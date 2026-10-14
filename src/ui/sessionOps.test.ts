import { describe, expect, it } from 'vitest';
import type { ClientMessage, ServerMessage, TurnBadge } from '../shared/protocol';
import { sendFromPane } from './components/Pane';
import { initialState, reducer, type AppState, type ChatItem } from './state';

const msg = (s: AppState, m: ServerMessage) => reducer(s, { type: 'server', msg: m });
const pane = (s: AppState) => s.panes[0]!;
const sendOf = (s: AppState): Extract<ClientMessage, { type: 'send' }> => {
  const out: ClientMessage[] = [];
  sendFromPane(pane(s), 'hi', [], () => {}, (m) => out.push(m));
  return out[0] as Extract<ClientMessage, { type: 'send' }>;
};
const open = (sessionId: string | null = 's1') => reducer(initialState, { type: 'open', sessionId, cwd: '/w/one', title: 't' });
const assistants = (s: AppState) => pane(s).items.filter((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant');
const badge: TurnBadge = { account: 'b', model: 'opus', reason: '', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 } as never, modelNote: null };

describe('작업 폴더 바꾸기 · 복제 · 턴별 모델 (reducer)', () => {
  it('session_cwd moves every pane showing that session to the new folder; others stay', () => {
    let s = open('s1');
    s = msg(s, { type: 'session_cwd', sessionId: 's1', cwd: '/w/two' });
    expect(pane(s).session?.cwd).toBe('/w/two');
    s = msg(s, { type: 'session_cwd', sessionId: 'other', cwd: '/w/three' });
    expect(pane(s).session?.cwd).toBe('/w/two');
  });

  it('session_duplicate opens a new session with the original\'s folder and settings; its first send carries the title', () => {
    let s = open('s1');
    s = msg(s, { type: 'session_duplicate', from: 's1', cwd: '/w/one', engine: 'claude', model: 'fable', title: '원래 (복사)', accountPin: null, permissionMode: 'acceptEdits' });
    const p = pane(s);
    expect(p.session).toMatchObject({ sessionId: null, cwd: '/w/one', title: '원래 (복사)', engine: 'claude', newTitle: '원래 (복사)', permissionMode: 'acceptEdits' });
    expect(p.items).toEqual([]);
    expect(p).toMatchObject({ engine: 'claude', model: 'fable', modelPicked: true });
    expect(sendOf(s)).toMatchObject({ sessionId: null, cwd: '/w/one', engine: 'claude', model: 'fable', title: '원래 (복사)', permissionMode: 'acceptEdits' });
  });

  it('a GPT duplicate keeps its sandbox; an existing session never sends a title', () => {
    let s = msg(open('s1'), { type: 'session_duplicate', from: 'g1', cwd: '/w/one', engine: 'codex', model: 'gpt-6-astra', title: 'g (복사)', sandbox: 'read-only' });
    expect(pane(s)).toMatchObject({ engine: 'codex', model: 'gpt-6-astra', sandbox: 'read-only' });
    expect(sendOf(s)).toMatchObject({ engine: 'codex', sandbox: 'read-only', title: 'g (복사)' });
    s = open('s1');
    expect(sendOf(s)).not.toHaveProperty('title');
  });

  it('the turn model: from the transcript for history turns, from turn_result (else its badge) for live ones', () => {
    let s = open('s1');
    s = msg(s, { type: 'history', sessionId: 's1', cwd: '/w/one', account: 'b', engine: 'claude', runningTurnId: null, messages: [{ kind: 'user', text: 'q', ts: null }, { kind: 'assistant', text: 'a', model: 'claude-opus-5-5', toolCalls: [], ts: null }, { kind: 'user', text: 'q2', ts: null }, { kind: 'assistant', text: 'b', model: null, toolCalls: [], ts: null }] });
    expect(assistants(s).map((a) => a.model)).toEqual(['claude-opus-5-5', undefined]);
    s = msg(s, { type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w/one', account: 'b', model: 'opus', reason: '', attempt: 0, engine: 'claude' });
    s = msg(s, { type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w/one', ok: true, text: 'done', badge, errorText: null, model: 'fable' });
    expect(assistants(s).at(-1)!.model).toBe('fable');
    s = msg(s, { type: 'turn_started', turnId: 't2', sessionId: 's1', cwd: '/w/one', account: 'b', model: 'opus', reason: '', attempt: 0, engine: 'claude' });
    s = msg(s, { type: 'turn_result', turnId: 't2', sessionId: 's1', cwd: '/w/one', ok: true, text: 'done', badge, errorText: null });
    expect(assistants(s).at(-1)!.model).toBe('opus');
  });
});
