import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionIconStore, SessionIconsFullError } from './SessionIconStore';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

async function tmpFile(): Promise<string> {
  return path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-icons-')), 'cfg', 'session-icons.json');
}

describe('SessionIconStore', () => {
  it('starts empty, sets, replaces, deletes, and persists across instances', async () => {
    const file = await tmpFile();
    const a = new SessionIconStore(file);
    await a.load();
    expect(a.list()).toEqual({});
    await a.set(ID1, '🚀');
    await a.set(ID2, 'glyph:leaf');
    await a.set(ID1, '🐛');
    expect(a.list()).toEqual({ [ID1]: '🐛', [ID2]: 'glyph:leaf' });
    const b = new SessionIconStore(file);
    await b.load();
    expect(b.list()).toEqual({ [ID1]: '🐛', [ID2]: 'glyph:leaf' });
    await b.set(ID1, null);
    expect(b.list()).toEqual({ [ID2]: 'glyph:leaf' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ [ID2]: 'glyph:leaf' });
  });

  it('an unchanged set returns the same map (no write, no broadcast)', async () => {
    const a = new SessionIconStore(await tmpFile());
    await a.load();
    const m = await a.set(ID1, '🚀');
    expect(await a.set(ID1, '🚀')).toBe(m);
    expect(await a.set(ID2, null)).toBe(m);
  });

  it('at the cap a new entry throws (nothing written); a replace or a delete still goes', async () => {
    const file = await tmpFile();
    const a = new SessionIconStore(file, 1);
    await a.load();
    await a.set(ID1, '🚀');
    await expect(a.set(ID2, '🐛')).rejects.toBeInstanceOf(SessionIconsFullError);
    expect(a.list()).toEqual({ [ID1]: '🚀' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ [ID1]: '🚀' });
    await a.set(ID1, '🐛');
    await a.set(ID1, null);
    await a.set(ID2, '🐛');
    expect(a.list()).toEqual({ [ID2]: '🐛' });
  });

  it('drops entries that are not allowed on load, and moves a corrupt file aside', async () => {
    const file = await tmpFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ [ID1]: '🚀', [ID2]: 'glyph:nope', '../x': '🐛' }));
    const a = new SessionIconStore(file);
    await a.load();
    expect(a.list()).toEqual({ [ID1]: '🚀' });
    await fs.writeFile(file, '{bad');
    const b = new SessionIconStore(file);
    await b.load();
    expect(b.list()).toEqual({});
    await expect(fs.stat(`${file}.bad`)).resolves.toBeTruthy();
  });
});
