import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SCHEMES = ['mono', 'system', 'light', 'dark'];
const ENGINES = ['whisper', 'parakeet'];
// Installed by the Daylight Apps "Voice Typing" app
const VOICE_HELPER = GLib.build_filenamev(
    [GLib.get_user_data_dir(), 'daylight-apps', 'voice-typing', 'dictate']);

export default class TabletKeyboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // GTK focuses the first height field when the window opens, which
        // brings the keyboard back up showing the number keypad
        if (window.visible)
            window.set_focus(null);
        else
            window.connect('show', () => window.set_focus(null));

        const switchRow = (group, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };
        const heightRow = (group, key, title) => {
            const row = Adw.SpinRow.new_with_range(60, 140, 5);
            row.title = title;
            row.subtitle = 'Percent of the normal height';
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        const look = new Adw.PreferencesGroup({title: 'Size and look'});
        page.add(look);
        heightRow(look, 'portrait-height', 'Key height in portrait');
        heightRow(look, 'landscape-height', 'Key height in landscape');
        switchRow(look, 'split-keyboard', 'Split keyboard in landscape',
            'Two halves at the sides, for typing with your thumbs');
        switchRow(look, 'split-keyboard-portrait', 'Split keyboard in portrait',
            'Hold the hide key to split or merge the keyboard for the current orientation');
        switchRow(look, 'shortcut-bar', 'Bar above the keys',
            'Undo, redo and paste, cut and copy when text is selected, and arrows to the previous and next field. ' +
            'Hold the hide key to hide or show it');
        switchRow(look, 'special-keys', 'Special keys in the bar',
            'Esc, tab, ctrl, alt and arrow keys instead of the shortcuts. ' +
            'Tap esc in the bar to switch to them and … to switch back. Terminals always have them');

        const scheme = new Adw.ComboRow({
            title: 'Theme',
            subtitle: 'Monochrome is black and white with high contrast, for the Daylight screen, and inverts with the system dark style',
            model: Gtk.StringList.new(['Monochrome', 'Follow system', 'Light', 'Dark']),
            selected: Math.max(0, SCHEMES.indexOf(settings.get_string('color-scheme'))),
        });
        scheme.connect('notify::selected',
            () => settings.set_string('color-scheme', SCHEMES[scheme.selected]));
        look.add(scheme);

        const typing = new Adw.PreferencesGroup({title: 'Typing'});
        page.add(typing);
        switchRow(typing, 'swipe-symbols', 'Swipe down for symbols',
            'Swipe down on a letter to type the small character above it');
        switchRow(typing, 'auto-capitalize', 'Auto-capitalization');
        switchRow(typing, 'double-space-period', 'Double-space period',
            'Tap space twice to type a period and a space');
        switchRow(typing, 'autocorrect', 'Small autocorrections',
            'i → I, dont → don’t, teh → the. Backspace right after a fix undoes it');

        if (GLib.file_test(VOICE_HELPER, GLib.FileTest.IS_EXECUTABLE)) {
            const voice = new Adw.PreferencesGroup({title: 'Voice typing'});
            page.add(voice);
            const engine = new Adw.ComboRow({
                title: 'Engine',
                subtitle: 'Whisper: English, 142 MB. Parakeet: 25 European languages, ' +
                    'detected automatically, 416 MB, downloads when first picked',
                model: Gtk.StringList.new(['Whisper', 'Parakeet']),
                selected: Math.max(0, ENGINES.indexOf(settings.get_string('voice-engine'))),
            });
            engine.connect('notify::selected',
                () => settings.set_string('voice-engine', ENGINES[engine.selected]));
            voice.add(engine);

            page.add(this._dictionaryGroup(settings));
        }
    }

    // Words voice typing should know, like names and jargon. An entry is
    // "Word" or "Word = misheard, other misheard"; see apps/voice-typing/dictate
    _dictionaryGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Voice dictionary',
            description: 'Names and special words voice typing should know and ' +
                'spell your way. If a word keeps coming out wrong, add what it ' +
                'is heard as after an equals sign: Finni = finny, funny',
        });

        const add = new Adw.EntryRow({title: 'Add a word', show_apply_button: true});
        add.connect('apply', () => {
            const [word, ...heard] = add.text.split('=');
            const entry = heard.length
                ? `${word.trim()} = ${heard.join('=').split(',').map(h => h.trim()).filter(h => h).join(', ')}`
                : word.trim();
            add.text = '';
            if (!word.trim())
                return;
            const words = settings.get_strv('voice-words');
            // A new entry for a word replaces its old one
            const key = word.trim().toLowerCase();
            settings.set_strv('voice-words', [
                ...words.filter(w => w.split('=')[0].trim().toLowerCase() !== key),
                entry,
            ]);
        });
        group.add(add);

        let rows = [];
        const sync = () => {
            rows.forEach(row => group.remove(row));
            const words = settings.get_strv('voice-words');
            rows = words.map((entry, i) => {
                const [word, ...heard] = entry.split('=');
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(word.trim(), -1),
                    subtitle: heard.length
                        ? GLib.markup_escape_text(`Heard as ${heard.join('=').trim()}`, -1)
                        : '',
                });
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: 'Remove',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => settings.set_strv('voice-words',
                    words.filter((_, j) => j !== i)));
                row.add_suffix(remove);
                group.add(row);
                return row;
            });
        };
        const id = settings.connect('changed::voice-words', sync);
        group.connect('destroy', () => settings.disconnect(id));
        sync();
        return group;
    }
}
