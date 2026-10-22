import { useEffect, useRef } from 'react';

/** URL of an uploaded image (authed GET; the browser sends the session cookie). */
export const attachmentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}`;

/**
 * ux-state: full-size image over everything; click anywhere or Esc closes. The Esc is taken in the capture phase and
 * marked handled, so the side panel under it (or the running turn) does not close / stop on the same key.
 */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    return () => { back?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} data-testid="lightbox" onClick={onClose}>
      <img src={src} alt={alt} />
      <button ref={closeRef} type="button" className="lightbox-close" aria-label="닫기" onClick={onClose}>✕</button>
    </div>
  );
}
