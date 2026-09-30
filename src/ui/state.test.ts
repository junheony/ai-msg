import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { fromTranscript, initialState, reducer, type AppState } from './state';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;

function play(msgs: ServerMessage[], start: AppState = initialState): AppState {
  return msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), start);
}

describe('reducer', () => {
  it('hello/usage/index update the top-level fields', () => {
    const s = play([{ type: 'hello', usage, projects: [] }]);
    expect(s.usage).toEqual(usage);
    expect(s.connected).toBe(true);
    expect(play([{ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [] }] }], s).projects[0]?.name).toBe('w');
  });

  it('streams a turn into one assistant item and finishes with a badge', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: '새 세션' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 't1', sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: '새 세션', attempt: 0 },
      { type: 'delta', turnId: 't1', text: 'o' },
      { type: 'delta', turnId: 't1', text: 'k' },
      { type: 'tool_call', turnId: 't1', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' } },
      { type: 'permission_request', turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } },
    ], s);
    expect(s.items[0]).toEqual({ kind: 'user', text: 'hi' });
    expect(s.items[1]).toMatchObject({ kind: 'assistant', turnId: 't1', text: 'ok', streaming: true, toolCalls: [{ toolUseId: 'tu1', name: 'Bash', result: null }] });
    expect(s.pending).toEqual([{ turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } }]);
    expect(s.activeTurnId).toBe('t1');
    s = play([
      { type: 'permission_resolved', requestId: 'r1', decision: 'once' },
      { type: 'tool_result', turnId: 't1', toolUseId: 'tu1', content: 'a.txt', isError: false },
      { type: 'turn_retry', turnId: 't1', fromAccount: 'b', toAccount: 'c', reason: '한도 도달', attempt: 1 },
      { type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', account: 'c', model: 'opus', reason: '재시도', attempt: 1 },
      { type: 'turn_result', turnId: 't1', sessionId: 's1', ok: true, text: 'ok', badge: { account: 'c', model: 'opus', reason: '재시도', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null }, errorText: null },
    ], s);
    expect(s.pending).toEqual([]);
    expect(s.items).toHaveLength(2);
    const a = s.items[1];
    expect(a).toMatchObject({ kind: 'assistant', streaming: false, badge: { account: 'c' }, notes: ['B → C: 한도 도달'], toolCalls: [{ result: 'a.txt' }] });
    expect(s.session).toMatchObject({ sessionId: 's1', account: 'c' });
    expect(s.activeTurnId).toBeNull();
  });

  it('uses the result text when no deltas arrived and records errors', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = play([
      { type: 'turn_started', turnId: 't2', sessionId: 's', cwd: '/w', account: 'a', model: 'sonnet', reason: 'r', attempt: 0 },
      { type: 'turn_result', turnId: 't2', sessionId: 's', ok: false, text: '', badge: { account: 'a', model: 'sonnet', reason: 'r', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null }, errorText: '401' },
      { type: 'error', turnId: null, message: 'boom' },
    ], s);
    expect(s.items[0]).toMatchObject({ kind: 'assistant', error: '401', text: '' });
    expect(s.error).toBe('boom');
    expect(reducer(s, { type: 'dismiss_error' }).error).toBeNull();
  });

  it('history replaces the items', () => {
    const s = play([{ type: 'history', sessionId: 's', cwd: '/w', account: 'b', messages: [
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
      { type: 'turn_result', turnId: 't4', sessionId: 's', ok: false, text: '', badge: null, errorText: 'engine exploded' },
    ], s);
    expect(s.activeTurnId).toBeNull();
    expect(s.session).toMatchObject({ sessionId: 's', account: null });
    expect(s.items[1]).toMatchObject({ streaming: false, error: 'engine exploded' });
  });
});
