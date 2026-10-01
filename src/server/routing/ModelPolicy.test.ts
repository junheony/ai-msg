import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS, DEFAULT_MODEL, isClaudeModel } from '../../shared/models';
import { MODEL_ARG, resolveModel } from './ModelPolicy';

describe('models', () => {
  it('only sonnet/opus/fable exist; default is opus', () => {
    expect(CLAUDE_MODELS).toEqual(['sonnet', 'opus', 'fable']);
    expect(DEFAULT_MODEL).toBe('opus');
    expect(isClaudeModel('haiku')).toBe(false);
    expect(isClaudeModel('fable')).toBe(true);
    expect(MODEL_ARG).toEqual({ sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' });
  });
});

describe('resolveModel', () => {
  it('uses the request, else the session default', () => {
    expect(resolveModel('sonnet', 'opus', 0)).toEqual({ model: 'sonnet', downgraded: false, note: null });
    expect(resolveModel(undefined, 'opus', 0)).toEqual({ model: 'opus', downgraded: false, note: null });
  });

  it('downgrades fable to opus when the account Fable window is ≥80 or unknown', () => {
    expect(resolveModel('fable', 'opus', 79)).toEqual({ model: 'fable', downgraded: false, note: null });
    expect(resolveModel('fable', 'opus', 80)).toEqual({ model: 'opus', downgraded: true, note: 'Fable 80% 이상 → Opus 로 대체' });
    expect(resolveModel('fable', 'opus', null)).toEqual({ model: 'opus', downgraded: true, note: 'Fable 잔여량 불명 → Opus 로 대체' });
    expect(resolveModel(undefined, 'fable', 95).model).toBe('opus');
  });
});
