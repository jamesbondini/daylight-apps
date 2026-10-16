// Swipe four fingers left or right to switch windows, like on an iPad.
// The focused window follows the fingers over the wallpaper with its
// neighbour sliding in beside it; lifting past a quarter of the screen (or
// with a flick) switches to it.
// Windows on the current workspace are in the order they were opened, so
// repeated swipes walk through them all and wrap around at the ends.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME's own touch swipes use three fingers (workspaces), and Two-Finger
// Scroll two, so four is free. Fingers rarely land together, though: three
// moving sideways before the fourth lands still swipe workspaces.
const FINGERS = 4;

// Switch when the fingers travel this share of the screen, or flick faster
// than this (px/ms, the speed GNOME's swipes use).
const DISTANCE_THRESHOLD = 0.25;
const VELOCITY_THRESHOLD = 0.3;

// A gap between the two windows while they slide, and how much a swipe with
// no other window to go to moves before resisting.
const GAP = 24;
const RUBBER_BAND = 0.2;

const SLIDE_MS = 250;

// Give up waiting for the switched-to window to come to the front after this.
const HANDOFF_MS = 300;

export class WindowSwitcher {
    // `isBusy` says whether a pinch is shrinking or closing a window.
    constructor(isBusy) {
        this._isBusy = isBusy;
        this._clones = [];
        this.gesture = new Clutter.PanGesture({
            min_n_points: FINGERS,
            max_n_points: FINGERS,
            pan_axis: Clutter.PanAxis.X,
        });
        this.gesture.connect('may-recognize', () => this._mayRecognize());
        this.gesture.connect('recognize', () => this._begin());
        this.gesture.connect('pan-update', () => this._update());
        this.gesture.connect('end', () => this._end());
        this.gesture.connect('cancel', () => this._slideTo(0, null));
        global.stage.add_action_full('window-gestures-switch',
            Clutter.EventPhase.CAPTURE, this.gesture);
    }

    // Whether a swipe is under way.
    get busy() {
        return !!this._window;
    }

    _mayRecognize() {
        if (Main.actionMode !== Shell.ActionMode.NORMAL || this._animating || this._isBusy())
            return false;
        const window = global.display.focus_window;
        return window?.get_window_type() === Meta.WindowType.NORMAL &&
            window.get_compositor_private() !== null;
    }

    // Windows the user would switch between: on this workspace and monitor,
    // not minimized, not hidden from the taskbar.
    _windows(current) {
        const workspace = global.workspace_manager.get_active_workspace();
        return workspace.list_windows()
            .filter(w => w === current ||
                (w.get_window_type() === Meta.WindowType.NORMAL &&
                 !w.minimized && !w.skip_taskbar &&
                 w.get_monitor() === current.get_monitor()))
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }

    _begin() {
        const window = global.display.focus_window;
        this._window = window;
        this._actor = window.get_compositor_private();
        this._destroyId = this._actor.connect('destroy', () => {
            this._actor = null;
        });
        this._offset = 0;

        const monitorIndex = window.get_monitor();
        const monitor = Main.layoutManager.monitors[monitorIndex];
        this._width = monitor.width;

        const windows = this._windows(window);
        const i = windows.indexOf(window);
        const n = windows.length;
        // Swiping left (negative) brings in the next window from the right.
        this._next = n > 1 ? windows[(i + 1) % n] : null;
        this._prev = n > 1 ? windows[(i - 1 + n) % n] : null;
        // A neighbour that closes mid-swipe can't be switched to
        for (const neighbour of new Set([this._next, this._prev])) {
            neighbour?.connectObject('unmanaging', () => {
                if (this._next === neighbour)
                    this._next = null;
                if (this._prev === neighbour)
                    this._prev = null;
            }, this);
        }

        // Clones of the window and its neighbours slide over a backdrop of
        // the wallpaper, which hides the windows stacked behind. Moving the
        // real actors would fight Mutter's stacking.
        this._backdrop = new Clutter.Actor({
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            background_color: new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 255}),
        });
        const wallpaper = Main.layoutManager._bgManagers?.[monitorIndex]?.backgroundActor;
        if (wallpaper)
            this._backdrop.add_child(new Clutter.Clone({source: wallpaper}));
        Main.layoutManager.uiGroup.insert_child_above(this._backdrop, global.window_group);

        for (const [target, side] of [[window, 0], [this._next, 1], [this._prev, -1]]) {
            if (!target)
                continue;
            const source = target.get_compositor_private();
            if (!source)
                continue;
            const clone = new Clutter.Clone({
                source,
                x: source.x + side * (this._width + GAP),
                y: source.y,
            });
            Main.layoutManager.uiGroup.insert_child_above(clone, this._backdrop);
            this._clones.push(clone);
        }
    }

    // The swipe may only be recognized once a possible pinch has given up,
    // so measure from where the fingers landed rather than adding up moves.
    _update() {
        const begin = this.gesture.get_begin_centroid_abs();
        this._offset = this.gesture.get_centroid_abs().x - begin.x;
        this._apply(this._offset);
    }

    // With no window to go to, the window resists like a rubber band.
    _apply(offset) {
        const target = offset < 0 ? this._next : this._prev;
        const shown = target ? offset : offset * RUBBER_BAND;
        for (const clone of this._clones)
            clone.translation_x = shown;
    }

    _end() {
        const velocity = this.gesture.get_velocity_abs().get_x();
        const flick = Math.abs(velocity) > VELOCITY_THRESHOLD &&
            Math.sign(velocity) === Math.sign(this._offset);
        const far = Math.abs(this._offset) > this._width * DISTANCE_THRESHOLD;
        const target = this._offset < 0 ? this._next : this._prev;
        if (target && (far || flick))
            this._slideTo(-Math.sign(this._offset) * (this._width + GAP), target);
        else
            this._slideTo(0, null);
    }

    // Animate to the final position, then switch to `target` (if any) and
    // put everything back where it was.
    // The gesture can report a cancel after its end. Easing back then would
    // bounce the window back, and stopping the first slide would still switch.
    _slideTo(offset, target) {
        if (!this._window || this._animating)
            return;
        this._animating = true;
        if (this._clones.length === 0) {
            this._finish(target);
            return;
        }
        let pending = this._clones.length;
        for (const clone of this._clones) {
            clone.ease({
                translation_x: offset,
                duration: SLIDE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: () => {
                    if (--pending === 0)
                        this._finish(target);
                },
            });
        }
    }

    _finish(target) {
        if (!this._window || this._restackedId)
            return;
        if (!target || (target !== this._next && target !== this._prev)) {
            this._reset();
            return;
        }
        // The window only comes to the front at a later restack. Removing the
        // clones before then would show the old window for a frame, then the
        // new one replacing its clone.
        // Restacks for other reasons can come first, so check the order.
        this._restackedId = global.display.connect('restacked', () => {
            if (this._isAbove(target))
                this._reset();
        });
        this._handoffId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HANDOFF_MS, () => {
            this._handoffId = 0;
            this._reset();
            return GLib.SOURCE_REMOVE;
        });
        Main.activateWindow(target);
    }

    // Whether `target` is now drawn above the window we swiped away.
    _isAbove(target) {
        const above = target.get_compositor_private();
        if (!above || !this._actor)
            return true;
        const actors = global.window_group.get_children();
        return actors.indexOf(above) > actors.indexOf(this._actor);
    }

    // Clear the state first: stopping the transitions calls _finish again.
    _reset() {
        const actor = this._actor;
        const clones = this._clones;
        const backdrop = this._backdrop;
        this._clones = [];
        this._backdrop = null;
        this._actor = null;
        this._window = null;
        this._next?.disconnectObject(this);
        this._prev?.disconnectObject(this);
        this._next = null;
        this._prev = null;
        this._animating = false;
        if (this._restackedId)
            global.display.disconnect(this._restackedId);
        this._restackedId = 0;
        if (this._handoffId)
            GLib.source_remove(this._handoffId);
        this._handoffId = 0;
        actor?.disconnect(this._destroyId);
        for (const clone of clones)
            clone.destroy();
        backdrop?.destroy();
    }

    destroy() {
        global.stage.remove_action(this.gesture);
        this.gesture = null;
        this._reset();
    }
}
