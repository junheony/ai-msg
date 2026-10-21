import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionActivity } from '../../shared/protocol';
import type { TaskInfo } from '../../shared/tasks';
import type { PendingPermission, PendingQuestion } from '../state';
import { ActivitySheet, type ActivitySheetProps, type ServerUpdateInfo, type WorkRow } from './ActivitySheet';

export type ActivityLevel = 'down' | 'waiting' | 'server' | 'running' | 'bg' | 'idle';
export type ActivitySummary = { waiting: number; running: number; bg: number; level: ActivityLevel };

/**
 * The dot's counts, straight from app state (no server message of its own): 승인 대기 = every permission card and
 * question whatever session (a pane's or none) plus `/bg` tasks stopped on a card whose session has none listed;
 * 실행 중 / 백그라운드 = sessions. The dot shows one state, the first that holds: 끊김 → 승인 대기 → 재시작/업데이트 대기
 * → 실행 중 → 백그라운드 → 없음.
 */
export function activitySummary({ pending, questions, tasks = [], activity, connected, serverWaiting }: {
  pending: { sessionId: string | null }[];
  questions: { sessionId: string | null }[];
  tasks?: TaskInfo[];
  activity: SessionActivity[];
  connected: boolean;
  /** Draining, or a server code update waiting for a restart. */
  serverWaiting: boolean;
}): ActivitySummary {
  const cardSessions = new Set([...pending, ...questions].map((c) => c.sessionId).filter(Boolean));
  const taskWaits = tasks.filter((t) => t.status === 'running' && t.waiting && !(t.sessionId && cardSessions.has(t.sessionId))).length;
  const waiting = pending.length + questions.length + taskWaits;
  const running = activity.filter((a) => a.running).length;
  const bg = activity.filter((a) => a.bg > 0).length;
  const level: ActivityLevel = !connected ? 'down' : waiting > 0 ? 'waiting' : serverWaiting ? 'server' : running > 0 ? 'running' : bg > 0 ? 'bg' : 'idle';
  return { waiting, running, bg, level };
}

/** The dot's accessible name: 활동 · 승인 대기 2 · 실행 중 1 (zeros left out). */
export function activityLabel(s: ActivitySummary): string {
  const parts = [
    s.level === 'down' ? '연결 끊김' : null,
    s.waiting ? `승인 대기 ${s.waiting}` : null,
    s.running ? `실행 중 ${s.running}` : null,
    s.bg ? `백그라운드 ${s.bg}` : null,
    s.level === 'server' ? '서버 재시작 대기' : null,
  ].filter(Boolean);
  return ['활동', ...parts].join(' · ');
}

/** How often the server update check asks whether server code changed (also once on every connect). */
const UPDATE_POLL_MS = 60_000;

/**
 * GET /api/server-update on connect and every minute: server code changed since the server started (and whether a
 * supervisor will start it again). Disconnected → forgotten (what the old server said no longer holds).
 */
export function useServerUpdate(ready: boolean, enabled: boolean, fetchFn: typeof fetch = fetch): ServerUpdateInfo | null {
  const [info, setInfo] = useState<ServerUpdateInfo | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetchFn('/api/server-update');
      if (!r.ok) return;
      const j = (await r.json()) as { changedFiles?: unknown; supervised?: unknown };
      setInfo({ changedFiles: typeof j.changedFiles === 'number' ? j.changedFiles : 0, supervised: j.supervised === true });
    } catch { /* offline: keep what is known */ }
  }, [fetchFn]);
  useEffect(() => {
    if (!ready || !enabled) { setInfo(null); return; }
    void load();
    const t = setInterval(() => void load(), UPDATE_POLL_MS);
    return () => clearInterval(t);
  }, [ready, enabled, load]);
  return info;
}

/** How often the 하이라이트 count is asked for, and how long after a turn ends. */
const HL_POLL_MS = 5 * 60_000;
const HL_AFTER_TURN_MS = 2_000;

/**
 * 하이라이트 N: the last 24 hours' outcomes (GET /api/highlights?hours=24 minus background task events — a session's
 * tasks would swamp the number), asked once connected, every 5 minutes, and shortly after a turn ends. A failed ask
 * keeps the number; only the newest answer lands.
 */
export function useHighlightCount(ready: boolean, enabled: boolean, running: number, fetchFn: typeof fetch = fetch): number | null {
  const [count, setCount] = useState<number | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetchFn('/api/highlights?hours=24');
      if (!r.ok) return;
      const list = ((await r.json()) as { events?: unknown }).events;
      if (mine !== seq.current || !Array.isArray(list)) return;
      setCount(list.filter((e) => !(e && typeof e === 'object' && (e as { kind?: unknown }).kind === 'task')).length);
    } catch { /* offline or an older server: keep the number */ }
  }, [fetchFn]);
  useEffect(() => {
    if (!ready || !enabled) return;
    void load();
    const t = setInterval(() => void load(), HL_POLL_MS);
    return () => clearInterval(t);
  }, [ready, enabled, load]);
  const prevRunning = useRef(running);
  const afterTurn = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const was = prevRunning.current;
    prevRunning.current = running;
    if (!enabled || running >= was) return;
    // Several turns ending together ask once.
    if (afterTurn.current) clearTimeout(afterTurn.current);
    afterTurn.current = setTimeout(() => { afterTurn.current = null; void load(); }, HL_AFTER_TURN_MS);
  }, [running, enabled, load]);
  useEffect(() => () => { if (afterTurn.current) clearTimeout(afterTurn.current); }, []);
  return count;
}

/** A one-time notice the app shows as a toast (and reads out): a new 승인 대기 elsewhere, or 재시작됨. */
export type ActivityAlert = { text: string; open?: () => void };

/**
 * How long after this tab first connects arriving cards count as the snapshot of what already waited (a reload): shown
 * on the dot and in the sheet, never alerted. The server sends them right behind hello, as separate messages.
 */
export const ALERT_SEED_MS = 1_000;

const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * 활동 점: the top bar's one way to everything that runs or waits (on a phone the only one). A dot whose colour says the
 * state, a 승인 대기 count badge (pulsing warn; still under reduced motion), ↻ while a restart / update waits. A click
 * opens the 활동 sheet. A card arriving for a session not on screen raises one alert (toast + live line).
 */
export function ActivityButton({ ready, serverUpdate, highlights, visibleSessions, onAlert, fetchFn = fetch, ...sheet }: Omit<ActivitySheetProps, 'onClose' | 'lastWorkAt' | 'highlights' | 'server' | 'tasks'> & {
  ready: boolean;
  tasks?: TaskInfo[];
  /** The server has the 서버 업데이트 check / highlights. */
  serverUpdate: boolean;
  highlights: boolean;
  /** Sessions the user sees right now: their cards raise no alert. */
  visibleSessions: (string | null)[];
  onAlert: (a: ActivityAlert) => void;
  server: Omit<ActivitySheetProps['server'], 'update'>;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const update = useServerUpdate(ready, serverUpdate, fetchFn);
  const running = sheet.activity.filter((a) => a.running).length;
  const hlCount = useHighlightCount(ready, highlights, running, fetchFn);
  const tasks = sheet.tasks ?? [];
  const updateWaiting = update?.supervised === true && update.changedFiles > 0;
  const summary = activitySummary({ pending: sheet.pending, questions: sheet.questions, tasks, activity: sheet.activity, connected: sheet.connected, serverWaiting: sheet.server.draining || updateWaiting });
  const label = activityLabel(summary);

  // When the work this tab watched ended (busy → idle); unknown after a reload.
  const busy = summary.waiting + running + summary.bg;
  const [lastWorkAt, setLastWorkAt] = useState<number | null>(null);
  const prevBusy = useRef(busy);
  useEffect(() => {
    const was = prevBusy.current;
    prevBusy.current = busy;
    if (busy === 0 && was > 0) setLastWorkAt(Date.now());
  }, [busy]);

  // One alert per card, for a session that is not on screen (a new chat's card belongs to a pane: never). Cards that
  // already waited when this tab first connected are only shown (see ALERT_SEED_MS); later ones alert.
  const alerted = useRef(new Set<string>());
  const seeding = useRef<boolean | null>(null);
  useEffect(() => {
    if (!ready || seeding.current !== null) return;
    seeding.current = true;
    const t = setTimeout(() => { seeding.current = false; }, ALERT_SEED_MS);
    return () => { clearTimeout(t); if (seeding.current) seeding.current = null; };
  }, [ready]);
  const alert = useRef(onAlert);
  alert.current = onAlert;
  const titleOf = useRef(sheet.titleOf);
  titleOf.current = sheet.titleOf;
  const openRow = useRef(sheet.onOpen);
  openRow.current = sheet.onOpen;
  const shown = visibleSessions.join('\n');
  useEffect(() => {
    const visible = new Set(shown.split('\n'));
    const cards = [...sheet.pending, ...sheet.questions];
    // Answered / gone requests leave the set (request ids are never reused).
    const live = new Set(cards.map((c) => c.requestId));
    for (const id of alerted.current) if (!live.has(id)) alerted.current.delete(id);
    for (const c of cards) {
      if (alerted.current.has(c.requestId)) continue;
      alerted.current.add(c.requestId);
      if (seeding.current !== false) continue;
      const sid = c.sessionId;
      if (!sid || visible.has(sid)) continue;
      const title = titleOf.current(sid, c.cwd);
      alert.current({ text: `${title} · 승인 대기`, open: () => openRow.current({ key: sid, sessionId: sid, turnId: c.turnId, title, cwd: c.cwd, status: '승인 대기', waiting: true }) });
    }
  }, [sheet.pending, sheet.questions, shown, ready]);

  // 재시작됨: one toast when this tab sees the server come back as a new process (not for one restored by a reload).
  const lastRestart = useRef(sheet.server.restartedAt);
  useEffect(() => {
    const at = sheet.server.restartedAt;
    if (at !== null && at !== lastRestart.current) alert.current({ text: `서버가 다시 시작됐어요 · ${hhmm(at)}` });
    lastRestart.current = at;
  }, [sheet.server.restartedAt]);

  return (
    <>
      <button
        ref={btn} type="button" className={`activity-btn lvl-${summary.level}`} data-testid="activity-btn" aria-label={label} title={label}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}
      >
        <span className="activity-dot" aria-hidden="true" />
        {summary.level === 'server' && <span className="activity-ring" aria-hidden="true">↻</span>}
        {summary.waiting > 0 && <span className="activity-badge" data-testid="activity-badge" aria-hidden="true">{summary.waiting > 99 ? '99+' : summary.waiting}</span>}
      </button>
      {open && (
        <ActivitySheet
          {...sheet} tasks={tasks} fetchFn={fetchFn} onClose={() => setOpen(false)} lastWorkAt={lastWorkAt}
          {...(highlights ? { highlights: hlCount } : {})}
          // 하이라이트 opens as this sheet closes: its opener is the dot, so closing it lands back here.
          {...(sheet.onOpenHighlights ? { onOpenHighlights: () => { btn.current?.focus(); sheet.onOpenHighlights!(); } } : {})}
          server={{ ...sheet.server, update }}
        />
      )}
    </>
  );
}
