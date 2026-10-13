import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DirError } from './dirs';
import { FileLister, FileReadError, isDeniedPath, openSessionFileRaw, rawContentType, readSessionFile, revealSessionPath } from './files';

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

describe('readSessionFile', () => {
  async function setup() {
    const h = await home();
    const p = path.join(h, 'proj');
    await fs.mkdir(path.join(p, 'src'), { recursive: true });
    await fs.writeFile(path.join(p, 'src', 'a.ts'), 'export const a = 1;\n');
    return { h, p, read: (file: string, cwd = p, max?: number) => readSessionFile({ home: h, roots: [h], cwd, file, ...(max ? { max } : {}) }) };
  }
  const status = async (pr: Promise<unknown>) => { try { await pr; return 200; } catch (e) { if (e instanceof FileReadError) return e.status; if (e instanceof DirError) return 400; throw e; } };

  it('reads text by relative or absolute path inside the cwd', async () => {
    const { p, read } = await setup();
    expect(await read('src/a.ts')).toEqual({ path: path.join(p, 'src', 'a.ts'), size: 20, kind: 'text', text: 'export const a = 1;\n' });
    expect((await read(path.join(p, 'src', 'a.ts'))).kind).toBe('text');
  });

  it('refuses traversal, absolute paths outside the cwd, and symlinks escaping it', async () => {
    const { h, p, read } = await setup();
    const outside = await home();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
    await fs.writeFile(path.join(h, 'sibling.txt'), 'x');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(p, 'link.txt'));
    await fs.symlink(outside, path.join(p, 'linkdir'));
    expect(await status(read('../sibling.txt'))).toBe(403);
    expect(await status(read('src/../../sibling.txt'))).toBe(403);
    expect(await status(read(path.join(outside, 'secret.txt')))).toBe(403);
    expect(await status(read('/etc/hosts'))).toBe(403);
    expect(await status(read('link.txt'))).toBe(403);
    expect(await status(read('linkdir/secret.txt'))).toBe(403);
    // The cwd itself must be inside the roots.
    expect(await status(read('secret.txt', outside))).toBe(400);
  });

  it('a symlink staying inside the cwd is fine', async () => {
    const { p, read } = await setup();
    await fs.symlink(path.join(p, 'src', 'a.ts'), path.join(p, 'alias.ts'));
    expect((await read('alias.ts')).path).toBe(path.join(p, 'src', 'a.ts'));
  });

  it('refuses credential files and dirs even inside the cwd', async () => {
    const { h, read } = await setup();
    for (const f of ['.env', '.env.local', 'id_rsa', 'server.pem', '.npmrc', 'auth.json', '.ssh/config', '.aws/credentials', '.codex/auth.json', '.claude/settings.json', '.claude-b/x.json']) {
      await fs.mkdir(path.dirname(path.join(h, f)), { recursive: true });
      await fs.writeFile(path.join(h, f), 'secret');
      expect(await status(read(f, h)), f).toBe(403);
    }
    await fs.writeFile(path.join(h, 'proj', '.env.example'), 'A=');
    expect((await read('.env.example')).kind).toBe('text');
    // ~ expansion is still contained and deny-listed.
    expect(await status(read('~/.ssh/config', h))).toBe(403);
    // A symlink inside the project pointing at a denied file.
    await fs.symlink(path.join(h, '.ssh', 'config'), path.join(h, 'proj', 'innocent.txt'));
    expect(await status(read('innocent.txt'))).toBe(403);
  });

  it('isDeniedPath: home-level .claude* only, project .claude folders stay readable', () => {
    expect(isDeniedPath('/u/.claude/x', '/u')).toBe(true);
    expect(isDeniedPath('/u/.claude-work/x', '/u')).toBe(true);
    expect(isDeniedPath('/u/code/deck/.claude/worktrees/a/src/x.ts', '/u')).toBe(false);
    expect(isDeniedPath('/u/code/.ssh/x', '/u')).toBe(true);
  });

  it('isDeniedPath: every home-level dotfile/dotdir and ~/Library; project dotdirs stay readable; history and token files anywhere', () => {
    for (const f of ['.zsh_history', '.config/deck/token', '.config/anything/x.json', '.vault-token', 'Library/Application Support/Claude/claude_desktop_config.json', 'Library/x']) expect(isDeniedPath(`/u/${f}`, '/u'), f).toBe(true);
    for (const f of ['code/x/.github/workflows/ci.yml', 'code/x/.gitignore', 'Libraryish/x', 'code/Library/x']) expect(isDeniedPath(`/u/${f}`, '/u'), f).toBe(false);
    for (const f of ['.bash_history', '.python_history', '.vault-token', 'credentials.tfrc.json', 'service-account-prod.json', 'logins.json', 'key4.db']) expect(isDeniedPath(`/u/code/x/${f}`, '/u'), f).toBe(true);
  });

  it('with the cwd at ~: deck\'s config dir (denyRoots) and home dotfiles are refused', async () => {
    const h = await home();
    const cfg = path.join(h, 'deckcfg');
    await fs.mkdir(cfg);
    await fs.writeFile(path.join(cfg, 'vapid.json'), '{}');
    await fs.writeFile(path.join(h, '.zsh_history'), 'x');
    await fs.writeFile(path.join(h, 'notes.txt'), 'ok');
    const read = (file: string) => readSessionFile({ home: h, roots: [h], cwd: h, file, denyRoots: [cfg] });
    expect(await status(read('deckcfg/vapid.json'))).toBe(403);
    expect(await status(read('.zsh_history'))).toBe(403);
    expect((await read('notes.txt')).kind).toBe('text');
    // Through the lister too.
    const lister = new FileLister({ home: h, roots: [h], denyRoots: [cfg] });
    expect(await status(lister.read(h, 'deckcfg/vapid.json'))).toBe(403);
  });

  it('refuses a hard-linked file (another name for a file elsewhere)', async () => {
    const { h, read } = await setup();
    await fs.writeFile(path.join(h, 'secret.txt'), 'x');
    await fs.link(path.join(h, 'secret.txt'), path.join(h, 'proj', 'alias.txt'));
    expect(await status(read('alias.txt'))).toBe(403);
  });

  it('size cap, binary detection, images sniffed by content', async () => {
    const { p, read } = await setup();
    await fs.writeFile(path.join(p, 'big.txt'), 'x'.repeat(101));
    expect(await status(read('big.txt', p, 100))).toBe(413);
    await fs.writeFile(path.join(p, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    expect(await status(read('bin.dat'))).toBe(415);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await fs.writeFile(path.join(p, 'pic.png'), png);
    expect(await read('pic.png')).toMatchObject({ kind: 'image', mediaType: 'image/png', base64: png.toString('base64') });
    expect(await status(read('src'))).toBe(400);
    expect(await status(read('missing.ts'))).toBe(404);
    expect(await status(read(''))).toBe(400);
  });
});

describe('openSessionFileRaw / revealSessionPath (same check as the preview)', () => {
  async function setup() {
    const h = await home();
    const p = path.join(h, 'proj');
    await fs.mkdir(path.join(p, 'sub'), { recursive: true });
    await fs.writeFile(path.join(p, 'a.txt'), 'abc');
    return { h, p };
  }
  const status = async (pr: Promise<unknown>) => { try { await pr; return 200; } catch (e) { if (e instanceof FileReadError) return e.status; if (e instanceof DirError) return 400; throw e; } };

  it('raw: open handle of the checked file, size, type; refuses hard links, folders and the size cap', async () => {
    const { h, p } = await setup();
    const r = await openSessionFileRaw({ home: h, roots: [h], cwd: p, file: 'a.txt' });
    try {
      expect(r).toMatchObject({ path: path.join(p, 'a.txt'), name: 'a.txt', size: 3, contentType: 'text/plain; charset=utf-8' });
      expect((await r.fh.readFile()).toString()).toBe('abc');
    } finally { await r.fh.close(); }
    await fs.writeFile(path.join(h, 'secret.txt'), 'x');
    await fs.link(path.join(h, 'secret.txt'), path.join(p, 'alias.txt'));
    expect(await status(openSessionFileRaw({ home: h, roots: [h], cwd: p, file: 'alias.txt' }))).toBe(403);
    expect(await status(openSessionFileRaw({ home: h, roots: [h], cwd: p, file: 'sub' }))).toBe(400);
    expect(await status(openSessionFileRaw({ home: h, roots: [h], cwd: p, file: 'a.txt', max: 2 }))).toBe(413);
  });

  it('rawContentType: sniffed images win, active content is text/plain, unknown is octet-stream', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(rawContentType('x.txt', png)).toBe('image/png');
    expect(rawContentType('x.png', Buffer.from('<html>'))).toBe('application/octet-stream');
    for (const n of ['x.svg', 'X.SVG', 'x.html', 'x.htm', 'x.js', 'x.md']) expect(rawContentType(n, Buffer.from('a')), n).toBe('text/plain; charset=utf-8');
    expect(rawContentType('x.pdf', Buffer.from('%PDF'))).toBe('application/pdf');
    expect(rawContentType('x', Buffer.from('a'))).toBe('application/octet-stream');
  });

  it('reveal: execFile open -R for a file and for a folder (never a plain open: it would launch bundles); 501 off macOS; 500 when open fails; 403 outside', async () => {
    const { h, p } = await setup();
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[], cb: (err: Error | null) => void) => { calls.push([cmd, ...args]); cb(null); };
    await revealSessionPath({ home: h, roots: [h], cwd: p, file: 'a.txt', platform: 'darwin', execFile: exec });
    await revealSessionPath({ home: h, roots: [h], cwd: p, file: 'sub', platform: 'darwin', execFile: exec });
    expect(calls).toEqual([['open', '-R', path.join(p, 'a.txt')], ['open', '-R', path.join(p, 'sub')]]);
    calls.length = 0;
    expect(await status(revealSessionPath({ home: h, roots: [h], cwd: p, file: 'a.txt', platform: 'linux', execFile: exec }))).toBe(501);
    expect(await status(revealSessionPath({ home: h, roots: [h], cwd: p, file: '../x', platform: 'darwin', execFile: exec }))).toBe(403);
    expect(calls).toEqual([]);
    const failing = (_c: string, _a: string[], cb: (err: Error | null) => void) => cb(new Error('boom'));
    expect(await status(revealSessionPath({ home: h, roots: [h], cwd: p, file: 'a.txt', platform: 'darwin', execFile: failing }))).toBe(500);
    // Through the lister (http uses this).
    const lister = new FileLister({ home: h, roots: [h], platform: 'win32', execFile: exec });
    await expect(lister.reveal(p, 'a.txt')).rejects.toMatchObject({ status: 501, message: '서버가 macOS 가 아니라 Finder 를 열 수 없습니다' });
  });
});
