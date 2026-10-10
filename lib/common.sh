# Shared helpers sourced by every app script.
# Scripts run either from the Installer GUI (output streamed to its log view)
# or directly from a terminal.

set -euo pipefail

step() { echo; echo "==> $*"; }
info() { echo "    $*"; }
fail() { echo "!! $*" >&2; exit 1; }

cmd_present() { command -v "$1" >/dev/null 2>&1; }

# Run a shell snippet as root. One graphical polkit prompt per call, so batch
# privileged work into a single call where possible.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    bash -euo pipefail -c "$1"
  elif [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ] && cmd_present pkexec; then
    pkexec bash -euo pipefail -c "$1"
  else
    sudo bash -euo pipefail -c "$1"
  fi
}

apk_present() {
  for pkg in "$@"; do apk info -e "$pkg" >/dev/null 2>&1 || return 1; done
}

# Shell snippets for use inside as_root. apk can exit non-zero because of an
# unrelated broken package, so check the result instead of trusting the exit code.
apk_add_cmd() {
  printf 'apk add %s || true\n' "$*"
  printf 'for p in %s; do apk info -e "$p" >/dev/null || { echo "Package $p did not install" >&2; exit 1; }; done\n' "$*"
}
apk_del_cmd() {
  printf 'apk del %s || true\n' "$*"
  printf 'for p in %s; do ! apk info -e "$p" >/dev/null || { echo "Package $p was not removed" >&2; exit 1; }; done\n' "$*"
}

flatpak_present() { flatpak info "$1" >/dev/null 2>&1; }

# Flathub apps, installed per-user (no root needed).
flatpak_install_app() {
  flatpak install --user -y --noninteractive flathub "$1"
}
flatpak_status() {
  flatpak_present "$1" || return 1
  local ver
  ver=$(flatpak info "$1" 2>/dev/null | awk -F': *' '/Version:/ {print $2; exit}')
  echo "v${ver:-?} · Flatpak"
}
flatpak_remove_app() {
  flatpak uninstall -y --noninteractive "$1"
}

# Open a command in a Ghostty window (reusing the main, software-GL instance),
# keeping it open afterwards so the user can read the result.
in_terminal() {
  local cmd="$1; echo; read -rp 'Press Enter to close…' _"
  if ghostty +new-window -e bash -c "$cmd" 2>/dev/null; then
    return 0
  fi
  setsid env LIBGL_ALWAYS_SOFTWARE=1 ghostty --gtk-single-instance=true -e bash -c "$cmd" >/dev/null 2>&1 &
}

# Re-exec the calling script inside a terminal when it was not started from one
# (e.g. from the GUI). Use at the top of interactive scripts: require_terminal "$0"
require_terminal() {
  if [ ! -t 0 ]; then
    in_terminal "$(printf '%q' "$1")"
    echo "Opened in a terminal window."
    exit 0
  fi
}

# Add or remove an item of an org.gnome.shell string list, e.g. enabled-extensions.
shell_strv_set() {
  local key="$1" item="$2" add="$3" current
  current=$(gsettings get org.gnome.shell "$key")
  python3 - "$item" "$add" "$current" <<'PY' | xargs -0 -r gsettings set org.gnome.shell "$key"
import ast, sys
item, add, current = sys.argv[1], sys.argv[2] == "true", sys.argv[3]
items = ast.literal_eval(current.removeprefix("@as ")) or []
new = [i for i in items if i != item] + ([item] if add else [])
if add and item in items:
    new = items
if new != items:
    print(repr(new), end="")
PY
}

# Enable or disable a GNOME Shell extension. gnome-extensions only knows
# extensions the shell has loaded, so also edit the enabled-extensions list
# directly for ones installed during this session. disabled-extensions wins
# over enabled-extensions, and `gnome-extensions disable` adds to it, so
# enabling also takes the extension off that list.
gnome_ext_set_enabled() {
  local uuid="$1" enable="$2"
  if [ "$enable" = true ]; then
    gnome-extensions enable "$uuid" 2>/dev/null || true
  else
    gnome-extensions disable "$uuid" 2>/dev/null || true
  fi
  shell_strv_set enabled-extensions "$uuid" "$enable"
  if [ "$enable" = true ]; then
    shell_strv_set disabled-extensions "$uuid" false
    gsettings set org.gnome.shell disable-user-extensions false
  fi
}

# Exit 0 if a GNOME Shell extension is in the enabled-extensions list (it may
# only become active after logging out and in, if installed this session).
gnome_ext_enabled() {
  [ "$(gsettings get org.gnome.shell disable-user-extensions)" = false ] || return 1
  case "$(gsettings get org.gnome.shell disabled-extensions)" in
    *"'$1'"*) return 1 ;;
  esac
  case "$(gsettings get org.gnome.shell enabled-extensions)" in
    *"'$1'"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Voice typing engine picked in the Tablet Keyboard settings (whisper or parakeet)
voice_engine() {
  local schemas="$HOME/.local/share/gnome-shell/extensions/tablet-keyboard@finni/schemas"
  gsettings --schemadir "$schemas" get org.gnome.shell.extensions.tablet-keyboard voice-engine \
    2>/dev/null | tr -d "'" | grep -x 'whisper\|parakeet' || echo whisper
}

# The voice dictionary from the keyboard settings, one entry per line
voice_words() {
  python3 -I -c '
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio
import sys
src = Gio.SettingsSchemaSource.new_from_directory(sys.argv[1],
    Gio.SettingsSchemaSource.get_default(), False)
schema = src.lookup("org.gnome.shell.extensions.tablet-keyboard", False)
if schema and schema.has_key("voice-words"):
    for w in Gio.Settings.new_full(schema, None, None).get_strv("voice-words"):
        print(w)
' "$HOME/.local/share/gnome-shell/extensions/tablet-keyboard@finni/schemas" 2>/dev/null
}
