import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { hookHandler } from './hooks';
import { toolAudit } from './stream';
import { COMMANDER_ASK_MESSAGE, COMMANDER_GATE_FAILED_MESSAGE, NO_TOOLS_MESSAGE, PLAN_GATE_MESSAGE } from './texts';
import * as rules from '../../commander/rules';
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

describe('hookHandler PreToolUse — 총사령탑 자동 턴(commanderHop)', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const bash = (command: string, id = 'b1') => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  const mkc = (gate?: ModeGate) => {
    const gated: { toolName: string; toolUseId: string; decision: string; input: unknown }[] = [];
    const r = mk({ commanderHop: 1, onCommanderGate: async (e) => { gated.push(e); } }, gate);
    return { ...r, gated };
  };
  const ask = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: COMMANDER_ASK_MESSAGE } };
  const allow = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };

  it('without commanderHop Bash / mcp calls get no opinion (as before)', async () => {
    expect(await mk({}).h(bash('rm -rf /'), sig)).toEqual({});
    expect(await mk({}).h(pre('mcp__x__y'), sig)).toEqual({});
  });
  it('allowlisted Bash: allow; anything else: ask; each decision audited once with the tool use id', async () => {
    const { h, gated } = mkc();
    expect(await h(bash('npm test', 'a'), sig)).toEqual(allow);
    expect(await h(bash('npm test && git push', 'b'), sig)).toEqual(ask);
    expect(await h(pre('mcp__github__create_issue', 'c'), sig)).toEqual(ask);
    expect(gated.map((g) => [g.toolName, g.toolUseId, g.decision])).toEqual([['Bash', 'a', 'allow'], ['Bash', 'b', 'ask'], ['mcp__github__create_issue', 'c', 'ask']]);
  });
  it('edit tools keep the mode gate (no opinion when the mode did not change)', async () => {
    const { h, gated, gate } = mkc();
    expect(await h(pre('Write'), sig)).toEqual({});
    gate.mode = 'plan';
    expect(await h(pre('Edit'), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_GATE_MESSAGE } });
    expect(gated).toEqual([]);
  });
  it('보안 #2: any edit at all turns test runners and git into ask for the rest of the process; reads stay allowed', async () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const { h } = mkc();
      expect(await h(bash('npm test'), sig)).toEqual(allow);
      await h({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: '/w/src/a.test.ts', notebook_path: '/w/a.ipynb' }, tool_use_id: 'e1' }, sig);
      expect(await h(bash('npm test'), sig)).toEqual(ask);
      expect(await h(bash('npx vitest'), sig)).toEqual(ask);
      expect(await h(bash('git status'), sig)).toEqual(ask);
      expect(await h(bash('ls'), sig)).toEqual(allow);
    }
  });
  it('보안 #2: an edit under .claude/ or .git/ (or with no path) is ask, audited; the mode gate does not get to allow it', async () => {
    const { h, gated, gate } = mkc();
    gate.mode = 'acceptEdits';
    const edit = (tool: string, input: unknown, id: string) => h({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id }, sig);
    expect(await edit('Write', { file_path: '/w/.claude/settings.json' }, 'p1')).toEqual(ask);
    expect(await edit('Edit', { file_path: '/w/.git/hooks/pre-commit' }, 'p2')).toEqual(ask);
    expect(await edit('NotebookEdit', {}, 'p3')).toEqual(ask);
    expect(await edit('Edit', { file_path: '/w/src/a.ts' }, 'p4')).toEqual(allow);
    expect(gated.map((g) => [g.toolName, g.toolUseId, g.decision])).toEqual([['Write', 'p1', 'ask'], ['Edit', 'p2', 'ask'], ['NotebookEdit', 'p3', 'ask']]);
  });
  it('보안 #5: read-only tools pass with no opinion (not audited); any other tool, known or not, is ask', async () => {
    const { h, gated } = mkc();
    for (const t of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode']) expect(await h(pre(t), sig)).toEqual({});
    expect(gated).toEqual([]);
    for (const t of ['WebFetch', 'WebSearch', 'Agent', 'Task', 'KillShell', 'SomeFutureTool', '']) expect(await h(pre(t, t), sig)).toEqual(ask);
    expect(gated.map((g) => g.decision)).toEqual(Array(7).fill('ask'));
  });
  it('without commanderHop read-only / unknown tools are unchanged (no opinion)', async () => {
    for (const t of ['Read', 'WebFetch', 'SomeFutureTool']) expect(await mk({}).h(pre(t), sig)).toEqual({});
  });
  it('fail closed: a gate that throws denies (and is audited as deny)', async () => {
    vi.spyOn(rules, 'gateTool').mockImplementation(() => { throw new Error('boom'); });
    const { h, gated } = mkc();
    expect(await h(bash('ls'), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: COMMANDER_GATE_FAILED_MESSAGE } });
    expect(gated.map((g) => g.decision)).toEqual(['deny']);
  });
  it('a failing audit callback never changes the decision', async () => {
    const { h } = mk({ commanderHop: 2, onCommanderGate: async () => { throw new Error('disk'); } });
    expect(await h(bash('rm x'), sig)).toEqual(ask);
    expect(await h(bash('ls'), sig)).toEqual(allow);
  });
  it('noTools still wins over commanderHop', async () => {
    const { h } = mk({ noTools: true, commanderHop: 1 });
    expect(await h(bash('ls'), sig)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NO_TOOLS_MESSAGE } });
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
