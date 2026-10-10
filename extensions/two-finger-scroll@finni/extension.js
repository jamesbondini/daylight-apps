// Drag two fingers over a terminal window to scroll it, like on a touchpad.
// Terminals don't scroll on touch (a one-finger drag selects text), so the
// drag is claimed from the app and replayed as smooth scroll events from a
// virtual pointer, followed by a short momentum glide after the fingers lift.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Wayland app ids (Meta.Window wm_class) of apps that get two-finger
// scrolling, with the finger movement in pixels that makes one scroll unit so
// the text follows the fingers (measured; Wayland scroll units are meant to
// be pixels, but Ghostty multiplies them by 10 and VTE scrolls 2.5 px each).
// Apps with their own touch handling (browsers, GTK lists) are left alone.
const TERMINALS = new Map([
    ['com.mitchellh.ghostty', 7],
    ['org.gnome.Console', 2.5],
    ['org.gnome.Terminal', 2.5],
    ['org.gnome.Ptyxis', 2.5],
    ['kitty', 1],
    ['foot', 1],
    ['Alacritty', 1],
    ['org.wezfurlong.wezterm', 1],
]);

// Momentum: start above this speed (px/ms), decay per ms like GNOME's swipes,
// stop below the end speed.
const MOMENTUM_MIN_VELOCITY = 0.3;
const MOMENTUM_END_VELOCITY = 0.02;
const DECELERATION = 0.997;
const FRAME_MS = 16;

// Ghostty counts a click within a cell width of the previous one as a double
// click, which selects a word. Keep our click at least this far away.
const CLICK_CLEARANCE = 64;

// Wayland apps only get scroll events through a pointer, so the scrolls come
// from a virtual one. Any pointer device takes Mutter out of touch mode, which
// hides the on-screen keyboard and the Auto Rotate toggle, so the shell is
// told to ignore it below. It is created once and never unplugged: back in
// touch mode, Mutter re-applies its own stale screen rotation, which is
// upside down on the DC-1.
let virtualPointer = null;

function isPointer(device) {
    return device.device_type === Clutter.InputDeviceType.POINTER_DEVICE ||
        device.device_type === Clutter.InputDeviceType.TOUCHPAD_DEVICE;
}

// Virtual devices have no device node
function isVirtualPointer(device) {
    return isPointer(device) && device.get_device_node() === null;
}

function getVirtualPointer() {
    if (virtualPointer)
        return virtualPointer;

    // Touch mode as if the virtual pointer weren't there
    const seat = global.stage.context.get_backend().get_default_seat();
    seat.get_touch_mode = () => {
        if (Clutter.Seat.prototype.get_touch_mode.call(seat))
            return true;
        const devices = seat.list_devices();
        return devices.some(d => d.device_type === Clutter.InputDeviceType.TOUCHSCREEN_DEVICE) &&
            !devices.some(d => isPointer(d) && !isVirtualPointer(d));
    };

    // Mutter only manages rotation in touch mode, and the Auto Rotate toggle
    // only shows when it does. The DC-1 rotates the screen itself, following
    // the toggle's setting.
    const monitorManager = global.backend.get_monitor_manager();
    const orientationManager = global.backend.get_orientation_manager();
    monitorManager.get_panel_orientation_managed = () =>
        Meta.MonitorManager.prototype.get_panel_orientation_managed.call(monitorManager) ||
        (seat.get_touch_mode() && orientationManager.has_accelerometer() &&
         monitorManager.get_is_builtin_display_on());

    // The keyboard comes up after a touch; decide on the last real device,
    // not on the virtual pointer after a scroll.
    let lastWasTouch = true;
    Main.keyboard._lastDeviceIsTouchscreen = function () {
        const device = this._lastDevice;
        if (device && !isVirtualPointer(device))
            lastWasTouch = device.device_type === Clutter.InputDeviceType.TOUCHSCREEN_DEVICE;
        return lastWasTouch;
    };

    virtualPointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    return virtualPointer;
}

export default class TwoFingerScrollExtension extends Extension {
    enable() {
        this._pointer = getVirtualPointer();
        this._cursorTracker = global.backend.get_cursor_tracker();
        this._lastX = -1;
        this._lastY = -1;
        this._momentumId = 0;

        // Vertical only: Ghostty switches tabs on horizontal touchpad scrolls.
        this._gesture = new Clutter.PanGesture({
            min_n_points: 2,
            max_n_points: 2,
            pan_axis: Clutter.PanAxis.Y,
        });
        this._gesture.connect('may-recognize', () => this._mayRecognize());
        this._gesture.connect('recognize', () => this._begin());
        this._gesture.connect('pan-update', () => this._update());
        this._gesture.connect('end', () => this._end());
        this._gesture.connect('cancel', () => this._finish());
        global.stage.add_action_full('two-finger-scroll',
            Clutter.EventPhase.CAPTURE, this._gesture);

        // Any new touch stops a momentum glide, like on a phone.
        this._touchId = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN)
                this._stopMomentum();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _mayRecognize() {
        if (Main.actionMode !== Shell.ActionMode.NORMAL)
            return false;
        const {x, y} = this._gesture.get_begin_centroid_abs();
        this._window = this._windowAt(x, y);
        this._pixelsPerUnit = TERMINALS.get(this._window?.get_wm_class());
        return this._pixelsPerUnit !== undefined;
    }

    _windowAt(x, y) {
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (actor && !(actor instanceof Meta.WindowActor))
            actor = actor.get_parent();
        return actor?.get_meta_window() ?? null;
    }

    _begin() {
        this._stopMomentum();
        const {x, y} = this._gesture.get_begin_centroid_abs();

        // The app saw the first touch as a mouse press, and only gets a touch
        // cancel instead of the release, so it may still think the button is
        // down and select text while scrolling. A click ends that press.
        let clickX = x;
        if (Math.hypot(x - this._lastX, y - this._lastY) < CLICK_CLEARANCE) {
            const rect = this._window.get_frame_rect();
            clickX += x < rect.x + rect.width / 2 ? CLICK_CLEARANCE : -CLICK_CLEARANCE;
        }
        // The first motion only enters the window; Ghostty takes the click
        // position from the second.
        this._moveTo(clickX + 1, y);
        this._moveTo(clickX, y);
        this._pointer.notify_button(this._now(), Clutter.BUTTON_PRIMARY,
            Clutter.ButtonState.PRESSED);
        this._pointer.notify_button(this._now(), Clutter.BUTTON_PRIMARY,
            Clutter.ButtonState.RELEASED);

        this._x = x;
        this._y = y;
    }

    _update() {
        const [delta] = this._gesture.get_delta_abs();
        this._scroll(-delta.get_y());
    }

    _end() {
        let velocity = -this._gesture.get_velocity_abs().get_y();
        if (Math.abs(velocity) < MOMENTUM_MIN_VELOCITY) {
            this._finish();
            return;
        }

        let last = GLib.get_monotonic_time();
        this._momentumId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            const now = GLib.get_monotonic_time();
            const ms = (now - last) / 1000;
            last = now;
            velocity *= DECELERATION ** ms;
            if (Math.abs(velocity) < MOMENTUM_END_VELOCITY) {
                this._momentumId = 0;
                this._finish();
                return GLib.SOURCE_REMOVE;
            }
            this._scroll(velocity * ms);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Scroll events go to the surface under the pointer, so keep it at the
    // fingers. Each touch event takes pointer focus away from the app while
    // the shell holds the touches, and only pointer motion gives it back.
    // Touch hid the cursor; keep it hidden.
    _moveTo(x, y) {
        this._pointer.notify_absolute_motion(this._now(), x, y);
        this._cursorTracker.set_pointer_visible(false);
        this._lastX = x;
        this._lastY = y;
    }

    _scroll(dy) {
        this._moveTo(this._x, this._y);
        this._pointer.notify_scroll_continuous(this._now(),
            0, dy / this._pixelsPerUnit,
            Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
    }

    // Tell the app the scroll is over, so it doesn't add its own momentum.
    _finish() {
        this._moveTo(this._x, this._y);
        this._pointer.notify_scroll_continuous(this._now(), 0, 0,
            Clutter.ScrollSource.FINGER,
            Clutter.ScrollFinishFlags.HORIZONTAL | Clutter.ScrollFinishFlags.VERTICAL);
    }

    _stopMomentum() {
        if (!this._momentumId)
            return;
        GLib.source_remove(this._momentumId);
        this._momentumId = 0;
        this._finish();
    }

    _now() {
        return GLib.get_monotonic_time();
    }

    disable() {
        this._stopMomentum();
        global.stage.disconnect(this._touchId);
        global.stage.remove_action(this._gesture);
        this._gesture = null;
        this._pointer = null;
        this._cursorTracker = null;
        this._window = null;
    }
}
