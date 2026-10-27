import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnose } from "../server/diagnose/index.js";
import { mergeDecisions, decisionStats, mergeDocument, readDocument } from "../server/decisions.js";
import { buildDocument, collect, folderName, planFiles, readiness, writePackage } from "../server/export.js";

const SDK = process.env.RENPY_SDK || "/Applications/renpy-8.5.2-sdk";
const QUESTION = path.join(SDK, "the_question");
const sdkOpts = { skip: fs.existsSync(path.join(QUESTION, "game")) ? false : `Ren'Py SDK 不在 ${SDK}` };

// A small game written for these tests: every shape the three steps have to handle, and nothing
// else, so the numbers below can be read off the source.
function writeFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-fixture-"));
    const game = path.join(dir, "game");
    fs.mkdirSync(path.join(game, "tl", "chinese"), { recursive: true });
    const write = (rel, text) => fs.writeFileSync(path.join(game, rel), text);
    const filler = (who, n, from) => Array.from({ length: n }, (_, i) => `    ${who} "填充第 ${from + i} 句。"`).join("\n");

    write("options.rpy", [
        'define config.name = "Fixture"',
        'define config.version = "1.0"',
        "init python:",
        "    gui.init(1280, 720)",
        '    config.window_title = "Fix" + "ture"',
        "",
    ].join("\n"));

    write("characters.rpy", [
        'define e = Character("Eileen")',
        'define e2 = Character("Eileen")',
        'define q = Character("？？？")',
        'define n = Character(None)',
        'define ghost = Character("Ghost")',
        "default flag = False",
        "default count = 0",
        "default toggled = False",
        "default started = time.time()",
        "",
        "style fixture_style:",
        '    font "DejaVuSans.ttf"',
        "",
        "screen fixture_screen():",
        "    vbox:",
        '        label "标题"',
        '        textbutton "走" action Jump("shared")',
        "",
        "init python:",
        "    def my_helper(x):",
        "        return x",
        '    renpy.register_statement("flash", execute=my_helper)',
        "",
    ].join("\n"));

    write("script.rpy", [
        "label start:",
        "    scene bg room",
        "    show eileen happy",
        '    "一句旁白。"',
        '    e "你好。"',
        '    e happy "带属性的一句。"',
        '    "店员" "一次性说话人。"',
        '    voice "voice/eileen/0001.ogg"',
        '    e "带配音的一句。"',
        "    $ flag = True",
        "    $ count += 1",
        "    $ toggled = not toggled",
        "    $ renpy.pause(1.0)",
        '    $ achievement.grant("first")',
        '    $ renpy.show(dynamic_name)',
        "    flash 0.5",
        "    show eileen at center:",
        "        linear 1.0 xalign 0.5",
        '    e "ATL 之后的一句。"',
        filler("e", 30, 1),
        '    $ renpy.movie_cutscene("movie/op.webm")',
        filler("e", 30, 31),
        "    menu:",
        '        "往左。":',
        "            jump left_path",
        '        "往右。" if flag:',
        "            jump right_path",
        "",
        "label right_path:",
        '    e "右边。"',
        '    call grant_ach("1")',
        "    jump shared",
        "",
        "label left_path:",
        '    voice "voice/alice/0002.ogg"',
        '    q "我是谁？"',
        '    voice "voice/bob/0003.ogg"',
        '    q "换了个人。"',
        "    stop music",
        '    play music "bgm/next.ogg"',
        '    e "换曲之后。"',
        "    jump the_end",
        "",
        "label shared:",
        '    e2 "共用段落。"',
        "    return",
        "",
        "label orphan:",
        '    e "没人跳到这里。"',
        "    return",
        "",
        "label missing_target:",
        "    jump nowhere",
        "",
    ].join("\n"));

    // The shapes a commercial game hides its achievements, its gallery and its sprite rewriting
    // in: one parameterised label for every achievement, a Gallery object built call by call, and
    // a global hook that rewrites attributes behind every `show`.
    write("extras.rpy", [
        "init python:",
        '    achievement.register("NEW_1_3", steam="NEW_ACHIEVEMENT_1_3")',
        '    achievement.register("NEW_2_1")',
        "    def eileen_adjuster(name, attrs):",
        '        if persistent.coat_color == "black":',
        "            return attrs",
        "        return attrs",
        "    gal = Gallery()",
        '    gal.button("cg1")',
        '    gal.image("cg1_a")',
        '    gal.image("cg1_b")',
        '    gal.unlock_image("cg1_a")',
        '    gal.condition("persistent.seen_cg1")',
        '    gal.button("cg2")',
        '    gal.image("cg2_a")',
        'define config.adjust_attributes = {"eileen": eileen_adjuster}',
        "",
        "label grant_ach(who):",
        '    if who == "1":',
        '        $ achievement.grant("NEW_1_3")',
        "    else:",
        '        $ achievement.grant("NEW_2_1")',
        "    return",
        "",
    ].join("\n"));

    // The shape a commercial game ends with: the credits are their own file and jump back to the
    // title screen, so nothing in the route ever says `return`.
    write("end.rpy", [
        "label the_end:",
        "    scene black",
        "    jump splashscreen",
        "",
    ].join("\n"));

    write(path.join("tl", "chinese", "script.rpy"), [
        "translate chinese start_1:",
        "",
        '    e "翻译过的一句，不该被算进台词。"',
        "",
        "translate chinese strings:",
        "",
        '    old "你好。"',
        '    new "你好。"',
        "",
    ].join("\n"));

    write("helpers.py", "def helper(value):\n    return value\n");
    return dir;
}

describe("fixture game", () => {
    let dir;
    let inv;
    let sp;
    let py;
    let flow;

    before(async () => {
        dir = writeFixture();
        inv = await diagnose(dir);
        sp = inv.extensions.speakers;
        py = inv.extensions.python;
        flow = inv.extensions.flow;
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("say statements: narration, attributes, one-off speakers, translations", () => {
        const e = sp.speakers.find((s) => s.variable === "e");
        assert.equal(sp.summary.narratorLines, 1);
        assert.equal(sp.inlineSpeakers.length, 1);
        assert.equal(sp.inlineSpeakers[0].name, "店员");
        assert.equal(e.lines, 67);
        assert.deepEqual(e.attributes.map((a) => a.name), ["happy"]);
        // The line in tl/ is a translation of a line already counted, not a line of its own.
        assert.ok(!e.files.some((f) => f.file.startsWith("tl/")));
    });

    test("style blocks and ATL are not dialogue and not unknown statements", () => {
        assert.ok(!sp.speakers.some((s) => s.variable === "font" || s.variable === "linear"));
        assert.deepEqual(py.unknownStatements, []);
    });

    test("sprite on stage and voice folder travel with the line", () => {
        const e = sp.speakers.find((s) => s.variable === "e");
        assert.equal(e.spriteTags[0].tag, "eileen");
        assert.equal(e.voiced, 1);
        assert.deepEqual(e.voiceDirs, [{ dir: "voice/eileen", lines: 1, from: 1, to: 1 }]);
    });

    test("a placeholder name that mixes two voice folders is split into ranges", () => {
        const q = sp.speakers.find((s) => s.variable === "q");
        assert.equal(q.lines, 2);
        assert.equal(q.ranges.length, 2);
        assert.deepEqual(q.ranges.map((r) => r.voiceDir), ["voice/alice", "voice/bob"]);
        // The take number comes from the file name, so two variables sharing a run can be spotted.
        assert.deepEqual(q.voiceDirs.map((v) => [v.dir, v.from, v.to]), [["voice/alice", 2, 2], ["voice/bob", 3, 3]]);
        assert.ok(q.flags.some((f) => f.kind === "placeholderName"));
        assert.ok(q.flags.some((f) => f.kind === "mixedVoiceDirs"));
        // The scan reports evidence only; who this variable is stays the migrator's call.
        assert.equal(q.guess, undefined);
    });

    test("variables that share a display name are reported together", () => {
        assert.equal(sp.groups.length, 1);
        assert.equal(sp.groups[0].displayName, "Eileen");
        assert.deepEqual(sp.groups[0].variables.map((v) => v.variable).sort(), ["e", "e2"]);
        assert.deepEqual(sp.speakers.find((s) => s.variable === "e").sameName, ["e2"]);
    });

    test("a character with no lines is reported as having none", () => {
        const ghost = sp.speakers.find((s) => s.variable === "ghost");
        assert.equal(ghost.lines, 0);
        assert.ok(ghost.flags.some((f) => f.kind === "unused"));
        assert.equal(sp.summary.unused, 2); // ghost and n
    });

    test("voice folders are indexed back to the variables that speak from them", () => {
        assert.deepEqual(sp.voiceDirs.map((d) => d.dir).sort(), ["voice/alice", "voice/bob", "voice/eileen"]);
        assert.deepEqual(sp.voiceDirs.find((d) => d.dir === "voice/alice").variables,
            [{ variable: "q", displayName: "？？？", lines: 1, from: 2, to: 2 }]);
    });

    test("assignments that convert mechanically", () => {
        const byLine = (line) => py.entries.find((x) => x.file === "script.rpy" && x.line === line);
        assert.equal(byLine(10).suggestion, '/set flag true');
        assert.equal(byLine(10).category, "autoSet");
        assert.equal(byLine(11).suggestion, "/inc count 1");
        assert.equal(byLine(12).suggestion, "/toggle toggled");
    });

    test("known APIs carry the row they become", () => {
        const api = Object.fromEntries(py.apiUsage.map((a) => [a.api, a]));
        assert.equal(api["renpy.pause"].target, "/wait");
        assert.equal(api["achievement.grant"].target, "/blueprint");
        assert.equal(api["renpy.movie_cutscene"].target, "/play");
        // renpy.show with a variable cannot be resolved without running the game.
        const show = py.entries.find((x) => x.api === "renpy.show");
        assert.equal(show.category, "unresolvable");
    });

    test("interface configuration is kept apart from story logic", () => {
        const title = py.entries.find((x) => x.target === "config.window_title");
        assert.equal(title.kind, "config");
        assert.equal(title.category, "drop");
        assert.ok(py.summary.configuration >= 1);
    });

    test("a non-literal default is a story variable with an expression", () => {
        const started = py.entries.find((x) => x.target === "started");
        assert.equal(started.kind, "defaultValue");
        assert.equal(started.suggestion, "/set");
    });

    test("custom statements are found with their uses in the script", () => {
        assert.equal(py.customStatements.length, 1);
        assert.equal(py.customStatements[0].name, "flash");
        assert.equal(py.customStatements[0].usageCount, 1);
        assert.equal(py.customStatements[0].usages[0].label, "start");
    });

    test("a global hook that rewrites every show, and the persistent flag it reads", () => {
        const hook = py.hooks.find((k) => k.hook === "config.adjust_attributes");
        assert.deepEqual(hook.tags, ["eileen"]);
        assert.equal(hook.everyTag, false);
        assert.equal(hook.functions[0].name, "eileen_adjuster");
        assert.deepEqual(hook.persistentReads, ["persistent.coat_color"]);
    });

    test("the gallery's own table of contents, not a pile of unknown calls", () => {
        assert.deepEqual(py.galleries.map((g) => [g.button, g.images]), [
            ["cg1", ["cg1_a", "cg1_b"]],
            ["cg2", ["cg2_a"]],
        ]);
        assert.deepEqual(py.galleries[0].unlocks, ["cg1_a"]);
        assert.deepEqual(py.galleries[0].conditions, ["persistent.seen_cg1"]);
        // And they are no longer "a call to an unknown function".
        assert.ok(!py.entries.some((e) => e.callee?.startsWith("gal.") && e.category === "needsAgent"));
    });

    test("an achievement unlocks where it is called, with its Steam id", () => {
        const ach = inv.extensions.facts.achievements;
        assert.deepEqual(ach.declared.map((d) => [d.name, d.steam]), [
            ["NEW_1_3", "NEW_ACHIEVEMENT_1_3"],
            ["NEW_2_1", null],
        ]);
        const unlock = ach.unlockPoints.find((u) => u.name === "NEW_1_3");
        assert.ok(unlock.site.startsWith("script.rpy:"));
        assert.equal(unlock.steam, "NEW_ACHIEVEMENT_1_3");
        assert.equal(unlock.arguments, '("1")');
        assert.equal(unlock.certain, true);
        // The other branch does not match that call site, so it is not listed under it.
        assert.ok(!ach.unlockPoints.some((u) => u.name === "NEW_2_1" && u.site === unlock.site));
    });

    test("the game's own functions and modules are listed", () => {
        assert.ok(py.functions.some((f) => f.name === "my_helper"));
        assert.deepEqual(py.modules, [{ file: "helpers.py", lines: 2 }]);
    });

    test("store variables keep where they came from", () => {
        const flag = py.variables.find((v) => v.name === "flag");
        assert.equal(flag.declaredBy, "default");
        assert.equal(flag.writes, 1);
    });

    test("the label graph: jumps, menu targets, fall-through and screen actions", () => {
        const names = flow.labels.map((l) => l.name);
        assert.ok(names.includes("start"));
        const menu = flow.menus[0];
        assert.deepEqual(menu.choices.map((c) => c.target), ["left_path", "right_path"]);
        assert.equal(menu.choices[1].condition, "flag");
        // Jump("shared") in a screen is an entry edge, so `shared` is reachable on its own.
        assert.ok(flow.labels.find((l) => l.name === "shared").reachable);
    });

    test("play order is not file order", () => {
        const play = flow.labels.filter((l) => l.reachable).map((l) => l.name);
        assert.deepEqual(play.slice(0, 4), ["start", "left_path", "the_end", "right_path"]);
        assert.ok(flow.warnings.some((w) => w.kind === "playOrderDiffersFromFileOrder"));
    });

    test("labels nothing reaches, and jumps to labels that do not exist", () => {
        assert.deepEqual(flow.unreachable.map((l) => l.name).sort(), ["missing_target", "orphan"]);
        assert.deepEqual(flow.undefinedTargets.map((e) => e.target), ["nowhere"]);
    });

    test("routes end with a return, or with a jump back to the title screen", () => {
        assert.deepEqual(flow.endings.map((e) => e.name).sort(), ["shared", "the_end"]);
        const credits = flow.endings.find((e) => e.name === "the_end");
        assert.equal(credits.kind, "toTitle");
        assert.equal(credits.titleTarget, "splashscreen");
        assert.ok(flow.warnings.some((w) => w.kind === "endingsReturnToTitle"));
    });

    test("per-file facts and the signals a chapter break could be cut at", () => {
        // No chapters are invented: the migrator groups the files themselves.
        assert.equal(flow.chapters, undefined);
        const script = flow.files.find((f) => f.file === "script.rpy");
        assert.equal(script.says, 72);
        assert.equal(script.menus, 1);
        assert.ok(script.labels.some((l) => l.name === "start"));
        assert.ok(script.breaks.some((b) => b.kind === "movie"));
        assert.ok(flow.breaks.some((b) => b.kind === "stopMusic"));
        assert.ok(flow.warnings.some((w) => w.kind === "chapterIsYours"));
    });
});


// A second small game, for the asset check only: a handful of real files on disk and a script that
// points at them, at a few that are not there, and at one whose extension lies.
function writeAssetFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-assets-"));
    const game = path.join(dir, "game");
    for (const d of ["images", "videos", "audio/bgm", "se"]) fs.mkdirSync(path.join(game, d), { recursive: true });
    const put = (rel, buf) => fs.writeFileSync(path.join(game, rel), buf);
    const png = (payload) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(payload)]);
    const webm = (payload) => Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.from("webm"), Buffer.from(payload)]);

    put("images/eileen_happy.png", png("same bytes"));
    // Byte for byte the file above, under another name.
    put("images/eileen_sad.png", png("same bytes"));
    put("images/bg_room.png", png("a room"));
    put("images/auto_tag.png", png("defined by its own file name"));
    put("videos/clip.webm", webm("picture"));
    put("videos/clip_mask.webm", webm("alpha"));
    put("videos/old.ogv", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("theora")]));
    put("audio/bgm/theme.ogg", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("vorbis")]));
    // A WAV that somebody renamed to .ogg.
    put("se/wrong.ogg", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]));

    fs.writeFileSync(path.join(game, "images.rpy"), [
        'image eileen happy = "images/eileen_happy.png"',
        'image eileen sad = "images/eileen_sad.png"',
        'image eileen gone = "images/eileen_gone.png"',
        'image bg room = "images/BG_ROOM.png"',
        'image clip = Movie(play="videos/clip.webm", mask="videos/clip_mask.webm")',
        'image eileen night = im.MatrixColor("images/eileen_happy.png", im.matrix.tint(0.75, 0.75, 0.9))',
        'image old = "videos/old.ogv"',
        'image bg dark = "images/bg_dark_old.png"',
        'image bg dark = "images/bg_room.png"',
        "image stack:",
        '    "images/stack_frame.png"',
        "    pause 1.0",
        // A CG the original mirrors and shrinks, the way a commercial game reuses one drawing.
        'image cg mirror = Transform("images/bg_room.png", zoom=0.5, xzoom=-0.5, yoffset=120)',
        "image bg wide:",
        '    "images/bg_room.png"',
        "    zoom 0.9",
        "    align (0.5, 1.0)",
        "layeredimage girl:",
        "    always:",
        '        "images/eileen_happy.png"',
        "    group coat:",
        "        attribute black default",
        "        attribute white",
        "    group face auto:",
        "        attribute smile",
        'image girl small = LayeredImageProxy("girl", Transform(zoom=0.45, xzoom=-0.45, yoffset=700))',
        "",
    ].join("\n"));

    fs.writeFileSync(path.join(game, "script.rpy"), [
        'define e = Character("Eileen")',
        'define nobody = Character("Nobody", image="noimg")',
        "label start:",
        "    scene bg room",
        "    show eileen happy",
        "    show auto_tag",
        "    show ghosttag",
        '    play music "bgm/theme.ogg"',
        '    play sound "se/wrong.ogg"',
        '    play sound "se/absent.ogg"',
        '    voice "voice/v1.ogg"',
        '    e "一句话。"',
        "    return",
        "",
    ].join("\n"));
    return dir;
}

describe("asset check", () => {
    let dir;
    let assets;

    before(async () => {
        dir = writeAssetFixture();
        assets = (await diagnose(dir)).extensions.assets;
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("every file an image definition is built from is counted, ATL bodies included", () => {
        assert.equal(assets.summary.imageDefinitions, 14);
        assert.equal(assets.summary.imageReferences, 14);
        assert.equal(assets.summary.audioReferences, 4);
        // Four tags are asked for by show/scene; the character's image= tag is not one of them.
        assert.equal(assets.summary.shownTags, 4);
        // The string inside `image stack:` belongs to that image, so it is checked like any path.
        assert.deepEqual(assets.missing.find((r) => r.path === "images/stack_frame.png").statements, ["image stack"]);
    });

    test("how an image is placed: zoom, mirroring, layered groups and proxies", () => {
        const byName = new Map(assets.geometry.map((d) => [d.name, d]));
        const cg = byName.get("cg mirror");
        assert.equal(cg.mirrored, true);
        assert.deepEqual(cg.properties.map((p) => `${p.name} ${p.value}`), ["zoom 0.5", "xzoom -0.5", "yoffset 120"]);
        const bg = byName.get("bg wide");
        assert.deepEqual(bg.properties.map((p) => p.name), ["zoom", "align"]);
        const girl = byName.get("girl");
        assert.equal(girl.statement, "layeredimage");
        assert.deepEqual(girl.groups.map((g) => [g.name, g.auto, g.attributes]), [
            ["coat", false, ["black", "white"]],
            ["face", true, ["smile"]],
        ]);
        assert.deepEqual(assets.autoGroups.map((g) => `${g.image}.${g.group}`), ["girl.face"]);
        const proxy = byName.get("girl small");
        assert.equal(proxy.proxyOf, "girl");
        assert.equal(proxy.mirrored, true);
        assert.equal(assets.summary.mirroredImages, 2);
    });

    test("a file the script points at and game/ does not have", () => {
        const paths = assets.missing.map((r) => r.path);
        assert.deepEqual(paths.sort(), [
            "images/bg_dark_old.png", "images/eileen_gone.png", "images/stack_frame.png",
            "se/absent.ogg", "voice/v1.ogg",
        ]);
        const gone = assets.missing.find((r) => r.path === "images/eileen_gone.png");
        assert.equal(gone.kind, "image");
        assert.equal(gone.statements[0], "image eileen gone");
        // Nothing shows the "eileen gone" definition's tag… except that "eileen happy" shares it.
        assert.equal(gone.tagShown, true);
        assert.equal(assets.missing.find((r) => r.path === "voice/v1.ogg").kind, "audio");
    });

    test("the last definition of a name wins, so the one before it is dead", () => {
        assert.deepEqual(assets.redefined.map((r) => r.name), ["bg dark"]);
        assert.equal(assets.missing.find((r) => r.path === "images/bg_dark_old.png").superseded, true);
        assert.equal(assets.summary.missingSuperseded, 1);
    });

    test("Ren'Py's own search rules are followed: the audio/ folder and letter case", () => {
        // play music "bgm/theme.ogg" is game/audio/bgm/theme.ogg.
        assert.equal(assets.summary.resolvedViaPrefix, 1);
        assert.deepEqual(assets.caseMismatch.map((r) => [r.path, r.onDisk]), [["images/BG_ROOM.png", "images/bg_room.png"]]);
    });

    test("a tag show asks for that nothing defines", () => {
        assert.deepEqual(assets.unknownTags.map((t) => t.tag), ["ghosttag"]);
        // images/auto_tag.png defines "auto_tag" by itself, as Ren'Py does on startup.
        assert.ok(!assets.unknownTags.some((t) => t.tag === "auto_tag"));
        // A character's image= tag is weaker evidence, so it is listed apart.
        assert.deepEqual(assets.unknownCharacterImages.map((t) => t.tag), ["noimg"]);
    });

    test("an extension that lies about the format", () => {
        assert.deepEqual(assets.formatMismatch.map((f) => [f.path, f.extension, f.actual]),
            [["se/wrong.ogg", ".ogg", "wav"]]);
    });

    test("two files with the same bytes, found without reading everything", () => {
        assert.equal(assets.duplicates.length, 1);
        assert.deepEqual(assets.duplicates[0].files, ["images/eileen_happy.png", "images/eileen_sad.png"]);
        assert.equal(assets.summary.duplicateFiles, 2);
        // Only the files that already share a byte size are read, never the whole game.
        assert.ok(assets.notes.hashedBytes >= assets.duplicates[0].bytes * 2);
        assert.ok(assets.notes.hashedBytes < assets.summary.mediaBytes);
        assert.equal(assets.notes.hashTruncated, false);
    });

    test("what has to be dealt with outside the port", () => {
        assert.deepEqual(assets.offline.maskedMovies.map((m) => [m.name, m.play, m.mask]),
            [["clip", "videos/clip.webm", "videos/clip_mask.webm"]]);
        assert.deepEqual(assets.offline.matrixColor.map((m) => [m.name, m.constructor, m.source]),
            [["eileen night", "im.MatrixColor", "images/eileen_happy.png"]]);
        assert.deepEqual(assets.offline.formats.map((f) => [f.extension, f.count, f.referenced]), [[".ogv", 1, 1]]);
    });

    test("a file nothing points at is not reported as a problem", () => {
        assert.equal(assets.summary.missingPaths, 5);
        // images/auto_tag.png is on disk and nothing references it by path; it defines a tag.
        assert.ok(!assets.missing.some((r) => r.path.includes("auto_tag")));
    });
});

describe("speaker decisions", () => {
    const empty = { version: 1, updatedAt: null, speakers: {} };

    test("a write merges field by field and never drops other variables", () => {
        const first = mergeDecisions(empty, { speakers: { e: { role: "main", name: "Eileen" } } }).doc;
        const second = mergeDecisions(first, { speakers: { e2: { mergeInto: "e" } } }).doc;
        assert.equal(second.speakers.e.name, "Eileen");
        assert.equal(second.speakers.e.role, "main");
        assert.equal(second.speakers.e2.mergeInto, "e");
        const third = mergeDecisions(second, { speakers: { e: { note: "POV" } } }).doc;
        assert.equal(third.speakers.e.name, "Eileen");
        assert.equal(third.speakers.e.note, "POV");
    });

    test("an empty value clears one field; an entry with nothing left is removed", () => {
        const doc = mergeDecisions(empty, { speakers: { e: { role: "main", name: "Eileen" } } }).doc;
        const cleared = mergeDecisions(doc, { speakers: { e: { name: "" } } }).doc;
        assert.equal(cleared.speakers.e.name, undefined);
        assert.equal(cleared.speakers.e.role, "main");
        const gone = mergeDecisions(cleared, { speakers: { e: { role: null } } }).doc;
        assert.equal(gone.speakers.e, undefined);
    });

    test("bad input is refused", () => {
        assert.throws(() => mergeDecisions(empty, { speakers: { "not a name": {} } }), /变量名无效/);
        assert.throws(() => mergeDecisions(empty, { speakers: { e: { role: "boss" } } }), /角色类型无效/);
        assert.throws(() => mergeDecisions(empty, { speakers: { e: { role: "alias" } } }), /角色类型无效/);
        assert.throws(() => mergeDecisions(empty, { speakers: { e: { whatever: 1 } } }), /未知字段/);
        assert.throws(() => mergeDecisions(empty, { speakers: { e: { aliasOf: "x" } } }), /未知字段/);
        assert.throws(() => mergeDecisions(empty, {}), /speakers/);
    });
});

describe("the_question", sdkOpts, () => {
    let inv;
    before(async () => {
        inv = await diagnose(QUESTION);
    });

    test("speakers, with narration counted apart", () => {
        const s = inv.extensions.speakers;
        assert.deepEqual(s.speakers.map((x) => x.variable).sort(), ["m", "s"]);
        assert.equal(s.summary.spokenLines, 40);
        assert.equal(s.summary.narratorLines, 31);
    });

    test("flow reaches every label and finds both endings", () => {
        const f = inv.extensions.flow;
        assert.equal(f.summary.unreachable, 0);
        assert.deepEqual(f.endings.map((e) => e.name).sort(), ["later", "marry"]);
        assert.equal(f.menus.length, 2);
    });
});

describe("export package", () => {
    let dir;
    let work;
    let game;

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "ren2leaf-export-"));
        work = path.join(dir, "work");
        const gameDir = path.join(dir, "game", "game");
        fs.mkdirSync(gameDir, { recursive: true });
        fs.writeFileSync(path.join(gameDir, "script.rpy"), [
            'define e = Character("Eileen")',
            'define e2 = Character("Eileen")',
            'define q = Character("？？？")',
            "label start:",
            '    e "你好。"',
            '    e2 "换了一套立绘。"',
            '    q "我是谁？"',
            "    return",
            "",
        ].join("\n"));
        fs.mkdirSync(work, { recursive: true });
        const inventory = await diagnose(path.join(dir, "game"));
        fs.writeFileSync(path.join(work, "inventory.json"), JSON.stringify(inventory));
        fs.mkdirSync(path.join(work, "decisions"), { recursive: true });
        fs.writeFileSync(path.join(work, "decisions", "speakers.json"), JSON.stringify({
            version: 1,
            updatedAt: new Date().toISOString(),
            speakers: {
                e: { role: "main", name: "艾琳" },
                e2: { mergeInto: "e" },
                q: { role: "npc" },
            },
        }));
        fs.writeFileSync(path.join(work, "decisions", "chapters.json"), JSON.stringify({
            version: 1,
            updatedAt: new Date().toISOString(),
            mode: "none",
            chapters: [{ id: "ch1", title: "第一章", files: ["script.rpy"] }],
        }));
        // One screenshot, as step ② would have left it.
        const shot = path.join(work, "manual", "shot-1");
        fs.mkdirSync(shot, { recursive: true });
        fs.writeFileSync(path.join(shot, "full.png"), Buffer.from("89504e470d0a1a0a", "hex"));
        fs.writeFileSync(path.join(shot, "meta.json"), JSON.stringify({ key: "shot-1", purpose: "主界面", screens: ["main_menu"], gameSize: [1280, 720] }));
        fs.writeFileSync(path.join(shot, "elements.json"), JSON.stringify({
            elements: [{ type: "Button", rect: [10, 20, 100, 40], boxed: true, label: "开始游戏", location: ["game/script.rpy", 2] }],
        }));
        game = { id: "0123456789", name: "测试 Game", path: path.join(dir, "game"), workDir: work };
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("the document leads with the Skills update and keeps its section numbers", () => {
        const parts = collect(game);
        const doc = buildDocument(game, parts, planFiles(game, parts));
        const sections = doc.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim());
        assert.deepEqual(sections.map((s) => s.split("　")[0]), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
        assert.ok(sections.includes("8　资产"));
        assert.ok(doc.indexOf("npx skills add NarraLeaf/Skills -g") < doc.indexOf("## 2"));
        assert.ok(doc.includes("# 测试 Game → NarraLeaf 迁移补充包"));
    });

    test("decisions the migrator made are quoted as settled", () => {
        const parts = collect(game);
        const doc = buildDocument(game, parts, planFiles(game, parts));
        assert.ok(doc.includes("### 3.1　主要角色"));
        // Subsection numbers follow the sections that are actually written, with no gaps.
        const numbers = [...doc.matchAll(/^### (\d+)\.(\d+)/gm)].map((m) => `${m[1]}.${m[2]}`);
        const seen = new Map();
        for (const n of numbers) {
            const [section, index] = n.split(".").map(Number);
            assert.equal(index, (seen.get(section) ?? 0) + 1, `节号跳了：${n}`);
            seen.set(section, index);
        }
        assert.ok(doc.includes("艾琳"));
        assert.ok(doc.includes("迁移者的意思"));
    });

    test("merged is one character; an alias is its own character in the NPC group", () => {
        const parts = collect(game);
        const doc = buildDocument(game, parts, planFiles(game, parts));
        const npcAt = doc.indexOf("　NPC / 别名");
        const mainPart = doc.slice(doc.indexOf("### 3.1"), npcAt);
        assert.ok(mainPart.includes("合并进来的变量"));
        assert.ok(mainPart.includes("e2×1"));
        assert.ok(mainPart.includes("同一个人的另一套立绘"));
        // Somebody under another name is a character of their own, in the group.
        const npcPart = doc.slice(npcAt, doc.indexOf("　配音目录与取号"));
        assert.ok(npcPart.includes("需放入「NPC / 别名」分组"));
        assert.ok(npcPart.includes("配音取号"));
        // Merged and classified variables are settled, so they are not asked about again.
        assert.ok(!doc.includes("迁移者没分类的"));
    });

    test("the chapter plan is handed over as the migrator drew it", () => {
        const parts = collect(game);
        const doc = buildDocument(game, parts, planFiles(game, parts));
        assert.ok(doc.includes("章节 → 故事"));
        assert.ok(doc.includes("不拆分"));
        assert.ok(doc.includes("第一章"));
        assert.ok(doc.includes("一个文件只属于一个章节"));
    });

    test("screenshots and their element coordinates are listed", () => {
        const parts = collect(game);
        assert.equal(parts.shots.length, 1);
        const files = planFiles(game, parts);
        assert.ok(files.some((f) => f.path === "screens/shot-1.png"));
        assert.ok(files.some((f) => f.path === "data/screens/shot-1.elements.json"));
        const doc = buildDocument(game, parts, files);
        assert.ok(doc.includes("![主界面](screens/shot-1.png)"));
        assert.ok(doc.includes("10, 20, 100, 40"));
        assert.ok(doc.includes("开始游戏"));
    });

    test("writing the package, and writing it again over itself", async () => {
        const out = path.join(dir, "out");
        const first = await writePackage(game, out);
        assert.equal(path.basename(first.dir), "测试-Game-ren2leaf");
        assert.ok(fs.existsSync(path.join(first.dir, "README.md")));
        assert.ok(fs.existsSync(path.join(first.dir, "screens", "shot-1.png")));
        assert.ok(fs.existsSync(path.join(first.dir, "data", "inventory.json")));
        assert.ok(first.bytes > 0);
        await assert.rejects(() => writePackage(game, out), /已经有一份补充包/);
        const again = await writePackage(game, out, { overwrite: true });
        assert.equal(again.dir, first.dir);
    });

    test("a folder that is not ours is never replaced", async () => {
        const out = path.join(dir, "out2");
        const target = path.join(out, "测试-Game-ren2leaf");
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "important.txt"), "不要删我");
        await assert.rejects(() => writePackage(game, out, { overwrite: true }), /不是 Ren2Leaf 的补充包/);
        assert.ok(fs.existsSync(path.join(target, "important.txt")));
    });

    test("the folder is named after the game, minus what a file system refuses", () => {
        assert.equal(folderName("星之 / 轨迹"), "星之-轨迹");
        assert.equal(folderName("The Question"), "The-Question");
        assert.equal(folderName("///", "fallback"), "fallback");
    });


    test("a step switched off says so instead of going silent", () => {
        const file = path.join(work, "decisions", "document.json");
        fs.writeFileSync(file, JSON.stringify(mergeDocument(readDocument(work), { skip: { speakers: true, capture: true } })));
        const parts = collect(game);
        const doc = buildDocument(game, parts, planFiles(game, parts));
        // The heading stays, so the numbering holds and the silence reads as a decision.
        assert.ok(doc.includes("## 3　说话人"));
        assert.ok(doc.includes("迁移者没有把这一节交出来"));
        assert.ok(!doc.includes("### 3.1　主要角色"));
        assert.ok(doc.includes("迁移者留给你判断，本节没有内容"));
        // The other sections are untouched.
        assert.ok(doc.includes("### 5.1　章节与文件"));
        const r = readiness(game, parts);
        assert.equal(r.steps.find((x) => x.id === "speakers").skipped, true);
        assert.equal(r.steps.find((x) => x.id === "flow").skipped, undefined);
        fs.rmSync(file, { force: true });
    });

    test("readiness names what is still missing", () => {
        const parts = collect(game);
        const r = readiness(game, parts);
        assert.ok(r.ready);
        assert.deepEqual(r.steps.map((s) => s.id), ["diagnose", "capture", "speakers", "flow"]);
        assert.deepEqual(r.steps.filter((s) => !s.done).map((s) => s.id), []);
        const bare = readiness(game, { inventory: null, decisions: { speakers: {} }, chapters: { chapters: [], mode: null }, shots: [] });
        assert.equal(bare.ready, false);
    });
});
