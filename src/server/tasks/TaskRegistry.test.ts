import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TASKS_KEEP } from '../../shared/tasks';
import { RESTART_CUT_LINE, TaskRegistry } from './TaskRegistry';

const dir = () => fs.mkdtemp(path.join(os.tmpdir(), 'deck-tasks-'));

describe('TaskRegistry', () => {
  it('runs under the cap, queues above it, ends once, and saves 0600', async () => {
    const file = path.join(await dir(), 'tasks.json');
    const r = new TaskRegistry(file, () => 1000);
    const a = r.create({ fromSessionId: 's', cwd: '/w', text: '첫 작업\n자세히' }, 1);
    const b = r.create({ fromSessionId: 's', cwd: '/w', text: '둘째' }, 1);
    expect([a.status, b.status, a.title]).toEqual(['running', 'queued', '첫 작업']);
    expect(r.running()).toBe(1);
    expect(r.nextQueued()?.taskId).toBe(b.taskId);
    r.turnStarted(a.taskId, 'turn-a');
    r.sessionKnown(a.taskId, 'sess-a');
    const done = r.finish(a.taskId, { ok: true, text: '# 끝\n본문' });
    expect(done).toMatchObject({ status: 'done', line: '끝', sessionId: 'sess-a', endedAt: 1000 });
    expect(r.finish(a.taskId, { ok: false, text: 'x' })).toBeNull();
    expect(r.taskOfTurn('turn-a')).toBe(a.taskId);
    r.start(b.taskId);
    expect(r.running()).toBe(1);
    expect(r.dismiss(b.taskId)).toBe(false);
    expect(r.dismiss(a.taskId)).toBe(true);
    await r.flushed();
    const st = await fs.stat(file);
    expect(st.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).map((x: { taskId: string }) => x.taskId)).toEqual([b.taskId]);
  });
  it('marks tasks a previous process left running or queued as failed on load', async () => {
    const file = path.join(await dir(), 'tasks.json');
    await fs.writeFile(file, JSON.stringify([
      { taskId: '1', fromSessionId: null, cwd: '/w', title: 'a', status: 'running', sessionId: 's', createdAt: 1 },
      { taskId: '2', fromSessionId: null, cwd: '/w', title: 'b', status: 'done', sessionId: 's', createdAt: 2, line: 'ok' },
      { junk: true },
    ]));
    const r = new TaskRegistry(file, () => 5);
    await r.load();
    expect(r.list().map((t) => [t.taskId, t.status, t.line])).toEqual([['1', 'failed', RESTART_CUT_LINE], ['2', 'done', 'ok']]);
  });
  it('keeps at most TASKS_KEEP, dropping ended ones first', () => {
    const r = new TaskRegistry(null);
    const first = r.create({ fromSessionId: null, cwd: '/w', text: 'keep running' }, 100);
    for (let i = 0; i < TASKS_KEEP + 5; i++) { const t = r.create({ fromSessionId: null, cwd: '/w', text: `t${i}` }, 100); r.finish(t.taskId, { ok: true, text: 'x' }); }
    expect(r.list()).toHaveLength(TASKS_KEEP);
    expect(r.get(first.taskId)?.status).toBe('running');
  });
  it('removes only a queued task; 승인 대기 is set on a running one and dropped when it ends', () => {
    const r = new TaskRegistry(null);
    const a = r.create({ fromSessionId: null, cwd: '/w', text: 'a' }, 1);
    const b = r.create({ fromSessionId: null, cwd: '/w', text: 'b' }, 1);
    expect(r.removeQueued(a.taskId)).toBe(false);
    expect(r.setWaiting(b.taskId, true)).toBe(false);
    expect(r.removeQueued(b.taskId)).toBe(true);
    expect(r.get(b.taskId)).toBeNull();
    expect(r.setWaiting(a.taskId, true)).toBe(true);
    expect(r.setWaiting(a.taskId, true)).toBe(false);
    expect(r.get(a.taskId)?.waiting).toBe(true);
    expect(r.setWaiting(a.taskId, false)).toBe(true);
    expect(r.get(a.taskId)).not.toHaveProperty('waiting');
    r.setWaiting(a.taskId, true);
    expect(r.finish(a.taskId, { ok: false, text: '취소됨' })).not.toHaveProperty('waiting');
  });
});
