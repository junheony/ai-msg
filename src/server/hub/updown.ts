/**
 * UPDOWN collector, phase 3: the PAPER trading record — not just health. 17 bot "brains" call up/down on BNB/BTC/ETH
 * every 5-minute round; 12 rounds make a 1-hour heat whose scores are bp (never money). Sources, all read-only:
 *  - prod :3090 / staging :3198 `/api/health` (GET),
 *  - the 30-day board `/api/updown/board?asset=ALL&window=30d` (GET; brain ranks, grades, streaks),
 *  - the LAB PostgreSQL through the tunnel: ONE batched `psql` call on stdin (SELECT only, read-only transaction,
 *    cached 60 s per deps). The connection URL comes from lab.env, lives only inside the loader and never reaches a
 *    name, an error, a row or a log — the source is called 'lab DB (psql)'.
 * Nothing here POSTs, ticks, stakes or writes.
 */
import type { HubAlert, HubCardItem, HubChartSeries, HubKpi, HubMetricValue, HubMode, HubSection, HubSource, HubState, HubStep } from '../../shared/hub-types';
import { DAY_MS, HUB_TIMEOUTS, HUB_URLS, SLOW_CACHE_MS, agoFrom, bool, downMode, fmtClock, fmtDate, fmtInt, fmtKst, fmtPct, isObj, kpi, latestIso, num, objs, page, probe, scrub, sec, slowCache, sortAlerts, str, toIso, type HubDeps } from './shared';

const LAB_ENV = 'bbai-updown-lab/lab.env';
const DB_SOURCE = 'lab DB (psql)';
const TUNNEL_NOTE = 'DB 터널 끊김 · board API 만 표시';
const ASSETS = ['BNB', 'BTC', 'ETH'] as const;
const CHART_DAYS = 14;
const MAX_TRADES = 50, MAX_OPEN = 120, MAX_BRAINS = 40;
const KST_TZ = 'Asia/Seoul';
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;
const utc = (col: string): string => `to_char(${col} at time zone 'UTC', ${ISO_UTC})`;

/** The whole read: SELECTs only, one section per `__SEC_` marker (psql prints `\echo` to stdout between result sets). */
const SQL = `\\echo __SEC_daily
select asset, to_char((scored_at at time zone '${KST_TZ}')::date, 'YYYY-MM-DD'), round(sum((select sum(v::numeric) from jsonb_each_text(scores) as e(k, v)))::numeric, 1)
from updown_heat where status = 'scored' and scored_at > now() - interval '16 days' group by 1, 2 order by 1, 2;
\\echo __SEC_asset7
select asset, count(*) filter (where result = 'win'), count(*) filter (where result = 'loss'), count(*) filter (where result = 'void'), count(*) filter (where result = 'abstain'), count(*) filter (where result = 'late')
from updown_brain_call where committed_at > now() - interval '7 days' group by 1 order by 1;
\\echo __SEC_brain7
select brain_id, count(*) filter (where result = 'win'), count(*) filter (where result = 'loss'), count(*) filter (where result = 'abstain')
from updown_brain_call where committed_at > now() - interval '7 days' group by 1 order by 1;
\\echo __SEC_brainbp
select e.k, round(sum(e.v::numeric)::numeric, 1) from updown_heat h, jsonb_each_text(h.scores) as e(k, v)
where h.status = 'scored' and h.scored_at > now() - interval '7 days' group by 1 order by 1;
\\echo __SEC_trades
with calls as (
  select c.asset, c.round_no, c.brain_id, c.side, c.result, c.committed_at, r.outcome
  from updown_brain_call c join updown_round r using (asset, round_no)
  where c.side is not null and c.result is not null and c.committed_at > now() - interval '2 days'
  order by c.round_no desc, c.asset, c.brain_id limit ${MAX_TRADES})
select c.asset, c.round_no, c.brain_id, c.side, c.result, coalesce(c.outcome, ''), ${utc('c.committed_at')}, coalesce(p.bp::text, '')
from calls c left join lateral (
  select round((e -> 'pnl' ->> c.brain_id)::numeric, 1) as bp from updown_heat h, jsonb_array_elements(h.rounds) e
  where h.asset = c.asset and h.scored_at > now() - interval '3 days' and (e ->> 'roundNo')::bigint = c.round_no limit 1) p on true
order by c.round_no desc, c.asset, c.brain_id;
\\echo __SEC_open
select c.asset, c.round_no, c.brain_id, c.side, ${utc('c.committed_at')}, r.status
from updown_brain_call c join updown_round r using (asset, round_no)
where r.status in ('open', 'live') and c.result is null and c.side is not null order by c.round_no desc, c.asset, c.brain_id limit ${MAX_OPEN};
\\echo __SEC_rounds
select asset, round_no, status, ${utc('open_at')}, ${utc('lock_at')}, ${utc('close_at')}, coalesce(${utc('settled_at')}, ''), coalesce(outcome, '')
from updown_round where round_no >= (select max(round_no) from updown_round) - 1 order by round_no desc, asset;
\\echo __SEC_heat
select asset, heat_no, status, ${utc('scored_at')}, array_to_string(top, ','), void_rounds from updown_heat order by scored_at desc limit 3;
\\echo __SEC_tick
select source, ${utc('last_at')}, ticks from updown_tick_source order by last_at desc limit 5;
\\echo __SEC_brains
select count(distinct brain_id) from updown_brain_call where committed_at > now() - interval '1 day';
\\echo __SEC_end
`;

/* ───────── DB record (parsed psql output) ───────── */

interface Trade { asset: string; roundNo: number; brain: string; side: string; result: string; outcome: string; at: string | null; bp: number | null }
interface OpenCall { asset: string; roundNo: number; brain: string; side: string; at: string | null; status: string }
interface RoundRow { asset: string; roundNo: number; status: string; openAt: string | null; lockAt: string | null; closeAt: string | null; settledAt: string | null; outcome: string }
interface Tally { win: number; loss: number; void: number; abstain: number; late: number }
interface DbRecord {
  /** asset → KST day (YYYY-MM-DD) → summed heat score bp. */
  daily: Map<string, Map<string, number>>;
  asset7: Map<string, Tally>;
  brain7: Map<string, { win: number; loss: number; abstain: number }>;
  brainBp7: Map<string, number>;
  trades: Trade[];
  open: OpenCall[];
  rounds: RoundRow[];
  heats: { asset: string; heatNo: number; status: string; at: string | null; top: string; voidRounds: number }[];
  ticks: { source: string; at: string | null; ticks: number }[];
  brains: number | null;
}

const n0 = (s: string | undefined): number => { const v = Number(s); return Number.isFinite(v) ? v : 0; };
const nOrNull = (s: string | undefined): number | null => (s === undefined || s === '' ? null : Number.isFinite(Number(s)) ? Number(s) : null);
const cell = (s: string | undefined, max = 40): string => scrub(s ?? '', max);

/** Splits psql's `-A -t -F \t` stdout into sections by the `__SEC_` markers; rows are tab-separated cells. */
export function parsePsqlSections(out: string): Map<string, string[][]> {
  const sections = new Map<string, string[][]>();
  let cur: string[][] | null = null;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('__SEC_')) { cur = []; sections.set(line.slice(6), cur); continue; }
    if (cur && line.length > 0) cur.push(line.split('\t'));
  }
  return sections;
}

export function parseDbRecord(out: string): DbRecord {
  const s = parsePsqlSections(out);
  if (!s.has('end')) throw new Error('incomplete');
  const rows = (k: string): string[][] => s.get(k) ?? [];
  const daily = new Map<string, Map<string, number>>();
  for (const r of rows('daily')) { const a = cell(r[0], 8); if (!daily.has(a)) daily.set(a, new Map()); daily.get(a)!.set(cell(r[1], 10), n0(r[2])); }
  const asset7 = new Map<string, Tally>();
  for (const r of rows('asset7')) asset7.set(cell(r[0], 8), { win: n0(r[1]), loss: n0(r[2]), void: n0(r[3]), abstain: n0(r[4]), late: n0(r[5]) });
  const brain7 = new Map<string, { win: number; loss: number; abstain: number }>();
  for (const r of rows('brain7')) brain7.set(cell(r[0]), { win: n0(r[1]), loss: n0(r[2]), abstain: n0(r[3]) });
  const brainBp7 = new Map<string, number>();
  for (const r of rows('brainbp')) brainBp7.set(cell(r[0]), n0(r[1]));
  const trades: Trade[] = rows('trades').slice(0, MAX_TRADES).map((r) => ({ asset: cell(r[0], 8), roundNo: n0(r[1]), brain: cell(r[2]), side: cell(r[3], 8), result: cell(r[4], 10), outcome: cell(r[5], 8), at: toIso(r[6]), bp: nOrNull(r[7]) }));
  const open: OpenCall[] = rows('open').slice(0, MAX_OPEN).map((r) => ({ asset: cell(r[0], 8), roundNo: n0(r[1]), brain: cell(r[2]), side: cell(r[3], 8), at: toIso(r[4]), status: cell(r[5], 10) }));
  const rounds: RoundRow[] = rows('rounds').slice(0, 12).map((r) => ({ asset: cell(r[0], 8), roundNo: n0(r[1]), status: cell(r[2], 10), openAt: toIso(r[3]), lockAt: toIso(r[4]), closeAt: toIso(r[5]), settledAt: toIso(r[6]), outcome: cell(r[7], 8) }));
  const heats = rows('heat').slice(0, 3).map((r) => ({ asset: cell(r[0], 8), heatNo: n0(r[1]), status: cell(r[2], 10), at: toIso(r[3]), top: cell(r[4], 80), voidRounds: n0(r[5]) }));
  const ticks = rows('tick').slice(0, 5).map((r) => ({ source: cell(r[0], 20), at: toIso(r[1]), ticks: n0(r[2]) }));
  const brains = nOrNull(rows('brains')[0]?.[0]);
  return { daily, asset7, brain7, brainBp7, trades, open, rounds, heats, ticks, brains };
}

/** `DATABASE_URL=…` (optionally `export`ed, optionally quoted) from lab.env; the value is returned, never kept. */
export function parseDatabaseUrl(envText: string): string | null {
  for (const raw of envText.split('\n')) {
    const m = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[1] ?? '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.length > 0 ? v : null;
  }
  return null;
}

/** Why the last psql load failed, per deps: a fixed, URL-free phrase (slowCache would flatten it to '오류'). */
const lastReason = new WeakMap<HubDeps, string>();
const fail = (deps: HubDeps, why: string): never => { lastReason.set(deps, why); throw new Error(why); };

/** One psql run (read-only transaction, fixed argv, SQL on stdin). Throws a fixed, URL-free reason on any failure. */
async function loadDb(deps: HubDeps): Promise<DbRecord> {
  if (!deps.exec) return fail(deps, '실행 불가');
  const env = await deps.readText(`${deps.home}/${LAB_ENV}`);
  const url = env === null ? null : parseDatabaseUrl(env);
  if (!url) return fail(deps, '설정 없음');
  const out = await deps.exec('psql', [url, '-X', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1'], { timeoutMs: HUB_TIMEOUTS.psql, env: { PGOPTIONS: '-c default_transaction_read_only=on', PGCONNECT_TIMEOUT: '4' }, stdin: SQL });
  if (out === null) return fail(deps, '연결 실패');
  let rec: DbRecord;
  try { rec = parseDbRecord(out); } catch { return fail(deps, '응답 형식 오류'); }
  lastReason.delete(deps);
  return rec;
}

/** The 60 s cache keyed by the deps object (tests get a fresh cache per fake deps). */
const dbCache = new WeakMap<HubDeps, ReturnType<typeof slowCache<DbRecord>>>();
function cachedDb(deps: HubDeps): ReturnType<typeof slowCache<DbRecord>> {
  let c = dbCache.get(deps);
  if (!c) { c = slowCache<DbRecord>(SLOW_CACHE_MS.psql, () => loadDb(deps), deps.now); dbCache.set(deps, c); }
  return c;
}

/* ───────── labels ───────── */

const SIDE_KO: Record<string, string> = { up: '상승', down: '하락' };
const RESULT_KO: Record<string, string> = { win: '승', loss: '패', void: '무효', abstain: '기권', late: '지각' };
const ROUND_KO: Record<string, string> = { open: '오픈', live: '진행 중', settled: '정산', void: '무효' };
const GRADE_KO: Record<string, string> = { EDGE: '엣지', UNPROVEN: '미입증', LOST: '상실' };
const ko = (m: Record<string, string>, v: string): string => m[v] ?? scrub(v, 12);
const fmtBp = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
const bpStatus = (v: number): 'ok' | 'bad' | 'info' => (v > 0 ? 'ok' : v < 0 ? 'bad' : 'info');
const rate = (win: number, loss: number): number | null => (win + loss > 0 ? (100 * win) / (win + loss) : null);
const fmtRate = (r: number | null): string => (r === null ? '—' : fmtPct(r, 1));

/** The last `days` KST calendar days ending today, oldest first, as YYYY-MM-DD. */
function kstDays(nowMs: number, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(fmtDate(new Date(nowMs - i * DAY_MS).toISOString()));
  return out;
}

/* ───────── the collector ───────── */

export async function collectUpdown(deps: HubDeps): Promise<HubMode> {
  const [prod, staging, board, db] = await Promise.all([
    probe(deps, 'app :3090', HUB_URLS.updown, HUB_TIMEOUTS.default),
    probe(deps, 'staging :3198', HUB_URLS.updownStaging, HUB_TIMEOUTS.default),
    probe(deps, 'board API', HUB_URLS.updownBoard, HUB_TIMEOUTS.default),
    (async () => { const t0 = deps.now(); const r = await cachedDb(deps)(); return { ...r, error: r.error === null ? null : lastReason.get(deps) ?? r.error, ms: deps.now() - t0 }; })(),
  ]);
  const dbSource: HubSource = { name: DB_SOURCE, ok: db.error === null && db.value !== null, ms: db.ms, ...(db.error !== null ? { error: db.error } : db.value === null ? { error: '응답 없음' } : {}) };
  const sources = [prod.source, staging.source, board.source, dbSource];
  const p = isObj(prod.data) ? prod.data : null;
  const sData = isObj(staging.data) ? staging.data : null;
  const fleet = isObj(board.data) && isObj(board.data.board) ? objs(board.data.board.fleet).slice(0, MAX_BRAINS) : null;
  // The record: the DB answer (fresh or stale) — null means "tunnel down, board only".
  const rec = db.value;
  if (!p && !fleet) {
    const m = downMode('updown', 'UPDOWN', prod.source);
    return { ...m, sources, tag: 'PAPER' };
  }

  const now = deps.now();
  const alerts: HubAlert[] = [];
  let state: HubState = 'ok';
  const worst = (s: HubState): void => { const rank: Record<HubState, number> = { ok: 0, idle: 1, unknown: 1, warn: 2, down: 3 }; if (rank[s] > rank[state]) state = s; };

  /* health (kept from the old collector) */
  const dbFlag = p ? bool(p.db) : null;
  const stagingText = sData ? (sData.ok === true ? (sData.db === false ? 'DB 끊김' : '정상') : '주의') : '응답 없음';
  if (!p) { alerts.push({ level: 'bad', text: `프로덕션 응답 없음 · ${prod.source.error ?? '오류'}` }); worst('down'); }
  else if (p.ok !== true) { alerts.push({ level: 'bad', text: '앱 상태 비정상' }); worst('down'); }
  if (dbFlag === false) { alerts.push({ level: 'bad', text: '앱 DB 연결 끊김' }); worst('down'); }
  if (!sData) { alerts.push({ level: 'warn', text: `스테이징 응답 없음 · ${staging.source.error ?? '오류'}` }); worst('warn'); }
  else if (sData.ok !== true || sData.db === false) { alerts.push({ level: 'warn', text: `스테이징 ${stagingText}` }); worst('warn'); }
  if (!fleet) { alerts.push({ level: 'warn', text: `board API 응답 없음 · ${board.source.error ?? '오류'}` }); worst('warn'); }
  if (!rec) { alerts.push({ level: 'warn', text: TUNNEL_NOTE, hint: `psql ${db.error ?? '응답 없음'} — bbai-lab-tunnel.service 확인` }); worst('warn'); }
  else if (db.stale) { alerts.push({ level: 'warn', text: `DB 터널 불안정 · 캐시 ${agoFrom(db.at ? new Date(db.at).toISOString() : null, now)}` }); worst('warn'); }

  /* the record */
  const days = kstDays(now, CHART_DAYS);
  const today = days[days.length - 1] ?? '', yesterday = days[days.length - 2] ?? '';
  const dayBp = (asset: string, day: string): number | null => rec?.daily.get(asset)?.get(day) ?? null;
  const sumAssets = (day: string): number | null => { let s: number | null = null; for (const a of ASSETS) { const v = dayBp(a, day); if (v !== null) s = (s ?? 0) + v; } return s; };
  const sumDays = (asset: string | null, list: string[]): number | null => { let s: number | null = null; for (const d of list) { const v = asset ? dayBp(asset, d) : sumAssets(d); if (v !== null) s = (s ?? 0) + v; } return s; };
  const week = days.slice(-7);
  const total7: Tally = { win: 0, loss: 0, void: 0, abstain: 0, late: 0 };
  if (rec) for (const t of rec.asset7.values()) { total7.win += t.win; total7.loss += t.loss; total7.void += t.void; total7.abstain += t.abstain; total7.late += t.late; }
  const rate7 = rate(total7.win, total7.loss);
  const bp7 = sumDays(null, week), bpToday = sumAssets(today), bpYesterday = sumAssets(yesterday);
  const openCalls = rec ? rec.open.length : null;
  const latestRound = rec?.rounds[0] ?? null;
  const roundNo = latestRound?.roundNo ?? (fleet ? Math.max(0, ...fleet.map((f) => num(f.lastRoundNo) ?? 0)) || null : null);
  const roundStatus = latestRound ? ko(ROUND_KO, latestRound.status) : null;
  const worker = rec?.ticks.find((t) => t.source === 'worker') ?? rec?.ticks[0] ?? null;
  const workerAgeMs = worker?.at ? now - Date.parse(worker.at) : null;
  const brainCount = rec?.brains ?? (fleet ? fleet.length : null);

  /* stalls → alerts */
  if (workerAgeMs !== null && workerAgeMs > 10 * 60_000) { alerts.push({ level: 'warn', text: `틱 워커 정지 · 마지막 틱 ${agoFrom(worker?.at ?? null, now)}`, at: worker?.at ?? null }); worst('warn'); }
  if (latestRound?.closeAt && now - Date.parse(latestRound.closeAt) > 15 * 60_000) { alerts.push({ level: 'warn', text: `라운드 정체 · #${latestRound.roundNo} 종료 ${agoFrom(latestRound.closeAt, now)}`, at: latestRound.closeAt }); worst('warn'); }
  for (const h of rec?.heats ?? []) if (h.status === 'void') alerts.push({ level: 'info', text: `${h.asset} 히트 #${h.heatNo} 무효`, at: h.at });

  /* brains: board (30d) + DB (7d) */
  interface BrainRow { id: string; name: string; rule: string; control: boolean; n: number | null; hitRate: number | null; edge: number | null; grade: string; streak: number | null; best: number | null; win7: number | null; loss7: number | null; bp7: number | null }
  const brains: BrainRow[] = (fleet ?? []).map((f) => {
    const id = str(f.id, 40) ?? '';
    const d7 = rec?.brain7.get(id);
    return { id, name: scrub(f.name, 40) || id, rule: scrub(f.rule, 120), control: f.control === true, n: num(f.n), hitRate: num(f.hitRate), edge: num(f.edge), grade: str(f.grade, 12) ?? '', streak: num(f.streak), best: num(f.bestStreak), win7: d7?.win ?? null, loss7: d7?.loss ?? null, bp7: rec?.brainBp7.get(id) ?? null };
  });
  const nameOf = new Map(brains.map((b) => [b.id, b.name]));
  const brainName = (id: string): string => nameOf.get(id) ?? id;
  if (!fleet && rec) for (const [id, bp] of rec.brainBp7) { const d7 = rec.brain7.get(id); brains.push({ id, name: id, rule: '', control: false, n: null, hitRate: null, edge: null, grade: '', streak: null, best: null, win7: d7?.win ?? null, loss7: d7?.loss ?? null, bp7: bp }); }
  brains.sort((a, b) => (b.bp7 ?? b.edge ?? -Infinity) - (a.bp7 ?? a.edge ?? -Infinity));
  const scored = brains.filter((b) => b.bp7 !== null && !b.control);
  const best = scored[0] ?? null, worstBrain = scored[scored.length - 1] ?? null;
  const streaker = brains.filter((b) => (b.streak ?? 0) >= 5).sort((a, b) => (b.streak ?? 0) - (a.streak ?? 0))[0] ?? null;
  const lost = brains.filter((b) => b.grade === 'LOST' && !b.control).length;
  if (lost > 0) alerts.push({ level: 'info', text: `등급 상실(LOST) 브레인 ${lost}개 (30일 보드)` });

  /* headline · decision · KPIs */
  const headParts = ['페이퍼'];
  headParts.push(rate7 !== null ? `7일 승률 ${fmtRate(rate7)} (${fmtInt(total7.win + total7.loss)}콜)` : rec ? '7일 콜 없음' : TUNNEL_NOTE);
  if (bpYesterday !== null) headParts.push(`어제 ${fmtBp(bpYesterday)} bp`);
  if (openCalls !== null) headParts.push(`열린 콜 ${openCalls}`);
  if (roundNo) headParts.push(`라운드 #${roundNo}${roundStatus ? ` ${roundStatus}` : ''}`);
  const headline = headParts.join(' · ');
  const decision = !p ? '프로덕션 :3090 응답 없음 — 서비스 가동 여부 확인'
    : dbFlag === false ? '앱 DB 끊김 — 로그 확인'
    : !rec ? `DB 터널 끊김 (${db.error ?? '응답 없음'}) — bbai-lab-tunnel.service 확인 · 보드만 표시`
    : workerAgeMs !== null && workerAgeMs > 10 * 60_000 ? `틱 워커 정지 ${agoFrom(worker?.at ?? null, now)} — worker 확인`
    : latestRound?.closeAt && now - Date.parse(latestRound.closeAt) > 15 * 60_000 ? `라운드 정체 #${latestRound.roundNo} — 라운드 크론 확인`
    : !fleet ? 'board API 응답 없음 — 앱 로그 확인 · DB 기록은 정상'
    : worstBrain && best ? `볼 것: 최악 ${worstBrain.name} 7일 ${fmtBp(worstBrain.bp7 ?? 0)} bp · 최고 ${best.name} ${fmtBp(best.bp7 ?? 0)} bp${streaker ? ` · ${streaker.name} ${streaker.streak}연승` : ''}`
    : '조치 없음';
  const kpis: HubKpi[] = [
    kpi('7일 승률', fmtRate(rate7), { status: rate7 === null || rate7 < 50 ? 'info' : 'ok', hint: rec ? `승 ${fmtInt(total7.win)} · 패 ${fmtInt(total7.loss)} · 기권 ${fmtInt(total7.abstain)}` : TUNNEL_NOTE }),
    kpi('7일 누적', bp7 === null ? '—' : fmtBp(bp7), { unit: 'bp', status: bp7 === null ? 'info' : bpStatus(bp7), hint: '히트 점수 합계 · 17 브레인 · 3 자산' }),
    kpi('오늘', bpToday === null ? '—' : fmtBp(bpToday), { unit: 'bp', status: bpToday === null ? 'info' : bpStatus(bpToday), hint: bpYesterday === null ? 'KST 기준' : `어제 ${fmtBp(bpYesterday)} bp` }),
    kpi('열린 콜', openCalls === null ? '—' : fmtInt(openCalls), { status: openCalls === null ? 'info' : 'ok', hint: '오픈·진행 중 라운드의 콜' }),
    kpi('브레인', brainCount === null ? '—' : fmtInt(brainCount), { status: 'info', hint: fleet ? `보드 ${fleet.length}개` : '보드 없음' }),
    kpi('최근 라운드', roundNo ? `#${roundNo}` : '—', { status: latestRound && now - Date.parse(latestRound.closeAt ?? '') > 15 * 60_000 ? 'warn' : 'ok', hint: latestRound ? `${roundStatus} · 종료 ${fmtClock(latestRound.closeAt)}` : '' }),
  ];
  const lastHeat = rec?.heats[0] ?? null;
  if (lastHeat) kpis.push(kpi('최근 히트', `#${lastHeat.heatNo}`, { status: lastHeat.status === 'void' ? 'warn' : 'ok', hint: `${fmtKst(lastHeat.at)} · 1위 ${lastHeat.top || '—'}` }));

  /* sections */
  const sections: HubSection[] = [];
  const tunnelNote = sec.text('DB 기록', TUNNEL_NOTE, { note: `psql ${db.error ?? '응답 없음'}`, open: true });
  if (rec) {
    const label = (d: string): string => d.slice(5);
    const series: HubChartSeries[] = [
      { name: 'BNB', values: days.map((d) => dayBp('BNB', d)), style: 'bar', color: 'warn' },
      { name: 'BTC', values: days.map((d) => dayBp('BTC', d)), style: 'bar', color: 'accent' },
      { name: 'ETH', values: days.map((d) => dayBp('ETH', d)), style: 'bar', color: 'muted' },
    ];
    let cum = 0; let seen = false;
    series.push({ name: '누적(합계)', values: days.map((d) => { const v = sumAssets(d); if (v === null) return seen ? cum : null; seen = true; cum += v; return Math.round(cum * 10) / 10; }), style: 'line', color: 'ok' });
    sections.push(sec.chart(`일별 손익(bp) ${CHART_DAYS}일`, days.map(label), series, { unit: 'bp', zero: true, open: true, note: 'KST 일 기준 · 히트 점수(17 브레인 합계) · 누적은 14일 시작부터' }));
    sections.push(sec.table(`최근 트레이드(콜) ${rec.trades.length}건`, ['시각(KST)', '자산', '브레인', '방향', '결과', 'bp', '라운드'],
      rec.trades.map((t) => [fmtKst(t.at), t.asset, brainName(t.brain), ko(SIDE_KO, t.side), ko(RESULT_KO, t.result), t.bp === null ? '—' : fmtBp(t.bp), `#${t.roundNo}`]),
      { open: true, num: [5, 6], note: '채점된 콜만 · 기권 제외 · 히트 채점 전 콜은 bp —' }));
  } else sections.push(tunnelNote);
  if (brains.length > 0) {
    sections.push(sec.table(`브레인 성적 (30일 보드${rec ? ' + 7일 DB' : ''})`, ['이름', '규칙', 'n', '승률', '엣지', '등급', '연승', '7일 승/패', '7일 bp'],
      brains.map((b) => [b.control ? `${b.name} (대조군)` : b.name, b.rule, b.n === null ? '—' : fmtInt(b.n), b.hitRate === null ? '—' : fmtPct(b.hitRate * 100, 1), b.edge === null ? '—' : `${b.edge >= 0 ? '+' : '−'}${fmtPct(Math.abs(b.edge) * 100, 2)}p`, b.grade ? ko(GRADE_KO, b.grade) : '—', b.streak === null ? '—' : `${b.streak}${b.best !== null ? ` / 최고 ${b.best}` : ''}`, b.win7 === null ? '—' : `${fmtInt(b.win7)} / ${fmtInt(b.loss7 ?? 0)}`, b.bp7 === null ? '—' : fmtBp(b.bp7)]),
      { open: true, num: [2, 3, 4, 6, 7, 8], wrap: [1], note: `7일 bp 순 · 엣지 = 적중률 − 기준선(%p)${fleet ? '' : ' · 보드 없음: DB 7일만'}` }));
  }
  if (rec) {
    const ups = rec.open.filter((c) => c.side === 'up').length;
    sections.push(sec.table(`열린 콜 ${rec.open.length}건 (현재 라운드)`, ['자산', '라운드', '브레인', '방향', '콜 시각(KST)', '라운드 상태'],
      rec.open.map((c) => [c.asset, `#${c.roundNo}`, brainName(c.brain), ko(SIDE_KO, c.side), fmtKst(c.at), ko(ROUND_KO, c.status)]),
      { num: [1], note: `상승 ${ups} · 하락 ${rec.open.length - ups} · 기권 제외` }));
    const cards: HubCardItem[] = ASSETS.map((a) => {
      const t = rec.asset7.get(a) ?? { win: 0, loss: 0, void: 0, abstain: 0, late: 0 };
      const r = rate(t.win, t.loss), w = sumDays(a, week), y = dayBp(a, yesterday), td = dayBp(a, today);
      return {
        title: a, badge: '페이퍼', state: r === null ? 'idle' : 'ok', sub: `7일 ${fmtInt(t.win + t.loss)}콜 · 기권 ${fmtInt(t.abstain)}`,
        rows: [
          { label: '7일 승률', value: fmtRate(r), ...(r !== null ? { status: r >= 50 ? 'ok' as const : 'info' as const } : {}) },
          { label: '7일 누적', value: w === null ? '—' : `${fmtBp(w)} bp`, ...(w !== null ? { status: bpStatus(w) } : {}) },
          { label: '오늘', value: td === null ? '—' : `${fmtBp(td)} bp`, ...(td !== null ? { status: bpStatus(td) } : {}) },
          { label: '어제', value: y === null ? '—' : `${fmtBp(y)} bp`, ...(y !== null ? { status: bpStatus(y) } : {}) },
        ],
        spark: { values: days.map((d) => dayBp(a, d)), label: `일별 bp ${CHART_DAYS}일`, unit: 'bp' },
      };
    });
    sections.push(sec.cards('자산별', cards, { cols: 3 }));
    if (latestRound) {
      const phase = (at: string | null): HubStep['state'] => (at && Date.parse(at) <= now ? 'done' : 'todo');
      const items: HubStep[] = [
        { label: '오픈', state: phase(latestRound.openAt), hint: fmtClock(latestRound.openAt) },
        { label: '락', state: phase(latestRound.lockAt), hint: fmtClock(latestRound.lockAt) },
        { label: '종료', state: phase(latestRound.closeAt), hint: fmtClock(latestRound.closeAt) },
        { label: '정산', state: latestRound.status === 'settled' ? 'done' : latestRound.status === 'void' ? 'blocked' : 'todo', hint: latestRound.settledAt ? fmtClock(latestRound.settledAt) : latestRound.status === 'void' ? '무효' : '대기' },
      ];
      const active = items.find((s) => s.state === 'todo'); if (active) active.state = 'active';
      const perAsset = rec.rounds.filter((r) => r.roundNo === latestRound.roundNo).map((r) => `${r.asset} ${ko(ROUND_KO, r.status)}`).join(' · ');
      sections.push(sec.steps(`라운드 #${latestRound.roundNo}`, items, { note: `5분 라운드 · 12 라운드 = 1 히트 · ${perAsset}` }));
    }
  }
  const envRows: [string, string][] = [
    ['프로덕션 :3090', p ? `${p.ok === true ? '정상' : '비정상'} · DB ${dbFlag === null ? '미확인' : dbFlag ? '연결됨' : '끊김'} · 헬스 ${fmtKst(toIso(p.ts))} · ${prod.source.ms} ms` : `응답 없음 · ${prod.source.error ?? '오류'}`],
    ['스테이징 :3198', sData ? `${stagingText} · 헬스 ${fmtKst(toIso(sData.ts))} · ${staging.source.ms} ms` : `응답 없음 · ${staging.source.error ?? '오류'}`],
    ['보드 API', fleet ? `정상 · 브레인 ${fleet.length} · ${board.source.ms} ms` : `응답 없음 · ${board.source.error ?? '오류'}`],
    ['DB 터널', rec ? `${db.stale ? `불안정 (${db.error ?? '오류'}) · 캐시` : '정상 ·'} ${agoFrom(db.at ? new Date(db.at).toISOString() : null, now)} 조회 · ${db.ms} ms` : `끊김 · ${db.error ?? '응답 없음'}`],
  ];
  if (worker) envRows.push(['틱 워커', `${agoFrom(worker.at, now)} · 틱 ${fmtInt(worker.ticks)}`]);
  if (latestRound) envRows.push(['마지막 라운드', `#${latestRound.roundNo} ${roundStatus ?? ''} · 오픈 ${fmtKst(latestRound.openAt)} · 종료 ${fmtClock(latestRound.closeAt)}`]);
  if (lastHeat) envRows.push(['마지막 히트', `#${lastHeat.heatNo} ${lastHeat.status === 'void' ? '무효' : '채점'} · ${fmtKst(lastHeat.at)} · 1위 ${lastHeat.top || '—'}`]);
  sections.push(sec.kv('환경', envRows, { open: !rec }));

  const metrics: Record<string, HubMetricValue> = { '앱': p ? (p.ok === true ? '정상' : '주의') : '응답 없음', 'DB': dbFlag === null ? '미확인' : dbFlag ? '연결됨' : '끊김', '스테이징': stagingText };
  if (rate7 !== null) metrics['7일 승률'] = fmtRate(rate7);
  if (bp7 !== null) metrics['7일 bp'] = `${fmtBp(bp7)} bp`;
  if (openCalls !== null) metrics['열린 콜'] = openCalls;
  if (!rec) metrics['DB 터널'] = '끊김';
  const lastActivity = latestIso(rec?.open[0]?.at ?? null, rec?.trades[0]?.at ?? null, worker?.at ?? null, p ? toIso(p.ts) : null, sData ? toIso(sData.ts) : null) ?? new Date(now).toISOString();
  return { id: 'updown', name: 'UPDOWN', state, lastActivity, metrics, alerts: sortAlerts(alerts), links: [], sources, tag: 'PAPER', page: page(headline, decision, kpis, sections) };
}
