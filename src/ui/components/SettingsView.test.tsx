// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AUTO_CONSENT_TEXT, ROTATION_CONSENT, SettingsView } from './SettingsView';

const noop = () => {};

describe('SettingsView 권한', () => {
  afterEach(cleanup);

  it('the 새 세션 기본 권한 select shows the default mode and changes it; hidden until the server says', () => {
    const onMode = vi.fn();
    const { rerender } = render(<SettingsView build={null} defaultPermMode={null} onDefaultPermMode={onMode} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByTestId('default-perm-select')).toBeNull();
    rerender(<SettingsView build={null} defaultPermMode="bypassPermissions" onDefaultPermMode={onMode} onOpenUsage={noop} onClose={noop} />);
    const sel = screen.getByTestId('default-perm-select') as HTMLSelectElement;
    expect(sel.value).toBe('bypassPermissions');
    fireEvent.change(sel, { target: { value: 'plan' } });
    expect(onMode).toHaveBeenCalledWith('plan');
  });
});

describe('SettingsView 자동 계정 선택', () => {
  afterEach(cleanup);

  it('two options (고르게 분산 / 리셋 임박 먼저 소진): shows the server value and sends a change; hidden until the server says', () => {
    const onPolicy = vi.fn();
    const { rerender } = render(<SettingsView build={null} routingPolicy={null} onRoutingPolicy={onPolicy} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByRole('group', { name: '자동 계정 선택' })).toBeNull();
    rerender(<SettingsView build={null} routingPolicy="balance" onRoutingPolicy={onPolicy} onOpenUsage={noop} onClose={noop} />);
    const balance = screen.getByRole('button', { name: '고르게 분산' });
    const drain = screen.getByRole('button', { name: '리셋 임박 먼저 소진' });
    expect(balance.getAttribute('aria-pressed')).toBe('true');
    expect(drain.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(drain);
    expect(onPolicy).toHaveBeenCalledWith('drain');
  });
});

describe('SettingsView 같은 벤더 계정 자동 순환', () => {
  afterEach(cleanup);
  const group = () => screen.getByRole('group', { name: '같은 벤더 계정 자동 순환' });
  const btn = (name: string) => Array.from(group().querySelectorAll('button')).find((b) => b.textContent === name) as HTMLButtonElement;

  it('hidden until the server says; turning it on asks for consent first, cancel sends nothing, agreeing sends true', () => {
    const on = vi.fn();
    const { rerender } = render(<SettingsView build={null} sameVendorRotation={null} onSameVendorRotation={on} claudeAccounts={3} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByRole('group', { name: '같은 벤더 계정 자동 순환' })).toBeNull();
    rerender(<SettingsView build={null} sameVendorRotation={false} onSameVendorRotation={on} claudeAccounts={3} onOpenUsage={noop} onClose={noop} />);
    expect(btn('끄기').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText(ROTATION_CONSENT)).toBeNull();
    fireEvent.click(btn('켜기'));
    expect(on).not.toHaveBeenCalled();
    expect(screen.getByText(ROTATION_CONSENT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByText(ROTATION_CONSENT)).toBeNull();
    expect(on).not.toHaveBeenCalled();
    fireEvent.click(btn('켜기'));
    fireEvent.click(screen.getByRole('button', { name: '동의하고 켜기' }));
    expect(on).toHaveBeenCalledWith(true);
    expect(screen.queryByText(ROTATION_CONSENT)).toBeNull();
  });

  it('turning it off needs no consent', () => {
    const on = vi.fn();
    render(<SettingsView build={null} sameVendorRotation onSameVendorRotation={on} claudeAccounts={2} onOpenUsage={noop} onClose={noop} />);
    expect(btn('켜기').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn('켜기'));
    expect(on).not.toHaveBeenCalled();
    fireEvent.click(btn('끄기'));
    expect(on).toHaveBeenCalledWith(false);
    expect(screen.queryByText(ROTATION_CONSENT)).toBeNull();
  });

  it('one Claude account: the switch is disabled and says why', () => {
    const on = vi.fn();
    render(<SettingsView build={null} sameVendorRotation={false} onSameVendorRotation={on} claudeAccounts={1} onOpenUsage={noop} onClose={noop} />);
    expect(btn('켜기').disabled).toBe(true);
    expect(btn('끄기').disabled).toBe(true);
    fireEvent.click(btn('켜기'));
    expect(screen.queryByText(ROTATION_CONSENT)).toBeNull();
    expect(on).not.toHaveBeenCalled();
    expect(screen.getByText(/Claude 계정이 1개라/)).toBeTruthy();
  });
});

describe('SettingsView 하이라이트', () => {
  afterEach(cleanup);

  it('the row shows only with onOpenHighlights (the server has the feature); a click closes Settings and opens it', () => {
    const { rerender } = render(<SettingsView build={null} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByRole('button', { name: '하이라이트' })).toBeNull();
    const onClose = vi.fn();
    const onOpen = vi.fn();
    rerender(<SettingsView build={null} onOpenUsage={noop} onOpenHighlights={onOpen} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '하이라이트' }));
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('SettingsView sheet', () => {
  afterEach(cleanup);

  it('shares the sheet with 사용량: a backdrop press closes, a press in the card does not', () => {
    const onClose = vi.fn();
    render(<SettingsView build={null} onOpenUsage={noop} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: '설정' });
    expect(dialog.className).toBe('sheet settings');
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsView 코드 줄바꿈', () => {
  afterEach(() => { cleanup(); localStorage.removeItem('deck.codeWrap'); });

  it('the 코드 줄바꿈 row flips the same deck.codeWrap switch the code blocks use', () => {
    render(<SettingsView build={null} onOpenUsage={noop} onClose={noop} />);
    const group = screen.getByText('코드 줄바꿈').closest('.settings-row') as HTMLElement;
    const on = Array.from(group.querySelectorAll('button')).find((b) => b.textContent === '줄바꿈')!;
    expect(on.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(on);
    expect(localStorage.getItem('deck.codeWrap')).toBe('1');
    expect(on.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('SettingsView 총사령탑', () => {
  afterEach(cleanup);

  it('hidden until the server says; shows its value and sends a change', () => {
    const on = vi.fn();
    const { rerender } = render(<SettingsView build={null} commanderEnabled={null} onCommanderEnabled={on} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByRole('group', { name: '총사령탑' })).toBeNull();
    rerender(<SettingsView build={null} commanderEnabled={false} onCommanderEnabled={on} onOpenUsage={noop} onClose={noop} />);
    const group = screen.getByRole('group', { name: '총사령탑' });
    const btn = (name: string) => Array.from(group.querySelectorAll('button')).find((b) => b.textContent === name) as HTMLButtonElement;
    expect(btn('끄기').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn('끄기'));
    expect(on).not.toHaveBeenCalled();
    fireEvent.click(btn('켜기'));
    expect(on).toHaveBeenCalledWith(true);
  });
});

describe('SettingsView 자동 분배', () => {
  afterEach(cleanup);
  const view = { autoEngines: ['claude', 'codex', 'gemini', 'grok'] as const, autoConsent: [] as const, grokFast: false };

  it('four engine checkboxes; unchecking sends the rest; hidden until the server says', () => {
    const on = vi.fn();
    const { rerender } = render(<SettingsView build={null} autoRoute={null} onAutoRoute={on} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByTestId('auto-engine-claude')).toBeNull();
    rerender(<SettingsView build={null} autoRoute={{ ...view, autoEngines: [...view.autoEngines], autoConsent: [] }} onAutoRoute={on} onOpenUsage={noop} onClose={noop} />);
    for (const e of ['claude', 'codex', 'gemini', 'grok']) expect((screen.getByTestId(`auto-engine-${e}`) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('auto-engine-codex'));
    expect(on).toHaveBeenLastCalledWith({ autoEngines: ['claude', 'gemini', 'grok'] });
    fireEvent.click(screen.getByTestId('auto-grok-fast'));
    expect(on).toHaveBeenLastCalledWith({ grokFast: true });
    expect(screen.getByText('Grok 빠른 모델 쓰기(2배 가격)')).toBeTruthy();
  });

  it('Gemini / Grok show 동의 필요 until consented; the consent card adds the engine to autoConsent', () => {
    const on = vi.fn();
    const { rerender } = render(<SettingsView build={null} autoRoute={{ autoEngines: ['claude', 'codex'], autoConsent: [], grokFast: false }} onAutoRoute={on} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByTestId('auto-consent-claude')).toBeNull();
    expect(screen.queryByTestId('auto-consent-codex')).toBeNull();
    expect(screen.queryByText(AUTO_CONSENT_TEXT)).toBeNull();
    fireEvent.click(screen.getByTestId('auto-consent-gemini'));
    expect(screen.getByText(AUTO_CONSENT_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '동의하고 Gemini 쓰기' }));
    expect(on).toHaveBeenLastCalledWith({ autoConsent: ['gemini'], autoEngines: ['claude', 'codex', 'gemini'] });
    expect(screen.queryByText(AUTO_CONSENT_TEXT)).toBeNull();
    // 취소 sends nothing
    fireEvent.click(screen.getByTestId('auto-consent-grok'));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(on).toHaveBeenCalledTimes(1);
    rerender(<SettingsView build={null} autoRoute={{ autoEngines: ['claude', 'codex', 'gemini'], autoConsent: ['gemini'], grokFast: false }} onAutoRoute={on} onOpenUsage={noop} onClose={noop} />);
    expect(screen.queryByTestId('auto-consent-gemini')).toBeNull();
    expect(screen.getByTestId('auto-consent-grok')).toBeTruthy();
  });
});
