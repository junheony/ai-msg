import type { Account, GeminiAccount, GrokAccount } from './accounts';

export type UsageWindow = {
  usedPct: number;
  resetsAt: string | null;
  /** `cli` usage mode: the last observation's `resetsAt` has passed, so 0 % is assumed, not observed. */
  estimated?: boolean;
};

/** ChatGPT pay-as-you-go credits from the Codex rollout's `rate_limits.credits`: usable after the plan's weekly is spent (they cost money). */
export type GptCredits = { hasCredits: boolean; unlimited: boolean; balance: number | null };

export type AccountUsage = {
  status: 'ok' | 'stale' | 'down';
  fetchedAt: string | null;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  fable: UsageWindow | null;
  /** GPT seat only: credits, when the rollout reported them. */
  credits?: GptCredits | null;
  /**
   * `cli` usage mode: until when the last observation still counts (ISO). Usage within a window never goes down, so the
   * observed numbers are a lower bound until the window resets: routing keeps a 'stale' account as a candidate until
   * then (see `trusted`). Absent = no such promise (usage-deck mode, never observed).
   */
  trustUntil?: string;
};

/** One Antigravity quota bucket as `agy -p=/usage` reports it; agy 1.4.2 names it "<group> · <window>" (e.g. `Gemini · 5h`, `Argon · 주간`). */
export type GeminiBucket = { name: string; usedPct: number; resetsAt: string | null };

/**
 * The Gemini (agy) seat. `loggedIn` false = the keychain login is missing, so no numbers (status 'down').
 * 'stale' = the last `/usage` read failed and these are the previous buckets. `error`: why there are no fresh numbers.
 */
export type GeminiUsage = { status: 'ok' | 'stale' | 'down'; fetchedAt: string | null; loggedIn: boolean; buckets: GeminiBucket[]; error?: string | null };

/**
 * The Grok seat (usage header design §4/§7-4/§7-5): no official quota API, so this is only what deck's own Grok turns
 * observed. `status`: 'unknown' = no Grok turn yet; 'down' = the last turn's error was an auth failure, kept until the
 * next turn succeeds; 'cooldown' = `cooldownUntil` (read from `TurnRunner.grokCooldownUntil`, the only source) is still
 * in the future; else 'ok'. `lastError`: the last turn's own classification, independent of `status`'s persistence.
 * `today`: input+output tokens of every turn that ended (success, stop or error, cancels included) on the local
 * calendar day `day`; read past midnight it resets (UsageSnapshot readers compare `day` themselves).
 */
export type GrokUsage = {
  status: 'ok' | 'down' | 'cooldown' | 'unknown';
  lastTurnAt: string | null;
  lastError: 'auth' | 'limit' | 'busy' | null;
  cooldownUntil: string | null;
  today: { inputTokens: number; outputTokens: number; turns: number; day: string };
  /** The subscription's own usage (Grok ACP `_x.ai/billing`); absent = never read (an older server, or no answer yet). */
  billing?: GrokBilling | null;
};

/**
 * One `_x.ai/billing` answer (grok 1.0.62), read at the end of a Grok turn or by the idle poller. `usedPct`: the
 * answer's `config.creditUsagePercent`, read as the percent of the period's included credit already used (0–100; 1.0
 * = 1 % used, 99 % left — the field name and SuperGrok's weekly window point that way). `windowStart`/`windowEnd`: the
 * current usage period (`currentPeriod`, else `billingPeriodStart/End`), ISO. `tier`: `subscription_tier`. The other
 * numbers are passed on only when the answer has them (seen in the binary, not in an answer yet).
 */
export type GrokBilling = {
  usedPct: number;
  windowStart: string | null;
  windowEnd: string | null;
  tier: string | null;
  fetchedAt: string;
  periodType?: string | null;
  monthlyLimit?: number | null;
  onDemandCap?: number | null;
  onDemandUsed?: number | null;
  includedUsed?: number | null;
  totalUsed?: number | null;
};

/**
 * The billing period as a usage window (the cards and routing read every engine as one). A period whose end has passed
 * is a new one deck has not read yet: 0 % assumed (`estimated`), as the `cli` mode does for Claude.
 */
export function grokBillingWindow(b: GrokBilling | null | undefined, nowMs: number): UsageWindow | null {
  if (!b || typeof b.usedPct !== 'number' || !Number.isFinite(b.usedPct)) return null;
  const end = b.windowEnd ? parseIsoUtc(b.windowEnd) : Number.NaN;
  if (!Number.isNaN(end) && end <= nowMs) return { usedPct: 0, resetsAt: null, estimated: true };
  return { usedPct: Math.max(0, Math.min(100, b.usedPct)), resetsAt: b.windowEnd };
}

export type UsageSnapshot = {
  generatedAt: string;
  deckReachable: boolean;
  /** By account id. An account may be missing (snapshot from before it was configured): read with `usageOf`. */
  accounts: Record<Account, AccountUsage>;
  /** ChatGPT Pro (usage-deck card `codex`); status 'down' = unknown (D5). Optional only for Plan 1 test literals. */
  gpt?: AccountUsage;
  /** Gemini via agy; absent = agy not installed (no card). Kept for older UIs — `geminiSeats.g1` carries the same value. */
  gemini?: GeminiUsage;
  /** Gemini seats (usage header design §4/§7-1); absent/missing key = agy not installed or that seat never polled. g2 is unused until that seat exists. */
  geminiSeats?: Partial<Record<GeminiAccount, GeminiUsage>>;
  /** Grok seats (usage header design §4/§7-4); absent/missing key = no `grok` binary or no Grok turn yet on that seat. */
  grokSeats?: Partial<Record<GrokAccount, GrokUsage>>;
  /** 'none' = this install has never had an answer from usage-deck: unknown usage alone does not change the model or engine. Absent = 'deck'. */ usageSource?: 'deck' | 'none';
  /**
   * Where the Claude account numbers come from (`DECK_USAGE_SOURCE`). 'cli' = only the `rate_limit_event` of deck's own
   * turns (no usage-deck): an account's `fetchedAt` is when that was last observed. Absent = 'usage-deck'.
   */
  usageMode?: UsageMode;
};

export type UsageMode = 'cli' | 'usage-deck';

export function remainingPct(w: UsageWindow | null): number | null {
  if (!w) return null;
  return Math.max(0, Math.min(100, 100 - w.usedPct));
}

export function emptyAccountUsage(): AccountUsage {
  return { status: 'down', fetchedAt: null, fiveHour: null, weekly: null, fable: null };
}

/** `day`: the local calendar day (`YYYY-MM-DD`) `today` starts at, e.g. `localDay(new Date())`. */
export function emptyGrokUsage(day: string): GrokUsage {
  return { status: 'unknown', lastTurnAt: null, lastError: null, cooldownUntil: null, today: { inputTokens: 0, outputTokens: 0, turns: 0, day } };
}

/** `YYYY-MM-DD` in local time (GrokUsage.today.day resets at local midnight, not UTC). */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** An account's usage; one the snapshot does not carry is unknown ('down'). */
export function usageOf(s: Pick<UsageSnapshot, 'accounts'>, account: Account): AccountUsage {
  return (Object.hasOwn(s.accounts, account) ? s.accounts[account] : undefined) ?? emptyAccountUsage();
}

/** A 'stale' account whose numbers still hold as a lower bound (`trustUntil` not yet reached): routing keeps it. */
export function trusted(u: AccountUsage, nowMs: number): boolean {
  return u.trustUntil !== undefined && parseIsoUtc(u.trustUntil) > nowMs;
}

/** `accounts`: the ids to carry (the server passes its registry's). */
export function emptySnapshot(now: Date, accounts: readonly Account[]): UsageSnapshot {
  return {
    generatedAt: now.toISOString(),
    deckReachable: false,
    accounts: Object.fromEntries(accounts.map((a) => [a, emptyAccountUsage()])),
    gpt: emptyAccountUsage(),
  };
}

/**
 * Epoch ms of an ISO timestamp; a date-time without a zone is UTC (claude-pick / Python
 * `fromisoformat` + `replace(tzinfo=utc)`), unlike `Date.parse`, which uses local time. NaN if unparsable.
 */
export function parseIsoUtc(iso: string): number {
  let t = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
    t = t.slice(0, 10) + 'T' + t.slice(11);
    if (!/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(t)) t += 'Z';
  }
  return Date.parse(t);
}
