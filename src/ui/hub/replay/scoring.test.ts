import { describe, expect, it } from 'vitest';
import { buyAndHoldPct, fmtPct, pnlPct, summarize, type ReplayRound } from './scoring';

const round = (n: number, dir: ReplayRound['dir'], entry: number, exit: number): ReplayRound => ({ n, dir, entryIndex: n, exitIndex: n + 1, entryT: n, exitT: n + 1, entry, exit, pnlPct: pnlPct(dir, entry, exit) });

describe('pnlPct', () => {
  it('long gains when price rises, short gains when it falls, both as percent of entry', () => {
    expect(pnlPct('long', 100, 105)).toBeCloseTo(5);
    expect(pnlPct('long', 100, 95)).toBeCloseTo(-5);
    expect(pnlPct('short', 100, 95)).toBeCloseTo(5);
    expect(pnlPct('short', 100, 110)).toBeCloseTo(-10);
    expect(pnlPct('long', 200, 200)).toBe(0);
  });
  it('charges the fee on both sides, answers null for skips and nonsense prices', () => {
    expect(pnlPct('long', 100, 101, 0.1)).toBeCloseTo(0.8);
    expect(pnlPct('skip', 100, 120)).toBeNull();
    expect(pnlPct('long', 0, 120)).toBeNull();
    expect(pnlPct('short', 100, Number.NaN)).toBeNull();
  });
});

describe('summarize', () => {
  it('counts trades and skips, sums the score, tracks hit rate, best/worst, drawdown and streak', () => {
    const s = summarize([round(1, 'long', 100, 102), round(2, 'skip', 102, 101), round(3, 'short', 101, 103), round(4, 'long', 103, 103 * 1.03), round(5, 'long', 106, 107)]);
    expect(s.rounds).toBe(5); expect(s.trades).toBe(4); expect(s.skips).toBe(1);
    expect(s.wins).toBe(3); expect(s.losses).toBe(1);
    expect(s.hitRate).toBeCloseTo(0.75);
    expect(s.totalPct).toBeCloseTo(2 - 1.9802 + 3 + 0.9434, 3);
    expect(s.best).toBeCloseTo(3); expect(s.worst).toBeCloseTo(-1.9802, 3);
    expect(s.maxDrawdownPct).toBeCloseTo(1.9802, 3);
    expect(s.bestStreak).toBe(2);
  });
  it('is all zeros / nulls with no trades', () => {
    const s = summarize([round(1, 'skip', 1, 2)]);
    expect(s).toMatchObject({ rounds: 1, trades: 0, skips: 1, wins: 0, losses: 0, hitRate: null, totalPct: 0, avgPct: null, best: null, worst: null, maxDrawdownPct: 0, bestStreak: 0 });
    expect(summarize([]).rounds).toBe(0);
  });
  it('a flat round is neither a win nor a loss but still a trade', () => {
    const s = summarize([round(1, 'long', 50, 50)]);
    expect(s.trades).toBe(1); expect(s.wins).toBe(0); expect(s.losses).toBe(0); expect(s.hitRate).toBe(0);
  });
});

describe('buyAndHoldPct · fmtPct', () => {
  it('compares against holding, and formats with sign and a real minus', () => {
    expect(buyAndHoldPct(100, 110)).toBeCloseTo(10);
    expect(buyAndHoldPct(0, 110)).toBeNull();
    expect(fmtPct(1.234)).toBe('+1.23%');
    expect(fmtPct(-0.4)).toBe('−0.40%');
    expect(fmtPct(0)).toBe('0.00%');
    expect(fmtPct(null)).toBe('—');
  });
});
