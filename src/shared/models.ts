export type ClaudeModel = 'sonnet' | 'opus' | 'fable';

/** Spec §4.2: Haiku and Luna are never used. */
export const CLAUDE_MODELS: readonly ClaudeModel[] = ['sonnet', 'opus', 'fable'];

export const DEFAULT_MODEL: ClaudeModel = 'opus';

export const MODEL_LABEL: Record<ClaudeModel, string> = { sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

export function isClaudeModel(x: unknown): x is ClaudeModel {
  return x === 'sonnet' || x === 'opus' || x === 'fable';
}
