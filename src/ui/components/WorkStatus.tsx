import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionActivity } from '../../shared/protocol';

/** A permission card or question waiting for an answer: its session (null = a new chat before its id is known). */
export type WaitingCard = { sessionId: string | null; cwd: string; turnId: string };

/** One row of the 작업 현황 popover: what it is doing, 승인 대기 first (it needs the user). */
export type WorkRow = { key: string; sessionId: string | null; turnId: string | null; title: string; cwd: string; status: string; waiting: boolean };

/** A waiting card's session key: its id, else (a new chat) its turn — two cards of one session count once. */
const waitKey = (c: WaitingCard) => c.sessionId ?? `turn:${c.turnId}`;

/**
 * The chip's counts, each session once: 승인 대기 wins — a session that runs (or holds background work) while a card of
 * it waits counts only under 승인 대기.
 */
export function workCounts(activity: SessionActivity[], waiting: WaitingCard[]): { running: number; bg: number; waiting: number } {
  const keys = new Set(waiting.map(waitKey));
  const rest = activity.filter((a) => !keys.has(a.sessionId));
  return { running: rest.filter((a) => a.running).length, bg: rest.filter((a) => !a.running && a.bg > 0).length, waiting: keys.size };
}

const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** The idle chip: 한가함, with when the last work ended if this tab saw it end (a reload forgets it). */
export function idleLabel(lastWorkAt: number | null): string {
  return lastWorkAt === null ? '한가함' : `한가함 · ${hhmm(lastWorkAt)} 까지 작업`;
}

/** The popover's rows: every session with a card waiting (a new chat as 새 대화), then those running or in background. */
export function workRows(activity: SessionActivity[], waiting: WaitingCard[], titleOf: (sessionId: string, cwd: string | null) => string): WorkRow[] {
  const rows: WorkRow[] = [];
  const seen = new Set<string>();
  for (const c of waiting) {
    const key = waitKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    const cwd = activity.find((a) => a.sessionId === c.sessionId)?.cwd ?? c.cwd;
    rows.push({ key, sessionId: c.sessionId, turnId: c.turnId, title: c.sessionId ? titleOf(c.sessionId, cwd) : '새 대화', cwd, status: '승인 대기', waiting: true });
  }
  for (const a of activity) {
    if (seen.has(a.sessionId) || (!a.running && a.bg <= 0)) continue;
    seen.add(a.sessionId);
    rows.push({ key: a.sessionId, sessionId: a.sessionId, turnId: null, title: titleOf(a.sessionId, a.cwd), cwd: a.cwd, status: a.running ? '실행 중' : `백그라운드 ${a.bg}`, waiting: false });
  }
  return rows;
}

/**
 * 작업 현황 chip: 실행 중 N · 백그라운드 M · 승인 대기 K, in sessions (zeros left out; nothing at all → 한가함). A click
 * lists the sessions; a row opens its session. Narrow top bars show the short form (▶N · ⏸M · !K, CSS).
 */
export function WorkStatus({ activity, waiting, titleOf, onOpen, onOpenHighlights, onNewChat }: {
  activity: SessionActivity[];
  /** Permission cards and questions waiting for an answer. */
  waiting: WaitingCard[];
  titleOf: (sessionId: string, cwd: string | null) => string;
  onOpen: (row: WorkRow) => void;
  /** The popover's last row: 하이라이트 보기 →. */
  onOpenHighlights?: () => void;
  /** The idle popover's 새 대화 row. */
  onNewChat?: () => void;
}) {
  const [pop, setPop] = useState<{ right: number; y: number } | null>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const counts = workCounts(activity, waiting);
  const total = counts.running + counts.bg + counts.waiting;
  // When the work this tab watched ended (busy → idle); unknown after a reload.
  const [lastWorkAt, setLastWorkAt] = useState<number | null>(null);
  const prevTotal = useRef(total);
  useEffect(() => {
    if (!pop) return;
    const close = () => setPop(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPop(null); chip.current?.focus(); } };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); document.removeEventListener('keydown', onKey); };
  }, [pop]);
  // Everything finished while the list was open: the chip goes, and the list (and its listeners) with it.
  useEffect(() => {
    const was = prevTotal.current;
    prevTotal.current = total;
    if (total === 0 && was > 0) { setPop(null); setLastWorkAt(Date.now()); }
  }, [total]);
  const idle = total === 0;
  const long = idle ? idleLabel(lastWorkAt) : [counts.running ? `실행 중 ${counts.running}` : null, counts.bg ? `백그라운드 ${counts.bg}` : null].filter(Boolean).join(' · ');
  const short = idle ? '한가함' : [counts.running ? `▶${counts.running}` : null, counts.bg ? `⏸${counts.bg}` : null].filter(Boolean).join(' · ');
  const label = [long, counts.waiting ? `승인 대기 ${counts.waiting}` : ''].filter(Boolean).join(' · ');
  const rows = pop ? workRows(activity, waiting, titleOf) : [];
  return (
    <>
      <button
        ref={chip} type="button" className={`top-chip work-chip${idle ? ' idle' : ''}`} data-testid="work-chip" aria-expanded={!!pop} aria-haspopup="dialog" aria-label={label}
        title={idle ? `작업 현황 (${label}) — 눌러서 열기` : `작업 현황 (${label}) — 눌러서 세션 목록 · 승인 대기인 세션은 실행 중·백그라운드에 세지 않습니다`}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          // Anchored by its right edge under the chip (the chip sits at the bar's right end): it never runs off the right.
          setPop(pop ? null : { right: Math.max(8, window.innerWidth - r.right), y: r.bottom + 6 });
        }}
      >
        <span className="chip-long">
          {long}
          {counts.waiting > 0 && <>{long ? ' · ' : ''}<b className="work-wait">승인 대기 {counts.waiting}</b></>}
        </span>
        <span className="chip-short" aria-hidden="true">
          {short}
          {counts.waiting > 0 && <>{short ? ' · ' : ''}<b className="work-wait">!{counts.waiting}</b></>}
        </span>
      </button>
      {pop && (
        <div className="usage-pop work-pop" role="dialog" aria-label="작업 현황" style={{ right: pop.right, top: pop.y }} onClick={(e) => e.stopPropagation()}>
          <div className="usage-pop-title">작업 현황</div>
          {rows.map((r) => (
            <button type="button" key={r.key} className="usage-pop-row work-row" onClick={() => { setPop(null); onOpen(r); }}>
              <span className="work-title">{r.title}</span>
              <b className={r.waiting ? 'work-wait' : ''}>{r.status}</b>
            </button>
          ))}
          {rows.length === 0 && <div className="usage-pop-row hint">지금 실행 중인 작업이 없어요</div>}
          {rows.length === 0 && onNewChat && <button type="button" className="usage-pop-row work-row" onClick={() => { setPop(null); onNewChat(); }}>새 대화</button>}
          {onOpenHighlights && <button type="button" className="usage-pop-row work-highlights" onClick={() => { setPop(null); onOpenHighlights(); }}>하이라이트 보기 →</button>}
        </div>
      )}
    </>
  );
}

/** 서버 · 3시간째: how long the server process has been up (분 / 시간 / 일). */
export function uptimeLabel(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return '서버 · 방금 시작';
  if (min < 60) return `서버 · ${min}분째`;
  const h = Math.floor(min / 60);
  return h < 24 ? `서버 · ${h}시간째` : `서버 · ${Math.floor(h / 24)}일째`;
}

/**
 * 서버 chip: 재시작 대기 중 while draining, 재시작됨 HH:MM right after a restart (a click closes it), else how long the
 * server has been up. An older server (no start time) shows only the draining form.
 */
export function ServerChip({ startedAt, restartedAt, draining, busy, onDismissRestart, now: fixedNow }: {
  startedAt: number | null;
  restartedAt: number | null;
  draining: boolean;
  /** Sessions still running or holding background work (what a drain waits for). */
  busy: number;
  onDismissRestart: () => void;
  now?: number;
}) {
  const [, setTick] = useState(0);
  // Re-render each minute (the label shows minute steps); the time itself is read at render, so a new start shows right.
  useEffect(() => {
    if (startedAt === null || fixedNow !== undefined) return;
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [startedAt, fixedNow]);
  if (draining) {
    return (
      <span className="top-chip warn server-chip" role="status" title="서버가 재시작을 준비 중입니다 — 돌고 있는 작업이 끝나면 다시 시작합니다">
        <span className="chip-long">{busy > 0 ? `재시작 대기 중 · 작업 ${busy}개 기다림` : '재시작 중…'}</span>
        <span className="chip-short" aria-hidden="true">{busy > 0 ? `재시작 대기 · ${busy}` : '재시작 중…'}</span>
      </span>
    );
  }
  if (restartedAt !== null) return <button type="button" className="top-chip server-chip" onClick={onDismissRestart} title="서버가 다시 시작됐습니다 — 눌러서 닫기">재시작됨 {hhmm(restartedAt)}</button>;
  if (startedAt === null) return null;
  const d = new Date(startedAt);
  return (
    <span className="top-chip server-chip server-uptime" data-testid="server-chip" title={`서버 시작 ${d.getMonth() + 1}/${d.getDate()} ${hhmm(startedAt)}`}>
      {uptimeLabel((fixedNow ?? Date.now()) - startedAt)}
    </span>
  );
}

/** How often the 하이라이트 badge asks for its count, and how long after a turn ends. */
const HL_POLL_MS = 5 * 60_000;
const HL_AFTER_TURN_MS = 2_000;

/**
 * 하이라이트 N: the last 24 hours' outcomes (GET /api/highlights?hours=24 minus background task events — a session's
 * tasks would swamp the number), asked once connected, every 5 minutes, and shortly after a turn ends (fewer sessions
 * running). A failed ask keeps the number shown. Narrow bars: ✦N (CSS).
 */
export function HighlightsBadge({ ready, running, onOpen, fetchFn = fetch }: {
  /** Connected (hello in): asks right away and starts polling. */
  ready: boolean;
  /** Sessions running a turn: a drop means a turn ended. */
  running: number;
  onOpen: () => void;
  fetchFn?: typeof fetch;
}) {
  const [count, setCount] = useState<number | null>(null);
  // Only the newest ask may land: a slow answer is not allowed to overwrite a newer one.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetchFn('/api/highlights?hours=24');
      if (!r.ok) return;
      const list = ((await r.json()) as { events?: unknown }).events;
      if (mine !== seq.current || !Array.isArray(list)) return;
      setCount(list.filter((e) => !(e && typeof e === 'object' && (e as { kind?: unknown }).kind === 'task')).length);
    } catch { /* offline or an older server: keep the number shown */ }
  }, [fetchFn]);
  useEffect(() => {
    if (!ready) return;
    void load();
    const t = setInterval(() => void load(), HL_POLL_MS);
    return () => clearInterval(t);
  }, [ready, load]);
  const prevRunning = useRef(running);
  const afterTurn = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const was = prevRunning.current;
    prevRunning.current = running;
    if (running >= was) return;
    // Several turns ending together ask once.
    if (afterTurn.current) clearTimeout(afterTurn.current);
    afterTurn.current = setTimeout(() => { afterTurn.current = null; void load(); }, HL_AFTER_TURN_MS);
  }, [running, load]);
  useEffect(() => () => { if (afterTurn.current) clearTimeout(afterTurn.current); }, []);
  const label = count ? `하이라이트 ${count}` : '하이라이트';
  return (
    <button type="button" className="top-chip hl-badge" data-testid="hl-badge" onClick={onOpen} aria-label={label} title={count ? `최근 24시간 하이라이트 ${count}건 — 눌러서 보기` : '하이라이트 보기'}>
      <span className="hl-badge-long">{label}</span>
      <span className="hl-badge-short" aria-hidden="true">✦{count ? ` ${count}` : ''}</span>
    </button>
  );
}
