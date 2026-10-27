// Step ④ flow and chapters. NarraLeaf Studio's shape is 故事 → 章节 → 场景: one game is one story,
// a story holds chapters, a chapter holds scenes. A Ren'Py script file becomes a chapter and its
// labels become that chapter's scenes. So this step lists the game's script files and lets the
// migrator put each one in a chapter. The scan only supplies facts — play order, how much dialogue a file
// holds, and the signals that often mark a break; it never groups anything by itself.

import { expandable, fact, facts, h, itemList, mountScanStep, props, section, table, tag } from "./shared.js";

const MODES = [
    {
        id: "none",
        title: "不拆分",
        detail: "所有剧本文件归入同一章节，在 Studio 里做成一个场景",
        apply: (files) => [{ id: "ch1", title: "", files: files.map((f) => f.file) }],
    },
    {
        id: "choices",
        title: "按选项拆分",
        detail: "Agent 将识别选项分支引出的支线，每条支线独立为一个场景；章节划分仍按下方分组配置",
        apply: null,
    },
    {
        id: "full",
        title: "全拆分",
        detail: "每个剧本文件独立为一个章节，在 Studio 里各成一个场景（仍为同一故事）",
        apply: (files) => files.map((f, i) => ({ id: `ch${i + 1}`, title: "", files: [f.file] })),
    },
];

// How much of a script is shown inline. Enough to tell what a file is; the whole file lives on disk.
const SOURCE_LINES = 600;

const BREAK = {
    opEd: "OP/ED 视频", movie: "过场视频", achievement: "成就点", stopMusic: "停止音乐",
    blackout: "黑场", music: "换音乐",
};

const EDGE = {
    jump: "jump", call: "call", fallthrough: "顺序进入下一个 label", jumpExpression: "jump expression",
    callExpression: "call expression", "Jump()": "Jump 动作", "Call()": "Call 动作",
    "Start()": "Start 动作", "Replay()": "Replay 动作", "renpy.jump": "renpy.jump", "renpy.call": "renpy.call",
};

export async function mount(host, ctx) {
    const { api, game } = ctx;
    let plan = { mode: null, chapters: [] };
    let saving = 0;
    let saveError = null;
    // A chapter just made, whose title box takes the focus once the list is drawn and saved.
    let focusChapter = null;
    const openLabels = new Set();
    const openFiles = new Set();
    // file -> {text, bytes, truncated} once read, or "loading" / an error message.
    const sources = new Map();
    let step = null;

    async function save(next) {
        plan = next;
        saving++;
        saveError = null;
        step?.redraw();
        try {
            const res = await api.put(`/api/games/${game.id}/chapters/decisions`, {
                mode: next.mode,
                chapters: next.chapters,
                excluded: next.excluded ?? [],
            });
            plan = res.chapters;
            ctx.setStatus("chapters", plan.chapters.length ? `章节 ${plan.chapters.length} 个` : null);
        } catch (err) {
            saveError = err.message;
        }
        saving--;
        step?.redraw();
    }

    // A chapter's title is the migrator's to give; one without is shown by its place in the list.
    const chapterLabel = (c) => c.title || `未命名 ${plan.chapters.indexOf(c) + 1}`;

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
            const title = field("title", `标题（${chapterLabel(c)}）`, "ch-title");
            const description = field("description", "描述", "ch-desc");
            if (focusChapter === c.id && !saving) {
                focusChapter = null;
                queueMicrotask(() => title.focus());
            }
            const says = c.files.reduce((n, f) => n + (data.files.find((x) => x.file === f)?.says ?? 0), 0);
            box.append(h("div", { class: "ch-row" },
                title,
                description,
                h("span", { class: "ch-meta" }, `${c.files.length} 个文件 · ${says} 句`),
                h("button", {
                    type: "button",
                    class: "btn btn-quiet btn-sm",
                    onclick: () => save({ ...plan, chapters: plan.chapters.filter((x) => x.id !== c.id) }),
                }, "删除")));
        }
        if (!plan.chapters.length) box.append(h("div", { class: "ch-empty" }, "暂无章节。请选择一种拆分方式，或直接新建章节，然后在下方分配文件"));
        box.append(h("div", { class: "ch-row" },
            h("button", { type: "button", class: "btn btn-quiet btn-sm", onclick: () => addChapter() }, "新建章节"),
            plan.chapters.length
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

    function modePanel(data) {
        const cards = MODES.map((m) => h("button", {
            type: "button",
            class: `ch-mode${plan.mode === m.id ? " is-on" : ""}`,
            onclick: async () => {
                if (m.apply && plan.chapters.length) {
                    const ok = await ctx.confirm({
                        title: m.title,
                        message: "将按所选方式重新分组，当前章节配置将被替换",
                        confirmText: "确认分组",
                    });
                    if (!ok) return;
                }
                save({ ...plan, mode: m.id, chapters: m.apply ? m.apply(data.files.filter((f) => f.says)) : plan.chapters });
            },
        },
        h("span", { class: "ch-mode-title" }, m.title),
        h("span", { class: "ch-mode-detail" }, m.detail)));
        return h("div", { class: "ch-modes" }, cards);
    }

    function fileTable(data) {
        const tbody = h("tbody");
        for (const f of data.files) {
            const current = chapterOf(f.file);
            const out = isExcluded(f.file);
            const select = h("select", { class: "an-select ch-select" },
                h("option", { value: "", selected: !current && !out }, "未分配"),
                plan.chapters.map((c) => h("option", { value: c.id, selected: current?.id === c.id }, chapterLabel(c))),
                h("option", { value: "+" }, "新建章节…"),
                h("option", { value: "-", selected: out }, "排除（非剧本文件）"));
            select.addEventListener("change", () => {
                if (select.value === "+") {
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
            ctx.setStatus("chapters", plan.chapters.length ? `章节 ${plan.chapters.length} 个` : null);
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
            const out = [];
            out.push(facts([
                fact("剧本文件", data.files.length, null, `${withStory} 个有台词`),
                fact("已分组", `${assigned} / ${withStory}`, assigned >= withStory && withStory ? "success" : "warning"),
                fact("章节", plan.chapters.length, plan.chapters.length ? "success" : "warning"),
                fact("拆分方式", MODES.find((m) => m.id === plan.mode)?.title ?? "未选", plan.mode ? null : "warning"),
                fact("label", s.labels, null, `不可达 ${s.unreachable} 个`),
                fact("菜单", s.menus, null, `${s.choices} 个选项`),
            ]));

            out.push(section("拆分方式", undefined, modePanel(data), {
                actions: saveError
                    ? h("span", { class: "an-value is-danger" }, saveError)
                    : saving ? h("span", { class: "an-value" }, "正在保存")
                        : plan.updatedAt ? h("span", { class: "an-value" }, "已保存") : null,
                note: "这里的一个章节在 Studio 里做成一个场景，整部游戏是一个故事",
            }));

            out.push(section("章节", plan.chapters.length, chapterPanel(data), {
                note: "标题是 Studio 里的场景名，描述是场景描述，都可以不填；不填的 Agent 不会替你写，场景名用 Studio 默认的 New Scene，描述留空",
            }));

            const warn = h("div", { class: "ch-warn" },
                h("p", {}, "分组前请确认以下事项：",
                    h("b", {}, "同一章节内不应包含属于不同章节的内容")),
                h("p", {}, "比如 c1c2.rpy 整个算第一章，那就把它整个放进第一章；但要保证这个文件里没有混进别的章节的内容。有人会把一章拆成几个文件，那就把这几个文件都放进同一个章节"),
                h("p", {}, "此项无法由程序自动校验，需人工确认"));
            out.push(section("文件分组", data.files.length, h("div", {}, warn, fileTable(data)), {
                note: "点一行看文件内容；不是剧本的文件（界面、transform、调试残留）在右边选「排除」。「游玩顺序」是从 start 走出来的先后，不是文件名的顺序",
            }));

            const labels = data.labels.filter((l) => l.reachable);
            const tbody = h("tbody");
            for (const l of labels) {
                expandable(tbody, {
                    key: l.name,
                    open: openLabels.has(l.name),
                    onToggle: (k) => {
                        if (openLabels.has(k)) openLabels.delete(k);
                        else openLabels.add(k);
                        step.redraw();
                    },
                    columns: 5,
                    cells: [
                        l.name,
                        String(l.playOrder + 1),
                        h("span", { class: "mono" }, `${l.file}:${l.line}`),
                        String(l.says),
                        h("span", {},
                            l.menus ? tag(`${l.menus} 个菜单`, "primary") : null,
                            l.terminal === "return" ? tag("以 return 结束") : null,
                            l.fallsThroughTo ? tag("顺序进入下一个") : null),
                    ],
                    detail: () => props([
                        ["位置", `${l.file}:${l.line}–${l.endLine}`],
                        ["台词", l.says ? `${l.says} 句` : "无台词"],
                        ["出口", l.out.filter((e) => e.to).map((e) => `${EDGE[e.kind] ?? e.kind} → ${e.to}`).join("；") || null],
                        ["入口", l.in.map((e) => `${EDGE[e.kind] ?? e.kind} ← ${e.from ?? e.screen ?? "入口"}`).join("；") || null],
                    ]),
                });
            }
            out.push(section("label 执行顺序", labels.length,
                table(["28%", "88px", "26%", "72px", null], ["label", "游玩顺序", "位置", "台词", "说明"], tbody)));

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
                out.push(section("菜单与选项", s.choices, t, {
                    note: "选择「按选项拆分」时，Agent 将依据这些分支划分场景",
                }));
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
