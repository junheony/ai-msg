// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientMessage } from '../shared/protocol';
import { Chat, type ChatProps } from './components/Chat';
import { FastConsentSheet } from './components/FastConsentSheet';
import { sendFromPane, startTaskFromPane } from './components/Pane';
import { FAST_CONSENT_KEY, FAST_KEY, hasFastConsent, isFast, requestFast, resetFastForTests, setFast } from './fastMode';
import { newPane, type PaneState } from './state';

Element.prototype.scrollIntoView = () => {};

const props = (extra: Partial<ChatProps> = {}): ChatProps => ({ items: [], pending: [], questions: [], activeTurnId: null, busy: false, title: 't', model: 'opus', effort: 'high', engine: 'claude', sandbox: 'read-only', sessionEngine: 'claude', sessionSandbox: null, isNew: false, codexAvailable: false, attachments: [], onSend: () => {}, onInterrupt: () => {}, onDecide: () => {}, onAnswer: () => {}, onModel: () => {}, onEffort: () => {}, onEngine: () => {}, onSandbox: () => {}, onAttach: () => {}, onUnattach: () => {}, sessionId: 's1', ...extra });
const renderAll = (extra: Partial<ChatProps> = {}) => render(<><Chat {...props(extra)} /><FastConsentSheet /></>);
const openMenu = () => fireEvent.click(screen.getByTestId('session-chip-head'));

beforeEach(() => { localStorage.clear(); resetFastForTests(); });
afterEach(() => { cleanup(); localStorage.clear(); act(() => resetFastForTests()); });

describe('⚡ 빠르게 switch', () => {
  it('first turn-on asks once (consent sheet); agreeing turns it on, shows ↯ and is remembered', () => {
    renderAll();
    expect(screen.queryByTestId('fast-chip')).toBeNull();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '빠르게 (Opus fast)' }));
    const sheet = screen.getByRole('dialog', { name: '빠르게 모드 켜기' });
    expect(sheet.textContent).toContain('$8');
    expect(sheet.textContent).toContain('$40');
    expect(sheet.textContent).toContain('한도가 남아 있어도');
    expect(sheet.textContent).toContain('한 번 더');
    expect(sheet.textContent).toContain('사용 크레딧이 켜져 있어야');
    expect(sheet.textContent).toContain('Opus 로만');
    expect(isFast('s1')).toBe(false);
    fireEvent.click(screen.getByTestId('fast-consent-agree'));
    expect(screen.queryByRole('dialog', { name: '빠르게 모드 켜기' })).toBeNull();
    expect(isFast('s1')).toBe(true);
    expect(hasFastConsent()).toBe(true);
    expect(localStorage.getItem(FAST_CONSENT_KEY)).toBe('1');
    expect(JSON.parse(localStorage.getItem(FAST_KEY)!)).toEqual(['s1']);
    const chip = screen.getByTestId('fast-chip');
    expect(chip.textContent).toBe('↯');
    expect(chip.getAttribute('aria-label')).toContain('빠르게 · 사용 크레딧');

    // ↯ turns it off; turning it on again needs no second consent.
    fireEvent.click(chip);
    expect(isFast('s1')).toBe(false);
    expect(screen.queryByTestId('fast-chip')).toBeNull();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '빠르게 (Opus fast)' }));
    expect(screen.queryByRole('dialog', { name: '빠르게 모드 켜기' })).toBeNull();
    expect(isFast('s1')).toBe(true);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '빠르게 끄기 (Opus fast)' }));
    expect(isFast('s1')).toBe(false);
  });

  it('declining leaves it off and asks again next time', () => {
    renderAll();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '빠르게 (Opus fast)' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(isFast('s1')).toBe(false);
    expect(hasFastConsent()).toBe(false);
    expect(screen.queryByRole('dialog', { name: '빠르게 모드 켜기' })).toBeNull();
    act(() => requestFast('s1', true));
    expect(screen.getByRole('dialog', { name: '빠르게 모드 켜기' })).toBeTruthy();
  });

  it('no switch for a new session, a non-Claude session or a read-only pane; ↯ hidden there too', () => {
    setFast('s1', true);
    for (const extra of [{ isNew: true, sessionId: null }, { sessionEngine: 'codex' as const, model: 'gpt-6-sol' as const }, { readOnly: '보기 전용' }] as Partial<ChatProps>[]) {
      renderAll(extra);
      expect(screen.queryByTestId('fast-chip')).toBeNull();
      const head = screen.queryByTestId('session-chip-head');
      if (head?.tagName === 'BUTTON') { fireEvent.click(head); expect(screen.queryByRole('menuitem', { name: /빠르게/ })).toBeNull(); }
      cleanup();
    }
  });
});

describe('⚡ 빠르게 on the wire', () => {
  const pane = (sessionId: string | null): PaneState => ({ ...newPane('p1'), session: { sessionId, cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null } });
  it('send and start_task carry fast only for a session that has it on', () => {
    const out: ClientMessage[] = [];
    const send = vi.fn((m: ClientMessage) => { out.push(m); return true; });
    sendFromPane(pane('s1'), 'hi', [], () => {}, send);
    startTaskFromPane(pane('s1'), 'bg', () => {}, send);
    expect(out.map((m) => 'fast' in m)).toEqual([false, false]);
    setFast('s1', true);
    sendFromPane(pane('s1'), 'hi', [], () => {}, send);
    startTaskFromPane(pane('s1'), 'bg', () => {}, send);
    sendFromPane(pane('s2'), 'hi', [], () => {}, send);
    expect(out.slice(2).map((m) => (m as { fast?: boolean }).fast)).toEqual([true, true, undefined]);
  });
  it('a corrupt store reads as off', () => {
    localStorage.setItem(FAST_KEY, '{nope');
    resetFastForTests();
    expect(isFast('s1')).toBe(false);
    localStorage.setItem(FAST_KEY, JSON.stringify([1, 's9']));
    resetFastForTests();
    expect(isFast('s9')).toBe(true);
  });
});
