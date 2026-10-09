#!/bin/bash
# Register Daylight Apps in the app grid and as `daylight-apps` on PATH.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
ln -sf "$DIR/daylight-apps.py" "$HOME/.local/bin/daylight-apps"

cat > "$HOME/.local/share/applications/dev.finni.DaylightApps.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Daylight Apps
Comment=Install and set up apps like Maestral, Tailscale and 1Password
Exec=$DIR/daylight-apps.py
Icon=system-software-install
Terminal=false
Categories=System;PackageManager;
Keywords=install;apps;tailscale;dropbox;maestral;1password;
StartupNotify=true
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Installed. Open “Daylight Apps” from the app grid or run: daylight-apps"
