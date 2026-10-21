// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chat, type ChatProps } from './Chat';
import { FIND_EVENT, markHits } from './FindBar';
import type { ChatItem } from '../state';

afterEach(cleanup);

const user = (text: string): ChatItem => ({ kind: 'user', text });
const answer = (text: string, streaming = false): ChatItem => ({ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming, error: null, notes: [], attempts: [] });

function props(items: ChatItem[], extra: Partial<ChatProps> = {}): ChatProps {
  const noop = () => {};
  return { items, pending: [], questions: [], activeTurnId: null, busy: false, title: 't', sessionId: 's1', model: 'opus', effort: 'high', engine: 'claude', sandbox: 'read-only', sessionEngine: null, sessionSandbox: null, isNew: false, codexAvailable: false, attachments: [], onSend: noop, onInterrupt: noop, onDecide: noop, onAnswer: noop, onModel: noop, onEffort: noop, onEngine: noop, onSandbox: noop, onAttach: noop, onUnattach: noop, ...extra };
}

const hits = () => [...document.querySelectorAll('mark.find-hit')];
const current = () => document.querySelector('mark.find-hit.current');
const count = () => screen.getByTestId('find-count').textContent;

describe('markHits', () => {
  it('marks every case-insensitive hit in messages only, and clear gives the text back', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="msg"><p>Apple apple <b>APPLE</b></p><div class="msg-actions"><button>apple</button></div></div><p>apple outside</p>';
    const before = root.innerHTML;
    const { marks, clear } = markHits(root, 'apple');
    expect(marks.map((m) => m.textContent)).toEqual(['Apple', 'apple', 'APPLE']);
    expect(root.querySelector('p')!.textContent).toBe('Apple apple APPLE');
    clear();
    expect(root.innerHTML).toBe(before);
  });

  it('keeps a text node rewritten meanwhile (a streaming reply) instead of putting the old text back', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="msg"><p>ab cat</p></div>';
    const text = root.querySelector('p')!.firstChild as Text;
    const { clear } = markHits(root, 'cat');
    text.data = 'ab cat and more';
    clear();
    expect(root.querySelector('p')!.textContent).toBe('ab cat and more');
  });
});

describe('대화에서 찾기', () => {
  const ITEMS = [user('고양이 질문'), answer('고양이는 귀엽다'), user('개도'), answer('고양이와 개')];

  it('⌘F opens the bar; all hits are marked with N / M; Enter / Shift+Enter / the buttons step and wrap', () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    render(<Chat {...props(ITEMS)} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '메시지' }), { key: 'f', metaKey: true });
    const input = screen.getByRole('searchbox', { name: '대화에서 찾기' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '고양이' } });
    expect(hits()).toHaveLength(3);
    expect(count()).toBe('1 / 3');
    expect(current()).toBe(hits()[0]);
    expect(scrolled.at(-1)).toBe(hits()[0]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(count()).toBe('2 / 3');
    expect(current()).toBe(hits()[1]);
    expect(scrolled.at(-1)).toBe(hits()[1]);
    fireEvent.click(screen.getByRole('button', { name: '다음 찾기 결과' }));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(count()).toBe('1 / 3');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(count()).toBe('3 / 3');
    fireEvent.click(screen.getByRole('button', { name: '이전 찾기 결과' }));
    expect(count()).toBe('2 / 3');
    expect(document.querySelectorAll('.find-hit.current')).toHaveLength(1);
  });

  it('no hit shows 0 / 0 with the step buttons off; Esc closes and removes every mark', () => {
    render(<Chat {...props(ITEMS)} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '메시지' }), { key: 'f', ctrlKey: true });
    const input = screen.getByRole('searchbox', { name: '대화에서 찾기' });
    fireEvent.change(input, { target: { value: '없는말' } });
    expect(count()).toBe('0 / 0');
    expect((screen.getByRole('button', { name: '다음 찾기 결과' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '개' } });
    expect(hits()).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('find-bar')).toBeNull();
    expect(hits()).toHaveLength(0);
    expect(document.querySelector('.chat-body')!.textContent).toContain('고양이와 개');
  });

  it('the ⋯ menu offers 대화에서 찾기', () => {
    render(<Chat {...props(ITEMS)} />);
    fireEvent.click(screen.getByTestId('session-chip-head'));
    fireEvent.click(screen.getByRole('menuitem', { name: '대화에서 찾기' }));
    expect(screen.getByTestId('find-bar')).toBeTruthy();
  });

  it('new content re-marks without moving the current hit or the view', () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    const view = render(<Chat {...props([user('a cat'), answer('cat', true)])} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '메시지' }), { key: 'f', metaKey: true });
    fireEvent.change(screen.getByRole('searchbox', { name: '대화에서 찾기' }), { target: { value: 'cat' } });
    fireEvent.keyDown(screen.getByRole('searchbox', { name: '대화에서 찾기' }), { key: 'Enter' });
    expect(count()).toBe('2 / 2');
    const n = scrolled.length;
    view.rerender(<Chat {...props([user('a cat'), answer('cat and another cat', true)])} />);
    expect(count()).toBe('2 / 3');
    expect(scrolled.length).toBe(n);
    expect(document.querySelector('.msg.assistant')!.textContent).toContain('cat and another cat');
  });

  it('a search jump (FIND_EVENT on a message) opens the bar with the term on that message’s hit', () => {
    Element.prototype.scrollIntoView = () => {};
    render(<Chat {...props(ITEMS)} />);
    const msgs = document.querySelectorAll('.msg');
    act(() => { msgs[3]!.dispatchEvent(new CustomEvent(FIND_EVENT, { bubbles: true, detail: '고양이' })); });
    expect((screen.getByRole('searchbox', { name: '대화에서 찾기' }) as HTMLInputElement).value).toBe('고양이');
    expect(count()).toBe('3 / 3');
    expect(msgs[3]!.contains(current())).toBe(true);
  });

  it('a hit in a folded long message unfolds it (the search-flash path)', async () => {
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = () => {};
    const long = Array.from({ length: 20 }, (_, i) => (i === 18 ? '끝부분 바늘' : `줄 ${i + 1}`)).join('\n');
    render(<Chat {...props([user(long), answer('답')])} />);
    expect(screen.getByTestId('user-text').className).toContain('folded');
    fireEvent.keyDown(screen.getByRole('textbox', { name: '메시지' }), { key: 'f', metaKey: true });
    await act(async () => {
      fireEvent.change(screen.getByRole('searchbox', { name: '대화에서 찾기' }), { target: { value: '바늘' } });
      await Promise.resolve();
    });
    expect(screen.getByTestId('user-text').className).not.toContain('folded');
    expect(current()?.textContent).toBe('바늘');
    vi.useRealTimers();
  });
});
