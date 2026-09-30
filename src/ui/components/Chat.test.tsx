// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chat } from './Chat';
import type { ChatItem } from '../state';

// jsdom has no layout, hence no scrollIntoView.
Element.prototype.scrollIntoView = () => {};

const failed: ChatItem = { kind: 'assistant', turnId: 't', text: '', toolCalls: [], badge: null, streaming: false, error: '한도 도달', notes: [], attempts: [] };

function renderChat(items: ChatItem[], busy = false, onSend = vi.fn()) {
  render(<Chat items={items} pending={[]} activeTurnId={null} busy={busy} model="opus" title="t" onSend={onSend} onInterrupt={() => {}} onDecide={() => {}} onModel={() => {}} />);
  return onSend;
}

describe('Chat', () => {
  afterEach(cleanup);

  it('a failed last turn offers 재시도, which re-sends the same prompt', () => {
    const onSend = renderChat([{ kind: 'user', text: 'first' }, { ...failed, error: null, text: 'fine' }, { kind: 'user', text: 'do the thing' }, failed]);
    fireEvent.click(screen.getByText('재시도'));
    expect(onSend).toHaveBeenCalledWith('do the thing');
    expect(screen.getAllByText('재시도')).toHaveLength(1);
  });

  it('no 재시도 while busy or when the last turn succeeded', () => {
    renderChat([{ kind: 'user', text: 'x' }, failed], true);
    expect(screen.queryByText('재시도')).toBeNull();
    cleanup();
    renderChat([{ kind: 'user', text: 'x' }, { ...failed, error: null }]);
    expect(screen.queryByText('재시도')).toBeNull();
  });
});
