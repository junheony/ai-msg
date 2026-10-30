/**
 * OPS · 펍덱: the RiseX printer fleet (main, sub1..3 via read-only systemd introspection), the ops dashboard's day/cost
 * figures and liquidity eligibility. Answers "which printers run, what today cost, is anything stopped on purpose?".
 */
import type { HubAlert, HubKpi, HubLink, HubMetricValue, HubMode, HubSection, HubState } from '../../shared/hub-types';
import { HUB_TIMEOUTS, HUB_URLS, STALLED_S, UNIT_STATE_KO, agoFrom, downMode, fmtAgo, fmtKst, fmtNum, fmtPct, fmtUsd, isObj, kpi, latestIso, num, objs, page, probe, sec, showUnit, sortAlerts, str, toIso, type HubDeps, type UnitInfo } from './shared';

export const OPS_ACCOUNTS = ['main', 'sub1', 'sub2', 'sub3'] as const;
export const PRINTER_UNITS: Record<(typeof OPS_ACCOUNTS)[number], string> = { main: 'risex-printer.service', sub1: 'risex-printer@sub1.service', sub2: 'risex-printer@sub2.service', sub3: 'risex-printer@sub3.service' };

/** Heartbeat age in seconds from whatever an account record offers (`heartbeat`, `heartbeat_at`, `heartbeat_age_s`, `last_seen`). */
function heartbeatAgeS(acct: Record<string, unknown>, nowMs: number): number | null {
  const age = num(acct.heartbeat_age_s ?? acct.heartbeat_age);
  if (age !== null) return age;
  const iso = toIso(acct.heartbeat ?? acct.heartbeat_at ?? acct.last_heartbeat ?? acct.last_seen ?? acct.ts);
  return iso ? Math.max(0, (nowMs - Date.parse(iso)) / 1000) : null;
}

const BUCKET_KO: Record<string, string> = { actual_fee: '수수료', spread_slippage: '스프레드·슬리피지', emergency_premium: '긴급 프리미엄', hold_period_pnl: '보유 손익', funding: '펀딩' };

export async function collectOps(deps: HubDeps): Promise<HubMode> {
  const links: HubLink[] = [{ label: '열기', href: '/hub/p/ops/', embed: true }];
  const [health, ops, ...units] = await Promise.all([
    probe(deps, '/api/health', HUB_URLS.opsHealth, HUB_TIMEOUTS.default), probe(deps, '/api/ops', HUB_URLS.ops, HUB_TIMEOUTS.ops),
    ...OPS_ACCOUNTS.map((a) => showUnit(deps, PRINTER_UNITS[a])),
  ]);
  const now = deps.now();
  const sources = [health.source, ops.source];
  const printers = OPS_ACCOUNTS.map((name, i) => ({ name, u: units[i] as UnitInfo }));
  const known = printers.filter((p) => p.u.active !== 'missing');
  if (known.length) sources.push({ name: 'systemd', ok: true, ms: 0 });
  if (!isObj(health.data) && !isObj(ops.data)) {
    const m = { ...downMode('ops', 'OPS · 펍덱', health.source, links), sources };
    if (known.length) {
      const up = known.filter((p) => p.u.active === 'active');
      m.page!.headline = `대시보드 응답 없음 · 프린터 ${up.map((p) => p.name).join('·') || '없음'} 가동`;
      m.page!.kpis = [kpi('가동 프린터', `${up.length}/${known.length}`, { status: up.length ? 'warn' : 'bad' })];
      m.page!.sections = [printerTable(printers, now)];
    }
    return m;
  }
  const h = isObj(health.data) ? health.data : null;
  const o = isObj(ops.data) ? ops.data : null;
  const alerts: HubAlert[] = [];
  const metrics: Record<string, HubMetricValue> = {};
  let state: HubState = h ? (h.ok === false ? 'warn' : 'ok') : 'warn';
  if (!h) alerts.push({ level: 'warn', text: '/api/health 응답 없음' });
  if (!o) alerts.push({ level: 'warn', text: `/api/ops 응답 없음 · ${ops.source.error ?? '오류'}` });
  if (h && h.vault_unlocked === false) alerts.push({ level: 'info', text: '볼트 잠김' });
  let lastActivity = toIso(h?.ts) ?? null;
  let vol: number | null = null, cost: number | null = null, cycles: number | null = null, bps: number | null = null, fillRate: number | null = null;
  let buckets: { label: string; value: number; text?: string }[] = [];
  let eligRows: string[][] = [];
  let serviceRows: [string, string][] = [];
  if (o) {
    lastActivity = latestIso(lastActivity, toIso(o.generated_at));
    const services = isObj(o.services) ? Object.entries(o.services) : [];
    const active = services.filter(([, v]) => v === 'active').length;
    if (services.length) metrics['서비스'] = `${active}/${services.length}`;
    serviceRows = services.map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 30) : String(v)]);
    const printer = services.find(([k]) => k === 'risex-printer');
    if (printer && printer[1] !== 'active') { alerts.push({ level: 'warn', text: `risex-printer ${String(printer[1]).slice(0, 20)}` }); state = 'warn'; }
    const watch = services.find(([k]) => k === 'standx-watch');
    if (watch && watch[1] !== 'active') alerts.push({ level: 'info', text: `standx-watch ${String(watch[1]).slice(0, 20)}` });
    const risex = isObj(o.risex) ? o.risex : {};
    const day = isObj(risex.day) ? risex.day : null;
    vol = num(day?.volume); if (vol !== null) metrics['오늘 거래량'] = fmtUsd(vol);
    cost = num(day?.cost); if (cost !== null) metrics['오늘 비용'] = fmtUsd(cost);
    cycles = num(day?.cycles); if (cycles !== null) metrics['사이클'] = cycles;
    bps = num(day?.bps);
    const c = isObj(risex.cost) ? risex.cost : null;
    if (c) {
      fillRate = num(c.maker_fill_rate);
      const b = isObj(c.buckets) ? c.buckets : {};
      buckets = Object.entries(b).filter((e): e is [string, Record<string, unknown>] => isObj(e[1])).map(([k, v]) => ({ k, usd: num(v.usd), bps: num(v.bps) })).filter((x) => x.usd !== null)
        .map((x) => ({ label: BUCKET_KO[x.k] ?? x.k, value: Math.abs(x.usd!), text: `${fmtUsd(x.usd!)}${x.bps !== null ? ` · ${fmtNum(x.bps, 1)} bps` : ''}` }));
      const top = buckets.slice().sort((a, b2) => b2.value - a.value)[0];
      if (top && top.value > 0) alerts.push({ level: 'info', text: `${num(c.days) ?? 7}일 최대 비용 버킷: ${top.label} ${top.text ?? ''}` });
    }
    const meas = isObj(o.measurements) ? o.measurements : {};
    eligRows = objs(meas.eligibility).slice(0, 40).map((r) => [str(r.symbol, 20) ?? '—', String(num(r.samples) ?? '—'), String(num(r.bid_ok) ?? '—'), String(num(r.ask_ok) ?? '—'), String(num(r.both) ?? '—'), num(r.minutes_per_hour) === null ? '—' : fmtNum(num(r.minutes_per_hour)!, 1), String(num(r.errors) ?? 0)]);
    // Per-account printers, when the dashboard lists them (`accounts` / `printers` / top-level main, sub1…).
    const table = isObj(o.accounts) ? o.accounts : isObj(o.printers) ? o.printers : o;
    let seen = 0;
    for (const name of OPS_ACCOUNTS) {
      const acct = table[name];
      if (!isObj(acct)) continue;
      seen++;
      const age = heartbeatAgeS(acct, now);
      const v = num(acct.volume ?? acct.volume_usd);
      const cc = num(acct.cost ?? acct.cost_usd);
      const parts = [v !== null ? fmtUsd(v) : null, cc !== null ? `비용 ${fmtUsd(cc)}` : null].filter(Boolean);
      if (age !== null && age > STALLED_S) {
        alerts.push({ level: 'warn', text: `${name} 하트비트 정지 · ${fmtAgo(age * 1000)}` });
        state = 'warn';
        metrics[name] = `정지${parts.length ? ' · ' + parts.join(' · ') : ''}`;
      } else {
        metrics[name] = parts.length ? parts.join(' · ') : age !== null ? `정상 · ${Math.round(age)}s` : '정상';
      }
    }
    if (seen === 0 && services.length === 0 && vol === null && known.length === 0) alerts.push({ level: 'info', text: '계정별 상태 없음' });
  }
  // systemd view of the fleet (authoritative for up/down when available).
  const up = known.filter((p) => p.u.active === 'active');
  const downP = known.filter((p) => p.u.active !== 'active');
  for (const p of downP) {
    const main = p.name === 'main';
    alerts.push({ level: main ? 'bad' : 'warn', text: `프린터 ${p.name} ${UNIT_STATE_KO[p.u.active]}${p.u.sub ? ` (${p.u.sub})` : ''}${p.u.since ? ` · ${agoFrom(p.u.since, now)}` : ''}` });
    state = main ? 'down' : state === 'down' ? 'down' : 'warn';
  }
  for (const p of up) if (p.u.restarts && p.u.restarts > 0) alerts.push({ level: 'info', text: `프린터 ${p.name} 재시작 ${p.u.restarts}회` });
  if (known.length) metrics['프린터'] = `${up.length}/${known.length}`;

  const mode = h ? str(h.mode, 20) : null;
  const headline = known.length
    ? `프린터 ${up.map((p) => p.name).join('·') || '없음'} 가동${downP.length ? `, ${downP.map((p) => p.name).join('·')} 정지` : ''}${vol !== null ? ` · 오늘 거래량 ${fmtUsd(vol)}` : ''}${cost !== null ? ` · 비용 ${fmtUsd(cost)}${bps !== null ? ` (${fmtNum(bps, 1)} bps)` : ''}` : ''}`
    : `${h ? (h.ok === false ? '대시보드 주의' : '대시보드 정상') : '헬스 응답 없음'}${vol !== null ? ` · 오늘 거래량 ${fmtUsd(vol)}` : ''}${cost !== null ? ` · 비용 ${fmtUsd(cost)}` : ''}${metrics['서비스'] ? ` · 서비스 ${String(metrics['서비스'])}` : ''}`;
  const decision = downP.some((p) => p.name === 'main') ? 'main 프린터 정지 — 즉시 확인' : downP.length ? `${downP.map((p) => p.name).join('·')} 정지 상태 — 의도된 것인지 확인` : known.length ? `${up.length}/${known.length} 가동 — 조치 없음` : !o ? '/api/ops 응답 없음 — 대시보드 확인' : state === 'ok' ? '조치 없음' : '주의 항목 확인';
  const kpis: HubKpi[] = [
    kpi('가동 프린터', known.length ? `${up.length}/${known.length}` : '—', { status: !known.length ? 'info' : downP.some((p) => p.name === 'main') ? 'bad' : downP.length ? 'warn' : 'ok' }),
    kpi('오늘 거래량', vol === null ? '—' : fmtUsd(vol)),
    kpi('오늘 비용', cost === null ? '—' : fmtUsd(cost), { status: cost === null ? 'info' : 'warn', ...(bps !== null ? { hint: `${fmtNum(bps, 1)} bps` } : {}) }),
    kpi('비용 bps', bps === null ? '—' : fmtNum(bps, 1)),
    kpi('메이커 체결률', fillRate === null ? '—' : fmtPct(fillRate <= 1 ? fillRate * 100 : fillRate), { hint: '최근 7일' }),
    kpi('사이클', cycles === null ? '—' : String(cycles)),
  ];
  const sections: HubSection[] = [printerTable(printers, now)];
  if (buckets.length) sections.push(sec.bars('7일 비용 버킷', buckets, { open: true, note: 'USD 절댓값 기준 막대 · 라벨에 부호 표시' }));
  if (serviceRows.length) sections.push(sec.kv('서비스', serviceRows));
  if (eligRows.length) sections.push(sec.table('유동성 적격', ['심볼', '표본', 'bid', 'ask', '둘 다', '분/시간', '오류'], eligRows, { num: [1, 2, 3, 4, 5, 6] }));
  if (h) sections.push(sec.kv('헬스', [['상태', h.ok === false ? '비정상' : '정상'], ['모드', mode ?? '—'], ['볼트', h.vault_unlocked === true ? '열림' : h.vault_unlocked === false ? '잠김' : '—'], ['헬스 시각', fmtKst(toIso(h.ts))]]));
  sections.push(sec.raw('원본 보기', '/hub/p/ops/', { embed: true, note: '읽기 전용 프록시 · 조작 버튼 비활성' }));
  return { id: 'ops', name: 'OPS · 펍덱', state, lastActivity, metrics, alerts: sortAlerts(alerts), links, sources, ...(mode ? { tag: mode.toUpperCase() } : {}), page: page(headline, decision, kpis, sections) };
}

function printerTable(printers: { name: string; u: UnitInfo }[], now: number): HubSection {
  const rows = printers.map((p) => [p.name, p.u.active === 'missing' ? '정보 없음' : `${UNIT_STATE_KO[p.u.active]}${p.u.sub ? ` (${p.u.sub})` : ''}`, p.u.since ? `${fmtKst(p.u.since)} · ${agoFrom(p.u.since, now)}` : '—', p.u.restarts === null ? '—' : String(p.u.restarts)]);
  return sec.table('프린터', ['프린터', '상태', '시작/정지', '재시작'], rows, { open: true, note: 'systemd --user 읽기 전용' });
}
