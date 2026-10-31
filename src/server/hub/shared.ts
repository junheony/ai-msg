/**
 * Shared ground for the hub collectors: the dependency surface a collector may touch (GET JSON from localhost,
 * read-only files, read-only `systemctl --user show`), formatting helpers, and the page-model builders.
 * Nothing here can run, trigger or change anything; nothing named like a secret ever leaves `stripSecrets`.
 */
import type { HubAlert, HubCardItem, HubChartSeries, HubImage, HubKpi, HubLevel, HubLink, HubMode, HubModeId, HubPage, HubSection, HubSource, HubStep } from '../../shared/hub-types';

export const HUB_CACHE_MS = 15_000;
/** Per-source timeouts (ms). The ops dashboard is slow by nature. */
export const HUB_TIMEOUTS = { default: 3_000, ops: 12_000, ssh: 8_000, psql: 8_000, py: 8_000, /** How long a first hub answer waits for a slow source before saying 불러오는 중 (the load goes on behind). */ firstWait: 4_000 } as const;
/** Slow sources keep their own answer this long (the hub cache is 15 s; ssh/psql/500 KB JSON should not run that often). */
export const SLOW_CACHE_MS = { ops: 60_000, ssh: 120_000, psql: 60_000, nexus: 20_000, quant: 60_000, /** ver2 equity (~6k rows) and trades/events: once a minute is plenty. */ ver2: 60_000 } as const;

/**
 * A tiny per-key cache for slow sources: the last good value is kept `ttlMs`; on a miss the loader runs once (callers
 * that race share the promise); a loader failure keeps the previous value (stale) and marks it `stale`.
 */
export interface SlowResult<T> { value: T | null; at: number | null; stale: boolean; error: string | null; /** No value yet and the load is still running (only with `waitMs`): the caller shows 불러오는 중, never an error. */ pending: boolean }
export function slowCache<T>(ttlMs: number, load: () => Promise<T>, clock: () => number = () => Date.now(), opts: { /** With no value yet, answer `pending` after this long instead of holding the whole hub answer (the load keeps running). */ waitMs?: number } = {}): () => Promise<SlowResult<T>> {
  let value: T | null = null; let at: number | null = null; let error: string | null = null; let inflight: Promise<void> | null = null;
  return async () => {
    const now = clock();
    if (at !== null && now - at < ttlMs && error === null) return { value, at, stale: false, error: null, pending: false };
    inflight ??= load().then((v) => { value = v; at = clock(); error = null; }, (err: unknown) => { error = errorText(err); if (at === null) at = clock(); }).finally(() => { inflight = null; });
    if (opts.waitMs !== undefined && value === null) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = await Promise.race([inflight.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), opts.waitMs); })]);
      if (timer !== null) clearTimeout(timer);
      if (!done) return { value: null, at, stale: false, error: null, pending: true };
    } else await inflight;
    return { value, at, stale: error !== null, error, pending: false };
  };
}
export const STALLED_S = 600;
export const IDLE_DAYS = 7;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const HUB_URLS = {
  printerStatus: 'http://127.0.0.1:8765/api/printer/status',
  updownBoard: 'http://127.0.0.1:3090/api/updown/board?asset=ALL&window=30d',
  updownRounds: 'http://127.0.0.1:3090/api/updown/rounds',
  nexusHome: 'http://127.0.0.1:3005/api/v2/home',
  yappingPosts: 'http://127.0.0.1:8095/api/posts',
  yappingNews: 'http://127.0.0.1:8095/api/ai_news',
  yappingYap: 'http://127.0.0.1:8095/api/yap',
  yappingReplies: 'http://127.0.0.1:8095/api/replies',
  nexus: 'http://127.0.0.1:8080/api/status',
  trading: 'http://127.0.0.1:8830/api/status',
  tradingHealth: 'http://127.0.0.1:8830/api/health',
  /** 트레이딩-ver2 paper engine (cblabx-paper) and its hash-chained ledger (cblabx-ledger): GET only. */
  paperHealth: 'http://127.0.0.1:8771/api/health',
  paperState: 'http://127.0.0.1:8771/api/paper/state',
  paperTrades: 'http://127.0.0.1:8771/api/paper/trades',
  paperEquity: 'http://127.0.0.1:8771/api/paper/equity',
  paperEvents: 'http://127.0.0.1:8771/api/paper/events',
  ledgerHealth: 'http://127.0.0.1:8793/health',
  ledgerRecords: 'http://127.0.0.1:8793/ledger?limit=40',
  ledgerStats: 'http://127.0.0.1:8793/ledger/stats',
  ledgerVerify: 'http://127.0.0.1:8793/ledger/verify',
  opsHealth: 'http://127.0.0.1:8765/api/health',
  ops: 'http://127.0.0.1:8765/api/ops',
  updown: 'http://127.0.0.1:3090/api/health',
  updownStaging: 'http://127.0.0.1:3198/api/health',
  quant: 'http://127.0.0.1:8810/api/snapshot.json',
  yappingStatus: 'http://127.0.0.1:8095/api/status',
  yappingMetrics: 'http://127.0.0.1:8095/api/metrics',
} as const;

/** Any field named like this is dropped from every mode, whatever a source sends. */
export const SECRET_FIELD_RE = /key|token|secret|vault|wallet|password|passwd|credential|cookie|authorization|bearer|seed|mnemonic/i;
/** Absolute home paths never leave the server (they would name the user and the machine layout). */
const HOME_PATH_RE = /(?:\/(?:home|Users)\/[^\s'"`)\]]+|~\/[^\s'"`)\]]+)/g;

/** One deck session for the MSG 터미널 page: no ids, no paths (the project is the folder's last name). */
export interface HubSelfSession { title: string; project: string; engine: 'claude' | 'codex' | 'gemini' | 'grok'; seat: string; lastModified: number; running: boolean; bg: number }
/** One seat's quota as the usage header knows it. Percentages are "used"; null = that window is not reported for this seat. */
export interface HubSelfSeat { id: string; label: string; status: 'ok' | 'stale' | 'down' | 'login' | 'cooldown' | 'unknown'; fiveHour: number | null; weekly: number | null; fable: number | null; resetsAt: string | null; weeklyResetsAt: string | null; note?: string }
export interface HubSelf {
  uptimeMs: number; sessions: number | null; activeTurns: number | null;
  /** Sessions touched in the last 24 h (all accounts, archived left out). */
  active24h?: number | null;
  /** Newest sessions first (bounded by the server; running ones first). */
  recent?: HubSelfSession[];
  /** Every seat with a usage card, in header order. */
  seats?: HubSelfSeat[];
}

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
  /** The last `maxBytes` of a text file (null when missing). */
  readTail: (file: string, maxBytes: number) => Promise<string | null>;
  /** Entry names of a folder (null when unreadable), dot-files excluded. */
  listDir: (dir: string) => Promise<string[] | null>;
  fileMtime: (file: string) => Promise<number | null>;
  /** `systemctl --user show <unit> -p …` as a key/value record; null when systemd is unavailable. Read-only. */
  systemdShow: (unit: string) => Promise<Record<string, string> | null>;
  /**
   * Run a read-only command (ssh probe, psql, python sqlite) with a time budget; resolves to its stdout, or null on any
   * failure (never throws). The hub only ever calls this with fixed argv lists, never shell strings; `env` adds to the
   * process env. Absent in tests that do not need it.
   */
  exec?: (cmd: string, args: string[], o: { timeoutMs: number; env?: Record<string, string>; stdin?: string }) => Promise<string | null>;
  now: () => number;
  self: () => HubSelf;
  host: string;
  home: string;
  /** Link-outs the server cannot derive. */
  links?: { nexus?: string };
}

export const DEFAULT_LINKS = { nexus: 'http://max-linuxserver.tail88e649.ts.net:3005' };

/* ───────── value helpers ───────── */

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
export const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const objs = (v: unknown): Record<string, unknown>[] => arr(v).filter(isObj);

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
export const isoMs = (iso: string | null): number | null => (iso ? Date.parse(iso) : null);
export const latestIso = (...v: (string | null)[]): string | null => {
  let best: string | null = null;
  for (const x of v) if (x && (!best || Date.parse(x) > Date.parse(best))) best = x;
  return best;
};

/** `Fri 2026-10-30 12:49:15 UTC` / `2026-10-30 22:05:14 KST` (systemd) → ISO; empty or `n/a` → null. */
export function parseSystemdTime(v: string | undefined): string | null {
  if (!v) return null;
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([A-Z]{2,5})?/.exec(v);
  if (!m) return null;
  const tz = m[3] === 'KST' || m[3] === 'JST' ? '+09:00' : m[3] === 'UTC' || m[3] === 'GMT' ? 'Z' : '+09:00';
  return toIso(`${m[1]}T${m[2]}${tz}`);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분`;
  return `${s}초`;
}
export const fmtAgo = (ms: number): string => `${fmtDuration(ms)} 전`;
export const agoFrom = (iso: string | null, nowMs: number): string => (iso ? fmtAgo(Math.max(0, nowMs - Date.parse(iso))) : '—');
export const fmtUsd = (v: number): string => (Math.abs(v) >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`);
export const fmtInt = (v: number): string => Math.round(v).toLocaleString('en-US');
export const fmtNum = (v: number, digits = 2): string => (Number.isInteger(v) ? fmtInt(v) : v.toLocaleString('en-US', { maximumFractionDigits: digits }));
export const fmtKrw = (v: number): string => (Math.abs(v) >= 1e8 ? `${(v / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 })}억` : `${fmtInt(v)}원`);
export const fmtPct = (v: number, digits = 1): string => `${v.toLocaleString('en-US', { maximumFractionDigits: digits })}%`;

const KST = 'Asia/Seoul';
const kstParts = (iso: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso))) out[p.type] = p.value;
  if (out.hour === '24') out.hour = '00';
  return out;
};
const validIso = (iso: string | null): iso is string => iso !== null && Number.isFinite(Date.parse(iso));
/** `10-30 21:49` in Seoul time; '—' for null. */
export const fmtKst = (iso: string | null): string => { if (!validIso(iso)) return '—'; const p = kstParts(iso); return `${p.month}-${p.day} ${p.hour}:${p.minute}`; };
/** `21:49` in Seoul time. */
export const fmtClock = (iso: string | null): string => { if (!validIso(iso)) return '—'; const p = kstParts(iso); return `${p.hour}:${p.minute}`; };
/** `2026-10-30` in Seoul time. */
export const fmtDate = (iso: string | null): string => { if (!validIso(iso)) return '—'; const p = kstParts(iso); return `${p.year}-${p.month}-${p.day}`; };

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

/** Free text from a source, with home paths blanked and length bounded. */
export const scrub = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(HOME_PATH_RE, '…').slice(0, max) : '');

/** A source's run as one record: the parsed JSON (or null) plus the source entry for the mode. */
export async function probe(deps: HubDeps, name: string, url: string, timeoutMs: number): Promise<{ data: unknown; source: HubSource }> {
  const t0 = deps.now();
  try {
    const data = await deps.fetchJson(url, timeoutMs);
    return { data, source: { name, ok: true, ms: deps.now() - t0 } };
  } catch (err) {
    return { data: null, source: { name, ok: false, ms: deps.now() - t0, error: errorText(err) } };
  }
}

export function downMode(id: HubModeId, name: string, source: HubSource, links: HubLink[] = []): HubMode {
  const why = source.error ?? '오류';
  return {
    id, name, state: 'down', lastActivity: null, metrics: {}, alerts: [{ level: 'bad', text: `응답 없음 · ${why}` }], links, sources: [source],
    page: { headline: `응답 없음 · ${why}`, decision: `${source.name} 응답 없음 — 서비스 가동 여부 확인`, kpis: [], sections: [] },
  };
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

/* ───────── systemd (read-only) ───────── */

export const SYSTEMD_PROPS = ['Id', 'LoadState', 'ActiveState', 'SubState', 'Result', 'NRestarts', 'ActiveEnterTimestamp', 'InactiveEnterTimestamp', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp', 'NextElapseUSecRealtime', 'LastTriggerUSec', 'TimersCalendar', 'Description'] as const;

export interface UnitInfo {
  unit: string;
  /** `missing` when systemd knows no such unit (or systemd is unavailable). */
  active: 'active' | 'activating' | 'inactive' | 'failed' | 'missing';
  sub: string;
  result: string | null;
  restarts: number | null;
  since: string | null;
  exitedAt: string | null;
  nextRun: string | null;
  lastRun: string | null;
}

export function unitInfo(unit: string, p: Record<string, string> | null): UnitInfo {
  if (!p || p.LoadState === 'not-found' || (!p.ActiveState && !p.LoadState)) return { unit, active: 'missing', sub: '', result: null, restarts: null, since: null, exitedAt: null, nextRun: null, lastRun: null };
  const a = p.ActiveState;
  const active: UnitInfo['active'] = a === 'active' || a === 'activating' || a === 'failed' ? a : a === 'reloading' ? 'active' : 'inactive';
  let nextRun = parseSystemdTime(p.NextElapseUSecRealtime);
  if (!nextRun && p.TimersCalendar) nextRun = parseSystemdTime(/next_elapse=([^}]+)/.exec(p.TimersCalendar)?.[1]);
  const restarts = p.NRestarts !== undefined && /^\d+$/.test(p.NRestarts) ? Number(p.NRestarts) : null;
  return {
    unit, active, sub: p.SubState ?? '', result: p.Result ?? null, restarts,
    since: parseSystemdTime(p.ActiveEnterTimestamp) ?? parseSystemdTime(p.InactiveEnterTimestamp),
    exitedAt: parseSystemdTime(p.ExecMainExitTimestamp), nextRun, lastRun: parseSystemdTime(p.LastTriggerUSec) ?? parseSystemdTime(p.ExecMainStartTimestamp),
  };
}

export async function showUnit(deps: HubDeps, unit: string): Promise<UnitInfo> {
  try { return unitInfo(unit, await deps.systemdShow(unit)); } catch { return unitInfo(unit, null); }
}

export const UNIT_STATE_KO: Record<UnitInfo['active'], string> = { active: '가동', activating: '시작 중', inactive: '정지', failed: '실패', missing: '없음' };

/* ───────── page builders ───────── */

export const kpi = (label: string, value: string, extra: Omit<HubKpi, 'label' | 'value'> = {}): HubKpi => ({ label, value, ...extra });
export const sec = {
  kv: (title: string, rows: [string, string][], o: { note?: string; open?: boolean } = {}): HubSection => ({ kind: 'kv', title, rows, ...o }),
  table: (title: string, columns: string[], rows: string[][], o: { note?: string; open?: boolean; num?: number[]; wrap?: number[] } = {}): HubSection => ({ kind: 'table', title, columns, rows, ...o }),
  cards: (title: string, items: HubCardItem[], o: { note?: string; open?: boolean; cols?: 2 | 3 } = {}): HubSection => ({ kind: 'cards', title, items, ...o }),
  chart: (title: string, x: string[], series: HubChartSeries[], o: { note?: string; open?: boolean; unit?: string; zero?: boolean; ymin?: number } = {}): HubSection => ({ kind: 'chart', title, x, series, ...o }),
  steps: (title: string, items: HubStep[], o: { note?: string; open?: boolean } = {}): HubSection => ({ kind: 'steps', title, items, ...o }),
  images: (title: string, items: HubImage[], o: { note?: string; open?: boolean } = {}): HubSection => ({ kind: 'images', title, items, ...o }),
  kvgrid: (title: string, rows: { label: string; desc?: string; value: string; sub?: string; status?: 'ok' | 'warn' | 'bad' | 'info' }[], o: { note?: string; open?: boolean } = {}): HubSection => ({ kind: 'kvgrid', title, rows, ...o }),
  list: (title: string, items: { text: string; level?: HubLevel | 'ok'; hint?: string; at?: string | null }[], o: { note?: string; open?: boolean } = {}): HubSection => ({ kind: 'list', title, items, ...o }),
  bars: (title: string, items: { label: string; value: number; text?: string }[], o: { note?: string; open?: boolean } = {}): HubSection => ({ kind: 'bars', title, items, ...o }),
  text: (title: string, body: string, o: { note?: string; open?: boolean } = {}): HubSection => ({ kind: 'text', title, body, ...o }),
  raw: (title: string, href: string, o: { note?: string; open?: boolean; embed?: boolean } = {}): HubSection => ({ kind: 'raw', title, href, ...o }),
};
export const page = (headline: string, decision: string, kpis: HubKpi[], sections: HubSection[]): HubPage => ({ headline, decision, kpis, sections });

/** Alerts sorted bad → warn → info, deduplicated by text. */
export function sortAlerts(alerts: HubAlert[]): HubAlert[] {
  const rank: Record<HubLevel, number> = { bad: 0, warn: 1, info: 2 };
  const seen = new Set<string>();
  return alerts.filter((a) => (seen.has(a.text) ? false : (seen.add(a.text), true))).sort((a, b) => rank[a.level] - rank[b.level]);
}
