# Hub controls (승인함 · 다음 작업 · 실행 관리 · 바로가기)

The hub dashboards used to be read-only. These controls let the owner act from them, inside fixed limits. Everything
runs through `/api/hub/ctl/*` (`src/server/hub/controls/`). Set `DECK_HUB_CONTROLS=0` to switch the whole thing off.

## What is never possible

Trading is off-limits in code (`guard.ts`), not by convention:

- Modes `trading` and `quant` have no controls. Their cards and pages show `QUANT/해당 채팅에서만 승인` and nothing else.
- An approval request is **locked** if its mode, kind or text mentions any of:
  - arming or disarming (arm/disarm, ARMED, FSD, 무장)
  - going live (go live, live trading, Cont live, live.conf, 실거래, 라이브 전환)
  - keys or secrets
  - nexus-engine or `cblabx-*` units
  - ports 8771/8783/8792/8793/8830
  - any ledger (ledger.jsonl, anchors.jsonl, 원장)
  - trading or quant

  A locked request is shown read-only. The server refuses to approve **or** reject it (403), and logs the refusal.
- Briefs and bot tasks matching the same list are refused (403). So are briefs that look like they contain a secret (422).
- A working dir is refused if it is outside `~`, or is a trading/ledger/state dir, or `.ssh`, `.gnupg`, `.config/deck` or `.msg`.
- Stop sends only `SIGTERM`, and only to a PID that passes every check:
  - It must be recorded for that job:
    - either MSG launched it, in which case its `/proc` start time must still match (this guards against PID reuse);
    - or it is in the job's `*.pid` / `pid.txt` file, in which case its cwd or cmdline must point into the job dir.
  - It must not be PID ≤ 1, the server itself or its parent.
  - It must not run under a `cblabx-*`, nexus-engine or `ai-msg` unit.
  - Its cmdline must not match the forbidden list.
- Nothing here writes to any ledger.

## Request flow

Every mutating request needs all of the following:

1. The MSG session cookie. Without it the request gets 401.
2. Same origin, via `sec-fetch-site` or `Origin`. Otherwise 403.
3. The `x-msg-csrf` header, set to the value `GET /api/hub/ctl/state` returns (an HMAC of the login token). Otherwise 403.
4. `x-msg-confirm: yes`. Otherwise 428. The UI sets this header only from a confirm dialog's button.
5. A JSON body. Otherwise 415.

Every action, whether done or refused, is one line in `~/.msg/msg-actions.log`. Briefs are logged only by length and sha256 prefix. Log and report views pass through `redact()`. Job environments are stripped of `*TOKEN*`, `*SECRET*`, `*API_KEY*`, `DECK_*` and similar variables.

## 승인함: `msg-approve`

Any bot, agent or script on the server can file a request:

```sh
scripts/msg-approve request --title "Merge feat/x" --kind pr-merge --mode msg --from my-bot \
  --pr-url https://github.com/o/r/pull/12 --pr-base main --pr-head feat/x --files 4 --additions 120 --deletions 8
# → prints the id
scripts/msg-approve status <id>          # pending | approved | rejected
scripts/msg-approve wait <id> --timeout 3600   # exit 0 approved, 2 rejected, 3 timeout
scripts/msg-approve list
```

- Files: `~/.msg/approvals/pending/<id>.json`, with fields `{id, from, mode, kind, title, detail, links[], createdAt, pr?, deploy?}`. `kind` is one of `generic`, `pr-merge` or `deploy`; any other kind is shown as generic.
- Deciding a request:
  1. The file is atomically claimed. A second decider gets 409.
  2. `decision: {status, by, at, note, hook}` is added.
  3. The file is moved to `~/.msg/approvals/decided/<id>.json`.
  4. One JSON line is appended to `~/.msg/msg-approvals.log`. This log is append-only and separate from any trading ledger.
- Executor hooks: approving only **records** the decision. If `~/.msg/approvals/hooks/<kind>` exists and is executable, it is started detached with the decided file's path as its only argument. No hook ships with MSG, so `pr-merge` and `deploy` never merge or deploy anything by themselves.
- `MSG_HOME` overrides `~/.msg`. This is for tests.

## 다음 작업

The button on each card opens a composer. The owner writes a brief, picks an engine and a working dir (each mode has a default), reviews, and confirms. The server then:

- creates `~/jobs/<YYYYMMDD>-<slug>/`;
- writes these files into it:
  - `BRIEF.md`: the brief, with the REPORT/STATUS rules appended after `<!-- msg:rules -->`
  - `account.txt`
  - `msg-job.json`: engine, account, mode, cwd, pid, `/proc` start time
  - `pid.txt`
  - `run.log`: stdout and stderr
- starts the engine detached.

| engine | command |
| --- | --- |
| Claude | `claude-pick --allow-protected-last` picks a/b/c → `CLAUDE_CONFIG_DIR` = `~/.claude`, `~/.claude-b` or `~/.claude-c`, then `claude -p … --dangerously-skip-permissions` |
| Codex | `~/.local/bin/codex exec --dangerously-bypass-approvals-and-sandbox …` |
| Hermes | `~/.local/bin/hermes -z …` |

Codex and Hermes share one OpenAI quota. The server scans recent `~/jobs/*/run.log` for `hit your usage limit … try again at <date>` (read as KST). While that date is in the future, both engines are greyed out, with the reset time shown, and Claude is suggested. Claude is greyed out only when every seat is at 95% or more of its 5-hour or weekly window.

**봇에게** only writes `~/.msg/tasks/<bot>/<id>.json` = `{id, bot, mode, text, createdAt, by, status: "queued"}`. Nothing is sent anywhere.

## 실행 관리

This lists:

- `~/jobs/*`
- `~/ai-msg-*` worktrees
- `~/msg-hub-design`

For each one it shows engine and account, whether a PID is alive, elapsed time, the REPORT's last `STATUS:` line, and whether a limit was hit.

Actions:

- log tail (48 KB, redacted)
- REPORT.md (rendered markdown, no raw HTML)
- stop (rules above, with a confirm)
- rerun: the same brief without the old rules footer, re-checked against the guards, into a new folder with a newly picked engine. Only for runs that are not alive.

## 바로가기

터미널 on a card or run opens that folder in the MSG terminal. If the folder has a session, the latest one opens. Otherwise you get the new-chat screen with the folder picked.
