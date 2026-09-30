import type { ClaudeModel } from '../../shared/models';

/** Values for Options.model. Verified 2026-09-30: sonnet→claude-sonnet-5-5, opus→claude-opus-5-5, fable→claude-fable-5-1. */
export const MODEL_ARG: Record<ClaudeModel, string> = { sonnet: 'sonnet', opus: 'opus', fable: 'fable' };

export const FABLE_MAX_PCT = 80;

export function resolveModel(
  requested: ClaudeModel | undefined,
  sessionDefault: ClaudeModel,
  fableUsedPct: number | null,
): { model: ClaudeModel; downgraded: boolean; note: string | null } {
  const wanted = requested ?? sessionDefault;
  if (wanted !== 'fable') return { model: wanted, downgraded: false, note: null };
  if (fableUsedPct === null) return { model: 'opus', downgraded: true, note: 'Fable 잔여량 불명 → Opus 로 대체' };
  if (fableUsedPct >= FABLE_MAX_PCT) return { model: 'opus', downgraded: true, note: `Fable ${fableUsedPct}% 이상 → Opus 로 대체` };
  return { model: 'fable', downgraded: false, note: null };
}
