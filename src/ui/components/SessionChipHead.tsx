import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { EngineKind } from '../../shared/models';
import { EngineMark } from './EngineMark';
import { FolderChip } from './FileMenu';
import { MenuList } from './SessionMenu';

/** Where a pane's ⋯ item sits in the session chip's menu (세션 → 보기 → 공유 → 창 → 총사령탑 → 위험); `viewEnd` = 보기's last rows. */
export type HeadGroup = 'session' | 'view' | 'viewEnd' | 'window' | 'commander';
export type HeadMenuItem = { label: string; run: () => void; group?: HeadGroup; /** Shown on the right (a shortcut). */ hint?: string };

export type HeadGrip = { onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void; onKeyDown?: (e: ReactKeyboardEvent<HTMLButtonElement>) => void };

/** Menu helpers handed to the caller's groups: `close` shuts the menu, `rename` swaps the chip for the name field. */
export type HeadMenuCtl = { close: () => void; rename: () => void };

/** A plain menu row (closes the menu first); `hint` is the shortcut on the right, kept out of the accessible name. */
export function HeadItem({ label, hint, run, ctl, className }: { label: string; hint?: string; run: () => void; ctl: HeadMenuCtl; className?: string }) {
  return (
    <button type="button" role="menuitem" className={className} onClick={() => { ctl.close(); run(); }}>
      {label}{hint && <kbd className="menu-hint" aria-hidden="true">{hint}</kbd>}
    </button>
  );
}

/**
 * The session chip: the pane's whole head in one button — engine mark, title, ▾ — opening a grouped menu (desktop: a
 * role="menu" under the chip; phone: a bottom sheet in the same order). With `slot` it renders into the top bar (one
 * pane, or the phone's shown pane), the folder as a small second line on desktop; otherwise it is the pane's own head
 * row, the folder moving into the menu's first line. The grip (drag / ←→ to reorder, card move) rides on the chip;
 * double-click renames. The phone's sheet (a modal dialog around the menu) and its scrim render into <body>, out of the
 * top bar's stacking context.
 */
export function SessionChipHead({ title, sessionKey, engine, cwd, slot, phone, paneId, chips, trail, grip, gripTitle, onRename, groups, toast, idle }: {
  title: string;
  /** The session the head names: a rename started on one session is never saved onto another (or after a switch). */
  sessionKey?: string | null;
  engine?: EngineKind | null;
  cwd?: string;
  /** The top bar's slot: the head renders there (portal). Absent = in the pane. */
  slot?: Element | null;
  phone?: boolean;
  /** The pane id (`data-pane-head`), so the top bar's head can be told apart. */
  paneId?: string;
  /** Conditional chips after the session chip (갈라짐, 총사령탑, 모두 자동 승인 ⚠). */
  chips?: ReactNode;
  /** Right-side buttons (a floating card's – / ▭ and ✕). */
  trail?: ReactNode;
  grip?: HeadGrip;
  gripTitle?: string;
  onRename?: (title: string | null) => void;
  /** Menu groups in order; each a list of rows (falsy rows dropped). Empty groups are skipped, a separator between the rest. */
  groups: (ctl: HeadMenuCtl) => ReactNode[][];
  /** A short status under the chip (링크를 복사했습니다). */
  toast?: string | null;
  /** An empty split pane's head: no control shows at rest (it appears while the pointer is over the pane). */
  idle?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null);
  renamingRef.current = renaming;
  const down = useRef<{ x: number; y: number; slop: number } | null>(null);
  const moved = useRef(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  // Rename: the session it started on, and whether the head is still mounted (a session switch remounts it).
  const renameKey = useRef<string | null | undefined>(undefined);
  const keyRef = useRef(sessionKey);
  keyRef.current = sessionKey;
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const cancelRename = () => { renamingRef.current = null; setRenaming(null); };
  const commitRename = () => {
    const v = renamingRef.current;
    if (v === null || !live.current) return;
    if (renameKey.current !== keyRef.current) { cancelRename(); return; }
    renamingRef.current = null;
    setRenaming(null);
    const t = v.replace(/\s+/g, ' ').trim();
    if (t !== title) onRename?.(t || null);
  };
  // Another session shown while the field is open (the same head kept): the edit is dropped.
  useEffect(() => { if (renamingRef.current !== null && renameKey.current !== sessionKey) cancelRename(); }, [sessionKey]);
  // A press elsewhere blurs the field before its click runs (a sidebar row switches the session on click): blur waits
  // for that click, then saves only if the same session is still shown here. A keyboard blur (Tab) saves at once.
  const press = useRef({ held: false, at: 0 });
  const editing = renaming !== null;
  useEffect(() => {
    if (!editing) return;
    const downAt = () => { press.current = { held: true, at: Date.now() }; };
    const up = () => { press.current.held = false; };
    window.addEventListener('pointerdown', downAt, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => { window.removeEventListener('pointerdown', downAt, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); };
  }, [editing]);
  const blurRename = () => {
    const p = press.current;
    if (!p.held && Date.now() - p.at > 1000) { commitRename(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('pointerup', onUp, true);
      clearTimeout(timer);
      setTimeout(commitRename, 0);
    };
    // No click comes (a drag off, a cancelled touch): save a moment after the press ends.
    const fallback = () => { clearTimeout(timer); timer = setTimeout(done, 600); };
    const onClick = () => done();
    const onUp = () => fallback();
    window.addEventListener('click', onClick, true);
    if (p.held) window.addEventListener('pointerup', onUp, true);
    else fallback();
  };
  const ctl: HeadMenuCtl = { close: () => setOpen(false), rename: () => { setOpen(false); if (onRename) { renameKey.current = sessionKey; setRenaming(title); } } };
  const topbar = !!slot;
  const folder = cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : null;
  // The folder line: under the chip in the desktop top bar; elsewhere (split panes, the phone) the menu's first row.
  const folderLine = topbar && !phone;
  const folderRow = folder && cwd && !folderLine ? <FolderChip key="folder" cwd={cwd} name={folder} asMenuItem /> : null;
  const built = groups(ctl).map((g) => g.filter(Boolean)).filter((g) => g.length > 0);
  if (folderRow) {
    if (built[0]) built[0] = [folderRow, ...built[0]];
    else built.unshift([folderRow]);
  }
  const hasMenu = built.length > 0;
  const items = built.map((g, i) => <Fragment key={i}>{i > 0 && <div className="menu-sep" role="separator" />}{g}</Fragment>);
  const label = <><span className="head-chip-title">{engine && <EngineMark engine={engine} />}{title}</span>{hasMenu && <span className="caret" aria-hidden="true">▾</span>}</>;

  const head = (
    <div className={`pane-head${topbar ? ' in-topbar' : ''}${idle ? ' idle' : ''}`} data-pane-head={paneId}>
      <div className="pane-head-main">
        <span className="head-chip-wrap">
          {renaming !== null ? (
            <input className="head-chip-input" aria-label="채팅 이름" value={renaming} autoFocus maxLength={200}
              onChange={(e) => setRenaming(e.target.value)} onBlur={blurRename}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
              }} />
          ) : hasMenu ? (
            <button ref={chipRef} type="button" className="head-chip" data-testid="session-chip-head" title={gripTitle ? `${title}\n${gripTitle}` : title}
              aria-haspopup="menu" aria-expanded={open} {...(grip ? { 'data-grip': '' } : {})}
              // The click-swallow threshold matches the drag's own start (paneDrag: 8px for touch, 4px for a mouse).
              onPointerDown={grip ? (e) => { down.current = { x: e.clientX, y: e.clientY, slop: e.pointerType === 'touch' ? 8 : 4 }; moved.current = false; grip.onPointerDown(e); } : undefined}
              onPointerMove={grip ? (e) => { const d = down.current; if (d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > d.slop) moved.current = true; } : undefined}
              onKeyDown={grip?.onKeyDown ? (e) => { if (e.key.startsWith('Arrow')) grip.onKeyDown?.(e); } : undefined}
              // A drag ends in a click on the chip: that one is not a menu toggle.
              onClick={() => { down.current = null; if (moved.current) { moved.current = false; return; } setOpen((o) => !o); }}
              onDoubleClick={onRename ? (e) => { e.stopPropagation(); ctl.rename(); } : undefined}>
              {label}
            </button>
          ) : (
            <span className="head-chip static" data-testid="session-chip-head" title={title}>{label}</span>
          )}
          {toast && <span className="share-toast" role="status">{toast}</span>}
          {open && hasMenu && !phone && <MenuList className="session-menu head-menu" label="채팅 메뉴" onClose={() => setOpen(false)}>{items}</MenuList>}
          {open && hasMenu && phone && createPortal(
            <>
              <div className="head-menu-scrim" aria-hidden="true" />
              <div className="session-menu head-menu as-sheet" role="dialog" aria-modal="true" aria-label="세션 메뉴">
                <MenuList className="head-menu-list" label="채팅 메뉴" opener={() => chipRef.current} modal onClose={() => setOpen(false)}>{items}</MenuList>
              </div>
            </>,
            document.body,
          )}
        </span>
        {folderLine && folder && cwd && <FolderChip cwd={cwd} name={folder} />}
      </div>
      {chips && <div className="pane-head-chips">{chips}</div>}
      {trail && <div className="pane-head-end">{trail}</div>}
    </div>
  );
  return slot ? createPortal(head, slot) : head;
}
