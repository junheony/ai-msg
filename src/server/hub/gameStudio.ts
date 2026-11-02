/**
 * 게임 스튜디오 (gamified): the studio as a game lobby rather than an ops sheet.
 *  · Games come from `studio/games/*.json` manifests (schema v1, docs: studio/README.md, docs/GAME_PIPELINE.md): a
 *    cartridge per game with its quest track (콘셉트 → 에셋 → 빌드 → 테스트·검증 → 미리보기 → 오너 승인 → 출시), each
 *    stage DERIVED from evidence files (exist + mtime) and approvals, never typed by hand.
 *  · Agents come from `~/jobs/<job>/` (BRIEF.md title, account.txt, pid.txt alive via /proc, the last human-readable
 *    run.log line from a 16 KB tail — claude stream-json or codex plain text — and REPORT.md's STATUS line).
 *  · Loot: artifact globs resolved newest first (≤ 12 per game; images, html builds, mp4/webm), served through the
 *    allow-listed read-only file route (studioFileRoots).
 * Read-only; every file is optional; missing records read "기록 없음". Nothing here can run or change anything.
 */
import path from 'node:path';
import type { GameStudio, HubLink, StudioAgent, StudioAgentState, StudioArtifact, StudioArtifactKind, StudioEvent, StudioGame, StudioStage, StudioStageId, StudioStageState } from '../../shared/hub-types';
import { STUDIO_STAGE_IDS } from '../../shared/hub-types';
import { GAME_PIPELINE_PATH, hubFileUrl, type HubFileRootPolicy } from './files';
import { SLOW_CACHE_MS, fmtNum, isObj, scrub, slowCache, str, toIso, type HubDeps, type SlowResult } from './shared';
import { loadGame, statBudget, type Game } from './studios';

/* ───────── constants ───────── */

export const STAGE_LABEL: Record<StudioStageId, string> = { concept: '콘셉트', assets: '에셋', build: '빌드', test: '테스트·검증', preview: '미리보기', approval: '오너 승인', release: '출시' };
/** An agent whose run.log moved this recently counts as working even without a live pid. */
export const AGENT_ACTIVE_MS = 10 * 60_000;
/** A BLOCKED report nobody picked up reads 막힘 this long, then 중단됨. */
export const AGENT_STALE_MS = 3 * 60 * 60_000;
export const LOOT_PER_GAME = 12;
const LOG_TAIL_BYTES = 16 * 1024;
const REPORT_TAIL_BYTES = 16 * 1024;
const LINE_MAX = 140;
const MAX_GAMES = 24;
/**
 * Job dirs read per pass, newest folder mtime first (on top of every job a manifest lists, which is always read). ~/jobs
 * grows by a few folders a day; at 60 the newest ones fell off the end in listing order and never showed as working.
 */
export const MAX_JOBS = 160;
/** Folder names stat'ed to order ~/jobs by mtime (a separate budget, so a big ~/jobs never starves stage evidence). */
const MAX_JOB_LISTING = 400;
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_RE = /\.(mp4|webm)$/i;
const HTML_RE = /\.html?$/i;

/* ───────── file route: what the studio may serve ───────── */

const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm']);
/** Build files (a playable HTML and what it loads) only inside a build/output folder, never a repo's sources. */
const BUILD_EXT = new Set(['.html', '.js', '.css', '.wasm', '.glb', '.gltf', '.ogg', '.mp3', '.wav', '.ico', '.svg', '.woff', '.woff2']);
const BUILD_DIR_RE = /^(dist|build|Build|builds|release|production|deploy|public|out|preview|TemplateData|StreamingAssets|unity-build)$/;
/** Media anywhere below the root; build files only inside a build folder; no dot-segment (.git, .env…), no node_modules. */
export function studioAllow(rel: string, ext: string): boolean {
  const segs = rel.split('/');
  if (segs.some((s) => s.startsWith('.') || s === 'node_modules')) return false;
  if (MEDIA_EXT.has(ext)) return true;
  return BUILD_EXT.has(ext) && segs.slice(0, -1).some((s) => BUILD_DIR_RE.test(s));
}
const STUDIO_ROOT_DIRS = { sgames: 'games', scodex: 'bbai-codex', sjobs: 'jobs' } as const;
/** The read-only roots the studio's thumbnails, videos and playable builds are served from (`/api/hub/file/<root>/…`). */
export function studioFileRoots(home: string): Record<string, HubFileRootPolicy> {
  const out: Record<string, HubFileRootPolicy> = {};
  for (const [name, dir] of Object.entries(STUDIO_ROOT_DIRS)) out[name] = { dir: path.join(home, dir), allow: studioAllow };
  return out;
}
/** An absolute path → its file-route URL, or null when it is outside the studio roots or not servable. */
export function studioFileUrl(home: string, abs: string): string | null {
  for (const [name, dir] of Object.entries(STUDIO_ROOT_DIRS)) {
    const root = path.join(home, dir) + path.sep;
    if (!abs.startsWith(root)) continue;
    const rel = abs.slice(root.length);
    return studioAllow(rel, path.extname(rel).toLowerCase()) ? hubFileUrl(name, rel) : null;
  }
  return null;
}

/* ───────── small helpers ───────── */

const msIso = (ms: number | null): string | null => (ms !== null && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const newest = (...v: (string | null)[]): string | null => v.filter((x): x is string => !!x).sort().reverse()[0] ?? null;
const readOpt = (deps: HubDeps, file: string): Promise<string | null> => deps.readText(file).catch(() => null);
const listOpt = (deps: HubDeps, dir: string): Promise<string[] | null> => deps.listDir(dir).catch(() => null);
const strs = (v: unknown, max = 40): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, max) : []);

/** `~/x` → $HOME/x; a relative path is taken from the repo (the folder holding studio/). `..` is refused (null). */
export function expandPath(p: string, home: string, repoDir: string): string | null {
  if (!p || p.includes('\0')) return null;
  const abs = p.startsWith('~/') ? path.join(home, p.slice(2)) : path.isAbsolute(p) ? p : path.join(repoDir, p);
  if (p.split(/[\\/]/).includes('..')) return null;
  return path.normalize(abs);
}

/** Tokens, keys, JWTs, emails and long secrets out of a free-text line (on top of `scrub`'s home paths). */
const SECRET_TEXT_RES: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie)\b\s*[:=]?\s*["']?[^\s"',;]{6,}/gi, /\b[A-Fa-f0-9]{32,}\b/g, /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
];
export function scrubLine(v: unknown, max = LINE_MAX): string {
  let s = scrub(v, 2000);
  for (const re of SECRET_TEXT_RES) s = s.replace(re, '•••');
  s = s.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `*` / `?` within one path segment. */
const segRe = (seg: string): RegExp => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
const hasGlob = (s: string): boolean => /[*?]/.test(s);

/**
 * Resolve a glob (`*` `?` per segment, `**` = 0–3 folders) to files with their mtimes, newest first, at most `cap`.
 * Bounded: ≤ 40 folder listings and the shared stat budget.
 */
export async function resolveGlob(deps: HubDeps, pattern: string, stat: (f: string) => Promise<number | null>, cap = 40): Promise<{ file: string; ms: number }[]> {
  if (!hasGlob(pattern)) { const ms = await stat(pattern); return ms === null ? [] : [{ file: pattern, ms }]; }
  const segs = pattern.split('/');
  const first = segs.findIndex(hasGlob);
  let bases = [segs.slice(0, first).join('/') || '/'];
  let lists = 0;
  for (let i = first; i < segs.length && bases.length; i++) {
    const seg = segs[i]!; const last = i === segs.length - 1;
    const next: string[] = [];
    if (seg === '**') {
      // 0–3 folders deep: keep the bases, and add every sub-folder down to depth 3.
      let level = bases; next.push(...bases);
      for (let d = 0; d < 3 && level.length; d++) {
        const deeper: string[] = [];
        for (const b of level.slice(0, 10)) { if (++lists > 40) break; for (const n of (await listOpt(deps, b)) ?? []) if (!n.includes('.')) deeper.push(path.join(b, n)); }
        next.push(...deeper); level = deeper;
      }
      bases = next.slice(0, 60); continue;
    }
    const re = hasGlob(seg) ? segRe(seg) : null;
    for (const b of bases.slice(0, 20)) {
      if (!re) { next.push(path.join(b, seg)); continue; }
      if (++lists > 40) break;
      for (const n of (await listOpt(deps, b)) ?? []) if (re.test(n)) next.push(path.join(b, n));
    }
    bases = last ? next.slice(0, 200) : next.slice(0, 40);
  }
  const timed = await Promise.all(bases.map(async (f) => ({ file: f, ms: await stat(f) })));
  return timed.filter((x): x is { file: string; ms: number } => x.ms !== null).sort((a, b) => b.ms - a.ms).slice(0, cap);
}

/* ───────── agents (~/jobs/<job>) ───────── */

/** `b opus` / `a (opus)` / `codex` → account + model. */
export function parseAccount(text: string | null): { account: StudioAgent['account']; model: string | null } {
  const t = (text ?? '').trim().toLowerCase();
  const m = /^(a|b|c|codex)\b\s*\(?([\w.-]+)?\)?/.exec(t);
  if (!m) return { account: 'unknown', model: null };
  return { account: m[1] as StudioAgent['account'], model: m[2] ?? null };
}

/** REPORT.md's last `STATUS:` line → done / blocked (with the reason) / null. */
export function parseReportStatus(text: string | null): { status: 'done' | 'blocked' | null; reason: string | null } {
  const m = statusMatch(text);
  if (!m) return { status: null, reason: null };
  const blocked = m[1]!.toUpperCase() === 'BLOCKED';
  return { status: blocked ? 'blocked' : 'done', reason: blocked ? scrubLine(m[2], 160) || null : null };
}
function statusMatch(text: string | null): RegExpExecArray | null {
  const lines = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    const m = /^\**STATUS\**\s*:\s*\**\s*(DONE|BLOCKED)\b\s*:?\s*(.*)$/i.exec(lines[i]!);
    if (m) return m;
  }
  return null;
}

const OWNER_WORD_RE = /\b(?:owner|approval)\b|승인|오너/i;
const OWNER_NEEDED_RE = /\bneeds?\s+(?:the\s+)?owner\b|\bowner[\s-]+(?:needed|required|decision|approval|action|input)\b|\bapproval\s+(?:needed|required)\b|(?:오너|승인).{0,12}필요|오너\s*(?:결정|판단)/i;
const OWNER_NEGATED_RE = /\b(?:no|not|without)\s+(?:\w+\s+){0,2}(?:owner|approval)\b|\b(?:owner|approval)\b.{0,24}\bnot\b|\bowner\s+approved\b|(?:오너|승인).{0,12}(?:불필요|필요\s*없|없음|아님|않)|승인(?:됨|완료|받음)/i;
const NOTHING_RE = /^(?:none\b|no\b|n\/a\b|없음|해당\s*없음|불필요)/i;

/**
 * Does a BLOCKED report put the decision on the owner? Its STATUS line names the owner or an approval, or a heading or
 * `label:` line says one is needed. Body prose never counts: reports mention "approved assets" and "ownership" freely.
 */
export function reportNeedsOwner(text: string | null): boolean {
  const status = statusMatch(text);
  if (status && OWNER_WORD_RE.test(status[2]!) && !OWNER_NEGATED_RE.test(status[2]!)) return true;
  const lines = (text ?? '').split('\n').map((l) => l.trim());
  return lines.some((l, i) => {
    const heading = /^#{1,6}\s/.test(l);
    const t = l.replace(/^#{1,6}\s+/, '');
    const label = /^[-*\s]*\**([^:：*]{2,40})\**\s*[:：]\**\s*(.*)$/.exec(t);
    const title = label?.[1] ?? (heading ? t : null);
    if (!title || !OWNER_NEEDED_RE.test(title) || OWNER_NEGATED_RE.test(l)) return false;
    const body = (label?.[2] || lines.slice(i + 1).find(Boolean) || '').replace(/^[-*\s]+/, '');
    return !NOTHING_RE.test(body);
  });
}

/** BRIEF.md's first heading (or first line). */
export function parseBriefTitle(text: string | null): string | null {
  if (!text) return null;
  const h = /^#{1,3}\s+(.+)$/m.exec(text)?.[1] ?? text.split('\n').find((l) => l.trim())?.trim() ?? null;
  return h ? scrubLine(h, 120) || null : null;
}

const TOOL_KO: Record<string, string> = { Bash: '명령 실행', Read: '파일 읽기', Write: '파일 작성', Edit: '파일 수정', Grep: '코드 검색', Glob: '파일 찾기', WebFetch: '웹 문서 읽기', WebSearch: '웹 검색', Agent: '하위 에이전트', Task: '하위 에이전트', TodoWrite: '할 일 정리' };
const usefulText = (t: string): string | null => {
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && !/^(```|\|[-: |]+\||---+$)/.test(l));
  const pick = lines.find((l) => !/^\|/.test(l)) ?? lines[0];
  return pick ? scrubLine(pick) || null : null;
};

/**
 * The last human-readable line of a run.log tail. Claude `--output-format stream-json`: the newest assistant text (or
 * the tool it is using, by its description — never the command or a tool's raw output) or the final result. Codex
 * `exec`: the newest message after a `codex` marker. Anything else: the last plain line that is not a table/code fence.
 */
export function lastHumanLine(tail: string | null): string | null {
  if (!tail) return null;
  const lines = tail.split('\n');
  let sawJson = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l.startsWith('{')) continue;
    let j: unknown; try { j = JSON.parse(l); } catch { continue; }
    sawJson = true;
    if (!isObj(j)) continue;
    if (j.type === 'result' && typeof j.result === 'string') { const t = usefulText(j.result); if (t) return t; }
    if (j.type === 'assistant' && isObj(j.message) && Array.isArray(j.message.content)) {
      const blocks = j.message.content.filter(isObj);
      for (let k = blocks.length - 1; k >= 0; k--) {
        const b = blocks[k]!;
        if (b.type === 'text' && typeof b.text === 'string') { const t = usefulText(b.text); if (t) return t; }
        if (b.type === 'tool_use') {
          const name = str(b.name, 40) ?? '도구';
          const desc = isObj(b.input) ? str(b.input.description, 200) ?? (name === 'Read' || name === 'Edit' || name === 'Write' ? (typeof b.input.file_path === 'string' ? path.basename(b.input.file_path) : null) : null) : null;
          return scrubLine(`${TOOL_KO[name] ?? name}${desc ? ` · ${desc}` : ''}`);
        }
      }
    }
  }
  if (sawJson) return null;
  // Codex exec: blocks start with a bare `codex` / `exec` / `thinking` marker line.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== 'codex') continue;
    const body: string[] = [];
    for (let k = i + 1; k < lines.length && body.length < 6; k++) { const l = lines[k]!.trim(); if (/^(exec|codex|thinking|tokens used)$/.test(l)) break; if (l) body.push(l); }
    const t = usefulText(body.join('\n'));
    if (t) return t;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l || /^(EXIT \d+|```|\||#|tokens used|\d[\d,]*$)/.test(l)) continue;
    return scrubLine(l) || null;
  }
  return null;
}

/** An agent and what its status derivation reads: BRIEF + REPORT (never leaves the server) and the owner-needed verdict. */
export interface LoadedJob { agent: StudioAgent; text: string; ownerNeeded: boolean }

export async function loadAgent(deps: HubDeps, jobsDir: string, job: string, stat: (f: string) => Promise<number | null>): Promise<LoadedJob> {
  const dir = path.join(jobsDir, job);
  const [briefText, accountText, pidText, logTail, logMs, reportTail, reportMs] = await Promise.all([
    readOpt(deps, path.join(dir, 'BRIEF.md')), readOpt(deps, path.join(dir, 'account.txt')), readOpt(deps, path.join(dir, 'pid.txt')),
    deps.readTail(path.join(dir, 'run.log'), LOG_TAIL_BYTES).catch(() => null), stat(path.join(dir, 'run.log')),
    deps.readTail(path.join(dir, 'REPORT.md'), REPORT_TAIL_BYTES).catch(() => null), stat(path.join(dir, 'REPORT.md')),
  ]);
  const pid = /^\s*(\d{1,8})\s*$/.exec(pidText ?? '')?.[1] ?? null;
  const alive = pid !== null && (await stat(`/proc/${pid}`)) !== null;
  const { account, model } = parseAccount(accountText);
  const report = parseReportStatus(reportTail);
  // A log still settling right after the final REPORT is a finished job, not one at work.
  const reportClosedLog = report.status !== null && reportMs !== null && logMs !== null && logMs - reportMs < AGENT_ACTIVE_MS;
  const recent = logMs !== null && deps.now() - logMs < AGENT_ACTIVE_MS && !reportClosedLog;
  // A live pid or a moving log is work in progress, whatever an older REPORT says.
  const state: StudioAgentState = alive || recent ? 'working' : report.status === 'blocked' ? 'blocked' : report.status === 'done' ? 'done' : 'idle';
  const agent: StudioAgent = { job, title: parseBriefTitle(briefText), account, model, state, alive, line: lastHumanLine(logTail), lineAt: msIso(logMs), reportAt: msIso(reportMs), reason: report.reason, successor: null, game: null, gameTitle: null };
  return { agent, text: `${briefText ?? ''}\n${reportTail ?? ''}`, ownerNeeded: reportNeedsOwner(reportTail) };
}

/** `name`, `name-cx`, `name-2`, `name-2-cx` are one line of work; a date suffix (`-20261101`) is not a follow-up number. */
const jobFamily = (job: string): string => job.replace(/-cx$/, '').replace(/-\d{1,2}$/, '');
const jobRank = (job: string): number => Number(/-(\d{1,2})(?:-cx)?$/.exec(job)?.[1] ?? 1) * 2 + (job.endsWith('-cx') ? 1 : 0);
const FOLLOW_UP_RE = /follow[\s-]?up|supersed|continu|takes?\s+over|previous|이어|후속|이전/i;
/** Briefs also name jobs to keep away from ("do not touch brawl-web-3", "parallel job"): that is no hand-over. */
const NOT_FOLLOW_UP_RE = /\b(?:do not|don't|never)\b|parallel|(?:other|another) job|건드리지|병렬/i;
const namesAsFollowUp = (text: string, job: string): boolean => {
  const name = new RegExp(`(?<![\\w.-])${job.replace(/[.+^\${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  return text.split('\n').some((l) => name.test(l) && FOLLOW_UP_RE.test(l) && !NOT_FOLLOW_UP_RE.test(l));
};
const lastActive = (a: StudioAgent): string => newest(a.lineAt, a.reportAt) ?? '';

/**
 * What a finished BLOCKED report means now. A newer job of the same game took it over (a higher `name-N` / `-cx`, or
 * its BRIEF/REPORT names it as the previous step) → superseded, even if the old report asked for the owner: the newer
 * job carries any question still open. Otherwise → needs-owner when the report says so, stopped once older than
 * AGENT_STALE_MS, and blocked only while recent.
 */
export function settleBlockedJobs(jobs: LoadedJob[], gameOf: (job: string) => string | undefined, now: number): void {
  for (const { agent: a, ownerNeeded } of jobs) {
    if (a.state !== 'blocked') continue;
    const newer = jobs.filter((o) => o.agent !== a && gameOf(o.agent.job) === gameOf(a.job) && (o.agent.alive || lastActive(o.agent) > lastActive(a)));
    const next = newer.filter((o) => jobFamily(o.agent.job) === jobFamily(a.job) && jobRank(o.agent.job) > jobRank(a.job)).sort((x, y) => jobRank(x.agent.job) - jobRank(y.agent.job))[0]
      ?? newer.filter((o) => namesAsFollowUp(o.text, a.job)).sort((x, y) => lastActive(x.agent).localeCompare(lastActive(y.agent)))[0];
    if (next) { a.state = 'superseded'; a.successor = next.agent.job; } else if (ownerNeeded) a.state = 'needs-owner';
    else if (!(now - Date.parse(lastActive(a)) < AGENT_STALE_MS)) a.state = 'stopped';
  }
}

/* ───────── manifests ───────── */

interface Manifest {
  id: string; title: string; titleKo: string | null; genre: string | null; engine: string | null; status: StudioGame['status']; reference: string | null; cover: string | null;
  repos: { label: string; path: string | null; branch: string | null; remote: string | null; readonly: boolean }[];
  stages: { id: StudioStageId; evidence: string[] }[]; artifacts: Record<'screenshots' | 'concept' | 'builds' | 'video', string[]>;
  tests: { label: string; path: string }[]; preview: HubLink[]; jobs: string[];
  approvals: { what: string; state: 'pending' | 'approved' | 'rejected'; at: string | null }[]; nextAction: { text: string; owner: boolean } | null;
}
const STATUSES = new Set(['live', 'candidate', 'building', 'concept', 'paused']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOB_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** A manifest file's JSON → the fields the studio uses; null when it is not a usable v1 manifest. */
export function parseManifest(text: string | null): Manifest | null {
  if (!text) return null;
  let j: unknown; try { j = JSON.parse(text); } catch { return null; }
  if (!isObj(j)) return null;
  const id = str(j.id, 64); const title = str(j.title, 80);
  if (!id || !SLUG_RE.test(id) || !title) return null;
  const stageIn = Array.isArray(j.stages) ? j.stages.filter(isObj) : [];
  const stages = STUDIO_STAGE_IDS.map((sid) => ({ id: sid, evidence: strs(stageIn.find((s) => s.id === sid)?.evidence, 20) }));
  const art = isObj(j.artifacts) ? j.artifacts : {};
  const status = str(j.status, 20);
  const next = isObj(j.nextAction) ? j.nextAction : null;
  return {
    id, title: scrubLine(title, 80), titleKo: str(j.titleKo, 80), genre: str(j.genre, 60), engine: str(j.engine, 60), status: status && STATUSES.has(status) ? status as StudioGame['status'] : 'unknown',
    reference: str(j.reference, 64), cover: str(j.cover, 400),
    repos: (Array.isArray(j.repos) ? j.repos.filter(isObj) : []).slice(0, 8).map((r) => ({ label: scrubLine(r.label, 40) || '저장소', path: str(r.path, 400), branch: str(r.branch, 120), remote: str(r.remote, 160), readonly: r.readonly === true })),
    stages, artifacts: { screenshots: strs(art.screenshots), concept: strs(art.concept), builds: strs(art.builds), video: strs(art.video) },
    tests: (Array.isArray(j.tests) ? j.tests.filter(isObj) : []).slice(0, 10).map((t) => ({ label: scrubLine(t.label, 60) || '테스트', path: str(t.path, 400) ?? '' })).filter((t) => t.path),
    preview: (Array.isArray(j.preview) ? j.preview.filter(isObj) : []).slice(0, 6).map((p) => ({ label: scrubLine(p.label, 40) || '미리보기', href: str(p.url, 400) ?? '' })).filter((p) => /^https?:\/\//.test(p.href)),
    jobs: strs(j.jobs, 20).filter((x) => JOB_RE.test(x)),
    approvals: (Array.isArray(j.approvals) ? j.approvals.filter(isObj) : []).slice(0, 10).map((a) => ({ what: scrubLine(a.what, 120), state: (a.state === 'approved' || a.state === 'rejected' ? a.state : 'pending') as 'pending' | 'approved' | 'rejected', at: toIso(a.at) })).filter((a) => a.what),
    nextAction: next && typeof next.text === 'string' ? { text: scrubLine(next.text, 120), owner: next.owner === true } : null,
  };
}

/**
 * The quest track: each stage done when every evidence item exists (approval: when every approval is approved);
 * the first not-done stage is active, or blocked when the game's newest agent reported BLOCKED (or an approval was
 * rejected). Stages with no evidence listed stay todo.
 */
export function deriveStages(found: { id: StudioStageId; found: number; total: number; at: string | null }[], approvals: Manifest['approvals'], blocked: string | null): StudioStage[] {
  let activeSet = false;
  // A game already out (release evidence present) with no approvals listed went out before approvals were recorded:
  // its approval stage counts as passed rather than reading 진행 중 forever.
  const release = found.find((f) => f.id === 'release');
  const releasedUnrecorded = !approvals.length && !!release && release.total > 0 && release.found === release.total;
  return found.map((f) => {
    let state: StudioStageState;
    let note: string | undefined;
    if (f.id === 'approval' && releasedUnrecorded) { state = 'done'; note = '출시됨 · 승인 기록 없음'; } else if (f.id === 'approval' && approvals.length) {
      const rejected = approvals.find((a) => a.state === 'rejected');
      const pending = approvals.filter((a) => a.state === 'pending');
      state = rejected ? 'blocked' : pending.length ? 'todo' : 'done';
      note = rejected ? `반려: ${rejected.what}` : pending.length ? `대기: ${pending[0]!.what}` : '승인됨';
    } else state = f.total > 0 && f.found === f.total ? 'done' : 'todo';
    if (state !== 'done' && !activeSet) {
      activeSet = true;
      if (state !== 'blocked') state = blocked ? 'blocked' : 'active';
      if (blocked && !note) note = blocked;
    }
    if (f.total > 0 && f.found < f.total && f.found > 0 && !note) note = `증거 ${f.found}/${f.total}`;
    return { id: f.id, label: STAGE_LABEL[f.id], state, found: f.found, total: f.total, at: f.at, ...(note ? { note } : {}) };
  });
}

const kindOf = (file: string): StudioArtifactKind | null => (IMAGE_RE.test(file) ? 'image' : VIDEO_RE.test(file) ? 'video' : HTML_RE.test(file) ? 'html' : null);
const jobOf = (home: string, file: string): string | null => { const root = path.join(home, 'jobs') + path.sep; return file.startsWith(root) ? file.slice(root.length).split(path.sep)[0] ?? null : null; };

interface Ctx { deps: HubDeps; home: string; repoDir: string; stat: (f: string) => Promise<number | null>; oldGames: Map<string, Game> }

async function loadStudioGame(ctx: Ctx, m: Manifest, agentsByJob: Map<string, StudioAgent>): Promise<StudioGame & { _events: StudioEvent[] }> {
  const { deps, home, repoDir, stat } = ctx;
  const ex = (p: string): string | null => expandPath(p, home, repoDir);
  const events: StudioEvent[] = [];
  // Stage evidence: every item (file or glob) found or not, newest mtime.
  const found = await Promise.all(m.stages.map(async (s) => {
    const hits = await Promise.all(s.evidence.map(async (e) => { const abs = ex(e); return abs ? resolveGlob(deps, abs, stat, 3) : []; }));
    const at = msIso(Math.max(0, ...hits.flat().map((h) => h.ms)) || null);
    return { id: s.id, found: hits.filter((h) => h.length > 0).length, total: s.evidence.length, at };
  }));
  // Artifacts: newest first across all groups, ≤ LOOT_PER_GAME; only what the file route will serve.
  const groups = (['screenshots', 'concept', 'video', 'builds'] as const);
  const resolved = await Promise.all(groups.map(async (g) => (await Promise.all(m.artifacts[g].map(async (p) => { const abs = ex(p); return abs ? resolveGlob(deps, abs, stat, LOOT_PER_GAME) : []; }))).flat().map((h) => ({ ...h, group: g }))));
  const seen = new Set<string>();
  const artifacts: StudioArtifact[] = [];
  for (const h of resolved.flat().sort((a, b) => b.ms - a.ms)) {
    if (seen.has(h.file)) continue; seen.add(h.file);
    const kind = kindOf(h.file); const src = studioFileUrl(home, h.file);
    if (!kind || !src) continue;
    artifacts.push({ src, kind, group: h.group, name: path.basename(h.file), at: msIso(h.ms), game: m.id, gameTitle: m.title, job: jobOf(home, h.file) });
  }
  const builds = artifacts.filter((a) => a.kind === 'html');
  const loot = artifacts.filter((a) => a.kind !== 'html').slice(0, LOOT_PER_GAME);
  // Cover: the manifest's cover, else the newest screenshot / concept image.
  let cover: StudioArtifact | null = null;
  const coverAbs = m.cover ? ex(m.cover) : null;
  if (coverAbs && kindOf(coverAbs) === 'image') { const ms = await deps.fileMtime(coverAbs).catch(() => null); /* outside the stat budget: an explicit cover must never lose to a busy studio (≤ MAX_GAMES calls) */ const src = studioFileUrl(home, coverAbs); if (ms !== null && src) cover = { src, kind: 'image', group: 'cover', name: path.basename(coverAbs), at: msIso(ms), game: m.id, gameTitle: m.title, job: jobOf(home, coverAbs) }; }
  cover ??= loot.find((a) => a.kind === 'image' && a.group === 'screenshots') ?? loot.find((a) => a.kind === 'image') ?? null;
  // Agents linked to this game; the newest one decides whether the active stage is blocked.
  const agents = m.jobs.map((j) => agentsByJob.get(j)).filter((a): a is StudioAgent => !!a);
  for (const a of agents) { a.game = m.id; a.gameTitle = m.title; }
  const newestAgent = agents.slice().sort((a, b) => (newest(b.lineAt, b.reportAt) ?? '').localeCompare(newest(a.lineAt, a.reportAt) ?? ''))[0] ?? null;
  // Only a recent, unanswered BLOCKED holds the track up; superseded and stopped jobs are history, needs-owner is the next move.
  const blocked = newestAgent && newestAgent.state === 'blocked' ? `${newestAgent.job} 막힘${newestAgent.reason ? `: ${newestAgent.reason}` : ''}` : null;
  const stages = deriveStages(found, m.approvals, blocked);
  // Facts from the existing ~/games collector (version, verification, deploy URL, tests) when a repo is under ~/games.
  const gamesRoot = path.join(home, 'games') + path.sep;
  const slug = m.repos.map((r) => (r.path ? ex(r.path) : null)).find((p): p is string => !!p && p.startsWith(gamesRoot) && !p.slice(gamesRoot.length).includes(path.sep))?.slice(gamesRoot.length) ?? null;
  const old = slug ? ctx.oldGames.get(slug) ?? null : null;
  const facts = old && old.kind === 'game' ? { verifiedAt: old.verifiedAt, deployUrl: old.deployUrl, tests: old.tests ? `${old.tests.passed}${old.tests.total !== null ? `/${old.tests.total}` : ''} PASS` : null } : null;
  const oldPlay = old?.builds.find((b) => b.rel.startsWith('dist/') && HTML_RE.test(b.rel)) ?? null;
  const playUrl = builds[0]?.src ?? (oldPlay && slug ? studioFileUrl(home, path.join(gamesRoot, slug, oldPlay.rel)) : null);
  const tests = await Promise.all(m.tests.map(async (t) => { const abs = ex(t.path); const hits = abs ? await resolveGlob(deps, abs, stat, 1) : []; return { label: t.label, at: msIso(hits[0]?.ms ?? null), found: hits.length > 0 }; }));
  const previews = [...m.preview];
  if (facts?.deployUrl && !previews.some((p) => p.href.replace(/\/$/, '') === facts.deployUrl!.replace(/\/$/, ''))) previews.push({ label: '공개 사이트', href: facts.deployUrl });

  // Feed: stage evidence, loot batches, approvals.
  for (const s of stages) if (s.at && s.state === 'done') events.push({ at: s.at, game: m.id, job: null, kind: 'stage', text: `${m.title} · ${s.label} 단계 기록 갱신`, level: 'ok' });
  const batches = new Map<string, { n: number; at: string; job: string | null; kind: string }>();
  for (const a of [...loot, ...builds]) { if (!a.at) continue; const key = `${a.job ?? ''}|${a.group}|${a.at.slice(0, 13)}`; const b = batches.get(key); if (b) { b.n++; if (a.at > b.at) b.at = a.at; } else batches.set(key, { n: 1, at: a.at, job: a.job, kind: a.group }); }
  const GROUP_KO: Record<string, string> = { screenshots: '스크린샷', concept: '콘셉트 아트', video: '영상', builds: '빌드' };
  for (const b of batches.values()) events.push({ at: b.at, game: m.id, job: b.job, kind: 'loot', text: `${m.title} · ${GROUP_KO[b.kind] ?? b.kind} ${b.n}개 획득${b.job ? ` (${b.job})` : ''}`, level: 'info' });
  for (const a of m.approvals) if (a.at) events.push({ at: a.at, game: m.id, job: null, kind: 'approval', text: `${m.title} · ${a.what} — ${a.state === 'approved' ? '오너 승인' : a.state === 'rejected' ? '오너 반려' : '승인 대기'}`, level: a.state === 'approved' ? 'ok' : 'warn' });
  const lastAt = newest(...stages.map((s) => s.at), artifacts[0]?.at ?? null, ...agents.map((a) => a.lineAt));
  // Next action: an agent asking the owner first, then the manifest's, else derived from the track. It is the owner's
  // only when an agent asks, or the track has reached a pending approval the manifest does not put off (owner: false).
  const pendingApproval = m.approvals.find((a) => a.state === 'pending');
  const active = stages.find((s) => s.state === 'active' || s.state === 'blocked');
  const asking = agents.find((a) => a.state === 'needs-owner');
  const approvalCall = active?.id === 'approval' && !!pendingApproval && m.nextAction?.owner !== false;
  const nextAction = asking ? { text: scrubLine(`${asking.job}: ${asking.reason ?? '오너 승인 필요'}`, 120), owner: true }
    : m.nextAction ? { text: m.nextAction.text, owner: approvalCall }
    : approvalCall ? { text: `${pendingApproval!.what} — 오너 결정`, owner: true }
    : active ? { text: active.state === 'blocked' ? `${active.label}: ${active.note ?? '막힘'}` : `${active.label} 단계 진행`, owner: false } : null;
  return {
    id: m.id, title: m.title, titleKo: m.titleKo, genre: m.genre, engine: m.engine, status: m.status, reference: m.reference, referenceTitle: null,
    version: old?.version ?? null, cover, stages, nextAction, approvals: m.approvals,
    play: playUrl ? { label: '플레이', href: playUrl } : null, previews,
    repos: m.repos.map((r) => ({ label: r.label, branch: r.branch ? scrubLine(r.branch, 80) : null, remote: r.remote ? scrubLine(r.remote, 120) : null, readonly: r.readonly })),
    tests, jobs: m.jobs, artifacts: loot, lastAt, facts, _events: events,
  };
}

/* ───────── the collector ───────── */

/**
 * Which ~/jobs folders to read: every job a manifest lists and its follow-ups (`name-2`, `name-cx`) when the folder
 * exists, then the rest newest folder mtime first (unknown mtimes last, in listing order) up to MAX_JOBS in total.
 * Output order: newest first.
 */
export async function pickJobs(deps: HubDeps, jobsDir: string, jobNames: string[] | null, manifests: { jobs: string[] }[]): Promise<string[]> {
  const names = [...new Set((jobNames ?? []).filter((j) => JOB_RE.test(j)))];
  const dirStat = statBudget(deps, MAX_JOB_LISTING);
  const timed = await Promise.all(names.map(async (job, i) => ({ job, i, ms: await dirStat(path.join(jobsDir, job)) })));
  timed.sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity) || a.i - b.i);
  const families = new Set(manifests.flatMap((m) => m.jobs.map(jobFamily)));
  const keep = new Set(timed.filter((t) => families.has(jobFamily(t.job))).map((t) => t.job));
  const cap = Math.max(MAX_JOBS, keep.size);
  for (const t of timed) { if (keep.size >= cap) break; keep.add(t.job); }
  return timed.filter((t) => keep.has(t.job)).map((t) => t.job);
}


export interface GameStudioOpts { /** The folder holding `games/*.json` (the repo's studio/). */ studioDir: string }

export async function collectGameStudio(deps: HubDeps, opts: GameStudioOpts): Promise<GameStudio> {
  const home = deps.home;
  const repoDir = path.dirname(opts.studioDir);
  const stat = statBudget(deps, 600);
  const gamesDir = path.join(opts.studioDir, 'games');
  const jobsDir = path.join(home, 'jobs');
  const [names, jobNames, docMs, templateMs] = await Promise.all([listOpt(deps, gamesDir), listOpt(deps, jobsDir), stat(path.join(repoDir, 'docs', 'GAME_PIPELINE.md')), stat(path.join(repoDir, 'templates', 'game'))]);
  const files = (names ?? []).filter((n) => /\.json$/i.test(n)).slice(0, MAX_GAMES);
  const manifests = (await Promise.all(files.map(async (f) => parseManifest(await readOpt(deps, path.join(gamesDir, f)))))).filter((m): m is Manifest => !!m);
  // Agents: every job dir (bounded); linked ones show their task, the rest only as names.
  const jobs = await pickJobs(deps, jobsDir, jobNames, manifests);
  // A follow-up (`name-2`, `name-cx`) belongs to the game of the job it continues, listed yet or not.
  for (const m of manifests) { const families = new Set(m.jobs.map(jobFamily)); m.jobs.push(...jobs.filter((j) => families.has(jobFamily(j)) && !m.jobs.includes(j))); }
  const linked = new Set(manifests.flatMap((m) => m.jobs));
  const loadedJobs = await Promise.all(jobs.filter((j) => linked.has(j)).map((j) => loadAgent(deps, jobsDir, j, stat)));
  settleBlockedJobs(loadedJobs, (job) => manifests.find((m) => m.jobs.includes(job))?.id, deps.now());
  const agentList = loadedJobs.map((j) => j.agent);
  const agentsByJob = new Map(agentList.map((a) => [a.job, a]));
  const otherJobs = jobs.filter((j) => !linked.has(j));
  // Their own /proc budget: a long ~/jobs list must not eat the stage-evidence stats below.
  const procStat = statBudget(deps, MAX_JOBS);
  const otherAlive = await Promise.all(otherJobs.map(async (j) => { const pid = /^\s*(\d{1,8})\s*$/.exec((await readOpt(deps, path.join(jobsDir, j, 'pid.txt'))) ?? '')?.[1]; return pid ? (await procStat(`/proc/${pid}`)) !== null : false; }));
  // The ~/games facts (version, verification, deploy, tests) for manifests whose repo is a ~/games/<slug> folder.
  const gamesRoot = path.join(home, 'games');
  const slugs = new Set<string>();
  for (const m of manifests) for (const r of m.repos) { const p = r.path ? expandPath(r.path, home, repoDir) : null; if (p && path.dirname(p) === gamesRoot) slugs.add(path.basename(p)); }
  const oldGames = new Map<string, Game>();
  const oldStat = statBudget(deps, 200);
  await Promise.all([...slugs].slice(0, 6).map(async (s) => { try { oldGames.set(s, await loadGame(deps, gamesRoot, s, oldStat)); } catch { /* optional */ } }));
  const ctx: Ctx = { deps, home, repoDir, stat, oldGames };
  const loaded = await Promise.all(manifests.map((m) => loadStudioGame(ctx, m, agentsByJob)));
  for (const g of loaded) g.referenceTitle = g.reference ? loaded.find((x) => x.id === g.reference)?.title ?? g.reference : null;
  const STATUS_RANK: Record<StudioGame['status'], number> = { candidate: 0, building: 1, live: 2, concept: 3, paused: 4, unknown: 5 };
  const games: StudioGame[] = loaded.map(({ _events, ...g }) => g).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));

  const agents = agentList.slice().sort((a, b) => { const r: Record<StudioAgentState, number> = { working: 0, 'needs-owner': 1, blocked: 2, idle: 3, stopped: 4, superseded: 5, done: 6 }; return r[a.state] - r[b.state] || Number(b.alive) - Number(a.alive) || (newest(b.lineAt, b.reportAt) ?? '').localeCompare(newest(a.lineAt, a.reportAt) ?? ''); });
  // Loot: round-robin over the games (each newest first), so one busy game does not fill the whole gallery.
  const loot: StudioArtifact[] = [];
  for (let i = 0; loot.length < 36 && games.some((g) => g.artifacts.length > i); i++) for (const g of games) { const a = g.artifacts[i]; if (a && loot.length < 36) loot.push(a); }
  const feed: StudioEvent[] = loaded.flatMap((g) => g._events);
  const because = (a: StudioAgent): string => (a.reason ? `: ${a.reason}` : '');
  const REPORT_FEED: Partial<Record<StudioAgentState, (a: StudioAgent) => string>> = {
    'needs-owner': (a) => `승인 필요${because(a)}`, blocked: (a) => `막힘 보고${because(a)}`, stopped: (a) => `중단됨${because(a)}`, superseded: (a) => `이어받음 → ${a.successor}`, done: () => '완료 보고',
  };
  const who = (a: StudioAgent): string => (a.account === 'codex' ? 'Codex' : a.account === 'unknown' ? '에이전트' : `Claude ${a.account}`);
  for (const a of agents) {
    if (a.lineAt) feed.push({ at: a.lineAt, game: a.game, job: a.job, kind: 'agent', text: `${who(a)} · ${a.job}${a.state === 'working' ? ' 작업 중' : ' 마지막 작업'}${a.line ? ` — ${a.line}` : ''}`, level: a.state === 'working' ? 'info' : undefined });
    if (a.reportAt && a.state !== 'working') feed.push({ at: a.reportAt, game: a.game, job: a.job, kind: 'report', text: `${who(a)} · ${a.job} ${REPORT_FEED[a.state]?.(a) ?? '보고서 갱신'}`, level: a.state === 'needs-owner' ? 'bad' : a.state === 'blocked' ? 'warn' : a.state === 'done' ? 'ok' : 'info' });
  }
  feed.sort((a, b) => b.at.localeCompare(a.at));
  const summary = {
    working: agents.filter((a) => a.state === 'working').length,
    owner: games.filter((g) => g.nextAction?.owner).length,
    released: games.filter((g) => g.status === 'live' || g.stages.find((s) => s.id === 'release')?.state === 'done').length,
    blocked: games.filter((g) => g.stages.some((s) => s.state === 'blocked')).length,
    games: games.length,
  };
  return {
    games, agents, others: { count: otherJobs.length, working: otherAlive.filter(Boolean).length, names: otherJobs.slice(0, 40) }, loot, feed: feed.slice(0, 40), summary,
    pipeline: { doc: docMs !== null ? GAME_PIPELINE_PATH : null, template: templateMs !== null, manifests: manifests.length },
    generatedAt: new Date(deps.now()).toISOString(), ...(names === null ? { error: '매니페스트 폴더 없음 (studio/games)' } : manifests.length === 0 ? { error: `읽을 수 있는 매니페스트 없음 (${fmtNum(files.length, 0)}개 파일)` } : {}),
  };
}

/* ───────── cache ───────── */

const caches = new WeakMap<HubDeps, () => Promise<SlowResult<GameStudio>>>();
/** The studio from a 60 s cache (SLOW_CACHE_MS.studio), like the other studios. Never throws: null when it cannot load. */
export async function collectGameStudioCached(deps: HubDeps, opts: GameStudioOpts): Promise<GameStudio | null> {
  let c = caches.get(deps);
  if (!c) { c = slowCache(SLOW_CACHE_MS.studio, () => collectGameStudio(deps, opts), deps.now); caches.set(deps, c); }
  try { return (await c()).value; } catch { return null; }
}
