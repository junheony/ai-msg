// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeadItem, SessionChipHead } from './SessionChipHead';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const head = (over: { sessionKey?: string; onRename?: (t: string | null) => void; phone?: boolean; run?: () => void } = {}) => (
  <SessionChipHead title="세션 1" sessionKey={over.sessionKey ?? 's1'} phone={over.phone} {...(over.onRename ? { onRename: over.onRename } : {})}
    groups={(ctl) => [[<HeadItem key="a" label="첫째" run={over.run ?? (() => {})} ctl={ctl} />, <HeadItem key="b" label="둘째" run={() => {}} ctl={ctl} />]]} />
);
const startRename = () => {
  fireEvent.doubleClick(screen.getByTestId('session-chip-head'));
  const input = screen.getByLabelText('채팅 이름') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '새 이름' } });
  return input;
};

describe('SessionChipHead · 이름 바꾸기', () => {
  it('Enter saves, Esc cancels, a keyboard blur (Tab) saves', () => {
    const onRename = vi.fn();
    render(head({ onRename }));
    fireEvent.keyDown(startRename(), { key: 'Enter' });
    expect(onRename).toHaveBeenLastCalledWith('새 이름');
    fireEvent.keyDown(startRename(), { key: 'Escape' });
    expect(onRename).toHaveBeenCalledTimes(1);
    fireEvent.blur(startRename());
    expect(onRename).toHaveBeenCalledTimes(2);
  });

  it('a press elsewhere that switches the session (the same head kept) drops the edit', () => {
    vi.useFakeTimers();
    const onRename = vi.fn();
    const { rerender } = render(head({ onRename }));
    const input = startRename();
    fireEvent.pointerDown(document.body);
    fireEvent.blur(input);
    fireEvent.pointerUp(document.body);
    // The sidebar row's click switches the session before the deferred save runs.
    rerender(head({ onRename, sessionKey: 's2' }));
    fireEvent.click(document.body);
    act(() => { vi.runAllTimers(); });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('채팅 이름')).toBeNull();
  });

  it('a press elsewhere that unmounts the head (Chat keys it by session) drops the edit; one that does not saves', () => {
    vi.useFakeTimers();
    const onRename = vi.fn();
    const { unmount } = render(head({ onRename }));
    let input = startRename();
    fireEvent.pointerDown(document.body);
    fireEvent.blur(input);
    fireEvent.pointerUp(document.body);
    unmount();
    act(() => { vi.runAllTimers(); });
    expect(onRename).not.toHaveBeenCalled();
    render(head({ onRename }));
    input = startRename();
    fireEvent.pointerDown(document.body);
    fireEvent.blur(input);
    fireEvent.pointerUp(document.body);
    fireEvent.click(document.body);
    act(() => { vi.runAllTimers(); });
    expect(onRename).toHaveBeenCalledWith('새 이름');
  });
});

describe('SessionChipHead · 폰 시트', () => {
  it('is a modal dialog in <body>: Tab stays inside, Esc closes and focus returns to the chip', () => {
    render(<div className="topbar">{head({ phone: true })}</div>);
    const chip = screen.getByTestId('session-chip-head');
    fireEvent.click(chip);
    const dialog = screen.getByRole('dialog', { name: '세션 메뉴' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.closest('.topbar')).toBeNull();
    const [first, second] = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: 'Tab' });
    expect(screen.getByRole('dialog', { name: '세션 메뉴' })).toBeTruthy();
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '세션 메뉴' })).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('a press on the scrim closes it; one inside the sheet does not', () => {
    render(head({ phone: true }));
    fireEvent.click(screen.getByTestId('session-chip-head'));
    const dialog = screen.getByRole('dialog', { name: '세션 메뉴' });
    fireEvent.pointerDown(dialog);
    expect(screen.getByRole('dialog', { name: '세션 메뉴' })).toBeTruthy();
    fireEvent.pointerDown(document.querySelector('.head-menu-scrim')!);
    expect(screen.queryByRole('dialog', { name: '세션 메뉴' })).toBeNull();
  });

  it('desktop keeps a role="menu" dropdown under the chip, Tab closes it', () => {
    render(head());
    fireEvent.click(screen.getByTestId('session-chip-head'));
    const menu = screen.getByRole('menu');
    expect(menu.closest('.head-chip-wrap')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
