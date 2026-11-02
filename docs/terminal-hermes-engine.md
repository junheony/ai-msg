# Hermes terminal engine (BRIEF7)

Hermes is an explicit peer engine (`engine: "hermes"`, account `hermes`, model `gpt-6-astra`). It is excluded from automatic routing. Discovery uses `DECK_HERMES_BIN`, PATH, then `~/.local/bin/hermes`; WebSocket hello advertises `hermes.available`.

## Runtime and safety

The installed Hermes 0.18.2 ACP implementation supports `initialize`, `session/new`, `session/load`, `session/set_model`, `session/set_mode`, streamed text/thought/tool updates, permission requests, cancellation, and image prompt blocks. Its session/load replay is discarded by the live adapter to avoid duplicating prior output. Native session IDs and cwd persist in MSG state before prompting; a bounded 200-message MSG transcript restores the pane after reconnect. Hermes still owns the complete native conversation and its usual auth/session storage.

Native approval inspection found two hazards: `.env` reloads override inherited environment variables, and native `approvals.mode: off` bypasses permissions. No secrets were printed. Merely omitting `--yolo` or setting a shell variable was therefore insufficient.

`hermesAcpBootstrap.py` launches the installed Hermes ACP entry point through the Python interpreter declared by the installed CLI. It is deliberately guarded to the inspected **Hermes 0.18.2**. The bootstrap wraps native config and dotenv loaders in this child process only, forces manual approvals and disables automatic unseen hooks, clears frozen/session YOLO, and refuses native session-YOLO changes. It asserts the effective policy before serving ACP. It preserves native authentication and session persistence, without changing global config or copying credentials. A mismatched version/API fails closed with a generic error; raw CLI stderr never reaches MSG clients. The offline `--check-policy` path emits one fixed boolean only. The server build copies the Python resource next to its bundled entry point.

ACP mode always remains `default`. MSG's live mode answers permission requests once each: default asks; acceptEdits only permits known edit requests whose resolved paths stay inside cwd and avoid sensitive paths/symlinks/hardlinks; bypass permits requested tools only after the user explicitly selected automatic approval. Native plan mode is not supported and is refused, not silently mapped. Global Claude automatic approval is not inherited by a new Hermes session. Pending cards abort when the native prompt finishes/cancels. Commander automatic turns are refused for fresh and resumed Hermes sessions.

Hermes still owns its native no-prompt allowlist for benign/read operations; it is not an OS sandbox. Permission hints disclose this. ACP exposes no reasoning-effort control in this version, so the Hermes effort UI is hidden. No live model prompt or paid generation was used for verification.

## Implementation files

- `src/server/engine/HermesEngine.ts`, `hermesAcpBootstrap.py`: isolated ACP lifecycle, guarded policy, stream mapping, permission relay, cancellation and secret-safe failures.
- `src/server/config.ts`, `server.ts`, `ws.ts`, `turn/TurnRunner.ts`, `turn/SessionState.ts`: installation availability, create/send/list/reopen/resume, permissions, audit and transcript persistence.
- `src/shared/models.ts`, `protocol.ts`, `accounts.ts`, `permission.ts`, `concise.ts` and engine unions: Hermes model/engine metadata and explicit-only routing compatibility.
- `scripts/build-server.mjs`: package the bootstrap resource.
- `HermesEngine.test.ts`, `HermesPolicy.test.ts`, `acp/fakeHermesCli.ts`, `TurnRunner.hermes.test.ts`, `ws.test.ts`: fake CLI, fake Python native modules, routing/storage and socket regressions.

## Verification

- `npx vitest run src/server/engine/HermesEngine.test.ts src/server/engine/HermesPolicy.test.ts src/server/turn/TurnRunner.hermes.test.ts src/server/ws.test.ts src/server/engine/grokEditPaths.test.ts`: 5 files, 76 tests passed (before one additional commander regression).
- Installed Hermes offline bootstrap: `/home/max/.hermes/hermes-agent/venv/bin/python -I src/server/engine/hermesAcpBootstrap.py --check-policy` → `{"msgPolicySafe": true}`. No session/model created.
- Parent integration run owns final full-suite, typecheck, UI build, server packaging and screenshot results in `REPORT.md`.

Remaining limitation: the narrow process-local policy bridge is intentionally version-coupled; an upgraded Hermes requires reviewing/testing the adapter before it is enabled. Native provider credentials must remain valid. No end-to-end paid model turn was run.
