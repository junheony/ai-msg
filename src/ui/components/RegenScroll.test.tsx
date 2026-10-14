// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chat, type ChatProps } from './Chat';
import { RegenerateContext, type Regenerate } from './MessageView';
import type { ChatItem } from '../state';

afterEach(cleanup);

// jsdom has no layout: the scroll box is faked on the transcript element (as in stickToBottom.test).
function fakeBox(el: HTMLElement, box: { height: number; client: number; top: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.client });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => box.top, set: (v: number) => { box.top = Math.max(0, Math.min(v, box.height - box.client)); } });
  return box;
}

const user = (text: string, n: number): ChatItem => ({ kind: 'user', text, n });
const answer = (text: string): ChatItem => ({ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] });
const ITEMS = [user('하나', 0), answer('일'), user('둘', 1), answer('이')];

function props(items: ChatItem[]): ChatProps {
  const noop = () => {};
  return { items, pending: [], questions: [], activeTurnId: null, busy: false, title: 't', sessionId: 's1', model: 'opus', effort: 'high', engine: 'claude', sandbox: 'read-only', sessionEngine: 'claude', sessionSandbox: null, isNew: false, codexAvailable: false, attachments: [], onSend: noop, onInterrupt: noop, onDecide: noop, onAnswer: noop, onModel: noop, onEffort: noop, onEngine: noop, onSandbox: noop, onAttach: noop, onUnattach: noop };
}

function setup(regen: Regenerate) {
  const ui = () => <RegenerateContext.Provider value={regen}><Chat {...props([...ITEMS])} /></RegenerateContext.Provider>;
  const view = render(ui());
  const body = view.container.querySelector('.chat-body') as HTMLElement;
  const box = fakeBox(body, { height: 1000, client: 400, top: 0 });
  view.rerender(ui());
  // The user scrolled up to an earlier reply.
  box.top = 100;
  fireEvent.scroll(body);
  expect(screen.getByTestId('jump-bottom')).toBeTruthy();
  return box;
}

describe('다시 생성 follows the new turn from the bottom', () => {
  it('↻ on an earlier reply (branch) jumps to the bottom and re-attaches', () => {
    const branch = vi.fn();
    const box = setup({ turnOf: (it) => (it.kind === 'assistant' && it.text === '일' ? { n: 0, text: '하나' } : null), branch, models: ['opus', 'sonnet'], current: 'opus' });
    fireEvent.click(screen.getByRole('button', { name: '다시 생성' }));
    expect(branch).toHaveBeenCalledWith({ n: 0, text: '하나' }, undefined);
    expect(box.top).toBe(600);
    expect(screen.queryByTestId('jump-bottom')).toBeNull();
  });

  it('다른 모델로 (retryWith on the last reply) jumps to the bottom too', () => {
    const retryWith = vi.fn();
    const box = setup({ turnOf: () => null, retryWith, models: ['opus', 'sonnet'], current: 'opus' });
    fireEvent.click(screen.getByRole('button', { name: '다른 모델로 다시 생성' }));
    fireEvent.click(screen.getAllByRole('menuitem').find((b) => b.textContent?.includes('Sonnet'))!);
    expect(retryWith).toHaveBeenCalledWith('sonnet');
    expect(box.top).toBe(600);
    expect(screen.queryByTestId('jump-bottom')).toBeNull();
  });
});
