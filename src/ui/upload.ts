import { useCallback, useState } from 'react';
import { MAX_ATTACHMENTS_PER_TURN, MAX_ATTACHMENT_BYTES } from '../shared/protocol';
import type { UploadedAttachment } from './state';

export type UploadFn = (file: File) => Promise<UploadedAttachment>;

/** D7: raw body upload; the server sniffs the type and sanitizes the name. */
export async function uploadFile(file: File, fetchFn: typeof fetch = fetch): Promise<UploadedAttachment> {
  const res = await fetchFn('/api/attachments', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-deck-filename': encodeURIComponent(file.name || 'file') },
    body: file,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `업로드 실패 (${res.status})`);
  }
  const j = (await res.json()) as { id: string; name: string; size: number; isImage: boolean };
  return { id: j.id, name: j.name, size: j.size, isImage: j.isImage };
}

/** Files of a paste/drop; null-safe. */
export function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files) for (const f of Array.from(dt.files)) out.push(f);
  return out;
}

export function useUploads({ uploadFn, current, onUploaded }: { uploadFn: UploadFn; current: number; onUploaded: (a: UploadedAttachment) => void }) {
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const addFiles = useCallback(async (files: File[]) => {
    setError(null);
    const room = Math.max(0, MAX_ATTACHMENTS_PER_TURN - current);
    const withinRoom = files.slice(0, room);
    if (files.length > room) setError(`첨부는 한 번에 최대 ${MAX_ATTACHMENTS_PER_TURN}개까지입니다`);
    // D7 / Task 6 security review: check size BEFORE uploading so an oversize file never hits the network.
    const accepted: File[] = [];
    for (const f of withinRoom) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setError(`첨부가 너무 큽니다(최대 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB)`);
      } else {
        accepted.push(f);
      }
    }
    for (const f of accepted) {
      setUploading((n) => n + 1);
      try {
        onUploaded(await uploadFn(f));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }, [uploadFn, current, onUploaded]);
  return { addFiles, uploading, error };
}
