/** Replay scoring: one prediction per round, PnL in percent of the entry price, no leverage, fees optional. */

export type Direction = 'long' | 'short' | 'skip';

export interface ReplayRound {
  n: number;
  dir: Direction;
  /** Index (into the scene's candles) of the entry candle (its close is the entry) and the exit candle. */
  entryIndex: number;
  exitIndex: number;
  entryT: number;
  exitT: number;
  entry: number;
  exit: number;
  /** Percent; null for a skipped round. */
  pnlPct: number | null;
}

export interface ReplaySummary {
  rounds: number;
  trades: number;
  skips: number;
  wins: number;
  losses: number;
  /** wins / trades, 0..1; null with no trades. */
  hitRate: number | null;
  /** Sum of the round PnLs, percent (the score). */
  totalPct: number;
  avgPct: number | null;
  best: number | null;
  worst: number | null;
  /** Largest peak-to-trough fall of the cumulative PnL, percent points (≥ 0). */
  maxDrawdownPct: number;
  /** Longest run of consecutive winning rounds. */
  bestStreak: number;
}

/**
 * Percent return of one round. Long: (exit − entry) / entry; short: (entry − exit) / entry. `feePct` is charged once
 * per side (so twice), as a percent of notional. Skips are null.
 */
export function pnlPct(dir: Direction, entry: number, exit: number, feePct = 0): number | null {
  if (dir === 'skip') return null;
  if (!(entry > 0) || !Number.isFinite(exit)) return null;
  const raw = dir === 'long' ? (exit - entry) / entry : (entry - exit) / entry;
  return raw * 100 - 2 * feePct;
}

export function summarize(rounds: readonly ReplayRound[]): ReplaySummary {
  const pnls = rounds.map((r) => r.pnlPct).filter((p): p is number => p !== null);
  const trades = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p < 0).length;
  const totalPct = pnls.reduce((a, b) => a + b, 0);
  let peak = 0; let cum = 0; let dd = 0;
  for (const p of pnls) { cum += p; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  let streak = 0; let bestStreak = 0;
  for (const p of pnls) { streak = p > 0 ? streak + 1 : 0; bestStreak = Math.max(bestStreak, streak); }
  return {
    rounds: rounds.length,
    trades,
    skips: rounds.length - trades,
    wins,
    losses,
    hitRate: trades ? wins / trades : null,
    totalPct,
    avgPct: trades ? totalPct / trades : null,
    best: trades ? Math.max(...pnls) : null,
    worst: trades ? Math.min(...pnls) : null,
    maxDrawdownPct: dd,
    bestStreak,
  };
}

/** What simply holding from the first entry to the last exit would have made, percent. */
export function buyAndHoldPct(firstClose: number, lastClose: number): number | null {
  return firstClose > 0 && Number.isFinite(lastClose) ? ((lastClose - firstClose) / firstClose) * 100 : null;
}

/** `+1.23%` / `−0.40%` / `0.00%`, with a real minus sign. */
export function fmtPct(p: number | null, dp = 2): string {
  if (p === null || !Number.isFinite(p)) return '—';
  const s = p.toFixed(dp);
  return p > 0 ? `+${s}%` : p < 0 ? `−${s.slice(1)}%` : `${s}%`;
}
