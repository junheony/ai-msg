/**
 * Support/resistance zones the Trading room shows (read-only), as MSG's `/api/hub/sr` answers them. The server reads
 * the 트레이딩룸 bot's `GET :8830/api/sr` snapshot (auto MTF VPVR + pivot zones, paper only), keeps the fields the panel
 * needs and nothing named like a secret or a home path. Prices are plain numbers in the symbol's quote currency.
 */

export type SrSide = 'support' | 'resistance';

export interface SrRange {
  id: string;
  symbol: string;
  side: SrSide;
  low: number;
  high: number;
  /** (low + high) / 2 — what the distance column measures from. */
  mid: number;
  /** The bot's raw score (Σ tf_weight × hit + SMA200) and its 1–5 confidence tier. */
  score: number | null;
  tier: number;
  /** Per-timeframe hit strength 0–1 (1m/5m/15m/1h/4h/1d, sometimes sma200_4h). */
  tfHits: Record<string, number>;
  timeframe: string;
  createdAt: string | null;
  expiresAt: string | null;
  /** The zone no longer holds once price closes beyond this (support: below, resistance: above). */
  invalidateBelow: number | null;
  invalidateAbove: number | null;
  /** The bot's own notes (short, scrubbed, bounded). */
  notes: string[];
}

export interface SrTimeframe { tf: string; profileDays: number | null; pivotDays: number | null; weight: number | null }

export interface SrSnapshot {
  /** The snapshot file's name (no path) and its times, so the panel can say how old the zones are. */
  source: string;
  snapshotAt: string | null;
  createdAt: string | null;
  ageHours: number | null;
  policy: string;
  schemaVersion: string;
  method: { tiers: string; tfs: SrTimeframe[] };
  /** Every symbol in the snapshot (the picker), sorted; `ranges` is the filtered set when `symbol` is set. */
  symbols: string[];
  symbol: string | null;
  ranges: SrRange[];
  rangeCount: number;
  /** Split-buy paper status: the bot exposes none today, so the panel says 미보고 rather than inventing one. */
  splitBuy: { reported: false; note: string } | { reported: true; rows: [string, string][] };
  generatedAt: string | null;
}

/** What `/api/hub/sr` answers when the bot does not: never a stack, never a URL. */
export interface SrError { error: string }

export const SR_SYMBOL_RE = /^[A-Z0-9]{3,20}$/;
