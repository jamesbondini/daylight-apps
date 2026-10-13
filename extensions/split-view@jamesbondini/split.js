// Two windows side by side with a divider between them, like Split View on
// an iPad. Dragging the divider resizes both, snapping to a third, a half or
// two thirds; dragging it to an edge closes that side and the other window
// goes back to full screen.
// Windows are placed by unmaximizing and resizing them: Mutter's own tiling
// only does halves, and its tiled windows can't be resized from a script.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Width of the bar between the two windows, and of the area around it that
// can be dragged.
const GAP = 8;
const HANDLE_WIDTH = 40;

// Where the divider snaps to, as a share of the screen width, and how close
// to an edge it must be let go to close that side.
const SNAPS = [1 / 3, 1 / 2, 2 / 3];
const CLOSE_EDGE = 0.15;

// How long windows take to grow or shrink to their new size, and how long to
// wait for an app to redraw at that size before giving up on animating it.
const RESIZE_MS = 250;
const RESIZE_WAIT_MS = 1000;

// Room around and between the window thumbnails in the picker (the spacing
// in stylesheet.css), and what each thumbnail adds around its picture.
const PICKER_PADDING = 24;
const THUMBNAIL_PADDING = 12;
const TITLE_HEIGHT = 32;

export class SplitView {
    constructor() {
        this._left = null;
        this._right = null;
        this._ratio = 0.5;
        this._monitor = 0;
        this._picker = null;
        this._previews = [];
        this._resizing = new Map();

        this._divider = new St.Widget({
            style_class: 'split-view-divider',
            reactive: true,
            visible: false,
            layout_manager: new Clutter.BinLayout(),
        });
        this._divider.add_child(new St.Widget({
            style_class: 'split-view-bar',
            width: GAP,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._divider.add_child(new St.Widget({
            style_class: 'split-view-handle',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        // Just above the windows, below the top bar and its menus
        Main.layoutManager.uiGroup.insert_child_above(this._divider, global.window_group);

        const gesture = new Clutter.PanGesture({max_n_points: 1, pan_axis: Clutter.PanAxis.X});
        // Where the finger is can't be asked once it has been lifted
        gesture.connect('recognize', () => {
            this._dividerX = gesture.get_centroid_abs().x;
            this._showPreviews();
        });
        gesture.connect('pan-update', () => {
            this._dividerX = gesture.get_centroid_abs().x;
            this._dragDivider(this._dividerX);
        });
        gesture.connect('end', () => this._dropDivider(this._dividerX));
        gesture.connect('cancel', () => this._hidePreviews());
        this._divider.add_action(gesture);

        // Double-tapping the divider swaps the two sides
        const doubleTap = new Clutter.ClickGesture({n_clicks_required: 2});
        doubleTap.connect('recognize', () => this._swap());
        this._divider.add_action(doubleTap);

        global.display.connectObject(
            'notify::focus-window', () => this._raisePair(),
            'restacked', () => this._updateDivider(),
            'workareas-changed', () => {
                if (this._monitor < global.display.get_n_monitors())
                    this._apply();
            },
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._updateDivider(),
            this);
        // The split's monitor may be gone
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._cancelPicker();
            this.end();
        }, this);
        Main.overview.connectObject(
            'showing', () => this._updateDivider(),
            'hidden', () => this._updateDivider(),
            this);
    }

    get active() {
        return !!(this._left && this._right);
    }

    // 'left', 'right' or null
    sideOf(window) {
        if (!this.active)
            return null;
        return window === this._left ? 'left' : window === this._right ? 'right' : null;
    }

    // Where a window dropped on `side` of `monitor` would go.
    rectFor(side, monitor) {
        const ratio = this.active && monitor === this._monitor ? this._ratio : 0.5;
        return this._sideRect(side, monitor, ratio);
    }

    _sideRect(side, monitor, ratio) {
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const mid = Math.round(area.x + area.width * ratio);
        return side === 'left'
            ? {x: area.x, y: area.y, width: mid - GAP / 2 - area.x, height: area.height}
            : {x: mid + GAP / 2, y: area.y, width: area.x + area.width - mid - GAP / 2, height: area.height};
    }

    // A window was dragged by its title bar and let go over one side of
    // `monitor`, where it was shown at `from` on screen.
    drop(window, side, monitor, from) {
        this.closePicker();
        const other = side === 'left' ? 'right' : 'left';

        if (this.active && monitor === this._monitor) {
            const current = this.sideOf(window);
            if (current === other) {
                [this._left, this._right] = [this._right, this._left];
                this._ratio = 1 - this._ratio;
            } else if (!current) {
                // Takes the place of the window on that side
                const replaced = this._get(side);
                this._unwatch(replaced);
                this._set(side, window);
                replaced.maximize(Meta.MaximizeFlags.BOTH);
            }
            this._apply(window, from);
            Main.activateWindow(window);
            return;
        }

        this.end();
        const candidates = this._candidates(window, monitor);
        if (!this._openPicker(window, side, monitor, candidates)) {
            window.maximize(Meta.MaximizeFlags.BOTH);
            return;
        }
        this._place(window, this._sideRect(side, monitor, 0.5), from);
    }

    // A split window was dragged out of the split: both go back to full screen.
    release(window) {
        if (!this.sideOf(window))
            return;
        this.end(window);
    }

    // Close split view, putting the windows back to full screen, with `keep`
    // in front. `closing` is a window that is going away.
    end(keep = null, closing = null) {
        if (!this.active)
            return;
        const windows = [this._left, this._right];
        this._unwatch(this._left);
        this._unwatch(this._right);
        this._left = this._right = null;
        this._updateDivider();
        for (const window of windows) {
            if (window !== closing)
                window.maximize(Meta.MaximizeFlags.BOTH);
        }
        if (keep)
            Main.activateWindow(keep);
    }

    _get(side) {
        return side === 'left' ? this._left : this._right;
    }

    _set(side, window) {
        if (side === 'left')
            this._left = window;
        else
            this._right = window;
        this._watch(window);
    }

    // Other windows on `monitor` the user could put beside `window`, most
    // recently used first.
    _candidates(window, monitor) {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.display.get_tab_list(Meta.TabList.NORMAL, workspace)
            .filter(w => w !== window && !w.minimized &&
                w.get_window_type() === Meta.WindowType.NORMAL && w.allows_resize() &&
                w.get_monitor() === monitor &&
                w.get_compositor_private()?.width > 0 &&
                w.get_compositor_private()?.height > 0);
    }

    // Leaving split view some other way ends it: closing, minimizing or
    // moving either window to another workspace leaves the other in front;
    // maximizing or making one full screen keeps that one in front.
    _watch(window) {
        const endIf = (check, keep) => () => {
            if (check())
                this.end(keep());
        };
        const partner = () => this._partner(window);
        const self = () => window;
        window.connectObject(
            'unmanaging', () => this.end(partner(), window),
            'workspace-changed', endIf(() => true, partner),
            'notify::minimized', endIf(() => window.minimized, partner),
            'notify::fullscreen', endIf(() => window.is_fullscreen(), self),
            'notify::maximized-horizontally', endIf(() => window.get_maximized() !== 0, self),
            'notify::maximized-vertically', endIf(() => window.get_maximized() !== 0, self),
            this);
    }

    _unwatch(window) {
        window?.disconnectObject(this);
    }

    _partner(window) {
        return window === this._left ? this._right : this._left;
    }

    // Put `window` at `rect`, growing or shrinking there from `from` (by
    // default where it is now).
    _place(window, rect, from = window.get_frame_rect()) {
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        if (window.get_maximized())
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        this._animateFrom(window, from, rect);
    }

    // A window jumps to its new size once the app has redrawn at it. Until
    // then, and when it has, it is scaled and moved to look like it is at
    // `from`, and eased from there to where it really is.
    _animateFrom(window, from, rect) {
        this.stopResizing(window);
        const actor = window.get_compositor_private();
        if (!actor)
            return;
        const settle = () => actor.ease({
            scale_x: 1,
            scale_y: 1,
            translation_x: 0,
            translation_y: 0,
            duration: RESIZE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._showAt(window, actor, from);
        const isThere = () => this._isAt(window, rect);
        // Already there, so the app won't redraw
        if (isThere()) {
            settle();
            return;
        }
        // Apps that can't be made as small as asked for never get there
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESIZE_WAIT_MS, () => {
            this._resizing.delete(window);
            window.disconnectObject(actor);
            settle();
            return GLib.SOURCE_REMOVE;
        });
        this._resizing.set(window, {actor, timeoutId});
        const arrived = () => {
            if (!isThere())
                return;
            this.stopResizing(window);
            this._showAt(window, actor, from);
            settle();
        };
        window.connectObject(
            'size-changed', arrived,
            'position-changed', arrived,
            'unmanaging', () => this.stopResizing(window),
            actor);
    }

    // Scale and move the window so its frame shows at `rect` on screen.
    _showAt(window, actor, rect) {
        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        if (frame.width === 0 || frame.height === 0)
            return;
        const scaleX = rect.width / frame.width;
        const scaleY = rect.height / frame.height;
        actor.remove_all_transitions();
        actor.set_pivot_point(0, 0);
        actor.set_scale(scaleX, scaleY);
        actor.set_translation(
            rect.x - buffer.x - (frame.x - buffer.x) * scaleX,
            rect.y - buffer.y - (frame.y - buffer.y) * scaleY, 0);
    }

    _isAt(window, rect) {
        const frame = window.get_frame_rect();
        return ['x', 'y', 'width', 'height']
            .every(key => Math.abs(frame[key] - rect[key]) <= 2);
    }

    // Stop waiting to animate `window`, showing it where it really is.
    stopResizing(window) {
        const resizing = this._resizing.get(window);
        if (!resizing)
            return;
        GLib.source_remove(resizing.timeoutId);
        window.disconnectObject(resizing.actor);
        this._resizing.delete(window);
        resizing.actor.remove_all_transitions();
        resizing.actor.set_scale(1, 1);
        resizing.actor.set_translation(0, 0, 0);
    }

    // `window` animates from `from` rather than from where it is now.
    // Windows already in place are left alone.
    _apply(window = null, from = null) {
        if (!this.active)
            return;
        for (const side of ['left', 'right']) {
            const w = this._get(side);
            const rect = this._sideRect(side, this._monitor, this._ratio);
            if (w === window && from)
                this._place(w, rect, from);
            else if (!this._isAt(w, rect) || w.get_maximized() || w.is_fullscreen())
                this._place(w, rect);
        }
        this._updateDivider();
    }

    _swap() {
        if (!this.active)
            return;
        [this._left, this._right] = [this._right, this._left];
        this._ratio = 1 - this._ratio;
        this._apply();
    }

    // Bringing one split window to the front brings the other with it.
    _raisePair() {
        const focus = global.display.focus_window;
        const partner = this.sideOf(focus) ? this._partner(focus) : null;
        if (!partner || this._pairOnTop())
            return;
        partner.raise();
        focus.raise();
    }

    // Whether the two split windows are in front of every other window.
    _pairOnTop() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = global.display.sort_windows_by_stacking(workspace.list_windows())
            .filter(w => w.get_window_type() === Meta.WindowType.NORMAL &&
                !w.minimized && w.get_monitor() === this._monitor);
        const top = windows.slice(-2);
        return top.includes(this._left) && top.includes(this._right);
    }

    // The divider only shows while the split windows are in front.
    _updateDivider() {
        const show = this.active && !Main.overview.visible && this._pairOnTop();
        this._divider.visible = show;
        if (!show)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(this._monitor);
        this._divider.set_position(
            Math.round(area.x + area.width * this._ratio - HANDLE_WIDTH / 2), area.y);
        this._divider.set_size(HANDLE_WIDTH, area.height);
    }

    // While the divider is dragged, outlines show the size each side will
    // be; the windows are only resized when it is let go.
    _showPreviews() {
        this._hidePreviews();
        for (let i = 0; i < 2; i++) {
            const preview = new St.Widget({style_class: 'tile-preview'});
            Main.layoutManager.uiGroup.insert_child_below(preview, this._divider);
            this._previews.push(preview);
        }
    }

    _hidePreviews() {
        this._previews.forEach(p => p.destroy());
        this._previews = [];
        this._updateDivider();
    }

    _ratioAt(x) {
        const area = Main.layoutManager.getWorkAreaForMonitor(this._monitor);
        return Math.clamp((x - area.x) / area.width, 0, 1);
    }

    _dragDivider(x) {
        if (!this.active || this._previews.length === 0)
            return;
        const ratio = this._ratioAt(x);
        this._divider.x = Math.round(x - HANDLE_WIDTH / 2);
        const sides = ratio < CLOSE_EDGE ? ['right']
            : ratio > 1 - CLOSE_EDGE ? ['left'] : ['left', 'right'];
        const full = this._sideRect('left', this._monitor, 1);
        this._previews.forEach((preview, i) => {
            const side = sides[i];
            preview.visible = !!side;
            if (!side)
                return;
            // A side about to close leaves the other filling the screen
            const rect = sides.length === 1
                ? {...full, width: full.width + GAP / 2}
                : this._sideRect(side, this._monitor, ratio);
            preview.set_position(rect.x, rect.y);
            preview.set_size(rect.width, rect.height);
        });
    }

    _dropDivider(x) {
        this._previews.forEach(p => p.destroy());
        this._previews = [];
        if (!this.active)
            return;
        const ratio = this._ratioAt(x);
        if (ratio < CLOSE_EDGE) {
            this.end(this._right);
        } else if (ratio > 1 - CLOSE_EDGE) {
            this.end(this._left);
        } else {
            this._ratio = SNAPS.reduce((best, s) =>
                Math.abs(s - ratio) < Math.abs(best - ratio) ? s : best);
            this._apply();
        }
    }

    // Thumbnails of the other windows fill the empty side; tapping one puts
    // it there. Tapping elsewhere, or going to another window or workspace,
    // puts `window` back to full screen.
    // Returns false if there are none, or no room to show them.
    _openPicker(window, side, monitor, candidates) {
        if (candidates.length === 0)
            return false;
        const other = side === 'left' ? 'right' : 'left';
        const rect = this._sideRect(other, monitor, 0.5);
        const picker = new St.Widget({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            layout_manager: new Clutter.BinLayout(),
        });
        const backdrop = new St.Button({
            style_class: 'split-view-picker',
            x_expand: true,
            y_expand: true,
        });
        backdrop.connect('clicked', () => this._cancelPicker());
        picker.add_child(backdrop);

        const box = new St.BoxLayout({
            style_class: 'split-view-thumbnails',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        picker.add_child(box);

        // In as many columns as makes the thumbnails largest, so they all fit
        const n = candidates.length;
        const sources = candidates.map(c => c.get_compositor_private());
        let best = {scale: 0};
        for (let columns = 1; columns <= n; columns++) {
            const rows = Math.ceil(n / columns);
            const width = (rect.width - PICKER_PADDING * (columns + 1)) / columns -
                THUMBNAIL_PADDING;
            const height = (rect.height - PICKER_PADDING * (rows + 1)) / rows -
                THUMBNAIL_PADDING - TITLE_HEIGHT;
            const scale = Math.min(...sources.map(s =>
                Math.min(width / s.width, height / s.height)));
            if (scale > best.scale)
                best = {scale, columns, width, height};
        }
        if (!best.columns) {
            picker.destroy();
            return false;
        }

        let row = null;
        candidates.forEach((candidate, i) => {
            if (i % best.columns === 0) {
                row = new St.BoxLayout({
                    style_class: 'split-view-thumbnails',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                box.add_child(row);
            }
            const source = sources[i];
            const scale = Math.max(0, Math.min(best.width / source.width,
                best.height / source.height));
            const width = Math.round(source.width * scale);
            const button = new St.Button({
                style_class: 'split-view-thumbnail',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
            content.add_child(new Clutter.Clone({
                source,
                width,
                height: Math.round(source.height * scale),
            }));
            const title = new St.Label({
                style_class: 'split-view-title',
                text: candidate.get_title() ?? '',
                width,
            });
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            content.add_child(title);
            button.set_child(content);
            button.connect('clicked', () => {
                this.closePicker();
                this._monitor = monitor;
                this._ratio = 0.5;
                this._set(side, window);
                this._set(other, candidate);
                this._apply();
                Main.activateWindow(candidate);
            });
            row.add_child(button);

            // A window that goes away can't be picked; with none left there
            // is nothing to pick
            const remove = () => {
                candidate.disconnectObject(picker);
                button.destroy();
                if (--this._pickerCount === 0)
                    this._cancelPicker();
            };
            candidate.connectObject(
                'unmanaging', remove,
                'workspace-changed', remove,
                'notify::minimized', () => {
                    if (candidate.minimized)
                        remove();
                },
                picker);
        });

        Main.layoutManager.uiGroup.insert_child_above(picker, global.window_group);
        this._picker = picker;
        this._pickerWindow = window;
        this._pickerCandidates = candidates;
        this._pickerCount = candidates.length;

        // Anything else happening to the window, or the user going somewhere
        // else, cancels picking.
        window.connectObject(
            'unmanaging', () => this.closePicker(),
            'workspace-changed', () => this._cancelPicker(),
            'notify::minimized', () => this.closePicker(),
            'notify::maximized-horizontally', () => this.closePicker(),
            'notify::maximized-vertically', () => this.closePicker(),
            'notify::fullscreen', () => this.closePicker(),
            picker);
        Main.overview.connectObject('showing', () => this._cancelPicker(), picker);
        // Don't leave copies of windows on screen behind the lock screen
        Main.sessionMode.connectObject('updated', () => {
            if (Main.sessionMode.isLocked)
                this._cancelPicker();
        }, picker);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._cancelPicker(), picker);
        global.display.connectObject('notify::focus-window', () => {
            const focus = global.display.focus_window;
            if (focus && focus !== window)
                this._cancelPicker();
        }, picker);
        return true;
    }

    // Close the picker, if open, and return the window that was waiting for
    // a partner.
    closePicker() {
        if (!this._picker)
            return null;
        const window = this._pickerWindow;
        window.disconnectObject(this._picker);
        this._pickerCandidates.forEach(c => c.disconnectObject(this._picker));
        Main.overview.disconnectObject(this._picker);
        Main.sessionMode.disconnectObject(this._picker);
        global.workspace_manager.disconnectObject(this._picker);
        global.display.disconnectObject(this._picker);
        this._picker.destroy();
        this._picker = null;
        this._pickerWindow = null;
        this._pickerCandidates = null;
        return window;
    }

    // Close the picker and put its window back to full screen.
    _cancelPicker() {
        const window = this.closePicker();
        if (window)
            window.maximize(Meta.MaximizeFlags.BOTH);
    }

    // Stays enabled on the lock screen (see metadata.json), so this only
    // runs when turned off, and the windows go back to full screen.
    destroy() {
        for (const window of [...this._resizing.keys()])
            this.stopResizing(window);
        this._cancelPicker();
        this._hidePreviews();
        this.end();
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._divider.destroy();
        this._divider = null;
    }
}
