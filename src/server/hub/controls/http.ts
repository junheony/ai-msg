/**
 * `/api/hub/ctl/*` — the hub's controls. The global handler already requires the session cookie and, for every
 * mutating method, a same-origin request. On top of that every POST here needs:
 *   - `x-msg-csrf`: the per-login value GET /api/hub/ctl/state hands out (an HMAC of the login token),
 *   - `x-msg-confirm: yes`: set by the UI's confirm dialog only after the owner pressed its confirm button,
 *   - a JSON body.
 * Every action — done or refused — is one line in `~/.msg/msg-actions.log` (approvals also in msg-approvals.log).
 * Nothing secret is ever in a response or a log line: briefs are logged by length and hash, never verbatim.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { ApprovalError, type ApprovalsService } from './approvals';
import { engineStates, isEngine, scanOpenAiLimit, suggestEngine, type EngineState, type SeatUsage } from './engines';
import { isLockedMode, LOCKED_LABEL, LOCKED_MODES } from './guard';
import { JobError, MODE_BOT, type createBotTasks, type JobsService } from './jobs';

export const CTL_PREFIX = '/api/hub/ctl/';

export interface ControlsDeps {
  /** `~/.msg` */
  root: string;
  home: string;
  token: string;
  approvals: ApprovalsService;
  jobs: JobsService;
  tasks: ReturnType<typeof createBotTasks>;
  seats: () => SeatUsage[];
  now?: () => number;
  /** Mode ids the hub knows (for defaults). */
  modes: readonly string[];
}

export const csrfFor = (token: string): string => createHmac('sha256', token).update('msg-hub-ctl').digest('hex');

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readJson(req: http.IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => { data += c.toString('utf8'); if (data.length > limit) { reject(new JobError(413, '요청이 너무 큽니다')); req.destroy(); } });
    req.on('end', () => { try { const o = JSON.parse(data || '{}') as unknown; resolve(o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}); } catch { reject(new JobError(400, 'JSON 이 아닙니다')); } });
    req.on('error', reject);
  });
}

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const s = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

export function createControls(deps: ControlsDeps) {
  const now = deps.now ?? Date.now;
  const csrf = csrfFor(deps.token);
  const actionLog = path.join(deps.root, 'msg-actions.log');
  const log = async (line: Record<string, unknown>) => {
    try {
      await fs.mkdir(deps.root, { recursive: true, mode: 0o700 });
      await fs.appendFile(actionLog, JSON.stringify({ ts: new Date(now()).toISOString(), by: 'owner(hub)', ...line }) + '\n', { mode: 0o600, flag: 'a' });
    } catch (err) { console.error('deck: hub action log write failed', err instanceof Error ? err.message : err); }
  };

  let engineCache: { at: number; states: EngineState[] } | null = null;
  const engines = async (): Promise<EngineState[]> => {
    if (engineCache && now() - engineCache.at < 30_000) return engineCache.states;
    const limit = await scanOpenAiLimit({ home: deps.home, now });
    const states = engineStates(limit, deps.seats());
    engineCache = { at: now(), states };
    return states;
  };

  async function state() {
    const [approvals, eng, bots] = await Promise.all([deps.approvals.list(), engines(), deps.tasks.bots()]);
    const modes = Object.fromEntries(deps.modes.map((m) => [m, { locked: isLockedMode(m), cwd: deps.jobs.defaultCwd(m), bot: MODE_BOT[m] ?? null, pending: approvals.pending.filter((a) => a.mode === m).length }]));
    return { csrf, home: deps.home, lockedLabel: LOCKED_LABEL, lockedModes: LOCKED_MODES, approvals, engines: eng, suggested: suggestEngine(eng), modes, bots };
  }

  /** Mutations: csrf + confirm + JSON, then the action. Errors keep their status; everything is logged. */
  async function mutate(req: http.IncomingMessage, res: http.ServerResponse, action: string, run: (body: Record<string, unknown>) => Promise<{ status?: number; body: unknown; log?: Record<string, unknown> }>) {
    const tok = s(req.headers['x-msg-csrf'], 128);
    if (!tok || !eq(tok, csrf)) { await log({ action, result: 'refused', reason: 'csrf' }); json(res, 403, { error: 'CSRF 확인 실패 — 페이지를 새로고침하세요' }); return; }
    if (req.headers['x-msg-confirm'] !== 'yes') { await log({ action, result: 'refused', reason: 'no-confirm' }); json(res, 428, { error: '확인 단계가 필요합니다' }); return; }
    if (!/^application\/json\b/i.test(s(req.headers['content-type']))) { json(res, 415, { error: 'JSON 으로 보내세요' }); return; }
    let body: Record<string, unknown> = {};
    try {
      body = await readJson(req);
      const out = await run(body);
      await log({ action, result: 'ok', ...out.log });
      json(res, out.status ?? 200, out.body);
    } catch (err) {
      const status = err instanceof JobError || err instanceof ApprovalError ? err.status : 500;
      const msg = status === 500 ? '서버 내부 오류' : (err as Error).message;
      if (status === 500) console.error('deck hub ctl:', action, err);
      await log({ action, result: 'refused', status, reason: msg.slice(0, 200) });
      json(res, status, { error: msg });
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const rest = url.pathname.slice(CTL_PREFIX.length);
    const method = req.method ?? 'GET';
    const get = method === 'GET';
    const post = method === 'POST';
    if (rest === 'state') { if (!get) return json(res, 405, { error: 'method not allowed' }); return json(res, 200, await state()); }
    if (rest === 'runs') { if (!get) return json(res, 405, { error: 'method not allowed' }); return json(res, 200, { runs: await deps.jobs.list() }); }

    let m = /^approvals\/([A-Za-z0-9._-]{1,80})\/decide$/.exec(rest);
    if (m) {
      if (!post) return json(res, 405, { error: 'method not allowed' });
      const id = m[1]!;
      return mutate(req, res, 'approval.decide', async (b) => {
        const decision = b.decision === 'approve' ? 'approved' : b.decision === 'reject' ? 'rejected' : null;
        if (!decision) throw new JobError(400, 'decision 은 approve 또는 reject');
        const item = await deps.approvals.decide(id, decision, s(b.note, 1000), 'owner(hub)');
        return { body: { item }, log: { id, decision, kind: item.kind, mode: item.mode } };
      });
    }
    if (rest === 'jobs') {
      if (!post) return json(res, 405, { error: 'method not allowed' });
      return mutate(req, res, 'job.launch', async (b) => {
        const mode = s(b.mode, 40);
        if (!deps.modes.includes(mode)) throw new JobError(400, '알 수 없는 모드');
        if (!isEngine(b.engine)) throw new JobError(400, '엔진을 고르세요');
        const eng = (await engines()).find((e) => e.id === b.engine)!;
        if (!eng.available) throw new JobError(409, `${eng.label} 는 지금 쓸 수 없습니다 · ${eng.reason ?? ''}`);
        const brief = s(b.brief, 25_000);
        const out = await deps.jobs.create({ mode, engine: b.engine, brief, title: s(b.title, 160), cwd: s(b.cwd, 400) });
        return { status: 201, body: out, log: { mode, engine: b.engine, account: out.run.account, job: out.jobDir, pid: out.run.pids[0]?.pid ?? null, briefLen: brief.length, briefSha: sha(brief) } };
      });
    }
    if (rest === 'tasks') {
      if (!post) return json(res, 405, { error: 'method not allowed' });
      return mutate(req, res, 'bot.task', async (b) => {
        const text = s(b.text, 25_000);
        const out = await deps.tasks.file({ bot: s(b.bot, 40), mode: s(b.mode, 40), text, by: 'owner(hub)' });
        return { status: 201, body: out, log: { bot: s(b.bot, 40), mode: s(b.mode, 40), file: out.file, textLen: text.length, textSha: sha(text) } };
      });
    }
    // The client encodes the id (`jobs%3A<name>`): decode the one segment, then validate the decoded id.
    m = /^runs\/([^/]{1,200})\/(log|report|brief|stop|rerun)$/.exec(rest);
    const runId = m ? (() => { try { return decodeURIComponent(m[1]!); } catch { return ''; } })() : '';
    if (m && /^(?:jobs|wt|design):[A-Za-z0-9._-]{1,120}$/.test(runId)) {
      const id = runId, op = m[2]!;
      if (op === 'log' || op === 'report' || op === 'brief') {
        if (!get) return json(res, 405, { error: 'method not allowed' });
        try { return json(res, 200, await deps.jobs.read(id, op)); } catch (err) { if (err instanceof JobError) return json(res, err.status, { error: err.message }); throw err; }
      }
      if (!post) return json(res, 405, { error: 'method not allowed' });
      if (op === 'stop') {
        return mutate(req, res, 'run.stop', async (b) => {
          const pid = typeof b.pid === 'number' ? b.pid : NaN;
          await deps.jobs.stop(id, pid);
          return { body: { ok: true, signal: 'SIGTERM', pid }, log: { run: id, pid, signal: 'SIGTERM' } };
        });
      }
      return mutate(req, res, 'run.rerun', async (b) => {
        if (!isEngine(b.engine)) throw new JobError(400, '엔진을 고르세요');
        const eng = (await engines()).find((e) => e.id === b.engine)!;
        if (!eng.available) throw new JobError(409, `${eng.label} 는 지금 쓸 수 없습니다 · ${eng.reason ?? ''}`);
        const out = await deps.jobs.rerun(id, b.engine);
        return { status: 201, body: out, log: { run: id, engine: b.engine, account: out.run.account, job: out.jobDir } };
      });
    }
    json(res, 404, { error: 'not found' });
  }

  return { handle, csrf, state };
}

export type ControlsService = ReturnType<typeof createControls>;
