/**
 * MSG Hub status aggregator: reads every mode's state from localhost (GET only, per-source timeouts), never throws,
 * and keeps the answer 15 s. Every collector picks explicit fields; nothing named like a secret ever leaves here.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HubAlert, HubLink, HubMetricValue, HubMode, HubModeId, HubSource, HubState, HubStatus } from '../../shared/hub-types';

export const HUB_CACHE_MS = 15_000;
/** Per-source timeouts (ms). The ops dashboard is slow by nature. */
export const HUB_TIMEOUTS = { default: 3_000, ops: 12_000 } as const;
const STALLED_S = 600;
const IDLE_DAYS = 7;
const DAY_MS = 86_400_000;

export const HUB_URLS = {
  nexus: 'http://127.0.0.1:8080/api/status',
  trading: 'http://127.0.0.1:8830/api/status',
  opsHealth: 'http://127.0.0.1:8765/api/health',
  ops: 'http://127.0.0.1:8765/api/ops',
  updown: 'http://127.0.0.1:3090/api/health',
  updownStaging: 'http://127.0.0.1:3198/api/health',
  quant: 'http://127.0.0.1:8810/api/snapshot.json',
} as const;

/** Any field named like this is dropped from every mode, whatever a source sends. */
export const SECRET_FIELD_RE = /key|token|secret|vault|wallet|password|passwd|credential|cookie|authorization|bearer|seed|mnemonic/i;

export interface HubSelf { uptimeMs: number; sessions: number | null; activeTurns: number | null }

export interface HubDeps {
  /** GET the URL and parse JSON; rejects on a network error, a non-2xx status or after `timeoutMs`. */
  fetchJson: (url: string, timeoutMs: number) => Promise<unknown>;
  /** Newest file under `dir` (recursive, bounded) whose folder is a render/output folder: its mtime and name. */
  latestRender: (dir: string) => Promise<{ mtimeMs: number; name: string } | null>;
  /** Number of entries in a folder, null when unreadable. */
  countEntries: (dir: string) => Promise<number | null>;
  /** `git log -1 --format=%cI` in `dir`; null when not a repo or git is missing. */
  gitLastCommit: (dir: string) => Promise<string | null>;
  /** A text file's content (null when missing). */
  readText: (file: string) => Promise<string | null>;
  fileMtime: (file: string) => Promise<number | null>;
  now: () => number;
  self: () => HubSelf;
  host: string;
  home: string;
  /** Link-outs the server cannot derive. */
  links?: { nexus?: string };
}

export const DEFAULT_LINKS = { nexus: 'http://max-linuxserver.tail88e649.ts.net:3005' };

/* ───────── small helpers ───────── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Epoch seconds, epoch ms or an ISO string → ISO; null for anything else. */
export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v < 1e11 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}
const isoMs = (iso: string | null): number | null => (iso ? Date.parse(iso) : null);
const latestIso = (...v: (string | null)[]): string | null => {
  let best: string | null = null;
  for (const x of v) if (x && (!best || Date.parse(x) > Date.parse(best))) best = x;
  return best;
};

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분`;
  return `${s}초`;
}
const fmtAgo = (ms: number): string => `${fmtDuration(ms)} 전`;
const fmtUsd = (v: number): string => (Math.abs(v) >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`);

/** Why a source failed, short and free of paths/hosts. */
export function errorText(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|timed out/i.test(msg)) return '시간 초과';
  const http = /\bHTTP (\d{3})/.exec(msg);
  if (http) return `HTTP ${http[1]}`;
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|EHOSTUNREACH/i.test(msg)) return '연결 실패';
  if (/JSON/i.test(msg)) return '응답 형식 오류';
  return '오류';
}

/** A source's run as one record: the parsed JSON (or null) plus the source entry for the mode. */
async function probe(deps: HubDeps, name: string, url: string, timeoutMs: number): Promise<{ data: unknown; source: HubSource }> {
  const t0 = deps.now();
  try {
    const data = await deps.fetchJson(url, timeoutMs);
    return { data, source: { name, ok: true, ms: deps.now() - t0 } };
  } catch (err) {
    return { data: null, source: { name, ok: false, ms: deps.now() - t0, error: errorText(err) } };
  }
}

function downMode(id: HubModeId, name: string, source: HubSource, links: HubLink[] = []): HubMode {
  return { id, name, state: 'down', lastActivity: null, metrics: {}, alerts: [{ level: 'bad', text: `응답 없음 · ${source.error ?? '오류'}` }], links, sources: [source] };
}

/** Drops every key named like a secret, recursively; never fails. */
export function stripSecrets<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripSecrets(x)) as T;
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET_FIELD_RE.test(k)) out[k] = stripSecrets(x);
    return out as T;
  }
  return v;
}

/* ───────── collectors ───────── */

function collectMsg(deps: HubDeps): HubMode {
  const self = deps.self();
  const metrics: Record<string, HubMetricValue> = { '가동 시간': fmtDuration(self.uptimeMs) };
  if (self.sessions !== null) metrics['세션'] = self.sessions;
  if (self.activeTurns !== null) metrics['실행 중 턴'] = self.activeTurns;
  return { id: 'msg', name: 'MSG 터미널', state: 'ok', lastActivity: new Date(deps.now()).toISOString(), metrics, alerts: [], links: [], sources: [{ name: 'self', ok: true, ms: 0 }] };
}

async function collectNexus(deps: HubDeps): Promise<HubMode> {
  const links: HubLink[] = [{ label: '대시보드', href: deps.links?.nexus ?? DEFAULT_LINKS.nexus }];
  const { data, source } = await probe(deps, 'engine /api/status', HUB_URLS.nexus, HUB_TIMEOUTS.default);
  if (!isObj(data)) return downMode('nexus', 'NEXUS', source, links);
  const running = data.running === true;
  const dry = data.dry_run === true;
  const strategies = isObj(data.strategies) ? Object.values(data.strategies).filter(isObj) : [];
  const enabled = strategies.filter((s) => s.enabled === true).length;
  const live = strategies.filter((s) => s.running === true).length;
  let lastScan: string | null = null;
  for (const s of strategies) lastScan = latestIso(lastScan, toIso(s.last_scan));
  const risk = isObj(data.risk) ? data.risk : {};
  const alerts: HubAlert[] = [];
  if (!running) alerts.push({ level: 'bad', text: '엔진 정지됨' });
  if (risk.emergency_stop === true) alerts.push({ level: 'bad', text: '비상 정지 활성' });
  if (risk.cooldown_active === true) alerts.push({ level: 'warn', text: '쿨다운 중' });
  const state: HubState = !running ? 'down' : alerts.length ? 'warn' : 'ok';
  const metrics: Record<string, HubMetricValue> = { '전략': `${live}/${enabled || strategies.length}`, '거래소': Array.isArray(data.exchanges) ? data.exchanges.length : null };
  const pos = num(risk.open_positions); if (pos !== null) metrics['열린 포지션'] = pos;
  const exp = num(risk.total_exposure_usd); if (exp !== null) metrics['노출'] = fmtUsd(exp);
  const pnl = num(risk.daily_pnl); if (pnl !== null) metrics['일간 손익'] = fmtUsd(pnl);
  return { id: 'nexus', name: 'NEXUS', state, lastActivity: lastScan ?? new Date(deps.now()).toISOString(), metrics, alerts, links, sources: [source], tag: dry ? 'DRY RUN' : 'LIVE' };
}

const TRADING_PICK: [string, string][] = [['dwf_basket_count', 'DWF 바스켓'], ['dwf_watch_total', '감시 종목'], ['shadow_heartbeat_age_s', '섀도 하트비트(s)'], ['onchain_alerts_count', '온체인 알림'], ['snapshot_age_h', '스냅샷 경과(h)'], ['promotion_eligible', '승격 가능']];

async function collectTrading(deps: HubDeps): Promise<HubMode> {
  const { data, source } = await probe(deps, 'trading /api/status', HUB_URLS.trading, HUB_TIMEOUTS.default);
  if (!isObj(data)) return downMode('trading', 'Trading Room', source);
  const state = (['ok', 'warn', 'down', 'idle', 'unknown'] as const).find((s) => s === data.state) ?? 'unknown';
  const m = isObj(data.metrics) ? data.metrics : {};
  const metrics: Record<string, HubMetricValue> = {};
  for (const [key, label] of TRADING_PICK) {
    const v = m[key];
    if (typeof v === 'number' || typeof v === 'boolean') metrics[label] = v;
  }
  if (Object.keys(metrics).length === 0) {
    for (const [k, v] of Object.entries(m)) {
      if (Object.keys(metrics).length >= 4) break;
      if (SECRET_FIELD_RE.test(k) || k.endsWith('_at') || k.endsWith('mtime')) continue;
      if (typeof v === 'number' || typeof v === 'boolean') metrics[k] = v;
    }
  }
  const alerts: HubAlert[] = [];
  if (Array.isArray(data.alerts)) {
    for (const a of data.alerts.slice(0, 5)) {
      if (typeof a === 'string') alerts.push({ level: 'warn', text: a.slice(0, 200) });
      else if (isObj(a) && typeof a.text === 'string') alerts.push({ level: a.level === 'bad' || a.level === 'info' ? a.level : 'warn', text: a.text.slice(0, 200), at: toIso(a.at ?? a.ts) });
    }
  }
  const stage = str(data.stage, 20);
  const sources: HubSource[] = [source];
  if (Array.isArray(data.sources)) sources.push({ name: `파일 ${data.sources.length}개`, ok: true, ms: 0 });
  return { id: 'trading', name: 'Trading Room', state, lastActivity: toIso(data.lastActivity) ?? toIso(data.generated_at), metrics, alerts, links: [], sources, ...(stage ? { tag: stage.toUpperCase() } : {}) };
}

async function collectVideo(deps: HubDeps): Promise<HubMode> {
  const dir = path.join(deps.home, 'engineering-shorts');
  const t0 = deps.now();
  const [latest, episodes] = await Promise.all([deps.latestRender(dir).catch(() => null), deps.countEntries(path.join(dir, 'episodes')).catch(() => null)]);
  const source: HubSource = { name: 'engineering-shorts', ok: latest !== null || episodes !== null, ms: deps.now() - t0, ...(latest === null && episodes === null ? { error: '폴더 없음' } : {}) };
  const metrics: Record<string, HubMetricValue> = {};
  if (episodes !== null) metrics['에피소드'] = episodes;
  let state: HubState = 'unknown';
  let lastActivity: string | null = null;
  if (latest) {
    const age = deps.now() - latest.mtimeMs;
    state = age > IDLE_DAYS * DAY_MS ? 'idle' : 'ok';
    lastActivity = new Date(latest.mtimeMs).toISOString();
    metrics['최근 렌더'] = fmtAgo(age);
    metrics['파일'] = latest.name;
  }
  return { id: 'video', name: '영상 스튜디오', state, lastActivity, metrics, alerts: [], links: [], sources: [source] };
}

const VERCEL_RE = /https:\/\/[a-z0-9-]+\.vercel\.app\b/i;

async function collectGame(deps: HubDeps): Promise<HubMode> {
  const dir = path.join(deps.home, 'games', 'neon-apex');
  const t0 = deps.now();
  const commit = toIso(await deps.gitLastCommit(dir).catch(() => null));
  const metrics: Record<string, HubMetricValue> = {};
  let lastActivity = commit;
  let sourceName = 'git log';
  if (!lastActivity) {
    sourceName = 'file mtime';
    const times = await Promise.all(['DEPLOYMENT.md', 'README.md', 'package.json'].map((f) => deps.fileMtime(path.join(dir, f)).catch(() => null)));
    const best = Math.max(...times.map((t) => t ?? 0));
    if (best > 0) lastActivity = new Date(best).toISOString();
  }
  const texts = await Promise.all(['DEPLOYMENT.md', 'README.md', 'vercel.json', 'production/vercel.json'].map((f) => deps.readText(path.join(dir, f)).catch(() => null)));
  let url: string | null = null;
  let verified: string | null = null;
  for (const t of texts) {
    if (!t) continue;
    url ??= VERCEL_RE.exec(t)?.[0] ?? null;
    verified ??= toIso(/Verified at:\s*([0-9T:.+-]+)/.exec(t)?.[1] ?? null);
  }
  const ok = lastActivity !== null || url !== null;
  const source: HubSource = { name: sourceName, ok, ms: deps.now() - t0, ...(ok ? {} : { error: '폴더 없음' }) };
  const age = lastActivity ? deps.now() - Date.parse(lastActivity) : null;
  if (age !== null) metrics[commit ? '마지막 커밋' : '마지막 변경'] = fmtAgo(age);
  if (verified) metrics['배포 검증'] = verified.slice(0, 10);
  metrics['배포'] = url ? 'Vercel' : '없음';
  const state: HubState = age === null ? 'unknown' : age > IDLE_DAYS * DAY_MS ? 'idle' : 'ok';
  return { id: 'game', name: '게임 스튜디오', state, lastActivity, metrics, alerts: [], links: url ? [{ label: 'Vercel', href: url }] : [], sources: [source] };
}

const OPS_ACCOUNTS = ['main', 'sub1', 'sub2', 'sub3'] as const;

/** Heartbeat age in seconds from whatever an account record offers (`heartbeat`, `heartbeat_at`, `heartbeat_age_s`, `last_seen`). */
function heartbeatAgeS(acct: Record<string, unknown>, nowMs: number): number | null {
  const age = num(acct.heartbeat_age_s ?? acct.heartbeat_age);
  if (age !== null) return age;
  const iso = toIso(acct.heartbeat ?? acct.heartbeat_at ?? acct.last_heartbeat ?? acct.last_seen ?? acct.ts);
  return iso ? Math.max(0, (nowMs - Date.parse(iso)) / 1000) : null;
}

async function collectOps(deps: HubDeps): Promise<HubMode> {
  const links: HubLink[] = [{ label: '열기', href: '/hub/p/ops/', embed: true }];
  const [health, ops] = await Promise.all([probe(deps, '/api/health', HUB_URLS.opsHealth, HUB_TIMEOUTS.default), probe(deps, '/api/ops', HUB_URLS.ops, HUB_TIMEOUTS.ops)]);
  const sources = [health.source, ops.source];
  if (!isObj(health.data) && !isObj(ops.data)) return { ...downMode('ops', 'OPS · 펍덱', health.source, links), sources };
  const h = isObj(health.data) ? health.data : null;
  const o = isObj(ops.data) ? ops.data : null;
  const alerts: HubAlert[] = [];
  const metrics: Record<string, HubMetricValue> = {};
  let state: HubState = h ? (h.ok === false ? 'warn' : 'ok') : 'warn';
  if (!h) alerts.push({ level: 'warn', text: '/api/health 응답 없음' });
  if (!o) alerts.push({ level: 'warn', text: `/api/ops 응답 없음 · ${ops.source.error ?? '오류'}` });
  let lastActivity = toIso(h?.ts) ?? null;
  if (o) {
    lastActivity = latestIso(lastActivity, toIso(o.generated_at));
    const services = isObj(o.services) ? Object.entries(o.services) : [];
    const active = services.filter(([, v]) => v === 'active').length;
    if (services.length) metrics['서비스'] = `${active}/${services.length}`;
    const printer = services.find(([k]) => k === 'risex-printer');
    if (printer && printer[1] !== 'active') { alerts.push({ level: 'warn', text: `risex-printer ${String(printer[1]).slice(0, 20)}` }); state = 'warn'; }
    const day = isObj(o.risex) && isObj(o.risex.day) ? o.risex.day : null;
    const vol = num(day?.volume); if (vol !== null) metrics['오늘 거래량'] = fmtUsd(vol);
    const cost = num(day?.cost); if (cost !== null) metrics['오늘 비용'] = fmtUsd(cost);
    const cycles = num(day?.cycles); if (cycles !== null) metrics['사이클'] = cycles;
    // Per-account printers, when the dashboard lists them (`accounts` / `printers` / top-level main, sub1…).
    const table = isObj(o.accounts) ? o.accounts : isObj(o.printers) ? o.printers : o;
    let seen = 0;
    for (const name of OPS_ACCOUNTS) {
      const acct = table[name];
      if (!isObj(acct)) continue;
      seen++;
      const age = heartbeatAgeS(acct, deps.now());
      const v = num(acct.volume ?? acct.volume_usd);
      const c = num(acct.cost ?? acct.cost_usd);
      const parts = [v !== null ? fmtUsd(v) : null, c !== null ? `비용 ${fmtUsd(c)}` : null].filter(Boolean);
      if (age !== null && age > STALLED_S) {
        alerts.push({ level: 'warn', text: `${name} 하트비트 정지 · ${fmtAgo(age * 1000)}` });
        state = 'warn';
        metrics[name] = `정지${parts.length ? ' · ' + parts.join(' · ') : ''}`;
      } else {
        metrics[name] = parts.length ? parts.join(' · ') : age !== null ? `정상 · ${Math.round(age)}s` : '정상';
      }
    }
    if (seen === 0 && services.length === 0 && vol === null) alerts.push({ level: 'info', text: '계정별 상태 없음' });
  }
  const mode = h ? str(h.mode, 20) : null;
  return { id: 'ops', name: 'OPS · 펍덱', state, lastActivity, metrics, alerts, links, sources, ...(mode ? { tag: mode.toUpperCase() } : {}) };
}

async function collectUpdown(deps: HubDeps): Promise<HubMode> {
  const [prod, staging] = await Promise.all([probe(deps, 'app :3090', HUB_URLS.updown, HUB_TIMEOUTS.default), probe(deps, 'staging :3198', HUB_URLS.updownStaging, HUB_TIMEOUTS.default)]);
  const sources = [prod.source, staging.source];
  if (!isObj(prod.data)) {
    const m = downMode('updown', 'UPDOWN', prod.source);
    if (isObj(staging.data)) m.metrics['스테이징'] = staging.data.ok === true ? '정상' : '주의';
    return { ...m, sources };
  }
  const p = prod.data;
  const alerts: HubAlert[] = [];
  let state: HubState = p.ok === true ? 'ok' : 'warn';
  if (p.ok !== true) alerts.push({ level: 'warn', text: '앱 상태 비정상' });
  const db = bool(p.db);
  if (db === false) { alerts.push({ level: 'bad', text: 'DB 연결 끊김' }); state = 'warn'; }
  const metrics: Record<string, HubMetricValue> = { '앱': p.ok === true ? '정상' : '주의', 'DB': db === null ? '미확인' : db ? '연결됨' : '끊김' };
  if (isObj(staging.data)) metrics['스테이징'] = staging.data.ok === true ? (staging.data.db === false ? 'DB 끊김' : '정상') : '주의';
  else metrics['스테이징'] = '응답 없음';
  const lastActivity = latestIso(toIso(p.ts), isObj(staging.data) ? toIso(staging.data.ts) : null) ?? new Date(deps.now()).toISOString();
  return { id: 'updown', name: 'UPDOWN', state, lastActivity, metrics, alerts, links: [], sources };
}

async function collectQuant(deps: HubDeps): Promise<HubMode> {
  const links: HubLink[] = [{ label: '열기', href: '/hub/p/quant/', embed: true }];
  const { data, source } = await probe(deps, 'snapshot.json', HUB_URLS.quant, HUB_TIMEOUTS.default);
  if (!isObj(data)) return downMode('quant', 'QUANT', source, links);
  const tabs = Array.isArray(data.tabs) ? data.tabs.filter(isObj) : [];
  let tiles = 0, warn = 0, bad = 0;
  for (const t of tabs) for (const s of Array.isArray(t.sections) ? t.sections.filter(isObj) : []) for (const it of Array.isArray(s.items) ? s.items.filter(isObj) : []) {
    tiles++;
    if (it.status === 'warn') warn++;
    else if (it.status === 'bad') bad++;
  }
  const errors = Array.isArray(data.errors) ? data.errors.filter((e): e is string => typeof e === 'string').slice(0, 5) : [];
  const alerts: HubAlert[] = errors.map((e) => ({ level: 'warn' as const, text: e.slice(0, 200) }));
  if (bad > 0) alerts.push({ level: 'bad', text: `타일 ${bad}개 장애` });
  const lastActivity = toIso(data.generated_at);
  const age = lastActivity ? deps.now() - Date.parse(lastActivity) : null;
  if (age !== null && age > DAY_MS) alerts.push({ level: 'warn', text: `스냅샷 ${fmtAgo(age)} 생성` });
  const state: HubState = bad > 0 || errors.length > 0 ? 'warn' : age !== null && age > DAY_MS ? 'idle' : age === null ? 'unknown' : 'ok';
  const metrics: Record<string, HubMetricValue> = { '탭': tabs.length, '타일': tiles, '주의 타일': warn + bad };
  if (age !== null) metrics['생성'] = fmtAgo(age);
  return { id: 'quant', name: 'QUANT', state, lastActivity, metrics, alerts, links, sources: [source] };
}

/* ───────── aggregate + cache ───────── */

const ORDER: HubModeId[] = ['msg', 'nexus', 'trading', 'video', 'game', 'ops', 'updown', 'quant'];
const NAMES: Record<HubModeId, string> = { msg: 'MSG 터미널', nexus: 'NEXUS', trading: 'Trading Room', video: '영상 스튜디오', game: '게임 스튜디오', ops: 'OPS · 펍덱', updown: 'UPDOWN', quant: 'QUANT' };

/** One pass over every source. A collector that throws (it should not) becomes an `unknown` card; this never rejects. */
export async function collectHubStatus(deps: HubDeps): Promise<HubStatus> {
  const runs: Record<HubModeId, () => Promise<HubMode> | HubMode> = {
    msg: () => collectMsg(deps), nexus: () => collectNexus(deps), trading: () => collectTrading(deps), video: () => collectVideo(deps),
    game: () => collectGame(deps), ops: () => collectOps(deps), updown: () => collectUpdown(deps), quant: () => collectQuant(deps),
  };
  const settled = await Promise.allSettled(ORDER.map(async (id) => runs[id]()));
  const modes = settled.map((r, i): HubMode => {
    const id = ORDER[i]!;
    if (r.status === 'fulfilled') return stripSecrets(r.value);
    return { id, name: NAMES[id], state: 'unknown', lastActivity: null, metrics: {}, alerts: [{ level: 'warn', text: `수집 실패 · ${errorText(r.reason)}` }], links: [], sources: [{ name: 'collector', ok: false, ms: 0, error: errorText(r.reason) }] };
  });
  return { modes, host: deps.host, generated_at: new Date(deps.now()).toISOString() };
}

export interface HubStatusService { status(): Promise<HubStatus> }

/**
 * `status()` answers from the last pass for `cacheMs`; after that one refresh runs (shared by concurrent callers) while
 * the previous answer is still handed out, so a slow source never holds the page. The first call waits.
 */
export function createHubStatus(deps: HubDeps, { cacheMs = HUB_CACHE_MS }: { cacheMs?: number } = {}): HubStatusService {
  let cached: HubStatus | null = null;
  let cachedAt = 0;
  let inflight: Promise<HubStatus> | null = null;
  const refresh = (): Promise<HubStatus> => {
    inflight ??= collectHubStatus(deps).then((s) => { cached = s; cachedAt = deps.now(); return s; }).finally(() => { inflight = null; });
    return inflight;
  };
  return {
    status() {
      if (cached && deps.now() - cachedAt < cacheMs) return Promise.resolve(cached);
      const p = refresh();
      return cached ? Promise.resolve(cached) : p;
    },
  };
}

/* ───────── real-world deps ───────── */

export async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' }, redirect: 'manual' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

const RENDER_DIR_RE = /^(render|renders|output|outputs|out|export|exports|final)$/i;
const MEDIA_RE = /\.(mp4|mov|webm|mkv|m4v|mp3|wav|m4a|png|jpg|jpeg|gif)$/i;
const SKIP_DIR_RE = /^(node_modules|\.git|\.venv.*|venv|dist|__pycache__|\.cache)$/;

/** The newest media file inside a render/output folder, at most `maxDepth` deep and `maxEntries` entries visited. */
export async function latestRenderIn(root: string, { maxDepth = 6, maxEntries = 20_000 }: { maxDepth?: number; maxEntries?: number } = {}): Promise<{ mtimeMs: number; name: string } | null> {
  let best: { mtimeMs: number; name: string } | null = null;
  let visited = 0;
  const walk = async (dir: string, depth: number, inRender: boolean): Promise<void> => {
    if (depth > maxDepth || visited > maxEntries) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++visited > maxEntries) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR_RE.test(e.name)) await walk(p, depth + 1, inRender || RENDER_DIR_RE.test(e.name)); continue; }
      if (!inRender || !e.isFile() || !MEDIA_RE.test(e.name)) continue;
      try {
        const st = await fs.stat(p);
        if (!best || st.mtimeMs > best.mtimeMs) best = { mtimeMs: st.mtimeMs, name: e.name };
      } catch { /* vanished */ }
    }
  };
  await walk(root, 0, false);
  return best;
}

export function gitLastCommitIso(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'log', '-1', '--format=%cI'], { timeout: 3000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(toIso(stdout.trim()));
    });
  });
}

/** Everything a live server needs; tests build their own `HubDeps`. */
export function liveHubDeps(opts: { home: string; host: string; self: () => HubSelf; links?: HubDeps['links'] }): HubDeps {
  return {
    fetchJson: fetchJsonWithTimeout,
    latestRender: (dir) => latestRenderIn(dir),
    countEntries: async (dir) => { try { return (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).length; } catch { return null; } },
    gitLastCommit: gitLastCommitIso,
    readText: async (file) => { try { return await fs.readFile(file, 'utf8'); } catch { return null; } },
    fileMtime: async (file) => { try { return (await fs.stat(file)).mtimeMs; } catch { return null; } },
    now: () => Date.now(),
    self: opts.self,
    host: opts.host,
    home: opts.home,
    ...(opts.links ? { links: opts.links } : {}),
  };
}
