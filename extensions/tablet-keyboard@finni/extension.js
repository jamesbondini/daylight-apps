// Replaces GNOME Shell's on-screen keyboard with TabletKeyboard.
//
// KeyboardManager creates and destroys its keyboard whenever touch mode or the
// a11y setting changes, from handlers bound at startup. We listen to the same
// signals (connected later, so we run after it) and swap any stock keyboard it
// created for ours.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TabletKeyboard, setExtension} from './keyboard.js';

function destroyKeyboard(manager) {
    const keyboard = manager._keyboard;
    if (!keyboard)
        return;

    // The stock keyboard leaves its swipe-to-dismiss gesture behind
    if (Main.uiGroup.get_actions().includes(keyboard._panGesture))
        Main.uiGroup.remove_action(keyboard._panGesture);
    keyboard.destroy();
    manager._keyboard = null;
}

export default class TabletKeyboardExtension extends Extension {
    enable() {
        setExtension(this);
        const manager = Main.keyboard;
        const sync = () => this._replaceStockKeyboard();

        manager._a11yApplicationsSettings.connectObject('changed', sync, this);
        manager._seat.connectObject('notify::touch-mode', sync, this);
        global.backend.connectObject('last-device-changed', sync, this);

        this._replaceStockKeyboard();
    }

    disable() {
        const manager = Main.keyboard;
        manager._a11yApplicationsSettings.disconnectObject(this);
        manager._seat.disconnectObject(this);
        global.backend.disconnectObject(this);

        // Hand back to the stock keyboard (also what the lock screen uses,
        // since extensions are disabled there)
        if (manager._keyboard instanceof TabletKeyboard) {
            const wasVisible = manager.visible;
            destroyKeyboard(manager);
            manager._syncEnabled();
            if (wasVisible)
                manager._keyboard?.open();
            manager.emit('visibility-changed');
        }
        setExtension(null);
    }

    _replaceStockKeyboard() {
        const manager = Main.keyboard;
        const stock = manager._keyboard;
        if (!stock || stock instanceof TabletKeyboard)
            return;

        const wasVisible = manager.visible;
        destroyKeyboard(manager);

        const keyboard = new TabletKeyboard();
        keyboard.setSuggestionsVisible(manager._suggestionsVisible);
        keyboard.connect('visibility-changed', () => manager.emit('visibility-changed'));
        manager._keyboard = keyboard;

        if (wasVisible)
            keyboard.open();
        manager.emit('visibility-changed');
    }
}
