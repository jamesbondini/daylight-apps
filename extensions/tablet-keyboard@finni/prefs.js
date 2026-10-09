import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SCHEMES = ['system', 'light', 'dark'];

export default class TabletKeyboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

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
        switchRow(look, 'shortcut-bar', 'Shortcut bar',
            'Undo, redo and paste above the keys, plus cut and copy when text is selected');

        const scheme = new Adw.ComboRow({
            title: 'Colors',
            model: Gtk.StringList.new(['Follow system', 'Light', 'Dark']),
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
    }
}
