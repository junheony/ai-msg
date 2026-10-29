import fs from 'node:fs';
import type { GrokAccount } from '../../shared/accounts';
import { parseIsoUtc, type GrokBilling } from '../../shared/usage-types';
import type { GrokBillingProbe } from '../engine/grokBilling';

/** How often the subscription's usage is read while no Grok turn reads it. */
export const GROK_BILLING_INTERVAL_MS = 15 * 60_000;
/** How often the poller looks whether a read is due (a passed period end is read on the next tick). */
export const GROK_BILLING_TICK_MS = 60_000;
/** Review item 2: a failed read's first retry delay, doubling after that up to GROK_BILLING_BACKOFF_MAX_MS. */
export const GROK_BILLING_BACKOFF_MS = 60 * 60_000;
export const GROK_BILLING_BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** A missing binary or a grok build without `_x.ai/billing` will not start working until this process restarts. */
const STOP_KINDS = new Set<GrokBillingProbe['kind']>(['no_bin', 'unsupported']);

export type GrokBillingTracker = {
  noteBilling(account: GrokAccount, b: GrokBilling): void;
  billingOf(account: GrokAccount): GrokBilling | null;
  /** The probe found Grok logged out. Optional so a tracker that only stores readings still type-checks. */
  noteAuth?(account: GrokAccount): void;
};

/**
 * Keeps the Grok card's subscription usage fresh while deck runs no Grok turn: one read right after start, then
 * whenever the last read (a turn's or its own) is GROK_BILLING_INTERVAL_MS old, or the billing period's end has passed
 * since it. Skipped while a Grok turn holds or waits for the Grok lock (`busy`). No binary, or a grok without
 * `_x.ai/billing`, stops it for this server process (one log line). A missing login does not: it marks the seat
 * logged out and backs off like any other failure (review item 2) — the first retry is an hour later, doubling up to
 * GROK_BILLING_BACKOFF_MAX_MS — so a device login can be picked up without a restart. `nudge()` (the login window
 * exited 0) or a newer `~/.grok/auth.json` mtime reads again on the next tick. The auth file's contents are never
 * read. A fresh reading from any source (this poller's own read, or a turn's end-of-turn read landing in the tracker)
 * resets the streak and the normal 15-minute cadence.
 */
export class GrokBillingPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private abortCtl: AbortController | null = null;
  private lastAttemptMs = Number.NEGATIVE_INFINITY;
  private lastLogged = '';
  private consecutiveFailures = 0;
  /** Set by `nudge()` or a newer auth file so the next read ignores backoff. Cleared when a read actually starts. */
  private forceDue = false;
  /** mtime last observed for the auth file; null until one is seen. Contents are never read. */
  private seenAuthMtime: number | null = null;
  /** True once a tick looked and the auth file was absent, so a file that appears later counts as a login. */
  private sawAuthMissing = false;
  /** The newest `fetchedAt` this poller has seen from the tracker (its own reads, or a turn's). */
  private lastKnownFetchedMs = Number.NEGATIVE_INFINITY;
  private readonly account: GrokAccount;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly tickMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: {
    probe: (signal: AbortSignal) => Promise<GrokBillingProbe>;
    tracker: GrokBillingTracker;
    /** True while a Grok turn runs (or waits to): the poll is skipped, a later tick tries again. */
    busy: () => boolean;
    /** `~/.grok/auth.json`. Only its mtime is stated, so a login outside this process is noticed. */
    authFile?: string;
    /** Test double for `authFile`'s mtime (ms), or null when the file is absent. */
    authMtime?: () => number | null;
    account?: GrokAccount;
    now?: () => number;
    intervalMs?: number;
    tickMs?: number;
    log?: (line: string) => void;
  }) {
    this.account = opts.account ?? 'x1';
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? GROK_BILLING_INTERVAL_MS;
    this.tickMs = opts.tickMs ?? GROK_BILLING_TICK_MS;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
  }

  /** Stops future ticks, aborts a read in flight, and resolves once that read (if any) has actually ended. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abortCtl?.abort();
    return this.inFlight ?? Promise.resolve();
  }

  get running(): boolean {
    return !this.stopped;
  }

  /**
   * Read on the next tick even if backoff has not elapsed. A poller stopped for good (no binary, no billing method,
   * or shutdown) stays stopped. Safe to call when a Grok turn is busy: the flag is kept until a tick can run.
   */
  nudge(): void {
    if (this.stopped) return;
    this.forceDue = true;
    void this.tick();
  }

  /** Auth-file mtime in ms, or null when there is no file. Never reads the file. */
  private authMtimeMs(): number | null {
    if (this.opts.authMtime) return this.opts.authMtime();
    const file = this.opts.authFile;
    if (!file) return null;
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  /** True when the auth file appeared or was rewritten after the last probe. */
  private authRewritten(): boolean {
    const mtime = this.authMtimeMs();
    if (mtime === null) {
      this.sawAuthMissing = true;
      return false;
    }
    const prev = this.seenAuthMtime;
    const appeared = prev === null && this.sawAuthMissing;
    this.seenAuthMtime = mtime;
    if (!(mtime > this.lastAttemptMs)) return false;
    return appeared || (prev !== null && mtime > prev);
  }

  /** The current retry delay after `consecutiveFailures` failures in a row; 0 while there is no streak. */
  private backoffMs(): number {
    if (this.consecutiveFailures <= 0) return 0;
    return Math.min(GROK_BILLING_BACKOFF_MAX_MS, GROK_BILLING_BACKOFF_MS * 2 ** (this.consecutiveFailures - 1));
  }

  /** Is a read due: never tried, the last read (any source) is an interval (or backoff delay) old, or the period ended. */
  private due(nowMs: number): boolean {
    const b = this.opts.tracker.billingOf(this.account);
    const fetched = b ? parseIsoUtc(b.fetchedAt) : Number.NaN;
    if (!Number.isNaN(fetched) && fetched > this.lastKnownFetchedMs) {
      // A fresh reading arrived from somewhere (this poller's own success, or a turn's end-of-turn read): the streak is over.
      this.lastKnownFetchedMs = fetched;
      this.consecutiveFailures = 0;
    }
    if (this.authRewritten()) this.forceDue = true;
    if (this.forceDue) return true;
    const last = Math.max(this.lastAttemptMs, Number.isNaN(fetched) ? Number.NEGATIVE_INFINITY : fetched);
    const interval = this.consecutiveFailures > 0 ? this.backoffMs() : this.intervalMs;
    if (nowMs - last >= interval) return true;
    if (this.consecutiveFailures > 0) return false;
    const end = b?.windowEnd ? parseIsoUtc(b.windowEnd) : Number.NaN;
    return !Number.isNaN(end) && end <= nowMs && last < end;
  }

  /** One tick (tests call it directly); resolves once a read it started is done. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const nowMs = this.now();
    if (!this.due(nowMs) || this.opts.busy()) return Promise.resolve();
    this.forceDue = false;
    this.lastAttemptMs = nowMs;
    const ctl = new AbortController();
    this.abortCtl = ctl;
    this.inFlight = this.read(ctl.signal).finally(() => { this.inFlight = null; this.abortCtl = null; });
    return this.inFlight;
  }

  private async read(signal: AbortSignal): Promise<void> {
    let r: GrokBillingProbe;
    try {
      r = await this.opts.probe(signal);
    } catch (e) {
      r = { kind: 'error', message: (e as Error)?.message ?? String(e) };
    }
    if (this.stopped) return;
    if (r.kind === 'ok') {
      this.lastLogged = '';
      this.consecutiveFailures = 0;
      this.lastKnownFetchedMs = parseIsoUtc(r.billing.fetchedAt);
      this.opts.tracker.noteBilling(this.account, r.billing);
      return;
    }
    if (STOP_KINDS.has(r.kind)) {
      this.stop();
      this.log(`deck: Grok 구독 사용량 조회를 멈춤 — ${r.message}`);
      return;
    }
    // Logged out is retryable: the card learns it, and a later login (nudge, or a newer auth file) reads again.
    if (r.kind === 'auth') this.opts.tracker.noteAuth?.(this.account);
    this.consecutiveFailures += 1;
    // The same failure in a row is said once.
    const line = `deck: Grok 구독 사용량 조회 실패 — ${r.message}`;
    if (line !== this.lastLogged) { this.lastLogged = line; this.log(line); }
  }
}
