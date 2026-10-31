/** The trainer's data calls, all to MSG's own `/api/replay/*` (the server talks to the exchanges). */
import type { ReplayFunding, ReplayInterval, ReplayKlines, ReplayMarket, ReplayOi } from '../../../shared/replay-types';

export interface KlineQuery { market: ReplayMarket; symbol: string; interval: ReplayInterval; endTime?: number; startTime?: number; limit: number }

export interface ReplayApi {
  klines(q: KlineQuery): Promise<ReplayKlines>;
  /** Open time of the symbol's first candle at this interval; null when unknown. */
  earliest(market: ReplayMarket, symbol: string, interval: ReplayInterval): Promise<number | null>;
  oi(symbol: string, period: string, startTime: number, endTime: number): Promise<ReplayOi>;
  funding(symbol: string, startTime: number, endTime: number): Promise<ReplayFunding>;
  symbols(market: ReplayMarket): Promise<string[]>;
}

/** Shown when the symbol list cannot be loaded; the field stays editable either way. */
export const FALLBACK_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT'];

async function getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const res = await fetch(`/api/replay/${path}?${q}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `요청 실패 (${res.status})`);
  if (!body) throw new Error('빈 응답');
  return body;
}

export const liveReplayApi: ReplayApi = {
  klines: (q) => getJson<ReplayKlines>('klines', { market: q.market, symbol: q.symbol, interval: q.interval, endTime: q.endTime, startTime: q.startTime, limit: q.limit }),
  async earliest(market, symbol, interval) {
    const r = await getJson<ReplayKlines>('klines', { market, symbol, interval, startTime: 0, limit: 1 });
    return r.candles[0]?.t ?? null;
  },
  oi: (symbol, period, startTime, endTime) => getJson<ReplayOi>('oi', { symbol, period, startTime, endTime, limit: 500 }),
  funding: (symbol, startTime, endTime) => getJson<ReplayFunding>('funding', { symbol, startTime, endTime, limit: 1000 }),
  symbols: async (market) => (await getJson<{ symbols: string[] }>('symbols', { market })).symbols,
};
