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
"""

import os
import re
import sys
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

    def script(self, name):
        p = self.path / name
        return p if p.exists() and os.access(p, os.X_OK) else None

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


def check_installed(app, callback):
    """Run the app's `installed` script asynchronously."""
    launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
    launcher.set_environ(script_env())
    proc = launcher.spawnv([str(app.path / "installed")])

    def done(proc, res):
        try:
            _, out, _ = proc.communicate_utf8_finish(res)
            app.installed = proc.get_successful()
            app.status = (out or "").strip().splitlines()[0] if (out or "").strip() else ""
        except GLib.Error:
            app.installed, app.status = False, ""
        callback(app)

    proc.communicate_utf8_async(None, None, done)


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

        # Action buttons
        self.actions = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, column_spacing=8,
                                   row_spacing=8, max_children_per_line=4, homogeneous=False,
                                   halign=Gtk.Align.START)
        box.append(self.actions)

        self.busy = Gtk.Box(spacing=12, visible=False)
        self.busy.append(Adw.Spinner(width_request=24, height_request=24))
        self.busy_label = Gtk.Label(xalign=0, hexpand=True, ellipsize=Pango.EllipsizeMode.END)
        self.busy.append(self.busy_label)
        cancel = Gtk.Button(label="Cancel")
        cancel.add_css_class("pill")
        cancel.connect("clicked", lambda *_: self.proc and self.proc.force_exit())
        self.busy.append(cancel)
        box.append(self.busy)

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

        while child := self.actions.get_first_child():
            self.actions.remove(child)
        running = self.proc is not None
        self.actions.set_visible(not running and app.installed is not None)
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

    # ---- actions ----

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

    def run(self, script, label):
        self.buffer.set_text("")
        self.urls.clear()
        while child := self.links.get_first_child():
            self.links.remove(child)
        self.links.set_visible(False)
        self.log_box.set_visible(True)
        self.busy_label.set_label(label)

        launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE)
        launcher.set_environ(script_env())
        launcher.set_cwd(str(self.app.path))
        try:
            self.proc = launcher.spawnv([str(self.app.path / script)])
        except GLib.Error as e:
            self.append(f"Failed to start: {e.message}\n")
            return
        self.window.on_status(self.app)
        stream = Gio.DataInputStream.new(self.proc.get_stdout_pipe())
        stream.read_line_async(GLib.PRIORITY_DEFAULT, None, self.on_line, stream)
        self.proc.wait_async(None, self.on_exit, script)

    def on_line(self, stream, res, _data):
        try:
            line, _ = stream.read_line_finish_utf8(res)
        except GLib.Error:
            line = None
        if line is None:
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

    def on_exit(self, proc, res, script):
        try:
            proc.wait_finish(res)
        except GLib.Error:
            pass
        ok = proc.get_if_exited() and proc.get_exit_status() == 0
        self.proc = None
        verb = {"install": "Install", "remove": "Removal", "setup": "Setup"}.get(script, script)
        if ok:
            self.window.toast(f"{verb} of {self.app.name} finished")
        else:
            self.append("\nFailed." if proc.get_if_exited() else "\nCancelled.")
            self.window.toast(f"{verb} of {self.app.name} failed")
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
            row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
            row.connect("activated", lambda _, a=app: self.show_app(a))
            group.add(row)
            self.rows[app.id] = (row, icon, badge)
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
        row, icon, badge = self.rows[app.id]
        icon.set_from_icon_name(app.icon_name(self))
        page = self.pages.get(app.id)
        busy = bool(page and page.proc)
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
