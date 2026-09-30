// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PermissionCard } from './PermissionCard';

describe('PermissionCard', () => {
  it('shows the tool and input and emits the three decisions', () => {
    const onDecide = vi.fn();
    render(<PermissionCard req={{ turnId: 't', requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf build' } }} onDecide={onDecide} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText(/rm -rf build/)).toBeTruthy();
    fireEvent.click(screen.getByText('허용 1회'));
    fireEvent.click(screen.getByText('이 세션'));
    fireEvent.click(screen.getByText('거부'));
    expect(onDecide.mock.calls).toEqual([['r1', 'once'], ['r1', 'session'], ['r1', 'deny']]);
  });
});
