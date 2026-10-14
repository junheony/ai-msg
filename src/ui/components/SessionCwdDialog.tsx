import { useEffect } from 'react';
import { FolderPicker } from './FolderPicker';

/** 작업 폴더 바꾸기: the folder picker in a modal; the picked (server-checked) folder becomes the session's cwd. */
export function SessionCwdDialog({ title, cwd, onPick, onClose, fetchFn }: { title: string; cwd: string; onPick: (cwd: string) => void; onClose: () => void; fetchFn?: typeof fetch }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal session-cwd-dialog" role="dialog" aria-modal="true" aria-label="작업 폴더 바꾸기">
        <header className="modal-head"><h2>작업 폴더 바꾸기</h2><button type="button" className="icon-btn" aria-label="닫기" onClick={onClose}>✕</button></header>
        <p className="session-cwd-now muted"><span className="session-cwd-title">{title}</span> · 지금: <code>{cwd}</code></p>
        <p className="session-cwd-hint muted">다음 턴부터 고른 폴더에서 실행됩니다.</p>
        <FolderPicker onOpen={onPick} onClose={onClose} {...(fetchFn ? { fetchFn } : {})} />
      </div>
    </div>
  );
}
