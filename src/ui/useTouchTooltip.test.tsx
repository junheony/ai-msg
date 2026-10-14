// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { TIP_PRESS_MS, TIP_SHOW_MS, useTouchTooltip } from './useTouchTooltip';

function coarse(on: boolean) {
  window.matchMedia = ((q: string) => ({ matches: on && q.includes('coarse'), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
}
const tip = () => document.querySelector('.touch-tip');

describe('useTouchTooltip', () => {
  beforeEach(() => { vi.useFakeTimers(); coarse(true); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  function setup() {
    const onClick = vi.fn();
    renderHook(() => useTouchTooltip());
    render(<button type="button" title="맨 아래로" onClick={onClick}>↓</button>);
    return { btn: screen.getByRole('button'), onClick };
  }

  it('a long press shows the title; lifting hides it and swallows the click', () => {
    const { btn, onClick } = setup();
    fireEvent.pointerDown(btn, { pointerType: 'touch', clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(TIP_PRESS_MS - 1);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(tip()?.textContent).toBe('맨 아래로');
    expect(tip()?.getAttribute('role')).toBe('tooltip');
    fireEvent.pointerUp(btn, { pointerType: 'touch' });
    expect(tip()).toBeNull();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    // The next tap is a plain click again.
    fireEvent.pointerDown(btn, { pointerType: 'touch' });
    fireEvent.pointerUp(btn, { pointerType: 'touch' });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a short tap clicks without a bubble; moving cancels the press', () => {
    const { btn, onClick } = setup();
    fireEvent.pointerDown(btn, { pointerType: 'touch', clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(100);
    fireEvent.pointerUp(btn, { pointerType: 'touch' });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(btn, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(btn, { pointerType: 'touch', clientX: 10, clientY: 40 });
    vi.advanceTimersByTime(TIP_PRESS_MS);
    expect(tip()).toBeNull();
  });

  it('goes away by itself after TIP_SHOW_MS while still held', () => {
    const { btn } = setup();
    fireEvent.pointerDown(btn, { pointerType: 'touch' });
    vi.advanceTimersByTime(TIP_PRESS_MS);
    expect(tip()).not.toBeNull();
    vi.advanceTimersByTime(TIP_SHOW_MS);
    expect(tip()).toBeNull();
  });

  it('does nothing with a mouse or on a fine pointer', () => {
    const { btn } = setup();
    fireEvent.pointerDown(btn, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_PRESS_MS);
    expect(tip()).toBeNull();
    cleanup();
    coarse(false);
    const again = setup();
    fireEvent.pointerDown(again.btn, { pointerType: 'touch' });
    vi.advanceTimersByTime(TIP_PRESS_MS);
    expect(tip()).toBeNull();
  });
});
