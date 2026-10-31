import { describe, expect, it } from 'vitest';
import type { HubCardItem, HubSection } from '../../shared/hub-types';
import { MACBOOK_SSH_ARGS, collectOps, fmtSignedUsd, fmtUsdCompact, parseEtime, parseMacProbe } from './ops';
import { HUB_URLS, type HubDeps } from './shared';

const NOW = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST
const HOME = '/Users/alice';
const sec = (offsetS: number): number => NOW / 1000 + offsetS;

/* ───────── fixtures ───────── */

const fee = (tier: number, taker: number, maker: number, vol14d: number, nextThreshold: number) => ({ tier, taker_bps: taker, maker_bps: maker, volume_14d: vol14d, next_tier: tier + 1, next_threshold: nextThreshold, next_remaining: nextThreshold - vol14d, next_taker_bps: taker - 0.4, next_maker_bps: maker - 0.25, source: 'printer ledgers, 14d (estimate)' });
const lane = (market: string, vol: number, cost: number, why = '', over = false) => ({ market, state: 'running', why, yielded: false, quoting: true, today_volume: vol, today_cost: cost, today_bps: (cost / vol) * 1e4, over_ceiling: over });
const row = (profile: string, label: string, o: Record<string, unknown>) => ({
  profile, label, address: '0xABC', daemon: 'alive', updated: sec(-40), markets: ['QQQ', 'SPY', 'XAU'], preparing: false,
  ceiling: { bps: 3.5, source: 'unit', unit_bps: 3.5, override_bps: null }, over_ceiling: false, remote_host: null, watch: null, overlap: ['QQQ', 'SPY', 'XAU'],
  cycle: { started: sec(-3600), status: 'running', volume: 50_000, cost: 10, bps: 2 }, lanes_now: [lane('QQQ', 30_000, 6), lane('SPY', 20_000, 4), lane('XAU', 50_000, 8)], ...o,
});
const STATUS = {
  unit: 'risex-printer', active: 'active', health: 'PRINTING', why: 'printing; today $49.30 of $2700', live: true, unit_is_live: true,
  day: { day: '2026-10-30', volume: 100_000, cost: 20, bps: 2, cycles: 1 },
  accounting: { lifetime: { volume: 92_594_176, cost: 22_469.27, bps: 2.4266 } },
  accounts: {
    rows: [
      row('main', '본계정', { volume: 100_000, cost: 20, bps: 2, fee_tier: fee(3, 2.1, 0.5, 38_883_623, 100_000_000), watch: { unit: 'risex-watch.timer', level: 'OK', ts: sec(-100), age_s: 100, stale: false, why: 'running; today $20 spent, last print 0.0h ago' } }),
      row('sub1', '서브1 (0x733a)', { volume: 50_000, cost: 12.5, bps: 2.5, fee_tier: fee(2, 2.5, 0.75, 24_800_000, 25_000_000) }),
      row('sub2', '서브2 · MacBook', { volume: 200_000, cost: 30, bps: 1.5, remote_host: 'MacBook', fee_tier: fee(2, 2.5, 0.75, 10_000_000, 25_000_000), lanes_now: [lane('QQQ', 100_000, 15), lane('XAU', 100_000, 15, `waiting: ${HOME}/StandX_volume/logs/x.log says screen found no market`)] }),
      row('sub3', '서브3 · MacBook', { volume: 120_000, cost: 30, bps: 2.5, remote_host: 'MacBook', fee_tier: fee(1, 3, 1, 3_400_000, 5_000_000) }),
    ],
    totals: { volume: 470_000, cost: 92.5, bps: 1.968, accounts: 4, alive: 4, preparing: 0, overlaps: [{ market: 'QQQ', accounts: ['main', 'sub1', 'sub2', 'sub3'] }] },
  },
};
const OPS = {
  generated_at: new Date(NOW - 120_000).toISOString(), services: { 'risex-printer': 'active', 'standx-watch': 'inactive', 'standx-dashboard': 'active' },
  risex: {
    day: { day: '2026-10-30', volume: 100_000, cost: 20, cycles: 1, bps: 2 },
    cost: {
      days: 7, market: 'XAU', trips: 6956, volume_usd: 3_890_138, trip_cost_usd: 776.64, trip_cost_bps: 1.9964,
      buckets: { actual_fee: { usd: 598.55, bps: 1.5386 }, spread_slippage: { usd: 52.58, bps: 0.1352 }, emergency_premium: { usd: 64.44, bps: 0.1656 }, hold_period_pnl: { usd: 61.07, bps: 0.157 }, funding: { usd: 0, bps: 0 } },
      settlements_usd: -719.29, settlement_detail: { rebate: -170.18, unexplained_residual: -549.11, external_adjustment: 0 },
      maker_attempted: 11545, maker_filled: 4094, maker_fill_rate: 0.3546, implied_maker_share: 0.7307,
    },
  },
};
const UNIT_UP = (since: string): Record<string, string> => ({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running', NRestarts: '0', ActiveEnterTimestamp: since, Result: 'success' });
const UNIT_DEAD: Record<string, string> = { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', NRestarts: '0', ActiveEnterTimestamp: '', InactiveEnterTimestamp: '', Result: 'success' };
const UNITS = { 'risex-printer.service': UNIT_UP('Thu 2026-10-29 11:37:56 UTC'), 'risex-printer@sub1.service': UNIT_UP('Thu 2026-10-29 11:17:21 UTC'), 'risex-printer@sub2.service': UNIT_DEAD, 'risex-printer@sub3.service': UNIT_DEAD };
const SSH_BLOB = ['PID main none', 'PID sub1 none', 'PID sub2 72748', 'ETIME sub2 01-05:24:51 2026년 10월 29일 목요일 20시 22분 47초', 'PID sub3 78273', 'ETIME sub3 01-05:20:15 2026년 10월 29일 목요일 20시 27분 23초', `UPTIME  1:47  up 3 days,  6:05, 1 user, load averages: 1.81 2.53 3.14`, ''].join('\n');

const daemonJson = (lifetimeVol: number, lifetimeCost: number, dayVol: number, dayCost: number): string => JSON.stringify({ updated: sec(-300), status: 'running', live: true, day: { day: '2026-10-30', volume: dayVol, cost: dayCost, cycles: 0 }, markets: ['QQQ', 'SPY', 'XAU'], lifetime_volume: lifetimeVol, lifetime_cost: lifetimeCost, lifetime_bps: (lifetimeCost / lifetimeVol) * 1e4 });
const multiJson = (updatedS: number): string => JSON.stringify({ live: true, status: 'running', started: sec(-3600), updated: updatedS, markets: ['QQQ', 'SPY', 'XAU'] });
const dayJson = (vol: number, cost: number): string => JSON.stringify({ day: '2026-10-30', volume: vol, cost, cycles: 1 });
const FILES: Record<string, string> = {
  'StandX_volume/reports/risex_daemon.json': daemonJson(2_332_432, 566.61, 90_000, 18), 'StandX_volume/reports/risex_printer_multi.json': multiJson(sec(-45)), 'StandX_volume/state_daemon/day.json': dayJson(100_000, 20),
  'StandX_volume/profiles/sub1/reports/risex_daemon.json': daemonJson(154_382, 35.74, 20_000, 5), 'StandX_volume/profiles/sub1/reports/risex_printer_multi.json': multiJson(sec(-50)), 'StandX_volume/profiles/sub1/state_daemon/day.json': dayJson(50_000, 12.5), 'StandX_volume/profiles/sub1/label.txt': '서브1 (0x733a)\n',
  'StandX_volume/profiles/sub2/reports/risex_daemon.json': daemonJson(1_681_197, 282.03, 70_000, 11), 'StandX_volume/profiles/sub2/reports/risex_printer_multi.json': multiJson(sec(-70)), 'StandX_volume/profiles/sub2/state_daemon/day.json': dayJson(200_000, 30), 'StandX_volume/profiles/sub2/label.txt': '서브2 · MacBook\n', 'StandX_volume/profiles/sub2/remote_host.txt': 'MacBook\n',
  'StandX_volume/profiles/sub3/reports/risex_daemon.json': daemonJson(1_038_387, 285.4, 60_000, 16), 'StandX_volume/profiles/sub3/reports/risex_printer_multi.json': multiJson(sec(-75)), 'StandX_volume/profiles/sub3/state_daemon/day.json': dayJson(120_000, 30), 'StandX_volume/profiles/sub3/label.txt': '서브3 · MacBook\n', 'StandX_volume/profiles/sub3/remote_host.txt': 'MacBook\n',
};

interface Fx { status?: unknown; ops?: unknown; units?: Record<string, Record<string, string>>; files?: Record<string, string>; ssh?: string | null; noExec?: boolean }
interface Calls { fetch: string[]; exec: string[][] }

/** Deps over canned URLs, an in-memory home folder, canned systemd units and a canned ssh answer; `now` is a mutable clock. */
function deps(fx: Fx = {}): { deps: HubDeps; calls: Calls; clock: { now: number } } {
  const calls: Calls = { fetch: [], exec: [] };
  const clock = { now: NOW };
  const byUrl = new Map<string, unknown>([[HUB_URLS.printerStatus, fx.status ?? STATUS], [HUB_URLS.ops, fx.ops ?? OPS]]);
  const files = fx.files ?? FILES;
  const units: Record<string, Record<string, string>> = fx.units ?? UNITS;
  const rel = (p: string): string => (p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p);
  const d: HubDeps = {
    fetchJson: async (url) => { calls.fetch.push(url); const a = byUrl.get(url); if (a instanceof Error) throw a; if (a === undefined) throw new Error('fetch failed: ECONNREFUSED'); return a; },
    latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null,
    readText: async (f) => files[rel(f)] ?? null, readTail: async (f) => files[rel(f)] ?? null, listDir: async () => null, fileMtime: async () => null,
    systemdShow: async (u) => units[u] ?? { LoadState: 'not-found', ActiveState: 'inactive' },
    ...(fx.noExec ? {} : { exec: async (cmd, args) => { calls.exec.push([cmd, ...args]); return fx.ssh === undefined ? SSH_BLOB : fx.ssh; } }),
    now: () => clock.now, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
  };
  return { deps: d, calls, clock };
}
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));
const cards = (secs: HubSection[]): HubCardItem[] => (section(secs, /^프린터$/) as Extract<HubSection, { kind: 'cards' }>).items;
const rowOf = (c: HubCardItem, label: string): string | undefined => c.rows.find((r) => r.label === label)?.value;
const noHome = (v: unknown): void => { expect(JSON.stringify(v)).not.toContain(HOME); expect(JSON.stringify(v)).not.toMatch(/\/home\/[a-z]/); };

/* ───────── helpers ───────── */

describe('ops helpers', () => {
  it('parses ps etime and the MacBook probe blob', () => {
    expect(parseEtime('01-05:24:51')).toBe(((24 + 5) * 3600 + 24 * 60 + 51) * 1000);
    expect(parseEtime('05:24:51')).toBe((5 * 3600 + 24 * 60 + 51) * 1000);
    expect(parseEtime('24:51')).toBe((24 * 60 + 51) * 1000);
    expect(parseEtime('garbage')).toBeNull();
    const m = parseMacProbe(SSH_BLOB, 336);
    expect(m.procs).toMatchObject({ main: { pid: null }, sub1: { pid: null }, sub2: { pid: 72748, uptimeMs: parseEtime('01-05:24:51') }, sub3: { pid: 78273 } });
    expect(m.uptime).toBe('up 3 days,  6:05, 1 user, load averages: 1.81 2.53 3.14');
    expect(m.ms).toBe(336);
  });
  it('formats signed and compact dollars', () => {
    expect(fmtSignedUsd(-49.3)).toBe('−$49.30');
    expect(fmtSignedUsd(49.3)).toBe('$49.30');
    expect(fmtUsdCompact(61_116_376)).toBe('$61.12M');
    expect(fmtUsdCompact(2_332_432.5)).toBe('$2.33M');
    expect(fmtUsdCompact(1_500)).toBe('$1,500');
  });
  it('the ssh probe is a fixed, non-interactive argv', () => {
    expect(MACBOOK_SSH_ARGS.slice(0, 5)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', 'macbook-m4']);
    expect(MACBOOK_SSH_ARGS).toHaveLength(6);
    expect(MACBOOK_SSH_ARGS[5]).toMatch(/^for p in main sub1 sub2 sub3; do .*launchctl list.*UPTIME/s);
    expect(MACBOOK_SSH_ARGS[5]).not.toMatch(/launchctl (start|stop|unload|load|kickstart|bootout)|kill|rm |>/);
  });
});

/* ───────── the page ───────── */

describe('OPS collector', () => {
  it('shows four printer cards with host badges, uptime from systemd / launchd etime, PnL = −cost, tier, lifetime', async () => {
    const { deps: d } = deps();
    const m = await collectOps(d);
    expect(m).toMatchObject({ id: 'ops', state: 'ok', metrics: { '프린터': '4/4', '오늘 거래량': '$470,000', '오늘 비용': '$92.50 (2.0 bps)', '맥북': '연결' } });
    expect(m.tag).toBeUndefined();
    expect(m.page!.headline).toBe('프린터 4대 가동(서버 2 · 맥북 2) · 오늘 거래량 $470,000 · 비용 $92.50 (2.0 bps)');
    expect(m.page!.decision).toBe('서브1 티어 변경 임박 ($200,000 남음) — 테이커 2.5→2.1 bps');
    expect(m.page!.kpis.map((k) => [k.label, k.value])).toEqual([['오늘 거래량', '$470,000'], ['오늘 비용', '$92.50'], ['평균 bps', '1.97'], ['가동 프린터', '4/4'], ['7일 XAU 왕복 비용', '2.00'], ['메이커 체결률', '35.5%']]);
    expect(m.page!.kpis[1]).toMatchObject({ status: 'warn', hint: 'PnL −$92.50 · 거래량 프린터' });
    expect(m.page!.sections[0]).toMatchObject({ kind: 'cards', title: '프린터', open: true, cols: 2 });
    const cs = cards(m.page!.sections);
    expect(cs.map((c) => [c.title, c.badge, c.state])).toEqual([['메인', '서버', 'ok'], ['서브1', '서버', 'ok'], ['서브2', '맥북', 'ok'], ['서브3', '맥북', 'ok']]);
    expect(cs[0]!.sub).toBe('가동 1일 1시간 · 하트비트 40초 전');
    expect(cs[2]!.sub).toBe('가동 1일 5시간 · 하트비트 40초 전');
    expect(cs[2]!.note).toBe('launchd pid 72748');
    expect(cs[0]!.note).toBe('running; today $20 spent, last print 0.0h ago');
    expect(rowOf(cs[0]!, '오늘 거래량')).toBe('$100,000');
    expect(rowOf(cs[0]!, '오늘 비용')).toBe('$20.00 (2.0 bps)');
    expect(rowOf(cs[0]!, 'PnL')).toBe('−$20.00');
    expect(rowOf(cs[0]!, '수수료 티어')).toBe('T3 · 테이커 2.1 / 메이커 0.5 bps');
    expect(rowOf(cs[0]!, '다음 티어까지')).toBe('$61.12M 남음 (14일 $38.88M / T4 $100M)');
    expect(rowOf(cs[0]!, '평생 거래량')).toBe('$2.33M');
    expect(rowOf(cs[0]!, '평생 비용')).toBe('$566.61 (2.43 bps)');
    expect(rowOf(cs[0]!, '원장 누적')).toBe('$92.59M · 비용 $22,469 (2.43 bps)');
    expect(rowOf(cs[1]!, '원장 누적')).toBeUndefined();
    expect(rowOf(cs[0]!, '레인')).toBe('3 · QQQ·SPY·XAU');
    expect(rowOf(cs[0]!, '사이클')).toBe('진행 중 · $50,000 · 비용 $10.00');
    expect(rowOf(cs[0]!, '비용 천장')).toBe('3.50 bps');
    expect(cs[1]!.rows.find((r) => r.label === '다음 티어까지')).toMatchObject({ value: '$200,000 남음 (14일 $24.8M / T3 $25M)', status: 'warn' });
    expect(rowOf(cs[2]!, '평생 거래량')).toBe('$1.68M');
    expect(cs.every((c) => !c.links?.length)).toBe(true);
    expect(m.alerts).toEqual(expect.arrayContaining([{ level: 'info', text: '서브1 수수료 티어 T2→T3 임박 · $200,000 남음' }, { level: 'info', text: 'standx-watch inactive' }]));
    expect(m.alerts.some((a) => a.level === 'warn' || a.level === 'bad')).toBe(false);
    expect(m.sources.map((s) => [s.name, s.ok])).toEqual([['프린터 상태', true], ['/api/ops', true], ['맥북 ssh', true], ['미러 파일', true], ['systemd', true]]);
    expect(m.lastActivity).toBe(new Date(NOW - 40_000).toISOString());
    noHome(m);
  });

  it('kvgrid: Korean bucket labels with a meaning, aligned dollars, bps sub, settlement rows and the PnL note', async () => {
    const m = await collectOps(deps().deps);
    const g = section(m.page!.sections, /^비용 버킷/) as Extract<HubSection, { kind: 'kvgrid' }>;
    expect(g.title).toBe('비용 버킷 (7일 XAU · 메인)');
    expect(g.open).toBe(true);
    expect(g.rows.map((r) => [r.label, r.value, r.sub ?? null, r.status ?? null])).toEqual([
      ['거래소 수수료', '$598.55', '1.54 bps', 'warn'], ['스프레드·슬리피지', '$52.58', '0.14 bps', 'info'], ['보유 중 가격 변동', '$61.07', '0.16 bps', 'info'], ['긴급 청산 추가 비용', '$64.44', '0.17 bps', 'info'], ['펀딩비', '$0.00', '0.00 bps', 'ok'],
      ['왕복 비용 합계', '$776.64', '2.00 bps', 'warn'],
      ['리베이트', '−$170.18', null, 'ok'], ['미설명 잔차', '−$549.11', null, 'ok'], ['외부 조정', '$0.00', null, 'info'], ['정산 합계', '−$719.29', null, 'ok'],
      ['메이커 체결', '35.5%', '4,094 / 11,545', null], ['메이커 비중(추정)', '73.1%', null, null],
    ]);
    expect(g.rows.every((r) => r.desc && r.desc.length > 4)).toBe(true);
    expect(g.rows[0]!.desc).toBe('체결마다 실제로 낸 테이커·메이커 수수료');
    expect(g.rows[6]!.desc).toContain('음수 = 크레딧');
    expect(g.note).toContain('PnL = −비용');
    expect(g.note).toContain('서브 계정은 일일 합계만');
  });

  it('lanes and units: every account\'s lanes with a wrapping reason column, the MacBook launchd rows, no path leaks', async () => {
    const m = await collectOps(deps().deps);
    const lanes = section(m.page!.sections, /^레인 현황$/) as Extract<HubSection, { kind: 'table' }>;
    expect(lanes.columns).toEqual(['마켓', '프린터', '상태', '오늘 거래량', '오늘 비용', 'bps', '이유']);
    expect(lanes).toMatchObject({ num: [3, 4, 5], wrap: [6], note: '여러 프린터가 같이 도는 마켓: QQQ(메인·서브1·서브2·서브3)' });
    expect(lanes.rows).toHaveLength(3 + 3 + 2 + 3);
    expect(lanes.rows[0]).toEqual(['QQQ', '메인(서버)', '가동', '$30,000', '$6.00', '2.00', '—']);
    expect(lanes.rows[7]).toEqual(['XAU', '서브2(맥북)', '가동', '$100,000', '$15.00', '1.50', 'waiting: … says screen found no market']);
    const units = section(m.page!.sections, /^서비스\/유닛$/) as Extract<HubSection, { kind: 'table' }>;
    expect(units.columns).toEqual(['유닛', '호스트', '상태', '시작']);
    expect(units.rows).toEqual([
      ['risex-printer.service', '서버', '가동 (running)', '10-29 20:37 · 1일 1시간 전'], ['risex-printer@sub1.service', '서버', '가동 (running)', '10-29 20:17 · 1일 1시간 전'],
      ['com.standx.risex-printer-sub2', '맥북', '가동 · pid 72748', '10-29 16:35 · 1일 5시간 전'], ['com.standx.risex-printer-sub3', '맥북', '가동 · pid 78273', '10-29 16:39 · 1일 5시간 전'],
      ['standx-watch', '서버', '정지', '—'], ['standx-dashboard', '서버', '가동', '—'],
    ]);
    expect(units.note).toContain('맥북 up 3 days');
    expect(units.note).toContain('유닛 정지는 정상');
    expect(section(m.page!.sections, /원본 보기/)).toMatchObject({ kind: 'raw', href: '/hub/p/ops/', embed: true });
    expect(m.page!.sections.map((s) => s.kind)).toEqual(['cards', 'kvgrid', 'table', 'table', 'raw']);
    noHome(m);
  });

  it('MacBook unreachable (exec → null): sub2/sub3 are warn with "맥북 연결 끊김", never down; mirrored values stay', async () => {
    const { deps: d } = deps({ ssh: null });
    const m = await collectOps(d);
    expect(m.state).toBe('warn');
    const cs = cards(m.page!.sections);
    expect(cs.map((c) => [c.title, c.badge, c.state])).toEqual([['메인', '서버', 'ok'], ['서브1', '서버', 'ok'], ['서브2', '맥북', 'warn'], ['서브3', '맥북', 'warn']]);
    expect(cs[2]!.sub).toBe('맥북 연결 끊김 · 마지막 확인 0초 전 · 하트비트 40초 전');
    expect(cs[2]!.note).toBe('ssh 실패 — 미러 파일·상태 API 값으로 표시');
    expect(rowOf(cs[2]!, '오늘 거래량')).toBe('$200,000');
    expect(rowOf(cs[2]!, '평생 거래량')).toBe('$1.68M');
    expect(m.page!.headline).toBe('프린터 4대 가동(서버 2 · 맥북 2) · 오늘 거래량 $470,000 · 비용 $92.50 (2.0 bps)');
    expect(m.page!.kpis[3]).toMatchObject({ label: '가동 프린터', value: '4/4', status: 'ok' });
    expect(m.alerts[0]).toMatchObject({ level: 'warn', text: '맥북 연결 끊김 · 마지막 확인 0초 전' });
    expect(m.page!.decision).toMatch(/^맥북 연결 끊김 — ssh·전원 확인/);
    expect(m.metrics['맥북']).toBe('끊김');
    expect(m.sources.find((s) => s.name === '맥북 ssh')).toEqual({ name: '맥북 ssh', ok: false, ms: 0, error: '연결 실패' });
    const units = section(m.page!.sections, /^서비스\/유닛$/) as Extract<HubSection, { kind: 'table' }>;
    expect(units.rows[2]).toEqual(['com.standx.risex-printer-sub2', '맥북', '연결 끊김', '—']);
    expect(JSON.stringify(m)).not.toMatch(/"state":"down"/);
  });

  it('MacBook disconnected later keeps the last good probe (stale) and says how long ago it was checked', async () => {
    let ssh: string | null = SSH_BLOB;
    const { deps: d, clock } = deps();
    d.exec = async () => ssh;
    await collectOps(d);
    ssh = null;
    clock.now = NOW + 121_000; // ssh TTL 120 s is over → the probe runs again and fails
    const m = await collectOps(d);
    const c = cards(m.page!.sections)[2]!;
    expect(c.state).toBe('warn');
    expect(c.sub).toBe('맥북 연결 끊김 · 마지막 확인 2분 전 · 하트비트 2분 전');
    expect(m.sources.find((s) => s.name === '맥북 ssh')).toMatchObject({ ok: false, error: '연결 실패 · 이전 값 사용' });
  });

  it('caches the slow sources per deps: a second call within the TTL fetches neither the printer status nor ssh again', async () => {
    const { deps: d, calls, clock } = deps();
    await collectOps(d);
    expect(calls.fetch.filter((u) => u === HUB_URLS.printerStatus)).toHaveLength(1);
    expect(calls.exec).toHaveLength(1);
    expect(calls.exec[0]).toEqual(['ssh', ...MACBOOK_SSH_ARGS]);
    clock.now = NOW + 30_000;
    await collectOps(d);
    expect(calls.fetch.filter((u) => u === HUB_URLS.printerStatus)).toHaveLength(1);
    expect(calls.exec).toHaveLength(1);
    expect(calls.fetch.filter((u) => u === HUB_URLS.ops)).toHaveLength(2); // /api/ops is cheap: probed every time
    clock.now = NOW + 61_000;
    await collectOps(d);
    expect(calls.fetch.filter((u) => u === HUB_URLS.printerStatus)).toHaveLength(2);
    expect(calls.exec).toHaveLength(1); // ssh TTL is 120 s
    // Fresh deps ⇒ fresh cache.
    const other = deps();
    await collectOps(other.deps);
    expect(other.calls.fetch.filter((u) => u === HUB_URLS.printerStatus)).toHaveLength(1);
  });

  it('stalled daemon, over-ceiling lane and a dead server unit become alerts and the decision, worst first', async () => {
    const status = JSON.parse(JSON.stringify(STATUS)) as typeof STATUS;
    const rows = status.accounts.rows as Record<string, unknown>[];
    rows[0]!.daemon = 'unset'; rows[0]!.updated = sec(-1200);
    rows[1]!.daemon = 'stalled';
    rows[2]!.over_ceiling = true; rows[2]!.bps = 4.2;
    const files = { ...FILES, 'StandX_volume/reports/risex_printer_multi.json': multiJson(sec(-1200)) };
    const { deps: d } = deps({ status, files, units: { ...UNITS, 'risex-printer.service': UNIT_DEAD } });
    const m = await collectOps(d);
    expect(m.state).toBe('down');
    const cs = cards(m.page!.sections);
    expect(cs.map((c) => [c.title, c.state])).toEqual([['메인', 'down'], ['서브1', 'warn'], ['서브2', 'warn'], ['서브3', 'ok']]);
    expect(cs[0]!.sub).toBe('유닛 정지 (dead) · 하트비트 20분 전');
    expect(cs[1]!.sub).toBe('데몬 stalled · 하트비트 40초 전');
    expect(cs[2]!.note).toBe('비용 천장 초과 (4.2 bps > 3.5 bps) · launchd pid 72748');
    expect(m.page!.headline).toBe('프린터 2/4 가동(서버 0 · 맥북 2), 메인·서브1 정지 · 오늘 거래량 $470,000 · 비용 $92.50 (2.0 bps)');
    expect(m.page!.decision).toBe('메인 프린터 정지 — 즉시 확인');
    expect(m.page!.kpis[3]).toMatchObject({ label: '가동 프린터', value: '2/4', status: 'bad' });
    expect(m.alerts.slice(0, 3).map((a) => [a.level, a.text])).toEqual([['bad', '메인(서버) 정지 · 유닛 정지 (dead) · 하트비트 20분 전'], ['warn', '서브1(서버) 정지 · 데몬 stalled · 하트비트 40초 전'], ['warn', '서브2 비용 천장 초과 · 4.2 bps > 3.5 bps']]);
    expect(m.alerts[0]!.hint).toBe('risex-printer.service 확인');
    const lanes = section(m.page!.sections, /^레인 현황$/) as Extract<HubSection, { kind: 'table' }>;
    expect(lanes.rows.filter((r) => r[1] === '서브2(맥북)').map((r) => r[2])).toEqual(['가동', '가동']);
  });

  it('a stale heartbeat (> 10 min) with a live process is warn (not printing), an alert and the decision', async () => {
    const status = JSON.parse(JSON.stringify(STATUS)) as typeof STATUS;
    (status.accounts.rows[3] as Record<string, unknown>).updated = sec(-900);
    const files = { ...FILES, 'StandX_volume/profiles/sub3/reports/risex_printer_multi.json': multiJson(sec(-900)) };
    const m = await collectOps(deps({ status, files }).deps);
    const c = cards(m.page!.sections)[3]!;
    expect(c.state).toBe('warn'); // launchd pid is there, so not dead — but not printing either
    expect(c.sub).toBe('데몬 응답 없음 · 하트비트 15분 전');
    expect(m.state).toBe('warn');
    expect(m.alerts.find((a) => /서브3/.test(a.text))).toMatchObject({ level: 'warn', text: '서브3(맥북) 정지 · 데몬 응답 없음 · 하트비트 15분 전', hint: 'com.standx.risex-printer-sub3 (launchd) 확인' });
    expect(m.page!.decision).toBe('서브3 정지 — 의도된 것인지 확인');
  });

  it('printer status down: the cards come from the mirrored files (warn, not down), and the kvgrid still shows', async () => {
    const { deps: d } = deps({ status: new Error('fetch failed: ECONNREFUSED') });
    const m = await collectOps(d);
    expect(m.state).toBe('warn');
    expect(m.sources[0]).toEqual({ name: '프린터 상태', ok: false, ms: 0, error: '연결 실패' });
    expect(m.alerts[0]).toMatchObject({ level: 'warn', text: '프린터 상태 응답 없음 · 연결 실패 — 미러 파일 값 표시' });
    const cs = cards(m.page!.sections);
    expect(cs.map((c) => [c.title, c.badge, c.state])).toEqual([['메인', '서버', 'ok'], ['서브1', '서버', 'ok'], ['서브2', '맥북', 'ok'], ['서브3', '맥북', 'ok']]);
    expect(rowOf(cs[2]!, '오늘 거래량')).toBe('$200,000');
    expect(rowOf(cs[2]!, '오늘 비용')).toBe('$30.00 (1.5 bps)');
    expect(rowOf(cs[2]!, '사이클')).toBe('1회 (오늘)');
    expect(cs[2]!.note).toBe('launchd pid 72748 · 상태 API 없음 — 미러 파일 값');
    expect(m.page!.headline).toBe('프린터 4대 가동(서버 2 · 맥북 2) · 오늘 거래량 $470,000 · 비용 $92.50 (2.0 bps)');
    expect(section(m.page!.sections, /^비용 버킷/)).toBeDefined();
    expect(section(m.page!.sections, /^레인 현황$/)).toBeUndefined();
    noHome(m);
  });

  it('nothing at all (no API, no files, no /api/ops) is a down mode that still lists the systemd units', async () => {
    const m = await collectOps(deps({ status: new Error('fetch failed: ECONNREFUSED'), ops: new Error('fetch failed: ECONNREFUSED'), files: {} }).deps);
    expect(m.state).toBe('down');
    expect(m.page!.headline).toBe('프린터 상태 응답 없음 · 연결 실패');
    expect(m.page!.sections[0]).toMatchObject({ kind: 'table', title: '서비스/유닛' });
    expect((m.page!.sections[0] as Extract<HubSection, { kind: 'table' }>).rows.map((r) => r[0])).toEqual(['risex-printer.service', 'risex-printer@sub1.service', 'risex-printer@sub2.service', 'risex-printer@sub3.service']);
    expect(m.sources.find((s) => s.name === '미러 파일')).toMatchObject({ ok: false, error: '파일 없음' });
  });

  it('without exec the MacBook printers rely on the heartbeat and the source says so', async () => {
    const m = await collectOps(deps({ noExec: true }).deps);
    const cs = cards(m.page!.sections);
    expect(cs[2]).toMatchObject({ badge: '맥북', state: 'ok', sub: '데몬 시작 1시간 0분 전 · 하트비트 40초 전' });
    expect(m.sources.find((s) => s.name === '맥북 ssh')).toEqual({ name: '맥북 ssh', ok: false, ms: 0, error: '사용 불가' });
    expect(m.alerts.some((a) => /맥북 연결 끊김/.test(a.text))).toBe(false);
    expect(m.metrics['맥북']).toBeUndefined();
    expect(m.state).toBe('ok');
  });

  it('a dry-run fleet is tagged', async () => {
    const m = await collectOps(deps({ status: { ...STATUS, unit_is_live: false } }).deps);
    expect(m.tag).toBe('DRY RUN');
  });
});
