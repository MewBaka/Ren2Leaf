# Capture spike notes

Ren'Py 8.5.2 SDK, sample `the_question` (1280x720), macOS. Spike date 2026-10-16.

## What works

- **Render tree.** `renpy.display.interface.surftree` is the root `Render` of the last drawn frame.
  Each `Render` has `width`, `height`, `render_of` (the displayables it was rendered for) and
  `children` as tuples `(child, x, y, focus, main)`. Accumulating `x`/`y` while walking gives screen
  rectangles in virtual (game) pixels. Children that are not `Render`s (surfaces) have no `children`.
- **Source location.** Screen-language displayables carry `_location = (file, line)`, e.g.
  `game/screens.rpy:299` for a navigation `textbutton`'s text. Displayables built inside the engine
  (button frames, tiles) have `None`.
- **Identity.** `d._repr_info()` (what the developer inspector prints) gives the image file for
  `Image` (`'gui/main_menu.png'`) and the text for `Text`; `d.id` is the screen `id`.
- **Resolved style.** `d.style.parent` is the style name tuple (`navigation_button_text`);
  `d.style.font / size / color / outlines / background / *_padding / xminimum…` return resolved
  values for the current state. Position properties such as `xalign` are not attributes of the style
  object; read the rectangle from the render tree instead.
- **Frames.** A `Frame` renders as nine `Image` tiles; the tiles' file is the state's background
  (`gui/button/idle_background.png`) and the button style's `background` repr gives the borders
  (`(4,4,4,4)`) and the `[prefix_]` pattern for the other states. Collapse the tiles into the frame.
- **Focus list.** `renpy.display.focus.focus_list` lists focusable widgets with `x, y, w, h`.
- **Forced hover.** `renpy.display.focus.change_focus(f)` + `renpy.restart_interaction()` + a short
  pause redraws the button in its hover state (verified visually).
- **Screenshot size.** `renpy.screenshot_to_bytes(None)` returns the drawable size (2560x1440 on a
  Retina screen), not the game size. Always pass `(config.screen_width, config.screen_height)` for
  the native capture and `(1920, 1080)` for the comparison capture.
- **Saves.** `RENPY_PATH_TO_SAVES=<dir>` in the environment keeps saves and persistent data out of
  the player's `~/Library/RenPy`.
- **Sandbox.** `sandbox-exec` with `(allow default)`, `(deny network-outbound (remote ip))`,
  `(deny file-write*)` and writes allowed only under the work dir, `/private/var/folders` and `/dev`
  runs the game and captures normally. On by default.

## What does not

- **No headless run.** `SDL_VIDEODRIVER=offscreen` fails Ren'Py's GL test (`00gltest.rpy`) and the
  draw object is `None`. A window has to open while capturing.
- **Main menu context.** Showing `main_menu` from the splashscreen label leaves `main_menu` False, so
  `navigation` shows the in-game items (History, Save). Set `store.main_menu = True` (and
  `_game_menu_screen` as appropriate) before showing menu screens.

## Reachability crawl (2026-10-16, second round)

Capturing every screen `game/` defines also captured template leftovers no player can open (a
`help` that only the unused `navigation` links to). The capture now starts where the player starts
and follows what is really on screen:

- **Roots.** The main menu (after `before_main_menu`), then the game: a dialogue line per speaker
  with the quick menu, the screen Esc opens (`_game_menu_screen`, which a `default` statement sets,
  so the capture runs `renpy.execute_default_statement(True)` first; the scan's value is the
  fallback), choices, engine screens (confirm, notify, skip indicator, input when the script calls
  `renpy.input`), and screens the story shows from a label (from the diagnose inventory).
- **Links are read, not pressed.** For every sensitive button in `focus_list` and every key a
  `Keymap` binds, `ShowMenu(x)` / `Show(x)` / `ToggleScreen(x)` make `x` reachable. Conditions in
  screens are already evaluated, so a button behind `if renpy.variant(...)` or `if main_menu` only
  counts when it is there.
- **Page states are pressed, in the copy.** Data actions (anything with `value_to_set` and
  `current_value`: `SetVariable`, `IncrementVariable`, `SetScreenVariable`…, plus `FilePage*`) on
  buttons are run and the result is a new state when at least 20% of the elements changed. The
  states form a graph; the walk goes back along known edges to states with untried actions, so
  "next, next" is found even when "previous" is tried first. Values changed are put back afterwards.
- **Not pressed:** engine key bindings (`Preference("self voicing")` is a data action too), anything
  on `_preferences`, `persistent` or `config`, and every non-data action (Start, Jump, file save or
  load, Function, OpenURL, gallery image viewers).
- **Unlock.** `renpy.seen_image/seen_label/seen_audio` return True in the copy when the job asks,
  so galleries show every entry.

Pitfalls met on the way:
- `ImageButton` is a subclass of `Button`; match with `isinstance`, not the class name.
- A `Frame` around an image name renders as tile subsurfaces with no displayable on them; read
  `frame.image` for what it shows.
- The splash context suppresses overlays (`suppress_overlay`), which hides the quick menu; the game
  branch sets it False, and screens opened with `ShowMenu` set it back, as the menu context does.
- Screen-variable actions use `renpy.current_screen()`; run them inside
  `push_current_screen(focus.screen)` or they look up the capture's own timer screen.
- A Ren'Py process under `sandbox-exec` does not stop on SIGTERM; cancel uses SIGKILL.

## Manual capture (F9)

The main way to capture: the migrator plays a clone of the game and presses F9 on every screen
worth porting, then types what it is for. The automatic crawl stays as the check that nothing was
missed (the manual page lists screens the crawl reached that no shot shows).

- Same safety as the crawl: trust first, a clone, `sandbox-exec`, saves in the work directory, the
  original folder fingerprinted before and after. The player's own saves (and persistent) are
  copied into `<work>/manual-saves` so they can continue from their progress; only public keys of
  the save tokens are written (see `stageSaves`).
- Nothing is taken over: no splashscreen override, sound and transitions as normal. The capture
  script only adds a `Keymap(K_F9=...)` to `config.underlay`, which every context draws, so F9 works
  in the game, its menus and the title screen.
- On F9 the frame on screen is saved and the element table read first; the annotation box opens
  after, through `renpy.invoke_in_new_context`, so it never appears in the shot.
- The box uses the SDK's `sdk-fonts/SourceHanSansLite.ttf`, copied into the clone as
  `_r2l_font.ttf`; a game that ships only Latin fonts still shows Chinese there.
- Each shot: `<work>/manual/<key>/{full.png, elements.json, meta.json}`. `meta.json` keeps the
  purpose as typed, the statement being run, the last line said and the screens shown. The WebUI can
  edit the purpose; the report quotes it as is.
- `R2L_SELFTEST=<seconds>` in the environment presses F9 once after that many seconds, fills the
  box with a fixed purpose and quits. It is how manual mode is tested without a person.
- `pygame_sdl2.image.save` takes a file name only; the rounded backgrounds of the F9 dialogs are
  written to `<out>/_ui/` and read back.
- **Crops instead of a picker (2026-10-18).** The F9 dialog offers "全图" (the whole screen) or "切图":
  every element smaller than the screen is cut automatically, listed largest first, and the player
  ticks the ones to keep. Each becomes `crop-<n>.png` (n: the element's number); the whole screen is
  always saved too. The WebUI can redo the choice later: it crops on a canvas from `full.png` and
  sends PNG bytes (`server/crops.js` checks the signature). Automatic captures can be cropped the
  same way; their crops live with the screen and go when that screen is captured again.
- A game playing `play movie` draws the movie over every screen (fullscreen video mode). The F9
  dialogs add an invisible `Movie(channel="movie")`, which turns that mode off while they are open.
