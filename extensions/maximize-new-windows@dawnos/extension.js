// Maximize every new top-level, resizable app window once it is shown.
// Dialogs and transient windows are left alone.

import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class MaximizeNewWindowsExtension extends Extension {
    enable() {
        // Windows created but not shown yet, with their signal handler ids
        this._pending = new Map();
        this._createdId = global.display.connect('window-created',
            (_display, win) => this._onWindowCreated(win));
    }

    _onWindowCreated(win) {
        this._pending.set(win, [
            win.connect('shown', () => {
                this._forget(win);
                if (win.get_window_type() !== Meta.WindowType.NORMAL ||
                    win.get_transient_for() ||
                    !win.allows_resize() ||
                    win.is_fullscreen())
                    return;
                win.maximize(Meta.MaximizeFlags.BOTH);
            }),
            win.connect('unmanaged', () => this._forget(win)),
        ]);
    }

    _forget(win) {
        this._pending.get(win)?.forEach(id => win.disconnect(id));
        this._pending.delete(win);
    }

    disable() {
        global.display.disconnect(this._createdId);
        this._createdId = 0;
        for (const win of [...this._pending.keys()])
            this._forget(win);
        this._pending = null;
    }
}
