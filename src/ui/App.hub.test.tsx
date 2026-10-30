// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ServerMessage } from '../shared/protocol';
import { hubStatusFixture } from './hub/__fixtures__/status';

Element.prototype.scrollIntoView = () => {};

const sock = vi.hoisted(() => ({ frames: [] as { type: string }[], onMessage: null as ((m: unknown) => void) | null }));
vi.mock('./ws', () => ({
  createSocket: (onMessage: (m: unknown) => void, onStatus: (v: boolean) => void) => {
    sock.onMessage = onMessage;
    onStatus(true);
    return { send: (m: { type: string }) => { sock.frames.push(m); return true; }, close: () => {}, reconnect: () => {}, wake: () => {}, retry: () => {} };
  },
}));

import { App } from './App';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;
const T = Date.now();
const entry = (sessionId: string, title: string, ago: number) => ({ sessionId, account: 'b' as const, cwd: '/w', projectDir: '/p', title, lastModified: T - ago, sizeBytes: 1 });
const STATUS = hubStatusFixture(T);

/** Boots the app against a server with the given features ('hub' = it pushes `hub_status`). */
async function boot(features: string[] = []) {
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  act(() => sock.onMessage!({ type: 'hello', features, usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one', 0)] }], running: [], codex: { available: false } } as unknown as ServerMessage));
}
const push = (status = STATUS) => act(() => sock.onMessage!({ type: 'hub_status', status } as unknown as ServerMessage));
/** jsdom has no Mac platform: the modifier is Ctrl. */
const press = (code: string) => fireEvent.keyDown(window, { code, key: '', ctrlKey: true });
const switcher = () => screen.getByRole('button', { name: /^모드: / });
const rail = () => screen.getByTestId('hub-rail');
const railButtons = () => Array.from(rail().querySelectorAll('button'));
const hubFetches = () => fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/hub/status').length;
let fetchMock: ReturnType<typeof vi.fn>;

describe('MSG hub shell', () => {
  beforeEach(() => {
    localStorage.clear();
    sock.frames = [];
    sock.onMessage = null;
    fetchMock = vi.fn(async (url: string) => {
      if (String(url) === '/api/hub/status') return new Response(JSON.stringify(STATUS), { status: 200, headers: { 'content-type': 'application/json' } });
      if (String(url).startsWith('/api/search')) return new Response(JSON.stringify({ hits: [], truncated: false }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('starts in the terminal with the rail in place: ten modes, no overlay, no polling, and Ctrl+1 keeps its pinned-row meaning', async () => {
    await boot();
    expect(switcher().getAttribute('aria-label')).toBe('모드: MSG 터미널');
    expect(railButtons().map((b) => b.dataset.mode)).toEqual(['home', 'msg', 'nexus', 'trading', 'video', 'game', 'ops', 'updown', 'quant', 'yapping']);
    expect(railButtons()[1]!.getAttribute('aria-current')).toBe('page');
    // The rail is the body's first child and the terminal its sibling: it never moves between modes.
    const body = document.querySelector('.body')!;
    expect(body.children[0]).toBe(rail());
    expect(body.children[1]!.className).toBe('shell-main');
    expect(screen.queryByTestId('hub-overlay')).toBeNull();
    expect(hubFetches()).toBe(0);
    expect(sock.frames.some((f) => f.type === 'hub_watch')).toBe(false);
    // No 고정됨 row → the key is left to the browser (not prevented), exactly as before the hub.
    expect(press('Digit1')).toBe(true);
    expect(screen.queryByTestId('hub-overlay')).toBeNull();
    expect(localStorage.getItem('deck.hubMode')).toBeNull();
  });

  it('a hub server is asked for pushes on hello; the pushed status lights the rail in the terminal and fills the 개요 without a fetch', async () => {
    await boot(['hub']);
    expect(sock.frames.filter((f) => f.type === 'hub_watch')).toEqual([{ type: 'hub_watch', on: true }]);
    push();
    // The rail's dots carry each mode's state even while the terminal shows.
    expect(railButtons()[2]!.getAttribute('aria-label')).toBe('NEXUS · 장애');
    expect(railButtons()[2]!.querySelector('.hub-dot')!.className).toContain('bad');
    expect(railButtons()[6]!.getAttribute('aria-label')).toBe('OPS · 펍덱 · 주의');
    expect(screen.queryByTestId('hub-overlay')).toBeNull();
    fireEvent.click(railButtons()[0]!);
    expect(localStorage.getItem('deck.hubMode')).toBe('home');
    const overview = await screen.findByTestId('hub-overview');
    expect(overview.querySelectorAll('.card').length).toBe(9);
    expect(overview.textContent).toContain('sub1 하트비트 정지 · 12분 전');
    expect(hubFetches()).toBe(0);
    expect(screen.getByText('실시간 푸시')).toBeTruthy();
    const sum = screen.getByRole('status', { name: '상태 요약' });
    expect(sum.textContent).toContain('정상 5');
    expect(sum.textContent).toContain('주의 1');
    expect(sum.textContent).toContain('장애 1');
    expect(sum.textContent).toContain('푸시 ');
    // The terminal stays mounted but inert underneath; the rail stays live.
    expect(document.querySelector('.panes')?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.sidebar-wrap')?.hasAttribute('inert')).toBe(true);
    expect(rail().hasAttribute('inert')).toBe(false);
    // No control surface anywhere in the hub.
    expect(overview.querySelector('form, input, select, textarea')).toBeNull();
    // A later push re-renders in place.
    push({ ...STATUS, generated_at: new Date(T + 1000).toISOString(), modes: STATUS.modes.map((m) => (m.id === 'nexus' ? { ...m, state: 'ok' as const, alerts: [] } : m)) });
    expect(railButtons()[2]!.getAttribute('aria-label')).toBe('NEXUS · 정상');
    expect(hubFetches()).toBe(0);
  });

  it('an older server (no hub feature) is polled only while a hub mode shows', async () => {
    await boot();
    fireEvent.click(switcher());
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent?.replace(/⌘\d|Ctrl\+\d/g, '').trim())).toEqual(['개요', 'MSG 터미널', 'NEXUS', 'Trading Room', '영상 스튜디오', '게임 스튜디오', 'OPS · 펍덱', 'UPDOWN', 'QUANT', '야핑봇']);
    expect(items[1]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(items[0]!);
    const overview = await screen.findByTestId('hub-overview');
    await waitFor(() => expect(hubFetches()).toBe(1));
    await screen.findAllByText('sub1 하트비트 정지 · 12분 전');
    expect(overview.querySelectorAll('.card').length).toBe(9);
    expect(screen.getByText('15초 폴링')).toBeTruthy();
    expect(sock.frames.some((f) => f.type === 'hub_watch')).toBe(false);
  });

  it('restores the last mode on reload; Ctrl+digit (and Ctrl+0) switch modes outside the terminal; 원본 보기 frames only on demand', async () => {
    localStorage.setItem('deck.hubMode', 'quant');
    await boot();
    expect(switcher().getAttribute('aria-label')).toBe('모드: QUANT');
    const quant = await screen.findByTestId('hub-mode-quant');
    await screen.findByText('IOC 발견 0 · 타일 9/9 정상');
    expect(quant.querySelector('iframe')).toBeNull();
    const raw = quant.querySelector('[data-testid="hub-sec-raw"]')!;
    fireEvent.click(raw.querySelector('summary')!);
    const frame = quant.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('/hub/p/quant/');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-forms');
    expect(press('Digit3')).toBe(false);
    expect(await screen.findByTestId('hub-mode-nexus')).toBeTruthy();
    expect(localStorage.getItem('deck.hubMode')).toBe('nexus');
    expect(railButtons()[2]!.getAttribute('aria-current')).toBe('page');
    expect(press('Digit0')).toBe(false);
    expect(await screen.findByTestId('hub-mode-yapping')).toBeTruthy();
    expect(localStorage.getItem('deck.hubMode')).toBe('yapping');
    press('Digit2');
    await waitFor(() => expect(screen.queryByTestId('hub-overlay')).toBeNull());
    expect(localStorage.getItem('deck.hubMode')).toBe('msg');
    expect(document.querySelector('.panes')?.hasAttribute('inert')).toBe(false);
    expect(rail()).toBeTruthy();
  });

  it('with the menu open, Ctrl+digit picks that mode even from the terminal; Esc closes the menu', async () => {
    await boot();
    fireEvent.click(switcher());
    expect(screen.getByRole('menu', { name: '모드' })).toBeTruthy();
    press('Digit1');
    expect(await screen.findByTestId('hub-overview')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('menu', { name: '모드' })).toBeNull());
    fireEvent.click(switcher());
    fireEvent.keyDown(screen.getByRole('menu', { name: '모드' }), { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: '모드' })).toBeNull();
    expect(screen.getByTestId('hub-overview')).toBeTruthy();
  });

  it('shows the login hint instead of cards when the status endpoint answers 401', async () => {
    fetchMock.mockImplementation(async (url: string) => new Response(String(url) === '/api/hub/status' ? '{"error":"unauthorized"}' : '{}', { status: String(url) === '/api/hub/status' ? 401 : 200 }));
    localStorage.setItem('deck.hubMode', 'home');
    await boot();
    expect((await screen.findAllByText(/로그인이 필요합니다/)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('hub-overview')?.querySelector('.card')).toBeFalsy();
  });
});
