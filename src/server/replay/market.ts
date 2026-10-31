/**
 * `/api/replay/*`: the chart replay trainer's market data, fetched server-side from public exchange endpoints (no keys)
 * because the page's CSP keeps the browser from talking to anything but MSG. GET only, an allowlist of four shapes,
 * every parameter validated before it reaches a URL, answers cached briefly. Binance first; Bybit v5 stands in for
 * klines when Binance refuses (451/403 geo blocks, 429) or is unreachable.
 */
import type { ServerResponse } from 'node:http';
import { isReplayInterval, type ReplayCandle, type ReplayFunding, type ReplayInterval, type ReplayKlines, type ReplayMarket, type ReplayOi, type ReplaySymbols } from '../../shared/replay-types';

export const REPLAY_PREFIX = '/api/replay/';
export const BINANCE_SPOT = 'https://api.binance.com';
export const BINANCE_FUTURES = 'https://fapi.binance.com';
export const BYBIT = 'https://api.bybit.com';

const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;
const OI_PERIODS = new Set(['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']);
const MAX_KLINES = 1000;
const MAX_OI = 500;
const MAX_FUNDING = 1000;
const TIMEOUT_MS = 8_000;
const CACHE_MS = { klines: 5 * 60_000, symbols: 60 * 60_000, other: 5 * 60_000 } as const;
const CACHE_MAX = 300;
const BYBIT_INTERVAL: Record<ReplayInterval, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ReplayHttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const num = (v: unknown): number => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; if (!Number.isFinite(n)) throw new ReplayHttpError(502, '거래소 응답 형식이 달라요'); return n; };
const asArr = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new ReplayHttpError(502, '거래소 응답 형식이 달라요'); return v; };

/** A Binance kline row → candle. Columns: open time, O, H, L, C, volume, close time, quote volume, trades, taker buy base, taker buy quote, ignore. */
export function fromBinanceKline(row: unknown): ReplayCandle {
  const r = asArr(row);
  return { t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]), q: num(r[7]), tb: num(r[9]) };
}
/** A Bybit v5 kline row → candle (no taker split, so `tb` is null). Columns: start, O, H, L, C, volume, turnover. */
export function fromBybitKline(row: unknown): ReplayCandle {
  const r = asArr(row);
  return { t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]), q: num(r[6]), tb: null };
}

/* ───────── parameter parsing (400 on anything off) ───────── */

function market(p: URLSearchParams): ReplayMarket {
  const m = p.get('market') ?? 'spot';
  if (m !== 'spot' && m !== 'futures') throw new ReplayHttpError(400, 'market 는 spot 또는 futures');
  return m;
}
function symbol(p: URLSearchParams): string {
  const s = (p.get('symbol') ?? '').toUpperCase();
  if (!SYMBOL_RE.test(s)) throw new ReplayHttpError(400, 'symbol 형식이 아니에요');
  return s;
}
function interval(p: URLSearchParams): ReplayInterval {
  const i = p.get('interval') ?? '1h';
  if (!isReplayInterval(i)) throw new ReplayHttpError(400, '지원하지 않는 interval');
  return i;
}
function intParam(p: URLSearchParams, name: string, max: number, dflt: number): number {
  const raw = p.get(name);
  if (raw === null || raw === '') return dflt;
  if (!/^\d{1,16}$/.test(raw)) throw new ReplayHttpError(400, `${name} 는 정수`);
  return Math.min(max, Math.max(1, Number(raw)));
}
function msParam(p: URLSearchParams, name: string): number | null {
  const raw = p.get(name);
  if (raw === null || raw === '') return null;
  if (!/^\d{1,16}$/.test(raw)) throw new ReplayHttpError(400, `${name} 는 밀리초 정수`);
  return Number(raw);
}

/* ───────── the fetcher with its cache ───────── */

interface Entry { at: number; value: unknown }

export interface MarketService {
  klines(p: URLSearchParams): Promise<ReplayKlines>;
  oi(p: URLSearchParams): Promise<ReplayOi>;
  funding(p: URLSearchParams): Promise<ReplayFunding>;
  symbols(p: URLSearchParams): Promise<ReplaySymbols>;
}

export function createMarketService(fetchImpl: FetchLike = (url, init) => fetch(url, init), clock: () => number = () => Date.now()): MarketService {
  const cache = new Map<string, Entry>();
  const remember = (key: string, value: unknown) => {
    if (cache.size >= CACHE_MAX) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
    cache.set(key, { at: clock(), value });
  };
  const cached = <T>(key: string, ttl: number): T | undefined => {
    const e = cache.get(key);
    if (!e) return undefined;
    if (clock() - e.at > ttl) { cache.delete(key); return undefined; }
    return e.value as T;
  };

  async function getJson(url: string): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'ai-msg replay trainer' } });
      if (!res.ok) {
        if (res.status === 400 || res.status === 404) throw new ReplayHttpError(400, '거래소가 모르는 심볼이거나 잘못된 요청이에요');
        if (res.status === 429 || res.status === 418) throw new ReplayHttpError(429, '거래소 요청 한도 · 잠시 후 다시');
        throw new ReplayHttpError(502, res.status === 451 || res.status === 403 ? '거래소가 이 지역을 차단했어요' : `거래소 응답 ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof ReplayHttpError) throw err;
      throw new ReplayHttpError(502, ctl.signal.aborted ? '거래소 응답이 너무 늦어요' : '거래소에 닿지 않아요');
    } finally { clearTimeout(timer); }
  }

  async function binanceKlines(m: ReplayMarket, s: string, i: ReplayInterval, start: number | null, end: number | null, limit: number): Promise<ReplayCandle[]> {
    const q = new URLSearchParams({ symbol: s, interval: i, limit: String(limit) });
    if (start !== null) q.set('startTime', String(start));
    if (end !== null) q.set('endTime', String(end));
    const url = m === 'spot' ? `${BINANCE_SPOT}/api/v3/klines?${q}` : `${BINANCE_FUTURES}/fapi/v1/klines?${q}`;
    return asArr(await getJson(url)).map(fromBinanceKline);
  }
  async function bybitKlines(m: ReplayMarket, s: string, i: ReplayInterval, start: number | null, end: number | null, limit: number): Promise<ReplayCandle[]> {
    const q = new URLSearchParams({ category: m === 'spot' ? 'spot' : 'linear', symbol: s, interval: BYBIT_INTERVAL[i], limit: String(Math.min(limit, 1000)) });
    if (start !== null) q.set('start', String(start));
    if (end !== null) q.set('end', String(end));
    const body = await getJson(`${BYBIT}/v5/market/kline?${q}`);
    const list = (body as { result?: { list?: unknown } } | null)?.result?.list;
    // Bybit lists newest first; the trainer wants oldest first like Binance.
    return asArr(list).map(fromBybitKline).sort((a, b) => a.t - b.t);
  }

  return {
    async klines(p) {
      const m = market(p); const s = symbol(p); const i = interval(p);
      const start = msParam(p, 'startTime'); const end = msParam(p, 'endTime'); const limit = intParam(p, 'limit', MAX_KLINES, 500);
      const key = `k:${m}:${s}:${i}:${start}:${end}:${limit}`;
      const hit = cached<ReplayKlines>(key, CACHE_MS.klines);
      if (hit) return hit;
      let out: ReplayKlines;
      try {
        out = { source: 'binance', market: m, symbol: s, interval: i, candles: await binanceKlines(m, s, i, start, end, limit) };
      } catch (err) {
        // A 400 from Binance (unknown symbol) is not retried elsewhere; a block, a limit or a dead link is.
        if (!(err instanceof ReplayHttpError) || err.status === 400) throw err;
        try { out = { source: 'bybit', market: m, symbol: s, interval: i, candles: await bybitKlines(m, s, i, start, end, limit) }; } catch { throw err; }
      }
      remember(key, out);
      return out;
    },
    async oi(p) {
      const s = symbol(p); const period = p.get('period') ?? '1h';
      if (!OI_PERIODS.has(period)) throw new ReplayHttpError(400, '지원하지 않는 period');
      const start = msParam(p, 'startTime'); const end = msParam(p, 'endTime'); const limit = intParam(p, 'limit', MAX_OI, 500);
      const key = `oi:${s}:${period}:${start}:${end}:${limit}`;
      const hit = cached<ReplayOi>(key, CACHE_MS.other);
      if (hit) return hit;
      const q = new URLSearchParams({ symbol: s, period, limit: String(limit) });
      if (start !== null) q.set('startTime', String(start));
      if (end !== null) q.set('endTime', String(end));
      const rows = asArr(await getJson(`${BINANCE_FUTURES}/futures/data/openInterestHist?${q}`));
      const out: ReplayOi = { symbol: s, period, points: rows.map((r) => { const o = r as Record<string, unknown>; return { t: num(o.timestamp), oi: num(o.sumOpenInterest), oiValue: num(o.sumOpenInterestValue) }; }) };
      remember(key, out);
      return out;
    },
    async funding(p) {
      const s = symbol(p);
      const start = msParam(p, 'startTime'); const end = msParam(p, 'endTime'); const limit = intParam(p, 'limit', MAX_FUNDING, 1000);
      const key = `f:${s}:${start}:${end}:${limit}`;
      const hit = cached<ReplayFunding>(key, CACHE_MS.other);
      if (hit) return hit;
      const q = new URLSearchParams({ symbol: s, limit: String(limit) });
      if (start !== null) q.set('startTime', String(start));
      if (end !== null) q.set('endTime', String(end));
      const rows = asArr(await getJson(`${BINANCE_FUTURES}/fapi/v1/fundingRate?${q}`));
      const out: ReplayFunding = { symbol: s, points: rows.map((r) => { const o = r as Record<string, unknown>; return { t: num(o.fundingTime), rate: num(o.fundingRate) }; }) };
      remember(key, out);
      return out;
    },
    async symbols(p) {
      const m = market(p);
      const key = `s:${m}`;
      const hit = cached<ReplaySymbols>(key, CACHE_MS.symbols);
      if (hit) return hit;
      const body = await getJson(m === 'spot' ? `${BINANCE_SPOT}/api/v3/exchangeInfo?permissions=SPOT` : `${BINANCE_FUTURES}/fapi/v1/exchangeInfo`);
      const rows = asArr((body as { symbols?: unknown } | null)?.symbols);
      const symbols = rows
        .map((r) => r as Record<string, unknown>)
        .filter((r) => r.quoteAsset === 'USDT' && r.status === 'TRADING' && (m === 'spot' || r.contractType === 'PERPETUAL') && typeof r.symbol === 'string' && SYMBOL_RE.test(r.symbol))
        .map((r) => r.symbol as string)
        .sort();
      const out: ReplaySymbols = { market: m, symbols };
      remember(key, out);
      return out;
    },
  };
}

/** Serves one `/api/replay/<kind>` request (GET only; the caller has checked the login). Unknown kinds answer 404. */
export async function serveReplay(service: MarketService, url: URL, method: string | undefined, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown, maxAge = 0) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': maxAge > 0 ? `private, max-age=${maxAge}` : 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (method !== 'GET') { send(405, { error: 'method not allowed' }); return; }
  const kind = url.pathname.slice(REPLAY_PREFIX.length);
  try {
    switch (kind) {
      case 'klines': send(200, await service.klines(url.searchParams), 60); return;
      case 'oi': send(200, await service.oi(url.searchParams), 60); return;
      case 'funding': send(200, await service.funding(url.searchParams), 300); return;
      case 'symbols': send(200, await service.symbols(url.searchParams), 3600); return;
      default: send(404, { error: 'not found' });
    }
  } catch (err) {
    if (err instanceof ReplayHttpError) { send(err.status, { error: err.message }); return; }
    send(502, { error: '거래소 자료를 읽지 못했어요' });
  }
}
