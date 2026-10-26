import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withFileRetry } from './fsRetry';

describe('withFileRetry', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });

  it('reads a file that appears during an atomic replace (ENOENT, then the file)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-retry-'));
    dirs.push(dir);
    const file = path.join(dir, 'index.html');
    setTimeout(() => { void fs.writeFile(file, 'ok'); }, 20);
    const fh = await withFileRetry(() => fs.open(file, 'r'), 5, 15);
    try {
      expect((await fh.readFile()).toString()).toBe('ok');
    } finally {
      await fh.close();
    }
  });

  it('does not retry a permission error', async () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const t = Date.now();
    await expect(withFileRetry(() => Promise.reject(err), 4, 50)).rejects.toBe(err);
    expect(Date.now() - t).toBeLessThan(40);
  });
});
