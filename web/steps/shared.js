// Pieces the scan steps (speakers, python, flow) share: the element helper, the dashboard shell
// (toolbar, stat cards, section cards, tables), and the inventory fetch they all start from.

export function h(tag, attrs = {}, ...children) {
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

/** Loads the steps' shared stylesheet once. */
export function ensureCss(url) {
    const id = "step-analysis-css";
    if (document.getElementById(id)) return;
    document.head.append(h("link", { id, rel: "stylesheet", href: url }));
}

export function formatTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `file:line`, the form the report and the editor both use. */
export const at = (o) => (o?.file ? `${o.file}${o.line ? `:${o.line}` : ""}` : "");

export function toolbar(...children) {
    return h("div", { class: "an-toolbar" }, children);
}

export function fact(label, value, tone, sub) {
    return h("div", { class: "an-fact" },
        h("span", { class: "an-fact-label" }, label),
        h("span", { class: `an-fact-value${tone ? ` is-${tone}` : ""}` }, value === null || value === undefined ? "—" : String(value)),
        sub ? h("span", { class: "an-fact-sub" }, sub) : null);
}

export function facts(list) {
    return h("div", { class: "an-facts" }, list.filter(Boolean));
}

export function section(title, count, body, { actions = null, note = null } = {}) {
    return h("div", { class: "an-section" },
        h("div", { class: "an-section-head" },
            h("span", {}, title),
            count === undefined || count === null ? null : h("span", { class: "an-count" }, String(count)),
            h("span", { class: "an-spacer" }),
            actions),
        note ? h("div", { class: "an-note" }, note) : null,
        body);
}

export function props(pairs) {
    const dl = h("dl", { class: "an-props" });
    for (const [k, v] of pairs) {
        if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
        dl.append(h("dt", {}, k), h("dd", {}, v instanceof Node ? v : String(v)));
    }
    return dl;
}

export function table(widths, headings, tbody) {
    return h("table", { class: "an-table" },
        h("colgroup", {}, widths.map((w) => h("col", w ? { style: { width: w } } : {}))),
        h("thead", {}, h("tr", {}, headings.map((t) => h("th", {}, t)))),
        tbody);
}

/** A clickable row plus the detail row under it, both appended to `tbody`. */
export function expandable(tbody, { key, open, onToggle, cells, detail, columns }) {
    const row = h("tr", {
        class: "an-row",
        "aria-expanded": open ? "true" : "false",
        onclick: () => onToggle(key),
    }, cells.map((c, i) => (c instanceof Node && c.tagName === "TD" ? c : h("td", i === 0 ? { class: "mono" } : {},
        i === 0 ? [h("span", { class: "an-chevron" }, "›"), " "] : null, c))));
    tbody.append(row);
    if (open) tbody.append(h("tr", { class: "an-detail" }, h("td", { colspan: String(columns) }, detail())));
}

/** The migrator's answer to "does this step go into the package?", loaded once per step. */
export async function loadDocumentPrefs(api, game) {
    try {
        return (await api.get(`/api/games/${game.id}/document/decisions`)).document ?? { skip: {} };
    } catch {
        return { skip: {} };
    }
}

/**
 * The switch every step carries. Off does not throw the step's work away: the document says this
 * part was left to the agent, which then reads the source itself.
 */
export function documentToggle({ api, game, prefs, step, redraw }) {
    const skipped = !!prefs?.skip?.[step];
    const input = h("input", { type: "checkbox", checked: !skipped });
    input.addEventListener("change", async () => {
        const skip = !input.checked;
        input.disabled = true;
        try {
            const res = await api.put(`/api/games/${game.id}/document/decisions`, { skip: { [step]: skip } });
            if (prefs) prefs.skip = res.document.skip;
        } catch {
            input.checked = !input.checked;
        }
        input.disabled = false;
        redraw?.();
    });
    return h("label", {
        class: `an-toggle${skipped ? " is-off" : ""}`,
        title: "关闭此项后，该步骤的内容将不写入补充包，由 Agent 自行分析源码判断",
    }, input, h("span", {}, skipped ? "不写入补充包，由 Agent 自行判断" : "写入补充包"));
}

export function chips(options, value, onPick) {
    return h("div", { class: "an-chips" }, options.map((o) =>
        h("button", {
            type: "button",
            class: "an-chip",
            "aria-pressed": o.id === value ? "true" : "false",
            onclick: () => onPick(o.id),
        }, o.label, o.count === undefined ? null : h("span", { class: "an-chip-count" }, String(o.count)))));
}

export function tag(text, tone) {
    return h("span", { class: `an-tag${tone ? ` is-${tone}` : ""}` }, text);
}

export function lines(list) {
    return h("div", { class: "an-lines mono" }, list.map((t) => h("span", {}, t)));
}

export function itemList(entries, text, extra) {
    return h("div", { class: "an-list" }, entries.map((e) =>
        h("div", { class: "an-item" },
            h("span", { class: "mono" }, at(e)),
            h("span", { class: "an-item-text" },
                h("span", {}, text(e)),
                extra?.(e) ?? (e.snippet ? h("span", { class: "an-snippet mono" }, e.snippet) : null)))));
}

export function emptyState(icon, title, action) {
    return h("div", { class: "empty-state" },
        h("div", { class: "empty-state-icon", html: icon }),
        h("p", { class: "empty-state-title" }, title),
        action ? h("div", { class: "empty-state-action" }, action) : null);
}

/**
 * The shell every scan step wears: it fetches the inventory, offers the rescan button, and calls
 * `render(extension, inventory)` with its own slice of it.
 *
 * @param {object} opts.ctx   the step context from the shell
 * @param {string} opts.key   the key under inventory.extensions
 * @param {Function} opts.render  (data, inventory, api) => Node[]
 */
export async function mountScanStep(host, ctx, { key, title, render, onLoaded, documentStep }) {
    ensureCss(new URL("./analysis.css", import.meta.url).href);
    const { game, api } = ctx;
    const root = h("div", { class: "an" });
    host.append(root);

    let inventory = null;
    let busy = false;
    let error = null;
    let prefs = { skip: {} };

    const rescan = async () => {
        busy = true;
        error = null;
        draw();
        try {
            ({ inventory } = await api.post(`/api/games/${game.id}/diagnose/run`));
            await ctx.refreshGame();
            await onLoaded?.(inventory);
        } catch (err) {
            error = err.message;
        }
        busy = false;
        draw();
    };

    function draw() {
        // Every click rebuilds the page, so remember where the reader was.
        const where = root.querySelector(".an-scroll")?.scrollTop ?? 0;
        // So does a text box being typed in, when it says who it is with data-keep.
        const active = root.contains(document.activeElement) ? document.activeElement : null;
        const keep = active?.dataset.keep ? { id: active.dataset.keep, value: active.value, caret: active.selectionStart } : null;
        const data = inventory?.extensions?.[key] ?? null;
        const bar = toolbar(
            h("button", { type: "button", class: "btn btn-quiet btn-sm", disabled: busy, onclick: rescan },
                busy ? "正在扫描" : "重新扫描"),
            documentStep ? documentToggle({ api, game, prefs, step: documentStep, redraw: draw }) : null,
            h("span", { class: "an-spacer" }),
            error
                ? h("span", { class: "an-value is-danger" }, error)
                : inventory
                    ? h("span", { class: "an-value" }, `扫描于 ${formatTime(inventory.generatedAt)}`)
                    : null);
        root.replaceChildren(bar);
        if (!data) {
            const why = busy ? "正在扫描" : inventory ? "当前扫描结果为旧版本，不包含此步骤的数据" : "暂无扫描结果";
            root.append(emptyState(ctx.icon("layers"), why,
                h("button", { type: "button", class: "btn btn-primary", disabled: busy, onclick: rescan },
                    inventory ? "重新扫描" : "开始扫描")));
            return;
        }
        const scroll = h("div", { class: "an-scroll" });
        for (const node of render(data, inventory)) if (node) scroll.append(node);
        root.append(scroll);
        scroll.scrollTop = where;
        const again = keep && [...root.querySelectorAll("[data-keep]")].find((el) => el.dataset.keep === keep.id);
        if (again) {
            // What was typed but not yet saved stays in the box.
            if (again.value !== keep.value) again.value = keep.value;
            again.focus({ preventScroll: true });
            if (keep.caret !== null && again.setSelectionRange) again.setSelectionRange(keep.caret, keep.caret);
        }
    }

    try {
        if (documentStep) prefs = await loadDocumentPrefs(api, game);
        ({ inventory } = await api.get(`/api/games/${game.id}/diagnose`));
        if (inventory) await onLoaded?.(inventory);
    } catch (err) {
        error = err.message;
    }
    draw();
    if (!inventory && !error) rescan();
    return { redraw: draw, get inventory() { return inventory; } };
}
