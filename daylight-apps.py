#!/usr/bin/env python3
"""Daylight Apps: a small GTK front end for the scripts in apps/<id>/.

Each app directory holds (in the spirit of Omarchy's install/installed/remove
scripts):
  info       KEY=value metadata (NAME, SUMMARY, ICON, WEBSITE, SETUP_LABEL,
             OPEN, OPEN_LABEL)
  install    install or update the app
  installed  exit 0 if installed, printing a one-line status
  remove     uninstall the app
  setup      optional post-install step (login, account linking, ...)
  enabled    optional: exit 0 if turned on; with `enable` and `disable`
             this adds an on/off switch (e.g. for GNOME Shell extensions)
  extras     optional: list optional parts (e.g. models), one per line as
             ID|Title|Subtitle|yes-or-no (downloaded); `extra-add ID` and
             `extra-remove ID` download and delete one. Group title comes
             from EXTRAS_TITLE in info.
  page.py    optional: Python module whose build(window) returns a widget
             (or None) shown on the app's page while it is installed, for
             settings such as Hardware Buttons'.
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
from gi.repository import Adw, Gio, GLib, Gtk, Pango  # noqa: E402

APP_ID = "dev.finni.DaylightApps"
ROOT = Path(__file__).resolve().parent
APP_DIRS = [ROOT / "apps", Path(GLib.get_user_config_dir()) / "daylight-apps" / "apps"]

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
        self.installed = None  # None = unknown
        self.status = ""
        self.enabled = None  # None = unknown or not switchable
        self.extras = []  # (id, title, subtitle, present)
        self.toggling = False

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


def check_installed(app, callback):
    """Run the app's `installed` script asynchronously."""
    launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
    launcher.set_environ(script_env())
    try:
        proc = launcher.spawnv([str(app.path / "installed")])
    except GLib.Error:  # missing or not executable
        app.installed, app.status, app.enabled, app.extras = False, "", None, []
        callback(app)
        return

    def done(proc, res):
        try:
            _, out, _ = proc.communicate_utf8_finish(res)
            app.installed = proc.get_successful()
            app.status = (out or "").strip().splitlines()[0] if (out or "").strip() else ""
        except GLib.Error:
            app.installed, app.status = False, ""
        app.enabled = None
        if not app.installed:
            app.extras = []
        after_extras = lambda: (check_enabled(app, callback) if app.installed and app.switchable
                                else callback(app))
        if app.installed and app.script("extras"):
            check_extras(app, after_extras)
        else:
            after_extras()

    proc.communicate_utf8_async(None, None, done)


def check_extras(app, callback):
    """Run the app's `extras` script asynchronously."""
    launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
    launcher.set_environ(script_env())
    proc = launcher.spawnv([str(app.path / "extras")])

    def done(proc, res):
        try:
            _, out, _ = proc.communicate_utf8_finish(res)
        except GLib.Error:
            out = ""
        app.extras = []
        for line in (out or "").splitlines():
            parts = line.split("|")
            if len(parts) == 4:
                app.extras.append((parts[0], parts[1], parts[2], parts[3].strip() == "yes"))
        callback()

    proc.communicate_utf8_async(None, None, done)


def check_enabled(app, callback):
    """Run the app's `enabled` script asynchronously."""
    launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE)
    launcher.set_environ(script_env())
    proc = launcher.spawnv([str(app.path / "enabled")])

    def done(proc, res):
        try:
            proc.wait_finish(res)
            app.enabled = proc.get_successful()
        except GLib.Error:
            app.enabled = None
        callback(app)

    proc.wait_async(None, done)


class AppPage(Adw.NavigationPage):
    """Detail page: status, actions and live script output for one app."""

    def __init__(self, window, app):
        super().__init__(title=app.name, tag=app.id)
        self.window = window
        self.app = app
        self.proc = None
        self.urls = set()

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

        # On/off switch for apps that have one
        self.switch_group = Adw.PreferencesGroup(visible=False)
        self.switch_row = Adw.SwitchRow(title="Turned On")
        self.switch_row.connect("notify::active", self.on_switch)
        self.switch_group.add(self.switch_row)
        box.append(self.switch_group)

        # Settings from the app's page.py, built once it is installed
        self.custom_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, visible=False)
        self.custom = None
        box.append(self.custom_box)

        # Optional parts, e.g. downloadable models
        self.extras_group = Adw.PreferencesGroup(title=app.meta.get("EXTRAS_TITLE", "Extras"), visible=False)
        self.extra_rows = []

        # Action buttons
        self.actions = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, column_spacing=8,
                                   row_spacing=8, max_children_per_line=4, homogeneous=False,
                                   halign=Gtk.Align.START)
        box.append(self.actions)

        self.busy = Gtk.Box(spacing=12, visible=False)
        self.busy.append(Adw.Spinner(width_request=24, height_request=24))
        self.busy_label = Gtk.Label(xalign=0, hexpand=True, ellipsize=Pango.EllipsizeMode.END)
        self.busy.append(self.busy_label)
        self.cancel_button = Gtk.Button(label="Cancel")
        self.cancel_button.add_css_class("pill")
        self.cancel_button.connect("clicked", lambda *_: self.cancel())
        self.busy.append(self.cancel_button)
        box.append(self.busy)
        box.append(self.extras_group)

        # Links found in the output (e.g. Tailscale login URL)
        self.links = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, visible=False)
        box.append(self.links)

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
        box.append(self.log_box)

        self.connect("showing", lambda *_: self.refresh())
        self.update()

    # ---- state ----

    def refresh(self):
        if not self.proc:
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

        running = self.proc is not None
        self.switch_group.set_visible(bool(app.installed) and app.enabled is not None)
        if app.enabled is not None and not app.toggling:
            self.syncing = True
            self.switch_row.set_active(app.enabled)
            self.syncing = False
        self.switch_row.set_sensitive(not running and not app.toggling)
        self.switch_row.set_subtitle("Switching…" if app.toggling else app.status)
        self.update_extras(running or app.toggling)
        if app.installed and not self.custom:
            self.custom = build_custom_page(app, self.window)
            if self.custom:
                self.custom_box.append(self.custom)
        self.custom_box.set_visible(bool(app.installed) and self.custom is not None)

        while child := self.actions.get_first_child():
            self.actions.remove(child)
        self.actions.set_visible(not running and app.installed is not None)
        self.actions.set_sensitive(not app.toggling)
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
        if self.proc or self.app.toggling:
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

        launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE)
        launcher.set_environ(script_env())
        launcher.set_cwd(str(self.app.path))
        try:
            # Own session, so Cancel can find and stop the script's children too.
            self.proc = launcher.spawnv(["setsid", str(self.app.path / script), *args])
        except GLib.Error as e:
            self.append(f"Failed to start: {e.message}\n")
            return
        self.sid = int(self.proc.get_identifier())
        self.window.on_status(self.app)
        self.stream = stream = Gio.DataInputStream.new(self.proc.get_stdout_pipe())
        stream.read_line_async(GLib.PRIORITY_DEFAULT, None, self.on_line, stream)
        self.proc.wait_async(None, self.on_exit, (script, what or self.app.name))

    def on_line(self, stream, res, _data):
        if stream is not self.stream:  # left over from an earlier run
            return
        try:
            line, _ = stream.read_line_finish_utf8(res)
        except GLib.Error:
            line = None
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

    def on_exit(self, proc, res, data):
        try:
            proc.wait_finish(res)
        except GLib.Error:
            pass
        self.exit_data = data
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
        script, what = self.exit_data
        proc = self.proc
        ok = proc.get_if_exited() and proc.get_exit_status() == 0
        self.proc = None
        verb = {"install": "Install", "remove": "Removal", "setup": "Setup",
                "extra-add": "Download", "extra-remove": "Removal"}.get(script, script)
        if ok:
            self.window.toast(f"{verb} of {what} finished")
        elif self.cancelling:
            self.append("\nCancelled.")
            self.window.toast(f"{verb} of {what} cancelled")
        else:
            self.append("\nFailed." if proc.get_if_exited() else "\nCancelled.")
            self.window.toast(f"{verb} of {what} failed")
        self.app.installed = None
        self.window.on_status(self.app)
        self.refresh()


class Window(Adw.ApplicationWindow):
    def __init__(self, application):
        super().__init__(application=application, title="Daylight Apps", default_width=720, default_height=900)
        self.apps = load_apps()
        self.rows = {}
        self.pages = {}

        self.toasts = Adw.ToastOverlay()
        self.nav = Adw.NavigationView()
        self.toasts.set_child(self.nav)
        self.set_content(self.toasts)

        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()
        refresh = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh")
        refresh.connect("clicked", lambda *_: self.refresh_all())
        header.pack_start(refresh)
        toolbar.add_top_bar(header)

        page = Adw.PreferencesPage()
        group = Adw.PreferencesGroup(title="Apps", description="Install and set up apps on this device.")
        page.add(group)
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
            group.add(row)
            self.rows[app.id] = (row, icon, badge, switch)
        if not self.apps:
            page = Adw.StatusPage(title="No Apps", description=f"Add app recipes to {APP_DIRS[-1]}",
                                  icon_name="system-software-install-symbolic")
        toolbar.set_content(page)
        self.nav.add(Adw.NavigationPage(title="Daylight Apps", tag="main", child=toolbar))

        # Re-check when coming back to the window (e.g. after a terminal setup).
        self.connect("notify::is-active", lambda *_: self.is_active() and self.refresh_all())
        self.refresh_all()

    def show_app(self, app):
        if app.id not in self.pages:
            self.pages[app.id] = AppPage(self, app)
        self.nav.push(self.pages[app.id])

    def refresh_all(self):
        for app in self.apps:
            page = self.pages.get(app.id)
            if not (page and page.proc):
                check_installed(app, self.on_status)

    def on_status(self, app):
        row, icon, badge, switch = self.rows[app.id]
        icon.set_from_icon_name(app.icon_name(self))
        page = self.pages.get(app.id)
        busy = bool(page and page.proc)
        switch.set_visible(bool(app.installed) and app.enabled is not None and not busy)
        if app.enabled is not None and not app.toggling:
            self.syncing = True
            switch.set_active(app.enabled)
            self.syncing = False
        switch.set_sensitive(not app.toggling)
        for cls in ("success", "dim-label", "accent"):
            badge.remove_css_class(cls)
        if busy:
            badge.set_label("Working…")
            badge.add_css_class("accent")
        elif app.installed:
            badge.set_label("Installed")
            badge.add_css_class("success")
        elif app.installed is False:
            badge.set_label("")
        if page:
            page.update()

    def on_row_switch(self, switch, _pspec, app):
        if not getattr(self, "syncing", False) and switch.get_active() != app.enabled:
            self.toggle(app, switch.get_active())

    def toggle(self, app, on):
        """Run the app's `enable` or `disable` script; toast its last line."""
        page = self.pages.get(app.id)
        if app.toggling or (page and page.proc):
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
                _, out, _ = proc.communicate_utf8_finish(res)
            except GLib.Error:
                out = ""
            lines = [ANSI_RE.sub("", l).strip() for l in (out or "").splitlines()]
            lines = [l for l in lines if l and not l.startswith("==>")]
            if proc.get_successful():
                self.toast(f"{app.name}: {lines[-1]}" if lines else f"{app.name} turned {'on' if on else 'off'}")
            else:
                self.toast(f"Could not turn {app.name} {'on' if on else 'off'}" + (f": {lines[-1]}" if lines else ""))
            app.toggling = False
            check_installed(app, self.on_status)

        proc.communicate_utf8_async(None, None, done)

    def toast(self, text):
        self.toasts.add_toast(Adw.Toast(title=text, timeout=4))


class Application(Adw.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)

    def do_activate(self):
        win = self.props.active_window or Window(self)
        win.present()


if __name__ == "__main__":
    sys.exit(Application().run(sys.argv))
