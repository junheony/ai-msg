import { describe, expect, it } from 'vitest';
import type { HubCardItem, HubSection } from '../../shared/hub-types';
import { collectQuant, fmtVal, fmtWon, parseFriends } from './quant';
import { HUB_URLS, type HubDeps } from './shared';

const NOW = Date.parse('2026-10-30T13:00:00Z'); // 10-30 22:00 KST → 어제 = 10-29, 7일 = 10-23~10-29
const HOME = '/Users/alice';
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

interface Fx { urls?: Partial<Record<keyof typeof HUB_URLS, unknown>>; files?: Record<string, string>; dirs?: Record<string, string[]>; mtimes?: Record<string, number>; units?: Record<string, Record<string, string>> }
interface Spy { reads: string[] }

/** Deps over an in-memory filesystem (paths relative to HOME), canned URLs and canned systemd units; `spy` counts reads. */
function deps(fx: Fx, spy: Spy = { reads: [] }): HubDeps {
  const byUrl = new Map<string, unknown>(Object.entries(HUB_URLS).map(([k, url]) => [url, fx.urls?.[k as keyof typeof HUB_URLS]]));
  const rel = (p: string): string => (p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p);
  return {
    fetchJson: async (url) => { const a = byUrl.get(url); if (a instanceof Error) throw a; if (a === undefined) throw new Error('fetch failed: ECONNREFUSED'); return a; },
    latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null,
    readText: async (f) => { spy.reads.push(rel(f)); return fx.files?.[rel(f)] ?? null; },
    readTail: async (f, max) => { const t = fx.files?.[rel(f)]; return t === undefined ? null : t.slice(-max); },
    listDir: async (d) => fx.dirs?.[rel(d)] ?? null,
    fileMtime: async (f) => fx.mtimes?.[rel(f)] ?? null,
    systemdShow: async (u) => fx.units?.[u] ?? (fx.units ? { LoadState: 'not-found', ActiveState: 'inactive' } : null),
    now: () => NOW, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
  };
}
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));
const cards = (secs: HubSection[], title: RegExp): HubCardItem[] => (section(secs, title) as { items: HubCardItem[] }).items;
const row = (c: HubCardItem, label: RegExp) => c.rows.find((r) => label.test(r.label));
const noHome = (v: unknown): void => { const j = JSON.stringify(v); expect(j).not.toContain(HOME); expect(j).not.toMatch(/\/home\/[a-z]/); expect(j).not.toContain('~/'); expect(j).not.toContain('_src'); };

/* ───────── fixtures ───────── */

const DAYS = ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const day = (net: number, top: [string, number][], extra: Record<string, unknown> = {}) => ({ turn: 2_000_000_000, real: net + 100_000, fee: 100_000, net, fills: 1_000, gross_bp: 5, fee_bp: 4, net_bp: (net / 2_000_000_000) * 1e4, mk_med: 1, ioc_med: -1, top, ...extra });
const equity = (totals: (number | null)[]) => DAYS.slice(2).map((d, i) => (totals[i] === null ? null : { d, krw: totals[i]! * 0.6, coin: totals[i]! * 0.4, otc: 0, total: totals[i] })).filter(Boolean);
const FRIENDS = {
  ok: true, ts: (NOW - 20 * 60_000) / 1000, fee_switch: '2026-09-06',
  accts: ['빗썸1', '빗썸2', '범수3', 'WILL'],
  equity: {
    '빗썸1': [{ d: '2026-03-13', krw: 1, coin: 1, otc: 1, total: 1_550_776_466 }, ...equity([2_000_000_000, 2_050_000_000, 2_100_000_000, 2_120_000_000, 2_146_118_587, 2_150_000_000])],
    '빗썸2': equity([1_800_000_000, 1_810_000_000, 1_820_000_000, 1_830_000_000, 1_864_222_154, 1_870_000_000]),
    '범수3': equity([1_800_000_000, 1_820_000_000, null, 1_850_000_000, 1_860_322_893, 1_865_000_000]), // 10-27 missing → null in the chart
    'WILL': equity([100_000_000, 100_000_000, 100_000_000, 100_000_000, 100_000_000, 100_000_000]),
  },
  daily: {
    '빗썸1': Object.fromEntries(DAYS.map((d, i) => [d, day(i === 0 ? 9_000_000 : 1_000_000, i === 6 ? [['BTC', 700_000], ['ETH', 300_000]] : [['BTC', 500_000], ['SOL', 200_000], ['XRP', 100_000]])])),
    '빗썸2': Object.fromEntries(DAYS.map((d) => [d, day(900_000, [['ETH', 400_000]])])),
    '범수3': Object.fromEntries(DAYS.map((d) => [d, day(d === '2026-10-29' ? -250_000 : 800_000, [['DOGE', -200_000]])])),
    'WILL': Object.fromEntries(DAYS.map((d) => [d, day(100_000, [['PEPE', 50_000]])])),
  },
  gauge: { '빗썸1': { turn: 17_808_629_690, net: 6_160_354, gross_bp: 7.46, fee_bp: 4, net_bp: 3.46, days: 7 }, '빗썸2': { turn: 15_578_386_086, net: 6_342_199, net_bp: 4.07, days: 7 }, '범수3': { turn: 16_909_109_197, net: 5_333_235, net_bp: 3.15, days: 7 }, 'WILL': { turn: 1_000_000_000, net: 700_000, net_bp: 7, days: 7 } },
  market: {}, now_px: {}, p0: { err: 'x' }, verdicts: [], findings: [], episodes: {},
};
const FRIENDS_FILE = '.local/state/friends_snapshot.json';
const INFRA = ['infra watch 2026-10-30 09:00 KST — 🟡 일부 지연', '[linux] ws(best) 🟢 lag 1초', '[aws] 빗썸1 🟢 수집 9초전 · 디스크 60%(잔여 20G) | 빗썸2 🔴 수집 3시간전 · 디스크 57%(잔여 21G) | 범수3 🟢 수집 12초전 · 디스크 49%(잔여 26G)', '[disk] linux 77% 사용'].join('\n');
const FILLS_SH = ['{"ts": 1791691200.1, "symbol": "ONDO", "side": "ask", "krw": 5500, "dry_run": true}', '{"ts": 1791691303.998, "observed_ms": 1791691303736, "symbol": "ONDO", "side": "ask", "krw": 5500, "dry_run": true}', ''].join('\n'); // last fill 2026-10-11 04:01:43Z = 13:01 KST

const tile = (label: string, value: unknown, fmt: string, extra: Record<string, unknown> = {}) => ({ label, value, fmt, src: { path: '/home/max/quant_analyzer/results/v9t/sg_24h.txt' }, ...extra });
const sgTiles = (id: string, fills: number, krw: number, touch: number) => ({ id: `sg_${id}`, title: `채점 24h · ${id}`, kind: 'tiles', asof: '2026-10-10T11:57:28+09:00', note: '10-09 11:52 ~ 11:52 KST', items: [tile('체결N', fills, 'int'), tile('체결대금', krw, 'krw', { unit: 'KRW' }), tile('crossed-at-fill', 22.2, 'pct'), tile('markout5s 중앙', 0, 'bp'), tile('가드취소 touch', touch, 'int'), tile('가드취소 approach', 0, 'int')] });
const liveTiles = (id: string, unit: string) => ({ id: `live_${id}`, title: `라이브 1h · ${id}`, kind: 'tiles', asof: iso(-300_000), note: `${unit}.service · 스냅샷 시각 기준 직전 1시간`, items: [tile('유닛', 'inactive', 'str', { status: 'bad' }), tile('체결 1h', 0, 'int'), tile('tel 마지막 기록', 1674061, 'int', { unit: 's 전', status: 'warn' })] });
const SNAPSHOT = {
  generated_at: iso(-300_000), errors: [],
  tabs: [
    { tab: 'sguard', title: '카피 엔진 S 가드', sections: [
      sgTiles('sh', 2524, 277_458_242, 0), sgTiles('a1', 1496, 190_179_455, 1461),
      { id: 'sg_table', title: '창 × 유닛 비교', kind: 'table', asof: '2026-10-10T11:57:28+09:00', columns: [{ key: 'win', label: '창', fmt: 'str' }, { key: 'unit', label: '유닛', fmt: 'str' }, { key: 'fills', label: '체결N', fmt: 'int' }, { key: 'krw', label: '체결대금', fmt: 'krw' }], rows: [{ win: '1h', unit: 'wf', fills: 53, krw: 2068042, _src: { path: '/home/max/quant_analyzer/results/v9t/sg_1h.txt' } }, { win: '24h', unit: 'sh', fills: 2524, krw: 277_458_242 }] },
      liveTiles('sh', 'v9flws-sh'), liveTiles('a1', 'v9flws-a1'),
      { id: 'summary', title: '요약', kind: 'text', asof: '2026-10-10T12:08:58+09:00', note: '/home/max/quant_analyzer/results/v9t/summary.txt 첫 줄부터', body: '요약' },
    ] },
    { tab: 'choi', title: '최O용 계정 · 선물 헷지', sections: [
      { id: 'hedge_tiles', title: '무헷지 vs 헷지 — 아카이브', kind: 'tiles', asof: '2026-10-09T11:50:00+09:00', note: '아카이브 분석', items: [tile('누적손익 헷지', 1_220_000_000, 'krw', { status: 'ok' }), tile('최대낙폭 무헷지', -1_248_000_000, 'krw', { status: 'bad' }), tile('펀딩 순', -328_000_000, 'krw', { status: 'bad' }), tile('P2 헷지', 826_000_000, 'krw', { status: 'warn' })] },
    ] },
    { tab: 're', title: '빗썸 RE 3계정 봇', sections: [
      { id: 'tiles_빗썸1', title: '빗썸1 — 7일(2026-07-07~07-13)', kind: 'tiles', asof: '2026-07-13T15:48:00+00:00', note: '라이브 아님(아카이브)', items: [tile('주문 수', 515346, 'int'), tile('메이커 회전 순익', -1.39, 'bp', { status: 'bad' })] },
      { id: 'audit_tiles', title: '최종 감사(07-14)', kind: 'tiles', asof: '2026-07-14T12:38:00+09:00', note: '라이브 아님(아카이브)', items: [tile('실자본 판정', 'NO-GO', 'str', { status: 'bad' })] },
    ] },
    { tab: 'misc', title: '기타', sections: [{ id: 'm', title: '미분류', kind: 'tiles', items: [tile('디스크', 97, 'pct', { status: 'warn' })] }] },
  ],
};
const UNITS: Record<string, Record<string, string>> = {
  'v9flws-sh': { Id: 'v9flws-sh.service', LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', Result: 'success', NRestarts: '0', Description: 'v9flws_sh paper = S stale 가드 A/B (config/v9flws_sh.json), ~/qa_v9flws' },
  'v9mk4-m3': { Id: 'v9mk4-m3.service', LoadState: 'loaded', ActiveState: 'active', SubState: 'running', Result: 'success', NRestarts: '0', ActiveEnterTimestamp: 'Wed 2026-10-21 18:40:59 UTC', Description: 'v9mk4 paper arm M3 (maker_v2 perp_pull 실험, ~/qa_v9mk4, config/v9mk4_M3.json)' },
  'v9pp-ex': { Id: 'v9pp-ex.service', LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', NRestarts: '0', ActiveEnterTimestamp: 'Tue 2026-10-13 16:40:15 UTC', InactiveEnterTimestamp: 'Wed 2026-10-14 15:43:32 UTC', ExecMainExitTimestamp: 'Wed 2026-10-14 15:43:32 UTC', Description: 'v9pp paper = pilot_v5k_ex config 24h trial (~/qa_v9pp, config/v9pp_ex.json)' },
};
const FULL: Fx = {
  urls: { quant: SNAPSHOT },
  files: { [FRIENDS_FILE]: JSON.stringify(FRIENDS), 'quant_analyzer/results/daily/infra_2026-10-30.txt': INFRA, 'quant_analyzer/results/daily/infra_2026-10-29.txt': 'infra watch 2026-10-29 09:00 KST — 🟢 전체 정상\n[aws] 빗썸1 🟢 수집 1초전', 'qa_v9flws/logs/v9flws_sh_fills.jsonl': FILLS_SH },
  dirs: { 'quant_analyzer/results/daily': ['infra_2026-10-29.txt', 'infra_2026-10-30.txt', 'other.txt'] },
  mtimes: { 'qa_v9flws/logs/v9flws_sh_fills.jsonl': Date.parse('2026-10-11T04:03:00Z') },
  units: UNITS,
};

/* ───────── tests ───────── */

describe('QUANT collector (work environment)', () => {
  it('builds the three account cards with rows, equity sparkline, 7-day top symbols and collector health', async () => {
    const m = await collectQuant(deps(FULL));
    expect(m).toMatchObject({ id: 'quant', state: 'warn', lastActivity: iso(-300_000), metrics: { '7일 순익': '+1,784만원', '어제': '+165만원', '유닛 가동': '1/4', '생성': '5분 전' } });
    expect(m.sources).toEqual([{ name: 'snapshot.json', ok: true, ms: 0 }, { name: 'friends_snapshot.json', ok: true, ms: 0 }]);
    expect(m.page!.headline).toBe('친구 계정 3 · 7일 순익 +1,784만원 (+3.55bp) · 자본(원가) 58.85억 · 라이브 페이퍼 유닛 2 정지(10-11) · v9pp-ex 실패');
    expect(m.page!.decision).toBe('정지된 v9flws A/B(sh·a1) 재개/폐기 결정 · v9pp-ex 실패 확인 · 수집 지연 계정(빗썸2) 확인 · 어제 적자 계정(범수3) 상위 심볼 확인');
    expect(m.page!.kpis.map((k) => [k.label, k.value, k.status])).toEqual([
      ['7일 순익 합', '+1,784만원', 'ok'], ['7일 평균 bp', '+3.55bp', 'ok'], ['어제 순익', '+165만원', 'ok'], ['총 자본 (원가)', '58.85억', 'info'],
      ['어제 체결 수', '3,000', undefined], ['페이퍼 유닛 가동', '1/4', 'bad'], ['스냅샷 신선도', '20분 전', 'ok'],
    ]);
    const secs = m.page!.sections;
    expect(secs.map((s) => s.kind)).toEqual(['cards', 'cards', 'chart', 'chart', 'table', 'table', 'list', 'kv', 'raw']);
    const acct = section(secs, /^계정/) as { kind: 'cards'; items: HubCardItem[]; cols: number; open: boolean; note: string };
    expect(acct).toMatchObject({ cols: 3, open: true, note: expect.stringContaining('7일 = 10-23~10-29') });
    expect(acct.items.map((c) => [c.title, c.badge, c.state])).toEqual([['빗썸1', '빗썸 현물', 'ok'], ['빗썸2', '빗썸 현물', 'warn'], ['범수동생계정3', '빗썸 현물', 'warn']]);
    const b1 = acct.items[0]!;
    expect(b1.sub).toBe('SEED 15.51억 → 21.5억 (+39%) · 원가 기준 · 03-13~10-30');
    expect(b1.rows).toEqual([
      { label: '7일 순익', value: '+616만원 (+3.46bp)', status: 'ok' },
      { label: '어제 순익 (10-29)', value: '+100만원 (+5bp)', status: 'ok' },
      { label: '어제 회전', value: '20억' },
      { label: '어제 체결', value: '1,000건' },
      { label: '어제 수수료', value: '100,000원' },
      { label: '상위 심볼 7일', value: 'BTC +370만원 · SOL +120만원 · XRP +60만원' }, // 10-23~10-29: BTC 6×50만 + 70만, SOL 6×20만, XRP 6×10만 (ETH 30만 ranks 4th)
      { label: '수집 상태', value: '🟢 수집 9초전 · 디스크 60%(잔여 20G)', status: 'ok' },
    ]);
    expect(b1.spark).toEqual({ values: [15.51, 20, 20.5, 21, 21.2, 21.46, 21.5], label: '자본(원가) 60일', unit: '억' });
    expect(b1.note).toContain('역공학');
    expect(row(acct.items[1]!, /수집 상태/)).toEqual({ label: '수집 상태', value: '🔴 수집 3시간전 · 디스크 57%(잔여 21G)', status: 'warn' });
    expect(row(acct.items[2]!, /어제 순익/)).toEqual({ label: '어제 순익 (10-29)', value: '-25만원 (-1.25bp)', status: 'bad' });
    expect(row(acct.items[2]!, /상위 심볼/)!.value).toBe('DOGE -140만원');
    // other accounts are a small table, never summed into the friends' figures
    expect(section(secs, /기타 계정/)).toMatchObject({ kind: 'table', rows: [['WILL', '10억', '+70만원', '+7bp', '+10만원']] });
    noHome(m);
  });

  it('aligns the equity chart on the union of dates (missing day → null, 억) and draws daily net as bars with a zero line', async () => {
    const secs = (await collectQuant(deps(FULL))).page!.sections;
    const eq = section(secs, /^자본 추이/) as { kind: 'chart'; x: string[]; series: { name: string; values: (number | null)[] }[]; unit: string; open: boolean; note: string };
    expect(eq.x).toEqual(['03-13', '10-25', '10-26', '10-27', '10-28', '10-29', '10-30']);
    expect(eq.series.map((s) => s.name)).toEqual(['빗썸1', '빗썸2', '범수동생계정3']);
    expect(eq.series[0]!.values).toEqual([15.51, 20, 20.5, 21, 21.2, 21.46, 21.5]);
    expect(eq.series[1]!.values).toEqual([null, 18, 18.1, 18.2, 18.3, 18.64, 18.7]);
    expect(eq.series[2]!.values).toEqual([null, 18, 18.2, null, 18.5, 18.6, 18.65]);
    expect(eq).toMatchObject({ unit: '억', open: true, note: expect.stringContaining('평균매수가') });
    const daily = section(secs, /^일별 순익/) as { kind: 'chart'; x: string[]; series: { name: string; values: (number | null)[]; style?: string }[]; zero?: boolean; note: string };
    expect(daily.x).toEqual(['10-23', '10-24', '10-25', '10-26', '10-27', '10-28', '10-29']); // today (10-30, partial) excluded
    expect(daily.zero).toBe(true);
    expect(daily.series.map((s) => s.style)).toEqual(['bar', 'bar', 'bar']);
    expect(daily.series[2]!.values).toEqual([800_000, 800_000, 800_000, 800_000, 800_000, 800_000, -250_000]);
  });

  it('groups the red tiles by reason with counts (stopped units / sign colouring / July archive / other) instead of listing them', async () => {
    const secs = (await collectQuant(deps(FULL))).page!.sections;
    const red = section(secs, /붉은 타일 — 이유별/) as { kind: 'list'; items: { text: string; level: string; hint?: string }[]; open: boolean; note: string };
    expect(red.items.map((i) => [i.level, i.text])).toEqual([
      ['info', '정지 유닛 4 — 라이브 1h 타일 (유닛 inactive · tel 기록 중단): sh·a1'],
      ['info', '분석 값 부호 3 — 최O용 헷지 분석 (손익·낙폭·펀딩·basis 의 음수/양수에 색)'],
      ['info', '7월 아카이브 판정 2 — 빗썸 RE 3계정 (메이커 회전 순익 음수 · 실자본 판정 NO-GO)'],
      ['warn', '기타 1 — 분류되지 않은 붉은 타일'],
    ]);
    expect(red.items[0]!.hint).toContain('10-11 13:01 에 의도적으로 정지');
    expect(red.items[1]!.hint).toBe('아카이브 분석 값 — 부호에 따라 색만 붙음, 장애 아님: 무헷지 vs 헷지: 최대낙폭 무헷지 = -12.48억, 펀딩 순 = -3.28억, P2 헷지 = 8.26억');
    expect(red.items[2]!.hint).toBe('2026-07 아카이브 판정, 라이브 아님: 빗썸1: 메이커 회전 순익 = -1.39 bp / 최종 감사(07-14): 실자본 판정 = NO-GO');
    expect(red.items[3]!.hint).toBe('미분류: 디스크 = 97%');
    expect(red.open).toBe(true); // only because an unexplained tile exists
    expect(red.note).toBe('qa_dash 붉은/노란 타일 10 (bad 6 · warn 4) — 전부 의도된 상태의 표시이며 장애 1');
    const withoutMisc = { ...SNAPSHOT, tabs: SNAPSHOT.tabs.filter((t) => t.tab !== 'misc') };
    const red2 = section((await collectQuant(deps({ ...FULL, urls: { quant: withoutMisc } }))).page!.sections, /붉은 타일/) as { items: unknown[]; open: boolean; note: string };
    expect(red2.items).toHaveLength(3);
    expect(red2).toMatchObject({ open: false, note: expect.stringContaining('장애 0') });
  });

  it('shows the paper units as cards: stopped (warn, time from the fills tail), running (ok), failed (down + bad alert), live-tile fallback', async () => {
    const m = await collectQuant(deps(FULL));
    const units = cards(m.page!.sections, /라이브 페이퍼 유닛/);
    expect(units.map((u) => [u.title, u.badge, u.state, u.sub])).toEqual([
      ['v9flws-sh', 'PAPER', 'warn', '정지 10-11 13:01 · 정상 종료'],
      ['v9flws-a1', 'PAPER', 'warn', '정지 시각 미상'], // not in systemd here → the live tile says inactive
      ['v9mk4-m3', 'PAPER', 'ok', '가동 10-22 03:40 부터'],
      ['v9pp-ex', 'PAPER', 'down', '실패 10-15 00:43 · 비정상 종료 (exit-code)'],
    ]);
    const sh = units[0]!;
    expect(sh.rows).toEqual([
      { label: '24h 체결 / 대금', value: '2,524 / 2.77억' }, { label: '24h markout5s 중앙', value: '0 bp' }, { label: '24h crossed-at-fill', value: '22.2%' }, { label: '24h 가드취소 touch/approach', value: '0 / 0' },
      { label: '마지막 체결', value: '10-11 13:01 · ONDO ask' }, { label: '역할', value: '섀도 — 가드 태그만 (취소 없음, 추정)' },
    ]);
    expect(sh.note).toContain('의도적 정지로 추정 — 기록 없음');
    expect(units[1]!.rows).toEqual(expect.arrayContaining([{ label: '24h 가드취소 touch/approach', value: '1,461 / 0' }, { label: '체결 1h', value: '0' }]));
    expect(units[2]!.rows).toEqual([{ label: '역할', value: 'v9mk4 paper arm M3 (maker_v2 perp_pull 실험, … config/v9mk4_M3.json)' }]);
    expect(units[3]!.note).toContain('로그 확인');
    expect(m.alerts).toEqual([
      { level: 'bad', text: 'v9pp-ex 실패 (exit-code) · 10-15 00:43', hint: '로그 확인 후 재시작/폐기 결정', at: '2026-10-14T15:43:32.000Z' },
      { level: 'warn', text: '계정 수집 지연: 빗썸2 🔴 수집 3시간전 · 디스크 57%(잔여 21G)', hint: 'infra watch 2026-10-30' },
      { level: 'info', text: '페이퍼 A/B 유닛 2개 정지 19일 (10-11 13:01) — 재개/폐기 미결', at: '2026-10-11T04:01:43.998Z' },
      { level: 'info', text: '범수동생계정3 어제 순익 -25만원', hint: '상위 심볼: DOGE -20만원' },
    ]);
    // the 24h A/B table and the raw proxy embed stay, collapsed, with paths blanked
    expect(section(m.page!.sections, /24h A\/B 스코어/)).toMatchObject({ kind: 'table', open: false, columns: ['창', '유닛', '체결N', '체결대금'], rows: [['1h', 'wf', '53', '2,068,042원'], ['24h', 'sh', '2,524', '2.77억']], num: [2, 3] });
    expect(m.page!.sections[m.page!.sections.length - 1]).toMatchObject({ kind: 'raw', href: '/hub/p/quant/', embed: true });
    expect(section(m.page!.sections, /신선도/)).toMatchObject({ kind: 'kv', rows: expect.arrayContaining([['friends_snapshot (30분 타이머)', '10-30 21:40 · 20분 전'], ['S 가드 24h 스코어', '10-10 11:57 · 20일 10시간 전'], ['infra watch (09:00 일보)', '2026-10-30 09:00 KST — 🟡 일부 지연'], ['전략 기록', '없음 — RE/IOC 메이커 회전은 역공학 추정 (핸드오프는 MacBook)']]) });
    noHome(m);
  });

  it('without the friends file the page degrades: a text section with a note, no charts, "—" KPIs, a warn alert; without both sources it is down', async () => {
    const m = await collectQuant(deps({ ...FULL, files: { 'quant_analyzer/results/daily/infra_2026-10-30.txt': INFRA } }));
    expect(m.state).toBe('warn');
    expect(m.alerts.map((a) => a.text)).toContain('friends_snapshot 없음 · 파일 없음 — 계정 카드·자본 차트 생략');
    expect(m.sources[1]).toEqual({ name: 'friends_snapshot.json', ok: false, ms: 0, error: '파일 없음' });
    const secs = m.page!.sections;
    expect(secs[0]).toMatchObject({ kind: 'text', title: '계정 (친구 3)', open: true, body: expect.stringContaining('friends_snapshot 이 없어'), note: '계정 카드 · 자본 추이 · 일별 순익 생략' });
    expect(secs.map((s) => s.kind)).toEqual(['text', 'cards', 'table', 'list', 'kv', 'raw']);
    expect(m.page!.kpis.slice(0, 5).map((k) => k.value)).toEqual(['—', '—', '—', '—', '—']);
    expect(m.page!.kpis[6]).toMatchObject({ label: '스냅샷 신선도', value: '—', status: 'bad' });
    expect(m.page!.headline).toBe('친구 계정 0 · 7일 순익 — · 라이브 페이퍼 유닛 2 정지(10-11) · v9pp-ex 실패');
    expect(m.page!.decision).toContain('friends_snapshot 타이머 확인');
    expect(m.metrics).toEqual({ '7일 순익': '—', '어제': '—', '유닛 가동': '1/4', '생성': '5분 전' });
    // qa_dash down but the friends file present: cards and charts still come, the units fall back to systemd only
    const m2 = await collectQuant(deps({ ...FULL, urls: {} }));
    expect(m2.state).toBe('warn');
    expect(m2.alerts.map((a) => a.text)).toContain('qa_dash 응답 없음 · 연결 실패');
    expect(m2.page!.sections.map((s) => s.kind)).toEqual(['cards', 'cards', 'chart', 'chart', 'table', 'list', 'kv', 'raw']);
    expect(cards(m2.page!.sections, /라이브 페이퍼 유닛/).map((u) => u.title)).toEqual(['v9flws-sh', 'v9mk4-m3', 'v9pp-ex']);
    expect(section(m2.page!.sections, /붉은 타일/)).toMatchObject({ items: [{ level: 'ok', text: 'qa_dash 응답 없음 — 타일 확인 불가' }] });
    // neither source: down
    const m3 = await collectQuant(deps({ units: UNITS }));
    expect(m3).toMatchObject({ state: 'down', sources: [{ name: 'snapshot.json', ok: false }, { name: 'friends_snapshot.json', ok: false }] });
    noHome(m);
    noHome(m2);
  });

  it('flags a stale friends snapshot and an old infra report; a broken friends file is reported, not thrown', async () => {
    const stale = { ...FRIENDS, ts: (NOW - 3 * 3_600_000) / 1000 };
    const m = await collectQuant(deps({ ...FULL, files: { ...FULL.files, [FRIENDS_FILE]: JSON.stringify(stale), 'quant_analyzer/results/daily/infra_2026-10-27.txt': INFRA }, dirs: { 'quant_analyzer/results/daily': ['infra_2026-10-27.txt'] } }));
    expect(m.alerts.map((a) => a.text)).not.toContain('계정 수집 지연');
    expect(m.alerts.map((a) => a.text)).toEqual(expect.arrayContaining(['friends_snapshot 3시간 0분 전 — 30분 타이머 지연', 'infra watch 보고 2026-10-27 이후 없음 — 수집 상태 미상']));
    expect(m.page!.kpis[6]).toMatchObject({ value: '3시간 0분 전', status: 'warn' });
    expect(row(cards(m.page!.sections, /^계정/)[0]!, /수집 상태/)).toEqual({ label: '수집 상태', value: '🟢 수집 9초전 · 디스크 60%(잔여 20G) (10-27 보고)', status: 'warn' });
    const noInfra = await collectQuant(deps({ ...FULL, dirs: {} }));
    expect(row(cards(noInfra.page!.sections, /^계정/)[0]!, /수집 상태/)).toEqual({ label: '수집 상태', value: '보고 없음', status: 'info' });
    const broken = await collectQuant(deps({ ...FULL, files: { ...FULL.files, [FRIENDS_FILE]: '{not json' } }));
    expect(broken.state).toBe('warn');
    expect(broken.sources[1]).toMatchObject({ name: 'friends_snapshot.json', ok: false, error: '응답 형식 오류' });
    expect(broken.page!.sections[0]!.kind).toBe('text');
  });

  it('reads the friends file once per deps within the slow cache window and never leaks the home path', async () => {
    const spy: Spy = { reads: [] };
    const d = deps(FULL, spy);
    const a = await collectQuant(d);
    const b = await collectQuant(d);
    expect(spy.reads.filter((f) => f === FRIENDS_FILE)).toHaveLength(1);
    expect(b.page!.headline).toBe(a.page!.headline);
    const spy2: Spy = { reads: [] };
    await collectQuant(deps(FULL, spy2)); // a different deps object → its own cache
    expect(spy2.reads.filter((f) => f === FRIENDS_FILE)).toHaveLength(1);
    noHome(a);
  });

  it('parseFriends is defensive and fmtVal/fmtWon format as documented', () => {
    expect(parseFriends(null)).toBeNull();
    expect(parseFriends([])).toBeNull();
    expect(parseFriends({})).toEqual({ ts: null, ok: true, accts: [] });
    const f = parseFriends({ ok: false, ts: 'nope', accts: ['x', 7], equity: { x: [{ d: '2026-01-02', total: 2 }, { d: 'bad', total: 1 }, { d: '2026-01-01', total: 'z' }, { d: '2026-01-01', total: 1 }] }, daily: { x: { '2026-01-01': { net: 1, top: [['A', 1], ['B', 'q'], 'junk'] }, junk: {} } }, gauge: { x: 'no' } })!;
    expect(f.ok).toBe(false);
    expect(f.ts).toBeNull();
    expect(f.accts).toEqual([{ name: 'x', equity: [{ d: '2026-01-01', total: 1 }, { d: '2026-01-02', total: 2 }], daily: [{ d: '2026-01-01', turn: null, fee: null, net: 1, fills: null, netBp: null, top: [['A', 1]] }], gauge: null }]);
    expect(fmtVal(8377335079, 'krw')).toBe('83.77억');
    expect(fmtVal(-1.39, 'bp')).toBe('-1.39 bp');
    expect(fmtVal(null, 'bp')).toBe('—');
    expect(fmtVal('NO-GO', 'str')).toBe('NO-GO');
    expect(fmtWon(17_836_000)).toBe('+1,784만원');
    expect(fmtWon(-244_492)).toBe('-24만원');
    expect(fmtWon(215_000_000)).toBe('+2.15억');
    expect(fmtWon(900)).toBe('+900원');
  });
});
