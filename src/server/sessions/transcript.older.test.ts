import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearTranscriptCache, clearTranscriptMarks, readTranscriptBefore, readTranscriptUncached, readTranscriptWindow, setTranscriptCacheDir,
  setTranscriptMarkLimits, transcriptMarkCount,
} from './transcript';
import type { TranscriptMessage } from '../../shared/session-types';

const L = (o: unknown) => JSON.stringify(o);

/** Prompts, assistant chunks sharing an id (one with a tool call), its tool result, steers logged twice, hook rows. */
function records(count: number, pad = 0): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const k = i % 6;
    if (k === 0) out.push(L({ type: 'user', uuid: `u${i}`, timestamp: `t${i}`, message: { role: 'user', content: `q ${i}` } }));
    else if (k === 1 || k === 2) out.push(L({ type: 'assistant', timestamp: `t${i}`, message: { id: `a${Math.floor(i / 6)}`, model: 'm', role: 'assistant', content: [{ type: 'text', text: `c ${i}` }, ...(k === 2 ? [{ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'ls' } }] : [])], usage: { input_tokens: i, output_tokens: 1 } } }));
    else if (k === 3) out.push(L({ type: 'user', timestamp: `t${i}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i - 1}`, content: 'r'.repeat(20 + pad) }] } }));
    else if (k === 4) out.push(L({ type: 'attachment', timestamp: `t${i}`, attachment: { type: 'queued_command', prompt: `steer ${i}`, source_uuid: `s${i}` } }));
    else out.push(L({ type: 'user', uuid: `s${i - 1}`, timestamp: `t${i}`, message: { role: 'user', content: `steer ${i - 1}` } }));
  }
  return out;
}

async function file(lines: string[]): Promise<string> {
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-older-')), 's.jsonl');
  await fs.writeFile(f, lines.join('\n') + '\n');
  return f;
}

/** Pages back from the window's start to the transcript's beginning; the pages in order, then the window. */
async function pageAll(f: string, count: number, window = 200): Promise<{ all: TranscriptMessage[]; pages: number }> {
  const w = await readTranscriptWindow(f, { maxMessages: window });
  let all = w.messages;
  let start = w.start;
  let pages = 0;
  while (start > 0) {
    const p = await readTranscriptBefore(f, start, count);
    expect(p.messages.length).toBeGreaterThan(0);
    expect(p.start).toBe(Math.max(0, start - count));
    all = [...p.messages, ...all];
    start = p.start;
    pages++;
  }
  return { all, pages };
}

afterEach(() => {
  setTranscriptCacheDir(null);
  clearTranscriptCache();
  clearTranscriptMarks();
  setTranscriptMarkLimits(null);
});

describe('readTranscriptWindow', () => {
  it('start = absolute index of the first message (0 when the whole transcript fits)', async () => {
    const f = await file(records(60));
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    const w = await readTranscriptWindow(f, { maxMessages: 10 });
    expect(w.messages).toEqual(full.slice(-10));
    expect(w.start).toBe(full.length - 10);
    expect((await readTranscriptWindow(f, { maxMessages: 1000 })).start).toBe(0);
  });

  it('start stays right when the cached window grows by appends', async () => {
    const lines = records(120);
    const f = await file(lines.slice(0, 50));
    await readTranscriptWindow(f, { maxMessages: 10 });
    await fs.appendFile(f, lines.slice(50).join('\n') + '\n');
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    const w = await readTranscriptWindow(f, { maxMessages: 10 });
    expect(w.start).toBe(full.length - 10);
    expect(w.messages).toEqual(full.slice(-10));
  });
});

describe('readTranscriptBefore', () => {
  it('pages back to the start: same messages as a full read, no gaps or repeats, exact page boundaries', async () => {
    const f = await file(records(500));
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    const { all, pages } = await pageAll(f, 37, 50);
    expect(all).toEqual(full);
    expect(pages).toBe(Math.ceil((full.length - 50) / 37));
  });

  it('a page reaching the start has start 0 (no more); a short transcript has nothing earlier', async () => {
    const f = await file(records(30));
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    const p = await readTranscriptBefore(f, 5, 200);
    expect(p).toEqual({ messages: full.slice(0, 5), start: 0 });
    expect((await readTranscriptWindow(f)).start).toBe(0);
  });

  it('large file (several 1MB marks): with marks, without (restart), and with a warm window cache — all the same', async () => {
    const f = await file(records(9000, 600));
    expect((await fs.stat(f)).size).toBeGreaterThan(2 * 1024 * 1024);
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    const first = await pageAll(f, 200);
    expect(first.all).toEqual(full);
    // Marks kept: later reads resume from them.
    const w = await readTranscriptWindow(f);
    const mid = Math.floor(w.start / 2);
    const warm = await readTranscriptBefore(f, mid, 200);
    clearTranscriptMarks();
    clearTranscriptCache();
    const cold = await readTranscriptBefore(f, mid, 200);
    expect(warm).toEqual(cold);
    expect(cold.messages).toEqual(full.slice(mid - 200, mid));
  }, 60_000);

  it('snapshot cache on disk (window from a fresh process) gives the same start', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-older-cache-'));
    setTranscriptCacheDir(dir);
    const f = await file(records(400));
    const a = await readTranscriptWindow(f);
    clearTranscriptCache();
    const b = await readTranscriptWindow(f);
    expect(b).toEqual(a);
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    expect((await readTranscriptBefore(f, b.start, 200)).messages).toEqual(full.slice(Math.max(0, b.start - 200), b.start));
  });

  it('marks survive appends and are dropped when the file is rewritten', async () => {
    const lines = records(9000, 600);
    const f = await file(lines.slice(0, 6000));
    const before = await readTranscriptUncached(f, { maxMessages: Infinity });
    await readTranscriptBefore(f, before.length - 1, 200);
    await fs.appendFile(f, lines.slice(6000).join('\n') + '\n');
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    expect((await readTranscriptBefore(f, 1000, 200)).messages).toEqual(full.slice(800, 1000));
    // Rewritten (different content, same path): the old marks must not be used.
    await fs.writeFile(f, records(3000, 900).map((l) => l.replace(/"q /g, '"Q ')).join('\n') + '\n');
    const other = await readTranscriptUncached(f, { maxMessages: Infinity });
    expect((await readTranscriptBefore(f, 1000, 200)).messages).toEqual(other.slice(800, 1000));
  }, 60_000);

  it('marks per file are capped: past the cap every other one goes (stride doubles) and pages stay exact', async () => {
    setTranscriptMarkLimits({ chunk: 4096, max: 8 });
    const f = await file(records(3000, 100));
    expect((await fs.stat(f)).size / 4096).toBeGreaterThan(50);
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    const { all } = await pageAll(f, 200);
    expect(all).toEqual(full);
    expect(transcriptMarkCount(f)).toBeGreaterThan(0);
    expect(transcriptMarkCount(f)).toBeLessThanOrEqual(8);
    for (const at of [150, 1200, full.length - 10]) expect((await readTranscriptBefore(f, at, 100)).messages).toEqual(full.slice(at - 100, at));
  });

  it('maxScanBytes: a scan that would read further gives an empty page; the marks it left stay, so later scans go on from them', async () => {
    setTranscriptMarkLimits({ chunk: 4096, max: 1000 });
    const f = await file(records(3000, 100));
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    const at = full.length - 10;
    expect(await readTranscriptBefore(f, at, 10, undefined, 16 * 1024)).toEqual({ messages: [], start: 0 });
    const marks = transcriptMarkCount(f);
    expect(marks).toBeGreaterThan(0);
    let tries = 1;
    let p = await readTranscriptBefore(f, at, 10, undefined, 16 * 1024);
    while (!p.messages.length && tries < 1000) {
      p = await readTranscriptBefore(f, at, 10, undefined, 16 * 1024);
      tries++;
    }
    expect(transcriptMarkCount(f)).toBeGreaterThan(marks);
    expect(tries).toBeGreaterThan(2);
    expect(p).toEqual({ messages: full.slice(at - 10, at), start: at - 10 });
  });

  it('invalid before: ≤ 0 or past the end gives an empty page', async () => {
    const f = await file(records(30));
    expect(await readTranscriptBefore(f, 0)).toEqual({ messages: [], start: 0 });
    expect(await readTranscriptBefore(f, -3)).toEqual({ messages: [], start: 0 });
    expect(await readTranscriptBefore(f, 10_000)).toEqual({ messages: [], start: 0 });
  });

  it('a last line without its newline is read', async () => {
    const lines = records(40);
    const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-older-')), 's.jsonl');
    await fs.writeFile(f, lines.join('\n'));
    const full = await readTranscriptUncached(f, { maxMessages: Infinity });
    expect((await readTranscriptBefore(f, full.length, 1000)).messages).toEqual(full);
  });
});
