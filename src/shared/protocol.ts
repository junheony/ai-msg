import { z } from 'zod';
import type { Account, GeminiAccount, Seat } from './accounts';
import type { AnyModel, CodexSandbox, EngineKind } from './models';
import type { DesktopSession, ProjectEntry, TranscriptMessage } from './session-types';
import type { BgTaskInfo, PermissionDecision, Question, QuestionAnswers, TaskUpdate, TaskUsage, TurnPhase, TurnUsage } from './turn-types';
import type { UsageSnapshot } from './usage-types';

/** Attachment ids are the UUIDs POST /api/attachments returned (Task 6); nothing path-like is accepted. */
export const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_ATTACHMENTS_PER_TURN = 8;
/** D7: per-file upload size cap, shared by the server (413) and the UI (pre-flight check before the network call). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const CLIENT_REF_MAX = 64;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send'),
    sessionId: z.string().min(1).nullable(),
    // Review M8: absolute path, bounded; the server also checks it is an existing directory.
    cwd: z.string().min(1).max(4096).refine((c) => c.startsWith('/'), { message: 'cwd must be an absolute path' }),
    text: z.string().min(1).max(200_000),
    /** 'auto' = 자동: new Claude sessions get a model from the first prompt; later turns keep the session's model. */
    model: z.enum(['sonnet', 'opus', 'fable', 'gpt-6-sol', 'gpt-6-astra', 'gemini-pro', 'gemini-flash', 'auto']).optional(),
    /** Reasoning effort for this turn (allowlist = shared/models EFFORTS); absent = the engine's own default. */
    effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    /** New sessions only (D3): which engine opens the session. Ignored on resume — the stored engine wins. 'gemini' is explicit only. */
    engine: z.enum(['claude', 'codex', 'gemini', 'auto']).optional(),
    /** New Codex / Gemini sessions only (D2). */
    sandbox: z.enum(['read-only', 'workspace-write']).optional(),
    /** New Claude sessions only: 이 세션은 B 써 (null/absent = 자동). Existing sessions use set_account_pin. */
    accountPin: z.enum(['a', 'b', 'c']).nullable().optional(),
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
  }),
  z.object({ type: z.literal('permission_response'), requestId: z.string().min(1), decision: z.enum(['once', 'session', 'deny']) }),
  /** D8: answers keyed by the question text, values are option labels (comma-joined for multiSelect) or free text. */
  z.object({ type: z.literal('question_response'), requestId: z.string().min(1), answers: z.record(z.string().max(2000), z.string().max(4000)) }),
  z.object({ type: z.literal('interrupt'), turnId: z.string().min(1) }),
  /** Stop one background task of a running turn (the rest of the turn keeps going). */
  z.object({ type: z.literal('stop_task'), turnId: z.string().min(1), taskId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('open_session'), sessionId: z.string().min(1) }),
  /** D6: a pane closed this session; stop routing its turn events to this socket. */
  z.object({ type: z.literal('close_session'), sessionId: z.string().min(1) }),
  /** After a reconnect: keep receiving a running turn this tab started (e.g. a new session with no id yet). */
  z.object({ type: z.literal('watch_turn'), turnId: z.string().min(1) }),
  z.object({ type: z.literal('refresh_index') }),
  /** Pin a Claude session to an account (null = 자동); persisted, applied from the next turn, broadcast as `account_pin`. */
  z.object({ type: z.literal('set_account_pin'), sessionId: z.string().min(1), pin: z.enum(['a', 'b', 'c']).nullable() }),
  /** 자동 승인 toggle (server-wide, persisted, broadcast to every device as `settings`). */
  z.object({ type: z.literal('set_settings'), autoApprove: z.boolean() }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Server-wide settings. autoApprove (자동 승인): Claude tool calls run without a card; new GPT sessions default to workspace-write. */
export type DeckSettings = { autoApprove: boolean };

/** gemini-cli present, and which accounts have an OAuth file (existence only; the UI shows "로그인 필요" otherwise). */
export type GeminiStatus = { available: boolean; loggedIn: Record<GeminiAccount, boolean> };

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
export type SessionActivity = { sessionId: string; cwd: string; turnId: string; running: boolean; bg: number; forMs: number };

/** Review I3: every turn-scoped message says which session (null = new, not yet known) and cwd it belongs to. */
type TurnScope = { turnId: string; sessionId: string | null; cwd: string };

export type ServerMessage =
  /** F2: `pins` = pinned session ids in pin order (optional only for older test literals). */
  /** `desktop` = recent Claude Desktop sessions (optional only for older test literals). */
  | { type: 'hello'; usage: UsageSnapshot; projects: ProjectEntry[]; pins?: string[]; desktop?: DesktopSession[]; settings?: DeckSettings; running: RunningTurn[]; activity?: SessionActivity[]; codex: { available: boolean }; gemini?: GeminiStatus; /** UI build id of the serving deck (null in dev); a changed id on reconnect means a new UI is out. */ build?: string | null }
  | { type: 'settings'; settings: DeckSettings }
  /** A session's account pin changed (null = 자동). */
  | { type: 'account_pin'; sessionId: string; pin: Account | null }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'index'; projects: ProjectEntry[]; pins?: string[]; desktop?: DesktopSession[] }
  | { type: 'history'; sessionId: string; cwd: string; account: Seat | null; engine?: EngineKind; sandbox?: CodexSandbox | null; messages: TranscriptMessage[]; runningTurnId: string | null; /** Claude sessions: the pinned account (null = 자동). */ accountPin?: Account | null; /** The running turn's prompt (a device opening the session mid-turn shows it even before the transcript has it). */ runningPrompt?: TurnPrompt | null; /** How long the running turn has run (its elapsed timer on a device that opens it mid-turn). */ runningForMs?: number }
  | ({ type: 'turn_started'; account: Seat; model: AnyModel; reason: string; attempt: number; engine?: EngineKind; clientRef?: string; /** The user message that started this turn (absent for a background continuation); the sending pane already shows it. */ prompt?: TurnPrompt } & TurnScope)
  | ({ type: 'delta'; text: string } & TurnScope)
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
  /** A background task (run_in_background Bash, backgrounded agent) settled during the turn; drives a push, the UI ignores it. */
  | ({ type: 'task_done'; status: 'completed' | 'failed' | 'stopped'; summary: string; taskId?: string; toolUseId?: string | null; usage?: TaskUsage } & TurnScope)
  /** Live state of a task (subagent or background command): started, progress, status change. Latest wins per taskId. */
  | ({ type: 'task_update'; /** On a replay to a device that opened the session mid-turn: how long ago the task started. */ ageMs?: number } & TaskUpdate & TurnScope)
  /** The running turn's output so far (main conversation) and what it is doing now — the status row. */
  | ({ type: 'turn_progress'; outputTokens: number; phase: TurnPhase } & TurnScope)
  /** A subagent's own tool call / result, under the Agent call `parentToolUseId` (never in the main transcript). */
  | ({ type: 'sub_tool_call'; parentToolUseId: string; toolUseId: string; name: string; input: unknown } & TurnScope)
  | ({ type: 'sub_tool_result'; parentToolUseId: string; toolUseId: string; isError: boolean } & TurnScope)
  | { type: 'activity'; sessions: SessionActivity[] }
  | ({ type: 'turn_retry'; fromAccount: Account; toAccount: Account; reason: string; attempt: number } & TurnScope)
  /**
   * Background tasks (Agent run_in_background, background Bash) live in the turn's process, one
   * description each; [] = none left. While non-empty the process stays open after the turn's
   * result; a finished task's continuation arrives as a new turn (reason 백그라운드 계속).
   * `turnId` names the turn the work belongs to (interrupt it to stop the work).
   */
  | ({ type: 'turn_background'; tasks: string[]; /** Per task: id (for stop_task), type, age. */ detail?: BgTaskInfo[]; /** stop_task works for this turn. */ canStop?: boolean } & TurnScope)
  | ({ type: 'turn_result'; ok: boolean; text: string; badge: TurnBadge | null; errorText: string | null } & TurnScope)
  | { type: 'error'; turnId: string | null; message: string; clientRef?: string };
