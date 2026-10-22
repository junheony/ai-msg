// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Chat, type ChatProps } from './Chat';

// jsdom has no layout, hence no scrollIntoView.
Element.prototype.scrollIntoView = () => {};

function renderChat(extra: Partial<ChatProps> = {}) {
  const onSend = vi.fn();
  render(<Chat items={[]} pending={[]} questions={[]} activeTurnId={null} busy={false} title="t" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine="claude" sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={onSend} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} {...extra} />);
  return onSend;
}
const box = () => screen.getByLabelText('메시지') as HTMLTextAreaElement;
const type = (t: string) => fireEvent.change(box(), { target: { value: t } });
const chip = () => screen.queryByTestId('prompt-suggest-take');

describe('Composer: next prompt suggestion', () => {
  afterEach(cleanup);

  it('empty input: the suggestion is the placeholder, with a Tab chip', () => {
    renderChat({ suggestion: '테스트도 돌려줘' });
    expect(box().getAttribute('placeholder')).toBe('테스트도 돌려줘');
    expect(chip()?.textContent).toContain('Tab');
    expect(chip()?.textContent).toContain('추천 채우기');
  });

  it('Tab fills the suggestion without sending, cursor at the end', async () => {
    const onSend = renderChat({ suggestion: '커밋해줘' });
    expect(fireEvent.keyDown(box(), { key: 'Tab' })).toBe(false);
    expect(box().value).toBe('커밋해줘');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(box().selectionStart).toBe('커밋해줘'.length));
    expect(chip()).toBeNull();
  });

  it('Tab during an IME composition does nothing; modifier Tabs are left alone', () => {
    renderChat({ suggestion: '커밋해줘' });
    expect(fireEvent.keyDown(box(), { key: 'Tab', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: 'Tab', keyCode: 229 })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: 'Tab', shiftKey: true })).toBe(true);
    expect(box().value).toBe('');
  });

  it('typing hides the suggestion; clearing the input brings it back', () => {
    renderChat({ suggestion: '커밋해줘' });
    type('직접 쓸게');
    expect(box().getAttribute('placeholder')).not.toBe('커밋해줘');
    expect(chip()).toBeNull();
    expect(fireEvent.keyDown(box(), { key: 'Tab' })).toBe(true);
    expect(box().value).toBe('직접 쓸게');
    type('');
    expect(box().getAttribute('placeholder')).toBe('커밋해줘');
  });

  it('no suggestion: no chip and Tab keeps its default', () => {
    renderChat({ suggestion: null });
    expect(chip()).toBeNull();
    expect(fireEvent.keyDown(box(), { key: 'Tab' })).toBe(true);
  });

  it('hidden while a turn runs or the pane is read-only', () => {
    renderChat({ suggestion: '커밋해줘', busy: true });
    expect(chip()).toBeNull();
    cleanup();
    renderChat({ suggestion: '커밋해줘', readOnly: '읽기 전용' });
    expect(chip()).toBeNull();
  });

  it('the chip fills on tap (mobile path)', () => {
    const onSend = renderChat({ suggestion: '배포 확인해줘' });
    fireEvent.click(chip()!);
    expect(box().value).toBe('배포 확인해줘');
    expect(onSend).not.toHaveBeenCalled();
  });

  // No test of the @/slash popup taking Tab first: that popup opens only on a token (`@…`, `/…`), so the input is never
  // empty while it is open, and the suggestion shows only on an empty input — the two never meet. (Chat's onKeyDown still
  // hands keys to the popup before the suggestion.)
});
