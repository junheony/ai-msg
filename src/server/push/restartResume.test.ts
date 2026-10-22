import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HighlightEvent } from '../../shared/highlights';
import { SessionStateStore, type ClaudeSessionState, type SessionState } from '../turn/SessionState';
import { en } from '../i18n/en';
import { ko } from '../i18n/ko';
import { isAutoRetryNotice, AUTO_RETRY_NOTICE } from '../turn/TurnRunner';
import { bookRestartResumes, cutSessions, readActivitySnapshot, RESTART_RESUME_DELAY_MS } from './restartResume';

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

  it('one entry per session, task names merged without repeats', () => {
    const states: SessionState[] = [claude({ sessionId: 's1', interrupted: { atMs: NOW - MIN, tasks: ['sleep 600', 'Agent: x'] } })];
    expect(cutSessions({ activity: snap(), events: [ev({ sessionId: 's1' })], states, pid: 222, now: NOW })).toEqual([{ sessionId: 's1', tasks: ['monitor build', 'sleep 600', 'Agent: x'] }]);
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
  const base = { enabled: true, exists: () => true, isDir: async () => true, text: (tasks: string[]) => `go ${tasks.join(',')}`, now: NOW };

  it('books the continue message a few seconds from now, hop 1, in the same session (engine and permissions are the session\'s own)', async () => {
    const store = await storeWith([claude({ sessionId: 's1' }), claude({ sessionId: 's2', cwd: '/w/b' })]);
    const n = await bookRestartResumes({ ...base, store, cut: [{ sessionId: 's1', tasks: ['sleep 600'] }, { sessionId: 's2', tasks: [] }] });
    expect(n).toBe(2);
    expect(store.get('s1')?.pendingRetry).toEqual({ text: 'go sleep 600', atMs: NOW + RESTART_RESUME_DELAY_MS, hops: 1 });
    expect(store.get('s2')?.pendingRetry).toEqual({ text: 'go ', atMs: NOW + RESTART_RESUME_DELAY_MS, hops: 1 });
  });

  it('nothing with 자동으로 이어가기 off', async () => {
    const store = await storeWith([claude()]);
    expect(await bookRestartResumes({ ...base, enabled: false, store, cut: [{ sessionId: 's1', tasks: [] }] })).toBe(0);
    expect(store.get('s1')?.pendingRetry).toBeUndefined();
  });

  it('skips an unknown session, a gone (trashed) one, a missing folder, and a commander that was running (it goes to the person)', async () => {
    const store = await storeWith([claude({ sessionId: 'gone' }), claude({ sessionId: 'nodir', cwd: '/nope' }), claude({ sessionId: 'cmd' })]);
    await store.setCommander('cmd', { status: 'running' } as unknown as NonNullable<ClaudeSessionState['commander']>);
    expect(store.get('cmd')?.commander?.status).toBe('running');
    const n = await bookRestartResumes({ ...base, store, exists: (st) => st.sessionId !== 'gone', isDir: async (d) => d !== '/nope', cut: ['unknown', 'gone', 'nodir', 'cmd'].map((sessionId) => ({ sessionId, tasks: [] })) });
    expect(n).toBe(0);
    for (const id of ['gone', 'nodir', 'cmd']) expect(store.get(id)?.pendingRetry).toBeUndefined();
  });

  it('a booking already there: the earlier one is kept, never two', async () => {
    const early = { text: 'mine', atMs: NOW + 1000, hops: 1 };
    const late = { text: 'later', atMs: NOW + 60 * MIN, hops: 1 };
    const store = await storeWith([claude({ sessionId: 's1', pendingRetry: early }), claude({ sessionId: 's2', pendingRetry: late })]);
    const n = await bookRestartResumes({ ...base, store, cut: [{ sessionId: 's1', tasks: [] }, { sessionId: 's2', tasks: [] }] });
    expect(n).toBe(1);
    expect(store.get('s1')?.pendingRetry).toEqual(early);
    expect(store.get('s2')?.pendingRetry?.atMs).toBe(NOW + RESTART_RESUME_DELAY_MS);
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
