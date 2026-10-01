import fs from 'node:fs/promises';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import { DEFAULT_CODEX_MODEL, DEFAULT_MODEL, DEFAULT_SANDBOX, defaultSandbox, effortFor, isClaudeModel, isCodexModel, type AnyModel, type ClaudeModel, type CodexModel, type CodexSandbox, type Effort, type EngineChoice } from '../../shared/models';
import type { ServerMessage } from '../../shared/protocol';
import { promptWithFiles, type Attachment, type AttachmentStore } from '../attachments/AttachmentStore';
import { ZERO_USAGE, type PermissionDecision, type QuestionAnswers, type TurnUsage } from '../../shared/turn-types';
import { appendAudit, hashInput } from '../audit';
import type { CodexEngine } from '../engine/CodexEngine';
import { findRolloutFile, readRolloutRateLimits } from '../engine/codexRollout';
import { ruleString, sessionUpdates, type Engine, type EngineEvent, type EngineResult, type LiveInput, type PermissionRequest, type QuestionRequest, type RateLimitSignal } from '../engine/Engine';
import { COOLDOWN_MS, classifyFailure } from '../engine/limitDetect';
import { displayError, redactSecrets } from '../engine/redact';
import { chooseAccount } from '../routing/AccountRouter';
import { chooseEngine } from '../routing/EngineChoice';
import { readAllCooldownsMs, writeCooldown } from '../routing/cooldown';
import { resolveModel } from '../routing/ModelPolicy';
import type { SessionIndex } from '../sessions/SessionIndex';
import { moveSession } from '../sessions/SessionMover';
import { projectSlug } from '../sessions/slug';
import type { UsageService } from '../usage/UsageService';
import { isCodexState, type ClaudeSessionState, type CodexSessionState, type SessionState, type SessionStateStore } from './SessionState';

export type TurnSink = {
  emit(msg: ServerMessage): void;
  askPermission(req: PermissionRequest & { turnId: string; sessionId: string | null; cwd: string }): Promise<PermissionDecision>;
  /** D8: an AskUserQuestion card; null = unanswered (timeout, abort, turn end). */
  askQuestion(req: QuestionRequest & { turnId: string; sessionId: string | null; cwd: string }): Promise<QuestionAnswers | null>;
  signal: AbortSignal;
};

export type TurnParams = {
  turnId: string;
  cwd: string;
  sessionId: string | null;
  text: string;
  /** Claude or GPT model; a model of the other engine is ignored (the session's default applies). */
  model?: AnyModel;
  /** Reasoning effort for this turn; dropped if the resolved model does not support it. */
  effort?: Effort;
  /** New sessions only (D3). */
  engine?: EngineChoice;
  /** New Codex sessions only (D2). */
  sandbox?: CodexSandbox;
  /** Ids from POST /api/attachments (D7). */
  attachments?: string[];
};

export type TurnRunnerDeps = {
  engine: Engine;
  /** Null = Codex disabled (D11); tests inject a fake with just runTurn. */
  codex: Pick<CodexEngine, 'runTurn'> | null;
  /** Null = no attachment store; any attachment id then fails the turn as missing. */
  attachments: AttachmentStore | null;
  codexSessionsRoot: string;
  usage: UsageService;
  index: SessionIndex;
  store: SessionStateStore;
  cooldownDir: string;
  protectedAccount: Account | null;
  auditFile: string;
  /** 자동 승인 (read per tool call / per new GPT session); absent = off. */
  autoApprove?: () => boolean;
  projectsRoots: Record<Account, string>;
  move?: typeof moveSession;
  findRollout?: typeof findRolloutFile;
  readRateLimits?: typeof readRolloutRateLimits;
  now?: () => number;
  maxRetries?: number;
};

const LABEL: Record<Account, string> = { a: 'A', b: 'B', c: 'C' };

/** `rest`: the engine stream after the first result (background continuations); `live`: its input handle. */
type Attempt = {
  result: EngineResult | null; rateLimit: RateLimitSignal | null; sessionId: string | null; compacted: boolean; initCwd: string | null;
  rest: AsyncIterator<EngineEvent>; live: LiveInput | null; bgTasks: string[];
};

/** A user message for a session whose process is still open for background work (see `followUp`). */
export type FollowUpParams = { turnId: string; text: string; attachments?: string[]; model?: AnyModel; clientRef?: string };

/** The mutable "which deck turn is the process working for now" — permission cards and events follow it. */
type Cursor = { turnId: string };

type LiveSession = { submit(f: FollowUpParams, attachments: Attachment[]): boolean };

/** What 이 세션 accepted: allow rules as rule strings, added directories, and acceptEdits. */
type SessionGrants = { rules: string[]; dirs: string[]; acceptEdits: boolean };

function addGrants(g: SessionGrants, pr: PermissionRequest): void {
  // The same sanitized set the engine returned to the SDK: nothing broader is ever remembered.
  for (const u of sessionUpdates(pr)) {
    if (u.type === 'addRules') {
      for (const r of u.rules) {
        const rule = ruleString(r);
        if (!g.rules.includes(rule)) g.rules.push(rule);
      }
    } else if (u.type === 'addDirectories') {
      for (const d of u.directories) if (!g.dirs.includes(d)) g.dirs.push(d);
    } else if (u.type === 'setMode' && u.mode === 'acceptEdits') {
      g.acceptEdits = true;
    }
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

/** First non-empty line of the prompt, ≤ 80 chars — the sidebar title of a Codex session (D4). */
function titleOf(text: string): string {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return first.length > 80 ? first.slice(0, 80) : first || '(제목 없음)';
}

export class TurnRunner {
  private readonly move: typeof moveSession;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly findRollout: typeof findRolloutFile;
  private readonly readRateLimits: typeof readRolloutRateLimits;
  private gptCooldownUntil: number | null = null;
  /** Claude sessions whose process stays open for background work, by session id. */
  private readonly live = new Map<string, LiveSession>();

  constructor(private readonly deps: TurnRunnerDeps) {
    this.move = deps.move ?? moveSession;
    this.now = deps.now ?? (() => Date.now());
    this.maxRetries = deps.maxRetries ?? 2;
    this.findRollout = deps.findRollout ?? findRolloutFile;
    this.readRateLimits = deps.readRateLimits ?? readRolloutRateLimits;
  }

  /**
   * A message for a session that is busy only because its process waits for background work:
   * it is written into that process's input (streaming-input mode — the CLI takes it as the next
   * user turn; the background tasks keep running). While a background continuation is streaming
   * the message waits in deck and goes in right after that continuation's result. Same process,
   * so the account and model stay those of the running process. False = no such process
   * (the caller refuses the send as busy).
   */
  followUp(sessionId: string, f: FollowUpParams): boolean {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    let attachments: Attachment[] = [];
    if (f.attachments?.length) {
      const r = this.deps.attachments?.resolve([...new Set(f.attachments)]) ?? { found: [], missing: f.attachments };
      if (r.missing.length) return false;
      attachments = r.found;
    }
    return entry.submit(f, attachments);
  }

  /** Session ids whose process is held open for background work. */
  backgroundSessions(): string[] {
    return [...this.live.keys()];
  }

  /** D3: set after a Codex limit failure; consulted by chooseEngine for 'auto'. In memory only. */
  gptCooldownUntilMs(): number | null {
    return this.gptCooldownUntil;
  }

  private async relocate(state: ClaudeSessionState, to: Account, sink: TurnSink, turnId: string): Promise<ClaudeSessionState | null> {
    const r = await this.move({ sessionId: state.sessionId, sourceProjectDir: state.projectDir, targetProjectsRoot: this.deps.projectsRoots[to] });
    if (!r.ok) {
      sink.emit({ type: 'turn_notice', turnId, sessionId: state.sessionId, cwd: state.cwd, message: `세션 이전 실패(${r.error}) — ${LABEL[state.account]} 계정 유지` });
      return null;
    }
    const next = { ...state, account: to, projectDir: r.targetDir };
    await this.deps.store.set(next);
    return next;
  }

  private async attempt(p: TurnParams, account: Account, model: ClaudeModel, cwd: string, resumeSessionId: string | null, sink: TurnSink, grants: SessionGrants, attachments: Attachment[], cur: Cursor): Promise<Attempt> {
    const scope = () => ({ turnId: cur.turnId, sessionId: out.sessionId, cwd });
    // The effort applies to the resolved model (a Fable → Opus downgrade keeps it when Opus supports it).
    const effort = effortFor(model, p.effort);
    const events = this.deps.engine.runTurn({
      account,
      cwd,
      resumeSessionId,
      model,
      ...(effort ? { effort } : {}),
      prompt: p.text,
      attachments,
      signal: sink.signal,
      allowRules: [...grants.rules],
      allowDirs: [...grants.dirs],
      ...(grants.acceptEdits ? { permissionMode: 'acceptEdits' as const } : {}),
      onPermission: async (pr) => {
        const decision = await sink.askPermission({ turnId: cur.turnId, sessionId: out.sessionId, cwd, ...pr });
        if (decision === 'session') addGrants(grants, pr);
        // Review M6: the audit log is best-effort; losing it must not lose the user's answer.
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: pr.toolName, decision, inputSha256: hashInput(pr.input) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
        return decision;
      },
      ...(this.deps.autoApprove ? { autoApprove: this.deps.autoApprove } : {}),
      onAutoApproved: async (pr) => {
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: pr.toolName, decision: 'auto', inputSha256: hashInput(pr.input) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
      },
      onQuestion: async (q) => {
        const answers = await sink.askQuestion({ turnId: cur.turnId, sessionId: out.sessionId, cwd, ...q });
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: 'AskUserQuestion', decision: answers ? 'answered' : 'deny', inputSha256: hashInput(q.questions) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
        return answers;
      },
      onQuestionMalformed: async (input) => {
        try {
          const questions = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : input;
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: 'AskUserQuestion', decision: 'deny', inputSha256: hashInput(questions) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
      },
      onLive: (l) => { out.live = l; },
    });
    const rest = events[Symbol.asyncIterator]();
    const out: Attempt = { result: null, rateLimit: null, sessionId: resumeSessionId, compacted: false, initCwd: null, rest, live: null, bgTasks: [] };
    // The first result ends the attempt; whatever follows (background continuations) is `rest`.
    while (!out.result) {
      const n = await rest.next();
      if (n.done) break;
      const ev = n.value;
      switch (ev.kind) {
        case 'init': out.sessionId = ev.sessionId; if (ev.cwd) out.initCwd = ev.cwd; break;
        case 'background': out.bgTasks = ev.tasks; sink.emit({ type: 'turn_background', ...scope(), tasks: ev.tasks }); break;
        case 'continue': break;
        case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
        case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
        case 'rate_limit':
          out.rateLimit = ev.info;
          this.deps.usage.applyTurn(account, { ...(ev.info.fiveHour ? { fiveHour: ev.info.fiveHour } : {}), ...(ev.info.weekly ? { weekly: ev.info.weekly } : {}) });
          break;
        case 'compact': out.compacted = true; break;
        case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
        case 'task_done': sink.emit({ type: 'task_done', ...scope(), status: ev.status, summary: redactSecrets(ev.summary) }); break;
        case 'result': out.result = ev; if (ev.sessionId) out.sessionId = ev.sessionId; break;
      }
    }
    return out;
  }

  /**
   * After the turn's own result: while the process stays open for background work, stream what
   * it does next into the same pane. Each later result closes a segment — a background
   * continuation (new turn id `<turnId>:bg<n>`, reason 백그라운드 계속) or a follow-up the user
   * sent meanwhile (its own turn id). Ends when the engine stream ends (no live task left, cap,
   * grace, abort).
   */
  private async followThrough(c: { p: TurnParams; a: Attempt; cur: Cursor; sink: TurnSink; account: Account; model: ClaudeModel; cwd: string; sessionId: string; grants: SessionGrants }): Promise<void> {
    const { p, a, cur, sink, account, model, cwd, sessionId, grants } = c;
    const scope = () => ({ turnId: cur.turnId, sessionId, cwd });
    type Seg = { turnId: string; reason: string; modelNote: string | null };
    let seg: Seg | null = null;
    let n = 0;
    let tasks = a.bgTasks;
    const queue: { f: FollowUpParams; attachments: Attachment[] }[] = [];
    const open = (turnId: string, reason: string, modelNote: string | null, clientRef?: string) => {
      seg = { turnId, reason, modelNote };
      cur.turnId = turnId;
      sink.emit({ type: 'turn_started', turnId, sessionId, cwd, account, model, reason, attempt: 0, engine: 'claude', ...(clientRef ? { clientRef } : {}) });
    };
    const openBackground = () => {
      open(`${p.turnId}:bg${++n}`, '백그라운드 계속', null);
      sink.emit({ type: 'turn_notice', ...scope(), message: '백그라운드 계속 — 백그라운드 작업이 끝나 이어서 진행합니다' });
    };
    const sendFollowUp = (f: FollowUpParams, attachments: Attachment[]) => {
      const note = isClaudeModel(f.model) && f.model !== model ? '백그라운드 대기 중인 프로세스의 모델 유지' : null;
      open(f.turnId, '백그라운드 대기 중 이어 보냄', note, f.clientRef);
      const turnId = f.turnId;
      void (a.live?.send({ text: f.text, attachments }) ?? Promise.resolve(false)).then((ok) => {
        if (ok || seg?.turnId !== turnId) return;
        seg = null;
        sink.emit({ type: 'turn_result', turnId, sessionId, cwd, ok: false, text: '', badge: null, errorText: '세션 프로세스가 방금 끝나 보내지 못했습니다 — 다시 보내 주세요' });
      }, () => {
        if (seg?.turnId !== turnId) return;
        seg = null;
        sink.emit({ type: 'turn_result', turnId, sessionId, cwd, ok: false, text: '', badge: null, errorText: '메시지를 보내지 못했습니다' });
      });
    };
    const saveState = async (ok: boolean) => {
      const st = this.deps.store.get(sessionId);
      if (!st || isCodexState(st)) return;
      await this.deps.store.set({
        ...st,
        ...(ok ? { lastTurnAtMs: this.now() } : {}),
        ...(grants.rules.length ? { allowRules: [...grants.rules] } : {}),
        ...(grants.dirs.length ? { allowDirs: [...grants.dirs] } : {}),
        ...(grants.acceptEdits ? { mode: 'acceptEdits' as const } : {}),
      });
    };
    // Follow-ups are taken only while background work holds the process open (else it closes right after this result).
    if (a.live && a.bgTasks.length) {
      this.live.set(sessionId, {
        submit: (f, attachments) => {
          if (seg) queue.push({ f, attachments });
          else sendFollowUp(f, attachments);
          return true;
        },
      });
    }
    try {
      for (;;) {
        const next = await a.rest.next();
        if (next.done) break;
        const ev = next.value;
        // Output with no segment open (e.g. a continuation racing a follow-up) still gets a turn of its own.
        const needSeg = ev.kind === 'delta' || ev.kind === 'tool_call' || ev.kind === 'tool_result' || ev.kind === 'result';
        if ((ev.kind === 'continue' && !seg) || (needSeg && !seg)) openBackground();
        switch (ev.kind) {
          case 'background': tasks = ev.tasks; sink.emit({ type: 'turn_background', ...scope(), tasks }); break;
          case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
          case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
          case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
          case 'rate_limit': this.deps.usage.applyTurn(account, { ...(ev.info.fiveHour ? { fiveHour: ev.info.fiveHour } : {}), ...(ev.info.weekly ? { weekly: ev.info.weekly } : {}) }); break;
          case 'result': {
            const s = seg as Seg | null;
            seg = null;
            if (s) {
              sink.emit({ type: 'turn_result', turnId: s.turnId, sessionId, cwd, ok: ev.ok, text: ev.text, badge: { account, model, reason: s.reason, usage: ev.usage, modelNote: s.modelNote }, errorText: ev.ok ? null : displayError(ev.errorText, ev.stderr) });
            }
            await saveState(ev.ok);
            // Sent before the engine resumes, so it sees the message outstanding and keeps the input open.
            const q = queue.shift();
            if (q) sendFollowUp(q.f, q.attachments);
            break;
          }
          case 'init': case 'compact': case 'continue': break;
        }
      }
    } finally {
      this.live.delete(sessionId);
      const s = seg as Seg | null;
      if (s) sink.emit({ type: 'turn_result', turnId: s.turnId, sessionId, cwd, ok: false, text: '', badge: { account, model, reason: s.reason, usage: ZERO_USAGE, modelNote: s.modelNote }, errorText: sink.signal.aborted ? '중단됨' : '결과 없이 끝났습니다' });
      for (const q of queue) sink.emit({ type: 'error', turnId: q.f.turnId, message: '세션 프로세스가 끝나 보내지 못했습니다 — 다시 보내 주세요', ...(q.f.clientRef ? { clientRef: q.f.clientRef } : {}) });
      if (tasks.length) sink.emit({ type: 'turn_background', ...scope(), tasks: [] });
    }
  }

  /**
   * Review I7: the directory the jsonl really lives in. The CLI slugs its realpath'd cwd
   * (and NFC/NFD spellings of the same name differ), so a guess from our cwd string is only
   * a candidate: confirm the file is there, else look for it under the account's root.
   */
  private async locateProjectDir(sessionId: string, account: Account, candidate: string): Promise<string> {
    if (await exists(path.join(candidate, `${sessionId}.jsonl`))) return candidate;
    const root = this.deps.projectsRoots[account];
    const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const d of dirs) {
      if (d.isDirectory() && (await exists(path.join(root, d.name, `${sessionId}.jsonl`)))) return path.join(root, d.name);
    }
    return candidate;
  }

  async run(p: TurnParams, sink: TurnSink): Promise<void> {
    const { deps } = this;
    // D7: only store-resolved attachments (server-side paths in the private dir) ever reach an engine.
    let attachments: Attachment[] = [];
    if (p.attachments?.length) {
      const ids = [...new Set(p.attachments)];
      const r = deps.attachments?.resolve(ids) ?? { found: [], missing: ids };
      if (r.missing.length) { sink.emit({ type: 'error', turnId: p.turnId, message: `첨부를 찾을 수 없습니다: ${r.missing.join(', ')}` }); return; }
      attachments = r.found;
    }
    let state: SessionState | null = null;
    if (p.sessionId) {
      state = deps.store.get(p.sessionId);
      if (!state) {
        const e = deps.index.lookup(p.sessionId);
        // Codex sessions always have a state entry (D4); a 'gpt' index entry without one is a bug, not a resumable session.
        if (!e || e.account === 'gpt') { sink.emit({ type: 'error', turnId: p.turnId, message: `세션을 찾을 수 없습니다: ${p.sessionId}` }); return; }
        state = { sessionId: e.sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: DEFAULT_MODEL };
      }
    }
    if (state && isCodexState(state)) return this.runCodex(p, state, sink, 'GPT 세션', attachments);
    if (!state) {
      const pick = chooseEngine({
        choice: p.engine ?? 'claude', usage: deps.usage.snapshot(), nowMs: this.now(), codexAvailable: deps.codex !== null,
        gptCooldownUntilMs: this.gptCooldownUntil, cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now()), protectedAccount: deps.protectedAccount,
      });
      if (pick.engine === 'codex') return this.runCodex(p, null, sink, pick.reason, attachments);
      // Only a non-default choice earns a prefix, so Plan 1 badges read exactly as before.
      return this.runClaude(p, null, sink, p.engine && p.engine !== 'claude' ? pick.reason : null, attachments);
    }
    return this.runClaude(p, state, sink, null, attachments);
  }

  /** D2/D3: one ChatGPT account — no routing, no session move, no retry; sandbox + approval never. */
  private async runCodex(p: TurnParams, state: CodexSessionState | null, sink: TurnSink, reason: string, attachments: Attachment[]): Promise<void> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    // A per-turn Codex model wins on resume too (like Claude's per-turn model); the session's stored default is kept.
    const model: CodexModel = isCodexModel(p.model) ? p.model : (state?.defaultModel ?? DEFAULT_CODEX_MODEL);
    const sandbox: CodexSandbox = state?.sandbox ?? p.sandbox ?? defaultSandbox(deps.autoApprove?.() ?? false);
    // Task 2 follow-up: the id is either the stored one (itself CLI-reported) or what the CLI reports via init
    // (thread.started) — never the result's sessionId, which echoes a rejected resume id.
    let sessionId: string | null = state?.sessionId ?? null;
    const scope = () => ({ turnId: p.turnId, sessionId, cwd });
    const badge = (usage: TurnUsage) => ({ account: 'gpt' as const, model, reason, usage, modelNote: null });
    if (!deps.codex) { sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: badge(ZERO_USAGE), errorText: 'codex CLI 를 찾을 수 없습니다' }); return; }
    if (sink.signal.aborted) { sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: badge(ZERO_USAGE), errorText: '중단됨' }); return; }
    sink.emit({ type: 'turn_started', ...scope(), account: 'gpt', model, reason, attempt: 0, engine: 'codex' });
    let result: EngineResult | null = null;
    const effort = effortFor(model, p.effort);
    for await (const ev of deps.codex.runTurn({ cwd, resumeThreadId: state?.sessionId ?? null, model, sandbox, ...(effort ? { effort } : {}), prompt: promptWithFiles(p.text, attachments), imagePaths: attachments.filter((a) => a.isImage).map((a) => a.path), signal: sink.signal })) {
      switch (ev.kind) {
        case 'init': sessionId = ev.sessionId; break;
        case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
        case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
        case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
        case 'result': result = ev; break;
        case 'rate_limit': case 'compact': case 'task_done': break;
      }
    }
    const res: EngineResult = result ?? { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
    if (sessionId) {
      const rolloutFile = state?.rolloutFile ?? (await this.findRollout(deps.codexSessionsRoot, sessionId).catch(() => null));
      const next: CodexSessionState = {
        engine: 'codex', sessionId, cwd, lastTurnAtMs: res.ok ? this.now() : (state?.lastTurnAtMs ?? null), justCompacted: false,
        defaultModel: state?.defaultModel ?? model, sandbox, rolloutFile, createdAtMs: state?.createdAtMs ?? this.now(), title: state?.title ?? titleOf(p.text),
      };
      await deps.store.set(next);
      // D5: the rollout's token_count.rate_limits is the only per-turn GPT usage signal.
      if (rolloutFile) {
        const w = await this.readRateLimits(rolloutFile).catch(() => null);
        if (w) deps.usage.applyTurn('gpt', w);
      }
    }
    if (!res.ok && classifyFailure({ ok: false, errorText: res.errorText, errorKind: res.errorKind, rateLimitStatus: null }) === 'limit') this.gptCooldownUntil = this.now() + COOLDOWN_MS.limit;
    sink.emit({ type: 'turn_result', ...scope(), ok: res.ok, text: res.text, badge: badge(res.usage), errorText: res.ok ? null : displayError(res.errorText, res.stderr) });
  }

  private async runClaude(p: TurnParams, state: ClaudeSessionState | null, sink: TurnSink, enginePrefix: string | null, attachments: Attachment[]): Promise<void> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    const sessionDefault = state?.defaultModel ?? DEFAULT_MODEL;
    const wantedClaude = isClaudeModel(p.model) ? p.model : undefined;
    const wanted = wantedClaude ?? sessionDefault;
    const routerBase = { usage: deps.usage.snapshot(), nowMs: this.now(), protectedAccount: deps.protectedAccount, needFable: wanted === 'fable' };

    const first = chooseAccount({
      ...routerBase,
      current: state?.account ?? null,
      lastTurnAtMs: state?.lastTurnAtMs ?? null,
      justCompacted: state?.justCompacted ?? false,
      cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now()),
    });
    let account = first.account;
    let reason = enginePrefix ? `${enginePrefix} · ${first.reason}` : first.reason;
    if (state && account !== state.account) {
      const moved = await this.relocate(state, account, sink, p.turnId);
      if (moved) state = moved;
      else { account = state.account; reason = `이전 실패 · ${LABEL[account]} 유지`; }
    }

    const tried: Account[] = [];
    const grants: SessionGrants = { rules: [...(state?.allowRules ?? [])], dirs: [...(state?.allowDirs ?? [])], acceptEdits: state?.mode === 'acceptEdits' };
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Review M2: an interrupt between attempts (or before the first) ends the turn here.
      if (sink.signal.aborted) {
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId: state?.sessionId ?? null, cwd, ok: false, text: '', badge: { account, model: wantedClaude ?? sessionDefault, reason, usage: ZERO_USAGE, modelNote: null }, errorText: '중단됨' });
        return;
      }
      const fable = deps.usage.snapshot().accounts[account].fable?.usedPct ?? null;
      const { model, note } = resolveModel(wantedClaude, sessionDefault, fable);
      sink.emit({ type: 'turn_started', turnId: p.turnId, sessionId: state?.sessionId ?? null, cwd, account, model, reason, attempt, engine: 'claude' });

      const cur: Cursor = { turnId: p.turnId };
      const a = await this.attempt(p, account, model, cwd, state?.sessionId ?? null, sink, grants, attachments, cur);
      const res: EngineResult = a.result ?? { kind: 'result', sessionId: a.sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
      const sessionId = a.sessionId ?? state?.sessionId ?? null;
      if (sessionId) {
        state = {
          sessionId,
          cwd,
          account,
          projectDir: await this.locateProjectDir(sessionId, account, state?.projectDir ?? path.join(deps.projectsRoots[account], projectSlug(a.initCwd ?? cwd))),
          lastTurnAtMs: res.ok ? this.now() : (state?.lastTurnAtMs ?? null),
          justCompacted: a.compacted,
          defaultModel: sessionDefault,
          ...(grants.rules.length ? { allowRules: [...grants.rules] } : {}),
          ...(grants.dirs.length ? { allowDirs: [...grants.dirs] } : {}),
          ...(grants.acceptEdits ? { mode: 'acceptEdits' as const } : {}),
        };
        await deps.store.set(state);
      }

      const failure = classifyFailure({ ok: res.ok, errorText: res.errorText, errorKind: res.errorKind, rateLimitStatus: a.rateLimit?.status ?? null });
      const badge = { account, model, reason, usage: res.usage, modelNote: note };
      const shownError = displayError(res.errorText, res.stderr);
      if (res.ok || failure === 'other' || failure === null || attempt === this.maxRetries || sink.signal.aborted) {
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId, cwd, ok: res.ok, text: res.text, badge, errorText: res.ok ? null : shownError });
        if (sessionId) await this.followThrough({ p, a, cur, sink, account, model, cwd, sessionId, grants });
        else await a.rest.return?.();
        return;
      }
      await a.rest.return?.();

      // Spec §8: limit/auth → cooldown (shared with claude-pick) → move → retry on the next account.
      writeCooldown(deps.cooldownDir, account, this.now() + COOLDOWN_MS[failure]);
      tried.push(account);
      const why = failure === 'limit' ? '한도 도달' : '인증 실패';
      // Review M1: a refused move rules that account out for this turn; ask the router again.
      let next: { account: Account; reason: string } | null = null;
      let moveRefused = false;
      for (;;) {
        const cand = chooseAccount({
          ...routerBase,
          usage: deps.usage.snapshot(),
          nowMs: this.now(),
          current: account,
          lastTurnAtMs: null,
          justCompacted: false,
          cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now()),
          exclude: tried,
        });
        if (cand.account === account || tried.includes(cand.account)) break;
        if (!state) { next = cand; break; }
        const moved = await this.relocate(state, cand.account, sink, p.turnId);
        if (moved) { state = moved; next = cand; break; }
        moveRefused = true;
        tried.push(cand.account);
      }
      if (!next) {
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId, cwd, ok: false, text: '', badge, errorText: `${why} · ${moveRefused ? '세션 이전 실패' : '대안 계정 없음'} · ${shownError ?? ''}`.trim() });
        return;
      }
      sink.emit({ type: 'turn_retry', turnId: p.turnId, sessionId: state?.sessionId ?? sessionId, cwd, fromAccount: account, toAccount: next.account, reason: `${why} → ${next.reason}`, attempt: attempt + 1 });
      reason = `재시도(${why}) · ${next.reason}`;
      account = next.account;
    }
  }
}
