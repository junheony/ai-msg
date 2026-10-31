import { describe, expect, it } from 'vitest';
import { appendSession, clearHistory, DEFAULT_REPLAY_PREFS, HISTORY_KEY, HISTORY_MAX, historyStats, PREFS_KEY, readHistory, readReplayPrefs, removeSession, writeReplayPrefs, type ReplaySession } from './history';
import { summarize } from './scoring';

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, map: m };
}
const session = (id: string, pnl: number[]): ReplaySession => {
  const rounds = pnl.map((p, i) => ({ n: i + 1, dir: 'long' as const, entryIndex: i, exitIndex: i + 1, entryT: i, exitT: i + 1, entry: 100, exit: 100 + p, pnlPct: p }));
  return { id, at: '2026-10-31T00:00:00.000Z', market: 'futures', symbol: 'BTCUSDT', interval: '15m', source: 'binance', horizon: 5, roundsPlanned: pnl.length, hidePrice: true, hideDate: true, playStartT: 0, endT: 1, rounds, summary: summarize(rounds), buyHoldPct: 1 };
};

describe('replay history', () => {
  it('starts empty, keeps newest first, de-duplicates by id, removes and clears', () => {
    const st = mem();
    expect(readHistory(st)).toEqual([]);
    appendSession(session('a', [1]), st);
    const list = appendSession(session('b', [-1]), st);
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
    expect(appendSession(session('a', [2]), st).map((s) => s.id)).toEqual(['a', 'b']);
    expect(removeSession('b', st).map((s) => s.id)).toEqual(['a']);
    clearHistory(st);
    expect(readHistory(st)).toEqual([]);
  });
  it('caps the log and ignores corrupt storage', () => {
    const st = mem();
    for (let i = 0; i < HISTORY_MAX + 5; i++) appendSession(session(`s${i}`, [0.1]), st);
    expect(readHistory(st).length).toBe(HISTORY_MAX);
    st.setItem(HISTORY_KEY, '{not json');
    expect(readHistory(st)).toEqual([]);
    st.setItem(HISTORY_KEY, JSON.stringify([{ id: 'x' }, 3, session('ok', [1])]));
    expect(readHistory(st).map((s) => s.id)).toEqual(['ok']);
    expect(readHistory(null)).toEqual([]);
  });
  it('sums the log into stats', () => {
    const s = historyStats([session('a', [2, -1]), session('b', [3])]);
    expect(s).toEqual({ sessions: 2, trades: 3, wins: 2, hitRate: 2 / 3, totalPct: 4, avgSessionPct: 2 });
    expect(historyStats([]).hitRate).toBeNull();
  });
});

describe('replay prefs', () => {
  it('defaults, round-trips, and drops unknown indicators', () => {
    const st = mem();
    expect(readReplayPrefs(st)).toEqual(DEFAULT_REPLAY_PREFS);
    writeReplayPrefs({ ...DEFAULT_REPLAY_PREFS, symbol: 'ETHUSDT', indicators: ['rsi'] }, st);
    expect(readReplayPrefs(st).symbol).toBe('ETHUSDT');
    expect(readReplayPrefs(st).indicators).toEqual(['rsi']);
    st.setItem(PREFS_KEY, JSON.stringify({ indicators: ['rsi', 'bogus'], hidePrice: false }));
    expect(readReplayPrefs(st)).toMatchObject({ indicators: ['rsi'], hidePrice: false, symbol: 'BTCUSDT' });
    st.setItem(PREFS_KEY, 'nope');
    expect(readReplayPrefs(st)).toEqual(DEFAULT_REPLAY_PREFS);
  });
});
