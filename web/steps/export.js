// Step ⑥ export: writes the supplement package the agent reads, and shows the document itself,
// so the migrator can see exactly what is being handed over before handing it over.

import { selectStep } from "../app.js";
import { fact, facts, h, section, table } from "./shared.js";
import { ensureCss, emptyState, formatTime, toolbar } from "./shared.js";

const KB = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export async function mount(host, ctx) {
    ensureCss(new URL("./analysis.css", import.meta.url).href);
    const { api, game } = ctx;
    const root = h("div", { class: "an" });
    host.append(root);

    let data = null;
    let busy = false;
    let error = null;
    let result = null;
    let copied = false;

    async function load() {
        try {
            data = await api.get(`/api/games/${game.id}/export`);
            error = null;
        } catch (err) {
            error = err.message;
        }
        draw();
    }

    async function run(dir) {
        busy = true;
        error = null;
        result = null;
        draw();
        try {
            result = await api.post(`/api/games/${game.id}/export/run`, { dir, overwrite: true });
            await ctx.refreshGame();
            data = await api.get(`/api/games/${game.id}/export`);
        } catch (err) {
            error = err.message;
        }
        busy = false;
        draw();
    }

    async function pickAndRun() {
        try {
            const res = await api.post(`/api/games/${game.id}/export/pick`);
            if (res?.cancelled) return;
            await run(res.dir);
        } catch (err) {
            error = err.message;
            draw();
        }
    }

    const reveal = (target) => api.post(`/api/games/${game.id}/reveal`, { target }).catch((err) => {
        error = err.message;
        draw();
    });

    function readinessList() {
        return h("div", { class: "an-list" }, data.readiness.steps.map((s) =>
            h("div", { class: "an-item", style: { gridTemplateColumns: "20px 1fr auto" } },
                h("span", { style: { color: s.done ? "rgb(var(--ui-success))" : "rgb(var(--ui-warning))" } }, s.done ? "✓" : "!"),
                h("span", { class: "an-item-text" },
                    h("span", {}, s.label),
                    h("span", { class: "an-snippet" }, s.at ? `${s.detail} · ${formatTime(s.at)}` : s.detail)),
                s.done ? null : h("button", {
                    type: "button",
                    class: "btn btn-quiet btn-sm",
                    onclick: () => selectStep(s.id),
                }, "前往该步骤"))));
    }

    function issueList() {
        const issues = data.readiness.issues ?? [];
        if (!issues.length) return null;
        return h("div", { class: "an-list" }, issues.map((i) =>
            h("div", { class: "an-item", style: { gridTemplateColumns: "20px 1fr" } },
                h("span", { style: { color: "rgb(var(--ui-warning))" } }, "!"),
                h("span", { class: "an-item-text" }, h("span", {}, i.message)))));
    }

    function documentView() {
        const pre = h("pre", { class: "an-doc" }, data.document);
        return h("div", {}, pre);
    }

    function draw() {
        const bar = toolbar(
            h("button", {
                type: "button",
                class: "btn btn-primary btn-sm",
                disabled: busy || !data?.document,
                onclick: () => run(data.defaultDir),
            }, busy ? "正在生成" : "生成补充包"),
            h("button", {
                type: "button",
                class: "btn btn-quiet btn-sm",
                disabled: busy || !data?.document,
                onclick: pickAndRun,
            }, "导出到其他位置…"),
            h("span", { class: "an-spacer" }),
            error ? h("span", { class: "an-value is-danger" }, error)
                : result ? h("span", { class: "an-value" }, `已生成 ${result.files.length} 个文件，${KB(result.bytes)}`)
                    : data?.lastExport ? h("span", { class: "an-value" }, `上次生成 ${formatTime(data.lastExport.at)}`) : null,
            data?.lastExport || result
                ? h("button", { type: "button", class: "btn btn-quiet btn-sm", onclick: () => reveal("work") }, "在 Finder 中显示")
                : null);
        root.replaceChildren(bar);

        if (!data) {
            root.append(emptyState(ctx.icon("layers"), error || "正在读取"));
            return;
        }
        if (!data.document) {
            root.append(emptyState(ctx.icon("layers"), "暂无扫描结果，请先执行诊断",
                h("button", { type: "button", class: "btn btn-primary", onclick: () => selectStep("diagnose") }, "前往诊断")));
            return;
        }

        const scroll = h("div", { class: "an-scroll" });
        const screens = data.files.filter((f) => f.path.startsWith("screens/")).length;
        scroll.append(facts([
            fact("文件", data.files.length, null, `含截图 ${screens} 张，共 ${KB(data.bytes)}`),
            fact("文档", KB(new Blob([data.document]).size), null, "README.md"),
            fact("准备情况", `${data.readiness.steps.filter((s) => s.done).length} / ${data.readiness.steps.length}`,
                data.readiness.steps.every((s) => s.done) ? "success" : "warning"),
            fact("上次生成", data.lastExport ? formatTime(data.lastExport.at) : "尚未生成", null,
                result ? result.dir.replace(/^\/Users\/[^/]+/, "~") : null),
        ]));

        scroll.append(section("发送给 Agent 之前", undefined,
            h("div", { class: "an-steps" },
                h("p", {}, "先安装或更新 NarraLeaf Skills："),
                h("pre", { class: "an-code" }, data.skillsCommand),
                h("p", {}, "然后将游戏源码与补充包一并发送给 Agent。补充包开头已注明需先更新 Skills"),
                h("p", {}, h("a", { class: "an-link", href: data.agentDocs, target: "_blank", rel: "noreferrer" }, "Agent 接入文档")))));

        scroll.append(section("准备情况", undefined, readinessList(), {
            note: "未完成配置也可生成，但缺失部分将由 Agent 自行推断",
        }));

        const issues = issueList();
        if (issues) {
            scroll.append(section("章节分组中的不一致项", undefined, issues, {
                note: "仅作为提示，最终分组由您决定；这些提示也会写入补充包",
            }));
        }

        const copyBtn = h("button", {
            type: "button",
            class: "btn btn-quiet btn-sm",
            onclick: async () => {
                try {
                    await navigator.clipboard.writeText(data.document);
                    copied = true;
                    draw();
                    setTimeout(() => {
                        copied = false;
                        draw();
                    }, 1500);
                } catch {
                    error = "浏览器不支持复制操作，请从生成的文件中获取";
                    draw();
                }
            },
        }, copied ? "已复制" : "复制全文");
        scroll.append(section("发送给 Agent 的文档", undefined, documentView(), {
            actions: copyBtn,
            note: "此即补充包中的 README.md，Agent 将以此为主要参考",
        }));

        const tbody = h("tbody");
        for (const f of data.files) {
            tbody.append(h("tr", {}, h("td", { class: "mono" }, f.path), h("td", {}, f.what)));
        }
        const fileTable = table(["46%", null], ["文件", "说明"], tbody);
        fileTable.classList.add("is-wrap");
        scroll.append(section("补充包文件说明", data.files.length, fileTable));
        root.append(scroll);
    }

    draw();
    await load();
    return () => {};
}
