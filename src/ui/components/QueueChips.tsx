import { useState } from 'react';
import type { QueueItem } from '../state';

/** ux-state: messages queued while a turn runs, above the composer — click to edit, ✕ to drop. */
export function QueueChips({ queue, paused, onEdit, onRemove, onClear, onResume }: {
  queue: QueueItem[];
  paused: boolean;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onResume: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (!queue.length) return null;
  const save = () => {
    if (editing === null) return;
    const text = draft.trim();
    const item = queue.find((q) => q.id === editing);
    if (text) onEdit(editing, text);
    else if (item && !item.attachments.length) onRemove(editing);
    setEditing(null);
  };
  return (
    <div className="queue" data-testid="queue">
      <span className="queue-label">{paused ? '대기열 멈춤' : '대기열'} {queue.length}</span>
      {queue.map((q, i) => (
        <span key={q.id} className="chip queue-chip">
          {editing === q.id ? (
            <input
              autoFocus
              value={draft}
              aria-label={`대기 메시지 ${i + 1} 수정`}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') setEditing(null); }}
            />
          ) : (
            <button type="button" className="queue-text" title={`${q.text}\n(클릭해서 수정)`} onClick={() => { setEditing(q.id); setDraft(q.text); }}>
              {q.attachments.length > 0 && <span aria-hidden="true">📎{q.attachments.length} </span>}
              {q.text || '첨부만'}
            </button>
          )}
          <button type="button" className="chip-remove" aria-label={`대기 메시지 ${i + 1} 삭제`} onClick={() => onRemove(q.id)}>✕</button>
        </span>
      ))}
      {paused && <button type="button" className="text-btn queue-resume" onClick={onResume}>이어서 보내기</button>}
      <button type="button" className="text-btn queue-clear" onClick={onClear}>모두 지우기</button>
    </div>
  );
}
