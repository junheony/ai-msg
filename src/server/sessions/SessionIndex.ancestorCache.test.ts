import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AncestorCache } from './SessionIndex';
import { ancestorInfo, isAncestor } from './SessionMover';

const conv = (id: string) => `${JSON.stringify({ uuid: id, type: 'user', message: { content: `m-${id}` } })}\n`;
const meta = (k: string) => `${JSON.stringify({ type: 'artifact-autoreact-ledger', k })}\n`;

let dir: string;
let x: string;
let y: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ancestor-cache-'));
  x = path.join(dir, 'x.jsonl');
  y = path.join(dir, 'y.jsonl');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// A distinct mtime per write: a same-size rewrite within one clock tick is invisible to any stamp cache.
let tick = 1_700_000_000;
async function touch(file: string): Promise<void> {
  tick += 7;
  await fs.utimes(file, tick, tick);
}
async function write(file: string, s: string): Promise<void> {
  await fs.writeFile(file, s);
  await touch(file);
}
async function append(file: string, s: string): Promise<void> {
  await fs.appendFile(file, s);
  await touch(file);
}
async function replace(file: string, s: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, s);
  await fs.rename(tmp, file);
  await touch(file);
}

function setup() {
  const full = vi.fn(ancestorInfo);
  return { cache: new AncestorCache(full), full };
}

async function expectBoth(cache: AncestorCache): Promise<void> {
  expect(await cache.isAncestor(x, y)).toBe(await isAncestor(x, y));
  expect(await cache.isAncestor(y, x)).toBe(await isAncestor(y, x));
}

const base = Array.from({ length: 60 }, (_, i) => conv(`b${i}`)).join(''); // > 4KB

describe('AncestorCache', () => {
  it('old copy unchanged, live copy appended-to: answers without a full re-read', async () => {
    await write(x, base);
    await write(y, base + conv('n1'));
    const { cache, full } = setup();
    expect(await cache.isAncestor(x, y)).toBe(true);
    expect(await cache.isAncestor(y, x)).toBe(false);
    expect(full).toHaveBeenCalledTimes(2);
    await append(y, conv('n2') + meta('a') + conv('n3'));
    expect(await cache.isAncestor(x, y)).toBe(true);
    expect(await cache.isAncestor(y, x)).toBe(false);
    expect(full).toHaveBeenCalledTimes(2);
    await expectBoth(cache);
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('unchanged pair: cached', async () => {
    await write(x, base);
    await write(y, base + conv('n1'));
    const { cache, full } = setup();
    await cache.isAncestor(x, y);
    await cache.isAncestor(x, y);
    expect(full).toHaveBeenCalledTimes(1);
  });

  it('diverged copies both appended-to: stays not-an-ancestor without a re-read', async () => {
    await write(x, base + conv('x1'));
    await write(y, base + conv('y1'));
    const { cache, full } = setup();
    expect(await cache.isAncestor(x, y)).toBe(false);
    await append(x, conv('x2'));
    await append(y, conv('y2'));
    expect(await cache.isAncestor(x, y)).toBe(false);
    expect(full).toHaveBeenCalledTimes(1);
  });

  it('middle byte changed (same size): recomputes', async () => {
    await write(x, base);
    await write(y, base + conv('n1'));
    const { cache, full } = setup();
    expect(await cache.isAncestor(x, y)).toBe(true);
    const buf = await fs.readFile(y);
    buf[100] = buf[100] === 0x41 ? 0x42 : 0x41;
    await write(y, buf.toString('latin1'));
    expect(await cache.isAncestor(x, y)).toBe(await isAncestor(x, y));
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('bytes changed within the last 4KB before the old end, plus an append: recomputes', async () => {
    await write(x, base);
    await write(y, base + conv('n1'));
    const { cache, full } = setup();
    expect(await cache.isAncestor(x, y)).toBe(true);
    const s = await fs.readFile(y, 'utf8');
    const i = s.length - 200;
    await write(y, s.slice(0, i) + (s[i] === 'Z' ? 'Y' : 'Z') + s.slice(i + 1) + conv('n2'));
    expect(await cache.isAncestor(x, y)).toBe(false);
    expect(await isAncestor(x, y)).toBe(false);
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('truncated: recomputes', async () => {
    await write(x, base);
    await write(y, base + conv('n1'));
    const { cache, full } = setup();
    expect(await cache.isAncestor(x, y)).toBe(true);
    await fs.truncate(y, 1000);
    await touch(y);
    expect(await cache.isAncestor(x, y)).toBe(false);
    expect(await isAncestor(x, y)).toBe(false);
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('replaced by rename (new inode), larger: recomputes', async () => {
    await write(x, base);
    await write(y, base + conv('n1'));
    const { cache, full } = setup();
    expect(await cache.isAncestor(x, y)).toBe(true);
    await replace(y, conv('other') + base + conv('n1') + conv('n2'));
    expect(await cache.isAncestor(x, y)).toBe(false);
    expect(await isAncestor(x, y)).toBe(false);
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('metadata lines appended to the older copy: recomputes (and becomes or stays an ancestor)', async () => {
    await write(x, base);
    await write(y, base + conv('n1'));
    const { cache, full } = setup();
    expect(await cache.isAncestor(x, y)).toBe(true);
    await append(x, meta('a') + meta('b'));
    expect(await cache.isAncestor(x, y)).toBe(true);
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('conversation line appended to the older copy: recomputes to not-an-ancestor', async () => {
    await write(x, base);
    await write(y, base + conv('n1'));
    const { cache, full } = setup();
    expect(await cache.isAncestor(x, y)).toBe(true);
    await append(x, conv('x1'));
    expect(await cache.isAncestor(x, y)).toBe(false);
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('unfinished last line later completed as metadata: recomputes to an ancestor', async () => {
    await write(x, base + '{"type":"led');
    await write(y, base + conv('n1'));
    const { cache, full } = setup();
    expect(await cache.isAncestor(x, y)).toBe(false);
    await append(x, 'ger"}\n');
    await append(y, conv('n2'));
    expect(await cache.isAncestor(x, y)).toBe(true);
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('shorter copy (prefix of the other) appended-to with the missing bytes: stays an ancestor', async () => {
    // x = base + meta, y = base: x is an ancestor (tail = metadata); n = |y| = y's old end.
    await write(x, base + meta('m'));
    await write(y, base);
    const { cache } = setup();
    expect(await cache.isAncestor(x, y)).toBe(true);
    await append(y, meta('m') + conv('n1'));
    await expectBoth(cache);
  });

  it('property: incremental answer == fresh answer over random append/rewrite scenarios', async () => {
    let seed = 12345;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % k;
    };
    const piece = (tag: string): string => {
      switch (rnd(5)) {
        case 0: case 1: return conv(`${tag}${rnd(1000)}`);
        case 2: return meta(`${tag}${rnd(1000)}`);
        case 3: return '{"type":"part';
        default: return '"}\n';
      }
    };
    let calls = 0;
    let fulls = 0;
    for (let scenario = 0; scenario < 40; scenario++) {
      const head = rnd(2) ? base : conv('h0');
      let sx = head;
      let sy = head;
      for (let i = rnd(3); i > 0; i--) sx += piece('x');
      for (let i = rnd(3); i > 0; i--) sy += piece('y');
      if (rnd(3) === 0) sy = sx + sy.slice(head.length);
      await write(x, sx);
      await write(y, sy);
      const { cache, full } = setup();
      await expectBoth(cache);
      calls += 2;
      for (let step = 0; step < 8; step++) {
        const file = rnd(2) ? x : y;
        const op = rnd(10);
        if (op < 6) {
          await append(file, piece('a'));
        } else if (op === 6) {
          const buf = await fs.readFile(file);
          if (buf.length) {
            const at = rnd(buf.length);
            buf[at] = buf[at] === 0x61 ? 0x62 : 0x61;
            await fs.writeFile(file, buf);
            await touch(file);
          }
        } else if (op === 7) {
          const st = await fs.stat(file);
          await fs.truncate(file, rnd(st.size + 1));
          await touch(file);
        } else if (op === 8) {
          const other = file === x ? y : x;
          await replace(file, (await fs.readFile(other, 'utf8')) + piece('r'));
        } else {
          await touch(file);
        }
        await expectBoth(cache);
        calls += 2;
      }
      fulls += full.mock.calls.length;
    }
    // The incremental path was taken (the comparison above is not vacuous).
    expect(fulls).toBeLessThan(calls * 0.8);
  }, 60_000);
});
