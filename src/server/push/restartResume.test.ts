import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HighlightEvent } from '../../shared/highlights';
import { SessionStateStore, type ClaudeSessionState, type SessionState } from '../turn/SessionState';
import { en } from '../i18n/en';
import { ko } from '../i18n/ko';
import { isAutoRetryNotice, AUTO_RETRY_NOTICE } from '../turn/TurnRunner';
import { bookRestartResumes, cutSessions, readActivitySnapshot, readResumed, takeCutSnapshot, writeCutSnapshot, writeResumed, RESTART_RESUME_DELAY_MS, RESTART_RESUME_GAP_MS, RESTART_RESUME_REPEAT_MS } from './restartResume';

const MIN = 60_000;
const NOW = Date.parse('2026-10-23T03:00:00Z');
const claude = (over: Partial<ClaudeSessionState> = {}): ClaudeSessionState => ({ sessionId: 's1', cwd: '/w/proj', account: 'a', projectDir: '/p', lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus', ...over });
const ev = (over: Partial<HighlightEvent>): HighlightEvent => ({ at: NOW - MIN, kind: 'interrupted', sessionId: 's1', cwd: '/w/proj', title: 't', body: 'b', ...over });
const snap = (over: Record<string, unknown> = {}) => ({ updatedAt: new Date(NOW - 2 * MIN).toISOString(), pid: 111, draining: true, sessions: [{ sessionId: 's1', cwd: '/w/proj', running: false, bg: 2, tasks: ['monitor build', 'sleep 600'] }], ...over });

describe('cutSessions — what the last server left cut', () => {
  it('the previous server\'s activity snapshot: running or background sessions, with their task names', () => {
    const a = snap({ sessions: [{ sessionId: 's1', cwd: '/w', running: false, bg: 2, tasks: ['monitor build', 'sleep 600'] }, { sessionId: 's2', cwd: '/w', running: true, bg: 0, tasks: [] }, { sessionId: 's3', cwd: '/w', running: false, bg: 0, tasks: [] }] });
    expect(cutSessions({ activity: a, events: [], states: [], pid: 222, now: NOW })).toEqual([{ sessionId: 's1', tasks: ['monitor build', 'sleep 600'] }, { sessionId: 's2', tasks: [] }]);
  });

  it('a snapshot of this very process, an old one, or a broken one is ignored', () => {
    expect(cutSessions({ activity: snap(), events: [], states: [], pid: 111, now: NOW })).toEqual([]);
    expect(cutSessions({ activity: snap({ updatedAt: new Date(NOW - 31 * MIN).toISOString() }), events: [], states: [], pid: 222, now: NOW })).toEqual([]);
    expect(cutSessions({ activity: { pid: 1, sessions: 'x' }, events: [], states: [], pid: 222, now: NOW })).toEqual([]);
    expect(cutSessions({ activity: null, events: [], states: [], pid: 222, now: NOW })).toEqual([]);
  });

  it('a graceful shutdown deletes the snapshot: the restart cuts in the event log and the session states are used', () => {
    const states: SessionState[] = [claude({ sessionId: 's2', interrupted: { atMs: NOW - MIN, tasks: ['Agent: review'] } })];
    const events = [ev({ at: NOW - 40 * MIN, kind: 'server', sessionId: null }), ev({ sessionId: 's1' }), ev({ sessionId: 's2' })];
    expect(cutSessions({ activity: null, events, states, pid: 222, now: NOW })).toEqual([{ sessionId: 's1', tasks: [] }, { sessionId: 's2', tasks: ['Agent: review'] }]);
  });

  it('only the run just ended counts: evidence older than its last server event, or than 30 minutes, is not fired again', () => {
    const states: SessionState[] = [claude({ sessionId: 's2', interrupted: { atMs: NOW - 10 * MIN, tasks: ['old'] } })];
    const events = [ev({ at: NOW - 10 * MIN, sessionId: 's1' }), ev({ at: NOW - 5 * MIN, kind: 'server', sessionId: null }), ev({ at: NOW - 3 * MIN, sessionId: 's3' }), ev({ at: NOW - 45 * MIN, sessionId: 's4' })];
    expect(cutSessions({ activity: snap({ updatedAt: new Date(NOW - 6 * MIN).toISOString() }), events, states, pid: 222, now: NOW })).toEqual([{ sessionId: 's3', tasks: [] }]);
  });

  it('a cut of another cause (account limit, the background cap) and a turn without a session id are not restart cuts', () => {
    const states: SessionState[] = [claude({ sessionId: 's1', interrupted: { atMs: NOW - MIN, tasks: ['a'], cause: 'x 계정 한도' } }), claude({ sessionId: 's2', interrupted: { atMs: NOW - MIN, tasks: ['b'], cause: 'cap', kind: 'cap' } })];
    expect(cutSessions({ activity: null, events: [ev({ sessionId: null }), ev({ kind: 'turn', sessionId: 's3' })], states, pid: 222, now: NOW })).toEqual([]);
  });

  it('a broken trace never throws: interrupted with tasks not a list, odd values, a non-object', () => {
    const states = [
      claude({ sessionId: 's1', interrupted: { atMs: NOW - MIN, tasks: 'sleep' as unknown as string[] } }),
      claude({ sessionId: 's2', interrupted: { atMs: NOW - MIN, tasks: [1, 'ok', null] as unknown as string[] } }),
      claude({ sessionId: 's3', interrupted: 'x' as unknown as ClaudeSessionState['interrupted'] }),
      claude({ sessionId: 's4', interrupted: { atMs: 'soon', tasks: [] } as unknown as ClaudeSessionState['interrupted'] }),
    ];
    expect(cutSessions({ activity: { pid: 1, updatedAt: new Date(NOW).toISOString(), sessions: [null, 5, { sessionId: 's5', bg: '2', running: true, tasks: 'x' }] }, events: [], states, pid: 222, now: NOW }))
      .toEqual([{ sessionId: 's5', tasks: [] }, { sessionId: 's1', tasks: [] }, { sessionId: 's2', tasks: ['ok'] }]);
  });

  it('one entry per session, task names merged without repeats', () => {
    const states: SessionState[] = [claude({ sessionId: 's1', interrupted: { atMs: NOW - MIN, tasks: ['sleep 600', 'Agent: x'] } })];
    expect(cutSessions({ activity: snap(), events: [ev({ sessionId: 's1' })], states, pid: 222, now: NOW })).toEqual([{ sessionId: 's1', tasks: ['monitor build', 'sleep 600', 'Agent: x'] }]);
  });
});

describe('restart-cut.json — what a forced shutdown was about to abort', () => {
  const cut = (over: Record<string, unknown> = {}) => ({ pid: 111, atMs: NOW - MIN, sessions: [{ sessionId: 's1', tasks: ['monitor build'] }, { sessionId: 's2', tasks: [] }], ...over });

  it('alone (no events, no session state, no activity) it is enough', () => {
    expect(cutSessions({ activity: null, cut: cut(), events: [], states: [], pid: 222, now: NOW })).toEqual([{ sessionId: 's1', tasks: ['monitor build'] }, { sessionId: 's2', tasks: [] }]);
  });

  it('written after that run\'s drain event, it still counts; this very pid, older than 30 minutes or before the last server event does not', () => {
    const drainEvent = [ev({ at: NOW - 2 * MIN, kind: 'server', sessionId: null })];
    expect(cutSessions({ activity: null, cut: cut(), events: drainEvent, states: [], pid: 222, now: NOW })).toHaveLength(2);
    expect(cutSessions({ activity: null, cut: cut(), events: [], states: [], pid: 111, now: NOW })).toEqual([]);
    expect(cutSessions({ activity: null, cut: cut({ atMs: NOW - 31 * MIN }), events: [], states: [], pid: 222, now: NOW })).toEqual([]);
    expect(cutSessions({ activity: null, cut: cut({ atMs: NOW - 3 * MIN }), events: drainEvent, states: [], pid: 222, now: NOW })).toEqual([]);
  });

  it('a broken one never throws and adds nothing', () => {
    for (const c of [null, 'x', 42, [], { pid: 1 }, { pid: 1, atMs: NOW - MIN, sessions: 'x' }, { pid: 1, atMs: NOW - MIN, sessions: [null, 1, { sessionId: '' }, { sessionId: 7 }] }]) {
      expect(cutSessions({ activity: null, cut: c, events: [], states: [], pid: 222, now: NOW })).toEqual([]);
    }
  });

  it('task names merge with the other traces', () => {
    const states: SessionState[] = [claude({ sessionId: 's1', interrupted: { atMs: NOW - MIN, tasks: ['Agent: x', 'monitor build'] } })];
    expect(cutSessions({ activity: snap(), cut: cut(), events: [ev({ sessionId: 's2' })], states, pid: 222, now: NOW })).toEqual([{ sessionId: 's1', tasks: ['monitor build', 'sleep 600', 'Agent: x'] }, { sessionId: 's2', tasks: [] }]);
  });

  it('written atomically (0600) and read back once: the file is gone after reading, also when broken', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-rr-'));
    const f = path.join(dir, 'restart-cut.json');
    writeCutSnapshot(f, [{ sessionId: 's1', tasks: ['sleep 600'] }], 111, NOW - MIN);
    expect((await fs.stat(f)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual(['restart-cut.json']);
    const raw = await takeCutSnapshot(f);
    expect(raw).toEqual({ pid: 111, atMs: NOW - MIN, sessions: [{ sessionId: 's1', tasks: ['sleep 600'] }] });
    await expect(fs.stat(f)).rejects.toThrow();
    expect(await takeCutSnapshot(f)).toBeNull();
    await fs.writeFile(f, '{oops');
    expect(await takeCutSnapshot(f)).toBeNull();
    await expect(fs.stat(f)).rejects.toThrow();
  });

  it('a write that fails throws (lifecycle logs it) and leaves no temp file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-rr-'));
    expect(() => writeCutSnapshot(path.join(dir, 'missing', 'restart-cut.json'), [])).toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('from the file alone a resume is booked (the forced-restart case)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-rr-'));
    const f = path.join(dir, 'restart-cut.json');
    writeCutSnapshot(f, [{ sessionId: 's1', tasks: ['sleep 600'] }], 111, NOW - MIN);
    const store = new SessionStateStore(path.join(dir, 'state.json'));
    await store.load();
    await store.set(claude({ sessionId: 's1' }));
    const c = cutSessions({ activity: null, cut: await takeCutSnapshot(f), events: [ev({ at: NOW - 2 * MIN, kind: 'server', sessionId: null })], states: store.list(), pid: 222, now: NOW });
    const r = await bookRestartResumes({ cut: c, store, enabled: true, exists: () => true, isDir: async () => true, text: (t) => `go ${t.join(',')}`, now: NOW, resumed: new Map() });
    expect(r.booked).toBe(1);
    expect(store.get('s1')?.pendingRetry).toEqual({ text: 'go sleep 600', atMs: NOW + RESTART_RESUME_DELAY_MS, hops: 1 });
  });
});

describe('readActivitySnapshot', () => {
  it('parsed JSON, or null when missing or broken', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-rr-'));
    const f = path.join(dir, 'activity.json');
    expect(await readActivitySnapshot(f)).toBeNull();
    await fs.writeFile(f, '{oops');
    expect(await readActivitySnapshot(f)).toBeNull();
    await fs.writeFile(f, JSON.stringify(snap()));
    expect(await readActivitySnapshot(f)).toEqual(snap());
  });
});

describe('bookRestartResumes — a 자동으로 이어가기 booking per cut session', () => {
  async function storeWith(states: SessionState[]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-rr-'));
    const store = new SessionStateStore(path.join(dir, 'state.json'));
    await store.load();
    for (const s of states) await store.set(s);
    return store;
  }
  const base = { enabled: true, exists: () => true, isDir: async () => true, text: (tasks: string[]) => `go ${tasks.join(',')}`, now: NOW, resumed: new Map<string, number>() };

  it('books the continue message in the same session (engine and permissions its own), hop 1: the first in 5 s, each next 15 s later', async () => {
    const store = await storeWith([claude({ sessionId: 's1' }), claude({ sessionId: 's2', cwd: '/w/b' }), claude({ sessionId: 's3' })]);
    const resumed = new Map<string, number>();
    const r = await bookRestartResumes({ ...base, resumed, store, cut: [{ sessionId: 's1', tasks: ['sleep 600'] }, { sessionId: 's2', tasks: [] }, { sessionId: 's3', tasks: [] }] });
    expect(r).toEqual({ booked: 3, skipped: [] });
    expect(store.get('s1')?.pendingRetry).toEqual({ text: 'go sleep 600', atMs: NOW + RESTART_RESUME_DELAY_MS, hops: 1 });
    expect(store.get('s2')?.pendingRetry).toEqual({ text: 'go ', atMs: NOW + RESTART_RESUME_DELAY_MS + RESTART_RESUME_GAP_MS, hops: 1 });
    expect(store.get('s3')?.pendingRetry?.atMs).toBe(NOW + RESTART_RESUME_DELAY_MS + 2 * RESTART_RESUME_GAP_MS);
    expect([...resumed]).toEqual([['s1', NOW], ['s2', NOW], ['s3', NOW]]);
  });

  it('repeat guard: a session sent on after the last restart and cut again is skipped once (logged), then sent on again', async () => {
    const store = await storeWith([claude({ sessionId: 's1' })]);
    const resumed = new Map([['s1', NOW - 20 * MIN]]);
    expect(await bookRestartResumes({ ...base, resumed, store, cut: [{ sessionId: 's1', tasks: [] }] })).toEqual({ booked: 0, skipped: ['s1'] });
    expect(store.get('s1')?.pendingRetry).toBeUndefined();
    expect(resumed.has('s1')).toBe(false);
    expect(await bookRestartResumes({ ...base, resumed, store, cut: [{ sessionId: 's1', tasks: [] }] })).toEqual({ booked: 1, skipped: [] });
  });

  it('the guard file: read back, old entries and broken content dropped', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-rr-'));
    const f = path.join(dir, 'restart-resumed.json');
    expect(await readResumed(f, NOW)).toEqual(new Map());
    await writeResumed(f, new Map([['a', NOW - MIN], ['old', NOW - RESTART_RESUME_REPEAT_MS - 1]]));
    expect([...(await readResumed(f, NOW))]).toEqual([['a', NOW - MIN]]);
    await fs.writeFile(f, '[1,2');
    expect(await readResumed(f, NOW)).toEqual(new Map());
  });

  it('nothing with 자동으로 이어가기 off', async () => {
    const store = await storeWith([claude()]);
    expect(await bookRestartResumes({ ...base, enabled: false, store, cut: [{ sessionId: 's1', tasks: [] }] })).toEqual({ booked: 0, skipped: [] });
    expect(store.get('s1')?.pendingRetry).toBeUndefined();
  });

  it('skips an unknown session, a gone (trashed) one, a missing folder, and a commander that was running (it goes to the person)', async () => {
    const store = await storeWith([claude({ sessionId: 'gone' }), claude({ sessionId: 'nodir', cwd: '/nope' }), claude({ sessionId: 'cmd' })]);
    await store.setCommander('cmd', { status: 'running' } as unknown as NonNullable<ClaudeSessionState['commander']>);
    expect(store.get('cmd')?.commander?.status).toBe('running');
    const r = await bookRestartResumes({ ...base, store, exists: (st) => st.sessionId !== 'gone', isDir: async (d) => d !== '/nope', cut: ['unknown', 'gone', 'nodir', 'cmd'].map((sessionId) => ({ sessionId, tasks: [] })) });
    expect(r.booked).toBe(0);
    for (const id of ['gone', 'nodir', 'cmd']) expect(store.get(id)?.pendingRetry).toBeUndefined();
  });

  it('a booking already there stays the one booking: a sooner one untouched, a later one only brought forward (its message and hops kept)', async () => {
    const early = { text: 'mine', atMs: NOW + 1000, hops: 1 };
    const late = { text: 'the user prompt', atMs: NOW + 60 * MIN, hops: 2, commanderHop: 3 };
    const store = await storeWith([claude({ sessionId: 's1', pendingRetry: early }), claude({ sessionId: 's2', pendingRetry: late })]);
    const r = await bookRestartResumes({ ...base, resumed: new Map(), store, cut: [{ sessionId: 's1', tasks: [] }, { sessionId: 's2', tasks: [] }] });
    expect(r.booked).toBe(1);
    expect(store.get('s1')?.pendingRetry).toEqual(early);
    expect(store.get('s2')?.pendingRetry).toEqual({ ...late, atMs: NOW + RESTART_RESUME_DELAY_MS });
  });
});

describe('the restart-resume message and notice', () => {
  it('names the cut work and asks to set it up again and go on, in both languages', () => {
    for (const d of [en, ko]) {
      const t = d.turn.restartResume.prompt('Monitor: build, sleep 600');
      expect(t.startsWith(d.turn.restartResume.lead)).toBe(true);
      expect(t).toContain('Monitor: build');
      expect(t).toContain('sleep 600');
      expect(d.turn.restartResume.prompt('').startsWith(d.turn.restartResume.lead)).toBe(true);
    }
  });

  it('isAutoRetryNotice: the limit retry and the restart resume notices both mark a turn deck started itself', () => {
    expect(isAutoRetryNotice(AUTO_RETRY_NOTICE)).toBe(true);
    expect(isAutoRetryNotice(en.turn.restartResume.notice)).toBe(true);
    expect(isAutoRetryNotice(ko.turn.restartResume.notice)).toBe(true);
    expect(isAutoRetryNotice('something else')).toBe(false);
  });
});
