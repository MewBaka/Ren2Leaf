// Step ⑥ export: the supplement package handed to the agent together with the game's source.
//
// One folder:
//   README.md                      the document the agent reads, first thing
//   screens/<key>.png              the screenshots step ② took, referenced from README.md
//   data/*.json                    the machine-readable output of every step
//
// Nothing here scans anything: it only reads what the earlier steps wrote into the work directory.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError, readJson } from "./http.js";
import { readDecisions, decisionStats, readChapters, chapterStats, chapterIssues } from "./decisions.js";
import { resolveGameDirs } from "./diagnose/index.js";
import { resolvePortraits } from "./portraits.js";
import { pickFolder } from "./capture.js";
import { recompressPng } from "./png.js";

export const PACKAGE_VERSION = 1;

const SKILLS_COMMAND = "npx skills add NarraLeaf/Skills -g";
const AGENT_DOCS = "https://www.narraleaf.com/zh/docs/studio/agent";
// The port skill ships with this tool rather than with NarraLeaf/Skills, which holds make-game only.
const PORT_SKILL_DIR = "skills/narraleaf-port-renpy/";
const MAX_ROWS = 80;
const MAX_SCREENS = 60;
const MAX_ELEMENTS = 30;
// Below this, two identical files are gui bits the Ren'Py template itself ships twice over.
const SMALL_ASSET = 4096;

function readJsonFile(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

/**
 * A folder name taken from the game's own name: the characters no file system accepts are
 * dropped, the rest (Chinese included) is kept, because this folder is handed to somebody.
 */
export function folderName(name, fallback = "game") {
    const s = String(name ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, " ")
        .replace(/\s+/g, "-")
        .replace(/^[-.]+|[-.\s]+$/g, "")
        .slice(0, 60);
    return s || fallback;
}

// ---------------------------------------------------------------- markdown helpers

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function mdTable(headers, rows) {
    if (!rows.length) return "";
    const head = `| ${headers.join(" | ")} |`;
    const rule = `| ${headers.map(() => "---").join(" | ")} |`;
    const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
    return [head, rule, ...body].join("\n");
}

/** Caps a list and says what was left out, pointing at the data file that has all of it. */
function capped(list, limit, where) {
    if (list.length <= limit) return { rows: list, note: "" };
    return { rows: list.slice(0, limit), note: `\n其余 ${list.length - limit} 条见 \`${where}\`\n` };
}

const yesNo = (v) => (v ? "是" : "否");

/** Numbers the subsections of one section in the order they are actually written. */
function numbering(section) {
    let n = 0;
    return (title) => `### ${section}.${++n}　${title}`;
}

const SOURCE_EXT = new Set([".rpy", ".rpym", ".py"]);

/**
 * A digest of the scripts this package was built from, so a package and a source tree can be told
 * apart later. Content only: no paths, no timestamps.
 */
export function sourceFingerprint(gamePath) {
    try {
        const { game } = resolveGameDirs(gamePath);
        const hash = crypto.createHash("sha256");
        let files = 0;
        let bytes = 0;
        const walk = (dir) => {
            for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                if (d.name.startsWith(".")) continue;
                const full = path.join(dir, d.name);
                if (d.isDirectory()) {
                    if (d.name !== "cache" && d.name !== "saves" && d.name !== "__pycache__") walk(full);
                } else if (d.isFile() && SOURCE_EXT.has(path.extname(d.name).toLowerCase())) {
                    const buf = fs.readFileSync(full);
                    hash.update(path.relative(game, full).split(path.sep).join("/"));
                    hash.update(buf);
                    files++;
                    bytes += buf.length;
                }
            }
        };
        walk(game);
        return { files, bytes, digest: hash.digest("hex").slice(0, 16) };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- the document

function headerSection(game, inventory, fingerprint) {
    const info = inventory?.game ?? {};
    const r = info.resolution;
    return [
        `# ${info.name || game.name} → NarraLeaf 迁移补充包`,
        "",
        "这份文件由 Ren2Leaf 生成，和 Ren'Py 游戏源码一起交给 Agent。它记录原作里有什么、迁移者定了什么，",
        "是源码里看不出来、或者要人来定的那部分。",
        "",
        "## 0　硬性要求",
        "",
        "1. 动手之前先更新 Skills：",
        "",
        "```bash",
        SKILLS_COMMAND,
        "```",
        "",
        `   以及本工具附带的 Ren'Py 移植 skill \`narraleaf-port-renpy\`，它在 Ren2Leaf 仓库的`,
        `   \`${PORT_SKILL_DIR}\` 下，复制到你的 agent 读取 skill 的目录即可。Agent 接入说明见 ${AGENT_DOCS}。`,
        "",
        "2. **这份文件是路牌，不是方案。** 它只说明原作的事实和迁移者的决定；具体怎么迁移由你判断，",
        "   不要被本文的措辞带着走。文中出现的任何 NarraLeaf 写法都只是参考，以 skill 和 Studio 的",
        "   `story_command` 目录为准。",
        "",
        "3. 角色一节只说明**迁移者的分组意图**；是否创建角色、怎么创建，由你决定。",
        "",
        "4. 迁移者明确保证过的事（哪个文件属于哪一章之类）照做，其余都是线索。",
        "",
        "5. 每张表都标了这一列是谁说的：**迁移者**（人确认过）、**扫描**（静态读出来的事实）、",
        "   **引擎**（截图时从运行中的游戏取的）。三者冲突时，以源码为准。",
        "",
        "## 1　这份文件说了什么",
        "",
        mdTable(["节", "内容"], [
            ["2", "游戏规格：分辨率、引擎版本、源码完整度"],
            ["3", "说话人：每个 Character 变量的证据，和迁移者的分类"],
            ["4", "Python 逻辑：每一处 `$`、python 块、非字面量的 define/default"],
            ["5", "流程与章节：迁移者定的章节分组，以及 label 图、菜单、结局"],
            ["6", "界面截图：游戏实际跑出来的画面和元素坐标"],
            ["7", "文本与演出：文字标签、插值、转场、transform、成就、persistent"],
            ["8", "资产：引用不到的文件、格式不符、重复素材、要离线处理的素材"],
            ["9", "静态扫描确定不了的，以及本工具没有检查的"],
            ["10", "这份包里的文件"],
        ]),
        "",
        "本文件里所有 `文件:行号` 都相对游戏的 `game/` 目录。",
        "",
        "## 2　游戏概况",
        "",
        mdTable(["项", "值"], [
            ["游戏名", info.name || game.name],
            ["版本", info.version || "未知"],
            ["分辨率", r ? `${r.width}×${r.height}（${r.aspectRatio}${r.is16x9 ? "" : "，不是 16:9"}）` : "未知"],
            ["引擎版本", inventory?.source?.engineVersion ? `Ren'Py ${inventory.source.engineVersion.version}` : "未知"],
            ["建议 SDK", inventory?.source?.sdkRecommendation ? `Ren'Py ${inventory.source.sdkRecommendation.exactVersion || inventory.source.sdkRecommendation.major}（把握：${inventory.source.sdkRecommendation.confidence}）` : "未知"],
            ["源码状态", {
                source: "源码完整",
                partialSource: "部分缺少源码",
                compiledOnly: "只有 .rpyc，需要先反编译",
                archivedOnly: "只有 .rpa，需要先解包",
                empty: "没有脚本",
            }[inventory?.source?.status] || "未知"],
            ["脚本文件", inventory?.source?.files ? `.rpy ${inventory.source.files.rpy}，.py ${inventory.source.files.py}，.rpyc ${inventory.source.files.rpyc}，.rpa ${inventory.source.files.rpa}` : "未知"],
            ["扫描时间", inventory?.generatedAt || "未扫描"],
            ["扫描器版本", inventory?.scanner ? `${inventory.scanner.name} ${inventory.scanner.version}（inventory v${inventory.schemaVersion}）` : "未知"],
            ["源码指纹", fingerprint ? `sha256:${fingerprint.digest}（${fingerprint.files} 个脚本，${Math.round(fingerprint.bytes / 1024)} KB）` : "没算出来"],
        ]),
        "",
        "源码指纹是生成这份包时 `game/` 下所有 `.rpy`/`.rpym`/`.py` 的内容摘要。手上的源码和它对不上，说明这份包和源码不是同一个版本。",
        "",
    ].join("\n");
}

const NPC_GROUP = "NPC / 别名";

function speakersSection(speakers, decisions, portraits) {
    if (!speakers) return "## 3　说话人\n\n这份扫描结果里没有说话人数据，回 Ren2Leaf 重新诊断一次就有了。\n";
    const answers = decisions?.speakers ?? {};
    const s = speakers.summary;
    const byVariable = new Map(speakers.speakers.map((x) => [x.variable, x]));
    const nameOf = (v) => answers[v]?.name || byVariable.get(v)?.displayName || v;
    const roleIs = (id) => speakers.speakers.filter((x) => answers[x.variable]?.role === id);
    const mergedInto = (v) => speakers.speakers.filter((x) => answers[x.variable]?.mergeInto === v);
    const picture = (x) => {
        const pic = portraits.get(x.variable);
        return pic ? `![${nameOf(x.variable)}](characters/${x.variable}${path.extname(pic.file)})` : "—";
    };
    const mergedCell = (x) => mergedInto(x.variable).map((m) => {
        const tag = m.spriteTags?.[0]?.tag ?? m.image;
        return `${m.variable}×${m.lines}${tag && tag !== m.variable ? `（立绘 ${tag}）` : ""}`;
    }).join("、") || "—";
    const totalLines = (x) => x.lines + mergedInto(x.variable).reduce((n, m) => n + m.lines, 0);

    const h = numbering(3);
    const flagText = (x) => x.flags.map((f) => f.message).join("；");
    const voiceCell = (x) => x.voiceDirs.map((v) => `${v.dir} ${v.from ?? "?"}–${v.to ?? "?"}×${v.lines}`).join("，") || "无";
    const out = ["## 3　说话人", ""];
    out.push(`共 ${s.speakers} 个 Character 变量，${s.withLines} 个有台词；台词 ${s.spokenLines} 句，旁白 ${s.narratorLines} 句，带配音 ${s.voicedLines} 句。`, "");
    out.push("迁移者把每个变量分成了四类，意思如下：", "");
    out.push(mdTable(["类别", "迁移者的意思"], [
        ["主要角色", "角色栏顶层"],
        ["POV 角色", "角色栏顶层，玩家视角"],
        [NPC_GROUP, `放进「${NPC_GROUP}」分组`],
        ["临时角色", "迁移者认为不需要独立角色（无立绘无配音的过场人物）"],
    ]), "");

    const main = roleIs("main");
    const pov = roleIs("pov");
    if (main.length || pov.length) {
        out.push(h("主要角色"), "");
        out.push(mdTable(["角色", "变量", "原显示名", "台词", "合并进来的变量", "立绘", "POV", "备注"],
            [...main, ...pov].map((x) => {
                const a = answers[x.variable];
                const merged = mergedInto(x.variable);
                return [
                    a.name || x.displayName || x.variable, x.variable, x.displayName ?? x.nameExpression ?? "（无）",
                    merged.length ? `${totalLines(x)}（本体 ${x.lines}）` : x.lines,
                    mergedCell(x), picture(x), a.role === "pov" ? "是" : "", a.note || "",
                ];
            })), "");
        if ([...main, ...pov].some((x) => mergedInto(x.variable).length)) {
            out.push("「合并进来的变量」在原作里是同一个人的另一套立绘（换装、Q 版、另一条线的造型），显示名相同：Ren'Py 一个 Character 只能绑一个侧像 tag，立绘换了 tag 作者就复制了一个 Character。迁移者已确认它们是同一个人。", "");
        }
        if (pov.length) out.push(`POV 角色是玩家的视角（${pov.map((x) => nameOf(x.variable)).join("、")}）；原作的名字框可能随章节变。`, "");
    }

    const npc = roleIs("npc");
    if (npc.length) {
        out.push(h(NPC_GROUP), "");
        out.push(`需放入「${NPC_GROUP}」分组。`, "");
        out.push(mdTable(["角色（迁移者）", "变量", "原名字框（扫描）", "台词", "配音（扫描）", "合并进来的变量", "备注"],
            npc.map((x) => {
                const a = answers[x.variable];
                return [
                    a.name || x.displayName || x.variable, x.variable,
                    x.displayName === "" ? "（空字符串）" : x.displayName ?? x.nameExpression ?? "（无）",
                    mergedInto(x.variable).length ? `${totalLines(x)}（本体 ${x.lines}）` : x.lines,
                    voiceCell(x), mergedCell(x), a.note || "",
                ];
            })), "");
        out.push("这一组里可能有同一个人换了名字框的变量（没报出身份时的「？？？」之类）；配音取号见本节后面的「配音目录与取号」。", "");
    }

    const temp = roleIs("temp");
    if (temp.length) {
        out.push(h("临时角色"), "");
        out.push("迁移者认为这些不需要独立角色。", "");
        const { rows, note } = capped(temp.map((x) => [
            answers[x.variable]?.name || x.displayName || x.variable, x.variable, x.lines, answers[x.variable]?.note || "",
        ]), MAX_ROWS, "data/speakers.json");
        out.push(mdTable(["名字", "变量", "台词", "备注"], rows), note, "");
    }

    const undecided = speakers.speakers.filter((x) => x.lines && !answers[x.variable]?.role && !answers[x.variable]?.mergeInto);
    const removed = roleIs("removed");
    if (undecided.length) {
        out.push(h("迁移者没分类的"), "");
        out.push("这些没有人确认过，下面是扫描到的证据。", "");
        const { rows, note } = capped(undecided.map((x) => [
            x.variable, x.displayName ?? x.nameExpression ?? "（无）", x.lines,
            x.voiceDirs.map((v) => `${v.dir} ${v.from ?? "?"}–${v.to ?? "?"}×${v.lines}`).join("，") || "无配音",
            x.spriteTags.slice(0, 3).map((t) => t.tag).join("，") || "—",
            x.flags.map((f) => f.message).join("；"),
        ]), MAX_ROWS, "data/inventory.json");
        out.push(mdTable(["变量", "显示名", "台词", "配音目录", "立绘 tag", "扫描看到的"], rows), note, "");
    }

    if (removed.length) {
        out.push(h("迁移者拿掉的"), "");
        out.push("迁移者把这些从名单里拿掉了（调试用的、根本不出场的之类）。扫描看到的东西照原样列在这里。", "");
        out.push(mdTable(["变量", "原名字框（扫描）", "台词", "配音（扫描）", "扫描看到的"],
            removed.slice(0, MAX_ROWS).map((x) => [
                x.variable, x.displayName === "" ? "（空字符串）" : x.displayName ?? "（无）", x.lines, voiceCell(x), flagText(x),
            ])), "");
    }

    const narratorStyle = speakers.speakers.filter((x) => x.flags.some((f) => f.kind === "narratorStyle"));
    if (narratorStyle.length) {
        out.push(h("名字框是空的变量"), "");
        out.push('这些变量是 `Character("")`：名字框存在但里面没有字，原作用它做一种文本样式（黑底居中、内心独白之类），不是一个人。带配音的行说明有角色在这个样式下说话，配音目录指向的就是那个角色。', "");
        out.push(mdTable(["变量", "台词", "配音（扫描）", "迁移者的分类", "出现在"],
            narratorStyle.slice(0, MAX_ROWS).map((x) => [
                x.variable, x.lines, voiceCell(x),
                { main: "主要角色", pov: "POV 角色", npc: NPC_GROUP, temp: "临时角色", removed: "拿掉了" }[answers[x.variable]?.role] ?? "没分类",
                x.files.slice(0, 3).map((f) => `${f.file}×${f.lines}`).join("，"),
            ])), "");
    }

    if (speakers.voiceDirs.length) {
        out.push(h("配音目录与取号"), "");
        out.push("取号是配音文件名里的序号。一位声优的取号通常是贯穿全作的一条连号，几个变量分着用同一条连号，说明是同一个人换了名字框。", "");
        out.push(mdTable(["目录", "台词", "说出它的变量（取号范围）"],
            speakers.voiceDirs.slice(0, MAX_ROWS).map((d) => [
                d.dir, d.lines,
                d.variables.map((v) => `${v.variable} ${v.from ?? "?"}–${v.to ?? "?"}（${v.lines} 句）`).join("，"),
            ])), "");
    }

    if (speakers.inlineSpeakers.length) {
        out.push(h("一次性说话人"), "");
        out.push("源码里写成 `\"名字\" \"台词\"` 的行，没有对应的 Character 变量。", "");
        out.push(mdTable(["名字", "台词数", "出现在"],
            speakers.inlineSpeakers.slice(0, MAX_ROWS).map((x) => [x.name, x.lines, x.files.map((f) => f.file).join("，")])), "");
    }
    return `${out.join("\n")}\n`;
}

function pythonSection(python) {
    if (!python) return "## 4　Python 逻辑\n\n这份扫描结果里没有 Python 数据，回 Ren2Leaf 重新诊断一次就有了。\n";
    const s = python.summary;
    const h = numbering(4);
    const out = ["## 4　Python 逻辑", ""];
    out.push(`共 ${s.total} 条。其中字面量赋值 ${s.autoConvertible} 条，映射表里有的 API ${(python.apiUsage ?? []).reduce((n, a) => n + a.count, 0)} 处，没有现成对应的 ${s.needsAgent} 条，静态确定不了的 ${s.unresolvable} 条，界面与选项配置 ${s.configuration} 条，函数或类内部的名字 ${s.localAssigns ?? 0} 条。`, "");
    out.push("只有 label 里的 `$` 行、顶层 python 块和 `default`/`define` 会动到故事状态。函数体和类体里的名字是局部的，下面按函数折叠，不按行列。", "");

    const auto = python.entries.filter((e) => e.category === "autoSet");
    if (auto.length) {
        out.push(h("字面量赋值"), "");
        out.push("值是字面量，没有表达式。", "");
        const { rows, note } = capped(auto.map((e) => [`${e.file}:${e.line}`, e.label || "—", e.snippet, e.suggestion]), MAX_ROWS, "data/inventory.json");
        out.push(mdTable(["位置", "label", "原文", "映射表里的写法"], rows), note, "");
    }

    if (python.apiUsage?.length) {
        out.push(h("用到的 Ren'Py API"), "");
        out.push("「映射表里的写法」来自移植 skill 的 `statement-mapping.md`，只作参考。", "");
        out.push(mdTable(["API", "次数", "映射表里的写法", "说明"],
            python.apiUsage.map((a) => [a.api, a.count, a.target || "—", a.note || ""])), "");
    }

    const needsAll = python.entries.filter((e) => e.category === "needsAgent" || e.category === "unresolvable");
    const needs = needsAll.filter((e) => !e.nested);
    const inBodies = needsAll.filter((e) => e.nested);
    if (needs.length) {
        out.push(h("映射表里没有现成对应的"), "");
        if (inBodies.length) out.push(`另有 ${inBodies.length} 条在函数或类的内部，不在这张表里；它们按函数列在后面。`, "");
        const { rows, note } = capped(needs.map((e) => [
            `${e.file}:${e.line}`, e.label || "—", e.snippet, e.suggestion || "—", e.reason || "",
        ]), MAX_ROWS, "data/inventory.json");
        out.push(mdTable(["位置", "label", "原文", "映射表里的写法", "扫描看到的"], rows), note, "");
    }

    if (python.customStatements?.length) {
        out.push(h("自定义语句"), "");
        out.push("`renpy.register_statement` 注册的语句，Ren'Py 之外没有对应写法，每一处用法都要单独决定。", "");
        out.push(mdTable(["语句", "定义", "用了几处", "示例位置"],
            python.customStatements.map((c) => [c.name || "（名字不是字面量）", `${c.file}:${c.line}`, c.usageCount ?? 0, (c.usages ?? []).slice(0, 3).map((u) => `${u.file}:${u.line}`).join("，")])), "");
    }

    if (python.functions?.length) {
        out.push(h("游戏自己的函数"), "");
        out.push("「包的是」一列是函数体里唯一那个已知 API：这种函数的每一处调用，和直接调用那个 API 是一回事。", "");
        const { rows, note } = capped(python.functions.map((f) => [
            f.name, `${f.file}:${f.line}`, f.calls, f.bodyLines ?? 0, f.wraps || "—",
            (f.apis ?? []).join("、") || "—",
        ]), MAX_ROWS, "data/inventory.json");
        out.push(mdTable(["函数", "定义", "调用次数", "函数体行数", "包的是", "体内用到的 API"], rows), note, "");
    }

    if (python.unknownStatements?.length) {
        out.push(h("扫描器没认出来的语句"), "");
        out.push("扫描器没有识别这些语句的开头。可能是别处注册的自定义语句，也可能是扫描器的漏洞。", "");
        out.push(mdTable(["开头", "处数", "示例"],
            python.unknownStatements.slice(0, MAX_ROWS).map((u) => [u.word, u.count, u.sites.slice(0, 2).map((x) => `${x.file}:${x.line}`).join("，")])), "");
    }

    if (python.variables?.length) {
        out.push(h("变量"), "");
        out.push("原作用 `default` 声明的是会变的量，`define` 的多半是常量。角色、位置、转场这类 `define`（值是 `Character(…)`、`Transform(…)` 之类）不在这张表里。", "");
        const { rows, note } = capped(python.variables.map((v) => [v.name, v.declaredBy, `${v.file}:${v.line}`, v.writes]), MAX_ROWS, "data/inventory.json");
        out.push(mdTable(["变量", "来自", "首次出现", "写入次数"], rows), note, "");
        if (python.notVariables?.length) {
            out.push(`从这张表里剔掉的 ${python.notVariables.length} 个名字（它们是角色、图像或转场的定义）：${python.notVariables.slice(0, 40).map((v) => `\`${v.name}\`${v.constructor ? `（${v.constructor}）` : ""}`).join("、")}${python.notVariables.length > 40 ? " …" : ""}`, "");
        }
    }

    if (python.persistent?.length) {
        out.push(h("persistent 变量"), "");
        out.push("`persistent.*` 跨存档保留：原作用它记周目、画廊、成就这类状态。走不到的分支常常是被它挡住的。", "");
        out.push(mdTable(["变量", "来自", "初值", "首次出现", "写入次数"],
            python.persistent.slice(0, MAX_ROWS).map((v) => [
                v.name, v.declaredBy ?? "赋值", v.hasInitial ? JSON.stringify(v.value) : "—", v.file ? `${v.file}:${v.line}` : "—", v.writes,
            ])), "");
    }

    if (inBodies.length) {
        out.push(h("函数与类内部"), "");
        out.push("这些行在函数体或类体里（解密器、音量函数、文字速度预览这类运行时设施居多），按定义它们的地方折叠。", "");
        const byFunc = new Map();
        for (const e of inBodies) {
            const key = `${e.file}::${e.func ?? e.inClass ?? "—"}`;
            const row = byFunc.get(key) ?? { file: e.file, func: e.func ?? e.inClass ?? "—", lines: 0, from: e.line, to: e.line };
            row.lines++;
            row.from = Math.min(row.from, e.line);
            row.to = Math.max(row.to, e.line);
            byFunc.set(key, row);
        }
        const rows = [...byFunc.values()].sort((a, b) => b.lines - a.lines).slice(0, MAX_ROWS)
            .map((r) => [r.func, r.file, `${r.from}–${r.to}`, r.lines]);
        out.push(mdTable(["函数或类", "文件", "行", "条数"], rows), "");
    }
    return `${out.join("\n")}\n`;
}

const MODE_TEXT = {
    none: {
        title: "不拆分",
        means: "迁移者的意思是：全部剧本属于同一个章节，不再往下切。",
    },
    choices: {
        title: "按选项拆分",
        means: "迁移者的意思是：选项（menu）引出的支线各自成为独立的故事，主线留在本章的主故事里。",
    },
    full: {
        title: "全拆分",
        means: "迁移者的意思是：一个剧本文件对应一个故事。",
    },
};

function chaptersSection(flow, plan) {
    // `files` arrived with the chapter step; an inventory from before it is too old to use here.
    if (!flow?.files) return "## 5　流程与章节\n\n这份扫描结果里没有流程数据，回 Ren2Leaf 重新诊断一次就有了。\n";
    const s = flow.summary;
    const h = numbering(5);
    const out = ["## 5　流程与章节", ""];
    out.push("NarraLeaf 的层级是**章节 → 故事**：故事是一个文件，章节是装故事的分组。下面是迁移者定的分组。", "");

    const mode = MODE_TEXT[plan?.mode] ?? null;
    if (mode) out.push(`**拆分方式：${mode.title}。** ${mode.means}`, "");
    else out.push("迁移者没有选拆分方式。", "");

    const planned = plan?.chapters ?? [];
    const assigned = new Set(planned.flatMap((c) => c.files));
    if (planned.length) {
        out.push(h("章节与文件"), "");
        out.push(mdTable(["章节", "文件", "台词", "备注"],
            planned.map((c) => [
                c.title,
                c.files.join("、") || "（空）",
                c.files.reduce((n, f) => n + (flow.files.find((x) => x.file === f)?.says ?? 0), 0),
                c.note || "",
            ])), "");
        out.push("⚠️ **一个文件只属于一个章节，而且文件里不会跨到别的章节**——这是迁移者保证的，扫描查不了。", "");
        const issues = chapterIssues(plan, flow.files);
        if (issues.length) {
            out.push("这份分组里有几处前后不一致，扫描只报出来，怎么处理由你判断：", "");
            for (const i of issues) out.push(`- ${i.message}`);
            out.push("");
        }
    } else {
        out.push(h("章节与文件"), "", "迁移者还没有分组。", "");
    }

    const left = flow.files.filter((f) => !assigned.has(f.file));
    if (planned.length && left.length) {
        out.push("没有分进任何章节的文件（多半是配置、界面或废稿）：", "");
        out.push(mdTable(["文件", "台词", "label"], left.map((f) => [f.file, f.says, f.labels.length])), "");
    }

    out.push(h("每个文件里有什么"), "");
    out.push("「游玩顺序」是从 `start` 走出来的先后，不是文件名的顺序。被 `persistent.*` 条件挡住的路线（二周目之类）排在一周目路线之后，并在「周目」一列标出来。", "");
    const { rows, note } = capped(flow.files.map((f) => [
        f.file, f.playOrder === null ? "走不到" : f.playOrder + 1, f.newGamePlus ? "要 persistent 条件" : "", f.says, f.labels.length, f.menus,
        f.labels.slice(0, 4).map((l) => l.name).join("、") + (f.labels.length > 4 ? "…" : ""),
    ]), MAX_ROWS, "data/inventory.json");
    out.push(mdTable(["文件", "游玩顺序", "周目", "台词", "label", "菜单", "label 名"], rows), note, "");

    out.push(h("流程事实"), "");
    out.push(`${s.labels} 个 label，可达 ${s.reachable} 个，走不到 ${s.unreachable} 个；菜单 ${s.menus} 个（${s.choices} 个选项），结局 ${s.endings} 个。`, "");
    for (const w of flow.warnings) out.push(`- ${w.message}`);
    out.push("");

    if (flow.menus.length) {
        out.push("#### 菜单与选项", "");
        out.push("「选项里写了什么」是选中之后、走出这个选项之前的赋值：路线常常就是这样分开的，所以没有跳转的选项不等于什么都没做。", "");
        const rows2 = [];
        for (const m of flow.menus.slice(0, MAX_ROWS)) {
            for (const c of m.choices) {
                rows2.push([
                    `${m.file}:${m.line}`, m.label || "—", c.text, c.condition || "—",
                    (c.sets ?? []).map((x) => x.snippet).join("；") || "—",
                    c.target || "顺序往下",
                ]);
            }
        }
        out.push(mdTable(["菜单", "所属 label", "选项", "条件", "选项里写了什么", "去向"], rows2), "");
    }

    if (flow.endings.length) {
        out.push("#### 结局", "", "这些 label 以 `return` 收尾，没有后续跳转，也不是被 `call` 进来的子流程。", "");
        out.push(mdTable(["label", "位置", "台词", "周目", "判断"],
            flow.endings.map((e) => [
                e.name, `${e.file}:${e.line}`, e.says, e.newGamePlus ? "要 persistent 条件" : "", e.kind === "startEnd" ? "start 自己走到尾（主线以 call 串起来时，这里就是主线的终点）" : e.kind === "namedEnding" ? "名字像结局" : "以 return 收尾",
            ])), "");
    }

    if (flow.notEndings?.length) {
        out.push("#### 以 return 收尾但不是结局的", "", "这些也以 `return` 收尾，但 `return` 不是终点。", "");
        out.push(mdTable(["label", "位置", "台词", "为什么不是结局"],
            flow.notEndings.slice(0, MAX_ROWS).map((e) => [e.name, `${e.file}:${e.line}`, e.says, e.reason])), "");
    }

    if (flow.subroutines?.length) {
        out.push("#### 被 call 进来的 label", "", "`call` 和 `jump` 不一样：这些 label 跑完会回到调用它的那一行，后面的语句接着跑。", "");
        out.push(mdTable(["label", "位置", "台词", "被 call 次数", "调用处"],
            flow.subroutines.slice(0, MAX_ROWS).map((e) => [e.name, `${e.file}:${e.line}`, e.says, e.calledFrom, e.callers.join("，")])), "");
    }

    if (flow.unreachable.length) {
        out.push("#### 走不到的 label", "");
        const { rows: r3, note: n3 } = capped(flow.unreachable.map((l) => [l.name, `${l.file}:${l.line}`, l.says, l.reason]), MAX_ROWS, "data/inventory.json");
        out.push(mdTable(["label", "位置", "台词", "原因"], r3), n3, "");
    }

    if (flow.dynamicTargets.length) {
        out.push("#### 运行时才知道目标的跳转", "", "这些边不在图上，上面的可达性可能少算。", "");
        out.push(mdTable(["位置", "所属", "写法", "表达式"],
            flow.dynamicTargets.slice(0, MAX_ROWS).map((e) => [`${e.file}:${e.line}`, e.label || e.screen || "—", e.kind, e.expr || "—"])), "");
    }
    return `${out.join("\n")}\n`;
}

function coverage(shots, screens) {
    const shot = new Set(shots.flatMap((s) => s.meta.find((m) => m[0] === "界面")?.[1]?.split("、") ?? []).map((n) => n.trim()).filter(Boolean));
    return (screens ?? [])
        .filter((s) => s.defined && s.classification !== "layout")
        .map((s) => ({
            name: s.name, category: s.category === "standard" ? "标准" : "自定义",
            shot: shot.has(s.name),
            actions: Object.entries(s.actions ?? {}).map(([k, v]) => `${k}×${v}`).join("、"),
        }))
        .sort((a, b) => Number(a.shot) - Number(b.shot) || a.name.localeCompare(b.name));
}

function screenshotSection(shots, screens) {
    if (!shots.length) return "## 6　界面截图\n\n没有截图。界面的位置和尺寸只能从代码推，误差很大；回 Ren2Leaf 跑一次截图步骤才会有。\n";
    const out = ["## 6　界面截图", ""];
    out.push("迁移者一边玩一边截的**游戏实际画面**，元素坐标来自引擎，不是从代码推的。坐标是 `x, y, 宽, 高`，按截图分辨率。字号、颜色、描边、对齐不在截图数据里，要自己读 `screens.rpy` 和 gui 变量。", "");
    const screenOf = (s) => s.meta.find((m) => m[0] === "界面")?.[1] || "—";
    out.push(mdTable(["截图", "对应界面", "图", "元素", "说明"],
        shots.map((s) => [s.title, screenOf(s), `[${s.image}](${s.image})`, s.elements.length, s.note || ""])), "");
    const perScreen = new Map();
    for (const s of shots) perScreen.set(screenOf(s), (perScreen.get(screenOf(s)) || 0) + 1);
    const twice = [...perScreen.entries()].filter(([name, n]) => n > 1 && name !== "—");
    if (twice.length) out.push(`同一个界面截了不止一张：${twice.map(([name, n]) => `${name}×${n}`).join("、")}。`, "");

    const rows = coverage(shots, screens);
    if (rows.length) {
        out.push("源码里定义的界面，哪些有截图：", "");
        out.push(mdTable(["界面", "来自", "有截图", "界面里的 action"],
            rows.slice(0, MAX_ROWS).map((r) => [r.name, r.category, r.shot ? "有" : "没有", r.actions || "—"])), "");
    }

    const h = numbering(6);
    for (const s of shots) {
        out.push("", h(s.title), "");
        if (s.note) out.push(s.note, "");
        out.push(`![${s.title}](${s.image})`, "");
        if (s.meta.length) out.push(mdTable(["项", "值"], s.meta), "");
        const rows = s.elements
            .filter((e) => e.boxed || e.type === "Text" || e.type === "Button")
            .slice(0, MAX_ELEMENTS)
            .map((e) => [
                e.type + (e.class ? `（${e.class}）` : ""),
                (e.rect || []).join(", "),
                e.label || e.text || e.image || "—",
                e.location ? `${e.location[0]}:${e.location[1]}` : "—",
            ]);
        if (rows.length) out.push(mdTable(["元素", "位置 x, y, w, h", "文字或图片", "定义处"], rows), "");
        for (const c of s.crops) out.push(`- 切图 ${c.label || c.type || c.n}：[${c.image}](${c.image})（${(c.rect || []).join(", ")}）`);
        if (s.crops.length) out.push("");
    }
    return `${out.join("\n")}\n`;
}

/** Section 7: what the dialogue and the staging are made of, counted. */
function factsSection(facts) {
    if (!facts) return "## 7　文本与演出\n\n这份扫描结果里没有这部分数据，回 Ren2Leaf 重新诊断一次就有了。\n";
    const f = facts.summary;
    const h = numbering(7);
    const out = ["## 7　文本与演出", ""];
    out.push(`带文字标签的台词 ${f.textTagLines} 句（${f.textTagKinds} 种标签），带 \`[变量]\` 插值的 ${f.interpolatedLines} 句，\`extend\` 续接 ${f.extendLines} 句，说话时顺便换立绘的 ${f.attributedSays} 句；转场 ${f.transitions} 处，\`at\` 上的 transform ${f.atClauses} 处，\`window\` 语句 ${f.windowStatements} 条，\`pause\` ${f.pauses} 处，成就 ${f.achievements} 个、解锁点 ${f.achievementUnlocks} 处。`, "");

    if (facts.textTags.length) {
        out.push(h("台词里的文字标签"), "");
        out.push("Ren'Py 的 `{…}` 标签写在台词文本里。", "");
        out.push(mdTable(["标签", "处数", "示例位置"],
            facts.textTags.map((t) => [`{${t.name}}`, t.count, t.sites.slice(0, 3).join("，")])), "");
    }

    if (facts.interpolations.length) {
        out.push(h("台词里的变量插值"), "");
        out.push(mdTable(["写法", "处数", "示例位置"],
            facts.interpolations.map((t) => [`[${t.name}]`, t.count, t.sites.slice(0, 3).join("，")])), "");
    }

    if (facts.attributedSays.lines) {
        out.push(h("说话行自带立绘属性"), "");
        out.push("原作里 `eileen happy sit \"…\"` 这种行，说这句话的同时把立绘换了。", "");
        out.push(mdTable(["变量", "处数", "示例位置"],
            facts.attributedSays.speakers.map((x) => [x.name, x.count, x.sites.slice(0, 3).join("，")])), "");
        if (facts.attributedSays.attributes.length) {
            out.push(`用到的属性：${facts.attributedSays.attributes.map((a) => `\`${a.name}\`×${a.count}`).join("、")}`, "");
        }
    }

    if (facts.transitions.length) {
        out.push(h("转场"), "");
        out.push(mdTable(["转场", "处数", "示例位置"],
            facts.transitions.map((t) => [t.name, t.count, t.sites.slice(0, 3).join("，")])), "");
    }

    if (facts.transforms.used.length) {
        out.push(h("立绘上的 transform"), "");
        out.push(mdTable(["transform", "用了几处", "示例位置"],
            facts.transforms.used.map((t) => [t.name, t.count, t.sites.slice(0, 3).join("，")])), "");
        if (facts.transforms.longLoopCount) {
            out.push(`其中 ${facts.transforms.longLoopCount} 处带 9999 这种参数，这个位置上通常是循环次数，等于一直动下去（原作靠换画面或 \`hide\` 把它冲掉）；transform 的定义本工具没有读，参数的含义要自己看一眼：`, "");
            out.push(mdTable(["位置", "transform", "对象", "参数"],
                facts.transforms.longLoops.map((t) => [`${t.file}:${t.line}`, t.transform, t.tag || "—", t.arguments || "—"])), "");
        }
    }

    if (facts.window.length || facts.nvl.length) {
        out.push(h("对话框与 NVL"), "");
        out.push(mdTable(["语句", "处数"],
            [...facts.window.map((w) => [`window ${w.name}`, w.count]), ...facts.nvl.map((n) => [`nvl ${n.name}`, n.count])]), "");
    }

    const ach = facts.achievements ?? {};
    if (ach.declared?.length || ach.granted?.length) {
        out.push(h("成就"), "");
        if (ach.wrappers?.length) {
            out.push(`原作把 \`achievement.grant\` 包在 ${ach.wrappers.map((w) => `\`${w}()\``).join("、")} 里，下面的解锁点算的是这个函数的调用处。`, "");
        }
        if (ach.declared.length) {
            out.push(`\`achievement.register\` 声明了 ${ach.declared.length} 个：${ach.declared.map((a) => a.name || "?").join("、")}`, "");
        }
        if (ach.granted.length) {
            out.push(mdTable(["成就", "解锁处数", "怎么解锁的", "位置"],
                ach.granted.slice(0, MAX_ROWS).map((a) => [a.name, a.grants, (a.via ?? []).join("、"), a.sites.slice(0, 3).join("，")])), "");
        }
    }

    if (facts.audio.length) {
        out.push(h("音频语句"), "");
        out.push(`用到 ${f.audioFiles} 个音频文件。`, "");
        out.push(mdTable(["语句", "处数"], facts.audio.map((a) => [a.name, a.count])), "");
    }
    return `${out.join("\n")}\n`;
}

/** How big a pile of files is, in the unit a person reads. */
function mb(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** What the script points at, and what is in game/. Facts only: no file is edited or converted. */
function assetsSection(assets) {
    if (!assets) return "## 8　资产\n\n这份扫描结果里没有这部分数据，回 Ren2Leaf 重新诊断一次就有了。\n";
    const a = assets.summary;
    const h = numbering(8);
    const out = ["## 8　资产", ""];
    out.push("Ren'Py 找文件的办法是：先按脚本里写的路径找，找不到再在 `images/`（图像）或 `audio/`（音频）下找一次，并且不分大小写。下面的比对照这个规则来。", "");
    out.push(`${a.imageDefinitions} 条 \`image\` 定义，引用了 ${a.referencedPaths} 个文件路径（图像 ${a.imageReferences} 处、音频 ${a.audioReferences} 处）`
        + (a.resolvedViaPrefix ? `，其中 ${a.resolvedViaPrefix} 处是靠 \`images/\`、\`audio/\` 前缀才找到的` : "")
        + `。\`show\`/\`scene\` 用到 ${a.shownTags} 个 tag。game/ 下媒体文件 ${a.mediaFiles} 个，共 ${mb(a.mediaBytes)}。`, "");
    if (assets.notes?.archives) {
        out.push(`另有 ${assets.notes.archives} 个 \`.rpa\` 归档，本工具不解包；下面说「没有」的文件有可能在归档里。`, "");
    }

    const beforeFindings = out.length;
    if (assets.missing.length) {
        out.push(h("引用了但 game/ 里没有的文件"), "");
        if (a.missingSuperseded) {
            out.push(`共 ${a.missingPaths} 个，其中 ${a.missingSuperseded} 个出自后来又被同名定义覆盖掉的那一条（游戏跑的是后一条，所以这几个文件缺着也不影响）。`, "");
        } else {
            out.push(`共 ${a.missingPaths} 个。`, "");
        }
        const { rows, note } = capped(assets.missing.map((r) => [
            r.path, r.kind === "audio" ? "音频语句" : "image 定义", r.statements.join("、"), r.sites.slice(0, 3).join("，"),
            r.superseded ? "被同名定义覆盖" : yesNo(r.tagShown),
        ]), MAX_ROWS, "data/inventory.json");
        out.push(mdTable(["路径", "引用来源", "引用它的语句", "位置", "tag 在剧情里出现过"], rows), note, "");
        out.push("最后一列只说这个定义的 tag 在 `show`/`scene` 里出现过。一个 tag 通常有几十条只差属性的定义，哪一行落到哪一条取决于当时舞台上带着什么属性，本工具没有算。", "");
    }

    if (assets.caseMismatch.length) {
        out.push(h("大小写和磁盘上不一致的引用"), "");
        out.push("Ren'Py 查文件不分大小写，所以原作跑得起来。", "");
        out.push(mdTable(["脚本里写的", "磁盘上的", "引用处数", "位置"],
            assets.caseMismatch.map((r) => [r.path, r.onDisk || "—", r.references, r.sites.slice(0, 3).join("，")])), "");
    }

    if (assets.unknownTags.length) {
        out.push(h("show / scene 用了但没有定义的 tag"), "");
        out.push("既没有 `image` 定义，`game/images/` 下也没有同名文件。", "");
        out.push(mdTable(["tag", "用了几处", "语句", "位置"],
            assets.unknownTags.map((t) => [t.tag, t.uses, t.statements.join("、"), t.sites.slice(0, 3).join("，")])), "");
    }

    if (assets.unknownCharacterImages.length) {
        out.push(h("角色 image= 指向的 tag 没有对应图像"), "");
        out.push("原作写了 `Character(…, image=\"x\")`，但没有叫 `x` 的 image 定义，`game/images/` 下也没有同名文件。这个 tag 只在「只写属性的台词」（`x happy \"…\"`）里才会被用到。", "");
        out.push(mdTable(["tag", "位置"],
            assets.unknownCharacterImages.map((t) => [t.tag, t.sites.slice(0, 3).join("，")])), "");
    }

    if (assets.formatMismatch.length) {
        out.push(h("扩展名和真实格式不符"), "");
        out.push("按文件头几个字节判断的。", "");
        out.push(mdTable(["文件", "扩展名", "文件头说它是", "大小"],
            assets.formatMismatch.map((f) => [f.path, f.extension, f.actualName || f.actual, mb(f.bytes)])), "");
    }

    if (assets.duplicates.length) {
        out.push(h("内容完全相同的文件"), "");
        out.push(`${a.duplicateGroups} 组、${a.duplicateFiles} 个文件，重复的那几份占 ${mb(a.wastedBytes)}。先按字节数分桶，只有字节数相同的才算 sha256。`, "");
        const big = assets.duplicates.filter((d) => d.bytes >= SMALL_ASSET);
        const small = assets.duplicates.length - big.length;
        const { rows, note } = capped(big.map((d) => [mb(d.bytes), d.files.join("、")]), MAX_ROWS, "data/inventory.json");
        out.push(mdTable(["大小", "内容相同的文件"], rows), note, "");
        if (small) out.push(`另有 ${small} 组每份都不到 ${Math.round(SMALL_ASSET / 1024)} KB，列在 \`data/inventory.json\` 里（Ren'Py 模板自带的 gui 图本来就有好几组是一样的）。`, "");
    }

    const off = assets.offline ?? {};
    if (off.maskedMovies?.length || off.matrixColor?.length || off.formats?.length) {
        out.push(h("要离线处理的素材"), "");
        if (off.maskedMovies?.length) {
            out.push(`带遮罩的 \`Movie\` ${a.maskedMovies} 处：画面和透明通道是两个视频文件。`, "");
            const { rows, note } = capped(off.maskedMovies.map((m) => [m.name, m.play || "—", m.mask || "—", `${m.file}:${m.line}`]), MAX_ROWS, "data/inventory.json");
            out.push(mdTable(["image 名", "画面", "遮罩", "位置"], rows), note, "");
        }
        if (off.matrixColor?.length) {
            out.push(`\`im.*\` 调色图 ${a.matrixColor} 条：同一张图在运行时被改了颜色。`, "");
            const { rows, note } = capped(off.matrixColor.map((x) => [x.name, x.constructor, x.source || "—", `${x.file}:${x.line}`]), MAX_ROWS, "data/inventory.json");
            out.push(mdTable(["image 名", "构造器", "原图", "位置"], rows), note, "");
        }
        if (off.formats?.length) {
            out.push("浏览器放不了的格式：", "");
            out.push(mdTable(["扩展名", "类别", "文件数", "脚本里引用处数", "示例文件"],
                off.formats.map((f) => [f.extension, f.kind, f.count, f.referenced, f.files.slice(0, 3).join("、")])), "");
        }
    }

    if (assets.redefined.length) {
        out.push(h("同一个 image 名定义了多次"), "");
        out.push("Ren'Py 取最后一条。", "");
        out.push(mdTable(["image 名", "定义了几次", "位置", "指向的文件"],
            assets.redefined.map((r) => [r.name, r.count, r.sites.join("，"), r.paths.join("、")])), "");
    }

    if (out.length === beforeFindings) out.push("没有发现引用不到的文件、格式不符或重复的素材。", "");
    return `${out.join("\n")}\n`;
}

/** What the scan could not settle, and what it never looked at. */
function reviewSection(inventory) {
    const review = inventory?.needsReview ?? [];
    const h = numbering(9);
    const out = ["## 9　扫描确定不了的", ""];
    out.push(h("名字或目标是运行时拼出来的"), "");
    if (!review.length) out.push("没有这类条目。", "");
    else {
        out.push("这些地方静态读不出来，要看运行时。", "");
        const { rows, note } = capped(review.map((r) => [`${r.file || "—"}${r.line ? `:${r.line}` : ""}`, r.label || r.screen || "—", r.message]), MAX_ROWS, "data/inventory.json");
        out.push(mdTable(["位置", "所属", "说明"], rows), note, "");
    }
    out.push(h("本工具没有检查的"), "");
    out.push("下面这些 Ren2Leaf 没有查过，这份文件里的任何一节都不代表它们没问题：", "");
    out.push(mdTable(["没查的", "要自己确认什么"], [
        ["素材本身的内容", "第 8 节查了文件在不在、格式对不对、有没有重复；图片的尺寸和透明边、音频的时长和音量、视频的帧率，没有看"],
        ["哪一行落到哪一张立绘", "第 8 节只按 tag 比对；一个 tag 下几十条只差属性的定义，哪一行用哪一条要运行时才知道"],
        ["ATL 动画本身", "transform 的内容只统计了用在哪里，没有读它做了什么；带 `repeat` 的循环只按参数数值猜"],
        ["翻译目录", "`tl/` 里是真译文还是只有引擎字符串"],
        ["字体", "界面和台词用了哪些字体文件"],
        ["界面文字样式", "截图给的是坐标和文字，字号、颜色、描边、对齐要自己从 `screens.rpy` 和 gui 变量里读"],
        ["按钮动作", "每个按钮的 `action`（`ShowMenu(…)`、`Start()` 之类）没有逐个列出，截图一节只给了元素"],
        ["画廊与回想", "有哪些条目、各自的解锁条件"],
        [".rpa / .rpyc", "归档和只有字节码的文件没有解包，里面的脚本和界面不在本文件里"],
    ]), "");
    return `${out.join("\n")}\n`;
}

function filesSection(files) {
    const out = ["## 10　这份包里的文件", ""];
    out.push(mdTable(["文件", "是什么"], files.map((f) => [f.path, f.what])), "");
    out.push("`data/inventory.json` 是完整的扫描结果，本文件里被截断的表都能在它里面找到全量。", "");
    return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------- package

/** Everything the package needs, read from the work directory. */
export function collect(game) {
    const workDir = game.workDir;
    const inventory = readJsonFile(path.join(workDir, "inventory.json"));
    const decisions = readDecisions(workDir);
    const chapters = readChapters(workDir);
    // Only the characters the migrator kept get their picture in the package.
    const speakers = inventory?.extensions?.speakers?.speakers ?? [];
    const wanted = speakers.filter((sp) => ["main", "pov", "npc"].includes(decisions.speakers?.[sp.variable]?.role));
    let portraits = new Map();
    try {
        portraits = wanted.length ? resolvePortraits(game, wanted) : new Map();
    } catch {
        portraits = new Map();
    }

    const shots = [];
    for (const name of (fs.existsSync(path.join(workDir, "manual")) ? fs.readdirSync(path.join(workDir, "manual")) : [])) {
        const dir = path.join(workDir, "manual", name);
        const meta = readJsonFile(path.join(dir, "meta.json"));
        const full = path.join(dir, "full.png");
        if (!meta || !fs.existsSync(full)) continue;
        const data = readJsonFile(path.join(dir, "elements.json"), {});
        shots.push({
            key: name,
            title: meta.purpose || (meta.screens ?? []).join("、") || name,
            note: meta.purpose ? `迁移者标注：${meta.purpose}` : "",
            file: full,
            image: `screens/${name}.png`,
            elements: data.elements ?? [],
            gameSize: meta.gameSize ?? null,
            meta: [
                ["界面", (meta.screens ?? []).join("、") || "—"],
                ["分辨率", (meta.gameSize ?? []).join("×") || "—"],
                ["来源", meta.location ? `${meta.location[0]}:${meta.location[1]}` : "—"],
            ],
            crops: (meta.crops ?? []).map((c) => ({ ...c, from: path.join(dir, c.file), image: `screens/${name}-${c.file}` })),
            elementsFile: path.join(dir, "elements.json"),
        });
    }
    return {
        inventory, decisions, chapters, portraits,
        shots: shots.slice(0, MAX_SCREENS),
        fingerprint: sourceFingerprint(game.path),
    };
}

/** What is ready and what is missing, for the step header. */
export function readiness(game, parts) {
    const { inventory, decisions, chapters, shots } = parts;
    const issues = chapterIssues(chapters ?? { chapters: [] }, inventory?.extensions?.flow?.files ?? []);
    const stats = decisionStats(decisions);
    const plan = chapterStats(chapters ?? { chapters: [], mode: null, updatedAt: null });
    const roles = Object.values(decisions.speakers ?? {});
    const main = roles.filter((r) => r.role === "main" || r.role === "pov").length;
    const steps = [
        { id: "diagnose", label: "诊断", done: !!inventory, detail: inventory ? "已扫描" : "还没有扫描过", at: inventory?.generatedAt ?? null, required: true },
        { id: "capture", label: "截图", done: shots.length > 0, detail: shots.length ? `${shots.length} 张` : "没有截图，Agent 只能从代码猜界面", required: false },
        {
            id: "speakers", label: "说话人", done: main > 0,
            detail: main
                ? `主要 ${main}，NPC/别名 ${roles.filter((r) => r.role === "npc").length}，临时 ${roles.filter((r) => r.role === "temp").length}，合并 ${roles.filter((r) => r.mergeInto).length}`
                : "还没分类，所有变量都会被当成独立角色",
            required: false,
        },
        {
            id: "flow", label: "流程与章节", done: plan.chapters > 0,
            detail: plan.chapters ? `${plan.chapters} 个章节，${plan.files} 个文件` : "还没分章，Agent 只能自己猜怎么切",
            required: false,
        },
    ];
    return { steps, issues, ready: steps.every((s) => !s.required || s.done) };
}

/** The document the agent reads. Pure: it writes nothing. */
export function buildDocument(game, parts, files) {
    const { inventory, decisions, chapters, portraits, shots, fingerprint } = parts;
    const ext = inventory?.extensions ?? {};
    return [
        headerSection(game, inventory, fingerprint ?? null),
        speakersSection(ext.speakers, decisions, portraits ?? new Map()),
        pythonSection(ext.python),
        chaptersSection(ext.flow, chapters),
        screenshotSection(shots, inventory?.screens ?? []),
        factsSection(ext.facts),
        assetsSection(ext.assets),
        reviewSection(inventory),
        filesSection(files),
        `---\n\n由 Ren2Leaf 生成于 ${new Date().toISOString()}（补充包格式 v${PACKAGE_VERSION}）\n`,
    ].filter(Boolean).join("\n");
}

/** The file list of the package, before anything is written. */
export function planFiles(game, parts) {
    const { inventory, decisions, chapters, shots } = parts;
    const files = [{ path: "README.md", what: "给 Agent 看的迁移文档" }];
    const sizeOf = (f) => {
        try {
            return fs.statSync(f).size;
        } catch {
            return 0;
        }
    };
    for (const s of shots) {
        files.push({ path: s.image, what: `截图：${s.title}`, from: s.file, bytes: sizeOf(s.file) });
        for (const c of s.crops) files.push({ path: c.image, what: `切图：${c.label || c.type || c.n}`, from: c.from, bytes: sizeOf(c.from) });
        files.push({ path: `data/screens/${s.key}.elements.json`, what: `${s.title} 的元素坐标`, from: s.elementsFile, bytes: sizeOf(s.elementsFile) });
    }
    for (const [variable, p] of parts.portraits ?? new Map()) {
        files.push({ path: `characters/${variable}${path.extname(p.file)}`, what: `角色 ${variable} 的立绘或对话截图`, from: p.file, bytes: sizeOf(p.file) });
    }
    if (inventory) files.push({ path: "data/inventory.json", what: "完整扫描结果（界面、角色、Python、流程）", content: JSON.stringify(inventory, null, 2) });
    if (Object.keys(decisions.speakers ?? {}).length) {
        files.push({ path: "data/speakers.json", what: "迁移者确认过的说话人身份", content: JSON.stringify(decisions, null, 2) });
    }
    if (chapters?.chapters?.length) {
        files.push({ path: "data/chapters.json", what: "迁移者定的章节分组", content: JSON.stringify(chapters, null, 2) });
    }
    for (const f of files) if (f.content !== undefined) f.bytes = Buffer.byteLength(f.content);
    return files;
}

/**
 * Copies one file the earlier steps left in the work directory. A PNG is rewritten with the same
 * pixels in fewer bytes on the way out (see server/png.js): the engine's screenshots carry their
 * scanlines unfiltered, so a package of ten screens is several times larger than it needs to be.
 * Anything that is not a PNG, or that the rewrite leaves no smaller, is copied as it is.
 */
async function copyAsset(from, out) {
    if (path.extname(from).toLowerCase() === ".png") {
        try {
            const small = recompressPng(await fsp.readFile(from), { level: 8 });
            if (small) {
                await fsp.writeFile(out, small);
                return;
            }
        } catch {
            // Fall through to the plain copy: a package is worth more than a saved megabyte.
        }
    }
    await fsp.copyFile(from, out);
}

/** Writes the package into `<dir>/<slug>-ren2leaf`, replacing a package written there before. */
export async function writePackage(game, dir, { overwrite = false } = {}) {
    const parts = collect(game);
    if (!parts.inventory) throw new HttpError(409, "还没有扫描结果，先跑一次诊断", "no_inventory");
    const files = planFiles(game, parts);
    const document = buildDocument(game, parts, files);
    files[0].content = document;

    const target = path.join(dir, `${folderName(game.name, game.id)}-ren2leaf`);
    const marker = path.join(target, "README.md");
    if (fs.existsSync(target)) {
        if (!overwrite) throw new HttpError(409, "目标文件夹已经有一份补充包", "exists");
        // Only ever replace a folder that holds a package we wrote.
        if (!fs.existsSync(marker)) throw new HttpError(409, "同名文件夹里不是 Ren2Leaf 的补充包，换个位置", "not_ours");
        await fsp.rm(target, { recursive: true, force: true });
    }

    let bytes = 0;
    for (const f of files) {
        const out = path.join(target, f.path);
        await fsp.mkdir(path.dirname(out), { recursive: true });
        if (f.content !== undefined) {
            await fsp.writeFile(out, f.content);
        } else {
            await copyAsset(f.from, out);
        }
        f.bytes = (await fsp.stat(out)).size;
        bytes += f.bytes;
    }
    return { dir: target, files: files.map(({ from, content, ...f }) => f), bytes, screenshots: parts.shots.length };
}

export function register(router, { games }) {
    router.get("/api/games/:id/export", ({ params }) => {
        const game = games.get(params.id);
        const parts = collect(game);
        const files = planFiles(game, parts);
        const document = parts.inventory ? buildDocument(game, parts, files) : null;
        if (document) {
            files[0].content = document;
            files[0].bytes = Buffer.byteLength(document);
        }
        const defaultDir = path.join(game.workDir, "export");
        const target = path.join(defaultDir, `${folderName(game.name, game.id)}-ren2leaf`);
        return {
            readiness: readiness(game, parts),
            document,
            bytes: files.reduce((n, f) => n + (f.bytes ?? 0), 0),
            files: files.map(({ from, content, ...f }) => f),
            defaultDir,
            lastExport: fs.existsSync(target) ? { dir: target, at: fs.statSync(target).mtime.toISOString() } : null,
            skillsCommand: SKILLS_COMMAND,
            agentDocs: AGENT_DOCS,
        };
    });

    router.post("/api/games/:id/export/run", async ({ req, params }) => {
        const game = games.get(params.id);
        const body = await readJson(req);
        const dir = body.dir ? String(body.dir) : path.join(game.workDir, "export");
        if (!path.isAbsolute(dir)) throw new HttpError(400, "需要绝对路径", "relative_path");
        await fsp.mkdir(dir, { recursive: true });
        const result = await writePackage(game, dir, { overwrite: body.overwrite !== false });
        games.updateMeta(game.id, { exportedAt: new Date().toISOString(), exportDir: result.dir });
        return result;
    });

    router.post("/api/games/:id/export/pick", async ({ req, params }) => {
        await readJson(req);
        const game = games.get(params.id);
        const picked = await pickFolder("选择补充包的存放位置", path.dirname(game.path));
        if (!picked) return { cancelled: true };
        return { dir: picked };
    });
}
