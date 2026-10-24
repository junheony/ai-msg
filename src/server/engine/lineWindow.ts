import fs from 'node:fs/promises';
import type { TranscriptMessage } from '../../shared/session-types';

/**
 * Paging a jsonl transcript by byte offset (Codex rollouts, Grok chat_history): a page's cursor is the byte where the
 * line that made its first message starts, and the page before it is read from the lines before that byte only.
 */

/** Turns lines into messages, remembering where the line that pushed each one starts. */
export interface OffsetBuilder {
  add(line: string, at: number): void;
  /** The messages so far and, index for index, the byte offset of the line that pushed each. */
  entries(): { messages: TranscriptMessage[]; starts: number[] };
}

/** A transcript window and the cursor for the page before it: a byte offset, or null = it starts at the beginning. */
export type ByteWindow = { messages: TranscriptMessage[]; older: number | null };

const CHUNK = 4 * 1024 * 1024;
/** An older page reads back this far first, doubling up to `PAGE_MAX_BYTES` until it has a full page. */
const PAGE_MIN_BYTES = 1024 * 1024;
const PAGE_MAX_BYTES = 64 * 1024 * 1024;

async function readAt(fh: fs.FileHandle, start: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, start + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/**
 * The lines of `[start, end)` with the byte each starts at, split on `\n`. A line cut by `start` is skipped (one that
 * starts exactly there is kept); the last one is given even without its `\n`.
 */
export async function* linesOf(fh: fs.FileHandle, start: number, end: number): AsyncGenerator<{ at: number; line: string }> {
  let pos = start > 0 ? start - 1 : 0;
  let skip = start > 0; // up to the first `\n` at or after start - 1
  let carry: Buffer = Buffer.alloc(0);
  let carryAt = pos;
  while (pos < end) {
    const chunk = await readAt(fh, pos, Math.min(CHUNK, end - pos));
    if (chunk.length === 0) break;
    pos += chunk.length;
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const base = carryAt;
    let i = 0;
    if (skip) {
      const nl = buf.indexOf(10);
      if (nl < 0) {
        carry = Buffer.alloc(0);
        carryAt = pos;
        continue;
      }
      i = nl + 1;
      skip = false;
    }
    for (let nl = buf.indexOf(10, i); nl >= 0; nl = buf.indexOf(10, i)) {
      yield { at: base + i, line: buf.toString('utf8', i, nl) };
      i = nl + 1;
    }
    carry = buf.subarray(i);
    carryAt = base + i;
  }
  if (!skip && carry.length) yield { at: carryAt, line: carry.toString('utf8') };
}

function windowOf(b: OffsetBuilder, count: number, fromStart: boolean, firstLine: number | null): ByteWindow {
  const { messages, starts } = b.entries();
  const lo = Math.max(0, messages.length - count);
  if (messages.length === 0) return { messages: [], older: fromStart || firstLine === null ? null : firstLine };
  return { messages: messages.slice(lo), older: lo === 0 && fromStart ? null : starts[lo]! };
}

/** The last `count` messages of the file's last `maxBytes` (all of it by default), and the cursor before them. */
export async function readByteWindow(file: string, make: () => OffsetBuilder, count = 200, maxBytes = Infinity): Promise<ByteWindow> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const b = make();
    let firstLine: number | null = null;
    for await (const { at, line } of linesOf(fh, start, size)) {
      firstLine ??= at;
      b.add(line, at);
    }
    return windowOf(b, count, start === 0, firstLine);
  } finally {
    await fh.close();
  }
}

/**
 * The (up to) `count` messages made by the lines before byte `before` (a `ByteWindow.older`), and the cursor before
 * them. Reads back from `before` only as far as it takes. `dropFirst`: the first message of a region that does not start
 * at the file's start may be part of one that began earlier (a Codex tool call joins the assistant message before it),
 * so it is left to the next page. Null = `before` is not inside the file.
 */
export async function readByteWindowBefore(file: string, before: number, make: () => OffsetBuilder, count = 200, dropFirst = false): Promise<ByteWindow | null> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (!Number.isSafeInteger(before) || before <= 0 || before > size) return null;
    for (let span = PAGE_MIN_BYTES; ; span *= 2) {
      const start = Math.max(0, before - span);
      const b = make();
      let firstLine: number | null = null;
      for await (const { at, line } of linesOf(fh, start, before)) {
        firstLine ??= at;
        b.add(line, at);
      }
      const { messages, starts } = b.entries();
      const usable = start > 0 && dropFirst ? messages.length - 1 : messages.length;
      if (usable >= count || start === 0 || span >= PAGE_MAX_BYTES) {
        if (start > 0 && dropFirst && messages.length > 0) {
          // The first message is not returned: the page before this one starts at its line.
          const lo = Math.max(1, messages.length - count);
          return { messages: messages.slice(lo), older: messages.length > 1 ? starts[lo]! : starts[0]! };
        }
        return windowOf(b, count, start === 0, firstLine);
      }
    }
  } finally {
    await fh.close();
  }
}
