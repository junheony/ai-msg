import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AccountRegistry } from '../../shared/accounts';
import type { UsageWindow } from '../../shared/usage-types';
import type { SpawnFn } from '../engine/CodexEngine';
import { STALE_MAX_MS } from '../routing/AccountRouter';
import type { TurnWindows, UsageService } from './UsageService';

/**
 * The CLI's print-mode `/usage`: no model call (num_turns 0, cost 0, ~5 s), the account's real limits as text in the
 * json `result`. `--bare` cannot be used (it skips the OAuth login); no settings, no MCP, no session file.
 */
export const CLAUDE_USAGE_ARGS = ['-p', '/usage', '--setting-sources=', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'json'] as const;

const STDOUT_MAX = 1_048_576;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A reset "at 5:59pm" read at 5:59:40 is that one, not tomorrow's: the text carries no seconds. */
const RESET_GRACE_MS = 2 * 60_000;
/** A date without a year rolls to next year only once it is this far past (a weekly reset never is). */
const RESET_YEAR_SLACK_MS = 7 * 86_400_000;
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

/** `tz`'s offset from UTC at `utcMs` (ms, east positive); throws RangeError for an unknown zone. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** A wall-clock time in `tz` → epoch ms (the offset checked again at the result, for a DST edge). */
function zonedMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  const first = wall - tzOffsetMs(wall, tz);
  return wall - tzOffsetMs(first, tz);
}

/** Today's date in `tz` at `nowMs`. */
function zonedToday(nowMs: number, tz: string): { y: number; mo: number; d: number } {
  const t = new Date(nowMs + tzOffsetMs(nowMs, tz));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
}

/**
 * "Oct 23 at 5:59pm (Asia/Seoul)", "5:59pm (Asia/Seoul)", "3pm (Asia/Seoul)" → ISO UTC, read in the zone in brackets.
 * The nearest future: a date more than RESET_YEAR_SLACK_MS past is next year's, a time more than RESET_GRACE_MS past is
 * tomorrow's (the text is cut to the minute, so a reset a moment ago stays today's). null when unreadable.
 */
export function parseClaudeReset(s: string, nowMs: number): string | null {
  const m = s.trim().match(/^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,?\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*\(([^)]+)\)$/i);
  if (!m) return null;
  const [, mon, day, year, hh, mm, ampm, tzRaw] = m;
  const tz = tzRaw!.trim();
  let h = Number(hh), mi = Number(mm ?? 0);
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/^p/i.test(ampm) ? 12 : 0);
  } else if (mm === undefined || h > 23) return null;
  if (mi > 59) return null;
  try {
    const today = zonedToday(nowMs, tz);
    let t: number;
    if (mon) {
      const mo = MONTHS.indexOf(mon.toLowerCase());
      const d = Number(day);
      if (mo < 0 || d < 1 || d > 31) return null;
      if (year) t = zonedMs(Number(year), mo, d, h, mi, tz);
      else {
        t = zonedMs(today.y, mo, d, h, mi, tz);
        if (t < nowMs - RESET_YEAR_SLACK_MS) t = zonedMs(today.y + 1, mo, d, h, mi, tz);
      }
    } else {
      t = zonedMs(today.y, today.mo, today.d, h, mi, tz);
      if (t < nowMs - RESET_GRACE_MS) t = zonedMs(today.y, today.mo, today.d + 1, h, mi, tz);
    }
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  } catch {
    return null; // not an IANA zone
  }
}

/**
 * The `/usage` text → windows: `Current session` → fiveHour, `Current week (all models)` → weekly, a
 * `Current week (<model>)` naming Opus or Fable → fable (as stream.ts fableSpentOf: Fable shares the Opus family's
 * limit). null when no line reads (not a subscription, logged out, another text): nothing should change then.
 */
export function parseClaudeUsageText(text: string, nowMs: number): TurnWindows | null {
  const out: TurnWindows = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const m = line.match(/^Current\s+(session|week\s*\(([^)]*)\))\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%\s*used\b(?:\s*[·•|—–-]\s*resets?\s+(.+))?$/i);
    if (!m) continue;
    const [, kind, model, pct, reset] = m;
    const key: keyof TurnWindows | null = /^session/i.test(kind!) ? 'fiveHour' : /^all\s+models$/i.test(model!.trim()) ? 'weekly' : /opus|fable/i.test(model!) ? 'fable' : null;
    if (!key || out[key]) continue;
    const w: UsageWindow = { usedPct: clampPct(Number(pct)), resetsAt: reset ? parseClaudeReset(reset, nowMs) : null };
    out[key] = w;
  }
  return out.fiveHour || out.weekly || out.fable ? out : null;
}

/** The CLI's json stdout (`result`, not an error) or, failing that, the plain text. */
export function parseClaudeUsage(stdout: string, nowMs: number): TurnWindows | null {
  const whole = stdout.trim();
  if (whole.startsWith('{')) {
    try {
      const o = JSON.parse(whole) as { result?: unknown; is_error?: unknown };
      if (o.is_error === true) return null;
      return typeof o.result === 'string' ? parseClaudeUsageText(o.result, nowMs) : null;
    } catch { /* not json: the text below */ }
  }
  return parseClaudeUsageText(stdout, nowMs);
}

/** The binary the usage poller runs in either usage mode (`DECK_CLAUDE_USAGE_POLL=0` or no usable claude: null → no poller). */
export function claudePollBin(cfg: { claudeUsagePoll: boolean; claudeBin: { ok: true; bin: string } | { ok: false } }): string | null {
  return cfg.claudeUsagePoll && cfg.claudeBin.ok ? cfg.claudeBin.bin : null;
}

type RunResult = { ok: true; stdout: string } | { ok: false; error: string };
/** A spawned child that also says when its output pipes closed (node's ChildProcess does). */
type UsageChild = ReturnType<SpawnFn> & { once(event: 'close', cb: (code: number | null) => void): unknown };

/** After `exit`, how long the output pipes may stay open (something the CLI left holds them) before the group is killed. */
const CLOSE_GRACE_MS = 2_000;
/** After a SIGKILL, how long to wait for `exit`/`close` before giving up on the child. */
const KILL_WAIT_MS = 5_000;
/** Consecutive failures on one account back off to at most this. */
const BACKOFF_MAX_MS = 2 * 3_600_000;

/**
 * Claude usage without a turn (`cli` usage mode): shortly after start, then every `intervalMs` (5 min), each active
 * account whose last observation (a turn's rate_limit_event or an earlier poll; the last poll too, so the account in use
 * — fresh from its own turns, which never tell Fable — is still read; never polled = due) is older than `maxAgeMs`
 * (STALE_MAX_MS − 2 min, so the card never turns 오래됨 between checks) gets one `claude -p /usage` in its own profile
 * (the registry's CLAUDE_CONFIG_DIR), one at a time; an account with a turn or background work running (`busy`) waits for the next round. A failure is logged when it changes (a new error, or the account
 * recovering) and the account backs off exponentially, up to BACKOFF_MAX_MS. Reads the CLI's text only — never
 * credentials.
 */
export class ClaudeUsagePoller {
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private child: { child: UsageChild; give: () => void } | null = null;
  private stopped = false;
  /** Per account: the last failure (logged once) and when it may be tried again. */
  private failures = new Map<Account, { error: string; count: number; retryAt: number }>();
  private readonly intervalMs: number;
  private readonly maxAgeMs: number;
  private readonly startDelayMs: number;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: {
    /** The resolved claude binary; null = none usable (nothing runs). */
    bin: string | null;
    accounts: Pick<AccountRegistry, 'list' | 'env'>;
    usage: Pick<UsageService, 'applyCliPoll' | 'cliObservedAt'>;
    /** True while a turn or background work runs on the account: that round skips it (not a failure: no backoff, nothing recorded). A throw counts as not busy. */
    busy?: (account: Account) => boolean;
    intervalMs?: number;
    maxAgeMs?: number;
    startDelayMs?: number;
    timeoutMs?: number;
    spawnFn?: SpawnFn;
    now?: () => number;
    baseEnv?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
  }) {
    this.intervalMs = opts.intervalMs ?? 5 * 60_000;
    this.maxAgeMs = opts.maxAgeMs ?? STALE_MAX_MS - 2 * 60_000;
    this.startDelayMs = opts.startDelayMs ?? 20_000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.spawnFn = opts.spawnFn ?? ((b, args, o) => nodeSpawn(b, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }));
    this.now = opts.now ?? Date.now;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /** One round over the active accounts (serial); a round already running is shared, never doubled. */
  sweep(): Promise<void> {
    if (!this.running) this.running = this.round().finally(() => { this.running = null; });
    return this.running;
  }

  private due(a: Account): boolean {
    const f = this.failures.get(a);
    if (f && this.now() < f.retryAt) return false;
    const at = this.opts.usage.cliObservedAt(a);
    return at === null || this.now() - at > this.maxAgeMs;
  }

  private isBusy(a: Account): boolean {
    try { return this.opts.busy?.(a) ?? false; } catch { return false; }
  }

  private async round(): Promise<void> {
    if (!this.opts.bin) return;
    for (const a of this.opts.accounts.list()) {
      if (this.stopped) return;
      if (!this.due(a) || this.isBusy(a)) continue;
      await this.pollAccount(a);
    }
  }

  private failed(a: Account, error: string): void {
    const prev = this.failures.get(a);
    const count = (prev?.count ?? 0) + 1;
    this.failures.set(a, { error, count, retryAt: this.now() + Math.min(this.intervalMs * 2 ** (count - 1), BACKOFF_MAX_MS) });
    if (prev?.error !== error) this.log(`deck: claude /usage (${a}) ${error}`);
  }

  private succeeded(a: Account): void {
    if (!this.failures.has(a)) return;
    this.failures.delete(a);
    this.log(`deck: claude /usage (${a}) 다시 읽힘`);
  }

  /** One `/usage` read for `a`; applied with the time it started (a turn that ends meanwhile is newer and wins). */
  async pollAccount(a: Account): Promise<void> {
    const bin = this.opts.bin;
    if (!bin) return;
    const startedAt = this.now();
    let env: Record<string, string | undefined>;
    try {
      env = this.opts.accounts.env(a, this.baseEnv);
    } catch (err) {
      this.failed(a, `건너뜀 — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const run = await this.runUsage(bin, env);
    if (this.stopped) return;
    if (!run.ok) { this.failed(a, `실패 — ${run.error}`); return; }
    const w = parseClaudeUsage(run.stdout, startedAt);
    if (!w) { this.failed(a, `응답에 한도 줄이 없어 그대로 둡니다 — 앞부분: ${run.stdout.replace(/\s+/g, ' ').slice(0, 200)}`); return; }
    this.succeeded(a);
    this.opts.usage.applyCliPoll(a, w, startedAt);
  }

  private killTree(child: ReturnType<SpawnFn>, sig: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid && pid > 1) { try { process.kill(-pid, sig); return; } catch { /* no group: the child alone */ } }
    try { child.kill(sig); } catch { /* gone */ }
  }

  private runUsage(bin: string, env: Record<string, string | undefined>): Promise<RunResult> {
    return new Promise((resolve) => {
      let cwd: string;
      try {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-claude-usage-'));
      } catch (err) {
        resolve({ ok: false, error: `임시 디렉터리를 만들 수 없음 — ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const cleanup = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } };
      let child: UsageChild;
      try {
        child = this.spawnFn(bin, [...CLAUDE_USAGE_ARGS], { cwd, env }) as UsageChild;
      } catch (err) {
        cleanup();
        resolve({ ok: false, error: `claude 실행 실패 — ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      let out = '', errTail = '', settled = false, timedOut = false;
      let exitCode: number | null | undefined; // undefined = no `exit` yet
      const timers: ReturnType<typeof setTimeout>[] = [];
      const later = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref?.(); timers.push(t); };
      const done = (r: RunResult) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        this.child = null;
        cleanup();
        resolve(r);
      };
      // SIGKILL the group; if neither `exit` nor `close` follows, give up on the child so the round goes on.
      const kill = (why: string) => {
        this.killTree(child, 'SIGKILL');
        later(KILL_WAIT_MS, () => done({ ok: false, error: `${why} — 종료 신호 뒤에도 끝나지 않음` }));
      };
      // The answer is judged once the output pipes have closed: `exit` can come before the last stdout data.
      const finish = () => {
        if (timedOut) { done({ ok: false, error: `응답 없음 (${Math.round(this.timeoutMs / 1000)}초 시간 초과)` }); return; }
        if (this.stopped) { done({ ok: false, error: '서버 종료' }); return; }
        if (exitCode === 0 || out.trim()) { done({ ok: true, stdout: out }); return; }
        const line = errTail.trim().split('\n').filter(Boolean).pop() ?? '';
        done({ ok: false, error: `exit ${exitCode ?? '?'}${line ? ` — ${line.slice(0, 200)}` : ''}` });
      };
      this.child = { child, give: () => kill('서버 종료') };
      later(this.timeoutMs, () => { timedOut = true; kill('응답 없음'); });
      child.stdout?.on('data', (d: Buffer | string) => { if (out.length < STDOUT_MAX) out += d.toString(); });
      child.stderr?.on('data', (d: Buffer | string) => { errTail = (errTail + d.toString()).slice(-2000); });
      child.once('exit', (code: number | null) => {
        exitCode = code;
        // Something the CLI left behind may hold the pipes open: then its group goes, and the answer is what came.
        later(CLOSE_GRACE_MS, () => { this.killTree(child, 'SIGKILL'); finish(); });
      });
      child.once('close', (code: number | null) => { if (exitCode === undefined) exitCode = code; finish(); });
      child.once('error', (err: Error) => done({ ok: false, error: `claude 실행 실패 — ${err.message}` }));
    });
  }

  start(): void {
    if (this.timer || this.startTimer || this.stopped) return;
    this.startTimer = setTimeout(() => { this.startTimer = null; void this.sweep(); }, this.startDelayMs);
    this.startTimer.unref?.();
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Timers off and a running `/usage` child (its process group) killed; no round starts after this. */
  stop(): void {
    this.stopped = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = null;
    this.timer = null;
    this.child?.give();
  }
}
