// Finding a Ren'Py SDK to run captures with. Nothing is downloaded here: the SDKs come from the
// paths the migrator configured, the usual install places, and the Ren2Leaf cache.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultHome } from "./games.js";

function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function listDirs(parent, pattern) {
    try {
        return fs.readdirSync(parent)
            .filter((name) => pattern.test(name))
            .map((name) => path.join(parent, name))
            .filter(isDir);
    } catch {
        return [];
    }
}

/** The program that starts a project with this SDK on this platform. */
export function sdkLauncher(sdkPath) {
    const names = process.platform === "win32" ? ["renpy.exe"] : ["renpy.sh"];
    for (const name of names) {
        const p = path.join(sdkPath, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/** Reads the SDK version from `renpy/vc_version.py`, falling back to the folder name. */
export function sdkVersion(sdkPath) {
    try {
        const src = fs.readFileSync(path.join(sdkPath, "renpy", "vc_version.py"), "utf8");
        const m = /^version\s*=\s*['"]([\d.]+)/m.exec(src);
        if (m) return m[1].split(".").slice(0, 3).join(".");
    } catch {
        // Older SDKs keep the version elsewhere; the folder name usually carries it.
    }
    const m = /renpy-(\d+(?:\.\d+)+)/.exec(path.basename(sdkPath));
    return m ? m[1] : null;
}

/** Describes an SDK folder, or returns null when it is not one. */
export function describeSdk(sdkPath) {
    if (!isDir(path.join(sdkPath, "renpy"))) return null;
    const launcher = sdkLauncher(sdkPath);
    if (!launcher) return null;
    const version = sdkVersion(sdkPath);
    const major = version ? Number(version.split(".")[0]) : null;
    return { path: sdkPath, version, major, launcher, python: major && major >= 8 ? 3 : 2 };
}

/** Remembers an SDK folder the migrator picked, in ~/.ren2leaf/settings.json. */
export function addSdkPath(sdkPath, home = defaultHome()) {
    const settings = readSettings(home);
    const paths = Array.isArray(settings.sdkPaths) ? settings.sdkPaths : [];
    if (!paths.includes(sdkPath)) paths.unshift(sdkPath);
    settings.sdkPaths = paths;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

function readSettings(home) {
    try {
        return JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
    } catch {
        return {};
    }
}

/**
 * Every SDK found, newest first. `extra` paths (from settings or the request) come first so a
 * migrator's own choice is never shadowed by an auto-detected one.
 */
export function findSdks({ home = defaultHome(), extra = [] } = {}) {
    const settings = readSettings(home);
    const candidates = [
        ...extra,
        ...(Array.isArray(settings.sdkPaths) ? settings.sdkPaths : []),
        ...listDirs(path.join(home, "sdk"), /./),
        ...listDirs("/Applications", /^renpy-[\d.]+-sdk$/),
        ...listDirs(path.join(os.homedir(), "Applications"), /^renpy-[\d.]+-sdk$/),
        ...listDirs(os.homedir(), /^renpy-[\d.]+-sdk$/),
        ...listDirs(path.join(os.homedir(), "Desktop"), /^renpy-[\d.]+-sdk$/),
    ];
    const seen = new Set();
    const sdks = [];
    for (const c of candidates) {
        let real;
        try {
            real = fs.realpathSync(c);
        } catch {
            continue;
        }
        if (seen.has(real)) continue;
        seen.add(real);
        const sdk = describeSdk(real);
        if (sdk) sdks.push(sdk);
    }
    return sdks.sort((a, b) => compareVersions(b.version, a.version));
}

export function compareVersions(a, b) {
    const pa = String(a || "0").split(".").map(Number);
    const pb = String(b || "0").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

/**
 * Chooses the SDK for a game: the requested path if it is an SDK, else the newest one of the
 * wanted major version (7 for games that need Python 2), else the newest one.
 */
export function chooseSdk(sdks, { requested, wantMajor } = {}) {
    if (requested) {
        const hit = sdks.find((s) => s.path === requested) || describeSdk(requested);
        if (hit) return hit;
    }
    if (wantMajor) {
        const hit = sdks.find((s) => s.major === wantMajor);
        if (hit) return hit;
    }
    return sdks[0] || null;
}
