// Polaris Studio
// カット案のプロンプト編集。左のカテゴリ（アコーディオン）からプロジェクトのカード（タグ）を右に追加し、下のテキストを生成に使う。
// カット案は「追加したタグの並び」と「プロンプトのテキスト」を別々に持つ。テキストは直接編集でき、編集しても並びには影響しない。
// 追加・削除したときはテキストのその部分だけを書き換え、並べ替えは「右の並びでプロンプトを並べ直す」で反映する。
// 排他カテゴリのタグは同じカテゴリで1つだけ追加できる。ネガティブ専用カテゴリのタグは常にネガティブプロンプトに入る。
(function () {
    "use strict";

    let categories = [];    // 開いているプロジェクトのカテゴリ。並び順 = 順位
    let entries = [];       // 開いているプロジェクトのカード

    // ---------- データ ----------

    // カテゴリとカードは編集中のプロジェクトのもの。保存は polaris_projects.js に任せる
    async function saveData() {
        editor.project.categories = categories;
        editor.project.entries = entries;
        await editor.onChange();
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function rankOf(categoryId) {
        return categories.findIndex((c) => c.id === categoryId);
    }

    // 存在するカテゴリならその id、それ以外は "" （未分類）
    function categoryKey(item) {
        return rankOf(item.categoryId) >= 0 ? item.categoryId : "";
    }

    function isNegativeCategory(categoryId) {
        const rank = rankOf(categoryId);
        return rank >= 0 && !!categories[rank].negative;
    }

    function promptArea(tab, negative) {
        return gradioApp().querySelector(`#${tab}_${negative ? "neg_prompt" : "prompt"} textarea`);
    }

    function fillCategorySelect(select, value) {
        select.textContent = "";
        for (const c of categories) select.appendChild(el("option", {value: c.id, text: c.name + (c.negative ? "（ネガティブ）" : "")}));
        select.appendChild(el("option", {value: "", text: "未分類"}));
        select.value = value;
    }

    // ---------- タグの解析 ----------

    function splitTags(text) {
        return text.split(/[,\n]/).map((t) => t.trim()).filter((t) => t);
    }

    // 重複判定用に正規化する。(tag:1.2) や ((tag)) の強調、_ とスペースの違い、大文字小文字は同一とみなす
    function normTag(tag) {
        let s = tag.trim();
        let prev;
        do {
            prev = s;
            s = s.replace(/^[(\[{]+/, "").replace(/[)\]}]+$/, "").replace(/:\s*-?[\d.]+$/, "").trim();
        } while (s !== prev);
        return s.replace(/\\/g, "").replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase();
    }

    // 強調・重みまで区別するキー（全画面モードの選択状態の判定用）。
    // normTag では (sweat:0.8) も ((((sweat)))) も sweat になってしまうので、実際の重みを掛け合わせて比べる。
    // (tag) と (tag:1.1) は同じ重みなので同じキーになる
    function tagKey(tag) {
        let s = tag.trim();
        let w = 1;
        while (s.length >= 2) {
            if (s[0] === "(" && s[s.length - 1] === ")") {
                const inner = s.slice(1, -1).trim();
                const m = inner.match(/^(.*?):\s*(-?\d+(?:\.\d+)?)$/);
                if (m) {
                    w *= parseFloat(m[2]);
                    s = m[1].trim();
                } else {
                    w *= 1.1;
                    s = inner;
                }
            } else if (s[0] === "[" && s[s.length - 1] === "]") {
                w /= 1.1;
                s = s.slice(1, -1).trim();
            } else {
                break;
            }
        }
        return normTag(s) + "|" + w.toFixed(3);
    }

    // プロンプトをカンマ・改行区切りのタグに分け、それぞれの位置を返す
    function parsePrompt(v) {
        const tokens = [];
        const re = /[^,\n]+/g;
        let m;
        while ((m = re.exec(v))) {
            const lead = m[0].length - m[0].trimStart().length;
            const text = m[0].trim();
            if (!text) continue;
            const start = m.index + lead;
            tokens.push({text: text, start: start, end: start + text.length, norm: normTag(text), key: tagKey(text)});
        }
        return tokens;
    }

    function setPrompt(ta, value) {
        if (ta.value === value) return;
        ta.value = value;
        updateInput(ta);
    }

    // ---------- 画面部品 ----------

    function el(tag, attrs, children) {
        const e = document.createElement(tag);
        if (attrs) {
            for (const [k, val] of Object.entries(attrs)) {
                if (k === "class") e.className = val;
                else if (k === "text") e.textContent = val;
                else if (k.startsWith("on")) e.addEventListener(k.slice(2), val);
                else e.setAttribute(k, val);
            }
        }
        for (const c of children || []) e.appendChild(c);
        return e;
    }

    function hasUncategorized() {
        return entries.some((x) => categoryKey(x) === "");
    }

    // カテゴリ名の横に「1」（排他）「N」（ネガティブ専用）の印を付ける
    function appendCategoryBadges(e, cat) {
        const notes = [];
        if (cat.negative) {
            e.appendChild(el("span", {class: "mtm-badge mtm-neg-badge", text: "N"}));
            notes.push("ネガティブ専用: タグはネガティブプロンプトに入ります");
        }
        if (cat.exclusive) {
            e.appendChild(el("span", {class: "mtm-badge mtm-excl-badge", text: "1"}));
            notes.push("排他: このカテゴリのタグは1つだけ入力できます");
        }
        if (notes.length) e.title = notes.join("\n");
    }

    // ---------- ドラッグで並べ替え ----------

    const DRAG_TYPE = "application/x-mtm-sort";  // text/plain にするとプロンプト欄へドロップしたとき文字が入ってしまう
    let dragState = null;   // {item, group}

    function makeHandle() {
        return el("span", {class: "mtm-handle", title: "ドラッグで並べ替え", text: "⠿", onclick: (e) => e.stopPropagation()});
    }

    // arr の中で item を target の前（after なら後ろ）に移す
    function moveItem(arr, item, target, after) {
        const from = arr.indexOf(item);
        if (from < 0 || item === target) return;
        arr.splice(from, 1);
        const to = arr.indexOf(target) + (after ? 1 : 0);
        arr.splice(to, 0, item);
    }

    // 行をハンドルからドラッグできるようにする。並べ替えは同じ group の行どうしに限る
    // horizontal: 横に並ぶ要素（全画面モードのカテゴリブロック）なら左右の半分で前後を判定する
    function makeSortable(row, handle, item, group, onDrop, horizontal) {
        if (horizontal) row.classList.add("mtm-sort-h");
        const clearMarks = () => row.classList.remove("mtm-drop-before", "mtm-drop-after");
        // 行全体を常に draggable にすると、クリックでの選択や入力欄の文字選択と干渉するため、ハンドルを押したときだけ有効にする
        handle.addEventListener("mousedown", () => (row.draggable = true));
        handle.addEventListener("mouseup", () => (row.draggable = false));
        row.addEventListener("dragstart", (e) => {
            // カードの中のハンドルを掴んだときに、外側のブロックまでドラッグ扱いにならないようにする
            e.stopPropagation();
            dragState = {item, group};
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(DRAG_TYPE, "");
            row.classList.add("mtm-dragging");
        });
        row.addEventListener("dragend", () => {
            row.draggable = false;
            row.classList.remove("mtm-dragging");
            document.querySelectorAll(".mtm-drop-before, .mtm-drop-after").forEach((x) => x.classList.remove("mtm-drop-before", "mtm-drop-after"));
            dragState = null;
        });
        row.addEventListener("dragover", (e) => {
            if (!dragState || dragState.group !== group || dragState.item === item) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const r = row.getBoundingClientRect();
            const after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
            row.classList.toggle("mtm-drop-before", !after);
            row.classList.toggle("mtm-drop-after", after);
        });
        row.addEventListener("dragleave", clearMarks);
        row.addEventListener("drop", (e) => {
            if (!dragState || dragState.group !== group || dragState.item === item) return;
            e.preventDefault();
            const after = row.classList.contains("mtm-drop-after");
            const from = dragState.item;
            // onDrop で一覧を描き直すとドラッグ元の行が消えて dragend が届かないため、ここで片付ける
            dragState = null;
            clearMarks();
            onDrop(from, item, after);
        });
    }

    // ---------- 並べきれない要素の山 ----------
    // 横1列に並べきれない要素を、右側の 1/4 ほどの場所にトランプのように重ねる（カット案のカード、編集画面のサムネイル）。
    // 一番上のすぐ下の要素は見える幅を 2 倍、その下は 1.5 倍にする。山の上でマウスを左右に動かすと、その位置の要素が前に出る

    function unstack(row, items, before) {
        for (const item of items) {
            item.classList.remove("ps-stacked", "ps-active");
            item.style.left = item.style.zIndex = "";
            row.insertBefore(item, before);
        }
        const old = row.querySelector(":scope > .ps-stack");
        if (old) old.remove();
    }

    // row: 要素を横に並べている入れ物。before: 山の後ろに置く要素（カット案の「＋ カット案」など）。label: 山の下に出す「ほか N 件」。
    // hold: マウスのイベントを受け取り、true を返すあいだは前に出す要素を切り替えない
    function stackOverflow(row, items, {before = null, label, hold = null}) {
        unstack(row, items, before);
        const width = row.clientWidth;
        if (!width || !items.length) return null;

        const itemWidth = items[0].offsetWidth;
        const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        const tail = before ? gap + before.offsetWidth : 0;
        if (items.length * (itemWidth + gap) - gap + tail <= width) return null;

        const baseWidth = Math.max(Math.round(width / 4), itemWidth + 40);
        // 各要素の見える幅は、山の幅を枚数で等分した幅。一番上のすぐ下だけ 2 倍、その下は 1.5 倍にする
        const offsets = (count) => {
            const step = count > 1 ? (baseWidth - itemWidth) / (count - 1) : 0;
            const lefts = [0];
            for (let i = 0; i < count - 1; i++) {
                const fromTop = count - 1 - i;
                lefts.push(lefts[i] + step * (fromTop === 1 ? 2 : fromTop === 2 ? 1.5 : 1));
            }
            return lefts;
        };
        // 広げた分も含めて収まるところまで、横に並べる数を減らす
        let shown = Math.min(Math.floor((width - tail - baseWidth) / (itemWidth + gap)), items.length - 1);
        while (shown > 0) {
            const lefts = offsets(items.length - shown);
            if (shown * (itemWidth + gap) + lefts[lefts.length - 1] + itemWidth + tail <= width) break;
            shown--;
        }
        shown = Math.max(shown, 0);
        const rest = items.slice(shown);
        const lefts = offsets(rest.length);
        const stackWidth = lefts[lefts.length - 1] + itemWidth;
        const stack = el("div", {class: "ps-stack"}, [el("span", {class: "ps-stack-count", text: label(rest.length)})]);
        stack.style.width = Math.round(stackWidth) + "px";
        rest.forEach((item, i) => {
            item.classList.add("ps-stacked");
            item.style.left = Math.round(lefts[i]) + "px";
            item.style.zIndex = i + 1;
            stack.appendChild(item);
        });
        row.insertBefore(stack, before);
        stack.style.height = Math.max(...rest.map((x) => x.offsetHeight)) + "px";

        // マウスの位置を山の幅で等分して、前に出す要素を決める
        let active = null;
        const activate = (e) => {
            // 呼び出し側が止めているあいだ（カット案のコマンドバーの近くなど）は切り替えない
            if (hold && hold(e)) return;
            const x = e.clientX - stack.getBoundingClientRect().left;
            const item = rest[Math.min(Math.max(Math.floor(x / (stackWidth / rest.length)), 0), rest.length - 1)];
            if (item === active) return;
            if (active) active.classList.remove("ps-active");
            active = item;
            item.classList.add("ps-active");
        };
        const deactivate = () => {
            if (active) active.classList.remove("ps-active");
            active = null;
        };
        stack.addEventListener("mousemove", activate);
        // 止めているあいだに山の外へ出たとき（山の上に浮かせたバーへ移ったときなど）は、前に出したままにする
        stack.addEventListener("mouseleave", (e) => {
            if (!hold || !hold(e)) deactivate();
        });
        // ドラッグ中も同じように前に出して、重なった要素にも落とせるようにする
        stack.addEventListener("dragover", activate, true);
        stack.addEventListener("dragleave", (e) => {
            if (!stack.contains(e.relatedTarget)) deactivate();
        });
        return stack;
    }

    // ---------- 編集画面 ----------
    // 左にカテゴリ（アコーディオン）、右に追加したタグの並び、下に生成に使うプロンプトのテキストを置く。
    // 右側で追加・削除したときは、テキストのその部分だけを書き換える。手で書いた部分には触らない。
    // 右側の並べ替えは、「右の並びでプロンプトを並べ直す」を押すまでテキストに反映しない。

    let fs = null;
    let fsTab = "txt2img";
    let editor = null;              // 編集中の {project, cut, onChange, onPreview, onQueue, onQueues, onClose, images, thumbUrl, keyImage, openImage}
    let fsPicks = [];               // 追加したタグ（カードの id）の並び
    let fsPicksInitial = [];        // 開いた時点（保存した時点）の並び
    let fsLeftSel = null;           // 左で選んでいるカードの id
    let fsRightSel = null;          // 右で選んでいるカードの id
    let fsOpenCats = new Set();     // 開いているカテゴリの id（未分類は ""）
    let fsDialogSave = null;
    let fsPendingNext = null;       // 未保存の確認の後に進む先
    let fsPendingSave = null;       // 差分の確認の後に進む先

    function fq(sel) {
        return fs.querySelector(sel);
    }

    // 強調・重みまで区別したキーの一覧（テキストに入っているかの判定に使う）
    function keysOf(text) {
        return splitTags(text).filter((t) => normTag(t)).map(tagKey);
    }

    const entryById = (id) => entries.find((x) => x.id === id);
    const pickedItems = () => fsPicks.map(entryById).filter(Boolean);
    const posArea = () => fq(".ps-ed-pos-text");
    const negArea = () => fq(".ps-ed-neg-text");
    const areaOf = (item) => (isNegativeCategory(item.categoryId) ? negArea() : posArea());

    function buildFullscreen() {
        fs = el("div", {id: "mtm-fs", class: "mtm-hidden", tabindex: "-1"});
        fs.innerHTML = `
            <div class="mtm-fs-window ps-editor">
                <div class="mtm-fs-bar">
                    <button type="button" class="mtm-btn mtm-fs-back">← 戻る</button>
                    <input type="text" class="ps-title-input mtm-fs-cut-title" title="カット案のタイトル">
                    <span class="mtm-fs-param" title="このカット案で生成する画像のサイズ（幅 × 高さ、8 の倍数）。プレビューとキューの生成に使います。空欄のときは WebUI の設定のままで、最初に生成した画像のサイズを覚えます">サイズ<input type="number" class="mtm-fs-width" min="64" max="2048" step="8" placeholder="幅">×<input type="number" class="mtm-fs-height" min="64" max="2048" step="8" placeholder="高さ"><button type="button" class="mtm-icon mtm-fs-size-swap" title="幅と高さを入れ替える（縦長 ⇄ 横長）">⇄</button></span>
                    <label class="mtm-fs-param" title="このカット案のプレビューの Sampling steps">Steps<input type="number" class="mtm-fs-steps" min="1" step="1"></label>
                    <span class="mtm-fs-param" title="このカット案のプレビューの Seed（-1 でランダム）">Seed<input type="number" class="mtm-fs-seed" step="1"><button type="button" class="mtm-icon mtm-fs-seed-random" title="ランダム（-1）にする">🎲</button></span>
                    <span class="mtm-fs-param" title="このカット案のプレビューの Variation seed（-1 でランダム。Var が 0 のときは生成に使われません）">Var Seed<input type="number" class="mtm-fs-subseed" step="1"><button type="button" class="mtm-icon mtm-fs-subseed-random" title="ランダム（-1）にする">🎲</button></span>
                    <label class="mtm-fs-param" title="このカット案のプレビューの Variation strength（0〜1）">Var<input type="number" class="mtm-fs-var" min="0" max="1" step="0.01"></label>
                    <div class="mtm-fs-progress mtm-hidden"></div>
                    <span class="mtm-fs-spacer"></span>
                    <button type="button" class="mtm-btn mtm-fs-queues" title="プロジェクト全体のキューを管理（編集中の内容はそのまま）">▶ キュー管理</button>
                </div>
                <div class="ps-ed-thumbs"></div>
                <div class="ps-ed-picker">
                    <div class="ps-ed-pane">
                        <div class="ps-ed-pane-head">
                            <span class="ps-ed-label">カテゴリ</span>
                            <input type="search" class="mtm-fs-search" placeholder="検索（タグ・説明）">
                            <button type="button" class="mtm-btn mtm-fs-add-cat">＋ カテゴリ</button>
                        </div>
                        <div class="ps-ed-pane-body ps-ed-cats"></div>
                    </div>
                    <div class="ps-ed-moves">
                        <button type="button" class="mtm-btn ps-ed-add" title="左で選んだタグを追加（ダブルクリックでも追加できます）">追加 &gt;&gt;</button>
                        <button type="button" class="mtm-btn ps-ed-remove" title="右で選んだタグを外す（ダブルクリックでも外せます）">&lt;&lt; 削除</button>
                    </div>
                    <div class="ps-ed-pane">
                        <div class="ps-ed-pane-head">
                            <span class="ps-ed-label">追加したタグ</span>
                            <span class="ps-ed-note" title="どのタグにも当たらないもの（手で書いたタグ）は後ろに残します">⠿ で並べ替えると、プロンプトもその順に並べ直します（左のカテゴリには影響しません）</span>
                        </div>
                        <div class="ps-ed-pane-body ps-ed-picks"></div>
                    </div>
                </div>
                <div class="ps-ed-prompts">
                    <label class="ps-ed-label">ポジティブプロンプト <span class="ps-ed-note">生成に使う最終プロンプト。直接編集でき、ここでの編集は上のリストに影響しません</span>
                        <textarea class="ps-ed-pos-text" rows="6" spellcheck="false"></textarea>
                    </label>
                    <label class="ps-ed-label">ネガティブプロンプト <span class="ps-ed-note">ネガティブ専用カテゴリのタグはこちらに入ります</span>
                        <textarea class="ps-ed-neg-text" rows="2" spellcheck="false"></textarea>
                    </label>
                </div>
                <div class="ps-ed-commands">
                    <span class="mtm-fs-dirty mtm-hidden">未保存の変更があります</span>
                    <span class="mtm-fs-saved mtm-hidden">保存しました</span>
                    <span class="mtm-fs-spacer"></span>
                    <button type="button" class="mtm-btn mtm-fs-history" title="保存した版の一覧">履歴</button>
                    <button type="button" class="mtm-btn mtm-primary mtm-fs-save">保存</button>
                    <button type="button" class="mtm-btn mtm-primary mtm-fs-preview" title="1枚だけ今すぐ生成">プレビュー</button>
                    <button type="button" class="mtm-btn mtm-primary mtm-fs-queue" title="キューを登録">キュー</button>
                </div>
            </div>
            <div class="ps-backdrop ps-off ps-confirm-dialog">
                <div class="ps-dialog">
                    <div class="ps-dialog-head">保存していない変更があります</div>
                    <div class="ps-confirm-text">変更を保存してから進みますか？</div>
                    <div class="ps-diff-list ps-confirm-diff"></div>
                    <div class="mtm-form-actions">
                        <button type="button" class="mtm-btn ps-confirm-cancel">キャンセル</button>
                        <button type="button" class="mtm-btn ps-confirm-discard">保存せずに進む</button>
                        <button type="button" class="mtm-btn mtm-primary ps-confirm-save">保存して進む</button>
                    </div>
                </div>
            </div>
            <div class="ps-backdrop ps-off ps-diff-dialog">
                <div class="ps-dialog">
                    <div class="ps-dialog-head">プロンプトの変更を確認</div>
                    <div class="ps-diff-list ps-save-diff"></div>
                    <div class="mtm-form-actions">
                        <button type="button" class="mtm-btn ps-diff-cancel">キャンセル</button>
                        <button type="button" class="mtm-btn mtm-primary ps-diff-save">保存</button>
                    </div>
                </div>
            </div>
            <div class="ps-backdrop ps-off ps-history-dialog">
                <div class="ps-dialog">
                    <div class="ps-dialog-head">保存履歴</div>
                    <div class="ps-history-list"></div>
                    <div class="mtm-form-actions">
                        <button type="button" class="mtm-btn mtm-primary ps-history-close">閉じる</button>
                    </div>
                </div>
            </div>
            <div class="mtm-dialog-backdrop mtm-cdialog mtm-hidden">
                <div class="mtm-dialog">
                    <div class="mtm-dialog-title"></div>
                    <label>カテゴリ名<input type="text" class="mtm-c-name" placeholder="例: 画質、キャラ、服装、背景"></label>
                    <label class="mtm-check"><input type="checkbox" class="mtm-c-excl">排他（このカテゴリのタグは1つだけ追加でき、別のタグを追加すると置き換わる）</label>
                    <label class="mtm-check"><input type="checkbox" class="mtm-c-neg">ネガティブ専用（このカテゴリのタグは常にネガティブプロンプトに入る）</label>
                    <div class="mtm-form-actions">
                        <button type="button" class="mtm-btn mtm-danger mtm-c-delete">削除</button>
                        <span class="mtm-hint">Enter で保存</span>
                        <button type="button" class="mtm-btn mtm-c-cancel">キャンセル</button>
                        <button type="button" class="mtm-btn mtm-primary mtm-c-save">保存</button>
                    </div>
                </div>
            </div>
            <div class="mtm-dialog-backdrop mtm-tdialog mtm-hidden">
                <div class="mtm-dialog">
                    <div class="mtm-dialog-title"></div>
                    <label>タグ<textarea class="mtm-d-tags" rows="3" placeholder="例: simple_background, white_background"></textarea></label>
                    <label>説明<input type="text" class="mtm-d-desc" placeholder="例: 白い無地背景"></label>
                    <label>カテゴリ<select class="mtm-d-cat"></select></label>
                    <div class="mtm-form-actions">
                        <span class="mtm-hint">Ctrl+Enter で保存</span>
                        <button type="button" class="mtm-btn mtm-d-cancel">キャンセル</button>
                        <button type="button" class="mtm-btn mtm-primary mtm-d-save">保存</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(fs);

        const search = fq(".mtm-fs-search");
        search.addEventListener("input", renderCats);
        search.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            // Esc は編集画面を閉じずに、検索を消すだけにする
            e.preventDefault();
            e.stopPropagation();
            search.value = "";
            renderCats();
            fs.focus();
        });
        fq(".mtm-fs-back").addEventListener("click", () => leaveEditor(closeEditor));
        // 保存だけを行い、編集画面は閉じない
        fq(".mtm-fs-save").addEventListener("click", () => requestSave(showSaved));
        fq(".mtm-fs-history").addEventListener("click", openHistory);
        fq(".mtm-fs-preview").addEventListener("click", () => leaveEditor(() => editor.onPreview(editor.cut)));
        fq(".mtm-fs-queue").addEventListener("click", () => leaveEditor(() => editor.onQueue(editor.cut)));
        // キュー管理はカット案の内容を使わないので、保存の確認なしで開く
        fq(".mtm-fs-queues").addEventListener("click", (e) => editor.onQueues(e.currentTarget));
        fq(".mtm-fs-add-cat").addEventListener("click", () => openCategoryDialog(null));
        fq(".ps-ed-add").addEventListener("click", () => addPick(entryById(fsLeftSel)));
        fq(".ps-ed-remove").addEventListener("click", () => removePick(entryById(fsRightSel)));
        fq(".ps-editor").addEventListener("input", (e) => {
            // 手でテキストを書き換えたら、右側の「テキストにない」の印を付け直す
            if (e.target.matches(".ps-ed-pos-text, .ps-ed-neg-text")) renderPicks();
            updateDirty();
        });
        fq(".mtm-fs-size-swap").addEventListener("click", () => {
            const w = fq(".mtm-fs-width");
            const h = fq(".mtm-fs-height");
            [w.value, h.value] = [h.value, w.value];
            updateDirty();
        });
        for (const name of ["seed", "subseed"]) {
            fq(`.mtm-fs-${name}-random`).addEventListener("click", () => {
                fq(`.mtm-fs-${name}`).value = -1;
                updateDirty();
            });
        }
        fq(".ps-confirm-cancel").addEventListener("click", () => finishConfirm(false));
        fq(".ps-confirm-discard").addEventListener("click", () => {
            loadEditorState();
            renderEditor();
            finishConfirm(true);
        });
        fq(".ps-confirm-save").addEventListener("click", () => {
            // 差分はこの確認の中で見せているので、もう一度は聞かない
            const next = fsPendingNext;
            finishConfirm(false);
            commitEditor();
            next();
        });
        fq(".ps-diff-cancel").addEventListener("click", () => closeDiff());
        fq(".ps-diff-save").addEventListener("click", () => {
            const next = fsPendingSave;
            closeDiff();
            commitEditor();
            next();
        });
        fq(".ps-history-close").addEventListener("click", closeHistory);
        fq(".mtm-d-cancel").addEventListener("click", closeDialog);
        fq(".mtm-d-save").addEventListener("click", submitDialog);
        fq(".mtm-tdialog .mtm-dialog").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submitDialog();
            }
        });
        fq(".mtm-c-cancel").addEventListener("click", closeCategoryDialog);
        fq(".mtm-c-save").addEventListener("click", submitCategoryDialog);
        fq(".mtm-c-delete").addEventListener("click", deleteCategoryFromDialog);
        fq(".mtm-c-name").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                submitCategoryDialog();
            }
        });
        // WebUI 本体のショートカット（Ctrl+Enter で生成など）に伝わらないようにする
        fs.addEventListener("keydown", (e) => {
            // プロジェクト管理の部品（ビューワーなど）が先に受け取って閉じたときは、何もしない
            if (e.key === "Escape" && editor && !e.defaultPrevented) {
                e.preventDefault();
                const open = (sel) => !fq(sel).classList.contains("ps-off");
                if (!fq(".mtm-tdialog").classList.contains("mtm-hidden")) closeDialog();
                else if (!fq(".mtm-cdialog").classList.contains("mtm-hidden")) closeCategoryDialog();
                else if (open(".ps-diff-dialog")) closeDiff();
                else if (open(".ps-confirm-dialog")) finishConfirm(false);
                else if (open(".ps-history-dialog")) closeHistory();
                else leaveEditor(closeEditor);
            }
            e.stopPropagation();
        });

        // 幅が変わったらサムネイルの山を作り直す
        let thumbsWidth = 0;
        new ResizeObserver((list) => {
            const width = Math.round(list[0].contentRect.width);
            if (width === thumbsWidth) return;
            thumbsWidth = width;
            requestAnimationFrame(stackThumbs);
        }).observe(fq(".ps-ed-thumbs"));
    }

    // ---------- カット案のテキストとカードの照合（まだ並びを保存していないカット案を開いたときだけ使う） ----------

    // テキストに全部のタグが（強調・重みも同じ形で）入っているカードを選択状態とする。排他カテゴリはタグ数の多い1つだけ
    function analyzeCut(cats, ents, positive, negative) {
        const negativeIds = new Set(cats.filter((c) => c.negative).map((c) => c.id));
        const exclusiveIds = new Set(cats.filter((c) => c.exclusive).map((c) => c.id));
        const destOf = (item) => (negativeIds.has(item.categoryId) ? "neg" : "pos");
        const present = {pos: new Set(parsePrompt(positive).map((t) => t.key)), neg: new Set(parsePrompt(negative).map((t) => t.key))};
        const selected = new Set();
        const exclusivePick = new Map();
        for (const item of ents) {
            const keys = keysOf(item.tags);
            if (!keys.length || !keys.every((k) => present[destOf(item)].has(k))) continue;
            if (exclusiveIds.has(item.categoryId)) {
                const prev = exclusivePick.get(item.categoryId);
                if (!prev || prev.keys.length < keys.length) exclusivePick.set(item.categoryId, {item, keys});
                continue;
            }
            selected.add(item.id);
        }
        for (const {item} of exclusivePick.values()) selected.add(item.id);
        return selected;
    }

    // 照合で当てはまったカードを、左の並び順（カテゴリ → カード）で並べる
    function migratePicks(cut) {
        const selected = analyzeCut(categories, entries, cut.positive, cut.negative);
        return catBlocks().flatMap((b) => entries.filter((x) => categoryKey(x) === b.id && selected.has(x.id)).map((x) => x.id));
    }

    // ---------- プロンプト編集の開閉 ----------

    function openEditor(options) {
        editor = options;
        categories = editor.project.categories;
        entries = editor.project.entries;
        fq(".mtm-fs-search").value = "";
        loadEditorState();
        loadOpenCats();
        fq(".ps-editor").classList.remove("ps-off");
        renderEditor();
        renderThumbs();
        fs.focus();
    }

    function closeEditor() {
        closeDialog();
        closeCategoryDialog();
        closeHistory();
        const done = editor.onClose;
        editor = null;
        fq(".ps-editor").classList.add("ps-off");
        done();
    }

    // カット案の内容から画面の状態を作り直す
    function loadEditorState() {
        const cut = editor.cut;
        const ids = new Set(entries.map((x) => x.id));
        // 消したカードは並びから外す
        fsPicks = Array.isArray(cut.picks) ? cut.picks.filter((id) => ids.has(id)) : migratePicks(cut);
        fsPicksInitial = [...fsPicks];
        fsLeftSel = null;
        fsRightSel = null;
        posArea().value = cut.positive;
        negArea().value = cut.negative;
        fq(".mtm-fs-cut-title").value = cut.title;
        fq(".mtm-fs-width").value = cut.width || "";
        fq(".mtm-fs-height").value = cut.height || "";
        fq(".mtm-fs-steps").value = cut.steps;
        fq(".mtm-fs-seed").value = cut.seed;
        fq(".mtm-fs-subseed").value = cut.subseed;
        fq(".mtm-fs-var").value = cut.subseedStrength;
    }

    // アコーディオンの開閉はプロジェクトごとにブラウザに覚えておく。初めて開くときは、追加済みのタグがあるカテゴリを開く
    const openCatsKey = () => "polaris-studio:open-categories:" + editor.project.id;

    function loadOpenCats() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(openCatsKey()));
        } catch (e) {
            saved = null;
        }
        fsOpenCats = Array.isArray(saved) ? new Set(saved) : new Set(pickedItems().map(categoryKey));
    }

    function toggleCat(id) {
        if (fsOpenCats.has(id)) fsOpenCats.delete(id);
        else fsOpenCats.add(id);
        saveOpenCats();
        renderCats();
    }

    function saveOpenCats() {
        try {
            localStorage.setItem(openCatsKey(), JSON.stringify([...fsOpenCats]));
        } catch (e) {
            // 覚えておけなくても、開閉そのものはできる
        }
    }

    // 右で選んだタグのカテゴリを左で開き、見出しが見える位置まで送って少しの間目立たせる
    function revealCat(item) {
        const id = categoryKey(item);
        if (!fsOpenCats.has(id)) {
            fsOpenCats.add(id);
            saveOpenCats();
            renderCats();
        }
        const box = fq(".ps-ed-cats");
        const block = [...box.querySelectorAll(".ps-ed-cat")].find((x) => x.dataset.cat === id);
        if (!block) return;
        box.scrollTop += block.getBoundingClientRect().top - box.getBoundingClientRect().top;
        block.classList.remove("ps-ed-focus");
        void block.offsetWidth;     // 続けて選んだときもアニメーションをやり直す
        block.classList.add("ps-ed-focus");
    }

    function readParams() {
        const int = (sel, min, fallback) => {
            const v = Math.round(Number(fq(sel).value));
            return fq(sel).value.trim() === "" || !Number.isFinite(v) ? fallback : Math.max(v, min);
        };
        const strength = Number(fq(".mtm-fs-var").value);
        // サイズは 8 の倍数（64〜2048）にそろえる。幅と高さのどちらかが空なら、サイズは決めない（0）
        const size = (sel) => {
            const v = Number(fq(sel).value);
            return fq(sel).value.trim() === "" || !Number.isFinite(v) || v <= 0 ? 0 : Math.min(Math.max(Math.round(v / 8) * 8, 64), 2048);
        };
        const width = size(".mtm-fs-width");
        const height = size(".mtm-fs-height");
        return {
            title: fq(".mtm-fs-cut-title").value.trim() || editor.cut.title,
            width: width && height ? width : 0,
            height: width && height ? height : 0,
            steps: int(".mtm-fs-steps", 1, 50),
            seed: int(".mtm-fs-seed", -1, -1),
            subseed: int(".mtm-fs-subseed", -1, -1),
            subseedStrength: Number.isFinite(strength) ? Math.round(Math.min(Math.max(strength, 0), 1) * 100) / 100 : 0,
        };
    }

    // プロンプトのテキストが変わっているか
    function textDirty() {
        return posArea().value !== editor.cut.positive || negArea().value !== editor.cut.negative;
    }

    function picksDirty() {
        return fsPicks.length !== fsPicksInitial.length || fsPicks.some((id, i) => id !== fsPicksInitial[i]);
    }

    function paramsDirty() {
        const p = readParams();
        // サイズを持たない古いカット案は 0（決めていない）として比べる
        return Object.keys(p).some((k) => p[k] !== (k === "width" || k === "height" ? editor.cut[k] || 0 : editor.cut[k]));
    }

    function fsDirty() {
        return textDirty() || picksDirty() || paramsDirty();
    }

    function updateDirty() {
        if (editor) fq(".mtm-fs-dirty").classList.toggle("mtm-hidden", !fsDirty());
    }

    // ---------- 保存 ----------

    // プロンプトが変わる保存は、差分を確認してから行う
    function requestSave(next) {
        if (!textDirty()) {
            commitEditor();
            next();
            return;
        }
        fsPendingSave = next;
        renderDiff(fq(".ps-save-diff"));
        fq(".ps-diff-dialog").classList.remove("ps-off");
    }

    function renderDiff(list) {
        list.textContent = "";
        for (const [label, before, now] of [["ポジティブ", editor.cut.positive, posArea().value], ["ネガティブ", editor.cut.negative, negArea().value]]) {
            if (before === now) continue;
            list.appendChild(el("div", {class: "ps-diff-label", text: label + "（変更前）"}));
            list.appendChild(makeDiffText(before, now, "ps-diff-removed"));
            list.appendChild(el("div", {class: "ps-diff-label", text: label + "（変更後）"}));
            list.appendChild(makeDiffText(now, before, "ps-diff-added"));
        }
    }

    // text を表示し、other にないタグだけを cls で色分けする。並び順が変わっただけのタグは色を付けない
    function makeDiffText(text, other, cls) {
        const box = el("div", {class: "ps-diff-text", text: text.trim() ? "" : "（空）"});
        const keys = new Set(parsePrompt(other).map((t) => t.key));
        let pos = 0;
        for (const t of parsePrompt(text)) {
            box.appendChild(document.createTextNode(text.slice(pos, t.start)));
            box.appendChild(el("span", {class: keys.has(t.key) ? "" : cls, text: t.text}));
            pos = t.end;
        }
        box.appendChild(document.createTextNode(text.slice(pos)));
        return box;
    }

    function closeDiff() {
        fq(".ps-diff-dialog").classList.add("ps-off");
        fsPendingSave = null;
    }

    function changePrompt(cut, positive, negative) {
        if (positive === cut.positive && negative === cut.negative) return;
        cut.history.unshift({at: new Date().toISOString(), positive: cut.positive, negative: cut.negative});
        cut.positive = positive;
        cut.negative = negative;
    }

    function commitEditor() {
        const cut = editor.cut;
        Object.assign(cut, readParams());
        cut.picks = [...fsPicks];
        changePrompt(cut, posArea().value, negArea().value);
        loadEditorState();
        renderEditor();
        saveData();
    }

    // 保存ボタンで保存したことを、少しの間だけ知らせる
    let savedTimer = null;
    function showSaved() {
        const saved = fq(".mtm-fs-saved");
        saved.classList.remove("mtm-hidden");
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => saved.classList.add("mtm-hidden"), 2000);
    }

    // 未保存の変更があれば確認してから next へ進む
    function leaveEditor(next) {
        if (!fsDirty()) {
            next();
            return;
        }
        fsPendingNext = next;
        // タイトルや Steps、右側の並びだけの変更ならテキストは変わらないので、差分は出さない
        const changed = textDirty();
        fq(".ps-confirm-diff").classList.toggle("ps-off", !changed);
        if (changed) renderDiff(fq(".ps-confirm-diff"));
        fq(".ps-confirm-dialog").classList.remove("ps-off");
    }

    function finishConfirm(run) {
        fq(".ps-confirm-dialog").classList.add("ps-off");
        const next = fsPendingNext;
        fsPendingNext = null;
        if (run) next();
    }

    // ---------- 保存履歴 ----------

    function formatDate(iso) {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP", {dateStyle: "short", timeStyle: "short"});
    }

    function renderHistory() {
        const list = fq(".ps-history-list");
        list.textContent = "";
        const history = editor.cut.history;
        if (!history.length) list.appendChild(el("div", {class: "mtm-empty", text: "まだ履歴はありません"}));
        history.forEach((h) => {
            list.appendChild(el("div", {class: "ps-history-row"}, [
                el("span", {class: "ps-history-at", text: formatDate(h.at)}),
                el("span", {class: "ps-history-prompt", text: h.positive || "（空）"}),
                el("button", {type: "button", class: "mtm-btn", text: "この版に戻す", onclick: () => leaveEditor(() => restoreHistory(h))}),
            ]));
        });
    }

    function openHistory() {
        renderHistory();
        fq(".ps-history-dialog").classList.remove("ps-off");
    }

    function closeHistory() {
        fq(".ps-history-dialog").classList.add("ps-off");
    }

    // 戻すのはテキストだけ。右側の並びはそのまま残す
    function restoreHistory(h) {
        changePrompt(editor.cut, h.positive, h.negative);
        loadEditorState();
        renderEditor();
        renderHistory();
        saveData();
    }

    // ---------- テキストへの反映 ----------

    // テキストの i 番目のタグを、前後の区切りごと取り除く
    function cutToken(text, tokens, i) {
        const t = tokens[i];
        if (i + 1 < tokens.length) return text.slice(0, t.start) + text.slice(tokens[i + 1].start);
        if (i > 0) return text.slice(0, tokens[i - 1].end) + text.slice(t.end);
        return text.slice(0, t.start) + text.slice(t.end);
    }

    // 追加したタグをテキストに入れる。右側で1つ前にある追加済みタグの直後、前がなければ後ろにある追加済みタグの直前、
    // どちらもなければ末尾に入れる。すでに入っているタグは重ねて入れない
    function insertTags(item) {
        const area = areaOf(item);
        const text = area.value;
        const tokens = parsePrompt(text);
        const present = new Set(tokens.map((t) => t.key));
        const tags = splitTags(item.tags).filter((t) => normTag(t) && !present.has(tagKey(t)));
        if (!tags.length) return;
        const negative = isNegativeCategory(item.categoryId);
        const same = pickedItems().filter((x) => isNegativeCategory(x.categoryId) === negative);
        const at = same.indexOf(item);
        const hitsOf = (x) => {
            const keys = new Set(keysOf(x.tags));
            return tokens.filter((t) => keys.has(t.key));
        };
        let pos = -1;
        let before = false;
        for (let i = at - 1; i >= 0 && pos < 0; i--) {
            const hits = hitsOf(same[i]);
            if (hits.length) pos = Math.max(...hits.map((t) => t.end));
        }
        for (let i = at + 1; i < same.length && pos < 0; i++) {
            const hits = hitsOf(same[i]);
            if (hits.length) {
                pos = Math.min(...hits.map((t) => t.start));
                before = true;
            }
        }
        const joined = tags.join(", ");
        if (pos < 0) {
            const body = text.replace(/[\s,]+$/, "");
            area.value = body ? body + ", " + joined : joined;
        } else if (before) {
            area.value = text.slice(0, pos) + joined + ", " + text.slice(pos);
        } else {
            area.value = text.slice(0, pos) + ", " + joined + text.slice(pos);
        }
    }

    // そのタグをテキストから消す。ほかの追加済みタグと重なるタグは残す
    function removeTags(item) {
        const area = areaOf(item);
        const negative = isNegativeCategory(item.categoryId);
        const others = new Set(pickedItems().filter((x) => x.id !== item.id && isNegativeCategory(x.categoryId) === negative).flatMap((x) => keysOf(x.tags)));
        const drop = new Set(keysOf(item.tags).filter((k) => !others.has(k)));
        let text = area.value;
        for (;;) {
            const tokens = parsePrompt(text);
            const i = tokens.findIndex((t) => drop.has(t.key));
            if (i < 0) break;
            text = cutToken(text, tokens, i);
        }
        area.value = text;
    }

    // 右の並びでテキストを並べ直す（右の並べ替えのたびに行う）。追加済みのどのタグにも当たらないタグ（手で書いたもの）は後ろに残す
    function reorderText() {
        for (const negative of [false, true]) {
            const area = negative ? negArea() : posArea();
            const tokens = parsePrompt(area.value);
            const used = new Set();
            const out = [];
            for (const item of pickedItems().filter((x) => isNegativeCategory(x.categoryId) === negative)) {
                for (const key of keysOf(item.tags)) {
                    const j = tokens.findIndex((t, i) => !used.has(i) && t.key === key);
                    if (j < 0) continue;
                    used.add(j);
                    out.push(tokens[j].text);
                }
            }
            tokens.forEach((t, i) => {
                if (!used.has(i)) out.push(t.text);
            });
            const next = out.join(", ");
            if (next !== parsePrompt(area.value).map((t) => t.text).join(", ")) area.value = next;
        }
        renderPicks();
        updateDirty();
    }

    // 追加したタグが全部テキストに入っているか
    function inText(item) {
        const present = new Set(parsePrompt(areaOf(item).value).map((t) => t.key));
        return keysOf(item.tags).every((k) => present.has(k));
    }

    // ---------- 追加・削除 ----------

    function addPick(item) {
        if (!item || fsPicks.includes(item.id)) return;
        let index = fsPicks.length;
        const key = categoryKey(item);
        const rank = rankOf(key);
        // 排他カテゴリは、同じカテゴリの追加済みタグと置き換える（右側の同じ位置に入れる）
        if (rank >= 0 && categories[rank].exclusive) {
            for (const x of pickedItems().filter((p) => categoryKey(p) === key)) {
                index = Math.min(index, fsPicks.indexOf(x.id));
                dropPick(x);
            }
        }
        // 同じタグの重み違い（sweat と (sweat:0.8) など）は同時に入れず、追加した方に切り替える
        const mine = new Map(splitTags(item.tags).map((t) => [normTag(t), tagKey(t)]));
        const isVariant = (t) => mine.has(normTag(t)) && mine.get(normTag(t)) !== tagKey(t);
        for (const x of pickedItems().filter((p) => splitTags(p.tags).some(isVariant))) {
            const i = fsPicks.indexOf(x.id);
            dropPick(x);
            if (i < index) index--;
        }
        fsPicks.splice(Math.min(index, fsPicks.length), 0, item.id);
        insertTags(item);
        fsRightSel = item.id;
        renderEditor();
    }

    // テキストからも消して、右側から外す
    function dropPick(item) {
        removeTags(item);
        fsPicks = fsPicks.filter((id) => id !== item.id);
        if (fsRightSel === item.id) fsRightSel = null;
    }

    function removePick(item) {
        if (!item || !fsPicks.includes(item.id)) return;
        dropPick(item);
        renderEditor();
    }

    // ---------- 描画 ----------

    function catBlocks() {
        const blocks = categories.map((c) => ({id: c.id, name: c.name, cat: c}));
        if (hasUncategorized() || categories.length === 0) blocks.push({id: "", name: "未分類", cat: null});
        return blocks;
    }

    function renderEditor() {
        renderCats();
        renderPicks();
        updateDirty();
    }

    // 左：カテゴリのアコーディオン
    function renderCats() {
        const box = fq(".ps-ed-cats");
        const top = box.scrollTop;
        box.textContent = "";
        const query = fq(".mtm-fs-search").value.trim().toLowerCase();
        const match = (x) => !query || x.tags.toLowerCase().includes(query) || (x.description || "").toLowerCase().includes(query);

        for (const b of catBlocks()) {
            const items = entries.filter((x) => categoryKey(x) === b.id);
            const shown = items.filter(match);
            if (query && shown.length === 0) continue;
            // 検索中は当てはまるカテゴリをすべて開く
            const open = !!query || fsOpenCats.has(b.id);
            const picked = items.filter((x) => fsPicks.includes(x.id)).length;
            const name = el("span", {class: "ps-ed-cat-name", text: b.name});
            if (b.cat) appendCategoryBadges(name, b.cat);
            // 未分類はカテゴリではないので、並べ替えと編集はできない
            const handle = b.cat ? makeHandle() : null;
            const head = el("div", {class: "ps-ed-cat-head" + (b.cat && b.cat.negative ? " ps-ed-neg" : ""), title: "クリックで開く / 閉じる"}, [
                ...(handle ? [handle] : []),
                el("span", {class: "ps-ed-arrow", text: "▶"}),
                name,
                el("span", {class: "ps-ed-cat-count" + (picked ? " ps-on" : ""), title: "追加済み / 登録数", text: `${picked} / ${items.length}`}),
                el("span", {class: "mtm-fs-spacer"}),
                ...(b.cat ? [el("button", {type: "button", class: "mtm-icon", title: "カテゴリを編集", text: "✎", onclick: (e) => {
                    e.stopPropagation();
                    openCategoryDialog(b.cat);
                }})] : []),
                el("button", {type: "button", class: "mtm-icon", title: "このカテゴリにタグを登録", text: "＋", onclick: (e) => {
                    e.stopPropagation();
                    openDialog(null, false, b.id);
                }}),
            ]);
            head.addEventListener("click", () => toggleCat(b.id));
            const body = el("div", {class: "ps-ed-cat-body"});
            for (const item of shown) body.appendChild(makeItem(item));
            if (shown.length === 0) body.appendChild(el("div", {class: "mtm-empty", text: "タグがありません"}));

            const block = el("div", {class: "ps-ed-cat" + (open ? " ps-open" : "")}, [head, body]);
            block.dataset.cat = b.id;
            if (b.cat) {
                makeSortable(block, handle, b.cat, "fs-category", async (from, to, after) => {
                    moveItem(categories, from, to, after);
                    renderEditor();
                    await saveData();
                });
            }
            box.appendChild(block);
        }
        if (!box.children.length) {
            box.appendChild(el("div", {class: "mtm-empty", text: query ? "一致するタグがありません。" : "まだタグが登録されていません。"}));
        }
        box.scrollTop = top;
        updateMoveButtons();
    }

    function makeItem(item) {
        const handle = makeHandle();
        const picked = fsPicks.includes(item.id);
        const row = el("div", {class: "ps-ed-item" + (picked ? " ps-picked" : "") + (fsLeftSel === item.id ? " ps-sel" : ""), title: "ダブルクリックで追加"}, [
            handle,
            el("span", {class: "ps-ed-check", text: picked ? "✓" : ""}),
            el("div", {class: "ps-ed-item-main"}, [
                el("div", {class: "ps-ed-tags", text: item.tags}),
                ...(item.description ? [el("div", {class: "ps-ed-desc", text: item.description})] : []),
            ]),
            el("div", {class: "ps-ed-item-actions"}, [
                el("button", {type: "button", class: "mtm-icon", title: "複製して登録", text: "⧉", onclick: () => openDialog(item, true)}),
                el("button", {type: "button", class: "mtm-icon", title: "編集", text: "✎", onclick: () => openDialog(item, false)}),
                el("button", {type: "button", class: "mtm-icon", title: "削除", text: "🗑", onclick: () => removeEntry(item)}),
            ]),
        ]);
        // 選ぶだけなら描き直さない（描き直すとダブルクリックが別の要素に分かれて届かなくなる）
        row.addEventListener("click", (e) => {
            if (e.target.closest("button")) return;
            fsLeftSel = item.id;
            fq(".ps-ed-cats").querySelectorAll(".ps-ed-item.ps-sel").forEach((x) => x.classList.remove("ps-sel"));
            row.classList.add("ps-sel");
            updateMoveButtons();
        });
        row.addEventListener("dblclick", (e) => {
            if (!e.target.closest("button")) addPick(item);
        });
        // カードの順序は左の表示順にだけ使う（同じカテゴリの中でのみ並べ替え可）
        makeSortable(row, handle, item, "fs-tag:" + categoryKey(item), async (from, to, after) => {
            moveItem(entries, from, to, after);
            renderEditor();
            await saveData();
        });
        return row;
    }

    // 右：追加したタグ
    function renderPicks() {
        const box = fq(".ps-ed-picks");
        const top = box.scrollTop;
        box.textContent = "";
        const items = pickedItems();
        if (!items.length) box.appendChild(el("div", {class: "mtm-empty", text: "左のタグをダブルクリックするか、選んで「追加 >>」で追加します"}));
        for (const item of items) {
            const handle = makeHandle();
            const rank = rankOf(categoryKey(item));
            const missing = !inText(item);
            const row = el("div", {
                class: "ps-ed-pick" + (isNegativeCategory(item.categoryId) ? " ps-ed-neg" : "") + (fsRightSel === item.id ? " ps-sel" : "") + (missing ? " ps-missing" : ""),
                title: "ダブルクリックで外す",
            }, [
                handle,
                el("span", {class: "ps-ed-pick-cat", text: rank >= 0 ? categories[rank].name : "未分類"}),
                el("span", {class: "ps-ed-tags", text: item.tags}),
                ...(item.description ? [el("span", {class: "ps-ed-desc", text: item.description})] : []),
                ...(missing ? [el("span", {class: "ps-ed-missing", title: "プロンプト欄で消したか書き換えたため、このタグはテキストに入っていません", text: "テキストにない"})] : []),
            ]);
            row.addEventListener("click", () => {
                fsRightSel = item.id;
                box.querySelectorAll(".ps-ed-pick.ps-sel").forEach((x) => x.classList.remove("ps-sel"));
                row.classList.add("ps-sel");
                updateMoveButtons();
                revealCat(item);
            });
            row.addEventListener("dblclick", () => removePick(item));
            makeSortable(row, handle, item.id, "ps-picks", (from, to, after) => {
                moveItem(fsPicks, from, to, after);
                reorderText();
            });
            box.appendChild(row);
        }
        box.scrollTop = top;
        updateMoveButtons();
    }

    function updateMoveButtons() {
        fq(".ps-ed-add").disabled = !entryById(fsLeftSel) || fsPicks.includes(fsLeftSel);
        fq(".ps-ed-remove").disabled = !fsPicks.includes(fsRightSel);
    }

    // 上段：このカット案の画像。あふれた分はカット案と同じように重ねる
    function renderThumbs() {
        const box = fq(".ps-ed-thumbs");
        box.textContent = "";
        if (!editor) return;
        const images = editor.images();
        if (!images.length) {
            box.appendChild(el("div", {class: "ps-ed-thumbs-empty", text: "まだ画像がありません。プレビューかキューで生成すると、ここに並びます"}));
            return;
        }
        const key = editor.keyImage();
        images.forEach((image, i) => {
            const img = el("img", {src: editor.thumbUrl(image), alt: "", loading: "lazy", draggable: "false"});
            box.appendChild(el("button", {type: "button", class: "ps-ed-thumb", title: image.name, onclick: () => editor.openImage(image)}, [
                img,
                ...(image === key ? [el("span", {class: "ps-thumb-mark", text: "キー"})] : []),
                el("span", {class: "ps-ed-thumb-no", text: String(i + 1)}),
            ]));
        });
        stackThumbs();
    }

    function stackThumbs() {
        if (!editor) return;
        const box = fq(".ps-ed-thumbs");
        stackOverflow(box, [...box.querySelectorAll(".ps-ed-thumb")], {label: (n) => `ほか ${n} 枚`});
    }

    // ---------- カードの登録・編集・削除 ----------

    async function removeEntry(item) {
        if (!confirm(`「${item.tags}」を削除しますか？`)) return;
        // 登録を消すだけで、テキストにはタグをそのまま残す
        entries = entries.filter((x) => x.id !== item.id);
        fsPicks = fsPicks.filter((id) => id !== item.id);
        fsPicksInitial = fsPicksInitial.filter((id) => id !== item.id);
        if (fsLeftSel === item.id) fsLeftSel = null;
        if (fsRightSel === item.id) fsRightSel = null;
        renderEditor();
        await saveData();
    }

    // item: 編集・複製の元（新規は null）。duplicate: true なら新規として登録
    function openDialog(item, duplicate, defaultCategory) {
        const editing = item && !duplicate && item.id ? item : null;
        fq(".mtm-tdialog .mtm-dialog-title").textContent = editing ? "タグを編集" : item && item.id ? "複製して登録" : "タグを登録";
        fq(".mtm-d-tags").value = item ? item.tags : "";
        fq(".mtm-d-desc").value = item ? item.description || "" : "";
        fillCategorySelect(fq(".mtm-d-cat"), item && item.id ? categoryKey(item) : (defaultCategory || ""));
        fq(".mtm-d-save").textContent = editing ? "更新" : item && item.id ? "複製して保存" : "保存";
        fq(".mtm-tdialog").classList.remove("mtm-hidden");
        const tags = fq(".mtm-d-tags");
        tags.focus();
        tags.setSelectionRange(tags.value.length, tags.value.length);

        fsDialogSave = async (data) => {
            if (editing) {
                // 追加済みのタグを書き換えたら、テキストの古いタグを新しいタグに差し替える
                const picked = fsPicks.includes(editing.id);
                if (picked) removeTags(editing);
                Object.assign(editing, data);
                if (picked) insertTags(editing);
            } else {
                const created = {id: newId(), ...data};
                if (item && item.id && entries.includes(item)) entries.splice(entries.indexOf(item) + 1, 0, created);
                else entries.push(created);
            }
            renderEditor();
            await saveData();
        };
    }

    function closeDialog() {
        if (!fs) return;
        fq(".mtm-tdialog").classList.add("mtm-hidden");
        fsDialogSave = null;
    }

    // ---------- カテゴリの登録・編集 ----------

    let fsEditingCategory = null;   // 編集中のカテゴリ（新規は null）

    function openCategoryDialog(cat) {
        fsEditingCategory = cat;
        fq(".mtm-cdialog .mtm-dialog-title").textContent = cat ? "カテゴリを編集" : "カテゴリを追加";
        fq(".mtm-c-name").value = cat ? cat.name : "";
        fq(".mtm-c-excl").checked = !!(cat && cat.exclusive);
        fq(".mtm-c-neg").checked = !!(cat && cat.negative);
        fq(".mtm-c-delete").classList.toggle("mtm-hidden", !cat);
        fq(".mtm-c-save").textContent = cat ? "更新" : "追加";
        fq(".mtm-cdialog").classList.remove("mtm-hidden");
        fq(".mtm-c-name").focus();
    }

    function closeCategoryDialog() {
        if (!fs) return;
        fq(".mtm-cdialog").classList.add("mtm-hidden");
        fsEditingCategory = null;
    }

    async function submitCategoryDialog() {
        const name = fq(".mtm-c-name").value.trim();
        if (!name) {
            fq(".mtm-c-name").focus();
            return;
        }
        const data = {name, exclusive: fq(".mtm-c-excl").checked, negative: fq(".mtm-c-neg").checked};
        if (fsEditingCategory) {
            Object.assign(fsEditingCategory, data);
        } else {
            const created = {id: newId(), ...data};
            categories.push(created);
            fsOpenCats.add(created.id);
        }
        closeCategoryDialog();
        renderEditor();
        await saveData();
    }

    async function deleteCategoryFromDialog() {
        const c = fsEditingCategory;
        if (!c) return;
        const count = entries.filter((x) => x.categoryId === c.id).length;
        let msg = `カテゴリ「${c.name}」を削除しますか？`;
        if (count) msg += `\n登録済みのタグ ${count} 件は「未分類」に移動します。`;
        if (!confirm(msg)) return;
        categories = categories.filter((x) => x.id !== c.id);
        for (const x of entries) {
            if (x.categoryId === c.id) x.categoryId = "";
        }
        closeCategoryDialog();
        renderEditor();
        await saveData();
    }

    async function submitDialog() {
        const tags = fq(".mtm-d-tags").value.trim();
        if (!tags) {
            fq(".mtm-d-tags").focus();
            return;
        }
        const save = fsDialogSave;
        const data = {tags, description: fq(".mtm-d-desc").value.trim(), categoryId: fq(".mtm-d-cat").value};
        closeDialog();
        if (save) await save(data);
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    let genWaiter = null;           // 生成の開始と終了を待っている {tab, started, resolve}

    // 生成ボタンを押し、その生成が終わるまで待つ
    function generateAndWait(tab) {
        return new Promise((resolve, reject) => {
            const btn = gradioApp().querySelector(`#${tab}_generate`);
            if (!btn) {
                reject(new Error("生成ボタンが見つかりません"));
                return;
            }
            const waiter = {tab, started: false, resolve};
            genWaiter = waiter;
            btn.click();
            setTimeout(() => {
                if (waiter.started) return;
                if (genWaiter === waiter) genWaiter = null;
                reject(new Error("生成が始まりませんでした"));
            }, 15000);
        });
    }

    async function postJob(url, payload) {
        const res = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload || {})});
        if (!res.ok) throw new Error(res.status + " " + (await res.text()));
    }

    // カット案やキューの内容をデフォルト UI に転記して生成し、終わるまで待つ。転記は一方通行で、WebUI の値は読まない
    async function generate(job) {
        const tab = "txt2img";
        const pos = promptArea(tab, false);
        const neg = promptArea(tab, true);
        if (!pos || !neg) throw new Error("プロンプト欄が見つかりません");
        setPrompt(pos, job.positive);
        setPrompt(neg, job.negative);
        writeWebuiValue("steps", job.steps, tab);
        writeWebuiValue("batch_count", job.batch, tab);
        writeWebuiValue("batch_size", 1, tab);
        writeField(webuiSeedInput(tab, "seed"), String(job.seed));
        writeField(webuiSeedInput(tab, "subseed"), String(job.subseed));
        writeVariationStrength(job.subseedStrength, tab);
        // カット案や元の画像のサイズが決まっているときだけ、サイズも書き込む（決まっていなければ WebUI の設定のまま）
        if (job.width && job.height) {
            writeWebuiValue("width", job.width, tab);
            writeWebuiValue("height", job.height, tab);
        }
        // 書き込んだ値を Gradio が拾ってから生成する
        await sleep(300);
        await postJob("polaris-studio/job", {project: job.project, cut: job.cut, source: job.source});
        try {
            await generateAndWait(tab);
        } finally {
            await postJob("polaris-studio/job/clear");
        }
    }

    // インペイントに送るときに、プロンプトと出力サイズを img2img に転記する
    function writeImg2img(values) {
        const tab = "img2img";
        const pos = promptArea(tab, false);
        const neg = promptArea(tab, true);
        if (!pos || !neg) throw new Error("img2img のプロンプト欄が見つかりません");
        setPrompt(pos, values.positive);
        setPrompt(neg, values.negative);
        if (values.width) writeWebuiValue("width", values.width, tab);
        if (values.height) writeWebuiValue("height", values.height, tab);
    }

    // ---------- 全画面モードの生成パラメータ（WebUI のスライダーと直結） ----------

    function webuiSlider(suffix, tab = fsTab) {
        const root = gradioApp().querySelector(`#${tab}_${suffix}`);
        return root ? {number: root.querySelector("input[type=number]"), range: root.querySelector("input[type=range]")} : null;
    }

    // シード欄（通常は数値欄。--use-textbox-seed で起動したときはテキスト欄）。name は "seed" か "subseed"（バリエーションのシード）
    function webuiSeedInput(tab = fsTab, name = "seed") {
        return gradioApp().querySelector(`#${tab}_${name} input[type=number], #${tab}_${name} textarea, #${tab}_${name} input[type=text]`);
    }

    function writeField(input, v) {
        if (!input || String(input.value) === String(v)) return;
        input.value = v;
        updateInput(input);
    }

    // バリエーションの強度を 0〜1（0.01 刻み）に丸めて WebUI に書き込み、書き込んだ値を返す
    function writeVariationStrength(v, tab) {
        const s = webuiSlider("subseed_strength", tab);
        if (!s || !s.number) return null;
        v = Math.round(Math.min(Math.max(v, 0), 1) * 100) / 100;
        writeField(s.number, v);
        if (s.range) s.range.value = v;
        // Extra がオフだと強度は生成に使われないので、0 より大きくしたらオンにする
        if (v > 0) {
            const extra = gradioApp().querySelector(`#${tab}_subseed_show input[type=checkbox]`);
            if (extra && !extra.checked) extra.click();
        }
        return v;
    }

    // WebUI のスライダーに値を書き込む（範囲外はスライダーの範囲に丸める）。書き込んだ値を返す
    function writeWebuiValue(suffix, v, tab = fsTab) {
        const s = webuiSlider(suffix, tab);
        if (!s || !s.number) return null;
        const min = Number((s.range && s.range.min) || s.number.min) || 1;
        const max = Number((s.range && s.range.max) || s.number.max) || Infinity;
        v = Math.min(Math.max(Math.round(v), min), max);
        if (String(s.number.value) !== String(v)) {
            // Gradio の Slider は数値欄の input イベントで値を受け取る
            s.number.value = v;
            updateInput(s.number);
            if (s.range) s.range.value = v;
        }
        return v;
    }

    // ---------- 生成の進捗表示（全画面モード上部のバッチ数の横） ----------
    // WebUI の requestProgress を包んで、txt2img / img2img の進捗を受け取る

    let progressHideTimer = null;
    let progressListener = null;    // 進捗の文字列を受け取る関数

    function fmtTime(secs) {
        return typeof formatTime === "function" ? formatTime(secs) : Math.floor(secs) + "s";
    }

    function showProgress(tab, res, start, done) {
        if (!fs) return;
        const line = fq(".mtm-fs-progress");
        clearTimeout(progressHideTimer);
        const p = Math.max(0, Math.min(1, res.progress || 0));
        const width = 20;
        const filled = Math.round(p * width);
        const elapsed = (Date.now() - start) / 1000;
        let parts;
        if (done) {
            // 完了と中断を区別できないので、終了時は進捗バーを出さない
            parts = [tab, "終了", "経過 " + fmtTime(elapsed)];
        } else {
            parts = [tab, "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]", (Math.floor(p * 100) + "%").padStart(4)];
            if (res.queued && !res.active) parts.push("待機中");
            if (res.eta) parts.push("ETA " + fmtTime(res.eta));
            parts.push("経過 " + fmtTime(elapsed));
            if (res.textinfo && res.textinfo.indexOf("\n") === -1) parts.push(res.textinfo);
        }
        line.textContent = parts.join("  ");
        if (progressListener) progressListener(line.textContent, {progress: p, eta: res.eta || 0, elapsed, waiting: !!(res.queued && !res.active), done: !!done});
        line.classList.remove("mtm-hidden");
        line.classList.toggle("mtm-fs-progress-done", !!done);
        if (done) progressHideTimer = setTimeout(() => line.classList.add("mtm-hidden"), 8000);
    }

    function hookProgress() {
        if (typeof window.requestProgress !== "function" || window.requestProgress.mtmHooked) return;
        const original = window.requestProgress;
        const hooked = function (id_task, container, gallery, atEnd, onProgress, inactivityTimeout) {
            const tab = container && container.id ? container.id.split("_")[0] : "";
            if (tab !== "txt2img" && tab !== "img2img") return original.apply(this, arguments);
            const start = Date.now();
            let last = {queued: true};
            // generate() が押した生成なら、終わったことを知らせる
            const waiter = genWaiter && genWaiter.tab === tab ? genWaiter : null;
            if (waiter) {
                waiter.started = true;
                genWaiter = null;
            }
            showProgress(tab, last, start, false);
            return original.call(this, id_task, container, gallery, function () {
                showProgress(tab, last, start, true);
                if (waiter) waiter.resolve();
                if (atEnd) return atEnd.apply(this, arguments);
            }, function (res) {
                last = res;
                showProgress(tab, res, start, false);
                if (onProgress) return onProgress.apply(this, arguments);
            }, inactivityTimeout);
        };
        hooked.mtmHooked = true;
        window.requestProgress = hooked;
    }

    // ---------- 起動ボタン ----------

    // 画面上部の設定の行（quicksettings）の右端に置く
    function attach() {
        const row = gradioApp().querySelector("#quicksettings");
        if (!row || row.querySelector(".ps-launch")) return;
        row.appendChild(el("button", {type: "button", class: "ps-launch", title: "プロジェクト管理を開く (Alt+P)", text: "Polaris Studio", onclick: () => window.PolarisProjects.toggle()}));
    }

    // Alt+P でポラスタとデフォルト UI を行き来する。全画面の中のキー操作は外へ伝わらないので、先に受け取る
    document.addEventListener("keydown", (e) => {
        if (e.code !== "KeyP" || !e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        window.PolarisProjects.toggle();
    }, true);

    // プロジェクト管理（polaris_projects.js）と共有する部品
    window.PolarisStudio = {
        el,
        root() {
            if (!fs) buildFullscreen();
            return fs;
        },
        // 全画面の土台を共有しているので、プロジェクト管理の画面を出す間はプロンプト編集のウィンドウを隠す
        hideEditor() {
            fq(".ps-editor").classList.add("ps-off");
        },
        openEditor,
        generate,
        writeImg2img,
        stackOverflow,
        fmtTime,
        // listener(text, {progress, eta, elapsed, waiting, done})
        onProgress(listener) {
            progressListener = listener;
        },
        // カット案が外から変わったとき（画像の削除など）に編集画面を作り直す。保存していない変更があるときはテキストと並びに触らない
        reloadEditor() {
            if (!editor) return;
            if (!fsDirty()) loadEditorState();
            renderEditor();
            renderThumbs();
        },
        isEditing(cut) {
            return !!editor && editor.cut === cut;
        },
        // ビューワーの「プロンプトを戻す」。編集中は保存せず、プロンプト欄に入れるだけにする
        setEditorPrompt(positive, negative) {
            posArea().value = positive;
            negArea().value = negative;
            renderPicks();
            updateDirty();
        },
    };

    onUiLoaded(attach);
    onUiLoaded(hookProgress);
    onUiUpdate(attach);
})();
