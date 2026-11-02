/**
 * Isolated screenshot host for the hub controls (승인함 · 다음 작업 · 실행 관리 · 바로가기).
 * Run with node --import tsx scripts/qa/controls-demo.ts [state-file]   (QA_PORT, default 9381; 9377 is the live demo).
 * HOME is a fresh temp dir with fixture approvals and job folders. Nothing is spawned or signalled: launches get a
 * fake PID, the process table is a fixture and stop is a no-op. The hub status is the frozen snapshot.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRequestHandler } from '../../src/server/http';
import { checkUpgrade, isAuthed, loadOrCreateToken } from '../../src/server/auth';
import { SessionIndex } from '../../src/server/sessions/SessionIndex';
import { UsageService } from '../../src/server/usage/UsageService';
import { rootsOf, testRegistry } from '../../src/shared/accounts.testkit';
import { accountInfos, type ServerMessage } from '../../src/shared/protocol';
import { HUB_MODE_IDS, type HubStatus } from '../../src/shared/hub-types';
import { createApprovals } from '../../src/server/hub/controls/approvals';
import { createControls, CTL_PREFIX } from '../../src/server/hub/controls/http';
import { createBotTasks, createJobs, type ProcInfo } from '../../src/server/hub/controls/jobs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.QA_PORT ?? 9381);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 9377) throw new Error('QA_PORT must be a free unprivileged port other than 9377 (the live demo)');
const serverUrl = `http://127.0.0.1:${port}`;
const statusFile = path.resolve(process.env.STATUS_JSON ?? path.join(repo, '../.demo/status.json'));
const uiDir = path.resolve(process.env.DIST ?? path.join(repo, 'dist/ui'));
const stateFile = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), `msg-controls-qa-state-${process.pid}.json`));
const status = JSON.parse(await fs.readFile(statusFile, 'utf8')) as HubStatus;
if (!Array.isArray(status.modes)) throw new Error('STATUS_JSON must be a frozen hub status snapshot');
await fs.access(path.join(uiDir, 'index.html'));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-controls-qa-'));
await fs.chmod(dir, 0o700);
const tokenFile = path.join(dir, 'token');
const token = await loadOrCreateToken(tokenFile);
const home = path.join(dir, 'home');
const root = path.join(home, '.msg');
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────
const put = async (file: string, body: string) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); };
const touch = async (file: string, min: number) => { const t = new Date(now - min * 60_000); await fs.utimes(file, t, t); };
for (const d of ['ai-msg', 'engineering-shorts', 'games', 'yapping-bot']) await fs.mkdir(path.join(home, d), { recursive: true });

const pending = path.join(root, 'approvals', 'pending');
const decided = path.join(root, 'approvals', 'decided');
const reqs = [
  { id: 'apr-20261102-pr-hub-controls', from: 'msg-controls', mode: 'msg', kind: 'pr-merge', title: 'feat/hub-controls 를 main 에 병합',
    detail: '허브 카드에 승인함·다음 작업·실행 관리를 붙였습니다. 테스트 67개 추가, 금지 동작 차단 테스트 포함.', createdAt: ago(12),
    pr: { url: 'https://github.com/creditscend/ai-msg/pull/214', base: 'main', head: 'feat/hub-controls', files: 23, additions: 2140, deletions: 64 }, links: [] },
  { id: 'apr-20261102-shorts-upload', from: 'shorts', mode: 'video', kind: 'generic', title: '쇼츠 3편 업로드 일정 확정',
    detail: '「베어링 수명 계산」, 「PID 튜닝 30초」, 「열팽창 이음」 을 11/3 저녁 7시부터 하루 한 편씩 올립니다.', createdAt: ago(38),
    links: [{ label: '썸네일 시안', href: 'https://example.com/shorts/thumbs' }] },
  { id: 'apr-20261102-game-deploy', from: 'game-studio', mode: 'game', kind: 'deploy', title: '퍼즐 빌드 0.4.2 를 itch.io 에 배포',
    detail: '레벨 12–18 추가, 저장 버그 수정.', createdAt: ago(95), deploy: { target: 'itch.io / web', version: '0.4.2' }, links: [] },
  { id: 'apr-20261102-quant-arm', from: 'quant-bot', mode: 'quant', kind: 'generic', title: 'ETH 그리드 전략 ARMED 전환',
    detail: '백테스트 통과. 실거래 전환 승인을 요청합니다.', createdAt: ago(51), links: [] },
];
for (const r of reqs) await put(path.join(pending, `${r.id}.json`), JSON.stringify(r, null, 2));
await put(path.join(decided, 'apr-20261101-yapping-tone.json'), JSON.stringify({
  id: 'apr-20261101-yapping-tone', from: 'yapping', mode: 'yapping', kind: 'generic', title: '답장 말투를 반말로 바꾸기', detail: '', links: [], createdAt: ago(900),
  decision: { status: 'approved', by: 'owner', at: ago(860), note: '친한 채널만', hook: null },
}, null, 2));

const jobs = path.join(home, 'jobs');
const FAKE_PID = 424242;
const FAKE_START = '9876543';
const live = path.join(jobs, '20261102-thumbnail-ab-test');
await put(path.join(live, 'BRIEF.md'), '# 썸네일 A/B\n\n지난주 쇼츠 6편의 썸네일 두 안을 비교해 주세요.\n');
await put(path.join(live, 'account.txt'), 'b\n');
await put(path.join(live, 'pid.txt'), `${FAKE_PID}\n`);
await put(path.join(live, 'msg-job.json'), JSON.stringify({ launchedBy: 'msg', engine: 'claude', account: 'b', mode: 'video', title: '썸네일 A/B 비교', cwd: path.join(home, 'engineering-shorts'), brief: '지난주 쇼츠 6편의 썸네일 두 안을 비교해 주세요.', pid: FAKE_PID, procStart: FAKE_START, startedAt: ago(27) }, null, 2));
await put(path.join(live, 'run.log'), [
  '[msg] claude-pick → b',
  'Reading BRIEF.md …',
  'Found 6 shorts in engineering-shorts/out/2026-10-26..11-01',
  'Comparing CTR: A 4.1% · B 5.3% (n=18,420 impressions)',
  'Writing thumbs/compare.md …',
].join('\n') + '\n');

const done = path.join(jobs, '20261101-shorts-captions');
await put(path.join(done, 'BRIEF.md'), '# 자막 정리\n');
await put(path.join(done, 'account.txt'), 'a\n');
await put(path.join(done, 'run.log'), 'done.\n');
await put(path.join(done, 'REPORT.md'), [
  '# 자막 정리 보고',
  '',
  '쇼츠 6편의 자막을 다시 맞췄습니다. 줄당 16자를 넘는 곳은 둘로 나눴고, 단위 표기를 SI 로 통일했어요.',
  '',
  '| 편 | 고친 줄 | 비고 |',
  '| --- | ---: | --- |',
  '| 베어링 수명 계산 | 14 | 공식 자막을 화면 하단으로 |',
  '| PID 튜닝 30초 | 9 | |',
  '| 열팽창 이음 | 11 | 숫자 읽기 속도 조정 |',
  '',
  '- 남은 일: 영어 자막은 다음 작업으로',
  '',
  'STATUS: DONE',
].join('\n') + '\n');
await touch(path.join(done, 'BRIEF.md'), 642);
await touch(path.join(done, 'REPORT.md'), 600);

const limited = path.join(jobs, '20261101-level-generator');
await put(path.join(limited, 'BRIEF.md'), '# 레벨 생성기\n');
await put(path.join(limited, 'account.txt'), 'codex\n');
await put(path.join(limited, 'run.log'), 'Generating levels 12-18 …\nERROR: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 4th, 2026 3:41 PM.\n');
await put(path.join(limited, 'REPORT.md'), '# 레벨 생성기\n\n레벨 12–14 만 만들고 Codex 한도에 걸렸습니다.\n\nSTATUS: BLOCKED: Codex 사용 한도\n');
await touch(path.join(limited, 'BRIEF.md'), 398);
await touch(path.join(limited, 'REPORT.md'), 380);

const old = path.join(jobs, '20261030-yapping-digest');
await put(path.join(old, 'BRIEF.md'), '# 주간 요약\n');
await put(path.join(old, 'account.txt'), 'hermes\n');
await put(path.join(old, 'run.log'), 'ok\n');
await put(path.join(old, 'REPORT.md'), '주간 요약 초안을 만들었고, 링크 검증은 일부만 했습니다.\n\nSTATUS: PARTIAL\n');
await touch(path.join(old, 'BRIEF.md'), 3071);
await touch(path.join(old, 'REPORT.md'), 3000);

const wt = path.join(home, 'ai-msg-mini-widget');
await put(path.join(wt, 'REPORT.md'), '# 잠금화면 위젯\n\n위젯 토큰 회전을 붙였습니다.\n\nSTATUS: DONE\n');
await touch(path.join(wt, 'REPORT.md'), 1500);

// ── services ───────────────────────────────────────────────────────────────────────────────────────────────
let nextPid = 500000;
const launched = new Set<number>();
const proc = async (pid: number): Promise<ProcInfo | null> => {
  if (pid === FAKE_PID) return { pid, alive: true, startTime: FAKE_START, cwd: live, cmdline: 'claude -p Read BRIEF.md', cgroup: '0::/user.slice' };
  if (launched.has(pid)) return { pid, alive: true, startTime: String(pid), cwd: null, cmdline: 'claude -p Read BRIEF.md', cgroup: '0::/user.slice' };
  return null;
};
const controls = createControls({
  root, home, token, modes: HUB_MODE_IDS,
  approvals: createApprovals({ root, runHook: async () => { /* no hooks in QA */ } }),
  jobs: createJobs({
    home, secrets: [token], proc, kill: () => { /* QA: never signal anything */ },
    pickClaude: async () => 'c',
    spawnDetached: async (_argv, o) => { await fs.appendFile(o.logFile, '[qa] not started: isolated screenshot host\n'); const pid = ++nextPid; launched.add(pid); return pid; },
  }),
  tasks: createBotTasks({ root }),
  seats: () => [{ id: 'a', status: 'ok', fiveHourPct: 41, weeklyPct: 62 }, { id: 'b', status: 'ok', fiveHourPct: 12, weeklyPct: 38 }, { id: 'c', status: 'ok', fiveHourPct: 5, weeklyPct: 21 }],
});

const registry = testRegistry(dir);
const roots = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, path.join(dir, id)]));
const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(dir, 'pins.json') });
await index.refresh();
const usage = new UsageService({
  accounts: registry, mode: 'cli', deckUrl: serverUrl,
  fetchFn: async () => { throw new Error('QA usage network access is disabled'); },
});
const handler = createRequestHandler({
  token, uiDir, home, index, usage,
  hub: { status: { status: async () => status }, proxyTargets: {}, fileRoots: {}, controls },
});
const readPaths = new Set(['/api/me', '/api/build', '/api/bootstrap', '/api/usage', '/api/sessions', '/api/hub/status', '/api/health', '/api/version']);
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', serverUrl).pathname;
  if (pathname === '/api/diag' && req.method === 'POST' && isAuthed(req.headers.cookie, token)) {
    req.resume(); res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return;
  }
  // The controls routes do their own cookie/origin/CSRF/confirm checks (controls.test.ts); everything acts on the temp HOME.
  if (pathname.startsWith(CTL_PREFIX)) { handler(req, res); return; }
  if (req.method !== 'GET' || pathname.startsWith('/hub/p/') || (pathname.startsWith('/api/') && !readPaths.has(pathname))) {
    req.resume(); res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'isolated QA host' })); return;
  }
  handler(req, res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !checkUpgrade(req, token).ok) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const hello: ServerMessage = {
      type: 'hello', usage: usage.snapshot(), projects: [], pins: [], desktop: [],
      running: [], activity: [], sessionIcons: {}, codex: { available: false },
      features: ['accounts'], accounts: accountInfos(registry), build: null,
    };
    ws.send(JSON.stringify(hello));
    ws.on('error', () => { /* an abandoned screenshot tab is harmless */ });
  });
});

let ownsStateFile = false;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
  if (ownsStateFile) await fs.rm(stateFile, { force: true });
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await fs.writeFile(stateFile, JSON.stringify({ server: serverUrl, tokenFile, statusFile, uiDir, home, pid: process.pid }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  ownsStateFile = true;
  console.log(JSON.stringify({ ready: true, server: serverUrl, stateFile, tokenFile }));
} catch (error) {
  await close();
  throw error;
}
