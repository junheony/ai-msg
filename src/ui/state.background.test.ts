import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { initialState, reducer, type AppState, type ChatItem } from './state';

function play(msgs: ServerMessage[], start: AppState): AppState {
  return msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), start);
}

const scope = { sessionId: 's1', cwd: '/w' };
const assistants = (s: AppState) => s.panes[0]!.items.filter((it): it is Extract<ChatItem, { kind: 'assistant' }> => it.kind === 'assistant');

describe('reducer: background work (turn_background, 백그라운드 계속)', () => {
  it('marks the turn with live tasks, streams the continuation as its own item, then clears', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = play([
      { type: 'turn_started', turnId: 't1', ...scope, account: 'b', model: 'opus', reason: 'r', attempt: 0, engine: 'claude' },
      { type: 'delta', turnId: 't1', ...scope, text: 'launched' },
      { type: 'turn_result', turnId: 't1', ...scope, ok: true, text: 'launched', badge: null, errorText: null },
      { type: 'turn_background', turnId: 't1', ...scope, tasks: ['explore repo', 'review'] },
    ], s);
    expect(assistants(s)[0]).toMatchObject({ turnId: 't1', streaming: false, background: ['explore repo', 'review'] });
    expect(s.panes[0]!.activeTurnId).toBeNull();

    s = play([
      { type: 'turn_background', turnId: 't1', ...scope, tasks: [] },
      { type: 'turn_started', turnId: 't1:bg1', ...scope, account: 'b', model: 'opus', reason: '백그라운드 계속', attempt: 0, engine: 'claude' },
      { type: 'turn_notice', turnId: 't1:bg1', ...scope, message: '백그라운드 계속 — 백그라운드 작업이 끝나 이어서 진행합니다' },
      { type: 'delta', turnId: 't1:bg1', ...scope, text: 'found' },
    ], s);
    const items = assistants(s);
    expect(items).toHaveLength(2);
    expect(items[0]!.background).toEqual([]);
    expect(items[1]).toMatchObject({ turnId: 't1:bg1', text: 'found', streaming: true, notes: [expect.stringContaining('백그라운드 계속')] });
    expect(s.panes[0]!.activeTurnId).toBe('t1:bg1');
  });

  it('after a reload the indicator lands on the last assistant item', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = play([{ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', runningTurnId: null, messages: [
      { kind: 'user', text: 'go', ts: null },
      { kind: 'assistant', text: 'launched', model: null, toolCalls: [], ts: null },
    ] }], s);
    s = play([{ type: 'turn_background', turnId: 't9', ...scope, tasks: ['build'] }], s);
    expect(assistants(s).at(-1)).toMatchObject({ turnId: 't9', background: ['build'] });
  });
});
