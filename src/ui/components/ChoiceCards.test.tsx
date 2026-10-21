// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageActionsContext, MessageView } from './MessageView';
import { Chat } from './Chat';
import type { ChatItem } from '../state';

Element.prototype.scrollIntoView = () => {};

const TEXT = '테스트 둘이 깨졌습니다.\n\n```deck-choices\n? 어떻게 할까요?\n- 지금 고치기\n- 이슈만 남기기\n```';
const reply = (text = TEXT, streaming = false): ChatItem => ({ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming, error: null, notes: [], attempts: [] });

describe('deck-choices option cards', () => {
  afterEach(cleanup);

  it('the last reply: the block becomes cards, a click sends the option once; the fence is not shown', () => {
    const onReply = vi.fn();
    const { container } = render(<MessageActionsContext.Provider value={{ onReply }}><MessageView item={reply()} last /></MessageActionsContext.Provider>);
    expect(container.textContent).not.toContain('deck-choices');
    expect(container.textContent).toContain('테스트 둘이 깨졌습니다.');
    expect(screen.getByTestId('choice-cards').textContent).toContain('어떻게 할까요?');
    const [fix, issue] = screen.getAllByTestId('choice') as HTMLButtonElement[];
    fireEvent.click(issue!);
    expect(onReply).toHaveBeenCalledWith('이슈만 남기기');
    expect(issue!.className).toContain('picked');
    expect(fix!.disabled).toBe(true);
    fireEvent.click(fix!);
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('an earlier reply, or no onReply (busy): cards shown disabled; while streaming: no cards, no fence', () => {
    render(<MessageActionsContext.Provider value={{ onReply: vi.fn() }}><MessageView item={reply()} last={false} /></MessageActionsContext.Provider>);
    for (const b of screen.getAllByTestId('choice') as HTMLButtonElement[]) expect(b.disabled).toBe(true);
    cleanup();
    const { container } = render(<MessageView item={reply('결과.\n```deck-choices\n- 지금', true)} last />);
    expect(screen.queryByTestId('choice-cards')).toBeNull();
    expect(container.textContent).not.toContain('deck-choices');
  });

  it('in a chat: a click sends the option as the user\'s reply; a busy chat does not', () => {
    const onSend = vi.fn();
    const props = { pending: [], questions: [], activeTurnId: null, title: 't', model: 'opus' as const, effort: 'high' as const, engine: 'codex' as const, sandbox: 'read-only' as const, sessionEngine: 'codex' as const, sessionSandbox: null, isNew: false, codexAvailable: true, attachments: [], onSend, onInterrupt: () => {}, onDecide: () => {}, onAnswer: () => {}, onModel: () => {}, onEffort: () => {}, onEngine: () => {}, onSandbox: () => {}, onAttach: () => {}, onUnattach: () => {} };
    const user: ChatItem = { kind: 'user', text: '테스트 돌려줘' } as ChatItem;
    render(<Chat {...props} items={[user, reply()]} busy={false} />);
    fireEvent.click(screen.getAllByTestId('choice')[0]!);
    expect(onSend).toHaveBeenCalledWith('지금 고치기');
    cleanup();
    render(<Chat {...props} items={[user, reply()]} busy />);
    for (const b of screen.getAllByTestId('choice') as HTMLButtonElement[]) expect(b.disabled).toBe(true);
  });

  it('a click sends only the option: files waiting in the composer are not attached to it', () => {
    const onSend = vi.fn();
    const onSendText = vi.fn();
    const props = { pending: [], questions: [], activeTurnId: null, title: 't', model: 'opus' as const, effort: 'high' as const, engine: 'codex' as const, sandbox: 'read-only' as const, sessionEngine: 'codex' as const, sessionSandbox: null, isNew: false, codexAvailable: true, attachments: [{ id: 'f1', name: 'a.png', size: 1, isImage: true }], onSend, onSendText, onInterrupt: () => {}, onDecide: () => {}, onAnswer: () => {}, onModel: () => {}, onEffort: () => {}, onEngine: () => {}, onSandbox: () => {}, onAttach: () => {}, onUnattach: () => {} };
    render(<Chat {...props} items={[{ kind: 'user', text: '테스트 돌려줘' } as ChatItem, reply()]} busy={false} />);
    fireEvent.click(screen.getAllByTestId('choice')[1]!);
    expect(onSendText).toHaveBeenCalledWith('이슈만 남기기');
    expect(onSend).not.toHaveBeenCalled();
  });
});
