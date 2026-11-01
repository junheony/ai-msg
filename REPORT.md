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
