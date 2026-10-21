import { Fragment, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { EngineKind } from '../../shared/models';
import { EngineMark } from './EngineMark';
import { FolderChip } from './FileMenu';
import { MenuList } from './SessionMenu';

/** Where a pane's ⋯ item sits in the session chip's menu (세션 → 보기 → 공유 → 창 → 총사령탑 → 위험). */
export type HeadGroup = 'session' | 'view' | 'window' | 'commander';
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
 * double-click renames.
 */
export function SessionChipHead({ title, engine, cwd, slot, phone, paneId, chips, trail, grip, gripTitle, onRename, groups, toast }: {
  title: string;
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
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null);
  renamingRef.current = renaming;
  const down = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const commitRename = () => {
    const v = renamingRef.current;
    if (v === null) return;
    renamingRef.current = null;
    setRenaming(null);
    const t = v.replace(/\s+/g, ' ').trim();
    if (t !== title) onRename?.(t || null);
  };
  const ctl: HeadMenuCtl = { close: () => setOpen(false), rename: () => { setOpen(false); if (onRename) setRenaming(title); } };
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
  const label = <><span className="head-chip-title">{engine && <EngineMark engine={engine} />}{title}</span>{hasMenu && <span className="caret" aria-hidden="true">▾</span>}</>;

  const head = (
    <div className={`pane-head${topbar ? ' in-topbar' : ''}`} data-pane-head={paneId}>
      <div className="pane-head-main">
        <span className="head-chip-wrap">
          {renaming !== null ? (
            <input className="head-chip-input" aria-label="채팅 이름" value={renaming} autoFocus maxLength={200}
              onChange={(e) => setRenaming(e.target.value)} onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); renamingRef.current = null; setRenaming(null); }
              }} />
          ) : hasMenu ? (
            <button type="button" className="head-chip" data-testid="session-chip-head" title={gripTitle ? `${title}\n${gripTitle}` : title}
              aria-haspopup="menu" aria-expanded={open} {...(grip ? { 'data-grip': '' } : {})}
              onPointerDown={grip ? (e) => { down.current = { x: e.clientX, y: e.clientY }; moved.current = false; grip.onPointerDown(e); } : undefined}
              onPointerMove={grip ? (e) => { const d = down.current; if (d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) moved.current = true; } : undefined}
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
          {open && hasMenu && (
            <>
              {phone && <div className="head-menu-scrim" aria-hidden="true" />}
              <MenuList className={`session-menu head-menu${phone ? ' as-sheet' : ''}`} label="채팅 메뉴" onClose={() => setOpen(false)}>
                {built.map((g, i) => <Fragment key={i}>{i > 0 && <div className="menu-sep" role="separator" />}{g}</Fragment>)}
              </MenuList>
            </>
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
