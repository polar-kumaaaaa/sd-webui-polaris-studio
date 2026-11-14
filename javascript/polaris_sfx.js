// Polaris Studio: オノマトペ（効果音・擬音）の形を作る
// 字形の輪郭はサーバー（fontTools）から受け取り、ここで並べ・ゆらして SVG にする。
// 形は設定（params）と乱数の種（seed）だけで決まる。同じ設定と種なら、いつも同じ形になる。
// 書き出しには、ここで描いた SVG を 2 倍の大きさの PNG にして素材と同じ置き場所に保存したものを使う
(function () {
    "use strict";

    const NS = "http://www.w3.org/2000/svg";
    const VERSION = 1;          // 描き方を変えたら上げる（書き出し用の画像を作り直す）
    const BAKE_SCALE = 2;       // 書き出し用の画像は置いた大きさの 2 倍で作る
    const BAKE_MAX = 8192;
    // 縦書きで 90° 回す字（セリフと同じ）
    const ROTATE = "ー－−–—―…‥～〜~（）()「」『』【】〔〕［］[]｛｝{}〈〉《》＜＞<>＝=-_｜|：:";

    // 既定の設定。大きさはページのピクセル、ほかは字の大きさ（size）に対する割合か角度。
    //   sizeStart・sizeEnd：始めと終わりの字の大きさ（%）。間はなめらかに変える
    //   spacing：字間（%）、rise：全体の傾き（°。プラスで右上がり）、italic：斜体（°）
    //   curve：並びの曲がり（%。プラスで真ん中が上・右にふくらむ）
    //   jitter：ゆらぎの幅。rot は字ごとの角度（°）、size は字ごとの大きさ（%）、offset は並びと直角のずれ（%）、tilt は全体の傾き（°）
    //   amount：ゆらぎの強さ（%。jitter 全体に掛ける）
    //   outlines：フチ。字に近い方から順に、色と太さ（%）
    const DEFAULTS = {
        text: "ドン", font: "", vertical: false, size: 140,
        sizeStart: 100, sizeEnd: 100, spacing: 0, rise: 0, italic: 0, curve: 0,
        jitter: {rot: 6, size: 6, offset: 6, tilt: 4}, amount: 100,
        fill: "#000000", outlines: [{color: "#ffffff", width: 8}],
        seed: 1,
    };

    // ひな形。文字・フォント・大きさ以外の設定
    const PRESETS = [
        {key: "impact", label: "衝撃", title: "ドン・バン など。だんだん大きく、右上がりに勢いよく",
            params: {vertical: false, sizeStart: 80, sizeEnd: 125, spacing: -6, rise: 8, italic: 10, curve: 0,
                jitter: {rot: 10, size: 12, offset: 8, tilt: 6}, fill: "#000000", outlines: [{color: "#ffffff", width: 10}]}},
        {key: "rumble", label: "地響き", title: "ゴゴゴ・ズズズ など。重く、上下に細かく揺れる",
            params: {vertical: false, sizeStart: 100, sizeEnd: 100, spacing: 4, rise: 0, italic: 0, curve: 0,
                jitter: {rot: 6, size: 6, offset: 14, tilt: 3}, fill: "#000000", outlines: [{color: "#ffffff", width: 7}, {color: "#000000", width: 4}]}},
        {key: "slash", label: "斬撃", title: "ザッ・シュッ など。強く傾け、尾を引くように小さく",
            params: {vertical: false, sizeStart: 130, sizeEnd: 70, spacing: -10, rise: 16, italic: 24, curve: 0,
                jitter: {rot: 4, size: 5, offset: 3, tilt: 5}, fill: "#000000", outlines: [{color: "#ffffff", width: 8}]}},
        {key: "soft", label: "やわらか", title: "ふわっ・ぽよん など。白抜きで、ゆるく弾む",
            params: {vertical: false, sizeStart: 100, sizeEnd: 100, spacing: 0, rise: 0, italic: 0, curve: 25,
                jitter: {rot: 12, size: 10, offset: 10, tilt: 8}, fill: "#ffffff", outlines: [{color: "#000000", width: 5}]}},
        {key: "quiet", label: "静けさ", title: "シーン・しん など。縦に間をあけて、ほとんど揺らさない",
            params: {vertical: true, sizeStart: 100, sizeEnd: 100, spacing: 30, rise: 0, italic: 0, curve: 0,
                jitter: {rot: 1, size: 0, offset: 1, tilt: 0}, fill: "#000000", outlines: []}},
        {key: "pop", label: "ポップ", title: "キラッ・パッ など。白い字に黒と白の二重フチ",
            params: {vertical: false, sizeStart: 95, sizeEnd: 110, spacing: -4, rise: 6, italic: 0, curve: 15,
                jitter: {rot: 15, size: 14, offset: 10, tilt: 6}, fill: "#ffffff", outlines: [{color: "#000000", width: 6}, {color: "#ffffff", width: 6}]}},
    ];

    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const num = (v, lo, hi, d) => (typeof v === "number" && isFinite(v) ? clamp(v, lo, hi) : d);
    const color = (v, d) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);

    // 足りない値を既定で埋め、範囲に収める
    function clean(p) {
        p = p && typeof p === "object" ? p : {};
        const j = p.jitter && typeof p.jitter === "object" ? p.jitter : {};
        const D = DEFAULTS;
        return {
            text: typeof p.text === "string" && p.text.trim() ? p.text.replace(/[\r\n]+/g, "").slice(0, 100) : D.text,
            font: typeof p.font === "string" ? p.font : "",
            vertical: p.vertical === true,
            size: num(p.size, 8, 2000, D.size),
            sizeStart: num(p.sizeStart, 10, 400, D.sizeStart),
            sizeEnd: num(p.sizeEnd, 10, 400, D.sizeEnd),
            spacing: num(p.spacing, -60, 200, D.spacing),
            rise: num(p.rise, -180, 180, D.rise),
            italic: num(p.italic, -45, 45, D.italic),
            curve: num(p.curve, -100, 100, D.curve),
            jitter: {
                rot: num(j.rot, 0, 90, D.jitter.rot), size: num(j.size, 0, 80, D.jitter.size),
                offset: num(j.offset, 0, 100, D.jitter.offset), tilt: num(j.tilt, 0, 45, D.jitter.tilt),
            },
            amount: num(p.amount, 0, 300, D.amount),
            fill: color(p.fill, D.fill),
            outlines: Array.from((Array.isArray(p.outlines) ? p.outlines : D.outlines).slice(0, 3),
                (o) => ({color: color(o && o.color, "#ffffff"), width: num(o && o.width, 0, 60, 0)})),
            seed: Math.floor(num(p.seed, 0, 2147483647, 1)),
        };
    }

    const randomSeed = () => Math.floor(Math.random() * 2147483647);

    // 種から決まる乱数（-1〜1）
    function rng(seed) {
        let a = (seed >>> 0) || 1;
        return () => {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
        };
    }

    // ---------- 字形の輪郭 ----------

    const glyphs = new Map();       // "フォント\n字" → {d, adv, cy}
    const loading = new Map();      // "フォント\n字の並び" → Promise
    const listeners = new Set();    // 輪郭が届いたら呼ぶ

    const gkey = (font, ch) => font + "\n" + ch;
    const ready = (p) => Array.from(p.text).every((ch) => glyphs.has(gkey(p.font, ch)));

    // 足りない字の輪郭を取りに行く。届いたら listeners を呼ぶ
    function load(p) {
        const missing = [...new Set(Array.from(p.text))].filter((ch) => !glyphs.has(gkey(p.font, ch)));
        if (!missing.length) return Promise.resolve();
        const key = gkey(p.font, missing.join(""));
        if (!loading.has(key)) {
            const url = `polaris-studio/glyphs?font=${encodeURIComponent(p.font || "win:YuGothB.ttc#0")}&text=${encodeURIComponent(missing.join(""))}`;
            loading.set(key, fetch(url).then((r) => r.json()).then((data) => {
                for (const ch of missing) glyphs.set(gkey(p.font, ch), (data.glyphs && data.glyphs[ch]) || {d: "", adv: 500, cy: -380});
                listeners.forEach((f) => f());
            }).catch(() => {
                for (const ch of missing) glyphs.set(gkey(p.font, ch), {d: "", adv: 500, cy: -380});
            }).finally(() => loading.delete(key)));
        }
        return loading.get(key);
    }

    // ---------- 並べ方 ----------
    // 字を 1 列に並べ、並びの真ん中を原点にする。横書きは右へ、縦書きは下へ。
    // 戻り値は字ごとの変換と大きさ、全体の傾き、外枠（フチの分の余白を含む）

    function layout(p) {
        const r = rng(p.seed);
        const k = p.amount / 100;
        const chars = Array.from(p.text);
        const n = chars.length;
        const base = p.size;
        const items = [];
        let cursor = 0;
        chars.forEach((ch, i) => {
            // 乱数はゆらぎの幅に関係なく同じ順に引く（幅を変えても形の傾向が変わらない）
            const rr = r(), rs = r(), ro = r();
            const t = n > 1 ? i / (n - 1) : 0;
            const scale = base * (p.sizeStart + (p.sizeEnd - p.sizeStart) * t) / 100 * Math.max(0.2, 1 + p.jitter.size / 100 * k * rs);
            const g = glyphs.get(gkey(p.font, ch)) || {d: "", adv: 500, cy: -380};
            const extent = p.vertical ? scale : g.adv / 1000 * scale;
            items.push({ch, g, scale, rr, ro, at: cursor + extent / 2});
            cursor += extent + (i < n - 1 ? p.spacing / 100 * base : 0);
        });
        const length = Math.max(cursor, 1);
        const tilt = r();
        const c = p.curve / 100;
        for (const it of items) {
            const u = it.at / length;
            // 並びの曲がり（放物線）。真ん中が length * c / 2 だけふくらむ
            const bend = -c * length / 2 * (1 - (2 * u - 1) ** 2);
            const slope = Math.atan(c * 2 * (2 * u - 1)) * 180 / Math.PI;
            const off = bend + p.jitter.offset / 100 * k * it.scale * it.ro;
            const along = it.at - length / 2;
            it.x = p.vertical ? -off : along;
            it.y = p.vertical ? along : off;
            it.rot = (p.vertical ? -slope : slope) + p.jitter.rot * k * it.rr;
            it.turn = p.vertical && ROTATE.includes(it.ch);
        }
        const angle = -(p.rise + p.jitter.tilt * k * tilt);
        // 外枠。字の枠（em）の四隅を変換して求める
        const pad = p.outlines.reduce((a, o) => a + o.width, 0) / 100 * base + base * 0.06;
        const rad = angle * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const it of items) {
            const hw = (it.turn ? 500 : it.g.adv / 2) / 1000 * it.scale, hh = (it.turn ? it.g.adv / 2 : 500) / 1000 * it.scale;
            const a = it.rot * Math.PI / 180, skew = Math.tan(p.italic * Math.PI / 180);
            for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
                const sx = lx - ly * skew;
                const gx = it.x + sx * Math.cos(a) - ly * Math.sin(a);
                const gy = it.y + sx * Math.sin(a) + ly * Math.cos(a);
                const px = gx * cos - gy * sin, py = gx * sin + gy * cos;
                x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
            }
        }
        if (!items.length) x0 = y0 = -base / 2, x1 = y1 = base / 2;
        return {items, angle, box: {x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2}, base};
    }

    const f1 = (v) => Math.round(v * 100) / 100;

    // 字ごとの変換（字形の単位 → 並びの座標）
    function glyphTransform(it, p) {
        const s = it.scale / 1000;
        return `translate(${f1(it.x)} ${f1(it.y)}) rotate(${f1(it.rot)}) skewX(${f1(-p.italic)}) scale(${f1(s * 1000) / 1000})` +
            (it.turn ? " rotate(90)" : "") + ` translate(${f1(-it.g.adv / 2)} ${f1(-it.g.cy)})`;
    }

    // SVG の中身（文字列）。原点は外枠の左上。フチは外側から順に全部の字を描き、最後に字を塗る（隣の字のフチが字に掛からない）
    function markup(p, lay) {
        const tr = lay.items.filter((it) => it.g.d).map((it) => ({d: it.g.d, t: glyphTransform(it, p), unit: it.scale / 1000}));
        const layers = [];
        let total = 0;
        const widths = p.outlines.map((o) => (total += o.width / 100 * lay.base));
        for (let i = p.outlines.length - 1; i >= 0; i--) {
            const o = p.outlines[i];
            if (!o.width) continue;
            layers.push(`<g fill="${o.color}" stroke="${o.color}" stroke-linejoin="round">` +
                tr.map((g) => `<path d="${g.d}" transform="${g.t}" stroke-width="${f1(widths[i] * 2 / g.unit)}"/>`).join("") + "</g>");
        }
        layers.push(`<g fill="${p.fill}">` + tr.map((g) => `<path d="${g.d}" transform="${g.t}"/>`).join("") + "</g>");
        return `<g transform="translate(${f1(-lay.box.x)} ${f1(-lay.box.y)}) rotate(${f1(lay.angle)})">${layers.join("")}</g>`;
    }

    // 形を作る。輪郭がまだ届いていなければ null（届いたら listeners が呼ばれる）
    // 戻り値の w, h は外枠の大きさ、svg は外枠を 0,0 からとした中身
    function build(params) {
        const p = clean(params);
        if (!ready(p)) {
            load(p);
            return null;
        }
        const lay = layout(p);
        return {w: lay.box.w, h: lay.box.h, svg: markup(p, lay)};
    }

    // ページの SVG に置く <g>。x, y, w, h の枠に合わせる
    function node(shape) {
        const b = build(shape.params);
        if (!b) return null;
        const g = document.createElementNS(NS, "g");
        g.setAttribute("transform", `translate(${shape.x} ${shape.y}) scale(${shape.w / b.w} ${shape.h / b.h})`);
        g.innerHTML = b.svg;
        return g;
    }

    // 一覧に出す小さな見本（SVG 要素）
    function preview(params, size) {
        const b = build(params);
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("class", "ps-sfx-preview");
        if (!b) return svg;
        svg.setAttribute("viewBox", `0 0 ${f1(b.w)} ${f1(b.h)}`);
        if (size) svg.setAttribute("style", `width:${size}px;height:${size}px`);
        svg.innerHTML = b.svg;
        return svg;
    }

    // 書き出し用の画像が今の設定に合っているかを見るためのキー
    function keyOf(params) {
        const text = VERSION + JSON.stringify(clean(params));
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
        return (h >>> 0).toString(36) + text.length.toString(36);
    }

    // 置いた大きさの 2 倍の PNG（Blob）にする
    async function rasterize(shape) {
        await load(clean(shape.params));
        const b = build(shape.params);
        if (!b) throw new Error("字形を読み込めません");
        const scale = Math.min(BAKE_SCALE * shape.w / b.w, BAKE_MAX / b.w, BAKE_MAX / b.h);
        const w = Math.max(1, Math.round(b.w * scale)), h = Math.max(1, Math.round(b.h * scale));
        const src = `<svg xmlns="${NS}" width="${w}" height="${h}" viewBox="0 0 ${f1(b.w)} ${f1(b.h)}">${b.svg}</svg>`;
        const url = URL.createObjectURL(new Blob([src], {type: "image/svg+xml"}));
        try {
            const img = new Image();
            img.src = url;
            await img.decode();
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            return await new Promise((ok, ng) => canvas.toBlob((blob) => (blob ? ok(blob) : ng(new Error("PNG にできません"))), "image/png"));
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    const stale = (s) => s.type === "sfx" && (!s.name || s.key !== keyOf(s.params));

    // ページのオノマトペのうち、書き出し用の画像が古いものを作り直して保存する。変えたら true。
    // upload(blob) は {name} を返す（素材のアップロード）
    async function bake(pages, upload) {
        let changed = false;
        for (const page of pages) {
            for (const s of page.shapes || []) {
                if (!stale(s)) continue;
                const key = keyOf(s.params);
                const saved = await upload(await rasterize(s));
                // 作っている間に設定が変わっていたら、次の機会に作り直す
                if (keyOf(s.params) !== key) continue;
                s.name = saved.name;
                s.key = key;
                changed = true;
            }
        }
        return changed;
    }

    // 設定を変えたあと、外枠の真ん中を保ったまま枠の大きさを合わせる
    function fit(shape) {
        const b = build(shape.params);
        if (!b) return false;
        const cx = shape.x + shape.w / 2, cy = shape.y + shape.h / 2;
        shape.w = Math.round(b.w * 10) / 10;
        shape.h = Math.round(b.h * 10) / 10;
        shape.x = Math.round((cx - shape.w / 2) * 10) / 10;
        shape.y = Math.round((cy - shape.h / 2) * 10) / 10;
        return true;
    }

    window.PolarisSfx = {
        DEFAULTS, PRESETS, clean, randomSeed, load, ready: (p) => ready(clean(p)), build, node, preview, fit,
        keyOf, stale, bake, rasterize, onLoad: (f) => listeners.add(f),
    };
})();
