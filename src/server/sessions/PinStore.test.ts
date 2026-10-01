import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PinStore, isPinnableId } from './PinStore';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

async function tmpFile(): Promise<string> {
  return path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-pins-')), 'cfg', 'pins.json');
}

describe('PinStore (F2)', () => {
  it('starts empty, pins in order, unpins, dedupes, and persists (0600) across instances', async () => {
    const file = await tmpFile();
    const a = new PinStore(file);
    await a.load();
    expect(a.list()).toEqual([]);
    await a.set(ID1, true);
    await a.set(ID2, true);
    expect(await a.set(ID1, true)).toEqual([ID1, ID2]);
    const b = new PinStore(file);
    await b.load();
    expect(b.list()).toEqual([ID1, ID2]);
    expect(await b.set(ID1, false)).toEqual([ID2]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('ignores a corrupt or junk file', async () => {
    const file = await tmpFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify([ID1, 5, '../x', ID1, ID2]));
    const s = new PinStore(file);
    await s.load();
    expect(s.list()).toEqual([ID1, ID2]);
    await fs.writeFile(file, '{nope');
    await s.load();
    expect(s.list()).toEqual([]);
  });

  it('caps the number of pins', async () => {
    const s = new PinStore(await tmpFile(), 3);
    await s.load();
    for (const id of ['a1', 'a2', 'a3', 'a4']) await s.set(id, true);
    expect(s.list()).toEqual(['a2', 'a3', 'a4']);
  });

  it('isPinnableId accepts session/thread ids only', () => {
    expect(isPinnableId(ID1)).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'x'.repeat(200), 5, null]) expect(isPinnableId(bad)).toBe(false);
  });
});
