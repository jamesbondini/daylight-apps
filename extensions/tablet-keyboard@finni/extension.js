// Replaces GNOME Shell's on-screen keyboard with TabletKeyboard.


import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TabletKeyboard} from './keyboard.js';

// Same as KeyboardManager._syncEnabled(), but with our keyboard class
function syncEnabled(keyboardClass) {
    const enableKeyboard = this._a11yApplicationsSettings.get_boolean('screen-keyboard-enabled');
    const autoEnabled = this._seat.get_touch_mode() && this._lastDeviceIsTouchscreen();
    const enabled = enableKeyboard || autoEnabled;

    if (enabled && !this._keyboard) {
        this._keyboard = new keyboardClass();
        this._keyboard.setSuggestionsVisible(this._suggestionsVisible);
        this._keyboard.connect('visibility-changed', () => {
            this.emit('visibility-changed');
        });
    } else if (!enabled && this._keyboard) {
        destroyKeyboard(this);
    }
}

function destroyKeyboard(manager) {
    const keyboard = manager._keyboard;
    if (!keyboard)
        return;

    // The stock keyboard leaves its swipe-to-dismiss gesture behind
    if (keyboard._panGesture && Main.uiGroup.get_actions().includes(keyboard._panGesture))
        Main.uiGroup.remove_action(keyboard._panGesture);
    keyboard.destroy();
    manager._keyboard = null;
}

function recreate(manager) {
    const wasVisible = manager.visible;
    destroyKeyboard(manager);
    manager._syncEnabled();
    if (wasVisible)
        manager._keyboard?.open();
    manager.emit('visibility-changed');
}

export default class TabletKeyboardExtension extends Extension {
    enable() {
        const manager = Main.keyboard;
        manager._syncEnabled = function () {
            syncEnabled.call(this, TabletKeyboard);
        };
        recreate(manager);
    }

    disable() {
        // Restore the stock keyboard (also used on the lock screen, as
        // extensions are disabled there)
        const manager = Main.keyboard;
        delete manager._syncEnabled;
        recreate(manager);
    }
}

