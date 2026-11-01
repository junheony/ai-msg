# BRIEF7 integration review

Scope: independent read-only review of the working Hermes adapter, turn runner, shared types, session persistence/index, WS history/duplicate handling, and screenshot fixture. Implementation owners were notified directly. No live model turn, provider call, real session creation, or production service operation was performed. This review did not run tests concurrently with root's verification.

## Findings and resolutions

1. **P1 — live permission downgrade left native edit approval enabled: resolved.** `src/server/engine/HermesEngine.ts` originally sent ACP `accept_edits` once at startup, while `src/server/turn/TurnRunner.ts:setPermissionMode` only changed MSG's live mode reference. Switching to ask during the turn therefore left Hermes automatically accepting edits. The current adapter always sends ACP `default`. MSG answers each request using current mode callbacks: explicit automatic approval, or edit approval after canonical-cwd and sensitive-path checks, can choose `allow_once`. Edit mode is rechecked after asynchronous path inspection. Adapter regressions cover native default mode and dynamic edit-mode decisions.

2. **P2 — effort picker promised unsupported behavior: resolved.** Hermes reused the shared `gpt-6-astra` model's effort controls even though its backend request ignored `p.effort`. Hermes-specific `ModelMenu`/label handling now hides effort controls, and `paneEffort` omits effort for Hermes. The visible model remains `gpt-6-astra`.

3. **P2 — image attachments silently discarded: resolved.** `runHermes` now passes attachment metadata to the adapter. Non-images remain file references in the text prompt; image files become explicit ACP `image` blocks with MIME type and base64 data. The adapter checks the agent's advertised image capability and refuses unsupported input before sending the prompt. A mocked CLI regression verifies the transmitted image block. An unsupported-image refusal can occur after session initialization; it never silently sends an image-less prompt.

4. **P1 integration regression observed by root — built-in Hermes seat treated as an unknown Claude account: resolved.** Real wire history and fixture both correctly use `account: 'hermes'`; the preview incorrectly disabled continuation and showed an unknown-account notice. `accounts.ts` and `Pane` now recognize the seat with a regression test. The rebuilt `shots-terminal-v2/hermes-inspection.json` passes both widths, with `composer.editable: true` and `composer.blockedAccount: false`; the new-session Hermes picker is available, selected, Astra-visible, and reachable.

## Confirmed integration paths

- Explicit new Hermes sessions route to `runHermes`, and a stored `engine: 'hermes'` takes precedence on resume. Hermes is intentionally excluded from automatic model routing.
- `onSessionId` persists the native session ID before prompt execution. Subsequent turns call ACP `session/load`, suppress its replay notifications, and retain the same ID. A missing load fails rather than starting a new conversation.
- `HermesSessionState` persists engine, seat, model, permission mode, title and a bounded 200-message display snapshot. `codexEntries()` includes Hermes; `SessionIndex.codexOwned()` passes non-Codex entries through, preserving Hermes identity in grouped session lists.
- WS hello advertises availability; open history returns the Hermes seat/engine/model and persisted messages; duplicate preserves the engine/model/mode. Claude-specific fork/handoff/delete/cwd behavior is guarded by `isOtherEngineState` or explicit refusal.
- The adapter uses a fresh ACP child per turn, handshake timeouts, cancellation notification, process-group termination, pending permission abort, and a single terminal result. It suppresses stderr, redacts text/error streams, and never selects native `allow_always`.
- Fresh and resumed Hermes commander hops are rejected before adapter invocation; the new-session guard has a runner regression.
- Native policy verification checks the same process-local bootstrap used by the ACP child. It does not print dotenv or credential values. This review read Hermes source files only, never `.env`.

## Native policy and persistence review

`hermesAcpBootstrap.py` intentionally supports Hermes **0.18.2** only and fails closed on other versions. The bootstrap wraps native dotenv loading so subsequent `override=True` reloads cannot re-enable the relevant YOLO/hook environment flags. Deep-copy wrappers force native approval configuration to manual and hooks to require approval without changing the original configuration objects or rewriting configuration/auth files. It clears the process's frozen/session YOLO state, refuses attempts to enable native session YOLO, and asserts the resulting policy before ACP starts. These hooks are specific to the inspected native APIs and need review when Hermes is upgraded.

The bootstrap leaves Hermes home/auth/session paths intact and delegates provider authentication and native session persistence to Hermes. The runner preserves the native ID; ACP `session/load` restores its conversation history. MSG keeps a bounded display snapshot independently and does not truncate Hermes' own history. Native source inspection confirms ACP restoration uses the persisted provider/model/cwd and restores conversation history; pre-existing non-ACP CLI sessions are not imported by this implementation. Ordinary native approval allowlists and hardline denials remain Hermes policy; this permission adapter is not an operating-system sandbox.

The adapter suppresses bootstrap/native stderr and exposes only a fixed boolean for `--check-policy`. Root reports the installed-runtime policy probe returned true and `build:server` passed. The server build explicitly copies the Python bootstrap next to bundled `app.js`, matching its relative runtime URL. No live provider turn was used for these checks. Python bytecode suppression is part of the final backend hardening; full final validation is root's responsibility.

## Validation and evidence limits

Mocked CLI adapter tests cover create/resume, stream filtering, images, permission selection, plan/policy refusal, cancellation, orphaned permission cleanup, crash diagnostics and error redaction. `HermesPolicy.test.ts` checks unsafe dotenv/config clamping, preservation of original configuration, and refusal of an unreviewed runtime version. `TurnRunner.hermes.test.ts` now covers persistence/reload/resume, index entries, safe defaults, explicit auto-approval, and fresh commander refusal. The Hermes case in `ws.test.ts` exercises hello/send/index/reopen/resume with a mocked engine. This review inspected those tests but did not execute them; root owns final test results.

The screenshot fixture matches production history's `account: 'hermes'`, `engine: 'hermes'`, and `sessionModel: 'gpt-6-astra'`. Its transcript is explicitly synthetic, with two tool calls, one error, thinking and code. Its leading `SUCCESS` deliberately exercises BRIEF7b's error-aware status correction. Other engine sidebar entries reuse the display transcript only to verify styling. The read-only harness does not demonstrate authentication or actual model output and never sends a prompt.

`scripts/qa/shoot-terminal.mjs` additionally asserts that the synthetic Hermes session's composer is editable and that no unknown/retired-account banner appears. The completed Hermes inspection artifact confirms those checks passed at desktop and mobile widths. Final full-suite/build results are recorded by root; no unrun test is claimed here. All substantive findings above are resolved in the reviewed source; live provider authentication/output and version upgrades remain outside this mock/synthetic verification.
