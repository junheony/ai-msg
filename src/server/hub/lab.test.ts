import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookieValueFor } from '../auth';
import { createRequestHandler, type HttpDeps } from '../http';
import { labFixture, LAB_NOW } from '../../test/labFixture';
import { createLabService, extraValue, fetchLabJson, LAB_CACHE_MS, LAB_EXTRA_LIMITS, LAB_TIMEOUT_MS, LAB_URL, mapLab, serveLab } from './lab';

describe('lab mapper', () => {
  it('copies only supported real fields, preserves KST and excludes scenarios, secrets and home paths', () => {
    const body = labFixture();
    const mapped = mapLab({ ...body, api_key: 'secret', probability: 0.99, scenario: { up: 0.8 }, books: [{ ...body.books[0], token: 'private', label: 'see /home/max/private' }] });
    expect(mapped.generated_at).toBe(body.generated_at);
    expect(mapped.books?.[0]?.equity).toBe(60170.39);
    expect(mapped.books?.[0]?.return_pct).toBe(0.284);
    expect(mapped.ledger.span_days).toBe(0.9);
    expect(mapped.issues).toEqual({});
    expect(JSON.stringify(mapped)).not.toMatch(/secret|private|probability|scenario|\/home\//);
  });
  it.each([{ schema: 'v2' }, { live: true }, { live: 'false' }, { read_only: false }, { read_only: 'true' }, { engine: { paper: { live: true } } }, { engine: { paper: { live: 'false' } } }])('rejects unsafe envelopes %j', change => {
    expect(() => mapLab({ ...labFixture(), ...change })).toThrow();
  });
  it('does not coerce numeric strings, booleans, NaN or infinity and does not invent nulls as zero', () => {
    const body = labFixture();
    const s = mapLab({ ...body, open_positions_total: '1', books: [{ ...body.books[0], equity: null, return_pct: false, pnl: { realized: '2', unrealized: NaN }, max_dd_pct: Infinity }] });
    expect(s.open_positions_total).toBeNull();
    expect(s.books?.[0]).toMatchObject({ equity: null, return_pct: null, pnl: { realized: null, unrealized: null }, max_dd_pct: null });
    expect(s.issues['books.0.equity']).toBeUndefined();
    expect(s.issues['books.0.return_pct']).toBe('응답 형식 오류');
  });
  it('rejects negative/fractional counts, invalid hashes, sides, times and malformed nested containers as field errors', () => {
    const body = labFixture();
    const s = mapLab({ ...body, books: [{ ...body.books[0], n_trades: -2.5, wins: '7', open: [{ side: 'buy', entry_kst: 'yesterday' }, null] }, 42], ledger: { ...body.ledger, span_days: -1 }, verify: { ...body.verify, gap_count: 0.5, head: 'bad' } });
    expect(s.books?.[0]?.n_trades).toBeNull();
    expect(s.ledger.span_days).toBeNull();
    expect(s.verify.gap_count).toBeNull();
    for (const path of ['books.0.n_trades', 'books.0.open.0.side', 'books.0.open.0.entry_kst', 'books.0.open.1', 'books.1', 'verify.head']) expect(s.issues[path]).toBeTruthy();
    expect(mapLab({ ...body, ledger: 'bad', verify: [] }).issues).toMatchObject({ ledger: '응답 형식 오류', verify: '응답 형식 오류' });
  });
  it('attributes errors only to affected null fields and keeps independent sections intact', () => {
    const body = labFixture();
    const s = mapLab({ ...body, sources: { ledger_roots: { ok: false, error: 'timeout' } }, errors: ['ledger_stats: timeout'], ledger: { ...body.ledger, certifiable_closed_trades: null }, verify: { ...body.verify, last_merkle_root: null } });
    expect(s.issues['ledger.certifiable_closed_trades']).toBe('ledger_stats: timeout');
    expect(s.issues['verify.last_merkle_root']).toBe('ledger_roots: timeout');
    expect(s.issues['ledger.span_days']).toBeUndefined();
    expect(s.books?.[0]?.equity).toBe(60170.39);
    expect(s.verify.ok).toBe(true);
  });
  it('rejects impossible calendar dates without normalizing them', () => {
    const body = labFixture();
    const mapped = mapLab({ ...body, generated_at: '2026-02-31T12:00:00+09:00', verify: { ...body.verify, last_merkle_root_date: '2026-02-31' } });
    expect(mapped.generated_at).toBeNull();
    expect(mapped.verify.last_merkle_root_date).toBeNull();
    expect(mapped.issues.generated_at).toBe('응답 형식 오류');
  });
  it('keeps unknown arrays distinct from empty arrays and caps recent trades at ten', () => {
    const body = labFixture();
    expect(mapLab({ ...body, books: null, recent_closed_trades: null }).books).toBeNull();
    expect(mapLab({ ...body, recent_closed_trades: null }).recent_closed_trades).toBeNull();
    expect(mapLab({ ...body, recent_closed_trades: Array(20).fill(body.recent_closed_trades[0]) }).recent_closed_trades).toHaveLength(10);
    expect(mapLab({ ...body, books: [] })).toMatchObject({ loading: true, books: [], open_positions_total: null, recent_closed_trades: [] });
  });
});

describe('lab unknown fields (future strategies)', () => {
  /** The real feed on 2026-11-01 (../.brief4/lab.json) already carries keys this hub never named. */
  const future = () => {
    const body = labFixture();
    return {
      ...body,
      cache: { ttl_s: 15, upstream_timeout_s: 3 },
      books: [{ ...body.books[0], strategy: 'kpb', tf: '15m', cash_start: 60000, avg_r: 0.37 }, { ...body.books[0], id: 'zzz_4h', label: 'ZZZ 신전략 · 4h', strategy: 'zzz', tf: '4h', ranking: { top: ['A', 'B'], note: 'new' } }],
      ledger: { ...body.ledger, per_strategy: { kpb_15m: { signals: 40, signals_cert: 3, exits: 9, latency_median_s: 0.8 }, zzz_4h: { signals: 2, exits: 0 } }, first_certifiable_trade_kst: '2026-10-31 21:02', targets: { trades: 100, days: 90 }, criteria: ['n>=100', 'days>=90'] },
      verify: { ...body.verify, anchor_lag_s: 12 },
      engine: { ...body.engine, paper: { ...body.engine.paper, now_kst: '2026-11-01 17:00:00', loops: 420, mode: 'paper', last_error: null }, ledger: { ok: true, queue: 0 }, scheduler: { ok: true } },
    };
  };
  it('keeps unknown top-level, book, ledger, verify and engine fields generically, in feed order, without naming strategies', () => {
    const s = mapLab(future());
    // the feed's own transport metadata (cache TTL, upstream timeout) is not strategy content and never reaches the page
    expect(s.extra).not.toHaveProperty('cache');
    expect(s.books?.[0]?.extra).toEqual({ strategy: 'kpb', tf: '15m', cash_start: 60000, avg_r: 0.37 });
    expect(s.books?.[1]?.extra).toEqual({ strategy: 'zzz', tf: '4h', ranking: { top: ['A', 'B'], note: 'new' } });
    expect(s.extra.ledger).toEqual({ per_strategy: { kpb_15m: { signals: 40, signals_cert: 3, exits: 9, latency_median_s: 0.8 }, zzz_4h: { signals: 2, exits: 0 } }, first_certifiable_trade_kst: '2026-10-31 21:02', targets: { trades: 100, days: 90 }, criteria: ['n>=100', 'days>=90'] });
    expect(s.extra.verify).toEqual({ anchor_lag_s: 12 });
    expect(s.extra.engine).toEqual({ scheduler: { ok: true }, paper: { now_kst: '2026-11-01 17:00:00', loops: 420, mode: 'paper', last_error: null }, ledger: { queue: 0 } });
    // the known fields are still read the strict way, never duplicated into extra
    expect(Object.keys(s.extra)).toEqual(['ledger', 'verify', 'engine']);
    expect(s.ledger.certifiable_closed_trades).toBe(3);
    expect(s.issues).toEqual({});
    expect(mapLab(labFixture()).extra).toEqual({});
  });
  it('keeps a realistic nested future shape — backtests.strategies[].metrics, per-strategy blocks on a book — intact', () => {
    const body = future();
    const backtests = {
      generated_kst: '2026-11-01 16:50', window_days: 30,
      strategies: [
        { id: 'kpb_15m', metrics: { sharpe: 1.42, pf: 1.31, max_dd_pct: 4.2, by_tf: { '15m': { trades: 61, win_rate: 0.54 } } }, params: { lookback: 20, atr_mult: 1.5 } },
        { id: 'zzz_4h', metrics: { sharpe: 0.3, pf: 0.98, by_tf: { '4h': { trades: 4 } } } },
      ],
    };
    const s = mapLab({ ...body, backtests, books: [{ ...labFixture().books[0], per_strategy: { kpb_15m: { metrics: { sharpe: 1.1, trades: [{ r: 0.4 }, { r: -0.2 }] } } } }] });
    expect(s.extra.backtests).toEqual(backtests);
    expect(s.books?.[0]?.extra).toEqual({ per_strategy: { kpb_15m: { metrics: { sharpe: 1.1, trades: [{ r: 0.4 }, { r: -0.2 }] } } } });
    expect(JSON.stringify(s)).not.toMatch(/knn|scenario|probab|시나리오|확률/i);
  });
  it('caps the whole unknown tree by node count, so a deeper allowance cannot become an unbounded page', () => {
    const wide = Array.from({ length: 20 }, () => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`k${i}`, { v: i }])));
    const s = mapLab({ ...labFixture(), first: { ok: true }, many: wide, books: [{ ...labFixture().books[0], note: 'kept?' }] });
    const count = (v: unknown): number => v !== null && typeof v === 'object' ? 1 + (Array.isArray(v) ? v : Object.values(v as object)).reduce((n: number, x) => n + count(x), 0) : 1;
    const total = count(s.extra) - 1 + (s.books ?? []).reduce((n, b) => n + count(b.extra) - 1, 0);
    expect(total).toBeLessThanOrEqual(LAB_EXTRA_LIMITS.nodes);
    expect(total).toBeGreaterThan(LAB_EXTRA_LIMITS.nodes - 30);
    expect(s.books?.[0]?.extra).toEqual({ note: 'kept?' });
    expect(s.extra.first).toEqual({ ok: true });
    expect((s.extra.many as unknown[]).length).toBeGreaterThan(0);
  });
  it('drops kNN scenario probabilities wherever they hide: by key, by nested key, by text', () => {
    const body = future();
    const s = mapLab({ ...body, knn_scenarios: { up: 0.7, down: 0.3 }, forecast: { scenario_probabilities: [0.1, 0.9], horizon: '4h', note: '시나리오 확률 상승 70%' }, books: [{ ...body.books[0], probability_up: 0.66, tags: ['momentum', 'kNN 시나리오 B'] }], ledger: { ...body.ledger, per_strategy: { knn_1h: { signals: 1 }, kpb_15m: { signals: 2, prob_win: 0.5 } } } });
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/knn|scenario|probab|시나리오|확률/i);
    expect(s.extra.forecast).toEqual({ horizon: '4h' });
    expect(s.books?.[0]?.extra).toMatchObject({ tags: ['momentum'] });
    expect(s.extra.ledger).toMatchObject({ per_strategy: { kpb_15m: { signals: 2 } } });
  });
  it('bounds and sanitizes malformed unknown fields: depth, breadth, length, markup, URLs, secrets, paths, non-finite numbers', () => {
    const deep: Record<string, unknown> = { d1: { d2: { d3: { d4: { d5: { d6: { d7: 1 } } } } } } };
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    const s = mapLab({ ...labFixture(), deep, wide, long: 'x'.repeat(500), html: '<img src=x onerror=alert(1)> plain', link: 'see https://evil.example/steal?c=1 and www.evil.example now', path: 'at /home/max/secret-dir/file.json', nan: NaN, inf: Infinity, api_token: 'sk-1', 'weird key!': 1, [`${'k'.repeat(60)}`]: 1, list: Array.from({ length: 50 }, (_, i) => i), fn: 'ok', mixed: [1, 'a', null, { x: 1 }, [2]] });
    expect(s.extra.deep).toEqual({ d1: { d2: { d3: { d4: { d5: {} } } } } });
    expect(Object.keys(s.extra.wide as object)).toHaveLength(LAB_EXTRA_LIMITS.keys);
    expect((s.extra.long as string).length).toBe(LAB_EXTRA_LIMITS.text);
    expect(s.extra.html).toBe('… plain');
    expect(s.extra.link).toBe('see … and … now');
    expect(s.extra.path).toBe('at …');
    expect(s.extra.nan).toBeNull();
    expect(s.extra.inf).toBeNull();
    expect(s.extra).not.toHaveProperty('api_token');
    expect(s.extra).not.toHaveProperty('weird key!');
    expect((s.extra.list as unknown[]).length).toBe(LAB_EXTRA_LIMITS.items);
    expect(s.extra.mixed).toEqual([1, 'a', null, { x: 1 }, [2]]);
    expect(Object.keys(s.extra).some((k) => k.length > LAB_EXTRA_LIMITS.key)).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/<|>|https?:|sk-1|\/home\//);
    expect(extraValue(() => 1)).toBeUndefined();
    expect(extraValue(Symbol('x') as unknown)).toBeUndefined();
  });
});

describe('lab cache and status', () => {
  const setup = () => {
    let now = LAB_NOW;
    const fetchJson = vi.fn<(_: string, timeout: number) => Promise<unknown>>().mockResolvedValue(labFixture());
    return { fetchJson, service: createLabService({ fetchJson, now: () => now }), advance: (ms = LAB_CACHE_MS) => { now += ms; } };
  };
  it('coalesces concurrent reads and caches successful AND failed reads for 60 seconds', async () => {
    const { fetchJson, service, advance } = setup();
    await Promise.all([service.get(), service.get(), service.get()]);
    expect(fetchJson).toHaveBeenCalledExactlyOnceWith(LAB_URL, LAB_TIMEOUT_MS);
    advance(59_999); await service.get(); expect(fetchJson).toHaveBeenCalledTimes(1);
    advance(1); fetchJson.mockRejectedValue(new Error('fetch failed')); const failed = await service.get();
    expect(failed).toMatchObject({ state: 'error', failures: 1, stale: true });
    expect(failed.snapshot?.books?.[0]?.equity).toBe(60170.39);
    await Promise.all([service.get(), service.get()]); expect(fetchJson).toHaveBeenCalledTimes(2);
    advance(); expect((await service.get()).failures).toBe(2);
    advance(); expect(await service.get()).toMatchObject({ state: 'offline', failures: 3 });
    expect(fetchJson).toHaveBeenCalledTimes(4);
    fetchJson.mockResolvedValue(labFixture()); advance(); expect((await service.get()).failures).toBe(0);
  });
  it('throttles failures with no snapshot and goes offline on the third network failure', async () => {
    const { fetchJson, service, advance } = setup(); fetchJson.mockRejectedValue(new Error('HTTP 503'));
    expect(await service.get()).toMatchObject({ snapshot: null, failures: 1 });
    await service.get(); expect(fetchJson).toHaveBeenCalledTimes(1);
    advance(); await service.get(); advance(); expect((await service.get()).state).toBe('offline');
  });
  it('retains the prior response on malformed JSON or unsafe schema without treating them as network outages', async () => {
    const { fetchJson, service, advance } = setup(); await service.get();
    fetchJson.mockRejectedValue(new SyntaxError('Unexpected token secret')); advance();
    expect(await service.get()).toMatchObject({ state: 'error', failures: 0, error: '응답 형식 오류' });
    fetchJson.mockResolvedValue({ ...labFixture(), live: true }); advance();
    expect((await service.get()).snapshot?.live).toBe(false);
    expect((await service.get()).state).toBe('error');
    expect(fetchJson).toHaveBeenCalledTimes(3);
  });
  it('marks stale at exactly 90s, prioritizes failed verification and replaces old values on loading', async () => {
    const { fetchJson, service, advance } = setup(); await service.get();
    advance(89_999); expect((await service.get()).state).toBe('ok');
    advance(1); expect((await service.get()).state).toBe('stale');
    fetchJson.mockResolvedValue({ ...labFixture(), verify: { ...labFixture().verify, ok: false, msg: 'broken chain' } }); advance();
    expect((await service.get()).state).toBe('verify-failed');
    fetchJson.mockRejectedValue(new Error('timeout'));
    for (let i = 0; i < 3; i++) { advance(); await service.get(); }
    expect(await service.get()).toMatchObject({ state: 'verify-failed', failures: 3 });
    fetchJson.mockResolvedValue({ ...labFixture(), engine: { ...labFixture().engine, paper: { ok: true, ready: false, live: false } } }); advance();
    expect(await service.get()).toMatchObject({ state: 'loading', snapshot: { books: [], recent_closed_trades: [], open_positions_total: null } });
    fetchJson.mockRejectedValue(new Error('timeout')); advance(); expect((await service.get()).snapshot?.books).toEqual([]);
  });
  it('replaces unavailable fields on a partial success instead of filling them with old values', async () => {
    const { fetchJson, service, advance } = setup(); await service.get();
    fetchJson.mockResolvedValue({ ...labFixture(), books: null, open_positions_total: null, errors: ['paper_state: timeout'] }); advance();
    const result = await service.get();
    expect(result).toMatchObject({ state: 'partial', failures: 0, snapshot: { books: null, open_positions_total: null } });
    expect(result.snapshot?.verify.ok).toBe(true);
  });
  it('never calls a structurally missing response healthy', async () => {
    const { fetchJson, service } = setup(); fetchJson.mockResolvedValue({ schema: 'cblabx_lab_summary/v1', live: false, read_only: true, errors: [] });
    expect((await service.get()).state).toBe('partial');
  });
});

function responseMock() {
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = { setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = v; }, writeHead: (s: number, h: Record<string, string>) => { out.status = s; Object.assign(out.headers, h); }, end: (v: string) => { out.body = v; finish(); } } as unknown as ServerResponse;
  return { out, res, done };
}
describe('lab route', () => {
  it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', undefined])('rejects %s without fetching', async method => {
    const service = { get: vi.fn() }; const { out, res } = responseMock(); await serveLab(service, method, res);
    expect(out.status).toBe(405); expect(out.headers.allow).toBe('GET'); expect(service.get).not.toHaveBeenCalled();
  });
  it('uses the existing session boundary without exposing a public endpoint', async () => {
    const service = createLabService({ fetchJson: async () => labFixture(), now: () => LAB_NOW });
    const get = vi.spyOn(service, 'get');
    const token = 'test-only-lab-cookie';
    const handler = createRequestHandler({ token, uiDir: '/unused', hub: { lab: service } } as HttpDeps);
    for (const authed of [false, true]) {
      const { out, res, done } = responseMock();
      handler({ url: '/api/hub/lab?url=http://evil.example', method: 'GET', headers: { host: 'localhost', ...(authed ? { cookie: `deck_session=${cookieValueFor(token)}` } : {}) } } as IncomingMessage, res);
      await done;
      expect(out.status).toBe(authed ? 200 : 401);
      expect(get).toHaveBeenCalledTimes(authed ? 1 : 0);
      expect(out.headers['cache-control']).toBe('no-store');
      expect(out.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
  it('strips secrets even from injected service output and sanitizes unexpected exceptions', async () => {
    const service = createLabService({ fetchJson: async () => labFixture(), now: () => LAB_NOW });
    const value = await service.get(); const a = responseMock();
    await serveLab({ get: async () => ({ ...value, token: 'hidden' }) }, 'GET', a.res);
    expect(a.out.body).not.toContain('hidden');
    const b = responseMock(); await serveLab({ get: async () => { throw new Error('/home/max/private'); } }, 'GET', b.res);
    expect(b.out.status).toBe(503); expect(b.out.body).not.toContain('private');
  });
});


describe('lab dedicated transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('only fetches the fixed URL with GET, no redirects and a timeout', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(labFixture()))); vi.stubGlobal('fetch', fetch);
    expect(await fetchLabJson('http://evil.example')).toMatchObject({ live: false });
    expect(fetch).toHaveBeenCalledWith(LAB_URL, expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) }));
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('credentials');
  });
  it('logs at most 200 redacted prefix characters on malformed JSON without exposing source strings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"api_key":"sk-secret","path":"/home/max/private","broken":"' + 'secret'.repeat(100))));
    await expect(fetchLabJson()).rejects.toBeInstanceOf(SyntaxError);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toHaveLength(200);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sk-secret|api_key|\/home\/|private/);
  });
  it('rejects non-200 and oversized bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 302 })).mockResolvedValueOnce(new Response('x'.repeat(2_000_001))));
    await expect(fetchLabJson()).rejects.toThrow('HTTP 302');
    await expect(fetchLabJson()).rejects.toThrow('too large');
  });
});
