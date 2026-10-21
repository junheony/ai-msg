// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AUTO_CONSENT_TEXT, ROTATION_CONSENT, SEG_MAX, SETTINGS_GROUPS, SettingsView } from './SettingsView';
import { DEFAULT_PREFS, PREFS_KEY } from '../prefs';

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
    const on = within(screen.getByRole('group', { name: '코드 줄바꿈' })).getByRole('button', { name: '줄바꿈' });
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

describe('SettingsView 간결 모드', () => {
  afterEach(() => { cleanup(); localStorage.clear(); });
  it('toggles conciseMode in prefs', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: true }));
    render(<SettingsView build={null} onOpenUsage={() => {}} onClose={() => {}} />);
    fireEvent.click(within(screen.getByRole('group', { name: '간결 모드' })).getByRole('button', { name: '끄기' }));
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).conciseMode).toBe(false);
  });
});

describe('SettingsView 4그룹', () => {
  afterEach(() => { cleanup(); localStorage.clear(); });
  const full = () => render(<SettingsView build="b42" defaultPermMode="default" onDefaultPermMode={noop} routingPolicy="balance" onRoutingPolicy={noop} sameVendorRotation={false} onSameVendorRotation={noop} claudeAccounts={2}
    commanderEnabled={false} onCommanderEnabled={noop} autoRoute={{ autoEngines: ['claude'], autoConsent: [], grokFast: false }} onAutoRoute={noop} grokLocked="tripwire" onGrokUnlock={noop} taskCap={2} onTaskCap={noop}
    onOpenUsage={noop} onOpenHighlights={noop} onClose={noop} />);
  const region = (name: string) => screen.getByRole('region', { name });

  it('화면 · 입력 · 권한·알림 · 계정, in that order, each row in its group; no 정보 section, the build on one line at the end', () => {
    full();
    const dialog = screen.getByRole('dialog', { name: '설정' });
    expect(within(dialog).getAllByRole('region').map((r) => r.getAttribute('aria-labelledby') && document.getElementById(r.getAttribute('aria-labelledby')!)!.textContent)).toEqual(['화면', '입력', '권한·알림', '계정']);
    expect(SETTINGS_GROUPS.map(([, n]) => n)).toEqual(['화면', '입력', '권한·알림', '계정']);
    for (const name of ['테마', '채팅 폭', '코드 줄바꿈', '간결 모드']) expect(within(region('화면')).getByRole('group', { name })).toBeTruthy();
    expect(within(region('화면')).getByRole('combobox', { name: '글자 크기' })).toBeTruthy();
    expect(within(region('입력')).getByRole('group', { name: 'Enter 동작' })).toBeTruthy();
    const perm = region('권한·알림');
    expect(within(perm).getByTestId('default-perm-select')).toBeTruthy();
    expect(within(perm).getByTestId('auto-engine-claude')).toBeTruthy();
    expect(within(perm).getByTestId('auto-grok-fast')).toBeTruthy();
    expect(within(perm).getByTestId('task-cap-select')).toBeTruthy();
    expect(within(perm).getByRole('group', { name: '총사령탑' })).toBeTruthy();
    expect(within(perm).getByRole('button', { name: '알림' })).toBeTruthy();
    const account = region('계정');
    expect(within(account).getByRole('group', { name: '자동 계정 선택' })).toBeTruthy();
    expect(within(account).getByRole('group', { name: '같은 벤더 계정 자동 순환' })).toBeTruthy();
    expect(within(account).getByRole('button', { name: '잠금 해제' })).toBeTruthy();
    expect(within(account).getByRole('button', { name: '사용량 보기' })).toBeTruthy();
    expect(within(account).getByRole('button', { name: '하이라이트' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '정보' })).toBeNull();
    expect(screen.getByTestId('settings-foot').textContent).toMatch(/^deck .* · 빌드 b42 · /);
    // The left list names the same four groups.
    expect(within(screen.getByRole('navigation', { name: '설정 그룹' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['화면', '입력', '권한·알림', '계정']);
  });

  it('a long note is one short line until 자세히; 접기 folds it again', () => {
    full();
    const long = /생각·도구 본문은 접어둡니다/;
    expect(screen.queryByText(long)).toBeNull();
    const more = within(region('화면')).getByRole('button', { name: '자세히' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getByText(long)).toBeTruthy();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(region('화면')).getByRole('button', { name: '접기' }));
    expect(screen.queryByText(long)).toBeNull();
  });

  it('segmented controls hold at most 3 choices: 글자 크기 (4) is a select that sets the pref', () => {
    full();
    for (const seg of Array.from(document.querySelectorAll('.seg'))) expect(seg.querySelectorAll('button').length).toBeLessThanOrEqual(SEG_MAX);
    expect(screen.queryByRole('group', { name: '글자 크기' })).toBeNull();
    const size = screen.getByRole('combobox', { name: '글자 크기' }) as HTMLSelectElement;
    expect(Array.from(size.options).map((o) => o.textContent)).toEqual(['작게', '보통', '크게', '아주 크게']);
    fireEvent.change(size, { target: { value: 'xlarge' } });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).fontSize).toBe('xlarge');
  });
});
