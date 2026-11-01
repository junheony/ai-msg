import { describe, expect, it, vi } from 'vitest';
import { risingFixture } from '../../../tests/fixtures/yapping-rising';
import { collectRising, parseRising } from './yapping-rising';
import { HUB_URLS, type HubDeps } from './shared';

function deps() {
  let now = 0;
  const fetchJson = vi.fn<(url: string, timeout: number) => Promise<unknown>>().mockResolvedValue(risingFixture());
  const d: HubDeps = {
    now: () => now, fetchJson, host: 'fixture', home: '/home/fixture',
    latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null,
    readText: async () => null, readTail: async () => null, listDir: async () => null, fileMtime: async () => null,
    systemdShow: async () => null, self: () => ({ uptimeMs: 0, sessions: 0, activeTurns: 0 }),
  };
  return { d, fetchJson, advance: (ms: number) => { now += ms; } };
}
describe('Rising read-only collector', () => {
  it('orders the fixture by rank, limits to ten and projects only the card fields', async () => {
    const { d, fetchJson } = deps();
    const { rising, source } = await collectRising(d);
    expect(fetchJson).toHaveBeenCalledExactlyOnceWith(HUB_URLS.yappingRising, 3000);
    expect(rising.items.map(item => item.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rising.items[0]).toMatchObject({ author: '@fixture_1', velocityVph: 12000.5, ageH: 0.25, topic: 'AI' });
    expect(rising).toMatchObject({ generatedAt: '2026-11-02T03:00:00.000Z', windowH: 12, reason: null });
    expect(source.ok).toBe(true);
    expect(JSON.stringify(rising)).not.toContain('followers');
  });
  it('deduplicates inflight requests and caches until 30 seconds after completion', async () => {
    const { d, fetchJson, advance } = deps();
    let resolve!: (value: unknown) => void;
    fetchJson.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const a = collectRising(d), b = collectRising(d);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    advance(500); resolve(risingFixture());
    expect(await a).toEqual(await b);
    advance(29_999); await collectRising(d); expect(fetchJson).toHaveBeenCalledTimes(1);
    advance(1); await collectRising(d); expect(fetchJson).toHaveBeenCalledTimes(2);
  });
  it.each([
    [new DOMException('sensitive upstream host', 'TimeoutError'), '시간 초과'],
    [new Error('HTTP 503 /home/private secret=value'), 'HTTP 503'],
    [new Error('fetch failed at private host'), '연결 실패'],
    [new SyntaxError('JSON body includes private data'), '응답 형식 오류'],
    [new Error('secret=password /home/private'), '오류'],
  ])('sanitizes failures and caches them without retaining stale rankings', async (error, reason) => {
    const { d, fetchJson, advance } = deps();
    await collectRising(d); advance(30_000);
    fetchJson.mockRejectedValue(error);
    const result = await collectRising(d);
    expect(result.rising).toEqual({ generatedAt: null, windowH: null, items: [], reason });
    expect(result.source).toMatchObject({ ok: false, error: reason });
    await collectRising(d); expect(fetchJson).toHaveBeenCalledTimes(2);
    advance(30_000); fetchJson.mockResolvedValue(risingFixture());
    expect((await collectRising(d)).rising.items).toHaveLength(10);
  });
  it.each(['javascript:alert(1)', 'http://x.com/a/status/1', 'https://x.com.evil.test/a/status/1', 'https://x.com@evil.test/a/status/1', 'https://x.com/a/status/1/other', 'https://x.com:8080/a/status/1'])('rejects unsafe post URL %s', url => {
    const fixture = risingFixture(); fixture.items[0]!.url = url;
    expect(() => parseRising(fixture)).toThrow('응답 형식 오류');
  });
  it.each(['rank', 'velocity_vph', 'age_h', 'views', 'followers', 'observations', 'score'])('rejects null and negative numeric field %s', field => {
    for (const value of [null, -1, Number.NaN, '10']) {
      const fixture = risingFixture(); Object.assign(fixture.items[0]!, { [field]: value });
      expect(() => parseRising(fixture)).toThrow('응답 형식 오류');
    }
  });
  it('validates the envelope, distinguishes an empty feed, normalizes links and deduplicates posts', async () => {
    const { d, fetchJson } = deps();
    fetchJson.mockResolvedValue({ items: [] });
    expect((await collectRising(d)).rising.reason).toBe('응답 형식 오류');
    const fixture = risingFixture(); fixture.items = [];
    expect(parseRising(fixture).reason).toBe('집계된 게시물 없음');
    const duplicated = risingFixture(); duplicated.items = [duplicated.items[29]!, { ...duplicated.items[29]!, rank: 2 }];
    duplicated.items[0]!.url += '?tracking=private#fragment';
    expect(parseRising(duplicated).items).toHaveLength(1);
    expect(parseRising(duplicated).items[0]!.url).toBe('https://x.com/fixture_1/status/900001');
  });
});
