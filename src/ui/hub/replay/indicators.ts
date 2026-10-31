/**
 * Indicator maths for the chart replay trainer — the textbook formulas, written here (no exchange or charting
 * library code). Every function takes the candle array and answers an array of the same length, `null` where the
 * indicator is not yet defined (warm-up), so the chart can align values with candles by index.
 */
import type { ReplayCandle } from '../../../shared/replay-types';

export type Series = (number | null)[];

const closes = (cs: readonly ReplayCandle[]): number[] => cs.map((c) => c.c);

/** Simple moving average over the last `n` values. */
export function smaOf(values: readonly number[], n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (n <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
export const sma = (cs: readonly ReplayCandle[], n: number): Series => smaOf(closes(cs), n);

/** Exponential moving average, k = 2/(n+1), seeded with the SMA of the first `n` values (the TradingView convention). */
export function emaOf(values: readonly number[], n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (n <= 0 || values.length < n) return out;
  const k = 2 / (n + 1);
  let seed = 0;
  for (let i = 0; i < n; i++) seed += values[i]!;
  let prev = seed / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) { prev = prev + k * (values[i]! - prev); out[i] = prev; }
  return out;
}
export const ema = (cs: readonly ReplayCandle[], n: number): Series => emaOf(closes(cs), n);

/** Wilder's RSI: the first averages are simple means of the first `n` changes, then avg = (prev·(n−1) + cur)/n. */
export function rsi(cs: readonly ReplayCandle[], n = 14): Series {
  const c = closes(cs);
  const out: Series = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  let gain = 0; let loss = 0;
  for (let i = 1; i <= n; i++) { const d = c[i]! - c[i - 1]!; if (d > 0) gain += d; else loss -= d; }
  let avgGain = gain / n; let avgLoss = loss / n;
  const value = () => (avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss));
  out[n] = value();
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!;
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value();
  }
  return out;
}

export interface MacdOut { macd: Series; signal: Series; hist: Series }
/** MACD = EMA(fast) − EMA(slow); signal = EMA(signalN) of MACD (seeded over its first `signalN` defined values). */
export function macd(cs: readonly ReplayCandle[], fast = 12, slow = 26, signalN = 9): MacdOut {
  const c = closes(cs);
  const f = emaOf(c, fast); const s = emaOf(c, slow);
  const line: Series = c.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  const first = line.findIndex((v) => v !== null);
  const signal: Series = new Array(c.length).fill(null);
  const hist: Series = new Array(c.length).fill(null);
  if (first >= 0) {
    const defined = line.slice(first) as number[];
    const sig = emaOf(defined, signalN);
    for (let j = 0; j < sig.length; j++) { const sv = sig[j]; if (sv !== null && sv !== undefined) { signal[first + j] = sv; hist[first + j] = defined[j]! - sv; } }
  }
  return { macd: line, signal, hist };
}

export interface BollingerOut { mid: Series; upper: Series; lower: Series }
/** Bollinger Bands: SMA(n) ± mult · population standard deviation over the same window. */
export function bollinger(cs: readonly ReplayCandle[], n = 20, mult = 2): BollingerOut {
  const c = closes(cs);
  const mid = smaOf(c, n);
  const upper: Series = new Array(c.length).fill(null);
  const lower: Series = new Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i++) {
    const m = mid[i]!;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) { const d = c[j]! - m; ss += d * d; }
    const sd = Math.sqrt(ss / n);
    upper[i] = m + mult * sd; lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

/** True range: max(h−l, |h−prevClose|, |l−prevClose|); the first bar uses h−l. */
export function trueRange(cs: readonly ReplayCandle[]): number[] {
  return cs.map((k, i) => (i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - cs[i - 1]!.c), Math.abs(k.l - cs[i - 1]!.c))));
}
/** Wilder's ATR: SMA of the first `n` true ranges, then atr = (prev·(n−1) + tr)/n. */
export function atr(cs: readonly ReplayCandle[], n = 14): Series {
  const tr = trueRange(cs);
  const out: Series = new Array(cs.length).fill(null);
  if (cs.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i++) seed += tr[i]!;
  let prev = seed / n;
  out[n - 1] = prev;
  for (let i = n; i < cs.length; i++) { prev = (prev * (n - 1) + tr[i]!) / n; out[i] = prev; }
  return out;
}

/**
 * Cumulative volume delta, approximated from the kline's taker-buy split: delta = buy − sell = 2·takerBuy − volume,
 * summed from the first candle. All null when the source has no taker split (Bybit fallback).
 */
export function cvd(cs: readonly ReplayCandle[]): Series {
  const out: Series = new Array(cs.length).fill(null);
  let acc = 0;
  for (let i = 0; i < cs.length; i++) {
    const k = cs[i]!;
    if (k.tb === null) return new Array(cs.length).fill(null);
    acc += 2 * k.tb - k.v;
    out[i] = acc;
  }
  return out;
}

export const volume = (cs: readonly ReplayCandle[]): Series => cs.map((c) => c.v);
