// Drag a window down by its title bar to pick it up, then to the left or
// right edge to put it on that side of split view, like on an iPad.
// The window shrinks into a card under the finger, and an outline shows
// where it will go. Letting go anywhere else puts it back (and takes a split
// window out of the split).

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// How far down from the top of a window (px) a drag counts as being on its
// title bar. Only downward drags pick a window up, so dragging browser tabs
// sideways or scrolling still works.
const TITLE_BAR = 48;

// How far (px) the finger must move before the drag starts. Apps start
// their own window move once a finger has moved 8 px on the title bar (GTK's
// drag threshold), and whichever is first gets the touch, so this has to be
// less than that. Clutter's default is 16.
const BEGIN_THRESHOLD = 6;

// Share of the screen width at each side where letting go puts the window
// on that side.
const EDGE = 0.2;

const CARD_SCALE = 0.5;
const SHRINK_MS = 150;
const SPRING_MS = 250;

export class TitleBarDrag {
    constructor(split) {
        this._split = split;
        this._side = null;
        this.gesture = new Clutter.PanGesture({
            max_n_points: 1,
            begin_threshold: BEGIN_THRESHOLD,
        });
        this.gesture.connect('may-recognize', () => this._mayRecognize());
        this.gesture.connect('recognize', () => this._begin());
        this.gesture.connect('pan-update', () => this._update());
        this.gesture.connect('end', () => this._end());
        this.gesture.connect('cancel', () => this._springBack());
        global.stage.add_action_full('split-view-drag',
            Clutter.EventPhase.CAPTURE, this.gesture);
    }

    _mayRecognize() {
        if (Main.actionMode !== Shell.ActionMode.NORMAL || this._actor)
            return false;
        const begin = this.gesture.get_begin_centroid_abs();
        const now = this.gesture.get_centroid_abs();
        if (now.y - begin.y <= Math.abs(now.x - begin.x))
            return false;
        const window = this._windowAt(begin.x, begin.y);
        if (window?.get_window_type() !== Meta.WindowType.NORMAL ||
            !window.allows_resize() || window.is_fullscreen())
            return false;
        const frame = window.get_frame_rect();
        if (begin.y < frame.y || begin.y >= frame.y + TITLE_BAR)
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
        // Picking a partner for a half-size window is given up, so it goes
        // back to full screen; if it is the window being dragged, only once
        // it is let go somewhere other than a side.
        const waiting = this._split.closePicker();
        if (waiting && waiting !== this._target)
            waiting.maximize(Meta.MaximizeFlags.BOTH);
        this._waiting = waiting === this._target;
        this._window = this._target;
        this._target = null;
        this._split.stopResizing(this._window);
        // Closing the window ends the drag
        this._window.connectObject('unmanaging', () => this._reset(), this);
        this._setActor(this._window.get_compositor_private());
        if (!this._actor)
            return;
        Main.activateWindow(this._window);

        // Shrink around the point the finger holds, from where the window
        // really is: it may still be easing into place
        const begin = this.gesture.get_begin_centroid_abs();
        this._actor.remove_all_transitions();
        this._actor.set_scale(1, 1);
        this._actor.set_translation(0, 0, 0);
        const [x, y] = this._actor.get_transformed_position();
        this._actor.set_pivot_point(
            (begin.x - x) / this._actor.width, (begin.y - y) / this._actor.height);
        this._actor.ease({
            scale_x: CARD_SCALE,
            scale_y: CARD_SCALE,
            duration: SHRINK_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Below the window, like GNOME's own tile preview
        this._preview = new St.Widget({style_class: 'tile-preview', visible: false});
        global.window_group.insert_child_below(this._preview, this._actor);
        this._update();
    }

    _setActor(actor) {
        this._actor?.disconnectObject(this);
        this._actor = actor;
        actor?.connectObject('destroy', () => {
            this._actor = null;
            this._clearPreview();
        }, this);
    }

    // Measure from where the finger landed: the gesture is only recognized
    // after it has moved a little.
    _update() {
        if (!this._actor)
            return;
        const begin = this.gesture.get_begin_centroid_abs();
        const now = this.gesture.get_centroid_abs();
        this._actor.translation_x = now.x - begin.x;
        this._actor.translation_y = now.y - begin.y;

        const monitor = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({x: now.x, y: now.y, width: 1, height: 1}));
        const side = this._sideAt(now.x, monitor);
        if (side === this._side && monitor === this._monitor)
            return;
        this._side = side;
        this._monitor = monitor;
        this._preview.visible = !!side;
        if (!side)
            return;
        const rect = this._split.rectFor(side, monitor);
        this._preview.set_position(rect.x, rect.y);
        this._preview.set_size(rect.width, rect.height);
    }

    _sideAt(x, index) {
        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return null;
        if (x < monitor.x + monitor.width * EDGE)
            return 'left';
        if (x > monitor.x + monitor.width * (1 - EDGE))
            return 'right';
        return null;
    }

    _end() {
        const window = this._window;
        const side = this._side;
        const monitor = this._monitor;
        if (!window)
            return;
        if (!side || !this._actor) {
            this._springBack();
            this._split.release(window);
            return;
        }
        // The window is resized to its side, growing there from the card,
        // so it can lose the card look straight away.
        const from = this._cardRect();
        this._reset();
        this._split.drop(window, side, monitor, from);
    }

    // Where the window's frame is on screen while it is a card.
    _cardRect() {
        const frame = this._window.get_frame_rect();
        const buffer = this._window.get_buffer_rect();
        const [x, y] = this._actor.get_transformed_position();
        const scale = this._actor.scale_x;
        return {
            x: x + (frame.x - buffer.x) * scale,
            y: y + (frame.y - buffer.y) * scale,
            width: frame.width * scale,
            height: frame.height * scale,
        };
    }

    _springBack() {
        const actor = this._actor;
        if (this._waiting && this._window)
            this._window.maximize(Meta.MaximizeFlags.BOTH);
        this._waiting = false;
        this._clearPreview();
        this._setActor(null);
        this._setWindow(null);
        if (!actor)
            return;
        actor.ease({
            scale_x: 1,
            scale_y: 1,
            translation_x: 0,
            translation_y: 0,
            duration: SPRING_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => actor.set_pivot_point(0, 0),
        });
    }

    _reset() {
        if (this._actor) {
            this._actor.remove_all_transitions();
            this._actor.set_scale(1, 1);
            this._actor.set_translation(0, 0, 0);
            this._actor.set_pivot_point(0, 0);
        }
        this._clearPreview();
        this._setActor(null);
        this._setWindow(null);
        this._waiting = false;
    }

    _setWindow(window) {
        this._window?.disconnectObject(this);
        this._window = window;
    }

    _clearPreview() {
        this._preview?.destroy();
        this._preview = null;
        this._side = null;
        this._monitor = null;
    }

    destroy() {
        global.stage.remove_action(this.gesture);
        this.gesture = null;
        this._reset();
    }
}
