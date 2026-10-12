#!/bin/bash
# Move installs from the old @finni extension UUIDs and dev.finni app IDs to
# the @jamesbondini / io.github.jamesbondini ones. Settings are keyed by
# schema id, so they carry over. Safe to run any number of times.
source "$(dirname "$(readlink -f "$0")")/common.sh"

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
APPS_DIR="$HOME/.local/share/applications"

in_strv() { case "$(gsettings get org.gnome.shell "$1")" in *"'$2'"*) return 0 ;; esac; return 1; }

for old_dir in "$EXT_DIR"/*@finni; do
  [ -d "$old_dir" ] || continue
  old=$(basename "$old_dir")
  new="${old%@finni}@jamesbondini"
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

# Old UUIDs whose files are gone and that the shell no longer runs
for list in enabled-extensions disabled-extensions; do
  for old in $(gsettings get org.gnome.shell "$list" | grep -o "[a-z-]*@finni" || true); do
    gnome-extensions info "$old" >/dev/null 2>&1 || shell_strv_set "$list" "$old" false
  done
done

rm -f "$APPS_DIR/dev.finni.DaylightApps.desktop"
if [ -f "$APPS_DIR/dev.finni.CrashHelper.desktop" ]; then
  mv "$APPS_DIR/dev.finni.CrashHelper.desktop" "$APPS_DIR/io.github.jamesbondini.CrashHelper.desktop"
  systemctl --user try-restart crash-helper.service 2>/dev/null || true
fi
