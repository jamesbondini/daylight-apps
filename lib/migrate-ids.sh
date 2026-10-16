#!/bin/bash
# Move installs from older names to the current ones: the @finni and
# @jamesbondini extension UUIDs to @dawnos, the dev.finni app IDs to
# io.github.jamesbondini, and Daylight Apps (daylight-apps) to dInstaller.
# Settings are keyed by schema id, so they carry over. Safe to run any number
# of times.
source "$(dirname "$(readlink -f "$0")")/common.sh"

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
APPS_DIR="$HOME/.local/share/applications"
OLD_SUFFIXES=(@finni @jamesbondini)

in_strv() { case "$(gsettings get org.gnome.shell "$1")" in *"'$2'"*) return 0 ;; esac; return 1; }

for suffix in "${OLD_SUFFIXES[@]}"; do
  for old_dir in "$EXT_DIR"/*"$suffix"; do
    [ -d "$old_dir" ] || continue
    old=$(basename "$old_dir")
    new="${old%"$suffix"}@dawnos"
    [ -d "$REPO/extensions/$new" ] || continue

    step "Renaming the $old extension to $new"
    rm -rf "${EXT_DIR:?}/$new"
    cp -r "$REPO/extensions/$new" "$EXT_DIR/$new"
    [ -d "$EXT_DIR/$new/schemas" ] && glib-compile-schemas "$EXT_DIR/$new/schemas"
    if in_strv enabled-extensions "$old" && ! in_strv disabled-extensions "$old"; then
      # Leave the old one on until the next login, or the keyboard disappears now
      shell_strv_set enabled-extensions "$new" true
      info "Log out and back in to switch to it."
    fi
    rm -rf "$old_dir"
  done
done

# Old UUIDs whose files are gone and that the shell no longer runs
for list in enabled-extensions disabled-extensions; do
  for old in $(gsettings get org.gnome.shell "$list" | grep -oE "[a-z-]*@(finni|jamesbondini)" || true); do
    gnome-extensions info "$old" >/dev/null 2>&1 || shell_strv_set "$list" "$old" false
  done
done

# Daylight Apps' own folders. The old path stays as a link, so extensions the
# shell still runs from before the rename keep finding voice typing.
for base in "${XDG_DATA_HOME:-$HOME/.local/share}" "${XDG_CONFIG_HOME:-$HOME/.config}" \
    "${XDG_STATE_HOME:-$HOME/.local/state}"; do
  old="$base/daylight-apps" new="$base/dinstaller"
  [ -d "$old" ] && [ ! -L "$old" ] || continue
  if [ -e "$new" ]; then
    info "Both $old and $new exist; leaving $old for you to merge."
    continue
  fi
  step "Moving $old to $new"
  mv "$old" "$new"
  ln -s "$new" "$old"
done

rm -f "$APPS_DIR/dev.finni.DaylightApps.desktop" "$APPS_DIR/io.github.jamesbondini.DaylightApps.desktop" \
  "$HOME/.local/share/icons/hicolor/scalable/apps/io.github.jamesbondini.DaylightApps.svg"
[ -L "$HOME/.local/bin/daylight-apps" ] && rm -f "$HOME/.local/bin/daylight-apps"
if [ -f "$APPS_DIR/dev.finni.CrashHelper.desktop" ]; then
  mv "$APPS_DIR/dev.finni.CrashHelper.desktop" "$APPS_DIR/io.github.jamesbondini.CrashHelper.desktop"
  systemctl --user try-restart crash-helper.service 2>/dev/null || true
fi

# Crash Helper runs from the checkout, so point it at this one if it moved
unit="$HOME/.local/share/systemd/user/crash-helper.service"
if [ -f "$unit" ] && ! grep -qF "ExecStart=$REPO/" "$unit"; then
  step "Pointing Crash Helper at $REPO"
  "$REPO/apps/crash-helper/install" >/dev/null
  systemctl --user try-restart crash-helper.service 2>/dev/null || true
fi
