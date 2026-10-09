# Daylight Apps

A small GTK/libadwaita installer for this DC-1 (Nura / postmarketOS, aarch64, musl),
modelled on Omarchy's `omarchy-install-*` / `omarchy-installed-*` / `omarchy-remove-*` scripts.

Run `./install.sh` once to add it to the app grid, then open **Daylight Apps**.

## Apps

| App       | Installed via                                   | Setup step                                  |
|-----------|-------------------------------------------------|---------------------------------------------|
| Maestral  | Python venv in `~/.local/share/maestral-venv` + systemd user service | Link Dropbox account (opens a terminal)     |
| Tailscale | `apk add tailscale tailscale-systemd` (password prompt) | `tailscale up`; login link shows as a button |
| 1Password | Flathub `com.onepassword.OnePassword` (user)    | Open the app and sign in                    |

## Adding an app

Create `apps/<id>/` (or `~/.config/daylight-apps/apps/<id>/`) containing:

- `info`: `NAME=`, `SUMMARY=`, `ICON=` (space-separated icon names, first found wins),
  optional `WEBSITE=`, `SETUP_LABEL=`, `OPEN=` (desktop id or URL), `OPEN_LABEL=`
- `install`: installs or updates (also used for **Update**)
- `installed`: exit 0 when installed; first line of stdout is shown as status
- `remove`: uninstalls
- `setup` (optional): post-install step. Call `require_terminal "$0"` if it needs keyboard input.

Scripts source `lib/common.sh` for `step`, `info`, `fail`, `as_root` (one polkit prompt per
call), `apk_present`, `flatpak_present`, `in_terminal` and `require_terminal`.
Every script also works directly from a terminal, e.g. `apps/tailscale/install`.
URLs printed by a script become clickable buttons in the app.

## License

MIT, see [LICENSE](LICENSE).
