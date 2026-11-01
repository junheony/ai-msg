import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookieValueFor } from '../auth';
import { createRequestHandler, type HttpDeps } from '../http';
import { labFixture, LAB_NOW } from '../../test/labFixture';
import { createLabService, fetchLabJson, LAB_CACHE_MS, LAB_TIMEOUT_MS, LAB_URL, mapLab, serveLab } from './lab';

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
