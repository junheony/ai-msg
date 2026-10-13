import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { MAX_ATTACHMENTS_PER_TURN, MAX_ATTACHMENT_BYTES } from '../shared/protocol';
import type { UploadedAttachment } from './state';

/** The text of a turn sent with attachments only. */
export const ATTACHMENT_ONLY_TEXT = '첨부 파일을 확인해 주세요.';

export type UploadFn = (file: File) => Promise<UploadedAttachment>;

/** D7: raw body upload; the server sniffs the type and sanitizes the name. */
export async function uploadFile(file: File, fetchFn: typeof fetch = fetch): Promise<UploadedAttachment> {
  let res: Response;
  try {
    res = await fetchFn('/api/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-deck-filename': encodeURIComponent(file.name || 'file') },
      body: file,
    });
  } catch {
    // fetch itself rejected (offline, DNS, CORS, aborted, …) — never surface the raw browser error.
    throw new Error('업로드 실패: 네트워크 오류');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `업로드 실패 (${res.status})`);
  }
  const j = (await res.json()) as { id: string; name: string; size: number; isImage: boolean };
  // ux-state: the composer previews the local file (blob: is allowed by the CSP img-src); the server's sniff decides.
  const previewUrl = j.isImage && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
  return { id: j.id, name: j.name, size: j.size, isImage: j.isImage, ...(previewUrl ? { previewUrl } : {}) };
}

/** A paste this long (either limit) becomes a `pasted-N.txt` attachment chip instead of composer text. */
export const PASTE_CHIP_MIN_CHARS = 1500;
export const PASTE_CHIP_MIN_LINES = 25;

export function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_CHIP_MIN_CHARS || lineCount(text) >= PASTE_CHIP_MIN_LINES;
}

/** The model sees pasted text as `pasted-1.txt`, `pasted-2.txt`, … (numbered within one message). */
export function pastedFileName(n: number): string {
  return `pasted-${n}.txt`;
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
  // Concurrent addFiles calls (paste + drop + picker, Task 12) each close over the same `current`
  // prop, so `current` alone can't see another call's in-flight uploads. pendingRef is reserved
  // synchronously — before this function's first await — so a second call made "back to back"
  // (e.g. via Promise.all) sees the first call's reservation and the combined cap still holds.
  const pendingRef = useRef(0);
  const addFiles = useCallback(async (files: File[]) => {
    setError(null);
    const room = Math.max(0, MAX_ATTACHMENTS_PER_TURN - current - pendingRef.current);
    const withinRoom = files.slice(0, room);
    if (files.length > room) setError(`첨부는 한 번에 최대 ${MAX_ATTACHMENTS_PER_TURN}개까지입니다`);
    // D7 / Task 6 security review: check size BEFORE uploading so an oversize file never hits the network.
    const accepted: File[] = [];
    for (const f of withinRoom) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setError(`첨부가 너무 큽니다(최대 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB)`);
      } else {
        accepted.push(f);
        pendingRef.current += 1; // reserved synchronously, before any await below
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
        pendingRef.current -= 1;
      }
    }
  }, [uploadFn, current, onUploaded]);
  return { addFiles, uploading, error };
}

/**
 * A composer's uploads plus its paste handling: pasted files attach; a long text paste (isLongPaste, wherever the caret
 * is) goes up as `pasted-N.txt` (numbered within the message, restarting once no attachment is left) and its text is
 * kept by attachment id in `pastedTexts` for the chip's preview (memory only, never persisted). Short text pastes as usual.
 * A long paste whose upload fails goes to `onUploadFailed` (the composer puts the text back), so nothing pasted is lost.
 */
export function usePasteUploads({ uploadFn, attachments, onUploaded, onUploadFailed, disabled = false }: { uploadFn: UploadFn; attachments: UploadedAttachment[]; onUploaded: (a: UploadedAttachment) => void; onUploadFailed?: (text: string) => void; disabled?: boolean }) {
  const pastedFiles = useRef(new WeakMap<File, string>());
  const pasteSeq = useRef(0);
  const [pastedTexts, setPastedTexts] = useState<Record<string, string>>({});
  const uploadWithText: UploadFn = async (f) => {
    let a: UploadedAttachment;
    try {
      a = await uploadFn(f);
    } catch (err) {
      const text = pastedFiles.current.get(f);
      if (text !== undefined) onUploadFailed?.(text);
      throw err;
    }
    const t = pastedFiles.current.get(f);
    if (t !== undefined) setPastedTexts((m) => ({ ...m, [a.id]: t }));
    return a;
  };
  const { addFiles: upload, uploading, error } = useUploads({ uploadFn: uploadWithText, current: attachments.length, onUploaded });
  // Once nothing is uploading, texts of removed chips go (all of them, and the numbering restarts, when none is left).
  useEffect(() => {
    if (uploading !== 0) return;
    if (attachments.length === 0) pasteSeq.current = 0;
    setPastedTexts((m) => {
      const ids = Object.keys(m);
      const keep = ids.filter((id) => attachments.some((a) => a.id === id));
      return keep.length === ids.length ? m : Object.fromEntries(keep.map((id) => [id, m[id]!]));
    });
  }, [attachments, uploading]);
  const addFiles = async (files: File[]) => { if (!disabled) await upload(files); };
  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    const files = filesFrom(e.clipboardData);
    if (files.length) { e.preventDefault(); void addFiles(files); return; }
    // iOS Safari too: plain getData.
    const pasted = e.clipboardData?.getData?.('text/plain') ?? '';
    if (!pasted || !isLongPaste(pasted) || disabled) return;
    // No room for another attachment: it pastes as plain text instead.
    if (attachments.length + uploading >= MAX_ATTACHMENTS_PER_TURN) return;
    e.preventDefault();
    const used = attachments.map((a) => /^pasted-(\d+)\.txt$/.exec(a.name)?.[1]).filter(Boolean).map(Number);
    const n = Math.max(pasteSeq.current, ...used) + 1;
    pasteSeq.current = n;
    const file = new File([pasted], pastedFileName(n), { type: 'text/plain' });
    pastedFiles.current.set(file, pasted);
    void addFiles([file]);
  };
  return { addFiles, onPaste, uploading, error, pastedTexts };
}
