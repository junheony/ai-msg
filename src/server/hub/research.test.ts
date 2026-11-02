import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { articleSchema, createResearchService, serveResearch, sortArticles, sourceSchema } from './research';
import type { ResearchArticle } from '../../shared/research-types';

const article = (over: Partial<ResearchArticle> = {}) => ({ id: 'a', title: '제목', date: '2026-11-02', summary: '', tags: ['RWA'], url: 'https://example.com/a', source: 'AI-Crypto 리서치', ...over });
const source = { name: 'Kaiko', url: 'https://www.kaiko.com/', focus: '시장 데이터', category: 'Data', ownerPick: false };

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-research-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const write = (name: string, body: unknown) => fs.writeFile(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));

describe('schema', () => {
  it('accepts an empty summary and fills the optional fields', () => {
    const r = articleSchema.parse({ id: 'a', title: 't', date: '2026-10-31', url: 'https://x.io/' });
    expect(r).toMatchObject({ summary: '', tags: [], source: 'AI-Crypto 리서치' });
  });
  it.each([
    ['a date that does not exist', { date: '2026-02-30' }],
    ['a date range', { date: '2026-10-30~31' }],
    ['a script link', { url: 'javascript:alert(1)' }],
    ['a non-URL', { url: 'cursor.com/canvas' }],
    ['an empty title', { title: '  ' }],
  ])('rejects %s', (_label, over) => {
    expect(articleSchema.safeParse(article(over)).success).toBe(false);
  });
  it('holds sources to the three categories', () => {
    expect(sourceSchema.safeParse(source).success).toBe(true);
    expect(sourceSchema.safeParse({ ...source, category: 'Blog' }).success).toBe(false);
  });
});

describe('sortArticles', () => {
  it('puts pinned first, then newest, then daily-updated pieces', () => {
    const ids = sortArticles([
      article({ id: 'daily', date: '2026-11-09', updatedDaily: true }),
      article({ id: 'old', date: '2026-10-01' }),
      article({ id: 'new', date: '2026-11-01' }),
      article({ id: 'pin', date: '2026-09-01', pinned: true }),
    ]).map((a) => a.id);
    expect(ids).toEqual(['pin', 'new', 'old', 'daily']);
  });
});

describe('createResearchService', () => {
  it('reports missing files as an empty, non-error state', async () => {
    const r = await createResearchService(path.join(dir, 'nope')).get();
    expect(r).toEqual({ articles: [], sources: [], files: { articles: 'missing', sources: 'missing' }, skipped: { articles: 0, sources: 0 } });
  });
  it('reads new articles without a restart', async () => {
    const svc = createResearchService(dir);
    await write('articles.json', [article()]);
    expect((await svc.get()).articles).toHaveLength(1);
    await write('articles.json', [article(), article({ id: 'b', url: 'https://example.com/b' })]);
    expect((await svc.get()).articles).toHaveLength(2);
  });
  it('marks broken JSON and a non-array root as invalid', async () => {
    await write('articles.json', '{ not json');
    await write('sources.json', { sources: [] });
    expect((await createResearchService(dir).get()).files).toEqual({ articles: 'invalid', sources: 'invalid' });
  });
  it('leaves out bad and duplicate entries and counts them', async () => {
    await write('articles.json', [article(), article(), article({ id: 'x', url: 'file:///etc/passwd' }), 7]);
    await write('sources.json', [source, { ...source, category: 'Blog', url: 'https://b.io' }]);
    const r = await createResearchService(dir).get();
    expect(r.articles.map((a) => a.id)).toEqual(['a']);
    expect(r.skipped).toEqual({ articles: 3, sources: 1 });
    expect(r.files.articles).toBe('ok');
  });
});

describe('serveResearch', () => {
  const capture = () => {
    const out = { status: 0, body: '', headers: {} as Record<string, unknown> };
    const res = { setHeader: (k: string, v: unknown) => { out.headers[k] = v; }, writeHead: (s: number, h: Record<string, unknown>) => { out.status = s; Object.assign(out.headers, h); }, end: (b: string) => { out.body = b; } };
    return { out, res: res as never };
  };
  it('answers GET without leaking a path', async () => {
    const { out, res } = capture();
    await serveResearch(createResearchService(dir), 'GET', res);
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toBe('no-store');
    expect(out.body).not.toContain(dir);
  });
  it('refuses writes', async () => {
    const { out, res } = capture();
    await serveResearch(createResearchService(dir), 'POST', res);
    expect(out.status).toBe(405);
    expect(out.headers.Allow).toBe('GET');
  });
});

describe('scripts/msg-research-add', () => {
  const script = path.resolve('scripts/msg-research-add');
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [script, ...args], { env: { ...process.env, MSG_RESEARCH_DIR: path.join(dir, 'new') } });
  const base = ['--title', '새 글', '--date', '2026-11-03', '--url', 'https://example.com/n', '--tags', 'RWA, Launchpad'];

  it('creates the file and writes an entry the server accepts', async () => {
    await run(...base, '--daily');
    const r = await createResearchService(path.join(dir, 'new')).get();
    expect(r.skipped.articles).toBe(0);
    expect(r.articles[0]).toMatchObject({ title: '새 글', summary: '', tags: ['RWA', 'Launchpad'], source: 'AI-Crypto 리서치', updatedDaily: true });
  });
  it('refuses a duplicate url, a bad date and a non-http link', async () => {
    await run(...base);
    await expect(run(...base)).rejects.toThrow(/already exists/);
    await expect(run('--title', 't', '--date', '2026-13-01', '--url', 'https://e.io/2')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(run('--title', 't', '--date', '2026-11-01', '--url', 'javascript:alert(1)')).rejects.toThrow(/http/);
  });
});
