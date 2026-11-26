// Polaris Studio: 描き直す（img2img・インペイント）
// カット案の画像を元に、ポラスタの画面の中でマスクを塗って描き直す。マスクを塗らなければ img2img、塗ればインペイント。
// 生成は WebUI の img2img に頼み、元の画像とマスクは Python が生成に差し込む（WebUI の img2img の画像欄は使わない）。
// できた画像はこの画面の一覧に並び、押すとそれを元にして続けて描き直せる
(function () {
    "use strict";

    const FILLS = [[1, "元の絵"], [0, "塗りつぶし"], [2, "ノイズ"], [3, "空"]];
    const UNDO_MAX = 30;
    const PREF_KEY = "polaris-studio:i2i-prefs";
    const DEFAULTS = {denoise: 0.55, maskBlur: 4, fill: 1, onlyMasked: true, padding: 32, count: 1, brush: 48, maskOpacity: 0.5};

    let root = null;
    let opts = null;
    let source = null;              // 元の画像 {name, prompt, negative, steps, size, ...}
    let img = null;                 // 元の画像の HTMLImageElement
    let W = 0;
    let H = 0;
    let mask = null;                // マスク（白で塗る。透明は塗っていない）。元の画像と同じ大きさ
    let tint = null;                // 表示用にマスクを色付けしたもの
    let undoStack = [];
    let redoStack = [];
    let view = {zoom: 1, x: 0, y: 0};
    let viewAuto = true;
    let drag = null;
    let hover = null;
    let spaceDown = false;
    let busy = false;
    let prefs = {...DEFAULTS};
    let fresh = new Set();          // この画面で生成した画像の名前（一覧で「新」を付ける）

    const q = (sel) => root.querySelector(sel);
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const canvasEl = () => q(".ps-i2i-canvas");

    function loadPrefs() {
        try {
            const v = JSON.parse(localStorage.getItem(PREF_KEY));
            if (v && typeof v === "object") prefs = {...DEFAULTS, ...v};
        } catch (e) { /* 読めなければ初期値 */ }
    }

    function savePrefs() {
        try {
            localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
        } catch (e) { /* 覚えられなくても使える */ }
    }

    // ---------- 画面 ----------

    function build() {
        root = document.createElement("div");
        root.className = "ps-pose ps-i2i ps-off";
        root.tabIndex = -1;
        root.innerHTML = `
            <div class="ps-pose-bar">
                <span class="ps-pose-title">描き直す</span>
                <span class="ps-i2i-where"></span>
                <span class="ps-pose-sep"></span>
                <button type="button" class="mtm-icon ps-i2i-undo" title="元に戻す (Ctrl+Z)">↶</button>
                <button type="button" class="mtm-icon ps-i2i-redo" title="やり直す (Ctrl+Y)">↷</button>
                <span class="mtm-fs-spacer"></span>
                <span class="ps-pose-busy ps-i2i-busy ps-off">生成中…</span>
                <span class="ps-i2i-mode"></span>
                <button type="button" class="mtm-btn mtm-primary ps-i2i-generate" title="この設定で描き直します。できた画像はこのカット案に入り、右の一覧に並びます (Ctrl+Enter)">生成</button>
                <button type="button" class="mtm-btn ps-i2i-close" title="閉じる (Esc)">閉じる</button>
            </div>
            <div class="ps-pose-main">
                <div class="ps-pose-stage">
                    <canvas class="ps-pose-canvas ps-i2i-canvas"></canvas>
                    <div class="ps-pose-status ps-off"></div>
                </div>
                <div class="ps-pose-side">
                    <section>
                        <div class="ps-pose-head">マスク（描き直す範囲）</div>
                        <div class="ps-pose-note">ドラッグで塗ります。Shift を押しながらドラッグで消します。塗らずに生成すると、画像全体を描き直します（img2img）。</div>
                        <label class="ps-pose-range" title="筆の太さ（元の画像の px）。Alt+ホイールでも変えられます">筆の太さ<input type="range" class="ps-i2i-brush" min="4" max="400" step="2"><span class="ps-i2i-brush-value"></span></label>
                        <label class="ps-pose-range" title="マスクの表示の濃さ（生成には関係しません）">表示の濃さ<input type="range" class="ps-i2i-opacity" min="0.1" max="0.9" step="0.05"><span></span></label>
                        <div class="ps-pose-row">
                            <button type="button" class="mtm-btn ps-i2i-clear" title="マスクを全部消します">全部消す</button>
                            <button type="button" class="mtm-btn ps-i2i-invert" title="塗ったところと塗っていないところを入れ替えます">反転</button>
                            <button type="button" class="mtm-btn ps-i2i-fit" title="全体が見える大きさに戻します (F)">全体を表示</button>
                        </div>
                    </section>
                    <section>
                        <div class="ps-pose-head">設定</div>
                        <label class="ps-pose-range" title="元の画像からどれだけ変えるか（0〜1）。初期値 0.55。小さいほど元のまま、大きいほど作り直します。手や顔の直しは 0.4〜0.6、形ごと変えるなら 0.7〜0.9">ノイズ除去強度<input type="range" class="ps-i2i-denoise" min="0" max="1" step="0.01"><span></span></label>
                        <label class="ps-pose-range" title="マスクの縁をぼかす幅（px）。初期値 4。描き直したところと元の絵の境目が目立つときは上げます">マスクのぼかし<input type="range" class="ps-i2i-blur" min="0" max="64" step="1"><span></span></label>
                        <label class="ps-pose-field" title="マスクしたところを、生成の始めにどうしておくか。初期値「元の絵」。元の形を生かすなら「元の絵」、まったく違うものを描くなら「塗りつぶし」か「ノイズ」">始め方<select class="ps-i2i-fill">${FILLS.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>
                        <label class="ps-pose-check" title="オンにすると、マスクのまわりだけを切り出して、生成の大きさで描き直してから貼り戻します。手や顔など小さいところを細かく描けます。オフは画像全体を描き直します（マスクの外は元のまま）"><input type="checkbox" class="ps-i2i-only">マスクのまわりだけ描き直す</label>
                        <label class="ps-pose-range" title="「マスクのまわりだけ」のときに、マスクのまわりに足す余白（px）。初期値 32。まわりとのつながりがおかしいときは広げます">余白<input type="range" class="ps-i2i-padding" min="0" max="256" step="4"><span></span></label>
                        <label class="ps-pose-field" title="一度に生成する枚数">枚数<input type="number" class="ps-i2i-count" min="1" max="8" step="1"></label>
                        <label class="ps-pose-field">Steps<input type="number" class="ps-i2i-steps" min="1" max="150" step="1"></label>
                        <label class="ps-pose-field" title="-1 でランダム">Seed<input type="number" class="ps-i2i-seed" step="1"></label>
                        <label class="ps-pose-check ps-i2i-pose-row"><input type="checkbox" class="ps-i2i-pose">カット案のポーズ（ControlNet）も使う</label>
                        <div class="ps-pose-note ps-i2i-size"></div>
                    </section>
                    <section>
                        <div class="ps-pose-head">プロンプト</div>
                        <div class="ps-pose-row">
                            <button type="button" class="mtm-btn ps-i2i-from-image" title="元の画像を生成したときのプロンプトにします">元の画像から</button>
                            <button type="button" class="mtm-btn ps-i2i-from-cut" title="カット案の今のプロンプトにします">カット案から</button>
                        </div>
                        <textarea class="ps-i2i-positive" rows="5" spellcheck="false" placeholder="ポジティブプロンプト"></textarea>
                        <textarea class="ps-i2i-negative" rows="3" spellcheck="false" placeholder="ネガティブプロンプト"></textarea>
                    </section>
                    <section>
                        <div class="ps-pose-head">元の画像</div>
                        <div class="ps-pose-note">押すとその画像を元にします（できた画像を押せば、続けて描き直せます）。大きさが同じなら、マスクはそのまま使えます。</div>
                        <div class="ps-pose-sources ps-i2i-sources"></div>
                    </section>
                    <section class="ps-pose-help">
                        <div class="ps-pose-head">操作</div>
                        <div>ドラッグ：塗る／Shift+ドラッグ：消す</div>
                        <div>Alt+ホイール：筆の太さ</div>
                        <div>ホイール：拡大・縮小</div>
                        <div>右ドラッグ・中ドラッグ・Space+ドラッグ：動かして見る</div>
                        <div>Ctrl+Z：元に戻す／Ctrl+Y：やり直す</div>
                        <div>Ctrl+Enter：生成／F：全体を表示／Esc：閉じる</div>
                    </section>
                </div>
            </div>
        `;
        window.PolarisStudio.root().appendChild(root);

        const canvas = canvasEl();
        canvas.addEventListener("pointerdown", pointerDown);
        canvas.addEventListener("pointermove", pointerMove);
        canvas.addEventListener("pointerup", pointerUp);
        canvas.addEventListener("pointercancel", pointerUp);
        canvas.addEventListener("pointerleave", () => {
            hover = null;
            draw();
        });
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        canvas.addEventListener("wheel", wheel, {passive: false});
        new ResizeObserver(() => {
            if (!img) return;
            if (viewAuto) fit();
            draw();
        }).observe(q(".ps-pose-stage"));
        root.addEventListener("keydown", keyDown);
        root.addEventListener("keyup", (e) => {
            if (e.code === "Space") spaceDown = false;
            if (e.key === "Alt") e.preventDefault();
            if (e.key === "Shift" && hover) {
                hover.erase = false;
                draw();
            }
        });

        q(".ps-i2i-undo").addEventListener("click", undo);
        q(".ps-i2i-redo").addEventListener("click", redo);
        q(".ps-i2i-generate").addEventListener("click", generate);
        q(".ps-i2i-close").addEventListener("click", close);
        q(".ps-i2i-clear").addEventListener("click", () => {
            if (!maskIsEmpty()) editMask((g) => g.clearRect(0, 0, W, H));
        });
        q(".ps-i2i-invert").addEventListener("click", invertMask);
        q(".ps-i2i-fit").addEventListener("click", () => {
            fit();
            draw();
        });
        q(".ps-i2i-from-image").addEventListener("click", () => setPrompts(source.prompt, source.negative));
        q(".ps-i2i-from-cut").addEventListener("click", () => {
            const c = opts.cutPrompt || {};
            setPrompts(c.positive, c.negative);
        });
        const bindRange = (sel, key, fmt) => {
            const input = q(sel);
            const label = input.parentElement.querySelector("span");
            const show = () => (label.textContent = fmt(Number(input.value)));
            input.addEventListener("input", () => {
                prefs[key] = Number(input.value);
                show();
                savePrefs();
                if (key === "maskOpacity" || key === "brush") draw();
            });
            return () => {
                input.value = prefs[key];
                show();
            };
        };
        root.psSync = [
            bindRange(".ps-i2i-brush", "brush", (v) => `${v}px`),
            bindRange(".ps-i2i-opacity", "maskOpacity", (v) => `${Math.round(v * 100)}%`),
            bindRange(".ps-i2i-denoise", "denoise", (v) => v.toFixed(2)),
            bindRange(".ps-i2i-blur", "maskBlur", (v) => `${v}px`),
            bindRange(".ps-i2i-padding", "padding", (v) => `${v}px`),
        ];
        q(".ps-i2i-fill").addEventListener("change", (e) => {
            prefs.fill = Number(e.target.value);
            savePrefs();
        });
        q(".ps-i2i-only").addEventListener("change", (e) => {
            prefs.onlyMasked = e.target.checked;
            savePrefs();
        });
        q(".ps-i2i-count").addEventListener("change", (e) => {
            prefs.count = clamp(Math.round(Number(e.target.value) || 1), 1, 8);
            e.target.value = prefs.count;
            savePrefs();
        });
    }

    function setPrompts(positive, negative) {
        q(".ps-i2i-positive").value = positive || "";
        q(".ps-i2i-negative").value = negative || "";
    }

    let statusTimer = null;
    function status(text) {
        const box = q(".ps-pose-status");
        box.textContent = text;
        box.classList.remove("ps-off");
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => box.classList.add("ps-off"), 2500);
    }

    // ---------- 開く・閉じる ----------

    // options: {title, images(), imageUrl(image), thumbUrl(image), start, cutPrompt: {positive, negative}, hasPose,
    //           generate(settings) → 生成した画像の一覧, onClose()}
    function open(options) {
        if (!root) build();
        opts = options;
        loadPrefs();
        fresh = new Set();
        root.psSync.forEach((f) => f());
        q(".ps-i2i-fill").value = String(prefs.fill);
        q(".ps-i2i-only").checked = prefs.onlyMasked;
        q(".ps-i2i-count").value = prefs.count;
        q(".ps-i2i-seed").value = -1;
        q(".ps-i2i-where").textContent = options.title || "";
        q(".ps-i2i-pose-row").classList.toggle("ps-off", !options.hasPose);
        q(".ps-i2i-pose").checked = false;
        root.classList.remove("ps-off");
        setBusy(false);
        selectSource(options.start, true);
        root.focus();
    }

    function isOpen() {
        return !!root && !root.classList.contains("ps-off");
    }

    function close() {
        if (!isOpen() || busy) return;
        root.classList.add("ps-off");
        const done = opts && opts.onClose;
        opts = null;
        img = null;
        if (done) done();
    }

    // ---------- 元の画像 ----------

    function loadImage(src) {
        return new Promise((ok, ng) => {
            const image = new Image();
            image.onload = () => ok(image);
            image.onerror = () => ng(new Error("画像が読めません"));
            image.src = src;
        });
    }

    async function selectSource(image, first = false) {
        if (!image) return;
        let next;
        try {
            next = await loadImage(opts.imageUrl(image));
        } catch (e) {
            alert(e.message);
            return;
        }
        const sameSize = mask && next.naturalWidth === W && next.naturalHeight === H;
        source = image;
        img = next;
        if (!sameSize) {
            W = img.naturalWidth;
            H = img.naturalHeight;
            mask = document.createElement("canvas");
            mask.width = W;
            mask.height = H;
            tint = document.createElement("canvas");
            tint.width = W;
            tint.height = H;
            undoStack = [];
            redoStack = [];
            updateTint();
            fit();
        }
        if (first) {
            setPrompts(image.prompt || (opts.cutPrompt || {}).positive, image.negative || (opts.cutPrompt || {}).negative);
            q(".ps-i2i-steps").value = Number(image.steps) || 30;
        }
        q(".ps-i2i-size").textContent = `元の画像：${image.name}（${W} × ${H}）。この大きさで生成します`;
        renderSources();
        updateUi();
        draw();
    }

    function renderSources() {
        const box = q(".ps-i2i-sources");
        box.textContent = "";
        // 新しい画像を先に並べる
        const list = opts.images().slice().reverse();
        for (const image of list) {
            const tile = document.createElement("button");
            tile.type = "button";
            tile.className = "ps-pose-src" + (source && image.name === source.name ? " ps-selected" : "");
            tile.title = image.name;
            tile.innerHTML = `<img alt="" loading="lazy">${fresh.has(image.name) ? '<span class="ps-i2i-new">新</span>' : ""}`;
            tile.querySelector("img").src = opts.thumbUrl(image);
            tile.addEventListener("click", () => {
                if (busy || (source && image.name === source.name)) return;
                selectSource(image);
            });
            box.appendChild(tile);
        }
    }

    // ---------- マスク ----------

    function snapshotMask() {
        return mask.getContext("2d").getImageData(0, 0, W, H);
    }

    function pushUndo() {
        undoStack.push(snapshotMask());
        if (undoStack.length > UNDO_MAX) undoStack.shift();
        redoStack = [];
    }

    function editMask(fn) {
        pushUndo();
        const g = mask.getContext("2d");
        g.save();
        fn(g);
        g.restore();
        updateTint();
        updateUi();
        draw();
    }

    function undo() {
        if (!undoStack.length) return;
        redoStack.push(snapshotMask());
        mask.getContext("2d").putImageData(undoStack.pop(), 0, 0);
        updateTint();
        updateUi();
        draw();
    }

    function redo() {
        if (!redoStack.length) return;
        undoStack.push(snapshotMask());
        mask.getContext("2d").putImageData(redoStack.pop(), 0, 0);
        updateTint();
        updateUi();
        draw();
    }

    function invertMask() {
        editMask((g) => {
            const copy = document.createElement("canvas");
            copy.width = W;
            copy.height = H;
            copy.getContext("2d").drawImage(mask, 0, 0);
            g.clearRect(0, 0, W, H);
            g.fillStyle = "#fff";
            g.fillRect(0, 0, W, H);
            g.globalCompositeOperation = "destination-out";
            g.drawImage(copy, 0, 0);
        });
    }

    // 表示用に、マスクを赤く色付けする
    function updateTint() {
        const g = tint.getContext("2d");
        g.globalCompositeOperation = "source-over";
        g.clearRect(0, 0, W, H);
        g.drawImage(mask, 0, 0);
        g.globalCompositeOperation = "source-in";
        g.fillStyle = "#ff3b3b";
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = "source-over";
    }

    function maskIsEmpty() {
        if (!mask) return true;
        const data = mask.getContext("2d").getImageData(0, 0, W, H).data;
        for (let i = 3; i < data.length; i += 16) if (data[i]) return false;
        return true;
    }

    // 生成に渡すマスク（黒地に白）。塗っていなければ null
    function maskDataUrl() {
        if (maskIsEmpty()) return null;
        const out = document.createElement("canvas");
        out.width = W;
        out.height = H;
        const g = out.getContext("2d");
        g.fillStyle = "#000";
        g.fillRect(0, 0, W, H);
        g.drawImage(mask, 0, 0);
        return out.toDataURL("image/png");
    }

    function paintTo(p) {
        const g = mask.getContext("2d");
        g.save();
        g.globalCompositeOperation = drag.erase ? "destination-out" : "source-over";
        g.strokeStyle = g.fillStyle = "#fff";
        g.lineCap = "round";
        g.lineJoin = "round";
        g.lineWidth = drag.size;
        g.beginPath();
        g.moveTo(drag.last.x, drag.last.y);
        g.lineTo(p.x + (p.x === drag.last.x && p.y === drag.last.y ? 0.01 : 0), p.y);
        g.stroke();
        g.restore();
        drag.last = p;
        updateTint();
    }

    // ---------- 表示 ----------

    function fit() {
        const stage = q(".ps-pose-stage").getBoundingClientRect();
        const w = Math.max(stage.width, 50);
        const h = Math.max(stage.height, 50);
        const zoom = clamp(Math.min((w - 40) / W, (h - 40) / H), 0.02, 40);
        view = {zoom, x: (w - W * zoom) / 2, y: (h - H * zoom) / 2};
        viewAuto = true;
    }

    const toCanvas = (sx, sy) => ({x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom});

    function draw() {
        if (!root || !isOpen() || !img) return;
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
        ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
        ctx.drawImage(img, 0, 0, W, H);
        ctx.globalAlpha = prefs.maskOpacity;
        ctx.drawImage(tint, 0, 0);
        ctx.globalAlpha = 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.strokeRect(view.x, view.y, W * view.zoom, H * view.zoom);
        if (hover && !spaceDown) {
            ctx.strokeStyle = hover.erase ? "#4ade80" : "#ff6b6b";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(hover.x, hover.y, Math.max(2, (prefs.brush / 2) * view.zoom), 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    function updateUi() {
        q(".ps-i2i-undo").disabled = !undoStack.length;
        q(".ps-i2i-redo").disabled = !redoStack.length;
        q(".ps-i2i-mode").textContent = maskIsEmpty() ? "マスクなし：画像全体を描き直します（img2img）" : "マスクあり：塗ったところを描き直します（インペイント）";
    }

    function setBusy(on) {
        busy = on;
        q(".ps-i2i-busy").classList.toggle("ps-off", !on);
        q(".ps-i2i-generate").disabled = on;
        q(".ps-i2i-close").disabled = on;
    }

    // ---------- マウス・キー ----------

    function localPos(e) {
        const r = canvasEl().getBoundingClientRect();
        return {x: e.clientX - r.left, y: e.clientY - r.top};
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
        if (e.button !== 0 || !img) return;
        pushUndo();
        const p = toCanvas(x, y);
        drag = {type: "paint", erase: e.shiftKey, size: prefs.brush, last: p};
        paintTo(p);
        draw();
    }

    function pointerMove(e) {
        const {x, y} = localPos(e);
        hover = {x, y, erase: drag && drag.type === "paint" ? drag.erase : e.shiftKey};
        canvasEl().style.cursor = spaceDown || (drag && drag.type === "pan") ? "grab" : "none";
        if (drag && drag.type === "pan") {
            view.x = drag.vx + (x - drag.sx);
            view.y = drag.vy + (y - drag.sy);
        } else if (drag && drag.type === "paint") {
            paintTo(toCanvas(x, y));
        }
        draw();
    }

    function pointerUp(e) {
        if (!drag) return;
        const wasPaint = drag.type === "paint";
        drag = null;
        try {
            canvasEl().releasePointerCapture(e.pointerId);
        } catch (err) { /* 離していれば何もしない */ }
        if (wasPaint) updateUi();
        draw();
    }

    function wheel(e) {
        e.preventDefault();
        if (e.altKey) {
            prefs.brush = clamp(Math.round(prefs.brush * (e.deltaY < 0 ? 1.15 : 1 / 1.15)), 4, 400);
            root.psSync[0]();
            savePrefs();
            draw();
            return;
        }
        const {x, y} = localPos(e);
        const before = toCanvas(x, y);
        view.zoom = clamp(view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.02, 40);
        viewAuto = false;
        view.x = x - before.x * view.zoom;
        view.y = y - before.y * view.zoom;
        draw();
    }

    function keyDown(e) {
        const typing = e.target.matches("input[type=number], input[type=text], textarea, select");
        const ctrl = e.ctrlKey || e.metaKey;
        let handled = true;
        if (e.key === "Escape") {
            close();
        } else if (ctrl && e.key === "Enter") {
            generate();
        } else if (typing) {
            handled = false;
        } else if (e.code === "Space") {
            spaceDown = true;
        } else if (ctrl && e.key.toLowerCase() === "z") {
            if (e.shiftKey) redo();
            else undo();
        } else if (ctrl && e.key.toLowerCase() === "y") {
            redo();
        } else if (e.key.toLowerCase() === "f" && !ctrl) {
            fit();
            draw();
        } else if (e.key === "Shift" && hover) {
            hover.erase = true;
            draw();
        } else {
            handled = false;
        }
        if (handled) e.preventDefault();
        // 編集画面・プロジェクト管理・WebUI のショートカットには伝えない
        e.stopPropagation();
    }

    // ---------- 生成 ----------

    async function generate() {
        if (busy || !source) return;
        const positive = q(".ps-i2i-positive").value.trim();
        if (!positive) {
            alert("プロンプトが空です。");
            return;
        }
        const seed = Number(q(".ps-i2i-seed").value);
        const settings = {
            source,
            width: W,
            height: H,
            positive,
            negative: q(".ps-i2i-negative").value,
            steps: clamp(Math.round(Number(q(".ps-i2i-steps").value) || 30), 1, 150),
            count: prefs.count,
            seed: Number.isFinite(seed) ? Math.round(seed) : -1,
            usePose: !q(".ps-i2i-pose-row").classList.contains("ps-off") && q(".ps-i2i-pose").checked,
            i2i: {
                name: source.name,
                mask: maskDataUrl(),
                denoise: prefs.denoise,
                maskBlur: prefs.maskBlur,
                fill: prefs.fill,
                onlyMasked: prefs.onlyMasked,
                padding: prefs.padding,
                width: W,
                height: H,
            },
        };
        setBusy(true);
        try {
            const made = await opts.generate(settings);
            if (!isOpen()) return;
            for (const image of made || []) fresh.add(image.name);
            renderSources();
            status(made && made.length ? `${made.length} 枚できました。右の一覧で「新」の画像を押すと、それを元にできます` : "画像はできませんでした");
        } catch (e) {
            console.error("[Polaris Studio] redraw failed", e);
            alert("描き直しに失敗しました。\n" + e.message);
        } finally {
            if (root) setBusy(false);
        }
    }

    window.PolarisI2i = {open, close, isOpen};
})();
