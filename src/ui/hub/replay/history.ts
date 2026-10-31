/**
 * Local persistence for the replay trainer: finished sessions (the practice log) and the last-used settings. Both live
 * in this browser's localStorage under MSG's `deck.` keys — nothing leaves the machine and nothing goes to the server.
 */
import type { ReplayInterval, ReplayMarket, ReplaySource } from '../../../shared/replay-types';
import type { ReplayRound, ReplaySummary } from './scoring';

export const HISTORY_KEY = 'deck.replay.history.v1';
export const PREFS_KEY = 'deck.replay.prefs.v1';
export const HISTORY_MAX = 100;

export interface ReplaySession {
  id: string;
  /** ISO time the session ended. */
  at: string;
  market: ReplayMarket;
  symbol: string;
  interval: ReplayInterval;
  source: ReplaySource;
  horizon: number;
  roundsPlanned: number;
  hidePrice: boolean;
  hideDate: boolean;
  /** Open time (ms) of the last candle visible when play began, and of the last revealed candle. */
  playStartT: number;
  endT: number;
  rounds: ReplayRound[];
  summary: ReplaySummary;
  buyHoldPct: number | null;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storage = (): StorageLike | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };

const isSession = (v: unknown): v is ReplaySession => typeof v === 'object' && v !== null && typeof (v as ReplaySession).id === 'string' && Array.isArray((v as ReplaySession).rounds) && typeof (v as ReplaySession).summary === 'object';

export function readHistory(st: StorageLike | null = storage()): ReplaySession[] {
  try {
    const raw = st?.getItem(HISTORY_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isSession) : [];
  } catch { return []; }
}
function writeHistory(list: ReplaySession[], st: StorageLike | null): void {
  try { st?.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* quota or private mode: the log is simply not kept */ }
}
/** Newest first, capped at HISTORY_MAX. Answers the new list. */
export function appendSession(s: ReplaySession, st: StorageLike | null = storage()): ReplaySession[] {
  const list = [s, ...readHistory(st).filter((x) => x.id !== s.id)].slice(0, HISTORY_MAX);
  writeHistory(list, st);
  return list;
}
export function removeSession(id: string, st: StorageLike | null = storage()): ReplaySession[] {
  const list = readHistory(st).filter((x) => x.id !== id);
  writeHistory(list, st);
  return list;
}
export function clearHistory(st: StorageLike | null = storage()): void {
  try { st?.removeItem(HISTORY_KEY); } catch { /* nothing to clear */ }
}

export interface HistoryStats { sessions: number; trades: number; wins: number; hitRate: number | null; totalPct: number; avgSessionPct: number | null }
/** The whole log in four numbers: how many sessions, how many calls, how often right, how much in total. */
export function historyStats(list: readonly ReplaySession[]): HistoryStats {
  const trades = list.reduce((n, s) => n + s.summary.trades, 0);
  const wins = list.reduce((n, s) => n + s.summary.wins, 0);
  const totalPct = list.reduce((n, s) => n + s.summary.totalPct, 0);
  return { sessions: list.length, trades, wins, hitRate: trades ? wins / trades : null, totalPct, avgSessionPct: list.length ? totalPct / list.length : null };
}

/* ───────── settings ───────── */

export type IndicatorId = 'ema20' | 'ema50' | 'sma200' | 'bb' | 'volume' | 'rsi' | 'macd' | 'atr' | 'cvd' | 'oi' | 'funding';
export const INDICATOR_IDS: readonly IndicatorId[] = ['ema20', 'ema50', 'sma200', 'bb', 'volume', 'rsi', 'macd', 'atr', 'cvd', 'oi', 'funding'];
export type CandleColors = 'intl' | 'kr';

export interface ReplayPrefs {
  market: ReplayMarket;
  symbol: string;
  interval: ReplayInterval;
  horizon: number;
  rounds: number;
  hidePrice: boolean;
  hideDate: boolean;
  candleColors: CandleColors;
  indicators: IndicatorId[];
}
export const DEFAULT_REPLAY_PREFS: ReplayPrefs = { market: 'futures', symbol: 'BTCUSDT', interval: '15m', horizon: 5, rounds: 10, hidePrice: true, hideDate: true, candleColors: 'intl', indicators: ['ema20', 'ema50', 'volume'] };

export function readReplayPrefs(st: StorageLike | null = storage()): ReplayPrefs {
  try {
    const raw = st?.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_REPLAY_PREFS;
    const v = JSON.parse(raw) as Partial<ReplayPrefs> | null;
    if (!v || typeof v !== 'object') return DEFAULT_REPLAY_PREFS;
    const merged = { ...DEFAULT_REPLAY_PREFS, ...v };
    merged.indicators = Array.isArray(v.indicators) ? v.indicators.filter((i): i is IndicatorId => (INDICATOR_IDS as readonly string[]).includes(i)) : DEFAULT_REPLAY_PREFS.indicators;
    return merged;
  } catch { return DEFAULT_REPLAY_PREFS; }
}
export function writeReplayPrefs(p: ReplayPrefs, st: StorageLike | null = storage()): void {
  try { st?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* not kept */ }
}
