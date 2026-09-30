import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { fromTranscript, initialState, reducer, type AppState } from './state';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;

function play(msgs: ServerMessage[], start: AppState = initialState): AppState {
  return msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), start);
}

describe('reducer', () => {
  it('hello/usage/index update the top-level fields', () => {
    const s = play([{ type: 'hello', usage, projects: [], running: [] }]);
    expect(s.usage).toEqual(usage);
    expect(s.connected).toBe(true);
    expect(play([{ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [] }] }], s).projects[0]?.name).toBe('w');
  });

  it('streams a turn into one assistant item and finishes with a badge', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: '새 세션' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 't1', sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: '새 세션', attempt: 0 },
      { type: 'delta', turnId: 't1', sessionId: null, cwd: '/w', text: 'o' },
      { type: 'delta', turnId: 't1', sessionId: null, cwd: '/w', text: 'k' },
      { type: 'tool_call', turnId: 't1', sessionId: null, cwd: '/w', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' } },
      { type: 'permission_request', turnId: 't1', sessionId: null, cwd: '/w', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true },
    ], s);
    expect(s.items[0]).toEqual({ kind: 'user', text: 'hi' });
    expect(s.items[1]).toMatchObject({ kind: 'assistant', turnId: 't1', text: 'ok', streaming: true, toolCalls: [{ toolUseId: 'tu1', name: 'Bash', result: null }] });
    expect(s.pending).toMatchObject([{ turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, cwd: '/w' }]);
    expect(s.activeTurnId).toBe('t1');
    s = play([
      { type: 'permission_resolved', requestId: 'r1', decision: 'once' },
      { type: 'tool_result', turnId: 't1', sessionId: null, cwd: '/w', toolUseId: 'tu1', content: 'a.txt', isError: false },
      { type: 'turn_retry', turnId: 't1', sessionId: null, cwd: '/w', fromAccount: 'b', toAccount: 'c', reason: '한도 도달', attempt: 1 },
      { type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', account: 'c', model: 'opus', reason: '재시도', attempt: 1 },
      { type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: true, text: 'ok', badge: { account: 'c', model: 'opus', reason: '재시도', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null }, errorText: null },
    ], s);
    expect(s.pending).toEqual([]);
    expect(s.items).toHaveLength(2);
    const a = s.items[1];
    expect(a).toMatchObject({ kind: 'assistant', streaming: false, badge: { account: 'c' }, notes: ['재시도 B → C: 한도 도달'], toolCalls: [{ result: 'a.txt' }] });
    expect(s.session).toMatchObject({ sessionId: 's1', account: 'c' });
    expect(s.activeTurnId).toBeNull();
  });

  it('uses the result text when no deltas arrived and records errors', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = play([
      { type: 'turn_started', turnId: 't2', sessionId: 's', cwd: '/w', account: 'a', model: 'sonnet', reason: 'r', attempt: 0 },
      { type: 'turn_result', turnId: 't2', sessionId: 's', cwd: '/w', ok: false, text: '', badge: { account: 'a', model: 'sonnet', reason: 'r', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null }, errorText: '401' },
      { type: 'error', turnId: null, message: 'boom' },
    ], s);
    expect(s.items[0]).toMatchObject({ kind: 'assistant', error: '401', text: '' });
    expect(s.error).toBe('boom');
    expect(reducer(s, { type: 'dismiss_error' }).error).toBeNull();
  });

  it('history replaces the items', () => {
    const s = play([{ type: 'history', sessionId: 's', cwd: '/w', account: 'b', runningTurnId: null, messages: [
      { kind: 'user', text: 'q', ts: null },
      { kind: 'assistant', text: 'a', model: 'claude-opus-5-5', toolCalls: [{ id: 'tu', name: 'Read', input: {} }], ts: null },
      { kind: 'tool_result', toolUseId: 'tu', content: 'file', isError: false, ts: null },
    ] }]);
    expect(s.session).toMatchObject({ sessionId: 's', cwd: '/w', account: 'b' });
    expect(s.items).toEqual(fromTranscript([
      { kind: 'user', text: 'q', ts: null },
      { kind: 'assistant', text: 'a', model: 'claude-opus-5-5', toolCalls: [{ id: 'tu', name: 'Read', input: {} }], ts: null },
      { kind: 'tool_result', toolUseId: 'tu', content: 'file', isError: false, ts: null },
    ]));
    expect(s.items[1]).toMatchObject({ kind: 'assistant', text: 'a', toolCalls: [{ toolUseId: 'tu', result: 'file' }] });
  });

  it('an error for the active turn clears activeTurnId and streaming so the tab can send again', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 't3', sessionId: 's', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'error', turnId: 't3', message: 'boom' },
    ], s);
    expect(s.activeTurnId).toBeNull();
    expect(s.items[1]).toMatchObject({ kind: 'assistant', streaming: false, error: 'boom' });
  });

  it('a turn_result without a badge (rejected run) still ends the turn', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 't4', sessionId: 's', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'turn_result', turnId: 't4', sessionId: 's', cwd: '/w', ok: false, text: '', badge: null, errorText: 'engine exploded' },
    ], s);
    expect(s.activeTurnId).toBeNull();
    expect(s.session).toMatchObject({ sessionId: 's', account: null });
    expect(s.items[1]).toMatchObject({ streaming: false, error: 'engine exploded' });
  });

  it('turn_notice is a note on the running turn and does not end it', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 't5', sessionId: 's', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'turn_notice', turnId: 't5', sessionId: 's', cwd: '/w', message: '세션 이전 실패(x) — B 계정 유지' },
    ], s);
    expect(s.activeTurnId).toBe('t5');
    expect(s.items[1]).toMatchObject({ streaming: true, notes: ['세션 이전 실패(x) — B 계정 유지'], error: null });
  });

  const badge = (account: 'a' | 'b' | 'c') => ({ account, model: 'opus' as const, reason: 'r', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null });
  const historyOf = (sessionId: string, account: 'a' | 'b' | 'c' = 'b'): ServerMessage => ({ type: 'history', sessionId, cwd: '/w', account, messages: [{ kind: 'user', text: 'q', ts: null }], runningTurnId: null });

  it("another session's turn events leave the open session untouched", () => {
    const s0 = play([historyOf('s')]);
    const s = play([
      { type: 'turn_started', turnId: 'tx', sessionId: 'other', cwd: '/x', account: 'c', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'delta', turnId: 'tx', sessionId: 'other', cwd: '/x', text: 'leak' },
      { type: 'tool_call', turnId: 'tx', sessionId: 'other', cwd: '/x', toolUseId: 'tu', name: 'Bash', input: {} },
      { type: 'turn_result', turnId: 'tx', sessionId: 'other', cwd: '/x', ok: true, text: 'leak', badge: badge('c'), errorText: null },
    ], s0);
    expect(s.items).toEqual(s0.items);
    expect(s.session).toEqual(s0.session);
    expect(s.activeTurnId).toBeNull();
  });

  it("a foreign new-session turn (sessionId null) is ignored even when this tab also has a new session open", () => {
    const s0 = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
    const s = play([
      { type: 'turn_started', turnId: 'tf', sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'delta', turnId: 'tf', sessionId: null, cwd: '/w', text: 'leak' },
    ], s0);
    expect(s.items).toEqual([]);
    expect(s.activeTurnId).toBeNull();
  });

  it("a turn on the open session started elsewhere streams in but never rewrites sessionId/account", () => {
    const s0 = play([historyOf('s', 'b')]);
    const s = play([
      { type: 'turn_started', turnId: 'to', sessionId: 's', cwd: '/w', account: 'c', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'delta', turnId: 'to', sessionId: 's', cwd: '/w', text: 'hi' },
      { type: 'turn_result', turnId: 'to', sessionId: 's2', cwd: '/w', ok: true, text: 'hi', badge: badge('c'), errorText: null },
    ], s0);
    expect(s.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'hi', streaming: false });
    expect(s.session).toMatchObject({ sessionId: 's', account: 'b' });
  });

  it('this tab\'s new-session turn is claimed at turn_started and sets sessionId/account at the end', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 'tm', sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'delta', turnId: 'tm', sessionId: 'n1', cwd: '/w', text: 'ok' },
      { type: 'turn_result', turnId: 'tm', sessionId: 'n1', cwd: '/w', ok: true, text: 'ok', badge: badge('b'), errorText: null },
    ], s);
    expect(s.items.at(-1)).toMatchObject({ text: 'ok', streaming: false });
    expect(s.session).toMatchObject({ sessionId: 'n1', account: 'b' });
  });

  it('permission requests are deduped by requestId (replays on reconnect) and carry session + cwd', () => {
    const req: ServerMessage = { type: 'permission_request', turnId: 't', sessionId: 's', cwd: '/w', requestId: 'r1', toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true };
    const s = play([req, req]);
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]).toMatchObject({ sessionId: 's', cwd: '/w' });
  });

  it('hello restores 중단 for a turn still running on the open session and clears a finished one', () => {
    const s0 = play([historyOf('s')]);
    const s1 = play([{ type: 'hello', usage, projects: [], running: [{ turnId: 'tr', sessionId: 's', cwd: '/w' }] }], s0);
    expect(s1.activeTurnId).toBe('tr');
    const s2 = play([{ type: 'hello', usage, projects: [], running: [] }], s1);
    expect(s2.activeTurnId).toBeNull();
  });

  it('history for a session with a running turn shows it as streaming', () => {
    const s = play([{ ...historyOf('s'), runningTurnId: 'tr' } as ServerMessage, { type: 'delta', turnId: 'tr', sessionId: 's', cwd: '/w', text: 'more' }]);
    expect(s.activeTurnId).toBe('tr');
    expect(s.items.at(-1)).toMatchObject({ kind: 'assistant', turnId: 'tr', streaming: true, text: 'more' });
  });

  it('after turn_retry the retry streams into a fresh text segment; the failed attempt is kept apart', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 'tr1', sessionId: 's', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'delta', turnId: 'tr1', sessionId: 's', cwd: '/w', text: 'partial' },
      { type: 'turn_retry', turnId: 'tr1', sessionId: 's', cwd: '/w', fromAccount: 'b', toAccount: 'c', reason: '한도 도달', attempt: 1 },
      { type: 'turn_started', turnId: 'tr1', sessionId: 's', cwd: '/w', account: 'c', model: 'opus', reason: 'r', attempt: 1 },
      { type: 'delta', turnId: 'tr1', sessionId: 's', cwd: '/w', text: 'ok' },
    ], s);
    expect(s.items[1]).toMatchObject({ text: 'ok', attempts: ['partial'] });
  });
});
