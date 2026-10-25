import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importStaticPrivate } from '../../shared/cloud/noise';
import { CloudState } from './CloudState';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'deck-cloud-state-'));
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe('CloudState', () => {
  it('creates the host key on load, writes 0600 on first update, moves a broken file aside', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'cloud', 'state.json');
    const s = await CloudState.load(dir);
    expect(s.get()).toMatchObject({ v: 2, hostId: null, hostToken: null, email: null, devices: [], pendingRevokes: [], plan: null });
    expect((await importStaticPrivate(s.get().hostKey)).publicRaw).toHaveLength(32);
    expect(await exists(path.join(dir, 'cloud'))).toBe(false); // nothing written until the first update

    await s.update({ hostId: 'h1', hostToken: 't1', email: 'a@example.test' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(dir, 'cloud'))).mode & 0o777).toBe(0o700);
    expect((await fs.readdir(path.join(dir, 'cloud'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const again = await CloudState.load(dir);
    expect(again.get()).toEqual(s.get()); // same key, same values

    await fs.writeFile(file, '{oops');
    const fresh = await CloudState.load(dir);
    expect(fresh.get().hostId).toBeNull();
    expect(fresh.get().hostKey).not.toBe(s.get().hostKey);
    const names = await fs.readdir(path.join(dir, 'cloud'));
    expect(names.some((n) => /^state\.json\.broken-\d+$/.test(n))).toBe(true);
    expect(names).not.toContain('state.json');
  });

  it('a file with another version is moved aside too', async () => {
    const dir = await tmp();
    await fs.mkdir(path.join(dir, 'cloud'));
    await fs.writeFile(path.join(dir, 'cloud', 'state.json'), JSON.stringify({ v: 1, hostId: 'old' }));
    const s = await CloudState.load(dir);
    expect(s.get().hostId).toBeNull();
    expect((await fs.readdir(path.join(dir, 'cloud'))).some((n) => n.startsWith('state.json.broken-'))).toBe(true);
  });

  it('removeDevice and reset (reset keeps the host key)', async () => {
    const dir = await tmp();
    const s = await CloudState.load(dir);
    const key = s.get().hostKey;
    await s.update({ hostId: 'h', hostToken: 't', email: 'e@example.test', devices: [{ id: 'd1', name: 'phone', pub: 'p', addedAt: 1 }], pendingRevokes: ['d0'] });
    expect(await s.removeDevice('nope')).toBe(false);
    expect(await s.removeDevice('d1')).toBe(true);
    expect((await CloudState.load(dir)).get().devices).toEqual([]);
    await s.reset();
    expect(s.get()).toEqual({ v: 2, hostId: null, hostToken: null, email: null, hostKey: key, devices: [], pendingRevokes: [], plan: null });
    expect((await CloudState.load(dir)).get()).toEqual(s.get());
  });

  it('concurrent updates are written in order', async () => {
    const dir = await tmp();
    const s = await CloudState.load(dir);
    await Promise.all([s.update({ hostId: 'a' }), s.update({ email: 'b@example.test' }), s.update({ hostToken: 'c' })]);
    expect((await CloudState.load(dir)).get()).toMatchObject({ hostId: 'a', email: 'b@example.test', hostToken: 'c' });
  });
});
