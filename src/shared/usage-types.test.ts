import { describe, expect, it } from 'vitest';
import { emptyAccountUsage, parseIsoUtc, trusted } from './usage-types';

describe('parseIsoUtc', () => {
  it('treats a zone-less date-time as UTC, like claude-pick', () => {
    const utc = Date.UTC(2026, 8, 30, 12, 0, 0);
    expect(parseIsoUtc('2026-09-30T12:00:00')).toBe(utc);
    expect(parseIsoUtc('2026-09-30 12:00:00')).toBe(utc);
    expect(parseIsoUtc('2026-09-30T12:00:00.000Z')).toBe(utc);
    expect(parseIsoUtc('2026-09-30T21:00:00+09:00')).toBe(utc);
    expect(parseIsoUtc('2026-09-30T21:00:00+0900')).toBe(utc);
    expect(parseIsoUtc('2026-09-30')).toBe(Date.UTC(2026, 8, 30));
    expect(parseIsoUtc('nope')).toBeNaN();
  });
});

describe('trusted', () => {
  it('only an account with a trustUntil still ahead (cli mode); none at all = not trusted (usage-deck mode)', () => {
    const now = Date.UTC(2026, 9, 17, 10, 0, 0);
    const u = { ...emptyAccountUsage(), status: 'stale' as const };
    expect(trusted(u, now)).toBe(false);
    expect(trusted({ ...u, trustUntil: new Date(now + 1000).toISOString() }, now)).toBe(true);
    expect(trusted({ ...u, trustUntil: new Date(now).toISOString() }, now)).toBe(false);
    expect(trusted({ ...u, trustUntil: 'junk' }, now)).toBe(false);
  });
});
