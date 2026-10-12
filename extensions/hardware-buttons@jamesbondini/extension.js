// Actions for the DC-1's two programmable buttons, which send XF86Launch1 and
// XF86Launch2. Each button has one action for a press and one for a hold.
//
// Mutter keybindings only see the key going down, so on a press we take a
// short modal grab to catch the release: released before the hold time is a
// press, still down at the hold time is a hold (which fires right away).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUTTONS = ['button1', 'button2'];

const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;

function toggleSetting(schema, key) {
    const settings = new Gio.Settings({schema_id: schema});
    settings.set_boolean(key, !settings.get_boolean(key));
    return settings.get_boolean(key);
}

function osd(icon, label) {
    Main.osdWindowManager.show(-1, Gio.ThemedIcon.new(icon), label, null, null);
}

// Keep the names in sync with ACTIONS in apps/hardware-buttons/page.py
const ACTIONS = {
    'overview': () => Main.overview.toggle(),
    'app-grid': () => {
        // showApps() does nothing while the overview is already open
        const button = Main.overview.dash.showAppsButton;
        if (!Main.overview.visible)
            Main.overview.showApps();
        else if (button.checked)
            Main.overview.hide();
        else
            button.checked = true;
    },
    'keyboard': () => {
        if (Main.keyboard.visible)
            Main.keyboard.close();
        else if (Main.keyboard.keyboardActor)
            Main.keyboard.open(Main.layoutManager.primaryIndex);
        else
            osd('input-keyboard-symbolic', 'On-screen keyboard is off');
    },
    'screenshot': () => Main.screenshotUI.open(),
    'notifications': () => Main.panel.toggleCalendar(),
    'quick-settings': () => Main.panel.toggleQuickSettings(),
    'close-window': () => global.display.focus_window?.delete(global.get_current_time()),
    'lock': () => {
        if (Main.screenShield)
            Main.screenShield.lock(true);
    },
    'rotation-lock': () => {
        const locked = toggleSetting('org.gnome.settings-daemon.peripherals.touchscreen', 'orientation-lock');
        osd(locked ? 'rotation-locked-symbolic' : 'rotation-allowed-symbolic',
            locked ? 'Rotation locked' : 'Auto rotate');
    },
    'dark-mode': () => {
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const dark = settings.get_string('color-scheme') !== 'prefer-dark';
        settings.set_string('color-scheme', dark ? 'prefer-dark' : 'default');
        osd(dark ? 'weather-clear-night-symbolic' : 'weather-clear-symbolic',
            dark ? 'Dark style' : 'Light style');
    },
    'do-not-disturb': () => {
        const banners = toggleSetting('org.gnome.desktop.notifications', 'show-banners');
        osd(banners ? 'preferences-system-notifications-symbolic' : 'notifications-disabled-symbolic',
            banners ? 'Notifications on' : 'Do Not Disturb');
    },
    'voice-typing': () => {
        // Provided by Tablet Keyboard, which owns the dictation and types the text
        const keyboard = Main.keyboard.keyboardActor;
        const state = keyboard?.toggleDictation?.();
        if (state === 'recording')
            osd('audio-input-microphone-symbolic', 'Listening…');
        else if (state === 'transcribing')
            osd('audio-input-microphone-symbolic', 'Typing what you said…');
        else if (state === 'downloading')
            osd('folder-download-symbolic', 'Downloading the voice model…');
        else if (!state)
            osd('microphone-disabled-symbolic', 'Voice typing needs Tablet Keyboard and Voice Typing');
    },
};

function runAction(action) {
    if (!action)
        return;
    const colon = action.indexOf(':');
    const kind = action.slice(0, colon);
    const arg = action.slice(colon + 1);
    try {
        if (kind === 'app') {
            const app = Shell.AppSystem.get_default().lookup_app(arg);
            if (app)
                app.activate();
            else
                Main.notify('Hardware Buttons', `Can't find the app ${arg}`);
        } else if (kind === 'shell') {
            ACTIONS[arg]?.();
        } else if (kind === 'command') {
            Util.spawn(['sh', '-c', arg]);
        }
    } catch (e) {
        logError(e, `hardware-buttons: ${action} failed`);
    }
}

export default class HardwareButtonsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._pending = null;
        for (const button of BUTTONS) {
            Main.wm.addKeybinding(`${button}-key`, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES,
                () => this._onPress(button));
        }
    }

    disable() {
        for (const button of BUTTONS)
            Main.wm.removeKeybinding(`${button}-key`);
        this._end();
        this._settings = null;
    }

    _onPress(button) {
        // A second button while one is down: settle the first as a press
        if (this._pending)
            this._fire('press');

        const actor = new Clutter.Actor({reactive: true});
        Main.uiGroup.add_child(actor);
        const grab = Main.pushModal(actor);
        this._pending = {button, actor, grab, timeoutId: 0};

        if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            // Something else holds the keyboard; we can't see the release
            this._fire('press');
            return;
        }

        // Key repeats and anything else stay with us until we know
        actor.connect('event', (_actor, event) => {
            if (event.type() === Clutter.EventType.KEY_RELEASE)
                this._fire('press');
            return Clutter.EVENT_STOP;
        });
        this._pending.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('hold-time'), () => {
                this._pending.timeoutId = 0;
                this._fire('hold');
                return GLib.SOURCE_REMOVE;
            });
    }

    _fire(kind) {
        const {button} = this._pending;
        this._end();
        this._settings.set_string('last-press', `${button} ${kind} ${GLib.get_real_time()}`);
        // After the grab is gone, so the action can take its own
        runAction(this._settings.get_string(`${button}-${kind}`));
    }

    _end() {
        const pending = this._pending;
        if (!pending)
            return;
        this._pending = null;
        if (pending.timeoutId)
            GLib.source_remove(pending.timeoutId);
        Main.popModal(pending.grab);
        pending.actor.destroy();
    }
}
