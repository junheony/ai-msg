import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { answersFor, fromTranscript, initialState, reducer, sessionsToClose, type AppState, type PendingQuestion } from './state';

const pane = (s: AppState) => s.panes[0]!;

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;

function play(msgs: ServerMessage[], start: AppState = initialState): AppState {
  return msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), start);
}

describe('reducer', () => {
  it('hello/usage/index update the top-level fields', () => {
    const s = play([{ type: 'hello', usage, projects: [], running: [], codex: { available: false } }]);
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
      { type: 'permission_request', turnId: 't1', sessionId: null, cwd: '/w', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' },
    ], s);
    expect(pane(s).items[0]).toEqual({ kind: 'user', text: 'hi' });
    expect(pane(s).items[1]).toMatchObject({ kind: 'assistant', turnId: 't1', text: 'ok', streaming: true, toolCalls: [{ toolUseId: 'tu1', name: 'Bash', result: null }] });
    expect(s.pending).toMatchObject([{ turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, cwd: '/w' }]);
    expect(pane(s).activeTurnId).toBe('t1');
    s = play([
      { type: 'permission_resolved', requestId: 'r1', decision: 'once' },
      { type: 'tool_result', turnId: 't1', sessionId: null, cwd: '/w', toolUseId: 'tu1', content: 'a.txt', isError: false },
      { type: 'turn_retry', turnId: 't1', sessionId: null, cwd: '/w', fromAccount: 'b', toAccount: 'c', reason: '한도 도달', attempt: 1 },
      { type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', account: 'c', model: 'opus', reason: '재시도', attempt: 1 },
      { type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: true, text: 'ok', badge: { account: 'c', model: 'opus', reason: '재시도', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null }, errorText: null },
    ], s);
    expect(s.pending).toEqual([]);
    expect(pane(s).items).toHaveLength(2);
    const a = pane(s).items[1];
    expect(a).toMatchObject({ kind: 'assistant', streaming: false, badge: { account: 'c' }, notes: ['재시도 B → C: 한도 도달'], toolCalls: [{ result: 'a.txt' }] });
    expect(pane(s).session).toMatchObject({ sessionId: 's1', account: 'c' });
    expect(pane(s).activeTurnId).toBeNull();
  });

  it('uses the result text when no deltas arrived and records errors', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = play([
      { type: 'turn_started', turnId: 't2', sessionId: 's', cwd: '/w', account: 'a', model: 'sonnet', reason: 'r', attempt: 0 },
      { type: 'turn_result', turnId: 't2', sessionId: 's', cwd: '/w', ok: false, text: '', badge: { account: 'a', model: 'sonnet', reason: 'r', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null }, errorText: '401' },
      { type: 'error', turnId: null, message: 'boom' },
    ], s);
    expect(pane(s).items[0]).toMatchObject({ kind: 'assistant', error: '401', text: '' });
    expect(s.error).toBe('boom');
    expect(reducer(s, { type: 'dismiss_error' }).error).toBeNull();
  });

  it('history replaces the items', () => {
    const s = play([{ type: 'history', sessionId: 's', cwd: '/w', account: 'b', runningTurnId: null, messages: [
      { kind: 'user', text: 'q', ts: null },
      { kind: 'assistant', text: 'a', model: 'claude-opus-5-5', toolCalls: [{ id: 'tu', name: 'Read', input: {} }], ts: null },
      { kind: 'tool_result', toolUseId: 'tu', content: 'file', isError: false, ts: null },
    ] }]);
    expect(pane(s).session).toMatchObject({ sessionId: 's', cwd: '/w', account: 'b' });
    expect(pane(s).items).toEqual(fromTranscript([
      { kind: 'user', text: 'q', ts: null },
      { kind: 'assistant', text: 'a', model: 'claude-opus-5-5', toolCalls: [{ id: 'tu', name: 'Read', input: {} }], ts: null },
      { kind: 'tool_result', toolUseId: 'tu', content: 'file', isError: false, ts: null },
    ]));
    expect(pane(s).items[1]).toMatchObject({ kind: 'assistant', text: 'a', toolCalls: [{ toolUseId: 'tu', result: 'file' }] });
  });

  it('an error for the active turn clears activeTurnId and streaming so the tab can send again', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 't3', sessionId: 's', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'error', turnId: 't3', message: 'boom' },
    ], s);
    expect(pane(s).activeTurnId).toBeNull();
    expect(pane(s).items[1]).toMatchObject({ kind: 'assistant', streaming: false, error: 'boom' });
  });

  it('a turn_result without a badge (rejected run) still ends the turn', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 't4', sessionId: 's', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'turn_result', turnId: 't4', sessionId: 's', cwd: '/w', ok: false, text: '', badge: null, errorText: 'engine exploded' },
    ], s);
    expect(pane(s).activeTurnId).toBeNull();
    expect(pane(s).session).toMatchObject({ sessionId: 's', account: null });
    expect(pane(s).items[1]).toMatchObject({ streaming: false, error: 'engine exploded' });
  });

  it('turn_notice is a note on the running turn and does not end it', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 't5', sessionId: 's', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'turn_notice', turnId: 't5', sessionId: 's', cwd: '/w', message: '세션 이전 실패(x) — B 계정 유지' },
    ], s);
    expect(pane(s).activeTurnId).toBe('t5');
    expect(pane(s).items[1]).toMatchObject({ streaming: true, notes: ['세션 이전 실패(x) — B 계정 유지'], error: null });
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
    expect(pane(s).items).toEqual(pane(s0).items);
    expect(pane(s).session).toEqual(pane(s0).session);
    expect(pane(s).activeTurnId).toBeNull();
  });

  it("a foreign new-session turn (sessionId null) is ignored even when this tab also has a new session open", () => {
    const s0 = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
    const s = play([
      { type: 'turn_started', turnId: 'tf', sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'delta', turnId: 'tf', sessionId: null, cwd: '/w', text: 'leak' },
    ], s0);
    expect(pane(s).items).toEqual([]);
    expect(pane(s).activeTurnId).toBeNull();
  });

  it("a turn on the open session started elsewhere streams in but never rewrites sessionId/account", () => {
    const s0 = play([historyOf('s', 'b')]);
    const s = play([
      { type: 'turn_started', turnId: 'to', sessionId: 's', cwd: '/w', account: 'c', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'delta', turnId: 'to', sessionId: 's', cwd: '/w', text: 'hi' },
      { type: 'turn_result', turnId: 'to', sessionId: 's2', cwd: '/w', ok: true, text: 'hi', badge: badge('c'), errorText: null },
    ], s0);
    expect(pane(s).items.at(-1)).toMatchObject({ kind: 'assistant', text: 'hi', streaming: false });
    expect(pane(s).session).toMatchObject({ sessionId: 's', account: 'b' });
  });

  it('this tab\'s new-session turn is claimed at turn_started and sets sessionId/account at the end', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    s = play([
      { type: 'turn_started', turnId: 'tm', sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'delta', turnId: 'tm', sessionId: 'n1', cwd: '/w', text: 'ok' },
      { type: 'turn_result', turnId: 'tm', sessionId: 'n1', cwd: '/w', ok: true, text: 'ok', badge: badge('b'), errorText: null },
    ], s);
    expect(pane(s).items.at(-1)).toMatchObject({ text: 'ok', streaming: false });
    expect(pane(s).session).toMatchObject({ sessionId: 'n1', account: 'b' });
  });

  it('permission requests are deduped by requestId (replays on reconnect) and carry session + cwd', () => {
    const req: ServerMessage = { type: 'permission_request', turnId: 't', sessionId: 's', cwd: '/w', requestId: 'r1', toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' };
    const s = play([req, req]);
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]).toMatchObject({ sessionId: 's', cwd: '/w' });
  });

  it('hello restores 중단 for a turn still running on the open session and clears a finished one', () => {
    const s0 = play([historyOf('s')]);
    const s1 = play([{ type: 'hello', usage, projects: [], running: [{ turnId: 'tr', sessionId: 's', cwd: '/w' }], codex: { available: false } }], s0);
    expect(pane(s1).activeTurnId).toBe('tr');
    const s2 = play([{ type: 'hello', usage, projects: [], running: [], codex: { available: false } }], s1);
    expect(pane(s2).activeTurnId).toBeNull();
  });

  it('history for a session with a running turn shows it as streaming', () => {
    const s = play([{ ...historyOf('s'), runningTurnId: 'tr' } as ServerMessage, { type: 'delta', turnId: 'tr', sessionId: 's', cwd: '/w', text: 'more' }]);
    expect(pane(s).activeTurnId).toBe('tr');
    expect(pane(s).items.at(-1)).toMatchObject({ kind: 'assistant', turnId: 'tr', streaming: true, text: 'more' });
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
    expect(pane(s).items[1]).toMatchObject({ text: 'ok', attempts: ['partial'] });
  });

  it('an error for a turn that never started (e.g. unknown session) unlocks the composer', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 'gone', cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    expect(pane(s).awaitingStart).toBe(true);
    s = play([{ type: 'error', turnId: 'tz', message: '세션을 찾을 수 없습니다: gone' }], s);
    expect(pane(s).awaitingStart).toBe(false);
    expect(pane(s).activeTurnId).toBeNull();
  });
});

describe('panes (D6)', () => {
  const started = (turnId: string, sessionId: string | null, cwd: string): ServerMessage => ({ type: 'turn_started', turnId, sessionId, cwd, account: 'b', model: 'opus', reason: 'r', attempt: 0 });

  it('add/close/focus panes within 1..4', () => {
    let s = reducer(initialState, { type: 'add_pane' });
    s = reducer(s, { type: 'add_pane' });
    s = reducer(s, { type: 'add_pane' });
    expect(s.panes.map((p) => p.id)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(reducer(s, { type: 'add_pane' }).panes).toHaveLength(4);
    s = reducer(s, { type: 'focus_pane', paneId: 'p2' });
    expect(s.activePaneId).toBe('p2');
    s = reducer(s, { type: 'close_pane', paneId: 'p2' });
    expect(s.panes.map((p) => p.id)).toEqual(['p0', 'p1', 'p3']);
    expect(s.activePaneId).toBe('p0');
    s = reducer(reducer(s, { type: 'close_pane', paneId: 'p0' }), { type: 'close_pane', paneId: 'p1' });
    expect(reducer(s, { type: 'close_pane', paneId: 'p3' }).panes).toHaveLength(1);
  });

  it('turn events reach the pane viewing that session; history targets the matching pane', () => {
    let s = reducer(initialState, { type: 'add_pane' });
    s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one', paneId: 'p0' });
    s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'two', paneId: 'p1' });
    s = play([started('t2', 's2', '/w'), { type: 'delta', turnId: 't2', sessionId: 's2', cwd: '/w', text: 'hi' }], s);
    expect(s.panes[0]?.items).toEqual([]);
    expect(s.panes[1]?.items[0]).toMatchObject({ kind: 'assistant', turnId: 't2', text: 'hi' });
    s = play([{ type: 'history', sessionId: 's1', cwd: '/w', account: 'gpt', engine: 'codex', sandbox: 'read-only', runningTurnId: null, messages: [{ kind: 'user', text: 'q', ts: null }] }], s);
    expect(s.panes[0]?.items).toEqual([{ kind: 'user', text: 'q' }]);
    expect(s.panes[0]?.session).toMatchObject({ engine: 'codex', sandbox: 'read-only', account: 'gpt' });
    expect(s.panes[1]?.items).toHaveLength(1);
  });

  it('only the first waiting pane with a matching new session claims a turn_started', () => {
    let s = reducer(initialState, { type: 'add_pane' });
    s = reducer(s, { type: 'open', sessionId: null, cwd: '/w', title: 'new', paneId: 'p0' });
    s = reducer(s, { type: 'open', sessionId: null, cwd: '/w', title: 'new', paneId: 'p1' });
    s = reducer(s, { type: 'sent', text: 'a', paneId: 'p0' });
    s = reducer(s, { type: 'sent', text: 'b', paneId: 'p1' });
    s = play([started('ta', null, '/w')], s);
    expect(s.panes[0]?.myTurns).toEqual(['ta']);
    expect(s.panes[1]?.myTurns).toEqual([]);
    expect(s.panes[1]?.awaitingStart).toBe(true);
    s = play([started('tb', null, '/w')], s);
    expect(s.panes[1]?.myTurns).toEqual(['tb']);
  });

  it('set_engine switches the model to the engine default; codexAvailable comes from hello', () => {
    let s = reducer(initialState, { type: 'set_engine', engine: 'codex' });
    expect(pane(s)).toMatchObject({ engine: 'codex', model: 'gpt-6-sol' });
    s = reducer(s, { type: 'set_model', model: 'gpt-6-astra' });
    s = reducer(s, { type: 'set_engine', engine: 'claude' });
    expect(pane(s).model).toBe('opus');
    s = reducer(s, { type: 'set_sandbox', sandbox: 'workspace-write' });
    expect(pane(s).sandbox).toBe('workspace-write');
    expect(play([{ type: 'hello', usage, projects: [], running: [], codex: { available: true } }]).codexAvailable).toBe(true);
  });

  it('questions are global, deduped, closed by question_resolved or the turn result; attachments ride the sent item', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = reducer(s, { type: 'attach', attachment: { id: 'a1', name: 'shot.png', size: 3, isImage: true } });
    s = reducer(s, { type: 'sent', text: 'look', attachments: ['shot.png'] });
    expect(pane(s).items[0]).toEqual({ kind: 'user', text: 'look', attachments: ['shot.png'] });
    expect(pane(s).attachments).toEqual([]);
    const q: ServerMessage = { type: 'question_request', turnId: 't1', sessionId: null, cwd: '/w', requestId: 'q1', questions: [{ question: 'Which?', header: 'H', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }], multiSelect: false }] };
    s = play([q, q], s);
    expect(s.questions).toHaveLength(1);
    expect(play([{ type: 'question_resolved', requestId: 'q1', answers: null }], s).questions).toEqual([]);
    s = play([started('t1', null, '/w'), { type: 'turn_result', turnId: 't1', sessionId: 's9', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null }], s);
    expect(s.questions).toEqual([]);
  });

  it('PF13: history resets a model that does not belong to the session engine', () => {
    const hist = (sessionId: string, engine: 'claude' | 'codex'): ServerMessage => ({ type: 'history', sessionId, cwd: '/w', account: engine === 'codex' ? 'gpt' : 'b', engine, sandbox: engine === 'codex' ? 'read-only' : null, runningTurnId: null, messages: [] });
    let s = reducer(initialState, { type: 'set_model', model: 'gpt-6-astra' });
    s = reducer(s, { type: 'open', sessionId: 'c1', cwd: '/w', title: 'c' });
    s = play([hist('c1', 'claude')], s);
    expect(pane(s).model).toBe('opus');
    s = reducer(s, { type: 'set_model', model: 'fable' });
    s = play([hist('c1', 'claude')], s);
    expect(pane(s).model).toBe('fable');
    s = reducer(s, { type: 'open', sessionId: 'x1', cwd: '/w', title: 'x' });
    s = play([hist('x1', 'codex')], s);
    expect(pane(s).model).toBe('gpt-6-sol');
    s = reducer(s, { type: 'set_model', model: 'gpt-6-astra' });
    s = play([hist('x1', 'codex')], s);
    expect(pane(s).model).toBe('gpt-6-astra');
  });

  it('history with sandbox null or missing engine/sandbox falls back safely', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = play([{ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [] }], s);
    expect(pane(s).session).toMatchObject({ engine: 'claude', sandbox: null });
    // An older server (or a malformed frame) that omits both fields must not crash or leak undefined.
    const legacy = { type: 'history', sessionId: 's1', cwd: '/w', account: 'b', runningTurnId: null, messages: [] } as unknown as ServerMessage;
    s = play([legacy], s);
    expect(pane(s).session).toMatchObject({ engine: 'claude', sandbox: null });
  });

  it('sessionsToClose lists sessions no pane views any more (close_session on pane close / switch)', () => {
    let s = reducer(initialState, { type: 'add_pane' });
    s = reducer(s, { type: 'add_pane' });
    s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one', paneId: 'p0' });
    s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'two', paneId: 'p1' });
    s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'two', paneId: 'p2' });
    // Switching p0 to another session releases s1.
    let next = reducer(s, { type: 'open', sessionId: 's3', cwd: '/w', title: 'three', paneId: 'p0' });
    expect(sessionsToClose(s, next)).toEqual(['s1']);
    // Re-opening the same session releases nothing; a new (null) session is never closed.
    expect(sessionsToClose(s, reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one', paneId: 'p0' }))).toEqual([]);
    // Closing p1 keeps s2 (p2 still views it); closing p2 afterwards releases it.
    s = next;
    next = reducer(s, { type: 'close_pane', paneId: 'p1' });
    expect(sessionsToClose(s, next)).toEqual([]);
    const after = reducer(next, { type: 'close_pane', paneId: 'p2' });
    expect(sessionsToClose(next, after)).toEqual(['s2']);
    // A new session that gets its id from turn_result is not "closed" by the id change.
    let n = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    n = reducer(n, { type: 'sent', text: 'hi' });
    const n1 = play([started('tn', null, '/w'), { type: 'turn_result', turnId: 'tn', sessionId: 'sn', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null }], n);
    expect(sessionsToClose(n, n1)).toEqual([]);
    expect(sessionsToClose(n1, reducer(n1, { type: 'open', sessionId: null, cwd: '/w', title: 'n2' }))).toEqual(['sn']);
  });

  it('answersFor keys each answer by the exact question text', () => {
    const q: PendingQuestion = { turnId: 't', sessionId: 's', cwd: '/w', requestId: 'q', questions: [
      { question: 'Which DB?  ', header: 'DB', options: [{ label: 'pg', description: '' }], multiSelect: false },
      { question: 'Which features?', header: 'F', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }], multiSelect: true },
    ] };
    expect(answersFor(q, ['pg', ['a', 'b']])).toEqual({ 'Which DB?  ': 'pg', 'Which features?': 'a, b' });
    // Unanswered questions are omitted rather than sent as empty strings.
    expect(answersFor(q, ['', []])).toEqual({});
  });
});
