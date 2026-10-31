/**
 * Trading Room bot (trading-status.service, :8830), read-only. `GET /api/status` (+ `/api/health`) is the source; when the
 * bot does not answer, the snapshot file it writes (~/trading-status/snapshot/trading_room_snapshot.json) stands in,
 * flagged, and flagged louder when older than 24 h. The three workstreams — 테이커 / 메이커 / 어댑티브 — are mapped to
 * three separate cards. Nothing is summed across them: :8830 reports no PnL and this file never invents one.
 */
import path from 'node:path';
import type { HubAlert, HubKpi, HubSource, HubState, TradingRoomView, TradingRow, TradingWorkstream } from '../../shared/hub-types';
import { HOUR_MS, HUB_TIMEOUTS, HUB_URLS, agoFrom, arr, fmtInt, fmtKst, fmtNum, isObj, kpi, num, probe, scrub, str, toIso, type HubDeps } from './shared';

export const SNAPSHOT_FILE = 'trading-status/snapshot/trading_room_snapshot.json';
/** The bot's own threshold (trading_status.py SNAP_STALE_H). */
export const SNAP_STALE_H = 24;
/** The pump-shadow heartbeat is written every poll; this long without one is a stall. */
const HEARTBEAT_WARN_S = 600;
const NO_PNL = 'PnL 미보고 · 워크스트림별 개별 표시, 합산 안 함';

const yes = (v: unknown): string => (v === true ? '예' : v === false ? '아니오' : '—');
const onOff = (v: unknown): string => (v === true ? '켜짐' : v === false ? '꺼짐' : '—');
const when = (v: unknown): string => fmtKst(toIso(v));
const count = (v: unknown): string => { const n = num(v); return n === null ? '—' : fmtInt(n); };

export interface RoomInput {
  /** `/api/status` JSON, or null when the bot did not answer. */
  status: Record<string, unknown> | null;
  /** The snapshot file's JSON, or null when missing/unreadable. */
  snapshot: Record<string, unknown> | null;
  /** Why `/api/status` failed (source error text). */
  statusError: string | null;
}

/* ───────── workstreams ───────── */

/** 테이커: DWF watch basket + the pump-shadow detector heartbeat. :8830 has no taker-specific PnL or fill metric. */
function taker(m: Record<string, unknown>, live: boolean): TradingWorkstream {
  const hb = num(m.shadow_heartbeat_age_s);
  const coins = arr(m.dwf_basket_coins).filter((c): c is string => typeof c === 'string').slice(0, 8).map((c) => scrub(c, 12));
  const rows: TradingRow[] = live ? [
    { label: 'DWF 바스켓 / 감시', value: `${count(m.dwf_basket_count)} / ${count(m.dwf_watch_total)}` },
    { label: '바스켓 코인', value: coins.length ? coins.join(' ') : '—' },
    { label: 'DWF 감시 갱신', value: when(m.dwf_watch_mtime) },
    { label: '섀도 하트비트', value: hb === null ? '—' : `${fmtNum(hb, 0)}s 전`, status: hb === null ? 'info' : hb > HEARTBEAT_WARN_S ? 'warn' : 'ok' },
  ] : [{ label: '테이커 지표', value: '스냅샷에 없음', status: 'info' }];
  const state: HubState = !live ? 'unknown' : hb === null ? 'unknown' : hb > HEARTBEAT_WARN_S ? 'warn' : 'ok';
  return { id: 'taker', label: '테이커', badge: 'DWF 감시 · 섀도', state, rows, pnl: null, pnlNote: NO_PNL, note: live ? '실포지션 없음 · 섀도 감지기만 가동' : '라이브 상태 없음 (:8830 응답 없음)' };
}

/** 메이커: dwf_maker_paper (+ the maker graft smoke run). Paper only; promotion flags are shown as the bot reports them. */
function maker(m: Record<string, unknown>, snap: Record<string, unknown> | null): TradingWorkstream {
  const sp = snap && isObj(snap.dwf_maker_paper) ? snap.dwf_maker_paper : null;
  const graft = snap && isObj(snap.maker_graft_smoke) ? snap.maker_graft_smoke : null;
  const enabled = typeof m.dwf_maker_paper_enabled === 'boolean' ? m.dwf_maker_paper_enabled : sp ? sp.enabled === true : null;
  const mode = str(m.dwf_maker_paper_mode, 20) ?? (sp ? str(sp.mode, 20) : null);
  const promo = typeof m.promotion_eligible === 'boolean' ? m.promotion_eligible : sp ? sp.promotion_eligible : null;
  const universe = num(m.maker_universe_count) ?? (sp ? arr(sp.symbols).length : null);
  const updated = m.maker_updated_at ?? sp?.updated_at;
  const graftRows = num(m.maker_graft_smoke_rows) ?? (graft ? num(graft.n_rows) : null);
  const graftPromo = typeof m.maker_graft_promotion_eligible === 'boolean' ? m.maker_graft_promotion_eligible : graft ? graft.promotion_eligible : null;
  const rows: TradingRow[] = [
    { label: '메이커 페이퍼', value: `${onOff(enabled)}${mode ? ` · ${scrub(mode, 20)}` : ''}`, status: enabled === true ? 'ok' : 'info' },
    { label: '승격 가능', value: yes(promo), status: promo === true ? 'ok' : 'info' },
    { label: '유니버스', value: universe === null ? '—' : `${fmtInt(universe)} 종목` },
    { label: '갱신', value: when(updated) },
    { label: '그래프트 스모크', value: `${graftRows === null ? '—' : `${fmtInt(graftRows)}행`} · 승격 ${yes(graftPromo)}` },
  ];
  if (graft && str(graft.maker_model)) rows.push({ label: '메이커 모델', value: scrub(graft.maker_model, 40) });
  const state: HubState = enabled === null ? 'unknown' : enabled ? 'ok' : 'idle';
  return { id: 'maker', label: '메이커', badge: mode && /live/i.test(mode) ? 'LIVE?' : 'PAPER', state, rows, pnl: null, pnlNote: NO_PNL, note: graft && str(graft.note) ? scrub(graft.note, 160) : '모의 호가 · 실주문 없음' };
}

/** 어댑티브: paper-only / live flags + the on-chain sell-alert feed. `adaptive_live` true is a red flag on a paper-only desk. */
function adaptive(m: Record<string, unknown>, snap: Record<string, unknown> | null): TradingWorkstream {
  const fr = snap && isObj(snap.adaptive_freeze) ? snap.adaptive_freeze : null;
  const oc = snap && isObj(snap.onchain_sell_alerts) ? snap.onchain_sell_alerts : null;
  const paperOnly = typeof m.adaptive_paper_only === 'boolean' ? m.adaptive_paper_only : fr ? fr.paper_only : null;
  const live = typeof m.adaptive_live === 'boolean' ? m.adaptive_live : fr ? fr.live : null;
  const alertsN = num(m.onchain_alerts_count) ?? (oc ? num(oc.count) : null);
  const lastAlert = m.last_onchain_alert_ts ?? oc?.last_ts;
  const rows: TradingRow[] = [
    { label: '페이퍼 전용', value: yes(paperOnly), status: paperOnly === true ? 'ok' : paperOnly === false ? 'warn' : 'info' },
    { label: '라이브', value: live === true ? '켜짐' : live === false ? '꺼짐' : '—', status: live === true ? 'bad' : live === false ? 'ok' : 'info' },
    { label: '온체인 매도 알림', value: alertsN === null ? '—' : fmtInt(alertsN) },
    { label: '마지막 알림', value: when(lastAlert) },
  ];
  if (fr) rows.push({ label: '동결 · 승격', value: `${yes(fr.freeze)} · ${yes(fr.promotion)}` }, { label: '온체인 피드', value: fr.onchain_feed_found === true ? '있음' : fr.onchain_feed_found === false ? '없음' : '—' });
  const state: HubState = live === true ? 'warn' : paperOnly === null && live === null ? 'unknown' : 'ok';
  return { id: 'adaptive', label: '어댑티브', badge: live === true ? 'LIVE' : 'PAPER', state, rows, pnl: null, pnlNote: NO_PNL, note: live === true ? '라이브 플래그 켜짐 — 페이퍼 전용 원칙과 어긋남, 확인 필요' : '온체인 알림은 매도 신호 피드일 뿐, 체결 아님' };
}

/* ───────── the view ───────── */

/** Pure: the live status (or the snapshot) → the room view. `nowMs` dates the snapshot. */
export function buildRoom(input: RoomInput, nowMs: number): TradingRoomView {
  const { status, snapshot } = input;
  const alerts: HubAlert[] = [];
  const m = status && isObj(status.metrics) ? status.metrics : {};
  if (status) {
    for (const a of arr(status.alerts).slice(0, 8)) {
      if (typeof a === 'string') alerts.push({ level: 'warn', text: scrub(a) });
      else if (isObj(a)) { const t = str(a.text) ?? str(a.msg); if (t) alerts.push({ level: a.level === 'error' || a.level === 'bad' ? 'bad' : a.level === 'info' ? 'info' : 'warn', text: scrub(t), at: toIso(a.at ?? a.ts) }); }
    }
  }
  const via: TradingRoomView['via'] = status ? 'live' : snapshot ? 'snapshot' : 'none';
  const generatedAt = status ? toIso(status.generated_at) : snapshot ? toIso(snapshot.snapshot_generated_at) : null;
  const ageH = generatedAt ? Math.max(0, nowMs - Date.parse(generatedAt)) / HOUR_MS : null;
  const stale = via === 'snapshot' && (ageH === null || ageH > SNAP_STALE_H);
  if (via === 'snapshot') alerts.unshift({ level: stale ? 'warn' : 'info', text: stale ? `:8830 응답 없음 — 스냅샷으로 대체 표시 · ${ageH === null ? '생성 시각 미상' : `${fmtNum(ageH, 1)}h 경과`} (${SNAP_STALE_H}h 초과, 오래됨)` : `:8830 응답 없음 — 스냅샷으로 대체 표시 · ${fmtNum(ageH ?? 0, 1)}h 경과`, at: generatedAt, hint: 'trading-status.service 응답 확인 (여기서는 읽기만)' });
  if (via === 'none') alerts.unshift({ level: 'warn', text: `:8830 응답 없음 · ${input.statusError ?? '오류'} — 스냅샷 파일도 없음`, hint: 'trading-status.service 와 스냅샷 경로 확인' });
  const botSnapshotAgeH = num(m.snapshot_age_h);
  const workstreams: TradingWorkstream[] = via === 'none'
    ? (['taker', 'maker', 'adaptive'] as const).map((id) => ({ id, label: id === 'taker' ? '테이커' : id === 'maker' ? '메이커' : '어댑티브', badge: '—', state: 'unknown' as HubState, rows: [{ label: '상태', value: '자료 없음', status: 'info' as const }], pnl: null, pnlNote: NO_PNL, note: ':8830 도 스냅샷도 없음' }))
    : [taker(m, via === 'live'), maker(m, snapshot), adaptive(m, snapshot)];
  const stateStr = status ? str(status.state, 10) : null;
  const kpis: HubKpi[] = [
    kpi('트레이딩룸 :8830', via === 'live' ? (stateStr ?? 'ok') : via === 'snapshot' ? '스냅샷' : '응답 없음', { status: via === 'live' ? (stateStr === 'ok' ? 'ok' : stateStr === 'down' ? 'bad' : 'warn') : via === 'snapshot' ? (stale ? 'warn' : 'info') : 'bad', hint: generatedAt ? `${via === 'live' ? '생성' : '스냅샷'} ${agoFrom(generatedAt, nowMs)}` : (input.statusError ?? '') }),
    kpi('워크스트림', `${workstreams.filter((w) => w.state === 'ok').length}/3 정상`, { status: workstreams.some((w) => w.state === 'warn') ? 'warn' : workstreams.every((w) => w.state === 'unknown') ? 'info' : 'ok', hint: '테이커 · 메이커 · 어댑티브 개별' }),
    kpi('온체인 알림', count(m.onchain_alerts_count ?? (snapshot && isObj(snapshot.onchain_sell_alerts) ? snapshot.onchain_sell_alerts.count : null)), { status: 'info', hint: `마지막 ${when(m.last_onchain_alert_ts ?? (snapshot && isObj(snapshot.onchain_sell_alerts) ? snapshot.onchain_sell_alerts.last_ts : null))}` }),
  ];
  return { via, error: status ? null : (input.statusError ?? null), state: stateStr, stage: status ? str(status.stage, 20) : null, generatedAt, ageH: ageH === null ? null : Math.round(ageH * 10) / 10, stale, botSnapshotAgeH, workstreams, alerts, kpis };
}

/* ───────── collector ───────── */

export interface RoomResult { view: TradingRoomView; /** The raw `/api/status` JSON (for the health rows the arbitrage page keeps). */ status: Record<string, unknown> | null; sources: HubSource[] }

export async function collectRoom(deps: HubDeps): Promise<RoomResult> {
  const file = path.join(deps.home, SNAPSHOT_FILE);
  const [st, health, snapText] = await Promise.all([
    probe(deps, 'trading /api/status', HUB_URLS.trading, HUB_TIMEOUTS.default),
    probe(deps, 'trading /api/health', HUB_URLS.tradingHealth, HUB_TIMEOUTS.default),
    deps.readText(file).catch(() => null),
  ]);
  const status = isObj(st.data) ? st.data : null;
  let snapshot: Record<string, unknown> | null = null;
  try { const j: unknown = snapText ? JSON.parse(snapText) : null; snapshot = isObj(j) ? j : null; } catch { snapshot = null; }
  const view = buildRoom({ status, snapshot, statusError: st.source.ok ? null : (st.source.error ?? '오류') }, deps.now());
  const healthOk = isObj(health.data) && health.data.ok === true;
  // the file's own age, whether or not it was needed this round, so a rotting fallback shows up while :8830 is still fine
  const snapAt = snapshot ? toIso(snapshot.snapshot_generated_at) : null;
  const snapStale = snapAt !== null && deps.now() - Date.parse(snapAt) > SNAP_STALE_H * HOUR_MS;
  const sources: HubSource[] = [
    st.source,
    { ...health.source, ok: health.source.ok && healthOk, ...(health.source.ok && !healthOk ? { error: 'ok=false' } : {}) },
    { name: 'trading snapshot', ok: snapshot !== null && !snapStale, ms: 0, ...(snapshot === null ? { error: '파일 없음' } : snapStale ? { error: `${SNAP_STALE_H}h 초과` } : {}) },
  ];
  return { view, status, sources };
}
