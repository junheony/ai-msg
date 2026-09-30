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
const entry = (sessionId: string, title: string) => ({ sessionId, account: 'b' as const, cwd: '/w', projectDir: '/p', title, lastModified: Date.now(), sizeBytes: 1 });

async function boot() {
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  server({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one'), entry('s2', 'two')] }], running: [], codex: { available: false } } as unknown as ServerMessage);
}
function server(msg: ServerMessage) { act(() => sock.onMessage!(msg)); }
const frames = () => sock.frames as ClientMessage[];
const closes = () => frames().filter((f) => f.type === 'close_session').map((f) => (f as { sessionId: string }).sessionId);
const lastPane = () => screen.getAllByTestId(/^pane-/).at(-1)!;
const openSession = (title: string) => fireEvent.click(within(document.querySelector('.sidebar') as HTMLElement).getByText(title));

describe('App split view (D6)', () => {
  beforeEach(() => {
    sock.frames = [];
    sock.onMessage = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('T9 (b): switching a pane to another session or closing it sends close_session only for sessions no pane still views', async () => {
    await boot();
    openSession('one');
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's1' });
    fireEvent.click(screen.getByText('+ 분할'));
    openSession('two'); // p1 (active) → s2
    expect(frames()).toContainEqual({ type: 'open_session', sessionId: 's2' });
    expect(closes()).toEqual([]);
    openSession('one'); // p1 switches s2 → s1: s2 is released, s1 still shown by p0
    expect(closes()).toEqual(['s2']);
    fireEvent.click(within(screen.getByTestId('pane-p1')).getByLabelText('패널 닫기')); // p0 still shows s1
    expect(closes()).toEqual(['s2']);
    fireEvent.click(screen.getByText('+ 분할'));
    openSession('two');
    fireEvent.click(within(lastPane()).getByLabelText('패널 닫기'));
    expect(closes()).toEqual(['s2', 's2']);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(1);
  });

  it('T9 (b): a pane closed while its open_session reply is in flight never gets its history into a blank pane', async () => {
    await boot();
    fireEvent.click(screen.getByText('+ 분할'));
    openSession('two'); // p1 → s2, history not yet arrived
    fireEvent.click(within(screen.getByTestId('pane-p1')).getByLabelText('패널 닫기'));
    expect(closes()).toEqual(['s2']);
    fireEvent.click(screen.getByText('+ 분할')); // blank active pane (ids are reused: max remaining + 1)
    server({ type: 'history', sessionId: 's2', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [{ kind: 'user', text: 'stale-history', ts: null }] });
    expect(screen.queryByText('stale-history')).toBeNull();
    expect(within(lastPane()).getByText(/세션을 고르거나/)).toBeTruthy();
  });

  it('every send carries a fresh clientRef; a reconnect re-opens each viewed session once', async () => {
    await boot();
    openSession('one');
    server({ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [] });
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('보내기'));
    const send = frames().find((f) => f.type === 'send') as { clientRef?: string };
    expect(send.clientRef).toMatch(/.+/);
    fireEvent.click(screen.getByText('+ 분할'));
    openSession('one');
    sock.frames = [];
    server({ type: 'hello', usage, projects: [], running: [], codex: { available: false } } as unknown as ServerMessage);
    expect(frames().filter((f) => f.type === 'open_session')).toEqual([{ type: 'open_session', sessionId: 's1' }]);
  });
});
