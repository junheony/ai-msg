// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';

Element.prototype.scrollIntoView = () => {};

const sock = vi.hoisted(() => ({ frames: [] as unknown[], onMessage: null as ((m: unknown) => void) | null, onStatus: null as ((v: boolean) => void) | null, retries: 0 }));
vi.mock('./ws', () => ({
  createSocket: (onMessage: (m: unknown) => void, onStatus: (v: boolean) => void) => {
    sock.onMessage = onMessage;
    sock.onStatus = onStatus;
    onStatus(true);
    return { send: (m: unknown) => { sock.frames.push(m); }, wake: () => {}, reconnect: () => {}, retry: () => { sock.retries += 1; }, close: () => {} };
  },
}));

import { App } from './App';
import { ALERT_SEED_MS } from './components/ActivityButton';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;
const entry = (sessionId: string, title: string) => ({ sessionId, account: 'b' as const, cwd: '/w', projectDir: '/p', title, lastModified: Date.now(), sizeBytes: 1 });

const hello = (features?: string[]) => ({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two')] }], running: [], codex: { available: false }, ...(features ? { features } : {}) } as unknown as ServerMessage);
async function boot(features?: string[]) {
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  server(hello(features));
}
function server(msg: ServerMessage) { act(() => sock.onMessage!(msg)); }
const frames = () => sock.frames as ClientMessage[];
const closes = () => frames().filter((f) => f.type === 'close_session').map((f) => (f as { sessionId: string }).sessionId);
const lastPane = () => screen.getAllByTestId(/^pane-/).at(-1)!;
/** A pane's session chip (a lone pane's sits in the top bar, outside the pane). */
const chipOf = (pane: HTMLElement) => document.querySelector<HTMLElement>(`[data-pane-head="${pane.dataset.pane}"] [data-testid="session-chip-head"]`)!;
const pickFrom = (pane: HTMLElement, name: string | RegExp) => {
  fireEvent.click(chipOf(pane));
  fireEvent.click(screen.getByRole('menuitem', { name }));
};
/** 창 › 떠 있는 카드로 떼기 / 패널에 다시 붙이기 (Enter on the old ⋮⋮ grip). */
const floatToggle = (id: string) => pickFrom(screen.getByTestId(`pane-${id}`), /^(떠 있는 카드로 떼기|패널에 다시 붙이기)$/);
/** A card's ✕, or 창 › 이 창 닫기 for a docked pane. */
const closePane = (pane: HTMLElement) => {
  const x = pane.querySelector<HTMLElement>('.pane-close');
  if (x) fireEvent.click(x);
  else pickFrom(pane, '이 창 닫기');
};
const openSession = (title: string) => fireEvent.click(within(document.querySelector('.sidebar') as HTMLElement).getByText(title));

describe('App split view (D6)', () => {
  beforeEach(() => {
    localStorage.clear(); // ux-state: the app restores its layout from localStorage
    sock.frames = [];
    sock.onMessage = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('ux-state: a reload restores the split, each pane\'s session/picker, and re-opens the sessions', async () => {
    await boot();
    openSession('one');
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    openSession('two');
    const stored = JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { session: { sessionId: string } }[]; active: number; collapsed: string[] };
    expect(stored.panes.map((p) => p.session.sessionId)).toEqual(['s1', 's2']);
    expect(stored.active).toBe(1);
    cleanup();
    sock.frames = [];
    sock.onMessage = null;
    await boot();
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(2);
    expect(frames().filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId)).toEqual(['s1', 's2']);
    server({ type: 'history', sessionId: 's2', cwd: '/w', account: 'b', messages: [{ kind: 'user', text: 'restored', ts: null }], runningTurnId: null } as ServerMessage);
    expect(within(lastPane()).getByText('restored')).toBeTruthy();
  });

  it('ux-state: garbage in localStorage is ignored (one blank pane)', async () => {
    localStorage.setItem('deck.ui.v1', '{"v":1,"panes":"x"');
    await boot();
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
  });

  it('splits into equal columns with no fixed ceiling ("+ 분할" stays enabled past 5); closing re-flows', async () => {
    await boot();
    const split = screen.getByRole('button', { name: '새 분할' }) as HTMLButtonElement;
    for (let i = 0; i < 4; i++) fireEvent.click(split);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(5);
    const panes = document.querySelector('.panes') as HTMLElement;
    expect(panes.dataset.count).toBe('5');
    expect(panes.style.getPropertyValue('--cols')).toBe('5');
    expect(split.disabled).toBe(false);
    fireEvent.click(split);
    fireEvent.click(split);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(7);
    expect(panes.dataset.count).toBe('7');
    closePane(lastPane());
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(6);
    expect(panes.style.getPropertyValue('--cols')).toBe('6');
  });

  it('⋮⋮ grip: ⋯ 떠 있는 카드로 떼기 turns a pane into a floating card over the grid, 패널에 다시 붙이기 docks it; the card survives a reload', async () => {
    await boot();
    expect(document.querySelector('[data-grip]')).toBeNull(); // one pane: nothing to drag
    openSession('one');
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    openSession('two');
    expect(document.querySelectorAll('[data-grip]')).toHaveLength(2);
    const menu = () => within(screen.getByTestId('pane-p1')).getByTestId('session-chip-head');
    fireEvent.click(menu());
    fireEvent.click(screen.getByRole('menuitem', { name: '떠 있는 카드로 떼기' }));
    const card = document.querySelector('.float-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.contains(screen.getByTestId('pane-p1'))).toBe(true);
    expect(card.classList.contains('on')).toBe(true);
    const grid = document.querySelector('.panes') as HTMLElement;
    expect(grid.dataset.count).toBe('1');
    expect(grid.querySelectorAll('.pane')).toHaveLength(1);
    expect(screen.queryAllByRole('separator', { name: '패널 폭 조절' })).toHaveLength(0);
    // The lone docked pane cannot be pulled off: no 떼기 item, but it keeps its grip (a card may still dock next to it).
    fireEvent.click(chipOf(screen.getByTestId('pane-p0')));
    expect(screen.queryByRole('menuitem', { name: '떠 있는 카드로 떼기' })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    const stored = JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { float?: { w: number } }[] };
    expect(stored.panes[1]!.float?.w).toBeGreaterThanOrEqual(320);
    cleanup();
    sock.frames = [];
    sock.onMessage = null;
    await boot();
    expect(document.querySelector('.float-card')).not.toBeNull();
    fireEvent.click(chipOf(screen.getByTestId('pane-p1')));
    fireEvent.click(screen.getByRole('menuitem', { name: '패널에 다시 붙이기' }));
    expect(document.querySelector('.float-card')).toBeNull();
    expect((document.querySelector('.panes') as HTMLElement).dataset.count).toBe('2');
    expect(screen.getAllByRole('separator', { name: '패널 폭 조절' })).toHaveLength(1);
  });

  it('⋮⋮ grip drag: along the rail it reorders the docked panes; below the rail it pulls the pane off as a card; Escape cancels', async () => {
    await boot();
    const split = screen.getByRole('button', { name: '새 분할' });
    fireEvent.click(split);
    fireEvent.click(split); // p0 p1 p2
    const ids = () => Array.from(document.querySelectorAll('.panes .pane')).map((el) => (el as HTMLElement).dataset.pane);
    expect(ids()).toEqual(['p0', 'p1', 'p2']);
    // jsdom has no layout: the body is 1200×800 at (0,0), the grid the same, each pane 400 wide in order.
    const box = (x: number, w: number, h = 800) => ({ width: w, height: h, left: x, right: x + w, top: 0, bottom: h, x, y: 0, toJSON: () => ({}) } as DOMRect);
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const pane = (this as HTMLElement).dataset?.pane;
      if (pane) return box(['p0', 'p1', 'p2'].indexOf(pane) * 400, 400);
      return box(0, 1200);
    });
    try {
      const grip = within(screen.getByTestId('pane-p0')).getByTestId('session-chip-head');
      // Reorder: p0 dragged along the rail (y < 72) to x = 1000 (past p2's centre at 1000? centre = 1000 → not past; use 1050).
      fireEvent.pointerDown(grip, { clientX: 10, clientY: 20, pointerId: 1, button: 0, pointerType: 'mouse' });
      fireEvent.pointerMove(grip, { clientX: 1050, clientY: 20, pointerId: 1, buttons: 1 });
      expect(document.body.classList.contains('pane-dragging')).toBe(true);
      expect(document.querySelector('.pane-drop-marker')).not.toBeNull();
      fireEvent.pointerUp(grip, { clientX: 1050, clientY: 20, pointerId: 1 });
      expect(document.body.classList.contains('pane-dragging')).toBe(false);
      expect(document.querySelector('.pane-ghost')).toBeNull();
      expect(ids()).toEqual(['p1', 'p2', 'p0']);
      // Escape mid-drag: nothing changes.
      const grip2 = within(screen.getByTestId('pane-p0')).getByTestId('session-chip-head');
      fireEvent.pointerDown(grip2, { clientX: 810, clientY: 20, pointerId: 2, button: 0, pointerType: 'mouse' });
      fireEvent.pointerMove(grip2, { clientX: 100, clientY: 20, pointerId: 2, buttons: 1 });
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.pointerUp(grip2, { clientX: 100, clientY: 20, pointerId: 2 });
      expect(ids()).toEqual(['p1', 'p2', 'p0']);
      // Off the rail (y = 400): p0 floats as a card about its own width.
      const grip3 = within(screen.getByTestId('pane-p0')).getByTestId('session-chip-head');
      fireEvent.pointerDown(grip3, { clientX: 810, clientY: 20, pointerId: 3, button: 0, pointerType: 'mouse' });
      fireEvent.pointerMove(grip3, { clientX: 600, clientY: 400, pointerId: 3, buttons: 1 });
      expect(document.querySelector('.pane-ghost.card')).not.toBeNull();
      fireEvent.pointerUp(grip3, { clientX: 600, clientY: 400, pointerId: 3 });
    } finally { rect.mockRestore(); }
    const card = document.querySelector('.float-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.contains(screen.getByTestId('pane-p0'))).toBe(true);
    expect(ids()).toEqual(['p1', 'p2']);
    const stored = JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { float?: { x: number; y: number; w: number; h: number } }[] };
    const f = stored.panes.find((p) => p.float)!.float!;
    expect(f.w).toBe(400);
    expect(f.y).toBe(382);
  });

  it('a floating card saved on a bigger screen is pulled back into the body; a resize keeps every card reachable', async () => {
    localStorage.setItem('deck.ui.v1', JSON.stringify({ v: 1, active: 0, collapsed: [], drawer: false, panes: [
      { session: null, model: 'auto', efforts: { claude: 'high', codex: 'medium', gemini: 'medium' }, autoEffort: null, engine: 'claude', sandbox: 'workspace-write' },
      { session: null, model: 'auto', efforts: { claude: 'high', codex: 'medium', gemini: 'medium' }, autoEffort: null, engine: 'claude', sandbox: 'workspace-write', float: { x: 3000, y: 2000, w: 400, h: 300 } },
    ] }));
    // jsdom has no layout: the body reports 1200 × 800 (no ResizeObserver either, so the window resize path runs).
    const size = { w: 1200, h: 800 };
    const cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('body') ? size.w : 0; });
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('body') ? size.h : 0; });
    try {
      await boot();
      const card = () => document.querySelector('.float-card') as HTMLElement;
      // The window resize listener is attached at mount; the first clamp ran then too (body size came from the mock).
      fireEvent(window, new Event('resize'));
      expect(card().style.left).toBe('1080px');
      expect(card().style.top).toBe('752px');
      size.w = 600; size.h = 500;
      fireEvent(window, new Event('resize'));
      expect(card().style.left).toBe('480px');
      expect(card().style.top).toBe('452px');
      const stored = JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { float?: { x: number; y: number } }[] };
      expect(stored.panes[1]!.float).toMatchObject({ x: 480, y: 452 });
    } finally { cw.mockRestore(); ch.mockRestore(); }
  });

  it('keyboard on the ⋮⋮ grip: ←→ reorder, Enter floats the pane; ⋯ has 왼쪽으로/오른쪽으로 이동 for panes with a neighbour there', async () => {
    await boot();
    openSession('one');
    const split = screen.getByRole('button', { name: '새 분할' });
    fireEvent.click(split);
    openSession('two');
    fireEvent.click(split); // p0 p1 p2
    const order = () => Array.from(document.querySelectorAll<HTMLElement>('.panes .pane')).map((e) => e.dataset.pane);
    expect(order()).toEqual(['p0', 'p1', 'p2']);
    const grip = (id: string) => within(screen.getByTestId(`pane-${id}`)).getByTestId('session-chip-head');
    const live = () => screen.getByTestId('cards-live').textContent;
    fireEvent.keyDown(grip('p0'), { key: 'ArrowRight' });
    expect(order()).toEqual(['p1', 'p0', 'p2']);
    expect(live()).toBe('2번째 자리로 옮겼습니다'); // narrated for screen readers
    fireEvent.keyDown(grip('p0'), { key: 'ArrowLeft' });
    expect(order()).toEqual(['p0', 'p1', 'p2']);
    expect(live()).toBe('1번째 자리로 옮겼습니다');
    fireEvent.keyDown(grip('p0'), { key: 'ArrowLeft' }); // already first: nothing
    expect(order()).toEqual(['p0', 'p1', 'p2']);
    // The leftmost pane's ⋯ offers only 오른쇽으로 이동; the middle one both.
    fireEvent.click(chipOf(screen.getByTestId('pane-p0')));
    expect(screen.queryByRole('menuitem', { name: '왼쪽으로 이동' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '오른쪽으로 이동' }));
    expect(order()).toEqual(['p1', 'p0', 'p2']);
    fireEvent.click(chipOf(screen.getByTestId('pane-p0')));
    expect(screen.getByRole('menuitem', { name: '왼쪽으로 이동' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '오른쪽으로 이동' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // Enter on a docked grip floats the pane; Enter on the card's grip docks it again (at the end).
    floatToggle('p1');
    expect(document.querySelector('.float-card[data-float="p1"]')).not.toBeNull();
    expect(order()).toEqual(['p0', 'p2']);
    expect(live()).toBe('카드로 뗐습니다');
    // Arrows move the card (24px, 96 with Shift), clamped to the body — jsdom's body is 0×0, so the card pins to the corner.
    fireEvent.keyDown(grip('p1'), { key: 'ArrowDown', shiftKey: true });
    const stored = JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { float?: { x: number; y: number } }[] };
    expect(stored.panes.find((p) => p.float)!.float!.y).toBe(0);
    floatToggle('p1');
    expect(document.querySelector('.float-card')).toBeNull();
    expect(order()).toEqual(['p0', 'p2', 'p1']);
    expect(live()).toBe('패널에 붙였습니다');
  });

  it('the ◢ corner resizes a card from the keyboard; ⋯ 떠 있는 카드 정렬 deals two or more cards into a grid', async () => {
    const size = { w: 1200, h: 800 };
    const cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('body') ? size.w : 0; });
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('body') ? size.h : 0; });
    try {
      await boot();
      openSession('one');
      const split = screen.getByRole('button', { name: '새 분할' });
      fireEvent.click(split);
      openSession('two');
      fireEvent.click(split); // p0 p1 p2
      const grip = (id: string) => within(screen.getByTestId(`pane-${id}`)).getByTestId('session-chip-head');
      const floatOf = (id: string) => (JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { session: { sessionId: string } | null; float?: { x: number; y: number; w: number; h: number } }[] }).panes.find((p) => p.session?.sessionId === id)?.float;
      floatToggle('p0'); // s1 → card, 480 wide
      expect(floatOf('s1')).toMatchObject({ w: 480 });
      // One card: no 정렬 item.
      fireEvent.click(chipOf(screen.getByTestId('pane-p0')));
      expect(screen.queryByRole('menuitem', { name: /^떠 있는 카드 정렬/ })).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
      // ←→ change the width, ↑↓ the height (24px, 96 with Shift), never below the minimum; the handle says its size.
      const corner = within(document.querySelector('.float-card[data-float="p0"]') as HTMLElement).getByLabelText('카드 크기 조절');
      const before = floatOf('s1')!;
      fireEvent.keyDown(corner, { key: 'ArrowRight' });
      fireEvent.keyDown(corner, { key: 'ArrowDown', shiftKey: true });
      expect(floatOf('s1')).toMatchObject({ w: before.w + 24, h: before.h + 96 });
      expect(screen.getByTestId('cards-live').textContent).toBe(`카드 크기 ${before.w + 24} × ${before.h + 96}`);
      for (let i = 0; i < 20; i++) fireEvent.keyDown(corner, { key: 'ArrowLeft', shiftKey: true });
      expect(floatOf('s1')).toMatchObject({ w: 320 });
      expect(corner.getAttribute('aria-valuetext')).toBe(`320 × ${before.h + 96}`);
      // A second card: 정렬 lays both out side by side over the 1200 × 800 body.
      floatToggle('p1'); // s2 → card
      fireEvent.click(chipOf(screen.getByTestId('pane-p1')));
      fireEvent.click(screen.getByRole('menuitem', { name: '떠 있는 카드 정렬' })); // jsdom is not a Mac
      expect(floatOf('s1')).toEqual({ x: 12, y: 12, w: 582, h: 776 });
      expect(floatOf('s2')).toEqual({ x: 606, y: 12, w: 582, h: 776 });
      expect(screen.getByTestId('cards-live').textContent).toBe('카드 2장을 정렬했습니다');
    } finally { cw.mockRestore(); ch.mockRestore(); }
  });

  const mockBody = (size: { w: number; h: number }) => {
    const cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('body') ? size.w : 0; });
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('body') ? size.h : 0; });
    return () => { cw.mockRestore(); ch.mockRestore(); };
  };
  type StoredPane = { session: { sessionId: string } | null; float?: { x: number; y: number; w: number; h: number }; floatBySize?: Record<string, { x: number; y: number; w: number; h: number }> };
  const storedPane = (id: string) => (JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: StoredPane[] }).panes.find((p) => p.session?.sessionId === id);
  const threePanes = async () => {
    await boot();
    openSession('one');
    const split = screen.getByRole('button', { name: '새 분할' });
    fireEvent.click(split);
    openSession('two');
    fireEvent.click(split); // p0 p1 p2
  };
  const grip = (id: string) => within(screen.getByTestId(`pane-${id}`)).getByTestId('session-chip-head');
  const ctrlShiftG = () => fireEvent.keyDown(document.body, { key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true });

  it('Ctrl+⇧G arranges two or more floating cards; with one card the key stays the browser\'s', async () => {
    const restore = mockBody({ w: 1200, h: 800 });
    try {
      await threePanes();
      floatToggle('p0'); // one card
      const before = storedPane('s1')!.float;
      expect(ctrlShiftG()).toBe(true); // not prevented: find-previous is the browser's
      expect(storedPane('s1')!.float).toEqual(before);
      expect(screen.getByTestId('cards-live').textContent).toBe('카드로 뗐습니다');
      floatToggle('p1'); // two cards
      expect(ctrlShiftG()).toBe(false);
      expect(storedPane('s1')!.float).toEqual({ x: 12, y: 12, w: 582, h: 776 });
      expect(storedPane('s2')!.float).toEqual({ x: 606, y: 12, w: 582, h: 776 });
      expect(screen.getByTestId('cards-live').textContent).toBe('카드 2장을 정렬했습니다');
    } finally { restore(); }
  });

  it('double-click on a card\'s header maximizes it to the body and back; ⋯ offers the same, labelled by state', async () => {
    const restore = mockBody({ w: 1200, h: 800 });
    try {
      await threePanes();
      floatToggle('p0');
      const box = storedPane('s1')!.float!;
      const card = () => document.querySelector('.float-card[data-float="p0"]') as HTMLElement;
      const live = () => screen.getByTestId('cards-live').textContent;
      fireEvent.doubleClick(card().querySelector('.pane-head') as HTMLElement);
      expect(storedPane('s1')!.float).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
      expect(card().style.width).toBe('1200px');
      expect(live()).toBe('카드를 최대화했습니다');
      fireEvent.click(chipOf(screen.getByTestId('pane-p0')));
      expect(screen.queryByRole('menuitem', { name: '카드 최대화' })).toBeNull();
      fireEvent.click(screen.getByRole('menuitem', { name: '카드 원래 크기로' }));
      expect(storedPane('s1')!.float).toEqual(box);
      expect(live()).toBe('카드를 원래 크기로 되돌렸습니다');
      fireEvent.click(chipOf(screen.getByTestId('pane-p0')));
      fireEvent.click(screen.getByRole('menuitem', { name: '카드 최대화' }));
      expect(storedPane('s1')!.float).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
      // The bare header strip toggles; a double-click on the chip renames instead.
      fireEvent.doubleClick(grip('p0'));
      expect(storedPane('s1')!.float).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
      expect(within(card()).getByLabelText('채팅 이름')).toBeTruthy();
      fireEvent.keyDown(within(card()).getByLabelText('채팅 이름'), { key: 'Escape' });
      fireEvent.doubleClick(card().querySelector('.pane-head') as HTMLElement);
      expect(storedPane('s1')!.float).toEqual(box);
    } finally { restore(); }
  });

  it('자석: a dragged card\'s edge within 8px of another card\'s lands on it, with a guide line while dragging; Alt drags freely', async () => {
    const restore = mockBody({ w: 1200, h: 800 });
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1200, height: 800, left: 0, right: 1200, top: 0, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    try {
      await threePanes();
      floatToggle('p0'); // A
      floatToggle('p1'); // B
      const a = storedPane('s1')!.float!;
      const b = storedPane('s2')!.float!;
      const right = a.x + a.w;
      const drag = (dx: number, altKey: boolean, check?: () => void) => {
        fireEvent.pointerDown(grip('p1'), { clientX: 300, clientY: 400, pointerId: 1, button: 0, pointerType: 'mouse' });
        fireEvent.pointerMove(grip('p1'), { clientX: 300 + dx, clientY: 400, pointerId: 1, buttons: 1, altKey });
        check?.();
        fireEvent.pointerUp(grip('p1'), { clientX: 300 + dx, clientY: 400, pointerId: 1, altKey });
      };
      drag(right + 5 - b.x, false, () => {
        const line = document.querySelector('.floats .snap-line.v') as HTMLElement;
        expect(line).not.toBeNull();
        expect(line.style.left).toBe(`${right}px`);
      });
      expect(storedPane('s2')!.float!.x).toBe(right);
      expect(document.querySelector('.snap-line')).toBeNull(); // gone with the drag
      drag(5, true, () => expect(document.querySelector('.snap-line.v')).toBeNull());
      expect(storedPane('s2')!.float!.x).toBe(right + 5);
    } finally { rect.mockRestore(); restore(); }
  });

  it('– on a card\'s head folds it to the head (no ◢, its box kept); double-click on the folded head unfolds it (no maximize)', async () => {
    const restore = mockBody({ w: 1200, h: 800 });
    try {
      await threePanes();
      floatToggle('p0');
      const box = storedPane('s1')!.float!;
      const card = () => document.querySelector('.float-card[data-float="p0"]') as HTMLElement;
      const live = () => screen.getByTestId('cards-live').textContent;
      const fold = within(card()).getByRole('button', { name: '카드 접기' });
      expect(fold.textContent).toBe('–');
      fireEvent.click(fold);
      expect(card().classList.contains('collapsed')).toBe(true);
      expect(card().style.height).toBe('56px'); // the head's height (COLLAPSED_H); the body is hidden by .collapsed
      // The CSS hides everything under the pane but the head: the head's controls are outside what it hides.
      const hiddenBy = '.float-card.collapsed > .pane > :not(.chat):not(.pane-head), .float-card.collapsed .chat > :not(.pane-head)';
      for (const el of [within(card()).getByLabelText('카드 펼치기'), grip('p0')]) expect(el.closest(hiddenBy)).toBeNull();
      expect(card().querySelector('.composer')?.closest(hiddenBy)).not.toBeNull();
      expect(within(card()).queryByLabelText('카드 크기 조절')).toBeNull();
      expect(live()).toBe('카드를 접었습니다');
      expect(storedPane('s1')!.float).toEqual(box);
      expect(within(card()).getByRole('button', { name: '카드 펼치기' }).textContent).toBe('▭');
      fireEvent.doubleClick(card().querySelector('.pane-head') as HTMLElement);
      expect(card().classList.contains('collapsed')).toBe(false);
      expect(storedPane('s1')!.float).toEqual(box); // unfolded, not maximized
      expect(live()).toBe('카드를 펼쳤습니다');
      expect(within(card()).getByLabelText('카드 크기 조절')).toBeTruthy();
      // ⋯ offers the same, labelled by state.
      fireEvent.click(chipOf(screen.getByTestId('pane-p0')));
      fireEvent.click(screen.getByRole('menuitem', { name: '카드 접기' }));
      expect(card().classList.contains('collapsed')).toBe(true);
      fireEvent.click(chipOf(screen.getByTestId('pane-p0')));
      expect(screen.getByRole('menuitem', { name: '카드 펼치기' })).toBeTruthy();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      // The new-chat screen (its own head, no chat): the head stays out of the hidden part too.
      floatToggle('p2');
      const blank = document.querySelector('.float-card[data-float="p2"]') as HTMLElement;
      fireEvent.click(within(blank).getByRole('button', { name: '카드 접기' }));
      expect(blank.classList.contains('collapsed')).toBe(true);
      for (const el of [within(blank).getByLabelText('카드 펼치기'), grip('p2')]) expect(el.closest(hiddenBy)).toBeNull();
      expect(blank.querySelector('.newchat')?.closest(hiddenBy)).not.toBeNull();
    } finally { restore(); }
  });

  it('a folded card snaps and clamps by its head: it can go down to the body\'s bottom, its stored height unchanged', async () => {
    const restore = mockBody({ w: 1200, h: 800 });
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1200, height: 800, left: 0, right: 1200, top: 0, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    try {
      await threePanes();
      floatToggle('p0');
      const card = document.querySelector('.float-card[data-float="p0"]') as HTMLElement;
      fireEvent.click(within(card).getByRole('button', { name: '카드 접기' }));
      const box = storedPane('s1')!.float!;
      const drag = (toY: number, altKey = false) => {
        fireEvent.pointerDown(grip('p0'), { clientX: 300, clientY: 400, pointerId: 1, button: 0, pointerType: 'mouse' });
        fireEvent.pointerMove(grip('p0'), { clientX: 300, clientY: 400 + toY - storedPane('s1')!.float!.y, pointerId: 1, buttons: 1, altKey });
        fireEvent.pointerUp(grip('p0'), { clientX: 300, clientY: 400 + toY - storedPane('s1')!.float!.y, pointerId: 1 });
      };
      drag(800 - 56 - 5); // the head's bottom 5px above the body's: it snaps onto it
      expect(storedPane('s1')!.float).toEqual({ ...box, y: 800 - 56 });
      drag(2000, true); // past the bottom (Alt: no snap): held with the head still in view
      expect(storedPane('s1')!.float).toEqual({ ...box, y: 800 - 48 });
    } finally { rect.mockRestore(); restore(); }
  });

  it('⋯ 카드 배치…: saves the panes under a name, loads them back after a change, deletes', async () => {
    const restore = mockBody({ w: 1200, h: 800 });
    try {
      await threePanes();
      const dialog = () => screen.getByRole('dialog', { name: '카드 배치' });
      const live = () => screen.getByTestId('cards-live').textContent;
      const openDialog = (id: string) => {
        fireEvent.click(chipOf(screen.getByTestId(`pane-${id}`)));
        fireEvent.click(screen.getByRole('menuitem', { name: '카드 배치…' }));
      };
      openDialog('p0');
      expect(dialog().getAttribute('aria-modal')).toBe('true');
      const save = within(dialog()).getByRole('button', { name: '지금 배치 저장' }) as HTMLButtonElement;
      expect(save.disabled).toBe(true); // no name, no save
      fireEvent.change(within(dialog()).getByLabelText('배치 이름'), { target: { value: '작업' } });
      fireEvent.click(save);
      expect(within(dialog()).getAllByRole('listitem')).toHaveLength(1);
      expect(within(dialog()).getByText('작업')).toBeTruthy();
      expect(live()).toBe('배치 "작업" 을 저장했습니다');
      fireEvent.change(within(dialog()).getByLabelText('배치 이름'), { target: { value: '작업' } });
      expect(within(dialog()).getByRole('button', { name: '덮어쓰기' })).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: '카드 배치' })).toBeNull();
      // Change the layout: s1 becomes a card.
      floatToggle('p0');
      expect(document.querySelector('.float-card')).not.toBeNull();
      sock.frames = [];
      openDialog('p1');
      fireEvent.click(within(dialog()).getByRole('button', { name: '작업 불러오기' }));
      expect(screen.queryByRole('dialog', { name: '카드 배치' })).toBeNull();
      expect(document.querySelector('.float-card')).toBeNull();
      expect((document.querySelector('.panes') as HTMLElement).dataset.count).toBe('3');
      expect(frames().filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId)).toEqual(['s1', 's2']);
      expect((JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: StoredPane[] }).panes.map((p) => p.session?.sessionId ?? null)).toEqual(['s1', 's2', null]);
      expect(live()).toBe('배치 "작업" 을 불러왔습니다');
      // New panes after a load never reuse an id.
      fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
      fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
      const ids = screen.getAllByTestId(/^pane-/).map((el) => el.dataset.pane);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
      // Delete.
      openDialog(document.querySelector<HTMLElement>('.panes .pane')!.dataset.pane!);
      fireEvent.click(within(dialog()).getByRole('button', { name: '작업 삭제' }));
      expect(within(dialog()).getAllByRole('listitem')).toHaveLength(1); // asks once more
      fireEvent.click(within(dialog()).getByRole('button', { name: '작업 정말 삭제' }));
      expect(within(dialog()).queryAllByRole('listitem')).toHaveLength(0);
      expect(JSON.parse(localStorage.getItem('deck.layouts.v1')!)).toEqual([]);
    } finally { restore(); }
  });

  it('카드 배치: 삭제 goes back to itself after 3 s; a full store says it could not save; shortcuts stay off while it is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const restore = mockBody({ w: 1200, h: 800 });
    try {
      await threePanes();
      floatToggle('p0');
      floatToggle('p1'); // two cards: Ctrl+⇧G would arrange them
      const before = storedPane('s1')!.float;
      fireEvent.click(within(screen.getByTestId('pane-p2')).queryByTestId('session-chip-head') ?? within(screen.getByTestId('pane-p0')).getByTestId('session-chip-head'));
      fireEvent.click(screen.getByRole('menuitem', { name: '카드 배치…' }));
      const dialog = () => screen.getByRole('dialog', { name: '카드 배치' });
      expect(ctrlShiftG()).toBe(true); // not taken: the dialog is modal
      expect(storedPane('s1')!.float).toEqual(before);
      fireEvent.change(within(dialog()).getByLabelText('배치 이름'), { target: { value: 'a' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: '지금 배치 저장' }));
      fireEvent.click(within(dialog()).getByRole('button', { name: 'a 삭제' }));
      expect(within(dialog()).getByRole('button', { name: 'a 정말 삭제' })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(3100); });
      expect(within(dialog()).getByRole('button', { name: 'a 삭제' })).toBeTruthy();
      // The store refuses the write.
      const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
      try {
        fireEvent.change(within(dialog()).getByLabelText('배치 이름'), { target: { value: 'b' } });
        fireEvent.click(within(dialog()).getByRole('button', { name: '지금 배치 저장' }));
      } finally { set.mockRestore(); }
      expect(within(dialog()).getByText('저장하지 못했습니다(저장 공간 부족)')).toBeTruthy();
      expect(screen.getByTestId('cards-live').textContent).toBe('저장하지 못했습니다(저장 공간 부족)');
      expect(within(dialog()).getAllByRole('listitem')).toHaveLength(1);
      expect((within(dialog()).getByLabelText('배치 이름') as HTMLInputElement).value).toBe('b'); // kept to try again
    } finally { restore(); vi.useRealTimers(); }
  });

  it('a card remembers the box the user gave it per body size: a resize clamps at once, then (250 ms still) restores the box for that size — never records one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const size = { w: 1200, h: 800 };
    const restore = mockBody(size);
    try {
      await threePanes();
      floatToggle('p0');
      const start = storedPane('s1')!.float!;
      expect(storedPane('s1')!.floatBySize).toEqual({ '1200x800': start }); // where it was pulled off
      for (let i = 0; i < 9; i++) fireEvent.keyDown(grip('p0'), { key: 'ArrowRight', shiftKey: true });
      const wide = { ...start, x: start.x + 864 };
      expect(storedPane('s1')!.float).toEqual(wide);
      expect(storedPane('s1')!.floatBySize).toEqual({ '1200x800': wide });
      const card = () => document.querySelector('.float-card[data-float="p0"]') as HTMLElement;
      // Narrower: pulled in at once; holding still adds no 800×600 entry (only user moves record).
      size.w = 800; size.h = 600;
      fireEvent(window, new Event('resize'));
      const narrow = { x: 680, y: start.y, w: start.w, h: 600 };
      expect(storedPane('s1')!.float).toEqual(narrow);
      expect(card().style.left).toBe('680px');
      expect(storedPane('s1')!.floatBySize).toEqual({ '1200x800': wide });
      act(() => { vi.advanceTimersByTime(300); });
      expect(storedPane('s1')!.float).toEqual(narrow);
      expect(storedPane('s1')!.floatBySize).toEqual({ '1200x800': wide });
      // Back to 1200×800: nothing to pull in, then the box from before comes back.
      size.w = 1200; size.h = 800;
      fireEvent(window, new Event('resize'));
      expect(storedPane('s1')!.float).toEqual(narrow);
      act(() => { vi.advanceTimersByTime(300); });
      expect(storedPane('s1')!.float).toEqual(wide);
      expect(card().style.left).toBe(`${wide.x}px`);
    } finally { restore(); vi.useRealTimers(); }
  });

  it('a splitter between each pair of panes: dragging trades width between its two neighbours, double-click evens them out, the widths survive a reload', async () => {
    await boot();
    expect(screen.queryAllByRole('separator', { name: '패널 폭 조절' })).toHaveLength(0);
    const split = screen.getByRole('button', { name: '새 분할' });
    fireEvent.click(split);
    fireEvent.click(split);
    const bars = screen.getAllByRole('separator', { name: '패널 폭 조절' });
    expect(bars).toHaveLength(2);
    expect(bars[0]!.getAttribute('aria-orientation')).toBe('vertical');
    const panes = document.querySelector('.panes') as HTMLElement;
    expect(panes.style.gridTemplateColumns).toBe('minmax(var(--pane-min), 1fr) 6px minmax(var(--pane-min), 1fr) 6px minmax(var(--pane-min), 1fr)');
    // jsdom has no layout: each pane reports 500px wide.
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 500, height: 400, left: 0, right: 500, top: 0, bottom: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    try {
      fireEvent.pointerDown(bars[1]!, { clientX: 1000, pointerId: 1 });
      fireEvent.pointerMove(bars[1]!, { clientX: 1100, pointerId: 1 });
      fireEvent.pointerUp(bars[1]!, { clientX: 1100, pointerId: 1 });
    } finally { rect.mockRestore(); }
    expect(panes.style.gridTemplateColumns).toBe('minmax(var(--pane-min), 1fr) 6px minmax(var(--pane-min), 1.2fr) 6px minmax(var(--pane-min), 0.8fr)');
    const stored = JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { size?: number }[] };
    expect(stored.panes.map((p) => p.size ?? 1).map((x) => Number(x.toFixed(4)))).toEqual([1, 1.2, 0.8]);
    cleanup();
    sock.onMessage = null;
    await boot();
    const again = document.querySelector('.panes') as HTMLElement;
    expect(again.style.gridTemplateColumns).toContain('1.2fr');
    fireEvent.doubleClick(screen.getAllByRole('separator', { name: '패널 폭 조절' })[0]!);
    expect(again.style.gridTemplateColumns).toBe('minmax(var(--pane-min), 1fr) 6px minmax(var(--pane-min), 1fr) 6px minmax(var(--pane-min), 1fr)');
  });

  it('the split button is an icon with a name and a tooltip, no counter text', async () => {
    await boot();
    const split = screen.getByRole('button', { name: '새 분할' }) as HTMLButtonElement;
    expect(split.textContent).toBe('');
    expect(split.querySelector('svg')).not.toBeNull();
    expect(split.title).toMatch(/^새 분할 \(Ctrl\+⇧O\)/);
    fireEvent.click(split);
    expect(split.textContent).toBe('');
  });

  it('⋯ 분할 보기로 열기: a new pane opens the session — also one another pane already shows', async () => {
    await boot();
    openSession('one');
    const row = within(document.querySelector('.sidebar') as HTMLElement).getByText('one').closest('li')!;
    fireEvent.click(row.querySelector('[aria-label="세션 메뉴"]')!);
    fireEvent.click(screen.getByRole('menuitem', { name: '분할 보기로 열기' }));
    const panes = screen.getAllByTestId(/^pane-/);
    expect(panes).toHaveLength(2);
    expect(panes[1]!.classList.contains('active')).toBe(true);
    expect(within(panes[1]!).getByTitle(/^one(\s|$)/)).toBeTruthy();
    expect(within(panes[0]!).getByTitle(/^one(\s|$)/)).toBeTruthy();
    expect(frames().filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId)).toEqual(['s1', 's1']);
  });

  it('⋯ 새 탭으로 떼어내기: opens the session in a new tab and closes this pane; a lone pane has no such item', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      await boot();
      openSession('one');
      fireEvent.click(chipOf(lastPane()));
      expect(screen.queryByRole('menuitem', { name: '새 탭으로 떼어내기' })).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
      openSession('two');
      expect(screen.getAllByTestId(/^pane-/)).toHaveLength(2);
      fireEvent.click(chipOf(lastPane()));
      fireEvent.click(screen.getByRole('menuitem', { name: '새 탭으로 떼어내기' }));
      expect(open).toHaveBeenCalledWith(expect.stringContaining('?session=s2'), '_blank', 'noopener');
      expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
      expect(closes()).toEqual(['s2']);
    } finally {
      open.mockRestore();
    }
  });

  it('T9 (b): switching a pane to another session or closing it sends close_session only for sessions no pane still views', async () => {
    await boot();
    openSession('one');
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's1' });
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    openSession('two'); // p1 (active) → s2
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's2' });
    expect(closes()).toEqual([]);
    // A second view of s1 (the sidebar row would only bring p0 forward): ⋯ 분할 보기로 열기 → p2.
    fireEvent.click(within(document.querySelector('.sidebar') as HTMLElement).getByText('one').closest('li')!.querySelector('[aria-label="세션 메뉴"]')!);
    fireEvent.click(screen.getByRole('menuitem', { name: '분할 보기로 열기' }));
    closePane(screen.getByTestId('pane-p1')); // s2 is released
    expect(closes()).toEqual(['s2']);
    closePane(screen.getByTestId('pane-p2')); // p0 still shows s1
    expect(closes()).toEqual(['s2']);
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    openSession('two');
    closePane(lastPane());
    expect(closes()).toEqual(['s2', 's2']);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
  });

  it('a sidebar row already open in another pane brings that pane forward (no second copy); a row open nowhere loads into the focused pane', async () => {
    await boot();
    openSession('one'); // p0 → s1
    fireEvent.click(screen.getByRole('button', { name: '새 분할' })); // p1 (blank) active
    const opens = () => frames().filter((f) => f.type === 'open_session').length;
    const before = opens();
    const side = document.querySelector('.sidebar') as HTMLElement;
    expect(within(side).getByRole('img', { name: '1번 칸에 열림' })).toBeTruthy();
    openSession('one');
    expect(screen.getByTestId('pane-p0').classList.contains('active')).toBe(true);
    expect(chipOf(screen.getByTestId('pane-p1')).textContent).not.toContain('one');
    expect(opens()).toBe(before);
    expect(closes()).toEqual([]);
    // Back to the blank p1: a session no pane shows opens there as before.
    fireEvent.mouseDown(screen.getByTestId('pane-p1'));
    expect(screen.getByTestId('pane-p1').classList.contains('active')).toBe(true);
    openSession('two');
    expect(chipOf(screen.getByTestId('pane-p1')).textContent).toContain('two');
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's2' });
    expect(within(side).getByRole('img', { name: '2번 칸에 열림' })).toBeTruthy();
  });

  it('T9 (b): a pane closed while its open_session reply is in flight never gets its history into a blank pane', async () => {
    await boot();
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    openSession('two'); // p1 → s2, history not yet arrived
    closePane(screen.getByTestId('pane-p1'));
    expect(closes()).toEqual(['s2']);
    fireEvent.click(screen.getByRole('button', { name: '새 분할' })); // blank active pane (ids are reused: max remaining + 1)
    server({ type: 'history', sessionId: 's2', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [{ kind: 'user', text: 'stale-history', ts: null }] });
    expect(screen.queryByText('stale-history')).toBeNull();
    expect(within(lastPane()).getByLabelText('첫 메시지')).toBeTruthy(); // the new-chat screen
  });

  it('every send carries a fresh clientRef; a reconnect re-opens each viewed session once', async () => {
    await boot();
    openSession('one');
    server({ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [] });
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('보내기'));
    const send = frames().find((f) => f.type === 'send') as { clientRef?: string };
    expect(send.clientRef).toMatch(/.+/);
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    openSession('one');
    sock.frames = [];
    server({ type: 'hello', usage, projects: [], running: [], codex: { available: false } } as unknown as ServerMessage);
    expect(frames().filter((f) => f.type === 'open_session')).toEqual([{ type: 'open_session', sessionId: 's1' }]);
  });
});

/** A matchMedia mock whose `matches` can flip after mount (simulating a viewport/orientation change) and notifies listeners registered via useIsPhone's addEventListener('change', …). */
function mockMatchMedia(initialPhone: boolean) {
  let matches = initialPhone;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() { return matches && query.includes('720'); },
    media: query,
    onchange: null,
    addEventListener: (_: string, cb: () => void) => { listeners.add(cb); },
    removeEventListener: (_: string, cb: () => void) => { listeners.delete(cb); },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return { setPhone: (v: boolean) => act(() => { matches = v; listeners.forEach((cb) => cb()); }) };
}

describe('App type-to-compose', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('ASCII lands in the active composer; a Korean / IME key only moves focus and is swallowed; Space is left to the page', async () => {
    await boot();
    openSession('one');
    const ta = within(lastPane()).getByLabelText('메시지');
    (document.activeElement as HTMLElement | null)?.blur();
    expect(fireEvent.keyDown(document.body, { key: ' ' })).toBe(true);
    expect(document.activeElement).not.toBe(ta);
    expect(fireEvent.keyDown(document.body, { key: 'a' })).toBe(true); // default kept: the browser types it into the composer
    expect(document.activeElement).toBe(ta);
    ta.blur();
    expect(fireEvent.keyDown(document.body, { key: 'Process', keyCode: 229 })).toBe(false);
    expect(document.activeElement).toBe(ta);
    ta.blur();
    expect(fireEvent.keyDown(document.body, { key: 'ㅎ' })).toBe(false);
    expect(document.activeElement).toBe(ta);
  });

  it('a file dragged over the sidebar gets the no-drop cursor and never navigates; the chat pane keeps its own drop', async () => {
    await boot();
    openSession('one');
    const side = { types: ['Files'], files: [], items: [], dropEffect: 'copy' };
    expect(fireEvent.dragOver(document.querySelector('.sidebar')!, { dataTransfer: side })).toBe(false);
    expect(side.dropEffect).toBe('none');
    expect(fireEvent.drop(document.querySelector('.sidebar')!, { dataTransfer: side })).toBe(false);
    const pane = { types: ['Files'], files: [], items: [], dropEffect: 'copy' };
    expect(fireEvent.dragOver(within(lastPane()).getByLabelText('메시지'), { dataTransfer: pane })).toBe(false);
    expect(pane.dropEffect).toBe('copy');
    expect(fireEvent.dragOver(document.querySelector('.sidebar')!, { dataTransfer: { types: ['text/plain'] } })).toBe(true);
  });
});

describe('App phone layout (D10)', () => {
  beforeEach(() => {
    localStorage.clear(); // ux-state: the app restores its layout from localStorage
    sock.frames = [];
    sock.onMessage = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); (window as { matchMedia?: unknown }).matchMedia = undefined; });

  const layoutPane = (extra: Record<string, unknown>) => ({ session: null, model: 'auto', efforts: { claude: 'high', codex: 'medium', gemini: 'medium' }, autoEffort: null, engine: 'claude', sandbox: 'workspace-write', ...extra });
  const loadFromPalette = (name: string) => {
    fireEvent.keyDown(window, { code: 'KeyK', key: 'k', ctrlKey: true });
    fireEvent.click(screen.getByText('카드 배치 저장/불러오기'));
    fireEvent.click(screen.getByRole('button', { name: `${name} 불러오기` }));
  };

  it('phone: a layout with a card loads as tabs (the card parked, its box kept)', async () => {
    const box = { x: 40, y: 50, w: 400, h: 300 };
    localStorage.setItem('deck.layouts.v1', JSON.stringify([{ name: 'L', savedAt: 1, panes: [layoutPane({}), layoutPane({ float: box })] }]));
    mockMatchMedia(true);
    await boot();
    loadFromPalette('L');
    expect(document.querySelector('.float-card')).toBeNull();
    const stored = JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { float?: unknown; parkedFloat?: unknown }[] };
    expect(stored.panes.map((p) => [p.float, p.parkedFloat])).toEqual([[undefined, undefined], [undefined, box]]);
  });

  it('desktop: a layout saved on a phone (a parked box only) floats that card again', async () => {
    const box = { x: 40, y: 50, w: 400, h: 300 };
    localStorage.setItem('deck.layouts.v1', JSON.stringify([{ name: 'L', savedAt: 1, panes: [layoutPane({}), layoutPane({ parkedFloat: box })] }]));
    mockMatchMedia(false);
    await boot();
    loadFromPalette('L');
    expect(document.querySelector('.float-card')).not.toBeNull();
  });

  it('phone: drawer sidebar, single pane, no split button; opening a session closes the drawer', async () => {
    mockMatchMedia(true);
    await boot();
    expect(screen.queryByText('+ 분할')).toBeNull();
    const menu = screen.getByLabelText('메뉴');
    expect(document.querySelector('.sidebar-wrap.drawer.open')).toBeNull();
    fireEvent.click(menu);
    expect(document.querySelector('.sidebar-wrap.drawer.open')).not.toBeNull();
    openSession('one');
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's1' });
    expect(document.querySelector('.sidebar-wrap.drawer.open')).toBeNull();
    expect(document.querySelectorAll('.pane')).toHaveLength(1);
  });

  it('phone with two panes: only the active pane renders, and the pane switcher changes which one renders (PF16)', async () => {
    const mm = mockMatchMedia(false);
    await boot();
    openSession('one'); // p0 -> s1
    fireEvent.click(screen.getByRole('button', { name: '새 분할' })); // adds p1, active
    openSession('two'); // p1 -> s2
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(2);

    expect(screen.getAllByRole('separator', { name: '패널 폭 조절' })).toHaveLength(1);
    mm.setPhone(true);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
    expect(screen.queryAllByRole('separator', { name: '패널 폭 조절' })).toHaveLength(0);
    expect(screen.getByTestId('pane-p1')).toBeTruthy(); // active pane (p1) is the one shown
    expect(screen.queryByTestId('pane-p0')).toBeNull();

    fireEvent.click(screen.getByText(/^1 ·/)); // switcher: select pane 1 (p0)
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
    expect(screen.getByTestId('pane-p0')).toBeTruthy();
    expect(screen.queryByTestId('pane-p1')).toBeNull();
    // The tab row ends in +: another pane (as a tab), no ceiling.
    fireEvent.click(within(screen.getByTestId('split-tabs')).getByRole('button', { name: '새 분할' }));
    expect(screen.getByTestId('split-tabs').querySelectorAll('button[data-tab]')).toHaveLength(3);
    expect(screen.getByTestId('pane-p2')).toBeTruthy();
    // No grip / card menu on a phone: a card means nothing on one screen.
    expect(document.querySelector('[data-grip]')).toBeNull();
  });

  it('phone: a floating card restored from a desktop save becomes a plain tab (its box kept); tabs reorder by press-and-drag; a wide screen floats it again', async () => {
    localStorage.setItem('deck.ui.v1', JSON.stringify({ v: 1, active: 0, collapsed: [], drawer: false, panes: [
      { session: { sessionId: 's1', cwd: '/w', title: 'one', engine: null }, model: 'auto', efforts: { claude: 'high', codex: 'medium', gemini: 'medium' }, autoEffort: null, engine: 'claude', sandbox: 'workspace-write', float: { x: 10, y: 10, w: 400, h: 300 } },
      { session: { sessionId: 's2', cwd: '/w', title: 'two', engine: null }, model: 'auto', efforts: { claude: 'high', codex: 'medium', gemini: 'medium' }, autoEffort: null, engine: 'claude', sandbox: 'workspace-write' },
      { session: null, model: 'auto', efforts: { claude: 'high', codex: 'medium', gemini: 'medium' }, autoEffort: null, engine: 'claude', sandbox: 'workspace-write' },
    ] }));
    const mm = mockMatchMedia(true);
    await boot();
    const labels = () => Array.from(screen.getByTestId('split-tabs').querySelectorAll('button[data-tab]')).map((b) => b.textContent);
    // The float landed at the end: one, two, (blank) → two, blank, one.
    await waitFor(() => expect(labels()).toEqual(['1 · two', '2 · 새 세션', '3 · one']));
    const stored = () => JSON.parse(localStorage.getItem('deck.ui.v1')!) as { panes: { float?: unknown; parkedFloat?: unknown }[] };
    expect(stored().panes.some((p) => p.float)).toBe(false);
    expect(stored().panes[2]!.parkedFloat).toEqual({ x: 10, y: 10, w: 400, h: 300 });
    // Drag tab 3 (one) to the front: tabs 100 wide at 0 / 100 / 200.
    const tabs = Array.from(screen.getByTestId('split-tabs').querySelectorAll<HTMLElement>('button[data-tab]'));
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const i = tabs.indexOf(this as HTMLElement);
      const x = i >= 0 ? i * 100 : 0;
      return { width: i >= 0 ? 100 : 400, height: 30, left: x, right: x + (i >= 0 ? 100 : 400), top: 0, bottom: 30, x, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      const strip = screen.getByTestId('split-tabs');
      fireEvent.pointerDown(tabs[2]!, { clientX: 250, clientY: 15, pointerId: 1, button: 0, pointerType: 'mouse' });
      fireEvent.pointerMove(window, { clientX: 20, clientY: 15, pointerId: 1 });
      expect(strip.classList.contains('tabs-reordering')).toBe(true);
      fireEvent.pointerUp(window, { clientX: 20, clientY: 15, pointerId: 1 });
    } finally { rect.mockRestore(); }
    expect(labels()).toEqual(['1 · one', '2 · two', '3 · 새 세션']);
    // Back on a wide screen: the parked pane floats again where it was (it travelled to the front meanwhile).
    mm.setPhone(false);
    const card = document.querySelector('.float-card[data-float]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getAllByText('one').length).toBeGreaterThan(0);
    expect(stored().panes[0]).toMatchObject({ float: { x: 10, y: 10, w: 400, h: 300 } });
    expect(stored().panes.some((p) => p.parkedFloat)).toBe(false);
    // And a phone again parks it (no card, a tab at the end).
    mm.setPhone(true);
    expect(document.querySelector('.float-card')).toBeNull();
    expect(labels()).toEqual(['1 · two', '2 · 새 세션', '3 · one']);
  });

  it('usage strip: in the top bar on a desktop, a line of its own under the top bar on a phone', async () => {
    const numbered = { ...usage, accounts: { ...usage.accounts, a: { ...usage.accounts.a, fiveHour: { usedPct: 42, resetsAt: null } } } };
    mockMatchMedia(false);
    await boot();
    server({ type: 'usage', usage: numbered } as unknown as ServerMessage);
    expect(screen.getByTestId('usage-strip').closest('.topbar')).not.toBeNull();
    cleanup();
    mockMatchMedia(true);
    await boot();
    server({ type: 'usage', usage: numbered } as unknown as ServerMessage);
    const strip = screen.getByTestId('usage-strip');
    expect(strip.closest('.topbar')).toBeNull();
    const row = strip.closest('.usage-strip-row')!;
    // Portalled into the slot right after the top bar; the bar keeps no usage element of its own.
    expect(row.parentElement?.classList.contains('usage-strip-slot')).toBe(true);
    expect(row.parentElement?.previousElementSibling?.classList.contains('topbar')).toBe(true);
    expect(document.querySelector('.topbar [data-testid="usage-strip"], .topbar [data-testid="usage-chip"]')).toBeNull();
    // Phone: the mid stage (no bars).
    expect(strip.querySelector('.usage-seg-bar')).toBeNull();
  });

  it('Escape closes the open phone drawer', async () => {
    mockMatchMedia(true);
    await boot();
    fireEvent.click(screen.getByLabelText('메뉴'));
    expect(document.querySelector('.sidebar-wrap.drawer.open')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.sidebar-wrap.drawer.open')).toBeNull();
  });
});

describe('App 고정됨 reorder', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const pinnedTitles = () => [...screen.getByTestId('pinned-group').querySelectorAll('.session-title')].map((e) => e.textContent);
  const bootPinned = async () => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two')] }], pins: ['s1', 's2'], running: [], codex: { available: false } } as unknown as ServerMessage);
  };
  const moveFirstDown = () => fireEvent.keyDown(screen.getByTestId('pinned-group').querySelector('li button')!, { key: 'ArrowDown', altKey: true });

  it('shows the new order at once and saves it', async () => {
    let release: (r: Response) => void = () => {};
    const fetchFn = vi.fn((url: string) => (url === '/api/pins/order' ? new Promise<Response>((r) => { release = r; }) : Promise.resolve(new Response('{}', { status: 200 }))));
    vi.stubGlobal('fetch', fetchFn);
    await bootPinned();
    moveFirstDown();
    expect(pinnedTitles()).toEqual(['two', 'one']);
    expect(fetchFn).toHaveBeenCalledWith('/api/pins/order', expect.objectContaining({ body: JSON.stringify({ order: ['s2', 's1'] }) }));
    await act(async () => { release(new Response(JSON.stringify({ pins: ['s2', 's1'] }), { status: 200 })); });
    expect(pinnedTitles()).toEqual(['two', 'one']);
    expect(document.querySelector('.toast-item')).toBeNull();
  });

  it('a late answer to an older move does not undo a newer one (success or failure)', async () => {
    const pending: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/pins/order' ? new Promise<Response>((resolve, reject) => { pending.push({ resolve, reject }); }) : Promise.resolve(new Response('{}', { status: 200 })))));
    await bootPinned();
    moveFirstDown(); // two, one
    moveFirstDown(); // one, two
    expect(pinnedTitles()).toEqual(['one', 'two']);
    await act(async () => { pending[1]!.resolve(new Response(JSON.stringify({ pins: ['s1', 's2'] }), { status: 200 })); });
    await act(async () => { pending[0]!.resolve(new Response(JSON.stringify({ pins: ['s2', 's1'] }), { status: 200 })); });
    expect(pinnedTitles()).toEqual(['one', 'two']);
    moveFirstDown(); // two, one
    moveFirstDown(); // one, two
    await act(async () => { pending[3]!.resolve(new Response(JSON.stringify({ pins: ['s1', 's2'] }), { status: 200 })); });
    await act(async () => { pending[2]!.reject(new TypeError('Failed to fetch')); });
    expect(pinnedTitles()).toEqual(['one', 'two']);
    expect(document.querySelector('.toast-item')).toBeNull();
  });

  it('a failed save keeps a pin added meanwhile', async () => {
    let fail: (e: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/pins/order' ? new Promise<Response>((_, reject) => { fail = reject; }) : Promise.resolve(new Response('{}', { status: 200 })))));
    await bootPinned();
    moveFirstDown(); // two, one
    server({ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two'), entry('s3', 'three')] }], pins: ['s3', 's2', 's1'] } as unknown as ServerMessage);
    await act(async () => { fail(new TypeError('Failed to fetch')); });
    expect(pinnedTitles()).toEqual(['three', 'one', 'two']);
    expect(document.querySelector('.toast-item')?.textContent).toContain('고정 순서 변경 실패');
  });

  it('puts the old order back with a Korean error when the save fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url === '/api/pins/order') throw new TypeError('Failed to fetch'); return new Response('{}', { status: 200 }); }));
    await bootPinned();
    moveFirstDown();
    await waitFor(() => expect(document.querySelector('.toast-item')?.textContent).toContain('고정 순서 변경 실패: 네트워크 오류'));
    expect(pinnedTitles()).toEqual(['one', 'two']);
  });
});

describe('App ⌘1 … ⌘9 (고정됨)', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const bootPinned = async () => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two'), entry('s3', 'three')] }], pins: ['s2', 's1'], running: [], codex: { available: false } } as unknown as ServerMessage);
  };
  /** jsdom has no Mac platform: the modifier is Ctrl. Returns false when the key was taken (preventDefault). */
  const press = (n: number, extra: Record<string, unknown> = {}, target: Element | Window = window) => fireEvent.keyDown(target, { code: `Digit${n}`, key: String(n), ctrlKey: true, ...extra });
  const opened = () => frames().filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId);

  it('opens the nth pinned session in the active pane, in the sidebar order — also from the composer', async () => {
    await bootPinned();
    expect(press(1)).toBe(false);
    expect(opened()).toEqual(['s2']);
    expect(document.querySelector('.sidebar li.active .session-title')?.textContent).toBe('two');
    expect(press(2, {}, within(lastPane()).getByLabelText('메시지'))).toBe(false);
    expect(opened()).toEqual(['s2', 's1']);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
    expect(document.querySelector('.sidebar li.active .session-title')?.textContent).toBe('one');
  });

  it('opens from the composer while a Hangul syllable is still composing (the last one typed stays so until committed)', async () => {
    await bootPinned();
    press(1);
    const ta = within(lastPane()).getByLabelText('메시지');
    // What Chromium sends for ⌘2 right after typing "안녕하" (seen in a real browser): isComposing true, a real keyCode.
    expect(press(2, { isComposing: true, keyCode: 50 }, ta)).toBe(false);
    await waitFor(() => expect(opened()).toEqual(['s2', 's1'])); // after the commit's tick
  });

  it('mid-IME: commits the syllable into the draft it was typed in, then switches — each draft stays its own', async () => {
    localStorage.setItem('deck.draft.s2', JSON.stringify({ text: '그대로', at: Date.now() }));
    await bootPinned();
    press(2); // s1
    const ta = within(lastPane()).getByLabelText<HTMLTextAreaElement>('메시지');
    ta.focus();
    // "안녕하" with 하 still composing; a blur commits it (as Chromium does) — compositionend, then the committed value.
    fireEvent.compositionStart(ta);
    fireEvent.change(ta, { target: { value: '안녕하' } });
    let committedOnBlur = false;
    ta.addEventListener('blur', () => { committedOnBlur = true; fireEvent.compositionEnd(ta); fireEvent.change(ta, { target: { value: '안녕하' } }); }, { once: true });
    expect(press(1, { isComposing: true, keyCode: 49 }, ta)).toBe(false);
    expect(committedOnBlur).toBe(true);
    expect(opened()).toEqual(['s1']); // not yet: the switch waits a tick for the commit
    await waitFor(() => expect(opened()).toEqual(['s1', 's2']));
    const now = within(lastPane()).getByLabelText<HTMLTextAreaElement>('메시지');
    expect(now.value).toBe('그대로');
    expect(JSON.parse(localStorage.getItem('deck.draft.s1')!).text).toBe('안녕하');
    expect(JSON.parse(localStorage.getItem('deck.draft.s2')!).text).toBe('그대로');
  });

  it('follows the order the sidebar shows: a reorder and the 세션 검색 filter both renumber', async () => {
    await bootPinned();
    server({ type: 'index', projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two'), entry('s3', 'three')] }], pins: ['s1', 's2'] } as unknown as ServerMessage);
    press(1);
    expect(opened()).toEqual(['s1']);
    fireEvent.click(within(document.querySelector<HTMLElement>('.sidebar')!).getByRole('button', { name: '검색' }));
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'two' } });
    press(1);
    expect(opened()).toEqual(['s1', 's2']);
    expect(press(2)).toBe(true); // only one pinned row shows now
  });

  it('does nothing past the end of the list, with Shift / Alt, on a key repeat, or under a dialog — and leaves the key alone (a repeat excepted)', async () => {
    await bootPinned();
    expect(press(3)).toBe(true);
    expect(press(9)).toBe(true);
    expect(press(1, { shiftKey: true })).toBe(true);
    expect(press(2, { altKey: true })).toBe(true); // ⌘⌥N is the split-pane key: no 2nd pane, so left alone
    expect(press(1, { repeat: true })).toBe(false); // a held key is kept from the browser, but opens nothing
    expect(press(1, { ctrlKey: false })).toBe(true);
    fireEvent.keyDown(window, { code: 'KeyK', key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: '명령 팔레트' })).not.toBeNull();
    expect(press(1)).toBe(true);
    expect(opened()).toEqual([]);
  });
});

describe('App new build without a server restart', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    sock.frames = [];
    sock.onMessage = null;
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

  const bootWithBuild = async (build: string) => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ type: 'hello', usage, projects: [], running: [], codex: { available: false }, build } as unknown as ServerMessage);
  };

  it('coming back to the page asks /api/build; a new id offers the 새 버전 pill, the same id or a failed fetch does not', async () => {
    let answer: () => Response = () => new Response(JSON.stringify({ build: 'b1' }), { status: 200 });
    const fetchMock = vi.fn(async (url: string) => (url === '/api/build' ? answer() : new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.setItem('deck.reloadedFor', 'b2'); // already reloaded once for b2: the pill, not another reload
    await bootWithBuild('b1');
    const asked = () => fetchMock.mock.calls.filter((c) => c[0] === '/api/build').length;
    expect(asked()).toBe(0);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(asked()).toBe(1));
    expect(screen.queryByText(/새 버전이 있어요/)).toBeNull();
    answer = () => new Response('nope', { status: 500 });
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    await waitFor(() => expect(asked()).toBe(2));
    expect(screen.queryByText(/새 버전이 있어요/)).toBeNull();
    answer = () => new Response(JSON.stringify({ build: 'b2' }), { status: 200 });
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    expect(await screen.findByText(/새 버전이 있어요/)).toBeTruthy();
  });

  it('the avatar menu ends with 새로고침', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await bootWithBuild('b1');
    fireEvent.click(screen.getByRole('button', { name: '설정 및 계정' }));
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent ?? '');
    // 동작 항목은 새로고침으로 끝나고, 그 뒤엔 비활성 버전 줄만 온다
    expect(labels).toHaveLength(6);
    expect(labels[0]).toMatch(/^설정/);
    expect(labels[1]).toBe('사용량 기록');
    expect(labels[2]).toMatch(/^테마: /);
    expect(labels[3]).toMatch(/^단축키/);
    expect(labels[4]).toBe('새로고침');
    expect(labels[5]).toMatch(/^AI-MSG /);
    expect(screen.getByTestId('foot-menu-version').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('App boot', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('boot: an unreachable server is retried, not left at 확인 중…', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText('확인 중…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(screen.queryByText('확인 중…')).toBeNull());
    expect(fetchFn.mock.calls.filter((c) => c[0] === '/api/me').length).toBe(2);
  });

  it('boot: a server still starting (503) is retried, not taken for logged out', async () => {
    const fetchFn = vi.fn()
      .mockImplementationOnce(async () => new Response('시작 중', { status: 503, headers: { 'retry-after': '2' } }))
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText('확인 중…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '로그인' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(screen.queryByText('확인 중…')).toBeNull());
    expect(fetchFn.mock.calls.filter((c) => c[0] === '/api/me').length).toBe(2);
    expect(screen.queryByRole('button', { name: '로그인' })).toBeNull();
  });

  it('boot: 401 is logged out at once (the token screen), without retrying', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchFn);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByRole('button', { name: '로그인' })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetchFn.mock.calls.filter((c) => (c as unknown[])[0] === '/api/me').length).toBe(1);
  });

  it('boot: a server that keeps not answering says so in plain words, with a retry button; Tailscale only under 자세히', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText('확인 중…')).toBeTruthy();
    // Misses at 0, 3, 6, 9 s: four — still 확인 중…; the fifth (12 s) names the cause.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000 * 3 + 100); });
    expect(screen.queryByText('서버에 연결할 수 없어요')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('서버에 연결할 수 없어요')).toBeTruthy();
    // Only the headline is the live status; the buttons sit outside it.
    expect(screen.getByRole('status').textContent).toBe('서버에 연결할 수 없어요');
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    const more = screen.getByText('자세히').closest('details')!;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain('Tailscale');
    expect(screen.getByText('서버에 연결할 수 없어요').textContent).not.toContain('Tailscale');
  });

  it('a long disconnect shows since when the server stopped answering and offers 다시 시도; reconnecting clears it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    vi.setSystemTime(new Date(2026, 9, 11, 0, 25, 0));
    sock.retries = 0;
    await boot();
    const dot = screen.getByTestId('activity-btn');
    expect(dot.getAttribute('aria-label')).toBe('활동');
    expect(document.querySelector('.conn')).toBeNull(); // no 연결됨 text in the top bar any more
    act(() => sock.onStatus!(false));
    // The dot turns danger; a short blip (a restart) says 재연결 중… in the sheet, no banner yet.
    expect(dot.classList.contains('lvl-down')).toBe(true);
    expect(dot.getAttribute('aria-label')).toBe('활동 · 연결 끊김');
    fireEvent.click(dot);
    expect(within(screen.getByTestId('act-conn')).getByText('재연결 중…')).toBeTruthy();
    expect(screen.queryByText(/서버에 연결할 수 없어요/)).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '활동' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
    expect(screen.getByText(/서버에 연결할 수 없어요 · 00:25부터 — 연결되면/)).toBeTruthy();
    // Both the banner's button and the sheet's retry now.
    fireEvent.click(screen.getByText('다시 시도'));
    fireEvent.click(dot);
    expect(within(screen.getByTestId('act-conn')).getByText('서버에 연결할 수 없어요 · 00:25부터')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('act-conn')).getByRole('button', { name: '다시 시도' }));
    expect(sock.retries).toBe(2);
    act(() => sock.onStatus!(true));
    expect(screen.queryByText(/서버에 연결할 수 없어요/)).toBeNull();
    expect(screen.queryByTestId('act-conn')).toBeNull();
    expect(dot.classList.contains('lvl-down')).toBe(false);
  });
});

describe('App error toasts', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const toasts = () => [...document.querySelectorAll('.toast-item')].map((e) => e.textContent);

  it('a server error shows as an error toast, not the old band', async () => {
    await boot();
    server({ type: 'error', turnId: null, message: '세션을 열 수 없습니다' } as ServerMessage);
    expect(screen.getByRole('alert').textContent).toContain('세션을 열 수 없습니다');
    expect(document.querySelector('.banner.error')).toBeNull();
  });

  it('"already resolved" replies (another device answered the card) show nothing', async () => {
    await boot();
    server({ type: 'error', turnId: null, message: '이미 처리된 권한 요청입니다', requestId: 'r1' } as ServerMessage);
    server({ type: 'error', turnId: null, message: '이미 처리된 질문입니다', requestId: 'q1' } as ServerMessage);
    expect(toasts()).toEqual([]);
    expect(document.body.textContent).not.toContain('이미 처리된');
  });

  it('two errors show two toasts, newest on top, and × closes one', async () => {
    await boot();
    server({ type: 'error', turnId: null, message: 'first' } as ServerMessage);
    server({ type: 'error', turnId: null, message: 'second' } as ServerMessage);
    expect(toasts()).toHaveLength(2);
    expect(toasts()[0]).toContain('second');
    fireEvent.click(screen.getAllByRole('button', { name: '닫기' })[0]!);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toContain('first');
  });

  it('the same error twice is two toasts (the slot is cleared once it becomes a toast)', async () => {
    await boot();
    server({ type: 'error', turnId: null, message: 'same' } as ServerMessage);
    server({ type: 'error', turnId: null, message: 'same' } as ServerMessage);
    expect(toasts()).toHaveLength(2);
  });
});

describe('App top bar: 작업 현황 · 서버 상태 · 다음 턴', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); sock.frames = []; sock.onMessage = null; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); (window as { matchMedia?: unknown }).matchMedia = undefined; });

  const act1 = (sessionId: string, running: boolean, bg: number) => ({ sessionId, cwd: '/w', turnId: `t-${sessionId}`, running, bg, forMs: 0 });
  const activity = (sessions: ReturnType<typeof act1>[], extra: Record<string, unknown> = {}) => server({ type: 'activity', sessions, serverStartedAt: 1, ...extra } as ServerMessage);
  const permission = (sessionId: string | null, n = 0, cwd = '/w') => server({ type: 'permission_request', requestId: `r-${sessionId}-${n}`, toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: false, sessionLabel: null, turnId: `t-${sessionId}`, sessionId, cwd } as ServerMessage);
  const PREVIEW = ['routePreview'];

  const numbered = { ...usage, accounts: { ...usage.accounts, a: { ...usage.accounts.a, fiveHour: { usedPct: 42, resetsAt: null } } } };

  it('the usage strip toggles the usage sheet; ✕ hands focus back to the strip', async () => {
    await boot();
    server({ type: 'usage', usage: numbered } as unknown as ServerMessage);
    const btn = screen.getByTestId('usage-strip');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.focus();
    fireEvent.click(btn);
    expect(screen.getByRole('dialog', { name: '사용량' })).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('닫기');
    fireEvent.click(btn);
    expect(screen.queryByRole('dialog', { name: '사용량' })).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    fireEvent.click(within(screen.getByRole('dialog', { name: '사용량' })).getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('dialog', { name: '사용량' })).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it('아바타 메뉴 → 사용량 기록 (설정 has no row for it): the sheet opens with the history; closing it lands focus on the top bar usage strip', async () => {
    await boot();
    server({ type: 'usage', usage: numbered } as unknown as ServerMessage);
    act(() => { window.dispatchEvent(new Event('deck:open-settings')); });
    expect(within(screen.getByRole('dialog', { name: '설정' })).queryByRole('button', { name: '사용량 보기' })).toBeNull();
    fireEvent.click(within(screen.getByRole('dialog', { name: '설정' })).getByRole('button', { name: '닫기' }));
    fireEvent.click(screen.getByRole('button', { name: '설정 및 계정' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '사용량 기록' }));
    const sheet = screen.getByRole('dialog', { name: '사용량' });
    expect(within(sheet).getByRole('button', { name: /토큰 사용량 기록/ }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(sheet).getByRole('button', { name: '닫기' }));
    expect(document.activeElement).toBe(screen.getByTestId('usage-strip'));
  });

  const dot = () => screen.getByTestId('activity-btn');
  const openSheet = () => { fireEvent.click(dot()); return screen.getByRole('dialog', { name: '활동' }); };
  const rowsOf = (sec: string) => within(screen.getByTestId(sec)).getAllByRole('button').filter((b) => b.classList.contains('act-row'));

  it('활동 점: one state at a time; 승인 대기 counts cards in a badge and wins; the label lists the counts', async () => {
    await boot();
    activity([]);
    expect(dot().classList.contains('lvl-idle')).toBe(true);
    expect(dot().getAttribute('aria-label')).toBe('활동');
    expect(screen.queryByTestId('activity-badge')).toBeNull();
    activity([act1('s1', true, 0)]);
    expect(dot().classList.contains('lvl-running')).toBe(true);
    expect(dot().getAttribute('aria-label')).toBe('활동 · 실행 중 1');
    activity([act1('s1', false, 2)]);
    expect(dot().classList.contains('lvl-bg')).toBe(true);
    activity([act1('s1', true, 0), act1('s2', false, 2)]);
    expect(dot().getAttribute('aria-label')).toBe('활동 · 실행 중 1 · 백그라운드 1');
    permission('s3');
    expect(dot().classList.contains('lvl-waiting')).toBe(true);
    expect(screen.getByTestId('activity-badge').textContent).toBe('1');
    expect(dot().getAttribute('aria-label')).toBe('활동 · 승인 대기 1 · 실행 중 1 · 백그라운드 1');
    expect(dot().getAttribute('aria-haspopup')).toBe('dialog');
    permission('s3', 1);
    expect(screen.getByTestId('activity-badge').textContent).toBe('2');
    server({ type: 'permission_resolved', requestId: 'r-s3-0' } as ServerMessage);
    server({ type: 'permission_resolved', requestId: 'r-s3-1' } as ServerMessage);
    expect(screen.queryByTestId('activity-badge')).toBeNull();
  });

  it('시트: 승인 대기 cards are answered right in the sheet; the card head opens its session', async () => {
    await boot();
    permission('s2');
    const sheet = openSheet();
    expect(within(sheet).getByTestId('act-waiting').querySelector('.act-sec-title')!.textContent).toBe('승인 대기 1');
    sock.frames = [];
    fireEvent.click(within(screen.getByTestId('act-waiting')).getByRole('button', { name: '허용 1회' }));
    expect(frames()).toContainEqual({ type: 'permission_response', requestId: 'r-s2-0', decision: 'once' });
    expect(screen.getByRole('dialog', { name: '활동' })).toBeTruthy(); // answered without leaving the sheet
    fireEvent.click(rowsOf('act-waiting')[0]!);
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's2' });
    expect(screen.queryByRole('dialog', { name: '활동' })).toBeNull();
  });

  it('시트: 실행 중 rows open their session or 중단 its turn; a session with a card shows only under 승인 대기', async () => {
    await boot();
    activity([act1('s1', true, 0), act1('s2', true, 0)]);
    permission('s2');
    openSheet();
    expect(rowsOf('act-running').map((r) => r.textContent)).toEqual(['one실행 중']);
    sock.frames = [];
    fireEvent.click(within(screen.getByTestId('act-running')).getByRole('button', { name: 'one 중단' }));
    expect(frames()).toContainEqual({ type: 'interrupt', turnId: 't-s1' });
    fireEvent.click(rowsOf('act-running')[0]!);
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's1' });
    expect(screen.queryByRole('dialog', { name: '활동' })).toBeNull();
  });

  it('시트: 백그라운드 lists sessions with their task titles and /bg tasks with 승인 대기 and 취소', async () => {
    await boot(['tasks']);
    server({ type: 'activity', sessions: [{ ...act1('s1', false, 2), tasks: ['dev server', 'watch'] }], serverStartedAt: 1 } as ServerMessage);
    server({ type: 'tasks', tasks: [{ taskId: 'k1', fromSessionId: 's1', cwd: '/w', title: '리팩터', status: 'running', sessionId: 's7', createdAt: 1, waiting: true }, { taskId: 'k2', fromSessionId: 's1', cwd: '/w', title: '끝난 일', status: 'done', sessionId: 's8', createdAt: 1 }], cap: 3 } as ServerMessage);
    // A task stopped on a card counts as 승인 대기 even when its card is not here.
    expect(screen.getByTestId('activity-badge').textContent).toBe('1');
    openSheet();
    const bg = screen.getByTestId('act-bg');
    expect(rowsOf('act-bg').map((r) => r.textContent)).toEqual(['one백그라운드 2']);
    expect(bg.textContent).toContain('· dev server');
    const tasks = within(bg).getAllByTestId('act-task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.textContent).toContain('승인 대기');
    sock.frames = [];
    fireEvent.click(within(tasks[0]!).getByRole('button', { name: '취소' }));
    expect(frames()).toContainEqual({ type: 'cancel_task', taskId: 'k1' });
    fireEvent.click(within(tasks[0]!).getByRole('button', { name: '열어 보기' }));
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's7' });
  });

  it('시트: a card with no pane opens in its folder; a new chat\'s card (no id yet) heads as 새 대화', async () => {
    await boot();
    permission('s9', 0, '/w/other');
    permission(null);
    openSheet();
    expect(rowsOf('act-waiting').map((r) => r.textContent)).toEqual(['other열기', '새 대화열기']);
    sock.frames = [];
    fireEvent.click(rowsOf('act-waiting')[0]!);
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's9' });
  });

  it('시트: a modal dialog — Escape closes it and gives focus back to the dot; Tab stays inside', async () => {
    await boot();
    activity([act1('s1', true, 0)]);
    dot().focus();
    const sheet = openSheet();
    expect(dot().getAttribute('aria-expanded')).toBe('true');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    const close = within(sheet).getByRole('button', { name: '닫기' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).not.toBe(close);
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '활동' })).toBeNull();
    expect(document.activeElement).toBe(dot());
    expect(dot().getAttribute('aria-expanded')).toBe('false');
  });

  it('비어 있음: the sheet says nothing is running (with when work ended, once seen) and offers 새 대화', async () => {
    await boot();
    let sheet = openSheet();
    expect(within(sheet).getByText('지금 실행 중인 작업이 없어요')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: '새 대화' }));
    expect(screen.queryByRole('dialog', { name: '활동' })).toBeNull();
    activity([act1('s1', true, 0)]);
    activity([]);
    sheet = openSheet();
    expect(within(sheet).getByText(/^지금 실행 중인 작업이 없어요 · \d\d:\d\d 까지 작업$/)).toBeTruthy();
  });

  it('하이라이트: the sheet row and the palette action show only when the server has the feature; 설정 never has a row', async () => {
    const press = () => fireEvent.keyDown(window, { code: 'KeyK', key: '', ctrlKey: true });
    await boot();
    openSheet();
    expect(screen.queryByTestId('act-highlights')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    press();
    expect(screen.queryByText('하이라이트 보기')).toBeNull();
    fireEvent.keyDown(screen.getByLabelText('세션 검색 또는 명령'), { key: 'Escape' });
    act(() => { window.dispatchEvent(new CustomEvent('deck:open-settings')); });
    expect(within(screen.getByRole('dialog', { name: '설정' })).queryByRole('button', { name: '하이라이트' })).toBeNull();
    cleanup();
    sock.onMessage = null;
    await boot(['highlights']);
    openSheet();
    fireEvent.click(screen.getByTestId('act-highlights'));
    expect(screen.getByRole('dialog', { name: '하이라이트' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '활동' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    press();
    expect(screen.getByText('하이라이트 보기')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('세션 검색 또는 명령'), { key: 'Escape' });
    act(() => { window.dispatchEvent(new CustomEvent('deck:open-settings')); });
    expect(within(screen.getByRole('dialog', { name: '설정' })).queryByRole('button', { name: '하이라이트' })).toBeNull();
  });

  it('하이라이트: asks once connected (not without the feature), the sheet row shows the 24h count', async () => {
    const list = { events: [{ at: 1, kind: 'turn', sessionId: 's1', cwd: '/w', title: 'one', body: '완료', ok: true }, { at: 2, kind: 'turn', sessionId: 's1', cwd: '/w', title: 'one', body: '완료', ok: true }, { at: 3, kind: 'task', sessionId: 's1', cwd: '/w', title: 'one', body: 'x', ok: true }] };
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify(list), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await boot();
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/highlights?hours=24')).toHaveLength(0);
    cleanup();
    sock.onMessage = null;
    await boot(['highlights']);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/highlights?hours=24')).toHaveLength(1));
    openSheet();
    await waitFor(() => expect(screen.getByTestId('act-highlights').textContent).toBe('하이라이트 2보기 →'));
  });

  it('하이라이트: asks again 2s after a turn ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ events: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await boot(['highlights']);
    const asks = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/api/highlights?hours=24').length;
    await waitFor(() => expect(asks()).toBe(1));
    activity([act1('s1', true, 0)]);
    activity([]);
    act(() => { vi.advanceTimersByTime(1_900); });
    expect(asks()).toBe(1);
    act(() => { vi.advanceTimersByTime(200); });
    expect(asks()).toBe(2);
  });

  it('서버: uptime from serverStartedAt; draining and 재시작됨 take its place; no section without a start time', async () => {
    await boot();
    openSheet();
    expect(screen.queryByTestId('act-server')).toBeNull();
    activity([], { serverStartedAt: Date.now() - 3 * 3_600_000 - 60_000 });
    const up = screen.getByTestId('server-uptime');
    expect(up.textContent).toBe('서버 · 3시간째');
    expect(up.title).toMatch(/^서버 시작 \d+\/\d+ \d\d:\d\d$/);
    activity([act1('s1', true, 0)], { serverStartedAt: Date.now() - 3 * 3_600_000, draining: true });
    expect(screen.queryByTestId('server-uptime')).toBeNull();
    expect(screen.getByTestId('drain-status').textContent).toBe('재시작 대기 중 · 작업 1개 기다림');
    expect(dot().classList.contains('lvl-running')).toBe(false);
    expect(dot().classList.contains('lvl-server')).toBe(true);
    expect(dot().querySelector('.activity-ring')!.textContent).toBe('↻');
    // A row of what the restart waits for opens its session.
    sock.frames = [];
    fireEvent.click(within(screen.getByTestId('act-server')).getByRole('button', { name: /^one/ }));
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's1' });
    activity([], { serverStartedAt: Date.now() - 60_000 });
    openSheet();
    expect(screen.getByText(/^재시작됨 \d\d:\d\d$/)).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('act-server')).getByRole('button', { name: '닫기' }));
    expect(screen.queryByText(/^재시작됨/)).toBeNull();
    expect(screen.getByTestId('server-uptime').textContent).toBe('서버 · 1분째');
  });

  it('draining: 재시작 대기 중 · 작업 N개 기다림, or 재시작 중… when nothing is left', async () => {
    await boot();
    activity([act1('s1', true, 0), act1('s2', false, 1)], { draining: true });
    openSheet();
    expect(screen.getByTestId('drain-status').textContent).toBe('재시작 대기 중 · 작업 2개 기다림');
    activity([], { draining: true });
    expect(screen.getByTestId('drain-status').textContent).toBe('재시작 중…');
    activity([]);
    expect(screen.queryByTestId('drain-status')).toBeNull();
  });

  it('재시작됨 HH:MM appears only when serverStartedAt changes (one toast), and goes on 닫기 or after 10 minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await boot();
    openSheet();
    activity([], { serverStartedAt: 100 });
    expect(screen.queryByText(/재시작됨/)).toBeNull();
    activity([], { serverStartedAt: 100 });
    expect(screen.queryByText(/재시작됨/)).toBeNull();
    activity([], { serverStartedAt: 200 });
    expect([...document.querySelectorAll('.toast-item')].filter((t) => /서버가 다시 시작됐어요 · \d\d:\d\d/.test(t.textContent ?? ''))).toHaveLength(1);
    fireEvent.click(within(screen.getByTestId('act-server')).getByRole('button', { name: '닫기' }));
    expect(screen.queryByText(/^재시작됨/)).toBeNull();
    activity([], { serverStartedAt: 300 });
    expect(screen.getByText(/^재시작됨/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10 * 60_000 + 1); });
    expect(screen.queryByText(/^재시작됨/)).toBeNull();
  });

  it('an older server\'s activity without serverStartedAt shows no 재시작됨 (and no NaN:NaN)', async () => {
    await boot();
    openSheet();
    activity([], { serverStartedAt: 100 });
    activity([], { serverStartedAt: undefined });
    activity([], { serverStartedAt: undefined });
    expect(screen.queryByText(/재시작됨/)).toBeNull();
    expect(document.body.textContent).not.toContain('NaN');
    activity([], { serverStartedAt: 100 }); // the start it had is kept: still the same server
    expect(screen.queryByText(/재시작됨/)).toBeNull();
  });

  it('재시작됨 survives a reload: the first activity after it is compared with the server this tab saw last', async () => {
    await boot();
    activity([], { serverStartedAt: 100 });
    cleanup(); // the reload: the page goes, sessionStorage stays
    sock.onMessage = null;
    await boot();
    activity([], { serverStartedAt: 200 });
    openSheet();
    expect(screen.getByText(/^재시작됨 \d\d:\d\d$/)).toBeTruthy();
    cleanup(); // a second reload keeps what was showing, without a second toast
    sock.onMessage = null;
    await boot();
    openSheet();
    expect(screen.getByText(/^재시작됨 \d\d:\d\d$/)).toBeTruthy();
    expect(screen.queryByText(/서버가 다시 시작됐어요/)).toBeNull();
    activity([], { serverStartedAt: 200 });
    fireEvent.click(within(screen.getByTestId('act-server')).getByRole('button', { name: '닫기' }));
    cleanup();
    sock.onMessage = null;
    await boot();
    openSheet();
    expect(screen.queryByText(/재시작됨/)).toBeNull();
  });

  it('reconnect: disconnect → hello → activity from a new process shows 재시작됨 and asks route_preview again', async () => {
    await boot(PREVIEW);
    openSession('one');
    activity([], { serverStartedAt: 100 });
    sock.frames = [];
    act(() => sock.onStatus!(false));
    server(hello(PREVIEW));
    activity([], { serverStartedAt: 200 });
    openSheet();
    expect(screen.getByText(/^재시작됨 \d\d:\d\d$/)).toBeTruthy();
    expect(frames()).toContainEqual({ route_preview: undefined, type: 'route_preview', sessionId: 's1', cwd: '/w' });
  });

  it('폰: another session\'s approval → the dot\'s badge number, one toast (열기 opens it, read out once); answered from the sheet', async () => {
    mockMatchMedia(true);
    await boot();
    // Cards already waiting right after connecting are shown, not toasted: wait that window out.
    await act(async () => { await new Promise((r) => setTimeout(r, ALERT_SEED_MS + 20)); });
    openSession('one');
    activity([act1('s1', true, 0)], { draining: true });
    expect(screen.queryByTestId('work-chip')).toBeNull();
    // The open session's own card raises no toast (it is on screen).
    server({ type: 'permission_request', requestId: 'own', toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: false, sessionLabel: null, turnId: 't-s1', sessionId: 's1', cwd: '/w' } as ServerMessage);
    const toasts = () => [...document.querySelectorAll('.toast-item')].filter((t) => (t.textContent ?? '').includes('승인 대기'));
    expect(toasts()).toHaveLength(0);
    permission('s2');
    expect(screen.getByTestId('activity-badge').textContent).toBe('2');
    expect(dot().getAttribute('aria-label')).toBe('활동 · 승인 대기 2 · 실행 중 1');
    expect(toasts()).toHaveLength(1);
    const toast = toasts()[0] as HTMLElement;
    expect(toast.textContent).toContain('two · 승인 대기');
    // Read out by the toast's own live region only — not a second time in the cards' live line.
    expect(toast.getAttribute('role')).toBe('status');
    expect(screen.getByTestId('cards-live').textContent).not.toContain('승인 대기');
    // The same card again (a reconnect's snapshot) does not toast twice.
    permission('s2');
    expect(toasts()).toHaveLength(1);
    sock.frames = [];
    fireEvent.click(within(toast).getByRole('button', { name: '열기' }));
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's2' });
    expect(toasts()).toHaveLength(0);
    const sheet = openSheet();
    expect(within(sheet).getAllByRole('button', { name: '허용 1회' }).length).toBe(2);
  });

  it('다음 턴: an open Claude session asks route_preview and its answer tags that account', async () => {
    await boot(PREVIEW);
    openSession('one');
    expect(frames()).toContainEqual({ type: 'route_preview', sessionId: 's1', cwd: '/w' });
    server({ type: 'route_preview', sessionId: 's1', account: 'c', reason: '5h 여유', asOpus: true } as ServerMessage);
    // The usage strip marks where the next turn goes (→ before C until the session's own account is known); the
    // reason is in its title.
    const tag = screen.getByTestId('next-c');
    expect(tag.textContent).toBe('→');
    expect(screen.getByTestId('seg-c').contains(tag)).toBe(true);
    expect(screen.getByTestId('usage-strip').title).toContain('5h 여유');
    expect(screen.getByTestId('usage-strip').getAttribute('aria-label')).toContain('다음 턴 C(Opus)');
    server({ type: 'route_preview', sessionId: 'other', account: 'a', reason: 'x' } as ServerMessage);
    expect(screen.queryByTestId(/^next-/)).toBeNull(); // an answer for another session is not shown
  });

  it('다음 턴: moving to a GPT session withdraws the ask ({ sessionId: null }, no cwd)', async () => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ ...hello(PREVIEW), projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), { ...entry('g1', 'gee'), account: 'gpt' }] }] } as ServerMessage);
    openSession('one');
    server({ type: 'route_preview', sessionId: 's1', account: 'c', reason: 'r' } as ServerMessage);
    sock.frames = [];
    openSession('gee');
    server({ type: 'history', sessionId: 'g1', cwd: '/w', account: 'gpt', engine: 'codex', messages: [], runningTurnId: null } as ServerMessage);
    // Until its history says which engine it is, the session is asked about (the server has no answer for GPT).
    expect(frames().filter((f) => f.type === 'route_preview').at(-1)).toEqual({ type: 'route_preview', sessionId: null });
    sock.frames = [];
    server({ type: 'usage', usage } as unknown as ServerMessage);
    expect(frames().some((f) => f.type === 'route_preview')).toBe(false);
    expect(screen.queryByTestId(/^next-/)).toBeNull();
  });

  it('다음 턴: a server without the routePreview feature is never asked', async () => {
    await boot();
    openSession('one');
    expect(frames().some((f) => f.type === 'route_preview')).toBe(false);
  });

  it('다음 턴: no session, no ask and no tag', async () => {
    await boot(PREVIEW);
    expect(frames().some((f) => f.type === 'route_preview')).toBe(false);
    expect(screen.queryByTestId(/^next-/)).toBeNull();
  });
});

describe('App setup wizard · address token login', () => {
  const status = { engines: [{ engine: 'claude', bin: '/b/claude', version: '2.1.0', login: 'yes', loginCommand: 'claude auth login' }], claudeProfiles: [], addresses: [], needed: true, supervised: false, restartNeeded: false, accountsFile: true, checkedAt: '2026-10-21T00:00:00.000Z' };
  const fetchFn = vi.fn(async (url: unknown) => new Response(JSON.stringify(url === '/api/setup' ? status : {}), { status: 200 }));
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; fetchFn.mockClear(); vi.stubGlobal('fetch', fetchFn); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

  it('opens the wizard when hello says setup is needed', async () => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ ...hello(['setup']), setup: { needed: true } } as ServerMessage);
    expect(await screen.findByRole('dialog', { name: '설치 점검' })).toBeTruthy();
    // Closed, a reconnect's hello does not bring it back.
    fireEvent.click(within(screen.getByRole('dialog', { name: '설치 점검' })).getByRole('button', { name: '닫기' }));
    server({ ...hello(['setup']), setup: { needed: true } } as ServerMessage);
    expect(screen.queryByRole('dialog', { name: '설치 점검' })).toBeNull();
  });

  it('does not open it for a server without the setup feature, nor when it is done', async () => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ ...hello([]), setup: { needed: true } } as ServerMessage);
    server({ ...hello(['setup']), setup: { needed: false } } as ServerMessage);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByRole('dialog', { name: '설치 점검' })).toBeNull();
  });

  it('설정 › 계정 › 설치 점검 opens it on a setup server', async () => {
    await boot(['setup']);
    act(() => { window.dispatchEvent(new Event('deck:open-settings')); });
    fireEvent.click(within(screen.getByRole('dialog', { name: '설정' })).getByRole('button', { name: '설치 점검' }));
    expect(await screen.findByRole('dialog', { name: '설치 점검' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull();
  });

  it('settings has no 설치 점검 on a server without the feature', async () => {
    await boot([]);
    act(() => { window.dispatchEvent(new Event('deck:open-settings')); });
    expect(within(screen.getByRole('dialog', { name: '설정' })).queryByRole('button', { name: '설치 점검' })).toBeNull();
  });

  it('logs in from #token= and strips the hash', async () => {
    window.history.replaceState(null, '', '/?x=1#token=a%2Bb');
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    const urls = fetchFn.mock.calls.map((c) => c[0]);
    expect(urls.indexOf('/api/login')).toBeGreaterThanOrEqual(0);
    expect(urls.indexOf('/api/login')).toBeLessThan(urls.indexOf('/api/me'));
    const login = fetchFn.mock.calls.find((c) => c[0] === '/api/login') as unknown as [string, RequestInit];
    expect(JSON.parse(String(login[1].body))).toEqual({ token: 'a+b' });
    expect(replace).toHaveBeenCalledWith(null, '', '/?x=1');
    expect(window.location.hash).toBe('');
    replace.mockRestore();
  });

  it('a wrong #token= is stripped too and the token screen shows', async () => {
    window.history.replaceState(null, '', '/#token=bad');
    fetchFn.mockImplementation(async () => new Response('{}', { status: 401 }));
    render(<App />);
    expect(await screen.findByRole('button', { name: '로그인' })).toBeTruthy();
    expect(window.location.hash).toBe('');
    fetchFn.mockImplementation(async (url: unknown) => new Response(JSON.stringify(url === '/api/setup' ? status : {}), { status: 200 }));
  });
});
