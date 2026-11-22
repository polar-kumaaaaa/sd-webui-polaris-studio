// Polaris Studio: コマページ（漫画のコマ割り）
// Book の中に置く白紙のページ。直線と四角を描き、四角には Book の画像の一部（クロップ範囲）をはめ込む。
// 元の画像には手を加えず、どの画像のどの範囲かだけを持つ。ZIP の書き出しではサーバーが 1 枚の画像にする。
// 吹き出し・集中線・小物などの画像は「素材」として、コマと線の上の層に自由に置ける。
// 座標はすべてページのピクセル。四角の線は四角の内側に描き、画像は四角いっぱいに置く（サーバーの描き方と同じ）
(function () {
    "use strict";

    const NS = "http://www.w3.org/2000/svg";
    const STROKES = [0, 4, 8, 12, 16, 24];  // 0 は線なし（四角だけ）
    const PAGE_WIDTH = 1573;
    const PAGE_HEIGHT = 2200;
    const PAGE_MIN = 64;
    const PAGE_MAX = 8192;
    const MIN_SIZE = 16;        // 四角の幅・高さと直線の長さの最小（ページのピクセル）
    const CROP_MIN = 16;        // クロップ範囲の幅の最小（画像のピクセル）
    const HANDLE = 10;          // つまみの大きさ（画面のピクセル）
    const SNAP = 8;             // 吸着する距離（画面のピクセル）
    const CLICK_MOVE = 4;       // これより動かなければクリック（画面のピクセル）
    const UNDO_MAX = 100;
    const PREFS_KEY = "polaris-studio:page-tools";
    const RECT_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    const HINTS = {
        select: "クリックで選択、ドラッグで移動・サイズ変更。選んだ四角をもう一度クリック（またはダブルクリック）すると画像を選べます。Delete で削除、Ctrl+Z で元に戻す。Alt を押している間は吸着しません。重なったコマは「下を隠す」(H) で手前のコマだけの線にし、「前面へ」(])「背面へ」([) で手前にするコマを決めます。素材は角のつまみで縦横比を保って拡大・縮小（Shift で自由に）、辺のつまみで伸び縮みします。「頂点を編集」(E) では、コマの角の丸いつまみをドラッグして台形・平行四辺形などにします（Shift で水平・垂直だけ、矢印キーで 1 px ずつ）。オノマトペは、選んでダブルクリックで「字を 1 つずつ直す」の入り・切り、Ctrl を押しながらドラッグで複製します。",
        line: "ドラッグで直線を引きます。Shift で水平・垂直。直線は分割線で、画像ははめ込めません。",
        hline: "ドラッグで、手で引いたように揺れる線を引きます。Shift で水平・垂直。太さ・揺れ・色・フチは下の行で、🎲 で別の揺れ方にします。引いた線は「選択」で両端を動かせます。",
        rect: "ドラッグで四角を描きます。Shift で正方形。線「なし」にすると透明な四角（線のないコマ）になります。台形や平行四辺形は、四角を選んで「頂点を編集」(E) で角を動かして作ります。",
        tri: "ドラッグで三角を描きます（ドラッグした枠の上の辺の真ん中が頂点。上へドラッグすると逆向き）。Shift で幅と高さをそろえます。描いたあとは「頂点を編集」(E) で角を動かせます。",
        text: "クリックした所にセリフを置き、文字を入力します（Ctrl+Enter で決定、Esc で取り消し）。置いたセリフをクリックすると文字を直せます。フォント・大きさ・縦書き/横書きなどは下の行で。動かすのは「選択」で。",
    };

    const el = (...args) => window.PolarisStudio.el(...args);
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const round1 = (v) => Math.round(v * 10) / 10;
    const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    function svgEl(tag, attrs = {}, children = []) {
        const e = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === "text") e.textContent = v;
            else e.setAttribute(k, v);
        }
        for (const c of children) e.appendChild(c);
        return e;
    }

    function newPage() {
        return {type: "page", id: newId(), width: PAGE_WIDTH, height: PAGE_HEIGHT, shapes: []};
    }

    // はめ込む範囲。四角と縦横比が違うときは、範囲の中央を四角の縦横比で切り出す（サーバーの fitted_crop と同じ）
    function fittedCrop(crop, w, h) {
        let {x, y, w: cw, h: ch} = crop;
        if (cw / ch > w / h) {
            const nw = ch * w / h;
            x += (cw - nw) / 2;
            cw = nw;
        } else {
            const nh = cw * h / w;
            y += (ch - nh) / 2;
            ch = nh;
        }
        return {x, y, w: cw, h: ch};
    }

    // 四角に映す画像の範囲（画像のピクセル）。
    // "full"（原寸）は画像を拡大・縮小せずに置く。範囲は四角と同じ大きさで、画像からはみ出した所は白い余白になる。
    // 四角の大きさをあとで変えても原寸のまま、範囲の中心を保つ。
    // それ以外（拡大して合わせる）は範囲を四角いっぱいに引き伸ばす（縦横比が違えば中央で合わせる）
    function panelCrop(image, w, h) {
        if (image.mode !== "full") return fittedCrop(image.crop, w, h);
        const c = image.crop;
        return {x: c.x + c.w / 2 - w / 2, y: c.y + c.h / 2 - h / 2, w, h};
    }

    // 位置と大きさ（x, y, w, h）で持つ図形。直線は x1, y1, x2, y2
    const boxy = (s) => s.type === "rect" || s.type === "material" || s.type === "text" || s.type === "sfx";
    // 置いたあとは自由に動かせる（ページから一部はみ出してよい）図形
    const floating = (s) => s.type === "material" || s.type === "text" || s.type === "sfx";

    // ---------- 多角形のコマ（三角・台形・平行四辺形など） ----------
    // 四角（type "rect"）が頂点 pts [[x, y], ...]（3〜4 個）を持つと多角形になる。x, y, w, h はいつも頂点の外枠にそろえる。
    // 画像は外枠に合わせて置き、多角形の形で切り抜く。線は形の内側に描く（サーバーの _polygon_mask と同じ）
    const polyArea = (pts) => pts.reduce((a, p, i) => {
        const n = pts[(i + 1) % pts.length];
        return a + p[0] * n[1] - n[0] * p[1];
    }, 0) / 2;
    // 図形の頂点。頂点のない四角は左上から時計回りの 4 つ
    const cornersOf = (s) => s.pts ? s.pts.map((p) => [...p])
        : [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
    const pointsAttr = (pts) => pts.map((p) => p.join(",")).join(" ");
    function setPoints(s, pts) {
        s.pts = pts.map((p) => [round1(p[0]), round1(p[1])]);
        const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]);
        Object.assign(s, {x: Math.min(...xs), y: Math.min(...ys), w: round1(Math.max(...xs) - Math.min(...xs)), h: round1(Math.max(...ys) - Math.min(...ys))});
    }
    // 頂点 i の角度。内角と、つながる 2 本の辺の傾き（水平・垂直からのずれ）
    function vertexAngles(pts, i) {
        const p = pts[i], a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
        const deg = (v) => v * 180 / Math.PI;
        const tilt = (q) => {
            const t = Math.abs(deg(Math.atan2(q[1] - p[1], q[0] - p[0]))) % 90;
            return Math.min(t, 90 - t);
        };
        let inner = Math.abs(deg(Math.atan2(a[1] - p[1], a[0] - p[0]) - Math.atan2(b[1] - p[1], b[0] - p[0])));
        if (inner > 180) inner = 360 - inner;
        return {inner, tilts: [tilt(a), tilt(b)]};
    }
    let clipSeq = 0;

    // ---------- セリフ（文字）の組み方（サーバーの layout_text と同じ） ----------
    // 縦書きは 1 文字ずつ、文字の大きさの升目に並べる。右の行から左へ。改行で次の行。
    //   - 「ー」「（」「」」などは 90° 回して置く。「、」「。」は升目の右上に、小さい「っ」などは少し右上に寄せる
    //   - 半角の数字・!・? が 2 文字までのときは、横に並べて 1 升に入れる（縦中横）。升目に入らなければ縮める
    // 横書きは字形の幅で並べる。フチの太さの分だけ周りに余白を取る。
    // 図形の x, y, w, h は組んだときの枠で、表示と書き出しでは枠の中心に合わせて組み直す（フォントの読み込みで幅が少し変わっても位置がずれない）

    const TEXT_ROTATE = "ー－−–—―…‥～〜~（）()「」『』【】〔〕［］[]｛｝{}〈〉《》＜＞<>＝=-_｜|：:";
    const TEXT_CORNER = "、。，．､｡,.";
    const TEXT_SMALL = "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ";
    const TEXT_TCY = "0123456789!?";
    const TEXT_DEFAULT = {font: "", size: 36, vertical: true, lineHeight: 1.5, spacing: 0, color: "#000000", outline: 0, outlineColor: "#ffffff"};
    const TEXT_SIZE = [8, 1000];
    const TEXT_LINE = [1, 4];
    const TEXT_SPACING = [-0.5, 2];
    const OUTLINES = [0, 2, 4, 6, 8, 12, 16, 24];
    // フォント選びの絞り込み [キー, 表示, 説明]
    const FONT_FILTERS = [
        ["all", "すべて", "この PC のすべてのフォント"],
        ["added", "追加したフォント", "Windows の個人用のフォント（右クリック →「インストール」で入れたフォント）と、拡張フォルダの data/fonts/ のフォント。「すべてのユーザーに対してインストール」で入れたフォントは、Windows に最初からあるフォントと見分けられないので出ません（★ を付けてください）"],
        ["fav", "★ お気に入り", "★ を付けたフォント"],
        ["recent", "最近使った", "最近セリフに使ったフォント（新しい順）"],
    ];
    const FONT_RECENT_MAX = 12;
    const FONT_FAV_MAX = 1000;
    // 新しく置くセリフに使うフォント（一覧にあれば、この順に選ぶ）
    const FONT_PREFERRED = ["win:YuGothB.ttc#0", "win:YuGothM.ttc#0", "win:meiryo.ttc#0", "win:msgothic.ttc#0"];
    // オノマトペの最初のフォント（太いものから）
    const SFX_FONT_PREFERRED = ["win:HGRSGU.TTC#0", "win:YuGothB.ttc#0", "win:meiryob.ttc#0", ...FONT_PREFERRED];

    const fontFaces = new Map();    // フォントの id → ブラウザに読み込んだときの名前
    let measureCtx = null;

    // フォントの id を CSS の font-family にする。初めての id はサーバーからフォントのファイルを読み込み、読み込めたら描き直す
    function fontFamily(id) {
        if (!id) return "sans-serif";
        let family = fontFaces.get(id);
        if (!family) {
            family = "ps-font-" + fontFaces.size;
            fontFaces.set(id, family);
            const face = new FontFace(family, `url("polaris-studio/font?${new URLSearchParams({id})}")`);
            document.fonts.add(face);
            face.load().then(() => {
                if (ed) {
                    renderSlots();
                    render();
                }
                if (window.PolarisPages.onFontLoad) window.PolarisPages.onFontLoad();
            }).catch((err) => console.warn("[Polaris Studio] font load failed", id, err));
        }
        return `"${family}", sans-serif`;
    }

    function measure(text, size, family) {
        if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
        measureCtx.font = `${size}px ${family}`;
        return measureCtx.measureText(text).width;
    }

    function verticalCells(line) {
        const chars = [...line];
        const cells = [];
        for (let i = 0; i < chars.length;) {
            let j = i;
            while (j < chars.length && TEXT_TCY.includes(chars[j])) j++;
            if (j > i) {
                if (j - i <= 2) cells.push(chars.slice(i, j).join(""));
                else cells.push(...chars.slice(i, j));
                i = j;
            } else {
                cells.push(chars[i]);
                i++;
            }
        }
        return cells;
    }

    // {w, h, glyphs: [{t, x, y, size, rot}]}（x, y は字の中心。枠の左上から）
    function layoutText(s, family) {
        const size = s.size, pad = s.outline || 0;
        const lines = String(s.text || "").split("\n");
        const glyphs = [];
        let w, h;
        if (s.vertical) {
            const adv = size * (1 + s.spacing), pitch = size * s.lineHeight;
            w = pad * 2 + size + (lines.length - 1) * pitch;
            let longest = size;
            lines.forEach((line, i) => {
                const cx = w - pad - size / 2 - i * pitch;
                const cells = verticalCells(line);
                cells.forEach((t, j) => {
                    const cy = pad + size / 2 + j * adv;
                    const g = {t, x: cx, y: cy, size, rot: false};
                    if ([...t].length > 1) {
                        const tw = measure(t, size, family);
                        if (tw > size * 0.95) g.size = size * size * 0.95 / tw;
                    } else if (TEXT_ROTATE.includes(t)) {
                        g.rot = true;
                    } else if (TEXT_CORNER.includes(t)) {
                        g.x = cx + size * 0.5;
                        g.y = cy - size * 0.5;
                    } else if (TEXT_SMALL.includes(t)) {
                        g.x = cx + size * 0.08;
                        g.y = cy - size * 0.08;
                    }
                    glyphs.push(g);
                });
                if (cells.length) longest = Math.max(longest, size + (cells.length - 1) * adv);
            });
            h = pad * 2 + longest;
        } else {
            const pitch = size * s.lineHeight;
            let widest = size;
            lines.forEach((line, i) => {
                let cursor = 0;
                const cy = pad + size / 2 + i * pitch;
                [...line].forEach((ch, j) => {
                    const a = measure(ch, size, family);
                    if (j) cursor += s.spacing * size;
                    glyphs.push({t: ch, x: pad + cursor + a / 2, y: cy, size, rot: false});
                    cursor += a;
                });
                widest = Math.max(widest, cursor);
            });
            w = pad * 2 + widest;
            h = pad * 2 + size + (lines.length - 1) * pitch;
        }
        return {w, h, glyphs};
    }

    // 表示する枠（組み直した大きさを、図形の枠の中心に置く）
    function textBox(s) {
        const lay = layoutText(s, fontFamily(s.font));
        return {x: s.x + s.w / 2 - lay.w / 2, y: s.y + s.h / 2 - lay.h / 2, w: lay.w, h: lay.h, lay};
    }

    // 文字や書式を変えたら、枠の中心を保って枠を組み直す
    function fitText(s) {
        const b = textBox(s);
        Object.assign(s, {x: round1(b.x), y: round1(b.y), w: round1(b.w), h: round1(b.h)});
    }

    // フチは全部の字のフチを先に描いてから字を描く（隣の字のフチが字に掛からないように。サーバーと同じ）
    function drawText(parent, s, editing) {
        const family = fontFamily(s.font);
        const b = textBox(s);
        const g = svgEl("g", {transform: `translate(${b.x} ${b.y})`, "font-family": family});
        const add = (gl, attrs) => {
            const a = {x: gl.x, y: gl.y, "font-size": gl.size, "text-anchor": "middle", "dominant-baseline": "central", text: gl.t, ...attrs};
            if (gl.rot) a.transform = `rotate(90 ${gl.x} ${gl.y})`;
            g.appendChild(svgEl("text", a));
        };
        const glyphs = b.lay.glyphs.filter((gl) => gl.t.trim());
        if (s.outline) {
            for (const gl of glyphs) add(gl, {fill: s.outlineColor, stroke: s.outlineColor, "stroke-width": s.outline * 2, "stroke-linejoin": "round"});
        }
        for (const gl of glyphs) add(gl, {fill: s.color});
        // 入力中で字がないときも、置いた場所が分かるように
        if (editing && !glyphs.length) g.appendChild(svgEl("rect", {x: 0, y: 0, width: b.w, height: b.h, class: "ps-pg-ghost"}));
        parent.appendChild(g);
    }

    // ---------- フキダシ ----------
    // セリフとオノマトペに付ける。balloon = {pts: [[dx, dy], ...], stroke}。頂点は持ち主の枠の中心からのずれ（ページのピクセル）なので、
    // 持ち主を動かすとフキダシも一緒に動く。セリフは四角だけ（大きさは文字とは別に変えられる）、オノマトペは頂点を足して多角形にできる。
    // 白で塗り、黒い線（太さ stroke、線の真ん中が頂点を通る）で囲む。持ち主のすぐ下に描く（サーバーの書き出しも同じ）
    const BALLOON_STROKES = [2, 4, 6, 8, 12];
    const BALLOON_MAX = 20;
    const BALLOON_MIN = 3;
    const ownerCenter = (s) => ({x: s.x + s.w / 2, y: s.y + s.h / 2});

    function balloonPts(s) {
        const c = ownerCenter(s);
        return s.balloon.pts.map((p) => [c.x + p[0], c.y + p[1]]);
    }

    function setBalloonPts(s, abs) {
        const c = ownerCenter(s);
        s.balloon = {...s.balloon, pts: abs.map((p) => [round1(p[0] - c.x), round1(p[1] - c.y)])};
    }

    // 持ち主の枠を少し広げた四角を作る
    function newBalloon(s) {
        const b = s.type === "text" ? textBox(s) : s;
        const m = (s.type === "text" ? s.size : s.params.size) * 0.6;
        const hw = round1(b.w / 2 + m), hh = round1(b.h / 2 + m);
        return {pts: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], stroke: 4};
    }

    function drawBalloon(parent, s) {
        parent.appendChild(svgEl("polygon", {
            points: pointsAttr(balloonPts(s)), fill: "#fff", stroke: "#000", "stroke-width": s.balloon.stroke, "stroke-linejoin": "round",
        }));
    }

    // ---------- 手描き線 ----------
    // 始点（x1, y1）から終点（x2, y2）まで、手で引いたように揺れる線。形は太さ・揺れ・乱数の種（seed）で決まる。
    // 線の向きに細かく点を並べ、線と直角の向きにゆっくりした揺れと細かい揺れを足してつなぐ。両端は細くする（筆の入りと抜き）。
    // 書き出しにはオノマトペと同じく、ブラウザで描いた画像（name）を使う。x, y, w, h はその画像を置く枠（描くたびに合わせる）
    const HLINE_DEFAULT = {width: 12, wobble: 30, color: "#000000", outline: 0, outlineColor: "#ffffff"};
    const HLINE_WIDTH = [2, 200];
    const HLINE_WOBBLE = [0, 100];
    const HLINE_OUTLINES = [0, 2, 4, 6, 8, 12, 16];
    const HLINE_VERSION = 1;    // 描き方を変えたら上げる（書き出し用の画像を作り直す）

    function seededRng(seed) {
        let a = (seed >>> 0) || 1;
        return () => {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
        };
    }

    // 線の輪郭（多角形の頂点、ページのピクセル）
    function hlineOutline(s) {
        const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
        const len = Math.max(Math.hypot(dx, dy), 1);
        const ux = dx / len, uy = dy / len;
        const n = clamp(Math.round(len / 10), 16, 400);
        const rnd = seededRng(s.seed);
        const amp = (s.width * 0.8 + 6) * s.wobble / 50;
        // ゆっくりした揺れ：およそ 120 px ごとの点をなめらかにつなぐ
        const k = Math.max(2, Math.round(len / 120));
        const slow = Array.from({length: k + 1}, () => rnd());
        // 細かい揺れと太さのむら：点ごとの乱数を隣とならす
        const smooth = (arr) => arr.map((v, i) => (arr[Math.max(0, i - 1)] + v * 2 + arr[Math.min(arr.length - 1, i + 1)]) / 4);
        const fine = smooth(smooth(Array.from({length: n + 1}, () => rnd())));
        const thick = smooth(smooth(Array.from({length: n + 1}, () => rnd())));
        const centers = [], widths = [];
        for (let i = 0; i <= n; i++) {
            const t = i / n;
            const f = t * k, j = Math.min(Math.floor(f), k - 1), e = (1 - Math.cos(Math.PI * (f - j))) / 2;
            const off = amp * (0.75 * (slow[j] * (1 - e) + slow[j + 1] * e) + 0.35 * fine[i]);
            centers.push([s.x1 + dx * t - uy * off, s.y1 + dy * t + ux * off]);
            const taper = Math.pow(Math.min(1, t / 0.12), 0.6) * Math.pow(Math.min(1, (1 - t) / 0.22), 0.6);
            widths.push(s.width * Math.max(0.06, taper) * (1 + 0.18 * thick[i]));
        }
        const left = [], right = [];
        for (let i = 0; i <= n; i++) {
            const a = centers[Math.max(0, i - 1)], b = centers[Math.min(n, i + 1)];
            const tl = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-6);
            const nx = -(b[1] - a[1]) / tl, ny = (b[0] - a[0]) / tl;
            const h = widths[i] / 2;
            left.push([centers[i][0] + nx * h, centers[i][1] + ny * h]);
            right.push([centers[i][0] - nx * h, centers[i][1] - ny * h]);
        }
        return left.concat(right.reverse());
    }

    const fmt1 = (pts) => pts.map((p) => round1(p[0]) + "," + round1(p[1])).join(" ");

    // 線の SVG（フチがあれば、フチを先に太く描く）
    function hlineNodes(s) {
        const pts = fmt1(hlineOutline(s));
        const nodes = [];
        if (s.outline) {
            nodes.push(svgEl("polygon", {points: pts, fill: s.outlineColor, stroke: s.outlineColor, "stroke-width": s.outline * 2, "stroke-linejoin": "round"}));
        }
        nodes.push(svgEl("polygon", {points: pts, fill: s.color, stroke: s.color, "stroke-width": 0.6, "stroke-linejoin": "round"}));
        return nodes;
    }

    // 書き出し用の画像を置く枠（線の輪郭にフチと少しの余白を足した四角）
    function hlineBox(s) {
        const bb = boundsOf(hlineOutline(s));
        const m = (s.outline || 0) + 2;
        return {x: round1(bb.l - m), y: round1(bb.t - m), w: round1(bb.r - bb.l + m * 2), h: round1(bb.b - bb.t + m * 2)};
    }

    // 書き出し用の画像が今の形に合っているかを見るためのキー
    function hlineKey(s) {
        const text = HLINE_VERSION + JSON.stringify([s.x1, s.y1, s.x2, s.y2, s.width, s.wobble, s.color, s.outline, s.outlineColor, s.seed]);
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
        return (h >>> 0).toString(36) + text.length.toString(36);
    }

    // 手描き線の書式を範囲に収める（isColor はセリフの書式と共通）
    function cleanHlineStyle(o) {
        const num = (v, [lo, hi], d) => (typeof v === "number" && isFinite(v) ? clamp(Math.round(v), lo, hi) : d);
        return {
            width: num(o.width, HLINE_WIDTH, HLINE_DEFAULT.width),
            wobble: num(o.wobble, HLINE_WOBBLE, HLINE_DEFAULT.wobble),
            color: isColor(o.color) ? o.color.toLowerCase() : HLINE_DEFAULT.color,
            outline: HLINE_OUTLINES.includes(o.outline) ? o.outline : HLINE_DEFAULT.outline,
            outlineColor: isColor(o.outlineColor) ? o.outlineColor.toLowerCase() : HLINE_DEFAULT.outlineColor,
        };
    }

    const hlineStale = (s) => s.type === "hline" && (!s.name || s.key !== hlineKey(s));

    // 置いた大きさの 2 倍の PNG（Blob）にする。枠も一緒に返す
    async function rasterizeHline(s) {
        const box = hlineBox(s);
        const scale = Math.min(2, 8192 / box.w, 8192 / box.h);
        const w = Math.max(1, Math.round(box.w * scale)), h = Math.max(1, Math.round(box.h * scale));
        const g = svgEl("g", {transform: `translate(${-box.x} ${-box.y})`}, hlineNodes(s));
        const src = `<svg xmlns="${NS}" width="${w}" height="${h}" viewBox="0 0 ${box.w} ${box.h}">${g.outerHTML}</svg>`;
        const url = URL.createObjectURL(new Blob([src], {type: "image/svg+xml"}));
        try {
            const img = new Image();
            img.src = url;
            await img.decode();
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            const blob = await new Promise((ok, ng) => canvas.toBlob((b) => (b ? ok(b) : ng(new Error("PNG にできません"))), "image/png"));
            return {blob, box};
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // ページの手描き線のうち、書き出し用の画像が古いものを作り直す。変えたら true
    async function bakeHlines(pages, upload) {
        let changed = false;
        for (const page of pages) {
            for (const s of page.shapes || []) {
                if (!hlineStale(s)) continue;
                const key = hlineKey(s);
                const {blob, box} = await rasterizeHline(s);
                const saved = await upload(blob);
                // 作っている間に形が変わっていたら、次の機会に作り直す
                if (hlineKey(s) !== key) continue;
                Object.assign(s, box, {name: saved.name, key});
                changed = true;
            }
        }
        return changed;
    }

    // 頂点が 4 つで、辺が水平・垂直の四角か
    const isAxisRect = (pts) => pts.length === 4 && pts.every((p, i) => {
        const n = pts[(i + 1) % 4];
        return Math.abs(p[0] - n[0]) < 0.5 || Math.abs(p[1] - n[1]) < 0.5;
    });

    const boundsOf = (pts) => {
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        return {l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys)};
    };

    // 下を隠す四角が、実際に後ろを隠すか。画像も線もない四角（配置の目安の透明な四角）は何も隠さない
    const hides = (s) => s.type === "rect" && s.front && (s.image || s.stroke);

    // ページを g に描く。resolve(ref) は画像の URL（見つからなければ null）。editing では空の四角や線のない四角の目印も描く。
    // 重なりの描き方（サーバーの render_page と同じ）：
    //   1. 「下を隠す」でない四角の画像を、いちばん下にまとめて描く
    //   2. 図形の並び順（後ろほど手前）に、線と直線を描く。「下を隠す」四角はその位置で白地・画像・線をまとめて描き、
    //      それより奥のものを隠す。なので「下を隠す」でない四角どうしは両方の線が見え、隠す四角では手前の線だけが見える
    function drawPage(g, page, resolve, editing) {
        g.appendChild(svgEl("rect", {x: 0, y: 0, width: page.width, height: page.height, fill: "#fff"}));
        // 多角形のコマの形。fill などを付けて描くか、切り抜き（clipPath）に使う
        const outline = (s, attrs) => s.pts ? svgEl("polygon", {points: pointsAttr(s.pts), ...attrs})
            : svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, ...attrs});
        const clipOf = (s) => {
            const id = "ps-pg-clip-" + (++clipSeq);
            g.appendChild(svgEl("clipPath", {id}, [outline(s, {})]));
            return `url(#${id})`;
        };
        const content = (s) => {
            const url = s.image && resolve(s.image);
            if (url) {
                const c = panelCrop(s.image, s.w, s.h);
                const box = svgEl("svg", {x: s.x, y: s.y, width: s.w, height: s.h, viewBox: `${c.x} ${c.y} ${c.w} ${c.h}`, preserveAspectRatio: "none"}, [
                    svgEl("image", {href: url, width: s.image.iw, height: s.image.ih, preserveAspectRatio: "none"}),
                ]);
                g.appendChild(s.pts ? svgEl("g", {"clip-path": clipOf(s)}, [box]) : box);
            } else if (editing) {
                g.appendChild(outline(s, {class: "ps-pg-empty"}));
                // 三角では「＋ 画像」を重心に置き、小さめにする
                const center = s.pts ? [s.pts.reduce((a, p) => a + p[0], 0) / s.pts.length, s.pts.reduce((a, p) => a + p[1], 0) / s.pts.length]
                    : [s.x + s.w / 2, s.y + s.h / 2];
                const size = Math.min(s.w / 9, s.h / 3, Math.max(page.width, page.height) / 40) * (s.pts && s.pts.length === 3 ? 0.7 : 1);
                if (size >= 8) {
                    g.appendChild(svgEl("text", {
                        x: center[0], y: center[1], "font-size": size, class: "ps-pg-empty-text",
                        "text-anchor": "middle", "dominant-baseline": "middle",
                        text: s.image ? "画像が見つかりません" : "＋ 画像",
                    }));
                }
            }
        };
        for (const s of page.shapes) {
            if (s.type === "rect" && !s.front) content(s);
        }
        for (const s of page.shapes) {
            if (hides(s)) g.appendChild(outline(s, {fill: "#fff"}));
            if (s.type === "rect" && s.front) content(s);
            if (s.type === "rect" && s.stroke && s.pts) {
                // 倍の太さの線を形で切り抜き、内側の半分だけを見せる
                g.appendChild(svgEl("polygon", {
                    points: pointsAttr(s.pts), fill: "none", stroke: "#000", "stroke-width": s.stroke * 2,
                    "stroke-linejoin": "round", "clip-path": clipOf(s),
                }));
            } else if (s.type === "rect" && s.pts && editing) {
                g.appendChild(outline(s, {class: "ps-pg-ghost"}));
            } else if (s.type === "rect" && s.stroke) {
                g.appendChild(svgEl("rect", {
                    x: s.x + s.stroke / 2, y: s.y + s.stroke / 2,
                    width: Math.max(0, s.w - s.stroke), height: Math.max(0, s.h - s.stroke),
                    fill: "none", stroke: "#000", "stroke-width": s.stroke,
                }));
            } else if (s.type === "rect" && editing) {
                g.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, class: "ps-pg-ghost"}));
            } else if (s.type === "line") {
                g.appendChild(svgEl("line", {x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, stroke: "#000", "stroke-width": s.stroke}));
            }
        }
        // 3. 素材（吹き出し・集中線・小物など）は、コマと線の上の層に並び順に重ねる。ページからはみ出した所は切る
        // 4. セリフはいちばん上に、並び順に
        // オノマトペは素材と同じ層に、並び順に描く。字形がまだ届いていなければ、書き出し用の画像で代える
        const materials = page.shapes.filter((s) => s.type === "material" || s.type === "sfx" || s.type === "hline");
        const texts = page.shapes.filter((s) => s.type === "text");
        if (materials.length || texts.length) {
            const layer = svgEl("svg", {x: 0, y: 0, width: page.width, height: page.height, viewBox: `0 0 ${page.width} ${page.height}`, overflow: "hidden"});
            for (const s of materials) {
                if (s.type === "hline") {
                    for (const node of hlineNodes(s)) layer.appendChild(node);
                    continue;
                }
                if (s.balloon) drawBalloon(layer, s);
                const vector = s.type === "sfx" && window.PolarisSfx ? window.PolarisSfx.node(s) : null;
                if (vector) {
                    layer.appendChild(vector);
                    continue;
                }
                const url = s.name && resolve({material: s.name});
                if (url) layer.appendChild(svgEl("image", {href: url, x: s.x, y: s.y, width: s.w, height: s.h, preserveAspectRatio: "none"}));
                else if (editing) layer.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, class: "ps-pg-empty"}));
            }
            for (const s of texts) {
                if (s.balloon) drawBalloon(layer, s);
                drawText(layer, s, editing);
            }
            g.appendChild(layer);
        }
    }

    // Book の一覧に出す小さな絵
    function thumb(page, resolve) {
        const svg = svgEl("svg", {class: "ps-pg-thumb", viewBox: `0 0 ${page.width} ${page.height}`, preserveAspectRatio: "xMidYMid meet"});
        const g = svgEl("g");
        drawPage(g, page, resolve, false);
        svg.appendChild(g);
        return svg;
    }

    // ---------- 編集画面 ----------

    let view = null;
    let svg = null;
    let ed = null;      // {page, opts, tool, sel, undo, redo}
    let drag = null;
    // cropMode: 新しくはめ込むときの置き方。"cover" は拡大して合わせる、"full" は原寸
    // favOnly は画像選択の「お気に入りのみ」
    // count は編集画面に並べるコマページの枚数（1〜3）
    // text はこれから置くセリフの書式（最後に使った書式）
    // fontFavorites は ★ を付けたフォント、fontRecent は最近使ったフォント（新しい順）、fontFilter はフォント選びの絞り込み
    const prefs = {tool: "rect", line: 4, rect: 4, cropMode: "cover", favOnly: false, count: 1, text: {...TEXT_DEFAULT},
        fontFavorites: [], fontRecent: [], fontFilter: "all",
        // オノマトペ：パレットを開いているか、文字列のスタンプのフォント・大きさ、置くたびに形を変えるか
        sfxOpen: false, sfxFont: "", sfxSize: 140, sfxVary: true,
        // オノマトペの調整で、フォント別の見本の枠を開いているか
        sfxFontsOpen: false,
        // フォント別の見本の枠をピンで固定しているか（オノマトペを選んでいないときも出しておく）
        sfxFontsPinned: false,
        // これから引く手描き線の書式（最後に使った書式）
        hline: {...HLINE_DEFAULT}};
    const PAGE_COUNTS = [1, 2, 3];

    const q = (sel) => view.querySelector(sel);
    // キー操作は画面の土台（#mtm-fs）で受ける。押したボタンが隠れるとフォーカスが外れるので戻す
    const refocus = () => {
        const root = view.closest("[tabindex]");
        if (root) root.focus();
    };
    const shapeOf = (id) => ed.page.shapes.find((s) => s.id === id) || null;
    const selected = () => (ed.sel ? shapeOf(ed.sel) : null);
    const snapshot = () => JSON.stringify({width: ed.page.width, height: ed.page.height, shapes: ed.page.shapes});

    function loadPrefs() {
        try {
            const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
            if (["select", "line", "hline", "rect", "tri", "text"].includes(saved.tool)) prefs.tool = saved.tool;
            if (saved.hline && typeof saved.hline === "object") prefs.hline = cleanHlineStyle(saved.hline);
            if (saved.text && typeof saved.text === "object") prefs.text = cleanTextStyle(saved.text);
            const ids = (v, max) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && x))].slice(0, max) : []);
            prefs.fontFavorites = ids(saved.fontFavorites, FONT_FAV_MAX);
            prefs.fontRecent = ids(saved.fontRecent, FONT_RECENT_MAX);
            if (FONT_FILTERS.some(([key]) => key === saved.fontFilter)) prefs.fontFilter = saved.fontFilter;
            if (STROKES.includes(saved.line) && saved.line) prefs.line = saved.line;
            if (STROKES.includes(saved.rect)) prefs.rect = saved.rect;
            if (saved.cropMode === "full") prefs.cropMode = "full";
            if (saved.favOnly === true) prefs.favOnly = true;
            if (PAGE_COUNTS.includes(saved.count)) prefs.count = saved.count;
            prefs.sfxOpen = saved.sfxOpen === true;
            if (typeof saved.sfxFont === "string") prefs.sfxFont = saved.sfxFont;
            if (isNum(saved.sfxSize)) prefs.sfxSize = clamp(Math.round(saved.sfxSize), 8, 2000);
            prefs.sfxVary = saved.sfxVary !== false;
            prefs.sfxFontsOpen = saved.sfxFontsOpen === true;
            prefs.sfxFontsPinned = saved.sfxFontsPinned === true;
        } catch (e) { /* 覚えていなくても既定で使える */ }
    }

    function savePrefs() {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch (e) { /* 覚えられなくても使える */ }
    }

    function build(host) {
        loadPrefs();
        view = el("div", {class: "mtm-fs-window ps-page-view ps-off"});
        view.innerHTML = `
            <div class="mtm-fs-bar ps-pg-bar">
                <div class="ps-pg-bar-side">
                    <button type="button" class="mtm-btn ps-pg-back">← Book</button>
                    <span class="mtm-fs-title">コマページ</span>
                    <span class="mtm-fs-target ps-pg-where" title="キャンバスの上でホイールを回すか PageUp・PageDown で、Book の前後のコマページに移ります"></span>
                    <input type="text" class="ps-pg-name" placeholder="ページの名前" maxlength="40" title="編集中のコマページの名前（Book の一覧やコマの印に出ます）">
                    <span class="ps-pg-group ps-pg-counts" title="並べて表示するコマページの枚数。右から Book の順に並びます（漫画の見開きと同じ）。編集するのは枠の付いたページで、ほかのページはクリックすると編集できます">
                        <span class="ps-pg-label">表示</span>
                        ${PAGE_COUNTS.map((n) => `<button type="button" class="mtm-btn" data-count="${n}">${n} 枚</button>`).join("")}
                    </span>
                </div>
                <a href="#" class="ps-pg-project" title="コマページと Book の画面を閉じて、プロジェクトの画面に戻ります（編集した内容は保存済みです）"></a>
                <div class="ps-pg-bar-side ps-pg-bar-right">
                    <button type="button" class="mtm-btn ps-pg-undo" title="元に戻す (Ctrl+Z)">↶ 元に戻す</button>
                    <button type="button" class="mtm-btn ps-pg-redo" title="やり直す (Ctrl+Y)">↷ やり直す</button>
                </div>
            </div>
            <div class="ps-pg-tools">
                <div class="ps-pg-group">
                    <button type="button" class="mtm-btn" data-tool="select" title="選択・移動 (V)">選択</button>
                    <button type="button" class="mtm-btn" data-tool="line" title="直線 (L)">直線</button>
                    <button type="button" class="mtm-btn" data-tool="hline" title="手描き線 (W)。ドラッグで、手で引いたように揺れる線を引きます">手描き線</button>
                    <button type="button" class="mtm-btn" data-tool="rect" title="四角 (R)">四角</button>
                    <button type="button" class="mtm-btn" data-tool="tri" title="三角 (Y)">三角</button>
                    <button type="button" class="mtm-btn" data-tool="text" title="セリフ (T)。クリックした所に文字を置きます">セリフ</button>
                </div>
                <div class="ps-pg-group ps-pg-strokes">
                    <span class="ps-pg-label">線の太さ</span>
                    ${STROKES.map((w) => `<button type="button" class="mtm-btn" data-stroke="${w}" title="${w ? w + " px" : "線なし（透明な四角）"}">${w || "なし"}</button>`).join("")}
                </div>
                <button type="button" class="mtm-btn ps-pg-pick" title="選んだ四角にはめ込む画像を選びます">画像を選ぶ</button>
                <div class="ps-pg-group">
                    <button type="button" class="mtm-btn ps-pg-vertex-mode" title="コマの角（頂点）を 1 つずつ動かして、台形・平行四辺形・三角の形を変えます。Shift を押しながらドラッグで元の位置から水平・垂直だけに動かし、矢印キーで最後に触った頂点を 1 px（Shift で 10 px）ずつ動かします (E)">頂点を編集</button>
                    <button type="button" class="mtm-btn ps-pg-squarify" title="頂点を動かしたコマを、今の外枠の四角に戻します">四角に戻す</button>
                </div>
                <span class="ps-pg-vinfo"></span>
                <div class="ps-pg-group">
                    <button type="button" class="mtm-btn ps-pg-front" title="重なったとき、このコマで後ろのコマ（画像と線）を隠します。オフなら両方の線を描きます (H)">下を隠す</button>
                    <button type="button" class="mtm-btn ps-pg-raise" title="いちばん手前に出します (])">前面へ</button>
                    <button type="button" class="mtm-btn ps-pg-lower" title="いちばん奥に下げます ([)">背面へ</button>
                </div>
                <button type="button" class="mtm-btn ps-pg-material" title="吹き出し・集中線・小物などの画像を素材として置きます。素材はコマと線の上に重なります。画像ファイルをキャンバスにドロップするか、Ctrl+V で貼り付けても置けます">＋ 素材</button>
                <input type="file" class="ps-pg-material-file ps-off" accept="image/*" multiple>
                <button type="button" class="mtm-btn ps-pg-sfx-toggle" title="オノマトペ（効果音・擬音）のパレットを開く・閉じる (O)">オノマトペ</button>
                <button type="button" class="mtm-btn mtm-danger ps-pg-delete" title="選んだ図形を削除します (Delete)">削除</button>
                <span class="mtm-fs-spacer"></span>
                <label class="ps-pg-size">キャンバス
                    <input type="number" class="ps-pg-w" min="${PAGE_MIN}" max="${PAGE_MAX}" step="1"> ×
                    <input type="number" class="ps-pg-h" min="${PAGE_MIN}" max="${PAGE_MAX}" step="1">
                </label>
                <button type="button" class="mtm-btn ps-pg-resize" title="キャンバスの大きさを変えます。置いた図形はそのままの位置に残ります">変更</button>
            </div>
            <div class="ps-pg-tools ps-pg-textbar ps-off" title="選んだセリフ（なければ、これから置くセリフ）の書式">
                <span class="ps-pg-label">セリフ</span>
                <button type="button" class="mtm-btn ps-pg-font" title="フォントを選びます。この PC に入っているフォントを使えます（書き出しにも同じ字形で入ります）"></button>
                <label class="ps-pg-size">大きさ <input type="number" class="ps-pg-tsize" min="${TEXT_SIZE[0]}" max="${TEXT_SIZE[1]}" step="1" title="文字の大きさ（ページのピクセル）"></label>
                <span class="ps-pg-group">
                    <button type="button" class="mtm-btn" data-dir="v" title="縦書き">縦書き</button>
                    <button type="button" class="mtm-btn" data-dir="h" title="横書き">横書き</button>
                </span>
                <label class="ps-pg-size">行間 <input type="number" class="ps-pg-tline" min="${TEXT_LINE[0]}" max="${TEXT_LINE[1]}" step="0.1" title="行の送り（文字の大きさの何倍か）"></label>
                <label class="ps-pg-size">字間 <input type="number" class="ps-pg-tspace" min="${TEXT_SPACING[0]}" max="${TEXT_SPACING[1]}" step="0.05" title="字と字の間（文字の大きさに対する割合。0 で詰めずに並べる）"></label>
                <label class="ps-pg-size">色 <input type="color" class="ps-pg-tcolor" title="文字の色"></label>
                <label class="ps-pg-size">フチ
                    <select class="ps-pg-toutline" title="文字のフチの太さ（ピクセル）。絵の上に直接置く文字に">${OUTLINES.map((w) => `<option value="${w}">${w ? w + " px" : "なし"}</option>`).join("")}</select>
                    <input type="color" class="ps-pg-toutcolor" title="フチの色">
                </label>
                <span class="ps-pg-group ps-pg-tballoon">
                    <button type="button" class="mtm-btn ps-pg-balloon-toggle" title="選んだセリフに四角い吹き出しを付ける・外す (B)。吹き出しの大きさは、菱形のつまみで文字とは別に変えられます">□ 吹き出し</button>
                    <select class="ps-pg-balloon-stroke" title="吹き出しの線の太さ">${BALLOON_STROKES.map((w) => `<option value="${w}">線 ${w} px</option>`).join("")}</select>
                </span>
            </div>
            <div class="ps-pg-tools ps-pg-hlinebar ps-off" title="選んだ手描き線（なければ、これから引く線）の書式">
                <span class="ps-pg-label">手描き線</span>
                <label class="ps-pg-size">太さ <input type="number" class="ps-pg-hwidth" min="${HLINE_WIDTH[0]}" max="${HLINE_WIDTH[1]}" step="1" title="線のいちばん太い所の太さ（ページのピクセル）"></label>
                <label class="ps-pg-size">揺れ <input type="range" class="ps-pg-hwobble" min="${HLINE_WOBBLE[0]}" max="${HLINE_WOBBLE[1]}" step="1" title="手振れの大きさ（0 でまっすぐ）"></label>
                <label class="ps-pg-size">色 <input type="color" class="ps-pg-hcolor" title="線の色"></label>
                <label class="ps-pg-size">フチ
                    <select class="ps-pg-houtline" title="線のフチの太さ（ピクセル）">${HLINE_OUTLINES.map((w) => `<option value="${w}">${w ? w + " px" : "なし"}</option>`).join("")}</select>
                    <input type="color" class="ps-pg-houtcolor" title="フチの色">
                </label>
                <button type="button" class="mtm-btn ps-pg-hreroll" title="同じ設定のまま、別の揺れ方にします (G)">🎲 別の揺れ</button>
            </div>
            <div class="ps-pg-fontpicker ps-off">
                <div class="ps-pg-fontpicker-head">
                    <input type="search" class="ps-pg-fontsearch" placeholder="名前で検索（↑↓ で試す、Enter で決める、Esc で戻す）" title="↑↓ キーでフォントを順に試せます（選んだオノマトペやセリフにすぐ当たります）。Enter で決め、Esc で試す前のフォントに戻します。検索のあとすぐ Enter なら一番上を選びます">
                    <button type="button" class="mtm-icon ps-pg-fontpicker-close" title="閉じる (Esc)">✕</button>
                </div>
                <div class="ps-pg-group ps-pg-fontfilters">
                    ${FONT_FILTERS.map(([key, label, title]) => `<button type="button" class="mtm-btn" data-font-filter="${key}" title="${title}">${label}</button>`).join("")}
                    <span class="ps-pg-fontcount"></span>
                </div>
                <div class="ps-pg-fontlist"></div>
            </div>
            <div class="ps-pg-hint"></div>
            <div class="ps-pg-textedit ps-off">
                <textarea class="ps-pg-textarea" rows="3" placeholder="セリフを入力（改行で次の行）。Ctrl+Enter で決定、Esc で取り消し"></textarea>
                <div class="ps-pg-textedit-actions">
                    <button type="button" class="mtm-btn ps-pg-text-cancel">キャンセル</button>
                    <button type="button" class="mtm-btn mtm-primary ps-pg-text-ok">決定</button>
                </div>
            </div>
            <div class="ps-pg-body">
                <div class="ps-pg-stage"></div>
                <div class="ps-pg-fontside ps-off">
                    <div class="ps-pg-sfx-head">
                        <span>フォント別の見え方</span>
                        <span class="ps-pg-fontside-count"></span>
                        <span class="mtm-fs-spacer"></span>
                        <button type="button" class="mtm-btn ps-pg-sfx-fonts-restore" title="外したフォントを一覧に戻します"></button>
                        <button type="button" class="mtm-icon ps-pg-fontside-pin" title="ピンで固定：オノマトペを選んでいないときも枠を出したままにします（ページの位置が動かなくなります）">📌</button>
                        <button type="button" class="mtm-icon ps-pg-fontside-close" title="閉じる">✕</button>
                    </div>
                    <div class="ps-pg-fontside-note">★ を付けた・追加した・最近使ったフォントで、今の形を描いた見本です。押すとそのフォントに、＋ で調整済みスタンプに登録、✕ で一覧から外します（編集画面を閉じると戻ります）。</div>
                    <div class="ps-pg-sfx-fonts-grid"></div>
                </div>
                <div class="ps-pg-sfx ps-off">
                    <div class="ps-pg-sfx-head">
                        <span class="ps-pg-sfx-title">オノマトペ</span>
                        <span class="mtm-fs-spacer"></span>
                        <button type="button" class="mtm-icon ps-pg-sfx-close" title="パレットを閉じる (O)">✕</button>
                    </div>
                    <div class="ps-pg-sfx-scroll">
                        <div class="ps-pg-sfx-palette">
                            <div class="ps-pg-sfx-label">文字列のスタンプ <span class="ps-pg-sfx-note">フォントと大きさ</span></div>
                            <div class="ps-pg-sfx-row">
                                <button type="button" class="mtm-btn ps-pg-sfx-font" data-font-target="sfx-new" title="文字列のスタンプに使うフォント"></button>
                                <label title="文字列のスタンプの字の大きさ（ページのピクセル）">大きさ <input type="number" class="ps-pg-sfx-newsize" min="8" max="2000" step="1"></label>
                            </div>
                            <label class="ps-pg-sfx-check" title="オフにすると、同じスタンプは同じ形で置きます"><input type="checkbox" class="ps-pg-sfx-vary"> 置くたびに形を変える（ゆらぎ）</label>
                            <div class="ps-pg-sfx-label">文字列
                                <span class="mtm-fs-spacer"></span>
                                <button type="button" class="mtm-btn ps-pg-sfx-edit" title="文字列をまとめて編集します（1 行に 1 つ）">編集</button>
                            </div>
                            <div class="ps-pg-sfx-wordedit ps-off">
                                <textarea class="ps-pg-sfx-textarea" rows="10" spellcheck="false" placeholder="1 行に 1 つ。例：&#10;ドン!!&#10;ゴゴゴ&#10;ザッ"></textarea>
                                <div class="ps-pg-sfx-row">
                                    <span class="mtm-fs-spacer"></span>
                                    <button type="button" class="mtm-btn ps-pg-sfx-edit-cancel">キャンセル</button>
                                    <button type="button" class="mtm-btn mtm-primary ps-pg-sfx-edit-ok" title="Ctrl+Enter">保存</button>
                                </div>
                            </div>
                            <div class="ps-pg-sfx-words"></div>
                            <div class="ps-pg-sfx-label">調整済みスタンプ</div>
                            <div class="ps-pg-sfx-stamps"></div>
                        </div>
                        <div class="ps-pg-sfx-detail ps-off"></div>
                    </div>
                </div>
            </div>
            <div class="ps-pg-crop ps-off">
                <div class="ps-pg-crop-box">
                    <div class="ps-pg-crop-head">
                        <button type="button" class="mtm-btn ps-pg-pick-back ps-off" title="カット案の一覧に戻る (Esc)">← カット案</button>
                        <span class="ps-pg-crop-title"></span>
                        <span class="ps-pg-crop-info"></span>
                        <span class="mtm-fs-spacer"></span>
                        <button type="button" class="mtm-btn ps-pg-pick-link ps-off"></button>
                        <label class="ps-fav-only ps-pg-favonly ps-off" title="お気に入り（♥）にした画像だけを出します。カット案の一覧では、お気に入りのあるカット案だけを出します"><input type="checkbox" class="ps-pg-favonly-check"> ♥ お気に入りのみ</label>
                        <span class="ps-pg-group ps-pg-cropmode ps-off">
                            <button type="button" class="mtm-btn" data-mode="cover" title="選んだ範囲をコマいっぱいに拡大・縮小します">拡大して合わせる</button>
                            <button type="button" class="mtm-btn" data-mode="full" title="画像を原寸のまま置きます。コマが画像より大きければ、残りは白い余白になります">原寸</button>
                        </span>
                    </div>
                    <div class="ps-pg-pickgrid"></div>
                    <div class="ps-pg-cropstage ps-off">
                        <div class="ps-pg-croppaper"></div>
                        <img class="ps-pg-cropimg" alt="" draggable="false">
                        <div class="ps-pg-frame">
                            ${["nw", "ne", "se", "sw"].map((c) => `<span class="ps-pg-fh ps-pg-fh-${c}" data-corner="${c}"></span>`).join("")}
                        </div>
                    </div>
                    <div class="mtm-form-actions">
                        <span class="mtm-hint ps-pg-crop-note"></span>
                        <button type="button" class="mtm-btn ps-pg-crop-remove">はめ込みを外す</button>
                        <button type="button" class="mtm-btn ps-pg-crop-repick">画像を選び直す</button>
                        <button type="button" class="mtm-btn ps-pg-crop-cancel">キャンセル</button>
                        <button type="button" class="mtm-btn mtm-primary ps-pg-crop-ok">決定</button>
                    </div>
                </div>
            </div>
        `;
        host.appendChild(view);
        svg = svgEl("svg", {class: "ps-pg-svg"});
        q(".ps-pg-stage").appendChild(svg);

        q(".ps-pg-back").addEventListener("click", close);
        // 個別プロジェクトの画面へ戻る。Book の画面も飛ばして戻る（変更は図形を触るたびに保存している）
        q(".ps-pg-project").addEventListener("click", (e) => {
            e.preventDefault();
            if (!ed) return;
            const toProject = ed.opts.onProject;
            close();
            if (toProject) toProject();
        });
        // コマページの名前。決めたら（Enter か外を押す）保存する。並べて表示している枠の番号にも出す
        const nameInput = q(".ps-pg-name");
        nameInput.addEventListener("change", () => {
            if (!ed) return;
            const name = nameInput.value.trim();
            if (name === (ed.page.name || "")) return;
            if (name) ed.page.name = name;
            else delete ed.page.name;
            renderSlots();
            render();
            ed.opts.onChange();
        });
        nameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) nameInput.blur();
        });
        q(".ps-pg-undo").addEventListener("click", undo);
        q(".ps-pg-redo").addEventListener("click", redo);
        view.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
        view.querySelectorAll("[data-stroke]").forEach((b) => b.addEventListener("click", () => setStroke(Number(b.dataset.stroke))));
        view.querySelectorAll("[data-count]").forEach((b) => b.addEventListener("click", () => setCount(Number(b.dataset.count))));
        q(".ps-pg-pick").addEventListener("click", () => {
            const s = selected();
            if (s && s.type === "rect") openPicker(s);
        });
        q(".ps-pg-delete").addEventListener("click", deleteSelected);
        q(".ps-pg-vertex-mode").addEventListener("click", toggleVertexMode);
        q(".ps-pg-squarify").addEventListener("click", squarify);
        q(".ps-pg-front").addEventListener("click", toggleFront);
        q(".ps-pg-raise").addEventListener("click", () => reorder(true));
        q(".ps-pg-lower").addEventListener("click", () => reorder(false));
        q(".ps-pg-resize").addEventListener("click", resizeCanvas);
        for (const sel of [".ps-pg-w", ".ps-pg-h"]) {
            q(sel).addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.isComposing) resizeCanvas();
            });
        }
        svg.addEventListener("pointerdown", pointerDown);
        // スタンプモードの右クリックはスタンプに使うので、メニューを出さない
        svg.addEventListener("contextmenu", (e) => {
            if (ed && prefs.tool === "sfx") e.preventDefault();
        });
        svg.addEventListener("pointermove", pointerMove);
        svg.addEventListener("pointerup", pointerUp);
        svg.addEventListener("pointercancel", () => {
            if (drag) cancelDrag();
        });
        svg.addEventListener("dblclick", (e) => {
            if (!ed || prefs.tool !== "select") return;
            // フキダシの頂点のダブルクリックは pointerDown で見分ける
            if (e.target.closest('[data-handle^="b"]')) return;
            const hit = e.target.closest("[data-id]");
            const s = hit && shapeOf(hit.dataset.id);
            if (s && s.type === "rect") openPicker(s);
            if (s && s.type === "text" && !textEdit) startTextEdit(s, null);
        });
        new ResizeObserver(() => {
            if (ed) render();
        }).observe(q(".ps-pg-stage"));
        // ホイールで Book の前後のコマページへ移る（下・右へ回すと次）。Ctrl を押しているときはブラウザの拡大に任せる
        q(".ps-pg-stage").addEventListener("wheel", (e) => {
            if (!ed || e.ctrlKey) return;
            e.preventDefault();
            wheelPage(e);
        }, {passive: false});
        buildMaterials();
        buildText();
        buildSfx();
        buildCrop();
    }

    // ---------- セリフの編集 ----------
    // 「セリフ」の道具でクリックした所に置き、上の入力欄で文字を入れる。入力中はその場で描き直し、決定で 1 回の変更として保存する

    let fontList = null;        // [{id, name, style}]。読み込み前は null
    let fontsLoading = false;
    let textEdit = null;        // 入力中のセリフ {id, before}

    const isNum = (v) => typeof v === "number" && Number.isFinite(v);
    const isColor = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

    function cleanTextStyle(t) {
        const d = TEXT_DEFAULT;
        return {
            font: typeof t.font === "string" ? t.font : d.font,
            size: isNum(t.size) ? clamp(t.size, ...TEXT_SIZE) : d.size,
            vertical: t.vertical !== false,
            lineHeight: isNum(t.lineHeight) ? clamp(t.lineHeight, ...TEXT_LINE) : d.lineHeight,
            spacing: isNum(t.spacing) ? clamp(t.spacing, ...TEXT_SPACING) : d.spacing,
            color: isColor(t.color) ? t.color.toLowerCase() : d.color,
            outline: OUTLINES.includes(t.outline) ? t.outline : d.outline,
            outlineColor: isColor(t.outlineColor) ? t.outlineColor.toLowerCase() : d.outlineColor,
        };
    }

    // フォントの一覧は最初に編集画面を開いたときに 1 回だけ読む
    async function loadFonts() {
        if (fontList || fontsLoading) return;
        fontsLoading = true;
        try {
            const res = await fetch("polaris-studio/fonts");
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || res.status);
            fontList = data.fonts;
        } catch (err) {
            console.warn("[Polaris Studio] font list failed", err);
            fontList = [];
        }
        fontsLoading = false;
        const ids = new Set(fontList.map((f) => f.id));
        if (!ids.has(prefs.text.font)) {
            prefs.text.font = FONT_PREFERRED.find((id) => ids.has(id)) || (fontList[0] ? fontList[0].id : "");
            savePrefs();
        }
        if (!ids.has(prefs.sfxFont)) {
            prefs.sfxFont = SFX_FONT_PREFERRED.find((id) => ids.has(id)) || prefs.text.font;
            savePrefs();
        }
        if (ed) updateTools();
        renderSfxPalette();
        if (isFontPickerOpen()) renderFontList();
    }

    // ---------- フォント選び ----------
    // 名前の検索と、すべて・追加したフォント・★ お気に入り・最近使った の絞り込み。それぞれのフォントで描いた見本を出す
    // （見本はサーバーが作る画像で、一覧で見えている分だけ読み込む）

    const fontOf = (id) => (fontList || []).find((f) => f.id === id) || null;
    const isFontPickerOpen = () => view && !q(".ps-pg-fontpicker").classList.contains("ps-off");

    function fontLabel(f) {
        const style = f.style && !/^(regular|normal|標準)$/i.test(f.style) ? " " + f.style : "";
        return f.name + style;
    }

    function fontName(id) {
        if (!fontList) return "フォントを読み込み中…";
        const f = fontOf(id);
        return f ? fontLabel(f) : id ? "（見つからないフォント）" : "（既定のフォント）";
    }

    function buildFontPicker() {
        const picker = q(".ps-pg-fontpicker");
        q(".ps-pg-font").addEventListener("click", (e) => (isFontPickerOpen() ? closeFontPicker() : openFontPicker(e.currentTarget, "text")));
        q(".ps-pg-fontpicker-close").addEventListener("click", closeFontPicker);
        q(".ps-pg-fontsearch").addEventListener("input", () => {
            fontCursor = false;
            renderFontList();
        });
        q(".ps-pg-fontsearch").addEventListener("keydown", (e) => {
            if (e.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                stepFont(e.key === "ArrowDown" ? 1 : -1);
                return;
            }
            if (e.key !== "Enter") return;
            e.preventDefault();
            // 上下キーで選んでいたら、それで決める。でなければ一番上
            if (fontCursor) {
                closeFontPicker();
                return;
            }
            const first = q(".ps-pg-fontlist [data-font]");
            if (first) pickFont(first.dataset.font);
        });
        view.querySelectorAll("[data-font-filter]").forEach((b) => b.addEventListener("click", () => {
            prefs.fontFilter = b.dataset.fontFilter;
            savePrefs();
            renderFontList();
            q(".ps-pg-fontsearch").focus();
        }));
        // 外を押したら閉じる
        view.addEventListener("mousedown", (e) => {
            if (isFontPickerOpen() && !picker.contains(e.target) && !e.target.closest(".ps-pg-font, [data-font-target]")) closeFontPicker();
        }, true);
    }

    // target はフォントを決める先。"text"（セリフ）、"sfx-new"（文字列のスタンプ）、"sfx"（選んだオノマトペ）
    let fontTarget = "text";

    // 上下キーでフォントを次々に試す。試している間は描き直すだけにし、閉じたときに 1 回の変更にする（元に戻すで、試す前に戻る）
    let fontCursor = false;     // 検索のあとに上下キーで選んだか（Enter でそれに決める）
    let fontBrowse = null;      // {before（試す前のページ）, orig（試す前のフォント）, id（いま試しているフォント）}

    function stepFont(dir) {
        const buttons = [...view.querySelectorAll(".ps-pg-fontlist [data-font]")];
        if (!buttons.length) return;
        const cur = currentFont();
        const at = buttons.findIndex((b) => b.dataset.font === cur);
        const next = at < 0 ? (dir > 0 ? 0 : buttons.length - 1) : clamp(at + dir, 0, buttons.length - 1);
        const id = buttons[next].dataset.font;
        fontCursor = true;
        if (id !== cur) tryFont(id);
        view.querySelectorAll(".ps-pg-fontrow").forEach((r) => r.classList.toggle("ps-on", !!r.querySelector(`[data-font="${CSS.escape(id)}"]`)));
        buttons[next].closest(".ps-pg-fontrow").scrollIntoView({block: "nearest"});
    }

    function tryFont(id) {
        if (!fontBrowse) {
            fontBrowse = {before: textEdit || fontTarget === "sfx-new" ? null : snapshot(), orig: currentFont(), id};
        }
        fontBrowse.id = id;
        applyFontLive(id);
    }

    // 変更として残さずにフォントを当てる
    function applyFontLive(id) {
        const s = selected();
        if (fontTarget === "sfx-new") {
            prefs.sfxFont = id;
            savePrefs();
            renderSfxPalette();
        } else if (fontTarget === "sfx") {
            if (!s || s.type !== "sfx") return;
            s.params.font = id;
            s.params = SFX().clean(s.params);
            if (!SFX().fit(s)) sfxPending.add(s.id);
            render();
        } else {
            prefs.text.font = id;
            savePrefs();
            if (s && s.type === "text") {
                s.font = id;
                fitText(s);
                render();
            } else {
                updateTools();
            }
        }
    }

    // 試していたフォントを決める（keep）か、試す前に戻す
    function finishFontBrowse(keep) {
        const b = fontBrowse;
        fontBrowse = null;
        fontCursor = false;
        if (!b) return;
        if (!keep) applyFontLive(b.orig);
        else useFont(b.id);
        if (b.before && snapshot() !== b.before) {
            pushUndo(b.before);
            commit();
        } else if (ed) {
            render();
        }
    }

    function openFontPicker(anchor, target) {
        finishFontBrowse(true);
        loadFonts();
        fontTarget = target;
        fontCursor = false;
        const picker = q(".ps-pg-fontpicker");
        const r = anchor.getBoundingClientRect();
        picker.classList.remove("ps-off");
        // ボタンの下に出す。画面の右や下からはみ出すときは寄せる
        const w = picker.offsetWidth, h = picker.offsetHeight;
        picker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
        picker.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - h - 8)) + "px";
        renderFontList();
        const search = q(".ps-pg-fontsearch");
        search.focus();
        search.select();
    }

    // keep が false なら（Esc）、上下キーで試していたフォントを試す前に戻す
    function closeFontPicker(keep) {
        if (!view || !isFontPickerOpen()) return;
        finishFontBrowse(keep !== false);
        q(".ps-pg-fontpicker").classList.add("ps-off");
        if (textEdit) q(".ps-pg-textarea").focus();
        else refocus();
    }

    // いま書式を見ているセリフ（選んでいるセリフ、なければこれから置くセリフ）のフォント
    function currentFont() {
        const s = ed && selected();
        if (fontTarget === "sfx-new") return prefs.sfxFont;
        if (fontTarget === "sfx") return s && s.type === "sfx" ? s.params.font : "";
        return s && s.type === "text" ? s.font : prefs.text.font;
    }

    function renderFontList() {
        const box = q(".ps-pg-fontlist");
        const filter = prefs.fontFilter;
        view.querySelectorAll("[data-font-filter]").forEach((b) => b.classList.toggle("mtm-active", b.dataset.fontFilter === filter));
        box.textContent = "";
        if (!fontList) {
            q(".ps-pg-fontcount").textContent = "";
            box.appendChild(el("div", {class: "mtm-empty", text: "フォントを読み込み中…"}));
            return;
        }
        const favs = new Set(prefs.fontFavorites);
        let list = fontList;
        if (filter === "added") list = list.filter((f) => f.added);
        else if (filter === "fav") list = list.filter((f) => favs.has(f.id));
        else if (filter === "recent") list = prefs.fontRecent.map(fontOf).filter(Boolean);
        const words = q(".ps-pg-fontsearch").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length) {
            list = list.filter((f) => {
                const hay = `${f.name} ${f.style} ${f.id}`.toLowerCase();
                return words.every((w) => hay.includes(w));
            });
        }
        q(".ps-pg-fontcount").textContent = `${list.length} 個`;
        if (!list.length) {
            const empty = words.length ? "名前に合うフォントがありません。"
                : {
                    added: "追加したフォントがありません。フォントのファイルを右クリック →「インストール」で入れるか、拡張フォルダの data/fonts/ に置くと出ます（reForge の再起動が必要です）。",
                    fav: "★ を付けたフォントがありません。一覧の ☆ を押すと付けられます。",
                    recent: "まだセリフにフォントを使っていません。",
                }[filter] || "フォントが見つかりません。";
            box.appendChild(el("div", {class: "mtm-empty", text: empty}));
            return;
        }
        const current = currentFont();
        let focus = null;
        for (const f of list) {
            const fav = favs.has(f.id);
            const row = el("div", {class: "ps-pg-fontrow" + (f.id === current ? " ps-on" : "")}, [
                el("button", {
                    type: "button", class: "mtm-icon ps-pg-fontstar" + (fav ? " ps-on" : ""), text: fav ? "★" : "☆",
                    title: fav ? "★ を外す" : "★ お気に入りにする", onclick: () => toggleFontFavorite(f.id),
                }),
                el("button", {type: "button", class: "ps-pg-fontpick", "data-font": f.id, title: f.id, onclick: () => pickFont(f.id)}, [
                    el("span", {class: "ps-pg-fontname", text: fontLabel(f)}, f.added ? [el("span", {class: "ps-pg-fontadded", text: "追加", title: "自分で追加したフォント"})] : []),
                    // 読めないフォントは見本を出さない
                    el("img", {class: "ps-pg-fontsample", src: "polaris-studio/font-sample?" + new URLSearchParams({id: f.id}), alt: "", loading: "lazy", draggable: "false",
                        onerror: (e) => e.target.remove()}),
                ]),
            ]);
            if (f.id === current) focus = row;
            box.appendChild(row);
        }
        if (focus) focus.scrollIntoView({block: "nearest"});
    }

    function toggleFontFavorite(id) {
        const list = prefs.fontFavorites.filter((x) => x !== id);
        if (list.length === prefs.fontFavorites.length) list.unshift(id);
        prefs.fontFavorites = list.slice(0, FONT_FAV_MAX);
        savePrefs();
        const scroll = q(".ps-pg-fontlist").scrollTop;
        renderFontList();
        q(".ps-pg-fontlist").scrollTop = scroll;
    }

    function useFont(id) {
        if (!id) return;
        prefs.fontRecent = [id, ...prefs.fontRecent.filter((x) => x !== id)].slice(0, FONT_RECENT_MAX);
        savePrefs();
    }

    function pickFont(id) {
        useFont(id);
        closeFontPicker();
        if (fontTarget === "sfx-new") {
            prefs.sfxFont = id;
            savePrefs();
            renderSfxPalette();
        } else if (fontTarget === "sfx") {
            editSfx((p) => (p.font = id), true);
        } else {
            setTextStyle("font", id);
        }
    }

    function buildText() {
        const ta = q(".ps-pg-textarea");
        ta.addEventListener("input", () => {
            const s = textEdit && shapeOf(textEdit.id);
            if (!s) return;
            s.text = ta.value;
            fitText(s);
            render();
        });
        q(".ps-pg-text-ok").addEventListener("click", () => finishTextEdit(true));
        q(".ps-pg-text-cancel").addEventListener("click", () => finishTextEdit(false));
        const num = (sel, key, range) => q(sel).addEventListener("change", (e) => {
            const v = Number(e.target.value);
            if (e.target.value === "" || !Number.isFinite(v)) {
                updateTools();
                return;
            }
            setTextStyle(key, clamp(Math.round(v * 100) / 100, ...range));
        });
        num(".ps-pg-tsize", "size", TEXT_SIZE);
        num(".ps-pg-tline", "lineHeight", TEXT_LINE);
        num(".ps-pg-tspace", "spacing", TEXT_SPACING);
        buildFontPicker();
        q(".ps-pg-toutline").addEventListener("change", (e) => setTextStyle("outline", Number(e.target.value)));
        q(".ps-pg-tcolor").addEventListener("change", (e) => setTextStyle("color", e.target.value.toLowerCase()));
        q(".ps-pg-toutcolor").addEventListener("change", (e) => setTextStyle("outlineColor", e.target.value.toLowerCase()));
        view.querySelectorAll("[data-dir]").forEach((b) => b.addEventListener("click", () => setTextStyle("vertical", b.dataset.dir === "v")));
        // 手描き線の書式
        const hnum = (sel, key, range) => q(sel).addEventListener("change", (e) => {
            const v = Number(e.target.value);
            if (e.target.value === "" || !Number.isFinite(v)) {
                updateTools();
                return;
            }
            setHlineStyle(key, clamp(Math.round(v), ...range));
        });
        hnum(".ps-pg-hwidth", "width", HLINE_WIDTH);
        hnum(".ps-pg-hwobble", "wobble", HLINE_WOBBLE);
        q(".ps-pg-hwidth").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) e.target.blur();
        });
        q(".ps-pg-hcolor").addEventListener("change", (e) => setHlineStyle("color", e.target.value.toLowerCase()));
        q(".ps-pg-houtline").addEventListener("change", (e) => setHlineStyle("outline", Number(e.target.value)));
        q(".ps-pg-houtcolor").addEventListener("change", (e) => setHlineStyle("outlineColor", e.target.value.toLowerCase()));
        q(".ps-pg-hreroll").addEventListener("click", () => rerollHline());
        q(".ps-pg-balloon-toggle").addEventListener("click", () => toggleBalloon());
        q(".ps-pg-balloon-stroke").addEventListener("change", (e) => {
            setBalloonStroke(Number(e.target.value));
            refocus();
        });
        // 数値の欄で Enter を押したら決める（キャンバスの操作に戻る）
        for (const sel of [".ps-pg-tsize", ".ps-pg-tline", ".ps-pg-tspace"]) {
            q(sel).addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.isComposing) e.target.blur();
            });
        }
    }

    // 手描き線の書式を変える。選んだ線があればそれに、なければこれから引く線に効く（どちらでも次に引く線の書式として覚える）
    function setHlineStyle(key, value) {
        prefs.hline = cleanHlineStyle({...prefs.hline, [key]: value});
        savePrefs();
        const s = selected();
        if (s && s.type === "hline") change(() => Object.assign(s, cleanHlineStyle({...s, [key]: value})));
        else updateTools();
        refocus();
    }

    function rerollHline() {
        const s = selected();
        if (!s || s.type !== "hline" || !SFX()) return;
        change(() => (s.seed = SFX().randomSeed()));
    }

    function fillHlineBar(t, placed) {
        const set = (sel, v) => {
            const input = q(sel);
            if (document.activeElement !== input) input.value = v;
        };
        set(".ps-pg-hwidth", t.width);
        set(".ps-pg-hwobble", t.wobble);
        set(".ps-pg-hcolor", t.color);
        set(".ps-pg-houtline", String(t.outline));
        set(".ps-pg-houtcolor", t.outlineColor);
        q(".ps-pg-hreroll").disabled = !placed;
    }

    // 書式を変える。選んだセリフがあればそれに、なければこれから置くセリフに効く（どちらでも次に置くセリフの書式として覚える）
    function setTextStyle(key, value) {
        prefs.text[key] = value;
        savePrefs();
        const s = selected();
        if (s && s.type === "text") {
            if (textEdit && textEdit.id === s.id) {
                // 入力中は、決定したときにまとめて 1 回の変更にする
                s[key] = value;
                fitText(s);
                render();
            } else {
                change(() => {
                    s[key] = value;
                    fitText(s);
                });
            }
        } else {
            updateTools();
        }
        if (textEdit) q(".ps-pg-textarea").focus();
    }

    function fillTextBar(t) {
        const set = (sel, v) => {
            const input = q(sel);
            if (document.activeElement !== input) input.value = v;
        };
        // 一覧にないフォント（ほかの PC で選んだものなど）は「見つからないフォント」と出す
        const button = q(".ps-pg-font");
        button.textContent = fontName(t.font) + " ▾";
        button.title = `フォントを選びます（${t.font || "既定"}）。書き出しにも同じ字形で入ります`;
        set(".ps-pg-tsize", t.size);
        set(".ps-pg-tline", t.lineHeight);
        set(".ps-pg-tspace", t.spacing);
        set(".ps-pg-tcolor", t.color);
        set(".ps-pg-toutline", String(t.outline));
        set(".ps-pg-toutcolor", t.outlineColor);
        view.querySelectorAll("[data-dir]").forEach((b) => b.classList.toggle("mtm-active", (b.dataset.dir === "v") === t.vertical));
        // 吹き出しは置いたセリフにだけ付けられる（これから置くセリフの書式にはない）
        const placed = t.type === "text";
        q(".ps-pg-tballoon").classList.toggle("ps-off", !placed);
        if (placed) {
            q(".ps-pg-balloon-toggle").classList.toggle("mtm-active", !!t.balloon);
            const stroke = q(".ps-pg-balloon-stroke");
            stroke.classList.toggle("ps-off", !t.balloon);
            if (t.balloon && document.activeElement !== stroke) stroke.value = String(t.balloon.stroke);
        }
    }

    // p（ページのピクセル）を中心に、空のセリフを置いて入力を始める
    function createText(p) {
        const before = snapshot();
        const s = {id: newId(), type: "text", x: p.x, y: p.y, w: 0, h: 0, text: "", ...cleanTextStyle(prefs.text)};
        fitText(s);
        ed.page.shapes.push(s);
        ed.sel = s.id;
        useFont(s.font);
        startTextEdit(s, before);
    }

    function startTextEdit(s, before) {
        if (textEdit) finishTextEdit(true);
        if (drag) cancelDrag();
        textEdit = {id: s.id, before: before || snapshot()};
        ed.sel = s.id;
        const ta = q(".ps-pg-textarea");
        ta.value = s.text;
        q(".ps-pg-textedit").classList.remove("ps-off");
        render();
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
    }

    // accept なら決定（字が空ならセリフごと消す）、そうでなければ入力を始める前に戻す
    function finishTextEdit(accept) {
        const t = textEdit;
        if (!t) return;
        textEdit = null;
        q(".ps-pg-textedit").classList.add("ps-off");
        if (!ed) return;
        if (!accept) {
            restoreSilently(t.before);
            render();
            refocus();
            return;
        }
        const s = shapeOf(t.id);
        if (s && !s.text.trim()) {
            ed.page.shapes = ed.page.shapes.filter((x) => x !== s);
            ed.sel = null;
        }
        if (snapshot() !== t.before) {
            pushUndo(t.before);
            commit();
        } else {
            render();
        }
        refocus();
    }

    // ---------- 素材（吹き出し・集中線・小物など） ----------
    // 画像ファイルのドロップ、クリップボードからの貼り付け、「＋ 素材」で置く。画像はサーバーに PNG で保存し、ページは名前と位置・大きさだけを持つ

    let pointerAt = null;   // 最後にキャンバスの上にあったマウスの位置（ページのピクセル）。貼り付ける位置に使う
    const MATERIAL_FIT = 0.8;   // 置くときは原寸。ページのこの割合に収まらなければ縮める
    const MATERIAL_STEP = 40;   // まとめて置いたとき、1 枚ずつずらす量（ページのピクセル）

    const imageFiles = (list) => [...(list || [])].filter((f) => f && /^image\//.test(f.type));
    const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

    function buildMaterials() {
        const stage = q(".ps-pg-stage");
        svg.addEventListener("pointermove", (e) => (pointerAt = toPage(e)));
        svg.addEventListener("pointerleave", () => (pointerAt = null));
        // 編集画面のどこにドロップしても受ける（プロジェクトの画面の「画像からカット案を作る」には渡さない）。
        // キャンバスの上ならその位置、ほかはページの中央に置く
        view.addEventListener("dragover", (e) => {
            if (!ed || !hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const ok = !isCropOpen() && !!ed.opts.uploadMaterial;
            e.dataTransfer.dropEffect = ok ? "copy" : "none";
            stage.classList.toggle("ps-pg-dropping", ok);
        });
        view.addEventListener("dragleave", (e) => {
            if (!view.contains(e.relatedTarget)) stage.classList.remove("ps-pg-dropping");
        });
        view.addEventListener("drop", (e) => {
            if (!ed || !hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            stage.classList.remove("ps-pg-dropping");
            if (isCropOpen()) return;
            addMaterials(imageFiles(e.dataTransfer.files), svg.contains(e.target) ? toPage(e) : null);
        });
        // Ctrl+V。入力欄に貼り付けるときは邪魔しない
        document.addEventListener("paste", (e) => {
            if (!ed || isCropOpen() || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
            const files = imageFiles(e.clipboardData && e.clipboardData.files);
            if (!files.length) return;
            e.preventDefault();
            addMaterials(files, pointerAt);
        });
        const input = q(".ps-pg-material-file");
        q(".ps-pg-material").addEventListener("click", () => input.click());
        input.addEventListener("change", () => {
            const files = imageFiles(input.files);
            input.value = "";
            refocus();
            addMaterials(files, null);
        });
    }

    // 素材はページから一部はみ出してよい（裁ち落としの集中線など）。ただし MIN_SIZE だけはページに残して、掴めるようにする
    function placeMaterial(s, x, y) {
        s.x = round1(clamp(x, MIN_SIZE - s.w, ed.page.width - MIN_SIZE));
        s.y = round1(clamp(y, MIN_SIZE - s.h, ed.page.height - MIN_SIZE));
    }

    // 画像をサーバーに保存してから、at（なければページの中央）を中心に原寸で置き、選んだ状態にする。1 枚ごとに元に戻せる
    async function addMaterials(files, at) {
        if (!ed || !files.length || !ed.opts.uploadMaterial) return;
        const page = ed.page;
        // ページの外（周りの灰色の所）に落としたときは、ページの端に寄せる
        const center = at ? inPage(at) : {x: page.width / 2, y: page.height / 2};
        let n = 0;
        for (const file of files) {
            let m;
            try {
                m = await ed.opts.uploadMaterial(file);
            } catch (err) {
                alert(`素材を置けませんでした（${file.name || "貼り付けた画像"}）。\n${err.message}`);
                continue;
            }
            // 保存している間に画面を閉じたり、ページを変えたりしたら置かない
            if (!ed || ed.page !== page) return;
            const scale = Math.min(1, page.width * MATERIAL_FIT / m.width, page.height * MATERIAL_FIT / m.height);
            const s = {id: newId(), type: "material", name: m.name, x: 0, y: 0, w: round1(m.width * scale), h: round1(m.height * scale)};
            // 置いたときはページの中に収める（はみ出させるのは、置いたあとに動かして）
            s.x = round1(clamp(center.x - s.w / 2 + n * MATERIAL_STEP, 0, page.width - s.w));
            s.y = round1(clamp(center.y - s.h / 2 + n * MATERIAL_STEP, 0, page.height - s.h));
            n++;
            // すぐ動かせるよう、選択の道具に持ち替える
            if (prefs.tool !== "select") {
                prefs.tool = "select";
                savePrefs();
            }
            if (drag) cancelDrag();
            finishTextEdit(true);
            change(() => {
                page.shapes.push(s);
                ed.sel = s.id;
            });
        }
    }

    // ---------- オノマトペ（効果音・擬音） ----------
    // パレットに文字列（1 行に 1 つ）と調整済みスタンプを並べる。押すとスタンプモードになり、クリックした所に置く（続けて置ける）。
    // 置くたびに乱数の種を変えるので、ゆらぎの設定の範囲で形が少しずつ変わる。
    // 選択の道具でオノマトペを選ぶと、パレットが詳細の調整に変わる。形を変えたら、書き出し用の画像を作り直して保存する。
    // 文字列と調整済みスタンプはプロジェクトをまたいで共通（サーバーの data/sfx.json）

    const SFX = () => window.PolarisSfx;
    let sfxLib = {words: "", stamps: []};
    let sfxLibLoaded = false;
    let stampSource = null;     // スタンプモードで置くもの {kind: "word" | "stamp", id, params}
    let sfxBefore = null;       // 詳細の調整で、つまみを動かし始める前の状態（離したときに 1 回の変更にする）
    const sfxPending = new Set();   // 字形が届いたら枠を合わせ直すオノマトペの id
    let bakeTimer = null;
    let baking = false;
    let sfxPaletteSig = "";     // パレットを最後に作ったときの中身（同じなら作り直さない）
    let sfxLoads = 0;           // 字形が届いた回数（見本を描き直すため）

    // 文字列と調整済みスタンプは 50 音順に並べる（ひらがなとカタカナは同じ音として並ぶ）
    const kanaOrder = new Intl.Collator("ja", {numeric: true});
    const sortWords = (text) => [...new Set(text.split(/\r?\n/).map((w) => w.trim()).filter(Boolean))].sort(kanaOrder.compare);
    const sfxWords = () => sortWords(sfxLib.words);
    // 調整済みスタンプの下に出すフォント名の長さ（超えたら … で切る。全部は指を乗せると見える）
    const STAMP_FONT_CHARS = 12;
    const shortText = (s, n) => {
        const chars = [...s];
        return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : s;
    };
    const sortedStamps = () => sfxLib.stamps.slice().sort((a, b) => kanaOrder.compare(a.params.text || "", b.params.text || ""));
    const isSfxOpen = () => view && !q(".ps-pg-sfx").classList.contains("ps-off");
    const cloneParams = (p) => JSON.parse(JSON.stringify(p));

    // 詳細の調整のつまみ [設定の場所, 表示, 最小, 最大, 刻み, 単位, 説明]
    const SFX_FIELDS = [
        ["形", [
            ["size", "大きさ", 8, 800, 1, "px", "字の大きさ（ページのピクセル）"],
            ["sizeStart", "始めの大きさ", 10, 300, 1, "%", "最初の字の大きさ。間はなめらかに変わります"],
            ["sizeEnd", "終わりの大きさ", 10, 300, 1, "%", "最後の字の大きさ"],
            ["spacing", "字間", -60, 150, 1, "%", "字と字の間（字の大きさに対する割合）"],
            ["rise", "傾き", -90, 90, 1, "°", "全体の傾き。プラスで右上がり"],
            ["italic", "斜体", -45, 45, 1, "°", "字を斜めに倒します"],
            ["curve", "曲がり", -100, 100, 1, "%", "並びを弓なりに曲げます。プラスで真ん中がふくらみます"],
            ["jitter.offset", "字のずれ", 0, 100, 1, "%", "字を並びと直角の向きにずらします。「交互」なら、隣り合う字がちょうどこの割合（字の大きさに対する）ずれ、置くたびに変わりません。「ばらばら」なら字ごとにこの幅の中で決まり、置くたびに変わります"],
        ]],
        ["ゆらぎ（置くたびに変わる幅）", [
            ["jitter.rot", "字の角度", 0, 45, 1, "°", "字ごとに、この角度の範囲で回します"],
            ["jitter.size", "字の大きさ", 0, 60, 1, "%", "字ごとに、この割合の範囲で大きさを変えます"],
            ["jitter.tilt", "全体の傾き", 0, 30, 1, "°", "全体の傾きを、この角度の範囲で変えます"],
            ["amount", "ゆらぎの強さ", 0, 200, 5, "%", "上のゆらぎ全部（と「ばらばら」の字のずれ）に掛ける強さ。0 でゆらぎなし"],
        ]],
        ["塗り・フチ", [
            ["outlines.0.width", "フチ 1", 0, 40, 0.5, "%", "字のすぐ外のフチの太さ（字の大きさに対する割合）。0 でなし"],
            ["outlines.1.width", "フチ 2", 0, 40, 0.5, "%", "フチ 1 のさらに外のフチの太さ。0 でなし"],
        ]],
    ];

    // 選んだ字の手直しのつまみ [設定の名前, 表示, 最小, 最大, 刻み, 単位, 説明]
    const SFX_GLYPH_FIELDS = [
        ["x", "左右", -200, 200, 1, "%", "字を並びの横の向きにずらします（字の大きさに対する割合。全体の傾きの前の向き）"],
        ["y", "上下", -200, 200, 1, "%", "字を並びの縦の向きにずらします（字の大きさに対する割合。全体の傾きの前の向き）"],
        ["rot", "角度", -180, 180, 1, "°", "字を回します。プラスで時計回り"],
        ["size", "大きさ", 10, 400, 1, "%", "字の大きさ。100 % でそのまま"],
    ];

    // i 番目の字の手直し（なければ何も変えない値）
    const glyphOf = (p, i) => ({x: 0, y: 0, rot: 0, size: 100, ...((p.glyphs || [])[i] || {})});

    function setGlyph(p, i, o) {
        if (i < 0) return;
        p.glyphs = (p.glyphs || []).slice();
        while (p.glyphs.length < i) p.glyphs.push(null);
        p.glyphs[i] = o;
    }

    function getPath(obj, path) {
        return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    }

    function setPath(obj, path, value) {
        const keys = path.split(".");
        let o = obj;
        keys.slice(0, -1).forEach((k, i) => {
            if (o[k] == null) o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
            o = o[k];
        });
        o[keys[keys.length - 1]] = value;
    }

    function buildSfx() {
        if (!SFX()) return;
        q(".ps-pg-sfx-toggle").addEventListener("click", () => toggleSfxPalette());
        q(".ps-pg-sfx-close").addEventListener("click", () => toggleSfxPalette(false));
        q(".ps-pg-sfx-font").addEventListener("click", (e) => (isFontPickerOpen() ? closeFontPicker() : openFontPicker(e.currentTarget, "sfx-new")));
        const size = q(".ps-pg-sfx-newsize");
        size.addEventListener("change", () => {
            const v = Number(size.value);
            if (size.value !== "" && Number.isFinite(v)) prefs.sfxSize = clamp(Math.round(v), 8, 2000);
            savePrefs();
            if (stampSource && stampSource.kind === "word") startStamp("word", stampSource.id);
            renderSfxPalette();
        });
        size.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) e.target.blur();
        });
        q(".ps-pg-sfx-vary").addEventListener("change", (e) => {
            prefs.sfxVary = e.target.checked;
            savePrefs();
        });
        q(".ps-pg-sfx-edit").addEventListener("click", () => startWordEdit());
        q(".ps-pg-sfx-edit-cancel").addEventListener("click", () => finishWordEdit(false));
        q(".ps-pg-sfx-edit-ok").addEventListener("click", () => finishWordEdit(true));
        q(".ps-pg-sfx-textarea").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
                e.preventDefault();
                finishWordEdit(true);
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                finishWordEdit(false);
            }
        });
        buildSfxDetail();
        q(".ps-pg-fontside-close").addEventListener("click", () => toggleFontSide(false));
        q(".ps-pg-fontside-pin").addEventListener("click", () => {
            prefs.sfxFontsPinned = !prefs.sfxFontsPinned;
            savePrefs();
            if (ed) render();
            refocus();
        });
        q(".ps-pg-sfx-fonts-restore").addEventListener("click", () => {
            fontCompareHidden.clear();
            fontCompareSig = "";
            renderSfxPalette();
        });
        // 字形が届いたら、枠を合わせ直して描き直す
        SFX().onLoad(() => {
            sfxLoads++;
            if (!ed) return;
            let fitted = false;
            for (const id of [...sfxPending]) {
                const s = shapeOf(id);
                if (!s || s.type !== "sfx") {
                    sfxPending.delete(id);
                } else if (SFX().fit(s)) {
                    sfxPending.delete(id);
                    fitted = true;
                }
            }
            if (fitted) commit();
            else render();
        });
    }

    function buildSfxDetail() {
        const box = q(".ps-pg-sfx-detail");
        const fields = SFX_FIELDS.map(([title, list]) => el("div", {class: "ps-pg-sfx-group"}, [
            el("div", {class: "ps-pg-sfx-label", text: title}),
            ...list.map(([path, label, min, max, step, unit, help]) => el("label", {class: "ps-pg-sfx-field", title: help}, [
                el("span", {class: "ps-pg-sfx-name", text: label}),
                el("input", {type: "range", min, max, step, "data-sfx": path}),
                el("input", {type: "number", min, max, step, "data-sfx": path, class: "ps-pg-sfx-num"}),
                el("span", {class: "ps-pg-sfx-unit", text: unit}),
            ])),
        ]));
        box.append(
            el("div", {class: "ps-pg-sfx-row"}, [
                el("button", {type: "button", class: "mtm-btn ps-pg-sfx-back", text: "← パレット", title: "選択を外してパレットに戻ります (Esc)", onclick: () => select(null)}),
                el("span", {class: "mtm-fs-spacer"}),
                el("button", {type: "button", class: "mtm-btn ps-pg-sfx-reroll", text: "🎲 別の形", title: "ゆらぎの種を変えて、別の形にします (G)", onclick: () => rerollSfx()}),
            ]),
            el("label", {class: "ps-pg-sfx-field ps-pg-sfx-textfield"}, [
                el("span", {class: "ps-pg-sfx-name", text: "文字"}),
                el("input", {type: "text", class: "ps-pg-sfx-text", maxlength: 100}),
            ]),
            el("div", {class: "ps-pg-sfx-row"}, [
                el("button", {type: "button", class: "mtm-btn ps-pg-sfx-dfont", "data-font-target": "sfx", title: "フォントを選びます"}),
                el("span", {class: "ps-pg-group"}, [
                    el("button", {type: "button", class: "mtm-btn", "data-sfx-dir": "h", text: "横", title: "横書き"}),
                    el("button", {type: "button", class: "mtm-btn", "data-sfx-dir": "v", text: "縦", title: "縦書き"}),
                ]),
            ]),
            el("div", {class: "ps-pg-sfx-row"}, [
                el("button", {type: "button", class: "mtm-btn ps-pg-sfx-fonts-toggle", text: "🔤 フォント別の見え方",
                    title: "今の形をほかのフォントで描いた見本を、パレットの左に広げて並べます。もう一度押すと閉じます",
                    onclick: () => toggleFontSide()}),
            ]),
            el("div", {class: "ps-pg-sfx-balloon"}, [
                el("div", {class: "ps-pg-sfx-row"}, [
                    el("button", {type: "button", class: "mtm-btn ps-pg-sfx-balloon-toggle", text: "□ フキダシ",
                        title: "このオノマトペにフキダシ（白地に黒い線）を付ける・外す (B)", onclick: () => toggleBalloon()}),
                    el("button", {type: "button", class: "mtm-btn ps-pg-sfx-balloon-edit", text: "頂点を編集",
                        title: "フキダシの頂点を動かします。辺の真ん中の丸をドラッグで頂点を足し（20 個まで）、頂点をダブルクリックで消します。矢印キーで最後に触った頂点を 1 px（Shift で 10 px）",
                        onclick: () => toggleBalloonEdit()}),
                    el("button", {type: "button", class: "mtm-btn ps-pg-sfx-balloon-square", text: "四角に戻す", title: "フキダシを今の外枠の四角に戻します",
                        onclick: () => squarifyBalloon()}),
                    el("button", {type: "button", class: "mtm-btn ps-pg-sfx-balloon-dice", text: "🎲", title: "フキダシの形をランダムに作り直します（ギザギザか、ゆがんだ多角形。外枠の大きさはそのまま）",
                        onclick: () => randomBalloon()}),
                ]),
                el("div", {class: "ps-pg-sfx-row ps-pg-sfx-balloon-more"}, [
                    el("span", {class: "ps-pg-sfx-balloon-info"}),
                    el("span", {class: "mtm-fs-spacer"}),
                    el("select", {class: "ps-pg-sfx-balloon-stroke", title: "フキダシの線の太さ",
                        onchange: (e) => setBalloonStroke(Number(e.target.value))},
                    BALLOON_STROKES.map((w) => el("option", {value: String(w), text: `線 ${w} px`}))),
                ]),
            ]),
            el("div", {class: "ps-pg-sfx-glyph"}, [
                el("div", {class: "ps-pg-sfx-row"}, [
                    el("button", {type: "button", class: "mtm-btn ps-pg-sfx-glyphmode", text: "✥ 字を 1 つずつ直す",
                        title: "字を 1 つずつ動かす・回す・大きさを変える (E)", onclick: () => toggleVertexMode()}),
                    el("span", {class: "mtm-fs-spacer"}),
                    el("button", {type: "button", class: "mtm-btn ps-pg-sfx-glyph-resetall", text: "すべての字を戻す",
                        title: "字ごとの手直しを全部やめます", onclick: () => editSfx((p) => (p.glyphs = []), true, true)}),
                ]),
                el("div", {class: "ps-pg-sfx-glyph-info"}),
                el("div", {class: "ps-pg-sfx-glyph-fields"}, [
                    ...SFX_GLYPH_FIELDS.map(([key, label, min, max, step, unit, help]) => el("label", {class: "ps-pg-sfx-field", title: help}, [
                        el("span", {class: "ps-pg-sfx-name", text: label}),
                        el("input", {type: "range", min, max, step, "data-sfx-glyph": key}),
                        el("input", {type: "number", min, max, step, "data-sfx-glyph": key, class: "ps-pg-sfx-num"}),
                        el("span", {class: "ps-pg-sfx-unit", text: unit}),
                    ])),
                    el("div", {class: "ps-pg-sfx-row"}, [
                        el("span", {class: "mtm-fs-spacer"}),
                        el("button", {type: "button", class: "mtm-btn ps-pg-sfx-glyph-reset", text: "この字を戻す", title: "選んだ字の手直しをやめます",
                            onclick: () => editSfx((p) => setGlyph(p, activeGlyph, null), true, true)}),
                    ]),
                ]),
            ]),
            ...fields,
            el("div", {class: "ps-pg-sfx-row ps-pg-sfx-colors"}, [
                el("label", {title: "字の色"}, [el("span", {text: "塗り"}), el("input", {type: "color", "data-sfx-color": "fill"})]),
                el("label", {title: "フチ 1 の色"}, [el("span", {text: "フチ 1"}), el("input", {type: "color", "data-sfx-color": "outlines.0.color"})]),
                el("label", {title: "フチ 2 の色"}, [el("span", {text: "フチ 2"}), el("input", {type: "color", "data-sfx-color": "outlines.1.color"})]),
            ]),
            el("div", {class: "ps-pg-sfx-row"}, [
                el("span", {class: "mtm-fs-spacer"}),
                el("button", {type: "button", class: "mtm-btn mtm-primary", text: "＋ 調整済みに登録", title: "この形を調整済みスタンプとしてパレットに登録します。どのプロジェクトでも使えます",
                    onclick: () => registerStamp(undefined)}),
            ]),
        );
        // つまみと数値の欄。動かしている間は描き直すだけにして、離したら 1 回の変更にする
        box.querySelectorAll("[data-sfx]").forEach((input) => {
            const apply = (final) => {
                const v = Number(input.value);
                if (input.value === "" || !Number.isFinite(v)) return;
                editSfx((p) => setPath(p, input.dataset.sfx, v), final);
            };
            input.addEventListener("input", () => input.type === "range" && apply(false));
            input.addEventListener("change", () => apply(true));
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.isComposing) e.target.blur();
            });
        });
        // 字のずれの付け方（交互・ばらばら）。字のずれのつまみのすぐ下に出す
        box.querySelector('[data-sfx="jitter.offset"]').closest("label").after(el("div", {class: "ps-pg-sfx-row ps-pg-sfx-zig"},
            [1, -1, 0].map((z) => el("button", {type: "button", class: "mtm-btn", "data-sfx-zig": z,
                onclick: () => editSfx((p) => (p.zigzag = z), true)}))));
        // 選んだ字の手直し
        box.querySelectorAll("[data-sfx-glyph]").forEach((input) => {
            const apply = (final) => {
                const v = Number(input.value);
                if (input.value === "" || !Number.isFinite(v) || activeGlyph < 0) return;
                editSfx((p) => setGlyph(p, activeGlyph, {...glyphOf(p, activeGlyph), [input.dataset.sfxGlyph]: v}), final, true);
            };
            input.addEventListener("input", () => input.type === "range" && apply(false));
            input.addEventListener("change", () => apply(true));
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.isComposing) e.target.blur();
            });
        });
        box.querySelectorAll("[data-sfx-color]").forEach((input) => {
            input.addEventListener("input", () => editSfx((p) => setPath(p, input.dataset.sfxColor, input.value.toLowerCase()), false));
            input.addEventListener("change", () => editSfx((p) => setPath(p, input.dataset.sfxColor, input.value.toLowerCase()), true));
        });
        const text = q(".ps-pg-sfx-text");
        text.addEventListener("input", () => text.value.trim() && editSfx((p) => (p.text = text.value), false));
        text.addEventListener("change", () => text.value.trim() && editSfx((p) => (p.text = text.value), true));
        text.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) e.target.blur();
        });
        q(".ps-pg-sfx-dfont").addEventListener("click", (e) => (isFontPickerOpen() ? closeFontPicker() : openFontPicker(e.currentTarget, "sfx")));
        box.querySelectorAll("[data-sfx-dir]").forEach((b) => b.addEventListener("click", () => editSfx((p) => (p.vertical = b.dataset.sfxDir === "v"), true)));
    }

    async function loadSfxLibrary() {
        if (sfxLibLoaded) return;
        sfxLibLoaded = true;
        try {
            const res = await fetch("polaris-studio/sfx", {cache: "no-store"});
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || res.status);
            sfxLib = {words: data.words || "", stamps: data.stamps || []};
        } catch (err) {
            console.warn("[Polaris Studio] sfx library failed", err);
            sfxLibLoaded = false;
        }
        renderSfxPalette();
    }

    async function saveSfxLibrary() {
        try {
            const res = await fetch("polaris-studio/sfx", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(sfxLib)});
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data.error || res.status);
        } catch (err) {
            alert("オノマトペのパレットを保存できませんでした。\n" + err.message);
        }
    }

    function toggleSfxPalette(open) {
        if (!SFX()) return;
        prefs.sfxOpen = open === undefined ? !prefs.sfxOpen : open;
        savePrefs();
        if (!prefs.sfxOpen && prefs.tool === "sfx") setTool("select");
        q(".ps-pg-sfx").classList.toggle("ps-off", !prefs.sfxOpen);
        if (prefs.sfxOpen) loadSfxLibrary();
        if (ed) render();
        refocus();
    }

    // 文字列のスタンプの設定（既定の形 ＋ フォント・大きさ）
    function wordParams(word) {
        return SFX().clean({text: word, font: prefs.sfxFont, size: prefs.sfxSize, seed: SFX().randomSeed()});
    }

    // スタンプモードにする。kind は "word"（id は文字列）か "stamp"（id は調整済みスタンプの id）
    function startStamp(kind, id) {
        const st = kind === "stamp" ? sfxLib.stamps.find((x) => x.id === id) : null;
        if (kind === "stamp" && !st) return;
        stampSource = {kind, id, params: st ? SFX().clean(st.params) : wordParams(id)};
        SFX().load(stampSource.params);
        if (prefs.tool !== "sfx") setTool("sfx");
        else render();
        renderSfxPalette();
    }

    // p を中心にスタンプを置く。「置くたびに形を変える」ならゆらぎの種を変える
    async function placeStamp(p) {
        if (!stampSource) return;
        const page = ed.page;
        const params = cloneParams(stampSource.params);
        if (prefs.sfxVary) params.seed = SFX().randomSeed();
        await SFX().load(params);
        if (!ed || ed.page !== page) return;
        const b = SFX().build(params);
        if (!b) return;
        const s = {id: newId(), type: "sfx", name: "", x: round1(p.x - b.w / 2), y: round1(p.y - b.h / 2), w: round1(b.w), h: round1(b.h), params};
        change(() => page.shapes.push(s));
        return s;
    }

    // 選んだオノマトペの設定を変える。final でなければ描き直すだけ（つまみを動かしている間）
    // keep なら（字の手直し）、ほかの字がページの上で動かないよう並びの原点を保つ。でなければ外枠の真ん中を保つ
    function editSfx(fn, final, keep) {
        const s = selected();
        if (!s || s.type !== "sfx") return;
        if (!sfxBefore) sfxBefore = snapshot();
        const prev = keep ? {x: s.x, y: s.y, w: s.w, h: s.h, params: cloneParams(s.params)} : null;
        fn(s.params);
        s.params = SFX().clean(s.params);
        if (!(keep ? SFX().refit(s, prev) : SFX().fit(s))) sfxPending.add(s.id);
        if (!final) {
            render();
            return;
        }
        const before = sfxBefore;
        sfxBefore = null;
        if (snapshot() !== before) {
            pushUndo(before);
            commit();
        } else {
            render();
        }
    }

    function rerollSfx() {
        editSfx((p) => (p.seed = SFX().randomSeed()), true);
    }

    // font を渡すと、そのフォントに替えた形で登録する（フォント別の見本から）
    function registerStamp(font) {
        const s = selected();
        if (!s || s.type !== "sfx") return;
        const params = cloneParams(s.params);
        if (font !== undefined) params.font = font;
        sfxLib.stamps.unshift({id: newId(), params});
        saveSfxLibrary();
        renderSfxPalette();
        if (ed.opts.toast) ed.opts.toast("調整済みスタンプに登録しました");
    }

    function deleteStamp(id) {
        if (!confirm("この調整済みスタンプをパレットから外しますか？\n（ページに置いたオノマトペはそのまま残ります）")) return;
        sfxLib.stamps = sfxLib.stamps.filter((x) => x.id !== id);
        if (stampSource && stampSource.kind === "stamp" && stampSource.id === id) setTool("select");
        saveSfxLibrary();
        renderSfxPalette();
    }

    function startWordEdit() {
        const ta = q(".ps-pg-sfx-textarea");
        ta.value = sfxLib.words;
        q(".ps-pg-sfx-wordedit").classList.remove("ps-off");
        q(".ps-pg-sfx-words").classList.add("ps-off");
        q(".ps-pg-sfx-edit").disabled = true;
        ta.focus();
    }

    function finishWordEdit(accept) {
        if (q(".ps-pg-sfx-wordedit").classList.contains("ps-off")) return;
        if (accept) {
            sfxLib.words = sortWords(q(".ps-pg-sfx-textarea").value).join("\n");
            saveSfxLibrary();
        }
        q(".ps-pg-sfx-wordedit").classList.add("ps-off");
        q(".ps-pg-sfx-words").classList.remove("ps-off");
        q(".ps-pg-sfx-edit").disabled = false;
        renderSfxPalette();
        refocus();
    }

    // パレットを描き直す（選んだオノマトペがあれば詳細の調整を出す）
    function renderSfxPalette() {
        if (!view || !SFX() || !isSfxOpen()) return;
        const s = ed && selected();
        const detail = !!(s && s.type === "sfx");
        q(".ps-pg-sfx-palette").classList.toggle("ps-off", detail);
        q(".ps-pg-sfx-detail").classList.toggle("ps-off", !detail);
        q(".ps-pg-sfx-title").textContent = detail ? "オノマトペの調整" : "オノマトペ";
        if (detail) {
            fillSfxDetail(s);
            sfxPaletteSig = "";
            return;
        }
        // 図形を動かすたびに描き直さないよう、パレットの中身が変わったときだけ作り直す
        const sig = JSON.stringify([sfxLib, sfxLibLoaded, prefs.sfxFont, prefs.sfxSize, prefs.sfxVary, !!fontList,
            prefs.tool === "sfx" && stampSource ? [stampSource.kind, stampSource.id] : null, sfxLoads]);
        if (sig === sfxPaletteSig) return;
        sfxPaletteSig = sig;
        const font = q(".ps-pg-sfx-font");
        font.textContent = fontName(prefs.sfxFont) + " ▾";
        if (document.activeElement !== q(".ps-pg-sfx-newsize")) q(".ps-pg-sfx-newsize").value = prefs.sfxSize;
        q(".ps-pg-sfx-vary").checked = prefs.sfxVary;
        const active = (kind, id) => prefs.tool === "sfx" && stampSource && stampSource.kind === kind && stampSource.id === id;
        const words = q(".ps-pg-sfx-words");
        words.textContent = "";
        const list = sfxWords();
        if (!list.length) {
            words.appendChild(el("div", {class: "mtm-empty", text: sfxLibLoaded ? "「編集」で、使うオノマトペの文字列を 1 行に 1 つずつ入れてください。" : "読み込み中…"}));
        }
        for (const w of list) {
            words.appendChild(el("button", {
                type: "button", class: "mtm-btn ps-pg-sfx-word" + (active("word", w) ? " mtm-active" : ""), text: w,
                title: `「${w}」を置きます。ページを左クリックで 1 つ置いて選んだ状態に、右クリックなら続けて置けます`,
                onclick: () => (active("word", w) ? setTool("select") : startStamp("word", w)),
            }));
        }
        const stamps = q(".ps-pg-sfx-stamps");
        stamps.textContent = "";
        if (!sfxLib.stamps.length) {
            stamps.appendChild(el("div", {class: "mtm-empty", text: "置いたオノマトペを選んで調整し、「＋ 調整済みに登録」で登録すると、ここから置けます。"}));
        }
        for (const st of sortedStamps()) {
            const item = el("div", {class: "ps-pg-sfx-stamp" + (active("stamp", st.id) ? " ps-on" : "")}, [
                el("button", {
                    type: "button", class: "ps-pg-sfx-stamp-pick", title: `「${st.params.text}」を置きます。ページを左クリックで 1 つ置いて選んだ状態に、右クリックなら続けて置けます`,
                    onclick: () => (active("stamp", st.id) ? setTool("select") : startStamp("stamp", st.id)),
                }, [SFX().preview(st.params)]),
                el("div", {class: "ps-pg-sfx-stamp-font", text: shortText(fontName(st.params.font), STAMP_FONT_CHARS), title: fontName(st.params.font)}),
                el("button", {type: "button", class: "mtm-icon ps-pg-sfx-stamp-del", text: "✕", title: "パレットから外す", onclick: () => deleteStamp(st.id)}),
            ]);
            stamps.appendChild(item);
        }
    }

    // ---------- フォント別の見本 ----------
    // 選んだオノマトペを、★ を付けたフォント・追加したフォント・最近使ったフォントで描いた見本を並べる。
    // 押すとそのフォントにし、「＋」でそのフォントの形を調整済みスタンプに登録する。✕ で外したフォントは、編集画面を閉じるまで出さない
    // 見本はパレットの左に広げる別の枠に並べる（数の上限はない）
    const fontCompareHidden = new Set();
    let fontCompareSig = "";
    let fontCompareTimer = null;
    let fontCompareAt = 0;

    // 並びは編集画面を開いている間は変えない（フォントを選んでも先頭に動かない）。はじめて出すフォントは後ろに足す
    let fontCompareOrder = [];

    function compareFonts(current) {
        // 一度出したフォントも残す（元のフォントに戻せるように）
        const ids = [...fontCompareOrder, ...prefs.fontFavorites, ...(fontList || []).filter((f) => f.added).map((f) => f.id), ...prefs.fontRecent, current];
        const wanted = new Set(ids.filter((id) => id === current || (!fontCompareHidden.has(id) && fontOf(id))));
        for (const id of wanted) if (!fontCompareOrder.includes(id)) fontCompareOrder.push(id);
        return fontCompareOrder.filter((id) => wanted.has(id));
    }

    // フォント別の見え方の枠を開く・閉じる。開いているかは覚えておき、オノマトペを選ぶたびに同じ状態で出す
    function toggleFontSide(open) {
        prefs.sfxFontsOpen = open === undefined ? !prefs.sfxFontsOpen : open;
        savePrefs();
        fontCompareSig = "";
        const side = q(".ps-pg-fontside");
        side.classList.remove("ps-pg-fontside-in");
        if (prefs.sfxFontsOpen) {
            // せり出すように出す
            void side.offsetWidth;
            side.classList.add("ps-pg-fontside-in");
        }
        if (ed) render();
        refocus();
    }

    // 枠を出すのは、パレットを開いていてオノマトペを選んでいるとき。ピンで固定していれば、選んでいなくても空の枠を出しておく
    function updateFontSide() {
        const s = ed && selected();
        const isSfx = !!(s && s.type === "sfx");
        const show = !!(prefs.sfxFontsOpen && prefs.sfxOpen && SFX() && (isSfx || prefs.sfxFontsPinned));
        q(".ps-pg-fontside").classList.toggle("ps-off", !show);
        q(".ps-pg-fontside-pin").classList.toggle("ps-on", !!prefs.sfxFontsPinned);
        q(".ps-pg-sfx-fonts-toggle").classList.toggle("mtm-active", !!prefs.sfxFontsOpen);
        if (show && !isSfx && fontCompareSig !== "empty") {
            fontCompareSig = "empty";
            const grid = q(".ps-pg-sfx-fonts-grid");
            grid.textContent = "";
            grid.appendChild(el("div", {class: "mtm-empty", text: "置いたオノマトペを選ぶと、フォント別の見本がここに並びます。"}));
            q(".ps-pg-fontside-count").textContent = "";
            q(".ps-pg-sfx-fonts-restore").classList.add("ps-off");
        }
    }

    // つまみを動かしている間は何度も呼ばれるので、作り直すのは少し間をあけてから
    function renderFontCompare(s) {
        updateFontSide();
        if (!prefs.sfxFontsOpen) return;
        const restore = q(".ps-pg-sfx-fonts-restore");
        restore.textContent = `外したフォントを戻す（${fontCompareHidden.size}）`;
        restore.classList.toggle("ps-off", !fontCompareHidden.size);
        const grid = q(".ps-pg-sfx-fonts-grid");
        const p = SFX().clean(s.params);
        const fonts = compareFonts(p.font);
        q(".ps-pg-fontside-count").textContent = `${fonts.length} 個`;
        const sig = JSON.stringify([s.id, {...p, font: ""}, p.font, fonts, !!fontList, sfxLoads]);
        if (sig === fontCompareSig) return;
        clearTimeout(fontCompareTimer);
        const wait = Math.max(0, 120 - (Date.now() - fontCompareAt));
        if (wait > 0 && fontCompareSig) {
            fontCompareTimer = setTimeout(() => {
                const cur = ed && selected();
                if (cur && cur.type === "sfx" && isSfxOpen()) renderFontCompare(cur);
            }, wait);
            return;
        }
        fontCompareSig = sig;
        fontCompareAt = Date.now();
        grid.textContent = "";
        if (fonts.length <= 1) {
            grid.appendChild(el("div", {class: "mtm-empty", text: "フォント選びで ☆ を付けたフォント・追加したフォント・最近使ったフォントの見本がここに並びます。"}));
        }
        for (const id of fonts) {
            const params = {...cloneParams(p), font: id};
            // 字形がまだなら読み込む（届いたら描き直す）
            if (!SFX().ready(params)) SFX().load(params);
            const on = id === p.font;
            const name = fontName(id);
            grid.appendChild(el("div", {class: "ps-pg-sfx-stamp ps-pg-sfx-fontcard" + (on ? " ps-on" : "")}, [
                el("button", {type: "button", class: "ps-pg-sfx-stamp-pick", title: on ? `${name}（今のフォント）` : `${name} にする`,
                    onclick: () => {
                        if (on) return;
                        useFont(id);
                        editSfx((x) => (x.font = id), true);
                    }}, [SFX().preview(params)]),
                el("div", {class: "ps-pg-sfx-stamp-font", text: shortText(name, STAMP_FONT_CHARS), title: name}),
                el("button", {type: "button", class: "mtm-icon ps-pg-sfx-fontcard-add", text: "＋", title: "このフォントの形を調整済みスタンプに登録します",
                    onclick: () => registerStamp(id)}),
                ...(on ? [] : [el("button", {type: "button", class: "mtm-icon ps-pg-sfx-stamp-del", text: "✕", title: "この一覧から外します（編集画面を閉じるまで）",
                    onclick: () => {
                        fontCompareHidden.add(id);
                        renderSfxPalette();
                    }})]),
            ]));
        }
    }

    function fillSfxDetail(s) {
        const p = SFX().clean(s.params);
        const box = q(".ps-pg-sfx-detail");
        renderFontCompare(s);
        // フキダシ
        const hasBalloon = !!s.balloon;
        q(".ps-pg-sfx-balloon-toggle").classList.toggle("mtm-active", hasBalloon);
        const bedit = q(".ps-pg-sfx-balloon-edit");
        bedit.disabled = !hasBalloon;
        bedit.classList.toggle("mtm-active", hasBalloon && balloonEdit);
        q(".ps-pg-sfx-balloon-dice").disabled = !hasBalloon;
        q(".ps-pg-sfx-balloon-square").disabled =!hasBalloon || s.balloon.pts.length === 4 && isAxisRect(s.balloon.pts);
        q(".ps-pg-sfx-balloon-more").classList.toggle("ps-off", !hasBalloon);
        if (hasBalloon) {
            const stroke = q(".ps-pg-sfx-balloon-stroke");
            if (document.activeElement !== stroke) stroke.value = String(s.balloon.stroke);
            q(".ps-pg-sfx-balloon-info").textContent = balloonEdit
                ? `頂点 ${s.balloon.pts.length} / ${BALLOON_MAX}（辺の丸で足す・ダブルクリックで消す）`
                : `頂点 ${s.balloon.pts.length}`;
        }
        box.querySelectorAll("[data-sfx]").forEach((input) => {
            if (document.activeElement === input) return;
            const v = getPath(p, input.dataset.sfx);
            input.value = v === undefined ? 0 : v;
        });
        box.querySelectorAll("[data-sfx-color]").forEach((input) => {
            if (document.activeElement === input) return;
            input.value = getPath(p, input.dataset.sfxColor) || "#ffffff";
        });
        const text = q(".ps-pg-sfx-text");
        if (document.activeElement !== text) text.value = p.text;
        q(".ps-pg-sfx-dfont").textContent = fontName(p.font) + " ▾";
        box.querySelectorAll("[data-sfx-dir]").forEach((b) => b.classList.toggle("mtm-active", (b.dataset.sfxDir === "v") === p.vertical));
        const zigLabel = {1: p.vertical ? "交互・1 字目を右へ" : "交互・1 字目を上へ", "-1": p.vertical ? "交互・1 字目を左へ" : "交互・1 字目を下へ", 0: "ばらばら"};
        box.querySelectorAll("[data-sfx-zig]").forEach((b) => {
            b.textContent = zigLabel[b.dataset.sfxZig];
            b.title = b.dataset.sfxZig === "0" ? "字ごとに乱数でずらします（置くたびに変わります）" : "隣り合う字を、反対の向きに同じだけずらします";
            b.classList.toggle("mtm-active", Number(b.dataset.sfxZig) === p.zigzag);
        });
        // 字の手直し
        const chars = Array.from(p.text);
        if (activeGlyph >= chars.length) activeGlyph = -1;
        const on = vertexMode && activeGlyph >= 0;
        q(".ps-pg-sfx-glyphmode").classList.toggle("mtm-active", vertexMode);
        q(".ps-pg-sfx-glyph-resetall").disabled = !p.glyphs.length;
        q(".ps-pg-sfx-glyph-info").textContent = !vertexMode ? ""
            : on ? `${activeGlyph + 1} 文字目「${chars[activeGlyph]}」：ドラッグで移動、上の丸で回転、右下の四角で大きさ。矢印キーで 1 px（Shift で 10 px）`
            : "直したい字をクリックして選びます。E で終わります";
        q(".ps-pg-sfx-glyph-fields").classList.toggle("ps-off", !on);
        if (on) {
            const g = glyphOf(p, activeGlyph);
            box.querySelectorAll("[data-sfx-glyph]").forEach((input) => {
                if (document.activeElement !== input) input.value = Math.round(g[input.dataset.sfxGlyph] * 10) / 10;
            });
            q(".ps-pg-sfx-glyph-reset").disabled = !p.glyphs[activeGlyph];
        }
    }

    // 選んだオノマトペの大きさを変える（角のつまみ）。真ん中を保ち、字の大きさごと拡大・縮小する
    function resizeSfx(s, o, p) {
        if (drag.sfxSize == null) drag.sfxSize = s.params.size;
        const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
        const scale = Math.max(0.05, Math.hypot(p.x - cx, p.y - cy) / Math.hypot(o.w / 2, o.h / 2));
        s.params.size = Math.round(clamp(drag.sfxSize * scale, 8, 2000) * 10) / 10;
        const k = s.params.size / drag.sfxSize;
        Object.assign(s, {w: round1(o.w * k), h: round1(o.h * k)});
        Object.assign(s, {x: round1(cx - s.w / 2), y: round1(cy - s.h / 2)});
        // フキダシも一緒に拡大・縮小する
        if (drag.origBalloon) s.balloon = {...drag.origBalloon, pts: drag.origBalloon.pts.map((q) => [round1(q[0] * k), round1(q[1] * k)])};
    }

    // 書き出し用の画像を作り直す（変更のたびに少し待ってから）。作り直したら保存する
    function scheduleBake() {
        if (!ed || !ed.opts.uploadMaterial || !SFX()) return;
        const opts = ed.opts, pages = pageList();
        clearTimeout(bakeTimer);
        bakeTimer = setTimeout(() => runBake(opts, pages), 800);
    }

    async function runBake(opts, pages) {
        bakeTimer = null;
        if (baking) {
            bakeTimer = setTimeout(() => runBake(opts, pages), 800);
            return;
        }
        baking = true;
        try {
            const sfx = await SFX().bake(pages, (blob) => opts.uploadMaterial(blob));
            const lines = await bakeHlines(pages, (blob) => opts.uploadMaterial(blob));
            if (sfx || lines) opts.onChange();
        } catch (err) {
            console.warn("[Polaris Studio] sfx bake failed", err);
        }
        baking = false;
    }

    // ---------- 前後のコマページへの移動 ----------
    // トラックパッドなどで細かいホイールが続けて来ても 1 ページずつ進むよう、量をためてから移り、移ったあとは少し待つ

    const WHEEL_STEP = 60;          // この量（ピクセル）たまったら 1 ページ移る
    const WHEEL_PAUSE = 350;        // 移ったあと、この時間（ミリ秒）はホイールを受け付けない
    let wheelSum = 0;
    let wheelUntil = 0;
    let wheelReset = null;

    function wheelPage(e) {
        if (drag || isCropOpen()) return;
        const now = Date.now();
        if (now < wheelUntil) return;
        // 行単位・ページ単位のホイールもピクセルにならす
        const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        const delta = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * scale;
        if (!delta) return;
        // 向きが変わったら、ためた量を捨てる
        if (Math.sign(delta) !== Math.sign(wheelSum)) wheelSum = 0;
        wheelSum += delta;
        clearTimeout(wheelReset);
        wheelReset = setTimeout(() => (wheelSum = 0), 200);
        if (Math.abs(wheelSum) < WHEEL_STEP) return;
        const dir = wheelSum > 0 ? 1 : -1;
        wheelSum = 0;
        if (switchPage(dir)) wheelUntil = now + WHEEL_PAUSE;
    }

    // ---------- 並べて表示（1〜3 枚） ----------
    // Book のコマページのうち start から count 枚を、右から Book の順に並べる（漫画の見開きと同じ向き）。
    // 編集するのはそのうちの 1 枚（ed.page）だけで、ほかのページは絵だけを出し、クリックするとそのページを編集する

    const pageList = () => (ed.opts.pages ? ed.opts.pages() : [ed.page]);
    const shownCount = (list) => Math.max(1, Math.min(prefs.count, list.length));

    // 編集中のページが並びに入るように start を直す
    function fitWindow(list) {
        const n = shownCount(list);
        const i = Math.max(0, list.indexOf(ed.page));
        ed.start = clamp(ed.start || 0, i - n + 1, i);
        ed.start = clamp(ed.start, 0, Math.max(0, list.length - n));
    }

    // 並べたページの枠を作り直す。編集中のページの枠には編集用の svg を入れる。図形の編集では呼ばない（render だけ）
    function renderSlots() {
        const stage = q(".ps-pg-stage");
        const list = pageList();
        fitWindow(list);
        const n = shownCount(list);
        stage.classList.toggle("ps-pg-multi", n > 1);
        stage.textContent = "";
        // 2 枚以上では、ページ番号のすぐ下にそろえて置く
        const align = n > 1 ? "xMidYMin meet" : "xMidYMid meet";
        svg.setAttribute("preserveAspectRatio", align);
        const width = Math.max(3, String(list.length).length);
        for (let i = ed.start; i < ed.start + n; i++) {
            const page = list[i];
            const active = page === ed.page;
            const slot = el("div", {class: "ps-pg-slot" + (active ? " ps-pg-slot-active" : "")});
            if (n > 1) {
                slot.appendChild(el("span", {class: "ps-pg-slot-no", text: String(i + 1).padStart(width, "0") + (page.name ? `  ${page.name}` : "") + (active ? "  編集中" : "")}));
            }
            if (active) {
                slot.appendChild(svg);
            } else {
                const margin = Math.max(page.width, page.height) * 0.02;
                const peek = svgEl("svg", {class: "ps-pg-svg ps-pg-peek", viewBox: `${-margin} ${-margin} ${page.width + margin * 2} ${page.height + margin * 2}`, preserveAspectRatio: align});
                const g = svgEl("g");
                drawPage(g, page, (ref) => ed.opts.resolve(ref, true), true);
                peek.appendChild(g);
                slot.title = "クリックでこのページを編集";
                slot.addEventListener("click", () => activatePage(page));
                slot.appendChild(peek);
            }
            stage.appendChild(slot);
        }
    }

    // 編集するページを変える。元に戻すの履歴はページごとなので、変えたら空にする
    function setActivePage(page) {
        if (page === ed.page) return;
        finishTextEdit(true);
        if (drag) cancelDrag();
        ed.page = page;
        ed.sel = null;
        ed.undo = [];
        ed.redo = [];
        sfxBefore = null;
    }

    function activatePage(page) {
        setActivePage(page);
        renderSlots();
        render();
        refocus();
    }

    // dir は 1（次）か -1（前）。動けたら true。
    // 1 枚表示では前後のページへ移る。2 枚以上では並びを 1 枚ずらし、編集するページは並びの中の同じ位置のページにする
    // （3 枚表示で真ん中を編集していたら、ずらしたあとも真ん中）。
    // 並びが端まで来てずらせないときは、編集するページを並びの中で 1 つ進める（端のページまで行けるように）
    function switchPage(dir) {
        const list = pageList();
        const n = shownCount(list);
        const i = list.indexOf(ed.page);
        const start = ed.start + dir;
        if (n > 1 && start >= 0 && start <= list.length - n) {
            const offset = i - ed.start;
            ed.start = start;
            setActivePage(list[start + offset]);
        } else {
            const next = list[i + dir];
            if (!next) return false;
            setActivePage(next);
        }
        renderSlots();
        render();
        return true;
    }

    function setCount(n) {
        if (!PAGE_COUNTS.includes(n) || n === prefs.count) return;
        prefs.count = n;
        savePrefs();
        renderSlots();
        render();
        refocus();
    }

    function open(opts) {
        if (!view) build(opts.host);
        ed = {page: opts.page, opts, sel: null, undo: [], redo: [], start: 0};
        // フォント別の見本から外したフォントは、編集画面を開き直したら戻す
        fontCompareHidden.clear();
        fontCompareOrder = [];
        fontCompareSig = "";
        if (prefs.tool === "sfx" && !stampSource) prefs.tool = "select";
        if (prefs.sfxOpen) loadSfxLibrary();
        // 開いたページを右端（並びの最初）に置く。後ろに足りなければ左に寄せる
        ed.start = Math.max(0, pageList().indexOf(opts.page));
        drag = null;
        q(".ps-pg-crop").classList.add("ps-off");
        view.classList.remove("ps-off");
        renderSlots();
        render();
        loadFonts();
        // 書き出し用の画像が古いオノマトペがあれば作り直す
        if (SFX() && pageList().some((pg) => (pg.shapes || []).some((s) => SFX().stale(s) || hlineStale(s)))) scheduleBake();
    }

    function close() {
        if (!ed) return;
        const opts = ed.opts;
        closeFontPicker();
        finishTextEdit(true);
        if (drag) cancelDrag();
        closeCrop();
        // 書き出し用の画像の作り直しを待っていたら、すぐに始める（閉じたあとも続く）
        if (bakeTimer) {
            clearTimeout(bakeTimer);
            runBake(opts, pageList());
        }
        sfxBefore = null;
        if (prefs.tool === "sfx") setTool("select");
        ed = null;
        view.classList.add("ps-off");
        opts.onClose();
    }

    const isOpen = () => !!ed;

    // ページを変えたら保存して描き直す
    function commit() {
        render();
        ed.opts.onChange();
        scheduleBake();
    }

    function pushUndo(before) {
        ed.undo.push(before);
        if (ed.undo.length > UNDO_MAX) ed.undo.shift();
        ed.redo = [];
    }

    function change(fn) {
        const before = snapshot();
        fn();
        if (snapshot() === before) return;
        pushUndo(before);
        commit();
    }

    function restore(state) {
        const data = JSON.parse(state);
        ed.page.width = data.width;
        ed.page.height = data.height;
        ed.page.shapes = data.shapes;
        if (!selected()) ed.sel = null;
        activeVertex = -1;
        sfxBefore = null;
        commit();
    }

    function undo() {
        if (!ed) return;
        finishTextEdit(true);
        if (!ed.undo.length) return;
        ed.redo.push(snapshot());
        restore(ed.undo.pop());
    }

    function redo() {
        if (!ed) return;
        finishTextEdit(true);
        if (!ed.redo.length) return;
        ed.undo.push(snapshot());
        restore(ed.redo.pop());
    }

    // 描く道具に持ち替えたら選択は外す（線の太さを変えても、前に描いた図形は変わらない）
    function setTool(tool) {
        prefs.tool = tool;
        if (tool !== "sfx") stampSource = null;
        savePrefs();
        if (!ed) return;
        finishTextEdit(true);
        if (drag) cancelDrag();
        if (tool !== "select") ed.sel = null;
        render();
    }

    // 選択の道具で図形を選んでいれば、その線を変える。描く道具では、これから描く図形の線を決める
    // いま線の太さを決める図形の種類（選んだ図形、なければ道具で描く図形）
    const strokeType = (s) => (s ? s.type : ["line", "hline", "text", "sfx"].includes(prefs.tool) ? prefs.tool : "rect");
    // 線の太さのボタンを使わない図形（素材・セリフ・オノマトペ・手描き線。手描き線は下の行で太さを決める）
    const noStroke = (type) => floating({type}) || type === "hline";

    function setStroke(w) {
        const s = selected();
        const type = strokeType(s);
        if ((type === "line" && !w) || noStroke(type)) return;
        prefs[type] = w;
        savePrefs();
        if (s) change(() => (s.stroke = w));
        updateTools();
    }

    function select(id) {
        if (ed.sel !== id) {
            activeVertex = activeGlyph = activeBalloonVertex = -1;
            balloonEdit = false;
        }
        ed.sel = id;
        render();
    }

    // 頂点の編集。オンの間は、選んだコマの角に丸いつまみを出す（外枠の大きさを変えるつまみの代わり）
    // オノマトペを選んでいるときは、字を 1 つずつ直す（字の枠を出し、選んだ字に回すつまみと大きさのつまみを出す）
    let vertexMode = false;
    let activeVertex = -1;      // 矢印キーで動かす頂点（最後に触った頂点）
    let activeGlyph = -1;       // 手直しする字（オノマトペの何文字目か）
    let balloonEdit = false;    // オノマトペのフキダシの頂点を編集しているか
    let activeBalloonVertex = -1;   // 矢印キーで動かすフキダシの頂点（最後に触った頂点）
    let lastBalloonPress = {i: -1, id: "", at: 0};  // 頂点のダブルクリックを見分けるための、前に押した頂点と時刻
    const DOUBLE_PRESS = 400;
    let lastSfxClick = {id: "", at: 0};     // オノマトペのダブルクリックを見分けるための、前にクリックしたオノマトペと時刻

    // フキダシを付ける・外す（選んだセリフかオノマトペ）
    function toggleBalloon() {
        const s = selected();
        if (!s || (s.type !== "text" && s.type !== "sfx")) return;
        balloonEdit = false;
        activeBalloonVertex = -1;
        change(() => {
            if (s.balloon) delete s.balloon;
            else s.balloon = newBalloon(s);
        });
    }

    function setBalloonStroke(w) {
        const s = selected();
        if (!s || !s.balloon || !BALLOON_STROKES.includes(w)) return;
        change(() => (s.balloon = {...s.balloon, stroke: w}));
    }

    // オノマトペのフキダシの頂点の編集。オンの間は、頂点を動かし、辺の真ん中の丸で頂点を足し、ダブルクリックで頂点を消す
    function toggleBalloonEdit() {
        const s = selected();
        balloonEdit = !balloonEdit && !!(s && s.type === "sfx" && s.balloon);
        activeBalloonVertex = -1;
        if (balloonEdit && vertexMode) vertexMode = false;
        render();
        refocus();
    }

    // フキダシを四角に戻す（今の外枠で）
    function squarifyBalloon() {
        const s = selected();
        if (!s || !s.balloon) return;
        const bb = boundsOf(balloonPts(s));
        activeBalloonVertex = -1;
        change(() => setBalloonPts(s, [[bb.l, bb.t], [bb.r, bb.t], [bb.r, bb.b], [bb.l, bb.b]]));
    }

    // フキダシの形をランダムに作り直す（今の外枠の大きさのまま）。ギザギザ（外と内の点を交互に）か、ゆがんだ多角形
    function randomBalloon() {
        const s = selected();
        if (!s || !s.balloon) return;
        const bb = boundsOf(balloonPts(s));
        const rand = (lo, hi) => lo + Math.random() * (hi - lo);
        const spiky = Math.random() < 0.5;
        const n = spiky ? 2 * Math.round(rand(6, 10)) : Math.round(rand(8, 14));
        const step = Math.PI * 2 / n;
        const start = rand(0, step);
        const inner = rand(0.66, 0.82);
        const raw = Array.from({length: n}, (_, i) => {
            const a = start + i * step + rand(-0.25, 0.25) * step;
            const r = spiky ? (i % 2 ? inner * rand(0.9, 1.1) : rand(0.92, 1)) : rand(0.84, 1);
            return [Math.cos(a) * r, Math.sin(a) * r];
        });
        // 作った形を今の外枠いっぱいに広げる
        const rb = boundsOf(raw);
        const sx = (bb.r - bb.l) / Math.max(rb.r - rb.l, 1e-6), sy = (bb.b - bb.t) / Math.max(rb.b - rb.t, 1e-6);
        activeBalloonVertex = -1;
        change(() => setBalloonPts(s, raw.map((p) => [bb.l + (p[0] - rb.l) * sx, bb.t + (p[1] - rb.t) * sy])));
    }

    function deleteBalloonVertex(i) {
        const s = selected();
        if (!s || !s.balloon || s.balloon.pts.length <= BALLOON_MIN) return;
        activeBalloonVertex = -1;
        change(() => (s.balloon = {...s.balloon, pts: s.balloon.pts.filter((_, j) => j !== i)}));
    }

    function toggleVertexMode() {
        vertexMode = !vertexMode;
        activeVertex = activeGlyph = -1;
        if (vertexMode) balloonEdit = false;
        if (vertexMode && prefs.tool !== "select") setTool("select");
        else if (ed) render();
        refocus();
    }

    // 多角形のコマを外枠の四角に戻す
    function squarify() {
        const s = selected();
        if (!s || !s.pts) return;
        activeVertex = -1;
        change(() => delete s.pts);
    }

    // 頂点 i を p へ。形が潰れる（面積がほとんどない）位置には動かさない
    function moveVertex(s, i, p) {
        const pts = cornersOf(s);
        pts[i] = [p.x, p.y];
        if (Math.abs(polyArea(pts)) < MIN_SIZE * MIN_SIZE) return false;
        setPoints(s, pts);
        return true;
    }

    // 選んだ四角で、重なった後ろのコマを隠すかどうか
    function toggleFront() {
        const s = selected();
        if (!s || s.type !== "rect") return;
        change(() => {
            if (s.front) delete s.front;
            else s.front = true;
        });
    }

    // 選んだ図形をいちばん手前（top）か、いちばん奥へ。手前のものほど重なったときに優先される
    function reorder(top) {
        const s = selected();
        if (!s) return;
        change(() => {
            const rest = ed.page.shapes.filter((x) => x !== s);
            ed.page.shapes = top ? [...rest, s] : [s, ...rest];
        });
    }

    function deleteSelected() {
        const s = selected();
        if (!s) return;
        change(() => {
            ed.page.shapes = ed.page.shapes.filter((x) => x !== s);
            ed.sel = null;
        });
    }

    function resizeCanvas() {
        const w = Math.round(Number(q(".ps-pg-w").value));
        const h = Math.round(Number(q(".ps-pg-h").value));
        if (!(w >= PAGE_MIN && w <= PAGE_MAX && h >= PAGE_MIN && h <= PAGE_MAX)) {
            alert(`キャンバスの大きさは ${PAGE_MIN}〜${PAGE_MAX} の整数で入れてください。`);
            updateTools();
            return;
        }
        change(() => {
            ed.page.width = w;
            ed.page.height = h;
        });
    }

    function updateTools() {
        if (!ed) return;
        const s = selected();
        view.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("mtm-active", b.dataset.tool === prefs.tool));
        const type = strokeType(s);
        const current = s ? s.stroke : prefs[type];
        view.querySelectorAll("[data-stroke]").forEach((b) => {
            const w = Number(b.dataset.stroke);
            // 素材とセリフには線がない
            b.classList.toggle("mtm-active", !noStroke(type) && w === current);
            b.disabled = (type === "line" && !w) || noStroke(type);
        });
        // 手描き線の書式の行
        const hlineShape = s && s.type === "hline" ? s : null;
        const hlineBar = prefs.tool === "hline" || !!hlineShape;
        q(".ps-pg-hlinebar").classList.toggle("ps-off", !hlineBar);
        if (hlineBar) fillHlineBar(hlineShape || prefs.hline, !!hlineShape);
        const textShape = s && s.type === "text" ? s : null;
        const textBar = prefs.tool === "text" || !!textShape;
        q(".ps-pg-textbar").classList.toggle("ps-off", !textBar);
        if (textBar) fillTextBar(textShape || prefs.text);
        q(".ps-pg-pick").disabled = !s || s.type !== "rect";
        q(".ps-pg-vertex-mode").classList.toggle("mtm-active", vertexMode);
        q(".ps-pg-squarify").disabled = !s || !s.pts;
        // 頂点の編集中は、最後に触った頂点の角度を出す
        const vinfo = q(".ps-pg-vinfo");
        if (vertexMode && s && s.type === "rect" && activeVertex >= 0) {
            const pts = cornersOf(s);
            const a = vertexAngles(pts, activeVertex);
            const p = pts[activeVertex];
            vinfo.textContent = `頂点 ${activeVertex + 1}：内角 ${a.inner.toFixed(1)}°　辺の傾き ${a.tilts[0].toFixed(1)}° / ${a.tilts[1].toFixed(1)}°　(${Math.round(p[0])}, ${Math.round(p[1])})`;
            vinfo.title = "内角はこの角の開き。辺の傾きは、この角につながる 2 本の辺の水平・垂直からのずれです";
        } else {
            vinfo.textContent = "";
        }
        q(".ps-pg-delete").disabled = !s;
        const front = q(".ps-pg-front");
        front.disabled = !s || s.type !== "rect";
        front.classList.toggle("mtm-active", !!(s && s.front));
        const shapes = ed.page.shapes;
        q(".ps-pg-raise").disabled = !s || shapes[shapes.length - 1] === s;
        q(".ps-pg-lower").disabled = !s || shapes[0] === s;
        q(".ps-pg-undo").disabled = !ed.undo.length;
        q(".ps-pg-redo").disabled = !ed.redo.length;
        if (document.activeElement !== q(".ps-pg-w")) q(".ps-pg-w").value = ed.page.width;
        if (document.activeElement !== q(".ps-pg-h")) q(".ps-pg-h").value = ed.page.height;
        q(".ps-pg-hint").textContent = prefs.tool === "sfx" && stampSource
            ? `${stampSource.kind === "stamp" ? "調整済みスタンプ" : "スタンプ"}「${stampSource.params.text}」：左クリックで 1 つ置いて選んだ状態にします（そのまま調整できます）。右クリックなら置いたあとも続けて置けます${prefs.sfxVary ? "（置くたびに形が少し変わります）" : ""}。Esc か V で選択に戻ります。`
            : balloonEdit && s && s.balloon
                ? "フキダシの頂点を編集します：丸をドラッグで動かす（Shift で水平か垂直だけ）、辺の真ん中の小さな丸をドラッグで頂点を足す（20 個まで）、頂点をダブルクリックで消す。矢印キーで最後に触った頂点を 1 px（Shift で 10 px）。"
            : vertexMode && s && s.type === "sfx"
                ? "字を 1 つずつ直します：字を押して選び、ドラッグで移動（Shift で縦か横だけ）、上の丸で回転（Shift で 15° ずつ）、右下の四角で大きさ。外枠の角の色付きの四角で、枠全体の大きさを変えます。矢印キーで 1 px（Shift で 10 px）。E で終わります。"
                : HINTS[prefs.tool] || "";
        q(".ps-pg-sfx-toggle").classList.toggle("mtm-active", prefs.sfxOpen);
        q(".ps-pg-sfx").classList.toggle("ps-off", !prefs.sfxOpen || !SFX());
        renderSfxPalette();
        updateFontSide();
        q(".ps-pg-stage").dataset.tool = prefs.tool;
        q(".ps-pg-where").textContent = ed.opts.title(ed.page);
        const nameInput = q(".ps-pg-name");
        if (document.activeElement !== nameInput) nameInput.value = ed.page.name || "";
        const project = q(".ps-pg-project");
        project.textContent = `← プロジェクト「${ed.opts.projectTitle ? ed.opts.projectTitle() : ""}」へ戻る`;
        project.classList.toggle("ps-off", !ed.opts.onProject);
        view.querySelectorAll("[data-count]").forEach((b) => b.classList.toggle("mtm-active", Number(b.dataset.count) === prefs.count));
        // 押したボタンが使えなくなったり隠れたりしてフォーカスが外れたら戻す
        if (!document.activeElement || document.activeElement === document.body) refocus();
    }

    // ---------- 描画 ----------

    // 画面の 1 ピクセルがページの何ピクセルか
    function unit() {
        const m = svg.getScreenCTM();
        return m && m.a ? 1 / m.a : 1;
    }

    function toPage(e) {
        const m = svg.getScreenCTM();
        if (!m) return {x: 0, y: 0};
        const p = svg.createSVGPoint();
        p.x = e.clientX;
        p.y = e.clientY;
        const r = p.matrixTransform(m.inverse());
        return {x: r.x, y: r.y};
    }

    function render() {
        const page = ed.page;
        // つまみが端で切れないよう、ページの周りに少し余白を取る
        const margin = Math.max(page.width, page.height) * 0.02;
        svg.setAttribute("viewBox", `${-margin} ${-margin} ${page.width + margin * 2} ${page.height + margin * 2}`);
        svg.textContent = "";
        const g = svgEl("g");
        drawPage(g, page, (ref) => ed.opts.resolve(ref, false), true);
        svg.appendChild(g);
        const u = unit();
        // カット案を対応させたコマには、左上にカット案の名前を出す（編集画面だけ。書き出しには入らない）
        for (const s of page.shapes) {
            const cut = s.type === "rect" && s.cut ? cutInfo(s.cut) : null;
            if (!cut) continue;
            const x = s.pts ? Math.min(...s.pts.map((p) => p[0])) : s.x;
            const y = s.pts ? Math.min(...s.pts.map((p) => p[1])) : s.y;
            const size = 13 * u;
            // コマの幅に収まらない名前は … で切る
            const fit = Math.max(2, Math.floor((s.w - 8 * u) / size) - 2);
            const label = "📌 " + shortText(cut.title, fit);
            const w = Math.min(s.w - 8 * u, ([...label].length + 1) * size);
            svg.appendChild(svgEl("g", {class: "ps-pg-cutlink"}, [
                svgEl("rect", {x: x + 4 * u, y: y + 4 * u, width: w, height: size * 1.6, rx: 3 * u}),
                svgEl("text", {x: x + 4 * u + size * 0.4, y: y + 4 * u + size * 0.8, "font-size": size, "dominant-baseline": "central", text: label}),
            ]));
        }
        // クリックを受ける面。四角は中ごと、直線は細くても掴めるよう太めに取る。直線を四角より手前にする
        const hits = svgEl("g", {class: "ps-pg-hits"});
        for (const s of page.shapes) {
            if (s.type === "rect" && s.pts) hits.appendChild(svgEl("polygon", {points: pointsAttr(s.pts), "data-id": s.id}));
            else if (s.type === "rect") hits.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, "data-id": s.id}));
        }
        for (const s of page.shapes) {
            if (s.type === "line") hits.appendChild(svgEl("line", {x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, "stroke-width": Math.max(s.stroke, 14 * u), "data-id": s.id}));
        }
        // 素材はいちばん上の層なので、クリックもいちばん手前で受ける
        // フキダシは持ち主のすぐ下で受ける（押すと持ち主を選ぶ）
        const balloonHit = (s) => s.balloon && hits.appendChild(svgEl("polygon", {points: pointsAttr(balloonPts(s)), "data-id": s.id}));
        for (const s of page.shapes) {
            // 手描き線は輪郭で受ける。細い線も掴めるよう、周りに太めの縁を足す
            if (s.type === "hline") {
                hits.appendChild(svgEl("polygon", {points: fmt1(hlineOutline(s)), stroke: "transparent", "stroke-width": 14 * u, "stroke-linejoin": "round", "data-id": s.id}));
                continue;
            }
            if (s.type !== "material" && s.type !== "sfx") continue;
            balloonHit(s);
            hits.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, "data-id": s.id}));
        }
        // セリフはさらに上
        for (const s of page.shapes) {
            if (s.type !== "text") continue;
            balloonHit(s);
            const b = textBox(s);
            hits.appendChild(svgEl("rect", {x: b.x, y: b.y, width: b.w, height: b.h, "data-id": s.id, class: "ps-pg-hit-text"}));
        }
        svg.appendChild(hits);
        const s = selected();
        if (s) svg.appendChild(drawSelection(s, u));
        updateTools();
    }

    function drawSelection(s, u) {
        const g = svgEl("g", {class: "ps-pg-sel"});
        const handle = (name, x, y) => svgEl("rect", {
            x: x - HANDLE * u / 2, y: y - HANDLE * u / 2, width: HANDLE * u, height: HANDLE * u,
            "data-handle": name, class: "ps-pg-handle ps-pg-handle-" + name,
        });
        // フキダシ。頂点の編集中（オノマトペ）は頂点の丸と、辺の真ん中の「頂点を足す」丸。でなければ外枠の 8 つのつまみ（菱形）
        if (s.balloon && (s.type === "text" || s.type === "sfx")) {
            const pts = balloonPts(s);
            g.appendChild(svgEl("polygon", {points: pointsAttr(pts), class: "ps-pg-sel-outline ps-pg-balloon-outline"}));
            if (balloonEdit && s.type === "sfx") {
                pts.forEach((p, i) => {
                    const n = pts[(i + 1) % pts.length];
                    if (pts.length < BALLOON_MAX) {
                        g.appendChild(svgEl("circle", {cx: (p[0] + n[0]) / 2, cy: (p[1] + n[1]) / 2, r: HANDLE * 0.45 * u, "data-handle": "bm" + i, class: "ps-pg-balloon-mid"}));
                    }
                });
                pts.forEach((p, i) => g.appendChild(svgEl("circle", {
                    cx: p[0], cy: p[1], r: HANDLE * 0.65 * u, "data-handle": "bv" + i,
                    class: "ps-pg-vertex ps-pg-balloon-vertex" + (i === activeBalloonVertex ? " ps-on" : ""),
                })));
                // 外枠の右上の外に、形をランダムに作り直すサイコロ
                const bb = boundsOf(pts);
                const r = 13 * u;
                const dx = bb.r + r + 6 * u, dy = bb.t - r - 6 * u;
                g.appendChild(svgEl("g", {class: "ps-pg-balloon-dice", "data-handle": "bdice"}, [
                    svgEl("title", {text: "フキダシの形をランダムに作り直します（外枠の大きさはそのまま）"}),
                    svgEl("circle", {cx: dx, cy: dy, r}),
                    svgEl("text", {x: dx, y: dy, "font-size": r * 1.2, "text-anchor": "middle", "dominant-baseline": "central", text: "🎲"}),
                ]));
            } else {
                const bb = boundsOf(pts);
                const xs = {w: bb.l, c: (bb.l + bb.r) / 2, e: bb.r};
                const ys = {n: bb.t, c: (bb.t + bb.b) / 2, s: bb.b};
                for (const name of RECT_HANDLES) {
                    const v = name.match(/[ns]/) ? name.match(/[ns]/)[0] : "c";
                    const hz = name.match(/[we]/) ? name.match(/[we]/)[0] : "c";
                    const h = handle("b" + name, xs[hz], ys[v]);
                    h.setAttribute("transform", `rotate(45 ${xs[hz]} ${ys[v]})`);
                    h.classList.add("ps-pg-balloon-handle", "ps-pg-handle-" + name);
                    g.appendChild(h);
                }
            }
        }
        // 字の手直し中のオノマトペは、字ごとの枠
        const fr = s.type === "sfx" && vertexMode && SFX() ? SFX().frames(s) : null;
        // セリフの大きさは文字の大きさで決まるので、つまみは出さない
        if (s.type === "text") {
            const b = textBox(s);
            g.appendChild(svgEl("rect", {x: b.x, y: b.y, width: b.w, height: b.h, class: "ps-pg-sel-outline"}));
        } else if (fr) {
            g.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, class: "ps-pg-sel-outline ps-pg-sel-faint"}));
            // 字の手直しのまま、枠全体の大きさも変えられるよう、外枠の角のつまみも出す（字のつまみより奥に置く）
            for (const [name, x, y] of [["nw", s.x, s.y], ["ne", s.x + s.w, s.y], ["se", s.x + s.w, s.y + s.h], ["sw", s.x, s.y + s.h]]) {
                const h = handle(name, x, y);
                h.classList.add("ps-pg-handle-frame");
                g.appendChild(h);
            }
            // 選んだ字を最後に描いて、つまみを手前にする
            const order = fr.glyphs.filter((f) => f.i !== activeGlyph).concat(fr.glyphs.filter((f) => f.i === activeGlyph));
            for (const f of order) {
                g.appendChild(svgEl("polygon", {points: pointsAttr(f.pts), "data-handle": "gm" + f.i, class: "ps-pg-glyph" + (f.i === activeGlyph ? " ps-on" : "")}));
                if (f.i !== activeGlyph) continue;
                const top = {x: (f.pts[0][0] + f.pts[1][0]) / 2, y: (f.pts[0][1] + f.pts[1][1]) / 2};
                const knob = {x: top.x + f.up.x * 28 * u, y: top.y + f.up.y * 28 * u};
                g.appendChild(svgEl("line", {x1: top.x, y1: top.y, x2: knob.x, y2: knob.y, class: "ps-pg-glyph-stick"}));
                g.appendChild(svgEl("circle", {cx: knob.x, cy: knob.y, r: HANDLE * 0.65 * u, "data-handle": "gr" + f.i, class: "ps-pg-vertex ps-pg-glyph-rot"}));
                const h = handle("gs" + f.i, f.pts[2][0], f.pts[2][1]);
                h.classList.add("ps-pg-glyph-size");
                g.appendChild(h);
            }
        } else if (s.type === "rect" && vertexMode) {
            const pts = cornersOf(s);
            g.appendChild(svgEl("polygon", {points: pointsAttr(pts), class: "ps-pg-sel-outline"}));
            pts.forEach((p, i) => g.appendChild(svgEl("circle", {
                cx: p[0], cy: p[1], r: HANDLE * 0.65 * u, "data-handle": "v" + i,
                class: "ps-pg-vertex" + (i === activeVertex ? " ps-on" : ""),
            })));
        } else if (boxy(s)) {
            if (s.pts) g.appendChild(svgEl("polygon", {points: pointsAttr(s.pts), class: "ps-pg-sel-outline"}));
            g.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, class: "ps-pg-sel-outline"}));
            const xs = {w: s.x, c: s.x + s.w / 2, e: s.x + s.w};
            const ys = {n: s.y, c: s.y + s.h / 2, s: s.y + s.h};
            // オノマトペは角のつまみだけ（字の大きさごと拡大・縮小する）
            for (const name of s.type === "sfx" ? ["nw", "ne", "se", "sw"] : RECT_HANDLES) {
                const v = name.match(/[ns]/) ? name.match(/[ns]/)[0] : "c";
                const h = name.match(/[we]/) ? name.match(/[we]/)[0] : "c";
                g.appendChild(handle(name, xs[h], ys[v]));
            }
        } else {
            g.appendChild(svgEl("line", {x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, class: "ps-pg-sel-outline"}));
            g.appendChild(handle("p1", s.x1, s.y1));
            g.appendChild(handle("p2", s.x2, s.y2));
        }
        return g;
    }

    // ---------- 操作 ----------

    // 吸着先。ページの端と中央、ほかの図形の端（動かしている図形は除く）
    function snapTargets(exceptId) {
        const xs = [0, ed.page.width / 2, ed.page.width];
        const ys = [0, ed.page.height / 2, ed.page.height];
        for (const s of ed.page.shapes) {
            if (s.id === exceptId) continue;
            if (boxy(s)) {
                xs.push(s.x, s.x + s.w);
                ys.push(s.y, s.y + s.h);
                for (const p of s.pts || []) {
                    xs.push(p[0]);
                    ys.push(p[1]);
                }
            } else {
                xs.push(s.x1, s.x2);
                ys.push(s.y1, s.y2);
            }
        }
        return {xs, ys};
    }

    // 近くの吸着先までのずれ。なければ null
    function snapOffset(values, targets) {
        if (!drag || drag.noSnap) return null;
        const limit = SNAP * drag.unit;
        let best = null;
        for (const v of values) {
            for (const t of targets) {
                const d = t - v;
                if (Math.abs(d) <= limit && (best === null || Math.abs(d) < Math.abs(best))) best = d;
            }
        }
        return best;
    }

    const snapX = (x) => x + (snapOffset([x], drag.targets.xs) || 0);
    const snapY = (y) => y + (snapOffset([y], drag.targets.ys) || 0);

    function inPage(p) {
        return {x: clamp(p.x, 0, ed.page.width), y: clamp(p.y, 0, ed.page.height)};
    }

    function pointerDown(e) {
        if (!ed) return;
        // スタンプモード：クリックした所にオノマトペを置く。
        // 文字列のスタンプも調整済みスタンプも、左クリックで 1 つ置いて選んだ状態にし（すぐ調整できる）、右クリックなら置いたあともスタンプを続ける
        if (prefs.tool === "sfx" && (e.button === 0 || e.button === 2)) {
            e.preventDefault();
            finishTextEdit(true);
            const once = e.button === 0 && !!stampSource;
            placeStamp(inPage(toPage(e))).then((s) => {
                if (!once || !s || !ed || !shapeOf(s.id)) return;
                setTool("select");
                select(s.id);
            });
            return;
        }
        if (e.button !== 0) return;
        e.preventDefault();
        const p = toPage(e);
        // セリフの道具：置いたセリフを押したら文字を直す。ほかの所なら新しく置く
        if (prefs.tool === "text") {
            const hit = e.target.closest("[data-id]");
            const s = hit && shapeOf(hit.dataset.id);
            if (s && s.type === "text") {
                if (!textEdit || textEdit.id !== s.id) startTextEdit(s, null);
            } else {
                finishTextEdit(true);
                createText(inPage(p));
            }
            return;
        }
        finishTextEdit(true);
        drag = {
            kind: "", id: "", start: p, client: {x: e.clientX, y: e.clientY}, moved: false,
            before: snapshot(), unit: unit(), noSnap: e.altKey, targets: null,
        };
        if (prefs.tool === "line" || prefs.tool === "hline" || prefs.tool === "rect" || prefs.tool === "tri") {
            drag.kind = prefs.tool === "line" || prefs.tool === "hline" ? "newline" : "newrect";
            drag.targets = snapTargets("");
            drag.start = inPage({x: snapX(p.x), y: snapY(p.y)});
        } else {
            const handle = e.target.closest("[data-handle]");
            const hit = e.target.closest("[data-id]");
            if (handle && selected()) {
                drag.kind = "handle";
                drag.handle = handle.dataset.handle;
                drag.id = ed.sel;
                const owner = selected();
                if (drag.handle === "bdice") {
                    drag = null;
                    randomBalloon();
                    return;
                }
                if (drag.handle.startsWith("bm")) {
                    // 辺の真ん中を押したら、そこに頂点を足して、その頂点を動かす
                    const i = Number(drag.handle.slice(2));
                    const pts = balloonPts(owner);
                    const n = pts[(i + 1) % pts.length];
                    pts.splice(i + 1, 0, [(pts[i][0] + n[0]) / 2, (pts[i][1] + n[1]) / 2]);
                    setBalloonPts(owner, pts);
                    drag.handle = "bv" + (i + 1);
                    drag.moved = true;      // 動かさなくても、足した頂点は 1 回の変更として残す
                }
                if (owner.balloon) drag.origBalloon = JSON.parse(JSON.stringify(owner.balloon));
                if (drag.handle.startsWith("bv")) {
                    const i = Number(drag.handle.slice(2));
                    // 同じ頂点を続けて 2 回押したら（ダブルクリック）、その頂点を消す。押すたびに描き直すので、dblclick は届かない
                    const now = Date.now();
                    const twice = lastBalloonPress.i === i && lastBalloonPress.id === owner.id && now - lastBalloonPress.at < DOUBLE_PRESS;
                    lastBalloonPress = twice ? {i: -1, id: "", at: 0} : {i, id: owner.id, at: now};
                    if (twice) {
                        drag = null;
                        deleteBalloonVertex(i);
                        return;
                    }
                    activeBalloonVertex = i;
                    render();
                } else if (drag.handle[0] === "v") {
                    activeVertex = Number(drag.handle.slice(1));
                    drag.origPts = cornersOf(selected());
                    render();
                } else if (drag.handle[0] === "g") {
                    // 字の手直し。動かし始めの字の位置と設定を覚えておく
                    activeGlyph = Number(drag.handle.slice(2));
                    drag.origParams = cloneParams(selected().params);
                    drag.frames = SFX().frames(selected());
                    if (!drag.frames) {
                        drag = null;
                        return;
                    }
                    render();
                }
            } else if (hit) {
                drag.kind = "move";
                drag.id = hit.dataset.id;
                drag.wasSelected = ed.sel === drag.id;
                const src = shapeOf(drag.id);
                if ((e.ctrlKey || e.metaKey) && src && src.type === "sfx") {
                    // Ctrl を押しながらドラッグで複製する。複製をいちばん手前に足して、それを動かす（動かさなければ足さない）
                    const copy = {...JSON.parse(JSON.stringify(src)), id: newId()};
                    ed.page.shapes.push(copy);
                    drag.dupOf = src.id;
                    drag.id = copy.id;
                    drag.wasSelected = false;
                    select(copy.id);
                } else if (!drag.wasSelected) select(drag.id);
            } else {
                drag = null;
                if (ed.sel) select(null);
                return;
            }
            drag.orig = {...shapeOf(drag.id)};
            drag.targets = snapTargets(drag.id);
        }
        svg.setPointerCapture(e.pointerId);
    }

    function pointerMove(e) {
        if (!drag) return;
        if (!drag.moved) {
            if (Math.hypot(e.clientX - drag.client.x, e.clientY - drag.client.y) < CLICK_MOVE) return;
            drag.moved = true;
        }
        drag.noSnap = e.altKey;
        const p = toPage(e);
        if (drag.kind === "newline") dragNewLine(p, e.shiftKey);
        else if (drag.kind === "newrect") dragNewRect(p, e.shiftKey);
        else if (drag.kind === "move") dragMove(p);
        else if (drag.kind === "handle") dragHandle(p, e.shiftKey);
        render();
    }

    function ensureShape(make) {
        let s = drag.id && shapeOf(drag.id);
        if (!s) {
            s = make();
            ed.page.shapes.push(s);
            drag.id = s.id;
        }
        return s;
    }

    function dragNewLine(p, shift) {
        const a = drag.start;
        let b = inPage({x: snapX(p.x), y: snapY(p.y)});
        if (shift) b = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? {x: b.x, y: a.y} : {x: a.x, y: b.y};
        const s = ensureShape(() => (prefs.tool === "hline"
            ? {id: newId(), type: "hline", x1: 0, y1: 0, x2: 0, y2: 0, ...cleanHlineStyle(prefs.hline), seed: SFX() ? SFX().randomSeed() : 1, name: "", x: 0, y: 0, w: 0, h: 0}
            : {id: newId(), type: "line", x1: 0, y1: 0, x2: 0, y2: 0, stroke: prefs.line || 4}));
        Object.assign(s, {x1: round1(a.x), y1: round1(a.y), x2: round1(b.x), y2: round1(b.y)});
    }

    function dragNewRect(p, shift) {
        const a = drag.start;
        let b = inPage({x: snapX(p.x), y: snapY(p.y)});
        if (shift) {
            const size = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
            b = inPage({x: a.x + Math.sign(b.x - a.x || 1) * size, y: a.y + Math.sign(b.y - a.y || 1) * size});
        }
        const s = ensureShape(() => ({id: newId(), type: "rect", x: 0, y: 0, w: 0, h: 0, stroke: prefs.rect, image: null}));
        Object.assign(s, {
            x: round1(Math.min(a.x, b.x)), y: round1(Math.min(a.y, b.y)),
            w: round1(Math.abs(b.x - a.x)), h: round1(Math.abs(b.y - a.y)),
        });
        // 三角は枠の上の辺の真ん中を頂点にする。上へドラッグしたら下向き
        if (prefs.tool === "tri") {
            const l = s.x, r = s.x + s.w, t = s.y, bt = s.y + s.h, cx = s.x + s.w / 2;
            s.pts = (b.y >= a.y ? [[cx, t], [r, bt], [l, bt]] : [[l, t], [r, t], [cx, bt]]).map((p) => [round1(p[0]), round1(p[1])]);
        }
    }

    // 図形ごと動かす。ページの外には出さない。端のどちらかが近くの吸着先にそろう
    function dragMove(p) {
        const s = shapeOf(drag.id);
        const o = drag.orig;
        let dx = p.x - drag.start.x;
        let dy = p.y - drag.start.y;
        if (floating(s)) {
            dx += snapOffset([o.x + dx, o.x + o.w + dx], drag.targets.xs) || 0;
            dy += snapOffset([o.y + dy, o.y + o.h + dy], drag.targets.ys) || 0;
            placeMaterial(s, o.x + dx, o.y + dy);
        } else if (s.type === "rect") {
            dx = clamp(dx, -o.x, ed.page.width - o.w - o.x);
            dy = clamp(dy, -o.y, ed.page.height - o.h - o.y);
            dx += snapOffset([o.x + dx, o.x + o.w + dx], drag.targets.xs) || 0;
            dy += snapOffset([o.y + dy, o.y + o.h + dy], drag.targets.ys) || 0;
            s.x = round1(clamp(o.x + dx, 0, ed.page.width - o.w));
            s.y = round1(clamp(o.y + dy, 0, ed.page.height - o.h));
            if (o.pts) s.pts = o.pts.map((p) => [round1(p[0] + s.x - o.x), round1(p[1] + s.y - o.y)]);
        } else {
            const minX = Math.min(o.x1, o.x2), maxX = Math.max(o.x1, o.x2);
            const minY = Math.min(o.y1, o.y2), maxY = Math.max(o.y1, o.y2);
            dx = clamp(dx, -minX, ed.page.width - maxX);
            dy = clamp(dy, -minY, ed.page.height - maxY);
            dx += snapOffset([o.x1 + dx, o.x2 + dx], drag.targets.xs) || 0;
            dy += snapOffset([o.y1 + dy, o.y2 + dy], drag.targets.ys) || 0;
            dx = clamp(dx, -minX, ed.page.width - maxX);
            dy = clamp(dy, -minY, ed.page.height - maxY);
            Object.assign(s, {x1: round1(o.x1 + dx), y1: round1(o.y1 + dy), x2: round1(o.x2 + dx), y2: round1(o.y2 + dy)});
        }
    }

    function dragHandle(p, shift) {
        const s = shapeOf(drag.id);
        const o = drag.orig;
        if (drag.handle[0] === "b" && drag.origBalloon) {
            dragBalloon(s, p, shift);
            return;
        }
        if (s.type === "material") {
            resizeMaterial(s, o, {x: snapX(p.x), y: snapY(p.y)}, shift);
            return;
        }
        if (s.type === "sfx" && drag.handle[0] === "g") {
            dragGlyph(s, p, shift);
            return;
        }
        if (s.type === "sfx") {
            resizeSfx(s, o, p);
            return;
        }
        if (drag.handle[0] === "v") {
            // 頂点を動かす。Shift なら元の位置から水平か垂直だけ（台形・平行四辺形の辺の傾きを作りやすい）
            const i = Number(drag.handle.slice(1));
            const from = drag.origPts[i];
            let v = inPage({x: snapX(p.x), y: snapY(p.y)});
            if (shift) v = Math.abs(v.x - from[0]) >= Math.abs(v.y - from[1]) ? {x: v.x, y: from[1]} : {x: from[0], y: v.y};
            moveVertex(s, i, v);
            return;
        }
        const q2 = inPage({x: snapX(p.x), y: snapY(p.y)});
        if (s.type === "line" || s.type === "hline") {
            const fixed = drag.handle === "p1" ? {x: o.x2, y: o.y2} : {x: o.x1, y: o.y1};
            let b = q2;
            if (shift) b = Math.abs(b.x - fixed.x) >= Math.abs(b.y - fixed.y) ? {x: b.x, y: fixed.y} : {x: fixed.x, y: b.y};
            if (drag.handle === "p1") Object.assign(s, {x1: round1(b.x), y1: round1(b.y)});
            else Object.assign(s, {x2: round1(b.x), y2: round1(b.y)});
            return;
        }
        // 動かしている辺だけを変える。反対側の辺を越えないよう、最小の大きさを残す
        let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
        if (drag.handle.includes("w")) l = Math.min(q2.x, r - MIN_SIZE);
        if (drag.handle.includes("e")) r = Math.max(q2.x, l + MIN_SIZE);
        if (drag.handle.includes("n")) t = Math.min(q2.y, b - MIN_SIZE);
        if (drag.handle.includes("s")) b = Math.max(q2.y, t + MIN_SIZE);
        Object.assign(s, {x: round1(l), y: round1(t), w: round1(r - l), h: round1(b - t)});
        // 多角形は外枠に合わせて頂点を伸び縮みさせる
        if (o.pts) {
            setPoints(s, o.pts.map((pt) => [l + (pt[0] - o.x) * (r - l) / o.w, t + (pt[1] - o.y) * (b - t) / o.h]));
        }
    }

    // フキダシ。bv は頂点を動かす（Shift で元の位置から水平か垂直だけ）。b + 向き（bnw など）は外枠の大きさを変え、頂点を外枠に合わせて伸び縮みさせる
    function dragBalloon(s, p, shift) {
        const c = ownerCenter(s);
        const orig = drag.origBalloon.pts.map((q) => [c.x + q[0], c.y + q[1]]);
        const h = drag.handle;
        if (h.startsWith("bv")) {
            const i = Number(h.slice(2));
            let v = {x: p.x, y: p.y};
            if (shift) v = Math.abs(v.x - orig[i][0]) >= Math.abs(v.y - orig[i][1]) ? {x: v.x, y: orig[i][1]} : {x: orig[i][0], y: v.y};
            const pts = orig.slice();
            pts[i] = [v.x, v.y];
            if (Math.abs(polyArea(pts)) < MIN_SIZE * MIN_SIZE) return;
            setBalloonPts(s, pts);
            return;
        }
        const bb = boundsOf(orig);
        let l = bb.l, t = bb.t, r = bb.r, b = bb.b;
        if (h.includes("w")) l = Math.min(p.x, r - MIN_SIZE);
        if (h.includes("e")) r = Math.max(p.x, l + MIN_SIZE);
        if (h.includes("n")) t = Math.min(p.y, b - MIN_SIZE);
        if (h.includes("s")) b = Math.max(p.y, t + MIN_SIZE);
        const sx = (r - l) / Math.max(bb.r - bb.l, 1e-6), sy = (b - t) / Math.max(bb.b - bb.t, 1e-6);
        setBalloonPts(s, orig.map((q) => [l + (q[0] - bb.l) * sx, t + (q[1] - bb.t) * sy]));
    }

    // 字の手直し。gm は字を動かす（Shift で縦か横だけ）、gr は字の真ん中を軸に回す（Shift で 15° ずつ）、gs は大きさを変える
    function dragGlyph(s, p, shift) {
        const i = activeGlyph;
        const f = drag.frames.glyphs[i];
        if (!f) return;
        const g = glyphOf(drag.origParams, i);
        const kind = drag.handle.slice(0, 2);
        if (kind === "gm") {
            let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
            if (shift) Math.abs(dx) >= Math.abs(dy) ? (dy = 0) : (dx = 0);
            const d = drag.frames.toLocal(dx, dy);
            g.x += d.x;
            g.y += d.y;
        } else if (kind === "gr") {
            const a0 = Math.atan2(drag.start.y - f.c.y, drag.start.x - f.c.x);
            const a1 = Math.atan2(p.y - f.c.y, p.x - f.c.x);
            let rot = g.rot + (a1 - a0) * 180 / Math.PI;
            rot = ((rot + 540) % 360) - 180;
            if (shift) rot = Math.round(rot / 15) * 15;
            g.rot = rot;
        } else {
            const d0 = Math.hypot(drag.start.x - f.c.x, drag.start.y - f.c.y) || 1;
            g.size = clamp(g.size * Math.hypot(p.x - f.c.x, p.y - f.c.y) / d0, 10, 400);
        }
        const params = cloneParams(drag.origParams);
        setGlyph(params, i, g);
        s.params = SFX().clean(params);
        SFX().refit(s, {...drag.orig, params: drag.origParams});
    }

    // 素材の大きさを変える。角のつまみは反対の角を止めて縦横比を保つ（free なら自由に）。辺のつまみはその向きだけ伸び縮みする。
    // ページからはみ出してよい
    function resizeMaterial(s, o, p, free) {
        const h = drag.handle;
        let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
        if (h.length === 2 && !free) {
            const ax = h.includes("w") ? r : l;
            const ay = h.includes("n") ? b : t;
            const scale = Math.max(MIN_SIZE / Math.min(o.w, o.h), Math.abs(p.x - ax) / o.w, Math.abs(p.y - ay) / o.h);
            const w = o.w * scale, hh = o.h * scale;
            l = h.includes("w") ? ax - w : ax;
            t = h.includes("n") ? ay - hh : ay;
            r = l + w;
            b = t + hh;
        } else {
            if (h.includes("w")) l = Math.min(p.x, r - MIN_SIZE);
            if (h.includes("e")) r = Math.max(p.x, l + MIN_SIZE);
            if (h.includes("n")) t = Math.min(p.y, b - MIN_SIZE);
            if (h.includes("s")) b = Math.max(p.y, t + MIN_SIZE);
        }
        Object.assign(s, {x: round1(l), y: round1(t), w: round1(r - l), h: round1(b - t)});
    }

    function pointerUp(e) {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
        if (d.kind === "newline" || d.kind === "newrect") {
            const s = d.id && shapeOf(d.id);
            const small = s && (s.type === "line" || s.type === "hline" ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < MIN_SIZE : s.w < MIN_SIZE || s.h < MIN_SIZE);
            // 描き終えたら選択は外す。続けて描ける
            ed.sel = null;
            if (s && small) ed.page.shapes = ed.page.shapes.filter((x) => x !== s);
            if (s && !small) {
                pushUndo(d.before);
                commit();
            } else {
                render();
            }
            return;
        }
        if (d.moved) {
            if (snapshot() !== d.before) {
                pushUndo(d.before);
                commit();
            }
            return;
        }
        // Ctrl+クリックだけ（動かさなかった）なら、複製は足さずに元のオノマトペを選ぶ
        if (d.dupOf) {
            ed.page.shapes = ed.page.shapes.filter((x) => x.id !== d.id);
            select(d.dupOf);
            return;
        }
        // 選んであった四角をもう一度クリックしたら、はめ込む画像を選ぶ
        // 選んであったセリフをもう一度クリックしたら、文字を直す
        const s = shapeOf(d.id);
        // 選んでいるオノマトペをダブルクリックしたら、字を 1 つずつ直す の入り・切りを切り替える。
        // ドラッグのために押した所を捕まえているので、dblclick はキャンバス全体に届いてしまい、どの図形か分からない。押した間隔で見分ける
        // 字の手直し中は字が枠のほとんどを覆うので、字をダブルクリックしても切る
        const glyphPress = d.kind === "handle" && d.handle && d.handle.startsWith("gm");
        if ((d.kind === "move" || glyphPress) && s && s.type === "sfx") {
            const now = Date.now();
            const twice = (d.wasSelected || glyphPress) && lastSfxClick.id === s.id && now - lastSfxClick.at < DOUBLE_PRESS;
            lastSfxClick = twice ? {id: "", at: 0} : {id: s.id, at: now};
            if (twice) toggleVertexMode();
        }
        if (d.kind === "move" && d.wasSelected && s && s.type === "rect") openPicker(s);
        if (d.kind === "move" && d.wasSelected && s && s.type === "text") startTextEdit(s, null);
    }

    function cancelDrag() {
        const d = drag;
        drag = null;
        if (snapshot() !== d.before) restoreSilently(d.before);
        render();
    }

    function restoreSilently(state) {
        const data = JSON.parse(state);
        Object.assign(ed.page, {width: data.width, height: data.height, shapes: data.shapes});
        if (!selected()) ed.sel = null;
    }

    function nudge(dx, dy) {
        const s = selected();
        if (!s) return;
        // フキダシの頂点の編集中は、最後に触った頂点だけを動かす
        if (balloonEdit && s.balloon && activeBalloonVertex >= 0 && activeBalloonVertex < s.balloon.pts.length) {
            const i = activeBalloonVertex;
            change(() => (s.balloon = {...s.balloon, pts: s.balloon.pts.map((p, j) => (j === i ? [round1(p[0] + dx), round1(p[1] + dy)] : p))}));
            return;
        }
        // 字の手直し中は、選んだ字だけを動かす
        if (s.type === "sfx" && vertexMode && activeGlyph >= 0) {
            const fr = SFX().frames(s);
            if (!fr) return;
            const d = fr.toLocal(dx, dy);
            editSfx((p) => {
                const g = glyphOf(p, activeGlyph);
                setGlyph(p, activeGlyph, {...g, x: g.x + d.x, y: g.y + d.y});
            }, true, true);
            return;
        }
        change(() => {
            if (floating(s)) {
                placeMaterial(s, s.x + dx, s.y + dy);
            } else if (s.type === "rect" && vertexMode && activeVertex >= 0) {
                // 頂点の編集中は、最後に触った頂点だけを動かす
                const p = cornersOf(s)[activeVertex];
                moveVertex(s, activeVertex, inPage({x: p[0] + dx, y: p[1] + dy}));
            } else if (s.type === "rect") {
                const ox = s.x, oy = s.y;
                s.x = round1(clamp(s.x + dx, 0, ed.page.width - s.w));
                s.y = round1(clamp(s.y + dy, 0, ed.page.height - s.h));
                if (s.pts) s.pts = s.pts.map((p) => [round1(p[0] + s.x - ox), round1(p[1] + s.y - oy)]);
            } else {
                const minX = Math.min(s.x1, s.x2), maxX = Math.max(s.x1, s.x2);
                const minY = Math.min(s.y1, s.y2), maxY = Math.max(s.y1, s.y2);
                dx = clamp(dx, -minX, ed.page.width - maxX);
                dy = clamp(dy, -minY, ed.page.height - maxY);
                Object.assign(s, {x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy});
            }
        });
    }

    // polaris_projects.js から、編集画面を開いている間のキー操作をすべて渡される
    function keydown(e) {
        if (!ed) return;
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
        const stop = () => {
            e.preventDefault();
            e.stopPropagation();
        };
        // フォント選びを開いている間は、Esc で閉じるほかは検索欄に任せる
        if (isFontPickerOpen()) {
            if (e.key === "Escape") {
                stop();
                closeFontPicker(false);
            }
            return;
        }
        // セリフの入力中は、Esc（取り消し）と Ctrl+Enter（決定）のほかは入力欄に任せる
        if (textEdit) {
            if (e.key === "Escape") {
                stop();
                finishTextEdit(false);
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
                stop();
                finishTextEdit(true);
            }
            return;
        }
        if (e.key === "Escape") {
            stop();
            // 画像の一覧ではカット案の一覧に戻る
            if (isCropOpen() && !crop.image && crop.pickCut) showPicker();
            else if (isCropOpen()) closeCrop();
            else if (drag) cancelDrag();
            else if (typing) e.target.blur();
            else if (prefs.tool === "sfx") setTool("select");
            else if (balloonEdit) toggleBalloonEdit();
            else if (ed.sel) select(null);
            else close();
            return;
        }
        if (isCropOpen()) {
            if (e.key === "Enter" && !e.isComposing && crop.image) {
                stop();
                acceptCrop();
            }
            return;
        }
        if (typing) return;
        const ctrl = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (ctrl && key === "z") {
            stop();
            if (e.shiftKey) redo();
            else undo();
        } else if (ctrl && key === "y") {
            stop();
            redo();
        } else if (ctrl || e.altKey) {
            return;
        } else if (e.key === "PageDown" || e.key === "PageUp") {
            // ホイールと同じく、前後のコマページへ
            stop();
            if (!drag) switchPage(e.key === "PageDown" ? 1 : -1);
        } else if (e.key === "Delete" || e.key === "Backspace") {
            stop();
            deleteSelected();
        } else if (e.key.startsWith("Arrow")) {
            if (!selected()) return;
            stop();
            const step = e.shiftKey ? 10 : 1;
            nudge({ArrowLeft: -step, ArrowRight: step}[e.key] || 0, {ArrowUp: -step, ArrowDown: step}[e.key] || 0);
        } else if (key === "v" || key === "l" || key === "w" || key === "r" || key === "y" || key === "t") {
            stop();
            setTool({v: "select", l: "line", w: "hline", r: "rect", y: "tri", t: "text"}[key]);
        } else if (key === "e") {
            stop();
            toggleVertexMode();
        } else if (key === "o") {
            stop();
            toggleSfxPalette();
        } else if (key === "g" && selected() && selected().type === "sfx") {
            stop();
            rerollSfx();
        } else if (key === "g" && selected() && selected().type === "hline") {
            stop();
            rerollHline();
        } else if (key === "b" && selected() && (selected().type === "text" || selected().type === "sfx")) {
            stop();
            toggleBalloon();
        } else if (key === "h" && selected()) {
            stop();
            toggleFront();
        } else if ((e.key === "]" || e.key === "[") && selected()) {
            stop();
            reorder(e.key === "]");
        } else if (e.key === "Enter" && selected() && selected().type === "rect") {
            stop();
            openPicker(selected());
        } else if (e.key === "Enter" && selected() && selected().type === "text") {
            stop();
            startTextEdit(selected(), null);
        }
    }

    // ---------- 画像の選択とクロップ ----------
    // 1. カット案を選ぶ  2. そのカット案の画像から 1 枚選ぶ  3. 画像の上に四角と同じ縦横比の枠を出して、はめ込む範囲を決める

    // mode: "cover"（拡大して合わせる。枠は画像の中で自由な大きさ）か "full"（原寸。枠は四角と同じ大きさで、画像からはみ出してよい）
    // pickCut は画像の一覧を出しているカット案の id（カット案の一覧では ""）
    const crop = {rect: null, image: null, pickCut: "", mode: "cover", iw: 0, ih: 0, x: 0, y: 0, w: 0, h: 0, scale: 1, ox: 0, oy: 0, drag: null};
    let lastPickCut = "";       // 前に画像を選んだカット案。カット案の一覧で印を付ける
    const isCropOpen = () => view && !q(".ps-pg-crop").classList.contains("ps-off");

    function buildCrop() {
        q(".ps-pg-crop-cancel").addEventListener("click", closeCrop);
        q(".ps-pg-crop-ok").addEventListener("click", acceptCrop);
        // 選び直すときは、いま選んでいる画像のカット案の画像一覧に戻る
        q(".ps-pg-crop-repick").addEventListener("click", () => (crop.image ? showCutImages(crop.image.cutId) : showPicker()));
        q(".ps-pg-pick-back").addEventListener("click", () => showPicker());
        // 開いているカット案を、このコマに対応させる（もう対応していれば外す）。画像は選ばなくてよい
        q(".ps-pg-pick-link").addEventListener("click", () => {
            const rect = crop.rect;
            const cutId = crop.pickCut;
            if (!rect || !cutId) return;
            change(() => {
                if (rect.cut === cutId) delete rect.cut;
                else rect.cut = cutId;
            });
            showCutImages(cutId);
        });
        // 「お気に入りのみ」は覚えておき、次に開くときも同じ状態にする。いま出している一覧を作り直す
        q(".ps-pg-favonly-check").addEventListener("change", (e) => {
            prefs.favOnly = e.target.checked;
            savePrefs();
            if (crop.pickCut) showCutImages(crop.pickCut);
            else showPicker();
        });
        q(".ps-pg-crop-remove").addEventListener("click", () => {
            const rect = crop.rect;
            closeCrop();
            change(() => (rect.image = null));
        });
        // 背景を押したら閉じる
        q(".ps-pg-crop").addEventListener("mousedown", (e) => {
            if (e.target === e.currentTarget) closeCrop();
        });
        view.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setCropMode(b.dataset.mode)));
        const frame = q(".ps-pg-frame");
        frame.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const corner = crop.mode === "full" ? "" : e.target.dataset.corner || "";
            crop.drag = {corner, client: {x: e.clientX, y: e.clientY}, orig: {x: crop.x, y: crop.y, w: crop.w, h: crop.h}};
            frame.setPointerCapture(e.pointerId);
        });
        frame.addEventListener("pointermove", (e) => {
            const d = crop.drag;
            if (!d) return;
            const dx = (e.clientX - d.client.x) / crop.scale;
            const dy = (e.clientY - d.client.y) / crop.scale;
            if (!d.corner) {
                crop.x = d.orig.x + dx;
                crop.y = d.orig.y + dy;
            } else {
                // 反対の角を止めたまま、縦横比を保って大きさを変える
                const o = d.orig;
                const aspect = cropAspect();
                const left = d.corner.includes("w"), top = d.corner.includes("n");
                const ax = left ? o.x + o.w : o.x;
                const ay = top ? o.y + o.h : o.y;
                const px = (left ? o.x : o.x + o.w) + dx;
                const py = (top ? o.y : o.y + o.h) + dy;
                const roomW = left ? ax : crop.iw - ax;
                const roomH = top ? ay : crop.ih - ay;
                let w = Math.max(Math.abs(px - ax), Math.abs(py - ay) * aspect);
                w = clamp(w, Math.min(CROP_MIN, roomW), Math.min(roomW, roomH * aspect));
                crop.w = w;
                crop.h = w / aspect;
                crop.x = left ? ax - w : ax;
                crop.y = top ? ay - crop.h : ay;
            }
            clampCrop();
            placeFrame();
        });
        const end = () => (crop.drag = null);
        frame.addEventListener("pointerup", end);
        frame.addEventListener("pointercancel", end);
        // ホイールで枠を大きく・小さくする（中心は動かさない）。原寸では大きさは変わらない
        q(".ps-pg-cropstage").addEventListener("wheel", (e) => {
            if (!crop.image) return;
            e.preventDefault();
            if (crop.mode === "full") return;
            const factor = e.deltaY < 0 ? 1 / 1.1 : 1.1;
            const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
            crop.w *= factor;
            crop.h = crop.w / cropAspect();
            crop.x = cx - crop.w / 2;
            crop.y = cy - crop.h / 2;
            clampCrop();
            placeFrame();
        }, {passive: false});
        q(".ps-pg-cropimg").addEventListener("load", imageLoaded);
        new ResizeObserver(() => {
            if (crop.image && isCropOpen()) placeFrame();
        }).observe(q(".ps-pg-cropstage"));
    }

    const cropAspect = () => crop.rect.w / crop.rect.h;

    // 拡大して合わせる：枠は画像の中に収める。縦横比は四角と同じ。
    // 原寸：枠は四角と同じ大きさ。画像より大きい向きは画像を枠の中に収め、小さい向きは枠を画像の中に収める
    function clampCrop() {
        if (crop.mode === "full") {
            crop.w = crop.rect.w;
            crop.h = crop.rect.h;
            const dx = crop.iw - crop.w, dy = crop.ih - crop.h;
            crop.x = clamp(crop.x, Math.min(0, dx), Math.max(0, dx));
            crop.y = clamp(crop.y, Math.min(0, dy), Math.max(0, dy));
            return;
        }
        const aspect = cropAspect();
        const maxW = Math.min(crop.iw, crop.ih * aspect);
        crop.w = clamp(crop.w, Math.min(CROP_MIN, maxW), maxW);
        crop.h = crop.w / aspect;
        crop.x = clamp(crop.x, 0, crop.iw - crop.w);
        crop.y = clamp(crop.y, 0, crop.ih - crop.h);
    }

    // 置き方を切り替える。枠の中心はそのまま
    function setCropMode(mode) {
        mode = mode === "full" ? "full" : "cover";
        prefs.cropMode = mode;
        savePrefs();
        if (!crop.image || !crop.iw || crop.mode === mode) {
            crop.mode = mode;
            if (crop.image && crop.iw) placeFrame();
            return;
        }
        const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
        crop.mode = mode;
        // 拡大して合わせるに戻すときは、画像に収まる一番大きい枠にする
        if (mode === "cover") crop.w = crop.iw;
        crop.h = crop.w / cropAspect();
        clampCrop();
        crop.x = cx - crop.w / 2;
        crop.y = cy - crop.h / 2;
        clampCrop();
        placeFrame();
    }

    function openPicker(rect) {
        if (drag) cancelDrag();
        crop.rect = rect;
        crop.image = null;
        q(".ps-pg-crop").classList.remove("ps-off");
        // はめ込み済みなら、その画像の範囲を直すところから始める
        const url = rect.image && ed.opts.resolve(rect.image, false);
        if (url) startCrop({cutId: rect.image.cutId, name: rect.image.name}, url);
        // カット案を対応させたコマは、そのカット案の画像から始める
        else if (rect.cut && cutInfo(rect.cut)) showCutImages(rect.cut);
        else showPicker();
    }

    const cutInfo = (id) => (ed.opts.cuts ? ed.opts.cuts().find((c) => c.id === id) : null) || null;

    // 画像を選ぶ段階（カット案の一覧と画像の一覧）の共通の見た目にする
    function pickStep(title, note) {
        crop.image = null;
        q(".ps-pg-crop-title").textContent = title;
        q(".ps-pg-crop-info").textContent = `コマ ${Math.round(crop.rect.w)} × ${Math.round(crop.rect.h)}`;
        q(".ps-pg-crop-note").textContent = note;
        q(".ps-pg-crop-note").classList.remove("ps-pg-warn");
        q(".ps-pg-pick-back").classList.toggle("ps-off", !crop.pickCut);
        const link = q(".ps-pg-pick-link");
        const linked = !!crop.pickCut && crop.rect.cut === crop.pickCut;
        link.classList.toggle("ps-off", !crop.pickCut);
        link.classList.toggle("mtm-active", linked);
        link.textContent = linked ? "📌 このコマに対応中（外す）" : "📌 このコマに対応させる";
        link.title = linked ? "このコマとカット案の対応を外します" : "このカット案をこのコマ用として覚えておきます。次からこのコマで「画像を選ぶ」と、このカット案の画像から始まります（ほかのカット案の画像も選べます）";
        q(".ps-pg-favonly").classList.remove("ps-off");
        q(".ps-pg-favonly-check").checked = prefs.favOnly;
        q(".ps-pg-cropstage").classList.add("ps-off");
        q(".ps-pg-cropmode").classList.add("ps-off");
        q(".ps-pg-crop-ok").classList.add("ps-off");
        q(".ps-pg-crop-repick").classList.add("ps-off");
        q(".ps-pg-crop-remove").classList.toggle("ps-off", !crop.rect.image);
        const grid = q(".ps-pg-pickgrid");
        grid.classList.remove("ps-off");
        grid.textContent = "";
        grid.scrollTop = 0;
        refocus();
        return grid;
    }

    // 左上の印。コマで使っている印（この Book のコマで使っている画像、カット案ではその画像のどれか）と、その隣にお気に入り。
    // favorites はお気に入りの枚数（カット案）か true（画像）
    function pickMarks(panels, favorites) {
        const marks = [];
        if (panels && panels.length && ed.opts.panelMark) marks.push(ed.opts.panelMark(panels));
        if (favorites && ed.opts.favoriteMark) {
            const mark = ed.opts.favoriteMark();
            if (typeof favorites === "number") {
                mark.textContent = "♥" + (favorites > 1 ? favorites : "");
                mark.title = `お気に入り ${favorites} 枚`;
            }
            marks.push(mark);
        }
        return marks.length ? [el("span", {class: "ps-pg-pickmarks"}, marks)] : [];
    }

    // 1. カット案の一覧。シーンごとに見出しを付け、キー画像と枚数を出す。画像のないカット案は選べない。
    // 「お気に入りのみ」では、お気に入りのあるカット案だけを出し、枚数もお気に入りの枚数にする
    function showPicker() {
        crop.pickCut = "";
        const favOnly = prefs.favOnly;
        const grid = pickStep("はめ込む画像を選択", "カット案を選ぶと、そのカット案の画像を一覧で出します");
        const all = ed.opts.cuts();
        const cuts = favOnly ? all.filter((c) => c.favorites) : all;
        if (!cuts.length) {
            grid.appendChild(el("div", {class: "mtm-empty", text: !all.length ? "カット案がありません。"
                : "お気に入りの画像のあるカット案がありません。サムネイル一覧のビューワーの「♡ お気に入り」（F キー）で付けられます。"}));
        }
        const current = crop.rect.image ? crop.rect.image.cutId : crop.rect.cut || lastPickCut;
        const linkedCut = crop.rect.cut || "";
        let scene = null;
        let focus = null;
        for (const c of cuts) {
            if (c.scene !== scene) {
                scene = c.scene;
                grid.appendChild(el("div", {class: "ps-pg-pickscene", text: scene || "（名前のないシーン）"}));
            }
            const count = favOnly ? `♥ ${c.favorites} / ${c.count} 枚` : c.count + " 枚";
            const item = el("button", {
                type: "button", class: "ps-pg-pickitem ps-pg-pickcut" + (c.id === current ? " ps-on" : ""),
                title: `${c.title}\n${c.count} 枚` + (c.favorites ? `（お気に入り ${c.favorites} 枚）` : ""), onclick: () => showCutImages(c.id),
            }, [
                c.thumb ? el("img", {src: c.thumb, alt: "", loading: "lazy", draggable: "false"}) : el("span", {class: "ps-pg-pickempty", text: "画像なし"}),
                ...pickMarks(c.panels, c.favorites),
                ...(c.id === linkedCut ? [el("span", {class: "ps-pg-picklink", text: "📌", title: "このコマに対応させたカット案"})] : []),
                el("span", {class: "ps-pg-pickitem-count", text: count}),
                el("span", {class: "ps-pg-pickitem-label", text: c.title}),
            ]);
            if (!c.count) item.disabled = true;
            if (c.id === current) focus = item;
            grid.appendChild(item);
        }
        if (focus) focus.scrollIntoView({block: "nearest"});
    }

    // 2. カット案の画像の一覧（古い順）。いまはめ込んでいる画像には枠を付ける。「お気に入りのみ」ではお気に入りだけを出す
    function showCutImages(cutId) {
        const cut = ed.opts.cuts().find((c) => c.id === cutId);
        if (!cut) {
            showPicker();
            return;
        }
        crop.pickCut = cutId;
        const grid = pickStep(`「${cut.title}」の画像を選択`, "画像を選ぶと、はめ込む範囲を決める画面に移ります");
        const all = ed.opts.images(cutId);
        const list = prefs.favOnly ? all.filter((x) => x.favorite) : all;
        if (!list.length) {
            grid.appendChild(el("div", {class: "mtm-empty", text: all.length ? "このカット案にはお気に入りの画像がありません。" : "このカット案にはまだ画像がありません。"}));
        }
        const current = crop.rect.image;
        let focus = null;
        for (const x of list) {
            const on = current && current.cutId === x.cutId && current.name === x.name;
            const item = el("button", {type: "button", class: "ps-pg-pickitem" + (on ? " ps-on" : ""), title: x.name, onclick: () => startCrop(x, ed.opts.resolve(x, false))}, [
                el("img", {src: x.thumb, alt: "", loading: "lazy", draggable: "false"}),
                ...pickMarks(x.panels, x.favorite),
                el("span", {class: "ps-pg-pickitem-label", text: x.label}),
            ]);
            if (on) focus = item;
            grid.appendChild(item);
        }
        if (focus) focus.scrollIntoView({block: "nearest"});
    }

    function startCrop(ref, url) {
        crop.image = {cutId: ref.cutId, name: ref.name};
        lastPickCut = ref.cutId;
        q(".ps-pg-pick-back").classList.add("ps-off");
        q(".ps-pg-pick-link").classList.add("ps-off");
        q(".ps-pg-favonly").classList.add("ps-off");
        q(".ps-pg-crop-title").textContent = "はめ込む範囲を決める";
        q(".ps-pg-crop-note").textContent = "";
        q(".ps-pg-pickgrid").classList.add("ps-off");
        q(".ps-pg-cropstage").classList.remove("ps-off");
        q(".ps-pg-cropmode").classList.remove("ps-off");
        q(".ps-pg-crop-ok").classList.remove("ps-off");
        q(".ps-pg-crop-repick").classList.remove("ps-off");
        q(".ps-pg-crop-remove").classList.toggle("ps-off", !crop.rect.image);
        q(".ps-pg-frame").classList.add("ps-off");
        refocus();
        const img = q(".ps-pg-cropimg");
        if (img.getAttribute("src") === url && img.complete && img.naturalWidth) imageLoaded();
        else img.src = url;
    }

    function imageLoaded() {
        if (!crop.image) return;
        const img = q(".ps-pg-cropimg");
        crop.iw = img.naturalWidth;
        crop.ih = img.naturalHeight;
        const rect = crop.rect;
        const prev = rect.image;
        if (prev && prev.cutId === crop.image.cutId && prev.name === crop.image.name) {
            // 前の範囲と置き方から始める。画像の大きさが変わっていたら同じ割合にする。四角の大きさが変わっていたら中央で合わせる
            crop.mode = prev.mode === "full" ? "full" : "cover";
            const sx = crop.iw / prev.iw, sy = crop.ih / prev.ih;
            const c = panelCrop(prev, rect.w, rect.h);
            if (crop.mode === "full") Object.assign(crop, {x: (c.x + c.w / 2) * sx - c.w / 2, y: (c.y + c.h / 2) * sy - c.h / 2});
            else Object.assign(crop, {x: c.x * sx, y: c.y * sy, w: c.w * sx, h: c.h * sy});
        } else {
            // 最初は前回の置き方で、四角と同じ大きさ（拡大して合わせるでは、画像に収まらなければ縮める）の枠を画像の中央に置く
            crop.mode = prefs.cropMode;
            Object.assign(crop, {w: rect.w, h: rect.h});
            clampCrop();
            crop.x = (crop.iw - crop.w) / 2;
            crop.y = (crop.ih - crop.h) / 2;
        }
        clampCrop();
        q(".ps-pg-frame").classList.remove("ps-off");
        placeFrame();
    }

    // 画像と枠をステージに収めて表示する。原寸で枠が画像より大きいときは、枠が動ける範囲まで含めて収め、
    // 画像の外は白い紙（できあがりの余白）として見せる
    function placeFrame() {
        const stage = q(".ps-pg-cropstage");
        const img = q(".ps-pg-cropimg");
        const sw = stage.clientWidth, sh = stage.clientHeight;
        if (!sw || !sh || !crop.iw) return;
        const full = crop.mode === "full";
        view.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("mtm-active", b.dataset.mode === crop.mode));
        q(".ps-pg-frame").classList.toggle("ps-pg-fixed", full);
        const bx = full ? Math.min(0, crop.iw - crop.w) : 0;
        const by = full ? Math.min(0, crop.ih - crop.h) : 0;
        const bw = full ? Math.max(crop.iw, crop.w) - bx : crop.iw;
        const bh = full ? Math.max(crop.ih, crop.h) - by : crop.ih;
        crop.scale = Math.min(sw / bw, sh / bh);
        crop.ox = (sw - bw * crop.scale) / 2 - bx * crop.scale;
        crop.oy = (sh - bh * crop.scale) / 2 - by * crop.scale;
        const px = (v) => v + "px";
        Object.assign(img.style, {left: px(crop.ox), top: px(crop.oy), width: px(crop.iw * crop.scale), height: px(crop.ih * crop.scale)});
        const paper = q(".ps-pg-croppaper");
        paper.classList.toggle("ps-off", !full);
        Object.assign(paper.style, {left: px(crop.ox + bx * crop.scale), top: px(crop.oy + by * crop.scale), width: px(bw * crop.scale), height: px(bh * crop.scale)});
        Object.assign(q(".ps-pg-frame").style, {
            left: px(crop.ox + crop.x * crop.scale), top: px(crop.oy + crop.y * crop.scale),
            width: px(crop.w * crop.scale), height: px(crop.h * crop.scale),
        });
        const size = `コマ ${Math.round(crop.rect.w)} × ${Math.round(crop.rect.h)}`;
        const note = q(".ps-pg-crop-note");
        if (full) {
            q(".ps-pg-crop-info").textContent = `画像 ${crop.iw} × ${crop.ih} → ${size}（原寸）`;
            note.classList.remove("ps-pg-warn");
            note.textContent = "画像を拡大・縮小せずに置きます。枠をドラッグで位置を決めます。画像の外は白い余白になります。Enter で決定。";
            return;
        }
        const ratio = crop.rect.w / crop.w;
        const pct = Math.round(ratio * 100);
        q(".ps-pg-crop-info").textContent = `範囲 ${Math.round(crop.w)} × ${Math.round(crop.h)} → ${size}（${pct}%）`;
        const warn = ratio > 1.005;
        note.classList.toggle("ps-pg-warn", warn);
        note.textContent = warn
            ? `⚠ 範囲がコマより小さいため ${pct}% に拡大して表示されます。画質が落ちます。「原寸」なら拡大せずに置けます。`
            : "枠をドラッグで移動、角をドラッグかホイールで大きさを変えます。Enter で決定。";
    }

    function acceptCrop() {
        if (!crop.image || !crop.iw) return;
        const rect = crop.rect;
        const image = {
            cutId: crop.image.cutId, name: crop.image.name, iw: crop.iw, ih: crop.ih,
            crop: {x: round1(crop.x), y: round1(crop.y), w: round1(crop.w), h: round1(crop.h)},
            ...(crop.mode === "full" ? {mode: "full"} : {}),
        };
        closeCrop();
        change(() => (rect.image = image));
    }

    function closeCrop() {
        if (!view) return;
        q(".ps-pg-crop").classList.add("ps-off");
        crop.rect = null;
        crop.image = null;
        crop.pickCut = "";
        crop.drag = null;
        refocus();
    }

    // 画像のクロップ・フォント選び・セリフの入力・ドラッグの途中か（Alt+B で閉じないようにする）
    const busy = () => !!ed && (isCropOpen() || isFontPickerOpen() || !!textEdit || !!drag);
    window.PolarisPages = {newPage, thumb, open, close, isOpen, busy, keydown, refresh: () => ed && render()};
})();
