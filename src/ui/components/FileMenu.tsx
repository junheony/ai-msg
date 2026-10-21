import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../clipboard';
import { has } from '../features';
import { rawFileUrl, revealFile } from '../sessionApi';
import { FileRootContext, SidePanelContext, viewFor } from '../sidePanel';
import { menuStep } from './SessionMenu';
import { Toasts, type ToastItem } from './Toasts';

const MARGIN = 8;
/** Touch: how long a press on a file chip waits before it opens the menu (iOS Safari fires no contextmenu). */
export const LONG_PRESS_MS = 500;
/** A finger that moves farther than this is scrolling, not pressing. */
const TOUCH_SLOP = 10;

export type MenuItem = { label: string; run: () => void };

/** Top-left of a `w`×`h` menu opened at (x, y), kept MARGIN inside the viewport. */
export function clampToViewport(x: number, y: number, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  return { left: Math.max(MARGIN, Math.min(x, vw - w - MARGIN)), top: Math.max(MARGIN, Math.min(y, vh - h - MARGIN)) };
}

export const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

/** Only one point menu at a time: opening another closes this one. */
let closeOpenMenu: (() => void) | null = null;

/**
 * A menu at a point (right-click / long press) or under a chip: `position: fixed` in a portal and clamped to the
 * viewport, so a narrow pane, the side panel or a phone never clips it. Focus starts on the first item, ↑/↓ (Home/End)
 * move it, Enter activates, Esc puts focus back on `anchor`; a click outside, Tab, scrolling or a resize closes it.
 */
export function PointMenu({ x, y, label, items, anchor, onClose }: {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  /** The element that opened it: clicks on it are not "outside" (it toggles), Esc refocuses it. */
  anchor?: HTMLElement | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const [pos, setPos] = useState<CSSProperties>({ left: x, top: y, visibility: 'hidden' });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = clampToViewport(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight);
    setPos({ left: p.left, top: p.top, maxHeight: window.innerHeight - 2 * MARGIN });
  }, [x, y]);

  useEffect(() => {
    const mine = () => closeRef.current();
    closeOpenMenu?.();
    closeOpenMenu = mine;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchorRef.current?.contains(t)) closeRef.current();
    };
    // The point it was opened at moves with the page: close rather than float over the wrong line. Only scrolling that
    // moves the anchor counts — a streaming reply auto-scrolling another pane (or the menu's own list) leaves it open.
    const moved = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && ref.current?.contains(t)) return;
      const a = anchorRef.current;
      if (a && t instanceof Node && t !== document && !t.contains(a)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', mine);
    return () => {
      if (closeOpenMenu === mine) closeOpenMenu = null;
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', mine);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      const a = anchorRef.current;
      onClose();
      a?.focus();
      return;
    }
    if (e.key === 'Tab') { onClose(); return; }
    const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const next = menuStep(els.indexOf(document.activeElement as HTMLElement), e.key, els.length);
    if (next === null) return;
    e.preventDefault();
    els[next]?.focus();
  };
  // A portal still bubbles React events to the owner's ancestors: keep the menu's clicks and keys to itself.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return createPortal(
    <div ref={ref} className="session-menu file-menu" role="menu" aria-label={label} style={pos} data-testid="file-menu"
      onKeyDown={onKeyDown} onClick={stop} onPointerDown={stop} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {items.map((it) => (
        <button key={it.label} type="button" role="menuitem" onClick={() => { onClose(); it.run(); }}>{it.label}</button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Touch long press (≈LONG_PRESS_MS; moving cancels) → `onLong(x, y)`. The click that ends a long press is swallowed so
 * the chip does not also open the panel.
 */
export function useLongPress(onLong: (x: number, y: number) => void) {
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const fired = useRef(false);
  const onLongRef = useRef(onLong);
  onLongRef.current = onLong;
  const cancel = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      fired.current = false;
      cancel();
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      const { clientX: x, clientY: y, pointerId: id } = e;
      press.current = { id, x, y, timer: setTimeout(() => { press.current = null; fired.current = true; onLongRef.current(x, y); }, LONG_PRESS_MS) };
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const p = press.current;
      if (p && e.pointerId === p.id && (Math.abs(e.clientX - p.x) > TOUCH_SLOP || Math.abs(e.clientY - p.y) > TOUCH_SLOP)) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: ReactMouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/**
 * The file actions with their own feedback toasts (the app's toast stack lives in App, out of reach here). Toasts render
 * in a portal above the phone's full-screen side panel.
 */
export function useFileActions() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const toast = useCallback((text: string, kind: 'info' | 'error' = 'info') => setToasts((t) => [...t, { id: ++seq.current, text, kind }]), []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const node: ReactNode = toasts.length > 0 ? createPortal(<div className="file-toasts"><Toasts toasts={toasts} onDismiss={dismiss} /></div>, document.body) : null;
  return {
    node,
    copy: (text: string, done: string) => { void copyText(text).then((ok) => toast(ok ? done : '복사하지 못했어요', ok ? 'info' : 'error')); },
    /** A plain <a download> click: the browser saves it on the device the user is looking at (phone, other Mac). */
    download: (cwd: string, path: string) => {
      const a = document.createElement('a');
      a.href = rawFileUrl(cwd, path, true);
      a.download = baseName(path);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    reveal: (cwd: string, path: string) => revealFile(cwd, path).then(
      () => toast('서버 Mac 의 Finder 에서 열었어요'),
      (err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'),
    ),
    openTab: (cwd: string, path: string) => { window.open(rawFileUrl(cwd, path), '_blank', 'noopener'); },
  };
}

export type FileActions = ReturnType<typeof useFileActions>;

/**
 * The file chip menu's items; the ones that need the session folder are left out without one, and the ones that need
 * the server's raw-file routes (`fileRaw`) without that — an older server would answer `raw=1` with the preview JSON,
 * which a download would save under the file's name.
 */
export function fileMenuItems(path: string, cwd: string | null, open: ((doc: { kind: 'file'; path: string }) => void) | null, act: FileActions): MenuItem[] {
  const items: MenuItem[] = [];
  if (open) items.push({ label: '패널에서 열기', run: () => open({ kind: 'file', path }) });
  items.push({ label: '경로 복사', run: () => act.copy(path, '경로를 복사했어요') });
  items.push({ label: '파일 이름 복사', run: () => act.copy(baseName(path), '파일 이름을 복사했어요') });
  if (cwd && has('fileRaw')) {
    items.push({ label: '다운로드', run: () => act.download(cwd, path) });
    items.push({ label: 'Finder 에서 보기 (서버 Mac)', run: () => { void act.reveal(cwd, path); } });
    if (viewFor(path) === 'image') items.push({ label: '새 탭에서 크게', run: () => act.openTab(cwd, path) });
  }
  return items;
}

/**
 * Right-click / long press on a reply's file chip or thumbnail. `bind` goes on the element (it takes the ref too);
 * `node` (the menu and its toasts) renders next to it.
 */
export function useFileMenu(path: string | null) {
  const open = useContext(SidePanelContext);
  const cwd = useContext(FileRootContext);
  const act = useFileActions();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const press = useLongPress((x, y) => setAt({ x, y }));
  const bind = {
    ...press,
    ref: (el: HTMLElement | null) => { anchor.current = el; },
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      // The keyboard's menu key / Shift+F10 reports (0, 0): open under the chip instead.
      if (e.clientX === 0 && e.clientY === 0 && anchor.current) {
        const r = anchor.current.getBoundingClientRect();
        setAt({ x: r.left, y: r.bottom + 4 });
      } else setAt({ x: e.clientX, y: e.clientY });
    },
  };
  const node: ReactNode = (
    <>
      {at && path && <PointMenu x={at.x} y={at.y} label="파일 메뉴" items={fileMenuItems(path, cwd, open, act)} anchor={anchor.current} onClose={() => setAt(null)} />}
      {act.node}
    </>
  );
  return { bind, node };
}

/** The chat header's session-folder chip: name shown, full path on hover; a click opens the folder menu. */
export function FolderChip({ cwd, name, asMenuItem }: { cwd: string; name: string; /** A row of the session chip's menu ("폴더: name ›") instead of the head's second line. */ asMenuItem?: boolean }) {
  const open = useContext(SidePanelContext);
  const act = useFileActions();
  const ref = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const toggle = () => {
    if (at) { setAt(null); return; }
    const r = ref.current?.getBoundingClientRect();
    setAt({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 });
  };
  const items: MenuItem[] = [
    { label: '경로 복사', run: () => act.copy(cwd, '경로를 복사했어요') },
    ...(open ? [{ label: '파일 패널 열기', run: () => open({ kind: 'pick' }) }] : []),
    ...(has('fileRaw') ? [{ label: 'Finder 에서 열기 (서버 Mac)', run: () => { void act.reveal(cwd, '.'); } }] : []),
  ];
  return (
    <>
      {asMenuItem
        ? <button ref={ref} type="button" role="menuitem" className="menu-folder" title={cwd} aria-haspopup="menu" aria-expanded={at !== null} onClick={toggle}>폴더: {name} <span aria-hidden="true">›</span></button>
        : <button ref={ref} type="button" className="folder-chip head-folder" title={cwd} aria-haspopup="menu" aria-expanded={at !== null} onClick={toggle}>{name}</button>}
      {at && <PointMenu x={at.x} y={at.y} label="폴더 메뉴" items={items} anchor={ref.current} onClose={() => setAt(null)} />}
      {act.node}
    </>
  );
}
