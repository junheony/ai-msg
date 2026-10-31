/**
 * Chart replay trainer (Trading room): the shapes the `/api/replay/*` market proxy answers with and the UI reads.
 * Candles are normalised from Binance (or the Bybit fallback) so the client never sees an exchange's raw rows.
 */

export type ReplayMarket = 'spot' | 'futures';
export type ReplaySource = 'binance' | 'bybit';

/** Exchange intervals the trainer offers (a subset of what Binance supports). */
export const REPLAY_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type ReplayInterval = (typeof REPLAY_INTERVALS)[number];
export const REPLAY_INTERVAL_MS: Record<ReplayInterval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
export const isReplayInterval = (v: unknown): v is ReplayInterval => typeof v === 'string' && (REPLAY_INTERVALS as readonly string[]).includes(v);

/** One closed candle. `tb` (taker-buy base volume) is null when the source does not report it (Bybit): CVD is then unavailable. */
export interface ReplayCandle { t: number; o: number; h: number; l: number; c: number; v: number; q: number; tb: number | null }

export interface ReplayKlines { source: ReplaySource; market: ReplayMarket; symbol: string; interval: ReplayInterval; candles: ReplayCandle[] }

/** Open-interest history point (Binance futures, last 30 days only) — `oi` in contracts (base), `oiValue` in USDT. */
export interface ReplayOiPoint { t: number; oi: number; oiValue: number }
export interface ReplayOi { symbol: string; period: string; points: ReplayOiPoint[] }

/** Funding settlement (every 8 h): rate as a fraction (0.0001 = 0.01 %). */
export interface ReplayFundingPoint { t: number; rate: number }
export interface ReplayFunding { symbol: string; points: ReplayFundingPoint[] }

export interface ReplaySymbols { market: ReplayMarket; symbols: string[] }
