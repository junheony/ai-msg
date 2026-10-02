import fs from 'node:fs/promises';
import path from 'node:path';
import { GEMINI_ACCOUNTS, SEAT_LABEL, isGeminiAccount, type Account, type GeminiAccount } from '../../shared/accounts';
import { AUTO_EFFORT, DEFAULT_CODEX_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_MODEL, DEFAULT_SANDBOX, defaultSandbox, effortFor, isClaudeModel, isCodexModel, isGeminiModel, type ClaudeModel, type CodexModel, type CodexSandbox, type Effort, type EngineChoice, type GeminiModel, type ModelChoice } from '../../shared/models';
import type { ServerMessage } from '../../shared/protocol';
import { promptWithFiles, type Attachment, type AttachmentStore } from '../attachments/AttachmentStore';
import { ZERO_USAGE, type BgTaskInfo, type PermissionDecision, type QuestionAnswers, type TurnUsage } from '../../shared/turn-types';
import { appendAudit, hashInput } from '../audit';
import type { CodexEngine } from '../engine/CodexEngine';
import type { GeminiEngine } from '../engine/GeminiEngine';
import { findRolloutFile, readRolloutRateLimits } from '../engine/codexRollout';
import { ruleString, sessionUpdates, type BgTask, type Engine, type EngineEvent, type EngineResult, type LiveInput, type PermissionRequest, type QuestionRequest, type RateLimitSignal } from '../engine/Engine';
import { COOLDOWN_MS, classifyFailure } from '../engine/limitDetect';
import { displayError, redactSecrets } from '../engine/redact';
import { chooseAccount } from '../routing/AccountRouter';
import { chooseAutoModel } from '../routing/AutoModel';
import { chooseEngine } from '../routing/EngineChoice';
import { readAllCooldownsMs, writeCooldown } from '../routing/cooldown';
import { resolveModel } from '../routing/ModelPolicy';
import type { SessionIndex } from '../sessions/SessionIndex';
import { findCopies, resolveCopies } from '../sessions/copies';
import { LIVE_ROLLOUT_NOTICE, rolloutRecentlyActive } from '../sessions/CodexImports';
import { forkDivergedAndMove } from '../sessions/SessionFork';
import { isBytePrefix, moveSession } from '../sessions/SessionMover';
import { projectSlug } from '../sessions/slug';
import type { UsageService } from '../usage/UsageService';
import { isCodexState, isGeminiState, type ClaudeSessionState, type CodexSessionState, type GeminiSessionState, type SessionState, type SessionStateStore } from './SessionState';

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
  /** Claude or GPT model; a model of the other engine is ignored (the session's default applies). 'auto' = 자동 (new Claude sessions). */
  model?: ModelChoice;
  /** Reasoning effort for this turn; dropped if the resolved model does not support it. */
  effort?: Effort;
  /** New sessions only (D3). */
  engine?: EngineChoice;
  /** New Codex sessions only (D2). */
  sandbox?: CodexSandbox;
  /** Ids from POST /api/attachments (D7). */
  attachments?: string[];
  /** New Claude sessions only: the account to pin (existing sessions keep their stored pin). */
  accountPin?: Account | null;
  /** 새 세션으로 이어가기: the handoff-note turn — Claude runs it with every tool call denied (TurnRequest.noTools). */
  handoff?: boolean;
};

export type TurnRunnerDeps = {
  engine: Engine;
  /** Null = Codex disabled (D11); tests inject a fake with just runTurn. */
  codex: Pick<CodexEngine, 'runTurn'> | null;
  /** Null = gemini-cli not installed. `loggedIn` checks only that the account's OAuth file exists (read per turn). */
  gemini?: { engine: Pick<GeminiEngine, 'runTurn'>; loggedIn: (account: GeminiAccount) => boolean } | null;
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
  /**
   * The profile Claude Desktop and a plain `claude --resume` use (A). After every Claude turn that ran
   * elsewhere the session is mirrored back into it (append-only, prefix-checked). Absent/null = no write-back.
   */
  homeAccount?: Account | null;
  /** While a session is held open for background work: at most one write-back per this many ms (default 20 s). */
  mirrorThrottleMs?: number;
  move?: typeof moveSession;
  /** A diverged copy in the target profile (not home/protected) is forked aside so the move can go on. */
  fork?: typeof forkDivergedAndMove;
  /** The session list changed on disk (a fork was written): rescan done, tell the clients. */
  onIndexChanged?: () => void;
  findRollout?: typeof findRolloutFile;
  readRateLimits?: typeof readRolloutRateLimits;
  now?: () => number;
  maxRetries?: number;
};

const LABEL: Record<Account, string> = { a: 'A', b: 'B', c: 'C' };

/** Shown right after turn_started when a copy of the session was just written by something other than deck. */
export const OPEN_ELSEWHERE_NOTICE = '이 대화가 Desktop/CLI 에서도 열려 있는 것 같아요 — 두 곳에서 이어 쓰면 갈라져요';

/** gemini-cli's quota / 429 errors (TerminalQuotaError, RESOURCE_EXHAUSTED); matched on the CLI's result error only. */
const GEMINI_LIMIT_RE = /\bRESOURCE_EXHAUSTED\b|exhausted your (daily )?quota|\bQuota exceeded\b|"code"\s*:\s*429\b/i;

/** `rest`: the engine stream after the first result (background continuations); `live`: its input handle. */
type Attempt = {
  result: EngineResult | null; rateLimit: RateLimitSignal | null; sessionId: string | null; compacted: boolean; initCwd: string | null;
  rest: AsyncIterator<EngineEvent>; live: LiveInput | null; bgTasks: string[];
};

/** A user message for a session whose process is still open for background work (see `followUp`). */
export type FollowUpParams = { turnId: string; text: string; attachments?: string[]; model?: ModelChoice; clientRef?: string };

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
/** Background task detail for the wire: age instead of a start time (the client's clock may differ). */
function bgInfo(detail: BgTask[] | undefined, now: number): BgTaskInfo[] | undefined {
  return detail?.map((t) => ({ id: t.id, description: t.description, type: t.type, ageMs: Math.max(0, now - t.startedAtMs) }));
}

function taskDoneOf(ev: Extract<EngineEvent, { kind: 'task_done' }>) {
  return {
    status: ev.status, summary: redactSecrets(ev.summary),
    ...(ev.taskId ? { taskId: ev.taskId } : {}),
    ...(ev.toolUseId !== undefined ? { toolUseId: ev.toolUseId } : {}),
    ...(ev.usage ? { usage: ev.usage } : {}),
  };
}

function titleOf(text: string): string {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return first.length > 80 ? first.slice(0, 80) : first || '(제목 없음)';
}

export class TurnRunner {
  private readonly move: typeof moveSession;
  private readonly fork: typeof forkDivergedAndMove;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly findRollout: typeof findRolloutFile;
  private readonly readRateLimits: typeof readRolloutRateLimits;
  private gptCooldownUntil: number | null = null;
  /** Claude sessions whose process stays open for background work, by session id. */
  private readonly live = new Map<string, LiveSession>();
  /** The engine input handle of each running Claude turn, by its first turn id (per-task stop). */
  private readonly inputs = new Map<string, LiveInput>();
  /** In-memory, per Gemini account, after a quota failure: new Gemini sessions open on the other account. */
  private geminiCooldownUntil: Partial<Record<GeminiAccount, number>> = {};
  /** Home write-backs in flight, by session id (serialized per session; the next turn waits for it). */
  private readonly mirrors = new Map<string, Promise<void>>();
  /** Notices already shown, `${sessionId}\0${message}` — a lasting divergence is told once, not every turn. */
  private readonly noted = new Set<string>();
  /** When each session's last write-back was started (wall clock), and a trailing one due while throttled. */
  private readonly mirrorAt = new Map<string, number>();
  private readonly mirrorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Claude sessions with a deck turn running now (its process may write the jsonl at any moment). */
  private readonly active = new Set<string>();
  /** When deck itself last wrote a transcript (its turn's process closed, a move/write-back), by resolved path. In memory only. */
  private readonly deckWroteAt = new Map<string, number>();

  constructor(private readonly deps: TurnRunnerDeps) {
    const move = deps.move ?? moveSession;
    this.move = async (o) => {
      const r = await move(o);
      if (r.ok) this.deckWroteAt.set(path.resolve(r.targetFile), this.now());
      return r;
    };
    this.fork = deps.fork ?? forkDivergedAndMove;
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

  /** Resolves when every home write-back started so far has finished (tests, shutdown). */
  async mirrorsSettled(): Promise<void> {
    while (this.mirrors.size) await Promise.all([...this.mirrors.values()]);
  }

  /** True the first time `message` is seen for this session (a lasting state is told once). */
  private firstNote(sessionId: string, message: string): boolean {
    const key = `${sessionId}\0${message}`;
    if (this.noted.has(key)) return false;
    this.noted.add(key);
    return true;
  }

  private noteOnce(sink: TurnSink, turnId: string, state: { sessionId: string; cwd: string }, message: string): void {
    if (!this.firstNote(state.sessionId, message)) return;
    sink.emit({ type: 'turn_notice', turnId, sessionId: state.sessionId, cwd: state.cwd, message });
  }

  /**
   * After a Claude turn (its process closed, the jsonl flushed): copy the session back into the home
   * profile so Claude Desktop / `claude --resume` there see it. Runs in the background; a failure is a
   * notice on the turn, never a turn failure. A home copy that went its own way is left untouched.
   */
  private scheduleMirror(sessionId: string, sink: TurnSink, turnId: string): void {
    const home = this.deps.homeAccount;
    if (!home) return;
    clearTimeout(this.mirrorTimers.get(sessionId));
    this.mirrorTimers.delete(sessionId);
    this.mirrorAt.set(sessionId, Date.now());
    this.serialize(sessionId, () => this.mirrorHome(sessionId, home, sink, turnId)).catch((err: unknown) => console.error('deck: home write-back failed', err instanceof Error ? err.message : err));
  }

  /** Runs `fn` after every write-back / fork resolution already queued for this session. */
  private serialize<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.mirrors.get(sessionId) ?? Promise.resolve()).then(fn);
    const done = run.then(() => undefined, () => undefined);
    this.mirrors.set(sessionId, done);
    void done.then(() => { if (this.mirrors.get(sessionId) === done) this.mirrors.delete(sessionId); });
    return run;
  }

  /**
   * A result while the process stays open for background work (sessions are held open for a long
   * time): write back now, or — within the throttle window — once when it ends. The final one at
   * close is scheduled by runClaude regardless.
   */
  private mirrorSoon(sessionId: string, sink: TurnSink, turnId: string): void {
    if (!this.deps.homeAccount || this.mirrorTimers.has(sessionId)) return;
    const wait = (this.mirrorAt.get(sessionId) ?? -Infinity) + (this.deps.mirrorThrottleMs ?? 20_000) - Date.now();
    if (wait <= 0) { this.scheduleMirror(sessionId, sink, turnId); return; }
    const t = setTimeout(() => this.scheduleMirror(sessionId, sink, turnId), wait);
    t.unref?.();
    this.mirrorTimers.set(sessionId, t);
  }

  /** deck's copy and the home profile's copy of a session, when deck runs it on another profile. */
  private async forkPair(sessionId: string): Promise<{ st: ClaudeSessionState; home: Account; deckFile: string; homeDir: string; homeFile: string } | null> {
    const home = this.deps.homeAccount;
    const st = this.deps.store.get(sessionId);
    if (!home || !st || isCodexState(st) || isGeminiState(st) || st.account === home) return null;
    const homeDir = path.join(this.deps.projectsRoots[home], path.basename(st.projectDir));
    return { st, home, deckFile: path.join(st.projectDir, `${sessionId}.jsonl`), homeDir, homeFile: path.join(homeDir, `${sessionId}.jsonl`) };
  }

  /**
   * Whether deck's copy and the home copy (Claude Desktop) went their own ways — neither contains the other.
   * Null: not a deck Claude session run outside the home profile.
   */
  async forkStatus(sessionId: string): Promise<{ diverged: boolean; deckAccount: Account; homeAccount: Account } | null> {
    const pair = await this.forkPair(sessionId);
    if (!pair) return null;
    const both = (await exists(pair.deckFile)) && (await exists(pair.homeFile));
    const diverged = both && !(await isBytePrefix(pair.homeFile, pair.deckFile)) && !(await isBytePrefix(pair.deckFile, pair.homeFile));
    return { diverged, deckAccount: pair.st.account, homeAccount: pair.home };
  }

  /**
   * "Desktop에서 열기": bring the home profile's copy up to date now (the same write-back as after a turn, awaited)
   * so `claude://resume?session=` finds the current conversation. `busy`: a CLI process of deck's still holds the session.
   */
  async openInDesktop(sessionId: string): Promise<{ ok: true; busy: boolean } | { ok: false; reason: 'unsupported' | 'diverged' | 'failed'; error?: string }> {
    const st = this.deps.store.get(sessionId);
    if (st && (isCodexState(st) || isGeminiState(st))) return { ok: false, reason: 'unsupported' };
    const busy = this.active.has(sessionId) || this.live.has(sessionId);
    const home = this.deps.homeAccount;
    if (!st || !home || st.account === home) return { ok: true, busy };
    return this.serialize(sessionId, async () => {
      const r = await this.move({ sessionId, sourceProjectDir: st.projectDir, targetProjectsRoot: this.deps.projectsRoots[home], ignoreOtherDirs: true });
      if (r.ok) return { ok: true as const, busy };
      // The home copy already contains ours: it is the newer one, nothing to write back.
      if (r.diverged && (await isBytePrefix(path.join(st.projectDir, `${sessionId}.jsonl`), path.join(this.deps.projectsRoots[home], path.basename(st.projectDir), `${sessionId}.jsonl`)).catch(() => false))) return { ok: true as const, busy };
      return r.diverged ? { ok: false as const, reason: 'diverged' as const } : { ok: false as const, reason: 'failed' as const, error: r.error };
    });
  }

  /**
   * The user's answer to a divergence. `keep: 'deck'` — the home copy (and its `<id>/` dir) is renamed to
   * `*.deck-fork-<ts>` and deck's copy is written there; `keep: 'home'` — the same on deck's side, adopting
   * the home copy. Nothing is deleted. Adopting the home copy needs the deck process gone (it would keep
   * appending to the old file); on failure the backups are put back.
   */
  async resolveFork(sessionId: string, keep: 'deck' | 'home'): Promise<{ ok: true; backup: string } | { ok: false; error: string }> {
    return this.serialize(sessionId, async () => {
      const pair = await this.forkPair(sessionId);
      if (!pair || !(await this.forkStatus(sessionId))?.diverged) return { ok: false as const, error: '갈라진 사본이 없습니다' };
      if (keep === 'home' && (this.active.has(sessionId) || this.live.has(sessionId))) {
        return { ok: false as const, error: 'deck 에서 이 세션이 실행 중입니다 — 끝난 뒤 다시 시도하세요' };
      }
      const [srcDir, dstDir] = keep === 'deck' ? [pair.st.projectDir, pair.homeDir] : [pair.homeDir, pair.st.projectDir];
      const stamp = `deck-fork-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const file = path.join(dstDir, `${sessionId}.jsonl`);
      const dir = path.join(dstDir, sessionId);
      const moved: [string, string][] = [];
      try {
        for (const [from, to] of [[file, `${file}.${stamp}`], [dir, `${dir}.${stamp}`]] as const) {
          if (!(await exists(from))) continue;
          await fs.rename(from, to);
          moved.push([from, to]);
        }
        const r = await this.move({ sessionId, sourceProjectDir: srcDir, targetProjectsRoot: path.dirname(dstDir), ignoreOtherDirs: true });
        if (!r.ok) throw new Error(r.error);
      } catch (err) {
        for (const [from, to] of moved.reverse()) if (!(await exists(from))) await fs.rename(to, from).catch(() => undefined);
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
      for (const k of [...this.noted]) if (k.startsWith(`${sessionId}\0`)) this.noted.delete(k);
      return { ok: true as const, backup: `${file}.${stamp}` };
    });
  }

  private async mirrorHome(sessionId: string, home: Account, sink: TurnSink, turnId: string): Promise<void> {
    const st = this.deps.store.get(sessionId);
    if (!st || isCodexState(st) || isGeminiState(st) || st.account === home) return;
    // Only the same-named dir is refreshed: a stale copy under an older dir spelling must not block it (nor is it touched).
    const r = await this.move({ sessionId, sourceProjectDir: st.projectDir, targetProjectsRoot: this.deps.projectsRoots[home], ignoreOtherDirs: true });
    if (r.ok) return;
    // The home copy already contains ours (Desktop went on, deck added nothing): the next turn pulls it in.
    if (r.diverged && (await isBytePrefix(path.join(st.projectDir, `${sessionId}.jsonl`), path.join(this.deps.projectsRoots[home], path.basename(st.projectDir), `${sessionId}.jsonl`)).catch(() => false))) return;
    console.error(`deck: home write-back of ${sessionId} to ${LABEL[home]} failed: ${r.error}`);
    this.noteOnce(sink, turnId, st, r.diverged
      ? `다른 곳(Desktop/CLI)에서 따로 이어진 대화가 있어 갈라졌습니다 — ${LABEL[home]} 계정 사본은 덮어쓰지 않았습니다 (머리글의 '갈라짐' 메뉴에서 어느 쪽으로 맞출지 고를 수 있습니다)`
      : `${LABEL[home]} 계정 사본 갱신 실패(${r.error}) — 대화는 계속됩니다`);
  }

  /**
   * Before a turn: the same session may have moved on in another profile (Claude Desktop on A).
   * A copy that contains ours is pulled into the profile deck last used (so routing is unchanged);
   * if that copy cannot be written, the session follows it instead. Truly diverged copies are never
   * merged or overwritten: the newest (mtime) is used and the user is told.
   */
  private async reconcile(state: ClaudeSessionState, say: (message: string) => void): Promise<ClaudeSessionState> {
    try {
      const copies = await findCopies(this.deps.projectsRoots, state.sessionId, state.projectDir, state.account);
      // No copy where deck left it: nothing to compare against (locateProjectDir / the engine handle that).
      if (copies[0]?.projectDir !== state.projectDir || copies.length < 2) return state;
      const r = (await resolveCopies(copies))!;
      if (r.heads.length > 1) {
        const others = r.heads.filter((h) => h !== r.best).map((h) => LABEL[h.account]).join('·');
        const message = `다른 곳(Desktop/CLI)에서 따로 이어진 대화가 있어 갈라졌습니다 — 가장 최근에 바뀐 ${LABEL[r.best.account]} 계정 사본으로 이어가고, ${others} 계정 사본은 그대로 둡니다 (머리글의 '갈라짐' 메뉴에서 맞출 수 있습니다)`;
        if (this.firstNote(state.sessionId, message)) say(message);
      }
      if (r.best.projectDir === state.projectDir) return state;
      if (!r.heads.includes(copies[0]!)) {
        // Ours is an older prefix of the winner: refresh it in place (moveSession accepts only that).
        const m = await this.move({ sessionId: state.sessionId, sourceProjectDir: r.best.projectDir, targetProjectsRoot: this.deps.projectsRoots[state.account] });
        if (m.ok && path.resolve(m.targetDir) === path.resolve(state.projectDir)) return state;
      }
      const next = { ...state, account: r.best.account, projectDir: r.best.projectDir };
      await this.deps.store.set(next);
      return next;
    } catch (err) {
      console.error('deck: session copy check failed', err instanceof Error ? err.message : err);
      return state;
    }
  }

  /**
   * Stop one background task of a running Claude turn (`turnId` = the turn's first id). False when the
   * turn has no open process or the SDK cannot stop single tasks (the caller falls back to interrupt).
   */
  async stopTask(turnId: string, taskId: string): Promise<boolean> {
    const l = this.inputs.get(turnId);
    if (!l?.stopTask) return false;
    try {
      return await l.stopTask(taskId);
    } catch (err) {
      console.error('deck: stopTask failed', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private bgExtra(turnId: string, detail: BgTask[] | undefined): { detail?: BgTaskInfo[]; canStop?: boolean } {
    const info = bgInfo(detail, this.now());
    return { ...(info ? { detail: info } : {}), ...(this.canStopTasks(turnId) ? { canStop: true } : {}) };
  }

  /** Whether `turnId` (a turn's first id) can stop single tasks. */
  canStopTasks(turnId: string): boolean {
    return typeof this.inputs.get(turnId)?.stopTask === 'function';
  }

  /** Session ids whose process is held open for background work. */
  backgroundSessions(): string[] {
    return [...this.live.keys()];
  }

  /**
   * 이 세션은 B 써: pins a Claude session to an account (null = 자동), applied from its next turn (which moves it there).
   * A session deck has no state for yet (seen only in the index) gets one. False = not a Claude session deck knows.
   */
  async setAccountPin(sessionId: string, pin: Account | null): Promise<boolean> {
    const { store, index } = this.deps;
    if (!store.get(sessionId)) {
      const e = index.lookup(sessionId);
      if (!e || e.account === 'gpt' || isGeminiAccount(e.account)) return false;
      await store.set({ sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: DEFAULT_MODEL, ...(pin ? { accountPin: pin } : {}) });
      return true;
    }
    return store.setAccountPin(sessionId, pin);
  }

  /** D3: set after a Codex limit failure; consulted by chooseEngine for 'auto'. In memory only. */
  gptCooldownUntilMs(): number | null {
    return this.gptCooldownUntil;
  }

  /**
   * Moves the session into `to`'s profile. A copy there that went its own way (the same id continued in two
   * places) is forked aside under a new id and the move retried — except in the home/protected profile (Desktop's),
   * whose copy is never touched. Notices go through `say` (the caller shows them on the turn).
   */
  private async relocate(state: ClaudeSessionState, to: Account, say: (message: string) => void): Promise<ClaudeSessionState | null> {
    const req = { sessionId: state.sessionId, sourceProjectDir: state.projectDir, targetProjectsRoot: this.deps.projectsRoots[to] };
    let r = await this.move(req);
    let forked: string | null = null;
    if (!r.ok && r.diverged) {
      // The target copy merely extends ours (it is ahead, not diverged): continue from it, as openInDesktop does.
      const targetDir = path.join(this.deps.projectsRoots[to], path.basename(state.projectDir));
      if (await isBytePrefix(path.join(state.projectDir, `${state.sessionId}.jsonl`), path.join(targetDir, `${state.sessionId}.jsonl`)).catch(() => false)) {
        const next = { ...state, account: to, projectDir: targetDir };
        await this.deps.store.set(next);
        say('다른 계정에 더 최신 대화가 있어 그걸로 이어가요');
        return next;
      }
      if (to === this.deps.homeAccount || to === this.deps.protectedAccount) {
        say(`${LABEL[to]} 계정(Desktop)에 따로 이어진 대화가 있어 그 사본은 그대로 두었어요 — ${LABEL[state.account]} 계정에서 이어가요`);
        return null;
      }
      const refuse = [this.deps.homeAccount, this.deps.protectedAccount].filter((a): a is Account => !!a).map((a) => this.deps.projectsRoots[a]);
      const f = await this.fork({ ...req, refuseProjectsRoots: refuse, move: this.move });
      if (f.ok) {
        r = f.move;
        console.log(`deck: ${state.sessionId} 의 ${LABEL[to]} 계정 사본이 갈라져 ${f.fork.sessionId} 로 보관 (백업 ${f.backupDir})`);
        forked = `다른 곳에서 이어진 대화가 있어 '${f.fork.title}'으로 따로 보관하고 ${LABEL[to]} 계정으로 옮겼어요`;
        if (f.keptAside.length) {
          console.error(`deck: ${state.sessionId} 의 옮겨 둔 원래 사본이 백업 뒤에 바뀌어 지우지 않음: ${f.keptAside.join(', ')}`);
          forked += ' (옮기는 사이 바뀐 원래 사본은 지우지 않고 남겨 두었어요)';
        }
        await this.deps.index.refresh().then(() => this.deps.onIndexChanged?.(), (err: unknown) => console.error('deck: index refresh after fork failed', err instanceof Error ? err.message : err));
      } else {
        console.error(`deck: fork of ${state.sessionId} in ${LABEL[to]} failed (${f.restored ? 'restored' : 'NOT restored'}, backup ${f.backupDir ?? '-'}): ${f.error}`);
        r = { ok: false, error: f.restored ? f.error : `${f.error} · 백업: ${f.backupDir ?? '없음'}` };
      }
    }
    if (!r.ok) {
      say(`세션을 ${LABEL[to]} 계정으로 옮기지 못해 ${LABEL[state.account]} 계정에서 이어가요 (${r.error})`);
      return null;
    }
    const next = { ...state, account: to, projectDir: r.targetDir };
    await this.deps.store.set(next);
    if (forked) say(forked);
    return next;
  }

  /**
   * A copy of the session (deck's or another profile's) was written in the last 2 minutes, after deck's own
   * last turn or write, with no deck process holding it: Desktop or a CLI probably has it open. Stat only.
   */
  private async openElsewhere(state: ClaudeSessionState): Promise<boolean> {
    if (this.live.has(state.sessionId)) return false;
    const now = this.now();
    const copies = await findCopies(this.deps.projectsRoots, state.sessionId, state.projectDir, state.account).catch(() => []);
    // A clearly future mtime is clock skew, not a writer.
    return copies.some((c) => {
      const deckAt = Math.max(state.lastTurnAtMs ?? 0, this.deckWroteAt.get(path.resolve(c.file)) ?? 0);
      return now - c.mtimeMs < 120_000 && now - c.mtimeMs > -5_000 && c.mtimeMs > deckAt + 5_000;
    });
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
      onLive: (l) => { out.live = l; this.inputs.set(p.turnId, l); },
      ...(p.handoff ? { noTools: true } : {}),
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
        case 'background': out.bgTasks = ev.tasks; sink.emit({ type: 'turn_background', ...scope(), tasks: ev.tasks, ...this.bgExtra(p.turnId, ev.detail) }); break;
        case 'continue': break;
        case 'progress': sink.emit({ type: 'turn_progress', ...scope(), outputTokens: ev.outputTokens, phase: ev.phase }); break;
        case 'sub_tool_call': sink.emit({ type: 'sub_tool_call', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'sub_tool_result': sink.emit({ type: 'sub_tool_result', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, isError: ev.isError }); break;
        case 'task_update': { const { kind: _k, ...u } = ev; sink.emit({ type: 'task_update', ...scope(), ...u, ...(u.summary ? { summary: redactSecrets(u.summary) } : {}) }); break; }
        case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
        case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
        case 'rate_limit':
          out.rateLimit = ev.info;
          this.deps.usage.applyTurn(account, { ...(ev.info.fiveHour ? { fiveHour: ev.info.fiveHour } : {}), ...(ev.info.weekly ? { weekly: ev.info.weekly } : {}) });
          break;
        case 'compact': out.compacted = true; break;
        case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
        case 'task_done': sink.emit({ type: 'task_done', ...scope(), ...taskDoneOf(ev) }); break;
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
      if (!st || isCodexState(st) || isGeminiState(st)) return;
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
          case 'background': tasks = ev.tasks; sink.emit({ type: 'turn_background', ...scope(), tasks, ...this.bgExtra(p.turnId, ev.detail) }); break;
          case 'progress': if (seg) sink.emit({ type: 'turn_progress', ...scope(), outputTokens: ev.outputTokens, phase: ev.phase }); break;
          case 'sub_tool_call': sink.emit({ type: 'sub_tool_call', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'sub_tool_result': sink.emit({ type: 'sub_tool_result', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, isError: ev.isError }); break;
          case 'task_update': { const { kind: _k, ...u } = ev; sink.emit({ type: 'task_update', ...scope(), ...u, ...(u.summary ? { summary: redactSecrets(u.summary) } : {}) }); break; }
          case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
          case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
          case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
          // A background task settled while the process waits: the push (PushNotifier) fires here, not only inside the turn.
          case 'task_done': sink.emit({ type: 'task_done', ...scope(), ...taskDoneOf(ev) }); break;
          case 'rate_limit': this.deps.usage.applyTurn(account, { ...(ev.info.fiveHour ? { fiveHour: ev.info.fiveHour } : {}), ...(ev.info.weekly ? { weekly: ev.info.weekly } : {}) }); break;
          case 'result': {
            const s = seg as Seg | null;
            seg = null;
            if (s) {
              sink.emit({ type: 'turn_result', turnId: s.turnId, sessionId, cwd, ok: ev.ok, text: ev.text, badge: { account, model, reason: s.reason, usage: ev.usage, modelNote: s.modelNote }, errorText: ev.ok ? null : displayError(ev.errorText, ev.stderr) });
            }
            await saveState(ev.ok);
            this.mirrorSoon(sessionId, sink, s?.turnId ?? cur.turnId);
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
      if (tasks.length) sink.emit({ type: 'turn_background', ...scope(), tasks: [], detail: [] });
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
    let notice: string | null = null;
    if (p.sessionId) {
      state = deps.store.get(p.sessionId);
      const imported = state ? null : deps.index.codexImport(p.sessionId);
      if (imported) {
        // A Codex Desktop / CLI thread: resumed in its own cwd under deck's sandbox; stored as a deck Codex session after this turn.
        state = {
          engine: 'codex', sessionId: imported.sessionId, cwd: imported.cwd, lastTurnAtMs: null, justCompacted: false,
          defaultModel: isCodexModel(p.model) ? p.model : DEFAULT_CODEX_MODEL, sandbox: p.sandbox ?? defaultSandbox(deps.autoApprove?.() ?? false),
          rolloutFile: imported.file, createdAtMs: this.now(), title: imported.title,
        };
        if (await rolloutRecentlyActive(imported.file, this.now())) notice = LIVE_ROLLOUT_NOTICE;
      } else if (!state) {
        const e = deps.index.lookup(p.sessionId);
        // Codex sessions always have a state entry (D4); a 'gpt' index entry without one is a bug, not a resumable session.
        if (!e || e.account === 'gpt' || isGeminiAccount(e.account)) { sink.emit({ type: 'error', turnId: p.turnId, message: `세션을 찾을 수 없습니다: ${p.sessionId}` }); return; }
        state = { sessionId: e.sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: DEFAULT_MODEL };
      }
    }
    if (state && isCodexState(state)) return this.runCodex(p, state, sink, 'GPT 세션', attachments, notice);
    if (state && isGeminiState(state)) return this.runGemini(p, state, sink, `Gemini 세션 · ${SEAT_LABEL[state.account]}`, attachments);
    // Gemini is explicit only: chooseEngine (자동) never sees it.
    if (!state && p.engine === 'gemini') return this.runGemini(p, null, sink, 'Gemini 지정', attachments);
    if (!state) {
      const pick = chooseEngine({
        choice: p.engine ?? 'claude', usage: deps.usage.snapshot(), nowMs: this.now(), codexAvailable: deps.codex !== null,
        gptCooldownUntilMs: this.gptCooldownUntil, cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now()), protectedAccount: deps.protectedAccount,
      });
      if (pick.engine === 'codex') return this.runCodex(p, null, sink, pick.reason, attachments);
      // Only a non-default choice earns a prefix, so Plan 1 badges read exactly as before.
      const enginePrefix = p.engine && p.engine !== 'claude' ? pick.reason : null;
      if (p.model === 'auto') {
        // 자동: decided once, here, for the new session; later turns keep it as the session default (prompt cache).
        const auto = chooseAutoModel({ text: p.text, attachmentCount: attachments.length, usage: deps.usage.snapshot(), nowMs: this.now(), cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now()), protectedAccount: deps.protectedAccount });
        return this.runClaude({ ...p, model: auto.model, effort: p.effort ?? auto.effort }, null, sink, enginePrefix ? `${enginePrefix} · ${auto.reason}` : auto.reason, attachments, auto.model);
      }
      return this.runClaude(p, null, sink, enginePrefix, attachments);
    }
    return this.runClaude(p, state, sink, null, attachments);
  }

  /** D2/D3: one ChatGPT account — no routing, no session move, no retry; sandbox + approval never. */
  private async runCodex(p: TurnParams, state: CodexSessionState | null, sink: TurnSink, reason: string, attachments: Attachment[], notice: string | null = null): Promise<void> {
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
    if (notice) sink.emit({ type: 'turn_notice', ...scope(), message: notice });
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
        case 'rate_limit': case 'compact': case 'task_done': case 'background': case 'continue': case 'progress': case 'sub_tool_call': case 'sub_tool_result': case 'task_update': break;
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

  /** Explicit Gemini: a new session takes the first logged-in, non-cooled account (g1, then g2) and stays on it. */
  private async runGemini(p: TurnParams, state: GeminiSessionState | null, sink: TurnSink, reason: string, attachments: Attachment[]): Promise<void> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    const model: GeminiModel = isGeminiModel(p.model) ? p.model : (state?.defaultModel ?? DEFAULT_GEMINI_MODEL);
    const sandbox: CodexSandbox = state?.sandbox ?? p.sandbox ?? defaultSandbox(deps.autoApprove?.() ?? false);
    let sessionId: string | null = state?.sessionId ?? null;
    const scope = () => ({ turnId: p.turnId, sessionId, cwd });
    const fail = (account: GeminiAccount, errorText: string) =>
      sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: { account, model, reason, usage: ZERO_USAGE, modelNote: null }, errorText });
    const gem = deps.gemini;
    if (!gem) { fail(state?.account ?? 'g1', 'gemini CLI 를 찾을 수 없습니다'); return; }
    let account: GeminiAccount;
    if (state) {
      account = state.account;
      if (!gem.loggedIn(account)) { fail(account, `Gemini ${SEAT_LABEL[account]} 로그인 필요`); return; }
    } else {
      const loggedIn = GEMINI_ACCOUNTS.filter((a) => gem.loggedIn(a));
      if (!loggedIn.length) { fail('g1', 'Gemini 로그인 필요 (docs/gemini-spike.md)'); return; }
      const free = loggedIn.find((a) => (this.geminiCooldownUntil[a] ?? 0) <= this.now());
      account = free ?? loggedIn[0]!;
      reason = `${reason} · ${SEAT_LABEL[account]}${free ? '' : ' (모두 쿨다운)'}`;
    }
    const badge = (usage: TurnUsage) => ({ account, model, reason, usage, modelNote: null });
    if (sink.signal.aborted) { fail(account, '중단됨'); return; }
    sink.emit({ type: 'turn_started', ...scope(), account, model, reason, attempt: 0, engine: 'gemini' });
    let result: EngineResult | null = null;
    for await (const ev of gem.engine.runTurn({ account, cwd, resumeSessionId: state?.sessionId ?? null, model, sandbox, prompt: promptWithFiles(p.text, attachments), signal: sink.signal })) {
      switch (ev.kind) {
        case 'init': sessionId = ev.sessionId; break;
        case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
        case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
        case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
        case 'result': result = ev; break;
        case 'rate_limit': case 'compact': break;
      }
    }
    const res: EngineResult = result ?? { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
    // Only an id the CLI reported (init) is stored, never a rejected resume id echoed back.
    if (sessionId) {
      await deps.store.set({
        engine: 'gemini', account, sessionId, cwd, lastTurnAtMs: res.ok ? this.now() : (state?.lastTurnAtMs ?? null), justCompacted: false,
        defaultModel: state?.defaultModel ?? model, sandbox, createdAtMs: state?.createdAtMs ?? this.now(), title: state?.title ?? titleOf(p.text),
      });
    }
    if (!res.ok && GEMINI_LIMIT_RE.test(res.errorText ?? '')) this.geminiCooldownUntil[account] = this.now() + COOLDOWN_MS.limit;
    sink.emit({ type: 'turn_result', ...scope(), ok: res.ok, text: res.text, badge: badge(res.usage), errorText: res.ok ? null : displayError(res.errorText, res.stderr) });
  }

  private async runClaude(p: TurnParams, state: ClaudeSessionState | null, sink: TurnSink, enginePrefix: string | null, attachments: Attachment[], newSessionModel?: ClaudeModel): Promise<void> {
    const id = state?.sessionId;
    if (id) this.active.add(id);
    // Notices before the turn has started would have no turn item to attach to (the UI shows them as an error).
    const early: string[] = [];
    let end: ClaudeSessionState | null = null;
    try {
      if (state) {
        // A write-back still copying this session finishes first (it must not see the next turn's writes).
        await this.mirrors.get(state.sessionId);
        state = await this.reconcile(state, (m) => early.push(m));
      }
      try {
        end = await this.runClaudeTurn(p, state, sink, enginePrefix, attachments, early, newSessionModel);
      } finally {
        this.inputs.delete(p.turnId);
      }
      // The final write-back at close (also after a long hold for background work).
      if (end) this.scheduleMirror(end.sessionId, sink, p.turnId);
    } finally {
      if (id) this.active.delete(id);
      // The CLI process has closed: whatever it wrote was deck's.
      if (end) this.deckWroteAt.set(path.resolve(end.projectDir, `${end.sessionId}.jsonl`), this.now());
    }
  }

  /** The Claude turn proper; resolves (after any background follow-through) with the session's final state. */
  private async runClaudeTurn(p: TurnParams, state: ClaudeSessionState | null, sink: TurnSink, enginePrefix: string | null, attachments: Attachment[], early: string[], newSessionModel?: ClaudeModel): Promise<ClaudeSessionState | null> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    const sessionDefault = state?.defaultModel ?? newSessionModel ?? DEFAULT_MODEL;
    // 자동 on a later turn: the session keeps its model, and its auto effort unless the user picked one.
    if (p.model === 'auto' && p.effort === undefined) p = { ...p, effort: AUTO_EFFORT[sessionDefault] };
    const wantedClaude = isClaudeModel(p.model) ? p.model : undefined;
    const wanted = wantedClaude ?? sessionDefault;
    const pin = state ? (state.accountPin ?? null) : (p.accountPin ?? null);
    const routerBase = { usage: deps.usage.snapshot(), nowMs: this.now(), protectedAccount: deps.protectedAccount, needFable: wanted === 'fable', pinned: pin };

    const first = chooseAccount({
      ...routerBase,
      current: state?.account ?? null,
      lastTurnAtMs: state?.lastTurnAtMs ?? null,
      justCompacted: state?.justCompacted ?? false,
      cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now()),
    });
    let account = first.account;
    let reason = enginePrefix ? `${enginePrefix} · ${first.reason}` : first.reason;
    const flushEarly = () => { for (const message of early.splice(0)) sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId: state?.sessionId ?? null, cwd, message }); };
    // The badge's pin marker: the account is the pinned one because of the pin.
    let byPin = first.pinned === true;
    if (state && account !== state.account) {
      const moved = await this.relocate(state, account, (m) => early.push(m));
      if (moved) state = moved;
      else { account = state.account; reason = `이전 실패 · ${LABEL[account]} 유지`; byPin = false; }
    }
    // Non-blocking: the same session written moments ago by Desktop/CLI is about to be continued in two places.
    if (state && (await this.openElsewhere(state))) early.push(OPEN_ELSEWHERE_NOTICE);
    if (pin && first.pinBlocked && account !== pin) early.push(`${LABEL[pin]} 계정 ${first.pinBlocked} — 이번 턴은 ${LABEL[account]} 로 (고정은 유지)`);
    const pinMark = () => (byPin ? { pinned: true } : {});

    const tried: Account[] = [];
    const grants: SessionGrants = { rules: [...(state?.allowRules ?? [])], dirs: [...(state?.allowDirs ?? [])], acceptEdits: state?.mode === 'acceptEdits' };
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Review M2: an interrupt between attempts (or before the first) ends the turn here.
      if (sink.signal.aborted) {
        flushEarly();
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId: state?.sessionId ?? null, cwd, ok: false, text: '', badge: { account, model: wantedClaude ?? sessionDefault, reason, usage: ZERO_USAGE, modelNote: null, ...pinMark() }, errorText: '중단됨' });
        return state;
      }
      const fable = deps.usage.snapshot().accounts[account].fable?.usedPct ?? null;
      const { model, note } = resolveModel(wantedClaude, sessionDefault, fable);
      sink.emit({ type: 'turn_started', turnId: p.turnId, sessionId: state?.sessionId ?? null, cwd, account, model, reason, attempt, engine: 'claude' });
      flushEarly();

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
          // Taken only by a new entry (a new session's pin); an existing entry keeps its stored pin.
          ...(pin ? { accountPin: pin } : {}),
        };
        await deps.store.set(state);
      }

      const failure = classifyFailure({ ok: res.ok, errorText: res.errorText, errorKind: res.errorKind, rateLimitStatus: a.rateLimit?.status ?? null });
      const badge = { account, model, reason, usage: res.usage, modelNote: note, ...pinMark() };
      const shownError = displayError(res.errorText, res.stderr);
      if (res.ok || failure === 'other' || failure === null || attempt === this.maxRetries || sink.signal.aborted) {
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId, cwd, ok: res.ok, text: res.text, badge, errorText: res.ok ? null : shownError });
        // Held open for background work: write back now too, not only once at the end.
        if (sessionId && a.bgTasks.length) this.mirrorSoon(sessionId, sink, p.turnId);
        if (sessionId) await this.followThrough({ p, a, cur, sink, account, model, cwd, sessionId, grants });
        else await a.rest.return?.();
        return state;
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
        const sid = state.sessionId;
        const moved = await this.relocate(state, cand.account, (message) => sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId: sid, cwd, message }));
        if (moved) { state = moved; next = cand; break; }
        moveRefused = true;
        tried.push(cand.account);
      }
      if (!next) {
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId, cwd, ok: false, text: '', badge, errorText: `${why} · ${moveRefused ? '세션 이전 실패' : '대안 계정 없음'} · ${shownError ?? ''}`.trim() });
        return state;
      }
      sink.emit({ type: 'turn_retry', turnId: p.turnId, sessionId: state?.sessionId ?? sessionId, cwd, fromAccount: account, toAccount: next.account, reason: `${why} → ${next.reason}`, attempt: attempt + 1 });
      reason = `재시도(${why}) · ${next.reason}`;
      account = next.account;
      byPin = false;
    }
    return state;
  }
}
