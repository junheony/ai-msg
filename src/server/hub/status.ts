/**
 * MSG Hub status aggregator: reads every mode's state from localhost (GET only, per-source timeouts), read-only files
 * and `systemctl --user show`, never throws, and keeps the answer 15 s. Every collector picks explicit fields and
 * builds the mode's page (headline → decision → KPIs → attention → drill-down); nothing named like a secret leaves here.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GameStudio, HubAlert, HubKpi, HubMetricValue, HubMode, HubModeId, HubSection, HubSource, HubState, HubStatus, ShortsFactoryView } from '../../shared/hub-types';
import { HUB_MODE_IDS } from '../../shared/hub-types';
import { collectOps } from './ops';
import { collectNexus } from './nexus';
import { collectQuant } from './quant';
import { collectTrading } from './trading';
import { collectUpdown } from './updown';
import {
  DAY_MS, DEFAULT_LINKS, HOUR_MS, IDLE_DAYS, HUB_CACHE_MS, HUB_TIMEOUTS, HUB_URLS, LAST_GOOD_MS, SECRET_FIELD_RE, STALLED_S, SYSTEMD_PROPS, agoFrom, bool, downMode, errorText, fmtAgo, fmtClock, fmtDuration, fmtInt, fmtKst, fmtNum, fmtUsd,
  isObj, kpi, latestIso, loopBudgetSignal, num, objs, page, probe, scrub, sec, sortAlerts, str, stripSecrets, toIso, withLastGood, type HubDeps, type HubSelf, type HubSelfSeat,
} from './shared';
import { collectGameStudioCached } from './gameStudio';
import { collectStudioCached } from './studios';
import { collectShorts } from './shorts';
import { collectYapping } from './yapping';

export { DEFAULT_LINKS, HUB_CACHE_MS, HUB_TIMEOUTS, HUB_URLS, SECRET_FIELD_RE, errorText, fmtDuration, stripSecrets, toIso } from './shared';
export type { HubDeps, HubSelf, HubSelfSeat, HubSelfSession } from './shared';

/* ───────── collectors: msg, nexus, trading, updown ───────── */

/** A session title that is a slash command or a bare prompt never shows as the title: the project stands in. */
const SLASH_TITLE_RE = /^\s*\/[a-z][\w:-]*/i;
const sessionTitle = (t: string, project: string): string => { const x = scrub(t, 80).trim(); return !x || SLASH_TITLE_RE.test(x) ? `${project} · 명령` : x; };
const SEAT_STATUS_KO: Record<HubSelfSeat['status'], string> = { ok: '정상', stale: '이전 값', down: '응답 없음', login: '로그인 필요', cooldown: '쿨다운', unknown: '기록 없음' };
const pctText = (v: number | null): string => (v === null ? '—' : `${v}%`);
/** A seat is spent when any reported window is at 100 %. */
/** Spent = its 5-hour or weekly window is full. The Fable quota is one model's: such a seat still runs every other model. */
const seatOut = (s: HubSelfSeat): boolean => [s.fiveHour, s.weekly].some((v) => v !== null && v >= 100);
/** Headroom = the fullest reported window; the best seat is the one with the most left among those that answer. */
const seatUsed = (s: HubSelfSeat): number | null => { const v = [s.fiveHour, s.weekly].filter((x): x is number => x !== null); return v.length ? Math.max(...v) : null; };

function collectMsg(deps: HubDeps): HubMode {
  const self = deps.self();
  const now = deps.now();
  const up = fmtDuration(self.uptimeMs);
  const startedAt = Number.isFinite(self.uptimeMs) && self.uptimeMs >= 0 ? new Date(now - self.uptimeMs).toISOString() : null;
  const metrics: Record<string, HubMetricValue> = { '가동 시간': up };
  if (self.sessions !== null) metrics['세션'] = self.sessions;
  if (self.activeTurns !== null) metrics['실행 중 턴'] = self.activeTurns;
  const turns = self.activeTurns ?? 0;
  const sessions = self.sessions === null ? '—' : String(self.sessions);
  const recent = self.recent ?? [];
  const seats = self.seats ?? [];
  const alerts: HubAlert[] = [];

  // ── seats: who has room, who is spent, who must log in ──
  const answering = seats.filter((s) => (s.status === 'ok' || s.status === 'stale') && seatUsed(s) !== null);
  const best = answering.filter((s) => !seatOut(s)).sort((a, b) => seatUsed(a)! - seatUsed(b)!)[0] ?? null;
  const out = seats.filter(seatOut);
  const login = seats.filter((s) => s.status === 'login');
  const cooling = seats.filter((s) => s.status === 'cooldown');
  // A spent seat or an expired login is a problem only when no other seat can take the work.
  const seatLevel = best ? 'info' as const : 'warn' as const;
  const fableOut = seats.filter((s) => !seatOut(s) && s.fable !== null && s.fable >= 100);
  if (fableOut.length) alerts.push({ level: 'info', text: `Fable 한도 100% · ${fableOut.map((s) => s.label).join(', ')} — 다른 모델은 사용 가능` });
  for (const s of out) alerts.push({ level: seatLevel, text: `${s.label} 소진${s.fiveHour !== null && s.fiveHour >= 100 ? ' · 5시간 100%' : ' · 주간 100%'}`, hint: s.resetsAt ? `리셋 ${fmtKst(s.resetsAt)}` : s.weeklyResetsAt ? `주간 리셋 ${fmtKst(s.weeklyResetsAt)}` : undefined });
  for (const s of login) alerts.push({ level: seatLevel, text: `${s.label} 로그인 필요`, hint: s.id === 'x1' ? '터미널 모드 상단 칩 → Grok → 다시 로그인 (grok 로그인 창)' : '터미널 모드 상단 칩 → Gemini → 다시 로그인 (agy TUI, 끝나면 q)' });
  for (const s of cooling) alerts.push({ level: 'info', text: `${s.label} 쿨다운${s.resetsAt ? ` · ${fmtKst(s.resetsAt)}까지` : ''}` });
  if (seats.length && !answering.length && !login.length) alerts.push({ level: 'info', text: '좌석 사용량 응답 없음 — usage-deck 확인' });

  const running = recent.filter((r) => r.running);
  const active24h = self.active24h ?? null;
  const kpis: HubKpi[] = [
    kpi('진행 중 턴', String(turns), { status: turns > 0 ? 'info' : 'ok', hint: turns > 0 ? running.slice(0, 2).map((r) => r.project).join(', ') || '터미널에서 응답 중' : '대기 중' }),
    kpi('24h 세션', active24h === null ? sessions : String(active24h), { status: 'info', hint: active24h === null ? '연결된 세션' : `전체 ${sessions}` }),
    kpi('좌석 여유', best ? best.label : seats.length ? '없음' : '—', { status: best ? (seatUsed(best)! >= 80 ? 'warn' : 'ok') : seats.length ? 'bad' : 'info', hint: best ? `사용 ${pctText(seatUsed(best))}${best.fiveHour !== null ? ` · 5h ${pctText(best.fiveHour)}` : ''}${out.length ? ` · 소진 ${out.length}` : ''}` : seats.length ? '모든 좌석 소진·응답 없음' : '사용량 없음' }),
    kpi('서버 가동', up, { status: 'ok', hint: startedAt ? `${fmtKst(startedAt)} 시작` : '' }),
  ];
  const headline = seats.length
    ? `진행 중 턴 ${turns} · 24h 세션 ${active24h ?? sessions} · 좌석 여유 ${best ? `${best.label} ${pctText(seatUsed(best))} 사용` : '없음'}${out.length ? ` · 소진 ${out.map((s) => s.label).join(', ')}` : ''}${login.length ? ` · 로그인 필요 ${login.map((s) => s.label).join(', ')}` : ''}`
    : `세션 ${sessions} · 진행 중 턴 ${turns} · 서버 가동 ${up}`;
  const decision = login.length ? `${login.map((s) => s.label).join(', ')} 다시 로그인 — 상단 칩에서` : out.length && best ? `${out.map((s) => s.label).join(', ')} 소진 — ${best.label}로 작업` : out.length ? '모든 좌석 소진 — 리셋 대기' : turns > 0 ? `진행 중 턴 ${turns}개 확인` : '조치 없음';

  const sessionRows = recent.map((r) => [r.running ? '응답 중' : r.bg > 0 ? `백그라운드 ${r.bg}` : '대기', fmtAgo(Math.max(0, now - r.lastModified)), r.seat, r.project, sessionTitle(r.title, r.project)]);
  const seatRows = seats.map((s) => [s.label, pctText(s.fiveHour), pctText(s.weekly), pctText(s.fable), s.resetsAt ? fmtKst(s.resetsAt) : s.weeklyResetsAt ? `${fmtKst(s.weeklyResetsAt)} (주간)` : '—', `${seatOut(s) ? '소진' : SEAT_STATUS_KO[s.status]}${s.note ? ` · ${s.note}` : ''}`]);
  const sections: HubSection[] = [
    ...(recent.length ? [sec.table('진행 중 · 최근 세션', ['상태', '마지막', '좌석', '프로젝트', '제목'], sessionRows, { open: true, wrap: [4], note: `응답 중 ${running.length} · 최근 ${recent.length}개 표시${active24h !== null ? ` · 24h 활동 ${active24h}` : ''} · 열기는 터미널 모드에서` })] : []),
    ...(seats.length ? [sec.table('좌석 사용량', ['좌석', '5시간', '주간', 'Fable 7d', '리셋', '상태'], seatRows, { open: true, num: [1, 2, 3], note: `사용한 비율 · 소진 ${out.length} · 로그인 필요 ${login.length} · 상세는 상단 칩/사용량 시트` })] : [sec.kv('사용량', [['좌석 사용량', '상단 칩/사용량 시트에서 확인']], { note: '이 페이지는 터미널 서버 자체 상태만 표시' })]),
    sec.kv('서버', [['호스트', deps.host], ['가동 시간', up], ['시작 시각', startedAt ? `${fmtKst(startedAt)} KST` : '—'], ['세션', sessions], ['진행 중 턴', String(turns)]], { open: !recent.length }),
  ];
  const state: HubState = (login.length || out.length) && !best ? 'warn' : 'ok';
  const sources: HubSource[] = [{ name: 'self', ok: true, ms: 0 }, ...(seats.length ? [{ name: '사용량', ok: answering.length > 0 || login.length > 0, ms: 0, ...(answering.length || login.length ? {} : { error: '응답 없음' }) }] : [])];
  return { id: 'msg', name: 'MSG 터미널', state, lastActivity: new Date(now).toISOString(), metrics, alerts: sortAlerts(alerts), links: [], sources, page: page(headline, decision, kpis, sections) };
}

/** 게임 스튜디오: the ops page (~/games facts) plus, with a studio folder, the gamified view built from the manifests. */
export async function collectGameMode(deps: HubDeps): Promise<HubMode> {
  const [mode, studio] = await Promise.all([collectStudioCached(deps, 'game'), deps.studioDir ? collectGameStudioCached(deps, { studioDir: deps.studioDir }) : Promise.resolve(null)]);
  return studio ? withStudioActivity(mode, studio, deps.now()) : mode;
}

/**
 * The ~/games page plus the manifest studio. 마지막 활동 is the newest of the ~/games scan and every studio card's
 * `lastAt` (most work now happens in ~/jobs, not ~/games); a card left idle only by an old ~/games scan reads ok again.
 */
export function withStudioActivity(mode: HubMode, studio: GameStudio, now: number): HubMode {
  const lastActivity = latestIso(mode.lastActivity, ...studio.games.map((g) => g.lastAt));
  const fresh = lastActivity !== null && now - Date.parse(lastActivity) <= IDLE_DAYS * DAY_MS;
  const state = mode.state === 'idle' && fresh ? 'ok' : mode.state;
  return { ...mode, state, lastActivity, studio };
}

/* ───────── aggregate + cache ───────── */

const ORDER: HubModeId[] = [...HUB_MODE_IDS];
const NAMES: Record<HubModeId, string> = { msg: 'MSG 터미널', nexus: 'NEXUS', trading: 'Trading Room', video: '영상 스튜디오', game: '게임 스튜디오', ops: 'OPS · 펍덱', updown: 'UPDOWN', quant: 'QUANT', yapping: '야핑봇' };

/** The 영상 card plus its second project tab (Shorts 공장); a failing shorts collector never takes engineering-shorts down with it. */
async function withShorts(deps: HubDeps, video: Promise<HubMode>): Promise<HubMode> {
  const [mode, shorts] = await Promise.all([video, collectShorts(deps).catch((err: unknown) => { console.error('[hub] shorts', errorText(err)); return null; })]);
  return leadWithShorts(mode, shorts);
}

/** The 영상 card led by Shorts 공장 (exported for tests). */
export function leadWithShorts(mode: HubMode, shorts: ShortsFactoryView | null): HubMode {
  // No Shorts 공장 files at all (not set up on this host): engineering-shorts keeps the card.
  if (!shorts || [shorts.files.status, shorts.files.channels, shorts.files.history].every((f) => f.state === 'missing')) return shorts ? { ...mode, shorts } : mode;
  // Shorts 공장 is the live project, so it speaks for the 영상 card (state, activity, 주의, metrics, the 정상/주의/장애
  // summary); engineering-shorts joins only while it has an active (not archived) episode.
  const studioLive = mode.state !== 'idle' && mode.state !== 'unknown';
  const sfAt = latestIso(shorts.files.status.at, shorts.files.channels.at, shorts.files.history.at);
  const state = studioLive && STATE_RANK[mode.state] > STATE_RANK[shorts.state] ? mode.state : shorts.state;
  const alerts = sortAlerts([...shorts.alerts, ...(studioLive ? mode.alerts.map((a) => ({ ...a, text: `engineering-shorts · ${a.text}` })) : [])]);
  const metrics: Record<string, HubMetricValue> = Object.fromEntries(shorts.kpis.slice(0, 4).map((k) => [k.label, k.value]));
  return { ...mode, state, lastActivity: studioLive ? latestIso(sfAt, mode.lastActivity) : sfAt, alerts, metrics, shorts, videoOwn: { state: mode.state, lastActivity: mode.lastActivity, alerts: mode.alerts, metrics: mode.metrics } };
}
const STATE_RANK: Record<HubState, number> = { down: 4, warn: 3, ok: 2, idle: 1, unknown: 0 };

/** One pass over every source. A collector that throws (it should not) becomes an `unknown` card; this never rejects. */
export async function collectHubStatus(deps: HubDeps): Promise<HubStatus> {
  const runs: Record<HubModeId, () => Promise<HubMode> | HubMode> = {
    msg: () => collectMsg(deps), nexus: () => collectNexus(deps), trading: () => collectTrading(deps), video: () => withShorts(deps, collectStudioCached(deps, 'video')),
    game: () => collectGameMode(deps), ops: () => collectOps(deps), updown: () => collectUpdown(deps), quant: () => collectQuant(deps), yapping: () => collectYapping(deps),
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
  const budget = loopBudgetSignal(timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: budget.signal, headers: { accept: 'application/json' }, redirect: 'manual' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as unknown;
  } finally { budget.clear(); }
}

/** Children the hub may have starting or running at once. */
export const SPAWN_LIMIT = 6;

/**
 * Starting a child blocks the event loop until it has exec'd (tens to hundreds of ms each on a loaded box). A pass needs
 * dozens, and started all at once they froze the loop for 3 s+ with every probe in flight. The gate starts them one
 * loop turn at a time, at most `limit` alive, so sockets are read between any two spawns.
 */
export function createSpawnGate(limit: number = SPAWN_LIMIT): <T>(start: (done: (v: T) => void) => void) => Promise<T> {
  const queue: (() => void)[] = [];
  let alive = 0, scheduled = false;
  const pump = (): void => {
    if (scheduled || alive >= limit || queue.length === 0) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; if (alive < limit) queue.shift()?.(); pump(); });
  };
  return <T>(start: (done: (v: T) => void) => void): Promise<T> => new Promise<T>((resolve) => {
    queue.push(() => { alive++; start((v) => { alive--; resolve(v); pump(); }); });
    pump();
  });
}
const spawnGate = createSpawnGate();

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
  return spawnGate<string | null>((resolve) => {
    execFile('git', ['-C', dir, 'log', '-1', '--format=%cI'], { timeout: HUB_TIMEOUTS.default, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(toIso(stdout.trim()));
    });
  });
}

const UNIT_NAME_RE = /^[A-Za-z0-9:_.@-]+$/;

const SYSTEMD_BATCH_WINDOW_MS = 15;
const SYSTEMD_BATCH_MAX = 60;
const SYSTEMD_RETRY_MS = 500;

/** `systemctl show a b c` output: one blank-line separated block per unit, in argv order. Null when the blocks do not line up. */
export function parseSystemdBlocks(stdout: string, units: string[]): Map<string, Record<string, string>> | null {
  const blocks = stdout.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length !== units.length) return null;
  const out = new Map<string, Record<string, string>>();
  blocks.forEach((block, i) => {
    const props: Record<string, string> = {};
    for (const line of block.split('\n')) { const at = line.indexOf('='); if (at > 0) props[line.slice(0, at)] = line.slice(at + 1).trim(); }
    out.set(units[i]!, props);
  });
  return out;
}

/**
 * Per-unit lookups asked for within a few ms share one `systemctl` child (a pass asks for 30+). The user bus sometimes
 * refuses under load ("Transport endpoint is not connected"), so a failed batch is retried once and then answered from
 * each unit's last good reading; only a unit with no reading at all comes back null.
 */
export function createSystemdShow(run: (units: string[]) => Promise<string | null>, clock: () => number = () => Date.now()): (unit: string) => Promise<Record<string, string> | null> {
  let waiting = new Map<string, ((v: Record<string, string> | null) => void)[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const good = new Map<string, { value: Record<string, string>; at: number }>();
  const fallback = (unit: string): Record<string, string> | null => { const g = good.get(unit); return g && clock() - g.at <= LAST_GOOD_MS ? g.value : null; };
  const showAll = async (units: string[]): Promise<Map<string, Record<string, string>> | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, SYSTEMD_RETRY_MS));
      const stdout = await run(units);
      const parsed = stdout === null ? null : parseSystemdBlocks(stdout, units);
      if (parsed) return parsed;
    }
    return null;
  };
  const flush = async (): Promise<void> => {
    timer = null;
    const batch = waiting;
    waiting = new Map();
    const parsed = await showAll([...batch.keys()]);
    for (const [unit, callers] of batch) {
      const props = parsed?.get(unit) ?? null;
      if (props) good.set(unit, { value: props, at: clock() });
      for (const resolve of callers) resolve(props ?? fallback(unit));
    }
  };
  return (unit) => new Promise((resolve) => {
    if (!waiting.has(unit) && waiting.size >= SYSTEMD_BATCH_MAX) { if (timer !== null) clearTimeout(timer); void flush(); }
    const callers = waiting.get(unit);
    if (callers) callers.push(resolve); else waiting.set(unit, [resolve]);
    timer ??= setTimeout(() => { void flush(); }, SYSTEMD_BATCH_WINDOW_MS);
  });
}

const runSystemctlShow = (units: string[]): Promise<string | null> => spawnGate<string | null>((resolve) => {
  execFile('systemctl', ['--user', 'show', ...units, '--no-pager', '--timestamp=utc', '-p', SYSTEMD_PROPS.join(',')], { timeout: HUB_TIMEOUTS.default, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, SYSTEMD_PAGER: '', LC_ALL: 'C' } }, (err, stdout) => {
    resolve(err && !stdout ? null : String(stdout));
  });
});
const showBatched = createSystemdShow(runSystemctlShow);

/** `systemctl --user show <unit>` (read-only introspection, batched). Null when systemd/systemctl is unavailable. */
export function systemdShowUser(unit: string): Promise<Record<string, string> | null> {
  if (!UNIT_NAME_RE.test(unit)) return Promise.resolve(null);
  return showBatched(unit);
}

const EXEC_CMD_RE = /^[A-Za-z0-9_./-]+$/;
/**
 * A fixed-argv, read-only helper command (ssh -o BatchMode=yes, psql, python3 -I) with a time budget. Stdout on
 * success, null on any failure. Never a shell; stdin is fed when given (SQL text), the env only extended.
 */
export function execReadOnly(cmd: string, args: string[], o: { timeoutMs: number; env?: Record<string, string>; stdin?: string }): Promise<string | null> {
  if (!EXEC_CMD_RE.test(cmd)) return Promise.resolve(null);
  return spawnGate<string | null>((resolve) => {
    const child = execFile(cmd, args, { timeout: o.timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...(o.env ?? {}), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' } }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout));
    });
    if (o.stdin !== undefined && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(o.stdin); } else child.stdin?.end();
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
export function liveHubDeps(opts: { home: string; host: string; self: () => HubSelf; links?: HubDeps['links']; studioDir?: string }): HubDeps {
  return {
    fetchJson: withLastGood(fetchJsonWithTimeout),
    latestRender: (dir) => latestRenderIn(dir),
    countEntries: async (dir) => { try { return (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).length; } catch { return null; } },
    gitLastCommit: gitLastCommitIso,
    readText: async (file) => { try { return await fs.readFile(file, 'utf8'); } catch { return null; } },
    readTail: readTailOf,
    listDir: async (dir) => { try { return (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).sort(); } catch { return null; } },
    fileMtime: async (file) => { try { return (await fs.stat(file)).mtimeMs; } catch { return null; } },
    systemdShow: systemdShowUser,
    exec: execReadOnly,
    now: () => Date.now(),
    self: opts.self,
    host: opts.host,
    home: opts.home,
    ...(opts.links ? { links: opts.links } : {}),
    ...(opts.studioDir ? { studioDir: opts.studioDir } : {}),
  };
}

// Re-exported for collectors' tests that want the same clock helpers without importing shared directly.
export { DAY_MS, HOUR_MS };
