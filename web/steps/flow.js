// Step ④ flow and chapters. NarraLeaf Studio's shape is 故事 → 章节 → 场景: one game is one story,
// a story holds chapters, a chapter holds scenes. The migrator decides two things: whether the game
// is split into chapters (and which script files go in each), and whether a chapter's script is one
// scene or one scene per label. A preview draws the Studio outline that comes out of it, and a graph
// draws the script's branches so the split can be decided with the logic in view. The scan only
// supplies facts — play order, how much dialogue a file holds, the signals that often mark a break;
// it never groups anything by itself.

import { expandable, fact, facts, h, itemList, mountScanStep, section, table, tag } from "./shared.js";
import { outline } from "../shared/outline.js";
import { flowGraph } from "./flow-graph.js";

const AXES = [
    {
        key: "chapters",
        title: "章节",
        options: [
            { value: false, label: "不拆分", detail: "只建一个章节，所有场景都在这一章里" },
            { value: true, label: "拆分", detail: "按下面的分组建多个章节，一个剧本文件只属于一个章节" },
        ],
    },
    {
        key: "scenes",
        title: "场景",
        options: [
            { value: false, label: "不拆分", detail: "每个章节的剧本合并成一个场景，label 留在场景里" },
            { value: true, label: "按 label 拆分", detail: "每个 label 一个场景，场景名就是 label 名" },
        ],
    },
];

// The row under the two choices: the migrator hands the whole structure to the agent.
const DELEGATE = {
    title: "委托 Agent 判断",
    detail: "我自己都不知道当时怎么配置的分支，帮帮我理解并优化吧，Agent先生！",
    result: "章节和场景都交给 Agent：它读 .rpy 和剧本逻辑自己推断，移植时可以调整结构，并在每个场景描述里写明对应哪个 .rpy 文件、结构是怎么改的",
};

/** The four combinations, said the way the migrator reads them. */
function splitText(split) {
    if (split.agent) return DELEGATE.result;
    if (split.chapters === null || split.scenes === null) return null;
    if (!split.chapters && !split.scenes) return "只建一个章节，所有剧本合并成这一章里的一个场景";
    if (split.chapters && !split.scenes) return "按分组建多个章节，每个章节的剧本合并成一个场景";
    if (split.chapters && split.scenes) return "按分组建多个章节，每个章节里一个 label 一个场景";
    return "只建一个章节，章节里一个 label 一个场景";
}

const STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>';
const PAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6"/></svg>';

// How much of a script is shown inline. Enough to tell what a file is; the whole file lives on disk.
const SOURCE_LINES = 600;

const BREAK = {
    opEd: "OP/ED 视频", movie: "过场视频", achievement: "成就点", stopMusic: "停止音乐",
    blackout: "黑场", music: "换音乐",
};

export async function mount(host, ctx) {
    const { api, game } = ctx;
    let plan = { split: { chapters: null, scenes: null }, chapters: [], excluded: [] };
    let saving = 0;
    let saveError = null;
    // A chapter just made, whose title box takes the focus once the list is drawn and saved.
    let focusChapter = null;
    const openFiles = new Set();
    // file -> {text, bytes, truncated} once read, or "loading" / an error message.
    const sources = new Map();
    // Chapters folded shut in the preview, and where the logic graph is looking.
    const folded = new Set();
    const graph = { scope: null, selected: null, top: 0, left: 0, reveal: false };
    let step = null;

    async function save(next) {
        plan = next;
        saving++;
        saveError = null;
        step?.redraw();
        try {
            const res = await api.put(`/api/games/${game.id}/chapters/decisions`, {
                split: next.split,
                chapters: next.chapters,
                excluded: next.excluded ?? [],
            });
            plan = res.chapters;
            ctx.setStatus("chapters", status());
        } catch (err) {
            saveError = err.message;
        }
        saving--;
        step?.redraw();
    }

    // A chapter's title is the migrator's to give; one without is shown by its place in the list.
    const chapterLabel = (c) => c.title || `章节 ${plan.chapters.indexOf(c) + 1}（未命名）`;
    const split = () => plan.split ?? { chapters: null, scenes: null, agent: false };
    const delegated = () => split().agent === true;
    const status = () => (delegated() ? "章节交给 Agent" : plan.chapters.length ? `章节 ${plan.chapters.length} 个` : null);

    const chapterOf = (file) => plan.chapters.find((c) => c.files.includes(file)) ?? null;

    const isExcluded = (file) => (plan.excluded ?? []).includes(file);

    function assign(file, chapterId) {
        const chapters = plan.chapters.map((c) => ({ ...c, files: c.files.filter((f) => f !== file) }));
        const target = chapters.find((c) => c.id === chapterId);
        if (target) target.files = [...target.files, file];
        // A file in a chapter is not excluded; picking a chapter takes it back off that list.
        save({ ...plan, chapters, excluded: (plan.excluded ?? []).filter((f) => f !== file) });
    }

    function exclude(file) {
        const chapters = plan.chapters.map((c) => ({ ...c, files: c.files.filter((f) => f !== file) }));
        const excluded = (plan.excluded ?? []).includes(file) ? plan.excluded : [...(plan.excluded ?? []), file];
        save({ ...plan, chapters, excluded });
    }

    /** The file's own text, read on demand so a big script is only fetched when someone looks. */
    async function openSource(file) {
        if (sources.has(file)) return;
        sources.set(file, { loading: true });
        step?.redraw();
        try {
            sources.set(file, await api.get(`/api/games/${game.id}/source?path=${encodeURIComponent(file)}`));
        } catch (err) {
            sources.set(file, { error: err.message });
        }
        step?.redraw();
    }

    function sourceView(file) {
        const got = sources.get(file);
        if (!got || got.loading) return h("div", { class: "ch-dim" }, "正在读取…");
        if (got.error) return h("div", { class: "an-value is-danger" }, got.error);
        const all = got.text.split("\n");
        const shown = all.slice(0, SOURCE_LINES);
        const body = h("div", { class: "src-body" });
        shown.forEach((line, i) => {
            body.append(h("span", { class: "src-n" }, String(i + 1)), h("code", { class: "src-line" }, line || " "));
        });
        const more = all.length > shown.length
            ? `仅显示前 ${SOURCE_LINES} 行，共 ${all.length} 行`
            : got.truncated ? `文件过大，仅读取前 ${Math.round(got.bytes / 1024)} KB` : null;
        return h("div", { class: "src" },
            h("div", { class: "src-head" }, h("span", { class: "mono" }, file),
                h("span", { class: "ch-dim" }, `${all.length} 行`)),
            body,
            more ? h("div", { class: "ch-dim src-more" }, more) : null);
    }

    function addChapter() {
        const used = new Set(plan.chapters.map((c) => c.id));
        let n = plan.chapters.length + 1;
        while (used.has(`ch${n}`)) n++;
        const chapter = { id: `ch${n}`, title: "", files: [] };
        focusChapter = chapter.id;
        save({ ...plan, chapters: [...plan.chapters, chapter] });
        return chapter;
    }

    function chapterPanel(data) {
        const { chapters: many, scenes: byLabel } = split();
        const box = h("div", { class: "ch-list" });
        for (const c of plan.chapters) {
            const field = (key, placeholder, cls) => {
                const input = h("input", {
                    class: `an-input ${cls}`, type: "text", value: c[key] ?? "", placeholder, spellcheck: "false",
                    "data-keep": `${c.id}:${key}`,
                });
                // "change" fires while focus is still leaving the box. Saving redraws the list, so it
                // waits until focus has landed (on the next box, after a Tab) and the redraw keeps it there.
                input.addEventListener("change", () => setTimeout(() => {
                    const next = plan.chapters.map((x) => (x.id === c.id ? { ...x, [key]: input.value.trim() } : x));
                    save({ ...plan, chapters: next });
                }));
                return input;
            };
            const title = field("title", "章节名（不填用 New Chapter）", "ch-title");
            if (focusChapter === c.id && !saving) {
                focusChapter = null;
                queueMicrotask(() => title.focus());
            }
            const says = c.files.reduce((n, f) => n + (data.files.find((x) => x.file === f)?.says ?? 0), 0);
            box.append(h("div", { class: "ch-row" },
                h("span", { class: "ch-index" }, String(plan.chapters.indexOf(c) + 1)),
                title,
                // A scene name and description only mean something when the chapter is one scene.
                byLabel ? null : field("sceneTitle", "场景名（不填用 New Scene）", "ch-scene"),
                byLabel ? null : field("description", "场景描述", "ch-desc"),
                byLabel ? h("span", { class: "ch-desc ch-dim" }, "场景名用 label 名，不写描述") : null,
                h("span", { class: "ch-meta" }, `${c.files.length} 个文件 · ${says} 句`),
                many === false ? null : h("button", {
                    type: "button",
                    class: "btn btn-quiet btn-sm",
                    onclick: () => save({ ...plan, chapters: plan.chapters.filter((x) => x.id !== c.id) }),
                }, "删除")));
        }
        if (!plan.chapters.length) {
            box.append(h("div", { class: "ch-empty" }, many === false
                ? "还没有章节。点「收入全部剧本」把有台词的文件放进这一章"
                : "暂无章节。新建章节后在下方分配文件，或者点「每个文件各建一章」从这里开始改"));
        }
        const withStory = data.files.filter((f) => f.says && !isExcluded(f.file));
        box.append(h("div", { class: "ch-row" },
            many === false
                ? plan.chapters.length ? null : h("button", { type: "button", class: "btn btn-quiet btn-sm", onclick: () => save({ ...plan, chapters: [oneChapter(data)] }) }, "收入全部剧本")
                : h("button", { type: "button", class: "btn btn-quiet btn-sm", onclick: () => addChapter() }, "新建章节"),
            many === false ? null : h("button", {
                type: "button",
                class: "btn btn-quiet btn-sm",
                onclick: async () => {
                    if (plan.chapters.length) {
                        const ok = await ctx.confirm({ title: "每个文件各建一章", message: `将按游玩顺序为 ${withStory.length} 个有台词的文件各建一个章节，当前分组将被替换`, confirmText: "替换" });
                        if (!ok) return;
                    }
                    save({ ...plan, chapters: withStory.map((f, i) => ({ id: `ch${i + 1}`, title: "", files: [f.file] })) });
                },
            }, "每个文件各建一章"),
            plan.chapters.length && many !== false
                ? h("button", {
                    type: "button",
                    class: "btn btn-quiet btn-sm",
                    onclick: async () => {
                        const ok = await ctx.confirm({ title: "清空分组", message: "将删除所有章节及已分配的文件，扫描结果不受影响", confirmText: "清空", tone: "danger" });
                        if (ok) save({ ...plan, chapters: [] });
                    },
                }, "清空分组")
                : null));
        return box;
    }

    /**
     * Everything in one chapter: what is already grouped keeps its place and names, and every other
     * file with dialogue joins it, in play order.
     */
    function oneChapter(data) {
        const first = plan.chapters[0] ?? { id: "ch1", title: "" };
        const grouped = new Set(plan.chapters.flatMap((c) => c.files));
        const files = data.files
            .filter((f) => !isExcluded(f.file) && (grouped.has(f.file) || f.says))
            .map((f) => f.file);
        return { ...first, files };
    }

    async function pick(axis, value, data) {
        const now = split();
        if (now[axis] === value) return;
        let chapters = plan.chapters;
        if (axis === "chapters" && value === false && (chapters.length !== 1 || data.files.some((f) => f.says && !isExcluded(f.file) && !chapterOf(f.file)))) {
            if (chapters.length > 1) {
                const ok = await ctx.confirm({
                    title: "章节不拆分",
                    message: `将把 ${chapters.length} 个章节合并成一章，章节名和场景名保留第一章的`,
                    confirmText: "合并",
                });
                if (!ok) return;
            }
            chapters = [oneChapter(data)];
        }
        save({ ...plan, split: { ...now, [axis]: value }, chapters });
    }

    function splitPanel(data) {
        const now = split();
        const off = now.agent;
        const axes = AXES.map((a) => {
            const chosen = a.options.find((o) => o.value === now[a.key]);
            return h("div", { class: `ch-axis${off ? " is-off" : ""}` },
                h("span", { class: "ch-axis-title" }, a.title),
                h("div", { class: "ch-axis-body" },
                    h("div", { class: "tabstrip", role: "tablist" }, a.options.map((o) => h("button", {
                        type: "button", class: "tab", role: "tab",
                        "aria-selected": !off && now[a.key] === o.value ? "true" : "false",
                        "aria-disabled": off ? "true" : null,
                        onclick: () => (off ? null : pick(a.key, o.value, data)),
                    }, o.label))),
                    h("span", { class: "ch-axis-detail" }, off ? "交给 Agent" : chosen ? chosen.detail : "未选")));
        });
        // The grouping stays saved underneath, so taking the structure back brings it back as it was.
        const box = h("input", { type: "checkbox", checked: off });
        box.addEventListener("change", () => save({ ...plan, split: { ...now, agent: box.checked } }));
        const delegate = h("label", { class: `ch-delegate${off ? " is-on" : ""}` },
            box,
            h("span", { class: "ch-delegate-text" },
                h("span", { class: "ch-delegate-title" }, DELEGATE.title),
                h("span", { class: "ch-axis-detail" }, DELEGATE.detail)));
        const said = splitText(now);
        return h("div", { class: "ch-split" },
            h("div", { class: "ch-axes" },
                axes,
                delegate,
                h("div", { class: `ch-result${said ? "" : " is-empty"}` }, said ?? "两项都选好后，右边会画出导入 Studio 后的样子")),
            preview(data));
    }

    /** The story outline as Studio's story panel shows it. */
    function preview(data) {
        const tree = outline(plan, data.files);
        const panel = h("div", { class: "st-tree" });
        panel.append(h("div", { class: "st-caption" }, "Studio 预览"));
        if (delegated()) {
            panel.append(h("div", { class: "st-empty" }, "章节和场景由 Agent 移植时决定"));
            return panel;
        }
        if (!tree.ready) {
            panel.append(h("div", { class: "st-empty" }, "选好章节和场景的拆分方式后显示"));
            return panel;
        }
        if (!tree.chapters.length) {
            panel.append(h("div", { class: "st-empty" }, "还没有章节"));
            return panel;
        }
        for (const c of tree.chapters) {
            const shut = folded.has(c.id);
            panel.append(h("button", {
                type: "button", class: "st-chapter", "aria-expanded": shut ? "false" : "true",
                onclick: () => {
                    if (shut) folded.delete(c.id);
                    else folded.add(c.id);
                    step?.redraw();
                },
            },
            h("span", { class: "st-chevron" }, "›"),
            h("span", { class: c.untitled ? "st-untitled" : null }, c.name),
            h("span", { class: "st-count" }, `（${c.scenes.length}）`)));
            if (shut) continue;
            if (!c.scenes.length) panel.append(h("div", { class: "st-none" }, "没有场景：这一章的文件里没有 label"));
            for (const sc of c.scenes) {
                panel.append(h("div", {
                    class: `st-scene${sc.label ? " is-link" : ""}${sc.reachable === false ? " is-dim" : ""}`,
                    title: sc.label ? `${sc.file}:${sc.line}${sc.reachable === false ? "，从入口走不到" : ""}` : sc.description || null,
                    onclick: sc.label ? () => showLabel(sc.label) : null,
                },
                h("span", { class: "st-icon", html: sc.entry ? STAR : PAGE }),
                h("span", { class: "st-text" },
                    h("span", { class: `st-name${sc.untitled ? " st-untitled" : ""}` }, sc.name),
                    h("span", { class: "st-sub" }, `${sc.says} 句台词${sc.reachable === false ? " · 走不到" : ""}`))));
            }
        }
        return panel;
    }

    /** Opens the logic graph on a label. */
    function showLabel(name) {
        graph.selected = name;
        graph.scope = null;
        graph.reveal = true;
        step?.redraw();
        queueMicrotask(() => document.querySelector(".fg")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }

    function logicPanel(data) {
        const many = !delegated() && split().chapters && plan.chapters.length > 1;
        const scope = many ? plan.chapters.find((c) => c.id === graph.scope) ?? null : null;
        const tabs = many
            ? h("div", { class: "tabstrip fg-scope", role: "tablist" },
                h("button", { type: "button", class: "tab", role: "tab", "aria-selected": scope ? "false" : "true", onclick: () => { graph.scope = null; step.redraw(); } }, "全部"),
                plan.chapters.map((c) => h("button", {
                    type: "button", class: "tab", role: "tab", "aria-selected": scope?.id === c.id ? "true" : "false",
                    onclick: () => { graph.scope = c.id; graph.top = 0; graph.left = 0; step.redraw(); },
                }, chapterLabel(c))))
            : null;
        return h("div", {}, tabs, flowGraph(data, {
            scope: scope ? new Set(scope.files) : null,
            chapterOf: (file) => {
                const c = chapterOf(file);
                return c ? chapterLabel(c) : isExcluded(file) ? "已排除" : "未分配";
            },
            state: graph,
            onSelect: (name, widen) => {
                graph.selected = name;
                if (widen && name) {
                    graph.scope = null;
                    graph.reveal = true;
                }
                step.redraw();
            },
        }));
    }

    function fileTable(data) {
        const tbody = h("tbody");
        for (const f of data.files) {
            const current = chapterOf(f.file);
            const out = isExcluded(f.file);
            // Handed to the agent, a file is either story for it to place or excluded.
            const select = delegated()
                ? h("select", { class: "an-select ch-select" },
                    h("option", { value: "", selected: !out }, "交给 Agent"),
                    h("option", { value: "-", selected: out }, "排除（非剧本文件）"))
                : h("select", { class: "an-select ch-select" },
                    h("option", { value: "", selected: !current && !out }, "未分配"),
                    plan.chapters.map((c) => h("option", { value: c.id, selected: current?.id === c.id }, chapterLabel(c))),
                    split().chapters === false ? null : h("option", { value: "+" }, "新建章节…"),
                    h("option", { value: "-", selected: out }, "排除（非剧本文件）"));
            select.addEventListener("change", () => {
                if (delegated()) {
                    if (select.value === "-") exclude(f.file);
                    else save({ ...plan, excluded: (plan.excluded ?? []).filter((x) => x !== f.file) });
                } else if (select.value === "+") {
                    const chapter = addChapter();
                    assign(f.file, chapter.id);
                } else if (select.value === "-") {
                    exclude(f.file);
                } else {
                    assign(f.file, select.value);
                }
            });
            // The select sits inside a row that opens on click; its own clicks stay with it.
            const cell = h("td", {}, select);
            cell.addEventListener("click", (e) => e.stopPropagation());
            const signals = f.breaks.filter((b) => b.score >= 3);
            // Excluding a file play walks into loses part of the story (the credits a good ending
            // jumps to, say), so the row says so instead of letting it ship quietly.
            const entered = (f.enteredFrom ?? []).filter((e) => e.reachable && e.from.some((x) => !isExcluded(x.file)));
            const warnCell = out && (entered.length || f.endings)
                ? h("span", { class: "an-value is-danger" },
                    f.endings ? `有 ${f.endings} 个结局` : `由 ${entered[0].from[0].file}:${entered[0].from[0].line} 跳转进入`)
                : null;
            expandable(tbody, {
                key: f.file,
                open: openFiles.has(f.file),
                onToggle: (file) => {
                    if (openFiles.has(file)) openFiles.delete(file);
                    else {
                        openFiles.add(file);
                        openSource(file);
                    }
                    step?.redraw();
                },
                columns: 6,
                cells: [
                    warnCell ? h("span", {}, h("span", { class: "ch-dim" }, f.file), " ", warnCell) : out ? h("span", { class: "ch-dim" }, f.file) : f.file,
                    f.playOrder === null ? h("span", { class: "ch-dim" }, "不可达") : String(f.playOrder + 1),
                    String(f.says),
                    String(f.labels.length),
                    signals.length ? `${signals.length} 处` : "—",
                    cell,
                ],
                detail: () => sourceView(f.file),
            });
        }
        const t = table(["30%", "88px", "72px", "72px", "96px", "20%"],
            ["文件", "游玩顺序", "台词", "label", "疑似分界", "章节"], tbody);
        t.classList.add("is-wrap");
        return t;
    }

    step = await mountScanStep(host, ctx, {
        key: "flow",
        documentStep: "flow",
        async onLoaded() {
            const res = await api.get(`/api/games/${game.id}/chapters/decisions`);
            plan = res.chapters;
            ctx.setStatus("chapters", status());
        },
        render(data) {
            // `files` arrived with this step; an older scan result has to be re-run first.
            if (!data.files) {
                return [section("流程与章节", undefined,
                    h("div", { class: "sp-empty" },
                        h("p", {}, "当前扫描结果为旧版本，缺少按文件统计的数据"),
                        h("p", {}, "请点击上方「重新扫描」后再操作")))];
            }
            const s = data.summary;
            const assigned = plan.chapters.reduce((n, c) => n + c.files.length, 0);
            const withStory = data.files.filter((f) => f.says).length;
            const tree = outline(plan, data.files);
            const scenes = tree.chapters.reduce((n, c) => n + c.scenes.length, 0);
            const now = split();
            const out = [];
            out.push(facts([
                fact("剧本文件", data.files.length, null, `${withStory} 个有台词`),
                now.agent
                    ? fact("已分组", "交给 Agent", null, `排除 ${(plan.excluded ?? []).length} 个文件`)
                    : fact("已分组", `${assigned} / ${withStory}`, assigned >= withStory && withStory ? "success" : "warning"),
                fact("章节", now.agent ? "—" : plan.chapters.length, now.agent ? null : plan.chapters.length ? "success" : "warning", now.agent ? "Agent 决定" : null),
                now.agent
                    ? fact("场景", "—", null, "Agent 决定")
                    : fact("场景", tree.ready ? scenes : "—", tree.ready ? null : "warning", tree.ready ? (now.scenes ? "一个 label 一个场景" : "一章一个场景") : "拆分方式未选"),
                fact("label", s.labels, null, `不可达 ${s.unreachable} 个`),
                fact("菜单", s.menus, null, `${s.choices} 个选项`),
            ]));

            out.push(section("拆分方式", undefined, splitPanel(data), {
                actions: saveError
                    ? h("span", { class: "an-value is-danger" }, saveError)
                    : saving ? h("span", { class: "an-value" }, "正在保存")
                        : plan.updatedAt ? h("span", { class: "an-value" }, "已保存") : null,
                note: "整部游戏是 Studio 里的一个故事。章节和场景都是 Studio 的：章节把场景分组，场景是写剧本的地方",
            }));

            if (!now.agent) out.push(section("章节", plan.chapters.length, chapterPanel(data), {
                note: now.scenes
                    ? "章节名就是 Studio 里的章节名，可以不填；不填的 Agent 不会替你起，用 Studio 默认的 New Chapter"
                    : "章节名是 Studio 里的章节名，场景名和场景描述给这一章合成的那个场景，都可以不填；不填的 Agent 不会替你写，用 Studio 默认的 New Chapter、New Scene，描述留空",
            }));

            const warn = now.chapters === false || now.agent ? null : h("div", { class: "ch-warn" },
                h("p", {}, "分组前请确认以下事项：",
                    h("b", {}, "同一章节内不应包含属于不同章节的内容")),
                h("p", {}, "比如 c1c2.rpy 整个算第一章，那就把它整个放进第一章；但要保证这个文件里没有混进别的章节的内容。有人会把一章拆成几个文件，那就把这几个文件都放进同一个章节"),
                h("p", {}, "此项无法由程序自动校验，需人工确认"));
            out.push(section(now.agent ? "剧本文件" : "文件分组", data.files.length, h("div", {}, warn, fileTable(data)), {
                note: now.agent
                    ? "章节交给 Agent 后这里只管排除：不是剧本的文件（界面、transform、调试残留）选「排除」，其余都交给 Agent。点一行看文件内容"
                    : "点一行看文件内容；不是剧本的文件（界面、transform、调试残留）在右边选「排除」。「游玩顺序」是从 start 走出来的先后，不是文件名的顺序",
            }));

            out.push(section("剧本逻辑", s.reachable, logicPanel(data), {
                note: "从 start 走得到的每个 label 一个框，按游玩顺序从左往右排；框里列出它的菜单选项，箭头指向选完去的 label。点框看入口，点 label 名跳过去",
            }));

            if (data.menus.length) {
                const mt = h("tbody");
                for (const m of data.menus) {
                    for (const c of m.choices) {
                        mt.append(h("tr", {},
                            h("td", { class: "mono" }, `${m.file}:${m.line}`),
                            h("td", {}, m.label || "—"),
                            h("td", {}, c.text),
                            h("td", {}, c.condition || "—"),
                            h("td", { class: "mono" }, c.target || "顺序执行")));
                    }
                }
                const t = table(["22%", "18%", null, "18%", "16%"], ["菜单", "所属 label", "选项", "条件", "跳转目标"], mt);
                t.classList.add("is-wrap");
                out.push(section("菜单与选项", s.choices, t));
            }

            if (data.breaks.length) {
                const bt = h("tbody");
                for (const b of data.breaks) {
                    bt.append(h("tr", {},
                        h("td", { class: "mono" }, `${b.file}:${b.line}`),
                        h("td", {}, BREAK[b.kind] ?? b.kind),
                        h("td", {}, String(b.score)),
                        h("td", { class: "mono" }, b.snippet)));
                }
                out.push(section("疑似分界信号", data.breaks.length,
                    table(["24%", "100px", "64px", null], ["位置", "信号", "权重", "原文"], bt),
                    { note: "仅供参考：黑场伴随停止音乐、过场视频、成就点通常为章节结尾的标志，权重越高越可能为分界点" }));
            }

            if (data.endings.length) {
                out.push(section("结局", data.endings.length,
                    itemList(data.endings, (e) => `${e.name}（${e.says} 句）`,
                        (e) => h("span", { class: "an-snippet" }, e.kind === "namedEnding" ? "名称疑似结局" : "以 return 结束")),
                    { note: "路线末尾的 return 在 NarraLeaf 中对应 /ending" }));
            }

            if (data.unreachable.length) {
                out.push(section("不可达的 label", data.unreachable.length,
                    itemList(data.unreachable, (l) => `${l.name}（${l.says} 句）`,
                        (l) => h("span", { class: "an-snippet" }, l.reason))));
            }

            if (data.warnings.length) {
                out.push(section("注意事项", data.warnings.length,
                    h("div", { class: "an-list" }, data.warnings.map((w) => h("div", { class: "an-item is-wide" }, w.message)))));
            }
            return out;
        },
    });

    return () => ctx.setStatus("chapters", null);
}
