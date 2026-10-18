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

/** The Grok seat's subscription used % for the current period; null when never read or its period has ended. */
function grokPeriodUsedPct(usage: UsageSnapshot, nowMs: number): number | null {
  const w = grokBillingWindow(usage.grokSeats?.x1?.billing, nowMs);
  return w && !w.estimated ? w.usedPct : null;
}

export function buildEngineLimits(i: EngineLimitsInput): EngineLimits {
  const gpt = i.usage.gpt;
  const gptDown = !gpt || gpt.status === 'down';
  const gem = i.usage.gemini;
  const gemDown = !gem || gem.status === 'down';
  const rem = gemDown ? { pro: null, flash: null } : remainingByGroup(gem.buckets);
  const cooling = (a: GeminiAccount) => (i.gemini.cooldownUntilMs[a] ?? 0) > i.nowMs;
  // The snapshot is one agy report (no per-seat numbers): G1 carries it, G2 is known only to be logged in.
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
      observedAtMs: gemDown ? null : ms(gem.fetchedAt),
      seats: [seat('g1', true, rem), seat('g2', i.gemini.loggedIn.g2, { pro: null, flash: null })],
    },
    grok: { installed: i.grok.installed, cooldownUntilMs: i.grok.cooldownUntilMs, lastError: i.grok.lastError, periodUsedPct: grokPeriodUsedPct(i.usage, i.nowMs) },
  };
}
