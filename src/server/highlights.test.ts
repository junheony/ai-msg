import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventLog, HIGHLIGHT_KEEP_MS, selectEvent } from './highlights';
import { ABORTED, SHUTDOWN_ABORTED, SHUTDOWN_CUT_NOTICE } from './turn/TurnRunner';
import type { HighlightEvent } from '../shared/highlights';

const NOW = 1_800_000_000_000;
const H = 3600_000;
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-highlights-'));
  file = path.join(dir, 'events.jsonl');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const ev = (at: number, over: Partial<HighlightEvent> = {}): HighlightEvent => ({ at, kind: 'turn', sessionId: 's1', cwd: '/p/app', title: 'T', body: '완료', ok: true, ...over });
const lines = async () => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as HighlightEvent);

describe('EventLog', () => {
  it('appends one line per recorded event and queries newest first within the window', async () => {
    let now = NOW - 10 * H;
    const log = new EventLog(file, { now: () => now, titleOf: () => 'My session' });
    await log.load();
    log.record({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/p/app', ok: true, text: '# 끝냈습니다\n자세히', badge: null, errorText: null });
    now = NOW - 2 * H;
    log.record({ type: 'turn_result', turnId: 't2', sessionId: 's1', cwd: '/p/app', ok: false, text: '', badge: null, errorText: 'boom' });
    now = NOW;
    log.record({ type: 'turn_delta', turnId: 't3', sessionId: 's1', cwd: '/p/app', text: 'x' } as never);
    await log.flush();
    const disk = await lines();
    expect(disk).toHaveLength(2);
    expect(disk[0]).toMatchObject({ kind: 'turn', ok: true, title: 'My session', body: '완료 · 끝냈습니다', sessionId: 's1', cwd: '/p/app', at: NOW - 10 * H });
    expect(disk[1]).toMatchObject({ kind: 'turn', ok: false, body: '실패 · boom' });
    expect(log.query(NOW - 6 * H).map((e) => e.at)).toEqual([NOW - 2 * H]);
    expect(log.query(NOW - 24 * H).map((e) => e.at)).toEqual([NOW - 2 * H, NOW - 10 * H]);
  });

  it('drops lines older than 7 days and broken lines at load, and rewrites the file without them', async () => {
    const old = ev(NOW - HIGHLIGHT_KEEP_MS - 1);
    const fresh = ev(NOW - H, { body: 'fresh' });
    await fs.writeFile(file, [JSON.stringify(old), '{not json', JSON.stringify({ at: 'x' }), JSON.stringify(fresh), ''].join('\n'));
    const log = new EventLog(file, { now: () => NOW });
    await log.load();
    expect(log.query(0).map((e) => e.body)).toEqual(['fresh']);
    expect(await lines()).toEqual([fresh]);
    expect(await fs.readdir(dir)).toEqual(['events.jsonl']);
  });

  it('starts empty without a file and records server events with a null session', async () => {
    const log = new EventLog(file, { now: () => NOW });
    await log.load();
    log.recordServer('서버 시작');
    await log.flush();
    expect(await lines()).toEqual([{ at: NOW, kind: 'server', sessionId: null, cwd: '', title: '서버', body: '서버 시작' }]);
  });
  it('drops lines with an unknown kind at load and rewrites the file', async () => {
    const fresh = ev(NOW - H, { body: 'fresh' });
    await fs.writeFile(file, [JSON.stringify({ ...ev(NOW - 2 * H), kind: 'bogus' }), JSON.stringify(fresh), ''].join('\n'));
    const log = new EventLog(file, { now: () => NOW });
    await log.load();
    expect(log.query(0).map((e) => e.body)).toEqual(['fresh']);
    expect(await lines()).toEqual([fresh]);
  });

  it('a file whose last line has no newline is rewritten, so the next append starts on its own line', async () => {
    const a = ev(NOW - 2 * H, { body: 'a' });
    await fs.writeFile(file, JSON.stringify(a));
    const log = new EventLog(file, { now: () => NOW });
    await log.load();
    log.recordServer('서버 시작');
    await log.flush();
    expect(await lines()).toEqual([a, { at: NOW, kind: 'server', sessionId: null, cwd: '', title: '서버', body: '서버 시작' }]);
  });

  it('one restart records one interrupted per session: a second within 10 s is skipped, later ones are kept', async () => {
    let now = NOW;
    const log = new EventLog(file, { now: () => now, titleOf: () => 'S' });
    await log.load();
    log.record({ type: 'turn_result', turnId: 't', sessionId: 's1', cwd: '/c', ok: false, text: '', badge: null, errorText: SHUTDOWN_ABORTED });
    now = NOW + 1000;
    log.record({ type: 'turn_notice', turnId: 't', sessionId: 's1', cwd: '/c', message: `${SHUTDOWN_CUT_NOTICE} 1개가 중단됨: a` });
    log.record({ type: 'turn_notice', turnId: 't', sessionId: 's2', cwd: '/c', message: `${SHUTDOWN_CUT_NOTICE} 1개가 중단됨: b` });
    await log.flush();
    expect((await lines()).map((e) => [e.sessionId, e.kind, e.at])).toEqual([['s1', 'interrupted', NOW], ['s2', 'interrupted', NOW + 1000]]);
    now = NOW + 11_000;
    log.record({ type: 'turn_notice', turnId: 't', sessionId: 's1', cwd: '/c', message: `${SHUTDOWN_CUT_NOTICE} 1개가 중단됨: c` });
    await log.flush();
    expect((await lines()).filter((e) => e.sessionId === 's1').map((e) => e.at)).toEqual([NOW, NOW + 11_000]);
  });
});

describe('selectEvent', () => {
  const titleOf = () => 'S';
  it('a turn cut by the server restart, or its background work, is interrupted', () => {
    expect(selectEvent({ type: 'turn_result', turnId: 't', sessionId: 's', cwd: '/c', ok: false, text: '', badge: null, errorText: SHUTDOWN_ABORTED }, titleOf, 1))
      .toMatchObject({ kind: 'interrupted', body: SHUTDOWN_ABORTED, sessionId: 's' });
    expect(selectEvent({ type: 'turn_notice', turnId: 't', sessionId: 's', cwd: '/c', message: `${SHUTDOWN_CUT_NOTICE} 1개가 중단됨: a` }, titleOf, 1))
      .toMatchObject({ kind: 'interrupted', sessionId: 's', cwd: '/c' });
    expect(selectEvent({ type: 'turn_notice', turnId: 't', sessionId: 's', cwd: '/c', message: '백그라운드 계속' }, titleOf, 1)).toBeNull();
  });

  it('a turn the user stopped is not a highlight (not a failure)', () => {
    expect(selectEvent({ type: 'turn_result', turnId: 't', sessionId: 's', cwd: '/c', ok: false, text: '', badge: null, errorText: ABORTED }, titleOf, 1)).toBeNull();
  });

  it('keeps the push kinds for cards and tasks', () => {
    expect(selectEvent({ type: 'task_done', turnId: 't', sessionId: 's', cwd: '/c', status: 'completed', summary: 'ok' } as never, titleOf, 1)).toMatchObject({ kind: 'task' });
  });

  it('a commander verdict is one highlight; a plain state broadcast is not', () => {
    const state = { status: 'waiting_human', hop: 2, maxTurns: 20, epoch: 1, goal: 'g', done: 'd', budget: { maxAutoTurns: 20, autoTurnsUsed: 2, maxTokens: 1, tokensUsed: 0, maxWallClockMs: 1, maxInternalRetries: 5, internalRetriesUsed: 0 } } as const;
    expect(selectEvent({ type: 'commander', sessionId: 's', state, lastVerdict: { verdict: 'human', reason: '배포 필요', atMs: 1 } }, titleOf, 1))
      .toMatchObject({ kind: 'commander', sessionId: 's', body: '사령탑 사람 필요 · 배포 필요' });
    expect(selectEvent({ type: 'commander', sessionId: 's', state }, titleOf, 1)).toBeNull();
  });
});
