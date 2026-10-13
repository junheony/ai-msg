import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { FileLister, MAX_RAW_BYTES } from './files';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { UsageService } from './usage/UsageService';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'd'.repeat(64);
const cookie = `deck_session=${cookieValueFor(TOKEN)}`;
let base = '';
let server: http.Server;
let dir: string;
let proj: string;
let outside: string;
const calls: { cmd: string; args: string[] }[] = [];

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-http-files-')));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-http-files-out-')));
  proj = path.join(dir, 'proj');
  await fs.mkdir(path.join(proj, 'sub'), { recursive: true });
  await fs.writeFile(path.join(proj, 'a.txt'), 'hello\n');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
  const roots = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') };
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(dir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const files = new FileLister({ home: dir, roots: [dir], platform: 'darwin', execFile: (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); } });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index, files }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });

const rawUrl = (file: string, extra = '') => `${base}/api/file?cwd=${encodeURIComponent(proj)}&path=${encodeURIComponent(file)}&raw=1${extra}`;

describe('GET /api/file?raw=1', () => {
  it('requires auth', async () => {
    expect((await fetch(rawUrl('a.txt'))).status).toBe(401);
  });

  it('streams the exact bytes with a safe type, nosniff and private no-store', async () => {
    const r = await fetch(rawUrl('a.txt'), { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''a.txt");
    expect(await r.text()).toBe('hello\n');
  });

  it('sniffs images by content and keeps binary bytes intact', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff, 1, 2]);
    await fs.writeFile(path.join(proj, 'pic.bin'), png);
    const r = await fetch(rawUrl('pic.bin'), { headers: { cookie } });
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await r.arrayBuffer()).equals(png)).toBe(true);
  });

  it('svg and html are plain text, unknown extensions octet-stream', async () => {
    await fs.writeFile(path.join(proj, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await fs.writeFile(path.join(proj, 'x.html'), '<script>alert(1)</script>');
    await fs.writeFile(path.join(proj, 'x.weird'), Buffer.from([1, 2, 3]));
    expect((await fetch(rawUrl('x.svg'), { headers: { cookie } })).headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect((await fetch(rawUrl('x.html'), { headers: { cookie } })).headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect((await fetch(rawUrl('x.weird'), { headers: { cookie } })).headers.get('content-type')).toBe('application/octet-stream');
  });

  it('download=1 is an attachment with an RFC 5987 UTF-8 file name (Korean included)', async () => {
    await fs.writeFile(path.join(proj, "보고서 (최종)'s.md"), '# 제목\n');
    const r = await fetch(rawUrl("보고서 (최종)'s.md", '&download=1'), { headers: { cookie } });
    expect(r.status).toBe(200);
    const cd = r.headers.get('content-disposition')!;
    expect(cd).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('보고서 ')}%28${encodeURIComponent('최종')}%29%27s.md`);
    expect(decodeURIComponent(cd.split("''")[1]!)).toBe("보고서 (최종)'s.md");
    expect(await r.text()).toBe('# 제목\n');
  });

  it('over 50MB is 413 (the preview cap of 2MB does not apply)', async () => {
    const mid = path.join(proj, 'mid.log');
    await fs.writeFile(mid, '');
    await fs.truncate(mid, 3 * 1024 * 1024);
    const ok = await fetch(rawUrl('mid.log'), { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(3 * 1024 * 1024);
    const big = path.join(proj, 'big.bin');
    await fs.writeFile(big, '');
    await fs.truncate(big, MAX_RAW_BYTES + 1);
    const r = await fetch(rawUrl('big.bin'), { headers: { cookie } });
    expect(r.status).toBe(413);
    expect((await r.json() as { error: string }).error).toContain('50MB');
  });

  it('outside the session folder, credentials and folders are refused like the preview', async () => {
    expect((await fetch(rawUrl(path.join(outside, 'secret.txt')), { headers: { cookie } })).status).toBe(403);
    expect((await fetch(rawUrl('../../x'), { headers: { cookie } })).status).toBe(403);
    await fs.writeFile(path.join(proj, '.env'), 'K=v');
    expect((await fetch(rawUrl('.env'), { headers: { cookie } })).status).toBe(403);
    expect((await fetch(rawUrl('sub'), { headers: { cookie } })).status).toBe(400);
    expect((await fetch(rawUrl('missing.txt'), { headers: { cookie } })).status).toBe(404);
  });

  it('without raw=1 the preview JSON is unchanged', async () => {
    const r = await fetch(`${base}/api/file?cwd=${encodeURIComponent(proj)}&path=a.txt`, { headers: { cookie } });
    expect(await r.json()).toEqual({ path: path.join(proj, 'a.txt'), size: 6, kind: 'text', text: 'hello\n' });
  });
});

describe('POST /api/reveal', () => {
  const post = (body: unknown, headers: Record<string, string> = { cookie, origin: base }) =>
    fetch(`${base}/api/reveal`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('requires auth and a same-origin request', async () => {
    expect((await post({ cwd: proj, file: 'a.txt' }, { origin: base })).status).toBe(401);
    expect((await post({ cwd: proj, file: 'a.txt' }, { cookie })).status).toBe(403);
  });

  it('a file and a folder are both revealed with open -R <real path> (a plain open would launch .app bundles); 204', async () => {
    calls.length = 0;
    const r = await post({ cwd: proj, file: 'a.txt' });
    expect(r.status).toBe(204);
    await post({ cwd: proj, file: 'sub' });
    expect(calls).toEqual([{ cmd: 'open', args: ['-R', path.join(proj, 'a.txt')] }, { cmd: 'open', args: ['-R', path.join(proj, 'sub')] }]);
  });

  it('refuses paths outside the folder and bad bodies without running anything', async () => {
    calls.length = 0;
    expect((await post({ cwd: proj, file: path.join(outside, 'secret.txt') })).status).toBe(403);
    expect((await post({ cwd: proj })).status).toBe(400);
    expect((await post({ cwd: 'relative', file: 'a.txt' })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
