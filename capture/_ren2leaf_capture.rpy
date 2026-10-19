# Ren2Leaf capture script.
#
# Injected into a COPY of the game by server/capture.js; never into the original. The job comes from
# the file named by R2L_JOB; outputs go under the job's "out" folder.
#
# The player plays the game as usual and presses F9 on each screen worth porting; nothing is taken
# over, muted or sped up. The job always carries "manual": true — the automatic capture that used to
# drive the game by itself was removed.
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

    _r2l_manual = bool(_r2l_job and _r2l_job.get("manual"))

    if _r2l_job is not None and _r2l_manual:
        if _r2l_job.get("unlock"):
            renpy.seen_image = lambda *args, **kwargs: True
            renpy.seen_label = lambda *args, **kwargs: True
            renpy.seen_audio = lambda *args, **kwargs: True

    # Displayable types worth reporting; the rest are engine plumbing.
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


    # ------------------------------------------------------------ manual captures (F9)

    _r2l_font = "_r2l_font.ttf" if renpy.loadable("_r2l_font.ttf") else "DejaVuSans.ttf"

    def _r2l_s(v):
        """Sizes are designed for a 1280-wide game and scaled to the game's width."""
        return int(round(v * config.screen_width / 1280.0))

    _r2l_round_cache = {}

    def _r2l_round(fill, radius=12, border=None):
        """
        A rounded rectangle as a nine-slice Frame: drawn at four times the size with pygame and
        scaled down smoothly, so the corners are antialiased.
        """
        key = (fill, radius, border)
        if key in _r2l_round_cache:
            return _r2l_round_cache[key]
        import pygame_sdl2 as pygame
        r = max(2, _r2l_s(radius))
        size = r * 2 + 4
        big = size * 4
        surf = pygame.Surface((big, big), pygame.SRCALPHA)
        def paint(color, inset):
            c = pygame.Color(color)
            rr = r * 4 - inset
            x0, y0, x1, y1 = inset, inset, big - inset, big - inset
            pygame.draw.rect(surf, c, (x0 + rr, y0, x1 - x0 - 2 * rr, y1 - y0))
            pygame.draw.rect(surf, c, (x0, y0 + rr, x1 - x0, y1 - y0 - 2 * rr))
            for cx, cy in ((x0 + rr, y0 + rr), (x1 - rr - 1, y0 + rr), (x0 + rr, y1 - rr - 1), (x1 - rr - 1, y1 - rr - 1)):
                pygame.draw.circle(surf, c, (cx, cy), rr)
        if border:
            paint(border, 0)
            paint(fill, 4)
        else:
            paint(fill, 0)
        small = pygame.transform.smoothscale(surf, (size, size))
        # pygame_sdl2 saves to a file name only; the work directory is writable under the sandbox.
        tmp = _r2l_out("_ui", "round-%d.png" % len(_r2l_round_cache))
        pygame.image.save(small, tmp)
        with open(tmp, "rb") as f:
            data = f.read()
        frame = Frame(im.Data(data, "_r2l_round_%d.png" % len(_r2l_round_cache)), r + 2, r + 2)
        _r2l_round_cache[key] = frame
        return frame
    _r2l_busy = [False]
    _r2l_session_shots = []
    # The shot behind the dialogs: their new context does not draw the game.
    _r2l_backdrop = [Solid("#18181b")]
    _r2l_purpose_text = ""

    def _r2l_where():
        """
        Where the player is: the statement being run, the last line said, and the screens shown.
        """
        info = {}
        try:
            fn, line = renpy.get_filename_line()
            info["location"] = [fn, line]
        except Exception:
            pass
        try:
            node = renpy.game.script.lookup(renpy.game.context().current)
            info["statement"] = type(node).__name__
        except Exception:
            pass
        info["mainMenu"] = bool(getattr(store, "main_menu", False))
        info["inMenu"] = bool(getattr(store, "_menu", False))
        who = getattr(store, "_last_say_who", None)
        what = getattr(store, "_last_say_what", None)
        if what:
            info["lastLine"] = {"who": _r2l_jsonable(who), "what": _r2l_jsonable(what)}
        return info

    def _r2l_manual_shot():
        if _r2l_busy[0]:
            return None
        _r2l_busy[0] = True
        try:
            # The frame on screen now, before the annotation box covers it.
            png = renpy.screenshot_to_bytes(_r2l_size())
            elements = _r2l_elements()
            _r2l_fix_button_rects(elements)
            where = _r2l_where()
            screens = []
            for e in elements:
                if e.get("screen") and e["screen"] not in screens and not e["screen"].startswith("_r2l"):
                    screens.append(e["screen"])

            answer = renpy.invoke_in_new_context(_r2l_ask_purpose, png, elements)
            if answer is None:
                return None
            purpose, crops = answer

            stamp = _r2l_time.strftime("%Y%m%d-%H%M%S")
            key = "shot-%s" % stamp
            n = 2
            while _r2l_os.path.exists(_r2l_out(key, "meta.json")):
                key = "shot-%s-%d" % (stamp, n)
                n += 1
            meta = dict(where, key=key, purpose=purpose, screens=screens, createdAt=_r2l_time.time(),
                        gameSize=list(_r2l_size()))
            # The whole screen is always kept, as the context of an element shot.
            _r2l_save_png(_r2l_out(key, "full.png"), png)
            if _r2l_size() != (1920, 1080):
                _r2l_save_png(_r2l_out(key, "full@1920.png"), renpy.screenshot_to_bytes((1920, 1080)))
            # Crops of the chosen elements, largest first, as crop-<n>.png (n: the element's number).
            sx = 1920.0 / config.screen_width
            sy = 1080.0 / config.screen_height
            meta["crops"] = []
            for e in crops:
                name = "crop-%d.png" % e["n"]
                if _r2l_crop(png, e["rect"], _r2l_out(key, name)):
                    meta["crops"].append({
                        "n": e["n"], "file": name, "rect": e["rect"], "rect1920": _r2l_scale_rect(e["rect"], sx, sy),
                        "type": e["type"], "label": e.get("label"), "text": e.get("text"), "screen": e.get("screen"),
                        "location": e.get("location"), "image": e.get("image"),
                    })
            _r2l_write_json(_r2l_out(key, "elements.json"), {
                "key": key, "item": {"kind": "manual", "purpose": purpose}, "gameSize": list(_r2l_size()),
                "elements": _r2l_table(elements),
            })
            _r2l_write_json(_r2l_out(key, "meta.json"), meta)
            _r2l_progress({"type": "shot", "key": key, "purpose": purpose, "screens": screens})
            _r2l_session_shots.append(key)
            # A dialog, not a notification: a notification stays on screen for seconds and would be
            # in the next shot. Closing the dialog leaves the game exactly as it was.
            renpy.invoke_in_new_context(renpy.call_screen, "_r2l_saved", purpose=purpose,
                                        count=len(_r2l_session_shots))
        except Exception:
            tb = _r2l_traceback.format_exc()
            try:
                with _r2l_io.open(_r2l_out("errors.txt"), "a", encoding="utf-8") as f:
                    f.write(tb if not isinstance(tb, bytes) else tb.decode("utf-8", "replace"))
            except Exception:
                pass
        finally:
            _r2l_busy[0] = False
        return None

    # ------------------------------------------------------------ choosing what to capture

    _R2L_PICK_PRIORITY = ("Button", "Input", "Bar", "Text", "Window", "Frame", "Viewport", "VPGrid", "Grid",
                          "Side", "Image", "ImageReference", "Movie", "Solid")

    def _r2l_pick_candidates(elements):
        """
        What can be picked: every element smaller than the screen, one per rectangle (a button, its
        frame and its text often share one; the button wins).
        """
        w, h = _r2l_size()
        best = {}
        for e in elements:
            x, y, ew, eh = e["rect"]
            if ew < 4 or eh < 4 or (ew >= w - 1 and eh >= h - 1):
                continue
            # Ren'Py's own checkerboard behind an empty scene is not part of the game.
            if "_transparent_tile" in u"%s%s" % (e.get("info") or "", e.get("image") or ""):
                continue
            k = tuple(int(round(v)) for v in e["rect"])
            rank = _R2L_PICK_PRIORITY.index(e["type"]) if e["type"] in _R2L_PICK_PRIORITY else 99
            if k not in best or rank < best[k][0]:
                best[k] = (rank, e)
        return [v[1] for v in best.values()]

    def _r2l_ask_purpose(png, elements):
        """
        Runs in a new context: shows the shot and asks what it is for, and whether to keep the whole
        screen or crops of chosen elements. Returns (purpose, crops) with crops a list of elements
        (empty for the whole screen), or None to discard.
        """
        store._r2l_purpose_text = u""
        shot = im.Data(png, "_r2l_shot_%d.png" % int(_r2l_time.time() * 1000))
        _r2l_backdrop[0] = Transform(shot, xysize=_r2l_size())
        # Largest first: a panel before the buttons on it, a button before its text.
        candidates = sorted(_r2l_pick_candidates(elements), key=lambda e: -(e["rect"][2] * e["rect"][3]))
        state = {"mode": "full", "hover": None}
        chosen = set()
        if _r2l_selftest:
            state["mode"] = "crop"
            chosen.update(range(min(2, len(candidates))))
        rv = renpy.call_screen("_r2l_annotate", shot=shot, candidates=candidates, state=state, chosen=chosen)
        # Return(None) is not "nothing" in Ren'Py: it returns True (save) in the game and opens the main
        # menu on the title screen. Discarding returns its own value.
        if rv is None or rv is False or rv == "__r2l_discard__":
            return None
        text = store._r2l_purpose_text if rv is True else rv
        crops = [candidates[i] for i in sorted(chosen)] if state["mode"] == "crop" else []
        return (text or u"").strip(), crops

    def _r2l_fit(rect, box_w, box_h):
        """Position and scale of a game rectangle inside a preview of the whole screen."""
        gw, gh = _r2l_size()
        k = min(float(box_w) / gw, float(box_h) / gh)
        return int(rect[0] * k), int(rect[1] * k), max(1, int(rect[2] * k)), max(1, int(rect[3] * k))

    def _r2l_crop_label(e):
        name = e.get("label") or e.get("text") or u""
        if len(name) > 14:
            name = name[:14] + u"…"
        return u"%s  %d×%d" % (e["type"], int(e["rect"][2]), int(e["rect"][3])), name

    if _r2l_manual:
        config.underlay.append(renpy.Keymap(K_F9=Function(_r2l_manual_shot)))

    # Self-test for manual mode (R2L_SELFTEST=<seconds>): presses F9 once after that many seconds,
    # as a player would, lets the annotation box save a fixed purpose, then quits.
    _r2l_selftest = _r2l_os.environ.get("R2L_SELFTEST")
    _r2l_selftest_state = {"start": _r2l_time.time(), "pressed": False}

    def _r2l_selftest_tick():
        st = _r2l_selftest_state
        if not st["pressed"] and _r2l_time.time() - st["start"] > float(_r2l_selftest):
            st["pressed"] = True
            import pygame_sdl2 as pygame
            pygame.event.post(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_F9, mod=0, unicode=u"",
                                                 scancode=0, repeat=False))
        elif st["pressed"] and _r2l_os.path.exists(_r2l_out("progress.jsonl")) and not _r2l_busy[0]:
            with _r2l_io.open(_r2l_out("progress.jsonl"), "r", encoding="utf-8") as f:
                if u'"shot"' in f.read():
                    renpy.quit()

    def _r2l_selftest_snap(name="selftest-annotate.png"):
        _r2l_save_png(_r2l_out(name), renpy.screenshot_to_bytes(_r2l_size()))

    if _r2l_manual and _r2l_selftest:
        config.periodic_callbacks.append(_r2l_selftest_tick)


image _r2l_stage = Solid("#6b7480")

# The F9 dialogs, in the WebUI's dashboard style: a white card on a dimmed game, indigo primary
# button, zinc greys.
screen _r2l_annotate(shot, candidates, state, chosen):
    modal True
    zorder 300000
    # A game playing a movie with `play movie` draws it over every screen; a Movie displayable on the
    # movie channel turns that off while the dialog is open (the movie keeps playing).
    add Transform(Movie(channel="movie", size=(4, 4)), alpha=0.0)
    add _r2l_backdrop[0]
    add Solid("#18181b99")
    $ crop_mode = state["mode"] == "crop"
    $ pw, ph = (_r2l_s(520), _r2l_s(292)) if crop_mode else (_r2l_s(1000), _r2l_s(450))
    frame:
        align (0.5, 0.5)
        xsize _r2l_s(1080)
        padding (_r2l_s(24), _r2l_s(20), _r2l_s(24), _r2l_s(18))
        background _r2l_round("#ffffff", 14, "#e4e4e7")
        has vbox
        spacing _r2l_s(14)

        hbox:
            xfill True
            vbox:
                spacing _r2l_s(3)
                text "截图用途" font _r2l_font size _r2l_s(18) color "#18181b"
                text ("勾选需要切分的元素，按尺寸降序排列" if crop_mode else "保存完整画面，或切换至切图模式选择元素") font _r2l_font size _r2l_s(13) color "#71717a"
            frame:
                xalign 1.0
                yalign 0.5
                padding (_r2l_s(3), _r2l_s(3))
                background _r2l_round("#f4f4f5", 8)
                hbox:
                    spacing _r2l_s(2)
                    for mode, label in (("full", u"全图"), ("crop", u"切图  %d" % len(chosen) if chosen else u"切图")):
                        button:
                            padding (_r2l_s(14), _r2l_s(5), _r2l_s(14), _r2l_s(5))
                            background (_r2l_round("#ffffff", 6, "#e4e4e7") if state["mode"] == mode else None)
                            hover_background (_r2l_round("#ffffff", 6, "#e4e4e7") if state["mode"] == mode else _r2l_round("#e4e4e7", 6))
                            action SetDict(state, "mode", mode)
                            text label font _r2l_font size _r2l_s(14) color ("#18181b" if state["mode"] == mode else "#52525b")

        hbox:
            spacing _r2l_s(16)
            # Preview: the whole screen, with the chosen (and the hovered) elements outlined.
            fixed:
                xysize (pw, ph)
                add Transform(shot, fit="contain", xysize=(pw, ph))
                if crop_mode:
                    for i in sorted(chosen):
                        $ x, y, w, h = _r2l_fit(candidates[i]["rect"], pw, ph)
                        add _r2l_round("#4f46e533", 2, "#4f46e5") pos (x, y) xysize (w, h)
                    if state["hover"] is not None and state["hover"] < len(candidates):
                        $ x, y, w, h = _r2l_fit(candidates[state["hover"]]["rect"], pw, ph)
                        add _r2l_round("#f59e0b33", 2, "#f59e0b") pos (x, y) xysize (w, h)
            if crop_mode and not candidates:
                frame:
                    xysize (_r2l_s(496), _r2l_s(292))
                    background _r2l_round("#fafafa", 8, "#e4e4e7")
                    text "该画面无可切分元素，仅可保存全图" font _r2l_font size _r2l_s(13) color "#71717a" align (0.5, 0.5)
            elif crop_mode:
                frame:
                    xysize (_r2l_s(496), _r2l_s(292))
                    padding (0, 0)
                    background None
                    viewport:
                        mousewheel True
                        draggable True
                        scrollbars "vertical"
                        side_spacing _r2l_s(6)
                        vscrollbar_xsize _r2l_s(6)
                        vscrollbar_unscrollable "hide"
                        vscrollbar_top_bar _r2l_round("#f4f4f5", 3)
                        vscrollbar_bottom_bar _r2l_round("#f4f4f5", 3)
                        vscrollbar_thumb _r2l_round("#d4d4d8", 3)
                        vscrollbar_hover_thumb _r2l_round("#a1a1aa", 3)
                        vscrollbar_thumb_offset 0
                        vpgrid:
                            cols 3
                            spacing _r2l_s(8)
                            for i, e in enumerate(candidates):
                                $ head, name = _r2l_crop_label(e)
                                button:
                                    xysize (_r2l_s(156), _r2l_s(124))
                                    padding (_r2l_s(6), _r2l_s(6), _r2l_s(6), _r2l_s(6))
                                    background (_r2l_round("#eef2ff", 8, "#4f46e5") if i in chosen else _r2l_round("#ffffff", 8, "#e4e4e7"))
                                    hover_background (_r2l_round("#e0e7ff", 8, "#4f46e5") if i in chosen else _r2l_round("#fafafa", 8, "#a1a1aa"))
                                    action ToggleSetMembership(chosen, i)
                                    hovered SetDict(state, "hover", i)
                                    unhovered SetDict(state, "hover", None)
                                    vbox:
                                        spacing _r2l_s(4)
                                        fixed:
                                            xysize (_r2l_s(144), _r2l_s(72))
                                            add Solid("#f4f4f5")
                                            add Transform(Transform(shot, crop=tuple(int(round(v)) for v in e["rect"])), fit="contain", xysize=(_r2l_s(144), _r2l_s(72))) align (0.5, 0.5)
                                        text head font _r2l_font size _r2l_s(11) color "#18181b"
                                        text name font _r2l_font size _r2l_s(11) color "#71717a"

        frame:
            xfill True
            padding (_r2l_s(12), _r2l_s(9), _r2l_s(12), _r2l_s(9))
            background _r2l_round("#ffffff", 8, "#a5b4fc")
            input:
                value VariableInputValue("_r2l_purpose_text", returnable=True)
                font _r2l_font
                size _r2l_s(15)
                color "#18181b"
                pixel_width _r2l_s(1000)
                copypaste True
        hbox:
            xalign 1.0
            spacing _r2l_s(8)
            button:
                padding (_r2l_s(14), _r2l_s(8), _r2l_s(14), _r2l_s(8))
                background _r2l_round("#ffffff", 8, "#e4e4e7")
                hover_background _r2l_round("#f4f4f5", 8, "#d4d4d8")
                action Return("__r2l_discard__")
                text "丢弃  Esc" font _r2l_font size _r2l_s(14) color "#3f3f46"
            button:
                padding (_r2l_s(14), _r2l_s(8), _r2l_s(14), _r2l_s(8))
                background _r2l_round("#4f46e5", 8)
                hover_background _r2l_round("#4338ca", 8)
                action Return(True)
                text ((u"保存 %d 张切图  Enter" % len(chosen)) if crop_mode and chosen else u"保存全图  Enter") font _r2l_font size _r2l_s(14) color "#ffffff"
    key "K_ESCAPE" action Return("__r2l_discard__")
    key "game_menu" action Return("__r2l_discard__")
    if _r2l_selftest:
        timer 0.8 action [SetVariable("_r2l_purpose_text", u"测试：标题画面，迁移为启动页")]
        timer 1.4 action Function(_r2l_selftest_snap)
        timer 1.8 action Return(True)

screen _r2l_saved(purpose, count):
    modal True
    zorder 300000
    # A game playing a movie with `play movie` draws it over every screen; a Movie displayable on the
    # movie channel turns that off while the dialog is open (the movie keeps playing).
    add Transform(Movie(channel="movie", size=(4, 4)), alpha=0.0)
    add _r2l_backdrop[0]
    add Solid("#18181b99")
    frame:
        align (0.5, 0.5)
        xsize _r2l_s(420)
        padding (_r2l_s(24), _r2l_s(22), _r2l_s(24), _r2l_s(20))
        background _r2l_round("#ffffff", 14, "#e4e4e7")
        has vbox
        spacing _r2l_s(14)
        hbox:
            spacing _r2l_s(10)
            frame:
                yalign 0.5
                xysize (_r2l_s(28), _r2l_s(28))
                padding (0, 0)
                background _r2l_round("#dcfce7", 14)
                text "✓" font "DejaVuSans.ttf" size _r2l_s(16) color "#16a34a" align (0.5, 0.5)
            vbox:
                yalign 0.5
                spacing _r2l_s(2)
                text "已保存截图" font _r2l_font size _r2l_s(17) color "#18181b"
                text "本次已截 [count] 张" font _r2l_font size _r2l_s(13) color "#71717a"
        if purpose:
            frame:
                xfill True
                padding (_r2l_s(12), _r2l_s(9), _r2l_s(12), _r2l_s(9))
                background _r2l_round("#f4f4f5", 8)
                text "[purpose!q]" font _r2l_font size _r2l_s(14) color "#3f3f46"
        button:
            xalign 1.0
            padding (_r2l_s(14), _r2l_s(8), _r2l_s(14), _r2l_s(8))
            background _r2l_round("#4f46e5", 8)
            hover_background _r2l_round("#4338ca", 8)
            action Return(True)
            text "继续  Enter" font _r2l_font size _r2l_s(14) color "#ffffff"
    key "K_RETURN" action Return(True)
    key "K_KP_ENTER" action Return(True)
    key "K_ESCAPE" action Return(True)
    key "game_menu" action Return(True)
    if _r2l_selftest:
        timer 0.6 action Function(_r2l_selftest_snap, "selftest-saved.png")
        timer 1.0 action Return(True)


