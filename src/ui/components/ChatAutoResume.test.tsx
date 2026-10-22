// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chat, type ChatProps } from './Chat';
import { ui } from '../i18n';

// jsdom has no layout, hence no scrollIntoView.
Element.prototype.scrollIntoView = () => {};

function renderChat(extra: Partial<ChatProps> = {}) {
  render(<Chat items={[]} pending={[]} questions={[]} activeTurnId={null} busy={false} title="t" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine="claude" sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={() => {}} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} {...extra} />);
}

describe('Chat: 한도가 풀리면 자동으로 이어가기 line', () => {
  afterEach(cleanup);

  it('no booking, no line', () => {
    renderChat();
    expect(screen.queryByTestId('auto-resume')).toBeNull();
  });

  it('one meta line with the local time; 취소 cancels', () => {
    const onCancel = vi.fn();
    renderChat({ autoResume: { atMs: new Date(2026, 9, 23, 1, 40).getTime(), onCancel } });
    const line = screen.getByTestId('auto-resume');
    expect(line.textContent).toContain(ui().chat.autoResume.at('1:40'));
    expect(line.querySelector('.turn-meta-text')).toBeTruthy();
    fireEvent.click(screen.getByTestId('auto-resume-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('hidden while a turn runs', () => {
    renderChat({ busy: true, autoResume: { atMs: Date.now() + 60_000, onCancel: () => {} } });
    expect(screen.queryByTestId('auto-resume')).toBeNull();
  });
});
