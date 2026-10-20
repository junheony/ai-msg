import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore, MemoryTooLarge } from './MemoryStore';

async function tmp(): Promise<string> {
  return path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-memory-')), 'memory.md');
}

describe('MemoryStore', () => {
  it('starts empty without a file; set persists (0600) and a fresh store reads it back', async () => {
    const file = await tmp();
    const s = new MemoryStore(file);
    await s.load();
    expect(s.get()).toBe('');
    expect(await s.set('답은 한국어로\r\n  ')).toBe('답은 한국어로');
    expect(await fs.readFile(file, 'utf8')).toBe('답은 한국어로\n');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const again = new MemoryStore(file);
    await again.load();
    expect(again.get()).toBe('답은 한국어로');
    expect(await again.set('')).toBe('');
    expect(await fs.readFile(file, 'utf8')).toBe('');
  });
  it('refuses a note over the cap and keeps the old one', async () => {
    const file = await tmp();
    const s = new MemoryStore(file, 10);
    await s.load();
    await s.set('짧음');
    await expect(s.set('가나다라')).rejects.toBeInstanceOf(MemoryTooLarge); // 12 bytes
    expect(s.get()).toBe('짧음');
  });
  it('a hand-edited file past the cap is cut on a character boundary', async () => {
    const file = await tmp();
    await fs.writeFile(file, '가나다라마');
    const s = new MemoryStore(file, 10);
    await s.load();
    expect(s.get()).toBe('가나다');
  });
});
