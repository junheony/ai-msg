// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';

Element.prototype.scrollIntoView = () => {};

const sock = vi.hoisted(() => ({ frames: [] as unknown[], onMessage: null as ((m: unknown) => void) | null }));
vi.mock('./ws', () => ({
  createSocket: (onMessage: (m: unknown) => void, onStatus: (v: boolean) => void) => {
    sock.onMessage = onMessage;
    onStatus(true);
    return { send: (m: unknown) => { sock.frames.push(m); }, close: () => {} };
  },
}));

import { App } from './App';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;
const T = Date.now();
const entry = (sessionId: string, title: string, ago: number) => ({ sessionId, account: 'b' as const, cwd: '/w', projectDir: '/p', title, lastModified: T - ago, sizeBytes: 1 });

/** Boots with real timers (the socket handshake uses waitFor), then hands the clock to the test. */
async function boot() {
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  act(() => sock.onMessage!({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one', 0), entry('s2', 'two', 1000)] }], running: [], codex: { available: false } } as unknown as ServerMessage));
  vi.useFakeTimers();
}
const wrap = () => document.querySelector('.sidebar-wrap') as HTMLElement;
const hotzone = () => screen.queryByTestId('sidebar-hotzone');
const peeking = () => wrap().classList.contains('peek');
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const opened = () => (sock.frames as ClientMessage[]).filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId);
/** A desktop with a mouse unless told otherwise: (pointer: fine) and (hover: hover) match, the phone width does not. */
function media(fine = true) {
  window.matchMedia = ((query: string) => ({
    matches: fine && (query.includes('pointer: fine') || query.includes('hover: hover')), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
const toggleKey = () => fireEvent.keyDown(window, { code: 'Backslash', key: '', ctrlKey: true });
async function bootPeeked() {
  await boot();
  fireEvent.mouseEnter(hotzone()!);
  tick(150);
  expect(peeking()).toBe(true);
}

describe('hidden sidebar peek (desktop)', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('deck.sidebarHidden', '1');
    sock.frames = [];
    sock.onMessage = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    media();
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); (window as { matchMedia?: unknown }).matchMedia = undefined; });

  it('dwelling 150ms on the left edge slides it out; leaving sooner does not', async () => {
    await boot();
    expect(wrap().classList.contains('hidden')).toBe(true);
    fireEvent.mouseEnter(hotzone()!);
    tick(100);
    fireEvent.mouseLeave(hotzone()!);
    tick(200);
    expect(peeking()).toBe(false);
    fireEvent.mouseEnter(hotzone()!);
    tick(149);
    expect(peeking()).toBe(false);
    tick(1);
    expect(peeking()).toBe(true);
    expect(wrap().classList.contains('hidden')).toBe(true);
  });

  it('leaving the sidebar closes it after 300ms; coming back in time keeps it', async () => {
    await bootPeeked();
    fireEvent.mouseLeave(wrap());
    tick(250);
    fireEvent.mouseEnter(wrap());
    tick(500);
    expect(peeking()).toBe(true);
    fireEvent.mouseLeave(wrap());
    tick(299);
    expect(peeking()).toBe(true);
    tick(1);
    expect(peeking()).toBe(false);
  });

  it('stays out while a field inside has focus, then closes once it is left', async () => {
    await bootPeeked();
    fireEvent.click(within(wrap()).getByRole('button', { name: '검색' }));
    const search = within(wrap()).getByLabelText('세션 검색');
    search.focus();
    fireEvent.mouseLeave(wrap());
    tick(900);
    expect(peeking()).toBe(true);
    search.blur();
    tick(300);
    expect(peeking()).toBe(false);
  });

  it('opening a session from it closes it; Esc closes it', async () => {
    await bootPeeked();
    fireEvent.click(within(wrap()).getByText('one'));
    expect(opened()).toContain('s1');
    expect(peeking()).toBe(false);

    fireEvent.mouseLeave(wrap());
    fireEvent.mouseEnter(hotzone()!);
    tick(150);
    expect(peeking()).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(peeking()).toBe(false);
  });

  it('Ctrl+\\ while peeking pins it visible: no peek, no hot zone', async () => {
    await bootPeeked();
    fireEvent.keyDown(window, { code: 'Backslash', key: '', ctrlKey: true });
    expect(wrap().classList.contains('hidden')).toBe(false);
    expect(peeking()).toBe(false);
    expect(hotzone()).toBeNull();
  });

  it('no hot zone while the sidebar is shown', async () => {
    localStorage.setItem('deck.sidebarHidden', '0');
    await boot();
    expect(hotzone()).toBeNull();
  });

  it('no hot zone on a phone (drawer mode)', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('720'), media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    await boot();
    expect(hotzone()).toBeNull();
    expect(wrap().classList.contains('hidden')).toBe(false);
  });
  it('no hot zone without a fine hovering pointer (touch screen): the sidebar stays tucked away', async () => {
    media(false);
    await boot();
    expect(hotzone()).toBeNull();
    expect(wrap().classList.contains('hidden')).toBe(true);
    fireEvent.mouseEnter(screen.getByRole('button', { name: '사이드바 보이기' }));
    tick(500);
    expect(peeking()).toBe(false);
  });

  it('resting on ☰ peeks too; the toggle rides in the peeked head over its spot, and leaving the sidebar closes after 300ms', async () => {
    await boot();
    const menu = screen.getByRole('button', { name: '사이드바 보이기' });
    fireEvent.mouseEnter(menu);
    tick(150);
    expect(peeking()).toBe(true);
    const inHead = screen.getByRole('button', { name: '사이드바 보이기' });
    expect(inHead.closest('.sidebar-head')).not.toBeNull();
    expect(document.querySelector('.topbar .sidebar-toggle')).toBeNull();
    // Its spot in the bar is kept (the chip does not jump left under the peeked sidebar).
    expect(document.querySelector('.topbar .sidebar-toggle-spacer')).not.toBeNull();
    fireEvent.mouseLeave(wrap());
    tick(300);
    expect(peeking()).toBe(false);
    expect(screen.getByRole('button', { name: '사이드바 보이기' }).closest('.topbar')).not.toBeNull();
  });

  it('peeked: the toggle in its head pins the sidebar (aria-pressed follows)', async () => {
    await bootPeeked();
    const toggle = screen.getByRole('button', { name: '사이드바 보이기' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(wrap().classList.contains('hidden')).toBe(false);
    const pinned = screen.getByRole('button', { name: '사이드바 숨기기' });
    expect(pinned.closest('.sidebar-head')).not.toBeNull();
    expect(pinned.getAttribute('aria-pressed')).toBe('true');
  });

  it('a drag crossing the edge (button held) does not peek', async () => {
    await boot();
    fireEvent.mouseEnter(hotzone()!, { buttons: 1 });
    tick(500);
    expect(peeking()).toBe(false);
  });

  it('Esc while peeking does not stop the running turn — it only closes the peek', async () => {
    await bootPeeked();
    fireEvent.click(within(wrap()).getByText('one'));
    act(() => sock.onMessage!({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one', 0), entry('s2', 'two', 1000)] }], running: [{ turnId: 't1', sessionId: 's1', cwd: '/w' }], codex: { available: false } } as unknown as ServerMessage));
    fireEvent.mouseLeave(hotzone()!);
    fireEvent.mouseEnter(hotzone()!);
    tick(150);
    expect(peeking()).toBe(true);
    (document.activeElement as HTMLElement | null)?.blur();
    sock.frames = [];
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(peeking()).toBe(false);
    expect((sock.frames as ClientMessage[]).filter((f) => f.type === 'interrupt')).toEqual([]);
    // Without the peek the same Esc stops the turn (the guard above is what held it).
    fireEvent.keyDown(window, { key: 'Escape' });
    expect((sock.frames as ClientMessage[]).filter((f) => f.type === 'interrupt')).toHaveLength(1);
  });

  it('Esc mid-IME composition leaves it open', async () => {
    await bootPeeked();
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    expect(peeking()).toBe(true);
  });

  it('closed by Esc with the pointer still on the edge: no reopening until the pointer has left', async () => {
    await bootPeeked();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(peeking()).toBe(false);
    fireEvent.mouseEnter(hotzone()!);
    tick(500);
    expect(peeking()).toBe(false);
    fireEvent.mouseLeave(hotzone()!);
    fireEvent.mouseEnter(hotzone()!);
    tick(150);
    expect(peeking()).toBe(true);
  });

  it('closed by opening a session: the pointer moving off the sidebar releases the latch', async () => {
    await bootPeeked();
    fireEvent.click(within(wrap()).getByText('one'));
    expect(peeking()).toBe(false);
    fireEvent.mouseEnter(hotzone()!);
    tick(500);
    expect(peeking()).toBe(false);
    fireEvent.mouseMove(document.querySelector('.panes')!);
    fireEvent.mouseEnter(hotzone()!);
    tick(150);
    expect(peeking()).toBe(true);
  });

  it('an open row menu keeps it out after the pointer leaves; Esc closes the menu, not the peek', async () => {
    await bootPeeked();
    fireEvent.click(within(wrap()).getAllByRole('button', { name: '세션 메뉴' })[0]!);
    expect(wrap().querySelector('.session-menu')).not.toBeNull();
    fireEvent.mouseLeave(wrap());
    tick(900);
    expect(peeking()).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(wrap().querySelector('.session-menu')).toBeNull();
    expect(peeking()).toBe(true);
    tick(300);
    expect(peeking()).toBe(false);
  });

  it('peeked from ☰ and closed by Esc: no reopening on ☰ until the pointer has left it', async () => {
    await boot();
    const menu = screen.getByRole('button', { name: '사이드바 보이기' });
    fireEvent.mouseEnter(menu);
    tick(150);
    expect(peeking()).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(peeking()).toBe(false);
    // Back in the top bar (a new button under the same pointer).
    const back = screen.getByRole('button', { name: '사이드바 보이기' });
    expect(back.closest('.topbar')).not.toBeNull();
    fireEvent.mouseEnter(back);
    tick(500);
    expect(peeking()).toBe(false);
    fireEvent.mouseLeave(back);
    fireEvent.mouseEnter(back);
    tick(150);
    expect(peeking()).toBe(true);
  });

  it('a side panel open in the pane: Esc closes the peek only, the next Esc the panel', async () => {
    await bootPeeked();
    fireEvent.click(within(wrap()).getByText('one'));
    act(() => sock.onMessage!({ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [{ kind: 'assistant', text: 'See `src/b.md`', model: null, toolCalls: [], ts: null }] } as unknown as ServerMessage));
    fireEvent.click(screen.getByTitle('src/b.md — 사이드 패널에서 열기'));
    expect(screen.getByTestId('side-panel')).toBeTruthy();
    fireEvent.mouseMove(document.querySelector('.panes')!);
    fireEvent.mouseEnter(hotzone()!);
    tick(150);
    expect(peeking()).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(peeking()).toBe(false);
    expect(screen.getByTestId('side-panel')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('side-panel')).toBeNull();
  });

  it('a dialog opened over it (⌘/ help): Esc closes the dialog, the peek stays', async () => {
    await bootPeeked();
    fireEvent.keyDown(window, { code: 'Slash', key: '/', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: '단축키' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '단축키' })).toBeNull();
    expect(peeking()).toBe(true);
  });

  it('⌘\\ during the open delay cancels it; unmounting clears a pending timer', async () => {
    await boot();
    fireEvent.mouseEnter(hotzone()!);
    tick(100);
    toggleKey();
    expect(hotzone()).toBeNull();
    toggleKey();
    tick(500);
    expect(peeking()).toBe(false);
    const spy = vi.spyOn(globalThis, 'clearTimeout');
    fireEvent.mouseEnter(hotzone()!);
    const before = vi.getTimerCount();
    cleanup();
    expect(spy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeLessThan(before);
    spy.mockRestore();
  });
});

describe('desktop layout: the sidebar a full-height column, its head the brand row', () => {
  beforeEach(() => {
    localStorage.clear();
    sock.frames = [];
    sock.onMessage = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    media();
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); (window as { matchMedia?: unknown }).matchMedia = undefined; });

  it('sidebar shown: brand and toggle in the sidebar head, the top bar beside it in the body column, focus sidebar → body', async () => {
    await boot();
    const head = document.querySelector('.sidebar-wrap .sidebar-head')!;
    expect(head.querySelector('.sidebar-brand')).not.toBeNull();
    const toggle = screen.getByRole('button', { name: '사이드바 숨기기' });
    expect(head.contains(toggle)).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // The toggle comes before the brand in the head.
    expect(toggle.compareDocumentPosition(head.querySelector('.sidebar-brand')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const topbar = document.querySelector('.topbar')!;
    expect(topbar.querySelector('.sidebar-toggle')).toBeNull();
    expect(topbar.classList.contains('beside-sidebar')).toBe(true);
    expect(topbar.parentElement!.classList.contains('main-col')).toBe(true);
    expect(wrap().parentElement!.classList.contains('app')).toBe(true);
    // DOM (= focus) order: the sidebar column, then the top bar, then the body (#main).
    expect(wrap().compareDocumentPosition(topbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const main = document.getElementById('main')!;
    expect(main.closest('.main-col')).not.toBeNull();
    expect(topbar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.querySelector('.panes')).not.toBeNull();
  });

  it('hidden: the toggle back at the top bar start (aria-pressed false), the bar the full width; the brand stays in the tucked head', async () => {
    localStorage.setItem('deck.sidebarHidden', '1');
    await boot();
    const toggle = screen.getByRole('button', { name: '사이드바 보이기' });
    expect(toggle.closest('.topbar')).not.toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.sidebar-head .sidebar-toggle')).toBeNull();
    expect(document.querySelector('.topbar')!.classList.contains('beside-sidebar')).toBe(false);
    expect(document.querySelector('.sidebar-wrap.hidden .sidebar-head .sidebar-brand')).not.toBeNull();
  });

  it('a press with focus on the toggle keeps focus on it as it moves between the head and the top bar', async () => {
    await boot();
    const toggle = screen.getByRole('button', { name: '사이드바 숨기기' });
    toggle.focus();
    fireEvent.click(toggle);
    const moved = screen.getByRole('button', { name: '사이드바 보이기' });
    expect(moved.closest('.topbar')).not.toBeNull();
    expect(document.activeElement).toBe(moved);
    fireEvent.click(moved);
    const back = screen.getByRole('button', { name: '사이드바 숨기기' });
    expect(back.closest('.sidebar-head')).not.toBeNull();
    expect(document.activeElement).toBe(back);
  });
});
