import { describe, expect, it } from 'vitest';
import { BOT_HOME, BOT_NOW, SNAPSHOT_8830, STATUS_8830 } from './__fixtures__/trading-bots';
import { HUB_URLS, type HubDeps } from './shared';
import { SNAP_STALE_H, SNAPSHOT_FILE, buildRoom, collectRoom } from './tradingRoom';

const noHome = (v: unknown): void => { const s = JSON.stringify(v); expect(s).not.toContain(BOT_HOME); expect(s).not.toMatch(/\/home\/[a-z]/); };
const H = 3_600_000;

describe('buildRoom', () => {
  it('maps the live /api/status to three separately labelled workstreams, each with its own (absent) PnL', () => {
    const v = buildRoom({ status: STATUS_8830, snapshot: null, statusError: null }, BOT_NOW);
    expect(v.via).toBe('live');
    expect(v.state).toBe('ok');
    expect(v.stage).toBe('paper');
    expect(v.generatedAt).toBe('2026-10-31T06:16:11.000Z');
    expect(v.stale).toBe(false);
    expect(v.botSnapshotAgeH).toBe(23.53);
    expect(v.workstreams.map((w) => `${w.id}:${w.label}:${w.state}:${w.badge}`)).toEqual(['taker:테이커:ok:DWF 감시 · 섀도', 'maker:메이커:ok:PAPER', 'adaptive:어댑티브:ok:PAPER']);
    const [taker, maker, adaptive] = v.workstreams;
    expect(taker!.rows.map((r) => r.value)).toEqual(['12 / 63', 'VELVET BICO ARIA FF', '10-20 14:51', '5s 전']);
    expect(maker!.rows.map((r) => [r.label, r.value])).toEqual([['메이커 페이퍼', '켜짐 · paper'], ['승격 가능', '아니오'], ['유니버스', '8 종목'], ['갱신', '10-28 03:18'], ['그래프트 스모크', '25행 · 승격 아니오']]);
    expect(adaptive!.rows.map((r) => [r.label, r.value, r.status])).toEqual([['페이퍼 전용', '예', 'ok'], ['라이브', '꺼짐', 'ok'], ['온체인 매도 알림', '1,113', undefined], ['마지막 알림', '10-31 15:09', undefined]]);
    // never summed: no workstream carries a PnL number, and the view has no total field at all
    expect(v.workstreams.map((w) => w.pnl)).toEqual([null, null, null]);
    expect(JSON.stringify(v)).not.toMatch(/total_pnl|pnl_sum|합계/);
    expect(v.alerts).toEqual([{ level: 'warn', text: '스냅샷 오래됨 …', at: '2026-10-31T06:16:06.000Z' }]);
    expect(v.kpis.map((k) => [k.label, k.value, k.status])).toEqual([['트레이딩룸 :8830', 'ok', 'ok'], ['워크스트림', '3/3 정상', 'ok'], ['온체인 알림', '1,113', 'info']]);
    noHome(v);
  });
  it('warns on a stalled shadow heartbeat and on adaptive_live=true, and badges an unknown taker when the heartbeat is missing', () => {
    const m = { ...STATUS_8830.metrics, shadow_heartbeat_age_s: 1200, adaptive_live: true, adaptive_paper_only: false };
    const v = buildRoom({ status: { ...STATUS_8830, metrics: m }, snapshot: null, statusError: null }, BOT_NOW);
    expect(v.workstreams.map((w) => w.state)).toEqual(['warn', 'ok', 'warn']);
    expect(v.workstreams[2]!.badge).toBe('LIVE');
    expect(v.workstreams[2]!.rows[1]).toEqual({ label: '라이브', value: '켜짐', status: 'bad' });
    expect(v.kpis[1]).toMatchObject({ value: '1/3 정상', status: 'warn' });
    const { shadow_heartbeat_age_s: _, ...noHb } = STATUS_8830.metrics;
    expect(buildRoom({ status: { ...STATUS_8830, metrics: noHb }, snapshot: null, statusError: null }, BOT_NOW).workstreams[0]!.state).toBe('unknown');
  });
  it('uses the snapshot when :8830 is silent: fresh → info note, older than 24h → stale warn; taker has no snapshot data', () => {
    const at = Date.parse('2026-10-30T06:44:35Z');
    const fresh = buildRoom({ status: null, snapshot: SNAPSHOT_8830, statusError: '연결 실패' }, at + 2 * H);
    expect(fresh.via).toBe('snapshot');
    expect(fresh.error).toBe('연결 실패');
    expect(fresh.ageH).toBe(2);
    expect(fresh.stale).toBe(false);
    expect(fresh.alerts[0]).toMatchObject({ level: 'info', text: ':8830 응답 없음 — 스냅샷으로 대체 표시 · 2h 경과', at: '2026-10-30T06:44:35.000Z' });
    expect(fresh.workstreams[0]!.rows).toEqual([{ label: '테이커 지표', value: '스냅샷에 없음', status: 'info' }]);
    expect(fresh.workstreams[0]!.state).toBe('unknown');
    expect(fresh.workstreams[1]!.rows.map((r) => r.value)).toEqual(['켜짐 · paper', '아니오', '3 종목', '10-28 03:18', '25행 · 승격 아니오', 'graft-v1']);
    expect(fresh.workstreams[1]!.note).toBe('스모크만 (…)');
    expect(fresh.workstreams[2]!.rows.map((r) => r.value)).toEqual(['예', '꺼짐', '1,100', '10-30 15:09', '예 · 아니오', '있음']);
    expect(fresh.kpis[0]).toMatchObject({ value: '스냅샷', status: 'info' });
    const stale = buildRoom({ status: null, snapshot: SNAPSHOT_8830, statusError: '시간 초과' }, at + (SNAP_STALE_H + 0.5) * H);
    expect(stale.stale).toBe(true);
    expect(stale.ageH).toBe(24.5);
    expect(stale.alerts[0]).toMatchObject({ level: 'warn', text: ':8830 응답 없음 — 스냅샷으로 대체 표시 · 24.5h 경과 (24h 초과, 오래됨)' });
    expect(stale.kpis[0]).toMatchObject({ value: '스냅샷', status: 'warn' });
    noHome(fresh); noHome(stale);
  });
  it('is `none` with unknown workstreams when neither the bot nor the snapshot is there', () => {
    const v = buildRoom({ status: null, snapshot: null, statusError: '연결 실패' }, BOT_NOW);
    expect(v.via).toBe('none');
    expect(v.workstreams.map((w) => [w.label, w.state])).toEqual([['테이커', 'unknown'], ['메이커', 'unknown'], ['어댑티브', 'unknown']]);
    expect(v.alerts[0]).toMatchObject({ level: 'warn', text: ':8830 응답 없음 · 연결 실패 — 스냅샷 파일도 없음' });
    expect(v.kpis[0]).toMatchObject({ value: '응답 없음', status: 'bad' });
  });
});

describe('collectRoom', () => {
  const deps = (urls: Record<string, unknown>, files: Record<string, string> = {}): HubDeps => ({
    fetchJson: async (url) => { if (url in urls) return urls[url]; throw new Error('fetch failed: ECONNREFUSED'); },
    latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null,
    readText: async (f) => files[f.replace(`${BOT_HOME}/`, '')] ?? null, readTail: async () => null, listDir: async () => null, fileMtime: async () => null, systemdShow: async () => null,
    now: () => BOT_NOW, self: () => ({ uptimeMs: 1, sessions: 0, activeTurns: 0 }), host: 'h', home: BOT_HOME,
  });
  it('probes status + health and reads the snapshot under home, reporting three sources', async () => {
    const r = await collectRoom(deps({ [HUB_URLS.trading]: STATUS_8830, [HUB_URLS.tradingHealth]: { ok: true } }, { [SNAPSHOT_FILE]: JSON.stringify(SNAPSHOT_8830) }));
    expect(r.view.via).toBe('live');
    expect(r.status).toBe(STATUS_8830);
    expect(r.sources.map((s) => [s.name, s.ok])).toEqual([['trading /api/status', true], ['trading /api/health', true], ['trading snapshot', true]]); // snapshot is 23.5h old at BOT_NOW: still fresh
    const later = await collectRoom({ ...deps({ [HUB_URLS.trading]: STATUS_8830 }, { [SNAPSHOT_FILE]: JSON.stringify(SNAPSHOT_8830) }), now: () => BOT_NOW + 3 * H });
    expect(later.sources[2]).toMatchObject({ name: 'trading snapshot', ok: false, error: '24h 초과' });
  });
  it('marks health ok=false and a broken snapshot file as source errors', async () => {
    const r = await collectRoom(deps({ [HUB_URLS.tradingHealth]: { ok: false } }, { [SNAPSHOT_FILE]: '{not json' }));
    expect(r.view.via).toBe('none');
    expect(r.sources.map((s) => [s.name, s.ok, s.error])).toEqual([['trading /api/status', false, '연결 실패'], ['trading /api/health', false, 'ok=false'], ['trading snapshot', false, '파일 없음']]);
  });
});
