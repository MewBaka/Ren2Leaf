// Step ④ Python logic: every `$` line, python block, init python and non-literal default/define,
// classified before anything is handed to an agent. The mapping table follows the port skill's
// statement table (skills/narraleaf-port-renpy/references/statement-mapping.md in this repo);
// `target` is the suggested `.story` row, `category` is how much human work is left:
//   autoSet      mechanical: a /set, /inc, /dec or /toggle row
//   mapped       a known API with a known row, still worth a glance
//   needsAgent   an agent has to decide (custom code, expressions, control flow)
//   unresolvable the name or target is built at runtime; static analysis cannot say
//   drop         engine bookkeeping with no NarraLeaf equivalent

import { literalAt, noteHook, parseCall, snippet } from "./scan.js";
import { byLocation } from "./screens.js";

export const ENTRY_LIMIT = 800;

/** Ren'Py APIs the port skill gives a row for. First match wins, so order matters. */
const API_MAP = [
    { re: /^renpy\.pause\s*\(/, api: "renpy.pause", target: "/wait", category: "mapped", note: "参数是秒数" },
    { re: /^renpy\.notify\s*\(/, api: "renpy.notify", target: "/blueprint", category: "mapped", note: "蓝图执行 Post Notification（blueprint.game.postNotification），文本连接 message 引脚" },
    { re: /^renpy\.movie_cutscene\s*\(/, api: "renpy.movie_cutscene", target: "/play", category: "mapped", note: "默认等待播放完毕后再继续" },
    { re: /^renpy\.movie_start_displayable\s*\(/, api: "renpy.movie_start_displayable", target: "/vfx", category: "mapped", note: "循环叠加的视频，可能带遮罩" },
    { re: /^renpy\.movie_stop\s*\(/, api: "renpy.movie_stop", target: "/hide", category: "mapped" },
    { re: /^achievement\.grant\s*\(/, api: "achievement.grant", target: "/blueprint", category: "mapped", note: "成就插件的解锁节点" },
    { re: /^achievement\.register\s*\(/, api: "achievement.register", target: "成就清单", category: "mapped", note: "成就声明，不是剧情行" },
    { re: /^achievement\.(progress|clear|clear_all|sync)\s*\(/, api: "achievement.*", target: "/blueprint", category: "mapped", note: "成就插件节点" },
    { re: /^renpy\.jump\s*\(/, api: "renpy.jump", target: "/jump", category: "mapped", note: "目标是字面量时才解析得出" },
    { re: /^renpy\.(call|call_in_new_context|invoke_in_new_context)\s*\(/, api: "renpy.call", target: "/jump 'Scene' return", category: "mapped", note: "原项目中该 label 执行完毕后将返回至本行之后" },
    { re: /^renpy\.jump_out_of_context\s*\(/, api: "renpy.jump_out_of_context", target: "/jump", category: "needsAgent", note: "跨上下文跳转" },
    { re: /^renpy\.music\.play\s*\(/, api: "renpy.music.play", target: "/bgm", category: "mapped" },
    { re: /^renpy\.music\.(stop|queue)\s*\(/, api: "renpy.music.stop", target: "/stop bgm", category: "mapped" },
    { re: /^renpy\.music\.set_volume\s*\(/, api: "renpy.music.set_volume", target: null, category: "needsAgent", note: "混音器音量" },
    { re: /^renpy\.(play|sound\.play)\s*\(/, api: "renpy.play", target: "/sound", category: "mapped" },
    { re: /^renpy\.sound\.stop\s*\(/, api: "renpy.sound.stop", target: "/stop", category: "mapped" },
    { re: /^renpy\.show\s*\(/, api: "renpy.show", target: "/show", category: "mapped", note: "图像名是变量时静态无法解析" },
    { re: /^renpy\.hide\s*\(/, api: "renpy.hide", target: "/hide", category: "mapped" },
    { re: /^renpy\.scene\s*\(/, api: "renpy.scene", target: "/bg", category: "mapped", note: "Ren'Py 的 scene 会清空图层" },
    { re: /^renpy\.transition\s*\(/, api: "renpy.transition", target: null, category: "needsAgent", note: "转场" },
    { re: /^renpy\.say\s*\(/, api: "renpy.say", target: "台词行", category: "mapped" },
    { re: /^renpy\.input\s*\(/, api: "renpy.input", target: "/blueprint", category: "needsAgent", note: "输入框" },
    { re: /^renpy\.(show_screen|call_screen|hide_screen|toggle_screen)\s*\(/, api: "renpy.show_screen", target: "页面 + /blueprint", category: "needsAgent", note: "界面" },
    { re: /^renpy\.full_restart\s*\(/, api: "renpy.full_restart", target: "/ending", category: "mapped", note: "返回标题画面" },
    { re: /^renpy\.(quit|utter_restart)\s*\(/, api: "renpy.quit", target: null, category: "needsAgent" },
    { re: /^renpy\.(block_rollback|retain_after_load|save_persistent|checkpoint|fix_rollback|restart_interaction|end_replay|dynamic|mark_image_seen|mark_label_seen|suspend_rollback)\s*\(/, api: "renpy 内部状态", target: null, category: "drop", note: "引擎内部簿记" },
    { re: /^renpy\.(loadable|exists|get_filename_line|version|variant|log|watch)\s*\(/, api: "renpy 查询", target: null, category: "drop" },
    { re: /^renpy\.(file|open_file|list_files|rename|unlink)\s*\(/, api: "renpy 文件", target: null, category: "needsAgent", note: "读写文件" },
    { re: /^renpy\.(get_screen|get_widget|restart|focus_coordinates|set_mouse_visible|free_memory)\s*\(/, api: "renpy 运行时", target: null, category: "drop" },
    { re: /^nvl_clear\s*\(/, api: "nvl_clear", target: "/nvl", category: "mapped", note: "NVL 段落边界" },
    { re: /^(eval|exec|getattr|setattr|globals|locals|__import__)\s*\(/, api: "动态求值", target: null, category: "unresolvable", note: "运行时才能确定执行内容" },
];

/** Namespaces that are interface and build configuration: step ⑥ territory, not story logic. */
const CONFIG_NAMESPACES = new Set(["gui", "config", "build", "style", "preferences", "_preferences", "layout", "theme", "director", "updater", "iap", "mixer"]);

const configRoot = (name) => {
    const root = String(name ?? "").split(/[.[(]/)[0];
    return CONFIG_NAMESPACES.has(root) ? root : null;
};

const CONFIG_REASON = "界面与选项配置";

const DROP_MODULES = new Set(["renpy", "config", "gui", "style", "persistent", "achievement", "store", "math", "random", "time", "datetime", "os", "sys", "re", "json", "collections", "itertools", "functools"]);

export function lookupApi(stmt) {
    for (const row of API_MAP) if (row.re.test(stmt)) return row;
    return null;
}

/** The mapping table itself, so the report and the WebUI can show what is covered. */
export function apiTable() {
    return API_MAP.map(({ re, ...row }) => row);
}

const ASSIGN_OPS = { "+=": "/inc", "-=": "/dec" };

function classifyTarget(name) {
    if (/^[A-Za-z_]\w*$/.test(name)) return { scope: "store", variable: name };
    if (/^store\.[A-Za-z_]\w*$/.test(name)) return { scope: "store", variable: name.slice(6) };
    if (/^persistent\.[A-Za-z_]\w*$/.test(name)) return { scope: "persistent", variable: name };
    return { scope: "complex", variable: null };
}

function assignEntry(col, ctx, ln, from, stmt, base) {
    const am = /^([^=<>!+\-*/%&|^]+?)\s*(\+=|-=|\*=|\/\/=|\/=|%=|\|=|&=|\^=|=)(?!=)\s*/.exec(stmt);
    if (!am) return null;
    const name = am[1].trim();
    const ns = configRoot(name);
    if (ns) {
        const valueFrom = ln.masked.indexOf(stmt, from) + am[0].length;
        noteHook(col, ctx, ln, name, valueFrom);
        const lit = literalAt(ln, valueFrom, ln.masked.length);
        return { ...base, kind: "config", target: name, namespace: ns, category: "drop", suggestion: null, reason: CONFIG_REASON, value: lit.ok ? lit.value : null };
    }
    if (/[,()]/.test(name)) {
        return { ...base, kind: "assign", target: name, category: "needsAgent", suggestion: "/set", reason: "一次赋多个值或目标是调用结果" };
    }
    if (base.nested) {
        // Inside a def or class body: a local or an attribute, not a story variable.
        return { ...base, kind: "localAssign", target: name, category: "drop", suggestion: null, reason: "函数或类内部的局部名称，非故事变量" };
    }
    const t = classifyTarget(name);
    const stmtStart = ln.masked.indexOf(stmt, from);
    const valueAt = stmtStart + am[0].length;
    const lit = literalAt(ln, valueAt, ln.masked.length);
    const value = lit.ok ? lit.value : null;
    if (t.scope === "persistent") col.notePersistent(name, "assigned", ctx.file, ln.line, lit.ok ? lit.value : undefined);
    const expr = lit.ok ? null : ln.text.slice(valueAt).trim();
    const entry = {
        ...base, kind: "assign", target: name, scope: t.scope, variable: t.variable,
        operator: am[2], value: lit.ok ? value : null, expression: expr ? snippet(expr) : null,
    };
    if (t.scope === "complex") {
        return { ...entry, category: "needsAgent", suggestion: null, reason: "赋值目标是属性或下标" };
    }
    if (am[2] === "=" && lit.ok) {
        return { ...entry, category: "autoSet", suggestion: `/set ${t.variable ?? name} ${JSON.stringify(value)}`, reason: "字面量赋值" };
    }
    if (ASSIGN_OPS[am[2]] && typeof value === "number") {
        return { ...entry, category: "autoSet", suggestion: `${ASSIGN_OPS[am[2]]} ${t.variable ?? name} ${value}`, reason: "数值自增自减" };
    }
    if (am[2] === "=" && expr && new RegExp(`^not\\s+(store\\.)?${name.replace(/[.[\]]/g, "\\$&")}$`).test(expr)) {
        return { ...entry, category: "autoSet", suggestion: `/toggle ${t.variable ?? name}`, reason: "布尔取反" };
    }
    return { ...entry, category: "needsAgent", suggestion: "/set", reason: "值是表达式" };
}

/**
 * Classifies one python logical line and records it. `context` is where the line lives:
 * dollar | python | initPython | label python | define | default | pyFile.
 */
export function classifyPython(col, ctx, ln, { from = 0, context = "python", nested = false } = {}) {
    const code = ln.masked.slice(from);
    const stmt = code.trim();
    if (!stmt || stmt === "pass" || /^(global|nonlocal)\b/.test(stmt)) return null;
    const base = {
        context, file: ctx.file, line: ln.line, endLine: ln.endLine,
        label: ctx.label ?? null, screen: ctx.screen ?? null, func: ctx.func ?? null,
        inClass: ctx.pyClass ?? null, indent: ln.indent,
        nested: nested || !!ctx.func || !!ctx.pyClass,
        // The `if`/`while` conditions this line sits under: an `if who == "1"` around a grant is
        // what says which call site unlocks which achievement.
        guards: (ctx.guards ?? []).filter((g) => g.condition).map((g) => `${g.word} ${g.condition}`),
        snippet: snippet(ln.text.slice(from)),
    };

    let entry = null;
    const rm = /^renpy\.register_statement\s*\(/.exec(stmt);
    if (rm) {
        const open = ln.masked.indexOf("(", ln.masked.indexOf("register_statement", from));
        const call = parseCall(ln, open);
        const nameArg = call?.positional[0];
        const lit = nameArg && literalAt(ln, nameArg[0], nameArg[1]);
        const name = lit?.ok && typeof lit.value === "string" ? lit.value : null;
        col.customStatements.push({ name, file: ctx.file, line: ln.line, block: /\bblock\s*=\s*True/.test(ln.masked), usages: [] });
        entry = { ...base, kind: "registerStatement", statementName: name, category: "needsAgent", suggestion: "/blueprint", reason: "自定义语句，剧本中有引用" };
    } else if (/^(def|async\s+def)\s+/.test(stmt)) {
        entry = { ...base, kind: "def", name: /^(?:async\s+)?def\s+(\w+)/.exec(stmt)?.[1] ?? null, category: "needsAgent", suggestion: "/blueprint", reason: "自定义函数" };
    } else if (/^class\s+/.test(stmt)) {
        entry = { ...base, kind: "class", name: /^class\s+(\w+)/.exec(stmt)?.[1] ?? null, category: "needsAgent", suggestion: null, reason: "自定义类" };
    } else if (/^(import|from)\s+/.test(stmt)) {
        const mod = /^(?:import|from)\s+([\w.]+)/.exec(stmt)?.[1] ?? null;
        entry = { ...base, kind: "import", name: mod, category: DROP_MODULES.has((mod ?? "").split(".")[0]) ? "drop" : "needsAgent", suggestion: null, reason: "导入模块" };
    } else if (stmt.startsWith("@")) {
        const name = stmt.slice(1).trim();
        const ns = configRoot(name);
        entry = { ...base, kind: "decorator", name, namespace: ns, category: ns ? "drop" : "needsAgent", suggestion: null, reason: ns ? CONFIG_REASON : "装饰器" };
    } else if (/^(if|elif|else|for|while|try|except|finally|with|return|break|continue|yield|raise|assert|del|print)\b/.test(stmt)) {
        entry = { ...base, kind: "control", category: "needsAgent", suggestion: /^(if|elif|else)\b/.test(stmt) ? "/if" : null, reason: "控制流" };
    } else {
        const api = lookupApi(stmt);
        if (api) {
            const dynamic = /^renpy\.(show|jump|call|hide)\s*\(\s*[A-Za-z_]\w*\s*[,)]/.test(stmt) && !ln.strings.some((s) => s.start > from);
            entry = {
                ...base, kind: "knownApi", api: api.api, category: dynamic ? "unresolvable" : api.category,
                suggestion: api.target, reason: dynamic ? "参数为变量，目标需运行时确定" : api.note ?? null,
            };
        } else if ((entry = assignEntry(col, ctx, ln, from, stmt, base))) {
            // handled by assignEntry
        } else {
            const cm = /^([A-Za-z_][\w.]*)\s*\(/.exec(stmt);
            if (cm && configRoot(cm[1])) {
                entry = { ...base, kind: "config", callee: cm[1], namespace: configRoot(cm[1]), category: "drop", suggestion: null, reason: CONFIG_REASON };
            } else if (cm) {
                const root = cm[1].split(".")[0];
                const known = col.callables.has(cm[1]);
                entry = {
                    ...base, kind: known ? "customCall" : "unknownCall", callee: cm[1],
                    category: "needsAgent", suggestion: "/blueprint",
                    reason: known ? "调用项目自定义函数" : root === "renpy" || root === "achievement" ? "映射表中无此 API" : "调用来源不明的函数",
                };
            } else {
                entry = { ...base, kind: "other", category: "needsAgent", suggestion: null, reason: "无法归类的 Python 语句" };
            }
        }
    }
    if (entry) col.pyEntries.push(entry);
    return entry;
}

/** A `default`/`define` whose value is not a literal is python logic too. */
export function classifyDefinition(col, ctx, ln, statement, name, from) {
    const value = ln.masked.slice(from).trim();
    if (!value) return null;
    const lit = literalAt(ln, from, ln.masked.length);
    if (lit.ok) return null;
    const ns = configRoot(name);
    const ctor = /^([A-Za-z_][\w.]*)\s*\(/.exec(value)?.[1] ?? null;
    const displayable = ctor && /^(Character|DynamicCharacter|NVLCharacter|ADVCharacter|Transform|Solid|Frame|Image|Text|Movie|Composite|LiveComposite|ConditionSwitch|ShowingSwitch|DynamicDisplayable|Animation|Color|Fade|Dissolve|ImageDissolve|MoveTransition|Pixellate|im\.\w+|Null|At|Crop|AlphaMask|Flatten|ParameterizedText|LayeredImageProxy|Position|Move|SnowBlossom|Particles)$/.test(ctor);
    if (displayable) col.displayables.set(name, ctor);
    const entry = {
        context: statement, file: ctx.file, line: ln.line, endLine: ln.endLine,
        label: ctx.label ?? null, screen: null, func: null, nested: false,
        snippet: snippet(ln.text), kind: ns ? "config" : statement === "default" ? "defaultValue" : "defineValue",
        target: name, namespace: ns, expression: snippet(ln.text.slice(from).trim()),
        category: ns || displayable ? "drop" : "needsAgent",
        suggestion: ns || displayable ? null : statement === "default" ? "/set" : null,
        reason: ns ? CONFIG_REASON : displayable ? `值是 ${ctor}(…)，属于角色、图像或转场` : statement === "default" ? "初值是表达式" : "define 的值是表达式",
    };
    col.pyEntries.push(entry);
    return entry;
}

function countBy(list, key) {
    const out = {};
    for (const e of list) {
        const k = typeof key === "function" ? key(e) : e[key];
        if (k == null) continue;
        out[k] = (out[k] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** Builds the python section of the inventory. */
export function buildPython(col) {
    const entries = [...col.pyEntries].sort(byLocation);

    // Custom statements: every use in the scripts, matched by the name they registered.
    const custom = col.customStatements.filter((s) => s.name);
    for (const s of custom) {
        if (s.name.includes(" ")) {
            const row = col.statementHeads.get(s.name);
            s.usageCount = row?.count ?? 0;
            s.usages = row?.sites ?? [];
        } else {
            const hits = col.unknownStatements.filter((u) => u.word === s.name).sort(byLocation);
            s.usageCount = hits.length;
            s.usages = hits.slice(0, 10).map(({ word, ...rest }) => rest);
        }
    }
    const registeredNames = new Set(custom.map((s) => s.name));
    const unknownStatements = Object.entries(
        col.unknownStatements.filter((u) => !registeredNames.has(u.word))
            .reduce((acc, u) => {
                (acc[u.word] ||= []).push(u);
                return acc;
            }, {}),
    ).map(([word, list]) => ({
        word, count: list.length, sites: list.slice(0, 10).map(({ word: _w, ...rest }) => rest),
    })).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

    // Functions the game defines, with the lines that call them.
    const defined = new Map();
    for (const e of entries) if (e.kind === "def" && e.name && !defined.has(e.name)) defined.set(e.name, e);
    const functions = [...defined.values()].map((d) => {
        const calls = entries.filter((e) => e.callee === d.name || e.callee?.endsWith(`.${d.name}`));
        // What the body does. A one-line wrapper around a known API (grant_achievement calling
        // achievement.grant) means every call site maps the same way the API does.
        const body = entries.filter((e) => e.func === d.name && e.file === d.file);
        const apis = [...new Set(body.filter((e) => e.kind === "knownApi").map((e) => e.api))];
        const calledFns = [...new Set(body.filter((e) => e.kind === "customCall" || e.kind === "unknownCall").map((e) => e.callee))];
        return {
            name: d.name, file: d.file, line: d.line, inLabel: d.label,
            calls: calls.length, callSites: calls.slice(0, 20).map((c) => ({ file: c.file, line: c.line, label: c.label })),
            bodyLines: body.length, apis, callees: calledFns,
            wraps: apis.length === 1 && body.filter((e) => e.kind !== "control" && e.kind !== "other").length === 1 ? apis[0] : null,
        };
    }).sort((a, b) => b.calls - a.calls || byLocation(a, b));

    // A hook's own body: which persistent flags decide what it does, and where it is defined.
    // an adjuster rewriting one of a sprite.s attributes from a `persistent.*` flag is the shape
    // this catches — the hardest kind of thing to notice by reading the script.
    const hooks = col.hooks.map((hook) => {
        const resolved = [];
        const reads = new Set();
        for (const name of hook.names) {
            const d = defined.get(name);
            if (!d) continue;
            const body = entries.filter((e) => e.func === name && e.file === d.file);
            for (const e of body) {
                for (const m of String(e.snippet ?? "").matchAll(/persistent\.(\w+)/g)) reads.add(`persistent.${m[1]}`);
            }
            resolved.push({ name, file: d.file, line: d.line, bodyLines: body.length });
        }
        return {
            ...hook,
            names: undefined,
            functions: resolved,
            persistentReads: [...reads].sort(),
        };
    });

    // Ren'Py's Gallery plugin: `g = Gallery()` and then `g.button` / `g.image` per CG. Read in
    // source order, those calls are the gallery's own table of contents — which is what the port
    // needs, not eight hundred "a call to an unknown function" rows.
    const galleryNames = new Set(entries
        .filter((e) => /(?:^|=\s*)Gallery\s*\(/.test(String(e.expression ?? e.snippet ?? "")) && (e.variable || e.target))
        .map((e) => e.variable || e.target));
    const galleries = [];
    if (galleryNames.size) {
        const open = new Map();
        for (const e of entries) {
            const callee = e.callee ?? "";
            const dot = callee.indexOf(".");
            if (dot < 0) continue;
            const object = callee.slice(0, dot);
            const method = callee.slice(dot + 1);
            if (!galleryNames.has(object)) continue;
            e.category = "mapped";
            e.suggestion = "画廊目录";
            e.reason = "Ren'Py 画廊插件的调用";
            const arg = /["']([^"']+)["']/.exec(String(e.snippet ?? ""))?.[1] ?? null;
            if (method === "button") {
                const group = { gallery: object, button: arg, images: [], unlocks: [], conditions: [], file: e.file, line: e.line };
                galleries.push(group);
                open.set(object, group);
                continue;
            }
            const group = open.get(object);
            if (!group) continue;
            if (method === "image") group.images.push(arg ?? snippet(e.snippet ?? ""));
            else if (method.startsWith("unlock")) group.unlocks.push(arg ?? snippet(e.snippet ?? ""));
            else if (method === "condition") group.conditions.push(arg ?? snippet(e.snippet ?? ""));
        }
    }

    const apiUsage = [];
    for (const row of API_MAP) {
        const hits = entries.filter((e) => e.kind === "knownApi" && e.api === row.api);
        if (!hits.length) continue;
        apiUsage.push({
            api: row.api, target: row.target, category: row.category, note: row.note ?? null,
            count: hits.length, examples: hits.slice(0, 5).map((h) => ({ file: h.file, line: h.line, label: h.label })),
        });
    }

    // A name only the interface uses. `cached_duration = {}` in `init python`, read by the music
    // screen and by nothing in the script, is interface bookkeeping: offering it as a `/set` row
    // sends the agent after a variable the story never has.
    const inScreens = new Set();
    for (const def of col.screenDefs) {
        for (const item of def.body) {
            for (const m of item.ln.masked.matchAll(/(?<![\w.$])[A-Za-z_]\w*/g)) inScreens.add(m[0]);
        }
    }
    const inStory = new Set();
    for (const e of entries) {
        if (!e.label && !e.screen) continue;
        if (e.variable) inStory.add(e.variable);
        for (const m of String(e.snippet ?? "").matchAll(/(?<![\w.$])[A-Za-z_]\w*/g)) if (e.label) inStory.add(m[0]);
    }
    const interfaceOnly = new Set();
    for (const e of entries) {
        if (!e.variable || e.label || e.nested) continue;
        if (e.context !== "initPython" && e.context !== "python" && e.context !== "pyFile") continue;
        if (!inScreens.has(e.variable) || inStory.has(e.variable)) continue;
        interfaceOnly.add(e.variable);
        e.category = "drop";
        e.suggestion = null;
        e.reason = "界面运行时使用的名称，剧本中无读写操作";
    }

    // `define x = Character(...)`, a position, a transition: a name, but not a story variable.
    const notVariables = [...col.store.keys()].filter((n) => col.displayables.has(n) || col.transforms.has(n));
    const skip = new Set(notVariables);
    const writes = countBy(entries.filter((e) => e.variable), "variable");
    const variableRow = ([name, v]) => ({ name, declaredBy: v.declaredBy, file: v.file, line: v.line, writes: writes[name] || 0 });
    const variables = [...col.store.entries()]
        .filter(([name]) => !skip.has(name) && !interfaceOnly.has(name))
        .map(variableRow)
        .sort((a, b) => a.name.localeCompare(b.name));
    const interfaceVariables = [...col.store.entries()]
        .filter(([name]) => !skip.has(name) && interfaceOnly.has(name))
        .map(variableRow)
        .sort((a, b) => a.name.localeCompare(b.name));
    const persistent = [...col.persistent.values()]
        .map((v) => ({ ...v, value: v.value === undefined ? null : v.value, hasInitial: v.value !== undefined }))
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
        version: 1,
        summary: {
            total: entries.length,
            byCategory: countBy(entries, "category"),
            byKind: countBy(entries, "kind"),
            byContext: countBy(entries, "context"),
            autoConvertible: entries.filter((e) => e.category === "autoSet").length,
            configuration: entries.filter((e) => e.kind === "config").length,
            needsAgent: entries.filter((e) => e.category === "needsAgent").length,
            unresolvable: entries.filter((e) => e.category === "unresolvable").length,
            functions: functions.length,
            customStatements: custom.length,
            unknownStatements: unknownStatements.reduce((n, u) => n + u.count, 0),
            variables: variables.length,
            interfaceVariables: interfaceVariables.length,
            persistent: persistent.length,
            localAssigns: entries.filter((e) => e.kind === "localAssign").length,
            hooks: hooks.length,
            galleryButtons: galleries.length,
            galleryImages: galleries.reduce((n, g) => n + g.images.length, 0),
            truncated: entries.length > ENTRY_LIMIT,
        },
        entries: entries.slice(0, ENTRY_LIMIT),
        hooks,
        galleries,
        apiUsage,
        functions,
        customStatements: custom.sort(byLocation),
        unknownStatements,
        variables,
        interfaceVariables,
        notVariables: notVariables.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, constructor: col.displayables.get(name) ?? (col.transforms.has(name) ? "transform" : null) })),
        persistent,
        modules: col.pyModules.sort((a, b) => a.file.localeCompare(b.file)),
        mappingTable: apiTable(),
    };
}
