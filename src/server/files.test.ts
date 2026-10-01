import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DirError } from './dirs';
import { FileLister } from './files';

async function home(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-files-')));
}

describe('FileLister', () => {
  it('walks a non-git folder: relative paths, hidden and node_modules skipped', async () => {
    const h = await home();
    const p = path.join(h, 'proj');
    await fs.mkdir(path.join(p, 'src', 'deep'), { recursive: true });
    await fs.mkdir(path.join(p, 'node_modules', 'x'), { recursive: true });
    await fs.mkdir(path.join(p, '.hidden'), { recursive: true });
    await fs.writeFile(path.join(p, 'a.txt'), '');
    await fs.writeFile(path.join(p, 'src', 'b.ts'), '');
    await fs.writeFile(path.join(p, 'src', 'deep', 'c.ts'), '');
    await fs.writeFile(path.join(p, 'node_modules', 'x', 'i.js'), '');
    await fs.writeFile(path.join(p, '.hidden', 'h'), '');
    await fs.writeFile(path.join(p, '.env'), '');
    const r = await new FileLister({ home: h, roots: [h] }).list(p);
    expect(r.git).toBe(false);
    expect(r.cwd).toBe(p);
    expect(r.files.sort()).toEqual(['a.txt', 'src/b.ts', 'src/deep/c.ts']);
  });

  it('inside a git repo uses git ls-files (respects .gitignore, includes untracked)', async () => {
    const h = await home();
    const p = path.join(h, 'repo');
    await fs.mkdir(path.join(p, 'out'), { recursive: true });
    execFileSync('git', ['init', '-q', p]);
    await fs.writeFile(path.join(p, '.gitignore'), 'out/\n*.log\n');
    await fs.writeFile(path.join(p, 'keep.ts'), '');
    await fs.writeFile(path.join(p, 'x.log'), '');
    await fs.writeFile(path.join(p, 'out', 'gen.js'), '');
    const r = await new FileLister({ home: h, roots: [h] }).list(p);
    expect(r.git).toBe(true);
    expect(r.files.sort()).toEqual(['.gitignore', 'keep.ts']);
  });

  it('caps the listing', async () => {
    const h = await home();
    for (let i = 0; i < 12; i++) await fs.writeFile(path.join(h, `f${i}`), '');
    const r = await new FileLister({ home: h, roots: [h], max: 5 }).list(h);
    expect(r.files).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });

  it('refuses folders outside the roots, relative paths, and symlinks pointing out', async () => {
    const h = await home();
    const outside = await home();
    await fs.symlink(outside, path.join(h, 'link'));
    const lister = new FileLister({ home: h, roots: [h] });
    await expect(lister.list(outside)).rejects.toBeInstanceOf(DirError);
    await expect(lister.list('relative/path')).rejects.toBeInstanceOf(DirError);
    await expect(lister.list(path.join(h, 'link'))).rejects.toBeInstanceOf(DirError);
    await expect(lister.list(`${h}/../`)).rejects.toBeInstanceOf(DirError);
  });
});
