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
        select: "クリックで選択、ドラッグで移動・サイズ変更。選んだ四角をもう一度クリック（またはダブルクリック）すると画像を選べます。Delete で削除、Ctrl+Z で元に戻す。Alt を押している間は吸着しません。重なったコマは「下を隠す」(H) で手前のコマだけの線にし、「前面へ」(])「背面へ」([) で手前にするコマを決めます。素材は角のつまみで縦横比を保って拡大・縮小（Shift で自由に）、辺のつまみで伸び縮みします。",
        line: "ドラッグで直線を引きます。Shift で水平・垂直。直線は分割線で、画像ははめ込めません。",
        rect: "ドラッグで四角を描きます。Shift で正方形。線「なし」にすると透明な四角（線のないコマ）になります。",
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
    const boxy = (s) => s.type === "rect" || s.type === "material" || s.type === "text";
    // 置いたあとは自由に動かせる（ページから一部はみ出してよい）図形
    const floating = (s) => s.type === "material" || s.type === "text";

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
    // 新しく置くセリフに使うフォント（一覧にあれば、この順に選ぶ）
    const FONT_PREFERRED = ["win:YuGothB.ttc#0", "win:YuGothM.ttc#0", "win:meiryo.ttc#0", "win:msgothic.ttc#0"];

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

    // 下を隠す四角が、実際に後ろを隠すか。画像も線もない四角（配置の目安の透明な四角）は何も隠さない
    const hides = (s) => s.type === "rect" && s.front && (s.image || s.stroke);

    // ページを g に描く。resolve(ref) は画像の URL（見つからなければ null）。editing では空の四角や線のない四角の目印も描く。
    // 重なりの描き方（サーバーの render_page と同じ）：
    //   1. 「下を隠す」でない四角の画像を、いちばん下にまとめて描く
    //   2. 図形の並び順（後ろほど手前）に、線と直線を描く。「下を隠す」四角はその位置で白地・画像・線をまとめて描き、
    //      それより奥のものを隠す。なので「下を隠す」でない四角どうしは両方の線が見え、隠す四角では手前の線だけが見える
    function drawPage(g, page, resolve, editing) {
        g.appendChild(svgEl("rect", {x: 0, y: 0, width: page.width, height: page.height, fill: "#fff"}));
        const content = (s) => {
            const url = s.image && resolve(s.image);
            if (url) {
                const c = panelCrop(s.image, s.w, s.h);
                g.appendChild(svgEl("svg", {x: s.x, y: s.y, width: s.w, height: s.h, viewBox: `${c.x} ${c.y} ${c.w} ${c.h}`, preserveAspectRatio: "none"}, [
                    svgEl("image", {href: url, width: s.image.iw, height: s.image.ih, preserveAspectRatio: "none"}),
                ]));
            } else if (editing) {
                g.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, class: "ps-pg-empty"}));
                const size = Math.min(s.w / 9, s.h / 3, Math.max(page.width, page.height) / 40);
                if (size >= 8) {
                    g.appendChild(svgEl("text", {
                        x: s.x + s.w / 2, y: s.y + s.h / 2, "font-size": size, class: "ps-pg-empty-text",
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
            if (hides(s)) g.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, fill: "#fff"}));
            if (s.type === "rect" && s.front) content(s);
            if (s.type === "rect" && s.stroke) {
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
        const materials = page.shapes.filter((s) => s.type === "material");
        const texts = page.shapes.filter((s) => s.type === "text");
        if (materials.length || texts.length) {
            const layer = svgEl("svg", {x: 0, y: 0, width: page.width, height: page.height, viewBox: `0 0 ${page.width} ${page.height}`, overflow: "hidden"});
            for (const s of materials) {
                const url = resolve({material: s.name});
                if (url) layer.appendChild(svgEl("image", {href: url, x: s.x, y: s.y, width: s.w, height: s.h, preserveAspectRatio: "none"}));
                else if (editing) layer.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, class: "ps-pg-empty"}));
            }
            for (const s of texts) drawText(layer, s, editing);
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
    const prefs = {tool: "rect", line: 4, rect: 4, cropMode: "cover", favOnly: false, count: 1, text: {...TEXT_DEFAULT}};
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
            if (["select", "line", "rect", "text"].includes(saved.tool)) prefs.tool = saved.tool;
            if (saved.text && typeof saved.text === "object") prefs.text = cleanTextStyle(saved.text);
            if (STROKES.includes(saved.line) && saved.line) prefs.line = saved.line;
            if (STROKES.includes(saved.rect)) prefs.rect = saved.rect;
            if (saved.cropMode === "full") prefs.cropMode = "full";
            if (saved.favOnly === true) prefs.favOnly = true;
            if (PAGE_COUNTS.includes(saved.count)) prefs.count = saved.count;
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
                    <button type="button" class="mtm-btn" data-tool="rect" title="四角 (R)">四角</button>
                    <button type="button" class="mtm-btn" data-tool="text" title="セリフ (T)。クリックした所に文字を置きます">セリフ</button>
                </div>
                <div class="ps-pg-group ps-pg-strokes">
                    <span class="ps-pg-label">線の太さ</span>
                    ${STROKES.map((w) => `<button type="button" class="mtm-btn" data-stroke="${w}" title="${w ? w + " px" : "線なし（透明な四角）"}">${w || "なし"}</button>`).join("")}
                </div>
                <button type="button" class="mtm-btn ps-pg-pick" title="選んだ四角にはめ込む画像を選びます">画像を選ぶ</button>
                <div class="ps-pg-group">
                    <button type="button" class="mtm-btn ps-pg-front" title="重なったとき、このコマで後ろのコマ（画像と線）を隠します。オフなら両方の線を描きます (H)">下を隠す</button>
                    <button type="button" class="mtm-btn ps-pg-raise" title="いちばん手前に出します (])">前面へ</button>
                    <button type="button" class="mtm-btn ps-pg-lower" title="いちばん奥に下げます ([)">背面へ</button>
                </div>
                <button type="button" class="mtm-btn ps-pg-material" title="吹き出し・集中線・小物などの画像を素材として置きます。素材はコマと線の上に重なります。画像ファイルをキャンバスにドロップするか、Ctrl+V で貼り付けても置けます">＋ 素材</button>
                <input type="file" class="ps-pg-material-file ps-off" accept="image/*" multiple>
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
                <select class="ps-pg-font" title="フォント。この PC に入っているフォントを使えます（書き出しにも同じ字形で入ります）"></select>
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
            </div>
            <div class="ps-pg-hint"></div>
            <div class="ps-pg-textedit ps-off">
                <textarea class="ps-pg-textarea" rows="3" placeholder="セリフを入力（改行で次の行）。Ctrl+Enter で決定、Esc で取り消し"></textarea>
                <div class="ps-pg-textedit-actions">
                    <button type="button" class="mtm-btn ps-pg-text-cancel">キャンセル</button>
                    <button type="button" class="mtm-btn mtm-primary ps-pg-text-ok">決定</button>
                </div>
            </div>
            <div class="ps-pg-stage"></div>
            <div class="ps-pg-crop ps-off">
                <div class="ps-pg-crop-box">
                    <div class="ps-pg-crop-head">
                        <button type="button" class="mtm-btn ps-pg-pick-back ps-off" title="カット案の一覧に戻る (Esc)">← カット案</button>
                        <span class="ps-pg-crop-title"></span>
                        <span class="ps-pg-crop-info"></span>
                        <span class="mtm-fs-spacer"></span>
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
        svg.addEventListener("pointermove", pointerMove);
        svg.addEventListener("pointerup", pointerUp);
        svg.addEventListener("pointercancel", () => {
            if (drag) cancelDrag();
        });
        svg.addEventListener("dblclick", (e) => {
            if (!ed || prefs.tool !== "select") return;
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
        const select = q(".ps-pg-font");
        select.textContent = "";
        for (const f of fontList) {
            const style = f.style && !/^(regular|normal|標準)$/i.test(f.style) ? " " + f.style : "";
            select.appendChild(el("option", {value: f.id, text: f.name + style}));
        }
        if (ed) updateTools();
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
        q(".ps-pg-font").addEventListener("change", (e) => setTextStyle("font", e.target.value));
        q(".ps-pg-toutline").addEventListener("change", (e) => setTextStyle("outline", Number(e.target.value)));
        q(".ps-pg-tcolor").addEventListener("change", (e) => setTextStyle("color", e.target.value.toLowerCase()));
        q(".ps-pg-toutcolor").addEventListener("change", (e) => setTextStyle("outlineColor", e.target.value.toLowerCase()));
        view.querySelectorAll("[data-dir]").forEach((b) => b.addEventListener("click", () => setTextStyle("vertical", b.dataset.dir === "v")));
        // 数値の欄で Enter を押したら決める（キャンバスの操作に戻る）
        for (const sel of [".ps-pg-tsize", ".ps-pg-tline", ".ps-pg-tspace"]) {
            q(sel).addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.isComposing) e.target.blur();
            });
        }
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
        const select = q(".ps-pg-font");
        // 一覧にないフォント（ほかの PC で選んだものなど）も、選ばれていることが分かるように出す
        if (fontList && t.font && ![...select.options].some((o) => o.value === t.font)) {
            select.appendChild(el("option", {value: t.font, text: `（見つからないフォント ${t.font}）`}));
        }
        if (!fontList) {
            select.textContent = "";
            select.appendChild(el("option", {value: "", text: "フォントを読み込み中…"}));
        }
        set(".ps-pg-font", t.font);
        set(".ps-pg-tsize", t.size);
        set(".ps-pg-tline", t.lineHeight);
        set(".ps-pg-tspace", t.spacing);
        set(".ps-pg-tcolor", t.color);
        set(".ps-pg-toutline", String(t.outline));
        set(".ps-pg-toutcolor", t.outlineColor);
        view.querySelectorAll("[data-dir]").forEach((b) => b.classList.toggle("mtm-active", (b.dataset.dir === "v") === t.vertical));
    }

    // p（ページのピクセル）を中心に、空のセリフを置いて入力を始める
    function createText(p) {
        const before = snapshot();
        const s = {id: newId(), type: "text", x: p.x, y: p.y, w: 0, h: 0, text: "", ...cleanTextStyle(prefs.text)};
        fitText(s);
        ed.page.shapes.push(s);
        ed.sel = s.id;
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
                slot.appendChild(el("span", {class: "ps-pg-slot-no", text: String(i + 1).padStart(width, "0") + (active ? "  編集中" : "")}));
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
        // 開いたページを右端（並びの最初）に置く。後ろに足りなければ左に寄せる
        ed.start = Math.max(0, pageList().indexOf(opts.page));
        drag = null;
        q(".ps-pg-crop").classList.add("ps-off");
        view.classList.remove("ps-off");
        renderSlots();
        render();
        loadFonts();
    }

    function close() {
        if (!ed) return;
        const opts = ed.opts;
        finishTextEdit(true);
        if (drag) cancelDrag();
        closeCrop();
        ed = null;
        view.classList.add("ps-off");
        opts.onClose();
    }

    const isOpen = () => !!ed;

    // ページを変えたら保存して描き直す
    function commit() {
        render();
        ed.opts.onChange();
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
        savePrefs();
        if (!ed) return;
        finishTextEdit(true);
        if (drag) cancelDrag();
        if (tool !== "select") ed.sel = null;
        render();
    }

    // 選択の道具で図形を選んでいれば、その線を変える。描く道具では、これから描く図形の線を決める
    function setStroke(w) {
        const s = selected();
        const type = s ? s.type : prefs.tool === "line" || prefs.tool === "text" ? prefs.tool : "rect";
        if ((type === "line" && !w) || floating({type})) return;
        prefs[type] = w;
        savePrefs();
        if (s) change(() => (s.stroke = w));
        updateTools();
    }

    function select(id) {
        ed.sel = id;
        render();
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
        const type = s ? s.type : prefs.tool === "line" || prefs.tool === "text" ? prefs.tool : "rect";
        const current = s ? s.stroke : prefs[type];
        view.querySelectorAll("[data-stroke]").forEach((b) => {
            const w = Number(b.dataset.stroke);
            // 素材とセリフには線がない
            b.classList.toggle("mtm-active", !floating({type}) && w === current);
            b.disabled = (type === "line" && !w) || floating({type});
        });
        const textShape = s && s.type === "text" ? s : null;
        const textBar = prefs.tool === "text" || !!textShape;
        q(".ps-pg-textbar").classList.toggle("ps-off", !textBar);
        if (textBar) fillTextBar(textShape || prefs.text);
        q(".ps-pg-pick").disabled = !s || s.type !== "rect";
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
        q(".ps-pg-hint").textContent = HINTS[prefs.tool];
        q(".ps-pg-stage").dataset.tool = prefs.tool;
        q(".ps-pg-where").textContent = ed.opts.title(ed.page);
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
        // クリックを受ける面。四角は中ごと、直線は細くても掴めるよう太めに取る。直線を四角より手前にする
        const hits = svgEl("g", {class: "ps-pg-hits"});
        for (const s of page.shapes) {
            if (s.type === "rect") hits.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, "data-id": s.id}));
        }
        for (const s of page.shapes) {
            if (s.type === "line") hits.appendChild(svgEl("line", {x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, "stroke-width": Math.max(s.stroke, 14 * u), "data-id": s.id}));
        }
        // 素材はいちばん上の層なので、クリックもいちばん手前で受ける
        for (const s of page.shapes) {
            if (s.type === "material") hits.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, "data-id": s.id}));
        }
        // セリフはさらに上
        for (const s of page.shapes) {
            if (s.type !== "text") continue;
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
        // セリフの大きさは文字の大きさで決まるので、つまみは出さない
        if (s.type === "text") {
            const b = textBox(s);
            g.appendChild(svgEl("rect", {x: b.x, y: b.y, width: b.w, height: b.h, class: "ps-pg-sel-outline"}));
        } else if (boxy(s)) {
            g.appendChild(svgEl("rect", {x: s.x, y: s.y, width: s.w, height: s.h, class: "ps-pg-sel-outline"}));
            const xs = {w: s.x, c: s.x + s.w / 2, e: s.x + s.w};
            const ys = {n: s.y, c: s.y + s.h / 2, s: s.y + s.h};
            for (const name of RECT_HANDLES) {
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
        if (!ed || e.button !== 0) return;
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
        if (prefs.tool === "line" || prefs.tool === "rect") {
            drag.kind = prefs.tool === "line" ? "newline" : "newrect";
            drag.targets = snapTargets("");
            drag.start = inPage({x: snapX(p.x), y: snapY(p.y)});
        } else {
            const handle = e.target.closest("[data-handle]");
            const hit = e.target.closest("[data-id]");
            if (handle && selected()) {
                drag.kind = "handle";
                drag.handle = handle.dataset.handle;
                drag.id = ed.sel;
            } else if (hit) {
                drag.kind = "move";
                drag.id = hit.dataset.id;
                drag.wasSelected = ed.sel === drag.id;
                if (!drag.wasSelected) select(drag.id);
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
        const s = ensureShape(() => ({id: newId(), type: "line", x1: 0, y1: 0, x2: 0, y2: 0, stroke: prefs.line || 4}));
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
        if (s.type === "material") {
            resizeMaterial(s, o, {x: snapX(p.x), y: snapY(p.y)}, shift);
            return;
        }
        const q2 = inPage({x: snapX(p.x), y: snapY(p.y)});
        if (s.type === "line") {
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
            const small = s && (s.type === "line" ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < MIN_SIZE : s.w < MIN_SIZE || s.h < MIN_SIZE);
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
        // 選んであった四角をもう一度クリックしたら、はめ込む画像を選ぶ
        // 選んであったセリフをもう一度クリックしたら、文字を直す
        const s = shapeOf(d.id);
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
        change(() => {
            if (floating(s)) {
                placeMaterial(s, s.x + dx, s.y + dy);
            } else if (s.type === "rect") {
                s.x = round1(clamp(s.x + dx, 0, ed.page.width - s.w));
                s.y = round1(clamp(s.y + dy, 0, ed.page.height - s.h));
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
        } else if (key === "v" || key === "l" || key === "r" || key === "t") {
            stop();
            setTool({v: "select", l: "line", r: "rect", t: "text"}[key]);
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
        else showPicker();
    }

    // 画像を選ぶ段階（カット案の一覧と画像の一覧）の共通の見た目にする
    function pickStep(title, note) {
        crop.image = null;
        q(".ps-pg-crop-title").textContent = title;
        q(".ps-pg-crop-info").textContent = `コマ ${Math.round(crop.rect.w)} × ${Math.round(crop.rect.h)}`;
        q(".ps-pg-crop-note").textContent = note;
        q(".ps-pg-crop-note").classList.remove("ps-pg-warn");
        q(".ps-pg-pick-back").classList.toggle("ps-off", !crop.pickCut);
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
        const current = crop.rect.image ? crop.rect.image.cutId : lastPickCut;
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

    window.PolarisPages = {newPage, thumb, open, close, isOpen, keydown, refresh: () => ed && render()};
})();
