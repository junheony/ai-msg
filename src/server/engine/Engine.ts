import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
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
  /** `cwd` is the CLI's own (realpath'd) working directory from system/init — the one it slugs. */
  | { kind: 'init'; sessionId: string; model: string; cwd?: string }
  | { kind: 'delta'; text: string }
  | { kind: 'tool_call'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'rate_limit'; info: RateLimitSignal }
  | { kind: 'compact' }
  | EngineResult;

/**
 * One canUseTool call. `signal` is the SDK's per-request abort signal (the prompt must close
 * when it fires); the rest is relayed from the SDK context when present (review I4).
 */
export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  signal?: AbortSignal;
  /** The scoped rules the SDK proposes for "don't ask again this session". */
  suggestions?: PermissionUpdate[];
  /** The rule 이 세션 would write is broader than this ask: offer no persistent choice. */
  suppressAlwaysAllowRule?: boolean;
  title?: string;
  decisionReason?: string;
  blockedPath?: string;
  defaultToNo?: boolean;
};

/** 이 세션 is offered only when the SDK suggested something scoped and did not forbid it. */
export function sessionAllowOffered(pr: Pick<PermissionRequest, 'suggestions' | 'suppressAlwaysAllowRule'>): boolean {
  return !pr.suppressAlwaysAllowRule && (pr.suggestions?.length ?? 0) > 0;
}

export type TurnRequest = {
  account: Account;
  cwd: string;
  resumeSessionId: string | null;
  model: ClaudeModel;
  prompt: string;
  signal: AbortSignal;
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** Rules (e.g. `Bash(git status)`) the user allowed for this deck session on earlier turns. */
  allowRules?: string[];
  /** Directories the user allowed for this deck session on earlier turns. */
  allowDirs?: string[];
};

export interface Engine {
  runTurn(req: TurnRequest): AsyncIterable<EngineEvent>;
}
