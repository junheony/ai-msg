# BRIEF7c isolated usage screenshots

These are **synthetic visual comparison fixtures**, not evidence of live account quota, successful refresh, or provider connectivity. `scripts/qa/usage-fixture.ts` expresses the owner screenshot's states: Claude A/B/C 37/46/38% remaining, Fable exhausted, GPT weekly exhausted, both Gemini accounts logged out, Grok 71% remaining. The input uses `usedPct = 100 - remaining`; GPT remains exhausted in both before and after to isolate layout changes. Five-hour values, exact resets, and Grok turn totals are invented display data.

The browser clock is fixed to **2026-11-02 02:00 KST**, and its timezone is explicitly Asia/Seoul. The host's fixture date matches. This preserves relative reset labels between captures. All conversations are the existing wholly synthetic Hermes fixture; no owner transcript, account file, ledger, collector, or provider is read. `authLogin` only exposes the two login buttons; the setup probe is an empty synthetic response and login actions remain disabled by the read-only host.

Start the owned host on the reserved QA port (an occupied port fails):

```sh
FIXTURE=hermes USAGE_FIXTURE=brief7c DIST=/tmp/msg-brief7c-before/ui \
  node --import tsx scripts/qa/terminal-demo.ts /tmp/msg-usage-brief7c-qa-state.json
```

The before UI is the frozen build from `81ce0e7`. Capture before and after from the same host:

```sh
QA_STATE=/tmp/msg-usage-brief7c-qa-state.json CAPTURE=usage RDP_PORT=9345 \
  node scripts/qa/shoot-terminal.mjs shots-terminal-v2 usage-before
QA_STATE=/tmp/msg-usage-brief7c-qa-state.json DIST="$PWD/dist/ui" CAPTURE=usage RDP_PORT=9345 \
  node scripts/qa/shoot-terminal.mjs shots-terminal-v2 usage-after
```

The existing terminal driver's file-URL/CDP bridge is reused. Browser HTTP(S)/WS(S) network is blocked; the Node bridge allows only API requests to the isolated port 9381. No remote image assets are allowed in the inspected panels. CDP 9345 must be free; Chrome and temporary copies/profiles are removed after each capture. The host remains available for the other build, and its owned PID is in the private state file. Stop only that PID when review is complete.

Default output includes dark/light, 1440×900 desktop, and 390×844 mobile. Each desktop captures the expanded popover and detailed sheet. The terminal's mobile header hides the usage pill, so the real sidebar → account → 사용량 보기 action opens the mobile sheet. Each surface has full viewport, clipped panel, and lower scrolled viewport captures. `THEMES=dark` and `SIZES=desktop` narrow a run. Login, refresh, sending, and provider actions are not clicked.

`usage-*-inspection.json` records panel bounds, document overflow, row/bar counts, synthetic visible row text, external-image count, and login-button count. It fails missing panels, viewport escapes, document overflow, external images, and browser/API errors. AFTER also checks all seven rows stay within panel horizontal bounds, no internal horizontal overflow, and Grok is fully visible after scrolling to the bottom. BEFORE records these content checks without gating existing defects; `USAGE_CHECKS=1` can explicitly enforce them for any tag. Duplicate bar counts remain inspection evidence for visual review. A visually changing fixture cannot validate real freshness—backend regression tests provide that evidence.

Baseline defect reproduced in both themes: desktop popover's Grok row extends into an unintended second column, causing internal horizontal overflow and failing full visibility after the bottom scroll. The panel's outer rectangle and document themselves fit the viewport. The desktop and mobile detailed sheets pass the new content bounds/last-row checks. This explains why outer panel geometry alone was insufficient.

Validation: `node --check scripts/qa/shoot-terminal.mjs` and `node --check scripts/qa/usage-capture.mjs` passed. Before capture completed with seven provider/account rows on all six surfaces and no geometry or browser/API errors. Root performs final build, after capture, image review, and full test suite.
