import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GLYPH_PREFIX, SESSION_ICON_EMOJI } from '../../shared/sessionIcons';
import { ui } from '../i18n';
import { SESSION_ICONS, SessionGlyph } from './SessionIcon';

/**
 * 직접 고르기: a transparent button over a session's avatar (a sibling of the row / chip button, never inside it, so a tap
 * here never opens the session) and the popover it opens — emoji, the line glyphs, and 기본으로 (제목 이모지 또는 첫 글자). The popover
 * renders into <body> (out of the sidebar's scroll box and the top bar), under the avatar or above it when it does not fit,
 * always inside the viewport, and follows the avatar on scroll and resize.
 */
export function SessionIconButton({ current, onPick, className }: { current: string | null; onPick: (icon: string | null) => void; className: string }) {
  const t = ui().sessionIcon;
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = (refocus: boolean) => { setOpen(false); if (refocus) btn.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const b = btn.current?.getBoundingClientRect();
      const p = pop.current;
      if (!b || !p) return;
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const m = 8;
      const left = Math.max(m, Math.min(b.left, window.innerWidth - w - m));
      const below = b.bottom + 4;
      const want = below + h > window.innerHeight - m && b.top - 4 - h >= m ? b.top - 4 - h : below;
      // Fits neither way (a short window): kept on screen, over the avatar if need be.
      const top = Math.max(m, Math.min(want, window.innerHeight - h - m));
      setPos({ left, top });
    };
    place();
    // A scroll anywhere (the sidebar's list included, hence capture) moves the avatar: the popover follows.
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    (pop.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? pop.current?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!pop.current?.contains(n) && !btn.current?.contains(n)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);

  const choose = (icon: string | null) => { close(true); if (icon !== current) onPick(icon); };
  const item = (icon: string, label: string, body: ReactNode) => (
    <button key={icon} type="button" className="icon-picker-item" aria-label={label} title={label} aria-pressed={icon === current} onClick={() => choose(icon)}>{body}</button>
  );
  return (
    <>
      <button ref={btn} type="button" className={`avatar-pick ${className}`} aria-label={t.change} title={t.change} aria-haspopup="dialog" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onDoubleClick={(e) => e.stopPropagation()} />
      {open && createPortal(
        <div ref={pop} className="icon-picker" role="dialog" aria-label={t.picker} style={(pos ?? { left: -9999, top: 0 }) as CSSProperties}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); close(true); } }}>
          <div className="icon-picker-head">{t.emoji}</div>
          <div className="icon-picker-grid">{SESSION_ICON_EMOJI.map((e) => item(e, e, <span aria-hidden="true">{e}</span>))}</div>
          <div className="icon-picker-head">{t.glyphs}</div>
          <div className="icon-picker-grid">{SESSION_ICONS.map((g) => item(`${GLYPH_PREFIX}${g.name}`, g.name, <SessionGlyph name={g.name} />))}</div>
          <button type="button" className="icon-picker-reset" aria-pressed={current === null} onClick={() => choose(null)}>{t.reset}</button>
        </div>,
        document.body,
      )}
    </>
  );
}
