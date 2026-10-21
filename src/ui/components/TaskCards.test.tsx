// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chat, type ChatProps } from './Chat';
import { TaskCards } from './TaskCards';
import type { TaskInfo } from '../../shared/tasks';

Element.prototype.scrollIntoView = () => {};

const task = (p: Partial<TaskInfo>): TaskInfo => ({ taskId: 'k', fromSessionId: 's', cwd: '/w', title: '버그 고치기', status: 'running', sessionId: null, createdAt: 1, ...p });

function renderChat(extra: Partial<ChatProps> = {}) {
  const onSend = vi.fn();
  render(<Chat items={[]} pending={[]} questions={[]} activeTurnId={null} busy={false} title="t" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine={null} sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={onSend} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} {...extra} />);
  return onSend;
}

describe('백그라운드 작업 UI', () => {
  afterEach(cleanup);

  it('cards: running, queued (with the cap), done with its result line, open and dismiss', () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(<TaskCards cap={3} onOpen={onOpen} onDismiss={onDismiss} tasks={[
      task({ taskId: 'a', status: 'running', sessionId: 'sa' }),
      task({ taskId: 'b', status: 'queued' }),
      task({ taskId: 'c', status: 'done', sessionId: 'sc', line: '고쳤습니다' }),
    ]} />);
    const cards = screen.getAllByTestId('task-card');
    expect(cards.map((c) => c.className)).toEqual(['task-card running', 'task-card queued', 'task-card done']);
    expect(cards[1]!.textContent).toContain('동시 작업 3개');
    expect(cards[2]!.textContent).toContain('고쳤습니다');
    fireEvent.click(screen.getAllByTestId('task-open')[1]!);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'c' }));
    expect(screen.getAllByTestId('task-dismiss')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('task-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('c');
  });

  it('composer: /bg and 작업으로 start a task instead of sending; without the hook they do not exist', () => {
    const onStartTask = vi.fn();
    const onSend = renderChat({ onStartTask, tasks: [task({ status: 'done', line: '끝' })] });
    expect(screen.getByTestId('task-cards').textContent).toContain('끝');
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '/bg 테스트 돌려줘' } });
    expect(screen.queryByTestId('task-add')).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onStartTask).toHaveBeenCalledWith('테스트 돌려줘');
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '로그 정리해줘' } });
    fireEvent.click(screen.getByTestId('task-add'));
    expect(onStartTask).toHaveBeenLastCalledWith('로그 정리해줘');
    expect(box.value).toBe('');
    cleanup();
    renderChat();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '뭐' } });
    expect(screen.queryByTestId('task-add')).toBeNull();
  });

  it('취소 on waiting and running cards (not on ended ones); 승인 대기 on a running task stopped on a card', () => {
    const onCancel = vi.fn();
    render(<TaskCards onCancel={onCancel} tasks={[
      task({ taskId: 'a', status: 'running', waiting: true }),
      task({ taskId: 'b', status: 'queued' }),
      task({ taskId: 'c', status: 'done', line: '끝' }),
    ]} />);
    expect(screen.getAllByTestId('task-waiting')).toHaveLength(1);
    expect(screen.getAllByTestId('task-card')[0]!.textContent).toContain('승인 대기');
    const cancels = screen.getAllByTestId('task-cancel');
    expect(cancels).toHaveLength(2);
    fireEvent.click(cancels[1]!);
    expect(onCancel).toHaveBeenCalledWith('b');
  });

  it('composer: a task that could not be sent (offline) keeps the draft', () => {
    const onStartTask = vi.fn(() => false);
    renderChat({ onStartTask });
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '/bg 테스트 돌려줘' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onStartTask).toHaveBeenCalledWith('테스트 돌려줘');
    expect(box.value).toBe('/bg 테스트 돌려줘');
    fireEvent.change(box, { target: { value: '로그 정리해줘' } });
    fireEvent.click(screen.getByTestId('task-add'));
    expect(box.value).toBe('로그 정리해줘');
  });
});
