import { describe, expect, it } from 'vitest';
import type { HubSection } from '../../shared/hub-types';
import { collectOps } from './ops';
import { collectQuant, fmtVal } from './quant';
import { HUB_URLS, fmtKst, parseSystemdTime, scrub, unitInfo, type HubDeps } from './shared';
import { collectGame, collectVideo, parseBacklogNow, parseProjectYaml } from './studios';
import { collectYapping, scanLogs } from './yapping';

const NOW = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST
const HOME = '/Users/alice';
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

interface Fx { urls?: Partial<Record<keyof typeof HUB_URLS, unknown>>; files?: Record<string, string>; dirs?: Record<string, string[]>; mtimes?: Record<string, number>; units?: Record<string, Record<string, string>>; render?: { mtimeMs: number; name: string } | null }

/** Deps over an in-memory filesystem (paths relative to HOME), canned URLs and canned systemd units. */
function deps(fx: Fx): HubDeps {
  const byUrl = new Map<string, unknown>(Object.entries(HUB_URLS).map(([k, url]) => [url, fx.urls?.[k as keyof typeof HUB_URLS]]));
  const rel = (p: string): string => p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p;
  return {
    fetchJson: async (url) => { const a = byUrl.get(url); if (a instanceof Error) throw a; if (a === undefined) throw new Error('fetch failed: ECONNREFUSED'); return a; },
    latestRender: async () => fx.render ?? null,
    countEntries: async (d) => fx.dirs?.[rel(d)]?.length ?? null,
    gitLastCommit: async () => null,
    readText: async (f) => fx.files?.[rel(f)] ?? null,
    readTail: async (f) => fx.files?.[rel(f)] ?? null,
    listDir: async (d) => fx.dirs?.[rel(d)] ?? null,
    fileMtime: async (f) => fx.mtimes?.[rel(f)] ?? null,
    systemdShow: async (u) => fx.units?.[u] ?? (fx.units ? { LoadState: 'not-found', ActiveState: 'inactive' } : null),
    now: () => NOW, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
  };
}
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));
const noHome = (v: unknown): void => { expect(JSON.stringify(v)).not.toContain(HOME); expect(JSON.stringify(v)).not.toMatch(/\/home\/[a-z]/); };

/* ───────── shared ───────── */

describe('shared helpers', () => {
  it('parses systemd timestamps in UTC and KST and formats Seoul clock times', () => {
    expect(parseSystemdTime('Fri 2026-10-30 12:49:15 UTC')).toBe('2026-10-30T12:49:15.000Z');
    expect(parseSystemdTime('Fri 2026-10-30 22:05:14 KST')).toBe('2026-10-30T13:05:14.000Z');
    expect(parseSystemdTime('')).toBeNull();
    expect(parseSystemdTime('n/a')).toBeNull();
    expect(fmtKst('2026-10-30T12:49:15Z')).toBe('10-30 21:49');
    expect(fmtKst(null)).toBe('—');
  });
  it('unitInfo reads state, restarts, since and the next timer run (falling back to TimersCalendar)', () => {
    const u = unitInfo('x.timer', { LoadState: 'loaded', ActiveState: 'active', SubState: 'running', NRestarts: '2', ActiveEnterTimestamp: 'Fri 2026-10-30 12:49:15 UTC', NextElapseUSecRealtime: '', TimersCalendar: '{ OnCalendar=*-*-* *:05,35:00 ; next_elapse=Fri 2026-10-30 13:05:00 UTC }', LastTriggerUSec: 'Fri 2026-10-30 21:35:14 KST', Result: 'success' });
    expect(u).toMatchObject({ active: 'active', restarts: 2, since: '2026-10-30T12:49:15.000Z', nextRun: '2026-10-30T13:05:00.000Z', lastRun: '2026-10-30T12:35:14.000Z', result: 'success' });
    expect(unitInfo('nope.service', { LoadState: 'not-found', ActiveState: 'inactive' }).active).toBe('missing');
    expect(unitInfo('nope.service', null).active).toBe('missing');
    expect(unitInfo('f.service', { ActiveState: 'failed', SubState: 'failed' }).active).toBe('failed');
  });
  it('scrub blanks home paths and bounds length', () => {
    expect(scrub('see /home/max/quant/results/x.txt and /Users/alice/y.md now')).toBe('see … and … now');
    expect(scrub('a'.repeat(300), 10)).toHaveLength(10);
    expect(scrub(42)).toBe('');
  });
});

/* ───────── studios ───────── */

const QA_REPORT = JSON.stringify({ schema_version: 1, episode_id: 'sprinkler', reviewed_at: '2026-09-01T15:10:47+09:00', stage: 'silent_visual_draft', gates: { factual_gate: { status: 'pass' }, copyright_gate: { status: 'pass' }, synthetic_media_gate: { status: 'pass_for_draft' }, audio_gate: { status: 'blocked', evidence: 'TYPECAST_API_KEY not configured' }, human_publish_approval: false }, blocking_next_actions: ['Create or supply a local Typecast API key and select a Voice ID', 'Second'] });
const DRAFT_QA = JSON.stringify({ width: 1080, height: 1920, duration_s: 90.048, fps: 30, technical_video_pass: true, black_frame_heuristic: { event_count: 0 }, frozen_frame_heuristic: { event_count: 1, total_duration_s: 2.6 }, has_audible_audio: false, audio_gate: 'blocked_typecast_voice_pending', publish_gate: 'blocked_human_approval_required', qa_pass: true });
const PROJECT_YAML = 'project:\n  name: "공학쇼츠 자동화"\n  status: pilot_storyboard\npublication:\n  auto_publish: false\n  human_approval_required: true\n';
const BACKLOG = '# Backlog\n\n## Now\n- [x] 파이프라인 골격\n- [x] 첫 렌더\n- [ ] Typecast API 키·Voice ID 연결 후 실제 한국어 내레이션 생성\n- [ ] JSON Schema 작성\n\n## Next\n- [ ] 다른 것\n';

describe('영상 스튜디오 collector', () => {
  const fx: Fx = {
    files: { 'engineering-shorts/project.yaml': PROJECT_YAML, 'engineering-shorts/backlog.md': BACKLOG, 'engineering-shorts/episodes/sprinkler/qa_report.json': QA_REPORT, 'engineering-shorts/renders/draft.qa.json': DRAFT_QA },
    dirs: { 'engineering-shorts/episodes': ['sprinkler'], 'engineering-shorts/renders': ['contact-sheet.png', 'draft.mp4', 'draft.qa.json', 'poster.png'] },
    mtimes: { 'engineering-shorts/backlog.md': NOW - 2 * 3_600_000 }, render: { mtimeMs: NOW - 5 * 3_600_000, name: 'draft.mp4' },
  };
  it('parses the backlog Now block and project.yaml', () => {
    expect(parseBacklogNow(BACKLOG)).toMatchObject({ checked: 2, total: 4 });
    expect(parseBacklogNow(BACKLOG).items[2]).toEqual({ text: 'Typecast API 키·Voice ID 연결 후 실제 한국어 내레이션 생성', done: false });
    expect(parseBacklogNow(null)).toEqual({ checked: 0, total: 0, items: [] });
    expect(parseProjectYaml(PROJECT_YAML)).toEqual({ status: 'pilot_storyboard', name: '공학쇼츠 자동화', autoPublish: false, approval: true });
  });
  it('answers stage, gates, the next blocker and render QA; a blocked gate makes it warn', async () => {
    const m = await collectVideo(deps(fx));
    expect(m).toMatchObject({ id: 'video', state: 'warn', metrics: { '에피소드': 1, '단계': 'pilot_storyboard', '파일': 'draft.mp4' } });
    expect(m.page!.headline).toBe("pilot_storyboard · 에피소드 1개 · 최근 'sprinkler' silent_visual_draft · 게이트 3/4");
    expect(m.page!.decision).toBe('다음 블로커: Create or supply a local Typecast API key and select a Voice ID');
    expect(m.page!.kpis.map((k) => [k.label, k.value])).toEqual([['진행 단계', 'pilot_storyboard'], ['에피소드', '1'], ['Now 체크', '2/4'], ['최근 렌더', '5시간 0분 전'], ['렌더 길이', '90s'], ['자동 게시', '끔']]);
    expect(m.alerts).toEqual(expect.arrayContaining([{ level: 'warn', text: 'sprinkler · audio_gate 차단 (blocked)' }, { level: 'info', text: 'sprinkler · synthetic_media_gate pass_for_draft' }, { level: 'info', text: '렌더 정지 프레임 1회 · 2.6s' }]));
    expect(m.alerts[0]!.level).toBe('warn');
    const eps = section(m.page!.sections, /^에피소드$/);
    expect(eps).toMatchObject({ kind: 'table', open: true });
    expect((eps as { rows: string[][] }).rows[0]!.slice(0, 2)).toEqual(['sprinkler', 'silent_visual_draft']);
    expect(section(m.page!.sections, /블로커/)).toMatchObject({ kind: 'list', open: true });
    expect(section(m.page!.sections, /렌더 QA/)).toMatchObject({ kind: 'kv', rows: expect.arrayContaining([['길이', '90s'], ['오디오', '없음']]) });
    noHome(m);
  });
  it('falls back to the next unchecked backlog item without a QA report, and is idle after 7 quiet days', async () => {
    const m = await collectVideo(deps({ files: { 'engineering-shorts/backlog.md': BACKLOG }, mtimes: { 'engineering-shorts/backlog.md': NOW - 9 * 86_400_000 } }));
    expect(m.state).toBe('idle');
    expect(m.page!.decision).toBe('다음 블로커: Typecast API 키·Voice ID 연결 후 실제 한국어 내레이션 생성');
  });
  it('is unknown with a "폴더 없음" source when nothing is readable', async () => {
    const m = await collectVideo(deps({}));
    expect(m).toMatchObject({ state: 'unknown', sources: [{ ok: false, error: '폴더 없음' }] });
    expect(m.page!.headline).toBe('프로젝트 폴더 없음');
  });
});

const MANIFEST = JSON.stringify({ verified_at: '2026-09-08T16:25:48+09:00', files: { 'src/core.js': 'aaaaaaaaaaaaaaaa', 'src/main.js': 'bbbbbbbbbbbbbbbb', 'dist/NEON-APEX.html': 'cccccccccccccccc' } });
const DEPLOYMENT = '# Deployment\n- Verified at: 2026-09-08T16:25:48.276118+09:00\n- Public URL: https://neon-apex-pi.vercel.app\n- 34 Node unit/geometry tests: PASS.\n';
const VERIFIED = Date.parse('2026-09-08T16:25:48+09:00');

describe('게임 스튜디오 collector', () => {
  const base: Fx = { files: { 'games/neon-apex/package.json': '{"name":"neon-apex","version":"3.0.0"}', 'games/neon-apex/DEPLOYMENT.md': DEPLOYMENT, 'games/neon-apex/tests/v3-release-manifest.json': MANIFEST } };
  it('reads version, verification, tests and the deploy URL; unchanged sources mean no re-verification', async () => {
    const m = await collectGame(deps({ ...base, mtimes: { 'games/neon-apex/DEPLOYMENT.md': VERIFIED, 'games/neon-apex/src/core.js': VERIFIED - 60_000, 'games/neon-apex/src/main.js': VERIFIED - 60_000, 'games/neon-apex/dist/NEON-APEX.html': VERIFIED - 1000 } }));
    expect(m).toMatchObject({ id: 'game', state: 'idle', metrics: { '버전': 'v3.0.0', '배포': 'Vercel', '배포 검증': '2026-09-08' }, links: [{ label: 'Vercel', href: 'https://neon-apex-pi.vercel.app' }] });
    expect(m.page!.headline).toBe('v3.0.0 배포됨 · 검증 2026-09-08 · 테스트 34 PASS');
    expect(m.page!.decision).toBe('소스 변경 없음 — 재검증 불필요');
    expect(m.page!.kpis.find((k) => k.label === '검증 후 변경')).toMatchObject({ value: '0', status: 'ok' });
    expect(section(m.page!.sections, /매니페스트/)).toMatchObject({ kind: 'table', rows: [['src/core.js', 'aaaaaaaaaaaa', '아니오'], ['src/main.js', 'bbbbbbbbbbbb', '아니오'], ['dist/NEON-APEX.html', 'cccccccccccc', '아니오']] });
    expect(section(m.page!.sections, /배포 사이트/)).toMatchObject({ kind: 'raw', href: 'https://neon-apex-pi.vercel.app' });
    noHome(m);
  });
  it('flags sources edited after the verification and asks for re-verification', async () => {
    const m = await collectGame(deps({ ...base, mtimes: { 'games/neon-apex/src/core.js': NOW - 3_600_000, 'games/neon-apex/src/main.js': VERIFIED - 60_000 } }));
    expect(m.state).toBe('warn');
    expect(m.page!.decision).toBe('검증 후 소스 1개 변경 — 재검증 필요');
    expect(section(m.page!.sections, /변경 파일/)).toMatchObject({ kind: 'list', open: true, items: [{ text: 'src/core.js', level: 'warn' }] });
    expect(m.alerts[0]).toMatchObject({ level: 'warn', text: '검증 후 소스 1개 변경 — 재검증 필요' });
  });
});

/* ───────── ops ───────── */

const OPS_HEALTH = { ok: true, ts: Math.floor(NOW / 1000) - 30, vault_unlocked: false, mode: 'personal' };
const OPS = {
  generated_at: iso(-120_000), services: { 'risex-printer': 'active', 'standx-watch': 'inactive', 'standx-dashboard': 'active' },
  risex: { day: { volume: 250_000, cost: 12.5, cycles: 40, bps: 0.5 }, cost: { days: 7, maker_fill_rate: 0.42, buckets: { actual_fee: { usd: 30, bps: 1.2 }, spread_slippage: { usd: 55.5, bps: 2.2 }, funding: { usd: -4, bps: -0.2 } } } },
  measurements: { eligibility: [{ symbol: 'BTC', samples: 120, bid_ok: 110, ask_ok: 100, both: 95, minutes_per_hour: 47.5, errors: 0 }] },
};
const UNIT_UP = (since: string): Record<string, string> => ({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running', NRestarts: '0', ActiveEnterTimestamp: since, Result: 'success' });
const UNIT_DEAD: Record<string, string> = { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', NRestarts: '0', ActiveEnterTimestamp: '', InactiveEnterTimestamp: 'Thu 2026-10-29 10:00:00 UTC', Result: 'success' };

describe('OPS collector', () => {
  const units = { 'risex-printer.service': UNIT_UP('Thu 2026-10-29 11:37:56 UTC'), 'risex-printer@sub1.service': UNIT_UP('Thu 2026-10-29 11:17:21 UTC'), 'risex-printer@sub2.service': UNIT_DEAD, 'risex-printer@sub3.service': UNIT_DEAD };
  it('reads the printer fleet from systemd: stopped subs make it warn and ask whether that is intended', async () => {
    const m = await collectOps(deps({ urls: { opsHealth: OPS_HEALTH, ops: OPS }, units }));
    expect(m).toMatchObject({ id: 'ops', state: 'warn', tag: 'PERSONAL', metrics: { '프린터': '2/4', '서비스': '2/3', '오늘 거래량': '$250,000' } });
    expect(m.page!.headline).toBe('프린터 main·sub1 가동, sub2·sub3 정지 · 오늘 거래량 $250,000 · 비용 $12.50 (0.5 bps)');
    expect(m.page!.decision).toBe('sub2·sub3 정지 상태 — 의도된 것인지 확인');
    expect(m.page!.kpis.map((k) => [k.label, k.value])).toEqual([['가동 프린터', '2/4'], ['오늘 거래량', '$250,000'], ['오늘 비용', '$12.50'], ['비용 bps', '0.5'], ['메이커 체결률', '42%'], ['사이클', '40']]);
    expect(m.alerts.filter((a) => a.level === 'warn').map((a) => a.text)).toEqual(['프린터 sub2 정지 (dead) · 1일 3시간 전', '프린터 sub3 정지 (dead) · 1일 3시간 전']);
    expect(m.alerts).toEqual(expect.arrayContaining([{ level: 'info', text: 'standx-watch inactive' }, { level: 'info', text: '7일 최대 비용 버킷: 스프레드·슬리피지 $55.50 · 2.2 bps' }, { level: 'info', text: '볼트 잠김' }]));
    const printers = section(m.page!.sections, /^프린터$/) as { rows: string[][]; open: boolean };
    expect(printers.open).toBe(true);
    expect(printers.rows.map((r) => r.slice(0, 2))).toEqual([['main', '가동 (running)'], ['sub1', '가동 (running)'], ['sub2', '정지 (dead)'], ['sub3', '정지 (dead)']]);
    expect(section(m.page!.sections, /비용 버킷/)).toMatchObject({ kind: 'bars', items: expect.arrayContaining([{ label: '펀딩', value: 4, text: '$-4.00 · -0.2 bps' }]) });
    expect(section(m.page!.sections, /유동성/)).toMatchObject({ kind: 'table', rows: [['BTC', '120', '110', '100', '95', '47.5', '0']] });
    expect(section(m.page!.sections, /원본 보기/)).toMatchObject({ kind: 'raw', href: '/hub/p/ops/', embed: true });
    expect(m.sources.map((s) => s.name)).toEqual(['/api/health', '/api/ops', 'systemd']);
    expect(JSON.stringify(m)).not.toMatch(/vault/i);
  });
  it('a stopped main printer is down; no systemd at all keeps the dashboard-only view', async () => {
    const m = await collectOps(deps({ urls: { opsHealth: OPS_HEALTH, ops: OPS }, units: { ...units, 'risex-printer.service': UNIT_DEAD } }));
    expect(m.state).toBe('down');
    expect(m.page!.decision).toBe('main 프린터 정지 — 즉시 확인');
    expect(m.alerts[0]).toMatchObject({ level: 'bad', text: expect.stringContaining('프린터 main 정지') });
    const m2 = await collectOps(deps({ urls: { opsHealth: OPS_HEALTH, ops: OPS } }));
    expect(m2.state).toBe('ok');
    expect(m2.page!.headline).toBe('대시보드 정상 · 오늘 거래량 $250,000 · 비용 $12.50 · 서비스 2/3');
    expect(m2.page!.kpis[0]).toMatchObject({ label: '가동 프린터', value: '—' });
  });
  it('with both endpoints dead the fleet still shows from systemd', async () => {
    const m = await collectOps(deps({ urls: { opsHealth: new Error('ECONNREFUSED'), ops: new Error('ECONNREFUSED') }, units }));
    expect(m.state).toBe('down');
    expect(m.page!.headline).toBe('대시보드 응답 없음 · 프린터 main·sub1 가동');
    expect(m.page!.sections[0]).toMatchObject({ title: '프린터', kind: 'table' });
  });
});

/* ───────── quant ───────── */

const tile = (label: string, value: unknown, fmt: string, extra: Record<string, unknown> = {}) => ({ label, value, fmt, ...extra });
const acctTiles = (acct: string, ioc: number, filled: number, maker: number, orders: number) => ({ id: `tiles_${acct}`, title: `${acct} — 7일`, kind: 'tiles', asof: '2026-07-13T15:48:00+00:00', note: '라이브 아님(아카이브)', items: [tile('주문 수', orders, 'int', { unit: '건' }), tile('취소율(무체결+부분체결 후 취소)', 93.04, 'pct'), tile('체결 발생 주문 비율', filled, 'pct'), tile('IOC 비중(TIF 라벨 있는 주문)', ioc, 'pct', { note: 'TIF unknown 29.6%' }), tile('거래 심볼 수', 40, 'int'), tile('메이커 회전 순익', maker, 'bp', { status: 'bad', note: 'N=6일 — 결론없음' })] });
const SNAPSHOT = {
  generated_at: iso(-600_000), errors: [],
  tabs: [
    { tab: 'sguard', title: '카피 엔진 S 가드', sections: [
      { id: 'sg_sh', title: '채점 24h · sh', kind: 'tiles', asof: '2026-10-10T11:57:28+09:00', note: '10-09 11:52 ~ 11:52 KST', items: [tile('체결N', 2524, 'int'), tile('crossed-at-fill', 22.2, 'pct'), tile('markout5s 중앙', 0, 'bp'), tile('가드취소 touch', 0, 'int'), tile('가드취소 approach', 0, 'int')] },
      { id: 'sg_a1', title: '채점 24h · a1', kind: 'tiles', asof: '2026-10-10T11:57:28+09:00', note: '', items: [tile('체결N', 1496, 'int'), tile('crossed-at-fill', 3.7, 'pct'), tile('markout5s 중앙', 0, 'bp'), tile('가드취소 touch', 1461, 'int'), tile('가드취소 approach', 977, 'int')] },
      { id: 'sg_savings', title: '회피 가능 절감 추정 · 24h', kind: 'tiles', asof: '2026-10-10T11:57:28+09:00', items: [tile('절감 추정 지연 150ms', -34878, 'krw'), tile('절감 추정 지연 300ms', -33900, 'krw')] },
      { id: 'sg_table', title: '창 × 유닛 비교', kind: 'table', asof: '2026-10-10T11:57:28+09:00', columns: [{ key: 'win', label: '창', fmt: 'str' }, { key: 'unit', label: '유닛', fmt: 'str' }, { key: 'fills', label: '체결N', fmt: 'int' }, { key: 'krw', label: '체결대금', fmt: 'krw' }], rows: [{ win: '1h', unit: 'wf', fills: 53, krw: 2068042, _src: { path: '/home/max/quant_analyzer/results/v9t/sg_1h.txt' } }] },
      { id: 'sg_bars', title: '유닛별 체결대금 · 24h', kind: 'bars', asof: '2026-10-10T11:57:28+09:00', x: ['sh', 'a1'], unit: 'KRW', series: [{ name: '체결대금', values: [277458242, 190179455] }], src: { path: '/home/max/x' } },
      { id: 'live_sh', title: '라이브 1h · sh', kind: 'tiles', asof: iso(-600_000), note: 'v9flws-sh.service · 스냅샷 시각 기준 직전 1시간', items: [tile('유닛', 'inactive', 'str', { status: 'bad' }), tile('체결 1h', 0, 'int'), tile('tel 마지막 기록', 1674061, 'int', { unit: 's 전', status: 'warn' })] },
      { id: 'summary', title: '요약', kind: 'text', asof: '2026-10-10T12:08:58+09:00', note: '/home/max/quant_analyzer/results/v9t/summary.txt 첫 줄부터', body: '1009ws_24h 요약' },
    ] },
    { tab: 'choi', title: '최O용 계정 · 선물 헷지', sections: [
      { id: 'hedge_tiles', title: '무헷지 vs 헷지', kind: 'tiles', asof: '2026-10-09T11:50:00+09:00', note: '아카이브 분석', items: [tile('누적손익 무헷지', 1085000000, 'krw'), tile('누적손익 헷지', 1220000000, 'krw', { status: 'ok' }), tile('최대낙폭 무헷지', -1248000000, 'krw', { status: 'bad' }), tile('펀딩 순', -328000000, 'krw', { status: 'bad' }), tile('일손익 표준편차 헷지', 42610000, 'krw')] },
      { id: 'monthly_pnl', title: '월별 손익 hedged vs unhedged', kind: 'bars', asof: '2026-10-09T11:50:00+09:00', note: '01·02월은 거래대금 100억 미만', x: ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'], series: [{ name: 'hedged', values: [0.92, 2, 3.44, 1.73, -1.34, 0.69, 0.1] }, { name: 'unhedged', values: [0.63, 0.82, 13.81, 2.94, -1.28, 0.28, 0.2] }], unit: '억', src: { path: '/Users/max/Documents/x.md' } },
      { id: 'wind_down_turnover', title: '월별 거래대금', kind: 'line', asof: '2026-10-07T21:00:00+09:00', x: ['2026-06', '2026-07'], series: [{ name: '거래대금', values: [100, 83] }], unit: '억' },
    ] },
    { tab: 're', title: '빗썸 RE 3계정 봇', sections: [
      acctTiles('빗썸1', 7.03, 8.45, -1.39, 515346), acctTiles('빗썸2', 6.18, 6.22, -0.12, 965056), acctTiles('범수동생계정3', 9.22, 11.11, -6.74, 513699),
      { id: 'acct_metrics', title: '계정×지표(7일, 계정별 따로)', kind: 'table', asof: '2026-07-13T15:48:00+00:00', note: '라이브 아님(아카이브)', columns: [{ key: 'acct', label: '계정', fmt: 'str' }, { key: 'orders', label: '주문', fmt: 'int' }, { key: 'cancel', label: '취소%', fmt: 'pct' }, { key: 'ioc', label: 'IOC%', fmt: 'pct' }, { key: 'symbols', label: '심볼', fmt: 'int' }, { key: 'maker_bp', label: '메이커bp', fmt: 'bp' }],
        rows: [{ acct: '빗썸1', orders: 515346, cancel: 93.04, ioc: 7.03, symbols: 40, maker_bp: -1.39, _src: { path: '/home/max/quant_analyzer/results/re.csv' } }, { acct: '빗썸2', orders: 965056, cancel: 94.79, ioc: 6.18, symbols: 42, maker_bp: -0.12 }, { acct: '범수동생계정3', orders: 513699, cancel: 90.63, ioc: 9.22, symbols: 40, maker_bp: -6.74 }] },
      { id: 'audit_tiles', title: '최종 감사(07-14)', kind: 'tiles', asof: '2026-07-14T12:38:00+09:00', note: '라이브 아님(아카이브)', items: [tile('라벨 구간 순익', -2.81, 'bp', { status: 'bad' }), tile('실자본 판정', 'NO-GO', 'str', { status: 'bad' })] },
    ] },
  ],
};

describe('QUANT collector (IOC focus)', () => {
  it('derives the IOC finding, guard effect, markout/PnL, broken tiles and next steps from the snapshot', async () => {
    const m = await collectQuant(deps({ urls: { quant: SNAPSHOT } }));
    expect(m).toMatchObject({ id: 'quant', state: 'warn', metrics: { '탭': 3 } });
    expect(m.page!.headline).toBe('IOC 비중 범수동생계정3 9.2% · 빗썸1 7% · 빗썸2 6.2% (TIF 라벨 주문) · 깨진 타일 8');
    expect(m.page!.decision).toBe('IOC 비중 최고 계정(범수동생계정3)의 TIF 라벨 주문 표본 확인 → 메이커 회전 순익 음수 계정(범수동생계정3·빗썸1·빗썸2) 우선');
    expect(m.page!.kpis.map((k) => [k.label, k.value, k.status])).toEqual([
      ['IOC 범수동생계정3', '9.22%', 'info'], ['IOC 빗썸1', '7.03%', 'info'], ['IOC 빗썸2', '6.18%', 'info'],
      ['체결 발생 주문', '11.11%', undefined], ['메이커 회전 순익', '-6.74 bp', 'bad'], ['깨진 타일', '8', 'bad'],
    ]);
    const secs = m.page!.sections;
    const ioc = section(secs, /^IOC 발견/) as { rows: string[][]; open: boolean; note: string };
    expect(ioc.open).toBe(true);
    expect(ioc.rows).toEqual([['범수동생계정3', '513,699', '90.63%', '9.22%', '11.11%', '40', '-6.74'], ['빗썸1', '515,346', '93.04%', '7.03%', '8.45%', '40', '-1.39'], ['빗썸2', '965,056', '94.79%', '6.18%', '6.22%', '42', '-0.12']]);
    expect(ioc.note).toContain('IOC 비중(TIF 라벨 있는 주문)');
    const guard = section(secs, /^가드 효과/) as { rows: string[][]; note: string };
    expect(guard.rows).toEqual([['sh', '2,524', '22.2%', '0 bp', '0', '0'], ['a1', '1,496', '3.7%', '0 bp', '1,461', '977']]);
    expect(guard.note).toContain('절감 추정 지연 150ms -34,878원');
    expect(section(secs, /마크아웃 · PnL/)).toMatchObject({ kind: 'kv', rows: expect.arrayContaining([['최대낙폭 무헷지', '-12.48억 ⚠'], ['펀딩 순', '-3.28억 ⚠']]) });
    expect(section(secs, /월별 손익/)).toMatchObject({ kind: 'bars', items: expect.arrayContaining([{ label: '2026-08', value: 0.1, text: 'hedged 0.1 · unhedged 0.2' }]) });
    expect((section(secs, /월별 손익/) as { items: unknown[] }).items).toHaveLength(6);
    const broken = section(secs, /^깨진 타일/) as { items: { text: string; level: string }[]; open: boolean };
    expect(broken.open).toBe(true);
    expect(broken.items[0]).toEqual({ level: 'bad', text: '라이브 유닛 sh inactive', hint: 'v9flws-sh.service' });
    expect(broken.items.map((i) => i.text)).toEqual(expect.arrayContaining(['빗썸 RE 3계정 봇 › 최종 감사(07-14) · 실자본 판정 = NO-GO', '최O용 계정 · 선물 헷지 › 무헷지 vs 헷지 · 최대낙폭 무헷지 = -12.48억']));
    const next = section(secs, /다음에 볼 것/) as { items: { text: string }[] };
    expect(next.items.map((i) => i.text)).toEqual([
      'IOC 비중 최고 계정 범수동생계정3 (9.22%) 의 TIF 라벨 주문 표본부터 확인',
      '메이커 회전 순익 음수: 범수동생계정3 -6.74bp · 빗썸1 -1.39bp · 빗썸2 -0.12bp — 이 계정들의 IOC 체결 먼저',
      '라이브 유닛 sh inactive — 재가동 여부 결정',
      '카피 엔진 S 가드 › 채점 24h · sh 기준 20일 10시간 전 — 갱신 필요 여부 확인',
      '카피 엔진 S 가드 › 채점 24h · a1 기준 20일 10시간 전 — 갱신 필요 여부 확인',
      '카피 엔진 S 가드 › 회피 가능 절감 추정 · 24h 기준 20일 10시간 전 — 갱신 필요 여부 확인',
    ]);
    // raw drill-down: every tab section mapped, collapsed, with paths blanked; the proxy link last.
    expect(section(secs, /카피 엔진 S 가드 › 창 × 유닛 비교/)).toMatchObject({ kind: 'table', columns: ['창', '유닛', '체결N', '체결대금'], rows: [['1h', 'wf', '53', '2,068,042원']] });
    expect(section(secs, /카피 엔진 S 가드 › 유닛별 체결대금/)).toMatchObject({ kind: 'bars', items: [{ label: 'sh', value: 277458242, text: '277,458,242 KRW' }, { label: 'a1', value: 190179455, text: '190,179,455 KRW' }] });
    expect(section(secs, /월별 거래대금/)).toMatchObject({ kind: 'table', columns: ['구간', '거래대금 (억)'], rows: [['2026-06', '100'], ['2026-07', '83']] });
    expect(section(secs, /카피 엔진 S 가드 › 요약/)).toMatchObject({ kind: 'text', body: '1009ws_24h 요약', note: expect.stringContaining('… 첫 줄부터') });
    expect(secs.filter((s) => s.open).map((s) => s.title)).toEqual(['IOC 발견 — 계정별', '가드 효과 — 유닛별 24h', '깨진 타일', '다음에 볼 것']);
    expect(secs[secs.length - 1]).toMatchObject({ kind: 'raw', href: '/hub/p/quant/', embed: true });
    noHome(m);
    expect(JSON.stringify(m)).not.toContain('_src');
  });
  it('formats tile values by their declared format', () => {
    expect(fmtVal(8377335079, 'krw')).toBe('83.77억');
    expect(fmtVal(203661, 'krw')).toBe('203,661원');
    expect(fmtVal(7.03, 'pct')).toBe('7.03%');
    expect(fmtVal(-1.39, 'bp')).toBe('-1.39 bp');
    expect(fmtVal(3988.5, 'ms')).toBe('3,989 ms');
    expect(fmtVal(null, 'bp')).toBe('—');
    expect(fmtVal('NO-GO', 'str')).toBe('NO-GO');
  });
  it('without a re tab the page still summarises the snapshot and never throws', async () => {
    const m = await collectQuant(deps({ urls: { quant: { generated_at: iso(-30 * 3_600_000), tabs: [{ tab: 'x', title: 'X', sections: [{ id: 's', title: 'S', kind: 'tiles', items: [{ label: 'a', value: 1 }] }] }], errors: ['boom /home/max/secret.txt'] } } }));
    expect(m.state).toBe('warn');
    expect(m.alerts.map((a) => a.text)).toEqual(['boom …', '스냅샷 1일 6시간 전 생성']);
    expect(m.page!.kpis[0]).toMatchObject({ label: 'IOC 비중', value: '—' });
    expect(m.page!.decision).toBe('조치 없음');
    noHome(m);
  });
});

/* ───────── yapping ───────── */

const Y_STATUS = {
  mode: 'live', model: 'codex CLI', llm: true, x_api: { enabled: false, halted: null, reads: false, mode: 'live' },
  inbox: { dir: '/home/max/yapping-bot/inbox/x', pending: 0, checked_at: iso(-4 * 60_000), targets_file: '/home/max/yapping-bot/inbox/x/targets.json' },
  banners: [{ level: 'info', text: 'X API 꺼짐 (x_api.enabled=false) — 게시·팔로우는 확장으로 직접, 데이터는 무료 수집' }],
  costs: { today: { x_usd: 0, llm_usd: 0, x_reads: 0, x_read_budget: 0, llm_purposes: [{ day: '2026-10-30', purpose: 'ai_news_qt', calls: 38, in_tokens: 49111, out_tokens: 10520, cost: 0 }] }, model: 'gpt-4o-mini' },
  last_jobs: [{ job: 'inbox_ingest', finished: iso(-4 * 60_000), ok: 1, summary: "{'files': 1, 'posts': 33}" }, { job: 'news', finished: iso(-7 * 60_000), ok: 1, summary: 'rss' }],
  replies_done_today: 60, todo: 1, ai_news_pending: 74, now_kst: '2026-10-30T22:03:15+09:00',
};
const Y_METRICS = { posts: [{ tweet_id: '1', text: '오픈AI 티보: ChatGPT Pro 한도 2배\n\n코덱스 헤비유저면 체감 클 듯', created_at: iso(-12 * 3_600_000), impressions: 27, likes: 0, replies: 0, is_reply: false }, { tweet_id: '2', text: '답글입니다', created_at: iso(-30 * 60_000), impressions: 5, likes: 1, replies: 0, is_reply: true }], snapshots: [{ day: '2026-10-29', followers: 501 }, { day: '2026-10-30', followers: 502 }], median_impressions_10: 10, like_rate_10: 0.72, replies_done_7d: 153, replies_done_today: 60 };
const Y_UNITS = {
  'yapping-bot.service': UNIT_UP('Fri 2026-10-30 12:49:15 UTC'),
  'yapping-free-x.timer': { LoadState: 'loaded', ActiveState: 'active', SubState: 'waiting', NextElapseUSecRealtime: 'Fri 2026-10-30 22:35:00 KST', LastTriggerUSec: 'Fri 2026-10-30 22:05:14 KST', Result: 'success' },
  'yapping-free-x.service': { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', Result: 'success', ExecMainStartTimestamp: 'Fri 2026-10-30 13:05:14 UTC', ExecMainExitTimestamp: 'Fri 2026-10-30 13:05:40 UTC' },
  'yapping-tg-agg.timer': { LoadState: 'loaded', ActiveState: 'active', SubState: 'waiting', NextElapseUSecRealtime: 'Sat 2026-10-31 00:07:00 KST', LastTriggerUSec: 'Fri 2026-10-30 22:07:32 KST', Result: 'success' },
  'yapping-tg-agg.service': { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', Result: 'success', ExecMainExitTimestamp: 'Fri 2026-10-30 13:09:39 UTC' },
};
const YB_LOG = '2026-10-30 21:43:09,145 INFO yb.breaking: breaking lane: posts=26\n2026-10-30 16:11:55,476 ERROR yb.sched: job ai_news failed: all LLM backends failed: codex: RuntimeError: codex exit -15: \nTraceback (most recent call last):\n  File "/home/max/yapping-bot/yb.py", line 1\n2026-10-30 16:21:06,348 WARNING yb.llm: llm backend codex failed for news: Expecting delimiter\n2026-10-28 09:00:00,000 ERROR yb.old: ancient failure\n';
const FREE_X_LOG = '2026-10-21 13:49:02,000 WARNING yb.free_x: job metrics_posts: HTTP 402 Payment Required — credits depleted\n2026-10-21 13:19:02,000 WARNING yb.free_x: job metrics_posts: HTTP 402 Payment Required — credits depleted\n';

describe('야핑봇 collector (read-only)', () => {
  it('scans logs for 24 h errors and the last 402 (job name, time, count)', () => {
    const s = scanLogs([YB_LOG, FREE_X_LOG], NOW);
    expect(s.errors24h).toBe(2); // ERROR line + its Traceback line; the 2-day-old one is excluded
    expect(s.last402).toEqual({ at: '2026-10-21T04:49:02.000Z', job: 'metrics_posts', count: 2 });
    expect(s.recentErrors).toEqual([{ at: '2026-10-30T07:11:55.000Z', text: 'yb.sched: job ai_news failed: all LLM backends failed: codex: RuntimeError: codex exit -15:' }]);
    expect(scanLogs([null, ''], NOW)).toEqual({ errors24h: 0, last402: null, recentErrors: [] });
  });
  it('answers service, replies, last post, next timer, cost and errors from systemd + GET + logs', async () => {
    const m = await collectYapping(deps({ urls: { yappingStatus: Y_STATUS, yappingMetrics: Y_METRICS }, units: Y_UNITS, files: { 'yapping-bot/logs/yb.log': YB_LOG, 'yapping-bot/logs/free_x_collector.log': FREE_X_LOG } }));
    expect(m).toMatchObject({ id: 'yapping', name: '야핑봇', state: 'warn', tag: 'LIVE', metrics: { '서비스': '가동', '오늘 답글': 60, '마지막 포스트': '30분 전', '오류 24h': 2 }, links: [{ label: 'x.com/cblabx', href: 'https://x.com/cblabx' }] });
    expect(m.page!.headline).toBe('서비스 가동 (10분) · 답글 오늘 60 · 마지막 포스트 30분 전 · 타이머 2/2');
    expect(m.page!.decision).toBe('다음 수집 22:35 X 무료 수집 · 할 일 1 · AI 뉴스 대기 74');
    expect(m.page!.kpis.map((k) => [k.label, k.value])).toEqual([['서비스', '가동'], ['오늘 답글', '60'], ['마지막 포스트', '30분 전'], ['다음 타이머', '22:35 X 무료 수집'], ['오늘 비용', 'LLM $0 · X $0'], ['오류 24h', '2']]);
    expect(m.page!.kpis[2]).toMatchObject({ hint: '답글 30분 전' });
    expect(m.alerts).toEqual(expect.arrayContaining([
      { level: 'warn', text: '로그 오류: yb.sched: job ai_news failed: all LLM backends failed: codex: RuntimeError: codex exit -15:', at: '2026-10-30T07:11:55.000Z' },
      { level: 'info', text: 'X API 402 크레딧 소진 2회 · 마지막 10-21 13:49 · metrics_posts' },
      { level: 'info', text: 'X API 꺼짐 (x_api.enabled=false) — 게시·팔로우는 확장으로 직접, 데이터는 무료 수집' },
    ]));
    const timers = section(m.page!.sections, /^타이머$/) as { rows: string[][]; open: boolean };
    expect(timers.open).toBe(true);
    expect(timers.rows).toEqual([['X 무료 수집', '가동', '10-30 22:05 · 0초 전', '10-30 22:35', 'success'], ['TG 집계', '가동', '10-30 22:07 · 0초 전', '10-31 00:07', 'success']]);
    expect(section(m.page!.sections, /최근 작업/)).toMatchObject({ kind: 'table', open: true, rows: [['inbox_ingest', '10-30 21:56', '성공', "{'files': 1, 'posts': 33}"], ['news', '10-30 21:53', '성공', 'rss']] });
    expect(section(m.page!.sections, /최근 포스트/)).toMatchObject({ kind: 'table', rows: [['10-30 10:00', '27', '0', '포스트', '오픈AI 티보: ChatGPT Pro 한도 2배 코덱스 헤비유저면 체감 클 듯'], ['10-30 21:30', '5', '1', '답글', '답글입니다']] });
    expect(section(m.page!.sections, /팔로워/)).toMatchObject({ kind: 'bars', items: [{ label: '2026-10-29', value: 501, text: '501' }, { label: '2026-10-30', value: 502, text: '502' }], note: '현재 502' });
    expect(section(m.page!.sections, /비용 · LLM/)).toMatchObject({ kind: 'kv', rows: expect.arrayContaining([['모델', 'codex CLI'], ['X API', '끔'], ['LLM 호출 (오늘)', 'ai_news_qt 38']]) });
    expect(m.sources.map((s) => [s.name, s.ok])).toEqual([['/api/status', true], ['/api/metrics', true], ['systemd', true], ['로그', true]]);
    const text = JSON.stringify(m);
    noHome(m);
    expect(text).not.toContain('targets.json');
    expect(text).not.toContain('in_tokens');
  });
  it('a 402 inside 24 h is the decision; a stopped service is down; a stopped timer is warn', async () => {
    const fresh402 = `${new Date(NOW - 3_600_000).toISOString().slice(0, 19).replace('T', ' ')},000 WARNING yb.free_x: job metrics_posts: HTTP 402 credits depleted\n`; // written in UTC digits; parsed as KST → still inside 24 h
    let m = await collectYapping(deps({ urls: { yappingStatus: Y_STATUS, yappingMetrics: Y_METRICS }, units: Y_UNITS, files: { 'yapping-bot/logs/free_x_collector.log': fresh402 } }));
    expect(m.page!.decision).toBe('402 크레딧 소진 — X API 크레딧 확인');
    expect(m.alerts[0]).toMatchObject({ level: 'bad', text: expect.stringContaining('X API 402 크레딧 소진 1회') });
    expect(m.page!.kpis[5]).toMatchObject({ label: '오류 24h', value: '1', status: 'bad' });
    m = await collectYapping(deps({ urls: { yappingStatus: new Error('ECONNREFUSED'), yappingMetrics: new Error('ECONNREFUSED') }, units: { ...Y_UNITS, 'yapping-bot.service': UNIT_DEAD } }));
    expect(m.state).toBe('down');
    expect(m.page!.decision).toBe('서비스 정지 — 로그 확인 (여기서 재시작하지 않음)');
    expect(m.alerts[0]).toMatchObject({ level: 'bad', text: '서비스 정지 (dead) · 1일 3시간 전' });
    m = await collectYapping(deps({ urls: { yappingStatus: Y_STATUS, yappingMetrics: Y_METRICS }, units: { ...Y_UNITS, 'yapping-tg-agg.timer': UNIT_DEAD } }));
    expect(m.state).toBe('warn');
    expect(m.alerts).toEqual(expect.arrayContaining([{ level: 'warn', text: '타이머 TG 집계 정지' }]));
    expect(m.page!.kpis[3]).toMatchObject({ label: '다음 타이머', hint: '타이머 1/2', status: 'warn' });
  });
  it('is unknown when nothing answers, and never includes a control link', async () => {
    const m = await collectYapping(deps({}));
    expect(m).toMatchObject({ state: 'unknown', page: { headline: '상태 확인 불가' } });
    expect(JSON.stringify(m)).not.toMatch(/restart|start|trigger|run\b/i);
  });
});
