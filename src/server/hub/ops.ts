/**
 * OPS · 펍덱: the RiseX volume-printer fleet as a work page. Four printers (메인·서브1 on the server under systemd,
 * 서브2·서브3 on the MacBook under launchd), each with host, uptime, today's volume/cost/bps, PnL (= −cost for a volume
 * printer), fee tier, lifetime; readable 7-day XAU cost buckets; lanes; units. Everything is read-only: GET JSON,
 * mirrored files, `systemctl --user show`, and one fixed `ssh -o BatchMode=yes` probe that only prints.
 */
import type { HubAlert, HubCardItem, HubKpi, HubLink, HubMetricValue, HubMode, HubSection, HubSource, HubState } from '../../shared/hub-types';
import { HUB_TIMEOUTS, HUB_URLS, SLOW_CACHE_MS, STALLED_S, UNIT_STATE_KO, agoFrom, arr, fmtAgo, fmtDuration, fmtInt, fmtKst, fmtNum, fmtPct, fmtUsd, isObj, kpi, latestIso, num, objs, page, probe, scrub, sec, showUnit, slowCache, sortAlerts, str, toIso, unitInfo, type HubDeps, type UnitInfo } from './shared';

export const OPS_ACCOUNTS = ['main', 'sub1', 'sub2', 'sub3'] as const;
export type OpsProfile = (typeof OPS_ACCOUNTS)[number];
export const PRINTER_UNITS: Record<OpsProfile, string> = { main: 'risex-printer.service', sub1: 'risex-printer@sub1.service', sub2: 'risex-printer@sub2.service', sub3: 'risex-printer@sub3.service' };
const PROFILE_KO: Record<OpsProfile, string> = { main: '메인', sub1: '서브1', sub2: '서브2', sub3: '서브3' };
const LAUNCHD_LABEL = (p: OpsProfile): string => `com.standx.risex-printer-${p}`;

/** The MacBook probe: one fixed remote command that only prints (launchd pid, process etime, host uptime). */
export const MACBOOK_HOST = 'macbook-m4';
export const MACBOOK_PROBE_CMD = `for p in ${OPS_ACCOUNTS.join(' ')}; do pid=$(launchctl list | awk -v l=com.standx.risex-printer-$p '$3==l{print $1}'); echo "PID $p \${pid:-none}"; [ -n "$pid" ] && [ "$pid" != "-" ] && ps -o etime=,lstart= -p "$pid" | sed "s/^/ETIME $p /"; done; echo "UPTIME $(uptime)"`;
export const MACBOOK_SSH_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', MACBOOK_HOST, MACBOOK_PROBE_CMD];

/** Heartbeat older than this is an alert (10 min); fee tier within this share of the threshold is "about to change". */
const HEARTBEAT_ALERT_S = STALLED_S;
const TIER_NEAR_SHARE = 0.05;
const MAX_LANE_ROWS = 60;

/* ───────── small formatters (candidates for shared.ts) ───────── */

/** `−$49.30` for negatives (a real minus sign), `$49.30` otherwise. */
export const fmtSignedUsd = (v: number): string => (v < 0 ? `−${fmtUsd(-v)}` : fmtUsd(v));
/** `$61.1M` / `$2.33M` / `$38.9K`-free: millions get a suffix, the rest is `fmtUsd`. */
export const fmtUsdCompact = (v: number): string => {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 })}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  return `${sign}${fmtUsd(a)}`;
};
/** Fixed decimals (`2.0`, `1.97`): bps columns must line up, so trailing zeros stay. */
export const fmtFix = (v: number, digits: number): string => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtBps = (v: number | null, digits = 1): string => (v === null ? '—' : `${fmtFix(v, digits)} bps`);

/** `ps -o etime=` (`[[dd-]hh:]mm:ss`) → ms. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)) * 1000;
}

/* ───────── MacBook probe ───────── */

export interface MacProbe {
  /** Per profile: the launchd pid (null = no process) and its uptime from `etime`. Profiles the blob did not mention are absent. */
  procs: Record<string, { pid: number | null; uptimeMs: number | null }>;
  /** The `uptime` line, scrubbed and bounded. */
  uptime: string | null;
  ms: number;
}

/** Parses the probe's stdout (`PID sub2 72748`, `ETIME sub2 01-05:24:51 …`, `UPTIME …`). */
export function parseMacProbe(out: string, ms = 0): MacProbe {
  const procs: MacProbe['procs'] = {};
  let uptime: string | null = null;
  for (const line of out.split('\n')) {
    const pid = /^PID (\S+) (\S+)/.exec(line);
    if (pid) { const [, p = '', v = ''] = pid; procs[p] = { pid: /^\d+$/.test(v) ? Number(v) : null, uptimeMs: null }; continue; }
    const et = /^ETIME (\S+)\s+(\S+)/.exec(line);
    if (et) { const [, p = '', v = ''] = et; const cur = procs[p] ?? { pid: null, uptimeMs: null }; procs[p] = { ...cur, uptimeMs: parseEtime(v) }; continue; }
    const up = /^UPTIME\s+(.*)$/.exec(line);
    if (up) uptime = scrub((up[1] ?? '').trim().replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, ''), 100) || null;
  }
  return { procs, uptime, ms };
}

/* ───────── per-deps slow caches (fresh deps in tests ⇒ fresh caches) ───────── */

interface PrinterFetch { data: Record<string, unknown>; ms: number }
interface OpsCaches { printer: ReturnType<typeof slowCache<PrinterFetch>>; mac: ReturnType<typeof slowCache<MacProbe>> }
const caches = new WeakMap<HubDeps, OpsCaches>();

function cachesFor(deps: HubDeps): OpsCaches {
  let c = caches.get(deps);
  if (c) return c;
  c = {
    printer: slowCache<PrinterFetch>(SLOW_CACHE_MS.ops, async () => {
      const t0 = deps.now();
      const data = await deps.fetchJson(HUB_URLS.printerStatus, HUB_TIMEOUTS.ops);
      if (!isObj(data)) throw new Error('JSON shape');
      return { data, ms: deps.now() - t0 };
    }, deps.now, { waitMs: HUB_TIMEOUTS.firstWait }), // :8765 takes 10 s+ to answer; the first hub answer must not wait for it
    mac: slowCache<MacProbe>(SLOW_CACHE_MS.ssh, async () => {
      if (!deps.exec) throw new Error('exec unavailable');
      const t0 = deps.now();
      const out = await deps.exec('ssh', MACBOOK_SSH_ARGS, { timeoutMs: HUB_TIMEOUTS.ssh });
      if (out === null) throw new Error('ECONNREFUSED ssh');
      return parseMacProbe(out, deps.now() - t0);
    }, deps.now),
  };
  caches.set(deps, c);
  return c;
}

/* ───────── mirrored files (sub2/sub3 are mirrored from the MacBook every ~67 s) ───────── */

interface Mirror {
  label: string | null;
  remoteHost: string | null;
  day: { day: string | null; volume: number | null; cost: number | null; cycles: number | null } | null;
  lifetime: { volume: number | null; cost: number | null; bps: number | null } | null;
  daemonStatus: string | null;
  /** Daemon heartbeat (`risex_printer_multi.json`.updated) and start (`started`). */
  heartbeat: string | null;
  started: string | null;
  markets: string[];
  files: number;
}

const EMPTY_MIRROR: Mirror = { label: null, remoteHost: null, day: null, lifetime: null, daemonStatus: null, heartbeat: null, started: null, markets: [], files: 0 };
const profileDir = (home: string, p: OpsProfile): string => (p === 'main' ? `${home}/StandX_volume` : `${home}/StandX_volume/profiles/${p}`);

async function readJson(deps: HubDeps, file: string): Promise<Record<string, unknown> | null> {
  const text = await deps.readText(file).catch(() => null);
  if (!text) return null;
  try { const v: unknown = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
}

async function readMirror(deps: HubDeps, p: OpsProfile): Promise<Mirror> {
  const dir = profileDir(deps.home, p);
  const [daemon, multi, day, label, remote] = await Promise.all([
    readJson(deps, `${dir}/reports/risex_daemon.json`), readJson(deps, `${dir}/reports/risex_printer_multi.json`), readJson(deps, `${dir}/state_daemon/day.json`),
    deps.readText(`${dir}/label.txt`).catch(() => null), deps.readText(`${dir}/remote_host.txt`).catch(() => null),
  ]);
  const lifetime = daemon && (num(daemon.lifetime_volume) !== null || num(daemon.lifetime_cost) !== null) ? { volume: num(daemon.lifetime_volume), cost: num(daemon.lifetime_cost), bps: num(daemon.lifetime_bps) } : null;
  return {
    label: str(label?.trim(), 40), remoteHost: str(remote?.trim(), 20),
    day: day ? { day: str(day.day, 10), volume: num(day.volume), cost: num(day.cost), cycles: num(day.cycles) } : null,
    lifetime, daemonStatus: daemon ? str(daemon.status, 60) : null,
    heartbeat: toIso(multi?.updated) ?? toIso(daemon?.updated), started: toIso(multi?.started),
    markets: arr(multi?.markets ?? daemon?.markets).filter((m): m is string => typeof m === 'string').slice(0, 20),
    files: [daemon, multi, day, label, remote].filter((x) => x !== null).length,
  };
}

/* ───────── one printer, assembled from status row + mirror + unit/launchd ───────── */

interface FeeTier { tier: number | null; taker: number | null; maker: number | null; vol14d: number | null; nextTier: number | null; nextThreshold: number | null; nextRemaining: number | null; nextTaker: number | null; nextMaker: number | null }
interface Lane { market: string; state: string; why: string; volume: number | null; cost: number | null; bps: number | null; over: boolean }

interface Printer {
  profile: OpsProfile; name: string; label: string | null;
  host: 'server' | 'remote'; hostLabel: string;
  daemon: 'alive' | 'stalled' | 'unset' | null; heartbeat: string | null; hbAgeS: number | null;
  volume: number | null; cost: number | null; bps: number | null; cycles: number | null;
  fee: FeeTier | null; lifetime: Mirror['lifetime'];
  /** The status API's ledger lifetime (main only): the daemon file's lifetime is a since-reset counter. */
  ledger: { volume: number | null; cost: number | null; bps: number | null } | null;
  markets: string[]; lanes: Lane[];
  cycle: { status: string | null; volume: number | null; cost: number | null } | null;
  watch: { level: string | null; why: string } | null;
  overCeiling: boolean; ceilingBps: number | null;
  unit: UnitInfo; proc: { pid: number | null; uptimeMs: number | null } | null; macOk: boolean | null;
  /** Process confirmed running (true), confirmed absent (false), unknown (null: MacBook unreachable). */
  running: boolean | null;
  up: boolean; state: HubState; sub: string; note: string | null;
}

function feeTier(v: unknown): FeeTier | null {
  if (!isObj(v)) return null;
  return { tier: num(v.tier), taker: num(v.taker_bps), maker: num(v.maker_bps), vol14d: num(v.volume_14d), nextTier: num(v.next_tier), nextThreshold: num(v.next_threshold), nextRemaining: num(v.next_remaining), nextTaker: num(v.next_taker_bps), nextMaker: num(v.next_maker_bps) };
}

function buildPrinter(p: OpsProfile, row: Record<string, unknown> | null, mirror: Mirror, unit: UnitInfo, mac: { value: MacProbe | null; ok: boolean | null; at: number | null }, now: number, ledger: Record<string, unknown> | null = null): Printer {
  const remote = (row ? str(row.remote_host, 20) : null) ?? mirror.remoteHost;
  const host: Printer['host'] = remote ? 'remote' : 'server';
  const hostLabel = remote ? (/^macbook$/i.test(remote) ? '맥북' : remote) : '서버';
  const daemonRaw = row ? str(row.daemon, 10) : null;
  const daemon: Printer['daemon'] = daemonRaw === 'alive' || daemonRaw === 'stalled' || daemonRaw === 'unset' ? daemonRaw : null;
  const heartbeat = latestIso(row ? toIso(row.updated) : null, mirror.heartbeat);
  const hbAgeS = heartbeat ? Math.max(0, (now - Date.parse(heartbeat)) / 1000) : null;
  const volume = (row ? num(row.volume) : null) ?? mirror.day?.volume ?? null;
  const cost = (row ? num(row.cost) : null) ?? mirror.day?.cost ?? null;
  const bps = (row ? num(row.bps) : null) ?? (volume && cost !== null && volume > 0 ? (cost / volume) * 1e4 : null);
  const cycleObj = row && isObj(row.cycle) ? row.cycle : null;
  const watchObj = row && isObj(row.watch) ? row.watch : null;
  const lanes: Lane[] = row ? objs(row.lanes_now).map((l) => ({ market: str(l.market, 16) ?? '—', state: str(l.state, 20) ?? '—', why: scrub(l.why, 160), volume: num(l.today_volume), cost: num(l.today_cost), bps: num(l.today_bps), over: l.over_ceiling === true })) : [];
  const markets = row ? arr(row.markets).filter((m): m is string => typeof m === 'string').slice(0, 20) : mirror.markets;
  const ceiling = row && isObj(row.ceiling) ? row.ceiling : null;
  const proc = host === 'remote' && mac.value ? mac.value.procs[p] ?? null : null;
  const macOk = host === 'remote' ? mac.ok : null;
  const running: boolean | null = host === 'server' ? unit.active === 'active' || unit.active === 'activating' : macOk ? (proc?.pid ?? null) !== null : null;
  const stale = hbAgeS !== null && hbAgeS > HEARTBEAT_ALERT_S;
  // Up = the process is confirmed, or the daemon reports alive with a fresh heartbeat (MacBook unreachable ⇒ trust the heartbeat).
  const up = daemon !== 'stalled' && !stale && (running === true || daemon === 'alive');
  // State + the one-line sub.
  const uptimeMs = host === 'server' ? (unit.since ? Math.max(0, now - Date.parse(unit.since)) : null) : proc?.uptimeMs ?? null;
  const subParts: string[] = [];
  let state: HubState = 'ok';
  const reasons: string[] = [];
  if (!up) {
    // Process confirmed running but not printing ⇒ warn; otherwise down.
    state = running === true ? 'warn' : 'down';
    subParts.push(running === false ? (host === 'server' ? `유닛 ${UNIT_STATE_KO[unit.active]}${unit.sub ? ` (${unit.sub})` : ''}` : 'launchd 프로세스 없음') : daemon === 'stalled' ? '데몬 stalled' : stale ? '데몬 응답 없음' : '데몬 상태 없음');
  } else {
    if (host === 'remote' && macOk === false) { state = 'warn'; subParts.push(`맥북 연결 끊김 · 마지막 확인 ${mac.at !== null ? fmtAgo(Math.max(0, now - mac.at)) : '없음'}`); reasons.push('ssh 실패 — 미러 파일·상태 API 값으로 표시'); }
    else if (uptimeMs !== null) subParts.push(`가동 ${fmtDuration(uptimeMs)}`);
    else if (mirror.started) subParts.push(`데몬 시작 ${agoFrom(mirror.started, now)}`);
    else subParts.push('가동');
    if (running === false) { state = 'warn'; reasons.push(host === 'server' ? `서버 유닛 ${UNIT_STATE_KO[unit.active]}인데 하트비트 생존` : 'launchd 프로세스 없음인데 하트비트 생존'); }
    if (daemon === 'unset') { state = 'warn'; reasons.push('데몬 상태 미설정'); }
  }
  subParts.push(`하트비트 ${hbAgeS === null ? '없음' : fmtAgo(hbAgeS * 1000)}`);
  const overCeiling = row?.over_ceiling === true;
  if (overCeiling && state === 'ok') state = 'warn';
  const watch = watchObj ? { level: str(watchObj.level, 10), why: scrub(watchObj.why, 140) } : null;
  if (watch?.level && watch.level !== 'OK' && state === 'ok') state = 'warn';
  const noteParts = [...reasons, overCeiling ? `비용 천장 초과 (${fmtBps(bps)} > ${fmtBps(num(ceiling?.bps))})` : null, watch?.why ? `${watch.level && watch.level !== 'OK' ? `[${watch.level}] ` : ''}${watch.why}` : null, host === 'remote' && proc?.pid ? `launchd pid ${proc.pid}` : null, !row && mirror.files ? '상태 API 없음 — 미러 파일 값' : null].filter((x): x is string => !!x);
  return {
    profile: p, name: PROFILE_KO[p], label: (row ? str(row.label, 40) : null) ?? mirror.label, host, hostLabel, daemon, heartbeat, hbAgeS, volume, cost, bps,
    cycles: mirror.day?.cycles ?? null,
    fee: row ? feeTier(row.fee_tier) : null, lifetime: mirror.lifetime, ledger: ledger ? { volume: num(ledger.volume), cost: num(ledger.cost), bps: num(ledger.bps) } : null, markets, lanes,
    cycle: cycleObj ? { status: str(cycleObj.status, 20), volume: num(cycleObj.volume), cost: num(cycleObj.cost) } : null,
    watch, overCeiling, ceilingBps: num(ceiling?.bps), unit, proc, macOk, running, up, state, sub: subParts.join(' · '), note: noteParts.length ? noteParts.join(' · ') : null,
  };
}

const CYCLE_KO: Record<string, string> = { running: '진행 중', idle: '대기', done: '완료', preparing: '준비 중', stopped: '정지', paused: '일시정지' };
const LANE_KO: Record<string, string> = { running: '가동', idle: '대기', halted: '중단', yielded: '양보', waiting: '대기', stopped: '정지', preparing: '준비 중' };

function printerCard(p: Printer): HubCardItem {
  const rows: HubCardItem['rows'] = [];
  rows.push({ label: '오늘 거래량', value: p.volume === null ? '—' : fmtUsd(p.volume) });
  rows.push({ label: '오늘 비용', value: p.cost === null ? '—' : `${fmtUsd(p.cost)} (${fmtBps(p.bps)})`, status: p.overCeiling ? 'bad' : 'info' });
  rows.push({ label: 'PnL', value: p.cost === null ? '—' : fmtSignedUsd(-p.cost), status: 'warn' });
  if (p.fee) {
    rows.push({ label: '수수료 티어', value: `T${p.fee.tier ?? '?'} · 테이커 ${p.fee.taker === null ? '—' : fmtNum(p.fee.taker, 2)} / 메이커 ${p.fee.maker === null ? '—' : fmtNum(p.fee.maker, 2)} bps` });
    if (p.fee.nextRemaining !== null && p.fee.nextThreshold) {
      const near = p.fee.nextRemaining / p.fee.nextThreshold <= TIER_NEAR_SHARE;
      rows.push({ label: '다음 티어까지', value: `${fmtUsdCompact(p.fee.nextRemaining)} 남음 (14일 ${p.fee.vol14d === null ? '—' : fmtUsdCompact(p.fee.vol14d)} / T${p.fee.nextTier ?? '?'} ${fmtUsdCompact(p.fee.nextThreshold)})`, status: near ? 'warn' : 'info' });
    }
  }
  if (p.lifetime) {
    if (p.lifetime.volume !== null) rows.push({ label: '평생 거래량', value: fmtUsdCompact(p.lifetime.volume) });
    if (p.lifetime.cost !== null) rows.push({ label: '평생 비용', value: `${fmtUsd(p.lifetime.cost)} (${fmtBps(p.lifetime.bps, 2)})` });
  }
  if (p.ledger && p.ledger.volume !== null) rows.push({ label: '원장 누적', value: `${fmtUsdCompact(p.ledger.volume)}${p.ledger.cost !== null ? ` · 비용 ${fmtUsd(p.ledger.cost)}` : ''}${p.ledger.bps !== null ? ` (${fmtBps(p.ledger.bps, 2)})` : ''}` });
  rows.push({ label: '레인', value: p.markets.length ? `${p.markets.length} · ${p.markets.join('·')}` : p.lanes.length ? String(p.lanes.length) : '—' });
  if (p.cycle) rows.push({ label: '사이클', value: `${p.cycle.status ? CYCLE_KO[p.cycle.status] ?? p.cycle.status : '—'}${p.cycle.volume !== null ? ` · ${fmtUsd(p.cycle.volume)}` : ''}${p.cycle.cost !== null ? ` · 비용 ${fmtUsd(p.cycle.cost)}` : ''}` });
  else if (p.cycles !== null) rows.push({ label: '사이클', value: `${p.cycles}회 (오늘)` });
  if (p.ceilingBps !== null) rows.push({ label: '비용 천장', value: fmtBps(p.ceilingBps, 2), status: p.overCeiling ? 'bad' : 'ok' });
  return { title: p.name, badge: p.hostLabel, state: p.state, sub: p.sub, rows, ...(p.note ? { note: p.note } : {}) };
}

/* ───────── 7-day cost buckets (main, XAU) ───────── */

const BUCKETS: { key: string; label: string; desc: string }[] = [
  { key: 'actual_fee', label: '거래소 수수료', desc: '체결마다 실제로 낸 테이커·메이커 수수료' },
  { key: 'spread_slippage', label: '스프레드·슬리피지', desc: '체결가가 중간가에서 벗어난 만큼의 비용' },
  { key: 'hold_period_pnl', label: '보유 중 가격 변동', desc: '왕복 사이 포지션을 들고 있는 동안의 손익 (양수 = 손실)' },
  { key: 'emergency_premium', label: '긴급 청산 추가 비용', desc: '정상 청산에 실패해 긴급 청산한 만큼 더 낸 비용' },
  { key: 'funding', label: '펀딩비', desc: '보유 중 지불·수취한 펀딩' },
];
const SETTLEMENTS: { key: string; label: string; desc: string }[] = [
  { key: 'rebate', label: '리베이트', desc: '거래소 정산에서 돌려받은 수수료 (음수 = 크레딧)' },
  { key: 'unexplained_residual', label: '미설명 잔차', desc: '정산 금액 중 버킷으로 설명되지 않는 부분 (음수 = 크레딧)' },
  { key: 'external_adjustment', label: '외부 조정', desc: '수동·외부 조정분' },
];

function costGrid(c: Record<string, unknown>): HubSection {
  const rows: Extract<HubSection, { kind: 'kvgrid' }>['rows'] = [];
  const b = isObj(c.buckets) ? c.buckets : {};
  for (const { key, label, desc } of BUCKETS) {
    const v = isObj(b[key]) ? b[key] : null;
    const usd = v ? num(v.usd) : null;
    if (usd === null) continue;
    const bps = v ? num(v.bps) : null;
    rows.push({ label, desc, value: fmtSignedUsd(usd), sub: fmtBps(bps, 2), status: usd <= 0 ? 'ok' : bps !== null && bps >= 1 ? 'warn' : 'info' });
  }
  const trip = num(c.trip_cost_usd), tripBps = num(c.trip_cost_bps);
  if (trip !== null) rows.push({ label: '왕복 비용 합계', desc: `${num(c.trips) !== null ? `${fmtInt(num(c.trips)!)}회 왕복` : '왕복'} · 거래량 ${num(c.volume_usd) !== null ? fmtUsdCompact(num(c.volume_usd)!) : '—'}`, value: fmtSignedUsd(trip), sub: fmtBps(tripBps, 2), status: 'warn' });
  const sd = isObj(c.settlement_detail) ? c.settlement_detail : {};
  for (const { key, label, desc } of SETTLEMENTS) {
    const usd = num(sd[key]);
    if (usd === null) continue;
    rows.push({ label, desc, value: fmtSignedUsd(usd), status: usd < 0 ? 'ok' : usd > 0 ? 'warn' : 'info' });
  }
  const settle = num(c.settlements_usd);
  if (settle !== null) rows.push({ label: '정산 합계', desc: '리베이트 + 잔차 + 조정 (음수 = 계정에 들어온 금액)', value: fmtSignedUsd(settle), status: settle < 0 ? 'ok' : settle > 0 ? 'warn' : 'info' });
  const att = num(c.maker_attempted), filled = num(c.maker_filled), rate = num(c.maker_fill_rate), share = num(c.implied_maker_share);
  if (att !== null || rate !== null) rows.push({ label: '메이커 체결', desc: '메이커 주문 시도 대비 체결', value: rate === null ? '—' : fmtPct(rate <= 1 ? rate * 100 : rate), sub: att !== null && filled !== null ? `${fmtInt(filled)} / ${fmtInt(att)}` : undefined });
  if (share !== null) rows.push({ label: '메이커 비중(추정)', desc: '수수료로 역산한 메이커 체결 비중', value: fmtPct(share <= 1 ? share * 100 : share) });
  const days = num(c.days) ?? 7, market = str(c.market, 10) ?? 'XAU';
  return sec.kvgrid(`비용 버킷 (${fmtInt(days)}일 ${market} · 메인)`, rows, { open: true, note: '거래량 프린터의 PnL = −비용 (수익은 포인트·티어로 돌아옴). 버킷은 메인 계정 XAU 왕복 기준 · 서브 계정은 일일 합계만 제공 · 정산 음수 = 크레딧.' });
}

/* ───────── the collector ───────── */

export async function collectOps(deps: HubDeps): Promise<HubMode> {
  const links: HubLink[] = [{ label: '열기', href: '/hub/p/ops/', embed: true }];
  const c = cachesFor(deps);
  const [printer, ops, mirrors, ...units] = await Promise.all([
    c.printer(), probe(deps, '/api/ops', HUB_URLS.ops, HUB_TIMEOUTS.ops),
    Promise.all(OPS_ACCOUNTS.map((p) => readMirror(deps, p))), ...OPS_ACCOUNTS.map((p) => showUnit(deps, PRINTER_UNITS[p])),
  ]);
  const now = deps.now();
  const ps = printer.value?.data ?? null;
  const acct = ps && isObj(ps.accounts) ? ps.accounts : null;
  const rowsByProfile = new Map<string, Record<string, unknown>>();
  for (const r of objs(acct?.rows)) { const p = str(r.profile, 10); if (p) rowsByProfile.set(p, r); }
  // Is any printer on a remote host? Only then probe the MacBook (one fixed read-only ssh).
  const remoteNeeded = OPS_ACCOUNTS.some((p, i) => (str(rowsByProfile.get(p)?.remote_host, 20) ?? mirrors[i]?.remoteHost) !== null);
  const mac = remoteNeeded && deps.exec ? await c.mac() : null;
  /** `ok` null = not probed (no exec): the MacBook printers then rely on their heartbeat alone. */
  const macView = { value: mac?.value ?? null, ok: mac === null ? null : !mac.stale && mac.value !== null, at: mac?.at ?? null };

  const sources: HubSource[] = [];
  sources.push(printer.value && !printer.stale ? { name: '프린터 상태', ok: true, ms: printer.value.ms } : { name: '프린터 상태', ok: false, ms: printer.value?.ms ?? 0, error: printer.pending ? '불러오는 중' : `${printer.error ?? '오류'}${printer.value ? ' · 이전 값 사용' : ''}` });
  sources.push(ops.source);
  if (remoteNeeded) sources.push(macView.ok ? { name: '맥북 ssh', ok: true, ms: mac!.value!.ms } : { name: '맥북 ssh', ok: false, ms: mac?.value?.ms ?? 0, error: !deps.exec ? '사용 불가' : `${mac?.error === '오류' || !mac?.error ? '연결 실패' : mac.error}${mac?.value ? ' · 이전 값 사용' : ''}` });
  const mirrorFiles = mirrors.reduce((n, m) => n + m.files, 0);
  sources.push({ name: '미러 파일', ok: mirrorFiles > 0, ms: 0, ...(mirrorFiles > 0 ? {} : { error: '파일 없음' }) });
  const known = units.filter((u) => u.active !== 'missing');
  if (known.length) sources.push({ name: 'systemd', ok: true, ms: 0 });

  const o = isObj(ops.data) ? ops.data : null;
  if (!ps && mirrorFiles === 0 && !o) {
    const why = printer.pending ? '불러오는 중' : printer.error ?? '오류';
    return {
      id: 'ops', name: 'OPS · 펍덱', state: 'down', lastActivity: null, metrics: {}, alerts: [{ level: 'bad', text: `프린터 상태 응답 없음 · ${why}` }], links, sources,
      page: page(`프린터 상태 응답 없음 · ${why}`, '프린터 상태 API·미러 파일 모두 없음 — 대시보드(8765) 가동 여부 확인', [], known.length ? [unitTable(OPS_ACCOUNTS.map((p, i) => ({ p, u: units[i] ?? unitInfo(PRINTER_UNITS[p], null) })), now)] : []),
    };
  }

  const ledger = ps && isObj(ps.accounting) && isObj(ps.accounting.lifetime) ? ps.accounting.lifetime : null;
  const printers = OPS_ACCOUNTS.map((p, i) => buildPrinter(p, rowsByProfile.get(p) ?? null, mirrors[i] ?? EMPTY_MIRROR, units[i] ?? unitInfo(PRINTER_UNITS[p], null), macView, now, p === 'main' ? ledger : null));
  const alerts: HubAlert[] = [];
  let state: HubState = 'ok';
  const worse = (s: HubState): void => { const rank: Record<HubState, number> = { ok: 0, idle: 0, unknown: 1, warn: 2, down: 3 }; if (rank[s] > rank[state]) state = s; };
  if (!ps && printer.pending) alerts.push({ level: 'info', text: '프린터 상태 불러오는 중 (대시보드 8765 응답 10초+) — 미러 파일 값 표시', hint: '다음 갱신(15초)에 반영' });
  else if (!ps) { alerts.push({ level: 'warn', text: `프린터 상태 응답 없음 · ${printer.error ?? '오류'} — 미러 파일 값 표시` }); worse('warn'); }
  else if (printer.stale) { alerts.push({ level: 'warn', text: `프린터 상태 ${printer.error ?? '오류'} · ${printer.at !== null ? fmtAgo(Math.max(0, now - printer.at)) : ''} 값 사용` }); worse('warn'); }
  if (!o) alerts.push({ level: 'info', text: `/api/ops 응답 없음 · ${ops.source.error ?? '오류'} — 7일 비용 버킷 없음` });
  const macDown = remoteNeeded && macView.ok === false;
  if (macDown) { alerts.push({ level: 'warn', text: `맥북 연결 끊김 · 마지막 확인 ${macView.at !== null ? fmtAgo(Math.max(0, now - macView.at)) : '없음'}`, hint: '서브2·서브3 는 하트비트·미러 파일로만 표시 (launchd 확인 불가)' }); worse('warn'); }

  // Per-printer alerts, worst first per printer.
  const decisions: { rank: number; text: string }[] = [];
  const decide = (rank: number, text: string): void => { decisions.push({ rank, text }); };
  for (const p of printers) {
    const main = p.profile === 'main';
    if (!p.up) {
      alerts.push({ level: main ? 'bad' : 'warn', text: `${p.name}(${p.hostLabel}) 정지 · ${p.sub}`, at: p.heartbeat, hint: p.host === 'server' ? `${PRINTER_UNITS[p.profile]} 확인` : `${LAUNCHD_LABEL(p.profile)} (launchd) 확인` });
      worse(main && p.state === 'down' ? 'down' : 'warn');
      decide(main ? 0 : 1, main ? '메인 프린터 정지 — 즉시 확인' : `${p.name} 정지 — 의도된 것인지 확인`);
      continue;
    }
    if (p.daemon === 'stalled') { alerts.push({ level: main ? 'bad' : 'warn', text: `${p.name} 데몬 stalled`, at: p.heartbeat }); worse('warn'); decide(1, `${p.name} 데몬 stalled — 로그 확인`); }
    if (p.hbAgeS !== null && p.hbAgeS > HEARTBEAT_ALERT_S) { alerts.push({ level: 'warn', text: `${p.name} 하트비트 ${fmtAgo(p.hbAgeS * 1000)}`, at: p.heartbeat }); worse('warn'); }
    if (p.overCeiling) { alerts.push({ level: 'warn', text: `${p.name} 비용 천장 초과 · ${fmtBps(p.bps)} > ${fmtBps(p.ceilingBps)}` }); worse('warn'); decide(2, `${p.name} 비용 천장 초과 — 레인·클립 점검`); }
    if (p.running === false) { alerts.push({ level: 'warn', text: p.host === 'server' ? `${p.name} 서버 유닛 ${UNIT_STATE_KO[p.unit.active]}인데 하트비트 생존 — 어디서 도는지 확인` : `${p.name} 맥북 launchd 프로세스 없음인데 하트비트 생존 — 확인` }); worse('warn'); decide(2, `${p.name} 프로세스 없음·하트비트 생존 — 어디서 도는지 확인`); }
    if (p.host === 'remote' && (p.unit.active === 'active' || p.unit.active === 'activating')) { alerts.push({ level: 'warn', text: `${p.name} 서버 유닛도 가동 중 — 맥북과 중복 가능` }); worse('warn'); decide(2, `${p.name} 서버·맥북 중복 가동 의심 — 확인`); }
    if (p.watch?.level && p.watch.level !== 'OK') { alerts.push({ level: 'warn', text: `${p.name} watch ${p.watch.level} · ${p.watch.why}` }); worse('warn'); }
    if (p.fee && p.fee.nextRemaining !== null && p.fee.nextThreshold && p.fee.nextRemaining / p.fee.nextThreshold <= TIER_NEAR_SHARE) {
      alerts.push({ level: 'info', text: `${p.name} 수수료 티어 T${p.fee.tier ?? '?'}→T${p.fee.nextTier ?? '?'} 임박 · ${fmtUsdCompact(p.fee.nextRemaining)} 남음` });
      decide(5, `${p.name} 티어 변경 임박 (${fmtUsdCompact(p.fee.nextRemaining)} 남음) — 테이커 ${p.fee.taker === null ? '—' : fmtNum(p.fee.taker, 2)}→${p.fee.nextTaker === null ? '—' : fmtNum(p.fee.nextTaker, 2)} bps`);
    }
    if (p.unit.restarts && p.unit.restarts > 0 && p.host === 'server') alerts.push({ level: 'info', text: `${p.name} 유닛 재시작 ${p.unit.restarts}회` });
  }
  if (macDown) decide(3, `맥북 연결 끊김 — ssh·전원 확인 (서브2·서브3 하트비트는 ${printers.filter((p) => p.host === 'remote').map((p) => p.hbAgeS === null ? '없음' : fmtAgo(p.hbAgeS * 1000)).join('·')})`);
  // Services from /api/ops (the printer unit itself is covered above).
  const services = o && isObj(o.services) ? Object.entries(o.services).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 30) : String(v)] as [string, string]) : [];
  for (const [k, v] of services) if (k !== 'risex-printer' && v !== 'active') alerts.push({ level: 'info', text: `${k} ${v}` });

  // Totals: the status API's, else summed from what we have.
  const totals = acct && isObj(acct.totals) ? acct.totals : null;
  const sum = (f: (p: Printer) => number | null): number | null => { const xs = printers.map(f).filter((x): x is number => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) : null; };
  const vol = num(totals?.volume) ?? sum((p) => p.volume);
  const cost = num(totals?.cost) ?? sum((p) => p.cost);
  const bps = num(totals?.bps) ?? (vol && cost !== null && vol > 0 ? (cost / vol) * 1e4 : null);
  const up = printers.filter((p) => p.up);
  const upServer = up.filter((p) => p.host === 'server').length, upRemote = up.length - upServer;
  const downNames = printers.filter((p) => !p.up).map((p) => p.name);
  const costObj = o && isObj(o.risex) && isObj(o.risex.cost) ? o.risex.cost : null;
  const day = o && isObj(o.risex) && isObj(o.risex.day) ? o.risex.day : null;
  const tripBps = costObj ? num(costObj.trip_cost_bps) : null;
  const fillRate = costObj ? num(costObj.maker_fill_rate) : null;

  const headline = `프린터 ${up.length}${up.length === printers.length ? '대' : `/${printers.length}`} 가동(서버 ${upServer} · 맥북 ${upRemote})${downNames.length ? `, ${downNames.join('·')} 정지` : ''}${vol !== null ? ` · 오늘 거래량 ${fmtUsd(vol)}` : ''}${cost !== null ? ` · 비용 ${fmtUsd(cost)}${bps !== null ? ` (${fmtBps(bps)})` : ''}` : ''}`;
  const decision = decisions.sort((a, b) => a.rank - b.rank)[0]?.text ?? (state === 'ok' ? '조치 없음' : '주의 항목 확인');
  const kpis: HubKpi[] = [
    kpi('오늘 거래량', vol === null ? '—' : fmtUsd(vol), { hint: `${printers.filter((p) => p.volume !== null).length}계정 합` }),
    kpi('오늘 비용', cost === null ? '—' : fmtUsd(cost), { status: cost === null ? 'info' : 'warn', hint: cost === null ? undefined : `PnL ${fmtSignedUsd(-cost)} · 거래량 프린터` }),
    kpi('평균 bps', bps === null ? '—' : fmtFix(bps, 2), { unit: 'bps', hint: '비용 ÷ 거래량' }),
    kpi('가동 프린터', `${up.length}/${printers.length}`, { status: up.length === printers.length ? 'ok' : printers.some((p) => !p.up && p.profile === 'main') ? 'bad' : 'warn', hint: `서버 ${upServer} · 맥북 ${upRemote}` }),
    kpi('7일 XAU 왕복 비용', tripBps === null ? '—' : fmtFix(tripBps, 2), { unit: 'bps', hint: costObj ? `${num(costObj.trip_cost_usd) !== null ? fmtUsd(num(costObj.trip_cost_usd)!) : '—'} · ${num(costObj.trips) !== null ? `${fmtInt(num(costObj.trips)!)}회` : '—'} · 메인` : '/api/ops 없음' }),
    kpi('메이커 체결률', fillRate === null ? '—' : fmtPct(fillRate <= 1 ? fillRate * 100 : fillRate), { hint: costObj && num(costObj.maker_filled) !== null ? `${fmtInt(num(costObj.maker_filled)!)}/${fmtInt(num(costObj.maker_attempted) ?? 0)} · 7일` : '7일' }),
  ];

  const sections: HubSection[] = [];
  sections.push(sec.cards('프린터', printers.map(printerCard), { open: true, cols: 2, note: '서버 2대는 systemd, 맥북 2대는 launchd(ssh 읽기 전용) · 하트비트는 프린터 상태 API·미러 파일 기준 · PnL = −오늘 비용 · 평생 = 데몬 파일 누적(리셋 이후), 원장 누적 = 상태 API 원장(메인만)' }));
  if (costObj) sections.push(costGrid(costObj));
  const laneRows: string[][] = [];
  for (const p of printers) for (const l of p.lanes) {
    if (laneRows.length >= MAX_LANE_ROWS) break;
    laneRows.push([l.market, `${p.name}(${p.hostLabel})`, l.over ? '천장 초과' : LANE_KO[l.state] ?? l.state, l.volume === null ? '—' : fmtUsd(l.volume), l.cost === null ? '—' : fmtUsd(l.cost), l.bps === null ? '—' : fmtFix(l.bps, 2), l.why || '—']);
  }
  if (laneRows.length) {
    const overlaps = objs(totals?.overlaps).map((ov) => `${str(ov.market, 10) ?? '?'}(${arr(ov.accounts).filter((a): a is string => typeof a === 'string').map((a) => PROFILE_KO[a as OpsProfile] ?? a).join('·')})`).slice(0, 8);
    sections.push(sec.table('레인 현황', ['마켓', '프린터', '상태', '오늘 거래량', '오늘 비용', 'bps', '이유'], laneRows, { num: [3, 4, 5], wrap: [6], note: overlaps.length ? `여러 프린터가 같이 도는 마켓: ${overlaps.join(' · ')}` : undefined }));
  }
  sections.push(unitTable(printers.map((p) => ({ p: p.profile, u: p.unit, printer: p })), now, services, macView.value?.uptime ?? null, macDown));
  sections.push(sec.raw('원본 보기', '/hub/p/ops/', { embed: true, note: '읽기 전용 프록시 · 조작 버튼 비활성' }));

  const metrics: Record<string, HubMetricValue> = { '프린터': `${up.length}/${printers.length}` };
  if (vol !== null) metrics['오늘 거래량'] = fmtUsd(vol);
  if (cost !== null) metrics['오늘 비용'] = `${fmtUsd(cost)}${bps !== null ? ` (${fmtBps(bps)})` : ''}`;
  if (macView.ok !== null) metrics['맥북'] = macView.ok ? '연결' : '끊김';
  const lastActivity = latestIso(...printers.map((p) => p.heartbeat), o ? toIso(o.generated_at) : null);
  const live = ps ? (ps.unit_is_live === false || ps.live === false) : false;
  return { id: 'ops', name: 'OPS · 펍덱', state, lastActivity, metrics, alerts: sortAlerts(alerts), links, sources, ...(live ? { tag: 'DRY RUN' } : {}), page: page(headline, decision, kpis, sections) };
}

/** 서비스/유닛: the server units, the MacBook launchd jobs, and the dashboard's service list. */
function unitTable(items: { p: OpsProfile; u: UnitInfo; printer?: Printer }[], now: number, services: [string, string][] = [], macUptime: string | null = null, macDown = false): HubSection {
  const rows: string[][] = [];
  for (const { p, u, printer } of items) {
    if (printer && printer.host === 'remote') {
      const proc = printer.proc;
      const status = printer.macOk === false ? '연결 끊김' : proc?.pid ? `가동 · pid ${proc.pid}` : printer.macOk ? '없음' : '—';
      const since = proc?.uptimeMs != null ? `${fmtKst(new Date(now - proc.uptimeMs).toISOString())} · ${fmtAgo(proc.uptimeMs)}` : '—';
      rows.push([LAUNCHD_LABEL(p), printer.hostLabel, status, since]);
      if (u.active !== 'missing' && u.active !== 'inactive') rows.push([PRINTER_UNITS[p], '서버', `${UNIT_STATE_KO[u.active]}${u.sub ? ` (${u.sub})` : ''} — 맥북과 중복?`, u.since ? `${fmtKst(u.since)} · ${agoFrom(u.since, now)}` : '—']);
      continue;
    }
    rows.push([PRINTER_UNITS[p], '서버', u.active === 'missing' ? '정보 없음' : `${UNIT_STATE_KO[u.active]}${u.sub ? ` (${u.sub})` : ''}${u.restarts ? ` · 재시작 ${u.restarts}` : ''}`, u.since ? `${fmtKst(u.since)} · ${agoFrom(u.since, now)}` : '—']);
  }
  for (const [k, v] of services) if (k !== 'risex-printer') rows.push([k, '서버', v === 'active' ? '가동' : v === 'inactive' ? '정지' : v, '—']);
  const notes = ['서브2·서브3 는 맥북 launchd 로 가동 — 서버의 risex-printer@sub2/@sub3 유닛 정지는 정상', macUptime ? `맥북 ${macUptime}` : null, macDown ? '맥북 ssh 실패 — launchd 행은 마지막 확인 값 없음' : null].filter((x): x is string => !!x);
  return sec.table('서비스/유닛', ['유닛', '호스트', '상태', '시작'], rows, { note: notes.join(' · ') });
}
