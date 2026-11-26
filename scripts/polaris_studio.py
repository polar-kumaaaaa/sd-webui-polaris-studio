"""Polaris Studio: プロジェクトのデータと生成画像を扱うAPI。

プロジェクト（タグ定義・シーン・カット案・キュー）は拡張フォルダ内の data/projects.json に保存する。
"""
import asyncio
import base64
import copy
import hashlib
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
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont

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
    backup_file(PROJECTS_FILE, "projects", new_data, _amount)


def backup_file(file, prefix, new_data, amount):
    """上書きする前の file を data/backups/<prefix>-<日時>.json に控える。
    BACKUP_INTERVAL に 1 回、ただし amount(data) のどれかが減る保存のときは毎回取る。新しいものから BACKUP_KEEP 件を残す"""
    if not os.path.exists(file):
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    names = _backup_names(prefix)
    try:
        with open(file, "r", encoding="utf-8") as f:
            old = json.load(f)
        shrinks = any(n < o for n, o in zip(amount(new_data), amount(old if isinstance(old, dict) else {})))
    except Exception:
        shrinks = True
    recent = names and time.time() - os.path.getmtime(os.path.join(BACKUP_DIR, names[-1])) < BACKUP_INTERVAL
    if recent and not shrinks:
        return
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(BACKUP_DIR, f"{prefix}-{stamp}.json")
    n = 1
    while os.path.exists(path):
        n += 1
        path = os.path.join(BACKUP_DIR, f"{prefix}-{stamp}-{n}.json")
    shutil.copyfile(file, path)
    for old_name in _backup_names(prefix)[:-BACKUP_KEEP]:
        os.remove(os.path.join(BACKUP_DIR, old_name))


# 控えのファイル名を古い順に
def _backup_names(prefix="projects"):
    names = [n for n in os.listdir(BACKUP_DIR) if n.startswith(prefix + "-") and n.endswith(".json")]
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


def apply_project_changes(payload):
    """変わったプロジェクトだけを差し替える。ほかのプロジェクトはファイルにあるままにするので、
    別のブラウザ（タブ）で開いている画面が保存しても、ここで開いていない変更を古い内容で上書きしない。
    save: [{project, create}]。create のないプロジェクトがファイルになければ（ほかの画面で消した）作り直さない。
    delete: プロジェクトの id。そのオノマトペのパレットも消す。呼ぶ側で _lock を取る"""
    data = load_projects()
    projects = data["projects"]
    missing = []
    for item in _dicts(payload.get("save")):
        if not isinstance(item.get("project"), dict):
            continue
        project = _sanitize_project(item["project"])
        index = next((i for i, p in enumerate(projects) if p["id"] == project["id"]), None)
        if index is not None:
            projects[index] = project
        elif item.get("create"):
            # 新しいプロジェクトは一覧の先頭に（画面でも先頭に足している）
            projects.insert(0, project)
        else:
            missing.append(project["id"])
    deleted = {str(x) for x in payload.get("delete") or []}
    data["projects"] = [p for p in projects if p["id"] not in deleted]
    save_projects(data)
    for pid in deleted:
        delete_sfx_library(pid)
    return data, missing


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


# Book は「コマページ」を並び順に持つ。コマにはめ込む画像は、コマページの四角が参照（カット案の id と画像の名前）で持つ。
# 以前の「Book に追加」で登録した画像の参照や、古いデータの images（画像だけの並び）は読まずに捨てる
def _sanitize_book(raw, cut_ids):
    return {
        "id": _safe_id(raw.get("id")),
        "title": str(raw.get("title", "")).strip() or "無題の Book",
        "items": [_sanitize_page(x, cut_ids) for x in _dicts(raw.get("items")) if x.get("type") == "page"],
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
# 白紙のページに直線と四角（コマ）を置く。四角には画像の一部（クロップ範囲）をはめ込める。
# コマは頂点（pts）を持つと三角・台形・平行四辺形などの多角形になる。
# 座標はすべてページのピクセル。四角の線は四角の内側に描き、画像は四角いっぱいに置く

PAGE_WIDTH = 1573
PAGE_HEIGHT = 2200
PAGE_SIZE_MIN = 64
PAGE_SIZE_MAX = 8192
PAGE_STROKES = (0, 4, 8, 12, 16, 24)    # 0 は線なし（四角だけ）
PAGE_NAME_MAX = 40
HLINE_WIDTH = (2, 200)
HLINE_WOBBLE = (0, 100)
HLINE_OUTLINE = (0, 16)
HLINE_SNAKE = (0, 100)
HLINE_SNAKE_FROM = (0, 95)
HLINE_SNAKE_WAVES = (1, 12)


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


PANEL_POINTS = (3, 4)


# 多角形のコマの頂点 [[x, y], ...]（3〜4 個、ページのピクセル）。形にならない（面積がほとんどない）ものは None
def _panel_points(raw):
    if not isinstance(raw, list) or len(raw) not in PANEL_POINTS:
        return None
    pts = []
    for p in raw:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            return None
        pts.append([_number(p[0]), _number(p[1])])
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) / 2
    return pts if abs(area) >= 16 else None


# 手描き線の乱数の種（0〜2147483647 の整数）。_number はページの大きさに合わせて大きな値を捨てるので使わない
def _shape_seed(value):
    try:
        value = int(value)
    except (TypeError, ValueError, OverflowError):
        return 1
    return value if 0 <= value <= 2147483647 else 1


def _panel_cut(raw, cut_ids):
    cut = str(raw or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", cut) or (cut_ids is not None and cut not in cut_ids):
        return {}
    return {"cut": cut}


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
            # pts があるコマは多角形（三角・台形・平行四辺形など）。x, y, w, h はその外枠で、画像は外枠に合わせて置き、多角形で切り抜く
            pts = _panel_points(s.get("pts"))
            if pts:
                xs, ys = [p[0] for p in pts], [p[1] for p in pts]
                box = {"x": min(xs), "y": min(ys), "w": round(max(xs) - min(xs), 1), "h": round(max(ys) - min(ys), 1)}
            else:
                box = {k: _number(s.get(k)) for k in ("x", "y", "w", "h")}
            if box["w"] < 1 or box["h"] < 1:
                continue
            shapes.append({
                "id": _safe_id(s.get("id")),
                "type": "rect",
                **box,
                **({"pts": pts} if pts else {}),
                "stroke": _stroke(s.get("stroke"), True),
                # 重なったとき、この四角で後ろのコマ（画像と線）を隠す
                **({"front": True} if s.get("front") is True else {}),
                # このコマ用として対応させたカット案（画像を選ぶとき、そのカット案から始める）。なくなったカット案は外す
                **_panel_cut(s.get("cut"), cut_ids),
                "image": _sanitize_panel_image(s.get("image"), cut_ids),
            })
        elif s.get("type") == "material":
            # 素材（吹き出し・集中線・小物など）。コマと線の上の層に、並び順（後ろほど手前）に置く。ページから一部はみ出してよい
            name = str(s.get("name", ""))
            w, h = _number(s.get("w")), _number(s.get("h"))
            if not re.fullmatch(MATERIAL_NAME, name) or w < 1 or h < 1:
                continue
            shapes.append({
                "id": _safe_id(s.get("id")),
                "type": "material",
                "name": name,
                "x": _number(s.get("x")),
                "y": _number(s.get("y")),
                "w": w,
                "h": h,
            })
        elif s.get("type") == "text":
            text = _sanitize_text(s)
            if text:
                shapes.append(text)
        elif s.get("type") == "hline":
            # 手描き線。形は始点・終点・太さ・揺れ・種で決まり、ブラウザで描く。書き出しには、ブラウザで描いた画像（name）を
            # x, y, w, h の枠に置く（オノマトペと同じ）。素材と同じ層に、並び順に重ねる
            name = str(s.get("name", ""))
            outline = int(_ranged(s.get("outline"), *HLINE_OUTLINE, 0))
            shapes.append({
                "id": _safe_id(s.get("id")),
                "type": "hline",
                **{k: _number(s.get(k)) for k in ("x1", "y1", "x2", "y2", "x", "y", "w", "h")},
                "width": int(_ranged(s.get("width"), *HLINE_WIDTH, 12)),
                "wobble": int(_ranged(s.get("wobble"), *HLINE_WOBBLE, 30)),
                "color": _color(s.get("color"), "#000000"),
                "outline": outline,
                "outlineColor": _color(s.get("outlineColor"), "#ffffff"),
                "seed": _shape_seed(s.get("seed")),
                # 蛇行（終わりのほうのくねり）。大きさ・始まる位置（%）・波の数
                "snake": int(_ranged(s.get("snake"), *HLINE_SNAKE, 0)),
                "snakeFrom": int(_ranged(s.get("snakeFrom"), *HLINE_SNAKE_FROM, 80)),
                "snakeWaves": int(_ranged(s.get("snakeWaves"), *HLINE_SNAKE_WAVES, 3)),
                # 始点・終点を細くするか（入り・抜き）
                "taperIn": s.get("taperIn") is not False,
                "taperOut": s.get("taperOut") is not False,
                "name": name if re.fullmatch(MATERIAL_NAME, name) else "",
                **({"key": str(s.get("key"))[:64]} if s.get("key") else {}),
            })
        elif s.get("type") == "sfx":
            # オノマトペ。形は params で決まり、ブラウザで描く。書き出しには、ブラウザで描いた画像（素材と同じ置き場所の name）を使う。
            # 素材と同じ層に、並び順に重ねる
            params = sanitize_sfx_params(s.get("params"))
            name = str(s.get("name", ""))
            w, h = _number(s.get("w")), _number(s.get("h"))
            if params is None or w < 1 or h < 1:
                continue
            shapes.append({
                "id": _safe_id(s.get("id")),
                "type": "sfx",
                "name": name if re.fullmatch(MATERIAL_NAME, name) else "",
                **({"key": str(s.get("key"))[:64]} if s.get("key") else {}),
                "x": _number(s.get("x")),
                "y": _number(s.get("y")),
                "w": w,
                "h": h,
                "params": params,
                **_balloon(s.get("balloon")),
            })
    # 名前は Book の画面で見分けるためのもの（書き出しのファイル名には使わない）
    name = str(raw.get("name", "")).strip()[:PAGE_NAME_MAX]
    return {
        "type": "page",
        "id": _safe_id(raw.get("id")),
        **({"name": name} if name else {}),
        "width": _page_size(raw.get("width"), PAGE_WIDTH),
        "height": _page_size(raw.get("height"), PAGE_HEIGHT),
        "shapes": shapes,
    }


# セリフ（文字）。素材の上の層に置く。x, y, w, h は画面で組んだときの枠で、書き出しでは枠の中心に合わせて組み直す。
# font はフォントの id（font_path を参照）。size は文字の大きさ（ページのピクセル）、lineHeight は行の送り（文字の大きさの倍数）、
# spacing は字間（文字の大きさに対する割合）、outline はフチの太さ（ピクセル。0 はフチなし）
TEXT_MAX = 2000
TEXT_SIZE = (8, 1000)
TEXT_LINE = (1.0, 4.0)
TEXT_SPACING = (-0.5, 2.0)
TEXT_OUTLINE = (0, 64)


def _ranged(value, lo, hi, default):
    value = _number(value, default)
    return min(max(value, lo), hi)


def _color(value, default):
    value = str(value or "")
    return value.lower() if re.fullmatch(r"#[0-9a-fA-F]{6}", value) else default


# フキダシ（セリフとオノマトペに付ける）。pts は持ち主の枠の中心からのずれ（ページのピクセル）で 3〜20 個、stroke は線の太さ。
# 白で塗り、黒い線（線の真ん中が頂点を通る）で囲む。持ち主のすぐ下に描く
BALLOON_STROKES = (2, 4, 6, 8, 12)
BALLOON_POINTS = (3, 20)


def _balloon(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get("pts"), list):
        return {}
    pts = []
    for p in raw["pts"][:BALLOON_POINTS[1]]:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            return {}
        pts.append([_number(p[0]), _number(p[1])])
    if len(pts) < BALLOON_POINTS[0]:
        return {}
    try:
        stroke = int(raw.get("stroke"))
    except (TypeError, ValueError):
        stroke = 4
    return {"balloon": {"pts": pts, "stroke": stroke if stroke in BALLOON_STROKES else 4}}


def _sanitize_text(s):
    text = str(s.get("text", "")).replace("\r\n", "\n").replace("\r", "\n")[:TEXT_MAX]
    if not text.strip():
        return None
    font = str(s.get("font", ""))
    return {
        **_balloon(s.get("balloon")),
        "id": _safe_id(s.get("id")),
        "type": "text",
        "x": _number(s.get("x")),
        "y": _number(s.get("y")),
        "w": max(_number(s.get("w")), 0.0),
        "h": max(_number(s.get("h")), 0.0),
        "text": text,
        "font": font if re.fullmatch(FONT_ID, font) else "",
        "size": _ranged(s.get("size"), *TEXT_SIZE, 36),
        "vertical": s.get("vertical") is not False,
        "lineHeight": _ranged(s.get("lineHeight"), *TEXT_LINE, 1.5),
        "spacing": _ranged(s.get("spacing"), *TEXT_SPACING, 0),
        "color": _color(s.get("color"), "#000000"),
        "outline": int(_ranged(s.get("outline"), *TEXT_OUTLINE, 0)),
        "outlineColor": _color(s.get("outlineColor"), "#ffffff"),
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
        # 生成する画像のサイズ。0 はまだ決めていない（WebUI の設定のまま生成する）
        **_image_size(raw),
        **_generation_params(raw, 50),
        "keyImage": str(raw.get("keyImage", "")),
        # お気に入りにした画像の名前（カット案のフォルダの中の名前だけ）
        "favorites": _unique_strings(os.path.basename(str(x)) for x in raw.get("favorites") if isinstance(x, str))
        if isinstance(raw.get("favorites"), list) else [],
        # 編集画面の「追加したタグ」の並び（カードの id）。None はまだ一度も保存していないカット案で、開いたときにテキストから作る
        "picks": _unique_strings(raw.get("picks")) if isinstance(raw.get("picks"), list) else None,
        # OpenPose のポーズ（座標は 0〜1）と、生成で ControlNet に入れるときの設定
        "pose": _sanitize_pose(raw.get("pose")),
        "poseControl": _sanitize_pose_control(raw.get("poseControl")),
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
        **_image_size(raw),
        **_generation_params(raw, 37),
        "batch": _positive_int(raw.get("batch"), 10),
        # 登録したときのカット案のポーズ（使わないときは None）
        "pose": _sanitize_pose_job(raw.get("pose")),
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
    return {
        "cutId": str(raw.get("cutId", "")),
        "name": os.path.basename(str(raw.get("name", ""))),
        "positive": str(raw.get("positive", "")),
        "negative": str(raw.get("negative", "")),
        **params,
        **_image_size(raw),
    }


def _image_size(raw):
    # 幅と高さはそろって決まっているときだけ残す。どちらかがなければ両方 0
    def size(value):
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 0

    width, height = size(raw.get("width")), size(raw.get("height"))
    return {"width": width, "height": height} if width and height else {"width": 0, "height": 0}


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


POSE_PARTS = {"pose_keypoints_2d": 18, "hand_left_keypoints_2d": 21, "hand_right_keypoints_2d": 21, "face_keypoints_2d": 70}
POSE_MODES = ("BALANCED", "PROMPT", "CONTROL")
POSE_MAX_PEOPLE = 20
POSE_DETECTED_KEY = "polaris_detected"
DEPTH_ERASE_MAX = 300


def _clamp_float(value, low, high, default):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:
        return default
    return min(max(v, low), high)


# OpenPose の JSON（people の各部位は [x, y, c] の並び）。座標は画像の幅・高さに対する 0〜1。c が 1 未満の点は隠した点
def _sanitize_pose(raw):
    if not isinstance(raw, dict):
        return None
    def points(values, count):
        if not isinstance(values, list) or len(values) != count * 3:
            return None
        return [
            round(_clamp_float(v, -1.0, 2.0, 0.0), 5) if i % 3 < 2 else (1.0 if _clamp_float(v, 0, 1, 0) >= 1 else 0.0)
            for i, v in enumerate(values)
        ]

    people = []
    for person in _dicts(raw.get("people"))[:POSE_MAX_PEOPLE]:
        out = {key: points(person.get(key), count) for key, count in POSE_PARTS.items()}
        if out["pose_keypoints_2d"] is None:
            continue
        # 画像から取り出したときの体と手（深度から、動かした手足の元の位置を消すのに使う）
        detected = person.get(POSE_DETECTED_KEY)
        if isinstance(detected, dict):
            det = {key: points(detected.get(key), count) for key, count in POSE_PARTS.items() if key != "face_keypoints_2d"}
            if det["pose_keypoints_2d"] is not None:
                out[POSE_DETECTED_KEY] = det
        people.append(out)
    return {
        "canvas_width": _positive_int(raw.get("canvas_width"), 512),
        "canvas_height": _positive_int(raw.get("canvas_height"), 512),
        "people": people,
        # 取り出し元の画像（カット案のフォルダの中の名前）。エディタの下敷きに使う
        "source": os.path.basename(str(raw.get("source", ""))),
    }


def _sanitize_pose_control(raw):
    raw = raw if isinstance(raw, dict) else {}
    mode = raw.get("mode")
    start = _clamp_float(raw.get("start"), 0, 1, 0.0)
    return {
        "use": bool(raw.get("use", False)),
        # ControlNet のユニットの番号（0 から）
        "unit": int(_clamp_float(raw.get("unit"), 0, 15, 0)),
        # 空なら、生成のときに名前に openpose を含む最初のモデルを使う
        "model": str(raw.get("model", ""))[:300],
        "weight": round(_clamp_float(raw.get("weight"), 0, 2, 1.0), 3),
        "start": round(start, 3),
        "end": round(max(_clamp_float(raw.get("end"), 0, 1, 1.0), start), 3),
        "mode": mode if mode in POSE_MODES else "BALANCED",
        "depth": _sanitize_depth_control(raw.get("depth")),
    }


# ポーズと一緒に、取り出し元の画像の深度（depth）を別のユニットに入れる設定。重みは控えめから始める
def _sanitize_depth_control(raw):
    raw = raw if isinstance(raw, dict) else {}
    start = _clamp_float(raw.get("start"), 0, 1, 0.0)
    return {
        "use": bool(raw.get("use", False)),
        "unit": int(_clamp_float(raw.get("unit"), 0, 15, 1)),
        # 空なら、生成のときに depth_anything_v2 などから使えるものを選ぶ
        "module": str(raw.get("module", ""))[:100],
        # 空なら、生成のときに名前に depth を含む最初のモデルを使う
        "model": str(raw.get("model", ""))[:300],
        "weight": round(_clamp_float(raw.get("weight"), 0, 2, 0.5), 3),
        "start": round(start, 3),
        "end": round(max(_clamp_float(raw.get("end"), 0, 1, 1.0), start), 3),
    }


def _sanitize_pose_job(raw):
    if not isinstance(raw, dict):
        return None
    pose = _sanitize_pose(raw.get("pose"))
    return {"pose": pose, "control": _sanitize_pose_control(raw.get("control"))} if pose and pose["people"] else None


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
_t2i = None             # WebUI の txt2img で生成した画像の保存先。ポラスタの「生成」で決まり、解除するまで続く {project, cut, source, label}
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


# ---------- 素材（コマページに置く吹き出し・集中線・小物などの画像） ----------
# <プロジェクトのフォルダ>/.materials/ に、メタ情報を持たない PNG で置く。名前は中身から作るので、同じ画像は 1 つになる。
# フォルダ名は ID_PATTERN に合わないので、カット案のフォルダとは混ざらない。プロジェクトを削除すると一緒に消える

MATERIAL_DIR = ".materials"
MATERIAL_NAME = r"[0-9a-f]{20}\.png"
MATERIAL_MAX_BYTES = 50 * 1024 * 1024


def material_path(project, name):
    if not re.fullmatch(MATERIAL_NAME, str(name)):
        raise ValueError(f"bad material name: {name}")
    return os.path.join(project_dir(project), MATERIAL_DIR, name)


def save_material(project, data):
    if not data:
        raise ValueError("画像が空です")
    if len(data) > MATERIAL_MAX_BYTES:
        raise ValueError("画像が大きすぎます（50 MB まで）")
    try:
        with Image.open(io.BytesIO(data)) as src:
            if src.width > PAGE_SIZE_MAX or src.height > PAGE_SIZE_MAX:
                raise ValueError(f"画像が大きすぎます（縦横 {PAGE_SIZE_MAX} ピクセルまで）")
            # 透明を保つ。動く画像は最初のコマだけ
            image = src.convert("RGBA")
    except ValueError:
        raise
    except Exception:
        raise ValueError("画像として読めません")
    out = io.BytesIO()
    image.save(out, "PNG")
    png = out.getvalue()
    name = hashlib.sha256(png).hexdigest()[:20] + ".png"
    path = material_path(project, name)
    if not os.path.isfile(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(png)
    return {"name": name, "width": image.width, "height": image.height}


# ---------- フォント（セリフ用） ----------
# この PC に入っているフォントのファイルを使う。id は「場所:場所からの相対パス#フェイスの番号」（例 win:YuGothM.ttc#0）。
# TTC（複数のフェイスをまとめたファイル）は番号でフェイスを選ぶ。拡張フォルダの data/fonts/ に置いたフォントも使える

FONT_ID = r"[a-z]{1,8}:[^#\x00]{1,300}#\d{1,2}"
FONT_EXTENSIONS = (".ttf", ".otf", ".ttc", ".otc")
FONT_FALLBACKS = ("win:YuGothM.ttc#0", "win:meiryo.ttc#0", "win:msgothic.ttc#0")

# 自分で入れたフォントの置き場所（Windows の個人用のフォント、data/fonts/、Linux・macOS のホームのフォント）。
# Windows の「すべてのユーザーに対してインストール」は Windows\Fonts に入り、最初からあるフォントと見分けられない
FONT_ADDED_ROOTS = ("user", "ext", "home", "machome")
FONT_SAMPLE = "あいうアイウ漢字 Abc"
FONT_SAMPLE_SIZE = 26
FONT_SAMPLE_HEIGHT = 38
FONT_SAMPLE_WIDTH = 360

_font_list = None       # [{id, name, style, added}]
_sample_cache = {}      # フォントの id → 見本の PNG
_font_cache = {}        # (パス, 番号, 大きさ) → ImageFont
_face_cache = {}        # (パス, 番号) → TTC から取り出した 1 フェイスのバイト列（ブラウザ用）


def font_roots():
    home = os.path.expanduser("~")
    roots = {
        "win": os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts") if os.name == "nt" else "",
        "user": os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts") if os.name == "nt" else "",
        "ext": os.path.join(DATA_DIR, "fonts"),
        "sys": "/usr/share/fonts" if os.name != "nt" else "",
        "local": "/usr/local/share/fonts" if os.name != "nt" else "",
        "home": os.path.join(home, ".local", "share", "fonts") if os.name != "nt" else "",
        "mac": "/Library/Fonts" if os.name != "nt" else "",
        "macsys": "/System/Library/Fonts" if os.name != "nt" else "",
        "machome": os.path.join(home, "Library", "Fonts") if os.name != "nt" else "",
    }
    return {k: os.path.abspath(v) for k, v in roots.items() if v and os.path.isdir(v)}


# id からフォントのファイルとフェイスの番号を引く。フォントの置き場所の外を指す id は受け付けない
def font_path(font_id):
    m = re.fullmatch(r"([a-z]{1,8}):([^#\x00]{1,300})#(\d{1,2})", str(font_id))
    if not m:
        raise ValueError(f"bad font id: {font_id}")
    root = font_roots().get(m.group(1))
    if not root:
        raise ValueError(f"no font folder: {m.group(1)}")
    path = os.path.abspath(os.path.join(root, m.group(2)))
    if os.path.commonpath([root, path]) != root or not path.lower().endswith(FONT_EXTENSIONS) or not os.path.isfile(path):
        raise ValueError(f"font not found: {font_id}")
    return path, int(m.group(3))


def _name_of(table, ids):
    # 日本語の名前があればそれを、なければ英語、なければどれか
    for name_id in ids:
        records = [r for r in table.names if r.nameID == name_id]
        for lang in (0x411, 0x409, None):
            for r in records:
                if lang is None or (r.platformID == 3 and r.langID == lang):
                    try:
                        text = r.toUnicode().strip()
                    except Exception:
                        continue
                    if text:
                        return text
    return ""


def _font_faces(path):
    """[(番号, 名前, スタイル)]。fontTools があれば日本語の名前を読む。なければ PIL で読む（英語の名前）"""
    faces = []
    try:
        from fontTools.ttLib import TTCollection, TTFont
        if path.lower().endswith((".ttc", ".otc")):
            with TTCollection(path, lazy=True) as coll:
                fonts = list(coll.fonts)
                for i, f in enumerate(fonts):
                    faces.append((i, _name_of(f["name"], (16, 1)), _name_of(f["name"], (17, 2))))
        else:
            with TTFont(path, lazy=True) as f:
                faces.append((0, _name_of(f["name"], (16, 1)), _name_of(f["name"], (17, 2))))
        return [x for x in faces if x[1]]
    except ImportError:
        pass
    except Exception:
        return []
    for i in range(32):
        try:
            family, style = ImageFont.truetype(path, 12, index=i).getname()
        except Exception:
            break
        faces.append((i, family or "", style or ""))
        if not path.lower().endswith((".ttc", ".otc")):
            break
    return [x for x in faces if x[1]]


def list_fonts(refresh=False):
    global _font_list
    if _font_list is not None and not refresh:
        return _font_list
    fonts = []
    for key, root in font_roots().items():
        for folder, _, files in os.walk(root):
            for file in files:
                if not file.lower().endswith(FONT_EXTENSIONS):
                    continue
                path = os.path.join(folder, file)
                rel = os.path.relpath(path, root).replace(os.sep, "/")
                for index, family, style in _font_faces(path):
                    fonts.append({"id": f"{key}:{rel}#{index}", "name": family, "style": style, "added": key in FONT_ADDED_ROOTS})
    # 日本語の名前のフォントを先に、名前の順に
    cjk = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")
    fonts.sort(key=lambda f: (not cjk.search(f["name"]), f["name"].lower(), f["style"].lower()))
    _font_list = fonts
    return fonts


# 書き出し用。見つからないフォントは、日本語の入った既定のフォントで代える
def load_font(font_id, size):
    for candidate in (font_id, *FONT_FALLBACKS):
        try:
            path, index = font_path(candidate)
        except ValueError:
            continue
        key = (path, index, size)
        if key not in _font_cache:
            if len(_font_cache) > 64:
                _font_cache.clear()
            try:
                _font_cache[key] = ImageFont.truetype(path, size, index=index)
            except Exception:
                continue
        return _font_cache[key]
    return ImageFont.load_default(size)


# フォント選びの一覧に出す見本（黒い字、透明な地の PNG）。字のないフォントは豆腐（□）になる
def font_sample(font_id):
    if font_id in _sample_cache:
        return _sample_cache[font_id]
    path, index = font_path(font_id)
    font = ImageFont.truetype(path, FONT_SAMPLE_SIZE, index=index)
    width = min(int(font.getlength(FONT_SAMPLE)) + 8, FONT_SAMPLE_WIDTH)
    image = Image.new("RGBA", (max(width, 8), FONT_SAMPLE_HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(image).text((4, FONT_SAMPLE_HEIGHT / 2), FONT_SAMPLE, font=font, fill=(0, 0, 0, 255), anchor="lm")
    out = io.BytesIO()
    image.save(out, "PNG")
    if len(_sample_cache) > 2000:
        _sample_cache.clear()
    _sample_cache[font_id] = out.getvalue()
    return _sample_cache[font_id]


# ブラウザに渡すフォント。TTC はブラウザでフェイスを選べないので、fontTools で 1 フェイスだけのファイルにする
def font_bytes(font_id):
    path, index = font_path(font_id)
    if not path.lower().endswith((".ttc", ".otc")):
        with open(path, "rb") as f:
            return f.read()
    key = (path, index)
    if key not in _face_cache:
        try:
            from fontTools.ttLib import TTFont
            with TTFont(path, fontNumber=index) as f:
                out = io.BytesIO()
                f.save(out)
                data = out.getvalue()
        except ImportError:
            with open(path, "rb") as f:
                data = f.read()
        if len(_face_cache) >= 8:
            _face_cache.pop(next(iter(_face_cache)))
        _face_cache[key] = data
    return _face_cache[key]


# ---------- オノマトペ ----------
# 字形の輪郭はサーバーが fontTools で取り出し、ブラウザで並べ・ゆらして描く。
# 登録した文字列と調整済みスタンプは、プロジェクトごとに data/sfx/<プロジェクトの id>.json に置く。
# 以前はプロジェクトをまたいで共通の data/sfx.json だった（初めて読むときに、そのときあるプロジェクトそれぞれに写す）

SFX_DIR = os.path.join(DATA_DIR, "sfx")
LEGACY_SFX_FILE = os.path.join(DATA_DIR, "sfx.json")
SFX_PARAMS_MAX = 8000       # 1 つのスタンプの設定（JSON）の大きさの上限
SFX_WORDS_MAX = 20000
SFX_STAMPS_MAX = 500
SFX_TEXT_MAX = 200          # 1 回に輪郭を取り出す字の数

_glyph_lock = threading.Lock()
_glyph_cache = {}           # (フォントの id, 字) → 輪郭
_ttfont_cache = {}          # (パス, 番号) → TTFont


def sanitize_sfx_params(raw):
    """スタンプの設定。中身はブラウザだけが使うので、JSON にできる値に限り、大きさを抑える"""
    if not isinstance(raw, dict):
        return None

    def clean(v, depth):
        if v is None or isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return v if v == v and abs(v) < 1e9 else 0
        if isinstance(v, str):
            return v[:300]
        if depth < 4 and isinstance(v, list):
            return [clean(x, depth + 1) for x in v[:32]]
        if depth < 4 and isinstance(v, dict):
            return {str(k)[:40]: clean(x, depth + 1) for k, x in list(v.items())[:64]}
        return None

    out = clean(raw, 0)
    return out if len(json.dumps(out, ensure_ascii=False)) <= SFX_PARAMS_MAX else None


def sanitize_sfx_library(raw):
    raw = raw if isinstance(raw, dict) else {}
    stamps = []
    for s in _dicts(raw.get("stamps"))[:SFX_STAMPS_MAX]:
        params = sanitize_sfx_params(s.get("params"))
        if params is not None:
            stamps.append({"id": _safe_id(s.get("id")), "params": params})
    words = raw.get("words")
    return {"words": words[:SFX_WORDS_MAX] if isinstance(words, str) else "", "stamps": stamps}


def sfx_file(project_id):
    project_id = str(project_id or "")
    if not re.fullmatch(ID_PATTERN, project_id):
        raise ValueError("bad project id")
    return os.path.join(SFX_DIR, project_id + ".json")


def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, **data}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def migrate_legacy_sfx():
    """共通の data/sfx.json が残っていて、data/sfx/ がまだなければ、今あるプロジェクトそれぞれに写す。
    写したあとの data/sfx.json は data/sfx.legacy-<時刻>.json に名前を変えて残す。呼ぶ側で _lock を取る"""
    if os.path.isdir(SFX_DIR) or not os.path.exists(LEGACY_SFX_FILE):
        return
    try:
        with open(LEGACY_SFX_FILE, "r", encoding="utf-8") as f:
            data = sanitize_sfx_library(json.load(f))
    except Exception as e:
        print(f"[Polaris Studio] failed to load {LEGACY_SFX_FILE}: {e}")
        return
    os.makedirs(SFX_DIR, exist_ok=True)
    for project in load_projects()["projects"]:
        _write_json(sfx_file(project["id"]), data)
    os.replace(LEGACY_SFX_FILE, os.path.join(DATA_DIR, f"sfx.legacy-{int(time.time())}.json"))
    print("[Polaris Studio] copied the shared onomatopoeia palette to each project")


def load_sfx_library(project_id):
    migrate_legacy_sfx()
    path = sfx_file(project_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return sanitize_sfx_library(json.load(f))
    except FileNotFoundError:
        return sanitize_sfx_library({})
    except Exception as e:
        print(f"[Polaris Studio] failed to load {path}: {e}")
        broken = os.path.join(SFX_DIR, f"{os.path.basename(path)[:-5]}.broken-{int(time.time())}.json")
        os.replace(path, broken)
        return sanitize_sfx_library({})


# 中身の量（文字列の数、調整済みスタンプの数）。どちらかが減る保存の前には、必ず控えを取る
def _sfx_amount(data):
    words = data.get("words") if isinstance(data.get("words"), str) else ""
    return len([w for w in words.splitlines() if w.strip()]), len(_dicts(data.get("stamps")))


def save_sfx_library(project_id, data):
    migrate_legacy_sfx()
    path = sfx_file(project_id)
    os.makedirs(SFX_DIR, exist_ok=True)
    try:
        backup_file(path, f"sfx-{project_id}", data, _sfx_amount)
    except Exception as e:
        # 控えが取れなくても保存は止めない
        print(f"[Polaris Studio] failed to back up {path}: {e}")
    _write_json(path, data)


# プロジェクトを消したときに、そのパレットも消す（控えには残す）
def delete_sfx_library(project_id):
    try:
        path = sfx_file(project_id)
    except ValueError:
        return
    if not os.path.exists(path):
        return
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        shutil.copyfile(path, os.path.join(BACKUP_DIR, f"sfx-{project_id}-deleted-{time.strftime('%Y%m%d-%H%M%S')}.json"))
    except Exception as e:
        print(f"[Polaris Studio] failed to back up {path}: {e}")
    os.remove(path)


def _ttfont(font_id):
    from fontTools.ttLib import TTFont
    path, index = font_path(font_id)
    key = (path, index)
    if key not in _ttfont_cache:
        if len(_ttfont_cache) >= 8:
            _ttfont_cache.pop(next(iter(_ttfont_cache))).close()
        _ttfont_cache[key] = TTFont(path, fontNumber=index, lazy=True)
    return _ttfont_cache[key]


def _num(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


def glyph_outline(font_id, ch):
    """字形の輪郭 {d, adv, cy}。em を 1000 にそろえ、y は下向き、原点は基準線の左端。
    cy は字の枠（em）の上下の中央。フォントにない字は既定のフォントで、どれにもなければ空"""
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    for candidate in (font_id, *FONT_FALLBACKS):
        key = (candidate, ch)
        if key in _glyph_cache:
            return _glyph_cache[key]
        try:
            font = _ttfont(candidate)
            name = (font.getBestCmap() or {}).get(ord(ch))
        except Exception:
            continue
        if name is None:
            continue
        scale = 1000 / font["head"].unitsPerEm
        os2 = font["OS/2"] if "OS/2" in font else None
        if os2 is not None and os2.sTypoAscender - os2.sTypoDescender > 0:
            asc, desc = os2.sTypoAscender, os2.sTypoDescender
        else:
            asc, desc = font["hhea"].ascent, font["hhea"].descent
        glyphs = font.getGlyphSet()
        pen = SVGPathPen(glyphs, ntos=_num)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, 0, 0)))
        result = {"d": pen.getCommands(), "adv": round(glyphs[name].width * scale, 1), "cy": round(-(asc + desc) / 2 * scale, 1)}
        if len(_glyph_cache) > 20000:
            _glyph_cache.clear()
        _glyph_cache[key] = result
        return result
    return {"d": "", "adv": 500, "cy": -380}


def glyph_outlines(font_id, text):
    chars = list(dict.fromkeys(str(text)))[:SFX_TEXT_MAX]
    with _glyph_lock:
        return {ch: glyph_outline(font_id, ch) for ch in chars}


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
# コマページを、生成情報などのメタ情報を持たない PNG に描き、Book 内の順序（001.png ...）をファイル名にして ZIP にまとめる


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
    if s.get("pts"):
        # 多角形のコマは、外枠に置いた画像を多角形の形で切り抜く
        alpha = ImageChops.multiply(part.getchannel("A"), _polygon_mask(s, 0)[2])
        part.putalpha(alpha)
    canvas.paste(part, (round(s["x"]), round(s["y"])), part)


PANEL_AA = 4    # 多角形の縁を滑らかにするため、この倍の大きさで描いてから縮める


# 多角形のコマの形（stroke が 0 なら中、そうでなければ内側に stroke の太さの線）を、外枠の大きさのマスクにする。
# 戻り値は (左, 上, マスク)。線は四角と同じく形の内側に描く
def _polygon_mask(s, stroke):
    x0, y0 = round(s["x"]), round(s["y"])
    w, h = max(1, round(s["w"])), max(1, round(s["h"]))
    k = PANEL_AA
    pts = [((px - x0) * k, (py - y0) * k) for px, py in s["pts"]]
    fill = Image.new("L", (w * k, h * k), 0)
    ImageDraw.Draw(fill).polygon(pts, fill=255)
    if stroke:
        # 辺に沿って倍の太さの線を引き、形の中に入る半分だけを残す
        line = Image.new("L", fill.size, 0)
        ImageDraw.Draw(line).line(pts + pts[:1], fill=255, width=stroke * 2 * k, joint="curve")
        fill = ImageChops.multiply(fill, line)
    return x0, y0, fill.resize((w, h), Image.BOX)


# フキダシを描く。縁を滑らかにするため、コマと同じく大きく描いてから縮めて重ねる
def _paste_balloon(canvas, s):
    balloon = s.get("balloon")
    if not balloon:
        return
    cx, cy = s["x"] + s["w"] / 2, s["y"] + s["h"] / 2
    pts = [(cx + dx, cy + dy) for dx, dy in balloon["pts"]]
    stroke = balloon["stroke"]
    pad = stroke + 2
    x0 = int(min(p[0] for p in pts) - pad)
    y0 = int(min(p[1] for p in pts) - pad)
    x1 = int(max(p[0] for p in pts) + pad) + 1
    y1 = int(max(p[1] for p in pts) + pad) + 1
    k = PANEL_AA
    local = [((px - x0) * k, (py - y0) * k) for px, py in pts]
    size = ((x1 - x0) * k, (y1 - y0) * k)
    fill = Image.new("L", size, 0)
    ImageDraw.Draw(fill).polygon(local, fill=255)
    line = Image.new("L", size, 0)
    ImageDraw.Draw(line).line(local + local[:1], fill=255, width=max(1, stroke * k), joint="curve")
    shape = ImageChops.lighter(fill, line).resize((x1 - x0, y1 - y0), Image.BOX)
    ink = line.resize((x1 - x0, y1 - y0), Image.BOX)
    layer = Image.new("RGBA", (x1 - x0, y1 - y0), (255, 255, 255, 0))
    layer.putalpha(shape)
    black = Image.new("RGBA", layer.size, (0, 0, 0, 255))
    layer = Image.composite(black, layer, ink)
    layer.putalpha(shape)
    canvas.paste(layer, (x0, y0), layer)


# 素材を置いた大きさにして重ねる。ページからはみ出した所は切れる。見つからない素材は飛ばす
def _paste_material(canvas, project, s):
    path = material_path(project, s["name"])
    if not os.path.isfile(path):
        return
    with Image.open(path) as src:
        part = src.convert("RGBA").resize((max(1, round(s["w"])), max(1, round(s["h"]))), Image.LANCZOS)
    canvas.paste(part, (round(s["x"]), round(s["y"])), part)


# ---------- セリフの組み方（JS の layoutText と同じ） ----------
# 縦書きは 1 文字ずつ、文字の大きさの升目に並べる。右の行から左へ。改行で次の行。
#   - 「ー」「（」「」」などは 90° 回して置く。「、」「。」は升目の右上に、小さい「っ」などは少し右上に寄せる
#   - 半角の数字・! ・? が 2 文字までのときは、横に並べて 1 升に入れる（縦中横）。升目に入らなければ縮める
# 横書きは字形の幅で並べる。フチの太さの分だけ周りに余白を取る

TEXT_ROTATE = "ー－−–—―…‥～〜~（）()「」『』【】〔〕［］[]｛｝{}〈〉《》＜＞<>＝=-_｜|：:"
TEXT_CORNER = "、。，．､｡,."
TEXT_SMALL = "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ"
TEXT_TCY = "0123456789!?"


def _vertical_cells(line):
    cells, i = [], 0
    while i < len(line):
        j = i
        while j < len(line) and line[j] in TEXT_TCY:
            j += 1
        if j > i:
            run = line[i:j]
            cells.extend([run] if len(run) <= 2 else list(run))
            i = j
        else:
            cells.append(line[i])
            i += 1
    return cells


def layout_text(s, measure):
    """measure(文字列, 大きさ) は字形の幅。{w, h, glyphs: [{t, x, y, size, rot}]}（x, y は字の中心。枠の左上から）"""
    size, pad = s["size"], s["outline"]
    lines = s["text"].split("\n")
    glyphs = []
    if s["vertical"]:
        adv, pitch = size * (1 + s["spacing"]), size * s["lineHeight"]
        w = pad * 2 + size + (len(lines) - 1) * pitch
        longest = size
        for i, line in enumerate(lines):
            cx = w - pad - size / 2 - i * pitch
            cells = _vertical_cells(line)
            for j, t in enumerate(cells):
                cy = pad + size / 2 + j * adv
                g = {"t": t, "x": cx, "y": cy, "size": size, "rot": False}
                if len(t) > 1:
                    tw = measure(t, size)
                    if tw > size * 0.95:
                        g["size"] = size * size * 0.95 / tw
                elif t in TEXT_ROTATE:
                    g["rot"] = True
                elif t in TEXT_CORNER:
                    g["x"], g["y"] = cx + size * 0.5, cy - size * 0.5
                elif t in TEXT_SMALL:
                    g["x"], g["y"] = cx + size * 0.08, cy - size * 0.08
                glyphs.append(g)
            if cells:
                longest = max(longest, size + (len(cells) - 1) * adv)
        h = pad * 2 + longest
    else:
        pitch = size * s["lineHeight"]
        widest = size
        for i, line in enumerate(lines):
            cursor = 0.0
            cy = pad + size / 2 + i * pitch
            for j, ch in enumerate(line):
                a = measure(ch, size)
                if j:
                    cursor += s["spacing"] * size
                glyphs.append({"t": ch, "x": pad + cursor + a / 2, "y": cy, "size": size, "rot": False})
                cursor += a
            widest = max(widest, cursor)
        w = pad * 2 + widest
        h = pad * 2 + size + (len(lines) - 1) * pitch
    return {"w": w, "h": h, "glyphs": glyphs}


# セリフを描いて重ねる。フチは全部の字のフチを先に描いてから字を描く（隣の字のフチが字に掛からないように）
def _paste_text(canvas, s):
    fonts = {}

    def font(size):
        key = round(size, 2)
        if key not in fonts:
            fonts[key] = load_font(s["font"], key)
        return fonts[key]

    lay = layout_text(s, lambda t, size: font(size).getlength(t))
    # 回した字や縦中横がはみ出しても切れないよう、周りに余白を取って描く
    margin = int(s["size"] * 2 + s["outline"] * 2 + 4)
    layer = Image.new("RGBA", (int(lay["w"]) + margin * 2 + 1, int(lay["h"]) + margin * 2 + 1), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    passes = ([(s["outlineColor"], s["outline"])] if s["outline"] else []) + [(s["color"], 0)]
    for color, stroke in passes:
        for g in lay["glyphs"]:
            if not g["t"].strip():
                continue
            x, y = g["x"] + margin, g["y"] + margin
            opts = {"font": font(g["size"]), "anchor": "mm", "fill": color}
            if stroke:
                opts.update(stroke_width=stroke, stroke_fill=color)
            if not g["rot"]:
                draw.text((x, y), g["t"], **opts)
                continue
            side = int(g["size"] * 2 + stroke * 2 + 4)
            glyph = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            ImageDraw.Draw(glyph).text((side / 2, side / 2), g["t"], **opts)
            glyph = glyph.rotate(-90)   # 時計回りに 90°
            layer.alpha_composite(glyph, (int(round(x - side / 2)), int(round(y - side / 2))))
    # 画面で組んだ枠の中心に合わせる
    left = s["x"] + s["w"] / 2 - lay["w"] / 2 - margin
    top = s["y"] + s["h"] / 2 - lay["h"] / 2 - margin
    canvas.paste(layer, (round(left), round(top)), layer)


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
            if s.get("pts"):
                x0, y0, mask = _polygon_mask(s, 0)
                canvas.paste("white", (x0, y0, x0 + mask.width, y0 + mask.height), mask)
            else:
                x0, y0 = round(s["x"]), round(s["y"])
                draw.rectangle((x0, y0, x0 + round(s["w"]) - 1, y0 + round(s["h"]) - 1), fill="white")
            _paste_panel(canvas, project, s)
        if s["type"] == "rect" and s["stroke"] and s.get("pts"):
            x0, y0, mask = _polygon_mask(s, s["stroke"])
            canvas.paste("black", (x0, y0, x0 + mask.width, y0 + mask.height), mask)
        elif s["type"] == "rect" and s["stroke"]:
            x0, y0 = round(s["x"]), round(s["y"])
            draw.rectangle((x0, y0, x0 + round(s["w"]) - 1, y0 + round(s["h"]) - 1), outline="black", width=s["stroke"])
        elif s["type"] == "line":
            draw.line(((s["x1"], s["y1"]), (s["x2"], s["y2"])), fill="black", width=s["stroke"])
    # 3. 素材とオノマトペは、コマと線の上に並び順に重ねる（透明な所は下が見える）
    # フキダシは持ち主のすぐ下に描く
    for s in page["shapes"]:
        if s["type"] == "sfx":
            _paste_balloon(canvas, s)
        if s["type"] in ("material", "sfx", "hline") and s["name"] and s["w"] >= 1 and s["h"] >= 1:
            _paste_material(canvas, project, s)
    # 4. セリフはいちばん上に、並び順に
    for s in page["shapes"]:
        if s["type"] == "text":
            _paste_balloon(canvas, s)
            _paste_text(canvas, s)
    out = io.BytesIO()
    canvas.save(out, "PNG")
    return out.getvalue()


# items は Book の並び（コマページ）。コマページは 1 枚の画像にする。コマページ以外は飛ばす
def book_zip(project, items):
    pages = [_sanitize_page(item, None) for item in _dicts(items) if item.get("type") == "page"]
    if not pages:
        raise ValueError("書き出すコマページがありません")
    width = max(3, len(str(len(pages))))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i, page in enumerate(pages, 1):
            # 日時も手がかりにならないよう固定にする
            info = zipfile.ZipInfo(f"{i:0{width}d}.png", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, render_page(project, page))
    return buf.getvalue()


# 生成に使うポーズ。JS で描いたポーズの画像（PNG の base64）と ControlNet の設定
def _job_pose(raw, project, cut):
    if not isinstance(raw, dict):
        return None
    data = str(raw.get("image", ""))
    if "," in data:
        data = data.split(",", 1)[1]
    try:
        image = Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")
    except Exception:
        raise ValueError("ポーズの画像が読めません")
    control = _sanitize_pose_control(raw)
    if not control["model"]:
        raise ValueError("ControlNet のモデルが決まっていません")
    depth = None
    if control["depth"]["use"]:
        depth = _job_depth(control, raw.get("depth"), project, cut)
    return {**control, "image": np.array(image), "depth": depth}


DEPTH_MODULES = ("depth_anything_v2", "depth_anything", "depth_midas", "depth_zoe", "depth_leres++", "depth_leres")


def depth_modules():
    try:
        names = _controlnet_state().get_filtered_preprocessor_names("Depth")
    except Exception:
        return []
    names = [x for x in names if x and x != "None"]
    # よく使うものを先に
    return sorted(names, key=lambda x: DEPTH_MODULES.index(x) if x in DEPTH_MODULES else len(DEPTH_MODULES))


# 深度は、ポーズの取り出し元（このカット案の画像）から ControlNet のプリプロセッサで作る（大きさも生成に合わせて ControlNet が直す）
def _job_depth(control, raw, project, cut):
    depth = control["depth"]
    if depth["unit"] == control["unit"]:
        raise ValueError("深度のユニットは、ポーズと別の番号にしてください")
    if not depth["model"]:
        raise ValueError("深度の ControlNet のモデルが決まっていません")
    name = str((raw or {}).get("name", ""))
    if not name:
        raise ValueError("深度は、ポーズをカット案の画像から取り出したときだけ使えます（取り出し元の画像がありません）")
    path = image_path(project, cut, name)
    if not os.path.isfile(path):
        raise ValueError(f"深度に使う取り出し元の画像がありません（{name}）")
    module = depth["module"]
    available = depth_modules()
    if not module:
        if not available:
            raise ValueError("ControlNet に深度のプリプロセッサがありません")
        module = available[0]
    elif available and module not in available:
        raise ValueError(f"深度のプリプロセッサ {module} がありません")
    with Image.open(path) as im:
        source = im.convert("RGB")
    erased = erase_moved_limbs(source, (raw or {}).get("erase"))
    return {**depth, "module": module, "image": np.array(source), "name": name, "erased": erased}


# ポーズで動かした手足の元の位置（JS が決めた線と円。座標は 0〜1、太さは短い辺に対する比）を、背景の色で塗る。
# 元の手足が深度に残ると、ポーズで動かした手足と一緒に元の手足も描かれてしまうため。塗った数を返す
def erase_moved_limbs(image, shapes):
    shapes = _dicts(shapes)[:DEPTH_ERASE_MAX]
    if not shapes:
        return 0
    w, h = image.size
    short = min(w, h)
    # 背景の色は、画像の縁の色の中央値
    arr = np.asarray(image)
    border = np.concatenate([arr[0], arr[-1], arr[:, 0], arr[:, -1]])
    color = tuple(int(v) for v in np.median(border, axis=0))
    draw = ImageDraw.Draw(image)
    count = 0
    for s in shapes:
        a, b = s.get("a"), s.get("b")
        if not (isinstance(a, list) and isinstance(b, list) and len(a) == 2 and len(b) == 2):
            continue
        ax, ay = _clamp_float(a[0], -1, 2, 0) * w, _clamp_float(a[1], -1, 2, 0) * h
        bx, by = _clamp_float(b[0], -1, 2, 0) * w, _clamp_float(b[1], -1, 2, 0) * h
        width = max(1.0, _clamp_float(s.get("w"), 0, 1, 0) * short)
        r = width / 2
        # 線の両端は丸くする
        if (ax, ay) != (bx, by):
            draw.line([(ax, ay), (bx, by)], fill=color, width=int(round(width)))
        for x, y in ((ax, ay), (bx, by)):
            draw.ellipse([x - r, y - r, x + r, y + r], fill=color)
        count += 1
    return count


def _controlnet_script(p):
    for s in (p.scripts.alwayson_scripts if p.scripts else []):
        if type(s).__name__ == "ControlNetForForgeOfficial":
            return s
    return None


def _enum_member(current, module_attr, name):
    # reforge と Neo で値の文字列が違うので、名前（BALANCED など）で選ぶ
    cls = type(current)
    if not hasattr(cls, "__members__"):
        try:
            from lib_controlnet import external_code
            cls = getattr(external_code, module_attr)
        except Exception:
            return current
    return cls[name] if name in cls.__members__ else current


# ControlNet のユニットを、このポーズで生成する設定に差し替える。WebUI の画面の ControlNet の設定は変えない
def apply_pose(p, pose):
    cn = _controlnet_script(p)
    if cn is None:
        raise RuntimeError("[Polaris Studio] ControlNet が見つからないので、ポーズを使えません")
    args = list(p.script_args)
    _set_unit(cn, args, pose["unit"], pose["mode"], {
        "module": "None",
        "model": pose["model"],
        "weight": pose["weight"],
        "guidance_start": pose["start"],
        "guidance_end": pose["end"],
        "pixel_perfect": False,
        # ポーズの画像をプレビューとして入れ、それを入力に使う（ControlNet の Upload JSON と同じ）
        "use_preview_as_input": True,
        "generated_image": pose["image"],
    })
    message = f"[Polaris Studio] pose -> ControlNet unit {pose['unit'] + 1} ({pose['model']})"
    depth = pose.get("depth")
    if depth:
        source = depth["image"]
        _set_unit(cn, args, depth["unit"], pose["mode"], {
            "module": depth["module"],
            "model": depth["model"],
            "weight": depth["weight"],
            "guidance_start": depth["start"],
            "guidance_end": depth["end"],
            # 深度は ControlNet がプリプロセッサで作る。解像度は生成の大きさに合わせる
            "pixel_perfect": True,
            "use_preview_as_input": False,
            "generated_image": None,
            # reforge は {image, mask} の形だけを読む（Neo もこの形を読める）
            "image": {"image": source, "mask": np.zeros_like(source)},
        })
        message += f", depth -> unit {depth['unit'] + 1} ({depth['module']}, {depth['model']}, erased {depth.get('erased', 0)} limb parts)"
    p.script_args = tuple(args) if isinstance(p.script_args, tuple) else args
    print(message)


def _set_unit(cn, args, number, mode, values):
    index = cn.args_from + number
    if not cn.args_from <= index < cn.args_to:
        raise RuntimeError(f"[Polaris Studio] ControlNet のユニット {number + 1} がありません（ユニットは {cn.args_to - cn.args_from} 個）")
    unit = args[index]
    values = {"enabled": True, "image_fg": None, "mask_image": None, "mask_image_fg": None, **values}
    if isinstance(unit, dict):
        unit = {**unit, **values, "control_mode": mode, "resize_mode": "Crop and Resize"}
    else:
        unit = copy.copy(unit)
        values["control_mode"] = _enum_member(getattr(unit, "control_mode", None), "ControlMode", mode)
        values["resize_mode"] = _enum_member(getattr(unit, "resize_mode", None), "ResizeMode", "INNER_FIT")
        for k, v in values.items():
            if hasattr(unit, k):
                setattr(unit, k, v)
    args[index] = unit


# ControlNet（WebUI に組み込みのもの）の中身を直接使う。Neo は --api で起動しないと /controlnet/* の API を出さないので、それには頼らない
def _controlnet_state():
    try:
        from lib_controlnet import global_state
    except Exception as e:
        raise RuntimeError(f"ControlNet が見つかりません（{e}）")
    return global_state


POSE_DETECT_MODULE = "dw_openpose_full"
POSE_DETECT_RES = 768


def pose_models():
    return [x for x in _controlnet_state().get_all_controlnet_names() if x and x != "None"]


# 画像から DWPose でポーズを取り出す。座標は 0〜1、キャンバスは元の画像の大きさ
def detect_pose(data):
    from modules.call_queue import queue_lock

    image = Image.open(io.BytesIO(data)).convert("RGB")
    processor = _controlnet_state().get_preprocessor(POSE_DETECT_MODULE)
    if processor is None:
        raise RuntimeError(f"ControlNet のプリプロセッサ {POSE_DETECT_MODULE} がありません")
    result = {}

    def accept(pose):
        result["pose"] = pose

    # 生成と同時に GPU を使わないよう、WebUI の生成と同じ順番待ちに並ぶ
    with queue_lock:
        processor(np.array(image), resolution=POSE_DETECT_RES, slider_1=64, slider_2=64, json_pose_callback=accept)
    pose = result.get("pose")
    if not isinstance(pose, dict):
        raise RuntimeError("ポーズを取り出せませんでした")
    return pose_to_original(pose, image.width, image.height, POSE_DETECT_RES)


# 取り出す前に、画像は短い辺を resolution に縮め（ControlNet の resize_image_with_pad）、右と下を 64 の倍数まで伸ばしている。
# 点はその縮めた画像の座標（px か、伸ばした画像に対する 0〜1）で返るので、元の画像の px に直す
def pose_to_original(pose, width, height, resolution):
    k = float(resolution) / float(min(width, height))
    target_w = max(1, int(round(width * k)))
    target_h = max(1, int(round(height * k)))
    padded_w = float(pose.get("canvas_width") or 0) or target_w + (-target_w % 64)
    padded_h = float(pose.get("canvas_height") or 0) or target_h + (-target_h % 64)
    keys = ("pose_keypoints_2d", "hand_left_keypoints_2d", "hand_right_keypoints_2d", "face_keypoints_2d")
    people = [p for p in pose.get("people") or [] if isinstance(p, dict)]
    # 見つかった点に 1 より大きい値があれば px（ControlNet と同じ見分け方）
    pixel = any(
        isinstance(p.get(key), list) and any(
            p[key][i + 2] >= 1 and (p[key][i] > 1 or p[key][i + 1] > 1) for i in range(0, len(p[key]) - 2, 3))
        for p in people for key in keys)
    sx = width / target_w * (1 if pixel else padded_w)
    sy = height / target_h * (1 if pixel else padded_h)
    out = []
    for p in people:
        q = dict(p)
        for key in keys:
            a = p.get(key)
            if not isinstance(a, list):
                continue
            b = list(a)
            for i in range(0, len(b) - 2, 3):
                # 見つからなかった点は (0, 0) のまま残す
                if b[i + 2] >= 1 or b[i] or b[i + 1]:
                    b[i] = round(float(b[i]) * sx, 2)
                    b[i + 1] = round(float(b[i + 1]) * sy, 2)
            q[key] = b
        out.append(q)
    return {**pose, "people": out, "canvas_width": width, "canvas_height": height}


def take_job():
    global _job
    job, _job = _job, None
    return job if job and time.time() - job["at"] < JOB_LIFETIME else None


class PolarisJobScript(scripts.Script):
    """JS から頼まれた生成だけ、保存先をカット案のフォルダにして、識別子を生成情報に入れる。
    txt2img は1回の生成ごとに頼まれる。頼まれていない txt2img の生成は、ポラスタの「生成」で決めた保存先（_t2i）があればそこに入れる。
    img2img はビューワーから送ったあと、解除するまでずっと続く。"""

    def title(self):
        return "Polaris Studio"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def before_process(self, p, *args):
        job = _i2i if self.is_img2img else (take_job() or _t2i)
        if job is None:
            return
        p.outpath_samples = cut_dir(job["project"], job["cut"])
        p.do_not_save_grid = True
        # 日付などのフォルダを作らず、カット案のフォルダの直下に保存する
        p.override_settings["save_to_dirs"] = False
        p.override_settings["samples_save"] = True
        p.extra_generation_params["Polaris Cut"] = job["cut"]
        p.extra_generation_params["Polaris Source"] = job["source"]
        if job.get("pose"):
            apply_pose(p, job["pose"])


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
        try:
            pose = _job_pose(payload.get("pose"), payload["project"], payload["cut"])
        except ValueError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        _job = {"project": payload["project"], "cut": payload["cut"], "source": str(payload.get("source", "preview")), "pose": pose, "at": time.time()}
        return {"ok": True}

    @app.get("/polaris-studio/pose/models")
    def get_pose_models():
        try:
            return {"ok": True, "models": pose_models(), "depthModules": depth_modules()}
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    # 画像（リクエスト本文にそのまま入れたバイト列）からポーズを取り出す
    @app.post("/polaris-studio/pose/detect")
    async def post_pose_detect(request: Request):
        data = await request.body()
        try:
            pose = await asyncio.to_thread(detect_pose, data)
        except Exception as e:
            print(f"[Polaris Studio] pose detect failed: {e}")
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        return {"ok": True, "pose": pose}

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

    @app.get("/polaris-studio/t2i")
    def get_t2i():
        return {"ok": True, "target": _t2i}

    @app.post("/polaris-studio/t2i")
    def set_t2i(payload: dict = Body(...)):
        global _t2i
        try:
            cut_dir(payload.get("project"), payload.get("cut"))
        except ValueError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        _t2i = {"project": str(payload["project"]), "cut": str(payload["cut"]), "source": "txt2img", "label": str(payload.get("label", ""))[:200]}
        return {"ok": True, "target": _t2i}

    @app.post("/polaris-studio/t2i/clear")
    def clear_t2i():
        global _t2i
        _t2i = None
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

    # 素材の画像（リクエスト本文にそのまま入れたバイト列）を、メタ情報を持たない PNG にして保存する
    @app.post("/polaris-studio/materials/upload")
    async def upload_material(request: Request, project: str):
        data = await request.body()
        try:
            saved = save_material(project, data)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        return {"ok": True, **saved}

    # 素材の名前は中身から作るので、同じ名前なら中身も同じ（長くキャッシュしてよい）
    @app.get("/polaris-studio/material")
    def get_material(project: str, name: str):
        try:
            path = material_path(project, name)
            if not os.path.isfile(path):
                return JSONResponse({"ok": False, "error": "not found"}, status_code=404)
            return FileResponse(path, media_type="image/png", headers={"Cache-Control": "max-age=31536000, immutable"})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    # セリフに使えるフォントの一覧。最初の 1 回はフォントを読むので少し時間がかかる（refresh で読み直す）
    @app.get("/polaris-studio/fonts")
    def get_fonts(refresh: bool = False):
        try:
            return {"ok": True, "fonts": list_fonts(refresh)}
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    # フォント選びの見本
    @app.get("/polaris-studio/font-sample")
    def get_font_sample(id: str):
        try:
            data = font_sample(id)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=404)
        return Response(data, media_type="image/png", headers={"Cache-Control": "max-age=86400"})

    # 編集画面で同じ字形を出すためのフォントのファイル
    @app.get("/polaris-studio/font")
    def get_font(id: str):
        try:
            data = font_bytes(id)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=404)
        return Response(data, media_type="application/octet-stream", headers={"Cache-Control": "max-age=86400"})

    # オノマトペの字形の輪郭
    @app.get("/polaris-studio/glyphs")
    def get_glyphs(font: str, text: str):
        try:
            return {"ok": True, "glyphs": glyph_outlines(font, text)}
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    # オノマトペの登録した文字列と調整済みスタンプ（プロジェクトごと）
    @app.get("/polaris-studio/sfx")
    def get_sfx(project: str = ""):
        try:
            with _lock:
                return {"ok": True, **load_sfx_library(project)}
        except ValueError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    @app.post("/polaris-studio/sfx")
    def put_sfx(payload: dict = Body(...)):
        data = sanitize_sfx_library(payload)
        try:
            with _lock:
                save_sfx_library(payload.get("project"), data)
        except ValueError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        return {"ok": True, **data}

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
        global _i2i, _t2i
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
        if _t2i and _t2i["project"] == payload.get("project") and (not cut or _t2i["cut"] == cut):
            _t2i = None
        return {"ok": True}

    # 変わったプロジェクトだけを保存する（一覧全体の上書きはしない。古い画面が保存してもほかのプロジェクトを消さないように）
    @app.post("/polaris-studio/projects/save")
    def save_project_changes(payload: dict = Body(...)):
        try:
            with _lock:
                _, missing = apply_project_changes(payload)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        return {"ok": True, "missing": missing}

    # Book の画像とコマページを並び順に ZIP にして返す。ファイル名は JS 側で Book のタイトルから付ける
    @app.post("/polaris-studio/books/export")
    def export_book(payload: dict = Body(...)):
        try:
            data = book_zip(payload.get("project"), payload.get("items") or [])
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
