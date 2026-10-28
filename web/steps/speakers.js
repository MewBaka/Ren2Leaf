// Step ③ speakers: every speaker the scan found, with its picture, sorted into the four things a
// speaker can become in NarraLeaf. Nothing is pre-selected. A speaker the migrator cannot place can
// be handed to the agent instead, but only with a note saying what they saw and what is unclear.
//
// An alias is not a special case here: a variable that is somebody under another name becomes its
// own character too, kept in the NPC / 别名 group. Since Studio 1.8.0 a take can be linked to a
// line under a bare name as well, but only a character gets its own voice volume and voice actor,
// and most games do not write their aliases cleanly enough for a `/rename`.
//
// Variables that share a display name are shown as one card. Ren'Py has no way to give a Character
// a second side image, so authors clone the Character per sprite set and one person ends up as
// `a1`, `a3`, `a5`… — in NarraLeaf that is one character, so choosing the card merges them,
// with the keeper's variable recorded as `mergeInto` on the others.
//
// Answers go to <work>/decisions/speakers.json through the decisions API, which merges by variable
// name, so a re-scan never overwrites them.

import { at, fact, facts, h, mountScanStep, props, section, table } from "./shared.js";

const SAMPLE = 2;

/** The four things a speaker can become. The hints are the rules this project settled on. */
const ROLES = [
    { id: "main", label: "主要角色", hint: "推动剧情发展的角色，无论是否有立绘；显示于角色列表顶层" },
    { id: "npc", label: "NPC / 别名", hint: "仍创建角色条目，但归入「NPC / 别名」分组，以保持角色列表整洁" },
    { id: "temp", label: "临时角色", hint: "不创建角色条目，名称直接写入台词；适用于无立绘的过场人物。台词仍可绑定配音，但没有独立的配音音量和声优信息" },
    { id: "pov", label: "POV 角色", hint: "视角角色，显示于顶层，仅作标记" },
    { id: "agent", label: "需 Agent 判断", hint: "证据不足以确定归类时选择；需填写备注，说明看到了什么、哪里无法确定，Agent 阅读源码后归入以上四类之一" },
];

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.label]));
const REMOVED = "removed";

// What 自动选择 fills in. Only these three cases are clear enough to fill; anything else is left
// alone, and nothing already answered is touched.
const AUTO = {
    mainLines: 100,   // 有立绘有配音，台词到这个数才算主要角色
    tempLines: 10,    // 没有配音，台词少于这个数算临时角色
};

export async function mount(host, ctx) {
    const { api, game } = ctx;
    let decisions = { speakers: {} };
    let portraits = {};
    let saving = 0;
    let saveError = null;
    const selected = new Set();   // card keys ticked for a batch change
    const keeperByName = new Map();   // which variable of a group keeps being the character
    let step = null;

    const answer = (variable) => decisions.speakers[variable] ?? null;
    const roleOf = (variable) => answer(variable)?.role ?? null;
    const mergeInto = (variable) => answer(variable)?.mergeInto ?? null;
    const settled = (variable) => roleOf(variable) || mergeInto(variable);

    /**
     * Asks for the note 需 Agent 判断 cannot go without and hands it to `submit`, which saves it and
     * resolves to the error, if any. A failed save keeps the box open with what was typed, so the
     * note is not lost. Resolves to the saved note, or null when cancelled.
     */
    async function askNote(current, count, submit) {
        const area = h("textarea", {
            class: "sp-note-input",
            rows: "4",
            maxlength: "400",
            autofocus: true,
            placeholder: "例如：与 b1 共用同一段配音编号，可能是同一角色的别名，但名称框不同",
            "aria-label": "备注",
        }, current || "");
        const failure = h("p", { class: "sp-note-error", role: "alert", hidden: true });
        const modal = ctx.openModal({
            title: "交给 Agent 判断",
            body: h("div", { class: "sp-note-form" },
                h("p", { class: "sp-note-lead" }, count > 1
                    ? `备注将写入已选的 ${count} 个角色。请说明看到了什么、哪里无法确定，Agent 将据此阅读源码并归类`
                    : "请说明看到了什么、哪里无法确定，Agent 将据此阅读源码并归类"),
                area,
                failure),
            width: 520,
            footer: [
                { label: "取消", variant: "secondary", value: null },
                {
                    id: "ok", label: "确定", variant: "primary",
                    onClick: async (close) => {
                        const note = area.value.trim();
                        modal.buttons.ok.disabled = true;
                        failure.hidden = true;
                        const err = await submit(note);
                        if (!err) return close(note);
                        // The page is served fresh but the server keeps running: an old one does
                        // not know this role yet.
                        failure.textContent = err.code === "bad_role"
                            ? `保存失败：${err.message}。后台服务可能仍是旧版本，请重启 Ren2Leaf 后再试`
                            : `保存失败：${err.message}`;
                        failure.hidden = false;
                        sync();
                    },
                },
            ],
        });
        const sync = () => { modal.buttons.ok.disabled = !area.value.trim(); };
        area.addEventListener("input", sync);
        sync();
        return (await modal.closed) || null;
    }

    /** Puts the note on what is handed to the agent. Other answers keep whatever note they had. */
    function withNote(patch, note) {
        for (const entry of Object.values(patch)) if (entry.role === "agent") entry.note = note;
        return patch;
    }

    /** Applies a picked role; 需 Agent 判断 saves through its note box and does nothing if cancelled. */
    async function choose(next, build, { current = null, count = 1 } = {}) {
        if (next !== "agent") {
            save(build(next));
            return true;
        }
        return !!(await askNote(current, count, (note) => save(withNote(build(next), note))));
    }

    function editNote(variable) {
        return askNote(answer(variable)?.note, 1, (note) => save({ [variable]: { note } }));
    }

    function agentNote(variable) {
        if (roleOf(variable) !== "agent") return null;
        return h("div", { class: "sp-agent-note" },
            h("span", {}, answer(variable)?.note || ""),
            h("button", { type: "button", class: "sp-link", onclick: () => editNote(variable) }, "修改备注"));
    }

    /** Resolves to the error when the save failed, null when it went through. */
    async function save(patch) {
        saving++;
        saveError = null;
        step?.redraw();
        let failed = null;
        try {
            const res = await api.put(`/api/games/${game.id}/speakers/decisions`, { speakers: patch });
            decisions = res.decisions;
            ctx.setStatus("speakers", summaryText());
        } catch (err) {
            saveError = err.message;
            failed = err;
        }
        saving--;
        step?.redraw();
        return failed;
    }

    function summaryText() {
        const roles = Object.values(decisions.speakers ?? {});
        const main = roles.filter((r) => r.role === "main").length;
        return main ? `角色 ${main} 个` : null;
    }

    // ---------------------------------------------------------------- pieces

    /** The speaker's sprite, whole: the migrator picks the keeper by looking at it. */
    function figure(sp) {
        const p = portraits[sp.variable];
        const box = h("div", { class: "sp-figure" });
        if (p) {
            box.append(h("img", { src: p.url, alt: sp.displayName || sp.variable, loading: "lazy", "data-tip": p.sourceLabel }));
            box.append(h("span", { class: "sp-figure-tag mono" }, p.tag || sp.variable));
        } else {
            // Nothing found. A cropped background would say nothing, so the name stands in for it.
            box.append(h("span", { class: "sp-figure-none" }, nameOf(sp)));
            box.append(h("span", { class: "sp-figure-tag" }, "无立绘"));
        }
        return box;
    }

    const nameOf = (sp) => answer(sp.variable)?.name || sp.displayName || sp.nameExpression || sp.variable;

    function evidence(sp) {
        const bits = [];
        bits.push(`${sp.lines} 句`);
        // The take numbers matter more than the folder: one actor's takes run as one series, so two
        // variables sharing a run are the same person.
        if (sp.voiced) bits.push(`配音 ${sp.voiceDirs.map((v) => `${v.dir} ${v.from ?? "?"}–${v.to ?? "?"}×${v.lines}`).join("，")}`);
        if (sp.spriteTags.length) bits.push(`立绘 ${sp.spriteTags.slice(0, 2).map((t) => t.tag).join("、")}`);
        if (sp.sameName?.length) bits.push(`与 ${sp.sameName.join("、")} 同名`);
        return bits.join(" · ");
    }

    function samples(sp) {
        return h("div", { class: "sp-samples" }, sp.samples.slice(0, SAMPLE).map((s) =>
            h("span", { class: "sp-sample" }, `「${s.text || "（空行）"}」`)));
    }

    // ---------------------------------------------------------------- ① roles

    function choice(label, on, onclick) {
        return h("button", { type: "button", class: `sp-choice${on ? " is-on" : ""}`, onclick }, label);
    }

    function roleButtons(role, onPick, disabledNote) {
        if (disabledNote) return h("div", { class: "sp-roles" }, h("span", { class: "sp-taken" }, disabledNote));
        return h("div", { class: "sp-roles" },
            ROLES.map((r) => choice(r.label, role === r.id, () => onPick(role === r.id ? null : r.id))),
            h("button", {
                type: "button",
                class: "sp-remove",
                "data-tip": "从列表中移除，补充包中将不再包含该角色",
                onclick: () => onPick(REMOVED),
            }, "移除"));
    }

    /** The tick box a batch change works from. */
    function picker(key) {
        const box = h("input", { type: "checkbox", checked: selected.has(key) || null });
        box.addEventListener("change", () => {
            if (box.checked) selected.add(key);
            else selected.delete(key);
            step.redraw();
        });
        return h("label", { class: "sp-pick", "data-tip": "选中后可批量设置" }, box);
    }

    function roleCard(sp) {
        const role = roleOf(sp.variable);
        const merged = mergeInto(sp.variable);
        return h("div", { class: `sp-card${role ? ` is-${role}` : ""}` },
            figure(sp),
            h("div", { class: "sp-card-body" },
                h("div", { class: "sp-card-name" },
                    picker(`v:${sp.variable}`),
                    h("span", { class: "sp-name" }, nameOf(sp)),
                    h("span", { class: "sp-var mono" }, sp.variable)),
                h("div", { class: "sp-card-meta" }, evidence(sp)),
                samples(sp),
                sp.flags.length
                    ? h("div", { class: "sp-card-flags" }, sp.flags.map((f) => h("span", {}, `· ${f.message}`)))
                    : null,
                role === "temp" && sp.voiced
                    ? h("div", { class: "sp-card-flags" }, h("span", {}, `· 该变量关联 ${sp.voiced} 句配音。临时角色的台词仍可绑定配音，但没有独立的配音音量和声优信息，需要这些请创建角色条目`))
                    : null,
                agentNote(sp.variable),
                roleButtons(role, (next) => choose(next, (r) => ({ [sp.variable]: { role: r } }), { current: answer(sp.variable)?.note }),
                    merged ? `已并入 ${merged}` : null)));
    }

    /**
     * One card for several variables that share a display name. Picking a role applies to all of
     * them: the keeper becomes the character, the rest are merged into it.
     */
    function groupCard(group) {
        const keeper = group.keeper;
        const others = group.members.filter((m) => m.variable !== keeper.variable);
        const role = roleOf(keeper.variable);
        const mergedCount = others.filter((m) => mergeInto(m.variable) === keeper.variable).length;

        const pick = h("select", { class: "an-select sp-keeper" },
            group.members.map((m) => h("option", { value: m.variable, selected: m.variable === keeper.variable },
                `${m.variable}（${m.lines} 句）`)));
        // Same name, several sprite sets: one character, so one variable takes the role and the
        // others merge into it, whichever role was picked.
        const patchTo = (keeperVariable, nextRole) => {
            const patch = {};
            if (nextRole === null || nextRole === REMOVED) {
                for (const m of group.members) patch[m.variable] = { role: nextRole, mergeInto: null };
            } else {
                patch[keeperVariable] = { role: nextRole, mergeInto: null };
                for (const m of group.members) {
                    if (m.variable !== keeperVariable) patch[m.variable] = { role: null, mergeInto: keeperVariable };
                }
            }
            return patch;
        };
        const apply = (nextRole) => choose(nextRole, (r) => patchTo(keeper.variable, r), { current: answer(keeper.variable)?.note });

        pick.addEventListener("change", () => {
            keeperByName.set(group.name, pick.value);
            // The role is already applied: move it, the merges and the note onto the newly picked variable.
            if (role === "agent") {
                const patch = withNote(patchTo(pick.value, role), answer(keeper.variable)?.note);
                patch[keeper.variable].note = null;
                save(patch);
            } else if (role) save(patchTo(pick.value, role));
            else step.redraw();
        });

        const voices = new Map();
        for (const m of group.members) for (const v of m.voiceDirs) voices.set(v.dir, (voices.get(v.dir) ?? 0) + v.lines);
        const lines = group.members.reduce((n, m) => n + m.lines, 0);

        return h("div", { class: `sp-card is-group${role ? ` is-${role}` : ""}` },
            figure(keeper),
            h("div", { class: "sp-card-body" },
                h("div", { class: "sp-card-name" },
                    picker(`g:${group.name}`),
                    h("span", { class: "sp-name" }, group.name),
                    h("span", { class: "sp-var mono" }, `${group.members.length} 个变量`)),
                // Which sprite set each variable carries: usually an outfit or a chibi version.
                h("div", { class: "sp-card-meta mono" }, group.members.map((m) => {
                    // The tag actually on stage says more than image=: it is where a chibi or a
                    // second outfit shows up (a variable speaking over a tag its name does not hint at).
                    const tag = m.spriteTags[0]?.tag ?? m.image;
                    return `${m.variable}×${m.lines}${tag && tag !== m.variable ? `（立绘 ${tag}）` : ""}`;
                }).join("  ")),
                h("div", { class: "sp-card-meta" },
                    `${lines} 句`,
                    voices.size ? ` · 配音 ${[...voices].map(([d, n]) => `${d}×${n}`).join("，")}` : " · 无配音"),
                samples(keeper),
                h("div", { class: "sp-merge" },
                    h("span", {}, "合并到"), pick,
                    h("span", { class: "sp-merge-hint" }, "左侧显示该角色的立绘，可切换预览，请选择主立绘"),
                    mergedCount ? h("span", { class: "sp-merge-done" }, `已合并 ${mergedCount} 个`) : null),
                agentNote(keeper.variable),
                roleButtons(role === null || mergedCount !== others.length ? null : role, apply, null)));
    }

    /**
     * Variables that share a display name, as one card each. A name drops out of here when its
     * variables already carry decisions that disagree with being one character.
     */
    function groupsOf(list) {
        const byName = new Map();
        for (const sp of list) {
            if (!sp.displayName || !sp.sameName?.length) continue;
            if (!byName.has(sp.displayName)) byName.set(sp.displayName, []);
            byName.get(sp.displayName).push(sp);
        }
        const groups = [];
        const grouped = new Set();
        for (const [name, members] of byName) {
            if (members.length < 2) continue;
            const mains = members.filter((m) => roleOf(m.variable) === "main");
            const apart = members.filter((m) =>
                mergeInto(m.variable) && !members.some((x) => x.variable === mergeInto(m.variable)));
            if (mains.length > 1 || apart.length) continue;
            const sorted = [...members].sort((a, b) => b.lines - a.lines);
            // An explicit pick comes first: otherwise the variable that already carries the role
            // would pin the dropdown and it would snap back on every change.
            const keeper = members.find((m) => m.variable === keeperByName.get(name)) ?? mains[0] ?? sorted[0];
            groups.push({ name, members: sorted, keeper });
            for (const m of members) grouped.add(m.variable);
        }
        return { groups, grouped };
    }

    function roleGuide() {
        return h("div", { class: "sp-legend" },
            ROLES.map((r) => h("div", { class: "sp-legend-row" },
                h("span", { class: "sp-legend-name" }, r.label),
                h("span", { class: "sp-legend-hint" }, r.hint))),
            h("div", { class: "sp-legend-row" },
                h("span", { class: "sp-legend-name" }, "配音"),
                h("span", { class: "sp-legend-hint" }, "临时角色的台词同样可以绑定配音，配音表按名称列出；独立的配音音量和声优信息只有已创建的角色条目才有")),
            h("div", { class: "sp-legend-row" },
                h("span", { class: "sp-legend-name" }, "别名"),
                h("span", { class: "sp-legend-hint" }, "同一角色使用不同名称框（如「？？？」）时，应分别创建角色条目并归入「NPC / 别名」分组")));
    }

    function helpButton() {
        return h("button", {
            type: "button",
            class: "sp-help",
            "data-tip": "角色分类说明",
            onclick: () => ctx.openModal({
                title: "角色分类说明",
                body: roleGuide(),
                footer: [{ label: "了解", variant: "primary" }],
                width: 560,
            }),
        }, "？");
    }

    /**
     * The cards of one list, group cards included, as entries that carry what sorting and the auto
     * pick need: a card has a picture and a voice when any of its variables does.
     */
    function entriesOf(list) {
        const { groups, grouped } = groupsOf(list);
        const entries = groups.map((g) => ({
            key: `g:${g.name}`,
            group: g,
            members: g.members,
            lines: g.members.reduce((n, m) => n + m.lines, 0),
            voiced: g.members.reduce((n, m) => n + m.voiced, 0),
            art: g.members.some((m) => portraits[m.variable]),
            decided: g.members.some((m) => settled(m.variable)),
            removed: g.members.every((m) => roleOf(m.variable) === REMOVED),
            render: () => groupCard(g),
        }));
        for (const sp of list) {
            if (grouped.has(sp.variable)) continue;
            entries.push({
                key: `v:${sp.variable}`,
                speaker: sp,
                members: [sp],
                lines: sp.lines,
                voiced: sp.voiced,
                art: !!portraits[sp.variable],
                decided: !!settled(sp.variable),
                removed: roleOf(sp.variable) === REMOVED,
                render: () => roleCard(sp),
            });
        }
        // Everything with both a sprite and a voice first — those are the ones worth deciding
        // first — and inside each half, the more a speaker says the higher it sits.
        return entries.sort((a, b) =>
            (b.art && b.voiced > 0) - (a.art && a.voiced > 0) || b.lines - a.lines || a.key.localeCompare(b.key));
    }

    /** Sets a whole card: for a group the keeper takes the role and the rest merge into it. */
    function patchFor(entry, role) {
        // Removing (or putting back) applies to every variable of the card on its own.
        if (role === REMOVED || role === null) {
            const patch = {};
            for (const m of entry.members) patch[m.variable] = { role, mergeInto: role === REMOVED ? null : mergeInto(m.variable) };
            return patch;
        }
        if (!entry.group) return { [entry.speaker.variable]: { role } };
        const keeper = entry.group.keeper;
        const patch = { [keeper.variable]: { role, mergeInto: null } };
        for (const m of entry.group.members) {
            if (m.variable !== keeper.variable) patch[m.variable] = { role: null, mergeInto: keeper.variable };
        }
        return patch;
    }

    /** The three cases the rules cover. Anything else stays unanswered on purpose. */
    function autoRole(entry) {
        if (entry.decided || !entry.lines) return null;
        if (!entry.voiced) return entry.lines < AUTO.tempLines ? "temp" : "npc";
        if (entry.art && entry.lines >= AUTO.mainLines) return "main";
        return null;
    }

    function autoButton(entries) {
        const planned = entries.map((e) => ({ entry: e, role: autoRole(e) })).filter((x) => x.role);
        const count = (id) => planned.filter((x) => x.role === id).length;
        const left = entries.filter((e) => !e.decided && e.lines && !autoRole(e)).length;
        return h("button", {
            type: "button",
            class: "btn btn-quiet btn-sm",
            disabled: !planned.length,
            onclick: async () => {
                const body = h("div", { class: "sp-legend" },
                    h("div", { class: "sp-legend-row" },
                        h("span", { class: "sp-legend-name" }, "主要角色"),
                        h("span", { class: "sp-legend-hint" }, `有立绘且有配音，台词数 ≥ ${AUTO.mainLines}——将填入 ${count("main")} 个`)),
                    h("div", { class: "sp-legend-row" },
                        h("span", { class: "sp-legend-name" }, "NPC / 别名"),
                        h("span", { class: "sp-legend-hint" }, `无 voice 语句，身份仅可通过立绘与台词推断——将填入 ${count("npc")} 个`)),
                    h("div", { class: "sp-legend-row" },
                        h("span", { class: "sp-legend-name" }, "临时角色"),
                        h("span", { class: "sp-legend-hint" }, `同样无 voice 语句，且台词数 < ${AUTO.tempLines}——将填入 ${count("temp")} 个`)),
                    h("div", { class: "sp-legend-row" },
                        h("span", { class: "sp-legend-name" }, "保持不变"),
                        h("span", { class: "sp-legend-hint" }, `已选择的角色不会被覆盖；另有 ${left} 个不符合上述任何条件，需手动指定`)));
                const ok = await ctx.openModal({
                    title: "按规则自动选择",
                    body,
                    width: 560,
                    footer: [
                        { label: "取消", variant: "secondary", value: false },
                        { label: `填入 ${planned.length} 个`, variant: "primary", value: true },
                    ],
                }).closed;
                if (ok !== true) return;
                const patch = {};
                for (const { entry, role } of planned) Object.assign(patch, patchFor(entry, role));
                save(patch);
            },
        }, planned.length ? `自动选择 ${planned.length} 个` : "自动选择");
    }

    function bulkBar(entries) {
        const picked = entries.filter((e) => selected.has(e.key));
        if (!picked.length) return null;
        const apply = async (role) => {
            const done = await choose(role, (r) => {
                const patch = {};
                for (const e of picked) Object.assign(patch, patchFor(e, r));
                return patch;
            }, { count: picked.length });
            if (!done) return;
            selected.clear();
            step.redraw();
        };
        return h("div", { class: "sp-bulk" },
            h("span", { class: "sp-bulk-count" }, `已选 ${picked.length} 个`),
            ROLES.map((r) => choice(r.label, false, () => apply(r.id))),
            h("button", { type: "button", class: "sp-remove", onclick: () => apply(REMOVED) }, "移除"),
            h("span", { class: "an-spacer" }),
            h("button", {
                type: "button",
                class: "btn btn-quiet btn-sm",
                onclick: () => {
                    selected.clear();
                    step.redraw();
                },
            }, "取消选择"));
    }

    function rolesPhase(data) {
        const spoken = data.speakers.filter((x) => x.lines);
        const silent = data.speakers.filter((x) => !x.lines);
        const all = entriesOf(spoken);
        const entries = all.filter((e) => !e.removed);
        const gone = all.filter((e) => e.removed);
        const cards = entries.map((e) => e.render());
        const out = [];
        out.push(section("选择角色", entries.length,
            h("div", {}, bulkBar(entries), h("div", { class: "sp-grid" }, cards)),
            {
                note: h("div", { class: "sp-note-row" },
                    h("span", {}, "同名变量已合并为一张卡片，选中即视为同一角色；合并目标请根据左侧立绘预览决定，分体式立绘可能无法正常显示"),
                    helpButton()),
                actions: h("span", { class: "sp-actions" }, autoButton(entries), saveStatus()),
            }));
        if (silent.length) {
            const silentEntries = entriesOf(silent).filter((e) => !e.removed);
            out.push(section("无台词变量", silentEntries.length,
                h("div", { class: "sp-grid" }, silentEntries.map((e) => e.render())),
                { note: "已定义但无台词，通常无需创建角色" }));
        }
        if (gone.length) {
            out.push(section("已移除", gone.length,
                h("div", { class: "an-list" }, gone.map((e) => h("div", { class: "an-item" },
                    h("span", {}, e.group ? `${e.group.name}（${e.members.length} 个变量）` : nameOf(e.speaker)),
                    h("span", { class: "an-item-text" },
                        h("span", { class: "mono" }, e.members.map((m) => m.variable).join("  ")),
                        h("button", {
                            type: "button",
                            class: "sp-link",
                            onclick: () => save(patchFor(e, null)),
                        }, "恢复到列表"))))),
                { note: "以下内容不会写入补充包" }));
        }
        return out;
    }

    function saveStatus() {
        if (saveError) return h("span", { class: "an-value is-danger" }, saveError);
        if (saving) return h("span", { class: "an-value" }, "正在保存");
        return decisions.updatedAt ? h("span", { class: "an-value" }, "已保存") : null;
    }

    step = await mountScanStep(host, ctx, {
        key: "speakers",
        documentStep: "speakers",
        async onLoaded() {
            const [d, p] = await Promise.all([
                api.get(`/api/games/${game.id}/speakers/decisions`),
                api.get(`/api/games/${game.id}/speakers/portraits`).catch(() => ({ portraits: {} })),
            ]);
            decisions = d.decisions;
            portraits = p.portraits ?? {};
            ctx.setStatus("speakers", summaryText());
        },
        render(data) {
            const s = data.summary;
            const count = (id) => data.speakers.filter((x) => roleOf(x.variable) === id).length;
            const main = count("main");
            const merged = data.speakers.filter((x) => mergeInto(x.variable)).length;
            const todo = data.speakers.filter((x) => x.lines && !settled(x.variable)).length;
            const out = [facts([
                fact("说话人变量", s.speakers, null, `${s.withLines} 个有台词`),
                fact("主要角色", main + count("pov"), main ? "success" : "warning", count("pov") ? `含 POV ${count("pov")}` : null),
                fact("NPC / 别名", count("npc"), null, "归入分组"),
                fact("临时角色", count("temp"), null, "不创建角色"),
                fact("交给 Agent", count("agent"), null, "附备注"),
                fact("已合并的变量", merged, null, "同名角色的另一套立绘"),
                fact("未指定", todo, todo ? "warning" : "success"),
            ])];
            out.push(...rolesPhase(data));

            if (data.voiceDirs.length) {
                const tbody = h("tbody");
                for (const d of data.voiceDirs) {
                    tbody.append(h("tr", {},
                        h("td", { class: "mono" }, d.dir),
                        h("td", {}, `${d.lines} 句`),
                        h("td", { class: "mono" }, d.variables.map((v) => `${v.variable} ${v.from ?? "?"}–${v.to ?? "?"}（${v.lines}）`).join("  "))));
                }
                const t = table(["22%", "72px", null], ["目录", "台词", "关联变量（编号范围）"], tbody);
                t.classList.add("is-wrap");
                out.push(section("配音目录对应的变量", data.voiceDirs.length, t,
                    { note: "编号取自配音文件名中的序号。同一声优的编号通常为连续序列；若多个变量共享同一段连续编号，则表明为同一角色使用了不同名称框" }));
            }

            if (data.inlineSpeakers.length) {
                const tbody = h("tbody");
                for (const x of data.inlineSpeakers) {
                    tbody.append(h("tr", {},
                        h("td", {}, x.name),
                        h("td", {}, String(x.lines)),
                        h("td", { class: "mono" }, x.files.map((f) => f.file).join("  "))));
                }
                out.push(section("单次出现的说话人", data.inlineSpeakers.length,
                    table(["24%", "80px", null], ["名字", "台词", "出现在"], tbody),
                    { note: "源码中直接以名称书写的台词，无需创建角色，也无需在此配置" }));
            }

            if (data.narrator.lines) {
                out.push(section("旁白", data.narrator.lines,
                    props([
                        ["分布", data.narrator.files.map((f) => `${f.file}（${f.lines}）`).join("、")],
                        ["样本", h("div", { class: "sp-samples" }, data.narrator.samples.map((x) =>
                            h("span", { class: "sp-sample" }, `${at(x)}　「${x.text}」`)))],
                    ])));
            }
            return out;
        },
    });

    return () => ctx.setStatus("speakers", null);
}
