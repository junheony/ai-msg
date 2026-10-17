import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
export function ServerChip({ startedAt, restartedAt, draining, busy, onDismissRestart, now: fixedNow, activity = [], titleOf = (id, cwd) => cwd?.split('/').filter(Boolean).pop() ?? id.slice(0, 8), onOpen }: {
  startedAt: number | null;
  restartedAt: number | null;
  draining: boolean;
  /** Sessions still running or holding background work (what a drain waits for). */
  busy: number;
  onDismissRestart: () => void;
  now?: number;
  /** While draining, a click lists these sessions (the ones the restart waits for); a row opens its session. */
  activity?: SessionActivity[];
  titleOf?: (sessionId: string, cwd: string | null) => string;
  onOpen?: (row: WorkRow) => void;
}) {
  const [, setTick] = useState(0);
  const [pop, setPop] = useState<{ right: number; y: number } | null>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const open = draining && pop !== null;
  useEffect(() => {
    if (!open) return;
    const close = () => setPop(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPop(null); chip.current?.focus(); } };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); document.removeEventListener('keydown', onKey); };
  }, [open]);
  // Re-render each minute (the label shows minute steps); the time itself is read at render, so a new start shows right.
  useEffect(() => {
    if (startedAt === null || fixedNow !== undefined) return;
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [startedAt, fixedNow]);
  if (draining) {
    const rows = open ? activity.filter((a) => a.running || a.bg > 0) : [];
    return (
      <>
        <button
          ref={chip} type="button" className="top-chip warn server-chip" aria-expanded={open} aria-haspopup="dialog" title="서버가 재시작을 준비 중입니다 — 돌고 있는 작업이 끝나면 다시 시작합니다"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setPop(open ? null : { right: Math.max(8, window.innerWidth - r.right), y: r.bottom + 6 });
          }}
        >
          <span role="status">
            <span className="chip-long">{busy > 0 ? `재시작 대기 중 · 작업 ${busy}개 기다림` : '재시작 중…'}</span>
            <span className="chip-short" aria-hidden="true">{busy > 0 ? `재시작 대기 · ${busy}` : '재시작 중…'}</span>
          </span>
        </button>
        {open && pop && (
          <div className="usage-pop work-pop" role="dialog" aria-label="재시작이 기다리는 작업" style={{ right: pop.right, top: pop.y }} onClick={(e) => e.stopPropagation()}>
            <div className="usage-pop-title">재시작이 기다리는 작업</div>
            {rows.map((a) => {
              const row: WorkRow = { key: a.sessionId, sessionId: a.sessionId, turnId: null, title: titleOf(a.sessionId, a.cwd), cwd: a.cwd, status: a.running ? '턴 진행 중' : `백그라운드 작업 ${a.bg}개`, waiting: false };
              return (
                <div key={row.key}>
                  <button type="button" className="usage-pop-row work-row" onClick={() => { setPop(null); onOpen?.(row); }}>
                    <span className="work-title">{row.title}</span>
                    <b>{row.status}</b>
                  </button>
                  {a.tasks && a.tasks.length > 0 && <div className="usage-pop-row hint">{a.tasks.map((t, i) => <div key={i} className="work-title">· {t}</div>)}</div>}
                </div>
              );
            })}
            {rows.length === 0 && <div className="usage-pop-row hint">기다리는 작업이 없어요</div>}
          </div>
        )}
      </>
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

/** How often the 서버 업데이트 chip asks whether server code changed (also once on every connect). */
const UPDATE_POLL_MS = 60_000;

/** What a drain waits for: running turns plus background tasks. */
function workCount(activity: SessionActivity[]): number {
  return activity.filter((a) => a.running).length + activity.reduce((n, a) => n + Math.max(0, a.bg), 0);
}

/** The restart confirm's line: what the drain waits for, or that it goes at once. */
export function restartConfirmText(activity: SessionActivity[]): string {
  const work = workCount(activity);
  return work > 0 ? `진행 중 작업 ${work}개가 끝나면 재시작합니다` : '바로 재시작합니다';
}

export const RESTART_WAIT_WARNING = '재시작을 기다리는 동안 새 메시지는 받지 않습니다 — 진행 중인 턴·백그라운드 작업이 모두 끝나야 재시작됩니다.';
export const FORCE_RESTART_WARNING = '진행 중인 턴과 백그라운드 작업(데모 서버 등)이 중단됩니다';

/**
 * 서버 업데이트 대기 · 파일 N: server code changed since the server started (GET /api/server-update, on connect and every
 * minute). Shown only under a supervisor that starts the server again. 지금 재시작 opens a confirm; its OK sends
 * POST /api/restart — the same drain as `npm run restart`. While draining (under a supervisor) it turns into
 * 재시작 대기 · N with 작업 끊고 지금 재시작: after a second confirm, POST /api/restart {force:true} — a second SIGUSR2.
 */
export function ServerUpdateChip({ ready, draining, activity, fetchFn = fetch }: {
  /** Connected (hello in): asks right away and starts polling. */
  ready: boolean;
  draining: boolean;
  /** What the drain would wait for (the confirm counts turns and background tasks). */
  activity: SessionActivity[];
  fetchFn?: typeof fetch;
}) {
  const [info, setInfo] = useState<{ changedFiles: number; supervised: boolean } | null>(null);
  const [pop, setPop] = useState<{ right: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** While draining: the 작업 끊고 지금 재시작 confirm step is showing. */
  const [confirmForce, setConfirmForce] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetchFn('/api/server-update');
      if (!r.ok) return;
      const j = (await r.json()) as { changedFiles?: unknown; supervised?: unknown };
      setInfo({ changedFiles: typeof j.changedFiles === 'number' ? j.changedFiles : 0, supervised: j.supervised === true });
    } catch { /* offline: keep what is shown */ }
  }, [fetchFn]);
  useEffect(() => {
    // Disconnected (a restart, maybe): what the old server said no longer holds.
    if (!ready) { setInfo(null); return; }
    void load();
    const t = setInterval(() => void load(), UPDATE_POLL_MS);
    return () => clearInterval(t);
  }, [ready, load]);
  const supervised = info !== null && info.supervised;
  const mode = !supervised ? null : draining ? 'draining' : info.changedFiles > 0 ? 'update' : null;
  const open = mode !== null && pop !== null;
  // A switch between update and draining closes what was open (its buttons belong to the other form).
  useEffect(() => { setPop(null); setConfirmForce(false); setError(null); }, [mode]);
  useEffect(() => {
    if (!open) return;
    const close = () => setPop(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPop(null); chip.current?.focus(); } };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (mode === null) return null;
  const files = info?.changedFiles ?? 0;
  const restart = async (force: boolean) => {
    setSending(true);
    setError(null);
    try {
      const r = await fetchFn('/api/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: force ? '{"force":true}' : '{}' });
      if (!r.ok) { setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `재시작 요청 실패 (${r.status})`); return; }
      setPop(null);
      setConfirmForce(false);
    } catch { setError('서버에 닿지 못했어요 — 연결되면 다시 눌러 주세요'); } finally { setSending(false); }
  };
  const toggle = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setError(null);
    setConfirmForce(false);
    const r = e.currentTarget.getBoundingClientRect();
    setPop(open ? null : { right: Math.max(8, window.innerWidth - r.right), y: r.bottom + 6 });
  };
  const close = () => { setPop(null); setConfirmForce(false); };
  if (mode === 'draining') {
    const work = workCount(activity);
    const status = work > 0 ? `재시작 대기 중 · 작업 ${work}개` : '재시작 중…';
    return (
      <>
        <button
          ref={chip} type="button" className="top-chip warn drain-chip" data-testid="drain-chip" aria-expanded={open} aria-haspopup="dialog"
          title={`${status} — 눌러서 작업을 끊고 지금 재시작`} onClick={toggle}
        >
          <span className="chip-long">작업 끊고 지금 재시작</span>
          <span className="chip-short" aria-hidden="true">{work > 0 ? `재시작 대기 · ${work}` : '재시작 중…'}</span>
        </button>
        {open && pop && (
          <div className="usage-pop work-pop update-pop" role="dialog" aria-label="재시작 대기 중" style={{ right: pop.right, top: pop.y }} onClick={(e) => e.stopPropagation()}>
            <div className="usage-pop-title">{status}</div>
            {!confirmForce
              ? <div className="usage-pop-row hint">{RESTART_WAIT_WARNING}</div>
              : <div className="usage-pop-row hint update-error">{FORCE_RESTART_WARNING}</div>}
            {error && <div className="usage-pop-row hint update-error" role="alert">{error}</div>}
            <div className="update-actions">
              <button type="button" className="btn ghost" onClick={close}>{confirmForce ? '취소' : '닫기'}</button>
              {!confirmForce
                ? <button type="button" className="btn primary" onClick={() => { setError(null); setConfirmForce(true); }}>작업 끊고 지금 재시작</button>
                : <button type="button" className="btn primary" disabled={sending} onClick={() => void restart(true)}>중단하고 재시작</button>}
            </div>
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <button
        ref={chip} type="button" className="top-chip update-chip" data-testid="update-chip" aria-expanded={open} aria-haspopup="dialog"
        title={`서버가 뜬 뒤 서버 코드 파일 ${files}개가 바뀌었습니다 — 눌러서 재시작`} onClick={toggle}
      >
        <span className="chip-long">서버 업데이트 대기 · 파일 {files}개 <b className="update-go">지금 재시작</b></span>
        <span className="chip-short" aria-hidden="true">업데이트 · {files}</span>
      </button>
      {open && pop && (
        <div className="usage-pop work-pop update-pop" role="dialog" aria-label="서버 재시작" style={{ right: pop.right, top: pop.y }} onClick={(e) => e.stopPropagation()}>
          <div className="usage-pop-title">서버 재시작</div>
          <div className="usage-pop-row hint">{restartConfirmText(activity)}</div>
          <div className="usage-pop-row hint">{RESTART_WAIT_WARNING}</div>
          {error && <div className="usage-pop-row hint update-error" role="alert">{error}</div>}
          <div className="update-actions">
            <button type="button" className="btn ghost" onClick={close}>취소</button>
            <button type="button" className="btn primary" disabled={sending} onClick={() => void restart(false)}>재시작</button>
          </div>
        </div>
      )}
    </>
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
