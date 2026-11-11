// Polaris Studio: プロジェクト管理
// プロジェクト一覧 → 個別プロジェクト（シーンを上から下へ時系列に並べ、シーン内にカット案を併記する）。
// データは data/projects.json に、生成画像はカット案ごとのフォルダに保存する。画面の土台（#mtm-fs）は polaris_studio.js のものを共有する
(function () {
    "use strict";

    const API = "polaris-studio/projects";
    const QUEUE_DEFAULT = {steps: 37, batch: 10, seed: -1, subseed: -1, subseedStrength: 0};
    const QUEUE_STATUS = {waiting: "待機中", done: "完了", error: "エラー"};
    const QUEUE_CUT_GONE = " [エラー: 元のカット案が削除されています]";
    const ZOOM_STEP = 1.25;
    const ZOOM_MIN = 0.1;
    const ZOOM_MAX = 8;

    let projects = [];
    let outputRoot = "";
    let canTrash = false;   // 削除した画像をごみ箱に移せるか（サーバーが教える）
    const projectImages = new Map();    // プロジェクト id → {カット案 id: 画像の一覧（古い順）}
    let project = null;     // 開いているプロジェクト
    let fs = null;
    let root = null;        // 一覧と個別プロジェクトの入れ物
    let overlay = null;     // プロンプト編集の上にも出す部品の入れ物
    let dragging = null;    // {kind: "scene" | "cut", scene, cut}
    let pendingDelete = null;
    let generating = false;
    let suspended = false;  // Alt+P で隠しているだけの状態か

    const el = (...args) => window.PolarisStudio.el(...args);
    const q = (sel) => fs.querySelector(sel);
    const isOpen = (sel) => !q(sel).classList.contains("ps-off");

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    // ---------- データ ----------

    async function loadProjects() {
        const res = await fetch(API, {cache: "no-store"});
        if (!res.ok) throw new Error(res.status + " " + (await res.text()));
        const data = await res.json();
        projects = Array.isArray(data.projects) ? data.projects : [];
        outputRoot = data.outputRoot || "";
        canTrash = data.trash === true;
    }

    // 保存は順番に行う。前の保存より後の内容が先に届いて、古い内容で上書きされないようにする
    let saving = Promise.resolve();
    function saveProjects() {
        const body = JSON.stringify({projects});
        saving = saving.then(async () => {
            try {
                const res = await fetch(API, {method: "POST", headers: {"Content-Type": "application/json"}, body});
                if (!res.ok) throw new Error(res.status + " " + (await res.text()));
            } catch (e) {
                console.error("[Polaris Studio] save failed", e);
                alert("プロジェクトの保存に失敗しました。\n" + e);
            }
        });
        return saving;
    }

    async function postJson(url, payload) {
        const res = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || res.status);
        return data;
    }

    async function loadImages(p) {
        const res = await fetch(`polaris-studio/images?project=${encodeURIComponent(p.id)}`, {cache: "no-store"});
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || res.status);
        projectImages.set(p.id, data.cuts);
    }

    const cutsOf = (p) => p.scenes.flatMap((s) => s.cuts);
    const queuesOf = (cut) => project.queues.filter((x) => x.cutId === cut.id);
    const imagesOf = (p, cut) => (projectImages.get(p.id) || {})[cut.id] || [];
    const pathOf = (...parts) => [outputRoot, ...parts].join("/") + "/";

    function imageUrl(p, cut, image, thumb) {
        const query = new URLSearchParams({project: p.id, cut: cut.id, name: image.name});
        if (thumb) query.set("thumb", "true");
        // 同じ名前で作り直されても古い画像が出ないよう、更新時刻を付ける
        query.set("t", image.mtime);
        return "polaris-studio/image?" + query;
    }

    // キー画像。指定がない、または指定の画像がなくなったときは一番古い画像
    function keyImageOf(p, cut) {
        const list = imagesOf(p, cut);
        return list.find((x) => x.name === cut.keyImage) || list[0] || null;
    }

    // カバー画像のカット案。手動で選んだものがなければ、一番若いシーンから自動で選ぶ
    function coverCutOf(p) {
        const cuts = cutsOf(p).filter((c) => imagesOf(p, c).length);
        return cuts.find((c) => c.id === p.coverCutId) || cuts[0] || null;
    }

    // ---------- 画面の開閉 ----------

    function build() {
        fs = window.PolarisStudio.root();
        root = el("div", {class: "ps-app"});
        root.innerHTML = `
            <div class="mtm-fs-window ps-list-view">
                <div class="mtm-fs-bar">
                    <span class="mtm-fs-title">プロジェクト</span>
                    <span class="mtm-fs-spacer"></span>
                    <button type="button" class="mtm-btn ps-close">閉じる</button>
                    <button type="button" class="mtm-btn mtm-primary ps-new-project">＋ 新規登録</button>
                </div>
                <div class="ps-grid"></div>
            </div>
            <div class="mtm-fs-window ps-project-view ps-off">
                <div class="mtm-fs-bar">
                    <button type="button" class="mtm-btn ps-back">← プロジェクト</button>
                    <input type="text" class="ps-project-title" title="プロジェクトのタイトル">
                    <span class="mtm-fs-spacer"></span>
                    <span class="mtm-fs-notice mtm-fs-notice-warn ps-off ps-project-notice"></span>
                    <button type="button" class="mtm-btn ps-open-cover">カバー画像</button>
                    <button type="button" class="mtm-btn ps-open-books">📖 Book</button>
                    <button type="button" class="mtm-btn ps-open-queues">▶ キュー管理</button>
                </div>
                <div class="ps-scenes">
                    <div class="ps-scene-list"></div>
                    <button type="button" class="mtm-btn ps-add-scene">＋ シーンを追加</button>
                </div>
                <div class="mtm-fs-drop ps-off ps-image-drop">シーンに画像をドロップすると、新しいカット案を作成します</div>
            </div>
            <div class="mtm-fs-window ps-books-view ps-off">
                <div class="mtm-fs-bar">
                    <button type="button" class="mtm-btn ps-books-back">← 戻る</button>
                    <span class="mtm-fs-title">Book</span>
                    <span class="mtm-fs-target ps-books-project"></span>
                </div>
                <div class="ps-books-body">
                    <div class="ps-books-side">
                        <div class="ps-books-list"></div>
                        <button type="button" class="mtm-btn ps-books-new">＋ 新しい Book</button>
                    </div>
                    <div class="ps-book-main">
                        <div class="ps-book-tools">
                            <input type="text" class="ps-book-title" title="Book のタイトル">
                            <span class="ps-book-count"></span>
                            <span class="mtm-fs-spacer"></span>
                            <button type="button" class="mtm-btn ps-book-newpage" title="白紙のコマページを Book の最後に足します">＋ コマページ作成</button>
                            <button type="button" class="mtm-btn mtm-primary ps-book-export" title="メタ情報を落とした PNG を、Book 内の順序をファイル名にして ZIP で保存します">ZIP で書き出し</button>
                            <button type="button" class="mtm-btn mtm-danger ps-book-delete" title="Book だけを削除します。画像は削除しません">Book を削除</button>
                        </div>
                        <div class="ps-book-hint">クリックでコマページの編集画面を開き、ドラッグで並べ替えます。コマを選んで「画像を選ぶ」から、カット案 → そのカット案の画像の順にはめ込む画像を選びます。✕ はコマページの削除で、画像は削除しません。</div>
                        <div class="ps-book-pages"></div>
                    </div>
                </div>
            </div>
            <div class="ps-backdrop ps-off ps-new-dialog">
                <div class="ps-dialog">
                    <div class="ps-dialog-head">プロジェクトの新規登録</div>
                    <label class="ps-field">タイトル<input type="text" class="ps-new-title"></label>
                    <label class="ps-field">タグ定義<select class="ps-new-tags"></select></label>
                    <div class="mtm-form-actions">
                        <button type="button" class="mtm-btn ps-new-cancel">キャンセル</button>
                        <button type="button" class="mtm-btn mtm-primary ps-new-save">登録</button>
                    </div>
                </div>
            </div>
            <div class="ps-backdrop ps-off ps-cover-dialog">
                <div class="ps-dialog">
                    <div class="ps-dialog-head">カバー画像を選択 <span class="ps-dialog-id ps-cover-state"></span></div>
                    <div class="ps-thumbs ps-cover-thumbs"></div>
                    <div class="mtm-form-actions">
                        <span class="mtm-hint">未選択のときは、一番若いシーンのキー画像を使います</span>
                        <button type="button" class="mtm-btn ps-cover-auto">自動に戻す</button>
                        <button type="button" class="mtm-btn mtm-primary ps-cover-close">閉じる</button>
                    </div>
                </div>
            </div>
            <div class="ps-backdrop ps-off ps-key-dialog">
                <div class="ps-dialog">
                    <div class="ps-dialog-head">キー画像を選択 <span class="ps-dialog-id ps-key-id"></span></div>
                    <div class="ps-thumbs ps-key-thumbs"></div>
                    <div class="mtm-form-actions">
                        <span class="mtm-hint">未指定のときは最初の画像がキー画像になります</span>
                        <button type="button" class="mtm-btn ps-key-reset">最初の画像に戻す</button>
                        <button type="button" class="mtm-btn mtm-primary ps-key-close">閉じる</button>
                    </div>
                </div>
            </div>
        `;
        fs.appendChild(root);

        overlay = el("div", {class: "ps-overlay"});
        overlay.innerHTML = `
            <div class="ps-gallery-view ps-off">
                <div class="mtm-fs-bar">
                    <button type="button" class="mtm-btn ps-gallery-back"></button>
                    <span class="mtm-fs-title ps-gallery-title"></span>
                    <span class="mtm-fs-target ps-gallery-count"></span>
                </div>
                <div class="ps-gallery-tools">
                    <input type="search" class="ps-gallery-search" placeholder="プロンプト、Seed、Sampler などで検索">
                    <select class="ps-gallery-source">
                        <option value="">すべての生成元</option>
                        <option value="preview">プレビュー</option>
                        <option value="queue">キュー</option>
                        <option value="i2i">i2i</option>
                    </select>
                    <label class="ps-fav-only" title="お気に入り（♥）にした画像だけを出します"><input type="checkbox" class="ps-gallery-fav"> ♥ お気に入りのみ</label>
                    <label><input type="checkbox" class="ps-gallery-all"> すべて選択</label>
                    <span class="mtm-fs-spacer"></span>
                    <span class="ps-gallery-selinfo" title="選択はカット案をまたいで残ります"></span>
                    <button type="button" class="mtm-btn ps-gallery-clear">選択を解除</button>
                    <button type="button" class="mtm-btn ps-gallery-regen" title="選んだ画像を、元のプロンプトと Seed のまま Steps だけ変えて作り直すキューを登録します">再生成</button>
                    <button type="button" class="mtm-btn mtm-danger ps-gallery-delete">選択を削除</button>
                </div>
                <div class="ps-gallery"><div class="ps-thumbs ps-gallery-thumbs"></div></div>
            </div>
            <div class="ps-queue-panel ps-off">
                <div class="ps-qp-head">
                    <span class="ps-qp-title">キュー登録</span>
                    <span class="ps-qp-cut ps-queue-cut"></span>
                    <button type="button" class="mtm-icon ps-queue-back" title="閉じる (Esc)">✕</button>
                </div>
                <div class="ps-qp-fields">
                    <label class="ps-qp-name">名前<input type="text" class="ps-queue-name" title="空欄なら自動で付けます"></label>
                    <label>Steps<input type="number" data-queue="steps" min="1" step="1"></label>
                    <label>Batch<input type="number" data-queue="batch" min="1" step="1"></label>
                    <label>Seed<input type="number" data-queue="seed" step="1"></label>
                    <label>Var Seed<input type="number" data-queue="subseed" step="1"></label>
                    <label>Var<input type="number" data-queue="subseedStrength" min="0" max="1" step="0.01"></label>
                </div>
                <div class="ps-qp-foot">
                    <span class="ps-queue-head"></span>
                    <button type="button" class="mtm-btn mtm-primary ps-queue-save">登録</button>
                </div>
            </div>
            <div class="ps-regen-panel ps-off">
                <div class="ps-qp-head">
                    <span class="ps-qp-title">再生成をキューに登録</span>
                    <span class="ps-qp-cut ps-regen-info"></span>
                    <button type="button" class="mtm-icon ps-regen-back" title="閉じる (Esc)">✕</button>
                </div>
                <div class="ps-qp-fields">
                    <label class="ps-qp-name">名前<input type="text" class="ps-regen-name" title="空欄なら自動で付けます"></label>
                    <label>Steps<input type="number" class="ps-regen-steps" min="1" step="1"></label>
                </div>
                <div class="ps-regen-note">プロンプト・Seed・Var Seed・サイズは元の画像のまま、1 枚ずつ作り直して元のカット案に入れます。</div>
                <div class="ps-qp-foot">
                    <span class="ps-queue-head ps-regen-head"></span>
                    <button type="button" class="mtm-btn mtm-primary ps-regen-save">登録</button>
                </div>
            </div>
            <div class="ps-queues-view ps-off">
                <div class="ps-qp-head">
                    <span class="ps-qp-title">キュー管理</span>
                    <span class="ps-qm-count ps-queues-count"></span>
                    <span class="ps-queues-progress"></span>
                    <button type="button" class="mtm-icon ps-queues-back" title="閉じる (Esc)">✕</button>
                </div>
                <div class="ps-qm-toolbar">
                    <label><input type="checkbox" class="ps-queues-all"> すべて選択</label>
                    <span class="mtm-fs-spacer"></span>
                    <button type="button" class="mtm-btn mtm-danger ps-queues-stop ps-off" title="残りのキューを取りやめ、実行中の生成も中断します">中止</button>
                    <button type="button" class="mtm-btn mtm-danger ps-queues-delete">選択を削除</button>
                    <button type="button" class="mtm-btn mtm-primary ps-queues-run">選択を実行</button>
                </div>
                <div class="ps-qm-list"></div>
            </div>
            <div class="ps-viewer ps-off">
                <div class="ps-viewer-bar">
                    <span class="ps-viewer-name"></span>
                    <span class="ps-viewer-marks"></span>
                    <span class="mtm-fs-spacer"></span>
                    <button type="button" class="mtm-btn ps-zoom-out" title="縮小">－</button>
                    <span class="ps-viewer-size"></span>
                    <button type="button" class="mtm-btn ps-zoom-in" title="拡大">＋</button>
                    <button type="button" class="mtm-btn ps-zoom-fit">フィット</button>
                    <button type="button" class="mtm-btn ps-zoom-full">原寸</button>
                    <button type="button" class="mtm-btn ps-view-fav" title="お気に入りにする・外す (F)">♡ お気に入り</button>
                    <button type="button" class="mtm-btn ps-view-key">キー画像に指定</button>
                    <button type="button" class="mtm-btn ps-view-restore" title="この画像の生成情報のプロンプトをカット案に戻す">プロンプトを戻す</button>
                    <button type="button" class="mtm-btn ps-view-i2i" title="WebUI のインペイントに送る。生成した画像はこのカット案に保存される">インペイントに送る</button>
                    <button type="button" class="mtm-btn mtm-danger ps-view-delete">削除</button>
                    <button type="button" class="mtm-btn ps-view-info">情報</button>
                    <button type="button" class="mtm-btn ps-viewer-close">閉じる</button>
                </div>
                <div class="ps-viewer-main">
                    <div class="ps-viewer-center">
                        <button type="button" class="ps-nav ps-nav-prev" title="前の画像 (←)">‹</button>
                        <div class="ps-viewer-stage"><img class="ps-viewer-image" alt=""></div>
                        <button type="button" class="ps-nav ps-nav-next" title="次の画像 (→)">›</button>
                    </div>
                    <div class="ps-viewer-info ps-off"></div>
                </div>
            </div>
            <div class="ps-backdrop ps-off ps-delete-dialog">
                <div class="ps-dialog">
                    <div class="ps-dialog-head ps-delete-title"></div>
                    <div class="ps-confirm-text ps-delete-text"></div>
                    <div class="ps-path ps-delete-path"></div>
                    <label class="ps-delete-confirm ps-off">
                        <span class="ps-delete-confirm-text"></span>
                        <input type="text" class="ps-delete-word" autocomplete="off" spellcheck="false" autocapitalize="off">
                    </label>
                    <div class="mtm-form-actions">
                        <button type="button" class="mtm-btn ps-delete-cancel">キャンセル</button>
                        <button type="button" class="mtm-btn mtm-danger ps-delete-ok">削除</button>
                    </div>
                </div>
            </div>
        `;
        fs.appendChild(overlay);

        q(".ps-close").addEventListener("click", close);
        q(".ps-back").addEventListener("click", showList);
        q(".ps-new-project").addEventListener("click", openNewDialog);
        q(".ps-new-cancel").addEventListener("click", closeNewDialog);
        q(".ps-new-save").addEventListener("click", createProject);
        q(".ps-new-title").addEventListener("keydown", (e) => {
            if (e.key === "Enter") createProject();
        });
        q(".ps-project-title").addEventListener("change", renameProject);
        q(".ps-add-scene").addEventListener("click", addScene);
        q(".ps-open-cover").addEventListener("click", openCoverDialog);
        q(".ps-cover-close").addEventListener("click", () => hide(".ps-cover-dialog"));
        q(".ps-cover-auto").addEventListener("click", () => setCover(""));
        q(".ps-key-close").addEventListener("click", () => hide(".ps-key-dialog"));
        q(".ps-key-reset").addEventListener("click", () => setKeyImage(keyCut, ""));
        q(".ps-delete-cancel").addEventListener("click", closeDeleteDialog);
        q(".ps-delete-ok").addEventListener("click", runDelete);
        q(".ps-delete-word").addEventListener("input", updateDeleteOk);
        q(".ps-delete-word").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) runDelete();
        });
        q(".ps-queue-back").addEventListener("click", closeQueueForm);
        q(".ps-queue-save").addEventListener("click", registerQueue);
        q(".ps-queue-panel").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing && e.target.tagName === "INPUT") {
                e.preventDefault();
                registerQueue();
            }
        });
        q(".ps-open-queues").addEventListener("click", (e) => toggleQueueManager(e.currentTarget));
        q(".ps-queues-back").addEventListener("click", closeQueueManager);
        q(".ps-queues-run").addEventListener("click", () => runQueues(project.queues.filter((x) => queueChecked.has(x.id))));
        q(".ps-queues-delete").addEventListener("click", deleteCheckedQueues);
        q(".ps-queues-stop").addEventListener("click", stopQueues);
        q(".ps-queues-all").addEventListener("change", (e) => {
            queueChecked = new Set(e.target.checked ? project.queues.map((x) => x.id) : []);
            renderQueueManager();
        });
        q(".ps-gallery-back").addEventListener("click", closeGallery);
        q(".ps-gallery-search").addEventListener("input", renderGallery);
        q(".ps-gallery-source").addEventListener("change", renderGallery);
        q(".ps-gallery-fav").addEventListener("change", renderGallery);
        // 「すべて選択」は今開いているカット案の中だけ。ほかのカット案の選択は残す
        q(".ps-gallery-all").addEventListener("change", (e) => {
            for (const k of selectedOf(galleryCut)) selectedImages.delete(selKey(galleryCut, k));
            if (e.target.checked) visibleImages().forEach((x) => selectedImages.add(selKey(galleryCut, x.name)));
            renderGallery();
        });
        q(".ps-gallery-clear").addEventListener("click", () => {
            selectedImages.clear();
            renderGallery();
        });
        q(".ps-gallery-regen").addEventListener("click", (e) => openRegenForm(e.currentTarget));
        q(".ps-open-books").addEventListener("click", () => openBooks());
        q(".ps-books-back").addEventListener("click", closeBooks);
        q(".ps-books-new").addEventListener("click", createBook);
        q(".ps-book-title").addEventListener("change", renameBook);
        q(".ps-book-title").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) e.target.blur();
        });
        q(".ps-book-export").addEventListener("click", exportBook);
        q(".ps-book-newpage").addEventListener("click", createPage);
        q(".ps-book-delete").addEventListener("click", deleteBook);
        q(".ps-regen-back").addEventListener("click", closeRegenForm);
        q(".ps-regen-save").addEventListener("click", registerRegen);
        q(".ps-regen-panel").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing && e.target.tagName === "INPUT") registerRegen();
        });
        q(".ps-gallery-delete").addEventListener("click", askDeleteSelected);
        setupDragSelect();
        // 伸びる動きは開いたときの1回だけ。残しておくと、画面を作り直して置き直すたびにまた伸びる
        q(".ps-gallery-view").addEventListener("animationend", (e) => e.currentTarget.classList.remove("ps-grow"));
        q(".ps-zoom-in").addEventListener("click", () => setZoom(zoom * ZOOM_STEP));
        q(".ps-zoom-out").addEventListener("click", () => setZoom(zoom / ZOOM_STEP));
        q(".ps-zoom-full").addEventListener("click", () => setZoom(1));
        q(".ps-zoom-fit").addEventListener("click", () => {
            fitting = true;
            applyZoom();
        });
        q(".ps-nav-prev").addEventListener("click", () => moveImage(-1));
        q(".ps-nav-next").addEventListener("click", () => moveImage(1));
        q(".ps-viewer-close").addEventListener("click", () => hide(".ps-viewer"));
        q(".ps-view-fav").addEventListener("click", toggleViewFavorite);
        q(".ps-view-key").addEventListener("click", () => setKeyImage(viewCut, viewImage.name));
        q(".ps-view-restore").addEventListener("click", restorePromptFromImage);
        q(".ps-view-i2i").addEventListener("click", sendToImg2img);
        q(".ps-view-delete").addEventListener("click", () => askDeleteImages([selKey(viewCut, viewImage.name)], "画像を削除"));
        q(".ps-view-info").addEventListener("click", () => {
            setViewerInfo(q(".ps-viewer-info").classList.contains("ps-off"));
            try {
                localStorage.setItem(VIEWER_INFO_KEY, isOpen(".ps-viewer-info") ? "1" : "");
            } catch (e) { /* 覚えられなくても表示は切り替わる */ }
        });
        // 画像の上（画像の周りの余白も含む）をダブルクリックすると閉じる。前後のボタンや情報欄では閉じない。
        // サムネイルをダブルクリックしたときは、1回目で開いた直後の 2 回目なので閉じない
        q(".ps-viewer-stage").addEventListener("dblclick", (e) => {
            e.preventDefault();
            if (Date.now() - viewerOpenedAt < VIEWER_DBLCLICK_GUARD) return;
            window.getSelection().removeAllRanges();
            hide(".ps-viewer");
        });
        q(".ps-viewer-image").addEventListener("load", applyZoom);
        q(".ps-viewer-stage").addEventListener("wheel", wheelViewer, {passive: false});
        window.addEventListener("resize", () => {
            if (isOpen(".ps-viewer")) applyZoom();
        });
        // 画像のドロップで、そのシーンに新しいカット案を作る
        const view = q(".ps-project-view");
        view.addEventListener("dragover", dragOverProject);
        view.addEventListener("drop", dropOnProject);
        buildCutBar();
        buildToast();
        q(".ps-scenes").addEventListener("scroll", () => {
            hideCutBar();
            placeQueuePanel();
            placeRegenPanel();
        }, {passive: true});
        window.addEventListener("resize", () => {
            placeQueuePanel();
            placeQueueManager();
            placeRegenPanel();
        });
        // キュー登録とキュー管理のパネルは、パネルの外を押すと閉じる。
        // 別のカット案の「キュー」や「キュー管理」のボタン自体は、それぞれの動作（移る・開け閉め）に任せる。トーストの操作では閉じない
        fs.addEventListener("mousedown", (e) => {
            const t = e.target;
            if (t.closest(".ps-toast")) return;
            if (isOpen(".ps-queue-panel") && !q(".ps-queue-panel").contains(t) && !t.closest(".ps-cut-bar-queue, .mtm-fs-queue")) closeQueueForm();
            if (isOpen(".ps-queues-view") && !q(".ps-queues-view").contains(t) && !t.closest(".ps-open-queues, .mtm-fs-queues")) closeQueueManager();
            if (isOpen(".ps-regen-panel") && !q(".ps-regen-panel").contains(t) && !t.closest(".ps-gallery-regen")) closeRegenForm();
        }, true);
        fs.addEventListener("keydown", onKeydown, true);
    }

    function hide(sel) {
        q(sel).classList.add("ps-off");
        fs.focus();
    }

    function onKeydown(e) {
        // コマページの編集画面を開いている間は、キー操作をすべて編集画面に任せる
        if (window.PolarisPages && window.PolarisPages.isOpen()) {
            window.PolarisPages.keydown(e);
            return;
        }
        const viewer = isOpen(".ps-viewer");
        if (viewer && !isOpen(".ps-delete-dialog") && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            e.stopPropagation();
            moveImage(e.key === "ArrowLeft" ? -1 : 1);
            return;
        }
        if (viewer && !isOpen(".ps-delete-dialog") && (e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey
            && !e.target.closest("input, textarea, select")) {
            e.preventDefault();
            e.stopPropagation();
            toggleViewFavorite();
            return;
        }
        if (e.key !== "Escape") return;
        // Esc は手前の部品から順に閉じる。プロンプト編集が開いていて部品がなければ編集側に任せる
        // 全画面の窓で開いた一覧は手前の部品として、インラインの一覧はダイアログなどの後に閉じる
        const windowGallery = isOpen(".ps-gallery-view") && q(".ps-gallery-view").classList.contains("mtm-fs-window");
        const front = [".ps-delete-dialog", ".ps-viewer", ...(windowGallery ? [".ps-gallery-view"] : []), ".ps-queues-view", ".ps-new-dialog", ".ps-cover-dialog", ".ps-key-dialog", ".ps-queue-panel", ".ps-regen-panel"].find(isOpen);
        if (!front && root.classList.contains("ps-off")) return;
        e.preventDefault();
        e.stopPropagation();
        if (front === ".ps-delete-dialog") closeDeleteDialog();
        else if (front === ".ps-gallery-view") closeGallery();
        else if (front === ".ps-queue-panel") closeQueueForm();
        else if (front === ".ps-regen-panel") closeRegenForm();
        else if (front === ".ps-queues-view") closeQueueManager();
        else if (front) hide(front);
        else if (isOpen(".ps-books-view")) closeBooks();
        else if (isOpen(".ps-gallery-view")) closeGallery();
        else if (isOpen(".ps-project-view")) showList();
        else close();
    }

    async function open() {
        if (!root) build();
        try {
            await loadProjects();
            await Promise.all(projects.map(loadImages));
        } catch (e) {
            console.error("[Polaris Studio] load failed", e);
            alert("プロジェクトの読み込みに失敗しました。\n" + e);
            return;
        }
        window.PolarisStudio.hideEditor();
        root.classList.remove("ps-off");
        fs.classList.remove("mtm-hidden");
        document.body.classList.add("mtm-fs-open");
        showList();
        fs.focus();
    }

    function setVisible(visible) {
        fs.classList.toggle("mtm-hidden", !visible);
        document.body.classList.toggle("mtm-fs-open", visible);
    }

    function close() {
        suspended = false;
        setVisible(false);
    }

    // 隠している間も画面の状態はそのまま残る。閉じていたら開き直し、隠していたら表示だけ戻す
    function toggle() {
        if (fs && !fs.classList.contains("mtm-hidden")) {
            suspended = true;
            setVisible(false);
        } else if (suspended) {
            resume();
        } else {
            open();
        }
    }

    async function resume() {
        suspended = false;
        setVisible(true);
        fs.focus();
        if (!project) return;
        // 隠している間に i2i で画像が増えているかもしれないので読み直す
        try {
            await loadImages(project);
        } catch (e) {
            console.error("[Polaris Studio] reload images failed", e);
            return;
        }
        if (isOpen(".ps-gallery-view")) renderGallery();
        refreshViews();
    }

    function showList() {
        window.PolarisPages.close();
        closeQueueForm();
        closeQueueManager();
        closeRegenForm();
        q(".ps-gallery-view").classList.add("ps-off");
        galleryCut = null;
        project = null;
        selectedImages.clear();
        q(".ps-project-view").classList.add("ps-off");
        q(".ps-books-view").classList.add("ps-off");
        q(".ps-list-view").classList.remove("ps-off");
        renderList();
    }

    function showProject(p) {
        project = p;
        // Book のない古いデータにも Book を持たせる。Book に持つのはコマページだけで、
        // 以前の「Book に追加」で登録した画像（{cutId, name}）や古い images は外す
        if (!Array.isArray(p.books)) p.books = [];
        for (const b of p.books) {
            b.items = Array.isArray(b.items) ? b.items.filter(isPage) : [];
            delete b.images;
        }
        q(".ps-project-title").value = p.title;
        q(".ps-list-view").classList.add("ps-off");
        q(".ps-project-view").classList.remove("ps-off");
        loadFoldedScenes();
        renderScenes();
    }

    let noticeTimer = null;
    function showNotice(text) {
        const n = q(".ps-project-notice");
        n.textContent = text;
        n.classList.remove("ps-off");
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => n.classList.add("ps-off"), 4000);
    }

    // ---------- プロジェクト一覧 ----------

    function makeCover(p) {
        const cut = coverCutOf(p);
        if (!cut) return el("div", {class: "ps-cover ps-no-cover", text: "カバー画像なし"});
        return el("div", {class: "ps-cover"}, [el("img", {src: imageUrl(p, cut, keyImageOf(p, cut), true), alt: "", loading: "lazy"})]);
    }

    function renderList() {
        const grid = q(".ps-grid");
        grid.textContent = "";
        if (!projects.length) {
            grid.appendChild(el("div", {class: "mtm-empty", text: "プロジェクトはまだありません。「＋ 新規登録」から作成してください。"}));
            return;
        }
        for (const p of projects) {
            grid.appendChild(el("button", {type: "button", class: "ps-tile", onclick: () => showProject(p)}, [
                makeCover(p),
                el("div", {class: "ps-tile-foot"}, [
                    el("div", {class: "ps-tile-title", title: p.title, text: p.title}),
                    // プロジェクトの削除はこの一覧からだけできる（作業中にうっかり押さないよう、個別の画面には置かない）
                    el("span", {class: "ps-tile-delete", role: "button", title: "プロジェクトを削除", text: "削除", onclick: (e) => {
                        e.stopPropagation();
                        askDeleteProject(p);
                    }}),
                ]),
            ]));
        }
    }

    function openNewDialog() {
        q(".ps-new-title").value = "";
        const select = q(".ps-new-tags");
        select.textContent = "";
        select.appendChild(el("option", {value: "", text: "空から始める"}));
        for (const p of projects) select.appendChild(el("option", {value: p.id, text: p.title + " からコピー"}));
        q(".ps-new-dialog").classList.remove("ps-off");
        q(".ps-new-title").focus();
    }

    function closeNewDialog() {
        hide(".ps-new-dialog");
    }

    async function createProject() {
        const title = q(".ps-new-title").value.trim();
        if (!title) {
            q(".ps-new-title").focus();
            return;
        }
        const source = projects.find((p) => p.id === q(".ps-new-tags").value);
        projects.unshift({
            id: newId(),
            title,
            coverCutId: "",
            categories: source ? JSON.parse(JSON.stringify(source.categories)) : [],
            entries: source ? JSON.parse(JSON.stringify(source.entries)) : [],
            scenes: [{id: newId(), name: "シーン1", cuts: []}],
            queues: [],
            createdAt: new Date().toISOString(),
        });
        closeNewDialog();
        renderList();
        await saveProjects();
    }

    // ---------- カバー画像 ----------

    function openCoverDialog() {
        renderCoverDialog();
        q(".ps-cover-dialog").classList.remove("ps-off");
    }

    function renderCoverDialog() {
        const cuts = cutsOf(project).filter((c) => imagesOf(project, c).length);
        const selected = coverCutOf(project);
        q(".ps-cover-state").textContent = cuts.some((c) => c.id === project.coverCutId) ? "手動で選択中" : "自動";
        const list = q(".ps-cover-thumbs");
        list.textContent = "";
        if (!cuts.length) list.appendChild(el("div", {class: "mtm-empty", text: "キー画像がまだありません"}));
        for (const c of cuts) {
            list.appendChild(makeThumb(project, c, keyImageOf(project, c), {
                on: c === selected,
                mark: c === selected ? "カバー" : "",
                label: c.title,
                onclick: () => setCover(c.id),
            }));
        }
    }

    async function setCover(cutId) {
        project.coverCutId = cutId;
        renderCoverDialog();
        await saveProjects();
    }

    // ---------- 個別プロジェクト ----------

    async function renameProject() {
        const input = q(".ps-project-title");
        const title = input.value.trim();
        if (!title) {
            input.value = project.title;
            return;
        }
        input.value = title;
        project.title = title;
        await saveProjects();
    }

    function renderScenes() {
        const list = q(".ps-scene-list");
        const gallery = q(".ps-gallery");
        const top = gallery.scrollTop;
        // インラインの一覧はシーンの中にあるので、作り直しで消えないよう元の入れ物に戻しておく
        const view = q(".ps-gallery-view");
        if (view.parentElement !== overlay) overlay.prepend(view);
        // カードを作り直すので、出ているコマンドバーは消す
        hideCutBar();
        cutsObserver.disconnect();
        list.textContent = "";
        project.scenes.forEach((scene) => list.appendChild(makeScene(scene)));
        placeGallery();
        // 作り直した直後に並べておく（監視の通知を待つと、並べる前の状態が一瞬見える）
        list.querySelectorAll(".ps-cuts").forEach((cuts) => {
            cuts.dataset.layoutWidth = Math.round(cuts.getBoundingClientRect().width);
            layoutCuts(cuts);
        });
        gallery.scrollTop = top;
        // キュー登録のパネルは、作り直したカードに付け直す（カット案が消えていたら閉じる）
        if (queueCut) {
            if (!sceneOf(queueCut)) closeQueueForm();
            else {
                renderQueueRows();
                placeQueuePanel();
            }
        }
    }

    // ---------- 収まらないカット案の山 ----------
    // 横に並べきれないカット案は、右側の画面幅の 1/4 ほどの場所にトランプのように重ねる。
    // 山の上でマウスを左右に動かすと、その位置のカードが前に出る

    const cutsObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            const cuts = entry.target;
            const width = Math.round(entry.contentRect.width);
            // 高さだけの変化（山を作ったことによるもの）では並べ直さない
            if (String(width) === cuts.dataset.layoutWidth) continue;
            cuts.dataset.layoutWidth = width;
            // 監視の通知の中で大きさを変えると通知が溢れる（ResizeObserver loop）ので、次の描画の前に並べる
            requestAnimationFrame(() => layoutCuts(cuts));
        }
    });

    function layoutCuts(cuts) {
        const add = cuts.querySelector(".ps-add-cut");
        window.PolarisStudio.stackOverflow(cuts, [...cuts.querySelectorAll(".ps-cut")], {before: add, label: (n) => `ほか ${n} 件`, hold: nearCutBar});
        // 並べ直すとカードの位置が変わるので、一覧の三角を向け直す
        if (galleryCut) markOpenCut();
    }

    function makeScene(scene) {
        const grip = el("span", {class: "ps-grip", draggable: "true", title: "ドラッグでシーンを並べ替え", text: "⠿"});
        grip.addEventListener("dragstart", (e) => startDrag(e, {kind: "scene", scene}, row));
        const name = el("input", {type: "text", class: "ps-scene-input", title: "シーンの名前"});
        name.value = scene.name;
        name.addEventListener("change", async () => {
            scene.name = name.value.trim();
            name.value = scene.name;
            await saveProjects();
        });
        const remove = el("button", {
            type: "button", class: "mtm-icon", text: "🗑",
            title: scene.cuts.length ? "カット案があるシーンは削除できません" : "シーンを削除",
            onclick: () => deleteScene(scene),
        });
        remove.disabled = scene.cuts.length > 0;
        const folded = foldedScenes.has(scene.id);
        const fold = el("button", {
            type: "button", class: "mtm-icon ps-scene-fold", text: folded ? "▶" : "▼",
            title: folded ? "シーンを開く" : "シーンを折りたたむ",
            onclick: () => toggleScene(scene),
        });

        // 折りたたんだシーンは、カット案の数だけを1行で出す。カット案をドラッグして落とすと末尾に入る
        const cuts = folded
            ? el("div", {class: "ps-scene-folded", title: "クリックでシーンを開く", onclick: () => toggleScene(scene)}, [
                el("span", {class: "ps-scene-folded-count", text: `カット案 ${scene.cuts.length} 件`}),
                el("span", {class: "ps-scene-folded-hint", text: "折りたたみ中"}),
            ])
            : el("div", {class: "ps-cuts"}, [
                ...scene.cuts.map((cut) => makeCut(scene, cut)),
                el("button", {type: "button", class: "ps-add-cut", text: "＋ カット案", onclick: () => addCut(scene)}),
            ]);
        // カードの並びの下に、開いたサムネイル一覧が入る
        const row = el("div", {class: "ps-scene" + (folded ? " ps-scene-is-folded" : "")}, [
            el("div", {class: "ps-rail"}, [el("div", {class: "ps-scene-name"}, [fold, grip, name, remove])]),
            el("div", {class: "ps-scene-body"}, [cuts]),
        ]);
        row.dataset.scene = scene.id;
        // シーンのドラッグは行全体、カット案のドラッグはカードの並びで受ける
        row.addEventListener("dragover", (e) => dragOverScene(e, row, scene));
        row.addEventListener("drop", (e) => dropOnScene(e, scene));
        cuts.addEventListener("dragover", (e) => dragOverCuts(e, cuts));
        cuts.addEventListener("drop", (e) => dropOnCuts(e, scene));
        if (!folded) cutsObserver.observe(cuts);
        return row;
    }

    // ---------- シーンの折りたたみ（プロジェクトごとにブラウザに覚えておく） ----------

    let foldedScenes = new Set();
    const foldedKey = () => "polaris-studio:folded-scenes:" + project.id;

    function loadFoldedScenes() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(foldedKey()));
        } catch (e) {
            saved = null;
        }
        foldedScenes = new Set(Array.isArray(saved) ? saved : []);
    }

    function toggleScene(scene) {
        if (foldedScenes.has(scene.id)) {
            foldedScenes.delete(scene.id);
        } else {
            foldedScenes.add(scene.id);
            // 折りたたむシーンのサムネイル一覧が開いていたら閉じる
            if (galleryCut && scene.cuts.includes(galleryCut) && isOpen(".ps-gallery-view")) {
                q(".ps-gallery-view").classList.add("ps-off");
                galleryCut = null;
            }
        }
        try {
            localStorage.setItem(foldedKey(), JSON.stringify([...foldedScenes]));
        } catch (e) {
            // 覚えておけなくても、折りたたみそのものはできる
        }
        renderScenes();
    }

    // キー画像の部分は、クリックでサムネイル一覧、ドラッグでカット案の並べ替えに使う
    function makeKeyArea(cut) {
        const image = keyImageOf(project, cut);
        const title = "クリックでサムネイル一覧、ドラッグで並べ替え（シーンをまたいで移動できます）";
        if (!image) return el("div", {class: "ps-key ps-none", draggable: "true", title, text: "未生成"});
        const list = imagesOf(project, cut);
        return el("div", {class: "ps-key", draggable: "true", title}, [
            // 画像そのものをドラッグすると、ブラウザが画像ファイルとして運び、画像のドロップ（カット案の作成）と区別できない
            el("img", {src: imageUrl(project, cut, image, true), alt: "", loading: "lazy", draggable: "false"}),
            el("button", {type: "button", class: "ps-key-pick", title: "キー画像を変更", text: "🖼", onclick: () => openKeyDialog(cut)}),
            el("span", {class: "ps-count", text: `${list.indexOf(image) + 1} / ${list.length}`}),
            makeSelBadge(cut),
        ]);
    }

    // サムネイル一覧で選んだ画像の枚数。一覧を閉じても、別のカット案を開いても、選択はカードに残して見せる
    function makeSelBadge(cut) {
        const n = selectedOf(cut).length;
        return el("span", {class: "ps-cut-sel" + (n ? "" : " ps-off"), title: "サムネイル一覧で選択中の画像", text: `✓ ${n}`});
    }

    function updateSelBadges() {
        if (!project) return;
        for (const cut of cutsOf(project)) {
            const badge = root.querySelector(`.ps-cut[data-cut="${cut.id}"] .ps-cut-sel`);
            if (badge) badge.replaceWith(makeSelBadge(cut));
        }
    }

    function makeCut(scene, cut) {
        const key = makeKeyArea(cut);
        const card = el("div", {class: "ps-cut"}, [
            key,
            el("div", {class: "ps-cut-title-row"}, [
                el("span", {class: "ps-cut-title", title: cut.title, text: cut.title}),
            ]),
        ]);
        // カードの大部分はサムネイル一覧への入口。ボタンとつまみはそれぞれの動作だけを行う
        card.addEventListener("click", (e) => {
            hideCutBar();
            if (!e.target.closest("button, .ps-grip")) toggleGallery(cut);
        });
        card.dataset.cut = cut.id;
        // キー画像の上でマウスを止めると、カット案のコマンドを浮かせて出す
        key.psCutBarTarget = {scene, cut, key};
        key.addEventListener("mousemove", (e) => hoverCutKey(e, scene, cut, key));
        key.addEventListener("mouseleave", leaveCutBar);
        key.addEventListener("dragstart", (e) => {
            hideCutBar();
            const r = card.getBoundingClientRect();
            startDrag(e, {kind: "cut", scene, cut}, card, e.clientX - r.left, e.clientY - r.top);
        });
        card.addEventListener("dragover", (e) => dragOverCut(e, card, cut));
        card.addEventListener("drop", (e) => dropOnCut(e, scene, cut));
        return card;
    }

    // ---------- カット案のフローティングコマンドバー ----------
    // キー画像の上でマウスを 0.2 秒ほど止めると、マウスの少し上（入らなければ少し下）に出す。
    // マウスの真下には出さないので、そのままクリックしてサムネイル一覧を開く操作を妨げない

    const CUT_BAR_DELAY = 200;
    const CUT_BAR_HOLD = 0.15;  // バーの上下に、バーの高さのこの割合だけ広げた帯では重なったカードを切り替えない
    const CUT_BAR_GAP = 14;     // マウスとバーの間を空ける幅
    let cutBar = null;
    let cutBarFor = null;       // バーを出しているカット案 {scene, cut, key}
    let cutBarTimer = null;
    let cutBarHideTimer = null;
    let cutBarCheckTimer = null;

    function buildCutBar() {
        cutBar = el("div", {class: "ps-cut-bar ps-off"});
        // バーに入ったら、消す予定も、別のカードへの出し直しもやめる
        cutBar.addEventListener("mouseenter", () => {
            clearTimeout(cutBarHideTimer);
            clearTimeout(cutBarTimer);
        });
        cutBar.addEventListener("mouseleave", leaveCutBar);
        q(".ps-project-view").appendChild(cutBar);
    }

    // バーが出ていて、マウスがバーの高さの帯（上下にバーの高さの 15% ずつ広げた範囲）にあるか。
    // この帯では、重なったカードの切り替えも、別のカードへのバーの出し直しもしない
    function nearCutBar(e) {
        if (!cutBar || cutBar.classList.contains("ps-off")) return false;
        const r = cutBar.getBoundingClientRect();
        const margin = r.height * CUT_BAR_HOLD;
        return e.clientY >= r.top - margin && e.clientY <= r.bottom + margin;
    }

    function hoverCutKey(e, scene, cut, key) {
        if (dragging) return;
        clearTimeout(cutBarHideTimer);
        clearTimeout(cutBarTimer);
        const near = nearCutBar(e);
        const x = e.clientX;
        const y = e.clientY;
        // 山の上では、このイベントが山まで伝わってから前に出るカードが切り替わる。切り替わったあとのマウスの下のカードで判断する
        // （マイクロタスクは途中の処理の合間に動いてしまい、切り替わる前に判断してしまうので使わない）
        clearTimeout(cutBarCheckTimer);
        cutBarCheckTimer = setTimeout(() => {
            const under = document.elementFromPoint(x, y);
            const underKey = under && under.closest(".ps-key");
            const target = (underKey && underKey.psCutBarTarget) || {scene, cut, key};
            const shown = !cutBar.classList.contains("ps-off");
            // 出ているバーと同じカット案の上か、バーの近くなら、そのまま残す
            if (shown && ((cutBarFor && cutBarFor.cut === target.cut) || near)) return;
            // 帯の外で別のカード（山の中の隣のカードなど）に移ったら、出ているバーは消して、そこで止まったら出し直す
            if (shown) hideCutBar();
            cutBarTimer = setTimeout(() => showCutBar(target, x, y), CUT_BAR_DELAY);
        }, 0);
    }

    function showCutBar(target, x, y) {
        // 待つ間に山の前に出るカードが変わることがあるので、出すときにマウスの下にあるカードを選び直す
        const under = document.elementFromPoint(x, y);
        const underKey = under && under.closest(".ps-key");
        if (underKey && underKey.psCutBarTarget) target = underKey.psCutBarTarget;
        const {scene, cut, key} = target;
        if (!key.isConnected || !under || !key.contains(under)) return;
        cutBarFor = target;
        const count = queuesOf(cut).length;
        const run = (fn) => () => {
            hideCutBar();
            fn();
        };
        cutBar.textContent = "";
        cutBar.append(
            el("div", {class: "ps-cut-bar-row"}, [
                el("button", {type: "button", class: "mtm-btn ps-cut-bar-edit", text: "プロンプト編集", onclick: run(() => openEditor(cut))}),
                el("button", {type: "button", class: "mtm-btn mtm-primary", title: "1枚だけ今すぐ生成", text: "プレビュー", onclick: run(() => runPreview(cut))}),
                el("button", {type: "button", class: "mtm-btn mtm-primary ps-cut-bar-queue", title: "キューを登録", text: "キュー" + (count ? " " + count : ""), onclick: run(() => openQueueForm(cut))}),
            ]),
            el("div", {class: "ps-cut-bar-row"}, [
                el("button", {type: "button", class: "mtm-btn", text: "複製", onclick: run(() => duplicateCut(scene, cut))}),
                el("button", {type: "button", class: "mtm-btn mtm-danger", text: "削除", onclick: run(() => askDeleteCut(scene, cut))}),
            ]),
        );
        // 横はカードの枠にぴったり合わせ、縦だけマウスの位置に合わせる。キー画像の中でマウスの上に入れば上、入らなければ下。
        // 位置は、バーを入れている窓からの相対で決める
        const view = q(".ps-project-view").getBoundingClientRect();
        const card = key.closest(".ps-cut").getBoundingClientRect();
        const k = key.getBoundingClientRect();
        cutBar.style.width = card.width + "px";
        cutBar.classList.remove("ps-off");
        const h = cutBar.offsetHeight;
        const above = y - CUT_BAR_GAP - h >= Math.max(k.top, view.top);
        const top = above ? y - CUT_BAR_GAP - h : Math.min(y + CUT_BAR_GAP + 6, card.bottom - h, view.bottom - h - 4);
        // 窓の枠線の分を引いて、カードの左端に合わせる
        cutBar.style.left = card.left - view.left - q(".ps-project-view").clientLeft + "px";
        cutBar.style.top = top - view.top - q(".ps-project-view").clientTop + "px";
    }

    // キー画像からバーへ移る間に消えないよう、少し待ってから消す
    function leaveCutBar() {
        clearTimeout(cutBarCheckTimer);
        clearTimeout(cutBarTimer);
        clearTimeout(cutBarHideTimer);
        cutBarHideTimer = setTimeout(hideCutBar, 250);
    }

    function hideCutBar() {
        clearTimeout(cutBarCheckTimer);
        clearTimeout(cutBarTimer);
        clearTimeout(cutBarHideTimer);
        cutBarFor = null;
        if (cutBar) cutBar.classList.add("ps-off");
    }

    async function addScene() {
        project.scenes.push({id: newId(), name: "シーン" + (project.scenes.length + 1), cuts: []});
        renderScenes();
        await saveProjects();
    }

    async function deleteScene(scene) {
        if (scene.cuts.length) return;
        project.scenes.splice(project.scenes.indexOf(scene), 1);
        renderScenes();
        await saveProjects();
    }

    function newCut(fields) {
        return {
            id: newId(), title: "", positive: "", negative: "",
            width: 0, height: 0,
            steps: 50, seed: -1, subseed: -1, subseedStrength: 0, keyImage: "", favorites: [], history: [],
            createdAt: new Date().toISOString(),
            ...fields,
        };
    }

    // 新しいカット案のサイズは、同じシーンで最後にサイズを決めたカット案（なければプロジェクト全体で最後のもの）から引き継ぐ
    function inheritedSize(scene) {
        const sized = (list) => [...list].reverse().find((c) => c.width && c.height);
        const from = sized(scene.cuts) || sized(cutsOf(project));
        return from ? {width: from.width, height: from.height} : {};
    }

    // 画像の生成情報のサイズ（"832 x 1216" や "832x1216"）を {width, height} にする。読めなければ null
    function parseSize(text) {
        const m = String(text || "").match(/(\d+)\s*x\s*(\d+)/);
        return m && Number(m[1]) && Number(m[2]) ? {width: Number(m[1]), height: Number(m[2])} : null;
    }

    // サイズを決めていないカット案は、生成した画像のサイズを覚える。覚えたら true
    function adoptSize(p, cut) {
        if (cut.width && cut.height) return false;
        const list = imagesOf(p, cut);
        const size = list.length && parseSize(list[list.length - 1].size);
        if (!size) return false;
        Object.assign(cut, size);
        return true;
    }

    async function addCut(scene) {
        scene.cuts.push(newCut({title: "カット案 " + (scene.cuts.length + 1), ...inheritedSize(scene)}));
        renderScenes();
        await saveProjects();
    }

    // 複製では画像とキューを引き継がない。プロンプトとプレビューの設定は引き継ぐ
    async function duplicateCut(scene, cut) {
        const copy = {
            ...JSON.parse(JSON.stringify(cut)),
            id: newId(), title: cut.title + " のコピー", keyImage: "", favorites: [], history: [],
            createdAt: new Date().toISOString(),
        };
        scene.cuts.splice(scene.cuts.indexOf(cut) + 1, 0, copy);
        renderScenes();
        await saveProjects();
    }

    // ---------- キー画像 ----------

    let keyCut = null;

    function openKeyDialog(cut) {
        keyCut = cut;
        renderKeyDialog();
        q(".ps-key-dialog").classList.remove("ps-off");
    }

    function renderKeyDialog() {
        const cut = keyCut;
        const key = keyImageOf(project, cut);
        q(".ps-key-id").textContent = `識別子 ${cut.id}・${imagesOf(project, cut).length} 枚`;
        const list = q(".ps-key-thumbs");
        list.textContent = "";
        imagesOf(project, cut).forEach((image, i) => {
            list.appendChild(makeThumb(project, cut, image, {
                on: image === key,
                mark: image === key ? "キー" : "",
                label: String(i + 1),
                onclick: () => setKeyImage(cut, image.name),
            }));
        });
    }

    async function setKeyImage(cut, name) {
        cut.keyImage = name;
        if (keyCut === cut && isOpen(".ps-key-dialog")) renderKeyDialog();
        if (isOpen(".ps-gallery-view")) renderGallery();
        if (isOpen(".ps-viewer")) showImage(viewImage);
        refreshViews();
        await saveProjects();
    }

    // 裏にある画面を今のデータで描き直す
    function refreshViews() {
        if (project) renderScenes();
        // 編集画面の上段のサムネイルも画像の増減に合わせる
        window.PolarisStudio.reloadEditor();
    }

    // コマで使っている印。panels はコマページの名前（「Book」のコマページ 003 など）
    function panelMark(panels) {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 12 12");
        svg.setAttribute("aria-hidden", "true");
        // コマ割りの形：外枠と、横に 1 本・下の段を縦に 1 本
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", "M1.5 1.5h9v9h-9z M1.5 5.5h9 M6 5.5v5");
        svg.appendChild(path);
        return el("span", {class: "ps-thumb-panel", title: "コマで使用中: " + panels.join("、")}, [
            svg,
            ...(panels.length > 1 ? [document.createTextNode(String(panels.length))] : []),
        ]);
    }

    // ---------- お気に入り ----------
    // カット案ごとに、お気に入りにした画像の名前を favorites に持つ。画像を消したら外す

    const isFavorite = (cut, name) => Array.isArray(cut.favorites) && cut.favorites.includes(name);
    const favoriteMark = () => el("span", {class: "ps-thumb-fav", title: "お気に入り", text: "♥"});

    async function toggleFavorite(cut, name) {
        if (!Array.isArray(cut.favorites)) cut.favorites = [];
        if (isFavorite(cut, name)) cut.favorites = cut.favorites.filter((x) => x !== name);
        else cut.favorites.push(name);
        if (isOpen(".ps-gallery-view") && galleryCut === cut) renderGallery();
        await saveProjects();
    }

    // 消えた画像（selKey の形）をお気に入りから外す
    function removeFavorites(keys) {
        for (const cut of cutsOf(project)) {
            if (Array.isArray(cut.favorites)) cut.favorites = cut.favorites.filter((name) => !keys.includes(selKey(cut, name)));
        }
    }

    function makeThumb(p, cut, image, {on, selected, mark, label, onclick, select, panels}) {
        const fav = isFavorite(cut, image.name);
        const thumb = el("button", {type: "button", class: "ps-thumb" + (on ? " ps-on" : "") + (selected ? " ps-selected" : ""), title: image.name}, [
            el("img", {src: imageUrl(p, cut, image, true), alt: "", loading: "lazy"}),
            ...(mark ? [el("span", {class: "ps-thumb-mark", text: mark})] : []),
            ...(select ? [el("span", {class: "ps-thumb-check", title: "選択（Shift+クリックで範囲選択）", text: selected ? "✓" : "", onclick: (e) => {
                e.stopPropagation();
                select(e);
            }})] : []),
            ...(label ? [el("span", {class: "ps-thumb-label", text: label})] : []),
            // はめ込んでいるコマ（削除するときは確認で知らせる）と、その隣にお気に入り
            ...((panels && panels.length) || fav ? [el("span", {class: "ps-thumb-marks"}, [
                ...(panels && panels.length ? [panelMark(panels)] : []),
                ...(fav ? [favoriteMark()] : []),
            ])] : []),
        ]);
        thumb.dataset.name = image.name;
        thumb.addEventListener("click", onclick);
        return thumb;
    }

    // ---------- 生成の進捗のトースト ----------
    // プレビューとキューの生成中は、画面右上（上部バーのすぐ下）に進捗を出す。どの画面にいても見える

    const TOAST_HIDE = 6000;    // 終わってから消すまで
    let toast = null;
    let toastHideTimer = null;
    let toastStop = null;
    let toastOpen = null;       // 生成した画像を開く関数（プレビューの結果）

    function buildToast() {
        toast = el("div", {class: "ps-toast ps-off", role: "status"}, [
            el("div", {class: "ps-toast-head"}, [
                el("span", {class: "ps-toast-title"}),
                el("span", {class: "ps-toast-sub"}),
                el("button", {type: "button", class: "mtm-icon ps-toast-close", title: "閉じる（生成は続きます）", text: "✕", onclick: () => toast.classList.add("ps-off")}),
            ]),
            el("div", {class: "ps-toast-bar"}, [el("div", {class: "ps-toast-fill"})]),
            el("button", {type: "button", class: "ps-toast-thumb ps-off", title: "ビューワーで開く", onclick: () => {
                toast.classList.add("ps-off");
                if (toastOpen) toastOpen();
            }}, [el("img", {alt: ""})]),
            el("div", {class: "ps-toast-foot"}, [
                el("span", {class: "ps-toast-text"}),
                el("button", {type: "button", class: "mtm-btn mtm-danger ps-toast-stop", text: "中止", onclick: () => toastStop && toastStop()}),
            ]),
        ]);
        overlay.appendChild(toast);
        window.addEventListener("resize", placeToast);
    }

    // 見えている窓の上部バーの右下に合わせる
    function placeToast() {
        if (!toast || toast.classList.contains("ps-off")) return;
        const bar = [...fs.querySelectorAll(".mtm-fs-bar")].find((b) => b.offsetParent && b.getBoundingClientRect().width > 0);
        const r = bar ? bar.getBoundingClientRect() : {bottom: 8, right: window.innerWidth - 8};
        toast.style.top = r.bottom + 8 + "px";
        toast.style.right = window.innerWidth - r.right + 12 + "px";
    }

    function startToast(title, sub, stop) {
        clearTimeout(toastHideTimer);
        toastStop = stop;
        toast.querySelector(".ps-toast-title").textContent = title;
        toast.querySelector(".ps-toast-sub").textContent = sub;
        toast.querySelector(".ps-toast-sub").title = sub;
        toast.querySelector(".ps-toast-text").textContent = "生成を開始しています…";
        toast.querySelector(".ps-toast-fill").style.width = "0%";
        toast.querySelector(".ps-toast-stop").classList.remove("ps-off");
        toast.querySelector(".ps-toast-thumb").classList.add("ps-off");
        toastOpen = null;
        toast.classList.remove("ps-toast-done", "ps-toast-failed");
        toast.classList.remove("ps-off");
        placeToast();
    }

    function updateToast(info) {
        if (!info || info.done) return;
        const fmt = window.PolarisStudio.fmtTime;
        const parts = [Math.floor(info.progress * 100) + "%"];
        if (info.waiting) parts.push("待機中");
        if (info.eta) parts.push("残り " + fmt(info.eta));
        parts.push("経過 " + fmt(info.elapsed));
        toast.querySelector(".ps-toast-text").textContent = parts.join("・");
        toast.querySelector(".ps-toast-fill").style.width = info.progress * 100 + "%";
        // 生成中に開いた窓（編集画面など）の上部バーに合わせ直す
        placeToast();
    }

    // 閉じていたトーストも、結果を知らせるためにもう一度出す。画像（{src, open}）を渡すと、押して開けるように出す
    function endToast(title, text, ok, image = null) {
        toastStop = null;
        toastOpen = image && image.open;
        toast.querySelector(".ps-toast-title").textContent = title;
        toast.querySelector(".ps-toast-sub").textContent = "";
        toast.querySelector(".ps-toast-text").textContent = text;
        if (ok) toast.querySelector(".ps-toast-fill").style.width = "100%";
        toast.querySelector(".ps-toast-stop").classList.add("ps-off");
        const thumb = toast.querySelector(".ps-toast-thumb");
        thumb.classList.toggle("ps-off", !image);
        if (image) thumb.querySelector("img").src = image.src;
        toast.classList.add(ok ? "ps-toast-done" : "ps-toast-failed");
        toast.classList.remove("ps-off");
        placeToast();
        clearTimeout(toastHideTimer);
        toastHideTimer = setTimeout(() => toast.classList.add("ps-off"), TOAST_HIDE);
    }

    function interruptGeneration() {
        const btn = gradioApp().querySelector("#txt2img_interrupt");
        if (btn) btn.click();
    }

    // ---------- プレビュー（常に1枚） ----------
    // 生成中も画面は操作できる。進捗と結果はトーストに出し、生成した画像はトーストから開く

    async function runPreview(cut) {
        if (generating) {
            alert("生成中です。終わってから実行してください。");
            return;
        }
        if (!cut.positive.trim()) {
            alert("プロンプトが空です。プロンプト編集から入力してください。");
            return;
        }
        // 生成中に別のプロジェクトへ移っても、生成を始めたプロジェクトに入れる
        const p = project;
        const before = imagesOf(p, cut).length;
        generating = true;
        if (isOpen(".ps-queues-view")) renderQueueManager();
        startToast("プレビュー", cut.title, interruptGeneration);
        window.PolarisStudio.onProgress((text, info) => updateToast(info));
        try {
            await window.PolarisStudio.generate({
                project: p.id, cut: cut.id, source: "preview",
                positive: cut.positive, negative: cut.negative,
                width: cut.width, height: cut.height,
                steps: cut.steps, batch: 1, seed: cut.seed, subseed: cut.subseed, subseedStrength: cut.subseedStrength,
            });
            await loadImages(p);
            if (adoptSize(p, cut)) await saveProjects();
            const list = imagesOf(p, cut);
            if (list.length > before) {
                const image = list[list.length - 1];
                endToast("プレビュー", cut.title + " を生成しました（画像を押すと開きます）", true, {
                    src: imageUrl(p, cut, image, true),
                    open: () => {
                        if (project === p && sceneOf(cut)) openViewerFor(cut, image);
                    },
                });
            } else {
                endToast("プレビュー", "画像は生成されませんでした", false);
            }
        } catch (e) {
            console.error("[Polaris Studio] preview failed", e);
            endToast("プレビュー", "生成に失敗しました: " + e.message, false);
        }
        window.PolarisStudio.onProgress(null);
        generating = false;
        if (project === p) refreshViews();
        if (isOpen(".ps-queues-view")) renderQueueManager();
    }

    // ---------- キュー登録（カット案からは登録だけを行う） ----------
    // 画面を切り替えず、カードの下（編集画面からは「キュー」ボタンの下）に小さなパネルを出す

    let queueCut = null;
    let queueAnchor = null;     // パネルを付ける要素。null ならカット案のカード

    function openQueueForm(cut, anchor = null) {
        // 折りたたんだシーンのカット案は、シーンを開いてからカードに付ける
        const scene = sceneOf(cut);
        if (!anchor && scene && foldedScenes.has(scene.id)) toggleScene(scene);
        queueCut = cut;
        queueAnchor = anchor;
        q(".ps-queue-cut").textContent = cut.title;
        q(".ps-queue-cut").title = cut.positive;
        q(".ps-queue-name").value = "";
        q(".ps-queue-name").placeholder = nextQueueName();
        // Steps・Seed 類はカット案の値を流用し、Batch だけは初期値から始める
        const initial = {...QUEUE_DEFAULT, steps: cut.steps, seed: cut.seed, subseed: cut.subseed, subseedStrength: cut.subseedStrength};
        fs.querySelectorAll("[data-queue]").forEach((i) => (i.value = initial[i.dataset.queue]));
        renderQueueRows();
        const panel = q(".ps-queue-panel");
        panel.classList.remove("ps-off", "ps-qp-in");
        void panel.offsetWidth;
        panel.classList.add("ps-qp-in");
        placeQueuePanel();
        // Enter でそのまま登録できるようにしておく
        q(".ps-queue-save").focus();
    }

    function closeQueueForm() {
        if (!queueCut) return;
        queueCut = null;
        queueAnchor = null;
        fs.querySelectorAll(".ps-cut.ps-queue-open").forEach((c) => c.classList.remove("ps-queue-open"));
        hide(".ps-queue-panel");
    }

    // 付ける要素の下に出す。下に入らなければ上に出し、左右は画面からはみ出さないようにずらす
    function placeQueuePanel() {
        if (!queueCut) return;
        const panel = q(".ps-queue-panel");
        fs.querySelectorAll(".ps-cut.ps-queue-open").forEach((c) => c.classList.remove("ps-queue-open"));
        let anchor = queueAnchor;
        if (!anchor) {
            anchor = fs.querySelector(`.ps-cut[data-cut="${queueCut.id}"]`);
            if (anchor) anchor.classList.add("ps-queue-open");
        }
        if (!anchor || !anchor.isConnected) return;
        const r = anchor.getBoundingClientRect();
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        panel.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8) + "px";
        panel.style.top = top + "px";
    }

    function nextQueueName() {
        let max = 0;
        for (const x of project.queues) {
            const m = x.name.match(/^queue_(\d+)/);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return "queue_" + String(max + 1).padStart(3, "0");
    }

    function readQueueForm() {
        const values = {};
        fs.querySelectorAll("[data-queue]").forEach((i) => {
            const v = Number(i.value);
            values[i.dataset.queue] = i.value.trim() !== "" && Number.isFinite(v) ? v : QUEUE_DEFAULT[i.dataset.queue];
        });
        return {
            steps: Math.max(1, Math.round(values.steps)),
            batch: Math.max(1, Math.round(values.batch)),
            seed: Math.max(-1, Math.round(values.seed)),
            subseed: Math.max(-1, Math.round(values.subseed)),
            subseedStrength: Math.round(Math.min(Math.max(values.subseedStrength, 0), 1) * 100) / 100,
        };
    }

    // 登録時のプロンプトと設定をそのまま持つ。登録しても画面に残り、Seed などを変えて続けて登録できる
    async function registerQueue() {
        const cut = queueCut;
        if (!cut.positive.trim()) {
            alert("プロンプトが空です。✎ から編集してください。");
            return;
        }
        const scene = project.scenes.find((s) => s.cuts.includes(cut));
        project.queues.push({
            id: newId(),
            name: q(".ps-queue-name").value.trim() || nextQueueName(),
            cutId: cut.id,
            sceneName: scene ? scene.name : "",
            cutTitle: cut.title,
            positive: cut.positive,
            negative: cut.negative,
            width: cut.width || 0,
            height: cut.height || 0,
            ...readQueueForm(),
            status: "waiting",
            createdAt: new Date().toISOString(),
        });
        const name = project.queues[project.queues.length - 1].name;
        q(".ps-queue-name").value = "";
        q(".ps-queue-name").placeholder = nextQueueName();
        renderQueueRows(name);
        await saveProjects();
    }

    const queueValues = (x) => `サイズ ${x.width && x.height ? `${x.width}×${x.height}` : "WebUI のまま"} / Steps ${x.steps} / Batch ${x.batch} / Seed ${x.seed < 0 ? "ランダム" : x.seed} / Var Seed ${x.subseed < 0 ? "ランダム" : x.subseed} / Var ${x.subseedStrength}`;

    // 登録済みの件数だけを出す。中身の確認・削除・実行はキュー管理で行う
    function renderQueueRows(added = "") {
        const count = queuesOf(queueCut).length;
        const head = q(".ps-queue-head");
        head.textContent = (added ? `${added} を登録しました・` : "") + `このカット案から ${count} 件`;
        head.classList.toggle("ps-qp-added", !!added);
    }

    // ---------- 再生成のキュー登録 ----------
    // サムネイル一覧で（カット案をまたいで）選んだ画像を、元のプロンプト・Seed・Var Seed・サイズのまま
    // Steps だけ変えて 1 枚ずつ作り直す。1 回の登録で 1 件のキューになり、作り直した画像は元のカット案に入る

    const REGEN_STEPS_KEY = "polaris-studio:regen-steps";
    let regenButton = null;

    // 選択のうち、まだある画像の生成情報。生成情報（プロンプト）のない画像は作り直せないので除く
    function regenTargets() {
        const images = [];
        let skipped = 0;
        let maxSteps = 0;   // 元の画像の Steps の最大。Steps の初期値に使う
        for (const k of selectedImages) {
            const cut = cutsOf(project).find((c) => c.id === selCutId(k));
            const image = cut && imagesOf(project, cut).find((x) => x.name === selName(k));
            if (!image) continue;
            if (!image.prompt) {
                skipped++;
                continue;
            }
            const [width, height] = (image.size || "").split("x").map((v) => parseInt(v, 10) || 0);
            const num = (v, fallback) => (String(v).trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);
            maxSteps = Math.max(maxSteps, parseInt(image.steps, 10) || 0);
            images.push({
                cutId: cut.id, name: image.name, positive: image.prompt, negative: image.negative || "",
                seed: num(image.seed, -1), subseed: num(image.subseed, -1), subseedStrength: num(image.subseedStrength, 0),
                width: width || 0, height: height || 0,
            });
        }
        // カット案の並び、その中は画像の並び（古い順）にそろえる
        const order = cutsOf(project).map((c) => c.id);
        const index = (x) => imagesOf(project, cutsOf(project).find((c) => c.id === x.cutId)).findIndex((i) => i.name === x.name);
        images.sort((a, b) => order.indexOf(a.cutId) - order.indexOf(b.cutId) || index(a) - index(b));
        return {images, skipped, maxSteps};
    }

    function regenSummary(images) {
        const titles = [...new Set(images.map((x) => x.cutId))].map((id) => (cutsOf(project).find((c) => c.id === id) || {}).title || "");
        return titles.length > 1 ? `${titles[0]} ほか ${titles.length - 1} カット案` : titles[0] || "";
    }

    function openRegenForm(button) {
        const {images, skipped, maxSteps} = regenTargets();
        if (!images.length) {
            alert(skipped ? "選んだ画像には生成情報（プロンプト）がないため、再生成できません。" : "再生成する画像を選んでください。");
            return;
        }
        regenButton = button;
        const cuts = new Set(images.map((x) => x.cutId)).size;
        q(".ps-regen-info").textContent = `${images.length} 枚・${cuts} カット案`;
        q(".ps-regen-info").title = regenSummary(images);
        q(".ps-regen-name").value = "";
        q(".ps-regen-name").placeholder = nextQueueName();
        let steps = "";
        try {
            steps = localStorage.getItem(REGEN_STEPS_KEY) || "";
        } catch (e) { /* 覚えていなければ元の画像の Steps から */ }
        if (!steps) steps = maxSteps || QUEUE_DEFAULT.steps;
        q(".ps-regen-steps").value = steps;
        const head = q(".ps-regen-head");
        head.textContent = skipped ? `生成情報のない ${skipped} 枚は除きます` : "";
        head.classList.remove("ps-qp-added");
        q(".ps-regen-save").disabled = false;
        const panel = q(".ps-regen-panel");
        panel.classList.remove("ps-off", "ps-qp-in");
        void panel.offsetWidth;
        panel.classList.add("ps-qp-in");
        placeRegenPanel();
        q(".ps-regen-steps").focus();
        q(".ps-regen-steps").select();
    }

    function closeRegenForm() {
        if (!isOpen(".ps-regen-panel")) return;
        regenButton = null;
        hide(".ps-regen-panel");
    }

    // ボタンの下に、右端をボタンにそろえて出す
    function placeRegenPanel() {
        if (!isOpen(".ps-regen-panel") || !regenButton || !regenButton.isConnected) return;
        const panel = q(".ps-regen-panel");
        const r = regenButton.getBoundingClientRect();
        let top = r.bottom + 6;
        if (top + panel.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - panel.offsetHeight - 6);
        panel.style.top = top + "px";
        panel.style.left = Math.min(Math.max(8, r.right - panel.offsetWidth), window.innerWidth - panel.offsetWidth - 8) + "px";
    }

    async function registerRegen() {
        const {images} = regenTargets();
        if (!images.length || q(".ps-regen-save").disabled) return;
        const v = Number(q(".ps-regen-steps").value);
        const steps = Number.isFinite(v) && v >= 1 ? Math.round(v) : QUEUE_DEFAULT.steps;
        try {
            localStorage.setItem(REGEN_STEPS_KEY, String(steps));
        } catch (e) { /* 覚えられなくても登録はできる */ }
        const name = q(".ps-regen-name").value.trim() || nextQueueName();
        project.queues.push({
            id: newId(), name, kind: "regen", images,
            cutId: "", sceneName: "", cutTitle: regenSummary(images), positive: "", negative: "",
            steps, batch: 1, seed: -1, subseed: -1, subseedStrength: 0,
            status: "waiting", createdAt: new Date().toISOString(),
        });
        // 同じ選択で二重に登録しないよう、登録したら選択を外してボタンを止める
        selectedImages.clear();
        if (isOpen(".ps-gallery-view")) renderGallery();
        updateSelBadges();
        const head = q(".ps-regen-head");
        head.textContent = `${name} を登録しました（${images.length} 枚・Steps ${steps}）`;
        head.classList.add("ps-qp-added");
        q(".ps-regen-save").disabled = true;
        if (isOpen(".ps-queues-view")) renderQueueManager();
        await saveProjects();
    }

    // ---------- Book（製本） ----------
    // Book はコマページ（{type: "page", ...}、polaris_pages.js）を Book 内の順序で items に持つ。
    // コマにはめ込む画像は、コマページの編集画面でカット案 → そのカット案の画像の順に選ぶ。
    // Book を削除しても画像は残る

    let bookId = "";            // Book の画面で開いている Book

    const bookOf = (id) => project.books.find((b) => b.id === id) || null;
    const refKey = (r) => r.cutId + "/" + r.name;
    const isPage = (r) => r.type === "page";
    const pageItems = (book) => book.items.filter(isPage);
    // コマにはめ込んだ画像の参照
    const panelRefs = (book) => pageItems(book).flatMap((p) => p.shapes.filter((s) => s.image).map((s) => s.image));
    // Book のコマが使っている画像の selKey
    const bookKeys = (book) => new Set(panelRefs(book).map(refKey));
    // その画像（selKey の形）を使っている Book
    const booksWith = (key) => project.books.filter((b) => bookKeys(b).has(key));
    // その画像をはめ込んでいるコマページの名前。同じページに何コマあっても 1 つと数える
    function panelPages(key, books, withTitle) {
        const names = [];
        for (const b of books) {
            const width = Math.max(3, String(b.items.length).length);
            b.items.forEach((r, i) => {
                if (!isPage(r) || !r.shapes.some((s) => s.image && refKey(s.image) === key)) return;
                const no = String(i + 1).padStart(width, "0");
                names.push(withTitle ? `「${b.title}」の ${no}` : `${no} ページ`);
            });
        }
        return names;
    }
    const bookCount = (book) => `コマページ ${pageItems(book).length}`;

    function findImage(ref) {
        const cut = cutsOf(project).find((c) => c.id === ref.cutId);
        const image = cut && imagesOf(project, cut).find((x) => x.name === ref.name);
        return image ? {cut, image} : null;
    }

    // 削除する画像を使っている Book を、確認の文に足す
    function bookWarning(keys) {
        const hit = project.books.map((b) => {
            const used = bookKeys(b);
            return {b, n: keys.filter((k) => used.has(k)).length};
        }).filter((x) => x.n);
        if (!hit.length) return "";
        const n = new Set(keys.filter((k) => booksWith(k).length)).size;
        return `\n⚠ このうち ${n} 枚は Book（${hit.map((x) => `「${x.b.title}」${x.n} 枚`).join("、")}）のコマで使われています。削除すると、はめ込んだコマは空になります。`;
    }

    // 消えた画像やカット案を、コマのはめ込みから外す
    function removeFromBooks(match) {
        for (const b of project.books) {
            for (const p of pageItems(b)) {
                for (const s of p.shapes) if (s.image && match(s.image)) s.image = null;
            }
        }
    }

    // Book の画面。個別プロジェクトの画面と入れ替えて開く
    function openBooks(id = "") {
        closeQueueForm();
        closeQueueManager();
        closeRegenForm();
        if (isOpen(".ps-gallery-view")) closeGallery();
        bookId = bookOf(id) ? id : bookOf(bookId) ? bookId : (project.books[0] || {}).id || "";
        q(".ps-project-view").classList.add("ps-off");
        q(".ps-books-view").classList.remove("ps-off");
        renderBooks();
    }

    function closeBooks() {
        window.PolarisPages.close();
        q(".ps-books-view").classList.add("ps-off");
        q(".ps-project-view").classList.remove("ps-off");
        renderScenes();
        fs.focus();
    }

    function renderBooks() {
        q(".ps-books-project").textContent = project.title;
        const list = q(".ps-books-list");
        list.textContent = "";
        if (!project.books.length) list.appendChild(el("div", {class: "mtm-empty", text: "Book はまだありません"}));
        for (const b of project.books) {
            list.appendChild(el("button", {type: "button", class: "ps-books-item" + (b.id === bookId ? " ps-on" : ""), onclick: () => {
                bookId = b.id;
                renderBooks();
            }}, [
                el("span", {class: "ps-books-item-title", text: b.title}),
                el("span", {class: "ps-books-item-count", text: bookCount(b)}),
            ]));
        }
        const book = bookOf(bookId);
        q(".ps-book-main").classList.toggle("ps-off", !book);
        if (!book) return;
        q(".ps-book-title").value = book.title;
        q(".ps-book-count").textContent = bookCount(book);
        q(".ps-book-export").disabled = !book.items.length;
        renderBookPages(book);
    }

    let bookDrag = -1;

    function renderBookPages(book) {
        const box = q(".ps-book-pages");
        box.textContent = "";
        if (!book.items.length) box.appendChild(el("div", {class: "mtm-empty", text: "まだコマページがありません。「コマページ作成」で白紙のコマページを足し、コマにカット案の画像をはめ込みます。"}));
        const width = Math.max(3, String(book.items.length).length);
        book.items.forEach((r, i) => {
            const no = el("span", {class: "ps-book-no", text: String(i + 1).padStart(width, "0")});
            const page = el("div", {class: "ps-book-page ps-book-komapage", draggable: "true", title: `コマページ ${r.width} × ${r.height}\nクリックで編集`}, [
                window.PolarisPages.thumb(r, (ref) => {
                    const found = findImage(ref);
                    return found ? imageUrl(project, found.cut, found.image, true) : null;
                }),
                no,
                el("span", {class: "ps-book-cut", text: "コマページ"}),
                el("button", {type: "button", class: "mtm-icon ps-book-remove", title: "コマページを削除（画像は削除しません）", text: "✕", onclick: () => deletePage(book, r)}),
            ]);
            page.addEventListener("click", (e) => {
                if (!e.target.closest("button")) openPageEditor(book, r);
            });
            page.addEventListener("dragstart", (e) => {
                bookDrag = i;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", "");
                page.classList.add("ps-dragging");
            });
            page.addEventListener("dragend", () => {
                bookDrag = -1;
                box.querySelectorAll(".ps-book-page").forEach((p) => p.classList.remove("ps-dragging", "ps-drop-before", "ps-drop-after"));
            });
            page.addEventListener("dragover", (e) => {
                if (bookDrag < 0) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const after = e.clientX > page.getBoundingClientRect().left + page.offsetWidth / 2;
                box.querySelectorAll(".ps-book-page").forEach((p) => p.classList.remove("ps-drop-before", "ps-drop-after"));
                if (bookDrag !== i) page.classList.add(after ? "ps-drop-after" : "ps-drop-before");
            });
            page.addEventListener("drop", (e) => {
                if (bookDrag < 0) return;
                e.preventDefault();
                const after = e.clientX > page.getBoundingClientRect().left + page.offsetWidth / 2;
                movePage(book, bookDrag, i + (after ? 1 : 0));
            });
            box.appendChild(page);
        });
    }

    // from の画像を to の位置（その前）へ動かす
    async function movePage(book, from, to) {
        if (to === from || to === from + 1) return;
        const [r] = book.items.splice(from, 1);
        book.items.splice(to > from ? to - 1 : to, 0, r);
        renderBooks();
        await saveProjects();
    }

    // ---------- コマページ（polaris_pages.js） ----------

    // 白紙のコマページを Book の最後に足して、すぐ編集画面を開く
    async function createPage() {
        const book = bookOf(bookId);
        if (!book) return;
        const page = window.PolarisPages.newPage();
        book.items.push(page);
        renderBooks();
        openPageEditor(book, page);
        await saveProjects();
    }

    async function deletePage(book, page) {
        const n = page.shapes.length;
        if (n && !confirm(`このコマページを削除しますか？\n描いた ${n} 個の図形も消えます。はめ込んだ画像は削除されません。`)) return;
        book.items = book.items.filter((r) => r !== page);
        renderBooks();
        await saveProjects();
    }

    function openPageEditor(book, page) {
        window.PolarisPages.open({
            host: overlay,
            page,
            title: () => `${book.title}  ${book.items.indexOf(page) + 1} / ${book.items.length}`,
            // はめ込む画像は、カット案を選んでから、そのカット案の画像（古い順）から選ぶ。
            // panels はこの Book のコマで使っているページの名前（カット案ではその画像のどれかを使っているページ）
            cuts: () => project.scenes.flatMap((scene) => scene.cuts.map((cut) => {
                const key = keyImageOf(project, cut);
                const list = imagesOf(project, cut);
                const pages = [...new Set(list.flatMap((image) => panelPages(selKey(cut, image.name), [book], false)))].sort();
                return {id: cut.id, title: cut.title, scene: scene.name, count: list.length,
                    favorites: list.filter((image) => isFavorite(cut, image.name)).length,
                    thumb: key ? imageUrl(project, cut, key, true) : "", panels: pages};
            })),
            images: (cutId) => {
                const cut = cutsOf(project).find((c) => c.id === cutId);
                return cut ? imagesOf(project, cut).map((image, i) => ({cutId, name: image.name, label: String(i + 1), favorite: isFavorite(cut, image.name),
                    thumb: imageUrl(project, cut, image, true), panels: panelPages(selKey(cut, image.name), [book], false)})) : [];
            },
            // お気に入りの印（サムネイル一覧と同じもの）
            favoriteMark,
            // コマで使っている印（サムネイル一覧と同じもの）
            panelMark,
            resolve: (ref, thumb) => {
                const found = findImage(ref);
                return found ? imageUrl(project, found.cut, found.image, thumb) : null;
            },
            onChange: () => saveProjects(),
            onClose: () => {
                renderBooks();
                fs.focus();
            },
        });
    }

    async function createBook() {
        const book = {id: newId(), title: `Book ${project.books.length + 1}`, items: [], createdAt: new Date().toISOString()};
        project.books.push(book);
        bookId = book.id;
        renderBooks();
        q(".ps-book-title").focus();
        q(".ps-book-title").select();
        await saveProjects();
    }

    async function renameBook() {
        const book = bookOf(bookId);
        if (!book) return;
        book.title = q(".ps-book-title").value.trim() || book.title;
        renderBooks();
        await saveProjects();
    }

    async function deleteBook() {
        const book = bookOf(bookId);
        if (!book) return;
        const pages = pageItems(book).length;
        const pageNote = pages ? `\nコマページ ${pages} 枚は Book と一緒に消えます。` : "";
        if (!confirm(`Book「${book.title}」を削除しますか？\nコマにはめ込んだ画像は削除されません。${pageNote}`)) return;
        project.books.splice(project.books.indexOf(book), 1);
        bookId = (project.books[0] || {}).id || "";
        renderBooks();
        await saveProjects();
    }

    // メタ情報を落とした PNG を、Book 内の順序（001.png …）をファイル名にして ZIP で保存する
    async function exportBook() {
        const book = bookOf(bookId);
        if (!book || !book.items.length) return;
        const button = q(".ps-book-export");
        button.disabled = true;
        button.textContent = "書き出し中…";
        try {
            const res = await fetch("polaris-studio/books/export", {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({project: project.id, items: book.items}),
            });
            if (!res.ok) throw new Error(((await res.json().catch(() => null)) || {}).error || res.status);
            const url = URL.createObjectURL(await res.blob());
            const a = el("a", {href: url});
            a.download = (book.title.replace(/[\\/:*?"<>|\s]+/g, "_") || "book") + ".zip";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (e) {
            alert("ZIP の書き出しに失敗しました。\n" + e.message);
        }
        button.textContent = "ZIP で書き出し";
        button.disabled = !book.items.length;
    }

    // ---------- キュー管理（プロジェクト全体） ----------

    let queueChecked = new Set();   // 選択中のキューの id
    let queueRun = null;            // 実行中の {abort}

    // 画面は切り替えず、上部バーの「キュー管理」ボタン（個別プロジェクトか編集画面のもの）の下にパネルを出す。もう一度押すと閉じる
    let queueManagerButton = null;

    function toggleQueueManager(button) {
        if (isOpen(".ps-queues-view") && queueManagerButton === button) closeQueueManager();
        else openQueueManager(button);
    }

    function openQueueManager(button) {
        if (queueManagerButton) queueManagerButton.classList.remove("mtm-active");
        queueManagerButton = button;
        queueChecked = new Set();
        renderQueueManager();
        const panel = q(".ps-queues-view");
        panel.classList.remove("ps-off", "ps-qp-in");
        void panel.offsetWidth;
        panel.classList.add("ps-qp-in");
        button.classList.add("mtm-active");
        placeQueueManager();
    }

    function closeQueueManager() {
        if (!isOpen(".ps-queues-view")) return;
        if (queueManagerButton) queueManagerButton.classList.remove("mtm-active");
        queueManagerButton = null;
        hide(".ps-queues-view");
    }

    // ボタンの下に、右端をボタンにそろえて出す。高さは画面の下端まで（はみ出す分は一覧をスクロール）
    function placeQueueManager() {
        if (!isOpen(".ps-queues-view") || !queueManagerButton) return;
        const panel = q(".ps-queues-view");
        const r = queueManagerButton.getBoundingClientRect();
        const top = r.bottom + 6;
        panel.style.top = top + "px";
        panel.style.right = Math.max(8, window.innerWidth - r.right) + "px";
        panel.style.maxHeight = window.innerHeight - top - 12 + "px";
    }

    function renderQueueManager() {
        if (!project) return;
        queueChecked = new Set(project.queues.filter((x) => queueChecked.has(x.id)).map((x) => x.id));
        q(".ps-queues-count").textContent = `${project.queues.length} 件`;
        const all = q(".ps-queues-all");
        all.checked = project.queues.length > 0 && queueChecked.size === project.queues.length;
        all.indeterminate = queueChecked.size > 0 && queueChecked.size < project.queues.length;
        const run = q(".ps-queues-run");
        run.textContent = `選択を実行（${queueChecked.size}件）`;
        run.disabled = queueChecked.size === 0 || generating;
        const del = q(".ps-queues-delete");
        del.textContent = `選択を削除（${queueChecked.size}件）`;
        del.disabled = queueChecked.size === 0 || generating;
        q(".ps-queues-stop").classList.toggle("ps-off", !queueRun);

        const list = q(".ps-qm-list");
        list.textContent = "";
        if (!project.queues.length) list.appendChild(el("div", {class: "mtm-empty", text: "キューはまだありません。カット案の「キュー」から登録してください。"}));
        for (const x of project.queues) list.appendChild(makeQueueRow(x));
    }

    function makeQueueRow(x) {
        const check = el("input", {type: "checkbox"});
        check.checked = queueChecked.has(x.id);
        check.addEventListener("change", () => {
            if (check.checked) queueChecked.add(x.id);
            else queueChecked.delete(x.id);
            renderQueueManager();
        });
        const run = el("button", {type: "button", class: "mtm-btn mtm-primary", text: "実行", onclick: () => runQueues([x])});
        const remove = el("button", {type: "button", class: "mtm-icon", title: "このキューを削除", text: "🗑", onclick: () => deleteQueues([x])});
        run.disabled = remove.disabled = generating;
        const error = x.status === "error" ? " ps-error" : "";
        // 実行中かどうかは保存しない（途中で閉じても「実行中」のまま残らないように）
        const running = queueRun && queueRun.current === x;
        const regen = x.kind === "regen";
        const status = running ? "実行中" + (regen && queueRun.step ? ` ${queueRun.step}/${x.images.length}` : "") : QUEUE_STATUS[x.status];
        const statusClass = running ? " ps-running" : error + (x.status === "done" ? " ps-done" : "");
        return el("div", {class: "ps-qm-row" + (running ? " ps-running" : "")}, [
            check,
            el("div", {class: "ps-qm-head"}, [
                el("span", {class: "ps-qm-name" + error, text: x.name}),
                el("span", {class: "ps-qm-cut", text: regen ? `再生成 ${x.images.length} 枚 ／ ${x.cutTitle}` : `${x.sceneName} ／ ${x.cutTitle}`}),
            ]),
            el("span", {class: "ps-qm-status" + statusClass, text: status}),
            el("div", {class: "ps-qm-actions"}, [run, remove]),
            el("div", {class: "ps-qm-detail", text: regen ? `Steps ${x.steps} / プロンプト・Seed・Var Seed・サイズは元の画像のまま` : queueValues(x)}),
            regen
                ? el("div", {class: "ps-qm-prompt", title: x.images.map((i) => i.name).join("\n"), text: x.images.map((i) => i.name).join(", ")})
                : el("div", {class: "ps-qm-prompt", title: x.positive, text: x.positive}),
        ]);
    }

    function deleteCheckedQueues() {
        deleteQueues(project.queues.filter((x) => queueChecked.has(x.id)));
    }

    async function deleteQueues(list) {
        project.queues = project.queues.filter((x) => !list.includes(x));
        renderQueueManager();
        await saveProjects();
    }

    function stopQueues() {
        if (!queueRun) return;
        queueRun.abort = true;
        const btn = gradioApp().querySelector("#txt2img_interrupt");
        if (btn) btn.click();
    }

    // ---------- 生成中の画像の取り込み ----------
    // キューの実行中は、進捗の通知（1 秒ほどごと）に合わせて IMAGE_POLL ごとに画像の一覧を読み直す。
    // 枚数が増えていたら（WebUI は 1 枚できるごとに保存する）サムネイルを描き直すので、ほぼ 1 枚ごとに並ぶ

    const IMAGE_POLL = 2000;
    let imagePollAt = 0;
    let imagePolling = false;
    let imageShownCount = 0;    // 画面に出している画像の枚数（プロジェクト全体）

    const countImages = (p) => Object.values(projectImages.get(p.id) || {}).reduce((n, list) => n + list.length, 0);

    async function pollImages(p) {
        if (imagePolling || Date.now() - imagePollAt < IMAGE_POLL) return;
        imagePolling = true;
        imagePollAt = Date.now();
        try {
            await loadImages(p);
            // 並べ替えのドラッグ中や、サムネイル一覧の範囲選択の最中は描き直さない（次の読み直しで描き直す）
            const busy = dragging || q(".ps-drag-box");
            if (project === p && !busy && countImages(p) !== imageShownCount) {
                imageShownCount = countImages(p);
                if (isOpen(".ps-gallery-view")) renderGallery();
                refreshViews();
            }
        } catch (e) {
            console.error("[Polaris Studio] load images failed", e);
        }
        imagePolling = false;
    }

    // 再生成のキュー。画像ごとに元のカット案へ 1 枚ずつ作る。カット案が削除された画像は飛ばし、全部飛ばしたらエラーにする
    async function runRegen(p, run, x, title) {
        x.status = "waiting";
        run.current = x;
        let made = 0;
        for (const [j, image] of x.images.entries()) {
            if (run.abort) break;
            run.step = j + 1;
            renderQueueManager();
            const cut = cutsOf(p).find((c) => c.id === image.cutId);
            startToast(title, `${x.name}・再生成 ${j + 1}/${x.images.length}・${cut ? cut.title : "（削除済み）"}`, stopQueues);
            if (!cut) continue;
            await window.PolarisStudio.generate({
                project: p.id, cut: cut.id, source: x.name,
                positive: image.positive, negative: image.negative,
                steps: x.steps, batch: 1, seed: image.seed, subseed: image.subseed, subseedStrength: image.subseedStrength,
                width: image.width, height: image.height,
            });
            made++;
        }
        run.current = null;
        run.step = 0;
        if (run.abort) return;
        if (made) {
            x.status = "done";
        } else {
            x.status = "error";
            if (!x.name.endsWith(QUEUE_CUT_GONE)) x.name += QUEUE_CUT_GONE;
        }
    }

    // 順に実行する。カット案が削除されていたキューは飛ばして、名前にエラーを付ける
    async function runQueues(list) {
        if (generating || !list.length) return;
        const p = project;
        const run = {abort: false};
        queueRun = run;
        generating = true;
        imageShownCount = countImages(p);
        const progress = q(".ps-queues-progress");
        window.PolarisStudio.onProgress((text, info) => {
            progress.textContent = text;
            updateToast(info);
            pollImages(p);
        });
        renderQueueManager();
        let failure = "";
        for (const [i, x] of list.entries()) {
            if (run.abort) break;
            if (x.kind === "regen") {
                try {
                    await runRegen(p, run, x, `キュー ${i + 1}/${list.length}`);
                } catch (e) {
                    console.error("[Polaris Studio] queue failed", e);
                    failure = e.message;
                    run.current = null;
                    break;
                }
                renderQueueManager();
                await saveProjects();
                continue;
            }
            const cut = cutsOf(p).find((c) => c.id === x.cutId);
            startToast(`キュー ${i + 1}/${list.length}`, `${x.name}・${x.cutTitle}`, stopQueues);
            if (!cut) {
                x.status = "error";
                if (!x.name.endsWith(QUEUE_CUT_GONE)) x.name += QUEUE_CUT_GONE;
            } else {
                x.status = "waiting";
                run.current = x;
                renderQueueManager();
                try {
                    await window.PolarisStudio.generate({
                        project: p.id, cut: x.cutId, source: x.name,
                        positive: x.positive, negative: x.negative, width: x.width, height: x.height,
                        steps: x.steps, batch: x.batch, seed: x.seed, subseed: x.subseed, subseedStrength: x.subseedStrength,
                    });
                    if (!run.abort) x.status = "done";
                    // サイズを決めずに登録したキューなら、カット案に生成した画像のサイズを覚える
                    if (!(x.width && x.height) && !(cut.width && cut.height)) {
                        await loadImages(p).then(() => adoptSize(p, cut), () => {});
                    }
                } catch (e) {
                    console.error("[Polaris Studio] queue failed", e);
                    failure = e.message;
                    run.current = null;
                    break;
                }
            }
            run.current = null;
            renderQueueManager();
            await saveProjects();
        }
        window.PolarisStudio.onProgress(null);
        queueRun = null;
        generating = false;
        queueChecked = new Set();
        progress.textContent = failure ? "中断しました: " + failure : run.abort ? "中止しました" : "完了しました";
        endToast(`キュー ${list.length} 件`, progress.textContent, !failure && !run.abort);
        try {
            await loadImages(p);
        } catch (e) {
            console.error("[Polaris Studio] load images failed", e);
        }
        if (project === p) {
            renderQueueManager();
            refreshViews();
        }
        await saveProjects();
    }

    // ---------- サムネイル一覧 ----------

    let galleryCut = null;
    let galleryInline = true;           // カット案の下に開いたか（false はプロンプト編集の上に窓で開いたとき）
    // 選択中の画像（"カット案の id/画像の名前"）。カット案をまたいで選べるよう、別のカット案の一覧を開いても残す
    const selectedImages = new Set();
    const selKey = (cut, name) => cut.id + "/" + name;
    const selCutId = (key) => key.slice(0, key.indexOf("/"));
    const selName = (key) => key.slice(key.indexOf("/") + 1);
    // そのカット案で選んでいる画像の名前
    const selectedOf = (cut) => [...selectedImages].filter((k) => selCutId(k) === cut.id).map(selName);

    let selectAnchor = "";              // Shift+クリックの範囲選択の起点となる画像の名前

    // 一覧はカット案のあるシーンの下にインラインで開く。
    // プロンプト編集から開いたとき（カット案の画面が隠れているとき）だけは、これまでどおり全画面の窓で開く
    async function openGallery(cut) {
        const view = q(".ps-gallery-view");
        const wasOpen = isOpen(".ps-gallery-view");
        const oldScene = wasOpen && sceneOf(galleryCut);
        // 折りたたんだシーンのカット案（編集画面から開いたときなど）は、シーンを開いてから一覧を出す
        const scene = sceneOf(cut);
        if (scene && foldedScenes.has(scene.id)) toggleScene(scene);
        galleryCut = cut;
        galleryInline = !root.classList.contains("ps-off");
        selectAnchor = "";
        q(".ps-gallery-search").value = "";
        q(".ps-gallery-source").value = "";
        q(".ps-gallery-fav").checked = false;
        await loadImages(project);
        renderGallery();
        view.classList.remove("ps-off");
        refreshViews();
        if (view.classList.contains("mtm-fs-window")) return;
        q(".ps-gallery").scrollTop = 0;
        // 開くとき（別のシーンへ移るときも）はニョキッと伸ばす
        if (!wasOpen || oldScene !== sceneOf(cut)) {
            view.classList.remove("ps-grow");
            void view.offsetWidth;
            view.classList.add("ps-grow");
        }
        view.scrollIntoView({block: "nearest", behavior: "smooth"});
    }

    function closeGallery() {
        closeRegenForm();
        hide(".ps-gallery-view");
        galleryCut = null;
        refreshViews();
        window.PolarisStudio.reloadEditor();
    }

    function toggleGallery(cut) {
        if (galleryCut === cut && isOpen(".ps-gallery-view")) closeGallery();
        else openGallery(cut);
    }

    const sceneOf = (cut) => project && project.scenes.find((s) => s.cuts.includes(cut));

    // 一覧を置く場所を決める。カット案の画面を作り直すたびに呼ぶ
    function placeGallery() {
        const view = q(".ps-gallery-view");
        if (!isOpen(".ps-gallery-view")) return;
        const inline = galleryInline;
        view.classList.toggle("mtm-fs-window", !inline);
        view.classList.toggle("ps-gallery-inline", inline);
        q(".ps-gallery-back").textContent = inline ? "▲ 閉じる" : "← 戻る";
        if (!inline) {
            if (view.parentElement !== overlay) overlay.prepend(view);
            return;
        }
        const scene = sceneOf(galleryCut);
        const body = scene && q(`.ps-scene[data-scene="${scene.id}"] .ps-scene-body`);
        if (!body) {
            // カット案が消えたら閉じる
            view.classList.add("ps-off");
            galleryCut = null;
            return;
        }
        // 置き直すと中のスクロール位置が戻ってしまうので、覚えておいて戻す
        const gallery = q(".ps-gallery");
        const top = gallery.scrollTop;
        if (view.parentElement !== body) body.appendChild(view);
        gallery.scrollTop = top;
        markOpenCut();
    }

    // 開いているカット案のカードに印を付けて、一覧の上の三角をそのカードに向ける
    function markOpenCut() {
        const view = q(".ps-gallery-view");
        root.querySelectorAll(".ps-cut.ps-open").forEach((c) => c.classList.remove("ps-open"));
        if (!galleryCut || !view.classList.contains("ps-gallery-inline")) return;
        const card = root.querySelector(`.ps-cut[data-cut="${galleryCut.id}"]`);
        if (!card) return;
        card.classList.add("ps-open");
        const c = card.getBoundingClientRect();
        const v = view.getBoundingClientRect();
        view.style.setProperty("--ps-arrow-x", Math.round(c.left + c.width / 2 - v.left) + "px");
    }

    function sourceKind(image) {
        if (image.source === "preview") return "preview";
        if (image.source.startsWith("i2i:")) return "i2i";
        return image.source ? "queue" : "";
    }

    function visibleImages() {
        const word = q(".ps-gallery-search").value.trim().toLowerCase();
        const source = q(".ps-gallery-source").value;
        const favOnly = q(".ps-gallery-fav").checked;
        return imagesOf(project, galleryCut).filter((x) => {
            if (source && sourceKind(x) !== source) return false;
            if (favOnly && !isFavorite(galleryCut, x.name)) return false;
            return !word || [x.prompt, x.negative, x.seed, x.steps, x.sampler, x.model, x.source, x.name].join(" ").toLowerCase().includes(word);
        });
    }

    function renderGallery() {
        const cut = galleryCut;
        const total = imagesOf(project, cut).length;
        const list = visibleImages();
        // 絞り込みで見えなくなった画像は選択から外す（ほかのカット案の選択はそのまま）
        for (const name of selectedOf(cut)) {
            if (!list.some((x) => x.name === name)) selectedImages.delete(selKey(cut, name));
        }
        q(".ps-gallery-title").textContent = cut.title;
        q(".ps-gallery-count").textContent = list.length === total ? `${total} 枚` : `${list.length} / ${total} 枚`;
        renderSelectionCount(list.length);

        const key = keyImageOf(project, cut);
        const thumbs = q(".ps-gallery-thumbs");
        thumbs.textContent = "";
        const emptyText = !total ? "まだ画像がありません"
            : q(".ps-gallery-fav").checked && !(cut.favorites || []).length ? "お気に入りの画像はまだありません。ビューワーの「♡ お気に入り」（F キー）で付けられます"
            : "条件に合う画像がありません";
        if (!list.length) thumbs.appendChild(el("div", {class: "mtm-empty", text: emptyText}));
        for (const image of list) {
            thumbs.appendChild(makeThumb(project, cut, image, {
                selected: selectedImages.has(selKey(cut, image.name)),
                mark: image === key ? "キー" : "",
                panels: panelPages(selKey(cut, image.name), project.books, true),
                onclick: (e) => (e.shiftKey ? selectRange(image.name) : openViewer(image)),
                select(e) {
                    if (e.shiftKey) return selectRange(image.name);
                    const k = selKey(cut, image.name);
                    if (selectedImages.has(k)) selectedImages.delete(k);
                    else selectedImages.add(k);
                    selectAnchor = image.name;
                    renderGallery();
                },
            }));
        }
    }

    // 「すべて選択」は開いているカット案の分、削除と再生成の枚数はカット案をまたいだ選択全体
    function renderSelectionCount(visible) {
        const mine = selectedOf(galleryCut).length;
        const total = selectedImages.size;
        const all = q(".ps-gallery-all");
        all.checked = visible > 0 && mine === visible;
        all.indeterminate = mine > 0 && mine < visible;
        const cuts = new Set([...selectedImages].map(selCutId)).size;
        const info = q(".ps-gallery-selinfo");
        info.textContent = cuts > 1 || (total && !mine) ? `選択 ${total} 枚・${cuts} カット案` : "";
        q(".ps-gallery-clear").disabled = total === 0;
        const regen = q(".ps-gallery-regen");
        regen.textContent = `再生成（${total}枚）`;
        regen.disabled = total === 0;
        const del = q(".ps-gallery-delete");
        del.textContent = `選択を削除（${total}枚）`;
        del.disabled = total === 0;
        updateSelBadges();
    }

    // 起点から指定の画像までを選択に加える。起点がなければその1枚だけ
    function selectRange(name) {
        const names = visibleImages().map((x) => x.name);
        const to = names.indexOf(name);
        let from = names.indexOf(selectAnchor);
        if (from < 0) from = to;
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) selectedImages.add(selKey(galleryCut, names[i]));
        selectAnchor = name;
        renderGallery();
    }

    // ドラッグで囲んだ画像を選択に加える。選択済みの画像から始めたときは選択から外す
    function setupDragSelect() {
        const gallery = q(".ps-gallery");
        let drag = null;
        let justDragged = false;

        const point = (e) => {
            const r = gallery.getBoundingClientRect();
            return {x: e.clientX - r.left + gallery.scrollLeft, y: e.clientY - r.top + gallery.scrollTop};
        };

        function update() {
            const {start, end, box, base, remove, thumbs} = drag;
            const left = Math.min(start.x, end.x), top = Math.min(start.y, end.y);
            const right = Math.max(start.x, end.x), bottom = Math.max(start.y, end.y);
            Object.assign(box.style, {left: left + "px", top: top + "px", width: right - left + "px", height: bottom - top + "px"});
            const r = gallery.getBoundingClientRect();
            selectedImages.clear();
            base.forEach((n) => selectedImages.add(n));
            for (const thumb of thumbs) {
                const t = thumb.getBoundingClientRect();
                const tl = t.left - r.left + gallery.scrollLeft, tt = t.top - r.top + gallery.scrollTop;
                const hit = tl < right && tl + t.width > left && tt < bottom && tt + t.height > top;
                const k = selKey(galleryCut, thumb.dataset.name);
                if (hit) {
                    if (remove) selectedImages.delete(k);
                    else selectedImages.add(k);
                }
                const on = selectedImages.has(k);
                thumb.classList.toggle("ps-selected", on);
                const check = thumb.querySelector(".ps-thumb-check");
                if (check) check.textContent = on ? "✓" : "";
            }
            renderSelectionCount(thumbs.length);
        }

        // 端に近づいたら自動でスクロールする
        function autoScroll() {
            if (!drag) return;
            const r = gallery.getBoundingClientRect();
            const edge = 40;
            let dy = 0;
            if (drag.clientY < r.top + edge) dy = -Math.ceil((r.top + edge - drag.clientY) / 3);
            else if (drag.clientY > r.bottom - edge) dy = Math.ceil((drag.clientY - (r.bottom - edge)) / 3);
            if (dy && drag.box.isConnected) {
                gallery.scrollTop += dy;
                drag.end = point({clientX: drag.clientX, clientY: drag.clientY});
                update();
            }
            drag.frame = requestAnimationFrame(autoScroll);
        }

        function move(e) {
            drag.clientX = e.clientX;
            drag.clientY = e.clientY;
            if (!drag.box.isConnected) {
                if (Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < 5) return;
                gallery.appendChild(drag.box);
                drag.frame = requestAnimationFrame(autoScroll);
            }
            drag.end = point(e);
            update();
        }

        function up() {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            cancelAnimationFrame(drag.frame);
            if (drag.box.isConnected) {
                drag.box.remove();
                justDragged = true;
                setTimeout(() => (justDragged = false), 0);
                renderGallery();
            }
            drag = null;
        }

        gallery.addEventListener("mousedown", (e) => {
            if (e.button !== 0 || drag || e.target.closest(".mtm-empty")) return;
            e.preventDefault();   // 文字や画像のドラッグを始めない
            const startThumb = e.target.closest(".ps-thumb");
            drag = {
                downX: e.clientX, downY: e.clientY, clientX: e.clientX, clientY: e.clientY,
                start: point(e), end: point(e),
                box: el("div", {class: "ps-drag-box"}),
                base: new Set(selectedImages),
                remove: !!startThumb && selectedImages.has(selKey(galleryCut, startThumb.dataset.name)),
                thumbs: [...gallery.querySelectorAll(".ps-thumb")],
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
        });

        // ドラッグの終わりに起きるクリックでビューワーなどを開かない
        gallery.addEventListener("click", (e) => {
            if (!justDragged) return;
            e.stopPropagation();
            e.preventDefault();
        }, true);
    }

    function askDeleteSelected() {
        askDeleteImages([...selectedImages], "選択した画像を削除");
    }

    // keys は selKey の形。カット案をまたいでいれば、それぞれのフォルダから消す
    function askDeleteImages(keys, title) {
        const cutIds = [...new Set(keys.map(selCutId))];
        const where = cutIds.length === 1 ? pathOf(project.id, cutIds[0]) : pathOf(project.id) + `（${cutIds.length} カット案）`;
        askDelete(title, `${keys.length} 枚を実ファイルごと削除します。${undoNote()}` + bookWarning(keys), where, () => deleteImages(keys));
    }

    async function deleteImages(keys) {
        const byCut = new Map();
        for (const k of keys) byCut.set(selCutId(k), [...(byCut.get(selCutId(k)) || []), selName(k)]);
        try {
            for (const [cutId, names] of byCut) {
                await postJson("polaris-studio/images/delete", {project: project.id, cut: cutId, names});
            }
            await loadImages(project);
        } catch (e) {
            alert("画像の削除に失敗しました。\n" + e);
            return;
        }
        for (const cut of cutsOf(project)) {
            if ((byCut.get(cut.id) || []).includes(cut.keyImage)) cut.keyImage = "";
        }
        keys.forEach((k) => selectedImages.delete(k));
        removeFromBooks((r) => keys.includes(refKey(r)));
        removeFavorites(keys);
        renderGallery();
        refreshViews();
        if (isOpen(".ps-viewer")) {
            // 前後の移動に使う一覧も作り直す。古い一覧のままだと、消した画像に戻れてしまう
            const index = viewIndex;
            viewList = viewEntries();
            const next = viewList[Math.min(index, viewList.length - 1)];
            if (next) showImage(next.image, next.cut);
            else hide(".ps-viewer");
        }
        await saveProjects();
    }

    // ---------- 単体ビューワー ----------

    // 前後に移動する画像の並び（{cut, image}）。絞り込み中は絞り込み結果
    let viewList = [];
    let viewImage = null;
    let viewCut = null;     // 表示中の画像のカット案
    let viewIndex = 0;
    let zoom = 1;
    let fitting = true;

    // 「情報」を出しているかはブラウザに覚えておき、次に開くときも同じ状態で開く
    const VIEWER_INFO_KEY = "polaris-studio:viewer-info";
    const VIEWER_DBLCLICK_GUARD = 600;  // 開いてからこの時間（ミリ秒）はダブルクリックで閉じない
    let viewerOpenedAt = 0;

    function setViewerInfo(on) {
        q(".ps-viewer-info").classList.toggle("ps-off", !on);
        q(".ps-view-info").classList.toggle("mtm-active", on);
        applyZoom();
    }

    const viewEntries = () => visibleImages().map((image) => ({cut: galleryCut, image}));

    const isEntry = (x, cut, image) => x.cut.id === cut.id && x.image.name === image.name;

    function openViewer(image, cut = galleryCut) {
        viewList = viewEntries();
        let info = false;
        try {
            info = localStorage.getItem(VIEWER_INFO_KEY) === "1";
        } catch (e) { /* 読めなければ閉じた状態で開く */ }
        viewerOpenedAt = Date.now();
        q(".ps-viewer").classList.remove("ps-off");
        setViewerInfo(info);
        showImage(image, cut);
    }

    // 編集画面の上段のサムネイルから開く。一覧は閉じたまま、絞り込みなしでそのカット案の画像を前後に移動する
    function openViewerFor(cut, image) {
        galleryCut = cut;
        q(".ps-gallery-search").value = "";
        q(".ps-gallery-source").value = "";
        q(".ps-gallery-fav").checked = false;
        openViewer(image);
    }

    function showImage(image, cut = viewCut) {
        viewCut = cut;
        // 生成中に画像の一覧を読み直すと、同じ画像でも別のオブジェクトになる。名前で今の一覧のものに合わせる
        image = imagesOf(project, cut).find((x) => x.name === image.name) || image;
        viewImage = image;
        viewIndex = viewList.findIndex((x) => isEntry(x, cut, image));
        if (viewIndex < 0) {
            viewList = viewEntries();
            viewIndex = viewList.findIndex((x) => isEntry(x, cut, image));
        }
        const key = keyImageOf(project, cut);
        const isKey = !!key && key.name === image.name;
        const number = imagesOf(project, cut).findIndex((x) => x.name === image.name) + 1;
        const where = `${cut.title}  ${number} / ${imagesOf(project, cut).length}`;
        q(".ps-viewer-name").textContent = where + (isKey ? "  （キー画像）" : "");
        q(".ps-nav-prev").disabled = viewIndex <= 0;
        q(".ps-nav-next").disabled = viewIndex >= viewList.length - 1;
        const keyButton = q(".ps-view-key");
        keyButton.disabled = isKey;
        keyButton.classList.toggle("ps-view-key-on", isKey);
        keyButton.textContent = isKey ? "キー画像" : "キー画像に指定";
        q(".ps-view-restore").disabled = !image.prompt;
        renderViewMarks();
        renderImageInfo(image);
        fitting = true;
        const url = imageUrl(project, cut, image, false);
        const img = q(".ps-viewer-image");
        if (img.getAttribute("src") === url) applyZoom();
        else img.src = url;
    }

    // 名前の右に、コマで使っている印とお気に入りの印を出す（サムネイルと同じもの）。お気に入りのボタンの表示もそろえる
    function renderViewMarks() {
        const key = selKey(viewCut, viewImage.name);
        const panels = panelPages(key, project.books, true);
        const fav = isFavorite(viewCut, viewImage.name);
        const box = q(".ps-viewer-marks");
        box.textContent = "";
        if (panels.length) box.appendChild(panelMark(panels));
        if (fav) box.appendChild(favoriteMark());
        const button = q(".ps-view-fav");
        button.textContent = fav ? "♥ お気に入り" : "♡ お気に入り";
        button.classList.toggle("ps-view-fav-on", fav);
    }

    async function toggleViewFavorite() {
        if (!viewImage || !viewCut) return;
        const done = toggleFavorite(viewCut, viewImage.name);
        renderViewMarks();
        await done;
    }

    function renderImageInfo(image) {
        const rows = [
            ["カット案", viewCut.title], ["識別子", viewCut.id], ["ファイル", image.name],
            ["プロンプト", image.prompt], ["ネガティブ", image.negative], ["Steps", image.steps],
            ["Sampler", image.sampler], ["Seed", image.seed], ["サイズ", image.size], ["モデル", image.model],
        ];
        const box = q(".ps-viewer-info");
        box.textContent = "";
        for (const [label, value] of rows) {
            box.appendChild(el("div", {class: "ps-info-label", text: label}));
            box.appendChild(el("div", {class: "ps-info-value", text: value || "—"}));
        }
    }

    function applyZoom() {
        const img = q(".ps-viewer-image");
        const stage = q(".ps-viewer-stage");
        if (!img.naturalWidth) return;
        if (fitting) zoom = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
        img.style.width = Math.round(img.naturalWidth * zoom) + "px";
        img.style.height = Math.round(img.naturalHeight * zoom) + "px";
        q(".ps-viewer-size").textContent = Math.round(zoom * 100) + "%";
    }

    function setZoom(value) {
        fitting = false;
        zoom = Math.min(Math.max(value, ZOOM_MIN), ZOOM_MAX);
        applyZoom();
    }

    function moveImage(delta) {
        const next = viewList[viewIndex + delta];
        if (next) showImage(next.image, next.cut);
    }

    // 画像が枠に収まっている間はホイールで前後に移動し、はみ出す大きさならスクロールする
    function wheelViewer(e) {
        const stage = q(".ps-viewer-stage");
        if (stage.scrollHeight > stage.clientHeight || stage.scrollWidth > stage.clientWidth) return;
        e.preventDefault();
        moveImage(e.deltaY > 0 ? 1 : -1);
    }

    // この画像の生成情報のプロンプトをカット案に戻す
    async function restorePromptFromImage() {
        const cut = viewCut;
        const image = viewImage;
        // 編集画面から開いたときは保存せず、プロンプト欄に入れるだけにする（保存は編集画面で行う）
        if (window.PolarisStudio.isEditing(cut)) {
            window.PolarisStudio.setEditorPrompt(image.prompt, image.negative);
            // 戻した結果が見えるよう、ビューワーを閉じて編集画面に戻る
            hide(".ps-viewer");
            return;
        }
        if (image.prompt === cut.positive && image.negative === cut.negative) return;
        cut.history.unshift({at: new Date().toISOString(), positive: cut.positive, negative: cut.negative});
        cut.positive = image.prompt;
        cut.negative = image.negative;
        refreshViews();
        await saveProjects();
    }

    // ---------- i2i（インペイント） ----------
    // ビューワーの画像を WebUI のインペイントに送る。そこで生成した画像は、解除するまで元のカット案のフォルダに保存する

    async function sendToImg2img() {
        const image = viewImage;
        const cut = viewCut;
        let target;
        try {
            const res = await fetch(imageUrl(project, cut, image, false));
            if (!res.ok) throw new Error(res.status);
            const blob = await res.blob();
            switch_to_inpaint();
            const box = gradioApp().querySelector("#img2maskimg");
            const clear = box && box.querySelector("button[aria-label='Clear'], button[aria-label='Remove Image']");
            if (clear) clear.click();
            await new Promise((resolve) => setTimeout(resolve, 200));
            const input = box && box.querySelector("input[type=file]");
            if (!input) throw new Error("インペイントの画像欄が見つかりません");
            const files = new DataTransfer();
            files.items.add(new File([blob], image.name, {type: blob.type || "image/png"}));
            input.files = files.files;
            input.dispatchEvent(new Event("change", {bubbles: true}));
            // 「元のプロンプトで再生成」が目的なので、カット案ではなくこの画像の生成情報のプロンプトを使う
            const size = (image.size || "").match(/^(\d+) x (\d+)$/);
            window.PolarisStudio.writeImg2img({
                positive: image.prompt || cut.positive,
                negative: image.negative || cut.negative,
                width: size ? Number(size[1]) : 0,
                height: size ? Number(size[2]) : 0,
            });
            target = (await postJson("polaris-studio/i2i", {
                project: project.id, cut: cut.id, source: "i2i:" + image.name, label: `${project.title} / ${cut.title}`,
            })).target;
        } catch (e) {
            console.error("[Polaris Studio] send to img2img failed", e);
            alert("インペイントに送れませんでした。\n" + e);
            return;
        }
        renderI2iBanner(target);
        // サムネイル一覧を開いたまま隠す。Alt+P か帯のボタンで戻ると、生成した画像が並んでいる
        hide(".ps-viewer");
        suspended = true;
        setVisible(false);
    }

    // img2img の画面の上に、保存先のカット案と解除ボタンを出す
    let i2iBanner = null;

    function renderI2iBanner(target) {
        const tab = gradioApp().querySelector("#tab_img2img");
        if (!tab) return;
        if (!i2iBanner) {
            i2iBanner = el("div", {class: "ps-i2i-banner"}, [
                el("span", {class: "ps-i2i-text"}),
                el("button", {type: "button", class: "ps-i2i-back", text: "ポラスタに戻る", onclick: toggle}),
                el("button", {type: "button", class: "ps-i2i-clear", text: "解除", title: "生成した画像を通常の出力先に保存するように戻す", onclick: clearI2i}),
            ]);
        }
        if (!i2iBanner.isConnected) tab.prepend(i2iBanner);
        i2iBanner.classList.toggle("ps-off", !target);
        if (target) i2iBanner.querySelector(".ps-i2i-text").textContent = `ポラスタ：${target.label} に保存中（元画像 ${target.source.replace(/^i2i:/, "")}）`;
    }

    async function clearI2i() {
        try {
            await postJson("polaris-studio/i2i/clear", {});
        } catch (e) {
            alert("解除できませんでした。\n" + e);
            return;
        }
        renderI2iBanner(null);
    }

    async function loadI2i() {
        try {
            const res = await fetch("polaris-studio/i2i", {cache: "no-store"});
            const data = await res.json();
            renderI2iBanner(data.target);
        } catch (e) {
            console.error("[Polaris Studio] i2i state failed", e);
        }
    }

    // ---------- プロンプト編集 ----------

    function openEditor(cut) {
        // インラインのサムネイル一覧は閉じておく。編集画面の上段の画像からビューワーを開くと、一覧の対象が切り替わるため
        if (isOpen(".ps-gallery-view")) {
            q(".ps-gallery-view").classList.add("ps-off");
            galleryCut = null;
            refreshViews();
        }
        root.classList.add("ps-off");
        window.PolarisStudio.openEditor({
            project,
            cut,
            onChange: saveProjects,
            onPreview: runPreview,
            // 編集画面からは、画面の上の「キュー」ボタンの下にパネルを出す
            onQueue: (c) => openQueueForm(c, fs.querySelector(".mtm-fs-queue")),
            onQueues: toggleQueueManager,
            images: () => imagesOf(project, cut),
            thumbUrl: (image) => imageUrl(project, cut, image, true),
            keyImage: () => keyImageOf(project, cut),
            openImage: (image) => openViewerFor(cut, image),
            onClose() {
                closeQueueForm();
                closeQueueManager();
                root.classList.remove("ps-off");
                renderScenes();
                fs.focus();
            },
        });
    }

    // ---------- 削除の確認 ----------

    const DELETE_WORD = "DELETE";
    let deleteWord = "";    // 削除の前に入力してもらう語（"" なら入力なしで削除できる）

    // word を渡すと、その語を入力するまで「削除」を押せない（マウスだけで削除してしまわないように）
    function askDelete(title, text, path, run, word = "") {
        q(".ps-delete-title").textContent = title;
        q(".ps-delete-text").textContent = text;
        q(".ps-delete-path").textContent = path;
        pendingDelete = run;
        deleteWord = word;
        const input = q(".ps-delete-word");
        input.value = "";
        input.placeholder = word;
        q(".ps-delete-confirm-text").textContent = `確認のため、半角大文字で ${word} と入力してください。`;
        q(".ps-delete-confirm").classList.toggle("ps-off", !word);
        updateDeleteOk();
        q(".ps-delete-dialog").classList.remove("ps-off");
        if (word) input.focus();
    }

    function updateDeleteOk() {
        q(".ps-delete-ok").disabled = !!deleteWord && q(".ps-delete-word").value !== deleteWord;
    }

    function runDelete() {
        const run = pendingDelete;
        if (!run || q(".ps-delete-ok").disabled) return;
        closeDeleteDialog();
        run();
    }

    function closeDeleteDialog() {
        hide(".ps-delete-dialog");
        pendingDelete = null;
        deleteWord = "";
    }

    // ごみ箱に移せるなら、そこから戻せると伝える
    const undoNote = () => canTrash ? "画像はごみ箱に移ります（ごみ箱から戻せます）。" : "元に戻せません。";
    const backupNote = () => canTrash
        ? "画像は次の保存場所からごみ箱に移ります。プロジェクトの内容は data/backups/ に控えが残ります。"
        : "元に戻せません。必要な画像は、次の保存場所から先にバックアップを取ってください。";

    function askDeleteCut(scene, cut) {
        const count = imagesOf(project, cut).length;
        const warning = bookWarning(imagesOf(project, cut).map((x) => selKey(cut, x.name)));
        askDelete(`カット案「${cut.title}」を削除`, `画像 ${count} 枚を実ファイルごと削除します。${backupNote()}${warning}`, pathOf(project.id, cut.id), async () => {
            try {
                await postJson("polaris-studio/folder/delete", {project: project.id, cut: cut.id});
            } catch (e) {
                alert("カット案の画像を削除できませんでした。\n" + e);
                return;
            }
            scene.cuts.splice(scene.cuts.indexOf(cut), 1);
            removeFromBooks((r) => r.cutId === cut.id);
            for (const k of [...selectedImages]) if (selCutId(k) === cut.id) selectedImages.delete(k);
            renderScenes();
            loadI2i();  // 消したカット案への img2img の保存はサーバーで解除される
            await saveProjects();
        });
    }

    // プロジェクト一覧から呼ぶ。p は削除するプロジェクト
    function askDeleteProject(p) {
        const cuts = cutsOf(p);
        const count = cuts.reduce((n, c) => n + imagesOf(p, c).length, 0);
        const books = (p.books || []).length;
        const bookNote = books ? `\n⚠ Book ${books} 件も一緒に削除されます。` : "";
        askDelete(`プロジェクト「${p.title}」を削除`, `カット案 ${cuts.length} 件と画像 ${count} 枚を実ファイルごと削除します。${backupNote()}${bookNote}`, pathOf(p.id), async () => {
            try {
                await postJson("polaris-studio/folder/delete", {project: p.id});
            } catch (e) {
                alert("プロジェクトの画像を削除できませんでした。\n" + e);
                return;
            }
            projects.splice(projects.indexOf(p), 1);
            projectImages.delete(p.id);
            renderList();
            loadI2i();
            await saveProjects();
        }, DELETE_WORD);
    }

    // ---------- 画像のドロップ ----------

    let imageDropTimer = null;

    const hasFiles = (e) => !dragging && e.dataTransfer && [...e.dataTransfer.types].includes("Files");

    // 開いているサムネイル一覧の上には落とせない（ブラウザが画像を開いてしまわないよう、受け取って捨てる）
    const onGallery = (e) => !!e.target.closest(".ps-gallery-view");

    function dragOverProject(e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (onGallery(e)) {
            e.dataTransfer.dropEffect = "none";
            endImageDrag();
            return;
        }
        e.dataTransfer.dropEffect = "copy";
        q(".ps-image-drop").classList.remove("ps-off");
        clearDrop();
        const row = e.target.closest(".ps-scene");
        if (row) row.classList.add("ps-drop");
        // dragleave は子要素の出入りでも飛ぶので、dragover が途切れたら消す
        clearTimeout(imageDropTimer);
        imageDropTimer = setTimeout(endImageDrag, 150);
    }

    function endImageDrag() {
        q(".ps-image-drop").classList.add("ps-off");
        clearDrop();
    }

    async function dropOnProject(e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        clearTimeout(imageDropTimer);
        endImageDrag();
        if (onGallery(e)) return;
        const row = e.target.closest(".ps-scene");
        const scene = project.scenes.find((s) => row && s.id === row.dataset.scene) || project.scenes[project.scenes.length - 1];
        const file = e.dataTransfer.files[0];
        if (!file || !scene) return;
        try {
            const res = await fetch("polaris-studio/image-info", {method: "POST", body: file});
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || res.status);
            if (!data.info.trim()) {
                showNotice("この画像には生成情報がありません");
                return;
            }
            const p = data.params;
            const number = (value, fallback) => (Number.isFinite(Number(value)) && value !== undefined ? Number(value) : fallback);
            const cut = newCut({
                title: file.name.replace(/\.[^.]+$/, ""),
                positive: p.Prompt || "",
                negative: p["Negative prompt"] || "",
                ...(parseSize(`${p["Size-1"]}x${p["Size-2"]}`) || {}),
                steps: number(p.Steps, 50),
                seed: number(p.Seed, -1),
                subseed: number(p["Variation seed"], -1),
                subseedStrength: number(p["Variation seed strength"], 0),
            });
            const query = new URLSearchParams({project: project.id, cut: cut.id, name: file.name});
            const saved = await fetch("polaris-studio/images/upload?" + query, {method: "POST", body: file});
            if (!saved.ok) throw new Error((await saved.json()).error || saved.status);
            scene.cuts.push(cut);
            await loadImages(project);
            renderScenes();
            await saveProjects();
        } catch (err) {
            console.error("[Polaris Studio] image drop failed", err);
            showNotice("画像を読み込めませんでした: " + err.message);
        }
    }

    // ---------- 並べ替え（シーン、カット案。カット案はシーンをまたいで移動できる） ----------

    const clearDrop = () => root.querySelectorAll(".ps-drop").forEach((x) => x.classList.remove("ps-drop"));

    function startDrag(e, state, image, x = 20, y = 20) {
        dragging = state;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "");
        e.dataTransfer.setDragImage(image, x, y);
    }

    function acceptDrop(e, target) {
        e.preventDefault();
        e.stopPropagation();
        clearDrop();
        target.classList.add("ps-drop");
    }

    function dragOverScene(e, row, scene) {
        if (dragging && dragging.kind === "scene" && dragging.scene !== scene) acceptDrop(e, row);
    }

    function dragOverCuts(e, cuts) {
        if (dragging && dragging.kind === "cut") acceptDrop(e, cuts);
    }

    function dragOverCut(e, card, cut) {
        if (dragging && dragging.kind === "cut" && dragging.cut !== cut) acceptDrop(e, card);
    }

    async function finishDrop(e, move) {
        e.preventDefault();
        e.stopPropagation();
        move();
        dragging = null;
        clearDrop();
        renderScenes();
        await saveProjects();
    }

    function dropOnScene(e, scene) {
        if (!dragging || dragging.kind !== "scene" || dragging.scene === scene) return;
        const moved = dragging.scene;
        finishDrop(e, () => {
            const to = project.scenes.indexOf(scene);
            project.scenes.splice(project.scenes.indexOf(moved), 1);
            project.scenes.splice(to, 0, moved);
        });
    }

    function moveCut(toScene, index) {
        const {scene, cut} = dragging;
        scene.cuts.splice(scene.cuts.indexOf(cut), 1);
        toScene.cuts.splice(index(), 0, cut);
    }

    function dropOnCuts(e, scene) {
        if (!dragging || dragging.kind !== "cut") return;
        finishDrop(e, () => moveCut(scene, () => scene.cuts.length));
    }

    function dropOnCut(e, scene, target) {
        if (!dragging || dragging.kind !== "cut" || dragging.cut === target) return;
        const to = scene.cuts.indexOf(target);
        finishDrop(e, () => moveCut(scene, () => to));
    }

    document.addEventListener("dragend", () => {
        dragging = null;
        if (root) clearDrop();
    });

    // ページを読み直しても、img2img の保存先が残っていれば帯を出す
    onUiLoaded(loadI2i);

    window.PolarisProjects = {toggle};
})();
