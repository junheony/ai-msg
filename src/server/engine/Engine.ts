import type { Account } from '../../shared/accounts';
import type { ClaudeModel } from '../../shared/models';
import type { PermissionDecision, TurnUsage } from '../../shared/turn-types';
import type { UsageWindow } from '../../shared/usage-types';

export type RateLimitSignal = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
};

export type EngineResult = {
  kind: 'result';
  sessionId: string | null;
  ok: boolean;
  text: string;
  usage: TurnUsage;
  /** The SDK's own error text (classifier input, review M4). */
  errorText: string | null;
  /** Tail of the CLI's stderr (≤ STDERR_MAX), display only — never classified. */
  stderr: string | null;
  /** SDKAssistantMessageError value when the SDK reported one (e.g. 'rate_limit', 'authentication_failed'). */
  errorKind: string | null;
  terminalReason: string | null;
};

export type EngineEvent =
  | { kind: 'init'; sessionId: string; model: string }
  | { kind: 'delta'; text: string }
  | { kind: 'tool_call'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'rate_limit'; info: RateLimitSignal }
  | { kind: 'compact' }
  | EngineResult;

export type PermissionRequest = { toolName: string; input: Record<string, unknown>; toolUseId: string };

export type TurnRequest = {
  account: Account;
  cwd: string;
  resumeSessionId: string | null;
  model: ClaudeModel;
  prompt: string;
  signal: AbortSignal;
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
};

export interface Engine {
  runTurn(req: TurnRequest): AsyncIterable<EngineEvent>;
}
