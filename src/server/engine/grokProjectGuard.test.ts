import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findGrokProjectConfig } from './grokProjectGuard';

let tmp: string;
beforeEach(async () => { tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-grok-guard-'))); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const mk = (...p: string[]) => fs.mkdir(path.join(tmp, ...p), { recursive: true });

describe('findGrokProjectConfig', () => {
  it('none: a plain folder outside git', async () => {
    await mk('w');
    expect(await findGrokProjectConfig(path.join(tmp, 'w'))).toBeNull();
  });

  it('cwd/.grok blocks', async () => {
    await mk('w', '.grok');
    expect(await findGrokProjectConfig(path.join(tmp, 'w'))).toBe(path.join(tmp, 'w', '.grok'));
  });

  it('outside git only cwd is checked (a parent .grok does not count)', async () => {
    await mk('.grok');
    await mk('w');
    expect(await findGrokProjectConfig(path.join(tmp, 'w'))).toBeNull();
  });

  it('inside git: every folder up to the root, root included; nothing above it', async () => {
    await mk('repo', '.git');
    await mk('repo', 'a', 'b');
    await mk('.grok'); // above the repo: out of range
    expect(await findGrokProjectConfig(path.join(tmp, 'repo', 'a', 'b'))).toBeNull();
    await mk('repo', 'a', '.grok');
    expect(await findGrokProjectConfig(path.join(tmp, 'repo', 'a', 'b'))).toBe(path.join(tmp, 'repo', 'a', '.grok'));
    await fs.rm(path.join(tmp, 'repo', 'a', '.grok'), { recursive: true });
    await mk('repo', '.grok');
    expect(await findGrokProjectConfig(path.join(tmp, 'repo', 'a', 'b'))).toBe(path.join(tmp, 'repo', '.grok'));
  });

  it('a worktree-style .git file marks the root too', async () => {
    await mk('wt', 'sub');
    await fs.writeFile(path.join(tmp, 'wt', '.git'), 'gitdir: elsewhere\n');
    await mk('wt', '.grok');
    expect(await findGrokProjectConfig(path.join(tmp, 'wt', 'sub'))).toBe(path.join(tmp, 'wt', '.grok'));
  });

  it('paths are realpath: a symlinked cwd is checked where it really is', async () => {
    await mk('real', '.grok');
    await fs.symlink(path.join(tmp, 'real'), path.join(tmp, 'link'));
    expect(await findGrokProjectConfig(path.join(tmp, 'link'))).toBe(path.join(tmp, 'real', '.grok'));
  });

  it("the seat's own GROK_HOME is not project config (cwd = home)", async () => {
    await mk('home', '.grok');
    const home = path.join(tmp, 'home');
    expect(await findGrokProjectConfig(home, path.join(home, '.grok'))).toBeNull();
    expect(await findGrokProjectConfig(home)).toBe(path.join(home, '.grok'));
  });

  it('a .grok file (not a directory) does not block', async () => {
    await mk('w');
    await fs.writeFile(path.join(tmp, 'w', '.grok'), '');
    expect(await findGrokProjectConfig(path.join(tmp, 'w'))).toBeNull();
  });
});
