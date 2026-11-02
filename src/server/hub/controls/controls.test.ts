import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from '../../auth';
import { createRequestHandler } from '../../http';
import { SessionIndex } from '../../sessions/SessionIndex';
import { UsageService } from '../../usage/UsageService';
import { rootsOf, testRegistry } from '../../../shared/accounts.testkit';
import { HUB_MODE_IDS } from '../../../shared/hub-types';
import { createApprovals, parseRequest } from './approvals';
import { engineArgv, engineStates, parseLimitReset, scanOpenAiLimit, suggestEngine } from './engines';
import { approvalLock, forbiddenDir, forbiddenProcess, forbiddenReason, hasSecret, LOCKED_LABEL, redact } from './guard';
import { createControls, csrfFor } from './http';
import { briefOnly, createBotTasks, createJobs, jobEnv, reportStatus, RULES_MARKER, type ProcInfo } from './jobs';

const TOKEN = 'f'.repeat(64);

/* ───────── guard ───────── */

describe('forbidden-action guard', () => {
  it.each([
    'ARMED 켜고 시작', 'disarm the book', 'set FSD on', 'go live tonight', 'switch to live trading', 'Cont live 재개', 'edit live.conf',
    '실거래 전환', '라이브 전환 해줘', 'rotate the api key', 'API 키 교체', 'nexus-engine reload', 'restart cblabx-sr.service',
    'systemctl restart :8830', 'fix port 8792 service', 'append to ledger.jsonl', 'anchors.jsonl rewrite', '원장 정리', 'quant 리포트', 'Trading room 버튼',
  ])('blocks %s', (t) => { expect(forbiddenReason(t)).not.toBeNull(); });

  it.each(['README 오타 고치기', 'Shorts 썸네일 3개 만들기', 'game build 0.4 배포 준비', 'harmless refactor of hub cards', 'port 9320 health check'])('allows %s', (t) => {
    expect(forbiddenReason(t)).toBeNull();
  });

  it('locks trading/quant approvals by mode, kind or text', () => {
    expect(approvalLock({ mode: 'trading', title: 'x' })).toBe('mode trading');
    expect(approvalLock({ mode: 'quant', title: 'x' })).toBe('mode quant');
    expect(approvalLock({ mode: 'ops', kind: 'arm', title: 'x' })).not.toBeNull();
    expect(approvalLock({ mode: 'msg', kind: 'deploy', title: 'restart cblabx-lab' })).not.toBeNull();
    expect(approvalLock({ mode: 'msg', kind: 'pr-merge', title: 'Merge feat/hub-controls' })).toBeNull();
  });

  it('refuses trading dirs, protected folders and anything outside home', () => {
    const h = '/home/u';
    expect(forbiddenDir(h, '/home/u/ai-msg')).toBeNull();
    expect(forbiddenDir(h, '/home/u/arbitrage-nexus/src')).not.toBeNull();
    expect(forbiddenDir(h, '/home/u/cblabx-lab')).not.toBeNull();
    expect(forbiddenDir(h, '/home/u/.ssh')).not.toBeNull();
    expect(forbiddenDir(h, '/etc')).not.toBeNull();
    expect(forbiddenDir(h, '/home/u/../root')).not.toBeNull();
  });

  it('never signals protected units, trading commands or the server itself', () => {
    const base = { selfPid: 100, parentPid: 99, cgroup: '0::/user.slice/app.slice/x.scope', cmdline: 'node\0agent.js' };
    expect(forbiddenProcess({ ...base, pid: 500 })).toBeNull();
    expect(forbiddenProcess({ ...base, pid: 1 })).not.toBeNull();
    expect(forbiddenProcess({ ...base, pid: 100 })).not.toBeNull();
    expect(forbiddenProcess({ ...base, pid: 99 })).not.toBeNull();
    expect(forbiddenProcess({ ...base, pid: 500, cgroup: '0::/user.slice/user@1000.service/app.slice/cblabx-sr.service' })).not.toBeNull();
    expect(forbiddenProcess({ ...base, pid: 500, cmdline: 'python\0nexus_engine/main.py' })).not.toBeNull();
    expect(forbiddenProcess({ ...base, pid: 500, cmdline: 'uvicorn\0app\0--port\x008783' })).not.toBeNull();
  });

  it('detects and masks secrets', () => {
    expect(hasSecret('token=abcdef123456')).toBe(true);
    expect(hasSecret('sk-ant-abcdefghijklmnopqrstuv')).toBe(true);
    expect(hasSecret('plain words only')).toBe(false);
    const out = redact(`a ghp_${'x'.repeat(30)} b ${TOKEN} c api_key: hunter22secret`, [TOKEN]);
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('hunter22');
  });
});

/* ───────── engines ───────── */

describe('engines', () => {
  it('parses the Codex limit reset as KST', () => {
    const d = parseLimitReset('ERROR: You’ve hit your usage limit. Visit … or try again at Nov 4th, 2026 3:41 PM.');
    expect(d?.toISOString()).toBe('2026-11-04T06:41:00.000Z');
  });

  it('greys out Codex and Hermes together and suggests Claude', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-eng-'));
    await fs.mkdir(path.join(home, 'jobs', 'w'), { recursive: true });
    await fs.writeFile(path.join(home, 'jobs', 'w', 'run.log'), 'x\nERROR: You’ve hit your usage limit. try again at Nov 4th, 2026 3:41 PM.\n');
    const now = Date.parse('2026-11-02T00:00:00Z');
    const limit = await scanOpenAiLimit({ home, now: () => now });
    expect(limit?.toISOString()).toBe('2026-11-04T06:41:00.000Z');
    const st = engineStates(limit, []);
    expect(st.find((e) => e.id === 'codex')).toMatchObject({ available: false, limitedUntil: '2026-11-04T06:41:00.000Z' });
    expect(st.find((e) => e.id === 'hermes')).toMatchObject({ available: false });
    expect(st.find((e) => e.id === 'codex')!.reason).toContain('2026-11-04 15:41 KST');
    expect(suggestEngine(st, 'codex')).toBe('claude');
    // after the reset it is free again
    expect(await scanOpenAiLimit({ home, now: () => Date.parse('2026-11-05T00:00:00Z') })).toBeNull();
  });

  it('builds the agreed command lines', () => {
    expect(engineArgv('/h', 'codex', 'P')).toEqual(['/h/.local/bin/codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', 'P']);
    expect(engineArgv('/h', 'hermes', 'P')).toEqual(['/h/.local/bin/hermes', '-z', 'P']);
    expect(engineArgv('/h', 'claude', 'P')[0]).toBe('/h/.local/bin/claude');
  });
});

/* ───────── approvals ───────── */

describe('approvals queue', () => {
  let root: string;
  const req = (o: Record<string, unknown>) => ({ from: 'bot', mode: 'msg', kind: 'generic', title: 'T', detail: '', links: [], createdAt: '2026-11-02T00:00:00Z', ...o });
  const put = async (o: Record<string, unknown>) => { await fs.mkdir(path.join(root, 'approvals', 'pending'), { recursive: true }); await fs.writeFile(path.join(root, 'approvals', 'pending', `${o.id as string}.json`), JSON.stringify(req(o))); };
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-appr-')); });

  it('rejects files whose id does not match their name, and http-only links', () => {
    expect(parseRequest(req({ id: 'a' }), 'b')).toBeNull();
    expect(parseRequest(req({ id: 'a', links: [{ label: 'x', href: 'javascript:alert(1)' }, { label: 'ok', href: 'https://x.y' }] }), 'a')!.links).toEqual([{ label: 'ok', href: 'https://x.y' }]);
  });

  it('moves a decided request to decided/ and appends one log line', async () => {
    await put({ id: 'r1', kind: 'pr-merge', pr: { url: 'https://github.com/a/b/pull/1', files: 2, additions: 5, deletions: 1 } });
    const ap = createApprovals({ root, now: () => new Date('2026-11-02T01:00:00Z') });
    expect((await ap.list()).pending.map((x) => x.id)).toEqual(['r1']);
    const out = await ap.decide('r1', 'approved', 'ok', 'owner(hub)');
    expect(out.decision).toMatchObject({ status: 'approved', by: 'owner(hub)', note: 'ok', hook: 'none' });
    await expect(fs.access(path.join(root, 'approvals', 'pending', 'r1.json'))).rejects.toThrow();
    const dec = JSON.parse(await fs.readFile(path.join(root, 'approvals', 'decided', 'r1.json'), 'utf8')) as { decision: { status: string }; pr: unknown };
    expect(dec.decision.status).toBe('approved');
    expect(dec.pr).toMatchObject({ files: 2 });
    const log = (await fs.readFile(path.join(root, 'msg-approvals.log'), 'utf8')).trim().split('\n');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!)).toMatchObject({ id: 'r1', action: 'approved', by: 'owner(hub)' });
    // decided twice → 404 (no longer pending)
    await expect(ap.decide('r1', 'rejected', '', 'owner(hub)')).rejects.toMatchObject({ status: 404 });
    expect((await ap.list()).decided.map((x) => x.id)).toEqual(['r1']);
  });

  it('never decides a trading request (approve or reject) and logs the refusal', async () => {
    await put({ id: 't1', mode: 'trading', title: 'enable maker' });
    await put({ id: 't2', mode: 'msg', title: 'Go live with Cont' });
    await put({ id: 't3', mode: 'ops', kind: 'deploy', title: 'restart cblabx-lab on 8792' });
    const ap = createApprovals({ root });
    const list = await ap.list();
    expect(list.pending.every((x) => x.locked && x.lockedLabel === LOCKED_LABEL)).toBe(true);
    for (const id of ['t1', 't2', 't3']) {
      await expect(ap.decide(id, 'approved', '', 'owner(hub)')).rejects.toMatchObject({ status: 403 });
      await expect(ap.decide(id, 'rejected', '', 'owner(hub)')).rejects.toMatchObject({ status: 403 });
    }
    expect((await fs.readdir(path.join(root, 'approvals', 'pending'))).sort()).toEqual(['t1.json', 't2.json', 't3.json']);
    expect((await fs.readFile(path.join(root, 'msg-approvals.log'), 'utf8')).match(/refused/g)).toHaveLength(6);
  });

  it('runs an executor hook only when one is configured for the kind', async () => {
    await put({ id: 'd1', kind: 'deploy' });
    await put({ id: 'd2', kind: 'deploy' });
    const ran: string[] = [];
    const ap = createApprovals({ root, runHook: async (f, d) => { ran.push(`${path.basename(f)}:${path.basename(d)}`); } });
    await ap.decide('d1', 'approved', '', 'owner(hub)');
    expect(ran).toEqual([]);
    await fs.mkdir(path.join(root, 'approvals', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(root, 'approvals', 'hooks', 'deploy'), '#!/bin/sh\n', { mode: 0o755 });
    expect((await ap.decide('d2', 'approved', '', 'owner(hub)')).decision!.hook).toBe('launched');
    expect(ran).toEqual(['deploy:d2.json']);
  });
});

/* ───────── jobs ───────── */

describe('jobs: launch, list, stop, rerun', () => {
  let home: string;
  let procs: Map<number, ProcInfo>;
  let spawned: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
  let killed: number[];
  let nextPid: number;
  const mk = () => createJobs({
    home, now: () => Date.parse('2026-11-02T03:00:00Z'), selfPid: 10, parentPid: 9, secrets: [TOKEN],
    env: { PATH: '/bin', GITHUB_TOKEN: 'x', DECK_TOKEN_FILE: 'y', HOME: home },
    pickClaude: async () => 'c',
    spawnDetached: async (argv, o) => { const pid = nextPid++; spawned.push({ argv, cwd: o.cwd, env: o.env }); procs.set(pid, { pid, alive: true, startTime: `st${pid}`, cwd: o.cwd, cmdline: argv.join('\0'), cgroup: '0::/user.slice/x.scope' }); await fs.writeFile(o.logFile, 'started\n'); return pid; },
    proc: async (pid) => procs.get(pid) ?? null,
    kill: (pid) => { killed.push(pid); const p = procs.get(pid); if (p) p.alive = false; },
  });
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-jobs-'));
    await fs.mkdir(path.join(home, 'ai-msg'));
    procs = new Map(); spawned = []; killed = []; nextPid = 4000;
  });

  it('writes BRIEF.md with the rules, picks a Claude seat and launches detached', async () => {
    const jobs = mk();
    const { run, jobDir } = await jobs.create({ mode: 'msg', engine: 'claude', brief: 'Fix the README typo', title: 'README typo' });
    expect(jobDir).toBe('~/jobs/20261102-readme-typo');
    const dir = path.join(home, 'jobs', '20261102-readme-typo');
    const brief = await fs.readFile(path.join(dir, 'BRIEF.md'), 'utf8');
    expect(brief).toContain('Fix the README typo');
    expect(brief).toContain(RULES_MARKER);
    expect(brief).toContain('STATUS: DONE');
    expect(briefOnly(brief)).not.toContain('작업 규칙');
    expect(spawned[0]!.cwd).toBe(path.join(home, 'ai-msg'));
    expect(spawned[0]!.env.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude-c'));
    expect(spawned[0]!.env.GITHUB_TOKEN).toBeUndefined();
    expect(spawned[0]!.env.DECK_TOKEN_FILE).toBeUndefined();
    expect(spawned[0]!.argv.slice(-1)[0]).toBe('--dangerously-skip-permissions');
    expect(run).toMatchObject({ engine: 'claude', account: 'c', launchedByMsg: true, alive: true });
    expect(run.pids[0]).toMatchObject({ pid: 4000, source: 'msg', stoppable: true });
    expect(await fs.readFile(path.join(dir, 'pid.txt'), 'utf8')).toBe('4000\n');
    const meta = await fs.readFile(path.join(dir, 'msg-job.json'), 'utf8');
    expect(meta).not.toContain(TOKEN);
  });

  it('refuses trading briefs, trading modes, trading dirs and secrets', async () => {
    const jobs = mk();
    await expect(jobs.create({ mode: 'trading', engine: 'claude', brief: 'look at charts' })).rejects.toMatchObject({ status: 403 });
    await expect(jobs.create({ mode: 'quant', engine: 'claude', brief: 'hello' })).rejects.toMatchObject({ status: 403 });
    await expect(jobs.create({ mode: 'msg', engine: 'claude', brief: 'set ARMED=1 and restart' })).rejects.toMatchObject({ status: 403 });
    await expect(jobs.create({ mode: 'msg', engine: 'codex', brief: 'systemctl --user restart cblabx-sr' })).rejects.toMatchObject({ status: 403 });
    await expect(jobs.create({ mode: 'msg', engine: 'claude', brief: 'tidy', cwd: '~/arbitrage-nexus' })).rejects.toMatchObject({ status: 403 });
    await expect(jobs.create({ mode: 'msg', engine: 'claude', brief: 'tidy', cwd: '/etc' })).rejects.toMatchObject({ status: 403 });
    await expect(jobs.create({ mode: 'msg', engine: 'claude', brief: `use token=${'a'.repeat(20)}` })).rejects.toMatchObject({ status: 422 });
    expect(spawned).toHaveLength(0);
  });

  it('stops only verified PIDs with SIGTERM', async () => {
    const jobs = mk();
    const { run } = await jobs.create({ mode: 'msg', engine: 'codex', brief: 'Do a thing' });
    await jobs.stop(run.id, 4000);
    expect(killed).toEqual([4000]);
    // a PID not recorded for this job
    await expect(jobs.stop(run.id, 12345)).rejects.toMatchObject({ status: 404 });

    // a foreign job with a pid file: its process belongs to the job dir → stoppable; a recycled pid → not
    const other = path.join(home, 'jobs', 'manual');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'BRIEF.md'), '# Manual job\nwork');
    await fs.writeFile(path.join(other, 'pid.txt'), '5000\n');
    await fs.writeFile(path.join(other, 'soak.pid'), '5001\n');
    procs.set(5000, { pid: 5000, alive: true, startTime: 's', cwd: other, cmdline: 'claude\0-p', cgroup: '' });
    procs.set(5001, { pid: 5001, alive: true, startTime: 's', cwd: '/', cmdline: 'sshd', cgroup: '' });
    const it = await jobs.get('jobs:manual');
    expect(it.pids.find((p) => p.pid === 5000)!.stoppable).toBe(true);
    expect(it.pids.find((p) => p.pid === 5001)!.stoppable).toBe(false);
    await expect(jobs.stop('jobs:manual', 5001)).rejects.toMatchObject({ status: 403 });

    // a trading job is locked as a whole
    const tr = path.join(home, 'jobs', 'nexus-engine-fix');
    await fs.mkdir(tr);
    await fs.writeFile(path.join(tr, 'BRIEF.md'), '# reload\n');
    await fs.writeFile(path.join(tr, 'pid.txt'), '6000\n');
    procs.set(6000, { pid: 6000, alive: true, startTime: 's', cwd: tr, cmdline: 'x', cgroup: '' });
    await expect(jobs.stop('jobs:nexus-engine-fix', 6000)).rejects.toMatchObject({ status: 403 });
    await expect(jobs.rerun('jobs:nexus-engine-fix', 'claude')).rejects.toMatchObject({ status: 403 });

    // a process under a protected unit
    procs.set(5000, { pid: 5000, alive: true, startTime: 's', cwd: other, cmdline: 'python', cgroup: '0::/user.slice/user@1000.service/app.slice/cblabx-lab.service' });
    await expect(jobs.stop('jobs:manual', 5000)).rejects.toMatchObject({ status: 403 });
    expect(killed).toEqual([4000]);
  });

  it('does not signal a recycled MSG pid', async () => {
    const jobs = mk();
    const { run } = await jobs.create({ mode: 'msg', engine: 'claude', brief: 'x thing' });
    procs.get(4000)!.startTime = 'different';
    await expect(jobs.stop(run.id, 4000)).rejects.toMatchObject({ status: 403 });
    expect(killed).toEqual([]);
  });

  it('lists runs with STATUS, limit hits and engine; reruns with the same brief', async () => {
    const jobs = mk();
    const { run } = await jobs.create({ mode: 'video', engine: 'codex', brief: 'Render ep 4 thumbnails', cwd: '~/ai-msg' });
    const dir = path.join(home, 'jobs', run.name);
    procs.get(4000)!.alive = false;
    await fs.appendFile(path.join(dir, 'run.log'), 'ERROR: You’ve hit your usage limit. try again at Nov 4th, 2026 3:41 PM.\n');
    await fs.writeFile(path.join(dir, 'REPORT.md'), '# r\n요약\n\nSTATUS: BLOCKED: codex limit\n');
    await fs.mkdir(path.join(home, 'ai-msg-wt'));
    await fs.writeFile(path.join(home, 'ai-msg-wt', 'REPORT.md'), 'x\nSTATUS: DONE\n');
    await fs.writeFile(path.join(home, 'ai-msg-wt', 'account.txt'), 'b opus\n');
    const runs = await jobs.list();
    const r = runs.find((x) => x.id === run.id)!;
    expect(r).toMatchObject({ engine: 'codex', alive: false, limitHit: true, statusKind: 'blocked', status: 'BLOCKED: codex limit' });
    expect(runs.find((x) => x.id === 'wt:ai-msg-wt')).toMatchObject({ engine: 'claude', account: 'b', statusKind: 'done' });
    const again = await jobs.rerun(run.id, 'claude');
    expect(again.jobDir).toBe('~/jobs/20261102-render-ep-4-thumbnails-2');
    const b2 = await fs.readFile(path.join(home, 'jobs', '20261102-render-ep-4-thumbnails-2', 'BRIEF.md'), 'utf8');
    expect(b2.split(RULES_MARKER)).toHaveLength(2);
    expect(spawned[1]!.cwd).toBe(path.join(home, 'ai-msg'));
  });

  it('masks secrets in the log tail and report', async () => {
    const jobs = mk();
    const { run } = await jobs.create({ mode: 'msg', engine: 'claude', brief: 'x thing' });
    await fs.appendFile(path.join(home, 'jobs', run.name, 'run.log'), `leak ${TOKEN} and ghp_${'z'.repeat(30)}\n`);
    const { text } = await jobs.read(run.id, 'log');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('ghp_');
  });

  it('rejects path tricks in run ids', async () => {
    const jobs = mk();
    await expect(jobs.get('jobs:../x')).rejects.toMatchObject({ status: 400 });
    await expect(jobs.get('wt:ai-msg')).rejects.toMatchObject({ status: 400 });
    await expect(jobs.get('design:other')).rejects.toMatchObject({ status: 400 });
  });

  it('strips secret env vars', () => {
    expect(Object.keys(jobEnv({ PATH: 'x', OPENAI_API_KEY: 'k', DECK_X: 'd', MY_SECRET: 's', CLAUDECODE: '1', HOME: 'h' })).sort()).toEqual(['HOME', 'PATH']);
  });

  it('reads the last STATUS line', () => {
    expect(reportStatus('STATUS: BLOCKED: a\n...\n**STATUS: DONE**\n')).toEqual({ status: 'DONE', kind: 'done' });
    expect(reportStatus('nothing')).toEqual({ status: null, kind: 'none' });
  });
});

describe('bot tasks', () => {
  it('files a queued task and refuses trading bots and text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-task-'));
    const t = createBotTasks({ root, now: () => Date.parse('2026-11-02T03:00:00Z') });
    const out = await t.file({ bot: 'shorts', mode: 'video', text: 'Make 3 hooks for ep 5', by: 'owner(hub)' });
    expect(out.file).toMatch(/^~\/\.msg\/tasks\/shorts\/20261102T030000Z-make-3-hooks-for-ep-5\.json$/);
    const files = await fs.readdir(path.join(root, 'tasks', 'shorts'));
    expect(files).toEqual([`${out.id}.json`]);
    await expect(t.file({ bot: 'cblabx-sr', mode: 'msg', text: 'x', by: 'o' })).rejects.toMatchObject({ status: 403 });
    await expect(t.file({ bot: 'shorts', mode: 'trading', text: 'x', by: 'o' })).rejects.toMatchObject({ status: 403 });
    await expect(t.file({ bot: 'shorts', mode: 'video', text: 'go live now', by: 'o' })).rejects.toMatchObject({ status: 403 });
    await expect(t.file({ bot: '../x', mode: 'video', text: 'x', by: 'o' })).rejects.toMatchObject({ status: 400 });
    expect(await t.bots()).not.toContain('trading');
  });
});

/* ───────── HTTP: auth, same-origin, CSRF, confirm, logging ───────── */

describe('/api/hub/ctl over HTTP', () => {
  let server: http.Server;
  let base = '';
  let home: string;
  let spawnedN = 0;
  const cookie = `deck_session=${cookieValueFor(TOKEN)}`;
  const csrf = csrfFor(TOKEN);
  const post = (p: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-msg-csrf': csrf, 'x-msg-confirm': 'yes', ...h }, body: JSON.stringify(body) });

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-http-'));
    const root = path.join(home, '.msg');
    await fs.mkdir(path.join(root, 'approvals', 'pending'), { recursive: true });
    await fs.mkdir(path.join(home, 'ai-msg'));
    const w = (id: string, o: Record<string, unknown>) => fs.writeFile(path.join(root, 'approvals', 'pending', `${id}.json`), JSON.stringify({ id, from: 'bot', mode: 'msg', kind: 'generic', title: 'T', createdAt: '2026-11-02T00:00:00Z', ...o }));
    await w('ok1', { title: 'Merge docs' });
    await w('tr1', { mode: 'trading', title: 'enable' });
    const procs = new Map<number, ProcInfo>();
    const controls = createControls({
      root, home, token: TOKEN, modes: HUB_MODE_IDS, seats: () => [],
      approvals: createApprovals({ root }),
      tasks: createBotTasks({ root }),
      jobs: createJobs({ home, secrets: [TOKEN], pickClaude: async () => 'b', proc: async (p) => procs.get(p) ?? null, kill: () => undefined, spawnDetached: async (argv, o) => { spawnedN++; const pid = 7000 + spawnedN; procs.set(pid, { pid, alive: true, startTime: 's', cwd: o.cwd, cmdline: argv.join('\0'), cgroup: '' }); return pid; } }),
    });
    const roots = { a: path.join(home, 'a'), b: path.join(home, 'b'), c: path.join(home, 'c') };
    const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(home, 'p.json') });
    const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
    server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: home, usage, index, hub: { status: { status: async () => ({ host: 'h', generated_at: 'x', modes: [] }) }, controls } }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it('GET state needs the session and never carries the token', async () => {
    expect((await fetch(`${base}/api/hub/ctl/state`)).status).toBe(401);
    const res = await fetch(`${base}/api/hub/ctl/state`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text) as { csrf: string; approvals: { pending: { id: string; locked: string | null }[] }; modes: Record<string, { locked: boolean }> };
    expect(body.csrf).toBe(csrf);
    expect(body.approvals.pending.find((x) => x.id === 'tr1')!.locked).not.toBeNull();
    expect(body.modes.trading!.locked).toBe(true);
  });

  it('refuses mutations without cookie, same origin, CSRF or confirm', async () => {
    const path_ = '/api/hub/ctl/approvals/ok1/decide';
    expect((await post(path_, { decision: 'approve' }, { cookie: '' })).status).toBe(401);
    expect((await post(path_, { decision: 'approve' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(path_, { decision: 'approve' }, { 'x-msg-csrf': 'nope' })).status).toBe(403);
    expect((await post(path_, { decision: 'approve' }, { 'x-msg-confirm': '' })).status).toBe(428);
    expect((await post(path_, { decision: 'approve' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await fetch(`${base}${path_}`, { headers: { cookie } })).status).toBe(405);
  });

  it('approves a normal request and refuses a trading one, logging both', async () => {
    const ok = await post('/api/hub/ctl/approvals/ok1/decide', { decision: 'approve', note: 'lgtm' });
    expect(ok.status).toBe(200);
    const tr = await post('/api/hub/ctl/approvals/tr1/decide', { decision: 'approve' });
    expect(tr.status).toBe(403);
    expect(((await tr.json()) as { error: string }).error).toContain(LOCKED_LABEL);
    const log = await fs.readFile(path.join(home, '.msg', 'msg-actions.log'), 'utf8');
    expect(log).toContain('"action":"approval.decide","result":"ok"');
    expect(log).toContain('"result":"refused"');
    expect(log).not.toContain(TOKEN);
  });

  it('launches a job, refuses a trading brief, and never logs the brief text', async () => {
    const res = await post('/api/hub/ctl/jobs', { mode: 'msg', engine: 'claude', brief: 'Polish the hub cards copy', title: 'hub copy' });
    expect(res.status).toBe(201);
    const bad = await post('/api/hub/ctl/jobs', { mode: 'msg', engine: 'claude', brief: 'disarm all books' });
    expect(bad.status).toBe(403);
    const badMode = await post('/api/hub/ctl/jobs', { mode: 'trading', engine: 'claude', brief: 'hello' });
    expect(badMode.status).toBe(403);
    expect(spawnedN).toBe(1);
    const log = await fs.readFile(path.join(home, '.msg', 'msg-actions.log'), 'utf8');
    expect(log).not.toContain('Polish the hub cards copy');
    expect(log).toContain('briefSha');
  });

  it('serves runs, a log tail, and refuses stop for a PID that is not the job\'s', async () => {
    const res = await fetch(`${base}/api/hub/ctl/runs`, { headers: { cookie } });
    const { runs } = (await res.json()) as { runs: { id: string; pids: { pid: number }[] }[] };
    const r = runs[0]!;
    expect((await post(`/api/hub/ctl/runs/${r.id}/stop`, { pid: 1 })).status).toBe(404);
    expect((await post(`/api/hub/ctl/runs/${r.id}/stop`, { pid: r.pids[0]!.pid })).status).toBe(200);
    expect((await fetch(`${base}/api/hub/ctl/runs/jobs:..%2Fetc/log`, { headers: { cookie } })).status).toBe(404);
    // The UI encodes the id: `jobs%3A<name>` must reach the same run, and an encoded slash must still be refused.
    expect((await fetch(`${base}/api/hub/ctl/runs/${encodeURIComponent(r.id)}/brief`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/hub/ctl/runs/${encodeURIComponent('jobs:../etc')}/log`, { headers: { cookie } })).status).toBe(404);
  });
});

/* ───────── msg-approve CLI → the queue the hub reads ───────── */

describe('scripts/msg-approve', () => {
  it('files a request the hub lists, and reports the decision', async () => {
    const { execFileSync } = await import('node:child_process');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-cli-'));
    const cli = path.resolve('scripts/msg-approve.mjs');
    const env = { ...process.env, MSG_HOME: root };
    const id = execFileSync(process.execPath, [cli, 'request', '--title', 'Merge feat/x', '--kind', 'pr-merge', '--from', 'test-bot', '--pr-url', 'https://github.com/o/r/pull/1', '--files', '3', '--additions', '10', '--deletions', '2'], { env, encoding: 'utf8' }).trim();
    expect(execFileSync(process.execPath, [cli, 'status', id], { env, encoding: 'utf8' }).trim()).toBe('pending');
    const ap = createApprovals({ root });
    const [item] = (await ap.list()).pending;
    expect(item).toMatchObject({ id, kind: 'pr-merge', from: 'test-bot', pr: { files: 3, additions: 10, deletions: 2 }, locked: null });
    await ap.decide(id, 'rejected', 'not yet', 'owner(hub)');
    expect(execFileSync(process.execPath, [cli, 'status', id], { env, encoding: 'utf8' }).trim()).toBe('rejected\tnot yet');
    expect(() => execFileSync(process.execPath, [cli, 'request', '--title', 'x', '--link', 'javascript:alert(1)'], { env, stdio: 'pipe' })).toThrow();
  });
});
