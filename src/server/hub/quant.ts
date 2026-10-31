/**
 * QUANT as a work environment: the friends' 빗썸 RE accounts as cards (7일 순익, 어제, 상위 심볼, 수집 상태, 자본 스파크)
 * from the friends snapshot (~/.local/state, 30-min timer), the paper units as cards (systemd + fills tail + the
 * 24h A/B score of qa_dash), equity/daily charts, and the qa_dash "red tiles" grouped by reason instead of listed as a
 * wall. Paths never leave (`scrub`), `_src`/`src` records are never copied, every list is bounded.
 */
import path from 'node:path';
import type { HubAlert, HubCardItem, HubChartSeries, HubKpi, HubLevel, HubMetricValue, HubMode, HubSection, HubSource, HubState } from '../../shared/hub-types';
import { DAY_MS, HOUR_MS, HUB_TIMEOUTS, HUB_URLS, SLOW_CACHE_MS, UNIT_STATE_KO, agoFrom, arr, downMode, fmtDate, fmtInt, fmtKrw, fmtKst, fmtNum, isObj, kpi, latestIso, num, objs, page, probe, scrub, sec, showUnit, slowCache, sortAlerts, str, toIso, unitInfo, type HubDeps, type UnitInfo } from './shared';

/* ───────── qa_dash snapshot (:8810) ───────── */

interface Tile { label: string; value: unknown; unit: string; fmt: string; status: string; note: string }
interface Section { id: string; title: string; kind: string; asof: string | null; note: string; items: Tile[]; columns: { key: string; label: string; fmt: string }[]; rows: Record<string, unknown>[]; x: string[]; series: { name: string; values: (number | null)[] }[]; unit: string; body: string }
interface Tab { tab: string; title: string; sections: Section[] }

export function parseSnapshot(data: Record<string, unknown>): Tab[] {
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
const tileOf = (s: Section | undefined, re: RegExp): Tile | undefined => s?.items.find((t) => re.test(t.label));
const tileStr = (s: Section | undefined, re: RegExp): string => { const t = tileOf(s, re); return t ? tileText(t) : '—'; };

function tableSection(s: Section, o: { open?: boolean; title?: string; note?: string } = {}): HubSection {
  const cols = s.columns.filter((c) => c.key && !c.key.startsWith('_'));
  const rows = s.rows.slice(0, 60).map((r) => cols.map((c) => fmtVal(r[c.key], c.fmt)));
  const numIdx = cols.map((c, i) => (['krw', 'pct', 'bp', 'ms', 'int', 'num'].includes(c.fmt) ? i : -1)).filter((i) => i >= 0);
  return sec.table(o.title ?? s.title, cols.map((c) => c.label), rows, { note: o.note ?? [s.note, s.asof ? `기준 ${fmtKst(s.asof)}` : ''].filter(Boolean).join(' · '), num: numIdx, open: o.open ?? false });
}

/* ───────── friends snapshot (~/.local/state/friends_snapshot.json) ───────── */

const FRIENDS_FILE = '.local/state/friends_snapshot.json';
const INFRA_DIR = 'quant_analyzer/results/daily';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The three friends' 빗썸 accounts (snapshot name → display name; the archive's `범수동생계정3`). */
const FRIENDS: { key: string; label: string }[] = [{ key: '빗썸1', label: '빗썸1' }, { key: '빗썸2', label: '빗썸2' }, { key: '범수3', label: '범수동생계정3' }];
const FRIEND_KEYS = new Set(FRIENDS.map((f) => f.key));

interface EqPt { d: string; total: number }
interface DayRow { d: string; turn: number | null; fee: number | null; net: number | null; fills: number | null; netBp: number | null; top: [string, number][] }
interface Gauge { turn: number | null; net: number | null; netBp: number | null; days: number | null }
interface Friend { name: string; equity: EqPt[]; daily: DayRow[]; gauge: Gauge | null }
export interface Friends { ts: string | null; ok: boolean; accts: Friend[] }

const byDate = <T extends { d: string }>(a: T, b: T): number => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0);

/** The friends snapshot, defensively: unknown accounts kept (bounded), bad points dropped, series sorted oldest first. */
export function parseFriends(data: unknown): Friends | null {
  if (!isObj(data)) return null;
  const eqAll = isObj(data.equity) ? data.equity : {};
  const dayAll = isObj(data.daily) ? data.daily : {};
  const gAll = isObj(data.gauge) ? data.gauge : {};
  const names = [...new Set([...arr(data.accts), ...Object.keys(eqAll), ...Object.keys(dayAll)].map((v) => str(v, 30)).filter((v): v is string => v !== null))].slice(0, 12);
  const accts = names.map((name): Friend => {
    const equity = objs(eqAll[name]).map((p) => ({ d: str(p.d, 10) ?? '', total: num(p.total) })).filter((p): p is EqPt => DATE_RE.test(p.d) && p.total !== null).sort(byDate).slice(-400);
    const dd = isObj(dayAll[name]) ? dayAll[name] : {};
    const daily = Object.entries(dd).filter((e): e is [string, Record<string, unknown>] => DATE_RE.test(e[0]) && isObj(e[1])).map(([d, v]): DayRow => ({
      d, turn: num(v.turn), fee: num(v.fee), net: num(v.net), fills: num(v.fills), netBp: num(v.net_bp),
      top: arr(v.top).filter(Array.isArray).map((t): [string, number | null] => [scrub(t[0], 16), num(t[1])]).filter((t): t is [string, number] => t[0] !== '' && t[1] !== null).slice(0, 5),
    })).sort(byDate).slice(-120);
    const g = gAll[name];
    const gauge: Gauge | null = isObj(g) ? { turn: num(g.turn), net: num(g.net), netBp: num(g.net_bp), days: num(g.days) } : null;
    return { name, equity, daily, gauge };
  });
  return { ts: toIso(data.ts), ok: data.ok !== false, accts };
}

type FriendsCache = ReturnType<typeof slowCache<Friends | null>>;
const friendsCache = new WeakMap<HubDeps, FriendsCache>();
/** The parsed friends file, kept 60 s per deps (the file is ~200 KB and changes every 30 min). */
function friendsOf(deps: HubDeps): ReturnType<FriendsCache> {
  let c = friendsCache.get(deps);
  if (!c) {
    c = slowCache<Friends | null>(SLOW_CACHE_MS.quant, async () => {
      const text = await deps.readText(path.join(deps.home, FRIENDS_FILE));
      return text === null ? null : parseFriends(JSON.parse(text) as unknown);
    }, deps.now);
    friendsCache.set(deps, c);
  }
  return c();
}

/* ───────── infra watch (09:00 daily, per-account collector health) ───────── */

interface Infra { date: string; head: string; accts: Record<string, { ok: boolean; text: string }> }

async function readInfra(deps: HubDeps): Promise<Infra | null> {
  const names = (await deps.listDir(path.join(deps.home, INFRA_DIR))) ?? [];
  const files = names.map((n) => /^infra_(\d{4}-\d{2}-\d{2})\.txt$/.exec(n)?.[1]).filter((d): d is string => !!d).sort();
  const date = files[files.length - 1];
  if (!date) return null;
  const text = await deps.readText(path.join(deps.home, INFRA_DIR, `infra_${date}.txt`));
  if (text === null) return null;
  const lines = text.split('\n').slice(0, 20);
  const head = scrub(lines[0] ?? '', 80).replace(/^infra watch\s*/, '');
  const accts: Infra['accts'] = {};
  const aws = lines.find((l) => l.startsWith('[aws]')) ?? '';
  for (const part of aws.replace(/^\[aws\]\s*/, '').split('|')) {
    const m = /^\s*(\S+)\s+(\S+)\s*(.*)$/.exec(part);
    const [, name, light, rest] = m ?? [];
    if (!name || !light) continue;
    accts[name] = { ok: light === '🟢', text: scrub(`${light} ${(rest ?? '').trim()}`, 60) };
  }
  return { date, head, accts };
}

/* ───────── paper units (systemd, read-only) ───────── */

const SG_UNITS = [
  { id: 'sh', unit: 'v9flws-sh', role: '섀도 — 가드 태그만 (취소 없음, 추정)', fills: 'qa_v9flws/logs/v9flws_sh_fills.jsonl' },
  { id: 'a1', unit: 'v9flws-a1', role: 'A/B arm 1 — S stale 가드 취소', fills: 'qa_v9flws/logs/v9flws_a1_fills.jsonl' },
  { id: 'a2', unit: 'v9flws-a2', role: 'A/B arm 2 — S stale 가드 취소', fills: 'qa_v9flws/logs/v9flws_a2_fills.jsonl' },
  { id: 'wf', unit: 'v9flwf-ex', role: '대조군 — v9flw_ex + end_handoff', fills: 'qa_v9flwf/logs/v9flwf_ex_fills.jsonl' },
] as const;
const OTHER_UNITS = ['v9mk4-m0r', 'v9mk4-m3', 'v9mk4-pc', 'v9pp2-ex', 'v9pp-ex'] as const;
const FILLS_TAIL_BYTES = 64 * 1024;

interface LastFill { at: string | null; sym: string; side: string }
async function lastFillOf(deps: HubDeps, rel: string): Promise<LastFill | null> {
  const tail = await deps.readTail(path.join(deps.home, rel), FILLS_TAIL_BYTES);
  if (!tail) return null;
  const lines = tail.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
    try {
      const j: unknown = JSON.parse(lines[i] ?? '');
      if (isObj(j)) return { at: toIso(num(j.ts) ?? num(j.observed_ms)), sym: scrub(j.symbol, 12), side: scrub(j.side, 6) };
    } catch { /* a torn first line of the tail */ }
  }
  return null;
}

interface Unit { id: string; unit: string; info: UnitInfo; role: string; fill: LastFill | null; fillMtime: number | null; score: Section | undefined; live: Section | undefined }
type UnitState = 'ok' | 'warn' | 'bad' | 'unknown';
/** 정지 = warn, 실패 = bad, 가동 = ok; a unit systemd does not know falls back to the qa_dash live tile. */
function unitState(u: Unit): UnitState {
  if (u.info.active === 'failed') return 'bad';
  if (u.info.active === 'active' || u.info.active === 'activating') return 'ok';
  if (u.info.active === 'inactive') return 'warn';
  const v = tileOf(u.live, /^유닛/)?.value;
  return v === 'active' ? 'ok' : v === 'inactive' || v === 'failed' ? (v === 'failed' ? 'bad' : 'warn') : 'unknown';
}
const stoppedAt = (u: Unit): string | null => u.info.since ?? u.info.exitedAt ?? u.fill?.at ?? (u.fillMtime !== null ? new Date(u.fillMtime).toISOString() : null);

/* ───────── formatting ───────── */

/** Signed won: +1,784만원 · -24만원 · +2.15억 · +900원. */
export const fmtWon = (v: number): string => {
  const a = Math.abs(v), s = v < 0 ? '-' : '+';
  return `${s}${a >= 1e8 ? `${fmtNum(a / 1e8, 2)}억` : a >= 1e4 ? `${fmtInt(a / 1e4)}만원` : `${fmtInt(a)}원`}`;
};
const fmtBp = (v: number): string => `${v >= 0 ? '+' : ''}${fmtNum(v, 2)}bp`;
const signStatus = (v: number | null): 'ok' | 'bad' | 'info' => (v === null ? 'info' : v >= 0 ? 'ok' : 'bad');
const dateMinus = (ms: number, days: number): string => fmtDate(new Date(ms - days * DAY_MS).toISOString());

/* ───────── collector ───────── */

export async function collectQuant(deps: HubDeps): Promise<HubMode> {
  const links = [{ label: '열기', href: '/hub/p/quant/', embed: true }];
  const now = deps.now();
  const t0 = now;
  const [{ data, source }, fr] = await Promise.all([probe(deps, 'snapshot.json', HUB_URLS.quant, HUB_TIMEOUTS.default), friendsOf(deps).catch(() => ({ value: null, at: null, stale: true, error: '오류' }))]);
  const friendsSrc: HubSource = { name: 'friends_snapshot.json', ok: fr.value !== null && !fr.stale, ms: Math.max(0, deps.now() - t0), ...(fr.error ? { error: fr.error } : fr.value === null ? { error: '파일 없음' } : {}) };
  const snap = isObj(data) ? data : null;
  if (!snap && !fr.value) return { ...downMode('quant', 'QUANT', source, links), sources: [source, friendsSrc] };
  const tabs = snap ? parseSnapshot(snap) : [];
  const friends = fr.value;
  const today = fmtDate(new Date(now).toISOString());
  const yday = dateMinus(now, 1);
  const weekFrom = dateMinus(now, 7); // the gauge window: the 7 days ending yesterday (weekFrom … yday)

  const [infra, ...units] = await Promise.all([
    readInfra(deps).catch(() => null),
    ...SG_UNITS.map(async (u): Promise<Unit> => {
      const [info, fill, fillMtime] = await Promise.all([showUnit(deps, u.unit), lastFillOf(deps, u.fills).catch(() => null), deps.fileMtime(path.join(deps.home, u.fills)).catch(() => null)]);
      const sg = tabs.find((t) => t.tab === 'sguard');
      return { id: u.id, unit: u.unit, info, role: u.role, fill, fillMtime, score: sg?.sections.find((s) => s.id === `sg_${u.id}`), live: sg?.sections.find((s) => s.id === `live_${u.id}`) };
    }),
    ...OTHER_UNITS.map(async (unit): Promise<Unit> => {
      const p = await deps.systemdShow(unit).catch(() => null);
      return { id: unit, unit, info: unitInfo(unit, p), role: scrub(p?.Description, 100), fill: null, fillMtime: null, score: undefined, live: undefined };
    }),
  ]);
  const known = units.filter((u) => u.info.active !== 'missing' || u.live);
  const running = known.filter((u) => unitState(u) === 'ok');
  const failed = known.filter((u) => unitState(u) === 'bad');
  const stopped = known.filter((u) => unitState(u) === 'warn');
  const sgStopped = stopped.filter((u) => SG_UNITS.some((s) => s.id === u.id));
  const stoppedDate = latestIso(...sgStopped.map(stoppedAt));

  /* ── accounts ── */
  const accts = FRIENDS.map((f) => friends?.accts.find((a) => a.name === f.key) ?? null);
  const have = accts.filter((a): a is Friend => a !== null);
  const yRow = (a: Friend): DayRow | undefined => a.daily.find((d) => d.d === yday);
  const week = (a: Friend): DayRow[] => a.daily.filter((d) => d.d >= weekFrom && d.d <= yday);
  const net7 = (a: Friend): number | null => a.gauge?.net ?? (week(a).length ? week(a).reduce((s, d) => s + (d.net ?? 0), 0) : null);
  const turn7 = (a: Friend): number | null => a.gauge?.turn ?? (week(a).length ? week(a).reduce((s, d) => s + (d.turn ?? 0), 0) : null);
  const sum = (xs: (number | null)[]): number | null => (xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);
  const sumNet7 = sum(have.map(net7));
  const sumTurn7 = sum(have.map(turn7));
  const bp7 = sumNet7 !== null && sumTurn7 ? (sumNet7 / sumTurn7) * 1e4 : null;
  const sumYNet = sum(have.map((a) => yRow(a)?.net ?? null));
  const sumYFills = sum(have.map((a) => yRow(a)?.fills ?? null));
  const equityNow = sum(have.map((a) => a.equity[a.equity.length - 1]?.total ?? null));
  const negY = have.filter((a) => (yRow(a)?.net ?? 0) < 0);
  const infraOf = (a: Friend): { ok: boolean; text: string } | null => infra?.accts[a.name] ?? null;
  const infraStale = infra !== null && infra.date < yday;
  const lagging = have.filter((a) => infra !== null && !infraStale && infraOf(a) !== null && !infraOf(a)!.ok);

  const cards: HubCardItem[] = FRIENDS.map((f, i) => {
    const a = accts[i];
    if (!a) return { title: f.label, badge: '빗썸 현물', state: 'unknown', sub: '스냅샷에 계정 없음', rows: [] };
    const first = a.equity[0], last = a.equity[a.equity.length - 1];
    const y = yRow(a);
    const n7 = net7(a), b7 = a.gauge?.netBp ?? (n7 !== null && turn7(a) ? (n7 / turn7(a)!) * 1e4 : null);
    const top = new Map<string, number>();
    for (const d of week(a)) for (const [sym, pnl] of d.top) top.set(sym, (top.get(sym) ?? 0) + pnl);
    const topList = [...top.entries()].sort((x, y2) => y2[1] - x[1]).slice(0, 3).map(([s, v]) => `${s} ${fmtWon(v)}`).join(' · ');
    const health = infraOf(a);
    const state: HubCardItem['state'] = (health && !health.ok) || (y && (y.net ?? 0) < 0) ? 'warn' : y ? 'ok' : 'idle';
    return {
      title: f.label, badge: '빗썸 현물', state,
      sub: first && last ? `SEED ${fmtKrw(first.total)} → ${fmtKrw(last.total)} (${first.total > 0 ? `${last.total >= first.total ? '+' : ''}${fmtNum(((last.total - first.total) / first.total) * 100, 0)}%` : '—'}) · 원가 기준 · ${first.d.slice(5)}~${last.d.slice(5)}` : '자본 이력 없음',
      rows: [
        { label: '7일 순익', value: n7 === null ? '—' : `${fmtWon(n7)}${b7 !== null ? ` (${fmtBp(b7)})` : ''}`, status: signStatus(n7) },
        { label: `어제 순익 (${yday.slice(5)})`, value: y?.net === null || y?.net === undefined ? '— (어제 기록 없음)' : `${fmtWon(y.net)}${y.netBp !== null ? ` (${fmtBp(y.netBp)})` : ''}`, status: signStatus(y?.net ?? null) },
        { label: '어제 회전', value: y?.turn === null || y?.turn === undefined ? '—' : fmtKrw(y.turn) },
        { label: '어제 체결', value: y?.fills === null || y?.fills === undefined ? '—' : `${fmtInt(y.fills)}건` },
        { label: '어제 수수료', value: y?.fee === null || y?.fee === undefined ? '—' : `${fmtInt(y.fee)}원` },
        { label: '상위 심볼 7일', value: topList || '—' },
        { label: '수집 상태', value: health ? `${health.text}${infraStale ? ` (${infra!.date.slice(5)} 보고)` : ''}` : '보고 없음', status: health ? (health.ok && !infraStale ? 'ok' : 'warn') : 'info' },
      ],
      spark: { values: a.equity.slice(-60).map((p) => Math.round(p.total / 1e6) / 100), label: '자본(원가) 60일', unit: '억' },
      note: '전략 추정: RE/IOC 메이커 회전 (역공학 — 라이브 전략 기록 없음) · 코인·OTC 는 평균매수가(원가) 평가',
    };
  });

  /* ── charts ── */
  const equityChart = ((): HubSection | null => {
    if (!have.length) return null;
    const dates = [...new Set(have.flatMap((a) => a.equity.slice(-90).map((p) => p.d)))].sort().slice(-90);
    const series: HubChartSeries[] = have.map((a) => { const m = new Map(a.equity.map((p) => [p.d, p.total])); return { name: FRIENDS.find((f) => f.key === a.name)?.label ?? a.name, values: dates.map((d) => { const v = m.get(d); return v === undefined ? null : Math.round(v / 1e6) / 100; }) }; });
    return sec.chart('자본 추이 (원가 기준, 억)', dates.map((d) => d.slice(5)), series, { unit: '억', open: true, note: `하루 첫 잔고 스냅샷 · 코인·OTC 는 평균매수가 평가(시장가 아님) · 최근 ${dates.length}일` });
  })();
  const dailyChart = ((): HubSection | null => {
    if (!have.length) return null;
    const dates = [...new Set(have.flatMap((a) => a.daily.map((d) => d.d)))].filter((d) => d < today).sort().slice(-30);
    if (!dates.length) return null;
    const series: HubChartSeries[] = have.map((a) => { const m = new Map(a.daily.map((d) => [d.d, d.net])); return { name: FRIENDS.find((f) => f.key === a.name)?.label ?? a.name, values: dates.map((d) => m.get(d) ?? null), style: 'bar' }; });
    return sec.chart('일별 순익 (원) 30일', dates.map((d) => d.slice(5)), series, { unit: '원', zero: true, open: true, note: `수수료 차감 후 · 오늘(${today.slice(5)}) 부분일 제외` });
  })();

  /* ── paper unit cards ── */
  const sg = tabs.find((t) => t.tab === 'sguard');
  const sgTable = sg?.sections.find((s) => s.id === 'sg_table');
  const scoreAsof = SG_UNITS.map((u) => units.find((x) => x.id === u.id)?.score?.asof ?? null).find((v) => v) ?? null;
  const unitCards: HubCardItem[] = known.map((u) => {
    const st = unitState(u);
    const at = st === 'warn' ? stoppedAt(u) : st === 'bad' ? (u.info.exitedAt ?? u.info.since) : u.info.since;
    const result = u.info.result === 'success' ? '정상 종료' : u.info.result === 'exit-code' ? '비정상 종료 (exit-code)' : u.info.result ? `Result=${u.info.result}` : '';
    const sub = st === 'ok' ? `가동 ${at ? `${fmtKst(at)} 부터` : ''}${u.info.restarts ? ` · 재시작 ${u.info.restarts}` : ''}`.trim()
      : st === 'bad' ? `실패 ${at ? fmtKst(at) : ''} · ${result || 'exit-code'}`.replace(/\s+·/, ' ·')
      : st === 'warn' ? `정지 ${at ? fmtKst(at) : '시각 미상'}${result ? ` · ${result}` : ''}` : '상태 미상';
    const rows: HubCardItem['rows'] = [];
    if (u.score) {
      rows.push({ label: '24h 체결 / 대금', value: `${tileStr(u.score, /^체결N/)} / ${tileStr(u.score, /^체결대금/)}` });
      rows.push({ label: '24h markout5s 중앙', value: tileStr(u.score, /markout5s 중앙/) });
      rows.push({ label: '24h crossed-at-fill', value: tileStr(u.score, /crossed/i) });
      rows.push({ label: '24h 가드취소 touch/approach', value: `${tileStr(u.score, /가드취소 touch/)} / ${tileStr(u.score, /가드취소 approach/)}` });
    }
    if (u.fill) rows.push({ label: '마지막 체결', value: `${fmtKst(u.fill.at)}${u.fill.sym ? ` · ${u.fill.sym} ${u.fill.side}` : ''}`.trim() });
    else if (u.live) rows.push({ label: '체결 1h', value: tileStr(u.live, /^체결 1h/) });
    rows.push({ label: '역할', value: u.role || '—' });
    return {
      title: u.unit, badge: 'PAPER', state: st === 'ok' ? 'ok' : st === 'warn' ? 'warn' : st === 'bad' ? 'down' : 'unknown', sub, rows,
      note: st === 'bad' ? `${UNIT_STATE_KO.failed} — 로그 확인 후 재시작/폐기 결정` : st === 'warn' && u.score ? '의도적 정지로 추정 — 기록 없음 · 24h 스코어는 10-09 A/B 채점' : st === 'warn' ? '정지 — 기록 없음' : '',
    };
  });

  /* ── red tiles grouped by reason ── */
  let warnN = 0, badN = 0;
  const groups: Record<'stopped' | 'sign' | 'archive' | 'other', { tab: Tab; s: Section; t: Tile }[]> = { stopped: [], sign: [], archive: [], other: [] };
  for (const tab of tabs) for (const s of tab.sections) for (const t of s.items) {
    if (t.status !== 'warn' && t.status !== 'bad') continue;
    if (t.status === 'warn') warnN++; else badN++;
    const g = s.id.startsWith('live_') ? 'stopped' : tab.tab === 'choi' ? 'sign' : tab.tab === 're' || /아카이브/.test(s.note) ? 'archive' : 'other';
    groups[g].push({ tab, s, t });
  }
  const redN = warnN + badN;
  /** `섹션: 라벨 = 값, 라벨 = 값 / 섹션: …` — the section title once per section, bounded. */
  const hintOf = (xs: { s: Section; t: Tile }[]): string => {
    const bySec = new Map<string, string[]>();
    for (const { s, t } of xs.slice(0, 8)) { const k = s.title.split(' — ')[0] ?? s.title; bySec.set(k, [...(bySec.get(k) ?? []), `${t.label} = ${tileText(t)}`]); }
    return [...bySec.entries()].map(([k, v]) => `${k}: ${v.join(', ')}`).join(' / ').slice(0, 240);
  };
  const redItems: { text: string; level: HubLevel | 'ok'; hint?: string }[] = [];
  if (groups.stopped.length) redItems.push({ level: 'info', text: `정지 유닛 ${groups.stopped.length} — 라이브 1h 타일 (유닛 inactive · tel 기록 중단): ${[...new Set(groups.stopped.map((x) => x.s.id.slice(5)))].join('·')}`, hint: `페이퍼 A/B 가 ${stoppedDate ? fmtKst(stoppedDate) : '10-11'} 에 의도적으로 정지된 상태로 추정 — 장애 아님 (위 라이브 유닛 카드)` });
  if (groups.sign.length) redItems.push({ level: 'info', text: `분석 값 부호 ${groups.sign.length} — 최O용 헷지 분석 (손익·낙폭·펀딩·basis 의 음수/양수에 색)`, hint: `아카이브 분석 값 — 부호에 따라 색만 붙음, 장애 아님: ${hintOf(groups.sign)}` });
  if (groups.archive.length) redItems.push({ level: 'info', text: `7월 아카이브 판정 ${groups.archive.length} — 빗썸 RE 3계정 (메이커 회전 순익 음수 · 실자본 판정 NO-GO)`, hint: `2026-07 아카이브 판정, 라이브 아님: ${hintOf(groups.archive)}` });
  if (groups.other.length) redItems.push({ level: 'warn', text: `기타 ${groups.other.length} — 분류되지 않은 붉은 타일`, hint: hintOf(groups.other) });
  if (!redItems.length) redItems.push({ level: 'ok', text: snap ? '붉은 타일 없음' : 'qa_dash 응답 없음 — 타일 확인 불가' });

  /* ── freshness ── */
  const genAt = snap ? toIso(snap.generated_at) : null;
  const reAsof = tabs.find((t) => t.tab === 're')?.sections.find((s) => s.id.startsWith('tiles_'))?.asof ?? null;
  const choiAsof = tabs.find((t) => t.tab === 'choi')?.sections.find((s) => s.id === 'hedge_tiles')?.asof ?? null;
  const fresh: [string, string][] = [
    ['friends_snapshot (30분 타이머)', friends ? `${fmtKst(friends.ts)} · ${agoFrom(friends.ts, now)}${fr.stale ? ' · 캐시(갱신 실패)' : ''}` : `없음${fr.error ? ` · ${fr.error}` : ''}`],
    ['qa_dash snapshot (5분 타이머)', genAt ? `${fmtKst(genAt)} · ${agoFrom(genAt, now)}` : `없음${source.error ? ` · ${source.error}` : ''}`],
    ['S 가드 24h 스코어', scoreAsof ? `${fmtKst(scoreAsof)} · ${agoFrom(scoreAsof, now)}` : '—'],
    ['RE 3계정 아카이브', reAsof ? `${fmtKst(reAsof)} (07-07~13 구간)` : '—'],
    ['최O용 헷지 분석', choiAsof ? fmtKst(choiAsof) : '—'],
    ['infra watch (09:00 일보)', infra ? infra.head : '파일 없음'],
    ['전략 기록', '없음 — RE/IOC 메이커 회전은 역공학 추정 (핸드오프는 MacBook)'],
  ];

  /* ── alerts / state ── */
  const errors = (Array.isArray(snap?.errors) ? snap!.errors : []).filter((e): e is string => typeof e === 'string').slice(0, 5).map((e) => scrub(e));
  const alerts: HubAlert[] = errors.map((e) => ({ level: 'warn' as const, text: `qa_dash 오류: ${e}` }));
  for (const u of failed) alerts.push({ level: 'bad', text: `${u.unit} 실패 (${u.info.result ?? 'failed'})${u.info.exitedAt ? ` · ${fmtKst(u.info.exitedAt)}` : ''}`, hint: '로그 확인 후 재시작/폐기 결정', at: u.info.exitedAt });
  if (!snap) alerts.push({ level: 'warn', text: `qa_dash 응답 없음 · ${source.error ?? '오류'}` });
  if (!friends) alerts.push({ level: 'warn', text: `friends_snapshot 없음${friendsSrc.error ? ` · ${friendsSrc.error}` : ''} — 계정 카드·자본 차트 생략`, hint: 'friends-snapshot.timer (30분) 확인' });
  else if (friends.ts && now - Date.parse(friends.ts) > 2 * HOUR_MS) alerts.push({ level: 'warn', text: `friends_snapshot ${agoFrom(friends.ts, now)} — 30분 타이머 지연`, at: friends.ts });
  if (genAt && now - Date.parse(genAt) > DAY_MS) alerts.push({ level: 'warn', text: `qa_dash 스냅샷 ${agoFrom(genAt, now)} 생성`, at: genAt });
  if (lagging.length) alerts.push({ level: 'warn', text: `계정 수집 지연: ${lagging.map((a) => `${a.name} ${infraOf(a)!.text}`).join(' · ')}`, hint: `infra watch ${infra!.date}` });
  if (infra && infraStale) alerts.push({ level: 'warn', text: `infra watch 보고 ${infra.date} 이후 없음 — 수집 상태 미상` });
  if (sgStopped.length) alerts.push({ level: 'info', text: `페이퍼 A/B 유닛 ${sgStopped.length}개 정지${stoppedDate ? ` ${Math.floor((now - Date.parse(stoppedDate)) / DAY_MS)}일 (${fmtKst(stoppedDate)})` : ''} — 재개/폐기 미결`, at: stoppedDate });
  for (const a of negY) alerts.push({ level: 'info', text: `${FRIENDS.find((f) => f.key === a.name)?.label ?? a.name} 어제 순익 ${fmtWon(yRow(a)!.net!)}`, hint: `상위 심볼: ${yRow(a)!.top.map(([s, v]) => `${s} ${fmtWon(v)}`).join(' · ') || '—'}` });
  const state: HubState = alerts.some((a) => a.level === 'bad' || a.level === 'warn') ? 'warn' : friends ? 'ok' : 'unknown';
  const lastActivity = latestIso(friends?.ts ?? null, genAt);

  /* ── page ── */
  const headline = [
    `친구 계정 ${have.length}`,
    sumNet7 !== null ? `7일 순익 ${fmtWon(sumNet7)}${bp7 !== null ? ` (${fmtBp(bp7)})` : ''}` : '7일 순익 —',
    equityNow !== null ? `자본(원가) ${fmtKrw(equityNow)}` : '',
    sgStopped.length ? `라이브 페이퍼 유닛 ${sgStopped.length} 정지${stoppedDate ? `(${fmtDate(stoppedDate).slice(5)})` : ''}` : running.length ? `페이퍼 유닛 가동 ${running.length}/${known.length}` : '',
    failed.length ? `${failed.map((u) => u.unit).join('·')} 실패` : '',
  ].filter(Boolean).join(' · ');
  const decisions: string[] = [];
  if (sgStopped.length) decisions.push(`정지된 v9flws A/B(${sgStopped.map((u) => u.id).join('·')}) 재개/폐기 결정`);
  if (failed.length) decisions.push(`${failed.map((u) => u.unit).join('·')} 실패 확인`);
  if (lagging.length) decisions.push(`수집 지연 계정(${lagging.map((a) => a.name).join('·')}) 확인`);
  if (negY.length) decisions.push(`어제 적자 계정(${negY.map((a) => a.name).join('·')}) 상위 심볼 확인`);
  if (!friends) decisions.push('friends_snapshot 타이머 확인');
  const decision = decisions.length ? decisions.join(' · ') : '조치 없음';
  const kpis: HubKpi[] = [
    kpi('7일 순익 합', sumNet7 === null ? '—' : fmtWon(sumNet7), { status: signStatus(sumNet7), hint: `${yday.slice(5)} 까지 7일 · 수수료 후` }),
    kpi('7일 평균 bp', bp7 === null ? '—' : fmtBp(bp7), { status: signStatus(bp7), hint: sumTurn7 !== null ? `회전 ${fmtKrw(sumTurn7)}` : '회전 가중' }),
    kpi('어제 순익', sumYNet === null ? '—' : fmtWon(sumYNet), { status: signStatus(sumYNet), hint: yday }),
    kpi('총 자본 (원가)', equityNow === null ? '—' : fmtKrw(equityNow), { status: 'info', hint: '코인·OTC 평균매수가 평가' }),
    kpi('어제 체결 수', sumYFills === null ? '—' : fmtInt(sumYFills), { hint: `${have.length}계정 합` }),
    kpi('페이퍼 유닛 가동', known.length ? `${running.length}/${known.length}` : '—', { status: failed.length ? 'bad' : sgStopped.length ? 'warn' : 'ok', hint: failed.length ? `실패 ${failed.map((u) => u.unit).join('·')}` : sgStopped.length ? `정지 ${sgStopped.length}` : '' }),
    kpi('스냅샷 신선도', friends?.ts ? agoFrom(friends.ts, now) : '—', { status: !friends ? 'bad' : friends.ts && now - Date.parse(friends.ts) > 2 * HOUR_MS ? 'warn' : 'ok', hint: `qa_dash ${genAt ? agoFrom(genAt, now) : '없음'}` }),
  ];
  const sections: HubSection[] = [];
  if (friends) sections.push(sec.cards('계정 (친구 3)', cards, { cols: 3, open: true, note: `7일 = ${weekFrom.slice(5)}~${yday.slice(5)} · 순익은 수수료 후 · 자본은 원가 기준 · 스냅샷 ${fmtKst(friends.ts)}` }));
  else sections.push(sec.text('계정 (친구 3)', `friends_snapshot 이 없어 계정 카드를 만들 수 없음${fr.error ? ` (${fr.error})` : ''}. 30분 타이머(friends-snapshot.timer) 와 상태 폴더를 확인.`, { open: true, note: '계정 카드 · 자본 추이 · 일별 순익 생략' }));
  if (unitCards.length) sections.push(sec.cards('라이브 페이퍼 유닛', unitCards, { cols: 3, open: true, note: `systemd --user 읽기 전용${scoreAsof ? ` · 24h 스코어 기준 ${fmtKst(scoreAsof)}` : ''} · 정지 = 주의, 실패 = 장애` }));
  if (equityChart) sections.push(equityChart);
  if (dailyChart) sections.push(dailyChart);
  if (sgTable) sections.push(tableSection(sgTable, { title: '24h A/B 스코어 (창 × 유닛)', open: false }));
  const others = (friends?.accts ?? []).filter((a) => !FRIEND_KEYS.has(a.name) && a.gauge).slice(0, 6);
  if (others.length) sections.push(sec.table('기타 계정 7일', ['계정', '회전', '순익', 'bp', '어제 순익'], others.map((a) => [a.name, a.gauge!.turn === null ? '—' : fmtKrw(a.gauge!.turn), a.gauge!.net === null ? '—' : fmtWon(a.gauge!.net), a.gauge!.netBp === null ? '—' : fmtBp(a.gauge!.netBp), yRow(a)?.net === null || yRow(a)?.net === undefined ? '—' : fmtWon(yRow(a)!.net!)]), { num: [1, 2, 3, 4], note: '친구 3계정 외 (합산하지 않음)' }));
  sections.push(sec.list('표시 색이 붉은 타일 — 이유별', redItems, { open: groups.other.length > 0, note: snap ? `qa_dash 붉은/노란 타일 ${redN} (bad ${badN} · warn ${warnN}) — 전부 의도된 상태의 표시이며 장애 ${groups.other.length}` : 'qa_dash 응답 없음' }));
  sections.push(sec.kv('스냅샷 · 소스 신선도', fresh));
  sections.push(sec.raw('원본 보기 (qa_dash)', '/hub/p/quant/', { embed: true, note: '읽기 전용 프록시 · RE 아카이브·최O용 헷지 탭은 여기서' }));

  const metrics: Record<string, HubMetricValue> = { '7일 순익': sumNet7 === null ? '—' : fmtWon(sumNet7), '어제': sumYNet === null ? '—' : fmtWon(sumYNet), '유닛 가동': known.length ? `${running.length}/${known.length}` : '—' };
  if (lastActivity) metrics['생성'] = agoFrom(lastActivity, now);
  return { id: 'quant', name: 'QUANT', state, lastActivity, metrics, alerts: sortAlerts(alerts), links, sources: [source, friendsSrc], page: page(headline, decision, kpis, sections) };
}
