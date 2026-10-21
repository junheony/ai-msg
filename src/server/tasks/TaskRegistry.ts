import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TASKS_KEEP, taskLine, taskTitle, type TaskInfo } from '../../shared/tasks';

export const RESTART_CUT_LINE = '서버가 다시 시작되어 중단됨';

/**
 * 백그라운드 작업 list (`tasks.json` in the config dir): which tasks run, wait for a slot (soft cap) or ended, and the
 * session each one opened. Pure bookkeeping — ws starts the turns and tells this what happened. Writes are serialized,
 * atomic (tmp + rename) and 0600. A task left running or queued by a previous process is marked failed on load.
 */
export class TaskRegistry {
  private tasks: TaskInfo[] = [];
  private writing: Promise<void> = Promise.resolve();
  /** Turn id of each running task's first turn → task id. */
  private readonly byTurn = new Map<string, string>();

  constructor(private readonly file: string | null, private readonly now: () => number = () => Date.now()) {}

  async load(): Promise<void> {
    if (!this.file) return;
    let raw: unknown = null;
    try { raw = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { raw = null; }
    const list = Array.isArray(raw) ? raw.filter(isTask) : [];
    let cut = false;
    this.tasks = list.map((t) => {
      if (t.status !== 'running' && t.status !== 'queued') return t;
      cut = true;
      return { ...t, status: 'failed' as const, endedAt: this.now(), line: RESTART_CUT_LINE };
    }).slice(-TASKS_KEEP);
    if (cut) await this.save();
  }

  list(): TaskInfo[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  get(taskId: string): TaskInfo | null {
    const t = this.tasks.find((x) => x.taskId === taskId);
    return t ? { ...t } : null;
  }

  running(): number {
    return this.tasks.filter((t) => t.status === 'running').length;
  }

  queued(): number {
    return this.tasks.filter((t) => t.status === 'queued').length;
  }

  /** The oldest task waiting for a slot. */
  nextQueued(): TaskInfo | null {
    const t = this.tasks.find((x) => x.status === 'queued');
    return t ? { ...t } : null;
  }

  /** A new task: running when a slot is free under `cap`, else queued. */
  create(a: { fromSessionId: string | null; cwd: string; text: string }, cap: number): TaskInfo {
    const t: TaskInfo = {
      taskId: randomUUID(), fromSessionId: a.fromSessionId, cwd: a.cwd, title: taskTitle(a.text),
      status: this.running() < cap ? 'running' : 'queued', sessionId: null, createdAt: this.now(),
    };
    this.tasks.push(t);
    this.trim();
    void this.save();
    return { ...t };
  }

  /** A queued task got its slot. */
  start(taskId: string): void {
    this.patch(taskId, { status: 'running' });
  }

  /** The task's first turn started (its id) — results of that turn end the task. */
  turnStarted(taskId: string, turnId: string): void {
    this.byTurn.set(turnId, taskId);
  }

  taskOfTurn(turnId: string): string | null {
    return this.byTurn.get(turnId) ?? null;
  }

  /** The task's session got its id. */
  sessionKnown(taskId: string, sessionId: string): void {
    const t = this.tasks.find((x) => x.taskId === taskId);
    if (t && t.sessionId !== sessionId) this.patch(taskId, { sessionId });
  }

  /** The task ended (its first turn's result, or a refusal before it started). Ended tasks stay ended. */
  finish(taskId: string, r: { ok: boolean; text: string | null; sessionId?: string | null }): TaskInfo | null {
    const t = this.tasks.find((x) => x.taskId === taskId);
    if (!t || t.status === 'done' || t.status === 'failed') return null;
    // byTurn keeps the turn: PushNotifier asks about it after the result (isTaskTurn); bounded below.
    while (this.byTurn.size > TASKS_KEEP * 4) this.byTurn.delete(this.byTurn.keys().next().value!);
    this.patch(taskId, { status: r.ok ? 'done' : 'failed', endedAt: this.now(), line: taskLine(r.text) || (r.ok ? '완료' : '실패'), ...(r.sessionId ? { sessionId: r.sessionId } : {}) });
    return this.get(taskId);
  }

  /** 닫기 on a card: an ended task is forgotten (a running one stays). */
  dismiss(taskId: string): boolean {
    const i = this.tasks.findIndex((x) => x.taskId === taskId && (x.status === 'done' || x.status === 'failed'));
    if (i < 0) return false;
    this.tasks.splice(i, 1);
    void this.save();
    return true;
  }

  /** Saved state settled (tests). */
  flushed(): Promise<void> {
    return this.writing;
  }

  private patch(taskId: string, p: Partial<TaskInfo>): void {
    this.tasks = this.tasks.map((t) => (t.taskId === taskId ? { ...t, ...p } : t));
    void this.save();
  }

  /** Ended tasks beyond TASKS_KEEP go, oldest first; running / queued ones are never dropped. */
  private trim(): void {
    let extra = this.tasks.length - TASKS_KEEP;
    if (extra <= 0) return;
    this.tasks = this.tasks.filter((t) => {
      if (extra > 0 && (t.status === 'done' || t.status === 'failed')) { extra--; return false; }
      return true;
    });
  }

  private save(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const data = JSON.stringify(this.tasks, null, 1);
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.rename(tmp, file);
    }).catch((err: unknown) => console.error('deck: tasks.json write failed', err instanceof Error ? err.message : err));
    return this.writing;
  }
}

function isTask(v: unknown): v is TaskInfo {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return typeof t.taskId === 'string' && typeof t.cwd === 'string' && typeof t.title === 'string' && typeof t.createdAt === 'number'
    && (t.fromSessionId === null || typeof t.fromSessionId === 'string') && (t.sessionId === null || typeof t.sessionId === 'string')
    && (t.status === 'queued' || t.status === 'running' || t.status === 'done' || t.status === 'failed');
}
