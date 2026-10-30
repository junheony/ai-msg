/**
 * MSG Hub status aggregator: reads every mode's state from localhost (GET only, per-source timeouts), read-only files
 * and `systemctl --user show`, never throws, and keeps the answer 15 s. Every collector picks explicit fields and
 * builds the mode's page (headline → decision → KPIs → attention → drill-down); nothing named like a secret leaves here.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HubAlert, HubKpi, HubMetricValue, HubMode, HubModeId, HubSection, HubSource, HubState, HubStatus } from '../../shared/hub-types';
import { HUB_MODE_IDS } from '../../shared/hub-types';
import { collectOps } from './ops';
import { collectQuant } from './quant';
import {
  DAY_MS, DEFAULT_LINKS, HOUR_MS, HUB_CACHE_MS, HUB_TIMEOUTS, HUB_URLS, SECRET_FIELD_RE, STALLED_S, SYSTEMD_PROPS, agoFrom, bool, downMode, errorText, fmtClock, fmtDuration, fmtInt, fmtKst, fmtNum, fmtUsd,
  isObj, kpi, latestIso, num, objs, page, probe, scrub, sec, sortAlerts, str, stripSecrets, toIso, type HubDeps, type HubSelf,
} from './shared';
import { collectGame, collectVideo } from './studios';
import { collectYapping } from './yapping';

export { DEFAULT_LINKS, HUB_CACHE_MS, HUB_TIMEOUTS, HUB_URLS, SECRET_FIELD_RE, errorText, fmtDuration, stripSecrets, toIso } from './shared';
export type { HubDeps, HubSelf } from './shared';

/* ───────── collectors: msg, nexus, trading, updown ───────── */

function collectMsg(deps: HubDeps): HubMode {
  const self = deps.self();
  const metrics: Record<string, HubMetricValue> = { '가동 시간': fmtDuration(self.uptimeMs) };
  if (self.sessions !== null) metrics['세션'] = self.sessions;
  if (self.activeTurns !== null) metrics['실행 중 턴'] = self.activeTurns;
  const turns = self.activeTurns ?? 0;
  const kpis: HubKpi[] = [
    kpi('가동 시간', fmtDuration(self.uptimeMs), { status: 'ok' }),
    kpi('세션', self.sessions === null ? '—' : String(self.sessions)),
    kpi('실행 중 턴', String(turns), { status: turns > 0 ? 'info' : 'ok' }),
    kpi('연결', '정상', { status: 'ok', hint: '이 서버' }),
  ];
  const headline = `가동 ${fmtDuration(self.uptimeMs)} · 세션 ${self.sessions ?? '—'} · 실행 중 턴 ${turns}`;
  const decision = turns > 0 ? `실행 중 턴 ${turns}개 — 터미널에서 진행 확인` : '대기 중 — 조치 없음';
  const sections: HubSection[] = [sec.kv('서버', [['호스트', deps.host], ['가동 시간', fmtDuration(self.uptimeMs)], ['세션', String(self.sessions ?? '—')], ['실행 중 턴', String(turns)]], { open: true })];
  return { id: 'msg', name: 'MSG 터미널', state: 'ok', lastActivity: new Date(deps.now()).toISOString(), metrics, alerts: [], links: [], sources: [{ name: 'self', ok: true, ms: 0 }], page: page(headline, decision, kpis, sections) };
}

const nameOf = (v: unknown): string | null => (typeof v === 'string' ? v : isObj(v) ? str(v.name ?? v.id ?? v.exchange ?? v.chain, 40) : null);

async function collectNexus(deps: HubDeps): Promise<HubMode> {
  const dash = deps.links?.nexus ?? DEFAULT_LINKS.nexus;
  const links = [{ label: '대시보드', href: dash }];
  const { data, source } = await probe(deps, 'engine /api/status', HUB_URLS.nexus, HUB_TIMEOUTS.default);
  if (!isObj(data)) return downMode('nexus', 'NEXUS', source, links);
  const now = deps.now();
  const running = data.running === true;
  const dry = data.dry_run === true;
  const tag = dry ? 'DRY RUN' : 'LIVE';
  const strategies = isObj(data.strategies) ? Object.entries(data.strategies).filter((e): e is [string, Record<string, unknown>] => isObj(e[1])) : [];
  const enabled = strategies.filter(([, s]) => s.enabled === true).length;
  const live = strategies.filter(([, s]) => s.running === true).length;
  let lastScan: string | null = null;
  let signals = 0, execs = 0, scans = 0;
  for (const [, s] of strategies) {
    lastScan = latestIso(lastScan, toIso(s.last_scan));
    signals += num(s.signal_count) ?? 0; execs += num(s.execution_count) ?? 0; scans += num(s.scan_count) ?? 0;
  }
  const risk = isObj(data.risk) ? data.risk : {};
  const ks = isObj(risk.kill_switches) ? risk.kill_switches : {};
  const lock = isObj(risk.triple_lock) ? risk.triple_lock : null;
  const alerts: HubAlert[] = [];
  if (!running) alerts.push({ level: 'bad', text: '엔진 정지됨' });
  if (risk.emergency_stop === true) alerts.push({ level: 'bad', text: '비상 정지 활성' });
  if (risk.cooldown_active === true) alerts.push({ level: 'warn', text: '쿨다운 중' });
  const pnlPct = num(risk.daily_pnl_pct), pnlThr = num(ks.daily_pnl_threshold_pct);
  if (pnlPct !== null && pnlThr !== null && pnlThr < 0 && pnlPct <= pnlThr * 0.7) alerts.push({ level: 'warn', text: `일간 손익 ${fmtNum(pnlPct)}% — 킬스위치 임계 ${fmtNum(pnlThr)}% 근접` });
  const coll = num(ks.current_collateral_ratio), minColl = num(ks.min_collateral_ratio);
  if (coll !== null && minColl !== null && coll < minColl * 1.3) alerts.push({ level: 'warn', text: `담보 비율 ${fmtNum(coll)} — 최소 ${fmtNum(minColl)} 근접` });
  for (const ex of objs(ks.blocked_exchanges).map(nameOf).concat((Array.isArray(ks.blocked_exchanges) ? ks.blocked_exchanges : []).filter((x): x is string => typeof x === 'string'))) if (ex) alerts.push({ level: 'warn', text: `거래소 차단: ${ex}` });
  const maxFails = num(ks.max_consecutive_fails);
  if (isObj(ks.consecutive_fails)) for (const [k, v] of Object.entries(ks.consecutive_fails)) { const n = num(v); if (n !== null && n > 0) alerts.push({ level: maxFails !== null && n >= maxFails * 0.6 ? 'bad' : 'warn', text: `${k} 연속 실패 ${n}${maxFails !== null ? `/${maxFails}` : ''}` }); }
  for (const [name, s] of strategies) {
    if (s.running !== true) continue;
    const last = toIso(s.last_scan), iv = num(s.scan_interval);
    if (last && iv && now - Date.parse(last) > iv * 3 * 1000) alerts.push({ level: 'warn', text: `${name} 스캔 정체 · ${agoFrom(last, now)}` });
  }
  const state: HubState = !running || risk.emergency_stop === true ? 'down' : alerts.length ? 'warn' : 'ok';
  const exchanges = (Array.isArray(data.exchanges) ? data.exchanges : []).map(nameOf).filter((x): x is string => x !== null);
  const chains = (Array.isArray(data.chains) ? data.chains : []).map(nameOf).filter((x): x is string => x !== null);
  const metrics: Record<string, HubMetricValue> = { '전략': `${live}/${enabled || strategies.length}`, '거래소': Array.isArray(data.exchanges) ? data.exchanges.length : null };
  const pos = num(risk.open_positions); if (pos !== null) metrics['열린 포지션'] = pos;
  const exp = num(risk.total_exposure_usd); if (exp !== null) metrics['노출'] = fmtUsd(exp);
  const pnl = num(risk.daily_pnl); if (pnl !== null) metrics['일간 손익'] = fmtUsd(pnl);

  const headline = `${tag} · 전략 ${strategies.length}개 중 실행 ${live} · 신호 ${fmtInt(signals)} · 체결 ${fmtInt(execs)}`;
  const decision = !running ? '엔진 정지 — 재시작 여부 결정' : lock ? (lock.live_ready === true ? '라이브 준비됨 — 확인 필요' : `라이브 차단: ${scrub(lock.blocker, 80) || '조건 미충족'}`) : '모니터링 — 조치 없음';
  const kpis: HubKpi[] = [
    kpi('일간 손익', pnl === null ? '—' : fmtUsd(pnl), { status: pnl === null ? 'info' : pnl < 0 ? 'warn' : 'ok', ...(pnlPct !== null ? { hint: `${fmtNum(pnlPct)}%` } : {}) }),
    kpi('노출', exp === null ? '—' : fmtUsd(exp), { ...(num(risk.current_capital) !== null ? { hint: `자본 ${fmtUsd(num(risk.current_capital)!)}` } : {}) }),
    kpi('열린 포지션', pos === null ? '—' : String(pos), { status: 'info' }),
    kpi('담보 비율', coll === null ? '—' : fmtNum(coll), { ...(minColl !== null ? { hint: `최소 ${fmtNum(minColl)}`, status: coll !== null && coll < minColl * 1.3 ? 'warn' : 'ok' } : {}) }),
    kpi('신호 / 체결', `${fmtInt(signals)} / ${fmtInt(execs)}`, { hint: `스캔 ${fmtInt(scans)}` }),
    kpi('거래소 · 체인', `${exchanges.length} · ${chains.length}`),
  ];
  const stratRows = strategies.map(([name, s]) => [name, s.enabled === true ? '예' : '아니오', s.running === true ? '실행' : '중지', fmtInt(num(s.scan_count) ?? 0), fmtInt(num(s.signal_count) ?? 0), fmtInt(num(s.execution_count) ?? 0), toIso(s.last_scan) ? agoFrom(toIso(s.last_scan), now) : '—', String(num(s.open_positions) ?? 0)]);
  stratRows.sort((a, b) => (a[2] === b[2] ? 0 : a[2] === '실행' ? -1 : 1));
  const riskRows: [string, string][] = [['비상 정지', risk.emergency_stop === true ? '활성' : '아니오'], ['쿨다운', risk.cooldown_active === true ? '진행 중' : '아니오'], ['일간 손익 임계', pnlThr === null ? '—' : `${fmtNum(pnlThr)}%`], ['최소 담보 비율', minColl === null ? '—' : fmtNum(minColl)], ['최대 연속 실패', maxFails === null ? '—' : String(maxFails)], ['손실 계수', num(risk.loss_factor) === null ? '—' : fmtNum(num(risk.loss_factor)!)]];
  if (lock) riskRows.push(['트리플 락', `ENABLED=${scrub(lock.ENABLED, 10) || '?'} · DRY_RUN=${scrub(lock.DRY_RUN, 10) || '?'} · LIVE_CONFIRM=${scrub(lock.LIVE_CONFIRM, 10) || '?'}`]);
  const sections: HubSection[] = [
    sec.table('전략', ['전략', '활성', '실행', '스캔', '신호', '체결', '마지막 스캔', '포지션'], stratRows, { open: true, num: [3, 4, 5, 7], note: `실행 ${live} · 활성 ${enabled} · 전체 ${strategies.length}` }),
    sec.kv('리스크 · 킬스위치', riskRows),
    sec.kv('거래소 · 체인', [['거래소', exchanges.join(', ') || '—'], ['체인', chains.join(', ') || '—']]),
    sec.raw('원본 대시보드', dash, { note: '외부 대시보드 (새 탭)' }),
  ];
  return { id: 'nexus', name: 'NEXUS', state, lastActivity: lastScan ?? new Date(now).toISOString(), metrics, alerts: sortAlerts(alerts), links, sources: [source], tag, page: page(headline, decision, kpis, sections) };
}

const TRADING_PICK: [string, string][] = [['dwf_basket_count', 'DWF 바스켓'], ['dwf_watch_total', '감시 종목'], ['shadow_heartbeat_age_s', '섀도 하트비트(s)'], ['onchain_alerts_count', '온체인 알림'], ['snapshot_age_h', '스냅샷 경과(h)'], ['promotion_eligible', '승격 가능']];

async function collectTrading(deps: HubDeps): Promise<HubMode> {
  const { data, source } = await probe(deps, 'trading /api/status', HUB_URLS.trading, HUB_TIMEOUTS.default);
  if (!isObj(data)) return downMode('trading', 'Trading Room', source);
  const now = deps.now();
  let state = (['ok', 'warn', 'down', 'idle', 'unknown'] as const).find((s) => s === data.state) ?? 'unknown';
  const m = isObj(data.metrics) ? data.metrics : {};
  const metrics: Record<string, HubMetricValue> = {};
  for (const [key, label] of TRADING_PICK) {
    const v = m[key];
    if (typeof v === 'number' || typeof v === 'boolean') metrics[label] = v;
  }
  if (Object.keys(metrics).length === 0) {
    for (const [k, v] of Object.entries(m)) {
      if (Object.keys(metrics).length >= 4) break;
      if (SECRET_FIELD_RE.test(k) || k.endsWith('_at') || k.endsWith('mtime')) continue;
      if (typeof v === 'number' || typeof v === 'boolean') metrics[k] = v;
    }
  }
  const alerts: HubAlert[] = [];
  if (Array.isArray(data.alerts)) {
    for (const a of data.alerts.slice(0, 5)) {
      if (typeof a === 'string') alerts.push({ level: 'warn', text: scrub(a) });
      else if (isObj(a) && typeof a.text === 'string') alerts.push({ level: a.level === 'bad' || a.level === 'info' ? a.level : 'warn', text: scrub(a.text), at: toIso(a.at ?? a.ts) });
    }
  }
  const hb = num(m.shadow_heartbeat_age_s), snapH = num(m.snapshot_age_h);
  if (hb !== null && hb > STALLED_S) { alerts.push({ level: 'warn', text: `섀도 하트비트 ${fmtDuration(hb * 1000)} 정체` }); if (state === 'ok') state = 'warn'; }
  if (snapH !== null && snapH > 24) { alerts.push({ level: 'warn', text: `스냅샷 ${fmtNum(snapH, 1)}h 경과` }); if (state === 'ok') state = 'warn'; }
  if (m.adaptive_live === false) alerts.push({ level: 'info', text: 'adaptive 는 paper 전용 (adaptive_live=false)' });
  const stage = str(data.stage, 20);
  const tag = stage ? stage.toUpperCase() : null;
  const sources: HubSource[] = [source];
  if (Array.isArray(data.sources)) sources.push({ name: `파일 ${data.sources.length}개`, ok: true, ms: 0 });
  const basket = num(m.dwf_basket_count), watch = num(m.dwf_watch_total), onchain = num(m.onchain_alerts_count);
  const lastOnchain = toIso(m.last_onchain_alert_ts);
  const promo = m.promotion_eligible === true, graft = m.maker_graft_promotion_eligible === true;
  const headline = `${tag ?? '단계 미상'} · 섀도 하트비트 ${hb === null ? '—' : `${fmtNum(hb, 0)}s`} · DWF 바스켓 ${basket ?? '—'} / 감시 ${watch ?? '—'}`;
  const promoList = [promo ? 'DWF 승격' : null, graft ? '메이커 그래프트 승격' : null].filter(Boolean).join(', ');
  const decision = promoList ? `승격 검토: ${promoList}` : `승격 가능 항목 없음 — ${stage ?? 'paper'} 유지`;
  const kpis: HubKpi[] = [
    kpi('섀도 하트비트', hb === null ? '—' : `${fmtNum(hb, 0)}s`, { status: hb === null ? 'info' : hb > STALLED_S ? 'warn' : 'ok' }),
    kpi('스냅샷 경과', snapH === null ? '—' : `${fmtNum(snapH, 1)}h`, { status: snapH === null ? 'info' : snapH > 24 ? 'warn' : 'ok', ...(toIso(m.snapshot_generated_at) ? { hint: fmtKst(toIso(m.snapshot_generated_at)) } : {}) }),
    kpi('DWF 바스켓', basket === null ? '—' : String(basket), { ...(watch !== null ? { hint: `감시 ${watch}` } : {}) }),
    kpi('온체인 알림', onchain === null ? '—' : fmtInt(onchain), { ...(lastOnchain ? { hint: `마지막 ${fmtKst(lastOnchain)}` } : {}) }),
    kpi('메이커 유니버스', num(m.maker_universe_count) === null ? '—' : fmtInt(num(m.maker_universe_count)!)),
    kpi('그래프트 스모크 행', num(m.maker_graft_smoke_rows) === null ? '—' : fmtInt(num(m.maker_graft_smoke_rows)!)),
  ];
  const coins = (Array.isArray(m.dwf_basket_coins) ? m.dwf_basket_coins : []).filter((c): c is string => typeof c === 'string').slice(0, 60);
  const flags: [string, string][] = [['DWF 승격 가능', promo ? '예' : '아니오'], ['메이커 그래프트 승격 가능', graft ? '예' : '아니오'], ['adaptive paper 전용', m.adaptive_paper_only === true ? '예' : m.adaptive_paper_only === false ? '아니오' : '—'], ['adaptive live', m.adaptive_live === true ? '예' : m.adaptive_live === false ? '아니오' : '—']];
  const rest: [string, string][] = [];
  for (const [k, v] of Object.entries(m)) {
    if (rest.length >= 30 || SECRET_FIELD_RE.test(k)) continue;
    if (typeof v === 'number') rest.push([k, fmtNum(v)]);
    else if (typeof v === 'boolean') rest.push([k, v ? '예' : '아니오']);
    else if (typeof v === 'string' && /_(at|ts)$/.test(k) && toIso(v)) rest.push([k, fmtKst(toIso(v))]);
  }
  const sections: HubSection[] = [
    sec.list('DWF 바스켓 코인', coins.map((c) => ({ text: c })), { open: true, note: `${coins.length}개` }),
    sec.kv('승격 · 플래그', flags, { open: true }),
    sec.kv('기타 지표', rest, { note: `소스 파일 ${Array.isArray(data.sources) ? data.sources.length : 0}개 · 운영 문서 ${num(m.ops_docs_count) ?? '—'}` }),
  ];
  return { id: 'trading', name: 'Trading Room', state, lastActivity: toIso(data.lastActivity) ?? toIso(data.generated_at), metrics, alerts: sortAlerts(alerts), links: [], sources, ...(tag ? { tag } : {}), page: page(headline, decision, kpis, sections) };
}

async function collectUpdown(deps: HubDeps): Promise<HubMode> {
  const [prod, staging] = await Promise.all([probe(deps, 'app :3090', HUB_URLS.updown, HUB_TIMEOUTS.default), probe(deps, 'staging :3198', HUB_URLS.updownStaging, HUB_TIMEOUTS.default)]);
  const sources = [prod.source, staging.source];
  const sData = isObj(staging.data) ? staging.data : null;
  const stagingText = sData ? (sData.ok === true ? (sData.db === false ? 'DB 끊김' : '정상') : '주의') : '응답 없음';
  if (!isObj(prod.data)) {
    const m = downMode('updown', 'UPDOWN', prod.source);
    m.metrics['스테이징'] = sData ? (sData.ok === true ? '정상' : '주의') : '응답 없음';
    m.page = page(`프로덕션 응답 없음 · 스테이징 ${stagingText}`, '프로덕션 :3090 응답 없음 — 서비스 가동 여부 확인', [kpi('앱', '응답 없음', { status: 'bad' }), kpi('스테이징', stagingText, { status: sData?.ok === true ? 'ok' : 'warn' })], [sec.kv('스테이징 :3198', [['상태', stagingText], ['응답', `${staging.source.ms} ms`]], { open: true })]);
    return { ...m, sources };
  }
  const p = prod.data;
  const alerts: HubAlert[] = [];
  const db = bool(p.db);
  let state: HubState = p.ok === true ? 'ok' : 'down';
  if (p.ok !== true) alerts.push({ level: 'bad', text: '앱 상태 비정상' });
  if (db === false) { alerts.push({ level: 'bad', text: 'DB 연결 끊김' }); state = 'down'; }
  if (!sData) { alerts.push({ level: 'warn', text: `스테이징 응답 없음 · ${staging.source.error ?? '오류'}` }); if (state === 'ok') state = 'warn'; }
  else if (sData.ok !== true || sData.db === false) { alerts.push({ level: 'warn', text: `스테이징 ${stagingText}` }); if (state === 'ok') state = 'warn'; }
  const metrics: Record<string, HubMetricValue> = { '앱': p.ok === true ? '정상' : '주의', 'DB': db === null ? '미확인' : db ? '연결됨' : '끊김', '스테이징': stagingText };
  const prodTs = toIso(p.ts), stTs = sData ? toIso(sData.ts) : null;
  const lastActivity = latestIso(prodTs, stTs) ?? new Date(deps.now()).toISOString();
  const headline = `프로덕션 ${p.ok === true ? '정상' : '비정상'} · DB ${db === null ? '미확인' : db ? '연결' : '끊김'} · 스테이징 ${stagingText}`;
  const decision = db === false ? 'DB 끊김 — 로그 확인' : p.ok !== true ? '앱 비정상 — 서비스 확인' : !sData ? '스테이징 응답 없음 — 필요 시 확인' : '조치 없음';
  const kpis: HubKpi[] = [
    kpi('앱', p.ok === true ? '정상' : '비정상', { status: p.ok === true ? 'ok' : 'bad' }),
    kpi('DB', db === null ? '미확인' : db ? '연결됨' : '끊김', { status: db === null ? 'info' : db ? 'ok' : 'bad' }),
    kpi('스테이징', stagingText, { status: sData?.ok === true && sData.db !== false ? 'ok' : 'warn' }),
    kpi('응답 prod', `${prod.source.ms} ms`, { status: prod.source.ms > 1000 ? 'warn' : 'ok' }),
    kpi('응답 staging', staging.source.ok ? `${staging.source.ms} ms` : '—'),
    kpi('마지막 헬스', fmtClock(prodTs), { ...(prodTs ? { hint: fmtKst(prodTs) } : {}) }),
  ];
  const envRows = (d: Record<string, unknown> | null, src: HubSource): [string, string][] => d
    ? [['상태', d.ok === true ? '정상' : '비정상'], ['DB', bool(d.db) === null ? '미확인' : d.db ? '연결됨' : '끊김'], ['헬스 시각', fmtKst(toIso(d.ts))], ['응답', `${src.ms} ms`]]
    : [['상태', `응답 없음 · ${src.error ?? '오류'}`], ['응답', `${src.ms} ms`]];
  const sections: HubSection[] = [sec.kv('프로덕션 :3090', envRows(p, prod.source), { open: true }), sec.kv('스테이징 :3198', envRows(sData, staging.source), { open: true })];
  return { id: 'updown', name: 'UPDOWN', state, lastActivity, metrics, alerts: sortAlerts(alerts), links: [], sources, page: page(headline, decision, kpis, sections) };
}

/* ───────── aggregate + cache ───────── */

const ORDER: HubModeId[] = [...HUB_MODE_IDS];
const NAMES: Record<HubModeId, string> = { msg: 'MSG 터미널', nexus: 'NEXUS', trading: 'Trading Room', video: '영상 스튜디오', game: '게임 스튜디오', ops: 'OPS · 펍덱', updown: 'UPDOWN', quant: 'QUANT', yapping: '야핑봇' };

/** One pass over every source. A collector that throws (it should not) becomes an `unknown` card; this never rejects. */
export async function collectHubStatus(deps: HubDeps): Promise<HubStatus> {
  const runs: Record<HubModeId, () => Promise<HubMode> | HubMode> = {
    msg: () => collectMsg(deps), nexus: () => collectNexus(deps), trading: () => collectTrading(deps), video: () => collectVideo(deps),
    game: () => collectGame(deps), ops: () => collectOps(deps), updown: () => collectUpdown(deps), quant: () => collectQuant(deps), yapping: () => collectYapping(deps),
  };
  const settled = await Promise.allSettled(ORDER.map(async (id) => runs[id]()));
  const modes = settled.map((r, i): HubMode => {
    const id = ORDER[i]!;
    if (r.status === 'fulfilled') return stripSecrets(r.value);
    const why = errorText(r.reason);
    return { id, name: NAMES[id], state: 'unknown', lastActivity: null, metrics: {}, alerts: [{ level: 'warn', text: `수집 실패 · ${why}` }], links: [], sources: [{ name: 'collector', ok: false, ms: 0, error: why }], page: { headline: `수집 실패 · ${why}`, decision: '서버 로그 확인', kpis: [], sections: [] } };
  });
  return { modes, host: deps.host, generated_at: new Date(deps.now()).toISOString() };
}

export interface HubStatusService { status(): Promise<HubStatus> }

/**
 * `status()` answers from the last pass for `cacheMs`; after that one refresh runs (shared by concurrent callers) while
 * the previous answer is still handed out, so a slow source never holds the page. The first call waits.
 */
export function createHubStatus(deps: HubDeps, { cacheMs = HUB_CACHE_MS }: { cacheMs?: number } = {}): HubStatusService {
  let cached: HubStatus | null = null;
  let cachedAt = 0;
  let inflight: Promise<HubStatus> | null = null;
  const refresh = (): Promise<HubStatus> => {
    inflight ??= collectHubStatus(deps).then((s) => { cached = s; cachedAt = deps.now(); return s; }).finally(() => { inflight = null; });
    return inflight;
  };
  return {
    status() {
      if (cached && deps.now() - cachedAt < cacheMs) return Promise.resolve(cached);
      const p = refresh();
      return cached ? Promise.resolve(cached) : p;
    },
  };
}

/* ───────── real-world deps ───────── */

export async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' }, redirect: 'manual' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

const RENDER_DIR_RE = /^(render|renders|output|outputs|out|export|exports|final)$/i;
const MEDIA_RE = /\.(mp4|mov|webm|mkv|m4v|mp3|wav|m4a|png|jpg|jpeg|gif)$/i;
const SKIP_DIR_RE = /^(node_modules|\.git|\.venv.*|venv|dist|__pycache__|\.cache)$/;

/** The newest media file inside a render/output folder, at most `maxDepth` deep and `maxEntries` entries visited. */
export async function latestRenderIn(root: string, { maxDepth = 6, maxEntries = 20_000 }: { maxDepth?: number; maxEntries?: number } = {}): Promise<{ mtimeMs: number; name: string } | null> {
  let best: { mtimeMs: number; name: string } | null = null;
  let visited = 0;
  const walk = async (dir: string, depth: number, inRender: boolean): Promise<void> => {
    if (depth > maxDepth || visited > maxEntries) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++visited > maxEntries) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR_RE.test(e.name)) await walk(p, depth + 1, inRender || RENDER_DIR_RE.test(e.name)); continue; }
      if (!inRender || !e.isFile() || !MEDIA_RE.test(e.name)) continue;
      try {
        const st = await fs.stat(p);
        if (!best || st.mtimeMs > best.mtimeMs) best = { mtimeMs: st.mtimeMs, name: e.name };
      } catch { /* vanished */ }
    }
  };
  await walk(root, 0, false);
  return best;
}

export function gitLastCommitIso(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'log', '-1', '--format=%cI'], { timeout: 3000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(toIso(stdout.trim()));
    });
  });
}

const UNIT_NAME_RE = /^[A-Za-z0-9:_.@-]+$/;

/** `systemctl --user show <unit>` (read-only introspection, 3 s budget). Null when systemd/systemctl is unavailable. */
export function systemdShowUser(unit: string): Promise<Record<string, string> | null> {
  if (!UNIT_NAME_RE.test(unit)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('systemctl', ['--user', 'show', unit, '--no-pager', '--timestamp=utc', '-p', SYSTEMD_PROPS.join(',')], { timeout: 3000, env: { ...process.env, SYSTEMD_PAGER: '', LC_ALL: 'C' } }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const out: Record<string, string> = {};
      for (const line of String(stdout).split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
      }
      resolve(Object.keys(out).length ? out : null);
    });
  });
}

/** The last `maxBytes` of a file as text; null when missing. */
export async function readTailOf(file: string, maxBytes: number): Promise<string | null> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; } finally { await fh?.close().catch(() => {}); }
}

/** Everything a live server needs; tests build their own `HubDeps`. */
export function liveHubDeps(opts: { home: string; host: string; self: () => HubSelf; links?: HubDeps['links'] }): HubDeps {
  return {
    fetchJson: fetchJsonWithTimeout,
    latestRender: (dir) => latestRenderIn(dir),
    countEntries: async (dir) => { try { return (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).length; } catch { return null; } },
    gitLastCommit: gitLastCommitIso,
    readText: async (file) => { try { return await fs.readFile(file, 'utf8'); } catch { return null; } },
    readTail: readTailOf,
    listDir: async (dir) => { try { return (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).sort(); } catch { return null; } },
    fileMtime: async (file) => { try { return (await fs.stat(file)).mtimeMs; } catch { return null; } },
    systemdShow: systemdShowUser,
    now: () => Date.now(),
    self: opts.self,
    host: opts.host,
    home: opts.home,
    ...(opts.links ? { links: opts.links } : {}),
  };
}

// Re-exported for collectors' tests that want the same clock helpers without importing shared directly.
export { DAY_MS, HOUR_MS };
