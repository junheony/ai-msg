import { describe, expect, it } from 'vitest';
import { dailyFixture } from '../../tests/fixtures/yapping-daily';
import { yappingDailyDeltas, yappingDailyWindow, yappingDateKst } from './yapping';

const NOW = Date.parse('2026-11-01T17:00:00Z'); // November 2, 02:00 KST
describe('daily calendar comparisons', () => {
  it('compares today to exact yesterday and day-7 dates using KST', () => {
    const rows = dailyFixture();
    const today = rows[29]!, yesterday = rows[28]!, weekAgo = rows[22]!;
    expect(yappingDateKst(NOW)).toBe('2026-11-02');
    expect(yappingDailyDeltas(rows, NOW)).toEqual({ date: '2026-11-02', followers: { day: today.followers! - yesterday.followers!, week: today.followers! - weekAgo.followers! }, views: { day: today.views - yesterday.views, week: today.views - weekAgo.views } });
  });
  it('preserves zero and negative deltas; does not substitute adjacent rows for missing dates', () => {
    const rows = dailyFixture(); rows[29]!.followers = rows[28]!.followers; rows[29]!.views = 0; rows[28]!.views = 70;
    expect(yappingDailyDeltas(rows, NOW)).toMatchObject({ followers: { day: 0 }, views: { day: -70 } });
    rows.splice(28, 1);
    expect(yappingDailyDeltas(rows, NOW)).toMatchObject({ followers: { day: null }, views: { day: null } });
    expect(yappingDailyDeltas(rows, NOW).followers.week).not.toBeNull();
    rows.splice(22, 1);
    expect(yappingDailyDeltas(rows, NOW).views.week).toBeNull();
  });
  it('keeps null follower observations and a missing today unknown independently of view data', () => {
    const rows = dailyFixture(); rows[22]!.followers = null; rows[29]!.followers = null;
    expect(yappingDailyDeltas(rows, NOW).followers).toEqual({ day: null, week: null });
    expect(yappingDailyDeltas(rows, NOW).views.day).not.toBeNull();
    rows.pop();
    expect(yappingDailyDeltas(rows, NOW)).toMatchObject({ followers: { day: null, week: null }, views: { day: null, week: null } });
  });
  it('rolls over exactly at KST midnight rather than UTC or the posting service reset', () => {
    expect(yappingDateKst(Date.parse('2026-11-01T14:59:59Z'))).toBe('2026-11-01');
    expect(yappingDateKst(Date.parse('2026-11-01T15:00:00Z'))).toBe('2026-11-02');
  });
  it('makes a 30-day chart window with explicit gaps and excludes old/future dates', () => {
    const rows = dailyFixture(); rows.splice(20, 1); rows.push({ ...rows[28]!, date: '2026-11-03' });
    const window = yappingDailyWindow(rows, NOW);
    expect(window).toHaveLength(30);
    expect(window[0]!.date).toBe('2026-10-04');
    expect(window[29]!.date).toBe('2026-11-02');
    expect(window[20]).toEqual({ date: '2026-10-24', followers: null, following: null, views: null, posts: null });
    expect(window[0]).toMatchObject({ followers: null, views: 0 });
  });
});
