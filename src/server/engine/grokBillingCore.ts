import type { GrokBilling } from '../../shared/usage-types';

/**
 * Shared between `GrokEngine.ts` (reads this after a turn's prompt) and `grokBilling.ts` (the idle poller's probe), kept
 * in its own file with no import of either so neither has to import the other (they otherwise would: GrokEngine needs
 * the parser, grokBilling needs GrokEngine's spawn args/timeouts/lock — a cycle).
 */

/**
 * Grok ACP extension for the subscription's usage (grok 1.0.62; `x.ai/billing` without the underscore is Method not
 * found). Needs only `initialize` — no session, no prompt, so reading it uses no quota.
 */
export const GROK_BILLING_METHOD = '_x.ai/billing';

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Rec) : null);
const iso = (x: unknown): string | null => (typeof x === 'string' && x && !Number.isNaN(Date.parse(x)) ? x : null);
/** A number, or protobuf-JSON's `{ val: n }` wrapper (`prepaidBalance` comes that way). */
const numOf = (x: unknown): number | null => {
  const v = rec(x) ? (x as Rec).val : x;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * One `_x.ai/billing` result as deck keeps it; null when it has no usable `config.creditUsagePercent`. The percent is
 * read as "used" (see GrokBilling); a value outside 0–100 is clamped.
 */
export function parseGrokBilling(result: unknown, fetchedAtMs: number): GrokBilling | null {
  const r = rec(result);
  const config = rec(r?.config);
  const pct = numOf(config?.creditUsagePercent);
  if (!r || !config || pct === null) return null;
  const period = rec(config.currentPeriod);
  const usage = rec(config.billingPeriodUsage) ?? rec(config.currentPeriodUsage) ?? rec(config.periodUsage) ?? rec(config.usage);
  const tier = r.subscription_tier ?? r.subscriptionTier ?? config.subscriptionTier;
  const out: GrokBilling = {
    usedPct: Math.max(0, Math.min(100, pct)),
    windowStart: iso(period?.start) ?? iso(config.billingPeriodStart),
    windowEnd: iso(period?.end) ?? iso(config.billingPeriodEnd),
    tier: typeof tier === 'string' && tier.trim() ? tier.trim().slice(0, 80) : null,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
  };
  if (typeof period?.type === 'string' && period.type) out.periodType = period.type.slice(0, 60);
  const extra: Array<[keyof GrokBilling, unknown]> = [
    ['monthlyLimit', config.monthlyLimit], ['onDemandCap', config.onDemandCap], ['onDemandUsed', config.onDemandUsed],
    ['includedUsed', usage?.includedUsed], ['totalUsed', usage?.totalUsed],
  ];
  for (const [k, v] of extra) {
    const n = numOf(v);
    if (n !== null) (out as Record<string, unknown>)[k] = n;
  }
  return out;
}

/**
 * The idle poller's answer. `no_bin` / `auth` / `unsupported` stop it; `blocked` (engine locked, the fail-closed checks
 * refused) and `error` are tried again on a later tick.
 */
export type GrokBillingProbe =
  | { kind: 'ok'; billing: GrokBilling }
  | { kind: 'no_bin' | 'auth' | 'unsupported' | 'blocked' | 'error'; message: string };

// ---------------------------------------------------------------------------------------------------------------
// Review item 1: a turn-end billing read is skipped (for the rest of this server process, or for a cooldown window)
// when the running grok binary clearly does not support the method, or keeps timing out. State lives here so it is
// one process-lifetime singleton shared by every GrokTurn, injectable through GrokDeps for tests.

export const GROK_BILLING_TIMEOUT_SKIP_THRESHOLD = 3;
export const GROK_BILLING_TIMEOUT_SKIP_MS = 30 * 60_000;

export type GrokBillingSkipState = {
  /** A `_x.ai/billing` request answered Method not found: this grok binary never has it, for the rest of the process. */
  unsupported: boolean;
  /** Consecutive turn-end billing timeouts; any other outcome resets it. */
  consecutiveTimeouts: number;
  /** Set after GROK_BILLING_TIMEOUT_SKIP_THRESHOLD consecutive timeouts: reads are skipped until this ms passes. */
  skipUntilMs: number | null;
};

export function createGrokBillingSkipState(): GrokBillingSkipState {
  return { unsupported: false, consecutiveTimeouts: 0, skipUntilMs: null };
}

/** One process-lifetime instance; tests inject their own via `GrokDeps.billingSkip` instead of touching this one. */
export const grokBillingSkipState: GrokBillingSkipState = createGrokBillingSkipState();

/** Whether a turn-end billing read should be skipped right now, given the shared state. */
export function grokBillingShouldSkip(state: GrokBillingSkipState, nowMs: number): boolean {
  if (state.unsupported) return true;
  if (state.skipUntilMs !== null) {
    if (nowMs < state.skipUntilMs) return true;
    state.skipUntilMs = null;
    state.consecutiveTimeouts = 0;
  }
  return false;
}

export type GrokBillingOutcome = 'ok' | 'method_not_found' | 'timeout' | 'other';

/** Updates the shared state after a turn-end billing attempt (or the lack of one need not call this at all). */
export function grokBillingNoteOutcome(state: GrokBillingSkipState, outcome: GrokBillingOutcome, nowMs: number): void {
  if (outcome === 'method_not_found') { state.unsupported = true; return; }
  if (outcome === 'timeout') {
    state.consecutiveTimeouts += 1;
    if (state.consecutiveTimeouts >= GROK_BILLING_TIMEOUT_SKIP_THRESHOLD) state.skipUntilMs = nowMs + GROK_BILLING_TIMEOUT_SKIP_MS;
    return;
  }
  state.consecutiveTimeouts = 0;
}
