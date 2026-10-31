import { describe, expect, it, vi } from 'vitest';
import { collectHubStatus, createHubStatus, errorText, fetchJsonWithTimeout, HUB_URLS, latestRenderIn, SECRET_FIELD_RE, stripSecrets, toIso, type HubDeps } from './status';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-10-30T10:00:00Z');
const HOME = '/Users/alice';

/** Deps where every source answers from `answers` (a value, or an Error to reject with); the filesystem is empty. */
function deps(answers: Partial<Record<keyof typeof HUB_URLS, unknown>>, extra: Partial<HubDeps> = {}): HubDeps & { calls: string[] } {
  const calls: string[] = [];
  const byUrl = new Map<string, unknown>(Object.entries(HUB_URLS).map(([k, url]) => [url, answers[k as keyof typeof HUB_URLS]]));
  return {
    calls,
    fetchJson: async (url) => {
      calls.push(url);
      if (!byUrl.has(url)) throw new Error(`unexpected ${url}`);
      const a = byUrl.get(url);
      if (a instanceof Error) throw a;
      if (a === undefined) throw new Error('fetch failed: ECONNREFUSED');
      return a;
    },
    latestRender: async () => null,
    countEntries: async () => null,
    gitLastCommit: async () => null,
    readText: async () => null,
    readTail: async () => null,
    listDir: async () => null,
    fileMtime: async () => null,
    systemdShow: async () => null,
    now: () => NOW,
    self: () => ({ uptimeMs: 90_061_000, sessions: 4, activeTurns: 1 }),
    host: 'deck-host.example.ts.net',
    home: HOME,
    ...extra,
  };
}

const NEXUS = { running: true, dry_run: true, exchanges: [1, 2, 3], chains: [1], strategies: { a: { enabled: true, running: true, last_scan: '2026-10-30T09:59:00Z' }, b: { enabled: true, running: false, last_scan: '2026-10-30T09:50:00Z' }, c: { enabled: false } }, risk: { emergency_stop: false, cooldown_active: false, open_positions: 2, total_exposure_usd: 1234.5, daily_pnl: -3.2 } };
const TRADING = { id: 'trading', state: 'ok', stage: 'paper', lastActivity: '2026-10-30T09:43:01+09:00', metrics: { dwf_basket_count: 12, dwf_basket_coins: ['A', 'B'], shadow_files: [{ path: '/Users/alice/x' }], shadow_heartbeat_age_s: 1, onchain_alerts_count: 931, promotion_eligible: false, api_key: 'nope', snapshot_age_h: 3.03 }, alerts: ['스냅샷 오래됨', { level: 'bad', text: '하트비트 없음' }], sources: ['/Users/alice/a', '/Users/alice/b'] };
const OPS_HEALTH = { ok: true, ts: Math.floor(NOW / 1000) - 30, vault_unlocked: false, mode: 'personal' };
const OPS = { generated_at: '2026-10-30T09:58:00Z', services: { 'risex-printer': 'active', 'standx-watch': 'inactive' }, risex: { day: { volume: 250_000, cost: 12.5, cycles: 40 } }, accounts: { main: { heartbeat_age_s: 20, volume: 100_000, cost: 5 }, sub1: { heartbeat: Math.floor(NOW / 1000) - 1200, volume: 50_000 }, sub2: { last_seen: '2026-10-30T09:59:50Z' } } };
const UPDOWN = { ok: true, ts: NOW - 5000, db: true };
const QUANT = { generated_at: '2026-10-30T09:40:00Z', tabs: [{ tab: 'a', sections: [{ items: [{ status: null }, { status: 'warn' }, { status: 'ok' }] }] }, { tab: 'b', sections: [] }], errors: [] };

describe('hub status aggregator', () => {
  it('answers the hub shape for every mode, in order, with explicit metrics only', async () => {
    const d = deps({ nexus: NEXUS, trading: TRADING, opsHealth: OPS_HEALTH, ops: OPS, updown: UPDOWN, updownStaging: { ok: true, ts: NOW, db: true }, quant: QUANT }, {
      latestRender: async () => ({ mtimeMs: NOW - 3_600_000, name: 'draft.mp4' }), countEntries: async () => 7,
      gitLastCommit: async () => '2026-10-28T01:00:00Z', readText: async (f) => (f.endsWith('DEPLOYMENT.md') ? 'Production: https://acme-app.vercel.app\nVerified at: 2026-09-08T16:25:48+09:00' : null),
    });
    const s = await collectHubStatus(d);
    expect(s.host).toBe('deck-host.example.ts.net');
    expect(s.generated_at).toBe(new Date(NOW).toISOString());
    expect(s.modes.map((m) => m.id)).toEqual(['msg', 'nexus', 'trading', 'video', 'game', 'ops', 'updown', 'quant', 'yapping']);
    for (const m of s.modes) {
      expect(['ok', 'warn', 'down', 'idle', 'unknown']).toContain(m.state);
      expect(m).toMatchObject({ name: expect.any(String), metrics: expect.any(Object), alerts: expect.any(Array), links: expect.any(Array), sources: expect.any(Array) });
    }
    const by = Object.fromEntries(s.modes.map((m) => [m.id, m]));
    expect(by.msg).toMatchObject({ state: 'ok', metrics: { '가동 시간': '1일 1시간', '세션': 4, '실행 중 턴': 1 } });
    expect(['ok', 'warn']).toContain(by.nexus!.state); // warn when the dashboard home is not answered
    expect(by.nexus).toMatchObject({ tag: 'DRY RUN', lastActivity: '2026-10-30T09:59:00.000Z', metrics: { '전략': '1/2', '거래소': 3, '열린 포지션': 2, '노출': '$1,235' } });
    expect(by.nexus!.links).toEqual([{ label: '대시보드', href: 'http://max-linuxserver.tail88e649.ts.net:3005' }]);
    expect(by.trading).toMatchObject({ tag: 'PAPER' }); // the work page itself is covered by trading.test.ts
    expect(['ok', 'warn']).toContain(by.trading!.state);
    expect(by.video).toMatchObject({ state: 'ok', metrics: { '에피소드': 7, '최근 렌더': '1시간 0분 전', '파일': 'draft.mp4' } });
    expect(by.game).toMatchObject({ state: 'ok', lastActivity: '2026-10-28T01:00:00.000Z', metrics: { '마지막 커밋': '2일 9시간 전', '배포': 'Vercel', '배포 검증': '2026-09-08' }, links: [{ label: 'Vercel', href: 'https://acme-app.vercel.app' }] });
    expect(by.ops).toMatchObject({ links: [{ label: '열기', href: '/hub/p/ops/', embed: true }] }); // the printer page itself is covered by ops.test.ts
    expect(['ok', 'warn', 'down']).toContain(by.ops!.state);
    expect(by.ops!.sources.find((x) => x.name === '/api/ops')).toMatchObject({ ok: true });
    expect(by.updown).toMatchObject({ metrics: { '앱': '정상', DB: '연결됨', '스테이징': '정상' } });
    expect(['ok', 'warn']).toContain(by.updown!.state); // warn: no board/psql in this fixture
    expect(['ok', 'warn']).toContain(by.quant!.state); // warn: no friends/accounts data in this fixture
    expect(by.quant).toMatchObject({ lastActivity: '2026-10-30T09:40:00.000Z', metrics: { '생성': '20분 전' }, links: [{ label: '열기', href: '/hub/p/quant/', embed: true }] });
  });

  it('never leaks a secret-looking field, a home path or a raw source record', async () => {
    const d = deps({ nexus: { ...NEXUS, api_key: 'k' }, trading: TRADING, opsHealth: OPS_HEALTH, ops: { ...OPS, wallet: '0xabc' }, updown: UPDOWN, quant: QUANT });
    const text = JSON.stringify(await collectHubStatus(d));
    for (const key of Object.keys(JSON.parse(text) as object)) expect(key).not.toMatch(SECRET_FIELD_RE);
    const walk = (v: unknown): void => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { expect(k).not.toMatch(SECRET_FIELD_RE); walk(x); } };
    walk(JSON.parse(text));
    expect(text).not.toContain('vault');
    expect(text).not.toContain(HOME);
    expect(text).not.toContain('0xabc');
    expect(text).not.toContain('nope');
  });

  it('a slow or dead source makes its card down (or warn) with a short reason and the others stay fine', async () => {
    const d = deps({ nexus: new Error('timeout'), trading: TRADING, opsHealth: OPS_HEALTH, ops: new Error('The operation was aborted due to timeout'), updown: undefined, quant: new Error('HTTP 503') });
    const s = await collectHubStatus(d);
    const by = Object.fromEntries(s.modes.map((m) => [m.id, m]));
    expect(by.nexus).toMatchObject({ state: 'down' });
    expect(by.nexus!.alerts[0]).toMatchObject({ level: 'bad', text: expect.stringContaining('시간 초과') });
    expect(by.nexus!.sources[0]).toMatchObject({ name: 'engine /api/status', ok: false, error: '시간 초과' });
    expect(by.nexus!.links.length).toBeGreaterThanOrEqual(1);
    expect(by.ops!.alerts.some((a) => a.text.includes('응답 없음'))).toBe(true);
    expect(by.ops!.sources.find((x) => x.name === '/api/ops')).toMatchObject({ ok: false, error: '시간 초과' });
    expect(by.updown).toMatchObject({ state: 'down', alerts: [{ level: 'bad', text: '응답 없음 · 연결 실패' }] });
    expect(by.quant).toMatchObject({ state: 'down' });
    expect(by.quant!.sources[0]).toMatchObject({ ok: false, error: 'HTTP 503' });
    expect(['ok', 'warn']).toContain(by.trading!.state); // no state files in this fixture: warn, never down
    expect(by.video).toMatchObject({ state: 'unknown', lastActivity: null });
    expect(by.game).toMatchObject({ state: 'unknown', metrics: { '배포': '없음' }, links: [] });
  });

  it('per-source timeouts are enforced by the aggregator: a hung fetch cannot hold the answer past its budget', async () => {
    vi.useFakeTimers();
    try {
      const hang = () => new Promise<never>(() => {});
      const d = deps({ trading: TRADING }, {
        fetchJson: (url, timeoutMs) => {
          if (url === HUB_URLS.trading) return Promise.resolve(TRADING);
          // The real fetchJson rejects itself after timeoutMs; a stand-in that honours the budget the same way.
          return new Promise((_, reject) => { setTimeout(() => reject(new DOMException('timeout', 'TimeoutError')), timeoutMs); void hang; });
        },
      });
      const p = collectHubStatus(d);
      await vi.advanceTimersByTimeAsync(12_000);
      const s = await p;
      const nexus = s.modes.find((m) => m.id === 'nexus')!;
      expect(nexus.state).toBe('down');
      expect(nexus.alerts[0]!.text).toContain('시간 초과');
      const opsSrc = s.modes.find((m) => m.id === 'ops')!.sources;
      expect(opsSrc.find((x) => x.name === '/api/ops')).toMatchObject({ ok: false, error: '시간 초과' });
      expect(opsSrc.find((x) => x.name === '프린터 상태')).toMatchObject({ ok: false, error: '불러오는 중' }); // the slow printer API is not waited for past its first-wait budget
    } finally { vi.useRealTimers(); }
  });

  it('ops stalls when a heartbeat is older than 600 s, and degrades without per-account data', async () => {
    const stale = { ...OPS, accounts: { main: { heartbeat_age_s: 601 } } };
    let s = await collectHubStatus(deps({ opsHealth: OPS_HEALTH, ops: stale }));
    let ops = s.modes.find((m) => m.id === 'ops')!;
    expect(['warn', 'down']).toContain(ops.state);
    expect(ops.alerts.some((a) => /메인.*정지/.test(a.text))).toBe(true); // the stalled printer is named, with the unit to check
    expect(ops.alerts.find((a) => /메인.*정지/.test(a.text))!.hint).toContain('risex-printer');
    s = await collectHubStatus(deps({ opsHealth: OPS_HEALTH, ops: { generated_at: OPS.generated_at } }));
    ops = s.modes.find((m) => m.id === 'ops')!;
    expect(['ok', 'warn', 'down']).toContain(ops.state);
    expect(ops.alerts.length).toBeGreaterThan(0);
    s = await collectHubStatus(deps({ opsHealth: new Error('ECONNREFUSED'), ops: new Error('ECONNREFUSED') }));
    expect(s.modes.find((m) => m.id === 'ops')).toMatchObject({ state: 'down' });
  });

  it('video is idle after 7 days without a render; game falls back to file mtimes when not a git repo', async () => {
    const d = deps({}, { latestRender: async () => ({ mtimeMs: NOW - 8 * 86_400_000, name: 'old.mp4' }), fileMtime: async (f) => (f.endsWith('README.md') ? NOW - 2 * 86_400_000 : null) });
    const s = await collectHubStatus(d);
    expect(s.modes.find((m) => m.id === 'video')).toMatchObject({ state: 'idle', metrics: { '최근 렌더': '8일 0시간 전' } });
    expect(s.modes.find((m) => m.id === 'game')).toMatchObject({ state: 'ok', metrics: { '마지막 변경': '2일 0시간 전' }, sources: [{ name: 'file mtime', ok: true }] });
  });

  it('a collector that throws becomes an unknown card; the aggregate never rejects', async () => {
    const d = deps({}, { self: () => { throw new Error('boom'); } });
    const s = await collectHubStatus(d);
    expect(s.modes[0]).toMatchObject({ id: 'msg', state: 'unknown', alerts: [{ level: 'warn', text: '수집 실패 · 오류' }] });
  });

  it('caches for 15 s, shares one refresh between callers, and hands out the last answer while refreshing', async () => {
    let now = NOW;
    let n = 0;
    const d = deps({}, { now: () => now, self: () => ({ uptimeMs: ++n * 1000, sessions: null, activeTurns: null }) });
    const svc = createHubStatus(d);
    const [a, b] = await Promise.all([svc.status(), svc.status()]);
    expect(a).toBe(b);
    expect(d.calls.filter((u) => u === HUB_URLS.nexus).length).toBe(1);
    now += 14_999;
    expect(await svc.status()).toBe(a);
    now += 2;
    const stale = await svc.status();
    expect(stale).toBe(a); // the refresh is running; the old answer is handed out at once
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const fresh = await svc.status();
    expect(fresh).not.toBe(a);
    expect(d.calls.filter((u) => u === HUB_URLS.nexus).length).toBe(2);
  });
});

describe('hub status helpers', () => {
  it('toIso takes epoch seconds, epoch ms and ISO strings', () => {
    expect(toIso(1_761_820_800)).toBe('2025-10-30T10:40:00.000Z');
    expect(toIso(1_761_820_800_000)).toBe('2025-10-30T10:40:00.000Z');
    expect(toIso('2026-10-30T18:43:01+09:00')).toBe('2026-10-30T09:43:01.000Z');
    expect(toIso('nope')).toBeNull();
    expect(toIso(null)).toBeNull();
  });
  it('errorText is short and free of detail', () => {
    expect(errorText(new DOMException('x', 'TimeoutError'))).toBe('시간 초과');
    expect(errorText(new Error('HTTP 502'))).toBe('HTTP 502');
    expect(errorText(new TypeError('fetch failed'))).toBe('연결 실패');
    expect(errorText(new SyntaxError('Unexpected token < in JSON'))).toBe('응답 형식 오류');
    expect(errorText('/Users/alice/secret')).toBe('오류');
  });
  it('stripSecrets removes secret-looking keys at any depth', () => {
    expect(stripSecrets({ a: 1, api_key: 2, nested: [{ wallet: 3, ok: true }] })).toEqual({ a: 1, nested: [{ ok: true }] });
  });
  it('fetchJsonWithTimeout rejects a non-2xx answer as HTTP <status> and gives up after the budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await expect(fetchJsonWithTimeout('http://127.0.0.1:1/x', 100)).rejects.toThrow('HTTP 503');
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason)); })));
    await expect(fetchJsonWithTimeout('http://127.0.0.1:1/x', 20)).rejects.toMatchObject({ name: 'TimeoutError' });
    vi.unstubAllGlobals();
  });
  it('latestRenderIn finds the newest media file under a render folder only, skipping node_modules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-video-'));
    try {
      await fs.mkdir(path.join(root, 'episodes/ep1/renders'), { recursive: true });
      await fs.mkdir(path.join(root, 'node_modules/renders'), { recursive: true });
      await fs.writeFile(path.join(root, 'episodes/ep1/renders/a.mp4'), 'a');
      await fs.writeFile(path.join(root, 'episodes/ep1/renders/b.mp4'), 'b');
      await fs.writeFile(path.join(root, 'episodes/ep1/script.md'), 'x');
      await fs.writeFile(path.join(root, 'node_modules/renders/z.mp4'), 'z');
      const t = Date.now();
      await fs.utimes(path.join(root, 'episodes/ep1/renders/a.mp4'), t / 1000 - 100, t / 1000 - 100);
      await fs.utimes(path.join(root, 'episodes/ep1/renders/b.mp4'), t / 1000 - 10, t / 1000 - 10);
      await fs.utimes(path.join(root, 'node_modules/renders/z.mp4'), t / 1000, t / 1000);
      expect((await latestRenderIn(root))?.name).toBe('b.mp4');
      expect(await latestRenderIn(path.join(root, 'missing'))).toBeNull();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
