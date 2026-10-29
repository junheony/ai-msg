import type { Account, AccountNames, GeminiAccount } from '../../shared/accounts';
import { grokBillingWindow, parseIsoUtc, type GeminiBucket, type UsageSnapshot } from '../../shared/usage-types';
import type { EngineLimits, GeminiGroup, GeminiSeatLimits } from './AutoRoute';

/**
 * The raw state TurnRunner holds, normalized into chooseRoute's EngineLimits (auto-route design §5, §10-6). Pure: the
 * caller reads the snapshot, the cooldown files and its in-memory cooldowns; this only reshapes them.
 */
export type EngineLimitsInput = {
  usage: UsageSnapshot;
  nowMs: number;
  claude: { cooldownUntilMs: Partial<Record<Account, number>>; protectedAccount: Account | null; accounts: AccountNames };
  codex: { installed: boolean; cooldownUntilMs: number | null };
  gemini: { installed: boolean; loggedIn: Record<GeminiAccount, boolean>; cooldownUntilMs: Partial<Record<GeminiAccount, number>> };
  grok: { installed: boolean; cooldownUntilMs: number | null; lastError: 'auth' | 'other' | null };
};

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = parseIsoUtc(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * A bucket's model group from its "<group> · <window>" name: Argon / Pro → pro; Flash or the plain "Gemini" group
 * (agy's "Gemini Models", the Flash family) → flash; anything else (another vendor's group) → null.
 */
export function geminiGroupOf(name: string): GeminiGroup | null {
  const group = (name.split(' · ')[0] ?? name).trim();
  if (/claude|gpt|openai|anthropic/i.test(group)) return null;
  if (/argon|\bpro\b/i.test(group)) return 'pro';
  if (/flash/i.test(group) || /^gemini$/i.test(group)) return 'flash';
  return null;
}

/** Remaining % per group: 100 − the highest used % among the group's buckets (5h and weekly); null when none is reported. */
function remainingByGroup(buckets: readonly GeminiBucket[]): Record<GeminiGroup, number | null> {
  const out: Record<GeminiGroup, number | null> = { pro: null, flash: null };
  for (const b of buckets) {
    const g = geminiGroupOf(b.name);
    if (!g) continue;
    const rem = Math.max(0, Math.min(100, 100 - b.usedPct));
    out[g] = out[g] === null ? rem : Math.min(out[g]!, rem);
  }
  // review #7: Argon is Pro-only quota nested inside the big shared "Gemini" bucket (agy's "Gemini Models" — both Pro
  // and Flash draw from it), so Pro's real remaining is never more than that shared bucket's.
  if (out.flash !== null) out.pro = out.pro === null ? out.flash : Math.min(out.pro, out.flash);
  return out;
}

/**
 * The Grok seat's subscription used % (and its period's reset time) for the current period; null when never read, its
 * period has ended, or — review item 3 — the window's end is unknown and the cached reading is over 24h old (stale
 * enough that it should not keep blocking Grok routing).
 */
function grokPeriodUsage(usage: UsageSnapshot, nowMs: number): { periodUsedPct: number | null; periodResetsAtMs: number | null } {
  const billing = usage.grokSeats?.x1?.billing;
  if (billing && !billing.windowEnd) {
    const fetched = ms(billing.fetchedAt);
    if (fetched !== null && nowMs - fetched > 24 * 3600_000) return { periodUsedPct: null, periodResetsAtMs: null };
  }
  const w = grokBillingWindow(billing, nowMs);
  if (!w || w.estimated) return { periodUsedPct: null, periodResetsAtMs: null };
  return { periodUsedPct: w.usedPct, periodResetsAtMs: ms(w.resetsAt) };
}

export function buildEngineLimits(i: EngineLimitsInput): EngineLimits {
  const gpt = i.usage.gpt;
  const gptDown = !gpt || gpt.status === 'down';
  const gem = i.usage.gemini;
  const gemDown = !gem || gem.status === 'down';
  const g1rem = gemDown ? { pro: null, flash: null } : remainingByGroup(gem.buckets);
  const g2u = i.usage.geminiSeats?.g2;
  const g2down = !g2u || g2u.status === 'down';
  const g2rem = !i.gemini.loggedIn.g2 || !g2u || g2u.status === 'down' ? { pro: null, flash: null } : remainingByGroup(g2u.buckets);
  const observed = [gemDown ? null : ms(gem?.fetchedAt), g2down ? null : ms(g2u?.fetchedAt)].filter((t): t is number => t !== null);
  const cooling = (a: GeminiAccount) => (i.gemini.cooldownUntilMs[a] ?? 0) > i.nowMs;
  const seat = (a: GeminiAccount, enabled: boolean, pct: Record<GeminiGroup, number | null>): GeminiSeatLimits =>
    ({ seat: a, enabled, remainingPct: cooling(a) ? { pro: 0, flash: 0 } : pct });
  return {
    claude: { usage: i.usage, cooldownUntilMs: i.claude.cooldownUntilMs, protectedAccount: i.claude.protectedAccount, accounts: i.claude.accounts },
    codex: {
      installed: i.codex.installed,
      weeklyUsedPct: gptDown ? null : gpt.weekly?.usedPct ?? null,
      weeklyResetsAtMs: gptDown ? null : ms(gpt.weekly?.resetsAt),
      observedAtMs: gptDown ? null : ms(gpt.fetchedAt),
      cooldownUntilMs: i.codex.cooldownUntilMs,
    },
    gemini: {
      installed: i.gemini.installed,
      loggedIn: i.gemini.loggedIn.g1 || i.gemini.loggedIn.g2,
      observedAtMs: observed.length ? Math.max(...observed) : null,
      seats: [seat('g1', true, g1rem), seat('g2', i.gemini.loggedIn.g2, g2rem)],
    },
    grok: { installed: i.grok.installed, cooldownUntilMs: i.grok.cooldownUntilMs, lastError: i.grok.lastError, ...grokPeriodUsage(i.usage, i.nowMs) },
  };
}
