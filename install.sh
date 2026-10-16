#!/bin/bash
# Register dInstaller in the app grid and as `dinstaller` on PATH.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

ICONS="$HOME/.local/share/icons/hicolor"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$ICONS/scalable/apps"
"$DIR/lib/migrate-ids.sh"
ln -sf "$DIR/dinstaller.py" "$HOME/.local/bin/dinstaller"
cp "$DIR/data/io.github.jamesbondini.dInstaller.svg" "$ICONS/scalable/apps/"

cat > "$HOME/.local/share/applications/io.github.jamesbondini.dInstaller.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=dInstaller
Comment=Install and set up apps like Maestral, Tailscale and 1Password
Exec=$DIR/dinstaller.py
Icon=io.github.jamesbondini.dInstaller
Terminal=false
Categories=System;PackageManager;
Keywords=install;daylight;apps;tailscale;dropbox;maestral;1password;
StartupNotify=true
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -qtf "$ICONS" 2>/dev/null || true
echo "Installed. Open “dInstaller” from the app grid or run: dinstaller"
