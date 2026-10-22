// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionIconButton } from './SessionIconPicker';

describe('SessionIconButton: where the popover goes', () => {
  let rect = { left: 0, top: 0, bottom: 0 };
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ ...rect, right: rect.left + 40, width: 40, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect);
    Object.assign(window, { innerWidth: 1000, innerHeight: 500 });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const open = () => {
    render(<SessionIconButton current={null} onPick={() => {}} className="row-avatar-pick" />);
    fireEvent.click(screen.getByRole('button', { name: '아이콘 바꾸기' }));
    return screen.getByRole('dialog', { name: '세션 아이콘' });
  };

  it('fits neither below nor above: clamped into the viewport, top and left', () => {
    rect = { left: 900, top: 200, bottom: 240 };
    const d = open();
    expect(d.style.left).toBe('692px'); // 1000 - 300 - 8
    expect(d.style.top).toBe('92px'); // 500 - 400 - 8, not below the avatar (off the bottom)
  });

  it('follows the avatar on a scroll anywhere (capture) and on resize', () => {
    rect = { left: 10, top: 20, bottom: 60 };
    const d = open();
    expect(d.style.top).toBe('64px');
    rect = { left: 10, top: 0, bottom: 30 };
    act(() => { document.body.dispatchEvent(new Event('scroll')); }); // a scroll box's scroll does not bubble
    expect(d.style.top).toBe('34px');
    Object.assign(window, { innerHeight: 300 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(d.style.top).toBe('8px');
  });
});
