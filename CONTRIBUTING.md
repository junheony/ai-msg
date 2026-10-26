# Contributing

Issues and pull requests are welcome. This is a personal project, so reviews are best-effort.

## Run from the repository

AI-MSG is not on npm yet, so this is how to run it today.

```bash
git clone https://github.com/junheony/ai-msg.git
cd ai-msg
npm install        # uses the claude, codex, gemini, grok CLIs you already installed
npm run build      # UI -> dist/ui
npm start          # http://127.0.0.1:9320
```

The server prints the addresses it listens on and where the login token is. Open `http://127.0.0.1:9320` and paste the contents of `~/.config/deck/token` into the login form. The token is created on first start (mode `0600`); delete the file and restart to sign every browser out.

## Development

```bash
DECK_DEV_ORIGIN=http://localhost:5173 npm run dev:server   # server with reload
npm run dev:ui                                             # Vite on :5173, proxies /api and /ws to :9320
npm run typecheck
npm test          # unit tests; no network or accounts needed
npm run build
```

- Do not run `npm run test:e2e` unless you mean to: it runs real turns on your logged-in accounts.
- Any change to `src/shared/protocol.ts` must follow [docs/protocol.md](docs/protocol.md): new fields are optional, nothing is removed or narrowed, and new server behavior gets a feature name.
- Keep fixtures free of personal data. Use `/Users/alice`, `deck-host.example.ts.net` and `acme-app`.
- UI strings are Korean for now; keep new strings consistent with the existing ones.
- Add or update tests next to the code you change (`*.test.ts`).

## Development service on a Mac (repository checkout)

Installed users run `ai-msg service install` instead (see [docs/install.md](docs/install.md#run-as-a-service)). From a checkout on macOS, a user LaunchAgent can run the repository build:

```bash
scripts/install-launchd.sh              # install a user LaunchAgent and start it
scripts/install-launchd.sh --uninstall
npm run restart                         # graceful restart: refused while turns or background work run, or when already draining (--force)
```

The service reads environment variables from `~/.config/deck/env` (`KEY=value` lines). The file is sourced by a shell script, so keep it writable by you only (`chmod 600`). If the checkout is under `~/Documents`, Desktop or Downloads, give Full Disk Access to the node binary the installer prints.

When server code changed since the server started, the top bar offers a graceful restart; it is offered only when the relaunch loop or the LaunchAgent will start the server again.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for an overview.
