import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { hookHandler } from './hooks';
import { toolAudit } from './stream';
import { NO_TOOLS_MESSAGE, PLAN_GATE_MESSAGE } from './texts';
import type { ModeGate } from './permissions';

const sig = new AbortController().signal;
const pre = (tool = 'Write', id = 't1') => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: '/w/a' }, tool_use_id: id });
const mk = (req: Parameters<typeof hookHandler>[0], gate: ModeGate = { mode: 'default', startedIn: 'default' }) => {
  const audited: { decision: string; source: string; toolUseId: string }[] = [];
  const audit = toolAudit({ onToolAudit: async (e) => { audited.push(e); } });
  return { h: hookHandler(req, audit, gate), audited, gate };
};

describe('hookHandler PreToolUse', () => {
  it('noTools: deny with the handoff text, audited once as deck', async () => {
    const { h, audited } = mk({ noTools: true });
    expect(await h(pre('Read'), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NO_TOOLS_MESSAGE } });
    await h(pre('Read'), sig);
    expect(audited).toEqual([expect.objectContaining({ decision: 'deny', source: 'deck', toolUseId: 't1' })]);
  });
  it('no mode change: no opinion', async () => {
    expect(await mk({}).h(pre(), sig)).toEqual({});
  });
  it('switched to plan mid-process: deny edits', async () => {
    const { h, gate } = mk({});
    gate.mode = 'plan';
    expect(await h(pre(), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_GATE_MESSAGE } });
  });
  it('switched to acceptEdits: allow edits without a card', async () => {
    const { h, gate } = mk({});
    gate.mode = 'acceptEdits';
    expect(await h(pre(), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  });
  it('started in acceptEdits, switched back to default: ask', async () => {
    const { h, gate } = mk({}, { mode: 'acceptEdits', startedIn: 'acceptEdits' });
    gate.mode = 'default';
    expect(await h(pre(), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } });
  });
  it('started in plan and still plan: left to the CLI', async () => {
    expect(await mk({}, { mode: 'plan', startedIn: 'plan' }).h(pre(), sig)).toEqual({});
  });
});

describe('hookHandler UserPromptSubmit', () => {
  it('adds the note to the first prompt only', async () => {
    const { h } = mk({ systemNote: 'NOTE' });
    const ev = { hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
    expect(await h(ev, sig)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'NOTE' } });
    expect(await h(ev, sig)).toEqual({});
  });
  it('no note: nothing', async () => {
    expect(await mk({}).h({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, sig)).toEqual({});
  });
});

describe('hook fixtures (real CLI captures)', () => {
  const frames = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.meta.json`), 'utf8'));
  it('E1: the relayed deny reached the model as an error tool result', () => {
    const results = frames('hooks').filter((f) => f.type === 'user').flatMap((f) => (Array.isArray(f.message.content) ? f.message.content : [])).filter((b: { type: string }) => b.type === 'tool_result');
    expect(results.some((b: { is_error?: boolean; content: unknown }) => b.is_error && JSON.stringify(b.content).includes('인계 메모'))).toBe(true);
  });
  it('E3: the note reached the model once', () => {
    expect(frames('hooks').find((f) => f.type === 'result').result).toContain('PAPAYA');
  });
  it('E4: no hook frames without --include-hook-events', () => {
    expect(frames('hooks').some((f) => f.type === 'system' && String(f.subtype).startsWith('hook_'))).toBe(false);
  });
  it('E2: ask routes to the prompt tool, allow skips it', () => {
    expect(meta('hook-ask').calls.map((c: { tool_name: string }) => c.tool_name)).toEqual(['Write']);
    expect(meta('hook-allow').calls).toEqual([]);
    expect(meta('hook-allow').fileWritten).toBe(true);
  });
});
