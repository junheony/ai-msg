// src/server/engine/claudeCli/permissions.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { permissionHandler, SessionGrants, synthesizedSuggestions, type ModeGate } from './permissions';
import { toolAudit } from './stream';
import { KEEP_PLANNING_MESSAGE, NO_TOOLS_MESSAGE, SELF_CALL_MESSAGE } from './texts';
import type { PermissionUpdate } from './permissionTypes';

const sig = new AbortController().signal;
const gate = (mode: ModeGate['mode'] = 'default'): ModeGate => ({ mode, startedIn: mode });
const mk = (req: Parameters<typeof permissionHandler>[0], g = gate(), grants = new SessionGrants()) => {
  const audited: unknown[] = [];
  const audit = toolAudit({ onToolAudit: async (e) => { audited.push(e); } });
  return { h: permissionHandler(req, audit, g, grants), audit, audited, g, grants };
};
const bashSuggestion: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];

describe('permissionHandler', () => {
  it('allow returns updatedInput = input; the call is marked handled (no duplicate audit)', async () => {
    const { h, audit } = mk({ onPermission: async () => 'once' });
    expect(await h({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(audit.handled.has('t1')).toBe(true);
  });
  it('deny → Korean message', async () => {
    const { h } = mk({ onPermission: async () => 'deny' });
    expect(await h({ tool_name: 'Bash', input: {}, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'deny', message: '사용자가 거부했습니다' });
  });
  it('passes suggestions and the abort signal to onPermission', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    await h({ tool_name: 'Bash', input: {}, tool_use_id: 't1', permission_suggestions: bashSuggestion }, sig);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'Bash', toolUseId: 't1', suggestions: bashSuggestion, signal: sig, suppressAlwaysAllowRule: false }));
  });
  it('session → updatedPermissions rewritten to destination session, and remembered for this process', async () => {
    const onPermission = vi.fn(async () => 'session' as const);
    const { h } = mk({ onPermission });
    const r = await h({ tool_name: 'Bash', input: {}, tool_use_id: 't1', permission_suggestions: bashSuggestion }, sig);
    expect(r).toEqual({ behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }] });
    const again = await h({ tool_name: 'Bash', input: {}, tool_use_id: 't2', permission_suggestions: bashSuggestion }, sig);
    expect(again).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(onPermission).toHaveBeenCalledTimes(1);
  });
  it('a call covered by a session grant is left to the stream audit (source cli)', async () => {
    const { h, audit } = mk({ onPermission: async () => 'session' });
    await h({ tool_name: 'Bash', input: {}, tool_use_id: 't1', permission_suggestions: bashSuggestion }, sig);
    await h({ tool_name: 'Bash', input: {}, tool_use_id: 't2', permission_suggestions: bashSuggestion }, sig);
    expect(audit.handled.has('t2')).toBe(false);
  });
  it('autoApprove allows at once and reports it', async () => {
    const onAutoApproved = vi.fn(async () => {});
    const onPermission = vi.fn(async () => 'deny' as const);
    const { h } = mk({ onPermission, autoApprove: () => true, onAutoApproved });
    expect(await h({ tool_name: 'Write', input: { a: 1 }, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'allow', updatedInput: { a: 1 } });
    expect(onAutoApproved).toHaveBeenCalledOnce();
    expect(onPermission).not.toHaveBeenCalled();
  });
  it('noTools denies everything with the handoff text', async () => {
    const { h } = mk({ onPermission: async () => 'once', noTools: true });
    expect(await h({ tool_name: 'Read', input: {}, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'deny', message: NO_TOOLS_MESSAGE });
  });
  it('denies direct calls of deck’s own MCP tool', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    expect(await h({ tool_name: 'mcp__deck_bridge__permission', input: {}, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'deny', message: SELF_CALL_MESSAGE });
    expect(onPermission).not.toHaveBeenCalled();
  });
  it('ExitPlanMode: deny keeps planning; once → default; session → acceptEdits, and the gate follows', async () => {
    const g = gate('plan');
    const deny = mk({ onPermission: async () => 'deny' }, g);
    expect(await deny.h({ tool_name: 'ExitPlanMode', input: { plan: 'p' }, tool_use_id: 't1' }, sig)).toEqual({ behavior: 'deny', message: KEEP_PLANNING_MESSAGE });
    expect(g.mode).toBe('plan');
    const once = mk({ onPermission: async () => 'once' }, g);
    expect(await once.h({ tool_name: 'ExitPlanMode', input: { plan: 'p' }, tool_use_id: 't2' }, sig)).toEqual({ behavior: 'allow', updatedInput: { plan: 'p' }, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] });
    expect(g.mode).toBe('default');
    const g2 = gate('plan');
    const session = mk({ onPermission: async () => 'session' }, g2);
    await session.h({ tool_name: 'ExitPlanMode', input: {}, tool_use_id: 't3' }, sig);
    expect(g2.mode).toBe('acceptEdits');
  });
  it('AskUserQuestion: answers ride updatedInput; malformed or unanswered deny', async () => {
    const input = { questions: [{ question: 'Which color?', header: 'c', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] };
    const ok = mk({ onPermission: async () => 'deny', onQuestion: async () => ({ 'Which color?': 'Blue' }) });
    expect(await ok.h({ tool_name: 'AskUserQuestion', input, tool_use_id: 'q1' }, sig)).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which color?': 'Blue' } } });
    const none = mk({ onPermission: async () => 'deny', onQuestion: async () => null });
    expect(await none.h({ tool_name: 'AskUserQuestion', input, tool_use_id: 'q2' }, sig)).toEqual({ behavior: 'deny', message: '사용자가 답하지 않았습니다' });
    const onQuestionMalformed = vi.fn(async () => {});
    const bad = mk({ onPermission: async () => 'deny', onQuestionMalformed });
    expect(await bad.h({ tool_name: 'AskUserQuestion', input: { questions: [] }, tool_use_id: 'q3' }, sig)).toEqual({ behavior: 'deny', message: '질문 형식이 올바르지 않습니다' });
    expect(onQuestionMalformed).toHaveBeenCalledOnce();
  });
});

describe('permission fixtures (real CLI captures)', () => {
  const meta = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.meta.json`), 'utf8')) as Record<string, any>;
  it('D1/D3: call shape and allow-runs-the-tool', () => {
    const m = meta('permission-allow');
    expect(m.calls[0]).toMatchObject({ tool_name: 'Write' });
    expect(m.calls[0].tool_use_id).toMatch(/^toolu_/);
    expect(m.fileWritten).toBe(true);
  });
  it('D6: AskUserQuestion answers reach the model', () => {
    const frames = fs.readFileSync(path.join(__dirname, 'fixtures', 'ask.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(frames.find((f) => f.type === 'result').result).toContain('Blue');
  });
  it('D2 / D5 / D9 are recorded (values drive Task 5 and Task 8a decisions)', () => {
    expect(typeof meta('permission-session').calls.length).toBe('number');
    expect(Array.isArray(meta('plan-exit').calls)).toBe(true);
    expect(Array.isArray(meta('self-call').calls)).toBe(true);
  });
});

describe('permission suggestions when the CLI sends none (spike D3 negative)', () => {
  it('a request without permission_suggestions reaches onPermission with one synthesized session rule', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    await h({ tool_name: 'Write', input: { file_path: '/w/a.txt', content: 'x' }, tool_use_id: 't1' }, sig);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' }],
    }));
  });
  it('Bash: the synthesized rule carries the exact command as ruleContent', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    await h({ tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 't1' }, sig);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }],
    }));
  });
  it('a request with permission_suggestions is passed through unchanged', async () => {
    const onPermission = vi.fn(async () => 'once' as const);
    const { h } = mk({ onPermission });
    await h({ tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 't1', permission_suggestions: bashSuggestion }, sig);
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ suggestions: bashSuggestion }));
  });
  it('이 세션 on a synthesized suggestion is returned as updatedPermissions and remembered for the process', async () => {
    const onPermission = vi.fn(async () => 'session' as const);
    const { h } = mk({ onPermission });
    const r = await h({ tool_name: 'Write', input: {}, tool_use_id: 't1' }, sig);
    expect(r).toEqual({ behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' }] });
    expect(await h({ tool_name: 'Write', input: {}, tool_use_id: 't2' }, sig)).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(onPermission).toHaveBeenCalledTimes(1);
  });
  it('synthesizedSuggestions: ExitPlanMode gets none (it is answered with setMode)', () => {
    expect(synthesizedSuggestions('ExitPlanMode', {})).toBeUndefined();
    expect(synthesizedSuggestions('Bash', { command: 42 })).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]);
  });
});
