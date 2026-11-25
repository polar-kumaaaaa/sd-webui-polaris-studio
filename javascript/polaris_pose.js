// Polaris Studio: ポーズ（OpenPose）の編集
// カット案ごとに 1 つのポーズを持つ。画像から DWPose で取り出し、体・手・顔の点を 1 つずつ動かせる。
// ポーズの絵は ControlNet と同じ描き方でここで描き、生成のときに PNG にして Python に渡す（ControlNet のユニットに入れるのは Python 側）
(function () {
    "use strict";

    // ---------- OpenPose の形 ----------
    // 体は 18 点、手は 21 点ずつ、顔は 70 点。JSON では [x, y, c] の並びで、c が 1 未満の点は「ない（隠した）」点
    const PARTS = [
        {id: "body", key: "pose_keypoints_2d", count: 18, label: "体"},
        // 並びは Python 側で保存するときと同じにする（保存していない変更があるかを JSON の文字列で比べるため）
        {id: "left", key: "hand_left_keypoints_2d", count: 21, label: "左手"},
        {id: "right", key: "hand_right_keypoints_2d", count: 21, label: "右手"},
        {id: "face", key: "face_keypoints_2d", count: 70, label: "顔"},
    ];
    const PART = Object.fromEntries(PARTS.map((x) => [x.id, x]));
    const BODY_NAMES = ["鼻", "首", "右肩", "右ひじ", "右手首", "左肩", "左ひじ", "左手首", "右腰", "右ひざ", "右足首", "左腰", "左ひざ", "左足首", "右目", "左目", "右耳", "左耳"];
    const FINGER_NAMES = ["親指", "人差し指", "中指", "薬指", "小指"];

    // ControlNet（annotator/openpose/util.py）と同じ線の組み合わせと色
    const LIMBS = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18]];
    const COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255],
        [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]];
    const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]];

    const MODES = [["BALANCED", "バランス"], ["PROMPT", "プロンプトを重視"], ["CONTROL", "ControlNet を重視"]];
    const DEFAULT_CONTROL = {use: false, unit: 0, model: "", weight: 1, start: 0, end: 1, mode: "BALANCED"};
    const HIT = 9;                  // 点をつかめる距離（画面の px）
    const UNDO_MAX = 100;
    const VIEW_KEY = "polaris-studio:pose-view";

    const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const rgb = (c, k = 1) => `rgb(${Math.floor(c[0] * k)},${Math.floor(c[1] * k)},${Math.floor(c[2] * k)})`;

    // HSV（色相 0〜1、彩度と明度は 1）を RGB に。ControlNet の手の線の色
    function hueColor(h) {
        const i = Math.floor(h * 6);
        const f = h * 6 - i;
        const q = 1 - f;
        const [r, g, b] = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][i % 6];
        return [r * 255, g * 255, b * 255];
    }

    // ---------- JSON と編集用の形の行き来 ----------
    // 編集中は、点を {x, y, v}（座標はキャンバスの px、v は見えるか）で持つ。部位がない人は null

    function fromJson(json) {
        const w = Math.max(1, Number(json && json.canvas_width) || 512);
        const h = Math.max(1, Number(json && json.canvas_height) || 512);
        const people = Array.isArray(json && json.people) ? json.people : [];
        // 座標が 0〜1 なら比率、それより大きい値があれば px（ControlNet と同じ見分け方）
        let normalized = true;
        for (const person of people) for (const part of PARTS) {
            const a = person[part.key];
            if (Array.isArray(a)) for (let i = 0; i < a.length; i += 3) if (a[i + 2] >= 1 && (a[i] > 1 || a[i + 1] > 1)) normalized = false;
        }
        const sx = normalized ? w : 1;
        const sy = normalized ? h : 1;
        const list = [];
        for (const person of people) {
            const out = {};
            for (const part of PARTS) {
                const a = person[part.key];
                if (!Array.isArray(a) || a.length !== part.count * 3) {
                    out[part.id] = null;
                    continue;
                }
                out[part.id] = [];
                for (let i = 0; i < part.count; i++) {
                    const x = Number(a[i * 3]) || 0;
                    const y = Number(a[i * 3 + 1]) || 0;
                    const v = Number(a[i * 3 + 2]) >= 1;
                    // 見つからなかった点は (0, 0) で来るので、置き場所が決まっていない印を付けて、あとで仮の場所に置く
                    out[part.id].push({x: x * sx, y: y * sy, v, unplaced: !v && x === 0 && y === 0});
                }
                if (part.id !== "body" && !out[part.id].some((p) => p.v)) out[part.id] = null;
            }
            if (!out.body) continue;
            list.push(out);
        }
        for (const person of list) placeHidden(person, w, h);
        return {width: w, height: h, people: list, source: (json && json.source) || ""};
    }

    // 保存する形（座標は 0〜1）。pixel が真なら px にする（JSON の書き出し用）
    function toJson(model, pixel) {
        const sx = pixel ? 1 : 1 / model.width;
        const sy = pixel ? 1 : 1 / model.height;
        const r = (v) => Math.round(v * 100000) / 100000;
        return {
            canvas_width: model.width,
            canvas_height: model.height,
            people: model.people.map((person) => {
                const out = {};
                for (const part of PARTS) {
                    const pts = person[part.id];
                    out[part.key] = pts ? pts.flatMap((p) => [r(p.x * sx), r(p.y * sy), p.v ? 1 : 0]) : null;
                }
                return out;
            }),
            ...(pixel ? {} : {source: model.source || ""}),
        };
    }

    // ---------- ひな形（人を足す、手・顔を足す、見つからなかった点の仮の場所） ----------
    // 体は首を原点、首から腰までの長さを 1 とした位置。画面の左が人物の右（こちらを向いている人）
    const BODY_TPL = [[0, -0.35], [0, 0], [-0.28, 0], [-0.33, 0.45], [-0.36, 0.85], [0.28, 0], [0.33, 0.45], [0.36, 0.85],
        [-0.15, 1], [-0.17, 1.6], [-0.18, 2.2], [0.15, 1], [0.17, 1.6], [0.18, 2.2], [-0.06, -0.42], [0.06, -0.42], [-0.13, -0.38], [0.13, -0.38]];
    // 手は手首を原点に、指の向きを u、横を w とした位置（手の長さを 1）
    const HAND_TPL = [[0, 0],
        [0.15, -0.25], [0.3, -0.4], [0.45, -0.5], [0.58, -0.58],
        [0.45, -0.15], [0.65, -0.17], [0.78, -0.18], [0.9, -0.19],
        [0.47, 0], [0.7, 0], [0.84, 0], [0.97, 0],
        [0.44, 0.13], [0.65, 0.15], [0.77, 0.16], [0.88, 0.17],
        [0.4, 0.25], [0.56, 0.29], [0.66, 0.31], [0.75, 0.33]];

    // 顔は鼻を中心に、顔の半分の幅を 1 とした位置（OpenPose の 70 点の並び）
    const FACE_TPL = (() => {
        const pts = [];
        for (let i = 0; i <= 16; i++) {
            const a = Math.PI * (i / 16);
            pts.push([-Math.cos(a), -0.25 + Math.sin(a) * 1.15]);
        }
        for (let i = 0; i < 5; i++) pts.push([-0.75 + i * 0.15, -0.62 - Math.sin(Math.PI * i / 4) * 0.08]);
        for (let i = 0; i < 5; i++) pts.push([0.15 + i * 0.15, -0.62 - Math.sin(Math.PI * i / 4) * 0.08]);
        for (let i = 0; i < 4; i++) pts.push([0, -0.45 + i * 0.15]);
        for (let i = 0; i < 5; i++) pts.push([-0.2 + i * 0.1, 0.18 - (i === 2 ? 0.03 : 0)]);
        const eye = (cx) => {
            for (let i = 0; i < 6; i++) {
                const a = Math.PI - i * Math.PI / 3;
                pts.push([cx + Math.cos(a) * 0.18, -0.38 - Math.sin(a) * 0.07]);
            }
        };
        eye(-0.42);
        eye(0.42);
        for (let i = 0; i < 12; i++) {
            const a = Math.PI - i * Math.PI / 6;
            pts.push([Math.cos(a) * 0.4, 0.5 - Math.sin(a) * 0.15]);
        }
        for (let i = 0; i < 8; i++) {
            const a = Math.PI - i * Math.PI / 4;
            pts.push([Math.cos(a) * 0.28, 0.5 - Math.sin(a) * 0.06]);
        }
        pts.push([-0.42, -0.38], [0.42, -0.38]);
        return pts;
    })();

    const visible = (p) => p && p.v;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    // 体の大きさ（首から腰までの長さ）を、見えている点から見積もる
    function bodyUnit(body, h) {
        const neck = body[1];
        const hips = [body[8], body[11]].filter(visible);
        if (visible(neck) && hips.length) {
            const mid = {x: hips.reduce((s, p) => s + p.x, 0) / hips.length, y: hips.reduce((s, p) => s + p.y, 0) / hips.length};
            const d = dist(neck, mid);
            if (d > 4) return d;
        }
        if (visible(body[2]) && visible(body[5])) {
            const d = dist(body[2], body[5]) / 0.56;
            if (d > 4) return d;
        }
        return h * 0.25;
    }

    function bodyOrigin(body, w, h) {
        if (visible(body[1])) return {x: body[1].x, y: body[1].y};
        const vis = body.filter(visible);
        if (!vis.length) return {x: w / 2, y: h * 0.3};
        return {x: vis.reduce((s, p) => s + p.x, 0) / vis.length, y: vis.reduce((s, p) => s + p.y, 0) / vis.length};
    }

    // 見つからなかった体の点を、ひな形の位置に（隠したまま）置く。あとで「見せる」にしたとき、それらしい所に出る
    function placeHidden(person, w, h) {
        const body = person.body;
        const u = bodyUnit(body, h);
        const o = bodyOrigin(body, w, h);
        body.forEach((p, i) => {
            if (!p.unplaced) return;
            p.x = o.x + BODY_TPL[i][0] * u;
            p.y = o.y + BODY_TPL[i][1] * u;
            delete p.unplaced;
        });
        for (const id of ["left", "right", "face"]) if (person[id]) person[id].forEach((p) => delete p.unplaced);
    }

    function newPerson(w, h, cx, cy) {
        const u = h * 0.2;
        const body = BODY_TPL.map(([x, y]) => ({x: cx + x * u, y: cy - u * 0.9 + y * u, v: true}));
        const person = {body, left: null, right: null, face: null};
        addHand(person, "right", h);
        addHand(person, "left", h);
        addFace(person, h);
        return person;
    }

    // 手首とひじから、手のひな形を置く
    function addHand(person, side, h) {
        const wrist = person.body[side === "right" ? 4 : 7];
        const elbow = person.body[side === "right" ? 3 : 6];
        let dx = 0;
        let dy = 1;
        let len = h * 0.07;
        if (wrist && elbow && dist(wrist, elbow) > 2) {
            dx = (wrist.x - elbow.x) / dist(wrist, elbow);
            dy = (wrist.y - elbow.y) / dist(wrist, elbow);
            len = dist(wrist, elbow) * 0.75;
        }
        // 画面の左にある右手は、親指を体の内側（画面の右）に向ける
        const sign = side === "right" ? -1 : 1;
        const nx = -dy * sign;
        const ny = dx * sign;
        person[side] = HAND_TPL.map(([u, w]) => ({x: wrist.x + (dx * u + nx * w) * len, y: wrist.y + (dy * u + ny * w) * len, v: true}));
    }

    function addFace(person, h) {
        const body = person.body;
        const nose = body[0];
        let f = bodyUnit(body, h) * 0.3;
        if (visible(body[14]) && visible(body[15])) f = Math.max(dist(body[14], body[15]) / 0.84 * 0.95, 3);
        person.face = FACE_TPL.map(([x, y]) => ({x: nose.x + x * f, y: nose.y - 0.05 * f + y * f, v: true}));
    }

    // ---------- 描画（ControlNet と同じ見た目） ----------

    function drawPose(ctx, model, {hands = true, face = true} = {}) {
        for (const person of model.people) {
            const body = person.body;
            LIMBS.forEach(([a, b], i) => {
                const p = body[a - 1];
                const q = body[b - 1];
                if (!visible(p) || !visible(q)) return;
                const mx = (p.x + q.x) / 2;
                const my = (p.y + q.y) / 2;
                const len = dist(p, q);
                ctx.beginPath();
                ctx.ellipse(mx, my, Math.max(len / 2, 0.5), 4, Math.atan2(q.y - p.y, q.x - p.x), 0, Math.PI * 2);
                ctx.fillStyle = rgb(COLORS[i], 0.6);
                ctx.fill();
            });
            body.forEach((p, i) => {
                if (!visible(p)) return;
                ctx.beginPath();
                ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = rgb(COLORS[i]);
                ctx.fill();
            });
            if (hands) for (const side of ["left", "right"]) {
                const pts = person[side];
                if (!pts) continue;
                ctx.lineWidth = 2;
                ctx.lineCap = "round";
                HAND_EDGES.forEach(([a, b], i) => {
                    if (!visible(pts[a]) || !visible(pts[b])) return;
                    ctx.beginPath();
                    ctx.moveTo(pts[a].x, pts[a].y);
                    ctx.lineTo(pts[b].x, pts[b].y);
                    ctx.strokeStyle = rgb(hueColor(i / HAND_EDGES.length));
                    ctx.stroke();
                });
                ctx.fillStyle = "rgb(0,0,255)";
                for (const p of pts) {
                    if (!visible(p)) continue;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            if (face && person.face) {
                ctx.fillStyle = "rgb(255,255,255)";
                for (const p of person.face) {
                    if (!visible(p)) continue;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    }

    // 生成に使うポーズの絵（黒地）。保存した形（座標は 0〜1）から描く
    function renderDataUrl(json) {
        const model = fromJson(json);
        const canvas = document.createElement("canvas");
        canvas.width = model.width;
        canvas.height = model.height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, model.width, model.height);
        drawPose(ctx, model);
        return canvas.toDataURL("image/png");
    }

    // ---------- ControlNet ----------

    let modelCache = null;

    async function controlnetModels(reload) {
        if (modelCache && !reload) return modelCache;
        // ControlNet の /controlnet/* の API は Neo では --api のときしか出ないので、ポラスタの API から読む
        const res = await fetch("polaris-studio/pose/models", {cache: "no-store"});
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error("ControlNet のモデルの一覧が読めません（" + (data.error || res.status) + "）");
        const list = data.models || [];
        // OpenPose のモデルを先に並べる
        modelCache = [...list.filter((x) => /openpose/i.test(x)), ...list.filter((x) => !/openpose/i.test(x))];
        return modelCache;
    }

    async function resolveModel(name) {
        if (name) return name;
        const found = (await controlnetModels()).find((x) => /openpose/i.test(x));
        if (!found) throw new Error("名前に openpose を含む ControlNet のモデルが見つかりません。ポーズの画面でモデルを選んでください");
        return found;
    }

    // 生成に渡す形 {image, unit, model, weight, start, end, mode}
    async function jobPayload(job) {
        const control = {...DEFAULT_CONTROL, ...(job.control || {})};
        return {
            image: renderDataUrl(job.pose),
            unit: control.unit,
            model: await resolveModel(control.model),
            weight: control.weight,
            start: control.start,
            end: control.end,
            mode: control.mode,
        };
    }

    // 画像の Blob から DWPose（dw_openpose_full）でポーズを取り出す。座標は 0〜1、キャンバスは元の画像の大きさ（Python 側で決める）
    async function detect(blob) {
        const res = await fetch("polaris-studio/pose/detect", {method: "POST", body: blob});
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok || !data.pose) throw new Error("ポーズを取り出せませんでした（" + (data.error || res.status) + "）");
        return data.pose;
    }

    function imageSize(src) {
        return new Promise((ok, ng) => {
            const img = new Image();
            img.onload = () => ok({width: img.naturalWidth, height: img.naturalHeight, img});
            img.onerror = () => ng(new Error("画像が読めません"));
            img.src = src;
        });
    }

    // ---------- エディタ ----------

    let root = null;                // .ps-pose
    let opts = null;                // open() に渡されたもの
    let model = null;               // 編集中 {width, height, people, source}
    let control = null;
    let undoStack = [];
    let redoStack = [];
    let selected = new Set();       // "人の番号:部位:点の番号"
    let view = {zoom: 1, x: 0, y: 0};
    let viewAuto = true;            // 拡大・移動するまでは、画面の大きさが変わるたびに全体を表示し直す
    let show = {hands: true, face: true, underlay: 0.5};
    let underlay = null;            // 下敷きの画像 {img, name}
    let localImage = null;          // 読み込んだファイル（ファイルから選んだか、外からドロップした画像） {blob, url, name}
    let sourceValue = "";           // 下敷き・取り出し元。"" はなし、"::file" は読み込んだファイル、ほかはカット案の画像の名前
    let drag = null;
    let spaceDown = false;
    let busy = false;
    let changed = false;

    const q = (sel) => root.querySelector(sel);
    const keyOf = (pi, part, i) => `${pi}:${part}:${i}`;
    const parseKey = (k) => {
        const [pi, part, i] = k.split(":");
        return {pi: Number(pi), part, i: Number(i)};
    };
    const pointOf = (k) => {
        const {pi, part, i} = parseKey(k);
        const pts = model.people[pi] && model.people[pi][part];
        return pts ? pts[i] : null;
    };

    function build() {
        root = document.createElement("div");
        root.className = "ps-pose ps-off";
        root.tabIndex = -1;
        root.innerHTML = `
            <div class="ps-pose-bar">
                <span class="ps-pose-title">ポーズ</span>
                <button type="button" class="mtm-btn ps-pose-detect" title="右の「下敷き・取り出し元」の画像から、DWPose でポーズを取り出します（今のポーズと置き換えます）">画像から取り出す</button>
                <button type="button" class="mtm-btn ps-pose-add" title="真ん中にひな形の人を足します">＋ 人</button>
                <button type="button" class="mtm-btn ps-pose-parts" title="選んだ人に、ない手と顔をひな形で足します">手・顔を足す</button>
                <button type="button" class="mtm-btn ps-pose-remove" title="選んだ点を含む人を消します">人を消す</button>
                <span class="ps-pose-sep"></span>
                <button type="button" class="mtm-icon ps-pose-undo" title="元に戻す (Ctrl+Z)">↶</button>
                <button type="button" class="mtm-icon ps-pose-redo" title="やり直す (Ctrl+Y)">↷</button>
                <span class="ps-pose-sep"></span>
                <button type="button" class="mtm-btn ps-pose-import" title="OpenPose の JSON を読み込みます">JSON を読み込む</button>
                <button type="button" class="mtm-btn ps-pose-export" title="OpenPose の JSON（座標は px）を保存します">JSON を書き出す</button>
                <span class="mtm-fs-spacer"></span>
                <span class="ps-pose-busy ps-off">取り出し中…</span>
                <button type="button" class="mtm-btn ps-pose-cancel">キャンセル</button>
                <button type="button" class="mtm-btn mtm-primary ps-pose-ok" title="編集画面に戻ります。カット案に入るのは、編集画面で「保存」したときです">決定</button>
            </div>
            <div class="ps-pose-main">
                <div class="ps-pose-stage">
                    <canvas class="ps-pose-canvas"></canvas>
                    <div class="ps-pose-status"></div>
                </div>
                <div class="ps-pose-side">
                    <section>
                        <div class="ps-pose-head">選んでいる点</div>
                        <div class="ps-pose-sel">なし</div>
                        <div class="ps-pose-row">
                            <button type="button" class="mtm-btn ps-pose-hide" title="選んだ点を隠します。隠した点はポーズの絵に描かれません (Delete)">隠す</button>
                            <button type="button" class="mtm-btn ps-pose-unhide" title="選んだ点を見せます (Shift+Delete)">見せる</button>
                        </div>
                    </section>
                    <section>
                        <div class="ps-pose-head">表示</div>
                        <label class="ps-pose-check"><input type="checkbox" class="ps-pose-show-hands" checked>手</label>
                        <label class="ps-pose-check"><input type="checkbox" class="ps-pose-show-face" checked>顔</label>
                        <button type="button" class="mtm-btn ps-pose-fit" title="全体が見える大きさに戻します (F)">全体を表示</button>
                    </section>
                    <section>
                        <div class="ps-pose-head">下敷き・取り出し元</div>
                        <div class="ps-pose-note">クリックで選び、ダブルクリックでそのまま取り出します。ブラウザの外から画像をドロップしても取り出せます</div>
                        <div class="ps-pose-sources"></div>
                        <button type="button" class="mtm-btn ps-pose-file">ファイルから…</button>
                        <label class="ps-pose-range">濃さ<input type="range" class="ps-pose-opacity" min="0" max="1" step="0.05"></label>
                    </section>
                    <section>
                        <div class="ps-pose-head">ControlNet</div>
                        <label class="ps-pose-check"><input type="checkbox" class="ps-pose-use">「生成」とキューでこのポーズを使う</label>
                        <label class="ps-pose-field">ユニット<select class="ps-pose-unit"></select></label>
                        <label class="ps-pose-field">モデル<select class="ps-pose-model"></select><button type="button" class="mtm-icon ps-pose-models" title="モデルの一覧を読み直す">↻</button></label>
                        <label class="ps-pose-field">重み<input type="number" class="ps-pose-weight" min="0" max="2" step="0.05"></label>
                        <label class="ps-pose-field">開始<input type="number" class="ps-pose-start" min="0" max="1" step="0.05"></label>
                        <label class="ps-pose-field">終了<input type="number" class="ps-pose-end" min="0" max="1" step="0.05"></label>
                        <label class="ps-pose-field">重視<select class="ps-pose-mode">${MODES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>
                        <div class="ps-pose-note">使うときは、そのユニットを WebUI の設定に関係なくオンにし、プリプロセッサなしでこのポーズの絵を入れます。WebUI の ControlNet の画面は変えません。</div>
                    </section>
                    <section class="ps-pose-help">
                        <div class="ps-pose-head">操作</div>
                        <div>点をドラッグ：動かす（選んだ点はまとめて）</div>
                        <div>何もない所をドラッグ：囲んで選ぶ</div>
                        <div>Shift+クリック：選ぶ点を足す・外す</div>
                        <div>点をダブルクリック：その部位（体・手・顔）を全部選ぶ</div>
                        <div>ホイール：拡大・縮小</div>
                        <div>右ドラッグ・中ドラッグ・Space+ドラッグ：動かして見る</div>
                        <div>矢印キー：1px 動かす（Shift で 10px）</div>
                        <div>Delete：隠す／Shift+Delete：見せる</div>
                        <div>Ctrl+A：全部選ぶ／Esc：選択を外す</div>
                    </section>
                </div>
            </div>
            <div class="ps-pose-drop ps-off">ここに画像をドロップすると、ポーズを取り出します</div>
            <input type="file" class="ps-pose-file-input" accept="image/*" hidden>
            <input type="file" class="ps-pose-json-input" accept=".json,application/json" hidden>
        `;
        window.PolarisStudio.root().appendChild(root);

        const canvas = q(".ps-pose-canvas");
        canvas.addEventListener("pointerdown", pointerDown);
        canvas.addEventListener("pointermove", pointerMove);
        canvas.addEventListener("pointerup", pointerUp);
        canvas.addEventListener("pointercancel", pointerUp);
        canvas.addEventListener("dblclick", doubleClick);
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        canvas.addEventListener("wheel", wheel, {passive: false});
        new ResizeObserver(() => {
            if (!model) return;
            if (viewAuto) fit();
            draw();
        }).observe(q(".ps-pose-stage"));
        root.addEventListener("keydown", keyDown);
        root.addEventListener("keyup", (e) => {
            if (e.code === "Space") spaceDown = false;
        });

        q(".ps-pose-detect").addEventListener("click", detectFromSource);
        q(".ps-pose-add").addEventListener("click", () => {
            edit(() => model.people.push(newPerson(model.width, model.height, model.width / 2, model.height / 2)));
            selectPart(model.people.length - 1, "body");
        });
        q(".ps-pose-parts").addEventListener("click", addParts);
        q(".ps-pose-remove").addEventListener("click", removePeople);
        q(".ps-pose-undo").addEventListener("click", undo);
        q(".ps-pose-redo").addEventListener("click", redo);
        q(".ps-pose-import").addEventListener("click", () => q(".ps-pose-json-input").click());
        q(".ps-pose-export").addEventListener("click", exportJson);
        q(".ps-pose-json-input").addEventListener("change", importJson);
        q(".ps-pose-cancel").addEventListener("click", cancel);
        q(".ps-pose-ok").addEventListener("click", apply);
        q(".ps-pose-hide").addEventListener("click", () => setVisible(false));
        q(".ps-pose-unhide").addEventListener("click", () => setVisible(true));
        q(".ps-pose-fit").addEventListener("click", () => {
            fit();
            draw();
        });
        q(".ps-pose-show-hands").addEventListener("change", (e) => {
            show.hands = e.target.checked;
            saveView();
            draw();
        });
        q(".ps-pose-show-face").addEventListener("change", (e) => {
            show.face = e.target.checked;
            saveView();
            draw();
        });
        q(".ps-pose-opacity").addEventListener("input", (e) => {
            show.underlay = Number(e.target.value);
            saveView();
            draw();
        });
        q(".ps-pose-file").addEventListener("click", () => q(".ps-pose-file-input").click());
        q(".ps-pose-file-input").addEventListener("change", (e) => {
            const file = e.target.files[0];
            e.target.value = "";
            if (file) useFile(file, false);
        });
        // ブラウザの外から画像をドロップしたら、それを取り出し元にして取り出す。編集画面や WebUI のドロップの処理には渡さない
        let dragDepth = 0;
        const hasFiles = (e) => [...(e.dataTransfer ? e.dataTransfer.types : [])].includes("Files");
        root.addEventListener("dragenter", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            dragDepth++;
            q(".ps-pose-drop").classList.remove("ps-off");
        });
        root.addEventListener("dragover", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
        });
        root.addEventListener("dragleave", (e) => {
            if (!hasFiles(e)) return;
            e.stopPropagation();
            dragDepth = Math.max(0, dragDepth - 1);
            if (!dragDepth) q(".ps-pose-drop").classList.add("ps-off");
        });
        root.addEventListener("drop", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            dragDepth = 0;
            q(".ps-pose-drop").classList.add("ps-off");
            const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
            if (!file) {
                alert("画像のファイルをドロップしてください。");
                return;
            }
            useFile(file, true);
        });
        q(".ps-pose-models").addEventListener("click", () => fillModels(true));
        for (const sel of [".ps-pose-use", ".ps-pose-unit", ".ps-pose-model", ".ps-pose-weight", ".ps-pose-start", ".ps-pose-end", ".ps-pose-mode"]) {
            q(sel).addEventListener("change", () => {
                changed = true;
            });
        }
        const unit = q(".ps-pose-unit");
        for (let i = 0; i < 8; i++) unit.appendChild(new Option(`${i + 1} 番目`, String(i)));
    }

    function loadView() {
        try {
            const v = JSON.parse(localStorage.getItem(VIEW_KEY));
            if (v && typeof v === "object") show = {...show, ...v};
        } catch (e) { /* 読めなければ初めの表示 */ }
    }

    function saveView() {
        try {
            localStorage.setItem(VIEW_KEY, JSON.stringify(show));
        } catch (e) { /* 覚えられなくても表示は変えられる */ }
    }

    // 読み込んだファイルを取り出し元にする。detectNow が真なら、そのままポーズを取り出す
    function useFile(file, detectNow) {
        if (localImage) URL.revokeObjectURL(localImage.url);
        localImage = {blob: file, url: URL.createObjectURL(file), name: file.name};
        fillSources("::file");
        loadUnderlay();
        if (detectNow) detectFromSource();
    }

    // options: {pose, control, size: {width, height}, images, imageUrl(image), thumbUrl(image), preferred, detect, onApply(pose, control), onCancel}
    // preferred は最初に選んでおく取り出し元の画像の名前。detect が真なら、開いてすぐにその画像から取り出す
    function open(options) {
        if (!root) build();
        opts = options;
        loadView();
        const size = options.size || {};
        model = options.pose && Array.isArray(options.pose.people)
            ? fromJson(options.pose)
            : {width: size.width || 512, height: size.height || 768, people: [], source: ""};
        control = {...DEFAULT_CONTROL, ...(options.control || {})};
        undoStack = [];
        redoStack = [];
        selected = new Set();
        changed = false;
        drag = null;
        underlay = null;
        q(".ps-pose-show-hands").checked = show.hands;
        q(".ps-pose-show-face").checked = show.face;
        q(".ps-pose-opacity").value = show.underlay;
        q(".ps-pose-use").checked = control.use;
        q(".ps-pose-unit").value = String(control.unit);
        q(".ps-pose-weight").value = control.weight;
        q(".ps-pose-start").value = control.start;
        q(".ps-pose-end").value = control.end;
        q(".ps-pose-mode").value = control.mode;
        fillModels(false);
        const images = options.images || [];
        // 取り出すために開いたときは、その画像を選ぶ。ほかは、前に取り出した画像があればそれを下敷きにする
        const preferred = options.detect && options.preferred ? options.preferred
            : model.source && images.some((x) => x.name === model.source) ? model.source : options.preferred || "";
        fillSources(preferred);
        root.classList.remove("ps-off");
        fit();
        loadUnderlay();
        updateUi();
        root.focus();
        if (options.detect) detectFromSource();
    }

    function isOpen() {
        return !!root && !root.classList.contains("ps-off");
    }

    function close() {
        if (!root) return;
        root.classList.add("ps-off");
        opts = null;
        model = null;
        underlay = null;
        if (localImage) {
            URL.revokeObjectURL(localImage.url);
            localImage = null;
        }
    }

    async function fillModels(reload) {
        const sel = q(".ps-pose-model");
        const current = control.model;
        sel.textContent = "";
        sel.appendChild(new Option("自動（名前に openpose を含む最初のモデル）", ""));
        try {
            const list = await controlnetModels(reload);
            for (const name of list) sel.appendChild(new Option(name, name));
        } catch (e) {
            sel.appendChild(new Option("（一覧が読めません: " + e.message + "）", "::error"));
        }
        if (current && ![...sel.options].some((o) => o.value === current)) sel.appendChild(new Option(current + "（見つかりません）", current));
        sel.value = current;
    }

    // 取り出し元をサムネイルで並べる（新しい画像が先）。value がなければ、いちばん新しい画像を選ぶ
    function fillSources(value) {
        const box = q(".ps-pose-sources");
        box.textContent = "";
        const images = (opts && opts.images) || [];
        const values = ["", ...(localImage ? ["::file"] : []), ...images.map((x) => x.name)];
        sourceValue = values.includes(value) ? value : images.length ? images[images.length - 1].name : "";
        const tile = (v, title, src, label) => {
            const t = document.createElement("button");
            t.type = "button";
            t.className = "ps-pose-src" + (v === sourceValue ? " ps-selected" : "");
            t.dataset.value = v;
            t.title = title;
            if (src) {
                const img = document.createElement("img");
                img.src = src;
                img.alt = "";
                img.loading = "lazy";
                img.draggable = false;
                t.appendChild(img);
            }
            if (label) {
                const span = document.createElement("span");
                span.textContent = label;
                t.appendChild(span);
            }
            t.addEventListener("click", () => selectSource(v));
            t.addEventListener("dblclick", () => {
                selectSource(v);
                if (v) detectFromSource();
            });
            box.appendChild(t);
        };
        tile("", "下敷きなし", null, "なし");
        if (localImage) tile("::file", "読み込んだ画像: " + localImage.name, localImage.url, "ファイル");
        const thumb = opts && opts.thumbUrl ? opts.thumbUrl : opts && opts.imageUrl;
        for (const image of [...images].reverse()) tile(image.name, image.name, thumb ? thumb(image) : null, "");
    }

    function selectSource(v) {
        if (v === sourceValue) return;
        sourceValue = v;
        for (const t of q(".ps-pose-sources").children) t.classList.toggle("ps-selected", t.dataset.value === v);
        loadUnderlay();
    }

    function sourceBlobUrl() {
        const v = sourceValue;
        if (!v) return null;
        if (v === "::file") return localImage ? localImage.url : null;
        const image = (opts.images || []).find((x) => x.name === v);
        return image ? opts.imageUrl(image) : null;
    }

    async function loadUnderlay() {
        const url = sourceBlobUrl();
        underlay = null;
        draw();
        if (!url) return;
        try {
            const {img} = await imageSize(url);
            if (sourceBlobUrl() !== url) return;
            underlay = {img};
            draw();
        } catch (e) {
            status("下敷きの画像が読めません");
        }
    }

    async function detectFromSource() {
        if (busy) return;
        const url = sourceBlobUrl();
        if (!url) {
            alert("「下敷き・取り出し元」で画像を選ぶか、画像をドロップしてください。");
            return;
        }
        if (model.people.length && !confirm("今のポーズを、取り出したポーズに置き換えます。よろしいですか？（元に戻すこともできます）")) return;
        setBusy(true);
        try {
            const blob = await (await fetch(url)).blob();
            const json = await detect(blob);
            const next = fromJson(json);
            if (!next.people.length) {
                alert("人が見つかりませんでした。");
                return;
            }
            const v = sourceValue;
            edit(() => {
                model.width = next.width;
                model.height = next.height;
                model.people = next.people;
                model.source = v === "::file" ? "" : v;
            });
            selected = new Set();
            fit();
            draw();
            status(`${next.people.length} 人のポーズを取り出しました`);
        } catch (e) {
            console.error("[Polaris Studio] pose detect failed", e);
            alert(e.message);
        } finally {
            setBusy(false);
        }
    }

    function setBusy(on) {
        busy = on;
        q(".ps-pose-busy").classList.toggle("ps-off", !on);
        q(".ps-pose-detect").disabled = on;
    }

    // ---------- 変更と元に戻す ----------

    function snapshot() {
        return JSON.stringify({width: model.width, height: model.height, people: model.people, source: model.source});
    }

    function restore(s) {
        const v = JSON.parse(s);
        model.width = v.width;
        model.height = v.height;
        model.people = v.people;
        model.source = v.source;
        // 消えた点は選択から外す
        selected = new Set([...selected].filter((k) => pointOf(k)));
    }

    function pushUndo() {
        undoStack.push(snapshot());
        if (undoStack.length > UNDO_MAX) undoStack.shift();
        redoStack = [];
        changed = true;
    }

    function edit(fn) {
        pushUndo();
        fn();
        updateUi();
        draw();
    }

    function undo() {
        if (!undoStack.length) return;
        redoStack.push(snapshot());
        restore(undoStack.pop());
        changed = true;
        updateUi();
        draw();
    }

    function redo() {
        if (!redoStack.length) return;
        undoStack.push(snapshot());
        restore(redoStack.pop());
        changed = true;
        updateUi();
        draw();
    }

    function setVisible(v) {
        const keys = [...selected].filter((k) => pointOf(k) && pointOf(k).v !== v);
        if (!keys.length) return;
        edit(() => keys.forEach((k) => (pointOf(k).v = v)));
    }

    function selectedPeople() {
        return [...new Set([...selected].map((k) => parseKey(k).pi))].sort((a, b) => a - b);
    }

    function addParts() {
        const people = selectedPeople();
        if (!people.length) {
            alert("手や顔を足す人の点を選んでください。");
            return;
        }
        const missing = people.filter((pi) => ["left", "right", "face"].some((id) => !model.people[pi][id]));
        if (!missing.length) {
            status("選んだ人には、手も顔もそろっています");
            return;
        }
        edit(() => {
            for (const pi of missing) {
                const person = model.people[pi];
                if (!person.right) addHand(person, "right", model.height);
                if (!person.left) addHand(person, "left", model.height);
                if (!person.face) addFace(person, model.height);
            }
        });
    }

    function removePeople() {
        const people = selectedPeople();
        if (!people.length) {
            alert("消す人の点を選んでください。");
            return;
        }
        edit(() => {
            model.people = model.people.filter((_, i) => !people.includes(i));
            selected = new Set();
        });
    }

    // ---------- JSON の読み書き ----------

    function exportJson() {
        const blob = new Blob([JSON.stringify(toJson(model, true), null, 2)], {type: "application/json"});
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "pose.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    async function importJson(e) {
        const file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        try {
            let json = JSON.parse(await file.text());
            if (Array.isArray(json)) json = json[0];
            if (!json || !Array.isArray(json.people)) throw new Error("OpenPose の JSON ではありません");
            const next = fromJson(json);
            edit(() => {
                model.width = next.width;
                model.height = next.height;
                model.people = next.people;
                model.source = "";
            });
            selected = new Set();
            fit();
            draw();
            status(`${next.people.length} 人のポーズを読み込みました`);
        } catch (err) {
            alert("JSON を読み込めませんでした: " + err.message);
        }
    }

    // ---------- 決定・キャンセル ----------

    function readControl() {
        const num = (sel, lo, hi, fallback) => {
            const v = Number(q(sel).value);
            return q(sel).value.trim() !== "" && Number.isFinite(v) ? Math.round(clamp(v, lo, hi) * 1000) / 1000 : fallback;
        };
        const modelName = q(".ps-pose-model").value;
        const start = num(".ps-pose-start", 0, 1, 0);
        return {
            use: q(".ps-pose-use").checked,
            unit: Number(q(".ps-pose-unit").value) || 0,
            model: modelName === "::error" ? "" : modelName,
            weight: num(".ps-pose-weight", 0, 2, 1),
            start,
            end: Math.max(num(".ps-pose-end", 0, 1, 1), start),
            mode: q(".ps-pose-mode").value,
        };
    }

    function apply() {
        const done = opts.onApply;
        const pose = model.people.length ? toJson(model, false) : null;
        const c = readControl();
        close();
        done(pose, c);
    }

    function cancel() {
        if (changed && !confirm("ポーズの変更を捨てて戻りますか？")) return;
        const done = opts.onCancel;
        close();
        if (done) done();
    }

    // ---------- 表示 ----------

    const canvasEl = () => q(".ps-pose-canvas");

    function fit() {
        const stage = q(".ps-pose-stage").getBoundingClientRect();
        const w = Math.max(stage.width, 50);
        const h = Math.max(stage.height, 50);
        const zoom = clamp(Math.min((w - 40) / model.width, (h - 40) / model.height), 0.05, 40);
        view = {zoom, x: (w - model.width * zoom) / 2, y: (h - model.height * zoom) / 2};
        viewAuto = true;
    }

    const toScreen = (p) => ({x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y});
    const toCanvas = (sx, sy) => ({x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom});

    // 表示している点の一覧（手・顔を隠しているときは、その点はつかめない）
    function eachPoint(fn) {
        model.people.forEach((person, pi) => {
            for (const part of PARTS) {
                const pts = person[part.id];
                if (!pts) continue;
                if ((part.id === "left" || part.id === "right") && !show.hands) continue;
                if (part.id === "face" && !show.face) continue;
                pts.forEach((p, i) => fn(p, pi, part.id, i));
            }
        });
    }

    function draw() {
        if (!root || !model || !isOpen()) return;
        const canvas = canvasEl();
        const stage = q(".ps-pose-stage").getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(stage.width));
        const h = Math.max(1, Math.round(stage.height));
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            canvas.style.width = w + "px";
            canvas.style.height = h + "px";
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // ポーズの絵（キャンバスの座標で描く）
        ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, model.width, model.height);
        if (underlay && show.underlay > 0) {
            ctx.globalAlpha = show.underlay;
            ctx.drawImage(underlay.img, 0, 0, model.width, model.height);
            ctx.globalAlpha = 1;
        }
        drawPose(ctx, model, show);
        // つかむ印（画面の座標で描く）
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.strokeRect(view.x, view.y, model.width * view.zoom, model.height * view.zoom);
        eachPoint((p, pi, part, i) => {
            const s = toScreen(p);
            const sel = selected.has(keyOf(pi, part, i));
            if (!p.v) {
                ctx.setLineDash([2, 2]);
                ctx.strokeStyle = sel ? "#fff" : "rgba(200,200,200,0.6)";
                ctx.beginPath();
                ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
                return;
            }
            if (!sel) return;
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(s.x, s.y, part === "face" ? 5 : 7, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;
        });
        if (drag && drag.type === "box") {
            const x = Math.min(drag.sx, drag.cx);
            const y = Math.min(drag.sy, drag.cy);
            ctx.fillStyle = "rgba(120,170,255,0.15)";
            ctx.strokeStyle = "rgba(120,170,255,0.9)";
            ctx.fillRect(x, y, Math.abs(drag.cx - drag.sx), Math.abs(drag.cy - drag.sy));
            ctx.strokeRect(x, y, Math.abs(drag.cx - drag.sx), Math.abs(drag.cy - drag.sy));
        }
        if (!model.people.length) {
            ctx.fillStyle = "rgba(255,255,255,0.75)";
            ctx.font = "14px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("「画像から取り出す」か「＋ 人」で始めます", w / 2, h / 2);
            ctx.textAlign = "start";
        }
    }

    let statusTimer = null;
    function status(text) {
        const box = q(".ps-pose-status");
        box.textContent = text;
        box.classList.remove("ps-off");
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => box.classList.add("ps-off"), 2500);
    }

    function pointName(part, i) {
        if (part === "body") return BODY_NAMES[i];
        if (part === "face") return `顔 ${i + 1}`;
        const side = PART[part].label;
        if (i === 0) return side + "・手首";
        return `${side}・${FINGER_NAMES[Math.floor((i - 1) / 4)]} ${((i - 1) % 4) + 1}`;
    }

    function updateUi() {
        const sel = q(".ps-pose-sel");
        if (!selected.size) {
            sel.textContent = model.people.length ? `${model.people.length} 人・点を選んでいません` : "人がいません";
        } else if (selected.size === 1) {
            const {pi, part, i} = parseKey([...selected][0]);
            const p = pointOf([...selected][0]);
            sel.textContent = `${pi + 1} 人目・${pointName(part, i)}${p && !p.v ? "（隠しています）" : ""}`;
        } else {
            const people = selectedPeople();
            const hidden = [...selected].filter((k) => pointOf(k) && !pointOf(k).v).length;
            sel.textContent = `${selected.size} 点（${people.map((x) => x + 1).join("・")} 人目）${hidden ? `・うち ${hidden} 点は隠しています` : ""}`;
        }
        q(".ps-pose-undo").disabled = !undoStack.length;
        q(".ps-pose-redo").disabled = !redoStack.length;
        q(".ps-pose-hide").disabled = !selected.size;
        q(".ps-pose-unhide").disabled = !selected.size;
        q(".ps-pose-export").disabled = !model.people.length;
    }

    // ---------- マウス ----------

    function localPos(e) {
        const r = canvasEl().getBoundingClientRect();
        return {x: e.clientX - r.left, y: e.clientY - r.top};
    }

    // いちばん近い点。選んでいる点を少しだけ優先する
    function hitTest(sx, sy) {
        let best = null;
        let bestD = HIT;
        eachPoint((p, pi, part, i) => {
            const s = toScreen(p);
            const k = keyOf(pi, part, i);
            const d = Math.hypot(s.x - sx, s.y - sy) - (selected.has(k) ? 2 : 0);
            if (d < bestD) {
                bestD = d;
                best = k;
            }
        });
        return best;
    }

    function pointerDown(e) {
        root.focus();
        const {x, y} = localPos(e);
        canvasEl().setPointerCapture(e.pointerId);
        if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
            drag = {type: "pan", sx: x, sy: y, vx: view.x, vy: view.y};
            viewAuto = false;
            return;
        }
        if (e.button !== 0) return;
        const hit = hitTest(x, y);
        if (hit) {
            if (e.shiftKey || e.ctrlKey || e.metaKey) {
                if (selected.has(hit)) selected.delete(hit);
                else selected.add(hit);
                drag = null;
                updateUi();
                draw();
                return;
            }
            if (!selected.has(hit)) selected = new Set([hit]);
            drag = {type: "move", sx: x, sy: y, moved: false, start: [...selected].map((k) => [k, {...pointOf(k)}])};
        } else {
            drag = {type: "box", sx: x, sy: y, cx: x, cy: y, add: e.shiftKey || e.ctrlKey || e.metaKey};
        }
        updateUi();
        draw();
    }

    function pointerMove(e) {
        const {x, y} = localPos(e);
        if (!drag) {
            canvasEl().style.cursor = spaceDown ? "grab" : hitTest(x, y) ? "pointer" : "crosshair";
            return;
        }
        if (drag.type === "pan") {
            view.x = drag.vx + (x - drag.sx);
            view.y = drag.vy + (y - drag.sy);
        } else if (drag.type === "move") {
            const dx = (x - drag.sx) / view.zoom;
            const dy = (y - drag.sy) / view.zoom;
            if (!drag.moved) {
                if (Math.hypot(x - drag.sx, y - drag.sy) < 2) return;
                pushUndo();
                drag.moved = true;
            }
            for (const [k, p0] of drag.start) {
                const p = pointOf(k);
                if (!p) continue;
                p.x = p0.x + dx;
                p.y = p0.y + dy;
            }
        } else if (drag.type === "box") {
            drag.cx = x;
            drag.cy = y;
        }
        draw();
    }

    function pointerUp(e) {
        if (!drag) return;
        if (drag.type === "box") {
            const x0 = Math.min(drag.sx, drag.cx);
            const x1 = Math.max(drag.sx, drag.cx);
            const y0 = Math.min(drag.sy, drag.cy);
            const y1 = Math.max(drag.sy, drag.cy);
            const next = drag.add ? new Set(selected) : new Set();
            if (x1 - x0 > 2 || y1 - y0 > 2) {
                eachPoint((p, pi, part, i) => {
                    const s = toScreen(p);
                    if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) next.add(keyOf(pi, part, i));
                });
            }
            selected = next;
        }
        drag = null;
        try {
            canvasEl().releasePointerCapture(e.pointerId);
        } catch (err) { /* 離していれば何もしない */ }
        updateUi();
        draw();
    }

    function selectPart(pi, part) {
        const pts = model.people[pi] && model.people[pi][part];
        if (!pts) return;
        selected = new Set(pts.map((_, i) => keyOf(pi, part, i)));
        updateUi();
        draw();
    }

    function doubleClick(e) {
        const {x, y} = localPos(e);
        const hit = hitTest(x, y);
        if (!hit) return;
        const {pi, part} = parseKey(hit);
        selectPart(pi, part);
    }

    function wheel(e) {
        e.preventDefault();
        const {x, y} = localPos(e);
        const before = toCanvas(x, y);
        const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        view.zoom = clamp(view.zoom * k, 0.05, 40);
        viewAuto = false;
        view.x = x - before.x * view.zoom;
        view.y = y - before.y * view.zoom;
        draw();
    }

    // ---------- キー ----------

    function keyDown(e) {
        // 入力欄の中では、そのまま入力させる（Esc だけは受け取る）
        const typing = e.target.matches("input[type=number], input[type=text], select");
        const ctrl = e.ctrlKey || e.metaKey;
        let handled = true;
        if (e.key === "Escape") {
            if (selected.size) {
                selected = new Set();
                updateUi();
                draw();
            } else {
                cancel();
            }
        } else if (typing) {
            handled = false;
        } else if (e.code === "Space") {
            spaceDown = true;
        } else if (ctrl && e.key.toLowerCase() === "z") {
            if (e.shiftKey) redo();
            else undo();
        } else if (ctrl && e.key.toLowerCase() === "y") {
            redo();
        } else if (ctrl && e.key.toLowerCase() === "a") {
            const next = new Set();
            eachPoint((p, pi, part, i) => next.add(keyOf(pi, part, i)));
            selected = next;
            updateUi();
            draw();
        } else if (e.key === "Delete" || e.key === "Backspace") {
            setVisible(e.shiftKey);
        } else if (e.key.toLowerCase() === "f" && !ctrl) {
            fit();
            draw();
        } else if (e.key.startsWith("Arrow") && selected.size) {
            const step = e.shiftKey ? 10 : 1;
            const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
            const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
            // 押し続けたときは、まとめて 1 回で戻せるようにする
            if (!e.repeat) pushUndo();
            for (const k of selected) {
                const p = pointOf(k);
                if (!p) continue;
                p.x += dx;
                p.y += dy;
            }
            changed = true;
            updateUi();
            draw();
        } else {
            handled = false;
        }
        if (handled) e.preventDefault();
        // 編集画面や WebUI のショートカットには伝えない
        e.stopPropagation();
    }

    window.PolarisPose = {open, close, isOpen, renderDataUrl, jobPayload, DEFAULT_CONTROL};
})();
