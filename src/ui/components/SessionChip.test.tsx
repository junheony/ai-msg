// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ContextInfo } from '../context';
import { CLAUDE_MODELS } from '../../shared/models';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('a new session names folder · engine · default permission; the model is in the label and title, on the chip only when not 자동', () => {
    const { rerender } = render(<SessionChip {...base({ isNew: true, folder: 'repo', account: null, perm: null, defaultPerm: 'default', model: 'auto', effort: null })} />);
    const chip = screen.getByTestId('session-chip');
    expect(chip.getAttribute('aria-label')).toBe('세션 설정: repo · Claude · 모델 자동 · 묻기');
    expect(chip.getAttribute('title')).toContain('모델: 자동');
    expect(chip.textContent).not.toContain('자동');
    rerender(<SessionChip {...base({ isNew: true, folder: 'repo', account: null, perm: null, defaultPerm: 'default', model: 'opus', effort: null, engine: 'auto' })} />);
    expect(chip.textContent).toContain('엔진 자동');
    expect(chip.textContent).toContain('Opus 5.5');
    rerender(<SessionChip {...base({ isNew: true, folder: 'repo', account: null, perm: null, defaultPerm: null })} />);
    expect(chip.getAttribute('aria-label')).not.toContain('묻기');
  });

  it('Esc closes the sheet and focus returns to the chip, even with the model/account menus inside it', () => {
    render(<SessionChip {...base()} />);
    const chip = screen.getByTestId('session-chip');
    chip.focus();
    fireEvent.click(chip);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('↑/↓/Home/End move focus between the items of a menu in the sheet', () => {
    render(<SessionChip {...base()} />);
    fireEvent.click(screen.getByTestId('session-chip'));
    const items = within(screen.getByTestId('account-menu')).getAllByRole('menuitemradio');
    items[0]!.focus();
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('phone CSS: .task-add stays 44px after its base rule, the effort buttons get a 44px hit area, plan uses --link', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    const rule = '.task-add { width: var(--phone-tap); height: var(--phone-tap); padding: 0; }';
    expect(css.lastIndexOf(rule)).toBeGreaterThan(css.indexOf('padding: 0 10px; height: 32px'));
    expect(css).toMatch(/\.mp-effort button::after \{[^}]*height: var\(--phone-tap\)/);
    expect(css).not.toMatch(/perm-plan \{ color: #3b82f6/);
    expect(css).toMatch(/\.sc-perm\.perm-plan \{ color: var\(--link\)/);
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

describe('SessionChip · session switch', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  const Wrap = ({ id, mode }: { id: string; mode: 'default' | 'plan' }) => <SessionChip key={id} {...base({ perm: { mode, supported: true, onChange: vi.fn() } })} />;

  it('keyed by session: a different permission on the next session neither flashes nor announces, and the sheet is closed', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Wrap id="s1" mode="default" />);
    fireEvent.click(screen.getByTestId('session-chip'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    rerender(<Wrap id="s2" mode="plan" />);
    act(() => { vi.advanceTimersByTime(10); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('session-chip').className).not.toContain('flash');
    expect(screen.getByTestId('session-chip-said').textContent).toBe('');
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
