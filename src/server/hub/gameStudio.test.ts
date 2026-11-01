import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveHubFile } from './files';
import { collectGameStudio, collectGameStudioCached, deriveStages, expandPath, lastHumanLine, parseAccount, parseBriefTitle, parseManifest, parseReportStatus, resolveGlob, scrubLine, studioAllow, studioFileRoots, studioFileUrl } from './gameStudio';
import type { HubDeps } from './shared';

const NOW = Date.parse('2026-11-01T03:00:00Z'); // 12:00 KST
const HOME = '/home/alice';
const MIN = 60_000;

interface Fx { files?: Record<string, string>; dirs?: Record<string, string[]>; mtimes?: Record<string, number> }
/** Deps over an in-memory filesystem; keys are relative to HOME (absolute keys are taken as is). */
function deps(fx: Fx, stats?: { n: number }): HubDeps {
  const rel = (p: string): string => (p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p);
  return {
    fetchJson: async () => { throw new Error('offline'); },
    latestRender: async () => null,
    countEntries: async (d) => fx.dirs?.[rel(d)]?.length ?? null,
    gitLastCommit: async () => null,
    readText: async (f) => fx.files?.[rel(f)] ?? null,
    readTail: async (f) => fx.files?.[rel(f)] ?? null,
    listDir: async (d) => fx.dirs?.[rel(d)] ?? null,
    fileMtime: async (f) => { if (stats) stats.n++; const k = rel(f); return fx.mtimes?.[k] ?? (fx.files?.[k] !== undefined ? NOW - 60 * MIN : null); },
    systemdShow: async () => null,
    now: () => NOW, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
  };
}
const stat = (d: HubDeps) => (f: string) => d.fileMtime(f);

describe('studioAllow / studioFileUrl', () => {
  it('serves media anywhere, build files only inside a build folder, never dot-dirs or node_modules', () => {
    expect(studioAllow('brawl/qa/shot.png', '.png')).toBe(true);
    expect(studioAllow('job/out.mp4', '.mp4')).toBe(true);
    expect(studioAllow('brawl/dist/index.html', '.html')).toBe(true);
    expect(studioAllow('brawl/dist/assets/a.js', '.js')).toBe(true);
    expect(studioAllow('brawl/src/main.js', '.js')).toBe(false);
    expect(studioAllow('brawl/index.html', '.html')).toBe(false);
    expect(studioAllow('brawl/.git/x.png', '.png')).toBe(false);
    expect(studioAllow('brawl/node_modules/x/dist/a.js', '.js')).toBe(false);
    expect(studioAllow('job/REPORT.md', '.md')).toBe(false);
    expect(studioAllow('job/run.log', '.log')).toBe(false);
  });
  it('maps an absolute path to its root, or null outside the roots', () => {
    expect(studioFileUrl(HOME, `${HOME}/jobs/neon-ui/shots/a b.png`)).toBe('/api/hub/file/sjobs/neon-ui/shots/a%20b.png');
    expect(studioFileUrl(HOME, `${HOME}/games/neon/dist/NEON.html`)).toBe('/api/hub/file/sgames/neon/dist/NEON.html');
    expect(studioFileUrl(HOME, `${HOME}/bbai-codex/brawl/README.md`)).toBeNull();
    expect(studioFileUrl(HOME, `${HOME}/.ssh/id.png`)).toBeNull();
    expect(studioFileUrl(HOME, '/etc/passwd')).toBeNull();
  });
});

describe('resolveHubFile with a policy root', () => {
  it('applies the root policy after the type allowlist and the containment check', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-files-'));
    try {
      await fs.mkdir(path.join(dir, 'jobs', 'j', 'shots'), { recursive: true });
      await fs.mkdir(path.join(dir, 'jobs', 'j', 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'jobs', 'j', 'shots', 'a.png'), 'x');
      await fs.writeFile(path.join(dir, 'jobs', 'j', 'src', 'page.html'), '<p>');
      const roots = studioFileRoots(dir);
      const ok = await resolveHubFile(roots, '/api/hub/file/sjobs/j/shots/a.png');
      expect('file' in ok && ok.type).toBe('image/png');
      expect(await resolveHubFile(roots, '/api/hub/file/sjobs/j/src/page.html')).toEqual({ status: 403 });
      expect('status' in (await resolveHubFile(roots, '/api/hub/file/sjobs/../x.png'))).toBe(true);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe('parsers', () => {
  it('parseAccount reads the account and model from account.txt', () => {
    expect(parseAccount('b opus\n')).toEqual({ account: 'b', model: 'opus' });
    expect(parseAccount('a (opus)')).toEqual({ account: 'a', model: 'opus' });
    expect(parseAccount('codex')).toEqual({ account: 'codex', model: null });
    expect(parseAccount('c')).toEqual({ account: 'c', model: null });
    expect(parseAccount('zz')).toEqual({ account: 'unknown', model: null });
    expect(parseAccount(null)).toEqual({ account: 'unknown', model: null });
  });
  it('parseReportStatus takes the last STATUS line', () => {
    expect(parseReportStatus('# r\n...\nSTATUS: DONE\n')).toEqual({ status: 'done', reason: null });
    expect(parseReportStatus('x\n**STATUS: BLOCKED: limit**')).toEqual({ status: 'blocked', reason: 'limit' });
    expect(parseReportStatus('no status here')).toEqual({ status: null, reason: null });
    expect(parseReportStatus(null)).toEqual({ status: null, reason: null });
  });
  it('parseBriefTitle takes the first heading', () => {
    expect(parseBriefTitle('intro\n# 브롤 웹 3차 — QA\nbody')).toBe('브롤 웹 3차 — QA');
    expect(parseBriefTitle('plain first line\n')).toBe('plain first line');
  });
  it('scrubLine strips secrets, emails, home paths and markdown', () => {
    const s = scrubLine('**done** token=abcdef123456 mail max@example.com key sk-ant-abcdefghijklmnop in /home/alice/x');
    expect(s).not.toMatch(/abcdef123456|example\.com|sk-ant|\/home\/alice|\*\*/);
    expect(scrubLine('x'.repeat(300)).length).toBeLessThanOrEqual(140);
  });
  it('expandPath resolves ~ and repo-relative paths and refuses ..', () => {
    expect(expandPath('~/games/a', HOME, '/repo')).toBe(`${HOME}/games/a`);
    expect(expandPath('docs/X.md', HOME, '/repo')).toBe('/repo/docs/X.md');
    expect(expandPath('~/games/../.ssh', HOME, '/repo')).toBeNull();
  });
});

describe('lastHumanLine', () => {
  it('stream-json: the newest assistant text, or the tool by its description', () => {
    const tail = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '빌드를 확인합니다.' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET OUTPUT' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf x', description: 'Run unit tests' } }] } }),
    ].join('\n');
    expect(lastHumanLine(tail)).toBe('명령 실행 · Run unit tests');
    const done = `${tail}\n${JSON.stringify({ type: 'result', result: '## 결과\n모든 테스트 통과 (42)' })}`;
    expect(lastHumanLine(done)).toBe('결과');
  });
  it('codex exec: the message after the last codex marker', () => {
    const tail = 'exec\nnpm test\n succeeded in 3s\ncodex\n매니페스트 5개를 작성했습니다.\ntokens used\n12,345\nEXIT 0 Sat Oct 31';
    expect(lastHumanLine(tail)).toBe('매니페스트 5개를 작성했습니다.');
  });
  it('plain text: the last line that is not a marker', () => {
    expect(lastHumanLine('step one\nstep two\nEXIT 0 now\n')).toBe('step two');
    expect(lastHumanLine(null)).toBeNull();
  });
});

describe('parseManifest / deriveStages', () => {
  it('rejects bad slugs and keeps only http(s) previews and valid job names', () => {
    expect(parseManifest('{"id":"Bad Slug","title":"x"}')).toBeNull();
    expect(parseManifest('not json')).toBeNull();
    const m = parseManifest(JSON.stringify({ id: 'g1', title: 'G', status: 'weird', preview: [{ label: 'a', url: 'javascript:alert(1)' }, { label: 'b', url: 'https://x.dev' }], jobs: ['ok-job', '../etc'] }))!;
    expect(m.status).toBe('unknown');
    expect(m.preview).toEqual([{ label: 'b', href: 'https://x.dev' }]);
    expect(m.jobs).toEqual(['ok-job']);
    expect(m.stages.map((s) => s.id)).toEqual(['concept', 'assets', 'build', 'test', 'preview', 'approval', 'release']);
  });
  const f = (found: number[], totals: number[]) => ['concept', 'assets', 'build', 'test', 'preview', 'approval', 'release'].map((id, i) => ({ id: id as 'concept', found: found[i]!, total: totals[i]!, at: null }));
  it('done by evidence, first not-done active, partial evidence noted', () => {
    const s = deriveStages(f([1, 1, 1, 0, 0, 0, 0], [1, 1, 2, 1, 1, 0, 1]), [], null);
    expect(s.map((x) => x.state)).toEqual(['done', 'done', 'active', 'todo', 'todo', 'todo', 'todo']);
    expect(s[2]!.note).toBe('증거 1/2');
  });
  it('approval follows approvals; a blocked agent blocks the active stage', () => {
    const s = deriveStages(f([1, 1, 1, 1, 1, 0, 0], [1, 1, 1, 1, 1, 0, 1]), [{ what: '공개', state: 'pending', at: null }], 'job-x 막힘');
    expect(s[5]!.state).toBe('blocked');
    expect(s[5]!.note).toBe('대기: 공개');
    const r = deriveStages(f([1, 1, 1, 1, 1, 0, 0], [1, 1, 1, 1, 1, 0, 1]), [{ what: '공개', state: 'rejected', at: null }], null);
    expect(r[5]!.state).toBe('blocked');
    const ok = deriveStages(f([1, 1, 1, 1, 1, 0, 0], [1, 1, 1, 1, 1, 0, 1]), [{ what: '공개', state: 'approved', at: null }], null);
    expect(ok.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'active']);
  });
  it('a released game without approvals counts its approval as passed', () => {
    const s = deriveStages(f([1, 1, 1, 1, 1, 0, 1], [1, 1, 1, 1, 1, 0, 1]), [], null);
    expect(s.every((x) => x.state === 'done')).toBe(true);
  });
});

describe('resolveGlob', () => {
  it('matches * within a segment and ** across folders, newest first, capped', async () => {
    const d = deps({
      dirs: { 'jobs/j': ['shots', 'run.log'], 'jobs/j/shots': ['a.png', 'b.png', 'c.txt', 'deep'], 'jobs/j/shots/deep': ['d.png'] },
      mtimes: { 'jobs/j/shots/a.png': 1000, 'jobs/j/shots/b.png': 3000, 'jobs/j/shots/deep/d.png': 2000 },
    });
    expect((await resolveGlob(d, `${HOME}/jobs/j/shots/*.png`, stat(d))).map((x) => path.basename(x.file))).toEqual(['b.png', 'a.png']);
    expect((await resolveGlob(d, `${HOME}/jobs/j/**/*.png`, stat(d))).map((x) => path.basename(x.file))).toEqual(['b.png', 'd.png', 'a.png']);
    expect(await resolveGlob(d, `${HOME}/jobs/j/shots/*.png`, stat(d), 1)).toHaveLength(1);
    expect(await resolveGlob(d, `${HOME}/jobs/none/*.png`, stat(d))).toEqual([]);
  });
});

/* ───────── the collector over a fixture ───────── */

const MANIFEST = {
  schema: 1, id: 'brawl', title: 'Bored Brawl', titleKo: '보어드 브롤', genre: '아레나', engine: 'Three.js', status: 'candidate', reference: 'neon',
  repos: [{ label: 'web', path: '~/bbai-codex/brawl', branch: 'main', readonly: true }],
  stages: [
    { id: 'concept', evidence: ['~/bbai-codex/brawl/DESIGN.md'] },
    { id: 'assets', evidence: ['~/bbai-codex/brawl/assets/LICENSES.md'] },
    { id: 'build', evidence: ['~/bbai-codex/brawl/dist/index.html'] },
    { id: 'test', evidence: ['~/jobs/brawl-qa/REPORT.md'] },
    { id: 'preview', evidence: ['~/jobs/brawl-qa/shots/*.png'] },
    { id: 'approval', evidence: [] }, { id: 'release', evidence: ['~/bbai-codex/brawl/DEPLOYMENT.md'] },
  ],
  artifacts: { screenshots: ['~/jobs/brawl-qa/shots/*.png'], builds: ['~/bbai-codex/brawl/dist/index.html'], concept: ['~/bbai-codex/brawl/README.md'] },
  tests: [{ label: 'unit', path: '~/jobs/brawl-qa/REPORT.md' }, { label: 'e2e', path: '~/jobs/brawl-qa/missing.json' }],
  preview: [{ label: '로컬', url: 'http://127.0.0.1:5173/' }],
  jobs: ['brawl-qa', 'brawl-art'],
  approvals: [{ what: 'v1 공개', state: 'pending', at: '2026-10-31T10:00:00Z' }],
};
const NEON = { id: 'neon', title: 'Neon Apex', status: 'live', stages: [{ id: 'concept', evidence: ['~/games/neon/README.md'] }] };
const STREAM = [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '스크린샷 3장 캡처 완료 token=abcdef1234567890' }] } }),
].join('\n');

function studioFx(): Fx {
  return {
    files: {
      '/repo/studio/games/brawl.json': JSON.stringify(MANIFEST), '/repo/studio/games/neon.json': JSON.stringify(NEON), '/repo/studio/games/broken.json': '{',
      'bbai-codex/brawl/DESIGN.md': '#', 'bbai-codex/brawl/assets/LICENSES.md': '#', 'bbai-codex/brawl/dist/index.html': '<p>', 'bbai-codex/brawl/README.md': '#',
      'jobs/brawl-qa/REPORT.md': 'done\nSTATUS: DONE', 'jobs/brawl-qa/account.txt': 'b opus', 'jobs/brawl-qa/pid.txt': '4242', 'jobs/brawl-qa/run.log': STREAM, 'jobs/brawl-qa/BRIEF.md': '# 브롤 QA',
      'jobs/brawl-art/account.txt': 'codex', 'jobs/brawl-art/REPORT.md': 'x\nSTATUS: BLOCKED: 에셋 라이선스 확인 필요', 'jobs/brawl-art/run.log': 'codex\n라이선스를 찾지 못했습니다.\nEXIT 1',
      'jobs/other-1/pid.txt': '777', 'games/neon/README.md': '#',
    },
    dirs: { '/repo/studio/games': ['brawl.json', 'broken.json', 'neon.json'], jobs: ['brawl-art', 'brawl-qa', 'other-1', 'other-2'], 'jobs/brawl-qa/shots': ['a.png', 'b.png', 'notes.txt'] },
    mtimes: {
      'jobs/brawl-qa/shots/a.png': NOW - 50 * MIN, 'jobs/brawl-qa/shots/b.png': NOW - 40 * MIN, 'jobs/brawl-qa/run.log': NOW - 2 * MIN, '/proc/4242': NOW,
      'jobs/brawl-art/REPORT.md': NOW - 30 * MIN, 'jobs/brawl-art/run.log': NOW - 31 * MIN, '/proc/777': NOW,
      '/repo/docs/GAME_PIPELINE.md': NOW - 600 * MIN,
    },
  };
}

describe('collectGameStudio', () => {
  it('builds games, agents, loot, feed and the summary from manifests and job dirs', async () => {
    const g = await collectGameStudio(deps(studioFx()), { studioDir: '/repo/studio' });
    expect(g.error).toBeUndefined();
    expect(g.games.map((x) => x.id)).toEqual(['brawl', 'neon']);
    const b = g.games[0]!;
    expect(b.referenceTitle).toBe('Neon Apex');
    // the newest linked agent (brawl-qa) is working, so the older BLOCKED report does not block the track
    expect(b.stages.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'active', 'todo']);
    expect(b.nextAction).toEqual({ text: 'v1 공개 — 오너 결정', owner: true });
    expect(b.play?.href).toBe('/api/hub/file/scodex/brawl/dist/index.html');
    expect(b.cover?.src).toBe('/api/hub/file/sjobs/brawl-qa/shots/b.png');
    expect(b.artifacts.map((a) => a.name)).toEqual(['b.png', 'a.png']);
    expect(b.artifacts[0]!.job).toBe('brawl-qa');
    expect(b.tests).toEqual([{ label: 'unit', at: expect.any(String), found: true }, { label: 'e2e', at: null, found: false }]);
    expect(b.previews).toEqual([{ label: '로컬', href: 'http://127.0.0.1:5173/' }]);

    expect(g.agents.map((a) => [a.job, a.account, a.state])).toEqual([['brawl-qa', 'b', 'working'], ['brawl-art', 'codex', 'blocked']]);
    const qa = g.agents[0]!;
    expect(qa.alive).toBe(true);
    expect(qa.title).toBe('브롤 QA');
    expect(qa.line).toContain('스크린샷 3장 캡처 완료');
    expect(qa.line).not.toContain('abcdef1234567890');
    expect(qa.gameTitle).toBe('Bored Brawl');
    expect(g.agents[1]!.reason).toBe('에셋 라이선스 확인 필요');

    expect(g.others).toEqual({ count: 2, working: 1, names: ['other-1', 'other-2'] });
    expect(g.summary).toEqual({ working: 1, owner: 1, released: 1, blocked: 0, games: 2 });
    expect(g.loot).toHaveLength(2);
    expect(g.feed.length).toBeGreaterThan(0);
    expect(g.feed.map((e) => e.at)).toEqual(g.feed.map((e) => e.at).slice().sort().reverse());
    expect(g.feed.some((e) => e.kind === 'approval' && e.text.includes('승인 대기'))).toBe(true);
    expect(g.pipeline).toEqual({ doc: '/api/hub/game-pipeline', template: false, manifests: 2 });
    expect(JSON.stringify(g)).not.toContain(HOME);
  });
  it('reads 기록 없음-style states when files are missing', async () => {
    const empty = await collectGameStudio(deps({}), { studioDir: '/repo/studio' });
    expect(empty.games).toEqual([]);
    expect(empty.error).toMatch(/매니페스트 폴더 없음/);
    const bare = await collectGameStudio(deps({ files: { '/repo/studio/games/n.json': JSON.stringify(NEON) }, dirs: { '/repo/studio/games': ['n.json'] } }), { studioDir: '/repo/studio' });
    expect(bare.games[0]!.stages[0]!.state).toBe('active');
    expect(bare.games[0]!.cover).toBeNull();
    expect(bare.agents).toEqual([]);
  });
  it('blocks the active stage when the newest linked agent reported BLOCKED', async () => {
    const fx = studioFx();
    fx.mtimes!['jobs/brawl-qa/run.log'] = NOW - 300 * MIN; fx.mtimes!['jobs/brawl-qa/REPORT.md'] = NOW - 300 * MIN; delete fx.mtimes!['/proc/4242'];
    const g = await collectGameStudio(deps(fx), { studioDir: '/repo/studio' });
    const s = g.games[0]!.stages.find((x) => x.id === 'approval')!;
    expect(s.state).toBe('blocked');
    expect(g.summary.blocked).toBe(1);
  });
  it('stays within its stat budget and the cached call never throws', async () => {
    const stats = { n: 0 };
    await collectGameStudio(deps(studioFx(), stats), { studioDir: '/repo/studio' });
    expect(stats.n).toBeLessThanOrEqual(800);
    const broken: HubDeps = { ...deps({}), listDir: async () => { throw new Error('boom'); } };
    await expect(collectGameStudioCached(broken, { studioDir: '/repo/studio' })).resolves.not.toBeUndefined();
  });
});
