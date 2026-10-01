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

/**
 * Picker rows: exact versions. Claude names/ids from the SDK's `supportedModels()` (agent-sdk 0.3.285, account B,
 * 2026-10-01): opus → claude-opus-5-5 "Opus 5.5", sonnet → claude-sonnet-5-5 "Sonnet 5.5", claude-fable-5-1
 * "Fable 5.1". GPT names from codex-cli 0.159.2's ~/.codex/models_cache.json (display_name).
 */
export const MODEL_INFO: Record<AnyModel, { name: string; description: string }> = {
  opus: { name: 'Opus 5.5', description: '복잡한 작업과 일상 작업 모두에' },
  sonnet: { name: 'Sonnet 5.5', description: '간단한 작업에 가장 효율적' },
  fable: { name: 'Fable 5.1', description: '가장 어려운 문제용 · 주간 80% 넘으면 Opus 로' },
  'gpt-6-sol': { name: 'GPT-6-Sol', description: '코딩과 일상 작업의 주력 모델' },
  'gpt-6-astra': { name: 'GPT-6-Astra', description: '가장 까다로운 작업용 최상위 모델' },
};

/**
 * Reasoning effort, sent per turn. Claude: SDK `Options.effort` (sdk.d.ts `EffortLevel`
 * = 'low'|'medium'|'high'|'xhigh'|'max'). GPT: `codex exec -c model_reasoning_effort="…"` (models_cache
 * supported_reasoning_levels low…max, ultra). deck offers the four levels every listed model supports;
 * 'max'/'ultra' are left out on purpose.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh'];
export const EFFORT_LABEL: Record<Effort, string> = { low: '낮음', medium: '중간', high: '높음', xhigh: '엑스트라' };
/** Per model: every model in the lineup reports all four (supportedEffortLevels / supported_reasoning_levels). */
export const MODEL_EFFORTS: Record<AnyModel, readonly Effort[]> = { opus: EFFORTS, sonnet: EFFORTS, fable: EFFORTS, 'gpt-6-sol': EFFORTS, 'gpt-6-astra': EFFORTS };
export const DEFAULT_EFFORT: Record<'claude' | 'codex', Effort> = { claude: 'high', codex: 'medium' };

export function isEffort(x: unknown): x is Effort {
  return x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh';
}

/** The effort to send with `model`: the requested one if the model supports it, else null (engine default). */
export function effortFor(model: AnyModel, effort: Effort | undefined): Effort | null {
  return effort !== undefined && MODEL_EFFORTS[model].includes(effort) ? effort : null;
}

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
export const SANDBOX_LABEL: Record<CodexSandbox, string> = { 'read-only': '읽기 전용', 'workspace-write': '작업폴더 쓰기(네트워크 차단)' };
