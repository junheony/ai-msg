import type { ServerMessage } from '../../shared/protocol';
import { limitResetAtMs } from '../engine/limitDetect';
import type { SessionState } from '../turn/SessionState';
import { ABORTED, AUTO_RETRY_NOTICE } from '../turn/TurnRunner';
import { PERMISSION_TIMEOUT_MS } from '../ws';
import { firstLine, type PushPayload } from './PushNotifier';

/** An unanswered permission / question card is pushed again once, this long after it came. */
export const ASK_NUDGE_MS = 10 * 60_000;
/** A failed turn nobody followed up: pushed again after these gaps (10 min, then 30, then 60), then left alone. */
export const TURN_NUDGE_GAPS_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000] as const;
/** A booked retry older than this at start is dropped (the work has surely moved on). */
const RETRY_STALE_MS = 12 * 3600_000;

const TITLE_MAX = 60;
const BODY_MAX = 140;
const clip = (s: string, max: number) => { const t = s.trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

type Timer = unknown;
export type WatchStore = { get(id: string): SessionState | null; list(): SessionState[]; set(s: SessionState): Promise<void> };
/** `commanderHop` is set when the failed turn was an automatic (commander) one — its retry must stay gated (보안 #3). */
export type RetryRequest = { sessionId: string; cwd: string; text: string; hop: number; commanderHop?: number };

/**
 * 병목 알림: the moments a session sits waiting on the user — an unanswered permission / question card, a turn that
 * failed and stayed failed — are pushed again later (same tag, so the first notice is replaced), and a turn booked for an
 * automatic retry (SessionState.pendingRetry, 대안 계정 없음) is fired at its time through `retry` (ws's send path).
 * Fed every server event (`observe`); the user sending to the session (`userSent`) stops its reminders — opening it does
 * not (every tab sends open_session again when it reconnects, e.g. after a restart). An answered card stops its own.
 * Failed-turn reminders and retries are stored in the session state and re-armed at start (`rearm`); cards die with the
 * process, so their reminders are memory only.
 */
export class BottleneckWatch {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly asks = new Map<string, { sessionId: string | null; timer: Timer }>();
  /** Failed turns by session id: the reminder timer. */
  private readonly turns = new Map<string, { cwd: string; timer: Timer | null }>();
  private readonly retries = new Map<string, Timer>();
  /** Turns deck started by itself (AUTO_RETRY_NOTICE): their failure goes on from the reminder stage before. */
  private readonly retryTurns = new Set<string>();
  /** By session: how many reminders the failure before this turn had sent (its record is gone once the next turn starts). */
  private readonly lastStage = new Map<string, number>();

  constructor(private readonly deps: {
    sendPush: (payload: PushPayload) => void;
    titleOf: (sessionId: string | null, cwd: string) => string;
    store: WatchStore;
    /** The earliest end of an account cooldown (ms), or null: "HH:MM 쯤 다시 시도 가능" for 대안 계정 없음. */
    earliestCooldownMs?: () => number | null;
    /** Starts the booked retry turn; absent = retries are not fired. */
    retry?: (r: RetryRequest) => void;
    /** A booked retry was armed (its time) or went (null: started, sent over, cancelled, stale) — the devices' 자동으로 이어가기 line. */
    onRetry?: (sessionId: string, atMs: number | null) => void;
    /** 총사령탑이 이 세션의 실패를 맡았다(사람 필요 푸시를 따로 낸다): 실패 리마인더는 내지 않고 재시도 예약만 둔다. */
    quiet?: (sessionId: string) => boolean;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => Timer;
    clearTimer?: (t: Timer) => void;
  }) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  observe(msg: ServerMessage): void {
    switch (msg.type) {
      case 'permission_request': {
        const what = msg.toolName === 'ExitPlanMode' ? '계획 승인' : msg.title ? `${msg.toolName}: ${firstLine(msg.title)}` : msg.toolName;
        this.watchAsk(msg.requestId, msg.sessionId, msg.cwd, 'permission', what);
        break;
      }
      case 'question_request':
        this.watchAsk(msg.requestId, msg.sessionId, msg.cwd, 'question', firstLine(msg.questions[0]?.question ?? '') || '질문');
        break;
      case 'permission_resolved':
      case 'question_resolved':
        this.dropAsk(msg.requestId);
        break;
      case 'turn_started':
        if (msg.sessionId) this.settle(msg.sessionId);
        break;
      case 'turn_notice':
        if (msg.message === AUTO_RETRY_NOTICE) this.retryTurns.add(msg.turnId);
        break;
      case 'turn_result': {
        const retried = this.retryTurns.delete(msg.turnId);
        if (!msg.sessionId) break;
        if (msg.ok) { this.settle(msg.sessionId); this.lastStage.delete(msg.sessionId); break; }
        // The user's own stop is not a bottleneck.
        if (msg.errorText === ABORTED) break;
        this.turnFailed(msg.sessionId, msg.cwd, msg.errorText ?? msg.text, retried);
        break;
      }
      default:
        break;
    }
  }

  /** The user sent to the session: its card and failed-turn reminders stop, and a booked retry is called off. */
  userSent(sessionId: string): void {
    for (const [id, a] of [...this.asks]) if (a.sessionId === sessionId) this.dropAsk(id);
    this.dropTurn(sessionId);
    this.dropRetry(sessionId);
    this.lastStage.delete(sessionId);
  }

  /** At start: failed-turn reminders from where they were (stages already past are skipped) and booked retries. */
  rearm(states: SessionState[]): void {
    for (const st of states) {
      if (st.blocked) {
        this.turns.set(st.sessionId, { cwd: st.cwd, timer: null });
        this.armTurn(st.sessionId);
      }
      if (st.pendingRetry) {
        if (this.now() - st.pendingRetry.atMs > RETRY_STALE_MS) { this.dropRetry(st.sessionId); continue; }
        this.armRetry(st.sessionId);
      }
    }
  }

  /**
   * The session just went idle (ws): a booked retry whose time has come but whose start was refused (the session was
   * busy then) is fired now instead of waiting for the next restart.
   */
  retryDue(sessionId: string): void {
    const r = this.deps.store.get(sessionId)?.pendingRetry;
    if (!r || r.atMs > this.now()) return;
    const t = this.retries.get(sessionId);
    if (t !== undefined) this.clearTimer(t);
    // Same rule as rearm: a booking this old (e.g. kept while background work held the process for hours) is dropped.
    if (this.now() - r.atMs > RETRY_STALE_MS) { this.dropRetry(sessionId); return; }
    this.fireRetry(sessionId);
  }

  /** 취소 on the 자동으로 이어가기 line: the booking is called off. False when there was none. */
  cancelRetry(sessionId: string): boolean {
    return this.dropRetry(sessionId);
  }

  /** Every timer off (tests, shutdown). */
  stop(): void {
    for (const a of this.asks.values()) this.clearTimer(a.timer);
    for (const t of this.turns.values()) if (t.timer !== null) this.clearTimer(t.timer);
    for (const t of this.retries.values()) this.clearTimer(t);
    this.asks.clear(); this.turns.clear(); this.retries.clear(); this.retryTurns.clear(); this.lastStage.clear();
  }

  private watchAsk(requestId: string, sessionId: string | null, cwd: string, kind: 'permission' | 'question', what: string): void {
    this.dropAsk(requestId);
    const left = Math.round((PERMISSION_TIMEOUT_MS - ASK_NUDGE_MS) / 60_000);
    // A permission card times out as a denial; a question card just closes (no answer).
    const end = kind === 'permission' ? '자동 거부' : '자동으로 닫힘';
    const timer = this.setTimer(() => {
      this.asks.delete(requestId);
      this.deps.sendPush({ kind, title: this.title(sessionId, cwd), body: clip(`아직 답을 기다립니다 · ${left}분 뒤 ${end} · ${what}`, BODY_MAX), sessionId, tag: `ask-${requestId}` });
    }, ASK_NUDGE_MS);
    this.asks.set(requestId, { sessionId, timer });
  }

  private dropAsk(requestId: string): void {
    const a = this.asks.get(requestId);
    if (!a) return;
    this.clearTimer(a.timer);
    this.asks.delete(requestId);
  }

  /**
   * `retried`: deck's own retry failed again — its reminders go on from the stage the failure before had reached (the
   * first stage skipped when that is not known, e.g. after a restart), so a chain of retries does not start over each time.
   */
  private turnFailed(sessionId: string, cwd: string, errorText: string, retried: boolean): void {
    this.dropTurn(sessionId, false);
    if (this.deps.quiet?.(sessionId)) {
      this.strip(sessionId, 'blocked');
      if (this.deps.store.get(sessionId)?.pendingRetry) this.armRetry(sessionId);
      return;
    }
    const now = this.now();
    const n = retried ? Math.max(1, this.lastStage.get(sessionId) ?? 0) : 0;
    this.lastStage.delete(sessionId);
    this.turns.set(sessionId, { cwd, timer: null });
    const st = this.deps.store.get(sessionId);
    const resetAtMs = limitResetAtMs(errorText, now);
    if (st) this.save({ ...st, blocked: { kind: 'turn_failed', atMs: now, lastPushAtMs: now, n, summary: firstLine(errorText).slice(0, 80), ...(resetAtMs !== null ? { resetAtMs } : {}) } });
    this.armTurn(sessionId);
    if (st?.pendingRetry) this.armRetry(sessionId);
  }

  /** Schedules the next reminder of a failed turn: the first stage still ahead (cumulative gaps from the failure). */
  private armTurn(sessionId: string): void {
    const t = this.turns.get(sessionId);
    const b = this.deps.store.get(sessionId)?.blocked;
    if (!t || !b) { this.dropTurn(sessionId); return; }
    let due = b.atMs;
    let n = 0;
    for (; n < TURN_NUDGE_GAPS_MS.length; n++) {
      due += TURN_NUDGE_GAPS_MS[n]!;
      if (n >= b.n && due > this.now()) break;
    }
    if (n >= TURN_NUDGE_GAPS_MS.length) { this.lastStage.set(sessionId, TURN_NUDGE_GAPS_MS.length); this.dropTurn(sessionId); return; }
    t.timer = this.setTimer(() => this.nudgeTurn(sessionId, n), Math.max(0, due - this.now()));
  }

  private nudgeTurn(sessionId: string, n: number): void {
    const t = this.turns.get(sessionId);
    const st = this.deps.store.get(sessionId);
    if (!t || !st?.blocked || this.deps.quiet?.(sessionId)) { this.dropTurn(sessionId); return; }
    t.timer = null;
    const b = st.blocked;
    const parts = ['턴이 실패한 채 멈춰 있습니다'];
    if (b.summary) parts.push(b.summary);
    if (st.pendingRetry) parts.push(`${hhmm(st.pendingRetry.atMs)} 자동 재시도 예정`);
    else if (b.summary.includes('대안 계정 없음')) {
      const at = b.resetAtMs ?? limitResetAtMs(b.summary, this.now()) ?? this.deps.earliestCooldownMs?.() ?? null;
      if (at !== null) parts.push(`${hhmm(at)} 쯤 다시 시도 가능`);
    }
    this.deps.sendPush({ kind: 'turn', title: this.title(sessionId, st.cwd), body: clip(parts.join(' · '), BODY_MAX), sessionId, tag: `turn-${sessionId}` });
    this.save({ ...st, blocked: { ...b, n: n + 1, lastPushAtMs: this.now() } });
    this.armTurn(sessionId);
  }

  /** `persisted`: the stored record goes too (false when a new failure is about to replace it). */
  private dropTurn(sessionId: string, persisted = true): void {
    const t = this.turns.get(sessionId);
    if (t?.timer != null) this.clearTimer(t.timer);
    this.turns.delete(sessionId);
    if (persisted) this.strip(sessionId, 'blocked');
  }

  private armRetry(sessionId: string): void {
    const r = this.deps.store.get(sessionId)?.pendingRetry;
    if (!r || !this.deps.retry) return;
    const old = this.retries.get(sessionId);
    if (old !== undefined) this.clearTimer(old);
    this.retries.set(sessionId, this.setTimer(() => this.fireRetry(sessionId), Math.max(0, r.atMs - this.now())));
    this.deps.onRetry?.(sessionId, r.atMs);
  }

  /** The booking stays stored until the retry's turn starts (a refused start leaves it for the next restart). */
  private fireRetry(sessionId: string): void {
    this.retries.delete(sessionId);
    const st = this.deps.store.get(sessionId);
    if (!st?.pendingRetry) return;
    try {
      this.deps.retry?.({ sessionId, cwd: st.cwd, text: st.pendingRetry.text, hop: st.pendingRetry.hops, ...(st.pendingRetry.commanderHop ? { commanderHop: st.pendingRetry.commanderHop } : {}) });
    } catch (err) {
      console.error('deck: 자동 재시도 실패', err instanceof Error ? err.message : err);
    }
  }

  private dropRetry(sessionId: string): boolean {
    const t = this.retries.get(sessionId);
    const had = t !== undefined || this.deps.store.get(sessionId)?.pendingRetry !== undefined;
    if (t !== undefined) this.clearTimer(t);
    this.retries.delete(sessionId);
    this.strip(sessionId, 'pendingRetry');
    if (had) this.deps.onRetry?.(sessionId, null);
    return had;
  }

  /** A turn started or succeeded: the session is moving again — reminders and any booked retry are settled. */
  private settle(sessionId: string): void {
    const b = this.deps.store.get(sessionId)?.blocked;
    if (b) this.lastStage.set(sessionId, b.n);
    this.dropTurn(sessionId);
    this.dropRetry(sessionId);
  }

  private strip(sessionId: string, key: 'blocked' | 'pendingRetry'): void {
    const st = this.deps.store.get(sessionId);
    if (!st || st[key] === undefined) return;
    const { [key]: _drop, ...rest } = st;
    this.save(rest as SessionState);
  }

  private save(s: SessionState): void {
    void this.deps.store.set(s).catch((err: unknown) => console.error('deck: 병목 알림 상태 저장 실패', err instanceof Error ? err.message : err));
  }

  private title(sessionId: string | null, cwd: string): string {
    return clip(this.deps.titleOf(sessionId, cwd) || 'AI-MSG', TITLE_MAX);
  }
}
