import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearTranscriptCache, flushTranscriptCache, readTranscript, readTranscriptUncached, setTranscriptCacheDir } from './transcript';
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
