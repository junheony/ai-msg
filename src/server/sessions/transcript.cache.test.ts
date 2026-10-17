import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CODE_VERSION_SOURCE, clearTranscriptCache, flushTranscriptCache, pruneTranscriptSnapshots, readTranscript, readTranscriptUncached, setTranscriptCacheDir,
  setTranscriptMemoryLimit, transcriptMemoryState,
} from './transcript';
import type { TranscriptOptions } from './transcript';

const L = (o: unknown) => JSON.stringify(o);

/** A mixed transcript: prompts, steers logged twice (same source uuid), assistant chunks sharing an id, tool results, hook rows. */
function records(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const k = i % 7;
    if (k === 0) out.push(L({ type: 'user', uuid: `u${i}`, timestamp: `t${i}`, message: { role: 'user', content: `질문 ${i} ✓` } }));
    else if (k === 1 || k === 2) out.push(L({ type: 'assistant', timestamp: `t${i}`, message: { id: `a${Math.floor(i / 7)}`, model: 'm', role: 'assistant', content: [{ type: 'text', text: `조각 ${i}` }, ...(k === 2 ? [{ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'ls' } }] : []), ], usage: { input_tokens: i, output_tokens: 1 } } }));
    else if (k === 3) out.push(L({ type: 'user', timestamp: `t${i}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i - 1}`, content: 'r'.repeat(i * 50) }] } }));
    else if (k === 4) out.push(L({ type: 'attachment', timestamp: `t${i}`, attachment: { type: 'queued_command', prompt: `끼어들기 ${i}`, source_uuid: `s${i}` } }));
    else if (k === 5) out.push(L({ type: 'user', uuid: `s${i - 1}`, timestamp: `t${i}`, message: { role: 'user', content: `끼어들기 ${i - 1}` } }));
    else out.push(L({ type: 'user', isMeta: true, timestamp: `t${i}`, message: { role: 'user', content: 'Stop hook feedback:\nkeep going' } }));
  }
  return out;
}

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'deck-trc-'));
}

async function same(f: string, opts: TranscriptOptions = {}): Promise<void> {
  expect(await readTranscript(f, opts)).toEqual(await readTranscriptUncached(f, opts));
}

afterEach(() => {
  setTranscriptCacheDir(null);
  clearTranscriptCache();
});

describe('readTranscript — incremental cache matches a full read', () => {
  it('appends cut at arbitrary bytes (mid-line, mid-character), several window sizes', async () => {
    const f = path.join(await tmp(), 's.jsonl');
    const all = Buffer.from(records(400).join('\n') + '\n');
    await fs.writeFile(f, '');
    // Cuts that land inside lines and inside multibyte characters.
    for (let at = 0; at < all.length; ) {
      const next = Math.min(all.length, at + 997 + ((at * 31) % 4001));
      await fs.appendFile(f, all.subarray(at, next));
      at = next;
      await same(f);
      await same(f, { maxMessages: 3 });
      await same(f, { maxMessages: 1, maxToolResultChars: 10 });
    }
  });

  it('merges same-id assistant chunks across the cached offset', async () => {
    const f = path.join(await tmp(), 's.jsonl');
    const chunk = (t: string) => L({ type: 'assistant', message: { id: 'a1', model: 'm', role: 'assistant', content: [{ type: 'text', text: t }] } });
    await fs.writeFile(f, L({ type: 'user', message: { role: 'user', content: 'go' } }) + '\n' + chunk('one') + '\n');
    const first = await readTranscript(f);
    await same(f);
    await fs.appendFile(f, chunk('two') + '\n');
    await same(f);
    // The earlier result is the caller's own: the later merge did not change it.
    expect(first.at(-1)).toMatchObject({ kind: 'assistant', text: 'one' });
    // A chunk still being written (no newline yet) is read, then completed.
    await fs.appendFile(f, chunk('three'));
    await same(f);
    await fs.appendFile(f, '\n');
    await same(f);
  });

  it('a complete last line without its newline is read but not kept as the cached state', async () => {
    const f = path.join(await tmp(), 's.jsonl');
    await fs.writeFile(f, L({ type: 'user', uuid: 'x', message: { role: 'user', content: 'a' } }));
    await same(f);
    await fs.appendFile(f, '\n' + L({ type: 'user', uuid: 'x', message: { role: 'user', content: 'a again' } }) + '\n');
    await same(f);
  });

  it('CRLF and lone CR line ends split as readline does', async () => {
    const f = path.join(await tmp(), 's.jsonl');
    const [a, b, c] = records(3);
    await fs.writeFile(f, `${a}\r\n${b}\r`);
    await same(f);
    await fs.appendFile(f, `${c}\r\n`);
    await same(f);
  });

  it('a rewritten, shrunk or replaced file is read from the start', async () => {
    const dir = await tmp();
    const f = path.join(dir, 's.jsonl');
    const lines = records(60);
    await fs.writeFile(f, lines.join('\n') + '\n');
    await same(f);
    // In place, same length, different content (same inode).
    await fs.writeFile(f, lines.map((l) => l.replace(/조각/g, '파편')).join('\n') + '\n');
    await same(f);
    // Shrunk.
    await fs.writeFile(f, lines.slice(0, 10).join('\n') + '\n');
    await same(f);
    // Longer, same head, different middle (in place).
    await fs.writeFile(f, [...lines.slice(0, 10), ...records(30).reverse()].join('\n') + '\n');
    await same(f);
    // Replaced by another file (new inode).
    const g = path.join(dir, 'g.jsonl');
    await fs.writeFile(g, records(90).join('\n') + '\n');
    await fs.rename(g, f);
    await same(f);
  });

  it('unbounded windows are read in full, not cached', async () => {
    const f = path.join(await tmp(), 's.jsonl');
    await fs.writeFile(f, records(20).join('\n') + '\n');
    await same(f, { maxMessages: Infinity });
    await same(f, { maxMessages: 0 });
  });
});

describe('readTranscript — snapshot on disk', () => {
  it('resumes from the snapshot after a restart, and ignores a damaged one', async () => {
    const cache = await tmp();
    setTranscriptCacheDir(cache);
    const f = path.join(await tmp(), 's.jsonl');
    const lines = records(200);
    await fs.writeFile(f, lines.slice(0, 120).join('\n') + '\n');
    await same(f);
    await flushTranscriptCache();
    const [snap] = await fs.readdir(cache);
    expect(snap).toMatch(/\.json$/);

    clearTranscriptCache(); // restart
    await fs.appendFile(f, lines.slice(120).join('\n') + '\n');
    await same(f);
    await flushTranscriptCache();

    // The snapshot is what is resumed from: a change hidden in the middle (outside the fingerprints) goes unread.
    clearTranscriptCache();
    const text = await fs.readFile(f, 'utf8');
    const mid = text.indexOf('질문 70 ');
    await fs.writeFile(f, text.slice(0, mid) + '질문 7X ' + text.slice(mid + '질문 70 '.length));
    expect(JSON.stringify(await readTranscript(f))).toContain('질문 70 ');

    // Damaged snapshots: rebuilt from the jsonl.
    clearTranscriptCache();
    for (const n of await fs.readdir(cache)) await fs.writeFile(path.join(cache, n), '{"key":');
    await same(f);
    await flushTranscriptCache();
    clearTranscriptCache();
    await fs.appendFile(f, records(5).join('\n') + '\n');
    await same(f);
  });
});

const sha1hex = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/** A cache dir holding one snapshot of `f` (read once, written to disk); returns the snapshot's path. */
async function snapshotOf(cache: string, f: string): Promise<string> {
  setTranscriptCacheDir(cache);
  await readTranscript(f);
  await flushTranscriptCache();
  const names = (await fs.readdir(cache)).filter((n) => n.endsWith('.json'));
  expect(names).toHaveLength(1);
  return path.join(cache, names[0]!);
}

describe('pruneTranscriptSnapshots', () => {
  it('removes snapshots of deleted sessions, ones unused for 14 days, and the oldest past the size cap', async () => {
    const cache = await tmp();
    const src = await tmp();
    setTranscriptCacheDir(cache);
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = path.join(src, `s${i}.jsonl`);
      await fs.writeFile(f, records(40 + i).join('\n') + '\n');
      await readTranscript(f);
      files.push(f);
    }
    await flushTranscriptCache();
    const snaps = (await fs.readdir(cache)).map((n) => path.join(cache, n));
    expect(snaps).toHaveLength(5);
    // Which snapshot is whose: the source path is kept in the snapshot.
    const byFile = new Map<string, string>();
    for (const s of snaps) byFile.set((JSON.parse(await fs.readFile(s, 'utf8')) as { file: string }).file, s);
    const snap = (i: number) => byFile.get(path.resolve(files[i]!))!;
    expect(snaps.every((s) => [...byFile.values()].includes(s))).toBe(true);

    const now = Date.now();
    const at = async (s: string, ageMs: number) => fs.utimes(s, new Date(now - ageMs), new Date(now - ageMs));
    // (a) source gone
    await fs.rm(files[0]!);
    // (b) not touched for 14 days
    await at(snap(1), 14 * 24 * 3600 * 1000 + 1000);
    // (c) the rest: s2 oldest, s4 newest; the cap fits only the newest one
    await at(snap(2), 3000);
    await at(snap(3), 2000);
    await at(snap(4), 1000);
    const size4 = (await fs.stat(snap(4))).size;

    const removed = await pruneTranscriptSnapshots(cache, { maxBytes: size4 + 1 });
    expect(removed.sort()).toEqual([snap(0), snap(1), snap(2), snap(3)].sort());
    expect(await fs.readdir(cache)).toEqual([path.basename(snap(4))]);
    // Nothing more to do; a missing dir is not an error.
    expect(await pruneTranscriptSnapshots(cache, { maxBytes: size4 + 1 })).toEqual([]);
    expect(await pruneTranscriptSnapshots(path.join(cache, 'missing'))).toEqual([]);
  });
});

describe('CODE_VERSION inputs', () => {
  it('include the module constants that shape the output and a manual format number', () => {
    for (const s of ['local-command-caveat', 'Goal check-in:', 'hook (?:feedback|blocking error)', '백그라운드 작업 완료', 'sk-ant-', 'tool_result', 'task-notification']) {
      expect(CODE_VERSION_SOURCE).toContain(s);
    }
    expect(CODE_VERSION_SOURCE).toMatch(/^format:\d+\0/);
  });
});

describe('readTranscript — memory cache bounded by size', () => {
  it('drops the least recently used entries once the byte total passes the limit', async () => {
    const dir = await tmp();
    const f = (i: number) => path.join(dir, `s${i}.jsonl`);
    for (let i = 0; i < 3; i++) await fs.writeFile(f(i), records(300).join('\n') + '\n');
    try {
      await readTranscript(f(0));
      const one = transcriptMemoryState().bytes;
      expect(one).toBeGreaterThan(1000);
      setTranscriptMemoryLimit(Math.floor(one * 2.5));
      await readTranscript(f(1));
      await readTranscript(f(2));
      expect(transcriptMemoryState().files).toEqual([path.resolve(f(1)), path.resolve(f(2))]);
      await readTranscript(f(1)); // used again: now the newest
      await readTranscript(f(0));
      expect(transcriptMemoryState().files).toEqual([path.resolve(f(1)), path.resolve(f(0))]);
      expect(transcriptMemoryState().bytes).toBeLessThanOrEqual(Math.floor(one * 2.5));
      await same(f(2));
    } finally {
      setTranscriptMemoryLimit(null);
    }
  });
});

describe('readTranscript — snapshot size cap counts UTF-8 bytes', () => {
  it('does not write a snapshot under 64M code units but over 64 MB', async () => {
    const cache = await tmp();
    setTranscriptCacheDir(cache);
    const f = path.join(await tmp(), 's.jsonl');
    // 10 prompts × 2.3M Hangul syllables: ~23M UTF-16 units, ~69 MB in UTF-8.
    const big = '가'.repeat(2_300_000);
    await fs.writeFile(f, Array.from({ length: 10 }, (_, i) => L({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: big } })).join('\n') + '\n');
    const out = await readTranscript(f);
    expect(out).toHaveLength(10);
    await flushTranscriptCache();
    expect(await fs.readdir(cache)).toEqual([]);
  }, 60_000);
});

describe('readTranscript — damaged snapshots are not trusted', () => {
  async function setup(): Promise<{ f: string; snap: string; lines: string[] }> {
    const f = path.join(await tmp(), 's.jsonl');
    const lines = records(80);
    await fs.writeFile(f, lines.slice(0, 50).join('\n') + '\n');
    const snap = await snapshotOf(await tmp(), f);
    await fs.appendFile(f, lines.slice(50).join('\n') + '\n');
    clearTranscriptCache();
    return { f, snap, lines };
  }

  it('headLen past offset (with a matching head hash) is rejected', async () => {
    const { f, snap } = await setup();
    const e = JSON.parse(await fs.readFile(snap, 'utf8'));
    const whole = await fs.readFile(f);
    e.headLen = whole.length; // beyond the offset
    e.headHash = sha1hex(whole);
    e.state.out = [];
    await fs.writeFile(snap, JSON.stringify(e));
    await same(f);
  });

  it('out entries without a kind are rejected', async () => {
    const { f, snap } = await setup();
    const e = JSON.parse(await fs.readFile(snap, 'utf8'));
    e.state.out = [null, { text: 'x' }];
    await fs.writeFile(snap, JSON.stringify(e));
    await same(f);
  });

  it('a snapshot that passes the checks but breaks the parser falls back to a full read', async () => {
    const f = path.join(await tmp(), 's.jsonl');
    const chunk = (c: unknown[]) => L({ type: 'assistant', message: { id: 'aX', model: 'm', role: 'assistant', content: c } });
    await fs.writeFile(f, L({ type: 'user', message: { role: 'user', content: 'go' } }) + '\n' + chunk([{ type: 'text', text: 'one' }]) + '\n');
    const snap = await snapshotOf(await tmp(), f);
    const e = JSON.parse(await fs.readFile(snap, 'utf8'));
    delete e.state.out.at(-1).toolCalls; // the next same-id chunk pushes into it
    await fs.writeFile(snap, JSON.stringify(e));
    clearTranscriptCache();
    await fs.appendFile(f, chunk([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]) + '\n');
    await same(f);
    // The broken snapshot was replaced: a restart resumes cleanly.
    await flushTranscriptCache();
    clearTranscriptCache();
    await same(f);
  });
});
