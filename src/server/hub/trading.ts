/**
 * Trading Room collector (phase 3): the work in arbitrage-nexus, read-only. The go-live checklist and readiness steps
 * (~/.local/state/go_live_status.json), paper results by mode (maker_paper.json, live_desk.json), the wave paper
 * ledger (wave_paper.db via `python3 -I`, read-only sqlite URI), the pump-shadow detector table (mmp_pump_shadow.db),
 * the lane scorecard (docs/레인성적표_최신.md), the last commits (`git log`) and the four 2-minute timers
 * (`systemctl --user show`). On top of that, the merged read-only view of the two trading bots (`mode.trading`): the
 * Trading Room (:8830, snapshot fallback — tradingRoom.ts) and 트레이딩-ver2 (:8771 paper engine + :8793 ledger — cblabx.ts).
 * Nothing here runs or changes anything.
 */
import path from 'node:path';
import type { HubAlert, HubKpi, HubMetricValue, HubMode, HubSection, HubSource, HubState, TradingBotRow, TradingMerged } from '../../shared/hub-types';
import { collectVer2, kstToIso } from './cblabx';
import { DAY_MS, HUB_TIMEOUTS, UNIT_STATE_KO, agoFrom, arr, fmtAgo, fmtInt, fmtKst, fmtNum, fmtPct, fmtUsd, isObj, kpi, latestIso, num, objs, page, scrub, sec, showUnit, slowCache, sortAlerts, str, toIso, type HubDeps, type UnitInfo } from './shared';
import { collectRoom } from './tradingRoom';

export const TRADING_DIR = 'arbitrage-nexus';
export const TRADING_STATE_DIR = '.local/state';
export const LANE_DOC = 'docs/레인성적표_최신.md';
/** The four state writers: each timer (OnUnitActiveSec=2min) rewrites one file; a file older than 2× the period is stale. */
export const TRADING_TIMERS = [
  { timer: 'go-live-status.timer', service: 'go-live-status.service', label: '출격 준비', file: 'go_live_status.json', periodMs: 120_000 },
  { timer: 'maker-paper.timer', service: 'maker-paper.service', label: '메이커 페이퍼', file: 'maker_paper.json', periodMs: 120_000 },
  { timer: 'live-desk.timer', service: 'live-desk.service', label: '라이브 데스크', file: 'live_desk.json', periodMs: 120_000 },
  { timer: 'wave-paper.timer', service: 'wave-paper.service', label: '웨이브 페이퍼', file: 'wave_paper.db', periodMs: 120_000 },
] as const;
const STALE_FACTOR = 2;
const GO_LIVE_FILE = 'go_live_status.json';
const NO_DATA = '데이터 없음';
/** The sum of what is reported; null when nothing is. */
const sumOf = (vs: (number | null)[]): number | null => { const got = vs.filter((v): v is number => v !== null); return got.length ? got.reduce((a, b) => a + b, 0) : null; };
const usdSigned = (v: number | null): string => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const SLOW_MS = 60_000;
const MAX_ROWS = 60;
const GROUP_KO: Record<string, string> = { keys: '키', smoke: '실측', lane: '이송 레인', engine: '엔진', config: '설정', bybit: '바이빗', switch: '스위치' };

/**
 * Read-only sqlite summary of the wave ledger and the pump-shadow events, as one JSON line. `-I` isolates the interpreter;
 * the URIs are `mode=ro`; argv[1]/argv[2] are the two db paths (never printed). Missing or locked → that part is an error.
 */
export const SQLITE_PY = `
import json, sqlite3, sys
def q(p, fn):
    try:
        c = sqlite3.connect('file:' + p + '?mode=ro', uri=True)
        try:
            c.execute('pragma query_only=1')
            return fn(c)
        finally:
            c.close()
    except Exception as e:
        return {'error': type(e).__name__}
def wave(c):
    acts = {r[0]: [r[1], r[2] or 0.0] for r in c.execute("select action, count(*), sum(pnl) from wave group by action")}
    sells = [dict(ts=r[0], sym=r[1], gap=r[2], size=r[3], pnl=r[4], venue=r[5], note=r[6]) for r in c.execute("select ts, sym, gap, size, pnl, buy_venue, note from wave where action='sell' order by ts desc limit 10")]
    pos = c.execute("select count(*), coalesce(sum(inv), 0) from pos").fetchone()
    return dict(actions=acts, sells=sells, pos_n=pos[0], pos_inv=pos[1], last_ts=c.execute("select max(ts) from wave").fetchone()[0])
def mmp(c):
    rows = [dict(det=r[0], variant=r[1], n=r[2], done=r[3], hit=r[4], last=r[5]) for r in c.execute("select det, variant, count(*), coalesce(sum(done), 0), coalesce(sum(hit), 0), max(ts_fire) from event group by det, variant order by count(*) desc limit 20")]
    return dict(n=c.execute("select count(*) from event").fetchone()[0], rows=rows)
print(json.dumps({'wave': q(sys.argv[1], wave), 'mmp': q(sys.argv[2], mmp)}))
`.trim();

/* ───────── text helpers ───────── */

const TILDE = '';
/** `scrub`, but `~/…` (relative to home, names nobody) survives; absolute home paths are still blanked. */
export const text = (v: unknown, max = 200): string => scrub(typeof v === 'string' ? v.replace(/~\//g, TILDE) : v, max).split(TILDE).join('~/');
const signed = (v: number | null, digits = 2, unit = '%'): string => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}${unit}`);
const signedInt = (v: number | null): string => (v === null ? '—' : `${v > 0 ? '+' : ''}${fmtInt(v)}`);
const epochIso = (v: unknown): string | null => toIso(num(v));
const yes = (v: unknown): string => (v === true ? '예' : v === false ? '아니오' : '—');

/* ───────── go-live ───────── */

export interface GoLiveCheck { id: string; group: string; ok: boolean; label: string; detail: string; next: string }

export function parseChecks(gl: Record<string, unknown> | null): GoLiveCheck[] {
  return gl ? objs(gl.checks).map((c) => ({ id: str(c.id, 60) ?? '', group: str(c.group, 20) ?? '', ok: c.ok === true, label: text(c.label, 80), detail: text(c.detail, 160), next: text(c.next, 160) })) : [];
}

/** 키 입력 → 키 점검 → 소액 실측 → 레인 설정 → T2 섀도 게이트 → 자동: done from the checks/ready flags, the first undone step is active. */
/** Failing first, source order otherwise; at most MAX_ROWS. */

/* ───────── paper ───────── */

/** maker_paper by_mode + live_desk paper.by_mode as one table: 출처, 모드, n, 중앙값, 승률, 체결·미체결, 메모. */
export function paperRows(maker: Record<string, unknown> | null, desk: Record<string, unknown> | null): string[][] {
  const rows: string[][] = [];
  const paper = desk && isObj(desk.paper) ? desk.paper : null;
  if (paper) {
    const n = num(paper.n), med = num(paper.median), win = num(paper.win);
    rows.push(['라이브 데스크', '전체', n === null ? '—' : fmtInt(n), signed(med), win === null ? '—' : fmtPct(win), '—', `TP 도달 ${fmtInt(num(paper.reached_tp) ?? 0)} · 최고 ${signed(num(paper.best))} · 최저 ${signed(num(paper.worst))}`]);
    const byMode = isObj(paper.by_mode) ? Object.entries(paper.by_mode).filter((e): e is [string, Record<string, unknown>] => isObj(e[1])) : [];
    for (const [mode, m] of byMode.sort((a, b) => (num(b[1].median) ?? -1e9) - (num(a[1].median) ?? -1e9))) {
      const n = num(m.n), med = num(m.median), win = num(m.win);
      rows.push(['라이브 데스크', text(mode, 20), n === null ? '—' : fmtInt(n), signed(med), win === null ? '—' : fmtPct(win), '—', `평균 ${signed(num(m.mean))} · TP ${fmtInt(num(m.reached_tp) ?? 0)}`]);
    }
  }
  if (maker) {
    const n = num(maker.n_both), med = num(maker.both_med), fill = num(maker.fill_rate_pct), unf = num(maker.unfilled_pct);
    rows.push(['메이커', '전체(양다리)', n === null ? '—' : fmtInt(n), signed(med), '—', `${fill === null ? '—' : fmtPct(fill)} / ${unf === null ? '—' : fmtPct(unf)}`, `vs 테이커 ${signed(num(maker.vs_taker_med))} · 한다리 ${num(maker.oneleg_pct) === null ? '—' : fmtPct(num(maker.oneleg_pct)!)}`]);
    const byMode = isObj(maker.by_mode) ? Object.entries(maker.by_mode).filter((e): e is [string, Record<string, unknown>] => isObj(e[1])) : [];
    for (const [mode, m] of byMode) {
      const n = num(m.n_settled) ?? num(m.n), med = num(m.med), fill = num(m.strict_fill_rate), unf = num(m['미체결_pct']);
      rows.push(['메이커', text(mode, 20), n === null ? '—' : fmtInt(n), signed(med), '—', `${fill === null ? '—' : fmtPct(fill)} / ${unf === null ? '—' : fmtPct(unf)}`, `EV 엄격 ${signed(num(m.ev_strict_med))} · vs 테이커 ${signed(num(m.vs_taker_med))}`]);
    }
    const slices = isObj(maker.by_slice) ? Object.entries(maker.by_slice).filter((e): e is [string, Record<string, unknown>] => isObj(e[1])) : [];
    for (const [slice, s] of slices.sort((a, b) => (num(b[1].strict_med) ?? -1e9) - (num(a[1].strict_med) ?? -1e9)).slice(0, 3)) {
      const n = num(s.n), med = num(s.strict_med), win = num(s.strict_win), fill = num(s.strict_fill_pct);
      rows.push(['메이커 슬라이스', text(slice, 30), n === null ? '—' : fmtInt(n), signed(med), win === null ? '—' : fmtPct(win), fill === null ? '—' : fmtPct(fill), `낙관 ${signed(num(s.opt_med))} · 승 ${num(s.opt_win) === null ? '—' : fmtPct(num(s.opt_win)!)}`]);
    }
  }
  return rows.slice(0, MAX_ROWS);
}

/* ───────── lanes ───────── */

export interface LaneDoc { date: string | null; alive: number | null; dead: number | null; collecting: number | null; verdictAt: string | null; ledger: string | null; columns: string[]; rows: string[][] }

const VERDICT_RANK: Record<string, number> = { '살았다': 0, '죽었다': 1, '수집중': 2 };
const cell = (s: string): string => s.replace(/\*\*/g, '').replace(/\s*⚠\s*/g, '').trim();

/** The scorecard markdown: the header date, the 살았다/죽었다/수집중 line, the 돈 판정표 date, the ledger line and the first table. */
export function parseLaneDoc(md: string | null): LaneDoc | null {
  if (!md) return null;
  const date = /^#\s*레인 성적표\s*[—-]+\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/m.exec(md)?.[1] ?? null;
  const counts = /살았다\s*(\d+)\s*·\s*죽었다\s*(\d+)\s*·\s*수집중\s*(\d+)/.exec(md);
  const verdictAt = toIso(/돈 판정표.*?적은 날\s*([0-9T:+-]+)/.exec(md)?.[1] ?? null);
  const ledger = /^- (원장 30일 .+)$/m.exec(md)?.[1] ?? null;
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  const split = (l: string): string[] => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => cell(c));
  const columns = lines[0] ? split(lines[0]) : [];
  const rows: string[][] = [];
  for (const l of lines.slice(1)) {
    const cells = split(l);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (cells.length !== columns.length) break; // a second table or a broken row ends the first
    rows.push(cells);
  }
  return { date, alive: counts ? Number(counts[1]) : null, dead: counts ? Number(counts[2]) : null, collecting: counts ? Number(counts[3]) : null, verdictAt, ledger: ledger ? text(ledger, 120) : null, columns, rows };
}

const LANE_COLS = ['레인', '가설', '30일 n', '비용 뒤(주 시평)', '적중률', '플라시보', '자동', '사람', '다음 판정 조건'] as const;

/** 살았다 → 죽었다 → 수집중, bigger samples first; the 9 columns the page shows, bounded. */
export function laneRows(doc: LaneDoc | null): string[][] {
  if (!doc) return [];
  const idx = LANE_COLS.map((c) => doc.columns.findIndex((h) => h === c || h.startsWith(c.split('(')[0]!)));
  const pick = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? '—') : '—');
  const auto = idx[6]!, n = idx[2]!;
  const rank = (r: string[]): number => VERDICT_RANK[pick(r, auto)] ?? 3;
  return [...doc.rows].sort((a, b) => rank(a) - rank(b) || (Number(pick(b, n)) || 0) - (Number(pick(a, n)) || 0)).slice(0, MAX_ROWS).map((r) => idx.map((i) => text(pick(r, i) || '—', 160)));
}

/* ───────── sqlite + git (slow, cached per deps) ───────── */

interface WaveSell { ts: number | null; sym: string; gap: number | null; size: number | null; pnl: number | null; venue: string; note: string }
interface DbOut { wave: { error: string | null; refills: number; sells: number; pnl: number; posN: number | null; posInv: number | null; lastTs: string | null; recent: WaveSell[] } | null; mmp: { error: string | null; n: number | null; rows: { det: string; variant: string; n: number; done: number; hit: number; last: string | null }[] } | null }

export function parseDbOut(raw: string | null): DbOut | null {
  if (!raw) return null;
  let j: unknown;
  try { j = JSON.parse(raw.trim().split('\n').pop() ?? ''); } catch { return null; }
  if (!isObj(j)) return null;
  const w = isObj(j.wave) ? j.wave : null;
  const acts = w && isObj(w.actions) ? w.actions : {};
  const act = (k: string): [number, number] => { const a = arr(acts[k]); return [num(a[0]) ?? 0, num(a[1]) ?? 0]; };
  const wave = w ? (str(w.error) ? { error: str(w.error, 40), refills: 0, sells: 0, pnl: 0, posN: null, posInv: null, lastTs: null, recent: [] } : {
    error: null, refills: act('refill')[0], sells: act('sell')[0], pnl: act('sell')[1], posN: num(w.pos_n), posInv: num(w.pos_inv), lastTs: epochIso(w.last_ts),
    recent: objs(w.sells).slice(0, 10).map((s) => ({ ts: num(s.ts), sym: text(s.sym, 16) || '?', gap: num(s.gap), size: num(s.size), pnl: num(s.pnl), venue: text(s.venue, 16), note: text(s.note, 80) })),
  }) : null;
  const m = isObj(j.mmp) ? j.mmp : null;
  const mmp = m ? (str(m.error) ? { error: str(m.error, 40), n: null, rows: [] } : { error: null, n: num(m.n), rows: objs(m.rows).slice(0, 20).map((r) => ({ det: text(r.det, 16) || '?', variant: text(r.variant, 16) || '—', n: num(r.n) ?? 0, done: num(r.done) ?? 0, hit: num(r.hit) ?? 0, last: epochIso(r.last) })) }) : null;
  return { wave, mmp };
}

export interface Commit { at: string | null; subject: string }
export function parseGitLog(raw: string | null): Commit[] {
  if (!raw) return [];
  return raw.split('\n').filter((l) => l.trim()).slice(0, 15).map((l) => { const i = l.indexOf('\t'); return { at: toIso(i > 0 ? l.slice(0, i) : l), subject: text(i > 0 ? l.slice(i + 1) : '', 140) }; });
}

type Slow = { db: () => Promise<{ value: DbOut | null; stale: boolean; error: string | null }>; git: () => Promise<{ value: Commit[] | null; stale: boolean; error: string | null }> };
const slowByDeps = new WeakMap<HubDeps, Slow>();
function slowFor(deps: HubDeps): Slow {
  let s = slowByDeps.get(deps);
  if (!s) {
    const stateDir = path.join(deps.home, TRADING_STATE_DIR), repo = path.join(deps.home, TRADING_DIR);
    s = {
      db: slowCache(SLOW_MS, async () => { if (!deps.exec) throw new Error('exec unavailable'); const out = parseDbOut(await deps.exec('python3', ['-I', '-c', SQLITE_PY, path.join(stateDir, 'wave_paper.db'), path.join(stateDir, 'mmp_pump_shadow.db')], { timeoutMs: HUB_TIMEOUTS.py })); if (!out) throw new Error('sqlite 조회 불가'); return out; }, deps.now),
      git: slowCache(SLOW_MS, async () => { if (!deps.exec) throw new Error('exec unavailable'); const out = await deps.exec('git', ['-C', repo, 'log', '-15', '--format=%cI%x09%s'], { timeoutMs: HUB_TIMEOUTS.default }); if (out === null) throw new Error('git 조회 불가'); return parseGitLog(out); }, deps.now),
    };
    slowByDeps.set(deps, s);
  }
  return s;
}

/* ───────── collector ───────── */

async function readJson(deps: HubDeps, file: string): Promise<Record<string, unknown> | null> {
  try { const t = await deps.readText(file); if (!t) return null; const j: unknown = JSON.parse(t); return isObj(j) ? j : null; } catch { return null; }
}

export async function collectTrading(deps: HubDeps): Promise<HubMode> {
  const stateDir = path.join(deps.home, TRADING_STATE_DIR), repo = path.join(deps.home, TRADING_DIR);
  const slow = slowFor(deps);
  const [room, ver2, gl, maker, desk, laneMd, db, git, waveMtime, ...units] = await Promise.all([
    collectRoom(deps), collectVer2(deps),
    readJson(deps, path.join(stateDir, 'go_live_status.json')), readJson(deps, path.join(stateDir, 'maker_paper.json')), readJson(deps, path.join(stateDir, 'live_desk.json')),
    deps.readText(path.join(repo, LANE_DOC)).catch(() => null),
    slow.db(), slow.git(),
    deps.fileMtime(path.join(stateDir, 'wave_paper.db')).catch(() => null),
    ...TRADING_TIMERS.flatMap((t) => [showUnit(deps, t.timer), showUnit(deps, t.service)]),
  ]);
  const now = deps.now();
  const timers = TRADING_TIMERS.map((t, i) => ({ ...t, u: units[i * 2] as UnitInfo, svc: units[i * 2 + 1] as UnitInfo }));
  const lanes = parseLaneDoc(laneMd);
  const checks = parseChecks(gl);
  const passed = checks.filter((c) => c.ok).length;
  const health = { data: room.status, source: room.sources[0]! };
  const h = room.status;
  const hm = h && isObj(h.metrics) ? h.metrics : {};
  const { paper: v2, ledger } = ver2;
  const paper = desk && isObj(desk.paper) ? desk.paper : null;
  const transfer = paper && isObj(paper.by_mode) && isObj(paper.by_mode['이송']) ? paper.by_mode['이송'] : null;
  const wave = db.value?.wave ?? null, mmp = db.value?.mmp ?? null;
  const commits = git.value ?? [];

  // ── freshness: each state file's own timestamp (json ts / generated_at; wave: file mtime) vs 2× its timer period ──
  const fileAt: Record<string, string | null> = {
    'go_live_status.json': epochIso(gl?.generated_at), 'maker_paper.json': epochIso(maker?.ts), 'live_desk.json': epochIso(desk?.ts),
    'wave_paper.db': waveMtime === null ? null : new Date(waveMtime).toISOString(),
  };
  const present: Record<string, boolean> = { 'go_live_status.json': gl !== null, 'maker_paper.json': maker !== null, 'live_desk.json': desk !== null, 'wave_paper.db': waveMtime !== null };
  const dbErr = db.error && db.error !== '오류' ? `sqlite 조회 불가 · ${db.error}` : 'sqlite 조회 불가';
  const gitErr = git.error && git.error !== '오류' ? `git 조회 불가 · ${git.error}` : 'git 조회 불가';
  const sources: HubSource[] = [
    ...room.sources, ...ver2.sources,
    ...TRADING_TIMERS.map((t) => (t.file === GO_LIVE_FILE && !present[t.file] ? { name: t.file, ok: false, off: true, ms: 0, error: '꺼짐' } : { name: t.file, ok: present[t.file] === true, ms: 0, ...(present[t.file] ? {} : { error: '파일 없음' }) })),
    { name: 'sqlite', ok: db.value !== null && !db.stale, ms: 0, ...(db.value === null ? { error: dbErr } : db.stale ? { error: '이전 값' } : {}) },
    { name: 'git log', ok: git.value !== null && !git.stale, ms: 0, ...(git.value === null ? { error: gitErr } : git.stale ? { error: '이전 값' } : {}) },
    { name: '레인 성적표', ok: lanes !== null, ms: 0, ...(lanes ? {} : { error: '파일 없음' }) },
    { name: 'systemd', ok: timers.some((t) => t.u.active !== 'missing'), ms: 0, ...(timers.every((t) => t.u.active === 'missing') ? { error: '유닛 없음' } : {}) },
  ];

  // ── alerts & state ──
  const alerts: HubAlert[] = [];
  let state: HubState = 'ok';
  const warn = (): void => { if (state === 'ok') state = 'warn'; };
  // The go-live status job is reference only (live switching is not on the table): its health raises nothing.
  for (const t of timers) {
    if (t.file === GO_LIVE_FILE) continue;
    const at = fileAt[t.file];
    if (!present[t.file]) { alerts.push({ level: 'warn', text: `${t.label} 기록 없음` }); warn(); continue; }
    if (at && now - Date.parse(at) > STALE_FACTOR * t.periodMs) { alerts.push({ level: 'warn', text: `${t.label} 상태 오래됨 · ${agoFrom(at, now)} (주기 ${Math.round(t.periodMs / 60_000)}분)`, at }); warn(); }
    if (t.u.active !== 'missing' && t.u.active !== 'active') { alerts.push({ level: 'warn', text: `타이머 ${t.label} ${UNIT_STATE_KO[t.u.active]}` }); warn(); }
    if (t.svc.result && t.svc.result !== 'success') { alerts.push({ level: 'warn', text: `${t.label} 마지막 실행 ${t.svc.result}${t.svc.exitedAt ? ` · ${fmtKst(t.svc.exitedAt)}` : ''}` }); warn(); }
  }
  // ── the two bots: :8830 alerts pass through; ver2 down / live / verify failures ──
  for (const a of room.view.alerts) { alerts.push(a); if (a.level !== 'info') warn(); }
  if (room.view.workstreams.some((w) => w.id === 'adaptive' && w.state === 'warn')) { alerts.push({ level: 'warn', text: '어댑티브 라이브 플래그 켜짐 — 페이퍼 전용 원칙 확인' }); warn(); }
  if (!v2.ok) { alerts.push({ level: 'warn', text: `ver2 페이퍼 엔진 응답 없음 · ${v2.error ?? '오류'}` }); warn(); }
  else {
    if (v2.live === true) { alerts.push({ level: 'bad', text: 'ver2 페이퍼 엔진이 LIVE=true 로 응답 — 모의 전용이어야 함' }); state = 'warn'; }
    if ((v2.errors ?? 0) > 0) alerts.push({ level: 'info', text: `ver2 페이퍼 엔진 오류 ${fmtInt(v2.errors!)}건${v2.lastError ? ` · ${v2.lastError}` : ''}` });
    const lastPoll = kstToIso(v2.lastPollKst);
    if (lastPoll && now - Date.parse(lastPoll) > 10 * 60_000) { alerts.push({ level: 'warn', text: `ver2 페이퍼 마지막 폴 ${agoFrom(lastPoll, now)} — 루프 멈춤 의심`, at: lastPoll }); warn(); }
  }
  if (!ledger.ok) { alerts.push({ level: 'warn', text: `ver2 원장 응답 없음 · ${ledger.error ?? '오류'}` }); warn(); }
  else {
    if (ledger.verify && ledger.verify.ok !== true) { alerts.push({ level: 'bad', text: `ver2 원장 해시 체인 검증 실패 · ${ledger.verify.msg || '사유 미상'}` }); state = 'warn'; }
    for (const w of ledger.verify?.warnings.slice(0, 3) ?? []) alerts.push({ level: 'info', text: `원장 검증 경고 · ${w}` });
    if (ledger.engineReady === false) alerts.push({ level: 'info', text: 'ver2 원장: 엔진 준비 전' });
  }
  if (db.value === null) alerts.push({ level: 'info', text: '웨이브·펌프 기록을 지금 읽지 못함' });
  const unknownOrders = gl ? num(gl.unknown_orders) : null;
  if (unknownOrders !== null && unknownOrders > 0) { alerts.push({ level: 'warn', text: `모르는 주문 ${unknownOrders}건` }); warn(); }
  const pauses = gl ? arr(gl.pauses) : []; if (pauses.length) { alerts.push({ level: 'warn', text: `라이브 멈춤 ${pauses.length}건` }); warn(); }
  if (lanes?.verdictAt && now - Date.parse(lanes.verdictAt) > 7 * DAY_MS) alerts.push({ level: 'info', text: `돈 판정표(수기) ${agoFrom(lanes.verdictAt, now)} — 갱신 검토`, at: lanes.verdictAt });
  if (room.view.via === 'none' && !v2.ok && !ledger.ok && !gl && !maker && !desk && !lanes) state = 'unknown';

  // ── headline / decision / KPIs ──
  const pN = paper ? num(paper.n) : null, pMed = paper ? num(paper.median) : null, pWin = paper ? num(paper.win) : null;
  const tMed = transfer ? num(transfer.median) : null, tWin = transfer ? num(transfer.win) : null;
  const openN = v2.open.length;
  const roomWord = room.view.via === 'live' ? `트레이딩룸 ${room.view.kpis[0]!.value}` : room.view.via === 'snapshot' ? `트레이딩룸 스냅샷${room.view.stale ? '(오래됨)' : ''}` : '트레이딩룸 데이터 없음';
  const v2Net = sumOf(v2.books.map((b) => b.netPnl)), v2Trades = sumOf(v2.books.map((b) => b.nTrades)), v2Wins = sumOf(v2.books.map((b) => b.wins));
  const v2Equity = sumOf(v2.books.map((b) => b.equity)), v2Start = sumOf(v2.books.map((b) => b.cashStart));
  const v2Marked = v2Equity !== null && v2Start !== null ? v2Equity - v2Start : null;
  const v2Win = v2Trades && v2Wins !== null ? (v2Wins / v2Trades) * 100 : null;
  const verified = ledger.ok && ledger.verify?.ok === true;
  const headline = [
    v2.ok ? `ver2 페이퍼 ${usdSigned(v2Net)}` : 'ver2 페이퍼 데이터 없음',
    v2.ok && v2Win !== null ? `승률 ${fmtPct(v2Win, 0)} (${fmtInt(v2Trades!)}건)` : null,
    v2.ok ? `열린 ${openN}` : null,
    verified ? '원장 검증 ✓' : null,
    room.view.generatedAt ? `${roomWord} ${fmtKst(room.view.generatedAt).slice(6)}` : roomWord,
  ].filter(Boolean).join(' · ');
  const firstProblem = sortAlerts(alerts).find((a) => a.level !== 'info');
  const decision = firstProblem ? firstProblem.text : '조치 없음';
  const lastCommit = commits[0] ?? null;
  const verifyKpi = !ledger.ok ? kpi('ver2 원장 검증', NO_DATA, { status: 'info', hint: ledger.error ?? '' }) : kpi('ver2 원장 검증', ledger.verify ? (ledger.verify.ok === true ? '통과' : '실패') : NO_DATA, { status: ledger.verify?.ok === true ? 'ok' : ledger.verify ? 'bad' : 'info', hint: `레코드 ${ledger.records === null ? '—' : fmtInt(ledger.records)}` });
  const kpis: HubKpi[] = [
    kpi('ver2 페이퍼 손익', v2.ok && v2Net !== null ? usdSigned(v2Net) : NO_DATA, { status: !v2.ok || v2Net === null ? 'info' : v2.live === true ? 'bad' : v2Net > 0 ? 'ok' : 'info', hint: v2.ok ? `실현 · 평가 포함 ${usdSigned(v2Marked)} · 북 ${v2.books.length}개` : (v2.error ?? '') }),
    kpi('ver2 승률', v2.ok && v2Win !== null ? fmtPct(v2Win, 0) : NO_DATA, { status: 'info', hint: v2.ok && v2Trades !== null ? `청산 ${fmtInt(v2Trades)}건 · 승 ${fmtInt(v2Wins ?? 0)}` : '' }),
    kpi('ver2 열린 포지션', v2.ok ? String(openN) : NO_DATA, { status: 'info', hint: v2.ok && v2.lastPollKst ? `갱신 ${v2.lastPollKst.slice(5, 16)}` : '' }),
    verifyKpi,
    room.view.kpis[0]!,
    kpi('페이퍼 승률 · 중앙값', paper ? `${pWin === null ? '—' : fmtPct(pWin)} · ${signed(pMed)}` : NO_DATA, { status: pMed === null ? 'info' : pMed > 0 ? 'ok' : 'warn', hint: paper ? `n=${pN === null ? '—' : fmtInt(pN)} · 보유 ${fmtInt(num(desk?.hold_min) ?? 0)}분` : '' }),
    kpi('이송 모드', transfer ? `${tWin === null ? '—' : fmtPct(tWin)} · ${signed(tMed)}` : NO_DATA, { status: tMed === null ? 'info' : tMed > 0 ? 'ok' : 'warn', hint: transfer ? `n=${fmtInt(num(transfer.n) ?? 0)}` : '' }),
    kpi('웨이브 누적 PnL', wave && !wave.error ? signedInt(wave.pnl) : NO_DATA, { status: !wave || wave.error ? 'info' : wave.pnl >= 0 ? 'ok' : 'warn', hint: wave && !wave.error ? `매도 ${wave.sells} · 보충 ${fmtInt(wave.refills)}` : '' }),
    kpi('레인 살았다/죽었다/수집중', lanes ? `${lanes.alive ?? '—'}/${lanes.dead ?? '—'}/${lanes.collecting ?? '—'}` : NO_DATA, { status: lanes ? ((lanes.alive ?? 0) > 0 ? 'ok' : 'warn') : 'info', hint: lanes?.date ? `성적표 ${lanes.date}` : '' }),
  ];

  // ── scoreboard: one line per bot, only what each one actually reports ──
  const roomPnl = room.view.workstreams.filter((w) => w.pnl !== null).map((w) => `${w.label} ${w.pnl}`).join(' · ');
  const scoreboard: TradingBotRow[] = [
    { id: 'room', name: '트레이딩룸 SR/DCA', pnl: roomPnl || null, pnlTone: null, win: null, open: null, updated: room.view.generatedAt ? fmtKst(room.view.generatedAt) : null, note: room.view.via === 'none' ? null : `${room.view.via === 'live' ? '실시간' : '스냅샷'} · 봇이 손익을 합산해 보고하지 않음` },
    { id: 'ver2', name: 'ver2 페이퍼', pnl: v2.ok && v2Net !== null ? usdSigned(v2Net) : null, pnlTone: v2.ok && v2Net ? (v2Net > 0 ? 'pos' : 'neg') : null, win: v2.ok && v2Win !== null ? `${fmtPct(v2Win, 0)} · ${fmtInt(v2Trades!)}건` : null, open: v2.ok ? String(openN) : null, updated: v2.ok && v2.lastPollKst ? v2.lastPollKst.slice(5, 16) : null, note: v2.ok ? [`실현 · 평가 포함 ${usdSigned(v2Marked)}`, verified ? `원장 검증 ✓ ${ledger.records === null ? '' : `${fmtInt(ledger.records)}건`}`.trim() : null].filter(Boolean).join(' · ') : null },
    { id: 'desk', name: '데스크 페이퍼', pnl: pMed === null ? null : `중앙값 ${signed(pMed)}`, pnlTone: pMed ? (pMed > 0 ? 'pos' : 'neg') : null, win: pWin === null ? null : `${fmtPct(pWin, 0)}${pN === null ? '' : ` · ${fmtInt(pN)}건`}`, open: paper && num(paper.open) !== null ? fmtInt(num(paper.open)!) : null, updated: fileAt['live_desk.json'] ? fmtKst(fileAt['live_desk.json']) : null, note: null },
    { id: 'wave', name: '웨이브 페이퍼', pnl: wave && !wave.error ? signedInt(wave.pnl) : null, pnlTone: wave && !wave.error && wave.pnl ? (wave.pnl > 0 ? 'pos' : 'neg') : null, win: null, open: wave && !wave.error && wave.posN !== null ? String(wave.posN) : null, updated: wave?.lastTs ? fmtKst(wave.lastTs) : null, note: wave && !wave.error ? `매도 ${wave.sells}` : null },
  ];

  // ── sections ──
  const why = desk && isObj(desk.why_dropped) ? Object.entries(desk.why_dropped).filter((e): e is [string, number] => typeof e[1] === 'number') : [];
  const dropRows: [string, string][] = [
    ['후보 행', desk ? fmtInt(num(desk.n_rows) ?? 0) : '—'], ['표 실행 가능', desk ? fmtInt(num(desk.n_table_exec) ?? 0) : '—'], ['호가 탐침', desk ? fmtInt(num(desk.n_probed) ?? 0) : '—'], ['라이브', desk ? fmtInt(num(desk.n_live) ?? 0) : '—'],
    ...why.sort((a, b) => b[1] - a[1]).map(([k, v]): [string, string] => [`드롭 · ${text(k, 30)}`, fmtInt(v)]),
    ['환율 · 크기', desk ? `${fmtNum(num(desk.fx) ?? 0)} · ${fmtUsd(num(desk.size_usd) ?? 0)}` : '—'],
  ];
  const probed = desk ? objs(desk.probed).slice(0, 20) : [];
  const probedRows = probed.map((p) => [text(p.sym, 12) || '?', text(p.kind, 12), `${text(p.buy, 30)} → ${text(p.sell, 30)}`, num(p.table_net_pct) === null ? '—' : fmtPct(num(p.table_net_pct)!, 2), num(p.table_size_usd) === null ? '—' : fmtUsd(num(p.table_size_usd)!), text(p.grade, 4) || '—', p.ok === true ? '가능' : '불가', text(p.why, 100) || '—']);
  const waveRows = wave?.recent.map((s) => [fmtKst(toIso(s.ts)), s.sym, s.gap === null ? '—' : fmtPct(s.gap, 2), s.size === null ? '—' : fmtUsd(s.size), s.pnl === null ? '—' : signed(s.pnl, 1, ''), s.venue || '—', s.note || '—']) ?? [];
  const lanesRows = laneRows(lanes);
  const commitRows = commits.map((c) => [fmtKst(c.at), c.subject || '—']);
  const freshRows: [string, string][] = timers.filter((t) => t.file !== GO_LIVE_FILE).flatMap((t): [string, string][] => {
    const at = fileAt[t.file] ?? null;
    return [[`${t.label} · 기록`, present[t.file] ? `${fmtKst(at)} · ${at ? agoFrom(at, now) : '시각 미상'}` : '기록 없음'], [`${t.label} · 타이머`, t.u.active === 'missing' ? '정보 없음' : `${UNIT_STATE_KO[t.u.active]} · 마지막 ${fmtKst(t.u.lastRun)} · 다음 ${t.u.nextRun ? fmtKst(t.u.nextRun) : `+${Math.round(t.periodMs / 60_000)}분`} · ${t.svc.result ?? '—'}`]];
  });
  const healthRows: [string, string][] = h ? [
    ['상태', str(h.state, 10) ?? '—'], ['단계', str(h.stage, 20) ?? '—'], ['생성', fmtKst(toIso(h.generated_at))],
    ['섀도 하트비트', num(hm.shadow_heartbeat_age_s) === null ? '—' : `${fmtNum(num(hm.shadow_heartbeat_age_s)!, 0)}s`], ['스냅샷 경과', num(hm.snapshot_age_h) === null ? '—' : `${fmtNum(num(hm.snapshot_age_h)!, 1)}h`],
    ['DWF 바스켓 / 감시', `${num(hm.dwf_basket_count) ?? '—'} / ${num(hm.dwf_watch_total) ?? '—'}`], ['온체인 알림', num(hm.onchain_alerts_count) === null ? '—' : fmtInt(num(hm.onchain_alerts_count)!)],
    ['승격 가능', yes(hm.promotion_eligible)], ['메이커 그래프트 승격', yes(hm.maker_graft_promotion_eligible)],
  ] : [['상태', `응답 없음 · ${health.source.error ?? '오류'}`]];
  const mmpRows = mmp?.rows.map((r) => [r.det, r.variant, fmtInt(r.n), fmtInt(r.done), fmtInt(r.hit), r.done > 0 ? fmtPct((r.hit / r.done) * 100, 0) : '—', fmtKst(r.last)]) ?? [];
  const caveats = maker ? arr(maker.caveats).filter((c): c is string => typeof c === 'string').slice(0, 6).map((c) => text(c, 160)) : [];

  const sections: HubSection[] = [
    sec.table('페이퍼 성적 (모드별)', ['출처', '모드', 'n', '중앙값', '승률', '체결 / 미체결', '메모'], paperRows(maker, desk), { open: true, num: [2, 3, 4], wrap: [6], note: [maker ? `메이커 ${fmtUsd(num(maker.size_usd) ?? 0)} · 대기 ${fmtInt(num(maker.wait_min) ?? 0)}분 · 보유 ${fmtInt(num(maker.hold_min) ?? 0)}분` : null, desk ? `데스크 ${fmtUsd(num(desk.size_usd) ?? 0)} · 보유 ${fmtInt(num(desk.hold_min) ?? 0)}분 · 열린 ${fmtInt(num(paper?.open) ?? 0)}` : null].filter(Boolean).join(' · ') }),
    sec.kv('드롭 사유 (라이브 데스크)', dropRows, { open: true, note: desk ? `${fmtKst(fileAt['live_desk.json'] ?? null)} 기준 · 모델에 없는 것: ${arr(desk.not_modeled).filter((x): x is string => typeof x === 'string').map((x) => text(x, 40)).join(', ') || '—'}` : '' }),
    sec.table('호가 탐침 후보', ['심볼', '종류', '경로', '표 순이익', '크기', '등급', '판정', '사유'], probedRows, { num: [3, 4], wrap: [2, 7], note: `탐침 ${probedRows.length} · 라이브 ${desk ? fmtInt(num(desk.n_live) ?? 0) : '—'}` }),
    sec.table('웨이브 페이퍼 (최근 매도)', ['시각', '심볼', '갭', '크기', 'PnL', '매수처', '메모'], waveRows, { open: true, num: [2, 3, 4], wrap: [6], note: wave ? (wave.error ? '기록을 지금 읽지 못함' : `누적 ${signedInt(wave.pnl)} · 매도 ${wave.sells} · 보충 ${fmtInt(wave.refills)} · 포지션 ${wave.posN ?? '—'} (재고 ${wave.posInv ?? '—'}) · 마지막 기록 ${fmtKst(wave.lastTs)}`) : '' }),
    sec.table('레인 성적표', [...LANE_COLS], lanesRows, { wrap: [8], note: lanes ? `${lanes.date ?? ''} · 살았다 ${lanes.alive ?? '—'} · 죽었다 ${lanes.dead ?? '—'} · 수집중 ${lanes.collecting ?? '—'} · 돈 판정표 ${lanes.verdictAt ? `${fmtKst(lanes.verdictAt)} (${agoFrom(lanes.verdictAt, now)})` : '—'}${lanes.ledger ? ` · ${lanes.ledger}` : ''}` : '성적표 파일 없음' }),
    sec.table('최근 커밋', ['시각', '제목'], commitRows, { wrap: [1], note: commitRows.length ? `${TRADING_DIR} · ${commitRows.length}개` : gitErr }),
    sec.kv('타이머 · 신선도', freshRows, { note: '각 2분 주기' }),
    sec.kv('헬스 :8830', healthRows),
    sec.table('펌프 섀도 감지기', ['감지기', '변형', '이벤트', '완료', '적중', '적중률', '마지막'], mmpRows, { num: [2, 3, 4, 5], note: mmp ? (mmp.error ? `sqlite 조회 불가 (${mmp.error})` : `이벤트 ${fmtInt(mmp.n ?? 0)}`) : dbErr }),
  ];
  if (caveats.length) sections.push(sec.list('메이커 페이퍼 주의', caveats.map((c) => ({ text: c, level: 'info' as const }))));

  const metrics: Record<string, HubMetricValue> = { '트레이딩룸': roomWord.replace('트레이딩룸 ', ''), 'ver2 북 · 열린': v2.ok ? `${v2.books.length} · ${openN}` : '—', '페이퍼 중앙값': signed(pMed), '웨이브 PnL': wave && !wave.error ? signedInt(wave.pnl) : '—', '레인': lanes ? `${lanes.alive ?? '—'}/${lanes.dead ?? '—'}/${lanes.collecting ?? '—'}` : '—' };
  const lastActivity = latestIso(lastCommit?.at ?? null, fileAt['live_desk.json'] ?? null, fileAt['maker_paper.json'] ?? null, wave?.lastTs ?? null, room.view.generatedAt, kstToIso(v2.lastPollKst), kstToIso(ledger.lastPollKst));
  // The desk's "live candidates" count is not a trading mode: only a bot saying it is live can lift this badge.
  const tag = v2.live === true || str(h?.stage, 20)?.toLowerCase() === 'live' || room.view.workstreams.some((w) => w.badge === 'LIVE') ? 'LIVE' : 'PAPER ONLY';
  const trading: TradingMerged = { room: room.view, ver2: { paper: v2, ledger }, scoreboard };
  const sourceNote = gl ? `라이브 전환 체크 ${passed}/${checks.length} · 참고용, 페이퍼 전용 운영` : undefined;
  return { id: 'trading', name: 'Trading Room', state, lastActivity, metrics, alerts: sortAlerts(alerts), links: [], sources, ...(sourceNote ? { sourceNote } : {}), tag, page: page(headline, decision, kpis, sections), trading };
}
