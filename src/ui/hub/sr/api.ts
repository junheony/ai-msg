/** The SR panel's two reads, both from MSG's own server: the bot's zones and public 1h candles for the distance column. */
import type { ReplayCandle, ReplayKlines } from '../../../shared/replay-types';
import type { SrSnapshot } from '../../../shared/sr-types';

export interface SrApi {
  /** `GET /api/hub/sr[?symbol=]` — unfiltered (the picker) or one symbol's zones. */
  sr(symbol: string | null): Promise<SrSnapshot>;
  /** Recent 1h futures candles for the symbol (newest last). */
  klines(symbol: string): Promise<ReplayCandle[]>;
}

export const SR_KLINE_INTERVAL = '1h';
export const SR_KLINE_LIMIT = 240;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `요청 실패 (${res.status})`);
  if (!body) throw new Error('빈 응답');
  return body;
}

export const liveSrApi: SrApi = {
  sr: (symbol) => getJson<SrSnapshot>(`/api/hub/sr${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`),
  klines: async (symbol) => (await getJson<ReplayKlines>(`/api/replay/klines?market=futures&symbol=${encodeURIComponent(symbol)}&interval=${SR_KLINE_INTERVAL}&limit=${SR_KLINE_LIMIT}`)).candles,
};
