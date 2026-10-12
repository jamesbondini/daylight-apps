#!/bin/bash
# Register Daylight Apps in the app grid and as `daylight-apps` on PATH.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

ICONS="$HOME/.local/share/icons/hicolor"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$ICONS/scalable/apps"
"$DIR/lib/migrate-ids.sh"
ln -sf "$DIR/daylight-apps.py" "$HOME/.local/bin/daylight-apps"
cp "$DIR/data/io.github.jamesbondini.DaylightApps.svg" "$ICONS/scalable/apps/"

cat > "$HOME/.local/share/applications/io.github.jamesbondini.DaylightApps.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Daylight Apps
Comment=Install and set up apps like Maestral, Tailscale and 1Password
Exec=$DIR/daylight-apps.py
Icon=io.github.jamesbondini.DaylightApps
Terminal=false
Categories=System;PackageManager;
Keywords=install;apps;tailscale;dropbox;maestral;1password;
StartupNotify=true
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -qtf "$ICONS" 2>/dev/null || true
echo "Installed. Open “Daylight Apps” from the app grid or run: daylight-apps"
