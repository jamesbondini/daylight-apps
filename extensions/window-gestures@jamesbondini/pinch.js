// Pinch five fingers together to close the window under them, like on an iPad.
// The window shrinks and fades with the fingers; letting go once they have
// closed in far enough closes it, otherwise it springs back.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FINGERS = 5;

// Spread of the fingers relative to when the fifth landed: the pinch starts
// below START, closes the window when let go below CLOSE, and spreading out
// past CANCEL means it isn't a pinch.
const START = 0.92;
const CLOSE = 0.6;
const CANCEL = 1.15;

// How small and faint the window gets at the close point.
const MIN_SCALE = 0.6;
const MIN_OPACITY = 128;

// Fewer than five fingers moving this far (px) are doing something else,
// such as a four-finger swipe, so it isn't a pinch.
const SETTLE = 30;

const SPRING_MS = 250;
const FADE_MS = 120;

// An app may ask to save first, or not answer at all; bring the window back
// if it is still there after this long.
const RESTORE_MS = 1000;

// Clutter has no pinch gesture. This one recognizes exactly five touches
// closing in on their centre; `scale` is their spread relative to the start.
const PinchGesture = GObject.registerClass({
    Signals: {'update': {}},
}, class PinchGesture extends Clutter.Gesture {
    vfunc_should_handle_sequence(event) {
        return event.type() === Clutter.EventType.TOUCH_BEGIN;
    }

    _init(params) {
        super._init(params);
        this.scale = 1;
        this._startSpread = 0;
    }

    vfunc_point_began() {
        const n = this.get_n_points();
        if (n === 1) {
            this.scale = 1;
            this._startSpread = 0;
        }
        if (n > FINGERS)
            this.set_state(Clutter.GestureState.CANCELLED);
        else if (n === FINGERS)
            this._startSpread = this._spread();
    }

    vfunc_point_moved() {
        if (this.get_n_points() < FINGERS && this.state === Clutter.GestureState.POSSIBLE &&
            this._moved() > SETTLE) {
            this.set_state(Clutter.GestureState.CANCELLED);
            return;
        }
        if (this.get_n_points() !== FINGERS || !this._startSpread)
            return;
        this.scale = this._spread() / this._startSpread;
        if (this.state === Clutter.GestureState.POSSIBLE) {
            if (this.scale < START)
                this.set_state(Clutter.GestureState.RECOGNIZING);
            else if (this.scale > CANCEL)
                this.set_state(Clutter.GestureState.CANCELLED);
        } else if (this.state === Clutter.GestureState.RECOGNIZING) {
            this.emit('update');
        }
    }

    // The first finger to lift ends the pinch.
    vfunc_point_ended() {
        this.set_state(this.state === Clutter.GestureState.RECOGNIZING
            ? Clutter.GestureState.COMPLETED : Clutter.GestureState.CANCELLED);
    }

    // Centre of the touches.
    centroid() {
        const points = this.get_points().map(i => this.get_point_coords_abs(i));
        return {
            x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
            y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
        };
    }

    // Mean distance of the touches from their centre.
    _spread() {
        const {x, y} = this.centroid();
        const points = this.get_points().map(i => this.get_point_coords_abs(i));
        return points.reduce((sum, p) => sum + Math.hypot(p.x - x, p.y - y), 0) /
            points.length;
    }

    // Furthest any touch has moved from where it landed.
    _moved() {
        return Math.max(...this.get_points().map(i => {
            const now = this.get_point_coords_abs(i);
            const begin = this.get_point_begin_coords_abs(i);
            return Math.hypot(now.x - begin.x, now.y - begin.y);
        }));
    }
});

export class PinchToClose {
    // `isBusy` says whether the window switcher is moving windows.
    constructor(isBusy) {
        this._isBusy = isBusy;
        this._restoreId = 0;
        this._closing = false;
        this.gesture = new PinchGesture();
        this.gesture.connect('may-recognize', () => this._mayRecognize());
        this.gesture.connect('recognize', () => this._begin());
        this.gesture.connect('update', () => this._update());
        this.gesture.connect('end', () => this._end());
        // The gesture can report a cancel after its end; the window is
        // closing by then and must not spring back.
        this.gesture.connect('cancel', () => {
            if (!this._closing)
                this._springBack();
        });
        global.stage.add_action_full('window-gestures-pinch',
            Clutter.EventPhase.CAPTURE, this.gesture);
    }

    // Whether a window is shrunk, closing or springing back.
    get busy() {
        return !!this._actor;
    }

    _mayRecognize() {
        if (Main.actionMode !== Shell.ActionMode.NORMAL || this._isBusy())
            return false;
        const {x, y} = this.gesture.centroid();
        const window = this._windowAt(x, y);
        if (window?.get_window_type() !== Meta.WindowType.NORMAL ||
            !window.can_close())
            return false;
        this._target = window;
        return true;
    }

    _windowAt(x, y) {
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (actor && !(actor instanceof Meta.WindowActor))
            actor = actor.get_parent();
        return actor?.get_meta_window() ?? null;
    }

    _begin() {
        // The window from the last pinch may still be waiting to close.
        this._springBack();
        this._setWindow(this._target);
        this._target = null;
        this._setActor(this._window.get_compositor_private());
        if (!this._actor)
            return;
        this._actor.remove_all_transitions();
        this._actor.set_pivot_point(0.5, 0.5);
    }

    _setActor(actor) {
        this._actor?.disconnectObject(this);
        this._actor = actor;
        actor?.connectObject('destroy', () => {
            this._actor = null;
        }, this);
    }

    _update() {
        if (!this._actor)
            return;
        // 0 when the pinch starts, 1 at the close point
        const progress = Math.clamp((1 - this.gesture.scale) / (1 - CLOSE), 0, 1);
        this._actor.set_scale(1 - progress * (1 - MIN_SCALE), 1 - progress * (1 - MIN_SCALE));
        this._actor.opacity = 255 - progress * (255 - MIN_OPACITY);
    }

    _end() {
        const window = this._window;
        if (this.gesture.scale > CLOSE || !window || !this._actor) {
            this._springBack();
            return;
        }
        // GNOME's close animation grows the window to 80%, the opposite of
        // the pinch, so carry on shrinking it out of sight first; that
        // animation then runs on an invisible window.
        this._closing = true;
        this._actor.ease({
            scale_x: this._actor.scale_x * 0.8,
            scale_y: this._actor.scale_y * 0.8,
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                // Stopped early by another pinch, which sprang it back.
                if (!finished || this._window !== window)
                    return;
                window.delete(global.get_current_time());
                this._restoreId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_MS, () => {
                    this._restoreId = 0;
                    this._springBack();
                    return GLib.SOURCE_REMOVE;
                });
            },
        });
    }

    _springBack() {
        this._clearRestore();
        this._closing = false;
        const actor = this._actor;
        this._setActor(null);
        this._setWindow(null);
        if (!actor)
            return;
        actor.ease({
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: SPRING_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => actor.set_pivot_point(0, 0),
        });
    }

    // Once the window closes there is nothing to bring back; GNOME's close
    // animation takes over its actor.
    _setWindow(window) {
        this._window?.disconnectObject(this);
        this._window = window;
        window?.connectObject('unmanaging', () => {
            this._clearRestore();
            this._closing = false;
            this._setActor(null);
            this._setWindow(null);
        }, this);
    }

    _clearRestore() {
        if (this._restoreId)
            GLib.source_remove(this._restoreId);
        this._restoreId = 0;
    }

    destroy() {
        this._clearRestore();
        this._closing = false;
        global.stage.remove_action(this.gesture);
        this.gesture = null;
        if (this._actor) {
            this._actor.remove_all_transitions();
            this._actor.set_scale(1, 1);
            this._actor.opacity = 255;
            this._actor.set_pivot_point(0, 0);
        }
        this._setActor(null);
        this._setWindow(null);
    }
}
