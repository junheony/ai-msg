// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthTerminal, linkify } from './AuthTerminal';

afterEach(cleanup);

describe('linkify', () => {
  it('turns an http URL into a link and leaves the sentence around it', () => {
    const { container } = render(<p>{linkify('열기: https://claude.ai/login?x=1. 끝')}</p>);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://claude.ai/login?x=1');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(container.textContent).toContain('열기:');
    expect(container.textContent).toContain('. 끝');
  });
});

describe('AuthTerminal', () => {
  it('starts the seat, shows the URL as a link, and posts only the pasted code', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    let streamRead = false;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === '/api/auth-login' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', label: 'claude auth login', seat: 'b' }), { status: 200 });
      }
      if (String(url).endsWith('/stream')) {
        const enc = new TextEncoder();
        const body = new ReadableStream({
          pull(controller) {
            if (streamRead) return;
            streamRead = true;
            controller.enqueue(enc.encode('event: out\ndata: {"text":"https://claude.ai/login\\n"}\n\n'));
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (String(url).endsWith('/input')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (String(url).endsWith('/cancel')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response('no', { status: 404 });
    });
    const { unmount } = render(<AuthTerminal seat="b" title="B" onClose={() => {}} fetchFn={fetchFn as unknown as typeof fetch} />);
    expect(await screen.findByText('https://claude.ai/login')).toBeTruthy();
    expect(screen.getByText('https://claude.ai/login').closest('a')?.getAttribute('href')).toBe('https://claude.ai/login');
    expect(screen.getByText('claude auth login')).toBeTruthy();
    fireEvent.change(screen.getByTestId('auth-code'), { target: { value: 'AB-CD' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(calls.some((c) => c.body === '{"text":"AB-CD"}')).toBe(true));
    unmount();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(true));
  });

  it('sends Enter once when agy prints its login menu', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') calls.push(init.body);
      if (url === '/api/auth-login' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: '22222222-2222-4222-8222-222222222222', label: 'agy', seat: 'g1' }), { status: 200 });
      }
      if (String(url).endsWith('/stream')) {
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode('event: out\ndata: {"text":"Select login method:\\n1. Google OAuth\\n"}\n\n'));
          },
        }), { status: 200 });
      }
      if (String(url).endsWith('/input')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (String(url).endsWith('/cancel')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response('no', { status: 404 });
    });
    const { unmount } = render(<AuthTerminal seat="g1" title="Gemini" onClose={() => {}} fetchFn={fetchFn as unknown as typeof fetch} />);
    await waitFor(() => expect(calls.filter((b) => b === '{"enter":true}')).toHaveLength(1));
    unmount();
  });
});
