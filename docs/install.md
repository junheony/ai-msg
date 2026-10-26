# Installing AI-MSG

English | [한국어](install.ko.md)

AI-MSG runs on your own computer and drives the coding-agent CLIs you have installed and logged in to. This guide covers installing it, logging in to each CLI, reaching it from your phone, running it as a service, upgrading and removing it.

## Requirements

| | |
|---|---|
| Node.js | 24 or newer |
| OS | macOS (the supported platform) or Linux (runs the server and the Claude and Codex engines, less tested). Windows is not supported yet. |
| At least one CLI | Claude Code (`claude`, 2.1.259 or newer, 2.1.283 recommended), Codex CLI (`codex`, 0.159 or newer), Gemini through the Antigravity CLI (`agy`), Grok Build CLI (`grok`) |
| Optional | Tailscale, to open it from your phone |

## Quick start

```bash
npx ai-msg
```

> **Not on npm yet:** the package is not published, so the line above does not work today — run AI-MSG from the repository instead, as described in [CONTRIBUTING.md](../CONTRIBUTING.md#run-from-the-repository). <!-- npm-pending -->

The terminal prints a login address:

```
AI-MSG: login address http://127.0.0.1:9320/#token=… (opening it logs you in at once — don't show it to anyone)
```

Open it in a browser on the same computer. The first-run setup lists the four CLIs, shows which are installed and logged in, and gives the login command for each one that is not. You can open it again later from Settings.

The address carries the login token, so it is printed only on a terminal, never into a service log. The token is created on first start in `~/.config/deck/token` (mode `0600`). To sign every browser out, delete that file and restart.

## Log in to each CLI

AI-MSG never logs in for you and never reads the CLIs' tokens. Log in once in a terminal with each CLI's own command:

| CLI | Command |
|---|---|
| Claude Code | `claude auth login` |
| Codex | `codex login` |
| Gemini (Antigravity) | run `agy` with no arguments, then sign in to Google in the browser |
| Grok | `grok login` |

A second Claude account is a second Claude Code profile folder, for example `CLAUDE_CONFIG_DIR=~/.claude-b claude auth login`. See [Multiple Claude accounts](../README.md#multiple-claude-accounts). Restart AI-MSG after installing a new CLI so it is found.

## Language

Pick English or Korean in Settings › Screen › Language (the first group in Settings). The pick applies to that device; notifications and server messages use the language last picked on any device. Until a language has been picked, the server follows `DECK_LANG` (`en` or `ko`), then `LC_ALL`, `LC_MESSAGES` and `LANG`, then English. `ai-msg --help`, `ai-msg doctor` and `ai-msg service install` follow the terminal's environment.

The interface is being translated; some screens are still in Korean.

## Open it from your phone

The server listens on `127.0.0.1` and on this computer's Tailscale address, never on `0.0.0.0`. With Tailscale on both devices, open `http://<tailscale-ip>:9320` on the phone. Web Push and installing the app on the home screen need HTTPS; `tailscale serve` provides it, for example:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:9320
```

Details and the `Host` rules: [Remote access](../README.md#remote-access). Reaching your sessions from anywhere without Tailscale or HTTPS setup is planned for Pro (coming soon).

## Check the install

```bash
ai-msg doctor          # which CLIs are installed and logged in, per Claude profile
ai-msg doctor --json   # the same as JSON
ai-msg login-url       # print the login address again
```

`login-url` reads the running server's port; if no server is running it builds the address from `DECK_PORT` (default `9320`) and says so.

## Run as a service

A service starts AI-MSG when you log in and restarts it if it exits. It cannot run from the npx cache (the cache can be cleared under it), so install the package globally first:

```bash
npm i -g ai-msg
ai-msg service install --dry-run   # print the files and commands, change nothing
ai-msg service install             # asks before writing; --yes skips the question
ai-msg service status
```

On macOS this is a LaunchAgent (`local.ai-msg.server`); on Linux a systemd user unit (`ai-msg.service`).

Options of `service install`:

| Option | Meaning |
|---|---|
| `--dry-run` | Show what would be written and run; write nothing. |
| `--yes` | Do not ask for confirmation (needed when not on a terminal). |
| `--node <path>` | The node binary the service runs. Default: the node running the command. |
| `--port N` | Port for the service (default `DECK_PORT` or `9320`). |
| `--drain-max-min N` | On stop or restart, minutes (1–28, default 25) to let running turns finish. |

Things the installer checks:

- **No version-manager node.** A node from nvm, fnm, volta, asdf, mise or n breaks the service when you switch versions, so it is refused. Pass a stable one, for example `ai-msg service install --node /opt/homebrew/bin/node`.
- **macOS:** run it from a logged-in desktop session, not over SSH (a LaunchAgent cannot be loaded there). If your projects are under `~/Documents`, Desktop or Downloads, add the node path the installer prints under System Settings › Privacy & Security › Full Disk Access. After upgrading node, run `ai-msg doctor` to check that the grant still holds. The service log is `~/.config/deck/ai-msg.log`.
- **Linux:** run it from a login session (it needs `systemctl --user`). To keep the service running after you log out, run `loginctl enable-linger`. Logs: `journalctl --user -u ai-msg`.
- The settings the service needs (paths of the CLIs, allowed `DECK_*` variables, port, drain limit) are recorded at install time. After changing them, run `ai-msg service install` again.

## Upgrade

```bash
npm i -g ai-msg@latest
ai-msg service restart
```

The running server keeps the old version until it restarts; `ai-msg service status` says when a restart is needed. A restart waits for running turns up to the drain limit.

## Stop and uninstall

```bash
ai-msg service uninstall
```

This stops the service and removes its files. Stopping waits for running turns up to the drain limit (default 25 minutes). The data folder (`~/.config/deck`) is kept; delete it yourself if you want it gone. Then `npm uninstall -g ai-msg`.

## One server per config folder

A config folder serves one server at a time. A second server on the same folder refuses to start and prints the address of the one already running. For a separate instance, give it both another folder and another port:

```bash
DECK_CONFIG_DIR=~/.config/deck-test ai-msg --port 9400
```

## Config folder and environment variables

Everything AI-MSG keeps (token, settings, accounts, session state, audit log, attachments, push keys) is in `~/.config/deck`, or in `DECK_CONFIG_DIR`. Conversations stay where each CLI keeps them. All settings are optional `DECK_*` environment variables; see [Configuration](../README.md#configuration) and [Files](../README.md#files).

## Troubleshooting

| Message | What to do |
|---|---|
| A server is already on port 9320 | If it is AI-MSG, open `http://127.0.0.1:9320` (`ai-msg login-url` prints the login address). Otherwise start with `--port`, together with another `DECK_CONFIG_DIR`. |
| The config folder is already used by a server | Another AI-MSG uses this folder. Stop it (`ai-msg service status` shows it), or use another `DECK_CONFIG_DIR`. |
| Run this from a logged-in macOS GUI session | You ran `service install` over SSH. Run it in Terminal on the Mac. |
| No systemd user session | Run it from a login session, not through `sudo` or a bare `su`. |
| A CLI shows as not found | Install it and put it on `PATH`, or point `DECK_CLAUDE_BIN`, `DECK_CODEX_BIN`, `DECK_GEMINI_BIN` or `DECK_GROK_BIN` at it, then restart. |

## Windows

Not supported yet.
