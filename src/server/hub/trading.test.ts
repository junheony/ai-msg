import { describe, expect, it } from 'vitest';
import type { HubSection } from '../../shared/hub-types';
import { HUB_URLS, type HubDeps } from './shared';
import { LANE_DOC, TRADING_DIR, TRADING_STATE_DIR, TRADING_TIMERS, checklistRows, collectTrading, goLiveSteps, laneRows, parseChecks, parseDbOut, parseGitLog, parseLaneDoc, paperRows, text } from './trading';

const NOW = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST
const HOME = '/Users/alice';
const epoch = (offsetMs: number): number => Math.floor((NOW + offsetMs) / 1000);

interface Fx { health?: unknown; files?: Record<string, string>; mtimes?: Record<string, number>; units?: Record<string, Record<string, string>>; exec?: Record<string, string | null> | null; now?: number }

/** Fake deps: paths are relative to HOME; `exec` is keyed by argv[0] (python3 / git) with canned stdout, null = failure, absent = no exec at all. */
function deps(fx: Fx): HubDeps & { calls: string[][] } {
  const calls: string[][] = [];
  const rel = (p: string): string => (p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p);
  const base: HubDeps & { calls: string[][] } = {
    calls,
    fetchJson: async (url) => { if (url !== HUB_URLS.trading) throw new Error(`unexpected ${url}`); if (fx.health instanceof Error) throw fx.health; if (fx.health === undefined) throw new Error('fetch failed: ECONNREFUSED'); return fx.health; },
    latestRender: async () => null,
    countEntries: async () => null,
    gitLastCommit: async () => null,
    readText: async (f) => fx.files?.[rel(f)] ?? null,
    readTail: async (f) => fx.files?.[rel(f)] ?? null,
    listDir: async () => null,
    fileMtime: async (f) => fx.mtimes?.[rel(f)] ?? null,
    systemdShow: async (u) => fx.units?.[u] ?? (fx.units ? { LoadState: 'not-found', ActiveState: 'inactive' } : null),
    now: () => fx.now ?? NOW, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
  };
  if (fx.exec !== undefined) base.exec = async (cmd, args) => { calls.push([cmd, ...args]); return fx.exec?.[cmd] ?? null; };
  return base;
}
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));
const noHome = (v: unknown): void => { const s = JSON.stringify(v); expect(s).not.toContain(HOME); expect(s).not.toMatch(/\/home\/[a-z]/); };
const stateFile = (name: string): string => `${TRADING_STATE_DIR}/${name}`;

/* ───────── fixtures (shapes verified against the live state files) ───────── */

const CHECKS = [
  { id: 'trade_keys.upbit', group: 'keys', ok: true, label: '업비트 키', detail: '채움', next: '' },
  { id: 'trade_keys.bybit', group: 'keys', ok: false, label: '바이빗 키', detail: `${HOME}/.config/nexus/trade.env 비어 있음`, next: '~/.config/nexus/trade.env 에 키 입력' },
  { id: 'key_check.upbit', group: 'keys', ok: false, label: '업비트 키 점검', detail: '미실행', next: 'python3 scripts/go_live.py keys-check' },
  { id: 'smoke.t1', group: 'smoke', ok: false, label: '소액 실측', detail: '전', next: 'go_live.py smoke' },
  { id: 'engine.wave', group: 'engine', ok: true, label: '웨이브 엔진', detail: '가동', next: '' },
  { id: 'config.fx', group: 'config', ok: true, label: '환율', detail: '1,420', next: '' },
];
const GL = {
  schema: 2, generated_at: epoch(-30_000), generated_at_kst: '2026-10-30 21:59:30',
  ready: { smoke: false, t1: false, p1: false, lane_first: false, lane_setup: false, t2_abroad: [], t2: false, auto: false },
  next_command: `~/.config/nexus/trade.env 에 세 거래소 키 입력(값은 대화에 붙이지 말 것) → python3 scripts/go_live.py keys-check (${HOME}/arbitrage-nexus)`,
  checks: CHECKS,
  t2_shadow_gate: { cycles: 107, median_pnl_usd: -1.2, median_net_pct: -0.3, collapsed_frac: 0.4, passed: false },
  t2v3_shadow_gate: { passed: false, n: 50, items: { median_net: { value: -0.3, ok: false }, cycles: { value: 50, ok: true } } },
  transfer_isolation: { deployed: true, why: '격리 OK' }, unknown_orders: 0, pauses: [],
};
const MAKER = {
  ts: epoch(-40_000), size_usd: 200, wait_min: 5, hold_min: 10, counts: { both: 100 },
  by_mode: { '양메이커': { n: 120, n_settled: 100, ev_strict_med: 0.1, strict_fill_rate: 60.5, '미체결_pct': 39.5, med: 0.2, vs_taker_med: 0.3 } },
  by_slice: { '매도메이커|역프': { n: 59239, strict_med: 0.28, strict_win: 59.35, strict_fill_pct: 70, opt_med: 0.4, opt_win: 65 }, '매수메이커|김프': { n: 10, strict_med: -0.5, strict_win: 20, strict_fill_pct: 50, opt_med: 0, opt_win: 30 } },
  fill_rate_pct: 61, unfilled_pct: 39, oneleg_pct: 12, both_med: 0.15, n_both: 100, vs_taker_med: 0.3, caveats: [`페이퍼는 호가만 봄 (${HOME}/arbitrage-nexus/notes.md)`],
};
const DESK = {
  ts: epoch(-50_000), fx: 1420, size_usd: 300, hold_min: 20, n_rows: 500, n_table_exec: 40, n_probed: 12, n_live: 0,
  why_dropped: { '경로막힘': 300, '크기미달': 100, '순음수': 50, '값의심': 10 }, live: [],
  probed: [{ sym: 'BTC', kind: '이송', buy: 'upbit', sell: 'bybit', table_net_pct: 0.5, table_size_usd: 300, grade: 'B', ok: false, why: `호가 얇음 ${HOME}/x` }],
  paper: { open: 2, n: 11694, median: -0.7, mean: -0.4, win: 41, worst: -5.1, best: 3.2, reached_tp: 900, by_mode: { '재고': { n: 5000, median: -1.1, mean: -0.9, win: 30, reached_tp: 100 }, '이송': { n: 6000, median: 0.78, mean: 0.6, win: 88, reached_tp: 800 }, '동시': { n: 694, median: 0.1, mean: 0.05, win: 50, reached_tp: 0 } }, by_reason: {} },
  not_modeled: [], now_modeled: [],
};
const LANE_MD = `# 레인 성적표 — 2026-10-30 21:50

살았다 2 · 죽었다 1 · 수집중 1

- 돈 판정표(수기) 적은 날 2026-10-20T10:00:00+09:00
- 원장 30일 매도 120 · 순 +1,234 (${HOME}/arbitrage-nexus/ledger.db)

| 레인 | 가설 | 30일 n | 비용 뒤(주 시평) | 적중률 | 플라시보 | 자동 | 사람 | 다음 판정 조건 |
|---|---|---|---|---|---|---|---|---|
| L1 | **빠른 이송** | 40 | +0.5% | 60% | 0.1% | 수집중 | ⚠ 보류 | n 100 |
| L2 | 역프 | 300 | +0.9% | 70% | 0.2% | 살았다 | 유지 | 계속 |
| L3 | 김프 | 20 | -1.0% | 30% | 0.3% | 죽었다 | 종료 | — |
| L4 | 동시 | 500 | +0.3% | 55% | 0.1% | 살았다 | 유지 | 계속 |

| 다른 표 | x |
|---|---|
| a | b |
`;
const DB_OUT = JSON.stringify({
  wave: { actions: { sell: [20, 1664.4], refill: [5, 0] }, sells: [{ ts: epoch(-3_600_000), sym: 'BTC', gap: 0.55, size: 150, pnl: 12.3, venue: 'upbit', note: `ok ${HOME}/w` }, { ts: epoch(-7_200_000), sym: 'ETH', gap: 0.2, size: 100, pnl: -3, venue: 'bybit', note: '' }], pos_n: 3, pos_inv: 500, last_ts: epoch(-3_600_000) },
  mmp: { n: 10, rows: [{ det: 'vol', variant: 'v1', n: 5, done: 4, hit: 2, last: epoch(-600_000) }] },
});
const GIT_LOG = `2026-10-30T21:00:00+09:00\tfeat: 레인 성적표 갱신 (${HOME}/arbitrage-nexus)\n2026-10-29T10:00:00+09:00\tfix: 웨이브 보충\n`;
const HEALTH = { id: 'trading', state: 'ok', stage: 'paper', lastActivity: '2026-10-30T21:43:01+09:00', metrics: { shadow_heartbeat_age_s: 1 }, alerts: [] };
const timerUnits = (result = 'success'): Record<string, Record<string, string>> => Object.fromEntries(TRADING_TIMERS.flatMap((t) => [
  [t.timer, { LoadState: 'loaded', ActiveState: 'active', SubState: 'waiting', LastTriggerUSec: 'Fri 2026-10-30 12:59:00 UTC', NextElapseUSecRealtime: '' }],
  [t.service, { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', Result: result, ExecMainExitTimestamp: 'Fri 2026-10-30 12:59:05 UTC' }],
]));
const full = (over: Partial<Fx> = {}): Fx => ({
  health: HEALTH,
  files: { [stateFile('go_live_status.json')]: JSON.stringify(GL), [stateFile('maker_paper.json')]: JSON.stringify(MAKER), [stateFile('live_desk.json')]: JSON.stringify(DESK), [`${TRADING_DIR}/${LANE_DOC}`]: LANE_MD },
  mtimes: { [stateFile('wave_paper.db')]: NOW - 20_000 },
  units: timerUnits(),
  exec: { python3: DB_OUT, git: GIT_LOG },
  ...over,
});

/* ───────── pure helpers ───────── */

describe('trading helpers', () => {
  it('text() blanks absolute home paths but keeps ~/ paths (they name no user)', () => {
    expect(text(`~/.config/nexus/trade.env 와 ${HOME}/x`)).toBe('~/.config/nexus/trade.env 와 …');
    expect(text(42)).toBe('');
  });
  it('goLiveSteps marks done steps from checks/ready flags and the first undone step active', () => {
    const checks = parseChecks(GL);
    const steps = goLiveSteps(GL, checks);
    expect(steps.map((s) => `${s.label}:${s.state}`)).toEqual(['키 입력:active', '키 점검:todo', '소액 실측:todo', '레인 설정:todo', 'T2 섀도 게이트:todo', '자동:todo']);
    expect(steps[0]!.hint).toBe('1/2 채움');
    expect(steps[4]!.hint).toContain('순환 107');
    const allKeys = { ...GL, ready: { ...GL.ready, smoke: true, lane_setup: true, lane_first: false }, checks: CHECKS.map((c) => (c.group === 'keys' ? { ...c, ok: true } : c)) };
    const s2 = goLiveSteps(allKeys, parseChecks(allKeys));
    expect(s2.map((s) => s.state)).toEqual(['done', 'done', 'done', 'active', 'todo', 'todo']);
    expect(s2[3]!.hint).toBe('lane-setup 완료 · 첫 실이송 전');
    const auto = { ...allKeys, ready: { ...allKeys.ready, lane_first: true, t2: true, auto: true } };
    expect(goLiveSteps(auto, parseChecks(auto)).every((s) => s.state === 'done')).toBe(true);
    expect(goLiveSteps(null, []).map((s) => s.state)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
  });
  it('checklistRows puts failing checks first with Korean group names and scrubbed details', () => {
    const rows = checklistRows(parseChecks(GL));
    expect(rows.map((r) => r[2])).toEqual(['실패', '실패', '실패', '통과', '통과', '통과']);
    expect(rows[0]).toEqual(['키', '바이빗 키', '실패', '… 비어 있음', '~/.config/nexus/trade.env 에 키 입력']);
    expect(rows[2]![0]).toBe('실측');
    expect(rows[3]![4]).toBe('—');
    noHome(rows);
  });
  it('paperRows lists live-desk overall + modes sorted by median desc, then maker overall/modes and top-3 slices', () => {
    const rows = paperRows(MAKER, DESK);
    expect(rows[0]!.slice(0, 5)).toEqual(['라이브 데스크', '전체', '11,694', '-0.70%', '41%']);
    expect(rows.slice(1, 4).map((r) => r[1])).toEqual(['이송', '동시', '재고']);
    expect(rows[1]!.slice(2, 5)).toEqual(['6,000', '+0.78%', '88%']);
    expect(rows[4]!.slice(0, 2)).toEqual(['메이커', '전체(양다리)']);
    expect(rows[5]!.slice(0, 3)).toEqual(['메이커', '양메이커', '100']);
    expect(rows[6]!.slice(0, 3)).toEqual(['메이커 슬라이스', '매도메이커|역프', '59,239']);
    expect(rows[6]![3]).toBe('+0.28%');
    expect(paperRows(null, null)).toEqual([]);
  });
  it('parseLaneDoc reads date, counts, verdict date, ledger and only the first table; laneRows orders 살았다 → 죽었다 → 수집중 by n', () => {
    const doc = parseLaneDoc(LANE_MD)!;
    expect(doc).toMatchObject({ date: '2026-10-30 21:50', alive: 2, dead: 1, collecting: 1, verdictAt: '2026-10-20T01:00:00.000Z' });
    expect(doc.ledger).toBe('원장 30일 매도 120 · 순 +1,234 (…)');
    expect(doc.columns).toHaveLength(9);
    expect(doc.rows).toHaveLength(4);
    expect(doc.rows[0]![1]).toBe('빠른 이송');
    const rows = laneRows(doc);
    expect(rows.map((r) => r[0])).toEqual(['L4', 'L2', 'L3', 'L1']);
    expect(rows[3]![7]).toBe('보류');
    expect(parseLaneDoc(null)).toBeNull();
    expect(laneRows(null)).toEqual([]);
  });
  it('parseDbOut / parseGitLog handle the canned python line and git format, and reject garbage', () => {
    const db = parseDbOut(`warning line\n${DB_OUT}`)!;
    expect(db.wave).toMatchObject({ error: null, refills: 5, sells: 20, pnl: 1664.4, posN: 3, posInv: 500 });
    expect(db.wave!.recent[0]).toMatchObject({ sym: 'BTC', pnl: 12.3, venue: 'upbit', note: 'ok …' });
    expect(db.mmp!.rows[0]).toMatchObject({ det: 'vol', n: 5, done: 4, hit: 2 });
    expect(parseDbOut(JSON.stringify({ wave: { error: 'OperationalError' }, mmp: { error: 'OperationalError' } }))!.wave!.error).toBe('OperationalError');
    expect(parseDbOut('not json')).toBeNull();
    expect(parseDbOut(null)).toBeNull();
    const log = parseGitLog(GIT_LOG);
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({ at: '2026-10-30T12:00:00.000Z', subject: 'feat: 레인 성적표 갱신 (…)' });
    expect(parseGitLog(null)).toEqual([]);
  });
});

/* ───────── collector ───────── */

describe('collectTrading', () => {
  it('builds the go-live work page from the state files, sqlite summary, lane doc and git log', async () => {
    const d = deps(full());
    const m = await collectTrading(d);
    expect(m.state).toBe('ok');
    expect(m.tag).toBe('PAPER');
    expect(m.page!.headline).toBe('라이브 전환 미완 · 체크 3/6 통과 · 페이퍼 n=11,694 중앙값 -0.70% (이송 +0.78% 승 88%) · 웨이브 +1,664');
    expect(m.page!.decision).toBe('~/.config/nexus/trade.env 에 세 거래소 키 입력(값은 대화에 붙이지 말 것) → python3 scripts/go_live.py keys-check (…)');
    expect(m.page!.kpis.map((k) => k.label)).toEqual(['체크 통과', '페이퍼 승률 · 중앙값', '이송 모드', '웨이브 누적 PnL', '레인 살았다/죽었다/수집중', '마지막 커밋']);
    expect(m.page!.kpis[0]).toMatchObject({ value: '3/6', status: 'warn' });
    expect(m.page!.kpis[3]!.value).toBe('+1,664');
    expect(m.page!.kpis[4]!.value).toContain('2');
    expect(m.page!.sections.map((s) => s.title)).toEqual(['라이브 전환', '체크리스트', '페이퍼 성적 (모드별)', '드롭 사유 (라이브 데스크)', '호가 탐침 후보', '웨이브 페이퍼 (최근 매도)', '레인 성적표', '최근 커밋', '타이머 · 신선도', '섀도 게이트 · 격리', '헬스 :8830', '펌프 섀도 감지기', '메이커 페이퍼 주의']);
    const steps = section(m.page!.sections, /^라이브 전환$/)!;
    expect(steps.kind).toBe('steps');
    if (steps.kind === 'steps') { expect(steps.open).toBe(true); expect(steps.items[0]).toMatchObject({ label: '키 입력', state: 'active' }); }
    const checklist = section(m.page!.sections, /^체크리스트$/)!;
    if (checklist.kind === 'table') { expect(checklist.rows[0]![2]).toBe('실패'); expect(checklist.rows.at(-1)![2]).toBe('통과'); expect(checklist.wrap).toEqual([3, 4]); }
    const wave = section(m.page!.sections, /^웨이브 페이퍼/)!;
    if (wave.kind === 'table') { expect(wave.rows).toHaveLength(2); expect(wave.rows[0]![1]).toBe('BTC'); expect(wave.note).toContain('누적 +1,664'); expect(wave.note).toContain('매도 20'); expect(wave.note).toContain('포지션 3'); }
    const lanes = section(m.page!.sections, /^레인 성적표$/)!;
    if (lanes.kind === 'table') { expect(lanes.rows).toHaveLength(4); expect(lanes.rows[0]![0]).toBe('L4'); expect(lanes.note).toContain('살았다 2'); }
    const commits = section(m.page!.sections, /^최근 커밋$/)!;
    if (commits.kind === 'table') { expect(commits.rows).toHaveLength(2); expect(commits.rows[0]![1]).toBe('feat: 레인 성적표 갱신 (…)'); }
    const drop = section(m.page!.sections, /^드롭 사유/)!;
    if (drop.kind === 'kv') expect(drop.rows.some(([k, v]) => k.includes('경로막힘') && v.includes('300'))).toBe(true);
    const fresh = section(m.page!.sections, /^타이머 · 신선도$/)!;
    if (fresh.kind === 'kv') { expect(fresh.rows.length).toBeGreaterThanOrEqual(4); expect(JSON.stringify(fresh.rows)).toContain('+2분'); }
    expect(m.alerts.map((a) => a.text)).toEqual(expect.arrayContaining([expect.stringContaining('라이브 전환 미완 · 체크 3/6 통과'), expect.stringContaining('T2 섀도 게이트 미통과')]));
    expect(m.alerts.every((a) => a.level === 'info')).toBe(true);
    expect(m.sources.map((s) => s.name)).toEqual(['trading /api/status', 'go_live_status.json', 'maker_paper.json', 'live_desk.json', 'wave_paper.db', 'sqlite', 'git log', '레인 성적표', 'systemd']);
    expect(m.sources.every((s) => s.ok)).toBe(true);
    // read-only: python runs isolated against the two db paths, git only logs; nothing else is executed
    expect(d.calls.map((c) => c[0]).sort()).toEqual(['git', 'python3']);
    expect(d.calls.find((c) => c[0] === 'python3')!.slice(1, 3)).toEqual(['-I', '-c']);
    expect(d.calls.find((c) => c[0] === 'git')).toEqual(['git', '-C', `${HOME}/${TRADING_DIR}`, 'log', '-15', '--format=%cI%x09%s']);
    noHome(m);
    expect(JSON.stringify(m)).not.toContain('api_key');
  });
  it('falls back to "sqlite 조회 불가" when exec is absent or fails, without losing the rest of the page', async () => {
    for (const exec of [undefined, null, { python3: null, git: null }]) {
      const m = await collectTrading(deps(full({ exec: exec as Fx['exec'] })));
      expect(m.state).toBe('ok');
      expect(m.page!.headline).toBe('라이브 전환 미완 · 체크 3/6 통과 · 페이퍼 n=11,694 중앙값 -0.70% (이송 +0.78% 승 88%)');
      const wave = section(m.page!.sections, /^웨이브 페이퍼/)!;
      if (wave.kind === 'table') { expect(wave.rows).toEqual([]); expect(wave.note).toContain('sqlite 조회 불가'); }
      expect(m.page!.kpis[3]!.value).toBe('—');
      expect(m.alerts.some((a) => a.level === 'info' && a.text.startsWith('웨이브·펌프 DB'))).toBe(true);
      expect(m.sources.find((s) => s.name === 'sqlite')).toMatchObject({ ok: false });
      expect(m.sources.find((s) => s.name === 'git log')).toMatchObject({ ok: false });
      const commits = section(m.page!.sections, /^최근 커밋$/)!;
      if (commits.kind === 'table') expect(commits.rows).toEqual([]);
      noHome(m);
    }
  });
  it('reports a db-side error (locked / missing file) as sqlite 조회 불가 with the python error type', async () => {
    const out = JSON.stringify({ wave: { error: 'OperationalError' }, mmp: { error: 'OperationalError' } });
    const m = await collectTrading(deps(full({ exec: { python3: out, git: GIT_LOG } })));
    const wave = section(m.page!.sections, /^웨이브 페이퍼/)!;
    if (wave.kind === 'table') expect(wave.note).toBe('sqlite 조회 불가 (OperationalError)');
    expect(m.page!.headline).not.toContain('웨이브');
  });
  it('warns when a state file is older than twice its timer period or missing, and when a timer run failed', async () => {
    const stale = { ...GL, generated_at: epoch(-5 * 60_000) };
    const files = { ...full().files!, [stateFile('go_live_status.json')]: JSON.stringify(stale) };
    delete files[stateFile('maker_paper.json')];
    const m = await collectTrading(deps(full({ files, units: timerUnits('exit-code') })));
    expect(m.state).toBe('warn');
    const texts = m.alerts.map((a) => a.text);
    expect(texts).toEqual(expect.arrayContaining([expect.stringMatching(/^출격 준비 상태 오래됨 · 5분 전/), '메이커 페이퍼 상태 파일 없음 (maker_paper.json)', expect.stringMatching(/^라이브 데스크 마지막 실행 exit-code/)]));
    expect(m.alerts[0]!.level).toBe('warn');
    expect(m.sources.find((s) => s.name === 'maker_paper.json')).toMatchObject({ ok: false, error: '파일 없음' });
  });
  it('warns on unknown orders / pauses from go_live_status and passes :8830 alerts through', async () => {
    const gl = { ...GL, unknown_orders: 2, pauses: [{ why: 'x' }] };
    const health = { ...HEALTH, stage: 'live', alerts: [`스냅샷 오래됨 ${HOME}/snap`, { level: 'bad', text: '하트비트 없음' }] };
    const m = await collectTrading(deps(full({ health, files: { ...full().files!, [stateFile('go_live_status.json')]: JSON.stringify(gl) } })));
    expect(m.tag).toBe('LIVE');
    expect(m.state).toBe('warn');
    expect(m.alerts.map((a) => a.text)).toEqual(expect.arrayContaining(['모르는 주문 2건', '라이브 멈춤 1건', '스냅샷 오래됨 …', '하트비트 없음']));
    expect(m.alerts[0]).toMatchObject({ level: 'bad', text: '하트비트 없음' });
  });
  it('is unknown when nothing is readable, and warns when only go_live_status is missing', async () => {
    const empty = await collectTrading(deps({ exec: null }));
    expect(empty.state).toBe('unknown');
    expect(empty.page!.headline).toBe('출격 상태 미상');
    expect(empty.page!.decision).toContain('go-live-status 타이머 확인');
    expect(empty.alerts.some((a) => a.text === 'go_live_status.json 없음 — 체크리스트 확인 불가')).toBe(true);
    const steps = section(empty.page!.sections, /^라이브 전환$/)!;
    if (steps.kind === 'steps') expect(steps.items.every((s) => s.state === 'todo')).toBe(true);
    noHome(empty);
    const files = { ...full().files! };
    delete files[stateFile('go_live_status.json')];
    const m = await collectTrading(deps(full({ files })));
    expect(m.state).toBe('warn');
    expect(m.page!.headline).toBe('출격 상태 미상 · 페이퍼 n=11,694 중앙값 -0.70% (이송 +0.78% 승 88%) · 웨이브 +1,664');
    expect(m.page!.kpis[0]!.value).toBe('—');
  });
  it('caches the sqlite and git results per deps instance for a minute', async () => {
    const d = deps(full());
    await collectTrading(d);
    await collectTrading(d);
    expect(d.calls.filter((c) => c[0] === 'python3')).toHaveLength(1);
    expect(d.calls.filter((c) => c[0] === 'git')).toHaveLength(1);
  });
});
