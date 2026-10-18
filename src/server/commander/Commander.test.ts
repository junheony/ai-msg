import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermMode } from '../../shared/permission';
import type { ServerMessage } from '../../shared/protocol';
import type { AuditEntry } from '../audit';
import type { PushPayload } from '../push/PushNotifier';
import { SessionStateStore, type SessionState } from '../turn/SessionState';
import { Commander, RESTART_NOTE, type CommanderSendRequest } from './Commander';
import type { JudgeInput, JudgeResult } from './Judge';
import type { CommanderState, SegmentDigest, Verdict } from './types';

const SID = 's1';
const claudeState = (over: Partial<SessionState> = {}): SessionState => ({ sessionId: SID, cwd: '/w/proj', account: 'a', projectDir: '/p', lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus', ...over }) as SessionState;

let n = 0;
/** A segment with progress (a changed file each time) unless a signature is given. */
const digest = (over: Partial<SegmentDigest> = {}): SegmentDigest => ({
  digestId: `d${++n}`, turns: 1, retries: 0, summary: '했습니다', changedFiles: ['a.ts'], changedFileCount: 1,
  testRuns: [], failure: { ok: true, errorText: null, kind: null }, signature: `-.${n}.t${n}`, ...over,
});
const cont = (next = '테스트를 고치세요', over: Partial<Verdict> = {}): Verdict => ({ verdict: 'continue', reason: '진행 중', next, risk: 'none', confidence: 'high', ...over });

type Pending = { input: JudgeInput; resolve: (r: JudgeResult) => void };

async function setup(opts: { busy?: boolean; mode?: PermMode; enabled?: boolean; state?: SessionState | null; sendOk?: boolean; now?: () => number } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-cmd-'));
  const store = new SessionStateStore(path.join(dir, 'session-state.json'));
  await store.load();
  if (opts.state !== null) await store.set(opts.state ?? claudeState());
  const sends: CommanderSendRequest[] = [];
  const pushes: PushPayload[] = [];
  const audits: AuditEntry[] = [];
  const records: ServerMessage[] = [];
  const broadcasts: ServerMessage[] = [];
  const judged: JudgeInput[] = [];
  const env = {
    busy: opts.busy ?? false,
    mode: (opts.mode ?? 'default') as PermMode,
    enabled: opts.enabled ?? true,
    sendOk: opts.sendOk ?? true,
    /** Verdicts the fake judge hands out in order; empty = held until `pending` is resolved by the test. */
    verdicts: [] as (Verdict | { failed: true })[],
    pending: [] as Pending[],
    usage: null as JudgeResult['usage'],
  };
  const c = new Commander({
    store,
    judge: (input) => {
      judged.push(input);
      const v = env.verdicts.shift();
      if (v === undefined) return new Promise((resolve) => env.pending.push({ input, resolve: (r) => resolve({ ...r, account: 'a' }) }));
      if ('failed' in v) return Promise.resolve({ verdict: { verdict: 'human', reason: '판정 실패', confidence: 'low' }, failed: true, usage: env.usage, account: 'a' });
      return Promise.resolve({ verdict: v, failed: false, usage: env.usage, account: 'a' });
    },
    send: (r) => { sends.push(r); if (env.sendOk) env.busy = true; return env.sendOk; },
    isBusy: () => env.busy,
    permissionModeOf: () => env.mode,
    push: (p) => pushes.push(p),
    record: (m) => records.push(m),
    audit: (e) => audits.push(e),
    broadcast: (m) => broadcasts.push(m),
    enabled: () => env.enabled,
    limits: () => ({ maxTurns: 20, tokenCap: 2_000_000 }),
    watchdogMs: 0,
    ...(opts.now ? { now: opts.now } : {}),
  });
  /** The auto turn ended: ws releases busy and calls the idle hook. */
  const idle = async (d: SegmentDigest = digest()) => { env.busy = false; await c.onSessionIdle(SID, d); await c.settled(); };
  const state = () => store.get(SID)?.commander as CommanderState;
  return { c, store, dir, env, sends, pushes, audits, records, broadcasts, judged, idle, state };
}

describe('Commander', () => {
  beforeEach(() => { n = 0; });

  describe('set', () => {
    it('refuses when the feature is off, on a non-Claude session, on bypass and while one is active', async () => {
      const off = await setup({ enabled: false });
      expect(off.c.set(SID, { goal: 'g', done: 'd' })).toMatchObject({ ok: false, code: 'commander_disabled' });
      const none = await setup({ state: null });
      expect(none.c.set(SID, { goal: 'g', done: 'd' })).toMatchObject({ ok: false, code: 'commander_engine' });
      const codex = await setup({ state: { sessionId: SID, cwd: '/w', engine: 'codex', defaultModel: 'gpt-5.5', sandbox: 'workspace-write', rolloutFile: null, createdAtMs: 0, lastTurnAtMs: null, justCompacted: false } as unknown as SessionState });
      expect(codex.c.set(SID, { goal: 'g', done: 'd' })).toMatchObject({ ok: false, code: 'commander_engine' });
      const bypass = await setup({ mode: 'bypassPermissions' });
      expect(bypass.c.set(SID, { goal: 'g', done: 'd' })).toMatchObject({ ok: false, code: 'commander_bypass' });
      const t = await setup();
      expect(t.c.set(SID, { goal: 'g', done: 'd' })).toEqual({ ok: true });
      expect(t.c.set(SID, { goal: 'g2', done: 'd2' })).toMatchObject({ ok: false, code: 'commander_active' });
      await t.c.settled();
    });

    it('idle session: sends goal + done condition as hop 1 at once (no judge), then running', async () => {
      const t = await setup();
      t.c.set(SID, { goal: '버그 고치기', done: '테스트 통과', maxTurns: 5 });
      await t.c.settled();
      expect(t.judged).toHaveLength(0);
      expect(t.sends).toHaveLength(1);
      expect(t.sends[0]).toMatchObject({ kind: 'commander', sessionId: SID, cwd: '/w/proj', text: '목표: 버그 고치기\n완료 조건: 테스트 통과', hop: 1, sendKey: '1:1' });
      expect(t.sends[0]!.commanderNote).toContain('1/5');
      expect(t.state()).toMatchObject({ status: 'running', hop: 1, epoch: 1, sendKey: '1:1', budget: { autoTurnsUsed: 1, maxAutoTurns: 5 } });
      expect(t.audits).toEqual([expect.objectContaining({ kind: 'commander_send', sessionId: SID, epoch: 1, hop: 1, sendKey: '1:1' })]);
      expect(t.broadcasts.at(-1)).toMatchObject({ type: 'commander', sessionId: SID, state: { status: 'running' } });
    });

    it('busy session: stays armed and sends the first instruction when the session goes idle (that segment is not judged)', async () => {
      const t = await setup({ busy: true });
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      expect(t.sends).toHaveLength(0);
      expect(t.state().status).toBe('armed');
      await t.idle();
      expect(t.judged).toHaveLength(0);
      expect(t.sends).toHaveLength(1);
      expect(t.state().status).toBe('running');
    });
  });

  describe('judging', () => {
    it('continue → the next instruction as the next hop', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push(cont('타입 오류를 고치세요'));
      await t.idle();
      expect(t.judged).toHaveLength(1);
      expect(t.judged[0]).toMatchObject({ goal: 'g', done: 'd', hop: 1, maxTurns: 20 });
      expect(t.sends.map((s) => [s.hop, s.text, s.sendKey])).toEqual([[1, '목표: g\n완료 조건: d', '1:1'], [2, '타입 오류를 고치세요', '1:2']]);
      expect(t.state()).toMatchObject({ status: 'running', hop: 2, budget: { autoTurnsUsed: 2 } });
      expect(t.state().lastVerdicts).toHaveLength(1);
      expect(t.audits.filter((a) => a.kind === 'commander_verdict')).toEqual([expect.objectContaining({ verdict: 'continue', epoch: 1, judgeAccount: 'a' })]);
      expect(t.records).toEqual([expect.objectContaining({ type: 'commander', lastVerdict: expect.objectContaining({ verdict: 'continue' }) })]);
    });

    it('done with a passing, unchanged test run → done + push', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push({ verdict: 'done', reason: '테스트 통과', evidence: { testRunId: 'r1' }, risk: 'none', confidence: 'high' });
      await t.idle(digest({ testRuns: [{ testRunId: 'r1', command: 'npx vitest run', outputTail: 'Tests 3 passed', hasOutput: true, exitCode: 0, filesChangedAfter: false, sub: false }] }));
      expect(t.state().status).toBe('done');
      expect(t.pushes).toEqual([expect.objectContaining({ kind: 'commander', body: '사령탑 · 목표 달성 — 테스트 통과', sessionId: SID, tag: `commander:${SID}` })]);
      expect(t.sends).toHaveLength(1);
    });

    it('done without valid evidence → waiting_human "완료 근거 부족"', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push({ verdict: 'done', reason: '된 것 같음', evidence: { testRunId: 'r1' }, risk: 'none', confidence: 'high' });
      await t.idle(digest({ testRuns: [{ testRunId: 'r1', command: 'npx vitest run', outputTail: 'x', hasOutput: true, exitCode: 0, filesChangedAfter: true, sub: false }] }));
      expect(t.state()).toMatchObject({ status: 'waiting_human', note: '완료 근거 부족', pausedBy: 'check' });
      expect(t.pushes[0]!.body).toContain('완료 근거 부족');
    });

    it('human → waiting_human + push', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push({ verdict: 'human', reason: '설계 선택 필요', confidence: 'high' });
      await t.idle();
      expect(t.state()).toMatchObject({ status: 'waiting_human', note: '설계 선택 필요' });
      expect(t.pushes).toEqual([expect.objectContaining({ body: '사령탑 · 판단이 필요합니다 — 설계 선택 필요' })]);
      expect(t.sends).toHaveLength(1);
    });

    it.each([
      ['risk', cont('계속', { risk: 'deploy' }), '되돌리기 어려운'],
      ['missing risk', (() => { const v = cont('계속'); delete v.risk; return v; })(), '되돌리기 어려운'],
      ['screened instruction', cont('git push origin main 하세요'), '차단 문구'],
      ['low confidence', cont('계속', { confidence: 'low' }), '확신 낮음'],
      ['judge failure', { failed: true } as const, '판정 실패'],
    ])('continue blocked by %s → waiting_human, nothing sent', async (_name, v, why) => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push(v);
      await t.idle();
      expect(t.state().status).toBe('waiting_human');
      expect(t.state().note).toContain(why);
      expect(t.sends).toHaveLength(1);
      expect(t.pushes).toHaveLength(1);
    });

    it('no progress (the same error signature twice) → waiting_human', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push(cont('a'), cont('b'));
      const failing = () => digest({ signature: 'abc123.0.t1', failure: { ok: false, errorText: 'x', kind: 'other' } });
      await t.idle(failing());
      expect(t.state().status).toBe('running');
      await t.idle(failing());
      expect(t.state()).toMatchObject({ status: 'waiting_human', note: '진척 없음' });
      expect(t.sends).toHaveLength(2);
    });

    it('a segment with no turn → waiting_human without judging', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      await t.idle(digest({ turns: 0 }));
      expect(t.judged).toHaveLength(0);
      expect(t.state()).toMatchObject({ status: 'waiting_human', note: '자동 턴이 실행되지 않았습니다' });
    });

    it('the same digest is judged once', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push({ verdict: 'human', reason: 'x', confidence: 'high' });
      const d = digest();
      await t.idle(d);
      await t.c.resume(SID, t.state().epoch);
      await t.c.settled();
      // resume sent a fresh first instruction; the old digest arriving again is ignored.
      await t.idle(d);
      expect(t.judged).toHaveLength(1);
    });
  });

  describe('epoch', () => {
    it('a late verdict (user stepped in while judging) is dropped; its tokens still count', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.busy = false;
      const judging = t.c.onSessionIdle(SID, digest());
      await vi.waitFor(() => expect(t.env.pending).toHaveLength(1));
      expect(t.state().status).toBe('judging');
      t.c.userIntervened(SID);
      expect(t.state()).toMatchObject({ status: 'paused', epoch: 2, pausedBy: 'user' });
      t.env.pending[0]!.resolve({ verdict: cont('계속'), failed: false, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
      await judging;
      await t.c.settled();
      expect(t.sends).toHaveLength(1);
      expect(t.state()).toMatchObject({ status: 'paused', epoch: 2, budget: { tokensUsed: 15 } });
      expect(t.state().lastVerdicts).toHaveLength(0);
      expect(t.pushes).toHaveLength(0);
    });

    it('a person steering / sending mid auto turn pauses (no push) and that segment is not judged', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.c.userIntervened(SID);
      expect(t.state()).toMatchObject({ status: 'paused', pausedBy: 'user' });
      await t.idle();
      expect(t.judged).toHaveLength(0);
      expect(t.pushes).toHaveLength(0);
    });

    it('stop / pause / resume need the current epoch; stop pushes; resume restarts with the first instruction', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      await t.idle(digest({ turns: 0 }));
      const e = t.state().epoch;
      expect(t.c.pause(SID, e + 5)).toMatchObject({ ok: false, code: 'commander_stale_epoch' });
      expect(t.c.resume(SID, e)).toEqual({ ok: true });
      await t.c.settled();
      expect(t.state()).toMatchObject({ status: 'running', epoch: e + 1 });
      expect(t.sends.at(-1)).toMatchObject({ text: '목표: g\n완료 조건: d', hop: 2, sendKey: `${e + 1}:2` });
      expect(t.c.pause(SID, e + 1)).toEqual({ ok: true });
      expect(t.state().status).toBe('paused');
      expect(t.c.stop(SID, e)).toMatchObject({ ok: false, code: 'commander_stale_epoch' });
      expect(t.c.stop(SID, e + 2)).toEqual({ ok: true });
      expect(t.state().status).toBe('stopped');
      expect(t.pushes.at(-1)).toMatchObject({ body: '사령탑 · 정지됨' });
      // Stopped: a new set is allowed.
      expect(t.c.set(SID, { goal: 'g2', done: 'd2' })).toEqual({ ok: true });
      await t.c.settled();
    });
  });

  describe('send guards', () => {
    it('busy at send time → waiting_human, nothing sent', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push(cont('다음'));
      t.env.busy = false;
      const p = t.c.onSessionIdle(SID, digest());
      t.env.busy = true; // a person's send started before the judge returned
      await p;
      await t.c.settled();
      expect(t.sends).toHaveLength(1);
      expect(t.state().status).toBe('waiting_human');
    });

    it('a refused send (ws said no) → waiting_human', async () => {
      const t = await setup({ sendOk: false });
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      expect(t.sends).toHaveLength(1);
      expect(t.state()).toMatchObject({ status: 'waiting_human', note: '자동 지시를 보내지 못했습니다' });
      expect(t.state().budget.autoTurnsUsed).toBe(0);
    });

    it('bypass turned on after set → no automatic send', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.mode = 'bypassPermissions';
      t.env.verdicts.push(cont('다음'));
      await t.idle();
      expect(t.sends).toHaveLength(1);
      expect(t.state().status).toBe('waiting_human');
    });

    it('feature turned off → nothing is sent at idle', async () => {
      const t = await setup({ busy: true });
      t.c.set(SID, { goal: 'g', done: 'd' });
      t.env.enabled = false;
      await t.idle();
      expect(t.sends).toHaveLength(0);
    });
  });

  describe('budget', () => {
    it('turn cap reached → waiting_human instead of the next send', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd', maxTurns: 1 });
      await t.c.settled();
      t.env.verdicts.push(cont('다음'));
      await t.idle();
      expect(t.sends).toHaveLength(1);
      expect(t.state().status).toBe('waiting_human');
      expect(t.state().note).toContain('턴 상한');
    });

    it('auto turn usage over the token cap → waiting_human at once (watchdog), and the judge is not called', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.c.observe({ type: 'turn_result', turnId: 'x:cmd1', sessionId: SID, cwd: '/w/proj', ok: true, text: '', errorText: null, auto: 'commander', badge: { account: 'a', model: 'opus', reason: '', modelNote: null, usage: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 400_000, cacheCreationTokens: 200_000 } } } as ServerMessage);
      await t.c.settled();
      expect(t.state().budget.tokensUsed).toBe(2_100_000);
      expect(t.state().status).toBe('waiting_human');
      expect(t.state().note).toContain('토큰 예산 초과');
      await t.idle();
      expect(t.judged).toHaveLength(0);
    });

    it('a person turn usage (no auto marker) is not counted', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.c.observe({ type: 'turn_result', turnId: 'x', sessionId: SID, cwd: '/w/proj', ok: true, text: '', errorText: null, badge: { account: 'a', model: 'opus', reason: '', modelNote: null, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 } } } as ServerMessage);
      expect(t.state().budget.tokensUsed).toBe(0);
    });

    it('wall clock over 12h → the watchdog hands over', async () => {
      let now = 1_000;
      const t = await setup({ now: () => now });
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      now += 12 * 3600_000;
      t.c.watchdog();
      await t.c.settled();
      expect(t.state()).toMatchObject({ status: 'waiting_human' });
      expect(t.state().note).toContain('시간 상한');
    });

    it('internal retries in a segment over the cap → waiting_human without judging', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      await t.idle(digest({ turns: 7, retries: 6 }));
      expect(t.judged).toHaveLength(0);
      expect(t.state().note).toContain('내부 재시도');
    });

    it('background continuations are not internal retries: a long :bg segment is judged', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push(cont('다음'));
      await t.idle(digest({ turns: 9, retries: 0 }));
      expect(t.judged).toHaveLength(1);
      expect(t.state()).toMatchObject({ status: 'running', budget: { internalRetriesUsed: 0 } });
    });
  });

  describe('cards', () => {
    it('a card during an auto turn → waiting_human (no commander push); answering resumes and the segment is judged', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.c.observe({ type: 'permission_request', turnId: 't', sessionId: SID, cwd: '/w/proj', requestId: 'q', toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: false, sessionLabel: null } as ServerMessage);
      expect(t.state()).toMatchObject({ status: 'waiting_human', pausedBy: 'card' });
      expect(t.pushes).toHaveLength(0);
      const e = t.state().epoch;
      t.c.cardAnswered(SID);
      expect(t.state()).toMatchObject({ status: 'running', epoch: e + 1 });
      t.env.verdicts.push(cont('다음'));
      await t.idle();
      expect(t.sends).toHaveLength(2);
    });
  });

  describe('defects from the adversarial review', () => {
    it('a segment the user stopped (ABORTED) goes to a person without judging', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.env.verdicts.push(cont('다음'));
      await t.idle(digest({ failure: { ok: false, errorText: '중단됨', kind: 'other' } }));
      expect(t.judged).toHaveLength(0);
      expect(t.sends).toHaveLength(1);
      expect(t.state()).toMatchObject({ status: 'waiting_human' });
    });

    it('a booked retry of an auto turn: one push and a note with its time; cleared once the segment is judged', async () => {
      let now = Date.parse('2026-10-18T01:00:00Z');
      const t = await setup({ now: () => now });
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      const at = now + 3 * 3600_000;
      const hhmm = new Date(at).toTimeString().slice(0, 5);
      t.c.retryBooked(SID, at);
      t.c.retryBooked(SID, at);
      expect(t.pushes).toEqual([expect.objectContaining({ kind: 'commander', body: expect.stringContaining(`자동 재시도 예정(${hhmm})`) })]);
      expect(t.state()).toMatchObject({ status: 'running', note: `자동 재시도 예정(${hhmm})` });
      expect(t.broadcasts.at(-1)).toMatchObject({ note: `자동 재시도 예정(${hhmm})` });
      // A booking already due, or a commander not running: nothing.
      t.c.retryBooked(SID, now - 1);
      expect(t.pushes).toHaveLength(1);
      now = at;
      t.env.verdicts.push(cont('다음'));
      await t.idle();
      expect(t.state().status).toBe('running');
      expect(t.state().note).toBeUndefined();
      t.c.pause(SID, t.state().epoch);
      t.c.retryBooked(SID, now + 60_000);
      expect(t.pushes).toHaveLength(1);
    });

    it.each(['stop', 'pause'] as const)('%s drops a booked retry of an auto turn (a person\'s booking stays)', async (op) => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      await t.store.set({ ...t.store.get(SID)!, pendingRetry: { text: 'x', atMs: 1, hops: 1, commanderHop: 1 } });
      t.c[op](SID, t.state().epoch);
      expect(t.store.get(SID)).not.toHaveProperty('pendingRetry');
      const u = await setup();
      u.c.set(SID, { goal: 'g', done: 'd' });
      await u.c.settled();
      await u.store.set({ ...u.store.get(SID)!, pendingRetry: { text: 'x', atMs: 1, hops: 1 } });
      u.c[op](SID, u.state().epoch);
      expect(u.store.get(SID)?.pendingRetry).toBeDefined();
    });

    it('set drops a leftover booked retry of an earlier commander before deciding to send', async () => {
      const t = await setup({ state: claudeState({ pendingRetry: { text: 'x', atMs: 1, hops: 1, commanderHop: 3 } }) });
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      expect(t.store.get(SID)).not.toHaveProperty('pendingRetry');
    });
  });

  describe('restore', () => {
    it('active commanders come back as waiting_human with one push and no send', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      const before = t.state();
      // A new process reading the same file.
      const store2 = new SessionStateStore(path.join(t.dir, 'session-state.json'));
      await store2.load();
      expect(store2.get(SID)?.commander?.status).toBe('running');
      const sends: CommanderSendRequest[] = [];
      const pushes: PushPayload[] = [];
      const judged: JudgeInput[] = [];
      const c2 = new Commander({
        store: store2, judge: (i) => { judged.push(i); return new Promise(() => {}); }, send: (r) => { sends.push(r); return true; }, isBusy: () => false, permissionModeOf: () => 'default',
        push: (p) => pushes.push(p), record: () => {}, audit: () => {}, broadcast: () => {}, enabled: () => true, limits: () => ({ maxTurns: 20, tokenCap: 2_000_000 }), watchdogMs: 0,
      });
      c2.restore(store2.list());
      await c2.settled();
      expect(store2.get(SID)?.commander).toMatchObject({ status: 'waiting_human', pausedBy: 'restart', note: RESTART_NOTE, epoch: before.epoch + 1 });
      expect(pushes).toHaveLength(1);
      // Idle after the restart: still nothing sent or judged.
      await c2.onSessionIdle(SID, digest());
      expect(sends).toHaveLength(0);
      expect(judged).toHaveLength(0);
    });

    it('stopped / done / paused are left as they are', async () => {
      const t = await setup();
      t.c.set(SID, { goal: 'g', done: 'd' });
      await t.c.settled();
      t.c.pause(SID, t.state().epoch);
      const st = t.state();
      t.c.restore(t.store.list());
      expect(t.state()).toEqual(st);
      expect(t.pushes).toHaveLength(0);
    });
  });

  it('quiet() covers sending / running / judging / waiting_human, not paused', async () => {
    const t = await setup();
    expect(t.c.quiet(SID)).toBe(false);
    t.c.set(SID, { goal: 'g', done: 'd' });
    await t.c.settled();
    expect(t.c.quiet(SID)).toBe(true);
    t.c.pause(SID, t.state().epoch);
    expect(t.c.quiet(SID)).toBe(false);
    expect(t.c.isActive(SID)).toBe(true);
  });
});
