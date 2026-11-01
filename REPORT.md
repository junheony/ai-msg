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
