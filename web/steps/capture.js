// Step 2: capture. Runs the game with the Ren'Py SDK (after the migrator trusts it) and shows each
// captured screen with its element table.

const CSS_ID = "step-capture-css";

const STATUS = {
    ok: { mark: "is-success", label: "完成" },
    needs_args: { mark: "is-warning", label: "缺少参数" },
    error: { mark: "is-danger", label: "出错" },
    missing: { mark: "", label: "仅有变体" },
    unverified: { mark: "is-warning", label: "未通过校验" },
    running: { mark: "", label: "进行中" },
    pending: { mark: "", label: "等待" },
    skipped: { mark: "", label: "未执行" },
    unreached: { mark: "", label: "未到达" },
};

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    document.head.append(h("link", { id: CSS_ID, rel: "stylesheet", href: new URL("./capture.css", import.meta.url).href }));
}

function fileUrl(gameId, rel, bust) {
    return `/api/games/${gameId}/capture/file/${encodeURIComponent(rel)}${bust ? `?v=${encodeURIComponent(bust)}` : ""}`;
}

function formatTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function rectText(r) {
    if (!r) return "";
    return r.map((v) => Math.round(v)).join(", ");
}

/** Groups results by where the player meets them. */
function groupOf(it) {
    const key = it.key;
    if (key.startsWith("save--")) return "存档";
    if (it.status === "unreached") return "未到达";
    if (key.startsWith("say--") || key.startsWith("nvl--")) return "对话";
    if (key.startsWith("choice--")) return "选项";
    if (it.branch === "menu") return "标题画面";
    return "游戏内";
}

const GROUP_ORDER = ["标题画面", "对话", "选项", "游戏内", "存档", "未到达"];

/** Puts each page state right after the screen it was reached from. */
function withStates(rows) {
    const children = new Map();
    const top = [];
    for (const it of rows) {
        if (it.via === "state" && it.parent) {
            if (!children.has(it.parent)) children.set(it.parent, []);
            children.get(it.parent).push(it);
        } else {
            top.push(it);
        }
    }
    const out = [];
    for (const it of top) {
        out.push(it);
        for (const c of children.get(it.key) || []) out.push(c);
        children.delete(it.key);
    }
    for (const rest of children.values()) out.push(...rest);
    return out;
}

function displayName(key, discover, it) {
    if (it?.via === "state") {
        const n = /--(\d+)$/.exec(key);
        return n ? `状态 ${n[1]}` : key;
    }
    const m = /^(say|nvl)--(.+)$/.exec(key);
    if (m) {
        const c = discover?.characters?.[m[2]];
        const name = c?.name && c.name !== "None" ? c.name : null;
        if (m[2] === "narrator") return "旁白";
        return name ? `${name}  ${m[2]}` : m[2];
    }
    const sv = /^save--(.+)$/.exec(key);
    if (sv) return `存档 ${sv[1]}`;
    const c = /^choice--(\d+)$/.exec(key);
    if (c) return `${c[1]} 个选项`;
    return key;
}

export async function mount(host, ctx) {
    ensureCss();
    const { game, api } = ctx;
    const gid = game.id;

    const state = {
        info: null,
        result: null,
        run: null,
        selected: null,
        screen: null,
        element: null,
        boxes: false,
        source: null,
        bust: null,
        disposed: false,
    };

    const root = h("div", { class: "cap" });
    host.append(root);

    // ---------------------------------------------------------------- data

    async function loadInfo() {
        state.info = await api.get(`/api/games/${gid}/capture`);
        state.result = state.info.result;
        state.bust = state.result?.finishedAt || null;
        if (state.info.run) {
            state.run = { ...state.info.run, done: Object.values(state.info.run.items || {}).filter((i) => i.status && !["pending", "running"].includes(i.status)).length };
            follow();
        }
    }

    function items() {
        if (state.run) {
            return (state.run.order || []).map((key) => ({ key, ...(state.run.items[key] || { status: "pending" }) }));
        }
        return state.result?.items || [];
    }

    function follow() {
        if (state.source) state.source.close();
        const es = new EventSource(`/api/games/${gid}/capture/events`);
        state.source = es;
        const onEvent = (e) => {
            const ev = JSON.parse(e.data);
            if (!state.run) state.run = { order: [], items: {}, done: 0 };
            if (ev.type === "phase") state.run.phase = ev.phase;
            if (ev.type === "start") {
                state.run.order = ev.order;
                state.run.items = Object.fromEntries(ev.order.map((k) => [k, { status: "pending" }]));
                state.run.done = 0;
            }
            if (ev.type === "item") {
                state.run.items[ev.key] = ev;
                if (ev.status === "running") state.run.current = ev.key;
                else state.run.done = (state.run.done || 0) + 1;
            }
            if (ev.type === "end") {
                es.close();
                state.source = null;
                finishRun(ev);
                return;
            }
            renderToolbar();
            renderList();
        };
        for (const type of ["phase", "start", "item", "end", "log"]) es.addEventListener(type, onEvent);
        es.addEventListener("idle", () => {
            es.close();
            state.source = null;
        });
    }

    async function finishRun(ev) {
        state.run = null;
        await loadInfo();
        await ctx.refreshGame();
        if (state.disposed) return;
        if (ev.status === "failed" && !state.result) {
            ctx.setStatus("capture", "截图失败");
        }
        render();
        if (state.selected) await select(state.selected, { keepElement: true });
    }

    // ---------------------------------------------------------------- actions

    async function ensureTrusted() {
        if (state.info.trusted) return true;
        const ok = await ctx.confirm({
            title: "在副本中运行游戏",
            message: "截图会用 Ren'Py SDK 运行该游戏的脚本，只在信任该游戏时继续。运行使用工作目录中的副本，存档写入工作目录，原游戏目录不会被修改",
            confirmText: "信任并运行",
        });
        if (!ok) return false;
        await api.post(`/api/games/${gid}/capture/trust`, { trusted: true });
        state.info.trusted = true;
        return true;
    }

    async function startRun(targets, saves) {
        if (!(await ensureTrusted())) return;
        const sdk = root.querySelector(".cap-sdk")?.value || state.info.defaultSdk;
        const sandbox = root.querySelector(".cap-sandbox input")?.checked ?? true;
        const unlock = root.querySelector(".cap-unlock input")?.checked ?? true;
        const detail = root.querySelector(".cap-detail-opt input")?.checked ?? false;
        try {
            await api.post(`/api/games/${gid}/capture/run`, { sdk, sandbox, unlock, detail, targets, saves });
        } catch (err) {
            ctx.setStatus("capture", err.message);
            return;
        }
        state.run = { order: [], items: {}, done: 0, phase: "prepare" };
        renderToolbar();
        follow();
    }

    async function cancelRun() {
        await api.post(`/api/games/${gid}/capture/cancel`);
    }

    async function pickSdk() {
        try {
            const res = await api.post("/api/capture/sdk/pick");
            if (res?.cancelled) return;
            await loadInfo();
            state.info.defaultSdk = res.sdk.path;
            render();
        } catch (err) {
            ctx.setStatus("capture", err.message);
        }
    }

    async function savesDialog() {
        let view;
        try {
            view = await api.get(`/api/games/${gid}/capture/saves`);
        } catch (err) {
            ctx.setStatus("capture", err.message);
            return;
        }
        const chosen = new Set();
        const list = h("div", { class: "cap-saves" });
        const dirLine = h("div", { class: "cap-saves-dir mono" });
        let modal = null;
        const setRunnable = () => {
            const btn = modal?.buttons?.run;
            if (btn) btn.disabled = !chosen.size;
        };
        const fill = () => {
            dirLine.textContent = view.dir ? view.dir.replace(/^\/Users\/[^/]+/, "~") : "未选择存档目录";
            list.replaceChildren();
            if (!view.saves.length) {
                list.append(h("p", { class: "cap-note" }, view.dir ? "该目录中没有存档" : "选择游戏的存档目录"));
            }
            for (const sv of view.saves) {
                const box = h("input", {
                    type: "checkbox",
                    onchange: (e) => {
                        if (e.target.checked) chosen.add(sv.file);
                        else chosen.delete(sv.file);
                        setRunnable();
                    },
                });
                list.append(h("label", { class: "cap-save" },
                    box,
                    sv.thumbnail
                        ? h("img", { src: `/api/games/${gid}/capture/saves/thumb/${encodeURIComponent(sv.file)}`, alt: "" })
                        : h("span", { class: "cap-save-noimg" }),
                    h("span", { class: "cap-save-text" },
                        h("span", {}, sv.name || sv.slot),
                        h("span", { class: "cap-row-value" }, `${sv.slot} · ${formatTime(sv.mtime)}`))));
            }
        };
        fill();
        modal = ctx.openModal({
            title: "从存档截图",
            body: h("div", {}, dirLine, list),
            width: 560,
            footer: [
                {
                    label: "选择目录",
                    variant: "secondary",
                    onClick: async () => {
                        try {
                            const res = await api.post(`/api/games/${gid}/capture/saves/pick`);
                            if (res?.cancelled) return;
                            view = res;
                            chosen.clear();
                            fill();
                            setRunnable();
                        } catch (err) {
                            dirLine.textContent = err.message;
                        }
                    },
                },
                {
                    id: "run",
                    label: "截图",
                    variant: "primary",
                    onClick: async (close) => {
                        if (!chosen.size) return;
                        close();
                        await startRun(null, [...chosen]);
                    },
                },
            ],
        });
        setRunnable();
    }

    function sdkMenu(anchor) {
        ctx.openMenu(anchor, [
            { label: "从存档截图", onSelect: savesDialog },
            "sep",
            { label: "选择 SDK 目录", onSelect: pickSdk },
            { label: state.info.trusted ? "撤回对该游戏的信任" : null, onSelect: revokeTrust },
        ].filter((i) => i === "sep" || i.label));
    }

    async function revokeTrust() {
        await api.post(`/api/games/${gid}/capture/trust`, { trusted: false });
        state.info.trusted = false;
    }

    // ---------------------------------------------------------------- render

    function renderToolbar() {
        let bar = root.querySelector(".cap-toolbar");
        const fresh = h("div", { class: "cap-toolbar" });
        const info = state.info;
        const running = Boolean(state.run);

        if (running) {
            fresh.append(h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: cancelRun }, "停止"));
            const total = state.run.order?.length || 0;
            const label = state.run.phase === "prepare" ? "正在准备副本"
                : total ? `${state.run.done || 0} / ${total}  ${state.run.current ? displayName(state.run.current, state.result?.discover) : ""}`
                : "正在启动游戏";
            fresh.append(h("span", { class: "cap-toolbar-value" }, label));
            const pct = total ? Math.round(((state.run.done || 0) / total) * 100) : 4;
            fresh.append(h("div", { class: "cap-progress" }, h("div", { class: "cap-progress-fill", style: { width: `${pct}%` } })));
        } else {
            fresh.append(h("button", {
                type: "button",
                class: "btn btn-primary btn-sm",
                disabled: !info.sdks.length,
                onclick: () => startRun(null),
            }, state.result ? "重新截图" : "开始截图"));

            if (info.sdks.length) {
                const select = h("select", { class: "select cap-sdk", "aria-label": "Ren'Py SDK" },
                    info.sdks.map((s) => h("option", { value: s.path, selected: s.path === info.defaultSdk }, `Ren'Py ${s.version || "?"}`)));
                fresh.append(select);
            }
            if (info.sandboxAvailable) {
                fresh.append(h("label", { class: "switch cap-sandbox", "data-tip": "断开网络，只允许写入工作目录" },
                    h("input", { type: "checkbox", checked: true }),
                    h("span", { class: "switch-track" }),
                    "沙盒"));
            }
            fresh.append(h("label", { class: "switch cap-unlock", "data-tip": "副本中所有图片、剧情与音频视为已解锁" },
                h("input", { type: "checkbox", checked: state.result?.options?.unlock ?? true }),
                h("span", { class: "switch-track" }),
                "全部解锁"));
            fresh.append(h("label", { class: "switch cap-detail-opt", "data-tip": "额外截取单个元素与悬停状态" },
                h("input", { type: "checkbox", checked: state.result?.options?.detail ?? false }),
                h("span", { class: "switch-track" }),
                "元素细节"));
            fresh.append(h("button", {
                type: "button",
                class: "tool-btn",
                "aria-label": "更多",
                html: ctx.icon("more"),
                onclick: (e) => sdkMenu(e.currentTarget),
            }));
        }

        fresh.append(h("span", { class: "cap-toolbar-spacer" }));
        const r = state.result;
        if (r && !running) {
            const n = r.counts?.ok || 0;
            const parts = [formatTime(r.finishedAt), `${n} 个画面`];
            if (r.counts?.unreached) parts.push(`${r.counts.unreached} 个未到达`);
            if (r.counts?.needs_args) parts.push(`${r.counts.needs_args} 个缺少参数`);
            if (r.counts?.error) parts.push(`${r.counts.error} 个出错`);
            if (r.gameSize) parts.push(r.gameSize.join("×"));
            fresh.append(h("span", { class: "cap-toolbar-value" }, parts.filter(Boolean).join(" · ")));
        }
        if (bar) bar.replaceWith(fresh);
        else root.prepend(fresh);
    }

    function renderWarnings(container) {
        const r = state.result;
        if (!r || state.run) return;
        if (r.originalUnchanged === false) {
            container.append(h("div", { class: "cap-warn" }, h("span", { class: "dot dot-danger" }), "原游戏目录在运行期间发生了变化"));
        }
        const skipped = r.splashSkipped || [];
        if (skipped.length) {
            container.append(h("div", { class: "cap-warn" }, h("span", { class: "dot dot-warning" }),
                `splashscreen 中有 ${skipped.length} 条 Python 语句未执行，截图结果可能与正常启动不同`));
        }
        if (r.status === "failed" || r.status === "cancelled") {
            container.append(h("div", { class: "cap-warn" }, h("span", { class: "dot dot-danger" }),
                r.status === "cancelled" ? "上次截图被停止，结果不完整" : "上次截图未正常结束，结果不完整"));
        }
    }

    function renderList() {
        const list = root.querySelector(".cap-list");
        if (!list) return;
        list.replaceChildren();
        const discover = state.result?.discover;
        const groups = new Map();
        const all = items();
        const parentGroup = new Map(all.map((it) => [it.key, groupOf(it)]));
        for (const it of all) {
            const g = it.via === "state" && parentGroup.has(it.parent) ? parentGroup.get(it.parent) : groupOf(it);
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(it);
        }
        for (const g of GROUP_ORDER) {
            const rows = groups.get(g);
            if (!rows) continue;
            list.append(h("div", { class: "cap-group" }, g));
            for (const it of withStates(rows)) {
                const st = STATUS[it.status] || STATUS.pending;
                list.append(h("button", {
                    type: "button",
                    class: `cap-row bar-mark ${st.mark}${it.via === "state" ? " is-state" : ""}${it.status === "unreached" ? " is-muted" : ""}`,
                    "aria-selected": state.selected === it.key ? "true" : "false",
                    onclick: () => select(it.key),
                },
                h("span", { class: "cap-row-name" }, displayName(it.key, discover, it)),
                h("span", { class: "cap-row-value" }, it.status === "ok" ? (it.stats?.states ? `${it.stats.states} 个状态` : "") : st.label)));
            }
        }
    }

    function render() {
        root.replaceChildren();
        renderToolbar();
        const info = state.info;

        if (!info.sdks.length) {
            root.append(h("div", { class: "empty-state" },
                h("div", { class: "empty-state-icon", html: ctx.icon("layers") }),
                h("p", { class: "empty-state-title" }, "未找到 Ren'Py SDK"),
                h("div", { class: "empty-state-action" },
                    h("button", { type: "button", class: "btn btn-primary", onclick: pickSdk }, "选择 SDK 目录"))));
            return;
        }

        const warn = h("div");
        renderWarnings(warn);
        if (warn.childNodes.length) root.append(warn);

        if (!items().length) {
            root.append(h("div", { class: "empty-state" },
                h("div", { class: "empty-state-icon", html: ctx.icon("layers") }),
                h("p", { class: "empty-state-title" }, state.run ? "正在启动游戏" : "尚未截图")));
            return;
        }

        const body = h("div", { class: "cap-body" },
            h("div", { class: "cap-list", role: "listbox", "aria-label": "界面" }),
            h("div", { class: "cap-detail" }));
        root.append(body);
        renderList();
        renderDetail();
    }

    async function select(key, { keepElement = false } = {}) {
        state.selected = key;
        if (!keepElement) state.element = null;
        state.screen = null;
        renderList();
        const it = items().find((i) => i.key === key);
        if (it?.status === "ok") {
            try {
                state.screen = await api.get(`/api/games/${gid}/capture/screens/${encodeURIComponent(key)}`);
            } catch {
                state.screen = null;
            }
        }
        if (state.selected !== key) return;
        renderDetail();
    }

    function renderDetail() {
        const pane = root.querySelector(".cap-detail");
        if (!pane) return;
        pane.replaceChildren();
        const key = state.selected;
        if (!key) {
            const first = items().find((i) => i.status === "ok");
            if (first) select(first.key);
            return;
        }
        const it = items().find((i) => i.key === key) || { status: "pending" };
        const discover = state.result?.discover;

        const title = it.via === "state" ? `${it.screen || it.parent}  ${displayName(key, discover, it)}` : displayName(key, discover, it);
        const head = h("div", { class: "cap-detail-head" },
            h("span", { class: "cap-detail-title" }, title));
        if (it.parent && it.via !== "state") {
            const via = !it.via ? "图片按钮" : String(it.via).startsWith("key:") ? `按键 ${String(it.via).slice(4)}` : it.via;
            head.append(h("span", { class: "cap-toolbar-value" }, `${displayName(it.parent, discover)} › ${via}`));
        } else if (it.via === "Esc") {
            head.append(h("span", { class: "cap-toolbar-value" }, "游戏中按 Esc"));
        }
        pane.append(head);

        if (it.status === "ok" && state.screen) {
            head.append(h("span", { class: "cap-toolbar-spacer" }));
            head.append(h("label", { class: "switch" },
                h("input", {
                    type: "checkbox",
                    checked: state.boxes,
                    onchange: (e) => {
                        state.boxes = e.target.checked;
                        root.querySelector(".cap-stage")?.classList.toggle("is-plain", !state.boxes);
                    },
                }),
                h("span", { class: "switch-track" }),
                "标注"));
            head.append(h("button", {
                type: "button",
                class: "btn btn-ghost btn-sm",
                disabled: Boolean(state.run),
                onclick: () => startRun([key]),
            }, "重新截取"));
            renderScreen(pane);
            return;
        }

        if (it.status === "needs_args" || it.status === "error") {
            renderFixture(pane, key, it);
            return;
        }
        if (it.status === "missing") {
            pane.append(h("p", { class: "cap-note" }, "该界面只定义了变体，当前设备不会显示"));
            return;
        }
        if (it.status === "unreached") {
            pane.append(h("p", { class: "cap-note" }, "可到达的界面上没有按钮或按键打开它，剧本也没有显示它"));
            pane.append(h("div", { class: "cap-actions" },
                h("button", {
                    type: "button",
                    class: "btn btn-secondary btn-sm",
                    disabled: Boolean(state.run),
                    onclick: () => startRun([key]),
                }, "仍然截取")));
            return;
        }
        pane.append(h("p", { class: "cap-note" }, STATUS[it.status]?.label || ""));
    }

    function renderScreen(pane) {
        const data = state.screen;
        const [gw, gh] = data.gameSize;
        const stage = h("div", { class: `cap-stage${state.boxes ? "" : " is-plain"}` },
            h("img", { src: fileUrl(gid, `screens/${data.key}/full.png`, state.bust), alt: "", width: gw, height: gh }));
        const rows = new Map();
        const boxes = new Map();

        const setHot = (n, on) => {
            boxes.get(n)?.classList.toggle("is-hot", on);
            rows.get(n)?.classList.toggle("is-hot", on);
        };

        const pick = (n) => {
            state.element = n;
            for (const [k, tr] of rows) tr.setAttribute("aria-selected", k === n ? "true" : "false");
            for (const [k, b] of boxes) b.classList.toggle("is-hot", k === n);
            renderInspect(pane, data);
        };

        for (const e of data.elements) {
            if (!e.boxed) continue;
            const [x, y, w, hgt] = e.rect;
            const box = h("div", {
                class: "cap-box",
                style: {
                    left: `${(x / gw) * 100}%`,
                    top: `${(y / gh) * 100}%`,
                    width: `${(w / gw) * 100}%`,
                    height: `${(hgt / gh) * 100}%`,
                },
                onmouseenter: () => setHot(e.n, true),
                onmouseleave: () => setHot(e.n, e.n === state.element),
                onclick: () => {
                    pick(e.n);
                    rows.get(e.n)?.scrollIntoView({ block: "nearest" });
                },
            }, h("span", { class: "cap-box-tag" }, String(e.n)));
            boxes.set(e.n, box);
            stage.append(box);
        }
        pane.append(stage);

        const tbody = h("tbody");
        for (const e of data.elements) {
            if (!e.boxed) continue;
            const what = e.label ?? e.text ?? e.info ?? e.image ?? "";
            const tr = h("tr", {
                "aria-selected": state.element === e.n ? "true" : "false",
                onmouseenter: () => setHot(e.n, true),
                onmouseleave: () => setHot(e.n, e.n === state.element),
                onclick: () => pick(e.n),
            },
            h("td", { class: "cap-num" }, String(e.n)),
            h("td", {}, e.type),
            h("td", {}, h("div", { class: "cap-cell-text" }, String(what))),
            h("td", { class: "cap-num mono" }, rectText(e.rect1920)),
            h("td", { class: "mono" }, e.style?.name || ""),
            h("td", { class: "mono" }, e.location ? `${e.location[0].replace(/^game\//, "")}:${e.location[1]}` : ""));
            rows.set(e.n, tr);
            tbody.append(tr);
        }
        pane.append(h("table", { class: "cap-table" },
            h("colgroup", {},
                h("col", { style: { width: "48px" } }),
                h("col", { style: { width: "72px" } }),
                h("col", {}),
                h("col", { style: { width: "136px" } }),
                h("col", { style: { width: "22%" } }),
                h("col", { style: { width: "18%" } })),
            h("thead", {}, h("tr", {},
                h("th", {}, "编号"), h("th", {}, "类型"), h("th", {}, "内容"),
                h("th", {}, "位置 1920"), h("th", {}, "样式"), h("th", {}, "源码"))),
            tbody));

        if (state.element) pick(state.element);
    }

    function renderInspect(pane, data) {
        pane.querySelector(".cap-inspect")?.remove();
        const e = data.elements.find((x) => x.n === state.element);
        if (!e) return;
        const crops = h("div", { class: "cap-crops" });
        if (e.crop) {
            crops.append(h("div", { class: "cap-crop" },
                h("img", { src: fileUrl(gid, `screens/${data.key}/${e.crop}`, state.bust), alt: "" }), "默认"));
        }
        if (e.hover) {
            crops.append(h("div", { class: "cap-crop" },
                h("img", { src: fileUrl(gid, `screens/${data.key}/${e.hover}`, state.bust), alt: "" }), "悬停"));
        }
        const props = h("dl", { class: "cap-props" });
        const add = (k, v) => {
            if (v === undefined || v === null || v === "") return;
            props.append(h("dt", {}, k), h("dd", { class: "mono" }, typeof v === "string" ? v : JSON.stringify(v)));
        };
        const hex = (c) => Array.isArray(c) && c.length >= 3
            ? "#" + c.slice(0, c[3] === 255 ? 3 : 4).map((x) => Number(x).toString(16).padStart(2, "0")).join("")
            : c;
        add("编号", e.n);
        add("原生位置", rectText(e.rect));
        add("1920 位置", rectText(e.rect1920));
        add("文字", e.label ?? e.text);
        add("图片", e.image ?? e.info);
        add("源码", e.location ? `${e.location[0]}:${e.location[1]}` : null);
        add("id", e.id);
        for (const [k, v] of Object.entries(e.style || {})) add(k, /color$/.test(k) ? hex(v) : v);
        const box = h("div", { class: "cap-inspect" }, crops, props);
        const table = pane.querySelector(".cap-table");
        table.before(box);
    }

    async function renderFixture(pane, key, it) {
        const screenName = key;
        if (it.status === "needs_args") {
            pane.append(h("p", { class: "cap-note" }, `缺少参数：${(it.missing || []).join("、")}`));
        } else {
            pane.append(h("p", { class: "cap-note" }, it.message || "截图出错"));
            try {
                const res = await fetch(fileUrl(gid, `errors/${key}.txt`, state.bust));
                if (res.ok) pane.append(h("pre", { class: "cap-pre" }, await res.text()));
            } catch {
                // The summary line above is enough when the file is gone.
            }
        }

        const fixtures = await api.get(`/api/games/${gid}/capture/fixtures`);
        const current = fixtures[screenName] || {
            args: Object.fromEntries((it.missing || []).map((p) => [p, null])),
            store: {},
        };
        const area = h("textarea", { class: "cap-textarea", spellcheck: "false", "aria-label": "参数" },
            JSON.stringify(current, null, 2));
        const error = h("span", { class: "field-error" });
        pane.append(h("p", { class: "cap-note" }, "参数与变量，值为 JSON；需要 Python 对象时写 {\"$eval\": \"表达式\"}"));
        pane.append(area);
        pane.append(h("div", { class: "cap-actions" },
            h("button", {
                type: "button",
                class: "btn btn-primary btn-sm",
                disabled: Boolean(state.run),
                onclick: async () => {
                    let value;
                    try {
                        value = JSON.parse(area.value);
                    } catch {
                        error.textContent = "JSON 无法解析";
                        return;
                    }
                    error.textContent = "";
                    const all = await api.get(`/api/games/${gid}/capture/fixtures`);
                    all[screenName] = value;
                    await api.put(`/api/games/${gid}/capture/fixtures`, all);
                    await startRun([key]);
                },
            }, "保存并截取"),
            error));
    }

    // ---------------------------------------------------------------- boot

    try {
        await loadInfo();
    } catch (err) {
        root.append(h("p", { class: "cap-note" }, err.message));
        return () => {};
    }
    if (state.result) {
        const n = state.result.counts?.ok || 0;
        ctx.setStatus("capture", `${n} 个界面`);
    }
    render();

    return () => {
        state.disposed = true;
        if (state.source) state.source.close();
    };
}
