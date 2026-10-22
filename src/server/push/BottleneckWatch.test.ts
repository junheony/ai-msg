import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '../../shared/protocol';
import { SessionStateStore, type ClaudeSessionState } from '../turn/SessionState';
import { limitResetAtMs } from '../engine/limitDetect';
import { ABORTED, AUTO_RETRY_NOTICE } from '../turn/TurnRunner';
import { ASK_NUDGE_MS, BottleneckWatch, type RetryRequest } from './BottleneckWatch';
import type { PushPayload } from './PushNotifier';

const MIN = 60_000;
const scope = { turnId: 't1', sessionId: 's1', cwd: '/w/proj' };
const claude = (over: Partial<ClaudeSessionState> = {}): ClaudeSessionState => ({ sessionId: 's1', cwd: '/w/proj', account: 'a', projectDir: '/p', lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus', ...over });

/** A manual clock: timers fire when `advance` passes their time. */
async function setup(o: { states?: ClaudeSessionState[]; cooldown?: number | null; quiet?: () => boolean; enabled?: () => boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-bottleneck-'));
  const store = new SessionStateStore(path.join(dir, 'state.json'));
  await store.load();
  for (const s of o.states ?? [claude()]) await store.set(s);
  let now = Date.parse('2026-10-15T01:00:00Z');
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const pushes: PushPayload[] = [];
  const retries: RetryRequest[] = [];
  const shown: [string, number | null][] = [];
  const watch = new BottleneckWatch({
    onRetry: (sessionId, atMs) => shown.push([sessionId, atMs]),
    sendPush: (p) => pushes.push(p),
    titleOf: () => '세션 제목',
    store,
    earliestCooldownMs: () => o.cooldown ?? null,
    retry: (r) => retries.push(r),
    ...(o.quiet ? { quiet: o.quiet } : {}),
    ...(o.enabled ? { enabled: o.enabled } : {}),
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (t) => { timers.delete(t as number); },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  return { watch, store, pushes, retries, shown, advance, now: () => now, pending: () => timers.size, waits: () => [...timers.values()].map((t) => t.at - now) };
}

const perm = (requestId: string, over: Record<string, unknown> = {}) => ({ type: 'permission_request', ...scope, requestId, toolName: 'Bash', input: {}, title: 'Run make', decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: false, sessionLabel: null, ...over } as ServerMessage);
const failed = (errorText: string, turnId = scope.turnId): ServerMessage => ({ type: 'turn_result', ...scope, turnId, ok: false, text: '', badge: null, errorText });

describe('BottleneckWatch · 답을 기다리는 카드', () => {
  it('one reminder 10 minutes on, same tag as the card; none once answered', async () => {
    const c = await setup();
    c.watch.observe(perm('r1'));
    c.watch.observe(perm('r2', { toolName: 'ExitPlanMode', title: null }));
    c.watch.observe({ type: 'question_request', ...scope, requestId: 'r3', questions: [{ question: '어느 색?', header: '색', options: [], multiSelect: false }] } as unknown as ServerMessage);
    c.watch.observe({ type: 'permission_resolved', requestId: 'r1', decision: 'once' });
    c.advance(ASK_NUDGE_MS - 1);
    expect(c.pushes).toEqual([]);
    c.advance(1);
    expect(c.pushes).toEqual([
      { kind: 'permission', title: '세션 제목', body: '아직 답을 기다립니다 · 20분 뒤 자동 거부 · 계획 승인', sessionId: 's1', tag: 'ask-r2' },
      { kind: 'question', title: '세션 제목', body: '아직 답을 기다립니다 · 20분 뒤 자동으로 닫힘 · 어느 색?', sessionId: 's1', tag: 'ask-r3' },
    ]);
    c.advance(60 * MIN);
    expect(c.pushes).toHaveLength(2);
    expect(c.pending()).toBe(0);
  });

  it('sending to the session stops its reminders (opening it does not reach the watch: ws reports sends only)', async () => {
    const c = await setup();
    c.watch.observe(perm('r1'));
    c.watch.observe(perm('r2', { sessionId: 's2' }));
    c.watch.userSent('s1');
    c.advance(ASK_NUDGE_MS);
    expect(c.pushes.map((p) => p.tag)).toEqual(['ask-r2']);
  });
});

describe('BottleneckWatch · 실패한 채 멈춘 턴', () => {
  it('reminds after 10, then 30, then 60 more minutes, then stops; stored as blocked', async () => {
    const c = await setup();
    c.watch.observe(failed('API Error: 500 overloaded'));
    expect(c.store.get('s1')?.blocked).toMatchObject({ kind: 'turn_failed', n: 0, summary: 'API Error: 500 overloaded' });
    c.advance(10 * MIN);
    expect(c.pushes).toEqual([{ kind: 'turn', title: '세션 제목', body: '턴이 실패한 채 멈춰 있습니다 · API Error: 500 overloaded', sessionId: 's1', tag: 'turn-s1' }]);
    expect(c.store.get('s1')?.blocked).toMatchObject({ n: 1, lastPushAtMs: c.now() });
    c.advance(30 * MIN - 1);
    expect(c.pushes).toHaveLength(1);
    c.advance(1);
    expect(c.pushes).toHaveLength(2);
    c.advance(60 * MIN);
    expect(c.pushes).toHaveLength(3);
    c.advance(24 * 60 * MIN);
    expect(c.pushes).toHaveLength(3);
    expect(c.store.get('s1')).not.toHaveProperty('blocked');
  });

  it('the next turn starting, a success, or the user sending ends it; the user\'s own stop starts none', async () => {
    const c = await setup();
    c.watch.observe(failed('boom'));
    c.watch.observe({ type: 'turn_started', ...scope, turnId: 't2', account: 'a', model: 'opus', reason: 'r', attempt: 0 } as ServerMessage);
    expect(c.store.get('s1')).not.toHaveProperty('blocked');
    c.watch.observe(failed('boom'));
    c.watch.observe({ type: 'turn_result', ...scope, ok: true, text: 'ok', badge: null, errorText: null });
    c.watch.observe(failed('boom'));
    c.watch.userSent('s1');
    c.watch.observe(failed(ABORTED));
    c.advance(3 * 60 * MIN);
    expect(c.pushes).toEqual([]);
    expect(c.store.get('s1')).not.toHaveProperty('blocked');
  });

  it('대안 계정 없음 says when it can work again (the reset the error named, else the earliest cooldown)', async () => {
    const c = await setup({ cooldown: Date.parse('2026-10-15T03:00:00Z') });
    c.watch.observe(failed('한도 도달 · 대안 계정 없음 · usage limit reached'));
    c.advance(10 * MIN);
    expect(c.pushes[0]!.body).toBe(`턴이 실패한 채 멈춰 있습니다 · 한도 도달 · 대안 계정 없음 · usage limit reached · ${new Date(Date.parse('2026-10-15T03:00:00Z')).toTimeString().slice(0, 5)} 쯤 다시 시도 가능`);
  });

  it('the reset time the full error named is stored with it, for the reminder after a restart', async () => {
    const c = await setup();
    c.watch.observe(failed('한도 도달 · 대안 계정 없음 · ' + 'x'.repeat(90) + ' · resets 3:50am'));
    const b = c.store.get('s1')?.blocked;
    expect(b?.resetAtMs).toBe(limitResetAtMs('resets 3:50am', c.now()));
    expect(b?.summary).not.toContain('resets');
    c.watch.stop();
    const d = new BottleneckWatch({ sendPush: (p) => c.pushes.push(p), titleOf: () => 't', store: c.store, now: c.now, setTimer: (fn) => { fn(); return 0; }, clearTimer: () => {} });
    d.rearm(c.store.list());
    expect(c.pushes.at(-1)!.body).toContain(`${new Date(b!.resetAtMs!).toTimeString().slice(0, 5)} 쯤 다시 시도 가능`);
  });

  it('re-armed at start from the stored stage: stages already past are skipped', async () => {
    const c = await setup();
    const at = c.now() - 25 * MIN;
    await c.store.set(claude({ blocked: { kind: 'turn_failed', atMs: at, lastPushAtMs: at + 10 * MIN, n: 1, summary: 'boom' } }));
    c.watch.rearm(c.store.list());
    // Stage 2 is due at 10+30 = 40 min after the failure: 15 min from now.
    c.advance(15 * MIN - 1);
    expect(c.pushes).toEqual([]);
    c.advance(1);
    expect(c.pushes).toHaveLength(1);
    expect(c.store.get('s1')?.blocked).toMatchObject({ n: 2 });

    // Down through stage 2 (n: 1, 50 min on): stage 2 is skipped, stage 3 (100 min) comes.
    const d = await setup();
    const at2 = d.now() - 50 * MIN;
    await d.store.set(claude({ blocked: { kind: 'turn_failed', atMs: at2, lastPushAtMs: at2 + 10 * MIN, n: 1, summary: 'boom' } }));
    d.watch.rearm(d.store.list());
    d.advance(50 * MIN - 1);
    expect(d.pushes).toEqual([]);
    d.advance(1);
    expect(d.pushes).toHaveLength(1);
  });
});

describe('BottleneckWatch · 자동 재시도', () => {
  it('a retry failing again goes on from the stage before: two hours to the reset is one failure + at most 3 reminders', async () => {
    const c = await setup();
    const atMs = c.now() + 121 * MIN;
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs, hops: 1 } }));
    c.watch.observe(failed('한도 도달 · 대안 계정 없음'));
    c.advance(121 * MIN);
    expect(c.pushes).toHaveLength(3);
    expect(c.retries).toHaveLength(1);
    // The retry runs and fails again; the runner booked hop 2 before its result.
    c.watch.observe({ type: 'turn_started', ...scope, turnId: 't2', account: 'a', model: 'opus', reason: 'r', attempt: 0 } as ServerMessage);
    c.watch.observe({ type: 'turn_notice', ...scope, turnId: 't2', message: AUTO_RETRY_NOTICE });
    await c.store.set({ ...c.store.get('s1')!, pendingRetry: { text: 'go', atMs: c.now() + 60 * MIN, hops: 2 } });
    c.watch.observe(failed('한도 도달 · 대안 계정 없음', 't2'));
    c.advance(6 * 60 * MIN);
    expect(c.pushes).toHaveLength(3);
    expect(c.retries).toHaveLength(2);
  });

  it('a retry failing mid-chain skips the stages already sent', async () => {
    const c = await setup();
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() + 20 * MIN, hops: 1 } }));
    c.watch.observe(failed('대안 계정 없음'));
    c.advance(20 * MIN);
    expect(c.pushes).toHaveLength(1);
    c.watch.observe({ type: 'turn_started', ...scope, turnId: 't2', account: 'a', model: 'opus', reason: 'r', attempt: 0 } as ServerMessage);
    c.watch.observe({ type: 'turn_notice', ...scope, turnId: 't2', message: AUTO_RETRY_NOTICE });
    c.watch.observe(failed('대안 계정 없음', 't2'));
    expect(c.store.get('s1')?.blocked).toMatchObject({ n: 1 });
    c.advance(6 * 60 * MIN);
    expect(c.pushes).toHaveLength(3);
  });

  it('fires the booked retry at its time and names it in the reminder; the retry\'s start settles it', async () => {
    const c = await setup();
    const atMs = c.now() + 40 * MIN;
    await c.store.set(claude({ pendingRetry: { text: '고쳐 줘', atMs, hops: 1 } }));
    c.watch.observe(failed('한도 도달 · 대안 계정 없음'));
    c.advance(10 * MIN);
    expect(c.pushes[0]!.body).toBe(`턴이 실패한 채 멈춰 있습니다 · 한도 도달 · 대안 계정 없음 · ${new Date(atMs).toTimeString().slice(0, 5)} 자동 재시도 예정`);
    c.advance(30 * MIN);
    expect(c.retries).toEqual([{ sessionId: 's1', cwd: '/w/proj', text: '고쳐 줘', hop: 1 }]);
    // Still stored until the retry's turn starts.
    expect(c.store.get('s1')?.pendingRetry).toBeDefined();
    c.watch.observe({ type: 'turn_started', ...scope, turnId: 't2', account: 'a', model: 'opus', reason: 'r', attempt: 0 } as ServerMessage);
    expect(c.store.get('s1')).not.toHaveProperty('pendingRetry');
    expect(c.store.get('s1')).not.toHaveProperty('blocked');
  });

  it('a booking from an automatic (commander) turn carries its commanderHop to the retry (보안 #3)', async () => {
    const c = await setup();
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() + 5 * MIN, hops: 2, commanderHop: 3 } }));
    c.watch.observe(failed('대안 계정 없음'));
    c.advance(5 * MIN);
    expect(c.retries).toEqual([{ sessionId: 's1', cwd: '/w/proj', text: 'go', hop: 2, commanderHop: 3 }]);
  });

  it('the user sending first calls it off', async () => {
    const c = await setup();
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() + 5 * MIN, hops: 1 } }));
    c.watch.observe(failed('대안 계정 없음'));
    c.watch.userSent('s1');
    c.advance(60 * MIN);
    expect(c.retries).toEqual([]);
    expect(c.store.get('s1')).not.toHaveProperty('pendingRetry');
  });

  it('자동으로 이어가기: the booking is told to the devices when armed and when it goes (start, send, cancel)', async () => {
    const c = await setup({ states: [claude(), claude({ sessionId: 's2', cwd: '/w/two' })] });
    const atMs = c.now() + 40 * MIN;
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs, hops: 1 } }));
    c.watch.observe(failed('대안 계정 없음'));
    expect(c.shown).toEqual([['s1', atMs]]);
    c.watch.observe({ type: 'turn_started', ...scope, turnId: 't2', account: 'a', model: 'opus', reason: 'r', attempt: 0 } as ServerMessage);
    expect(c.shown).toEqual([['s1', atMs], ['s1', null]]);
    // Nothing booked: nothing to tell.
    c.watch.userSent('s1');
    expect(c.shown).toHaveLength(2);
    await c.store.set(claude({ sessionId: 's2', cwd: '/w/two', pendingRetry: { text: 'go', atMs, hops: 1 } }));
    c.watch.observe({ ...failed('대안 계정 없음'), sessionId: 's2', cwd: '/w/two' } as ServerMessage);
    c.watch.userSent('s2');
    expect(c.shown.slice(2)).toEqual([['s2', atMs], ['s2', null]]);
  });

  it('취소: cancelRetry calls the booking off — no retry at its time, nothing stored', async () => {
    const c = await setup();
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() + 5 * MIN, hops: 1 } }));
    c.watch.observe(failed('대안 계정 없음'));
    expect(c.watch.cancelRetry('s1')).toBe(true);
    expect(c.watch.cancelRetry('s1')).toBe(false);
    c.advance(60 * MIN);
    expect(c.retries).toEqual([]);
    expect(c.store.get('s1')).not.toHaveProperty('pendingRetry');
    expect(c.shown.at(-1)).toEqual(['s1', null]);
  });

  it('re-armed at start: a booking already due fires at once, a stale one is dropped', async () => {
    const c = await setup({ states: [claude({ pendingRetry: { text: 'go', atMs: Date.parse('2026-10-15T00:50:00Z'), hops: 2 } }), claude({ sessionId: 's2', pendingRetry: { text: 'old', atMs: Date.parse('2026-10-14T00:00:00Z'), hops: 1 } })] });
    c.watch.rearm(c.store.list());
    c.advance(0);
    expect(c.retries).toEqual([{ sessionId: 's1', cwd: '/w/proj', text: 'go', hop: 2 }]);
    expect(c.store.get('s2')).not.toHaveProperty('pendingRetry');
  });
});

describe('BottleneckWatch · 사령탑이 맡은 세션', () => {
  it('quiet: no failure push or reminder, but a booked retry still arms', async () => {
    let quiet = true;
    const c = await setup({ quiet: () => quiet });
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() + 5 * MIN, hops: 1, commanderHop: 2 } }));
    c.watch.observe(failed('한도 도달 · 대안 계정 없음'));
    expect(c.store.get('s1')).not.toHaveProperty('blocked');
    c.advance(5 * MIN);
    expect(c.retries).toEqual([{ sessionId: 's1', cwd: '/w/proj', text: 'go', hop: 1, commanderHop: 2 }]);
    c.advance(120 * MIN);
    expect(c.pushes).toEqual([]);
    quiet = false;
    c.watch.observe(failed('또 실패', 't2'));
    expect(c.store.get('s1')?.blocked).toBeDefined();
  });

  it('retryDue drops a booking older than the stale limit instead of firing it (same rule as rearm)', async () => {
    const c = await setup();
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() - 13 * 3600_000, hops: 1 } }));
    c.watch.retryDue('s1');
    expect(c.retries).toHaveLength(0);
    expect(c.store.get('s1')).not.toHaveProperty('pendingRetry');
  });

  it('retryDue fires a due booking it has not fired yet; a future one waits', async () => {
    const c = await setup();
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() - MIN, hops: 1 } }));
    c.watch.retryDue('s1');
    expect(c.retries).toHaveLength(1);
    const d = await setup();
    await d.store.set(claude({ pendingRetry: { text: 'go', atMs: d.now() + 5 * MIN, hops: 1 } }));
    d.watch.retryDue('s1');
    expect(d.retries).toHaveLength(0);
  });

  it('a fired booking whose turn never started is not fired again at once: booked 5 min later, 3 fires at most, then dropped', async () => {
    const c = await setup();
    const atMs = c.now() + 5 * MIN;
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs, hops: 1 } }));
    c.watch.rearm(c.store.list());
    c.advance(5 * MIN);
    expect(c.retries).toHaveLength(1);
    // Refused before turn_started (e.g. the folder is gone): the session goes idle at once — no immediate second fire.
    c.watch.retryDue('s1');
    c.watch.retryDue('s1');
    expect(c.retries).toHaveLength(1);
    expect(c.store.get('s1')?.pendingRetry?.atMs).toBe(c.now() + 5 * MIN);
    expect(c.shown.at(-1)).toEqual(['s1', c.now() + 5 * MIN]);
    c.advance(5 * MIN);
    expect(c.retries).toHaveLength(2);
    c.watch.retryDue('s1');
    c.advance(5 * MIN);
    expect(c.retries).toHaveLength(3);
    c.watch.retryDue('s1');
    expect(c.store.get('s1')).not.toHaveProperty('pendingRetry');
    expect(c.shown.at(-1)).toEqual(['s1', null]);
    c.advance(60 * MIN);
    expect(c.retries).toHaveLength(3);
  });

  it('자동으로 이어가기 turned off after booking: not fired at its time but dropped; cancelAllRetries drops every booking', async () => {
    let on = true;
    const c = await setup({ enabled: () => on, states: [claude(), claude({ sessionId: 's2' })] });
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() + 5 * MIN, hops: 1 } }));
    c.watch.rearm(c.store.list());
    on = false;
    c.advance(5 * MIN);
    expect(c.retries).toEqual([]);
    expect(c.store.get('s1')).not.toHaveProperty('pendingRetry');
    expect(c.shown.at(-1)).toEqual(['s1', null]);
    await c.store.set(claude({ pendingRetry: { text: 'a', atMs: c.now() + 5 * MIN, hops: 1 } }));
    await c.store.set(claude({ sessionId: 's2', pendingRetry: { text: 'b', atMs: c.now() + 9 * MIN, hops: 1 } }));
    c.watch.rearm(c.store.list());
    c.watch.cancelAllRetries();
    expect(c.store.list().filter((s) => s.pendingRetry)).toEqual([]);
    expect(c.shown.slice(-2).sort()).toEqual([['s1', null], ['s2', null]]);
    expect(c.pending()).toBe(0);
  });

  it('a booking past setTimeout\'s longest delay is armed in steps, not fired at once', async () => {
    const c = await setup();
    const DAY = 24 * 60 * MIN;
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() + 30 * DAY, hops: 1 } }));
    c.watch.rearm(c.store.list());
    expect(Math.max(...c.waits())).toBeLessThanOrEqual(2 ** 31 - 1);
    c.advance(29 * DAY);
    expect(c.retries).toEqual([]);
    c.advance(DAY);
    expect(c.retries).toHaveLength(1);
  });

  it('a booking gone by its time (the conversation was deleted): nothing fired, the line goes', async () => {
    const c = await setup();
    await c.store.set(claude({ pendingRetry: { text: 'go', atMs: c.now() + 5 * MIN, hops: 1 } }));
    c.watch.rearm(c.store.list());
    await c.store.set(claude());
    c.advance(5 * MIN);
    expect(c.retries).toEqual([]);
    expect(c.shown.at(-1)).toEqual(['s1', null]);
  });
});
