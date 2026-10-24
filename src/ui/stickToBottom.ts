import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Within this many px of the bottom, scrolling down re-attaches (Desktop-like). */
export const STICK_THRESHOLD = 64;
/** At most this far from the bottom counts as "at the bottom" whatever the direction (sub-pixel rounding). */
const AT_BOTTOM = 2;

export type ScrollSample = { top: number; height: number; client: number };

export const distanceFromBottom = (s: ScrollSample) => s.height - s.top - s.client;

/**
 * Whether the transcript follows new content after a scroll event.
 * - at the very bottom: attached (our own follow lands here, and so does the browser clamping on shrink);
 * - moved up: detached — only a user (wheel, touch, keys, scrollbar) or a deliberate jump (search hit) moves it up,
 *   our follow only ever moves it down;
 * - moved down into the threshold by the user (content height unchanged — not a scroll-anchoring shift): attached;
 * - otherwise unchanged (e.g. content growth while detached).
 */
export function nextStick(stick: boolean, prev: { top: number; height: number }, s: ScrollSample, threshold = STICK_THRESHOLD): boolean {
  const dist = distanceFromBottom(s);
  if (dist <= AT_BOTTOM) return true;
  if (s.top < prev.top - 1) return false;
  if (s.top > prev.top && s.height === prev.height && dist <= threshold) return true;
  return stick;
}

/** A touch drag must travel this far down, and further down than sideways, to count as scrolling up: a sideways swipe on a wide
 *  code block or table, or finger jitter, must not stop the follow. */
export const TOUCH_DETACH_PX = 10;
export const touchDetaches = (start: { x: number; y: number }, now: { x: number; y: number }): boolean => {
  const dx = now.x - start.x;
  const dy = now.y - start.y;
  return dy > TOUCH_DETACH_PX && dy > Math.abs(dx);
};
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
const nativeAnchoring = () => typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('overflow-anchor', 'auto');

/**
 * Stick-to-bottom for a scroll container whose direct children are the transcript.
 * State lives in refs; React state changes only on detach/attach.
 * `resetKey` changing (session switch) re-attaches; `contentKey` changing (new items) follows when attached.
 * `turns` = stable keys of the messages so far: `unread` is how many follow the one that was last when the view detached
 * (0 = only scrolled away — growth of a message already there, e.g. a streaming reply, is not new — or that message is
 * gone, e.g. the list was rebuilt: the count is unknown, so none is shown).
 */
/** The first child of `el` crossing its top edge, and how far below that edge its top is (negative: above it). */
export function viewAnchor(el: HTMLElement): { el: Element; offset: number } | null {
  const top = el.getBoundingClientRect().top;
  const kids = el.children;
  let lo = 0, hi = kids.length - 1, found: Element | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const kid = kids[mid]!;
    if (kid.getBoundingClientRect().bottom > top) { found = kid; hi = mid - 1; } else lo = mid + 1;
  }
  return found ? { el: found, offset: found.getBoundingClientRect().top - top } : null;
}

export function useStickToBottom(ref: RefObject<HTMLElement | null>, contentKey: unknown, resetKey: unknown, turns: readonly string[] = []) {
  const stick = useRef(true);
  const lastTop = useRef(0);
  /** scrollHeight at the last scroll event (nextStick). */
  const scrollHeight = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // Manual anchoring (browsers without overflow-anchor, i.e. Safari): the first child crossing the viewport top.
  const anchor = useRef<{ el: Element; offset: number } | null>(null);
  const [detached, setDetached] = useState(false);
  /** The last turn's key when the view last detached (null: there was none). */
  const [mark, setMark] = useState<string | null>(null);
  const latest = useRef(turns);
  latest.current = turns;
  const shown = useRef(false);

  const publish = useCallback((d: boolean) => {
    if (shown.current === d) return;
    shown.current = d;
    setDetached(d);
    if (d) setMark(latest.current[latest.current.length - 1] ?? null);
  }, []);

  const recordAnchor = useCallback((el: HTMLElement) => {
    if (nativeAnchoring()) return;
    anchor.current = viewAnchor(el);
  }, []);

  const toBottom = useCallback((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  /** Content or viewport changed size: follow when attached, else keep what the user reads in place. */
  const onResize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) { toBottom(el); return; }
    const a = anchor.current;
    if (a && a.el.isConnected && !nativeAnchoring()) {
      const delta = a.el.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
      if (Math.abs(delta) > 0.5) { el.scrollTop += delta; lastTop.current = el.scrollTop; }
    }
    recordAnchor(el);
  }, [ref, toBottom, recordAnchor]);

  const detach = useCallback(() => {
    const el = ref.current;
    if (!el || el.scrollTop <= 0 || !stick.current) return;
    stick.current = false;
    publish(true);
  }, [ref, publish]);

  /** Jump to the bottom and follow again (jump button, send, session switch). */
  const attach = useCallback(() => {
    stick.current = true;
    const el = ref.current;
    if (el) toBottom(el);
    publish(false);
  }, [ref, toBottom, publish]);

  /**
   * A card that needs the user (a question / approval) just appeared while following: when it is taller than the view,
   * show its head instead of the bottom (detached, so the follow does not pull it away); a card that fits keeps the
   * follow. Not following (the user scrolled up to read): left alone.
   */
  const revealTop = useCallback((target: HTMLElement, gap = 8) => {
    const el = ref.current;
    if (!el || !stick.current || target.offsetHeight <= el.clientHeight - gap) return;
    stick.current = false;
    el.scrollTop = Math.max(0, el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - gap);
    lastTop.current = el.scrollTop;
    recordAnchor(el);
    publish(true);
  }, [ref, recordAnchor, publish]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const s = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
      stick.current = nextStick(stick.current, { top: lastTop.current, height: scrollHeight.current }, s);
      lastTop.current = s.top;
      scrollHeight.current = s.height;
      if (stick.current) publish(false);
      else { publish(true); recordAnchor(el); }
    };
    // Upward intent detaches at once, before the scroll lands (a follow in the same frame would undo it).
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) detach(); };
    const onKey = (e: KeyboardEvent) => { if (UP_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)) detach(); };
    // The start point stays fixed for the whole gesture: per-move deltas would let slow drags and jitter slip under the threshold.
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t && touchStart.current && touchDetaches(touchStart.current, { x: t.clientX, y: t.clientY })) detach();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      const obs = new ResizeObserver(onResize);
      ro = obs;
      obs.observe(el);
      for (const c of el.children) obs.observe(c);
      if (typeof MutationObserver !== 'undefined') {
        mo = new MutationObserver((records) => {
          for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) obs.observe(n);
        });
        mo.observe(el, { childList: true });
      }
    }
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [ref, onResize, detach, publish, recordAnchor]);

  // New items: same as a resize (the ResizeObserver also catches growth inside a message, images, expanding cards).
  useLayoutEffect(onResize, [contentKey, onResize]);

  // Session switch: open at the bottom.
  const prevReset = useRef(resetKey);
  useLayoutEffect(() => {
    if (prevReset.current === resetKey) return;
    const wasSession = prevReset.current != null;
    prevReset.current = resetKey;
    if (wasSession) attach();
  }, [resetKey, attach]);

  const at = mark === null ? -1 : turns.lastIndexOf(mark);
  const unread = !detached || (mark !== null && at < 0) ? 0 : turns.length - 1 - at;
  return { detached, unread, attach, revealTop };
}
