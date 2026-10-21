import { z } from 'zod';
import { ACCOUNT_ID_RE, RESERVED_ACCOUNT_IDS, type Account, type AccountNames, type GeminiAccount, type Seat } from './accounts';
import { GROK_MODELS, type AnyModel, type ClaudeModel, type CodexSandbox, type Effort, type EngineKind } from './models';
import { PERM_MODES, type PermMode } from './permission';
import type { DesktopSession, ProjectEntry, TranscriptMessage } from './session-types';
import type { BgTaskInfo, PermissionDecision, Question, QuestionAnswers, TaskUpdate, TaskUsage, TurnPhase, TurnUsage } from './turn-types';
import type { UsageSnapshot } from './usage-types';
import type { TaskInfo } from './tasks';

/** Attachment ids are the UUIDs POST /api/attachments returned (Task 6); nothing path-like is accepted. */
export const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_ATTACHMENTS_PER_TURN = 8;
/** D7: per-file upload size cap, shared by the server (413) and the UI (pre-flight check before the network call). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const CLIENT_REF_MAX = 64;
/** Every engine, in 자동 분배 order (settings `autoEngines` / `autoConsent`). */
export const ENGINE_KINDS: readonly EngineKind[] = ['claude', 'codex', 'gemini', 'grok'];
/** A Claude account id by shape only (`ACCOUNT_ID_RE`): which ids exist is the server's configuration, checked when the message is handled. */
const AccountId = z.string().regex(ACCOUNT_ID_RE).refine((id) => !RESERVED_ACCOUNT_IDS.includes(id), { message: '예약된 이름이라 계정 id 로 쓸 수 없습니다' });

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send'),
    sessionId: z.string().min(1).nullable(),
    // Review M8: absolute path, bounded; the server also checks it is an existing directory.
    cwd: z.string().min(1).max(4096).refine((c) => c.startsWith('/'), { message: 'cwd must be an absolute path' }),
    text: z.string().min(1).max(200_000),
    /** 'auto' = 자동: new Claude sessions get a model from the first prompt; later turns keep the session's model. */
    model: z.enum(['sonnet', 'opus', 'fable', 'gpt-6-sol', 'gpt-6-astra', 'gemini-pro', 'gemini-flash', ...GROK_MODELS, 'auto']).optional(),
    /** Reasoning effort for this turn (allowlist = shared/models EFFORTS); absent = the engine's own default. */
    effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    /**
     * New sessions only (D3): which engine opens the session. Ignored on resume — the stored engine wins. 'auto' = 자동 분배
     * (chooseRoute): Gemini / Grok only when on in settings `autoEngines` and agreed to in `autoConsent`.
     */
    engine: z.enum(['claude', 'codex', 'gemini', 'grok', 'auto']).optional(),
    /** New Codex / Gemini sessions only (D2). */
    sandbox: z.enum(['read-only', 'workspace-write']).optional(),
    /** New Claude sessions only: 이 세션은 B 써 (null/absent = 자동). Existing sessions use set_account_pin. */
    accountPin: AccountId.nullable().optional(),
    /** New Claude sessions only: the permission mode picked before the first send (existing sessions use set_permission_mode). */
    permissionMode: z.enum(PERM_MODES).optional(),
    attachments: z.array(z.string().regex(ATTACHMENT_ID)).max(MAX_ATTACHMENTS_PER_TURN).optional(),
    /** Client correlation id: echoed on this send's turn_started and on any error refusing it (which pane sent it). */
    clientRef: z.string().min(1).max(CLIENT_REF_MAX).optional(),
    /** 새 세션으로 이어가기, step 1 (existing sessions only): the server runs shared/handoff HANDOFF_PROMPT with every tool call denied. */
    handoff: z.boolean().optional(),
    /** Step 2 (new sessions only): the session this one continues; once it has an id, deck's session meta links the two. */
    handoffFrom: z.string().min(1).max(200).optional(),
    /**
     * 메시지 편집 갈래 (new sessions only): `text` replaces user message `n` (TranscriptMessage.n) of Claude session `from`.
     * `expect` is that message as the device showed it — the server checks it (nearest match) before forking.
     */
    branch: z.object({ from: z.string().min(1).max(200), n: z.number().int().min(0).max(1_000_000), expect: z.string().max(200_000).optional() }).optional(),
    /** 복제 (new sessions only): deck's title for the new session, set in session meta once it has an id. */
    title: z.string().min(1).max(200).optional(),
    /** 그래도 보내기: send even though the engine cannot do this kind of turn (skips the `route_fit` check). */
    ignoreFit: z.boolean().optional(),
    /** 간결 모드 (the device's pref): answer results-first, short, decisions as cards (shared/concise CONCISE_STYLE_PROMPT). Claude only for now. */
    concise: z.boolean().optional(),
    /**
     * ⚡ 빠르게 (the session's switch on the device): a Claude turn runs on Opus with `fastMode` (billed to usage credits,
     * not the plan). Ignored on a handoff note and by Codex / Gemini / Grok.
     */
    fast: z.boolean().optional(),
  }),
  z.object({ type: z.literal('permission_response'), requestId: z.string().min(1), decision: z.enum(['once', 'session', 'deny']) }),
  /** D8: answers keyed by the question text, values are option labels (comma-joined for multiSelect) or free text. */
  z.object({ type: z.literal('question_response'), requestId: z.string().min(1), answers: z.record(z.string().max(2000), z.string().max(4000)) }),
  /**
   * A message typed while a Claude turn runs: written into the running process's input (priority 'next'), so the CLI
   * folds it in at the next tool boundary of the same turn — or runs it right after the turn when none comes.
   * `turnId` = the running turn the device shows; `steerId` = the device's id for it (echoed on steer_delivered /
   * steer_rejected). Refused (steer_rejected) when it cannot go in now: the device then sends it after the turn.
   */
  z.object({
    type: z.literal('steer'),
    turnId: z.string().min(1),
    steerId: z.string().min(1).max(CLIENT_REF_MAX),
    text: z.string().min(1).max(200_000),
    attachments: z.array(z.string().regex(ATTACHMENT_ID)).max(MAX_ATTACHMENTS_PER_TURN).optional(),
  }),
  z.object({ type: z.literal('interrupt'), turnId: z.string().min(1) }),
  /**
   * 취소 on a send the server answered with `turn_queued`: take it out of the session's queue before it goes in. No
   * reply — too late (already in) and the ref's turn_started arrives as usual. Only sent after a `turn_queued`, so any
   * server that sent one understands it.
   */
  z.object({ type: z.literal('cancel_queued'), sessionId: z.string().min(1), clientRef: z.string().min(1).max(CLIENT_REF_MAX) }),
  /** Stop one background task of a running turn (the rest of the turn keeps going). */
  z.object({ type: z.literal('stop_task'), turnId: z.string().min(1), taskId: z.string().min(1).max(200) }),
  /**
   * `after` (servers with the 'catchup' feature; others drop it and answer with the full history): the last stream
   * position this device applied for the session. When the server still holds what came after it, it answers `catchup`
   * and only those events instead of `history`.
   */
  z.object({
    type: z.literal('open_session'), sessionId: z.string().min(1), after: z.object({ epoch: z.string().min(1).max(200), seq: z.number().int().min(0) }).optional(),
    /** Server message kinds beyond the base set this UI understands ('sandbox'): the socket gets them from now on (rule 3). */
    accepts: z.array(z.string().max(40)).max(20).optional(),
  }),
  /** D6: a pane closed this session; stop routing its turn events to this socket. */
  z.object({ type: z.literal('close_session'), sessionId: z.string().min(1) }),
  /** After a reconnect: keep receiving a running turn this tab started (e.g. a new session with no id yet). */
  z.object({ type: z.literal('watch_turn'), turnId: z.string().min(1) }),
  z.object({ type: z.literal('refresh_index') }),
  /** Pin a Claude session to an account (null = 자동); persisted, applied from the next turn, broadcast as `account_pin`. */
  z.object({ type: z.literal('set_account_pin'), sessionId: z.string().min(1), pin: AccountId.nullable() }),
  /** A Claude session's permission mode; persisted, applied to its running turn at once, broadcast as `permission_mode`. */
  z.object({ type: z.literal('set_permission_mode'), sessionId: z.string().min(1), mode: z.enum(PERM_MODES) }),
  /** A GPT session's sandbox (D2; never danger-full-access); persisted, used from its next turn, broadcast as `sandbox`. Claude/Gemini: refused. */
  z.object({ type: z.literal('set_sandbox'), sessionId: z.string().min(1), sandbox: z.enum(['read-only', 'workspace-write']) }),
  /**
   * Server-wide settings (persisted, broadcast to every device as `settings`). `defaultPermissionMode` = the mode new
   * sessions start in; `autoApprove` is the legacy switch (true = bypassPermissions, false = default).
   */
  /** Settings: unlock the Grok engine after a tripwire (§14.9-3). */
  z.object({ type: z.literal('grok_unlock') }),
  z.object({ type: z.literal('set_settings'), autoApprove: z.boolean().optional(), defaultPermissionMode: z.enum(PERM_MODES).optional(), routingPolicy: z.enum(['balance', 'drain']).optional(), sameVendorRotation: z.boolean().optional(), /** 총사령탑 켜기·끄기 (설정 화면 토글). */ commanderEnabled: z.boolean().optional(),
    /** 자동 분배: engines 자동 may use, engines whose external-transfer card was accepted, Grok fast model. */
    autoEngines: z.array(z.enum(['claude', 'codex', 'gemini', 'grok'])).max(4).optional(), autoConsent: z.array(z.enum(['claude', 'codex', 'gemini', 'grok'])).max(4).optional(), grokFast: z.boolean().optional(), taskSoftCap: z.number().int().min(1).max(10).optional() }),
  /**
   * 'routePreview' servers: which account the next Claude turn of this session (null with a `cwd` = a new session there)
   * would run on if sent now with `model` (absent = the session's own default; '자동' on a new session has no preview),
   * without running one. Answered with `route_preview` (Claude sessions only; GPT / Gemini and unknown ids get no
   * answer); the server remembers the socket's last ask and answers it again after a usage change that changes the answer.
   * `sessionId: null` with no `cwd` withdraws the ask (the pane left Claude): nothing more is sent.
   */
  /**
   * 작업 폴더 바꾸기: the session's next turns run in `cwd` (an existing folder under the allowed roots). Refused while the
   * session runs or holds background work. Answered with `session_cwd` to every device (and an `index`); refused with `error`.
   */
  z.object({ type: z.literal('set_cwd'), sessionId: z.string().min(1).max(200), cwd: z.string().min(1).max(4096).refine((c) => c.startsWith('/'), { message: 'cwd must be an absolute path' }) }),
  /** 복제: the sender gets `session_duplicate` (the session's settings for a new, empty session); nothing is copied yet. */
  z.object({ type: z.literal('duplicate_session'), sessionId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('route_preview'), sessionId: z.string().min(1).max(200).nullable(), cwd: z.string().min(1).max(4096).optional(), model: z.enum(['sonnet', 'opus', 'fable', 'auto']).optional() }),
  /**
   * 'commander' servers (총사령탑): arm a goal on an existing Claude session. Refused (`error` with a RefusalCode) while
   * one is active, on a bypass session, on a non-Claude session, or with the feature off. Answered by a `commander` broadcast.
   */
  /**
   * 백그라운드 작업 ('tasks' servers): run `text` as a new session in `cwd` (자동 engine and model), leaving the sending chat
   * free. Queued behind the soft cap (설정 taskSoftCap). Answered with `tasks` to every device; refused with `error`.
   */
  z.object({ type: z.literal('start_task'), cwd: z.string().min(1).max(4096).refine((c) => c.startsWith('/'), { message: 'cwd must be an absolute path' }), text: z.string().trim().min(1).max(200_000), fromSessionId: z.string().min(1).max(200).nullable(), concise: z.boolean().optional(), fast: z.boolean().optional(), clientRef: z.string().min(1).max(CLIENT_REF_MAX).optional() }),
  /** 닫기 on an ended task's card. */
  z.object({ type: z.literal('dismiss_task'), taskId: z.string().min(1).max(64) }),
  /** 백그라운드 작업 취소: a queued task leaves the list; a running one's turn is stopped (it ends as 취소됨). */
  z.object({ type: z.literal('cancel_task'), taskId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('commander_set'), sessionId: z.string().min(1).max(200), goal: z.string().trim().min(1).max(2000), done: z.string().trim().min(1).max(2000), maxTurns: z.number().int().min(1).max(50).optional() }),
  /** ■ 정지 / 일시 정지 / 재개 — `epoch` is the one the device last saw; another one is refused (`commander_stale_epoch`). */
  z.object({ type: z.literal('commander_stop'), sessionId: z.string().min(1).max(200), epoch: z.number().int().min(0) }),
  z.object({ type: z.literal('commander_pause'), sessionId: z.string().min(1).max(200), epoch: z.number().int().min(0) }),
  z.object({ type: z.literal('commander_resume'), sessionId: z.string().min(1).max(200), epoch: z.number().int().min(0) }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/**
 * Server-wide settings. defaultPermissionMode: the mode new Claude sessions (and sessions deck has no mode for) start in.
 * autoApprove mirrors `defaultPermissionMode === 'bypassPermissions'` (legacy 자동 승인; new GPT sessions default to workspace-write).
 */
export type DeckSettings = { autoApprove: boolean; defaultPermissionMode: PermMode; /** Absent from older servers (= 'balance'). */ routingPolicy?: RoutingPolicy;
  /**
   * 같은 벤더 계정 자동 순환: true = the router may move a session between Claude accounts by itself (limits, Fable cap,
   * cold cache, failover). false (the default) = a session stays on its account (new ones on the home account) unless the
   * user pins another. Turned on only after the user agrees to the own-accounts-only notice. Absent from older servers.
   */
  sameVendorRotation?: boolean;
  /** 총사령탑: off by default (설정 화면 토글 or the settings file); the turn cap a goal gets without one and its token budget (file only). Absent from older servers. */
  commanderEnabled?: boolean;
  commanderMaxTurns?: number;
  commanderTokenCap?: number;
  /** 자동 분배: engines 자동 may open a session on (default all four). Absent from older servers. */
  autoEngines?: EngineKind[];
  /** Engines whose "code goes to Google / xAI" card was accepted (only Gemini and Grok need one; default none). */
  autoConsent?: EngineKind[];
  /** 자동 uses Grok 4.7 Build Fast instead of Grok 4.7 (2× price; default off). */
  grokFast?: boolean;
  /** 백그라운드 작업 running at once before new ones wait (1–10, default 3). Absent from older servers. */
  taskSoftCap?: number };

/**
 * 자동 account routing: 'balance' (고르게 분산) = the safe account with the lowest 5h usage;
 * 'drain' (리셋 임박 먼저 소진) = the account whose weekly quota resets soonest, relative to what is left.
 */
export const ROUTING_POLICIES = ['balance', 'drain'] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

/** One configured Claude account as the UI needs it (`hello.accounts`). `retired`: read-only — shown, never offered as a pin. */
export type AccountInfo = { id: Account; label: string; home: boolean; retired: boolean };

/** `hello.accounts` for a registry: every configured account (retired included), in configured order. */
export function accountInfos(names: Pick<AccountNames, 'all' | 'label' | 'isHome' | 'isRetired'>): AccountInfo[] {
  return names.all().map((id) => ({ id, label: names.label(id), home: names.isHome(id), retired: names.isRetired(id) }));
}

/** gemini-cli present, and which accounts have an OAuth file (existence only; the UI shows "로그인 필요" otherwise). */
export type GeminiStatus = { available: boolean; loggedIn: Record<GeminiAccount, boolean> };
/** A `grok` binary was found (DECK_GROK_BIN → PATH → ~/.grok/bin/grok) and what `grok --version` printed. Login is not checked (design §5). */
export type GrokStatus = { bin: boolean; version?: string; /** §14.9-3: why the Grok engine is locked (a tripwire fired); null/absent = not locked. */ locked?: string | null };

export type TurnBadge = { account: Seat; model: AnyModel; reason: string; usage: TurnUsage; modelNote: string | null; /** The account was chosen because the session is pinned to it. */ pinned?: boolean };

/** An attachment as shown in a sent bubble (images load from GET /api/attachments/:id). */
export type PromptFile = { id: string; name: string; isImage: boolean };
/** What the user typed for a turn, as sent (attachment metadata only) — lets every device viewing the session show the bubble. */
export type TurnPrompt = { text: string; attachments: PromptFile[] };

/** A turn in flight; sessionId is null for a new session until the CLI reports one. */
export type RunningTurn = { turnId: string; sessionId: string | null; cwd: string };

/**
 * What runs where, for the sidebar and the tab title on every device: one entry per session with a
 * turn in flight or background work held open. `forMs` = how long the current turn has run.
 */
export type SessionActivity = { sessionId: string; cwd: string; turnId: string; running: boolean; bg: number; forMs: number; /** Live background task titles: at most 5, each cut to 80 characters (absent: none, or an older server). */ tasks?: string[] };

/**
 * What this server can do beyond the first protocol, announced in `hello.features` (see docs/protocol.md). A server
 * that sends no list has none of them. The UI asks only through ui/features.ts `has()`.
 * - sessionModel: a Claude session's `history` carries the model it runs on.
 * - abortLabel: a user's interrupt ends the turn with exactly '중단됨' (never the SDK's own text).
 * - catchup: turn events carry `pos`; `open_session.after` is answered with `catchup` when possible.
 * - accounts: `hello.accounts` lists the configured Claude accounts; account pins take any of its active ids.
 * - sessionSandbox: `set_sandbox` changes an existing GPT session's sandbox (announced to sockets that accept 'sandbox').
 * - routePreview: `route_preview` asks are answered with `route_preview` (and again after usage changes).
 * - highlights: GET /api/highlights answers (세션 하이라이트, events.jsonl).
 * - sessionOps: `set_cwd` (작업 폴더 바꾸기) and `duplicate_session` (복제) are answered; `send.title` is applied.
 * - serverUpdate: GET /api/server-update and POST /api/restart answer (서버 업데이트 대기 · 지금 재시작; `{force:true}` while draining exits now).
 * - grok: a `grok` binary was found — `send.engine: 'grok'` can open a Grok session. Advertised only then (`hello.grok.bin`).
 * - commander: `commander_set|stop|pause|resume` are answered and `commander` is broadcast (총사령탑). Advertised only while
 *   the settings turn it on (`commanderEnabled`); a `settings` broadcast that changes it carries the new list.
 */
export const FEATURES = ['sessionModel', 'abortLabel', 'catchup', 'accounts', 'sessionSandbox', 'routePreview', 'highlights', 'fileRaw', 'sessionOps', 'serverUpdate', 'commander', 'grok', 'tasks'] as const;
export type Feature = (typeof FEATURES)[number];

/**
 * Where a turn event stands in its session's stream: `seq` grows by one per event for the session (never reused while
 * the server runs); `epoch` names the process that produced it (events can be re-sent only while it lives).
 */
export type StreamPos = { sid: string; epoch: string; seq: number };

/** Review I3: every turn-scoped message says which session (null = new, not yet known) and cwd it belongs to. `pos`: once the session has an id ('catchup' servers). */
type TurnScope = { turnId: string; sessionId: string | null; cwd: string; pos?: StreamPos };

/** 총사령탑 — what a device shows of a session's commander (the `commander` broadcast and SessionFacts.commander). */
export type CommanderStatusName = 'idle' | 'armed' | 'sending' | 'running' | 'judging' | 'waiting_human' | 'paused' | 'stopped' | 'done';
export type CommanderView = {
  state: {
    status: CommanderStatusName; hop: number; maxTurns: number; epoch: number; goal: string; done: string;
    budget: { maxAutoTurns: number; autoTurnsUsed: number; maxTokens: number; tokensUsed: number; maxWallClockMs: number; maxInternalRetries: number; internalRetriesUsed: number };
  };
  lastVerdict?: { verdict: 'continue' | 'human' | 'done'; reason: string; next?: string; evidence?: { testRunId: string }; atMs: number };
  /** Why it waits / stopped (사람 필요 · 재시작으로 끊김 · 상한 도달 …), when the server set one. */
  note?: string;
};

/** What `history` and `catchup` both say about the session besides its messages. */
export type SessionFacts = { /** 'commander' servers: the session's commander, null when it has none. */ commander?: CommanderView | null; runningTurnId: string | null; /** Claude sessions: the pinned account (null = 자동). */ accountPin?: Account | null; /** Claude sessions: the mode its next tool calls run in. */ permissionMode?: PermMode; /** The model the session runs on (its stored default; GPT / Gemini / Grok too: the model 자동 picked stays on reopen; absent: an older server). */ sessionModel?: AnyModel; /** Grok sessions: the stored effort (a reopened pane keeps it). */ sessionEffort?: Effort; /** The running turn's prompt (a device opening the session mid-turn shows it even before the transcript has it). */ runningPrompt?: TurnPrompt | null; /** How long the running turn has run (its elapsed timer on a device that opens it mid-turn). */ runningForMs?: number; /** The send clientRefs / steer ids this session accepted lately (absent: an older server). */ acceptedRefs?: string[]; /** Refs handed to the running process but not recorded yet: they are going in — never sent again by themselves. */ pendingRefs?: string[]; /** Set when the per-session cap may have pushed older refs out: the oldest kept ref's time (ms). A maybe-sent message from before it cannot be told by the list. */ acceptedRefsSince?: number; /** The session's newest stream position (absent: no turn since the server started, or an older server). */ pos?: StreamPos };

export type ServerMessage =
  /** F2: `pins` = pinned session ids in pin order (optional only for older test literals). */
  /** `desktop` = recent Claude Desktop sessions (optional only for older test literals). */
  | { type: 'grok_status'; grok: GrokStatus }
  | { type: 'hello'; usage: UsageSnapshot; projects: ProjectEntry[]; pins?: string[]; desktop?: DesktopSession[]; settings?: DeckSettings; running: RunningTurn[]; activity?: SessionActivity[]; codex: { available: boolean }; gemini?: GeminiStatus; grok?: GrokStatus; /** See FEATURES; absent = none (an older server). Unknown names are ignored. */ features?: string[]; /** 'accounts' servers: the configured Claude accounts (retired included), in configured order. Absent (an older server) = a/b/c, a is home. */ accounts?: AccountInfo[]; /** UI build id of the serving deck (null in dev); a changed id on reconnect means a new UI is out. */ build?: string | null }
  /** `features`: the server's list again when a setting changed it (총사령탑 켜기·끄기 → 'commander'); absent = unchanged. */
  | { type: 'settings'; settings: DeckSettings; features?: string[] }
  /** 백그라운드 작업 ('tasks' servers): the whole list (newest last) and the soft cap, after hello and on every change. */
  | { type: 'tasks'; tasks: TaskInfo[]; cap: number }
  | ({ type: 'commander'; sessionId: string } & CommanderView)
  /** A Claude session's permission mode changed (picker, Shift+Tab, or an approved plan). */
  | { type: 'permission_mode'; sessionId: string; mode: PermMode }
  /** A session's account pin changed (null = 자동). */
  | { type: 'account_pin'; sessionId: string; pin: Account | null }
  /** A GPT session's sandbox changed (set_sandbox, 'sessionSandbox' servers). */
  | { type: 'sandbox'; sessionId: string; sandbox: CodexSandbox }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'index'; projects: ProjectEntry[]; pins?: string[]; desktop?: DesktopSession[] }
  | ({ type: 'history'; sessionId: string; cwd: string; account: Seat | null; engine?: EngineKind; sandbox?: CodexSandbox | null; messages: TranscriptMessage[] } & SessionFacts)
  /**
   * The answer to `open_session.after` when nothing has to be read again: the device keeps what it shows, and the events
   * after its position (if any) follow this message at once, in order. Never sent unasked.
   */
  | ({ type: 'catchup'; sessionId: string; /** GPT sessions ('sessionSandbox' servers): the current sandbox. */ sandbox?: CodexSandbox } & SessionFacts)
  | ({ type: 'turn_started'; account: Seat; model: AnyModel; reason: string; attempt: number; engine?: EngineKind; clientRef?: string; /** The user message that started this turn (absent for a background continuation); the sending pane already shows it. */ prompt?: TurnPrompt; /** Claude: the session's stored model after this send (a pick sticks); panes that picked none show it. Absent: unchanged / an older server. */ sessionModel?: ClaudeModel } & TurnScope)
  | ({ type: 'delta'; text: string } & TurnScope)
  /** Claude thinking content so far (chunks; empty text = a block started); `redacted` = an encrypted block. */
  | ({ type: 'thinking'; text: string; redacted?: boolean } & TurnScope)
  | ({ type: 'tool_call'; toolUseId: string; name: string; input: unknown } & TurnScope)
  | ({ type: 'tool_result'; toolUseId: string; content: string; isError: boolean } & TurnScope)
  | ({
      type: 'permission_request';
      requestId: string;
      toolName: string;
      input: unknown;
      /** SDK prompt sentence, reason, and the path that triggered it, when the CLI supplied them (review I4). */
      title: string | null;
      decisionReason: string | null;
      blockedPath: string | null;
      /** Open on 거부; no one-click approve default. */
      defaultToNo: boolean;
      /** False when no SDK suggestion can be kept for the session, or suppressAlwaysAllowRule: hide 이 세션. */
      allowSession: boolean;
      /** What 이 세션 will allow, e.g. "이 세션 동안 파일 편집 허용"; null when not offered. */
      sessionLabel: string | null;
    } & TurnScope)
  | { type: 'permission_resolved'; requestId: string; decision: PermissionDecision }
  /** D8: AskUserQuestion card; answered with question_response, closed for everyone with question_resolved. */
  | ({ type: 'question_request'; requestId: string; questions: Question[] } & TurnScope)
  | { type: 'question_resolved'; requestId: string; answers: QuestionAnswers | null }
  /** Non-terminal note about a running turn (e.g. a refused session move). */
  | ({ type: 'turn_notice'; message: string } & TurnScope)
  /**
   * The send was taken by the session's held-open process but waits in deck while a segment streams (`behind` = that
   * segment's reason, e.g. 백그라운드 계속): its turn_started comes with that segment's result. Only to the sending socket,
   * and only when it asked for the kind (open_session.accepts, rule 3).
   */
  | { type: 'turn_queued'; turnId: string; sessionId: string; cwd: string; clientRef: string; behind: string }
  /** A hook sent the model a message mid-turn (e.g. a Stop hook made it keep going): a muted row in the turn. `event`: Stop, PreToolUse… */
  | ({ type: 'turn_system'; source: string; label: string; text: string } & TurnScope)
  /** A background task (run_in_background Bash, backgrounded agent) settled during the turn; drives a push, the UI ignores it. */
  | ({ type: 'task_done'; status: 'completed' | 'failed' | 'stopped'; summary: string; taskId?: string; toolUseId?: string | null; usage?: TaskUsage } & TurnScope)
  /** Live state of a task (subagent or background command): started, progress, status change. Latest wins per taskId. */
  | ({ type: 'task_update'; /** On a replay to a device that opened the session mid-turn: how long ago the task started. */ ageMs?: number } & TaskUpdate & TurnScope)
  /** The running turn's output so far (main conversation) and what it is doing now — the status row. */
  | ({ type: 'turn_progress'; outputTokens: number; phase: TurnPhase } & TurnScope)
  /** A subagent's own tool call / result, under the Agent call `parentToolUseId` (never in the main transcript). */
  | ({ type: 'sub_tool_call'; parentToolUseId: string; toolUseId: string; name: string; input: unknown } & TurnScope)
  | ({ type: 'sub_tool_result'; parentToolUseId: string; toolUseId: string; isError: boolean } & TurnScope)
  /** `draining`: the server is waiting for running work before a restart. `serverStartedAt`: when this server process started (ms, fixed) — a change after a reconnect means it restarted. */
  | { type: 'activity'; sessions: SessionActivity[]; draining?: boolean; serverStartedAt?: number }
  /** The answer to a `route_preview` ask (and again after each usage change): the account the next turn would take and why. */
  | { type: 'route_preview'; sessionId: string | null; account: Account; reason: string; asOpus?: boolean }
  | ({ type: 'turn_retry'; fromAccount: Account; toAccount: Account; reason: string; attempt: number } & TurnScope)
  /**
   * Background tasks (Agent run_in_background, background Bash) live in the turn's process, one
   * description each; [] = none left. While non-empty the process stays open after the turn's
   * result; a finished task's continuation arrives as a new turn (reason 백그라운드 계속).
   * `turnId` names the turn the work belongs to (interrupt it to stop the work).
   */
  | ({ type: 'turn_background'; tasks: string[]; /** Per task: id (for stop_task), type, age. */ detail?: BgTaskInfo[]; /** stop_task works for this turn. */ canStop?: boolean } & TurnScope)
  | ({ type: 'turn_result'; ok: boolean; text: string; badge: TurnBadge | null; errorText: string | null; /** The model alias the engine ran this turn on (absent: unknown / an older server). */ model?: string; /** An automatic (총사령탑) turn: no completion push of its own. */ auto?: 'commander'; /** Why it failed, when the client can act on it: 'thread_locked' = another app (ChatGPT desktop) holds this GPT thread. Older clients ignore it. */ errorCode?: 'thread_locked' } & TurnScope)
  /**
   * A steer reached the model, at this point of the transcript (mid-turn after a tool round, or as the start of its own
   * turn right after `turnId`'s result). Every device viewing the session shows `prompt` as the user's message here.
   */
  | ({ type: 'steer_delivered'; steerId: string; prompt: TurnPrompt; /** Re-sent after `history` to a device that opened the session mid-turn (the transcript may already show it). */ replay?: true } & TurnScope)
  /** A steer did not go in (no running Claude turn, process closed, retry/failover): the sending device sends it after the turn. */
  | ({ type: 'steer_rejected'; steerId: string; message: string; /** Why, when the device should act on it (see RefusalCode). */ code?: RefusalCode } & TurnScope)
  /** 작업 폴더 바꾸기 (set_cwd) took: the session's turns run in `cwd` from now on. */
  | { type: 'session_cwd'; sessionId: string; cwd: string }
  /**
   * 복제 (duplicate_session), to the sender only: open a new session with these settings. `title` = "<원래 제목> (복사)",
   * sent back as the first send's `title`. No history is copied.
   */
  | { type: 'session_duplicate'; from: string; cwd: string; engine: EngineKind; model: AnyModel; title: string; accountPin?: Account | null; permissionMode?: PermMode; sandbox?: CodexSandbox }
  /**
   * The engine cannot take this turn (auto-route §10-4: Gemini with a shell / non-explain turn, Grok with an image): the
   * turn was not sent. `need` = what is missing ("셸 실행"). Resend with `ignoreFit: true` to send anyway. Carries the
   * send's `clientRef`; `sessionId` is null on a new session.
   */
  | { type: 'route_fit'; turnId: string; sessionId: string | null; engine: EngineKind; need: string; clientRef?: string; pos?: StreamPos }
  | { type: 'error'; turnId: string | null; message: string; pos?: StreamPos; clientRef?: string; /** Why, when the device should act on it (see RefusalCode). */ code?: RefusalCode; /** The error is about this session (e.g. opening it failed): shown in the panes showing it. */ sessionId?: string; /** An answer to this permission / question card came too late (another device answered it first): the card goes, nothing is shown. */ requestId?: string };

/**
 * 'draining': the server is about to restart (USR2) — the device sends the refused message again once it reconnects.
 * 'already_accepted': the session took a send / steer under this ref already — the device drops its copy.
 * 'in_flight': the session is taking this ref right now (not recorded yet; it may still fail) — the device keeps its copy, paused.
 * 'not_found': open_session named a session the server does not have — asking again will not help.
 * 'commander_bypass' / 'commander_active' / 'commander_engine' / 'commander_disabled' / 'commander_stale_epoch' (총사령탑):
 * the session runs in bypass mode · a commander is already active (stop it first; also: no bypass while one is) · not an
 * existing Claude session · the feature is off · the device's epoch is not the current one (its screen is out of date).
 */
export type RefusalCode = 'draining' | 'already_accepted' | 'in_flight' | 'not_found' | 'commander_bypass' | 'commander_active' | 'commander_engine' | 'commander_disabled' | 'commander_stale_epoch';

/** How long / how many accepted refs the server keeps per session (`history.acceptedRefs`). */
export const ACCEPTED_REFS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCEPTED_REFS_MAX = 500;
