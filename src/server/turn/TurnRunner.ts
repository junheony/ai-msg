import path from 'node:path';
import type { Account } from '../../shared/accounts';
import { DEFAULT_MODEL, type ClaudeModel } from '../../shared/models';
import type { ServerMessage } from '../../shared/protocol';
import type { PermissionDecision } from '../../shared/turn-types';
import { ZERO_USAGE } from '../../shared/turn-types';
import { appendAudit, hashInput } from '../audit';
import type { Engine, EngineResult, RateLimitSignal } from '../engine/Engine';
import { COOLDOWN_MS, classifyFailure } from '../engine/limitDetect';
import { chooseAccount } from '../routing/AccountRouter';
import { readAllCooldownsMs, writeCooldown } from '../routing/cooldown';
import { resolveModel } from '../routing/ModelPolicy';
import type { SessionIndex } from '../sessions/SessionIndex';
import { moveSession } from '../sessions/SessionMover';
import { projectSlug } from '../sessions/slug';
import type { UsageService } from '../usage/UsageService';
import type { SessionState, SessionStateStore } from './SessionState';

export type TurnSink = {
  emit(msg: ServerMessage): void;
  askPermission(req: { turnId: string; toolName: string; input: Record<string, unknown>; toolUseId: string }): Promise<PermissionDecision>;
  signal: AbortSignal;
};

export type TurnParams = { turnId: string; cwd: string; sessionId: string | null; text: string; model?: ClaudeModel };

export type TurnRunnerDeps = {
  engine: Engine;
  usage: UsageService;
  index: SessionIndex;
  store: SessionStateStore;
  cooldownDir: string;
  protectedAccount: Account | null;
  auditFile: string;
  projectsRoots: Record<Account, string>;
  move?: typeof moveSession;
  now?: () => number;
  maxRetries?: number;
};

const LABEL: Record<Account, string> = { a: 'A', b: 'B', c: 'C' };

type Attempt = { result: EngineResult | null; rateLimit: RateLimitSignal | null; sessionId: string | null; compacted: boolean };

export class TurnRunner {
  private readonly move: typeof moveSession;
  private readonly now: () => number;
  private readonly maxRetries: number;

  constructor(private readonly deps: TurnRunnerDeps) {
    this.move = deps.move ?? moveSession;
    this.now = deps.now ?? (() => Date.now());
    this.maxRetries = deps.maxRetries ?? 2;
  }

  private async relocate(state: SessionState, to: Account, sink: TurnSink, turnId: string): Promise<SessionState | null> {
    const r = await this.move({ sessionId: state.sessionId, sourceProjectDir: state.projectDir, targetProjectsRoot: this.deps.projectsRoots[to] });
    if (!r.ok) {
      sink.emit({ type: 'error', turnId, message: `세션 이전 실패(${r.error}) — ${LABEL[state.account]} 계정 유지` });
      return null;
    }
    const next = { ...state, account: to, projectDir: r.targetDir };
    await this.deps.store.set(next);
    return next;
  }

  private async attempt(p: TurnParams, account: Account, model: ClaudeModel, cwd: string, resumeSessionId: string | null, sink: TurnSink): Promise<Attempt> {
    const out: Attempt = { result: null, rateLimit: null, sessionId: resumeSessionId, compacted: false };
    const events = this.deps.engine.runTurn({
      account,
      cwd,
      resumeSessionId,
      model,
      prompt: p.text,
      signal: sink.signal,
      onPermission: async (pr) => {
        const decision = await sink.askPermission({ turnId: p.turnId, ...pr });
        await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: p.turnId, sessionId: out.sessionId, toolName: pr.toolName, decision, inputSha256: hashInput(pr.input) });
        return decision;
      },
    });
    for await (const ev of events) {
      switch (ev.kind) {
        case 'init': out.sessionId = ev.sessionId; break;
        case 'delta': sink.emit({ type: 'delta', turnId: p.turnId, text: ev.text }); break;
        case 'tool_call': sink.emit({ type: 'tool_call', turnId: p.turnId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'tool_result': sink.emit({ type: 'tool_result', turnId: p.turnId, toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
        case 'rate_limit':
          out.rateLimit = ev.info;
          this.deps.usage.applyTurn(account, { ...(ev.info.fiveHour ? { fiveHour: ev.info.fiveHour } : {}), ...(ev.info.weekly ? { weekly: ev.info.weekly } : {}) });
          break;
        case 'compact': out.compacted = true; break;
        case 'result': out.result = ev; if (ev.sessionId) out.sessionId = ev.sessionId; break;
      }
    }
    return out;
  }

  async run(p: TurnParams, sink: TurnSink): Promise<void> {
    const { deps } = this;
    let state: SessionState | null = null;
    if (p.sessionId) {
      state = deps.store.get(p.sessionId);
      if (!state) {
        const e = deps.index.lookup(p.sessionId);
        if (!e) { sink.emit({ type: 'error', turnId: p.turnId, message: `세션을 찾을 수 없습니다: ${p.sessionId}` }); return; }
        state = { sessionId: e.sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: DEFAULT_MODEL };
      }
    }
    const cwd = state?.cwd ?? p.cwd;
    const sessionDefault = state?.defaultModel ?? DEFAULT_MODEL;
    const wanted = p.model ?? sessionDefault;
    const routerBase = { usage: deps.usage.snapshot(), nowMs: this.now(), protectedAccount: deps.protectedAccount, needFable: wanted === 'fable' };

    const first = chooseAccount({
      ...routerBase,
      current: state?.account ?? null,
      lastTurnAtMs: state?.lastTurnAtMs ?? null,
      justCompacted: state?.justCompacted ?? false,
      cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now()),
    });
    let account = first.account;
    let reason = first.reason;
    if (state && account !== state.account) {
      const moved = await this.relocate(state, account, sink, p.turnId);
      if (moved) state = moved;
      else { account = state.account; reason = `이전 실패 · ${LABEL[account]} 유지`; }
    }

    const tried: Account[] = [];
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const fable = deps.usage.snapshot().accounts[account].fable?.usedPct ?? null;
      const { model, note } = resolveModel(p.model, sessionDefault, fable);
      sink.emit({ type: 'turn_started', turnId: p.turnId, sessionId: state?.sessionId ?? null, cwd, account, model, reason, attempt });

      const a = await this.attempt(p, account, model, cwd, state?.sessionId ?? null, sink);
      const res: EngineResult = a.result ?? { kind: 'result', sessionId: a.sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', errorKind: null, terminalReason: null };
      const sessionId = a.sessionId ?? state?.sessionId ?? null;
      if (sessionId) {
        state = {
          sessionId,
          cwd,
          account,
          // Only place a slug is derived from cwd: the CLI computed it from the same string we passed.
          projectDir: state?.projectDir ?? path.join(deps.projectsRoots[account], projectSlug(cwd)),
          lastTurnAtMs: res.ok ? this.now() : (state?.lastTurnAtMs ?? null),
          justCompacted: a.compacted,
          defaultModel: sessionDefault,
        };
        await deps.store.set(state);
      }

      const failure = classifyFailure({ ok: res.ok, errorText: res.errorText, errorKind: res.errorKind, rateLimitStatus: a.rateLimit?.status ?? null });
      const badge = { account, model, reason, usage: res.usage, modelNote: note };
      if (res.ok || failure === 'other' || failure === null || attempt === this.maxRetries || sink.signal.aborted) {
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId: sessionId ?? '', ok: res.ok, text: res.text, badge, errorText: res.errorText });
        return;
      }

      // Spec §8: limit/auth → cooldown (shared with claude-pick) → move → retry on the next account.
      writeCooldown(deps.cooldownDir, account, this.now() + COOLDOWN_MS[failure]);
      tried.push(account);
      const next = chooseAccount({
        ...routerBase,
        usage: deps.usage.snapshot(),
        nowMs: this.now(),
        current: account,
        lastTurnAtMs: null,
        justCompacted: false,
        cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now()),
        exclude: tried,
      });
      const why = failure === 'limit' ? '한도 도달' : '인증 실패';
      if (next.account === account) {
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId: sessionId ?? '', ok: false, text: '', badge, errorText: `${why} · 대안 계정 없음 · ${res.errorText ?? ''}`.trim() });
        return;
      }
      if (state) {
        const moved = await this.relocate(state, next.account, sink, p.turnId);
        if (!moved) {
          sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId: sessionId ?? '', ok: false, text: '', badge, errorText: `${why} · 세션 이전 실패 · ${res.errorText ?? ''}`.trim() });
          return;
        }
        state = moved;
      }
      sink.emit({ type: 'turn_retry', turnId: p.turnId, fromAccount: account, toAccount: next.account, reason: `${why} → ${next.reason}`, attempt: attempt + 1 });
      reason = `재시도(${why}) · ${next.reason}`;
      account = next.account;
    }
  }
}
