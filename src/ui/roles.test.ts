import { describe, expect, it } from 'vitest';
import { roleStatus, roleSummary } from './roles';

const call = (name: string, input: unknown) => ({ toolUseId: 'x', name, input, result: null, isError: false });

describe('roleSummary (D9)', () => {
  it('lists Agent/Task calls with subagent type and model, and Bash offload invocations with model / cross', () => {
    const roles = roleSummary([
      call('Agent', { subagent_type: 'explore', model: 'sonnet', description: 'find auth', prompt: '…' }),
      call('Task', { description: 'review', prompt: '…' }),
      call('Bash', { command: 'offload -m fable "review the design"' }),
      call('Bash', { command: '/Users/alice/bin/offload cross "decide"' }),
      call('Bash', { command: 'offload status' }),
      call('Bash', { command: 'git status && offload -m opus x' }),
      call('Read', { file_path: '/x' }),
    ]);
    expect(roles).toEqual([
      { kind: 'agent', toolUseId: 'x', type: 'explore', model: 'sonnet', description: 'find auth', isError: false, pending: true },
      { kind: 'agent', toolUseId: 'x', type: 'general', model: null, description: 'review', isError: false, pending: true },
      { kind: 'offload', toolUseId: 'x', model: 'fable', cross: false, command: 'offload -m fable "review the design"', isError: false, pending: true },
      { kind: 'offload', toolUseId: 'x', model: null, cross: true, command: '/Users/alice/bin/offload cross "decide"', isError: false, pending: true },
    ]);
  });
});

describe('roleStatus', () => {
  const pending = { isError: false, pending: true };
  it('uses live agent status when given, otherwise the call itself', () => {
    expect(roleStatus(pending, true, 'failed')).toBe('failed');
    expect(roleStatus(pending, true)).toBe('running');
    expect(roleStatus(pending, false)).toBe('stopped');
    expect(roleStatus({ isError: true, pending: false }, false)).toBe('failed');
    expect(roleStatus({ isError: false, pending: false }, false)).toBe('completed');
  });
});
