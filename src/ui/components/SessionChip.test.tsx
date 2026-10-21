// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ContextInfo } from '../context';
import { CLAUDE_MODELS } from '../../shared/models';
import { Chat } from './Chat';
import { SessionChip, type SessionChipProps } from './SessionChip';

Element.prototype.scrollIntoView = () => {};

const info = (cacheReadTokens: number): ContextInfo =>
  ({ usage: { inputTokens: 2_000, cacheReadTokens, cacheCreationTokens: 10_000 }, window: 1_000_000, at: Date.now(), model: 'opus', account: 'b' });

const base = (over: Partial<SessionChipProps> = {}): SessionChipProps => ({
  isNew: false, engine: 'claude', models: CLAUDE_MODELS, model: 'opus', effort: 'high', onModel: vi.fn(), onEffort: vi.fn(),
  account: { pin: null, current: 'a', usage: null, onPin: vi.fn() },
  perm: { mode: 'default', supported: true, onChange: vi.fn() },
  ...over,
});

describe('SessionChip', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('is one button that names model · account · permission and opens the 세션 설정 sheet (aria-haspopup / aria-expanded)', () => {
    render(<SessionChip {...base()} />);
    const chip = screen.getByTestId('session-chip');
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(chip.getAttribute('aria-label')).toBe('세션 설정: Opus 5.5 높음 · 계정: 자동 · A · 묻기');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const sheet = screen.getByRole('dialog', { name: '세션 설정' });
    expect(within(sheet).getByTestId('model-menu')).toBeTruthy();
    expect(within(sheet).getByTestId('account-menu')).toBeTruthy();
    expect(within(sheet).getByTestId('perm-select')).toBeTruthy();
    fireEvent.click(within(sheet).getByLabelText('닫기'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('a new session names folder · engine instead of the model', () => {
    render(<SessionChip {...base({ isNew: true, folder: 'repo', account: null })} />);
    expect(screen.getByTestId('session-chip').getAttribute('aria-label')).toBe('세션 설정: repo · Claude · 묻기');
  });

  it('a pick in the sheet reaches the handler, and the chip shows it once the props follow', () => {
    const p = base();
    const { rerender } = render(<SessionChip {...p} />);
    fireEvent.click(screen.getByTestId('session-chip'));
    const sheet = within(screen.getByRole('dialog'));
    fireEvent.click(within(sheet.getByTestId('model-menu')).getByText('Sonnet 5.5'));
    expect(p.onModel).toHaveBeenCalledWith('sonnet');
    fireEvent.click(within(sheet.getByTestId('account-menu')).getByText('B'));
    expect(p.account!.onPin).toHaveBeenCalledWith('b');
    fireEvent.change(sheet.getByTestId('perm-select'), { target: { value: 'acceptEdits' } });
    expect(p.perm!.onChange).toHaveBeenCalledWith('acceptEdits');
    rerender(<SessionChip {...p} model="sonnet" account={{ ...p.account!, pin: 'b' }} perm={{ ...p.perm!, mode: 'acceptEdits' }} />);
    expect(screen.getByTestId('session-chip').getAttribute('aria-label')).toBe('세션 설정: Sonnet 5.5 높음 · 계정: B 고정 · 편집 승인');
  });

  it('a permission change flashes the chip for 150ms and is announced; the first render does not flash', () => {
    vi.useFakeTimers();
    const p = base();
    const { rerender } = render(<SessionChip {...p} />);
    const chip = screen.getByTestId('session-chip');
    expect(chip.classList.contains('flash')).toBe(false);
    rerender(<SessionChip {...p} perm={{ ...p.perm!, mode: 'plan' }} />);
    expect(chip.classList.contains('flash')).toBe(true);
    expect(screen.getByTestId('session-chip-said').textContent).toBe('권한: 계획 모드');
    act(() => { vi.advanceTimersByTime(150); });
    expect(chip.classList.contains('flash')).toBe(false);
  });

  it('the context ring sits in the chip; the number shows outside only at ≥80%; the sheet carries the line and the handoff', () => {
    const onHandoff = vi.fn();
    const { rerender } = render(<SessionChip {...base({ ctx: info(300_000), onHandoff })} />);
    expect(within(screen.getByTestId('session-chip')).getByTestId('context-ring')).toBeTruthy();
    expect(screen.queryByTestId('context-out')).toBeNull();
    expect(screen.getByTestId('session-chip').getAttribute('aria-label')).toContain('컨텍스트 31%');
    rerender(<SessionChip {...base({ ctx: info(820_000), onHandoff })} />);
    expect(screen.getByTestId('context-out').textContent).toBe('83%');
    fireEvent.click(screen.getByTestId('session-chip'));
    expect(screen.getByTestId('context-line')).toBeTruthy();
    fireEvent.click(screen.getByTestId('handoff-btn'));
    expect(onHandoff).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('GPT: the chip names the sandbox; the sheet keeps the permission picker disabled', () => {
    render(<SessionChip {...base({ engine: 'codex', models: ['gpt-6-sol'], model: 'gpt-6-sol', effort: 'medium', account: null, sandbox: { value: 'read-only' }, perm: { mode: 'default', supported: false, onChange: vi.fn() } })} />);
    expect(screen.getByTestId('session-chip').getAttribute('aria-label')).toBe('세션 설정: GPT-6.1-Sol 중간 · 읽기 전용');
    fireEvent.click(screen.getByTestId('session-chip'));
    expect((screen.getByTestId('perm-select') as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('Chat · Shift+Tab', () => {
  afterEach(cleanup);

  it('Shift+Tab in the composer cycles the permission mode without opening the sheet', () => {
    const onPermMode = vi.fn();
    render(<Chat items={[]} pending={[]} questions={[]} activeTurnId={null} busy={false} title="t" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine="claude" sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={() => {}} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} permMode="default" onPermMode={onPermMode} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/메시지/), { key: 'Tab', shiftKey: true });
    expect(onPermMode).toHaveBeenCalledTimes(1);
    expect(onPermMode.mock.calls[0]![0]).not.toBe('default');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
