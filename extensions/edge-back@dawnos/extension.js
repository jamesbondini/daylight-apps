// Swipe in from the left edge of the screen to go back in the app under the
// finger, like on a phone. An arrow follows the finger; letting go once it is
// highlighted sends the app its Back shortcut.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Swipes must start this close to the left edge (px). The DC-1's bezel
// covers the outer ~10 device pixels, so a finger coming in over it first
// touches a little way in.
const EDGE = 32;

// Letting go after the finger travelled this far (px), or flicking right
// faster than this (px/ms), goes back.
const DISTANCE_THRESHOLD = 120;
const VELOCITY_THRESHOLD = 0.5;

// The arrow's size (as in the stylesheet), and how far in it comes at most.
const ARROW_SIZE = 56;
const MAX_TRAVEL = 96;

const SLIDE_MS = 150;

// The Back shortcut of apps that don't use Alt+Left, by Wayland app id
// (Meta.Window wm_class).
const SHORTCUTS = new Map([
    ['code', [Clutter.KEY_Control_L, Clutter.KEY_Alt_L, Clutter.KEY_minus]],
    ['Code', [Clutter.KEY_Control_L, Clutter.KEY_Alt_L, Clutter.KEY_minus]],
    ['obsidian', [Clutter.KEY_Control_L, Clutter.KEY_Alt_L, Clutter.KEY_Left]],
]);
const DEFAULT_SHORTCUT = [Clutter.KEY_Alt_L, Clutter.KEY_Left];

// Terminals have no Back, and Alt+Left would move the shell's cursor a word,
// so a swipe there stays with the app.
const TERMINALS = new Set([
    'com.mitchellh.ghostty',
    'org.gnome.Console',
    'org.gnome.Terminal',
    'org.gnome.Ptyxis',
    'kitty',
    'foot',
    'Alacritty',
    'org.wezfurlong.wezterm',
]);

export default class EdgeBackExtension extends Extension {
    enable() {
        // Shortcuts go to the focused window, so the window under the finger
        // is focused first. A keyboard, unlike a pointer, leaves Mutter in
        // touch mode.
        const seat = global.stage.context.get_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._gesture = new Clutter.PanGesture({
            max_n_points: 1,
            pan_axis: Clutter.PanAxis.X,
        });
        this._gesture.connect('may-recognize', () => this._mayRecognize());
        this._gesture.connect('recognize', () => this._begin());
        this._gesture.connect('pan-update', () => this._update());
        this._gesture.connect('end', () => this._end());
        this._gesture.connect('cancel', () => this._hide());
        global.stage.add_action_full('edge-back',
            Clutter.EventPhase.CAPTURE, this._gesture);
    }

    _mayRecognize() {
        if (Main.actionMode !== Shell.ActionMode.NORMAL || this._arrow)
            return false;
        const begin = this._gesture.get_begin_centroid_abs();
        const now = this._gesture.get_centroid_abs();
        if (now.x <= begin.x)
            return false;
        const index = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({x: begin.x, y: begin.y, width: 1, height: 1}));
        const monitor = Main.layoutManager.monitors[index];
        if (!monitor || begin.x - monitor.x >= EDGE)
            return false;
        const window = this._windowAt(begin.x, begin.y);
        if (window?.get_window_type() !== Meta.WindowType.NORMAL ||
            TERMINALS.has(window.get_wm_class()))
            return false;
        this._window = window;
        this._monitor = monitor;
        return true;
    }

    _windowAt(x, y) {
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (actor && !(actor instanceof Meta.WindowActor))
            actor = actor.get_parent();
        return actor?.get_meta_window() ?? null;
    }

    _begin() {
        const begin = this._gesture.get_begin_centroid_abs();
        this._arrow = new St.Bin({
            style_class: 'edge-back-arrow',
            child: new St.Icon({icon_name: 'go-previous-symbolic'}),
            x: this._monitor.x - ARROW_SIZE,
            y: Math.clamp(begin.y - ARROW_SIZE / 2, this._monitor.y,
                this._monitor.y + this._monitor.height - ARROW_SIZE),
        });
        Main.layoutManager.uiGroup.add_child(this._arrow);
        // Closing the window mid-swipe leaves nothing to go back in
        this._window.connectObject('unmanaging', () => {
            this._window = null;
            this._hide();
        }, this);
        this._update();
    }

    // Measure from where the finger landed: the gesture is only recognized
    // after it has moved a little.
    _update() {
        if (!this._arrow)
            return;
        const distance = this._distance();
        // Follows the finger, slowing down as it comes in
        const travel = MAX_TRAVEL * (1 - Math.exp(-distance / MAX_TRAVEL));
        this._arrow.x = this._monitor.x - ARROW_SIZE + travel;
        if (distance >= DISTANCE_THRESHOLD)
            this._arrow.add_style_class_name('armed');
        else
            this._arrow.remove_style_class_name('armed');
    }

    _distance() {
        const begin = this._gesture.get_begin_centroid_abs();
        return Math.max(0, this._gesture.get_centroid_abs().x - begin.x);
    }

    _end() {
        const velocity = this._gesture.get_velocity_abs().get_x();
        if (this._window &&
            (this._distance() >= DISTANCE_THRESHOLD || velocity > VELOCITY_THRESHOLD))
            this._goBack(this._window);
        this._hide();
    }

    _goBack(window) {
        Main.activateWindow(window);
        const keys = SHORTCUTS.get(window.get_wm_class()) ?? DEFAULT_SHORTCUT;
        const time = GLib.get_monotonic_time();
        for (const key of keys)
            this._keyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED);
        for (const key of [...keys].reverse())
            this._keyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }

    // Slide the arrow back out over the edge.
    _hide() {
        this._window?.disconnectObject(this);
        this._window = null;
        const arrow = this._arrow;
        if (!arrow)
            return;
        this._arrow = null;
        arrow.ease({
            x: this._monitor.x - ARROW_SIZE,
            opacity: 0,
            duration: SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => arrow.destroy(),
        });
    }

    disable() {
        global.stage.remove_action(this._gesture);
        this._gesture = null;
        this._window?.disconnectObject(this);
        this._window = null;
        this._arrow?.destroy();
        this._arrow = null;
        this._keyboard = null;
    }
}
