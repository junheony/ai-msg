// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PermissionCard } from './PermissionCard';

describe('PermissionCard', () => {
  afterEach(cleanup);

  it('shows the tool and input and emits the three decisions', () => {
    const onDecide = vi.fn();
    render(<PermissionCard req={{ turnId: 't', sessionId: 's1', cwd: '/w/proj', requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf build' }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' }} onDecide={onDecide} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText(/rm -rf build/)).toBeTruthy();
    expect(screen.getByTestId('permission-scope').textContent).toContain('/w/proj');
    expect(screen.getByTestId('permission-scope').textContent).toContain('s1');
    fireEvent.click(screen.getByText('허용 1회'));
    fireEvent.click(screen.getByText('이 세션 동안 `Bash(ls)` 허용'));
    fireEvent.click(screen.getByText('거부'));
    expect(onDecide.mock.calls).toEqual([['r1', 'once'], ['r1', 'session'], ['r1', 'deny']]);
  });

  it('shows the SDK title, reason and blocked path; hides 이 세션 when not offered; defaultToNo focuses 거부', () => {
    render(<PermissionCard req={{ turnId: 't', sessionId: null, cwd: '/w', requestId: 'r2', toolName: 'Bash', input: {}, title: 'Claude wants to run rm', decisionReason: 'dangerous', blockedPath: '/etc/hosts', defaultToNo: true, allowSession: false, sessionLabel: null }} onDecide={() => {}} />);
    expect(screen.getByText('Claude wants to run rm')).toBeTruthy();
    expect(screen.getByText(/dangerous/)).toBeTruthy();
    expect(screen.getByText(/\/etc\/hosts/)).toBeTruthy();
    expect(screen.queryByText('이 세션')).toBeNull();
    expect(document.activeElement?.textContent).toBe('거부');
  });
});
