import { describe, expect, it } from 'vitest';
import { HANDOFF_PROMPT, THREAD_LOCKED_MESSAGE, codexHandoffExcerpt, codexHandoffMessage, handoffFirstMessage } from '../shared/handoff';
import { DEFAULT_MODEL } from '../shared/models';
import { nextPermMode } from '../shared/permission';
import { setFeatures } from './features';
import { ACCEPTED_REFS_TTL_MS, type ServerMessage } from '../shared/protocol';
import { PANE_LIMIT, answersFor, engineOf, fromTranscript, modelFor, initialState, newPane, nextQueued, openPanes, nextUserN, paneMode, reducer, restoreSentFiles, sessionsToClose, type AppState, type ChatItem, type PendingQuestion } from './state';

const pane = (s: AppState) => s.panes[0]!;

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;

function play(msgs: ServerMessage[], start: AppState = initialState): AppState {
  return msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), start);
}

/** The app dispatches `open` (recording the id on the pane) before it sends open_session; history only lands on such a pane. */
const openedOn = (sessionId: string): AppState => reducer(initialState, { type: 'open', sessionId, cwd: '/w', title: 't' });

describe('reducer', () => {
  it('hello/usage/index update the top-level fields', () => {
    const s = play([{ type: 'hello', usage, projects: [], running: [], codex: { available: false } }]);
    expect(s.usage).toEqual(usage);
    expect(s.connected).toBe(true);
    expect(play([{ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [] }] }], s).projects[0]?.name).toBe('w');
    expect(s.gemini).toBeNull();
    const g = { available: true, loggedIn: { g1: true, g2: false } };
    expect(play([{ type: 'hello', usage, projects: [], running: [], codex: { available: false }, gemini: g }]).gemini).toEqual(g);
  });

  it('engineOf / modelFor know Gemini; the 자동 engine never keeps a Gemini model', () => {
    expect(engineOf('gemini-flash')).toBe('gemini');
    expect(modelFor('gemini', 'opus')).toBe('gemini-pro');
    expect(modelFor('gemini', 'gemini-flash')).toBe('gemini-flash');
    expect(modelFor('claude', 'gemini-pro')).toBe('fable');
    let s = reducer(initialState, { type: 'set_model', model: 'gemini-flash' });
    s = reducer(s, { type: 'set_engine', engine: 'auto' });
    expect(s.panes[0]?.model).toBe('auto');
  });

  it('engineOf / modelFor know Grok; set_engine grok picks Grok 4.7; the 자동 engine never keeps a Grok model', () => {
    expect(engineOf('grok-4.5')).toBe('grok');
    expect(modelFor('grok', 'opus')).toBe('grok-4.7');
    expect(modelFor('grok', 'grok-4.6')).toBe('grok-4.6');
    expect(modelFor('grok', 'grok-4.5')).toBe('grok-4.5');
    let s = reducer(initialState, { type: 'set_engine', engine: 'grok' });
    expect(s.panes[0]).toMatchObject({ engine: 'grok', model: 'grok-4.7' });
    s = reducer(s, { type: 'set_engine', engine: 'auto' });
    expect(s.panes[0]?.model).toBe('auto');
  });

  it('a pane engine grok the server cannot run (no grok feature) goes back to Claude on hello; hello.grok is kept', () => {
    const grokPane = reducer(initialState, { type: 'set_engine', engine: 'grok' });
    setFeatures(['grok']);
    let s = play([{ type: 'hello', usage, projects: [], running: [], codex: { available: false }, grok: { bin: true } }], grokPane);
    expect(s.panes[0]).toMatchObject({ engine: 'grok', model: 'grok-4.7' });
    expect(s.grok).toEqual({ bin: true });
    setFeatures([]);
    s = play([{ type: 'hello', usage, projects: [], running: [], codex: { available: false }, grok: { bin: false } }], grokPane);
    expect(s.panes[0]).toMatchObject({ engine: 'claude', model: DEFAULT_MODEL });
    s = play([{ type: 'hello', usage, projects: [], running: [], codex: { available: false } }], grokPane);
    expect(s.panes[0]?.engine).toBe('claude');
    expect(s.grok).toBeNull();
  });

  it('pins come from hello/index and set_pins; an index without pins keeps them (F2)', () => {
    expect(initialState.pins).toEqual([]);
    let s = play([{ type: 'hello', usage, projects: [], pins: ['a', 'b'], running: [], codex: { available: false } }]);
    expect(s.pins).toEqual(['a', 'b']);
    s = play([{ type: 'index', projects: [] }], s);
    expect(s.pins).toEqual(['a', 'b']);
    s = play([{ type: 'index', projects: [], pins: ['b'] }], s);
    expect(s.pins).toEqual(['b']);
    expect(reducer(s, { type: 'set_pins', pins: ['c'] }).pins).toEqual(['c']);
    expect(reducer(s, { type: 'show_error', message: '고정 실패' }).error).toBe('고정 실패');
  });

  it('session icons come from hello/index and set_session_icons; an index without them keeps them', () => {
    expect(initialState.sessionIcons).toEqual({});
    let s = play([{ type: 'hello', usage, projects: [], sessionIcons: { a: '🚀' }, running: [], codex: { available: false } }]);
    expect(s.sessionIcons).toEqual({ a: '🚀' });
    s = play([{ type: 'index', projects: [] }], s);
    expect(s.sessionIcons).toEqual({ a: '🚀' });
    s = play([{ type: 'index', projects: [], sessionIcons: {} }], s);
    expect(s.sessionIcons).toEqual({});
    expect(reducer(s, { type: 'set_session_icons', sessionIcons: { b: 'glyph:leaf' } }).sessionIcons).toEqual({ b: 'glyph:leaf' });
  });

  it('adopts the server-known title into a pane once the index reports it (finding 3)', () => {
    let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 'w · 새 세션' });
    const sessionEntry = { sessionId: 's1', account: 'b', cwd: '/w', projectDir: '/w', file: 'f', title: 'Reply with exactly: ok', lastModified: 0, sizeBytes: 0 } as const;
    s = play([{ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [sessionEntry] }] }], s);
    expect(pane(s).session?.title).toBe('Reply with exactly: ok');
  });

  it('a new 자동 session routed to Gemini follows the picked model; one routed to Claude keeps 자동', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: '새 세션' });
    expect(pane(s)).toMatchObject({ engine: 'auto', model: 'auto' });
    s = reducer(s, { type: 'sent', text: '이 함수 설명해 줘' });
    s = play([{ type: 'turn_started', turnId: 't1', sessionId: null, cwd: '/w', account: 'g1', model: 'gemini-flash', reason: '자동 · 설명 → Gemini Flash', attempt: 0, engine: 'gemini' }], s);
    expect(pane(s)).toMatchObject({ model: 'gemini-flash', session: { engine: 'gemini' } });
    let c = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: '새 세션' });
    c = reducer(c, { type: 'sent', text: 'hi' });
    c = play([{ type: 'turn_started', turnId: 't1', sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: '자동 · 구현 → Claude Opus', attempt: 0 }], c);
    expect(pane(c).model).toBe('auto');
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
    expect(pane(s).items[0]).toEqual({ kind: 'user', text: 'hi', n: 0, at: expect.any(Number) });
    expect(pane(s).items[1]).toMatchObject({ kind: 'assistant', turnId: 't1', text: 'ok', streaming: true, toolCalls: [{ toolUseId: 'tu1', name: 'Bash', result: null, textAt: 2 }] });
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
    // The retry restarted the text: the old call's text mark (간결 모드 fold point) is gone.
    expect((a as { toolCalls: { textAt?: number }[] }).toolCalls[0]!.textAt).toBeUndefined();
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
    ] }], openedOn('s'));
    expect(pane(s).session).toMatchObject({ sessionId: 's', cwd: '/w', account: 'b' });
    expect(pane(s).items).toEqual(fromTranscript([
      { kind: 'user', text: 'q', ts: null },
      { kind: 'assistant', text: 'a', model: 'claude-opus-5-5', toolCalls: [{ id: 'tu', name: 'Read', input: {} }], ts: null },
      { kind: 'tool_result', toolUseId: 'tu', content: 'file', isError: false, ts: null },
    ]));
    expect(pane(s).items[1]).toMatchObject({ kind: 'assistant', text: 'a', toolCalls: [{ toolUseId: 'tu', result: 'file' }] });
  });

  it('fromTranscript turns a system entry into a system row between the two assistant replies', () => {
    const items = fromTranscript([
      { kind: 'user', text: 'q', ts: null, n: 0 },
      { kind: 'assistant', text: 'a', model: 'claude-opus-5-5', toolCalls: [], ts: null },
      { kind: 'system', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴', text: 'Stop hook feedback:\nmore', ts: null },
      { kind: 'assistant', text: 'b', model: 'claude-opus-5-5', toolCalls: [], ts: null },
    ]);
    expect(items.map((it) => it.kind)).toEqual(['user', 'assistant', 'system', 'assistant']);
    expect(items[2]).toEqual({ kind: 'system', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴', text: 'Stop hook feedback:\nmore' });
    expect(nextUserN(items, null)).toBe(1);
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

  it('loading: open of a saved session sets it until its history (or an error about it) arrives; a new chat never loads', () => {
    expect(pane(openedOn('s')).loading).toBe(true);
    expect(pane(play([historyOf('s')], openedOn('s'))).loading).toBe(false);
    expect(pane(play([{ type: 'error', turnId: null, message: '기록을 읽지 못했습니다', sessionId: 's' }], openedOn('s'))).loading).toBe(false);
    // an app-wide error (no session) can't be waited on: the placeholder must not hang
    expect(pane(play([{ type: 'error', turnId: null, message: '잘못된 요청' }], openedOn('s'))).loading).toBe(false);
    expect(pane(reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' })).loading).toBe(false);
    expect(pane(reducer(openedOn('s'), { type: 'clear_pane' })).loading).toBe(false);
  });

  it("another session's turn events leave the open session untouched", () => {
    const s0 = play([historyOf('s')], openedOn('s'));
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
    const s0 = play([historyOf('s', 'b')], openedOn('s'));
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

  it('an "already resolved" error naming a card removes that card only, with no error and no pane touched', () => {
    const req: ServerMessage = { type: 'permission_request', turnId: 't', sessionId: 's', cwd: '/w', requestId: 'r1', toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' };
    const other: ServerMessage = { ...req, requestId: 'r2' } as ServerMessage;
    const q: ServerMessage = { type: 'question_request', turnId: 't', sessionId: 's', cwd: '/w', requestId: 'q1', questions: [{ question: 'Which?', header: 'H', options: [{ label: 'a', description: '' }], multiSelect: false }] };
    let s = reducer(initialState, { type: 'add_pane' });
    s = reducer(s, { type: 'open', sessionId: null, cwd: '/w', title: 'n', paneId: 'p0' });
    s = reducer(s, { type: 'sent', text: 'a', paneId: 'p0' });
    s = { ...s, panes: s.panes.map((p) => ({ ...p, loading: true })) };
    const before = s.panes;
    s = play([req, other, q, { type: 'error', turnId: null, message: '이미 처리된 권한 요청입니다', requestId: 'r1' }], s);
    expect(s.pending.map((p) => p.requestId)).toEqual(['r2']);
    s = play([{ type: 'error', turnId: null, message: '이미 처리된 질문입니다', requestId: 'q1' }], s);
    expect(s.questions).toEqual([]);
    expect(s.error).toBeNull();
    expect(s.panes).toBe(before);
  });

  it('hello restores 중단 for a turn still running on the open session and clears a finished one', () => {
    const s0 = play([historyOf('s')], openedOn('s'));
    const s1 = play([{ type: 'hello', usage, projects: [], running: [{ turnId: 'tr', sessionId: 's', cwd: '/w' }], codex: { available: false } }], s0);
    expect(pane(s1).activeTurnId).toBe('tr');
    const s2 = play([{ type: 'hello', usage, projects: [], running: [], codex: { available: false } }], s1);
    expect(pane(s2).activeTurnId).toBeNull();
  });

  it('history for a session with a running turn shows it as streaming', () => {
    const s = play([{ ...historyOf('s'), runningTurnId: 'tr' } as ServerMessage, { type: 'delta', turnId: 'tr', sessionId: 's', cwd: '/w', text: 'more' }], openedOn('s'));
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

  it('add/close/focus panes: no user-facing ceiling (only the PANE_LIMIT sanity cap), never fewer than one', () => {
    let s = reducer(initialState, { type: 'add_pane' });
    s = reducer(s, { type: 'add_pane' });
    s = reducer(s, { type: 'add_pane' });
    s = reducer(s, { type: 'add_pane' });
    expect(s.panes.map((p) => p.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(reducer(s, { type: 'add_pane' }).panes).toHaveLength(6);
    let many = s;
    for (let i = 0; i < PANE_LIMIT + 3; i++) many = reducer(many, { type: 'add_pane' });
    expect(many.panes).toHaveLength(PANE_LIMIT);
    s = reducer(s, { type: 'close_pane', paneId: 'p4' });
    s = reducer(s, { type: 'focus_pane', paneId: 'p2' });
    expect(s.activePaneId).toBe('p2');
    s = reducer(s, { type: 'close_pane', paneId: 'p2' });
    expect(s.panes.map((p) => p.id)).toEqual(['p0', 'p1', 'p3']);
    expect(s.activePaneId).toBe('p0');
    s = reducer(reducer(s, { type: 'close_pane', paneId: 'p0' }), { type: 'close_pane', paneId: 'p1' });
    expect(reducer(s, { type: 'close_pane', paneId: 'p3' }).panes).toHaveLength(1);
  });

  it('move_pane reorders the docked panes; floating cards keep their array slots', () => {
    let s = initialState;
    for (let i = 0; i < 3; i++) s = reducer(s, { type: 'add_pane' }); // p0 p1 p2 p3
    s = reducer(s, { type: 'move_pane', paneId: 'p0', to: 2 });
    expect(s.panes.map((p) => p.id)).toEqual(['p1', 'p2', 'p0', 'p3']);
    s = reducer(s, { type: 'move_pane', paneId: 'p3', to: 0 });
    expect(s.panes.map((p) => p.id)).toEqual(['p3', 'p1', 'p2', 'p0']);
    expect(reducer(s, { type: 'move_pane', paneId: 'p3', to: 0 })).toBe(s); // same place: no change
    expect(reducer(s, { type: 'move_pane', paneId: 'nope', to: 0 })).toBe(s);
    s = reducer(s, { type: 'move_pane', paneId: 'p3', to: 99 }); // clamped to the end
    expect(s.panes.map((p) => p.id)).toEqual(['p1', 'p2', 'p0', 'p3']);
    const rect = { x: 10, y: 10, w: 400, h: 300 };
    s = reducer(s, { type: 'float_pane', paneId: 'p2', rect });
    s = reducer(s, { type: 'move_pane', paneId: 'p3', to: 0 }); // among p1 p0 p3 → p3 p1 p0; p2 stays at index 1
    expect(s.panes.map((p) => p.id)).toEqual(['p3', 'p2', 'p1', 'p0']);
    expect(s.panes[1]!.float).toEqual(rect);
  });

  it('float_pane / dock_pane / move_float: a pane off the rail and back; the last docked pane never floats', () => {
    let s = reducer(initialState, { type: 'add_pane' }); // p0 p1
    const rect = { x: 20, y: 30, w: 420, h: 320 };
    expect(reducer(s, { type: 'float_pane', paneId: 'p9', rect })).toBe(s);
    s = reducer(s, { type: 'float_pane', paneId: 'p0', rect });
    expect(s.panes[0]!.float).toEqual(rect);
    expect(s.activePaneId).toBe('p0');
    expect(reducer(s, { type: 'float_pane', paneId: 'p1', rect })).toBe(s); // p1 is the only docked pane
    expect(reducer(s, { type: 'float_pane', paneId: 'p0', rect })).toBe(s); // already floating
    const moved = { ...rect, x: 200 };
    s = reducer(s, { type: 'move_float', paneId: 'p0', rect: moved });
    expect(s.panes[0]!.float).toEqual(moved);
    expect(reducer(s, { type: 'move_float', paneId: 'p0', rect: moved })).toBe(s);
    expect(reducer(s, { type: 'move_float', paneId: 'p1', rect: moved })).toBe(s); // docked: nothing to move
    // Another pane and a dock at index 1 (between p1 and p2).
    s = reducer(s, { type: 'add_pane' }); // p0(float) p1 p2
    s = reducer(s, { type: 'focus_pane', paneId: 'p2' });
    s = reducer(s, { type: 'dock_pane', paneId: 'p0', to: 1 });
    expect(s.panes.map((p) => [p.id, !!p.float])).toEqual([['p1', false], ['p0', false], ['p2', false]]);
    expect(s.activePaneId).toBe('p0');
    expect(reducer(s, { type: 'dock_pane', paneId: 'p0' })).toBe(s); // not floating
    // Default dock slot: the right end; the width is the average of the others, not the stale one it left with.
    s = reducer(s, { type: 'resize_panes', sizes: { p1: 2.5, p0: 2, p2: 4 } });
    s = reducer(s, { type: 'float_pane', paneId: 'p1', rect });
    s = reducer(s, { type: 'dock_pane', paneId: 'p1' });
    expect(s.panes.map((p) => p.id)).toEqual(['p0', 'p2', 'p1']);
    expect(s.panes[2]!.size).toBe(3);
  });

  it('toggle_max_float: a card fills the body and back; a user move un-maximizes, keepMax keeps it; dock forgets it', () => {
    let s = reducer(initialState, { type: 'add_pane' }); // p0 p1
    const rect = { x: 40, y: 50, w: 400, h: 300 };
    const bounds = { w: 1200, h: 800 };
    expect(reducer(s, { type: 'toggle_max_float', paneId: 'p0', bounds })).toBe(s); // docked: nothing
    s = reducer(s, { type: 'float_pane', paneId: 'p0', rect });
    s = reducer(s, { type: 'toggle_max_float', paneId: 'p0', bounds });
    expect(s.panes[0]).toMatchObject({ float: { x: 0, y: 0, w: 1200, h: 800 }, floatBefore: rect });
    s = reducer(s, { type: 'toggle_max_float', paneId: 'p0', bounds });
    expect(s.panes[0]!.float).toEqual(rect);
    expect(s.panes[0]).not.toHaveProperty('floatBefore');
    expect(reducer(reducer(s, { type: 'move_float', paneId: 'p0', rect: { x: 0, y: 0, w: 1200, h: 800 } }), { type: 'toggle_max_float', paneId: 'p0', bounds }).panes[0]).not.toHaveProperty('floatBefore'); // already filling the body
    const filled = reducer(s, { type: 'move_float', paneId: 'p0', rect: { x: 0, y: 0, w: 1200, h: 800 } });
    expect(reducer(filled, { type: 'toggle_max_float', paneId: 'p0', bounds })).toBe(filled);
    // Restored at another body size with `at`: the restored box is remembered for that size (maximizing records nothing).
    const big = reducer(s, { type: 'toggle_max_float', paneId: 'p0', bounds, at: '1200x800' });
    expect(big.panes[0]!.floatBySize).toBeUndefined();
    const back = reducer(big, { type: 'toggle_max_float', paneId: 'p0', bounds: { w: 800, h: 600 }, at: '800x600' });
    expect(back.panes[0]!.floatBySize).toEqual({ '800x600': rect });
    // A tiny body: still at least the minimum size.
    const tiny = reducer(s, { type: 'toggle_max_float', paneId: 'p0', bounds: { w: 100, h: 100 } });
    expect(tiny.panes[0]!.float).toMatchObject({ w: 320, h: 240 });
    // The body resized under a maximized card (keepMax): still maximized; a user move un-maximizes it.
    s = reducer(s, { type: 'toggle_max_float', paneId: 'p0', bounds });
    s = reducer(s, { type: 'move_float', paneId: 'p0', rect: { x: 0, y: 0, w: 800, h: 600 }, keepMax: true });
    expect(s.panes[0]).toMatchObject({ float: { x: 0, y: 0, w: 800, h: 600 }, floatBefore: rect });
    const moved = reducer(s, { type: 'move_float', paneId: 'p0', rect: { x: 0, y: 0, w: 800, h: 600 } });
    expect(moved.panes[0]).not.toHaveProperty('floatBefore'); // same box, still a change: no longer maximized
    expect(moved.panes[0]!.float).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    const docked = reducer(s, { type: 'dock_pane', paneId: 'p0' });
    expect(docked.panes.find((p) => p.id === 'p0')).not.toHaveProperty('floatBefore');
    // A fresh float starts un-maximized.
    expect(reducer(docked, { type: 'float_pane', paneId: 'p0', rect }).panes.find((p) => p.id === 'p0')!.floatBefore).toBeUndefined();
  });

  it('toggle_collapse_float: folds a card to its head and back; dock clears it; maximizing unfolds it', () => {
    let s = reducer(initialState, { type: 'add_pane' }); // p0 p1
    const rect = { x: 40, y: 50, w: 400, h: 300 };
    expect(reducer(s, { type: 'toggle_collapse_float', paneId: 'p0' })).toBe(s); // docked: nothing
    s = reducer(s, { type: 'float_pane', paneId: 'p0', rect });
    s = reducer(s, { type: 'toggle_collapse_float', paneId: 'p0' });
    expect(s.panes[0]).toMatchObject({ floatCollapsed: true, float: rect }); // the box is kept
    expect(reducer(s, { type: 'toggle_collapse_float', paneId: 'p0' }).panes[0]).not.toHaveProperty('floatCollapsed');
    expect(reducer(s, { type: 'dock_pane', paneId: 'p0' }).panes.find((p) => p.id === 'p0')).not.toHaveProperty('floatCollapsed');
    const max = reducer(s, { type: 'toggle_max_float', paneId: 'p0', bounds: { w: 1200, h: 800 } });
    expect(max.panes[0]).toMatchObject({ float: { x: 0, y: 0, w: 1200, h: 800 } });
    expect(max.panes[0]).not.toHaveProperty('floatCollapsed');
  });

  it('load_layout: replaces every pane, the first becomes active; an empty list changes nothing', () => {
    let s = reducer(initialState, { type: 'add_pane' }); // p0 p1
    expect(reducer(s, { type: 'load_layout', panes: [] })).toBe(s);
    const a = { ...s.panes[0]!, id: 'p5' };
    const b = { ...s.panes[1]!, id: 'p6', float: { x: 0, y: 0, w: 400, h: 300 } };
    s = reducer(s, { type: 'load_layout', panes: [a, b] });
    expect(s.panes.map((p) => p.id)).toEqual(['p5', 'p6']);
    expect(s.activePaneId).toBe('p5');
  });

  it('move_float `at`: the box is remembered per body size, newest last, at most four; float_pane / dock_pane forget them', () => {
    let s = reducer(initialState, { type: 'add_pane' });
    const rect = { x: 40, y: 50, w: 400, h: 300 };
    s = reducer(s, { type: 'float_pane', paneId: 'p0', rect });
    s = reducer(s, { type: 'move_float', paneId: 'p0', rect: { ...rect, x: 60 } });
    expect(s.panes[0]!.floatBySize).toBeUndefined(); // no `at`: nothing remembered
    s = reducer(s, { type: 'move_float', paneId: 'p0', rect: { ...rect, x: 60 }, at: '1200x800' }); // same box, still recorded
    expect(s.panes[0]!.floatBySize).toEqual({ '1200x800': { ...rect, x: 60 } });
    expect(reducer(s, { type: 'move_float', paneId: 'p0', rect: { ...rect, x: 60 }, at: '1200x800' })).toBe(s); // already so
    for (const k of ['800x600', '1000x700', '1400x900']) s = reducer(s, { type: 'move_float', paneId: 'p0', rect: { ...rect, y: 10 }, at: k });
    s = reducer(s, { type: 'move_float', paneId: 'p0', rect: { ...rect, x: 7 }, at: '800x600' }); // re-recorded: newest
    expect(Object.keys(s.panes[0]!.floatBySize!)).toEqual(['1200x800', '1000x700', '1400x900', '800x600']);
    s = reducer(s, { type: 'move_float', paneId: 'p0', rect, at: '1600x1000' }); // a fifth: the oldest goes
    expect(Object.keys(s.panes[0]!.floatBySize!)).toEqual(['1000x700', '1400x900', '800x600', '1600x1000']);
    expect(s.panes[0]!.floatBySize!['800x600']).toEqual({ ...rect, x: 7 });
    const docked = reducer(s, { type: 'dock_pane', paneId: 'p0' });
    expect(docked.panes.find((p) => p.id === 'p0')).not.toHaveProperty('floatBySize');
    expect(reducer(docked, { type: 'float_pane', paneId: 'p0', rect }).panes.find((p) => p.id === 'p0')!.floatBySize).toBeUndefined();
    // Pulled off with `at`: a fresh record of just that box.
    expect(reducer(docked, { type: 'float_pane', paneId: 'p0', rect, at: '900x700' }).panes.find((p) => p.id === 'p0')!.floatBySize).toEqual({ '900x700': rect });
  });

  it('park_floats / unpark_floats: cards become tabs for a phone-wide screen and float again where they were', () => {
    let s = reducer(initialState, { type: 'add_pane' });
    s = reducer(s, { type: 'add_pane' }); // p0 p1 p2
    const rect = { x: 40, y: 50, w: 400, h: 300 };
    expect(reducer(s, { type: 'park_floats' })).toBe(s); // nothing floating
    expect(reducer(s, { type: 'unpark_floats' })).toBe(s); // nothing parked
    s = reducer(s, { type: 'float_pane', paneId: 'p0', rect });
    s = reducer(s, { type: 'park_floats' }); // p1 p2 p0(parked)
    expect(s.panes.map((p) => [p.id, !!p.float, !!p.parkedFloat])).toEqual([['p1', false, false], ['p2', false, false], ['p0', false, true]]);
    expect(reducer(s, { type: 'park_floats' })).toBe(s);
    // The phone reorders tabs meanwhile: the parked box travels with the pane.
    s = reducer(s, { type: 'move_pane', paneId: 'p0', to: 0 });
    s = reducer(s, { type: 'unpark_floats' });
    expect(s.panes.map((p) => [p.id, p.float ?? null, !!p.parkedFloat])).toEqual([['p0', rect, false], ['p1', null, false], ['p2', null, false]]);
    // Docking (desktop) forgets any parked box; floating anew replaces it.
    s = reducer(s, { type: 'park_floats' });
    s = reducer(s, { type: 'unpark_floats' });
    s = reducer(s, { type: 'dock_pane', paneId: 'p0' });
    expect(s.panes.every((p) => !p.parkedFloat && !p.float)).toBe(true);
    // Only parked panes left (the docked ones were closed on the phone): the first stays in the grid.
    s = reducer(s, { type: 'float_pane', paneId: 'p1', rect });
    s = reducer(s, { type: 'float_pane', paneId: 'p2', rect: { ...rect, x: 90 } }); // p0 is the only docked pane
    s = reducer(s, { type: 'park_floats' }); // p0 p1(parked) p2(parked)
    s = reducer(s, { type: 'close_pane', paneId: 'p0' });
    s = reducer(s, { type: 'unpark_floats' });
    expect(s.panes.map((p) => [p.id, p.float ?? null, !!p.parkedFloat])).toEqual([['p1', null, false], ['p2', { ...rect, x: 90 }, false]]);
  });

  it('closing the last docked pane docks the first floating card (the grid never empties)', () => {
    let s = reducer(initialState, { type: 'add_pane' });
    s = reducer(s, { type: 'add_pane' }); // p0 p1 p2
    const rect = { x: 0, y: 0, w: 400, h: 300 };
    s = reducer(s, { type: 'float_pane', paneId: 'p1', rect });
    s = reducer(s, { type: 'float_pane', paneId: 'p2', rect });
    s = reducer(s, { type: 'focus_pane', paneId: 'p0' });
    s = reducer(s, { type: 'close_pane', paneId: 'p0' });
    expect(s.panes.map((p) => [p.id, !!p.float])).toEqual([['p1', false], ['p2', true]]);
    expect(s.activePaneId).toBe('p1');
    // add_pane with only floats around still averages over the docked ones (here: one).
    expect(reducer(s, { type: 'add_pane' }).panes.at(-1)!.size).toBeUndefined();
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
    expect(pane(s).model).toBe('fable');
    s = reducer(s, { type: 'set_sandbox', sandbox: 'workspace-write' });
    expect(pane(s).sandbox).toBe('workspace-write');
    expect(play([{ type: 'hello', usage, projects: [], running: [], codex: { available: true } }]).codexAvailable).toBe(true);
  });

  it('a new GPT session keeps the sandbox its first turn was sent with (the chip showed 읽기 전용 for a workspace-write session)', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
    s = reducer(s, { type: 'set_engine', engine: 'codex' });
    s = reducer(s, { type: 'set_sandbox', sandbox: 'workspace-write' });
    s = reducer(s, { type: 'sent', text: 'hi' });
    expect(pane(s).session?.sandbox).toBeNull();
    s = play([{ type: 'turn_started', turnId: 't1', sessionId: null, cwd: '/w', account: 'gpt', model: 'gpt-6-sol', reason: '새 세션', attempt: 0, engine: 'codex' }], s);
    expect(pane(s).session).toMatchObject({ engine: 'codex', sandbox: 'workspace-write' });
    s = play([{ type: 'turn_result', turnId: 't1', sessionId: 'thread-1', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null }], s);
    expect(pane(s).session).toMatchObject({ sessionId: 'thread-1', engine: 'codex', sandbox: 'workspace-write' });
    // A Claude session has no sandbox: the claim leaves it null.
    let c = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
    c = reducer(c, { type: 'sent', text: 'hi' });
    c = play([{ type: 'turn_started', turnId: 't2', sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: '새 세션', attempt: 0 }], c);
    expect(pane(c).session).toMatchObject({ engine: 'claude', sandbox: null });
  });

  it('questions are global, deduped, closed by question_resolved or the turn result; attachments ride the sent item', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = reducer(s, { type: 'attach', attachment: { id: 'a1', name: 'shot.png', size: 3, isImage: true } });
    const shot = { id: 'a1', name: 'shot.png', isImage: true };
    s = reducer(s, { type: 'sent', text: 'look', attachments: [shot] });
    expect(pane(s).items[0]).toEqual({ kind: 'user', text: 'look', attachments: [shot], n: 0, at: expect.any(Number) });
    expect(pane(s).attachments).toEqual([]);
    const q: ServerMessage = { type: 'question_request', turnId: 't1', sessionId: null, cwd: '/w', requestId: 'q1', questions: [{ question: 'Which?', header: 'H', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }], multiSelect: false }] };
    s = play([q, q], s);
    expect(s.questions).toHaveLength(1);
    expect(play([{ type: 'question_resolved', requestId: 'q1', answers: null }], s).questions).toEqual([]);
    s = play([started('t1', null, '/w'), { type: 'turn_result', turnId: 't1', sessionId: 's9', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null }], s);
    expect(s.questions).toEqual([]);
  });

  it('reattach swaps an edited image in place, keeping the order', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = reducer(s, { type: 'attach', attachment: { id: 'a1', name: 'shot.png', size: 3, isImage: true } });
    s = reducer(s, { type: 'attach', attachment: { id: 'a2', name: 'b.txt', size: 1, isImage: false } });
    s = reducer(s, { type: 'reattach', id: 'a1', attachment: { id: 'a3', name: 'shot.png', size: 2, isImage: true } });
    expect(pane(s).attachments.map((a) => a.id)).toEqual(['a3', 'a2']);
  });

  it('PF13: history resets a model that does not belong to the session engine', () => {
    const hist = (sessionId: string, engine: 'claude' | 'codex'): ServerMessage => ({ type: 'history', sessionId, cwd: '/w', account: engine === 'codex' ? 'gpt' : 'b', engine, sandbox: engine === 'codex' ? 'read-only' : null, runningTurnId: null, messages: [] });
    let s = reducer(initialState, { type: 'set_model', model: 'gpt-6-astra' });
    s = reducer(s, { type: 'open', sessionId: 'c1', cwd: '/w', title: 'c' });
    s = play([hist('c1', 'claude')], s);
    // Not picked for this session: it shows the session's own model (an older server sends none → the imported default).
    expect(pane(s).model).toBe('fable');
    s = reducer(s, { type: 'set_model', model: 'sonnet' });
    s = play([hist('c1', 'claude')], s);
    expect(pane(s).model).toBe('sonnet');
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

  describe('fix round 1', () => {
    const newPanes = () => {
      let s = reducer(initialState, { type: 'add_pane' });
      s = reducer(s, { type: 'open', sessionId: null, cwd: '/w', title: 'n', paneId: 'p0' });
      return reducer(s, { type: 'open', sessionId: null, cwd: '/w', title: 'n', paneId: 'p1' });
    };
    const startedRef = (turnId: string, clientRef: string): ServerMessage => ({ ...started(turnId, null, '/w'), clientRef } as ServerMessage);

    it('I1: an error without this pane\'s clientRef (stale permission, other pane) does not unlock its wait', () => {
      let s = reducer(newPanes(), { type: 'sent', text: 'a', paneId: 'p0', clientRef: 'r0' });
      s = play([{ type: 'error', turnId: null, message: '이미 처리된 권한 요청입니다' }], s);
      expect(s.panes[0]?.awaitingStart).toBe(true);
      s = play([{ type: 'error', turnId: null, message: '이 세션은 이미 실행 중입니다', clientRef: 'other' }], s);
      expect(s.panes[0]?.awaitingStart).toBe(true);
      s = play([startedRef('ta', 'r0')], s);
      expect(s.panes[0]).toMatchObject({ awaitingStart: false, awaitingRef: null, myTurns: ['ta'], activeTurnId: 'ta' });
      expect(s.panes[0]?.items).toHaveLength(2);
    });

    it('I1: the refusal echoing the clientRef ends only that pane\'s wait', () => {
      let s = reducer(newPanes(), { type: 'sent', text: 'a', paneId: 'p0', clientRef: 'r0' });
      s = reducer(s, { type: 'sent', text: 'b', paneId: 'p1', clientRef: 'r1' });
      s = play([{ type: 'error', turnId: 'tx', message: '첨부를 찾을 수 없습니다: x', clientRef: 'r1' }], s);
      expect(s.panes[0]?.awaitingStart).toBe(true);
      expect(s.panes[1]).toMatchObject({ awaitingStart: false, awaitingRef: null });
      expect(s.error).toBe('첨부를 찾을 수 없습니다: x');
    });

    it('I2: turn_started is claimed by clientRef, not pane order (p1 sent first)', () => {
      let s = reducer(newPanes(), { type: 'sent', text: 'b', paneId: 'p1', clientRef: 'r1' });
      s = reducer(s, { type: 'sent', text: 'a', paneId: 'p0', clientRef: 'r0' });
      s = play([startedRef('tb', 'r1')], s);
      expect(s.panes[0]).toMatchObject({ myTurns: [], awaitingStart: true });
      expect(s.panes[1]).toMatchObject({ myTurns: ['tb'], awaitingStart: false });
      s = play([startedRef('ta', 'r0')], s);
      expect(s.panes[0]?.myTurns).toEqual(['ta']);
      expect(s.panes[1]?.myTurns).toEqual(['tb']);
      // A ref-less turn_started (another device) is claimed by neither ref-waiting pane.
      let t = reducer(newPanes(), { type: 'sent', text: 'a', paneId: 'p0', clientRef: 'r0' });
      t = play([started('tz', null, '/w')], t);
      expect(t.panes[0]).toMatchObject({ myTurns: [], awaitingStart: true });
    });

    it('I3: history fills every pane viewing the session', () => {
      let s = reducer(initialState, { type: 'add_pane' });
      s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 't', paneId: 'p0' });
      s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 't', paneId: 'p1' });
      s = play([{ type: 'history', sessionId: 's2', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [{ kind: 'user', text: 'q', ts: null }] }], s);
      expect(s.panes[0]?.items).toEqual([{ kind: 'user', text: 'q' }]);
      expect(s.panes[1]?.items).toEqual([{ kind: 'user', text: 'q' }]);
    });

    it('M1: a history no pane claims never overwrites a pane showing another session', () => {
      let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one' });
      s = play([{ type: 'history', sessionId: 'gone', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [{ kind: 'user', text: 'q', ts: null }] }], s);
      expect(pane(s).session?.sessionId).toBe('s1');
      expect(pane(s).items).toEqual([]);
    });

    it('T9 (b): a history for a session no pane views or is opening is dropped, even into a blank active pane', () => {
      // Pane p1 opens s2 and is closed while the open_session reply is in flight; a fresh blank pane is active.
      let s = reducer(initialState, { type: 'add_pane' });
      s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 't', paneId: 'p1' });
      s = reducer(s, { type: 'close_pane', paneId: 'p1' });
      s = reducer(s, { type: 'add_pane' });
      expect(s.panes.find((p) => p.id === s.activePaneId)?.session).toBeNull();
      const before = s;
      s = play([{ type: 'history', sessionId: 's2', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [{ kind: 'user', text: 'stale', ts: null }] }], s);
      expect(s).toBe(before);
      expect(play([{ type: 'history', sessionId: 'x', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [] }]).panes[0]?.session).toBeNull();
    });

    it('M2: a turn_notice no item owns goes to the bar of the pane showing that session, never the app-wide banner', () => {
      const notice = (turnId: string, sessionId: string | null): ServerMessage => ({ type: 'turn_notice', turnId, sessionId, cwd: '/w', message: '세션 이동 거부' });
      let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one' });
      const other = play([notice('tq', 'elsewhere')], s);
      expect(other.error).toBeNull();
      expect(pane(other).notices).toEqual([]);
      const owned = play([notice('tq', 's1')], s);
      expect(owned.error).toBeNull();
      expect(pane(owned).notices).toEqual([{ sessionId: 's1', message: '세션 이동 거부', level: 'notice' }]);
      s = play([started('t1', 's1', '/w'), notice('t1', 's1')], s);
      expect(s.error).toBeNull();
      expect(pane(s).notices).toEqual([]);
      expect(pane(s).items[0]).toMatchObject({ notes: ['세션 이동 거부'] });
    });

    it('a session notice (turnId \'\') is pane-scoped: dismissible, cleared when the pane shows another session', () => {
      const notice: ServerMessage = { type: 'turn_notice', turnId: '', sessionId: 's1', cwd: '/w', message: '「x」 대화의 기록 파일이 방금 deck 밖에서 바뀌었어요.' };
      let s = reducer(initialState, { type: 'add_pane' });
      const [p0, p1] = s.panes;
      s = reducer(s, { type: 'focus_pane', paneId: p0!.id });
      s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one' });
      s = reducer(s, { type: 'focus_pane', paneId: p1!.id });
      s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'two' });
      s = play([notice], s);
      expect(s.error).toBeNull();
      expect(s.panes[0]!.notices?.[0]?.message).toContain('deck 밖');
      expect(s.panes[1]!.notices).toEqual([]);
      // Same session's history keeps it; another session's history (or opening another) clears it.
      const hist = (sessionId: string): ServerMessage => ({ type: 'history', sessionId, cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [] });
      expect(play([hist('s1')], s).panes[0]!.notices).toHaveLength(1);
      const opened = reducer(reducer(s, { type: 'focus_pane', paneId: p0!.id }), { type: 'open', sessionId: 's3', cwd: '/w', title: 'three' });
      expect(opened.panes[0]!.notices).toEqual([]);
      const dismissed = reducer(s, { type: 'dismiss_notice', paneId: p0!.id, message: s.panes[0]!.notices![0]!.message });
      expect(dismissed.panes[0]!.notices).toEqual([]);
      expect(dismissed.error).toBeNull();
    });

    it('an error about a session lands in the bar of its pane; without a pane (or a sessionId) it stays app-wide', () => {
      const s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one' });
      const scoped = play([{ type: 'error', turnId: null, message: '기록을 읽지 못했습니다', sessionId: 's1' }], s);
      expect(scoped.error).toBeNull();
      expect(pane(scoped).notices).toEqual([{ sessionId: 's1', message: '기록을 읽지 못했습니다', level: 'error' }]);
      expect(play([{ type: 'error', turnId: null, message: 'x', sessionId: 'gone' }], s).error).toBe('x');
      expect(play([{ type: 'error', turnId: null, message: 'y' }], s).error).toBe('y');
    });

    it('a notice and an error both stay (newest 3, a repeat moves to the end); dismissing one keeps the rest', () => {
      const s0 = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one' });
      const n = (message: string): ServerMessage => ({ type: 'turn_notice', turnId: '', sessionId: 's1', cwd: '/w', message });
      const e = (message: string): ServerMessage => ({ type: 'error', turnId: null, message, sessionId: 's1' });
      let s = play([n('알림'), e('오류')], s0);
      expect(pane(s).notices?.map((x) => [x.message, x.level])).toEqual([['알림', 'notice'], ['오류', 'error']]);
      s = play([n('둘'), n('셋'), n('알림')], s);
      expect(pane(s).notices?.map((x) => x.message)).toEqual(['둘', '셋', '알림']);
      s = reducer(s, { type: 'dismiss_notice', paneId: pane(s).id, message: '셋' });
      expect(pane(s).notices?.map((x) => x.message)).toEqual(['둘', '알림']);
      expect(pane(reducer(s, { type: 'dismiss_notice', paneId: pane(s).id })).notices).toEqual([]);
    });

    it('turn_system closes the streamed part, shows the system row, and streams the continuation after it; ordinals ignore it', () => {
      let s = play([{ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [{ kind: 'user', text: 'q', ts: null, n: 0 }] }], openedOn('s1'));
      s = play([
        started('t1', 's1', '/w'),
        { type: 'delta', turnId: 't1', sessionId: 's1', cwd: '/w', text: '끝났어요' },
        { type: 'turn_system', turnId: 't1', sessionId: 's1', cwd: '/w', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴', text: 'Stop hook feedback:\n테스트 실패' },
        { type: 'delta', turnId: 't1', sessionId: 's1', cwd: '/w', text: '다시 고칩니다' },
      ], s);
      const items = pane(s).items;
      expect(items.map((it) => it.kind)).toEqual(['user', 'assistant', 'system', 'assistant']);
      expect(items[1]).toMatchObject({ text: '끝났어요', streaming: false });
      expect(items[2]).toEqual({ kind: 'system', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴', text: 'Stop hook feedback:\n테스트 실패' });
      expect(items[3]).toMatchObject({ turnId: 't1', text: '다시 고칩니다', streaming: true });
      expect(nextUserN(items, pane(s).session)).toBe(1);
      expect(play([{ type: 'turn_system', turnId: 'tx', sessionId: 'other', cwd: '/w', source: 'peer', label: '다른 세션의 메시지', text: 'x' }], s).panes[0]!.items).toBe(items);
    });

    it('M3: answersFor clips keys to 2000 and values to 4000 chars', () => {
      const long = 'q'.repeat(2500);
      const q: PendingQuestion = { turnId: 't', sessionId: 's', cwd: '/w', requestId: 'q', questions: [{ question: long, header: 'H', options: [], multiSelect: false }] };
      const out = answersFor(q, ['v'.repeat(5000)]);
      expect(Object.keys(out)[0]).toHaveLength(2000);
      expect(Object.values(out)[0]).toHaveLength(4000);
    });
  });
});

describe('reducer: 자동 승인 and Desktop sessions', () => {
  it('hello/settings set autoApprove; a new GPT session starts on workspace-write either way and an explicit pick stays', () => {
    let s = play([{ type: 'hello', usage, projects: [], running: [], codex: { available: true }, settings: { autoApprove: false, defaultPermissionMode: 'default' }, desktop: [{ sessionId: 'd1', account: 'a', title: 'T', cwd: '/w/x', project: 'x', lastModified: 1 }] }]);
    expect(s.autoApprove).toBe(false);
    expect(s.desktop.map((d) => d.sessionId)).toEqual(['d1']);
    s = reducer(s, { type: 'set_engine', engine: 'codex', paneId: s.panes[0]!.id });
    expect(s.panes[0]!.sandbox).toBe('workspace-write');
    s = reducer(s, { type: 'add_pane' });
    s = reducer(s, { type: 'set_engine', engine: 'codex', paneId: s.panes[1]!.id });
    s = reducer(s, { type: 'set_sandbox', sandbox: 'read-only', paneId: s.panes[1]!.id });
    s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions' } }], s);
    expect(s.autoApprove).toBe(true);
    expect(s.panes.map((p) => p.sandbox)).toEqual(['workspace-write', 'read-only']);
    s = play([{ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default' } }], s);
    expect(s.panes.map((p) => p.sandbox)).toEqual(['workspace-write', 'read-only']);
  });

  it('a new Gemini session keeps its 자동 승인 default (off → plan/read-only, on → auto_edit/workspace-write); leaving Gemini goes back to the GPT default', () => {
    let s = play([{ type: 'hello', usage, projects: [], running: [], codex: { available: true }, settings: { autoApprove: false, defaultPermissionMode: 'default' }, desktop: [] }]);
    const id = s.panes[0]!.id;
    s = reducer(s, { type: 'set_engine', engine: 'gemini', paneId: id });
    expect(s.panes[0]!.sandbox).toBe('read-only');
    // 자동 승인 on: a Gemini pane still on the old default follows; a GPT pane does not move.
    s = reducer(s, { type: 'add_pane' });
    s = reducer(s, { type: 'set_engine', engine: 'codex', paneId: s.panes[1]!.id });
    s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions' } }], s);
    expect(s.panes.map((p) => p.sandbox)).toEqual(['workspace-write', 'workspace-write']);
    s = play([{ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default' } }], s);
    expect(s.panes.map((p) => p.sandbox)).toEqual(['read-only', 'workspace-write']);
    s = reducer(s, { type: 'set_engine', engine: 'codex', paneId: id });
    expect(s.panes[0]!.sandbox).toBe('workspace-write');
  });

  it('an existing GPT session\'s sandbox follows the server: the `sandbox` broadcast and catchup update every pane showing it', () => {
    const codexHistory = (sandbox: 'read-only' | 'workspace-write'): ServerMessage => ({ type: 'history', sessionId: 'g1', cwd: '/w', account: 'gpt', engine: 'codex', sandbox, messages: [], runningTurnId: null });
    let s = play([codexHistory('read-only')], openedOn('g1'));
    expect(pane(s).session?.sandbox).toBe('read-only');
    s = play([{ type: 'sandbox', sessionId: 'g1', sandbox: 'workspace-write' }], s);
    expect(pane(s).session?.sandbox).toBe('workspace-write');
    // A reconnect that only catches up carries it too.
    s = play([{ type: 'catchup', sessionId: 'g1', sandbox: 'read-only', runningTurnId: null }], s);
    expect(pane(s).session?.sandbox).toBe('read-only');
    // Another session's broadcast does nothing here.
    const same = play([{ type: 'sandbox', sessionId: 'other', sandbox: 'workspace-write' }], s);
    expect(pane(same).session).toBe(pane(s).session);
  });
});

describe('message queue (ux-state)', () => {
  const started = (s: AppState, turnId: string, clientRef: string) => play([{ type: 'turn_started', turnId, sessionId: 's1', cwd: '/w', clientRef } as ServerMessage], s);
  const result = (s: AppState, turnId: string, ok: boolean) => play([{ type: 'turn_result', turnId, sessionId: 's1', cwd: '/w', ok, text: '', badge: null, errorText: ok ? null : '중단됨' }], s);
  const running = (): AppState => started(reducer(openedOn('s1'), { type: 'sent', text: 'first', clientRef: 'r1' }), 't1', 'r1');

  it('queue_add takes the composer attachments; edit / remove / clear; empty text without files is ignored', () => {
    let s = reducer(running(), { type: 'attach', attachment: { id: 'a1', name: 'x.png', size: 1, isImage: true } });
    s = reducer(s, { type: 'queue_add', text: '  second ' });
    s = reducer(s, { type: 'queue_add', text: 'third' });
    s = reducer(s, { type: 'queue_add', text: '   ' });
    expect(pane(s).queue.map((q) => [q.text, q.attachments.length])).toEqual([['second', 1], ['third', 0]]);
    expect(pane(s).attachments).toEqual([]);
    const [a, b] = pane(s).queue;
    s = reducer(s, { type: 'queue_edit', id: b!.id, text: 'third!' });
    expect(pane(s).queue[1]!.text).toBe('third!');
    s = reducer(s, { type: 'queue_remove', id: a!.id });
    expect(pane(s).queue.map((q) => q.text)).toEqual(['third!']);
    s = reducer(s, { type: 'queue_clear' });
    expect(pane(s).queue).toEqual([]);
  });

  it('nextQueued: nothing while the turn runs or a send awaits its start; the head once the turn ends', () => {
    let s = reducer(running(), { type: 'queue_add', text: 'second' });
    expect(nextQueued(pane(s))).toBeNull();
    s = result(s, 't1', true);
    expect(nextQueued(pane(s))?.text).toBe('second');
    s = reducer(s, { type: 'sent', text: 'second', clientRef: 'r2' });
    expect(nextQueued(pane(s))).toBeNull(); // awaiting start
    expect(nextQueued({ ...pane(s), session: null, awaitingStart: false })).toBeNull();
  });

  it('queue_send_now: the item moves to the head and goes out once the interrupted turn ends, ahead of the rest', () => {
    let s = reducer(running(), { type: 'queue_add', text: 'a' });
    s = reducer(s, { type: 'queue_add', text: 'b' });
    s = reducer(s, { type: 'queue_add', text: 'c' });
    const b = pane(s).queue[1]!;
    s = reducer(s, { type: 'queue_send_now', id: b.id });
    expect(pane(s).queue.map((q) => q.text)).toEqual(['b', 'a', 'c']);
    expect(nextQueued(pane(s))).toBeNull(); // the turn is still running (interrupt in flight)
    s = result(s, 't1', false); // interrupted: the queue pauses, but 지금 전송 still goes
    expect(pane(s).queuePaused).toBe(true);
    expect(nextQueued(pane(s))?.text).toBe('b');
    s = reducer(s, { type: 'queue_remove', id: b.id });
    expect(pane(s).queueSendNow).toBeNull();
    s = reducer(s, { type: 'sent', text: 'b', clientRef: 'r2' });
    expect(pane(s).queuePaused).toBe(false); // the rest follows after b's turn
    s = started(s, 't2', 'r2');
    s = result(s, 't2', true);
    expect(nextQueued(pane(s))?.text).toBe('a');
    expect(pane(reducer(s, { type: 'queue_send_now', id: 'nope' }))).toBe(pane(s));
  });

  describe('지금 전송 on a message already sent into the running turn (전달 대기)', () => {
    const steering = () => {
      let s = reducer(running(), { type: 'queue_add', text: 'a' });
      s = reducer(s, { type: 'queue_add', text: 'steer me', steerId: 'k1' });
      s = reducer(s, { type: 'queue_add', text: 'c' });
      return reducer(s, { type: 'queue_send_now', id: pane(s).queue[1]!.id });
    };
    const rejected = (s: AppState) => play([{ type: 'steer_rejected', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: 'k1', message: '세션 프로세스가 끝나 턴이 끝난 뒤 보냅니다' }], s);
    const delivered = (s: AppState) => play([{ type: 'steer_delivered', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: 'k1', prompt: { text: 'steer me' } } as ServerMessage], s);

    it('interrupted before it went in: waits for the server to hand it back, then goes out once as the next turn; the rest keep their order and the queue does not stay paused', () => {
      let s = steering();
      expect(pane(s).queue.map((q) => q.text)).toEqual(['steer me', 'a', 'c']);
      s = result(s, 't1', false); // the interrupt ended the turn
      expect(nextQueued(pane(s))).toBeNull(); // still in the dead process's hands: not sent twice
      s = rejected(s); // the process ended without taking it
      const now = nextQueued(pane(s))!;
      expect(now.text).toBe('steer me');
      expect(now.steer).toBeUndefined();
      s = reducer(s, { type: 'queue_remove', id: now.id });
      expect(nextQueued(pane(s))).toBeNull(); // nothing else while the queue is paused by the stop
      s = reducer(s, { type: 'sent', text: 'steer me', clientRef: 'r2' });
      expect(pane(s).queuePaused).toBe(false);
      expect(pane(s).queueSendNow).toBeNull();
      s = result(started(s, 't2', 'r2'), 't2', true);
      expect(pane(s).queue.map((q) => q.text)).toEqual(['a', 'c']);
      expect(nextQueued(pane(s))?.text).toBe('a');
    });

    it('it went in just before the stop (steer_delivered, before or after the result): never sent again', () => {
      for (const order of ['before', 'after'] as const) {
        let s = steering();
        s = order === 'before' ? result(delivered(s), 't1', false) : delivered(result(s, 't1', false));
        expect(pane(s).queue.map((q) => q.text)).toEqual(['a', 'c']);
        expect(pane(s).queueSendNow).toBeNull();
        expect(pane(s).items.filter((it) => it.kind === 'user' && it.text === 'steer me')).toHaveLength(1);
        expect(nextQueued(pane(s))).toBeNull(); // the stop paused the rest, as any stop does
        // A late "already in" answer for the same id changes nothing.
        expect(pane(play([{ type: 'steer_rejected', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: 'k1', message: 'x', code: 'already_accepted' }], s)).queue.map((q) => q.text)).toEqual(['a', 'c']);
      }
    });

    it('no answer at all (lost): after the steer timeout it still goes out, once', () => {
      let s = result(steering(), 't1', false);
      s = reducer(s, { type: 'steer_lost', steerId: 'k1' });
      expect(nextQueued(pane(s))?.text).toBe('steer me');
    });
  });

  it('stop / a failed turn pause the queue (kept); resume or a manual send unpause; open drops it', () => {
    let s = reducer(running(), { type: 'queue_add', text: 'second' });
    s = reducer(s, { type: 'queue_pause' });
    s = result(s, 't1', false);
    expect(pane(s).queuePaused).toBe(true);
    expect(pane(s).queue).toHaveLength(1);
    expect(nextQueued(pane(s))).toBeNull();
    s = reducer(s, { type: 'queue_resume' });
    expect(nextQueued(pane(s))?.text).toBe('second');
    // a failed turn without an explicit stop pauses too
    let f = reducer(running(), { type: 'queue_add', text: 'q' });
    f = result(f, 't1', false);
    expect(pane(f).queuePaused).toBe(true);
    f = reducer(f, { type: 'sent', text: 'manual', clientRef: 'r9' });
    expect(pane(f).queuePaused).toBe(false);
    // a refused send pauses a non-empty queue
    let r = reducer(openedOn('s1'), { type: 'sent', text: 'x', clientRef: 'rx' });
    r = reducer(r, { type: 'queue_add', text: 'later' });
    r = play([{ type: 'error', turnId: null, message: 'busy', clientRef: 'rx' }], r);
    expect(pane(r).queuePaused).toBe(true);
    expect(pane(reducer(f, { type: 'open', sessionId: 's2', cwd: '/w', title: 't' })).queue).toEqual([]);
  });

  describe('a send refused before its turn started', () => {
    const DRAIN = '서버가 재시작을 준비 중입니다 — 잠시 뒤 다시 보내 주세요';
    const hello: ServerMessage = { type: 'hello', usage, projects: [], running: [], codex: { available: false } };
    const history = (texts: string[]): ServerMessage => ({ type: 'history', sessionId: 's1', cwd: '/w', account: null, runningTurnId: null, messages: texts.map((text, n) => ({ kind: 'user' as const, text, ts: null, n })) });
    const file = { id: '11111111-1111-4111-8111-111111111111', name: 'x.png', isImage: true };
    const refusedSend = (code?: 'draining') => {
      let s = play([history(['old'])], openedOn('s1'));
      s = reducer(s, { type: 'queue_add', text: 'later' });
      s = reducer(s, { type: 'sent', text: 'mine', attachments: [file], clientRef: 'r1' });
      return play([{ type: 'error', turnId: null, message: code ? DRAIN : '세션이 실행 중입니다', clientRef: 'r1', ...(code ? { code } : {}) }], s);
    };

    it('takes the bubble back and puts the message (with its files) at the head of the queue; the error still shows', () => {
      const s = refusedSend();
      expect(pane(s).items.map((it) => it.kind === 'user' && it.text)).toEqual(['old']);
      expect(pane(s).queue.map((q) => q.text)).toEqual(['mine', 'later']);
      expect(pane(s).queue[0]!.attachments).toMatchObject([{ id: file.id, name: 'x.png', isImage: true }]);
      expect(pane(s).awaitingStart).toBe(false);
      expect(s.error).toBe('세션이 실행 중입니다');
    });

    it('any other reason: queued paused, nothing goes out by itself (not even after a reconnect)', () => {
      let s = refusedSend();
      expect(pane(s).queuePaused).toBe(true);
      expect(nextQueued(pane(s))).toBeNull();
      s = play([hello, history(['old'])], s);
      expect(nextQueued(pane(s))).toBeNull();
    });

    it('a bubble something came after stays; another pane\'s refusal changes nothing here', () => {
      let s = reducer(openedOn('s1'), { type: 'sent', text: 'mine', clientRef: 'r1' });
      s = { ...s, panes: [{ ...pane(s), items: [...pane(s).items, { kind: 'user', text: 'other device' }] }] };
      s = play([{ type: 'error', turnId: null, message: 'x', clientRef: 'r1' }], s);
      expect(pane(s).items.map((it) => it.kind === 'user' && it.text)).toEqual(['mine', 'other device']);
      expect(pane(s).queue.map((q) => q.text)).toEqual(['mine']);
      const o = play([{ type: 'error', turnId: null, message: 'x', clientRef: 'zz' }], reducer(openedOn('s1'), { type: 'sent', text: 'mine', clientRef: 'r1' }));
      expect(pane(o).queue).toEqual([]);
      expect(pane(o).items).toHaveLength(1);
    });

    it('a handoff-note send refused is not queued (its text is server-side)', () => {
      let s = play([history(['old'])], openedOn('s1'));
      s = reducer(s, { type: 'sent', text: HANDOFF_PROMPT, clientRef: 'h1', handoff: true });
      s = play([{ type: 'error', turnId: null, message: DRAIN, clientRef: 'h1', code: 'draining' }], s);
      expect(pane(s).queue).toEqual([]);
    });

    it('draining: held until the reconnect, then sent once the history shows it did not go in — not paused', () => {
      let s = refusedSend('draining');
      expect(pane(s).queuePaused).toBe(false);
      expect(nextQueued(pane(s))).toBeNull(); // the old server would only refuse it again
      s = play([hello], s);
      expect(nextQueued(pane(s))).toBeNull(); // waits for the session's history
      s = play([history(['old'])], s);
      expect(nextQueued(pane(s))?.text).toBe('mine');
    });

    it('draining after its turn started (a follow-up the ended process never took): its turn and bubble go, it is held in the queue after the held ones and sent after the restart', () => {
      let s = play([history(['old'])], openedOn('s1'));
      s = reducer(s, { type: 'queue_add', text: 'later' });
      s = reducer(s, { type: 'sent', text: 'mine', attachments: [file], clientRef: 'r1' });
      s = play([{ type: 'turn_started', turnId: 'f1', sessionId: 's1', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0, clientRef: 'r1' }], s);
      // Another device's refusal of the same kind changes nothing here (its ref, its turn).
      const other = play([{ type: 'error', turnId: 'zz', message: 'x', clientRef: 'zz', code: 'draining' }], s);
      expect(pane(other).queue.map((q) => q.text)).toEqual(['later']);
      // The runner tells the refusal before it closes the turn (refuseFollowUp).
      s = play([{ type: 'error', turnId: 'f1', message: 'x', clientRef: 'r1', code: 'draining' }], s);
      s = play([{ type: 'turn_result', turnId: 'f1', sessionId: 's1', cwd: '/w', ok: false, text: '', badge: null, errorText: 'x' }], s);
      expect(pane(s).items.map((it) => it.kind)).toEqual(['user']);
      expect(pane(s).queue.map((q) => [q.text, q.restart, q.ref])).toEqual([['mine', 'hold', 'r1'], ['later', undefined, undefined]]);
      expect(pane(s).queue[0]!.attachments).toMatchObject([{ id: file.id, name: 'x.png', isImage: true }]);
      expect(pane(s).activeTurnId).toBeNull();
      // Delivered twice (a reconnect replay): still one copy.
      expect(pane(play([{ type: 'error', turnId: 'f1', message: 'x', clientRef: 'r1', code: 'draining' }], s)).queue).toHaveLength(2);
      expect(nextQueued(pane(s))).toBeNull();
      s = play([hello, history(['old'])], s);
      expect(nextQueued(pane(s))?.text).toBe('mine');
    });

    it('a follow-up that waited in line and was refused before it started (no code): back at the head of the queue, paused; said in the pane, not app-wide', () => {
      let s = play([history(['old'])], openedOn('s1'));
      s = reducer(s, { type: 'queue_add', text: 'later' });
      s = reducer(s, { type: 'sent', text: 'mine', attachments: [file], clientRef: 'r1' });
      s = play([{ type: 'turn_queued', turnId: 'f1', sessionId: 's1', cwd: '/w', clientRef: 'r1', behind: '세션 프로세스가 끝나 새로 이어 보냅니다' }], s);
      s = play([{ type: 'error', turnId: 'f1', message: '세션 프로세스가 끝나 보내지 못했습니다 — 다시 보내 주세요', clientRef: 'r1', sessionId: 's1' }], s);
      expect(pane(s).awaitingStart).toBe(false);
      expect(pane(s).awaitingBehind).toBeNull();
      expect(pane(s).items.map((it) => it.kind === 'user' && it.text)).toEqual(['old']);
      expect(pane(s).queue.map((q) => [q.text, q.ref])).toEqual([['mine', 'r1'], ['later', undefined]]);
      expect(pane(s).queue[0]!.attachments).toMatchObject([{ id: file.id, name: 'x.png', isImage: true }]);
      expect(pane(s).queuePaused).toBe(true);
      expect(s.error).toBeNull();
      expect((pane(s).notices ?? []).map((n) => n.message)).toContain('세션 프로세스가 끝나 보내지 못했습니다 — 다시 보내 주세요');
    });

    it('draining: never deduped against the history (it definitely did not go in) — the same text sent twice goes out twice', () => {
      let s = refusedSend('draining');
      s = play([hello, history(['old', 'mine'])], s);
      expect(pane(s).queue.map((q) => q.text)).toEqual(['mine', 'later']);
      expect(nextQueued(pane(s))?.text).toBe('mine');
    });

    // H1 + M5: a send whose socket died before any reply may have gone in — checked by its ordinal, not by the last text.
    const lostSend = (text: string, transcript: string[]) => {
      let s = play([history(transcript)], openedOn('s1'));
      s = reducer(s, { type: 'sent', text, clientRef: 'r1' });
      return play([hello], s); // the old socket died: no turn_started, no error
    };

    it('socket lost before any reply: queued again at the head, then dropped if the history has it as the message it would have been', () => {
      let s = lostSend('계속', ['old']);
      expect(pane(s).awaitingStart).toBe(false);
      expect(pane(s).queue.map((q) => [q.text, q.maybeSent])).toEqual([['계속', 1]]);
      expect(nextQueued(pane(s))).toBeNull(); // waits for the history
      s = play([history(['old', '계속'])], s);
      expect(pane(s).queue).toEqual([]);
    });

    it('socket lost: sent again when the history does not have it — "계속" twice keeps the second', () => {
      let s = lostSend('계속', ['old', '계속']);
      expect(pane(s).queue[0]!.maybeSent).toBe(2);
      s = play([history(['old', '계속'])], s);
      expect(pane(s).queue.map((q) => q.text)).toEqual(['계속']);
      expect(pane(s).queue[0]!.maybeSent).toBeUndefined();
      expect(nextQueued(pane(s))?.text).toBe('계속');
    });

    it('socket drops while 확인 waits: back in the queue at once (안 보냄), no frozen timer; the next hello checks the history as before', () => {
      let s = play([history(['old'])], openedOn('s1'));
      s = reducer(s, { type: 'sent', text: '계속', clientRef: 'r1' });
      expect(pane(s).runStartedAt).not.toBeNull();
      s = reducer(s, { type: 'connected', value: false, at: 1 });
      expect(pane(s).awaitingStart).toBe(false);
      expect(pane(s).runStartedAt).toBeNull();
      expect(pane(s).items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual(['old']);
      expect(pane(s).queue.map((q) => [q.text, q.restart, q.maybeSent])).toEqual([['계속', 'hello', 1]]);
      s = play([hello], s);
      expect(pane(s).queue).toHaveLength(1); // not queued twice
      s = play([history(['old'])], s);
      expect(nextQueued(pane(s))?.text).toBe('계속');
    });

    it('a disconnect with nothing waiting leaves the panes as they are', () => {
      const s0 = play([history(['old'])], openedOn('s1'));
      const s = reducer(s0, { type: 'connected', value: false, at: 1 });
      expect(s.panes).toBe(s0.panes);
    });

    it('socket lost in a new session (it may have made one): queued paused, never sent by itself', () => {
      let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
      s = reducer(s, { type: 'sent', text: 'first', clientRef: 'r1' });
      s = play([hello], s);
      expect(pane(s).items).toEqual([]);
      expect(pane(s).queue.map((q) => q.text)).toEqual(['first']);
      expect(pane(s).queuePaused).toBe(true);
      expect(nextQueued(pane(s))).toBeNull();
    });

    // M1: a released item goes out alone; the rest of a paused queue (a lost steer) stays paused.
    it('a released item does not unpause the queue: a lost steer behind it is not sent', () => {
      let s = running();
      s = reducer(s, { type: 'queue_add', text: 'steer', steerId: 'k1' });
      s = play([{ type: 'steer_rejected', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: 'k1', message: DRAIN, code: 'draining' }], s);
      s = reducer(s, { type: 'queue_add', text: 'maybe-in', steerId: 'k2' });
      s = result(s, 't1', true);
      s = play([hello, history(['first'])], s); // k2 comes back as a lost steer: the queue pauses
      expect(pane(s).queuePaused).toBe(true);
      const next = nextQueued(pane(s))!;
      expect(next.text).toBe('steer');
      s = reducer(s, { type: 'queue_remove', id: next.id });
      s = reducer(s, { type: 'sent', text: next.text, clientRef: 'r9', keepPaused: next.restart === 'go' });
      s = started(s, 't2', 'r9');
      s = result(s, 't2', true);
      expect(pane(s).queuePaused).toBe(true);
      expect(nextQueued(pane(s))).toBeNull();
      expect(pane(s).queue.map((q) => [q.text, q.lostSteer])).toEqual([['maybe-in', 'k2']]);
    });

    // M2: a held item stays with the session it was refused in.
    it('a held item does not follow the pane into a branch: it stays as a paused, ordinary queue item', () => {
      let s = refusedSend('draining');
      s = { ...s, panes: [{ ...pane(s), items: [{ kind: 'user', text: 'old', n: 0 }] }] };
      s = reducer(s, { type: 'branch_edit', n: 0, text: 'edited', clientRef: 'b1' });
      s = play([{ type: 'error', turnId: null, message: DRAIN, clientRef: 'b1', code: 'draining' }, hello], s);
      expect(pane(s).session?.sessionId).toBeNull();
      expect(pane(s).queue.every((q) => !q.restart && q.maybeSent === undefined)).toBe(true);
      expect(pane(s).queuePaused).toBe(true);
      expect(nextQueued(pane(s))).toBeNull();
    });

    it('G: a held item does not follow the pane into the 이어서 session — it is parked with the old one; plain ones follow, paused', () => {
      let s = refusedSend('draining');
      s = reducer(s, { type: 'sent', text: HANDOFF_PROMPT, clientRef: 'h1', handoff: true });
      s = started(s, 'th', 'h1');
      s = play([{ type: 'turn_result', turnId: 'th', sessionId: 's1', cwd: '/w', ok: true, text: 'note', badge: null, errorText: null }], s);
      expect(pane(s).session?.sessionId).toBeNull();
      expect(s.parked.s1!.queue.map((q) => [q.text, q.restart, q.ref])).toEqual([['mine', undefined, 'r1']]);
      s = play([hello], s);
      expect(pane(s).queue.map((q) => [q.text, q.restart])).toEqual([['later', undefined]]);
      expect(pane(s).queuePaused).toBe(true);
      expect(nextQueued(pane(s))).toBeNull();
    });

    it('a steer still in flight is parked as a lost steer, not reported dropped, when the pane leaves; a typed-only item is parked too', () => {
      let s = reducer(running(), { type: 'queue_add', text: 'mid-turn', steerId: 'k1' });
      s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'other' });
      expect(s.error ?? null).toBeNull();
      expect(s.parked.s1!.queue.map((q) => [q.text, q.lostSteer, q.steer])).toEqual([['mid-turn', 'k1', undefined]]);
      let t = reducer(running(), { type: 'queue_add', text: 'typed only' });
      t = reducer(t, { type: 'open', sessionId: 's2', cwd: '/w', title: 'other' });
      expect(t.error ?? null).toBeNull();
      expect(t.parked.s1!.queue.map((q) => q.text)).toEqual(['typed only']);
    });

    it('leaving the session parks every queued item (held or only typed) in queue order; reopening brings them back, paused', () => {
      let s = reducer(running(), { type: 'queue_add', text: 'one' });
      s = reducer(s, { type: 'queue_add', text: 'two', steerId: 'k1' });
      s = reducer(s, { type: 'queue_add', text: 'three' });
      s = { ...s, panes: [{ ...pane(s), queue: [...pane(s).queue, { id: 'x1', text: 'four', attachments: [], restart: 'hold' }, { id: 'x2', text: 'five', attachments: [] }] }] };
      s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'other' });
      expect(s.error ?? null).toBeNull();
      expect(s.parked.s1!.queue.map((q) => q.text)).toEqual(['one', 'two', 'three', 'four', 'five']);
      expect(pane(s).queue).toEqual([]);
      s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 'back' });
      expect(s.parked.s1).toBeUndefined();
      expect(pane(s).queue.map((q) => [q.text, q.kept])).toEqual([['one', true], ['two', true], ['three', true], ['four', true], ['five', true]]);
      expect(pane(s).queuePaused).toBe(true);
      expect(nextQueued(pane(s))).toBeNull();
    });

    it('the answer to a steer whose pane left settles the parked copy: delivered / already in drops it, refused keeps it plain and names it', () => {
      const away = () => reducer(reducer(running(), { type: 'queue_add', text: 'mid-turn', steerId: 'k1' }), { type: 'open', sessionId: 's2', cwd: '/w', title: 'other' });
      const scope = { turnId: 't1', sessionId: 's1', cwd: '/w' };
      const done = reducer(away(), { type: 'server', msg: { type: 'steer_delivered', steerId: 'k1', prompt: { text: 'mid-turn' }, ...scope } as never });
      expect(done.parked.s1).toBeUndefined();
      expect(done.error ?? null).toBeNull();
      const dup = reducer(away(), { type: 'server', msg: { type: 'steer_rejected', steerId: 'k1', message: 'x', code: 'already_accepted', ...scope } });
      expect(dup.parked.s1).toBeUndefined();
      const flying = reducer(away(), { type: 'server', msg: { type: 'steer_rejected', steerId: 'k1', message: 'x', code: 'in_flight', ...scope } });
      expect(flying.parked.s1!.queue[0]).toMatchObject({ text: 'mid-turn', lostSteer: 'k1' });
      const no = reducer(away(), { type: 'server', msg: { type: 'steer_rejected', steerId: 'k1', message: 'x', ...scope } });
      expect(no.parked.s1!.queue.map((q) => [q.text, q.lostSteer, q.kept])).toEqual([['mid-turn', undefined, true]]);
      expect(no.error).toContain('mid-turn');
      // another steer's answer leaves it alone
      expect(reducer(away(), { type: 'server', msg: { type: 'steer_rejected', steerId: 'zz', message: 'x', ...scope } }).parked.s1!.queue[0]!.lostSteer).toBe('k1');
    });

    it('G: branch_edit parks held items (restart, maybeSent, lost steer, kept) with the parent; only plain ones follow, paused', () => {
      let s = lostSend('lost', ['old']);
      s = reducer(s, { type: 'queue_add', text: 'plain' });
      s = { ...s, panes: [{ ...pane(s), queue: [...pane(s).queue, { id: 'x1', text: 'steer', attachments: [], lostSteer: 'k1' }, { id: 'x2', text: 'back', attachments: [], kept: true }] }] };
      s = reducer(s, { type: 'branch_edit', n: 0, text: 'edited', clientRef: 'b1' });
      expect(s.parked.s1!.queue.map((q) => q.text)).toEqual(['lost', 'steer', 'back']);
      expect(s.parked.s1!.queue[0]).toMatchObject({ maybeSent: 1, ref: 'r1' });
      expect(pane(s).queue.map((q) => q.text)).toEqual(['plain']);
      expect(pane(s).queuePaused).toBe(true);
    });

    // M6: opening another session / clearing / closing the pane never silently drops held items.
    it('held items stay with their session when the pane opens another one, and come back (paused) when it is reopened', () => {
      let s = refusedSend('draining');
      s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'two' });
      expect(pane(s).queue).toEqual([]);
      expect(s.parked.s1!.queue.map((q) => q.text)).toEqual(['mine', 'later']);
      s = reducer(s, { type: 'clear_pane' });
      s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
      expect(pane(s).queue.map((q) => [q.text, q.restart])).toEqual([['mine', undefined], ['later', undefined]]);
      expect(pane(s).queuePaused).toBe(true);
      expect(s.parked).toEqual({});
    });

    it('L3: held items of a new session are kept with its folder (attachments too) and come back into the next new session there', () => {
      let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
      s = reducer(s, { type: 'sent', text: 'first', clientRef: 'r1', attachments: [{ id: 'a1', name: 'f.txt', isImage: false }] });
      s = play([{ type: 'error', turnId: null, message: DRAIN, clientRef: 'r1', code: 'draining' }], s);
      s = reducer(s, { type: 'clear_pane' });
      expect(s.error).toContain('first');
      expect(s.parked['__new__:/w']!.queue.map((q) => [q.text, q.attachments.map((a) => a.id)])).toEqual([['first', ['a1']]]);
      s = reducer(s, { type: 'open', sessionId: null, cwd: '/other', title: 'new' });
      expect(pane(s).queue).toEqual([]);
      s = reducer(s, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
      expect(pane(s).queue.map((q) => [q.text, q.attachments.map((a) => a.id), q.ref])).toEqual([['first', ['a1'], 'r1']]);
      expect(pane(s).queuePaused).toBe(true);
      expect(s.parked).toEqual({});
    });

    it('closing a pane parks its held items too', () => {
      let s = reducer(refusedSend('draining'), { type: 'add_pane' });
      s = reducer(s, { type: 'close_pane', paneId: 'p0' });
      expect(s.parked.s1!.queue.map((q) => q.text)).toEqual(['mine', 'later']);
    });

    // LOW: a refused fork keeps its text; a hold is released by the next history even without a reconnect.
    it('a refused branch_edit keeps its text: queued, paused (sent only by the user)', () => {
      let s = play([history(['old'])], openedOn('s1'));
      s = reducer(s, { type: 'branch_edit', n: 0, text: 'edited', clientRef: 'b1' });
      s = play([{ type: 'error', turnId: null, message: DRAIN, clientRef: 'b1', code: 'draining' }], s);
      expect(pane(s).items).toEqual([]);
      expect(pane(s).queue.map((q) => [q.text, q.restart])).toEqual([['edited', undefined]]);
      expect(pane(s).queuePaused).toBe(true);
      s = play([hello], s);
      expect(nextQueued(pane(s))).toBeNull();
    });

    it('a held item is released by the next history even if no reconnect ever comes', () => {
      let s = refusedSend('draining');
      expect(nextQueued(pane(s))).toBeNull();
      s = play([history(['old'])], s);
      expect(nextQueued(pane(s))?.text).toBe('mine');
    });

    it('draining in a new session (no id, no history): sent right after the reconnect', () => {
      let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'new' });
      s = reducer(s, { type: 'sent', text: 'first', clientRef: 'r1' });
      s = play([{ type: 'error', turnId: null, message: DRAIN, clientRef: 'r1', code: 'draining' }], s);
      expect(pane(s).items).toEqual([]);
      expect(nextQueued(pane(s))).toBeNull();
      s = play([hello], s);
      expect(nextQueued(pane(s))?.text).toBe('first');
    });

    it('draining refused again after a reconnect: a fresh item, held for the next reconnect', () => {
      let s = refusedSend('draining');
      s = play([hello, history(['old'])], s);
      const first = nextQueued(pane(s))!;
      s = reducer(s, { type: 'queue_remove', id: first.id });
      s = reducer(s, { type: 'sent', text: first.text, attachments: [file], clientRef: 'r2' });
      s = play([{ type: 'error', turnId: null, message: DRAIN, clientRef: 'r2', code: 'draining' }], s);
      expect(pane(s).queue[0]!.id).not.toBe(first.id);
      expect(nextQueued(pane(s))).toBeNull();
    });

    it('지금 전송 sends a held item at once', () => {
      let s = refusedSend('draining');
      s = reducer(s, { type: 'queue_send_now', id: pane(s).queue[0]!.id });
      expect(nextQueued(pane(s))?.text).toBe('mine');
    });

    it('a steer refused while draining is held, then sent after the reconnect', () => {
      let s = running();
      s = reducer(s, { type: 'queue_add', text: 'steer me', steerId: 'k1' });
      s = play([{ type: 'steer_rejected', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: 'k1', message: DRAIN, code: 'draining' }], s);
      s = result(s, 't1', true);
      expect(pane(s).queue[0]!.steer).toBeUndefined();
      expect(nextQueued(pane(s))).toBeNull();
      s = play([hello, history(['first'])], s);
      expect(nextQueued(pane(s))?.text).toBe('steer me');
    });

    // Round 2 (adversarial review).
    const historyWith = (messages: { text: string; n: number }[], acceptedRefs?: string[]): ServerMessage => ({ type: 'history', sessionId: 's1', cwd: '/w', account: null, runningTurnId: null, messages: messages.map((m) => ({ kind: 'user' as const, ts: null, ...m })), ...(acceptedRefs ? { acceptedRefs } : {}) });

    it('H1: a refused branch_edit goes back to the original session with the edited text and the held items, paused', () => {
      let s = refusedSend('draining');
      s = { ...s, panes: [{ ...pane(s), items: [{ kind: 'user', text: 'old', n: 0 }] }] };
      s = reducer(s, { type: 'branch_edit', n: 0, text: 'edited', clientRef: 'b1' });
      s = play([{ type: 'error', turnId: null, message: DRAIN, clientRef: 'b1', code: 'draining' }], s);
      s = reducer(s, { type: 'branch_undo', sessionId: 's1' });
      s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
      // 'mine' (held) was parked with s1 at the fork; what followed the fork goes back ahead of it.
      expect(pane(s).queue.map((q) => q.text)).toEqual(['edited', 'later', 'mine']);
      expect(pane(s).queue.every((q) => !q.restart)).toBe(true);
      expect(pane(s).queuePaused).toBe(true);
      expect(s.parked).toEqual({});
      expect(nextQueued(pane(s))).toBeNull();
    });

    it('M1: acceptedRefs decides — dropped only if its clientRef is listed, even with a task-notification interleaved', () => {
      // A <task-notification> record counted as a user message: '계속' sits one past the ordinal it was sent at.
      let s = lostSend('계속', ['old']);
      expect(pane(s).queue[0]).toMatchObject({ text: '계속', maybeSent: 1, ref: 'r1' });
      const transcript = [{ text: 'old', n: 0 }, { text: '<task-notification>done</task-notification>', n: 1 }, { text: '계속', n: 2 }];
      expect(pane(play([historyWith(transcript, ['r1'])], s)).queue).toEqual([]);
      // not listed: it did not go in (the same text at that spot is an earlier message) — sent again, under the same ref
      const kept = play([historyWith(transcript, ['other'])], s);
      expect(pane(kept).queue.map((q) => [q.text, q.ref])).toEqual([['계속', 'r1']]);
      expect(nextQueued(pane(kept))?.ref).toBe('r1');
    });

    it('M1 fallback (no acceptedRefs): the text anywhere at or after the ordinal, after a task-notification', () => {
      const s = lostSend('계속', ['old']);
      expect(pane(play([historyWith([{ text: 'old', n: 0 }, { text: '<task-notification>x</task-notification>', n: 1 }, { text: '계속', n: 2 }])], s)).queue).toEqual([]);
      expect(pane(play([historyWith([{ text: '계속', n: 0 }, { text: 'old', n: 1 }])], s)).queue.map((q) => q.text)).toEqual(['계속']);
    });

    it('M1 fallback: an attachment-only send (the server rewrote its empty text to the file lines) is recognised', () => {
      let s = play([history(['old'])], openedOn('s1'));
      s = reducer(s, { type: 'sent', text: '', attachments: [file], clientRef: 'r1' });
      s = play([hello], s);
      expect(pane(s).queue.map((q) => [q.text, q.maybeSent])).toEqual([['', 1]]);
      s = play([historyWith([{ text: 'old', n: 0 }, { text: '\n\n첨부 파일: /tmp/x.png', n: 1 }])], s);
      expect(pane(s).queue).toEqual([]);
    });

    it('M1: a draining refusal is never dropped, even if acceptedRefs lists something', () => {
      let s = refusedSend('draining');
      s = play([hello, historyWith([{ text: 'old', n: 0 }, { text: 'mine', n: 1 }], ['r1'])], s);
      expect(pane(s).queue.map((q) => q.text)).toEqual(['mine', 'later']);
    });

    it('M1: a lost steer the server lists as accepted is dropped', () => {
      let s = running();
      s = reducer(s, { type: 'queue_add', text: 'maybe-in', steerId: 'k2' });
      s = result(s, 't1', true);
      s = play([hello, historyWith([{ text: 'first', n: 0 }], ['r1', 'k2'])], s);
      expect(pane(s).queue).toEqual([]);
    });

    it('M2: the queue runner\'s ready flag is set by hello only, and cleared by a disconnect', () => {
      let s = reducer(initialState, { type: 'connected', value: true });
      expect(s.ready).toBe(false);
      s = play([hello], s);
      expect(s.ready).toBe(true);
      s = reducer(s, { type: 'connected', value: false });
      expect(s.ready).toBe(false);
    });

    it('disconnectedSince: set by the first disconnect (kept across retries), cleared by connected or a hello', () => {
      let s = reducer(initialState, { type: 'connected', value: true });
      expect(s.disconnectedSince).toBeNull();
      s = reducer(s, { type: 'connected', value: false, at: 1000 });
      expect(s.disconnectedSince).toBe(1000);
      // Each failed reconnect reports false again: the start of the outage does not move.
      s = reducer(s, { type: 'connected', value: false, at: 5000 });
      expect(s.disconnectedSince).toBe(1000);
      s = reducer(s, { type: 'connected', value: true });
      expect(s.disconnectedSince).toBeNull();
      s = reducer(s, { type: 'connected', value: false, at: 9000 });
      s = play([hello], s);
      expect(s.connected).toBe(true);
      expect(s.disconnectedSince).toBeNull();
    });

    it('L1: messages waiting for a history that fails (open_session error) become ordinary paused items; 이어서 보내기 releases holds', () => {
      let s = lostSend('계속', ['old']);
      s = play([{ type: 'error', turnId: null, message: '세션을 찾을 수 없습니다: s1', sessionId: 's1' }], s);
      expect(pane(s).queue.map((q) => [q.text, q.restart, q.maybeSent])).toEqual([['계속', undefined, undefined]]);
      expect(pane(s).queuePaused).toBe(true);
      expect(pane(s).notices?.map((n) => n.message)).toEqual(['세션을 찾을 수 없습니다: s1']);
      let d = refusedSend('draining');
      expect(pane(d).queue[0]!.restart).toBe('hold');
      d = reducer(d, { type: 'queue_resume' });
      expect(pane(d).queue[0]!.restart).toBeUndefined();
      expect(nextQueued(pane(d))?.text).toBe('mine');
    });

    it('H: the drain broadcast and another session\'s open_session error do not stop messages waiting for this history', () => {
      let s = lostSend('계속', ['old']);
      s = play([{ type: 'error', turnId: null, message: DRAIN, code: 'draining' }], s);
      s = play([{ type: 'error', turnId: null, message: '세션을 찾을 수 없습니다: s9', sessionId: 's9' }], s);
      s = play([{ type: 'error', turnId: null, message: '형식 오류' }], s);
      expect(pane(s).queue.map((q) => [q.text, q.restart, q.maybeSent])).toEqual([['계속', 'hello', 1]]);
      s = play([historyWith([{ text: 'old', n: 0 }], [])], s);
      expect(nextQueued(pane(s))?.text).toBe('계속');
    });

    // Round 3.
    it('B: a lost send too old for the server\'s acceptedRefs (or without a send time) is not sent again: paused, with a banner', () => {
      const old = Date.now() - ACCEPTED_REFS_TTL_MS + 30 * 60_000; // within the last hour of the server's memory
      for (const at of [old, undefined]) {
        let s = lostSend('계속', ['old']);
        s = { ...s, panes: [{ ...pane(s), queue: pane(s).queue.map(({ at: _a, ...q }) => ({ ...q, ...(at !== undefined ? { at } : {}) })) }] };
        s = play([historyWith([{ text: 'old', n: 0 }], [])], s);
        expect(pane(s).queue.map((q) => [q.text, q.restart, q.maybeSent, q.ref])).toEqual([['계속', undefined, undefined, 'r1']]);
        expect(pane(s).queuePaused).toBe(true);
        expect(nextQueued(pane(s))).toBeNull();
        expect(s.error).toBe('이미 들어갔을 수 있어 멈춰 둔 메시지: 계속');
      }
      // A fresh one is sent again (it carries its send time).
      const fresh = play([historyWith([{ text: 'old', n: 0 }], [])], lostSend('계속', ['old']));
      expect(nextQueued(pane(fresh))?.text).toBe('계속');
      expect(fresh.error).toBeNull();
    });

    it('catchup: the transcript and the running turn stay as they are; the queue is settled as a history would', () => {
      const caughtUp = (extra: Partial<Extract<ServerMessage, { type: 'catchup' }>> = {}): ServerMessage => ({ type: 'catchup', sessionId: 's1', runningTurnId: null, acceptedRefs: [], ...extra });
      const base = lostSend('계속', ['old']);
      const items = pane(base).items;
      // listed as accepted: it went in — dropped
      let s = play([caughtUp({ acceptedRefs: ['r1'] })], base);
      expect(pane(s).queue).toEqual([]);
      expect(pane(s).items).toBe(items);
      expect(pane(s).loading).toBeFalsy();
      // not listed: sent again under the same ref
      s = play([caughtUp()], base);
      expect(nextQueued(pane(s))?.ref).toBe('r1');
      expect(pane(s).items).toBe(items);
      // going in right now: paused, with the banner
      s = play([caughtUp({ pendingRefs: ['r1'] })], base);
      expect(pane(s).queuePaused).toBe(true);
      expect(nextQueued(pane(s))).toBeNull();
      expect(s.error).toBe('이미 들어갔을 수 있어 멈춰 둔 메시지: 계속');
      // the session's server-side settings come with it
      s = play([caughtUp({ accountPin: 'b', permissionMode: 'plan', sessionModel: 'fable' })], base);
      expect(pane(s).session).toMatchObject({ sessionId: 's1', accountPin: 'b', permissionMode: 'plan' });
      expect(pane(s).model).toBe('fable');
      // about a session no pane shows: nothing
      expect(play([caughtUp({ sessionId: 'other', acceptedRefs: ['r1'] })], base)).toBe(base);
    });

    it('catchup: what was missed follows as ordinary events onto the turn already on screen', () => {
      let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
      s = play([{ type: 'history', sessionId: 's1', cwd: '/w', account: null, runningTurnId: 't1', messages: [] }, { type: 'delta', turnId: 't1', sessionId: 's1', cwd: '/w', text: 'a' }], s);
      s = play([{ type: 'catchup', sessionId: 's1', runningTurnId: 't1', acceptedRefs: [] }, { type: 'delta', turnId: 't1', sessionId: 's1', cwd: '/w', text: 'b' }], s);
      expect(pane(s).activeTurnId).toBe('t1');
      expect(pane(s).items.at(-1)).toMatchObject({ kind: 'assistant', turnId: 't1', text: 'ab', streaming: true });
    });

    it('C: a lost send the server is injecting right now (pendingRefs) is never sent by itself', () => {
      let s = lostSend('계속', ['old']);
      s = play([{ ...historyWith([{ text: 'old', n: 0 }], []), pendingRefs: ['r1'] } as ServerMessage], s);
      expect(pane(s).queue.map((q) => [q.text, q.restart])).toEqual([['계속', undefined]]);
      expect(pane(s).queuePaused).toBe(true);
      expect(nextQueued(pane(s))).toBeNull();
      expect(s.error).toContain('계속');
    });

    it('D: already_accepted ends the wait without requeueing, takes the extra bubble back and shows no error', () => {
      let s = play([history(['old'])], openedOn('s1'));
      s = reducer(s, { type: 'sent', text: 'again', clientRef: 'r1' });
      s = play([{ type: 'error', turnId: null, message: '이미 들어간 메시지라 다시 보내지 않았습니다', clientRef: 'r1', code: 'already_accepted', sessionId: 's1' }], s);
      expect(pane(s)).toMatchObject({ awaitingStart: false, awaitingRef: null, awaitingSend: null, queue: [], queuePaused: false, notices: [] });
      expect(pane(s).items.map((it) => it.kind === 'user' && it.text)).toEqual(['old']);
      expect(s.error).toBeNull();
    });

    it('D: a steer refused as already_accepted is dropped from the queue', () => {
      let s = running();
      s = reducer(s, { type: 'queue_add', text: 'in already', steerId: 'k1' });
      s = play([{ type: 'steer_rejected', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: 'k1', message: 'x', code: 'already_accepted' }], s);
      expect(pane(s).queue).toEqual([]);
    });

    // Round 4.
    it('in_flight: a send or steer the server is taking right now under its ref is kept — plain, paused, with its ref, and a banner', () => {
      const IN = '아직 처리 중인 메시지 — 멈춰 둠';
      let s = reducer(play([history(['old'])], openedOn('s1')), { type: 'sent', text: 'again', clientRef: 'r1' });
      s = play([{ type: 'error', turnId: null, message: IN, clientRef: 'r1', code: 'in_flight' }], s);
      expect(pane(s).queue.map((q) => [q.text, q.ref, q.restart, q.maybeSent])).toEqual([['again', 'r1', undefined, undefined]]);
      expect(pane(s)).toMatchObject({ awaitingStart: false, awaitingRef: null, queuePaused: true });
      expect(nextQueued(pane(s))).toBeNull();
      expect(s.error).toBe(IN);
      let t = reducer(running(), { type: 'queue_add', text: 'st', steerId: 'k1' });
      t = play([{ type: 'steer_rejected', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: 'k1', message: IN, code: 'in_flight' }], t);
      expect(pane(t).queue.map((q) => [q.text, q.steer, q.lostSteer])).toEqual([['st', undefined, 'k1']]);
      expect(pane(t).queuePaused).toBe(true);
      expect(nextQueued(pane(t))).toBeNull();
      expect(t.error).toBe(IN);
    });

    it('acceptedRefsSince: a lost send from before the oldest ref the server\'s cap kept is in doubt — paused, not resent', () => {
      let s = lostSend('계속', ['old']);
      const at = pane(s).queue[0]!.at!;
      s = play([{ ...historyWith([{ text: 'old', n: 0 }], []), acceptedRefsSince: at + 2 * 3_600_000 } as ServerMessage], s);
      expect(pane(s).queue.map((q) => [q.text, q.restart, q.ref])).toEqual([['계속', undefined, 'r1']]);
      expect(pane(s).queuePaused).toBe(true);
      expect(nextQueued(pane(s))).toBeNull();
      expect(s.error).toContain('계속');
      // Sent after it: the list can tell — sent again.
      const fresh = play([{ ...historyWith([{ text: 'old', n: 0 }], []), acceptedRefsSince: at - 2 * 3_600_000 } as ServerMessage], lostSend('계속', ['old']));
      expect(nextQueued(pane(fresh))?.text).toBe('계속');
    });

    it('turn_started echoing the ref of a queued copy drops the copy: it is that very message, gone in', () => {
      let s = reducer(play([history(['old'])], openedOn('s1')), { type: 'sent', text: 'again', clientRef: 'r1' });
      s = play([{ type: 'error', turnId: null, message: 'x', clientRef: 'r1', code: 'in_flight' }], s);
      s = reducer(s, { type: 'queue_add', text: 'other' });
      s = play([{ type: 'turn_started', turnId: 't9', sessionId: 's1', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0, clientRef: 'r1', prompt: { text: 'again', attachments: [] } }], s);
      expect(pane(s).queue.map((q) => q.text)).toEqual(['other']);
    });

    it('B: a send and a steer carry their send time; a lost one keeps it', () => {
      let s = reducer(play([history(['old'])], openedOn('s1')), { type: 'sent', text: 'm', clientRef: 'r1' });
      expect(pane(s).awaitingSend?.at).toEqual(expect.any(Number));
      s = play([hello], s);
      expect(pane(s).queue[0]!.at).toEqual(expect.any(Number));
      let t = reducer(running(), { type: 'queue_add', text: 'st', steerId: 'k1' });
      const at = pane(t).queue[0]!.at;
      expect(at).toEqual(expect.any(Number));
      t = reducer(t, { type: 'steer_lost', steerId: 'k1' });
      expect(pane(t).queue[0]).toMatchObject({ lostSteer: 'k1', at });
    });

    it('F: items back from a parked bucket are kept — leaving the session again parks them instead of dropping them', () => {
      let s = refusedSend('draining');
      s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'two' });
      s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
      expect(pane(s).queue.map((q) => [q.text, q.kept])).toEqual([['mine', true], ['later', true]]);
      s = reducer(reducer(s, { type: 'dismiss_error' }), { type: 'open', sessionId: 's2', cwd: '/w', title: 'two' });
      expect(s.parked.s1!.queue.map((q) => q.text)).toEqual(['mine', 'later']);
      expect(s.error).toBeNull();
    });

    it('I: opening the session the pane already shows keeps its queue and pending send', () => {
      let s = refusedSend('draining');
      s = reducer(s, { type: 'sent', text: 'waiting', clientRef: 'r2', keepPaused: true });
      s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
      expect(pane(s).queue.map((q) => [q.text, q.restart])).toEqual([['mine', 'hold'], ['later', undefined]]);
      expect(pane(s)).toMatchObject({ awaitingStart: true, awaitingRef: 'r2' });
      expect(s.parked).toEqual({});
    });

    it('L2: a refusal naming a turn that never started (older server) still requeues the send', () => {
      let s = play([history(['old'])], openedOn('s1'));
      s = reducer(s, { type: 'sent', text: 'mine', clientRef: 'r1' });
      s = play([{ type: 'error', turnId: 'never', message: '실행 실패', clientRef: 'r1' }], s);
      expect(pane(s).queue.map((q) => q.text)).toEqual(['mine']);
    });

    it('L4: two draining refusals in a row keep their order', () => {
      let s = refusedSend('draining');
      s = reducer(s, { type: 'sent', text: 'second', clientRef: 'r2' });
      s = play([{ type: 'error', turnId: null, message: DRAIN, clientRef: 'r2', code: 'draining' }], s);
      expect(pane(s).queue.map((q) => [q.text, q.restart])).toEqual([['mine', 'hold'], ['second', 'hold'], ['later', undefined]]);
    });

    it('opening another session parks ordinary queued items with it too — never let go', () => {
      let s = reducer(openedOn('s1'), { type: 'queue_add', text: 'typed' });
      s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 'two' });
      expect(s.error ?? null).toBeNull();
      expect(s.parked.s1!.queue.map((q) => q.text)).toEqual(['typed']);
    });
  });

  it('a successful turn leaves the queue running', () => {
    let s = reducer(running(), { type: 'queue_add', text: 'second' });
    s = result(s, 't1', true);
    expect(pane(s).queuePaused).toBe(false);
  });
});

describe('restoreSentFiles (ux-state)', () => {
  const img = { id: '11111111-2222-3333-4444-555555555555', name: 'a.png', isImage: true };
  const doc = { id: '66666666-2222-3333-4444-555555555555', name: 'b.md', isImage: false };
  it('matches records in order by typed text (exact, or followed by the server-added lines)', () => {
    const items: ChatItem[] = [
      { kind: 'user', text: 'hello' },
      { kind: 'user', text: 'look\n[이미지]' },
      { kind: 'user', text: 'lookalike' },
      { kind: 'user', text: 'read this\n\n첨부 파일: /x/b.md' },
    ];
    const out = restoreSentFiles(items, [{ text: 'look', files: [img] }, { text: 'read this', files: [doc] }]);
    expect(out.map((i) => (i.kind === 'user' ? i.attachments ?? null : null))).toEqual([null, [img], null, [doc]]);
    expect(restoreSentFiles(items, [])).toEqual(items);
  });

  it('a history action carrying sentFiles restores them onto the pane', () => {
    const s0 = openedOn('s1');
    const s = reducer(s0, { type: 'server', msg: { type: 'history', sessionId: 's1', cwd: '/w', account: 'b', messages: [{ kind: 'user', text: 'look\n[이미지]', ts: null }], runningTurnId: null } as ServerMessage, sentFiles: [{ text: 'look', files: [img] }] });
    expect(pane(s).items[0]).toEqual({ kind: 'user', text: 'look\n[이미지]', attachments: [img] });
  });
});

describe('cross-device prompt sync', () => {
  const S = 'sess-x';
  const ts = (turnId: string, extra: Partial<Extract<ServerMessage, { type: 'turn_started' }>> = {}): ServerMessage => ({ type: 'turn_started', turnId, sessionId: S, cwd: '/w', account: 'b', model: 'sonnet', reason: 'r', attempt: 0, engine: 'claude', ...extra });
  const viewing = (): AppState => play([{ type: 'history', sessionId: S, cwd: '/w', account: 'b', messages: [{ kind: 'user', text: 'old', ts: null }], runningTurnId: null }], openedOn(S));

  it('a pane viewing the session shows another device\'s prompt (with attachments) before the turn\'s answer', () => {
    const s = play([
      ts('t1', { clientRef: 'other-tab-1', prompt: { text: '1+1만 답해', attachments: [{ id: 'a1', name: 'shot.png', isImage: true }] } }),
      { type: 'delta', turnId: 't1', sessionId: S, cwd: '/w', text: '2' },
    ], viewing());
    expect(pane(s).items.map((it) => it.kind)).toEqual(['user', 'user', 'assistant']);
    expect(pane(s).items[1]).toEqual({ kind: 'user', text: '1+1만 답해', attachments: [{ id: 'a1', name: 'shot.png', isImage: true }] });
    expect(pane(s).items[2]).toMatchObject({ kind: 'assistant', turnId: 't1', text: '2', streaming: true });
    expect(pane(s).activeTurnId).toBe('t1');
  });

  it('the sending pane does not duplicate its own bubble', () => {
    let s = reducer(viewing(), { type: 'sent', text: 'hi', paneId: 'p0', clientRef: 'r0' });
    s = play([ts('t1', { clientRef: 'r0', prompt: { text: 'hi', attachments: [] } })], s);
    expect(pane(s).items.map((it) => (it.kind === 'user' ? it.text : 'A'))).toEqual(['old', 'hi', 'A']);
  });

  it('a second pane on the same session in the sending tab shows the bubble once; a retry start adds nothing', () => {
    let s = reducer(viewing(), { type: 'add_pane' });
    s = reducer(s, { type: 'open', sessionId: S, cwd: '/w', title: 't', paneId: 'p1' });
    s = play([{ type: 'history', sessionId: S, cwd: '/w', account: 'b', messages: [{ kind: 'user', text: 'old', ts: null }], runningTurnId: null }], s);
    s = reducer(s, { type: 'sent', text: 'hi', paneId: 'p0', clientRef: 'r0' });
    const start = ts('t1', { clientRef: 'r0', prompt: { text: 'hi', attachments: [] } });
    s = play([start, { ...start, attempt: 1 } as ServerMessage], s);
    const texts = (i: number) => s.panes[i]!.items.map((it) => (it.kind === 'user' ? it.text : 'A'));
    expect(texts(0)).toEqual(['old', 'hi', 'A']);
    expect(texts(1)).toEqual(['old', 'hi', 'A']);
  });

  it('a background continuation (no prompt) adds only the assistant segment', () => {
    const s = play([ts('t1:bg1', { reason: '백그라운드 계속' })], viewing());
    expect(pane(s).items.map((it) => it.kind)).toEqual(['user', 'assistant']);
  });

  it('opening mid-turn shows the running prompt unless the transcript already has it', () => {
    const base = { type: 'history', sessionId: S, cwd: '/w', account: 'b', runningTurnId: 't9' } as const;
    const fresh = play([{ ...base, messages: [{ kind: 'user', text: 'old', ts: null }, { kind: 'assistant', text: 'a', model: null, toolCalls: [], ts: null }], runningPrompt: { text: 'new q', attachments: [{ id: 'a1', name: 'f.txt', isImage: false }] } }], openedOn(S));
    expect(pane(fresh).items.map((it) => (it.kind === 'user' ? it.text : 'A'))).toEqual(['old', 'A', 'new q', 'A']);
    expect(pane(fresh).items[2]).toMatchObject({ attachments: [{ id: 'a1', name: 'f.txt', isImage: false }] });
    expect(pane(fresh).items[3]).toMatchObject({ turnId: 't9', streaming: true });
    const written = play([{ ...base, messages: [{ kind: 'user', text: 'new q\n\n첨부 파일: /x/f.txt', ts: null }], runningPrompt: { text: 'new q', attachments: [{ id: 'a1', name: 'f.txt', isImage: false }] } }], openedOn(S));
    expect(pane(written).items.map((it) => it.kind)).toEqual(['user', 'assistant']);
    expect(pane(written).items[0]).toMatchObject({ attachments: [{ id: 'a1', name: 'f.txt', isImage: false }] });
  });
});

describe('context gauge state', () => {
  const S = 'sctx';
  const usage0 = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 };
  it('history restores the context from the last assistant usage (window from the model)', () => {
    const s = play([{ type: 'history', sessionId: S, cwd: '/w', account: 'b', messages: [
      { kind: 'assistant', text: 'a', model: 'claude-opus-5-5', toolCalls: [], ts: '2026-10-01T00:00:00.000Z', usage: { inputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3 } },
      { kind: 'user', text: 'q', ts: null },
      { kind: 'assistant', text: 'b', model: 'claude-opus-5-5', toolCalls: [], ts: '2026-10-01T01:00:00.000Z', usage: { inputTokens: 4, cacheReadTokens: 300_000, cacheCreationTokens: 6 } },
    ], runningTurnId: null }], openedOn(S));
    const items = pane(s).items as Extract<ChatItem, { kind: 'assistant' }>[];
    expect(items.at(-1)!.ctx).toEqual({ usage: { inputTokens: 4, cacheReadTokens: 300_000, cacheCreationTokens: 6 }, window: 1_000_000, at: Date.parse('2026-10-01T01:00:00.000Z'), model: 'claude-opus-5-5', account: null });
  });
  it('turn_result sets the turn context from badge.usage.context and notes a cold cache write', () => {
    const s0 = play([{ type: 'history', sessionId: S, cwd: '/w', account: 'b', messages: [
      { kind: 'assistant', text: 'a', model: 'claude-opus-5-5', toolCalls: [], ts: null, usage: { inputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3 } },
    ], runningTurnId: null }], openedOn(S));
    const s = play([
      { type: 'turn_started', turnId: 'tc', sessionId: S, cwd: '/w', account: 'c', model: 'opus', reason: '5h 한도 → C 전환', attempt: 1 },
      { type: 'turn_result', turnId: 'tc', sessionId: S, cwd: '/w', ok: true, text: 'ok', errorText: null, badge: { account: 'c', model: 'opus', reason: '5h 한도 → C 전환', modelNote: null, usage: { ...usage0, cacheCreationTokens: 120_000, context: { inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 120_000 }, contextWindow: 1_000_000 } } },
    ], s0);
    const last = pane(s).items.at(-1) as Extract<ChatItem, { kind: 'assistant' }>;
    expect(last.ctx).toMatchObject({ usage: { cacheCreationTokens: 120_000 }, window: 1_000_000, model: 'opus', account: 'c' });
    expect(last.cacheNote).toBe('캐시 새로 씀 · 계정 전환');
  });
});

describe('reducer: 새 세션으로 이어가기 (handoff)', () => {
  const badge = { account: 'b' as const, model: 'opus' as const, reason: 'r', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null };
  const SID = '11111111-1111-4111-8111-111111111111';
  const start = (): AppState => {
    let s = reducer(initialState, { type: 'open', sessionId: SID, cwd: '/w', title: '작업' });
    s = reducer(s, { type: 'sent', text: HANDOFF_PROMPT, clientRef: 'h1', handoff: true });
    return play([{ type: 'turn_started', turnId: 'th', sessionId: SID, cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0, clientRef: 'h1' }], s);
  };

  it('a finished note turn switches the pane to a new session in the same folder with the first message prefilled (not sent)', () => {
    let s = start();
    expect(pane(s).handoff).toMatchObject({ ref: 'h1', turnId: 'th', sessionId: SID, title: '작업', cwd: '/w' });
    s = play([
      { type: 'delta', turnId: 'th', sessionId: SID, cwd: '/w', text: '## 목표\n- X' },
      { type: 'turn_result', turnId: 'th', sessionId: SID, cwd: '/w', ok: true, text: '## 목표\n- X', badge, errorText: null },
    ], s);
    const p = pane(s);
    expect(p.session).toMatchObject({ sessionId: null, cwd: '/w', title: '작업 (이어서)', engine: 'claude' });
    expect(p.items).toEqual([]);
    expect(p.handoff).toBeNull();
    expect(p.handoffFrom).toEqual({ sessionId: SID, title: '작업' });
    expect(p.prefill).toBe(handoffFirstMessage('작업', SID, '## 목표\n- X'));
    expect(p.prefill).toContain(`이전 세션(작업, ${SID})에서 이어서 작업합니다. 인계 메모:\n\n## 목표\n- X\n\n`);
    expect(p.activeTurnId).toBeNull();
    // Sending clears the prefill; handoffFrom stays for the 이전 세션 link (and the send's handoffFrom).
    s = reducer(s, { type: 'sent', text: p.prefill!, clientRef: 'n1' });
    expect(pane(s).prefill).toBeNull();
    expect(pane(s).handoffFrom).toEqual({ sessionId: SID, title: '작업' });
    // Opening another session drops it.
    expect(pane(reducer(s, { type: 'open', sessionId: 'other', cwd: '/w', title: 'o' })).handoffFrom).toBeNull();
  });

  it('the new session keeps the old session\'s account pin', () => {
    let s = reducer(start(), { type: 'set_account_pin', paneId: initialState.panes[0]!.id, pin: 'c' });
    s = play([{ type: 'turn_result', turnId: 'th', sessionId: SID, cwd: '/w', ok: true, text: '메모', badge, errorText: null }], s);
    expect(pane(s).session).toMatchObject({ sessionId: null, accountPin: 'c' });
  });

  it('a failed note turn or a refused send keeps the old session', () => {
    const failed = play([{ type: 'turn_result', turnId: 'th', sessionId: SID, cwd: '/w', ok: false, text: '', badge, errorText: 'boom' }], start());
    expect(pane(failed).session?.sessionId).toBe(SID);
    expect(pane(failed).handoff).toBeNull();
    expect(pane(failed).prefill).toBeNull();
    let s = reducer(initialState, { type: 'open', sessionId: SID, cwd: '/w', title: '작업' });
    s = reducer(s, { type: 'sent', text: HANDOFF_PROMPT, clientRef: 'h2', handoff: true });
    s = play([{ type: 'error', turnId: null, message: '세션이 실행 중이라 지금은 넘길 수 없습니다', clientRef: 'h2' }], s);
    expect(pane(s).handoff).toBeNull();
    expect(pane(s).session?.sessionId).toBe(SID);
  });

  it('an id-less pane drops handoffFrom once the index shows the old session already continues elsewhere', () => {
    let s = play([{ type: 'turn_result', turnId: 'th', sessionId: SID, cwd: '/w', ok: true, text: '메모', badge, errorText: null }], start());
    const entry = (extra: object) => ({ sessionId: SID, account: 'b', cwd: '/w', projectDir: '/w', file: 'f', title: '작업', lastModified: 0, sizeBytes: 0, ...extra }) as const;
    s = play([{ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry({})] }] }], s);
    expect(pane(s).handoffFrom).toEqual({ sessionId: SID, title: '작업' });
    // e.g. the page reloaded mid first send: the server linked SID → another session meanwhile
    s = play([{ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry({ nextSession: '22222222-2222-4222-8222-222222222222' })] }] }], s);
    expect(pane(s).handoffFrom).toBeNull();
    expect(pane(s).prefill).not.toBeNull(); // the composer text stays
  });

  it('a new session (no id) records no handoff', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = reducer(s, { type: 'sent', text: HANDOFF_PROMPT, clientRef: 'h3', handoff: true });
    expect(pane(s).handoff).toBeNull();
  });
});

describe('permission modes', () => {
  const open = (sessionId: string | null) => reducer(initialState, { type: 'open', sessionId, cwd: '/w', title: 't' });
  const first = (st: AppState) => st.panes[0]!;

  it('a pane follows the server default until it picks its own; Shift+Tab cycles from the effective mode', () => {
    let s = play([{ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default' } }], open(null));
    expect(s.defaultPermMode).toBe('default');
    expect(paneMode(first(s), s.defaultPermMode)).toBe('default');
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = reducer(s, { type: 'set_permission_mode', mode: nextPermMode(paneMode(first(s), s.defaultPermMode)) });
      seen.push(paneMode(first(s), s.defaultPermMode));
    }
    expect(seen).toEqual(['acceptEdits', 'plan', 'bypassPermissions', 'default']);
    // The pane's own choice is kept when the default changes.
    s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions' } }], s);
    expect(paneMode(first(s), s.defaultPermMode)).toBe('default');
    expect(paneMode(first(open(null)), 'plan')).toBe('plan');
    expect(paneMode(first(open(null)), null)).toBe('default');
  });

  it('메시지 편집 갈래 keeps the parent\'s mode on the pane (the server forks in it)', () => {
    let s = play([{ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', runningTurnId: null, messages: [{ role: 'user', text: 'q', ts: null }] as never, permissionMode: 'plan' }], open('s1'));
    s = reducer(s, { type: 'branch_edit', n: 1, text: 'q2', clientRef: 'r' });
    expect(first(s).session).toMatchObject({ sessionId: null, permissionMode: 'plan' });
  });

  it('a pick during a new session\'s first turn is pending; a broadcast for the new id does not overwrite it', () => {
    let s = reducer(open(null), { type: 'sent', text: 'x', clientRef: 'r1' });
    s = reducer(s, { type: 'set_permission_mode', mode: 'plan' });
    expect(first(s).session).toMatchObject({ permissionMode: 'plan', permissionModePending: true });
    s = play([{ type: 'turn_started', turnId: 't1', sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0, engine: 'claude', clientRef: 'r1' } as ServerMessage,
      { type: 'turn_result', turnId: 't1', sessionId: 'n1', cwd: '/w', ok: true, text: '', badge: null, errorText: null },
      { type: 'permission_mode', sessionId: 'n1', mode: 'default' }], s);
    expect(first(s).session).toMatchObject({ sessionId: 'n1', permissionMode: 'plan', permissionModePending: true });
    // Re-applying the pick once the id is known (what useQueueRunner does with the send) clears it.
    s = reducer(s, { type: 'set_permission_mode', mode: 'plan' });
    expect(first(s).session?.permissionModePending).toBeUndefined();
  });

  it('history and permission_mode broadcasts set the session\'s mode (only for that session)', () => {
    let s = play([{ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', runningTurnId: null, messages: [], permissionMode: 'plan' }], open('s1'));
    expect(first(s).session?.permissionMode).toBe('plan');
    s = play([{ type: 'permission_mode', sessionId: 's1', mode: 'acceptEdits' }], s);
    expect(first(s).session?.permissionMode).toBe('acceptEdits');
    s = play([{ type: 'permission_mode', sessionId: 'other', mode: 'bypassPermissions' }], s);
    expect(first(s).session?.permissionMode).toBe('acceptEdits');
  });
});

describe('pane widths (resize_panes)', () => {
  const sizes = (s: AppState) => s.panes.map((p) => p.size ?? 1);
  const three = () => reducer(reducer(initialState, { type: 'add_pane' }), { type: 'add_pane' });

  it('trades weight between the two named panes only; others keep theirs', () => {
    const s = reducer(three(), { type: 'resize_panes', sizes: { p0: 1.4, p1: 0.6 } });
    expect(sizes(s)).toEqual([1.4, 0.6, 1]);
  });

  it('bad weights fall back to 1, tiny ones to the floor; unknown ids and no-op changes keep the state', () => {
    const base = three();
    expect(sizes(reducer(base, { type: 'resize_panes', sizes: { p0: -3, p1: Number.NaN, p2: 0.0001 } }))).toEqual([1, 1, 0.05]);
    expect(reducer(base, { type: 'resize_panes', sizes: { p9: 2 } })).toBe(base);
    expect(reducer(base, { type: 'resize_panes', sizes: { p0: 1 } })).toBe(base);
  });

  it('equalize (double-click): every pane back to 1', () => {
    const s = reducer(three(), { type: 'resize_panes', sizes: { p0: 1.5, p1: 0.5 } });
    expect(sizes(reducer(s, { type: 'resize_panes', sizes: { p0: 1, p1: 1, p2: 1 } }))).toEqual([1, 1, 1]);
  });

  it('add_pane gives the new pane the average weight; close_pane leaves the rest as they were', () => {
    let s = reducer(initialState, { type: 'add_pane' });
    s = reducer(s, { type: 'resize_panes', sizes: { p0: 1.5, p1: 0.5 } });
    s = reducer(s, { type: 'add_pane' });
    expect(sizes(s)).toEqual([1.5, 0.5, 1]);
    s = reducer(s, { type: 'resize_panes', sizes: { p1: 1.5, p2: 3 } });
    s = reducer(s, { type: 'add_pane' });
    expect(sizes(s)).toEqual([1.5, 1.5, 3, 2]);
    s = reducer(s, { type: 'close_pane', paneId: 'p1' });
    expect(sizes(s)).toEqual([1.5, 3, 2]);
  });
});

describe('openPanes (sidebar markers)', () => {
  const at = (id: string, sessionId: string | null, float = false) => ({ ...newPane(id), session: sessionId === null ? null : { sessionId, cwd: '/w', account: null, title: sessionId, engine: null, sandbox: null }, ...(float ? { float: { x: 0, y: 0, w: 300, h: 200 } } : {}) });

  it('numbers the docked panes left to right (cards skipped), marks card-only sessions float, skips blank panes', () => {
    const m = openPanes([at('p0', 's1'), at('p1', 's2', true), at('p2', null), at('p3', 's3')]);
    expect([...m]).toEqual([['s1', 1], ['s3', 3], ['s2', 'float']]);
  });

  it('a session in two places keeps its first split number; a pane beats a card', () => {
    const m = openPanes([at('p0', 's1', true), at('p1', 's2'), at('p2', 's2'), at('p3', 's1')]);
    expect(m.get('s2')).toBe(1);
    expect(m.get('s1')).toBe(3);
    expect(openPanes([at('p0', null)]).size).toBe(0);
  });
});

describe('자동 분배 (auto-route) UI state', () => {
  it('a new pane starts on the 자동 engine', () => {
    expect(newPane('x').engine).toBe('auto');
    expect(initialState.panes[0]!.engine).toBe('auto');
  });

  it('settings carry autoEngines / autoConsent / grokFast into state.autoRoute (null until the server says)', () => {
    expect(initialState.autoRoute).toBeNull();
    let s = play([{ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default' } }]);
    expect(s.autoRoute).toBeNull();
    s = play([{ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default', autoEngines: ['claude', 'gemini'], autoConsent: ['gemini'], grokFast: true } }], s);
    expect(s.autoRoute).toEqual({ autoEngines: ['claude', 'gemini'], autoConsent: ['gemini'], grokFast: true, crossEngineFailover: true, autoResume: true });
  });

  const held = () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = reducer(s, { type: 'sent', text: '스크린샷 봐줘', paneId: 'p0', clientRef: 'r1', attachments: [{ id: 'a1', name: 'x.png', isImage: true }] });
    return play([{ type: 'route_fit', turnId: 't1', sessionId: null, engine: 'grok', need: '이미지 입력', clientRef: 'r1' }], s);
  };

  it('route_fit ends the wait and keeps the held message for the card', () => {
    const p = held().panes[0]!;
    expect(p.awaitingStart).toBe(false);
    expect(p.routeFit).toEqual({ engine: 'grok', need: '이미지 입력', text: '스크린샷 봐줘', attachments: [{ id: 'a1', name: 'x.png', isImage: true }] });
  });

  it('route_fit for another send (clientRef mismatch) leaves the pane alone', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = reducer(s, { type: 'sent', text: 'a', paneId: 'p0', clientRef: 'r1' });
    s = play([{ type: 'route_fit', turnId: 't1', sessionId: null, engine: 'grok', need: '이미지 입력', clientRef: 'other' }], s);
    expect(s.panes[0]!.routeFit ?? null).toBeNull();
    expect(s.panes[0]!.awaitingStart).toBe(true);
  });

  it('그래도 보내기 takes the bubble back (the resend adds it again); dismiss requeues it paused', () => {
    const sent = reducer(held(), { type: 'route_fit_resolve', how: 'send', paneId: 'p0' });
    expect(sent.panes[0]!.routeFit).toBeNull();
    expect(sent.panes[0]!.items.filter((i) => i.kind === 'user')).toHaveLength(0);
    const back = reducer(held(), { type: 'route_fit_resolve', how: 'dismiss', paneId: 'p0' });
    expect(back.panes[0]!.routeFit).toBeNull();
    expect(back.panes[0]!.queue.map((q) => q.text)).toEqual(['스크린샷 봐줘']);
    expect(back.panes[0]!.queuePaused).toBe(true);
  });
});

describe('자동 분배: review counterexamples', () => {
  it('#1 reopening a GPT / Gemini / Grok session shows the model it runs on (history sessionModel), not the engine default; Grok keeps its effort', () => {
    const g = play([{ type: 'history', sessionId: 'G1', cwd: '/w', account: 'g1', engine: 'gemini', sandbox: 'read-only', sessionModel: 'gemini-flash', runningTurnId: null, messages: [] }], openedOn('G1'));
    expect(pane(g).model).toBe('gemini-flash');
    const c = play([{ type: 'history', sessionId: 'C1', cwd: '/w', account: 'gpt', engine: 'codex', sandbox: 'read-only', sessionModel: 'gpt-6-astra', runningTurnId: null, messages: [] }], openedOn('C1'));
    expect(pane(c).model).toBe('gpt-6-astra');
    const x = play([{ type: 'history', sessionId: 'X1', cwd: '/w', account: 'x1', engine: 'grok', sandbox: null, sessionModel: 'grok-4.5', sessionEffort: 'low', runningTurnId: null, messages: [] }], openedOn('X1'));
    expect(pane(x).model).toBe('grok-4.5');
    expect(pane(x).efforts.grok).toBe('low');
  });

  it('#2 a routed model does not stick: the next new session on the 자동 engine starts on 자동 again; an explicit pick stays', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = reducer(s, { type: 'sent', text: '이 함수 설명해 줘', clientRef: 'r1' });
    s = play([{ type: 'turn_started', turnId: 't1', sessionId: null, cwd: '/w', account: 'gpt', model: 'gpt-6-sol', reason: '자동 → GPT Sol', attempt: 0, engine: 'codex', clientRef: 'r1' }], s);
    expect(pane(s).model).toBe('gpt-6-sol');
    s = reducer(s, { type: 'open', sessionId: null, cwd: '/w', title: 'n2' });
    expect(pane(s)).toMatchObject({ engine: 'auto', model: 'auto', modelPicked: false });
    let e = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    e = reducer(e, { type: 'set_model', model: 'gpt-6-astra' });
    e = reducer(e, { type: 'sent', text: 'x', clientRef: 'r1' });
    e = play([{ type: 'turn_started', turnId: 't1', sessionId: null, cwd: '/w', account: 'gpt', model: 'gpt-6-astra', reason: 'GPT Astra 지정', attempt: 0, engine: 'codex', clientRef: 'r1' }], e);
    e = reducer(e, { type: 'open', sessionId: null, cwd: '/w', title: 'n2' });
    expect(pane(e).model).toBe('gpt-6-astra');
  });

  it('#4 a history (reconnect) while the route_fit card is up puts the held message back in the queue, paused', () => {
    let s = play([{ type: 'history', sessionId: 'G1', cwd: '/w', account: 'g1', engine: 'gemini', sandbox: 'read-only', runningTurnId: null, messages: [] }], openedOn('G1'));
    s = reducer(s, { type: 'sent', text: '테스트 돌려줘', clientRef: 'r1' });
    s = play([{ type: 'route_fit', turnId: 't1', sessionId: 'G1', engine: 'gemini', need: '셸 실행', clientRef: 'r1' }], s);
    expect(pane(s).routeFit).toMatchObject({ text: '테스트 돌려줘' });
    s = play([{ type: 'history', sessionId: 'G1', cwd: '/w', account: 'g1', engine: 'gemini', sandbox: 'read-only', runningTurnId: null, messages: [] }], s);
    expect(pane(s).routeFit ?? null).toBeNull();
    expect(pane(s).queue.map((q) => q.text)).toEqual(['테스트 돌려줘']);
    expect(pane(s).queuePaused).toBe(true);
  });

  it('#4 opening another session while the route_fit card is up: the held message is treated as a queued one (never silently gone)', () => {
    let s = play([{ type: 'history', sessionId: 'G1', cwd: '/w', account: 'g1', engine: 'gemini', sandbox: 'read-only', runningTurnId: null, messages: [] }], openedOn('G1'));
    s = reducer(s, { type: 'sent', text: '테스트 돌려줘', clientRef: 'r1' });
    s = play([{ type: 'route_fit', turnId: 't1', sessionId: 'G1', engine: 'gemini', need: '셸 실행', clientRef: 'r1' }], s);
    s = reducer(s, { type: 'open', sessionId: 'S2', cwd: '/w', title: 'other' });
    expect(pane(s).routeFit ?? null).toBeNull();
    expect(s.parked.G1!.queue.map((q) => q.text)).toEqual(['테스트 돌려줘']);
  });

  it('existing Grok session + an image: route_fit shows the card and the message waits for it', () => {
    let s = play([{ type: 'history', sessionId: 'X1', cwd: '/w', account: 'x1', engine: 'grok', sandbox: null, runningTurnId: null, messages: [] }], openedOn('X1'));
    s = reducer(s, { type: 'sent', text: '이 화면 봐줘', clientRef: 'r1', attachments: [{ id: 'a1', name: 'x.png', isImage: true }] });
    s = play([{ type: 'route_fit', turnId: 't1', sessionId: 'X1', engine: 'grok', need: '이미지 입력', clientRef: 'r1' }], s);
    expect(pane(s)).toMatchObject({ awaitingStart: false, routeFit: { engine: 'grok', need: '이미지 입력', text: '이 화면 봐줘', attachments: [{ id: 'a1', name: 'x.png', isImage: true }] } });
  });
});

describe('reducer: deck 에서 새 GPT 세션으로 이어가기 (codex_handoff)', () => {
  const TID = '019a0000-0000-7000-8000-000000000001';
  const gptBadge = { account: 'gpt' as const, model: 'gpt-6-astra' as const, reason: 'GPT 세션', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, modelNote: null };
  const started = (turnId: string, clientRef: string): ServerMessage => ({ type: 'turn_started', turnId, sessionId: TID, cwd: '/w', account: 'gpt', model: 'gpt-6-astra', reason: 'GPT 세션', attempt: 0, engine: 'codex', clientRef });
  const locked = (errorCode: boolean): AppState => {
    let s = reducer(initialState, { type: 'open', sessionId: TID, cwd: '/w', title: 'GPT 작업' });
    s = play([{ type: 'history', sessionId: TID, cwd: '/w', account: 'gpt', engine: 'codex', sessionModel: 'gpt-6-astra', sandbox: 'read-only', runningTurnId: null, messages: [
      { kind: 'user', text: '이전 질문', ts: null },
      { kind: 'assistant', text: '이전 답', model: 'gpt-6-astra', toolCalls: [{ id: 'tu', name: 'shell', input: { command: 'ls -la' } }], ts: null },
      { kind: 'tool_result', toolUseId: 'tu', content: 'file-listing', isError: false, ts: null },
    ] }], s);
    s = reducer(s, { type: 'sent', text: '이 함수 고쳐줘', clientRef: 'c1' });
    return play([started('t1', 'c1'), { type: 'turn_result', turnId: 't1', sessionId: TID, cwd: '/w', ok: false, text: '', badge: gptBadge, errorText: THREAD_LOCKED_MESSAGE, ...(errorCode ? { errorCode: 'thread_locked' as const } : {}) }], s);
  };

  it('the failed turn keeps its errorCode on the item', () => {
    expect(pane(locked(true)).items.at(-1)).toMatchObject({ kind: 'assistant', turnId: 't1', error: THREAD_LOCKED_MESSAGE, errorCode: 'thread_locked' });
    expect(pane(locked(false)).items.at(-1)).not.toHaveProperty('errorCode');
  });

  it('opens a new GPT session in the same folder, model and sandbox, with the excerpt and the failed request prefilled', () => {
    const before = locked(true);
    const s = reducer(before, { type: 'codex_handoff', paneId: pane(before).id, turnId: 't1' });
    const p = pane(s);
    expect(p.session).toMatchObject({ sessionId: null, cwd: '/w', title: 'GPT 작업 (이어서)', engine: 'codex', sandbox: 'read-only' });
    expect(p.session).not.toHaveProperty('accountPin');
    expect(p.engine).toBe('codex');
    expect(p.model).toBe('gpt-6-astra');
    expect(p.sandbox).toBe('read-only');
    expect(p.items).toEqual([]);
    expect(p.activeTurnId).toBeNull();
    expect(p.handoffFrom).toEqual({ sessionId: TID, title: 'GPT 작업' });
    const excerpt = codexHandoffExcerpt([{ kind: 'user', text: '이전 질문' }, { kind: 'assistant', text: '이전 답' }]);
    expect(p.prefill).toBe(codexHandoffMessage('GPT 작업', TID, excerpt, '이 함수 고쳐줘'));
    expect(p.prefill).not.toContain('file-listing');
    expect(p.prefill).not.toContain('ls -la');
    // the old session is left as it was (nothing sent, nothing parked)
    expect(s.parked).toEqual(before.parked);
    expect(pane(before).session?.sessionId).toBe(TID);
  });

  it('earlier locked tries of the same request (재시도) stay out of the excerpt; an unknown errorCode is not kept', () => {
    let s = locked(true);
    s = reducer(s, { type: 'sent', text: '이 함수 고쳐줘', clientRef: 'c2' });
    s = play([started('t2', 'c2'), { type: 'turn_result', turnId: 't2', sessionId: TID, cwd: '/w', ok: false, text: '', badge: gptBadge, errorText: 'x', errorCode: 'future_code' as never }], s);
    expect(pane(s).items.at(-1)).not.toHaveProperty('errorCode');
    const p = pane(reducer(s, { type: 'codex_handoff', paneId: pane(s).id, turnId: 't2' }));
    const excerpt = codexHandoffExcerpt([{ kind: 'user', text: '이전 질문' }, { kind: 'assistant', text: '이전 답' }]);
    expect(p.prefill).toBe(codexHandoffMessage('GPT 작업', TID, excerpt, '이 함수 고쳐줘'));
  });

  it('a turn that is not a failed one of this pane: nothing happens', () => {
    const before = locked(true);
    expect(reducer(before, { type: 'codex_handoff', paneId: pane(before).id, turnId: 'nope' })).toBe(before);
  });
});

describe('reducer: prompt suggestions (volatile, per session)', () => {
  const sug = (sessionId: string | null, text: string): ServerMessage => ({ type: 'prompt_suggestion', turnId: 't1', sessionId, cwd: '/w', text });

  it('stores the latest suggestion per session; one without a session is dropped', () => {
    const s = play([sug('s1', '하나'), sug('s2', '둘'), sug('s1', '셋'), sug(null, '없음')]);
    expect(s.suggestions).toEqual({ s1: '셋', s2: '둘' });
  });

  it('a new turn on the session clears its suggestion only', () => {
    const s = play([sug('s1', '하나'), sug('s2', '둘'), { type: 'turn_started', turnId: 't2', sessionId: 's1', cwd: '/w', account: 'c', model: 'opus', reason: '새 턴', attempt: 0 }]);
    expect(s.suggestions).toEqual({ s2: '둘' });
  });

  it('switching the pane to another session clears the left one; reopening the same keeps it', () => {
    const s = play([sug('s1', '하나'), sug('s2', '둘')], openedOn('s1'));
    const same = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    expect(same.suggestions).toEqual({ s1: '하나', s2: '둘' });
    const moved = reducer(s, { type: 'open', sessionId: 's3', cwd: '/w', title: 't' });
    expect(moved.suggestions).toEqual({ s2: '둘' });
  });
});

describe('activity.drainReason', () => {
  it('kept while draining (absent = an older server: restart), cleared when the drain ends; heartbeat changes nothing', () => {
    let s = reducer(initialState, { type: 'server', msg: { type: 'activity', sessions: [], draining: true, drainReason: 'stop' } });
    expect([s.draining, s.drainReason]).toEqual([true, 'stop']);
    s = reducer(s, { type: 'server', msg: { type: 'activity', sessions: [], draining: true } });
    expect(s.drainReason).toBe('restart');
    s = reducer(s, { type: 'server', msg: { type: 'activity', sessions: [] } });
    expect([s.draining, s.drainReason]).toEqual([false, null]);
    expect(reducer(s, { type: 'server', msg: { type: 'heartbeat' } })).toBe(s);
  });
});
