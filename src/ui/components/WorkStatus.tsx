import { useEffect, useRef, useState } from 'react';
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
 * 작업 현황 chip: 실행 중 N · 백그라운드 M · 승인 대기 K, in sessions (zeros left out; nothing at all → no chip). A click
 * lists the sessions; a row opens its session. Narrow top bars show the short form (▶N · ⏸M · !K, CSS).
 */
export function WorkStatus({ activity, waiting, titleOf, onOpen }: {
  activity: SessionActivity[];
  /** Permission cards and questions waiting for an answer. */
  waiting: WaitingCard[];
  titleOf: (sessionId: string, cwd: string | null) => string;
  onOpen: (row: WorkRow) => void;
}) {
  const [pop, setPop] = useState<{ right: number; y: number } | null>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const counts = workCounts(activity, waiting);
  const total = counts.running + counts.bg + counts.waiting;
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
  useEffect(() => { if (total === 0) setPop(null); }, [total]);
  if (total === 0) return null;
  const long = [counts.running ? `실행 중 ${counts.running}` : null, counts.bg ? `백그라운드 ${counts.bg}` : null].filter(Boolean).join(' · ');
  const short = [counts.running ? `▶${counts.running}` : null, counts.bg ? `⏸${counts.bg}` : null].filter(Boolean).join(' · ');
  const label = [long, counts.waiting ? `승인 대기 ${counts.waiting}` : ''].filter(Boolean).join(' · ');
  const rows = pop ? workRows(activity, waiting, titleOf) : [];
  return (
    <>
      <button
        ref={chip} type="button" className="top-chip work-chip" data-testid="work-chip" aria-expanded={!!pop} aria-haspopup="dialog" aria-label={label}
        title={`작업 현황 (${label}) — 눌러서 세션 목록 · 승인 대기인 세션은 실행 중·백그라운드에 세지 않습니다`}
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
        </div>
      )}
    </>
  );
}
