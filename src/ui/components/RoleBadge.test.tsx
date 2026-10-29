// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { RoleEntry } from '../roles';
import type { AgentInfo } from '../state';
import { AgentContext } from './Activity';
import { RoleBadge } from './RoleBadge';

const agent = (over: Partial<Extract<RoleEntry, { kind: 'agent' }>> = {}): RoleEntry => ({
  kind: 'agent', toolUseId: 'a1', type: 'explore', model: 'sonnet', description: 'find auth', isError: false, pending: true, ...over,
});
const offload = (): RoleEntry => ({
  kind: 'offload', toolUseId: 'o1', model: null, cross: true, command: 'offload cross "x"', isError: false, pending: false,
});

const info = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  taskId: 't', status: 'completed', description: 'find auth', subagentType: 'explore', backgrounded: false,
  startedAt: 0, endedAt: 1, usage: { totalTokens: 10, toolUses: 1, durationMs: 125_000 }, lastToolName: null, calls: [], ...over,
});

describe('RoleBadge', () => {
  afterEach(cleanup);

  it('stays a count until opened, then lists status, description, model, and elapsed', () => {
    const { getByRole, queryByTestId, getByTestId } = render(
      <AgentContext.Provider value={{ agents: { a1: info() }, bgLive: false, active: false }}>
        <RoleBadge roles={[agent({ pending: false }), offload()]} live={false} />
      </AgentContext.Provider>,
    );
    const toggle = getByRole('button');
    expect(toggle.textContent).toBe('서브에이전트 1 · offload 1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(queryByTestId('role-list')).toBeNull();
    fireEvent.click(toggle);
    const list = getByTestId('role-list');
    expect(list.textContent).toContain('explore');
    expect(list.textContent).toContain('find auth');
    expect(list.textContent).toContain('sonnet');
    expect(list.textContent).toContain('완료');
    expect(list.textContent).toContain('2:05');
    expect(list.textContent).toContain('offload cross');
    expect(list.textContent).toContain('완료');
    const rows = list.querySelectorAll('.role-row');
    expect(rows[1]!.querySelector('.role-elapsed')).toBeNull();
  });

  it('a live pending offload is running, and a failed agent is failed', () => {
    const { getByRole, getByTestId } = render(
      <RoleBadge roles={[agent({ isError: true, pending: false }), { ...offload(), pending: true, isError: false }]} live />,
    );
    fireEvent.click(getByRole('button'));
    const text = getByTestId('role-list').textContent ?? '';
    expect(text).toContain('실패');
    expect(text).toContain('실행 중');
  });
});
