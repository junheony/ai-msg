import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEngine, buildOptions, mapSdkMessage } from './ClaudeEngine';
import type { EngineEvent, TurnRequest } from './Engine';

const M = (o: unknown) => o as SDKMessage;

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

describe('buildOptions', () => {
  it('selects the profile env, model alias, default permission mode, user+project+local settings, streaming', () => {
    const o = buildOptions(req({ account: 'b', model: 'fable', resumeSessionId: 'sid' }), { home: '/h', baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'k' }, abortController: new AbortController(), onStderr: () => {} });
    expect(o.cwd).toBe('/w');
    expect(o.env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-b' });
    expect(o.model).toBe('fable');
    expect(o.resume).toBe('sid');
    expect(o.permissionMode).toBe('default');
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.includePartialMessages).toBe(true);
    const a = buildOptions(req({ account: 'a' }), { home: '/h', baseEnv: { CLAUDE_CONFIG_DIR: '/h/.claude-c' }, abortController: new AbortController(), onStderr: () => {} });
    expect(a.env).toEqual({});
    expect(a.resume).toBeUndefined();
  });

  it('maps permission decisions to PermissionResult', async () => {
    const seen: string[] = [];
    const mk = (d: 'once' | 'session' | 'deny') => buildOptions(req({ onPermission: async (p) => { seen.push(p.toolName + ':' + p.toolUseId); return d; } }), { home: '/h', baseEnv: {}, abortController: new AbortController(), onStderr: () => {} });
    const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' } as never;
    expect(await mk('once').canUseTool!('Bash', { command: 'ls' }, ctx)).toEqual({ behavior: 'allow' });
    expect(await mk('session').canUseTool!('Bash', {}, ctx)).toEqual({ behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] });
    expect(await mk('deny').canUseTool!('Write', {}, ctx)).toMatchObject({ behavior: 'deny' });
    expect(seen).toEqual(['Bash:tu1', 'Bash:tu1', 'Write:tu1']);
  });
});

describe('mapSdkMessage', () => {
  it('init, text deltas (top-level only), tool calls, tool results, rate limit, compact, result', () => {
    expect(mapSdkMessage(M({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' }))).toEqual([{ kind: 'init', sessionId: 's', model: 'claude-opus-5-5' }]);
    expect(mapSdkMessage(M({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } }))).toEqual([{ kind: 'delta', text: 'ok' }]);
    expect(mapSdkMessage(M({ type: 'stream_event', parent_tool_use_id: 'agent', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } } }))).toEqual([]);
    expect(mapSdkMessage(M({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } }))).toEqual([]);
    expect(mapSdkMessage(M({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }))).toEqual([{ kind: 'tool_call', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' } }]);
    expect(mapSdkMessage(M({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a.txt' }], is_error: false }] } }))).toEqual([{ kind: 'tool_result', toolUseId: 'tu1', content: 'a.txt', isError: false }]);
    expect(mapSdkMessage(M({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', unifiedWindows: { five_hour: { utilization: 0.13, resetsAt: 1790773200 }, seven_day: { utilization: 0.9, resetsAt: 1790931600 } } } }))).toEqual([
      { kind: 'rate_limit', info: { status: 'allowed_warning', fiveHour: { usedPct: 13, resetsAt: '2026-09-30T13:00:00.000Z' }, weekly: { usedPct: 90, resetsAt: '2026-10-02T09:00:00.000Z' } } },
    ]);
    expect(mapSdkMessage(M({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }))).toEqual([{ kind: 'rate_limit', info: { status: 'rejected', fiveHour: null, weekly: null } }]);
    expect(mapSdkMessage(M({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 } }))).toEqual([{ kind: 'compact' }]);
    expect(mapSdkMessage(M({ type: 'system', subtype: 'status', status: 'requesting' }))).toEqual([]);
  });

  it('result: success, API error inside success, and error subtype', () => {
    const usage = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 };
    expect(mapSdkMessage(M({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage, session_id: 's', terminal_reason: 'completed' }))).toEqual([
      { kind: 'result', sessionId: 's', ok: true, text: 'ok', usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 10, cacheCreationTokens: 20 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' },
    ]);
    expect(mapSdkMessage(M({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401', usage, session_id: 's' }))).toMatchObject([{ kind: 'result', ok: false, text: '', errorText: 'Failed to authenticate. API Error: 401' }]);
    expect(mapSdkMessage(M({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many'], usage, session_id: 's' }))).toMatchObject([{ kind: 'result', ok: false, errorText: 'error_max_turns: too many' }]);
  });
});

describe('ClaudeEngine.runTurn', () => {
  it('streams mapped events, attaches the assistant error kind to the result, and passes options to queryFn', async () => {
    let captured: { prompt: string; options?: Record<string, unknown> } | null = null;
    const queryFn = (params: { prompt: string; options?: Record<string, unknown> }) => {
      captured = params;
      return (async function* () {
        yield M({ type: 'system', subtype: 'init', session_id: 's9', model: 'claude-opus-5-5' });
        yield M({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { content: [] } });
        yield M({ type: 'result', subtype: 'success', is_error: true, result: 'limit hit', usage: {}, session_id: 's9' });
      })();
    };
    const eng = new ClaudeEngine({ queryFn: queryFn as never, home: '/h', baseEnv: { PATH: '/bin' } });
    const events: EngineEvent[] = [];
    for await (const e of eng.runTurn(req({ prompt: 'p', account: 'a' }))) events.push(e);
    expect(events[0]).toEqual({ kind: 'init', sessionId: 's9', model: 'claude-opus-5-5' });
    expect(events[1]).toMatchObject({ kind: 'result', ok: false, errorKind: 'rate_limit', errorText: 'limit hit', usage: { inputTokens: 0 } });
    expect(captured!.prompt).toBe('p');
    expect(captured!.options?.env).toEqual({ PATH: '/bin' });
  });

  it('keeps CLI stderr out of errorText (classifier input) and caps it at ~2 KB', async () => {
    const queryFn = (p: { options?: { stderr?: (s: string) => void } }) => (async function* () {
      p.options?.stderr?.('x'.repeat(5000) + ' API Error: 429 rate limit');
      yield M({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', cwd: '/w' });
      throw new Error('Claude Code process exited with code 1');
    })();
    const eng = new ClaudeEngine({ queryFn: queryFn as never, home: '/h', baseEnv: {} });
    const events: EngineEvent[] = [];
    for await (const e of eng.runTurn(req())) events.push(e);
    const r = events.at(-1) as Extract<EngineEvent, { kind: 'result' }>;
    expect(r.errorText).toBe('Claude Code process exited with code 1');
    expect(r.stderr?.length).toBeLessThanOrEqual(2048);
    expect(r.stderr).toContain('429');
  });

  it('does not call query() when the turn was aborted before it started', async () => {
    let called = false;
    const queryFn = () => { called = true; return (async function* () { /* nothing */ })(); };
    const ac = new AbortController();
    ac.abort();
    const eng = new ClaudeEngine({ queryFn: queryFn as never, home: '/h', baseEnv: {} });
    const events: EngineEvent[] = [];
    for await (const e of eng.runTurn(req({ signal: ac.signal }))) events.push(e);
    expect(called).toBe(false);
    expect(events).toMatchObject([{ kind: 'result', ok: false, terminalReason: 'aborted' }]);
  });

  it('turns a thrown error without a result into a failed result', async () => {
    const queryFn = () => (async function* () { yield M({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }); throw new Error('process exited'); })();
    const eng = new ClaudeEngine({ queryFn: queryFn as never, home: '/h', baseEnv: {} });
    const events: EngineEvent[] = [];
    for await (const e of eng.runTurn(req())) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'result', ok: false, sessionId: 's1', errorText: expect.stringContaining('process exited') });
  });
});
