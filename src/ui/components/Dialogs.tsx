import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react';
import { digitMod, isSafariBrowser, shortcutList, type ShortcutId } from '../shortcuts';
import { ui } from '../i18n';
import { POPUP } from '../composerFocus';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

export const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab / Shift+Tab wrap inside a sheet (a modal: focus never walks out behind it). */
export function trapTab(e: ReactKeyboardEvent<HTMLElement>) {
  // A sheet's own inner trap already wrapped it (the Sheet traps too).
  if (e.key !== 'Tab' || e.defaultPrevented) return;
  const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (!all.length) return;
  const first = all[0]!;
  const last = all[all.length - 1]!;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * A large modal card over a dimmed backdrop (설정, 사용량): full screen on a phone. Closes on Esc and on a mousedown that
 * starts on the backdrop. Esc yields to a popup opened over it (later in the DOM, not inside the card — its own menus do not count: palette, help,
 * confirm, another sheet), to an Esc someone already took and to a held key's repeats. Focus goes back where it was when
 * the sheet closes, or to the top bar's `[data-sheet-return]` button when that is gone (설정 → 사용량 보기) or was nowhere.
 * Tab / Shift+Tab wrap inside it; on open, focus goes to its 닫기 button (`autoFocus` in the content) or, if nothing in it
 * took focus, the first focusable control.
 */
export function Sheet({ label, className, onClose, children }: { label: string; className: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [opener] = useState(() => (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  // Layout: runs before a sheet opened in the same commit (설정 → 사용량) focuses its own ✕.
  useLayoutEffect(() => () => { (opener?.isConnected && opener !== document.body ? opener : document.querySelector<HTMLElement>('[data-sheet-return]'))?.focus(); }, [opener]);
  useEffect(() => {
    const self = ref.current;
    if (self && !self.contains(document.activeElement)) self.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    let owned = false;
    // Capture: decided before the popup's own Esc handler removes it.
    const note = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const self = ref.current;
      owned = !!self && Array.from(document.querySelectorAll(POPUP)).some((el) => el !== self && !self.contains(el) && (self.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.defaultPrevented || e.isComposing || e.keyCode === 229 || owned) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', note, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', note, true); window.removeEventListener('keydown', onKey); };
  }, []);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={label} onKeyDown={trapTab}>{children}</div>
    </div>
  );
}

/**
 * Every sheet's head row (사용량 · 세션 설정 · 활동 · 설정 · 메시지 메뉴): the title left, a ✕ icon button right — 32px seen
 * on a desktop with a 44px press area (44px seen on a phone), the same padding and title size everywhere. `excerpt`: a
 * one-line quote instead of a heading (the message menu names its message, not itself). The ✕ takes the first focus
 * unless `autoFocus` is off (a sheet that focuses its first item itself).
 */
export function SheetHead({ title, onClose, autoFocus = true, closeRef, excerpt = false }: { title: ReactNode; onClose: () => void; autoFocus?: boolean; closeRef?: Ref<HTMLButtonElement>; excerpt?: boolean }) {
  return (
    <header className={`sheet-head${excerpt ? ' excerpt' : ''}`}>
      {excerpt ? <p className="sheet-title">{title}</p> : <h2 className="sheet-title">{title}</h2>}
      <button ref={closeRef} type="button" className="icon-btn sheet-btn sheet-close" onClick={onClose} aria-label="닫기" title="닫기 (Esc)" autoFocus={autoFocus}>✕</button>
    </header>
  );
}

/** Which group of the cheat sheet a global shortcut sits in. */
const HELP_GROUP: Record<ShortcutId, 'move' | 'compose' | 'panes'> = {
  palette: 'move', 'prev-session': 'move', 'next-session': 'move', 'toggle-sidebar': 'move', settings: 'move', help: 'move',
  'new-chat': 'compose',
  'new-pane': 'panes', 'prev-pane': 'panes', 'next-pane': 'panes', 'close-pane': 'panes', 'move-pane-left': 'panes', 'move-pane-right': 'panes', 'max-pane': 'panes', 'toggle-side': 'panes', 'arrange-cards': 'panes',
};

/** ⌘/ cheat sheet, grouped (이동 · 작성 · 패널·카드). The list scrolls with the keyboard too (focusable, with a ring). */
export function ShortcutHelp({ mac, safari = isSafariBrowser(), onClose }: { mac: boolean; safari?: boolean; onClose: () => void }) {
  useEscape(onClose);
  const t = ui().panels.help;
  // Number keys on a Mac take ⌘ and ⌃ both; the one that works in this browser first (Safari keeps ⌘1 … ⌘9 for its menus).
  const digits = (alt: string) => (mac ? `${digitMod(mac, safari)}${alt}1–9 · ${safari ? '⌘' : '⌃'}${alt}1–9` : `Ctrl+${alt ? 'Alt+' : ''}1–9`);
  const row = (key: string, keys: string, label: string) => <div key={key} className="shortcut-row"><dt><kbd>{keys}</kbd></dt><dd>{label}</dd></div>;
  const list = shortcutList(mac);
  const of = (g: 'move' | 'compose' | 'panes') => list.filter((s) => HELP_GROUP[s.id] === g).map((s) => row(s.id, s.keys, s.label));
  const groups: { id: 'move' | 'compose' | 'panes'; rows: ReactNode[] }[] = [
    { id: 'move', rows: [...of('move'),
      row('pins', digits(''), 'N번째 고정 세션 열기'),
      row('pin-order', `${mac ? '⌥' : 'Alt+'}↑/↓`, '고정 항목 순서 이동 (고정됨 줄의 버튼에서)'),
      row('esc', 'Esc', '창 닫기')] },
    { id: 'compose', rows: [...of('compose'),
      row('send', `${mac ? '⌘' : 'Ctrl+'}Enter`, '메시지 보내기 · 새 대화 화면에서는 새 분할 패널로 시작 (보내기 키가 Enter 일 때)'),
      row('perm', '⇧Tab', '권한 모드 바꾸기 (입력창에서)'),
      row('focus', '⇧Esc', '입력창으로 포커스')] },
    { id: 'panes', rows: [...of('panes'),
      row('panes', digits('⌥'), 'N번째 분할 패널로 이동 (왼쪽부터)'),
      row('palette-open', `${mac ? '⌘' : 'Ctrl+'}Enter · ⇧Enter`, '명령 팔레트의 세션: 새 분할 패널로 · 떠 있는 카드로 열기')] },
  ];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal shortcut-help" role="dialog" aria-modal="true" aria-label={t.title} onKeyDown={trapTab}>
        <header className="modal-head"><h2>{t.title}</h2><button type="button" className="icon-btn" aria-label={t.close} onClick={onClose} autoFocus>✕</button></header>
        <div className="shortcut-groups" tabIndex={0} role="group" aria-label={t.title}>
          {groups.map((g) => (
            <section key={g.id} className="shortcut-group" aria-labelledby={`shortcut-group-${g.id}`}>
              <h3 id={`shortcut-group-${g.id}`} className="shortcut-group-title">{t[g.id]}</h3>
              <dl className="shortcut-list">{g.rows}</dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A yes/no question (Esc / backdrop = no). */
export function ConfirmDialog({ title, message, confirmLabel, danger = false, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  useEscape(onCancel);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>취소</button>
          <button type="button" className={`btn ${danger ? 'deny' : 'primary'}`} onClick={onConfirm} autoFocus>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
