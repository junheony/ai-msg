// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AUTO_CONSENT_TEXT, EXPERIMENTAL_NOTICE, EXPERIMENTAL_ROWS, ROTATION_CONSENT, ROTATION_NOTICE, SEG_MAX, SETTINGS_GROUPS, SettingsView } from './SettingsView';
import { DEFAULT_PREFS, PREFS_KEY } from '../prefs';

const noop = () => {};

describe('SettingsView 권한', () => {
  afterEach(cleanup);

  it('the 새 세션 기본 권한 select shows the default mode and changes it; hidden until the server says', () => {
    const onMode = vi.fn();
    const { rerender } = render(<SettingsView build={null} defaultPermMode={null} onDefaultPermMode={onMode} onClose={noop} />);
    expect(screen.queryByTestId('default-perm-select')).toBeNull();
    rerender(<SettingsView build={null} defaultPermMode="bypassPermissions" onDefaultPermMode={onMode} onClose={noop} />);
    const sel = screen.getByTestId('default-perm-select') as HTMLSelectElement;
    expect(sel.value).toBe('bypassPermissions');
    fireEvent.change(sel, { target: { value: 'plan' } });
    expect(onMode).toHaveBeenCalledWith('plan');
  });

  it('the current mode is visible: a plain select beside its label (not hidden in a .pick), 모두 자동 승인 marked as a warning', () => {
    render(<SettingsView build={null} defaultPermMode="bypassPermissions" onDefaultPermMode={noop} onClose={noop} />);
    const sel = screen.getByRole('combobox', { name: '새 세션 기본 권한' }) as HTMLSelectElement;
    expect(sel.closest('.pick')).toBeNull();
    expect(sel.selectedOptions[0]!.textContent).toBe('모두 자동 승인');
    expect(sel.classList.contains('perm-bypassPermissions')).toBe(true);
    const row = sel.closest('.settings-row')!;
    expect(row.firstElementChild!.textContent).toBe('새 세션 기본 권한');
    expect(row.classList.contains('default-perm')).toBe(false);
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    const rule = css.match(/\.settings-row \.perm-select\.perm-bypassPermissions \{([^}]*)\}/)![1]!;
    expect(rule).toMatch(/color: var\(--danger\)/);
    expect(rule).not.toMatch(/opacity/);
  });
});

describe('SettingsView 자동 계정 선택', () => {
  afterEach(cleanup);

  it('two options (고르게 분산 / 리셋 임박 먼저 소진): shows the server value and sends a change; hidden until the server says', () => {
    const onPolicy = vi.fn();
    const { rerender } = render(<SettingsView build={null} routingPolicy={null} onRoutingPolicy={onPolicy} onClose={noop} />);
    expect(screen.queryByRole('group', { name: '자동 계정 선택' })).toBeNull();
    rerender(<SettingsView build={null} routingPolicy="balance" onRoutingPolicy={onPolicy} onClose={noop} />);
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
    const { rerender } = render(<SettingsView build={null} sameVendorRotation={null} onSameVendorRotation={on} claudeAccounts={3} onClose={noop} />);
    expect(screen.queryByRole('group', { name: '같은 벤더 계정 자동 순환' })).toBeNull();
    rerender(<SettingsView build={null} sameVendorRotation={false} onSameVendorRotation={on} claudeAccounts={3} onClose={noop} />);
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
    render(<SettingsView build={null} sameVendorRotation onSameVendorRotation={on} claudeAccounts={2} onClose={noop} />);
    expect(btn('켜기').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn('켜기'));
    expect(on).not.toHaveBeenCalled();
    fireEvent.click(btn('끄기'));
    expect(on).toHaveBeenCalledWith(false);
    expect(screen.queryByText(ROTATION_CONSENT)).toBeNull();
  });

  it('one Claude account: the switch is disabled and says why', () => {
    const on = vi.fn();
    render(<SettingsView build={null} sameVendorRotation={false} onSameVendorRotation={on} claudeAccounts={1} onClose={noop} />);
    expect(btn('켜기').disabled).toBe(true);
    expect(btn('끄기').disabled).toBe(true);
    fireEvent.click(btn('켜기'));
    expect(screen.queryByText(ROTATION_CONSENT)).toBeNull();
    expect(on).not.toHaveBeenCalled();
    expect(screen.getByText(/Claude 계정이 1개라/)).toBeTruthy();
  });
});

describe('SettingsView 실험적 기능', () => {
  afterEach(cleanup);
  const btn = (label: string, name: string) => Array.from(screen.getByRole('group', { name: label }).querySelectorAll('button')).find((b) => b.textContent === name) as HTMLButtonElement;
  const fresh = { grokBot: false, desktop: false, localImports: true };

  it('the notice always shows; the toggles wait for the server', () => {
    render(<SettingsView build={null} experimental={null} onExperimental={noop} onClose={noop} />);
    expect(screen.getByTestId('experimental-notice').textContent).toContain(EXPERIMENTAL_NOTICE);
    expect(screen.getByTestId('experimental-notice').textContent).toContain('실험적 · 비공식');
    for (const [, label] of EXPERIMENTAL_ROWS) expect(screen.queryByRole('group', { name: label })).toBeNull();
    expect(within(screen.getByRole('region', { name: '실험적 기능' })).getByText('서버 연결 후 표시됩니다.')).toBeTruthy();
  });

  it('each row shows its state and its one line; picking the other value sends only that key, the current one sends nothing', () => {
    const on = vi.fn();
    render(<SettingsView build={null} experimental={fresh} onExperimental={on} onClose={noop} />);
    for (const [, label, what] of EXPERIMENTAL_ROWS) {
      expect(screen.getByRole('group', { name: label })).toBeTruthy();
      expect(screen.getByText(what)).toBeTruthy();
    }
    expect(btn('Grok Bot 앱 대화·사용량', '끄기').getAttribute('aria-pressed')).toBe('true');
    expect(btn('Codex·Gemini 대화 가져오기', '켜기').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn('Grok Bot 앱 대화·사용량', '끄기'));
    expect(on).not.toHaveBeenCalled();
    fireEvent.click(btn('Grok Bot 앱 대화·사용량', '켜기'));
    expect(on).toHaveBeenLastCalledWith({ grokBot: true });
    fireEvent.click(btn('Claude Desktop 연동', '켜기'));
    expect(on).toHaveBeenLastCalledWith({ desktop: true });
    fireEvent.click(btn('Codex·Gemini 대화 가져오기', '끄기'));
    expect(on).toHaveBeenLastCalledWith({ localImports: false });
    expect(on).toHaveBeenCalledTimes(3);
  });

  it('two sub-groups, each with its own notice: the local-files one is not shown over 계정 순환', () => {
    render(<SettingsView build={null} experimental={fresh} onExperimental={noop} sameVendorRotation={false} onSameVendorRotation={noop} claudeAccounts={2} onClose={noop} />);
    const apps = screen.getByRole('group', { name: '다른 앱 연동' });
    const rotation = screen.getByRole('group', { name: '계정 순환' });
    expect(within(apps).getByTestId('experimental-notice').textContent).toContain(EXPERIMENTAL_NOTICE);
    for (const [, label] of EXPERIMENTAL_ROWS) expect(within(apps).getByRole('group', { name: label })).toBeTruthy();
    expect(within(rotation).getByTestId('rotation-notice').textContent).toBe(ROTATION_NOTICE);
    expect(within(rotation).queryByText(new RegExp(EXPERIMENTAL_NOTICE.slice(0, 10)))).toBeNull();
    expect(within(rotation).getByRole('group', { name: '같은 벤더 계정 자동 순환' })).toBeTruthy();
  });
});

describe('SettingsView 사용량·하이라이트', () => {
  afterEach(cleanup);

  it('no 사용량 보기 / 하이라이트 rows: the usage chip, the activity sheet and the palette are their way in', () => {
    render(<SettingsView build={null} onClose={noop} />);
    expect(screen.queryByRole('button', { name: '사용량 보기' })).toBeNull();
    expect(screen.queryByRole('button', { name: '하이라이트' })).toBeNull();
  });
});

describe('SettingsView sheet', () => {
  afterEach(cleanup);

  it('shares the sheet with 사용량: a backdrop press closes, a press in the card does not', () => {
    const onClose = vi.fn();
    render(<SettingsView build={null} onClose={onClose} />);
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
    render(<SettingsView build={null} onClose={noop} />);
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
    const { rerender } = render(<SettingsView build={null} commanderEnabled={null} onCommanderEnabled={on} onClose={noop} />);
    expect(screen.queryByRole('group', { name: '총사령탑' })).toBeNull();
    rerender(<SettingsView build={null} commanderEnabled={false} onCommanderEnabled={on} onClose={noop} />);
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
    const { rerender } = render(<SettingsView build={null} autoRoute={null} onAutoRoute={on} onClose={noop} />);
    expect(screen.queryByTestId('auto-engine-claude')).toBeNull();
    rerender(<SettingsView build={null} autoRoute={{ ...view, autoEngines: [...view.autoEngines], autoConsent: [] }} onAutoRoute={on} onClose={noop} />);
    for (const e of ['claude', 'codex', 'gemini', 'grok']) expect((screen.getByTestId(`auto-engine-${e}`) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('auto-engine-codex'));
    expect(on).toHaveBeenLastCalledWith({ autoEngines: ['claude', 'gemini', 'grok'] });
    fireEvent.click(screen.getByTestId('auto-grok-fast'));
    expect(on).toHaveBeenLastCalledWith({ grokFast: true });
    expect(screen.getByText('Grok 빠른 모델 쓰기(2배 가격)')).toBeTruthy();
  });

  it('Gemini / Grok show 동의 필요 until consented; the consent card adds the engine to autoConsent', () => {
    const on = vi.fn();
    const { rerender } = render(<SettingsView build={null} autoRoute={{ autoEngines: ['claude', 'codex'], autoConsent: [], grokFast: false }} onAutoRoute={on} onClose={noop} />);
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
    rerender(<SettingsView build={null} autoRoute={{ autoEngines: ['claude', 'codex', 'gemini'], autoConsent: ['gemini'], grokFast: false }} onAutoRoute={on} onClose={noop} />);
    expect(screen.queryByTestId('auto-consent-gemini')).toBeNull();
    expect(screen.getByTestId('auto-consent-grok')).toBeTruthy();
  });
});

describe('SettingsView 간결 모드', () => {
  afterEach(() => { cleanup(); localStorage.clear(); });
  it('toggles conciseMode in prefs', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: true }));
    render(<SettingsView build={null} onClose={() => {}} />);
    fireEvent.click(within(screen.getByRole('group', { name: '간결 모드' })).getByRole('button', { name: '끄기' }));
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).conciseMode).toBe(false);
  });
});

describe('SettingsView 4그룹', () => {
  afterEach(() => { cleanup(); localStorage.clear(); });
  const full = () => render(<SettingsView build="b42" defaultPermMode="default" onDefaultPermMode={noop} routingPolicy="balance" onRoutingPolicy={noop} sameVendorRotation={false} onSameVendorRotation={noop} claudeAccounts={2}
    commanderEnabled={false} onCommanderEnabled={noop} autoRoute={{ autoEngines: ['claude'], autoConsent: [], grokFast: false }} onAutoRoute={noop} grokLocked="tripwire" onGrokUnlock={noop} taskCap={2} onTaskCap={noop}
    onClose={noop} />);
  const region = (name: string) => screen.getByRole('region', { name });

  it('화면 · 입력 · 권한·알림 · 계정, in that order, each row in its group; no 정보 section, the build on one line at the end', () => {
    full();
    const dialog = screen.getByRole('dialog', { name: '설정' });
    expect(within(dialog).getAllByRole('region').map((r) => r.getAttribute('aria-labelledby') && document.getElementById(r.getAttribute('aria-labelledby')!)!.textContent)).toEqual(['화면', '입력', '권한·알림', '계정', '실험적 기능']);
    expect(SETTINGS_GROUPS.map(([, n]) => n)).toEqual(['화면', '입력', '권한·알림', '계정', '실험적 기능']);
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
    expect(within(region('실험적 기능')).getByRole('group', { name: '같은 벤더 계정 자동 순환' })).toBeTruthy();
    expect(within(account).getByRole('button', { name: '잠금 해제' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '정보' })).toBeNull();
    // The version is the avatar menu's (deck v…); the last line is the build and the screen only.
    expect(screen.getByTestId('settings-foot').textContent).toMatch(/^빌드 b42 · /);
    expect(screen.getByTestId('settings-foot').textContent).not.toMatch(/deck/);
    // The left list names the same four groups.
    expect(within(screen.getByRole('navigation', { name: '설정 그룹' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['화면', '입력', '권한·알림', '계정', '실험적 기능']);
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

  it('opened, the note shows the long text only (the summary is swapped out, not repeated above it)', () => {
    full();
    const short = '짧은 확인 뒤 결과만 보여 줍니다 · 이 기기에만 저장';
    const hint = within(region('화면')).getByRole('button', { name: '자세히' }).closest('.settings-hint')!;
    expect(hint.textContent).toContain(short);
    fireEvent.click(within(hint as HTMLElement).getByRole('button', { name: '자세히' }));
    expect(hint.textContent).not.toContain(short);
    expect(hint.textContent).toMatch(/생각·도구 본문은 접어둡니다/);
    expect(hint.querySelectorAll('p')).toHaveLength(1);
  });

  it('the left list: a press moves focus to the group heading, marks it aria-current, and scrolls without smooth under reduced motion', () => {
    const mm = window.matchMedia;
    const calls: ScrollIntoViewOptions[] = [];
    const had = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (o?: boolean | ScrollIntoViewOptions) { calls.push(o as ScrollIntoViewOptions); };
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia;
    try {
      full();
      const nav = screen.getByRole('navigation', { name: '설정 그룹' });
      const btn = (n: string) => within(nav).getByRole('button', { name: n });
      expect(btn('화면').getAttribute('aria-current')).toBe('true');
      fireEvent.click(btn('계정'));
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: '계정' }));
      expect(document.activeElement!.getAttribute('tabindex')).toBe('-1');
      expect(btn('계정').getAttribute('aria-current')).toBe('true');
      expect(btn('화면').getAttribute('aria-current')).toBeNull();
      expect(calls.at(-1)).toEqual({ block: 'start', behavior: 'auto' });
    } finally {
      window.matchMedia = mm;
      Element.prototype.scrollIntoView = had;
    }
  });

  it('the left list is safe without scrollIntoView or matchMedia (jsdom): focus still moves', () => {
    const had = Element.prototype.scrollIntoView;
    const mm = window.matchMedia;
    // @ts-expect-error jsdom has neither
    delete Element.prototype.scrollIntoView;
    // @ts-expect-error jsdom has neither
    delete window.matchMedia;
    try {
      full();
      fireEvent.click(within(screen.getByRole('navigation', { name: '설정 그룹' })).getByRole('button', { name: '입력' }));
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: '입력' }));
    } finally {
      if (had) Element.prototype.scrollIntoView = had;
      window.matchMedia = mm;
    }
  });

  it('the sheet: 닫기 has focus on open; Tab from the last control wraps to it, Shift+Tab from it wraps to the last', () => {
    full();
    const dialog = screen.getByRole('dialog', { name: '설정' });
    const close = within(dialog).getByRole('button', { name: '닫기' });
    expect(document.activeElement).toBe(close);
    const all = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    const last = all[all.length - 1]!;
    act(() => { last.focus(); });
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
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

describe('SettingsView 언어', () => {
  afterEach(cleanup);
  const langGroup = () => screen.getByRole('group', { name: '언어 · Language' });

  it('picking English saves the pref, tells the server, and reloads only once the server has it', async () => {
    let ack!: () => void;
    const onLanguage = vi.fn(() => new Promise<void>((r) => { ack = r; }));
    const reload = vi.fn();
    render(<SettingsView build={null} onLanguage={onLanguage} reload={reload} onClose={noop} />);
    fireEvent.click(within(langGroup()).getByRole('button', { name: 'English' }));
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).lang).toBe('en');
    expect(onLanguage).toHaveBeenCalledWith('en');
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).not.toHaveBeenCalled();
    ack();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('picking Auto clears the server language (null)', () => {
    const onLanguage = vi.fn();
    const reload = vi.fn();
    render(<SettingsView build={null} onLanguage={onLanguage} reload={reload} onClose={noop} />);
    fireEvent.click(within(langGroup()).getByRole('button', { name: '자동' }));
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).lang).toBe('auto');
    expect(onLanguage).toHaveBeenCalledWith(null);
  });

  it('picking the current language does nothing', () => {
    const onLanguage = vi.fn();
    const reload = vi.fn();
    render(<SettingsView build={null} onLanguage={onLanguage} reload={reload} onClose={noop} />);
    fireEvent.click(within(langGroup()).getByRole('button', { name: '한국어' }));
    expect(onLanguage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('the language row is a 3-way segment (SEG_MAX), language names in their own language', () => {
    render(<SettingsView build={null} onClose={noop} />);
    const names = within(langGroup()).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['자동', 'English', '한국어']);
    expect(names.length).toBeLessThanOrEqual(SEG_MAX);
  });
});
