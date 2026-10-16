import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

import { chooseSdk, compareVersions, describeSdk } from "../server/sdk.js";
import { publicKeyLines, slotOf, stageSaves, zipEntries, zipRead, describeSave, readSaveDirectory } from "../server/saves.js";
import { CAPTURE_SCRIPT, cloneGame, fingerprint, saveKey, scriptScreens, unreachedItems } from "../server/capture.js";

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "r2l-cap-"));
}

/** A minimal zip writer for the tests: entries are { name, data, deflate }. */
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name);
        const data = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
        const method = e.deflate ? 8 : 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(e.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += 30 + name.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

test("compareVersions orders dotted versions numerically", () => {
    assert.ok(compareVersions("8.10.0", "8.9.9") > 0);
    assert.ok(compareVersions("7.4.11", "8.0") < 0);
    assert.equal(compareVersions("8.5.2", "8.5.2"), 0);
});

test("describeSdk recognises an SDK folder and its version", () => {
    const dir = path.join(tmpDir(), "renpy-8.5.2-sdk");
    fs.mkdirSync(path.join(dir, "renpy"), { recursive: true });
    fs.writeFileSync(path.join(dir, "renpy", "vc_version.py"), "version = '8.5.2.26010301'\n");
    fs.writeFileSync(path.join(dir, process.platform === "win32" ? "renpy.exe" : "renpy.sh"), "");
    const sdk = describeSdk(dir);
    assert.equal(sdk.version, "8.5.2");
    assert.equal(sdk.major, 8);
    assert.equal(sdk.python, 3);
    assert.equal(describeSdk(path.dirname(dir)), null);
});

test("chooseSdk prefers the request, then the wanted major, then the newest", () => {
    const sdks = [
        { path: "/a", version: "8.5.2", major: 8 },
        { path: "/b", version: "7.8.4", major: 7 },
    ];
    assert.equal(chooseSdk(sdks, { requested: "/b" }).path, "/b");
    assert.equal(chooseSdk(sdks, { wantMajor: 7 }).path, "/b");
    assert.equal(chooseSdk(sdks, {}).path, "/a");
    assert.equal(chooseSdk([], {}), null);
});

test("slot names drop Ren'Py 8's location suffix", () => {
    assert.equal(slotOf("1-1-LT1.save"), "1-1");
    assert.equal(slotOf("auto-3.save"), "auto-3");
    assert.equal(saveKey("quick-1-LT1.save"), "save--quick-1");
});

test("zip reader reads stored and deflated entries", () => {
    const buf = makeZip([
        { name: "extra_info", data: Buffer.from("第三章开头") },
        { name: "screenshot.png", data: Buffer.alloc(300, 7), deflate: true },
    ]);
    const entries = zipEntries(buf);
    assert.deepEqual([...entries.keys()], ["extra_info", "screenshot.png"]);
    assert.equal(zipRead(buf, entries.get("extra_info")).toString("utf8"), "第三章开头");
    assert.deepEqual(zipRead(buf, entries.get("screenshot.png")), Buffer.alloc(300, 7));
});

test("describeSave reads the save's name and thumbnail flag", () => {
    const dir = tmpDir();
    const file = path.join(dir, "2-3-LT1.save");
    fs.writeFileSync(file, makeZip([
        { name: "extra_info", data: Buffer.from("night") },
        { name: "screenshot.png", data: Buffer.from("png") },
    ]));
    const info = describeSave(file);
    assert.equal(info.slot, "2-3");
    assert.equal(info.name, "night");
    assert.equal(info.thumbnail, true);
});

test("publicKeyLines writes public keys only, deriving them from signing keys", () => {
    const dir = tmpDir();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const sec1 = privateKey.export({ format: "der", type: "sec1" }).toString("base64");
    const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey
        .export({ format: "der", type: "spki" }).toString("base64");
    const file = path.join(dir, "security_keys.txt");
    fs.writeFileSync(file, `signing-key ${sec1}\nverifying-key ${other}\ngarbage\n`);

    const lines = publicKeyLines(file);
    assert.deepEqual(lines.sort(), [`verifying-key ${spki}`, `verifying-key ${other}`].sort());
    assert.ok(!lines.join("\n").includes(sec1));
});

test("stageSaves copies saves and persistent, and no private key", () => {
    const src = tmpDir();
    fs.writeFileSync(path.join(src, "1-1-LT1.save"), "a");
    fs.writeFileSync(path.join(src, "1-2-LT1.save"), "b");
    fs.writeFileSync(path.join(src, "persistent"), "p");
    const keys = path.join(tmpDir(), "security_keys.txt");
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const sec1 = privateKey.export({ format: "der", type: "sec1" }).toString("base64");
    fs.writeFileSync(keys, `signing-key ${sec1}\n`);
    process.env.REN2LEAF_RENPY_TOKENS = keys;
    try {
        const root = path.join(tmpDir(), "load");
        const out = stageSaves({ sourceDir: src, files: ["1-1-LT1.save"], savesRoot: root, saveDirectory: "game-123" });
        assert.equal(out.verifyingKeys, 1);
        assert.deepEqual(fs.readdirSync(path.join(root, "game-123")).sort(), ["1-1-LT1.save", "persistent"]);
        const written = fs.readFileSync(path.join(root, "tokens", "security_keys.txt"), "utf8");
        assert.match(written, /^verifying-key /);
        assert.ok(!written.includes("signing-key"));
        assert.throws(() => stageSaves({ sourceDir: src, files: ["../x.save"], savesRoot: root, saveDirectory: "g" }));
    } finally {
        delete process.env.REN2LEAF_RENPY_TOKENS;
    }
});

test("readSaveDirectory finds config.save_directory", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "game", "script"), { recursive: true });
    fs.writeFileSync(path.join(root, "game", "script", "options.rpy"), 'define config.save_directory = "Demo-1700000000"\n');
    assert.equal(readSaveDirectory(root), "Demo-1700000000");
});

test("cloneGame copies game/ without saves and cache, and adds the capture script", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "game", "saves"), { recursive: true });
    fs.mkdirSync(path.join(root, "game", "cache"), { recursive: true });
    fs.mkdirSync(path.join(root, "game", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "game", "script.rpy"), "label start:\n    return\n");
    fs.writeFileSync(path.join(root, "game", "images", "bg.png"), "x");
    fs.writeFileSync(path.join(root, "game", "saves", "1-1.save"), "s");
    fs.writeFileSync(path.join(root, "game", "cache", "bytecode.rpyb"), "c");

    const before = fingerprint(path.join(root, "game"));
    const run = path.join(tmpDir(), "run");
    cloneGame(root, run);
    const after = fingerprint(path.join(root, "game"));

    assert.equal(before.hash, after.hash, "the original is untouched");
    assert.ok(fs.existsSync(path.join(run, "game", "script.rpy")));
    assert.ok(fs.existsSync(path.join(run, "game", "images", "bg.png")));
    assert.ok(!fs.existsSync(path.join(run, "game", "saves")));
    assert.ok(!fs.existsSync(path.join(run, "game", "cache")));
    assert.equal(
        fs.readFileSync(path.join(run, "game", "_ren2leaf_capture.rpy"), "utf8"),
        fs.readFileSync(CAPTURE_SCRIPT, "utf8"),
    );
});

test("fingerprint changes when a file in the folder changes", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.rpy"), "1");
    const a = fingerprint(dir);
    fs.writeFileSync(path.join(dir, "b.rpy"), "2");
    const b = fingerprint(dir);
    assert.notEqual(a.hash, b.hash);
    assert.equal(b.files, 2);
});

test("unreachedItems lists defined screens nothing reached, minus parts included with use", () => {
    const manifest = {
        discover: { screens: ["main_menu", "gallery", "say", "help", "about", "navigation", "game_menu", "_r2l_boxes"].map((name) => ({ name })) },
        items: [
            { key: "main_menu", screen: "main_menu", status: "ok" },
            { key: "gallery", screen: "gallery", status: "ok" },
            { key: "gallery--2", screen: "gallery", via: "state", parent: "gallery", status: "ok" },
            { key: "say--s", status: "ok" },
        ],
        reached: ["main_menu", "gallery"],
    };
    const inventory = { screens: [
        { name: "help", uses: ["game_menu"] },
        { name: "game_menu", uses: ["navigation"] },
        { name: "gallery", uses: [] },
    ] };
    assert.deepEqual(unreachedItems(manifest, inventory).map((it) => it.key), ["about", "game_menu", "help", "navigation"]);
    inventory.screens.push({ name: "main_menu", uses: ["navigation"] });
    assert.deepEqual(unreachedItems(manifest, inventory).map((it) => it.key), ["about", "game_menu", "help"]);
});

test("scriptScreens keeps screens shown or called from a label", () => {
    const inventory = { screens: [
        { name: "phone", defined: true, callSites: [{ kind: "call", label: "chapter1" }] },
        { name: "choice", defined: true, callSites: [{ kind: "menu", label: "chapter1" }] },
        { name: "gallery", defined: true, callSites: [{ kind: "show", label: null, caller: "main_menu" }] },
        { name: "ghost", defined: false, callSites: [{ kind: "show", label: "x" }] },
    ] };
    assert.deepEqual(scriptScreens(inventory), ["phone"]);
});
