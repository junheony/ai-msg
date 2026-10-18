import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findGrokProjectConfig } from './grokProjectGuard';

let tmp: string;
let home: string;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-grok-guard-')));
  home = path.join(tmp, 'home');
  await fs.mkdir(home);
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const mk = (...p: string[]) => fs.mkdir(path.join(home, ...p), { recursive: true });
const at = (...p: string[]) => path.join(home, ...p);
const find = (cwd: string, trusted: string | null = null) => findGrokProjectConfig(cwd, trusted, home);

describe('findGrokProjectConfig (S9 결과 전까지 넓게 막음)', () => {
  it('none: a plain folder', async () => {
    await mk('w');
    expect(await find(at('w'))).toBeNull();
  });

  it('cwd/.grok blocks', async () => {
    await mk('w', '.grok');
    expect(await find(at('w'))).toBe(at('w', '.grok'));
  });

  it('a .cursor/ (Cursor hooks, MCP, rules Grok reads through external compat) blocks too, in cwd or a parent; GROK_HOME trust does not cover it', async () => {
    await mk('w', 'sub');
    await mk('w', '.cursor');
    expect(await find(at('w', 'sub'))).toBe(at('w', '.cursor'));
    await mk('v');
    await fs.writeFile(at('v', '.cursor'), '');
    expect(await find(at('v'), at('v', '.cursor'))).toBe(at('v', '.cursor'));
  });

  it('every parent up to the folder directly under home is checked, past a git root', async () => {
    await mk('top', 'repo', '.git');
    await mk('top', 'repo', 'a', 'b');
    expect(await find(at('top', 'repo', 'a', 'b'))).toBeNull();
    await mk('top', '.grok'); // above the git root, directly under home: in range
    expect(await find(at('top', 'repo', 'a', 'b'))).toBe(at('top', '.grok'));
  });

  it("home's own .grok is out of range for a cwd under home (and subfolders are never checked)", async () => {
    await mk('.grok');
    await mk('w', 'sub', '.grok');
    expect(await find(at('w'))).toBeNull();
  });

  it('outside home the walk goes on up (to the filesystem root)', async () => {
    const outside = path.join(tmp, 'elsewhere', 'deep', 'er');
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(path.join(tmp, '.grok'));
    expect(await find(outside)).toBe(path.join(tmp, '.grok'));
  });

  it('paths are realpath: a symlinked cwd is checked where it really is', async () => {
    await mk('real', '.grok');
    await fs.symlink(at('real'), at('link'));
    expect(await find(at('link'))).toBe(at('real', '.grok'));
  });

  it("the seat's own GROK_HOME is not project config (cwd = home); any other .grok on the way still is", async () => {
    await mk('.grok');
    expect(await find(home, at('.grok'))).toBeNull();
    expect(await find(home)).toBe(at('.grok'));
    await mk('w', '.grok');
    expect(await find(at('w'), at('.grok'))).toBe(at('w', '.grok'));
  });

  it('a .grok file (not a directory) blocks too, and so does a dangling symlink', async () => {
    await mk('w');
    await fs.writeFile(at('w', '.grok'), '');
    expect(await find(at('w'))).toBe(at('w', '.grok'));
    await mk('v');
    await fs.symlink(at('nowhere'), at('v', '.grok'));
    expect(await find(at('v'))).toBe(at('v', '.grok'));
  });
});
