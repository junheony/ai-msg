import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeEngine, KEEP_PLANNING_MESSAGE, mapCliMessage, toolAudit, toUserMessage, type ClaudeEngineOptions } from './ClaudeEngine';
import { parseQuestions, sessionAllowLabel, sessionAllowOffered, type EngineEvent, type LiveInput, type TurnRequest } from './Engine';
import { fakeClaudeCli, cli, argValue } from './claudeCli/fakeClaudeCli';
import { MCP_TOOL_TIMEOUT_MS, PermissionBridge, type PermissionCall } from './claudeCli/bridge';
import type { CliMessage } from './claudeCli/messages';
import { SessionGrants, permissionHandler, type ModeGate } from './claudeCli/permissions';
import { testRegistry } from '../../shared/accounts.testkit';

const M = (o: unknown) => o as CliMessage;

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

const SID = '11111111-2222-4333-8444-555555555555';
let bridge: PermissionBridge | null = null;
let tmp = '';
afterEach(async () => { await bridge?.close(); bridge = null; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });
async function setup(over: Partial<ClaudeEngineOptions> = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-eng-'));
  bridge = await PermissionBridge.open();
  const f = fakeClaudeCli();
  const engine = new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge, accounts: testRegistry('/h'), baseEnv: {}, readFile: async () => Buffer.from(''), tmpRoot: tmp, killGraceMs: 50, ...over });
  return { f, engine };
}
const drain = async (it: AsyncIterable<EngineEvent>) => { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; };
/** One finished turn; returns the spawn record and the events. */
async function turn(r: Partial<TurnRequest> = {}, over: Partial<ClaudeEngineOptions> = {}) {
  const { f, engine } = await setup(over);
  f.push(cli.init('s1'), cli.result('ok', 's1'));
  const evs = await drain(engine.runTurn(req(r)));
  return { f, s: f.spawns[0]!, evs };
}
type Settings = { permissions?: { allow: string[] }; hooks: Record<string, unknown> };

/** The old canUseTool is the bridge's permission handler; `canUse` calls it like the prompt tool does. */
function handler(r: Partial<TurnRequest> = {}, gate: ModeGate = { mode: r.permissionMode ?? 'default', startedIn: r.permissionMode ?? 'default' }) {
  const h = permissionHandler(req(r), toolAudit(req(r)), gate, new SessionGrants());
  return (toolName: string, input: Record<string, unknown>, extra: Partial<PermissionCall> = {}) => h({ tool_name: toolName, input, tool_use_id: 'tu1', ...extra }, new AbortController().signal);
}

describe('claude argv / env', () => {
  it('selects the profile env, model id, default permission mode, user+project+local settings, streaming', async () => {
    const { s } = await turn({ account: 'b', model: 'fable', resumeSessionId: SID }, { baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'k' } });
    expect(s.cwd).toBe('/w');
    expect(s.env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-b', MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) });
    expect(argValue(s.args, '--model')).toBe('claude-fable-5-1');
    expect(s.args).not.toContain('--effort');
    expect(argValue(s.args, '--resume')).toBe(SID);
    expect(argValue(s.args, '--permission-mode')).toBe('default');
    expect(argValue(s.args, '--setting-sources')).toBe('user,project,local');
    expect(s.args).toContain('--include-partial-messages');
    const a = (await turn({ account: 'a' }, { baseEnv: { CLAUDE_CONFIG_DIR: '/h/.claude-c' } })).s;
    expect(a.env).toEqual({ MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) });
    expect(argValue(a.args, '--resume')).toBeUndefined();
  });

  it('maps permission decisions to the prompt tool reply', async () => {
    const seen: string[] = [];
    const mk = (d: 'once' | 'session' | 'deny') => handler({ onPermission: async (p) => { seen.push(p.toolName + ':' + p.toolUseId); return d; } });
    expect(await mk('once')('Bash', { command: 'ls' })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    // No suggestions from the CLI → deck synthesizes one session rule for the tool (Lost or changed features: "Always allow" suggestions).
    expect(await mk('session')('Bash', {})).toEqual({ behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] });
    expect(await mk('deny')('Write', {})).toMatchObject({ behavior: 'deny' });
    expect(seen).toEqual(['Bash:tu1', 'Bash:tu1', 'Write:tu1']);
  });
});

describe('claude argv: model version and effort', () => {
  it('passes the exact model id and the per-turn effort as --effort', async () => {
    const { s } = await turn({ model: 'opus', effort: 'xhigh' });
    expect(argValue(s.args, '--model')).toBe('claude-opus-5-5');
    expect(argValue(s.args, '--effort')).toBe('xhigh');
    const s2 = (await turn({ model: 'sonnet', effort: 'low' })).s;
    expect([argValue(s2.args, '--model'), argValue(s2.args, '--effort')]).toEqual(['claude-sonnet-5-5', 'low']);
  });

  it('always asks the CLI to echo consumed user messages; steering switched off only drops live.steer', async () => {
    let live: LiveInput | null = null;
    const on = await turn({ onLive: (l) => { live = l; } });
    expect(on.s.args).toContain('--replay-user-messages');
    expect(live!.steer).toBeTypeOf('function');
    const off = await turn({ onLive: (l) => { live = l; } }, { steer: false });
    expect(off.s.args).toContain('--replay-user-messages');
    expect(live!.steer).toBeUndefined();
  });

  it("carries deck's note on the process's first user prompt only (UserPromptSubmit additionalContext), never in the system prompt", async () => {
    const { f, engine } = await setup();
    const it = engine.runTurn(req({ systemNote: '[deck] note' }))[Symbol.asyncIterator]();
    f.push(cli.init('s1'));
    await it.next();
    const s = f.spawns[0]!;
    expect(s.args.some((a) => a.includes('system-prompt'))).toBe(false);
    expect((s.files.settings as Settings).hooks.UserPromptSubmit).toBeDefined();
    const input = { hook_event_name: 'UserPromptSubmit', prompt: 'hi', session_id: 's', transcript_path: '/t', cwd: '/w' };
    expect(await f.hook(input)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[deck] note' } });
    // A follow-up, continuation or steer into the same process: nothing more.
    const again = (await f.hook(input)) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(again.hookSpecificOutput?.additionalContext).toBeUndefined();
    f.push(cli.result('ok', 's1'));
    for (let r = await it.next(); !r.done; r = await it.next()) { /* drain */ }
    const plain = (await turn()).s;
    expect(plain.args.some((a) => a.includes('system-prompt'))).toBe(false);
    expect((plain.files.settings as Settings).hooks.UserPromptSubmit).toBeUndefined();
  });
});

describe('permission handler: allow for this session (review I4)', () => {
  const suggestions = [{ type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'allow' as const, destination: 'session' as const }];

  it('returns the CLI suggestions as updatedPermissions and relays the prompt details', async () => {
    const seen: unknown[] = [];
    const canUse = handler({ onPermission: async (p) => { seen.push(p); return 'session'; } });
    expect(await canUse('Bash', { command: 'git status' }, { permission_suggestions: suggestions })).toEqual({ behavior: 'allow', updatedInput: { command: 'git status' }, updatedPermissions: suggestions });
    // title / decisionReason / blockedPath / defaultToNo are not passed to the prompt tool (Lost or changed features).
    expect(seen[0]).toMatchObject({ toolName: 'Bash', suggestions, suppressAlwaysAllowRule: false });
  });

  it('pre-allows the session\'s stored rules and directories through the --settings file and --add-dir', async () => {
    const { s } = await turn({ allowRules: ['Bash(git status)'], allowDirs: ['/data'] });
    expect((s.files.settings as Settings).permissions).toEqual({ allow: ['Bash(git status)'] });
    expect(s.args.filter((a) => a.startsWith('--add-dir='))).toEqual(['--add-dir=/data']);
    const none = (await turn()).s;
    expect((none.files.settings as Settings).permissions).toBeUndefined();
    expect(none.args.filter((a) => a.startsWith('--add-dir='))).toEqual([]);
  });
});

// Shapes captured from the real CLI (account b, the SDK engine's options) — not fabricated.
const REAL_WRITE_SUGGESTIONS = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
const REAL_BASH_SUGGESTIONS = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch s3.txt' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addDirectories', directories: ['/w/sub'], destination: 'session' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];

describe('permission handler: 이 세션 never persists outside the session', () => {
  const answer = async (suggestions: unknown[]) =>
    (await handler({ onPermission: async () => 'session' })('Bash', { command: 'touch s3.txt' }, { permission_suggestions: suggestions as never })) as { behavior: string; updatedPermissions?: Array<{ destination: string }> };

  it('real Bash suggestions: every destination is rewritten to session (localSettings is never returned)', async () => {
    const r = await answer(REAL_BASH_SUGGESTIONS);
    expect(r.updatedPermissions).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch s3.txt' }], behavior: 'allow', destination: 'session' },
      { type: 'addDirectories', directories: ['/w/sub'], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
    expect(r.updatedPermissions!.every((u) => u.destination === 'session')).toBe(true);
  });

  it('real Write suggestion: setMode acceptEdits is returned with destination session', async () => {
    expect(await answer(REAL_WRITE_SUGGESTIONS)).toEqual({ behavior: 'allow', updatedInput: { command: 'touch s3.txt' }, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  });

  it('unknown kinds, deny/ask rules, removals and bypassPermissions are dropped', async () => {
    const r = await answer([
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      { type: 'setMode', mode: 'dontAsk', destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'userSettings' },
      { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'removeDirectories', directories: ['/x'], destination: 'session' },
      { type: 'somethingNew', destination: 'projectSettings' },
      { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/w/**' }], behavior: 'allow', destination: 'projectSettings' },
    ]);
    expect(r.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/w/**' }], behavior: 'allow', destination: 'session' }]);
  });

  it('nothing persistable: a plain one-time allow, no updatedPermissions', async () => {
    // (The suppressAlwaysAllowRule half of this test is gone with the field — Lost or changed features.)
    expect(await answer([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }])).toEqual({ behavior: 'allow', updatedInput: { command: 'touch s3.txt' } });
  });

  it('once never returns updatedPermissions', async () => {
    expect(await handler({ onPermission: async () => 'once' })('Bash', {}, { permission_suggestions: REAL_BASH_SUGGESTIONS as never })).toEqual({ behavior: 'allow', updatedInput: {} });
  });

  it('a session that accepted edits runs later turns in acceptEdits', async () => {
    expect(argValue((await turn({ permissionMode: 'acceptEdits' })).s.args, '--permission-mode')).toBe('acceptEdits');
    expect(argValue((await turn()).s.args, '--permission-mode')).toBe('default');
  });
});

describe('sessionAllowOffered / sessionAllowLabel', () => {
  it('offered only when something is persistable; the label says what', () => {
    const s = (suggestions: unknown[], suppress = false) => ({ suggestions: suggestions as never, suppressAlwaysAllowRule: suppress });
    expect(sessionAllowLabel(s(REAL_WRITE_SUGGESTIONS))).toBe('이 세션 동안 파일 편집 허용');
    expect(sessionAllowLabel(s(REAL_BASH_SUGGESTIONS))).toBe('이 세션 동안 `Bash(touch s3.txt)`, `/w/sub` 폴더 접근, 파일 편집 허용');
    expect(sessionAllowLabel(s([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }]))).toBe('이 세션 동안 `Bash(ls)` 허용');
    expect(sessionAllowOffered(s(REAL_WRITE_SUGGESTIONS))).toBe(true);
    expect(sessionAllowOffered(s([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }, { type: 'somethingNew' }]))).toBe(false);
    expect(sessionAllowLabel(s([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }]))).toBeNull();
    expect(sessionAllowOffered(s([]))).toBe(false);
    expect(sessionAllowOffered(s(REAL_BASH_SUGGESTIONS, true))).toBe(false);
    expect(sessionAllowLabel(s(REAL_BASH_SUGGESTIONS, true))).toBeNull();
  });
});

describe('mapCliMessage', () => {
  it('a background task notification → task_done (drives a push)', () => {
    expect(mapCliMessage(M({ type: 'system', subtype: 'task_notification', task_id: 'k', status: 'completed', output_file: '/tmp/o', summary: 'npm test 끝' }))).toEqual([{ kind: 'task_done', status: 'completed', summary: 'npm test 끝', taskId: 'k', toolUseId: null }]);
  });

  it('a replayed user message (--replay-user-messages) maps to nothing, even when it carries a tool_result', () => {
    const tr = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] };
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, isReplay: true, message: tr }))).toEqual([]);
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: 'agent', isReplay: true, message: tr }))).toEqual([]);
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, message: tr }))).toEqual([{ kind: 'tool_result', toolUseId: 'u1', content: 'ok', isError: false }]);
  });

  it('a synthetic / meta top-level user message → a system event (hook, peer, task); context-only ones and replays → nothing', () => {
    const msg = { role: 'user', content: 'Stop hook feedback:\n[verify] 테스트 실패' };
    const stop = [{ kind: 'system', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴', text: 'Stop hook feedback:\n[verify] 테스트 실패' }];
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, isSynthetic: true, message: msg }))).toEqual(stop);
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, isMeta: true, message: msg }))).toEqual(stop);
    // Unflagged text is not harness-injected; a subagent copy and a replay never show.
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, message: msg }))).toEqual([]);
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: 'agent', isSynthetic: true, message: msg }))).toEqual([]);
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, isSynthetic: true, isReplay: true, message: msg }))).toEqual([]);
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, isSynthetic: true, origin: { kind: 'peer', from: 'a1' }, message: { role: 'user', content: 'Another Claude session sent a message: hi' } }))).toMatchObject([{ kind: 'system', source: 'peer', label: '다른 세션의 메시지' }]);
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification><status>failed</status><summary>빌드</summary></task-notification>' } }))).toEqual([{ kind: 'system', source: 'task', label: '백그라운드 작업 실패', text: '빌드' }]);
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, isSynthetic: true, message: { role: 'user', content: 'Base directory for this skill: /x' } }))).toEqual([]);
  });

  it('init, text deltas (top-level only), tool calls, tool results, rate limit, compact, result', () => {
    expect(mapCliMessage(M({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', cwd: '/private/var/w' }))).toEqual([{ kind: 'init', sessionId: 's', model: 'claude-opus-5-5', cwd: '/private/var/w' }]);
    expect(mapCliMessage(M({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } }))).toEqual([{ kind: 'delta', text: 'ok' }]);
    expect(mapCliMessage(M({ type: 'stream_event', parent_tool_use_id: 'agent', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } } }))).toEqual([]);
    expect(mapCliMessage(M({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } }))).toEqual([]);
    expect(mapCliMessage(M({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }))).toEqual([{ kind: 'tool_call', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' } }]);
    expect(mapCliMessage(M({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a.txt' }], is_error: false }] } }))).toEqual([{ kind: 'tool_result', toolUseId: 'tu1', content: 'a.txt', isError: false }]);
    expect(mapCliMessage(M({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', unifiedWindows: { five_hour: { utilization: 0.13, resetsAt: 1790773200 }, seven_day: { utilization: 0.9, resetsAt: 1790931600 } } } }))).toEqual([
      { kind: 'rate_limit', info: { status: 'allowed_warning', fiveHour: { usedPct: 13, resetsAt: '2026-09-30T13:00:00.000Z' }, weekly: { usedPct: 90, resetsAt: '2026-10-02T09:00:00.000Z' } } },
    ]);
    expect(mapCliMessage(M({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }))).toEqual([{ kind: 'rate_limit', info: { status: 'rejected', fiveHour: null, weekly: null } }]);
    expect(mapCliMessage(M({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 } }))).toEqual([{ kind: 'compact' }]);
    expect(mapCliMessage(M({ type: 'system', subtype: 'status', status: 'requesting' }))).toEqual([]);
  });

  it('result: success, API error inside success, and error subtype', () => {
    const usage = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 };
    expect(mapCliMessage(M({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage, session_id: 's', terminal_reason: 'completed' }))).toEqual([
      { kind: 'result', sessionId: 's', ok: true, text: 'ok', usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 10, cacheCreationTokens: 20 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' },
    ]);
    expect(mapCliMessage(M({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401', usage, session_id: 's' }))).toMatchObject([{ kind: 'result', ok: false, text: '', errorText: 'Failed to authenticate. API Error: 401' }]);
    expect(mapCliMessage(M({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many'], usage, session_id: 's' }))).toMatchObject([{ kind: 'result', ok: false, errorText: 'error_max_turns: too many' }]);
  });
});

describe('ClaudeEngine.runTurn', () => {
  it('streams mapped events, attaches the assistant error kind to the result, and writes the prompt to stdin', async () => {
    const { f, engine } = await setup({ baseEnv: { PATH: '/bin' } });
    f.push(
      { type: 'system', subtype: 'init', session_id: 's9', model: 'claude-opus-5-5' },
      { type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { content: [] } },
      { type: 'result', subtype: 'success', is_error: true, result: 'limit hit', usage: {}, session_id: 's9' },
    );
    const events = await drain(engine.runTurn(req({ prompt: 'p', account: 'a' })));
    expect(events[0]).toEqual({ kind: 'init', sessionId: 's9', model: 'claude-opus-5-5' });
    expect(events[1]).toMatchObject({ kind: 'result', ok: false, errorKind: 'rate_limit', errorText: 'limit hit', usage: { inputTokens: 0 } });
    // Streaming-input mode always (background work needs the process to outlive the result).
    expect(f.inputs[0]!.message.content).toBe('p');
    expect(f.spawns[0]!.env).toEqual({ PATH: '/bin', MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) });
  });

  it('keeps CLI stderr out of errorText (classifier input) and caps it at ~2 KB', async () => {
    const { f, engine } = await setup();
    const it = engine.runTurn(req())[Symbol.asyncIterator]();
    f.push({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', cwd: '/w' });
    await it.next();
    f.stderr('x'.repeat(5000) + ' API Error: 429 rate limit');
    f.end(1);
    const events: EngineEvent[] = [];
    for (let x = await it.next(); !x.done; x = await it.next()) events.push(x.value);
    const r = events.at(-1) as Extract<EngineEvent, { kind: 'result' }>;
    expect(r.errorText).toBe('Claude Code 종료 코드 1');
    expect(r.stderr?.length).toBeLessThanOrEqual(2048);
    expect(r.stderr).toContain('429');
  });

  it('does not spawn the CLI when the turn was aborted before it started', async () => {
    const { f, engine } = await setup();
    const ac = new AbortController();
    ac.abort();
    const events = await drain(engine.runTurn(req({ signal: ac.signal })));
    expect(f.state.calls).toBe(0);
    expect(events).toMatchObject([{ kind: 'result', ok: false, terminalReason: 'aborted' }]);
  });

  it('turns an exit without a result into a failed result', async () => {
    const { f, engine } = await setup();
    f.push({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
    f.end(1);
    const events = await drain(engine.runTurn(req()));
    expect(events.at(-1)).toMatchObject({ kind: 'result', ok: false, sessionId: 's1', errorText: expect.stringContaining('종료 코드 1') });
  });
});

const img = { id: 'i1', name: 'a.png', mediaType: 'image/png', size: 3, path: '/att/i1-a.png', isImage: true, createdAtMs: 0 };
const doc = { id: 'd1', name: 'n.md', mediaType: 'application/octet-stream', size: 1, path: '/att/d1-n.md', isImage: false, createdAtMs: 0 };

describe('ClaudeEngine.runTurn — context size', () => {
  it('the result carries the main conversation\'s last call prompt as context (subagent calls ignored) and the CLI context window', async () => {
    const u = (input: number, read: number, write: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5 });
    const { f, engine } = await setup();
    f.push(
      { type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: u(1, 100, 50) } },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: u(2, 150, 10) } },
      { type: 'assistant', parent_tool_use_id: 'agent', message: { content: [], usage: u(9, 9000, 9000) } },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', usage: u(3, 250, 60), modelUsage: { 'claude-opus-5-5': { contextWindow: 1_000_000 }, 'claude-haiku-4-5': { contextWindow: 200_000 } } },
    );
    const events = await drain(engine.runTurn(req()));
    const res = events.find((e) => e.kind === 'result');
    expect(res).toMatchObject({ usage: { inputTokens: 3, cacheReadTokens: 250, cacheCreationTokens: 60, context: { inputTokens: 2, cacheReadTokens: 150, cacheCreationTokens: 10 }, contextWindow: 1_000_000, lastCall: { inputTokens: 2, outputTokens: 5, cacheReadTokens: 150, cacheCreationTokens: 10 } } });
  });
});

describe('toUserMessage (D7, D14)', () => {
  it('text only / files only stay plain text with path lines; images become one user message with base64 blocks', async () => {
    const readFile = async (p: string) => Buffer.from(`bytes-of-${p}`);
    expect((await toUserMessage('hi', [], readFile)).message.content).toBe('hi');
    expect((await toUserMessage('hi', [doc], readFile)).message.content).toBe('hi\n\n첨부 파일: /att/d1-n.md');
    expect(await toUserMessage('what is this?', [img, doc], readFile)).toEqual({
      type: 'user', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: 'what is this?\n\n첨부 파일: /att/d1-n.md' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('bytes-of-/att/i1-a.png').toString('base64') } },
      ] },
    });
  });
});

describe('ClaudeEngine with attachments', () => {
  it('writes the image message to stdin and stops reading after the result', async () => {
    const { f, engine } = await setup({ readFile: async () => Buffer.from('png') });
    f.push(
      { type: 'system', subtype: 'init', session_id: 's', model: 'm' },
      { type: 'result', subtype: 'success', is_error: false, result: 'a red pixel', session_id: 's', usage: {} },
      { type: 'system', subtype: 'init', session_id: 's', model: 'm' }, // reached only if the engine keeps reading after the result
    );
    const out = await drain(engine.runTurn(req({ prompt: 'what?', attachments: [img] })));
    expect(f.inputs[0]!.message.content).toHaveLength(2);
    expect(out.at(-1)).toMatchObject({ kind: 'result', ok: true, text: 'a red pixel' });
    expect(out.filter((e) => e.kind === 'init')).toHaveLength(1);
    expect(f.state.inputClosed).toBe(true);
  });

  it('without images the stdin message carries the plain text with path lines', async () => {
    const { f, engine } = await setup({ readFile: async () => { throw new Error('must not read'); } });
    f.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', usage: {} });
    await drain(engine.runTurn(req({ prompt: 'x', attachments: [doc] })));
    expect(f.inputs.map((m) => m.message.content)).toEqual(['x\n\n첨부 파일: /att/d1-n.md']);
  });

  it('a failed image read ends the turn as a failed result, not a throw', async () => {
    const { f, engine } = await setup({ readFile: async () => { throw new Error('ENOENT: gone'); } });
    f.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', usage: {} });
    const out = await drain(engine.runTurn(req({ attachments: [img] })));
    expect(f.state.calls).toBe(0);
    expect(out).toEqual([expect.objectContaining({ kind: 'result', ok: false, errorText: expect.stringContaining('ENOENT') })]);
  });
});

const QUESTIONS = [{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: 'cool', preview: 'x' }], multiSelect: false }];

describe('AskUserQuestion (D8)', () => {
  it('parseQuestions validates the tool input shape and drops previews; garbage → null', () => {
    expect(parseQuestions({ questions: QUESTIONS })).toEqual([{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: 'cool' }], multiSelect: false }]);
    expect(parseQuestions({ questions: [] })).toBeNull();
    expect(parseQuestions({ questions: [{ question: 'q', options: [{ label: 'a' }] }] })).toBeNull();
    expect(parseQuestions('nope')).toBeNull();
  });

  it('parseQuestions rejects duplicate question texts and texts over 2000 chars (answers are keyed by text)', () => {
    const q = (question: string) => ({ question, header: 'H', options: [{ label: 'a' }, { label: 'b' }] });
    expect(parseQuestions({ questions: [q('Same?'), q('Same?')] })).toBeNull();
    expect(parseQuestions({ questions: [q('x'.repeat(2001))] })).toBeNull();
    expect(parseQuestions({ questions: [q('x'.repeat(2000)), q('Other?')] })).toHaveLength(2);
  });

  it('a malformed AskUserQuestion is denied without asking and reported through onQuestionMalformed (for the audit)', async () => {
    const asked: unknown[] = [];
    const malformed: unknown[] = [];
    const dup = { questions: [QUESTIONS[0], QUESTIONS[0]] };
    const canUse = handler({ onQuestion: async (q) => { asked.push(q); return { x: 'y' }; }, onQuestionMalformed: async (input) => { malformed.push(input); } });
    expect(await canUse('AskUserQuestion', dup, { tool_use_id: 'tu9' })).toMatchObject({ behavior: 'deny' });
    expect(asked).toHaveLength(0);
    expect(malformed).toEqual([dup]);
  });

  it('the permission handler routes AskUserQuestion to onQuestion and returns the answers as updatedInput; no answer → deny', async () => {
    const asked: unknown[] = [];
    const canUse = handler({ onQuestion: async (q) => { asked.push(q); return { 'Which color?': 'blue' }; } });
    expect(await canUse('AskUserQuestion', { questions: QUESTIONS }, { tool_use_id: 'tu9' })).toEqual({ behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { 'Which color?': 'blue' } } });
    expect(asked[0]).toMatchObject({ toolUseId: 'tu9', questions: [{ question: 'Which color?' }] });
    expect(await handler({ onQuestion: async () => null })('AskUserQuestion', { questions: QUESTIONS })).toMatchObject({ behavior: 'deny' });
    const noHandler = handler({});
    expect(await noHandler('AskUserQuestion', { questions: QUESTIONS })).toMatchObject({ behavior: 'deny' });
    // never confused with a permission prompt
    expect(await noHandler('Bash', { command: 'ls' })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });
});

describe('자동 승인 (autoApprove)', () => {
  it('on: every tool is allowed at once without asking, each reported for the audit; AskUserQuestion still asks', async () => {
    const asked: string[] = [];
    const audited: string[] = [];
    const questions: unknown[] = [];
    const canUse = handler({
      autoApprove: () => true,
      onPermission: async (p) => { asked.push(p.toolName); return 'deny'; },
      onAutoApproved: async (p) => { audited.push(`${p.toolName}:${p.toolUseId}`); },
      onQuestion: async (q) => { questions.push(q); return { 'Which color?': 'red' }; },
    });
    for (const t of ['Bash', 'Edit', 'Write', 'Read']) expect(await canUse(t, { command: 'git -C /x log' })).toEqual({ behavior: 'allow', updatedInput: { command: 'git -C /x log' } });
    expect(asked).toEqual([]);
    expect(audited).toEqual(['Bash:tu1', 'Edit:tu1', 'Write:tu1', 'Read:tu1']);
    expect(await canUse('AskUserQuestion', { questions: QUESTIONS })).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which color?': 'red' } } });
    expect(questions).toHaveLength(1);
  });

  it('off (or toggled off mid-turn): back to the per-call card', async () => {
    let on = true;
    const asked: string[] = [];
    const canUse = handler({ autoApprove: () => on, onPermission: async (p) => { asked.push(p.toolName); return 'deny'; } });
    expect(await canUse('Bash', {})).toEqual({ behavior: 'allow', updatedInput: {} });
    on = false;
    expect(await canUse('Bash', {})).toMatchObject({ behavior: 'deny' });
    expect(asked).toEqual(['Bash']);
  });
});

describe('permission modes and the plan card (ExitPlanMode)', () => {
  it('passes the session mode to the CLI (absent = default)', async () => {
    expect(argValue((await turn({})).s.args, '--permission-mode')).toBe('default');
    expect(argValue((await turn({ permissionMode: 'plan' })).s.args, '--permission-mode')).toBe('plan');
    expect(argValue((await turn({ permissionMode: 'acceptEdits' })).s.args, '--permission-mode')).toBe('acceptEdits');
  });

  it('승인 · 편집 자동 승인 → allow + acceptEdits, 승인 · 수동 → allow + default, 계속 계획 → deny', async () => {
    let decision: 'session' | 'once' | 'deny' = 'session';
    const asked: string[] = [];
    const canUse = handler({ permissionMode: 'plan', autoApprove: () => false, onPermission: async (p) => { asked.push(p.toolName); return decision; } });
    expect(await canUse('ExitPlanMode', { plan: '1. a' })).toEqual({ behavior: 'allow', updatedInput: { plan: '1. a' }, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    decision = 'once';
    expect(await canUse('ExitPlanMode', { plan: '1. a' })).toEqual({ behavior: 'allow', updatedInput: { plan: '1. a' }, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] });
    decision = 'deny';
    expect(await canUse('ExitPlanMode', { plan: '1. a' })).toEqual({ behavior: 'deny', message: KEEP_PLANNING_MESSAGE });
    expect(asked).toEqual(['ExitPlanMode', 'ExitPlanMode', 'ExitPlanMode']);
  });
});
