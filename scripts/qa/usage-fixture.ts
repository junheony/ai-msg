/** BRIEF7c visual fixture. Synthetic display data; never evidence of live quota. */
import type { AccountUsage, UsageSnapshot } from '../../src/shared/usage-types';

export const usageFixtureClock = '2026-11-01T17:00:00.000Z'; // Nov 2, 02:00 KST
const window = (usedPct: number, resetsAt: string) => ({ usedPct, resetsAt });
const account = (remaining: number, resetsAt: string): AccountUsage => ({
  status: 'ok', fetchedAt: usageFixtureClock,
  fiveHour: window(0, '2026-11-01T20:00:00.000Z'),
  weekly: window(100 - remaining, resetsAt),
  fable: window(100, resetsAt),
});
export const usageFixture: UsageSnapshot = {
  generatedAt: usageFixtureClock, deckReachable: true, usageMode: 'cli',
  accounts: {
    a: account(37, '2026-11-03T15:00:00.000Z'),
    b: account(46, '2026-11-06T15:00:00.000Z'),
    c: account(38, '2026-11-03T15:00:00.000Z'),
  },
  gpt: { status: 'ok', fetchedAt: usageFixtureClock, fiveHour: window(0, '2026-11-01T20:00:00.000Z'), weekly: window(100, '2026-11-04T03:10:00.000Z'), fable: null },
  geminiSeats: {
    g1: { status: 'down', fetchedAt: usageFixtureClock, loggedIn: false, buckets: [] },
    g2: { status: 'down', fetchedAt: usageFixtureClock, loggedIn: false, buckets: [] },
  },
  grokSeats: {
    x1: {
      status: 'ok', lastTurnAt: usageFixtureClock, lastError: null, cooldownUntil: null,
      today: { inputTokens: 1200, outputTokens: 800, turns: 2, day: '2026-11-02' },
      billing: { usedPct: 29, windowStart: '2026-10-29T15:00:00.000Z', windowEnd: '2026-11-05T15:00:00.000Z', tier: 'SuperGrok', fetchedAt: usageFixtureClock, periodType: 'WEEKLY' },
    },
  },
};
