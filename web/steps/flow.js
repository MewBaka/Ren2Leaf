// Step ④ flow and chapters. NarraLeaf's shape is 章节 → 故事: a story is a file, a chapter is the
// group that holds stories. So this step lists the game's script files and lets the migrator put
// each one in a chapter. The scan only supplies facts — play order, how much dialogue a file
// holds, and the signals that often mark a break; it never groups anything by itself.

import { expandable, fact, facts, h, itemList, mountScanStep, props, section, table, tag } from "./shared.js";

const MODES = [
    {
        id: "none",
        title: "不拆分",
        detail: "所有剧本放进同一个章节，Agent 不再切分",
        apply: (files) => [{ id: "ch1", title: "第一章", files: files.map((f) => f.file) }],
    },
    {
        id: "choices",
        title: "按选项拆分",
        detail: "Agent 找出选项引出的支线，每条支线单独做成一个故事；章节还是按你下面的分组",
        apply: null,
    },
    {
        id: "full",
        title: "全拆分",
        detail: "一个剧本文件一个章节，面向一章一个文件的游戏",
        apply: (files) => files.map((f, i) => ({ id: `ch${i + 1}`, title: f.file.replace(/^.*\//, "").replace(/\.rpym?$/, ""), files: [f.file] })),
    },
];

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
    const openLabels = new Set();
    let step = null;

    async function save(next) {
        plan = next;
        saving++;
        saveError = null;
        step?.redraw();
        try {
            const res = await api.put(`/api/games/${game.id}/chapters/decisions`, { mode: next.mode, chapters: next.chapters });
            plan = res.chapters;
            ctx.setStatus("chapters", plan.chapters.length ? `章节 ${plan.chapters.length} 个` : null);
        } catch (err) {
            saveError = err.message;
        }
        saving--;
        step?.redraw();
    }

    const chapterOf = (file) => plan.chapters.find((c) => c.files.includes(file)) ?? null;

    function assign(file, chapterId) {
        const chapters = plan.chapters.map((c) => ({ ...c, files: c.files.filter((f) => f !== file) }));
        const target = chapters.find((c) => c.id === chapterId);
        if (target) target.files = [...target.files, file];
        save({ ...plan, chapters });
    }

    function addChapter(title) {
        const used = new Set(plan.chapters.map((c) => c.id));
        let n = plan.chapters.length + 1;
        while (used.has(`ch${n}`)) n++;
        const chapter = { id: `ch${n}`, title: title || `第 ${plan.chapters.length + 1} 章`, files: [] };
        save({ ...plan, chapters: [...plan.chapters, chapter] });
        return chapter;
    }

    function chapterPanel(data) {
        const box = h("div", { class: "ch-list" });
        for (const c of plan.chapters) {
            const title = h("input", { class: "an-input ch-title", type: "text", value: c.title, spellcheck: "false" });
            title.addEventListener("change", () => {
                const next = plan.chapters.map((x) => (x.id === c.id ? { ...x, title: title.value.trim() || x.id } : x));
                save({ ...plan, chapters: next });
            });
            const says = c.files.reduce((n, f) => n + (data.files.find((x) => x.file === f)?.says ?? 0), 0);
            box.append(h("div", { class: "ch-row" },
                title,
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
            const select = h("select", { class: "an-select ch-select" },
                h("option", { value: "", selected: !current }, "未分配"),
                plan.chapters.map((c) => h("option", { value: c.id, selected: current?.id === c.id }, c.title)),
                h("option", { value: "+" }, "新建章节…"));
            select.addEventListener("change", () => {
                if (select.value === "+") {
                    const chapter = addChapter();
                    assign(f.file, chapter.id);
                } else {
                    assign(f.file, select.value);
                }
            });
            const signals = f.breaks.filter((b) => b.score >= 3);
            tbody.append(h("tr", {},
                h("td", { class: "mono" }, f.file),
                h("td", {}, f.playOrder === null ? h("span", { class: "ch-dim" }, "走不到") : String(f.playOrder + 1)),
                h("td", {}, String(f.says)),
                h("td", {}, String(f.labels.length)),
                h("td", {}, signals.length ? `${signals.length} 处` : "—"),
                h("td", {}, select)));
        }
        const t = table(["30%", "88px", "72px", "72px", "96px", "20%"],
            ["文件", "游玩顺序", "台词", "label", "可能的分界", "章节"], tbody);
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
                note: "NarraLeaf 的层级是章节 → 故事：故事是一个文件，章节是装故事的分组",
            }));

            out.push(section("章节", plan.chapters.length, chapterPanel(data)));

            const warn = h("div", { class: "ch-warn" },
                h("p", {}, "分组前请确认以下事项：",
                    h("b", {}, "同一章节内不应包含属于不同章节的内容")),
                h("p", {}, "比如 c1c2.rpy 整个算第一章，那就把它整个放进第一章；但要保证这个文件里没有混进别的章节的内容。有人会把一章拆成几个文件，那就把这几个文件都放进同一个章节"),
                h("p", {}, "此项无法由程序自动校验，需人工确认"));
            out.push(section("文件分组", data.files.length, h("div", {}, warn, fileTable(data)), {
                note: "「游玩顺序」是从 start 走出来的先后，不是文件名的顺序；Ren'Py 的文件号常常和游玩顺序对不上",
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
                    note: "选「按选项拆分」时，Agent 就是按这些支线拆故事的",
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
