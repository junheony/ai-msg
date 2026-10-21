/**
 * 백그라운드 작업 (`/bg`, 작업으로): work started as its own new session in the same folder, so the chat it came from
 * stays free. Shared shapes and pure helpers (server registry, UI cards).
 */

export const TASK_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskInfo = {
  taskId: string;
  /** The chat the task was started from (null = a new chat with no id yet: matched by cwd). */
  fromSessionId: string | null;
  cwd: string;
  /** Short label (the prompt's first line). */
  title: string;
  status: TaskStatus;
  /** The task's own session, once the engine named it. */
  sessionId: string | null;
  createdAt: number;
  endedAt?: number;
  /** First line of the result (or of the error). */
  line?: string;
  /** Running and stopped on a permission / question card in its session (승인 대기). */
  waiting?: boolean;
};

export const TASK_CANCELED_LINE = '취소됨';

/** Parallel tasks running at once before new ones wait (설정 `taskSoftCap`). */
export const DEFAULT_TASK_SOFT_CAP = 3;
export const TASK_SOFT_CAP_MIN = 1;
export const TASK_SOFT_CAP_MAX = 10;
/** Finished tasks kept (and shown) at most. */
export const TASKS_KEEP = 50;
/** Tasks waiting for a slot at most: each holds its full prompt in memory until it starts. */
export const TASKS_QUEUED_MAX = 20;
export const TASK_TITLE_MAX = 60;
export const TASK_LINE_MAX = 200;

/** `/bg <text>` in the composer: the task text, or null when the message is not one. */
export function parseBgCommand(text: string): string | null {
  const m = /^\/bg(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const rest = (m[1] ?? '').trim();
  return rest ? rest : null;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The task's label: the prompt's first non-empty line. */
export function taskTitle(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '작업';
  return clip(first, TASK_TITLE_MAX);
}

/** First non-empty prose line of a result (markdown heading / bullet marks dropped), clipped. */
export function taskLine(text: string | null | undefined): string {
  for (const raw of (text ?? '').replace(/```[\s\S]*?(?:```|$)/g, '').split('\n')) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '').trim();
    if (line) return clip(line, TASK_LINE_MAX);
  }
  return '';
}

/** Tasks shown in a pane: started from its session (a new chat: same folder, no id). Newest first. */
export function tasksForPane(tasks: readonly TaskInfo[], sessionId: string | null, cwd: string | null): TaskInfo[] {
  return tasks
    .filter((t) => (sessionId ? t.fromSessionId === sessionId : t.fromSessionId === null && cwd !== null && t.cwd === cwd))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function clampTaskCap(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= TASK_SOFT_CAP_MIN && v <= TASK_SOFT_CAP_MAX ? v : DEFAULT_TASK_SOFT_CAP;
}
