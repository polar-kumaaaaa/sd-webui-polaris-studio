"""Polaris Studio: プロジェクトのデータと生成画像を扱うAPI。

プロジェクト（タグ定義・シーン・カット案・キュー）は拡張フォルダ内の data/projects.json に保存する。
"""
import io
import json
import os
import re
import shutil
import threading
import time
import uuid
import zipfile

from fastapi import Body, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image, ImageDraw

from modules import images, script_callbacks, scripts, shared
from modules.infotext_utils import parse_generation_parameters

try:
    from send2trash import send2trash as _send2trash
except Exception:
    _send2trash = None

EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(EXT_DIR, "data")
PROJECTS_FILE = os.path.join(DATA_DIR, "projects.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
BACKUP_KEEP = 30            # 残す控えの数（古いものから消す）
BACKUP_INTERVAL = 10 * 60   # 控えを取る間隔（秒）。中身が減る保存のときは間隔によらず取る

_lock = threading.Lock()


# ---------- ごみ箱 ----------

def _windows_trash(path):
    # send2trash がない Windows では、エクスプローラーと同じ API でごみ箱に送る
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_uint16),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    FO_DELETE = 3
    FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 0x4, 0x10, 0x40, 0x400
    op = SHFILEOPSTRUCTW(
        wFunc=FO_DELETE,
        pFrom=os.path.abspath(path) + "\0",   # 末尾は NUL 2 つ（もう 1 つは ctypes が付ける）
        fFlags=FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI,
    )
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if result or op.fAnyOperationsAborted:
        raise OSError(f"ごみ箱に移せませんでした（{result}）")


def can_trash():
    return _send2trash is not None or os.name == "nt"


def remove_path(path):
    """ファイルやフォルダを削除する。ごみ箱が使えれば、ごみ箱に移す（そこから戻せる）。"""
    if _send2trash is not None:
        _send2trash(os.path.abspath(path))
    elif os.name == "nt":
        _windows_trash(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)
    else:
        os.remove(path)


def _sanitize_tags(raw):
    # カテゴリは並び順がそのまま順位になる
    categories = []
    category_ids = set()
    for item in raw.get("categories") or []:
        if not isinstance(item, dict):
            continue
        cid = str(item.get("id", "")).strip()
        name = str(item.get("name", "")).strip()
        if not cid or not name or cid in category_ids:
            continue
        category_ids.add(cid)
        # exclusive: このカテゴリのタグはプロンプトに1つしか入れられない（後から入れたもので置き換える）
        # negative: このカテゴリのタグは常にネガティブプロンプトに入れる
        categories.append({
            "id": cid,
            "name": name,
            "exclusive": bool(item.get("exclusive", False)),
            "negative": bool(item.get("negative", False)),
        })

    entries = []
    for item in raw.get("entries") or []:
        if not isinstance(item, dict):
            continue
        tags = str(item.get("tags", "")).strip()
        if not tags:
            continue
        category_id = str(item.get("categoryId", ""))
        entries.append({
            "id": str(item.get("id", "")),
            "tags": tags,
            "description": str(item.get("description", "")).strip(),
            # 存在しないカテゴリを指していたら未分類（空文字）に戻す
            "categoryId": category_id if category_id in category_ids else "",
        })
    return categories, entries


def _positive_int(value, default):
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default


# シードは -1（ランダム）以上の整数。なければ None
def _seed(value):
    try:
        return max(-1, int(value))
    except (TypeError, ValueError):
        return None


# バリエーションの強度は 0〜1。なければ None
def _strength(value):
    try:
        return min(max(round(float(value), 2), 0.0), 1.0)
    except (TypeError, ValueError):
        return None


# ---------- プロジェクト ----------

QUEUE_STATUSES = ("waiting", "done", "error")


def load_projects():
    if not os.path.exists(PROJECTS_FILE):
        return {"projects": []}
    try:
        with open(PROJECTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return sanitize_projects(data if isinstance(data, dict) else {})
    except Exception as e:
        print(f"[Polaris Studio] failed to load {PROJECTS_FILE}: {e}")
        # 次の保存で上書きしてしまわないよう、読めなかったファイルは別名で残す
        broken = os.path.join(DATA_DIR, f"projects.broken-{int(time.time())}.json")
        os.replace(PROJECTS_FILE, broken)
        return {"projects": []}


# 中身の量。プロジェクト・カット案・Book のどれかが減る保存の前には、必ず控えを取る
def _amount(data):
    projects = _dicts(data.get("projects"))
    cuts = sum(len(_dicts(s.get("cuts"))) for p in projects for s in _dicts(p.get("scenes")))
    books = sum(len(_dicts(p.get("books"))) for p in projects)
    return len(projects), cuts, books


def backup_projects(new_data):
    """上書きする前の projects.json を data/backups/ に控える。"""
    if not os.path.exists(PROJECTS_FILE):
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    names = _backup_names()
    try:
        with open(PROJECTS_FILE, "r", encoding="utf-8") as f:
            old = json.load(f)
        shrinks = any(n < o for n, o in zip(_amount(new_data), _amount(old if isinstance(old, dict) else {})))
    except Exception:
        shrinks = True
    recent = names and time.time() - os.path.getmtime(os.path.join(BACKUP_DIR, names[-1])) < BACKUP_INTERVAL
    if recent and not shrinks:
        return
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(BACKUP_DIR, f"projects-{stamp}.json")
    n = 1
    while os.path.exists(path):
        n += 1
        path = os.path.join(BACKUP_DIR, f"projects-{stamp}-{n}.json")
    shutil.copyfile(PROJECTS_FILE, path)
    for old_name in _backup_names()[:-BACKUP_KEEP]:
        os.remove(os.path.join(BACKUP_DIR, old_name))


# 控えのファイル名を古い順に
def _backup_names():
    names = [n for n in os.listdir(BACKUP_DIR) if n.startswith("projects-") and n.endswith(".json")]
    return sorted(names, key=lambda n: os.path.getmtime(os.path.join(BACKUP_DIR, n)))


def save_projects(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    try:
        backup_projects(data)
    except Exception as e:
        # 控えが取れなくても保存は止めない
        print(f"[Polaris Studio] failed to back up {PROJECTS_FILE}: {e}")
    tmp = PROJECTS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, **data}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PROJECTS_FILE)


def sanitize_projects(raw):
    return {"projects": [_sanitize_project(p) for p in _dicts(raw.get("projects"))]}


def _sanitize_project(raw):
    categories, entries = _sanitize_tags(raw)
    scenes = [_sanitize_scene(s) for s in _dicts(raw.get("scenes"))]
    cut_ids = {c["id"] for s in scenes for c in s["cuts"]}
    cover = str(raw.get("coverCutId", ""))
    return {
        "id": _safe_id(raw.get("id")),
        "title": str(raw.get("title", "")).strip() or "無題",
        # 手動で選んだカバー画像のカット案。そのカット案がなくなったら自動選択に戻す
        "coverCutId": cover if cover in cut_ids else "",
        "categories": categories,
        "entries": entries,
        "scenes": scenes,
        "queues": [_sanitize_queue(q) for q in _dicts(raw.get("queues"))],
        "books": [_sanitize_book(b, cut_ids) for b in _dicts(raw.get("books"))],
        "createdAt": str(raw.get("createdAt", "")),
    }


# Book は「画像への参照（カット案の id と画像の名前）」と「コマページ」を並び順に持つ。画像そのものは持たない。
# 同じ画像は 1 つの Book に 1 回だけ。カット案がなくなった画像は外す。
# 古いデータの images（画像だけの並び）は items として読む
def _sanitize_book(raw, cut_ids):
    items = []
    seen = set()
    source = raw.get("items") if isinstance(raw.get("items"), list) else raw.get("images")
    for x in _dicts(source):
        if x.get("type") == "page":
            items.append(_sanitize_page(x, cut_ids))
            continue
        ref = _image_ref(x, cut_ids)
        if ref and (ref["cutId"], ref["name"]) not in seen:
            seen.add((ref["cutId"], ref["name"]))
            items.append(ref)
    return {
        "id": _safe_id(raw.get("id")),
        "title": str(raw.get("title", "")).strip() or "無題の Book",
        "items": items,
        "createdAt": str(raw.get("createdAt", "")),
    }


# cut_ids が None のときはカット案の有無を見ない（書き出しのとき。画像のパスは image_path で確かめる）
def _image_ref(raw, cut_ids):
    cut = str(raw.get("cutId", ""))
    name = os.path.basename(str(raw.get("name", "")))
    if not name or (cut_ids is not None and cut not in cut_ids):
        return None
    return {"cutId": cut, "name": name}


# ---------- コマページ ----------
# 白紙のページに直線と四角を置く。四角には画像の一部（クロップ範囲）をはめ込める。
# 座標はすべてページのピクセル。四角の線は四角の内側に描き、画像は四角いっぱいに置く

PAGE_WIDTH = 1573
PAGE_HEIGHT = 2200
PAGE_SIZE_MIN = 64
PAGE_SIZE_MAX = 8192
PAGE_STROKES = (0, 4, 8, 12, 16, 24)    # 0 は線なし（四角だけ）


def _number(value, default=0.0):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return default
    if value != value or abs(value) > PAGE_SIZE_MAX * 4:
        return default
    return round(value, 1)


def _page_size(value, default):
    try:
        return min(max(int(value), PAGE_SIZE_MIN), PAGE_SIZE_MAX)
    except (TypeError, ValueError):
        return default


def _stroke(value, allow_none):
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = 4
    if value not in PAGE_STROKES or (value == 0 and not allow_none):
        return 4
    return value


def _sanitize_page(raw, cut_ids):
    shapes = []
    for s in _dicts(raw.get("shapes")):
        if s.get("type") == "line":
            shapes.append({
                "id": _safe_id(s.get("id")),
                "type": "line",
                **{k: _number(s.get(k)) for k in ("x1", "y1", "x2", "y2")},
                "stroke": _stroke(s.get("stroke"), False),
            })
        elif s.get("type") == "rect":
            w, h = _number(s.get("w")), _number(s.get("h"))
            if w < 1 or h < 1:
                continue
            shapes.append({
                "id": _safe_id(s.get("id")),
                "type": "rect",
                "x": _number(s.get("x")),
                "y": _number(s.get("y")),
                "w": w,
                "h": h,
                "stroke": _stroke(s.get("stroke"), True),
                # 重なったとき、この四角で後ろのコマ（画像と線）を隠す
                **({"front": True} if s.get("front") is True else {}),
                "image": _sanitize_panel_image(s.get("image"), cut_ids),
            })
    return {
        "type": "page",
        "id": _safe_id(raw.get("id")),
        "width": _page_size(raw.get("width"), PAGE_WIDTH),
        "height": _page_size(raw.get("height"), PAGE_HEIGHT),
        "shapes": shapes,
    }


# 四角にはめ込んだ画像。iw・ih はクロップしたときの画像の大きさ、crop はその画像の中の範囲（ピクセル）。
# mode が "full"（原寸）なら画像を拡大・縮小せずに置き、crop は画像からはみ出してよい（はみ出した所は白い余白）。
# 元の画像には手を加えない
def _sanitize_panel_image(raw, cut_ids):
    if not isinstance(raw, dict):
        return None
    ref = _image_ref(raw, cut_ids)
    crop = raw.get("crop") if isinstance(raw.get("crop"), dict) else {}
    iw, ih = _number(raw.get("iw")), _number(raw.get("ih"))
    cw, ch = _number(crop.get("w")), _number(crop.get("h"))
    if not ref or iw < 1 or ih < 1 or cw < 1 or ch < 1:
        return None
    image = {**ref, "iw": iw, "ih": ih, "crop": {"x": _number(crop.get("x")), "y": _number(crop.get("y")), "w": cw, "h": ch}}
    if raw.get("mode") == "full":
        image["mode"] = "full"
    return image


def _sanitize_scene(raw):
    return {
        "id": _safe_id(raw.get("id")),
        "name": str(raw.get("name", "")).strip(),
        "cuts": [_sanitize_cut(c) for c in _dicts(raw.get("cuts"))],
    }


def _sanitize_cut(raw):
    # プロンプトはプレビューで決めたときのテキストをそのまま残す（前後の空白や改行も含めて手を加えない）
    return {
        "id": _safe_id(raw.get("id")),
        "title": str(raw.get("title", "")).strip(),
        "positive": str(raw.get("positive", "")),
        "negative": str(raw.get("negative", "")),
        **_generation_params(raw, 50),
        "keyImage": str(raw.get("keyImage", "")),
        # 編集画面の「追加したタグ」の並び（カードの id）。None はまだ一度も保存していないカット案で、開いたときにテキストから作る
        "picks": _unique_strings(raw.get("picks")) if isinstance(raw.get("picks"), list) else None,
        "history": [
            {"at": str(h.get("at", "")), "positive": str(h.get("positive", "")), "negative": str(h.get("negative", ""))}
            for h in _dicts(raw.get("history"))
        ],
        "createdAt": str(raw.get("createdAt", "")),
    }


def _sanitize_queue(raw):
    status = raw.get("status")
    # 登録時のプロンプトと設定をそのまま持つ。カット案を変えても追従しない
    return {
        "id": _safe_id(raw.get("id")),
        "name": str(raw.get("name", "")).strip(),
        "cutId": str(raw.get("cutId", "")),
        "sceneName": str(raw.get("sceneName", "")),
        "cutTitle": str(raw.get("cutTitle", "")),
        "positive": str(raw.get("positive", "")),
        "negative": str(raw.get("negative", "")),
        **_generation_params(raw, 37),
        "batch": _positive_int(raw.get("batch"), 10),
        # "regen" は、選んだ画像を元のプロンプトと Seed のまま Steps だけ変えて 1 枚ずつ作り直すキュー
        "kind": "regen" if raw.get("kind") == "regen" else "",
        "images": [_sanitize_regen_image(x) for x in _dicts(raw.get("images"))] if raw.get("kind") == "regen" else [],
        "status": status if status in QUEUE_STATUSES else "waiting",
        "createdAt": str(raw.get("createdAt", "")),
    }


# 再生成する画像 1 枚分。作り直した画像は元のカット案（cutId）に入る
def _sanitize_regen_image(raw):
    params = _generation_params(raw, 1)
    del params["steps"]

    def size(value):
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 0

    return {
        "cutId": str(raw.get("cutId", "")),
        "name": os.path.basename(str(raw.get("name", ""))),
        "positive": str(raw.get("positive", "")),
        "negative": str(raw.get("negative", "")),
        **params,
        "width": size(raw.get("width")),
        "height": size(raw.get("height")),
    }


def _generation_params(raw, default_steps):
    seed = _seed(raw.get("seed"))
    subseed = _seed(raw.get("subseed"))
    strength = _strength(raw.get("subseedStrength"))
    return {
        "steps": _positive_int(raw.get("steps"), default_steps),
        "seed": -1 if seed is None else seed,
        "subseed": -1 if subseed is None else subseed,
        "subseedStrength": 0.0 if strength is None else strength,
    }


def _dicts(value):
    return [x for x in value if isinstance(x, dict)] if isinstance(value, list) else []


def _unique_strings(value):
    # 並びを保ったまま、文字列だけを重複なしで残す
    return list(dict.fromkeys(str(x) for x in value if isinstance(x, str) and x))


# id はフォルダ名にも使うので、英数字と - _ だけにする。使えないものは作り直す
def _safe_id(value):
    value = str(value or "")
    return value if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value) else uuid.uuid4().hex[:12]


# ---------- 生成画像の保存先 ----------
# 画像は <出力フォルダ>/polaris-studio/<プロジェクト id>/<カット案 id>/ に保存する

ID_PATTERN = r"[A-Za-z0-9_-]{1,64}"
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".avif")
THUMBNAIL_SIZE = 480
JOB_LIFETIME = 60

_job = None             # 次の生成の保存先 {project, cut, source, at}
_i2i = None             # img2img の保存先。解除するまで続く {project, cut, source, label}
_info_cache = {}        # (パス, 更新時刻) → 画像のメタ情報


def output_root():
    base = shared.opts.outdir_samples or shared.opts.outdir_txt2img_samples or "outputs/txt2img-images"
    return os.path.join(os.path.dirname(os.path.abspath(base)), "polaris-studio")


def project_dir(project):
    if not re.fullmatch(ID_PATTERN, str(project)):
        raise ValueError(f"bad project id: {project}")
    return os.path.join(output_root(), project)


def cut_dir(project, cut):
    if not re.fullmatch(ID_PATTERN, str(cut)):
        raise ValueError(f"bad cut id: {cut}")
    return os.path.join(project_dir(project), cut)


def image_path(project, cut, name):
    # 画像はカット案のフォルダの直下にだけ置く。別の場所を指す名前は受け付けない
    name = str(name)
    if name != os.path.basename(name) or name in ("", ".", ".."):
        raise ValueError(f"bad image name: {name}")
    return os.path.join(cut_dir(project, cut), name)


def image_meta(path):
    mtime = os.path.getmtime(path)
    key = (path, mtime)
    if key not in _info_cache:
        info = ""
        try:
            with images.read(path) as image:
                info = images.read_info_from_image(image)[0] or ""
        except Exception as e:
            print(f"[Polaris Studio] failed to read {path}: {e}")
        params = parse_generation_parameters(info) if info else {}
        _info_cache[key] = {
            "name": os.path.basename(path),
            "mtime": mtime,
            "info": info,
            "prompt": params.get("Prompt", ""),
            "negative": params.get("Negative prompt", ""),
            "steps": str(params.get("Steps", "")),
            "sampler": str(params.get("Sampler", "")),
            "seed": str(params.get("Seed", "")),
            "subseed": str(params.get("Variation seed", "")),
            "subseedStrength": str(params.get("Variation seed strength", "")),
            "size": f"{params.get('Size-1', '')} x {params.get('Size-2', '')}" if "Size-1" in params else "",
            "model": str(params.get("Model", "")),
            "source": str(params.get("Polaris Source", "")),
        }
    return _info_cache[key]


def list_cut_images(project, cut):
    folder = cut_dir(project, cut)
    if not os.path.isdir(folder):
        return []
    paths = [e.path for e in os.scandir(folder) if e.is_file() and e.name.lower().endswith(IMAGE_EXTENSIONS)]
    # 古い順。一番古い画像が、指定のないときのキー画像になる
    return sorted((image_meta(p) for p in paths), key=lambda m: (m["mtime"], m["name"]))


def list_project_images(project):
    folder = project_dir(project)
    if not os.path.isdir(folder):
        return {}
    return {e.name: list_cut_images(project, e.name) for e in os.scandir(folder) if e.is_dir() and re.fullmatch(ID_PATTERN, e.name)}


def thumbnail_bytes(path):
    with images.read(path) as image:
        image = image.convert("RGB")
        image.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE), Image.LANCZOS)
        out = io.BytesIO()
        image.save(out, "JPEG", quality=85)
    return out.getvalue()


def unique_name(folder, name):
    base, ext = os.path.splitext(os.path.basename(name))
    if ext.lower() not in IMAGE_EXTENSIONS:
        raise ValueError(f"not an image: {name}")
    base = re.sub(r"[^\w.-]", "_", base) or "image"
    candidate = base + ext
    n = 1
    while os.path.exists(os.path.join(folder, candidate)):
        n += 1
        candidate = f"{base}-{n}{ext}"
    return candidate


# ---------- Book の書き出し ----------
# 生成情報などのメタ情報をすべて落とした PNG にし、Book 内の順序（001.png ...）をファイル名にして ZIP にまとめる

PNG_MODES = ("1", "L", "LA", "I", "I;16", "P", "RGB", "RGBA")


def clean_png(path):
    with Image.open(path) as image:
        image.load()
        clean = image.copy()
    # 画素だけを残す。透過は画像の一部なので残し、ほかの情報（生成情報・EXIF・ICC など）は書き出さない
    transparency = clean.info.get("transparency")
    clean.info = {"transparency": transparency} if transparency is not None else {}
    if clean.mode not in PNG_MODES:
        clean = clean.convert("RGBA" if "A" in clean.mode else "RGB")
    out = io.BytesIO()
    clean.save(out, "PNG")
    return out.getvalue()


# はめ込む範囲。四角と縦横比が違うときは、範囲の中央を四角の縦横比で切り出す（画面の表示と同じ）
def fitted_crop(crop, w, h):
    x, y, cw, ch = crop["x"], crop["y"], crop["w"], crop["h"]
    if cw / ch > w / h:
        nw = ch * w / h
        x, cw = x + (cw - nw) / 2, nw
    else:
        nh = cw * h / w
        y, ch = y + (ch - nh) / 2, nh
    return x, y, cw, ch


# 四角に映す画像の範囲（JS の panelCrop と同じ）。原寸は四角と同じ大きさの範囲を、範囲の中心に合わせて取る
def panel_crop(ref, w, h):
    if ref.get("mode") != "full":
        return fitted_crop(ref["crop"], w, h)
    c = ref["crop"]
    return c["x"] + c["w"] / 2 - w / 2, c["y"] + c["h"] / 2 - h / 2, w, h


def _paste_panel(canvas, project, s):
    ref = s.get("image")
    if not ref:
        return
    path = image_path(project, ref["cutId"], ref["name"])
    if not os.path.isfile(path):
        return
    with Image.open(path) as src:
        src = src.convert("RGBA")
    # クロップした後で画像の大きさが変わっていても、同じ割合の範囲を使う
    sx, sy = src.width / ref["iw"], src.height / ref["ih"]
    x, y, cw, ch = panel_crop(ref, s["w"], s["h"])
    # 画像からはみ出した範囲は透明になり、白地がそのまま余白として残る
    box = (round(x * sx), round(y * sy), round((x + cw) * sx), round((y + ch) * sy))
    size = (max(1, round(s["w"])), max(1, round(s["h"])))
    part = src.crop(box).resize(size, Image.LANCZOS)
    canvas.paste(part, (round(s["x"]), round(s["y"])), part)


# コマページを 1 枚の画像にする。見つからない画像の四角は空けておく。重なりの描き方は JS の drawPage と同じ：
#   1. 「下を隠す」（front）でない四角の画像を、いちばん下にまとめて置く
#   2. 図形の並び順（後ろほど手前）に線と直線を描く。「下を隠す」四角はその位置で白地・画像・線をまとめて描き、奥のものを隠す。
#      画像も線もない「下を隠す」四角は何も隠さない
def render_page(project, page):
    canvas = Image.new("RGB", (page["width"], page["height"]), "white")
    for s in page["shapes"]:
        if s["type"] == "rect" and not s.get("front"):
            _paste_panel(canvas, project, s)
    draw = ImageDraw.Draw(canvas)
    for s in page["shapes"]:
        if s["type"] == "rect" and s.get("front") and (s.get("image") or s["stroke"]):
            x0, y0 = round(s["x"]), round(s["y"])
            draw.rectangle((x0, y0, x0 + round(s["w"]) - 1, y0 + round(s["h"]) - 1), fill="white")
            _paste_panel(canvas, project, s)
        if s["type"] == "rect" and s["stroke"]:
            x0, y0 = round(s["x"]), round(s["y"])
            draw.rectangle((x0, y0, x0 + round(s["w"]) - 1, y0 + round(s["h"]) - 1), outline="black", width=s["stroke"])
        elif s["type"] == "line":
            draw.line(((s["x1"], s["y1"]), (s["x2"], s["y2"])), fill="black", width=s["stroke"])
    out = io.BytesIO()
    canvas.save(out, "PNG")
    return out.getvalue()


# items は Book の並び（画像の参照とコマページ）。見つからない画像は飛ばす。コマページは 1 枚の画像にする
def book_zip(project, items):
    pages = []
    for item in _dicts(items):
        if item.get("type") == "page":
            page = _sanitize_page(item, None)
            pages.append(lambda page=page: render_page(project, page))
            continue
        ref = _image_ref(item, None)
        path = ref and image_path(project, ref["cutId"], ref["name"])
        if path and os.path.isfile(path):
            pages.append(lambda path=path: clean_png(path))
    if not pages:
        raise ValueError("書き出す画像がありません")
    width = max(3, len(str(len(pages))))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i, make in enumerate(pages, 1):
            # 日時も手がかりにならないよう固定にする
            info = zipfile.ZipInfo(f"{i:0{width}d}.png", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, make())
    return buf.getvalue()


def take_job():
    global _job
    job, _job = _job, None
    return job if job and time.time() - job["at"] < JOB_LIFETIME else None


class PolarisJobScript(scripts.Script):
    """JS から頼まれた生成だけ、保存先をカット案のフォルダにして、識別子を生成情報に入れる。
    txt2img は1回の生成ごとに頼まれる。img2img はビューワーから送ったあと、解除するまでずっと続く。"""

    def title(self):
        return "Polaris Studio"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def before_process(self, p, *args):
        job = _i2i if self.is_img2img else take_job()
        if job is None:
            return
        p.outpath_samples = cut_dir(job["project"], job["cut"])
        p.do_not_save_grid = True
        # 日付などのフォルダを作らず、カット案のフォルダの直下に保存する
        p.override_settings["save_to_dirs"] = False
        p.override_settings["samples_save"] = True
        p.extra_generation_params["Polaris Cut"] = job["cut"]
        p.extra_generation_params["Polaris Source"] = job["source"]


def on_app_started(demo, app):
    @app.get("/polaris-studio/projects")
    def get_projects():
        with _lock:
            return {**load_projects(), "outputRoot": output_root(), "trash": can_trash()}

    @app.post("/polaris-studio/job")
    def set_job(payload: dict = Body(...)):
        global _job
        try:
            cut_dir(payload.get("project"), payload.get("cut"))
        except ValueError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        _job = {"project": payload["project"], "cut": payload["cut"], "source": str(payload.get("source", "preview")), "at": time.time()}
        return {"ok": True}

    @app.post("/polaris-studio/job/clear")
    def clear_job():
        global _job
        _job = None
        return {"ok": True}

    @app.get("/polaris-studio/i2i")
    def get_i2i():
        return {"ok": True, "target": _i2i}

    @app.post("/polaris-studio/i2i")
    def set_i2i(payload: dict = Body(...)):
        global _i2i
        try:
            cut_dir(payload.get("project"), payload.get("cut"))
        except ValueError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        _i2i = {key: str(payload.get(key, "")) for key in ("project", "cut", "source", "label")}
        return {"ok": True, "target": _i2i}

    @app.post("/polaris-studio/i2i/clear")
    def clear_i2i():
        global _i2i
        _i2i = None
        return {"ok": True}

    @app.get("/polaris-studio/images")
    def get_images(project: str):
        try:
            return {"ok": True, "cuts": list_project_images(project)}
        except ValueError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    @app.get("/polaris-studio/image")
    def get_image(project: str, cut: str, name: str, thumb: bool = False):
        try:
            path = image_path(project, cut, name)
            if not os.path.isfile(path):
                return JSONResponse({"ok": False, "error": "not found"}, status_code=404)
            if thumb:
                return Response(thumbnail_bytes(path), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
            return FileResponse(path)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    @app.post("/polaris-studio/images/upload")
    async def upload_image(request: Request, project: str, cut: str, name: str):
        data = await request.body()
        try:
            folder = cut_dir(project, cut)
            os.makedirs(folder, exist_ok=True)
            saved = unique_name(folder, name)
            with open(os.path.join(folder, saved), "wb") as f:
                f.write(data)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        return {"ok": True, "name": saved}

    # 画像は実ファイルごと削除する（ごみ箱が使えればごみ箱へ）
    @app.post("/polaris-studio/images/delete")
    def delete_images(payload: dict = Body(...)):
        try:
            paths = [image_path(payload.get("project"), payload.get("cut"), n) for n in payload.get("names") or []]
            for path in paths:
                if os.path.isfile(path):
                    remove_path(path)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        return {"ok": True}

    # カット案（cut あり）またはプロジェクト（cut なし）のフォルダを実ファイルごと削除する（ごみ箱が使えればごみ箱へ）
    @app.post("/polaris-studio/folder/delete")
    def delete_folder(payload: dict = Body(...)):
        global _i2i
        try:
            cut = payload.get("cut")
            path = cut_dir(payload.get("project"), cut) if cut else project_dir(payload.get("project"))
            if os.path.isdir(path):
                remove_path(path)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        # 消したフォルダへの img2img の保存は解除する。残すと、生成したときにフォルダが作り直される
        if _i2i and _i2i["project"] == payload.get("project") and (not cut or _i2i["cut"] == cut):
            _i2i = None
        return {"ok": True}

    @app.post("/polaris-studio/projects")
    def put_projects(payload: dict = Body(...)):
        data = sanitize_projects(payload)
        try:
            with _lock:
                save_projects(data)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        return {"ok": True, **data}

    # Book の画像とコマページを並び順に ZIP にして返す。ファイル名は JS 側で Book のタイトルから付ける
    @app.post("/polaris-studio/books/export")
    def export_book(payload: dict = Body(...)):
        try:
            data = book_zip(payload.get("project"), payload.get("items") or payload.get("images") or [])
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        return Response(data, media_type="application/zip")

    # 画像（リクエスト本文にそのまま入れたバイト列）から生成情報を読む。「PNG内の情報を表示」タブと同じ読み方
    @app.post("/polaris-studio/image-info")
    async def image_info(request: Request):
        data = await request.body()
        try:
            image = images.read(io.BytesIO(data))
            info, _ = images.read_info_from_image(image)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        params = parse_generation_parameters(info) if info else {}
        return {"ok": True, "info": info or "", "params": {k: str(v) for k, v in params.items()}}


script_callbacks.on_app_started(on_app_started)
