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
    // 整列のとき、縦書きで升目の右上に置く字・少し右上に寄せる字・2 字までなら横に並べて 1 升に入れる字（縦中横）
    const CORNER = "、。，．､｡,.";
    const SMALL = "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ";
    const TCY = "0123456789!?";
    const TEXT_MAX = 100, ALIGN_TEXT_MAX = 300, ALIGN_LINES = 20;

    // 既定の設定。大きさはページのピクセル、ほかは字の大きさ（size）に対する割合か角度。
    //   sizeStart・sizeEnd：始めと終わりの字の大きさ（%）。間はなめらかに変える
    //   spacing：字間（%）、rise：全体の傾き（°。プラスで右上がり）、italic：斜体（°）
    //   curve：並びの曲がり（%。プラスで真ん中が上・右にふくらむ）
    //   jitter：ゆらぎの幅。rot は字ごとの角度（°）、size は字ごとの大きさ（%）、offset は並びと直角のずれ（%）、tilt は全体の傾き（°）
    //   zigzag：字のずれ（jitter.offset）の付け方。1 は交互に、1 字目を右（横書きは上）へ。-1 は 1 字目を左（横書きは下）へ。
    //     このときのずれは乱数を使わず、隣り合う字がちょうど offset %（字の大きさに対する割合）ずれる。
    //     0 は字ごとに乱数で決める（はじめの版の動き。それまでに作った形を変えないよう、指定がなければこれ）
    //   amount：ゆらぎの強さ（%。jitter 全体に掛ける。交互のずれには掛けない）
    //   outlines：フチ。字に近い方から順に、色と太さ（%）
    //   glyphs：字ごとの手直し。i 番目の字の {x, y（字の大きさに対する %。全体の傾きの前の向き）, rot（°）, size（%）}。なければ null
    //     i は改行を数えない字の順番
    //   align：整列。ゆらぎ・交互のずれ・傾き・斜体・曲がり・大きさの変化を使わず、升目にそろえて並べる（セリフの組み方）。
    //     このときだけ改行で次の行にできる（縦書きは右の行から左へ）。lineHeight は行の間隔（字の大きさに対する %）
    //     ほかの設定は残しておくので、整列を外せば元の形に戻る
    const DEFAULTS = {
        text: "ドン", font: "", vertical: false, size: 140, align: false, lineHeight: 150,
        sizeStart: 100, sizeEnd: 100, spacing: 0, rise: 0, italic: 0, curve: 0,
        jitter: {rot: 6, size: 6, offset: 6, tilt: 4}, zigzag: 1, amount: 100,
        fill: "#000000", outlines: [{color: "#ffffff", width: 8}],
        glyphs: [], seed: 1,
    };
    const GLYPHS_MAX = 32;

    // ひな形。文字・フォント・大きさ以外の設定
    const PRESETS = [
        {key: "impact", label: "衝撃", title: "ドン・バン など。だんだん大きく、右上がりに勢いよく",
            params: {vertical: false, sizeStart: 80, sizeEnd: 125, spacing: -6, rise: 8, italic: 10, curve: 0,
                jitter: {rot: 10, size: 12, offset: 8, tilt: 6}, zigzag: 1, fill: "#000000", outlines: [{color: "#ffffff", width: 10}]}},
        {key: "rumble", label: "地響き", title: "ゴゴゴ・ズズズ など。重く、上下に細かく揺れる",
            params: {vertical: false, sizeStart: 100, sizeEnd: 100, spacing: 4, rise: 0, italic: 0, curve: 0,
                jitter: {rot: 6, size: 6, offset: 14, tilt: 3}, zigzag: 1, fill: "#000000", outlines: [{color: "#ffffff", width: 7}, {color: "#000000", width: 4}]}},
        {key: "slash", label: "斬撃", title: "ザッ・シュッ など。強く傾け、尾を引くように小さく",
            params: {vertical: false, sizeStart: 130, sizeEnd: 70, spacing: -10, rise: 16, italic: 24, curve: 0,
                jitter: {rot: 4, size: 5, offset: 3, tilt: 5}, zigzag: 1, fill: "#000000", outlines: [{color: "#ffffff", width: 8}]}},
        {key: "soft", label: "やわらか", title: "ふわっ・ぽよん など。白抜きで、ゆるく弾む",
            params: {vertical: false, sizeStart: 100, sizeEnd: 100, spacing: 0, rise: 0, italic: 0, curve: 25,
                jitter: {rot: 12, size: 10, offset: 10, tilt: 8}, zigzag: 1, fill: "#ffffff", outlines: [{color: "#000000", width: 5}]}},
        {key: "quiet", label: "静けさ", title: "シーン・しん など。縦に間をあけて、ほとんど揺らさない",
            params: {vertical: true, sizeStart: 100, sizeEnd: 100, spacing: 30, rise: 0, italic: 0, curve: 0,
                jitter: {rot: 1, size: 0, offset: 1, tilt: 0}, zigzag: 1, fill: "#000000", outlines: []}},
        {key: "pop", label: "ポップ", title: "キラッ・パッ など。白い字に黒と白の二重フチ",
            params: {vertical: false, sizeStart: 95, sizeEnd: 110, spacing: -4, rise: 6, italic: 0, curve: 15,
                jitter: {rot: 15, size: 14, offset: 10, tilt: 6}, zigzag: 1, fill: "#ffffff", outlines: [{color: "#000000", width: 6}, {color: "#ffffff", width: 6}]}},
    ];

    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const num = (v, lo, hi, d) => (typeof v === "number" && isFinite(v) ? clamp(v, lo, hi) : d);
    const color = (v, d) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);

    // 足りない値を既定で埋め、範囲に収める
    function clean(p) {
        p = p && typeof p === "object" ? p : {};
        const j = p.jitter && typeof p.jitter === "object" ? p.jitter : {};
        const D = DEFAULTS;
        const align = p.align === true;
        return {
            text: cleanText(p.text, align),
            font: typeof p.font === "string" ? p.font : "",
            vertical: p.vertical === true,
            size: num(p.size, 8, 2000, D.size),
            align,
            lineHeight: num(p.lineHeight, 100, 400, D.lineHeight),
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
            zigzag: p.zigzag === 1 || p.zigzag === -1 ? p.zigzag : 0,
            amount: num(p.amount, 0, 300, D.amount),
            fill: color(p.fill, D.fill),
            outlines: Array.from((Array.isArray(p.outlines) ? p.outlines : D.outlines).slice(0, 3),
                (o) => ({color: color(o && o.color, "#ffffff"), width: num(o && o.width, 0, 60, 0)})),
            glyphs: cleanGlyphs(p.glyphs),
            seed: Math.floor(num(p.seed, 0, 2147483647, 1)),
        };
    }

    // 文字。整列なら改行を残し（前後の空行は落とす）、そうでなければ 1 行にする
    function cleanText(v, align) {
        if (typeof v !== "string" || !v.trim()) return DEFAULTS.text;
        if (!align) return v.replace(/[\r\n]+/g, "").slice(0, TEXT_MAX);
        const lines = v.replace(/\r\n?/g, "\n").slice(0, ALIGN_TEXT_MAX).split("\n");
        while (lines.length && !lines[0].trim()) lines.shift();
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        return lines.slice(0, ALIGN_LINES).join("\n");
    }

    // 改行を除いた字の並び（字の手直しの番号はこれで数える）
    const charsOf = (text) => Array.from(text).filter((ch) => ch !== "\n");

    // 字ごとの手直し。何も変えていない字は null にし、後ろの null は詰める
    function cleanGlyphs(list) {
        if (!Array.isArray(list)) return [];
        const out = Array.from(list.slice(0, GLYPHS_MAX), (g) => {
            if (!g || typeof g !== "object") return null;
            const r = (v) => Math.round(v * 10) / 10;
            const o = {x: r(num(g.x, -500, 500, 0)), y: r(num(g.y, -500, 500, 0)), rot: r(num(g.rot, -180, 180, 0)), size: r(num(g.size, 10, 400, 100))};
            return o.x || o.y || o.rot || o.size !== 100 ? o : null;
        });
        while (out.length && !out[out.length - 1]) out.pop();
        return out;
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
    const ready = (p) => charsOf(p.text).every((ch) => glyphs.has(gkey(p.font, ch)));

    // 足りない字の輪郭を取りに行く。届いたら listeners を呼ぶ
    function load(p) {
        const missing = [...new Set(charsOf(p.text))].filter((ch) => !glyphs.has(gkey(p.font, ch)));
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
        if (p.align) return alignedLayout(p);
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
        items.forEach((it, i) => {
            const u = it.at / length;
            // 並びの曲がり（放物線）。真ん中が length * c / 2 だけふくらむ
            const bend = -c * length / 2 * (1 - (2 * u - 1) ** 2);
            const slope = Math.atan(c * 2 * (2 * u - 1)) * 180 / Math.PI;
            // 字のずれ。交互なら、隣り合う字がちょうど offset % ずれる（マイナスが縦書きの右・横書きの上）
            const shift = p.zigzag
                ? -p.zigzag * (i % 2 ? -1 : 1) * p.jitter.offset / 100 * base / 2
                : p.jitter.offset / 100 * k * it.scale * it.ro;
            const off = bend + shift;
            const along = it.at - length / 2;
            it.x = p.vertical ? -off : along;
            it.y = p.vertical ? along : off;
            it.rot = (p.vertical ? -slope : slope) + p.jitter.rot * k * it.rr;
            it.turn = p.vertical && ROTATE.includes(it.ch);
            // 字ごとの手直し
            const o = p.glyphs[i];
            if (o) {
                it.x += o.x / 100 * base;
                it.y += o.y / 100 * base;
                it.rot += o.rot;
                it.scale *= o.size / 100;
            }
        });
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

    // 整列：セリフと同じ組み方。縦書きは 1 字ずつ字の大きさの升目に並べ、右の行から左へ。横書きは字形の幅で並べる。
    //   - 縦書きの「ー」「（」などは 90° 回し、「、」「。」は升目の右上に、小さい「っ」などは少し右上に寄せる
    //   - 縦書きで半角の数字・!・? が 2 字までなら、横に並べて 1 升に入れる（縦中横）。升目に入らなければ縮める
    // 原点は升目全体の真ん中。外枠は升目にフチの分の余白を足したもの
    function alignedLayout(p) {
        const base = p.size;
        const adv = base * (1 + p.spacing / 100), pitch = base * p.lineHeight / 100;
        const lines = p.text.split("\n");
        const glyph = (ch) => glyphs.get(gkey(p.font, ch)) || {d: "", adv: 500, cy: -380};
        const items = [];
        const put = (ch, x, y, scale, turn) => items.push({ch, g: glyph(ch), scale, x, y, rot: 0, turn});
        let w, h;
        if (p.vertical) {
            w = base + (lines.length - 1) * pitch;
            let longest = base;
            lines.forEach((line, li) => {
                const cx = w - base / 2 - li * pitch;
                const cells = [];
                const chars = Array.from(line);
                for (let i = 0; i < chars.length;) {
                    if (!TCY.includes(chars[i])) {
                        cells.push([chars[i++]]);
                        continue;
                    }
                    let j = i;
                    while (j < chars.length && TCY.includes(chars[j])) j++;
                    if (j - i <= 2) cells.push(chars.slice(i, j));
                    else chars.slice(i, j).forEach((ch) => cells.push([ch]));
                    i = j;
                }
                cells.forEach((cell, k) => {
                    const cy = base / 2 + k * adv;
                    if (cell.length > 1) {
                        const total = cell.reduce((a, ch) => a + glyph(ch).adv / 1000 * base, 0);
                        const s = total > base * 0.95 ? base * 0.95 / total : 1;
                        let x = cx - total * s / 2;
                        for (const ch of cell) {
                            const a = glyph(ch).adv / 1000 * base * s;
                            put(ch, x + a / 2, cy, base * s, false);
                            x += a;
                        }
                        return;
                    }
                    const ch = cell[0];
                    if (ROTATE.includes(ch)) put(ch, cx, cy, base, true);
                    else if (CORNER.includes(ch)) put(ch, cx + base * 0.5, cy - base * 0.5, base, false);
                    else if (SMALL.includes(ch)) put(ch, cx + base * 0.08, cy - base * 0.08, base, false);
                    else put(ch, cx, cy, base, false);
                });
                if (cells.length) longest = Math.max(longest, base + (cells.length - 1) * adv);
            });
            h = longest;
        } else {
            let widest = base;
            lines.forEach((line, li) => {
                const cy = base / 2 + li * pitch;
                let cursor = 0;
                Array.from(line).forEach((ch, j) => {
                    if (j) cursor += p.spacing / 100 * base;
                    const a = glyph(ch).adv / 1000 * base;
                    put(ch, cursor + a / 2, cy, base, false);
                    cursor += a;
                });
                widest = Math.max(widest, cursor);
            });
            w = widest;
            h = base + (lines.length - 1) * pitch;
        }
        items.forEach((it, i) => {
            it.x -= w / 2;
            it.y -= h / 2;
            const o = p.glyphs[i];
            if (o) {
                it.x += o.x / 100 * base;
                it.y += o.y / 100 * base;
                it.rot += o.rot;
                it.scale *= o.size / 100;
            }
        });
        const pad = p.outlines.reduce((a, o) => a + o.width, 0) / 100 * base + base * 0.06;
        // 字の手直しで升目の外に出た字も枠に入れる
        let x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
        items.forEach((it, i) => {
            if (!p.glyphs[i]) return;
            const r = it.scale / 2 * Math.SQRT2;
            x0 = Math.min(x0, it.x - r); y0 = Math.min(y0, it.y - r); x1 = Math.max(x1, it.x + r); y1 = Math.max(y1, it.y + r);
        });
        return {items, angle: 0, box: {x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2}, base};
    }

    // 整列なら斜体を使わない
    const italicOf = (p) => (p.align ? 0 : p.italic);

    const f1 = (v) => Math.round(v * 100) / 100;

    // 字ごとの変換（字形の単位 → 並びの座標）
    function glyphTransform(it, p) {
        const s = it.scale / 1000;
        return `translate(${f1(it.x)} ${f1(it.y)}) rotate(${f1(it.rot)}) skewX(${f1(-italicOf(p))}) scale(${f1(s * 1000) / 1000})` +
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
        return {w: lay.box.w, h: lay.box.h, ox: -lay.box.x, oy: -lay.box.y, svg: markup(p, lay)};
    }

    // 置いたオノマトペの字ごとの位置（ページの座標）。字の手直しに使う。輪郭がまだなら null
    //   glyphs[i]：c（字の真ん中）、pts（字の枠の四隅）、up（字の上向きの単位ベクトル）、half（字の枠の半分の高さ）
    //   toLocal(dx, dy)：ページでの動きを、手直しの x・y（%）の動きに直す
    function frames(shape) {
        const p = clean(shape.params);
        if (!ready(p)) {
            load(p);
            return null;
        }
        const lay = layout(p);
        const sx = shape.w / lay.box.w, sy = shape.h / lay.box.h;
        const rad = lay.angle * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const toPage = (x, y) => ({x: shape.x + sx * (x * cos - y * sin - lay.box.x), y: shape.y + sy * (x * sin + y * cos - lay.box.y)});
        const skew = Math.tan(italicOf(p) * Math.PI / 180);
        const glyphs = lay.items.map((it, i) => {
            const hw = (it.turn ? 500 : it.g.adv / 2) / 1000 * it.scale, hh = (it.turn ? it.g.adv / 2 : 500) / 1000 * it.scale;
            const a = it.rot * Math.PI / 180;
            const at = (lx, ly) => {
                const kx = lx - ly * skew;
                return toPage(it.x + kx * Math.cos(a) - ly * Math.sin(a), it.y + kx * Math.sin(a) + ly * Math.cos(a));
            };
            const c = toPage(it.x, it.y);
            const top = at(0, -hh);
            const len = Math.hypot(top.x - c.x, top.y - c.y) || 1;
            return {i, ch: it.ch, c, pts: [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)].map((q) => [q.x, q.y]),
                up: {x: (top.x - c.x) / len, y: (top.y - c.y) / len}, half: len};
        });
        const toLocal = (dx, dy) => {
            const x = dx / sx, y = dy / sy;
            return {x: (x * cos + y * sin) / lay.base * 100, y: (-x * sin + y * cos) / lay.base * 100};
        };
        return {glyphs, toLocal};
    }

    // 字の手直しのあと、ほかの字がページの上で動かないよう、並びの原点を prev（変える前の形）と同じ所に保って枠を合わせる
    function refit(shape, prev) {
        const b0 = build(prev.params), b = build(shape.params);
        if (!b0 || !b) return fit(shape);
        const sx = prev.w / b0.w, sy = prev.h / b0.h;
        const ox = prev.x + b0.ox * sx, oy = prev.y + b0.oy * sy;
        shape.w = Math.round(b.w * sx * 10) / 10;
        shape.h = Math.round(b.h * sy * 10) / 10;
        shape.x = Math.round((ox - b.ox * sx) * 10) / 10;
        shape.y = Math.round((oy - b.oy * sy) * 10) / 10;
        return true;
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
        DEFAULTS, PRESETS, clean, randomSeed, load, ready: (p) => ready(clean(p)), build, node, preview, fit, frames, refit,
        keyOf, stale, bake, rasterize, onLoad: (f) => listeners.add(f), charsOf,
    };
})();
