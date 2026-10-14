// Split-view panes as cards: drag a pane's grip to reorder it among the docked panes, pull it off the rail into a
// floating card, or drop a floating card back onto the rail. Pure geometry here; the DOM drag lives in App.tsx.
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { dropIndex } from './pinOrder';

/** A floating card's box, in px relative to the `.body` area (under the header, sidebar included). */
export type FloatRect = { x: number; y: number; w: number; h: number };

export const FLOAT_MIN_W = 320;
export const FLOAT_MIN_H = 240;
/** The widest / tallest a stored card may claim (the CSS clamps it to the viewport anyway). */
const FLOAT_MAX = 10_000;
/** How much of a card must stay on screen when it is placed. */
const FLOAT_KEEP_X = 120;
const FLOAT_KEEP_Y = 48;
/** A pointer within this many px of the panes' top edge is "on the rail" (reorder / dock); below it the pane floats. */
export const RAIL_PX = 72;

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** A stored rect, validated; null for anything not a usable box. */
export function readFloat(x: unknown): FloatRect | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (!num(r.x) || !num(r.y) || !num(r.w) || !num(r.h)) return null;
  if (r.w < FLOAT_MIN_W || r.h < FLOAT_MIN_H || r.w > FLOAT_MAX || r.h > FLOAT_MAX || Math.abs(r.x) > FLOAT_MAX || Math.abs(r.y) > FLOAT_MAX) return null;
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

/** The rect kept inside `bounds` (the body's size): at least a strip of it stays reachable, and it never exceeds the box. */
export function clampFloat(r: FloatRect, bounds: { w: number; h: number }): FloatRect {
  const w = Math.max(FLOAT_MIN_W, Math.min(r.w, Math.max(FLOAT_MIN_W, bounds.w)));
  const h = Math.max(FLOAT_MIN_H, Math.min(r.h, Math.max(FLOAT_MIN_H, bounds.h)));
  const x = Math.max(Math.min(0, bounds.w - w), Math.min(r.x, Math.max(0, bounds.w - FLOAT_KEEP_X)));
  const y = Math.max(0, Math.min(r.y, Math.max(0, bounds.h - FLOAT_KEEP_Y)));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Where a pane pulled off the rail lands: a card about as wide as it was (capped), hanging from the pointer so the
 * grip stays under the finger. `pointer` is relative to the body; `source` the pane's size on the rail.
 */
export function floatRectAt(pointer: { x: number; y: number }, source: { w: number; h: number }, bounds: { w: number; h: number }): FloatRect {
  const w = Math.min(Math.max(FLOAT_MIN_W, source.w), 560, Math.max(FLOAT_MIN_W, bounds.w - 24));
  const h = Math.min(Math.max(FLOAT_MIN_H, Math.round(source.h * 0.8)), Math.max(FLOAT_MIN_H, bounds.h - 24));
  return clampFloat({ x: pointer.x - Math.round(w * 0.3), y: pointer.y - 18, w, h }, bounds);
}

/** Gap between / around cards laid out by `arrangeFloats`. */
const ARRANGE_GAP = 12;

/**
 * `count` floating cards dealt into a grid over the body (as square as fits, row-major): every card the same size,
 * each at least the minimum — a body too small for that overlaps them a little rather than shrinking them.
 */
export function arrangeFloats(count: number, bounds: { w: number; h: number }): FloatRect[] {
  if (count <= 0) return [];
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = Math.max(FLOAT_MIN_W, Math.floor((bounds.w - ARRANGE_GAP * (cols + 1)) / cols));
  const h = Math.max(FLOAT_MIN_H, Math.floor((bounds.h - ARRANGE_GAP * (rows + 1)) / rows));
  return Array.from({ length: count }, (_, i) => clampFloat({ x: ARRANGE_GAP + (i % cols) * (w + ARRANGE_GAP), y: ARRANGE_GAP + Math.floor(i / cols) * (h + ARRANGE_GAP), w, h }, bounds));
}

/** True when the pointer is on the rail: within the panes' box and no deeper than RAIL_PX from its top. */
export function onRail(p: { x: number; y: number }, panes: { left: number; right: number; top: number }): boolean {
  return p.x >= panes.left && p.x <= panes.right && p.y >= panes.top && p.y < panes.top + RAIL_PX;
}

/** A docked pane `from` dragged along the rail: its new index among the others (`mids` = every docked pane's x-centre). */
export function reorderSlot(mids: readonly number[], from: number, x: number): number {
  return dropIndex([...mids], from, x);
}

/** A floating card dropped on the rail: the docked index it goes in at (before the first pane whose centre is right of x). */
export function dockSlot(mids: readonly number[], x: number): number {
  return mids.filter((m) => m < x).length;
}

/** The x of the insertion marker for slot `k` among `rects` (the docked panes left to right, the dragged one excluded). */
export function slotX(rects: readonly { left: number; right: number }[], k: number): number {
  if (!rects.length) return 0;
  return k < rects.length ? rects[k]!.left : rects[rects.length - 1]!.right;
}

// --- phone: the tab strip, long-press (touch) / press-and-move (mouse) to reorder ---

const LONG_PRESS_MS = 350;
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 4;
const SUPPRESS_CLICK_MS = 600;
/** Auto-scroll while dragging: within this many px of a scrollable edge, by this much per frame. */
export const EDGE_PX = 36;
export const SCROLL_STEP = 10;

type TabDrag = { pointerId: number; touch: boolean; from: number; to: number; startX: number; startY: number; clientX: number; dx: number; tabs: HTMLElement[]; mids: number[]; step: number; active: boolean; timer: ReturnType<typeof setTimeout> | null; raf: number | null; stop: () => void };

/**
 * Horizontal drag-to-reorder for the phone's pane tabs (`<button>` children of the strip, in pane order). Touch: hold,
 * then move; mouse: press and move. The strip's `onMove(from, to)` gets the tab's new index among the others.
 * Runs on the DOM while dragging (no re-render per move); `stripProps` go on the strip element.
 */
export function useTabReorder(count: number, onMove?: (from: number, to: number) => void) {
  const latest = useRef({ count, onMove });
  latest.current = { count, onMove };
  const strip = useRef<HTMLDivElement | null>(null);
  const drag = useRef<TabDrag | null>(null);
  const suppressClickUntil = useRef(0);
  const blockScroll = useCallback((e: TouchEvent) => { if (drag.current?.active) e.preventDefault(); }, []);
  const ref = useCallback((el: HTMLDivElement | null) => {
    strip.current?.removeEventListener('touchmove', blockScroll);
    strip.current = el;
    el?.addEventListener('touchmove', blockScroll, { passive: false });
  }, [blockScroll]);
  useEffect(() => () => drag.current?.stop(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = strip.current;
    const { count: n, onMove: commit } = latest.current;
    suppressClickUntil.current = 0;
    if (!el || !commit || n < 2 || drag.current || e.button !== 0 || !(e.target instanceof Element)) return;
    const tab = e.target.closest('button[data-tab]') as HTMLElement | null;
    const tabs = Array.from(el.querySelectorAll<HTMLElement>('button[data-tab]'));
    const from = tab ? tabs.indexOf(tab) : -1;
    if (from < 0 || tabs.length !== n) return;
    const left = el.getBoundingClientRect().left;
    const rects = tabs.map((t) => t.getBoundingClientRect());
    const gap = rects.length > 1 ? Math.max(0, rects[1]!.left - rects[0]!.right) : 0;
    const clear = (d: TabDrag) => { el.classList.remove('tabs-reordering'); for (const t of d.tabs) { t.style.transform = ''; t.classList.remove('tab-dragging'); } };
    const start = () => {
      const d = drag.current;
      if (!d || d.active) return;
      d.active = true;
      d.timer = null;
      el.classList.add('tabs-reordering');
      window.getSelection()?.removeAllRanges();
      if (d.touch && typeof navigator.vibrate === 'function') navigator.vibrate(8);
    };
    // Positions are in the strip's content coordinates (scroll included), so a strip that scrolls under the finger
    // keeps the slots right. The dragged tab re-asserts its class: a re-render of the strip may have replaced it.
    const contentX = (clientX: number) => clientX - el.getBoundingClientRect().left + el.scrollLeft;
    const render = (d: TabDrag) => {
      const center = Math.min(Math.max(d.mids[d.from]! + d.dx, d.mids[0]!), d.mids[d.mids.length - 1]!);
      d.to = dropIndex(d.mids, d.from, center);
      d.tabs.forEach((t, i) => {
        if (i === d.from) { t.classList.add('tab-dragging'); t.style.transform = `translateX(${center - d.mids[d.from]!}px)`; return; }
        const k = i < d.from ? i : i - 1;
        t.style.transform = i > d.from && k < d.to ? `translateX(${-d.step}px)` : i < d.from && k >= d.to ? `translateX(${d.step}px)` : '';
      });
    };
    // Near either end of a strip that overflows, the strip scrolls on its own so far-off slots can be reached.
    const autoScroll = () => {
      const d = drag.current;
      if (!d?.active || d.raf !== null) return;
      const step = () => {
        const cur = drag.current;
        if (!cur?.active) return;
        cur.raf = null;
        const r = el.getBoundingClientRect();
        const room = el.scrollWidth - el.clientWidth;
        const dir = room <= 0 ? 0 : cur.clientX < r.left + EDGE_PX ? -1 : cur.clientX > r.right - EDGE_PX ? 1 : 0;
        if (dir === 0 || (dir < 0 && el.scrollLeft <= 0) || (dir > 0 && el.scrollLeft >= room)) return;
        el.scrollLeft += dir * SCROLL_STEP;
        cur.dx = contentX(cur.clientX) - cur.startX;
        render(cur);
        cur.raf = requestAnimationFrame(step);
      };
      d.raf = requestAnimationFrame(step);
    };
    const end = (drop: boolean) => {
      const d = drag.current;
      if (!d) return;
      d.stop();
      if (!d.active) return;
      suppressClickUntil.current = Date.now() + SUPPRESS_CLICK_MS;
      const cb = latest.current.onMove;
      if (drop && d.to !== d.from && cb && latest.current.count === d.tabs.length) flushSync(() => cb(d.from, d.to));
      clear(d);
    };
    const onMoveEv = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      d.clientX = ev.clientX;
      d.dx = contentX(ev.clientX) - d.startX;
      if (!d.active) {
        if (d.touch) { if (Math.abs(d.dx) > TOUCH_SLOP || Math.abs(ev.clientY - d.startY) > TOUCH_SLOP) end(false); return; }
        if (Math.abs(d.dx) <= MOUSE_SLOP) return;
        start();
      }
      ev.preventDefault();
      render(d);
      if (typeof requestAnimationFrame === 'function') autoScroll();
    };
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === drag.current?.pointerId) end(true); };
    const onCancel = (ev: PointerEvent) => { if (ev.pointerId === drag.current?.pointerId) end(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && drag.current?.active) { ev.preventDefault(); ev.stopPropagation(); end(false); } };
    window.addEventListener('pointermove', onMoveEv);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    drag.current = {
      pointerId: e.pointerId, touch, from, to: from, startX: e.clientX - left + el.scrollLeft, startY: e.clientY, clientX: e.clientX, dx: 0, tabs,
      mids: rects.map((r) => r.left - left + el.scrollLeft + r.width / 2), step: rects[from]!.width + gap, active: false, raf: null,
      timer: touch ? setTimeout(start, LONG_PRESS_MS) : null,
      stop: () => {
        const d = drag.current;
        if (d?.timer) clearTimeout(d.timer);
        if (d?.raf !== null && d?.raf !== undefined) cancelAnimationFrame(d.raf);
        window.removeEventListener('pointermove', onMoveEv);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        drag.current = null;
      },
    };
  };
  const onClickCapture = (e: { preventDefault(): void; stopPropagation(): void }) => {
    if (Date.now() < suppressClickUntil.current) { suppressClickUntil.current = 0; e.preventDefault(); e.stopPropagation(); }
  };
  const onContextMenuCapture = (e: { preventDefault(): void; stopPropagation(): void }) => { if (drag.current?.touch) { e.preventDefault(); e.stopPropagation(); } };
  return { stripProps: { ref, onPointerDown, onClickCapture, onContextMenuCapture } };
}
