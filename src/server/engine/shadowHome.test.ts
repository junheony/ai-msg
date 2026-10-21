import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROK_SHADOW_LINKS, ShadowHomeError, createShadowHome, sweepShadowHomes } from './shadowHome';

let tmp: string;
let realHome: string;
let root: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-shadow-')));
  realHome = path.join(tmp, 'home');
  root = path.join(tmp, 'config', 'homes', 'grok');
  await fs.mkdir(path.join(realHome, '.config', 'git'), { recursive: true });
  await fs.mkdir(path.join(realHome, '.ssh'), { recursive: true });
  await fs.mkdir(path.join(realHome, '.claude'), { recursive: true });
  await fs.mkdir(path.join(realHome, 'Library'), { recursive: true });
  await fs.writeFile(path.join(realHome, '.claude', 'settings.json'), '{"permissions":{"defaultMode":"auto"}}');
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('createShadowHome', () => {
  it('links only the allow-list entries the real HOME has; nothing else (no .claude, no Library)', async () => {
    const h = await createShadowHome({ root, realHome, links: GROK_SHADOW_LINKS, id: 't1' });
    expect(h.path).toBe(path.join(root, 't1'));
    expect((await fs.lstat(h.path)).mode & 0o777).toBe(0o700);
    expect((await fs.readdir(h.path)).sort()).toEqual(['.config', '.ssh']);
    expect(await fs.readdir(path.join(h.path, '.config'))).toEqual(['git']);
    expect(await fs.readlink(path.join(h.path, '.ssh'))).toBe(path.join(realHome, '.ssh'));
    expect(await fs.readlink(path.join(h.path, '.config', 'git'))).toBe(path.join(realHome, '.config', 'git'));
    // .gitconfig is missing in the real HOME: not created.
    await expect(fs.lstat(path.join(h.path, '.gitconfig'))).rejects.toThrow();
    for (const d of [root, path.dirname(root)]) expect((await fs.lstat(d)).mode & 0o777).toBe(0o700);
  });

  it('a fresh folder per turn; remove() deletes links only, never their targets', async () => {
    await fs.writeFile(path.join(realHome, '.gitconfig'), '[user]\n');
    const a = await createShadowHome({ root, realHome, links: GROK_SHADOW_LINKS });
    const b = await createShadowHome({ root, realHome, links: GROK_SHADOW_LINKS });
    expect(a.path).not.toBe(b.path);
    await fs.mkdir(path.join(a.path, '.claude'));
    await a.remove();
    await a.remove();
    await expect(fs.lstat(a.path)).rejects.toThrow();
    expect(await fs.readFile(path.join(realHome, '.gitconfig'), 'utf8')).toBe('[user]\n');
    expect((await fs.readdir(path.join(realHome, '.ssh')))).toEqual([]);
    await b.remove();
  });

  it('two turns creating at once (fresh root) do not collide: both succeed with their own folder and links', async () => {
    const [a, b] = await Promise.all([
      createShadowHome({ root, realHome, links: GROK_SHADOW_LINKS }),
      createShadowHome({ root, realHome, links: GROK_SHADOW_LINKS }),
    ]);
    expect(a.path).not.toBe(b.path);
    for (const h of [a, b]) expect((await fs.readdir(h.path)).sort()).toEqual(['.config', '.ssh']);
    await a.remove();
    expect((await fs.readdir(b.path)).sort()).toEqual(['.config', '.ssh']);
    await b.remove();
  });

  it('refuses forbidden or escaping link entries', async () => {
    for (const bad of ['.claude', '.claude/settings.json', 'Library', '.config', '.config/deck', '../x', '/etc', '.cursor', '.cursor/hooks.json']) {
      await expect(createShadowHome({ root, realHome, links: [bad] })).rejects.toBeInstanceOf(ShadowHomeError);
    }
    // Nothing is left behind by a refused create.
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('a symlinked root (or parent) is refused', async () => {
    const elsewhere = path.join(tmp, 'elsewhere');
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.mkdir(path.join(tmp, 'config', 'homes'), { recursive: true, mode: 0o700 });
    await fs.symlink(elsewhere, root);
    await expect(createShadowHome({ root, realHome, links: GROK_SHADOW_LINKS })).rejects.toBeInstanceOf(ShadowHomeError);
    const root2 = path.join(tmp, 'config2', 'homes', 'grok');
    await fs.mkdir(path.join(tmp, 'config2'), { recursive: true });
    await fs.symlink(elsewhere, path.join(tmp, 'config2', 'homes'));
    await expect(createShadowHome({ root: root2, realHome, links: GROK_SHADOW_LINKS })).rejects.toBeInstanceOf(ShadowHomeError);
  });

  it('a loose root mode is tightened to 0700', async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.chmod(root, 0o755);
    const h = await createShadowHome({ root, realHome, links: [] });
    expect((await fs.lstat(root)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(h.path)).toEqual([]);
  });

  it('a bad id is refused', async () => {
    await expect(createShadowHome({ root, realHome, links: [], id: '../x' })).rejects.toBeInstanceOf(ShadowHomeError);
  });
});

describe('sweepShadowHomes', () => {
  it('server.ts (startServer) waits for the start-up sweep before any Grok turn can make a folder (no sweep racing a live turn)', async () => {
    const main = await fs.readFile(path.join(__dirname, '..', 'server.ts'), 'utf8');
    expect(main).toMatch(/await sweepShadowHomes\(grokHomesDir\)/);
    expect(main).not.toMatch(/void sweepShadowHomes\(/);
  });

  it('removes leftover turn folders; a missing root is fine', async () => {
    expect(await sweepShadowHomes(root)).toBe(0);
    await createShadowHome({ root, realHome, links: GROK_SHADOW_LINKS, id: 'left1' });
    await createShadowHome({ root, realHome, links: GROK_SHADOW_LINKS, id: 'left2' });
    expect(await sweepShadowHomes(root)).toBe(2);
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(path.join(realHome, '.ssh'))).toEqual([]);
  });
});
