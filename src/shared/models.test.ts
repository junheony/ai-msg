import { describe, expect, it } from 'vitest';
import { CODEX_CLI_MODEL, CODEX_MODELS, MODEL_INFO, DEFAULT_CODEX_MODEL, DEFAULT_SANDBOX, MODEL_LABEL, SANDBOX_LABEL, defaultGeminiSandbox, isCodexModel, modelLabelOf } from './models';

describe('sandbox defaults (D2, 다 붙여)', () => {
  it('GPT: workspace-write with network is the default and says so; Gemini keeps plan unless 자동 승인', () => {
    expect(DEFAULT_SANDBOX).toBe('workspace-write');
    expect(SANDBOX_LABEL['workspace-write']).toBe('작업폴더 쓰기 · 네트워크');
    expect(defaultGeminiSandbox(false)).toBe('read-only');
    expect(defaultGeminiSandbox(true)).toBe('workspace-write');
  });
});

describe('codex models (D1)', () => {
  it('only sol and astra; sol is the default; luna/terra/5.5/gpt-5.6-sol are not models', () => {
    expect(CODEX_MODELS).toEqual(['gpt-6-sol', 'gpt-6-astra']);
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-6-sol');
    for (const bad of ['gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5', 'haiku']) expect(isCodexModel(bad)).toBe(false);
    expect(isCodexModel('gpt-6-astra')).toBe(true);
    expect(MODEL_LABEL['gpt-6-sol']).toBe('GPT Sol');
    expect(MODEL_LABEL.opus).toBe('Opus');
    expect(SANDBOX_LABEL['read-only']).toBe('읽기 전용');
  });

  it('Sol goes to the CLI as gpt-6.1-sol; the deck id stays gpt-6-sol', () => {
    expect(CODEX_CLI_MODEL).toEqual({ 'gpt-6-sol': 'gpt-6.1-sol', 'gpt-6-astra': 'gpt-6-astra' });
    expect(MODEL_INFO['gpt-6-sol'].name).toBe('GPT-6.1-Sol');
    expect(isCodexModel('gpt-6.1-sol')).toBe(false);
  });
});

describe('modelLabelOf (턴별 모델)', () => {
  it('deck aliases and Codex CLI slugs by MODEL_LABEL, Claude ids as family + version, others as they are', () => {
    expect(modelLabelOf('opus')).toBe('Opus');
    expect(modelLabelOf('gpt-6-sol')).toBe('GPT Sol');
    expect(modelLabelOf('gpt-6.1-sol')).toBe('GPT Sol');
    expect(modelLabelOf('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabelOf('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelLabelOf('claude-3-5-sonnet-20241022')).toBe('Sonnet');
    expect(modelLabelOf('claude-fable-1')).toBe('Fable 1');
    expect(modelLabelOf('some-model')).toBe('some-model');
  });
});

describe('Grok models', () => {
  it('two models, 4.6 by default; the CLI ids are the same names; 4.5 has no xhigh; 500k context; Grok accounts are x1 only', async () => {
    const m = await import('./models');
    const a = await import('./accounts');
    expect(m.GROK_MODELS).toEqual(['grok-4.6', 'grok-4.5']);
    expect(m.DEFAULT_GROK_MODEL).toBe('grok-4.6');
    expect(m.GROK_CLI_ALIAS).toEqual({ 'grok-4.6': 'grok-4.6', 'grok-4.5': 'grok-4.5' });
    expect(m.MODEL_LABEL['grok-4.6']).toBe('Grok 4.6');
    expect(m.MODEL_LABEL['grok-4.5']).toBe('Grok 4.5');
    expect(m.MODEL_EFFORTS['grok-4.5']).toEqual(['low', 'medium', 'high']);
    expect(m.DEFAULT_EFFORT.grok).toBe('high');
    expect(m.isGrokModel('grok-4.6')).toBe(true);
    expect(m.isGrokModel('grok')).toBe(false);
    expect(m.contextWindowOf('grok-4.5')).toBe(500_000);
    expect(a.GROK_ACCOUNTS).toEqual(['x1']);
    expect(a.isGrokAccount('x1')).toBe(true);
    expect(a.isGrokAccount('x2')).toBe(false);
    expect(a.GROK_LABEL.x1).toBe('X1');
  });
});
