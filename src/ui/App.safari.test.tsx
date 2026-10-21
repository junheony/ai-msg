// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';

// Safari on a Mac, before App reads the platform at import.
vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', configurable: true });
});

Element.prototype.scrollIntoView = () => {};

const sock = vi.hoisted(() => ({ frames: [] as unknown[], onMessage: null as ((m: unknown) => void) | null }));
vi.mock('./ws', () => ({
  createSocket: (onMessage: (m: unknown) => void, onStatus: (v: boolean) => void) => {
    sock.onMessage = onMessage;
    onStatus(true);
    return { send: (m: unknown) => { sock.frames.push(m); }, wake: () => {}, reconnect: () => {}, retry: () => {}, close: () => {} };
  },
}));

import { App } from './App';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;
const entry = (sessionId: string, title: string) => ({ sessionId, account: 'b' as const, cwd: '/w', projectDir: '/p', title, lastModified: Date.now(), sizeBytes: 1 });
const server = (msg: ServerMessage) => act(() => sock.onMessage!(msg));
const opened = () => (sock.frames as ClientMessage[]).filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId);
const lastPane = () => screen.getAllByTestId(/^pane-/).at(-1)!;
/** Returns false when the key was taken (preventDefault). */
const press = (n: number, extra: Record<string, unknown> = {}, target: Element | Window = window) => fireEvent.keyDown(target, { code: `Digit${n}`, key: String(n), ...extra });

describe('App in Safari on a Mac: ⌃1 … ⌃9 next to ⌘1 … ⌘9', () => {
  beforeEach(() => { localStorage.clear(); sock.frames = []; sock.onMessage = null; vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const bootPinned = async () => {
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two'), entry('s3', 'three')] }], pins: ['s2', 's1'], running: [], codex: { available: false } } as unknown as ServerMessage);
  };

  it('⌃1 / ⌃2 open the pinned rows (also from the composer, mid-IME too); ⌘1 still does', async () => {
    await bootPinned();
    expect(press(1, { ctrlKey: true })).toBe(false);
    expect(opened()).toEqual(['s2']);
    const ta = within(lastPane()).getByLabelText('메시지');
    expect(press(2, { ctrlKey: true }, ta)).toBe(false);
    expect(opened()).toEqual(['s2', 's1']);
    expect(press(1, { ctrlKey: true, isComposing: true, keyCode: 229, key: 'Process' }, within(lastPane()).getByLabelText('메시지'))).toBe(false);
    await waitFor(() => expect(opened()).toEqual(['s2', 's1', 's2']));
    expect(press(2, { metaKey: true })).toBe(false);
    expect(opened()).toEqual(['s2', 's1', 's2', 's1']);
    expect(press(1, { ctrlKey: true, metaKey: true })).toBe(true); // ⌘⌃ together is neither
    expect(press(3, { ctrlKey: true })).toBe(true); // no 3rd pinned row: left alone
  });

  it('holding ⌃ shows ⌃1 on the 고정됨 rows; the cheat sheet lists ⌃1–9 first, ⌘1–9 too', async () => {
    await bootPinned();
    fireEvent.keyDown(window, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    expect([...document.querySelectorAll('.pin-key')].map((k) => k.textContent)).toEqual(['⌃1', '⌃2']);
    fireEvent.keyUp(window, { key: 'Control', code: 'ControlLeft' });
    expect(document.querySelector('.pin-key')).toBeNull();
    fireEvent.keyDown(window, { code: 'Slash', key: '/', metaKey: true });
    const help = screen.getByRole('dialog', { name: '단축키' });
    expect(within(help).getByText('⌃1–9 · ⌘1–9')).toBeTruthy();
    expect(within(help).getByText('⌃⌥1–9 · ⌘⌥1–9')).toBeTruthy();
  });
});
