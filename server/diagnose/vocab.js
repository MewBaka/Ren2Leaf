// Word lists the scanner uses to tell store variables apart from screen-language syntax, Python
// builtins and Ren'Py's own names. Lists err on the side of filtering: a name missed here shows up
// in a screen's `unresolvedNames`, never silently dropped.

const words = (s) => new Set(s.trim().split(/\s+/));

/** Screens the default GUI template (and older templates) defines; the engine shows several itself. */
export const STANDARD_SCREENS = [
    "say", "input", "choice", "quick_menu", "navigation", "main_menu", "game_menu", "about",
    "save", "load", "file_slots", "preferences", "history", "help", "keyboard_help", "mouse_help",
    "gamepad_help", "confirm", "skip_indicator", "notify", "nvl", "nvl_dialogue", "nvl_choice",
    "bubble", "ctc", "yesno_prompt", "window",
];

/** Screens defined in renpy/common (besides the `_`-prefixed ones). */
export const ENGINE_SCREENS = words(`
    director director_move_button director_lines director_statement director_with_statement
    director_audio_statement director_footer director_choices director_kind director_tag
    director_attributes director_transform director_behind director_with director_channel
    director_audio iconbutton gallery_navigation sync_confirm sync_prompt sync_success sync_error
`);

export const PY_KEYWORDS = words(`
    and as assert async await break class continue def del elif else except exec finally for from
    global if import in is lambda nonlocal not or pass print raise return try while with yield
    None True False
`);

export const PY_BUILTINS = words(`
    abs all any ascii bin bool bytearray bytes callable chr classmethod compile complex delattr dict
    dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash hex id
    input int isinstance issubclass iter len list locals map max memoryview min next object oct open
    ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum
    super tuple type vars zip __import__ unicode basestring long xrange unichr raw_input reduce cmp
    Exception ValueError TypeError KeyError IndexError AttributeError NameError RuntimeError
    StopIteration NotImplemented Ellipsis math random time datetime os sys re
    _ __ _p ___
`);

/** Statements and displayables of the screen language. */
export const SCREEN_KEYWORDS = words(`
    screen use transclude default python if elif else for in while pass on key timer showif has
    window frame fixed hbox vbox grid vpgrid side viewport text textbutton button imagebutton image
    add null label bar vbar input imagemap hotspot hotbar drag draggroup mousearea nearrect
    areapicker dismiss zorder modal tag variant layer sensitive predict roll_forward style_prefix
    style_group style_suffix expression at as id style
`);

export const DISPLAYABLES = words(`
    window frame fixed hbox vbox grid vpgrid side viewport text textbutton button imagebutton image
    add null label bar vbar input imagemap hotspot hotbar drag draggroup mousearea nearrect
    areapicker dismiss key timer use transclude
`);

/** Widgets a player clicks or drags. bar/vbar count unless their value is display-only. */
export const CLICKABLE = words(`
    button textbutton imagebutton hotspot hotbar bar vbar input drag dismiss
`);

const STYLE_PROPS = words(`
    pos xpos ypos anchor xanchor yanchor align xalign yalign center xcenter ycenter offset xoffset
    yoffset maximum xmaximum ymaximum minimum xminimum yminimum size xsize ysize xysize fill xfill
    yfill fit xfit yfit area subpixel transform_anchor alt group
    background foreground margin xmargin ymargin left_margin right_margin top_margin bottom_margin
    padding xpadding ypadding left_padding right_padding top_padding bottom_padding size_group
    font bold italic underline strikethrough vertical color first_indent rest_indent line_spacing
    line_leading line_overlap_split text_align textalign justify layout min_width newline_indent
    outlines outline_scaling kerning antialias hinting slow_cps slow_cps_multiplier slow_abortable
    black_color adjust_spacing drop_shadow drop_shadow_color language emoji_font prefer_emoji axis
    shaper instance features ruby_style altruby_style ruby_line_leading textshader
    spacing xspacing yspacing first_spacing box_reverse box_wrap box_wrap_spacing box_layout
    box_align order_reverse hover_sound activate_sound child mouse focus_mask keyboard_focus
    key_events bar_vertical bar_invert bar_resizing left_gutter right_gutter top_gutter
    bottom_gutter left_bar right_bar top_bar bottom_bar base_bar thumb thumb_shadow thumb_offset
    unscrollable xinitial yinitial child_size mousewheel draggable edgescroll scrollbars arrowkeys
    pagekeys xadjustment yadjustment transpose cols rows allow_underfull alpha zoom xzoom yzoom
    rotate rotate_pad crop crop_relative corner1 corner2 events clipping xtile ytile matrixcolor
    blur additive mesh mesh_pad shader nearest fps mipmap
    action alternate hovered unhovered clicked selected sensitive keysym alternate_keysym focus
    default_focus tooltip style style_prefix style_group style_suffix at id as tag zorder modal
    variant predict layer roll_forward value range adjustment changed released length allow exclude
    prefix suffix pixel_width copypaste mask multiline caret_blink ground idle hover insensitive
    auto cache drag_name droppable drag_raise dragged dropped drag_handle drag_joined mouse_drop
    drag_offscreen snapped repeat capture rect prefer_top substitute slow scope width height minwidth sound
    hotspot_padding text_style
`);

const PROP_PREFIXES = [
    "selected_", "idle_", "hover_", "insensitive_", "activate_", "text_", "bar_", "thumb_",
    "side_", "viewport_", "scrollbar_", "vscrollbar_", "who_", "what_", "window_", "button_",
];

export function isPropertyName(name) {
    let n = name;
    for (let changed = true; changed; ) {
        changed = false;
        for (const p of PROP_PREFIXES) {
            if (n.startsWith(p) && n.length > p.length) {
                n = n.slice(p.length);
                changed = true;
            }
        }
    }
    return STYLE_PROPS.has(n);
}

/** Module-like names in the store; a bare use is not a variable read. */
export const NAMESPACES = words(`
    renpy config gui store style ui im build preferences _preferences layout theme director iap
    updater achievement bubble _console persistent nvl adv centered narrator extend vcentered
`);

/** Store variables the engine itself defines and screens commonly read. */
export const ENGINE_STORE = words(`
    main_menu _history_list _game_menu_screen save_name _window_subtitle _quit_slot _in_replay
    _skipping _rollback _confirm_quit _window _windows_hidden _menu _last_say_who _version
    _autosave _dismiss_pause _side_image_attributes suppress_overlay _screenshot_pattern
    _history _return _args _kwargs mouse_visible
`);

/** Built-in transforms, positions and transitions. */
export const ENGINE_DEFINES = words(`
    left right center truecenter topleft topright top bottom offscreenleft offscreenright default
    reset dissolve fade pixellate move moveinright moveinleft moveintop moveinbottom moveoutright
    moveoutleft moveouttop moveoutbottom ease easeinright easeinleft easeintop easeinbottom
    easeoutright easeoutleft easeouttop easeoutbottom zoomin zoomout zoominout vpunch hpunch blinds
    squares wipeleft wiperight wipeup wipedown slideleft slideright slideup slidedown
    slideawayleft slideawayright slideawayup slideawaydown pushright pushleft pushup pushdown
    irisin irisout
`);

/** Ren'Py screen actions, values and common displayable constructors. */
export const RENPY_CALLABLES = words(`
    Return Jump Call Show Hide ShowMenu ShowTransient ToggleScreen ShowScreen
    ToggleScreenVariable SetScreenVariable SetVariable ToggleVariable SetField ToggleField SetDict
    ToggleDict SetLocalVariable ToggleLocalVariable AddToSet RemoveFromSet ToggleSetMembership
    Function NullAction Notify Confirm Start MainMenu Quit Skip Rollback RollForward
    RestartStatement Help OpenURL OpenDirectory Screenshot FileSave FileLoad FileAction FileDelete
    FileTakeScreenshot FilePage FilePageNext FilePagePrevious FileSlotName FileTime FileScreenshot
    FileSaveName FileUsedSlots FileJson FilePageName FileCurrentPage FileLoadable QuickSave
    QuickLoad Preference GetTooltip Language Play Queue Stop PauseAudio SetMixer SetMute ToggleMute
    SetVoiceMute ToggleVoiceMute PlayCharacterVoice VoiceReplay HideInterface With Scroll Replay
    EndReplay MouseMove QueueEvent CaptureFocus ClearFocus ToggleFocus GetFocusRect ExecJS
    DisableAllInputValues InvertSelected If SelectedIf SensitiveIf AudioPositionValue BarValue
    FieldValue VariableValue ScreenVariableValue DictValue AnimatedValue StaticValue MixerValue
    XScrollValue YScrollValue VariableInputValue ScreenVariableInputValue FieldInputValue
    DictInputValue FilePageNameInputValue LocalVariableValue LocalVariableInputValue Tooltip
    Character DynamicCharacter NVLCharacter ADVCharacter Transform Solid Frame Image Text Null
    Fixed HBox VBox Grid Window Viewport Composite LiveComposite ConditionSwitch ShowingSwitch
    DynamicDisplayable Flatten AlphaMask Movie Animation Position Move Dissolve Fade Pixellate
    ImageDissolve MoveTransition ParameterizedText Color Matrix SnowBlossom Particles
    ImageReference LayeredImageProxy At Crop
`);
