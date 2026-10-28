---
name: narraleaf-port-renpy
description: Port a finished Ren'Py visual novel, with its source, into NarraLeaf Studio through Studio's MCP server at the highest fidelity - story, characters and sprites, backgrounds, audio, voice, video, variables and endings, gallery, and an interface traced from the running Ren'Py game. Use when the user has a Ren'Py project (a game/ folder with .rpy scripts) and wants it in NarraLeaf Studio, or asks to convert, migrate or port a Ren'Py game.
---

# Port a Ren'Py game to NarraLeaf Studio

> **Experimental.** Ren'Py porting is still being tested and is not stable yet. Tell the author so at
> the start, and list every difference from the original game you could not resolve in the hand-over.

You are moving a finished Ren'Py game into NarraLeaf Studio. Studio is open on the author's machine
and you drive it through its MCP server; every write lands live, and most are one undo step (the
make-game `SKILL.md` names the few that are not). This skill is
the porting method. It sits on top of **`narraleaf-make-game`**, which explains the tools, the text
formats and the order of work for any game - read its `SKILL.md` first (or `agent_guide
{chapter:"workflow"}`), and read its chapters when a step below sends you there. That skill is a
separate install, from [NarraLeaf/Skills](https://github.com/NarraLeaf/Skills); this one ships with
the Ren2Leaf wizard, and it needs the wizard's Studio plugin, **Ren2Leaf Bridge** - step 0 checks
for it before anything else. The Ren2Leaf pack (the facts scanned from this game, the screenshots of
its screens and the decisions the author already made) reaches you only through that plugin's tools,
never as a folder: read it with them before step 1. Rows the pack marks as the author's (`迁移者`)
are settled; the scanned ones are evidence you still check.

| Chapter | Read it before | File |
|---|---|---|
| Statement mapping | writing the converter | `references/statement-mapping.md` |
| Characters and voice | deciding who the cast is | `references/characters-and-voice.md` |
| Positions and ATL | placing anything on the stage | `references/positions-and-atl.md` |
| Assets and media | importing | `references/assets-and-media.md` |
| Interface | rebuilding any screen | `references/interface.md` |

## What "done" means

The ported game plays from the first line to every ending, looks like the Ren'Py game on every
screen the player can reach, and builds. Fidelity is judged against the **running Ren'Py game**, not
against your reading of its code: run it (step 7) and compare screenshots.

## Safety: the game is a program

A Ren'Py game's `.rpy` scripts and `python` blocks are code, and they run with the author's own
permissions the moment the game starts: the game can read and change their files and reach the
network like any program they install. Reading the scripts as text is safe; running the game is not.

- **Run a game only when the author made it or trusts where it came from.** Ask before the first run
  (step 7) and say what you will run. If they do not own or trust the game, do not run it: trace the
  interface from `screens.rpy` and from screenshots the author gives you, and say so in the hand-over.
- **Ask the author before you download or install anything** - the Ren'Py SDK, an unpacker or
  decompiler (unrpa, unrpyc), ffmpeg, fonttools, any package. Name the tool and where it comes from
  (its official site or repository) and wait for a yes. Use the author's own copy when they have one.
- **Never disable or work around a security protection** to get something to run or read: antivirus,
  SmartScreen or Gatekeeper prompts, macOS quarantine flags, file permissions, code-signing or sandbox
  settings. If one stops you, stop, tell the author what it said, and let them decide.

## Ground rules

1. **Never modify the Ren'Py source.** Read it in place; anything you change (a capture script, a
   converted file) goes in a copy or your own working folder.
2. **Write a converter, do not hand-port.** A real game is thousands of lines. Parse the scripts into
   an intermediate representation (IR) once, then generate `.story` text per scene from it. When a
   mapping turns out wrong you fix the converter and regenerate, instead of editing hundreds of rows.
   Keep it deterministic: the same source gives the same output.
3. **Keep the port's state in Ren2Leaf Bridge from the first minute**, and update it after every
   step. It lives in the project, the author follows it in the Bridge panel, and a long port that
   outlives one context window resumes from `port_status` - you or a successor.
   - The checklist (`ledger_upsert`): every feature of the original, how it is ported, and its state.
   - The port log (`log_note`): the phase you are in, every mapping decision and why, how to
     regenerate each part. "Log it" below means a `log_note`.
   - Questions (`decision_ask`): what only the author can decide - "Needs the author" below. Ask with
     options and a recommendation, then carry on with other work; the answer comes back at the top
     of a later Bridge answer.
   - Issues (`issue_add`): every problem - the tool and arguments, the exact error text, what you
     expected, the workaround, severity. The author uses them to improve Studio; do not soften them.
4. **Measure, do not assume.** Before mapping a whole category (positions, transitions, video),
   try one case in a scratch scene and look at it with `playtest_screenshot`. Delete the scratch
   scene at the end.
5. **Keep big outputs out of your context.** Write tool results to files and read the parts you
   need; send big payloads from files.

## Step 0 - Access and the project

- **Ren2Leaf Bridge first.** Look for `mewbaka_ren2leaf_bridge__port_status` in your tool list. If it
  is not there, **stop**: tell the author to install **Ren2Leaf Bridge** from Studio's plugin store
  (and enable it), then import the Ren2Leaf pack in the Ren2Leaf Bridge panel in Studio's left
  sidebar. Do nothing else until they say it is done, then check again. With the tools there, read
  `agent_guide {chapter:"plugin:mewbaka.ren2leaf-bridge"}` and call `port_status`; if it reports no
  pack imported, stop the same way and ask the author to import it. Do not ask for the pack folder
  or read one from disk instead.
- `agent_status`. Writes must be on. Call `request_folder_access` once for the Ren'Py `game` folder
  and your working folder (converted media lands there), with a one-line reason. "Pending" means the
  author has not answered yet: carry on with work that needs no import and retry every minute.
- **The project.** Start from a project made with `project_create {template: "skeleton", leaveOut:
  ["story", "characters", "files"]}`: the skeleton's pages, already wired to saving, loading,
  settings and the backlog, with one empty scene that the title's Start begins at, and no sample
  story, characters, backgrounds, music or sprite to delete. You restyle the pages to look like the
  Ren'Py screens and write the story into that scene (rename it; add the others beside it). A Studio
  older than `leaveOut` refuses it as an unknown argument: create the project without it and treat
  it as the case below. If the author already opened a project made from the whole
  `skeleton`, keep it:
  delete its sample characters and files before you import, and write every scene's `#background`
  (`none` for black), since a reused demo scene otherwise opens on its demo picture. If the author
  already opened a project made from the empty template, run
  `ui_install_standard_screens {dryRun:true}`, show the author what it adds, then run it. Do not
  rebuild save, load or settings logic by hand from store templates - they are layouts only.
- Resolution: the skeleton is laid out for 1920x1080 only, so the project is 1920x1080. Read the
  game's size from `gui.init(w, h)` (or `config.screen_width/height`) and scale every Ren'Py pixel
  value by `1920 / w` in the converter - positions, sizes, offsets, font sizes, outline widths (x1.5
  for a 1280x720 game). Capture the Ren'Py screens at 1920x1080 too (`interface.md`) so the pictures
  compare one to one. A game that is not 16:9 does not fit the skeleton's screens; ask the author
  before going on.

## Step 1 - Survey

Read, in this order, and log the facts:

1. `options.rpy` (name, version, window/menu config, `config.*`), `gui.rpy` (every `gui.*` value),
   `screens.rpy` and any other file that defines `screen` blocks.
2. Every `image` statement and the image folders (Ren'Py also defines images automatically from file
   names under `images/`). Note: plain files, `Movie(play=..., mask=...)`, `im.*` / `Transform`
   matrix effects, `LayeredImage` (a `group … auto` takes its attributes from the file names, so
   read the folder, not only the block), `LayeredImageProxy` (a layered image seen through a
   transform - both halves matter), `ConditionSwitch`, `DynamicDisplayable`.
   Count tags and attribute combinations per tag, and expect no structure: a finished game may have
   **no `layeredimage` at all** and define a thousand `image` statements over a couple of hundred
   tags, one tag reaching a hundred-odd attribute combinations. Attribute names are the author's
   private shorthand - abbreviations, initials, bare numbers (`image a00 1 = …`, `show a1 0`). Treat
   a numeric attribute as an ordinary attribute, never as an index, and do not read meaning into any
   of them.
3. `define` / `default` / `persistent.*` - characters, variables, saved vs persistent state.
4. `transform` definitions (ATL) and how often each is used.
5. The scripts: labels and the flow between them (`jump`, `call`, `menu`), endings (what each final
   label does - credits, a movie, `return`, or a `jump` back to the title screen), `python` blocks
   and what they do. Watch for a label that takes parameters (`label achievement(who):`) and is
   called with one (`call achievement ("4") from _call_achievement_1`): the space before the
   bracket and the `from` clause are both legal, and a parser that misses them loses every
   achievement in the game.
6. Global hooks installed in `init python`, above all `config.adjust_attributes` - a function that
   rewrites the attributes of every `show` of a tag, usually from a `persistent` flag. It is
   installed one key at a time, with a subscript
   (`define config.adjust_attributes["<tag>_f"] = <tag>_adjuster`), so a scan for plain `define
   <name> =` will not see it. Read what each one does: without it your sprite resolution is wrong
   for every line of that tag, and nothing in the script says so.
7. `audio/`, `voice` statements and their folders, `tl/` (a folder with only Ren'Py's own strings
   is not a game translation), achievements (`achievement.grant`, Steam), the gallery / music room /
   replay screens.
8. Missing files: Ren'Py games often reference images that do not exist (dead code paths). List them
   and do not invent them.

**Source availability.** `.rpy` files are what you parse. A shipped game may contain only `.rpyc`
(compiled) or `.rpa` archives; those must be unpacked/decompiled first (e.g. unrpa, unrpyc) - only
with the author's rights to the game, and say so in the log. These are third-party tools: ask the
author before you download or install one (see *Safety* above), and run it on a copy in your
working folder.

## Step 2 - Mapping plan

Decide, and write down with reasons (`references/statement-mapping.md` has the defaults):

- **Chapters and scenes.** When the pack's section 5 groups the scripts, that grouping is the
  author's and wins. Its chapters are Studio chapters, in its order, named as written (`New Chapter`,
  Studio's default, when a name is missing). Its scene split says what goes in each: either the
  chapter's whole script is one scene, named and described as written (`New Scene` and no
  `#description` when missing), with the labels inside as `/label`s; or every label is a scene of
  its own, named with the label's name and with no `#description`. Do not make a name or a
  description up. When section 5 says the author handed the structure to you, work the branches
  out from the source and its label table, then choose the chapters and scenes yourself; reshaping
  is allowed as long as every route plays the same. Then every scene's `#description` says which
  `.rpy` files and labels it came from and what you changed in the structure, and why.
  Without a grouping: one Studio scene per Ren'Py label that is a unit of story; split
  very long labels at `scene` statements (never inside a `menu`) and chain the parts with `/jump`.
  A scene of a few hundred rows is comfortable to review and to re-apply.
- **Characters.** Studio characters are people, and a Ren'Py game's speaker variables are not: one
  person is routinely several `Character` objects, an alias is another one again, and an empty
  display name is narration dressed as a speaker. Decide the cast from evidence - display-name
  grouping, the sprite tag each variable carries, voice take numbering for the aliases - as
  `references/characters-and-voice.md` sets out, and have the author confirm the grouping before
  any story row is generated.
- **Stage objects.** A Ren'Py *tag* is one Studio stage object. Standing sprites of the cast become
  character poses; everything else shown with `show` (CGs, overlays, chibis, effects) becomes an
  image object that `/swap` changes.
- **Text styles.** Narrator modes such as an NVL-like full-screen box or white-on-black captions
  become separate dialogue looks the story switches between (see `references/interface.md`).

## Step 3 - Assets

`references/assets-and-media.md` lists every conversion. In short: import what Studio plays as is,
convert the rest offline into your working folder (AVI/OGV/Theora video, masked movies, matrix
colour effects, mis-named files), keep a name → asset-id map from the import results, and remember
that byte-identical files are imported once (the second name points at the first asset).

## Step 4 - Characters and sprites

- Resolve sprites **the way Ren'Py does**, not by looking a name up in a table. `show eileen happy`
  keeps attributes the tag already shows unless they conflict; the image chosen is the one whose
  attributes include all requested ones, then share the most with what was showing. Implement this
  choice (`references/statement-mapping.md` → "Image attributes") in the converter and walk the
  script with a stage model, or a large share of `show` statements resolve to the wrong picture.
- Apply `config.adjust_attributes` in the resolver if the game installs one (step 1): it runs after
  the statement's attributes are collected and before the image is picked, so the pose on screen is
  not the one the script spells. Resolve the flag it reads to each of its values and port the result
  as separate poses, with an `/if` where the game switches.
- One character's sprite sets usually live on several tags (an outfit, a chibi, a later arc), named
  with no relation to each other or to the speaker variable. Collect them all under the one Studio
  character, one pose per resolved image, and log the tag → pose map.
- Flattened full-body images per expression → one preset character with a pose per image. Part
  images (base, eyes, mouth) or a PSD → a layered character (`narraleaf-make-game` chapter
  *layered sprites*).
- Set each character's entrance so that `/show <name> <pose>` lands where Ren'Py's default position
  puts the sprite. For Ren'Py's stock bottom-anchored positions that is
  `entranceTransform: "standing"`; a game whose transforms place sprites otherwise needs the offset
  computed (`references/positions-and-atl.md` → "Sprites"). Verify one with a screenshot.
- Name colours, name-box styles and per-character text styles come from the `Character(...)`
  arguments.

## Step 5 - Variables

`default x = v` → a saved variable; `persistent.x` → a persistent variable; `define` constants
inline. Booleans and numbers map directly; Python objects need a decision (log it).

## Step 6 - Story

Generate `.story` per scene from the IR and send each with `story_apply` (dry run first). Map with
`references/statement-mapping.md`. Every scene's header states `#background`: the picture the
original shows as the scene opens (`none` for black), or a reused skeleton scene flashes its demo
picture. `#description` is the author's text from the pack, or left out. After each scene: `story_show` it back and check the row count and
that nothing came back as an opaque `»` row you did not expect. Then:

- **Voice.** There is no voice command in `.story`; link takes after the text is written:
  `voice_settings_set`, then `voice_list` and `voice_link` by line id (match on scene + line order
  from your IR, not by file name guessing). **Once voice is linked or any line translated, do not
  re-apply a regenerated scene file** - lines without anchors are new lines, and the takes and
  translations of the old ones are lost to them. Edit through `story_show` → `story_apply` instead,
  which keeps anchors; so link voice and translate last, once the converter is final.
- **Menus and flags.** Port conditions on menu options and the variables they set exactly; the
  endings depend on them. An option's own `if` has no `.story` spelling: write the menu once per case
  under `/if` / `? else`, or list it under "Needs the author" (`references/statement-mapping.md`).
- **Endings.** Mark each final label's end with `/ending` and name the endings (the achievement or
  the credits title usually gives the name). An ending does not have to `return`: a label that rolls
  the credits and then jumps back to the title screen is an ending too, and any statement after that
  jump is unreachable. If you excluded a file from the port (credits, a demo, an unused route),
  check that nothing jumps or calls into it before you call it excluded.

## Step 7 - Interface: trace the running game

Working the layout out from `screens.rpy` alone is unreliable (nested boxes, style inheritance,
`gui.*` indirection). **Run the Ren'Py game and screenshot every screen**, then rebuild each one in
Studio against the picture - once the author has agreed to the run and to any SDK download (see
*Safety* above). The full method, how to write the capture script and the Ren'Py layout rules for the
parts you still compute are in `references/interface.md`. Per screen:

1. Capture it in Ren'Py at the project's resolution - unless the pack already has it:
   `pack_screen` lists the captures Ren2Leaf took, with every element's rectangle, and
   `pack_image` shows a capture's crops.
2. Write the element table (rectangles, fonts, colours, states) in your working folder.
3. Build or restyle the Studio page / game UI, using the game's own images for frames and buttons.
4. `ui_screenshot` it and compare side by side; then check it **in the running game**
   (`playtest_screenshot`), because the editor render and the game can differ.

A screen that changes with saved state (a title that looks different once the game is cleared, a
locked gallery button) has one look per state: capture each, and switch between them with a
blueprint that reads the persistent variable when the page opens.

## Step 8 - Behaviour

Wire what the Ren'Py screens do with blueprints (`narraleaf-make-game` chapter *blueprint format*):
navigation, confirm prompts, preferences, the gallery's locks, quick-menu actions. Test buttons with
`playtest_click` / `playtest_key`, not by reading the graph.

**Port the behaviour, not only the look.** Ren'Py games routinely have controls the skeleton has no
counterpart for: extra preferences (voice continuing into the next line, per-channel mutes, a reset),
save pages, a replay-voice button, a "jump back to this line" in the history, a music room with its
own player. The skeleton is not the limit (`narraleaf-make-game`, step 6, "Beyond the skeleton"): for
each one, search `blueprint_nodes` for what it needs, then build the control and wire it - a page or
component of your own, a variable for its state, a blueprint on its events. Pages of slots come from
a page variable and the slot component's params. Only what still has no way after that search goes
into the hand-over as a difference, with what you searched and tried; a control the Ren'Py game had
is never dropped silently, and none is left looking live but doing nothing.

## Step 9 - Gallery, replay, achievements, extras

- Gallery: entries from the Ren'Py gallery definition; unlock with the same condition (a persistent
  "seen" flag set where the CG first shows). The definition is usually built call by call in a
  screen file (`g = Gallery()`, then `g.button` / `g.image` / `g.unlock_image` / `g.condition`), not
  declared in one place: read the calls in order, a `button` opening each group.
- Achievements: the list comes from the `achievement.register(...)` calls in `init python` - the
  first argument is the game's own id, a `steam=` argument the Steam name. The grants are often
  routed through one parameterised label called with the id (step 1), so collect them from its
  call sites. If the project has an achievements plugin, grant at the same points with a
  `/blueprint` row whose blueprint calls the plugin's unlock node (`story-format` in the make-game
  guide, "A row that runs a blueprint"). Without such a plugin, keep a note row at each grant and
  list them under "Needs the author".

## Step 10 - Verify and hand over

`narraleaf-make-game` chapter *verify and ship*, plus:

- `lint` with `rule` filters to read past the unused-asset noise; before deleting anything lint
  calls unused, confirm with `asset_usage` that nothing uses it.
- `test` reachable-endings and route-coverage; then playtest every ending from its menu.
- Compare a handful of story moments (a line with a sprite change, a menu, a CG, a caption mode)
  Ren'Py vs Studio, screenshot against screenshot.
- Hand over: coverage numbers (scenes, lines, characters, poses, assets by type, screens, voice
  lines, gallery entries, endings), what was not ported and why, the visible differences that remain,
  "Needs the author" still open, and that the checklist, log and issues are in the Ren2Leaf Bridge
  panel.
