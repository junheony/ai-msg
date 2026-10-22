// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ServerMessage } from '../shared/protocol';
import { useSessionIconStore } from './components/SessionIcon';

Element.prototype.scrollIntoView = () => {};

const sock = vi.hoisted(() => ({ onMessage: null as ((m: unknown) => void) | null }));
vi.mock('./ws', () => ({
  createSocket: (onMessage: (m: unknown) => void, onStatus: (v: boolean) => void) => {
    sock.onMessage = onMessage;
    onStatus(true);
    return { send: () => {}, wake: () => {}, reconnect: () => {}, retry: () => {}, close: () => {} };
  },
}));

import { App } from './App';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;
const entry = { sessionId: 's1', account: 'b' as const, cwd: '/w', projectDir: '/p', title: 'one', lastModified: Date.now(), sizeBytes: 1 };
const hello = (features: string[]) => ({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry] }], running: [], codex: { available: false }, features }) as unknown as ServerMessage;
function server(msg: unknown) { act(() => sock.onMessage!(msg)); }
const sidebar = () => within(document.querySelector('.sidebar') as HTMLElement);

describe('세션 아이콘 in the app', () => {
  beforeEach(() => { localStorage.clear(); sock.onMessage = null; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  it('a server without the sessionIcons feature: the avatar is a plain letter, no picker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    render(<App />);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server(hello([]));
    const li = sidebar().getByText('one').closest('li')!;
    expect(li.querySelector('.avatar-mono')!.textContent).toBe('O');
    expect(within(li).queryByRole('button', { name: '아이콘 바꾸기' })).toBeNull();
  });

  it('with it: the setter stays the same across renders (no avatar re-render), and a refused choice shows the server\'s words', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (String(url).includes('/api/session-icon') ? new Response(JSON.stringify({ error: '아이콘을 더 저장할 수 없습니다' }), { status: 409 }) : new Response('{}', { status: 200 }))));
    const seen = new Set<unknown>();
    let renders = 0;
    function Probe() { const { setIcon } = useSessionIconStore(); renders++; if (setIcon) seen.add(setIcon); return null; }
    render(<><App /><Probe /></>);
    await waitFor(() => expect(sock.onMessage).not.toBeNull());
    server(hello(['sessionIcons']));
    const after = renders;
    server(hello(['sessionIcons']));
    server(hello(['sessionIcons']));
    expect(seen.size).toBe(1);
    expect(renders).toBe(after);
    const li = sidebar().getByText('one').closest('li')!;
    fireEvent.click(within(li).getByRole('button', { name: '아이콘 바꾸기' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '세션 아이콘' })).getByRole('button', { name: '🚀' }));
    expect(await screen.findByText('아이콘을 더 저장할 수 없습니다')).toBeTruthy();
  });
});
