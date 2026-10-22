import fs from 'node:fs/promises';
import type { HighlightEvent } from '../../shared/highlights';
import type { SessionState } from '../turn/SessionState';
import type { WatchStore } from './BottleneckWatch';

/** Evidence of a cut older than this at start is left alone (the work has surely moved on, or the user is back). */
export const RESTART_RESUME_WINDOW_MS = 30 * 60_000;
/** The booking fires this long after start: the server is listening by then. */
export const RESTART_RESUME_DELAY_MS = 5_000;
const TASKS_MAX = 10;
const TASK_LEN = 80;
/** A commander in these states at start is handed to the person (Commander.restore): no automatic turn for it. */
const COMMANDER_ACTIVE = ['armed', 'sending', 'running', 'judging'];

export type CutSession = { sessionId: string; tasks: string[] };

/** `activity.json` as the last server left it (read before this server writes its own), or null. */
export async function readActivitySnapshot(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The sessions the server run that just ended left cut (pure). Three traces, any of which may be missing:
 * - its `activity.json` (another pid, written within the window): sessions running a turn or holding background work.
 *   A crash or kill leaves it; an ordinary shutdown deletes it (ws close()), so the two below cover that case.
 * - the event log's restart cuts ('interrupted': a turn ended by the shutdown, or its background work cut).
 * - SessionState.interrupted without a cause: the background tasks the shutdown cut, with their names.
 * Only traces since the event log's last server event (that run's start or drain) and within the window count: once
 * this server has logged its own start, the same traces are never taken again on the next restart.
 */
export function cutSessions(o: { activity: unknown; events: HighlightEvent[]; states: SessionState[]; pid: number; now: number }): CutSession[] {
  const lastServer = o.events.reduce((m, e) => (e.kind === 'server' && e.at <= o.now ? Math.max(m, e.at) : m), 0);
  const since = Math.max(o.now - RESTART_RESUME_WINDOW_MS, lastServer);
  const out = new Map<string, Set<string>>();
  const add = (sessionId: string, tasks: string[]) => {
    const set = out.get(sessionId) ?? new Set<string>();
    for (const t of tasks) set.add(t.slice(0, TASK_LEN));
    out.set(sessionId, set);
  };
  const a = o.activity;
  if (isRec(a) && typeof a.pid === 'number' && a.pid !== o.pid && typeof a.updatedAt === 'string' && Array.isArray(a.sessions)) {
    const at = Date.parse(a.updatedAt);
    if (Number.isFinite(at) && at >= since && at <= o.now) {
      for (const s of a.sessions) {
        if (!isRec(s) || typeof s.sessionId !== 'string' || !s.sessionId) continue;
        const bg = typeof s.bg === 'number' ? s.bg : 0;
        if (s.running === true || bg > 0) add(s.sessionId, strings(s.tasks));
      }
    }
  }
  for (const e of [...o.events].sort((x, y) => x.at - y.at)) {
    if (e.kind === 'interrupted' && e.sessionId && e.at >= since && e.at <= o.now) add(e.sessionId, []);
  }
  for (const st of o.states) {
    const c = st.interrupted;
    if (c && c.cause === undefined && c.kind === undefined && c.atMs >= since && c.atMs <= o.now) add(st.sessionId, c.tasks);
  }
  return [...out].map(([sessionId, tasks]) => ({ sessionId, tasks: [...tasks].slice(0, TASKS_MAX) }));
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Books a 자동으로 이어가기 (SessionState.pendingRetry, hop 1) for each cut session, RESTART_RESUME_DELAY_MS from now:
 * BottleneckWatch.rearm arms it and fires it through ws's send path like a limit retry — the same session, its own
 * engine, account rules and permission mode, never wider; a start refused before turn_started and a limit hit take the
 * retry paths already there. Not with 자동으로 이어가기 off, nor for a session deck does not know (or that is gone, e.g.
 * trashed), a missing folder, or a commander that was active (handed to the person). A booking already there that is
 * due no later stays (one booking per session); a later one is replaced. Returns how many were booked.
 */
export async function bookRestartResumes(o: {
  cut: CutSession[];
  store: Pick<WatchStore, 'get' | 'set'>;
  enabled: boolean;
  exists: (st: SessionState) => boolean;
  text: (tasks: string[]) => string;
  now: number;
  isDir?: (cwd: string) => Promise<boolean>;
}): Promise<number> {
  if (!o.enabled) return 0;
  const isDir = o.isDir ?? isDirectory;
  const atMs = o.now + RESTART_RESUME_DELAY_MS;
  let n = 0;
  for (const c of o.cut) {
    const st = o.store.get(c.sessionId);
    if (!st || !o.exists(st)) continue;
    if (st.commander && COMMANDER_ACTIVE.includes(st.commander.status)) continue;
    if (st.pendingRetry && st.pendingRetry.atMs <= atMs) continue;
    if (!(await isDir(st.cwd))) continue;
    await o.store.set({ ...st, pendingRetry: { text: o.text(c.tasks), atMs, hops: 1 } });
    n++;
  }
  return n;
}
