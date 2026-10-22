// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MessageView } from './MessageView';
import { fromTranscript, initialState, reducer, type ChatItem } from '../state';

const base: Extract<ChatItem, { kind: 'assistant' }> = { kind: 'assistant', turnId: 't', text: 'ok', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] };

describe('thinking render', () => {
  afterEach(cleanup);

  it('shows a collapsed "N초 동안 생각함" disclosure with the text', () => {
    const { getByText, getByTestId } = render(<MessageView item={{ ...base, thinking: { text: '먼저 확인', redacted: false, startedAt: 0, ms: 8200 } }} />);
    const opener = getByTestId('thinking');
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(getByText('8초 동안 생각함')).toBeTruthy();
    const panel = document.getElementById(opener.getAttribute('aria-controls')!)!;
    expect(panel.hidden).toBe(true);
    expect(panel.textContent).toContain('먼저 확인');
    fireEvent.click(opener);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
  });

  it('redacted thinking is plain text with no fold: "N초 동안 생각함", or "생각함" without a time', () => {
    const { container, getByTestId } = render(<MessageView item={{ ...base, thinking: { text: '', redacted: true, startedAt: null, ms: null } }} />);
    expect(container.querySelector('details')).toBeNull();
    expect(getByTestId('thinking').textContent).toBe('생각함');
    cleanup();
    const timed = render(<MessageView item={{ ...base, thinking: { text: '', redacted: true, startedAt: 0, ms: 4000 } }} />);
    expect(timed.container.querySelector('details')).toBeNull();
    expect(timed.getByTestId('thinking').textContent).toBe('4초 동안 생각함');
  });

  it('history: transcript thinking becomes an item with thinking', () => {
    const items: ChatItem[] = fromTranscript([{ kind: 'assistant', text: 'a', model: null, toolCalls: [], ts: null, thinking: 'hm' }]);
    expect(items[0]).toMatchObject({ thinking: { text: 'hm', redacted: false } });
  });

  it('highlights fenced code and keeps the copy button + language label', async () => {
    const { container } = render(<MessageView item={{ ...base, text: '```ts\nconst a = 1;\n```' }} />);
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull());
    expect(container.querySelector('.code-lang')?.textContent).toBe('ts');
    expect(container.querySelector('button[aria-label="코드 복사"]')).not.toBeNull();
  });

  it('renders math with KaTeX', async () => {
    const { container } = render(<MessageView item={{ ...base, text: '식 $$x^2$$ 입니다' }} />);
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
  });
});

describe('dollar signs', () => {
  afterEach(cleanup);
  it('prices and tickers stay plain text', async () => {
    for (const text of ['$5 and $10', '$BTC $ETH']) {
      const { container } = render(<MessageView item={{ ...base, text }} />);
      await new Promise((r) => setTimeout(r, 50));
      expect(container.querySelector('.katex')).toBeNull();
      expect(container.querySelector('.markdown')?.textContent).toBe(text);
      cleanup();
    }
  });
});

describe('thinking reducer', () => {
  it('accumulates thinking live and fixes elapsed time at the first reply text', () => {
    const scope = { turnId: 'T', sessionId: 's', cwd: '/w' };
    const started = reducer(reducer(initialState, { type: 'open', sessionId: 's', cwd: '/w', title: 't' }), { type: 'server', msg: { type: 'turn_started', ...scope, account: 'a', model: 'opus', reason: 'r', attempt: 0 } });
    const s = [{ type: 'thinking', ...scope, text: '' }, { type: 'thinking', ...scope, text: '생각' }, { type: 'delta', ...scope, text: 'hi' }].reduce((st, msg) => reducer(st, { type: 'server', msg } as never), started);
    const it = s.panes[0]!.items.at(-1) as Extract<ChatItem, { kind: 'assistant' }>;
    expect(it.thinking).toMatchObject({ text: '생각', redacted: false });
    expect(it.thinking?.ms).not.toBeNull();
    expect(it.text).toBe('hi');
  });
});
