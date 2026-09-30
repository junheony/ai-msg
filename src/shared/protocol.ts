import { z } from 'zod';
import type { Account } from './accounts';
import type { ClaudeModel } from './models';
import type { ProjectEntry, TranscriptMessage } from './session-types';
import type { PermissionDecision, TurnUsage } from './turn-types';
import type { UsageSnapshot } from './usage-types';

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send'),
    sessionId: z.string().min(1).nullable(),
    // Review M8: absolute path, bounded; the server also checks it is an existing directory.
    cwd: z.string().min(1).max(4096).refine((c) => c.startsWith('/'), { message: 'cwd must be an absolute path' }),
    text: z.string().min(1).max(200_000),
    model: z.enum(['sonnet', 'opus', 'fable']).optional(),
  }),
  z.object({ type: z.literal('permission_response'), requestId: z.string().min(1), decision: z.enum(['once', 'session', 'deny']) }),
  z.object({ type: z.literal('interrupt'), turnId: z.string().min(1) }),
  z.object({ type: z.literal('open_session'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('refresh_index') }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type TurnBadge = { account: Account; model: ClaudeModel; reason: string; usage: TurnUsage; modelNote: string | null };

/** A turn in flight; sessionId is null for a new session until the CLI reports one. */
export type RunningTurn = { turnId: string; sessionId: string | null; cwd: string };

/** Review I3: every turn-scoped message says which session (null = new, not yet known) and cwd it belongs to. */
type TurnScope = { turnId: string; sessionId: string | null; cwd: string };

export type ServerMessage =
  | { type: 'hello'; usage: UsageSnapshot; projects: ProjectEntry[]; running: RunningTurn[] }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'index'; projects: ProjectEntry[] }
  | { type: 'history'; sessionId: string; cwd: string; account: Account | null; messages: TranscriptMessage[]; runningTurnId: string | null }
  | ({ type: 'turn_started'; account: Account; model: ClaudeModel; reason: string; attempt: number } & TurnScope)
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
      /** False when the SDK offered no scoped rule or set suppressAlwaysAllowRule: hide 이 세션. */
      allowSession: boolean;
    } & TurnScope)
  | { type: 'permission_resolved'; requestId: string; decision: PermissionDecision }
  /** Non-terminal note about a running turn (e.g. a refused session move). */
  | ({ type: 'turn_notice'; message: string } & TurnScope)
  | ({ type: 'turn_retry'; fromAccount: Account; toAccount: Account; reason: string; attempt: number } & TurnScope)
  | ({ type: 'turn_result'; ok: boolean; text: string; badge: TurnBadge | null; errorText: string | null } & TurnScope)
  | { type: 'error'; turnId: string | null; message: string };
