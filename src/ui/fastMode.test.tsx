// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useReducer } from 'react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { Chat, type ChatProps } from './components/Chat';
import { FastConsentSheet } from './components/FastConsentSheet';
import { Pane, sendFromPane, startTaskFromPane, useQueueRunner } from './components/Pane';
import { FAST_CONSENT_KEY, FAST_KEY, hasFastConsent, isFast, requestFast, resetFastForTests, setFast, useFast } from './fastMode';
import { initialState, newPane, reducer, type AppState, type PaneState } from './state';

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
    const row = screen.getByRole('menuitemcheckbox', { name: '빠르게 (Opus fast)' });
    expect(row.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(row);
    const sheet = screen.getByRole('dialog', { name: '빠르게 모드 켜기' });
    // A paid switch: the sheet opens on 취소, so Enter right away never agrees.
    expect(document.activeElement).toBe(screen.getByTestId('fast-consent-cancel'));
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
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '빠르게 (Opus fast)' }));
    expect(screen.queryByRole('dialog', { name: '빠르게 모드 켜기' })).toBeNull();
    expect(isFast('s1')).toBe(true);
    openMenu();
    expect(screen.getByRole('menuitemcheckbox', { name: '빠르게 끄기 (Opus fast)' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '빠르게 끄기 (Opus fast)' }));
    expect(isFast('s1')).toBe(false);
  });

  it('declining leaves it off and asks again next time', () => {
    renderAll();
    openMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '빠르게 (Opus fast)' }));
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
      if (head?.tagName === 'BUTTON') { fireEvent.click(head); expect(screen.queryByRole('menuitemcheckbox', { name: /빠르게/ })).toBeNull(); }
      cleanup();
    }
  });
});

describe('⚡ 빠르게 on the wire', () => {
  const pane = (sessionId: string | null): PaneState => ({ ...newPane('p1'), session: { sessionId, cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null } });
  it('send carries fast only for a Claude session that has it on; a background task or a model-naming retry never does', () => {
    const out: ClientMessage[] = [];
    const send = vi.fn((m: ClientMessage) => { out.push(m); return true; });
    sendFromPane(pane('s1'), 'hi', [], () => {}, send);
    startTaskFromPane(pane('s1'), 'bg', () => {}, send);
    expect(out.map((m) => 'fast' in m)).toEqual([false, false]);
    setFast('s1', true);
    sendFromPane(pane('s1'), 'hi', [], () => {}, send);
    startTaskFromPane(pane('s1'), 'bg', () => {}, send);
    sendFromPane(pane('s2'), 'hi', [], () => {}, send);
    // 다시 생성 › a model (Pane retryWith): the picked model goes as chosen, never turned into fast Opus.
    sendFromPane({ ...pane('s1'), model: 'sonnet', modelPicked: true }, 'again', [], () => {}, send, null, false, undefined, { keepAttachments: true, noFast: true });
    expect((out[5] as { model?: string }).model).toBe('sonnet');
    sendFromPane({ ...pane('s1'), session: { ...pane('s1').session!, engine: 'codex' } }, 'hi', [], () => {}, send);
    expect(out.slice(2).map((m) => (m as { fast?: boolean }).fast)).toEqual([true, undefined, undefined, undefined, undefined]);
    expect(out[3]!.type).toBe('start_task');
  });
  it('two tabs: a change in one shows in the other (storage event) and neither overwrites the other', () => {
    const seen: boolean[] = [];
    function Probe() { const v = useFast('s1'); seen.push(v); return null; }
    render(<Probe />);
    // The other tab writes straight to the shared store, then the browser fires 'storage' here.
    act(() => {
      localStorage.setItem(FAST_KEY, JSON.stringify(['s1']));
      window.dispatchEvent(new StorageEvent('storage', { key: FAST_KEY }));
    });
    expect(seen.at(-1)).toBe(true);
    // This tab turns on s2 after the other tab's write: s1 survives (read-modify-write).
    setFast('s2', true);
    expect(JSON.parse(localStorage.getItem(FAST_KEY)!)).toEqual(['s1', 's2']);
    act(() => {
      localStorage.setItem(FAST_KEY, JSON.stringify(['s2']));
      window.dispatchEvent(new StorageEvent('storage', { key: FAST_KEY }));
    });
    expect(seen.at(-1)).toBe(false);
    // Consent given in another tab counts here at once.
    expect(hasFastConsent()).toBe(false);
    localStorage.setItem(FAST_CONSENT_KEY, '1');
    expect(hasFastConsent()).toBe(true);
    requestFast('s3', true);
    expect(isFast('s3')).toBe(true);
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

describe('⚡ 빠르게 — a message typed during a running turn (steer)', () => {
  /** A Claude pane whose first send started turn t1 (↯ as `fastAtStart`), with the queue runner on. */
  function running(fastAtStart: boolean) {
    setFast('s1', fastAtStart);
    const send = vi.fn<(m: ClientMessage) => unknown>();
    const start: AppState = { ...initialState, connected: true, panes: [{ ...newPane('p0'), session: { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null } }] };
    let dispatchOut: (a: Parameters<typeof reducer>[1]) => void = () => {};
    function Harness() {
      const [s, dispatch] = useReducer(reducer, start);
      dispatchOut = dispatch;
      useQueueRunner(s.panes, s.connected, dispatch, send);
      return <Pane pane={s.panes[0]!} app={s} active closable={false} dispatch={dispatch} send={send} onClose={() => {}} />;
    }
    render(<Harness />);
    const server = (msg: ServerMessage) => act(() => dispatchOut({ type: 'server', msg }));
    const box = () => screen.getByLabelText('메시지');
    fireEvent.change(box(), { target: { value: 'one' } });
    fireEvent.click(screen.getByText('보내기'));
    const first = send.mock.lastCall![0] as Extract<ClientMessage, { type: 'send' }>;
    expect(first.fast === true).toBe(fastAtStart);
    server({ type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', engine: 'claude', clientRef: first.clientRef } as ServerMessage);
    const steer = (text: string) => {
      fireEvent.change(box(), { target: { value: text } });
      fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
      return send.mock.lastCall![0] as Extract<ClientMessage, { type: 'steer' }>;
    };
    return { send, server, steer };
  }

  it.each([
    ['turned off mid-turn', true, false],
    ['turned on mid-turn', false, true],
  ])('↯ %s: the steer carries the switch; refused by the server it waits as a queue item and goes out after the turn as a send with ↯ as it is then', (_what, was, now) => {
    const { send, server, steer } = running(was);
    act(() => setFast('s1', now));
    const st = steer('also this');
    expect(st.type).toBe('steer');
    expect(st.fast === true).toBe(now);
    server({ type: 'steer_rejected', turnId: 't1', sessionId: 's1', cwd: '/w', steerId: st.steerId, message: '↯ 빠르게 설정이 바뀌어 이 턴이 끝난 뒤 새로 보냅니다' });
    expect(screen.getByTestId('queue').textContent).toContain('also this');
    const before = send.mock.calls.length;
    server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null });
    expect(send.mock.calls.length).toBe(before + 1);
    const again = send.mock.lastCall![0] as Extract<ClientMessage, { type: 'send' }>;
    expect(again).toMatchObject({ type: 'send', sessionId: 's1', text: 'also this' });
    expect(again.fast === true).toBe(now);
  });

  it('the same ↯ as at the start: the steer carries it (the server folds it in)', () => {
    const { steer } = running(true);
    expect(steer('more').fast).toBe(true);
  });
});
