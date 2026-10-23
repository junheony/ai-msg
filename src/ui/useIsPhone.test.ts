// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePhoneMode, useIsPhone } from './useIsPhone';

type Pointer = 'coarse' | 'fine';
const listeners = new Set<() => void>();

/** A window of w×h on a screen of sw×sh (the screen's own numbers, portrait or not). Only the media features useIsPhone reads. */
function device(w: number, h: number, pointer: Pointer, sw = w, sh = h) {
  window.innerWidth = w;
  window.innerHeight = h;
  window.matchMedia = ((query: string) => ({
    get matches() {
      if (query === '(max-width: 720px)') return window.innerWidth <= 720;
      if (query === '(pointer: coarse)') return pointer === 'coarse';
      if (query === '(orientation: landscape)') return window.innerWidth > window.innerHeight;
      throw new Error(`unexpected query ${query}`);
    },
    media: query, onchange: null,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb), removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window.screen, 'width', { value: sw, configurable: true });
  Object.defineProperty(window.screen, 'height', { value: sh, configurable: true });
  Object.defineProperty(window.screen, 'orientation', { value: { type: sw > sh ? 'landscape-primary' : 'portrait-primary', addEventListener() {}, removeEventListener() {} }, configurable: true });
}

describe('useIsPhone', () => {
  afterEach(() => {
    cleanup();
    listeners.clear();
    (window as { matchMedia?: unknown }).matchMedia = undefined;
    Object.defineProperty(window.screen, 'width', { value: 0, configurable: true });
    Object.defineProperty(window.screen, 'height', { value: 0, configurable: true });
    Object.defineProperty(window.screen, 'orientation', { value: undefined, configurable: true });
  });

  it.each([
    [844, 390, 'coarse', 'landscape'], // phone on its side
    [932, 430, 'coarse', 'landscape'], // large phone on its side
    [390, 844, 'coarse', 'portrait'], // phone
    [626, 780, 'coarse', 'portrait'], // foldable unfolded, upright
    [466, 678, 'coarse', 'portrait'], // foldable's cover screen
    [720, 900, 'fine', 'portrait'], // the width edge, any pointer
    [1024, 768, 'coarse', ''], // tablet on its side
    [1440, 900, 'fine', ''], // desktop
    [1280, 560, 'fine', ''], // a short laptop window
    [800, 450, 'fine', ''], // a very short one, still a mouse
  ] as const)('%i×%i %s → "%s"', (w, h, pointer, mode) => {
    device(w, h, pointer);
    expect(renderHook(() => usePhoneMode()).result.current).toBe(mode);
    expect(document.documentElement.getAttribute('data-phone')).toBe(mode || null);
  });

  it('a foldable unfolded on its side (890×510 under the bars, a 890×626 screen) is a phone', () => {
    device(890, 510, 'coarse', 890, 626);
    expect(renderHook(() => usePhoneMode()).result.current).toBe('landscape');
  });

  it('the keyboard shortening a tablet\'s window does not make it a phone (only innerHeight changes)', () => {
    device(1280, 800, 'coarse');
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(false);
    act(() => { window.innerHeight = 450; window.dispatchEvent(new Event('resize')); });
    expect(result.current).toBe(false);
    expect(document.documentElement.hasAttribute('data-phone')).toBe(false);
  });

  it('nor turns an upright foldable "landscape" when the keyboard leaves a wide, low window', () => {
    device(626, 780, 'coarse', 626, 890);
    const { result } = renderHook(() => usePhoneMode());
    act(() => { window.innerHeight = 400; window.dispatchEvent(new Event('resize')); });
    expect(result.current).toBe('portrait');
  });

  it('judged again when the window narrows (a fold, a split) and when it widens back', () => {
    device(1000, 700, 'fine');
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(false);
    act(() => { window.innerWidth = 600; listeners.forEach((cb) => cb()); });
    expect(result.current).toBe(true);
    act(() => { window.innerWidth = 1000; window.dispatchEvent(new Event('resize')); });
    expect(result.current).toBe(false);
  });

  it('styles.css: the phone layout, the phone toasts and the sideways bars follow data-phone, not a media query of their own', () => {
    const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
    expect(css).toContain('/* ───────── Phone ───────── */\n:where(:root[data-phone]) {\n  .topbar');
    expect(css).toContain(':where(:root[data-phone]) {\n  .toasts { top: auto;');
    expect(css).toContain(':where(:root[data-phone="landscape"]) {\n  .topbar {');
    expect(css).not.toMatch(/max-height: 560px\) and \(orientation/);
  });
});
