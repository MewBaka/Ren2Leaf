// What the migrator's split turns into in NarraLeaf Studio: one story, its chapters, each chapter's
// scenes. Pure data in, pure data out, so the flow step draws its preview from the same answer the
// exported package hands the agent. Imported by the browser and by the server alike.

/**
 * Labels the engine enters by itself that are not story. They are not scenes: a splash screen or a
 * main menu is the interface's business. `start` is story and stays.
 */
export const ENGINE_LABELS = new Set([
    "splashscreen", "before_main_menu", "main_menu", "after_load", "after_warp", "quit",
    "hide_windows", "_start", "_main_menu", "_quit", "autosave", "replay",
]);

/** A local label (`label .part` under `label a`) is written `a.part`; it stays in its owner's scene. */
export const isLocal = (name) => name.includes(".");

/** The labels that become scenes when scenes are split by label, in the file's own order. */
export function sceneLabels(file) {
    return (file?.labels ?? []).filter((l) => !isLocal(l.name) && !ENGINE_LABELS.has(l.name));
}

/**
 * @param {object} plan  the chapter plan: `{ split: {chapters, scenes}, chapters: [...] }`
 * @param {Array} files  `flow.files` from the inventory
 * @returns {{ready: boolean, chapters: Array}} `ready` is false until both axes are picked
 */
export function outline(plan, files = []) {
    const split = plan?.split ?? {};
    const byFile = new Map(files.map((f) => [f.file, f]));
    const chapters = (plan?.chapters ?? []).map((c, i) => {
        const says = c.files.reduce((n, f) => n + (byFile.get(f)?.says ?? 0), 0);
        const scenes = split.scenes
            ? c.files.flatMap((f) => sceneLabels(byFile.get(f)).map((l) => ({
                name: l.name, untitled: false, label: l.name, file: f, line: l.line,
                says: localSays(byFile.get(f), l.name) + l.says, reachable: l.reachable,
                entry: l.name === "start",
            })))
            : [{
                name: c.sceneTitle || "New Scene", untitled: !c.sceneTitle, description: c.description || "",
                says, entry: c.files.some((f) => byFile.get(f)?.labels.some((l) => l.name === "start")),
            }];
        return { id: c.id, index: i, name: c.title || "New Chapter", untitled: !c.title, files: c.files, says, scenes };
    });
    return { ready: split.chapters !== null && split.chapters !== undefined && split.scenes !== null && split.scenes !== undefined, chapters };
}

/** The dialogue in a label's local labels, which is written into that label's scene. */
function localSays(file, owner) {
    return (file?.labels ?? []).filter((l) => l.name.startsWith(`${owner}.`)).reduce((n, l) => n + l.says, 0);
}
