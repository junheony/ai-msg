import { describe, expect, it } from 'vitest';
import type { HubSection } from '../../shared/hub-types';
import { HUB_URLS, type HubDeps } from './shared';
import { collectUpdown, parseDatabaseUrl, parsePsqlSections } from './updown';

const NOW = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST → today 2026-10-30, yesterday 10-29
const HOME = '/Users/alice';
const DB_URL = 'postgres://labuser:s3cret@127.0.0.1:15432/bbai_updown_lab';
const LAB_ENV = `# lab\nexport DATABASE_URL="${DB_URL}"\nCRON_SECRET=zzz\n`;

const HEALTH = { ok: true, ts: NOW - 5000, db: true };
const BOARD = { success: true, board: { asset: 'ALL', window: '30d', fleet: [
  { id: 'momentum-5m', name: 'Momentum Scalper', rule: 'Rides the last five minutes.', control: false, n: 25913, wins: 12962, hitRate: 0.5002, edge: -0.0051, grade: 'UNPROVEN', streak: 1, bestStreak: 24, lastRoundNo: 5977927 },
  { id: 'rubber-band', name: 'Liquidation Hunter', rule: 'Fades a stretched move.', control: false, n: 5000, wins: 2600, hitRate: 0.52, edge: 0.015, grade: 'EDGE', streak: 7, bestStreak: 14, lastRoundNo: 5977927 },
  { id: 'always-up', name: 'Always Up', rule: 'Control: always up.', control: true, n: 25913, wins: 12400, hitRate: 0.478, edge: -0.027, grade: 'LOST', streak: 0, bestStreak: 21, lastRoundNo: 5977927 },
] } };

const T = (...c: (string | number)[]): string => c.join('\t');
const iso = (s: string): string => s; // psql rows carry ISO UTC already
/** Canned `psql -A -t -F \t` stdout in the collector's `__SEC_` layout. */
function psqlOut(o: { daily?: string[]; open?: string[]; rounds?: string[]; end?: boolean } = {}): string {
  const daily = o.daily ?? [
    T('BNB', '2026-10-17', '198.7'), T('BNB', '2026-10-29', '-156.6'), T('BNB', '2026-10-30', '-33.8'),
    T('BTC', '2026-10-29', '-1083.7'), T('BTC', '2026-10-30', '-26.5'),
    T('ETH', '2026-10-16', '999'), T('ETH', '2026-10-29', '-878.7'), T('ETH', '2026-10-30', '-3204.3'),
  ];
  const open = o.open ?? [T('BNB', 5977929, 'always-up', 'up', iso('2026-10-30T12:57:01Z'), 'open'), T('BTC', 5977929, 'rubber-band', 'down', iso('2026-10-30T12:57:01Z'), 'open')];
  const rounds = o.rounds ?? [T('BNB', 5977929, 'open', '2026-10-30T12:55:00Z', '2026-10-30T13:00:00Z', '2026-10-30T13:05:00Z', '', ''), T('BTC', 5977929, 'open', '2026-10-30T12:55:00Z', '2026-10-30T13:00:00Z', '2026-10-30T13:05:00Z', '', ''), T('BNB', 5977928, 'live', '2026-10-30T12:50:00Z', '2026-10-30T12:55:00Z', '2026-10-30T13:00:00Z', '', '')];
  return [
    '__SEC_daily', ...daily,
    '__SEC_asset7', T('BNB', 9862, 9889, 0, 14487, 0), T('BTC', 9809, 9952, 0, 14476, 0), T('ETH', 9755, 9888, 0, 14593, 0),
    '__SEC_brain7', T('always-up', 2916, 3126, 0), T('momentum-5m', 3041, 3001, 0), T('rubber-band', 825, 808, 4409),
    '__SEC_brainbp', T('always-up', '-1200.5'), T('momentum-5m', '2754.3'), T('rubber-band', '3906'),
    '__SEC_trades',
    T('BNB', 5977928, 'always-up', 'up', 'loss', 'down', '2026-10-30T12:52:02Z', ''),
    T('BTC', 5977928, 'momentum-5m', 'down', 'win', 'down', '2026-10-30T12:52:02Z', ''),
    T('ETH', 5977927, 'rubber-band', 'down', 'win', 'down', '2026-10-30T12:47:02Z', '85.5'),
    T('ETH', 5977927, 'always-up', 'up', 'loss', 'down', '2026-10-30T12:47:02Z', '-85.5'),
    T('BNB', 5977926, 'momentum-5m', 'up', 'void', '', '2026-10-30T12:42:02Z', '0'),
    '__SEC_open', ...open,
    '__SEC_rounds', ...rounds,
    '__SEC_heat', T('ETH', 498159, 'scored', '2026-10-30T12:06:29Z', 'momentum-5m', 0), T('BNB', 498158, 'void', '2026-10-30T11:05:30Z', '', 2),
    '__SEC_tick', T('worker', '2026-10-30T12:59:40Z', 282285), T('cron', '2026-09-26T17:07:07Z', 1),
    '__SEC_brains', '17',
    ...(o.end === false ? [] : ['__SEC_end']),
    '',
  ].join('\n');
}

interface Fx { urls?: Partial<Record<keyof typeof HUB_URLS, unknown>>; env?: string | null; psql?: string | null | (() => string | null); noExec?: boolean; now?: () => number }
interface Call { cmd: string; args: string[]; o: { timeoutMs: number; env?: Record<string, string>; stdin?: string } }
function deps(fx: Fx = {}): HubDeps & { calls: Call[] } {
  const byUrl = new Map<string, unknown>(Object.entries(HUB_URLS).map(([k, url]) => [url, fx.urls?.[k as keyof typeof HUB_URLS]]));
  const calls: Call[] = [];
  const env = fx.env === undefined ? LAB_ENV : fx.env;
  const d: HubDeps & { calls: Call[] } = {
    calls,
    fetchJson: async (url) => { const a = byUrl.get(url); if (a instanceof Error) throw a; if (a === undefined) throw new Error('fetch failed: ECONNREFUSED'); return a; },
    latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null,
    readText: async (f) => (f === `${HOME}/bbai-updown-lab/lab.env` ? env : null),
    readTail: async () => null, listDir: async () => null, fileMtime: async () => null, systemdShow: async () => null,
    now: fx.now ?? (() => NOW), self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
  };
  if (!fx.noExec) d.exec = async (cmd, args, o) => { calls.push({ cmd, args, o }); const v = fx.psql === undefined ? psqlOut() : fx.psql; return typeof v === 'function' ? v() : v; };
  return d;
}
const ALL_OK: Fx['urls'] = { updown: HEALTH, updownStaging: { ...HEALTH, ts: NOW }, updownBoard: BOARD };
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));
const table = (secs: HubSection[], title: RegExp): Extract<HubSection, { kind: 'table' }> => { const s = section(secs, title); if (!s || s.kind !== 'table') throw new Error(`no table ${title}`); return s; };

describe('collectUpdown · paper record', () => {
  it('runs ONE read-only psql on stdin (fixed argv, read-only transaction, URL only in argv) and shows the trades table newest first', async () => {
    const d = deps({ urls: ALL_OK });
    const m = await collectUpdown(d);
    expect(d.calls).toHaveLength(1);
    const c = d.calls[0]!;
    expect(c.cmd).toBe('psql');
    expect(c.args).toEqual([DB_URL, '-X', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1']);
    expect(c.o.env).toEqual({ PGOPTIONS: '-c default_transaction_read_only=on', PGCONNECT_TIMEOUT: '4' });
    expect(c.o.timeoutMs).toBe(8000);
    expect(c.o.stdin).toMatch(/__SEC_daily[\s\S]*__SEC_trades[\s\S]*__SEC_end/);
    expect(c.o.stdin).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|create)\b/i);
    expect(m.state).toBe('ok');
    expect(m.tag).toBe('PAPER');
    expect(m.page!.headline).toBe('페이퍼 · 7일 승률 49.7% (59,155콜) · 어제 −2,119 bp · 열린 콜 2 · 라운드 #5977929 오픈');
    expect(m.page!.decision).toContain('최악 Momentum Scalper 7일 +2,754.3 bp'); // the control brain is not a candidate
    expect(m.page!.decision).toContain('최고 Liquidation Hunter +3,906 bp');
    expect(m.page!.decision).toContain('Liquidation Hunter 7연승');
    const t = table(m.page!.sections, /최근 트레이드/);
    expect(t.columns).toEqual(['시각(KST)', '자산', '브레인', '방향', '결과', 'bp', '라운드']);
    expect(t.num).toEqual([5, 6]);
    expect(t.rows).toHaveLength(5);
    expect(t.rows[0]).toEqual(['10-30 21:52', 'BNB', 'Always Up', '상승', '패', '—', '#5977928']);
    expect(t.rows[2]).toEqual(['10-30 21:47', 'ETH', 'Liquidation Hunter', '하락', '승', '+85.5', '#5977927']);
    expect(t.rows[3]![5]).toBe('−85.5');
    expect(t.rows[4]![4]).toBe('무효');
    expect(m.sources.map((s) => [s.name, s.ok])).toEqual([['app :3090', true], ['staging :3198', true], ['board API', true], ['lab DB (psql)', true]]);
    expect(m.metrics).toMatchObject({ '앱': '정상', DB: '연결됨', '스테이징': '정상', '7일 승률': '49.7%', '7일 bp': '−5,383.6 bp', '열린 콜': 2 });
    expect(m.lastActivity).toBe('2026-10-30T13:00:00.000Z'); // newest of calls, ticks and health
  });

  it('daily chart: 14 KST day labels oldest → newest, one aligned series per asset plus a cumulative line, zero line, bp unit', async () => {
    const m = await collectUpdown(deps({ urls: ALL_OK }));
    const ch = section(m.page!.sections, /일별 손익/);
    if (!ch || ch.kind !== 'chart') throw new Error('no chart');
    expect(ch.x).toHaveLength(14);
    expect(ch.x[0]).toBe('10-17');
    expect(ch.x[13]).toBe('10-30');
    expect(ch.unit).toBe('bp');
    expect(ch.zero).toBe(true);
    expect(ch.series.map((s) => s.name)).toEqual(['BNB', 'BTC', 'ETH', '누적(합계)']);
    for (const s of ch.series) expect(s.values).toHaveLength(14);
    const bnb = ch.series[0]!, eth = ch.series[2]!, cum = ch.series[3]!;
    expect(bnb.style).toBe('bar');
    expect(bnb.values[0]).toBe(198.7); // 10-17
    expect(bnb.values[1]).toBeNull(); // 10-18: no heat
    expect(bnb.values[12]).toBe(-156.6); // 10-29
    expect(bnb.values[13]).toBe(-33.8); // 10-30
    expect(eth.values).not.toContain(999); // 10-16 is outside the window
    expect(cum.style).toBe('line');
    expect(cum.values[0]).toBe(198.7);
    expect(cum.values[1]).toBe(198.7); // carried forward
    expect(cum.values[13]).toBeCloseTo(-5184.9, 1);
    const kpis = Object.fromEntries(m.page!.kpis.map((k) => [k.label, k]));
    expect(kpis['오늘']).toMatchObject({ value: '−3,264.6', unit: 'bp', status: 'bad', hint: '어제 −2,119 bp' });
    expect(kpis['7일 누적']).toMatchObject({ value: '−5,383.6', unit: 'bp' });
    expect(kpis['7일 승률']).toMatchObject({ value: '49.7%', hint: '승 29,426 · 패 29,729 · 기권 43,556' });
    expect(kpis['최근 히트']).toMatchObject({ value: '#498159' });
    const cards = section(m.page!.sections, /자산별/);
    if (!cards || cards.kind !== 'cards') throw new Error('no cards');
    expect(cards.items.map((c) => c.title)).toEqual(['BNB', 'BTC', 'ETH']);
    expect(cards.items[0]!.spark!.values).toEqual(bnb.values);
    expect(cards.items[0]!.rows.map((r) => [r.label, r.value])).toEqual([['7일 승률', '49.9%'], ['7일 누적', '−190.4 bp'], ['오늘', '−33.8 bp'], ['어제', '−156.6 bp']]);
    expect(cards.items[2]!.rows[3]).toMatchObject({ label: '어제', value: '−878.7 bp', status: 'bad' });
  });

  it('brain table joins the 30-day board with the 7-day DB record, sorted by 7-day bp, rule column wraps', async () => {
    const m = await collectUpdown(deps({ urls: ALL_OK }));
    const t = table(m.page!.sections, /브레인 성적/);
    expect(t.title).toBe('브레인 성적 (30일 보드 + 7일 DB)');
    expect(t.columns).toEqual(['이름', '규칙', 'n', '승률', '엣지', '등급', '연승', '7일 승/패', '7일 bp']);
    expect(t.wrap).toEqual([1]);
    expect(t.num).toEqual([2, 3, 4, 6, 7, 8]);
    expect(t.rows.map((r) => r[0])).toEqual(['Liquidation Hunter', 'Momentum Scalper', 'Always Up (대조군)']);
    expect(t.rows[0]).toEqual(['Liquidation Hunter', 'Fades a stretched move.', '5,000', '52%', '+1.5%p', '엣지', '7 / 최고 14', '825 / 808', '+3,906']);
    expect(t.rows[2]!.slice(3)).toEqual(['47.8%', '−2.7%p', '상실', '0 / 최고 21', '2,916 / 3,126', '−1,200.5']);
    expect(m.alerts.some((a) => /LOST/.test(a.text))).toBe(false); // the only LOST brain is the control
    expect(m.alerts).toContainEqual({ level: 'info', text: 'BNB 히트 #498158 무효', at: '2026-10-30T11:05:30.000Z' });
    const open = table(m.page!.sections, /열린 콜/);
    expect(open.rows).toEqual([['BNB', '#5977929', 'Always Up', '상승', '10-30 21:57', '오픈'], ['BTC', '#5977929', 'Liquidation Hunter', '하락', '10-30 21:57', '오픈']]);
    expect(open.note).toBe('상승 1 · 하락 1 · 기권 제외');
    const steps = section(m.page!.sections, /라운드 #5977929/);
    if (!steps || steps.kind !== 'steps') throw new Error('no steps');
    expect(steps.items.map((s) => [s.label, s.state])).toEqual([['오픈', 'done'], ['락', 'done'], ['종료', 'active'], ['정산', 'todo']]);
  });

  it('tunnel down (exec null): warn, DB sections replaced by the note, board sections still shown; no exec at all behaves the same', async () => {
    for (const d of [deps({ urls: ALL_OK, psql: null }), deps({ urls: ALL_OK, noExec: true })]) {
      const m = await collectUpdown(d);
      expect(m.state).toBe('warn');
      expect(m.alerts[0]).toMatchObject({ level: 'warn', text: 'DB 터널 끊김 · board API 만 표시' });
      expect(m.sources.find((s) => s.name === 'lab DB (psql)')).toMatchObject({ ok: false });
      expect(m.page!.headline).toBe('페이퍼 · DB 터널 끊김 · board API 만 표시 · 라운드 #5977927');
      expect(m.page!.decision).toContain('bbai-lab-tunnel.service 확인');
      const titles = m.page!.sections.map((s) => s.title);
      expect(titles).toEqual(['DB 기록', '브레인 성적 (30일 보드)', '환경']);
      expect(section(m.page!.sections, /DB 기록/)).toMatchObject({ kind: 'text', body: 'DB 터널 끊김 · board API 만 표시' });
      const t = table(m.page!.sections, /브레인 성적/);
      expect(t.rows).toHaveLength(3);
      expect(t.rows[0]![8]).toBe('—');
      expect(m.metrics).toMatchObject({ 'DB 터널': '끊김' });
      expect(Object.fromEntries(m.page!.kpis.map((k) => [k.label, k.value]))).toMatchObject({ '7일 승률': '—', '열린 콜': '—', '브레인': '3', '최근 라운드': '#5977927' });
    }
  });

  it('prod health and board both dead → down mode (staging alone is not enough); health dead but board alive stays a page', async () => {
    const down = await collectUpdown(deps({ urls: { updownStaging: HEALTH } }));
    expect(down).toMatchObject({ state: 'down', tag: 'PAPER', alerts: [{ level: 'bad', text: '응답 없음 · 연결 실패' }] });
    expect(down.sources).toHaveLength(4);
    const half = await collectUpdown(deps({ urls: { updownBoard: BOARD, updownStaging: HEALTH } }));
    expect(half.state).toBe('down');
    expect(half.alerts[0]).toMatchObject({ level: 'bad', text: '프로덕션 응답 없음 · 연결 실패' });
    expect(half.page!.decision).toBe('프로덕션 :3090 응답 없음 — 서비스 가동 여부 확인');
    expect(table(half.page!.sections, /최근 트레이드/).rows).toHaveLength(5);
    const dbDown = await collectUpdown(deps({ urls: { ...ALL_OK, updown: { ok: true, db: false, ts: NOW } } }));
    expect(dbDown.state).toBe('down');
    expect(dbDown.alerts[0]).toMatchObject({ level: 'bad', text: '앱 DB 연결 끊김' });
  });

  it('never leaks the connection string: no host, port, user, password, db name or @ anywhere in the mode', async () => {
    for (const d of [deps({ urls: ALL_OK }), deps({ urls: ALL_OK, psql: null }), deps({ urls: ALL_OK, psql: 'garbage\nno markers' }), deps({ urls: ALL_OK, env: 'DATABASE_URL=\n' }), deps({ urls: {} })]) {
      const text = JSON.stringify(await collectUpdown(d));
      for (const bad of ['15432', 'postgres', 'bbai_updown_lab', 'labuser', 's3cret', '@', 'DATABASE_URL', 'CRON_SECRET', 'zzz', HOME]) expect(text).not.toContain(bad);
    }
    const bad = await collectUpdown(deps({ urls: ALL_OK, psql: 'garbage\nno markers' }));
    expect(bad.sources.find((s) => s.name === 'lab DB (psql)')).toMatchObject({ ok: false, error: '응답 형식 오류' });
    const noEnv = await collectUpdown(deps({ urls: ALL_OK, env: null }));
    expect(noEnv.sources.find((s) => s.name === 'lab DB (psql)')).toMatchObject({ ok: false, error: '설정 없음' });
    expect(noEnv.state).toBe('warn');
  });

  it('slowCache: a second collect within 60 s reuses the psql answer (one exec per deps); after the TTL it runs again; a failure keeps the stale answer', async () => {
    let t = NOW; let fail = false;
    const d = deps({ urls: ALL_OK, now: () => t, psql: () => (fail ? null : psqlOut()) });
    await collectUpdown(d);
    await collectUpdown(d);
    expect(d.calls).toHaveLength(1);
    t += 59_000;
    await collectUpdown(d);
    expect(d.calls).toHaveLength(1);
    t += 2_000; fail = true;
    const stale = await collectUpdown(d);
    expect(d.calls).toHaveLength(2);
    expect(stale.state).toBe('warn');
    expect(stale.alerts.some((a) => /DB 터널 불안정/.test(a.text))).toBe(true);
    expect(table(stale.page!.sections, /최근 트레이드/).rows).toHaveLength(5);
    expect(deps({ urls: ALL_OK }).calls).toHaveLength(0); // a fresh deps object gets its own cache
  });

  it('helpers: parseDatabaseUrl (export, quotes, empty) and parsePsqlSections', () => {
    expect(parseDatabaseUrl(LAB_ENV)).toBe(DB_URL);
    expect(parseDatabaseUrl("DATABASE_URL='x'\n")).toBe('x');
    expect(parseDatabaseUrl('DATABASE_URL=\n')).toBeNull();
    expect(parseDatabaseUrl('OTHER=1\n')).toBeNull();
    const s = parsePsqlSections('noise\n__SEC_a\n1\t2\n\n__SEC_b\n__SEC_end\n');
    expect([...s.keys()]).toEqual(['a', 'b', 'end']);
    expect(s.get('a')).toEqual([['1', '2']]);
    expect(s.get('b')).toEqual([]);
  });
});
