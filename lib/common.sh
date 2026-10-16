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

# Install Flatpak itself (asks for your password) and add the Flathub remote
# for the user, if missing. Apps it installs show up in the app grid only after
# logging out and in once, since that adds Flatpak's folders to XDG_DATA_DIRS.
# Keep its packages in sync with PACKAGES= in apps/flatpak/info.
ensure_flatpak() {
  if ! cmd_present flatpak; then
    step "Installing Flatpak (asks for your password)"
    as_root "$(apk_add_cmd flatpak)"
    info "Log out and in once afterwards so Flatpak apps show in the app grid."
  fi
  if ! flatpak remotes --user --columns=name 2>/dev/null | grep -qx flathub; then
    step "Adding the Flathub app source"
    flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
  fi
}

# Flathub apps, installed per-user (no root needed once Flatpak is present).
flatpak_install_app() {
  ensure_flatpak
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

# Open a command in a GNOME Console window, keeping it open afterwards so the
# user can read the result. Falls back to Ghostty (reusing the main,
# software-GL instance) where Console isn't installed.
in_terminal() {
  local cmd="$1; echo; read -rp 'Press Enter to close…' _"
  if cmd_present kgx; then
    setsid kgx -- bash -c "$cmd" >/dev/null 2>&1 &
    return 0
  fi
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

# The install, installed, enable and remove scripts of an extension that is
# just copied from extensions/<uuid> (no settings schema). Each takes the
# UUID, and install/enable/remove the message to show once it is done.
gnome_ext_dir() { echo "$HOME/.local/share/gnome-shell/extensions/$1"; }

gnome_ext_active() {
  gnome-extensions info "$1" 2>/dev/null | grep -q "State: ACTIVE"
}

gnome_ext_install() {
  local uuid="$1" active="$2"
  local src dest
  src="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../extensions/$uuid"
  dest=$(gnome_ext_dir "$uuid")

  # Update leaves an extension the user turned off switched off
  local was_off=
  [ -f "$dest/extension.js" ] && ! gnome_ext_enabled "$uuid" && was_off=1

  step "Copying extension to $dest"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -r "$src"/. "$dest"/

  if [ -n "$was_off" ]; then
    step "Done"
    info "Updated. It is still turned off; use the switch above to turn it on."
    return 0
  fi

  step "Enabling extension"
  gnome_ext_set_enabled "$uuid" true

  step "Done"
  if gnome_ext_active "$uuid"; then
    info "Active. $active"
  else
    info "Log out and back in to activate it (Wayland only loads new extensions at login)."
  fi
}

gnome_ext_installed() {
  local uuid="$1" state
  [ -f "$(gnome_ext_dir "$uuid")/extension.js" ] || return 1
  state=$(gnome-extensions info "$uuid" 2>/dev/null | awk -F': ' '/State:/ {print $2}' || true)
  case "$state" in
    ACTIVE)  echo "Active" ;;
    INACTIVE|DISABLED) echo "Disabled" ;;
    *)       echo "Log out and back in to activate" ;;
  esac
}

gnome_ext_enable() {
  local uuid="$1" on="$2"
  step "Enabling extension"
  gnome_ext_set_enabled "$uuid" true
  if gnome_ext_active "$uuid"; then
    info "On. $on"
  else
    info "Log out and back in to activate it."
  fi
}

gnome_ext_remove() {
  local uuid="$1" done="$2"
  step "Disabling extension"
  gnome_ext_set_enabled "$uuid" false

  step "Removing files"
  rm -rf "$(gnome_ext_dir "$uuid")"

  step "Done"
  info "$done"
}

# Speech model voice typing uses: the one picked in the Tablet Keyboard
# settings, else the first downloaded (see apps/voice-typing/models). Prints
# nothing when there is none.
voice_engine() {
  local schemas="$HOME/.local/share/gnome-shell/extensions/tablet-keyboard@dawnos/schemas"
  local picked
  picked=$(gsettings --schemadir "$schemas" get org.gnome.shell.extensions.tablet-keyboard voice-engine \
    2>/dev/null | tr -d "'") || true
  "${XDG_DATA_HOME:-$HOME/.local/share}/dinstaller/voice-typing/dictate" --resolve "$picked" 2>/dev/null || true
}

# Pick the speech model voice typing uses, or with no argument go back to the
# first downloaded one. Older keyboard schemas only know whisper and parakeet.
voice_set_engine() {
  local schemas="$HOME/.local/share/gnome-shell/extensions/tablet-keyboard@dawnos/schemas"
  if [ -n "${1:-}" ]; then
    gsettings --schemadir "$schemas" set org.gnome.shell.extensions.tablet-keyboard voice-engine "$1"
  else
    gsettings --schemadir "$schemas" reset org.gnome.shell.extensions.tablet-keyboard voice-engine
  fi 2>/dev/null
}

# The dictate options for the keyboard's Language and Battery saver settings,
# one per line
voice_options() {
  local schemas="$HOME/.local/share/gnome-shell/extensions/tablet-keyboard@dawnos/schemas"
  local key=org.gnome.shell.extensions.tablet-keyboard language saver
  language=$(gsettings --schemadir "$schemas" get $key voice-language 2>/dev/null | tr -d "'") || true
  saver=$(gsettings --schemadir "$schemas" get $key voice-battery-saver 2>/dev/null) || true
  if [ -n "$language" ]; then printf '%s\n' --language "$language"; fi
  if [ "$saver" = true ]; then echo --battery-saver; fi
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
' "$HOME/.local/share/gnome-shell/extensions/tablet-keyboard@dawnos/schemas" 2>/dev/null
}

# App recipe directories, one per line, sorted by id. Ones in
# ~/.config/dinstaller/apps override built-ins with the same id, as in the GUI.
app_dirs() {
  local repo user dir id
  repo="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../apps"
  user="${XDG_CONFIG_HOME:-$HOME/.config}/dinstaller/apps"
  local -A dirs=()
  for dir in "$repo"/*/ "$user"/*/; do
    [ -f "$dir/info" ] && [ -f "$dir/install" ] || continue
    # The id is the entry's own name, as in the GUI, even if it is a symlink
    id=$(basename "$dir")
    dirs[$id]=$(readlink -f "$dir")
  done
  for id in "${!dirs[@]}"; do echo "$id"; done | sort | while read -r id; do echo "${dirs[$id]}"; done
}

# A value from an app's info file, e.g. app_info "$dir" NAME
app_info() { sed -n "s/^$2=//p" "$1/info" | head -n 1; }

# Run one of an app's scripts, from its directory as the GUI does
app_run() { (cd "$1" && "./$2"); }

# Exit 0 if the app in this directory is installed
app_installed() { [ -x "$1/installed" ] && app_run "$1" installed >/dev/null 2>&1; }

# Names joined as "a, b, c"
join_names() { local IFS=,; echo "$*" | sed 's/,/, /g'; }

# Run the install script of each app directory under a "VERB <name>" step.
# Adds the names of those that fail to the caller's failed array, and sets
# extensions=1 if an extension was installed (it needs a logout to load).
app_install_each() {
  local verb=$1 dir name
  shift
  for dir in "$@"; do
    name=$(app_info "$dir" NAME)
    name=${name:-$(basename "$dir")}
    step "$verb $name"
    if ! app_run "$dir" install; then
      failed+=("$name")
    elif [ "$(app_info "$dir" CATEGORY)" = extensions ]; then
      extensions=1
    fi
  done
}
