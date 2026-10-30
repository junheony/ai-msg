/**
 * QUANT: derives the current question — finding IOC orders across the 빗썸 RE accounts — from the qa_dash snapshot:
 * IOC share per account, guard effectiveness, markout/PnL, broken tiles and what to look at next. Raw tabs stay as
 * collapsed drill-down; `_src`/`src` records (paths) are never copied.
 */
import type { HubAlert, HubKpi, HubLevel, HubMetricValue, HubMode, HubSection, HubState } from '../../shared/hub-types';
import { DAY_MS, HUB_TIMEOUTS, HUB_URLS, agoFrom, downMode, fmtAgo, fmtInt, fmtKrw, fmtKst, fmtNum, isObj, kpi, num, objs, page, probe, scrub, sec, sortAlerts, str, toIso, type HubDeps } from './shared';

interface Tile { label: string; value: unknown; unit: string; fmt: string; status: string; note: string }
interface Section { id: string; title: string; kind: string; asof: string | null; note: string; items: Tile[]; columns: { key: string; label: string; fmt: string }[]; rows: Record<string, unknown>[]; x: string[]; series: { name: string; values: (number | null)[] }[]; unit: string; body: string }
interface Tab { tab: string; title: string; sections: Section[] }

const STALE_ASOF_DAYS = 7;

function parseSnapshot(data: Record<string, unknown>): Tab[] {
  return objs(data.tabs).map((t) => ({
    tab: str(t.tab, 40) ?? '?', title: scrub(t.title, 80) || '?',
    sections: objs(t.sections).map((s): Section => ({
      id: str(s.id, 60) ?? '?', title: scrub(s.title, 100) || '?', kind: str(s.kind, 20) ?? 'text', asof: toIso(s.asof), note: scrub(s.note, 200),
      items: objs(s.items).map((it) => ({ label: scrub(it.label, 80), value: it.value, unit: str(it.unit, 10) ?? '', fmt: str(it.fmt, 10) ?? '', status: str(it.status, 10) ?? '', note: scrub(it.note, 160) })),
      columns: Array.isArray(s.columns) ? s.columns.map((c) => (isObj(c) ? { key: str(c.key, 40) ?? '', label: scrub(c.label, 40) || str(c.key, 40) || '', fmt: str(c.fmt, 10) ?? '' } : { key: String(c), label: String(c), fmt: '' })) : [],
      rows: objs(s.rows), x: Array.isArray(s.x) ? s.x.map((v) => scrub(v, 30)) : [], unit: str(s.unit, 10) ?? '',
      series: objs(s.series).map((se) => ({ name: scrub(se.name, 40), values: Array.isArray(se.values) ? se.values.map((v) => num(v)) : [] })),
      body: scrub(s.body, 1200),
    })),
  }));
}

/** A tile/cell value rendered by its declared format. */
export function fmtVal(v: unknown, fmt: string, unit = ''): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return scrub(v, 60);
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  switch (fmt) {
    case 'krw': return fmtKrw(v);
    case 'pct': return `${fmtNum(v, 2)}%`;
    case 'bp': return `${fmtNum(v, 2)} bp`;
    case 'ms': return `${fmtNum(v, 0)} ms`;
    case 'int': return fmtInt(v);
    default: return unit ? `${fmtNum(v, 2)} ${unit}` : fmtNum(v, 2);
  }
}
const tileText = (t: Tile): string => fmtVal(t.value, t.fmt, t.unit);
const levelOf = (status: string): HubLevel | 'ok' | null => (status === 'bad' ? 'bad' : status === 'warn' ? 'warn' : status === 'ok' ? 'ok' : null);

function tableSection(s: Section, o: { open?: boolean } = {}): HubSection {
  const cols = s.columns.filter((c) => c.key && !c.key.startsWith('_'));
  const rows = s.rows.slice(0, 60).map((r) => cols.map((c) => fmtVal(r[c.key], c.fmt)));
  const numIdx = cols.map((c, i) => (['krw', 'pct', 'bp', 'ms', 'int', 'num'].includes(c.fmt) ? i : -1)).filter((i) => i >= 0);
  return sec.table(s.title, cols.map((c) => c.label), rows, { note: [s.note, s.asof ? `기준 ${fmtKst(s.asof)}` : ''].filter(Boolean).join(' · '), num: numIdx, ...o });
}
function sectionToHub(s: Section): HubSection | null {
  const note = [s.note, s.asof ? `기준 ${fmtKst(s.asof)}` : ''].filter(Boolean).join(' · ');
  switch (s.kind) {
    case 'tiles': return sec.kv(s.title, s.items.map((t): [string, string] => [t.label, `${tileText(t)}${t.status === 'bad' ? ' ⚠' : ''}`]), { note });
    case 'table': return tableSection(s);
    case 'bars': { const se = s.series[0]; if (!se) return null; return sec.bars(s.title, s.x.map((x, i) => ({ label: x, value: Math.abs(se.values[i] ?? 0), text: `${fmtNum(se.values[i] ?? 0, 2)} ${s.unit}`.trim() })), { note }); }
    case 'line': return sec.table(s.title, ['구간', ...s.series.map((se) => `${se.name}${s.unit ? ` (${s.unit})` : ''}`)], s.x.map((x, i) => [x, ...s.series.map((se) => (se.values[i] === null || se.values[i] === undefined ? '—' : fmtNum(se.values[i]!, 2)))]), { note, num: s.series.map((_, i) => i + 1) });
    case 'text': return sec.text(s.title, s.body || '—', { note });
    default: return null;
  }
}

export async function collectQuant(deps: HubDeps): Promise<HubMode> {
  const links = [{ label: '열기', href: '/hub/p/quant/', embed: true }];
  const { data, source } = await probe(deps, 'snapshot.json', HUB_URLS.quant, HUB_TIMEOUTS.default);
  if (!isObj(data)) return downMode('quant', 'QUANT', source, links);
  const now = deps.now();
  const tabs = parseSnapshot(data);
  const all = tabs.flatMap((t) => t.sections.map((s) => ({ t, s })));
  let tiles = 0, warn = 0, bad = 0;
  const broken: { text: string; level: HubLevel; hint?: string }[] = [];
  for (const { t, s } of all) for (const it of s.items) {
    tiles++;
    if (it.status === 'warn') warn++;
    else if (it.status === 'bad') bad++;
    if (it.status === 'warn' || it.status === 'bad') broken.push({ level: it.status, text: `${t.title} › ${s.title} · ${it.label} = ${tileText(it)}`, ...(it.note ? { hint: it.note } : {}) });
  }
  const errors = (Array.isArray(data.errors) ? data.errors : []).filter((e): e is string => typeof e === 'string').slice(0, 5).map((e) => scrub(e));
  const alerts: HubAlert[] = errors.map((e) => ({ level: 'warn' as const, text: e }));
  if (bad > 0) alerts.push({ level: 'bad', text: `타일 ${bad}개 장애` });
  const lastActivity = toIso(data.generated_at);
  const age = lastActivity ? now - Date.parse(lastActivity) : null;
  if (age !== null && age > DAY_MS) alerts.push({ level: 'warn', text: `스냅샷 ${fmtAgo(age)} 생성` });
  const state: HubState = bad > 0 || errors.length > 0 ? 'warn' : age !== null && age > DAY_MS ? 'idle' : age === null ? 'unknown' : 'ok';
  const metrics: Record<string, HubMetricValue> = { '탭': tabs.length, '타일': tiles, '주의 타일': warn + bad };
  if (age !== null) metrics['생성'] = fmtAgo(age);

  // ── IOC finding (re tab) ──
  const re = tabs.find((t) => t.tab === 're');
  const acctTable = re?.sections.find((s) => s.id === 'acct_metrics' || (s.kind === 'table' && s.columns.some((c) => c.key === 'ioc')));
  const iocTiles = (re?.sections ?? []).filter((s) => s.kind === 'tiles' && s.id.startsWith('tiles_'));
  interface Acct { acct: string; orders: number | null; cancel: number | null; ioc: number | null; symbols: number | null; filled: number | null; makerBp: number | null; iocStatus: string; iocNote: string }
  const accts: Acct[] = [];
  if (acctTable) for (const r of acctTable.rows) accts.push({ acct: scrub(r.acct, 30) || '?', orders: num(r.orders), cancel: num(r.cancel), ioc: num(r.ioc), symbols: num(r.symbols), filled: null, makerBp: num(r.maker_bp), iocStatus: '', iocNote: '' });
  for (const s of iocTiles) {
    const name = s.id.slice('tiles_'.length);
    let a = accts.find((x) => x.acct === name);
    if (!a) { a = { acct: name, orders: null, cancel: null, ioc: null, symbols: null, filled: null, makerBp: null, iocStatus: '', iocNote: '' }; accts.push(a); }
    for (const it of s.items) {
      if (/IOC/i.test(it.label)) { a.ioc ??= num(it.value); a.iocStatus = it.status; a.iocNote = it.note; }
      else if (/체결 발생/.test(it.label)) a.filled = num(it.value);
      else if (/메이커 회전/.test(it.label)) a.makerBp ??= num(it.value);
      else if (/^주문 수/.test(it.label)) a.orders ??= num(it.value);
      else if (/취소율/.test(it.label)) a.cancel ??= num(it.value);
      else if (/심볼 수/.test(it.label)) a.symbols ??= num(it.value);
    }
  }
  accts.sort((a, b) => (b.ioc ?? -1) - (a.ioc ?? -1));
  const top = accts[0] ?? null;
  const negMaker = accts.filter((a) => a.makerBp !== null && a.makerBp < 0).sort((a, b) => a.makerBp! - b.makerBp!);
  const worstMaker = negMaker[0] ?? null;
  const iocDef = iocTiles.flatMap((s) => s.items).find((it) => /IOC/i.test(it.label));

  // ── guard effectiveness (sguard tab) ──
  const sg = tabs.find((t) => t.tab === 'sguard');
  const guardUnits = (sg?.sections ?? []).filter((s) => /^sg_(sh|a1|a2|wf)$/.test(s.id));
  const pickTile = (s: Section, re2: RegExp): string => { const it = s.items.find((x) => re2.test(x.label)); return it ? tileText(it) : '—'; };
  const guardRows = guardUnits.map((s) => [s.id.slice(3), pickTile(s, /^체결N/), pickTile(s, /crossed/i), pickTile(s, /markout5s 중앙/), pickTile(s, /가드취소 touch/), pickTile(s, /가드취소 approach/)]);
  const savings = sg?.sections.find((s) => s.id === 'sg_savings');
  const liveUnits = (sg?.sections ?? []).filter((s) => /^live_(sh|a1|a2|wf)$/.test(s.id));
  const inactiveUnits = liveUnits.filter((s) => s.items.some((it) => /^유닛/.test(it.label) && it.value === 'inactive')).map((s) => ({ id: s.id.slice(5), unit: /([\w-]+\.service)/.exec(s.note)?.[1] ?? '' }));

  // ── markout / PnL (choi tab) ──
  const choi = tabs.find((t) => t.tab === 'choi');
  const hedge = choi?.sections.find((s) => s.id === 'hedge_tiles');
  const pnlRows: [string, string][] = (hedge?.items ?? []).filter((it) => /손익|낙폭|펀딩|basis|수수료/i.test(it.label)).slice(0, 10).map((it) => [it.label, `${tileText(it)}${it.status === 'bad' ? ' ⚠' : it.status === 'warn' ? ' △' : ''}`]);
  const monthly = choi?.sections.find((s) => s.id === 'monthly_pnl');
  const monthlyBars = monthly ? monthly.x.map((x, i) => ({ x, h: monthly.series.find((se) => /hedged/i.test(se.name) && !/un/i.test(se.name))?.values[i] ?? null, u: monthly.series.find((se) => /unhedged/i.test(se.name))?.values[i] ?? null })).slice(-6) : [];
  const bench = choi?.sections.find((s) => s.id === 'benchmarks');
  const benchMarkout = (bench?.items ?? []).filter((it) => /마크아웃/.test(it.label)).slice(0, 4).map((it): [string, string] => [it.label, tileText(it)]);

  // ── stale sections / next steps ──
  const stale = all.filter(({ s }) => s.asof && now - Date.parse(s.asof) > STALE_ASOF_DAYS * DAY_MS && !/라이브 아님|아카이브/.test(s.note));
  const next: { text: string; level: HubLevel | 'ok'; hint?: string }[] = [];
  if (top && top.ioc !== null) next.push({ level: 'warn', text: `IOC 비중 최고 계정 ${top.acct} (${fmtNum(top.ioc, 2)}%) 의 TIF 라벨 주문 표본부터 확인`, ...(top.iocNote ? { hint: top.iocNote } : {}) });
  if (negMaker.length) next.push({ level: 'warn', text: `메이커 회전 순익 음수: ${negMaker.map((a) => `${a.acct} ${fmtNum(a.makerBp!, 2)}bp`).join(' · ')} — 이 계정들의 IOC 체결 먼저`, hint: 'N=6일 표본 — 결론은 보류' });
  if (inactiveUnits.length) next.push({ level: 'bad', text: `라이브 유닛 ${inactiveUnits.map((u) => u.id).join('·')} inactive — 재가동 여부 결정`, hint: inactiveUnits.map((u) => u.unit).filter(Boolean).join(', ') });
  for (const { t, s } of stale.slice(0, 3)) next.push({ level: 'info', text: `${t.title} › ${s.title} 기준 ${agoFrom(s.asof, now)} — 갱신 필요 여부 확인` });
  for (const e of errors) next.push({ level: 'warn', text: `스냅샷 오류: ${e}` });
  if (!next.length) next.push({ level: 'ok', text: '규칙상 볼 것 없음' });

  const headline = top && top.ioc !== null
    ? `IOC 비중 ${accts.filter((a) => a.ioc !== null).map((a) => `${a.acct} ${fmtNum(a.ioc!, 1)}%`).join(' · ')} (TIF 라벨 주문) · 깨진 타일 ${bad}`
    : `스냅샷 ${lastActivity ? fmtKst(lastActivity) : '시각 미상'} · 탭 ${tabs.length} · 타일 ${tiles} · 깨진 타일 ${bad}`;
  const decision = top && top.ioc !== null
    ? `IOC 비중 최고 계정(${top.acct})의 TIF 라벨 주문 표본 확인 → ${worstMaker ? `메이커 회전 순익 음수 계정(${negMaker.map((a) => a.acct).join('·')}) 우선` : '메이커 회전 순익 계정별 비교'}`
    : inactiveUnits.length ? `라이브 유닛 ${inactiveUnits.length}개 inactive — 재가동 여부 결정` : bad ? `깨진 타일 ${bad}개 확인` : '조치 없음';
  const kpis: HubKpi[] = [];
  for (const a of accts.slice(0, 3)) kpis.push(kpi(`IOC ${a.acct}`, a.ioc === null ? '—' : `${fmtNum(a.ioc, 2)}%`, { status: a.iocStatus === 'bad' ? 'bad' : a.iocStatus === 'warn' ? 'warn' : 'info', ...(a.filled !== null ? { hint: `체결 발생 ${fmtNum(a.filled, 2)}%` } : a.orders !== null ? { hint: `주문 ${fmtInt(a.orders)}` } : {}) }));
  if (!accts.length) kpis.push(kpi('IOC 비중', '—', { status: 'info', hint: 're 탭 없음' }));
  const filledMax = accts.filter((a) => a.filled !== null).sort((a, b) => b.filled! - a.filled!)[0];
  kpis.push(kpi('체결 발생 주문', filledMax ? `${fmtNum(filledMax.filled!, 2)}%` : '—', { ...(filledMax ? { hint: `최고 ${filledMax.acct}` } : {}) }));
  kpis.push(kpi('메이커 회전 순익', worstMaker ? `${fmtNum(worstMaker.makerBp!, 2)} bp` : accts.find((a) => a.makerBp !== null) ? `${fmtNum(accts.find((a) => a.makerBp !== null)!.makerBp!, 2)} bp` : '—', { status: worstMaker ? 'bad' : 'info', ...(worstMaker ? { hint: `최악 ${worstMaker.acct}` } : {}) }));
  kpis.push(kpi('깨진 타일', String(bad), { status: bad ? 'bad' : 'ok', hint: `주의 ${warn}` }));

  const sections: HubSection[] = [];
  if (accts.length) sections.push(sec.table('IOC 발견 — 계정별', ['계정', '주문', '취소율', 'IOC 비중', '체결 발생', '심볼', '메이커 회전 bp'], accts.map((a) => [a.acct, a.orders === null ? '—' : fmtInt(a.orders), a.cancel === null ? '—' : `${fmtNum(a.cancel, 2)}%`, a.ioc === null ? '—' : `${fmtNum(a.ioc, 2)}%`, a.filled === null ? '—' : `${fmtNum(a.filled, 2)}%`, a.symbols === null ? '—' : String(a.symbols), a.makerBp === null ? '—' : fmtNum(a.makerBp, 2)]), { open: true, num: [1, 2, 3, 4, 5, 6], note: `IOC 비중 내림차순 · ${iocDef?.label ?? 'IOC 비중'}${acctTable?.asof ? ` · 기준 ${fmtKst(acctTable.asof)}` : ''}${acctTable?.note ? ` · ${acctTable.note}` : ''}` }));
  if (guardRows.length) {
    const sav = (savings?.items ?? []).map((it): [string, string] => [it.label, tileText(it)]);
    sections.push(sec.table('가드 효과 — 유닛별 24h', ['유닛', '체결N', 'crossed-at-fill', 'markout5s 중앙', '가드취소 touch', '가드취소 approach'], guardRows, { open: true, num: [1, 2, 3, 4, 5], note: `${guardUnits[0]?.note ?? ''}${guardUnits[0]?.asof ? ` · 기준 ${fmtKst(guardUnits[0].asof)}` : ''}${sav.length ? ` · ${sav.map(([k, v]) => `${k} ${v}`).join(' · ')}` : ''}` }));
  }
  if (pnlRows.length || monthlyBars.length) {
    sections.push(sec.kv('마크아웃 · PnL (헷지 분석)', [...pnlRows, ...benchMarkout], { note: hedge?.note ?? '' }));
    if (monthlyBars.length) sections.push(sec.bars('월별 손익 hedged (억)', monthlyBars.map((m) => ({ label: m.x, value: Math.abs(m.h ?? 0), text: `hedged ${m.h === null ? '—' : fmtNum(m.h, 2)} · unhedged ${m.u === null ? '—' : fmtNum(m.u, 2)}` })), { note: monthly?.note ?? '' }));
  }
  sections.push(sec.list('깨진 타일', [...inactiveUnits.map((u) => ({ level: 'bad' as const, text: `라이브 유닛 ${u.id} inactive`, ...(u.unit ? { hint: u.unit } : {}) })), ...broken.filter((b) => !/^유닛 = /.test(b.text.split(' · ')[1] ?? ''))].slice(0, 40), { open: bad > 0, note: `bad ${bad} · warn ${warn}` }));
  sections.push(sec.list('다음에 볼 것', next, { open: true }));
  for (const t of tabs) for (const s of t.sections) { const h = sectionToHub(s); if (h) sections.push({ ...h, title: `${t.title} › ${h.title}` }); }
  sections.push(sec.raw('원본 보기', '/hub/p/quant/', { embed: true, note: '읽기 전용 프록시' }));
  void levelOf;
  return { id: 'quant', name: 'QUANT', state, lastActivity, metrics, alerts: sortAlerts(alerts), links, sources: [source], page: page(headline, decision, kpis, sections) };
}
