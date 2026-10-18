import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectEditPaths, editAutoAllowed, isEditDenied } from './grokEditPaths';

let tmp: string;
let home: string;
let cwd: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-editpaths-')));
  home = path.join(tmp, 'home');
  cwd = path.join(home, 'proj');
  await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'src', 'a.ts'), 'x');
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const write = (file: string) => ({ toolCallId: 'c', kind: 'edit', locations: [{ path: file }], rawInput: { variant: 'Write', file_path: file, content: 'hi' } });
const allowed = (toolCall: Record<string, unknown>, c = cwd) => editAutoAllowed({ cwd: c, home, toolCall });

describe('editAutoAllowed', () => {
  it('inside the cwd (existing or new file): automatic', async () => {
    expect(await allowed(write(path.join(cwd, 'src', 'a.ts')))).toBe(true);
    expect(await allowed(write(path.join(cwd, 'src', 'new', 'deep', 'b.ts')))).toBe(true);
    expect(await allowed(write('src/rel.ts'))).toBe(true);
  });

  it('outside the cwd, a symlink escape, no path, or an unreadable path: card', async () => {
    expect(await allowed(write(path.join(home, 'other.txt')))).toBe(false);
    expect(await allowed(write(path.join(cwd, '..', 'proj2', 'x')))).toBe(false);
    await fs.symlink(tmp, path.join(cwd, 'link'));
    expect(await allowed(write(path.join(cwd, 'link', 'escape.txt')))).toBe(false);
    expect(await allowed({ toolCallId: 'c', kind: 'edit' })).toBe(false);
    expect(await allowed({ toolCallId: 'c', kind: 'edit', locations: [{}] })).toBe(false);
    expect(await allowed({ toolCallId: 'c', kind: 'edit', rawInput: { file_path: 42 } })).toBe(false);
  });

  it('deny list (case- and NFC-folded): card', async () => {
    for (const rel of ['.git/hooks/pre-commit', '.GIT/config', '.gitmodules', '.envrc', '.env', '.env.local', '.claude/settings.json', '.grok/config.toml', '.mcp.json', '.vscode/tasks.json', '.idea/x.xml', '.husky/pre-push', '.githooks/x', 'node_modules/.bin/tsc', 'sub/.git/config']) {
      expect(await allowed(write(path.join(cwd, rel))), rel).toBe(false);
    }
    expect(isEditDenied('node_modules/pkg/index.js')).toBe(false);
    expect(isEditDenied('docs/env.md')).toBe(false);
  });

  it('.cursor/ (Cursor hooks, MCP, rules): card', async () => {
    for (const rel of ['.cursor/hooks.json', '.cursor/mcp.json', '.Cursor/rules/a.mdc', 'sub/.cursor/x']) {
      expect(await allowed(write(path.join(cwd, rel))), rel).toBe(false);
    }
  });

  it('a path starting with ~, holding $, or of a scheme: form (file:, a drive letter): card', async () => {
    for (const p of ['~/x.txt', '~', '~other/x', 'src/$HOME/x', '$PWD/src/a.ts', 'src/${X}', `file://${path.join(cwd, 'src', 'a.ts')}`, 'file:src/a.ts', 'http://x/y', 'C:\\x.txt', 'c:x']) {
      expect(await allowed(write(p)), p).toBe(false);
    }
    // Only at the start: a ~ or a colon later in a file name is an ordinary name.
    expect(await allowed(write('src/a~b.ts'))).toBe(true);
  });

  it('a symlink inside the cwd pointing into a denied folder: card', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    await fs.symlink(path.join(cwd, '.git'), path.join(cwd, 'g'));
    expect(await allowed(write(path.join(cwd, 'g', 'config')))).toBe(false);
  });

  it('a hard-linked existing file (nlink > 1): card', async () => {
    await fs.link(path.join(cwd, 'src', 'a.ts'), path.join(cwd, 'src', 'b.ts'));
    expect(await allowed(write(path.join(cwd, 'src', 'a.ts')))).toBe(false);
  });

  it('cwd = HOME, an ancestor of HOME, or /: edit auto off', async () => {
    expect(await allowed(write(path.join(home, 'x.txt')), home)).toBe(false);
    expect(await allowed(write(path.join(home, 'x.txt')), tmp)).toBe(false);
    expect(await allowed(write('/tmp/x'), '/')).toBe(false);
  });

  it('every path counts: a move with one end outside, a patch with one file outside', async () => {
    expect(await allowed({ kind: 'edit', rawInput: { from: path.join(cwd, 'src', 'a.ts'), to: path.join(home, 'a.ts') } })).toBe(false);
    const patch = `*** Begin Patch\n*** Update File: ${path.join(cwd, 'src', 'a.ts')}\n@@\n-x\n+y\n*** Add File: ${path.join(home, 'evil.sh')}\n+echo\n*** End Patch\n`;
    expect(await allowed({ kind: 'edit', rawInput: { patch } })).toBe(false);
    const ok = `*** Begin Patch\n*** Update File: ${path.join(cwd, 'src', 'a.ts')}\n@@\n-x\n+y\n*** End Patch\n`;
    expect(await allowed({ kind: 'edit', rawInput: { patch: ok } })).toBe(true);
  });
});

describe('collectEditPaths', () => {
  it('reads locations, diff content, rawInput fields and patch files once each', () => {
    expect(collectEditPaths({
      locations: [{ path: '/w/a' }],
      content: [{ type: 'diff', path: '/w/a', oldText: '', newText: 'x' }],
      rawInput: { variant: 'SearchReplace', file_path: '/w/a', edits: [{ file_path: '/w/b' }], patch: '*** Move to: /w/c\n' },
    })).toEqual(['/w/a', '/w/b', '/w/c']);
  });

  it('nesting deeper than it reads: unreadable (null), not silently skipped', () => {
    const deep = { edits: [{ edits: [{ edits: [{ file_path: '/elsewhere/x' }] }] }] };
    expect(collectEditPaths({ locations: [{ path: '/w/a' }], rawInput: deep })).toBeNull();
    expect(collectEditPaths({ locations: [{ path: '/w/a' }], rawInput: { edits: [{ file_path: '/w/a' }] } })).toEqual(['/w/a']);
  });
});
