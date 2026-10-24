import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

/**
 * 'olderHistory' cursors: `<kind><n>.<tag>` — kind `i` (a Claude transcript's absolute message index) or `b` (a byte
 * offset in a Codex rollout / Grok chat_history), and the tag of the file it was taken from (fileTag). A cursor whose
 * tag is not the file's now (another copy, a rewritten file) points at nothing: it is refused, never read.
 */
export type CursorKind = 'i' | 'b';

/** open_session.from: a history reaches back to the cursor when it has at most this many messages from there to the end. */
export const HISTORY_FROM_MAX = 2000;

/**
 * open_session.from on a Claude transcript: the scan back to the cursor (from the nearest older-page mark, or the file's
 * start when there is none, e.g. after a restart) reads at most this many bytes; past it the plain window is sent.
 */
export const HISTORY_FROM_SCAN_BYTES = 32 * 1024 * 1024;

const TAG_HEAD_BYTES = 1024;

/** What identifies a transcript file: its dev:ino and its first bytes, hashed to 8 hex characters. */
export async function fileTag(file: string): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const st = await fh.stat({ bigint: true });
    const head = Buffer.alloc(TAG_HEAD_BYTES);
    const { bytesRead } = await fh.read(head, 0, TAG_HEAD_BYTES, 0);
    return createHash('sha1').update(`${st.dev}:${st.ino}:`).update(head.subarray(0, bytesRead)).digest('hex').slice(0, 8);
  } finally {
    await fh.close();
  }
}

export function cursorOf(kind: CursorKind, n: number, tag: string): string {
  return `${kind}${n}.${tag}`;
}

/** The position and tag of a cursor of this kind, or null (another kind, malformed). */
export function parseCursor(cursor: string, kind: CursorKind): { n: number; tag: string } | null {
  const m = /^([ib])(\d{1,15})\.([0-9a-f]{8})$/.exec(cursor);
  return m && m[1] === kind ? { n: Number(m[2]), tag: m[3]! } : null;
}
