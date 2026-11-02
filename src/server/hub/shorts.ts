/**
 * 영상 › Shorts 공장: the read-only view of ~/shorts_status (status.json, channels.json, history.jsonl, reference_ledger.json;
 * schema in scripts/shorts-factory/SCHEMA.md) plus three host probes (df, claude-pick, codex). Attached to the 영상 mode as
 * `mode.shorts`; the engineering-shorts page stays exactly as collectVideo builds it.
 *
 * Honesty rules: a missing or malformed file is said so; a null count stays null (미공개/미수집), never 0; the bootstrap
 * status.json (placeholder) is never healthy. Nothing here writes, uploads or downloads.
 */
import type { HubAlert, HubKpi, HubState, SfBlocker, SfLongform, SfLongformItem, SfRoutineRow, SfCalendar, SfCalendarDay, SfCalendarItem, SfChannel, SfClaudeAccount, SfDistCell, SfDistChannel, SfDistShort, SfDistUpload, SfDistribution, SfUploadState, SfFile, SfFileState, SfLedger, SfLedgerItem, SfLedgerStatus, SfLedgerType, SfPipeline, SfPlatformId, SfPlatformStatus, SfRoutineStatus, SfVideo, ShortsFactoryView } from '../../shared/hub-types';
import { SF_ACCOUNT_STATES, SF_LEDGER_STATUSES, SF_PLATFORMS, SF_UPLOAD_STATES } from '../../shared/hub-types';
import { DAY_MS, HOUR_MS, HUB_TIMEOUTS, agoFrom, arr, fmtClock, fmtDate, fmtInt, isObj, kpi, num, objs, scrub, slowCache, sortAlerts, str, toIso, type HubDeps, type SlowResult } from './shared';

export const SF_DIR = 'shorts_status';
export const SF_PLANNED_TOTAL = 20;
/** status.json older than 6 h and channels.json older than 8 h (two missed 4-hourly runs) are 오래됨; a `running` routine older than 6 h is stuck. */
export const SF_STALE_MS = { status: 6 * HOUR_MS, channels: 8 * HOUR_MS, running: 6 * HOUR_MS } as const;
export const SF_LIMITS = { distPlatforms: 12, distShorts: 200, videos: 10, logLines: 40, lineChars: 200, historyBytes: 512 * 1024, days: 14, sparkPoints: 40, items: 400, channelAlerts: 20 } as const;
/** Host probes once a minute; the first hub answer waits this long for them before saying 확인 중. */
export const SF_PROBE_MS = 60_000;
export const SF_PROBE_WAIT_MS = 2_500;
/** claude-pick writes its verdicts to stderr and exits 3/4 for "no account"; one fixed, literal argv folds both into stdout. */
const CLAUDE_PICK_ARGV = ['-c', 'claude-pick --verbose 2>&1; echo "claude-pick-exit=$?"'] as const;

/* ───────── raw file shapes (after parsing, before the view) ───────── */

interface SchedRow { channelId: string; videoId: string | null; title: string | null; at: string; atMs: number }
interface StatusRaw {
  generatedAt: string | null; placeholder: boolean;
  routine: { lastRunAt: string | null; status: SfRoutineStatus; logTail: string[] };
  lastRender: { file: string | null; at: string | null };
  /** null = the file does not carry a gate_failures array (nothing is known, not "none"). */
  gateFailures: string[] | null; queueDepth: number | null; scheduled: SchedRow[]; published: SchedRow[]; notes: string[];
  distribution: SfDistribution | null;
  routines: SfRoutineRow[]; longform: SfLongform | null; blockers: SfBlocker[];
}
interface ChannelsRaw { generatedAt: string | null; plannedTotal: number; channels: SfChannel[] }
interface HistRow { at: string; atMs: number; channelId: string | null; source: 'collector' | 'user_reference'; videos: { id: string; views: number | null }[]; mapping: string | null }

const ROUTINE_STATUS: readonly SfRoutineStatus[] = ['ok', 'failed', 'running', 'unknown'];
const PLATFORM_STATUS: readonly SfPlatformStatus[] = ['live', 'none', 'unknown'];
const validMs = (iso: string | null): number | null => { const ms = iso ? Date.parse(iso) : NaN; return Number.isFinite(ms) ? ms : null; };
const count = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? Math.round(n) : null; };
/** Credential-looking values inside free text (log tails, verdict lines) are blanked; the key name stays so the line still reads. */
const SECRET_ASSIGN_RE = /\b((?:api[-_]?)?key|token|secret|password|passwd|cookie|authorization|credential)s?\b(\s*[=:]\s*)(?:(?:bearer|basic)\s+[^\s"']+|"[^"]*"|'[^']*'|[^\s"']+)/gi;
const AUTH_SCHEME_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const KEY_SHAPE_RE = /\b(?:sk|ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_][A-Za-z0-9_.-]{8,}|\bAIza[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{12,}|\bya29\.[A-Za-z0-9_.-]{10,}/g;
export function redact(s: string): string { return s.replace(SECRET_ASSIGN_RE, '$1$2…').replace(AUTH_SCHEME_RE, '$1 …').replace(KEY_SHAPE_RE, '…'); }
const line = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? scrub(redact(v.trim()), SF_LIMITS.lineChars) : null);
const lines = (v: unknown, max: number): string[] => (typeof v === 'string' ? v.split('\n') : arr(v)).map(line).filter((s): s is string => s !== null).slice(-max);
const baseName = (v: unknown): string | null => { const s = str(v, 200); return s ? (s.split('/').pop() ?? null) : null; };

/** Parses `text` as a JSON object; the file's state and a note when it is not one. */
function parseJsonFile(name: string, text: string | null): { obj: Record<string, unknown> | null; file: SfFile } {
  if (text === null) return { obj: null, file: { name, state: 'missing', at: null, note: '파일 없음' } };
  let v: unknown;
  try { v = JSON.parse(text); } catch (err) { return { obj: null, file: { name, state: 'malformed', at: null, note: 'JSON 해석 실패' } }; } // the parser's message quotes the raw source; a constant label leaks nothing
  if (!isObj(v)) return { obj: null, file: { name, state: 'malformed', at: null, note: '객체가 아님' } };
  return { obj: v, file: { name, state: 'fresh', at: toIso(v.generated_at), note: null } };
}
/** Freshness from generated_at: no usable time is malformed, older than `staleMs` is stale. */
function withAge(file: SfFile, staleMs: number, nowMs: number): SfFile {
  if (file.state !== 'fresh') return file;
  const ms = validMs(file.at);
  if (ms === null) return { ...file, state: 'malformed', note: 'generated_at 없음 또는 형식 오류' };
  if (nowMs - ms > staleMs) return { ...file, state: 'stale', note: `${agoFrom(file.at, nowMs)} 기록` };
  return file;
}

function schedRows(v: unknown): SchedRow[] {
  const out: SchedRow[] = [];
  for (const r of objs(v).slice(0, SF_LIMITS.items)) {
    const channelId = str(r.channel_id, 64); const at = toIso(r.publish_at ?? r.published_at ?? r.at); const atMs = validMs(at);
    if (!channelId || !at || atMs === null) continue;
    out.push({ channelId, videoId: str(r.video_id, 64), title: line(r.title), at, atMs });
  }
  return out;
}

export function parseStatus(text: string | null, nowMs: number): { raw: StatusRaw | null; file: SfFile } {
  const { obj, file } = parseJsonFile('status.json', text);
  if (!obj) return { raw: null, file };
  const routine = isObj(obj.routine) ? obj.routine : {};
  const statusText = str(routine.status, 20);
  const status: SfRoutineStatus = statusText === null ? 'unknown' : (ROUTINE_STATUS as readonly string[]).includes(statusText) ? (statusText as SfRoutineStatus) : 'invalid';
  const render = isObj(obj.last_render) ? obj.last_render : {};
  const raw: StatusRaw = {
    generatedAt: file.at,
    placeholder: obj.placeholder === true || status === 'unknown',
    routine: { lastRunAt: toIso(routine.last_run_at), status, logTail: lines(routine.log_tail, SF_LIMITS.logLines) },
    lastRender: { file: baseName(render.file), at: toIso(render.at) },
    gateFailures: !Array.isArray(obj.gate_failures) ? null : arr(obj.gate_failures).slice(0, 20).map((g) => (isObj(g) ? line([str(g.gate, 60), line(g.detail)].filter(Boolean).join(' · ')) : line(g))).filter((s): s is string => s !== null),
    queueDepth: count(obj.queue_depth),
    scheduled: schedRows(obj.scheduled),
    published: schedRows(obj.published),
    notes: lines(obj.notes, 20),
    distribution: parseDistribution(obj.distribution),
    routines: parseRoutines(obj.routines),
    longform: parseLongform(obj.longform),
    blockers: parseBlockers(obj.blockers, nowMs),
  };
  let f = withAge(file, SF_STALE_MS.status, nowMs);
  if (raw.placeholder && f.state !== 'malformed') f = { ...f, state: 'placeholder', note: f.state === 'stale' ? `자리표시자 · ${f.note}` : '자리표시자 · 루틴이 아직 쓰지 않음' };
  return { raw, file: f };
}

/* ───────── routines · longform · blockers (golf-shorts scripts/push_dashboard_status.py) ───────── */

export function parseRoutines(v: unknown): SfRoutineRow[] {
  return objs(v).slice(0, 12).flatMap((r) => {
    const id = str(r.id, 40); const name = line(r.name) ?? id; if (!id || !name) return [];
    const s = str(r.status, 20);
    const status: SfRoutineStatus = s === null ? 'unknown' : (ROUTINE_STATUS as readonly string[]).includes(s) ? (s as SfRoutineStatus) : 'invalid';
    return [{ id, name, schedule: line(r.schedule), lastRunAt: toIso(r.last_run_at), status, note: line(r.note) }];
  });
}
function longformItems(v: unknown): SfLongformItem[] {
  return objs(v).slice(0, 60).flatMap((r) => {
    const id = str(r.id, 80); if (!id) return [];
    const d = num(r.duration_s);
    return [{ id, channelName: line(r.channel_name) ?? str(r.channel, 64), title: line(r.title), url: httpOrNull(r.url), state: str(r.state, 20), at: toIso(r.published_at ?? r.ready_at ?? r.at), durationS: d !== null && d >= 0 ? Math.round(d) : null, plan: line(r.plan) }];
  });
}
const DONE_RE = /^(done|완료|게시|posted|uploaded|ok|✅|x)$/i;
export function parseLongform(v: unknown): SfLongform | null {
  if (!isObj(v)) return null;
  const queue = objs(v.queue).slice(0, 60).flatMap((r) => {
    const text = typeof r.text === 'string' ? line(r.text) : line(Object.values(r).filter((x) => typeof x === 'string' && x.trim()).join(' · '));
    if (!text) return [];
    const done = r.done === true || Object.values(r).some((x) => typeof x === 'string' && DONE_RE.test(x.trim()));
    return [{ text, done }];
  });
  const p = isObj(v.progress) ? v.progress : null;
  return {
    targetPerDay: count(v.target_per_day), doneToday: count(v.done_today),
    published: longformItems(v.published), pending: longformItems(v.pending), queue,
    progress: p ? { file: baseName(p.file), updatedAt: toIso(p.updated_at), lines: lines(p.lines, 10) } : null,
  };
}
/** A blocker raised this long ago and never touched again is dropped as stale: the view shows only live, actionable ones. */
export const SF_BLOCKER_STALE_MS = 30 * 86_400_000;

export function parseBlockers(v: unknown, nowMs?: number): SfBlocker[] {
  return objs(v).slice(0, 40).flatMap((b) => {
    const text = line(b.text); if (!text || b.resolved_at) return [];
    const since = str(b.since, 25);
    const sinceMs = since ? Date.parse(since) : NaN;
    if (nowMs !== undefined && Number.isFinite(sinceMs) && nowMs - sinceMs > SF_BLOCKER_STALE_MS) return [];
    return [{ id: str(b.id, 60) ?? text.slice(0, 20), text, scope: line(b.scope), owner: str(b.owner, 12), since }];
  });
}

/* ───────── distribution: status.json `distribution` (golf-shorts scripts/dist.py) ───────── */

const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;
const httpOrNull = (v: unknown): string | null => { const s = str(v, 500); return s && /^https?:\/\/\S+$/i.test(s) ? s : null; };
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt);
const zeroCounts = (): Record<SfUploadState, number> => ({ queued: 0, scheduled: 0, posted: 0, failed: 0 });
function countsOf(v: unknown): Record<SfUploadState, number> {
  const o = isObj(v) ? v : {}; const c = zeroCounts();
  for (const k of SF_UPLOAD_STATES) c[k] = count(o[k]) ?? 0;
  return c;
}
function setupOf(v: unknown): Record<string, boolean> | null {
  if (!isObj(v)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, x] of Object.entries(v).slice(0, 20)) if (ID_RE.test(k) && typeof x === 'boolean') out[k] = x;
  return Object.keys(out).length ? out : null;
}
/** Tolerant: anything unexpected is dropped, never thrown. Platform ids are short slugs; text is scrubbed like every other line. */
export function parseDistribution(v: unknown): SfDistribution | null {
  if (!isObj(v)) return null;
  const platforms = objs(v.platforms).map((p) => ({ id: str(p.id, 40), name: line(p.label ?? p.name) ?? str(p.id, 40), status: str(p.status, 20), note: line(p.note) }))
    .filter((p): p is SfDistribution['platforms'][number] => p.id !== null && ID_RE.test(p.id)).slice(0, SF_LIMITS.distPlatforms);
  if (!platforms.length) return null;
  const pids = platforms.map((p) => p.id);
  const channels: SfDistChannel[] = objs(v.channels).slice(0, 50).flatMap((c) => {
    const id = str(c.id, 64); const name = line(c.name) ?? id; if (!id || !name) return [];
    const raw = isObj(c.cells) ? c.cells : {};
    const cells: Record<string, SfDistCell> = {};
    for (const pid of pids) {
      const x = isObj(raw[pid]) ? raw[pid] : {};
      cells[pid] = { accountState: pick(x.account_state, SF_ACCOUNT_STATES, 'none'), handle: str(x.handle, 80), url: httpOrNull(x.url), blockers: lines(x.blockers, 6), counts: countsOf(x.counts), views: count(x.views), setup: setupOf(x.setup), setupNote: line(x.setup_note) };
    }
    return [{ id, name, lang: str(c.lang, 8), youtubeChannelId: str(c.youtube_channel_id, 64), publishKst: str(c.publish_kst, 5), cells }];
  });
  const totals: Record<string, Record<SfUploadState, number>> = {};
  const rawTotals = isObj(v.totals) ? v.totals : {};
  for (const pid of pids) totals[pid] = countsOf(rawTotals[pid]);
  const shorts: SfDistShort[] = objs(v.shorts).slice(0, SF_LIMITS.distShorts).flatMap((r) => {
    const id = str(r.id, 80); const channel = str(r.channel, 64); if (!id || !channel) return [];
    const raw = isObj(r.platforms) ? r.platforms : {};
    const platformsOut: Record<string, SfDistUpload> = {};
    for (const pid of pids) {
      const x = raw[pid]; if (!isObj(x)) continue;
      platformsOut[pid] = { state: pick(x.state, SF_UPLOAD_STATES, 'queued'), url: httpOrNull(x.url), at: toIso(x.at), views: count(x.views), videoId: str(x.video_id, 64), error: line(x.error), derived: x.derived === true };
    }
    return [{ id, channel, title: line(r.title), batch: str(r.batch, 40), platforms: platformsOut }];
  });
  const blockers = objs(v.blockers).slice(0, 60).flatMap((b) => { const text = line(b.text); const platform = str(b.platform, 40); return text && platform ? [{ channel: line(b.channel) ?? '—', platform, text }] : []; });
  const setupFields = arr(v.setup_fields).map((k) => str(k, 40)).filter((k): k is string => k !== null && ID_RE.test(k)).slice(0, 20);
  return { platforms, channels, totals, shorts, shortsTotal: count(v.shorts_total) ?? shorts.length, blockers, setupFields, updatedAt: toIso(v.updated_at) };
}

/** YouTube views the collector already has (channels.json videos) fill per-short and per-cell views the ledger left null. */
export function withYoutubeViews(d: SfDistribution | null, channels: SfChannel[]): SfDistribution | null {
  if (!d || !d.platforms.some((p) => p.id === 'youtube')) return d;
  const views = new Map<string, number>();
  for (const c of channels) for (const vid of c.videos) if (vid.views !== null) views.set(vid.id, vid.views);
  if (!views.size) return d;
  const shorts = d.shorts.map((s) => { const y = s.platforms.youtube; if (!y || y.views !== null || !y.videoId || !views.has(y.videoId)) return s; return { ...s, platforms: { ...s.platforms, youtube: { ...y, views: views.get(y.videoId)! } } }; });
  const chans = d.channels.map((c) => {
    const cell = c.cells.youtube; if (!cell || cell.views !== null) return c;
    const known = shorts.filter((s) => s.channel === c.id).map((s) => s.platforms.youtube?.views).filter((n): n is number => typeof n === 'number');
    return known.length ? { ...c, cells: { ...c.cells, youtube: { ...cell, views: known.reduce((a, b) => a + b, 0) } } } : c;
  });
  return { ...d, shorts, channels: chans };
}

function platformsOf(v: unknown): Record<SfPlatformId, SfPlatformStatus> {
  const p = isObj(v) ? v : {};
  const out = {} as Record<SfPlatformId, SfPlatformStatus>;
  for (const id of SF_PLATFORMS) {
    const s = isObj(p[id]) ? str((p[id] as Record<string, unknown>).status, 10) : null;
    out[id] = s !== null && (PLATFORM_STATUS as readonly string[]).includes(s) ? (s as SfPlatformStatus) : 'unknown';
  }
  return out;
}
function videosOf(v: unknown): SfVideo[] {
  const out: SfVideo[] = [];
  for (const r of objs(v).slice(0, SF_LIMITS.videos)) {
    const id = str(r.id, 64);
    if (!id) continue;
    out.push({ id, title: line(r.title), views: count(r.views), uploadedAt: toIso(r.uploaded_at) });
  }
  return out;
}

export function parseChannels(text: string | null, nowMs: number): { raw: ChannelsRaw | null; file: SfFile } {
  const { obj, file } = parseJsonFile('channels.json', text);
  if (!obj) return { raw: null, file };
  const channels: SfChannel[] = [];
  for (const c of objs(obj.channels).slice(0, 100)) {
    const id = str(c.id, 64);
    if (!id) continue;
    const videos = videosOf(c.videos);
    const lastSuccessAt = toIso(c.last_success_at); const okMs = validMs(lastSuccessAt);
    const publish = str(c.publish_kst, 5);
    channels.push({
      id, name: line(c.name) ?? id, publishKst: publish && /^\d{2}:\d{2}$/.test(publish) ? publish : null, platforms: platformsOf(c.platforms),
      subscribers: count(c.subscribers), totalViews: count(c.total_views), videoCount: count(c.video_count), videos,
      latestViews: videos[0]?.views ?? null, spark: null,
      collection: { lastAttemptAt: toIso(c.last_attempt_at), lastSuccessAt, error: line(c.error), stale: okMs === null || nowMs - okMs > SF_STALE_MS.channels },
    });
  }
  const raw: ChannelsRaw = { generatedAt: file.at, plannedTotal: count(obj.planned_total) ?? SF_PLANNED_TOTAL, channels };
  return { raw, file: withAge(file, SF_STALE_MS.channels, nowMs) };
}

/** history.jsonl tail: one observation per line; a cut first line or any broken line is counted and skipped. */
export function parseHistory(text: string | null): { rows: HistRow[]; skipped: number } {
  if (text === null) return { rows: [], skipped: 0 };
  const rows: HistRow[] = []; let skipped = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let v: unknown;
    try { v = JSON.parse(l); } catch { skipped++; continue; }
    if (!isObj(v)) { skipped++; continue; }
    const at = toIso(v.at); const atMs = validMs(at); const source = str(v.source, 20);
    if (!at || atMs === null || (source !== 'collector' && source !== 'user_reference')) { skipped++; continue; }
    const videos = objs(v.videos).slice(0, SF_LIMITS.videos).map((x) => ({ id: str(x.id, 64) ?? '', views: count(x.views) })).filter((x) => x.id);
    rows.push({ at, atMs, channelId: str(v.channel_id, 64), source, videos, mapping: str(v.mapping, 20) });
  }
  rows.sort((a, b) => a.atMs - b.atMs);
  return { rows, skipped };
}

/** The newest video's views over time when the history has ≥2 points for it, else the per-run sum of the latest videos. */
export function sparkOf(ch: SfChannel, rows: HistRow[]): SfChannel['spark'] {
  const mine = rows.filter((r) => r.channelId === ch.id);
  const newest = ch.videos[0]?.id;
  if (newest) {
    const series = mine.map((r) => r.videos.find((v) => v.id === newest)?.views ?? null).filter((v): v is number => v !== null);
    if (series.length >= 2) return { label: '최신 영상 조회', values: series.slice(-SF_LIMITS.sparkPoints) };
  }
  const sums = mine.filter((r) => r.source === 'collector').map((r) => { const vs = r.videos.map((v) => v.views).filter((v): v is number => v !== null); return vs.length ? vs.reduce((a, b) => a + b, 0) : null; }).filter((v): v is number => v !== null);
  return sums.length >= 2 ? { label: '최신 영상 조회 합', values: sums.slice(-SF_LIMITS.sparkPoints) } : null;
}

/* ───────── 적용 현황: reference_ledger.json (hand-maintained; never stale, only present / missing / malformed) ───────── */

/** The five status labels the ledger may carry. Dashes (en/em dash or hyphen) and spacing around them are normalized before matching. */
const LEDGER_STATUS_BY_LABEL: Record<string, SfLedgerStatus> = { '적용됨-운영 중': 'applied', '구현됨-꺼짐': 'built_off', '문서만': 'docs_only', '검토 후 제외': 'rejected', '미착수': 'todo' };
const LEDGER_TYPES: readonly SfLedgerType[] = ['video', 'tool', 'post', 'tip'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HTTP_RE = /^https?:\/\/\S+$/i;
export const normalizeLedgerStatusLabel = (v: string): string => v.trim().replace(/\s*[-‐‑‒–—―−]\s*/g, '-').replace(/\s+/g, ' ');
export function ledgerStatusOf(v: unknown): SfLedgerStatus {
  const s = str(v, 60);
  return s === null ? 'unknown' : LEDGER_STATUS_BY_LABEL[normalizeLedgerStatusLabel(s)] ?? 'unknown';
}
const ledgerDate = (v: unknown): string | null => { const s = str(v, 10); return s !== null && DATE_RE.test(s) ? s : null; };
const ledgerUrl = (v: unknown): string | null => { const s = str(v, 500); return s !== null && HTTP_RE.test(s) ? s : null; };
const emptyCounts = (): Record<SfLedgerStatus, number> => Object.fromEntries(SF_LEDGER_STATUSES.map((k) => [k, 0])) as Record<SfLedgerStatus, number>;

/** Items newest first (added_at desc, then updated_at desc, dates missing last), capped at SF_LIMITS.items; counts per normalized status cover the whole file. */
export function parseLedger(text: string | null): SfLedger {
  const { obj, file } = parseJsonFile('reference_ledger.json', text);
  const counts = emptyCounts();
  if (!obj) return { file, items: [], counts, total: 0, truncated: 0, skipped: 0 };
  const items: SfLedgerItem[] = []; let skipped = 0;
  const entries = Array.isArray(obj.items) ? obj.items : [];
  for (const r of entries) {
    if (!isObj(r)) { skipped++; continue; }
    const id = str(r.id, 80); const title = line(r.title);
    if (!id || !title) { skipped++; continue; }
    const status = ledgerStatusOf(r.status);
    const type = str(r.type, 10);
    items.push({
      id, title, url: ledgerUrl(r.url), type: type !== null && (LEDGER_TYPES as readonly string[]).includes(type) ? (type as SfLedgerType) : 'other',
      whatWeTook: line(r.what_we_took), status, statusText: status === 'unknown' ? line(r.status) : null, statusReason: line(r.status_reason), evidence: line(r.evidence), nextAction: line(r.next_action),
      addedAt: ledgerDate(r.added_at), updatedAt: ledgerDate(r.updated_at),
    });
    counts[status]++;
  }
  const desc = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b.localeCompare(a));
  items.sort((a, b) => desc(a.addedAt, b.addedAt) || desc(a.updatedAt, b.updatedAt) || a.title.localeCompare(b.title));
  const total = items.length;
  const f: SfFile = !Array.isArray(obj.items) ? { ...file, state: 'malformed', note: 'items 배열 없음' } : file;
  return { file: f, items: items.slice(0, SF_LIMITS.items), counts, total, truncated: Math.max(0, total - SF_LIMITS.items), skipped };
}

/* ───────── KST calendar ───────── */

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const kstDate = (ms: number): string => fmtDate(new Date(ms).toISOString());
const dateMs = (date: string): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const addDays = (date: string, n: number): string => new Date(dateMs(date) + n * DAY_MS).toISOString().slice(0, 10);
const dowOf = (date: string): string => DOW[new Date(dateMs(date)).getUTCDay()] ?? '';
/** `YYYY-MM-DD` of tomorrow in Seoul. */
export const kstTomorrow = (nowMs: number): string => addDays(kstDate(nowMs), 1);

/** Two weeks from the Monday of the current Seoul week; items from status.json's scheduled and published lists. */
export function buildCalendar(status: StatusRaw | null, statusFile: SfFile, channels: SfChannel[], nowMs: number): SfCalendar {
  const today = kstDate(nowMs); const tomorrow = addDays(today, 1);
  const start = addDays(today, -((new Date(dateMs(today)).getUTCDay() + 6) % 7));
  const names = new Map(channels.map((c) => [c.id, c.name]));
  const days: SfCalendarDay[] = Array.from({ length: SF_LIMITS.days }, (_, i) => { const date = addDays(start, i); return { date, dow: dowOf(date), today: date === today, tomorrow: date === tomorrow, items: [] }; });
  const byDate = new Map(days.map((d) => [d.date, d]));
  const unavailable = !status ? `status.json ${statusFile.state === 'missing' ? '없음' : '형식 오류'}` : statusFile.state === 'placeholder' ? '자리표시자 · 예약 정보 없음' : null;
  if (status) {
    const put = (kind: SfCalendarItem['kind'], rows: SchedRow[]) => {
      for (const r of rows) {
        const day = byDate.get(kstDate(r.atMs));
        if (day) day.items.push({ kind, channelId: r.channelId, channelName: names.get(r.channelId) ?? r.channelId, time: fmtClock(r.at), title: r.title, videoId: r.videoId });
      }
    };
    put('scheduled', status.scheduled); put('published', status.published);
    for (const d of days) d.items.sort((a, b) => a.time.localeCompare(b.time) || a.channelName.localeCompare(b.channelName));
  }
  return { days, unavailable };
}

/* ───────── host probes: df, claude-pick, codex ───────── */

export function parseDf(out: string | null): SfPipeline['disk'] {
  if (out === null) return { usedPct: null, note: 'df 실행 실패' };
  const last = out.trim().split('\n').pop() ?? '';
  const pct = last.split(/\s+/).find((t) => /^\d{1,3}%$/.test(t));
  return pct ? { usedPct: Number(pct.slice(0, -1)), note: null } : { usedPct: null, note: 'df 출력 해석 실패' };
}

const URL_RE = /https?:\/\/\S+/g;
const VERDICT_RE = /^claude-pick: (제외|후보) ([^:]+): (.+)$/;
/** Keeps only claude-pick's own verdict/message lines and the picked account; anything else on the stream is dropped. */
export function parseClaudePick(out: string | null): SfPipeline['claude'] {
  if (out === null) return { state: 'unknown', summary: 'claude-pick 실행 불가', picked: null, accounts: [] };
  const accounts: SfClaudeAccount[] = []; const messages: string[] = []; let exit: number | null = null; let picked: string | null = null;
  for (const raw of out.split('\n')) {
    const l = raw.trim();
    const m = VERDICT_RE.exec(l);
    if (m) { accounts.push({ id: scrub(m[2] ?? '', 16), verdict: m[1] === '후보' ? 'candidate' : 'excluded', detail: redact(scrub(m[3] ?? '', 120)).replace(URL_RE, '…') }); continue; }
    const e = /^claude-pick-exit=(\d+)$/.exec(l);
    if (e) { exit = Number(e[1]); continue; }
    if (l.startsWith('claude-pick: ')) { messages.push(redact(scrub(l.slice(13), 120)).replace(URL_RE, '…')); continue; }
    if (/^[a-z0-9_-]{1,16}$/.test(l)) picked = l;
  }
  const cand = accounts.filter((a) => a.verdict === 'candidate').length;
  const tally = accounts.length ? ` · 후보 ${cand}/${accounts.length}` : '';
  if (exit === 0 && picked) return { state: 'ok', summary: `계정 ${picked} 선택${tally}`, picked, accounts };
  if (exit === 3) return { state: 'warn', summary: `자격 있는 계정 없음${picked ? ` · 최소 사용 ${picked}` : ''}${tally}`, picked: null, accounts };
  if (exit === 4) return { state: 'warn', summary: `대시보드 조회 실패${picked ? ` · 대체 ${picked}` : ''}`, picked: null, accounts };
  if (exit === null) return { state: 'unknown', summary: messages[0] ?? '응답 해석 불가', picked: null, accounts };
  return { state: 'warn', summary: messages[0] ?? `종료 코드 ${exit}`, picked: null, accounts };
}

export function parseCodex(out: string | null): SfPipeline['codex'] {
  if (out === null) return { available: false, version: null, note: 'codex --version 실패 · 미설치 또는 시간 초과' };
  const v = scrub(out.trim().split('\n')[0] ?? '', 40);
  return v ? { available: true, version: v, note: null } : { available: true, version: null, note: '버전 출력 없음' };
}

interface Probes { disk: SfPipeline['disk']; claude: SfPipeline['claude']; codex: SfPipeline['codex'] }
async function runProbes(deps: HubDeps): Promise<Probes> {
  if (!deps.exec) return { disk: { usedPct: null, note: '측정 불가 · exec 없음' }, claude: { state: 'unknown', summary: '확인 불가 · exec 없음', picked: null, accounts: [] }, codex: { available: null, version: null, note: '확인 불가 · exec 없음' } };
  const [df, pick, codex] = await Promise.all([
    deps.exec('df', ['-P', '/'], { timeoutMs: HUB_TIMEOUTS.default }),
    deps.exec('bash', [...CLAUDE_PICK_ARGV], { timeoutMs: 10_000 }),
    deps.exec('codex', ['--version'], { timeoutMs: HUB_TIMEOUTS.py }),
  ]);
  return { disk: parseDf(df), claude: parseClaudePick(pick), codex: parseCodex(codex) };
}
const PENDING: Probes = { disk: { usedPct: null, note: '측정 중' }, claude: { state: 'unknown', summary: '확인 중', picked: null, accounts: [] }, codex: { available: null, version: null, note: '확인 중' } };
const probeCaches = new WeakMap<HubDeps, () => Promise<SlowResult<Probes>>>();
function probesCached(deps: HubDeps): Promise<SlowResult<Probes>> {
  let c = probeCaches.get(deps);
  if (!c) { c = slowCache(SF_PROBE_MS, () => runProbes(deps), deps.now, { waitMs: SF_PROBE_WAIT_MS }); probeCaches.set(deps, c); }
  return c();
}

/* ───────── the view ───────── */

const ROUTINE_KO: Record<SfRoutineStatus, string> = { ok: '정상', failed: '실패', running: '실행 중', unknown: '미보고', invalid: '형식 오류' };
const fileAlert = (f: SfFile, what: string): HubAlert | null => {
  if (f.state === 'missing') return { level: 'warn', text: `${f.name} 없음`, hint: what };
  if (f.state === 'malformed') return { level: 'warn', text: `${f.name} 형식 오류`, hint: f.note ?? undefined };
  if (f.state === 'stale') return { level: 'warn', text: `${f.name} 오래됨`, at: f.at ?? undefined, hint: f.note ?? undefined };
  return null;
};
const sumOf = (vs: (number | null)[]): { sum: number | null; n: number } => { const k = vs.filter((v): v is number => v !== null); return { sum: k.length ? k.reduce((a, b) => a + b, 0) : null, n: k.length }; };

/** Builds the view from already-read inputs (pure; the tests drive this directly). */
export function buildShortsView(input: { status: string | null; channels: string | null; history: string | null; /** reference_ledger.json; undefined (older callers) reads as missing. */ ledger?: string | null; probes: Probes; probeNote: string | null }, nowMs: number): ShortsFactoryView {
  const st = parseStatus(input.status, nowMs);
  const ledger = parseLedger(input.ledger ?? null);
  const ch = parseChannels(input.channels, nowMs);
  const hist = parseHistory(input.history);
  const channels = (ch.raw?.channels ?? []).map((c) => ({ ...c, spark: sparkOf(c, hist.rows) }));
  const plannedTotal = ch.raw?.plannedTotal ?? SF_PLANNED_TOTAL;
  const liveCount = channels.filter((c) => c.platforms.youtube === 'live').length;
  const calendar = buildCalendar(st.raw, st.file, channels, nowMs);
  const { disk, claude, codex } = input.probes;
  const routine = st.raw?.routine ?? { lastRunAt: null, status: 'unknown' as const, logTail: [] };
  const pipeline: SfPipeline = { routine, lastRender: st.raw?.lastRender ?? { file: null, at: null }, gateFailures: st.raw && st.file.state !== 'placeholder' ? st.raw.gateFailures : null, queueDepth: st.raw?.queueDepth ?? null, disk, claude, codex };
  const unmappedReference = hist.rows.filter((r) => r.source === 'user_reference' && r.channelId === null).flatMap((r) => r.videos.map((v) => ({ at: r.at, videoId: v.id, views: v.views }))).slice(0, 20);

  const alerts: HubAlert[] = [];
  const sa = fileAlert(st.file, '루틴이 아직 status.json 을 쓰지 않았다'); if (sa) alerts.push(sa);
  if (st.file.state === 'placeholder') alerts.push({ level: 'warn', text: '루틴 상태 미보고 · status.json 자리표시자', hint: 'SCHEMA.md 의 routine 블록부터 채운다' });
  const ca = fileAlert(ch.file, 'collect_youtube.py 를 한 번 실행하면 채워진다'); if (ca) alerts.push(ca);
  const mainNote = st.raw?.routines?.[0]?.note ?? null;
  if (routine.status === 'failed') alerts.push({ level: 'bad', text: '루틴 실패', at: routine.lastRunAt ?? undefined, hint: routine.logTail.at(-1) ?? mainNote ?? '로그 꼬리 없음' });
  else if (routine.status === 'invalid') alerts.push({ level: 'warn', text: 'routine.status 형식 오류', hint: 'ok · failed · running 중 하나여야 한다' });
  else if (routine.status === 'running') { const ms = validMs(routine.lastRunAt); if (ms === null || nowMs - ms > SF_STALE_MS.running) alerts.push({ level: 'warn', text: '루틴 실행 중 표시가 6시간 넘게 그대로', at: routine.lastRunAt ?? undefined }); }
  const routines = st.raw?.routines ?? [];
  for (const r of routines.slice(1)) {
    if (r.status === 'failed') alerts.push({ level: 'bad', text: `${r.name} 루틴 실패`, at: r.lastRunAt ?? undefined, hint: r.note ?? undefined });
    else if (r.status === 'running') { const ms = validMs(r.lastRunAt); if (ms !== null && nowMs - ms > SF_STALE_MS.running) alerts.push({ level: 'warn', text: `${r.name} 실행 중 표시가 6시간 넘게 그대로`, at: r.lastRunAt ?? undefined }); }
  }
  const blockers = st.raw?.blockers ?? [];
  const mine = blockers.filter((b) => b.owner === 'user');
  if (mine.length) alerts.push({ level: 'info', text: `사람 손이 필요한 막힘 ${mine.length}건`, hint: mine[0]?.text });
  if (pipeline.gateFailures === null) { if (st.raw && st.file.state !== 'placeholder') alerts.push({ level: 'warn', text: '게이트 실패 미보고', hint: 'status.json 에 gate_failures 배열이 없다' }); }
  else if (pipeline.gateFailures.length) alerts.push({ level: 'warn', text: `게이트 실패 ${pipeline.gateFailures.length}건`, hint: pipeline.gateFailures[0] });
  for (const c of channels.filter((c) => c.collection.error).slice(0, SF_LIMITS.channelAlerts)) alerts.push({ level: 'warn', text: `${c.name} 수집 실패 · 이전 값 유지`, at: c.collection.lastAttemptAt ?? undefined, hint: c.collection.error ?? undefined });
  const tomorrow = kstTomorrow(nowMs); const tmLabel = tomorrow.slice(5);
  let tomorrowOk = 0;
  if (channels.length) {
    if (calendar.unavailable) alerts.push({ level: 'warn', text: `내일(${tmLabel}) 예약 확인 불가 · ${calendar.unavailable}` });
    else {
      const booked = new Set((st.raw?.scheduled ?? []).filter((r) => kstDate(r.atMs) === tomorrow).map((r) => r.channelId));
      for (const c of channels) {
        if (booked.has(c.id)) { tomorrowOk++; continue; }
        if (alerts.length < 60) alerts.push({ level: 'warn', text: `${c.name} 내일(${tmLabel}) 예약 없음`, hint: c.publishKst ? `계획 ${c.publishKst} KST` : undefined });
      }
    }
  }
  if (disk.usedPct === null) alerts.push({ level: 'warn', text: `디스크 사용률 ${disk.note ?? '측정 불가'}` });
  else if (disk.usedPct > 95) alerts.push({ level: 'bad', text: `디스크 ${disk.usedPct}% · 95% 초과`, hint: '렌더/업로드 전에 공간 확보' });
  if (claude.state === 'warn') alerts.push({ level: 'warn', text: `Claude · ${claude.summary}` });
  else if (claude.state === 'unknown') alerts.push({ level: 'warn', text: `Claude ${claude.summary}` });
  if (codex.available === false) alerts.push({ level: 'warn', text: 'Codex 실행 불가', hint: codex.note ?? undefined });
  else if (codex.available === null) alerts.push({ level: 'warn', text: `Codex ${codex.note ?? '확인 불가'}` });
  if (hist.skipped) alerts.push({ level: 'info', text: `history.jsonl 깨진 줄 ${hist.skipped}개 건너뜀` });
  if (ledger.file.state === 'malformed') alerts.push({ level: 'warn', text: 'reference_ledger.json 형식 오류', hint: ledger.file.note ?? undefined });
  if (ledger.skipped) alerts.push({ level: 'info', text: `reference_ledger.json 항목 ${ledger.skipped}개 건너뜀`, hint: 'id 또는 title 없음' });
  if (ledger.counts.unknown) alerts.push({ level: 'info', text: `적용 현황 미분류 ${ledger.counts.unknown}건`, hint: 'status 가 다섯 가지 중 하나가 아님' });
  if (unmappedReference.length) alerts.push({ level: 'info', text: `참고 관측 ${unmappedReference.length}건 채널 미지정`, hint: '수집기가 공개 조회로 채널을 찾으면 자동으로 매핑된다' });
  if (input.probeNote) alerts.push({ level: 'info', text: input.probeNote });
  const sorted = sortAlerts(alerts);

  const subs = sumOf(channels.map((c) => c.subscribers)); const views = sumOf(channels.map((c) => c.totalViews)); const latest = sumOf(channels.map((c) => c.latestViews));
  const n = channels.length;
  const pub = (s: { sum: number | null; n: number }, none: string): HubKpi['hint'] => (n === 0 ? 'channels.json 없음' : s.sum === null ? none : `${s.n}/${n} 채널 공개`);
  const kpis: HubKpi[] = [
    kpi('개설 채널', n === 0 ? '—' : String(liveCount), { unit: `/${plannedTotal}`, status: n === 0 ? 'warn' : liveCount === 0 ? 'warn' : ch.file.state === 'fresh' ? 'ok' : 'warn', hint: ch.file.state === 'fresh' ? `${n}개 기록 · ${agoFrom(ch.file.at, nowMs)} 수집` : `channels.json ${ch.file.state === 'missing' ? '없음' : ch.file.state === 'stale' ? '오래됨' : '형식 오류'}` }),
    kpi('구독자 합', subs.sum === null ? '미공개' : fmtInt(subs.sum), { status: subs.sum === null ? 'info' : undefined, hint: pub(subs, '공개 수집 응답에 없음') }),
    kpi('총 조회 합', views.sum === null ? '미공개' : fmtInt(views.sum), { status: views.sum === null ? 'info' : undefined, hint: pub(views, '공개 수집 응답에 없음 · 부분 합산 안 함') }),
    kpi('최신 영상 조회 합', latest.sum === null ? '미수집' : fmtInt(latest.sum), { status: latest.sum === null ? 'info' : undefined, hint: n === 0 ? 'channels.json 없음' : `${latest.n}/${n} 채널 · 채널당 최신 1편` }),
    kpi('루틴', ROUTINE_KO[routine.status], { status: routine.status === 'ok' ? 'ok' : routine.status === 'failed' ? 'bad' : 'warn', hint: routine.lastRunAt ? `${agoFrom(routine.lastRunAt, nowMs)} 실행` : '실행 기록 없음' }),
    ...(st.raw?.longform ? [kpi('롱폼 오늘', st.raw.longform.doneToday === null ? '미보고' : String(st.raw.longform.doneToday), { unit: st.raw.longform.targetPerDay ? `/${st.raw.longform.targetPerDay}` : undefined, status: st.raw.longform.doneToday !== null && st.raw.longform.targetPerDay !== null && st.raw.longform.doneToday >= st.raw.longform.targetPerDay ? 'ok' : 'info', hint: `게시 ${st.raw.longform.published.length} · 대기 ${st.raw.longform.pending.length}` })] : []),
    kpi('대기열', pipeline.queueDepth === null ? '미보고' : String(pipeline.queueDepth), { status: pipeline.queueDepth === null ? 'warn' : undefined, hint: pipeline.lastRender.file ? `마지막 렌더 ${agoFrom(pipeline.lastRender.at, nowMs)}` : '렌더 기록 없음' }),
    kpi('디스크 /', disk.usedPct === null ? '측정 불가' : String(disk.usedPct), { unit: disk.usedPct === null ? undefined : '%', status: disk.usedPct === null ? 'warn' : disk.usedPct > 95 ? 'bad' : disk.usedPct > 90 ? 'warn' : 'ok', hint: disk.note ?? (disk.usedPct !== null && disk.usedPct > 90 ? '95% 넘으면 주의' : undefined) }),
    kpi('Claude', claude.picked ? `계정 ${claude.picked}` : claude.state === 'ok' ? '선택됨' : claude.state === 'warn' ? '후보 없음' : '확인 불가', { status: claude.state === 'ok' ? 'ok' : 'warn', hint: claude.summary }),
    kpi('Codex', codex.available ? (codex.version ?? '있음') : codex.available === false ? '실행 불가' : '확인 불가', { status: codex.available ? 'ok' : 'warn', hint: codex.note ?? undefined }),
  ];

  const worst = sorted[0];
  const state: HubState = worst?.level === 'bad' ? 'down' : n === 0 && !st.raw ? 'unknown' : worst?.level === 'warn' ? 'warn' : 'ok';
  const headline = worst && worst.level !== 'info' ? worst.text : `채널 ${liveCount}/${plannedTotal} 개설 · 내일 예약 ${tomorrowOk}/${n}`;
  const decision = !st.raw || st.file.state === 'placeholder' ? '루틴이 status.json 을 쓰게 한다' : n === 0 ? '수집기를 한 번 실행한다' : worst && worst.level !== 'info' ? (worst.hint ?? '주의 항목 확인') : '조치 없음';
  return {
    state, headline, decision, kpis, alerts: sorted,
    files: { status: st.file, channels: ch.file, history: { name: 'history.jsonl', state: input.history === null ? 'missing' : 'fresh', at: hist.rows.at(-1)?.at ?? null, note: input.history === null ? '파일 없음' : null, rows: hist.rows.length, skipped: hist.skipped } },
    plannedTotal, liveCount, channels, calendar, pipeline, notes: st.raw?.notes ?? [], unmappedReference, ledger, distribution: withYoutubeViews(st.raw?.distribution ?? null, channels), routines, longform: st.raw?.longform ?? null, blockers, generatedAt: new Date(nowMs).toISOString(),
  };
}

export async function collectShorts(deps: HubDeps): Promise<ShortsFactoryView> {
  const dir = `${deps.home}/${SF_DIR}`;
  const [status, channels, history, ledger, probes] = await Promise.all([
    deps.readText(`${dir}/status.json`), deps.readText(`${dir}/channels.json`), deps.readTail(`${dir}/history.jsonl`, SF_LIMITS.historyBytes), deps.readText(`${dir}/reference_ledger.json`), probesCached(deps),
  ]);
  const probeNote = probes.pending ? '호스트 점검(df · claude-pick · codex) 진행 중' : probes.error ? `호스트 점검 오류 · ${scrub(probes.error, 80)}` : probes.stale ? '호스트 점검 값은 이전 측정' : null;
  return buildShortsView({ status, channels, history, ledger, probes: probes.value ?? PENDING, probeNote }, deps.now());
}
