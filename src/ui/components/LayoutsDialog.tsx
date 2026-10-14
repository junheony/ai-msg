import { useEffect, useLayoutEffect, useState } from 'react';
import type { SavedLayout } from '../layouts';

/** How long 정말 삭제 waits for the second click before it goes back to 삭제. */
const CONFIRM_MS = 3000;

/**
 * 카드 배치: save the panes as they are now under a name, and load or delete a saved one (삭제 asks once more: the same
 * button turns into 정말 삭제 for a few seconds). `error`: the last save failed (shown under the name field). Focus goes
 * back where it was when the dialog closes (as Sheet does).
 */
export function LayoutsDialog({ layouts, error, onSave, onLoad, onDelete, onClose }: { layouts: SavedLayout[]; error?: string | null; onSave: (name: string) => boolean; onLoad: (layout: SavedLayout) => void; onDelete: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [opener] = useState(() => (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useLayoutEffect(() => () => { (opener?.isConnected && opener !== document.body ? opener : document.querySelector<HTMLElement>('[data-sheet-return]'))?.focus(); }, [opener]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirm]);
  const key = name.trim();
  const exists = layouts.some((l) => l.name === key);
  const save = () => { if (key && onSave(key)) setName(''); };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal layouts-dialog" role="dialog" aria-modal="true" aria-label="카드 배치">
        <header className="modal-head"><h2>카드 배치</h2><button type="button" className="icon-btn" aria-label="닫기" onClick={onClose}>✕</button></header>
        <form className="layouts-save" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input type="text" aria-label="배치 이름" placeholder="배치 이름" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
          <button type="submit" className="btn primary" disabled={!key}>{exists ? '덮어쓰기' : '지금 배치 저장'}</button>
        </form>
        {error && <p className="layouts-error">{error}</p>}
        {layouts.length === 0 ? <p className="muted layouts-empty">저장된 배치가 없습니다.</p> : (
          <ul className="layouts-list" aria-label="저장된 배치">
            {layouts.map((l) => (
              <li key={l.name} className="layouts-row">
                <span className="layouts-name">{l.name}</span>
                <span className="layouts-meta muted">{new Date(l.savedAt).toLocaleString()} · 패널 {l.panes.length}개</span>
                <button type="button" className="btn ghost" aria-label={`${l.name} 불러오기`} onClick={() => onLoad(l)}>불러오기</button>
                {confirm === l.name
                  ? <button type="button" className="btn deny" aria-label={`${l.name} 정말 삭제`} onClick={() => { setConfirm(null); onDelete(l.name); }}>정말 삭제</button>
                  : <button type="button" className="btn deny" aria-label={`${l.name} 삭제`} onClick={() => setConfirm(l.name)}>삭제</button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
