import type { GrokAccount } from '../../shared/accounts';
import { parseIsoUtc, type GrokBilling } from '../../shared/usage-types';
import type { GrokBillingProbe } from '../engine/grokBilling';

/** How often the subscription's usage is read while no Grok turn reads it. */
export const GROK_BILLING_INTERVAL_MS = 15 * 60_000;
/** How often the poller looks whether a read is due (a passed period end is read on the next tick). */
export const GROK_BILLING_TICK_MS = 60_000;

const STOP_KINDS = new Set<GrokBillingProbe['kind']>(['no_bin', 'auth', 'unsupported']);

/**
 * Keeps the Grok card's subscription usage fresh while deck runs no Grok turn: one read right after start, then
 * whenever the last read (a turn's or its own) is GROK_BILLING_INTERVAL_MS old, or the billing period's end has passed
 * since it. Skipped while a Grok turn holds or waits for the Grok lock (`busy`). No binary, no login, or a grok
 * without `_x.ai/billing` stops it for this server process (one log line); other failures are tried again later.
 */
export class GrokBillingPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private lastAttemptMs = Number.NEGATIVE_INFINITY;
  private lastLogged = '';
  private readonly account: GrokAccount;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly tickMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: {
    probe: () => Promise<GrokBillingProbe>;
    tracker: { noteBilling(account: GrokAccount, b: GrokBilling): void; billingOf(account: GrokAccount): GrokBilling | null };
    /** True while a Grok turn runs (or waits to): the poll is skipped, a later tick tries again. */
    busy: () => boolean;
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

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Is a read due: never tried, the last read (any source) is an interval old, or the period ended after it. */
  private due(nowMs: number): boolean {
    const b = this.opts.tracker.billingOf(this.account);
    const fetched = b ? parseIsoUtc(b.fetchedAt) : Number.NaN;
    const last = Math.max(this.lastAttemptMs, Number.isNaN(fetched) ? Number.NEGATIVE_INFINITY : fetched);
    if (nowMs - last >= this.intervalMs) return true;
    const end = b?.windowEnd ? parseIsoUtc(b.windowEnd) : Number.NaN;
    return !Number.isNaN(end) && end <= nowMs && last < end;
  }

  /** One tick (tests call it directly); resolves once a read it started is done. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const nowMs = this.now();
    if (!this.due(nowMs) || this.opts.busy()) return Promise.resolve();
    this.lastAttemptMs = nowMs;
    this.inFlight = this.read().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async read(): Promise<void> {
    let r: GrokBillingProbe;
    try {
      r = await this.opts.probe();
    } catch (e) {
      r = { kind: 'error', message: (e as Error)?.message ?? String(e) };
    }
    if (this.stopped) return;
    if (r.kind === 'ok') {
      this.lastLogged = '';
      this.opts.tracker.noteBilling(this.account, r.billing);
      return;
    }
    if (STOP_KINDS.has(r.kind)) {
      this.stop();
      this.log(`deck: Grok 구독 사용량 조회를 멈춤 — ${r.message}`);
      return;
    }
    // The same failure every 15 minutes is said once.
    const line = `deck: Grok 구독 사용량 조회 실패 — ${r.message}`;
    if (line !== this.lastLogged) { this.lastLogged = line; this.log(line); }
  }
}
