export type ClaudeModel = 'sonnet' | 'opus' | 'fable';

/** Spec §4.2: Haiku and Luna are never used. */
export const CLAUDE_MODELS: readonly ClaudeModel[] = ['sonnet', 'opus', 'fable'];

export const DEFAULT_MODEL: ClaudeModel = 'opus';

/**
 * D1: GPT models are gpt-6-sol (default) and gpt-6-astra. gpt-6-sol needs codex-cli >= 0.159
 * (0.146 was rejected with HTTP 400 "not supported when using Codex with a ChatGPT account").
 * Never luna, terra, gpt-5.x.
 */
export type CodexModel = 'gpt-6-sol' | 'gpt-6-astra';
export const CODEX_MODELS: readonly CodexModel[] = ['gpt-6-sol', 'gpt-6-astra'];
export const DEFAULT_CODEX_MODEL: CodexModel = 'gpt-6-sol';

export type AnyModel = ClaudeModel | CodexModel;

export const MODEL_LABEL: Record<AnyModel, string> = { sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', 'gpt-6-sol': 'GPT Sol', 'gpt-6-astra': 'GPT Astra' };

export function isClaudeModel(x: unknown): x is ClaudeModel {
  return x === 'sonnet' || x === 'opus' || x === 'fable';
}

export function isCodexModel(x: unknown): x is CodexModel {
  return x === 'gpt-6-sol' || x === 'gpt-6-astra';
}

/** Fable (7d) usage at or above this is not Fable-eligible (routing) and downgrades to Opus (model policy). */
export const FABLE_MAX_PCT = 80;

/** Spec §4.3: the engine is fixed per session; 'auto' is resolved once when the session is created. */
export type EngineKind = 'claude' | 'codex';
export type EngineChoice = EngineKind | 'auto';

/** D2: codex exec cannot relay approvals, so the sandbox is the guard. Never danger-full-access. */
export type CodexSandbox = 'read-only' | 'workspace-write';
export const CODEX_SANDBOXES: readonly CodexSandbox[] = ['read-only', 'workspace-write'];
export const DEFAULT_SANDBOX: CodexSandbox = 'read-only';
/** 자동 승인 on: new GPT sessions default to workspace-write (network stays off, approval never). */
export function defaultSandbox(autoApprove: boolean): CodexSandbox {
  return autoApprove ? 'workspace-write' : DEFAULT_SANDBOX;
}
export const SANDBOX_LABEL: Record<CodexSandbox, string> = { 'read-only': '읽기 전용', 'workspace-write': '작업폴더 쓰기(네트워크 차단)' };
