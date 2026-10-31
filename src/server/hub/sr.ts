/**
 * `GET /api/hub/sr[?symbol=X]` — the 트레이딩룸 bot's support/resistance snapshot (:8830 `/api/sr`), read once a
 * minute, mapped to `SrSnapshot` and filtered per symbol here (one upstream read serves every picker choice). GET only;
 * nothing here can place, change or cancel anything. Field names that look like secrets never pass `stripSecrets`.
 */
import type { ServerResponse } from 'node:http';
import { SR_SYMBOL_RE, type SrRange, type SrSide, type SrSnapshot, type SrTimeframe } from '../../shared/sr-types';
import { HUB_TIMEOUTS, SLOW_CACHE_MS, errorText, isObj, num, scrub, slowCache, str, stripSecrets, toIso } from './shared';

export const SR_PREFIX = '/api/hub/sr';
export const SR_URL = 'http://127.0.0.1:8830/api/sr';
/** The bot's snapshot is rebuilt every few hours; a minute is plenty between reads. */
export const SR_CACHE_MS = 60_000;
export const SR_LIMITS = { ranges: 400, notes: 12, noteLen: 160, symbols: 200 } as const;

export class SrHttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export interface SrService {
  /** The snapshot, filtered to `symbol` when given (unknown symbol → 404). Throws SrHttpError (400/404/503). */
  get(symbol: string | null): Promise<SrSnapshot>;
}

export interface SrDeps { fetchJson: (url: string, timeoutMs: number) => Promise<unknown>; now?: () => number }

/* ───────── mapping ───────── */

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

/** The bot's `/api/sr` body → the panel's shape (unfiltered; `filterSr` narrows it). */
export function mapSr(body: unknown): SrSnapshot {
  const b = isObj(body) ? body : {};
  const ranges = (Array.isArray(b.ranges) ? b.ranges : []).map(rangeOf).filter((r): r is SrRange => r !== null).slice(0, SR_LIMITS.ranges);
  const listed = (Array.isArray(b.symbols) ? b.symbols : []).map((s) => (str(s) ?? '').toUpperCase()).filter((s) => SR_SYMBOL_RE.test(s));
  const symbols = [...new Set([...listed, ...ranges.map((r) => r.symbol)])].sort().slice(0, SR_LIMITS.symbols);
  const method = isObj(b.method) ? b.method : {};
  return stripSecrets({
    source: scrub((str(b.source, 400) ?? '').split('/').pop(), 120),
    snapshotAt: toIso(b.snapshot_mtime_kst), createdAt: toIso(b.created_at_kst), ageHours: num(b.snapshot_age_h),
    policy: scrub(b.policy, 200), schemaVersion: scrub(b.schema_version, 40),
    method: { tiers: scrub(method.tiers, 200), tfs: (Array.isArray(method.tfs) ? method.tfs : []).map(tfOf).filter((t): t is SrTimeframe => t !== null) },
    symbols, symbol: null, ranges, rangeCount: ranges.length,
    splitBuy: { reported: false, note: '트레이딩룸(:8830)이 분할매수 페이퍼 상태를 내보내지 않음 — 미보고' },
    generatedAt: toIso(b.generated_at),
  });
}

/** One symbol's zones out of the whole snapshot; null when the symbol is not in it. */
export function filterSr(all: SrSnapshot, symbol: string): SrSnapshot | null {
  if (!all.symbols.includes(symbol)) return null;
  const ranges = all.ranges.filter((r) => r.symbol === symbol);
  return { ...all, symbol, ranges, rangeCount: ranges.length };
}

/* ───────── service ───────── */

export function createSrService(deps: SrDeps): SrService {
  const now = deps.now ?? (() => Date.now());
  const cached = slowCache<SrSnapshot>(SR_CACHE_MS, async () => mapSr(await deps.fetchJson(SR_URL, HUB_TIMEOUTS.default)), now);
  return {
    async get(symbol) {
      if (symbol !== null && !SR_SYMBOL_RE.test(symbol)) throw new SrHttpError(400, 'symbol 은 영문 대문자·숫자 3–20자');
      const r = await cached();
      if (!r.value) throw new SrHttpError(503, `SR 스냅샷을 읽지 못했어요 · ${r.error ?? '오류'}`);
      const all = r.value;
      if (symbol === null) return all;
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
    res.end(JSON.stringify(body));
  };
  if (method !== 'GET') { send(405, { error: 'method not allowed' }); return; }
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
