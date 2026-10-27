// Step ② capture: start the game in a copy, play it, press F9 on each screen worth porting and
// type what it is for. Each shot keeps the purpose as typed, the full screen, its element table
// and the element crops chosen in the game or here.
//
// The screens step ① found that no shot covers yet are listed beside the shots, as a checklist.

import { cropGallery, openCropEditor } from "./crop-editor.js";
import { documentToggle, loadDocumentPrefs } from "./shared.js";

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

function formatTime(sec) {
    const d = new Date(sec * 1000);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const rectText = (r) => (r ? r.map((v) => Math.round(v)).join(", ") : "");

const CSS_ID = "step-capture-css";

/** This step's own stylesheet, loaded the first time the step is opened. */
function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    document.head.append(h("link", { id: CSS_ID, rel: "stylesheet", href: new URL("./capture.css", import.meta.url).href }));
}

export async function mount(host, ctx) {
    ensureCss();
    const { game, api } = ctx;
    const gid = game.id;
    const state = {
        info: null,
        sdks: null,
        screens: [],
        selected: null,
        detail: null,
        boxes: false,
        source: null,
        disposed: false,
        bust: Date.now(),
        document: { skip: {} },
    };
    const root = h("div", { class: "cap" });
    host.append(root);

    async function load() {
        const [info, cap, scan, prefs] = await Promise.all([
            api.get(`/api/games/${gid}/manual`),
            api.get(`/api/games/${gid}/capture`),
            api.get(`/api/games/${gid}/diagnose`).catch(() => ({ inventory: null })),
            loadDocumentPrefs(api, game),
        ]);
        state.document = prefs;
        state.info = info;
        state.sdks = cap;
        // The checklist: screens the game defines itself, engine internals left out.
        state.screens = (scan.inventory?.screens ?? []).filter((s) => s.defined && s.category !== "engine");
        if (info.running) follow();
    }

    function follow() {
        if (state.source) return;
        const es = new EventSource(`/api/games/${gid}/manual/events`);
        state.source = es;
        es.addEventListener("shot", async (e) => {
            const ev = JSON.parse(e.data);
            await refreshShots();
            if (!state.disposed) select(ev.key);
        });
        es.addEventListener("end", async () => {
            es.close();
            state.source = null;
            await load();
            await ctx.refreshGame();
            if (!state.disposed) render();
        });
        es.addEventListener("idle", () => {
            es.close();
            state.source = null;
        });
    }

    async function refreshShots() {
        state.info = await api.get(`/api/games/${gid}/manual`);
        renderToolbar();
        renderList();
    }

    async function ensureTrusted() {
        if (state.sdks.trusted) return true;
        const ok = await ctx.confirm({
            title: "在副本中运行游戏",
            message: "截图功能将通过 Ren'Py SDK 运行游戏脚本，仅在确认信任该游戏后继续。运行时使用工作目录中的副本，存档写入工作目录，不会修改原游戏目录",
            confirmText: "信任并运行",
        });
        if (!ok) return false;
        await api.post(`/api/games/${gid}/capture/trust`, { trusted: true });
        state.sdks.trusted = true;
        return true;
    }

    async function start() {
        if (!(await ensureTrusted())) return;
        const body = {
            sdk: root.querySelector(".cap-sdk")?.value || state.sdks.defaultSdk,
            sandbox: root.querySelector(".cap-sandbox input")?.checked ?? true,
            useSaves: root.querySelector(".cap-saves-opt input")?.checked ?? true,
            unlock: root.querySelector(".cap-unlock input")?.checked ?? false,
        };
        try {
            await api.post(`/api/games/${gid}/manual/start`, body);
        } catch (err) {
            ctx.setStatus("capture", err.message);
            return;
        }
        state.info.running = { status: "running", shots: [] };
        renderToolbar();
        follow();
    }

    async function stop() {
        await api.post(`/api/games/${gid}/manual/stop`);
    }

    async function pickSaves() {
        try {
            const res = await api.post(`/api/games/${gid}/capture/saves/pick`);
            if (res?.cancelled) return;
            await refreshShots();
        } catch (err) {
            ctx.setStatus("capture", err.message);
        }
    }

    // ---------------------------------------------------------------- render

    function switchEl(cls, label, checked, tip) {
        return h("label", { class: `switch ${cls}`, "data-tip": tip },
            h("input", { type: "checkbox", checked }),
            h("span", { class: "switch-track" }),
            label);
    }

    function renderToolbar() {
        const old = root.querySelector(".cap-toolbar");
        const bar = h("div", { class: "cap-toolbar" });
        const info = state.info;
        const sdks = state.sdks.sdks || [];
        if (info.running) {
            bar.append(h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: stop }, "结束游戏"));
            bar.append(h("span", { class: "cap-toolbar-value" }, "游戏运行中，按 F9 截图"));
        } else {
            bar.append(h("button", {
                type: "button",
                class: "btn btn-primary btn-sm",
                disabled: !sdks.length || info.busy,
                onclick: start,
            }, "启动游戏"));
            if (sdks.length) {
                bar.append(h("select", { class: "select cap-sdk", "aria-label": "Ren'Py SDK" },
                    sdks.map((s) => h("option", { value: s.path, selected: s.path === state.sdks.defaultSdk }, `Ren'Py ${s.version || "?"}`))));
            }
            if (state.sdks.sandboxAvailable) bar.append(switchEl("cap-sandbox", "沙盒", true, "断开网络连接，仅允许写入工作目录"));
            if (info.saveCount) {
                bar.append(switchEl("cap-saves-opt", `使用本地存档（${info.saveCount} 个）`, true, "存档将复制到工作目录后读取，原存档不受影响"));
            }
            // Where those saves come from: the game's own folder by default, changeable here.
            bar.append(h("button", {
                type: "button",
                class: "btn btn-quiet btn-sm",
                "data-tip": info.saveSource || "未找到存档目录",
                onclick: pickSaves,
            }, info.saveCount ? "更改存档目录" : "选择存档目录"));
            bar.append(switchEl("cap-unlock", "全部解锁", false, "副本中的所有图片、剧情及音频均视为已解锁"));
        }
        bar.append(documentToggle({ api, game, prefs: state.document, step: "capture", redraw: renderToolbar }));
        bar.append(h("span", { class: "cap-toolbar-spacer" }));
        const n = info.shots.length;
        if (n) bar.append(h("span", { class: "cap-toolbar-value" }, `${n} 张截图`));
        if (old) old.replaceWith(bar);
        else root.prepend(bar);
    }

    /** Screens the scan found that no shot shows yet. */
    function uncovered() {
        const covered = new Set();
        for (const s of state.info.shots) for (const name of s.screens || []) covered.add(name);
        return state.screens.filter((s) => !covered.has(s.name));
    }

    function renderList() {
        const list = root.querySelector(".cap-list");
        if (!list) return;
        list.replaceChildren();
        const shots = [...state.info.shots].reverse();
        if (shots.length) list.append(h("div", { class: "cap-group" }, "已截图"));
        for (const s of shots) {
            list.append(h("button", {
                type: "button",
                class: `cap-row bar-mark${s.purpose ? " is-success" : " is-warning"}`,
                "aria-selected": state.selected === s.key ? "true" : "false",
                onclick: () => select(s.key),
            },
            h("span", { class: "cap-row-name" }, s.purpose || "未填写用途说明"),
            h("span", { class: "cap-row-value" }, `${s.crops?.length ? `${s.crops.length} 切图 · ` : ""}${formatTime(s.createdAt).split(" ")[1] || ""}`)));
        }
        const rest = uncovered();
        if (rest.length) {
            list.append(h("div", { class: "cap-group" }, "已识别但尚未截图"));
            for (const sc of rest) {
                list.append(h("button", {
                    type: "button",
                    class: "cap-row is-muted",
                    "aria-selected": state.selected === `screen:${sc.name}` ? "true" : "false",
                    onclick: () => select(`screen:${sc.name}`),
                },
                h("span", { class: "cap-row-name" }, sc.name),
                h("span", { class: "cap-row-value" }, sc.category === "custom" ? "自定义" : "标准")));
            }
        }
    }

    function render() {
        root.replaceChildren();
        renderToolbar();
        if (!(state.sdks.sdks || []).length) {
            root.append(h("div", { class: "empty-state" },
                h("div", { class: "empty-state-icon", html: ctx.icon("layers") }),
                h("p", { class: "empty-state-title" }, "未找到 Ren'Py SDK")));
            return;
        }
        const last = state.info.lastSession;
        if (last && last.originalUnchanged === false) {
            root.append(h("div", { class: "cap-warn" }, h("span", { class: "dot dot-danger" }), "原游戏目录在运行期间发生了变化"));
        }
        if (!state.info.shots.length && !uncovered().length) {
            root.append(h("div", { class: "empty-state" },
                h("div", { class: "empty-state-icon", html: ctx.icon("layers") }),
                h("p", { class: "empty-state-title" }, "启动游戏后按 F9 截取需要迁移的画面")));
            return;
        }
        root.append(h("div", { class: "cap-body" },
            h("div", { class: "cap-list", role: "listbox", "aria-label": "截图" }),
            h("div", { class: "cap-detail" })));
        renderList();
        if (!state.selected && state.info.shots.length) select(state.info.shots[state.info.shots.length - 1].key);
        else renderDetail();
    }

    async function select(key) {
        state.selected = key;
        state.detail = null;
        renderList();
        if (!key.startsWith("screen:")) {
            try {
                state.detail = await api.get(`/api/games/${gid}/manual/shots/${encodeURIComponent(key)}`);
            } catch {
                state.detail = null;
            }
        }
        if (state.selected === key) renderDetail();
    }

    /** The whole screen with element boxes; the regions of saved crops are marked. */
    function stage(src, data, crops) {
        const [fw, fh] = data.gameSize;
        const el = h("div", { class: `cap-stage${state.boxes ? "" : " is-plain"}` },
            h("img", { src, alt: "", width: fw, height: fh }));
        const place = ([x, y, w, hh]) => ({
            left: `${(x / fw) * 100}%`,
            top: `${(y / fh) * 100}%`,
            width: `${(w / fw) * 100}%`,
            height: `${(hh / fh) * 100}%`,
        });
        for (const c of crops || []) el.append(h("div", { class: "cap-region", "data-crop": String(c.n), style: place(c.rect) }));
        el.append(h("div", { class: "cap-region is-focus", hidden: true }));
        for (const e of data.elements || []) {
            if (!e.boxed) continue;
            el.append(h("div", {
                class: "cap-box",
                "data-n": String(e.n),
                style: place(e.rect),
                onmouseenter: () => hot(e.n, true),
                onmouseleave: () => hot(e.n, false),
            }, h("span", { class: "cap-box-tag" }, String(e.n))));
        }
        return el;
    }

    function focusRegion(gameSize, rect) {
        const el = root.querySelector(".cap-region.is-focus");
        if (!el) return;
        el.hidden = !rect;
        if (!rect) return;
        const [fw, fh] = gameSize;
        Object.assign(el.style, { left: `${(rect[0] / fw) * 100}%`, top: `${(rect[1] / fh) * 100}%`, width: `${(rect[2] / fw) * 100}%`, height: `${(rect[3] / fh) * 100}%` });
    }

    function hot(n, on) {
        root.querySelector(`.cap-box[data-n="${n}"]`)?.classList.toggle("is-hot", on);
        root.querySelector(`tr[data-n="${n}"]`)?.classList.toggle("is-hot", on);
    }

    function table(elements) {
        const tbody = h("tbody");
        for (const e of elements) {
            if (!e.boxed) continue;
            tbody.append(h("tr", {
                "data-n": String(e.n),
                onmouseenter: () => hot(e.n, true),
                onmouseleave: () => hot(e.n, false),
            },
            h("td", { class: "cap-num" }, String(e.n)),
            h("td", {}, e.type),
            h("td", {}, h("div", { class: "cap-cell-text" }, String(e.label ?? e.text ?? e.image ?? e.info ?? ""))),
            h("td", { class: "cap-num mono" }, rectText(e.rect1920)),
            h("td", { class: "mono" }, e.style?.name || ""),
            h("td", { class: "mono" }, e.location ? `${e.location[0].replace(/^game\//, "")}:${e.location[1]}` : "")));
        }
        return h("table", { class: "cap-table" },
            h("colgroup", {},
                h("col", { style: { width: "48px" } }), h("col", { style: { width: "72px" } }), h("col", {}),
                h("col", { style: { width: "136px" } }), h("col", { style: { width: "22%" } }), h("col", { style: { width: "18%" } })),
            h("thead", {}, h("tr", {}, h("th", {}, "编号"), h("th", {}, "类型"), h("th", {}, "内容"),
                h("th", {}, "位置 1920"), h("th", {}, "样式"), h("th", {}, "源码"))),
            tbody);
    }

    function boxesSwitch() {
        return h("label", { class: "switch" },
            h("input", {
                type: "checkbox",
                checked: state.boxes,
                onchange: (e) => {
                    state.boxes = e.target.checked;
                    root.querySelector(".cap-stage")?.classList.toggle("is-plain", !state.boxes);
                },
            }),
            h("span", { class: "switch-track" }),
            "标注");
    }

    function renderDetail() {
        const pane = root.querySelector(".cap-detail");
        if (!pane) return;
        pane.replaceChildren();
        const key = state.selected;
        if (!key) return;

        if (key.startsWith("screen:")) {
            const sc = state.screens.find((x) => `screen:${x.name}` === key);
            if (!sc) return;
            const def = sc.definitions?.[0];
            pane.append(h("div", { class: "cap-detail-head" }, h("span", { class: "cap-detail-title" }, sc.name)));
            pane.append(h("p", { class: "cap-note" }, "该界面尚无截图。请在游戏中进入该界面时按 F9 截图，或确认其无需迁移"));
            const where = [
                def ? `定义于 ${def.file}:${def.line}` : null,
                sc.classification === "dialogue_like" ? "疑似台词界面" : sc.classification === "interactive" ? "可交互界面" : null,
                sc.callSites?.length ? `${sc.callSites.length} 处调用` : null,
            ].filter(Boolean);
            if (where.length) pane.append(h("p", { class: "cap-note mono" }, where.join(" · ")));
            return;
        }

        const d = state.detail;
        if (!d) return;
        const meta = d.meta;
        const data = d.elements || { gameSize: meta.gameSize, elements: [] };
        const fileUrl = (name) => `/api/games/${gid}/manual/file/${encodeURIComponent(meta.key)}/${name}?v=${state.bust}`;
        const crops = meta.crops || [];
        const head = h("div", { class: "cap-detail-head" },
            h("span", { class: "cap-detail-title" }, formatTime(meta.createdAt)),
            h("span", { class: "cap-toolbar-value" }, (meta.screens || []).join("、")),
            h("span", { class: "cap-toolbar-spacer" }),
            boxesSwitch(),
            h("button", {
                type: "button",
                class: "btn btn-secondary btn-sm",
                onclick: () => openCropEditor(ctx, {
                    imageUrl: fileUrl("full.png"),
                    gameSize: data.gameSize,
                    elements: data.elements,
                    crops,
                    onSave: async (list) => {
                        const res = await api.put(`/api/games/${gid}/manual/shots/${encodeURIComponent(meta.key)}/crops`, { crops: list });
                        state.bust = Date.now();
                        const shot = state.info.shots.find((x) => x.key === meta.key);
                        if (shot) shot.crops = res.meta.crops;
                        await select(meta.key);
                    },
                }),
            }, crops.length ? `切图 ${crops.length}` : "切图"),
            h("button", {
                type: "button",
                class: "tool-btn",
                "aria-label": "更多",
                html: ctx.icon("more"),
                onclick: (e) => ctx.openMenu(e.currentTarget, [
                    { label: "删除截图", danger: true, onSelect: () => remove(meta) },
                ]),
            }));
        pane.append(head);

        const area = h("textarea", { class: "cap-textarea cap-purpose", rows: "2", placeholder: "描述该画面在游戏中的功能及迁移时的注意事项", "aria-label": "用途" }, meta.purpose || "");
        const saved = h("span", { class: "cap-toolbar-value" });
        const save = async () => {
            if (area.value === (meta.purpose || "")) return;
            const res = await api.put(`/api/games/${gid}/manual/shots/${encodeURIComponent(meta.key)}`, { purpose: area.value });
            meta.purpose = res.meta.purpose;
            const shot = state.info.shots.find((s) => s.key === meta.key);
            if (shot) shot.purpose = meta.purpose;
            saved.textContent = "已保存";
            renderList();
        };
        area.addEventListener("blur", save);
        area.addEventListener("input", () => { saved.textContent = ""; });
        pane.append(h("div", { class: "cap-purpose-row" }, area, saved));

        const where = [];
        if (meta.location) where.push(`${meta.location[0].replace(/^game\//, "")}:${meta.location[1]}`);
        if (meta.lastLine?.what) where.push(`${meta.lastLine.who ? `${meta.lastLine.who}：` : ""}${meta.lastLine.what}`);
        if (where.length) pane.append(h("p", { class: "cap-note mono" }, where.join(" · ")));

        if (crops.length) {
            pane.append(h("div", { class: "cap-section-title" }, `切图 ${crops.length}`));
            pane.append(cropGallery(crops, fileUrl, (rect) => focusRegion(data.gameSize, rect)));
            pane.append(h("div", { class: "cap-section-title" }, "全图"));
        }
        pane.append(stage(fileUrl("full.png"), data, crops));
        if (d.elements?.elements?.length) pane.append(table(d.elements.elements));
    }

    async function remove(meta) {
        const ok = await ctx.confirm({ title: "删除截图", message: meta.purpose || "该截图未填写用途说明", confirmText: "删除", tone: "danger" });
        if (!ok) return;
        await api.del(`/api/games/${gid}/manual/shots/${encodeURIComponent(meta.key)}`);
        state.selected = null;
        await refreshShots();
        render();
    }

    try {
        await load();
    } catch (err) {
        root.append(h("p", { class: "cap-note" }, err.message));
        return () => {};
    }
    render();
    return () => {
        state.disposed = true;
        if (state.source) state.source.close();
    };
}
