import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { trapTab } from '../../components/Dialogs';

/**
 * A dialog layer at the hub's root. The hub sections are containing blocks, so a fixed backdrop rendered inside one
 * would dim only that section; `.hub-main` still carries the controls' colour tokens.
 */
export function CtlLayer({ children }: { children: ReactNode }) {
  return createPortal(children, document.querySelector('.hub-main') ?? document.body);
}

/**
 * The confirm step every hub action goes through. Nothing reaches the server before its confirm button is pressed;
 * the action runs here so the dialog can hold its busy state and show a refusal in place (the server's words).
 */
export function CtlConfirm({ title, children, confirmLabel, tone = 'primary', onConfirm, onClose, disabled = false }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** Resolves when done (the dialog closes), throws to show the error and stay open. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const go = async () => {
    setBusy(true); setError(null);
    try { await onConfirm(); onClose(); } catch (err) { setError(err instanceof Error ? err.message : '실패했어요'); setBusy(false); }
  };
  return (
    <CtlLayer>
      <div className="modal-backdrop ctl-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal ctl-modal ctl-confirm" role="alertdialog" aria-modal="true" aria-label={title} onKeyDown={trapTab}>
          <h2>{title}</h2>
          <div className="ctl-confirm-body">{children}</div>
          {error && <p className="ctl-err" role="alert">{error}</p>}
          <div className="ctl-actions">
            <button ref={cancelRef} type="button" className="ctl-btn ghost" onClick={onClose} disabled={busy}>취소</button>
            <button type="button" className={`ctl-btn ${tone === 'danger' ? 'danger' : 'solid'}`} onClick={() => void go()} disabled={busy || disabled}>{busy ? '보내는 중…' : confirmLabel}</button>
          </div>
        </div>
      </div>
    </CtlLayer>
  );
}
