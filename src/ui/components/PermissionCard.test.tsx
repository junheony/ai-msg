// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CARD_PENDING_RESET_MS, PermissionCard, dangerSpans } from './PermissionCard';
import type { PendingPermission } from '../state';

const bashReq: PendingPermission = { turnId: 't', sessionId: 's1', cwd: '/w', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' };

describe('PermissionCard', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows the tool and input and emits the three decisions', () => {
    const onDecide = vi.fn();
    const rmReq: PendingPermission = { turnId: 't', sessionId: 's1', cwd: '/w/proj', requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf build' }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' };
    const { rerender } = render(<PermissionCard req={rmReq} onDecide={onDecide} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText(/rm -rf build/)).toBeTruthy();
    // The folder name only (full path in the tooltip); no session id.
    expect(screen.getByTestId('permission-scope').textContent).toBe('proj');
    expect(screen.getByTestId('permission-scope').getAttribute('title')).toBe('/w/proj');
    // A tap locks the card until the request changes, so each decision gets its own request id.
    fireEvent.click(screen.getByText('허용 1회'));
    rerender(<PermissionCard req={{ ...rmReq, requestId: 'r2' }} onDecide={onDecide} />);
    fireEvent.click(screen.getByText('이 세션 동안 허용'));
    rerender(<PermissionCard req={{ ...rmReq, requestId: 'r3' }} onDecide={onDecide} />);
    fireEvent.click(screen.getByText('거부'));
    expect(onDecide.mock.calls).toEqual([['r1', 'once'], ['r2', 'session'], ['r3', 'deny']]);
  });

  it('shows the SDK title, reason and blocked path; hides 이 세션 when not offered; defaultToNo focuses 거부', () => {
    render(<PermissionCard req={{ turnId: 't', sessionId: null, cwd: '/w', requestId: 'r2', toolName: 'Bash', input: {}, title: 'Claude wants to run rm', decisionReason: 'dangerous', blockedPath: '/etc/hosts', defaultToNo: true, allowSession: false, sessionLabel: null }} onDecide={() => {}} />);
    expect(screen.getByText('Claude wants to run rm')).toBeTruthy();
    expect(screen.getByText(/dangerous/)).toBeTruthy();
    expect(screen.getByText(/\/etc\/hosts/)).toBeTruthy();
    expect(screen.queryByText('이 세션 동안 허용')).toBeNull();
    expect(screen.queryByTestId('session-rule')).toBeNull();
    expect(document.activeElement?.textContent).toBe('거부');
  });

  it('keeps a long session rule out of the button: short label, the rule only in its tooltip', () => {
    const long = `git -C /Users/alice/Documents/작업/acme-worktree log --oneline --decorate --graph --all -n 200 ${'x'.repeat(300)}`;
    const label = `이 세션 동안 \`Bash(${long})\` 허용`;
    render(<PermissionCard req={{ turnId: 't', sessionId: 's1', cwd: '/w', requestId: 'r3', toolName: 'Bash', input: { command: long }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: label }} onDecide={() => {}} />);
    const btn = screen.getByRole('button', { name: '이 세션 동안 허용' });
    expect(btn.textContent).toBe('이 세션 동안 허용');
    expect(btn.getAttribute('title')).toBe(label);
    expect(btn.className).toContain('session-allow');
    expect(screen.queryByTestId('session-rule')).toBeNull();
    // All three decisions share one actions row (wraps + right-aligns via CSS).
    const actions = btn.parentElement!;
    expect(actions.className).toBe('permission-actions');
    expect([...actions.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['거부', '이 세션 동안 허용', '허용 1회']);
  });

  it('clicking 허용 1회 disables the buttons and shows 보내는 중…', () => {
    const onDecide = vi.fn();
    render(<PermissionCard req={bashReq} onDecide={onDecide} />);
    fireEvent.click(screen.getByText('허용 1회'));
    expect(onDecide.mock.calls).toEqual([['r1', 'once']]);
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('보내는 중…');
    expect(buttons[0]!.parentElement!.className).toBe('permission-actions sending');
    // A second tap on the disabled button must not send again.
    fireEvent.click(screen.getByText('허용 1회'));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it('the buttons come back after 8 s without a resolution', () => {
    vi.useFakeTimers();
    render(<PermissionCard req={bashReq} onDecide={() => {}} />);
    fireEvent.click(screen.getByText('거부'));
    act(() => { vi.advanceTimersByTime(CARD_PENDING_RESET_MS - 1); });
    expect((screen.getByText('거부') as HTMLButtonElement).disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect((screen.getByText('거부') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a new requestId resets the pending state', () => {
    const { rerender } = render(<PermissionCard req={bashReq} onDecide={() => {}} />);
    fireEvent.click(screen.getByText('허용 1회'));
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(<PermissionCard req={{ ...bashReq, requestId: 'r9' }} onDecide={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByText('허용 1회') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Bash: the description line and `$ command` instead of JSON; risky words underlined; raw JSON under 자세히', () => {
    const cmd = 'npm run db:migrate -- --env=staging && rm -rf ./tmp/cache';
    render(<PermissionCard req={{ ...bashReq, input: { command: cmd, description: '스테이징 DB 마이그레이션 후 캐시 정리' } }} onDecide={() => {}} />);
    expect(screen.getByText('스테이징 DB 마이그레이션 후 캐시 정리')).toBeTruthy();
    const pre = screen.getByTestId('permission-cmd');
    expect(pre.textContent).toBe(`$ ${cmd}`);
    expect(screen.getAllByTestId('danger-token').map((e) => e.textContent)).toEqual(['rm -rf']);
    const raw = screen.getByText('자세히').closest('details')!;
    expect(raw.open).toBe(false);
    expect(raw.querySelector('pre')!.textContent).toContain('"command"');
    expect(pre.textContent).not.toContain('"command"');
  });

  it('other tools: key · value rows instead of JSON', () => {
    render(<PermissionCard req={{ ...bashReq, toolName: 'WebFetch', input: { url: 'https://example.com', prompt: 'summarize', skip: null } }} onDecide={() => {}} />);
    const kv = screen.getByTestId('permission-kv');
    expect([...kv.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['url', 'prompt']);
    expect([...kv.querySelectorAll('dd')].map((d) => d.textContent)).toEqual(['https://example.com', 'summarize']);
    expect(screen.queryByTestId('permission-cmd')).toBeNull();
  });

  it('the allow button is the accent primary; the buttons share one row', () => {
    render(<PermissionCard req={bashReq} onDecide={() => {}} />);
    expect(screen.getByText('허용 1회').className).toBe('btn primary');
  });
});

describe('dangerSpans', () => {
  it('marks a small list of risky shell words and keeps the rest as is', () => {
    const marked = (c: string) => dangerSpans(c).filter((s) => s.danger).map((s) => s.text);
    expect(marked('sudo rm -rf / && git push --force origin main')).toEqual(['sudo', 'rm -rf', 'git push', '--force']);
    expect(marked('git reset --hard HEAD~1; git clean -fd; rm -r build')).toEqual(['git reset --hard', 'git clean -fd', 'rm -r']);
    expect(marked('ls -la && npm test && git status')).toEqual([]);
    expect(marked('npm run x --force-color')).toEqual([]);
    const c = 'echo hi; sudo ls';
    expect(dangerSpans(c).map((s) => s.text).join('')).toBe(c);
  });
});
