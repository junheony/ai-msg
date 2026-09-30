import { useRef } from 'react';
import type { UploadedAttachment } from '../state';

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function AttachmentBar({ attachments, uploading, error, onFiles, onRemove }: {
  attachments: UploadedAttachment[];
  uploading: number;
  error: string | null;
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="attachment-bar">
      {attachments.map((a) => (
        <span key={a.id} className="chip attachment">
          {a.isImage ? '🖼 ' : '📄 '}{a.name} <span className="muted">{kb(a.size)}</span>
          <button type="button" className="chip-remove" aria-label="첨부 제거" onClick={() => onRemove(a.id)}>✕</button>
        </span>
      ))}
      {uploading > 0 && <span className="muted">업로드 중 {uploading}</span>}
      {error && <span className="error">{error}</span>}
      <button type="button" className="attach" onClick={() => input.current?.click()} title="이미지·파일 첨부 (붙여넣기·끌어놓기도 됩니다)">첨부</button>
      <input ref={input} data-testid="attachment-input" type="file" multiple hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onFiles(files); e.target.value = ''; }} />
    </div>
  );
}
