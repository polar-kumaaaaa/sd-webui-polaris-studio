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
    // 画像から取り出したときの体と手を、人ごとにこの名前で一緒に保存する（顔は使わない）
    const DETECTED_KEY = "polaris_detected";
    // 深度から消す範囲を手で塗った線。mode は "erase"（消す）か "keep"（消さない）。座標は比率、太さは短い辺に対する比
    const PAINT_KEY = "polaris_paint";
    const ORIG_PARTS = PARTS.filter((x) => x.id !== "face");
    const BODY_NAMES = ["鼻", "首", "右肩", "右ひじ", "右手首", "左肩", "左ひじ", "左手首", "右腰", "右ひざ", "右足首", "左腰", "左ひざ", "左足首", "右目", "左目", "右耳", "左耳"];
    const FINGER_NAMES = ["親指", "人差し指", "中指", "薬指", "小指"];

    // ControlNet（annotator/openpose/util.py）と同じ線の組み合わせと色
    const LIMBS = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18]];
    const COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255],
        [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]];
    const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]];

    const MODES = [["BALANCED", "バランス"], ["PROMPT", "プロンプトを重視"], ["CONTROL", "ControlNet を重視"]];
    // depth は、ポーズと一緒に取り出し元の画像の深度を別のユニットに入れる設定（並びは Python 側で保存するときと同じにする）
    // grow は、動かした手足の元の位置を自動で消す太さの倍率
    const DEFAULT_DEPTH = {use: false, unit: 1, module: "", model: "", weight: 0.5, start: 0, end: 1, grow: 1};
    const DEFAULT_CONTROL = {use: false, unit: 0, model: "", weight: 1, start: 0, end: 1, mode: "BALANCED", depth: DEFAULT_DEPTH};
    const withDefaults = (c) => ({...DEFAULT_CONTROL, ...(c || {}), depth: {...DEFAULT_DEPTH, ...((c && c.depth) || {})}});
    // 体の点をダブルクリックしたときに、そこから体の外に向けてまとめて選ぶ点（hand はその側の手、face は顔も選ぶ）
    const CHAINS = {
        0: {body: [0, 14, 15, 16, 17], face: true},           // 鼻：目・耳と顔
        1: {body: "all", face: true},                          // 首：体全体と顔（手は別）
        2: {body: [2, 3, 4], hand: "right"},                   // 右肩：右腕と右手
        3: {body: [3, 4], hand: "right"},
        4: {body: [4], hand: "right"},
        5: {body: [5, 6, 7], hand: "left"},
        6: {body: [6, 7], hand: "left"},
        7: {body: [7], hand: "left"},
        8: {body: [8, 9, 10]}, 9: {body: [9, 10]}, 10: {body: [10]},
        11: {body: [11, 12, 13]}, 12: {body: [12, 13]}, 13: {body: [13]},
        14: {body: [14, 16]}, 15: {body: [15, 17]}, 16: {body: [16]}, 17: {body: [17]},
    };
    const HAND_WRIST = {right: 4, left: 7};  // 手と同じ側の体の手首
    const KNOB = 7;                 // 手を回すつまみの半径（画面の px）
    const KNOB_DIST = 40;           // 手首からつまみまでの距離（画面の px）
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
        // 座標が比率（0〜1）か px かを見分ける。取り出した点は画像の外（1 を少し超える）に出ることがあるので、
        // 2 を超える値があるときだけ px とみなす（ポラスタは比率で保存し、Python も -1〜2 に収める）
        let normalized = true;
        for (const person of people) for (const part of PARTS) {
            const a = person[part.key];
            if (Array.isArray(a)) for (let i = 0; i < a.length; i += 3) if (a[i + 2] >= 1 && (Math.abs(a[i]) > 2 || Math.abs(a[i + 1]) > 2)) normalized = false;
        }
        const sx = normalized ? w : 1;
        const sy = normalized ? h : 1;
        const readPart = (person, part) => {
            const a = person[part.key];
            if (!Array.isArray(a) || a.length !== part.count * 3) return null;
            const pts = [];
            for (let i = 0; i < part.count; i++) {
                const x = Number(a[i * 3]) || 0;
                const y = Number(a[i * 3 + 1]) || 0;
                const v = Number(a[i * 3 + 2]) >= 1;
                // 見つからなかった点は (0, 0) で来るので、置き場所が決まっていない印を付けて、あとで仮の場所に置く
                pts.push({x: x * sx, y: y * sy, v, unplaced: !v && x === 0 && y === 0});
            }
            return part.id !== "body" && !pts.some((p) => p.v) ? null : pts;
        };
        const list = [];
        for (const person of people) {
            const out = {};
            for (const part of PARTS) out[part.id] = readPart(person, part);
            if (!out.body) continue;
            // 画像から取り出したときの体と手（深度から、動かした手足の元の位置を消すのに使う）
            const det = person[DETECTED_KEY];
            if (det && typeof det === "object") {
                const orig = {};
                for (const part of ORIG_PARTS) orig[part.id] = readPart(det, part);
                if (orig.body) out.orig = orig;
            }
            list.push(out);
        }
        for (const person of list) placeHidden(person, w, h);
        // 深度から消す範囲を手で塗った線（比率で保存している。px の JSON には入っていない）
        const short = Math.min(w, h);
        const paint = normalized && Array.isArray(json && json[PAINT_KEY]) ? json[PAINT_KEY].filter((s) => s && Array.isArray(s.pts)).map((s) => ({
            mode: s.mode === "keep" ? "keep" : "erase",
            w: Math.max(1, (Number(s.w) || 0) * short),
            pts: s.pts.filter((p) => Array.isArray(p) && p.length === 2).map(([x, y]) => ({x: Number(x) * w, y: Number(y) * h})),
        })).filter((s) => s.pts.length) : [];
        return {width: w, height: h, people: list, source: (json && json.source) || "", paint};
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
                const flat = (pts) => (pts ? pts.flatMap((p) => [r(p.x * sx), r(p.y * sy), p.v ? 1 : 0]) : null);
                for (const part of PARTS) out[part.key] = flat(person[part.id]);
                // 取り出したときの点は、ポラスタの中だけで使う（JSON の書き出しには入れない）
                if (!pixel && person.orig) {
                    out[DETECTED_KEY] = {};
                    for (const part of ORIG_PARTS) out[DETECTED_KEY][part.key] = flat(person.orig[part.id]);
                }
                return out;
            }),
            ...(pixel ? {} : {source: model.source || ""}),
            ...(!pixel && model.paint && model.paint.length ? {[PAINT_KEY]: model.paint.map((s) => ({
                mode: s.mode,
                w: r(s.w / Math.min(model.width, model.height)),
                pts: s.pts.map((p) => [r(p.x * sx), r(p.y * sy)]),
            }))} : {}),
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

    let depthModuleCache = [];
    async function controlnetModels(reload) {
        if (modelCache && !reload) return modelCache;
        // ControlNet の /controlnet/* の API は Neo では --api のときしか出ないので、ポラスタの API から読む
        const res = await fetch("polaris-studio/pose/models", {cache: "no-store"});
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error("ControlNet のモデルの一覧が読めません（" + (data.error || res.status) + "）");
        modelCache = data.models || [];
        depthModuleCache = data.depthModules || [];
        return modelCache;
    }

    // pattern に合うモデルを先に並べる
    const modelsFirst = (list, pattern) => [...list.filter((x) => pattern.test(x)), ...list.filter((x) => !pattern.test(x))];

    async function resolveModel(name, pattern = /openpose/i, label = "openpose") {
        if (name) return name;
        const found = (await controlnetModels()).find((x) => pattern.test(x));
        if (!found) throw new Error(`名前に ${label} を含む ControlNet のモデルが見つかりません。ポーズの画面でモデルを選んでください`);
        return found;
    }

    // ---------- 深度から消す場所 ----------
    // ポーズで動かした手足は、取り出し元の画像の元の位置が深度に残ると、元の手足も描かれてしまう。
    // 取り出したときの点と今の点を比べて、動いた手足の元の位置（線と円）を返す。座標は 0〜1、太さは画像の短い辺に対する比
    const ERASE_LIMBS = [
        {chain: [2, 3, 4], hand: "right"},  // 右腕（画面の左）
        {chain: [5, 6, 7], hand: "left"},
        {chain: [8, 9, 10]},                 // 右脚
        {chain: [11, 12, 13]},
    ];

    // grow は自動で消す範囲の太さの倍率。手で塗った線（keep は「消さない」）も最後に足す
    function eraseAreas(poseJson, grow = 1) {
        const m = fromJson(poseJson);
        const W = m.width;
        const H = m.height;
        const short = Math.min(W, H);
        const moveLimit = Math.max(6, short * 0.02);   // これより動いた点を「動かした」とみなす
        const out = [];
        const g = clamp(Number(grow) || 1, 0.5, 3);
        const add = (a, b, width) => out.push({a: [a.x / W, a.y / H], b: [b.x / W, b.y / H], w: width * g / short});
        const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        for (const person of m.people) {
            const orig = person.orig;
            if (!orig || !orig.body) continue;
            const ob = orig.body;
            const seen = (p) => p && p.v;
            // 動いたか：元で見えていた点が、今は見えない・大きく動いた
            const moved = (o, c) => seen(o) && (!c || !c.v || dist(o, c) > moveLimit);
            // 手足の太さは肩幅から決める（なければ画像の大きさから）
            const shoulders = seen(ob[2]) && seen(ob[5]) ? dist(ob[2], ob[5]) : 0;
            // 袖や服の厚みも消えるよう、腕の太さより広めにとる
            const limbWidth = Math.max(12, shoulders ? shoulders * 0.6 : short * 0.08);
            for (const limb of ERASE_LIMBS) {
                const ch = limb.chain;
                const mv = ch.map((i) => moved(ob[i], person.body[i]));
                for (let k = 0; k < ch.length - 1; k++) {
                    const a = ob[ch[k]];
                    const b = ob[ch[k + 1]];
                    if ((mv[k] || mv[k + 1]) && seen(a) && seen(b)) add(a, b, limbWidth * (limb.hand ? 1 : 1.3));
                }
                if (!limb.hand) continue;
                const oh = orig[limb.hand];
                const ch2 = person[limb.hand];
                const wrist = ob[ch[2]];
                const wristMoved = mv[2];
                if (oh && oh.some(seen)) {
                    const handMoved = wristMoved || !ch2 || oh.some((p, i) => moved(p, ch2[i]));
                    if (!handMoved) continue;
                    // 手の大きさ（手首から中指の先まで）に合わせた太さで、指の線をなぞる
                    const tip = [12, 11, 10, 9].map((i) => oh[i]).find(seen);
                    const size = seen(oh[0]) && tip ? dist(oh[0], tip) : limbWidth * 1.5;
                    const w = Math.max(10, size * 0.6);
                    for (const [i, j] of HAND_EDGES) if (seen(oh[i]) && seen(oh[j])) add(oh[i], oh[j], w);
                } else if (wristMoved && seen(wrist)) {
                    // 手が取り出せていなくても、手首を動かしたら手のあたりを消す
                    add(wrist, wrist, limbWidth * 2.2);
                }
            }
        }
        // 手で塗った線（倍率はかけない）。点のあいだを線でつなぐ
        for (const s of m.paint || []) {
            const keep = s.mode === "keep";
            const push = (a, b) => out.push({a: [a.x / W, a.y / H], b: [b.x / W, b.y / H], w: s.w / short, ...(keep ? {keep: true} : {})});
            if (s.pts.length === 1) push(s.pts[0], s.pts[0]);
            for (let i = 1; i < s.pts.length; i++) push(s.pts[i - 1], s.pts[i]);
        }
        return out;
    }

    // 生成に渡す形 {image, unit, model, weight, start, end, mode, depth}。depth は取り出し元の画像の名前と、深度のユニットの設定
    async function jobPayload(job) {
        const control = withDefaults(job.control);
        const out = {
            image: renderDataUrl(job.pose),
            unit: control.unit,
            model: await resolveModel(control.model),
            weight: control.weight,
            start: control.start,
            end: control.end,
            mode: control.mode,
        };
        const d = control.depth;
        if (d.use) {
            out.depth = {...d, model: await resolveModel(d.model, /depth/i, "depth"), name: (job.pose && job.pose.source) || "",
                erase: job.pose ? eraseAreas(job.pose, d.grow) : []};
        }
        return out;
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
    let show = {hands: true, face: true, underlay: 0.5, brush: 60};
    let brush = false;              // 深度から消す範囲を塗るモード
    let hover = null;               // 塗るモードで、筆の大きさを見せる位置（画面の座標）
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
                        <label class="ps-pose-range" title="選んだ点（2 点以上）を、並びの比率を保ったまま、まとめて大きく・小さくします。中心は選んだ点の範囲の真ん中です。Alt+ホイールでも変えられます">大きさ<input type="range" class="ps-pose-scale" min="25" max="200" step="1" value="100"><span class="ps-pose-scale-value">100%</span></label>
                        <div class="ps-pose-row">
                            <button type="button" class="mtm-btn ps-pose-scale-down" title="選んだ点を 5% 小さくします (Alt+ホイール下)">−5%</button>
                            <button type="button" class="mtm-btn ps-pose-scale-up" title="選んだ点を 5% 大きくします (Alt+ホイール上)">＋5%</button>
                        </div>
                    </section>
                    <section>
                        <div class="ps-pose-head">手</div>
                        <div class="ps-pose-note">手の点か体の手首を選ぶと、その手を手首を中心に動かせます。手首のそばの白い丸をドラッグすると回ります（Shift で 15° ずつ）</div>
                        <div class="ps-pose-row">
                            <button type="button" class="mtm-btn ps-pose-flip" title="手のひらの表と裏を入れ替えます。手首と中指の付け根を結ぶ線で裏返すので、親指が反対側に移ります (H)">反転</button>
                            <button type="button" class="mtm-btn ps-pose-rotl" title="手首を中心に左へ 15° 回します (Q、Shift+Q で 1°)">⟲ 15°</button>
                            <button type="button" class="mtm-btn ps-pose-rotr" title="手首を中心に右へ 15° 回します (E、Shift+E で 1°)">⟳ 15°</button>
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
                        <label class="ps-pose-field" title="ポーズにどれだけ従わせるか（0〜2）。初期値 1。ポーズどおりにならないときは 1.1〜1.3 に上げます。上げすぎると絵が硬くなります">重み<input type="number" class="ps-pose-weight" min="0" max="2" step="0.05"></label>
                        <label class="ps-pose-field" title="生成のどの段階からポーズを効かせるか（0〜1。0 が最初）。初期値 0。体の向きや手足の位置は最初のほうで決まるので、ふつうは 0 のままにします">開始<input type="number" class="ps-pose-start" min="0" max="1" step="0.05"></label>
                        <label class="ps-pose-field" title="生成のどの段階までポーズを効かせるか（0〜1。1 が最後）。初期値 1。0.6〜0.8 に下げると、ポーズは保ったまま細部を自由に描かせられます">終了<input type="number" class="ps-pose-end" min="0" max="1" step="0.05"></label>
                        <label class="ps-pose-field" title="プロンプトと ControlNet のどちらを優先するか。初期値「バランス」。ポーズに従わないときは「ControlNet を重視」にします">重視<select class="ps-pose-mode">${MODES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>
                        <div class="ps-pose-note">使うときは、そのユニットを WebUI の設定に関係なくオンにし、プリプロセッサなしでこのポーズの絵を入れます。WebUI の ControlNet の画面は変えません。</div>
                        <details class="ps-pose-tips">
                            <summary>重み・開始・終了・重視とは</summary>
                            <dl>
                                <dt>重み（初期値 1）</dt>
                                <dd>ポーズにどれだけ従わせるか。0 で効かず、大きいほど強く従います。ポーズどおりにならないときは 1.1〜1.3。上げすぎると絵が硬くなったり崩れたりします。</dd>
                                <dt>開始・終了（初期値 0 と 1）</dt>
                                <dd>生成の何割目から何割目までポーズを効かせるか（0 が最初、1 が最後）。体の向きや手足の位置は最初の 3 割ほどで決まり、後半で細部を描きます。ポーズは開始 0 のまま、細部まで縛られて硬いときは終了を 0.6〜0.8 に下げます。</dd>
                                <dt>重視（初期値 バランス）</dt>
                                <dd>プロンプトと ControlNet のどちらを優先するか。ポーズに従わないときは「ControlNet を重視」、プロンプトの内容が出ないときは「プロンプトを重視」。</dd>
                            </dl>
                        </details>
                    </section>
                    <section>
                        <div class="ps-pose-head">深度（depth）</div>
                        <label class="ps-pose-check"><input type="checkbox" class="ps-pose-depth-use">取り出し元の画像の深度も入れる</label>
                        <div class="ps-pose-note ps-pose-depth-source"></div>
                        <div class="ps-pose-note ps-pose-warn ps-pose-depth-warn ps-off">名前に depth を含む ControlNet のモデルがありません。深度のモデル（SDXL 用）を ControlNet のモデルのフォルダに入れて、↻ で読み直してください。</div>
                        <label class="ps-pose-field">ユニット<select class="ps-pose-depth-unit"></select></label>
                        <label class="ps-pose-field" title="画像から深度の絵を作る方法。初期値は自動（depth_anything_v2）。モデルの名前に midas とあれば depth_midas に合わせると素直に効きます">プリプロセッサ<select class="ps-pose-depth-module"></select></label>
                        <label class="ps-pose-field">モデル<select class="ps-pose-depth-model"></select></label>
                        <label class="ps-pose-field" title="元の画像の形にどれだけ寄せるか（0〜2）。初期値 0.5。服や髪をもっと寄せたいときは 0.6〜0.8、元の画像に寄りすぎるときは 0.3 前後">重み<input type="number" class="ps-pose-depth-weight" min="0" max="2" step="0.05"></label>
                        <label class="ps-pose-field" title="生成のどの段階から深度を効かせるか（0〜1）。初期値 0。腕などを大きく動かして元の形が混ざるときは 0.3〜0.5 に上げます">開始<input type="number" class="ps-pose-depth-start" min="0" max="1" step="0.05"></label>
                        <label class="ps-pose-field" title="生成のどの段階まで深度を効かせるか（0〜1）。初期値 1。元の画像に寄りすぎるときは 0.6〜0.8 に下げます">終了<input type="number" class="ps-pose-depth-end" min="0" max="1" step="0.05"></label>
                        <div class="ps-pose-subhead">深度から消す範囲（薄い赤）</div>
                        <label class="ps-pose-range" title="動かした腕・手・脚の元の位置を自動で消す太さの倍率。初期値 1。袖や服が元の形のまま残るときは上げます">自動の太さ<input type="range" class="ps-pose-depth-grow" min="0.5" max="2.5" step="0.1"><span class="ps-pose-depth-grow-value"></span></label>
                        <div class="ps-pose-row">
                            <button type="button" class="mtm-btn ps-pose-brush" title="ドラッグで消す範囲を塗り足します。Shift を押しながらドラッグすると、消さない範囲を塗ります（自動の範囲も減らせます） (B)">🖌 塗る</button>
                            <button type="button" class="mtm-btn ps-pose-brush-clear" title="手で塗った範囲を全部消します（自動の範囲はそのまま）">塗りを消す</button>
                        </div>
                        <label class="ps-pose-range">筆の太さ<input type="range" class="ps-pose-brush-size" min="10" max="300" step="5"><span class="ps-pose-brush-size-value"></span></label>
                        <details class="ps-pose-tips">
                            <summary>深度の重み・開始・終了の目安</summary>
                            <dl>
                                <dt>重み（初期値 0.5）</dt>
                                <dd>元の画像の形（服・髪・体の厚み・手の形）にどれだけ寄せるか。もっと寄せたいときは 0.6〜0.8、寄りすぎるときは 0.3 前後。ポーズより強くすると、ポーズで動かした手足が元の形に引っ張られます。</dd>
                                <dt>開始（初期値 0）</dt>
                                <dd>手足を大きく動かして、元の形が混ざるときは 0.3〜0.5 に上げます。最初のほう（構図を決める段階）はポーズだけで決め、深度は後半の服のしわや形の仕上げに効きます。</dd>
                                <dt>終了（初期値 1）</dt>
                                <dd>元の画像に寄りすぎる、細部まで同じになるときは 0.6〜0.8 に下げます。</dd>
                                <dt>はじめに試す組み合わせ</dt>
                                <dd>ほぼ同じ姿勢で描き直す：重み 0.5・開始 0・終了 1。腕などを動かした：重み 0.4〜0.5・開始 0〜0.3・終了 1（動かした手足の元の位置は自動で消します）。</dd>
                                <dt>消す範囲</dt>
                                <dd>薄い赤の範囲は、元の画像を背景の色で塗ってから深度を作ります。袖や服の一部が残って、元の形のまま描かれるときは「自動の太さ」を上げるか、「🖌 塗る」（B）で塗り足します。Shift を押しながら塗ると、その部分は消さずに残します。</dd>
                            </dl>
                        </details>
                        <div class="ps-pose-note">ポーズを取り出した画像の奥行きを、もう 1 つのユニットに入れます。手の形や体の厚み、服や髪の形も元の画像に近づきます。ポーズのユニットと別の番号にしてください。深度の絵は生成のたびに ControlNet が作ります（重視はポーズと同じ）。</div>
                        <div class="ps-pose-note">取り出したあとに動かした腕・手・脚は、元の位置を背景の色で塗ってから深度を作ります（元の手足が残らないように）。塗る場所は、ポーズの絵の上に薄い赤で出します。この版より前に取り出したポーズでは塗りません（取り出し直すと塗ります）。</div>
                    </section>
                    <section class="ps-pose-help">
                        <div class="ps-pose-head">操作</div>
                        <div>点をドラッグ：動かす（選んだ点はまとめて）</div>
                        <div>何もない所をドラッグ：囲んで選ぶ</div>
                        <div>Shift+クリック：選ぶ点を足す・外す</div>
                        <div>点をダブルクリック：そこから先をまとめて選ぶ（肩なら腕と手、鼻なら目・耳・顔、首なら手のほかの全部。手首なら手全体、顔の点なら顔全体）</div>
                        <div>H：手の反転／Q・E：手を回す</div>
                        <div>ホイール：拡大・縮小</div>
                        <div>Alt+ホイール：選んだ点をまとめて大きく・小さく（比率はそのまま）</div>
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
        canvas.addEventListener("pointerleave", () => {
            if (!hover) return;
            hover = null;
            draw();
        });
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
            // Alt+ホイールのあとに Alt を離しても、ブラウザのメニューに移らないようにする
            if (e.key === "Alt") e.preventDefault();
            if (e.key === "Shift" && brush && hover && !drag) {
                hover.keep = false;
                draw();
            }
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
        q(".ps-pose-flip").addEventListener("click", flipHands);
        q(".ps-pose-rotl").addEventListener("click", () => rotateHands(-15));
        q(".ps-pose-rotr").addEventListener("click", () => rotateHands(15));
        q(".ps-pose-hide").addEventListener("click", () => setVisible(false));
        q(".ps-pose-scale").addEventListener("input", () => scaleSlider(false));
        q(".ps-pose-scale").addEventListener("change", () => scaleSlider(true));
        q(".ps-pose-scale-down").addEventListener("click", () => scaleSelection(0.95));
        q(".ps-pose-scale-up").addEventListener("click", () => scaleSelection(1 / 0.95));
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
        for (const sel of [".ps-pose-use", ".ps-pose-unit", ".ps-pose-model", ".ps-pose-weight", ".ps-pose-start", ".ps-pose-end", ".ps-pose-mode",
            ".ps-pose-depth-use", ".ps-pose-depth-unit", ".ps-pose-depth-module", ".ps-pose-depth-model", ".ps-pose-depth-weight", ".ps-pose-depth-start", ".ps-pose-depth-end"]) {
            q(sel).addEventListener("change", () => {
                changed = true;
            });
        }
        // 深度を使うかで、消す場所の表示が変わる
        q(".ps-pose-depth-use").addEventListener("change", () => {
            if (!q(".ps-pose-depth-use").checked) setBrush(false);
            draw();
        });
        q(".ps-pose-depth-grow").addEventListener("input", () => {
            changed = true;
            q(".ps-pose-depth-grow-value").textContent = `× ${Number(q(".ps-pose-depth-grow").value).toFixed(1)}`;
            draw();
        });
        q(".ps-pose-brush").addEventListener("click", () => setBrush(!brush));
        q(".ps-pose-brush-clear").addEventListener("click", () => {
            if (!model.paint.length) return;
            edit(() => (model.paint = []));
        });
        q(".ps-pose-brush-size").addEventListener("input", () => {
            show.brush = Number(q(".ps-pose-brush-size").value);
            q(".ps-pose-brush-size-value").textContent = `${show.brush}px`;
            saveView();
            draw();
        });
        for (const sel of [".ps-pose-unit", ".ps-pose-depth-unit"]) {
            for (let i = 0; i < 8; i++) q(sel).appendChild(new Option(`${i + 1} 番目`, String(i)));
        }
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

    // 深度から消す範囲を塗るモード。深度を使っていて、取り出し元の画像があるときだけ入れる
    function setBrush(on) {
        if (on && !(q(".ps-pose-depth-use").checked && model.source)) {
            status("深度を使い、カット案の画像からポーズを取り出したときに塗れます");
            on = false;
        }
        brush = on;
        hover = null;
        q(".ps-pose-brush").classList.toggle("mtm-active", brush);
        canvasEl().style.cursor = brush ? "none" : "crosshair";
        if (brush) status("ドラッグで消す範囲を塗ります。Shift を押しながらで、消さない範囲を塗ります（B か Esc で終わる）");
        draw();
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
            : {width: size.width || 512, height: size.height || 768, people: [], source: "", paint: []};
        control = withDefaults(options.control);
        brush = false;
        hover = null;
        q(".ps-pose-brush").classList.remove("mtm-active");
        q(".ps-pose-depth-grow").value = control.depth.grow;
        q(".ps-pose-depth-grow-value").textContent = `× ${Number(control.depth.grow).toFixed(1)}`;
        q(".ps-pose-brush-size").value = show.brush;
        q(".ps-pose-brush-size-value").textContent = `${show.brush}px`;
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
        q(".ps-pose-depth-use").checked = control.depth.use;
        q(".ps-pose-depth-unit").value = String(control.depth.unit);
        q(".ps-pose-depth-weight").value = control.depth.weight;
        q(".ps-pose-depth-start").value = control.depth.start;
        q(".ps-pose-depth-end").value = control.depth.end;
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
        let list = [];
        let error = "";
        try {
            list = await controlnetModels(reload);
        } catch (e) {
            error = e.message;
        }
        const fill = (sel, current, auto, names) => {
            sel.textContent = "";
            sel.appendChild(new Option(auto, ""));
            if (error) sel.appendChild(new Option("（一覧が読めません: " + error + "）", "::error"));
            for (const name of names) sel.appendChild(new Option(name, name));
            if (current && ![...sel.options].some((o) => o.value === current)) sel.appendChild(new Option(current + "（見つかりません）", current));
            sel.value = current;
        };
        fill(q(".ps-pose-model"), control.model, "自動（名前に openpose を含む最初のモデル）", modelsFirst(list, /openpose/i));
        fill(q(".ps-pose-depth-model"), control.depth.model, "自動（名前に depth を含む最初のモデル）", modelsFirst(list, /depth/i));
        fill(q(".ps-pose-depth-module"), control.depth.module, "自動（" + (depthModuleCache[0] || "depth_anything_v2") + "）", depthModuleCache);
        const noDepthModel = !error && !list.some((x) => /depth/i.test(x));
        q(".ps-pose-depth-warn").classList.toggle("ps-off", !noDepthModel);
    }

    // 深度に使う画像（取り出し元）。カット案の画像から取り出したときだけ使える
    function updateDepthNote() {
        const note = q(".ps-pose-depth-source");
        note.textContent = model.source ? `深度に使う画像：${model.source}（ポーズを取り出した画像）`
            : "深度に使う画像がありません。カット案の画像から「画像から取り出す」をすると使えます（ファイルやドロップした画像は使えません）";
        note.classList.toggle("ps-pose-warn", !model.source);
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
            // 取り出したときの体と手を覚えておく（動かした手足の元の位置を、深度から消すのに使う）
            for (const p of next.people) p.orig = clone({body: p.body, left: p.left, right: p.right});
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
                // 塗った範囲は前の画像に合わせたものなので消す
                model.paint = [];
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
        return JSON.stringify({width: model.width, height: model.height, people: model.people, source: model.source, paint: model.paint});
    }

    function restore(s) {
        const v = JSON.parse(s);
        model.width = v.width;
        model.height = v.height;
        model.people = v.people;
        model.source = v.source;
        model.paint = v.paint || [];
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

    // ---------- 手の反転と回転 ----------

    // 対象の手：選んでいる手の点か、体の手首がある手 [{pi, side}]
    function targetHands() {
        const found = new Map();
        for (const k of selected) {
            const {pi, part, i} = parseKey(k);
            let side = null;
            if (part === "left" || part === "right") side = part;
            else if (part === "body") side = Object.keys(HAND_WRIST).find((s) => HAND_WRIST[s] === i) || null;
            const person = model.people[pi];
            if (side && person && person[side]) found.set(`${pi}:${side}`, {pi, side});
        }
        return [...found.values()];
    }

    // 点を、中心 c のまわりに角度 a（ラジアン）回す
    function rotatePoint(p, c, a) {
        const dx = p.x - c.x;
        const dy = p.y - c.y;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        p.x = c.x + dx * cos - dy * sin;
        p.y = c.y + dx * sin + dy * cos;
    }

    function flipHands() {
        const hands = targetHands();
        if (!hands.length) {
            status("手の点か、体の手首を選んでください");
            return;
        }
        edit(() => {
            for (const {pi, side} of hands) {
                const pts = model.people[pi][side];
                const c = pts[0];
                let ax = pts[9].x - c.x;
                let ay = pts[9].y - c.y;
                const len = Math.hypot(ax, ay);
                if (len < 1e-6) continue;
                ax /= len;
                ay /= len;
                // 手首と中指の付け根を結ぶ線で裏返す
                for (const p of pts.slice(1)) {
                    const dx = p.x - c.x;
                    const dy = p.y - c.y;
                    const t = dx * ax + dy * ay;
                    p.x = c.x + 2 * t * ax - dx;
                    p.y = c.y + 2 * t * ay - dy;
                }
            }
        });
        status(hands.length > 1 ? `${hands.length} つの手を反転しました` : "手を反転しました");
    }

    function rotateHands(deg) {
        const hands = targetHands();
        if (!hands.length) {
            status("手の点か、体の手首を選んでください");
            return;
        }
        edit(() => {
            for (const {pi, side} of hands) {
                const pts = model.people[pi][side];
                pts.slice(1).forEach((p) => rotatePoint(p, pts[0], deg * Math.PI / 180));
            }
        });
    }

    // 手を回すつまみ（画面の座標）。手首のすぐそばの、指と反対側（腕の側）に出す。
    // 画面の外に出るときは、手首の横（左右どちらか）、それでも外なら指の側に出す
    function handKnobs() {
        if (!show.hands || !model) return [];
        const stage = q(".ps-pose-stage").getBoundingClientRect();
        const inside = (x, y) => x >= KNOB + 4 && y >= KNOB + 4 && x <= stage.width - KNOB - 4 && y <= stage.height - KNOB - 4;
        return targetHands().map(({pi, side}) => {
            const pts = model.people[pi][side];
            const c = toScreen(pts[0]);
            const m = toScreen(pts[9]);
            let dx = m.x - c.x;
            let dy = m.y - c.y;
            const len = Math.hypot(dx, dy);
            if (len < 1e-6) {
                dx = 0;
                dy = -1;
            } else {
                dx /= len;
                dy /= len;
            }
            const candidates = [[-dx, -dy], [-dy, dx], [dy, -dx], [dx, dy]].map(([ux, uy]) => ({x: c.x + ux * KNOB_DIST, y: c.y + uy * KNOB_DIST}));
            const at = candidates.find((p) => inside(p.x, p.y)) || candidates[0];
            return {pi, side, c, x: at.x, y: at.y};
        });
    }

    function knobAt(sx, sy) {
        return handKnobs().find((k) => Math.hypot(k.x - sx, k.y - sy) <= KNOB + 3) || null;
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
                model.paint = [];
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
        const pick = (sel) => (q(sel).value === "::error" ? "" : q(sel).value);
        const start = num(".ps-pose-start", 0, 1, 0);
        const depthStart = num(".ps-pose-depth-start", 0, 1, 0);
        return {
            use: q(".ps-pose-use").checked,
            unit: Number(q(".ps-pose-unit").value) || 0,
            model: pick(".ps-pose-model"),
            weight: num(".ps-pose-weight", 0, 2, 1),
            start,
            end: Math.max(num(".ps-pose-end", 0, 1, 1), start),
            mode: q(".ps-pose-mode").value,
            depth: {
                use: q(".ps-pose-depth-use").checked,
                unit: Number(q(".ps-pose-depth-unit").value) || 0,
                module: pick(".ps-pose-depth-module"),
                model: pick(".ps-pose-depth-model"),
                weight: num(".ps-pose-depth-weight", 0, 2, 0.5),
                start: depthStart,
                end: Math.max(num(".ps-pose-depth-end", 0, 1, 1), depthStart),
                grow: num(".ps-pose-depth-grow", 0.5, 2.5, 1),
            },
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

    // 深度から消す範囲（自動の範囲と塗った範囲から、消さない範囲を引いたもの）を、別の板に描いてから薄く重ねる
    let overlayCanvas = null;
    function drawEraseOverlay(ctx) {
        const W = model.width;
        const H = model.height;
        // 板は画像の長い辺を 1024 px までに縮める（重ならないよう 1 枚に描いてから重ねる）
        const k = Math.min(1, 1024 / Math.max(W, H));
        if (!overlayCanvas) overlayCanvas = document.createElement("canvas");
        const oc = overlayCanvas;
        oc.width = Math.max(1, Math.round(W * k));
        oc.height = Math.max(1, Math.round(H * k));
        const g = oc.getContext("2d");
        g.setTransform(k, 0, 0, k, 0, 0);
        g.lineCap = "round";
        g.strokeStyle = "#ff3b3b";
        const short = Math.min(W, H);
        const areas = eraseAreas(toJson(model, false), Number(q(".ps-pose-depth-grow").value) || 1);
        for (const keep of [false, true]) {
            g.globalCompositeOperation = keep ? "destination-out" : "source-over";
            for (const e of areas) {
                if (!!e.keep !== keep) continue;
                const ax = e.a[0] * W, ay = e.a[1] * H;
                const bx = e.b[0] * W, by = e.b[1] * H;
                g.lineWidth = e.w * short;
                g.beginPath();
                g.moveTo(ax, ay);
                g.lineTo(bx + (ax === bx && ay === by ? 0.01 : 0), by);
                g.stroke();
            }
        }
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.drawImage(oc, 0, 0, W, H);
        ctx.restore();
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
        // 深度を使うときは、深度から消す場所（動かした手足の元の位置）を薄い赤で見せる
        if (q(".ps-pose-depth-use").checked && model.source) drawEraseOverlay(ctx);
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
        for (const k of handKnobs()) {
            ctx.strokeStyle = "rgba(255,255,255,0.7)";
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(k.c.x, k.c.y);
            ctx.lineTo(k.x, k.y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = drag && drag.type === "rotate" && drag.pi === k.pi && drag.side === k.side ? "#9cf" : "#fff";
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(k.x, k.y, KNOB, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.lineWidth = 1;
        }
        if (brush && hover) {
            ctx.strokeStyle = hover.keep ? "#4ade80" : "#ff6b6b";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(hover.x, hover.y, Math.max(2, (show.brush / 2) * view.zoom), 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;
        }
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
        const noHand = !targetHands().length;
        q(".ps-pose-flip").disabled = noHand;
        q(".ps-pose-rotl").disabled = noHand;
        q(".ps-pose-rotr").disabled = noHand;
        q(".ps-pose-hide").disabled = !selected.size;
        q(".ps-pose-unhide").disabled = !selected.size;
        const canScale = selected.size >= 2;
        q(".ps-pose-scale").disabled = !canScale;
        q(".ps-pose-scale-down").disabled = !canScale;
        q(".ps-pose-scale-up").disabled = !canScale;
        q(".ps-pose-export").disabled = !model.people.length;
        updateDepthNote();
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
        // 塗るモード：消す範囲（Shift なら消さない範囲）を塗る
        if (brush) {
            pushUndo();
            const p = toCanvas(x, y);
            const stroke = {mode: e.shiftKey ? "keep" : "erase", w: show.brush, pts: [{x: p.x, y: p.y}]};
            model.paint.push(stroke);
            drag = {type: "paint", stroke};
            draw();
            return;
        }
        const knob = knobAt(x, y);
        if (knob) {
            const pts = model.people[knob.pi][knob.side];
            drag = {type: "rotate", pi: knob.pi, side: knob.side, moved: false, a0: Math.atan2(y - knob.c.y, x - knob.c.x),
                start: pts.map((p) => ({...p}))};
            draw();
            return;
        }
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
        if (brush) hover = {x, y, keep: drag && drag.type === "paint" ? drag.stroke.mode === "keep" : e.shiftKey};
        if (!drag) {
            if (brush) {
                canvasEl().style.cursor = spaceDown ? "grab" : "none";
                draw();
                return;
            }
            canvasEl().style.cursor = spaceDown || knobAt(x, y) ? "grab" : hitTest(x, y) ? "pointer" : "crosshair";
            return;
        }
        if (drag.type === "paint") {
            const p = toCanvas(x, y);
            const last = drag.stroke.pts[drag.stroke.pts.length - 1];
            // 筆の太さの 1/5 ほど動いたら点を足す（点を増やしすぎない）
            if (Math.hypot(p.x - last.x, p.y - last.y) >= Math.max(2, drag.stroke.w * 0.2)) drag.stroke.pts.push({x: p.x, y: p.y});
        } else if (drag.type === "pan") {
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
        } else if (drag.type === "rotate") {
            const pts = model.people[drag.pi] && model.people[drag.pi][drag.side];
            if (!pts) return;
            const c = toScreen(drag.start[0]);
            let a = Math.atan2(y - c.y, x - c.x) - drag.a0;
            if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
            if (!drag.moved) {
                if (Math.abs(a) < 1e-3) return;
                pushUndo();
                drag.moved = true;
            }
            pts.forEach((p, i) => {
                p.x = drag.start[i].x;
                p.y = drag.start[i].y;
                if (i) rotatePoint(p, drag.start[0], a);
            });
            const deg = Math.round(a * 180 / Math.PI);
            status(`${((deg % 360) + 540) % 360 - 180}°`);
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

    // 体の点はそこから体の外に向けて、手の点はそこから指先まで（手首なら手全体）、顔の点は顔全体を選ぶ
    function chainKeys(pi, part, i) {
        const person = model.people[pi];
        const keys = [];
        const addPart = (id, list) => {
            const pts = person[id];
            if (!pts) return;
            if ((id === "left" || id === "right") && !show.hands) return;
            if (id === "face" && !show.face) return;
            (list || pts.map((_, j) => j)).forEach((j) => keys.push(keyOf(pi, id, j)));
        };
        if (part === "body") {
            const c = CHAINS[i] || {body: [i]};
            addPart("body", c.body === "all" ? null : c.body);
            if (c.hand) addPart(c.hand);
            if (c.face) addPart("face");
        } else if (part === "left" || part === "right") {
            if (i === 0) {
                addPart(part);
            } else {
                const tip = Math.floor((i - 1) / 4) * 4 + 4;
                const list = [];
                for (let j = i; j <= tip; j++) list.push(j);
                addPart(part, list);
            }
        } else {
            addPart(part);
        }
        return keys;
    }

    function doubleClick(e) {
        if (brush) return;
        const {x, y} = localPos(e);
        if (knobAt(x, y)) return;
        // 鼻・目・手首は顔や手の点と重なりやすいので、届く範囲に体の点があればそれを、次に手の点を選ぶ
        const near = {};
        eachPoint((p, pi, part, i) => {
            const s = toScreen(p);
            const d = Math.hypot(s.x - x, s.y - y);
            const group = part === "body" ? 0 : part === "face" ? 2 : 1;
            if (d < HIT && (!near[group] || d < near[group].d)) near[group] = {d, k: keyOf(pi, part, i)};
        });
        const hit = (near[0] || near[1] || near[2] || {}).k;
        if (!hit) return;
        const {pi, part, i} = parseKey(hit);
        selected = new Set(chainKeys(pi, part, i));
        updateUi();
        draw();
    }

    // ---------- 選んだ点の大きさ ----------
    // 選んだ点を、その範囲の真ん中を中心に、比率を保ったまま大きく・小さくする

    function selectionCenter(points) {
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        return {x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2};
    }

    // 続けて変えたとき（ホイールを回し続ける・ボタンを続けて押す）は、まとめて 1 回で戻せるようにする
    let lastScaleAt = 0;
    function scaleSelection(factor) {
        const points = [...selected].map(pointOf).filter(Boolean);
        if (points.length < 2) return;
        const now = Date.now();
        if (now - lastScaleAt > 600) pushUndo();
        lastScaleAt = now;
        const c = selectionCenter(points);
        for (const p of points) {
            p.x = c.x + (p.x - c.x) * factor;
            p.y = c.y + (p.y - c.y) * factor;
        }
        changed = true;
        updateUi();
        draw();
    }

    // スライダーは、動かし始めたときの位置からの倍率（離すと 100% に戻る）
    let scaleStart = null;
    function scaleSlider(final) {
        const slider = q(".ps-pose-scale");
        const v = Number(slider.value) / 100;
        if (!scaleStart) {
            const keys = [...selected].filter((k) => pointOf(k));
            if (keys.length < 2) return;
            pushUndo();
            const start = keys.map((k) => [k, {...pointOf(k)}]);
            scaleStart = {start, c: selectionCenter(start.map(([, p]) => p))};
        }
        const {start, c} = scaleStart;
        for (const [k, p0] of start) {
            const p = pointOf(k);
            if (!p) continue;
            p.x = c.x + (p0.x - c.x) * v;
            p.y = c.y + (p0.y - c.y) * v;
        }
        changed = true;
        q(".ps-pose-scale-value").textContent = `${Math.round(v * 100)}%`;
        if (final) {
            scaleStart = null;
            slider.value = 100;
            q(".ps-pose-scale-value").textContent = "100%";
            status(`${Math.round(v * 100)}% にしました`);
        }
        draw();
    }

    function wheel(e) {
        e.preventDefault();
        // Alt+ホイールは、選んだ点の大きさを変える
        if (e.altKey && selected.size >= 2) {
            scaleSelection(e.deltaY < 0 ? 1.05 : 1 / 1.05);
            return;
        }
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
            if (brush) {
                setBrush(false);
            } else if (selected.size) {
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
        } else if (e.key.toLowerCase() === "b" && !ctrl && !e.altKey) {
            setBrush(!brush);
        } else if (e.key === "Shift" && brush && hover) {
            hover.keep = true;
            draw();
        } else if (e.key.toLowerCase() === "h" && !ctrl) {
            flipHands();
        } else if ((e.key.toLowerCase() === "q" || e.key.toLowerCase() === "e") && !ctrl) {
            const step = e.shiftKey ? 1 : 15;
            rotateHands(e.key.toLowerCase() === "q" ? -step : step);
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

    window.PolarisPose = {open, close, isOpen, renderDataUrl, jobPayload, DEFAULT_CONTROL, withDefaults};
})();
