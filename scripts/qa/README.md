# Lab panel screenshots

This isolated BRIEF3 host uses the real `createRequestHandler` and `createLabService` on
`127.0.0.1:9378`. Its only live upstream is GET
`http://127.0.0.1:8792/lab/api/summary`, with redirects disabled. It starts no collectors,
engines, services or periodic usage jobs and does not read any lab ledger files.

After the lab implementation and UI build are ready, run from the repository:

```sh
node --import tsx scripts/qa/lab-demo.ts /tmp/msg-lab-qa-state.json
```

The host prints paths only. The token lives in a new temporary directory with a `0600`
file and `0700` directory; the state file contains paths and the owned process ID, never
the token. Existing state files are refused. Stop only this process using SIGTERM or
Ctrl-C: it removes its temporary state and token. Port collisions fail without stopping
any existing process. Keep this foreground process running while taking screenshots:

```sh
node scripts/qa/shoot-lab.mjs /tmp/msg-lab-qa-state.json shots-lab lab
FOCUS='[data-testid="lab-panel"]' node scripts/qa/shoot-lab.mjs /tmp/msg-lab-qa-state.json shots-lab lab-panel
```

The wrapper delegates to `../tools/shoot.mjs`, the existing CDP/file-URL harness; it does not implement a second
browser driver. It captures Trading at 1440px desktop and 390px phone, using CDP port
9341 by default. `RDP_PORT`, `FOCUS`, `EVAL`, `MAXH`, `SETTLE_MS` and `THEME` pass through.
`SETTLE_MS` defaults to 10000 (10 seconds) so the live lab summary can finish loading
before capture; set it explicitly to override this wait.
`SHOOT_HARNESS` can select the existing harness when located elsewhere.

Fixtures and limitations:

- Other hub sections use the frozen `../.demo/status.json` (`STATUS_JSON` can select
  another frozen file). No production hub collectors or embed proxy targets are used.
- SR and market replay return deliberately empty fixtures. Replay uses the production
  validator/mapper with an in-memory empty upstream. These shots do not test their data.
- Sessions and account usage are empty and isolated under a temporary home. WebSocket
  authentication uses the real gate; its server sends a minimal hello and runs no tasks.
- Automatic UI diagnostics are discarded by a no-storage authenticated sink. Other
  mutation routes are disabled; `/api/hub/lab` uses the production method/auth gate.
- Lab data is live and may change between captures. Empty/error/stale states reflect
  the summary service and the production mapper/cache, not invented lab values.
- This script is not a production server, deployment or browser end-to-end suite. It
  depends on the existing local frozen snapshot and screenshot harness.

# Unified Trading room screenshots (BRIEF4)

`unified-demo.ts` is the same isolated host with the real `createSrService` added. It listens on
`127.0.0.1:${QA_PORT}` (default **9379**; 9377 is the live demo and is refused). Its live upstreams
are GET only and go through the production transports: `http://127.0.0.1:8792/lab/api/summary`
and the allowlisted `http://127.0.0.1:8830/api/sr` + `/api/status` (no redirects, no credentials,
bounded JSON, per-feed cache and last-good). No collectors, engines or ledgers are touched.

```sh
npm run build
node --import tsx scripts/qa/unified-demo.ts /tmp/msg-unified-qa-state.json
node scripts/qa/shoot-unified.mjs /tmp/msg-unified-qa-state.json shots-unified unified
FOCUS='[data-testid="sr-panel"]'  node scripts/qa/shoot-unified.mjs /tmp/msg-unified-qa-state.json shots-unified sr
FOCUS='[data-testid="lab-panel"]' node scripts/qa/shoot-unified.mjs /tmp/msg-unified-qa-state.json shots-unified lab
```

The wrapper refuses a state file whose server is not a loopback port, uses CDP port 9342 by default
and waits 12 s before capture so both live feeds settle. Replay candles are an empty in-memory
fixture, so the SR chart shows its "no candles" state and the table sorts by tier. The Trading room
is links only: `#sr=SYMBOL`, `#sr-all`, `#hub-lab`, `#hub-sr` and `#hub-practice` are plain hash
links; there is no `#replay` sub-screen and no button anywhere in `hub-mode-trading`, header included.
