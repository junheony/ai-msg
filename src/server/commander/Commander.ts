/**
 * 총사령탑 상태 머신 — `docs/superpowers/specs/2026-10-18-commander-design.md` §4·§5·§6.
 * 입력: `onSessionIdle`(ws 가 busy 를 푼 지점, 세그먼트당 1회) · `userIntervened`(send·steer) · `cardAnswered` ·
 * `observe`(서버 이벤트: 자동 턴 사용량·카드) · `set/stop/pause/resume` · `restore`. 판정·전송 결정은 모두 여기서 한다.
 * 세션별 처리는 직렬화하고, 판정 반영 직전·전송 직전에 epoch·status 를 다시 대조해 늦은 결과를 버린다.
 */
import type { CommanderView, RefusalCode, ServerMessage } from '../../shared/protocol';
import type { PermMode } from '../../shared/permission';
import { hashInput, type AuditEntry } from '../audit';
import type { PushPayload } from '../push/PushNotifier';
import { isCodexState, isGeminiState, type SessionState } from '../turn/SessionState';
import { ABORTED } from '../turn/TurnRunner';
import { doneEvidenceOk } from './digest';
import type { JudgeInput, JudgeResult } from './Judge';
import { screenInstruction } from './rules';
import { noProgress } from './signature';
import type { CommanderBudget, CommanderState, CommanderStatus, SegmentDigest, Verdict } from './types';

/** `commander_set` 을 거절하는 상태(§2) — 먼저 정지해야 한다. */
export const ACTIVE_STATUSES: readonly CommanderStatus[] = ['armed', 'sending', 'running', 'judging', 'waiting_human', 'paused'];
/** 자동 턴이 진행 중이거나 사령탑이 이미 사람을 불렀다 — BottleneckWatch 의 실패 푸시를 억제한다(§5 중복 푸시). */
const QUIET_STATUSES: readonly CommanderStatus[] = ['sending', 'running', 'judging', 'waiting_human'];
export const WATCHDOG_MS = 30_000;
export const DEFAULT_WALL_CLOCK_MS = 12 * 3600_000;
export const DEFAULT_MAX_INTERNAL_RETRIES = 5;
export const RESTART_NOTE = '재시작으로 끊김 · 재개';
const PUSH_BODY_MAX = 140;

export type CommanderSendRequest = { kind: 'commander'; sessionId: string; cwd: string; text: string; hop: number; sendKey: string; commanderNote: string };
export type CommanderResult = { ok: true } | { ok: false; code: RefusalCode | 'not_found'; message: string };

export type CommanderDeps = {
  /** `set`: 자동 턴의 재시도 예약(pendingRetry.commanderHop)을 지울 때만. */
  store: { get(id: string): SessionState | null; list(): SessionState[]; setCommander(id: string, c: CommanderState | undefined): Promise<boolean>; set(s: SessionState): Promise<void> };
  /** 판정 한 건(절대 throw 하지 않는다) + 판정을 돌린 계정(못 골랐으면 null). */
  judge: (input: JudgeInput, sessionId: string) => Promise<JudgeResult & { account: string | null }>;
  /** ws.submitServerSend — 동기로 수락(true)·거절(false). */
  send: (r: CommanderSendRequest) => boolean;
  /** busy·afterRelease 대기·pendingRetry 가 있으면 true(§6). */
  isBusy: (sessionId: string) => boolean;
  permissionModeOf: (sessionId: string) => PermMode;
  push: (p: PushPayload) => void;
  /** 하이라이트(events.record) — 판정마다 한 번. */
  record: (msg: ServerMessage) => void;
  audit: (e: AuditEntry) => void;
  broadcast: (msg: ServerMessage) => void;
  /** 설정 `commanderEnabled`. */
  enabled: () => boolean;
  /** 설정 `commanderMaxTurns`·`commanderTokenCap`. */
  limits: () => { maxTurns: number; tokenCap: number };
  titleOf?: (sessionId: string, cwd: string) => string;
  now?: () => number;
  /** 0 = watchdog 없음(테스트는 `watchdog()` 를 직접 부른다). */
  watchdogMs?: number;
};

const clip = (s: string, max: number) => { const t = s.trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

export class Commander {
  private readonly now: () => number;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(private readonly deps: CommanderDeps) {
    this.now = deps.now ?? (() => Date.now());
    const ms = deps.watchdogMs ?? WATCHDOG_MS;
    this.timer = ms > 0 ? setInterval(() => this.watchdog(), ms) : null;
    this.timer?.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 세션별 대기 중인 처리가 모두 끝날 때(테스트). */
  async settled(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  get(sessionId: string): CommanderState | null {
    return this.deps.store.get(sessionId)?.commander ?? null;
  }

  view(sessionId: string): CommanderView | null {
    const c = this.get(sessionId);
    return c ? viewOf(c) : null;
  }

  /** 기능 게이트(설정 파일 commanderEnabled). */
  enabled(): boolean {
    return this.deps.enabled();
  }

  isActive(sessionId: string): boolean {
    const c = this.get(sessionId);
    return !!c && ACTIVE_STATUSES.includes(c.status);
  }

  /** BottleneckWatch: 이 세션의 실패 푸시는 사령탑이 대신한다. */
  quiet(sessionId: string): boolean {
    const c = this.get(sessionId);
    return !!c && QUIET_STATUSES.includes(c.status);
  }

  // ── 사용자 조작 ─────────────────────────────────────────────

  set(sessionId: string, a: { goal: string; done: string; maxTurns?: number }): CommanderResult {
    if (!this.deps.enabled()) return { ok: false, code: 'commander_disabled', message: '총사령탑이 꺼져 있습니다(설정 파일 commanderEnabled)' };
    const st = this.deps.store.get(sessionId);
    if (!st) return { ok: false, code: 'commander_engine', message: '총사령탑은 deck 에서 턴을 돌린 Claude 세션에만 걸 수 있습니다' };
    if (isCodexState(st) || isGeminiState(st)) return { ok: false, code: 'commander_engine', message: '총사령탑은 Claude 세션에서만 쓸 수 있습니다' };
    const prev = st.commander;
    if (prev && ACTIVE_STATUSES.includes(prev.status)) return { ok: false, code: 'commander_active', message: '이미 총사령탑이 걸려 있습니다 — 먼저 정지하세요' };
    if (this.deps.permissionModeOf(sessionId) === 'bypassPermissions') return { ok: false, code: 'commander_bypass', message: '모두 자동 승인 세션에는 총사령탑을 걸 수 없습니다' };
    const lim = this.deps.limits();
    const maxTurns = a.maxTurns ?? lim.maxTurns;
    const budget: CommanderBudget = { maxAutoTurns: maxTurns, autoTurnsUsed: 0, maxTokens: lim.tokenCap, tokensUsed: 0, maxWallClockMs: DEFAULT_WALL_CLOCK_MS, maxInternalRetries: DEFAULT_MAX_INTERNAL_RETRIES, internalRetriesUsed: 0 };
    const c: CommanderState = { goal: a.goal, done: a.done, maxTurns, hop: 0, epoch: (prev?.epoch ?? 0) + 1, status: 'armed', startedAtMs: this.now(), budget, lastVerdicts: [], processedDigestIds: [], signatures: [] };
    void this.save(sessionId, c);
    this.dropRetry(sessionId);
    // 턴 중이면 그 턴은 사용자 턴: idle 이 된 뒤(onSessionIdle) 첫 지시부터.
    if (!this.deps.isBusy(sessionId)) void this.enqueue(sessionId, () => this.sendInstruction(sessionId, c.epoch, firstInstruction(c)));
    return { ok: true };
  }

  stop(sessionId: string, epoch: number): CommanderResult {
    const c = this.get(sessionId);
    const bad = this.checkEpoch(c, epoch);
    if (bad || !c) return bad ?? notFound();
    if (c.status === 'stopped' || c.status === 'done' || c.status === 'idle') return { ok: true };
    // 진행 중 자동 턴은 끊지 않는다(기존 중단 버튼은 그대로).
    const next: CommanderState = { ...c, status: 'stopped', epoch: c.epoch + 1, note: '정지됨' };
    delete next.pausedBy;
    void this.save(sessionId, next);
    this.dropRetry(sessionId);
    this.notify(sessionId, '사령탑 · 정지됨');
    return { ok: true };
  }

  pause(sessionId: string, epoch: number): CommanderResult {
    const c = this.get(sessionId);
    const bad = this.checkEpoch(c, epoch);
    if (bad || !c) return bad ?? notFound();
    if (!ACTIVE_STATUSES.includes(c.status) || c.status === 'paused') return { ok: true };
    void this.save(sessionId, { ...c, status: 'paused', epoch: c.epoch + 1, pausedBy: 'user', note: '일시 정지' });
    this.dropRetry(sessionId);
    return { ok: true };
  }

  resume(sessionId: string, epoch: number): CommanderResult {
    if (!this.deps.enabled()) return { ok: false, code: 'commander_disabled', message: '총사령탑이 꺼져 있습니다(설정 파일 commanderEnabled)' };
    const c = this.get(sessionId);
    const bad = this.checkEpoch(c, epoch);
    if (bad || !c) return bad ?? notFound();
    if (c.status !== 'paused' && c.status !== 'waiting_human') return { ok: false, code: 'commander_active', message: '재개할 수 있는 상태가 아닙니다' };
    if (this.deps.permissionModeOf(sessionId) === 'bypassPermissions') return { ok: false, code: 'commander_bypass', message: '모두 자동 승인 세션에서는 재개할 수 없습니다' };
    const next: CommanderState = { ...c, status: 'armed', epoch: c.epoch + 1 };
    delete next.pausedBy;
    delete next.note;
    void this.save(sessionId, next);
    if (!this.deps.isBusy(sessionId)) void this.enqueue(sessionId, () => this.sendInstruction(sessionId, next.epoch, firstInstruction(next)));
    return { ok: true };
  }

  /** send·steer: 어느 활성 상태에서든 일시 정지(수동 재개). 진행 중 턴은 끊지 않고, 그 세그먼트는 판정하지 않는다. */
  userIntervened(sessionId: string): void {
    const c = this.get(sessionId);
    if (!c || !ACTIVE_STATUSES.includes(c.status) || c.status === 'paused') return;
    void this.save(sessionId, { ...c, status: 'paused', epoch: c.epoch + 1, pausedBy: 'user', note: '사용자 개입으로 일시 정지' });
  }

  /** 권한·질문 카드에 답했다 — 카드 때문에 기다리던 것만 자동 재개(같은 세그먼트를 이어서 판정). */
  cardAnswered(sessionId: string): void {
    const c = this.get(sessionId);
    if (!c || c.status !== 'waiting_human' || c.pausedBy !== 'card') return;
    const next: CommanderState = { ...c, status: 'running', epoch: c.epoch + 1 };
    delete next.pausedBy;
    delete next.note;
    void this.save(sessionId, next);
  }

  /**
   * 자동 턴이 한도로 실패해 재시도가 예약된 채 세션이 쉬었다(ws: 그 예약이 세그먼트를 열어 둬 판정은 재시도 뒤로 밀린다):
   * 몇 시간 조용하지 않게 예약 시각을 사유(note)에 남기고 푸시 1회. 같은 예약을 다시 알리지 않는다.
   */
  retryBooked(sessionId: string, atMs: number): void {
    const c = this.get(sessionId);
    if (!c || c.status !== 'running' || atMs <= this.now()) return;
    const note = `자동 재시도 예정(${hhmm(atMs)})`;
    if (c.note === note) return;
    void this.save(sessionId, { ...c, note });
    this.notify(sessionId, `사령탑 · 한도에 걸려 ${note}`);
  }

  // ── 서버 이벤트 ─────────────────────────────────────────────

  /** 모든 서버 이벤트(ws notify): 자동 턴의 사용량을 예산에 더하고, 자동 턴 중 뜬 카드는 사람 필요로. */
  observe(msg: ServerMessage): void {
    if (msg.type === 'turn_result' && msg.auto === 'commander' && msg.sessionId) {
      const c = this.get(msg.sessionId);
      const u = msg.badge?.usage;
      if (!c || !u) return;
      const n = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
      if (n <= 0) return;
      const next = { ...c, budget: { ...c.budget, tokensUsed: c.budget.tokensUsed + n } };
      void this.save(msg.sessionId, next);
      if (next.status === 'running') this.checkRunning(msg.sessionId);
      return;
    }
    if ((msg.type === 'permission_request' || msg.type === 'question_request') && msg.sessionId) {
      const c = this.get(msg.sessionId);
      // 카드 자체가 푸시된다(PushNotifier) — 사령탑 푸시는 따로 내지 않는다.
      if (c?.status === 'running') void this.save(msg.sessionId, { ...c, status: 'waiting_human', pausedBy: 'card', note: msg.type === 'permission_request' ? '권한 카드 응답 대기' : '질문 카드 응답 대기' });
    }
  }

  /** §5 실행 중 watchdog(30초): 진행 중 자동 턴의 예산·시간이 넘으면 다음 자동 행동을 막는다(턴은 끊지 않음). */
  watchdog(): void {
    for (const st of this.deps.store.list()) if (st.commander?.status === 'running') this.checkRunning(st.sessionId);
  }

  /**
   * ws 가 busy 를 푼 지점(세그먼트당 1회). armed → 첫 지시(판정 없음), running → 판정. 그 밖의 상태는 무시
   * (paused: 사용자가 끼어든 세그먼트, waiting_human: 이미 사람에게 넘김).
   */
  onSessionIdle(sessionId: string, digest: SegmentDigest): Promise<void> {
    const c = this.get(sessionId);
    if (!c || !this.deps.enabled()) return Promise.resolve();
    if (c.status === 'armed') return this.enqueue(sessionId, () => this.sendInstruction(sessionId, c.epoch, firstInstruction(c)));
    if (c.status === 'running') return this.enqueue(sessionId, () => this.judgeSegment(sessionId, c.epoch, digest));
    return Promise.resolve();
  }

  /** §6 재시작 뒤: 활성이던 사령탑은 재전송·재판정 없이 사람에게(waiting_human + 푸시 1회). */
  restore(states: SessionState[]): void {
    for (const st of states) {
      const c = st.commander;
      if (!c || !['armed', 'sending', 'running', 'judging'].includes(c.status)) continue;
      void this.save(st.sessionId, { ...c, status: 'waiting_human', epoch: c.epoch + 1, pausedBy: 'restart', note: RESTART_NOTE });
      this.notify(st.sessionId, `사령탑 · 판단이 필요합니다 — ${RESTART_NOTE}`);
    }
  }

  // ── 내부 ────────────────────────────────────────────────────

  private checkEpoch(c: CommanderState | null, epoch: number): CommanderResult | null {
    if (!c) return notFound();
    if (c.epoch !== epoch) return { ok: false, code: 'commander_stale_epoch', message: '화면이 오래됐습니다 — 최신 상태를 보고 다시 해 주세요' };
    return null;
  }

  private checkRunning(sessionId: string): void {
    const c = this.get(sessionId);
    if (!c || c.status !== 'running') return;
    const over = hardOver(c, this.now());
    if (over) this.toHuman(sessionId, c, `${over} — 다음 자동 행동 금지`);
  }

  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn).catch((err: unknown) => console.error('deck: 총사령탑 처리 실패', err instanceof Error ? err.message : err));
    this.chains.set(sessionId, run);
    void run.then(() => { if (this.chains.get(sessionId) === run) this.chains.delete(sessionId); });
    return run;
  }

  /** §6 전송 순서: sendKey 와 sending 을 먼저 저장 → 같은 동기 블록에서 epoch·status·busy 확인 후 전송 → 수락되면 running. */
  private async sendInstruction(sessionId: string, epoch: number, text: string): Promise<void> {
    let c = this.get(sessionId);
    if (!c || c.epoch !== epoch || (c.status !== 'armed' && c.status !== 'judging')) return;
    if (!this.deps.enabled()) return;
    const over = turnCapOver(c) ?? hardOver(c, this.now());
    if (over) { this.toHuman(sessionId, c, over); return; }
    if (this.deps.permissionModeOf(sessionId) === 'bypassPermissions') { this.toHuman(sessionId, c, '모두 자동 승인 모드라 자동 지시를 보내지 않았습니다'); return; }
    const hop = c.hop + 1;
    const sendKey = `${epoch}:${hop}`;
    if (c.sendKey === sendKey) return;
    await this.save(sessionId, { ...c, status: 'sending', hop, sendKey });
    c = this.get(sessionId);
    if (!c || c.epoch !== epoch || c.status !== 'sending' || c.sendKey !== sendKey) return;
    const st = this.deps.store.get(sessionId);
    if (!st || this.deps.isBusy(sessionId)) { this.toHuman(sessionId, c, '세션이 실행 중이라 자동 지시를 보내지 않았습니다'); return; }
    const ok = this.deps.send({ kind: 'commander', sessionId, cwd: st.cwd, text, hop, sendKey, commanderNote: commanderNote(c, hop) });
    if (!ok) { this.toHuman(sessionId, c, '자동 지시를 보내지 못했습니다'); return; }
    const saved = this.save(sessionId, { ...c, status: 'running', budget: { ...c.budget, autoTurnsUsed: c.budget.autoTurnsUsed + 1 } });
    this.deps.audit({ kind: 'commander_send', ts: new Date(this.now()).toISOString(), sessionId, epoch, hop, sendKey, inputSha256: hashInput(text) });
    await saved;
  }

  private async judgeSegment(sessionId: string, epoch: number, digest: SegmentDigest): Promise<void> {
    let c = this.get(sessionId);
    if (!c || c.epoch !== epoch || c.status !== 'running') return;
    if (c.processedDigestIds.includes(digest.digestId)) return;
    // digestId 를 먼저 남긴 뒤 행동한다(같은 digest 두 번 판정 없음). 세그먼트 안 하위 턴(cap·failover·retry)은 내부 재시도로 센다
    // (bg 이어가기는 정상 작업이라 세지 않는다 — digest.retries).
    // running 의 사유는 재시도 예약 알림(retryBooked)뿐 — 세그먼트가 끝났으니 지운다.
    const { note: _retryNote, ...rest } = c;
    c = {
      ...rest, status: 'judging',
      processedDigestIds: [...c.processedDigestIds, digest.digestId].slice(-8),
      signatures: [...c.signatures, digest.signature].slice(-3),
      budget: { ...c.budget, internalRetriesUsed: c.budget.internalRetriesUsed + digest.retries },
    };
    await this.save(sessionId, c);
    // 사용자가 ■중단한 세그먼트(ws 는 개입으로도 알린다 — 이중 방어): 판정하지 않고 사람에게.
    if (digest.failure.errorText === ABORTED) { this.toHuman(sessionId, c, '사용자가 자동 턴을 중단했습니다'); return; }
    if (digest.turns === 0) { this.toHuman(sessionId, c, '자동 턴이 실행되지 않았습니다'); return; }
    // 예산이 이미 넘었으면 판정 비용도 쓰지 않는다.
    const over = hardOver(c, this.now());
    if (over) { this.toHuman(sessionId, c, over); return; }
    const input: JudgeInput = { goal: c.goal, done: c.done, hop: c.hop, maxTurns: c.maxTurns, lastVerdicts: c.lastVerdicts, digest };
    const r = await this.deps.judge(input, sessionId);
    const v = r.verdict;
    this.deps.audit({ kind: 'commander_verdict', ts: new Date(this.now()).toISOString(), sessionId, epoch, digestId: digest.digestId, verdict: v.verdict, reason: v.reason, judgeAccount: r.account, usage: r.usage });
    const cur = this.get(sessionId);
    if (!cur) return;
    // 판정 비용은 늦게 왔어도 공유 예산에 들어간다.
    const budget = r.usage ? { ...cur.budget, tokensUsed: cur.budget.tokensUsed + r.usage.totalTokens } : cur.budget;
    if (cur.epoch !== epoch || cur.status !== 'judging') {
      if (r.usage) await this.save(sessionId, { ...cur, budget });
      return;
    }
    const at = this.now();
    const judged: CommanderState = { ...cur, budget, lastVerdicts: [...cur.lastVerdicts, v].slice(-2), verdictAtMs: at };
    await this.save(sessionId, judged);
    this.deps.record({ type: 'commander', sessionId, ...viewOf(judged) });
    if (v.verdict === 'done') {
      if (v.evidence && doneEvidenceOk(digest, v.evidence.testRunId)) {
        const next: CommanderState = { ...judged, status: 'done', note: v.reason };
        delete next.pausedBy;
        await this.save(sessionId, next);
        this.notify(sessionId, `사령탑 · 목표 달성 — ${v.reason}`);
      } else this.toHuman(sessionId, judged, '완료 근거 부족');
      return;
    }
    if (v.verdict === 'human') { this.toHuman(sessionId, judged, v.reason); return; }
    const why = continueBlock(judged, v, r.failed, at);
    if (why) { this.toHuman(sessionId, judged, why); return; }
    await this.sendInstruction(sessionId, epoch, v.next!);
  }

  /** 정지·일시 정지·새로 걸기: 자동 턴의 재시도 예약은 사령탑과 함께 간다(남으면 isBusy 가 armed 의 첫 지시를 막는다). */
  private dropRetry(sessionId: string): void {
    const st = this.deps.store.get(sessionId);
    if (!st?.pendingRetry?.commanderHop) return;
    const { pendingRetry: _drop, ...rest } = st;
    void this.deps.store.set(rest as SessionState).catch((err: unknown) => console.error('deck: 총사령탑 재시도 예약 삭제 실패', err instanceof Error ? err.message : err));
  }

  private toHuman(sessionId: string, c: CommanderState, reason: string): void {
    void this.save(sessionId, { ...c, status: 'waiting_human', pausedBy: 'check', note: reason });
    this.notify(sessionId, `사령탑 · 판단이 필요합니다 — ${reason}`);
  }

  private notify(sessionId: string, body: string): void {
    const cwd = this.deps.store.get(sessionId)?.cwd ?? '';
    const title = clip(this.deps.titleOf?.(sessionId, cwd) || cwd.split('/').filter(Boolean).pop() || 'deck', 60);
    try {
      this.deps.push({ kind: 'commander', title, body: clip(body, PUSH_BODY_MAX), sessionId, tag: `commander:${sessionId}` });
    } catch (err) {
      console.error('deck: 총사령탑 푸시 실패', err instanceof Error ? err.message : err);
    }
  }

  /** 세션 맵은 동기로 바뀐다(store.get 이 곧바로 새 값) — 디스크 쓰기만 기다릴 수 있다. */
  private save(sessionId: string, c: CommanderState): Promise<void> {
    const p = this.deps.store.setCommander(sessionId, c).then(() => undefined, (err: unknown) => console.error('deck: 총사령탑 상태 저장 실패', err instanceof Error ? err.message : err));
    this.deps.broadcast({ type: 'commander', sessionId, ...viewOf(c) });
    return p;
  }
}

function notFound(): CommanderResult {
  return { ok: false, code: 'not_found', message: '이 세션에는 총사령탑이 없습니다' };
}

export function viewOf(c: CommanderState): CommanderView {
  const v = c.lastVerdicts[c.lastVerdicts.length - 1];
  return {
    state: { status: c.status, hop: c.hop, maxTurns: c.maxTurns, epoch: c.epoch, goal: c.goal, done: c.done, budget: { ...c.budget } },
    ...(v ? { lastVerdict: { verdict: v.verdict, reason: v.reason, ...(v.next !== undefined ? { next: v.next } : {}), ...(v.evidence ? { evidence: v.evidence } : {}), atMs: c.verdictAtMs ?? c.startedAtMs } } : {}),
    ...(c.note ? { note: c.note } : {}),
  };
}

/** §4 첫 지시: 판정 없이 목표·완료 조건 원문. 재개(armed) 때도 같은 문구로 다시 시작한다. */
export function firstInstruction(c: Pick<CommanderState, 'goal' | 'done'>): string {
  return `목표: ${c.goal}\n완료 조건: ${c.done}`;
}

/** §6 훅 지점의 systemNote 문구. */
export function commanderNote(c: Pick<CommanderState, 'goal' | 'done' | 'maxTurns'>, hop: number): string {
  return `[deck] deck 총사령탑 자동 지시 ${hop}/${c.maxTurns} — 목표: ${c.goal} 완료 조건: ${c.done} 되돌리기 어려운 행동은 하지 말고 멈춰서 보고하세요.`;
}

function turnCapOver(c: CommanderState): string | null {
  return c.budget.autoTurnsUsed >= c.budget.maxAutoTurns ? `턴 상한 도달(${c.budget.autoTurnsUsed}/${c.budget.maxAutoTurns})` : null;
}

/** 진행 중에도 검사하는 예산(토큰·벽시계·내부 재시도). 턴 수는 다음 전송 때만 본다. */
export function hardOver(c: CommanderState, now: number): string | null {
  const b = c.budget;
  if (b.tokensUsed >= b.maxTokens) return '토큰 예산 초과';
  if (now - c.startedAtMs >= b.maxWallClockMs) return '시간 상한 도달';
  if (b.internalRetriesUsed > b.maxInternalRetries) return '내부 재시도 상한 초과';
  return null;
}

/** §4 전이 규칙: continue 라도 하나라도 걸리면 사람에게. 이유(없으면 null). */
function continueBlock(c: CommanderState, v: Verdict, failed: boolean, now: number): string | null {
  if (failed) return v.reason;
  const over = turnCapOver(c) ?? hardOver(c, now);
  if (over) return over;
  if (noProgress(c.signatures)) return '진척 없음';
  if (v.risk !== 'none') return `되돌리기 어려운 행동 가능성(${v.risk ?? '미표시'})`;
  if (!v.next) return '다음 지시 없음';
  const hit = screenInstruction(v.next);
  if (hit) return `차단 문구가 든 지시(${hit})`;
  if (v.confidence === 'low') return '판정 확신 낮음';
  return null;
}
