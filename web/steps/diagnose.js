// Step 1: diagnose. A static scan of the game's scripts; nothing is executed.

const CSS_ID = "step-diagnose-css";

const SOURCE_STATUS = {
    source: "源码完整",
    partialSource: "部分缺少源码",
    compiledOnly: "仅有 .rpyc",
    archivedOnly: "仅有 .rpa",
    empty: "没有脚本",
};

const CLASSIFICATION = { dialogue_like: "像台词", interactive: "可操作" };
const CATEGORY = { standard: "标准", custom: "自定义" };
const CALL_KIND = { show: "show screen", call: "call screen", menu: "菜单动作", use: "use", python: "Python" };

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
    document.head.append(h("link", { id: CSS_ID, rel: "stylesheet", href: new URL("./diagnose.css", import.meta.url).href }));
}

function formatTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const at = (o) => (o?.file ? `${o.file}${o.line ? `:${o.line}` : ""}` : "");

export async function mount(host, ctx) {
    ensureCss();
    const { game, api } = ctx;
    const gid = game.id;
    const root = h("div", { class: "dg" });
    host.append(root);

    let inventory = null;
    let busy = false;
    let error = null;
    const open = new Set();

    async function run() {
        busy = true;
        error = null;
        render();
        try {
            ({ inventory } = await api.post(`/api/games/${gid}/diagnose/run`));
            await ctx.refreshGame();
        } catch (err) {
            error = err.message;
        }
        busy = false;
        render();
    }

    function toolbar() {
        const bar = h("div", { class: "dg-toolbar" },
            h("button", { type: "button", class: "btn btn-primary btn-sm", disabled: busy, onclick: run },
                busy ? "正在诊断" : inventory ? "重新诊断" : "开始诊断"),
            h("span", { class: "dg-spacer" }));
        if (error) bar.append(h("span", { class: "dg-value", style: { color: "rgb(var(--nl-danger))" } }, error));
        else if (inventory) bar.append(h("span", { class: "dg-value" }, formatTime(inventory.generatedAt)));
        return bar;
    }

    function fact(label, value, tone) {
        return h("div", { class: "dg-fact" },
            h("span", { class: "dg-fact-label" }, label),
            h("span", { class: `dg-fact-value${tone ? ` is-${tone}` : ""}` }, value ?? "未知"));
    }

    function facts(inv) {
        const r = inv.game?.resolution;
        const src = inv.source || {};
        const rec = src.sdkRecommendation;
        const s = inv.summary || {};
        return h("div", { class: "dg-facts" },
            fact("分辨率", r?.width ? `${r.width}×${r.height}` : null, r && !r.is16x9 ? "warning" : null),
            fact("源码", SOURCE_STATUS[src.status] || src.status, src.status && src.status !== "source" ? "warning" : null),
            fact("推荐 SDK", rec ? (rec.exactVersion ? `Ren'Py ${rec.exactVersion}` : `Ren'Py ${rec.major}`) : null),
            fact("界面", s.customScreens ? `${s.screens}，自定义 ${s.customScreens}` : s.screens),
            fact("角色", s.characters),
            fact("需人工确认", s.needsReview || 0, s.needsReview ? "warning" : null));
    }

    function section(title, count, body) {
        return h("div", { class: "dg-section" },
            h("div", { class: "dg-section-head" }, title, count !== undefined ? h("span", { class: "dg-count" }, String(count)) : null),
            body);
    }

    function props(pairs) {
        const dl = h("dl", { class: "dg-props" });
        for (const [k, v] of pairs) {
            if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
            dl.append(h("dt", {}, k), h("dd", {}, v instanceof Node ? v : String(v)));
        }
        return dl;
    }

    function screenDetail(sc) {
        const def = sc.definitions?.[0];
        const calls = h("div", { class: "dg-lines mono" },
            sc.callSites.map((c) => h("span", {}, [at(c), c.label ? `label ${c.label}` : null, CALL_KIND[c.kind] || c.kind].filter(Boolean).join(" · "))));
        const actions = Object.entries(sc.actions || {}).map(([k, n]) => `${k}×${n}`).join("、");
        return props([
            ["定义", sc.definitions?.map((d) => `${at(d)}${d.variant ? ` variant ${d.variant}` : ""}`).join("、") || "未定义"],
            ["参数", def?.signature],
            ["调用", sc.callSites.length ? calls : null],
            ["被引用", sc.usedBy?.join("、")],
            ["读取变量", sc.storeVariables?.map((v) => (typeof v === "string" ? v : v.name)).join("、")],
            ["动作", actions],
            ["判断依据", sc.classificationReasons?.join("；")],
            ["无法解析", sc.unresolvedNames?.join("、")],
        ]);
    }

    function screensTable(inv) {
        const tbody = h("tbody");
        const screens = [...inv.screens].sort((a, b) =>
            (a.category === b.category ? 0 : a.category === "custom" ? -1 : 1) || a.name.localeCompare(b.name));
        for (const sc of screens) {
            const expanded = open.has(sc.name);
            const row = h("tr", {
                class: "is-row",
                "aria-expanded": expanded ? "true" : "false",
                onclick: () => {
                    if (open.has(sc.name)) open.delete(sc.name);
                    else open.add(sc.name);
                    render();
                },
            },
            h("td", { class: "mono" }, h("span", { class: "dg-chevron" }, "›"), " ", sc.name),
            h("td", {}, sc.defined ? CATEGORY[sc.category] || sc.category : "未定义"),
            h("td", {}, CLASSIFICATION[sc.classification] || ""),
            h("td", { class: "mono" }, sc.definitions?.[0]?.signature || ""),
            h("td", {}, String(sc.callSites.length)));
            tbody.append(row);
            if (expanded) tbody.append(h("tr", { class: "dg-detail" }, h("td", { colspan: "5" }, screenDetail(sc))));
        }
        return h("table", { class: "dg-table" },
            h("colgroup", {},
                h("col", { style: { width: "28%" } }),
                h("col", { style: { width: "72px" } }),
                h("col", { style: { width: "72px" } }),
                h("col", {}),
                h("col", { style: { width: "64px" } })),
            h("thead", {}, h("tr", {}, h("th", {}, "名称"), h("th", {}, "分类"), h("th", {}, "类型"), h("th", {}, "参数"), h("th", {}, "调用处"))),
            tbody);
    }

    function charactersTable(inv) {
        const tbody = h("tbody");
        for (const c of inv.characters) {
            tbody.append(h("tr", {},
                h("td", { class: "mono" }, c.variable),
                h("td", {}, c.displayName ?? c.nameExpression ?? ""),
                h("td", {}, c.kind || ""),
                h("td", { class: "mono" }, at(c))));
        }
        return h("table", { class: "dg-table" },
            h("colgroup", {}, h("col", { style: { width: "28%" } }), h("col", {}), h("col", { style: { width: "72px" } }), h("col", { style: { width: "30%" } })),
            h("thead", {}, h("tr", {}, h("th", {}, "变量"), h("th", {}, "显示名"), h("th", {}, "模式"), h("th", {}, "位置"))),
            tbody);
    }

    function itemList(entries, text) {
        return h("div", { class: "dg-list" }, entries.map((e) =>
            h("div", { class: "dg-item" },
                h("span", { class: "mono" }, at(e)),
                h("span", { class: "dg-item-text" },
                    h("span", {}, text(e)),
                    e.snippet ? h("span", { class: "dg-snippet mono" }, e.snippet) : null))));
    }

    function render() {
        root.replaceChildren(toolbar());
        if (!inventory) {
            root.append(h("div", { class: "empty-state" },
                h("div", { class: "empty-state-icon", html: ctx.icon("layers") }),
                h("p", { class: "empty-state-title" }, busy ? "正在诊断" : "尚未诊断")));
            return;
        }
        const inv = inventory;
        const scroll = h("div", { class: "dg-scroll" });
        scroll.append(facts(inv));

        if (inv.needsReview?.length) {
            scroll.append(section("需人工确认", inv.needsReview.length,
                itemList(inv.needsReview, (e) => e.message || e.kind)));
        }
        scroll.append(section("界面", inv.screens.length, screensTable(inv)));
        scroll.append(section("角色", inv.characters.length, charactersTable(inv)));

        const src = inv.source || {};
        const health = [
            ...(src.archives || []).map((f) => ({ ...(typeof f === "string" ? { file: f } : f), message: ".rpa 归档，未解包" })),
            ...(src.python2?.hits || []).map((e) => ({ ...e, message: e.message || "Python 2 语法" })),
        ];
        if (health.length) scroll.append(section("源码问题", health.length, itemList(health, (e) => e.message)));
        const reasons = src.sdkRecommendation?.reasons || [];
        if (reasons.length) {
            scroll.append(section("SDK 判断", undefined, h("div", { class: "dg-list" },
                reasons.map((r) => h("div", { class: "dg-item", style: { gridTemplateColumns: "1fr" } }, r)))));
        }
        root.append(scroll);
    }

    try {
        ({ inventory } = await api.get(`/api/games/${gid}/diagnose`));
    } catch (err) {
        error = err.message;
    }
    render();
    if (!inventory && !error) run();
    return () => {};
}
