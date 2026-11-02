import { describe, expect, it, vi } from 'vitest';
import { dailyFixture } from '../../../tests/fixtures/yapping-daily';
import { collectDaily, parseDaily } from './yapping-daily';
import { HUB_TIMEOUTS, HUB_URLS, type HubDeps } from './shared';

function deps() {
  let now = 0;
  const fetchJson = vi.fn<(url: string, timeout: number) => Promise<unknown>>().mockResolvedValue(dailyFixture());
  const d: HubDeps = {
    now: () => now, fetchJson, host: 'fixture', home: '/home/fixture',
    latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null,
    readText: async () => null, readTail: async () => null, listDir: async () => null, fileMtime: async () => null,
    systemdShow: async () => null, self: () => ({ uptimeMs: 0, sessions: 0, activeTurns: 0 }),
  };
  return { d, fetchJson, advance: (ms: number) => { now += ms; } };
}

describe('daily metrics collector', () => {
  it('reads fixed 30-day GET endpoint, preserves null followers and actual zero counts', async () => {
    const { d, fetchJson } = deps();
    const result = await collectDaily(d);
    expect(fetchJson).toHaveBeenCalledExactlyOnceWith(HUB_URLS.yappingDaily, HUB_TIMEOUTS.default);
    expect(result.daily).toEqual({ rows: dailyFixture(), reason: null });
    expect(result.daily.rows.filter(row => row.followers === null)).toHaveLength(16);
    expect(result.daily.rows[0]).toMatchObject({ followers: null, following: null, views: 0, posts: 0 });
    expect(result.source.ok).toBe(true);
  });
  it('coalesces concurrent requests and caches for 60 seconds after completion', async () => {
    const { d, fetchJson, advance } = deps();
    let resolve!: (value: unknown) => void;
    fetchJson.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = collectDaily(d), second = collectDaily(d);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    advance(500); resolve(dailyFixture());
    expect(await first).toEqual(await second);
    advance(59_999); await collectDaily(d); expect(fetchJson).toHaveBeenCalledTimes(1);
    advance(1); await collectDaily(d); expect(fetchJson).toHaveBeenCalledTimes(2);
  });
  it.each([
    [new DOMException('private source', 'TimeoutError'), '시간 초과'],
    [new Error('HTTP 503 /home/private secret=value'), 'HTTP 503'],
    [new SyntaxError('JSON private response'), '응답 형식 오류'],
  ])('sanitizes failure, discards stale daily comparisons and caches failure for 60 seconds', async (error, reason) => {
    const { d, fetchJson, advance } = deps();
    await collectDaily(d); advance(60_000); fetchJson.mockRejectedValue(error);
    expect(await collectDaily(d)).toMatchObject({ daily: { rows: [], reason }, source: { ok: false, error: reason } });
    advance(59_999); await collectDaily(d); expect(fetchJson).toHaveBeenCalledTimes(2);
    advance(1); fetchJson.mockResolvedValue(dailyFixture());
    expect((await collectDaily(d)).daily.rows).toHaveLength(30);
  });
  it.each(['followers', 'following', 'views', 'posts'])('rejects invalid counts for %s', field => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '2', undefined]) {
      const fixture = dailyFixture(); Object.assign(fixture[0]!, { [field]: value });
      expect(() => parseDaily(fixture)).toThrow('응답 형식 오류');
    }
  });
  it('validates calendar dates, strict ordering, envelope and count limit', () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-1-01', 'private', '2026-11-02T00:00:00Z']) {
      expect(() => parseDaily([{ ...dailyFixture()[0], date }])).toThrow('응답 형식 오류');
    }
    const fixture = dailyFixture();
    for (const invalid of [null, { rows: fixture }, [...fixture, fixture[29]], [fixture[1], fixture[0]], [fixture[0], fixture[0]], [{ ...fixture[0], views: null }], [{ ...fixture[0], posts: null }]]) {
      expect(() => parseDaily(invalid)).toThrow('응답 형식 오류');
    }
    expect(parseDaily([])).toEqual({ rows: [], reason: '집계된 일별 기록 없음' });
    expect(parseDaily([{ ...fixture[0], private: 'ignored' }]).rows[0]).toEqual(fixture[0]);
  });
});
