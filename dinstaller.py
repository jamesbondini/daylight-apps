#!/usr/bin/env python3
"""dInstaller: a small GTK front end for the scripts in apps/<id>/.

Each app directory holds (in the spirit of Omarchy's install/installed/remove
scripts):
  info       KEY=value metadata (NAME, SUMMARY, ICON, CATEGORY, WEBSITE, BASED_ON,
             SETUP_LABEL, OPEN, OPEN_LABEL)
  install    install or update the app
  installed  exit 0 if installed, printing a one-line status
  remove     uninstall the app
  setup      optional post-install step (login, account linking, ...)
  enabled    optional: exit 0 if turned on; with `enable` and `disable`
             this adds an on/off switch (e.g. for GNOME Shell extensions)
  extras     optional: list optional parts (e.g. models), one per line as
             ID|Title|Subtitle|yes-or-no (downloaded), plus optionally one
             line without `|` shown under the group title (e.g. the space
             they use); `extra-add ID` and `extra-remove ID` download and
             delete one. Group title comes from EXTRAS_TITLE in info.
  page.py    optional: Python module whose build(window) returns a widget
             (or None) shown on the app's page while it is installed, for
             settings such as Hardware Buttons'.

NEEDS in info lists app ids (space-separated) that must be installed first;
until they are, the app's Install button points to them instead.

RECOMMENDED=yes puts an app in the "Recommended apps" set the main list
offers to install in one go (lib/install-apps). PACKAGES lists the apk
packages its install script would ask for the password to add; they are
installed together beforehand, so the whole set asks once. Update All runs
lib/update-all, which upgrades the system and then runs every installed app's
`install` again.
"""

import importlib.util
import os
import re
import signal
import sys
import traceback
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk, Pango  # noqa: E402

APP_ID = "io.github.jamesbondini.dInstaller"
ROOT = Path(__file__).resolve().parent
APP_DIRS = [ROOT / "apps", Path(GLib.get_user_config_dir()) / "dinstaller" / "apps"]
# CATEGORY values from info, in the order the main list shows them. Apps
# without one go under "apps"; unknown categories follow, titled as written.
CATEGORIES = {
    "setup": ("Start Here", "Install these first; other apps need them."),
    "apps": ("Apps", "Desktop apps, installed from Flathub."),
    "developer": ("Developer Tools", "Editors and coding agents for the terminal."),
    "services": ("Services", "Run in the background; set up once with an account."),
    "extensions": ("Extensions", "GNOME Shell extensions and add-ons for them. "
                                 "Log out and in after installing one for the first time."),
}

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")
URL_RE = re.compile(r"https?://[^\s'\"<>]+")


class AppEntry:
    def __init__(self, path: Path):
        self.id = path.name
        self.path = path
        self.meta = {}
        for line in (path / "info").read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                self.meta[key.strip()] = value.strip()
        self.name = self.meta.get("NAME", self.id)
        self.summary = self.meta.get("SUMMARY", "")
        self.category = self.meta.get("CATEGORY", "apps")
        self.needs = self.meta.get("NEEDS", "").split()
        self.installed = None  # None = unknown
        self.status = ""
        self.enabled = None  # None = unknown or not switchable
        self.extras = []  # (id, title, subtitle, present)
        self.extras_note = ""
        self.toggling = False
        self.checking = False  # an `installed` check is running

    def script(self, name):
        p = self.path / name
        return p if p.exists() and os.access(p, os.X_OK) else None

    @property
    def switchable(self):
        return all(self.script(s) for s in ("enabled", "enable", "disable"))

    def icon_name(self, widget):
        theme = Gtk.IconTheme.get_for_display(widget.get_display())
        for name in self.meta.get("ICON", "").split():
            if theme.has_icon(name):
                return name
        return "application-x-executable-symbolic"


def load_apps():
    apps = {}
    for d in APP_DIRS:
        if d.is_dir():
            for p in sorted(d.iterdir()):
                if (p / "info").exists() and (p / "install").exists():
                    apps[p.name] = AppEntry(p)  # user dir overrides built-ins
    return sorted(apps.values(), key=lambda a: a.name.lower())


def text(data):
    """Script output (GLib.Bytes) as text. Bytes that are not UTF-8 must not
    lose the rest, as communicate_utf8 would."""
    return data.get_data().decode("utf-8", "replace") if data else ""


def script_env():
    env = dict(os.environ)
    env.update(TERM="dumb", NO_COLOR="1", PYTHONUNBUFFERED="1")
    return [f"{k}={v}" for k, v in env.items()]


def session_pids(sid):
    """PIDs of live processes in session `sid` (root ones included)."""
    pids = []
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = stat.read_text().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        if fields[0] != "Z" and int(fields[3]) == sid:
            pids.append(int(stat.parent.name))
    return pids


def build_custom_page(app, window):
    """The widget from the app's page.py, or None."""
    path = app.path / "page.py"
    if not path.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location(f"daylight_page_{app.id.replace('-', '_')}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.build(window)
    except Exception:  # a broken page must not take the app down
        traceback.print_exc()
        return None


APK_DB = Path("/lib/apk/db/installed")
_apk_cache = (None, frozenset())


def apk_installed():
    """Names of the installed apk packages (re-read only when apk changes them)."""
    global _apk_cache
    try:
        mtime = APK_DB.stat().st_mtime
        if _apk_cache[0] != mtime:
            names = (line[2:] for line in APK_DB.read_text(errors="replace").splitlines() if line.startswith("P:"))
            _apk_cache = (mtime, frozenset(names))
    except OSError:
        pass
    return _apk_cache[1]


def check_installed(app, callback):
    """Run the app's `installed` script asynchronously."""
    launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
    launcher.set_environ(script_env())
    try:
        proc = launcher.spawnv([str(app.path / "installed")])
    except GLib.Error:  # missing or not executable
        app.installed, app.status, app.enabled, app.extras, app.extras_note = False, "", None, [], ""
        callback(app)
        return
    app.checking = True

    def done(proc, res):
        app.checking = False
        try:
            _, out, _ = proc.communicate_finish(res)
            app.installed = proc.get_successful()
            out = text(out).strip()
            app.status = out.splitlines()[0] if out else ""
        except GLib.Error:
            app.installed, app.status = False, ""
        app.enabled = None
        if not app.installed:
            app.extras, app.extras_note = [], ""
        after_extras = lambda: (check_enabled(app, callback) if app.installed and app.switchable
                                else callback(app))
        if app.installed and app.script("extras"):
            check_extras(app, after_extras)
        else:
            after_extras()

    proc.communicate_async(None, None, done)


def check_extras(app, callback):
    """Run the app's `extras` script asynchronously."""
    launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
    launcher.set_environ(script_env())
    try:
        proc = launcher.spawnv([str(app.path / "extras")])
    except GLib.Error:  # removed or made non-executable since the check
        app.extras, app.extras_note = [], ""
        callback()
        return

    def done(proc, res):
        try:
            _, out, _ = proc.communicate_finish(res)
            out = text(out)
        except GLib.Error:
            out = ""
        app.extras, app.extras_note = [], ""
        for line in out.splitlines():
            parts = line.split("|")
            if len(parts) == 4:
                app.extras.append((parts[0], parts[1], parts[2], parts[3].strip() == "yes"))
            elif len(parts) == 1 and line.strip():
                app.extras_note = line.strip()
        callback()

    proc.communicate_async(None, None, done)


def check_enabled(app, callback):
    """Run the app's `enabled` script asynchronously."""
    launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE)
    launcher.set_environ(script_env())
    try:
        proc = launcher.spawnv([str(app.path / "enabled")])
    except GLib.Error:
        app.enabled = None
        callback(app)
        return

    def done(proc, res):
        try:
            proc.wait_finish(res)
            app.enabled = proc.get_successful()
        except GLib.Error:
            app.enabled = None
        callback(app)

    proc.wait_async(None, done)


class ScriptPage(Adw.NavigationPage):
    """A page that runs scripts: a spinner with Cancel while one runs, its
    output streamed into a log, and buttons for the links it prints.
    Subclasses place self.busy, self.links and self.log_box on the page."""

    def __init__(self, window, **kwargs):
        super().__init__(**kwargs)
        self.window = window
        self.proc = None
        self.urls = set()

        self.busy = Gtk.Box(spacing=12, visible=False)
        self.busy.append(Adw.Spinner(width_request=24, height_request=24))
        self.busy_label = Gtk.Label(xalign=0, hexpand=True, ellipsize=Pango.EllipsizeMode.END)
        self.busy.append(self.busy_label)
        self.cancel_button = Gtk.Button(label="Cancel")
        self.cancel_button.add_css_class("pill")
        self.cancel_button.connect("clicked", lambda *_: self.cancel())
        self.busy.append(self.cancel_button)

        # Links found in the output (e.g. Tailscale login URL)
        self.links = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, visible=False)

        # Output log
        self.log_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, visible=False)
        heading = Gtk.Label(label="Output", xalign=0)
        heading.add_css_class("heading")
        self.log_box.append(heading)
        self.buffer = Gtk.TextBuffer()
        self.view = Gtk.TextView(buffer=self.buffer, editable=False, cursor_visible=False, monospace=True,
                                 wrap_mode=Gtk.WrapMode.WORD_CHAR, top_margin=12, bottom_margin=12,
                                 left_margin=12, right_margin=12)
        self.log_scroll = Gtk.ScrolledWindow(child=self.view, min_content_height=320, vexpand=True)
        self.log_scroll.add_css_class("card")
        self.log_scroll.set_overflow(Gtk.Overflow.HIDDEN)
        self.log_box.append(self.log_scroll)

    def changed(self):
        """Called when a script starts or stops running."""

    def start(self, argv, cwd, label, done):
        """Run argv in cwd, then call done(ok, cancelled)."""
        if self.proc:
            return
        self.buffer.set_text("")
        self.urls.clear()
        while child := self.links.get_first_child():
            self.links.remove(child)
        self.links.set_visible(False)
        self.log_box.set_visible(True)
        self.busy_label.set_label(label)
        self.cancel_button.set_sensitive(True)
        self.cancelling = False
        self.pending = 2  # stdout EOF and process exit
        self.done = done

        launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE)
        launcher.set_environ(script_env())
        launcher.set_cwd(str(cwd))
        try:
            # Own session, so Cancel can find and stop the script's children too.
            self.proc = launcher.spawnv(["setsid", *map(str, argv)])
        except GLib.Error as e:
            self.append(f"Failed to start: {e.message}\n")
            return
        self.sid = int(self.proc.get_identifier())
        self.changed()
        self.stream = stream = Gio.DataInputStream.new(self.proc.get_stdout_pipe())
        stream.read_line_async(GLib.PRIORITY_DEFAULT, None, self.on_line, stream)
        self.proc.wait_async(None, self.on_exit)

    def on_line(self, stream, res, _data):
        if stream is not self.stream:  # left over from an earlier run
            return
        try:
            line, _ = stream.read_line_finish_utf8(res)
        except GLib.Error as e:
            # A line that is not UTF-8 is consumed and skipped; stopping here
            # would leave the pipe undrained and the script blocked on it.
            line = "" if e.matches(GLib.convert_error_quark(), GLib.ConvertError.ILLEGAL_SEQUENCE) else None
        if line is None:
            self.step_done()
            return
        # Progress bars redraw with \r; keep only the final state of the line.
        line = ANSI_RE.sub("", line).rstrip("\r").split("\r")[-1]
        if line or self.buffer.get_char_count():
            self.append(line + "\n")
        for url in URL_RE.findall(line):
            self.add_link(url.rstrip(".,)"))
        stream.read_line_async(GLib.PRIORITY_DEFAULT, None, self.on_line, stream)

    def append(self, text):
        self.buffer.insert(self.buffer.get_end_iter(), text)
        adj = self.log_scroll.get_vadjustment()
        GLib.idle_add(lambda: adj.set_value(adj.get_upper()) and False)

    def add_link(self, url):
        if url in self.urls:
            return
        self.urls.add(url)
        button = Gtk.Button(halign=Gtk.Align.START)
        content = Gtk.Box(spacing=8)
        content.append(Gtk.Image(icon_name="web-browser-symbolic"))
        content.append(Gtk.Label(label=f"Open {url}", ellipsize=Pango.EllipsizeMode.MIDDLE))
        button.set_child(content)
        button.add_css_class("pill")
        button.add_css_class("suggested-action")
        button.connect("clicked", lambda *_: Gtk.UriLauncher.new(url).launch(self.window, None, None))
        self.links.append(button)
        self.links.set_visible(True)

    def cancel(self):
        """Stop the script and its children; root children may finish their step."""
        if not self.proc or self.cancelling:
            return
        self.cancelling = True
        self.busy_label.set_label("Cancelling…")
        self.cancel_button.set_sensitive(False)
        for pid in session_pids(self.sid):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:  # gone, or root (e.g. via pkexec)
                pass

    def on_exit(self, proc, res):
        try:
            proc.wait_finish(res)
        except GLib.Error:
            pass
        self.step_done()
        if self.pending:
            # Something left in the background may hold stdout open; don't wait forever.
            GLib.timeout_add(1000, lambda: self.proc is proc and self.pending and self.step_done() and False)

    def step_done(self):
        self.pending -= 1
        if self.pending == 0:
            self.finish()

    def finish(self):
        if self.cancelling and session_pids(self.sid):
            GLib.timeout_add(500, lambda: self.finish() and False)
            return
        proc = self.proc
        ok = proc.get_if_exited() and proc.get_exit_status() == 0
        self.proc = None
        if self.cancelling:
            self.append("\nCancelled.")
        elif not ok:
            self.append("\nFailed." if proc.get_if_exited() else "\nCancelled.")
        self.done(ok, self.cancelling)
        self.changed()


class TaskPage(ScriptPage):
    """Runs one of dInstaller' own scripts from lib/, such as Update All."""

    def __init__(self, window, tag, title, description):
        super().__init__(window, title=title, tag=tag)
        toolbar = Adw.ToolbarView()
        toolbar.add_top_bar(Adw.HeaderBar())
        self.set_child(toolbar)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18,
                      margin_top=24, margin_bottom=24, margin_start=16, margin_end=16)
        clamp = Adw.Clamp(maximum_size=720, child=box)
        toolbar.set_content(Gtk.ScrolledWindow(child=clamp, vexpand=True))

        heading = Gtk.Label(label=title, xalign=0)
        heading.add_css_class("title-1")
        box.append(heading)
        self.description = Gtk.Label(label=description, xalign=0, wrap=True)
        box.append(self.description)
        box.append(self.busy)
        box.append(self.links)
        box.append(self.log_box)

    def changed(self):
        self.busy.set_visible(self.proc is not None)
        self.window.on_task(self)


class AppPage(ScriptPage):
    """Detail page: status, actions and live script output for one app."""

    def __init__(self, window, app):
        super().__init__(window, title=app.name, tag=app.id)
        self.app = app

        toolbar = Adw.ToolbarView()
        toolbar.add_top_bar(Adw.HeaderBar())
        self.set_child(toolbar)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18,
                      margin_top=24, margin_bottom=24, margin_start=16, margin_end=16)
        clamp = Adw.Clamp(maximum_size=720, child=box)
        toolbar.set_content(Gtk.ScrolledWindow(child=clamp, vexpand=True))

        # Header: icon, name, status, summary
        head = Gtk.Box(spacing=18)
        self.icon = Gtk.Image(pixel_size=72, valign=Gtk.Align.START)
        self.icon.add_css_class("icon-dropshadow")
        head.append(self.icon)
        text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, valign=Gtk.Align.CENTER, hexpand=True)
        title = Gtk.Label(label=app.name, xalign=0)
        title.add_css_class("title-1")
        text.append(title)
        self.status_label = Gtk.Label(xalign=0, wrap=True)
        self.status_label.add_css_class("dim-label")
        text.append(self.status_label)
        head.append(text)
        box.append(head)

        summary = Gtk.Label(label=app.summary, xalign=0, wrap=True)
        box.append(summary)
        if site := app.meta.get("WEBSITE"):
            link = Gtk.LinkButton(uri=site, label=site.split("://", 1)[-1], halign=Gtk.Align.START)
            link.add_css_class("flat")
            box.append(link)
        # Credit for apps we wrote ourselves, modelled on someone else's project
        if based_on := app.meta.get("BASED_ON"):
            credit = Gtk.Box(spacing=0, halign=Gtk.Align.START)
            label = Gtk.Label(label="Based on")
            label.add_css_class("dim-label")
            credit.append(label)
            link = Gtk.LinkButton(uri=based_on, label=based_on.split("://", 1)[-1])
            link.add_css_class("flat")
            credit.append(link)
            box.append(credit)

        # Shown while an app from NEEDS is missing
        self.needs_banner = Adw.Banner(button_label="Show")
        self.needs_banner.connect("button-clicked", lambda *_: self.show_missing())
        box.append(self.needs_banner)

        # On/off switch for apps that have one
        self.switch_group = Adw.PreferencesGroup(visible=False)
        self.switch_row = Adw.SwitchRow(title="Turned On")
        self.switch_row.connect("notify::active", self.on_switch)
        self.switch_group.add(self.switch_row)
        box.append(self.switch_group)

        # Settings from the app's page.py, built once it is installed
        self.custom_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, visible=False)
        self.custom = None
        self.custom_tried = False
        box.append(self.custom_box)

        # Optional parts, e.g. downloadable models
        self.extras_group = Adw.PreferencesGroup(title=app.meta.get("EXTRAS_TITLE", "Extras"), visible=False)
        self.extra_rows = []

        # Action buttons
        self.actions = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, column_spacing=8,
                                   row_spacing=8, max_children_per_line=4, homogeneous=False,
                                   halign=Gtk.Align.START)
        box.append(self.actions)
        box.append(self.busy)
        box.append(self.extras_group)
        box.append(self.links)
        box.append(self.log_box)

        self.connect("showing", lambda *_: self.refresh())
        self.update()

    # ---- state ----

    def refresh(self):
        if not self.proc and not self.window.task_running():  # as in Window.refresh_all
            check_installed(self.app, lambda _: self.window.on_status(self.app))

    def update(self):
        app = self.app
        self.icon.set_from_icon_name(app.icon_name(self))
        if app.installed is None:
            self.status_label.set_label("Checking…")
        elif app.installed:
            self.status_label.set_label("Installed" + (f" · {app.status}" if app.status else ""))
        else:
            self.status_label.set_label("Not installed")

        missing = self.window.missing_needs(app)
        self.needs_banner.set_title(f"Needs {' and '.join(a.name for a in missing)}, install it first")
        self.needs_banner.set_revealed(bool(missing) and not app.installed)

        running = self.proc is not None
        # Update All or the recommended apps may be installing this one
        blocked = app.toggling or self.window.task_running()
        self.switch_group.set_visible(bool(app.installed) and app.enabled is not None)
        if app.enabled is not None and not app.toggling:
            self.syncing = True
            self.switch_row.set_active(app.enabled)
            self.syncing = False
        self.switch_row.set_sensitive(not running and not blocked)
        self.switch_row.set_subtitle("Switching…" if app.toggling else app.status)
        self.update_extras(running or blocked)
        if app.installed and not self.custom and not self.custom_tried:
            # Once per install: a page.py that fails or returns None is not re-run on every update
            self.custom_tried = True
            self.custom = build_custom_page(app, self.window)
            if self.custom:
                self.custom_box.append(self.custom)
        elif app.installed is False:
            self.custom_tried = False
        self.custom_box.set_visible(bool(app.installed) and self.custom is not None)

        while child := self.actions.get_first_child():
            self.actions.remove(child)
        self.actions.set_visible(not running and app.installed is not None)
        self.actions.set_sensitive(not blocked)
        self.busy.set_visible(running)
        if running or app.installed is None:
            return

        def add(label, cb, style=None):
            b = Gtk.Button(label=label)
            b.add_css_class("pill")
            if style:
                b.add_css_class(style)
            b.connect("clicked", lambda *_: cb())
            self.actions.append(b)

        if not app.installed:
            if missing:
                first = missing[0]
                add(f"Install {first.name} First", lambda: self.window.show_app(first), "suggested-action")
            else:
                add("Install", lambda: self.run("install", f"Installing {app.name}…"), "suggested-action")
            return
        if app.script("setup"):
            add(app.meta.get("SETUP_LABEL", "Set Up"), lambda: self.run("setup", "Setting up…"), "suggested-action")
        if app.meta.get("OPEN"):
            add(app.meta.get("OPEN_LABEL", "Open"), self.open_app)
        add("Update", lambda: self.run("install", f"Updating {app.name}…"))
        add("Remove", self.confirm_remove, "destructive-action")

    def update_extras(self, running):
        app = self.app
        for row in self.extra_rows:
            self.extras_group.remove(row)
        self.extra_rows = []
        self.extras_group.set_visible(bool(app.installed) and bool(app.extras))
        self.extras_group.set_description(app.extras_note or None)
        if not app.installed:
            return
        for ident, title, subtitle, present in app.extras:
            row = Adw.ActionRow(title=title, subtitle=subtitle)
            button = Gtk.Button(label="Remove" if present else "Download", valign=Gtk.Align.CENTER,
                                sensitive=not running)
            button.add_css_class("pill")
            if present:
                button.connect("clicked", lambda *_, i=ident, t=title: self.confirm_remove_extra(i, t))
            else:
                button.add_css_class("suggested-action")
                button.connect("clicked", lambda *_, i=ident, t=title:
                               self.run("extra-add", f"Downloading {t}…", [i], t))
            row.add_suffix(button)
            self.extras_group.add(row)
            self.extra_rows.append(row)

    # ---- actions ----

    def show_missing(self):
        if missing := self.window.missing_needs(self.app):
            self.window.show_app(missing[0])

    def on_switch(self, row, _pspec):
        if not getattr(self, "syncing", False) and row.get_active() != self.app.enabled:
            self.window.toggle(self.app, row.get_active())

    def open_app(self):
        target = self.app.meta["OPEN"]
        if "://" in target:
            Gtk.UriLauncher.new(target).launch(self.window, None, None)
            return
        info = Gio.DesktopAppInfo.new(f"{target}.desktop")
        if info:
            info.launch([], None)
        else:
            self.window.toast(f"Could not find {target}")

    def confirm_remove(self):
        dialog = Adw.AlertDialog(heading=f"Remove {self.app.name}?",
                                 body="The app will be uninstalled. Your settings and data are kept.")
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("remove", "Remove")
        dialog.set_response_appearance("remove", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.connect("response", lambda _, r: r == "remove" and self.run("remove", f"Removing {self.app.name}…"))
        dialog.present(self.window)

    def confirm_remove_extra(self, ident, title):
        dialog = Adw.AlertDialog(heading=f"Remove {title}?",
                                 body="You can download it again here at any time.")
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("remove", "Remove")
        dialog.set_response_appearance("remove", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.connect("response", lambda _, r: r == "remove" and
                       self.run("extra-remove", f"Removing {title}…", [ident], title))
        dialog.present(self.window)

    def run(self, script, label, args=(), what=None):
        if self.app.toggling or self.window.task_running():
            return
        what = what or self.app.name
        self.start([self.app.path / script, *args], self.app.path, label,
                   lambda ok, cancelled: self.finished(script, what, ok, cancelled))

    def changed(self):
        self.window.on_status(self.app)

    def finished(self, script, what, ok, cancelled):
        verb = {"install": "Install", "remove": "Removal", "setup": "Setup",
                "extra-add": "Download", "extra-remove": "Removal"}.get(script, script)
        if ok:
            self.window.toast(f"{verb} of {what} finished")
        elif cancelled:
            self.window.toast(f"{verb} of {what} cancelled")
        else:
            self.window.toast(f"{verb} of {what} failed")
        self.app.installed = None
        self.refresh()


class Window(Adw.ApplicationWindow):
    def __init__(self, application):
        super().__init__(application=application, title="dInstaller", default_width=720, default_height=900)
        self.apps = load_apps()
        self.by_id = {a.id: a for a in self.apps}
        self.rows = {}
        self.pages = {}
        self.tasks = {}  # TaskPages by tag

        self.toasts = Adw.ToastOverlay()
        self.nav = Adw.NavigationView()
        self.toasts.set_child(self.nav)
        self.set_content(self.toasts)

        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()
        refresh = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh")
        refresh.connect("clicked", lambda *_: self.refresh_all())
        header.pack_start(refresh)
        self.update_all = Gtk.Button(icon_name="software-update-available-symbolic", tooltip_text="Update All")
        self.update_all.connect("clicked", lambda *_: self.confirm_update_all())
        header.pack_end(self.update_all)
        toolbar.add_top_bar(header)

        page = Adw.PreferencesPage()
        # Offers the apps marked RECOMMENDED=yes while some are not installed
        self.recommended = [a for a in self.apps if a.meta.get("RECOMMENDED") == "yes"]
        self.recommended_group = Adw.PreferencesGroup(title="Set Up This Tablet", visible=False)
        self.recommended_row = Adw.ActionRow(title="Recommended Apps", subtitle_lines=0)
        self.recommended_row.add_prefix(Gtk.Image(icon_name="starred-symbolic", pixel_size=32))
        self.recommended_button = Gtk.Button(label="Install", valign=Gtk.Align.CENTER)
        self.recommended_button.add_css_class("pill")
        self.recommended_button.add_css_class("suggested-action")
        self.recommended_button.connect("clicked", lambda *_: self.install_recommended())
        self.recommended_row.add_suffix(self.recommended_button)
        self.recommended_group.add(self.recommended_row)
        page.add(self.recommended_group)
        groups = {}
        order = list(CATEGORIES) + sorted({a.category for a in self.apps} - set(CATEGORIES))
        for cat in order:
            if any(a.category == cat for a in self.apps):
                title, description = CATEGORIES.get(cat, (cat.replace("-", " ").title(), None))
                groups[cat] = Adw.PreferencesGroup(title=title, description=description)
                page.add(groups[cat])
        for app in self.apps:
            row = Adw.ActionRow(title=app.name, subtitle=app.summary, activatable=True, subtitle_lines=2)
            icon = Gtk.Image(icon_name=app.icon_name(self), pixel_size=32)
            row.add_prefix(icon)
            badge = Gtk.Label(valign=Gtk.Align.CENTER)
            badge.add_css_class("caption")
            row.add_suffix(badge)
            switch = Gtk.Switch(valign=Gtk.Align.CENTER, visible=False,
                                tooltip_text=f"Turn {app.name} on or off")
            switch.connect("notify::active", self.on_row_switch, app)
            row.add_suffix(switch)
            row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
            row.connect("activated", lambda _, a=app: self.show_app(a))
            groups[app.category].add(row)
            self.rows[app.id] = (row, icon, badge, switch)
        if not self.apps:
            page = Adw.StatusPage(title="No Apps", description=f"Add app recipes to {APP_DIRS[-1]}",
                                  icon_name="system-software-install-symbolic")
        toolbar.set_content(page)
        self.nav.add(Adw.NavigationPage(title="dInstaller", tag="main", child=toolbar))

        # Re-check when coming back to the window (e.g. after a terminal setup).
        self.connect("notify::is-active", lambda *_: self.is_active() and self.refresh_all())
        self.refresh_all()

    def show_page(self, page):
        if self.nav.find_page(page.get_tag()):
            self.nav.pop_to_page(page)
        else:
            self.nav.push(page)

    def show_app(self, app):
        if app.id not in self.pages:
            self.pages[app.id] = AppPage(self, app)
        self.show_page(self.pages[app.id])

    def missing_needs(self, app):
        """Apps from app's NEEDS that are known not to be installed."""
        return [self.by_id[n] for n in app.needs if n in self.by_id and self.by_id[n].installed is False]

    def refresh_all(self):
        # A task re-installs apps as it goes, so checking now could catch one
        # half-copied; the task re-checks everything when it ends.
        if self.task_running():
            return
        for app in self.apps:
            page = self.pages.get(app.id)
            if not (page and page.proc) and not app.checking:
                check_installed(app, self.on_status)

    def on_status(self, app):
        self.show_status(app)
        self.update_recommended()

    def show_status(self, app, _seen=None):
        row, icon, badge, switch = self.rows[app.id]
        icon.set_from_icon_name(app.icon_name(self))
        page = self.pages.get(app.id)
        busy = bool(page and page.proc)
        switch.set_visible(bool(app.installed) and app.enabled is not None and not busy)
        if app.enabled is not None and not app.toggling:
            self.syncing = True
            switch.set_active(app.enabled)
            self.syncing = False
        switch.set_sensitive(not app.toggling and not self.task_running())
        for cls in ("success", "dim-label", "accent"):
            badge.remove_css_class(cls)
        if busy:
            badge.set_label("Working…")
            badge.add_css_class("accent")
        elif app.installed:
            badge.set_label("Installed")
            badge.add_css_class("success")
        elif app.installed is False and (missing := self.missing_needs(app)):
            badge.set_label(f"Needs {missing[0].name}")
            badge.add_css_class("dim-label")
        elif app.installed is False:
            badge.set_label("")
        if page:
            page.update()
        # Apps that need this one show its state too (once each, even if NEEDS loops).
        seen = (_seen or set()) | {app.id}
        for other in self.apps:
            if app.id in other.needs and other.id in self.rows and other.id not in seen:
                self.show_status(other, seen)

    # ---- tasks: Update All and installing the recommended apps ----

    def task_running(self):
        return any(t.proc for t in self.tasks.values())

    def run_task(self, tag, title, description, argv, label, messages):
        """Run a script from lib/ on its own page; toast messages[ok, cancelled or failed] at the end."""
        if (self.task_running() or any(p.proc for p in self.pages.values())
                or any(a.toggling for a in self.apps)):
            self.toast("Wait for the app being installed or changed to finish first")
            return
        page = self.tasks.get(tag)
        if not page:
            page = self.tasks[tag] = TaskPage(self, tag, title, description)
        page.description.set_label(description)
        self.show_page(page)

        def done(ok, cancelled):
            self.toast(messages["ok" if ok else "cancelled" if cancelled else "failed"])
            for app in self.apps:
                app.installed = None
            self.refresh_all()

        page.start(argv, ROOT, label, done)

    def on_task(self, _page):
        running = self.task_running()
        self.update_all.set_sensitive(not running)
        for app in self.apps:
            self.show_status(app)
        self.update_recommended()

    def confirm_update_all(self):
        dialog = Adw.AlertDialog(
            heading="Update Everything?",
            body="Updates dInstaller, the system (asks for your password), your Flatpak apps "
                 "and every app installed here. This can take a while.")
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("update", "Update")
        dialog.set_response_appearance("update", Adw.ResponseAppearance.SUGGESTED)
        dialog.connect("response", lambda _, r: r == "update" and self.run_task(
            "update-all", "Update All",
            "Updating dInstaller, the system, your Flatpak apps and every app installed here.",
            [ROOT / "lib" / "update-all"], "Updating everything…",
            {"ok": "Everything is up to date", "cancelled": "Update All cancelled",
             "failed": "Some updates failed; see the output"}))
        dialog.present(self)

    def missing_recommended(self):
        """Recommended apps known not to be installed, each after the ones it needs."""
        missing = [a for a in self.recommended if a.installed is False]
        ordered = []
        while missing:
            ready = [a for a in missing if not any(n in (m.id for m in missing) for n in a.needs)]
            for a in ready or missing:  # ready is empty only if NEEDS loops
                ordered.append(a)
                missing.remove(a)
        return ordered

    def update_recommended(self):
        missing = self.missing_recommended()
        self.recommended_group.set_visible(bool(missing))
        if not missing:
            return
        names = [a.name for a in missing]
        listed = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
        packages = {p for a in missing for p in a.meta.get("PACKAGES", "").split()}
        password = " (asks for your password)" if packages - apk_installed() else ""
        self.recommended_row.set_subtitle(f"Installs {listed} in one go{password}.")
        self.recommended_button.set_sensitive(not self.task_running())

    def install_recommended(self):
        missing = self.missing_recommended()
        if not missing:
            return
        self.run_task(
            "recommended", "Recommended Apps", self.recommended_row.get_subtitle(),
            [ROOT / "lib" / "install-apps", *(a.path for a in missing)], "Installing the recommended apps…",
            {"ok": "Recommended apps installed", "cancelled": "Installing the recommended apps cancelled",
             "failed": "Some recommended apps could not be installed; see the output"})

    def on_row_switch(self, switch, _pspec, app):
        if not getattr(self, "syncing", False) and switch.get_active() != app.enabled:
            self.toggle(app, switch.get_active())

    def toggle(self, app, on):
        """Run the app's `enable` or `disable` script; toast its last line."""
        page = self.pages.get(app.id)
        if app.toggling or (page and page.proc) or self.task_running():
            return
        app.toggling = True
        self.on_status(app)
        launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE)
        launcher.set_environ(script_env())
        launcher.set_cwd(str(app.path))
        try:
            proc = launcher.spawnv([str(app.path / ("enable" if on else "disable"))])
        except GLib.Error as e:
            app.toggling = False
            self.toast(f"Could not start: {e.message}")
            check_installed(app, self.on_status)
            return

        def done(proc, res):
            try:
                _, out, _ = proc.communicate_finish(res)
                out = text(out)
            except GLib.Error:
                out = ""
            lines = [ANSI_RE.sub("", l).strip() for l in out.splitlines()]
            lines = [l for l in lines if l and not l.startswith("==>")]
            if proc.get_successful():
                self.toast(f"{app.name}: {lines[-1]}" if lines else f"{app.name} turned {'on' if on else 'off'}")
            else:
                self.toast(f"Could not turn {app.name} {'on' if on else 'off'}" + (f": {lines[-1]}" if lines else ""))
            app.toggling = False
            check_installed(app, self.on_status)

        proc.communicate_async(None, None, done)

    def toast(self, text):
        self.toasts.add_toast(Adw.Toast(title=text, timeout=4))


class Application(Adw.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)

    def do_startup(self):
        Adw.Application.do_startup(self)
        # Window icon from the repo, so it shows even before install.sh has run
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(str(ROOT / "data"))
        Gtk.Window.set_default_icon_name(APP_ID)

    def do_activate(self):
        win = self.props.active_window or Window(self)
        win.present()


if __name__ == "__main__":
    sys.exit(Application().run(sys.argv))
