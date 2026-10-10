"""Button settings shown on the Hardware Buttons page in Daylight Apps."""

from pathlib import Path

from gi.repository import Adw, Gio, GLib, Gtk

SCHEMA = "org.gnome.shell.extensions.hardware-buttons"
SCHEMA_DIR = Path(GLib.get_user_data_dir()) / "gnome-shell/extensions/hardware-buttons@finni/schemas"

BUTTONS = [("button1", "Button 1"), ("button2", "Button 2")]
KINDS = [("press", "Press"), ("hold", "Hold")]

# Keep the names in sync with ACTIONS in extensions/hardware-buttons@finni/extension.js
ACTIONS = [
    ("GNOME Shell", [
        ("overview", "Overview", "view-grid-symbolic"),
        ("app-grid", "App Grid", "view-app-grid-symbolic"),
        ("keyboard", "On-Screen Keyboard", "input-keyboard-symbolic"),
        ("screenshot", "Screenshot", "screenshot-recorded-symbolic"),
        ("notifications", "Notifications", "preferences-system-notifications-symbolic"),
        ("quick-settings", "Quick Settings", "emblem-system-symbolic"),
        ("close-window", "Close Window", "window-close-symbolic"),
        ("lock", "Lock Screen", "system-lock-screen-symbolic"),
    ]),
    ("Device", [
        ("rotation-lock", "Rotation Lock On/Off", "rotation-locked-symbolic"),
        ("dark-mode", "Dark Style On/Off", "weather-clear-night-symbolic"),
        ("do-not-disturb", "Do Not Disturb On/Off", "notifications-disabled-symbolic"),
        ("voice-typing", "Voice Typing Start/Stop", "audio-input-microphone-symbolic"),
    ]),
]
SHELL_ACTIONS = {name: (label, icon) for _, items in ACTIONS for name, label, icon in items}

JUST_PRESSED_MS = 3000


def describe(action):
    """(label, icon name) for an action string."""
    kind, _, arg = action.partition(":")
    if kind == "shell" and arg in SHELL_ACTIONS:
        return SHELL_ACTIONS[arg]
    if kind == "app":
        try:
            info = Gio.DesktopAppInfo.new(arg)
        except TypeError:  # unknown id
            info = None
        if info:
            return f"Open {info.get_display_name()}", info.get_icon()
        return f"Open {arg}", "application-x-executable-symbolic"
    if kind == "command":
        return f"Run {arg}", "utilities-terminal-symbolic"
    return "Nothing", "action-unavailable-symbolic"


def set_icon(image, icon):
    if isinstance(icon, str):
        image.set_from_icon_name(icon)
    elif icon:
        image.set_from_gicon(icon)
    else:
        image.set_from_icon_name("application-x-executable-symbolic")


class ActionPicker(Adw.Dialog):
    """Pick an action: nothing, a GNOME Shell or device function, a command or an app."""

    def __init__(self, title, current, on_pick):
        super().__init__(title=title, content_width=480, content_height=720)
        self.on_pick = on_pick
        self.current = current
        self.rows = []  # (row, group, search text)

        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()
        self.search = Gtk.SearchEntry(placeholder_text="Search actions and apps", hexpand=True)
        self.search.connect("search-changed", lambda *_: self.filter())
        header.set_title_widget(self.search)
        toolbar.add_top_bar(header)
        page = Adw.PreferencesPage()
        toolbar.set_content(page)
        self.set_child(toolbar)

        group = Adw.PreferencesGroup()
        self.add_row(group, "", "Nothing", "action-unavailable-symbolic")
        page.add(group)

        for title, items in ACTIONS:
            group = Adw.PreferencesGroup(title=title)
            for name, label, icon in items:
                self.add_row(group, f"shell:{name}", label, icon)
            page.add(group)

        group = Adw.PreferencesGroup(title="Command",
                                     description="Runs with sh -c, like a custom keyboard shortcut.")
        entry = Adw.EntryRow(title="Command", show_apply_button=True)
        if current.startswith("command:"):
            entry.set_text(current.split(":", 1)[1])
        entry.connect("apply", lambda e: e.get_text().strip() and self.pick(f"command:{e.get_text().strip()}"))
        group.add(entry)
        self.rows.append((entry, group, "command run"))
        page.add(group)

        group = Adw.PreferencesGroup(title="Open App")
        apps = [a for a in Gio.AppInfo.get_all() if a.should_show() and a.get_id()]
        for app in sorted(apps, key=lambda a: a.get_display_name().lower()):
            self.add_row(group, f"app:{app.get_id()}", app.get_display_name(), app.get_icon(),
                         search=f"{app.get_display_name()} {app.get_id()}")
        page.add(group)

    def add_row(self, group, action, label, icon, search=None):
        row = Adw.ActionRow(title=label, activatable=True, use_markup=False)
        image = Gtk.Image(pixel_size=24)
        set_icon(image, icon)
        row.add_prefix(image)
        if action == self.current:
            row.add_suffix(Gtk.Image(icon_name="object-select-symbolic"))
        row.connect("activated", lambda *_: self.pick(action))
        group.add(row)
        self.rows.append((row, group, (search or label).lower()))

    def filter(self):
        text = self.search.get_text().strip().lower()
        shown = {}
        for row, group, haystack in self.rows:
            visible = not text or text in haystack
            row.set_visible(visible)
            shown[group] = shown.get(group, False) or visible
        for group, visible in shown.items():
            group.set_visible(visible)

    def pick(self, action):
        self.on_pick(action)
        self.close()


class ButtonSettings(Gtk.Box):
    def __init__(self, window, settings):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=18)
        self.window = window
        self.settings = settings
        self.rows = {}  # key -> (row, image)
        self.groups = {}
        self.reset_id = 0

        for button, title in BUTTONS:
            group = Adw.PreferencesGroup(title=title)
            for kind, label in KINDS:
                key = f"{button}-{kind}"
                row = Adw.ActionRow(title=label, activatable=True, use_markup=False)
                image = Gtk.Image(pixel_size=24)
                row.add_prefix(image)
                row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
                row.connect("activated", lambda *_, k=key, t=f"{title} {label}": self.edit(k, t))
                group.add(row)
                self.rows[key] = (row, image)
                self.sync(key)
            self.groups[button] = group
            self.append(group)
        self.reset_descriptions()

        group = Adw.PreferencesGroup()
        hold = Adw.SpinRow.new_with_range(250, 2000, 50)
        hold.set_title("Hold Time")
        hold.set_subtitle("Milliseconds a button must be down to count as held")
        settings.bind("hold-time", hold, "value", Gio.SettingsBindFlags.DEFAULT)
        group.add(hold)
        self.append(group)

        settings.connect("changed", self.on_changed)

    def sync(self, key):
        row, image = self.rows[key]
        label, icon = describe(self.settings.get_string(key))
        row.set_subtitle(label)
        set_icon(image, icon)

    def edit(self, key, title):
        ActionPicker(title, self.settings.get_string(key),
                     lambda action: self.settings.set_string(key, action)).present(self.window)

    def on_changed(self, _settings, key):
        if key in self.rows:
            self.sync(key)
        elif key == "last-press":
            self.show_last_press()

    def reset_descriptions(self):
        self.reset_id = 0
        for group in self.groups.values():
            group.set_description("Press a button on the device to see which one this is.")
        return GLib.SOURCE_REMOVE

    def show_last_press(self):
        """Mark the group of the button that was just pressed."""
        button, kind = (self.settings.get_string("last-press").split() + ["", ""])[:2]
        if button not in self.groups:
            return
        if self.reset_id:
            GLib.source_remove(self.reset_id)
        self.reset_descriptions()
        self.groups[button].set_description("Just held" if kind == "hold" else "Just pressed")
        self.reset_id = GLib.timeout_add(JUST_PRESSED_MS, self.reset_descriptions)


def build(window):
    """Widget for the app page, or None when the extension's schema is missing."""
    try:
        source = Gio.SettingsSchemaSource.new_from_directory(
            str(SCHEMA_DIR), Gio.SettingsSchemaSource.get_default(), False)
    except GLib.Error:
        return None
    schema = source.lookup(SCHEMA, False)
    if not schema:
        return None
    return ButtonSettings(window, Gio.Settings.new_full(schema, None, None))
