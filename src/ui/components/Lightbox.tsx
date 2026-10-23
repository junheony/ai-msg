import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ui } from '../i18n';

/** URL of an uploaded image (authed GET; the browser sends the session cookie). */
export const attachmentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}`;

export type LightboxImage = { src: string; alt: string };

/**
 * ux-state: full-size image over everything; a click outside the image or Esc closes. The Esc is taken in the capture
 * phase and marked handled, so the side panel under it (or the running turn) does not close / stop on the same key.
 * `items` (2+): a gallery opened at `start` — ← / → (buttons and keys) step through it, `i / n` says where.
 * Tab stays among the dialog's buttons (aria-modal).
 */
export function Lightbox({ src, alt, items, start = 0, onClose }: { src?: string; alt?: string; items?: LightboxImage[]; start?: number; onClose: () => void }) {
  const list = items && items.length > 0 ? items : [{ src: src ?? '', alt: alt ?? '' }];
  const [at, setAt] = useState(() => Math.min(Math.max(0, start), list.length - 1));
  const cur = list[Math.min(at, list.length - 1)]!;
  const many = list.length > 1;
  const t = ui().chat.lightbox;
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    return () => { back?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const step = (d: number) => setAt((i) => (i + d + list.length) % list.length);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const btns = Array.from(boxRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const next = btns[i < 0 ? 0 : (i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length];
        (next ?? closeRef.current)?.focus({ preventScroll: true });
        return;
      }
      if (many && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        step(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, many, list.length]);
  const nav = (d: number) => (e: ReactMouseEvent) => { e.stopPropagation(); setAt((i) => (i + d + list.length) % list.length); };
  return (
    <div ref={boxRef} className="lightbox" role="dialog" aria-modal="true" aria-label={cur.alt} data-testid="lightbox" onClick={onClose}>
      <img src={cur.src} alt={cur.alt} onClick={(e) => e.stopPropagation()} />
      {many && (
        <>
          <button type="button" className="lightbox-nav prev" aria-label={t.prev} onClick={nav(-1)}>‹</button>
          <button type="button" className="lightbox-nav next" aria-label={t.next} onClick={nav(1)}>›</button>
          <span className="lightbox-count" aria-live="polite" data-testid="lightbox-count">{t.count(at + 1, list.length)}</span>
        </>
      )}
      <button ref={closeRef} type="button" className="lightbox-close" aria-label={t.close} onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
    </div>
  );
}
