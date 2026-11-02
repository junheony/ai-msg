import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveHubFile } from './files';
import { collectGameStudio, collectGameStudioCached, deriveStages, expandPath, lastHumanLine, parseAccount, parseBriefTitle, parseManifest, parseReportStatus, reportNeedsOwner, resolveGlob, scrubLine, studioAllow, studioFileRoots, studioFileUrl } from './gameStudio';
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
  it('reportNeedsOwner reads the STATUS line and owner-needed headings or labels, not prose', () => {
    expect(reportNeedsOwner('x\nSTATUS: BLOCKED: needs owner decision on the licence')).toBe(true);
    expect(reportNeedsOwner('x\nSTATUS: BLOCKED: 공개 범위 승인 대기')).toBe(true);
    expect(reportNeedsOwner('## Owner needed\n- pick a licence\n\nSTATUS: BLOCKED: stuck')).toBe(true);
    expect(reportNeedsOwner('- **오너 결정 필요:** 폰트 교체\nSTATUS: BLOCKED: stuck')).toBe(true);
    // the words in passing, a negation, or an empty section are no request
    expect(reportNeedsOwner('input ownership retained; 승인된 자산은 그대로 보존\nowner decision was made last week\nSTATUS: BLOCKED: gate unmet')).toBe(false);
    expect(reportNeedsOwner('x\nSTATUS: BLOCKED: gate unmet, no owner action needed')).toBe(false);
    expect(reportNeedsOwner('x\nSTATUS: BLOCKED: 오너 승인 불필요, 게이트 미달')).toBe(false);
    expect(reportNeedsOwner('## Owner needed\nNone.\n\nSTATUS: BLOCKED: stuck')).toBe(false);
    expect(reportNeedsOwner('Owner needed: none\nSTATUS: BLOCKED: stuck')).toBe(false);
    expect(reportNeedsOwner(null)).toBe(false);
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
  /** The fixture's brawl game with `jobs` (and optional mtimes / REPORT text) in place of its two agents. */
  const withJobs = (jobs: Record<string, { report?: string; ago?: number; pid?: string; brief?: string }>): Fx => {
    const fx = studioFx();
    const m = { ...MANIFEST, jobs: Object.keys(jobs).filter((j) => !/-cx$/.test(j)) };
    fx.files!['/repo/studio/games/brawl.json'] = JSON.stringify(m);
    for (const k of Object.keys(fx.files!)) if (/^jobs\/brawl-(qa|art)\//.test(k) && !k.endsWith('REPORT.md')) delete fx.files![k];
    delete fx.files!['jobs/brawl-art/REPORT.md'];
    for (const k of Object.keys(fx.mtimes!)) if (/^jobs\/brawl-art\/|brawl-qa\/run/.test(k)) delete fx.mtimes![k];
    delete fx.mtimes!['/proc/4242'];
    fx.dirs!.jobs = Object.keys(jobs);
    for (const [j, v] of Object.entries(jobs)) {
      if (v.report !== undefined) { fx.files![`jobs/${j}/REPORT.md`] = v.report; fx.mtimes![`jobs/${j}/REPORT.md`] = NOW - (v.ago ?? 30) * MIN; }
      fx.files![`jobs/${j}/run.log`] = 'x'; fx.mtimes![`jobs/${j}/run.log`] = NOW - (v.ago ?? 30) * MIN;
      if (v.brief) fx.files![`jobs/${j}/BRIEF.md`] = v.brief;
      if (v.pid) { fx.files![`jobs/${j}/pid.txt`] = v.pid; fx.mtimes![`/proc/${v.pid}`] = NOW; }
    }
    return fx;
  };
  const collect = (fx: Fx) => collectGameStudio(deps(fx), { studioDir: '/repo/studio' });
  const states = (g: Awaited<ReturnType<typeof collect>>) => Object.fromEntries(g.agents.map((a) => [a.job, a.successor ? `${a.state}>${a.successor}` : a.state]));
  const BLOCKED = 'x\nSTATUS: BLOCKED: gate unmet';

  it('leads with live jobs: a live pid before a moving log, whatever an older REPORT says', async () => {
    const g = await collect(withJobs({ 'old-b': { report: BLOCKED, ago: 30 }, moving: { ago: 1 }, 'live-1': { report: BLOCKED, ago: 400, pid: '51' }, 'old-d': { report: 'STATUS: DONE', ago: 20 } }));
    expect(g.agents.map((a) => [a.job, a.state])).toEqual([['live-1', 'working'], ['moving', 'working'], ['old-b', 'blocked'], ['old-d', 'done']]);
    expect(g.summary.working).toBe(2);
  });
  it('a job whose final REPORT is in stops counting as working while its log settles', async () => {
    expect(states(await collect(withJobs({ fin: { report: 'STATUS: DONE', ago: 2 } })))).toEqual({ fin: 'done' });
    // a pid-less re-run with a stale REPORT is still at work
    const fx = withJobs({ rerun: { report: 'STATUS: DONE', ago: 2 } }); fx.mtimes!['jobs/rerun/REPORT.md'] = NOW - 500 * MIN;
    expect(states(await collect(fx))).toEqual({ rerun: 'working' });
  });
  it('supersedes a BLOCKED job by name-N, by -cx (auto-linked), and by a newer job naming it as the previous step', async () => {
    expect(states(await collect(withJobs({ web: { report: BLOCKED, ago: 500 }, 'web-2': { report: BLOCKED, ago: 300 }, 'web-3': { report: 'STATUS: DONE', ago: 100 } })))).toEqual({ 'web-3': 'done', web: 'superseded>web-2', 'web-2': 'superseded>web-3' });
    const cx = await collect(withJobs({ kit: { report: BLOCKED, ago: 60 }, 'kit-cx': { ago: 1, pid: '52' } }));
    expect(states(cx)).toEqual({ 'kit-cx': 'working', kit: 'superseded>kit-cx' });
    expect(cx.games.find((x) => x.id === 'brawl')!.jobs).toContain('kit-cx');
    const named = await collect(withJobs({ perf: { report: BLOCKED, ago: 500 }, tune: { report: 'STATUS: DONE', ago: 100, brief: '# t\nRead ~/jobs/perf/REPORT.md first: it holds the previous measurements.' } }));
    expect(states(named)).toEqual({ tune: 'done', perf: 'superseded>tune' });
  });
  it('does not treat a parallel or keep-away mention, an older job, or a lower number as a successor', async () => {
    expect(states(await collect(withJobs({ perf: { report: BLOCKED, ago: 500 }, tune: { report: 'STATUS: DONE', ago: 100, brief: '# t\nDo NOT touch the previous ~/jobs/perf run.\nParallel job perf continues there.' } })))).toEqual({ tune: 'done', perf: 'stopped' });
    expect(states(await collect(withJobs({ perf: { report: BLOCKED, ago: 30 }, 'perf-tool': { report: 'STATUS: DONE', ago: 10, brief: '# t\nprevious perf-toolbox' } })))).toEqual({ perf: 'blocked', 'perf-tool': 'done' });
    expect(states(await collect(withJobs({ 'a-2': { report: BLOCKED, ago: 30 }, a: { report: 'STATUS: DONE', ago: 10 } })))).toEqual({ 'a-2': 'blocked', a: 'done' });
  });
  it('an unanswered BLOCKED: 막힘 under 3 h (track held, amber feed), then 중단됨 (track free, no alarm)', async () => {
    const fresh = await collect(withJobs({ solo: { report: BLOCKED, ago: 179 } }));
    expect(states(fresh)).toEqual({ solo: 'blocked' });
    expect(fresh.summary.blocked).toBe(1);
    expect(fresh.feed.find((e) => e.kind === 'report')).toMatchObject({ level: 'warn', text: expect.stringContaining('막힘 보고: gate unmet') });
    const old = await collect(withJobs({ solo: { report: BLOCKED, ago: 181 } }));
    expect(states(old)).toEqual({ solo: 'stopped' });
    expect(old.agents[0]!.reason).toBe('gate unmet');
    expect(old.summary.blocked).toBe(0);
    expect(old.games.find((x) => x.id === 'brawl')!.stages.some((s) => s.state === 'blocked')).toBe(false);
    expect(old.feed.find((e) => e.kind === 'report')).toMatchObject({ level: 'info', text: expect.stringContaining('중단됨: gate unmet') });
  });
  it('a superseded job counts for nothing: no 막힘, no red, the feed names who took over', async () => {
    const g = await collect(withJobs({ web: { report: BLOCKED, ago: 400 }, 'web-2': { report: 'STATUS: DONE', ago: 300 } }));
    expect(g.summary.blocked).toBe(0);
    const line = g.feed.find((e) => e.kind === 'report' && e.job === 'web')!;
    expect(line.level).toBe('info');
    expect(line.text).toContain('이어받음 → web-2');
    expect(JSON.stringify(g)).not.toContain('REPORT.md');
  });
  it('needs-owner: the only red, the game next move, however old; a successor still takes it over', async () => {
    const ask = 'x\nSTATUS: BLOCKED: owner decision on the licence';
    const g = await collect(withJobs({ solo: { report: ask, ago: 900 } }));
    expect(states(g)).toEqual({ solo: 'needs-owner' });
    expect(g.games.find((x) => x.id === 'brawl')!.nextAction).toEqual({ text: 'solo: owner decision on the licence', owner: true });
    expect(g.summary).toMatchObject({ owner: 1, blocked: 0 });
    expect(g.feed.find((e) => e.kind === 'report')).toMatchObject({ level: 'bad', text: expect.stringContaining('승인 필요') });
    expect(states(await collect(withJobs({ solo: { report: ask, ago: 900 }, 'solo-2': { report: 'STATUS: DONE', ago: 10 } })))).toEqual({ 'solo-2': 'done', solo: 'superseded>solo-2' });
  });
  it('오너 확인 counts only a reached pending approval or an asking agent, not a manifest flag or a far-off approval', async () => {
    const manifest = (over: object) => JSON.stringify({ id: 'one', title: 'One', stages: [{ id: 'concept', evidence: ['~/nope.md'] }], ...over });
    const run = async (over: object) => { const g = await collect({ files: { '/repo/studio/games/one.json': manifest(over) }, dirs: { '/repo/studio/games': ['one.json'] } }); return { next: g.games[0]!.nextAction, owner: g.summary.owner }; };
    expect(await run({ nextAction: { text: '계획 결정', owner: true } })).toEqual({ next: { text: '계획 결정', owner: false }, owner: 0 });
    expect(await run({ approvals: [{ what: '공개', state: 'pending' }] })).toEqual({ next: { text: '콘셉트 단계 진행', owner: false }, owner: 0 });
    // a pending approval the track has reached, unless the manifest says the next move is not the owner's yet
    const fx = studioFx();
    const reached = await collect(fx);
    expect(reached.games[0]!.nextAction?.owner).toBe(true);
    fx.files!['/repo/studio/games/brawl.json'] = JSON.stringify({ ...MANIFEST, nextAction: { text: '재측정', owner: false } });
    const putOff = await collect(fx);
    expect(putOff.games[0]!.nextAction).toEqual({ text: '재측정', owner: false });
    expect(putOff.summary.owner).toBe(0);
  });
  it('stays within its stat budget and the cached call never throws', async () => {
    const stats = { n: 0 };
    await collectGameStudio(deps(studioFx(), stats), { studioDir: '/repo/studio' });
    expect(stats.n).toBeLessThanOrEqual(800);
    const broken: HubDeps = { ...deps({}), listDir: async () => { throw new Error('boom'); } };
    await expect(collectGameStudioCached(broken, { studioDir: '/repo/studio' })).resolves.not.toBeUndefined();
  });
});
