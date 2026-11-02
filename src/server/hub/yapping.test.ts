import { describe, expect, it, vi } from 'vitest';
import { collectYapping } from './yapping';
import { HUB_TIMEOUTS, HUB_URLS, type HubDeps } from './shared';
import { YAPPING_READ_SCRIPT } from './yapping-read';
import { yappingSourceSummary } from '../../shared/yapping';
import { risingFixture } from '../../../tests/fixtures/yapping-rising';
import { dailyFixture } from '../../../tests/fixtures/yapping-daily';

const NOW = Date.parse('2026-11-01T17:00:00Z'); // 02:00 KST, previous posting service day
function projection() {
  return { at: new Date(NOW).toISOString(), day: '2026-11-01', errors: [], caps: { breaking: 5, report: 2, total: 7, replies: 40 }, plan: { day: '2026-11-01', breaking: 5, report: 1, posted: 6, reserved: 1 }, replies: 11, followers: { at: new Date(NOW - 300_000).toISOString(), followers: 505, delta_since_last_run: 0 }, channel: 'blockschool', posts: [1, 2, 3, 4].map((n) => ({ tweet_id: String(n), posted_at: new Date(NOW - n * 60_000).toISOString(), text: `게시물 ${n}` })), mirrors: [1, 2, 3, 4].map((n) => ({ tg_message_id: String(n), tg_posted_at: new Date(NOW - n * 60_000).toISOString(), headline: `미러 ${n}` })) };
}
function deps(data: unknown = projection()) {
  let now = NOW;
  const exec = vi.fn(async () => data === null ? null : JSON.stringify(data));
  const fetchJson = vi.fn<(url: string, timeout: number) => Promise<unknown>>(async (url: string) => {
    if (url === HUB_URLS.yappingDaily) return dailyFixture();
    if (url === HUB_URLS.yappingRising) return risingFixture();
    throw new Error('Unexpected HTTP endpoint');
  });
  const d: HubDeps = { exec, fetchJson, latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null, readText: async () => null, readTail: async () => null, listDir: async () => null, fileMtime: async () => null, systemdShow: async () => ({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running' }), now: () => now, self: () => ({ uptimeMs: 0, sessions: 0, activeTurns: 0 }), host: 'test', home: '/home/test' };
  return { d, exec, fetchJson, advance: (ms: number) => { now += ms; } };
}
const kpi = (m: Awaited<ReturnType<typeof collectYapping>>, label: string) => m.page!.kpis.find((k) => k.label === label)!;

describe('auto-growth yapping collector', () => {
  it('keeps local counters and mode health when Rising times out', async () => {
    const { d, fetchJson } = deps();
    fetchJson.mockRejectedValue(new DOMException('private timeout detail', 'TimeoutError'));
    const m = await collectYapping(d);
    expect(m.state).toBe('ok');
    expect(kpi(m, '전체 게시').value).toBe('7 / 7');
    expect(m.rising).toMatchObject({ items: [], reason: '시간 초과' });
    expect(m.alerts).toEqual([]);
    expect(m.sources.find(source => source.name === '/api/rising')).toMatchObject({ ok: false, error: '시간 초과' });
  });
  it('shows real lane cap usage and midnight replies with 3 independent public X/TG links', async () => {
    const { d, exec, fetchJson } = deps();
    const m = await collectYapping(d);
    expect(m.state).toBe('ok');
    expect(kpi(m, '속보').value).toBe('5 / 5');
    expect(kpi(m, '리포트').value).toBe('1 / 2');
    expect(kpi(m, '전체 게시')).toMatchObject({ value: '7 / 7', hint: '완료 6 · 예약 1 (일반 QT 포함)' });
    expect(kpi(m, '답글').value).toBe('11 / 40');
    expect(kpi(m, '팔로워 변화')).toMatchObject({ value: '+5' });
    expect(kpi(m, '팔로워 변화').hint).toContain('7일 전 대비 +29');
    expect(kpi(m, '조회수 변화')).toMatchObject({ value: '+892' });
    expect(kpi(m, '조회수 변화').hint).toContain('7일 전 대비 +262');
    expect(kpi(m, '조회수 변화').hint).toContain('날짜별 원글 조회수 차이');
    expect(m.daily?.rows).toHaveLength(30);
    const [x, tg] = m.page!.sections;
    if (x?.kind !== 'table' || tg?.kind !== 'table') throw Error('missing feeds');
    expect(x.rows).toHaveLength(3); expect(tg.rows).toHaveLength(3);
    expect(x.rows[0]![2]).toBe('https://x.com/cblabx/status/1');
    expect(tg.rows[0]![2]).toBe('https://t.me/blockschool/1');
    expect(m.page!.sections.some((s) => /로테이션|초안/.test(s.title))).toBe(false);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(fetchJson).toHaveBeenCalledWith(HUB_URLS.yappingRising, HUB_TIMEOUTS.default);
    expect(fetchJson).toHaveBeenCalledWith(HUB_URLS.yappingDaily, HUB_TIMEOUTS.default);
    expect(exec).toHaveBeenCalledWith('python3', ['-c', YAPPING_READ_SCRIPT, '/home/test/yapping-bot', String(NOW)], { timeoutMs: 1800 });
    expect(JSON.stringify(m)).not.toContain('/home/test');
  });
  it('never conflates actual posted total with lane totals, flags cap overruns', async () => {
    const p = projection(); p.plan.posted = 8; p.plan.reserved = 0;
    const { d } = deps(p); const m = await collectYapping(d);
    expect(kpi(m, '전체 게시').value).toBe('8 / 7');
    expect(m.alerts).toContainEqual({ level: 'bad', text: '전체 게시 8건 · 현재 한도 7건 초과' });
  });
  it('missing projection is explicit and never throws or invents zero counts', async () => {
    const { d } = deps(null); const m = await collectYapping(d);
    expect(m.state).toBe('unknown');
    expect(m.page!.kpis.slice(0, 4).every((k) => k.value === '데이터 없음')).toBe(true);
    expect(kpi(m, '팔로워 변화').value).toBe('+5');
    expect(JSON.stringify(m)).not.toContain('—/—');
    expect(m.alerts).toEqual([]);
    expect(m.sources[0]!.ok).toBe(false);
  });
  it('caches for30s and keeps timestamped muted last-good values when transport fails', async () => {
    const { d, exec, advance } = deps();
    await collectYapping(d); await collectYapping(d);
    expect(exec).toHaveBeenCalledTimes(1);
    advance(31_000); exec.mockResolvedValueOnce(null);
    const m = await collectYapping(d);
    expect(kpi(m, '속보')).toMatchObject({ value: '5 / 5', status: 'info' });
    expect(kpi(m, '속보').hint).toContain('마지막 정상');
    expect(m.state).toBe('warn');
    expect(m.sources[0]!.ok).toBe(false);
  });
  it('does not reuse previous service day counts or previous calendar day reply counts', async () => {
    const { d, advance, exec } = deps(); await collectYapping(d);
    advance(26 * 3_600_000); exec.mockResolvedValueOnce(null);
    const m = await collectYapping(d);
    expect(kpi(m, '속보').value).toBe('데이터 없음');
    expect(kpi(m, '답글').value).toBe('데이터 없음');
  });
  it('uses daily follower observations instead of previous-run deltas and preserves real zeros', async () => {
    const { d, fetchJson } = deps();
    const rows = dailyFixture(); rows[29]!.followers = rows[28]!.followers; rows[29]!.views = 0;
    fetchJson.mockImplementation(async url => url === HUB_URLS.yappingDaily ? rows : risingFixture());
    const m = await collectYapping(d);
    expect(kpi(m, '팔로워 변화').value).toBe('0');
    expect(kpi(m, '조회수 변화').value).toBe('0');
    expect(kpi(m, '팔로워 변화').hint).toContain('오늘 − 어제');
  });
  it('null daily followers never become zero while independent views remain available', async () => {
    const { d, fetchJson } = deps();
    const rows = dailyFixture(); rows[29]!.followers = null;
    fetchJson.mockImplementation(async url => url === HUB_URLS.yappingDaily ? rows : risingFixture());
    const m = await collectYapping(d);
    expect(kpi(m, '팔로워 변화').value).toBe('데이터 없음');
    expect(kpi(m, '조회수 변화').value).toBe('+892');
  });
  it('daily timeout leaves local counters, Rising and mode health independent', async () => {
    const { d, fetchJson } = deps();
    fetchJson.mockImplementation(async url => {
      if (url === HUB_URLS.yappingDaily) throw new DOMException('private upstream', 'TimeoutError');
      return risingFixture();
    });
    const m = await collectYapping(d);
    expect(m.state).toBe('ok');
    expect(kpi(m, '전체 게시').value).toBe('7 / 7');
    expect(kpi(m, '팔로워 변화').value).toBe('데이터 없음');
    expect(kpi(m, '조회수 변화').value).toBe('데이터 없음');
    expect(m.rising?.items).toHaveLength(10);
    expect(m.daily).toEqual({ rows: [], reason: '시간 초과' });
    expect(m.sources.find(source => source.name === '/api/metrics/daily')).toMatchObject({ ok: false, error: '시간 초과' });
  });
  it('accepts numeric Telegram message ids without inventing links for malformed ids', async () => {
    const p = projection();
    const m = await collectYapping(deps({ ...p, mirrors: [{ tg_message_id: 123, tg_posted_at: p.at, headline: 'numeric mirror' }, { tg_message_id: 'not-an-id', tg_posted_at: p.at, headline: 'invalid' }] }).d);
    expect(m.page!.sections[1]).toMatchObject({ rows: [[p.at, 'numeric mirror', 'https://t.me/blockschool/123']] });
  });
  it('does not emit unsafe links or private Telegram destinations', async () => {
    const p = projection(); p.channel = '-100123'; p.posts[0]!.tweet_id = 'javascript:alert(1)';
    const m = await collectYapping(deps(p).d);
    expect(JSON.stringify(m)).not.toContain('javascript:');
    expect(JSON.stringify(m)).not.toContain('-100123');
    expect(m.page!.sections[1]).toMatchObject({ rows: [], note: '데이터 없음 · 공개 채널 또는 미러 게시 기록 없음' });
  });
  it('does not import bot code or use write-capable sqlite connection', () => {
    expect(YAPPING_READ_SCRIPT).toContain("+'?mode=ro'");
    expect(YAPPING_READ_SCRIPT).toContain('PRAGMA query_only=ON');
    expect(YAPPING_READ_SCRIPT).not.toMatch(/from app|import app|INSERT|UPDATE|DELETE|kv_set|autopilot/);
    expect(YAPPING_READ_SCRIPT).toContain("('qt_auto_plan',)");
  });
});

describe('collapsed source summary', () => {
  it('groups6/7 API timeouts once and keeps genuine data sources separate', () => {
    const sources = Array.from({ length: 7 }, (_, i) => ({ name: `/api/${i}`, ok: i === 6, ms: 3000, ...(i === 6 ? {} : { error: '시간 초과' }) }));
    expect(yappingSourceSummary([...sources, { name: 'systemd', ok: true, ms: 0 }])).toBe('야핑봇 API 응답 느림 (6/7)');
    expect(yappingSourceSummary([{ name: '기록', ok: false, ms: 0, error: '없음' }])).toBe('소스 확인 필요 (1/1)');
  });
});
