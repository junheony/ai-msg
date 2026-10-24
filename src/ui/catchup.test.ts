import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ClientMessageSchema, type ClientMessage, type ServerMessage, type StreamPos } from '../shared/protocol';
import { CATCHUP_HEAL_AGAIN_MS, CATCHUP_HEAL_MAX_MS, CATCHUP_HEAL_MS, CATCHUP_RETRY_MAX_MS, CATCHUP_RETRY_MIN_MS, CATCHUP_STALL_MS, CATCHUP_VISIBLE_STALL_MS, createCatchup } from './catchup';
import type { SessionEntry } from '../shared/session-types';
import { initialState, nextQueued, reducer, type AppState } from './state';

const S = 's1';
const pos = (seq: number, epoch = 'e1', sid = S): StreamPos => ({ sid, epoch, seq });
const delta = (seq: number, epoch = 'e1', sid = S): ServerMessage => ({ type: 'delta', turnId: 't', sessionId: sid, cwd: '/w', text: `d${seq}`, pos: pos(seq, epoch, sid) });
const history = (p?: StreamPos, sid = S): ServerMessage => ({ type: 'history', sessionId: sid, cwd: '/w', account: 'a', messages: [], runningTurnId: null, ...(p ? { pos: p } : {}) });
const caughtUp = (sid = S): ServerMessage => ({ type: 'catchup', sessionId: sid, runningTurnId: null });
const refused = (message = '기록을 읽지 못했습니다', sid = S): ServerMessage => ({ type: 'error', turnId: null, sessionId: sid, message });

function setup(o: { enabled?: boolean; connected?: boolean; shown?: string[] } = {}) {
  const state = { enabled: o.enabled ?? true, connected: o.connected ?? true, shown: o.shown ?? [S, 's2'], stalled: 0 };
  const out: ClientMessage[] = [];
  const c = createCatchup({
    send: (m) => { if (!state.connected) return false; out.push(m); return true; },
    enabled: () => state.enabled,
    shown: () => state.shown,
    stalled: () => { state.stalled++; },
  });
  /** The catch-up requests sent so far. */
  const asked = () => out.flatMap((m) => (m.type === 'open_session' && m.after ? [{ sessionId: m.sessionId, after: m.after }] : []));
  return { c, out, asked, state };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('catch-up tracker: order', () => {
  it('events in order are applied; a repeat of one already applied is dropped; nothing is asked', () => {
    const { c, out } = setup();
    expect(c.accept(delta(4))).toBe(true);
    expect(c.accept(delta(5))).toBe(true);
    expect(c.accept(delta(5))).toBe(false);
    expect(c.accept(delta(4))).toBe(false);
    expect(c.accept(delta(6))).toBe(true);
    // The session's next process counts on under a new epoch.
    expect(c.accept(delta(7, 'e2'))).toBe(true);
    expect(out).toEqual([]);
  });

  it('messages without a position (an older server, a card, the index) always pass', () => {
    const { c, out } = setup();
    expect(c.accept({ type: 'delta', turnId: 't', sessionId: S, cwd: '/w', text: 'x' })).toBe(true);
    expect(c.accept({ type: 'index', projects: [] })).toBe(true);
    expect(c.accept({ type: 'error', turnId: null, message: 'm' })).toBe(true);
    expect(c.accept(refused())).toBe(true);
    expect(out).toEqual([]);
  });

  it('a skipped number is not applied: what is missing is asked for once, from the last applied position, and then comes in order', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    expect(c.accept(delta(3))).toBe(false);
    expect(c.accept(delta(4))).toBe(false);
    expect(asked()).toEqual([{ sessionId: S, after: { epoch: 'e1', seq: 1 } }]);
    expect(c.accept(caughtUp())).toBe(true);
    expect([2, 3, 4].map((n) => c.accept(delta(n)))).toEqual([true, true, true]);
    expect(c.accept(delta(5))).toBe(true);
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(0);
  });

  it('an event of another epoch that does not follow on is a gap too', () => {
    const { c, asked } = setup();
    c.accept(delta(9));
    expect(c.accept(delta(2, 'e2'))).toBe(false);
    expect(asked()).toEqual([{ sessionId: S, after: { epoch: 'e1', seq: 9 } }]);
  });

  it('a history is the new starting point (its position, or none) — also as the answer of a server that could not catch up', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(5));
    expect(asked().length).toBe(1);
    expect(c.accept(history(pos(40, 'e3')))).toBe(true);
    expect(c.accept(delta(40, 'e3'))).toBe(false);
    expect(c.accept(delta(41, 'e3'))).toBe(true);
    c.accept(history());
    expect(c.accept(delta(7, 'e9'))).toBe(true);
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(0);
  });

  it('sessions are tracked apart', () => {
    const { c, out } = setup();
    c.accept(delta(1));
    expect(c.accept(delta(8, 'x', 's2'))).toBe(true);
    expect(c.accept(delta(2))).toBe(true);
    expect(out).toEqual([]);
  });

  it('a session no pane shows is not kept in order: its events pass and nothing is asked', () => {
    const { c, out, state } = setup({ shown: [] });
    expect([1, 5, 5].map((n) => c.accept(delta(n)))).toEqual([true, true, true]);
    state.shown = [S];
    // Shown again: in order from whatever comes first.
    expect([9, 10, 12].map((n) => c.accept(delta(n)))).toEqual([true, true, false]);
    expect(out).toEqual([{ type: 'open_session', sessionId: S, after: { epoch: 'e1', seq: 10 } }]);
  });
});

describe('catch-up tracker: failures', () => {
  it('no answer: the same request is not sent again on that socket — after the stall time the socket is given up (reconnect)', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    c.accept(delta(4));
    vi.advanceTimersByTime(CATCHUP_STALL_MS - 1);
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state.stalled).toBe(1);
    // Nothing more until the new socket's hello.
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(1);
    c.hello();
    expect(asked().length).toBe(2);
    expect(CATCHUP_STALL_MS).toBe(30_000);
  });

  it('the server failing (an error about that session): asked again after 1s, then 2s, 4s … up to 30s; the error is shown once', () => {
    const { c, asked } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    expect(c.accept(refused())).toBe(true);
    let wait = CATCHUP_RETRY_MIN_MS;
    for (let n = 2; n <= 8; n++) {
      vi.advanceTimersByTime(wait - 1);
      expect(asked().length).toBe(n - 1);
      vi.advanceTimersByTime(1);
      expect(asked().length).toBe(n);
      // The same failure again: not shown again.
      expect(c.accept(refused())).toBe(false);
      wait = Math.min(wait * 2, CATCHUP_RETRY_MAX_MS);
    }
    expect(wait).toBe(CATCHUP_RETRY_MAX_MS);
    expect(CATCHUP_RETRY_MIN_MS).toBe(1000);
    expect(CATCHUP_RETRY_MAX_MS).toBe(30_000);
    // An answer ends it; the next failure starts at 1s again, and is shown.
    c.accept(history(pos(3)));
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    expect(asked().length).toBe(8);
    c.accept(delta(9));
    expect(asked().length).toBe(9);
    expect(c.accept(refused())).toBe(true);
    vi.advanceTimersByTime(CATCHUP_RETRY_MIN_MS);
    expect(asked().length).toBe(10);
  });

  it('an error about the session while nothing is asked changes nothing', () => {
    const { c, out } = setup();
    c.accept(delta(1));
    expect(c.accept(refused())).toBe(true);
    expect(c.accept(refused())).toBe(true);
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    expect(out).toEqual([]);
  });

  it('the session is gone (not_found): shown once, never asked again', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    expect(c.accept({ type: 'error', turnId: null, sessionId: S, message: '세션을 찾을 수 없습니다', code: 'not_found' })).toBe(true);
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    c.visible();
    expect(asked().length).toBe(1);
    expect(state.stalled).toBe(0);
  });

  it('a pane closed while its request waits: no retry, no request for it afterwards', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    c.accept(refused());
    state.shown = [];
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    c.visible();
    expect(asked().length).toBe(1);
    // forget (close_session): an outstanding request's clock stops too.
    const b = setup();
    b.c.accept(delta(1));
    b.c.accept(delta(3));
    b.c.forget(S);
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(b.state.stalled).toBe(0);
    expect(b.c.accept(delta(9))).toBe(true);
  });

  it('not connected: nothing is asked and nothing is retried (the reconnect asks); cancel stops the clocks', () => {
    const { c, out, state } = setup({ connected: false });
    c.accept(delta(1));
    c.accept(delta(3));
    c.visible();
    vi.advanceTimersByTime(10 * CATCHUP_RETRY_MAX_MS);
    expect(out).toEqual([]);
    state.connected = true;
    c.visible();
    expect(out.length).toBe(1);
    c.cancel();
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(state.stalled).toBe(0);
  });
});

describe('catch-up tracker: reconnect and coming back into view', () => {
  it('hello: every shown session is opened again once — with its position where one is known, plainly otherwise', () => {
    const { c, out, state } = setup({ shown: [S, 's2', 's3', S] });
    c.accept(delta(5));
    c.accept(delta(2, 'x', 's2'));
    c.hello();
    expect(out).toEqual([
      { type: 'open_session', sessionId: S, after: { epoch: 'e1', seq: 5 } },
      { type: 'open_session', sessionId: 's2', after: { epoch: 'x', seq: 2 } },
      { type: 'open_session', sessionId: 's3' },
    ]);
    // A new socket: what the old one was asked does not count.
    c.hello();
    expect(out.length).toBe(6);
    expect(state.stalled).toBe(0);
  });

  it('hello from an older server: plain opens only, and the positions are forgotten', () => {
    const { c, out, state } = setup();
    c.accept(delta(5));
    state.enabled = false;
    c.hello();
    expect(out).toEqual([{ type: 'open_session', sessionId: S }, { type: 'open_session', sessionId: 's2' }]);
    c.visible();
    state.enabled = true;
    c.visible();
    expect(out.length).toBe(2);
    vi.advanceTimersByTime(10 * CATCHUP_STALL_MS);
    expect(state.stalled).toBe(0);
  });

  it('back in view: the shown sessions with a position are asked about (nothing is opened plainly), and a waiting retry runs now with its delay back at 1s', () => {
    const { c, out, asked } = setup({ shown: [S, 's3'] });
    c.accept(delta(5));
    c.visible();
    expect(out).toEqual([{ type: 'open_session', sessionId: S, after: { epoch: 'e1', seq: 5 } }]);
    c.accept(refused());
    vi.advanceTimersByTime(CATCHUP_RETRY_MIN_MS);
    c.accept(refused());
    // waiting 2s now
    c.visible();
    expect(asked().length).toBe(3);
    c.accept(refused());
    vi.advanceTimersByTime(CATCHUP_RETRY_MIN_MS);
    expect(asked().length).toBe(4);
  });
});

describe('an older server', () => {
  it('its schema drops `after` and answers as to any open_session', () => {
    // The open_session schema before `after` existed.
    const old = z.object({ type: z.literal('open_session'), sessionId: z.string().min(1) });
    const sent = { type: 'open_session', sessionId: S, after: { epoch: 'e1', seq: 3 } };
    expect(old.parse(sent)).toEqual({ type: 'open_session', sessionId: S });
    expect(ClientMessageSchema.parse(sent)).toEqual(sent);
  });
});

describe('tracker and reducer together', () => {
  const pane = (s: AppState) => s.panes[0]!;
  it('a send whose turn_started fell behind a gap is still this pane\'s once the history lists it: the pane is not left waiting', () => {
    const { c } = setup();
    let s = reducer(initialState, { type: 'open', sessionId: S, cwd: '/w', title: 't' });
    const play = (m: ServerMessage) => { if (c.accept(m)) s = reducer(s, { type: 'server', msg: m }); };
    play({ type: 'history', sessionId: S, cwd: '/w', account: null, runningTurnId: null, messages: [], acceptedRefs: [], pos: pos(40, 'A') });
    s = reducer(s, { type: 'sent', text: 'go', clientRef: 'r1' });
    expect(pane(s)).toMatchObject({ awaitingStart: true, awaitingRef: 'r1' });
    // 41‥90 never reached this socket.
    play({ type: 'turn_started', turnId: 'tB', sessionId: S, cwd: '/w', account: 'b', model: 'opus', reason: '', attempt: 1, clientRef: 'r1', pos: pos(91, 'B') });
    expect(pane(s).awaitingStart).toBe(true);
    play({ type: 'history', sessionId: S, cwd: '/w', account: null, runningTurnId: 'tB', messages: [{ kind: 'user', text: 'go', ts: null, n: 0 }], acceptedRefs: ['r1'], pos: pos(91, 'B') });
    expect(pane(s)).toMatchObject({ awaitingStart: false, awaitingRef: null, awaitingSend: null, activeTurnId: 'tB' });
    expect(pane(s).myTurns).toContain('tB');
    play({ type: 'turn_result', turnId: 'tB', sessionId: S, cwd: '/w', ok: true, text: 'done', badge: null, errorText: null, pos: pos(92, 'B') });
    expect(pane(s)).toMatchObject({ awaitingStart: false, activeTurnId: null });
    // The pane is free again: the next queued message may go.
    s = reducer(s, { type: 'queue_add', text: 'next' });
    expect(nextQueued(pane(s))?.text).toBe('next');
  });

  it('a send the history does not list keeps waiting for its turn_started', () => {
    let s = reducer(initialState, { type: 'open', sessionId: S, cwd: '/w', title: 't' });
    s = reducer(s, { type: 'sent', text: 'go', clientRef: 'r1' });
    s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: S, cwd: '/w', account: null, runningTurnId: null, messages: [], acceptedRefs: ['other'], pendingRefs: ['r1'] } });
    expect(pane(s)).toMatchObject({ awaitingStart: true, awaitingRef: 'r1' });
  });

  it('visible() gives the request 5 s, not 30 s, before reporting the socket stalled', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.visible();
    expect(asked().length).toBe(1);
    vi.advanceTimersByTime(CATCHUP_VISIBLE_STALL_MS - 1);
    expect(state.stalled).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state.stalled).toBe(1);
  });

  it('visible() with a request already out shortens its remaining wait to 5 s', () => {
    const { c, asked, state } = setup();
    c.accept(delta(1));
    c.accept(delta(3));
    expect(asked().length).toBe(1);
    vi.advanceTimersByTime(10_000);
    c.visible();
    expect(asked().length).toBe(1);
    vi.advanceTimersByTime(CATCHUP_VISIBLE_STALL_MS);
    expect(state.stalled).toBe(1);
  });
});

/** The server's activity, announcing these stream heads. */
const heads = (...ps: StreamPos[]): ServerMessage => ({ type: 'activity', sessions: [], heads: ps });
/** A session list where each given session's transcript was last written at the given time (what an outside run moves). */
const listing = (mods: Record<string, number>): ServerMessage => ({
  type: 'index',
  projects: [{ cwd: '/w', name: 'w', pinned: false, sessions: Object.entries(mods).map(([sessionId, lastModified]) => ({ sessionId, lastModified, account: 'b', cwd: '/w', projectDir: '/p', file: `/p/${sessionId}.jsonl`, title: 't', sizeBytes: 1 }) as SessionEntry) }],
});
const plainOpens = (out: ClientMessage[]) => out.filter((m) => m.type === 'open_session' && !m.after).map((m) => (m as { sessionId: string }).sessionId);

describe('catch-up tracker: behind the announced stream head', () => {
  it('a shown session that stays behind its head, hearing nothing, is asked for from its position after 30 s', () => {
    const { c, asked } = setup();
    c.accept(history(pos(10)));
    c.accept(heads(pos(14)));
    vi.advanceTimersByTime(CATCHUP_HEAL_MS - 1);
    expect(asked()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(asked()).toEqual([{ sessionId: S, after: { epoch: 'e1', seq: 10 } }]);
    // The answer brings what was missed: in order, and the head is reached.
    expect(c.accept(caughtUp())).toBe(true);
    expect([11, 12, 13, 14].map((n) => c.accept(delta(n)))).toEqual([true, true, true, true]);
    vi.advanceTimersByTime(CATCHUP_HEAL_MAX_MS * 2);
    expect(asked().length).toBe(1);
  });

  it('a busy session: other lists and activity in between do not restart or stop its clock', () => {
    const { c, asked } = setup();
    c.accept(history(pos(10)));
    c.accept(heads(pos(12)));
    vi.advanceTimersByTime(10_000);
    c.accept(listing({ [S]: 1, s2: 5 }));
    c.accept(heads(pos(12), pos(3, 'x', 's2')));
    vi.advanceTimersByTime(10_000);
    c.accept({ type: 'activity', sessions: [] });
    c.accept(listing({ [S]: 2 }));
    c.accept(heads(pos(13)));
    vi.advanceTimersByTime(10_000);
    // 30 s after it first fell behind (s2's own clock started 10 s later).
    expect(asked()).toEqual([{ sessionId: S, after: { epoch: 'e1', seq: 10 } }]);
  });

  it('events that keep arriving, or a head this device has reached, ask nothing', () => {
    const { c, out } = setup();
    c.accept(history(pos(10)));
    for (let n = 11; n <= 20; n++) {
      c.accept(delta(n));
      // The head is announced as the segment ends (after its event) — or, from another broadcast, one ahead for a moment.
      c.accept(heads(pos(n + (n % 2))));
      vi.advanceTimersByTime(20_000);
    }
    c.accept(heads(pos(20)));
    vi.advanceTimersByTime(CATCHUP_HEAL_MAX_MS);
    expect(out).toEqual([]);
  });

  it('a heal that brings nothing is tried again after 60 s, doubling up to 10 min; anything heard starts it over', () => {
    const { c, asked } = setup();
    c.accept(history(pos(10)));
    c.accept(heads(pos(14)));
    const at: number[] = [];
    let t = 0;
    const step = (ms: number) => { vi.advanceTimersByTime(ms); t += ms; };
    for (let i = 0; i < 9; i++) {
      const before = asked().length;
      for (let k = 0; asked().length === before && k < 2 * CATCHUP_HEAL_MAX_MS / 1000; k++) step(1000);
      if (asked().length === before) break;
      at.push(t / 1000);
      // The server answers, with nothing later than this device has.
      c.accept(caughtUp());
    }
    const gaps = at.map((x, i) => (i ? x - at[i - 1]! : x));
    expect(gaps).toEqual([CATCHUP_HEAL_MS, CATCHUP_HEAL_AGAIN_MS, 120_000, 240_000, 480_000, CATCHUP_HEAL_MAX_MS, CATCHUP_HEAL_MAX_MS, CATCHUP_HEAL_MAX_MS, CATCHUP_HEAL_MAX_MS].map((ms) => ms / 1000));
    // The socket is told again: one event heard, and the next time this falls behind it waits 30 s once more.
    expect(c.accept(delta(11))).toBe(true);
    c.accept(heads(pos(15)));
    const before = asked().length;
    step(CATCHUP_HEAL_MS);
    expect(asked().length).toBe(before + 1);
  });

  it('a history without a position (one the server could not vouch for) is healed with the whole history', () => {
    const { c, out } = setup();
    c.accept(history());
    c.accept(heads(pos(7)));
    vi.advanceTimersByTime(CATCHUP_HEAL_MS);
    expect(plainOpens(out)).toEqual([S]);
    c.accept(history(pos(7)));
    vi.advanceTimersByTime(CATCHUP_HEAL_MAX_MS);
    expect(out.length).toBe(1);
  });

  it('a session run outside deck (its transcript grows, it has no head) is never asked for; nor a hidden one', () => {
    const { c, out, state } = setup();
    c.accept(history(pos(10)));
    c.accept(history(undefined, 's2'));
    for (let n = 1; n <= 20; n++) { c.accept(listing({ [S]: n * 1000, s2: n * 1000 })); c.accept(heads()); vi.advanceTimersByTime(45_000); }
    state.shown = ['s2'];
    c.accept(heads(pos(30)));
    vi.advanceTimersByTime(CATCHUP_HEAL_MAX_MS);
    expect(out).toEqual([]);
  });
});
