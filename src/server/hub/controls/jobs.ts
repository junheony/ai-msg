/**
 * 다음 작업 + 실행 관리: launch a brief as a detached job (`~/jobs/<date>-<slug>/`), file a task for a bot, and list /
 * stop / rerun the jobs on this server (`~/jobs/*`, `~/msg-hub-design`, the `~/ai-msg-*` worktrees).
 *
 * A job folder holds BRIEF.md (with the REPORT/STATUS rule appended), run.log, pid.txt, account.txt and — when MSG
 * launched it — msg-job.json (engine, account, cwd, pid and its /proc start time). Stop sends SIGTERM to one PID only,
 * and only to a PID MSG launched (start time matches) or one recorded in that job's pid file whose process still
 * belongs to the job (its cwd or command line points into the job folder). Nothing here touches a trading process
 * (guard.ts), a ledger, or a secret.
 */
import { execFile, spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { engineArgv, isClaudeAccount, LIMIT_RE, type EngineId, CLAUDE_ACCOUNTS } from './engines';
import { forbiddenDir, forbiddenProcess, forbiddenReason, hasSecret, isLockedMode, LOCKED_LABEL, redact } from './guard';

export class JobError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** The marker the auto-appended rules start with; everything above it is the owner's brief. */
export const RULES_MARKER = '<!-- msg:rules -->';
export const MAX_BRIEF = 20_000;

/** Default working dir per mode (relative to home); absent = the job folder itself. */
export const MODE_CWD: Record<string, string> = { msg: 'ai-msg', video: 'engineering-shorts', game: 'games', yapping: 'yapping-bot' };
/** Default bot queue per mode for 봇에게. */
export const MODE_BOT: Record<string, string> = { msg: 'msg', video: 'shorts', game: 'game-studio', yapping: 'yapping', nexus: 'nexus', ops: 'ops', updown: 'updown' };
export const BOT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ProcInfo { pid: number; alive: boolean; startTime: string; cwd: string | null; cmdline: string; cgroup: string }

export interface JobsDeps {
  home: string;
  now?: () => number;
  /** Starts argv detached with stdout+stderr appended to `logFile`; resolves the child's PID. */
  spawnDetached?: (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }) => Promise<number>;
  /** `claude-pick --allow-protected-last` → a|b|c. */
  pickClaude?: () => Promise<string>;
  proc?: (pid: number) => Promise<ProcInfo | null>;
  kill?: (pid: number, sig: 'SIGTERM') => void;
  selfPid?: number;
  parentPid?: number;
  /** Exact values never shown (the login token). */
  secrets?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface MsgJobMeta {
  launchedBy: 'msg';
  engine: EngineId;
  account: string;
  mode: string;
  title: string;
  cwd: string;
  brief: string;
  pid: number;
  procStart: string | null;
  startedAt: string;
  rerunOf?: string;
}

export type RunRoot = 'jobs' | 'wt' | 'design';
export interface RunPid { pid: number; alive: boolean; source: 'msg' | 'pidfile'; file: string; stoppable: boolean; why: string | null }
export interface RunItem {
  id: string;
  root: RunRoot;
  name: string;
  /** `~/jobs/x` form (never an absolute home path). */
  path: string;
  title: string;
  mode: string | null;
  engine: EngineId | null;
  account: string | null;
  launchedByMsg: boolean;
  pids: RunPid[];
  alive: boolean;
  startedAt: string | null;
  endedAt: string | null;
  elapsedMs: number | null;
  status: string | null;
  statusKind: 'done' | 'blocked' | 'partial' | 'other' | 'none';
  limitHit: boolean;
  hasReport: boolean;
  hasLog: boolean;
  /** Why stop/rerun are off (a trading job), or null. */
  locked: string | null;
  cwd: string | null;
  updatedAt: string;
}

const tilde = (home: string, p: string) => (p === home ? '~' : p.startsWith(home + path.sep) ? `~/${p.slice(home.length + 1)}` : p);

export function slugify(text: string): string {
  const ascii = text.toLowerCase().normalize('NFKD').replace(/[^\x00-\x7f]/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return ascii || 'task';
}

export const kstDate = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');

export function rulesFooter(jobDir: string, cwd: string, home: string): string {
  return [
    '',
    RULES_MARKER,
    '## 작업 규칙 (MSG 다음 작업이 붙임)',
    `- 작업 폴더: \`${tilde(home, cwd)}\``,
    `- 끝나면 \`${tilde(home, jobDir)}/REPORT.md\` 를 쓴다. 맨 위에 짧은 한국어 요약, 마지막 줄은 \`STATUS: DONE\` 또는 \`STATUS: BLOCKED: <이유>\`.`,
    '- 트레이딩 제어는 하지 않는다: 무장/해제, 라이브 전환, 키, 보호 서비스 재시작, 원장 쓰기 모두 금지.',
    '- push·merge·배포·서비스 재시작이 필요하면 하지 말고 `msg-approve request` 로 승인함에 올린다.',
    '- 토큰·키 같은 비밀값을 파일·로그·리포트에 쓰지 않는다.',
    '',
  ].join('\n');
}

export const briefOnly = (text: string): string => { const i = text.indexOf(RULES_MARKER); return (i >= 0 ? text.slice(0, i) : text).trim(); };

export function agentPrompt(jobDir: string, cwd: string): string {
  return `Read ${jobDir}/BRIEF.md and carry it out completely. Work in ${cwd}. When finished write ${jobDir}/REPORT.md (short Korean summary on top) whose last line is "STATUS: DONE" or "STATUS: BLOCKED: <reason>".`;
}

/** The last `STATUS: …` line of a report. */
export function reportStatus(text: string): { status: string | null; kind: RunItem['statusKind'] } {
  const all = [...text.matchAll(/^[\s>*_`#-]*STATUS:\s*([^\n]*?)[\s*_`]*$/gim)];
  const last = all[all.length - 1]?.[1]?.trim();
  if (!last) return { status: null, kind: 'none' };
  const k = /^DONE\b/i.test(last) ? 'done' : /^BLOCKED\b/i.test(last) ? 'blocked' : /^PARTIAL\b/i.test(last) ? 'partial' : 'other';
  return { status: last.slice(0, 160), kind: k };
}

export function engineOfAccount(acct: string | null): { engine: EngineId | null; account: string | null } {
  if (!acct) return { engine: null, account: null };
  const a = acct.trim().toLowerCase();
  if (/^codex/.test(a)) return { engine: 'codex', account: 'codex' };
  if (/^hermes/.test(a)) return { engine: 'hermes', account: 'hermes' };
  const m = /^([abc])\b/.exec(a);
  if (m) return { engine: 'claude', account: m[1]! };
  return { engine: null, account: acct.trim().slice(0, 20) };
}

/* ───────── live defaults (/proc, spawn, claude-pick) ───────── */

export async function procInfo(pid: number): Promise<ProcInfo | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const state = rest[0] ?? '';
    const startTime = rest[19] ?? '';
    const [cmdline, cgroup, cwd] = await Promise.all([
      fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
      fs.readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => ''),
      fs.readlink(`/proc/${pid}/cwd`).catch(() => null),
    ]);
    return { pid, alive: state !== 'Z' && state !== 'X', startTime, cwd, cmdline, cgroup };
  } catch { return null; }
}

const liveSpawn = (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }): Promise<number> => new Promise((resolve, reject) => {
  const fd = fsSync.openSync(opts.logFile, 'a', 0o600);
  try {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', fd, fd] });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); if (child.pid) resolve(child.pid); else reject(new Error('no pid')); });
  } finally { fsSync.closeSync(fd); }
});

const livePick = (home: string) => (): Promise<string> => new Promise((resolve) => {
  execFile(path.join(home, '.local', 'bin', 'claude-pick'), ['--allow-protected-last'], { timeout: 15_000 }, (_err, stdout) => {
    const a = String(stdout ?? '').trim().split(/\s+/)[0] ?? '';
    resolve(isClaudeAccount(a) ? a : 'b');
  });
});

/** The server's environment minus anything secret-looking, for a launched agent. */
export function jobEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/TOKEN|SECRET|PASSW|API_KEY|PRIVATE|CREDENTIAL|^DECK_|^CLAUDECODE$|^CLAUDE_CODE_|^CLAUDE_CONFIG_DIR$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/* ───────── the service ───────── */

export function createJobs(deps: JobsDeps) {
  const home = path.resolve(deps.home);
  const now = deps.now ?? Date.now;
  const spawnDetached = deps.spawnDetached ?? liveSpawn;
  const pickClaude = deps.pickClaude ?? livePick(home);
  const proc = deps.proc ?? procInfo;
  const kill = deps.kill ?? ((pid: number, sig: 'SIGTERM') => { process.kill(pid, sig); });
  const selfPid = deps.selfPid ?? process.pid;
  const parentPid = deps.parentPid ?? process.ppid;
  const secrets = deps.secrets ?? [];
  const jobsDir = path.join(home, 'jobs');

  const readText = (f: string, max = 512 * 1024) => fs.readFile(f, 'utf8').then((t) => t.slice(0, max), () => null);
  const mtime = (f: string) => fs.stat(f).then((s) => s.mtimeMs, () => null);

  function resolveRun(id: string): { root: RunRoot; name: string; dir: string } {
    const m = /^(jobs|wt|design):([A-Za-z0-9][A-Za-z0-9._-]{0,120})$/.exec(id);
    if (!m) throw new JobError(400, '잘못된 실행 id');
    const root = m[1] as RunRoot, name = m[2]!;
    if (name.includes('..')) throw new JobError(400, '잘못된 실행 id');
    if (root === 'jobs') return { root, name, dir: path.join(jobsDir, name) };
    if (root === 'wt') { if (!name.startsWith('ai-msg-')) throw new JobError(400, '잘못된 실행 id'); return { root, name, dir: path.join(home, name) }; }
    if (name !== 'msg-hub-design') throw new JobError(400, '잘못된 실행 id');
    return { root, name, dir: path.join(home, name) };
  }

  async function readMeta(dir: string): Promise<MsgJobMeta | null> {
    const t = await readText(path.join(dir, 'msg-job.json'), 64 * 1024);
    if (!t) return null;
    try { const o = JSON.parse(t) as MsgJobMeta; return o && o.launchedBy === 'msg' && Number.isInteger(o.pid) ? o : null; } catch { return null; }
  }

  async function pidFiles(dir: string): Promise<{ pid: number; file: string }[]> {
    let names: string[] = [];
    try { names = (await fs.readdir(dir)).filter((n) => n === 'pid.txt' || /^[\w.-]+\.pid$/.test(n)); } catch { return []; }
    const out: { pid: number; file: string }[] = [];
    for (const n of names.slice(0, 8)) {
      const t = await readText(path.join(dir, n), 64);
      const pid = Number((t ?? '').trim());
      if (Number.isInteger(pid) && pid > 1) out.push({ pid, file: n });
    }
    return out;
  }

  const inside = (p: string | null, dir: string) => !!p && (p === dir || p.startsWith(dir + path.sep));

  /** Every PID this job owns, each with whether the hub may SIGTERM it and why not. */
  async function runPids(dir: string, meta: MsgJobMeta | null, locked: string | null): Promise<RunPid[]> {
    const seen = new Set<number>();
    const out: RunPid[] = [];
    const judge = (info: ProcInfo | null): string | null => {
      if (!info || !info.alive) return '종료됨';
      if (locked) return `${LOCKED_LABEL} · ${locked}`;
      return forbiddenProcess({ pid: info.pid, cmdline: info.cmdline, cgroup: info.cgroup, selfPid, parentPid });
    };
    if (meta) {
      seen.add(meta.pid);
      const info = await proc(meta.pid);
      let why = judge(info);
      // A recycled PID is somebody else's process now.
      if (!why && meta.procStart && info!.startTime !== meta.procStart) why = 'PID 가 재사용됨 (다른 프로세스)';
      out.push({ pid: meta.pid, alive: !!info?.alive, source: 'msg', file: 'msg-job.json', stoppable: !why, why });
    }
    for (const { pid, file } of await pidFiles(dir)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const info = await proc(pid);
      let why = judge(info);
      if (!why && !inside(info!.cwd, dir) && !info!.cmdline.includes(dir) && !(meta && inside(info!.cwd, meta.cwd))) why = '이 작업의 프로세스인지 확인할 수 없음';
      out.push({ pid, alive: !!info?.alive, source: 'pidfile', file, stoppable: !why, why });
    }
    return out;
  }

  async function runItem(root: RunRoot, name: string, dir: string): Promise<RunItem | null> {
    const [brief, report, acct, meta, logM, reportM, briefM, dirM] = await Promise.all([
      readText(path.join(dir, 'BRIEF.md'), 16 * 1024).then(async (t) => t ?? (await firstBrief(dir))),
      readText(path.join(dir, 'REPORT.md')),
      readText(path.join(dir, 'account.txt'), 64),
      readMeta(dir),
      mtime(path.join(dir, 'run.log')),
      mtime(path.join(dir, 'REPORT.md')),
      mtime(path.join(dir, 'BRIEF.md')),
      mtime(dir),
    ]);
    if (brief === null && report === null && logM === null && !meta) return null;
    const title = (meta?.title ?? (brief ? /^#\s+(.+)$/m.exec(brief)?.[1] : null) ?? name).trim().slice(0, 160);
    const { engine, account } = meta ? { engine: meta.engine, account: meta.account } : engineOfAccount(acct);
    const locked = (isLockedMode(meta?.mode) ? `mode ${meta!.mode}` : null) ?? forbiddenReason(name, title, meta ? meta.brief : brief ? briefOnly(brief).slice(0, 4000) : null);
    const pids = await runPids(dir, meta, locked);
    const alive = pids.some((p) => p.alive);
    const st = report ? reportStatus(report) : { status: null, kind: 'none' as const };
    let limitHit = false;
    if (logM !== null && now() - logM < 14 * 24 * 3600_000) {
      const t = await tailOf(path.join(dir, 'run.log'), 64 * 1024);
      limitHit = LIMIT_RE.test(t);
    }
    const startMs = meta ? Date.parse(meta.startedAt) : briefM ?? dirM;
    const endMs = alive ? null : (reportM ?? logM ?? null);
    const updated = Math.max(logM ?? 0, reportM ?? 0, briefM ?? 0, dirM ?? 0);
    return {
      id: `${root}:${name}`, root, name, path: tilde(home, dir), title, mode: meta?.mode ?? null, engine, account,
      launchedByMsg: !!meta, pids, alive,
      startedAt: startMs ? new Date(startMs).toISOString() : null,
      endedAt: endMs ? new Date(endMs).toISOString() : null,
      elapsedMs: startMs ? Math.max(0, (endMs ?? now()) - startMs) : null,
      status: st.status, statusKind: st.kind, limitHit, hasReport: report !== null, hasLog: logM !== null, locked,
      cwd: meta ? tilde(home, meta.cwd) : null,
      updatedAt: new Date(updated || now()).toISOString(),
    };
  }

  async function firstBrief(dir: string): Promise<string | null> {
    try {
      const n = (await fs.readdir(dir)).filter((x) => /^BRIEF[\w-]*\.md$/.test(x)).sort()[0];
      return n ? readText(path.join(dir, n), 16 * 1024) : null;
    } catch { return null; }
  }

  async function tailOf(file: string, bytes: number): Promise<string> {
    try {
      const fh = await fs.open(file, 'r');
      try {
        const st = await fh.stat();
        const start = Math.max(0, st.size - bytes);
        const buf = Buffer.alloc(st.size - start);
        await fh.read(buf, 0, buf.length, start);
        return buf.toString('utf8');
      } finally { await fh.close(); }
    } catch { return ''; }
  }

  async function candidates(): Promise<{ root: RunRoot; name: string; dir: string }[]> {
    const out: { root: RunRoot; name: string; dir: string }[] = [];
    const dirs = async (d: string) => { try { return (await fs.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
    for (const n of await dirs(jobsDir)) if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(n)) out.push({ root: 'jobs', name: n, dir: path.join(jobsDir, n) });
    for (const n of await dirs(home)) {
      if (/^ai-msg-[A-Za-z0-9._-]{1,100}$/.test(n)) out.push({ root: 'wt', name: n, dir: path.join(home, n) });
      if (n === 'msg-hub-design') out.push({ root: 'design', name: n, dir: path.join(home, n) });
    }
    return out;
  }

  async function launch(o: { mode: string; engine: EngineId; brief: string; title: string; cwd: string; rerunOf?: string }): Promise<{ run: RunItem; jobDir: string }> {
    const date = kstDate(now());
    const slug = slugify(o.title);
    await fs.mkdir(jobsDir, { recursive: true });
    let jobDir = '';
    for (let i = 1; i < 100; i++) {
      const cand = path.join(jobsDir, `${date}-${slug}${i > 1 ? `-${i}` : ''}`);
      try { await fs.mkdir(cand); jobDir = cand; break; } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
    }
    if (!jobDir) throw new JobError(409, '작업 폴더 이름을 정하지 못했습니다');
    const cwd = o.cwd || jobDir;
    const heading = /^#\s/m.test(o.brief) ? '' : `# ${o.title}\n\n`;
    await fs.writeFile(path.join(jobDir, 'BRIEF.md'), heading + o.brief.trim() + '\n' + rulesFooter(jobDir, cwd, home), { mode: 0o644 });
    let account: string = o.engine;
    const env = jobEnv(deps.env ?? process.env);
    if (o.engine === 'claude') {
      const a = await pickClaude();
      account = isClaudeAccount(a) ? a : 'b';
      env.CLAUDE_CONFIG_DIR = path.join(home, CLAUDE_ACCOUNTS[account as 'a' | 'b' | 'c']);
    }
    await fs.writeFile(path.join(jobDir, 'account.txt'), account + '\n');
    const pid = await spawnDetached(engineArgv(home, o.engine, agentPrompt(jobDir, cwd)), { cwd, env, logFile: path.join(jobDir, 'run.log') });
    const info = await proc(pid);
    const meta: MsgJobMeta = { launchedBy: 'msg', engine: o.engine, account, mode: o.mode, title: o.title, cwd, brief: o.brief.trim(), pid, procStart: info?.startTime ?? null, startedAt: new Date(now()).toISOString(), ...(o.rerunOf ? { rerunOf: o.rerunOf } : {}) };
    await fs.writeFile(path.join(jobDir, 'msg-job.json'), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
    await fs.writeFile(path.join(jobDir, 'pid.txt'), `${pid}\n`);
    const run = await runItem('jobs', path.basename(jobDir), jobDir);
    return { run: run!, jobDir };
  }

  function checkBrief(mode: string, title: string, brief: string): void {
    if (isLockedMode(mode)) throw new JobError(403, `${LOCKED_LABEL} · mode ${mode}`);
    const why = forbiddenReason(title, brief);
    if (why) throw new JobError(403, `${LOCKED_LABEL} · 트레이딩 제어로 보이는 내용 (${why})`);
    if (hasSecret(title) || hasSecret(brief)) throw new JobError(422, '비밀값처럼 보이는 문자열이 있습니다 — 빼고 다시 보내세요');
  }

  function resolveCwd(mode: string, cwd: string | undefined): string {
    const raw = (cwd ?? '').trim();
    if (!raw) { const d = MODE_CWD[mode]; return d ? path.join(home, d) : ''; }
    const abs = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw === '~' ? home : path.resolve(raw);
    const why = forbiddenDir(home, abs);
    if (why) throw new JobError(403, `이 폴더에서는 시작할 수 없습니다 (${why})`);
    return abs;
  }

  return {
    defaultCwd: (mode: string): string | null => (MODE_CWD[mode] ? `~/${MODE_CWD[mode]}` : null),
    async list(limit = 80): Promise<RunItem[]> {
      const items = (await Promise.all((await candidates()).map((c) => runItem(c.root, c.name, c.dir).catch(() => null)))).filter((x): x is RunItem => !!x);
      items.sort((a, b) => Number(b.alive) - Number(a.alive) || b.updatedAt.localeCompare(a.updatedAt));
      return items.slice(0, limit);
    },
    async get(id: string): Promise<RunItem> {
      const r = resolveRun(id);
      const it = await runItem(r.root, r.name, r.dir);
      if (!it) throw new JobError(404, '실행을 찾을 수 없습니다');
      return it;
    },
    /** run.log's last `bytes`, or REPORT.md — both with secrets masked. */
    async read(id: string, what: 'log' | 'report' | 'brief'): Promise<{ text: string; truncated: boolean }> {
      const r = resolveRun(id);
      if (what === 'log') {
        const t = await tailOf(path.join(r.dir, 'run.log'), 48 * 1024);
        const st = await fs.stat(path.join(r.dir, 'run.log')).catch(() => null);
        if (!st) throw new JobError(404, 'run.log 이 없습니다');
        return { text: redact(t, secrets), truncated: st.size > 48 * 1024 };
      }
      const t = what === 'report' ? await readText(path.join(r.dir, 'REPORT.md'), 256 * 1024) : (await readText(path.join(r.dir, 'BRIEF.md'), 64 * 1024)) ?? (await firstBrief(r.dir));
      if (t === null) throw new JobError(404, `${what === 'report' ? 'REPORT.md' : 'BRIEF.md'} 가 없습니다`);
      return { text: redact(t, secrets), truncated: t.length >= 256 * 1024 };
    },
    async create(o: { mode: string; engine: EngineId; brief: string; title?: string; cwd?: string }): Promise<{ run: RunItem; jobDir: string }> {
      const brief = o.brief.trim();
      if (!brief) throw new JobError(400, '할 일을 적어 주세요');
      if (brief.length > MAX_BRIEF) throw new JobError(413, '브리프가 너무 깁니다');
      const title = (o.title?.trim() || brief.split('\n').find((l) => l.trim())!.replace(/^#+\s*/, '')).slice(0, 120);
      checkBrief(o.mode, title, brief);
      const cwd = resolveCwd(o.mode, o.cwd);
      if (cwd) { const st = await fs.stat(cwd).catch(() => null); if (!st?.isDirectory()) throw new JobError(400, '작업 폴더가 없습니다'); }
      const res = await launch({ mode: o.mode, engine: o.engine, brief, title, cwd });
      return { ...res, jobDir: tilde(home, res.jobDir) };
    },
    async stop(id: string, pid: number): Promise<RunItem> {
      const it = await this.get(id);
      const p = it.pids.find((x) => x.pid === pid);
      if (!p) throw new JobError(404, '이 작업에 기록된 PID 가 아닙니다');
      if (!p.stoppable) throw new JobError(403, `멈출 수 없습니다 · ${p.why ?? ''}`);
      try { kill(pid, 'SIGTERM'); } catch (err) { throw new JobError(409, `신호를 보내지 못했습니다 (${(err as NodeJS.ErrnoException).code ?? 'error'})`); }
      return it;
    },
    async rerun(id: string, engine: EngineId): Promise<{ run: RunItem; jobDir: string }> {
      const r = resolveRun(id);
      const it = await this.get(id);
      if (it.locked) throw new JobError(403, `${LOCKED_LABEL} · ${it.locked}`);
      if (it.alive) throw new JobError(409, '아직 실행 중입니다 — 먼저 멈추세요');
      const meta = await readMeta(r.dir);
      const raw = meta?.brief ?? briefOnly((await readText(path.join(r.dir, 'BRIEF.md'), 64 * 1024)) ?? (await firstBrief(r.dir)) ?? '');
      if (!raw.trim()) throw new JobError(404, 'BRIEF.md 가 없습니다');
      const mode = meta?.mode ?? 'msg';
      checkBrief(mode, it.title, raw);
      const cwd = meta ? meta.cwd : r.dir;
      if (forbiddenDir(home, cwd)) throw new JobError(403, '이 폴더에서는 다시 실행할 수 없습니다');
      const res = await launch({ mode, engine, brief: raw, title: it.title, cwd, rerunOf: id });
      return { ...res, jobDir: tilde(home, res.jobDir) };
    },
  };
}

export type JobsService = ReturnType<typeof createJobs>;

/* ───────── 봇에게: a task file in the bot's queue (no outbound message) ───────── */

export function createBotTasks(o: { root: string; now?: () => number }) {
  const now = o.now ?? Date.now;
  const dir = path.join(o.root, 'tasks');
  return {
    async bots(): Promise<string[]> {
      let have: string[] = [];
      try { have = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && BOT_RE.test(e.name)).map((e) => e.name); } catch { /* none yet */ }
      return [...new Set([...have, ...Object.values(MODE_BOT)])].filter((b) => !forbiddenReason(b)).sort();
    },
    async file(t: { bot: string; mode: string; text: string; by: string }): Promise<{ id: string; file: string }> {
      if (!BOT_RE.test(t.bot)) throw new JobError(400, '봇 이름은 영문 소문자·숫자·- 로 적어 주세요');
      if (isLockedMode(t.mode)) throw new JobError(403, `${LOCKED_LABEL} · mode ${t.mode}`);
      const text = t.text.trim();
      if (!text) throw new JobError(400, '할 일을 적어 주세요');
      if (text.length > MAX_BRIEF) throw new JobError(413, '내용이 너무 깁니다');
      const why = forbiddenReason(t.bot, text);
      if (why) throw new JobError(403, `${LOCKED_LABEL} · 트레이딩 제어로 보이는 내용 (${why})`);
      if (hasSecret(text)) throw new JobError(422, '비밀값처럼 보이는 문자열이 있습니다 — 빼고 다시 보내세요');
      const q = path.join(dir, t.bot);
      await fs.mkdir(q, { recursive: true, mode: 0o700 });
      const ts = new Date(now()).toISOString();
      const id = `${ts.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${slugify(text.split('\n')[0]!)}`;
      const body = { id, bot: t.bot, mode: t.mode, text, createdAt: ts, by: t.by, status: 'queued' };
      const tmp = path.join(q, `.${id}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(tmp, path.join(q, `${id}.json`));
      return { id, file: `~/.msg/tasks/${t.bot}/${id}.json` };
    },
  };
}
