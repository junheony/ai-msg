# Claude Engine CLI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `ClaudeEngine`'s dependency on `@anthropic-ai/claude-agent-sdk` with a child process of the user's own installed, unmodified `claude` binary in headless print mode (`-p`, stream-json in and out), keeping every behaviour the rest of the server relies on behind the unchanged `Engine` interface.

**Architecture:** One deck turn = one `claude -p --input-format stream-json --output-format stream-json` child (same lifetime rules as today: kept open while background tasks run). Its stdout lines are parsed into the same message shapes the SDK used to hand over, so the existing mapping, background, meter and steer logic moves over almost verbatim into `src/server/engine/claudeCli/`. Permission prompts and AskUserQuestion come through the documented `--permission-prompt-tool` route: a tiny stdio MCP server per process (`permissionMcp.ts`, attached with `--mcp-config`) forwards each request over a per-server unix socket (`PermissionBridge`) to the turn's existing `onPermission`/`onQuestion` callbacks; the two in-process hooks deck still needs (PreToolUse, UserPromptSubmit) become `--settings` hook commands running `hookRelay.ts` against the same socket.

**Tech Stack:** TypeScript (Node 24, ESM, native type stripping for the two child scripts), vitest, tsx, `node:child_process`, `node:http` over a unix socket, `node:readline`. No new dependencies; one removed.

**Spec:** `docs/superpowers/specs/2026-10-15-quarterdeck-paid-design.md` §3 (policy rules) and §5.2 (this plan). usage-deck removal and same-vendor rotation opt-in are separate plans and are not touched here.

## Global Constraints

- Minimum `claude` version **2.1.259** (introduces `--permission-prompts`), recommended **2.1.283**; checked once at startup with `claude --version` (`resolveClaudeBin`). Below the minimum the binary is not used; below the recommended version deck logs a Korean warning.
- Verified on CLI 2.1.283 (do not re-verify): `-p`, `--output-format stream-json`, `--input-format stream-json`, `--include-partial-messages`, `--replay-user-messages`, `--verbose`, `--resume <id>`, `--fork-session`, `--session-id <uuid>`, `--model`, `--effort`, `--settings <file-or-json>` (with `hooks` and `permissions`), `--setting-sources`, `--add-dir`, `--permission-mode`, `--permission-prompts host|none`, `--permission-prompt-tool <mcp tool>` (documented; MCP server via `--mcp-config`; Claude waits for it before the first turn), `--mcp-config`, `--strict-mcp-config`, `--max-turns`, `--include-hook-events`, `--forward-subagent-text`. SIGTERM kills (exit 143, no result). Not yet verified: that SIGINT interrupts a turn cleanly in stream-json input mode (result recorded, process keeps reading stdin) — this is verified by spike B1 in Task 3; if negative, see "Lost or changed features" (Abort text row: the engine synthesizes 중단됨 from the exit). `--resume` with a transcript path (fork-at-message) is likewise unverified until spike F1 in Task 3. Stdin user messages are `{"type":"user","message":{"role":"user","content":…}}`.
- `resumeSessionAt` does not exist in the CLI; fork-at-message is redesigned (Task 6) and documented in "Lost or changed features".
- Never pass `--bare` (it disables subscription login).
- Never pass `--strict-mcp-config` (it would drop the user's own MCP servers).
- Never use the stdin `control_request`/`control_response` protocol (undocumented for CLI consumers): no interrupt, stopTask or setPermissionMode over stdin.
- deck never reads token files, `.credentials.json`, or the keychain, and never intermediates credentials; it selects the profile only through `CLAUDE_CONFIG_DIR` (`AccountRegistry.env`, unchanged). Login stays the user's job in a terminal.
- deck never sets `CLAUDE_CODE_ENTRYPOINT` or `CLAUDE_AGENT_SDK_VERSION` (and `AccountRegistry.env` keeps stripping an inherited `CLAUDE_CODE_ENTRYPOINT`).
- `@anthropic-ai/claude-agent-sdk` is removed from `package.json` and `package-lock.json`; no file under `src/` imports it (guard test in Task 8c).
- Tests use temp dirs (`fs.mkdtemp(path.join(os.tmpdir(), …))`) and never the network; the bridge uses a unix socket inside a temp dir. Live captures (spike steps) run the real CLI by hand, never inside `vitest`.
- User-facing strings stay Korean (existing texts are moved, not rewritten).
- All new files live under `src/server/engine/claudeCli/`. The two child-process entry scripts (`permissionMcp.ts`, `hookRelay.ts`) import only `node:` built-ins and use erasable TypeScript only, so `node <file>.ts` runs them without tsx.
- Committed fixtures pass `src/hygiene.test.ts` (no home paths, slugs, private names): every capture goes through `fixtures/scrub.ts`.
- Run tests with `npx vitest run <path> --maxWorkers=4`. Do not run `npm run restart`, do not signal the running server, do not touch `dist`.

## File Structure

New, under `src/server/engine/claudeCli/`:

| File | Responsibility |
|---|---|
| `version.ts` | `MIN_CLAUDE_VERSION`, `RECOMMENDED_CLAUDE_VERSION`, `parseClaudeVersion`, `resolveClaudeBin` (DECK_CLAUDE_BIN → PATH → `~/.local/bin` → `~/.claude/local`, version-gated). |
| `version.test.ts` | Version parsing and resolution order. |
| `args.ts` | `claudeArgs` (argv), `buildSettings` (`--settings` file: allow rules + hook commands), `buildMcpConfig` (`--mcp-config` file), `relayCommand`, `shellQuote`, `claudeEnv`, `validResume`, constants `BRIDGE_SERVER`, `PERMISSION_TOOL`, `EDIT_TOOL_MATCHER`. Pure. |
| `args.test.ts` | argv/settings/mcp-config shape, forbidden flags absent, env hygiene. |
| `messages.ts` | Local replacements for the SDK message types (`CliMessage`, `CliUserMessage`, blocks) and `parseLine`. |
| `spawnTypes.ts` | `ClaudeChildLike` / `ClaudeSpawnFn`: the slice of `ChildProcess` the engine uses, so tests inject `fakeClaudeCli`'s child. |
| `prompt.ts` | `toUserMessage` (text + image blocks → one stdin user message), moved from `ClaudeEngine.ts`. |
| `stream.ts` | Pure stream logic moved from `ClaudeEngine.ts`: `mapCliMessage`, `BackgroundTracker`, `ProgressMeter`, `isActivity`, `isInjectedNoopResult`, `toolAudit`, `deniedCalls`, `noteCommands`, `ToolTracker` (stream-side audit that replaces PostToolUse/PostToolUseFailure). |
| `stream.test.ts` | Parser + mapper + fixture replay + ToolTracker. |
| `texts.ts` | Korean texts shared by engine, permissions and hooks (`NO_TOOLS_MESSAGE`, `KEEP_PLANNING_MESSAGE`, new `PLAN_GATE_MESSAGE`, `SELF_CALL_MESSAGE`, `CLAUDE_MISSING_TEXT`, `FORK_SOURCE_MISSING`, …). |
| `process.ts` | `ClaudeProcess`: spawn, line reader, stdin writes, `closeInput`, `interrupt` (SIGINT → SIGTERM → SIGKILL), `stop`, `terminate`, stderr tail, exit info. |
| `process.test.ts` | Lifecycle against the fake child, replay of the abort fixture. |
| `fakeClaudeCli.ts` | Test double replacing `fakeSdk.ts`: a fake child process (stdout lines, stdin capture, signals, exit), `cli` message builders (the old `sdk` builders), `argValue`, and `ask`/`hook` helpers that talk to the real bridge like the child scripts do. |
| `permissionTypes.ts` | Local `PermissionUpdate` type (replaces the SDK import in `Engine.ts`). |
| `bridge.ts` | `PermissionBridge`: one unix-socket HTTP server per deck server, per-process registrations (token), `POST /v1/permission`, `POST /v1/hook`, wait cap, abort on dispose. |
| `bridge.test.ts` | Protocol, auth, abort, dispose, socket permissions. |
| `permissionMcp.ts` | Child entry: minimal stdio MCP server (JSON-RPC lines) with one tool, `permission`, forwarding to the bridge; exports `postBridge` and `handleRpc` for tests. |
| `permissionMcp.test.ts` | Spawns `node permissionMcp.ts` and speaks MCP to it. |
| `permissions.ts` | `permissionHandler` (the old `canUseTool` logic on bridge calls), `ModeGate`, session-grant memory. |
| `permissions.test.ts` | The old `canUseTool` tests, rewritten against `permissionHandler`. |
| `hookRelay.ts` | Child entry for `--settings` hook commands: stdin JSON → bridge → stdout JSON; fail-open or fail-deny. |
| `hookRelay.test.ts` | Spawns `node hookRelay.ts` against a bridge and a dead socket. |
| `hooks.ts` | `hookHandler`: PreToolUse (handoff note no-tools, permission-mode gate) and UserPromptSubmit (first-prompt `systemNote`). |
| `hooks.test.ts` | The old hook tests, rewritten against `hookHandler`. |
| `fork.ts` | Fork-at-message redesign: `chainUpTo`, `forkCandidates`, `writeForkSource` (truncated copy of the parent transcript resumed by path with `--fork-session`). |
| `fork.test.ts` | Chain truncation and source writing. |
| `ownedEntries.ts` | `OwnedEntries` / `deckWrites`: uuids and API message ids deck's own processes emitted (replaces `entrypoint === 'sdk-ts'`). |
| `ownedEntries.test.ts` | Set semantics and bound. |
| `background.fixture.test.ts` | Replays the recorded background-task fixture through engine + mapper. |
| `noSdk.test.ts` | Guard: no SDK import in `src/`, no SDK dependency in `package.json` (Task 8c). |
| `fixtures/scrub.ts` | Dev-only: scrubs a raw capture (home path, slugs, temp dir, e-mails, init lists) for commit. |
| `fixtures/scrub.test.ts` | Scrubber behaviour. |
| `fixtures/capture.ts` | Dev-only live capture runner (scenarios added per task); never imported by the server or tests. |
| `fixtures/*.jsonl`, `fixtures/*.meta.json` | Recorded, scrubbed stdout of real runs + run metadata. |

Modified:

| File | Change |
|---|---|
| `src/server/engine/ClaudeEngine.ts` | Rewritten as the orchestrator (spawn, bridge registration, stream loop moved from today's `runTurn`); keeps exporting `ClaudeEngine`, `BG_MAX_MS`, `BG_GRACE_MS`, `NO_TOOLS_MESSAGE`, `KEEP_PLANNING_MESSAGE`, `CommandsListener`. `buildOptions`, `buildPrompt`, `InputChannel`, `QueryFn`, `PromptInput` move to the temporary `legacySdkEngine.ts` in Task 8a (behind a `ClaudeEngine` shim that routes options without `bin` to it) and are deleted with it in Task 8c. |
| `src/server/engine/Engine.ts` | `PermissionUpdate` from `./claudeCli/permissionTypes`; SDK wording in comments. Shapes of `Engine`, `TurnRequest`, `EngineEvent`, `LiveInput` unchanged. |
| `src/server/engine/CodexEngine.ts` | Export `versionAtLeast` (reused by `version.ts`). |
| `src/server/config.ts`, `src/server/main.ts` | Resolve the claude binary at startup, log version / warnings, pass `bin` to `ClaudeEngine`, close the bridge on shutdown, drop `ownRoots` for `ProcessHolders`. |
| `src/server/sessions/foreignWrites.ts` (+ test) | Ownership by `deckWrites` instead of `entrypoint`; `pending` state for very recent unknown lines. |
| `src/server/sessions/ProcessHolders.ts` (+ test) | deck's own children recognised by the `--permission-prompt-tool mcp__deck_bridge__permission` argv marker instead of the SDK's `node_modules` path. |
| `src/server/engine/ClaudeEngine.test.ts`, `.activity.test.ts`, `.background.test.ts`, `.fork.test.ts`, `.handoff.test.ts`, `.uuids.test.ts`, `thinking.test.ts`, `slashCommands.test.ts` | Migrated from `fakeSdk`/`buildOptions` to `fakeClaudeCli`/the new modules (Task 8b). |
| `src/server/turn/TurnRunner.background.test.ts`, `TurnRunner.steer.test.ts`, `src/server/ws.background.test.ts`, `ws.bottleneck.test.ts`, `ws.activity.test.ts`, `ws.newSession.test.ts`, `ws.status.test.ts`, `ws.outside.test.ts` | Same migration (constructor options, imports incl. the `type QueryFn` imports, SDK option inspection → argv / `spawns[i].files.settings` inspection, stop_task expectation; Task 8b). |
| `src/hygiene.private.test.ts` | The "npm scope" example no longer names the removed package. |
| `package.json`, `package-lock.json` | SDK dependency removed. |

Temporary (created in Task 8a, deleted in Task 8c): `src/server/engine/legacySdkEngine.ts` — today's SDK engine moved verbatim, reached only through the shim.

Deleted: `src/server/engine/fakeSdk.ts` (Task 8b).

---

### Task 1: Version gate and argument builder

**Files:**
- Create: `src/server/engine/claudeCli/version.ts`, `src/server/engine/claudeCli/version.test.ts`
- Create: `src/server/engine/claudeCli/args.ts`, `src/server/engine/claudeCli/args.test.ts`
- Modify: `src/server/engine/CodexEngine.ts` (add `export` to `versionAtLeast`, nothing else)

**Interfaces:**
- Consumes: `versionAtLeast(v: string, min: string): boolean` from `../CodexEngine`; `MODEL_ARG` from `src/server/routing/ModelPolicy.ts`; `ClaudeModel`, `Effort` from `src/shared/models.ts`.
- Produces:
  ```ts
  // version.ts
  export const MIN_CLAUDE_VERSION = '2.1.259';
  export const RECOMMENDED_CLAUDE_VERSION = '2.1.283';
  export function parseClaudeVersion(raw: string | null): string | null;
  export type ClaudeBin =
    | { ok: true; bin: string; version: string; belowRecommended: boolean }
    | { ok: false; reason: 'missing' }
    | { ok: false; reason: 'too_old'; bin: string; version: string };
  export function resolveClaudeBin(
    env: NodeJS.ProcessEnv, home: string,
    existsFn?: (p: string) => boolean, versionFn?: (bin: string) => string | null,
  ): ClaudeBin;

  // args.ts
  export const BRIDGE_SERVER = 'deck_bridge';
  export const PERMISSION_TOOL = 'mcp__deck_bridge__permission';
  export const EDIT_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
  export type CliPermissionMode = 'default' | 'acceptEdits' | 'plan';
  export interface ArgsInput {
    model: ClaudeModel; effort?: Effort; permissionMode: CliPermissionMode;
    settingsPath: string; mcpConfigPath: string; addDirs?: string[];
    resume?: string; forkSession?: boolean; sessionId?: string;
  }
  export function claudeArgs(a: ArgsInput): string[];
  export function validResume(v: string): boolean;
  export function shellQuote(s: string): string;
  export function relayCommand(r: RelaySpec, fail: 'open' | 'deny'): string;
  export interface RelaySpec { node: string; script: string; socketPath: string; token: string }
  export interface SettingsInput { allowRules?: string[]; noTools?: boolean; systemNote?: string; relay: RelaySpec }
  export function buildSettings(s: SettingsInput): Record<string, unknown>;
  export function buildMcpConfig(m: { node: string; script: string; socketPath: string; token: string }): Record<string, unknown>;
  export function claudeEnv(base: NodeJS.ProcessEnv, toolTimeoutMs: number): NodeJS.ProcessEnv;
  ```

- [ ] **Step 1: Write the failing version test**

```ts
// src/server/engine/claudeCli/version.test.ts
import { describe, it, expect } from 'vitest';
import { parseClaudeVersion, resolveClaudeBin, MIN_CLAUDE_VERSION, RECOMMENDED_CLAUDE_VERSION } from './version';

const HOME = '/home/u';

describe('parseClaudeVersion', () => {
  it('reads "2.1.283 (Claude Code)"', () => expect(parseClaudeVersion('2.1.283 (Claude Code)\n')).toBe('2.1.283'));
  it('null on garbage / null', () => {
    expect(parseClaudeVersion('nope')).toBeNull();
    expect(parseClaudeVersion(null)).toBeNull();
  });
});

describe('resolveClaudeBin', () => {
  const versions: Record<string, string> = {
    '/old/claude': '2.1.200 (Claude Code)',
    '/new/claude': '2.1.283 (Claude Code)',
    '/mid/claude': '2.1.260 (Claude Code)',
    [`${HOME}/.local/bin/claude`]: '2.1.290 (Claude Code)',
  };
  const exists = (p: string) => p in versions;
  const ver = (p: string) => versions[p] ?? null;

  it('first qualifying PATH entry wins, older ones skipped', () => {
    const r = resolveClaudeBin({ PATH: '/old:/new' }, HOME, exists, ver);
    expect(r).toEqual({ ok: true, bin: '/new/claude', version: '2.1.283', belowRecommended: false });
  });
  it('flags a binary between minimum and recommended', () => {
    const r = resolveClaudeBin({ PATH: '/mid' }, HOME, exists, ver);
    expect(r).toEqual({ ok: true, bin: '/mid/claude', version: '2.1.260', belowRecommended: true });
  });
  it('falls back to ~/.local/bin/claude', () => {
    const r = resolveClaudeBin({ PATH: '/nowhere' }, HOME, exists, ver);
    expect(r).toMatchObject({ ok: true, bin: `${HOME}/.local/bin/claude` });
  });
  it('reports too_old when only old binaries exist', () => {
    const r = resolveClaudeBin({ PATH: '/old' }, '/empty', exists, ver);
    expect(r).toEqual({ ok: false, reason: 'too_old', bin: '/old/claude', version: '2.1.200' });
  });
  it('reports missing when nothing exists', () => {
    expect(resolveClaudeBin({ PATH: '' }, '/empty', () => false, () => null)).toEqual({ ok: false, reason: 'missing' });
  });
  it('DECK_CLAUDE_BIN overrides PATH but is still version-gated', () => {
    expect(resolveClaudeBin({ PATH: '/new', DECK_CLAUDE_BIN: '/mid/claude' }, HOME, exists, ver)).toMatchObject({ ok: true, bin: '/mid/claude' });
    expect(resolveClaudeBin({ PATH: '/new', DECK_CLAUDE_BIN: '/old/claude' }, HOME, exists, ver)).toMatchObject({ ok: false, reason: 'too_old' });
  });
  it('constants', () => {
    expect(MIN_CLAUDE_VERSION).toBe('2.1.259');
    expect(RECOMMENDED_CLAUDE_VERSION).toBe('2.1.283');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/server/engine/claudeCli/version.test.ts --maxWorkers=4`
Expected: FAIL — `Failed to resolve import "./version"`.

- [ ] **Step 3: Implement `version.ts`** (and add `export` in front of `function versionAtLeast` in `CodexEngine.ts`)

```ts
// src/server/engine/claudeCli/version.ts
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { versionAtLeast } from '../CodexEngine';

/** 2.1.259 introduced `--permission-prompts`; 2.1.283 is the version the plan's CLI facts were verified on. */
export const MIN_CLAUDE_VERSION = '2.1.259';
export const RECOMMENDED_CLAUDE_VERSION = '2.1.283';

export type ClaudeBin =
  | { ok: true; bin: string; version: string; belowRecommended: boolean }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'too_old'; bin: string; version: string };

export function parseClaudeVersion(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** `claude --version` with a minimal env: no profile dir, no tokens — the version string needs neither. */
function defaultVersionFn(bin: string): string | null {
  try {
    return execFileSync(bin, ['--version'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
  } catch {
    return null;
  }
}

/**
 * `DECK_CLAUDE_BIN` → each PATH entry → `~/.local/bin/claude` → `~/.claude/local/claude`.
 * Every candidate (the override included) must report >= MIN_CLAUDE_VERSION. The first existing
 * but too-old binary is remembered so the startup log can say "update claude" instead of "install".
 */
export function resolveClaudeBin(
  env: NodeJS.ProcessEnv,
  home: string,
  existsFn: (p: string) => boolean = isExecutable,
  versionFn: (bin: string) => string | null = defaultVersionFn,
): ClaudeBin {
  let tooOld: { bin: string; version: string } | null = null;
  const check = (p: string): ClaudeBin | null => {
    if (!existsFn(p)) return null;
    const version = parseClaudeVersion(versionFn(p));
    if (version === null) return null;
    if (!versionAtLeast(version, MIN_CLAUDE_VERSION)) { tooOld ??= { bin: p, version }; return null; }
    return { ok: true, bin: p, version, belowRecommended: !versionAtLeast(version, RECOMMENDED_CLAUDE_VERSION) };
  };
  if (env.DECK_CLAUDE_BIN) {
    const r = check(env.DECK_CLAUDE_BIN);
    if (r) return r;
    return tooOld ? { ok: false, reason: 'too_old', ...(tooOld as { bin: string; version: string }) } : { ok: false, reason: 'missing' };
  }
  const candidates = [
    ...(env.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, 'claude')),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
  ];
  for (const p of candidates) {
    const r = check(p);
    if (r) return r;
  }
  return tooOld ? { ok: false, reason: 'too_old', ...(tooOld as { bin: string; version: string }) } : { ok: false, reason: 'missing' };
}
```

- [ ] **Step 4: Run the version test and see it pass**

Run: `npx vitest run src/server/engine/claudeCli/version.test.ts src/server/engine/CodexEngine.test.ts --maxWorkers=4`
Expected: PASS (CodexEngine tests unaffected by the added `export`).

- [ ] **Step 5: Write the failing args test**

```ts
// src/server/engine/claudeCli/args.test.ts
import { describe, it, expect } from 'vitest';
import {
  claudeArgs, buildSettings, buildMcpConfig, relayCommand, shellQuote, claudeEnv, validResume,
  PERMISSION_TOOL, EDIT_TOOL_MATCHER,
} from './args';

const base = { model: 'opus' as const, permissionMode: 'default' as const, settingsPath: '/t/p/settings.json', mcpConfigPath: '/t/p/mcp.json' };
const relay = { node: '/usr/bin/node', script: '/app/hookRelay.ts', socketPath: '/t/qd-1/bridge.sock', token: 'tok' };

describe('claudeArgs', () => {
  it('builds the fixed headless stream-json prefix', () => {
    const a = claudeArgs(base);
    expect(a.slice(0, 7)).toEqual(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages']);
    expect(a).toContain('--replay-user-messages');
    expect(a).toEqual(expect.arrayContaining(['--permission-prompts', 'host', '--permission-prompt-tool', PERMISSION_TOOL]));
    expect(a).toEqual(expect.arrayContaining(['--setting-sources', 'user,project,local']));
    expect(a).toContain('--settings=/t/p/settings.json');
    expect(a).toContain('--mcp-config=/t/p/mcp.json');
    expect(a).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--permission-mode', 'default']));
  });
  it('never emits forbidden flags', () => {
    const a = claudeArgs({ ...base, resume: '11111111-2222-4333-8444-555555555555', forkSession: true, addDirs: ['/x'] });
    for (const f of ['--bare', '--strict-mcp-config', '--dangerously-skip-permissions']) expect(a).not.toContain(f);
  });
  it('effort, add-dir (absolute only), resume, fork, session-id', () => {
    const a = claudeArgs({ ...base, effort: 'high', addDirs: ['/abs', 'rel'], resume: '11111111-2222-4333-8444-555555555555', forkSession: true });
    expect(a).toEqual(expect.arrayContaining(['--effort', 'high']));
    expect(a).toContain('--add-dir=/abs');
    expect(a.some((x) => x.includes('rel'))).toBe(false);
    expect(a).toContain('--resume=11111111-2222-4333-8444-555555555555');
    expect(a).toContain('--fork-session');
    const n = claudeArgs({ ...base, sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(n).toContain('--session-id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });
  it('rejects malformed resume values instead of passing them through', () => {
    expect(() => claudeArgs({ ...base, resume: '--bare' })).toThrow();
    expect(validResume('/t/p/fork.jsonl')).toBe(true);
    expect(validResume('fork.jsonl')).toBe(false);
  });
  it('session-id is ignored together with resume', () => {
    const a = claudeArgs({ ...base, resume: '11111111-2222-4333-8444-555555555555', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(a.some((x) => x.startsWith('--session-id'))).toBe(false);
  });
});

describe('buildSettings', () => {
  it('allow rules and a fail-open edit-gate hook', () => {
    const s = buildSettings({ allowRules: ['Bash(npm test:*)'], relay }) as any;
    expect(s.permissions).toEqual({ allow: ['Bash(npm test:*)'] });
    expect(s.hooks.PreToolUse[0].matcher).toBe(EDIT_TOOL_MATCHER);
    expect(s.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', timeout: 30 });
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain("'--fail' 'open'");
    expect(s.hooks.UserPromptSubmit).toBeUndefined();
  });
  it('noTools gates every tool and fails closed', () => {
    const s = buildSettings({ noTools: true, relay }) as any;
    expect(s.hooks.PreToolUse[0].matcher).toBe('*');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain("'--fail' 'deny'");
  });
  it('systemNote adds a UserPromptSubmit relay', () => {
    const s = buildSettings({ systemNote: 'note', relay }) as any;
    expect(s.hooks.UserPromptSubmit[0].hooks[0].type).toBe('command');
    expect(JSON.stringify(s)).not.toContain('note"'); // the note itself is served over the bridge, not written to disk
  });
});

describe('relayCommand / shellQuote', () => {
  it('quotes every part; the token travels as an env prefix, never as a node argv flag', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(relayCommand(relay, 'open')).toBe(
      `DECK_BRIDGE_TOKEN='tok' '/usr/bin/node' '--disable-warning=ExperimentalWarning' '/app/hookRelay.ts' '--sock' '/t/qd-1/bridge.sock' '--fail' 'open'`,
    );
    expect(relayCommand(relay, 'open')).not.toContain('--token');
  });
});

describe('buildMcpConfig', () => {
  it('one stdio server, token only in its env', () => {
    const m = buildMcpConfig({ node: '/usr/bin/node', script: '/app/permissionMcp.ts', socketPath: '/s', token: 'tok' }) as any;
    expect(m).toEqual({ mcpServers: { deck_bridge: {
      type: 'stdio', command: '/usr/bin/node', args: ['--disable-warning=ExperimentalWarning', '/app/permissionMcp.ts'],
      env: { DECK_BRIDGE_SOCK: '/s', DECK_BRIDGE_TOKEN: 'tok' },
    } } });
  });
});

describe('claudeEnv', () => {
  it('adds the MCP tool timeout and never sets the SDK entrypoint', () => {
    const e = claudeEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/p' }, 43_200_000);
    expect(e).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/p', MCP_TOOL_TIMEOUT: '43200000' });
    expect('CLAUDE_CODE_ENTRYPOINT' in e).toBe(false);
  });
  it('drops an inherited entrypoint / SDK version', () => {
    const e = claudeEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '1' }, 1);
    expect(e.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(e.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `npx vitest run src/server/engine/claudeCli/args.test.ts --maxWorkers=4`
Expected: FAIL — `Failed to resolve import "./args"`.

- [ ] **Step 7: Implement `args.ts`**

```ts
// src/server/engine/claudeCli/args.ts
import path from 'node:path';
import type { ClaudeModel, Effort } from '../../../shared/models';
import { MODEL_ARG } from '../../routing/ModelPolicy';

export const BRIDGE_SERVER = 'deck_bridge';
export const PERMISSION_TOOL = `mcp__${BRIDGE_SERVER}__permission`;
/** Tools whose auto-approval depends on the permission mode (acceptEdits) — gated by the PreToolUse relay. */
export const EDIT_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

export type CliPermissionMode = 'default' | 'acceptEdits' | 'plan';

export interface ArgsInput {
  model: ClaudeModel;
  effort?: Effort;
  permissionMode: CliPermissionMode;
  settingsPath: string;
  mcpConfigPath: string;
  addDirs?: string[];
  /** Session id, or an absolute path to a `.jsonl` transcript (fork-at-message source, Task 6). */
  resume?: string;
  forkSession?: boolean;
  /** Only for brand-new sessions: lets deck know the id before the init frame arrives. */
  sessionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validResume(v: string): boolean {
  return UUID_RE.test(v) || (path.isAbsolute(v) && v.endsWith('.jsonl'));
}

/**
 * argv for one deck turn process. Value flags use `--flag=value` where the CLI declares them
 * variadic (`--add-dir`, `--mcp-config`) so a value can never swallow the next flag.
 * Never: --bare (breaks subscription login), --strict-mcp-config (drops the user's MCP servers).
 */
export function claudeArgs(a: ArgsInput): string[] {
  const out = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--model', MODEL_ARG[a.model],
  ];
  if (a.effort) out.push('--effort', a.effort);
  out.push(
    '--permission-mode', a.permissionMode,
    '--permission-prompts', 'host',
    '--permission-prompt-tool', PERMISSION_TOOL,
    '--setting-sources', 'user,project,local',
    `--settings=${a.settingsPath}`,
    `--mcp-config=${a.mcpConfigPath}`,
  );
  for (const d of a.addDirs ?? []) if (path.isAbsolute(d)) out.push(`--add-dir=${d}`);
  if (a.resume !== undefined) {
    if (!validResume(a.resume)) throw new Error(`invalid resume target: ${a.resume}`);
    out.push(`--resume=${a.resume}`);
    if (a.forkSession) out.push('--fork-session');
  } else if (a.sessionId && UUID_RE.test(a.sessionId)) {
    out.push(`--session-id=${a.sessionId}`);
  }
  return out;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RelaySpec { node: string; script: string; socketPath: string; token: string }

/**
 * Hook command line. The registration token goes in as a `DECK_BRIDGE_TOKEN=` env assignment in
 * front of node (same channel as the MCP server's `env`), so it never appears in node's argv / `ps`.
 */
export function relayCommand(r: RelaySpec, fail: 'open' | 'deny'): string {
  return `DECK_BRIDGE_TOKEN=${shellQuote(r.token)} ` + [r.node, '--disable-warning=ExperimentalWarning', r.script, '--sock', r.socketPath, '--fail', fail]
    .map(shellQuote).join(' ');
}

export interface SettingsInput { allowRules?: string[]; noTools?: boolean; systemNote?: string; relay: RelaySpec }

/**
 * Contents of the per-process `--settings` file (0600, inside a 0700 temp dir). Merged by the CLI
 * on top of user/project/local settings, exactly like the SDK's `settings` option was.
 */
export function buildSettings(s: SettingsInput): Record<string, unknown> {
  const hook = (fail: 'open' | 'deny') => ({ type: 'command', command: relayCommand(s.relay, fail), timeout: 30 });
  const hooks: Record<string, unknown> = {
    PreToolUse: [{ matcher: s.noTools ? '*' : EDIT_TOOL_MATCHER, hooks: [hook(s.noTools ? 'deny' : 'open')] }],
  };
  if (s.systemNote) hooks.UserPromptSubmit = [{ hooks: [hook('open')] }];
  const out: Record<string, unknown> = { hooks };
  if (s.allowRules?.length) out.permissions = { allow: [...s.allowRules] };
  return out;
}

export function buildMcpConfig(m: { node: string; script: string; socketPath: string; token: string }): Record<string, unknown> {
  return {
    mcpServers: {
      [BRIDGE_SERVER]: {
        type: 'stdio',
        command: m.node,
        args: ['--disable-warning=ExperimentalWarning', m.script],
        env: { DECK_BRIDGE_SOCK: m.socketPath, DECK_BRIDGE_TOKEN: m.token },
      },
    },
  };
}

/**
 * Env for the claude child: the account env (`AccountRegistry.env`, already stripped of token and
 * routing vars, CLAUDE_CONFIG_DIR set) plus the MCP tool timeout so a permission card can wait for
 * the user. deck never sets CLAUDE_CODE_ENTRYPOINT / CLAUDE_AGENT_SDK_VERSION.
 */
export function claudeEnv(base: NodeJS.ProcessEnv, toolTimeoutMs: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, MCP_TOOL_TIMEOUT: String(toolTimeoutMs) };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_AGENT_SDK_VERSION;
  return env;
}
```

- [ ] **Step 8: Run the args test and see it pass**

Run: `npx vitest run src/server/engine/claudeCli/args.test.ts --maxWorkers=4`
Expected: PASS (all `claudeArgs`, `buildSettings`, `relayCommand`, `buildMcpConfig`, `claudeEnv` cases).

- [ ] **Step 9: Commit**

```bash
git add src/server/engine/claudeCli/version.ts src/server/engine/claudeCli/version.test.ts src/server/engine/claudeCli/args.ts src/server/engine/claudeCli/args.test.ts src/server/engine/CodexEngine.ts
git commit -m "feat(claude-cli): claude 바이너리 버전 게이트와 headless 인자·설정 빌더"
```

---

### Task 2: Message types, stream mapper move, fake CLI child, first real fixture

**Files:**
- Create: `src/server/engine/claudeCli/messages.ts`, `src/server/engine/claudeCli/spawnTypes.ts`, `src/server/engine/claudeCli/prompt.ts`, `src/server/engine/claudeCli/stream.ts`, `src/server/engine/claudeCli/stream.test.ts`
- Create: `src/server/engine/claudeCli/fakeClaudeCli.ts`
- Create: `src/server/engine/claudeCli/fixtures/scrub.ts`, `src/server/engine/claudeCli/fixtures/scrub.test.ts`, `src/server/engine/claudeCli/fixtures/basic.jsonl`, `src/server/engine/claudeCli/fixtures/basic.meta.json`
- Modify: `src/server/engine/ClaudeEngine.ts` (delete the moved code, import it back from `./claudeCli/stream` and `./claudeCli/prompt`, and re-export `BackgroundTracker`, `ProgressMeter`, `toolAudit`, `deniedCalls`, `noteCommands`, `toUserMessage`, `CommandsListener`, `ToolAudit` plus `mapSdkMessage` as an alias of `mapCliMessage`, so existing tests stay green until they are migrated in Task 8b; Task 8a moves the SDK engine and these re-exports' consumers behind a shim)

**Interfaces:**
- Consumes: `systemRow`, `textOfContent` (`src/server/sessions/transcript.ts`), `IMAGE_TYPES`, `promptWithFiles`, `Attachment` (`src/server/attachments/AttachmentStore.ts`), `EngineEvent`, `EngineResult`, `BgTask`, `RateLimitSignal`, `TurnRequest` (`../Engine`), turn types from `src/shared/turn-types.ts`.
- Produces:
  ```ts
  // messages.ts
  export type Rec = Record<string, unknown>;
  export type ContentBlock = Rec & { type: string };
  export type CliMessage = CliSystemMessage | CliStreamEvent | CliAssistantMessage | CliUserMessage | CliResultMessage | CliRateLimitEvent | CliOtherMessage;
  export interface CliUserMessage { type: 'user'; parent_tool_use_id: string | null; message: { role: 'user'; content: string | ContentBlock[] }; session_id?: string; uuid?: string; priority?: 'now' | 'next' | 'later'; isReplay?: boolean; [k: string]: unknown }
  export function parseLine(line: string): CliMessage | null;

  // spawnTypes.ts
  export interface ClaudeChildLike { stdin: Writable; stdout: Readable; stderr: Readable; pid?: number; kill(signal?: NodeJS.Signals): boolean;
    once(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown; once(event: 'error', cb: (err: Error) => void): unknown }
  export type ClaudeSpawnFn = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ClaudeChildLike;

  // prompt.ts
  export type ReadFile = (p: string) => Promise<Buffer>;
  export function toUserMessage(text: string, attachments: Attachment[], readFile?: ReadFile): Promise<CliUserMessage>;

  // stream.ts (moved, behaviour unchanged; SDKMessage → CliMessage)
  export class BackgroundTracker { apply(m: CliMessage): boolean; tasks(): string[]; detail(): BgTask[] }
  export class ProgressMeter { reset(): void; apply(m: CliMessage): { outputTokens: number; phase: TurnPhase } | null }
  export function isActivity(m: CliMessage): boolean;
  export function isInjectedNoopResult(m: CliMessage): boolean;
  export type AuditSource = 'cli' | 'rule' | 'deck';
  export type ToolAudit = { handled: Set<string>; report: (e: { tool_name: string; tool_input: unknown; tool_use_id: string }, decision: 'allow' | 'deny', source: AuditSource) => Promise<void> };
  export function toolAudit(req: Pick<TurnRequest, 'onToolAudit'>): ToolAudit;
  export function deniedCalls(m: CliMessage, inputs: Map<string, unknown>): { tool_name: string; tool_input: unknown; tool_use_id: string; source: AuditSource }[];
  export function mapCliMessage(m: CliMessage): EngineEvent[];
  export type CommandsListener = (sessionId: string | null, cwd: string, commands: (string | SlashCommandInfo)[], terminal: string[]) => void;
  export function noteCommands(m: CliMessage, fallbackCwd: string, onCommands: CommandsListener): void;

  // fakeClaudeCli.ts
  export type FakeSpawn = { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
  export function fakeClaudeCli(opts?: { exitOnStdinClose?: boolean; onSignal?: (sig: NodeJS.Signals, ctl: FakeCtl) => void }): {
    spawnFn: ClaudeSpawnFn; spawns: FakeSpawn[]; inputs: CliUserMessage[];
    state: { inputClosed: boolean; calls: number; signals: NodeJS.Signals[] };
    push(...ms: unknown[]): void; end(code?: number): void; stderr(text: string): void; ctl(): FakeCtl | null;
  };
  export type FakeCtl = { push(...ms: unknown[]): void; raw(text: string): void; exit(code: number | null, signal?: NodeJS.Signals | null): void };
  export const cli: { /* every builder of today's `sdk` object, same names and shapes */ replay(uuid: string, text?: string): Rec; resultFor(uuids: string[], text: string, sid?: string): Rec };
  export function argValue(args: string[], flag: string): string | undefined;

  // fixtures/scrub.ts
  export function scrubLine(line: string, ctx: { home: string; cwd: string }): string;
  ```

- [ ] **Step 1 (spike): Capture the basic fixture**

Validates these assumptions in one bounded run (no tools, one turn): (A1) the init frame has `session_id`, `model`, `cwd`, `slash_commands`; (A2) `stream_event` frames carry `parent_tool_use_id` and the same `event` shapes the SDK forwarded (`message_start`, `content_block_start`, `content_block_delta`/`text_delta`, `message_delta.usage.output_tokens`); (A3) `--replay-user-messages` echoes our stdin message as a `user` frame with `isReplay: true` and our `uuid`; (A4) the `result` frame names our uuid in `user_message_uuids` (or `user_message_uuid`); (A5) `assistant` frames carry top-level `uuid` and `message.id`. First write the scrubber (Step 2–4 below), then run from the repo root:

```bash
D=$(mktemp -d)
printf '%s\n' '{"type":"user","uuid":"00000000-0000-4000-8000-000000000001","parent_tool_use_id":null,"message":{"role":"user","content":"Reply with exactly the word pong and nothing else."}}' \
  | (cd "$D" && perl -e 'alarm 120; exec @ARGV' claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages --replay-user-messages --max-turns 1 --model claude-sonnet-5-5) > "$D/raw.jsonl"
npx tsx src/server/engine/claudeCli/fixtures/scrub.ts --home "$HOME" --cwd "$D" < "$D/raw.jsonl" > src/server/engine/claudeCli/fixtures/basic.jsonl
printf '{"cli":"%s","scenario":"basic","args":"-p stream-json in/out, --verbose --include-partial-messages --replay-user-messages --max-turns 1"}\n' "$(claude --version | head -1)" > src/server/engine/claudeCli/fixtures/basic.meta.json
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")) { try { const m = JSON.parse(l); if (m.type === "result") console.log("cost", m.total_cost_usd, JSON.stringify(m.usage)); } catch {} }' "$D/raw.jsonl"
rm -rf "$D"
npx vitest run src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=4
```

**Account and cost (applies to every spike/capture step in this plan):** captures run on whichever Claude profile `CLAUDE_CONFIG_DIR` selects in the implementer's shell (unset = `~/.claude`). Before the first capture, run `echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` and choose the profile deliberately (one with usage headroom, not the profile the running deck serves). Record the profile's usage before and after this step (the 5-hour and weekly percentages from `/usage` in an interactive `claude` on that profile) together with the `cost` line printed above. Put these numbers and the profile name in the task report only — never in a committed fixture or meta file (profile names and home paths are private; `hygiene.private.test.ts` checks).

Expected: `basic.jsonl` has an init line, stream events, one `assistant`, the replay line and one `result`; hygiene PASS. If A3 or A4 fails (no replay frame / no uuids in the result), record it in `basic.meta.json` as `"notes"` and keep going — the engine already handles both (`namesAnswers` fallback, steer echo via result uuids), but Task 3's steer test must then use the fallback shapes. If the CLI refuses stdin messages without `session_id`, add `"session_id":""` to the line and record that in `notes`; `toUserMessage` already sets it.

- [ ] **Step 2: Write the failing scrubber test**

```ts
// src/server/engine/claudeCli/fixtures/scrub.test.ts
import { describe, it, expect } from 'vitest';
import { scrubLine } from './scrub';

const ctx = { home: '/home/alice', cwd: '/tmp/tmp.Xy12' };

describe('scrubLine', () => {
  it('replaces the home dir, its project slug and the temp cwd', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'x', a: '/home/alice/.claude/projects/-home-alice-proj/s.jsonl', cwd: '/tmp/tmp.Xy12' });
    const out = JSON.parse(scrubLine(line, ctx));
    expect(out.a).toBe('/home/user/.claude/projects/-home-user-proj/s.jsonl');
    expect(out.cwd).toBe('/work');
  });
  it('removes e-mail addresses and tailnet host names', () => {
    const out = scrubLine(JSON.stringify({ type: 'x', e: 'alice@example.org', h: 'box.tail1234.ts.net' }), ctx);
    expect(out).not.toContain('alice@');
    expect(out).not.toContain('ts.net');
  });
  it('trims init inventories to what tests need', () => {
    const init = { type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/tmp/tmp.Xy12',
      tools: ['Bash', 'mcp__private__x', 'mcp__deck_bridge__permission'], slash_commands: ['compact', 'private-cmd'],
      mcp_servers: [{ name: 'private', status: 'connected' }, { name: 'deck_bridge', status: 'connected' }],
      skills: ['s'], plugins: [{ name: 'p' }], agents: ['a'] };
    const out = JSON.parse(scrubLine(JSON.stringify(init), ctx));
    expect(out.tools).toEqual(['Bash', 'mcp__deck_bridge__permission']);
    expect(out.slash_commands).toEqual(['compact']);
    expect(out.mcp_servers).toEqual([{ name: 'deck_bridge', status: 'connected' }]);
    expect(out.skills).toEqual([]);
    expect(out.plugins).toEqual([]);
    expect(out.agents).toEqual([]);
  });
  it('passes non-JSON lines through after text scrubbing', () => {
    expect(scrubLine('oops /home/alice/x', ctx)).toBe('oops /home/user/x');
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run src/server/engine/claudeCli/fixtures/scrub.test.ts --maxWorkers=4`
Expected: FAIL — `Failed to resolve import "./scrub"`.

- [ ] **Step 4: Implement the scrubber**

```ts
// src/server/engine/claudeCli/fixtures/scrub.ts
// Dev-only: turns a raw `claude -p --output-format stream-json` capture into a committable fixture.
// Usage: npx tsx src/server/engine/claudeCli/fixtures/scrub.ts --home "$HOME" --cwd <capture dir> < raw > out
import fs from 'node:fs';
import readline from 'node:readline';

const BUILTIN_COMMANDS = new Set(['compact', 'context', 'cost', 'init', 'review', 'clear', 'help', 'model', 'memory']);
const slug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function variants(p: string): string[] {
  const out = new Set([p]);
  try { out.add(fs.realpathSync(p)); } catch { /* temp dir already gone */ }
  if (p.startsWith('/var/')) out.add(`/private${p}`);
  return [...out].sort((a, b) => b.length - a.length);
}

function scrubText(s: string, ctx: { home: string; cwd: string }): string {
  let out = s;
  for (const c of variants(ctx.cwd)) {
    out = out.replace(new RegExp(escape(c), 'g'), '/work').replace(new RegExp(escape(slug(c)), 'g'), '-work');
  }
  for (const h of variants(ctx.home)) {
    out = out.replace(new RegExp(escape(h), 'g'), '/home/user').replace(new RegExp(escape(slug(h)), 'g'), '-home-user');
  }
  return out
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.invalid')
    .replace(/[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net/g, 'host.invalid');
}

export function scrubLine(line: string, ctx: { home: string; cwd: string }): string {
  const text = scrubText(line, ctx);
  let m: Record<string, unknown>;
  try { m = JSON.parse(text) as Record<string, unknown>; } catch { return text; }
  if (m.type === 'system' && m.subtype === 'init') {
    if (Array.isArray(m.tools)) m.tools = m.tools.filter((t) => typeof t === 'string' && (!t.startsWith('mcp__') || t.startsWith('mcp__deck_bridge__')));
    if (Array.isArray(m.slash_commands)) m.slash_commands = m.slash_commands.filter((c) => typeof c === 'string' && BUILTIN_COMMANDS.has(c));
    if (Array.isArray(m.mcp_servers)) m.mcp_servers = m.mcp_servers.filter((s) => (s as { name?: unknown })?.name === 'deck_bridge');
    for (const k of ['skills', 'plugins', 'agents']) if (Array.isArray(m[k])) m[k] = [];
  }
  return JSON.stringify(m);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };
  const ctx = { home: arg('--home'), cwd: arg('--cwd') };
  if (!ctx.home || !ctx.cwd) { console.error('usage: scrub.ts --home <dir> --cwd <dir> < raw > out'); process.exit(2); }
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (l) => { if (l.trim()) process.stdout.write(scrubLine(l, ctx) + '\n'); });
}
```

- [ ] **Step 5: Run the scrubber test, then do the Step 1 capture**

Run: `npx vitest run src/server/engine/claudeCli/fixtures/scrub.test.ts --maxWorkers=4`
Expected: PASS. Then run the Step 1 commands; expected hygiene PASS.

- [ ] **Step 6: Write the failing stream test** (fixture replay + fake child basics + moved helpers)

```ts
// src/server/engine/claudeCli/stream.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseLine, type CliMessage } from './messages';
import { mapCliMessage, isActivity, BackgroundTracker } from './stream';
import { toUserMessage } from './prompt';
import { fakeClaudeCli, cli, argValue } from './fakeClaudeCli';

const fixture = (name: string): CliMessage[] =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n').filter(Boolean).map((l) => parseLine(l)!).filter(Boolean);

describe('parseLine', () => {
  it('accepts objects with a string type, rejects the rest', () => {
    expect(parseLine('{"type":"result","subtype":"success"}')).toMatchObject({ type: 'result' });
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('[1]')).toBeNull();
    expect(parseLine('{"no":"type"}')).toBeNull();
  });
});

describe('basic fixture (real CLI capture)', () => {
  const ms = fixture('basic.jsonl');
  it('maps init → deltas → result like the SDK stream did', () => {
    const evs = ms.flatMap(mapCliMessage);
    expect(evs[0]).toMatchObject({ kind: 'init' });
    expect(typeof (evs[0] as { sessionId: string }).sessionId).toBe('string');
    const text = evs.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text.toLowerCase()).toContain('pong');
    const result = evs.find((e) => e.kind === 'result') as { ok: boolean; text: string; usage: { outputTokens: number } };
    expect(result.ok).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
  it('A3/A4: our uuid comes back as a replay and in the result', () => {
    const ours = '00000000-0000-4000-8000-000000000001';
    const replay = ms.find((m) => m.type === 'user' && (m as Record<string, unknown>).isReplay === true);
    const result = ms.find((m) => m.type === 'result') as Record<string, unknown>;
    const named = [...((result.user_message_uuids as string[] | undefined) ?? []), result.user_message_uuid];
    // Both are what the engine relies on; if the capture recorded otherwise in basic.meta.json notes, this test documents it.
    expect(replay?.uuid ?? null).toBe(ours);
    expect(named).toContain(ours);
  });
  it('A5: assistant frames carry uuid and message.id; replay frames are not activity', () => {
    const a = ms.find((m) => m.type === 'assistant') as Record<string, unknown>;
    expect(typeof a.uuid).toBe('string');
    expect(typeof (a.message as Record<string, unknown>).id).toBe('string');
    expect(ms.filter((m) => m.type === 'user').every((m) => !isActivity(m))).toBe(true);
  });
});

describe('moved helpers keep behaving', () => {
  it('BackgroundTracker reads the level signal', () => {
    const bg = new BackgroundTracker(() => 1);
    expect(bg.apply(cli.bgLevel([{ id: 't1', desc: 'sleep' }]) as CliMessage)).toBe(true);
    expect(bg.tasks()).toEqual(['sleep']);
  });
  it('toUserMessage builds one stdin user message with image blocks', async () => {
    const m = await toUserMessage('hi', [{ path: '/x.png', name: 'x.png', mediaType: 'image/png', isImage: true } as never], async () => Buffer.from('PNG'));
    expect(m.type).toBe('user');
    expect(Array.isArray(m.message.content)).toBe(true);
    expect((m.message.content as { type: string }[]).map((b) => b.type)).toEqual(['text', 'image']);
  });
});

describe('fakeClaudeCli', () => {
  it('records argv, parses stdin lines, streams pushed frames and exits on stdin close', async () => {
    const fake = fakeClaudeCli();
    fake.push(cli.init('s9'));
    const child = fake.spawnFn('claude', ['-p', '--model', 'm', '--settings=/x'], { cwd: '/w', env: {} });
    const lines: string[] = [];
    child.stdout.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)));
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n');
    const exit = new Promise<[number | null, string | null]>((r) => child.once('exit', (c, s) => r([c, s])));
    child.stdin.end();
    expect(await exit).toEqual([0, null]);
    expect(fake.inputs).toHaveLength(1);
    expect(fake.state.inputClosed).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'system', subtype: 'init', session_id: 's9' });
    expect(argValue(fake.spawns[0]!.args, '--model')).toBe('m');
    expect(argValue(fake.spawns[0]!.args, '--settings')).toBe('/x');
  });
  it('SIGINT exits 130 by default, SIGTERM by signal', async () => {
    const fake = fakeClaudeCli();
    const a = fake.spawnFn('claude', [], { cwd: '/w', env: {} });
    const ea = new Promise((r) => a.once('exit', (c, s) => r([c, s])));
    a.kill('SIGINT');
    expect(await ea).toEqual([130, null]);
    const b = fake.spawnFn('claude', [], { cwd: '/w', env: {} });
    const eb = new Promise((r) => b.once('exit', (c, s) => r([c, s])));
    b.kill('SIGTERM');
    expect(await eb).toEqual([null, 'SIGTERM']);
    expect(fake.state.signals).toEqual(['SIGINT', 'SIGTERM']);
  });
});
```

- [ ] **Step 7: Run it and see it fail**

Run: `npx vitest run src/server/engine/claudeCli/stream.test.ts --maxWorkers=4`
Expected: FAIL — `Failed to resolve import "./messages"`.

- [ ] **Step 8: Implement `messages.ts`, `spawnTypes.ts`, `prompt.ts`**

```ts
// src/server/engine/claudeCli/messages.ts
// The subset of `claude -p --output-format stream-json` frames deck reads. Field names follow the
// CLI's own output (the same objects the SDK used to forward); unknown types pass through as
// CliOtherMessage and are ignored by the mapper.
export type Rec = Record<string, unknown>;
export type ContentBlock = Rec & { type: string };

export interface CliSystemMessage { type: 'system'; subtype: string; session_id?: string; uuid?: string; [k: string]: unknown }
export interface CliStreamEvent { type: 'stream_event'; parent_tool_use_id: string | null; event: Rec; session_id?: string; uuid?: string }
export interface CliAssistantMessage {
  type: 'assistant'; parent_tool_use_id: string | null;
  message: { id?: string; content: ContentBlock[]; usage?: unknown; [k: string]: unknown };
  session_id?: string; uuid?: string; error?: string; [k: string]: unknown;
}
export interface CliUserMessage {
  type: 'user'; parent_tool_use_id: string | null;
  message: { role: 'user'; content: string | ContentBlock[] };
  session_id?: string; uuid?: string; priority?: 'now' | 'next' | 'later'; isReplay?: boolean; [k: string]: unknown;
}
export interface CliResultMessage {
  type: 'result'; subtype: string; is_error?: boolean; result?: string; errors?: string[];
  session_id: string; usage?: unknown; modelUsage?: unknown; terminal_reason?: string | null; num_turns?: number; [k: string]: unknown;
}
export interface CliRateLimitEvent { type: 'rate_limit_event'; rate_limit_info: Rec; [k: string]: unknown }
export interface CliOtherMessage {
  type: 'keep_alive' | 'tool_progress' | 'tool_use_summary' | 'auth_status' | 'stream_request_start' | 'control_request' | 'control_cancel_request' | 'unknown';
  [k: string]: unknown;
}
export type CliMessage = CliSystemMessage | CliStreamEvent | CliAssistantMessage | CliUserMessage | CliResultMessage | CliRateLimitEvent | CliOtherMessage;

/** One stdout line → a frame, or null for blank/non-JSON/non-object lines (never throws). */
export function parseLine(line: string): CliMessage | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Rec).type === 'string' ? (v as CliMessage) : null;
  } catch {
    return null;
  }
}
```

```ts
// src/server/engine/claudeCli/spawnTypes.ts
import type { Readable, Writable } from 'node:stream';

/** The slice of ChildProcess the engine uses — a real `spawn()` result or the fake child. */
export interface ClaudeChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', cb: (err: Error) => void): unknown;
}

export type ClaudeSpawnFn = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ClaudeChildLike;
```

```ts
// src/server/engine/claudeCli/prompt.ts
import fs from 'node:fs/promises';
import { IMAGE_TYPES, promptWithFiles, type Attachment } from '../../attachments/AttachmentStore';
import type { CliUserMessage, ContentBlock } from './messages';

export type ReadFile = (p: string) => Promise<Buffer>;

/**
 * D7/D14: one stdin user message. Non-image attachments become path lines in the text; images
 * become base64 image blocks next to it. `session_id: ''` is what the SDK used to write.
 */
export async function toUserMessage(text: string, attachments: Attachment[], readFile: ReadFile = (p) => fs.readFile(p)): Promise<CliUserMessage> {
  const body = promptWithFiles(text, attachments);
  const images = attachments.filter((a) => a.isImage && IMAGE_TYPES.has(a.mediaType));
  if (!images.length) return { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: body } };
  const content: ContentBlock[] = [{ type: 'text', text: body }];
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: (await readFile(img.path)).toString('base64') } });
  }
  return { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
}
```

- [ ] **Step 9: Create `stream.ts` by moving code out of `ClaudeEngine.ts`**

Move these declarations unchanged in logic from `src/server/engine/ClaudeEngine.ts` to `src/server/engine/claudeCli/stream.ts`: `BackgroundTracker`, `ProgressMeter`, `taskUsageOf`, `PATCH_STATUS`, `taskUpdateOf`, `isActivity`, `isInjectedNoopResult`, `AuditSource` (now exported), `ToolAudit`, `toolAudit`, `deniedCalls`, `isoFromEpochSec`, `windowOf`, `usageOf`, `windowFromModelUsage`, `mapSdkMessage` (renamed `mapCliMessage`), `CommandsListener`, `noteCommands`. The file header:

```ts
// src/server/engine/claudeCli/stream.ts
import { contextUsageOf, type TaskStatus, type TaskUpdate, type TaskUsage, type TurnPhase, type TurnUsage } from '../../../shared/turn-types';
import { systemRow, textOfContent } from '../../sessions/transcript';
import type { BgTask, EngineEvent, EngineResult, RateLimitSignal, TurnRequest } from '../Engine';
import type { SlashCommandInfo } from '../slashCommands';
import type { CliMessage, Rec } from './messages';
```

Exactly these edits are needed for the looser local types (everything else is a type rename `SDKMessage` → `CliMessage`):

```ts
// toolAudit: narrow the parameter so permissions.ts/hooks.ts can share it
export function toolAudit(req: Pick<TurnRequest, 'onToolAudit'>): ToolAudit { /* body unchanged */ }

// mapCliMessage, case 'system' → init (fields are optional strings now)
if (m.subtype === 'init') return [{ kind: 'init', sessionId: String(m.session_id ?? ''), model: String(m.model ?? ''), ...(typeof m.cwd === 'string' ? { cwd: m.cwd } : {}) }];

// mapCliMessage, case 'system' → task_notification (status read defensively)
const r = m as Rec;
const status = r.status === 'failed' || r.status === 'stopped' ? r.status : 'completed';
const summary = typeof r.summary === 'string' ? r.summary : '';
if (r.ambient === true || r.skip_transcript === true) return [{ kind: 'task_done', status, summary }];
const usage = taskUsageOf(r.usage);
return [{ kind: 'task_done', status, summary, ...(typeof r.task_id === 'string' ? { taskId: r.task_id } : {}), toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : null, ...(usage ? { usage } : {}) }];

// mapCliMessage, case 'result'
const ok = m.subtype === 'success' && !m.is_error;
let errorText: string | null = null;
if (!ok) errorText = m.subtype === 'success' ? (m.result ?? '') : [m.subtype, ...(m.errors ?? [])].join(': ');
const result: EngineResult = { kind: 'result', sessionId: m.session_id, ok, text: ok ? (m.result ?? '') : '', usage: { ...usageOf(m.usage), ...windowFromModelUsage(m.modelUsage) }, errorText, stderr: null, errorKind: null, terminalReason: m.terminal_reason ?? null };
return [result];

// the assistant branch in the runTurn loop (Task 8a) reads blocks as ContentBlock: `b.type === 'tool_use'` then `String(b.id)`.
```

If `npx tsc --noEmit -p .` reports another SDK-only field, read it through `m as Rec` with a `typeof` check, the same way the surrounding code already does.

In `ClaudeEngine.ts`, delete the moved code and the old `buildPrompt`'s image helpers, keep `buildPrompt` (still used by its tests until Task 8b; Task 8a moves it into `legacySdkEngine.ts`) implemented on top of `toUserMessage`:

```ts
import { toUserMessage, type ReadFile } from './claudeCli/prompt';
import { BackgroundTracker, ProgressMeter, deniedCalls, isActivity, isInjectedNoopResult, mapCliMessage, noteCommands, toolAudit, type CommandsListener, type ToolAudit } from './claudeCli/stream';
export { BackgroundTracker, ProgressMeter, deniedCalls, noteCommands, toolAudit, toUserMessage, mapCliMessage as mapSdkMessage };
export type { CommandsListener, ToolAudit, ReadFile };
```

The temporary `SDKMessage`→`CliMessage` mismatch inside the still-SDK-driven `runTurn` is bridged with a single cast at the loop head: `for await (const sdkMsg of stream) { const m = sdkMsg as unknown as CliMessage; … }` (moved with the SDK engine into `legacySdkEngine.ts` in Task 8a, deleted with it in Task 8c).

- [ ] **Step 10: Implement `fakeClaudeCli.ts`**

```ts
// src/server/engine/claudeCli/fakeClaudeCli.ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import type { CliUserMessage, Rec } from './messages';
import type { ClaudeChildLike, ClaudeSpawnFn } from './spawnTypes';

export type FakeSpawn = { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
export type FakeCtl = { push(...ms: unknown[]): void; exit(code: number | null, signal?: NodeJS.Signals | null): void };

/**
 * Test double for the `claude` child. Frames pushed before a spawn are queued and written as soon
 * as the next child starts; frames pushed while a child is alive go straight to its stdout. Every
 * stdin line is parsed into `inputs`. Closing stdin ends the child with exit 0 (the real CLI's
 * behaviour once its input ends and the turn is over) unless `exitOnStdinClose: false`.
 * Signals: SIGINT → `onSignal` if given, else exit 130 with no output; SIGTERM/SIGKILL → killed by signal.
 */
export function fakeClaudeCli(opts: { exitOnStdinClose?: boolean; onSignal?: (sig: NodeJS.Signals, ctl: FakeCtl) => void } = {}) {
  const spawns: FakeSpawn[] = [];
  const inputs: CliUserMessage[] = [];
  const state = { inputClosed: false, calls: 0, signals: [] as NodeJS.Signals[] };
  const queue: unknown[] = [];
  let live: FakeCtl | null = null;
  let stderrOf: PassThrough | null = null;

  const spawnFn: ClaudeSpawnFn = (bin, args, o) => {
    state.calls++;
    state.inputClosed = false;
    spawns.push({ bin, args: [...args], cwd: o.cwd, env: { ...o.env } });
    const ee = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let exited = false;
    const ctl: FakeCtl = {
      push: (...ms) => { if (!exited) for (const m of ms) stdout.write(JSON.stringify(m) + '\n'); },
      exit: (code, signal = null) => {
        if (exited) return;
        exited = true;
        if (live === ctl) live = null;
        stdout.end();
        stderr.end();
        setImmediate(() => ee.emit('exit', code, signal));
      },
    };
    readline.createInterface({ input: stdin }).on('line', (l) => { if (l.trim()) inputs.push(JSON.parse(l) as CliUserMessage); });
    stdin.on('finish', () => {
      state.inputClosed = true;
      if (opts.exitOnStdinClose !== false) setImmediate(() => ctl.exit(0));
    });
    const child: ClaudeChildLike = {
      stdin, stdout, stderr, pid: 40000 + state.calls,
      kill: (sig: NodeJS.Signals = 'SIGTERM') => {
        state.signals.push(sig);
        if (exited) return false;
        if (sig === 'SIGINT') { if (opts.onSignal) opts.onSignal(sig, ctl); else ctl.exit(130); }
        else ctl.exit(null, sig);
        return true;
      },
      once: ((event: string, cb: (...a: never[]) => void) => { ee.once(event, cb as (...a: unknown[]) => void); return child; }) as ClaudeChildLike['once'],
    };
    live = ctl;
    stderrOf = stderr;
    const pending = queue.splice(0);
    if (pending.length) setImmediate(() => ctl.push(...pending));
    return child;
  };

  return {
    spawnFn,
    spawns,
    inputs,
    state,
    push: (...ms: unknown[]) => { if (live) live.push(...ms); else queue.push(...ms); },
    end: (code = 0) => { if (live) live.exit(code); },
    stderr: (text: string) => { stderrOf?.write(text); },
    ctl: () => live,
  };
}

/** `--flag value` or `--flag=value` → value (first occurrence). */
export function argValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) return args[i + 1];
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  return undefined;
}

/** stream-json frame builders: today's `sdk` builders (same names, same shapes) plus replay/result-for helpers. */
export const cli = {
  // Copy every entry of `sdk` from src/server/engine/fakeSdk.ts verbatim here (init … subagentTool), then:
  replay: (uuid: string, text = 'x'): Rec => ({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content: text }, session_id: 's1' }),
  resultFor: (uuids: string[], text: string, sid = 's1'): Rec => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, usage: { input_tokens: 1, output_tokens: 2 }, user_message_uuids: uuids }),
};
```

The "copy every entry of `sdk`" instruction is literal: the 17 builders (`init`, `delta`, `result`, `bgLevel`, `taskStarted`, `taskDone`, `notifyUser`, `notifyNoopResult`, `messageStart`, `blockStart`, `messageDelta`, `agentCall`, `agentStarted`, `agentProgress`, `subToolCall`, `subToolResult`, `subagentTool`) are moved character for character from `fakeSdk.ts` lines 52–77; `fakeSdk.ts` itself re-exports `cli as sdk` from here until it is deleted in Task 8b.

- [ ] **Step 11: Run the new tests and the old engine tests**

Run: `npx vitest run src/server/engine --maxWorkers=4`
Expected: PASS — the new `stream.test.ts` and `scrub.test.ts`, plus every existing `ClaudeEngine*.test.ts`, `thinking.test.ts`, `slashCommands.test.ts` unchanged (they still import from `ClaudeEngine`/`fakeSdk`, which re-export).

- [ ] **Step 12: Commit**

```bash
git add src/server/engine/claudeCli/messages.ts src/server/engine/claudeCli/spawnTypes.ts src/server/engine/claudeCli/prompt.ts src/server/engine/claudeCli/stream.ts src/server/engine/claudeCli/stream.test.ts src/server/engine/claudeCli/fakeClaudeCli.ts src/server/engine/claudeCli/fixtures src/server/engine/ClaudeEngine.ts src/server/engine/fakeSdk.ts
git commit -m "refactor(claude-cli): stream-json 메시지 타입·매퍼 분리, 가짜 claude 자식 프로세스와 첫 실측 픽스처"
```

---

### Task 3: Process lifecycle — spawn, stdin follow-ups, SIGINT abort, exit codes, stderr, rate limits

**Files:**
- Create: `src/server/engine/claudeCli/process.ts`, `src/server/engine/claudeCli/process.test.ts`
- Create: `src/server/engine/claudeCli/fixtures/capture.ts` (dev-only), `fixtures/abort.jsonl`, `fixtures/abort.meta.json`, `fixtures/steer.jsonl`, `fixtures/steer.meta.json`
- Create (go/no-go spikes, Steps 7–11): `fixtures/go-no-go.meta.json`, `fixtures/background.jsonl`, `fixtures/background.meta.json` (scenario `background`, moved here from Task 7), `fixtures/ask.jsonl`, `fixtures/ask.meta.json` (spike D6, moved here from Task 4)

This task also runs the early go/no-go spikes (E1/E3 hook echo, D6 AskUserQuestion through the prompt tool, H1 background survival, F1 fork from a truncated transcript) against the real CLI, so the risky unknowns are answered before Tasks 4–8c build on them. They use throwaway helpers in a temp dir (a printf hook, a 30-line spike MCP server, a hand-truncated transcript), not the Task 4–6 modules, which do not exist yet. Tasks 4–7 keep their own captures as regression fixtures for deck's real code paths.

**Interfaces:**
- Consumes: `ClaudeSpawnFn`, `ClaudeChildLike` (`spawnTypes.ts`), `parseLine`, `CliMessage`, `CliUserMessage` (`messages.ts`), `STDERR_MAX` (`../redact`), `claudeArgs`, `claudeEnv` (`args.ts`), `resolveClaudeBin` (`version.ts`), `scrubLine` (`fixtures/scrub.ts`), `classifyFailure` (`../limitDetect`), `BackgroundTracker` (`stream.ts`, for the `background` scenario).
- Produces:
  ```ts
  export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; spawnError: string | null };
  export interface ClaudeProcessOpts { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; spawnFn?: ClaudeSpawnFn; killGraceMs?: number; drainMs?: number }
  export const KILL_GRACE_MS = 5_000;
  export class ClaudeProcess {
    constructor(o: ClaudeProcessOpts);
    readonly exited: Promise<ProcessExit>;
    get exit(): ProcessExit | null;
    get stderrTail(): string;
    get inputOpen(): boolean;
    get interrupted(): boolean;
    start(): void;
    messages(): AsyncGenerator<CliMessage>;
    write(m: CliUserMessage): boolean;
    closeInput(): void;
    /** SIGINT once; if the child is still alive after killGraceMs: close stdin + terminate(). */
    interrupt(): void;
    /** Close stdin; terminate() if the child has not exited after killGraceMs. */
    stop(): void;
    /** SIGTERM, then SIGKILL after killGraceMs. */
    terminate(): void;
  }
  export function exitFailureText(exit: ProcessExit): string;   // Korean, for a turn that ended without a result
  ```

- [ ] **Step 1: Write the failing process test**

```ts
// src/server/engine/claudeCli/process.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaudeProcess, exitFailureText } from './process';
import { fakeClaudeCli, cli } from './fakeClaudeCli';
import { parseLine, type CliMessage } from './messages';
import { mapCliMessage } from './stream';
import { classifyFailure } from '../limitDetect';

const mk = (fake: ReturnType<typeof fakeClaudeCli>, extra: Partial<ConstructorParameters<typeof ClaudeProcess>[0]> = {}) =>
  new ClaudeProcess({ bin: 'claude', args: ['-p'], cwd: '/w', env: { A: '1' }, spawnFn: fake.spawnFn, killGraceMs: 50, drainMs: 20, ...extra });

const collect = async (p: ClaudeProcess) => { const out: CliMessage[] = []; for await (const m of p.messages()) out.push(m); return out; };

afterEach(() => vi.useRealTimers());

describe('ClaudeProcess', () => {
  it('spawns with bin/args/cwd/env, writes stdin lines, yields stdout frames, exits 0 after stdin closes', async () => {
    const fake = fakeClaudeCli();
    const p = mk(fake);
    p.start();
    expect(fake.spawns[0]).toMatchObject({ bin: 'claude', args: ['-p'], cwd: '/w', env: { A: '1' } });
    expect(p.write({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'hi' }, uuid: 'u1' })).toBe(true);
    fake.push(cli.init(), cli.result('ok'));
    const reading = collect(p);
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    p.closeInput();
    expect(p.write({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'late' } })).toBe(false);
    const frames = await reading;
    expect(frames.map((f) => f.type)).toEqual(['system', 'result']);
    expect(await p.exited).toEqual({ code: 0, signal: null, spawnError: null });
    expect(fake.inputs[0]!.uuid).toBe('u1');
  });

  it('skips non-JSON stdout lines', async () => {
    const fake = fakeClaudeCli();
    const p = mk(fake);
    p.start();
    const reading = collect(p);
    fake.ctl()!.raw('not json');
    fake.ctl()!.push(cli.init());
    fake.end(0);
    expect((await reading).length).toBe(1);
  });

  it('interrupt sends SIGINT once and escalates to SIGTERM when the child ignores it', async () => {
    const fake = fakeClaudeCli({ onSignal: () => { /* ignore SIGINT */ } });
    const p = mk(fake);
    p.start();
    p.interrupt();
    p.interrupt();
    expect(fake.state.signals).toEqual(['SIGINT']);
    expect(await p.exited).toEqual({ code: null, signal: 'SIGTERM', spawnError: null });
    expect(fake.state.signals).toEqual(['SIGINT', 'SIGTERM']);
    expect(fake.state.inputClosed).toBe(true);
    expect(p.interrupted).toBe(true);
  });

  it('interrupt: a child that answers SIGINT with a result keeps running until stop()', async () => {
    const fake = fakeClaudeCli({ onSignal: (_s, ctl) => ctl.push({ ...cli.result(''), subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted' }) });
    const p = mk(fake, { killGraceMs: 10_000 });
    p.start();
    const it = p.messages()[Symbol.asyncIterator]();
    p.interrupt();
    const r = (await it.next()).value as CliMessage;
    expect(r.type).toBe('result');
    p.stop();
    expect(await p.exited).toEqual({ code: 0, signal: null, spawnError: null });
    expect(fake.state.signals).toEqual(['SIGINT']);
  });

  it('stop escalates to SIGTERM then SIGKILL for a child that never exits', async () => {
    const fake = fakeClaudeCli({ exitOnStdinClose: false });
    const p = mk(fake);
    p.start();
    p.stop();
    expect(await p.exited).toMatchObject({ signal: 'SIGTERM' });
  });

  it('keeps the stderr tail and never mixes it into frames', async () => {
    const fake = fakeClaudeCli();
    const p = mk(fake);
    p.start();
    fake.stderr('x'.repeat(10_000) + 'TAIL');
    fake.end(1);
    await p.exited;
    await collect(p);
    expect(p.stderrTail.endsWith('TAIL')).toBe(true);
    expect(p.stderrTail.length).toBeLessThanOrEqual(4096);
    expect(p.exit).toEqual({ code: 1, signal: null, spawnError: null });
  });

  it('a throwing spawn is recorded as spawnError, not thrown', async () => {
    const p = new ClaudeProcess({ bin: '/nope', args: [], cwd: '/w', env: {}, spawnFn: () => { throw new Error('ENOENT'); } });
    p.start();
    expect(await p.exited).toEqual({ code: null, signal: null, spawnError: 'ENOENT' });
    expect(await collect(p)).toEqual([]);
    expect(p.write({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'x' } })).toBe(false);
  });

  it('exitFailureText (Korean, never stderr)', () => {
    expect(exitFailureText({ code: null, signal: null, spawnError: 'spawn claude ENOENT' })).toBe('Claude Code 실행 실패: spawn claude ENOENT');
    expect(exitFailureText({ code: 1, signal: null, spawnError: null })).toBe('Claude Code 종료 코드 1');
    expect(exitFailureText({ code: null, signal: 'SIGKILL', spawnError: null })).toBe('Claude Code 종료 신호 SIGKILL');
  });
});

describe('rate limits ride the stream, never stderr (review M4)', () => {
  it('rate_limit_event → rate_limit; an error result text classifies as limit', () => {
    const ev = mapCliMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1_800_000_000 } } } });
    expect(ev[0]).toMatchObject({ kind: 'rate_limit', info: { status: 'rejected', fiveHour: { usedPct: 100 } } });
    const [res] = mapCliMessage({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1800000000', session_id: 's' }) as [{ ok: boolean; errorText: string | null }];
    expect(classifyFailure({ ok: res.ok, errorText: res.errorText, errorKind: null, rateLimitStatus: null })).toBe('limit');
  });
});

describe('abort fixture (real CLI capture)', () => {
  const file = path.join(__dirname, 'fixtures', 'abort.jsonl');
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'abort.meta.json'), 'utf8')) as { resultAfterSigint: boolean; exit: { code: number | null; signal: string | null } };
  const frames = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => parseLine(l)!);
  it('B1: SIGINT mid-turn still produced a result frame, after the last text delta', () => {
    expect(meta.resultAfterSigint).toBe(true);
    const lastDelta = frames.map((f) => f.type).lastIndexOf('stream_event');
    const result = frames.findIndex((f) => f.type === 'result');
    expect(result).toBeGreaterThan(lastDelta);
  });
  it('B2: the process then exited on stdin close without a signal', () => {
    expect(meta.exit.signal).toBeNull();
  });
});
```

The `stop escalates` case uses a fake child that ignores stdin close (`exitOnStdinClose: false`), so `stop()` must fall through to SIGTERM after `killGraceMs`. The `skips non-JSON` case needs one addition to `fakeClaudeCli.ts` (make it in this step): `FakeCtl` gains `raw(text: string): void`, implemented inside `spawnFn` as `raw: (t) => { if (!exited) stdout.write(t + '\n'); }`.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/server/engine/claudeCli/process.test.ts --maxWorkers=4`
Expected: FAIL — `Failed to resolve import "./process"`.

- [ ] **Step 3: Implement `process.ts`**

```ts
// src/server/engine/claudeCli/process.ts
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { STDERR_MAX } from '../redact';
import { parseLine, type CliMessage, type CliUserMessage } from './messages';
import type { ClaudeChildLike, ClaudeSpawnFn } from './spawnTypes';

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; spawnError: string | null };
export interface ClaudeProcessOpts { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; spawnFn?: ClaudeSpawnFn; killGraceMs?: number; drainMs?: number }

export const KILL_GRACE_MS = 5_000;
const DRAIN_MS = 1_000;

const defaultSpawn: ClaudeSpawnFn = (bin, args, o) =>
  spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ClaudeChildLike;

export function exitFailureText(e: ProcessExit): string {
  if (e.spawnError !== null) return `Claude Code 실행 실패: ${e.spawnError}`;
  if (e.signal) return `Claude Code 종료 신호 ${e.signal}`;
  return `Claude Code 종료 코드 ${e.code ?? '?'}`;
}

/**
 * One `claude -p --input-format stream-json` child. Abort is SIGINT (the CLI ends the turn and
 * still writes its result); stdin stays open so deck can keep the process for background tasks
 * and steers, and closing it is how a finished process is let go. No control protocol on stdin.
 */
export class ClaudeProcess {
  readonly exited: Promise<ProcessExit>;
  private resolveExit!: (e: ProcessExit) => void;
  private child: ClaudeChildLike | null = null;
  private _exit: ProcessExit | null = null;
  private _stderr = '';
  private _inputOpen = false;
  private _interrupted = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly grace: number;
  private readonly drain: number;

  constructor(private readonly o: ClaudeProcessOpts) {
    this.exited = new Promise((r) => { this.resolveExit = r; });
    this.grace = o.killGraceMs ?? KILL_GRACE_MS;
    this.drain = o.drainMs ?? DRAIN_MS;
  }

  get exit(): ProcessExit | null { return this._exit; }
  get stderrTail(): string { return this._stderr; }
  get inputOpen(): boolean { return this._inputOpen; }
  get interrupted(): boolean { return this._interrupted; }

  start(): void {
    try {
      this.child = (this.o.spawnFn ?? defaultSpawn)(this.o.bin, this.o.args, { cwd: this.o.cwd, env: this.o.env });
    } catch (err) {
      this.finish({ code: null, signal: null, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const c = this.child;
    this._inputOpen = true;
    c.stdin.on('error', () => { this._inputOpen = false; }); // EPIPE once the child is gone
    c.stderr.on('data', (b: Buffer) => { this._stderr = (this._stderr + b.toString('utf8')).slice(-STDERR_MAX); });
    c.once('error', (err) => this.finish({ code: null, signal: null, spawnError: err.message }));
    c.once('exit', (code, signal) => this.finish({ code, signal, spawnError: null }));
  }

  /** stdout frames until stdout closes — or `drainMs` after exit, in case a descendant kept the pipe open. */
  async *messages(): AsyncGenerator<CliMessage> {
    const c = this.child;
    if (!c) return;
    const rl = readline.createInterface({ input: c.stdout, crlfDelay: Infinity });
    void this.exited.then(() => { const t = setTimeout(() => rl.close(), this.drain); t.unref?.(); });
    for await (const line of rl) {
      const m = parseLine(line);
      if (m) yield m;
    }
  }

  write(m: CliUserMessage): boolean {
    if (!this._inputOpen || !this.child || this._exit) return false;
    this.child.stdin.write(JSON.stringify(m) + '\n');
    return true;
  }

  closeInput(): void {
    if (!this._inputOpen || !this.child) return;
    this._inputOpen = false;
    this.child.stdin.end();
  }

  interrupt(): void {
    if (this._interrupted || this._exit || !this.child) return;
    this._interrupted = true;
    this.child.kill('SIGINT');
    this.after(() => { this.closeInput(); this.terminate(); });
  }

  stop(): void {
    this.closeInput();
    if (!this._exit) this.after(() => this.terminate());
  }

  terminate(): void {
    if (this._exit || !this.child) return;
    this.child.kill('SIGTERM');
    this.after(() => { if (!this._exit) this.child?.kill('SIGKILL'); });
  }

  private after(fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); if (!this._exit) fn(); }, this.grace);
    t.unref?.();
    this.timers.add(t);
  }

  private finish(e: ProcessExit): void {
    if (this._exit) return;
    this._exit = e;
    this._inputOpen = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.resolveExit(e);
  }
}
```

Note the `drainMs` close: `messages()` must be called before or after exit — if called after exit the timer is armed on the already-resolved promise and still closes the reader, which is what the stderr test relies on.

- [ ] **Step 4: Write the capture runner (dev-only) with the `abort`, `steer` and `background` scenarios** (`background` is captured by spike H1 in Step 9)

```ts
// src/server/engine/claudeCli/fixtures/capture.ts
// Dev-only live capture. Never imported by the server or by tests.
// Usage (repo root): npx tsx src/server/engine/claudeCli/fixtures/capture.ts <scenario>
// Runs the user's real `claude` with --max-turns, in a fresh temp dir, project settings only
// (no user hooks/plugins in the capture), and writes fixtures/<scenario>.jsonl + .meta.json (scrubbed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProcess } from '../process';
import { claudeArgs, claudeEnv } from '../args';
import { resolveClaudeBin } from '../version';
import { scrubLine } from './scrub';
import { BackgroundTracker } from '../stream';
import type { CliMessage, CliUserMessage, Rec } from '../messages';

export type CaptureCtx = {
  proc: ClaudeProcess; dir: string; frames: CliMessage[]; meta: Rec;
  send(text: string, extra?: Partial<CliUserMessage>): string;
};
export type Scenario = {
  maxTurns: number;
  timeoutMs?: number;
  settings?: Record<string, unknown>;
  /** Default false: prompts off (`--permission-prompts none`, no prompt tool). Task 4 adds the bridge path. */
  bridge?: boolean;
  extraArgs?: (dir: string) => string[];
  resume?: (dir: string) => string;
  first: string;
  drive(ctx: CaptureCtx, m: CliMessage): void | Promise<void>;
  /** Extra checks recorded into meta after the run. */
  after?(ctx: CaptureCtx): void | Promise<void>;
};

export const FIRST_UUID = '00000000-0000-4000-8000-000000000001';
export const SECOND_UUID = '00000000-0000-4000-8000-000000000002';

const text = (m: CliMessage): string => (m.type === 'stream_event' && (m.event as Rec).type === 'content_block_delta' ? String(((m.event as Rec).delta as Rec)?.text ?? '') : '');

export const scenarios: Record<string, Scenario> = {
  abort: {
    maxTurns: 1,
    first: 'Write the numbers from 1 to 400, one per line, with nothing else.',
    drive: (ctx, m) => {
      if (!ctx.proc.interrupted && text(m)) { ctx.meta.sigintAfterFrame = ctx.frames.length; ctx.proc.interrupt(); }
      if (m.type === 'result') { ctx.meta.resultAfterSigint = ctx.proc.interrupted; ctx.meta.result = { subtype: m.subtype, is_error: m.is_error, terminal_reason: m.terminal_reason ?? null }; ctx.proc.stop(); }
    },
  },
  steer: {
    maxTurns: 3,
    settings: { permissions: { allow: ['Bash(sleep 4)'] } },
    first: 'Run the shell command `sleep 4` with the Bash tool. When it finishes, reply with the secret word if I have told you one, else reply NONE.',
    drive: (ctx, m) => {
      if (m.type === 'assistant' && m.message.content.some((b) => b.type === 'tool_use') && !ctx.meta.steerSent) {
        ctx.meta.steerSent = true;
        ctx.send('The secret word is MANGO.', { uuid: SECOND_UUID, priority: 'next' });
      }
      if (m.type === 'user' && m.isReplay === true) (ctx.meta.replays as string[] | undefined ?? (ctx.meta.replays = [] as string[]) as string[]).push(String(m.uuid));
      if (m.type === 'result') {
        ((ctx.meta.results ??= []) as unknown[]).push({ uuids: m.user_message_uuids ?? m.user_message_uuid ?? null, text: m.result });
        const named = JSON.stringify(m.user_message_uuids ?? m.user_message_uuid ?? '');
        if (named.includes(SECOND_UUID) || String(m.result ?? '').includes('MANGO')) ctx.proc.stop();
      }
    },
  },
  background: {
    maxTurns: 3,
    timeoutMs: 120_000,
    settings: { permissions: { allow: ['Bash(sleep 6)'] } },
    first: 'Run the shell command `sleep 6` with the Bash tool with run_in_background set to true. Do not wait for it: reply STARTED right away. When it finishes, reply FINISHED.',
    drive: (ctx, m) => {
      const bg = (ctx.meta.bgTracker ??= new BackgroundTracker()) as BackgroundTracker;
      bg.apply(m);
      if (m.type === 'system' && m.subtype === 'background_tasks_changed') ctx.meta.sawLevel = true;
      if (m.type === 'system' && m.subtype === 'task_started') ctx.meta.sawTaskStarted = true;
      if (m.type === 'system' && m.subtype === 'task_notification') ctx.meta.sawNotification = true;
      if (m.type !== 'result') return;
      const results = ((ctx.meta.results ??= []) as unknown[]);
      results.push({ uuids: m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : null), tasksLive: bg.tasks().length });
      if (results.length === 1) {
        // The engine's rule: stdin stays open while a task is live. Check the child is still there a moment later.
        setTimeout(() => { ctx.meta.aliveAfterFirstResult = ctx.proc.exit === null; }, 500);
        if (bg.tasks().length === 0) ctx.proc.stop();
      } else if (bg.tasks().length === 0) {
        ctx.proc.stop();
      }
    },
    after: (ctx) => { delete ctx.meta.bgTracker; },
  },
};

function replaceFlag(args: string[], flag: string, value: string | null): string[] {
  const i = args.indexOf(flag);
  if (i < 0) return value === null ? args : [...args, flag, value];
  return value === null ? [...args.slice(0, i), ...args.slice(i + 2)] : [...args.slice(0, i + 1), value, ...args.slice(i + 2)];
}

export async function capture(name: string, sc: Scenario, hooks: { bridgeSetup?: (dir: string) => Promise<{ mcpConfigPath: string; settings: Record<string, unknown>; dispose(): Promise<void> }> } = {}): Promise<void> {
  const bin = resolveClaudeBin(process.env, os.homedir());
  if (!bin.ok) throw new Error(`claude not usable: ${bin.reason}`);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qd-cap-')));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const bridge = sc.bridge && hooks.bridgeSetup ? await hooks.bridgeSetup(dir) : null;
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ ...(sc.settings ?? {}), ...(bridge?.settings ?? {}) }), { mode: 0o600 });
  const mcpConfigPath = bridge?.mcpConfigPath ?? path.join(dir, 'mcp.json');
  if (!bridge) fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  let args = claudeArgs({ model: 'sonnet', permissionMode: 'default', settingsPath, mcpConfigPath, ...(sc.resume ? { resume: sc.resume(dir) } : {}) });
  args = replaceFlag(args, '--setting-sources', 'project');
  if (!bridge) { args = replaceFlag(args, '--permission-prompt-tool', null); args = replaceFlag(args, '--permission-prompts', 'none'); }
  args.push('--max-turns', String(sc.maxTurns), ...(sc.extraArgs?.(dir) ?? []));
  const proc = new ClaudeProcess({ bin: bin.bin, args, cwd: work, env: claudeEnv(process.env, 600_000) });
  const frames: CliMessage[] = [];
  const meta: Rec = { cli: bin.version, scenario: name, maxTurns: sc.maxTurns };
  const ctx: CaptureCtx = {
    proc, dir, frames, meta,
    send: (t, extra = {}) => { const uuid = extra.uuid ?? randomUUID(); proc.write({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: t }, ...extra, uuid }); return uuid; },
  };
  proc.start();
  ctx.send(sc.first, { uuid: FIRST_UUID });
  const timer = setTimeout(() => { meta.timedOut = true; proc.terminate(); }, sc.timeoutMs ?? 180_000);
  for await (const m of proc.messages()) { frames.push(m); await sc.drive(ctx, m); }
  const exit = await proc.exited;
  clearTimeout(timer);
  meta.exit = { code: exit.code, signal: exit.signal };
  await sc.after?.(ctx);
  await bridge?.dispose();
  const scrub = (s: string) => scrubLine(s, { home: os.homedir(), cwd: work });
  const out = path.join(import.meta.dirname, `${name}.jsonl`);
  fs.writeFileSync(out, frames.map((f) => scrub(JSON.stringify(f))).join('\n') + '\n');
  fs.writeFileSync(path.join(import.meta.dirname, `${name}.meta.json`), scrub(JSON.stringify(meta, null, 2)) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${path.relative(process.cwd(), out)} (${frames.length} frames)`, meta.exit);
}

if (process.argv[1]?.endsWith('capture.ts')) {
  const name = process.argv[2] ?? '';
  const sc = scenarios[name];
  if (!sc) { console.error(`scenarios: ${Object.keys(scenarios).join(', ')}`); process.exit(2); }
  await capture(name, sc);
}
```

- [ ] **Step 5 (spike): Capture `abort` and `steer`**

Run (repo root):
```bash
npx tsx src/server/engine/claudeCli/fixtures/capture.ts abort
npx tsx src/server/engine/claudeCli/fixtures/capture.ts steer
npx vitest run src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=4
```
Expected: two fixtures plus meta files; hygiene PASS.

`abort` validates: (B1) in stream-json input mode a SIGINT mid-turn still yields a `result` frame (meta `resultAfterSigint: true`, its `subtype`/`terminal_reason` recorded), and (B2) the process keeps waiting on stdin and exits 0 once `stop()` closes it (meta `exit.signal: null`). If B1 fails (no result after SIGINT), the engine's synthesized `중단됨` result (Task 8a) covers it and the B1 test is changed to `expect(meta.resultAfterSigint).toBe(false)` with a comment pointing at the meta file. If B2 fails (the CLI exits on SIGINT by itself), nothing changes in the engine: `ClaudeProcess` already treats an early exit as the end of `messages()`.

`steer` validates: (C1) our stdin `uuid` comes back as an `isReplay` frame when the CLI takes the message (meta `replays` contains `…0002`); (C2) `priority: "next"` folds the message into the running turn at the Bash tool boundary, so one result names both uuids and contains MANGO; (C3) results carry `user_message_uuids`. If C2 fails (the steer becomes its own next turn), the engine still answers it correctly through `unanswered` bookkeeping; record that under "Lost or changed features" ("steer folds in only at the next turn").

- [ ] **Step 6: Run the process test and see it pass**

Run: `npx vitest run src/server/engine/claudeCli/process.test.ts --maxWorkers=4`
Expected: PASS.

- [ ] **Step 7 (go/no-go spike E1/E3): hook echo through a `--settings` command hook**

The spikes in Steps 7–10 share one shell session (repo root) and one verdict file. Define the helper once:

```bash
verdict() { node -e 'const fs=require("fs"),[f,k,v]=process.argv.slice(1);const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};j[k]=v==="true";j.cli=process.env.CLI_VER;fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' src/server/engine/claudeCli/fixtures/go-no-go.meta.json "$1" "$2"; echo "$1=$2"; }
export CLI_VER="$(claude --version | head -1)"
```

Run a print-mode turn whose `--settings` carries two plain command hooks (no deck code involved): a PreToolUse deny on Bash and a UserPromptSubmit `additionalContext`:

```bash
D=$(mktemp -d)
cat > "$D/settings.json" <<'EOF'
{"permissions":{"allow":["Bash(echo hi)"]},
 "hooks":{
  "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","timeout":30,"command":"printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"HOOK-DENY-MARKER\"}}'"}]}],
  "UserPromptSubmit":[{"hooks":[{"type":"command","timeout":30,"command":"printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"The codeword is PAPAYA.\"}}'"}]}]
}}
EOF
printf '%s\n' '{"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"Run `echo hi` with the Bash tool and quote its tool result verbatim. Then tell me the codeword from your context if you were given one, else NONE."}}' \
  | (cd "$D" && perl -e 'alarm 180; exec @ARGV' claude -p --output-format stream-json --input-format stream-json --verbose --max-turns 3 --model claude-sonnet-5-5 \
      --setting-sources project "--settings=$D/settings.json" --permission-prompts none) > "$D/e.jsonl"
node -e '
const fr = require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const tr = fr.filter((f) => f.type === "user" && Array.isArray(f.message?.content)).flatMap((f) => f.message.content).filter((b) => b.type === "tool_result");
const res = fr.find((f) => f.type === "result");
console.log("E1", tr.some((b) => b.is_error && JSON.stringify(b.content).includes("HOOK-DENY-MARKER")));
console.log("E3", String(res?.result ?? "").includes("PAPAYA"));' "$D/e.jsonl"
```

(`echo hi` is pre-allowed, so only the hook can block it.) Positive: the script prints `E1 true` (the Bash call came back as an error `tool_result` carrying HOOK-DENY-MARKER, i.e. the hook's JSON `permissionDecision` is honoured in print mode) and `E3 true` (the `result` names PAPAYA, i.e. `additionalContext` reached the model). Record both: `verdict E1 true|false; verdict E3 true|false`, then `rm -rf "$D"`.

Negative and fallback:
- E1 false: the noTools turn (handoff note) and the mode gate cannot rely on a PreToolUse hook. The `--permission-prompt-tool` route still sees every call that is not pre-allowed, so Task 5 moves the noTools deny and the plan-mode edit deny into `permissionHandler` (Task 4 already denies noTools there) and drops the PreToolUse relay; the acceptEdits auto-allow from the mode gate is lost mid-turn (see "Lost or changed features", row "Mid-process permission-mode change": the new mode then applies from the next turn).
- E3 false: stop and report before Task 4 instead of improvising. The alternatives (`--append-system-prompt`, or a separate first stdin message) either change the system prompt and its cache or put the note into the visible transcript, and both contradict how `systemNote` works today.

- [ ] **Step 8 (go/no-go spike D6): AskUserQuestion through the permission prompt tool**

deck's bridge does not exist yet, so the spike uses a throwaway stdio MCP server that answers AskUserQuestion with Blue and denies anything else. The raw stream is scrubbed into `fixtures/ask.jsonl`, which Task 4's `D6` test reads.

```bash
D=$(mktemp -d)
cat > "$D/spike-mcp.mjs" <<'EOF'
import fs from 'node:fs';
import readline from 'node:readline';
const log = new URL('./calls.log', import.meta.url);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spike', version: '0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'permission', description: 'spike permission prompt', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }] } });
  if (m.method === 'tools/call') {
    const a = m.params.arguments;
    fs.appendFileSync(log, a.tool_name + '\n');
    const q = a.input?.questions?.[0]?.question ?? '';
    const reply = a.tool_name === 'AskUserQuestion'
      ? { behavior: 'allow', updatedInput: { ...a.input, answers: { [q]: 'Blue' } } }
      : { behavior: 'deny', message: 'spike: only AskUserQuestion is answered' };
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
EOF
printf '{"mcpServers":{"spike":{"type":"stdio","command":"%s","args":["%s"]}}}\n' "$(command -v node)" "$D/spike-mcp.mjs" > "$D/mcp.json"
printf '%s\n' '{"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"Use the AskUserQuestion tool to ask me one question, \"Which color?\", with the options Red and Blue. Then reply with my answer only."}}' \
  | (cd "$D" && perl -e 'alarm 180; exec @ARGV' claude -p --output-format stream-json --input-format stream-json --verbose --max-turns 3 --model claude-sonnet-5-5 \
      --setting-sources project "--mcp-config=$D/mcp.json" --permission-prompts host --permission-prompt-tool mcp__spike__permission) > "$D/raw.jsonl"
cat "$D/calls.log"
npx tsx src/server/engine/claudeCli/fixtures/scrub.ts --home "$HOME" --cwd "$D" < "$D/raw.jsonl" > src/server/engine/claudeCli/fixtures/ask.jsonl
printf '{"cli":"%s","scenario":"ask","args":"-p stream-json, spike MCP server as --permission-prompt-tool, --max-turns 3"}\n' "$CLI_VER" > src/server/engine/claudeCli/fixtures/ask.meta.json
node -e 'const r = require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === "result"); console.log("D6", String(r?.result ?? "").includes("Blue"));' "$D/raw.jsonl"
```

Positive: `calls.log` lists `AskUserQuestion` and the script prints `D6 true` (the `answers` in `updatedInput` reached the model). Record `verdict D6 true|false`, then `rm -rf "$D"`.

Negative and fallback: AskUserQuestion has no other documented route in print mode. Stop and report before Task 4 — do not start the bridge work. The decision (ship without AskUserQuestion, i.e. the model gets a deny and the question card never appears, or stay on the SDK) belongs to the user; if they accept the loss, add a row "AskUserQuestion — Lost" to "Lost or changed features" and Task 4 Step 11's D6 test asserts the recorded negative instead.

- [ ] **Step 9 (go/no-go spike H1): background task survives the first result while stdin stays open**

Capture the `background` scenario (Step 4). `capture()` keeps stdin open until the scenario calls `stop()`, which is exactly deck's holding rule:

```bash
npx tsx src/server/engine/claudeCli/fixtures/capture.ts background
node -e 'const m = require("./src/server/engine/claudeCli/fixtures/background.meta.json"); console.log("H1", m.aliveAfterFirstResult === true && m.results?.[0]?.tasksLive === 1, "results", m.results?.length);'
```

Assumptions validated (recorded in `background.meta.json`, asserted by Task 7's replay test):
- H1: after the first `result` with a live background task, the child stays alive while stdin is open (`aliveAfterFirstResult: true`, `results[0].tasksLive: 1`).
- H2: print mode emits the level signal `background_tasks_changed` (`sawLevel`) or at least the `task_started` / `task_notification` bookends (`sawTaskStarted && sawNotification`); `BackgroundTracker` handles either.
- H3: the CLI runs the continuation turn by itself after the task settles, and that `result` names none of deck's uuids (`results[1].uuids` is `null` or `[]`, never `[FIRST_UUID]`), so the existing "names its answers" rule classifies it as a background continuation.
- H4: closing stdin after the last result ends the child with exit code 0 (`exit.code: 0`).

Positive: the script prints `H1 true results 2`. Record `verdict H1 true|false`.

Negative and fallback: if H1 fails (the child exits at the first result even with stdin open), background work cannot outlive a turn: Task 8a then closes stdin at the first result regardless, `BG_MAX_MS`/`BG_GRACE_MS` become unused, Task 7's H1/H3 assertions are changed to the recorded values, and "Background tasks after the turn" in "Lost or changed features" becomes **Lost**. If H3 fails because the continuation's result does name `FIRST_UUID`, the loop's `answer()` call is a no-op for it (already answered) and nothing changes — record it in meta and keep going.

- [ ] **Step 10 (go/no-go spike F1): fork from a truncated transcript with `--resume <path> --fork-session`**

Run a two-turn parent session with a known id, cut its transcript after the first turn by hand, and resume the cut copy as a fork:

```bash
D=$(mktemp -d); mkdir "$D/work"; D=$(cd "$D" && pwd -P)
SID=$(node -e 'console.log(require("crypto").randomUUID())')
{ printf '%s\n' '{"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"Remember the codeword KIWI. Reply only OK."}}'; sleep 25;
  printf '%s\n' '{"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"Also remember the codeword LIME. Reply only OK."}}'; sleep 25; } \
  | (cd "$D/work" && perl -e 'alarm 120; exec @ARGV' claude -p --output-format stream-json --input-format stream-json --verbose --max-turns 2 --model claude-sonnet-5-5 \
      --setting-sources project --permission-prompts none "--session-id=$SID") > "$D/parent.jsonl"
PROJ="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
SRC=$(find "$PROJ" -name "$SID.jsonl" | head -1); echo "parent transcript: ${SRC:+found}"
# Keep every line up to (not including) the first user entry that mentions LIME.
node -e 'const fs=require("fs"); const ls=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean); const i=ls.findIndex((l)=>{const r=JSON.parse(l); return r.type==="user" && JSON.stringify(r.message??"").includes("LIME");}); fs.writeFileSync(process.argv[2], ls.slice(0, i<0?ls.length:i).join("\n")+"\n");' "$SRC" "$D/cut.jsonl"
printf '%s\n' '{"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"List every codeword I asked you to remember, comma-separated, nothing else."}}' \
  | (cd "$D/work" && perl -e 'alarm 120; exec @ARGV' claude -p --output-format stream-json --input-format stream-json --verbose --max-turns 1 --model claude-sonnet-5-5 \
      --setting-sources project --permission-prompts none "--resume=$D/cut.jsonl" --fork-session) > "$D/fork.jsonl"
node -e '
const fr = require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const init = fr.find((f) => f.type === "system" && f.subtype === "init"); const r = fr.find((f) => f.type === "result");
const t = String(r?.result ?? ""); console.log("F1", /KIWI/.test(t) && !/LIME/.test(t), "newId", init?.session_id !== process.argv[2], "result", JSON.stringify(t));' "$D/fork.jsonl" "$SID"
```

Positive: `F1 true newId true` — the CLI accepted a path for `--resume`, loaded exactly the cut history (KIWI, not LIME) and forked under a new id. Record `verdict F1 true|false`. Clean up the profile: `rm -rf "$D"` and remove the project directories the two runs created under `$PROJ` (the directories whose name ends in the temp dir's basename plus `-work`; check with `ls "$PROJ" | grep -- "$(basename "$D")"` before deleting).

Negative and fallback: if the CLI rejects a path, ignores the cut, or reuses the parent id, fork-at-message is deferred: Task 6 item 1 (fork-at-message, `fork.ts`, the `fork-parent`/`fork-file` scenarios) is skipped; the engine yields `FORK_AT_UNSUPPORTED` for every `forkAt` (Task 8a handles a `{ ok: false }` source the same way); and "Fork at a message" in "Lost or changed features" becomes **Lost**. Task 6 items 2 and 3 (ownership, holder marker) proceed unchanged.

- [ ] **Step 11: Hygiene and the go/no-go gate**

```bash
cat src/server/engine/claudeCli/fixtures/go-no-go.meta.json
npx vitest run src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=4
```

Expected: the verdict file has `E1`, `E3`, `D6`, `H1`, `F1` (plus `cli`); hygiene PASS. Gate: if `E3` or `D6` is `false`, stop here and report (both have no fallback that keeps today's behaviour). Any other `false` follows the fallback written in its step; note the choice in the task report.

- [ ] **Step 12: Commit**

```bash
git add src/server/engine/claudeCli/process.ts src/server/engine/claudeCli/process.test.ts src/server/engine/claudeCli/fakeClaudeCli.ts src/server/engine/claudeCli/fixtures/capture.ts src/server/engine/claudeCli/fixtures/abort.jsonl src/server/engine/claudeCli/fixtures/abort.meta.json src/server/engine/claudeCli/fixtures/steer.jsonl src/server/engine/claudeCli/fixtures/steer.meta.json src/server/engine/claudeCli/fixtures/go-no-go.meta.json src/server/engine/claudeCli/fixtures/background.jsonl src/server/engine/claudeCli/fixtures/background.meta.json src/server/engine/claudeCli/fixtures/ask.jsonl src/server/engine/claudeCli/fixtures/ask.meta.json
git commit -m "feat(claude-cli): claude 자식 프로세스 수명 관리(SIGINT 중단·종료 승격·stderr 꼬리)와 중단·끼어들기 실측 픽스처"
```

---

### Task 4: Permission bridge — MCP prompt tool, unix-socket IPC, AskUserQuestion

**Files:**
- Create: `src/server/engine/claudeCli/permissionTypes.ts`
- Create: `src/server/engine/claudeCli/bridge.ts`, `src/server/engine/claudeCli/bridge.test.ts`
- Create: `src/server/engine/claudeCli/permissionMcp.ts`, `src/server/engine/claudeCli/permissionMcp.test.ts`
- Create: `src/server/engine/claudeCli/permissions.ts`, `src/server/engine/claudeCli/permissions.test.ts`
- Create: `src/server/engine/claudeCli/texts.ts`
- Modify: `src/server/engine/Engine.ts` (line 1: `import type { PermissionUpdate } from './claudeCli/permissionTypes';`)
- Modify: `src/server/engine/claudeCli/fixtures/capture.ts` (bridge setup + scenarios), `src/server/engine/claudeCli/fakeClaudeCli.ts` (`ask` helper)
- Create: `fixtures/permission-allow.*`, `fixtures/permission-session.*`, `fixtures/plan-exit.*`, `fixtures/deny.*`, `fixtures/self-call.*`, `fixtures/permission-slow.*`, `fixtures/permission-slow-20s.*` (`.jsonl` + `.meta.json` each). `fixtures/ask.*` already exists (spike D6, Task 3 Step 8).

**Interfaces:**
- Consumes: `TurnRequest`, `PermissionRequest`, `sessionUpdates`, `ruleString`, `parseQuestions` (`../Engine`); `ToolAudit` (`stream.ts`); `PERMISSION_TOOL`, `BRIDGE_SERVER`, `CliPermissionMode`, `buildMcpConfig` (`args.ts`).
- Produces:
  ```ts
  // permissionTypes.ts
  export type PermissionRuleValue = { toolName: string; ruleContent?: string };
  export type PermissionDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
  export type PermissionUpdate =
    | { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: PermissionRuleValue[]; behavior: 'allow' | 'deny' | 'ask'; destination: PermissionDestination }
    | { type: 'setMode'; mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'; destination: PermissionDestination }
    | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: PermissionDestination };
  export function asPermissionUpdates(v: unknown): PermissionUpdate[] | undefined;

  // bridge.ts
  export type PermissionCall = { tool_name: string; input: Record<string, unknown>; tool_use_id: string; permission_suggestions?: PermissionUpdate[] };
  export type PermissionReply =
    | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
    | { behavior: 'deny'; message: string };
  export type BridgeHandlers = {
    permission(call: PermissionCall, signal: AbortSignal): Promise<PermissionReply>;
    hook(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
  };
  export type BridgeRegistration = { token: string; socketPath: string; abortAll(): void; dispose(): void };
  export const MCP_TOOL_TIMEOUT_MS = 12 * 60 * 60_000;
  export const PERMISSION_WAIT_MS = MCP_TOOL_TIMEOUT_MS - 2 * 60_000; // 2 min below the CLI's tool timeout
  export const HOOK_WAIT_MS = 25_000;
  export class PermissionBridge {
    static open(opts?: { waitMs?: number; hookWaitMs?: number }): Promise<PermissionBridge>;
    readonly socketPath: string;
    /** Live (not yet disposed) registrations; 0 after every register has been disposed. */
    get registrations(): number;
    register(h: BridgeHandlers): BridgeRegistration;
    close(): Promise<void>;
  }

  // permissionMcp.ts (node built-ins only)
  export const TOOL_NAME = 'permission';
  export const RELAY_FAILED_MESSAGE: string;
  export function postBridge(sock: string, token: string, urlPath: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: string }>;
  export type RpcDeps = { post(urlPath: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: string }>; inflight: Map<string | number, AbortController> };
  export function handleRpc(msg: Record<string, unknown>, deps: RpcDeps): Promise<Record<string, unknown> | null>;

  // permissions.ts
  export type ModeGate = { mode: CliPermissionMode; readonly startedIn: CliPermissionMode };
  export class SessionGrants { add(updates: PermissionUpdate[]): void; covers(suggestions: PermissionUpdate[] | undefined): boolean }
  export type PermissionDeps = Pick<TurnRequest, 'noTools' | 'onQuestion' | 'onQuestionMalformed' | 'autoApprove' | 'onAutoApproved' | 'onPermission'>;
  export function permissionHandler(req: PermissionDeps, audit: ToolAudit, gate: ModeGate, grants: SessionGrants): BridgeHandlers['permission'];

  // texts.ts
  export const NO_TOOLS_MESSAGE: string;      // moved verbatim
  export const KEEP_PLANNING_MESSAGE: string; // moved verbatim
  export const DENIED_MESSAGE = '사용자가 거부했습니다';
  export const QUESTION_MALFORMED_MESSAGE = '질문 형식이 올바르지 않습니다';
  export const QUESTION_UNANSWERED_MESSAGE = '사용자가 답하지 않았습니다';
  export const SELF_CALL_MESSAGE = 'deck 내부 도구는 직접 부를 수 없습니다';
  export const PERMISSION_TIMEOUT_MESSAGE = '권한 요청이 오래 응답되지 않아 거부했습니다';
  export const PERMISSION_ERROR_MESSAGE = '권한 요청을 처리하다 오류가 나서 거부했습니다';
  ```

- [ ] **Step 1: Write the failing bridge test**

```ts
// src/server/engine/claudeCli/bridge.test.ts
import fs from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { PermissionBridge, type BridgeHandlers } from './bridge';
import { postBridge } from './permissionMcp';

let bridge: PermissionBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

const allowAll: BridgeHandlers = {
  permission: async (c) => ({ behavior: 'allow', updatedInput: c.input }),
  hook: async () => ({}),
};
const call = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' };

describe('PermissionBridge', () => {
  it('socket dir is private and the socket answers registered tokens only', async () => {
    bridge = await PermissionBridge.open();
    const dirMode = fs.statSync(bridge.socketPath.replace(/\/[^/]+$/, '')).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const reg = bridge.register(allowAll);
    const ok = await postBridge(reg.socketPath, reg.token, '/v1/permission', call);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect((await postBridge(reg.socketPath, 'wrong', '/v1/permission', call)).status).toBe(401);
    expect((await postBridge(reg.socketPath, reg.token, '/v1/nope', call)).status).toBe(404);
  });

  it('400 on a malformed body, 410 after dispose', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register(allowAll);
    expect((await postBridge(reg.socketPath, reg.token, '/v1/permission', { tool_name: 1 })).status).toBe(400);
    reg.dispose();
    expect((await postBridge(reg.socketPath, reg.token, '/v1/permission', call)).status).toBe(410);
  });

  it('routes hooks to the hook handler', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ ...allowAll, hook: async (i) => ({ echoed: i.hook_event_name }) });
    const r = await postBridge(reg.socketPath, reg.token, '/v1/hook', { hook_event_name: 'PreToolUse' });
    expect(JSON.parse(r.body)).toEqual({ echoed: 'PreToolUse' });
  });

  it('client disconnect aborts the handler signal (MCP notifications/cancelled path)', async () => {
    bridge = await PermissionBridge.open();
    let aborted = false;
    const reg = bridge.register({ ...allowAll, permission: (_c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve({ behavior: 'deny', message: 'x' }); })) });
    const ac = new AbortController();
    const p = postBridge(reg.socketPath, reg.token, '/v1/permission', call, ac.signal).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await p;
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
  });

  it('abortAll aborts in-flight requests and answers them with a deny', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ ...allowAll, permission: (_c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'aborted' }))) });
    const p = postBridge(reg.socketPath, reg.token, '/v1/permission', call);
    await new Promise((r) => setTimeout(r, 50));
    reg.abortAll();
    expect(JSON.parse((await p).body)).toMatchObject({ behavior: 'deny' });
  });

  it('the wait cap answers deny in Korean', async () => {
    bridge = await PermissionBridge.open({ waitMs: 50 });
    const reg = bridge.register({ ...allowAll, permission: () => new Promise(() => {}) });
    const r = JSON.parse((await postBridge(reg.socketPath, reg.token, '/v1/permission', call)).body);
    expect(r).toEqual({ behavior: 'deny', message: '권한 요청이 오래 응답되지 않아 거부했습니다' });
  });

  it('a throwing handler answers deny, never 500 with a stack', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ ...allowAll, permission: async () => { throw new Error('boom'); } });
    const r = await postBridge(reg.socketPath, reg.token, '/v1/permission', call);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ behavior: 'deny', message: '권한 요청을 처리하다 오류가 나서 거부했습니다' });
  });

  it('register N then dispose N leaks nothing: zero registrations, in-flight requests aborted, socket stays until close', async () => {
    bridge = await PermissionBridge.open();
    const N = 20;
    let aborted = 0;
    const regs = Array.from({ length: N }, () => bridge!.register({ ...allowAll, permission: (_c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted++; resolve({ behavior: 'deny', message: 'aborted' }); }, { once: true })) }));
    expect(bridge.registrations).toBe(N);
    const pending = regs.map((r) => postBridge(r.socketPath, r.token, '/v1/permission', call));
    await new Promise((r) => setTimeout(r, 50));
    for (const r of regs) r.dispose();
    for (const r of regs) r.dispose(); // idempotent
    await Promise.all(pending);
    expect(bridge.registrations).toBe(0);
    expect(aborted).toBe(N);
    for (const r of regs) expect((await postBridge(r.socketPath, r.token, '/v1/permission', call)).status).toBe(410);
    expect(fs.existsSync(bridge.socketPath)).toBe(true); // one shared socket per deck server
    const sock = bridge.socketPath;
    await bridge.close();
    bridge = null;
    expect(fs.existsSync(sock)).toBe(false);
  });

  it('close removes the socket dir', async () => {
    const b = await PermissionBridge.open();
    const dir = b.socketPath.replace(/\/[^/]+$/, '');
    await b.close();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/server/engine/claudeCli/bridge.test.ts --maxWorkers=4`
Expected: FAIL — `Failed to resolve import "./bridge"`.

- [ ] **Step 3: Implement `permissionTypes.ts`, `texts.ts`, `bridge.ts`, and the `postBridge` half of `permissionMcp.ts`**

```ts
// src/server/engine/claudeCli/permissionTypes.ts
// Local copy of the permission-update shape the CLI's prompt-tool contract uses (formerly imported from the SDK).
export type PermissionRuleValue = { toolName: string; ruleContent?: string };
export type PermissionDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
export type PermissionUpdate =
  | { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: PermissionRuleValue[]; behavior: 'allow' | 'deny' | 'ask'; destination: PermissionDestination }
  | { type: 'setMode'; mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'; destination: PermissionDestination }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: PermissionDestination };

/** `permission_suggestions` as the CLI sent them, keeping only well-formed entries; undefined when none. */
export function asPermissionUpdates(v: unknown): PermissionUpdate[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((u): u is PermissionUpdate => {
    if (!u || typeof u !== 'object') return false;
    const r = u as Record<string, unknown>;
    if (r.type === 'addRules' || r.type === 'replaceRules' || r.type === 'removeRules') return Array.isArray(r.rules) && (r.rules as unknown[]).every((x) => !!x && typeof (x as Record<string, unknown>).toolName === 'string');
    if (r.type === 'addDirectories' || r.type === 'removeDirectories') return Array.isArray(r.directories) && (r.directories as unknown[]).every((d) => typeof d === 'string');
    return r.type === 'setMode' && typeof r.mode === 'string';
  });
  return out.length ? out : undefined;
}
```

```ts
// src/server/engine/claudeCli/texts.ts
/** The handoff-note turn (TurnRequest.noTools): what a denied tool call tells the model. */
export const NO_TOOLS_MESSAGE = '인계 메모 작성 중에는 도구를 쓸 수 없습니다 — 지금까지의 대화만으로 메모를 써 주세요';
/** 계속 계획 on the plan card: what the denied ExitPlanMode call tells the model. */
export const KEEP_PLANNING_MESSAGE = '사용자가 계획을 승인하지 않았습니다 — 계획 모드를 유지하며 계획을 더 다듬어 주세요';
export const DENIED_MESSAGE = '사용자가 거부했습니다';
export const QUESTION_MALFORMED_MESSAGE = '질문 형식이 올바르지 않습니다';
export const QUESTION_UNANSWERED_MESSAGE = '사용자가 답하지 않았습니다';
export const SELF_CALL_MESSAGE = 'deck 내부 도구는 직접 부를 수 없습니다';
export const PERMISSION_TIMEOUT_MESSAGE = '권한 요청이 오래 응답되지 않아 거부했습니다';
export const PERMISSION_ERROR_MESSAGE = '권한 요청을 처리하다 오류가 나서 거부했습니다';
```

In `ClaudeEngine.ts` replace the two `export const` declarations with `export { NO_TOOLS_MESSAGE, KEEP_PLANNING_MESSAGE } from './claudeCli/texts';` (and import them for the remaining internal uses).

```ts
// src/server/engine/claudeCli/bridge.ts
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { asPermissionUpdates, type PermissionUpdate } from './permissionTypes';
import { PERMISSION_ERROR_MESSAGE, PERMISSION_TIMEOUT_MESSAGE } from './texts';

export type PermissionCall = { tool_name: string; input: Record<string, unknown>; tool_use_id: string; permission_suggestions?: PermissionUpdate[] };
export type PermissionReply =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string };
export type BridgeHandlers = {
  permission(call: PermissionCall, signal: AbortSignal): Promise<PermissionReply>;
  hook(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
};
export type BridgeRegistration = { token: string; socketPath: string; abortAll(): void; dispose(): void };

/** Passed to the claude child as `MCP_TOOL_TIMEOUT` (the CLI's limit for one MCP tool call, the prompt tool included — spike `permission-slow`). */
export const MCP_TOOL_TIMEOUT_MS = 12 * 60 * 60_000;
/**
 * A permission card may wait for the user this long. Kept 2 minutes below MCP_TOOL_TIMEOUT_MS so
 * deck's own Korean deny always reaches the CLI before the CLI gives up on the tool call itself
 * (a CLI-side timeout would surface as an MCP error, not as deck's message). If spike
 * `permission-slow` shows the CLI ignores MCP_TOOL_TIMEOUT for the prompt tool, set this to the
 * CLI's internal limit minus 2 minutes (see "Lost or changed features").
 */
export const PERMISSION_WAIT_MS = MCP_TOOL_TIMEOUT_MS - 2 * 60_000;
/** Below the 30 s command-hook timeout written into the settings file. */
export const HOOK_WAIT_MS = 25_000;
const MAX_BODY = 1024 * 1024;

type Reg = { handlers: BridgeHandlers; inflight: Set<AbortController> };

function parseCall(v: unknown): PermissionCall | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.tool_name !== 'string' || !r.input || typeof r.input !== 'object' || Array.isArray(r.input)) return null;
  const suggestions = asPermissionUpdates(r.permission_suggestions);
  return { tool_name: r.tool_name, input: r.input as Record<string, unknown>, tool_use_id: typeof r.tool_use_id === 'string' ? r.tool_use_id : '', ...(suggestions ? { permission_suggestions: suggestions } : {}) };
}

/**
 * One per deck server: an HTTP server on a unix socket inside a private temp dir (0700). Each
 * claude process gets its own registration token, handed only to its MCP prompt server and hook
 * relay through 0600 config files, always as the env variable `DECK_BRIDGE_TOKEN` (the MCP server's
 * `env` entry; a `DECK_BRIDGE_TOKEN=` prefix in the hook command) — never in the claude process env
 * and never as an argv flag of node or claude.
 */
export class PermissionBridge {
  private readonly regs = new Map<string, Reg>();
  private constructor(private readonly server: http.Server, readonly socketPath: string, private readonly dir: string, private readonly waitMs: number, private readonly hookWaitMs: number) {}

  static async open(opts: { waitMs?: number; hookWaitMs?: number } = {}): Promise<PermissionBridge> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-'));
    await fs.chmod(dir, 0o700);
    const socketPath = path.join(dir, 'b.sock');
    let self: PermissionBridge | null = null;
    const server = http.createServer((req, res) => { void self!.handle(req, res); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()); });
    await fs.chmod(socketPath, 0o600);
    server.unref();
    self = new PermissionBridge(server, socketPath, dir, opts.waitMs ?? PERMISSION_WAIT_MS, opts.hookWaitMs ?? HOOK_WAIT_MS);
    return self;
  }

  get registrations(): number { return this.regs.size; }

  register(handlers: BridgeHandlers): BridgeRegistration {
    const token = randomBytes(24).toString('hex');
    const reg: Reg = { handlers, inflight: new Set() };
    this.regs.set(token, reg);
    const abortAll = () => { for (const ac of reg.inflight) ac.abort(); };
    const dispose = () => {
      abortAll();
      if (!this.regs.delete(token)) return;
      this.disposedTokens.add(token);
      if (this.disposedTokens.size > 1000) this.disposedTokens.delete(this.disposedTokens.values().next().value!);
    };
    return { token, socketPath: this.socketPath, abortAll, dispose };
  }

  async close(): Promise<void> {
    for (const reg of this.regs.values()) for (const ac of reg.inflight) ac.abort();
    this.regs.clear();
    await new Promise<void>((r) => this.server.close(() => r()));
    await fs.rm(this.dir, { recursive: true, force: true });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const kind = req.method === 'POST' && req.url === '/v1/permission' ? 'permission' : req.method === 'POST' && req.url === '/v1/hook' ? 'hook' : null;
    if (!kind) return send(404, { error: 'not found' });
    const token = req.headers['x-deck-token'];
    if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return send(401, { error: 'unauthorized' });
    let raw = '';
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) return send(413, { error: 'too large' }); }
    } catch { return; }
    const reg = this.regs.get(token);
    if (!reg) return send(this.knownShape(token) ? 410 : 401, { error: 'gone' });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return send(400, { error: 'bad json' }); }
    const ac = new AbortController();
    reg.inflight.add(ac);
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const cap = setTimeout(() => {
      ac.abort();
      send(200, kind === 'permission' ? { behavior: 'deny', message: PERMISSION_TIMEOUT_MESSAGE } : {});
    }, kind === 'permission' ? this.waitMs : this.hookWaitMs);
    cap.unref();
    try {
      if (kind === 'permission') {
        const call = parseCall(body);
        if (!call) return send(400, { error: 'bad call' });
        send(200, await reg.handlers.permission(call, ac.signal));
      } else {
        if (!body || typeof body !== 'object') return send(400, { error: 'bad hook input' });
        send(200, await reg.handlers.hook(body as Record<string, unknown>, ac.signal));
      }
    } catch {
      send(200, kind === 'permission' ? { behavior: 'deny', message: PERMISSION_ERROR_MESSAGE } : {});
    } finally {
      clearTimeout(cap);
      reg.inflight.delete(ac);
    }
  }

  /** Disposed registrations answer 410 (a process outliving its turn), unknown tokens 401. */
  private readonly disposedTokens = new Set<string>();
  private knownShape(token: string): boolean { return this.disposedTokens.has(token); }
}
```

The first half of `permissionMcp.ts` (the rest follows in Step 7):

```ts
// src/server/engine/claudeCli/permissionMcp.ts
// Child entry: deck's permission-prompt MCP server, started by claude via --mcp-config.
// Runs as `node --disable-warning=ExperimentalWarning permissionMcp.ts` (native type stripping):
// node: built-ins only, erasable TypeScript only (no enums, namespaces or parameter properties).
import http from 'node:http';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const TOOL_NAME = 'permission';
export const RELAY_FAILED_MESSAGE = '권한 요청을 deck 에 전달하지 못해 거부했습니다';

export function postBridge(sock: string, token: string, urlPath: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath: sock, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-deck-token': token }, signal }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}
```

- [ ] **Step 4: Run the bridge test and see it pass**

Run: `npx vitest run src/server/engine/claudeCli/bridge.test.ts --maxWorkers=4`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing MCP server test**

```ts
// src/server/engine/claudeCli/permissionMcp.test.ts
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { PermissionBridge } from './bridge';
import { handleRpc, RELAY_FAILED_MESSAGE } from './permissionMcp';

const SCRIPT = path.join(__dirname, 'permissionMcp.ts');
let bridge: PermissionBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

describe('handleRpc', () => {
  const deps = (status = 200, body = '{"behavior":"allow","updatedInput":{}}') => ({ post: async () => ({ status, body }), inflight: new Map<string | number, AbortController>() });
  it('initialize / tools/list / ping / unknown', async () => {
    expect(await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, deps())).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'deck_bridge' } } });
    const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['permission']);
    expect(await handleRpc({ jsonrpc: '2.0', id: 3, method: 'ping' }, deps())).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps())).toBeNull();
    expect(await handleRpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, deps())).toMatchObject({ id: 4, error: { code: -32601 } });
  });
  it('tools/call returns the bridge reply as one text block; a failed relay denies', async () => {
    const ok = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'permission', arguments: { tool_name: 'Bash', input: {} } } }, deps()) as { result: { content: { type: string; text: string }[] } };
    expect(ok.result.content).toEqual([{ type: 'text', text: '{"behavior":"allow","updatedInput":{}}' }]);
    const bad = await handleRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'permission', arguments: {} } }, deps(401, '')) as { result: { content: { text: string }[] } };
    expect(JSON.parse(bad.result.content[0]!.text)).toEqual({ behavior: 'deny', message: RELAY_FAILED_MESSAGE });
    const thrown = await handleRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'permission', arguments: {} } }, { post: async () => { throw new Error('ECONNREFUSED'); }, inflight: new Map() }) as { result: { content: { text: string }[] } };
    expect(JSON.parse(thrown.result.content[0]!.text).behavior).toBe('deny');
  });
  it('notifications/cancelled aborts the matching in-flight call', async () => {
    const inflight = new Map<string | number, AbortController>();
    let seen: AbortSignal | null = null;
    const p = handleRpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'permission', arguments: {} } }, { inflight, post: (_p, _b, signal) => { seen = signal; return new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))); } });
    await handleRpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }, { inflight, post: async () => ({ status: 200, body: '' }) });
    await p;
    expect(seen!.aborted).toBe(true);
    expect(inflight.size).toBe(0);
  });
});

describe('permissionMcp.ts as a child process (plain node, no tsx)', () => {
  it('speaks newline-delimited JSON-RPC and relays tools/call to the bridge', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ permission: async (c) => ({ behavior: 'allow', updatedInput: { ...c.input, seen: c.tool_use_id } }), hook: async () => ({}) });
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT], { env: { PATH: process.env.PATH ?? '', DECK_BRIDGE_SOCK: reg.socketPath, DECK_BRIDGE_TOKEN: reg.token }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const rpc = async (m: object) => { child.stdin.write(JSON.stringify(m) + '\n'); return JSON.parse((await lines.next()).value as string); };
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result.serverInfo.name).toBe('deck_bridge');
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'permission', arguments: { tool_name: 'Write', input: { file_path: '/w/a' }, tool_use_id: 'toolu_1' } } });
    expect(JSON.parse(r.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { file_path: '/w/a', seen: 'toolu_1' } });
    const exited = new Promise((res) => child.once('exit', res));
    child.stdin.end();
    await exited;
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `npx vitest run src/server/engine/claudeCli/permissionMcp.test.ts --maxWorkers=4`
Expected: FAIL — `handleRpc` is not exported.

- [ ] **Step 7: Complete `permissionMcp.ts`** (append below `postBridge`)

```ts
type Json = Record<string, unknown>;
export type RpcDeps = { post(urlPath: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: string }>; inflight: Map<string | number, AbortController> };

const TOOL = {
  name: TOOL_NAME,
  description: 'deck internal: relays Claude Code permission prompts to the deck UI. Never call this tool yourself.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
    additionalProperties: true,
  },
};

const reply = (id: unknown, result: unknown): Json => ({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string): Json => ({ jsonrpc: '2.0', id, error: { code, message } });
const denyText = (message: string) => JSON.stringify({ behavior: 'deny', message });

export async function handleRpc(msg: Json, deps: RpcDeps): Promise<Json | null> {
  const id = msg.id;
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json;
  switch (msg.method) {
    case 'initialize':
      return reply(id, { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'deck_bridge', version: '1' } });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: [TOOL] });
    case 'notifications/cancelled': {
      const target = params.requestId as string | number | undefined;
      if (target !== undefined) deps.inflight.get(target)?.abort();
      return null;
    }
    case 'tools/call': {
      if (params.name !== TOOL_NAME) return fail(id, -32602, `unknown tool ${String(params.name)}`);
      const ac = new AbortController();
      const key = id as string | number;
      deps.inflight.set(key, ac);
      let text: string;
      try {
        const r = await deps.post('/v1/permission', params.arguments ?? {}, ac.signal);
        text = r.status === 200 && r.body ? r.body : denyText(RELAY_FAILED_MESSAGE);
      } catch {
        text = denyText(RELAY_FAILED_MESSAGE);
      } finally {
        deps.inflight.delete(key);
      }
      return reply(id, { content: [{ type: 'text', text }] });
    }
    default:
      return id === undefined ? null : fail(id, -32601, `method not found: ${String(msg.method)}`);
  }
}

function main(): void {
  const sock = process.env.DECK_BRIDGE_SOCK ?? '';
  const token = process.env.DECK_BRIDGE_TOKEN ?? '';
  const deps: RpcDeps = { post: (p, b, s) => postBridge(sock, token, p, b, s), inflight: new Map() };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg: Json;
    try { msg = JSON.parse(line) as Json; } catch { return; }
    void handleRpc(msg, deps).then((out) => { if (out) process.stdout.write(JSON.stringify(out) + '\n'); });
  });
  rl.on('close', () => { for (const ac of deps.inflight.values()) ac.abort(); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 8: Run the MCP test and see it pass**

Run: `npx vitest run src/server/engine/claudeCli/permissionMcp.test.ts --maxWorkers=4`
Expected: PASS (4 tests). If the child case fails with a type-stripping error, the file used non-erasable syntax — fix the syntax, do not add tsx to the child command.

- [ ] **Step 9: Extend the capture runner with a real bridge and add the permission scenarios**

Add to `fixtures/capture.ts`:

```ts
import { PermissionBridge, type BridgeHandlers, type PermissionCall } from '../bridge';
import { buildMcpConfig } from '../args';

export type BridgeScenario = Scenario & { handlers(ctx: { calls: PermissionCall[]; meta: Rec; dir: string }): Partial<BridgeHandlers> };

const MCP_SCRIPT = path.join(import.meta.dirname, '..', 'permissionMcp.ts');
const allow = async (c: PermissionCall) => ({ behavior: 'allow' as const, updatedInput: c.input });

export async function captureWithBridge(name: string, sc: BridgeScenario): Promise<void> {
  const calls: PermissionCall[] = [];
  const meta: Rec = {};
  const bridge = await PermissionBridge.open();
  await capture(name, { ...sc, bridge: true, after: async (ctx) => { Object.assign(ctx.meta, meta, { calls: calls.map((c) => ({ tool_name: c.tool_name, inputKeys: Object.keys(c.input), tool_use_id: c.tool_use_id, permission_suggestions: c.permission_suggestions ?? null })) }); await sc.after?.(ctx); } }, {
    bridgeSetup: async (dir) => {
      const h = sc.handlers({ calls, meta, dir });
      const reg = bridge.register({
        permission: async (c, s) => { calls.push(c); return (h.permission ?? allow)(c, s); },
        hook: h.hook ?? (async () => ({})),
      });
      const mcpConfigPath = path.join(dir, 'mcp.json');
      fs.writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig({ node: process.execPath, script: MCP_SCRIPT, socketPath: reg.socketPath, token: reg.token })), { mode: 0o600 });
      return { mcpConfigPath, settings: {}, dispose: async () => { reg.dispose(); await bridge.close(); } };
    },
  });
}

export const bridgeScenarios: Record<string, BridgeScenario> = {
  'permission-allow': {
    maxTurns: 3,
    first: 'Create a file named hello.txt containing the word hi, using the Write tool. Then reply DONE.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({}),
    after: (ctx) => { ctx.meta.fileWritten = fs.existsSync(path.join(ctx.dir, 'work', 'hello.txt')); },
  },
  'permission-session': {
    maxTurns: 4,
    first: 'Run the shell command `echo one` with the Bash tool, then, as a separate Bash call, run `echo two`. Then reply DONE.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({
      permission: async (c) => ({ behavior: 'allow', updatedInput: c.input, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] }),
    }),
  },
  'plan-exit': {
    maxTurns: 6,
    extraArgs: () => [],
    first: 'Make a one-line plan to create notes.txt containing x, present it with ExitPlanMode, and once approved create the file with the Write tool. Then reply DONE.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({
      permission: async (c) => c.tool_name === 'ExitPlanMode'
        ? { behavior: 'allow', updatedInput: c.input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }
        : { behavior: 'allow', updatedInput: c.input },
    }),
    after: (ctx) => { ctx.meta.fileWritten = fs.existsSync(path.join(ctx.dir, 'work', 'notes.txt')); },
  },
  // `ask` (spike D6) moved to Task 3 Step 8; its fixture is already committed.
  deny: {
    maxTurns: 3,
    settings: { permissions: { deny: ['Bash(rm:*)'] } },
    first: 'First run `rm -f nothing.txt` with the Bash tool. Then create a file named x.txt containing x with the Write tool. Report each tool result verbatim.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({ permission: async () => ({ behavior: 'deny', message: 'NOPE-MARKER' }) }),
  },
  'self-call': {
    maxTurns: 2,
    first: 'Call the tool named mcp__deck_bridge__permission with tool_name "Bash" and input {}. Report what happened.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({}),
  },
  'permission-slow': slowPermission(3_000),
  'permission-slow-20s': slowPermission(20_000),
};

/**
 * Does MCP_TOOL_TIMEOUT bound the permission prompt tool? The allow is answered 6 s late; with a
 * 3 s timeout the CLI should give up on the call (tool not run), with 20 s it should honour it.
 */
function slowPermission(toolTimeoutMs: number): BridgeScenario {
  return {
    maxTurns: 3,
    toolTimeoutMs,
    timeoutMs: 120_000,
    first: 'Create a file named slow.txt containing the word hi, using the Write tool. Then report the tool result verbatim and reply DONE.',
    drive: (ctx, m) => {
      if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const b of m.message.content) if (b.type === 'tool_result') {
          ((ctx.meta.toolResults ??= []) as unknown[]).push({ is_error: b.is_error === true, text: (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 300) });
        }
      }
      if (m.type === 'result') ctx.proc.stop();
    },
    handlers: ({ meta }) => ({
      permission: (c, signal) => new Promise((resolve) => {
        const t0 = Date.now();
        const t = setTimeout(() => { meta.answeredAfterMs = Date.now() - t0; resolve({ behavior: 'allow', updatedInput: c.input }); }, 6_000);
        signal.addEventListener('abort', () => { clearTimeout(t); meta.cancelledAfterMs = Date.now() - t0; resolve({ behavior: 'deny', message: 'cancelled' }); }, { once: true });
      }),
    }),
    after: (ctx) => { ctx.meta.toolTimeoutMs = toolTimeoutMs; ctx.meta.fileWritten = fs.existsSync(path.join(ctx.dir, 'work', 'slow.txt')); },
  };
}
```

and route bridge scenarios in the CLI entry: `const bsc = bridgeScenarios[name]; if (bsc) await captureWithBridge(name, bsc); else …`. For `plan-exit`, `capture()` must start in plan mode: add `permissionMode?: CliPermissionMode` to `Scenario`, pass it to `claudeArgs`, and set `permissionMode: 'plan'` on that scenario (replacing the empty `extraArgs`). For `permission-slow`, add `toolTimeoutMs?: number` to `Scenario` and change the `ClaudeProcess` construction in `capture()` to `env: claudeEnv(process.env, sc.toolTimeoutMs ?? 600_000)`, so the scenario's value becomes the child's `MCP_TOOL_TIMEOUT`.

- [ ] **Step 10 (spike): Capture the permission scenarios**

Run (repo root), one at a time, then the hygiene test:
```bash
for s in permission-allow permission-session plan-exit deny self-call permission-slow permission-slow-20s; do npx tsx src/server/engine/claudeCli/fixtures/capture.ts "$s"; done
npx vitest run src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=4
```

(`ask` is no longer in this loop: it was captured as spike D6 in Task 3 Step 8, which already wrote `fixtures/ask.jsonl` + `ask.meta.json`.)
What each validates (record the answer in that scenario's `.meta.json`; the tests in Step 11 assert the recorded value):

| Scenario | Assumption |
|---|---|
| `permission-allow` | D1: the prompt tool receives `{tool_name, input, tool_use_id}` and `tool_use_id` equals the assistant `tool_use` block id; D3: `{"behavior":"allow","updatedInput":…}` runs the tool (`fileWritten: true`). Also records whether `permission_suggestions` is present for Write. |
| `permission-session` | D2: `updatedPermissions` returned by the prompt tool are applied for the rest of the process (meta `calls.length === 1`). Also records Bash `permission_suggestions` shape. |
| `plan-exit` | D4: ExitPlanMode reaches the prompt tool in plan mode; D5: a returned `setMode acceptEdits` leaves plan mode and the following Write is not asked (`calls` = only ExitPlanMode) — or is asked (`calls` includes Write), meaning the mode switch must be enforced by deck (Task 5 gate already does). |
| `ask` | Moved: D6 is answered early by Task 3 Step 8 (go/no-go spike); not re-captured here. |
| `deny` | D7: a deny-rule refusal is reported as a `system/permission_denied` frame (record its fields, and whether it arrives before the matching `tool_result`) and/or in `result.permission_denials`; D8: a prompt-tool deny message comes back to the model as an error `tool_result` containing NOPE-MARKER. |
| `self-call` | D9: whether `mcp__deck_bridge__permission` appears in init `tools` (model-visible) and whether a direct call reaches the prompt tool as `tool_name: "mcp__deck_bridge__permission"` (then denied by `SELF_CALL_MESSAGE`, Step 13). If it is visible, re-run `permission-allow` once with `extraArgs: () => ['--disallowedTools', 'mcp__deck_bridge__permission']` (scenario `permission-allow-disallowed`) and record whether the prompt tool still works; Task 8a adds the flag only if it does. |
| `permission-slow` / `permission-slow-20s` | D10: `MCP_TOOL_TIMEOUT` applies to the permission prompt tool. Positive: with 3000 ms the 6 s-late allow is not honoured — `fileWritten: false`, `toolResults[0].is_error: true` (a timeout/denied text), and usually `cancelledAfterMs` ≈ 3000 (the CLI cancelled the MCP call); with 20000 ms the late allow is honoured — `fileWritten: true`, `answeredAfterMs` ≈ 6000. Negative: the 3000 ms run also writes the file (the variable does not bound the prompt tool), or the 20000 ms run times out (some lower internal limit wins). |

If D2 fails, deck's `SessionGrants` (Step 13) is what keeps 이 세션 working within the process; later turns already pass the rules through `--settings`. If D10 is negative, follow "Lost or changed features" (row "Long-waiting permission cards"): find the CLI's own limit by re-running `permission-slow-20s` with the handler delay raised (60 s, 300 s, 600 s) until the allow is no longer honoured, then set `PERMISSION_WAIT_MS` in `bridge.ts` to that limit minus 2 minutes and change the D10 assertions in Step 11 to the recorded values.

- [ ] **Step 11: Write the failing permission-handler test** (moved `canUseTool` tests + fixture assertions)

```ts
// src/server/engine/claudeCli/permissions.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { permissionHandler, SessionGrants, type ModeGate } from './permissions';
import { toolAudit } from './stream';
import { KEEP_PLANNING_MESSAGE, NO_TOOLS_MESSAGE, SELF_CALL_MESSAGE } from './texts';
import type { PermissionUpdate } from './permissionTypes';

const sig = new AbortController().signal;
const gate = (mode: ModeGate['mode'] = 'default'): ModeGate => ({ mode, startedIn: mode });
const mk = (req: Parameters<typeof permissionHandler>[0], g = gate(), grants = new SessionGrants()) => {
  const audited: unknown[] = [];
  const audit = toolAudit({ onToolAudit: async (e) => { audited.push(e); } });
  return { h: permissionHandler(req, audit, g, grants), audit, audited, g, grants };
};
const bashSuggestion: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];

describe('permissionHandler', () => {
  it('allow returns updatedInput = input; the call is marked handled (no duplicate audit)', async () => {
    const { h, audit } = mk({ onPermission: async () => 'once' });
    expect(await h({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(audit.handled.has('t1')).toBe(true);
  });
  it('deny → Korean message', async () => {
    const { h } = mk({ onPermission: async () => 'deny' });
    expect(await h({ tool_name: 'Bash', input: {}, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'deny', message: '사용자가 거부했습니다' });
  });
  it('passes suggestions and the abort signal to onPermission', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    await h({ tool_name: 'Bash', input: {}, tool_use_id: 't1', permission_suggestions: bashSuggestion }, sig);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'Bash', toolUseId: 't1', suggestions: bashSuggestion, signal: sig, suppressAlwaysAllowRule: false }));
  });
  it('session → updatedPermissions rewritten to destination session, and remembered for this process', async () => {
    const onPermission = vi.fn(async () => 'session' as const);
    const { h } = mk({ onPermission });
    const r = await h({ tool_name: 'Bash', input: {}, tool_use_id: 't1', permission_suggestions: bashSuggestion }, sig);
    expect(r).toEqual({ behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }] });
    const again = await h({ tool_name: 'Bash', input: {}, tool_use_id: 't2', permission_suggestions: bashSuggestion }, sig);
    expect(again).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(onPermission).toHaveBeenCalledTimes(1);
  });
  it('a call covered by a session grant is left to the stream audit (source cli)', async () => {
    const { h, audit } = mk({ onPermission: async () => 'session' });
    await h({ tool_name: 'Bash', input: {}, tool_use_id: 't1', permission_suggestions: bashSuggestion }, sig);
    await h({ tool_name: 'Bash', input: {}, tool_use_id: 't2', permission_suggestions: bashSuggestion }, sig);
    expect(audit.handled.has('t2')).toBe(false);
  });
  it('autoApprove allows at once and reports it', async () => {
    const onAutoApproved = vi.fn(async () => {});
    const onPermission = vi.fn(async () => 'deny' as const);
    const { h } = mk({ onPermission, autoApprove: () => true, onAutoApproved });
    expect(await h({ tool_name: 'Write', input: { a: 1 }, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'allow', updatedInput: { a: 1 } });
    expect(onAutoApproved).toHaveBeenCalledOnce();
    expect(onPermission).not.toHaveBeenCalled();
  });
  it('noTools denies everything with the handoff text', async () => {
    const { h } = mk({ onPermission: async () => 'once', noTools: true });
    expect(await h({ tool_name: 'Read', input: {}, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'deny', message: NO_TOOLS_MESSAGE });
  });
  it('denies direct calls of deck’s own MCP tool', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    expect(await h({ tool_name: 'mcp__deck_bridge__permission', input: {}, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'deny', message: SELF_CALL_MESSAGE });
    expect(onPermission).not.toHaveBeenCalled();
  });
  it('ExitPlanMode: deny keeps planning; once → default; session → acceptEdits, and the gate follows', async () => {
    const g = gate('plan');
    const deny = mk({ onPermission: async () => 'deny' }, g);
    expect(await deny.h({ tool_name: 'ExitPlanMode', input: { plan: 'p' }, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'deny', message: KEEP_PLANNING_MESSAGE });
    expect(g.mode).toBe('plan');
    const once = mk({ onPermission: async () => 'once' }, g);
    expect(await once.h({ tool_name: 'ExitPlanMode', input: { plan: 'p' }, tool_use_id: 't2' }, sig)).toEqual({ behavior: 'allow', updatedInput: { plan: 'p' }, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] });
    expect(g.mode).toBe('default');
    const g2 = gate('plan');
    const session = mk({ onPermission: async () => 'session' }, g2);
    await session.h({ tool_name: 'ExitPlanMode', input: {}, tool_use_id: 't3' }, sig);
    expect(g2.mode).toBe('acceptEdits');
  });
  it('AskUserQuestion: answers ride updatedInput; malformed or unanswered deny', async () => {
    const input = { questions: [{ question: 'Which color?', header: 'c', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] };
    const ok = mk({ onPermission: async () => 'deny', onQuestion: async () => ({ 'Which color?': 'Blue' }) });
    expect(await ok.h({ tool_name: 'AskUserQuestion', input, tool_use_id: 'q1' }, sig)).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which color?': 'Blue' } } });
    const none = mk({ onPermission: async () => 'deny', onQuestion: async () => null });
    expect(await none.h({ tool_name: 'AskUserQuestion', input, tool_use_id: 'q2' }, sig)).toEqual({ behavior: 'deny', message: '사용자가 답하지 않았습니다' });
    const onQuestionMalformed = vi.fn(async () => {});
    const bad = mk({ onPermission: async () => 'deny', onQuestionMalformed });
    expect(await bad.h({ tool_name: 'AskUserQuestion', input: { questions: [] }, tool_use_id: 'q3' }, sig)).toEqual({ behavior: 'deny', message: '질문 형식이 올바르지 않습니다' });
    expect(onQuestionMalformed).toHaveBeenCalledOnce();
  });
});

describe('permission fixtures (real CLI captures)', () => {
  const meta = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.meta.json`), 'utf8')) as Record<string, any>;
  it('D1/D3: call shape and allow-runs-the-tool', () => {
    const m = meta('permission-allow');
    expect(m.calls[0]).toMatchObject({ tool_name: 'Write' });
    expect(m.calls[0].tool_use_id).toMatch(/^toolu_/);
    expect(m.fileWritten).toBe(true);
  });
  it('D6: AskUserQuestion answers reach the model', () => {
    const frames = fs.readFileSync(path.join(__dirname, 'fixtures', 'ask.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(frames.find((f) => f.type === 'result').result).toContain('Blue');
  });
  it('D2 / D5 / D9 are recorded (values drive Task 5 and Task 8a decisions)', () => {
    expect(typeof meta('permission-session').calls.length).toBe('number');
    expect(Array.isArray(meta('plan-exit').calls)).toBe(true);
    expect(Array.isArray(meta('self-call').calls)).toBe(true);
  });
});
```

- [ ] **Step 12: Run it and see it fail**

Run: `npx vitest run src/server/engine/claudeCli/permissions.test.ts --maxWorkers=4`
Expected: FAIL — `Failed to resolve import "./permissions"`.

- [ ] **Step 13: Implement `permissions.ts`**

```ts
// src/server/engine/claudeCli/permissions.ts
import { parseQuestions, ruleString, sessionUpdates, type PermissionRequest, type TurnRequest } from '../Engine';
import { BRIDGE_SERVER, type CliPermissionMode } from './args';
import type { BridgeHandlers, PermissionReply } from './bridge';
import type { PermissionUpdate } from './permissionTypes';
import type { ToolAudit } from './stream';
import { DENIED_MESSAGE, KEEP_PLANNING_MESSAGE, NO_TOOLS_MESSAGE, QUESTION_MALFORMED_MESSAGE, QUESTION_UNANSWERED_MESSAGE, SELF_CALL_MESSAGE } from './texts';

/** The process's effective permission mode as deck sees it (changed by the plan card and by live.setPermissionMode). */
export type ModeGate = { mode: CliPermissionMode; readonly startedIn: CliPermissionMode };

/**
 * 이 세션 grants given during this process. The CLI should apply `updatedPermissions` itself
 * (spike D2); this memory makes a repeat ask auto-allow even if it does not.
 */
export class SessionGrants {
  private readonly rules = new Set<string>();
  private readonly dirs = new Set<string>();
  add(updates: PermissionUpdate[]): void {
    for (const u of updates) {
      if (u.type === 'addRules' && u.behavior === 'allow') for (const r of u.rules) this.rules.add(ruleString(r));
      else if (u.type === 'addDirectories') for (const d of u.directories) this.dirs.add(d);
    }
  }
  covers(suggestions: PermissionUpdate[] | undefined): boolean {
    const wanted: string[] = [];
    for (const u of suggestions ?? []) {
      if (u.type === 'addRules' && u.behavior === 'allow') wanted.push(...u.rules.map((r) => `r:${ruleString(r)}`));
      else if (u.type === 'addDirectories') wanted.push(...u.directories.map((d) => `d:${d}`));
    }
    return wanted.length > 0 && wanted.every((w) => (w.startsWith('r:') ? this.rules.has(w.slice(2)) : this.dirs.has(w.slice(2))));
  }
}

export type PermissionDeps = Pick<TurnRequest, 'noTools' | 'onQuestion' | 'onQuestionMalformed' | 'autoApprove' | 'onAutoApproved' | 'onPermission'>;

/** The old canUseTool, answering the CLI's permission-prompt tool through the bridge. */
export function permissionHandler(req: PermissionDeps, audit: ToolAudit, gate: ModeGate, grants: SessionGrants): BridgeHandlers['permission'] {
  return async (call, signal): Promise<PermissionReply> => {
    const { tool_name: toolName, input, tool_use_id: toolUseId } = call;
    audit.handled.add(toolUseId);
    const deny = (message: string): PermissionReply => ({ behavior: 'deny', message });
    if (toolName.startsWith(`mcp__${BRIDGE_SERVER}__`)) return deny(SELF_CALL_MESSAGE);
    if (req.noTools) return deny(NO_TOOLS_MESSAGE);
    if (toolName === 'AskUserQuestion') {
      const questions = parseQuestions(input);
      if (!questions) { await req.onQuestionMalformed?.(input); return deny(QUESTION_MALFORMED_MESSAGE); }
      const answers = req.onQuestion ? await req.onQuestion({ toolUseId, questions, signal }) : null;
      if (!answers) return deny(QUESTION_UNANSWERED_MESSAGE);
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    const pr: PermissionRequest = {
      toolName, input, toolUseId, signal,
      ...(call.permission_suggestions ? { suggestions: call.permission_suggestions } : {}),
      suppressAlwaysAllowRule: false,
    };
    if (req.autoApprove?.()) {
      await req.onAutoApproved?.(pr);
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName !== 'ExitPlanMode' && grants.covers(pr.suggestions)) {
      audit.handled.delete(toolUseId); // decided by a rule the user gave earlier: audited from the stream as 'cli'
      return { behavior: 'allow', updatedInput: input };
    }
    const decision = await req.onPermission(pr);
    if (toolName === 'ExitPlanMode') {
      if (decision === 'deny') return deny(KEEP_PLANNING_MESSAGE);
      const mode = decision === 'session' ? 'acceptEdits' : 'default';
      gate.mode = mode;
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
    }
    if (decision === 'deny') return deny(DENIED_MESSAGE);
    if (decision === 'session') {
      const updates = sessionUpdates(pr);
      if (updates.length) {
        grants.add(updates);
        if (updates.some((u) => u.type === 'setMode' && u.mode === 'acceptEdits')) gate.mode = 'acceptEdits';
        return { behavior: 'allow', updatedInput: input, updatedPermissions: updates };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
```

- [ ] **Step 14: Write the failing synthesized-suggestion test** (spike D3 negative: no `permission_suggestions`)

`TurnRunner`'s `addGrants` persists 이 세션 only from `pr.suggestions` (through `sessionUpdates(pr)`). If the CLI sends no `permission_suggestions`, `pr.suggestions` would be empty and 이 세션 would neither persist to later turns nor be remembered by `SessionGrants`. `permissionHandler` therefore synthesizes one suggestion from the tool name when the request carries none. Append to `permissions.test.ts`:

```ts
import { synthesizedSuggestions } from './permissions';

describe('permission suggestions when the CLI sends none (spike D3 negative)', () => {
  it('a request without permission_suggestions reaches onPermission with one synthesized session rule', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    await h({ tool_name: 'Write', input: { file_path: '/w/a.txt', content: 'x' }, tool_use_id: 't1' }, sig);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' }],
    }));
  });
  it('Bash: the synthesized rule carries the exact command as ruleContent', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    await h({ tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 't1' }, sig);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }],
    }));
  });
  it('a request with permission_suggestions is passed through unchanged', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    await h({ tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 't1', permission_suggestions: bashSuggestion }, sig);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ suggestions: bashSuggestion }));
  });
  it('이 세션 on a synthesized suggestion is returned as updatedPermissions and remembered for the process', async () => {
    const onPermission = vi.fn(async () => 'session' as const);
    const { h } = mk({ onPermission });
    const r = await h({ tool_name: 'Write', input: {}, tool_use_id: 't1' }, sig);
    expect(r).toEqual({ behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' }] });
    expect(await h({ tool_name: 'Write', input: {}, tool_use_id: 't2' }, sig)).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(onPermission).toHaveBeenCalledTimes(1);
  });
  it('synthesizedSuggestions: ExitPlanMode gets none (it is answered with setMode)', () => {
    expect(synthesizedSuggestions('ExitPlanMode', {})).toBeUndefined();
    expect(synthesizedSuggestions('Bash', { command: 42 })).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]);
  });
});
```

(Merge the `synthesizedSuggestions` import into the existing `./permissions` import line at the top of the file.)

- [ ] **Step 15: Run it and see it fail**

Run: `npx vitest run src/server/engine/claudeCli/permissions.test.ts --maxWorkers=4`
Expected: FAIL — `synthesizedSuggestions` is not exported, and the first test sees `suggestions` absent from the `onPermission` argument.

- [ ] **Step 16: Synthesize the suggestion in `permissions.ts`**

Add above `permissionHandler`:

```ts
/**
 * The suggestion deck offers when the CLI's prompt-tool request has no `permission_suggestions`
 * (spike D3 negative): allow this tool for the session; for Bash, this exact command. Without it
 * TurnRunner's addGrants (which reads pr.suggestions) would have nothing to persist for 이 세션.
 */
export function synthesizedSuggestions(toolName: string, input: Record<string, unknown>): PermissionUpdate[] | undefined {
  if (toolName === 'ExitPlanMode') return undefined;
  const ruleContent = toolName === 'Bash' && typeof input.command === 'string' && input.command ? input.command : undefined;
  return [{ type: 'addRules', rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }], behavior: 'allow', destination: 'session' }];
}
```

and in `permissionHandler` replace the `pr` construction with:

```ts
    const suggestions = call.permission_suggestions ?? synthesizedSuggestions(toolName, input);
    const pr: PermissionRequest = {
      toolName, input, toolUseId, signal,
      ...(suggestions ? { suggestions } : {}),
      suppressAlwaysAllowRule: false,
    };
```

- [ ] **Step 17: Run it and see it pass**

Run: `npx vitest run src/server/engine/claudeCli/permissions.test.ts --maxWorkers=4`
Expected: PASS, including the earlier `passes suggestions and the abort signal to onPermission` and `session → updatedPermissions rewritten to destination session` tests (both send suggestions, so they take the pass-through branch).

- [ ] **Step 18: Add the `ask` helper to the fake CLI** (used by engine tests in Task 8a)

In `fakeClaudeCli.ts`, the returned object gains:

```ts
/** What the real permissionMcp.ts would do for the latest spawn: read its mcp-config file, POST to the bridge. */
ask: async (call: { tool_name: string; input: Record<string, unknown>; tool_use_id: string; permission_suggestions?: unknown }) => {
  const s = spawns[spawns.length - 1];
  if (!s) throw new Error('no spawn');
  const cfgPath = argValue(s.args, '--mcp-config')!;
  const env = (JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers.deck_bridge!.env;
  const r = await postBridge(env.DECK_BRIDGE_SOCK!, env.DECK_BRIDGE_TOKEN!, '/v1/permission', call);
  return JSON.parse(r.body) as Record<string, unknown>;
},
```

with `import fs from 'node:fs';` and `import { postBridge } from './permissionMcp';` at the top.

- [ ] **Step 19: Run the Task 4 tests and the engine suite**

Run: `npx vitest run src/server/engine/claudeCli src/server/engine/ClaudeEngine.test.ts --maxWorkers=4`
Expected: PASS (`Engine.ts` now imports the local `PermissionUpdate`; `sessionUpdates` type-checks against it).

- [ ] **Step 20: Commit**

```bash
git add src/server/engine/claudeCli/permissionTypes.ts src/server/engine/claudeCli/texts.ts src/server/engine/claudeCli/bridge.ts src/server/engine/claudeCli/bridge.test.ts src/server/engine/claudeCli/permissionMcp.ts src/server/engine/claudeCli/permissionMcp.test.ts src/server/engine/claudeCli/permissions.ts src/server/engine/claudeCli/permissions.test.ts src/server/engine/claudeCli/fakeClaudeCli.ts src/server/engine/claudeCli/fixtures src/server/engine/Engine.ts src/server/engine/ClaudeEngine.ts
git commit -m "feat(claude-cli): 권한 프롬프트 MCP 도구와 유닉스 소켓 브리지, AskUserQuestion 중계"
```

---

### Task 5: Hooks — relay what deck still needs, drop the rest

Today `buildOptions` registers four in-process hooks. In the CLI world:

| SDK hook | Decision | Replacement |
|---|---|---|
| PreToolUse (noTools only) | **Relay** | `--settings` command hook → `hookRelay.ts` → bridge → `hookHandler` (deny + audit 'deck'); fail-closed. |
| UserPromptSubmit (systemNote) | **Relay** | Same relay; `additionalContext` on the first prompt only (prompt cache unchanged). The note text never touches disk. |
| PostToolUse / PostToolUseFailure (audit 'cli') | **Remove** | `ToolTracker` in `stream.ts`: a `tool_result` for a call deck did not decide → audit allow 'cli' (main and subagent calls). Error results are held until the next `result` frame so a late `permission_denied` / `permission_denials` wins. |
| PermissionDenied (auto-mode classifier only) | **Remove** | Never fires in deck's modes; denials still come from `system/permission_denied` and `result.permission_denials` (`deniedCalls`, unchanged). |
| *(new)* PreToolUse on edit tools | **Relay** | Mid-process permission-mode changes (`live.setPermissionMode`, plan card) without the control protocol: `hookHandler` answers `deny` (switched to plan), `allow` (switched to acceptEdits), `ask` (switched from acceptEdits to default), or no opinion. Fail-open (an IPC failure leaves the CLI's own permission flow in charge). |

**Files:**
- Create: `src/server/engine/claudeCli/hooks.ts`, `src/server/engine/claudeCli/hooks.test.ts`
- Create: `src/server/engine/claudeCli/hookRelay.ts`, `src/server/engine/claudeCli/hookRelay.test.ts`
- Modify: `src/server/engine/claudeCli/stream.ts` (add `ToolTracker`), `src/server/engine/claudeCli/stream.test.ts`, `src/server/engine/claudeCli/texts.ts` (`PLAN_GATE_MESSAGE`, `HOOK_RELAY_FAILED_MESSAGE`)
- Modify: `src/server/engine/claudeCli/fixtures/capture.ts` (hook settings for bridge scenarios), `src/server/engine/claudeCli/fakeClaudeCli.ts` (`hook` helper)
- Create: `fixtures/hooks.*`, `fixtures/hook-ask.*`, `fixtures/hook-allow.*`

**Interfaces:**
- Consumes: `ToolAudit` (`stream.ts`), `ModeGate` (`permissions.ts`), `BridgeHandlers` (`bridge.ts`), `postBridge` (`permissionMcp.ts`), `buildSettings`, `RelaySpec` (`args.ts`), `TurnRequest` (`../Engine`).
- Produces:
  ```ts
  // hooks.ts
  export type HookDeps = Pick<TurnRequest, 'noTools' | 'systemNote'>;
  export function hookHandler(req: HookDeps, audit: ToolAudit, gate: ModeGate): BridgeHandlers['hook'];
  // hookRelay.ts (node built-ins only)
  export function relayOutput(fail: 'open' | 'deny', status: number | null, body: string): string;
  // stream.ts
  export class ToolTracker { constructor(audit: ToolAudit); apply(m: CliMessage): Promise<void>; inputOf(id: string): unknown }
  // texts.ts
  export const PLAN_GATE_MESSAGE = '계획 모드로 바뀌었습니다 — 파일을 바꾸지 말고 계획을 이어 가 주세요';
  export const HOOK_RELAY_FAILED_MESSAGE = '도구 사용 여부를 deck 에 확인하지 못해 거부했습니다';
  ```

- [ ] **Step 1: Write the failing hook-handler and relay tests**

```ts
// src/server/engine/claudeCli/hooks.test.ts
import { describe, it, expect } from 'vitest';
import { hookHandler } from './hooks';
import { toolAudit } from './stream';
import { NO_TOOLS_MESSAGE, PLAN_GATE_MESSAGE } from './texts';
import type { ModeGate } from './permissions';

const sig = new AbortController().signal;
const pre = (tool = 'Write', id = 't1') => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: '/w/a' }, tool_use_id: id });
const mk = (req: Parameters<typeof hookHandler>[0], gate: ModeGate = { mode: 'default', startedIn: 'default' }) => {
  const audited: { decision: string; source: string; toolUseId: string }[] = [];
  const audit = toolAudit({ onToolAudit: async (e) => { audited.push(e); } });
  return { h: hookHandler(req, audit, gate), audited, gate };
};

describe('hookHandler PreToolUse', () => {
  it('noTools: deny with the handoff text, audited once as deck', async () => {
    const { h, audited } = mk({ noTools: true });
    expect(await h(pre('Read'), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NO_TOOLS_MESSAGE } });
    await h(pre('Read'), sig);
    expect(audited).toEqual([expect.objectContaining({ decision: 'deny', source: 'deck', toolUseId: 't1' })]);
  });
  it('no mode change: no opinion', async () => {
    expect(await mk({}).h(pre(), sig)).toEqual({});
  });
  it('switched to plan mid-process: deny edits', async () => {
    const { h, gate } = mk({});
    gate.mode = 'plan';
    expect(await h(pre(), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_GATE_MESSAGE } });
  });
  it('switched to acceptEdits: allow edits without a card', async () => {
    const { h, gate } = mk({});
    gate.mode = 'acceptEdits';
    expect(await h(pre(), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  });
  it('started in acceptEdits, switched back to default: ask', async () => {
    const { h, gate } = mk({}, { mode: 'acceptEdits', startedIn: 'acceptEdits' });
    gate.mode = 'default';
    expect(await h(pre(), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } });
  });
  it('started in plan and still plan: left to the CLI', async () => {
    expect(await mk({}, { mode: 'plan', startedIn: 'plan' }).h(pre(), sig)).toEqual({});
  });
});

describe('hookHandler UserPromptSubmit', () => {
  it('adds the note to the first prompt only', async () => {
    const { h } = mk({ systemNote: 'NOTE' });
    const ev = { hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
    expect(await h(ev, sig)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'NOTE' } });
    expect(await h(ev, sig)).toEqual({});
  });
  it('no note: nothing', async () => {
    expect(await mk({}).h({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, sig)).toEqual({});
  });
});
```

```ts
// src/server/engine/claudeCli/hookRelay.test.ts
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { PermissionBridge } from './bridge';
import { relayOutput } from './hookRelay';
import { HOOK_RELAY_FAILED_MESSAGE } from './texts';

const SCRIPT = path.join(__dirname, 'hookRelay.ts');
let bridge: PermissionBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

const run = (args: string[], stdin: string, token: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { input: stdin, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', DECK_BRIDGE_TOKEN: token }, timeout: 10_000 });

describe('relayOutput', () => {
  it('passes a 200 body through; failures follow the fail mode', () => {
    expect(relayOutput('open', 200, '{"a":1}')).toBe('{"a":1}');
    expect(relayOutput('open', null, '')).toBe('{}');
    expect(JSON.parse(relayOutput('deny', 401, ''))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: HOOK_RELAY_FAILED_MESSAGE } });
  });
});

describe('hookRelay.ts as the CLI runs it (plain node)', () => {
  it('posts stdin to the bridge and prints the answer', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ permission: async () => ({ behavior: 'deny', message: 'x' }), hook: async (i) => ({ hookSpecificOutput: { hookEventName: i.hook_event_name, additionalContext: 'N' } }) });
    const r = run(['--sock', reg.socketPath, '--fail', 'open'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'p' }), reg.token);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'N' } });
  });
  it('dead socket: fail-open prints {}, fail-deny prints a deny', () => {
    const sock = path.join(os.tmpdir(), 'qd-none', 'b.sock');
    const open = run(['--sock', sock, '--fail', 'open'], '{"hook_event_name":"PreToolUse"}', 'x');
    expect(open.status).toBe(0);
    expect(JSON.parse(open.stdout)).toEqual({});
    const deny = run(['--sock', sock, '--fail', 'deny'], '{"hook_event_name":"PreToolUse"}', 'x');
    expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
```

Append to `stream.test.ts`:

```ts
import { ToolTracker, toolAudit as mkAudit } from './stream';

describe('ToolTracker (replaces PostToolUse/PostToolUseFailure audit)', () => {
  const setup = () => {
    const seen: { toolUseId: string; decision: string; source: string }[] = [];
    const audit = mkAudit({ onToolAudit: async (e) => { seen.push(e); } });
    return { t: new ToolTracker(audit), audit, seen };
  };
  const use = (id: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } }) as CliMessage;
  const res = (id: string, isError = false, parent: string | null = null) => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] } }) as CliMessage;
  it('a successful result the CLI ran on its own → allow cli, once', async () => {
    const { t, seen } = setup();
    await t.apply(use('a'));
    await t.apply(res('a'));
    await t.apply(res('a'));
    expect(seen).toEqual([expect.objectContaining({ toolUseId: 'a', decision: 'allow', source: 'cli' })]);
  });
  it('subagent calls are audited too', async () => {
    const { t, seen } = setup();
    await t.apply(use('s', 'toolu_ag'));
    await t.apply(res('s', false, 'toolu_ag'));
    expect(seen.map((s) => s.toolUseId)).toEqual(['s']);
  });
  it('calls deck decided are skipped', async () => {
    const { t, audit, seen } = setup();
    audit.handled.add('b');
    await t.apply(use('b'));
    await t.apply(res('b'));
    expect(seen).toEqual([]);
  });
  it('error results wait for the turn result so a denial report wins', async () => {
    const { t, audit, seen } = setup();
    await t.apply(use('c'));
    await t.apply(res('c', true));
    expect(seen).toEqual([]);
    await audit.report({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'c' }, 'deny', 'rule');
    await t.apply({ type: 'result', subtype: 'success', session_id: 's' } as CliMessage);
    expect(seen).toEqual([expect.objectContaining({ toolUseId: 'c', decision: 'deny', source: 'rule' })]);
  });
  it('replayed tool results are ignored', async () => {
    const { t, seen } = setup();
    await t.apply(use('d'));
    await t.apply({ ...(res('d') as object), isReplay: true } as CliMessage);
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run src/server/engine/claudeCli/hooks.test.ts src/server/engine/claudeCli/hookRelay.test.ts src/server/engine/claudeCli/stream.test.ts --maxWorkers=4`
Expected: FAIL — `./hooks`, `./hookRelay` unresolved; `ToolTracker` not exported.

- [ ] **Step 3: Implement `hooks.ts`, `hookRelay.ts`, `ToolTracker`, the two texts**

```ts
// src/server/engine/claudeCli/hooks.ts
import type { TurnRequest } from '../Engine';
import type { BridgeHandlers } from './bridge';
import type { ModeGate } from './permissions';
import type { ToolAudit } from './stream';
import { NO_TOOLS_MESSAGE, PLAN_GATE_MESSAGE } from './texts';

export type HookDeps = Pick<TurnRequest, 'noTools' | 'systemNote'>;

const pre = (permissionDecision: 'allow' | 'deny' | 'ask', reason?: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...(reason ? { permissionDecisionReason: reason } : {}) },
});

/** Answers the `--settings` command hooks of one process (relayed by hookRelay.ts). */
export function hookHandler(req: HookDeps, audit: ToolAudit, gate: ModeGate): BridgeHandlers['hook'] {
  let noteSent = false;
  return async (input) => {
    if (input.hook_event_name === 'PreToolUse') {
      const call = { tool_name: String(input.tool_name ?? ''), tool_input: input.tool_input ?? null, tool_use_id: String(input.tool_use_id ?? '') };
      if (req.noTools) { await audit.report(call, 'deny', 'deck'); return pre('deny', NO_TOOLS_MESSAGE); }
      if (gate.mode === gate.startedIn) return {};
      if (gate.mode === 'plan') return pre('deny', PLAN_GATE_MESSAGE);
      if (gate.mode === 'acceptEdits') return pre('allow');
      if (gate.startedIn === 'acceptEdits') return pre('ask');
      return {};
    }
    if (input.hook_event_name === 'UserPromptSubmit') {
      if (noteSent || !req.systemNote) return {};
      noteSent = true;
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: req.systemNote } };
    }
    return {};
  };
}
```

```ts
// src/server/engine/claudeCli/hookRelay.ts
// Child entry for deck's `--settings` command hooks. The CLI runs:
//   DECK_BRIDGE_TOKEN=<t> node --disable-warning=ExperimentalWarning hookRelay.ts --sock <s> --fail open|deny
// The token comes from the env (never argv). stdin: the hook input JSON; stdout: the hook output JSON.
// node: built-ins only, erasable TS only.
import { pathToFileURL } from 'node:url';
import { postBridge } from './permissionMcp.ts';

const FAILED = '도구 사용 여부를 deck 에 확인하지 못해 거부했습니다';

export function relayOutput(fail: 'open' | 'deny', status: number | null, body: string): string {
  if (status === 200 && body) return body;
  return fail === 'deny'
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: FAILED } })
    : '{}';
}

async function main(): Promise<void> {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };
  const fail = arg('--fail') === 'deny' ? 'deny' : 'open';
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let status: number | null = null;
  let body = '';
  try {
    const r = await postBridge(arg('--sock'), process.env.DECK_BRIDGE_TOKEN ?? '', '/v1/hook', JSON.parse(raw || '{}'), AbortSignal.timeout(25_000));
    status = r.status;
    body = r.body;
  } catch {
    // dead socket, timeout, bad stdin: decided by the fail mode
  }
  process.stdout.write(relayOutput(fail, status, body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
```

Note the `.ts` extension in `import { postBridge } from './permissionMcp.ts'`: plain `node` needs it. To make that import legal for `tsc` and vite, add `"allowImportingTsExtensions": true` to `tsconfig.json` `compilerOptions` (valid because the config already has `"noEmit": true`). This is the only import between the two child scripts; `FAILED` is duplicated from `texts.ts` on purpose (the child may not import server modules), and `hookRelay.test.ts` asserts the two stay equal.

In `texts.ts` add:

```ts
/** A mid-process switch into plan mode (live.setPermissionMode): edits are refused by deck's PreToolUse hook. */
export const PLAN_GATE_MESSAGE = '계획 모드로 바뀌었습니다 — 파일을 바꾸지 말고 계획을 이어 가 주세요';
/** Mirrors hookRelay.ts (which may import node built-ins only). */
export const HOOK_RELAY_FAILED_MESSAGE = '도구 사용 여부를 deck 에 확인하지 못해 거부했습니다';
```

In `stream.ts` add:

```ts
/**
 * Stream-side audit for tool calls deck was not asked about (allow rule, permission mode, tools
 * that need no permission) — what the PostToolUse/PostToolUseFailure hooks reported before.
 * Error results are held until the turn's `result`, so a denial seen in the meantime
 * (permission_denied frame or permission_denials) is reported instead.
 */
export class ToolTracker {
  private readonly calls = new Map<string, { name: string; input: unknown }>();
  private held: string[] = [];
  constructor(private readonly audit: ToolAudit) {}

  inputOf(id: string): unknown { return this.calls.get(id)?.input ?? null; }

  async apply(m: CliMessage): Promise<void> {
    if (m.type === 'assistant') {
      for (const b of m.message.content) if (b.type === 'tool_use' && typeof b.id === 'string') this.calls.set(b.id, { name: String(b.name ?? ''), input: b.input });
      return;
    }
    if (m.type === 'user' && m.isReplay !== true && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || !this.calls.has(b.tool_use_id)) continue;
        if (b.is_error === true) this.held.push(b.tool_use_id);
        else await this.report(b.tool_use_id);
      }
      return;
    }
    if (m.type === 'result') {
      const held = this.held;
      this.held = [];
      for (const id of held) await this.report(id);
    }
  }

  private async report(id: string): Promise<void> {
    const c = this.calls.get(id);
    this.calls.delete(id);
    if (c) await this.audit.report({ tool_name: c.name, tool_input: c.input, tool_use_id: id }, 'allow', 'cli');
  }
}
```

The `relayOutput` deny case in `hookRelay.test.ts` compares against `HOOK_RELAY_FAILED_MESSAGE` from `texts.ts`, which keeps the duplicated string in sync.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run src/server/engine/claudeCli/hooks.test.ts src/server/engine/claudeCli/hookRelay.test.ts src/server/engine/claudeCli/stream.test.ts src/server/engine/claudeCli/permissionMcp.test.ts --maxWorkers=4`
Expected: PASS.

- [ ] **Step 5: Hook settings in the capture runner, `hook` helper in the fake**

In `fixtures/capture.ts`: `BridgeScenario` gains `hookSettings?: (relay: RelaySpec) => Record<string, unknown>`; inside `bridgeSetup` build `const relay = { node: process.execPath, script: path.join(import.meta.dirname, '..', 'hookRelay.ts'), socketPath: reg.socketPath, token: reg.token }` and return `settings: sc.hookSettings?.(relay) ?? {}`. Add the scenarios:

```ts
hooks: {
  maxTurns: 3,
  first: 'Read the file a.txt with the Read tool. Then tell me the codeword from your context if you were given one, else NONE.',
  hookSettings: (relay) => buildSettings({ noTools: true, systemNote: 'The codeword is PAPAYA.', relay }),
  handlers: ({ meta }) => {
    const audit = toolAudit({ onToolAudit: async (e) => { ((meta.audits ??= []) as unknown[]).push(e); } });
    const h = hookHandler({ noTools: true, systemNote: 'The codeword is PAPAYA.' }, audit, { mode: 'default', startedIn: 'default' });
    return { hook: async (i, s) => { ((meta.hookEvents ??= []) as unknown[]).push(i.hook_event_name); return h(i, s); } };
  },
  drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
},
'hook-ask': {
  maxTurns: 4,
  permissionMode: 'acceptEdits',
  first: 'Create a.txt containing a with the Write tool, then create b.txt containing b with the Write tool. Then reply DONE.',
  hookSettings: (relay) => buildSettings({ relay }),
  handlers: ({ meta }) => {
    let n = 0;
    return { hook: async (i) => {
      if (i.hook_event_name !== 'PreToolUse') return {};
      n += 1;
      ((meta.hookCalls ??= []) as unknown[]).push(i.tool_name);
      return n === 2 ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } } : {};
    } };
  },
  drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
  after: (ctx) => { ctx.meta.files = ['a.txt', 'b.txt'].filter((f) => fs.existsSync(path.join(ctx.dir, 'work', f))); },
},
'hook-allow': {
  maxTurns: 3,
  first: 'Create c.txt containing c with the Write tool. Then reply DONE.',
  hookSettings: (relay) => buildSettings({ relay }),
  handlers: () => ({ hook: async (i) => (i.hook_event_name === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } : {}) }),
  drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
  after: (ctx) => { ctx.meta.fileWritten = fs.existsSync(path.join(ctx.dir, 'work', 'c.txt')); },
},
```

(imports: `buildSettings`, `type RelaySpec` from `../args`; `hookHandler` from `../hooks`; `toolAudit` from `../stream`. The three scenarios go into `bridgeScenarios` and are captured with `captureWithBridge`.)

In `fakeClaudeCli.ts` add next to `ask`:

```ts
/** What hookRelay.ts would do for the latest spawn: parse --sock and the DECK_BRIDGE_TOKEN= prefix out of the settings file's first hook command. */
hook: async (input: Record<string, unknown>) => {
  const s = spawns[spawns.length - 1]!;
  const settings = JSON.parse(fs.readFileSync(argValue(s.args, '--settings')!, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const cmd = Object.values(settings.hooks)[0]![0]!.hooks[0]!.command;
  const word = (flag: string) => (cmd.match(new RegExp(`'${flag}' '([^']*)'`)) ?? [])[1]!;
  const token = (cmd.match(/^DECK_BRIDGE_TOKEN='([^']*)' /) ?? [])[1]!;
  const r = await postBridge(word('--sock'), token, '/v1/hook', input);
  return JSON.parse(r.body) as Record<string, unknown>;
},
```

- [ ] **Step 6 (spike): Capture the hook scenarios**

```bash
for s in hooks hook-ask hook-allow; do npx tsx src/server/engine/claudeCli/fixtures/capture.ts "$s"; done
npx vitest run src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=4
```

E1/E3 were already answered as go/no-go in Task 3 Step 7 with plain printf hooks; here the same two facts are re-recorded through deck's real relay (`hookRelay.ts` → bridge → `hookHandler`) as regression fixtures.

| Scenario | Assumption |
|---|---|
| `hooks` | E1: a `--settings` command-hook PreToolUse deny (through the relay) blocks the tool and its reason reaches the model as the tool result; E3: UserPromptSubmit `additionalContext` from a command hook reaches the model (result names PAPAYA); E4: no hook frames appear on stdout without `--include-hook-events` (meta `hookEvents` lists what ran; the fixture shows no `hook_*` frames). |
| `hook-ask` | E2a: `permissionDecision: "ask"` in `-p` mode with a prompt tool routes the call to `mcp__deck_bridge__permission` (meta `calls` has exactly the second Write) instead of failing the call. |
| `hook-allow` | E2b: `permissionDecision: "allow"` skips the prompt tool in default mode (meta `calls` empty, `fileWritten: true`). |

If E2a fails (an `ask` hook denies outright in print mode), change the `default`-after-`acceptEdits` branch of `hookHandler` to return `{}` and list "switching from acceptEdits back to manual mid-turn takes effect next turn" under Lost or changed features. E1/E3 fallbacks: see Task 3 Step 7 (if they passed there but fail here, the relay is at fault — fix `hookRelay.ts`/`hookHandler`, not the plan).

- [ ] **Step 7: Add the fixture assertions and run**

Append to `hooks.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

describe('hook fixtures (real CLI captures)', () => {
  const frames = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.meta.json`), 'utf8'));
  it('E1: the relayed deny reached the model as an error tool result', () => {
    const results = frames('hooks').filter((f) => f.type === 'user').flatMap((f) => (Array.isArray(f.message.content) ? f.message.content : [])).filter((b: { type: string }) => b.type === 'tool_result');
    expect(results.some((b: { is_error?: boolean; content: unknown }) => b.is_error && JSON.stringify(b.content).includes('인계 메모'))).toBe(true);
  });
  it('E3: the note reached the model once', () => {
    expect(frames('hooks').find((f) => f.type === 'result').result).toContain('PAPAYA');
  });
  it('E4: no hook frames without --include-hook-events', () => {
    expect(frames('hooks').some((f) => f.type === 'system' && String(f.subtype).startsWith('hook_'))).toBe(false);
  });
  it('E2: ask routes to the prompt tool, allow skips it', () => {
    expect(meta('hook-ask').calls.map((c: { tool_name: string }) => c.tool_name)).toEqual(['Write']);
    expect(meta('hook-allow').calls).toEqual([]);
    expect(meta('hook-allow').fileWritten).toBe(true);
  });
});
```

Run: `npx vitest run src/server/engine/claudeCli --maxWorkers=4`
Expected: PASS (if a spike recorded a failed assumption, the matching assertion was changed in Step 6 together with the code).

- [ ] **Step 8: Commit**

```bash
git add src/server/engine/claudeCli/hooks.ts src/server/engine/claudeCli/hooks.test.ts src/server/engine/claudeCli/hookRelay.ts src/server/engine/claudeCli/hookRelay.test.ts src/server/engine/claudeCli/stream.ts src/server/engine/claudeCli/stream.test.ts src/server/engine/claudeCli/texts.ts src/server/engine/claudeCli/fakeClaudeCli.ts src/server/engine/claudeCli/fixtures tsconfig.json
git commit -m "feat(claude-cli): 설정 파일 훅 중계(도구 차단·메모·모드 게이트)와 스트림 기반 도구 감사"
```

---

### Task 6: Fork-at-message, own-entry ownership, holder marker

Three things today lean on SDK-only behaviour:

1. **`forkAt`** uses SDK `resumeSessionAt`, which the CLI does not have. Redesign: deck writes a *truncated copy* of the parent transcript (the chain from the root up to and including `forkAt`) into the per-process temp dir and starts `claude --resume=<that file> --fork-session`. The CLI loads the copy and writes the fork under a new session id; the parent transcript is never written (same guarantee as today).
2. **Foreign-write detection** treats `entrypoint === 'sdk-ts'` as "deck wrote this". A `claude -p` child stamps whatever the CLI stamps for print mode (recorded by the spike, not set by deck), which other `claude -p` users share. Redesign: per-entry ownership — the uuids and API message ids that deck's own processes emitted on stdout (`deckWrites`). The `sdk-ts` rule stays for transcripts written by earlier deck versions.
3. **`ProcessHolders`** recognises a second deck instance's children by the SDK's `node_modules` path (`ownRoots`). The CLI now lives wherever the user installed it. Redesign: deck's children carry the argv marker `--permission-prompt-tool mcp__deck_bridge__permission` (always present, see `claudeArgs`), which no user-run session has.

**Item 1 is deferred if spike F1 was negative** (`fixtures/go-no-go.meta.json` has `"F1": false`, Task 3 Step 10): skip `fork.ts`/`fork.test.ts`, `FORK_SOURCE_MISSING`, and the `fork-parent`/`fork-file` scenarios and their assertions; keep `FORK_AT_UNSUPPORTED` in `texts.ts` (the engine returns it for every `forkAt`). Items 2 and 3 are done either way.

**Files:**
- Create: `src/server/engine/claudeCli/fork.ts`, `src/server/engine/claudeCli/fork.test.ts`
- Create: `src/server/engine/claudeCli/ownedEntries.ts`, `src/server/engine/claudeCli/ownedEntries.test.ts`
- Modify: `src/server/engine/claudeCli/texts.ts` (`FORK_SOURCE_MISSING`, `FORK_AT_UNSUPPORTED`)
- Modify: `src/server/sessions/foreignWrites.ts`, `src/server/sessions/foreignWrites.test.ts`
- Modify: `src/server/turn/TurnRunner.ts` (`foreignWrites` passes ownership), `src/server/ws.ts` (`followOutside` passes ownership)
- Modify: `src/server/sessions/ProcessHolders.ts`, `src/server/sessions/ProcessHolders.test.ts`, `src/server/main.ts` (line 52: `new ProcessHolders()` without `ownRoots`)
- Modify: `src/server/engine/claudeCli/fixtures/capture.ts` (`resume` may be async; project-dir cleanup; scenarios `fork-parent`, `fork-file`, `owned-uuids`)
- Create: `fixtures/fork-parent.*`, `fixtures/fork-file.*`, `fixtures/owned-uuids.*`

**Interfaces:**
- Consumes: `projectSlug` (`src/server/sessions/slug.ts`), `CliMessage` (`messages.ts`), `PERMISSION_TOOL` (`args.ts`).
- Produces:
  ```ts
  // fork.ts
  export function chainUpTo(lines: string[], at: string): string[] | null;
  export function forkCandidates(projectsDir: string, cwd: string, sessionId: string, realpath?: (p: string) => string): string[];
  export type ForkSource = { ok: true; path: string } | { ok: false; text: string };
  export function writeForkSource(o: { candidates: string[]; at: string; dir: string; sessionId: string; readFile?: (p: string) => Promise<string> }): Promise<ForkSource>;
  // ownedEntries.ts
  export class OwnedEntries {
    constructor(max?: number);
    add(key: string): void;
    note(m: CliMessage): void;
    has(uuid: string, messageId: string | null): boolean;
    readonly size: number;
  }
  export const deckWrites: OwnedEntries;
  // foreignWrites.ts
  export type ForeignOpts = { isOwn?: (uuid: string, messageId: string | null) => boolean; nowMs?: number; lagMs?: number };
  export const OWN_LAG_MS = 3000;
  export function classifyLine(line: string, sinceMs: number, opts?: ForeignOpts): 'foreign' | 'old' | 'pending' | null;
  export function scanForeign(file: string, sinceMs: number, from?: number, opts?: ForeignOpts): Promise<{ foreign: boolean; end: number }>;
  // ProcessHolders.ts
  export const DECK_CHILD_MARKER = '--permission-prompt-tool mcp__deck_bridge__permission';
  export type HolderSelf = { pid: number };
  // texts.ts
  export const FORK_SOURCE_MISSING = '갈래를 만들 원본 대화 기록을 찾지 못했습니다';
  export const FORK_AT_UNSUPPORTED = '고친 메시지 지점을 원본 대화 기록에서 찾지 못했습니다';
  ```

- [ ] **Step 1: Write the failing fork and ownership tests**

```ts
// src/server/engine/claudeCli/fork.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { chainUpTo, forkCandidates, writeForkSource } from './fork';
import { FORK_AT_UNSUPPORTED, FORK_SOURCE_MISSING } from './texts';

const e = (uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', uuid, parentUuid, sessionId: 'p', message: { role: 'user', content: uuid }, ...extra });
const LINES = [
  JSON.stringify({ type: 'summary', summary: 'title', leafUuid: 'a2' }),
  e('u1', null),
  e('a1', 'u1', { type: 'assistant' }),
  e('u2', 'a1'),
  e('a2', 'u2', { type: 'assistant' }),
  e('side', 'a2', { isSidechain: true }),
  e('u3', 'a2'),
  e('a3', 'u3', { type: 'assistant' }),
  e('u2b', 'a1'), // an earlier edit's branch, after the main chain in the file
];

describe('chainUpTo', () => {
  it('keeps the chain from the root to `at`, plus leading metadata; drops later entries and other branches', () => {
    const out = chainUpTo(LINES, 'a2')!;
    expect(out.map((l) => JSON.parse(l).uuid ?? 'meta')).toEqual(['meta', 'u1', 'a1', 'u2', 'a2']);
  });
  it('follows logicalParentUuid across a compact boundary', () => {
    const lines = [e('u1', null), e('a1', 'u1'), e('cb', null, { type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'a1' }), e('s', 'cb', { isCompactSummary: true }), e('a2', 's')];
    expect(chainUpTo(lines, 'a2')!.map((l) => JSON.parse(l).uuid)).toEqual(['u1', 'a1', 'cb', 's', 'a2']);
  });
  it('unknown `at` → null; junk lines are skipped', () => {
    expect(chainUpTo(LINES, 'nope')).toBeNull();
    expect(chainUpTo(['{bad', e('u1', null)], 'u1')).toEqual([e('u1', null)]);
  });
});

describe('forkCandidates', () => {
  it('slug of cwd, of its realpath and of both normal forms, deduplicated', () => {
    const cwd = '/w/작업'.normalize('NFC');
    const c = forkCandidates('/h/projects', cwd, 's1', () => '/private' + cwd);
    const slug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
    expect(c).toEqual([
      path.join('/h/projects', slug(cwd), 's1.jsonl'),
      path.join('/h/projects', slug(cwd.normalize('NFD')), 's1.jsonl'),
      path.join('/h/projects', slug('/private' + cwd), 's1.jsonl'),
      path.join('/h/projects', slug(('/private' + cwd).normalize('NFD')), 's1.jsonl'),
    ]);
  });
});

describe('writeForkSource', () => {
  let dir = '';
  afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });
  it('writes the truncated chain as <sessionId>.jsonl (0600) into the process dir', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-fork-'));
    const src = path.join(dir, 'p.jsonl');
    await fs.writeFile(src, LINES.join('\n') + '\n');
    const r = await writeForkSource({ candidates: [path.join(dir, 'missing.jsonl'), src], at: 'a1', dir, sessionId: 'p' });
    expect(r).toEqual({ ok: true, path: path.join(dir, 'p.jsonl.fork', 'p.jsonl') });
    if (!r.ok) return;
    expect((await fs.readFile(r.path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).uuid ?? 'meta')).toEqual(['meta', 'u1', 'a1']);
    expect((await fs.stat(r.path)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(src, 'utf8')).toBe(LINES.join('\n') + '\n');
  });
  it('no transcript → FORK_SOURCE_MISSING; `at` not in it → FORK_AT_UNSUPPORTED', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-fork-'));
    expect(await writeForkSource({ candidates: [path.join(dir, 'x.jsonl')], at: 'a1', dir, sessionId: 'p' })).toEqual({ ok: false, text: FORK_SOURCE_MISSING });
    const src = path.join(dir, 's.jsonl');
    await fs.writeFile(src, LINES.join('\n'));
    expect(await writeForkSource({ candidates: [src], at: 'zz', dir, sessionId: 'p' })).toEqual({ ok: false, text: FORK_AT_UNSUPPORTED });
  });
});
```

```ts
// src/server/engine/claudeCli/ownedEntries.test.ts
import { describe, it, expect } from 'vitest';
import { OwnedEntries } from './ownedEntries';
import type { CliMessage } from './messages';

describe('OwnedEntries', () => {
  it('notes assistant uuids and API message ids, user uuids (replays too); ignores the rest', () => {
    const o = new OwnedEntries();
    o.note({ type: 'assistant', parent_tool_use_id: null, uuid: 'a-uuid', message: { id: 'msg_1', content: [] } } as CliMessage);
    o.note({ type: 'user', parent_tool_use_id: null, uuid: 'u-uuid', isReplay: true, message: { role: 'user', content: 'x' } } as CliMessage);
    o.note({ type: 'system', subtype: 'init', uuid: 'sys' } as CliMessage);
    expect(o.has('a-uuid', null)).toBe(true);
    expect(o.has('other-block-uuid', 'msg_1')).toBe(true); // same API message, another content-block entry
    expect(o.has('u-uuid', null)).toBe(true);
    expect(o.has('sys', null)).toBe(false);
    expect(o.has('x', null)).toBe(false);
  });
  it('stdin uuids deck sent are added directly', () => {
    const o = new OwnedEntries();
    o.add('00000000-0000-4000-8000-000000000001');
    expect(o.has('00000000-0000-4000-8000-000000000001', null)).toBe(true);
  });
  it('is bounded: the oldest keys go first', () => {
    const o = new OwnedEntries(3);
    for (const k of ['a', 'b', 'c', 'd']) o.add(k);
    expect(o.size).toBe(3);
    expect(o.has('a', null)).toBe(false);
    expect(o.has('d', null)).toBe(true);
  });
});
```

Append to `src/server/sessions/foreignWrites.test.ts`:

```ts
describe('ownership by deck’s own stdout (CLI children)', () => {
  const cli = (o: { type?: string; ms: number; uuid: string; id?: string; compact?: boolean }) => JSON.stringify({
    parentUuid: null, isSidechain: false, type: o.type ?? 'user', uuid: o.uuid, timestamp: at(o.ms), entrypoint: 'sdk-cli',
    ...(o.compact ? { isCompactSummary: true } : {}),
    message: { role: o.type ?? 'user', ...(o.id ? { id: o.id } : {}), content: 'x' },
  });
  const own = new Set(['mine-u', 'msg_mine']);
  const isOwn = (u: string, id: string | null) => own.has(u) || (id !== null && own.has(id));
  it('an entry deck emitted is not foreign; one it did not is', () => {
    expect(classifyLine(cli({ ms: 5, uuid: 'mine-u' }), T0, { isOwn })).toBeNull();
    expect(classifyLine(cli({ type: 'assistant', ms: 5, uuid: 'blk2', id: 'msg_mine' }), T0, { isOwn })).toBeNull();
    expect(classifyLine(cli({ ms: 5, uuid: 'theirs' }), T0, { isOwn })).toBe('foreign');
  });
  it('an unknown entry younger than the lag is pending (deck may not have read its stdout frame yet)', () => {
    expect(classifyLine(cli({ ms: 5, uuid: 'theirs' }), T0, { isOwn, nowMs: T0 + 1000, lagMs: 3000 })).toBe('pending');
    expect(classifyLine(cli({ ms: 5, uuid: 'theirs' }), T0, { isOwn, nowMs: T0 + 5000, lagMs: 3000 })).toBe('foreign');
  });
  it('compact summaries are bookkeeping, not a prompt', () => {
    expect(classifyLine(cli({ ms: 5, uuid: 'cs', compact: true }), T0, { isOwn })).toBeNull();
  });
  it('a pending line keeps the cursor where it was; older foreign lines are still found', async () => {
    const f = await transcript('pending.jsonl', [cli({ ms: 5, uuid: 'mine-u' }), cli({ ms: 6, uuid: 'late' })]);
    expect(await scanForeign(f, T0, 0, { isOwn, nowMs: T0 + 1000, lagMs: 3000 })).toEqual({ foreign: false, end: 0 });
    const g = await transcript('pending2.jsonl', [cli({ ms: 5, uuid: 'theirs' }), cli({ ms: 3000, uuid: 'late' })]);
    expect((await scanForeign(g, T0, 0, { isOwn, nowMs: T0 + 4000, lagMs: 3000 })).foreign).toBe(true);
  });
});
```

Replace the `ownRoots` cases in `src/server/sessions/ProcessHolders.test.ts` (lines 32–44: same rows, new rule):

```ts
const MARK = '--permission-prompt-tool mcp__deck_bridge__permission';
it("deck's own CLI children are never holders: by parent pid, by ancestry, and by deck's argv marker (another deck instance)", () => {
  expect(parseHolders(`700 600 /opt/bin/claude -p --output-format stream-json ${MARK} --resume=${B}`, { pid: DECK }).size).toBe(0);
  expect(parseHolders(`700 600 /opt/bin/claude -p --output-format stream-json --resume=${B}`, { pid: DECK }).get(B)).toBe('other');
});
```

and change the remaining `{ pid: DECK, ownRoots: [ROOT] }` arguments to `{ pid: DECK }` (delete `ROOT`). Rows that used `ROOT` as the SDK binary path keep their expectation by adding `${MARK}` to the command (they model deck children).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run src/server/engine/claudeCli/fork.test.ts src/server/engine/claudeCli/ownedEntries.test.ts src/server/sessions/foreignWrites.test.ts src/server/sessions/ProcessHolders.test.ts --maxWorkers=4`
Expected: FAIL — `./fork`, `./ownedEntries` unresolved; `classifyLine` ignores the third argument (`'foreign'` where `null`/`'pending'` expected); the marker row is reported as a holder.

- [ ] **Step 3: Implement**

```ts
// src/server/engine/claudeCli/fork.ts
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { projectSlug } from '../../sessions/slug';
import { FORK_AT_UNSUPPORTED, FORK_SOURCE_MISSING } from './texts';

type Entry = { uuid?: unknown; parentUuid?: unknown; logicalParentUuid?: unknown };

/**
 * 메시지 편집 갈래 without `resumeSessionAt`: the transcript lines that make up the conversation up to and
 * including entry `at` — its ancestor chain (parentUuid, or logicalParentUuid across a compact boundary) in file
 * order, plus uuid-less metadata lines (summary, title) that come before `at`. Null when `at` is not in the lines.
 */
export function chainUpTo(lines: string[], at: string): string[] | null {
  const parsed = lines.map((line) => { try { const r = JSON.parse(line) as unknown; return r && typeof r === 'object' ? (r as Entry) : null; } catch { return null; } });
  const parent = new Map<string, string | null>();
  for (const r of parsed) {
    if (r && typeof r.uuid === 'string') {
      const p = typeof r.parentUuid === 'string' ? r.parentUuid : typeof r.logicalParentUuid === 'string' ? r.logicalParentUuid : null;
      parent.set(r.uuid, p);
    }
  }
  if (!parent.has(at)) return null;
  const keep = new Set<string>();
  for (let u: string | null | undefined = at, i = 0; u && !keep.has(u) && i < 1_000_000; u = parent.get(u), i++) keep.add(u);
  const atIndex = parsed.findIndex((r) => r?.uuid === at);
  const out: string[] = [];
  parsed.forEach((r, i) => {
    if (!r || i > atIndex) return;
    if (typeof r.uuid === 'string' ? keep.has(r.uuid) : true) out.push(lines[i]!);
  });
  return out;
}

/** Where the CLI keeps `sessionId`'s transcript for `cwd` in one profile: slug of cwd and its realpath, NFC and NFD. */
export function forkCandidates(projectsDir: string, cwd: string, sessionId: string, realpath: (p: string) => string = realpathSync): string[] {
  let real = cwd;
  try { real = realpath(cwd); } catch { /* cwd gone: the plain slug only */ }
  const out: string[] = [];
  for (const p of [cwd, real]) for (const form of [p.normalize('NFC'), p.normalize('NFD')]) {
    const f = path.join(projectsDir, projectSlug(form), `${sessionId}.jsonl`);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

export type ForkSource = { ok: true; path: string } | { ok: false; text: string };

/**
 * Writes the truncated parent transcript to `<dir>/<sessionId>.jsonl.fork/<sessionId>.jsonl` (0600; `dir` is the
 * process's 0700 temp dir, removed after the turn) for `--resume=<path> --fork-session`. The file keeps the
 * parent's name so its entries' `sessionId` match the file they are in. The parent transcript is only read.
 */
export async function writeForkSource(o: { candidates: string[]; at: string; dir: string; sessionId: string; readFile?: (p: string) => Promise<string> }): Promise<ForkSource> {
  const read = o.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  let text: string | null = null;
  for (const c of o.candidates) {
    try { text = await read(c); break; } catch { /* next candidate */ }
  }
  if (text === null) return { ok: false, text: FORK_SOURCE_MISSING };
  const kept = chainUpTo(text.split('\n').filter((l) => l.trim()), o.at);
  if (!kept) return { ok: false, text: FORK_AT_UNSUPPORTED };
  const sub = path.join(o.dir, `${o.sessionId}.jsonl.fork`);
  await fs.mkdir(sub, { mode: 0o700, recursive: true });
  const file = path.join(sub, `${o.sessionId}.jsonl`);
  await fs.writeFile(file, kept.join('\n') + '\n', { mode: 0o600 });
  return { ok: true, path: file };
}
```

(`writeForkSource` writes into a subdirectory so the source can never overwrite a candidate that happens to sit in `dir`, as in the test.)

```ts
// src/server/engine/claudeCli/ownedEntries.ts
import type { CliMessage } from './messages';

/**
 * Transcript entries deck's own CLI children wrote, known from their stdout: entry uuids (assistant, user, replayed
 * prompts), API message ids (one assistant message is several transcript entries, one per content block), and
 * the uuids deck put on its stdin prompts. Replaces `entrypoint === 'sdk-ts'`. In memory, bounded, FIFO.
 */
export class OwnedEntries {
  private readonly keys = new Set<string>();
  constructor(private readonly max = 50_000) {}

  get size(): number { return this.keys.size; }

  add(key: string): void {
    if (!key || this.keys.has(key)) return;
    this.keys.add(key);
    if (this.keys.size > this.max) this.keys.delete(this.keys.values().next().value!);
  }

  note(m: CliMessage): void {
    if (m.type === 'assistant') {
      if (typeof m.uuid === 'string') this.add(m.uuid);
      if (typeof m.message.id === 'string') this.add(m.message.id);
    } else if (m.type === 'user' && typeof m.uuid === 'string') {
      this.add(m.uuid);
    }
  }

  has(uuid: string, messageId: string | null): boolean {
    return this.keys.has(uuid) || (messageId !== null && this.keys.has(messageId));
  }
}

/** The server-wide instance: the engine notes every frame, foreign-write checks ask it. */
export const deckWrites = new OwnedEntries();
```

`foreignWrites.ts` changes (everything else unchanged):

```ts
/** How long an entry deck may still be about to claim (its stdout frame not read yet) counts as undecided. */
export const OWN_LAG_MS = 3000;

export type ForeignOpts = {
  /** Entries deck's own CLI children emitted (`deckWrites.has`). */
  isOwn?: (uuid: string, messageId: string | null) => boolean;
  nowMs?: number;
  /** 0 (default) = never pending. */
  lagMs?: number;
};

export function classifyLine(line: string, sinceMs: number, opts: ForeignOpts = {}): 'foreign' | 'old' | 'pending' | null {
  // … unchanged up to the `t < sinceMs` check …
  if (r.isSidechain || r.isCompactSummary || typeof r.entrypoint !== 'string' || r.entrypoint === DECK_ENTRYPOINT) return null;
  if (!(r.type === 'assistant' || (r.type === 'user' && promptText(r) !== null))) return null;
  const id = (r.message as { id?: unknown } | null | undefined)?.id;
  if (opts.isOwn?.(r.uuid, typeof id === 'string' ? id : null)) return null;
  if (opts.lagMs && (opts.nowMs ?? Date.now()) - t < opts.lagMs) return 'pending';
  return 'foreign';
}
```

In `scanForeign(file, sinceMs, from = 0, opts: ForeignOpts = {})`: pass `opts` to `classifyLine`; keep a `let pending = false`; on `'pending'` set it and continue; both clean exits return `pending ? { foreign: false, end: from } : clean`. Update the `DECK_ENTRYPOINT` comment: "entries written by deck versions that ran the CLI through the Agent SDK". `foreignWriteSince` passes no options (unchanged behaviour for its callers).

`TurnRunner.foreignWrites` and `ws.ts` `followOutside` pass the ownership:

```ts
// src/server/turn/TurnRunner.ts (inside foreignWrites)
const r = await scanForeign(c.file, entry.since, from ?? 0, { isOwn: (u, id) => deckWrites.has(u, id), lagMs: OWN_LAG_MS });
// src/server/ws.ts (inside followOutside)
const r = await scanForeign(file, rec.at - OUTSIDE_SLACK_MS, rec.clean.get(file) ?? 0, { isOwn: (u, id) => deckWrites.has(u, id), lagMs: OWN_LAG_MS }).catch(() => null);
```

with `import { deckWrites } from '../engine/claudeCli/ownedEntries'` (TurnRunner) / `'./engine/claudeCli/ownedEntries'` (ws) and `OWN_LAG_MS` from the foreignWrites module.

`ProcessHolders.ts`:

```ts
/** deck's own CLI children (this or another deck instance) always carry this argv pair (`claudeArgs`). */
export const DECK_CHILD_MARKER = '--permission-prompt-tool mcp__deck_bridge__permission';

export type HolderSelf = {
  /** deck's own pid: its descendants are not "another" process. */
  pid: number;
};
```

In `parseHolders` replace the `roots` lines with `if (!isClaudeCli(r.command) || underDeck(r.pid) || r.command.includes(DECK_CHILD_MARKER)) continue;`. The constructor drops `ownRoots` (`opts: { pid?; ps?; ttlMs?; now? }`, `this.self = { pid: opts.pid ?? process.pid }`). `main.ts:52` becomes `const holders = new ProcessHolders();` (drop the now-unused `repoRootDefault`/`path` imports only if nothing else in `main.ts` uses them — check with `npx tsc --noEmit -p .`).

`texts.ts` gains the two `FORK_*` constants from the Interfaces block.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run src/server/engine/claudeCli/fork.test.ts src/server/engine/claudeCli/ownedEntries.test.ts src/server/sessions/foreignWrites.test.ts src/server/sessions/ProcessHolders.test.ts src/server/ws.outside.test.ts src/server/ws.bottleneck.test.ts --maxWorkers=4`
Expected: PASS (the ws tests still stub `runner.foreignWrites` or write `sdk-ts` entries, which remain deck's).

- [ ] **Step 5: Fork and ownership scenarios in the capture runner**

In `fixtures/capture.ts`: `Scenario.resume` becomes `(dir: string) => string | Promise<string>` and `capture()` awaits it. After `fs.rmSync(dir, …)`, remove the transcript directory the run created in the user's profile, so captures leave nothing behind:

```ts
const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
for (const f of new Set([work, work.normalize('NFD')])) fs.rmSync(path.join(projects, projectSlug(f)), { recursive: true, force: true });
```

Add the scenarios (`HANDOFF` is a file in `os.tmpdir()` that carries the parent run's facts to the fork run; it holds only a session id, a uuid and a path, and is deleted by `fork-file`):

```ts
const HANDOFF = path.join(os.tmpdir(), 'qd-cap-fork.json');
const PROJECTS = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');

'fork-parent': {
  maxTurns: 2,
  first: 'Remember the codeword KIWI. Reply only OK.',
  drive: (ctx, m) => {
    if (m.type === 'assistant' && typeof m.uuid === 'string') ctx.meta.lastAssistant = m.uuid;
    if (m.type !== 'result') return;
    ((ctx.meta.turns ??= []) as unknown[]).push({ session: m.session_id, lastAssistant: ctx.meta.lastAssistant });
    if ((ctx.meta.turns as unknown[]).length === 1) ctx.send('Also remember the codeword LIME. Reply only OK.');
    else ctx.proc.stop();
  },
  after: async (ctx) => {
    const [t1] = ctx.meta.turns as { session: string; lastAssistant: string }[];
    const file = path.join(PROJECTS(), projectSlug(path.join(ctx.dir, 'work')), `${t1!.session}.jsonl`);
    const copy = path.join(os.tmpdir(), `qd-cap-parent-${t1!.session}.jsonl`);
    fs.copyFileSync(file, copy);
    fs.writeFileSync(HANDOFF, JSON.stringify({ sessionId: t1!.session, at: t1!.lastAssistant, file: copy }), { mode: 0o600 });
    ctx.meta.transcriptUuidsSeenOnStdout = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'assistant').every((r) => (ctx.frames as { uuid?: string }[]).some((f) => f.uuid === r.uuid));
  },
},
'fork-file': {
  maxTurns: 1,
  resume: async (dir) => {
    const h = JSON.parse(fs.readFileSync(HANDOFF, 'utf8')) as { sessionId: string; at: string; file: string };
    const r = await writeForkSource({ candidates: [h.file], at: h.at, dir, sessionId: h.sessionId });
    if (!r.ok) throw new Error(r.text);
    return r.path;
  },
  extraArgs: () => ['--fork-session'],
  first: 'List every codeword I asked you to remember, comma-separated, nothing else.',
  drive: (ctx, m) => {
    if (m.type === 'system' && m.subtype === 'init') ctx.meta.initSession = m.session_id;
    if (m.type === 'result') { ctx.meta.result = m.result; ctx.meta.resultSession = m.session_id; ctx.proc.stop(); }
  },
  after: (ctx) => {
    const h = JSON.parse(fs.readFileSync(HANDOFF, 'utf8')) as { sessionId: string; file: string };
    ctx.meta.newId = ctx.meta.initSession !== h.sessionId;
    const own = path.join(PROJECTS(), projectSlug(path.join(ctx.dir, 'work')));
    ctx.meta.forkTranscriptInCwdProject = fs.existsSync(path.join(own, `${String(ctx.meta.initSession)}.jsonl`));
    ctx.meta.sourceKeptWhole = fs.readFileSync(h.file, 'utf8').includes('LIME');
    fs.rmSync(h.file, { force: true });
    fs.rmSync(HANDOFF, { force: true });
  },
},
'owned-uuids': {
  maxTurns: 3,
  settings: { permissions: { allow: ['Bash(echo owned)'] } },
  first: 'Run `echo owned` with the Bash tool, then reply DONE.',
  drive: (ctx, m) => { if (m.type === 'system' && m.subtype === 'init') ctx.meta.session = m.session_id; if (m.type === 'result') ctx.proc.stop(); },
  after: (ctx) => {
    const own = new OwnedEntries();
    own.add(FIRST_UUID);
    for (const f of ctx.frames) own.note(f);
    const file = path.join(PROJECTS(), projectSlug(path.join(ctx.dir, 'work')), `${String(ctx.meta.session)}.jsonl`);
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    ctx.meta.entrypoints = [...new Set(rows.map((r) => r.entrypoint).filter((x) => typeof x === 'string'))];
    ctx.meta.firstUuidKept = rows.some((r) => r.uuid === FIRST_UUID);
    ctx.meta.unowned = rows
      .filter((r) => !r.isSidechain && (r.type === 'assistant' || r.type === 'user') && typeof r.uuid === 'string')
      .filter((r) => !own.has(r.uuid as string, typeof (r.message as { id?: unknown })?.id === 'string' ? (r.message as { id: string }).id : null))
      .map((r) => ({ type: r.type, toolResult: Array.isArray((r.message as { content?: unknown })?.content) }));
  },
},
```

(imports: `projectSlug` from `../../../sessions/slug`, `writeForkSource` from `../fork`, `OwnedEntries` from `../ownedEntries`.) The `fork-parent` run sends its second prompt itself after the first `result`.

- [ ] **Step 6 (spike): Capture**

```bash
npx tsx src/server/engine/claudeCli/fixtures/capture.ts fork-parent
npx tsx src/server/engine/claudeCli/fixtures/capture.ts fork-file
npx tsx src/server/engine/claudeCli/fixtures/capture.ts owned-uuids
npx vitest run src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=4
```

| Scenario | Assumption |
|---|---|
| `fork-parent` | F0: assistant uuids on stdout are the uuids in the transcript (`transcriptUuidsSeenOnStdout: true`) — the base of both fork points (`forkAt` comes from transcript uuids) and of ownership. |
| `fork-file` | F1 (go/no-go already answered in Task 3 Step 10; this is the regression capture through deck's own `writeForkSource`): `--resume=<truncated file> --fork-session` loads exactly the truncated history (result names KIWI, not LIME); F2: the fork gets a new session id (`newId: true`) and its transcript is written under the cwd's project dir (`forkTranscriptInCwdProject: true`), where deck's index finds it; F3: the file deck reads from is never rewritten (`sourceKeptWhole`: the copy of the parent still contains LIME; truncation went to a separate file). |
| `owned-uuids` | G1: every main-chain user/assistant transcript entry is claimed by stdout uuids, API message ids and the stdin uuid (`unowned: []`); G2: `firstUuidKept` records whether the CLI keeps deck's stdin uuid (if false, ownership of prompts relies on the replayed frame's uuid); `entrypoints` records what a print-mode child stamps (expected not `sdk-ts`; deck does not set it). |

F1 fallback: see Task 3 Step 10 (if F1 passed there but `fork-file` fails here, the fault is in `writeForkSource`/`chainUpTo` — fix them). If G1 lists entries, add the missing key kind to `OwnedEntries.note` (e.g. the replayed prompt's uuid) and recapture; if prompt entries cannot be claimed at all, `classifyLine` must ignore `user` entries whose text equals a prompt deck sent — do not fall back to `entrypoint`.

- [ ] **Step 7: Fixture assertions and run**

Append to `fork.test.ts`:

```ts
import { readFileSync } from 'node:fs';
describe('fork fixtures (real CLI captures)', () => {
  const meta = (n: string) => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', `${n}.meta.json`), 'utf8'));
  it('F0: stdout assistant uuids are the transcript uuids', () => { expect(meta('fork-parent').transcriptUuidsSeenOnStdout).toBe(true); });
  it('F1/F2: the fork saw only the kept history, under a new id in the cwd project', () => {
    const m = meta('fork-file');
    expect(m.result).toMatch(/KIWI/);
    expect(m.result).not.toMatch(/LIME/);
    expect(m.newId).toBe(true);
    expect(m.forkTranscriptInCwdProject).toBe(true);
    expect(m.sourceKeptWhole).toBe(true);
  });
});
```

Append to `ownedEntries.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
it('G1: every main-chain entry of a real run is claimed by its stdout', () => {
  const m = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'owned-uuids.meta.json'), 'utf8'));
  expect(m.unowned).toEqual([]);
  expect(m.entrypoints).not.toContain('sdk-ts');
});
```

Run: `npx vitest run src/server/engine/claudeCli src/server/sessions --maxWorkers=4`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/engine/claudeCli/fork.ts src/server/engine/claudeCli/fork.test.ts src/server/engine/claudeCli/ownedEntries.ts src/server/engine/claudeCli/ownedEntries.test.ts src/server/engine/claudeCli/texts.ts src/server/engine/claudeCli/fixtures src/server/sessions/foreignWrites.ts src/server/sessions/foreignWrites.test.ts src/server/sessions/ProcessHolders.ts src/server/sessions/ProcessHolders.test.ts src/server/turn/TurnRunner.ts src/server/ws.ts src/server/main.ts
git commit -m "feat(claude-cli): 잘라 낸 사본으로 메시지 편집 갈래, 출력 기준 자기 기록 판별, 자식 프로세스 표식"
```

---

### Task 7: Background tasks over stdio — recorded fixture

The engine's background logic (`BackgroundTracker`, the `idle`/`continue` segments, `bgGraceMs`/`bgMaxMs`, the uuid attribution of results) moves unchanged; it depends on the CLI (a) staying alive with stdin open after a `result` while a background task runs, (b) emitting `background_tasks_changed` and/or `task_*` frames on stdout in print mode, and (c) running a continuation turn by itself when the task settles, whose `result` names none of deck's stdin uuids. Task 3 recorded that once (spike H1); this task pins it with a replay test, so Task 8a can move the loop without guessing.

**Files:**
- Create: `src/server/engine/claudeCli/background.fixture.test.ts`
- Reads (created in Task 3): `fixtures/background.jsonl`, `fixtures/background.meta.json`

**Interfaces:**
- Consumes: `BackgroundTracker`, `mapCliMessage`, `isActivity`, `isInjectedNoopResult` (`stream.ts`), `parseLine` (`messages.ts`), `FIRST_UUID` (`fixtures/capture.ts`), `ClaudeProcess` (`process.ts`), `fakeClaudeCli` (`fakeClaudeCli.ts`).
- Produces: no runtime code. Fixture contract (`background.meta.json`): `{ aliveAfterFirstResult: boolean, results: { uuids: string[] | null, tasksLive: number }[], sawLevel: boolean, sawTaskStarted: boolean, sawNotification: boolean, exit: { code, signal } }`.

The `background` scenario and its capture (spike H1–H4, with the fallbacks) moved to Task 3 (Steps 4 and 9); `fixtures/background.jsonl` and `background.meta.json` are already committed. This task only adds the replay test.

- [ ] **Step 1: Write the replay test**

```ts
// src/server/engine/claudeCli/background.fixture.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseLine, type CliMessage } from './messages';
import { BackgroundTracker, mapCliMessage, isActivity } from './stream';
import { ClaudeProcess } from './process';
import { fakeClaudeCli } from './fakeClaudeCli';

const dir = path.join(__dirname, 'fixtures');
const frames = (): CliMessage[] => fs.readFileSync(path.join(dir, 'background.jsonl'), 'utf8').split('\n').map(parseLine).filter((m): m is CliMessage => m !== null);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'background.meta.json'), 'utf8')) as {
  aliveAfterFirstResult: boolean; results: { uuids: string[] | null; tasksLive: number }[];
  sawLevel?: boolean; sawTaskStarted?: boolean; sawNotification?: boolean; exit: { code: number | null };
};

describe('background fixture (real CLI, print mode, stdin open)', () => {
  it('H1/H4: alive after the first result while a task runs; clean exit after stdin closes', () => {
    expect(meta.aliveAfterFirstResult).toBe(true);
    expect(meta.results[0]!.tasksLive).toBe(1);
    expect(meta.exit.code).toBe(0);
  });

  it('H2: the tracker sees the task come and go from the recorded frames', () => {
    const bg = new BackgroundTracker(() => 0);
    const live: number[] = [];
    for (const m of frames()) { if (bg.apply(m)) live.push(bg.tasks().length); }
    expect(live).toContain(1);
    expect(live.at(-1)).toBe(0);
    expect(meta.sawLevel === true || (meta.sawTaskStarted === true && meta.sawNotification === true)).toBe(true);
  });

  it('H3: two results; the continuation names none of deck’s prompts and is preceded by main-thread activity', () => {
    const fs_ = frames();
    const results = fs_.filter((m) => m.type === 'result');
    expect(results).toHaveLength(2);
    expect(meta.results[1]!.uuids ?? []).not.toContain('00000000-0000-4000-8000-000000000001');
    const firstResult = fs_.indexOf(results[0]!);
    const between = fs_.slice(firstResult + 1, fs_.indexOf(results[1]!));
    expect(between.some((m) => isActivity(m))).toBe(true);
  });

  it('the mapper turns the recorded notification into task_done and both results into results', () => {
    const evs = frames().flatMap((m) => mapCliMessage(m));
    expect(evs.some((e) => e.kind === 'task_done')).toBe(true);
    expect(evs.filter((e) => e.kind === 'result')).toHaveLength(2);
  });

  it('ClaudeProcess does not end the stream at a result: frames after the first result still arrive', async () => {
    const fake = fakeClaudeCli({ exitOnStdinClose: true });
    const p = new ClaudeProcess({ bin: 'claude', args: [], cwd: '/w', env: {}, spawnFn: fake.spawnFn });
    p.start();
    fake.push(...frames());
    const got: CliMessage[] = [];
    const reader = (async () => { for await (const m of p.messages()) { got.push(m); if (got.filter((x) => x.type === 'result').length === 2) p.stop(); } })();
    await reader;
    expect(got.filter((m) => m.type === 'result')).toHaveLength(2);
    expect(fake.state.inputClosed).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/server/engine/claudeCli/background.fixture.test.ts --maxWorkers=4`
Expected: PASS (5 tests) against the fixture captured in Task 3 Step 9. If Task 3 recorded a negative H-verdict, change the matching assertion in Step 1 to the recorded behaviour before running (fallback in Task 3 Step 9); any other failure here otherwise means the replay code is wrong, not the CLI.

- [ ] **Step 3: Commit**

```bash
git add src/server/engine/claudeCli/background.fixture.test.ts
git commit -m "test(claude-cli): 백그라운드 작업 실측 기록 재생 테스트"
```

---

### Task 8a: Engine rewrite behind a shim (old tests stay green)

`ClaudeEngine.runTurn` keeps its event contract and its loop (uuid attribution, steer echo, background segments, cap/grace, injected no-op results, denial audit, meter, commands) line for line; only the transport changes: `InputChannel` → `ClaudeProcess.write`, `queryFn` → spawn, `abortController.abort()` → SIGINT, SDK options → argv + two 0600 files in a 0700 per-process dir, `canUseTool`/hooks → bridge registration.

Task 8 is split in three commits so each one leaves the whole suite green and is reviewable on its own:
- **8a (this task)** writes the CLI engine and its own test. Today's SDK engine is moved, unchanged, into `legacySdkEngine.ts`; the exported `ClaudeEngine` is a thin shim that picks the CLI engine when the options carry `bin` and the SDK engine otherwise. Every existing test (they pass `queryFn`, never `bin`) and `main.ts` (no `bin` yet) keep running on the SDK engine, so nothing outside the new test changes behaviour in this commit.
- **8b** migrates the old tests to the fake CLI and deletes `fakeSdk.ts`.
- **8c** removes the shim and the SDK engine, uninstalls the SDK, adds the guard test, and wires `main.ts`/`config.ts` (the production switch happens here).

**Files:**
- Create: `src/server/engine/legacySdkEngine.ts` (today's SDK-driven class moved verbatim; deleted in Task 8c)
- Modify: `src/server/engine/ClaudeEngine.ts` (the CLI engine as `CliClaudeEngine` + the `ClaudeEngine` shim; the moved helpers stay re-exported as in Task 2; `QueryFn`, `buildOptions`, `buildPrompt` re-exported from `./legacySdkEngine` until Task 8b)
- Modify: `src/server/engine/claudeCli/texts.ts` (`CLAUDE_MISSING_TEXT`, `claudeTooOldText`, `ABORTED_TEXT`)
- Modify: `src/server/engine/claudeCli/fakeClaudeCli.ts` (`end()` before spawn is queued; spawn snapshots the `--settings` / `--mcp-config` files; `ask`/`hook` read the snapshot)
- Create: `src/server/engine/ClaudeEngine.cli.test.ts`
- Modify (only if spike D9 requires it, Step 9): `src/server/engine/claudeCli/args.ts`, `args.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–7.
- Produces:
  ```ts
  // legacySdkEngine.ts (temporary — removed in Task 8c)
  export type LegacySdkEngineOptions = /* today's ClaudeEngineOptions, unchanged (has queryFn, home, …; never bin) */;
  export class LegacySdkEngine implements Engine { /* today's ClaudeEngine body, unchanged */ }
  export type QueryFn; export function buildOptions(...); export function buildPrompt(...); // unchanged

  // ClaudeEngine.ts
  /** Shim until Task 8c: options with `bin` → CliClaudeEngine, otherwise → LegacySdkEngine. */
  export class ClaudeEngine implements Engine {
    constructor(opts: ClaudeEngineOptions | LegacySdkEngineOptions);
    runTurn(req: TurnRequest): AsyncIterable<EngineEvent>;
    close(): Promise<void>;
  }
  export type ClaudeEngineOptions = {
    /** From resolveClaudeBin at startup; a plain string = a usable binary (tests). */
    bin: ClaudeBin | string;
    spawnFn?: ClaudeSpawnFn;
    /** Shared bridge; opened lazily on the first turn when absent. */
    bridge?: PermissionBridge;
    accounts: Pick<AccountRegistry, 'env' | 'projectsDir'>;
    baseEnv?: NodeJS.ProcessEnv;
    readFile?: ReadFile;
    bgMaxMs?: number;
    bgGraceMs?: number;
    onCommands?: CommandsListener;
    /** DECK_STEER=0 → false: no `onLive().steer` (the replay flag stays on; deck's ownership needs it). */
    steer?: boolean;
    killGraceMs?: number;
    owned?: OwnedEntries;
    /** node binary for the two child scripts; default process.execPath. */
    node?: string;
    /** Parent of the per-process temp dirs; default os.tmpdir(). */
    tmpRoot?: string;
  };
  class CliClaudeEngine implements Engine {   // renamed to ClaudeEngine in Task 8c
    constructor(opts: ClaudeEngineOptions);
    runTurn(req: TurnRequest): AsyncIterable<EngineEvent>;
    /** Closes the bridge (server shutdown). */
    close(): Promise<void>;
  }
  // texts.ts
  export const CLAUDE_MISSING_TEXT = 'Claude Code(claude)를 찾지 못했습니다 — 터미널에서 설치하고 로그인한 뒤 deck 을 다시 시작해 주세요';
  export function claudeTooOldText(version: string): string; // `Claude Code ${version} 은 너무 오래됐습니다 — ${MIN_CLAUDE_VERSION} 이상으로 업데이트한 뒤 deck 을 다시 시작해 주세요`
  export const ABORTED_TEXT = '중단됨'; // = TurnRunner.ABORTED (the UI hides exactly this text)
  ```

- [ ] **Step 1: Fake additions**

In `fakeClaudeCli.ts`: `FakeSpawn` gains `files: { settings: Record<string, unknown> | null; mcpConfig: Record<string, unknown> | null }`, read synchronously inside `spawnFn` (the engine deletes its temp dir when the turn ends, tests inspect afterwards):

```ts
const readJson = (p: string | undefined) => { if (!p) return null; try { return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; } };
spawns.push({ bin, args: [...args], cwd: o.cwd, env: { ...o.env }, files: { settings: readJson(argValue(args, '--settings')), mcpConfig: readJson(argValue(args, '--mcp-config')) } });
```

`ask` and `hook` read `s.files.mcpConfig` / `s.files.settings` instead of the paths. `end()` called before the child exists is queued:

```ts
let endQueued: number | null = null;
// in spawnFn, after the pending frames are scheduled:
if (endQueued !== null) { const c = endQueued; endQueued = null; setImmediate(() => setImmediate(() => ctl.exit(c))); }
// returned object:
end: (code = 0) => { if (live) live.exit(code); else endQueued = code; },
```

- [ ] **Step 2: Write the failing engine test**

```ts
// src/server/engine/ClaudeEngine.cli.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { ClaudeEngine, type ClaudeEngineOptions } from './ClaudeEngine';
import type { EngineEvent, LiveInput, TurnRequest } from './Engine';
import { fakeClaudeCli, cli, argValue } from './claudeCli/fakeClaudeCli';
import { PermissionBridge } from './claudeCli/bridge';
import { OwnedEntries } from './claudeCli/ownedEntries';
import { CLAUDE_MISSING_TEXT, FORK_SOURCE_MISSING, PLAN_GATE_MESSAGE, claudeTooOldText } from './claudeCli/texts';
import { testRegistry } from '../../shared/accounts.testkit';

let bridge: PermissionBridge | null = null;
let tmp = '';
afterEach(async () => { await bridge?.close(); bridge = null; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over });
async function setup(over: Partial<ClaudeEngineOptions> = {}, fakeOpts: Parameters<typeof fakeClaudeCli>[0] = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-eng-'));
  bridge = await PermissionBridge.open();
  const f = fakeClaudeCli(fakeOpts);
  const owned = new OwnedEntries();
  const engine = new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge, accounts: testRegistry('/h'), baseEnv: { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'x' }, readFile: async () => Buffer.from(''), tmpRoot: tmp, owned, killGraceMs: 50, ...over });
  return { f, engine, owned };
}
const drain = async (it: AsyncIterable<EngineEvent>) => { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; };

describe('ClaudeEngine over the claude CLI', () => {
  it('spawns claude -p with stream-json, the prompt tool, 0600 files in a 0700 dir; the token never in argv/env', async () => {
    const { f, engine } = await setup();
    f.push(cli.init('s1'), cli.delta('a'), cli.result('a', 's1'));
    const evs = await drain(engine.runTurn(req()));
    const s = f.spawns[0]!;
    expect(s.bin).toBe('claude');
    expect(s.cwd).toBe('/w');
    expect(s.args.slice(0, 1)).toEqual(['-p']);
    expect(argValue(s.args, '--input-format')).toBe('stream-json');
    expect(argValue(s.args, '--permission-prompt-tool')).toBe('mcp__deck_bridge__permission');
    expect(s.args).not.toContain('--bare');
    expect(s.args).not.toContain('--strict-mcp-config');
    expect(argValue(s.args, '--session-id')).toMatch(/^[0-9a-f-]{36}$/);
    const settingsPath = argValue(s.args, '--settings')!;
    expect(path.dirname(settingsPath).startsWith(tmp)).toBe(true);
    expect(fs.existsSync(path.dirname(settingsPath))).toBe(false); // removed after the turn
    const token = (s.files.mcpConfig as { mcpServers: { deck_bridge: { env: { DECK_BRIDGE_TOKEN: string } } } }).mcpServers.deck_bridge.env.DECK_BRIDGE_TOKEN;
    expect(token.length).toBeGreaterThan(20);
    expect(s.args.join(' ')).not.toContain(token);
    expect(Object.values(s.env).join(' ')).not.toContain(token);
    expect(s.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(s.env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(s.env.MCP_TOOL_TIMEOUT).toBe(String(12 * 60 * 60_000));
    expect((s.files.settings as { hooks: Record<string, unknown> }).hooks.PreToolUse).toBeTruthy();
    expect(evs.find((e) => e.kind === 'result')).toMatchObject({ ok: true, sessionId: 's1' });
  });

  it('files are private while the child runs', async () => {
    const { f, engine } = await setup();
    let modes: number[] = [];
    const spawnFn: typeof f.spawnFn = (bin, args, o) => {
      const st = (p: string) => fs.statSync(p).mode & 0o777;
      const sp = argValue(args, '--settings')!;
      modes = [st(path.dirname(sp)), st(sp), st(argValue(args, '--mcp-config')!)];
      return f.spawnFn(bin, args, o);
    };
    const e2 = new ClaudeEngine({ bin: 'claude', spawnFn, bridge: bridge!, accounts: testRegistry('/h'), baseEnv: {}, readFile: async () => Buffer.from(''), tmpRoot: tmp });
    void engine;
    f.push(cli.init('s1'), cli.result('a', 's1'));
    await drain(e2.runTurn(req()));
    expect(modes).toEqual([0o700, 0o600, 0o600]);
  });

  it('resume passes --resume=<id> and no --session-id', async () => {
    const { f, engine } = await setup();
    f.push(cli.init('p1'), cli.result('a', 'p1'));
    await drain(engine.runTurn(req({ resumeSessionId: '11111111-2222-4333-8444-555555555555' })));
    expect(argValue(f.spawns[0]!.args, '--resume')).toBe('11111111-2222-4333-8444-555555555555');
    expect(argValue(f.spawns[0]!.args, '--session-id')).toBeUndefined();
  });

  it('missing or too old binary: one failed result, nothing spawned', async () => {
    const { f } = await setup();
    const missing = new ClaudeEngine({ bin: { ok: false, reason: 'missing' }, spawnFn: f.spawnFn, bridge: bridge!, accounts: testRegistry('/h') });
    expect((await drain(missing.runTurn(req()))).at(-1)).toMatchObject({ kind: 'result', ok: false, errorText: CLAUDE_MISSING_TEXT });
    const old = new ClaudeEngine({ bin: { ok: false, reason: 'too_old', bin: '/x/claude', version: '2.0.1' }, spawnFn: f.spawnFn, bridge: bridge!, accounts: testRegistry('/h') });
    expect((await drain(old.runTurn(req()))).at(-1)).toMatchObject({ ok: false, errorText: claudeTooOldText('2.0.1') });
    expect(f.state.calls).toBe(0);
  });

  it('abort: SIGINT, the CLI\'s interrupted result is reported as 중단됨 / aborted, the child is stopped', async () => {
    const ac = new AbortController();
    const { f, engine } = await setup({}, { onSignal: (_sig, ctl) => ctl.push({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1', errors: ['interrupted'] }) });
    f.push(cli.init('s1'), cli.delta('par'));
    const evs: EngineEvent[] = [];
    for await (const e of engine.runTurn(req({ signal: ac.signal }))) { evs.push(e); if (e.kind === 'delta') ac.abort(); }
    expect(f.state.signals[0]).toBe('SIGINT');
    expect(evs.filter((e) => e.kind === 'result')).toEqual([expect.objectContaining({ ok: false, errorText: '중단됨', terminalReason: 'aborted' })]);
    expect(f.state.inputClosed).toBe(true);
  });

  it('abort before the turn starts: nothing is spawned, no bridge registration is left, one 중단됨 / aborted result', async () => {
    const ac = new AbortController();
    ac.abort();
    const { f, engine } = await setup();
    const evs = await drain(engine.runTurn(req({ signal: ac.signal })));
    expect(f.state.calls).toBe(0);
    expect(f.spawns).toHaveLength(0);
    expect(bridge!.registrations).toBe(0);
    expect(fs.readdirSync(tmp)).toEqual([]); // no per-process dir was created
    expect(evs).toEqual([expect.objectContaining({ kind: 'result', ok: false, errorText: '중단됨', terminalReason: 'aborted' })]);
  });

  it('exit without a result: the exit becomes the failure text, with the stderr tail', async () => {
    const { f, engine } = await setup();
    const it = engine.runTurn(req())[Symbol.asyncIterator]();
    f.push(cli.init('s1'));
    expect((await it.next()).value).toMatchObject({ kind: 'init' });
    f.stderr('boom\n'); // the fake only has a stderr once the child exists
    f.end(1);
    const rest: EngineEvent[] = [];
    for (let x = await it.next(); !x.done; x = await it.next()) rest.push(x.value);
    const r = rest.at(-1)!;
    expect(r).toMatchObject({ kind: 'result', ok: false, errorText: expect.stringContaining('종료 코드 1'), stderr: expect.stringContaining('boom') });
  });

  it('a permission request from the prompt tool reaches onPermission; the answer goes back', async () => {
    const seen: string[] = [];
    const { f, engine } = await setup();
    const it = engine.runTurn(req({ onPermission: async (p) => { seen.push(p.toolName); return 'once'; } }))[Symbol.asyncIterator]();
    f.push(cli.init('s1'));
    expect((await it.next()).value).toMatchObject({ kind: 'init' });
    const reply = await f.ask({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' });
    expect(seen).toEqual(['Bash']);
    expect(reply).toMatchObject({ behavior: 'allow', updatedInput: { command: 'ls' } });
    f.push(cli.result('ok', 's1'));
    for (let r = await it.next(); !r.done; r = await it.next()) { /* drain */ }
  });

  it('setPermissionMode mid-process: the PreToolUse gate refuses edits after a switch to plan; stopTask is not offered', async () => {
    let live: LiveInput | null = null;
    const { f, engine } = await setup();
    const it = engine.runTurn(req({ onLive: (l) => { live = l; } }))[Symbol.asyncIterator]();
    f.push(cli.init('s1'));
    await it.next();
    expect(live!.stopTask).toBeUndefined();
    expect(await live!.setPermissionMode!('plan')).toBe(true);
    const out = await f.hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {}, tool_use_id: 'w1' });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_GATE_MESSAGE } });
    f.push(cli.result('ok', 's1'));
    for (let r = await it.next(); !r.done; r = await it.next()) { /* drain */ }
  });

  it('records what the child wrote as deck\'s own (prompt uuid, assistant uuid and message id)', async () => {
    const { f, engine, owned } = await setup();
    f.push(cli.init('s1'), { type: 'assistant', parent_tool_use_id: null, uuid: 'as-1', message: { id: 'msg_9', content: [] }, session_id: 's1' }, cli.result('a', 's1'));
    await drain(engine.runTurn(req()));
    expect(owned.has(String(f.inputs[0]!.uuid), null)).toBe(true);
    expect(owned.has('as-1', null)).toBe(true);
    expect(owned.has('other', 'msg_9')).toBe(true);
  });

  it('forkAt: resumes a truncated copy with --fork-session; a missing parent transcript fails without spawning', async () => {
    const { f, engine } = await setup();
    const projects = path.join(tmp, 'projects');
    const accounts = { ...testRegistry('/h'), projectsDir: () => projects };
    const cwd = path.join(tmp, 'w');
    fs.mkdirSync(cwd);
    const e2 = new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge: bridge!, accounts, baseEnv: {}, readFile: async () => Buffer.from(''), tmpRoot: tmp });
    void engine;
    expect((await drain(e2.runTurn(req({ cwd, resumeSessionId: 'parent', forkAt: 'a1' })))).at(-1)).toMatchObject({ ok: false, errorText: FORK_SOURCE_MISSING, sessionId: null });
    expect(f.state.calls).toBe(0);
    const dir = path.join(projects, fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'parent.jsonl'), [{ uuid: 'u1', parentUuid: null }, { uuid: 'a1', parentUuid: 'u1' }, { uuid: 'u2', parentUuid: 'a1' }].map((r) => JSON.stringify(r)).join('\n'));
    f.push(cli.init('child'), cli.result('ok', 'child'));
    const evs = await drain(e2.runTurn(req({ cwd, resumeSessionId: 'parent', forkAt: 'a1' })));
    const args = f.spawns[0]!.args;
    expect(argValue(args, '--resume')).toMatch(/parent\.jsonl$/);
    expect(args).toContain('--fork-session');
    expect(evs.find((e) => e.kind === 'result')).toMatchObject({ ok: true, sessionId: 'child' });
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run src/server/engine/ClaudeEngine.cli.test.ts --maxWorkers=4`
Expected: FAIL — the constructor has no `bin`/`spawnFn`; today's engine calls the SDK `query()`.

- [ ] **Step 4: Move the SDK engine aside**

Create `src/server/engine/legacySdkEngine.ts` by moving, character for character, everything in today's `ClaudeEngine.ts` that the CLI engine does not reuse: the SDK `import` line (`query`, `HookInput`, `Options`, `SDKMessage`, `SDKUserMessage`), the remaining imports the moved code uses, `QueryFn`, `PromptInput`, `InputChannel`, `buildOptions`, `buildPrompt` (the Task 2 version on top of `toUserMessage`), and the `ClaudeEngine` class with its `ClaudeEngineOptions` type. Only two names change: the class becomes `export class LegacySdkEngine implements Engine` and its options type becomes `export type LegacySdkEngineOptions`. Imports of the helpers moved in Task 2 point at `./claudeCli/stream` and `./claudeCli/prompt` (not back at `./ClaudeEngine`, which would be circular); `BG_MAX_MS`/`BG_GRACE_MS` are imported from `./ClaudeEngine` (read only inside methods at run time, so this one import cycle is harmless under ESM). Add at the top:

```ts
/**
 * Today's Agent-SDK-driven engine, moved here unchanged so the existing tests and main.ts keep running while the
 * CLI engine lands (Task 8a). Reached only through the ClaudeEngine shim when the options carry no `bin`.
 * Deleted in Task 8c together with the SDK dependency.
 */
```

Run: `npx tsc --noEmit -p .`
Expected: errors only in `ClaudeEngine.ts` (the moved names are now defined twice or missing) — fixed by Step 5.

- [ ] **Step 5: Rewrite the engine**

Add to `texts.ts`:

```ts
import { MIN_CLAUDE_VERSION } from './version';
export const CLAUDE_MISSING_TEXT = 'Claude Code(claude)를 찾지 못했습니다 — 터미널에서 설치하고 로그인한 뒤 deck 을 다시 시작해 주세요';
export const claudeTooOldText = (version: string): string => `Claude Code ${version} 은 너무 오래됐습니다 — ${MIN_CLAUDE_VERSION} 이상으로 업데이트한 뒤 deck 을 다시 시작해 주세요`;
/** = TurnRunner.ABORTED: the UI hides a stopped turn's error when it is exactly this. */
export const ABORTED_TEXT = '중단됨';
```

Replace everything left in `ClaudeEngine.ts` (after Step 4 moved the SDK engine out) from the `import` block through the end of the file, keeping the Task 2 re-exports, with:

```ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountRegistry } from '../../shared/accounts';
import type { Attachment } from '../attachments/AttachmentStore';
import { ZERO_USAGE, contextUsageOf, type ContextUsage } from '../../shared/turn-types';
import type { Engine, EngineEvent, LiveInput, TurnRequest } from './Engine';
import { buildMcpConfig, buildSettings, claudeArgs, claudeEnv, type CliPermissionMode } from './claudeCli/args';
import { MCP_TOOL_TIMEOUT_MS, PermissionBridge } from './claudeCli/bridge';
import { forkCandidates, writeForkSource } from './claudeCli/fork';
import { hookHandler } from './claudeCli/hooks';
import type { CliUserMessage, Rec } from './claudeCli/messages';
import { deckWrites, type OwnedEntries } from './claudeCli/ownedEntries';
import { SessionGrants, permissionHandler, type ModeGate } from './claudeCli/permissions';
import { ClaudeProcess, exitFailureText } from './claudeCli/process';
import { toUserMessage, type ReadFile } from './claudeCli/prompt';
import type { ClaudeSpawnFn } from './claudeCli/spawnTypes';
import { BackgroundTracker, ProgressMeter, ToolTracker, deniedCalls, isActivity, isInjectedNoopResult, mapCliMessage, noteCommands, toolAudit, type CommandsListener } from './claudeCli/stream';
import { ABORTED_TEXT, CLAUDE_MISSING_TEXT, claudeTooOldText } from './claudeCli/texts';
import type { ClaudeBin } from './claudeCli/version';
import { LegacySdkEngine, type LegacySdkEngineOptions } from './legacySdkEngine'; // shim — removed in Task 8c

export { BackgroundTracker, ProgressMeter, isActivity, isInjectedNoopResult, toolAudit, deniedCalls, noteCommands, mapCliMessage, type CommandsListener, type ToolAudit } from './claudeCli/stream';
export { toUserMessage, type ReadFile } from './claudeCli/prompt';
export { NO_TOOLS_MESSAGE, KEEP_PLANNING_MESSAGE } from './claudeCli/texts';
// Kept only so the not-yet-migrated tests compile; both lines are deleted in Task 8b Step 3.
export { mapCliMessage as mapSdkMessage } from './claudeCli/stream';
export { buildOptions, buildPrompt, type QueryFn, type LegacySdkEngineOptions } from './legacySdkEngine';

/** The longest a process is kept open for background tasks after its turn (then they are cut). */
export const BG_MAX_MS = 2 * 60 * 60_000;
/** How long an emptied background set may stay idle before the process is closed. */
export const BG_GRACE_MS = 60_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_RELAY = path.join(HERE, 'claudeCli', 'hookRelay.ts');
const PERMISSION_MCP = path.join(HERE, 'claudeCli', 'permissionMcp.ts');

export type ClaudeEngineOptions = {
  bin: ClaudeBin | string;
  spawnFn?: ClaudeSpawnFn;
  bridge?: PermissionBridge;
  accounts: Pick<AccountRegistry, 'env' | 'projectsDir'>;
  baseEnv?: NodeJS.ProcessEnv;
  readFile?: ReadFile;
  bgMaxMs?: number;
  bgGraceMs?: number;
  onCommands?: CommandsListener;
  steer?: boolean;
  killGraceMs?: number;
  owned?: OwnedEntries;
  node?: string;
  tmpRoot?: string;
};

class CliClaudeEngine implements Engine {
  private readonly bin: ClaudeBin;
  private readonly o: ClaudeEngineOptions;
  private readonly readFile: ReadFile;
  private readonly owned: OwnedEntries;
  private bridgeP: Promise<PermissionBridge> | null;

  constructor(opts: ClaudeEngineOptions) {
    this.o = opts;
    this.bin = typeof opts.bin === 'string' ? { ok: true, bin: opts.bin, version: '', belowRecommended: false } : opts.bin;
    this.readFile = opts.readFile ?? ((p) => fs.readFile(p));
    this.owned = opts.owned ?? deckWrites;
    this.bridgeP = opts.bridge ? Promise.resolve(opts.bridge) : null;
  }

  private bridge(): Promise<PermissionBridge> {
    return (this.bridgeP ??= PermissionBridge.open());
  }

  async close(): Promise<void> {
    if (this.bridgeP && !this.o.bridge) await (await this.bridgeP).close();
  }

  /**
   * One deck turn = one `claude -p` child in stream-json input mode. Its stdin stays open after a result while
   * background tasks are live: when one settles, the CLI injects its notification and runs another turn by itself
   * (yielded as `continue` + that turn's events + its result), and `onLive().send` can add user messages. Stdin
   * closes — and the child ends — after a result with no live background task and no unanswered message, after an
   * emptied set stays idle for `bgGraceMs`, after `bgMaxMs` (the child is terminated), or on abort (SIGINT).
   */
  async *runTurn(req: TurnRequest): AsyncIterable<EngineEvent> {
    // A fork gets its own id from init; the parent's id must never be reported as the turn's session.
    let sessionId: string | null = req.forkAt ? null : req.resumeSessionId;
    const fail = (errorText: string, terminalReason: string | null = null, stderr: string | null = null): EngineEvent =>
      ({ kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText, stderr, errorKind: null, terminalReason });
    // Review M2: an interrupt that landed before the turn started must not spawn the CLI at all.
    if (req.signal.aborted) { yield fail(ABORTED_TEXT, 'aborted'); return; }
    if (!this.bin.ok) { yield fail(this.bin.reason === 'too_old' ? claudeTooOldText(this.bin.version) : CLAUDE_MISSING_TEXT); return; }

    const procDir = await fs.mkdtemp(path.join(this.o.tmpRoot ?? os.tmpdir(), 'qd-claude-'));
    await fs.chmod(procDir, 0o700);
    const audit = toolAudit(req);
    const tracker = new ToolTracker(audit);
    const startMode: CliPermissionMode = req.permissionMode ?? 'default';
    const gate: ModeGate = { mode: startMode, startedIn: startMode };
    const reg = (await this.bridge()).register({
      permission: permissionHandler(req, audit, gate, new SessionGrants()),
      hook: hookHandler(req, audit, gate),
    });
    let proc: ClaudeProcess | null = null;
    let aborted = false;
    const onAbort = () => { aborted = true; reg.abortAll(); proc?.interrupt(); };
    req.signal.addEventListener('abort', onAbort, { once: true });
    let capTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    try {
      const relay = { node: this.o.node ?? process.execPath, script: HOOK_RELAY, socketPath: reg.socketPath, token: reg.token };
      const settingsPath = path.join(procDir, 'settings.json');
      const mcpConfigPath = path.join(procDir, 'mcp.json');
      await fs.writeFile(settingsPath, JSON.stringify(buildSettings({ ...(req.allowRules?.length ? { allowRules: req.allowRules } : {}), ...(req.noTools ? { noTools: true } : {}), ...(req.systemNote ? { systemNote: req.systemNote } : {}), relay })), { mode: 0o600 });
      await fs.writeFile(mcpConfigPath, JSON.stringify(buildMcpConfig({ node: relay.node, script: PERMISSION_MCP, socketPath: reg.socketPath, token: reg.token })), { mode: 0o600 });

      let resume = req.resumeSessionId ?? undefined;
      let forkSession = false;
      if (req.forkAt && req.resumeSessionId) {
        const src = await writeForkSource({ candidates: forkCandidates(this.o.accounts.projectsDir(req.account), req.cwd, req.resumeSessionId), at: req.forkAt, dir: procDir, sessionId: req.resumeSessionId });
        if (!src.ok) { yield fail(src.text); return; }
        resume = src.path;
        forkSession = true;
      }
      const args = claudeArgs({
        model: req.model, ...(req.effort ? { effort: req.effort } : {}), permissionMode: startMode,
        settingsPath, mcpConfigPath, ...(req.allowDirs?.length ? { addDirs: req.allowDirs } : {}),
        ...(resume !== undefined ? { resume, forkSession } : { sessionId: randomUUID() }),
      });
      const env = claudeEnv(this.o.accounts.env(req.account, this.o.baseEnv ?? process.env), MCP_TOOL_TIMEOUT_MS);
      const p = new ClaudeProcess({ bin: this.bin.bin, args, cwd: req.cwd, env, ...(this.o.spawnFn ? { spawnFn: this.o.spawnFn } : {}), ...(this.o.killGraceMs !== undefined ? { killGraceMs: this.o.killGraceMs } : {}) });
      proc = p;

      // ---- the loop below is today's runTurn body; only the marked lines differ ----
      let errorKind: string | null = null;
      let sawResult = false;
      let lastCtx: ContextUsage | null = null;
      const bg = new BackgroundTracker();
      const meter = new ProgressMeter();
      let shownTasks: string[] = [];
      let shownSig = '[]';
      const unanswered: string[] = [];
      const steers = new Map<string, string>();
      let echoed: string[] = [];
      let namesAnswers = false;
      const answer = (ids: Iterable<string>) => { for (const id of ids) { const i = unanswered.indexOf(id); if (i >= 0) unanswered.splice(i, 1); } };
      let idle = false;
      let ended: 'cap' | 'grace' | null = null;
      // changed: cap kills (tasks are still running), grace only closes stdin (nothing is running).
      const finish = (why: 'cap' | 'grace') => { if (!p.inputOpen || ended) return; ended = why; if (why === 'cap') p.terminate(); else p.stop(); };
      const clearGrace = () => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } };
      const armGrace = () => {
        clearGrace();
        if (!idle || unanswered.length > 0 || bg.tasks().length > 0) return;
        graceTimer = setTimeout(() => finish('grace'), this.o.bgGraceMs ?? BG_GRACE_MS);
        graceTimer.unref?.();
      };
      const toolInputs = new Map<string, unknown>();
      const writeMsg = (m: CliUserMessage): boolean => { if (typeof m.uuid === 'string') this.owned.add(m.uuid); return p.write(m); }; // changed
      const write = async (f: { text: string; attachments: Attachment[] }, steerId: string | null): Promise<boolean> => {
        if (!p.inputOpen || aborted) return false; // changed
        const uuid = randomUUID();
        unanswered.push(uuid);
        if (steerId !== null) steers.set(uuid, steerId);
        idle = false;
        clearGrace();
        const undo = () => { answer([uuid]); steers.delete(uuid); idle = unanswered.length === 0; armGrace(); };
        let m: CliUserMessage;
        try {
          m = await toUserMessage(f.text, f.attachments, this.readFile);
        } catch (err) {
          undo();
          throw err;
        }
        if (!writeMsg({ ...m, uuid, ...(steerId !== null ? { priority: 'next' as const } : {}) })) { undo(); return false; }
        return true;
      };
      // changed: no stopTask (control protocol only); the mode switch goes through deck's PreToolUse gate.
      const live: LiveInput = {
        send: (f) => write(f, null),
        steer: (f, id) => write(f, id),
        setPermissionMode: async (mode) => {
          if (!p.inputOpen) return false;
          gate.mode = mode;
          return true;
        },
      };
      const first = randomUUID();
      unanswered.push(first);
      const firstMsg = { ...(await toUserMessage(req.prompt, req.attachments ?? [], this.readFile)), uuid: first };
      p.start(); // changed
      writeMsg(firstMsg); // changed
      if (req.signal.aborted) onAbort();
      if (this.o.steer === false || req.noTools) delete live.steer;
      req.onLive?.(live);
      for await (const m of p.messages()) { // changed
        if (ended) break; // changed: what arrives after cap/grace is the dying child's
        this.owned.note(m); // changed
        await tracker.apply(m); // changed: replaces PostToolUse/PostToolUseFailure
        if (isInjectedNoopResult(m) && unanswered.length > 0) {
          const r = m as unknown as Rec;
          if (r.subtype !== 'success' || r.is_error === true) console.warn(`deck: CLI-injected turn failed (not ours): ${[r.subtype, ...(Array.isArray(r.errors) ? r.errors : [])].join(': ')}`);
          continue;
        }
        if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use' && typeof b.id === 'string') toolInputs.set(b.id, b.input);
        for (const d of deniedCalls(m, toolInputs)) await audit.report(d, 'deny', d.source);
        if (m.type === 'result') toolInputs.clear();
        if (bg.apply(m)) {
          const tasks = bg.tasks();
          const detail = bg.detail();
          const sig = JSON.stringify(detail.map((t) => [t.id, t.description, t.type]));
          if (sig !== shownSig) { shownSig = sig; shownTasks = tasks; yield { kind: 'background', tasks, detail }; }
          armGrace();
        }
        if (idle && isActivity(m)) { idle = false; clearGrace(); yield { kind: 'continue', cause: 'background' }; }
        const prog = meter.apply(m);
        if (prog) yield { kind: 'progress', ...prog };
        if (m.type === 'assistant' && m.parent_tool_use_id === null) lastCtx = contextUsageOf(m.message.usage) ?? lastCtx;
        if (m.type === 'assistant' && typeof m.error === 'string') errorKind = m.error;
        if (this.o.onCommands) noteCommands(m, req.cwd, this.o.onCommands);
        if (m.type === 'user' && m.isReplay === true && typeof m.uuid === 'string') {
          const id = steers.get(m.uuid);
          if (id !== undefined) { steers.delete(m.uuid); echoed.push(m.uuid); yield { kind: 'steer_delivered', id }; }
        }
        let gotResult = false;
        for (const ev of mapCliMessage(m)) {
          if (ev.kind === 'init') sessionId = ev.sessionId;
          if (ev.kind !== 'result') { yield ev; continue; }
          sawResult = true;
          gotResult = true;
          // changed: the interrupted turn's result, however the CLI words it, is a stop.
          if (aborted) { yield { ...ev, ok: false, text: '', errorText: ABORTED_TEXT, stderr: null, terminalReason: 'aborted' }; break; }
          const r = m as unknown as Rec;
          const ids = Array.isArray(r.user_message_uuids) ? (r.user_message_uuids as unknown[]).filter((x): x is string => typeof x === 'string')
            : typeof r.user_message_uuid === 'string' ? [r.user_message_uuid] : null;
          if (ids) namesAnswers = true;
          if (ids && ids.length && ids.some((u) => unanswered.includes(u))) {
            for (const u of ids) {
              const id = steers.get(u);
              if (id !== undefined) { steers.delete(u); yield { kind: 'steer_delivered', id }; }
            }
            answer(ids);
          } else if (ids && ids.length) {
            console.warn('deck: result answers no message written to this process', { session: sessionId, ids, unanswered: unanswered.length });
            answer([...unanswered.slice(0, 1), ...echoed]);
          } else if (!namesAnswers || !ev.ok) {
            answer([...unanswered.slice(0, 1), ...echoed]);
          }
          echoed = [];
          yield { ...ev, ...(lastCtx ? { usage: { ...ev.usage, context: lastCtx } } : {}), errorKind: ev.errorKind ?? errorKind, stderr: ev.ok ? null : p.stderrTail || null }; // changed: stderr from the child
          errorKind = null;
          lastCtx = null;
          meter.reset();
        }
        if (!gotResult) continue;
        if (aborted) break; // changed
        if (unanswered.length === 0 && bg.tasks().length === 0) break;
        idle = unanswered.length === 0;
        if (!capTimer) { capTimer = setTimeout(() => finish('cap'), this.o.bgMaxMs ?? BG_MAX_MS); capTimer.unref?.(); }
        armGrace();
      }
      // changed: the SDK threw on a dead process; the child's exit is read instead.
      p.stop();
      const exit = await p.exited;
      if (!sawResult) yield aborted ? fail(ABORTED_TEXT, 'aborted') : { ...(fail(exitFailureText(exit), null, p.stderrTail || null) as Extract<EngineEvent, { kind: 'result' }>), errorKind };
      if (ended === 'cap') {
        const minutes = Math.round((this.o.bgMaxMs ?? BG_MAX_MS) / 60_000);
        yield { kind: 'notice', message: `백그라운드 작업이 ${minutes}분 안에 끝나지 않아 프로세스를 종료했습니다` };
        yield { kind: 'bg_cap', tasks: shownTasks.length ? [...shownTasks] : bg.tasks(), minutes };
      }
      if (shownTasks.length) yield { kind: 'background', tasks: [], detail: [] };
    } finally {
      if (capTimer) clearTimeout(capTimer);
      if (graceTimer) clearTimeout(graceTimer);
      req.signal.removeEventListener('abort', onAbort);
      // A consumer that stopped reading early must not leave the child behind.
      if (proc && proc.exit === null) proc.terminate();
      reg.dispose();
      await fs.rm(procDir, { recursive: true, force: true });
    }
  }
}

/**
 * Shim until Task 8c. Options with `bin` (the new test, and main.ts from Task 8c) run the CLI engine; options
 * without it (every pre-existing test, which passes `queryFn`, and today's main.ts) run the moved SDK engine
 * unchanged. Task 8c deletes this class and renames CliClaudeEngine to ClaudeEngine.
 */
export class ClaudeEngine implements Engine {
  private readonly impl: CliClaudeEngine | LegacySdkEngine;
  constructor(opts: ClaudeEngineOptions | LegacySdkEngineOptions) {
    this.impl = 'bin' in opts ? new CliClaudeEngine(opts) : new LegacySdkEngine(opts);
  }
  runTurn(req: TurnRequest): AsyncIterable<EngineEvent> {
    return this.impl.runTurn(req);
  }
  async close(): Promise<void> {
    if (this.impl instanceof CliClaudeEngine) await this.impl.close();
  }
}
```

Notes for the implementer:
- `home` is not in `ClaudeEngineOptions` (it only fed the SDK's env); `LegacySdkEngineOptions` keeps it until Task 8c, where `home: cfg.home` is dropped from `main.ts`. Migrated tests drop `home:` in Task 8b.
- The `yield fail(src.text)` inside `try` returns through `finally`, so the temp dir and the registration are cleaned up.
- The `ClaudeEngine.ts` re-exports (`toolAudit`, `mapCliMessage`, …) exist so the migrated tests import from one place; nothing else in `src/server` imports the moved names from `ClaudeEngine.ts` after Task 8b (check with `grep -rn "from './ClaudeEngine'" src/server`).
- `'bin' in opts` is the only discriminator the shim needs: `LegacySdkEngineOptions` has no `bin` field, and every `ClaudeEngineOptions` has one.

- [ ] **Step 6: Run the new engine test and see it pass**

Run: `npx vitest run src/server/engine/ClaudeEngine.cli.test.ts --maxWorkers=4`
Expected: PASS (11 tests).

- [ ] **Step 7: Run the untouched suites and see them still pass through the shim**

Run: `npx vitest run src/server/engine src/server/turn src/server/ws.activity.test.ts src/server/ws.background.test.ts src/server/ws.bottleneck.test.ts src/server/ws.newSession.test.ts src/server/ws.outside.test.ts src/server/ws.status.test.ts --maxWorkers=4` and `npx tsc --noEmit -p .`
Expected: PASS, no type errors. None of these files changed in this task; they construct `ClaudeEngine` with `queryFn` and no `bin`, so they run on `LegacySdkEngine` exactly as before. A failure here means Step 4 changed more than the two names — diff `legacySdkEngine.ts` against the pre-task `ClaudeEngine.ts` (`git show HEAD:src/server/engine/ClaudeEngine.ts`).

- [ ] **Step 8: Hygiene**

Run: `npx vitest run src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=4`
Expected: PASS.

- [ ] **Step 9 (conditional on spike D9): hide the bridge tool from the model**

If `fixtures/self-call.meta.json` shows the tool in init `tools` **and** `fixtures/permission-allow-disallowed.meta.json` shows the prompt tool still answered (`calls.length === 1`), add `'--disallowedTools', PERMISSION_TOOL` to `claudeArgs` after `--permission-prompt-tool`, with an `args.test.ts` case asserting it, and re-run `npx vitest run src/server/engine/claudeCli/args.test.ts --maxWorkers=4`. Otherwise leave argv as is; `SELF_CALL_MESSAGE` (Task 4) already denies a direct call, and "the bridge tool is visible to the model" stays in Lost or changed features.

- [ ] **Step 10: Commit**

```bash
git add src/server/engine/ClaudeEngine.ts src/server/engine/legacySdkEngine.ts src/server/engine/ClaudeEngine.cli.test.ts src/server/engine/claudeCli/texts.ts src/server/engine/claudeCli/fakeClaudeCli.ts src/server/engine/claudeCli/args.ts src/server/engine/claudeCli/args.test.ts
git commit -m "feat(claude-engine): claude CLI 엔진 추가 — 기존 SDK 엔진은 bin 없는 옵션용 임시 경로로 유지"
```

---

### Task 8b: Migrate the old engine tests to the fake CLI, delete `fakeSdk.ts`

Every test that drives `ClaudeEngine` moves from `fakeSdk`/`queryFn` to `fakeClaudeCli`/`spawnFn` + `bin: 'claude'`, so it exercises `CliClaudeEngine` through the shim. Production is untouched: `main.ts` still builds the engine without `bin` until Task 8c.

**Files:**
- Modify (migration): `src/server/engine/ClaudeEngine.test.ts`, `ClaudeEngine.activity.test.ts`, `ClaudeEngine.background.test.ts`, `ClaudeEngine.fork.test.ts`, `ClaudeEngine.handoff.test.ts`, `ClaudeEngine.uuids.test.ts`, `thinking.test.ts`, `slashCommands.test.ts`, `src/server/turn/TurnRunner.background.test.ts`, `TurnRunner.steer.test.ts`, `src/server/ws.activity.test.ts`, `ws.background.test.ts`, `ws.bottleneck.test.ts`, `ws.newSession.test.ts`, `ws.outside.test.ts`, `ws.status.test.ts`
- Modify: `src/server/engine/ClaudeEngine.ts` (drop the two test-only re-export lines)
- Delete: `src/server/engine/fakeSdk.ts`

**Interfaces:**
- Consumes: `ClaudeEngine` shim, `ClaudeEngineOptions`, `fakeClaudeCli` with `spawns[i].files` (Task 8a).
- Produces: nothing new; after this task no test references `queryFn`, `QueryFn`, `fakeSdk`, `sdk.*`, `buildOptions`, `buildPrompt` or `mapSdkMessage`.

- [ ] **Step 1: Migrate the tests**

Mechanical rules, applied to every file in the Files list:

| Old | New |
|---|---|
| `import { fakeSdk, sdk } from './fakeSdk'` (or `../engine/fakeSdk`) | `import { fakeClaudeCli, cli, argValue } from './claudeCli/fakeClaudeCli'` (adjust the relative path) |
| `const f = fakeSdk()` / `sdk.x(...)` | `const f = fakeClaudeCli()` / `cli.x(...)` |
| `new ClaudeEngine({ …, queryFn: f.queryFn, … })` or `queryFn: (p) => f.queryFn(p)` | `new ClaudeEngine({ …, bin: 'claude', spawnFn: f.spawnFn, … })` |
| a `queryFn` wrapper that captures `p.options` | read `f.spawns[i]` instead: `argValue(args, '--model')`, `--permission-mode`, `--effort`, `--resume`, `--add-dir` (all occurrences: `args.filter((a) => a.startsWith('--add-dir='))`), `f.spawns[i].files.settings.permissions.allow`, `.hooks` |
| `options.cwd` / `options.env` | `f.spawns[i].cwd` / `f.spawns[i].env` |
| `'Claude Code process aborted by user'` expected from the engine | `'중단됨'` with `terminalReason: 'aborted'` |
| `f.stopped`, `live.stopTask(...)` expectations | `expect(live.stopTask).toBeUndefined()`; delete the stop-one-task assertions (feature lost, see below) |
| `buildOptions(...)` assertions on `canUseTool` | already covered by `permissions.test.ts` (Task 4): delete |
| `buildOptions(...)` assertions on `hooks.PreToolUse` / `UserPromptSubmit` | `hooks.test.ts` (Task 5) covers the handler; keep one engine-level check: `f.spawns[0].files.settings.hooks.UserPromptSubmit` exists iff `systemNote` is set |
| `buildOptions(...)` assertions on `PostToolUse` / `PostToolUseFailure` / `PermissionDenied` | `ToolTracker` tests in `stream.test.ts` (Task 5): delete |
| `buildOptions(...)` `extraArgs['replay-user-messages']` with `steer: false` | `--replay-user-messages` is always present; assert `live.steer` is absent with `steer: false` instead |
| `buildPrompt(...)` | `toUserMessage(...)` from `./claudeCli/prompt` (string content when there are no images) |
| `fork.test.ts` `resumeSessionAt` assertions | replaced by the fork cases in `ClaudeEngine.cli.test.ts`; keep "the fork reports the id the CLI gives it" rewritten on the new engine with a parent transcript written into a temp `projectsDir` (as in Task 8a Step 2) |
| tests that never push a result and rely on `f.end()` | unchanged: `end()` before spawn is queued (Task 8a Step 1) |
| `import { ClaudeEngine, type QueryFn } from './engine/ClaudeEngine'` — `src/server/ws.activity.test.ts:9`, `src/server/ws.outside.test.ts:10`, `src/server/ws.status.test.ts:9` | `import { ClaudeEngine } from './engine/ClaudeEngine'` plus `import { fakeClaudeCli, cli } from './engine/claudeCli/fakeClaudeCli'`; delete the module-level `const queryFn: QueryFn = (p) => fake.queryFn(p);` (lines 34 / 39 / 27) and pass `bin: 'claude', spawnFn: fake.spawnFn` instead of `queryFn` in the `new ClaudeEngine({ … })` inside the `TurnRunner` options (lines 46 / 51 / 41). Where a test closes over `p.options` (a wrapper of the form `(p) => { seen = p.options; return fake.queryFn(p); }`), read the same facts after the turn from `fake.spawns[i].files.settings` (`permissions.allow`, `hooks`) and `fake.spawns[i].args` via `argValue` (add `argValue` to the import then) |

Because the child is now a stream that ends on exit, a test that previously left the fake stream open until `end()` while asserting "input still open" must assert `f.state.inputClosed === false` *before* pushing the final result, exactly as today.

TurnRunner tests that use `StubEngine` (not `fakeSdk`) and expect `'Claude Code process aborted by user'` from a stub stay unchanged — the text there is the stub's own.

- [ ] **Step 2: Run the migrated suites and see them pass**

Run: `npx vitest run src/server/engine src/server/turn src/server/ws.activity.test.ts src/server/ws.background.test.ts src/server/ws.bottleneck.test.ts src/server/ws.newSession.test.ts src/server/ws.outside.test.ts src/server/ws.status.test.ts --maxWorkers=4`
Expected: PASS. Any failure is a migration slip (compare the old assertion with the table) or a real behaviour difference; a real difference goes into "Lost or changed features" with the assertion changed to the new behaviour, never silently deleted.

- [ ] **Step 3: Drop the test-only re-exports and delete the SDK fake**

In `ClaudeEngine.ts` delete the two lines under `// Kept only so the not-yet-migrated tests compile; …` (the `mapSdkMessage` alias and the `buildOptions, buildPrompt, QueryFn, LegacySdkEngineOptions` re-export). Then:

```bash
git rm src/server/engine/fakeSdk.ts
```

Run: `grep -rn "fakeSdk\|queryFn\|QueryFn\|mapSdkMessage\|buildOptions\|buildPrompt" src --include='*.ts' --include='*.tsx' | grep -v 'src/server/engine/legacySdkEngine.ts'`
Expected: exactly one hit, the comment at `src/server/turn/TurnRunner.test.ts:412` (`captured on account b with deck's buildOptions` — prose, not a reference; leave it). The SDK engine itself, which Task 8c deletes, is excluded by the second `grep`.

Run: `npx tsc --noEmit -p .` and `npx vitest run src/server src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=4`
Expected: no type errors; PASS.

- [ ] **Step 4: Commit**

```bash
git add -A src/server/engine src/server/turn src/server/ws.activity.test.ts src/server/ws.background.test.ts src/server/ws.bottleneck.test.ts src/server/ws.newSession.test.ts src/server/ws.outside.test.ts src/server/ws.status.test.ts
git commit -m "test(claude-engine): 엔진 테스트를 fake claude CLI 로 이전하고 fakeSdk 삭제"
```

---

### Task 8c: Remove the SDK, guard test, startup wiring

The production switch: `main.ts` builds the engine with `bin: cfg.claudeBin`, the shim and `LegacySdkEngine` are deleted, and `@anthropic-ai/claude-agent-sdk` leaves `package.json`.

**Files:**
- Create: `src/server/engine/claudeCli/noSdk.test.ts`
- Delete: `src/server/engine/legacySdkEngine.ts`
- Modify: `src/server/engine/ClaudeEngine.ts` (delete the shim, rename `CliClaudeEngine` → `ClaudeEngine`)
- Modify: `src/hygiene.private.test.ts` (line 73 example), `package.json`, `package-lock.json`
- Modify: `src/server/config.ts` (`claudeBin`), `src/server/config.test.ts`, `src/server/main.ts` (engine options, startup log, shutdown)

**Interfaces:**
- Consumes: `CliClaudeEngine`, `ClaudeEngineOptions` (Task 8a); `resolveClaudeBin`, `ClaudeBin`, `MIN_CLAUDE_VERSION`, `RECOMMENDED_CLAUDE_VERSION` (Task 1).
- Produces:
  ```ts
  // ClaudeEngine.ts — the shim is gone; the CLI engine takes the public name
  export class ClaudeEngine implements Engine {
    constructor(opts: ClaudeEngineOptions);
    runTurn(req: TurnRequest): AsyncIterable<EngineEvent>;
    /** Closes the bridge (server shutdown). */
    close(): Promise<void>;
  }
  // config.ts
  claudeBin: ClaudeBin;   // new DeckConfig field
  ```

- [ ] **Step 1: Write the failing SDK guard**

```ts
// src/server/engine/claudeCli/noSdk.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Built by concatenation so this file does not match its own scan.
const PKG = ['@anthropic-ai', 'claude-agent-sdk'].join('/');
const ROOT = path.resolve(__dirname, '../../../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') sources(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('the Agent SDK is gone', () => {
  it('no source file imports it', () => {
    const hits = sources(path.join(ROOT, 'src')).filter((f) => new RegExp(`from ['"]${PKG}`).test(fs.readFileSync(f, 'utf8')));
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
  it('package.json does not depend on it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) expect(Object.keys(pkg[k] ?? {})).not.toContain(PKG);
  });
});
```

Run: `npx vitest run src/server/engine/claudeCli/noSdk.test.ts --maxWorkers=4`
Expected: FAIL on `package.json` and on `src/server/engine/legacySdkEngine.ts`.

- [ ] **Step 2: Delete the shim and the SDK engine**

In `ClaudeEngine.ts`: delete the `import { LegacySdkEngine, type LegacySdkEngineOptions } from './legacySdkEngine';` line and the whole shim (the doc comment `Shim until Task 8c …` and `export class ClaudeEngine` below it), then rename `class CliClaudeEngine implements Engine` to `export class ClaudeEngine implements Engine`. Then:

```bash
git rm src/server/engine/legacySdkEngine.ts
```

- [ ] **Step 3: Startup wiring**

`src/server/config.ts`: add to the config type

```ts
  /** The user's own `claude` (version-gated). Not ok = Claude turns fail with a Korean hint; the rest of deck runs. */
  claudeBin: ClaudeBin;
```

and to the returned object, next to `codexBin`:

```ts
    claudeBin: resolveClaudeBin(env, home),
```

with `import { resolveClaudeBin, type ClaudeBin } from './engine/claudeCli/version';`. In `src/server/config.test.ts`, add one case: with `DECK_CLAUDE_BIN` pointing at a temp script that prints `2.1.283 (Claude Code)`, `loadConfig(...).claudeBin` is `{ ok: true, bin: <script>, version: '2.1.283', belowRecommended: false }` (use the existing test's `loadConfig` call shape).

`src/server/main.ts` (today the engine is built inline at line 94; hoist it to a `const` declared just before the object that line belongs to, and import `type ClaudeBin`, `MIN_CLAUDE_VERSION`, `RECOMMENDED_CLAUDE_VERSION` from `./engine/claudeCli/version`):

```ts
const claude = new ClaudeEngine({ bin: cfg.claudeBin, accounts, bgMaxMs: cfg.bgMaxMs, steer: cfg.steer, onCommands: (sessionId, cwd, list, terminal) => commands.record(sessionId, cwd, list, terminal) });
// in the TurnRunner options:
    engine: claude,
```

Startup log (line 152) gains `· claude ${claudeLabel(cfg.claudeBin)}` with

```ts
const claudeLabel = (b: ClaudeBin) => (b.ok ? `${b.version}${b.belowRecommended ? ` (${RECOMMENDED_CLAUDE_VERSION} 이상 권장)` : ''}` : b.reason === 'too_old' ? `${b.version} (너무 오래됨 — ${MIN_CLAUDE_VERSION} 이상 필요)` : '없음');
```

and `shutdown` adds `void claude.close();` next to `ws.close()`.

- [ ] **Step 4: Remove the SDK dependency**

```bash
npm uninstall @anthropic-ai/claude-agent-sdk
```

`npm uninstall` edits `package.json` and `package-lock.json` only (no network needed to remove). In `src/hygiene.private.test.ts` line 73 change the example to another scoped package: `['an npm scope', '@types/node'],`. In `src/server/sessions/ProcessHolders.test.ts` the `SDK` constant is a `ps` row string, not an import; leave it (the guard only matches `from '…'`).

- [ ] **Step 5: Run the guard, config, hygiene and type check**

Run: `npx vitest run src/server/engine/claudeCli/noSdk.test.ts src/server/config.test.ts src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=4` and `npx tsc --noEmit -p .`
Expected: PASS, no type errors. A type error in `main.ts` about `home` or a missing `bin` means Step 3 was skipped: with the shim gone, `ClaudeEngineOptions` is the only accepted shape.

Run: `npx vitest run src/server --maxWorkers=4`
Expected: PASS (all engine tests already run on the CLI engine since Task 8b).

- [ ] **Step 6: Commit**

```bash
git add -A src/server/engine src/server/config.ts src/server/config.test.ts src/server/main.ts src/hygiene.private.test.ts package.json package-lock.json
git commit -m "feat(claude-engine): Agent SDK 대신 설치된 claude CLI 를 자식 프로세스로 실행"
```

---

### Task 9: Whole-repo verification

No new code. Every command is read-only with respect to the running server: no `npm run restart`, no signal to the running deck, no `dist` changes — so no `vite build` (its `outDir` is `dist/ui`).

**Files:** none (fixes found here go back into the task that owns the file, with that task's test re-run).

**Interfaces:** none.

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit -p .`
Expected: no output, exit 0. `allowImportingTsExtensions` (Task 5) is accepted because `noEmit` is already true.

- [ ] **Step 2: Server and shared tests**

Run: `npx vitest run src/server src/shared --maxWorkers=4`
Expected: PASS. No test file imports `fakeSdk` (it no longer exists — an import would fail to resolve).

- [ ] **Step 3: UI tests**

Run: `npx vitest run src/ui --maxWorkers=4`
Expected: PASS, unchanged. The UI already hides the stop-task button when `stopTask` is absent; no UI test depends on the engine.

- [ ] **Step 4: Hygiene and SDK guard**

Run: `npx vitest run src/hygiene.test.ts src/hygiene.private.test.ts src/server/engine/claudeCli/noSdk.test.ts --maxWorkers=4`
Expected: PASS (all committed fixtures scrubbed; no SDK import or dependency).

Run: `grep -rn "claude-agent-sdk" src package.json package-lock.json`
Expected: no output. `node_modules` may still hold the package until the next `npm ci`; nothing loads it.

- [ ] **Step 5: The child scripts run under plain node**

Run: `DECK_BRIDGE_TOKEN=x node --disable-warning=ExperimentalWarning src/server/engine/claudeCli/hookRelay.ts --sock /nonexistent.sock --fail deny < /dev/null; echo "exit $?"`
Expected: one JSON line with `"permissionDecision":"deny"` and `HOOK_RELAY_FAILED_MESSAGE`, then `exit 0` (fail-deny path, no tsx needed).

Run: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' | DECK_BRIDGE_SOCK=/nonexistent.sock DECK_BRIDGE_TOKEN=x node --disable-warning=ExperimentalWarning src/server/engine/claudeCli/permissionMcp.ts`
Expected: one JSON-RPC reply with `serverInfo.name` `deck_bridge`; the process exits when stdin ends.

- [ ] **Step 6: UI compile check without a build**

`npx vite build` is not run: it writes `dist/ui`, which this plan must not touch. Step 1's `tsc --noEmit -p .` already type-checks `src/ui` against the changed shared types, and the server is not bundled (it runs from `src` through tsx). Record in the report that the build was skipped for this reason.

- [ ] **Step 7: Manual smoke (by the user, after merge, outside this plan)**

Not run by the implementer: restarting deck is the user's decision. The checklist handed over: a new Claude session answers; an edit asks with a permission card and "이 세션" stops the repeat ask; abort shows 중단됨; a background `sleep` reports its completion; editing an earlier message forks; a `claude --resume` of the same session in a terminal shows as an outside write in deck.

No commit (nothing changed). If any step required a fix, that fix was committed in its own task's commit step.

---

## Lost or changed features

| Feature | Before (SDK) | After (CLI child) | Why |
|---|---|---|---|
| Stop one background task (`LiveInput.stopTask`) | `Query.stopTask` | **Lost.** `stopTask` is absent; the UI hides the button. Stopping the whole turn still works (SIGINT). | Only reachable through the stdin control protocol, which this plan does not use. |
| Mid-process permission-mode change (`setPermissionMode`) | `Query.setPermissionMode`, enforced by the CLI | **Changed.** deck's PreToolUse gate (`ModeGate`) enforces the new mode for edit tools from the next tool call: plan → edits denied with `PLAN_GATE_MESSAGE`; acceptEdits → edits allowed; back to default → asked. Leaving plan mode in the middle of a turn that started in plan is only fully effective from the next turn (the CLI itself still believes it is in plan). The gate's matcher is `EDIT_TOOL_MATCHER` (edit tools only): **Bash and MCP tools are not restricted by deck** after a mid-process switch to plan — they still go through the CLI's own permission flow for the mode the process started in (a process started in default asks for them through the prompt tool; one started in acceptEdits/bypass does whatever that mode allows). A switch to plan therefore stops file edits at once but not shell commands until the next turn. | Control protocol only; widening the matcher to Bash would deny read-only commands the CLI's plan mode allows. |
| Fork at a message (`resumeSessionAt`) | SDK option | **Redesigned**: a truncated copy of the parent transcript (chain up to the message) in the per-process temp dir, then `--resume=<path> --fork-session`. If spike F1 fails, editing an earlier message falls back to `FORK_AT_UNSUPPORTED` (the edit is refused with a Korean message) — lost. | Not in the CLI. |
| Permission card fields `title`, `decisionReason`, `blockedPath`, `defaultToNo`, `suppressAlwaysAllowRule` | From `canUseTool` options | **Lost**: the prompt tool receives only `tool_name`, `input`, `tool_use_id` (and `permission_suggestions` if spike D3 shows it). The card shows the tool and its input. | Not passed to the prompt tool. |
| "Always allow" suggestions on the card | `suggestions` from the SDK | The CLI's `permission_suggestions` are passed through when they arrive (spike D3). When they are absent, deck synthesizes one session suggestion itself (`synthesizedSuggestions`, Task 4 Step 16): `addRules` / `allow` / `destination: 'session'` with the tool name, plus `ruleContent` = the exact command for Bash. So `pr.suggestions` is never empty for a normal tool, TurnRunner's `addGrants` gets a rule to persist, the card always offers 한 번 / 이 세션, and `SessionGrants` keeps 이 세션 for the process. Not synthesized for ExitPlanMode (plan approval is not a reusable grant). A synthesized Bash rule matches only the exact command, not a prefix — broader than nothing, narrower than the CLI's own suggestion would be. | Prompt-tool payload. |
| Tool audit (PostToolUse / PostToolUseFailure / PermissionDenied hooks) | In-process hooks | Rebuilt from the stream (`ToolTracker`, `deniedCalls`); error results are attributed when the turn's result arrives instead of immediately. | Hooks replaceable by stream events are removed (spec §5.2). |
| Audit order of failed tool calls | PostToolUseFailure reported an error result the moment it happened | **Changed.** `ToolTracker` reports an errored tool result to the audit when the turn's result arrives, so in the audit log a failed call can appear after later calls of the same turn (and after that turn's permission decisions). The entries are the same; only their order differs. | No PostToolUseFailure hook; the stream carries the error with the turn. |
| "이 세션" without a CLI suggestion | Only the SDK's own `suggestions` could become a rule | **Changed.** When the prompt tool brings no `permission_suggestions`, the synthesized session suggestion (`addRules` / `allow` / `session`, tool name, exact Bash command) is what TurnRunner's `addGrants` persists, so answering 이 세션 now always creates an allow rule (`allowRules` of later turns of that session) — also for tools the SDK would have offered no rule for. | `synthesizedSuggestions` (Task 4 Step 16). |
| `DECK_STEER=0` | Removed the replay flag and steer | Removes only `LiveInput.steer`; `--replay-user-messages` is always on (ownership and steer echo need it). | deck's own-entry tracking reads the replays. |
| Steer folding into the running turn | `priority: 'next'` via the SDK | Same frame on stdin. If spike C2 fails, a steer becomes its own turn right after the current one. | Undocumented field on the CLI side. |
| Outside-write detection | `entrypoint === 'sdk-ts'` | deck remembers the uuids and message ids its own children wrote (in memory, bounded); lines younger than 3 s are 'pending'. Legacy `sdk-ts` lines still count as deck's. After a deck restart, entries written before the restart by a still-running deck child cannot exist (children die with the server), so in-memory is enough — but a handoff that spans a restart treats deck's last pre-restart entries as old, not foreign. | **Deviation from spec §5.2**: the spec proposed a session-id set for `foreignWrites` ("sessions deck started are deck's"); this plan uses an own-entry set (uuids / message ids) instead (Task 6), because a session-id set would hide a terminal `claude --resume` of a deck session, which is exactly the case to detect. |
| Process holders ("who else has this session open") | Matched SDK process roots (`ownRoots`) | Matches deck's marker flag in the command line. `ownRoots` is gone. | No SDK process tree anymore. |
| The deck bridge MCP tool | n/a | Visible to the model unless spike D9 allows `--disallowedTools` for it; a direct call is denied with `SELF_CALL_MESSAGE`. | Prompt tool must be an MCP tool. |
| Background tasks after the turn | SDK kept the process | Same design (stdin open). If spike H1 fails, background work is cut when the turn's result arrives and the BG timers are unused. | CLI behaviour after a result in stream-json mode. |
| Fixture captures | n/a | Run with project settings only, so captures do not depend on the developer's personal settings. | Reproducibility, hygiene. |
| Cost per edit-tool call | In-process hook | One extra short `node` process per edit-tool PreToolUse (the hook relay). | Hooks are commands. |
| Packaging | SDK bundled its CLI | Uses the user's installed `claude` (minimum 2.1.259); `permissionMcp.ts` and `hookRelay.ts` must ship with the server sources. Missing or old `claude` → a Korean message on each Claude turn; Codex/Gemini unaffected. | Spec §5.2. |
| Abort text | `Claude Code process aborted by user` from the SDK | `중단됨` from the engine, `terminalReason: 'aborted'`. An abort that lands before the turn starts spawns nothing (Task 8a test). | Same text the UI already hides. |
| Long-waiting permission cards | The SDK's `canUseTool` promise could wait indefinitely | deck sets `MCP_TOOL_TIMEOUT` = 12 h on the child and auto-denies at `PERMISSION_WAIT_MS` = 12 h − 2 min, so deck's own denial always wins over the CLI's tool timeout. If spike D10 (`permission-slow` vs `permission-slow-20s`, Task 4 Step 10) shows that `MCP_TOOL_TIMEOUT` does **not** apply to the prompt tool, a card that waits longer than the CLI's internal limit is **auto-denied** by the CLI; `PERMISSION_WAIT_MS` is then set to that measured limit minus 2 minutes so deck's denial (with its Korean reason) still comes first, and a user who answers later sees the card closed. | The prompt tool is an MCP call with the CLI's tool timeout. |
| AskUserQuestion (only if spike D6 is negative) | `canUseTool` answered with `updatedInput.answers` | Not reachable: the plan stops at the Task 3 gate (Step 11) and asks for a decision; it does not ship without AskUserQuestion. | Prompt-tool `updatedInput` must carry the answers. |

---

## Self-review

**Spec coverage (§5.2):**

| Spec item | Where |
|---|---|
| Options cwd, env, model, effort | Task 1 (`claudeArgs`, `claudeEnv`), Task 8a (spawn `cwd`, account env) |
| resume, forkSession | Task 1 (`--resume=`, `--fork-session`), Task 3 Step 10 (spike F1), Task 8a |
| resumeSessionAt | Task 6 (truncated copy fork), Lost or changed features |
| permissionMode, settingSources, includePartialMessages, replay-user-messages | Task 1 |
| abort → SIGINT, force → SIGTERM | Task 3 (`ClaudeProcess.interrupt/terminate`, spike B1), Task 8a (incl. abort before spawn) |
| settings(permissions.allow), additionalDirectories | Task 1 (`buildSettings`, `--add-dir=`) |
| canUseTool → `--permission-prompt-tool` via per-process stdio MCP server, AskUserQuestion via `updatedInput.answers` | Task 4 |
| hooks: PreToolUse, UserPromptSubmit kept as `--settings` commands; PostToolUse, PostToolUseFailure, PermissionDenied replaced by stream events | Task 5 |
| Messages system(init, compact, task_*, permission_denied), stream_event, assistant, user, result | Task 2 (parser + mapper moved), Task 7 (task_* recorded) |
| No control protocol | Global Constraints; stopTask/setPermissionMode consequences in Lost or changed features |
| `--session-id` and foreign-write redesign | Task 1 (`--session-id=` for new sessions), Task 6 (own-entry set instead of a session-id set; reason in Lost or changed features) |
| No `--bare` | Global Constraints, asserted in Task 1 and Task 8a tests |
| Minimum 2.1.259, recommended 2.1.283, `claude --version` at startup | Task 1 (`resolveClaudeBin`), Task 8c (config, startup log) |
| SDK removed | Task 8a (SDK engine isolated behind a shim), Task 8b (`fakeSdk.ts` deleted), Task 8c (uninstall, guard test), Task 9 |
| Out of scope (not touched) | usage-deck removal, same-vendor rotation opt-in |

**Placeholder scan:** no to-be-decided markers, no "later", no "same as another task" shortcuts, no unnamed files (the grep in the plan review returns nothing). The places that depend on runtime facts are written as conditional steps with both branches spelled out: Task 8a Step 9 (spike D9), the go/no-go spikes in Task 3 Steps 7–11 (E1/E3, D6, H1, F1 — each with a positive and a negative criterion and a fallback), D10 in Task 4 Step 10, and the fallbacks in the capture steps of Tasks 4–7. The test migration in Task 8b Step 1 is a rule table rather than per-file diffs; it is mechanical and every rule names the exact replacement.

**Type consistency (checked across tasks):**
- `ClaudeBin` (Task 1) is consumed by `ClaudeEngineOptions.bin` and `DeckConfig.claudeBin` (Task 8c); the `too_old` branch carries `version` for `claudeTooOldText`.
- `ArgsInput` fields used by the engine: `model`, `effort`, `permissionMode`, `settingsPath`, `mcpConfigPath`, `addDirs`, `resume`, `forkSession`, `sessionId`. Matches Task 1.
- `SettingsInput.relay: RelaySpec` and `buildMcpConfig({node, script, socketPath, token})`: the engine fills both from one `BridgeRegistration` (`token`, `socketPath`) (Task 4).
- `ClaudeProcess` members used in Task 8a (`start`, `messages`, `write`, `inputOpen`, `interrupt`, `stop`, `terminate`, `exited`, `exit`, `stderrTail`) all exist in Task 3's interface.
- `permissionHandler(req, audit, gate, grants)` (Task 4) and `hookHandler(req, audit, gate)` (Task 5) share one `ModeGate` per process; `LiveInput.setPermissionMode` writes `gate.mode`.
- `OwnedEntries.add/note/has` (Task 6) are fed by the engine (`add` for stdin uuids, `note` for every frame) and read by `foreignWrites` through `deckWrites.has`.
- `ToolTracker.apply(m)` (Task 5) is awaited per frame in Task 8a.
- `writeForkSource` returns `ForkSource`; the engine uses `src.path` / `src.text` (Task 6).
- `FakeSpawn.files` is added in Task 8a Step 1; `ask` (Task 4) and `hook` (Task 5) switch to it in the same step.
- `ABORTED_TEXT` equals `TurnRunner.ABORTED` ('중단됨').

**Undetermined until the spikes run (each has a written fallback):**
- B1: SIGINT in stream-json input mode ends the turn with a result (otherwise the engine synthesizes 중단됨 from the exit).
- C1–C3: stdin `uuid` is echoed as a replay; `priority: 'next'` folds a steer into the running turn; results carry `user_message_uuids`.
- D2/D5: `updatedPermissions` and `setMode` returned by the prompt tool are honoured (otherwise `SessionGrants` and the PreToolUse gate cover it). D3: an allow runs the tool, and whether `permission_suggestions` arrives. D6: AskUserQuestion through the prompt tool (answered in Task 3 Step 8; no fallback — the plan stops at the Task 3 gate if it fails). D9: the bridge tool can be hidden.
- D10: `MCP_TOOL_TIMEOUT` applies to the prompt tool, so a permission card can wait up to `PERMISSION_WAIT_MS` = 12 h − 2 min (deck's auto-deny) before the CLI's 12 h tool timeout. Measured by `permission-slow` (3 s timeout, allow after 6 s) against `permission-slow-20s` (20 s timeout); fallback in Task 4 Step 10 and Lost or changed features.
- Go/no-go answered early, in Task 3 Steps 7–11 (`fixtures/go-no-go.meta.json`): E1/E3 (hook decision and `additionalContext` honoured), D6 (AskUserQuestion through the prompt tool), H1 (process survives a result while a background task runs), F1 (fork from a truncated transcript). E3 or D6 negative stops the plan at Task 3; H1 and F1 negative have written fallbacks (Task 8a closes stdin at the first result; Task 6 item 1 deferred).
- E1–E4: the hook command's JSON output is honoured (`permissionDecision`, `additionalContext`).
- F0/F1: transcript uuids match stdout uuids; `--resume=<path>` with `--fork-session` accepts a truncated copy and writes the new session under the cwd's project dir.
- G1/G2: which entries the CLI writes per turn and that deck's stdout/stdin ids cover them.
- H1–H4: the process stays alive after a result while a background task runs, and the CLI injects the completion turn by itself.
