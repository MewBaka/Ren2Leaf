# Ren2Leaf capture script.
#
# Injected into a COPY of the game by server/capture.js; never into the original. It takes over the
# splashscreen, shows each requested screen, and writes screenshots plus an element table for each one.
# The job comes from the file named by R2L_JOB; outputs go under the job's "out" folder.
#
# Kept to syntax that Python 2.7 also parses, so the same file can run under a Ren'Py 7 SDK.

init 999 python:
    import io as _r2l_io
    import json as _r2l_json
    import os as _r2l_os
    import time as _r2l_time
    import traceback as _r2l_traceback

    _r2l_job_path = _r2l_os.environ.get("R2L_JOB")
    _r2l_job = None

    if _r2l_job_path:
        with _r2l_io.open(_r2l_job_path, "r", encoding="utf-8") as _r2l_f:
            _r2l_job = _r2l_json.load(_r2l_f)

        config.label_overrides["splashscreen"] = "_r2l_main"

        # Quick, repeatable captures: no audio, no transitions, text shown at once.
        config.has_sound = False
        config.has_music = False
        config.has_voice = False
        config.enter_transition = None
        config.exit_transition = None
        config.intra_transition = None
        config.main_game_transition = None
        config.game_main_transition = None
        config.end_game_transition = None
        config.after_load_transition = None
        config.window_show_transition = None
        config.window_hide_transition = None
        config.autosave_on_quit = False
        config.has_autosave = False
        config.developer = False
        config.rollback_enabled = False
        _preferences.text_cps = 0
        _preferences.transitions = 0
        _preferences.afm_enable = False

        # In the copy only: everything counts as seen, so galleries and replays show all entries.
        if _r2l_job.get("unlock"):
            renpy.seen_image = lambda *args, **kwargs: True
            renpy.seen_label = lambda *args, **kwargs: True
            renpy.seen_audio = lambda *args, **kwargs: True

    _R2L_KEEP = (
        "Button", "Text", "Window", "Frame", "Bar", "Viewport", "VPGrid", "Grid", "Input",
        "Image", "ImageReference", "Solid", "Movie", "Side",
    )

    # Boxed on the annotated picture: what a person points at. Containers stay in the table only.
    _R2L_BOXED = ("Button", "Text", "Bar", "Input", "Image", "ImageReference", "Movie")

    def _r2l_out(*parts):
        p = _r2l_os.path.join(_r2l_job["out"], *parts)
        d = _r2l_os.path.dirname(p)
        if not _r2l_os.path.isdir(d):
            _r2l_os.makedirs(d)
        return p

    def _r2l_write_json(path, data):
        with _r2l_io.open(path, "w", encoding="utf-8") as f:
            f.write(_r2l_json.dumps(data, ensure_ascii=False, indent=1, default=repr))

    def _r2l_progress(event):
        event["t"] = _r2l_time.time()
        line = _r2l_json.dumps(event, ensure_ascii=False, default=repr)
        with _r2l_io.open(_r2l_out("progress.jsonl"), "a", encoding="utf-8") as f:
            f.write(line + u"\n")

    def _r2l_jsonable(v):
        if v is None or isinstance(v, (bool, int, float)):
            return v
        if isinstance(v, (list, tuple)):
            return [_r2l_jsonable(i) for i in v]
        try:
            if isinstance(v, basestring):  # noqa: F821 (Python 2)
                return v
        except NameError:
            if isinstance(v, str):
                return v
        return repr(v)

    _R2L_STYLE_KEYS = (
        "font", "size", "color", "outlines", "bold", "italic", "underline", "kerning", "line_spacing",
        "text_align", "background", "foreground", "left_padding", "right_padding", "top_padding",
        "bottom_padding", "left_margin", "right_margin", "top_margin", "bottom_margin", "spacing",
        "xminimum", "xmaximum", "yminimum", "ymaximum", "left_bar", "right_bar", "thumb",
    )

    def _r2l_style(d):
        s = getattr(d, "style", None)
        if s is None:
            return None
        rv = {"name": "_".join(str(i) for i in s.parent) if getattr(s, "parent", None) else None}
        for k in _R2L_STYLE_KEYS:
            try:
                v = getattr(s, k)
            except Exception:
                continue
            if v is None or v == 0 or v == []:
                continue
            if type(v).__name__ == "Null":
                continue
            rv[k] = _r2l_jsonable(v)
        return rv

    def _r2l_matrix_point(m, x, y):
        if m is None:
            return x, y
        try:
            p = m.transform(x, y)
            return p[0], p[1]
        except Exception:
            return x, y

    def _r2l_disp_name(d):
        """
        A short name for what a displayable shows: its file, or its image name.
        """
        if d is None:
            return None
        fn = getattr(d, "filename", None)
        if fn:
            return fn
        name = getattr(d, "name", None)
        if isinstance(name, tuple):
            return " ".join(str(i) for i in name)
        if isinstance(name, str):
            return name
        target = getattr(d, "target", None) or getattr(d, "child", None)
        if target is not None and target is not d:
            return _r2l_disp_name(target)
        return None

    def _r2l_is_button(d):
        return isinstance(d, renpy.display.behavior.Button)

    def _r2l_walk(r, place, depth, out, in_frame, screen_name, owner=None):
        """
        place(x, y) maps a point in r's coordinates to screen coordinates.
        """

        x0, y0 = place(0, 0)
        x1, y1 = place(r.width, r.height)
        rect = [min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0)]

        frame_here = False
        button_here = None

        for d in (getattr(r, "render_of", None) or []):
            cls = type(d).__name__
            real_cls = cls
            # ImageButton and other Button subclasses are buttons in the table.
            if cls != "Button" and _r2l_is_button(d):
                cls = "Button"
            if cls == "ScreenDisplayable":
                screen_name = d.screen_name[0] if getattr(d, "screen_name", None) else screen_name
                continue
            if cls not in _R2L_KEEP:
                continue
            if in_frame and cls in ("Image", "ImageReference", "Solid"):
                continue
            if rect[2] < 1 or rect[3] < 1:
                continue

            e = {
                "type": cls,
                "class": real_cls if real_cls != cls else None,
                "rect": [round(v, 1) for v in rect],
                "depth": depth,
                "screen": screen_name,
                "id": getattr(d, "id", None),
                "location": list(d._location) if getattr(d, "_location", None) else None,
                "inButton": owner is not None,
                "_obj": d,
            }
            if cls == "Button":
                button_here = e
            try:
                info = d._repr_info()
            except Exception:
                info = None
            if cls == "Text":
                e["text"] = u"".join(u"%s" % (t,) for t in d.text)
                # A textbutton's source line and label live on its text; copy them to the button.
                if owner is not None and owner.get("label") is None:
                    owner["label"] = e["text"]
                    if owner.get("location") is None:
                        owner["location"] = e["location"]
            elif info is not None:
                e["info"] = _r2l_jsonable(info)
            if cls in ("Text", "Button", "Window", "Frame", "Bar", "Input"):
                e["style"] = _r2l_style(d)
            if cls == "Frame":
                frame_here = True
                e["image"] = _r2l_disp_name(getattr(d, "image", None))
                for c in ([] if e["image"] else r.children):
                    for od in (getattr(c[0], "render_of", None) or []):
                        if type(od).__name__ == "Image":
                            e["image"] = getattr(od, "filename", None)
                            break
                    if e["image"]:
                        break
            # What a button shows (a gallery thumbnail, a locked mark) tells its states apart.
            if owner is not None and owner.get("image") is None and cls in ("Image", "ImageReference", "Frame"):
                owner["image"] = e.get("image") or getattr(d, "filename", None) or e.get("info")
            if r.forward is not None:
                e["transformed"] = True
            out.append(e)

        for c in getattr(r, "children", []):
            child, cx, cy = c[0], c[1], c[2]
            if not hasattr(child, "children"):
                continue

            # A render's reverse matrix maps its children's space (offsets included) into its own.
            def child_place(x, y, cx=cx, cy=cy, rev=getattr(r, "reverse", None)):
                px, py = _r2l_matrix_point(rev, x + cx, y + cy)
                return place(px, py)

            _r2l_walk(child, child_place, depth + 1, out, in_frame or frame_here, screen_name, button_here or owner)

    def _r2l_elements():
        out = []
        st = renpy.display.interface.surftree
        _r2l_walk(st, lambda x, y: (x, y), 0, out, False, None)

        # The same displayable can be listed by an outer render that was handed the whole area and by
        # its own tight render. Keep the tightest rectangle, in the original order.
        best = {}
        for e in out:
            k = id(e["_obj"])
            area = e["rect"][2] * e["rect"][3]
            if k not in best or area < best[k][0]:
                best[k] = (area, e)
        keep = set(id(v[1]) for v in best.values())
        out = [e for e in out if id(e) in keep]

        w, h = config.screen_width, config.screen_height
        visible = []
        for e in out:
            x, y, ew, eh = e["rect"]
            if x >= w or y >= h or x + ew <= 0 or y + eh <= 0:
                continue
            # Full-screen layers and the empty scene are noise.
            if e["type"] in ("Window", "Frame") and e["location"] is None and ew >= w and eh >= h:
                continue
            visible.append(e)

        for i, e in enumerate(visible):
            e["n"] = i + 1
            boxed = e["type"] in _R2L_BOXED and not e["inButton"]
            if e["type"] in ("Image", "ImageReference", "Movie") and e["location"] is None:
                boxed = False
            ex, ey, ew2, eh2 = e["rect"]
            if ew2 >= w and eh2 >= h:
                boxed = False
            e["boxed"] = boxed
        return visible

    def _r2l_scale_rect(rect, sx, sy):
        return [round(rect[0] * sx, 1), round(rect[1] * sy, 1), round(rect[2] * sx, 1), round(rect[3] * sy, 1)]

    def _r2l_save_png(path, data):
        with open(path, "wb") as f:
            f.write(data)

    def _r2l_crop(full_png, rect, path, pad=0):
        import pygame_sdl2 as pygame
        surf = pygame.image.load(_r2l_io.BytesIO(full_png), "x.png")
        sw, sh = surf.get_size()
        x = max(0, int(rect[0]) - pad)
        y = max(0, int(rect[1]) - pad)
        x2 = min(sw, int(rect[0] + rect[2] + 0.999) + pad)
        y2 = min(sh, int(rect[1] + rect[3] + 0.999) + pad)
        if x2 <= x or y2 <= y:
            return False
        pygame.image.save(surf.subsurface((x, y, x2 - x, y2 - y)), path)
        return True

    def _r2l_size():
        return (config.screen_width, config.screen_height)

    def _r2l_element_set(elements):
        return set(u"%s|%s|%s|%s|%s" % (e["type"], ",".join(str(int(v) // 4) for v in e["rect"]),
                                        e.get("text") or "", e.get("info") or "", e.get("image") or "")
                   for e in elements)

    def _r2l_changed(a, b):
        """
        Share of elements that differ between two states. A page of thumbnails or a new tab changes
        most of them; a volume step or a toggled option changes one or two.
        """
        if not a and not b:
            return 0.0
        return float(len(a ^ b)) / float(max(len(a), len(b)) * 2)

    def _r2l_signature(elements):
        """
        What a state looks like, for telling new states from seen ones: element types, rounded
        rectangles and texts. Screenshots are not compared; a movie background never holds still.
        """
        import hashlib
        parts = []
        for e in elements:
            parts.append(u"%s|%s|%s|%s|%s" % (e["type"], ",".join(str(int(v) // 4) for v in e["rect"]),
                                              e.get("text") or "", e.get("info") or "", e.get("image") or ""))
        data = u"\n".join(parts)
        return hashlib.md5(data.encode("utf-8")).hexdigest()

    def _r2l_table(elements):
        sx = 1920.0 / config.screen_width
        sy = 1080.0 / config.screen_height
        table = []
        for e in elements:
            e = dict(e)
            e.pop("_obj", None)
            e["rect1920"] = _r2l_scale_rect(e["rect"], sx, sy)
            table.append(e)
        return table

    def _r2l_fix_button_rects(elements):
        by_obj = dict((id(e["_obj"]), e) for e in elements)
        focusables = []
        for f in renpy.display.focus.focus_list:
            e = by_obj.get(id(f.widget))
            if e is None or f.x is None:
                continue
            e["rect"] = [round(f.x, 1), round(f.y, 1), round(f.w, 1), round(f.h, 1)]
            if _r2l_is_button(f.widget):
                focusables.append((f, e))
        return focusables

    def _r2l_save_state(key, item, elements, png):
        """
        One captured state: the whole screen, plus its element table as data.
        """
        _r2l_save_png(_r2l_out("screens", key, "full.png"), png)
        if _r2l_size() != (1920, 1080):
            _r2l_save_png(_r2l_out("screens", key, "full@1920.png"), renpy.screenshot_to_bytes((1920, 1080)))
        table = _r2l_table(elements)
        _r2l_write_json(_r2l_out("screens", key, "elements.json"), {
            "key": key,
            "item": _r2l_item_json(item),
            "gameSize": list(_r2l_size()),
            "elements": table,
        })
        return {"elements": len(table), "buttons": len([e for e in table if e["type"] == "Button"])}

    def _r2l_item_json(item):
        rv = dict((k, _r2l_jsonable(v) if k == "pyargs" else v) for k, v in item.items()
                  if k != "over" and not k.startswith("_"))
        if item.get("over") is not None:
            rv["over"] = item["over"].get("key")
        return rv

    # ------------------------------------------------------------ what the player can reach
    #
    # A screen is captured when the player can reach it: from the main menu or the game, through a
    # button that is actually on screen and sensitive (or a key the screen binds), or from the story.
    # Buttons are read, not pressed, for navigation; only actions that change data in place (page
    # buttons, tabs) are run, in the copy, to reach the states a screen hides behind them.

    def _r2l_flatten(action):
        if action is None:
            return []
        if isinstance(action, (list, tuple)):
            rv = []
            for a in action:
                rv.extend(_r2l_flatten(a))
            return rv
        return [action]

    def _r2l_sensitive(widget):
        sens = getattr(widget, "sensitive", None)
        if sens is not None:
            return bool(sens)
        try:
            return bool(renpy.is_sensitive(widget.action))
        except Exception:
            return True

    _R2L_FILE_PAGE = ("FilePage", "FilePageNext", "FilePagePrevious")

    def _r2l_is_data_action(a):
        if type(a).__name__ in _R2L_FILE_PAGE:
            return True
        return hasattr(a, "value_to_set") and hasattr(a, "current_value")

    def _r2l_page_like(a, label):
        """
        Only what a button on the page does is explored: not the engine's key bindings, and not
        actions that change preferences, persistent data or configuration (FilePage aside, which is
        how save pages turn).
        """
        if label is not None and str(label).startswith("key:"):
            return False
        if type(a).__name__ in _R2L_FILE_PAGE:
            return True
        obj = getattr(a, "object", None)
        if obj is not None:
            for protected in (getattr(store, "_preferences", None), getattr(store, "persistent", None), config):
                if obj is protected:
                    return False
        return True

    def _r2l_action_id(a):
        try:
            fields = sorted((k, repr(v)) for k, v in vars(a).items())
        except TypeError:
            fields = repr(a)
        return u"%s%s" % (type(a).__name__, fields)

    def _r2l_widget_label(widget):
        def find(d, depth=0):
            if depth > 6 or d is None:
                return None
            if type(d).__name__ == "Text":
                return u"".join(u"%s" % (t,) for t in d.text)
            for c in (getattr(d, "children", None) or [getattr(d, "child", None)]):
                hit = find(c, depth + 1)
                if hit:
                    return hit
            return None
        try:
            return find(widget)
        except Exception:
            return None

    def _r2l_keymaps():
        rv = []
        def walk(r):
            for d in (getattr(r, "render_of", None) or []):
                if type(d).__name__ == "Keymap":
                    rv.append(d)
            for c in getattr(r, "children", []):
                if hasattr(c[0], "children"):
                    walk(c[0])
        walk(renpy.display.interface.surftree)
        return rv

    def _r2l_current_actions():
        """
        (action, label, screen) for every sensitive button on screen and every key a screen binds.
        """
        rv = []
        for f in renpy.display.focus.focus_list:
            w = f.widget
            if not _r2l_is_button(w) or not _r2l_sensitive(w):
                continue
            label = _r2l_widget_label(w)
            for a in _r2l_flatten(getattr(w, "action", None)):
                rv.append((a, label, getattr(f, "screen", None)))
        for km in _r2l_keymaps():
            for keyname, act in getattr(km, "keymap", {}).items():
                for a in _r2l_flatten(act):
                    rv.append((a, "key:" + keyname, None))
        return rv

    def _r2l_run_action(a, screen):
        """
        Runs an action as its button would: screen-variable actions need their screen as the
        current one, not the capture's timer screen.
        """
        sd = renpy.display.screen
        if screen is not None and hasattr(sd, "push_current_screen"):
            sd.push_current_screen(screen)
            try:
                return renpy.run(a)
            finally:
                sd.pop_current_screen()
        return renpy.run(a)

    def _r2l_nav_target(a):
        """
        (screen, args, kwargs, mode) when the action opens a screen, else None.
        """
        cls = type(a).__name__
        if cls == "ShowMenu":
            name = a.screen or getattr(store, "_game_menu_screen", None)
            mode = "menu"
        elif cls in ("Show", "ShowTransient", "ToggleScreen"):
            name = a.screen
            mode = "over"
        else:
            return None
        if not name or not renpy.has_screen(name):
            return None
        return (name, tuple(getattr(a, "args", ()) or ()), dict(getattr(a, "kwargs", {}) or {}), mode)

    class _R2LCrawl(object):
        def __init__(self):
            self.queue = []
            self.keys = set()
            self.screens = {}

        def add(self, node, parent=None, via=None):
            """
            Queues a node unless its screen (with the same arguments) is already queued.
            """
            if node.get("kind", "screen") == "screen":
                pa = node.get("pyargs")
                has_args = bool(pa and (pa[0] or pa[1]))
                ident = (node["screen"], repr(pa) if has_args else "")
                if ident in self.screens:
                    return None
                self.screens[ident] = node["key"]
            key = node["key"]
            n = 2
            while key in self.keys:
                key = "%s~%d" % (node["key"], n)
                n += 1
            node["key"] = key
            self.keys.add(key)
            node["parent"] = parent
            node["via"] = via
            self.queue.append(node)
            _r2l_progress({"type": "item-add", "key": key, "parent": parent, "via": via,
                           "screen": node.get("screen"), "branch": node.get("branch")})
            return node

        def links(self, parent_node, actions):
            if _r2l_job.get("targets"):
                return
            for a, label, _screen in actions:
                target = _r2l_nav_target(a)
                if target is None:
                    continue
                name, args, kwargs, mode = target
                if name.startswith("_") or name == parent_node.get("screen"):
                    continue
                node = {
                    "key": name,
                    "kind": "screen",
                    "screen": name,
                    "pyargs": (args, kwargs),
                    "branch": parent_node.get("branch"),
                    "mainMenu": parent_node.get("mainMenu", False),
                    "background": parent_node.get("background"),
                }
                if mode == "over":
                    node["over"] = parent_node
                    node["menuContext"] = parent_node.get("menuContext", False)
                else:
                    node["menuContext"] = True
                self.add(node, parent=parent_node["key"], via=label)

    _r2l_crawl = _R2LCrawl()

    class _R2LDriver(object):
        """
        Captures one screen inside a single interaction, driven by a repeating timer.

        Ending an interaction clears the transient layer (the say and choice screens), so every
        capture of a node (its first state, the states behind page buttons, and the optional
        detail pictures) happens while the same interaction runs. tick() returns True when done.
        """

        def __init__(self, key, item, explore=True):
            self.key = key
            self.item = item
            self.wait = item.get("wait", _r2l_job.get("wait", 0.6))
            self.step_wait = _r2l_job.get("stepWait", 0.5)
            self.hover_wait = _r2l_job.get("hoverWait", 0.25)
            self.detail = bool(_r2l_job.get("detail"))
            self.explore_on = explore
            self.phase = "settle"
            self.t = _r2l_time.time()
            self.error = None
            self.stats = None
            self.elements = []
            self.native = None
            self.hover_queue = []
            self.hovering = None
            self.layer = _r2l_job.get("overlayLayer") or "screens"
            self.actions = []
            self.sigs = {}
            self.cur = None
            self.tried = set()
            self.steps = 0
            self.restore = {}
            self.states = []

        def tick(self):
            try:
                return self.step()
            except Exception:
                self.error = _r2l_traceback.format_exc()
                try:
                    renpy.hide_screen("_r2l_boxes", layer=self.layer)
                except Exception:
                    pass
                self.undo()
                return True

        def elapsed(self):
            return _r2l_time.time() - self.t

        def next_phase(self, name):
            self.phase = name
            self.t = _r2l_time.time()

        def step(self):
            if self.phase == "settle":
                if self.elapsed() < self.wait:
                    return None
                self.capture_first()
                self.next_phase("explore" if self.explore_on else "detail")
                return None

            if self.phase == "explore":
                return self.explore()

            if self.phase == "explore-wait":
                if self.elapsed() < self.step_wait:
                    return None
                self.after_step()
                self.next_phase("explore")
                return None

            if self.phase == "detail":
                return self.detail_step()

            if self.phase == "boxes":
                if self.elapsed() < 0.15:
                    return None
                _r2l_save_png(_r2l_out("screens", self.key, "annotated.png"), renpy.screenshot_to_bytes(_r2l_size()))
                renpy.hide_screen("_r2l_boxes", layer=self.layer)
                self.finish()
                return True

        # -- first state

        def capture_first(self):
            self.native = renpy.screenshot_to_bytes(_r2l_size())
            self.elements = _r2l_elements()
            focusables = _r2l_fix_button_rects(self.elements)
            self.actions = _r2l_current_actions()
            self.actions_first = list(self.actions)
            self.cur = _r2l_signature(self.elements)
            self.sigs[self.cur] = self.key
            self.sets = {self.cur: _r2l_element_set(self.elements)}
            if self.detail:
                for e in self.elements:
                    if e["boxed"] and _r2l_crop(self.native, e["rect"], _r2l_out("screens", self.key, "elements", "%d.png" % e["n"])):
                        e["crop"] = "elements/%d.png" % e["n"]
                self.hover_queue = focusables[: _r2l_job.get("maxHover", 60)]

        # -- states behind data actions (pages, tabs)

        def remember(self, a):
            """
            Records the value a data action is about to change, so the store is put back afterwards.
            """
            cls = type(a).__name__
            if cls in _R2L_FILE_PAGE:
                k = ("persistent", "_file_page")
                if k not in self.restore:
                    self.restore[k] = (persistent, "_file_page", persistent._file_page)
                return
            obj = getattr(a, "object", None)
            field = getattr(a, "field", None)
            if obj is not None and field:
                parts = field.split(".")
                target = obj
                for p in parts[:-1]:
                    target = getattr(target, p)
                k = (id(target), parts[-1])
                if k not in self.restore:
                    self.restore[k] = (target, parts[-1], getattr(target, parts[-1], None))
                return
            d = getattr(a, "dict", None)
            if d is not None and hasattr(a, "key"):
                k = (id(d), repr(a.key))
                if k not in self.restore:
                    try:
                        self.restore[k] = (d, a.key, d[a.key], "dict")
                    except Exception:
                        pass

        def undo(self):
            for v in self.restore.values():
                try:
                    if len(v) == 4:
                        v[0][v[1]] = v[2]
                    else:
                        setattr(v[0], v[1], v[2])
                except Exception:
                    pass
            self.restore = {}

        def data_actions(self, actions):
            rv = []
            seen = set()
            for a, label, screen in actions:
                if not _r2l_is_data_action(a) or not _r2l_page_like(a, label):
                    continue
                aid = _r2l_action_id(a)
                if aid in seen:
                    continue
                seen.add(aid)
                rv.append((aid, a, screen))
            return rv

        def explore(self):
            """
            Walks the states a screen's data actions lead to (pages, tabs) as a graph: tries each
            action from each state once, and when the current state has nothing left to try, goes back
            along known edges to a state that has.
            """
            if not hasattr(self, "edges"):
                self.edges = {}
                self.state_actions = {self.cur: self.data_actions(self.actions)}
            limit = _r2l_job.get("maxStates", 12)
            if self.steps < _r2l_job.get("maxSteps", 40) and len(self.sigs) < limit:
                todo = [x for x in self.state_actions.get(self.cur, []) if (self.cur, x[0]) not in self.tried]
                if todo:
                    aid, a, screen = todo[0]
                    return self.apply(aid, a, screen)
                step = self.route_to_untried()
                if step is not None:
                    aid, a, screen = step
                    return self.apply(aid, a, screen, probe=False)
            self.undo()
            renpy.restart_interaction()
            self.next_phase("detail")
            return None

        def route_to_untried(self):
            """
            The first action on the shortest known path from the current state to a state that still
            has untried actions, or None.
            """
            from collections import deque
            queue = deque([(self.cur, None)])
            visited = set([self.cur])
            while queue:
                sig, first = queue.popleft()
                if sig != self.cur and any((sig, x[0]) not in self.tried for x in self.state_actions.get(sig, [])):
                    return first
                for (src, aid), dst in self.edges.items():
                    if src != sig or dst in visited:
                        continue
                    visited.add(dst)
                    act = next((x for x in self.state_actions.get(src, []) if x[0] == aid), None)
                    if act is None:
                        continue
                    queue.append((dst, first or act))
            return None

        def apply(self, aid, a, screen, probe=True):
            # Prefer the action object rendered now: it belongs to the screen as it is.
            for x in self.data_actions(self.actions):
                if x[0] == aid:
                    a, screen = x[1], x[2]
                    break
            if probe:
                self.tried.add((self.cur, aid))
            self.pending = (self.cur, aid)
            self.steps += 1
            self.remember(a)
            _r2l_run_action(a, screen)
            renpy.restart_interaction()
            self.next_phase("explore-wait")
            return None

        def after_step(self):
            elements = _r2l_elements()
            _r2l_fix_button_rects(elements)
            sig = _r2l_signature(elements)
            self.actions = _r2l_current_actions()
            elset = _r2l_element_set(elements)
            if sig not in self.sigs:
                # Close to a state already captured: the same page with a value changed.
                threshold = _r2l_job.get("newStateShare", 0.2)
                near = [k for k, v in self.sets.items() if _r2l_changed(v, elset) < threshold]
                if near:
                    sig = near[0]
            if sig not in self.sigs:
                key = "%s--%d" % (self.key, len(self.sigs) + 1)
                self.sigs[sig] = key
                self.sets[sig] = elset
                item = dict(self.item, key=key, state=len(self.sigs))
                _r2l_progress({"type": "item-add", "key": key, "parent": self.key, "via": "state",
                               "screen": self.item.get("screen"), "branch": self.item.get("branch")})
                stats = _r2l_save_state(key, item, elements, renpy.screenshot_to_bytes(_r2l_size()))
                _r2l_progress({"type": "item-done", "key": key, "status": "ok", "stats": stats})
                self.states.append(key)
                if self.item.get("_node") is not None:
                    _r2l_crawl.links(self.item["_node"], self.actions)
            if sig not in self.state_actions:
                self.state_actions[sig] = self.data_actions(self.actions)
            if getattr(self, "pending", None):
                self.edges[self.pending] = sig
                self.pending = None
            self.cur = sig

        # -- optional detail pictures

        def detail_step(self):
            if not self.detail:
                self.finish()
                return True
            if self.hovering is not None:
                if self.elapsed() < self.hover_wait:
                    return None
                f, e = self.hovering
                shot = renpy.screenshot_to_bytes(_r2l_size())
                if _r2l_crop(shot, e["rect"], _r2l_out("screens", self.key, "hover", "%d.png" % e["n"]), pad=4):
                    e["hover"] = "hover/%d.png" % e["n"]
                self.hovering = None
            if self.hover_queue:
                f, e = self.hover_queue.pop(0)
                renpy.display.focus.change_focus(f)
                renpy.restart_interaction()
                self.hovering = (f, e)
                self.t = _r2l_time.time()
                return None
            renpy.display.focus.clear_focus()
            boxes = [(e["n"], e["rect"]) for e in self.elements if e["boxed"]]
            renpy.show_screen("_r2l_boxes", boxes=boxes, _layer=self.layer)
            renpy.restart_interaction()
            self.next_phase("boxes")
            return None

        def finish(self):
            self.stats = _r2l_save_state(self.key, self.item, self.elements, self.native)
            if self.states:
                self.stats["states"] = len(self.states) + 1
            if self.detail:
                self.stats["crops"] = len([e for e in self.elements if e.get("crop")])
                self.stats["hovers"] = len([e for e in self.elements if e.get("hover")])
            # The element table was written by _r2l_save_state; rewrite it with crop and hover paths.
            if self.detail:
                _r2l_write_json(_r2l_out("screens", self.key, "elements.json"), {
                    "key": self.key, "item": _r2l_item_json(self.item), "gameSize": list(_r2l_size()),
                    "elements": _r2l_table(self.elements),
                })

    def _r2l_clear(keep_scene=False):
        if not keep_scene:
            for layer in config.layers + config.top_layers:
                try:
                    renpy.scene(layer=layer)
                except Exception:
                    pass
        for name in list(_r2l_shown) + ["say", "choice", "nvl", "notify", "quick_menu"]:
            try:
                renpy.hide_screen(name)
            except Exception:
                pass
        del _r2l_shown[:]
        store.main_menu = False

    _r2l_shown = []

    def _r2l_show_screen(name, item):
        args, kwargs = (), {}
        if item.get("pyargs") is not None:
            args, kwargs = item["pyargs"]
        kwargs = dict(kwargs)
        kwargs.update(_r2l_eval_args(item.get("args")))
        renpy.show_screen(name, *args, **kwargs)
        _r2l_shown.append(name)

    def _r2l_show_item(item):
        kind = item.get("kind", "screen")
        for k, v in (item.get("store") or {}).items():
            setattr(store, k, v)

        if item.get("mainMenu"):
            store.main_menu = True

        # Screens opened with ShowMenu run in the menu context, where overlays (the quick menu) are off.
        if item.get("branch") == "game":
            store.suppress_overlay = bool(item.get("menuContext"))

        bg = item.get("background")
        if bg == "auto":
            bg = _r2l_job.get("stageBackground")
        if bg:
            renpy.scene()
            if renpy.has_image(bg):
                renpy.show(bg)
            else:
                renpy.show("_r2l_stage")

        if item.get("quickMenu") and renpy.has_screen("quick_menu"):
            store.quick_menu = True
            renpy.show_screen("quick_menu")

        if kind == "say":
            who = item.get("character")
            ch = getattr(store, who, None) if who else None
            if who and ch is None:
                raise Exception("character %r not found" % who)
            if ch is None:
                ch = store.narrator
            renpy.say(ch, item.get("text") or u"……", interact=False)
            return

        if kind == "choice":
            captions = item.get("captions") or [u"选项一", u"选项二"]
            renpy.display_menu([(c, i) for i, c in enumerate(captions)], interact=False)
            return

        # A screen opened with Show() sits over the screen that opened it.
        chain = []
        over = item.get("over")
        while over is not None:
            chain.insert(0, over)
            over = over.get("over")
        for base in chain:
            if base.get("kind", "screen") == "screen":
                _r2l_show_screen(base["screen"], base)
        _r2l_show_screen(item["screen"], item)

    def _r2l_missing_params(name, args):
        try:
            scr = renpy.display.screen.get_screen_variant(name)
        except Exception:
            scr = None
        if scr is None:
            return None
        params = getattr(scr, "parameters", None)
        if params is None:
            return []
        missing = []
        for p in params.parameters.values():
            if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                continue
            if p.default is p.empty and p.name not in args:
                missing.append(p.name)
        return missing

    def _r2l_eval_args(args):
        """
        Fixture values are JSON; {"$eval": "expr"} is evaluated in the game's store, which is how a
        fixture passes an action or another Python object.
        """
        rv = {}
        for k, v in (args or {}).items():
            if isinstance(v, dict) and "$eval" in v:
                v = renpy.python.py_eval(v["$eval"])
            rv[k] = v
        return rv

    _R2L_STANDARD_ARGS = {
        "confirm": {"message": {"$eval": "layout.QUIT"}, "yes_action": {"$eval": "NullAction()"}, "no_action": {"$eval": "NullAction()"}},
        "notify": {"message": {"$eval": "_('Quick save complete.')"}},
        "input": {"prompt": {"$eval": "_('What is your name?')"}},
    }

    # Screens the engine shows by itself while the game runs.
    _R2L_ENGINE = ("confirm", "notify", "skip_indicator")

    def _r2l_menus(limit=40):
        rv = []
        for node in renpy.game.script.namemap.values():
            if type(node).__name__ != "Menu":
                continue
            caps = [i[0] for i in node.items if i[0] and i[2] is not None]
            if caps:
                rv.append(caps)
            if len(rv) >= limit:
                break
        return rv

    def _r2l_script_uses_input():
        for node in renpy.game.script.namemap.values():
            code = getattr(getattr(node, "code", None), "source", None)
            if code and "renpy.input" in code:
                return True
        return False

    def _r2l_screen_node(name, branch, fixtures, **extra):
        f = fixtures.get(name) or {}
        node = {"key": name, "kind": "screen", "screen": name, "branch": branch,
                "args": f.get("args") or _R2L_STANDARD_ARGS.get(name, {}), "store": f.get("store")}
        node.update(extra)
        return node

    def _r2l_roots(disc):
        """
        Where the player starts: the main menu, then the game itself (dialogue with the quick menu,
        the menu Esc opens, choices, and the screens the story shows).
        """
        fixtures = _r2l_job.get("fixtures") or {}
        names = set(s["name"] for s in disc["screens"])
        menu_roots, game_roots = [], []

        if "main_menu" in names:
            menu_roots.append({"key": "main_menu", "kind": "screen", "screen": "main_menu", "branch": "menu",
                               "mainMenu": True, "wait": 2.0})

        chars = sorted(disc["characters"].items(), key=lambda kv: -kv[1]["lines"])
        adv = [kv for kv in chars if kv[1]["lines"] > 0 and kv[1]["kind"] == "adv"][: _r2l_job.get("maxSpeakers", 12)]
        if not adv:
            adv = [("narrator", {"sample": None})]
        for i, (var, c) in enumerate(adv):
            game_roots.append({"key": "say--" + var, "kind": "say", "character": var, "text": c.get("sample"),
                               "background": "auto", "branch": "game", "quickMenu": True})
        for var, c in [kv for kv in chars if kv[1]["lines"] > 0 and kv[1]["kind"] == "nvl"][:3]:
            game_roots.append({"key": "nvl--" + var, "kind": "say", "character": var, "text": c.get("sample"),
                               "background": "auto", "branch": "game"})

        # Esc opens it in the game; the scan read it from `default _game_menu_screen` when the
        # splash context has not set it yet.
        gm = getattr(store, "_game_menu_screen", None) or _r2l_job.get("gameMenuScreen")
        if gm not in names:
            gm = _r2l_job.get("gameMenuScreen")
        if gm and gm in names:
            game_roots.append(_r2l_screen_node(gm, "game", fixtures, via="Esc", menuContext=True))

        if "choice" in names:
            menus = _r2l_menus()
            for n in (2, 3, 4):
                caps = next((m for m in menus if len(m) >= n), None)
                if caps is not None:
                    game_roots.append({"key": "choice--%d" % n, "kind": "choice", "captions": caps[:n],
                                       "background": "auto", "branch": "game"})

        for name in _R2L_ENGINE:
            if name in names:
                game_roots.append(_r2l_screen_node(name, "game", fixtures, background="auto"))
        if "input" in names and _r2l_script_uses_input():
            game_roots.append(_r2l_screen_node("input", "game", fixtures, background="auto"))

        # Screens the story shows or calls (from the static scan), and anything asked for by name.
        for name in (_r2l_job.get("scriptScreens") or []) + (_r2l_job.get("extraScreens") or []):
            if name in names:
                game_roots.append(_r2l_screen_node(name, "game", fixtures, background="auto"))

        return menu_roots, game_roots

    def _r2l_targets(menu_roots, game_roots):
        """
        A partial run captures only the nodes asked for, without following links. Targets carry the
        branch they were found on, so a menu screen is still shown over the title background.
        """
        targets = _r2l_job.get("targets")
        if not targets:
            return menu_roots, game_roots
        fixtures = _r2l_job.get("fixtures") or {}
        known = dict((n["key"], n) for n in menu_roots + game_roots)
        menu, game = [], []
        for t in targets:
            node = known.get(t["key"])
            if node is None:
                if not t.get("screen"):
                    continue
                branch = t.get("branch") or "game"
                node = _r2l_screen_node(t["screen"], branch, fixtures,
                                        mainMenu=branch == "menu",
                                        background=None if branch == "menu" else "auto")
                node["key"] = t["key"]
            (menu if node.get("branch") == "menu" else game).append(node)
        return menu, game

    def _r2l_run_node(node, keep_scene=False):
        key = node["key"]
        started = _r2l_time.time()
        _r2l_progress({"type": "item-start", "key": key})

        if node.get("kind", "screen") == "screen":
            given = dict(_r2l_eval_args(node.get("args")))
            if node.get("pyargs") is not None:
                given.update(node["pyargs"][1])
                missing = []
            else:
                missing = _r2l_missing_params(node["screen"], given)
            if missing is None:
                _r2l_progress({"type": "item-done", "key": key, "status": "missing", "message": "screen not defined"})
                return
            if missing:
                _r2l_progress({"type": "item-done", "key": key, "status": "needs_args", "missing": missing})
                return

        try:
            _r2l_clear(keep_scene=keep_scene)
            _r2l_show_item(node)
            node["_node"] = node
            drv = _R2LDriver(key, node, explore=node.get("kind", "screen") == "screen")
            renpy.call_screen("_r2l_driver", drv=drv)
            if drv.error:
                raise Exception(drv.error)
            _r2l_crawl.links(node, drv.actions_first)
            _r2l_progress({"type": "item-done", "key": key, "status": "ok", "stats": drv.stats,
                           "seconds": round(_r2l_time.time() - started, 2)})
        except Exception:
            tb = _r2l_traceback.format_exc()
            with _r2l_io.open(_r2l_out("errors", key + ".txt"), "w", encoding="utf-8") as f:
                f.write(tb if not isinstance(tb, bytes) else tb.decode("utf-8", "replace"))
            _r2l_progress({"type": "item-done", "key": key, "status": "error", "message": tb.strip().splitlines()[-1]})
        finally:
            node.pop("_node", None)
            try:
                _r2l_clear(keep_scene=keep_scene)
            except Exception:
                pass

    def _r2l_run_branch(branch, keep_scene=False):
        """
        Runs queued nodes of one branch until none is left; nodes found on the way are queued too.
        """
        limit = _r2l_job.get("maxNodes", 120)
        done = 0
        while done < limit:
            node = next((n for n in _r2l_crawl.queue if n.get("branch") == branch and not n.get("_done")), None)
            if node is None:
                break
            node["_done"] = True
            done += 1
            _r2l_run_node(node, keep_scene=keep_scene)

    # ------------------------------------------------------------ captures from save files
    #
    # renpy.load() never returns: the saved game takes over. The queue therefore lives on the sys
    # module (loading a save does not restart Python), and an overlay screen captures the first
    # frames after each load, then loads the next save.

    import sys as _r2l_sys

    def _r2l_saves_state():
        st = getattr(_r2l_sys, "_r2l_saves", None)
        if st is None:
            st = {"queue": [], "current": None, "driver": None, "started": 0}
            _r2l_sys._r2l_saves = st
        return st

    def _r2l_save_verified(slot):
        """
        Ren'Py asks before loading a save signed on another device. The capture never answers that
        prompt; it checks first with the same function and skips saves that would ask.
        """
        st = getattr(renpy, "savetoken", None)
        if st is None or not getattr(st, "token_dir", None) or not getattr(st, "signing_keys", None):
            return True
        log_data, signature = renpy.loadsave.location.load(slot)
        return bool(st.verify_data(log_data, signature))

    def _r2l_next_save():
        st = _r2l_saves_state()
        while st["queue"]:
            item = st["queue"].pop(0)
            st["current"] = item
            st["driver"] = None
            st["started"] = _r2l_time.time()
            _r2l_progress({"type": "item-start", "key": item["key"]})
            try:
                if not renpy.can_load(item["slot"]):
                    _r2l_progress({"type": "item-done", "key": item["key"], "status": "error", "message": "save not found"})
                    continue
                if not _r2l_save_verified(item["slot"]):
                    _r2l_progress({"type": "item-done", "key": item["key"], "status": "unverified"})
                    continue
                renpy.load(item["slot"])
                # Not reached when the load works.
                _r2l_progress({"type": "item-done", "key": item["key"], "status": "error", "message": "load refused"})
            except Exception as e:
                # Loading works by raising: let Ren'Py's control-flow exceptions through.
                control = tuple(getattr(renpy.game, "CONTROL_EXCEPTIONS", ()))
                if isinstance(e, control) or type(e).__name__ == "UnfreezeException":
                    raise
                tb = _r2l_traceback.format_exc()
                with _r2l_io.open(_r2l_out("errors", item["key"] + ".txt"), "w", encoding="utf-8") as f:
                    f.write(tb if not isinstance(tb, bytes) else tb.decode("utf-8", "replace"))
                _r2l_progress({"type": "item-done", "key": item["key"], "status": "error", "message": tb.strip().splitlines()[-1]})
        st["current"] = None
        _r2l_progress({"type": "done"})
        renpy.quit()

    def _r2l_probe_tick():
        st = _r2l_saves_state()
        item = st["current"]
        if item is None:
            return None
        if st["driver"] is None:
            # A loaded game is the player's state: read it, never press anything in it.
            st["driver"] = _R2LDriver(item["key"], item, explore=False)
        drv = st["driver"]
        done = drv.tick()
        if done:
            if drv.error:
                with _r2l_io.open(_r2l_out("errors", item["key"] + ".txt"), "w", encoding="utf-8") as f:
                    f.write(drv.error if not isinstance(drv.error, bytes) else drv.error.decode("utf-8", "replace"))
                _r2l_progress({"type": "item-done", "key": item["key"], "status": "error",
                               "message": drv.error.strip().splitlines()[-1]})
            else:
                _r2l_progress({"type": "item-done", "key": item["key"], "status": "ok", "stats": drv.stats,
                               "seconds": round(_r2l_time.time() - st["started"], 2)})
            st["current"] = None
            _r2l_next_save()
        # Never end the game's own interaction.
        return None

    def _r2l_keep_probe():
        # Overlay screens can be suppressed in the loaded context, so show the probe directly.
        st = getattr(_r2l_sys, "_r2l_saves", None)
        if st and st.get("current") and not renpy.get_screen("_r2l_probe"):
            renpy.show_screen("_r2l_probe")
            renpy.restart_interaction()

    if _r2l_job is not None and _r2l_job.get("saves"):
        config.periodic_callbacks.append(_r2l_keep_probe)

    def _r2l_discover():
        """
        What the running game defines, for the orchestrator: screens with their parameters, characters,
        and one real line per character.
        """

        screens = []
        for (name, variant), scr in renpy.display.screen.screens.items():
            loc = getattr(scr, "location", None)
            if not loc or not str(loc[0]).replace("\\", "/").startswith("game/"):
                continue
            params = []
            sig = getattr(scr, "parameters", None)
            if sig is not None:
                for p in sig.parameters.values():
                    params.append({"name": p.name, "required": p.default is p.empty,
                                   "default": None if p.default is p.empty else _r2l_jsonable(p.default)})
            screens.append({"name": name, "variant": variant, "location": list(loc), "parameters": params})

        chars = {}
        for k, v in list(store.__dict__.items()):
            if k.startswith("_"):
                continue
            if isinstance(v, renpy.character.ADVCharacter):
                chars[k] = {"name": _r2l_jsonable(getattr(v, "name", None)),
                            "kind": "nvl" if isinstance(v, getattr(renpy.character, "NVLCharacter", ())) or getattr(v, "mode", None) == "nvl" else "adv",
                            "lines": 0, "sample": None}

        for node in renpy.game.script.namemap.values():
            if type(node).__name__ not in ("Say", "TranslateSay"):
                continue
            if getattr(node, "language", None) is not None:
                continue
            who = node.who or "narrator"
            c = chars.get(who)
            if c is None:
                continue
            c["lines"] += 1
            if c["sample"] is None or (len(c["sample"]) < 24 and len(node.what) > len(c["sample"])):
                c["sample"] = node.what

        scenes = {}
        for node in renpy.game.script.namemap.values():
            if type(node).__name__ == "Scene" and getattr(node, "imspec", None):
                name = " ".join(node.imspec[0])
                scenes[name] = scenes.get(name, 0) + 1
        def scene_rank(kv):
            name, count = kv
            usable = renpy.has_image(name) and name not in ("black", "white") and not name.startswith('"')
            return (0 if usable else 1, 0 if name.startswith("bg") else 1, -count)
        top_scenes = sorted(scenes.items(), key=scene_rank)[:10]

        # The splashscreen is replaced by the capture, so whatever else it does is skipped. Report its
        # Python statements; a game may rely on them (decrypting files, setting flags).
        skipped = []
        try:
            # namemap, not lookup(): lookup follows label_overrides to the capture's own label.
            node = renpy.game.script.namemap.get("splashscreen")
            seen = 0
            while node is not None and seen < 200:
                seen += 1
                if type(node).__name__ in ("Python", "EarlyPython") and getattr(node, "code", None) is not None:
                    skipped.append({"location": [node.filename, node.linenumber], "code": node.code.source})
                if type(node).__name__ == "Return":
                    break
                node = node.next
        except Exception:
            pass

        return {"screens": screens, "characters": chars, "scenes": top_scenes, "splashSkipped": skipped,
                "saveDirectory": config.save_directory,
                "gameSize": list(_r2l_size()),
                "renpyVersion": renpy.version_only if hasattr(renpy, "version_only") else renpy.version()}

image _r2l_stage = Solid("#6b7480")

screen _r2l_probe():
    zorder 200000
    if getattr(_r2l_sys, "_r2l_saves", None) and _r2l_sys._r2l_saves.get("current"):
        timer 0.05 repeat True action Function(_r2l_probe_tick)

screen _r2l_driver(drv):
    zorder 200000
    timer 0.05 repeat True action Function(drv.tick)

screen _r2l_boxes(boxes):
    zorder 100000
    for n, r in boxes:
        add Solid("#40a8c4", xysize=(max(1, int(r[2])), 2)) pos (int(r[0]), int(r[1]))
        add Solid("#40a8c4", xysize=(max(1, int(r[2])), 2)) pos (int(r[0]), int(r[1] + r[3]) - 2)
        add Solid("#40a8c4", xysize=(2, max(1, int(r[3])))) pos (int(r[0]), int(r[1]))
        add Solid("#40a8c4", xysize=(2, max(1, int(r[3])))) pos (int(r[0] + r[2]) - 2, int(r[1]))
        frame:
            pos (int(r[0]), int(r[1]) - 15 if r[1] >= 15 else int(r[1]))
            padding (3, 0, 3, 0)
            background Solid("#0f1115d0")
            text "[n]" font "DejaVuSans.ttf" size 12 color "#eef1f5"

label _r2l_main:
    python:
        # What the start of a game does before its first line: `default` statements set their values.
        try:
            renpy.execute_default_statement(True)
        except Exception:
            pass
        _r2l_disc = _r2l_discover()
        if not _r2l_job.get("stageBackground") and _r2l_disc["scenes"]:
            _r2l_job["stageBackground"] = _r2l_disc["scenes"][0][0]
        _r2l_progress({"type": "start", "discover": _r2l_disc, "items": []})
        if _r2l_job.get("discoverOnly"):
            renpy.quit()
        if _r2l_job.get("saves"):
            _r2l_items = [dict(s, wait=s.get("wait", 1.5)) for s in _r2l_job["saves"]]
            for _r2l_item in _r2l_items:
                _r2l_progress({"type": "item-add", "key": _r2l_item["key"], "via": "save"})
            _r2l_saves_state()["queue"] = list(_r2l_items)
            _r2l_next_save()
        _r2l_menu_roots, _r2l_game_roots = _r2l_roots(_r2l_disc)
        _r2l_menu_roots, _r2l_game_roots = _r2l_targets(_r2l_menu_roots, _r2l_game_roots)
        for _r2l_n in _r2l_menu_roots:
            _r2l_crawl.add(_r2l_n)

    # Main menu branch: before_main_menu draws the title background (often a movie), and the menu
    # screens opened from the title are shown over it, as the player sees them.
    if _r2l_menu_roots:
        $ _r2l_clear()
        $ store.main_menu = True
        if renpy.has_label("before_main_menu"):
            call before_main_menu
        $ _r2l_run_branch("menu", keep_scene=True)

    python:
        _r2l_clear()
        # In the game, overlay screens (the quick menu) are shown; the splash context hides them.
        store.suppress_overlay = False
        for _r2l_n in _r2l_game_roots:
            _r2l_crawl.add(_r2l_n, via=_r2l_n.get("via"))
        _r2l_run_branch("game")
        _r2l_progress({"type": "done", "reached": sorted(set(n.get("screen") for n in _r2l_crawl.queue if n.get("screen")))})
        renpy.quit()
    return
