import { useEffect, useLayoutEffect, useState } from 'react';
import { useIsPhone } from '../useIsPhone';
import { ui } from '../i18n';

/** An info toast's life (ms): long enough to read a short line, short enough not to pile up. */
export const INFO_TOAST_MS = 5_000;
/** An error toast's life (ms): longer than info so a glance away does not miss it, but it still clears itself (the old band never did). */
export const ERROR_TOAST_MS = 12_000;
/** Visible at once; older ones are hidden (not dropped) until newer ones go, so a burst never covers the screen. */
export const MAX_TOASTS = 4;
/** A phone's info toast (ms): it sits just over the composer, so it goes sooner than a desktop's corner one. */
export const PHONE_TOAST_MS = 4_000;
/** Space (px) between a phone's toast stack and the top of the composer under it. */
const COMPOSER_GAP = 8;

export type ToastItem = { id: number; text: string; kind?: 'error' | 'info'; /** A button next to the text (열기): runs, then closes the toast. */ action?: { label: string; run: () => void }; /** Life (ms) instead of the kind's default. */ ms?: number; /** The raw text under a readable one (errorText.ts): folded, opened on a tap. */ detail?: string };

function Toast({ toast, onDismiss, phone }: { toast: ToastItem; onDismiss: (id: number) => void; phone: boolean }) {
  const kind = toast.kind ?? 'error';
  useEffect(() => {
    const info = toast.ms ?? INFO_TOAST_MS;
    const t = setTimeout(() => onDismiss(toast.id), kind === 'info' ? (phone ? Math.min(info, PHONE_TOAST_MS) : info) : (toast.ms ?? ERROR_TOAST_MS));
    return () => clearTimeout(t);
    // onDismiss is a fresh closure each render; the timer belongs to the toast, so it must not restart.
  }, [toast.id, kind]);
  return (
    <div className={`toast-item ${kind}`} role={kind === 'info' ? 'status' : 'alert'}>
      <span>{toast.text}{toast.detail && <details className="toast-detail"><summary>{ui().common.errorRaw}</summary><code>{toast.detail}</code></details>}</span>
      {toast.action && <button type="button" className="text-btn" onClick={() => { toast.action!.run(); onDismiss(toast.id); }}>{toast.action.label}</button>}
      <button type="button" className="icon-btn" aria-label="닫기" onClick={() => onDismiss(toast.id)}>✕</button>
    </div>
  );
}

/**
 * Fixed stack of transient messages (errors, notes): floats over the layout instead of pushing it down,
 * each closes itself and on ×, and several can be seen at once (the old single band overwrote the previous one).
 * `toasts` is oldest-first (append order); shown newest on top.
 */
export function Toasts({ toasts, onDismiss, aboveComposer = false }: { toasts: ToastItem[]; onDismiss: (id: number) => void; /** Phone: stack just over the shown composer (its chips included), never on it. */ aboveComposer?: boolean }) {
  const phone = useIsPhone();
  const bottom = useComposerTop(aboveComposer && phone && toasts.length > 0);
  if (!toasts.length) return null;
  const shown = toasts.slice(-MAX_TOASTS).reverse();
  return <div className="toasts" style={bottom !== null ? { bottom } : undefined}>{shown.map((t) => <Toast key={t.id} toast={t} onDismiss={onDismiss} phone={phone} />)}</div>;
}

/** The distance (px) from the viewport's bottom to just above the visible composer area; null = none shown / not asked. */
function useComposerTop(on: boolean): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!on) { setBottom(null); return; }
    const measure = () => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('.composer-wrap, .composer')).find((x) => x.getBoundingClientRect().height > 0);
      setBottom(el ? Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top + COMPOSER_GAP)) : null);
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    document.querySelectorAll('.composer-wrap').forEach((x) => ro?.observe(x));
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [on]);
  return bottom;
}
