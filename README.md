# Daylight Apps

A small GTK/libadwaita installer for the Daylight DC-1 (Nura / postmarketOS, aarch64, musl),
modelled on Omarchy's `omarchy-install-*` / `omarchy-installed-*` / `omarchy-remove-*` scripts.

## Getting started

Install the dependencies (most are already present on Nura with GNOME):

```sh
sudo apk add git python3 py3-gobject3 gtk4.0 libadwaita
```

Download Daylight Apps and add it to the app grid:

```sh
git clone https://github.com/jamesbondini/daylight-apps.git ~/Projects/daylight-apps
cd ~/Projects/daylight-apps
./install.sh
```

Then open **Daylight Apps** from the app grid, or run `daylight-apps` in a terminal.

To update later:

```sh
cd ~/Projects/daylight-apps && git pull
```

`install.sh` links to the cloned folder, so keep it where you cloned it
(re-run `./install.sh` if you move it).

## Apps

| App       | Installed via                                   | Setup step                                  |
|-----------|-------------------------------------------------|---------------------------------------------|
| Maestral  | Python venv in `~/.local/share/maestral-venv` + systemd user service | Link Dropbox account (opens a terminal)     |
| Tailscale | `apk add tailscale tailscale-systemd` (password prompt) | `tailscale up`; login link shows as a button |
| 1Password | Flathub `com.onepassword.OnePassword` (user)    | Open the app and sign in                    |
| LocalSend | Flathub `org.localsend.localsend_app` (user) | None |
| Obsidian  | Flathub `md.obsidian.Obsidian` (user) | Open the app and pick a vault |
| Déjà Dup  | Flathub `org.gnome.DejaDup` (user) | Open the app and choose what to back up and where |
| Signal    | Flathub `org.signal.Signal` (user) | Open the app and link it to your phone |
| VS Code   | Flathub `com.visualstudio.code` (user) | None |
| Neovim    | Flathub `io.neovim.nvim` (user) + `nvim` command in `~/.local/bin` | Opens `nvim` in a terminal |
| Brave     | Flathub `com.brave.Browser` (user) + `/etc/brave/policies/managed/daylight-apps.json` turning off Rewards, Wallet, VPN, Leo, News and telemetry (Brave Origin has no musl build) | None |
| Claude Code | Official native installer (`claude.ai/install.sh`, arm64-musl) + `libgcc libstdc++ ripgrep` | Opens `claude` in a terminal to sign in |
| Maximize New Windows | Bundled GNOME Shell extension (`extensions/maximize-new-windows@finni`), see [dc-1-pmos#10](https://github.com/denysvitali/dc-1-pmos/issues/10) | None; log out and in if it was newly installed |

## Adding an app

Create `apps/<id>/` (or `~/.config/daylight-apps/apps/<id>/`) containing:

- `info`: `NAME=`, `SUMMARY=`, `ICON=` (space-separated icon names, first found wins),
  optional `WEBSITE=`, `SETUP_LABEL=`, `OPEN=` (desktop id or URL), `OPEN_LABEL=`
- `install`: installs or updates (also used for **Update**)
- `installed`: exit 0 when installed; first line of stdout is shown as status
- `remove`: uninstalls
- `setup` (optional): post-install step. Call `require_terminal "$0"` if it needs keyboard input.

Scripts source `lib/common.sh` for `step`, `info`, `fail`, `as_root` (one polkit prompt per
call), `apk_present`, `apk_add_cmd`/`apk_del_cmd`, `flatpak_install_app`/`flatpak_status`/
`flatpak_remove_app`, `gnome_ext_set_enabled`, `in_terminal` and `require_terminal`.
A Flathub app needs only three one-line scripts; see `apps/localsend/`.
Every script also works directly from a terminal, e.g. `apps/tailscale/install`.
URLs printed by a script become clickable buttons in the app.

## License

MIT, see [LICENSE](LICENSE).
