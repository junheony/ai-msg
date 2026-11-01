# Lab summary panel (BRIEF3)

Branch: `feat/hub-lab-summary`, based on `feat/hub-design-pass` (`e45405a`).

## Changes

- Added a session-gated, GET-only `/api/hub/lab` route for the fixed same-host summary endpoint. A 60s cache coalesces requests and also caches failures; previous valid snapshots survive transport/format failures. Loading/partial responses replace old data.
- Added a strict, allowlisted mapper: no numeric coercion, no null-to-zero fallback, no scenario probabilities. Per-field source errors distinguish `미보고` from `오류`.
- Added the read-only Trading room lab panel: paper/ledger health, book PnL and positions, latest ten closes, certification progress (100 trades / 90 days), integrity verification, shortened Merkle root, gaps and original KST generation time. It is added above the existing Trading room content; legacy UI and collectors remain unchanged.
- Reused the existing glass/theme and Barlow Semi Condensed typography. Native progress indicators and internally scrolling tables fit desktop and phone. Integrity failure is the first alert; stale/partial/offline states remain explicit.
- Added mapper/cache/route/panel coverage and a reproducible isolated QA host. Two existing filesystem timestamp tests now compare against the observed `fs.stat().mtimeMs`, retaining activity-advance checks; requested millisecond values were rounded down by 0.001ms on this filesystem. A pre-existing relaunch test now waits for the fake server’s reported PID instead of selecting an unidentified child process. Existing service processes, protected ports and lab ledger files were not modified; no push, merge, deployment or service restart.

## Verification

| Check | Result |
|---|---|
| `npx vitest run --maxWorkers=4 --retry=1` | Passed: 348 files, 4321 tests; 149.94s; exit 0 |
| Focused lab mapper/transport/cache/route/panel + HubPage/TradingHome suite | 4 files, 55 tests passed |
| `npm run typecheck` | Passed after final edits |
| `npm run build` | Passed; largest main chunk 432.11 kB, below 500 kB limit |
| `node scripts/contrast-check.mjs` | All pairs passed |
| Live HTTP checks on isolated `127.0.0.1:9378` | GET 200; no cookie/bearer-only 401; POST/PUT/PATCH/DELETE/HEAD/OPTIONS 405 with `Allow: GET`; no-store; repeated reads return same cached snapshot |
| Live summary check | 4 books, 12 open positions, 10 recent closes, integrity passed; schema/read-only/PAPER fields verified |
| Browser checks | 1440/390, panel loaded; 0 controls; no page-wide horizontal overflow; no console/API failures |
| `git diff --check` and independent static review | Passed; no remaining findings |

Three pre-existing test assertions were made deterministic after full-suite failures:
filesystem timestamp checks use actual `fs.stat().mtimeMs` (the stored value differed
from the requested Date by 0.001ms); the relaunch test waits for the fake server’s
reported PID and registers the close listener before stopping it. Production code is
unchanged. All 53 tests in those three files pass independently. The complete final
suite result is recorded above. A preceding run without retries passed 4320/4321;
the remaining failure was the existing `setup/detect.test.ts` immediate child-exit
assertion, also documented as timing-sensitive in BRIEF2. The final full run permits
one retry per test; no test was skipped and that detection code was not changed.

JSON parse diagnostics retain only the first 200 characters' punctuation, redacting
source keys/values and paths. This satisfies the bounded diagnostic intent without
logging upstream secrets. The transport also refuses redirects/non-200 responses and
caps input at 2 MB.

## Screenshots

| Screenshot | CSS viewport / capture |
|---|---|
| [lab-desktop-trading.png](shots-lab/lab-desktop-trading.png) | 1440 × 6000 |
| [lab-mobile-trading.png](shots-lab/lab-mobile-trading.png) | 390 × 6000, 2× pixels |
| [lab-viewport-desktop-trading.png](shots-lab/lab-viewport-desktop-trading.png) | 1440 × 900 |
| [lab-viewport-mobile-trading.png](shots-lab/lab-viewport-mobile-trading.png) | 390 × 900, 2× pixels |

The 6000px captures show the complete new lab panel and part of the longer existing room. Screenshots show live lab summary data. Other hub sections use the existing frozen QA status; SR/replay are explicit empty fixtures. QA bound only to 127.0.0.1:9378, with the existing CDP harness and no production collectors. Desktop 1440px and phone 390px (2× pixel density). Both viewports were inspected: the lab panel has zero buttons/inputs/selects/links, and no page-wide horizontal overflow. There were no browser console errors or failed API requests in the final captures. The owned QA process was stopped after capture.

## Files

- `src/server/hub/lab.ts`, `src/shared/lab-types.ts`: transport, allowlisted mapping, cached service and GET response.
- `src/server/http.ts`, `src/server/server.ts`: existing session boundary and service wiring.
- `src/ui/hub/lab/{LabPanel.tsx,api.ts,lab.css}`, `HubPage.tsx`: standalone panel and Trading room integration.
- `src/server/hub/lab.test.ts`, `src/ui/hub/lab/LabPanel.test.tsx`, `src/test/labFixture.ts`, `HubPage.test.tsx`: coverage and isolated fixture.
- `src/server/sessions/CodexImports.test.ts`, `src/server/ws.outside.test.ts`: filesystem precision assertions only.
- `src/server/relaunch.test.ts`: fake-server readiness and close-event synchronization only.
- `scripts/qa/`, `shots-lab/`, `REPORT.md`: reproduction instructions, screenshots and this report.

The pre-existing workspace `../REPORT.md` receives this section as an append; this
repository copy and the screenshot files are included in the local commit. Workspace
`../shots-lab` points to this repository's `shots-lab` directory.

## Design references

[The Seeker dashboard references](https://ref.theseeker.io/?category=dashboard) and [Refero Styles](https://styles.refero.design/) were reviewed for calibration. The established hub design tokens take precedence.

STATUS: DONE

# Unified Trading room (BRIEF4)

## Changes

- Created `feat/hub-trading-unified` from `feat/hub-lab-summary` at `0588eff`. Fetched the server-local main from `/home/max/ai-msg` and merged `377b1b4` as `f41e4a7` (18 incoming commits). The source repository was not modified.
- Unified Lab and SR / DCA in the Trading room with source summaries, visible PAPER ONLY badges, source timestamps in KST, and source-section links. Existing @Trading Room and ver2 read-only information remains.
- Reused `/api/hub/sr[?symbol=]`, adding the real `:8830/api/status` alongside `:8830/api/sr`. The two feeds have independent caches, timeouts, last-good values and error metadata. Requests use fixed GET endpoints with no credentials/redirects and a bounded JSON body; session authentication remains in the existing HTTP boundary.
- Lab maps and displays future strategy entries generically, including nested metrics, while excluding old kNN/scenario probabilities and secret-like fields. Missing DCA fill/stage values remain explicitly unreported; existing reported status fields are shown.
- Trading content has no buttons, form inputs, collapsible controls, embedded control pages or interactive replay screen. SR symbol navigation and external dashboard access use links; the SR chart has no zoom/drag controls.

## Merge and review notes

The merge completed without conflicts. Git automatically merged `HubPage.tsx` and its tests. Existing main-branch polish and the Lab implementation were retained. Review corrected the initial header-refresh exception, replay sub-screen, SR refresh/client-error handling, nested strategy bounds and source-anchor visibility.

Design follows the existing hub tokens and larger typography. The `frontend-design` skill was applied with calibration from [The Seeker dashboard references](https://ref.theseeker.io/?category=dashboard), [Refero Styles](https://styles.refero.design/) and [liquid-glass](https://glass.samasante.com/); no new image assets or external palette were introduced.

## Validation

| Check | Final result |
|---|---|
| `npx vitest run --maxWorkers=4` | 350 files, **4,385 tests passed**, 98.39 s, exit 0; no retries/skips |
| `npx tsc --noEmit` / `npm run typecheck` | Passed (final polish also typechecked) |
| `npm run build` | Passed, including bundle-size check |
| Focused final UI regression tests | 4 files / 47 tests passed |
| `node scripts/contrast-check.mjs` | All pairs passed |
| Isolated HTTP checks on `127.0.0.1:9379` | Both Lab/SR: unauthenticated GET 401; authenticated POST/PUT/PATCH/DELETE/HEAD/OPTIONS 405 with Allow: GET |
| Real upstream data and caching | SR 37 symbols / 269 ranges; BTC filter 8 ranges; both feeds healthy; cached read reused; stage paper; DCA unreported; Lab 4 books |
| Browser at 1440 / 390 | Zero controls inside entire Trading page, zero document/room horizontal overflow; both PAPER ONLY/KST labels, Room/ver2 content and dashboard link present; no console/API errors |
| Source anchor / visual inspection | Lab and SR headings visible; nested strategy tree legible; empty-candle caption accurate |
| `git diff --check` | Passed |

The initial merged baseline passed 349 files / 4,348 tests. After implementation and review the final count is above;
a CSS-source-string assertion was removed in favor of actual browser inspection. Future Lab extra trees are bounded
to six container levels and a shared 400-node budget, with no hardcoded strategy names.

## Screenshots

| Screenshot | CSS capture size |
|---|---|
| [lab-desktop-trading-focus.png](shots-unified/lab-desktop-trading-focus.png) | 1440 × 4697 |
| [lab-mobile-trading-focus.png](shots-unified/lab-mobile-trading-focus.png) | 390 × 7050 (2× device scale) |
| [sr-desktop-trading-focus.png](shots-unified/sr-desktop-trading-focus.png) | 1440 × 1074 |
| [sr-mobile-trading-focus.png](shots-unified/sr-mobile-trading-focus.png) | 390 × 2380 (2× device scale) |
| [unified-desktop-trading.png](shots-unified/unified-desktop-trading.png) | 1440 × 16000 |
| [unified-mobile-trading.png](shots-unified/unified-mobile-trading.png) | 390 × 16000 (2× device scale) |
| [viewport-desktop-trading.png](shots-unified/viewport-desktop-trading.png) | 1440 × 900 |
| [viewport-mobile-trading.png](shots-unified/viewport-mobile-trading.png) | 390 × 900 (2× device scale) |

The 16,000 px overview captures include both complete new source sections; focused captures also show each source in full. The longer existing Trading content continues below the overview crop. Workspace `./shots-unified` links to `repo/shots-unified`; all eight PNGs are committed in the repository.

The isolated QA host uses the production HTTP handler and Lab/SR services on loopback port 9379; 9377 was occupied and left untouched. Only the three requested upstream GET feeds are live. Other hub data is a frozen QA snapshot, and market candles are an explicit empty fixture, so the SR screenshot honestly shows a no-candles state with real SR ranges. The existing CDP harness loads the built UI from file URLs and bridges API requests to the isolated host because HTTP main-frame browser navigation stalls in this environment. Viewport widths are 1440 and 390 CSS pixels; mobile captures use 2× device scale.

No production unit was restarted/stopped, no protected service was modified, no ledger/anchors JSONL was edited, no credentials were printed, and no push, deployment, or merge into main occurred. Only owned temporary QA processes were stopped. An optional Grok second opinion was unavailable because its API credential was absent; implementation review, regression tests and browser inspection were completed independently of it.

No required work is blocked.

STATUS: DONE

# Terminal redesign (BRIEF6)

## Changes

- Created `feat/terminal-redesign` from the fetched server main, `58b88d6`. Read `terminal-owner-1102.png` before implementation. The source repository `/home/max/ai-msg` was not modified.
- `src/ui/terminalPresentation.ts`, `MessageView.tsx`, and `Chat.tsx`: combine consecutive tool/thinking records into quiet, expandable process groups, preserving original order, tool inspection, model provenance and turn boundaries. Narrative commentary remains visible. Repeated model labels appear on hover/focus; meaningful turn and role controls remain available. Explicit leading SUCCESS/PARTIAL/BLOCKED markers become small colored status tags.
- `styles.css` and `App.tsx`: scope the redesign to Terminal, widen the normal transcript lane to 960px (wide setting 1040px), retain the larger Korean type scale, improve answer rhythm, distinguish user bubbles, and reduce repeated footer space. The hamburger remains exclusive to Terminal.
- `Composer.tsx`, `Chat.tsx`, and `UsageStrip.tsx`: integrate cache state into a solid composer, clarify model/account/approval controls, enlarge send controls and simplify header quota summaries. Existing keyboard shortcuts and controls remain mounted.
- `Sidebar.tsx`: remove markdown/status prefixes from previews, display status dots, and strengthen spacing and the active row. `FindBar.tsx` excludes content hidden inside any closed process disclosure. Historical-message memoization and grouped role summaries are covered by regression tests. `src/server/ws.tasks.test.ts` waits for server closure and uses bounded temporary-directory cleanup retries, fixing a teardown race found during validation without changing production code or assertions.
- `scripts/qa/terminal-demo.ts`, `shoot-terminal.mjs`, `terminal-README.md`, `docs/terminal-redesign-plan.md`, and `shots-terminal/`: reproducible isolated real-session comparison, design decisions and browser inspection evidence.

## Validation

| Check | Final result |
|---|---|
| `npx vitest run --maxWorkers=4` | **357 files / 4,469 tests passed**, 83.24 s, exit 0 |
| `npm run typecheck` | Passed |
| `npm run build` | Passed, including bundle checks; final UI asset `main-xnOjKvfr.js` |
| `node scripts/contrast-check.mjs` | All dark/light pairs passed |
| `node scripts/qa/shoot-terminal.mjs shots-terminal before` | Eight baseline captures; same frozen real session and answer anchor |
| `DIST="$PWD/dist/ui" node scripts/qa/shoot-terminal.mjs shots-terminal after` | Eight final captures; zero browser errors, failed API checks, error toasts or horizontal overflow |
| `DIST=/home/max/msg-hub-design/repo/dist/ui LAYOUT_CHECKS=1 RDP_PORT=9344 node scripts/qa/shoot-terminal.mjs /tmp/terminal-final-layout-shots layout` | Final build passed 1.35× type scale, actual 400px split pane and 390px mobile composer bounds/menu checks |
| Browser interactions | Process expand/collapse, options, model menu, usage menu and hamburger absence on home passed |
| `git diff --check` | Passed |

The fetched baseline passed 355 files / 4,446 tests. Validation exposed one fixed-pixel caret font-size violation and an existing WebSocket task fixture teardown race (`ENOTEMPTY` after all test assertions passed). The caret now uses the existing type token; the fixture awaits server closure before bounded cleanup. The font rule and all assertions were retained. The focused task suite passed all seven tests and typecheck after the fixture fix; the final full-suite result is above. Read-only review also identified and resolved historical-message rerenders, missing grouped role summaries and invisible nested search matches.

## Before / after screenshots

All screenshots use the same frozen long session and answer (normalized hash `cbc35fd3`). Desktop captures are 1440×900; mobile captures are 390×844 at device scale 1.

| View | Before | After |
|---|---|---|
| Desktop tool-heavy turn | [before](shots-terminal/before-desktop-turn.png) | [after](shots-terminal/after-desktop-turn.png) |
| Desktop long answer, top | [before](shots-terminal/before-desktop-answer-top.png) | [after](shots-terminal/after-desktop-answer-top.png) |
| Desktop long answer, bottom | [before](shots-terminal/before-desktop-answer-bottom.png) | [after](shots-terminal/after-desktop-answer-bottom.png) |
| Desktop session list | [before](shots-terminal/before-desktop-list.png) | [after](shots-terminal/after-desktop-list.png) |
| Mobile tool-heavy turn | [before](shots-terminal/before-mobile-turn.png) | [after](shots-terminal/after-mobile-turn.png) |
| Mobile long answer, top | [before](shots-terminal/before-mobile-answer-top.png) | [after](shots-terminal/after-mobile-answer-top.png) |
| Mobile long answer, bottom | [before](shots-terminal/before-mobile-answer-bottom.png) | [after](shots-terminal/after-mobile-answer-bottom.png) |
| Mobile session drawer | [before](shots-terminal/before-mobile-drawer.png) | [after](shots-terminal/after-mobile-drawer.png) |

Personally inspected the before/after images and iterated on excessive footer gaps, composer height and mobile title space. The final turn replaces repeated pill stacks with compact process rows, keeps explanatory text visible, and gives the answer more usable width. Metrics are in `shots-terminal/before-inspection.json`, `after-inspection.json` and `layout-inspection.json`.

## Reproduction and limits

The owned, read-only demo runs on `127.0.0.1:9381`; occupied 9377 was left untouched. It freezes a production-parser snapshot of 1,000 real transcript messages (35 user, 490 assistant, 421 tool calls) from the Agentic Harness session, plus seven real sidebar titles/previews. Secret-shaped strings are redacted and tool payloads withheld; no raw transcript is committed. Usage is explicitly offline/empty, demo pin selection is synthetic, and fork status is an isolated no-divergence fixture. These are not claims about live account state.

The browser uses a file-origin build and CDP bridge to the isolated host because HTTP main-frame navigation stalls in this environment. Unauthenticated reads return 401 and mutations return 405; the host cannot execute turns. Live queue/running-task controls were not exercised in the browser, although the full component suite passed. Leading bare uppercase status words followed by Korean text intentionally use the owner's report convention; ordinary prose beginning with the same pattern may also be tagged.

The `frontend-design` skill was applied, with calibration from [The Seeker](https://ref.theseeker.io/?category=dashboard), [Refero](https://styles.refero.design/), [glass.samasante.com](https://glass.samasante.com/), [Navbar Gallery](https://navbar.gallery/), [Cursor Agent](https://cursor.com/docs/agent/overview), [Warp](https://www.warp.dev/ai) and [Raycast AI](https://www.raycast.com/core-features/ai). Existing hub tokens take precedence. Claude delegation was quota-blocked and the other external providers were unavailable; native delegated implementation, QA and review completed the work.

No push, merge into main, deployment, unit restart, protected-service access or ledger change occurred. No required work remains blocked.

STATUS: DONE

# Terminal Hermes + polish (BRIEF7)

## Changes

- `HermesEngine.ts`, `hermesAcpBootstrap.py`, `TurnRunner.ts`, `SessionState.ts`, and `ws.ts`: Hermes is a peer engine with explicit new-session selection, ACP streaming, tool/thought events, native session resume, persisted model/title/permission mode and a bounded display transcript. The model picker shows `gpt-6-astra`; automatic routing does not silently select Hermes.
- Installed Hermes 0.18.2 reloads dotenv and had native approval bypass enabled. The version-guarded bootstrap forces manual native requests inside the child process, preserving native auth/history and modifying no global configuration. MSG resolves each permission using the current user-selected mode; default does not use YOLO, explicit auto-approve permits once, edit-only checks paths, and unsupported plan/commander modes refuse safely. No secret values or raw native stderr reach the client.
- `ModelPicker.tsx`, `NewChat.tsx`, `Pane.tsx`, `SessionChip.tsx`, `EngineMark.tsx`, and sidebar/state files: complete Hermes account identity, model selection and session reopening; five-engine accents, restrained empty-state treatment and keyboard/focus affordances. Unsupported effort/cwd actions are hidden for Hermes.
- `Chat.tsx`, `MessageView.tsx`, `stickToBottom.ts`, and `styles.css`: streaming caret, process disclosure motion, user-controlled smooth bottom scrolling with upward-scroll cancellation, code-block treatment/copy affordances and reduced-motion support. Existing theme tokens and type-scale invariants remain intact.
- CLI mocks, permission-policy fixtures, runner/socket integration tests and packaging tests cover streaming, resume, images, cancellation, live permission changes, secret-safe errors and the bundled Python resource. `scripts/qa/*` adds an isolated read-only synthetic Hermes fixture; design, runtime and independent-review notes are in `docs/terminal-brief7-*.md` and `docs/terminal-hermes-engine.md`.

## Validation

| Check | Result |
|---|---|
| `npx vitest run --maxWorkers=2` | 360 files / 4,497 tests passed; 365.01 s |
| `npm run typecheck` | Passed |
| `npm run build` | Passed, including bundle checks |
| `npm run build:server` | Passed, including Python bootstrap resource |
| `node scripts/contrast-check.mjs` | All dark/light pairs passed |
| Installed Python `-I src/server/engine/hermesAcpBootstrap.py --check-policy` | `{"msgPolicySafe": true}`; no provider turn |
| `DIST=/tmp/msg-brief7-before-header/ui node scripts/qa/shoot-terminal.mjs shots-terminal-v2 hermes` | 16 captures, desktop/mobile interaction checks passed |
| `git diff --check` | Passed |

An earlier full run exposed theme-token placement, an outdated engine-icon expectation and the packaging path allowlist; these were fixed with existing invariants retained. An unchanged Grok termination timing assertion exceeded its wall-time budget under host load; its isolated 74-test suite passed, followed by the final complete run above.

## Screenshots and review

Desktop is 1440×900, mobile 390×844. `shots-terminal-v2/hermes-inspection.json` records zero horizontal overflow, browser errors and error toasts, an editable Hermes composer, and reachable model/engine selection. Personally inspected final desktop/mobile captures and iterated after the first browser run revealed an unknown-account banner for the new Hermes seat; the account classification and regression test were corrected before final capture.

| View | Desktop | Mobile |
|---|---|---|
| Hermes session/header | [desktop](shots-terminal-v2/hermes-desktop-header.png) | [mobile](shots-terminal-v2/hermes-mobile-header.png) |
| Existing-session model picker | [desktop](shots-terminal-v2/hermes-desktop-model-picker.png) | [mobile](shots-terminal-v2/hermes-mobile-model-picker.png) |
| New-session Hermes selection | [desktop](shots-terminal-v2/hermes-desktop-new-hermes-picker.png) | [mobile](shots-terminal-v2/hermes-mobile-new-hermes-picker.png) |
| Empty state | [desktop](shots-terminal-v2/hermes-desktop-empty-state.png) | [mobile](shots-terminal-v2/hermes-mobile-empty-state.png) |

The fixture is synthetic and cannot execute turns. `header-before-*` captures retain the BRIEF6 real-session comparison. The double identity, red approval chip and misleading SUCCESS marker are retained here specifically for the separately requested BRIEF7b follow-up.

The `frontend-design` skill was applied with [The Seeker dashboard](https://ref.theseeker.io/?category=dashboard), [Refero](https://styles.refero.design/), [glass.samasante.com](https://glass.samasante.com/) and [Scrolltide](https://www.scrolltide.co/) references. No new image asset was needed. External delegation was unavailable because of quota/credentials; native delegated implementation and review completed the work.

## Limits

No paid/live provider turn was run: adapter behavior is verified with CLI mocks, installed-runtime offline policy checks, and synthetic browser evidence. The policy bridge intentionally supports Hermes 0.18.2 only; a Hermes upgrade requires a reviewed adapter update. MSG retains the last 200 display records while Hermes keeps its native full conversation. Existing non-ACP CLI sessions are not imported.

No push, deployment, unit restart, protected-port access, ledger change or modification of `/home/max/ai-msg` occurred.

STATUS: DONE

# Header fix (BRIEF7b)

## Changes

- Continued after BRIEF7 was recorded DONE and committed as `b21f4ab`. Read `header-owner-1102.png` and used the same synthetic Hermes conversation for before/after comparisons.
- `SessionChipHead.tsx` and `styles.css`: a single engine mark (or chosen custom avatar), title, small engine/model chip and aligned caret form one row. Equivalent title/folder slugs are no longer repeated; differing paths remain in the tooltip and folder actions remain in the menu. Rename, switcher, custom icon, focus and drag behavior are retained.
- `Chat.tsx` and styles: automatic approval stays visibly labeled `자동 승인` with a small amber icon and explanatory tooltip. Composer approval text follows the same quieter color. No permission semantics changed.
- `terminalPresentation.ts`, `MessageView.tsx`, and `Chat.tsx`: completed turns containing a failed tool show PARTIAL even when the answer says SUCCESS. Errors are collected across commentary and model changes, explicit turn IDs survive in-turn steering, historical null IDs reset at user boundaries, busy gaps remain unfinished, and BLOCKED stays authoritative. Original message text is preserved.
- `App.tsx`: Terminal phone layout reserves space for the session title by using existing bottom navigation for mode switching and moving quota access to the sidebar account menu's `사용량 보기`. Usage history, limits, global search/activity and focus restoration remain available. Screenshot inspection prompted this iteration when the first mobile draft left only two title characters.
- Regression tests cover failed/clean turns, cross-group errors, previous-turn isolation, steering and busy gaps, single/custom identity, path normalization, and the real phone drawer-to-usage interaction. `scripts/qa/shoot-terminal.mjs` now checks visible controls, title space, partial status and the reachable mobile usage route.

## Validation

| Check | Result |
|---|---|
| `npx vitest run --maxWorkers=2` | 360 files / 4,506 tests passed; 311.55 s |
| `npm run typecheck` | Passed |
| `npm run build` | Passed, including bundle checks; final asset `main--AzAaDYi.js` |
| `RDP_PORT=9345 HEADER_CHECKS=1 DIST=/home/max/msg-hub-design/repo/dist/ui node scripts/qa/shoot-terminal.mjs shots-terminal-v2 header-after` | 16 captures and both-width header/interaction checks passed |
| `node --check scripts/qa/shoot-terminal.mjs` | Passed |
| `git diff --check` | Passed |

## Before / after

| View | Before | After |
|---|---|---|
| Desktop header and failed-tool turn, 1440×900 | [before](shots-terminal-v2/header-before-hermes-desktop-turn.png) | [after](shots-terminal-v2/header-after-desktop-header.png) |
| Mobile header and failed-tool turn, 390×844 | [before](shots-terminal-v2/header-before-hermes-mobile-turn.png) | [after](shots-terminal-v2/header-after-mobile-header.png) |
| Desktop model picker | [before](shots-terminal-v2/hermes-desktop-model-picker.png) | [after](shots-terminal-v2/header-after-desktop-model-picker.png) |
| Mobile model picker | [before](shots-terminal-v2/hermes-mobile-model-picker.png) | [after](shots-terminal-v2/header-after-mobile-model-picker.png) |

Final capture contains sixteen views. Root personally inspected desktop/mobile header and picker images. `header-after-inspection.json` records the same source/answer hash as BRIEF7, exactly one identity, visible amber automatic approval, discoverable full Hermes model, PARTIAL with one tool error, reachable usage and no page overflow or browser errors. The final mobile title has 105.28px of visible width. Mobile usage was opened through the visible drawer account menu and closed successfully. A separate task occupied the usual CDP port during capture; only our own stalled browser was stopped, and final capture used 9345. The owned read-only QA host was stopped after completion.

The frontend-design references and design direction are documented in `docs/terminal-brief7-design.md`; independent status/header review is in `docs/terminal-brief7b-review.md`. Screenshots are synthetic UI evidence, not a live provider turn. BRIEF7's Hermes 0.18.2 runtime restriction and no-live-model verification limit still apply.

No push, merge into `/home/max/ai-msg`, deployment, unit restart, protected-port access or ledger change occurred. No required work remains.

STATUS: DONE
