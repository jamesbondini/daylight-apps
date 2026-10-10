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

# Enable or disable a GNOME Shell extension. gnome-extensions only knows
# extensions the shell has loaded, so also edit the enabled-extensions list
# directly for ones installed during this session.
gnome_ext_set_enabled() {
  local uuid="$1" enable="$2"
  if [ "$enable" = true ]; then
    gnome-extensions enable "$uuid" 2>/dev/null || true
  else
    gnome-extensions disable "$uuid" 2>/dev/null || true
  fi
  local current
  current=$(gsettings get org.gnome.shell enabled-extensions)
  python3 - "$uuid" "$enable" "$current" <<'PY' | xargs -0 -r gsettings set org.gnome.shell enabled-extensions
import ast, sys
uuid, enable, current = sys.argv[1], sys.argv[2] == "true", sys.argv[3]
items = ast.literal_eval(current.removeprefix("@as ")) or []
new = [i for i in items if i != uuid] + ([uuid] if enable else [])
if enable and uuid in items:
    new = items
if new != items:
    print(repr(new), end="")
PY
  if [ "$enable" = true ]; then
    gsettings set org.gnome.shell disable-user-extensions false
  fi
}

# Exit 0 if a GNOME Shell extension is in the enabled-extensions list (it may
# only become active after logging out and in, if installed this session).
gnome_ext_enabled() {
  [ "$(gsettings get org.gnome.shell disable-user-extensions)" = false ] || return 1
  case "$(gsettings get org.gnome.shell enabled-extensions)" in
    *"'$1'"*) return 0 ;;
    *) return 1 ;;
  esac
}
