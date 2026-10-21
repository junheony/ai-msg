// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MSG_PRESS_MS, MessageActionsContext, MessageView, RegenerateContext, type MessageActions, type Regenerate } from './MessageView';
import { TurnBadge } from './TurnBadge';
import { DIVIDER_GAP_MS, timeDividers, timeLabel } from '../dateGroups';
import type { ChatItem } from '../state';

const reply = (text: string, extra: Partial<Extract<ChatItem, { kind: 'assistant' }>> = {}): ChatItem => ({ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], ...extra });
const badge = { account: 'a', model: 'opus', reason: '가장 여유', modelNote: null, usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheCreationTokens: 0 } } as never;

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** A touch press on `el` at (10, 10). */
const touchDown = (el: Element, id = 1) => fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: id, clientX: 10, clientY: 10 });

function userMsg(actions: MessageActions = {}) {
  render(<MessageActionsContext.Provider value={actions}><MessageView item={{ kind: 'user', text: '원래 질문', n: 0 }} /></MessageActionsContext.Provider>);
  return document.querySelector<HTMLElement>('.msg.user')!;
}

describe('message long press (touch)', () => {
  it(`opens the action sheet after ${MSG_PRESS_MS}ms, not before`, () => {
    vi.useFakeTimers();
    const msg = userMsg({ onEdit: () => {} });
    touchDown(msg.querySelector('pre')!);
    act(() => { vi.advanceTimersByTime(MSG_PRESS_MS - 1); });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    const sheet = screen.getByRole('dialog', { name: '메시지 메뉴' });
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent)).toEqual(['복사', '편집', '닫기']);
  });

  it('a finger that moves (a scroll), a mouse, or a press on a control inside opens nothing', () => {
    vi.useFakeTimers();
    const msg = userMsg({ onEdit: () => {} });
    const text = msg.querySelector('pre')!;
    touchDown(text);
    fireEvent.pointerMove(text, { pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 40 });
    act(() => { vi.advanceTimersByTime(MSG_PRESS_MS * 2); });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.pointerDown(text, { pointerType: 'mouse', pointerId: 2, clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(MSG_PRESS_MS * 2); });
    expect(screen.queryByRole('dialog')).toBeNull();
    touchDown(screen.getByRole('button', { name: '편집' }), 3);
    act(() => { vi.advanceTimersByTime(MSG_PRESS_MS * 2); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Esc closes the sheet and focus goes back to the message; Tab stays inside', () => {
    vi.useFakeTimers();
    const msg = userMsg({ onEdit: () => {} });
    touchDown(msg.querySelector('pre')!);
    act(() => { vi.advanceTimersByTime(MSG_PRESS_MS); });
    const items = within(screen.getByRole('dialog')).getAllByRole('button');
    expect(document.activeElement).toBe(items[0]);
    items[items.length - 1]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(msg);
  });

  it('user message: 복사 copies, 편집 runs, 버전 ‹ › switch — every hover action is in the sheet', async () => {
    vi.useFakeTimers();
    const onEdit = vi.fn();
    const go = vi.fn();
    const msg = userMsg({ onEdit, versions: () => ({ index: 1, count: 3, go }) });
    const open = () => { touchDown(msg.querySelector('pre')!); act(() => { vi.advanceTimersByTime(MSG_PRESS_MS); }); return screen.getByRole('dialog'); };
    fireEvent.click(within(open()).getByRole('button', { name: '복사' }));
    expect(writeText).toHaveBeenCalledWith('원래 질문');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(open()).getByRole('button', { name: '편집' }));
    expect(onEdit).toHaveBeenCalledWith('원래 질문');
    const sheet = open();
    expect(within(sheet).getByRole('group', { name: '버전' }).textContent).toContain('버전 2/3');
    fireEvent.click(within(sheet).getByRole('button', { name: '다음 버전' }));
    expect(go).toHaveBeenCalledWith(2);
  });

  it('an earlier reply: 다시 생성 and 다른 모델로 (model list) from the sheet', () => {
    vi.useFakeTimers();
    const branch = vi.fn();
    const regen: Regenerate = { turnOf: () => ({ n: 0, text: '질문' }), branch, models: ['opus', 'sonnet'], current: 'opus' };
    render(<RegenerateContext.Provider value={regen}><MessageView item={reply('예전 답')} /></RegenerateContext.Provider>);
    const msg = document.querySelector('.msg.assistant')!;
    expect(msg.classList.contains('last')).toBe(false);
    touchDown(msg.querySelector('p')!);
    act(() => { vi.advanceTimersByTime(MSG_PRESS_MS); });
    let sheet = screen.getByRole('dialog');
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent)).toEqual(['복사', '다시 생성', '다른 모델로 다시 생성', '닫기']);
    fireEvent.click(within(sheet).getByRole('button', { name: '다시 생성' }));
    expect(branch).toHaveBeenCalledWith({ n: 0, text: '질문' });
    touchDown(msg.querySelector('p')!);
    act(() => { vi.advanceTimersByTime(MSG_PRESS_MS); });
    sheet = screen.getByRole('dialog');
    const more = within(sheet).getByRole('button', { name: '다른 모델로 다시 생성' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(within(sheet).getByRole('group', { name: '다시 생성할 모델' })).getByRole('button', { name: /Sonnet/ }));
    expect(branch).toHaveBeenLastCalledWith({ n: 0, text: '질문' }, 'sonnet');
  });

  it('the last reply keeps its action row in the page (재시도 one tap); touch CSS hides only the other messages\' rows', () => {
    render(<MessageActionsContext.Provider value={{ onRetry: () => {} }}><MessageView item={reply('마지막')} last /></MessageActionsContext.Provider>);
    expect(document.querySelector('.msg.assistant.last')).not.toBeNull();
    expect(screen.getByRole('button', { name: '응답 복사' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '재시도' })).toBeTruthy();
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/\.msg\.assistant\.last \.msg-actions \{ opacity: 1; \}|\.msg\.assistant\.last \.msg-actions[^{]*\{ opacity: 1; \}/);
    const touch = [...css.matchAll(/@media \(hover: none\) \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]!).find((b) => b.includes('.msg-actions'))!;
    expect(touch).toContain('.msg:not(.last) .msg-actions:not(:focus-within)');
    expect(touch).toContain('-webkit-touch-callout: none');
    expect(touch).not.toMatch(/(^|\n)\s*\.msg-actions \{ opacity: 1; \}/);
  });
});

describe('turn meta pill', () => {
  it('model · account in the pill; tokens and reason open from it, Esc closes back to the pill', () => {
    render(<TurnBadge badge={badge} />);
    const details = screen.getByTestId('turn-badge') as HTMLDetailsElement;
    const pill = details.querySelector('summary')!;
    expect(pill.textContent).toBe('OpusA');
    expect(details.open).toBe(false);
    fireEvent.click(pill);
    expect(details.open).toBe(true);
    expect(details.querySelector('.tb-detail')!.textContent).toContain('입력 1.2k');
    fireEvent.keyDown(pill, { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(pill);
  });

  it('a dot for a cache note, and for the last reply\'s expired cache (the old line above the composer)', () => {
    const { rerender } = render(<TurnBadge badge={badge} />);
    expect(screen.queryByTestId('badge-dot')).toBeNull();
    rerender(<TurnBadge badge={badge} ctx={{ usage: { inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1 }, window: 200_000, at: Date.now() - 2 * 3600_000, model: 'opus', account: null } as never} />);
    expect(screen.getByTestId('badge-dot')).toBeTruthy();
    expect(screen.getByTestId('badge-cold').textContent).toBe('캐시 만료 · 이번 턴은 전체 다시 읽기');
  });
});

describe('time dividers', () => {
  const at = (ms: number) => ({ kind: 'assistant', ctx: { at: ms } });
  const u = { kind: 'user' };
  const t0 = new Date(2026, 9, 21, 11, 50).getTime();

  it('Grok Bot labels: 오전/오후 h:mm today, 어제, then the date (the year only when it differs)', () => {
    const now = new Date(2026, 9, 21, 18, 0).getTime();
    expect(timeLabel(t0, now)).toBe('오전 11:50');
    expect(timeLabel(new Date(2026, 9, 21, 0, 5).getTime(), now)).toBe('오전 12:05');
    expect(timeLabel(new Date(2026, 9, 20, 15, 5).getTime(), now)).toBe('어제 오후 3:05');
    expect(timeLabel(new Date(2026, 9, 2, 9, 0).getTime(), now)).toBe('10월 2일 오전 9:00');
    expect(timeLabel(new Date(2025, 0, 2, 9, 0).getTime(), now)).toBe('2025년 1월 2일 오전 9:00');
  });

  it('before the first exchange, and after a pause longer than the gap; never between close turns', () => {
    const items = [u, at(t0), u, at(t0 + 60_000), u, { kind: 'assistant' }, at(t0 + DIVIDER_GAP_MS + 120_000)];
    expect(timeDividers(items)).toEqual([t0, null, null, null, t0 + DIVIDER_GAP_MS + 120_000, null, null]);
    expect(timeDividers([u, { kind: 'assistant' }])).toEqual([null, null]);
  });
});
