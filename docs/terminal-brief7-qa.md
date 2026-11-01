# Terminal Hermes visual evidence

`scripts/qa/terminal-fixtures.ts` is deterministic display data, not a recorded Hermes run. It provides a Hermes session using `gpt-6-astra`, a readable Korean title, a different cwd, two thinking blocks, two tool calls, one failed tool result, a TypeScript code block, and a finished answer. The answer deliberately begins with `SUCCESS` despite the error; BRIEF7b must derive `PARTIAL` from the tool result. The fixture never invokes a model or executes the command shown in its tool input.

Other sidebar entries represent Claude, Codex, Gemini, and Grok with fictional titles. Opening these entries uses the same display transcript; they establish engine styling only, not those engines' transport behavior. Usage, availability, pins and fork status are offline fixtures. The actual Hermes CLI adapter is verified separately with mocked CLI tests.

Start an owned isolated host only after the prior host on port 9381 is stopped:

```sh
FIXTURE=hermes DIST="$PWD/dist/ui" node --import tsx scripts/qa/terminal-demo.ts /tmp/msg-terminal-hermes-qa-state.json
```

From another shell:

```sh
QA_STATE=/tmp/msg-terminal-hermes-qa-state.json node scripts/qa/shoot-terminal.mjs shots-terminal-v2 hermes
```

`FIXTURE=hermes` bypasses the real Claude transcript and title metadata reads entirely. State stores fixture identity, counts, source-code provenance, process ID and private token-file location; it never stores the token. Auth remains in the private temporary directory. The host permits display reads, refuses sends and mutations, and has no engine runner. It never reads `~/.hermes/.env`.

The screenshot driver runs headless Chrome over CDP 9343, refuses an occupied CDP port, blocks browser network traffic, and proxies only to isolated localhost 9381. At 1440×900 and 390×844 it writes `{tag}-{desktop,mobile}-{turn,answer-top,answer-bottom,header,model-picker,list/drawer,empty-state,new-hermes-picker}.png`, plus `{tag}-inspection.json`. The last two views are synthetic-fixture-only. The header capture is a full viewport so the header, status row, and visible mode chip can be assessed together. It checks rendered users/answers/tools, no document overflow, model-picker visibility/bounds, and Hermes/Astra presence in the synthetic fixture's picker. It opens a new composer with Ctrl+N and selects Hermes in the engine dropdown, asserting the engine is available/selected and Astra is visible before taking the new-composer picker screenshot. This changes only local draft state; it sends no prompt and creates no server session. It also exercises options, usage, step expansion, and mobile drawer.

Use an identical running fixture for the BRIEF7b comparison, overriding only the immutable UI build:

```sh
QA_STATE=/tmp/msg-terminal-hermes-qa-state.json DIST=/tmp/msg-brief7-before-header/ui node scripts/qa/shoot-terminal.mjs shots-terminal-v2 header-before-hermes
QA_STATE=/tmp/msg-terminal-hermes-qa-state.json DIST="$PWD/dist/ui" node scripts/qa/shoot-terminal.mjs shots-terminal-v2 header-after-hermes
```

The state records the first answer's normalized hash to keep framing stable. The explicit `SUCCESS` prefix is excluded from this hash, so a corrected status label does not change the anchor. The earlier `header-before-*` images use the frozen BRIEF6 UI and the original redacted real-Claude fixture; those remain useful baseline evidence but are not a same-fixture Hermes comparison. Only inspect/log count, geometry, status and boolean metadata; never dump raw transcript content or tokens. Screenshot names and actual validation outcomes belong in `REPORT.md` after root executes and reviews them.

This harness does not prove live Hermes authentication, permissions, or resume behavior. It creates no real session or turn and performs no production operation. Optional `LAYOUT_CHECKS=1` adds xlarge-font and 400px split checks inherited from BRIEF6. It cannot substitute for adapter tests or actual desktop/mobile screenshot review.
