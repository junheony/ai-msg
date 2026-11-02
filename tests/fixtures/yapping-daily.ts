import type { YappingDailyRow } from '../../src/shared/hub-types';

/** Synthetic test/opt-in preview data only; never a production fallback. */
export function dailyFixture(endDate = '2026-11-02'): YappingDailyRow[] {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Array.from({ length: 30 }, (_, index) => ({
    date: new Date(end - (29 - index) * 86_400_000).toISOString().slice(0, 10),
    followers: index < 16 ? null : 450 + (index - 16) * 4 + (index % 3),
    following: index < 16 ? null : 860 + index,
    views: index % 7 === 0 ? 0 : (index + 1) * 23 + (index % 3) * 101,
    posts: index % 7 === 0 ? 0 : 1 + (index % 5),
  }));
}
