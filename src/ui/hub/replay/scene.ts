/**
 * A replay scene: the window of candles the trainer plays through. Warm-up candles feed the indicators, the visible
 * window is what the player sees at the start, the future is revealed round by round, and a short tail shows what
 * came after the last call. One kline request (≤ 1000 candles) covers all of it.
 */
import { REPLAY_INTERVAL_MS, type ReplayInterval } from '../../../shared/replay-types';

export const WARMUP = 200;
export const VISIBLE = 120;
export const TAIL = 40;
export const MAX_CANDLES = 1000;
export const HORIZONS = [1, 3, 5, 10, 20] as const;
export const ROUND_COUNTS = [5, 10, 20] as const;

export interface ScenePlan {
  /** Index of the last candle visible when play begins. */
  startIndex: number;
  /** Candles to request, and the `endTime` (ms, inclusive) to request them up to. */
  limit: number;
  endTime: number;
  /** Open time (ms) of the candle at `startIndex`. */
  playStartT: number;
}

export const futureCandles = (horizon: number, rounds: number): number => horizon * rounds + TAIL;
export const sceneCandles = (horizon: number, rounds: number): number => WARMUP + VISIBLE + futureCandles(horizon, rounds);

/**
 * Plans a scene whose play starts at `playStartT` (open time of the last visible candle). The request ends at the last
 * future candle; the start index is fixed by the warm-up and visible counts.
 */
export function planAt(playStartT: number, interval: ReplayInterval, horizon: number, rounds: number): ScenePlan {
  const ms = REPLAY_INTERVAL_MS[interval];
  const limit = Math.min(MAX_CANDLES, sceneCandles(horizon, rounds));
  const future = futureCandles(horizon, rounds);
  return { startIndex: WARMUP + VISIBLE - 1, limit, endTime: playStartT + future * ms + ms - 1, playStartT };
}

/**
 * Picks a random play start between the symbol's first candle (plus warm-up and visible window) and now (minus the
 * future). Null when the symbol's history is too short for a full scene. `random` is `Math.random`-shaped.
 */
export function randomPlayStart(earliestT: number, nowT: number, interval: ReplayInterval, horizon: number, rounds: number, random: () => number = Math.random): number | null {
  const ms = REPLAY_INTERVAL_MS[interval];
  const lo = earliestT + (WARMUP + VISIBLE) * ms;
  const hi = nowT - (futureCandles(horizon, rounds) + 1) * ms;
  if (hi <= lo) return null;
  const span = Math.floor((hi - lo) / ms);
  return lo + Math.floor(random() * (span + 1)) * ms;
}

/** Snaps a user-picked date to a candle open time on the interval's grid (UTC-aligned like the exchange). */
export function snapToInterval(t: number, interval: ReplayInterval): number {
  const ms = REPLAY_INTERVAL_MS[interval];
  return Math.floor(t / ms) * ms;
}

/**
 * Checks a fetched window against its plan. The start index is counted back from the end of the fetched array so a
 * short answer (the symbol listed recently) still leaves the full future; it fails only when there is no room for the
 * visible window and at least part of the warm-up.
 */
export function startIndexFor(length: number, horizon: number, rounds: number): number | null {
  const future = futureCandles(horizon, rounds);
  const start = length - 1 - future;
  return start >= VISIBLE - 1 + Math.min(WARMUP, 50) ? start : null;
}
