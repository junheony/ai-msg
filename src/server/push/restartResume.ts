import fs from 'node:fs/promises';
import type { HighlightEvent } from '../../shared/highlights';
import type { SessionState } from '../turn/SessionState';
import type { WatchStore } from './BottleneckWatch';

/** Evidence of a cut older than this at start is left alone (the work has surely moved on, or the user is back). */
export const RESTART_RESUME_WINDOW_MS = 30 * 60_000;
/** The first booking fires this long after start (the server is listening by then), each next one RESTART_RESUME_GAP_MS later. */
export const RESTART_RESUME_DELAY_MS = 5_000;
export const RESTART_RESUME_GAP_MS = 15_000;
/** A session deck sent on after a restart is not sent on again by the next one within this long (unless the user sent to it since). */
export const RESTART_RESUME_REPEAT_MS = 12 * 3600_000;
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
    if (isRec(c) && c.cause === undefined && c.kind === undefined && typeof c.atMs === 'number' && c.atMs >= since && c.atMs <= o.now) add(st.sessionId, strings(c.tasks));
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
 * `restart-resumed.json`: by session, when deck last sent it on after a restart (the repeat guard). Missing or broken
 * reads as empty; entries older than RESTART_RESUME_REPEAT_MS are dropped.
 */
export async function readResumed(file: string, now: number): Promise<Map<string, number>> {
  const raw = await readActivitySnapshot(file);
  const out = new Map<string, number>();
  if (isRec(raw)) for (const [id, at] of Object.entries(raw)) if (typeof at === 'number' && now - at < RESTART_RESUME_REPEAT_MS) out.set(id, at);
  return out;
}

export async function writeResumed(file: string, resumed: Map<string, number>): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(resumed)), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * Books a 자동으로 이어가기 (SessionState.pendingRetry, hop 1) for each cut session, the first RESTART_RESUME_DELAY_MS from
 * now and each next RESTART_RESUME_GAP_MS later: BottleneckWatch.rearm arms it and fires it through ws's send path like a
 * limit retry — the same session, its own engine, account rules and permission mode, never wider; a start refused before
 * turn_started and a limit hit take the retry paths already there. Not with 자동으로 이어가기 off, nor for a session deck
 * does not know (or that is gone, e.g. trashed), a missing folder, or a commander that was active (handed to the person).
 * A booking already there stays the one booking (its message, hops and commander hop kept): only brought forward when
 * ours is sooner. Repeat guard (`resumed`, updated in place): a session sent on after the last restart and cut again
 * before the user sent to it is skipped once (its entry goes, so the restart after that sends it on again).
 */
export async function bookRestartResumes(o: {
  cut: CutSession[];
  store: Pick<WatchStore, 'get' | 'set'>;
  enabled: boolean;
  exists: (st: SessionState) => boolean;
  text: (tasks: string[]) => string;
  now: number;
  resumed: Map<string, number>;
  isDir?: (cwd: string) => Promise<boolean>;
}): Promise<{ booked: number; skipped: string[] }> {
  const skipped: string[] = [];
  if (!o.enabled) return { booked: 0, skipped };
  const isDir = o.isDir ?? isDirectory;
  let n = 0;
  for (const c of o.cut) {
    const known = o.store.get(c.sessionId);
    if (!known || !o.exists(known)) continue;
    if (known.commander && COMMANDER_ACTIVE.includes(known.commander.status)) continue;
    if (!(await isDir(known.cwd))) continue;
    if (o.resumed.has(c.sessionId)) { o.resumed.delete(c.sessionId); skipped.push(c.sessionId); continue; }
    const st = o.store.get(c.sessionId) ?? known;
    const atMs = o.now + RESTART_RESUME_DELAY_MS + n * RESTART_RESUME_GAP_MS;
    const r = st.pendingRetry;
    if (r && r.atMs <= atMs) continue;
    await o.store.set({ ...st, pendingRetry: r ? { ...r, atMs } : { text: o.text(c.tasks), atMs, hops: 1 } });
    o.resumed.set(c.sessionId, o.now);
    n++;
  }
  return { booked: n, skipped };
}
