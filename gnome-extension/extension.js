// Wispr Flow Window Bridge — GNOME Shell extension (GNOME 45+, ESM modules).
//
// Runs inside the privileged gnome-shell process and exports a small D-Bus
// interface giving the focused window's identity plus a focus-change signal.
// This is the "Window Calls" / "Focused Window D-Bus" pattern: the built-in
// org.gnome.Shell.Introspect API is gated behind unsafe_mode on modern GNOME
// (AccessDenied to normal callers), so the Wispr Flow Linux helper bundles and
// enables this extension instead and talks to it over the session bus.
//
// Interface:
//   name      : org.wispr.flow.WindowBridge   (well-known bus name we own)
//   object    : /org/wispr/flow/WindowBridge
//   interface : org.wispr.flow.WindowBridge
//     GetFocusedWindow() -> (s)   JSON {appId,title,pid,wmClass} ("" if none)
//     GetWindowList()    -> (s)   JSON array of the same shape (normal windows)
//     FocusChanged(s)             signal carrying the focused-window JSON

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUS_NAME = 'org.wispr.flow.WindowBridge';
const OBJECT_PATH = '/org/wispr/flow/WindowBridge';

const IFACE_XML = `
<node>
  <interface name="org.wispr.flow.WindowBridge">
    <method name="GetFocusedWindow">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="GetWindowList">
      <arg type="s" direction="out" name="json"/>
    </method>
    <signal name="FocusChanged">
      <arg type="s" name="json"/>
    </signal>
  </interface>
</node>`;

// The focused window, or — when mutter reports none (focus on the shell /
// overview, or a session that hasn't received real input yet) — the
// most-recently-used normal, taskbar-visible window. For a dictation helper the
// MRU window is the right "where would my text go" answer when nothing holds
// keyboard focus; mirrors how the macOS/Windows helpers keep a last-active app.
function focusedOrMru() {
    const win = global.display.get_focus_window();
    if (win)
        return win;
    try {
        const ws = global.workspace_manager.get_active_workspace();
        const list = global.display.get_tab_list(Meta.TabList.NORMAL, ws);
        for (const w of list) {
            if (w && w.window_type === Meta.WindowType.NORMAL && !w.is_skip_taskbar())
                return w;
        }
    } catch (e) {}
    return null;
}

// Build the {appId,title,pid,wmClass} object for a Meta.Window, resolving the
// real .desktop app id via Shell.WindowTracker.
function windowInfo(win) {
    if (!win)
        return {appId: '', title: '', pid: 0, wmClass: ''};

    let appId = '';
    try {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (app)
            appId = app.get_id() ?? '';
    } catch (e) {
        // get_window_app can fail transiently while a window is mapping.
    }

    let title = '';
    try {
        title = win.get_title() ?? '';
    } catch (e) {}

    let pid = 0;
    try {
        pid = win.get_pid() ?? 0;
        if (pid < 0)
            pid = 0;
    } catch (e) {}

    let wmClass = '';
    try {
        wmClass = win.get_wm_class() ?? '';
    } catch (e) {}

    return {appId, title, pid, wmClass};
}

// Wispr Flow's own auxiliary windows that are never meant to be taskbar/
// Alt-Tab entries (the dictation status pill, the in-app context menu, ...).
// Electron creates each of these with `skipTaskbar: true`, but that hint has
// no effect under native Wayland: Electron's Ozone/Wayland backend talks raw
// xdg-shell and never creates a GtkWindow, so the gtk_shell1 protocol that
// carries the skip-taskbar request to Mutter is never spoken. Mutter is left
// to assume every xdg_toplevel is an ordinary app window, so the transparent,
// click-through status pill shows up as a second, empty-looking window in the
// taskbar/Overview/Alt-Tab (issue: the pill is "always open" from the user's
// perspective). We run inside gnome-shell's own process, so we can correct
// Mutter's classification directly via Meta.Window, independent of whatever
// protocol the client did or didn't speak. `Hub` and `Scratchpad` are the
// only two Wispr Flow windows meant to be real, user-facing taskbar entries.
const WISPR_WM_CLASS = 'wispr-flow';
const WISPR_TASKBAR_TITLES = new Set(['Hub', 'Scratchpad']);

// Re-snap tolerance: skip re-positioning if we're already within this many
// pixels of the target, so our own `position-changed` handler doesn't loop
// against the move it just made.
const STATUS_POSITION_TOLERANCE = 2;

// The pill is bottom-centred in the status window with its bottom edge this
// many logical px above the window's bottom (measured from the renderer DOM).
// The window itself is sized by the app (linux-status-compact.sh patch).
const STATUS_PILL_BOTTOM_INSET = 14;
// Gap between the pill's bottom edge and the top of the dock.
const STATUS_DOCK_GAP = 2;

// Height of the (Ubuntu/dash-to-dock) dock as drawn by GNOME Shell. The dock
// is Shell chrome, not a Meta.Window, so read its actor directly. Returns 0
// if no dock is present.
function dockHeight() {
    let found = 0;
    const walk = actor => {
        if (found)
            return;
        if (actor.get_name?.() === 'dashtodockBox') {
            found = actor.height;
            return;
        }
        for (const c of actor.get_children?.() ?? [])
            walk(c);
    };
    try {
        walk(Main.layoutManager.uiGroup);
    } catch (e) {}
    return Math.round(found);
}

export default class WindowBridgeExtension extends Extension {
    enable() {
        // Must exist before the sweep below wires an already-open status pill.
        this._statusWins = new Set();
        this._clickThroughSaved = new WeakMap();

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._dbusImpl.export(Gio.DBus.session, OBJECT_PATH);
        this._ownerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session,
            BUS_NAME,
            Gio.BusNameOwnerFlags.REPLACE,
            null,
            null
        );

        // Track the focused window so we can also fire FocusChanged on title
        // changes of the currently-focused window (mirrors macOS/Windows which
        // surface title updates as focus updates).
        this._focusWindow = null;
        this._titleId = 0;

        this._focusChangedId = global.display.connect(
            'notify::focus-window',
            () => this._onFocusChanged()
        );

        // Seed the title-watch on whatever already has focus.
        this._onFocusChanged();

        // Hide Wispr Flow's non-taskbar windows from the taskbar/Alt-Tab/
        // Overview. `map` (not `window-created`) because wm_class/title are
        // not reliably populated yet at creation time -- they're set by the
        // point the compositor maps the surface.
        this._mapId = global.window_manager.connect('map', (_wm, actor) =>
            this._hideIfAuxiliary(actor.meta_window)
        );
        // Catch anything already mapped before we were enabled (e.g. this
        // extension re-enabling mid-session after a GNOME Shell restart).
        global.get_window_actors().forEach(a =>
            this._hideIfAuxiliary(a.meta_window)
        );

        // Let clicks through the status pill while a fullscreen app is up.
        const rescan = () => this._statusWins.forEach(w => this._updateClickThrough(w));
        this._clickThroughSignals = [];
        for (const [obj, name] of [
            [global.display, 'in-fullscreen-changed'],
            [global.display, 'notify::focus-window'],
            [global.window_manager, 'map'],
            [global.window_manager, 'destroy'],
            [global.window_manager, 'minimize'],
            [global.window_manager, 'unminimize'],
            [global.window_manager, 'size-changed'],
            [global.window_manager, 'switch-workspace'],
        ])
            this._clickThroughSignals.push([obj, obj.connect(name, rescan)]);
    }

    // While a fullscreen window is showing on the pill's monitor, make the
    // pill's window click-through so clicks reach that app instead.
    //
    // The status window is a real toplevel (Wayland has no input-transparent
    // overlay for a client to ask for, and its click-through hit test does not
    // work there), and it is larger than the pill it draws. A click anywhere in
    // it focuses it, so the fullscreen app loses focus -- and apps that
    // minimize on focus loss (Wine/Proton games such as Genshin Impact) drop
    // out of fullscreen. Marking the actor non-reactive removes it from
    // Clutter's pointer picking, so the pointer lands on the window beneath.
    // It has to be applied to the window actor AND all its descendants: setting
    // it on the actor alone leaves the surface actor pickable. (Verified on
    // GNOME 50 / mutter 18 by picking at the window centre in a headless
    // shell: window -> actor only: still window -> actor+children: background.)
    // The hover-only UI (globe button, tooltip) is unavailable meanwhile;
    // push-to-talk itself is keyboard-driven and unaffected.

    // True if a normal, non-Wispr fullscreen window is visible on `monitor` in
    // the active workspace.
    _fullscreenWindowOn(monitor) {
        const ws = global.workspace_manager.get_active_workspace();
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (!w || w.window_type !== Meta.WindowType.NORMAL || w.minimized)
                continue;
            if (w.get_wm_class() === WISPR_WM_CLASS)
                continue;
            if (w.get_monitor() !== monitor || !w.located_on_workspace(ws))
                continue;
            if (w.is_fullscreen())
                return true;
        }
        return false;
    }

    _updateClickThrough(win) {
        try {
            const actor = win.get_compositor_private();
            if (!actor)
                return;
            const through = this._fullscreenWindowOn(win.get_monitor());
            const saved = this._clickThroughSaved.get(win);
            if (through && !saved) {
                // Remember each actor's own value so we restore exactly what
                // Mutter set (some children, e.g. shadows, are never reactive).
                const state = new Map();
                const walk = a => {
                    state.set(a, a.reactive);
                    a.reactive = false;
                    for (const c of a.get_children())
                        walk(c);
                };
                walk(actor);
                this._clickThroughSaved.set(win, state);
            } else if (!through && saved) {
                this._restoreClickThrough(win);
            }
        } catch (e) {
            // Window can vanish mid-call; nothing to clean up either way.
        }
    }

    _restoreClickThrough(win) {
        const state = this._clickThroughSaved?.get(win);
        if (!state)
            return;
        this._clickThroughSaved.delete(win);
        for (const [actor, reactive] of state) {
            try {
                actor.reactive = reactive;
            } catch (e) {
                // Actor destroyed since we recorded it.
            }
        }
    }

    // Excludes win from the taskbar/Alt-Tab/Overview switcher if it is one of
    // Wispr Flow's auxiliary windows, and corrects its window type so it
    // actually behaves like the overlay it's meant to be. Idempotent and safe
    // to call repeatedly (each of these calls is a no-op on a window already
    // in the target state), so both the `map` handler and the enable()-time
    // sweep can call it unconditionally without tracking which windows were
    // already seen.
    _hideIfAuxiliary(win) {
        if (!win)
            return;
        try {
            if (win.get_wm_class() !== WISPR_WM_CLASS)
                return;
            // The title (and possibly other window properties) may not be
            // populated yet at `map` time -- Electron sets the OS-level
            // window title from the loaded page's <title>, which can lag the
            // surface actually mapping. Retry once the title lands instead of
            // silently mis-classifying a not-yet-titled window as one of the
            // real taskbar windows (empty string is never in
            // WISPR_TASKBAR_TITLES, so this only ever widens what gets
            // treated as auxiliary, never narrows it).
            if (!this._titleWatched?.has(win)) {
                this._titleWatched ??= new WeakSet();
                this._titleWatched.add(win);
                win.connect('notify::title', () => this._hideIfAuxiliary(win));
            }
            if (WISPR_TASKBAR_TITLES.has(win.get_title() ?? ''))
                return;
            win.hide_from_window_list();
            // `hide_from_window_list()` only affects Alt-Tab/taskbar-style
            // consumers that check `is_skip_taskbar()`; GNOME Shell's own
            // Overview window grid additionally reads the `skip-taskbar`
            // GObject property directly. Set both explicitly rather than
            // relying on one to imply the other. Separately guarded: some
            // Mutter versions expose this as constructor-only, in which case
            // assignment throws and we fall through to the type/stacking
            // fixes below regardless.
            try {
                win.skip_taskbar = true;
            } catch (e) {
                // Read-only in this Mutter version; hide_from_window_list()
                // above is the fallback lever.
            }
            // Wispr Flow's overlay windows are already asked (from the
            // Electron side) to appear on every workspace; Wayland ignores
            // that request for the same reason it ignores skip-taskbar, so
            // mirror it here too rather than leaving the pill workspace-
            // bound.
            win.stick();
            // Electron's `type: "toolbar"` BrowserWindow option is X11-only
            // and does nothing on Wayland, so Mutter classifies the pill as
            // an ordinary Meta.WindowType.NORMAL toplevel. A NORMAL window's
            // always-on-top state is still subject to Mutter's normal
            // focus/stacking rules, so the "always on top" status pill can
            // end up rendered *behind* whatever window has focus -- from the
            // user's perspective, the push-to-talk indicator never appears.
            // UTILITY windows are stacked/raised independently of focus
            // changes to the main application, matching what this window
            // actually is.
            win.set_type(Meta.WindowType.UTILITY);
            if (!this._aboveWired?.has(win)) {
                this._aboveWired ??= new WeakSet();
                this._aboveWired.add(win);
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!win.is_destroyed?.())
                        win.make_above();
                    return GLib.SOURCE_REMOVE;
                });
            }

            // The dictation status pill specifically: pin it bottom-center.
            // Wispr's own dock-edge placement code (and its drag-to-reposition
            // feature) both work by asking Electron to move the BrowserWindow
            // to an absolute (x, y) -- a request the base Wayland xdg_toplevel
            // protocol has no way to carry at all (unlike X11, a Wayland
            // client cannot place its own top-level window on screen; only
            // the compositor can). Under native Wayland, Mutter silently
            // accepts the surface and applies its own placement heuristic
            // instead, which is what puts the pill wherever it lands rather
            // than bottom-center, and why dragging it visibly does nothing.
            // We're inside gnome-shell itself, so we CAN move it via
            // Meta.Window -- the only place in the stack with the authority
            // to position a toplevel Wayland surface. Dragging still won't
            // work (there's no client-side move on Wayland), but this keeps
            // the pill where it's meant to live.
            // The context menu (language picker etc.) is a transparent
            // overlay the app sizes to the whole work area and draws the menu
            // inside at pill-relative coordinates; it only lines up if the
            // window sits exactly at the work-area origin, which Wayland won't
            // let the app enforce itself.
            const title = win.get_title() ?? '';
            if ((title === 'Context Menu' || title === 'Flow Context Menu') &&
                !this._statusWired?.has(win)) {
                this._statusWired ??= new WeakSet();
                this._statusWired.add(win);
                const pin = () => {
                    try {
                        const a = win.get_work_area_current_monitor();
                        const r = win.get_frame_rect();
                        if (r.x !== a.x || r.y !== a.y)
                            win.move_frame(true, a.x, a.y);
                    } catch (e) {}
                };
                pin();
                win.connect('position-changed', pin);
                win.connect('size-changed', pin);
            }
            if (win.get_title() === 'Status' && !this._statusWired?.has(win)) {
                this._statusWired ??= new WeakSet();
                this._statusWired.add(win);
                this._pinStatusBottomCenter(win);
                win.connect('position-changed', () =>
                    this._pinStatusBottomCenter(win)
                );
                win.connect('size-changed', () =>
                    this._pinStatusBottomCenter(win)
                );
                this._statusWins.add(win);
                win.connect('unmanaged', () => this._statusWins.delete(win));
                // Re-evaluate if the pill lands on a different monitor.
                win.connect('position-changed', () =>
                    this._updateClickThrough(win)
                );
                this._updateClickThrough(win);
            }
        } catch (e) {
            // Window can vanish mid-call (closed while we're inspecting it);
            // nothing to clean up either way.
        }
    }

    _pinStatusBottomCenter(win) {
        try {
            if (win.is_destroyed?.())
                return;
            const area = win.get_work_area_current_monitor();
            const rect = win.get_frame_rect();
            const {width, height} = rect;
            const x = Math.round(area.x + (area.width - width) / 2);
            const mon = global.display.get_monitor_geometry(win.get_monitor());
            const dockTop = mon.y + mon.height - dockHeight();
            const y = Math.round(
                dockTop - STATUS_DOCK_GAP - height + STATUS_PILL_BOTTOM_INSET
            );
            if (
                Math.abs(rect.x - x) <= STATUS_POSITION_TOLERANCE &&
                Math.abs(rect.y - y) <= STATUS_POSITION_TOLERANCE
            )
                return;
            win.move_frame(true, x, y);
        } catch (e) {
            // Window can vanish mid-call; nothing to clean up either way.
        }
    }

    disable() {
        if (this._mapId) {
            global.window_manager.disconnect(this._mapId);
            this._mapId = 0;
        }
        if (this._focusChangedId) {
            global.display.disconnect(this._focusChangedId);
            this._focusChangedId = 0;
        }
        for (const [obj, id] of this._clickThroughSignals ?? [])
            obj.disconnect(id);
        this._clickThroughSignals = [];
        this._statusWins?.forEach(w => this._restoreClickThrough(w));
        this._statusWins?.clear();
        this._disconnectTitle();
        this._focusWindow = null;

        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
    }

    _disconnectTitle() {
        if (this._titleId && this._focusWindow) {
            try {
                this._focusWindow.disconnect(this._titleId);
            } catch (e) {}
        }
        this._titleId = 0;
    }

    _onFocusChanged() {
        const win = global.display.get_focus_window();

        // Re-arm the title watcher on the newly focused window.
        if (win !== this._focusWindow) {
            this._disconnectTitle();
            this._focusWindow = win;
            if (win) {
                this._titleId = win.connect('notify::title', () =>
                    this._emitFocus()
                );
            }
        }

        this._emitFocus();
    }

    _emitFocus() {
        if (!this._dbusImpl)
            return;
        const json = JSON.stringify(windowInfo(focusedOrMru()));
        this._dbusImpl.emit_signal(
            'FocusChanged',
            new GLib.Variant('(s)', [json])
        );
    }

    // D-Bus method: focused window identity as JSON (MRU fallback when none).
    GetFocusedWindow() {
        return JSON.stringify(windowInfo(focusedOrMru()));
    }

    // D-Bus method: all normal, taskbar-visible windows as a JSON array. The
    // skip_taskbar filter drops docks/OSDs and — importantly — the helper's own
    // wl-copy clipboard surfaces (which map as titled "wl-clipboard" windows when
    // the in-process ext-data-control path is unavailable, e.g. on mutter), so
    // they don't pollute GetRunningApps. Matches the KWin script's filter.
    GetWindowList() {
        const out = [];
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win)
                continue;
            if (win.window_type !== Meta.WindowType.NORMAL)
                continue;
            if (win.is_skip_taskbar())
                continue;
            const info = windowInfo(win);
            // Drop windows with no real application identity: the Shell assigns a
            // synthetic "window:N" app id and an empty wmClass to surfaces with no
            // .desktop file — e.g. the helper's own wl-copy clipboard surfaces on
            // mutter (which has no ext-data-control). Real apps set a wmClass.
            if (info.wmClass === '' && info.appId.startsWith('window:'))
                continue;
            out.push(info);
        }
        return JSON.stringify(out);
    }
}
