import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { GEMINI_ACCOUNTS, geminiEnv, geminiSeatHome, type GeminiAccount } from '../../shared/accounts';
import { parseIsoUtc, type GeminiBucket, type GeminiUsage } from '../../shared/usage-types';
import type { SpawnFn } from '../engine/CodexEngine';
import { GEMINI_LOGIN_HINT, type GeminiLogin } from '../engine/GeminiEngine';
import { ensureGeminiSeatHome } from '../engine/geminiHome';
import type { UsageService } from './UsageService';

/**
 * agy's print-mode `/usage` command: with `--output-format json` (agy 1.4.2, fixtures/agy-1.4.2/usage.json) the quota
 * summary is `command.data.groups[] → buckets[]`, each `{ id, name, window: 'weekly' | '5h', remaining_fraction: 0–1,
 * reset_time }`, plus the same as tab-separated text in `response`. Bucket names repeat across groups, so a bucket is
 * named "<group> · <window>". `--disable-slash-commands` must NOT be passed here — it would turn `/usage` into a prompt.
 */
export const GEMINI_USAGE_ARGS = ['-p=/usage', '--output-format', 'json'] as const;

const STDOUT_MAX = 1_048_576;
const NAME_KEYS = ['display_name', 'displayName', 'name', 'label', 'title', 'model_name', 'modelName', 'model', 'bucket_name', 'bucketName', 'bucket', 'key', 'id'];
const USED_KEYS = ['used_percentage', 'usedPercentage', 'used_percent', 'usedPercent', 'used_pct', 'usage_percentage'];
const REMAINING_FRACTION_KEYS = ['remaining_fraction', 'remainingFraction'];
const REMAINING_KEYS = ['remaining_percentage', 'remainingPercentage', 'remaining_percent', 'remainingPercent', 'remaining_pct'];
const RESET_AT_KEYS = ['reset_time', 'resetTime', 'resets_at', 'resetsAt', 'reset_at', 'resetAt', 'reset', 'reset_time_local', 'resetTimeLocal'];
const RESET_IN_KEYS = ['reset_in_seconds', 'resetInSeconds', 'seconds_until_reset', 'secondsUntilReset', 'reset_in', 'resetIn', 'resets_in', 'resetsIn'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);
const first = (o: Obj, keys: readonly string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

/** The `Claude and GPT models` group: agy's own Claude/GPT seats, which deck never uses → not shown. */
const THIRD_PARTY_GROUP_RE = /\b(claude|gpt)\b/i;
/** "Gemini Models" → "Gemini", "Gemini 4 Argon" → "Argon". */
const groupLabel = (g: string) => g.trim().replace(/\s+models?$/i, '').replace(/^gemini\s+\d+(?:\.\d+)?\s+/i, '').trim() || g.trim();
/** agy windows (`weekly`, `5h`) or, in the text report, the bucket name ("Weekly Limit Remaining", "Five Hour Limit Remaining"). */
function windowLabel(w: string): string {
  if (/week/i.test(w)) return '주간';
  if (/^5\s*h$|five\s*hour/i.test(w)) return '5h';
  if (/day|daily/i.test(w)) return '일간';
  return w.trim();
}

/** "2h 10m", "in 45m", "1d 3h", "90s" → ms; null when it is not a duration. */
export function parseDuration(s: string): number | null {
  const m = s.trim().toLowerCase().replace(/^(in|after)\s+/, '').match(/^(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?$/);
  if (!m || m.slice(1).every((x) => x === undefined)) return null;
  const [d, h, mi, se] = m.slice(1).map((x) => Number(x ?? 0));
  return (((d! * 24 + h!) * 60 + mi!) * 60 + se!) * 1000;
}

/** An ISO/RFC3339 string, epoch seconds/ms, a relative duration → ISO; null when unreadable. */
export function toResetIso(v: unknown, nowMs: number): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  if (/^\d{9,13}$/.test(s)) return toResetIso(Number(s), nowMs);
  const dur = parseDuration(s);
  if (dur !== null) return new Date(nowMs + dur).toISOString();
  const t = /^\d{4}-\d{2}-\d{2}/.test(s) ? parseIsoUtc(s) : Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function bucketOf(o: Obj, inheritedName: string | null, nowMs: number): GeminiBucket | null {
  let usedPct: number | null = null;
  const used = num(first(o, USED_KEYS));
  const fraction = num(first(o, REMAINING_FRACTION_KEYS));
  const remaining = num(first(o, REMAINING_KEYS));
  if (used !== null) usedPct = used;
  else if (fraction !== null) usedPct = (1 - fraction) * 100;
  else if (remaining !== null) usedPct = 100 - remaining;
  else {
    // `used`/`remaining` + `limit` counts (tokens, requests): a percentage of the limit.
    const limit = num(first(o, ['limit', 'quota', 'max', 'total']));
    const u = num(o.used), r = num(o.remaining);
    if (limit !== null && limit > 0) usedPct = u !== null ? (u / limit) * 100 : r !== null ? 100 - (r / limit) * 100 : null;
  }
  if (usedPct === null) return null;
  const own = first(o, NAME_KEYS);
  const ownName = typeof own === 'string' && own.trim() ? own.trim() : null;
  // A bucket with a window inside a group: names repeat across groups, so "<group> · <window>".
  const win = typeof o.window === 'string' && o.window.trim() ? o.window : null;
  const name = win && inheritedName ? `${groupLabel(inheritedName)} · ${windowLabel(win)}` : ownName ?? inheritedName ?? '한도';
  let resetsAt = toResetIso(first(o, RESET_AT_KEYS), nowMs);
  if (!resetsAt) {
    const sec = num(first(o, RESET_IN_KEYS));
    if (sec !== null && sec > 0) resetsAt = new Date(nowMs + sec * 1000).toISOString();
  }
  return { name, usedPct: clampPct(usedPct), resetsAt };
}

function walk(node: unknown, inheritedName: string | null, nowMs: number, out: GeminiBucket[]): void {
  if (Array.isArray(node)) { for (const x of node) walk(x, inheritedName, nowMs, out); return; }
  if (!isObj(node)) return;
  const b = bucketOf(node, inheritedName, nowMs);
  if (b) out.push(b);
  const own = first(node, NAME_KEYS);
  const name = typeof own === 'string' && own.trim() ? own.trim() : inheritedName;
  if (Array.isArray(node.buckets) && name && THIRD_PARTY_GROUP_RE.test(name)) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'usage' && isObj(v) && 'input_tokens' in v) continue; // the turn's token usage, not quota
    if (isObj(v) || Array.isArray(v)) walk(v, name, nowMs, out);
  }
}

/**
 * The text report. agy 1.4.2 (`response` of `/usage`): tab-separated `<group>\t<bucket name>\t<remaining>%\t<ISO>`.
 * Older guesses: "Gemini 4 Argon: 73% remaining (resets in 2h 10m)" / "Flash · 12% used · resets at 2026-10-14T09:00Z".
 */
export function parseUsageText(text: string, nowMs: number): GeminiBucket[] {
  const out: GeminiBucket[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length >= 3) {
      const [group, bucket, pctCol, reset] = cols as [string, string, string, string | undefined];
      const pct = pctCol.match(/^(\d{1,3}(?:\.\d+)?)\s*%$/);
      if (!pct || !group || !bucket) continue;
      if (THIRD_PARTY_GROUP_RE.test(group)) continue;
      out.push({ name: `${groupLabel(group)} · ${windowLabel(bucket)}`, usedPct: clampPct(100 - Number(pct[1])), resetsAt: reset ? toResetIso(reset, nowMs) : null });
      continue;
    }
    const m = line.match(/^[-*•]?\s*([^:|·—–]+?)\s*[:|·—–]\s*(\d{1,3}(?:\.\d+)?)\s*%\s*(remaining|left|used|소진|남음|사용)?/i);
    if (!m) continue;
    const pct = Number(m[2]);
    const kind = (m[3] ?? '').toLowerCase();
    const usedPct = kind === 'used' || kind === '사용' ? pct : 100 - pct;
    const r = line.match(/resets?\s+(?:in|at)\s+([^()\n]+?)\s*\)?\s*$/i) ?? line.match(/리셋\s*[:：]?\s*([^()\n]+)$/);
    out.push({ name: m[1]!.trim(), usedPct: clampPct(usedPct), resetsAt: r ? toResetIso(r[1]!.trim(), nowMs) : null });
  }
  return out;
}

/** Every bucket agy's `/usage` output names, first occurrence per name; [] when nothing in it reads as a quota. */
export function parseGeminiUsage(stdout: string, nowMs: number): GeminiBucket[] {
  const found: GeminiBucket[] = [];
  const objects: unknown[] = [];
  const whole = stdout.trim();
  if (whole.startsWith('{') || whole.startsWith('[')) { try { objects.push(JSON.parse(whole)); } catch { /* line by line below */ } }
  if (!objects.length) for (const line of stdout.split(/\r?\n/)) { const t = line.trim(); if (t.startsWith('{') || t.startsWith('[')) { try { objects.push(JSON.parse(t)); } catch { /* not json */ } } }
  for (const o of objects) walk(o, null, nowMs, found);
  if (!found.length) {
    for (const o of objects) if (isObj(o) && typeof o.response === 'string') found.push(...parseUsageText(o.response, nowMs));
  }
  if (!found.length) found.push(...parseUsageText(stdout, nowMs));
  const seen = new Set<string>();
  return found.filter((b) => (seen.has(b.name) ? false : (seen.add(b.name), true)));
}

/**
 * Each Gemini seat's numbers: `agy -p=/usage --output-format json` on start, every `intervalMs` (5 min) and shortly
 * after a Gemini turn (`bump`), with that seat's HOME. A seat is skipped while its `agy models` probe says logged out
 * — unauthenticated print mode blocks ~60 s waiting for a browser login, which must never happen from deck.
 * Reads quota only; never credentials.
 */
export class GeminiUsagePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bumpTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private readonly last = new Map<GeminiAccount, GeminiUsage>();
  private loggedParseFailure = false;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly realHome: string;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: {
    bin: string;
    usage: Pick<UsageService, 'applyGemini'>;
    login: Pick<GeminiLogin, 'get' | 'refresh'>;
    intervalMs?: number;
    timeoutMs?: number;
    spawnFn?: SpawnFn;
    now?: () => number;
    baseEnv?: NodeJS.ProcessEnv;
    realHome?: string;
    log?: (line: string) => void;
  }) {
    this.intervalMs = opts.intervalMs ?? 300_000;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.spawnFn = opts.spawnFn ?? ((b, args, o) => nodeSpawn(b, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] }));
    this.now = opts.now ?? Date.now;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.realHome = opts.realHome ?? this.baseEnv.HOME ?? os.homedir();
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /** g1's last reading (tests, status). */
  current(): GeminiUsage | null {
    return this.last.get('g1') ?? null;
  }

  private publish(account: GeminiAccount, u: GeminiUsage): void {
    this.last.set(account, u);
    this.opts.usage.applyGemini(account, u);
  }

  /** One `/usage` read; concurrent calls share it. */
  pollOnce(): Promise<void> {
    if (!this.running) this.running = this.poll().finally(() => { this.running = null; });
    return this.running;
  }

  private async poll(): Promise<void> {
    if (GEMINI_ACCOUNTS.some((a) => !this.opts.login.get(a))) await this.opts.login.refresh();
    for (const account of GEMINI_ACCOUNTS) {
      if (!this.opts.login.get(account)) {
        const prev = this.last.get(account);
        this.publish(account, { status: 'down', fetchedAt: prev?.fetchedAt ?? null, loggedIn: false, buckets: [], error: GEMINI_LOGIN_HINT });
        continue;
      }
      const run = await this.runUsage(account);
      const nowMs = this.now();
      const buckets = run.ok ? parseGeminiUsage(run.stdout, nowMs) : [];
      if (buckets.length) {
        this.publish(account, { status: 'ok', fetchedAt: new Date(nowMs).toISOString(), loggedIn: true, buckets, error: null });
        continue;
      }
      const why = run.ok ? '사용량 응답을 해석하지 못했습니다' : run.error;
      if (run.ok && !this.loggedParseFailure) {
        this.loggedParseFailure = true;
        this.log(`deck: agy /usage 응답을 해석하지 못했습니다 — 앞부분: ${run.stdout.replace(/\s+/g, ' ').slice(0, 600)}`);
      }
      const prev = this.last.get(account);
      if (prev?.buckets.length) this.publish(account, { ...prev, status: 'stale', loggedIn: true, error: why });
      else this.publish(account, { status: 'down', fetchedAt: null, loggedIn: true, buckets: [], error: why });
    }
  }

  private runUsage(account: GeminiAccount): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    if (account === 'g2') {
      const ensured = ensureGeminiSeatHome('g2', this.realHome);
      if (!ensured.ok) return Promise.resolve({ ok: false, error: ensured.error });
    }
    const home = geminiSeatHome(account, this.realHome);
    return new Promise((resolve) => {
      let child: ReturnType<SpawnFn>;
      try {
        child = this.spawnFn(this.opts.bin, [...GEMINI_USAGE_ARGS], { cwd: os.tmpdir(), env: geminiEnv(this.baseEnv, { home }) });
      } catch (err) {
        resolve({ ok: false, error: `agy 실행 실패 — ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      let out = '', errTail = '', settled = false, timedOut = false;
      const done = (r: { ok: true; stdout: string } | { ok: false; error: string }) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, this.timeoutMs);
      timer.unref?.();
      child.stdin?.end();
      child.stdout?.on('data', (d: Buffer | string) => { if (out.length < STDOUT_MAX) out += d.toString(); });
      child.stderr?.on('data', (d: Buffer | string) => { errTail = (errTail + d.toString()).slice(-2000); });
      child.once('exit', (code: number | null) => {
        if (timedOut) { done({ ok: false, error: 'agy /usage 응답 없음 (시간 초과)' }); return; }
        if (/authentication required|Authentication required|Please sign in/i.test(errTail + out)) { done({ ok: false, error: GEMINI_LOGIN_HINT }); return; }
        if (code === 0 || out.trim()) { done({ ok: true, stdout: out }); return; }
        const line = errTail.trim().split('\n').filter(Boolean).pop() ?? '';
        done({ ok: false, error: `agy /usage 실패 (exit ${code ?? '?'})${line ? ` — ${line.slice(0, 200)}` : ''}` });
      });
      child.once('error', (err: Error) => done({ ok: false, error: `agy 실행 실패 — ${err.message}` }));
    });
  }

  /** A Gemini turn just ended: read again soon (coalesced), the numbers moved. */
  bump(delayMs = 4_000): void {
    if (this.bumpTimer) return;
    this.bumpTimer = setTimeout(() => { this.bumpTimer = null; void this.pollOnce(); }, delayMs);
    this.bumpTimer.unref?.();
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bumpTimer) clearTimeout(this.bumpTimer);
    this.timer = null;
    this.bumpTimer = null;
  }
}
