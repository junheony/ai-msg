import { z } from 'zod';
import type { Account, Seat } from './accounts';
import type { AnyModel, CodexSandbox, EngineKind } from './models';
import type { ProjectEntry, TranscriptMessage } from './session-types';
import type { PermissionDecision, Question, QuestionAnswers, TurnUsage } from './turn-types';
import type { UsageSnapshot } from './usage-types';

/** Attachment ids are the UUIDs POST /api/attachments returned (Task 6); nothing path-like is accepted. */
export const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_ATTACHMENTS_PER_TURN = 8;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send'),
    sessionId: z.string().min(1).nullable(),
    // Review M8: absolute path, bounded; the server also checks it is an existing directory.
    cwd: z.string().min(1).max(4096).refine((c) => c.startsWith('/'), { message: 'cwd must be an absolute path' }),
    text: z.string().min(1).max(200_000),
    model: z.enum(['sonnet', 'opus', 'fable', 'gpt-6-sol', 'gpt-6-astra']).optional(),
    /** New sessions only (D3): which engine opens the session. Ignored on resume — the stored engine wins. */
    engine: z.enum(['claude', 'codex', 'auto']).optional(),
    /** New Codex sessions only (D2). */
    sandbox: z.enum(['read-only', 'workspace-write']).optional(),
    attachments: z.array(z.string().regex(ATTACHMENT_ID)).max(MAX_ATTACHMENTS_PER_TURN).optional(),
  }),
  z.object({ type: z.literal('permission_response'), requestId: z.string().min(1), decision: z.enum(['once', 'session', 'deny']) }),
  /** D8: answers keyed by the question text, values are option labels (comma-joined for multiSelect) or free text. */
  z.object({ type: z.literal('question_response'), requestId: z.string().min(1), answers: z.record(z.string().max(2000), z.string().max(4000)) }),
  z.object({ type: z.literal('interrupt'), turnId: z.string().min(1) }),
  z.object({ type: z.literal('open_session'), sessionId: z.string().min(1) }),
  /** D6: a pane closed this session; stop routing its turn events to this socket. */
  z.object({ type: z.literal('close_session'), sessionId: z.string().min(1) }),
  /** After a reconnect: keep receiving a running turn this tab started (e.g. a new session with no id yet). */
  z.object({ type: z.literal('watch_turn'), turnId: z.string().min(1) }),
  z.object({ type: z.literal('refresh_index') }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type TurnBadge = { account: Seat; model: AnyModel; reason: string; usage: TurnUsage; modelNote: string | null };

/** A turn in flight; sessionId is null for a new session until the CLI reports one. */
export type RunningTurn = { turnId: string; sessionId: string | null; cwd: string };

/** Review I3: every turn-scoped message says which session (null = new, not yet known) and cwd it belongs to. */
type TurnScope = { turnId: string; sessionId: string | null; cwd: string };

export type ServerMessage =
  | { type: 'hello'; usage: UsageSnapshot; projects: ProjectEntry[]; running: RunningTurn[]; codex: { available: boolean } }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'index'; projects: ProjectEntry[] }
  | { type: 'history'; sessionId: string; cwd: string; account: Seat | null; engine?: EngineKind; sandbox?: CodexSandbox | null; messages: TranscriptMessage[]; runningTurnId: string | null }
  | ({ type: 'turn_started'; account: Seat; model: AnyModel; reason: string; attempt: number; engine?: EngineKind } & TurnScope)
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
  | ({ type: 'turn_retry'; fromAccount: Account; toAccount: Account; reason: string; attempt: number } & TurnScope)
  | ({ type: 'turn_result'; ok: boolean; text: string; badge: TurnBadge | null; errorText: string | null } & TurnScope)
  | { type: 'error'; turnId: string | null; message: string };
