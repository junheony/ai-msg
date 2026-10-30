// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WIDGET_TOKEN_TEXTS, WidgetTokenRow } from './WidgetTokenRow';

const T1 = 'a'.repeat(60) + '1234';
const T2 = 'b'.repeat(60) + '5678';

function fetchStub(tokens: { current: string }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/mini/widget-token' && !init?.method) return new Response(JSON.stringify({ token: tokens.current }), { status: 200 });
    if (url === '/api/mini/widget-token/rotate' && init?.method === 'POST') { tokens.current = T2; return new Response(JSON.stringify({ token: T2 }), { status: 200 }); }
    return new Response('{}', { status: 405 });
  });
}

describe('WidgetTokenRow', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('복사 fetches the token and puts it on the clipboard; only its last four characters ever show', async () => {
    const tokens = { current: T1 };
    const fetchFn = fetchStub(tokens);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<WidgetTokenRow fetchFn={fetchFn} />);
    expect(screen.getByText(WIDGET_TOKEN_TEXTS.hint)).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: WIDGET_TOKEN_TEXTS.copy })); });
    expect(fetchFn).toHaveBeenCalledWith('/api/mini/widget-token', { cache: 'no-store' });
    expect(writeText).toHaveBeenCalledWith(T1);
    expect(screen.getByText(WIDGET_TOKEN_TEXTS.copied)).toBeTruthy();
    expect(document.body.textContent).toContain('····1234');
    expect(document.body.innerHTML).not.toContain(T1);
  });

  it('재발급 asks once, then rotates; 취소 does nothing', async () => {
    const tokens = { current: T1 };
    const fetchFn = fetchStub(tokens);
    render(<WidgetTokenRow fetchFn={fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: WIDGET_TOKEN_TEXTS.rotate }));
    expect(screen.getByRole('group', { name: '위젯 토큰 재발급' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: WIDGET_TOKEN_TEXTS.cancel }));
    expect(screen.queryByRole('group', { name: '위젯 토큰 재발급' })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: WIDGET_TOKEN_TEXTS.rotate }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: WIDGET_TOKEN_TEXTS.confirm })); });
    expect(fetchFn).toHaveBeenCalledWith('/api/mini/widget-token/rotate', { method: 'POST', cache: 'no-store' });
    expect(tokens.current).toBe(T2);
    expect(screen.getByText(WIDGET_TOKEN_TEXTS.rotated)).toBeTruthy();
    expect(document.body.textContent).toContain('····5678');
    expect(document.body.innerHTML).not.toContain(T2);
  });

  it('a server error is said in words', async () => {
    const fetchFn = vi.fn(async () => new Response('x', { status: 500 }));
    render(<WidgetTokenRow fetchFn={fetchFn} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: WIDGET_TOKEN_TEXTS.copy })); });
    expect(screen.getByText(WIDGET_TOKEN_TEXTS.failed)).toBeTruthy();
  });
});
