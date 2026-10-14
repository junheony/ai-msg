import { useEffect } from 'react';

/** How long a press on a button / link waits before its `title` shows (FileMenu's long press uses the same). */
export const TIP_PRESS_MS = 500;
/** The bubble goes away by itself after this long, or when the finger lifts. */
export const TIP_SHOW_MS = 2000;
/** A finger moving further than this is a scroll, not a press. */
const SLOP_PX = 10;
const TARGET = 'button, a, [role="button"], [role="menuitem"], [role="tab"]';
/** These open their own menu on a long press (file chips, thumbnails): no bubble over it. */
const OWN_LONG_PRESS = '.file-link, .file-thumb';

/**
 * Touch screens have no hover, so an icon button's `title` is never seen. On a coarse pointer, a long press on a
 * button or link shows its title in a small bubble above it (below near the top edge); lifting the finger or
 * TIP_SHOW_MS hides it, and the click that ends such a press is swallowed. One set of document listeners for the app.
 */
export function useTouchTooltip(): void {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: coarse)').matches) return;
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let swallowTimer: ReturnType<typeof setTimeout> | undefined;
    let tip: HTMLElement | null = null;
    let start: { x: number; y: number } | null = null;
    let swallow = false;

    const hide = () => {
      clearTimeout(hideTimer);
      tip?.remove();
      tip = null;
    };
    const cancelPress = () => {
      clearTimeout(pressTimer);
      pressTimer = undefined;
      start = null;
    };
    const show = (el: Element, text: string) => {
      hide();
      const t = document.createElement('div');
      t.className = 'touch-tip';
      t.setAttribute('role', 'tooltip');
      t.textContent = text;
      document.body.appendChild(t);
      const r = el.getBoundingClientRect();
      const w = t.offsetWidth;
      const left = Math.max(8 + w / 2, Math.min(r.left + r.width / 2, window.innerWidth - 8 - w / 2));
      const below = r.top < t.offsetHeight + 16;
      t.style.left = `${left}px`;
      t.style.top = `${below ? r.bottom + 8 : r.top - 8}px`;
      if (below) t.classList.add('below');
      tip = t;
      swallow = true;
      hideTimer = setTimeout(hide, TIP_SHOW_MS);
    };

    const onDown = (e: PointerEvent) => {
      hide();
      cancelPress();
      swallow = false;
      if (e.pointerType === 'mouse') return;
      const el = e.target instanceof Element ? e.target.closest(TARGET) : null;
      const text = el?.getAttribute('title')?.trim();
      if (!el || !text || el.closest(OWN_LONG_PRESS)) return;
      start = { x: e.clientX ?? 0, y: e.clientY ?? 0 };
      pressTimer = setTimeout(() => { pressTimer = undefined; show(el, text); }, TIP_PRESS_MS);
    };
    const onMove = (e: PointerEvent) => {
      if (!start) return;
      if (Math.abs((e.clientX ?? 0) - start.x) > SLOP_PX || Math.abs((e.clientY ?? 0) - start.y) > SLOP_PX) cancelPress();
    };
    const onUp = () => {
      cancelPress();
      hide();
      // The click (if any) follows pointerup at once; a press that produced none must not swallow the next tap.
      clearTimeout(swallowTimer);
      if (swallow) swallowTimer = setTimeout(() => { swallow = false; }, 400);
    };
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // The long press may also raise the browser's own menu / callout on the button.
    const onContextMenu = (e: Event) => { if (tip || pressTimer) e.preventDefault(); };

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      cancelPress();
      hide();
      clearTimeout(swallowTimer);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, []);
}
