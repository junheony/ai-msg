// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ServerMessage } from '../shared/protocol';
import type { HubStatus } from '../shared/hub-types';

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

const STATUS: HubStatus = {
  host: 'deck-host',
  generated_at: new Date(T).toISOString(),
  modes: [
    { id: 'msg', name: 'MSG 터미널', state: 'ok', lastActivity: new Date(T).toISOString(), metrics: { '가동 시간': '3시간 2분', '세션': 4 }, alerts: [], links: [], sources: [{ name: 'msg', ok: true, ms: 0 }] },
    { id: 'nexus', name: 'NEXUS', state: 'down', lastActivity: null, metrics: {}, alerts: [{ level: 'bad', text: '연결 실패' }], links: [{ label: 'NEXUS 열기', href: 'http://nexus.example/' }], sources: [{ name: 'nexus', ok: false, ms: 3000, error: '시간 초과' }] },
    { id: 'trading', name: 'Trading Room', state: 'ok', lastActivity: new Date(T - 60_000).toISOString(), metrics: { '감시 종목': 12 }, alerts: [], links: [], sources: [{ name: 'trading', ok: true, ms: 5 }] },
    { id: 'video', name: '영상 스튜디오', state: 'idle', lastActivity: null, metrics: {}, alerts: [], links: [], sources: [] },
    { id: 'game', name: '게임 스튜디오', state: 'ok', lastActivity: null, metrics: {}, alerts: [], links: [], sources: [] },
    { id: 'ops', name: 'OPS · 펍덱', state: 'warn', lastActivity: null, metrics: { '서비스': 'ok' }, alerts: [{ level: 'warn', text: 'sub1 하트비트 정지 · 12분 전' }], links: [{ label: 'OPS 열기', href: '/hub/p/ops/', embed: true }], sources: [{ name: 'ops', ok: true, ms: 40 }] },
    { id: 'updown', name: 'UPDOWN', state: 'ok', lastActivity: null, metrics: {}, alerts: [], links: [], sources: [] },
    { id: 'quant', name: 'QUANT', state: 'ok', lastActivity: null, metrics: { '타일': 9 }, alerts: [], links: [{ label: 'QUANT 열기', href: '/hub/p/quant/', embed: true }], sources: [{ name: 'quant', ok: true, ms: 3 }] },
  ],
};

async function boot() {
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  act(() => sock.onMessage!({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one', 0)] }], running: [], codex: { available: false } } as unknown as ServerMessage));
}
/** jsdom has no Mac platform: the modifier is Ctrl. */
const press = (code: string) => fireEvent.keyDown(window, { code, key: '', ctrlKey: true });
const switcher = () => screen.getByRole('button', { name: /^모드: / });
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

  it('starts in the terminal: no overlay, no status polling, and Ctrl+1 keeps its pinned-row meaning', async () => {
    await boot();
    expect(switcher().getAttribute('aria-label')).toBe('모드: MSG 터미널');
    expect(screen.queryByTestId('hub-overlay')).toBeNull();
    expect(hubFetches()).toBe(0);
    // No 고정됨 row → the key is left to the browser (not prevented), exactly as before the hub.
    expect(press('Digit1')).toBe(true);
    expect(screen.queryByTestId('hub-overlay')).toBeNull();
    expect(localStorage.getItem('deck.hubMode')).toBeNull();
  });

  it('the switcher lists the nine modes; picking 개요 shows the card grid, polls the status endpoint and persists the choice', async () => {
    await boot();
    fireEvent.click(switcher());
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent?.replace(/⌘\d|Ctrl\+\d/g, '').trim())).toEqual(['개요', 'MSG 터미널', 'NEXUS', 'Trading Room', '영상 스튜디오', '게임 스튜디오', 'OPS · 펍덱', 'UPDOWN', 'QUANT']);
    expect(items[1]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(items[0]!);
    expect(localStorage.getItem('deck.hubMode')).toBe('home');
    const overview = await screen.findByTestId('hub-overview');
    await waitFor(() => expect(hubFetches()).toBe(1));
    await screen.findAllByText('sub1 하트비트 정지 · 12분 전');
    const cards = overview.querySelectorAll('.hub-card');
    expect(cards.length).toBe(8);
    expect(cards[1]!.className).toContain('bad');
    expect(cards[5]!.className).toContain('warn');
    // Summary chips: ok / warn / down counts.
    const sum = screen.getByRole('status', { name: '상태 요약' });
    expect(sum.textContent).toContain('정상 5');
    expect(sum.textContent).toContain('주의 1');
    expect(sum.textContent).toContain('장애 1');
    // The terminal stays mounted but inert underneath.
    expect(document.querySelector('.panes')?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.sidebar-wrap')?.hasAttribute('inert')).toBe(true);
    // No control surface anywhere in the hub.
    expect(overview.querySelector('form, input, select, textarea')).toBeNull();
  });

  it('restores the last mode on reload and Ctrl+digit switches modes while outside the terminal', async () => {
    localStorage.setItem('deck.hubMode', 'quant');
    await boot();
    expect(switcher().getAttribute('aria-label')).toBe('모드: QUANT');
    const quant = await screen.findByTestId('hub-mode-quant');
    const frame = quant.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('/hub/p/quant/');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-forms');
    press('Digit3');
    expect(await screen.findByTestId('hub-mode-nexus')).toBeTruthy();
    expect(localStorage.getItem('deck.hubMode')).toBe('nexus');
    press('Digit2');
    await waitFor(() => expect(screen.queryByTestId('hub-overlay')).toBeNull());
    expect(localStorage.getItem('deck.hubMode')).toBe('msg');
    expect(document.querySelector('.panes')?.hasAttribute('inert')).toBe(false);
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
    expect(screen.queryByTestId('hub-overview')?.querySelector('.hub-card')).toBeFalsy();
  });
});
