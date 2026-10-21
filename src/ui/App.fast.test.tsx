// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { FAST_CONSENT_KEY, FAST_KEY, isFast, resetFastForTests, setFast } from './fastMode';

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
const entry = { sessionId: 's1', account: 'b' as const, cwd: '/w', projectDir: '/p', title: 'one', lastModified: Date.now(), sizeBytes: 1 };
const hello = { type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry] }], running: [], codex: { available: false }, features: [] } as unknown as ServerMessage;
function server(msg: unknown) { act(() => sock.onMessage!(msg)); }
const sends = () => (sock.frames as ClientMessage[]).filter((f): f is Extract<ClientMessage, { type: 'send' }> => f.type === 'send');

/** Boots with ↯ on for 's1', opens it and sends one message (a fast turn), answered by `result`. */
async function failedFastTurn(result: Partial<Extract<ServerMessage, { type: 'turn_result' }>>) {
  localStorage.setItem(FAST_CONSENT_KEY, '1');
  setFast('s1', true);
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  server(hello);
  fireEvent.click(within(document.querySelector('.sidebar') as HTMLElement).getByText('one'));
  server({ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [] });
  fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'hi' } });
  fireEvent.click(screen.getByText('보내기'));
  const first = sends()[0]!;
  expect(first.fast).toBe(true);
  server({ type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0, clientRef: first.clientRef });
  server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: false, text: '', badge: null, errorText: 'Fast mode rate limit', ...result });
}

describe('⚡ 빠르게 — a refused fast turn in the app', () => {
  beforeEach(() => {
    localStorage.clear();
    resetFastForTests();
    sock.frames = [];
    sock.onMessage = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  it('표준으로 다시 보내기: the same prompt goes again without fast, straight from the button — the switch is not touched', async () => {
    await failedFastTurn({ errorCode: 'fast_refused' });
    expect(isFast('s1')).toBe(true);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent.click(screen.getByTestId('fast-standard-retry'));
    expect(write.mock.calls.filter(([k]) => k === FAST_KEY)).toEqual([]);
    write.mockRestore();
    expect(isFast('s1')).toBe(true);
    const again = sends()[1]!;
    expect(again.text).toBe('hi');
    expect(again.fast).toBeUndefined();
    // Only that one send: the next one goes with ↯ as the switch says.
    server({ type: 'turn_started', turnId: 't2', sessionId: 's1', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0, clientRef: again.clientRef });
    server({ type: 'turn_result', turnId: 't2', sessionId: 's1', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null });
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'next' } });
    fireEvent.click(screen.getByText('보내기'));
    expect(sends()[2]).toMatchObject({ text: 'next', fast: true });
  });

  it('credits used up (fastOff): the session\'s switch is turned off by itself, the ↯ chip goes', async () => {
    await failedFastTurn({ errorCode: 'fast_refused', fastOff: true });
    expect(isFast('s1')).toBe(false);
    expect(screen.queryByTestId('fast-chip')).toBeNull();
  });

  it('any other failure leaves the switch alone and offers no standard retry', async () => {
    await failedFastTurn({ errorText: 'boom' });
    expect(isFast('s1')).toBe(true);
    expect(screen.queryByTestId('fast-standard-retry')).toBeNull();
    expect(screen.getByTestId('fast-chip')).toBeTruthy();
  });
});
