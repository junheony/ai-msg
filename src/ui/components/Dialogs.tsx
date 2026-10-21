import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { shortcutList } from '../shortcuts';
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

/** ⌘/ cheat sheet. */
export function ShortcutHelp({ mac, onClose }: { mac: boolean; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal shortcut-help" role="dialog" aria-modal="true" aria-label="단축키">
        <header className="modal-head"><h2>단축키</h2><button type="button" className="icon-btn" aria-label="닫기" onClick={onClose} autoFocus>✕</button></header>
        <dl className="shortcut-list">
          {shortcutList(mac).map((s) => (
            <div key={s.id} className="shortcut-row"><dt><kbd>{s.keys}</kbd></dt><dd>{s.label}</dd></div>
          ))}
          <div className="shortcut-row"><dt><kbd>{mac ? '⌘⌥' : 'Ctrl+Alt+'}1–9</kbd></dt><dd>N번째 분할 패널로 이동 (왼쪽부터)</dd></div>
          <div className="shortcut-row"><dt><kbd>{mac ? '⌘' : 'Ctrl+'}1–9</kbd></dt><dd>N번째 고정 세션 열기</dd></div>
          <div className="shortcut-row"><dt><kbd>{mac ? '⌘' : 'Ctrl+'}Enter</kbd></dt><dd>메시지 보내기 · 새 대화 화면에서는 새 분할 패널로 시작 (보내기 키가 Enter 일 때)</dd></div>
          <div className="shortcut-row"><dt><kbd>{mac ? '⌘' : 'Ctrl+'}Enter · ⇧Enter</kbd></dt><dd>명령 팔레트의 세션: 새 분할 패널로 · 떠 있는 카드로 열기</dd></div>
          <div className="shortcut-row"><dt><kbd>⇧Tab</kbd></dt><dd>권한 모드 바꾸기 (입력창에서)</dd></div>
          <div className="shortcut-row"><dt><kbd>{mac ? '⌥' : 'Alt+'}↑/↓</kbd></dt><dd>고정 항목 순서 이동 (고정됨 줄의 버튼에서)</dd></div>
          <div className="shortcut-row"><dt><kbd>⇧Esc</kbd></dt><dd>입력창으로 포커스</dd></div>
          <div className="shortcut-row"><dt><kbd>Esc</kbd></dt><dd>창 닫기</dd></div>
        </dl>
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
