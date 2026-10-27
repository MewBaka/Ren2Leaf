import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnose, SCHEMA_VERSION } from "../server/diagnose/index.js";
import { lex } from "../server/diagnose/lexer.js";

// Samples that ship with the SDK; read only. Tests that need them skip when the SDK is missing.
const SDK = process.env.RENPY_SDK || "/Applications/renpy-8.5.2-sdk";
const QUESTION = path.join(SDK, "the_question");
const TUTORIAL = path.join(SDK, "tutorial");
const haveSdk = fs.existsSync(path.join(QUESTION, "game")) && fs.existsSync(path.join(TUTORIAL, "game"));
const sdkOpts = { skip: haveSdk ? false : `Ren'Py SDK 不在 ${SDK}` };

const screen = (inv, name) => inv.screens.find((s) => s.name === name);

/** Every object key outside the name-keyed maps must be camelCase. */
function assertCamelCase(value, where = "inventory") {
    if (Array.isArray(value)) return value.forEach((v, i) => assertCamelCase(v, `${where}[${i}]`));
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
        assert.match(k, /^[a-z][a-zA-Z0-9]*$/, `${where}.${k} 不是 camelCase`);
        if (k === "actions" || k === "elements" || k === "actionKinds") continue;
        if (k === "byCategory" || k === "byKind" || k === "byContext") continue;
        assertCamelCase(v, `${where}.${k}`);
    }
}

function assertRelativePaths(inv) {
    const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== "object") return;
        for (const [k, x] of Object.entries(v)) {
            if ((k === "file" || k === "path") && typeof x === "string") {
                assert.ok(!path.isAbsolute(x) && !x.includes("\\"), `路径应相对 game/：${x}`);
            } else walk(x);
        }
    };
    walk(inv);
}

describe("lexer", () => {
    test("joins bracketed and multi-line strings, drops comments, masks strings", () => {
        const { lines, errors } = lex('define e = Character(\n    "Ei # not a comment",  # comment\n    color="#fff")\n\nlabel start:\n    e "one\ntwo"\n');
        assert.deepEqual(errors, []);
        assert.equal(lines.length, 3);
        assert.equal(lines[0].line, 1);
        assert.equal(lines[0].endLine, 3);
        assert.equal(lines[0].strings[0].value, "Ei # not a comment");
        assert.ok(!lines[0].masked.includes("Ei"));
        assert.equal(lines[0].text.length, lines[0].masked.length);
        assert.equal(lines[2].indent, 4);
        assert.equal(lines[2].strings[0].value, "one\ntwo");
    });
});

describe("the_question", sdkOpts, () => {
    let inv;
    before(async () => {
        inv = await diagnose(QUESTION);
    });

    test("versioned, camelCase, relative paths", () => {
        assert.equal(inv.schemaVersion, SCHEMA_VERSION);
        assert.equal(inv.schemaVersion, 2);
        assertCamelCase(inv);
        assertRelativePaths(inv);
        assert.deepEqual(Object.keys(inv.extensions), ["speakers", "python", "flow", "facts", "assets"]);
    });

    test("game info", () => {
        assert.equal(inv.game.name, "The Question");
        assert.equal(inv.game.version, "7.0");
        assert.deepEqual(inv.game.nameAt, { file: "options.rpy", line: 15 });
        const r = inv.game.resolution;
        assert.equal(r.width, 1280);
        assert.equal(r.height, 720);
        assert.equal(r.source, "gui.init");
        assert.equal(r.file, "gui.rpy");
        assert.equal(r.aspectRatio, "16:9");
        assert.equal(r.is16x9, true);
    });

    test("source health and SDK recommendation", () => {
        assert.equal(inv.source.status, "source");
        assert.ok(inv.source.files.rpy > 0);
        assert.deepEqual(inv.source.compiledOnly, []);
        assert.deepEqual(inv.source.archives, []);
        assert.equal(inv.source.python2.syntaxHits, 0);
        assert.equal(inv.source.sdkRecommendation.major, 8);
    });

    test("standard screens with signatures and locations", () => {
        assert.equal(inv.summary.customScreens, 0);
        assert.equal(inv.summary.standardScreens, 22);
        const say = screen(inv, "say");
        assert.equal(say.category, "standard");
        assert.equal(say.definitions[0].signature, "(who, what)");
        assert.deepEqual(say.definitions[0].params.map((p) => p.name), ["who", "what"]);
        assert.equal(say.definitions[0].file, "screens.rpy");
        assert.equal(say.definitions[0].line, 98);
        assert.equal(say.classification, "dialogue_like");
        const gm = screen(inv, "game_menu");
        assert.deepEqual(gm.definitions[0].params.find((p) => p.name === "scroll"), { name: "scroll", default: "None" });
        // quick_menu has a second, touch-variant definition.
        assert.equal(screen(inv, "quick_menu").definitions.length, 2);
        assert.ok(screen(inv, "quick_menu").definitions.some((d) => d.variant === "touch"));
        assert.equal(screen(inv, "confirm").definitions[0].modal, true);
    });

    test("call sites with labels and callers", () => {
        const choice = screen(inv, "choice");
        assert.equal(choice.classification, "interactive");
        assert.deepEqual(choice.callSites.map((c) => [c.kind, c.label]), [["menu", "start"], ["menu", "rightaway"]]);
        const nav = screen(inv, "navigation");
        assert.deepEqual(nav.usedBy, ["game_menu", "main_menu"]);
        assert.ok(nav.callSites.every((c) => c.kind === "use"));
        assert.ok(screen(inv, "history").callSites.some((c) => c.kind === "ShowMenu" && c.caller === "quick_menu"));
        assert.ok(screen(inv, "quick_menu").callSites.some((c) => c.kind === "config.overlay_screens"));
        // ShowMenu() with no screen falls back to the save screen.
        assert.ok(screen(inv, "save").callSites.some((c) => c.via === "_game_menu_screen 默认值"));
        assert.ok(screen(inv, "main_menu").classificationReasons.some((r) => r.includes("navigation")));
    });

    test("store variables and actions", () => {
        const nav = screen(inv, "navigation");
        assert.deepEqual(nav.storeVariables.map((v) => v.name), ["_in_replay", "main_menu"]);
        assert.deepEqual(screen(inv, "quick_menu").storeVariables, [{ name: "quick_menu", declaredBy: "default" }]);
        assert.deepEqual(screen(inv, "history").storeVariables, [{ name: "_history_list", declaredBy: "engine" }]);
        assert.equal(nav.actions.ShowMenu, 6);
        assert.equal(nav.actions.Start, 1);
        assert.ok(inv.screens.every((s) => s.unresolvedNames.length === 0), "标准模板不应有未识别的名字");
    });

    test("characters", () => {
        assert.deepEqual(
            inv.characters.map((c) => [c.variable, c.displayName, c.kind]),
            [["s", "Sylvie", "adv"], ["m", "Me", "adv"]],
        );
        assert.deepEqual(inv.needsReview, []);
    });
});

describe("tutorial", sdkOpts, () => {
    let inv;
    before(async () => {
        inv = await diagnose(path.join(TUTORIAL, "game"));
    });

    test("accepts game/ directly; custom screens are listed apart", () => {
        assert.equal(inv.game.name, "Ren'Py Tutorial Game");
        assert.ok(inv.summary.customScreens > 50);
        const first = inv.screens.findIndex((s) => s.category === "custom");
        assert.ok(inv.screens.slice(0, first).every((s) => s.category === "standard"));
        assert.ok(inv.screens.slice(first).every((s) => s.category !== "standard"));
        assertCamelCase(inv);
        assertRelativePaths(inv);
    });

    test("call screen inside a label; custom displayable counts as interactive", () => {
        const pong = screen(inv, "pong");
        assert.deepEqual(pong.callSites.map((c) => [c.kind, c.file, c.line, c.label]), [["call screen", "indepth_minigame.rpy", 236, "play_pong"]]);
        assert.equal(pong.classification, "interactive");
    });

    test("show screen with arguments", () => {
        const text = screen(inv, "text");
        assert.ok(text.callSites.length > 10);
        assert.ok(text.callSites.every((c) => c.kind === "show screen" && c.args && c.args.startsWith("(")));
    });

    test("store variables a screen reads", () => {
        assert.deepEqual(
            screen(inv, "day_planner").storeVariables,
            [
                { name: "day_choices", declaredBy: "define" },
                { name: "day_periods", declaredBy: "define" },
                { name: "day_plan", declaredBy: "default" },
                { name: "stat_strength", declaredBy: "default" },
            ],
        );
        assert.ok(screen(inv, "day_planner").actions.SetDict >= 1);
        assert.ok(screen(inv, "stats").storeVariables.some((v) => v.name === "player_hp"));
    });

    test("characters: kind, inherited names, interpolated names", () => {
        const c = Object.fromEntries(inv.characters.map((x) => [x.variable, x]));
        assert.equal(c.e.displayName, "Eileen");
        assert.equal(c.nvle.kind, "nvl");
        assert.equal(c.eslow.kindSource, "e");
        assert.equal(c.eslow.displayName, "Eileen");
        assert.equal(c.e8.displayName, null);
        assert.equal(c.g.displayName, "[name]");
        assert.equal(c.l.displayName, "Lucy");
    });

    test("dynamic screen names go to needsReview", () => {
        const r = inv.needsReview.find((x) => x.kind === "dynamicScreenName" && x.file === "01example.rpy");
        assert.ok(r, "renpy.show_screen(name) 应进 needsReview");
        assert.ok(r.line > 0 && r.snippet.includes("show_screen"));
    });
});

describe("synthetic game", () => {
    let tmp;
    let root;
    let inv;
    let before_;

    const listing = (dir) => {
        const out = [];
        const visit = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) visit(p);
                else out.push([path.relative(dir, p), fs.statSync(p).mtimeMs]);
            }
        };
        visit(dir);
        return out.sort();
    };

    before(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-diag-"));
        root = path.join(tmp, "proj");
        const game = path.join(root, "game");
        fs.mkdirSync(path.join(game, "sub"), { recursive: true });
        fs.writeFileSync(path.join(game, "options.rpy"), [
            'define config.name = "Synthetic"',
            "define config.version = build_version",
            "init python:",
            "    config.screen_width = 800",
            "    config.screen_height = 600",
            "    def helper():",
            "        global points",
            "        points = 1",
            "",
        ].join("\n"));
        fs.writeFileSync(path.join(game, "script.rpy"), [
            'define a = Character("Alice", image="alice", screen="talk")',
            "define b = Character(name_var)",
            "define n = Character(None, kind=nvl)",
            "define n2 = Character(kind=n)",
            "define d = DynamicCharacter(\"hero_name\")",
            "default persistent.seen = False",
            "default gold = 0",
            "",
            "label start:",
            '    $ print "hi"',
            "    $ x = u'ok'",
            "    show screen hud",
            '    call screen expression "shop" pass (3)',
            "    show screen expression which",
            '    $ renpy.call_screen("panel_" + kind)',
            "    $ renpy.show_screen('missing_one')",
            "    menu:",
            '        "Yes":',
            "            pass",
            "label .inner:",
            "    call screen shop(5)",
            "    return",
            "",
            "screen hud():",
            '    text "[gold] / [persistent.seen]"',
            "    if gold > secret_value:",
            '        textbutton "Shop" action [SetVariable("gold", 0), Show("shop", items=3)]',
            "",
            "screen talk(who, what):",
            '    text what id "what"',
            "",
            "screen shop(count=1):",
            "    modal True",
            "    tag menu",
            "    use hud",
            '    key "K_ESCAPE" action Return()',
            "",
        ].join("\n"));
        fs.writeFileSync(path.join(game, "sub", "old.py"), "try:\n    pass\nexcept ValueError, e:\n    print e\nd = {}.has_key('x')\n");
        fs.writeFileSync(path.join(game, "sub", "gone.rpyc"), "RENPY RPC2");
        fs.writeFileSync(path.join(game, "archive.rpa"), "RPA-3.0 0000000000000040 42424242\n");
        before_ = listing(root);
        inv = await diagnose(root);
    });

    after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    test("does not touch the game folder", () => {
        assert.deepEqual(listing(root), before_);
    });

    test("game info from config.screen_width/height; non-literal version is reviewed", () => {
        assert.equal(inv.game.name, "Synthetic");
        assert.equal(inv.game.version, null);
        assert.deepEqual([inv.game.resolution.width, inv.game.resolution.height, inv.game.resolution.is16x9], [800, 600, false]);
        assert.equal(inv.game.resolution.aspectRatio, "4:3");
        assert.ok(inv.needsReview.some((r) => r.kind === "nonLiteralConfig" && r.snippet.includes("config.version")));
    });

    test("source health: compiled-only, archives, Python 2 → SDK 7", () => {
        assert.equal(inv.source.status, "partialSource");
        assert.deepEqual(inv.source.compiledOnly, ["sub/gone.rpyc"]);
        assert.deepEqual(inv.source.archives.map((a) => [a.path, a.format]), [["archive.rpa", "RPA-3.0"]]);
        const rules = inv.source.python2.hits.map((h) => `${h.file}:${h.line}:${h.rule}`);
        assert.ok(rules.includes("script.rpy:10:printStatement"));
        assert.ok(rules.includes("sub/old.py:3:exceptComma"));
        assert.ok(rules.includes("sub/old.py:4:printStatement"));
        assert.ok(rules.includes("sub/old.py:5:py2DictMethod"));
        assert.ok(!rules.some((r) => r.startsWith("script.rpy:11:")), "u'' 前缀不算 Python 2 特征");
        assert.equal(inv.source.sdkRecommendation.major, 7);
        const kinds = inv.needsReview.map((r) => r.kind);
        assert.ok(kinds.includes("compiledOnlyFile"));
        assert.ok(kinds.includes("archive"));
    });

    test("call sites, local labels and dynamic names", () => {
        const shop = screen(inv, "shop");
        assert.deepEqual(
            shop.callSites.map((c) => [c.kind, c.label, c.caller]),
            [["call screen", "start", null], ["call screen", "start.inner", null], ["Show", null, "hud"]],
        );
        assert.equal(shop.callSites[1].args, "(5)");
        assert.equal(shop.definitions[0].modal, true);
        assert.equal(shop.definitions[0].tag, "menu");
        assert.equal(shop.classification, "interactive");
        assert.ok(shop.classificationReasons.some((r) => r.includes("hud")));
        assert.deepEqual(screen(inv, "talk").callSites.map((c) => c.kind), ["Character(screen=)"]);
        assert.equal(screen(inv, "talk").classification, "dialogue_like");
        assert.deepEqual(screen(inv, "choice").callSites.map((c) => c.label), ["start"]);

        const missing = screen(inv, "missing_one");
        assert.equal(missing.defined, false);
        assert.equal(missing.classification, null);
        const review = inv.needsReview.filter((r) => r.kind === "dynamicScreenName").map((r) => r.line);
        assert.deepEqual(review, [14, 15]);
        assert.ok(inv.needsReview.some((r) => r.kind === "undefinedScreen" && r.message.includes("missing_one")));
    });

    test("store variables, persistent and unresolved names", () => {
        const hud = screen(inv, "hud");
        assert.deepEqual(hud.storeVariables, [{ name: "gold", declaredBy: "default" }, { name: "persistent.seen", declaredBy: "persistent" }]);
        assert.deepEqual(hud.unresolvedNames, ["secret_value"]);
        assert.deepEqual(hud.actions, { SetVariable: 1, Show: 1 });
        assert.equal(screen(inv, "shop").actions.Return, 1);
    });

    test("characters", () => {
        const c = Object.fromEntries(inv.characters.map((x) => [x.variable, x]));
        assert.deepEqual([c.a.displayName, c.a.image, c.a.screen, c.a.kind], ["Alice", "alice", "talk", "adv"]);
        assert.equal(c.b.displayName, null);
        assert.equal(c.b.nameExpression, "name_var");
        assert.equal(c.n.kind, "nvl");
        assert.equal(c.n2.kind, "nvl");
        assert.equal(c.d.constructor, "DynamicCharacter");
        assert.equal(c.d.nameExpression, "[hero_name]");
        assert.ok(inv.needsReview.some((r) => r.kind === "dynamicCharacterName" && r.line === 2));
    });

    test("rejects a folder without game/", async () => {
        await assert.rejects(diagnose(tmp), /game/);
    });
});

describe("config.auto_voice", () => {
    let dir;
    let inv;
    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-autovoice-"));
        const game = path.join(dir, "game");
        const write = (rel, text) => {
            fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true });
            fs.writeFileSync(path.join(game, rel), text);
        };
        write("options.rpy", 'define config.auto_voice = "voice/{id}.ogg"\n');
        write("script.rpy", [
            'define a = Character("A")',
            "",
            "label start:",
            "",
            '    a "First."',
            '    a "First."',
            '    a "She said \\"hi\\"." with dissolve',
            "    menu:",
            '        "Bare caption."',
            '        "Go":',
            "            pass",
            "    menu pick:",
            '        a "Which one?"',
            '        "Left":',
            "            pass",
            '    "Narration after the menu."',
            '    a "Fixed." id custom_line',
            "    return",
        ].join("\n"));
        // Identifiers as Ren'Py writes them, with one that is not in the script any more.
        write("tl/schinese/script.rpy", [
            "translate schinese start_2222d3ae:",
            '    a "第一句。"',
            "translate schinese pick_267af3a3:",
            '    a "哪个？"',
            "translate schinese start_00000000:",
            '    a "删掉的一句。"',
            "translate schinese strings:",
            '    old "Go"',
            '    new "走"',
        ].join("\n"));
        write("voice/start_2222d3ae.ogg", "");
        write("voice/custom_line.ogg", "");
        inv = await diagnose(dir);
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("each line's voice file is named after the identifier Ren'Py gives it", () => {
        const sp = inv.extensions.speakers;
        assert.equal(sp.summary.voicedLines, 0);
        assert.equal(sp.summary.autoVoicedLines, 2);
        assert.equal(sp.autoVoice.pattern, "voice/{id}.ogg");
        assert.equal(sp.autoVoice.file, "options.rpy");
        // Expected identifiers computed apart from the scanner, with Python's hashlib.
        assert.deepEqual(sp.autoVoice.entries.map((x) => [x.line, x.id, x.exists]), [
            [5, "start_2222d3ae", true],
            [6, "start_2222d3ae_1", false],
            [7, "start_aa0fff06", false],
            // Line 9, the bare caption, is part of the menu and has no identifier.
            [13, "pick_267af3a3", false],
            [16, "pick_61323630", false],
            [17, "custom_line", true],
        ]);
        assert.deepEqual(sp.autoVoice.checked, { language: "schinese", folder: "tl/schinese", identifiers: 3, found: 2 });
        assertCamelCase(inv);
    });
});

describe("config.auto_voice on the_question", sdkOpts, () => {
    let dir;
    after(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

    test("every identifier computed for The Question is one its translations use", async () => {
        // A copy, so the setting can be added without touching the SDK.
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-tq-voice-"));
        fs.cpSync(path.join(QUESTION, "game"), path.join(dir, "game"), { recursive: true, filter: (f) => !/[/\\](cache|saves)$/.test(f) });
        fs.appendFileSync(path.join(dir, "game", "options.rpy"), '\ndefine config.auto_voice = "voice/{id}.ogg"\n');
        const av = (await diagnose(dir)).extensions.speakers.autoVoice;
        assert.equal(av.lines, 70);
        assert.equal(av.checked.found, 70);
    });
});
