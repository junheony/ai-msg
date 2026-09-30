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
    cwd: z.string().min(1),
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

export type ServerMessage =
  | { type: 'hello'; usage: UsageSnapshot; projects: ProjectEntry[] }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'index'; projects: ProjectEntry[] }
  | { type: 'history'; sessionId: string; cwd: string; account: Account | null; messages: TranscriptMessage[] }
  | { type: 'turn_started'; turnId: string; sessionId: string | null; cwd: string; account: Account; model: ClaudeModel; reason: string; attempt: number }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'tool_call'; turnId: string; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; turnId: string; toolUseId: string; content: string; isError: boolean }
  | { type: 'permission_request'; turnId: string; requestId: string; toolName: string; input: unknown }
  | { type: 'permission_resolved'; requestId: string; decision: PermissionDecision }
  | { type: 'turn_retry'; turnId: string; fromAccount: Account; toAccount: Account; reason: string; attempt: number }
  | { type: 'turn_result'; turnId: string; sessionId: string; ok: boolean; text: string; badge: TurnBadge | null; errorText: string | null }
  | { type: 'error'; turnId: string | null; message: string };
