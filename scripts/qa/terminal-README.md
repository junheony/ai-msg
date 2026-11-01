# BRIEF6 isolated Terminal capture

Start the localhost-only host (port collision fails; never use an existing server):

```sh
DIST=/tmp/msg-terminal-baseline/ui node --import tsx scripts/qa/terminal-demo.ts
node scripts/qa/shoot-terminal.mjs shots-terminal before
DIST="$PWD/dist/ui" node scripts/qa/shoot-terminal.mjs shots-terminal after
```

Keep this host running between before/after. It holds a frozen 1,000-message parsed tail of the real Agentic Harness session in memory. Both builds use the same answer hash, normalizing whitespace and optional leading status labels. A missing saved anchor fails capture rather than choosing a different answer. Delete the temporary state only after stopping the owned host; a new run selects a new snapshot. `QA_STATE` changes the screenshot state path. The default state `/tmp/msg-terminal-qa-state.json` contains paths, PID, counts, source provenance and the selected answer hash, never the auth token.

Each run captures desktop 1440×900 and mobile 390×844 at device scale 1: user-turn start, answer top, answer bottom, and session list (mobile drawer). The JSON inspection contains only counts/geometry, hash and checks. It verifies real chat, users, answers and tools, no document overflow or login/error toast, options/model and usage menus, step expansion/collapse, and hamburger absence on home. A failing check returns nonzero. `SIZES=desktop` narrows capture. `EVAL` can run an extra read-only DOM inspection after transcript shots; never inspect/log raw transcript text or credentials. `ANSWER_HASH` explicitly overrides the anchor.

The screenshot driver creates a temporary file:// copy of the selected build, adjusts asset preloads and History URLs for file origins, and proxies app fetch/WebSocket through CDP 9343. Chrome and temporary build/profile directories are cleaned up; an occupied CDP port is refused. Browser network requests are blocked. Its proxy accepts only the isolated port 9381. No protected service is contacted.

The host reads only UUID transcript files and their title companions under a short allowlist of `~/.claude/projects` directories, plus the known `~/.config/deck/session-meta.json` title map. It uses the production parser without its persistent cache. Transcript ordering, text, thinking, call identities/names and result flags are preserved; secret-shaped strings are redacted and all tool input/output payloads withheld. No raw transcript is written in the repository. The sidebar uses seven real session titles/previews; demo pins select up to two sessions per project and do not claim to mirror the owner's actual pins. Usage is explicitly an empty offline fixture. Fork status is an isolated no-divergence fixture. These are display data, not live account/service status.

Auth lives in a private temporary directory. The only accepted WS actions are session reads and harmless view/index requests. All mutations are refused, including sends, commands, settings, pinning and fork resolution. HTTP diagnostics have a no-storage sink. There is no production runner, subprocess execution, upstream service fetch, ledger access or source-transcript mutation. Stop only the PID recorded in the temporary state to clean up this host.

Optional geometry stress check: add `LAYOUT_CHECKS=1` (and `RDP_PORT=9344` when another capture uses 9343). It applies xlarge font scale, opens a real split on desktop and sizes its first pane to 400px, records idle composer button bounds and horizontal overflow, checks model-menu reachability, and saves an extra layout PNG. It never sends a turn. Queue/task controls remain explicitly unexercised. Extra geometry lives in `sizes.*.interactions.layout` in the inspection JSON.
