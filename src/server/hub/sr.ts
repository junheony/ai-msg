/**
 * `GET /api/hub/sr[?symbol=X]` — the 트레이딩룸 bot's support/resistance snapshot (:8830 `/api/sr`) and its room status
 * (:8830 `/api/status`), read on two independent caches (a minute / half a minute), each keeping its last good answer
 * when a later read fails, mapped to `SrSnapshot` and filtered per symbol here (one upstream read serves every link).
 * GET only, fixed loopback URLs, no redirects, no credentials; nothing here can place, change or cancel anything.
 * Field names that look like secrets never pass `stripSecrets`; home paths never pass `scrub`.
 */
import type { ServerResponse } from 'node:http';
import { SR_SYMBOL_RE, type SrFeedMeta, type SrRange, type SrRoomStatus, type SrScalar, type SrSide, type SrSnapshot, type SrTimeframe } from '../../shared/sr-types';
import { HUB_TIMEOUTS, HUB_URLS, SECRET_FIELD_RE, SLOW_CACHE_MS, arr, bool, errorText, fetchLoopbackJson, isObj, num, scrub, slowCache, str, stripSecrets, toIso } from './shared';

export const SR_PREFIX = '/api/hub/sr';
export const SR_URL = 'http://127.0.0.1:8830/api/sr';
export const SR_STATUS_URL: string = HUB_URLS.trading;
/** The bot's snapshot is rebuilt every few hours; a minute is plenty between reads. The status feed moves faster. */
export const SR_CACHE_MS = 60_000;
export const SR_STATUS_CACHE_MS = 30_000;
export const SR_LIMITS = { ranges: 400, notes: 12, noteLen: 160, symbols: 200, extra: 40, coins: 40, alerts: 12 } as const;
/** The only two URLs the SR transport will ever GET. */
export const SR_ALLOWED_URLS: readonly string[] = [SR_URL, SR_STATUS_URL];

export class SrHttpError extends Error { constructor(public status: number, message: string) { super(message); } }
/** The feed answered, but not with an SR snapshot (or a status) — the previous value is kept, like a network failure. */
export class SrValidationError extends Error {}

export interface SrService {
  /** The snapshot, filtered to `symbol` when given (unknown symbol → 404). Throws SrHttpError (400/404/503). */
  get(symbol: string | null): Promise<SrSnapshot>;
}

export interface SrDeps { fetchJson: (url: string, timeoutMs: number) => Promise<unknown>; now?: () => number }

/** The production transport: GET one of the two fixed loopback URLs, no redirects, bounded body (see `fetchLoopbackJson`). */
export const fetchSrJson = (url: string, timeoutMs: number): Promise<unknown> => fetchLoopbackJson(SR_ALLOWED_URLS, url, timeoutMs, 'sr');

/* ───────── mapping: /api/sr ───────── */

const sideOf = (v: unknown): SrSide | null => (typeof v === 'string' ? (v.toUpperCase() === 'SUPPORT' ? 'support' : v.toUpperCase() === 'RESISTANCE' ? 'resistance' : null) : null);

function rangeOf(r: unknown): SrRange | null {
  if (!isObj(r)) return null;
  const symbol = (str(r.symbol) ?? '').toUpperCase();
  const side = sideOf(r.side);
  const low = num(r.low); const high = num(r.high);
  if (!SR_SYMBOL_RE.test(symbol) || !side || low === null || high === null || !(high >= low)) return null;
  const tfHits: Record<string, number> = {};
  if (isObj(r.tf_hits)) for (const [k, v] of Object.entries(r.tf_hits)) { const n = num(v); if (n !== null && /^[a-z0-9_]{1,16}$/i.test(k)) tfHits[k] = Math.max(0, Math.min(1, n)); }
  const tier = num(r.confidence_tier);
  return {
    id: scrub(r.range_id, 120) || `${symbol}_${side}_${low}_${high}`,
    symbol, side, low, high, mid: (low + high) / 2,
    score: num(r.score), tier: tier === null ? 1 : Math.max(1, Math.min(5, Math.round(tier))),
    tfHits, timeframe: scrub(r.timeframe, 60),
    createdAt: toIso(r.created_at), expiresAt: toIso(r.expires_at),
    invalidateBelow: num(r.invalidate_below), invalidateAbove: num(r.invalidate_above),
    notes: (Array.isArray(r.notes) ? r.notes : []).slice(0, SR_LIMITS.notes).map((n) => scrub(n, SR_LIMITS.noteLen)).filter(Boolean),
  };
}

function tfOf(t: unknown): SrTimeframe | null {
  if (!isObj(t)) return null;
  const tf = scrub(t.tf, 12);
  return tf ? { tf, profileDays: num(t.profile_days), pivotDays: num(t.pivot_days), weight: num(t.weight) } : null;
}

const FEED_NONE: SrFeedMeta = { endpoint: '', ok: false, stale: false, error: null, fetchedAt: null, lastGoodAt: null };

/** The SR feed's own split-buy rows, if it ever reports them (keys mentioning split-buy / DCA / 분할), else 미보고. */
const DCA_KEY_RE = /dca|split_?buy|분할/i;
const SPLITBUY_NOTE = '트레이딩룸(:8830)이 분할매수 페이퍼 상태를 내보내지 않음 — 미보고';

/** A reported value as text or a plain scalar; objects and arrays are not scalars. Home paths are blanked, length bounded. */
const scalarOf = (v: unknown): SrScalar | undefined => (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'boolean' ? v : typeof v === 'string' ? scrub(v, 120) : v === null ? null : undefined);
const safeKey = (k: string): boolean => k.length <= 40 && /^[\p{L}\p{N}_.\- ]+$/u.test(k) && !SECRET_FIELD_RE.test(k);

/** The bot's `/api/sr` body → the panel's shape (unfiltered; `filterSr` narrows it). Feeds and room are filled by the service. */
export function mapSr(body: unknown): SrSnapshot {
  const b = isObj(body) ? body : {};
  const ranges = (Array.isArray(b.ranges) ? b.ranges : []).map(rangeOf).filter((r): r is SrRange => r !== null).slice(0, SR_LIMITS.ranges);
  const listed = (Array.isArray(b.symbols) ? b.symbols : []).map((s) => (str(s) ?? '').toUpperCase()).filter((s) => SR_SYMBOL_RE.test(s));
  const symbols = [...new Set([...listed, ...ranges.map((r) => r.symbol)])].sort().slice(0, SR_LIMITS.symbols);
  const method = isObj(b.method) ? b.method : {};
  const splitRows: [string, string][] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!DCA_KEY_RE.test(k) || !safeKey(k)) continue;
    const s = scalarOf(v);
    if (s !== undefined && s !== null) splitRows.push([k, String(s)]);
    else if (isObj(v)) for (const [k2, v2] of Object.entries(v).slice(0, 12)) { const s2 = scalarOf(v2); if (safeKey(k2) && s2 !== undefined && s2 !== null) splitRows.push([`${k}.${k2}`, String(s2)]); }
  }
  return stripSecrets({
    source: scrub((str(b.source, 400) ?? '').split('/').pop(), 120),
    snapshotAt: toIso(b.snapshot_mtime_kst), createdAt: toIso(b.created_at_kst), ageHours: num(b.snapshot_age_h),
    policy: scrub(b.policy, 200), schemaVersion: scrub(b.schema_version, 40),
    method: { tiers: scrub(method.tiers, 200), tfs: (Array.isArray(method.tfs) ? method.tfs : []).map(tfOf).filter((t): t is SrTimeframe => t !== null) },
    symbols, symbol: null, ranges, rangeCount: ranges.length,
    splitBuy: splitRows.length ? { reported: true, rows: splitRows.slice(0, 12) } : { reported: false, note: SPLITBUY_NOTE },
    generatedAt: toIso(b.generated_at),
    feeds: { sr: { ...FEED_NONE, endpoint: '/api/sr' }, status: { ...FEED_NONE, endpoint: '/api/status' } },
    room: null,
  });
}

/** An SR body the cache may replace the last good one with: an object carrying a `ranges` list (empty is valid and clears). */
export function validSrBody(body: unknown): boolean { return isObj(body) && Array.isArray(body.ranges); }

/* ───────── mapping: /api/status ───────── */

const KNOWN_METRICS = new Set(['dwf_basket_count', 'dwf_basket_coins', 'dwf_watch_total', 'dwf_watch_mtime', 'shadow_heartbeat_age_s', 'shadow_files', 'onchain_alerts_count', 'last_onchain_alert_ts', 'onchain_alerts_source', 'dwf_maker_paper_enabled', 'dwf_maker_paper_mode', 'promotion_eligible', 'maker_universe_count', 'maker_updated_at', 'adaptive_paper_only', 'adaptive_live', 'maker_graft_smoke_rows', 'maker_graft_promotion_eligible', 'ops_docs_count', 'snapshot_age_h', 'snapshot_generated_at', 'sr_snapshot']);
/** Metric names that carry machine layout (file lists, paths) and never leave the server. */
const PATHY_METRIC_RE = /files?$|paths?$|_dir$|dirs?$/i;
const levelOf = (v: unknown): 'info' | 'warn' | 'bad' => { const s = typeof v === 'string' ? v.toLowerCase() : ''; return s === 'bad' || s === 'error' || s === 'critical' || s === 'crit' ? 'bad' : s === 'warn' || s === 'warning' ? 'warn' : 'info'; };

/** A `/api/status` body the cache may replace the last good one with. */
export function validStatusBody(body: unknown): boolean { return isObj(body) && (isObj(body.metrics) || typeof body.state === 'string' || typeof body.stage === 'string'); }

/** The bot's `/api/status` → the room status the SR / DCA section states. Nothing is invented: unreported = null. */
export function mapSrStatus(body: unknown): SrRoomStatus {
  const b = isObj(body) ? body : {};
  const m = isObj(b.metrics) ? b.metrics : {};
  const sr = isObj(m.sr_snapshot) ? m.sr_snapshot : null;
  const dcaRows: [string, SrScalar][] = [];
  const extra: [string, SrScalar][] = [];
  for (const [k, v] of Object.entries(m)) {
    if (KNOWN_METRICS.has(k) || !safeKey(k) || PATHY_METRIC_RE.test(k)) continue;
    const s = scalarOf(v);
    if (s === undefined) continue;
    (DCA_KEY_RE.test(k) ? dcaRows : extra).push([k, s]);
  }
  for (const [k, v] of Object.entries(b)) if (DCA_KEY_RE.test(k) && safeKey(k)) { const s = scalarOf(v); if (s !== undefined) dcaRows.push([k, s]); }
  return stripSecrets({
    state: scrub(b.state, 20) || null, stage: scrub(b.stage, 20) || null, generatedAt: toIso(b.generated_at), lastActivity: toIso(b.lastActivity),
    paper: {
      adaptivePaperOnly: bool(m.adaptive_paper_only), adaptiveLive: bool(m.adaptive_live), makerPaperEnabled: bool(m.dwf_maker_paper_enabled),
      makerPaperMode: scrub(m.dwf_maker_paper_mode, 20) || null, promotionEligible: bool(m.promotion_eligible), makerGraftPromotionEligible: bool(m.maker_graft_promotion_eligible),
    },
    srSnapshot: sr ? { endpoint: scrub(sr.endpoint, 40) || null, source: scrub((str(sr.source, 400) ?? '').split('/').pop(), 120) || null, mtime: toIso(sr.mtime), ageHours: num(sr.age_h), rangeCount: num(sr.range_count), symbolCount: num(sr.symbol_count), createdAt: toIso(sr.created_at_kst) } : null,
    snapshotAgeH: num(m.snapshot_age_h), snapshotGeneratedAt: toIso(m.snapshot_generated_at),
    maker: { universeCount: num(m.maker_universe_count), updatedAt: toIso(m.maker_updated_at), graftSmokeRows: num(m.maker_graft_smoke_rows) },
    onchain: { alertsCount: num(m.onchain_alerts_count), lastAlertAt: toIso(m.last_onchain_alert_ts), source: scrub(m.onchain_alerts_source, 40) || null },
    dwf: { basketCount: num(m.dwf_basket_count), watchTotal: num(m.dwf_watch_total), watchMtime: toIso(m.dwf_watch_mtime), basketCoins: arr(m.dwf_basket_coins).map((c) => scrub(c, 20)).filter((c) => /^[A-Z0-9_\-]{1,20}$/i.test(c)).slice(0, SR_LIMITS.coins) },
    shadowHeartbeatAgeS: num(m.shadow_heartbeat_age_s), opsDocsCount: num(m.ops_docs_count),
    alerts: arr(b.alerts).filter(isObj).slice(0, SR_LIMITS.alerts).map((a) => ({ level: levelOf(a.level), text: scrub(a.msg ?? a.text, 200), at: toIso(a.ts ?? a.at) })).filter((a) => a.text),
    dca: dcaRows.length ? { reported: true, rows: dcaRows.slice(0, 12) } : { reported: false, note: '/api/status 와 /api/sr 에 분할매수(DCA) 체결·단계 필드 없음 — stage·paper 플래그만 보고됨' },
    extra: extra.slice(0, SR_LIMITS.extra),
  });
}

/** One symbol's zones out of the whole snapshot; null when the symbol is not in it. */
export function filterSr(all: SrSnapshot, symbol: string): SrSnapshot | null {
  if (!all.symbols.includes(symbol)) return null;
  const ranges = all.ranges.filter((r) => r.symbol === symbol);
  return { ...all, symbol, ranges, rangeCount: ranges.length };
}

/* ───────── service ───────── */

/** A loader that keeps its own last-good bookkeeping; the body must pass `valid` or the previous value stays. */
function feed<T>(deps: SrDeps, url: string, endpoint: string, ttl: number, valid: (b: unknown) => boolean, map: (b: unknown) => T) {
  const now = deps.now ?? (() => Date.now());
  let lastGoodAt: string | null = null;
  const cached = slowCache<T>(ttl, async () => {
    const body = await deps.fetchJson(url, HUB_TIMEOUTS.default);
    if (!valid(body)) throw new SrValidationError('응답 형식 오류');
    const v = map(body);
    lastGoodAt = new Date(now()).toISOString();
    return v;
  }, now);
  return async (): Promise<{ value: T | null; meta: SrFeedMeta }> => {
    const r = await cached();
    return { value: r.value, meta: { endpoint, ok: r.value !== null, stale: r.value !== null && r.stale, error: r.error, fetchedAt: lastGoodAt, lastGoodAt } };
  };
}

export function createSrService(deps: SrDeps): SrService {
  const srFeed = feed(deps, SR_URL, '/api/sr', SR_CACHE_MS, validSrBody, mapSr);
  const statusFeed = feed(deps, SR_STATUS_URL, '/api/status', SR_STATUS_CACHE_MS, validStatusBody, mapSrStatus);
  return {
    async get(symbol) {
      if (symbol !== null && !SR_SYMBOL_RE.test(symbol)) throw new SrHttpError(400, 'symbol 은 영문 대문자·숫자 3–20자');
      // Independent: a silent status never hides the zones, a silent SR never hides the room's paper flags.
      const [sr, status] = await Promise.all([srFeed(), statusFeed()]);
      if (!sr.value && !status.value) throw new SrHttpError(503, `SR 스냅샷을 읽지 못했어요 · ${sr.meta.error ?? status.meta.error ?? '오류'}`);
      const base = sr.value ?? mapSr({ ranges: [] });
      const all: SrSnapshot = { ...base, feeds: { sr: sr.meta, status: status.meta }, room: status.value };
      if (symbol === null) return all;
      if (!sr.value) return { ...all, symbol, ranges: [], rangeCount: 0 };
      const one = filterSr(all, symbol);
      if (!one) throw new SrHttpError(404, `${symbol}: 스냅샷에 없는 심볼`);
      return one;
    },
  };
}

/** Serves one `/api/hub/sr` request (the caller has checked the login). */
export async function serveSr(service: SrService, url: URL, method: string | undefined, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown, maxAge = 0) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': maxAge > 0 ? `private, max-age=${maxAge}` : 'no-store' });
    res.end(JSON.stringify(stripSecrets(body)));
  };
  if (method !== 'GET') { res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'GET' }); res.end(JSON.stringify({ error: 'method not allowed' })); return; }
  const raw = url.searchParams.get('symbol');
  const symbol = raw === null || raw.trim() === '' ? null : raw.trim().toUpperCase();
  try {
    send(200, await service.get(symbol), 30);
  } catch (err) {
    if (err instanceof SrHttpError) { send(err.status, { error: err.message }); return; }
    send(503, { error: `SR 스냅샷을 읽지 못했어요 · ${errorText(err)}` });
  }
}

export { SLOW_CACHE_MS };
