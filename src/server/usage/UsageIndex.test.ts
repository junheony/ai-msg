import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageIndex } from './UsageIndex';
import type { UsageRow } from '../../shared/token-usage';

let dir: string;
let roots: { a: string; b: string; c: string };
let codexRoot: string;
let indexFile: string;
const NOW = new Date('2026-10-02T12:00:00');
const TS = '2026-10-02T03:00:00.000Z';

function asst(id: string, usage: Partial<Record<string, number>>, opts: { model?: string; ts?: string } = {}): string {
  return JSON.stringify({ type: 'assistant', uuid: `u-${id}-${Math.random()}`, timestamp: opts.ts ?? TS, requestId: `req-${id}`, message: { id, model: opts.model ?? 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } } }) + '\n';
}
function tokenCount(total: number[], last: number[], ts = TS): string {
  const v = (a: number[]) => ({ input_tokens: a[0], cached_input_tokens: a[1], cache_write_input_tokens: a[2], output_tokens: a[3] });
  return JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: v(total), last_token_usage: v(last) } } }) + '\n';
}
const make = () => new UsageIndex({ projectsRoots: roots, codexSessionsRoot: codexRoot, indexFile, now: () => NOW });
const pick = (rows: UsageRow[], source: string) => rows.filter((r) => r.source === source).reduce((s, r) => ({ input: s.input + r.input, output: s.output + r.output, cacheRead: s.cacheRead + r.cacheRead, cacheWrite: s.cacheWrite + r.cacheWrite, messages: s.messages + r.messages }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-usage-idx-'));
  roots = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(path.join(r, '-proj'), { recursive: true });
  codexRoot = path.join(dir, 'codex', 'sessions');
  await fs.mkdir(path.join(codexRoot, '2026', '10', '02'), { recursive: true });
  indexFile = path.join(dir, 'cfg', 'usage-index.json');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('UsageIndex', () => {
  it('dedupes repeated lines of one message and counts subagent transcripts', async () => {
    const f = path.join(roots.a, '-proj', 's1.jsonl');
    await fs.writeFile(f, asst('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }) + asst('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }) + JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    await fs.mkdir(path.join(roots.a, '-proj', 's1', 'subagents'), { recursive: true });
    await fs.writeFile(path.join(roots.a, '-proj', 's1', 'subagents', 'agent-x.jsonl'), asst('m2', { input_tokens: 1, output_tokens: 2 }, { model: 'claude-sonnet-5-5' }));
    const idx = make();
    await idx.refresh();
    const h = idx.history(30);
    expect(pick(h.rows, 'a')).toEqual({ input: 11, output: 7, cacheRead: 100, cacheWrite: 20, messages: 2 });
    expect(h.rows.find((r) => r.source === 'a' && r.family === 'sonnet')?.output).toBe(2);
    expect(h.rows[0]!.day).toBe('2026-10-02');
  });

  it('reads only appended complete lines and survives a restart from the cache file', async () => {
    const f = path.join(roots.b, '-proj', 's.jsonl');
    const line2 = asst('m2', { output_tokens: 7 });
    await fs.writeFile(f, asst('m1', { output_tokens: 3 }) + line2.slice(0, 20)); // partial second line
    const idx = make();
    await idx.refresh();
    expect(pick(idx.history(30).rows, 'b').output).toBe(3);
    await fs.appendFile(f, line2.slice(20));
    await idx.refresh();
    expect(pick(idx.history(30).rows, 'b').output).toBe(10);

    // A fresh instance resumes from the saved offsets: appended bytes only, nothing counted twice.
    await fs.appendFile(f, asst('m3', { output_tokens: 100 }));
    const again = make();
    await again.refresh();
    expect(pick(again.history(30).rows, 'b')).toMatchObject({ output: 110, messages: 3 });
  });

  it('counts a message copied into two accounts once globally and once per account', async () => {
    const shared = asst('m1', { input_tokens: 5 }) + asst('m2', { input_tokens: 7 });
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'), shared);
    await fs.writeFile(path.join(roots.c, '-proj', 's.jsonl'), shared + asst('m3', { input_tokens: 1 }));
    const idx = make();
    await idx.refresh();
    const rows = idx.history(30).rows;
    expect(pick(rows, 'a').input).toBe(12);
    expect(pick(rows, 'c').input).toBe(13);
    expect(pick(rows, 'all').input).toBe(13);
  });

  it('turns Codex cumulative token_count into deltas, skips repeats, splits cached input', async () => {
    const f = path.join(codexRoot, '2026', '10', '02', 'rollout-x.jsonl');
    await fs.writeFile(f, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }) + '\n'
      + tokenCount([100, 40, 0, 10], [100, 40, 0, 10])
      + tokenCount([100, 40, 0, 10], [100, 40, 0, 10]) // repeated event
      + tokenCount([250, 140, 0, 30], [150, 100, 0, 20]));
    await fs.writeFile(path.join(codexRoot, '2026', '10', '02', 'other.jsonl'), tokenCount([999, 0, 0, 999], [999, 0, 0, 999]));
    const idx = make();
    await idx.refresh();
    const rows = idx.history(30).rows;
    expect(pick(rows, 'codex')).toEqual({ input: 110, output: 30, cacheRead: 140, cacheWrite: 0, messages: 2 });
    expect(rows.find((r) => r.source === 'codex')?.family).toBe('gpt');
    expect(pick(rows, 'all').output).toBe(30);
    await fs.appendFile(f, tokenCount([300, 140, 0, 35], [50, 0, 0, 5]));
    await idx.refresh();
    expect(pick(idx.history(30).rows, 'codex')).toMatchObject({ input: 160, output: 35, messages: 3 });
  });

  it('filters by day window and skips synthetic messages', async () => {
    await fs.writeFile(path.join(roots.a, '-proj', 's.jsonl'),
      asst('old', { output_tokens: 1 }, { ts: '2026-08-01T03:00:00Z' })
      + asst('syn', { output_tokens: 9 }, { model: '<synthetic>' })
      + asst('new', { output_tokens: 2 }));
    const idx = make();
    await idx.refresh();
    expect(pick(idx.history(7).rows, 'a').output).toBe(2);
    expect(pick(idx.history(90).rows, 'a').output).toBe(3);
    const saved = JSON.parse(await fs.readFile(indexFile, 'utf8')) as { version: number };
    expect(saved.version).toBe(1);
  });

  it('takes the max output_tokens of a message split over lines and scans, without double counting', async () => {
    const f = path.join(roots.a, '-proj', 's.jsonl');
    await fs.writeFile(f, asst('m1', { input_tokens: 10, output_tokens: 2 }) + asst('m1', { input_tokens: 10, output_tokens: 9 }));
    await fs.writeFile(path.join(roots.c, '-proj', 's.jsonl'), asst('m1', { input_tokens: 10, output_tokens: 2 }));
    const idx = make();
    await idx.refresh();
    expect(pick(idx.history(30).rows, 'a')).toMatchObject({ input: 10, output: 9, messages: 1 });
    expect(pick(idx.history(30).rows, 'c')).toMatchObject({ input: 10, output: 9, messages: 1 }); // a copy joins at the largest output known
    expect(pick(idx.history(30).rows, 'all')).toMatchObject({ input: 10, output: 9, messages: 1 });
    // A later line (next scan, after a restart) with the final count tops every counter up exactly once.
    await fs.appendFile(f, asst('m1', { input_tokens: 10, output_tokens: 15 }));
    const again = make();
    await again.refresh();
    await again.refresh();
    const rows = again.history(30).rows;
    expect(pick(rows, 'a')).toMatchObject({ output: 15, messages: 1 });
    expect(pick(rows, 'all')).toMatchObject({ input: 10, output: 15, messages: 1 });
    expect(pick(rows, 'c').output).toBe(15);
  });

  it('keeps the dedupe map out of the index JSON (append-only .seen log) and still dedupes after restart', async () => {
    const f = path.join(roots.a, '-proj', 's.jsonl');
    await fs.writeFile(f, asst('m1', { output_tokens: 4 }));
    await make().refresh();
    expect(JSON.parse(await fs.readFile(indexFile, 'utf8')).seen).toBeUndefined();
    expect(await fs.readFile(`${indexFile}.seen`, 'utf8')).toContain('m1\t');
    // The same message in a new file after restart: already seen.
    await fs.writeFile(path.join(roots.b, '-proj', 's.jsonl'), asst('m1', { output_tokens: 4 }));
    const again = make();
    await again.refresh();
    expect(pick(again.history(30).rows, 'all')).toMatchObject({ output: 4, messages: 1 });
  });
});
