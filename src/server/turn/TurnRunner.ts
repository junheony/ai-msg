import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GEMINI_ACCOUNTS, GEMINI_LABEL, GROK_LABEL, isGeminiAccount, isGrokAccount, type Account, type AccountNames, type GeminiAccount, type GrokAccount, type ProjectsRoots } from '../../shared/accounts';
import { AUTO_EFFORT, DEFAULT_CODEX_MODEL, DEFAULT_EFFORT, DEFAULT_GEMINI_MODEL, DEFAULT_GROK_MODEL, DEFAULT_MODEL, DEFAULT_SANDBOX, GROK_CLI_ALIAS, IMPORTED_DEFAULT_MODEL, MODEL_EFFORTS, defaultGeminiSandbox, effortFor, isClaudeModel, isCodexModel, isGeminiModel, isGrokModel, type ClaudeModel, type CodexModel, type CodexSandbox, type Effort, type EngineChoice, type EngineKind, type GeminiModel, type GrokModel, type ModelChoice } from '../../shared/models';
import { sdkPermMode, type PermMode } from '../../shared/permission';
import { conciseStylePrompt } from '../../shared/concise';
import { DECK_CHOICES_PROMPT, systemReminder } from '../../shared/choices';
import { deckAddendum } from '../../shared/memory';
import type { Locale } from '../../shared/locale';
import { languageDirective } from './language';
import type { RoutingPolicy, ServerMessage, TurnPrompt } from '../../shared/protocol';
import { promptWithFiles, type Attachment, type AttachmentStore } from '../attachments/AttachmentStore';
import { ZERO_USAGE, type BgTaskInfo, type PermissionDecision, type QuestionAnswers, type TurnUsage } from '../../shared/turn-types';
import { appendAudit, hashInput, recordAudit, type ToolAuditEntry } from '../audit';
import type { CodexEngine } from '../engine/CodexEngine';
import type { GeminiEngine } from '../engine/GeminiEngine';
import type { GrokTurnRequest } from '../engine/GrokEngine';
import { findRolloutFile, readRolloutRateLimits } from '../engine/codexRollout';
import { ruleString, sessionUpdates, type BgTask, type Engine, type EngineEvent, type EngineResult, type LiveInput, type PermissionRequest, type QuestionRequest, type RateLimitSignal } from '../engine/Engine';
import { COOLDOWN_MS, classifyFailure, failureLabel, limitResetAtMs, limitResetHint } from '../engine/limitDetect';
import { fastFailureKind, type FastModeKind } from '../engine/claudeCli/texts';
import { FAST_FELL_BACK_NOTE, FAST_NOTE } from '../../shared/models';
import { StreamRedactor, displayError, redactSecrets } from '../engine/redact';
import { NO_ROTATION, chooseAccount, fixedAccount, onlyAccount, routeLogLine, type RouterInput } from '../routing/AccountRouter';
import { chooseAutoModel } from '../routing/AutoModel';
import { chooseRoute, clampEffort, classifyTask, turnFits, type RouteDecision } from '../routing/AutoRoute';
import { buildEngineLimits } from '../routing/engineLimits';
import { chooseEngine } from '../routing/EngineChoice';
import { readAllCooldownsMs, writeCooldown } from '../routing/cooldown';
import { resolveModel } from '../routing/ModelPolicy';
import type { SessionIndex } from '../sessions/SessionIndex';
import { findCopies, resolveCopies } from '../sessions/copies';
import { CODEX_ARCHIVED_NOTICE, importBlockReason, liveRolloutNotice, rolloutActiveAgeMs } from '../sessions/CodexImports';
import { elsewhereNotice } from '../sessions/elsewhereNotice';
import { GROKBOT_ID_PREFIX, GROKBOT_SEND_REFUSED } from '../sessions/GrokBotImports';
import { GROK_HELD_NOTICE, grokImportBlockReason } from '../sessions/GrokImports';
import { OWN_LAG_MS, scanForeign } from '../sessions/foreignWrites';
import { deckWrites } from '../engine/claudeCli/ownedEntries';
import { backupDivergedAndMove } from '../sessions/SessionFork';
import { isAncestor, moveSession } from '../sessions/SessionMover';
import { moveToTrash, restoreFromTrash } from '../sessions/SessionTrash';
import { projectSlug } from '../sessions/slug';
import type { UsageService } from '../usage/UsageService';
import { usageOf, type GrokBilling } from '../../shared/usage-types';
import { isCodexState, isGeminiState, isGrokState, isOtherEngineState, type ClaudeSessionState, type CodexSessionState, type GeminiSessionState, type GrokSessionState, type SessionState, type SessionStateStore } from './SessionState';

export type TurnSink = {
  emit(msg: ServerMessage): void;
  askPermission(req: PermissionRequest & { turnId: string; sessionId: string | null; cwd: string }): Promise<PermissionDecision>;
  /** D8: an AskUserQuestion card; null = unanswered (timeout, abort, turn end). */
  askQuestion(req: QuestionRequest & { turnId: string; sessionId: string | null; cwd: string }): Promise<QuestionAnswers | null>;
  signal: AbortSignal;
  /** The CLI named the turn's session (a new one, a fork) — before any event carries the id, so a reload mid first turn can find it. */
  sessionKnown?(sessionId: string): void;
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
  /** New Claude sessions only: the mode picked before the first send (existing sessions keep their stored mode). */
  permissionMode?: PermMode;
  /** 새 세션으로 이어가기: the handoff-note turn — Claude runs it with every tool call denied (TurnRequest.noTools). */
  handoff?: boolean;
  /**
   * 메시지 편집 갈래 (new sessions only): fork Claude session `from` at chain entry `at` (the entry the edited
   * message followed) into a new session; `text` replaces that message. The fork keeps the parent's cwd, pin,
   * model and grants. The parent's transcript is never written.
   */
  fork?: { from: string; at: string };
  /** 간결 모드 (send.concise): the engine gets shared/concise CONCISE_STYLE_PROMPT as an appended system prompt (Claude). */
  concise?: boolean;
  /**
   * ⚡ 빠르게 (send.fast): a person's Claude turn runs on Opus with `fastMode` (usage credits). Not a handoff note, a
   * 총사령탑 hop, deck's own cap continuation or automatic retry (fastTurn); Codex / Gemini / Grok ignore it.
   */
  fast?: boolean;
  /** Server-internal: a 백그라운드 작업's turn (no one watches it: the style note asks no AskUserQuestion). */
  bgTask?: boolean;
  /** Server-internal: how many times this turn already moved on to another account after a background segment hit a limit (failoverAfterBackground). */
  failoverHop?: number;
  /** Server-internal (failoverAfterBackground): a follow-up's send ref, carried on its turn_started so ws records the message as taken. */
  clientRef?: string;
  /** Server-internal: this turn is the n-th automatic retry after 대안 계정 없음 (SessionState.pendingRetry, fired through ws). */
  retryHop?: number;
  /** Server-internal (continueAfterCap): this turn is the n-th continuation deck sent by itself after the background wait limit cut the session's work. */
  bgCapHop?: number;
  /**
   * Server-internal (총사령탑 3층): this turn runs with the automatic-turn tool gate (TurnRequest.commanderHop — Bash and
   * `mcp__*` ask unless allowlisted, hooks fail closed). Carried to the cap continuation and the failover turn it spawns.
   */
  commanderHop?: number;
  /** Server-internal (총사령탑 §6): appended to this turn's systemNote ("deck 총사령탑 자동 지시 n/상한 — …"). The first turn only, not its cap / failover continuations. */
  commanderNote?: string;
  /** 그래도 보내기: skip the capability check (auto-route §10-4) that would answer `route_fit` instead of running the turn. */
  ignoreFit?: boolean;
  /** The reply language (ws: turnLanguage — the device's send.lang, else the session's last, else settings `language`); en / absent = no note. Carried to continuations. */
  lang?: Locale;
};

/** 자동 분배 settings (DeckSettings autoEngines / autoConsent / grokFast). */
export type AutoRouteSettings = { autoEngines: readonly EngineKind[]; autoConsent: readonly EngineKind[]; grokFast: boolean };
const DEFAULT_AUTO_ROUTE: AutoRouteSettings = { autoEngines: ['claude', 'codex', 'gemini', 'grok'], autoConsent: [], grokFast: false };
const ROUTE_ENGINE_LABEL: Record<EngineKind, string> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini', grok: 'Grok' };

/** ⚡ 빠르게 applies to this turn: only a person's turn (never a handoff note, 총사령탑 hop, cap continuation or automatic retry). */
export function fastTurn(p: Pick<TurnParams, 'fast' | 'handoff' | 'commanderHop' | 'bgCapHop' | 'retryHop'>): boolean {
  return p.fast === true && !p.handoff && p.commanderHop === undefined && !p.bgCapHop && !p.retryHop;
}
/** The badge note of a ⚡ 빠르게 turn. */
export { FAST_FELL_BACK_NOTE, FAST_NOTE };
/** ⚡ Said with the turn_result whose `fastOff` turns the session's switch off (credits used up). */
export const FAST_OFF_NOTICE = '⚡ 사용 크레딧이 떨어져 이 세션의 ↯ 빠르게를 껐습니다';
const FAST_SAID_MAX = 500;
/** ⚡ A fast turn's failure that is about fast mode itself (claudeCli/texts fastFailureKind): never a plan limit. */
function fastFailureOf(p: TurnParams, ev: { ok: boolean; errorText: string | null; errorKind: string | null }, aborted: boolean, rateLimitStatus: RateLimitSignal['status'] | null = null): FastModeKind | null {
  return fastTurn(p) && !ev.ok && !aborted ? fastFailureKind(ev.errorText, ev.errorKind, rateLimitStatus) : null;
}

/** A commanderHop turn on a Codex/Gemini/Grok session (총사령탑 v1 = Claude only): refused, never run ungated. */
export const COMMANDER_ENGINE_REFUSED = '총사령탑 자동 턴은 Claude 세션에서만 실행됩니다';

/** The background wait limit (ClaudeEngine bgMaxMs) cutting work → at most this many continuations deck sends by itself in a row (continueAfterCap). */
export const MAX_BG_CAP_HOPS = 2;

/** 대안 계정 없음 → at most this many automatic retries of the same prompt (SessionState.pendingRetry). */
export const MAX_RETRY_HOPS = 2;
export const AUTO_RETRY_NOTICE = '한도가 풀려 자동으로 다시 시도합니다';

/** The pre-send `holders.refresh({ force: true })` waits at most this long: a hung `ps`/`lsof` never stalls a send — the last known answer stands. */
export const FORCE_HOLDERS_SCAN_TIMEOUT_MS = 1000;

export type TurnRunnerDeps = {
  engine: Engine;
  /** deck 메모 (MemoryStore.get): appended to every turn's system prompt except a handoff note's; absent = none. */
  memory?: () => string;
  /** Null = Codex disabled (D11); tests inject a fake with just runTurn. */
  codex: Pick<CodexEngine, 'runTurn'> | null;
  /** Null = agy not installed. `loggedIn` reads the cached `agy models` probe (only g1 can be logged in). */
  gemini?: { engine: Pick<GeminiEngine, 'runTurn'>; loggedIn: (account: GeminiAccount) => boolean } | null;
  /** Re-reads the Gemini quota shortly after a Gemini turn (GeminiUsagePoller.bump); absent = none. */
  geminiUsage?: { bump(): void } | null;
  /** Notes every ended Grok turn's tokens/error for the usage header's Grok card (GrokUsageTracker.noteTurn); absent = no Grok usage card. */
  grokUsage?: { noteTurn(account: GrokAccount, result: { ok: boolean; errorKind: string | null; usage: { inputTokens: number; outputTokens: number }; cooldownUntilMs: number | null; /** The turn's `_x.ai/billing` read, when it had one. */ billing?: GrokBilling }): void } | null;
  /** Null/absent = no `grok` binary. main binds runGrokTurn to the binary and x1's GROK_HOME; tests inject a fake. */
  grok?: { run: (req: GrokTurnRequest) => AsyncIterable<EngineEvent> } | null;
  /**
   * Processes outside deck holding a Grok session (by id: refused) or running in its folder (a warning); absent = no check.
   * `refresh({ force: true })` rescans before a send to a Grok session decides on it (a failed scan keeps the last answer).
   */
  holders?: { grokHeldBy?(sessionId: string): unknown; grokCwdHeld?(cwd: string): boolean | Promise<boolean>; refresh?(opts?: { force?: boolean }): Promise<boolean> } | null;
  /** Null = no attachment store; any attachment id then fails the turn as missing. */
  attachments: AttachmentStore | null;
  codexSessionsRoot: string;
  usage: UsageService;
  index: SessionIndex;
  store: SessionStateStore;
  cooldownDir: string;
  protectedAccount: Account | null;
  auditFile: string;
  /** The mode for new sessions and sessions with no stored mode (read per turn / per new GPT session); absent = 'default'. */
  defaultPermissionMode?: () => PermMode;
  /** 자동 routing policy (DeckSettings.routingPolicy, read per turn); absent = 'balance'. */
  routingPolicy?: () => RoutingPolicy;
  /** 같은 벤더 계정 자동 순환 (DeckSettings.sameVendorRotation, read per turn); absent = on (main passes the setting, off by default). */
  sameVendorRotation?: () => boolean;
  /** 자동 분배 settings (read per new session); absent = every engine, no Gemini / Grok consent, Grok 4.7. */
  autoRoute?: () => AutoRouteSettings;
  /** 개발용(총사령탑 3단계, DECK_DEV_COMMANDER_GATE=1): every Claude turn without a commanderHop runs as hop 1 of the gate. */
  devCommanderGate?: boolean;
  /** One line per routed Claude turn (main: console.log); absent = not logged. */
  routeLog?: (line: string) => void;
  /** A session's mode changed during a turn (approved plan, 이 세션's "allow all edits") or via setPermissionMode. */
  onPermissionMode?: (sessionId: string, mode: PermMode) => void;
  /** Which Claude accounts exist, their order and labels. */
  accounts: AccountNames;
  /** `projects` dir of each configured account (retired included). */
  projectsRoots: ProjectsRoots;
  /**
   * The profile Claude Desktop and a plain `claude --resume` use (A). After every Claude turn that ran
   * elsewhere the session is mirrored back into it (append-only, prefix-checked). Absent/null = no write-back.
   */
  homeAccount?: Account | null;
  /** While a session is held open for background work: at most one write-back per this many ms (default 20 s). */
  mirrorThrottleMs?: number;
  move?: typeof moveSession;
  /** A diverged copy in the target profile (not home/protected) is backed up and overwritten so the move can go on. */
  replaceDiverged?: typeof backupDivergedAndMove;
  /** The session list changed on disk (a fork was written): rescan done, tell the clients. */
  onIndexChanged?: () => void;
  findRollout?: typeof findRolloutFile;
  readRateLimits?: typeof readRolloutRateLimits;
  now?: () => number;
  maxRetries?: number;
};

/** What a turn the user stopped says, whatever the engine threw on the way out (the UI hides it as an error line). */
export const ABORTED = '중단됨';
/** The abort reason deck's shutdown (ws abortAll) stops running turns with. */
export const SHUTDOWN_ABORT = 'deck-shutdown';
/** A turn cut by the server going down: shown (unlike a user's stop, which the UI hides as exactly ABORTED). */
export const SHUTDOWN_ABORTED = '서버가 다시 시작되어 중단됨';
/** The error text of an aborted turn: the user's stop (interrupt, 지금 전송; also a recycle) vs. the server shutting down. */
export const abortedText = (signal: AbortSignal): string => (signal.reason === SHUTDOWN_ABORT ? SHUTDOWN_ABORTED : ABORTED);
/** Told to the model once, with the first prompt of a brand-new session (systemNote; never shown in the pane). */
export const DECK_INTRO_NOTE = '[deck] 사용자는 deck 웹 UI(대개 폰·다른 기기의 브라우저)로 이 대화를 봅니다. 파일이나 URL 을 open/xdg-open/code 로 띄우지 마세요 — 서버에서만 열리고 사용자에게는 보이지 않습니다. 보여줄 파일은 경로를 인라인 코드로 적으면 사용자가 클릭해 사이드 패널에서 봅니다(세션 폴더 안의 파일만; 밖의 파일은 핵심 내용을 답장에 옮기세요).';

/** A Grok turn's mode moved into or out of plan mid-turn (other modes apply to the next request at once). */
export const GROK_MODE_NEXT_TURN_NOTICE = 'Grok 은 다음 턴부터 계획 모드 변경을 씁니다';
/** Start of the turn_notice said when the drain deadline cuts a process's background work (highlights.ts keys on it). */
export const SHUTDOWN_CUT_NOTICE = '서버가 다시 시작되어 백그라운드 작업';

/** agy / Gemini quota and 429 errors (RESOURCE_EXHAUSTED, rate limit); matched on the CLI's result error only. */
const GEMINI_LIMIT_RE = /\bRESOURCE_EXHAUSTED\b|exhausted your (daily )?quota|\bQuota exceeded\b|"code"\s*:\s*429\b|quota|rate limit|\b429\b/i;

/** `rest`: the engine stream after the first result (background continuations); `live`: its input handle. */
type Attempt = {
  result: EngineResult | null; rateLimit: RateLimitSignal | null; sessionId: string | null; compacted: boolean; initCwd: string | null;
  rest: AsyncIterator<EngineEvent>; live: LiveInput | null; bgTasks: string[];
  /** 자동 턴(commanderHop)에서 편집 도구가 불렸다 — runClaudeTurn 이 상태를 쓴 뒤 SessionState.commanderEdited 로 남긴다. */
  commanderEdited?: boolean;
  /** ⚡ The fast-mode line the CLI sent during the attempt (a notice tagged `fast`). */
  fastKind?: FastModeKind;
};

/** What the next Claude turn of a session would be routed to (previewRoute): no turn is run, nothing is moved or stored. */
export type RoutePreview = { account: Account; asOpus?: boolean; reason: string };

/** A user message for a session whose process is still open for background work (see `followUp`). */
/**
 * `retryHop`: an automatic retry (TurnParams.retryHop) that found the session's process held open.
 * No `commanderHop` on purpose: a follow-up goes into a process that already runs with its own turn's gate (or none) —
 * the hook settings, fail-closed registration and autoApprove of that process apply to it as they are.
 */
export type FollowUpParams = { turnId: string; text: string; attachments?: string[]; model?: ModelChoice; clientRef?: string; retryHop?: number; /** The sending device's reply language (send.lang); the failover resend keeps it. */ lang?: Locale };

/**
 * A background / follow-up segment of a held-open process ended on a limit or auth failure (followThrough): the process
 * is closed and the work goes on on another account (failoverAfterBackground). `seg`: the failed segment; `followUp`:
 * set when that segment was a follow-up the user sent (it is sent again); `tasks`: background work the process still
 * had (cut with it); `queued`: follow-ups that waited behind the segment, sent after the continuation.
 */
type Failover = {
  failure: 'limit' | 'auth';
  errorText: string | null;
  seg: { turnId: string; reason: string };
  followUp: { f: FollowUpParams; attachments: Attachment[] } | null;
  tasks: string[];
  queued: { f: FollowUpParams; attachments: Attachment[] }[];
};

/**
 * The held-open process was ended by the background wait limit (EngineEvent bg_cap) with work still running: the model
 * was never told (no task notification comes from a dead process), so deck sends the session on by itself (continueAfterCap).
 */
type Capped = { cap: true; tasks: string[]; minutes: number };

/** The mutable "which deck turn is the process working for now" — permission cards and events follow it. */
type Cursor = { turnId: string };

/** How a follow-up was taken: written to the process now, or held in deck until the streaming segment's result (`queuedBehind` = that segment's reason). */
export type FollowUpTaken = { queuedBehind: string | null };
type LiveSession = { submit(f: FollowUpParams, attachments: Attachment[]): FollowUpTaken; /** Takes a follow-up still waiting in the queue back out (by its clientRef): its turn id, or null when none waits under that ref (already sent in, or never queued). */ cancelQueued(clientRef: string): string | null; /** When the process was started: it has read nothing another process wrote after this. */ since: number; /** Per transcript copy: the offset the foreign-write check found clean up to. */ clean: Map<string, number> };

/** What 이 세션 accepted: allow rules as rule strings and added directories (its acceptEdits becomes the session's mode). */
type SessionGrants = { rules: string[]; dirs: string[] };

/** A Claude turn's live permission mode: read per tool call, changed mid-turn by setPermissionMode or an approved plan. */
type ModeRef = { mode: PermMode };

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

/** Events that leave held thinking text held: more thinking, and the meters that tick between its deltas. */
function holdsThinking(ev: EngineEvent): boolean {
  return (ev.kind === 'thinking' && !!ev.text && !ev.redacted) || ev.kind === 'progress' || ev.kind === 'rate_limit';
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

/** §10-4: whether `cwd` (symlinks resolved) is inside HOME — Gemini edits files only in trusted folders. */
async function insideHome(cwd: string): Promise<boolean> {
  const real = async (x: string) => fs.realpath(x).catch(() => path.resolve(x));
  const [dir, home] = await Promise.all([real(cwd), real(os.homedir())]);
  return dir === home || dir.startsWith(home.endsWith(path.sep) ? home : home + path.sep);
}

export class TurnRunner {
  private readonly move: typeof moveSession;
  private readonly replaceDiverged: typeof backupDivergedAndMove;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly findRollout: typeof findRolloutFile;
  private readonly readRateLimits: typeof readRolloutRateLimits;
  private gptCooldownUntil: number | null = null;
  /** Claude sessions whose process stays open for background work, by session id. */
  private readonly live = new Map<string, LiveSession>();
  /** The engine input handle of each running Claude turn, by its first turn id (per-task stop). */
  private readonly inputs = new Map<string, LiveInput>();
  /**
   * Steers of each running Claude turn's process, by its first turn id: `pending` = written, not yet seen reaching
   * the model (steerId → prompt); `ids` = every steerId ever taken, so each is answered exactly once.
   */
  private readonly steering = new Map<string, { pending: Map<string, TurnPrompt>; ids: Set<string> }>();
  /** The live mode of each running Claude turn and the session it is for, by its first turn id. */
  /** notice: a running Grok turn, whose process cannot switch mode mid-turn, says so on the turn instead. */
  private readonly modes = new Map<string, { ref: ModeRef; sessionId: () => string | null; notice?: (message: string) => void }>();
  /** A pin set for a new or forked session during its first turn (no stored state yet), by turn id: stored with it. */
  private readonly bornPins = new Map<string, Account | null>();
  /** ⚡ The fast-mode notice kinds each session was told already (once per session and kind; oldest dropped past FAST_SAID_MAX). */
  private readonly fastSaid = new Map<string, Set<FastModeKind>>();
  /** setSandbox on a Codex Desktop / CLI thread deck has not run yet (no stored state): its first turn uses and stores it. */
  private readonly importSandboxes = new Map<string, CodexSandbox>();
  /** In-memory, per Gemini account, after a quota failure: new Gemini sessions open on the other account. */
  private geminiCooldownUntil: Partial<Record<GeminiAccount, number>> = {};
  /** In-memory, per Grok account, after a quota failure (design §8). Shown in the badge reason; never switches engines. */
  private grokCooldownUntil: Partial<Record<GrokAccount, number>> = {};
  /** The last finished Grok turn's failure kind (auth blocks Grok in 자동 분배); cleared by the next successful turn. */
  private grokLastError: 'auth' | 'other' | null = null;
  /** Home write-backs in flight, by session id (serialized per session; the next turn waits for it). */
  private readonly mirrors = new Map<string, Promise<void>>();
  /** Notices already shown, `${sessionId}\0${message}` — a lasting divergence is told once, not every turn. */
  private readonly noted = new Set<string>();
  /** Home write-back failures already logged, `${sessionId}\0${reason}` — logged once, until a write-back of that session succeeds. */
  private readonly writeBackLogged = new Set<string>();
  /** When each session's last write-back was started (wall clock), and a trailing one due while throttled. */
  private readonly mirrorAt = new Map<string, number>();
  private readonly mirrorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Claude sessions with a deck turn running now (its process may write the jsonl at any moment), counted: an edit-fork
   * reading its parent and the parent's own turn each hold it, so the first to end does not unmark the other.
   */
  private readonly active = new Map<string, number>();
  /** When deck itself last wrote a transcript (its turn's process closed, a move/write-back), by resolved path. In memory only. */
  private readonly deckWroteAt = new Map<string, number>();

  private readonly accounts: AccountNames;
  /** `projects` dir by account, in configured order. */
  private readonly roots: ReadonlyMap<Account, string>;

  constructor(private readonly deps: TurnRunnerDeps) {
    this.accounts = deps.accounts;
    this.roots = new Map(deps.projectsRoots.map((r) => [r.id, r.dir]));
    const move = deps.move ?? moveSession;
    this.move = async (o) => {
      const r = await move(o);
      if (r.ok) this.deckWroteAt.set(path.resolve(r.targetFile), this.now());
      return r;
    };
    this.replaceDiverged = deps.replaceDiverged ?? backupDivergedAndMove;
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
   * (the caller refuses the send as busy); else how it was taken (`queuedBehind`: the segment it waits for).
   */
  followUp(sessionId: string, f: FollowUpParams): false | FollowUpTaken {
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

  /**
   * Withdraws a follow-up that still waits behind a streaming segment (the device's 취소 while turn_queued). The turn id
   * it was taken under when it was still in the queue; null once it went into the process (its turn_started is on its
   * way or already out) or when the session holds no process.
   */
  cancelQueued(sessionId: string, clientRef: string): string | null {
    return this.live.get(sessionId)?.cancelQueued(clientRef) ?? null;
  }

  /**
   * Whether the session's held-open process (see `followUp`) is behind: since it started, some copy of the transcript
   * gained main-chain entries deck did not write (Claude Desktop / a terminal CLI went on with the session). That
   * process would answer from before them; a new one resumes from the newest copy (`reconcile`). False when no
   * process is held open — every ordinary turn starts a new process that reads the transcript as it is. Never throws.
   */
  async foreignWrites(sessionId: string): Promise<boolean> {
    const entry = this.live.get(sessionId);
    const st = this.deps.store.get(sessionId);
    if (!entry || !st || isOtherEngineState(st)) return false;
    try {
      const copies = await findCopies(this.deps.projectsRoots, sessionId, st.projectDir, st.account);
      for (const c of copies) {
        const from = entry.clean.get(c.file);
        // Never scanned: the stat spares the read (2 s of slack for file systems that keep whole-second mtimes).
        if (from === undefined && c.mtimeMs < entry.since - 2000) continue;
        // Scanned before: only what was appended since is read, so a process held open for hours costs each send the same.
        const r = await scanForeign(c.file, entry.since, from ?? 0, { isOwn: (u, id) => deckWrites.has(u, id), lagMs: OWN_LAG_MS });
        if (r.foreign) return true;
        entry.clean.set(c.file, r.end);
      }
    } catch (err) {
      console.error('deck: foreign write check failed', err instanceof Error ? err.message : err);
    }
    return false;
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

  private label(account: Account): string {
    return this.accounts.label(account);
  }

  /** The account's `projects` dir. Throws for an account that is not configured (a stored session of a removed one). */
  private rootOf(account: Account): string {
    const root = this.roots.get(account);
    if (root === undefined) throw new Error(`설정에 없는 계정: ${account}`);
    return root;
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
    if (!home || !st || isOtherEngineState(st) || st.account === home) return null;
    const homeDir = path.join(this.rootOf(home), path.basename(st.projectDir));
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
    const diverged = both && !(await isAncestor(pair.homeFile, pair.deckFile)) && !(await isAncestor(pair.deckFile, pair.homeFile));
    return { diverged, deckAccount: pair.st.account, homeAccount: pair.home };
  }

  /**
   * "Desktop에서 열기": bring the home profile's copy up to date now (the same write-back as after a turn, awaited)
   * so `claude://resume?session=` finds the current conversation. `busy`: a CLI process of deck's still holds the session.
   */
  async openInDesktop(sessionId: string): Promise<{ ok: true; busy: boolean } | { ok: false; reason: 'unsupported' | 'diverged' | 'failed'; error?: string }> {
    const st = this.deps.store.get(sessionId);
    if (st && (isOtherEngineState(st))) return { ok: false, reason: 'unsupported' };
    const busy = this.active.has(sessionId) || this.live.has(sessionId);
    const home = this.deps.homeAccount;
    if (!st || !home || st.account === home) return { ok: true, busy };
    return this.serialize(sessionId, async () => {
      const r = await this.move({ sessionId, sourceProjectDir: st.projectDir, targetProjectsRoot: this.rootOf(home), ignoreOtherDirs: true });
      if (r.ok) return { ok: true as const, busy };
      // The home copy already contains ours: it is the newer one, nothing to write back.
      if (r.diverged && (await isAncestor(path.join(st.projectDir, `${sessionId}.jsonl`), path.join(this.rootOf(home), path.basename(st.projectDir), `${sessionId}.jsonl`)).catch(() => false))) return { ok: true as const, busy };
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

  /**
   * 삭제: every profile's copy of a Claude session goes to that profile's `session-trash/` (moved, never unlinked;
   * pruned after the backup retention). Refused while deck runs it (turn or background process) or while
   * another program (Desktop/CLI) seems to have it open. Returns the undo handle.
   */
  async trashSession(sessionId: string): Promise<{ ok: true; trashId: string } | { ok: false; error: string }> {
    return this.serialize(sessionId, async () => {
      const st = this.deps.store.get(sessionId);
      if (st && (isOtherEngineState(st))) return { ok: false as const, error: 'Claude 대화만 삭제할 수 있습니다' };
      const e = this.deps.index.lookup(sessionId);
      if (!st && (!e || e.account === 'gpt' || isGeminiAccount(e.account) || isGrokAccount(e.account) || e.imported)) return { ok: false as const, error: 'Claude 대화만 삭제할 수 있습니다' };
      if (this.active.has(sessionId) || this.live.has(sessionId)) return { ok: false as const, error: '실행 중인 대화는 삭제할 수 없습니다 — 끝난 뒤 다시 시도하세요' };
      const base: ClaudeSessionState = st ?? { sessionId, cwd: e!.cwd, account: e!.account as Account, projectDir: e!.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL };
      if ((await this.openElsewhere(base)) !== null) return { ok: false as const, error: '다른 곳(Desktop/CLI)에서 열려 있는 것 같아 삭제하지 않았습니다' };
      const copies = await findCopies(this.deps.projectsRoots, sessionId, base.projectDir, base.account).catch(() => []);
      try {
        const r = await moveToTrash({ sessionId, projectDirs: copies.map((c) => c.projectDir), nowMs: this.now() });
        return { ok: true as const, trashId: r.trashId };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  /** 되돌리기 for trashSession. */
  async restoreSession(trashId: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    try {
      const r = await restoreFromTrash({ trashId, projectsRoots: [...this.roots.values()] });
      return { ok: true, sessionId: r.sessionId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async mirrorHome(sessionId: string, home: Account, sink: TurnSink, turnId: string): Promise<void> {
    const st = this.deps.store.get(sessionId);
    if (!st || isOtherEngineState(st) || st.account === home) return;
    // Only the same-named dir is refreshed: a stale copy under an older dir spelling must not block it (nor is it touched).
    const r = await this.move({ sessionId, sourceProjectDir: st.projectDir, targetProjectsRoot: this.rootOf(home), ignoreOtherDirs: true });
    if (r.ok) {
      // A later failure (of any reason) is news again.
      for (const k of [...this.writeBackLogged]) if (k.startsWith(`${sessionId}\0`)) this.writeBackLogged.delete(k);
      return;
    }
    // The home copy already contains ours (Desktop went on, deck added nothing): the next turn pulls it in.
    if (r.diverged && (await isAncestor(path.join(st.projectDir, `${sessionId}.jsonl`), path.join(this.rootOf(home), path.basename(st.projectDir), `${sessionId}.jsonl`)).catch(() => false))) return;
    // Once per process for a given session and reason: a lasting state would otherwise log on every turn.
    const logKey = `${sessionId}\0${r.diverged ? 'diverged' : r.error}`;
    if (!this.writeBackLogged.has(logKey)) {
      this.writeBackLogged.add(logKey);
      console.error(`deck: home write-back of ${sessionId} to ${this.label(home)} failed: ${r.error}`);
    }
    this.noteOnce(sink, turnId, st, r.diverged
      ? `다른 곳(Desktop/CLI)에서 따로 이어진 대화가 있어 갈라졌습니다 — ${this.label(home)} 계정 사본은 덮어쓰지 않았습니다 (머리글의 '갈라짐' 메뉴에서 어느 쪽으로 맞출지 고를 수 있습니다)`
      : `${this.label(home)} 계정 사본 갱신 실패(${r.error}) — 대화는 계속됩니다`);
  }

  /**
   * Before a turn: the same session may have moved on in another profile (Claude Desktop on A).
   * A copy that contains ours is pulled into the profile deck last used (so routing is unchanged);
   * if that copy cannot be written, the session follows it instead. Truly diverged copies are never
   * merged or overwritten: the one with the latest conversation timestamp is used (a tie → deck's, not the
   * home copy) and the user is told.
   */
  private async reconcile(state: ClaudeSessionState, say: (message: string) => void): Promise<ClaudeSessionState> {
    try {
      const copies = await findCopies(this.deps.projectsRoots, state.sessionId, state.projectDir, state.account);
      // No copy where deck left it: nothing to compare against (locateProjectDir / the engine handle that).
      if (copies[0]?.projectDir !== state.projectDir || copies.length < 2) return state;
      const r = (await resolveCopies(copies, undefined, { home: this.deps.homeAccount }))!;
      if (r.heads.length > 1) {
        // Desktop's (home/protected) copy is never overwritten; a B/C copy is, once the session moves there (relocate backs it up first).
        const others = r.heads.filter((h) => h !== r.best).map((h) => h.account);
        const kept = others.filter((a) => a === this.deps.homeAccount || a === this.deps.protectedAccount);
        const replaced = others.filter((a) => !kept.includes(a));
        const names = (as: Account[]) => as.map((a) => this.label(a)).join('·');
        const parts = [
          ...(kept.length ? [`${names(kept)} 계정 사본은 덮어쓰지 않아요 (머리글의 '갈라짐' 메뉴에서 맞출 수 있습니다)`] : []),
          ...(replaced.length ? [`${names(replaced)} 계정 사본은 그 계정으로 옮길 때 백업해 두고 덮어써요`] : []),
        ];
        const message = `다른 곳(Desktop/CLI)에서 따로 이어진 대화가 있어 갈라졌습니다 — 가장 최근 대화가 있는 ${this.label(r.best.account)} 계정 사본으로 이어가고, ${parts.join(', ')}`;
        if (this.firstNote(state.sessionId, message)) say(message);
      }
      if (r.best.projectDir === state.projectDir) return state;
      if (!r.heads.includes(copies[0]!)) {
        // Ours is an older prefix of the winner: refresh it in place (moveSession accepts only that).
        const m = await this.move({ sessionId: state.sessionId, sourceProjectDir: r.best.projectDir, targetProjectsRoot: this.rootOf(state.account) });
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

  /**
   * A message typed while Claude turn `turnId` (its first id) runs, written into its process with priority 'next': the
   * CLI folds it in at the next tool boundary, or runs it right after the turn. `steer_delivered` (with `prompt`) is
   * emitted once it reaches the model; `steer_rejected` if the process ends or the turn retries first. Never resent by a
   * retry or failover. False = cannot go in now (no running Claude process, a handoff turn, attachment gone, input
   * closed, retrying). Null = already answered (a repeated steerId, or settled while being written): say nothing more.
   */
  async steer(turnId: string, s: { steerId: string; text: string; attachments?: string[]; prompt: TurnPrompt }): Promise<boolean | null> {
    const l = this.inputs.get(turnId);
    const st = this.steering.get(turnId);
    if (st?.ids.has(s.steerId)) return null;
    if (!l?.steer || !st) return false;
    let attachments: Attachment[] = [];
    if (s.attachments?.length) {
      const r = this.deps.attachments?.resolve([...new Set(s.attachments)]) ?? { found: [], missing: s.attachments };
      if (r.missing.length) return false;
      attachments = r.found;
    }
    // Registered before the write: the CLI may echo it back before the write resolves.
    st.ids.add(s.steerId);
    st.pending.set(s.steerId, s.prompt);
    try {
      if (await l.steer({ text: s.text, attachments }, s.steerId)) return true;
    } catch (err) {
      console.error('deck: steer failed', err instanceof Error ? err.message : err);
    }
    // Rejected (process ended, retry) or delivered meanwhile: that answer stands.
    return st.pending.delete(s.steerId) ? false : null;
  }

  /** A Claude engine notice as turn_notice — a ⚡ fast-mode one only the first time its session gets that kind. */
  private notice(ev: { message: string; fast?: FastModeKind }, sessionId: string | null, sink: TurnSink, scope: { turnId: string; sessionId: string | null; cwd: string }): void {
    if (ev.fast && sessionId) {
      const said = this.fastSaid.get(sessionId) ?? new Set<FastModeKind>();
      if (said.has(ev.fast)) return;
      said.add(ev.fast);
      this.fastSaid.delete(sessionId);
      this.fastSaid.set(sessionId, said);
      if (this.fastSaid.size > FAST_SAID_MAX) this.fastSaid.delete(this.fastSaid.keys().next().value!);
    }
    sink.emit({ type: 'turn_notice', ...scope, message: redactSecrets(ev.message) });
  }

  private steerDelivered(turnId: string, steerId: string, sink: TurnSink, scope: { turnId: string; sessionId: string | null; cwd: string }): void {
    const pending = this.steering.get(turnId)?.pending;
    const prompt = pending?.get(steerId);
    if (!pending || !prompt) return;
    pending.delete(steerId);
    sink.emit({ type: 'steer_delivered', ...scope, steerId, prompt });
  }

  /**
   * Every steer of `turnId` still waiting goes back to its device (sent after the turn instead).
   * Known edge: a steer the CLI already folded in just before an interrupt / crash whose echo never came out is
   * rejected here too, so the device sends it again after the turn — the model sees it twice. Rarer than losing it.
   */
  private rejectSteers(turnId: string, sink: TurnSink, scope: { turnId: string; sessionId: string | null; cwd: string }, message: string): void {
    const pending = this.steering.get(turnId)?.pending;
    if (!pending) return;
    for (const steerId of pending.keys()) sink.emit({ type: 'steer_rejected', ...scope, steerId, message });
    pending.clear();
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
    if (pin !== null && !this.accounts.list().includes(pin)) return false;
    if (!store.get(sessionId)) {
      // A new or forked session in its first turn (its id known since init): stored when the attempt ends.
      const born = this.bornTurnOf(sessionId);
      if (born) { this.bornPins.set(born, pin); return true; }
      const e = index.lookup(sessionId);
      if (!e || e.account === 'gpt' || isGeminiAccount(e.account) || isGrokAccount(e.account)) return false;
      await store.set({ sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL, ...(pin ? { accountPin: pin } : {}) });
      return true;
    }
    return store.setAccountPin(sessionId, pin);
  }

  /**
   * D2: changes a GPT session's sandbox (never danger-full-access: the type has no such value). codexArgs gives it every
   * turn, so it applies from the next one; a running turn keeps its own and stores this one when it ends. A Codex
   * Desktop / CLI thread deck has not run yet keeps the pick in memory for its first turn. False = not a GPT session.
   */
  async setSandbox(sessionId: string, sandbox: CodexSandbox): Promise<boolean> {
    let st = this.deps.store.get(sessionId);
    if (!st) {
      if (!(await this.deps.index.freshCodexImport(sessionId))) return false;
      // Its first turn may have ended (and stored it) during that await: then the store is the place.
      st = this.deps.store.get(sessionId);
      if (!st) { this.importSandboxes.set(sessionId, sandbox); return true; }
    }
    if (!isCodexState(st)) return false;
    if (st.sandbox !== sandbox) await this.deps.store.set({ ...st, sandbox });
    return true;
  }

  /**
   * 작업 폴더 바꾸기: the session's next turns run in `cwd` (already resolved and checked by the caller). A Claude session's
   * transcript (every profile's copy, with its `<id>/` dir) moves to the new folder's project dir — `claude --resume` only
   * looks there. Refused while a turn or held-open process runs it; Gemini / Grok sessions and unrun Codex imports cannot move.
   */
  async setCwd(sessionId: string, cwd: string): Promise<{ ok: true; engine: 'claude' | 'codex' } | { ok: false; error: string }> {
    const { store, index } = this.deps;
    if (this.active.has(sessionId) || this.live.has(sessionId) || this.bornTurnOf(sessionId)) return { ok: false, error: '세션이 실행 중이라 작업 폴더를 바꿀 수 없어요.' };
    return this.serialize(sessionId, async () => {
      const st = store.get(sessionId);
      if (st && isGeminiState(st)) return { ok: false as const, error: 'Gemini 세션은 작업 폴더를 바꿀 수 없어요.' };
      if (st && isGrokState(st)) return { ok: false as const, error: 'Grok 세션은 작업 폴더를 바꿀 수 없어요.' };
      if (st && isCodexState(st)) {
        if (st.cwd !== cwd) await store.set({ ...st, cwd });
        return { ok: true as const, engine: 'codex' as const };
      }
      let base: ClaudeSessionState;
      if (st) base = st;
      else {
        const e = index.lookup(sessionId);
        if (!e || e.account === 'gpt' || isGeminiAccount(e.account) || isGrokAccount(e.account)) return { ok: false as const, error: '작업 폴더를 바꿀 수 없는 세션이에요.' };
        base = { sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL };
      }
      const slug = projectSlug(cwd);
      let projectDir = base.projectDir;
      if (path.basename(base.projectDir) !== slug) {
        const copies = await findCopies(this.deps.projectsRoots, sessionId, base.projectDir, base.account).catch(() => []);
        const moves = copies.map((c) => ({ from: c.projectDir, to: path.join(path.dirname(c.projectDir), slug) }));
        for (const m of moves) {
          if (await exists(path.join(m.to, `${sessionId}.jsonl`))) return { ok: false as const, error: '새 작업 폴더에 같은 세션 기록이 이미 있어요.' };
        }
        try {
          for (const m of moves) {
            await fs.mkdir(m.to, { recursive: true, mode: 0o700 });
            await fs.rename(path.join(m.from, `${sessionId}.jsonl`), path.join(m.to, `${sessionId}.jsonl`));
            if (await exists(path.join(m.from, sessionId))) await fs.rename(path.join(m.from, sessionId), path.join(m.to, sessionId));
          }
        } catch (err) {
          return { ok: false as const, error: `세션 기록을 옮기지 못했어요: ${err instanceof Error ? err.message : String(err)}` };
        }
        projectDir = path.join(path.dirname(base.projectDir), slug);
      }
      await store.set({ ...base, cwd, projectDir });
      return { ok: true as const, engine: 'claude' as const };
    });
  }

  /** The sandbox a Codex thread deck has not run yet was given (setSandbox), if any. */
  importSandboxOf(sessionId: string): CodexSandbox | null {
    return this.importSandboxes.get(sessionId) ?? null;
  }

  /** The running Claude turn (by its first id) working in `sessionId`, if any. */
  private bornTurnOf(sessionId: string): string | null {
    for (const [turnId, m] of this.modes) if (m.sessionId() === sessionId) return turnId;
    return null;
  }

  private defaultMode(): PermMode {
    return this.deps.defaultPermissionMode?.() ?? 'default';
  }

  /** The mode a Claude session's next tool call runs in: its running turn's, else the stored one, else the default. */
  permissionModeOf(sessionId: string): PermMode {
    for (const m of this.modes.values()) if (m.sessionId() === sessionId) return m.ref.mode;
    const st = this.deps.store.get(sessionId);
    return (st && isGrokState(st) ? st.permissionMode : st && !isOtherEngineState(st) ? st.mode : undefined) ?? this.defaultMode();
  }

  /**
   * The picker / Shift+Tab: stores a Claude session's mode and applies it to its running turn at once (tool calls read
   * it per call; the process gets Query.setPermissionMode). False = not a Claude session deck knows.
   */
  async setPermissionMode(sessionId: string, mode: PermMode): Promise<boolean> {
    const { store, index } = this.deps;
    const st = store.get(sessionId);
    if (!st) {
      // A new or forked session in its first turn (its id known since init): the turn's mode below is stored with the
      // session when the attempt ends.
      if (!this.bornTurnOf(sessionId)) {
        const e = index.lookup(sessionId);
        if (!e || e.account === 'gpt' || isGeminiAccount(e.account) || isGrokAccount(e.account)) return false;
        await store.set({ sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL, mode });
      }
    } else if (isGrokState(st)) {
      // Grok: deck answers the permission requests, reading the mode per request — a change applies at once (§14.1-3).
      // Plan mode is not offered for Grok (§14.2).
      if (mode === 'plan') return false;
      await store.set({ ...st, permissionMode: mode });
    } else if (isOtherEngineState(st)) {
      return false;
    } else {
      await store.set({ ...st, mode });
    }
    for (const [turnId, m] of this.modes) {
      if (m.sessionId() !== sessionId || m.ref.mode === mode) continue;
      const prev = m.ref.mode;
      m.ref.mode = mode;
      // Grok: modes apply to the next request at once; only entering or leaving plan would wait for the next turn.
      if (m.notice) { if (mode === 'plan' || prev === 'plan') m.notice(GROK_MODE_NEXT_TURN_NOTICE); continue; }
      await this.inputs.get(turnId)?.setPermissionMode?.(sdkPermMode(mode)).catch((err: unknown) => console.error('deck: setPermissionMode failed', err instanceof Error ? err.message : err));
    }
    return true;
  }

  /** A turn changed its own mode (the SDK already switched): remember it for the session and tell the clients. */
  private async applyMode(sessionId: string | null, ref: ModeRef, mode: PermMode): Promise<void> {
    ref.mode = mode;
    if (!sessionId) return;
    const st = this.deps.store.get(sessionId);
    if (st && !isOtherEngineState(st) && st.mode !== mode) {
      await this.deps.store.set({ ...st, mode }).catch((err: unknown) => console.error('deck: saving the permission mode failed', err instanceof Error ? err.message : err));
    }
    this.deps.onPermissionMode?.(sessionId, mode);
  }

  /** D3: set after a Codex limit failure; consulted by chooseEngine for 'auto'. In memory only. */
  gptCooldownUntilMs(): number | null {
    return this.gptCooldownUntil;
  }

  /**
   * Moves the session into `to`'s profile. A copy there that went its own way (the same id continued in two
   * places) is backed up to that profile's `session-backups/` and overwritten with ours (the copy reconcile chose),
   * then the move is retried — except in the home/protected profile (Desktop's), whose copy is never touched.
   * Notices go through `say` (the caller shows them on the turn).
   */
  private async relocate(state: ClaudeSessionState, to: Account, say: (message: string) => void): Promise<ClaudeSessionState | null> {
    const req = { sessionId: state.sessionId, sourceProjectDir: state.projectDir, targetProjectsRoot: this.rootOf(to) };
    let r = await this.move(req);
    let replaced: string | null = null;
    if (!r.ok && r.diverged) {
      // The target copy merely extends ours (it is ahead, not diverged): continue from it, as openInDesktop does.
      const targetDir = path.join(this.rootOf(to), path.basename(state.projectDir));
      if (await isAncestor(path.join(state.projectDir, `${state.sessionId}.jsonl`), path.join(targetDir, `${state.sessionId}.jsonl`)).catch(() => false)) {
        const next = { ...state, account: to, projectDir: targetDir };
        await this.deps.store.set(next);
        say('다른 계정에 더 최신 대화가 있어 그걸로 이어가요');
        return next;
      }
      if (to === this.deps.homeAccount || to === this.deps.protectedAccount) {
        say(`${this.label(to)} 계정(Desktop)에 따로 이어진 대화가 있어 그 사본은 그대로 두었어요 — ${this.label(state.account)} 계정에서 이어가요`);
        return null;
      }
      const refuse = [this.deps.homeAccount, this.deps.protectedAccount].filter((a): a is Account => !!a).map((a) => this.rootOf(a));
      const f = await this.replaceDiverged({ ...req, refuseProjectsRoots: refuse, move: this.move });
      if (f.ok) {
        r = f.move;
        console.log(`deck: ${state.sessionId} 의 ${this.label(to)} 계정 사본이 갈라져 백업(${f.backupDir}) 뒤 덮어씀`);
        replaced = `${this.label(to)} 계정에 따로 이어진 사본이 있어 백업해 두고 이 대화로 덮어썼어요 (백업: ${f.backupDir} — 자동 정리되지 않아요)`;
        if (f.keptAside.length) {
          console.error(`deck: ${state.sessionId} 의 옮겨 둔 원래 사본이 백업 뒤에 바뀌어 지우지 않음: ${f.keptAside.join(', ')}`);
          replaced += ' (옮기는 사이 바뀐 원래 사본은 지우지 않고 남겨 두었어요)';
        }
      } else {
        console.error(`deck: replacing the diverged copy of ${state.sessionId} in ${this.label(to)} failed (${f.restored ? 'restored' : 'NOT restored'}, backup ${f.backupDir ?? '-'}): ${f.error}`);
        r = { ok: false, error: f.restored ? f.error : `${f.error} · 백업: ${f.backupDir ?? '없음'}` };
      }
    }
    if (!r.ok) {
      say(`세션을 ${this.label(to)} 계정으로 옮기지 못해 ${this.label(state.account)} 계정에서 이어가요 (${r.error})`);
      return null;
    }
    const next = { ...state, account: to, projectDir: r.targetDir };
    await this.deps.store.set(next);
    if (replaced) say(replaced);
    return next;
  }

  /**
   * 메시지 편집 갈래 when the parent's account cannot take the turn: the parent is copied into `to`'s profile by the
   * safe mover (source never written) and the fork made from that copy. The parent itself is not relocated: its stored
   * state keeps its account and folder.
   */
  private async copyForFork(state: ClaudeSessionState, to: Account, say: (message: string) => void, why = `${this.label(state.account)} 계정을 지금 쓸 수 없어`): Promise<ClaudeSessionState | null> {
    const r = await this.move({ sessionId: state.sessionId, sourceProjectDir: state.projectDir, targetProjectsRoot: this.rootOf(to) });
    if (!r.ok) {
      say(`갈래를 ${this.label(to)} 계정에 만들지 못해 ${this.label(state.account)} 계정에서 만들어요 (${r.error})`);
      return null;
    }
    say(`${why} 대화를 ${this.label(to)} 계정에 복사해 갈래를 만들어요 — 원래 대화는 ${this.label(state.account)} 계정에 그대로 있어요`);
    return { ...state, account: to, projectDir: r.targetDir };
  }

  /**
   * A copy of the session (deck's or another profile's) was written in the last 2 minutes, after deck's own
   * last turn or write, with no deck process holding it: Desktop or a CLI probably has it open. Stat only.
   * Returns how long ago the newest such copy was written, else null.
   */
  private async openElsewhere(state: ClaudeSessionState): Promise<number | null> {
    if (this.live.has(state.sessionId)) return null;
    const now = this.now();
    const copies = await findCopies(this.deps.projectsRoots, state.sessionId, state.projectDir, state.account).catch(() => []);
    // A clearly future mtime is clock skew, not a writer.
    const ages = copies.filter((c) => {
      const deckAt = Math.max(state.lastTurnAtMs ?? 0, this.deckWroteAt.get(path.resolve(c.file)) ?? 0);
      return now - c.mtimeMs < 120_000 && now - c.mtimeMs > -5_000 && c.mtimeMs > deckAt + 5_000;
    }).map((c) => Math.max(0, now - c.mtimeMs));
    return ages.length ? Math.min(...ages) : null;
  }

  /** Ids of sessions with `commanderEdited` whose cwd is the same folder as `cwd` (compared by realpath). */
  private async editedInFolder(cwd: string): Promise<string[]> {
    const marked = this.deps.store.list().filter((s) => s.commanderEdited);
    if (!marked.length) return [];
    const real = (d: string) => fs.realpath(d).catch(() => path.resolve(d));
    const here = await real(cwd);
    const out: string[] = [];
    for (const s of marked) if ((await real(s.cwd)) === here) out.push(s.sessionId);
    return out;
  }

  /**
   * What rides this turn's system prompt, never the transcript: the 간결 모드 style note (a person's concise turn — not a
   * handoff note nor a 총사령탑 hop), the deck 메모 and the reply-language note (every turn but a handoff note, which must
   * stay tool- and context-free).
   */
  private addendum(p: TurnParams, engine: EngineKind = 'claude'): string | null {
    if (p.handoff) return null;
    const style = p.concise && p.commanderHop === undefined ? conciseStylePrompt(engine, { task: p.bgTask === true }) : null;
    let memory = '';
    try { memory = this.deps.memory?.() ?? ''; } catch { /* a broken store never blocks a turn */ }
    // GPT, Gemini and Grok have no question tool: they offer decisions as a deck-choices block (option cards in the pane).
    return deckAddendum({ style, choices: engine === 'claude' ? null : DECK_CHOICES_PROMPT, memory, language: languageDirective(p.lang, { questionTool: engine === 'claude' && !p.bgTask }) });
  }

  /**
   * Gemini and Grok take deck's context inside the prompt (a `<system-reminder>` the pane and history readers hide), so it
   * is sent on a session's first turn and again only when it changed — not on every turn of a long session. Keyed by the
   * engine's session id; after a server restart it is sent once more.
   */
  private readonly contextSent = new Map<string, string>();
  private contextFor(sessionId: string | null, addendum: string | null): string | null {
    if (!addendum) return null;
    if (sessionId && this.contextSent.get(sessionId) === addendum) return null;
    return addendum;
  }
  private contextDelivered(sessionId: string | null, context: string | null): void {
    if (!sessionId || !context) return;
    this.contextSent.delete(sessionId); // re-insert: the map keeps the most recent sessions last
    this.contextSent.set(sessionId, context);
    if (this.contextSent.size > 500) this.contextSent.delete(this.contextSent.keys().next().value!);
  }

  private async attempt(p: TurnParams, account: Account, model: ClaudeModel, cwd: string, resumeSessionId: string | null, forkAt: string | null, sink: TurnSink, grants: SessionGrants, modeRef: ModeRef, attachments: Attachment[], cur: Cursor, systemNote?: string): Promise<Attempt> {
    const scope = () => ({ turnId: cur.turnId, sessionId: out.sessionId, cwd });
    // The effort applies to the resolved model (a Fable → Opus downgrade keeps it when Opus supports it).
    const effort = effortFor(model, p.effort);
    const commanderHop = p.commanderHop ?? (this.deps.devCommanderGate ? 1 : undefined);
    // 보안 #8: a person's turn gated only by DECK_DEV_COMMANDER_GATE is labelled in the audit log.
    const devGate = commanderHop !== undefined && p.commanderHop === undefined;
    const addendum = this.addendum(p);
    // An edit on an earlier automatic turn of this session — or of any session in the same (realpath) folder — still holds
    // test runners and git at ask (rules.ts GateContext).
    const priorEdited = commanderHop !== undefined
      && ((resumeSessionId !== null && !!this.deps.store.get(resumeSessionId)?.commanderEdited) || (await this.editedInFolder(cwd)).length > 0);
    const events = this.deps.engine.runTurn({
      account,
      cwd,
      resumeSessionId,
      ...(forkAt ? { forkAt } : {}),
      model,
      ...(effort ? { effort } : {}),
      prompt: p.text,
      attachments,
      signal: sink.signal,
      allowRules: [...grants.rules],
      allowDirs: [...grants.dirs],
      ...(sdkPermMode(modeRef.mode) !== 'default' ? { permissionMode: sdkPermMode(modeRef.mode) as 'acceptEdits' | 'plan' } : {}),
      onPermission: async (pr) => {
        const decision = await sink.askPermission({ turnId: cur.turnId, sessionId: out.sessionId, cwd, ...pr });
        if (pr.toolName === 'ExitPlanMode') {
          // The plan card: 'session' = approve with edits auto-accepted, 'once' = approve and ask every time.
          if (decision !== 'deny') await this.applyMode(out.sessionId, modeRef, decision === 'session' ? 'acceptEdits' : 'default');
        } else if (decision === 'session') {
          addGrants(grants, pr);
          // The engine hands the SDK this setMode from whatever mode the turn is in (plan included): deck follows it.
          if (modeRef.mode !== 'acceptEdits' && sessionUpdates(pr).some((u) => u.type === 'setMode' && u.mode === 'acceptEdits')) await this.applyMode(out.sessionId, modeRef, 'acceptEdits');
        }
        // Review M6: the audit log is best-effort; losing it must not lose the user's answer.
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: pr.toolName, decision, source: 'user', inputSha256: hashInput(pr.input) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
        return decision;
      },
      // 모두 자동 승인 is read per call, so a mode change mid-turn applies to the next tool call. Never on an automatic
      // (commanderHop) turn: the gate's ask would reach the permission tool and be approved there unseen.
      autoApprove: commanderHop ? () => false : () => modeRef.mode === 'bypassPermissions',
      onAutoApproved: async (pr) => {
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: pr.toolName, decision: 'auto', source: 'auto', inputSha256: hashInput(pr.input) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
      },
      // Every other tool call (run or refused by a rule / the mode without a prompt, or by the handoff hook): one line each.
      onToolAudit: async (t) => {
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: t.toolName, decision: t.decision, source: t.source, inputSha256: hashInput(t.input) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
      },
      onQuestion: async (q) => {
        const answers = await sink.askQuestion({ turnId: cur.turnId, sessionId: out.sessionId, cwd, ...q });
        try {
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: 'AskUserQuestion', decision: answers ? 'answered' : 'deny', source: 'user', inputSha256: hashInput(q.questions) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
        return answers;
      },
      onQuestionMalformed: async (input) => {
        try {
          const questions = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : input;
          await appendAudit(this.deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, toolName: 'AskUserQuestion', decision: 'deny', source: 'deck', inputSha256: hashInput(questions) });
        } catch (err) {
          console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
        }
      },
      onLive: (l) => { out.live = l; this.inputs.set(p.turnId, l); },
      ...(p.handoff ? { noTools: true } : {}),
      ...(fastTurn(p) ? { fast: true } : {}),
      // Only a person's turn waits for a suggestion (an automatic turn, cap continuation or retry never holds the process for one).
      ...(!p.handoff && p.commanderHop === undefined && !p.bgTask && !p.bgCapHop && !p.retryHop && !p.failoverHop ? { suggest: true } : {}),
      ...(addendum ? { appendSystemPrompt: addendum } : {}),
      ...(systemNote ? { systemNote } : {}),
      ...(commanderHop ? {
        commanderHop,
        onCommanderGate: (g) => {
          const cmd = g.toolName === 'Bash' && g.input && typeof g.input === 'object' ? (g.input as { command?: unknown }).command : undefined;
          return recordAudit(this.deps.auditFile, { kind: 'commander_gate', ts: new Date(this.now()).toISOString(), turnId: cur.turnId, sessionId: out.sessionId, hop: commanderHop, toolName: g.toolName, decision: g.decision, inputSha256: hashInput(typeof cmd === 'string' ? cmd : g.input), ...(devGate ? { dev: true as const } : {}) });
        },
        ...(priorEdited ? { commanderEdited: true } : {}),
        onCommanderEdit: async () => {
          out.commanderEdited = true;
          // A fork's id is not the stored one until init; a brand-new session has no state yet — runClaudeTurn records it then.
          if (out.sessionId) await this.deps.store.setCommanderEdited(out.sessionId, true);
        },
      } : {}),
    });
    const rest = events[Symbol.asyncIterator]();
    // A fork's id is the one init reports, never the parent's.
    const out: Attempt = { result: null, rateLimit: null, sessionId: forkAt ? null : resumeSessionId, compacted: false, initCwd: null, rest, live: null, bgTasks: [] };
    this.modes.set(p.turnId, { ref: modeRef, sessionId: () => out.sessionId });
    // The first result ends the attempt; whatever follows (background continuations) is `rest`.
    const { emitThinking, flushThinking } = this.thinkingStream(sink, scope);
    try {
      while (!out.result) {
        const n = await rest.next();
        if (n.done) break;
        const ev = n.value;
        if (!holdsThinking(ev)) flushThinking();
        switch (ev.kind) {
          case 'init': if (ev.sessionId !== out.sessionId) sink.sessionKnown?.(ev.sessionId); out.sessionId = ev.sessionId; if (ev.cwd) out.initCwd = ev.cwd; break;
          case 'background': out.bgTasks = ev.tasks; sink.emit({ type: 'turn_background', ...scope(), tasks: ev.tasks, ...this.bgExtra(p.turnId, ev.detail) }); break;
          case 'continue': break;
          case 'progress': sink.emit({ type: 'turn_progress', ...scope(), outputTokens: ev.outputTokens, phase: ev.phase }); break;
          case 'sub_tool_call': sink.emit({ type: 'sub_tool_call', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'sub_tool_result': sink.emit({ type: 'sub_tool_result', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, isError: ev.isError }); break;
          case 'task_update': { const { kind: _k, ...u } = ev; sink.emit({ type: 'task_update', ...scope(), ...u, ...(u.summary ? { summary: redactSecrets(u.summary) } : {}) }); break; }
          case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
          case 'thinking': emitThinking(ev); break;
          case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
          case 'rate_limit':
            out.rateLimit = ev.info;
            this.deps.usage.applyTurn(account, { ...(ev.info.fiveHour ? { fiveHour: ev.info.fiveHour } : {}), ...(ev.info.weekly ? { weekly: ev.info.weekly } : {}), ...(ev.info.fable ? { fable: ev.info.fable } : {}) });
            break;
          case 'compact': out.compacted = true; break;
          case 'notice': if (ev.fast) out.fastKind = ev.fast; this.notice(ev, p.sessionId ?? out.sessionId, sink, scope()); break;
          case 'system': sink.emit({ type: 'turn_system', ...scope(), source: ev.source, label: ev.label, text: redactSecrets(ev.text) }); break;
          case 'task_done': sink.emit({ type: 'task_done', ...scope(), ...taskDoneOf(ev) }); break;
          case 'steer_delivered': this.steerDelivered(p.turnId, ev.id, sink, scope()); break;
          case 'suggestion': break;
          case 'result': out.result = ev; if (ev.sessionId) out.sessionId = ev.sessionId; break;
        }
      }
    } finally {
      // also when the engine stream throws: the held tail goes out (redacted), never lost
      flushThinking();
    }
    return out;
  }

  /**
   * Thinking deltas redacted as one stream, so a secret split across deltas is still caught: text that
   * may still be part of a match is held until the next delta, a new block, or any other event.
   * Never emits an empty chunk for held text (empty = "a block started" to the UI).
   */
  private thinkingStream(sink: TurnSink, scope: () => { turnId: string; sessionId: string | null; cwd: string }) {
    const r = new StreamRedactor();
    const flushThinking = () => { const text = r.flush(); if (text) sink.emit({ type: 'thinking', ...scope(), text }); };
    const emitThinking = (ev: Extract<EngineEvent, { kind: 'thinking' }>) => {
      if (ev.text && !ev.redacted) {
        const text = r.push(ev.text);
        if (text) sink.emit({ type: 'thinking', ...scope(), text });
        return;
      }
      flushThinking();
      sink.emit({ type: 'thinking', ...scope(), text: redactSecrets(ev.text), ...(ev.redacted ? { redacted: true } : {}) });
    };
    return { emitThinking, flushThinking };
  }

  /**
   * After the turn's own result: while the process stays open for background work, stream what
   * it does next into the same pane. Each later result closes a segment — a background
   * continuation (new turn id `<turnId>:bg<n>`, reason 백그라운드 계속) or a follow-up the user
   * sent meanwhile (its own turn id). Ends when the engine stream ends (no live task left, cap,
   * grace, abort).
   */
  private async followThrough(c: { p: TurnParams; a: Attempt; cur: Cursor; sink: TurnSink; account: Account; model: ClaudeModel; cwd: string; sessionId: string; grants: SessionGrants; startedAt: number }): Promise<Failover | Capped | null> {
    const { p, a, cur, sink, account, model, cwd, sessionId, grants, startedAt } = c;
    const scope = () => ({ turnId: cur.turnId, sessionId, cwd });
    // ⚡ Everything this process answers is billed as it was started (ws never joins a send asking otherwise).
    const fastNote = fastTurn(p) ? FAST_NOTE : null;
    type Seg = { turnId: string; reason: string; modelNote: string | null; followUp?: { f: FollowUpParams; attachments: Attachment[] } };
    let seg: Seg | null = null;
    let failover: Failover | null = null;
    /** The background wait limit ended the process with this work still running (EngineEvent bg_cap). */
    let capped: Capped | null = null;
    /** Set while the process is being closed after a limit / auth failure (follow-ups queue instead of going in). */
    let closing = false;
    let n = 0;
    let steered = 0;
    let tasks = a.bgTasks;
    // The server's drain deadline (SHUTDOWN_ABORT) cutting background work: said in the pane — unless the turn was cut
    // before its result, whose turn_result already says so — and kept for the session's next turn (the model is told then).
    // `live` is the work before the abort (the engine clears the tasks once the process is gone).
    const abortedBefore = sink.signal.aborted;
    let live = tasks;
    let cutSaid = false;
    const shutdown = () => sink.signal.aborted && sink.signal.reason === SHUTDOWN_ABORT && live.length > 0;
    const sayCut = () => {
      if (cutSaid || abortedBefore || !shutdown()) return;
      cutSaid = true;
      sink.emit({ type: 'turn_notice', ...scope(), message: `${SHUTDOWN_CUT_NOTICE} ${live.length}개가 중단됨: ${live.join(', ')}` });
    };
    const queue: { f: FollowUpParams; attachments: Attachment[] }[] = [];
    const open = (turnId: string, reason: string, modelNote: string | null, clientRef?: string, followUp?: Seg['followUp']) => {
      seg = { turnId, reason, modelNote, ...(followUp ? { followUp } : {}) };
      cur.turnId = turnId;
      sink.emit({ type: 'turn_started', turnId, sessionId, cwd, account, model, reason, attempt: 0, engine: 'claude', ...(clientRef ? { clientRef } : {}) });
    };
    const openBackground = () => {
      open(`${p.turnId}:bg${++n}`, '백그라운드 계속', fastNote);
      sink.emit({ type: 'turn_notice', ...scope(), message: '백그라운드 계속 — 백그라운드 작업이 끝나 이어서 진행합니다' });
    };
    const sendFollowUp = (f: FollowUpParams, attachments: Attachment[]) => {
      const note = isClaudeModel(f.model) && f.model !== model ? `${fastNote ? `${fastNote} · ` : ''}백그라운드 대기 중인 프로세스의 모델 유지` : fastNote;
      open(f.turnId, '백그라운드 대기 중 이어 보냄', note, f.clientRef, { f, attachments });
      if (f.retryHop) sink.emit({ type: 'turn_notice', ...scope(), message: AUTO_RETRY_NOTICE });
      const turnId = f.turnId;
      // Its turn_started recorded the ref as accepted: an error carrying it takes that back (ws), so a resent copy goes in.
      const failed = (errorText: string) => {
        seg = null;
        sink.emit({ type: 'turn_result', turnId, sessionId, cwd, ok: false, text: '', badge: null, errorText });
        if (f.clientRef) sink.emit({ type: 'error', turnId, message: errorText, clientRef: f.clientRef });
      };
      void (a.live?.send({ text: f.text, attachments }) ?? Promise.resolve(false)).then((ok) => {
        if (ok || seg?.turnId !== turnId) return;
        failed('세션 프로세스가 방금 끝나 보내지 못했습니다 — 다시 보내 주세요');
      }, () => {
        if (seg?.turnId !== turnId) return;
        failed('메시지를 보내지 못했습니다');
      });
    };
    const saveState = async (ok: boolean) => {
      const st = this.deps.store.get(sessionId);
      if (!st || isOtherEngineState(st)) return;
      await this.deps.store.set({
        ...st,
        ...(ok ? { lastTurnAtMs: this.now() } : {}),
        ...(grants.rules.length ? { allowRules: [...grants.rules] } : {}),
        ...(grants.dirs.length ? { allowDirs: [...grants.dirs] } : {}),
      });
    };
    // Follow-ups are taken only while background work holds the process open (else it closes right after this result).
    if (a.live && a.bgTasks.length) {
      this.live.set(sessionId, {
        since: startedAt,
        clean: new Map(),
        submit: (f, attachments) => {
          // While a segment streams the message waits here (the sender is told which segment: ws turn_queued).
          if (seg || closing) { queue.push({ f, attachments }); return { queuedBehind: seg?.reason ?? '다른 계정으로 이어가는 중' }; }
          sendFollowUp(f, attachments);
          return { queuedBehind: null };
        },
        cancelQueued: (clientRef) => {
          const i = queue.findIndex((q) => q.f.clientRef === clientRef);
          if (i < 0) return null;
          return queue.splice(i, 1)[0]!.f.turnId;
        },
      });
    }
    const { emitThinking, flushThinking } = this.thinkingStream(sink, scope);
    try {
      for (;;) {
        const next = await a.rest.next();
        if (next.done) break;
        const ev = next.value;
        // Held thinking text belongs to the segment it streamed in: out before any other event (or a new segment).
        if (!holdsThinking(ev)) flushThinking();
        // Output with no segment open (e.g. a continuation racing a follow-up) still gets a turn of its own.
        const needSeg = ev.kind === 'delta' || ev.kind === 'tool_call' || ev.kind === 'tool_result' || ev.kind === 'result';
        // A steer the CLI ran as its own turn (no tool boundary came before the result): a segment of its own.
        if (ev.kind === 'steer_delivered' && !seg) open(`${p.turnId}:s${++steered}`, '실행 중 보낸 메시지', fastNote);
        if ((ev.kind === 'continue' && !seg) || (needSeg && !seg)) openBackground();
        switch (ev.kind) {
          case 'steer_delivered': this.steerDelivered(p.turnId, ev.id, sink, scope()); break;
          case 'background': if (sink.signal.aborted) sayCut(); else live = ev.tasks; tasks = ev.tasks; sink.emit({ type: 'turn_background', ...scope(), tasks, ...this.bgExtra(p.turnId, ev.detail) }); break;
          case 'progress': if (seg) sink.emit({ type: 'turn_progress', ...scope(), outputTokens: ev.outputTokens, phase: ev.phase }); break;
          case 'sub_tool_call': sink.emit({ type: 'sub_tool_call', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'sub_tool_result': sink.emit({ type: 'sub_tool_result', ...scope(), parentToolUseId: ev.parentToolUseId, toolUseId: ev.toolUseId, isError: ev.isError }); break;
          case 'task_update': { const { kind: _k, ...u } = ev; sink.emit({ type: 'task_update', ...scope(), ...u, ...(u.summary ? { summary: redactSecrets(u.summary) } : {}) }); break; }
          case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
          case 'thinking': emitThinking(ev); break;
          case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
          case 'notice': this.notice(ev, sessionId, sink, scope()); break;
          // Only work that was really still running counts (an abort or shutdown racing the cap is theirs to report).
          case 'bg_cap': if (!sink.signal.aborted && (ev.tasks.length || live.length)) capped = { cap: true, tasks: ev.tasks.length ? ev.tasks : [...live], minutes: ev.minutes }; break;
          case 'system': sink.emit({ type: 'turn_system', ...scope(), source: ev.source, label: ev.label, text: redactSecrets(ev.text) }); break;
          // A background task settled while the process waits: the push (PushNotifier) fires here, not only inside the turn.
          case 'task_done': sink.emit({ type: 'task_done', ...scope(), ...taskDoneOf(ev) }); break;
          case 'rate_limit': this.deps.usage.applyTurn(account, { ...(ev.info.fiveHour ? { fiveHour: ev.info.fiveHour } : {}), ...(ev.info.weekly ? { weekly: ev.info.weekly } : {}), ...(ev.info.fable ? { fable: ev.info.fable } : {}) }); break;
          case 'result': {
            const s = seg as Seg | null;
            seg = null;
            // A limit / auth failure of a segment: no turn_result here — the work goes on on another account
            // (failoverAfterBackground says so with turn_retry, or ends the segment if no account is left).
            const fastFailed = fastFailureOf(p, ev, sink.signal.aborted);
            const failure = !ev.ok && !sink.signal.aborted && !fastFailed ? classifyFailure({ ok: false, errorText: ev.errorText, errorKind: ev.errorKind, rateLimitStatus: null }) : null;
            if (s && (failure === 'limit' || failure === 'auth')) {
              writeCooldown(this.deps.cooldownDir, account, this.now() + COOLDOWN_MS[failure]);
              // No follow-up goes into the closing process: one arriving now waits in the queue and goes on with the rest
              // (the queue is taken only once the process is closed, so nothing sent meanwhile is left behind).
              closing = true;
              this.live.delete(sessionId);
              await a.rest.return?.();
              failover = { failure, errorText: ev.errorText, seg: { turnId: s.turnId, reason: s.reason }, followUp: s.followUp ?? null, tasks: [...tasks], queued: queue.splice(0) };
              break;
            }
            if (s) {
              sink.emit({ type: 'turn_result', turnId: s.turnId, sessionId, cwd, ok: ev.ok, text: ev.text, badge: { account, model, reason: s.reason, usage: ev.usage, modelNote: s.modelNote }, errorText: ev.ok ? null : sink.signal.aborted ? abortedText(sink.signal) : displayError(ev.errorText, ev.stderr), ...(fastFailed ? { errorCode: 'fast_refused' as const } : {}), ...(fastFailed === 'exhausted' ? { fastOff: true as const } : {}) });
            }
            // Sent before the engine resumes, so it sees the message outstanding and keeps the input open — and before any
            // await: its turn_started refills ws's `current` in this same tick, so the microtask that ends a held process
            // while draining (ws endHeld) does not take the queued message down with it.
            const q = queue.shift();
            if (q) sendFollowUp(q.f, q.attachments);
            await saveState(ev.ok);
            this.mirrorSoon(sessionId, sink, s?.turnId ?? cur.turnId);
            break;
          }
          // After an interrupt the guess is stale: the engine drops it too, this covers one already on its way.
          case 'suggestion': if (!sink.signal.aborted) sink.emit({ type: 'prompt_suggestion', ...scope(), text: ev.text }); break;
          case 'init': case 'compact': case 'continue': break;
        }
        if (failover) break;
      }
    } finally {
      flushThinking();
      this.live.delete(sessionId);
      const s = seg as Seg | null;
      if (s) sink.emit({ type: 'turn_result', turnId: s.turnId, sessionId, cwd, ok: false, text: '', badge: { account, model, reason: s.reason, usage: ZERO_USAGE, modelNote: s.modelNote }, errorText: sink.signal.aborted ? abortedText(sink.signal) : '결과 없이 끝났습니다' });
      // Cut by the restart deadline: code draining, so the device holds the message and sends it again after the restart.
      const dropped = sink.signal.reason === SHUTDOWN_ABORT ? { code: 'draining' as const } : {};
      for (const q of queue) sink.emit({ type: 'error', turnId: q.f.turnId, message: '세션 프로세스가 끝나 보내지 못했습니다 — 다시 보내 주세요', ...dropped, ...(q.f.clientRef ? { clientRef: q.f.clientRef } : {}) });
      sayCut();
      if (tasks.length) sink.emit({ type: 'turn_background', ...scope(), tasks: [], detail: [] });
      if (shutdown()) {
        const st = this.deps.store.get(sessionId);
        if (st && !isOtherEngineState(st)) {
          await this.deps.store.set({ ...st, interrupted: { atMs: this.now(), tasks: [...live] } }).catch((err: unknown) => console.error('deck: 끊긴 작업 기록 실패', err instanceof Error ? err.message : err));
        }
      }
    }
    return failover ?? (sink.signal.aborted ? null : capped);
  }

  /**
   * The background wait limit (ClaudeEngine bgMaxMs) ended the session's process with work still running: the model
   * never hears of it (a dead process sends no task notification) and the session would sit until the user asks why.
   * So the cut is recorded (SessionState.interrupted, kind 'cap' — told to the model on the next turn, as a restart's
   * cut is) and deck sends '이어서 진행해 주세요.' itself, as a turn of the same session (routed as any turn; the UI shows
   * it under the turn that was held open). At most MAX_BG_CAP_HOPS in a row (TurnParams.bgCapHop): a continuation whose
   * own work hits the limit again is left for the user's next message, which still gets the note.
   */
  private async continueAfterCap(need: Capped, c: { p: TurnParams; sink: TurnSink; cwd: string; sessionId: string }): Promise<void> {
    const { p, sink, cwd, sessionId } = c;
    const st = this.deps.store.get(sessionId);
    if (!st || isOtherEngineState(st)) return;
    const hop = (p.bgCapHop ?? 0) + 1;
    const n = need.tasks.length;
    const cause = `백그라운드 작업 ${need.minutes}분 한도`;
    try {
      // The closed process wrote the transcript: deck's own write, not Desktop / a CLI (openElsewhere).
      this.deckWroteAt.set(path.resolve(st.projectDir, `${sessionId}.jsonl`), this.now());
      await this.deps.store.set({ ...st, interrupted: { atMs: this.now(), tasks: need.tasks, cause, kind: 'cap' } });
    } catch (err) {
      console.error('deck: 끊긴 작업 기록 실패', err instanceof Error ? err.message : err);
      return;
    }
    if (hop > MAX_BG_CAP_HOPS) {
      sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId, cwd, message: `백그라운드 작업 ${n}개가 ${need.minutes}분 한도로 끊김: ${need.tasks.join(', ')} — 자동 이어가기 ${MAX_BG_CAP_HOPS}회를 다 써서 멈춥니다 (다음 메시지에 모델에게 알립니다)` });
      return;
    }
    sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId, cwd, message: `백그라운드 작업 ${n}개가 ${need.minutes}분 한도로 끊김: ${need.tasks.join(', ')} — 이어서 진행하도록 자동으로 보냅니다` });
    try {
      await this.run({ cwd, sessionId, turnId: `${p.turnId}:cap${hop}`, text: '이어서 진행해 주세요.', bgCapHop: hop, ...(p.commanderHop ? { commanderHop: p.commanderHop } : {}), ...(p.lang ? { lang: p.lang } : {}) }, sink);
    } catch (err) {
      console.error('deck: 한도 뒤 자동 이어가기 실패', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Review I7: the directory the jsonl really lives in. The CLI slugs its realpath'd cwd
   * (and NFC/NFD spellings of the same name differ), so a guess from our cwd string is only
   * a candidate: confirm the file is there, else look for it under the account's root.
   */
  private async locateProjectDir(sessionId: string, account: Account, candidate: string): Promise<string> {
    if (await exists(path.join(candidate, `${sessionId}.jsonl`))) return candidate;
    const root = this.rootOf(account);
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
    // Set once the fresh-import branch below has already run the agy-RUNNING check for this send (no second rescan before runGemini).
    let geminiHoldChecked = false;
    // Who holds a Grok session is decided on a scan made now, not on the poll's cached one (once per send).
    let holdersFresh = false;
    const freshHolders = async () => {
      if (holdersFresh) return;
      holdersFresh = true;
      const refreshed = deps.holders?.refresh?.({ force: true }).catch(() => false);
      if (!refreshed) return;
      await Promise.race([refreshed, new Promise((resolve) => setTimeout(resolve, FORCE_HOLDERS_SCAN_TIMEOUT_MS))]);
    };
    if (p.fork && !p.sessionId) {
      // 메시지 편집 갈래: a Claude session only (Codex / Gemini cannot resume at an entry).
      const st = deps.store.get(p.fork.from);
      const e = st ? null : deps.index.lookup(p.fork.from);
      const parent: SessionState | null = st ?? (e && !(e.account === 'gpt' || isGeminiAccount(e.account) || isGrokAccount(e.account)) ? { sessionId: e.sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL } : null);
      if (!parent || isOtherEngineState(parent)) { sink.emit({ type: 'error', turnId: p.turnId, message: `편집할 Claude 세션을 찾을 수 없습니다: ${p.fork.from}` }); return; }
      return this.runClaude(p, parent, sink, '메시지 편집', attachments);
    }
    if (p.sessionId) {
      state = deps.store.get(p.sessionId);
      // A deck Codex thread Codex has since archived (its rollout moved to archived_sessions): view only, like an archived import.
      if (state && isCodexState(state) && (await deps.index.freshCodexImport(p.sessionId))?.codexArchived) { sink.emit({ type: 'error', turnId: p.turnId, message: CODEX_ARCHIVED_NOTICE }); return; }
      // Checked live: a thread archived / unarchived in Codex or a folder that came back since the last scan is rescanned first.
      // A Grok Bot conversation is never sent from deck (no app API): an explicit refusal, never a new session.
      if (!state && p.sessionId.startsWith(GROKBOT_ID_PREFIX)) { sink.emit({ type: 'error', turnId: p.turnId, message: GROKBOT_SEND_REFUSED }); return; }
      const imported = state ? null : await deps.index.freshImport(p.sessionId);
      if (imported && imported.source === 'grokbot') { sink.emit({ type: 'error', turnId: p.turnId, message: GROKBOT_SEND_REFUSED }); return; }
      if (imported && imported.engine === 'grok') {
        // A Grok CLI session (design §3.1): held by a terminal grok (by id) or folder gone → refused; else resumed with session/load.
        await freshHolders();
        const blocked = await grokImportBlockReason(imported, deps.holders);
        if (blocked) { sink.emit({ type: 'error', turnId: p.turnId, message: blocked }); return; }
        const effort: Effort = p.effort ?? imported.grokEffort ?? DEFAULT_EFFORT.grok;
        state = {
          engine: 'grok', account: 'x1', sessionId: imported.sessionId, grokSessionId: imported.sessionId,
          cwd: imported.cwd, canonicalCwd: await fs.realpath(imported.cwd).catch(() => path.resolve(imported.cwd)),
          model: isGrokModel(p.model) ? p.model : isGrokModel(imported.grokModel) ? imported.grokModel : DEFAULT_GROK_MODEL,
          effort, permissionMode: p.permissionMode ?? (this.defaultMode() === 'plan' ? 'default' : this.defaultMode()),
          lastTurnAtMs: null, justCompacted: false, createdAtMs: this.now(), title: imported.title,
        };
        const age = await deps.index.importActiveAgeMs(imported.sessionId, this.now());
        if (age !== null || (await deps.holders?.grokCwdHeld?.(imported.cwd))) notice = elsewhereNotice({ engine: 'grok', title: imported.title === '(제목 없음)' ? null : imported.title, ageMs: age ?? 0 });
      } else if (imported && imported.engine === 'gemini') {
        // An agy conversation: resumed with --conversation <id> (its past messages are not replayed in deck). One agy is
        // running right now (RUNNING, written within LIVE_ROLLOUT_MS): refused like a held Grok session.
        geminiHoldChecked = true;
        const blocked = (await deps.index.importHeldReason(imported.sessionId, this.now())) ?? (await importBlockReason(imported));
        if (blocked) { sink.emit({ type: 'error', turnId: p.turnId, message: blocked }); return; }
        state = {
          engine: 'gemini', account: isGeminiAccount(imported.account) ? imported.account : 'g1', sessionId: imported.sessionId, cwd: imported.cwd,
          defaultModel: isGeminiModel(p.model) ? p.model : DEFAULT_GEMINI_MODEL, sandbox: p.sandbox ?? defaultGeminiSandbox(this.defaultMode() === 'bypassPermissions'),
          lastTurnAtMs: null, justCompacted: false, createdAtMs: this.now(), title: imported.title,
        };
        const age = await deps.index.importActiveAgeMs(imported.sessionId, this.now());
        if (age !== null) notice = elsewhereNotice({ engine: 'gemini', title: imported.title === '(제목 없음)' ? null : imported.title, ageMs: age });
      } else if (imported) {
        // Folder gone (codex cannot spawn there) or archived in Codex (resume by id is not assured): view only.
        const blocked = await importBlockReason(imported);
        if (blocked) { sink.emit({ type: 'error', turnId: p.turnId, message: blocked }); return; }
        // A Codex Desktop / CLI thread: resumed in its own cwd under deck's sandbox; stored as a deck Codex session after this turn.
        state = {
          engine: 'codex', sessionId: imported.sessionId, cwd: imported.cwd, lastTurnAtMs: null, justCompacted: false,
          defaultModel: isCodexModel(p.model) ? p.model : DEFAULT_CODEX_MODEL, sandbox: this.importSandboxes.get(imported.sessionId) ?? p.sandbox ?? DEFAULT_SANDBOX,
          rolloutFile: imported.file, createdAtMs: this.now(), title: imported.title,
        };
        const age = await rolloutActiveAgeMs(imported.file, this.now());
        if (age !== null) notice = liveRolloutNotice(imported.title, age);
      } else if (!state) {
        const e = deps.index.lookup(p.sessionId);
        // Codex sessions always have a state entry (D4); a 'gpt' index entry without one is a bug, not a resumable session.
        if (!e || e.account === 'gpt' || isGeminiAccount(e.account) || isGrokAccount(e.account)) { sink.emit({ type: 'error', turnId: p.turnId, message: `세션을 찾을 수 없습니다: ${p.sessionId}` }); return; }
        state = { sessionId: e.sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL };
      }
    }
    // 총사령탑: the gate lives in the Claude engine's hooks only — an automatic turn never reaches another engine.
    if (p.commanderHop !== undefined && state && (isOtherEngineState(state))) { sink.emit({ type: 'error', turnId: p.turnId, message: COMMANDER_ENGINE_REFUSED }); return; }
    if (state && isCodexState(state)) return this.runCodex(p, state, sink, 'GPT 세션', attachments, notice);
    // A terminal grok resumed this very session (its id in the arguments): both writing would fork it (imports design §4.1).
    if (state && isGrokState(state)) await freshHolders();
    if (state && isGrokState(state) && deps.holders?.grokHeldBy?.(state.sessionId)) { sink.emit({ type: 'error', turnId: p.turnId, message: GROK_HELD_NOTICE }); return; }
    // A deck-owned Gemini session agy also runs (RUNNING, written within LIVE_ROLLOUT_MS) right now: refused like a held
    // Grok session, same as a fresh import's first send above (not re-checked when that branch already did, just above).
    if (state && isGeminiState(state) && !geminiHoldChecked) {
      const blocked = await deps.index.importHeldReason(state.sessionId, this.now());
      if (blocked) { sink.emit({ type: 'error', turnId: p.turnId, message: blocked }); return; }
    }
    // §10-4: a Gemini / Grok session checks every turn whether its engine can do it (Claude / GPT can do anything).
    if (state && (isGeminiState(state) || isGrokState(state)) && !p.ignoreFit) {
      const engine = isGeminiState(state) ? 'gemini' : 'grok';
      const fit = turnFits(engine, classifyTask(p.text, { images: attachments.filter((a) => a.isImage).length }), { cwdInsideHome: await insideHome(state.cwd) });
      if (!fit.ok) { sink.emit({ type: 'route_fit', turnId: p.turnId, sessionId: state.sessionId, engine, need: fit.need }); return; }
    }
    if (state && isGeminiState(state)) return this.runGemini(p, state, sink, `Gemini 세션 · ${GEMINI_LABEL[state.account]}`, attachments, notice);
    if (state && isGrokState(state)) return this.runGrok(p, state, sink, `Grok 세션 · ${GROK_LABEL[state.account]}`, attachments, notice);
    // 자동 분배 (chooseRoute): engine 자동, or an engine other than Claude with model 자동. Claude / no engine keeps chooseEngine below.
    // review #3: a pinned account forces Claude — engine 자동 never crosses vendors when an account is pinned.
    if (!state && !p.accountPin && (p.engine === 'auto' || (p.model === 'auto' && (p.engine === 'codex' || p.engine === 'gemini' || p.engine === 'grok')))) {
      return this.runRouted(p, sink, attachments);
    }
    // An explicit Gemini / Grok model: that engine as is.
    if (!state && p.engine === 'gemini') return this.runGemini(p, null, sink, 'Gemini 지정', attachments);
    if (!state && p.engine === 'grok') return this.runGrok(p, null, sink, 'Grok 지정', attachments);
    if (!state) {
      // 같은 벤더 계정 자동 순환 off: the new session can only run on one Claude account, so GPT (벤더 간 인계) and 자동
      // 모델 weigh that account alone.
      const claudeAccounts = this.rotation() ? this.accounts : onlyAccount(this.accounts, fixedAccount({ pinned: p.accountPin ?? null, current: null, accounts: this.accounts }));
      const pick = chooseEngine({
        // review #3: a pinned account forces Claude — chooseEngine's own 자동 (Claude ↔ GPT) decision never fires for it.
        choice: p.accountPin ? 'claude' : (p.engine ?? 'claude'), usage: deps.usage.routingSnapshot(), nowMs: this.now(), codexAvailable: deps.codex !== null,
        gptCooldownUntilMs: this.gptCooldownUntil, cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now(), this.accounts.list()), protectedAccount: deps.protectedAccount, accounts: claudeAccounts,
      });
      if (pick.engine === 'codex') return this.runCodex(p, null, sink, pick.reason, attachments);
      // Only a non-default choice earns a prefix, so Plan 1 badges read exactly as before.
      const enginePrefix = p.engine && p.engine !== 'claude' ? pick.reason : null;
      if (p.model === 'auto') {
        // 자동: decided once, here, for the new session; later turns keep it as the session default (prompt cache).
        const auto = chooseAutoModel({ text: p.text, attachmentCount: attachments.length, usage: deps.usage.routingSnapshot(), nowMs: this.now(), cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now(), this.accounts.list()), protectedAccount: deps.protectedAccount, accounts: claudeAccounts });
        return this.runClaude({ ...p, model: auto.model, effort: p.effort ?? auto.effort }, null, sink, enginePrefix ? `${enginePrefix} · ${auto.reason}` : auto.reason, attachments, auto.model);
      }
      return this.runClaude(p, null, sink, enginePrefix, attachments);
    }
    return this.runClaude(p, state, sink, null, attachments);
  }

  /**
   * 자동 분배 (auto-route design §10): a new session's engine, model and effort from chooseRoute. A turn the picked engine
   * cannot do answers `route_fit` (unless ignoreFit); no engine at all answers an error. The reason rides the badge; the
   * full `why` goes to the server log only.
   */
  private async runRouted(p: TurnParams, sink: TurnSink, attachments: Attachment[]): Promise<void> {
    const { deps } = this;
    const nowMs = this.now();
    const claudeAccounts = this.rotation() ? this.accounts : onlyAccount(this.accounts, fixedAccount({ pinned: p.accountPin ?? null, current: null, accounts: this.accounts }));
    const gem = deps.gemini ?? null;
    const limits = buildEngineLimits({
      usage: deps.usage.routingSnapshot(), nowMs,
      claude: { cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, nowMs, this.accounts.list()), protectedAccount: deps.protectedAccount, accounts: claudeAccounts },
      codex: { installed: deps.codex !== null, cooldownUntilMs: this.gptCooldownUntil },
      gemini: { installed: gem !== null, loggedIn: { g1: gem?.loggedIn('g1') ?? false, g2: gem?.loggedIn('g2') ?? false }, cooldownUntilMs: this.geminiCooldownUntil },
      grok: { installed: !!deps.grok, cooldownUntilMs: this.grokCooldownUntil.x1 ?? null, lastError: this.grokLastError },
    });
    const settings = deps.autoRoute?.() ?? DEFAULT_AUTO_ROUTE;
    const d: RouteDecision = chooseRoute({
      text: p.text, images: attachments.filter((a) => a.isImage).length, engine: p.engine ?? 'auto', model: p.model ?? 'auto',
      ...(p.effort ? { effort: p.effort } : {}), limits, nowMs, cwdInsideHome: await insideHome(p.cwd),
      autoEngines: settings.autoEngines, consented: settings.autoConsent, grokFast: settings.grokFast, commander: p.commanderHop !== undefined,
    });
    if (d.kind === 'no_route') {
      deps.routeLog?.(`deck route ${p.turnId}: no route — ${Object.entries(d.reasons).map(([e, r]) => `${e}: ${r}`).join(' | ')}`);
      const parts = (Object.keys(ROUTE_ENGINE_LABEL) as EngineKind[]).map((e) => `${ROUTE_ENGINE_LABEL[e]}: ${d.reasons[e]}`);
      sink.emit({ type: 'error', turnId: p.turnId, message: `자동 분배: 쓸 수 있는 엔진 없음 — ${parts.join(', ')}` });
      return;
    }
    deps.routeLog?.(`deck route ${p.turnId}: ${d.why.join(' | ')}`);
    if (d.fit && !d.fit.ok && !p.ignoreFit) { sink.emit({ type: 'route_fit', turnId: p.turnId, sessionId: null, engine: d.engine, need: d.fit.need }); return; }
    // A model chosen here: the user's 자동 effort (if any) wins, clamped; else the route's. A picked model keeps the picked effort.
    const effort = p.model === 'auto' || p.model === undefined ? (p.effort ? clampEffort(d.model, p.effort) : d.effort) : d.effort;
    const routed: TurnParams = { ...p, model: d.model, effort };
    // GPT picked (engine GPT + model 자동, or a GPT model) but no codex CLI: Claude, as before 자동 분배, saying why.
    if (d.engine === 'codex' && !deps.codex) {
      const auto = chooseAutoModel({ text: p.text, attachmentCount: attachments.length, usage: deps.usage.routingSnapshot(), nowMs, cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, nowMs, this.accounts.list()), protectedAccount: deps.protectedAccount, accounts: claudeAccounts });
      return this.runClaude({ ...p, model: auto.model, effort: p.effort ?? auto.effort }, null, sink, `codex CLI 없음 → Claude · ${auto.reason}`, attachments, auto.model);
    }
    switch (d.engine) {
      case 'codex': return this.runCodex(routed, null, sink, d.reason, attachments);
      case 'gemini': return this.runGemini(routed, null, sink, d.reason, attachments);
      case 'grok': return this.runGrok(routed, null, sink, d.reason, attachments);
      case 'claude': return this.runClaude(routed, null, sink, d.reason, attachments, isClaudeModel(d.model) ? d.model : undefined);
    }
  }

  /** D2/D3: one ChatGPT account — no routing, no session move, no retry; sandbox + approval never. */
  private async runCodex(p: TurnParams, state: CodexSessionState | null, sink: TurnSink, reason: string, attachments: Attachment[], notice: string | null = null): Promise<void> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    // A per-turn Codex model wins on resume too (like Claude's per-turn model); the session's stored default is kept.
    const model: CodexModel = isCodexModel(p.model) ? p.model : (state?.defaultModel ?? DEFAULT_CODEX_MODEL);
    const sandbox: CodexSandbox = state?.sandbox ?? p.sandbox ?? DEFAULT_SANDBOX;
    // Task 2 follow-up: the id is either the stored one (itself CLI-reported) or what the CLI reports via init
    // (thread.started) — never the result's sessionId, which echoes a rejected resume id.
    let sessionId: string | null = state?.sessionId ?? null;
    const scope = () => ({ turnId: p.turnId, sessionId, cwd });
    const badge = (usage: TurnUsage) => ({ account: 'gpt' as const, model, reason, usage, modelNote: null });
    if (!deps.codex) { sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: badge(ZERO_USAGE), errorText: 'codex CLI 를 찾을 수 없습니다' }); return; }
    if (sink.signal.aborted) { sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: badge(ZERO_USAGE), errorText: abortedText(sink.signal) }); return; }
    sink.emit({ type: 'turn_started', ...scope(), account: 'gpt', model, reason, attempt: 0, engine: 'codex' });
    if (notice) sink.emit({ type: 'turn_notice', ...scope(), message: notice });
    let result: EngineResult | null = null;
    const effort = effortFor(model, p.effort);
    const createdAtMs = state?.createdAtMs ?? this.now();
    const developerInstructions = this.addendum(p, 'codex');
    for await (const ev of deps.codex.runTurn({ cwd, resumeThreadId: state?.sessionId ?? null, model, sandbox, ...(effort ? { effort } : {}), ...(developerInstructions ? { developerInstructions } : {}), prompt: promptWithFiles(p.text, attachments), imagePaths: attachments.filter((a) => a.isImage).map((a) => a.path), signal: sink.signal })) {
      switch (ev.kind) {
        case 'init':
          sessionId = ev.sessionId;
          // A new thread is recorded as soon as the CLI names it: its rollout is a `codex exec` one, and the
          // import list (자동 실행) must not show deck's own thread while this first turn is still running.
          if (!state && !deps.store.get(sessionId)) {
            await deps.store.set({
              engine: 'codex', sessionId, cwd, lastTurnAtMs: null, justCompacted: false, defaultModel: model, sandbox,
              rolloutFile: null, createdAtMs, title: titleOf(p.text),
            }).catch((err: unknown) => console.error('deck: recording the new Codex thread failed', err instanceof Error ? err.message : err));
          }
          if (!state) sink.sessionKnown?.(sessionId);
          break;
        case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
        case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
        case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
        case 'result': result = ev; break;
        case 'rate_limit': case 'compact': case 'task_done': case 'background': case 'continue': case 'progress': case 'sub_tool_call': case 'sub_tool_result': case 'task_update': case 'system': break;
      }
    }
    const res: EngineResult = result ?? { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
    if (sessionId) {
      const rolloutFile = state?.rolloutFile ?? (await this.findRollout(deps.codexSessionsRoot, sessionId).catch(() => null));
      // A sandbox set while this turn ran (setSandbox) is kept for the next one.
      const cur = deps.store.get(sessionId);
      const picked = this.importSandboxes.get(sessionId);
      this.importSandboxes.delete(sessionId);
      const next: CodexSessionState = {
        engine: 'codex', sessionId, cwd, lastTurnAtMs: res.ok ? this.now() : (state?.lastTurnAtMs ?? null), justCompacted: false,
        defaultModel: state?.defaultModel ?? model, sandbox: picked ?? (cur && isCodexState(cur) ? cur.sandbox : sandbox), rolloutFile, createdAtMs, title: state?.title ?? titleOf(p.text),
      };
      await deps.store.set(next);
      // D5: the rollout's token_count.rate_limits is the only per-turn GPT usage signal.
      if (rolloutFile) {
        const w = await this.readRateLimits(rolloutFile).catch(() => null);
        if (w) deps.usage.applyTurn('gpt', w);
      }
    }
    if (!res.ok && classifyFailure({ ok: false, errorText: res.errorText, errorKind: res.errorKind, rateLimitStatus: null }) === 'limit') this.gptCooldownUntil = this.now() + COOLDOWN_MS.limit;
    sink.emit({ type: 'turn_result', ...scope(), ok: res.ok, text: res.text, badge: badge(res.usage), errorText: res.ok ? null : sink.signal.aborted ? abortedText(sink.signal) : displayError(res.errorText, res.stderr), ...(!res.ok && !sink.signal.aborted && res.errorKind === 'thread_locked' ? { errorCode: 'thread_locked' as const } : {}) });
  }

  /** Explicit Gemini: a new session takes the first logged-in, non-cooled account (g1, then g2) and stays on it. */
  private async runGemini(p: TurnParams, state: GeminiSessionState | null, sink: TurnSink, reason: string, attachments: Attachment[], notice: string | null = null): Promise<void> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    const model: GeminiModel = isGeminiModel(p.model) ? p.model : (state?.defaultModel ?? DEFAULT_GEMINI_MODEL);
    const sandbox: CodexSandbox = state?.sandbox ?? p.sandbox ?? defaultGeminiSandbox(this.defaultMode() === 'bypassPermissions');
    let sessionId: string | null = state?.sessionId ?? null;
    const scope = () => ({ turnId: p.turnId, sessionId, cwd });
    const fail = (account: GeminiAccount, errorText: string) =>
      sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: { account, model, reason, usage: ZERO_USAGE, modelNote: null }, errorText });
    const gem = deps.gemini;
    if (!gem) { fail(state?.account ?? 'g1', 'gemini CLI 를 찾을 수 없습니다'); return; }
    let account: GeminiAccount;
    if (state) {
      account = state.account;
      if (!gem.loggedIn(account)) { fail(account, `Gemini ${GEMINI_LABEL[account]} 로그인 필요`); return; }
    } else {
      const loggedIn = GEMINI_ACCOUNTS.filter((a) => gem.loggedIn(a));
      if (!loggedIn.length) { fail('g1', 'Gemini 로그인 필요 (docs/gemini-spike.md)'); return; }
      const free = loggedIn.find((a) => (this.geminiCooldownUntil[a] ?? 0) <= this.now());
      account = free ?? loggedIn[0]!;
      reason = `${reason} · ${GEMINI_LABEL[account]}${free ? '' : ' (모두 쿨다운)'}`;
    }
    const badge = (usage: TurnUsage) => ({ account, model, reason, usage, modelNote: null });
    if (sink.signal.aborted) { fail(account, abortedText(sink.signal)); return; }
    sink.emit({ type: 'turn_started', ...scope(), account, model, reason, attempt: 0, engine: 'gemini' });
    if (notice) sink.emit({ type: 'turn_notice', ...scope(), message: notice });
    let result: EngineResult | null = null;
    // A picked effort Gemini does not have (xhigh) becomes the closest lower one (high).
    const effort = p.effort ? clampEffort(model, p.effort) : DEFAULT_EFFORT.gemini;
    const context = this.contextFor(state?.sessionId ?? null, this.addendum(p, 'gemini'));
    const prompt = promptWithFiles(p.text, attachments);
    for await (const ev of gem.engine.runTurn({ account, cwd, resumeSessionId: state?.sessionId ?? null, model, effort, sandbox, prompt: context ? `${systemReminder(context)}\n\n${prompt}` : prompt, signal: sink.signal })) {
      switch (ev.kind) {
        case 'init': if (ev.sessionId !== sessionId) sink.sessionKnown?.(ev.sessionId); sessionId = ev.sessionId; break;
        case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
        case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
        case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
        case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
        case 'result': result = ev; break;
        case 'rate_limit': case 'compact': break;
      }
    }
    const res: EngineResult = result ?? { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
    // Delivered only once a turn carrying it succeeded: a failed first turn sends it again next time.
    if (res.ok) this.contextDelivered(sessionId, context);
    // Only an id the CLI reported (init) is stored, never a rejected resume id echoed back.
    if (sessionId) {
      await deps.store.set({
        engine: 'gemini', account, sessionId, cwd, lastTurnAtMs: res.ok ? this.now() : (state?.lastTurnAtMs ?? null), justCompacted: false,
        defaultModel: state?.defaultModel ?? model, sandbox, createdAtMs: state?.createdAtMs ?? this.now(), title: state?.title ?? titleOf(p.text),
      });
    }
    if (!res.ok && GEMINI_LIMIT_RE.test(res.errorText ?? '')) this.geminiCooldownUntil[account] = this.now() + COOLDOWN_MS.limit;
    sink.emit({ type: 'turn_result', ...scope(), ok: res.ok, text: res.text, badge: badge(res.usage), errorText: res.ok ? null : sink.signal.aborted ? abortedText(sink.signal) : displayError(res.errorText, res.stderr) });
    deps.geminiUsage?.bump();
  }

  /**
   * Explicit Grok (design §4–§8): one seat (x1), no routing, no retry. Approval cards, 자동 승인, steer and the audit log
   * go through the same paths as a Claude turn; the engine classifies its own errors (errorKind) and refuses images.
   */
  private async runGrok(p: TurnParams, state: GrokSessionState | null, sink: TurnSink, reason: string, attachments: Attachment[], notice: string | null = null): Promise<void> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    const account: GrokAccount = state?.account ?? 'x1';
    // A stored model id that is no longer listed (the model list changed) falls back to the default; its effort is clamped.
    const model: GrokModel = isGrokModel(p.model) ? p.model : state && isGrokModel(state.model) ? state.model : DEFAULT_GROK_MODEL;
    const effort: Effort = effortFor(model, p.effort) ?? (state && effortFor(model, state.effort)) ?? effortFor(model, DEFAULT_EFFORT.grok) ?? MODEL_EFFORTS[model].at(-1)!;
    // A server-wide default of plan does not apply to Grok (no plan mode yet, §14.2); an explicit plan is refused by the engine.
    const fallbackMode = this.defaultMode();
    const modeRef: ModeRef = { mode: state?.permissionMode ?? p.permissionMode ?? (fallbackMode === 'plan' ? 'default' : fallbackMode) };
    let sessionId: string | null = state?.sessionId ?? null;
    const scope = () => ({ turnId: p.turnId, sessionId, cwd });
    if ((this.grokCooldownUntil[account] ?? 0) > this.now()) reason = `${reason} (한도 쿨다운 중)`;
    const badge = (usage: TurnUsage) => ({ account, model, reason, usage, modelNote: null });
    const fail = (errorText: string) => sink.emit({ type: 'turn_result', ...scope(), ok: false, text: '', badge: badge(ZERO_USAGE), errorText });
    if (!deps.grok) { fail('grok CLI 를 찾을 수 없습니다'); return; }
    if (sink.signal.aborted) { fail(abortedText(sink.signal)); return; }
    const createdAtMs = state?.createdAtMs ?? this.now();
    const canonicalCwd = state?.canonicalCwd ?? (await fs.realpath(cwd).catch(() => path.resolve(cwd)));
    const record = (id: string, ok: boolean | null) => {
      const cur = deps.store.get(id);
      const next: GrokSessionState = {
        engine: 'grok', account, sessionId: id, grokSessionId: id, cwd, canonicalCwd,
        lastTurnAtMs: ok ? this.now() : (state?.lastTurnAtMs ?? null), justCompacted: false,
        // The picker values of this turn become the session's defaults; a mode changed mid-turn (setPermissionMode) is kept.
        model, effort, permissionMode: cur && isGrokState(cur) ? cur.permissionMode : modeRef.mode,
        createdAtMs, title: state?.title ?? titleOf(p.text),
      };
      return deps.store.set(next);
    };
    sink.emit({ type: 'turn_started', ...scope(), account, model, reason, attempt: 0, engine: 'grok' });
    if (notice) sink.emit({ type: 'turn_notice', ...scope(), message: notice });
    const audit = (toolName: string, input: unknown, decision: ToolAuditEntry['decision'], source: ToolAuditEntry['source']) =>
      appendAudit(deps.auditFile, { ts: new Date(this.now()).toISOString(), turnId: p.turnId, sessionId, toolName, decision, source, inputSha256: hashInput(input) })
        .catch((err: unknown) => console.error('deck: audit log write failed', err instanceof Error ? err.message : err));
    this.steering.set(p.turnId, { pending: new Map(), ids: new Set() });
    this.modes.set(p.turnId, { ref: modeRef, sessionId: () => sessionId, notice: (message) => sink.emit({ type: 'turn_notice', ...scope(), message }) });
    let result: EngineResult | null = null;
    const context = this.contextFor(state?.sessionId ?? null, this.addendum(p, 'grok'));
    try {
      const events = deps.grok.run({
        account, cwd: canonicalCwd, resumeSessionId: state?.sessionId ?? null, model: GROK_CLI_ALIAS[model], effort,
        // Grok's session mode is always default; deck answers the requests per the live mode (§14.1-3). Plan is refused.
        permissionMode: modeRef.mode === 'plan' ? 'plan' : 'default',
        prompt: p.text, ...(context ? { context } : {}), attachments, signal: sink.signal,
        autoApprove: () => modeRef.mode === 'bypassPermissions',
        editAuto: () => modeRef.mode === 'acceptEdits',
        onPermission: async (pr) => {
          const decision = await sink.askPermission({ turnId: p.turnId, sessionId, cwd, ...pr });
          await audit(pr.toolName, pr.input, decision, 'user');
          return decision;
        },
        onAutoApproved: async (pr) => { await audit(pr.toolName, pr.input, 'auto', 'auto'); },
        onToolAudit: async (t) => { await audit(t.toolName, t.input, t.decision, t.source); },
        onLive: (l) => { this.inputs.set(p.turnId, l); },
        // Recorded before the prompt goes out, so a crash mid-turn can still be resumed.
        onSessionId: async (id) => {
          if (id !== sessionId) sink.sessionKnown?.(id);
          sessionId = id;
          if (!state) await record(id, null).catch((err: unknown) => console.error('deck: recording the new Grok session failed', err instanceof Error ? err.message : err));
        },
      });
      for await (const ev of events) {
        switch (ev.kind) {
          case 'init': if (ev.sessionId !== sessionId) sink.sessionKnown?.(ev.sessionId); sessionId = ev.sessionId; break;
          case 'delta': sink.emit({ type: 'delta', ...scope(), text: ev.text }); break;
          case 'thinking': if (ev.text) sink.emit({ type: 'thinking', ...scope(), text: redactSecrets(ev.text) }); break;
          case 'tool_call': sink.emit({ type: 'tool_call', ...scope(), toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
          case 'tool_result': sink.emit({ type: 'tool_result', ...scope(), toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }); break;
          case 'notice': sink.emit({ type: 'turn_notice', ...scope(), message: redactSecrets(ev.message) }); break;
          case 'steer_delivered': this.steerDelivered(p.turnId, ev.id, sink, scope()); break;
          case 'result': result = ev; break;
          // rate_limit: carries no window for Grok (quota is not readable) — the result's errorKind sets the cooldown below.
          default: break;
        }
      }
    } finally {
      this.inputs.delete(p.turnId);
      this.modes.delete(p.turnId);
      this.rejectSteers(p.turnId, sink, scope(), '세션 프로세스가 끝나 턴이 끝난 뒤 보냅니다');
      this.steering.delete(p.turnId);
    }
    const res: EngineResult = result ?? { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
    // Delivered only once a turn carrying it succeeded: a failed first turn sends it again next time.
    if (res.ok) this.contextDelivered(sessionId, context);
    // Only an id Grok reported is stored, never a rejected resume id echoed back.
    if (sessionId) await record(sessionId, res.ok).catch((err: unknown) => console.error('deck: saving the Grok session failed', err instanceof Error ? err.message : err));
    if (!res.ok && res.errorKind === 'rate_limit') this.grokCooldownUntil[account] = this.now() + COOLDOWN_MS.limit;
    if (res.ok) this.grokLastError = null;
    else if (!sink.signal.aborted) this.grokLastError = res.errorKind === 'authentication_failed' ? 'auth' : 'other';
    // The map itself is kept on success (same as the Codex/Gemini cooldowns, which only expire); the card is told a
    // successful turn means no cooldown, so it does not keep showing "한도" after Grok answered.
    try {
      this.deps.grokUsage?.noteTurn(account, { ok: res.ok, errorKind: res.errorKind, usage: res.usage, cooldownUntilMs: res.ok ? null : (this.grokCooldownUntil[account] ?? null), ...(res.grokBilling ? { billing: res.grokBilling } : {}) });
    } catch (err) {
      console.error('deck: recording Grok usage failed', err instanceof Error ? err.message : err);
    }
    sink.emit({ type: 'turn_result', ...scope(), ok: res.ok, text: res.text, badge: badge(res.usage), errorText: res.ok ? null : sink.signal.aborted ? abortedText(sink.signal) : displayError(res.errorText, res.stderr) });
  }

  private async runClaude(p: TurnParams, state: ClaudeSessionState | null, sink: TurnSink, enginePrefix: string | null, attachments: Attachment[], newSessionModel?: ClaudeModel): Promise<void> {
    const id = state?.sessionId;
    if (id) this.active.set(id, (this.active.get(id) ?? 0) + 1);
    // Notices before the turn has started would have no turn item to attach to (the UI shows them as an error).
    const early: string[] = [];
    let end: ClaudeSessionState | null = null;
    try {
      // Read-only sessions: an account that is not configured any more, or one marked retired. A retired account's
      // sessions stay listed (and deletable); the projects dir of an account removed from the settings is not scanned
      // any more, so such a session stays listed only while another account has a copy of it.
      const readOnly = (account: Account): string | null => {
        if (!this.accounts.has(account) || !this.roots.has(account)) return `설정에 없는 계정(${this.label(account)})의 세션이라 이어갈 수 없습니다 — 이어 쓰려면 accounts.json 에 {"id": ${JSON.stringify(account)}, "configDir": "그 계정의 설정 폴더"} 를 추가하고 deck 을 다시 시작하세요. 필요 없는 세션이면 삭제해도 됩니다.`;
        if (this.accounts.isRetired(account)) return `${this.label(account)} 계정은 뺀 계정(retired)이라 이 세션을 이어갈 수 없습니다 — 기록은 그대로 볼 수 있습니다. 이어 쓰려면 accounts.json 에서 이 계정의 "retired" 를 지우고 deck 을 다시 시작하거나, 새 세션에서 이어가세요.`;
        return null;
      };
      let refused = state ? readOnly(state.account) : null;
      if (state && !refused) {
        // A write-back still copying this session finishes first (it must not see the next turn's writes).
        await this.mirrors.get(state.sessionId);
        state = await this.reconcile(state, (m) => early.push(m));
        // The copy check reads retired accounts' dirs too: the newest copy may have put the session on one.
        // Intended: `reconcile` has stored that move, so the session stays read-only from here on.
        refused = readOnly(state.account);
      }
      if (refused) {
        // What the copy check found (diverged copies, ...) goes out with the refusal instead of being dropped.
        for (const message of early.splice(0)) sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId: state?.sessionId ?? null, cwd: state?.cwd ?? p.cwd, message });
        sink.emit({ type: 'error', turnId: p.turnId, message: refused });
        return;
      }
      // A handoff-note turn denies every tool: no tool boundary to fold a steer in at, and it must stay a pure note.
      if (!p.handoff) this.steering.set(p.turnId, { pending: new Map(), ids: new Set() });
      try {
        end = await this.runClaudeTurn(p, state, sink, enginePrefix, attachments, early, newSessionModel);
      } finally {
        this.inputs.delete(p.turnId);
        this.modes.delete(p.turnId);
        this.bornPins.delete(p.turnId);
        this.rejectSteers(p.turnId, sink, { turnId: p.turnId, sessionId: end?.sessionId ?? state?.sessionId ?? null, cwd: end?.cwd ?? state?.cwd ?? p.cwd }, '세션 프로세스가 끝나 턴이 끝난 뒤 보냅니다');
        this.steering.delete(p.turnId);
      }
      // The final write-back at close (also after a long hold for background work).
      if (end) this.scheduleMirror(end.sessionId, sink, p.turnId);
    } finally {
      if (id) { const n = (this.active.get(id) ?? 1) - 1; if (n > 0) this.active.set(id, n); else this.active.delete(id); }
      // The CLI process has closed: whatever it wrote was deck's.
      if (end) this.deckWroteAt.set(path.resolve(end.projectDir, `${end.sessionId}.jsonl`), this.now());
    }
  }

  /**
   * The router's input for a Claude turn on `state` (null = a new session) wanting `wanted`, pinned to `askedPin`: reads
   * usage, settings and cooldown files only. The turn path and previewRoute both route from it.
   */
  /** 같은 벤더 계정 자동 순환 (read per turn); absent = on. */
  private rotation(): boolean {
    return this.deps.sameVendorRotation?.() ?? true;
  }

  private claudeRoute(state: ClaudeSessionState | null, wanted: ClaudeModel, askedPin: Account | null) {
    const { deps } = this;
    // A pin on an account that is not active (removed or retired since) is no pin.
    const pin = askedPin && this.accounts.list().includes(askedPin) ? askedPin : null;
    const routerBase = { usage: deps.usage.routingSnapshot(), nowMs: this.now(), protectedAccount: deps.protectedAccount, needFable: wanted === 'fable', pinned: pin, policy: deps.routingPolicy?.() ?? 'balance', accounts: this.accounts, sameVendorRotation: this.rotation() };
    const routeInput: RouterInput = {
      ...routerBase,
      current: state?.account ?? null,
      lastTurnAtMs: state?.lastTurnAtMs ?? null,
      justCompacted: state?.justCompacted ?? false,
      cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now(), this.accounts.list()),
    };
    return { pin, routerBase, routeInput };
  }

  /**
   * Where the next turn of Claude session `sessionId` (null = a new Claude session) would go if it were sent now with
   * `model` (absent = no model picked): the model is resolved as the turn resolves it (a picked Claude model, else the
   * session's stored default; a new session 자동 would need the prompt chooseAutoModel reads, so it has no preview), then
   * the same router input and decision as the turn's first routing, from the stored state (the copy check a real turn
   * runs first may still move it). null for GPT / Gemini sessions, unknown ids — a new session just before and after its
   * first turn has no stored state yet, so it is null too — and a session whose account is retired or no longer
   * configured. No side effects.
   */
  previewRoute(sessionId: string | null, model?: ClaudeModel | 'auto'): RoutePreview | null {
    const { deps } = this;
    let state: ClaudeSessionState | null = null;
    if (sessionId) {
      const st = deps.store.get(sessionId);
      if (st && (isOtherEngineState(st))) return null;
      if (st) state = st;
      else {
        const e = deps.index.lookup(sessionId);
        if (!e || e.account === 'gpt' || isGeminiAccount(e.account) || isGrokAccount(e.account)) return null;
        state = { sessionId: e.sessionId, cwd: e.cwd, account: e.account, projectDir: e.projectDir, lastTurnAtMs: null, justCompacted: false, defaultModel: IMPORTED_DEFAULT_MODEL };
      }
      if (!this.accounts.list().includes(state.account)) return null;
    } else if (model === 'auto') return null;
    // As runClaudeTurn: a picked Claude model, else the session's default, else (a new session) DEFAULT_MODEL.
    const wanted = (isClaudeModel(model) ? model : null) ?? state?.defaultModel ?? DEFAULT_MODEL;
    const { routeInput } = this.claudeRoute(state, wanted, state?.accountPin ?? null);
    const d = chooseAccount(routeInput);
    return { account: d.account, reason: d.reason, ...(d.asOpus ? { asOpus: true } : {}) };
  }

  /** The Claude turn proper; resolves (after any background follow-through) with the session's final state. */
  private async runClaudeTurn(p: TurnParams, state: ClaudeSessionState | null, sink: TurnSink, enginePrefix: string | null, attachments: Attachment[], early: string[], newSessionModel?: ClaudeModel): Promise<ClaudeSessionState | null> {
    const { deps } = this;
    const cwd = state?.cwd ?? p.cwd;
    // The model a turn is sent with becomes the session's default (the picker's choice sticks, on every device); a send
    // without one (자동, an older client) keeps the stored default; a new one takes 자동's pick, else DEFAULT_MODEL.
    const sessionDefault = (isClaudeModel(p.model) ? p.model : null) ?? state?.defaultModel ?? newSessionModel ?? DEFAULT_MODEL;
    // 자동 on a later turn: the session keeps its model, and its auto effort unless the user picked one.
    if (p.model === 'auto' && p.effort === undefined) p = { ...p, effort: AUTO_EFFORT[sessionDefault] };
    const wantedClaude = isClaudeModel(p.model) ? p.model : undefined;
    const wanted = wantedClaude ?? sessionDefault;
    // 메시지 편집 갈래: until the CLI reports the fork's id, `state` is the parent's and its id is not this turn's.
    let forkAt = p.fork && state?.sessionId === p.fork.from ? p.fork.at : null;
    // A fork takes the parent's pin (the pane sends the same one; it covers a pin set a moment before the edit).
    const askedPin = state ? (state.accountPin ?? (forkAt ? p.accountPin : null) ?? null) : (p.accountPin ?? null);
    const shownId = () => (forkAt ? null : (state?.sessionId ?? null));
    const done = () => (forkAt ? null : state);
    const { pin, routerBase, routeInput } = this.claudeRoute(state, wanted, askedPin);

    // An unpinned edit-fork runs on the parent's own account (it is not moved for a branch) unless that account is
    // unusable; a pinned one routes like any turn of the session, copying the parent to the pinned account.
    const forkFrom = forkAt && state && !pin ? state.account : null;
    let first = chooseAccount(forkFrom ? { ...routeInput, pinned: forkFrom, pinIsParent: true } : routeInput);
    // A fork whose pin is unusable stays on the parent's account like an unpinned one (a cold cache must not send it,
    // and a copy of the parent, to a third account); only if that one is unusable too is the parent copied elsewhere.
    let forkWhy: string | undefined;
    if (forkAt && state && pin && first.pinBlocked && pin !== state.account) {
      const stay = chooseAccount({ ...routeInput, pinned: state.account });
      if (stay.pinBlocked) forkWhy = `${this.label(pin)} 고정 계정과 ${this.label(state.account)} 계정을 지금 쓸 수 없어`;
      first = { ...stay, pinned: false, pinBlocked: first.pinBlocked, reason: `고정 ${this.label(pin)} ${first.pinBlocked} → 갈래는 ${stay.reason}` };
    }
    let account = first.account;
    // Set while the account is the router's choice for a Fable turn it routed as Opus (see RouterDecision.asOpus): its
    // reason says "→ Opus", so the turn runs on Opus whatever the usage snapshot says by the time the attempt starts.
    let asOpus = first.asOpus;
    let reason = enginePrefix ? `${enginePrefix} · ${first.reason}` : first.reason;
    const flushEarly = () => { for (const message of early.splice(0)) sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId: shownId(), cwd, message }); };
    // The badge's pin marker: the account is the pinned one because of the pin.
    let byPin = first.pinned === true && account === pin;
    if (state && account !== state.account) {
      if (byPin) forkWhy = `${this.label(account)} 계정 고정이라`;
      const moved = forkAt ? await this.copyForFork(state, account, (m) => early.push(m), forkWhy) : await this.relocate(state, account, (m) => early.push(m));
      if (moved) state = moved;
      else { account = state.account; reason = `이전 실패 · ${this.label(account)} 유지`; byPin = false; asOpus = undefined; }
    }
    // Non-blocking: the same session written moments ago by Desktop/CLI is about to be continued in two places.
    const elsewhereAge = state && !forkAt ? await this.openElsewhere(state) : null;
    if (state && elsewhereAge !== null) early.push(elsewhereNotice({ engine: 'claude', title: deps.index.lookup(state.sessionId)?.title ?? null, ageMs: elsewhereAge }));
    deps.routeLog?.(routeLogLine(state?.sessionId ?? null, { ...first, account, reason }, this.accounts));
    // The Fable-cap case adds how to stop seeing this every turn; a limit or cooldown passes by itself.
    if (pin && first.pinBlocked && account !== pin) early.push(`${this.label(pin)} 계정 ${first.pinBlocked} — 이번 턴은 ${this.label(account)} 로 (고정은 유지${first.pinBlocked.startsWith('Fable') ? ' · 계정 칩에서 풀면 매 턴 자동으로 고릅니다' : ''})`);
    // The pin held although the router would not have picked it (Fable at the cap, no room elsewhere): say so every turn.
    // (The model then follows the account's own Fable value, as always: at the cap → Opus, said by the badge's modelNote.)
    if (pin && first.pinWarn && account === pin) early.push(`${this.label(pin)} 계정 고정 · ${first.pinWarn} ${this.label(pin)} 로`);
    // Background work the last restart cut (followThrough): said in the pane and told to the model (UserPromptSubmit
    // additionalContext), forgotten only once a turn got through (res.ok below) — a turn that fails before the model saw
    // the note leaves it for the next one. A handoff-note turn (no tools) leaves it alone. Not a fork's (the parent's).
    const carried = state && !forkAt ? state.interrupted : undefined;
    const cut = p.handoff ? undefined : carried;
    let systemNote: string | undefined;
    if (cut) {
      const d = new Date(cut.atMs);
      const hm = d.toTimeString().slice(0, 5);
      const at = d.toDateString() === new Date(this.now()).toDateString() ? hm : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
      const n = cut.tasks.length;
      const list = cut.tasks.map((t) => `"${t}"`).join(', ');
      if (cut.kind === 'cap') {
        // The background wait limit cut the work (continueAfterCap): this turn is deck's own continuation, or — the auto
        // hops used up — the user's next message, which then carries the note.
        const auto = !!p.bgCapHop;
        early.push(`${at} ${cut.cause}로 백그라운드 작업 ${n}개가 끊겼습니다: ${cut.tasks.join(', ')} — ${auto ? 'deck 이 자동으로 이어갑니다' : '모델에게 알렸습니다'}`);
        systemNote = `[deck] 이 세션의 이전 프로세스는 ${at} 에 ${cut.cause}로 종료되었고, 그때 돌고 있던 백그라운드 작업 ${n}개는 끊겨 결과가 오지 않습니다: ${list}. ${auto ? '이 턴은 deck 이 자동으로 이어 보낸 것입니다(사용자가 보낸 메시지가 아닙니다). ' : ''}끊긴 작업이 파일 등에 남긴 부분 결과가 있으면 확인하고, 필요한 작업은 더 작은 단위로 다시 띄우거나 직접 마무리해 보고까지 끝내세요. 끊겼던 사실을 사용자에게 한 줄로 알리세요.`;
      } else if (!cut.cause) {
        early.push(`${at} 서버 재시작으로 백그라운드 작업 ${n}개가 끊겼습니다: ${cut.tasks.join(', ')} — 모델에게 알렸습니다`);
        systemNote = `[deck] 이 세션의 이전 프로세스는 ${at} 에 deck 서버 재시작으로 종료되었고, 그때 돌고 있던 백그라운드 작업 ${n}개는 끊겨 결과가 오지 않습니다: ${list}. 필요한 작업은 다시 띄우고, 끊겼던 사실을 사용자에게 한 줄로 알리세요. 이미 다시 띄웠거나 더 필요 없으면 무시하세요.`;
      } else if (n) {
        // A limit / auth failure of the held-open process (failoverAfterBackground): this turn runs on another account.
        early.push(`${at} ${cut.cause}로 백그라운드 작업 ${n}개가 끊겼습니다: ${cut.tasks.join(', ')} — 다른 계정에서 이어갑니다 (모델에게 알렸습니다)`);
        systemNote = `[deck] 이 세션의 이전 프로세스는 ${at} 에 ${cut.cause}로 종료되었고, 그때 돌고 있던 백그라운드 작업 ${n}개는 끊겨 결과가 오지 않습니다: ${list}. 이 턴은 다른 계정에서 이어 갑니다. 필요한 작업은 다시 띄우고, 끊겼던 사실을 사용자에게 한 줄로 알리세요. 이미 다시 띄웠거나 더 필요 없으면 무시하세요.`;
      } else {
        early.push(`${at} ${cut.cause}로 이전 프로세스가 끝났습니다 — 다른 계정에서 이어갑니다 (모델에게 알렸습니다)`);
        systemNote = `[deck] 이 세션의 이전 프로세스는 ${at} 에 ${cut.cause}로 응답 도중 종료되었습니다. 이 턴은 다른 계정에서 이어 갑니다. 마지막으로 하던 작업이 어디까지 됐는지 확인하고 이어서 진행하되, 끊겼던 사실을 사용자에게 한 줄로 알리세요.`;
      }
    }
    if (!state?.sessionId && !forkAt && !p.handoff) systemNote = systemNote ? `${systemNote}\n\n${DECK_INTRO_NOTE}` : DECK_INTRO_NOTE;
    if (p.commanderNote) systemNote = systemNote ? `${systemNote}\n\n${p.commanderNote}` : p.commanderNote;
    if (p.retryHop) early.unshift(AUTO_RETRY_NOTICE);
    const pinMark = () => (byPin ? { pinned: true } : {});

    // 사람이 보낸 턴(자동 턴·deck 이 스스로 보낸 이어가기·재시도·failover 가 아님)이 시작되면 자동 턴의 편집 표시를 지운다 —
    // 이 세션과, 같은 폴더(realpath)를 쓰는 다른 세션의 것까지(표시가 폴더 단위로 러너·git 을 막으므로 사람이 그 폴더로 돌아오면 함께 푼다).
    if (!forkAt && p.commanderHop === undefined && !p.retryHop && !p.bgCapHop && !p.failoverHop) {
      const edited = new Set(await this.editedInFolder(cwd));
      if (state?.commanderEdited) edited.add(state.sessionId);
      for (const id of edited) await deps.store.setCommanderEdited(id, false);
      if (state?.commanderEdited) {
        const { commanderEdited: _cleared, ...rest } = state;
        state = rest;
      }
    }
    const tried: Account[] = [];
    const grants: SessionGrants = { rules: [...(state?.allowRules ?? [])], dirs: [...(state?.allowDirs ?? [])] };
    // Handoff turns keep the mode as is: noTools denies every call before any mode is consulted.
    const modeRef: ModeRef = { mode: (state ? state.mode : p.permissionMode) ?? this.defaultMode() };
    // A new or forked session's mode is re-sent with its turn_result: the owning pane adopts the id at init (activity)
    // or at turn_result, and a mode broadcast before that found no pane to apply to. A mode set once the id was known
    // (setPermissionMode finds the running turn) is in modeRef and is stored with the session when the attempt ends.
    let bornId: string | null = null;
    const announceMode = () => {
      if (bornId) deps.onPermissionMode?.(bornId, this.permissionModeOf(bornId));
      bornId = null;
    };
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Review M2: an interrupt between attempts (or before the first) ends the turn here.
      if (sink.signal.aborted) {
        flushEarly();
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId: shownId(), cwd, ok: false, text: '', badge: { account, model: wantedClaude ?? sessionDefault, reason, usage: ZERO_USAGE, modelNote: null, ...pinMark() }, errorText: abortedText(sink.signal) });
        announceMode();
        return done();
      }
      const fable = usageOf(deps.usage.snapshot(), account).fable?.usedPct ?? null;
      const resolved = resolveModel(wantedClaude, sessionDefault, fable, deps.usage.snapshot().usageSource);
      const routed = asOpus && resolved.model === 'fable' ? { model: 'opus' as const, note: `${asOpus} → Opus 로 대체` } : resolved;
      // ⚡ 빠르게: fast mode runs on Opus only — the account choice above is left as routed, only the model is forced.
      const { model, note } = fastTurn(p) ? { model: 'opus' as const, note: routed.model === 'opus' ? FAST_NOTE : `${FAST_NOTE} → Opus` } : routed;
      sink.emit({ type: 'turn_started', turnId: p.turnId, sessionId: shownId(), cwd, account, model, reason, attempt, engine: 'claude', sessionModel: sessionDefault, ...(p.clientRef && attempt === 0 ? { clientRef: p.clientRef } : {}) });
      flushEarly();

      const cur: Cursor = { turnId: p.turnId };
      const startedAt = this.now();
      const a = await this.attempt(p, account, model, cwd, state?.sessionId ?? null, forkAt, sink, grants, modeRef, attachments, cur, systemNote);
      const res: EngineResult = a.result ?? { kind: 'result', sessionId: a.sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '엔진이 결과 없이 종료했습니다', stderr: null, errorKind: null, terminalReason: null };
      const sessionId = a.sessionId ?? shownId();
      const forked = forkAt !== null;
      if (sessionId && (forked || !state)) bornId = sessionId;
      if (sessionId) {
        state = {
          sessionId,
          cwd,
          account,
          projectDir: await this.locateProjectDir(sessionId, account, state?.projectDir ?? path.join(this.rootOf(account), projectSlug(a.initCwd ?? cwd))),
          lastTurnAtMs: res.ok ? this.now() : forked ? null : (state?.lastTurnAtMs ?? null),
          justCompacted: a.compacted,
          defaultModel: sessionDefault,
          ...(grants.rules.length ? { allowRules: [...grants.rules] } : {}),
          ...(grants.dirs.length ? { allowDirs: [...grants.dirs] } : {}),
          mode: modeRef.mode,
          // Taken only by a new entry (a new session's pin); an existing entry keeps its stored pin.
          ...(pin ? { accountPin: pin } : {}),
          // Kept until a turn got the note through (cleared just below).
          ...(carried ? { interrupted: carried } : {}),
        };
        await deps.store.set(state);
        if (a.commanderEdited) {
          await deps.store.setCommanderEdited(sessionId, true);
          state = { ...state, commanderEdited: true };
        }
        if (cut && res.ok) {
          const st = deps.store.get(sessionId);
          if (st && !isOtherEngineState(st)) { const { interrupted: _told, ...kept } = st; await deps.store.set(kept); }
          const { interrupted: _was, ...rest } = state;
          state = rest;
        }
        // A pin picked once the new session's id was known (it had no state to take it then).
        const bornPin = this.bornPins.get(p.turnId);
        if (bornPin !== undefined) {
          this.bornPins.delete(p.turnId);
          await deps.store.setAccountPin(sessionId, bornPin);
          state = bornPin ? { ...state, accountPin: bornPin } : (({ accountPin: _drop, ...rest }) => rest)(state);
        }
        // The fork exists now: later attempts resume it like any session.
        forkAt = null;
      }

      // The account works for deck even if its usage-deck card says setup_needed (down).
      if (res.ok) deps.usage.noteTurnOk(account);
      // ⚡ A fast turn refused for fast mode / credits: shown as it is, no cooldown, no account move, no booked retry —
      // the person picks 표준으로 다시 보내기 (errorCode). Credits used up turn the session's switch off (fastOff).
      const fastFailed = fastFailureOf(p, res, sink.signal.aborted, a.rateLimit?.status ?? null);
      const failure = fastFailed ? 'other' : classifyFailure({ ok: res.ok, errorText: res.errorText, errorKind: res.errorKind, rateLimitStatus: a.rateLimit?.status ?? null });
      const fastOff = fastTurn(p) && (fastFailed ?? a.fastKind) === 'exhausted';
      const badge = { account, model, reason, usage: res.usage, modelNote: res.ok && fastTurn(p) && a.fastKind ? FAST_FELL_BACK_NOTE : note, ...pinMark() };
      const shownError = sink.signal.aborted ? abortedText(sink.signal) : displayError(res.errorText, res.stderr);
      if (res.ok || failure === 'other' || failure === null || attempt === this.maxRetries || sink.signal.aborted) {
        if (fastOff) sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId, cwd, message: FAST_OFF_NOTICE });
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId, cwd, ok: res.ok, text: res.text, badge, errorText: res.ok ? null : shownError, ...(fastFailed ? { errorCode: 'fast_refused' as const } : {}), ...(fastOff ? { fastOff: true as const } : {}) });
        announceMode();
        // Held open for background work: write back now too, not only once at the end.
        if (sessionId && a.bgTasks.length) this.mirrorSoon(sessionId, sink, p.turnId);
        if (!sessionId) { await a.rest.return?.(); return done(); }
        const need = await this.followThrough({ p, a, cur, sink, account, model, cwd, sessionId, grants, startedAt });
        if (!need) return done();
        if ('cap' in need) await this.continueAfterCap(need, { p, sink, cwd, sessionId });
        else await this.failoverAfterBackground(need, { p, sink, cwd, sessionId, account, model, routerBase });
        // The continuation may have moved the session: the caller's write-back and bookkeeping read where it is now.
        const now = deps.store.get(sessionId);
        return now && !isOtherEngineState(now) ? now : done();
      }
      await a.rest.return?.();
      // The retry sends only the turn's own prompt: a steer still waiting in the closed process goes back to its device.
      this.inputs.delete(p.turnId);
      this.rejectSteers(p.turnId, sink, { turnId: p.turnId, sessionId, cwd }, '재시도 중이라 턴이 끝난 뒤 보냅니다');

      // Spec §8: limit/auth → cooldown (shared with claude-pick) → move → retry on the next account.
      writeCooldown(deps.cooldownDir, account, this.now() + COOLDOWN_MS[failure]);
      tried.push(account);
      const why = failure === 'limit' ? '한도 도달' : '인증 실패';
      // Review M1: a refused move rules that account out for this turn; ask the router again.
      let next: { account: Account; reason: string; asOpus?: string } | null = null;
      let moveRefused = false;
      for (;;) {
        const cand = chooseAccount({
          ...routerBase,
          usage: deps.usage.routingSnapshot(),
          nowMs: this.now(),
          current: account,
          lastTurnAtMs: null,
          justCompacted: false,
          cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now(), this.accounts.list()),
          exclude: tried,
        });
        if (cand.account === account || tried.includes(cand.account)) break;
        if (!state) { next = cand; break; }
        const sid = shownId();
        const say = (message: string) => sink.emit({ type: 'turn_notice', turnId: p.turnId, sessionId: sid, cwd, message });
        const moved = forkAt ? await this.copyForFork(state, cand.account, say) : await this.relocate(state, cand.account, say);
        if (moved) { state = moved; next = cand; break; }
        moveRefused = true;
        tried.push(cand.account);
      }
      if (!next) {
        // Nowhere to go on a limit: the same prompt is tried again by itself once a limit should have lifted (written before
        // the result, so BottleneckWatch sees the booking with it). Not for a fork, a handoff note or a turn with files.
        const sid = shownId();
        if (failure === 'limit' && !moveRefused && sid && !p.handoff && !p.attachments?.length) await this.bookRetry(sid, p.text, p.retryHop, res.errorText, p.commanderHop).catch((err: unknown) => console.error('deck: 자동 재시도 예약 실패', err instanceof Error ? err.message : err));
        sink.emit({ type: 'turn_result', turnId: p.turnId, sessionId, cwd, ok: false, text: '', badge, errorText: `${why} · ${moveRefused ? '세션 이전 실패' : `대안 계정 없음${routerBase.sameVendorRotation === false ? `(${NO_ROTATION})` : ''}`} · ${shownError ?? ''}`.trim() });
        announceMode();
        return done();
      }
      sink.emit({ type: 'turn_retry', turnId: p.turnId, sessionId: shownId() ?? sessionId, cwd, fromAccount: account, toAccount: next.account, reason: `${why} → ${next.reason}`, attempt: attempt + 1 });
      reason = `재시도(${why}) · ${next.reason}`;
      account = next.account;
      asOpus = next.asOpus;
      byPin = false;
    }
    return done();
  }

  /**
   * 대안 계정 없음: books an automatic retry of `text` in session `sessionId` (SessionState.pendingRetry) — at the reset time
   * the limit text names (+1 min), else a minute after the earliest account cooldown ends, else in 30 minutes. The
   * (MAX_RETRY_HOPS+1)-th failure in a row books nothing. BottleneckWatch fires it through ws's send path.
   */
  private async bookRetry(sessionId: string, text: string, prevHop: number | undefined, errorText: string | null, commanderHop: number | undefined): Promise<void> {
    const hops = (prevHop ?? 0) + 1;
    if (hops > MAX_RETRY_HOPS) return;
    const st = this.deps.store.get(sessionId);
    if (!st) return;
    const now = this.now();
    const reset = limitResetAtMs(errorText, now);
    // 같은 벤더 계정 자동 순환 off: the retry runs on the session's own account, so only its cooldown counts.
    const cooled = Object.values(readAllCooldownsMs(this.deps.cooldownDir, now, this.rotation() || isOtherEngineState(st) ? this.accounts.list() : [st.account])).filter((v): v is number => v !== undefined);
    const atMs = reset !== null ? reset + 60_000 : cooled.length ? Math.min(...cooled) + 60_000 : now + 30 * 60_000;
    // The retry of an automatic turn runs gated too (보안 #3): the hop rides the booking to ws's send path.
    await this.deps.store.set({ ...st, pendingRetry: { text, atMs, hops, ...(commanderHop ? { commanderHop } : {}) } });
  }

  /**
   * A segment of a held-open process (background continuation or follow-up) ended on a limit / auth failure
   * (followThrough recorded the cooldown and closed the process): the router picks another account and the work goes on
   * there — turn_retry on the failed segment, then the failed follow-up is sent again under its own turn id (the UI
   * takes the new turn_started as the retry segment), or, for a background continuation, a turn that tells the model
   * what was cut (SessionState.interrupted with its cause) and asks it to go on; the follow-ups that waited behind the
   * segment follow. The session is moved by those turns' own routing (runClaudeTurn's relocate). At most one hop per
   * other account (TurnParams.failoverHop); with nowhere to go the segment ends as failed.
   */
  private async failoverAfterBackground(need: Failover, c: { p: TurnParams; sink: TurnSink; cwd: string; sessionId: string; account: Account; model: ClaudeModel; routerBase: Omit<RouterInput, 'current' | 'lastTurnAtMs' | 'justCompacted' | 'cooldownUntilMs'> }): Promise<void> {
    const { deps } = this;
    const { p, sink, cwd, sessionId, account, model, routerBase } = c;
    const why = failureLabel(need.failure);
    const hint = limitResetHint(need.errorText);
    const fail = (errorText: string) => {
      sink.emit({ type: 'turn_result', turnId: need.seg.turnId, sessionId, cwd, ok: false, text: '', badge: { account, model, reason: need.seg.reason, usage: ZERO_USAGE, modelNote: null }, errorText });
      for (const q of need.queued) sink.emit({ type: 'error', turnId: q.f.turnId, message: '세션 프로세스가 끝나 보내지 못했습니다 — 다시 보내 주세요', ...(q.f.clientRef ? { clientRef: q.f.clientRef } : {}) });
    };
    const noneLeft = `${this.label(account)} 계정 ${why}${hint ? ` · ${hint}` : ''} · 대안 계정 없음${routerBase.sameVendorRotation === false ? `(${NO_ROTATION})` : ''}`;
    // A background continuation is booked as '이어서 진행해 주세요.', a failed follow-up as its own text (not with files).
    const retryText = need.followUp ? (need.followUp.f.attachments?.length ? null : need.followUp.f.text) : '이어서 진행해 주세요.';
    const none = async () => {
      if (need.failure === 'limit' && retryText) await this.bookRetry(sessionId, retryText, need.followUp ? need.followUp.f.retryHop : p.retryHop, need.errorText, p.commanderHop).catch((err: unknown) => console.error('deck: 자동 재시도 예약 실패', err instanceof Error ? err.message : err));
      fail(noneLeft);
    };
    try {
      const hop = p.failoverHop ?? 0;
      if (hop >= this.accounts.list().length - 1) { await none(); return; }
      const cand = chooseAccount({
        ...routerBase,
        usage: deps.usage.routingSnapshot(),
        nowMs: this.now(),
        current: account,
        lastTurnAtMs: null,
        justCompacted: false,
        cooldownUntilMs: readAllCooldownsMs(deps.cooldownDir, this.now(), this.accounts.list()),
        exclude: [account],
      });
      if (cand.account === account) { await none(); return; }
      sink.emit({ type: 'turn_retry', turnId: need.seg.turnId, sessionId, cwd, fromAccount: account, toAccount: cand.account, reason: `${why}${hint ? ` · ${hint}` : ''} → ${cand.reason}`, attempt: 1 });
      sink.emit({ type: 'turn_notice', turnId: need.seg.turnId, sessionId, cwd, message: `${this.label(account)} 계정 ${why}${hint ? ` (${hint})` : ''} — ${this.label(cand.account)} 계정으로 이어서 진행합니다` });
      const st = deps.store.get(sessionId);
      if (st && !isOtherEngineState(st)) {
        // The closed process wrote the transcript: deck's own write, not Desktop / a CLI (openElsewhere).
        this.deckWroteAt.set(path.resolve(st.projectDir, `${sessionId}.jsonl`), this.now());
        // What the process was doing is told to the model on the next turn: always for a background continuation (it
        // is the continuation turn's whole point), for a resent follow-up only when background work was cut with it.
        if (!need.followUp || need.tasks.length) await deps.store.set({ ...st, interrupted: { atMs: this.now(), tasks: need.tasks, cause: `${this.label(account)} 계정 ${why}` } });
      }
      const next = { cwd, sessionId, failoverHop: hop + 1, ...(p.commanderHop ? { commanderHop: p.commanderHop } : {}), ...(p.lang ? { lang: p.lang } : {}) };
      const ofFollowUp = (f: FollowUpParams): TurnParams => ({ ...next, turnId: f.turnId, text: f.text, ...(f.model ? { model: f.model } : {}), ...(f.attachments ? { attachments: f.attachments } : {}), ...(f.clientRef ? { clientRef: f.clientRef } : {}), ...(f.retryHop ? { retryHop: f.retryHop } : {}), ...(f.lang ? { lang: f.lang } : {}) });
      // The continuation refused before its turn_started (attachment purged, session gone): the segment that got the
      // turn_retry still needs an end, else the pane waits on it.
      let started = false;
      const watched: TurnSink = { ...sink, emit: (m) => { if (m.type === 'turn_started' && m.turnId === need.seg.turnId) started = true; sink.emit(m); } };
      if (need.followUp) await this.run(ofFollowUp(need.followUp.f), watched);
      else await this.run({ ...next, turnId: need.seg.turnId, text: '이어서 진행해 주세요.' }, watched);
      if (!started) { fail(`${this.label(account)} 계정 ${why}${hint ? ` · ${hint}` : ''} · 다른 계정에서 이어가지 못했습니다`); return; }
      for (const q of need.queued) {
        // A continuation still held open for background work takes them as follow-ups; else each is a turn of its own.
        const live = this.live.get(sessionId);
        if (live) { live.submit(q.f, q.attachments); continue; }
        await this.run(ofFollowUp(q.f), sink);
      }
    } catch (err) {
      console.error('deck: 한도 이어가기 실패', err instanceof Error ? err.message : err);
      fail(`${this.label(account)} 계정 ${why}${hint ? ` · ${hint}` : ''} · 다른 계정으로 이어가지 못했습니다`);
    }
  }
}
