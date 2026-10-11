#!/bin/bash
# One-line install of Daylight Apps:
#   curl -fsSL https://raw.githubusercontent.com/jamesbondini/daylight-apps/main/get.sh | bash
# Installs the dependencies, clones the repo to ~/Projects/daylight-apps (or
# updates an existing clone there) and adds the app to the app grid.
set -euo pipefail

REPO=https://github.com/jamesbondini/daylight-apps.git
DEST="$HOME/Projects/daylight-apps"
DEPS=(git python3 py3-gobject3 gtk4.0 libadwaita)

# Everything runs from main, so a download cut short runs nothing
main() {
  local missing=()
  for pkg in "${DEPS[@]}"; do
    apk info -e "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "==> Installing ${missing[*]} (asks for your password)"
    sudo apk add "${missing[@]}"
  fi

  if [ -d "$DEST/.git" ]; then
    echo "==> Updating $DEST"
    git -C "$DEST" pull --ff-only
  elif [ -e "$DEST" ]; then
    echo "!! $DEST exists but is not a git clone; move it away and try again" >&2
    exit 1
  else
    echo "==> Downloading to $DEST"
    mkdir -p "$(dirname "$DEST")"
    git clone "$REPO" "$DEST"
  fi

  echo "==> Adding Daylight Apps to the app grid"
  "$DEST/install.sh"
}

main
