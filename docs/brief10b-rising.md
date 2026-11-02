# BRIEF10b Rising

The 야핑봇 page now includes Rising after the two local publication feeds. It shows at most ten validated posts sorted by upstream rank: author, single-line text, topic chip, views/hour, age, and an external post link. Desktop uses one row per post; mobile places the velocity and age below each title. Existing local caps, growth observations and publication feeds remain authoritative and independent.

## Collector decisions

- `yapping-rising.ts` calls only the fixed `HUB_URLS.yappingRising` URL with the hub's 3,000 ms default timeout. The existing production fetch wrapper uses GET, bounds fetch/body reading with an abort signal, and refuses redirects. Collection runs alongside the local read and systemd query.
- Successful and failed results are cached for 30 seconds after completion, per dependency instance. Concurrent callers share one promise. A failed refresh replaces rankings with muted `데이터 없음` and the hub's sanitized reason; it does not reuse old rankings or change local mode health.
- Validate the envelope and required numeric/text fields before projecting seven display fields. Allow only HTTPS X/Twitter post permalinks, remove tracking queries/fragments, deduplicate links, sort and select ten. Malformed data yields `응답 형식 오류`; a valid empty feed yields `집계된 게시물 없음`. The UI repeats link validation and uses `noopener noreferrer`.
- The previous API delay note in the collapsed source details is replaced with the current collection policy. Current timing diagnosis is recorded separately by the parent task in REPORT.md.

## Fixtures and capture

`tests/fixtures/yapping-rising.ts` creates thirty deliberately reversed, clearly labelled synthetic posts. Unit tests cover sorting, limits, required fields, malformed/unsafe links, empty feeds, sanitized failures, recovery, 30-second expiry, concurrent deduplication, local-stat independence and required UI fields.

The isolated `scripts/brief10-preview.ts` allows the exact Rising URL alongside the existing quant snapshot. It never calls other :8095 routes. `BRIEF10B_RISING_FIXTURE=success|error` substitutes only the Rising source (unset means live); the preview manifest explicitly identifies that choice. All remaining operational records still use the established read-only dependencies.

Run the preview on an unused isolated port; do not change any running production service:

```bash
PATH=/home/max/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH BRIEF10_PORT=9411 BRIEF10B_RISING_FIXTURE=success node_modules/.bin/tsx scripts/brief10-preview.ts
BRIEF10_PORT=9411 node scripts/brief10b-capture.mjs
```

Repeat with `error` on a separate unused preview port; omit the fixture variable for live. Stop only the preview process created for the capture. The parent task builds the UI before capture.

`brief10b-capture.mjs` writes distinct `shots-yapquant/brief10b-rising-{live|success|error}-*` files and does not overwrite BRIEF10 artifacts. It captures desktop and mobile, scrolls the existing hub container to show every Rising row, checks horizontal overflow, single-line titles, safe links, local caps, collapsed source details, console/page errors and blocked requests. Fixture screenshots include an explicit SYNTHETIC RISING FIXTURE banner added only as capture instrumentation. The original BRIEF10 capture refuses fixture mode.

## Commands run by implementation agent

- `PATH=/home/max/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH npm test -- src/server/hub/yapping.test.ts src/server/hub/yapping-rising.test.ts src/ui/hub/YappingHome.test.tsx`: passed, 3 files / 36 tests (final targeted run).
- `node --check scripts/brief10b-capture.mjs`: passed.
- Parent task owns full tests, typecheck, build, screenshot runs and final REPORT.md evidence. No commit, push, merge, deployment or service restart performed by this implementation agent.
