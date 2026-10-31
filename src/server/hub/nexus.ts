/**
 * NEXUS collector: the engine status (:8080 /api/status → health, risk, strategies) and, phase 3, the standalone
 * dashboard's home (:3005 /api/v2/home) ported read-only onto `mode.nexus` for the hub's own NexusHome view.
 * The home JSON is picked field by field (bounded arrays, scrubbed strings, hrefs rewritten onto the outside
 * dashboard); the dashboard's act/yes/no/cmd knobs never leave this file.
 */
import type { HubAlert, HubKpi, HubLink, HubMetricValue, HubMode, HubSection, HubSource, HubState, NexusAction, NexusBin, NexusHome, NexusListing, NexusOp, NexusScoreRow, NexusWalletRow } from '../../shared/hub-types';
import { DEFAULT_LINKS, HUB_TIMEOUTS, HUB_URLS, SLOW_CACHE_MS, agoFrom, arr, bool, downMode, fmtClock, fmtInt, fmtKst, fmtNum, fmtUsd, isObj, kpi, latestIso, num, objs, page, probe, scrub, sec, slowCache, sortAlerts, str, toIso, type HubDeps } from './shared';

const nameOf = (v: unknown): string | null => (typeof v === 'string' ? v : isObj(v) ? str(v.name ?? v.id ?? v.exchange ?? v.chain, 40) : null);

/* ───────── home (:3005 /api/v2/home) ───────── */

/** Array bounds for the home view (the live JSON is ~25 KB; the hub status is pushed to every client). */
export const NEXUS_LIMITS = { actions: 20, near: 20, ops: 20, recent: 20, feed: 30, coins: 15, score: 20, real: 20, bins: 200, halts: 20 } as const;

/** The dashboard's tabs (lib/v2/ia.ts): 지금 / 상장 / 갭 / 지갑 / 더보기 → outside links. */
const TAB_PATHS: [string, string][] = [['지금', '/'], ['상장', '/listing'], ['갭', '/arb'], ['지갑', '/coins'], ['더보기', '/alerts']];
const VKO: Record<string, string> = { bithumb: '빗썸', upbit: '업비트', coinone: '코인원', korbit: '코빗', binance: '바이낸스', bybit: '바이빗', okx: 'OKX', gate: '게이트', bitget: '비트겟', mexc: 'MEXC', htx: 'HTX', kucoin: '쿠코인' };
const HALT_KO: Record<string, string> = { paused: '입출금 중단', withdraw_only: '입금 중단', deposit_only: '출금 중단' };

/** `+1.31%` / `−0.50%` (the dashboard's `sgn`). */
const sgnPct = (v: number, d = 2): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`;

/** Only http(s) URLs or site-relative paths survive; a path is rewritten onto the outside dashboard. */
export function hrefOf(v: unknown, dash: string): string | null {
  const s = str(v, 300);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/') && !s.startsWith('//')) return `${dash}${s}`;
  return null;
}

/** Up to `n` mapped items, skipping the ones the mapper rejects. */
function take<T>(xs: unknown, n: number, f: (o: Record<string, unknown>) => T | null): T[] {
  const out: T[] = [];
  for (const o of objs(xs)) { if (out.length >= n) break; const v = f(o); if (v !== null) out.push(v); }
  return out;
}
const strs = (v: unknown, n: number, max = 40): string[] => arr(v).map((x) => scrub(x, max)).filter(Boolean).slice(0, n);

const actionOf = (o: Record<string, unknown>, dash: string): NexusAction | null => {
  const title = scrub(o.title, 200);
  if (!title) return null;
  const nums = arr(o.nums).slice(0, 8).map((n) => (isObj(n) ? `${scrub(n.k, 40)} ${scrub(n.v, 60)}`.trim() : scrub(n, 60))).filter(Boolean);
  return {
    id: scrub(o.id, 200) || title, kind: scrub(o.kind, 40), source: scrub(o.source, 40), verdict: scrub(o.verdict, 60), tone: scrub(o.tone, 20) || 'info',
    title, action: scrub(o.action, 200), href: hrefOf(o.href, dash), nums, detail: scrub(o.detail, 200),
    fold: o.fold === true ? 'fix' : typeof o.fold === 'string' ? scrub(o.fold, 40) || null : null,
  };
};
/** A near-miss gap (`inbox.near[]`: sym/buy/sell/gap_pct/net_pct/depth_usd/gate/why/route_why/suspect/since) in card shape. */
const nearOf = (o: Record<string, unknown>): NexusAction | null => {
  const sym = scrub(o.sym, 20);
  if (!sym) return null;
  const buy = scrub(o.buy, 20), sell = scrub(o.sell, 20);
  const nums: string[] = [];
  const gap = num(o.gap_pct); if (gap !== null) nums.push(`갭 ${sgnPct(gap)}`);
  const net = num(o.net_pct); nums.push(net !== null ? `순 ${sgnPct(net)}` : '순 모름');
  const depth = num(o.depth_usd); if (depth !== null) nums.push(`깊이 ${fmtUsd(depth)}`);
  const since = toIso(o.since);
  return {
    id: `near:${sym}:${buy}:${sell}`, kind: 'near', source: 'kr_gap', verdict: scrub(o.why, 60) || scrub(o.gate, 40), tone: o.suspect === true ? 'warn' : 'info',
    title: `${sym} ${VKO[buy] ?? buy}→${VKO[sell] ?? sell}`, action: scrub(o.route_why, 200), href: null, nums, detail: since ? `${fmtKst(since)}부터` : '', fold: null,
  };
};
const opOf = (o: Record<string, unknown>, dash: string): NexusOp | null => {
  const title = scrub(o.title, 200);
  if (!title) return null;
  // cmd / act / yes / no (the dashboard's decision knobs) are dropped on purpose: the hub is read-only.
  return { tone: scrub(o.tone, 20) || 'info', cat: scrub(o.cat, 40), title, detail: scrub(o.detail, 200), ts: toIso(o.ts), href: hrefOf(o.href, dash) };
};
const listingOf = (o: Record<string, unknown>): NexusListing | null => {
  const sym = scrub(o.sym, 20);
  if (!sym) return null;
  return { ex: scrub(o.ex, 20), sym, kind: scrub(o.kind, 40), network: scrub(o.network, 40), notice_ts: toIso(o.notice_ts), open_ts: toIso(o.open_ts), hedge_perp: typeof o.hedge_perp === 'boolean' ? (o.hedge_perp ? '가능' : '없음') : str(o.hedge_perp, 40), m10: num(o.m10), m30: num(o.m30) };
};
const flowOf = (o: Record<string, unknown>): NexusWalletRow | null => {
  const sym = scrub(o.sym, 20);
  if (!sym) return null;
  return { t: toIso(o.t), kind: scrub(o.kind, 20), who: scrub(o.who, 60), sym, usd: num(o.usd), venue: scrub(o.venue ?? o.dest, 40), kr: bool(o.kr) };
};
const scoreOf = (o: Record<string, unknown>): NexusScoreRow | null => {
  const name = scrub(o.name, 80);
  if (!name) return null;
  return { sig: scrub(o.key, 60), name, hit: num(o.hit), scored: num(o.scored), hit_pct: num(o.hit_pct), med_usd_1k: num(o.med_usd_1k), verdict: scrub(o.verdict, 40), policy: scrub(o.policy, 40) };
};
const binOf = (o: Record<string, unknown>): NexusBin | null => {
  const t = toIso(o.t);
  if (!t) return null;
  return { t, max: num(o.max), sym: str(o.sym, 20), buy: str(o.buy, 20), sell: str(o.sell, 20) };
};
/** `입출금 중단` entries ({ex, cur, state, since} or plain strings) as one label each. */
const haltOf = (h: unknown): string | null => {
  if (typeof h === 'string') return scrub(h, 80) || null;
  if (!isObj(h)) return null;
  const ex = scrub(h.ex, 20), cur = scrub(h.cur, 20);
  if (!ex && !cur) return null;
  const since = toIso(h.since);
  return `${VKO[ex] ?? ex} ${cur} ${HALT_KO[scrub(h.state, 20)] ?? '막힘'}${since ? ` ${fmtClock(since)}~` : ''}`.trim();
};
const best24Of = (v: unknown): string | null => {
  if (typeof v === 'string') return scrub(v, 120) || null;
  if (!isObj(v)) return null;
  const sym = scrub(v.sym, 20), net = num(v.net), ts = toIso(v.ts);
  if (!sym) return null;
  const buy = scrub(v.buy, 20), sell = scrub(v.sell, 20);
  return `${sym} ${VKO[buy] ?? buy}→${VKO[sell] ?? sell}${net !== null ? ` ${sgnPct(net)}` : ''}${ts ? ` · ${fmtKst(ts)}` : ''}`;
};
const count = (v: unknown): number | null => (Array.isArray(v) ? v.length : num(v));

/** The home JSON → `NexusHome`: explicit picks only, every string scrubbed, every array bounded, hrefs on the dashboard. */
export function mapNexusHome(d: Record<string, unknown>, dash: string): NexusHome {
  const inbox = isObj(d.inbox) ? d.inbox : {};
  const head = isObj(inbox.head) ? inbox.head : {};
  const funnel = isObj(inbox.funnel) ? inbox.funnel : {};
  const kr = isObj(d.kr) ? d.kr : {};
  const L = isObj(d.listing) ? d.listing : {};
  const M = isObj(d.market) ? d.market : {};
  const btc = isObj(M.btc) ? M.btc : {}, alt = isObj(M.alt) ? M.alt : {}, kimp = isObj(M.kimp) ? M.kimp : {};
  const P = isObj(d.peg) ? d.peg : {};
  const W = isObj(d.wallet) ? d.wallet : {};
  const S = isObj(d.score) ? d.score : {};
  const T = isObj(d.today) ? d.today : {};
  const B = isObj(d.band) ? d.band : {};
  const lateWhat = Array.isArray(d.late) ? strs(d.late, 10) : [];
  const market: NexusHome['market'] = { btc: { v: num(btc.v), px: num(btc.px) }, alt: { v: num(alt.v), n: num(alt.n) }, kimp: { v: num(kimp.v), n: num(kimp.n) }, pulse_age_s: num(M.pulse_age_s), blocked: bool(M.blocked) };
  if (isObj(M.blocked)) market.blocked_n = { upbit: num(M.blocked.upbit), bithumb: num(M.blocked.bithumb) };
  return {
    ts: toIso(d.ts) ?? toIso(inbox.ts),
    late: Array.isArray(d.late) ? lateWhat.length > 0 : d.late === true,
    ...(lateWhat.length ? { late_what: lateWhat } : {}),
    head: { armed_n: num(head.armed_n), kill: bool(head.kill), gap_age_s: num(head.gap_age_s), failed_nexus: num(head.failed_nexus), failed_all: num(head.failed_all) },
    actions: take(inbox.actions, NEXUS_LIMITS.actions, (o) => actionOf(o, dash)),
    near: take(inbox.near, NEXUS_LIMITS.near, nearOf),
    funnel: { total: num(funnel.total), route: num(funnel.route), ident: num(funnel.ident), depth: num(funnel.depth), net: num(funnel.net), pass: num(funnel.pass) },
    best_24h: best24Of(inbox.best_24h ?? d.best_24h),
    ops: take(inbox.ops ?? d.ops, NEXUS_LIMITS.ops, (o) => opOf(o, dash)),
    kr: { ok: bool(kr.ok), age_s: num(kr.age_s), fresh: bool(kr.fresh), min_net: num(kr.min_net), best_net: num(kr.best_net), best_sym: str(kr.best_sym, 20) },
    listing: { ok: bool(L.ok), age_s: num(L.age_s), n_seen: num(L.n_seen), upcoming: count(L.upcoming), pending: count(L.pending), recent: take(L.recent, NEXUS_LIMITS.recent, listingOf) },
    market,
    peg: { bank: num(P.bank), upbit_usdt: num(P.upbit_usdt), age_s: num(P.age_s), tprem: num(P.tprem) },
    halts: arr(d.halts).map(haltOf).filter((x): x is string => x !== null).slice(0, NEXUS_LIMITS.halts),
    flows: {
      ok: bool(W.ok), kol_ok: bool(W.kol_ok), kol_age_s: num(W.kol_age_s), persons24: num(W.persons24), usd24: num(W.usd24),
      feed: take(W.feed, NEXUS_LIMITS.feed, flowOf),
      coins: take(W.coins, NEXUS_LIMITS.coins, (c) => { const sym = scrub(c.sym, 20); return sym ? { sym, persons: num(c.persons), usd: num(c.usd) } : null; }),
      deposits_hidden_n: num(W.deposits_hidden_n), deposits_min_usd: num(W.deposits_min_usd),
    },
    score: { ok: bool(S.ok), age_s: num(S.age_s), rows: take(S.rows, NEXUS_LIMITS.score, scoreOf) },
    today: { real: take(T.real, NEXUS_LIMITS.real, (r) => { const sym = scrub(r.sym, 20); return sym ? { t: toIso(r.t), sym, route: scrub(r.route, 40), net1k: num(r.net1k), why: scrub(r.why, 200) } : null; }), armed_n: num(T.armed_n), day_start: toIso(T.day_start) },
    band: { t0: toIso(B.t0), t1: toIso(B.t1), now: toIso(B.now), bin_s: num(B.bin_s), bins: take(B.bins, NEXUS_LIMITS.bins, binOf), bins_age_s: num(B.bins_age_s) },
    tabs: TAB_PATHS.map(([label, path]) => ({ label, href: `${dash}${path}` })),
  };
}

type HomeProbe = { data: unknown; source: HubSource };
/** One 20 s cache per deps object (the live server has one; tests get a fresh one each). */
const homeCaches = new WeakMap<HubDeps, () => Promise<{ value: HomeProbe | null }>>();
function homeOf(deps: HubDeps): Promise<HomeProbe> {
  let get = homeCaches.get(deps);
  if (!get) { get = slowCache<HomeProbe>(SLOW_CACHE_MS.nexus, () => probe(deps, 'dashboard /api/v2/home', HUB_URLS.nexusHome, HUB_TIMEOUTS.default), deps.now); homeCaches.set(deps, get); }
  return get().then((r) => r.value ?? { data: null, source: { name: 'dashboard /api/v2/home', ok: false, ms: 0, error: '오류' } });
}

/* ───────── engine (:8080 /api/status) ───────── */

interface EngineView { running: boolean; tag: string; state: HubState; alerts: HubAlert[]; metrics: Record<string, HubMetricValue>; kpis: HubKpi[]; sections: HubSection[]; headline: string; decision: string; lastScan: string | null }

function engineView(data: Record<string, unknown>, now: number): EngineView {
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
  // Stalled scans: one alert for all of them (29 strategies made 29 rows before), the names in the hint, the oldest first.
  const stalled: { name: string; last: string }[] = [];
  for (const [name, s] of strategies) {
    if (s.running !== true) continue;
    const last = toIso(s.last_scan), iv = num(s.scan_interval);
    if (last && iv && now - Date.parse(last) > iv * 3 * 1000) stalled.push({ name, last });
  }
  if (stalled.length) {
    stalled.sort((a, b) => Date.parse(a.last) - Date.parse(b.last));
    const names = stalled.map((x) => x.name);
    alerts.push({ level: 'warn', text: stalled.length === 1 ? `${names[0]} 스캔 정체 · ${agoFrom(stalled[0]!.last, now)}` : `스캔 정체 ${stalled.length}개 전략 · 최대 ${agoFrom(stalled[0]!.last, now)}`, hint: stalled.length === 1 ? '전략 표에서 마지막 스캔 확인' : `${names.slice(0, 6).join(', ')}${names.length > 6 ? ` 외 ${names.length - 6}` : ''}` });
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
    kpi('전략 실행', `${live}/${strategies.length}`, { status: stalled.length ? 'warn' : live ? 'ok' : 'info', hint: stalled.length ? `스캔 정체 ${stalled.length}` : `활성 ${enabled}` }),
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
    sec.table('전략', ['전략', '활성', '실행', '스캔', '신호', '체결', '마지막 스캔', '포지션'], stratRows, { num: [3, 4, 5, 7], note: `실행 ${live} · 활성 ${enabled} · 전체 ${strategies.length}` }),
    sec.kv('리스크 · 킬스위치', riskRows),
    sec.kv('거래소 · 체인', [['거래소', exchanges.join(', ') || '—'], ['체인', chains.join(', ') || '—']]),
  ];
  return { running, tag, state, alerts, metrics, kpis, sections, headline, decision, lastScan };
}

/* ───────── the mode ───────── */

/** What the home adds to the page: alerts and two KPIs (`rows` = the one-line 요약 kept for the metrics/tests). */
function homeView(h: NexusHome, now: number): { alerts: HubAlert[]; rows: [string, string][]; kpis: HubKpi[]; nBad: number; firstBad: string | null } {
  const alerts: HubAlert[] = [];
  const bad = h.actions.filter((a) => a.tone === 'bad');
  const fix = h.actions.filter((a) => a.fold === 'fix');
  if (h.late) alerts.push({ level: 'warn', text: `대시보드 자료 지연${h.late_what?.length ? ` · ${h.late_what.join(', ')}` : ''}` });
  if (h.head.kill === true) alerts.push({ level: 'bad', text: 'KILL 스위치 활성' });
  if (h.head.failed_nexus !== null && h.head.failed_nexus > 0) alerts.push({ level: 'warn', text: `NEXUS 유닛 실패 ${h.head.failed_nexus}${h.head.failed_all !== null ? ` (전체 ${h.head.failed_all})` : ''}`, hint: '대시보드 운영 메모 확인' });
  if (h.kr.ok === false) alerts.push({ level: 'warn', text: '국내갭 자료 못 읽음' });
  else if (h.kr.fresh === false) alerts.push({ level: 'warn', text: `국내갭 자료 낡음${h.kr.age_s !== null ? ` · ${Math.round(h.kr.age_s / 60)}분 전` : ''}` });
  if (bad.length) alerts.push({ level: 'warn', text: `할 일 고장·알람 ${bad.length}건`, hint: bad[0]!.title });
  if (h.flows.ok === false) alerts.push({ level: 'warn', text: '지갑 원천 못 읽음' });
  if (h.score.ok === false) alerts.push({ level: 'warn', text: '신호 성적표 못 읽음' });
  const best = h.kr.best_net !== null ? `${sgnPct(h.kr.best_net)}${h.kr.best_sym ? ` ${h.kr.best_sym}` : ''}` : '—';
  const rows: [string, string][] = [
    ['자료 시각', h.ts ? `${fmtKst(h.ts)} · ${agoFrom(h.ts, now)}` : '—'],
    ['할 일', `${h.actions.length}건${bad.length ? ` · 고장·알람 ${bad.length}` : ''}${fix.length ? ` · 고칠 것 ${fix.length}` : ''}`],
    ['국내갭 최고', `${best}${h.kr.age_s !== null ? ` · ${Math.round(h.kr.age_s)}초 전` : ''}${h.kr.min_net !== null ? ` (실행 기준 ${h.kr.min_net}%)` : ''}`],
    ['24h 최고', h.best_24h ?? '—'],
    ['KOL 24h', h.flows.persons24 !== null ? `${h.flows.persons24}명${h.flows.usd24 !== null ? ` · ${fmtUsd(h.flows.usd24)}` : ''}` : '—'],
    ['상장 공지', `${h.listing.n_seen !== null ? `${fmtInt(h.listing.n_seen)}건 감시` : '—'} · 예정 ${h.listing.upcoming ?? 0} · 미정 ${h.listing.pending ?? 0}`],
    ['무장 · 유닛 실패', `${h.head.armed_n ?? '—'} · ${h.head.failed_nexus ?? '—'}${h.head.failed_all !== null ? `/${h.head.failed_all}` : ''}`],
  ];
  const kpis: HubKpi[] = [
    kpi('할 일', String(h.actions.length), { status: bad.length ? 'warn' : 'info', hint: bad.length ? `고장·알람 ${bad.length}` : fix.length ? `고칠 것 ${fix.length}` : '카드' }),
    kpi('국내갭 최고', best, { status: h.kr.fresh === false ? 'warn' : 'info', ...(h.kr.min_net !== null ? { hint: `실행 기준 ${h.kr.min_net}%` } : {}) }),
  ];
  return { alerts, rows, kpis, nBad: bad.length, firstBad: bad[0]?.title ?? null };
}

export async function collectNexus(deps: HubDeps): Promise<HubMode> {
  const dash = (deps.links?.nexus ?? DEFAULT_LINKS.nexus).replace(/\/+$/, '');
  const links: HubLink[] = [{ label: '대시보드', href: dash }];
  const [eng, home] = await Promise.all([probe(deps, 'engine /api/status', HUB_URLS.nexus, HUB_TIMEOUTS.default), homeOf(deps)]);
  const sources: HubSource[] = [eng.source, home.source];
  const nexus = isObj(home.data) ? mapNexusHome(home.data, dash) : undefined;
  if (!isObj(eng.data) && !nexus) { const m = downMode('nexus', 'NEXUS', eng.source, links); m.sources = sources; m.alerts.push({ level: 'warn', text: '대시보드 응답 없음' }); return m; }
  const now = deps.now();
  const E = isObj(eng.data) ? engineView(eng.data, now) : null;
  const H = nexus ? homeView(nexus, now) : null;

  const alerts: HubAlert[] = [...(E?.alerts ?? [{ level: 'bad', text: `엔진 응답 없음 · ${eng.source.error ?? '오류'}` }]), ...(H?.alerts ?? [{ level: 'warn', text: '대시보드 응답 없음' }])];
  const state: HubState = !E ? 'down' : E.state === 'down' ? 'down' : alerts.length ? 'warn' : 'ok';
  const headline = E ? `${E.headline}${nexus ? ` · 할 일 ${nexus.actions.length}` : ''}` : `엔진 응답 없음 · 할 일 ${nexus!.actions.length} · 국내갭 최고 ${nexus!.kr.best_net !== null ? sgnPct(nexus!.kr.best_net) : '—'}`;
  const decision = !E ? '엔진 응답 없음 — 서비스 가동 여부 확인' : E.running && H && H.nBad ? `할 일 고장·알람 ${H.nBad}건 확인 — ${H.firstBad}` : E.decision;
  // With the home shown (NexusHome), the KPI row stays short: the home's two, then the engine's four that the home does not say.
  const pick = (labels: string[]): HubKpi[] => labels.map((l) => E?.kpis.find((k) => k.label === l)).filter((k): k is HubKpi => !!k);
  const kpis: HubKpi[] = H ? [...H.kpis, ...pick(['전략 실행', '신호 / 체결', '일간 손익', '열린 포지션'])] : (E?.kpis.slice(0, 6) ?? []);
  // No 요약 kv: the home already says all of it (할 일, 국내갭, 24h, KOL, 상장, 유닛). Without the home, the engine page stands alone.
  const sections: HubSection[] = [
    ...(E?.sections ?? []),
    sec.raw('원본 대시보드', dash, { note: '외부 대시보드 (새 탭)' }),
  ];
  const metrics: Record<string, HubMetricValue> = { ...(E?.metrics ?? {}), ...(nexus ? { '할 일': nexus.actions.length } : {}) };
  return {
    id: 'nexus', name: 'NEXUS', state, lastActivity: E?.lastScan ?? nexus?.ts ?? new Date(now).toISOString(), metrics, alerts: sortAlerts(alerts), links, sources,
    ...(E ? { tag: E.tag } : {}), page: page(headline, decision, kpis, sections), ...(nexus ? { nexus } : {}),
  };
}
