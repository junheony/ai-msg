import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type ReactNode } from 'react';
import type { SessionActivity } from '../../shared/protocol';
import type { PermissionDecision, QuestionAnswers } from '../../shared/turn-types';
import type { TaskInfo } from '../../shared/tasks';
import type { PaneBackground, PendingPermission, PendingQuestion } from '../state';
import { pushBlocker } from '../push';
import { FOCUSABLE, Sheet, SheetHead, trapTab } from './Dialogs';
import { BLOCKER_TEXT, NotifyMenu } from './NotifyMenu';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { useClock } from './usageSeats';

/** A row that opens its session: a session id, else (a new chat's card) the turn the card belongs to. */
export type WorkRow = { key: string; sessionId: string | null; turnId: string | null; title: string; cwd: string; status: string; waiting: boolean };

/** What the 서버 업데이트 check said (GET /api/server-update); null = not known / feature off. */
export type ServerUpdateInfo = { changedFiles: number; supervised: boolean };

const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** 서버 · 3시간째: how long the server process has been up (분 / 시간 / 일). */
export function uptimeLabel(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return '서버 · 방금 시작';
  if (min < 60) return `서버 · ${min}분째`;
  const h = Math.floor(min / 60);
  return h < 24 ? `서버 · ${h}시간째` : `서버 · ${Math.floor(h / 24)}일째`;
}

/** What a drain waits for: running turns plus background tasks. */
export function workCount(activity: SessionActivity[]): number {
  return activity.filter((a) => a.running).length + activity.reduce((n, a) => n + Math.max(0, a.bg), 0);
}

/** The restart confirm's line: what the drain waits for, or that it goes at once. */
export function restartConfirmText(activity: SessionActivity[]): string {
  const work = workCount(activity);
  return work > 0 ? `진행 중 작업 ${work}개가 끝나면 재시작합니다` : '바로 재시작합니다';
}

export const RESTART_WAIT_WARNING = '재시작을 기다리는 동안 새 메시지는 받지 않습니다 — 진행 중인 턴·백그라운드 작업이 모두 끝나야 재시작됩니다.';
export const FORCE_RESTART_WARNING = '진행 중인 턴과 백그라운드 작업(데모 서버 등)이 중단됩니다';

/** The empty sheet's line: nothing runs, with when the last work ended if this tab saw it end (a reload forgets it). */
export function idleLabel(lastWorkAt: number | null): string {
  return lastWorkAt === null ? '지금 실행 중인 작업이 없어요' : `지금 실행 중인 작업이 없어요 · ${hhmm(lastWorkAt)} 까지 작업`;
}

/** A sheet row that can go away under the user's hand (a card answered, a turn stopped, a task cancelled). */
const ROW = '.act-card, .act-item';

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="act-sec" data-testid={testId} aria-label={title}>
      <h3 className="act-sec-title">{title}</h3>
      {children}
    </section>
  );
}

const TASK_STATUS: Record<TaskInfo['status'], string> = { queued: '대기 중', running: '작업 중', done: '완료', failed: '실패' };

/**
 * 서버: uptime, 재시작됨 HH:MM (닫기), 업데이트 대기 · 파일 N with 지금 재시작 → confirm → POST /api/restart, and while
 * draining what the restart waits for plus (under a supervisor) 작업 끊고 지금 재시작 → confirm → POST {force:true}.
 */
function ServerSection({ startedAt, restartedAt, draining, update, activity, titleOf, onOpen, onDismissRestart, fetchFn, now }: {
  startedAt: number | null; restartedAt: number | null; draining: boolean; update: ServerUpdateInfo | null; activity: SessionActivity[];
  titleOf: (sessionId: string, cwd: string | null) => string; onOpen: (row: WorkRow) => void; onDismissRestart: () => void; fetchFn: typeof fetch; now: number;
}) {
  const supervised = update?.supervised === true;
  const mode = draining ? 'draining' : supervised && (update?.changedFiles ?? 0) > 0 ? 'update' : null;
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // A switch between update and draining drops the confirm that was open (its buttons belong to the other form).
  useEffect(() => { setConfirm(false); setError(null); }, [mode]);
  if (!mode && restartedAt === null && startedAt === null) return null;
  const restart = async (force: boolean) => {
    setSending(true);
    setError(null);
    try {
      const r = await fetchFn('/api/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: force ? '{"force":true}' : '{}' });
      if (!r.ok) { setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `재시작 요청 실패 (${r.status})`); return; }
      setConfirm(false);
    } catch { setError('서버에 닿지 못했어요 — 연결되면 다시 눌러 주세요'); } finally { setSending(false); }
  };
  const work = workCount(activity);
  const waitedOn = draining ? activity.filter((a) => a.running || a.bg > 0) : [];
  return (
    <Section title="서버" testId="act-server">
      {startedAt !== null && !draining && (
        <div className="act-line" data-testid="server-uptime" title={`서버 시작 ${new Date(startedAt).getMonth() + 1}/${new Date(startedAt).getDate()} ${hhmm(startedAt)}`}>{uptimeLabel(now - startedAt)}</div>
      )}
      {restartedAt !== null && !draining && (
        <div className="act-line">
          <span>재시작됨 {hhmm(restartedAt)}</span>
          <button type="button" className="text-btn" onClick={onDismissRestart}>닫기</button>
        </div>
      )}
      {mode === 'draining' && (
        <>
          <div className="act-line warn" role="status" data-testid="drain-status">{work > 0 ? `재시작 대기 중 · 작업 ${work}개 기다림` : '재시작 중…'}</div>
          {waitedOn.map((a) => {
            const row: WorkRow = { key: a.sessionId, sessionId: a.sessionId, turnId: null, title: titleOf(a.sessionId, a.cwd), cwd: a.cwd, status: a.running ? '턴 진행 중' : `백그라운드 작업 ${a.bg}개`, waiting: false };
            return (
              <div key={row.key}>
                <button type="button" className="act-row" onClick={() => onOpen(row)}><span className="act-title">{row.title}</span><b>{row.status}</b></button>
                {a.tasks && a.tasks.length > 0 && <div className="act-sub">{a.tasks.map((t, i) => <div key={i} className="act-title">· {t}</div>)}</div>}
              </div>
            );
          })}
          {supervised && (
            <>
              <p className={`act-hint${confirm ? ' update-error' : ''}`}>{confirm ? FORCE_RESTART_WARNING : RESTART_WAIT_WARNING}</p>
              {error && <p className="act-hint update-error" role="alert">{error}</p>}
              <div className="update-actions">
                {confirm && <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>취소</button>}
                {!confirm
                  ? <button type="button" className="btn primary" data-testid="drain-force" onClick={() => { setError(null); setConfirm(true); }}>작업 끊고 지금 재시작</button>
                  : <button type="button" className="btn primary" disabled={sending} onClick={() => void restart(true)}>중단하고 재시작</button>}
              </div>
            </>
          )}
        </>
      )}
      {mode === 'update' && (
        <>
          <div className="act-line accent" data-testid="server-update">서버 업데이트 대기 · 파일 {update?.changedFiles ?? 0}개</div>
          {confirm && <p className="act-hint">{restartConfirmText(activity)}</p>}
          {confirm && <p className="act-hint">{RESTART_WAIT_WARNING}</p>}
          {error && <p className="act-hint update-error" role="alert">{error}</p>}
          <div className="update-actions">
            {confirm && <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>취소</button>}
            {!confirm
              ? <button type="button" className="btn primary" data-testid="update-restart" onClick={() => { setError(null); setConfirm(true); }}>지금 재시작</button>
              : <button type="button" className="btn primary" disabled={sending} onClick={() => void restart(false)}>재시작</button>}
          </div>
        </>
      )}
    </Section>
  );
}

export type ActivitySheetProps = {
  onClose: () => void;
  connected: boolean;
  /** When the server stopped answering (a long disconnect); null = a short blip / connected. */
  downSince: number | null;
  onRetry: () => void;
  /** Every permission card and question waiting, whatever session (a pane's or none). */
  pending: PendingPermission[];
  questions: PendingQuestion[];
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onAnswer: (requestId: string, answers: QuestionAnswers) => void;
  activity: SessionActivity[];
  /** 백그라운드 작업 (`/bg`): the not-ended ones are listed. */
  tasks: TaskInfo[];
  onOpenTask?: (t: TaskInfo) => void;
  onCancelTask?: (taskId: string) => void;
  /** Open panes' background pills: a session's held turn there gives per-task 중지. */
  paneBg: PaneBackground[];
  onStopTask?: (turnId: string, taskId: string) => void;
  onInterrupt?: (turnId: string) => void;
  titleOf: (sessionId: string, cwd: string | null) => string;
  onOpen: (row: WorkRow) => void;
  onNewChat?: () => void;
  lastWorkAt: number | null;
  /** 하이라이트: the last 24 hours' count (null = not known yet); undefined = the server has no highlights. */
  highlights?: number | null;
  onOpenHighlights?: () => void;
  server: { startedAt: number | null; restartedAt: number | null; draining: boolean; update: ServerUpdateInfo | null; onDismissRestart: () => void };
  fetchFn?: typeof fetch;
  now?: number;
};

/**
 * 활동 시트 (the activity dot's sheet; a right column on desktop, a bottom sheet on a phone): 승인 대기 cards answered
 * right here, 실행 중 (open · 중단), 백그라운드 (per-task 중지, `/bg` tasks with 취소 · 승인 대기), 하이라이트, 서버
 * (restart flow), 알림 설정. A modal dialog: Esc closes (Sheet), Tab stays inside.
 */
export function ActivitySheet(p: ActivitySheetProps) {
  // The server's uptime moves on while the sheet stays open.
  const now = useClock(p.now, 60_000);
  // The row focus was last in: when it goes away (허용/거부, 중단, 취소) focus moves to the row now in its place, else
  // the one before, else ✕ — never left on the page behind the modal.
  const inner = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const lastRow = useRef<{ el: HTMLElement; index: number } | null>(null);
  const noteFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(ROW);
    lastRow.current = row ? { el: row, index: Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ROW)).indexOf(row) } : null;
  };
  useLayoutEffect(() => {
    const last = lastRow.current;
    const box = inner.current;
    if (!last || !box) return;
    const rows = Array.from(box.querySelectorAll<HTMLElement>(ROW));
    // Still here: keep its place current (rows above it may have gone).
    if (last.el.isConnected) { last.index = rows.indexOf(last.el); return; }
    lastRow.current = null;
    const at = document.activeElement;
    if (at && at !== document.body) return;
    const target = rows[last.index] ?? rows[last.index - 1];
    (target?.querySelector<HTMLElement>(FOCUSABLE) ?? closeBtn.current)?.focus();
  });
  const blocker = pushBlocker();
  const cardSessions = new Set([...p.pending, ...p.questions].map((c) => c.sessionId).filter(Boolean));
  const running = p.activity.filter((a) => a.running && !cardSessions.has(a.sessionId));
  const bgSessions = p.activity.filter((a) => a.bg > 0);
  const liveTasks = p.tasks.filter((t) => t.status === 'queued' || t.status === 'running');
  const cardCount = p.pending.length + p.questions.length;
  const empty = cardCount === 0 && running.length === 0 && bgSessions.length === 0 && liveTasks.length === 0;
  const open = (row: WorkRow) => { p.onClose(); p.onOpen(row); };
  const cardHead = (c: { sessionId: string | null; cwd: string; turnId: string }) => {
    const title = c.sessionId ? p.titleOf(c.sessionId, c.cwd) : '새 대화';
    return (
      <button type="button" className="act-row act-card-head" onClick={() => open({ key: c.sessionId ?? c.turnId, sessionId: c.sessionId, turnId: c.turnId, title, cwd: c.cwd, status: '승인 대기', waiting: true })}>
        <span className="act-title">{title}</span><b className="act-wait">열기</b>
      </button>
    );
  };
  return (
    <Sheet className="activity-sheet" label="활동" onClose={p.onClose}>
      <div ref={inner} className="act-inner" onKeyDown={trapTab} onFocus={noteFocus}>
        <SheetHead title="활동" onClose={p.onClose} closeRef={closeBtn} />
        {blocker && <p className="act-banner warn" data-testid="act-notify-blocked">알림이 꺼져 있어요 — {BLOCKER_TEXT[blocker]}</p>}
        {!p.connected && (
          <div className="act-banner danger" data-testid="act-conn">
            <span>{p.downSince !== null ? `서버에 연결할 수 없어요 · ${hhmm(p.downSince)}부터` : '재연결 중…'}</span>
            <button type="button" className="text-btn" onClick={p.onRetry}>다시 시도</button>
          </div>
        )}
        {cardCount > 0 && (
          <Section title={`승인 대기 ${cardCount}`} testId="act-waiting">
            {p.pending.map((r) => <div key={r.requestId} className="act-card">{cardHead(r)}<PermissionCard req={r} onDecide={p.onDecide} /></div>)}
            {p.questions.map((q) => <div key={q.requestId} className="act-card">{cardHead(q)}<QuestionCard req={q} onAnswer={p.onAnswer} /></div>)}
          </Section>
        )}
        {running.length > 0 && (
          <Section title={`실행 중 ${running.length}`} testId="act-running">
            {running.map((a) => {
              const title = p.titleOf(a.sessionId, a.cwd);
              return (
                <div key={a.sessionId} className="act-item">
                  <button type="button" className="act-row" onClick={() => open({ key: a.sessionId, sessionId: a.sessionId, turnId: null, title, cwd: a.cwd, status: '실행 중', waiting: false })}>
                    <span className="act-title">{title}</span><b>실행 중</b>
                  </button>
                  {p.onInterrupt && <button type="button" className="btn ghost act-stop" aria-label={`${title} 중단`} onClick={() => p.onInterrupt!(a.turnId)}>중단</button>}
                </div>
              );
            })}
          </Section>
        )}
        {(bgSessions.length > 0 || liveTasks.length > 0) && (
          <Section title="백그라운드" testId="act-bg">
            {bgSessions.map((a) => {
              const title = p.titleOf(a.sessionId, a.cwd);
              const held = p.paneBg.find((b) => b.turnId === a.turnId);
              const stoppable = held?.canStop && held.detail.length ? held.detail : [];
              return (
                <div key={a.sessionId}>
                  <button type="button" className="act-row" onClick={() => open({ key: a.sessionId, sessionId: a.sessionId, turnId: null, title, cwd: a.cwd, status: `백그라운드 ${a.bg}`, waiting: false })}>
                    <span className="act-title">{title}</span><b>백그라운드 {a.bg}</b>
                  </button>
                  {stoppable.length > 0 && p.onStopTask
                    ? stoppable.map((d) => (
                      <div key={d.id} className="act-item act-sub">
                        <span className="act-title">· {d.description || '작업'}</span>
                        <button type="button" className="btn ghost act-stop" onClick={() => p.onStopTask!(a.turnId, d.id)}>중지</button>
                      </div>
                    ))
                    : a.tasks && a.tasks.length > 0 && <div className="act-sub">{a.tasks.map((t, i) => <div key={i} className="act-title">· {t}</div>)}</div>}
                </div>
              );
            })}
            {liveTasks.map((t) => (
              <div key={t.taskId} className="act-item" data-testid="act-task">
                <span className="act-title">
                  <span className={`task-badge ${t.status}`}>{TASK_STATUS[t.status]}</span>
                  {t.status === 'running' && t.waiting && <span className="task-badge waiting">승인 대기</span>}
                  {' '}{t.title}
                </span>
                {t.sessionId && p.onOpenTask && <button type="button" className="btn ghost act-stop" onClick={() => { p.onClose(); p.onOpenTask!(t); }}>열어 보기</button>}
                {p.onCancelTask && <button type="button" className="btn ghost act-stop" onClick={() => p.onCancelTask!(t.taskId)}>취소</button>}
              </div>
            ))}
          </Section>
        )}
        {empty && (
          <div className="act-empty">
            <p className="act-hint">{idleLabel(p.lastWorkAt)}</p>
            {p.onNewChat && <button type="button" className="btn ghost" onClick={() => { p.onClose(); p.onNewChat!(); }}>새 대화</button>}
          </div>
        )}
        {p.highlights !== undefined && p.onOpenHighlights && (
          <button type="button" className="act-row act-link" data-testid="act-highlights" onClick={() => { p.onClose(); p.onOpenHighlights!(); }}>
            <span>하이라이트{p.highlights ? ` ${p.highlights}` : ''}</span><b>보기 →</b>
          </button>
        )}
        <ServerSection {...p.server} activity={p.activity} titleOf={p.titleOf} onOpen={open} fetchFn={p.fetchFn ?? fetch} now={now} />
        <div className="act-line act-notify"><span>이 기기 알림 설정</span><NotifyMenu /></div>
      </div>
    </Sheet>
  );
}
