# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Daylight Apps is a GTK4/libadwaita installer for the Daylight DC-1 running postmarketOS (Nura):
**aarch64, musl, BusyBox userland, GNOME Shell 48 on Wayland**. It is modelled on Omarchy's
`omarchy-install-*` / `omarchy-installed-*` / `omarchy-remove-*` scripts. Development happens on the
device itself, so commands can be run and the app tested right here.

The README is the user-facing documentation (one table row per app, plus the "Adding an app"
contract). Keep it in sync when adding, removing or changing what an app does.

## Commands

There is no build step, test suite or linter config.

```sh
./daylight-apps.py                 # run the GUI straight from the checkout
./install.sh                       # register it in the app grid / as `daylight-apps` (symlinks to this checkout)
apps/<id>/install                  # every app script also runs directly from a terminal
apps/<id>/installed; echo $?       # check status: exit code + first line of stdout
bash -n apps/<id>/<script>         # syntax-check a script
python3 -m py_compile daylight-apps.py apps/*/page.py
journalctl -b -o cat /usr/bin/gnome-shell   # GNOME Shell extension logs/errors
```

Extensions in `extensions/` are **copied** (not linked) into
`~/.local/share/gnome-shell/extensions/<uuid>` by `apps/<id>/install`, which also compiles their
GSettings schemas. After editing extension code, re-run its install script; on Wayland the shell only
reloads extension JS after logging out and in.

## Architecture

**`daylight-apps.py`** (single file) discovers app recipes in `apps/` and
`~/.config/daylight-apps/apps/` (user dir overrides built-ins by id). It knows nothing about any
particular app: all behaviour lives in each `apps/<id>/` directory's executable scripts, and the GUI
only runs them and interprets their output. The script contract (`info`, `install`, `installed`,
`remove`, optional `setup`, `enabled`/`enable`/`disable`, `extras`/`extra-add`/`extra-remove`,
`page.py`) is documented in the module docstring and the README; read those before adding an app.

How the GUI runs scripts, which shapes how scripts should be written:
- Run asynchronously via `Gio.Subprocess` with `TERM=dumb NO_COLOR=1`, cwd = the app dir, under
  `setsid` so Cancel can SIGTERM the whole session. stderr is merged into the streamed log.
- ANSI codes are stripped and `\r` progress lines collapse to their final state.
- Any `http(s)://` URL printed becomes a clickable button (e.g. Tailscale's login link).
- `installed`: exit code = installed or not; the first stdout line is the status text.
- `enable`/`disable`: the last non-`==>` output line becomes the toast.
- Scripts without a terminal (GUI) that need keyboard input call `require_terminal "$0"`, which
  re-execs them in GNOME Console (`kgx`), falling back to Ghostty.
- `info` `CATEGORY` values map to groups via `CATEGORIES` in `daylight-apps.py`: `setup` (Start Here),
  `apps`, `developer`, `services`, `extensions`. `NEEDS=<id ...>` gates the Install button until
  those apps are installed.
- `page.py` is imported in-process; `build(window)` returns a widget. Exceptions are caught and
  printed so a broken page cannot crash the app.

**`lib/common.sh`** is sourced by every script with the readlink-resolved header (scripts may be
reached via symlinks):

```sh
source "$(dirname "$(readlink -f "$0")")/../../lib/common.sh"
```

It sets `set -euo pipefail` and provides `step`/`info`/`fail` (the `==>` / indented output style),
`as_root`, apk and Flatpak helpers, `gnome_ext_set_enabled`/`gnome_ext_enabled`, the
`gnome_ext_install`/`installed`/`enable`/`remove` scripts of an extension without settings, and
`in_terminal`/`require_terminal`. Use these rather than reimplementing them.

**`extensions/<name>@jamesbondini/`** are GNOME Shell 48 extensions (ESM gjs), each wrapped by an
`apps/<id>/` recipe in the `extensions` category. Some span both sides:
- Hardware Buttons: settings UI is `apps/hardware-buttons/page.py`; the extension reads the same
  GSettings schema. `shell-keys` takes over/returns GNOME's own shortcuts for those keys.
- Voice Typing is an add-on to Tablet Keyboard: `apps/voice-typing/dictate` and the speech model
  registry `apps/voice-typing/models` are installed to `~/.local/share/daylight-apps/voice-typing/`.
  The keyboard's `voice.js` runs `dictate`; the keyboard (`voicemodels.js`) and the app's scripts
  all read the installed `models`, so a model is added by adding a line there. Its `voice-engine`
  setting stores a model ID; empty means the first downloaded model.

Paired lists that must be kept in sync by hand (each side has a comment pointing at the other):
- `ACTIONS` in `apps/hardware-buttons/page.py` ↔ `extensions/hardware-buttons@jamesbondini/extension.js`

**IDs**: extension UUIDs use `@jamesbondini`, app/desktop ids `io.github.jamesbondini.*`.
`lib/migrate-ids.sh` (run by `install.sh`) moves old `@finni` / `dev.finni.*` installs over; keep it
idempotent.

## Platform gotchas

- musl + BusyBox: no GNU-only flags (e.g. BusyBox `xargs` has no `-d`); prefer portable shell/Python.
- `apk add`/`del` can exit non-zero because of unrelated broken packages; use `apk_add_cmd` /
  `apk_del_cmd`, which verify the result instead of trusting the exit code.
- `as_root` shows one polkit prompt per call, so batch all privileged work into a single call.
- Flathub apps are installed `--user`; they only appear in the app grid after Flatpak's first
  logout/login. A Flathub app needs just three one-line scripts (see `apps/localsend/`).
- Per-app data lives under `~/.local/share/daylight-apps/<id>/`; `remove` should keep user
  settings and data (the Remove dialog promises this).

## Conventions

- User-facing text (summaries, `info` output, toasts, README) is plain, non-technical English that
  says what will happen, e.g. "(asks for your password)" before a root step, and "Log out and back
  in to activate it" when an extension isn't active yet.
- Script files open with a one-line comment saying what they do; comments explain *why*.
- Commit subjects: `<App or area>: <what changed>` (e.g. `Tablet Keyboard: ...`, `README: ...`) or
  `Add <App>: <what it does>`.
- Apps we wrote ourselves but modelled on another project get `BASED_ON=` in `info` for credit.
