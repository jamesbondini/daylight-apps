// Maximize every new top-level, resizable app window once it is shown.
// Dialogs and transient windows are left alone.

import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class MaximizeNewWindowsExtension extends Extension {
    enable() {
        this._createdId = global.display.connect('window-created',
            (_display, win) => this._onWindowCreated(win));
    }

    _onWindowCreated(win) {
        const id = win.connect('shown', () => {
            win.disconnect(id);
            if (win.get_window_type() !== Meta.WindowType.NORMAL ||
                win.get_transient_for() ||
                !win.allows_resize() ||
                win.is_fullscreen())
                return;
            win.maximize(Meta.MaximizeFlags.BOTH);
        });
    }

    disable() {
        global.display.disconnect(this._createdId);
    }
}
