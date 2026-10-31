import { describe, expect, it } from 'vitest';
import type { HubSection } from '../../shared/hub-types';
import { collectNexus, hrefOf, mapNexusHome, NEXUS_LIMITS } from './nexus';
import { HUB_URLS, SECRET_FIELD_RE, stripSecrets, type HubDeps } from './shared';

const NOW = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST
const S = NOW / 1000;
const DASH = 'http://dash.example:3005';

function deps(urls: Partial<Record<keyof typeof HUB_URLS, unknown>>, links?: HubDeps['links']): HubDeps {
  const byUrl = new Map<string, unknown>(Object.entries(HUB_URLS).map(([k, url]) => [url, urls[k as keyof typeof HUB_URLS]]));
  return {
    fetchJson: async (url) => { const a = byUrl.get(url); if (a instanceof Error) throw a; if (a === undefined) throw new Error('fetch failed: ECONNREFUSED'); return a; },
    latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null, readText: async () => null, readTail: async () => null, listDir: async () => null, fileMtime: async () => null, systemdShow: async () => null,
    now: () => NOW, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: '/home/max', ...(links ? { links } : {}),
  };
}

const ENGINE = {
  running: true, dry_run: true,
  strategies: { kr_gap: { enabled: true, running: true, scan_count: 100, signal_count: 5, execution_count: 1, last_scan: S - 30, scan_interval: 60, open_positions: 0 } },
  risk: { emergency_stop: false, cooldown_active: false, daily_pnl: 12.5, daily_pnl_pct: 0.1, open_positions: 0, total_exposure_usd: 0, current_capital: 10000, kill_switches: { daily_pnl_threshold_pct: -5, current_collateral_ratio: 2, min_collateral_ratio: 1.2, max_consecutive_fails: 5, consecutive_fails: {} } },
  exchanges: ['upbit', 'bithumb'], chains: ['ETH'],
};

/** A home as :3005 answers it (the live shape), with a few secrets and odd values sprinkled in. */
function home(over: Record<string, unknown> = {}): Record<string, unknown> {
  const action = (i: number, extra: Record<string, unknown> = {}) => ({ id: `a:${i}`, kind: 'ops', source: 'ops', verdict: '고장', tone: 'bad', title: `고장 ${i} in /home/max/x.service`, action: '로그 보고 고친다', href: '/sys', nums: [{ k: '진짜', v: '13/29' }, { k: '채점', v: '29' }], detail: 'd', decide_title: 'dt', fold: true, ...extra });
  return {
    ok: true, ts: S - 20, late: [], prev_age: {},
    inbox: {
      ok: true, ts: S - 21,
      head: { armed_n: 0, kill: false, gap_age_s: 33.9, failed_nexus: 2, failed_all: 13 },
      actions: [
        action(1), action(2, { tone: 'warn', fold: null, source: 'crime_cex', kind: 'wallet', href: '/crime?sym=FET', api_key: 'SECRET1' }),
        action(3, { tone: 'info', fold: false, href: 'https://x.example/p', nums: ['plain'] }), action(4, { href: 'javascript:alert(1)' }), action(5, { href: '//evil.example/x' }),
        ...Array.from({ length: 30 }, (_, i) => action(10 + i)),
      ],
      near: [{ sym: 'ELF', buy: 'htx', sell: 'gate', gap_pct: 22.63, net_pct: null, depth_usd: 3.5, gate: 'route', why: '경로 막힘/미상', route_why: 'HTX 출금중지', suspect: true, since: S - 7200 }],
      funnel: { total: 197, route: 142, ident: 9, depth: 10, net: 36, pass: 0 },
      best_24h: { sym: 'PUNDIX', buy: 'kucoin', sell: 'upbit', net: 15.28, ts: S - 3600 },
      ops: [{ tone: 'bad', cat: '고장', title: 'x.service 실패', detail: 'why', ts: S - 300, href: '/sys', cmd: 'journalctl -u x', act: '고친다', yes: '고쳤음', no: '안 씀' }, { tone: 'q', cat: '키', title: '빗썸 키 점검', detail: 'd', href: '/exec', cmd: 'python3 go_live.py', act: 'a', yes: 'y', no: 'n', choices: ['a', 'b'] }],
      sources: { execgap: { ok: true } },
    },
    kr: { ok: true, age_s: 54, fresh: true, min_net: 5, best_net: 0.12, best_sym: 'CRO' },
    listing: { ok: true, age_s: 29.6, n_seen: 311, upcoming: [], pending: [{ sym: 'P' }], recent: [{ key: 'upbit:6714', ex: 'upbit', sym: 'NIL', kind: '마켓추가', network: 'Ethereum', notice_ts: S - 86400, open_ts: S - 86000, hedge_perp: true, m10: -0.08, m30: -0.09 }] },
    market: { btc: { v: -5, px: 77252.96 }, alt: { v: -6.479, n: 679 }, kimp: { v: 0.0008, n: 198 }, pulse_age_s: 30, blocked: { upbit: 42, bithumb: 57, why: {} } },
    peg: { bank: 1338.04, upbit_usdt: 1345, age_s: 10, tprem: 0.52 },
    halts: [{ ex: 'upbit', cur: 'XRP', state: 'paused', since: S - 600 }], halts_age_s: 246,
    wallet: {
      ok: true, kol_ok: true, kol_age_s: 41.9, persons24: 74, usd24: 49980429,
      feed: Array.from({ length: 40 }, (_, i) => ({ t: S - 60 * i, kind: i % 3 ? 'kol' : 'team', who: `who${i}`, sym: 'ONDO', usd: 1000 * i, venue: 'upbit', kr: true, wallet_address: '0xdead' })),
      coins: Array.from({ length: 20 }, (_, i) => ({ sym: `C${i}`, persons: i, usd: 100 * i })),
      deposits_hidden_n: 34, deposits_min_usd: 50000, deposit_residual: [{ store: 's' }],
    },
    score: { ok: true, age_s: 37, rows: Array.from({ length: 25 }, (_, i) => ({ key: `sig${i}`, name: `신호 ${i} (sig${i})`, hit: i, scored: 10, hit_pct: i * 10, med_usd_1k: i - 5, verdict: '된다', policy: 'send' })) },
    today: { real: [{ t: S - 1000, sym: 'KERNEL', route: 'kr_gap', net1k: 17.18, why: '이체 도착 후에도 순 +1.72%' }], armed_n: 0, day_start: S - 36000 },
    band: { t0: S - 36000, t1: S + 7200, now: S, bin_s: 600, bins: Array.from({ length: 300 }, (_, i) => ({ t: S - 36000 + 600 * i, max: 1 + (i % 5) / 10, sym: '0G', buy: 'bithumb', sell: 'upbit' })), bins_age_s: 54 },
    ...over,
  };
}
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));

describe('mapNexusHome', () => {
  const h = mapNexusHome(home(), DASH);
  it('keeps hrefs only when http(s) or site-relative, rewriting paths onto the dashboard', () => {
    expect(hrefOf('/sys', DASH)).toBe(`${DASH}/sys`);
    expect(hrefOf('https://x.example/p', DASH)).toBe('https://x.example/p');
    expect(hrefOf('javascript:alert(1)', DASH)).toBeNull();
    expect(hrefOf('//evil.example/x', DASH)).toBeNull();
    expect(hrefOf(42, DASH)).toBeNull();
    expect(h.actions[0]!.href).toBe(`${DASH}/sys`);
    expect(h.actions[1]!.href).toBe(`${DASH}/crime?sym=FET`);
    expect(h.actions[2]!.href).toBe('https://x.example/p');
    expect(h.actions[3]!.href).toBeNull();
    expect(h.actions[4]!.href).toBeNull();
    expect(h.ops[0]!.href).toBe(`${DASH}/sys`);
  });
  it('bounds every array and scrubs strings (home paths blanked)', () => {
    expect(h.actions.length).toBe(NEXUS_LIMITS.actions);
    expect(h.flows.feed.length).toBe(NEXUS_LIMITS.feed);
    expect(h.flows.coins.length).toBe(NEXUS_LIMITS.coins);
    expect(h.score.rows.length).toBe(NEXUS_LIMITS.score);
    expect(h.band.bins.length).toBe(NEXUS_LIMITS.bins);
    expect(JSON.stringify(h)).not.toContain('/home/max');
    expect(h.actions[0]!.title).toBe('고장 1 in …');
  });
  it('maps the live shapes: nums → strings, fold → fix, near rows and best_24h → text, epoch → ISO, arrays → counts', () => {
    expect(h.actions[0]!.nums).toEqual(['진짜 13/29', '채점 29']);
    expect(h.actions[2]!.nums).toEqual(['plain']);
    expect(h.actions[0]!.fold).toBe('fix');
    expect(h.actions[1]!.fold).toBeNull();
    expect(h.actions[2]!.fold).toBeNull();
    expect(h.near[0]).toMatchObject({ kind: 'near', title: 'ELF HTX→게이트', tone: 'warn', verdict: '경로 막힘/미상', action: 'HTX 출금중지', nums: ['갭 +22.63%', '순 모름', '깊이 $3.50'] });
    expect(h.best_24h).toBe('PUNDIX 쿠코인→업비트 +15.28% · 10-30 21:00');
    expect(h.ts).toBe(new Date((S - 20) * 1000).toISOString());
    expect(h.ops[0]!.ts).toBe(new Date((S - 300) * 1000).toISOString());
    expect(h.band.bins[0]!.t).toBe(new Date((S - 36000) * 1000).toISOString());
    expect(h.listing.upcoming).toBe(0);
    expect(h.listing.pending).toBe(1);
    expect(h.listing.recent[0]).toMatchObject({ ex: 'upbit', sym: 'NIL', hedge_perp: '가능', m10: -0.08 });
    expect(h.halts).toEqual(['업비트 XRP 입출금 중단 21:50~']);
    expect(h.market.blocked).toBeNull();
    expect(h.market.blocked_n).toEqual({ upbit: 42, bithumb: 57 });
    expect(h.late).toBe(false);
    expect(h.score.rows[3]).toMatchObject({ sig: 'sig3', name: '신호 3 (sig3)', hit: 3, scored: 10, hit_pct: 30, med_usd_1k: -2 });
    expect(h.flows).toMatchObject({ persons24: 74, usd24: 49980429, deposits_hidden_n: 34, deposits_min_usd: 50000 });
    expect(h.flows.feed[1]).toMatchObject({ kind: 'kol', who: 'who1', sym: 'ONDO', usd: 1000, venue: 'upbit', kr: true });
  });
  it('drops the dashboard\'s decision knobs (cmd/act/yes/no/choices) from ops and every secret-named field', () => {
    const json = JSON.stringify(h);
    for (const k of ['"cmd"', '"act"', '"yes"', '"no"', '"choices"', 'journalctl', 'go_live', 'SECRET1', '0xdead', 'api_key', 'wallet_address', 'decide_title']) expect(json).not.toContain(k);
    expect(Object.keys(h.ops[0]!).sort()).toEqual(['cat', 'detail', 'href', 'title', 'tone', 'ts']);
  });
  it('survives stripSecrets unchanged: no NexusHome field name matches SECRET_FIELD_RE', () => {
    expect(SECRET_FIELD_RE.test('wallet')).toBe(true);
    expect(SECRET_FIELD_RE.test('key')).toBe(true);
    const stripped = stripSecrets(h);
    expect(stripped).toEqual(h);
    expect(stripped.flows.feed.length).toBe(NEXUS_LIMITS.feed);
    expect(stripped.score.rows[0]!.sig).toBe('sig0');
    const names = new Set<string>();
    const walk = (v: unknown): void => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { names.add(k); walk(x); } };
    walk(h);
    expect([...names].filter((k) => SECRET_FIELD_RE.test(k))).toEqual([]);
  });
  it('sets the five tabs as outside links on the dashboard, 지금 first', () => {
    expect(h.tabs).toEqual([{ label: '지금', href: `${DASH}/` }, { label: '상장', href: `${DASH}/listing` }, { label: '갭', href: `${DASH}/arb` }, { label: '지갑', href: `${DASH}/coins` }, { label: '더보기', href: `${DASH}/alerts` }]);
  });
  it('tolerates an empty or odd home (nothing throws; arrays empty; late as a list)', () => {
    const e = mapNexusHome({}, DASH);
    expect(e.actions).toEqual([]); expect(e.band.bins).toEqual([]); expect(e.ts).toBeNull(); expect(e.late).toBe(false); expect(e.flows.feed).toEqual([]);
    const l = mapNexusHome({ late: ['inbox', 'market'], inbox: 'nope', band: { bins: [{ t: 'bad' }, { t: S }] } }, DASH);
    expect(l.late).toBe(true); expect(l.late_what).toEqual(['inbox', 'market']); expect(l.band.bins.length).toBe(1);
  });
});

describe('collectNexus', () => {
  it('puts the home on mode.nexus with both sources, no 요약 kv (the home says it) and the engine sections collapsed', async () => {
    const m = await collectNexus(deps({ nexus: ENGINE, nexusHome: home() }, { nexus: 'http://dash.example:3005/' }));
    expect(m.state).toBe('warn');
    expect(m.tag).toBe('DRY RUN');
    expect(m.nexus).toBeDefined();
    expect(m.nexus!.actions.length).toBe(NEXUS_LIMITS.actions);
    expect(m.nexus!.tabs[1]!.href).toBe('http://dash.example:3005/listing');
    expect(m.sources.map((s) => [s.name, s.ok])).toEqual([['engine /api/status', true], ['dashboard /api/v2/home', true]]);
    expect(m.page!.headline).toContain('할 일 20');
    expect(m.page!.decision).toContain('고장·알람');
    const secs = m.page!.sections;
    expect(section(secs, /^요약$/)).toBeUndefined();
    expect(m.page!.kpis.map((k) => k.label)).toEqual(['할 일', '국내갭 최고', '전략 실행', '신호 / 체결', '일간 손익', '열린 포지션']);
    expect(section(secs, /전략/)).toMatchObject({ kind: 'table' });
    expect(section(secs, /전략/)!.open).toBeFalsy();
    expect(secs.at(-1)).toMatchObject({ kind: 'raw', href: 'http://dash.example:3005' });
    expect(m.alerts.some((a) => a.text.includes('유닛 실패 2'))).toBe(true);
    expect(m.page!.kpis.map((k) => k.label)).toContain('할 일');
    expect(m.metrics['할 일']).toBe(20);
    const stripped = stripSecrets(m);
    expect(stripped.nexus!.flows.feed.length).toBe(NEXUS_LIMITS.feed);
  });
  it(':3005 down → mode.nexus undefined, a warn alert, the engine page still works', async () => {
    const m = await collectNexus(deps({ nexus: ENGINE }));
    expect(m.nexus).toBeUndefined();
    expect(m.state).toBe('warn');
    expect(m.alerts.some((a) => a.level === 'warn' && a.text === '대시보드 응답 없음')).toBe(true);
    expect(m.sources[1]).toMatchObject({ name: 'dashboard /api/v2/home', ok: false, error: '연결 실패' });
    expect(m.page!.headline).toContain('DRY RUN');
    expect(section(m.page!.sections, /요약/)).toBeUndefined();
    expect(section(m.page!.sections, /전략/)).toBeDefined();
  });
  it(':8080 down but :3005 up → down state, 엔진 응답 없음 alert, the home still shown', async () => {
    const m = await collectNexus(deps({ nexusHome: home() }));
    expect(m.state).toBe('down');
    expect(m.nexus).toBeDefined();
    expect(m.alerts[0]).toMatchObject({ level: 'bad', text: '엔진 응답 없음 · 연결 실패' });
    expect(m.page!.headline).toContain('엔진 응답 없음');
    expect(section(m.page!.sections, /^요약$/)).toBeUndefined();
    expect(m.page!.kpis[0]!.label).toBe('할 일');
  });
  it('both down → downMode with both sources and the dashboard warn', async () => {
    const m = await collectNexus(deps({}));
    expect(m.state).toBe('down');
    expect(m.nexus).toBeUndefined();
    expect(m.sources.length).toBe(2);
    expect(m.alerts.map((a) => a.text)).toContain('대시보드 응답 없음');
  });
  it('caches the home per deps for 20 s (one fetch for two collects)', async () => {
    let n = 0;
    const d = deps({ nexus: ENGINE, nexusHome: home() });
    const inner = d.fetchJson;
    d.fetchJson = async (url, t) => { if (url === HUB_URLS.nexusHome) n += 1; return inner(url, t); };
    await collectNexus(d); await collectNexus(d);
    expect(n).toBe(1);
  });
});
