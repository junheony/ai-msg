import { useSyncExternalStore } from 'react';

/**
 * D10: a phone — the sidebar is a drawer and one pane is shown. Two ways in:
 * - the window is 720px wide or less (the width does not move with the on-screen keyboard);
 * - a touch screen whose SHORT side is 640px or less (a phone on its side, 844×390; a foldable's inner screen, ~626 —
 *   890×510 under the browser's bars). The screen's size, not the window's height: Android Chrome
 *   (interactive-widget=resizes-content) shortens the window while the keyboard is up, and a 1280×800 tablet typing at
 *   ~450px tall must not turn into a phone and back. 640 leaves out the smallest tablet (744).
 * The answer is kept on `<html data-phone="portrait|landscape">` and styles.css follows that attribute, so the CSS and
 * the components never disagree. Judged again on resize, rotation, a fold / unfold and a pointer change.
 */
export type PhoneMode = '' | 'portrait' | 'landscape';

const WIDTH_QUERY = '(max-width: 720px)';
const COARSE_QUERY = '(pointer: coarse)';
const SHORT_SIDE = 640;

const mm = (q: string): boolean => typeof window.matchMedia === 'function' && !!window.matchMedia(q)?.matches;

/** Held sideways, by the screen (the window turns "landscape" in portrait while the keyboard is up). */
function sideways(): boolean {
  const type = screen.orientation?.type;
  if (type) return type.startsWith('landscape');
  const angle = (window as { orientation?: number }).orientation; // older iOS Safari
  if (typeof angle === 'number') return Math.abs(angle) === 90;
  return mm('(orientation: landscape)');
}

/** The judgement now, uncached: '' on a desktop or a tablet. */
export function phoneMode(): PhoneMode {
  if (typeof window === 'undefined' || typeof screen === 'undefined') return '';
  const short = screen.width > 0 && screen.height > 0 ? Math.min(screen.width, screen.height) : Infinity;
  const touchPhone = short <= SHORT_SIDE && mm(COARSE_QUERY);
  if (!touchPhone && !mm(WIDTH_QUERY)) return '';
  return touchPhone && sideways() ? 'landscape' : 'portrait';
}

export const isPhoneNow = (): boolean => phoneMode() !== '';

let current: PhoneMode | null = null;
const subs = new Set<() => void>();
let detach: (() => void) | null = null;

function refresh() {
  const next = phoneMode();
  const root = document.documentElement;
  // Written only on a change: resize fires on every keyboard rise and fall.
  if ((root.getAttribute('data-phone') ?? '') !== next) {
    if (next) root.setAttribute('data-phone', next);
    else root.removeAttribute('data-phone');
  }
  if (next === current) return;
  current = next;
  subs.forEach((cb) => cb());
}

function attach(): () => void {
  const mqls = typeof window.matchMedia === 'function' ? [WIDTH_QUERY, COARSE_QUERY].map((q) => window.matchMedia(q)).filter(Boolean) : [];
  const so = screen.orientation;
  mqls.forEach((m) => m.addEventListener?.('change', refresh));
  window.addEventListener('resize', refresh);
  window.addEventListener('orientationchange', refresh);
  so?.addEventListener?.('change', refresh);
  return () => {
    mqls.forEach((m) => m.removeEventListener?.('change', refresh));
    window.removeEventListener('resize', refresh);
    window.removeEventListener('orientationchange', refresh);
    so?.removeEventListener?.('change', refresh);
  };
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (!detach) detach = attach();
  refresh();
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && detach) { detach(); detach = null; current = null; }
  };
}

const snapshot = (): PhoneMode => (current ??= phoneMode());

/** Keeps `<html data-phone>` current for the page's whole life; main.tsx calls it before the first render. */
export function watchPhone(): void { subscribe(() => {}); }

export function usePhoneMode(): PhoneMode {
  return useSyncExternalStore(subscribe, snapshot, () => '');
}

export function useIsPhone(): boolean {
  return usePhoneMode() !== '';
}
