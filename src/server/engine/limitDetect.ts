import type { RateLimitSignal } from './Engine';

export type FailureKind = 'limit' | 'auth' | 'other';

/**
 * Spec §8: the exact text at a hard limit is unmeasured (claude-limit-probe
 * pending). Edit these arrays when a real capture arrives.
 */
export const LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate limit/i,
  /limit reached/i,
  /hit your limit/i,
  /out of (extra )?usage/i,
  /\b429\b/,
  /resets? at/i,
];

export const AUTH_PATTERNS: RegExp[] = [/\b401\b/, /authenticat/i, /OAuth .*revoked/i, /not logged in/i, /please run \/login/i];

export const COOLDOWN_MS: Record<FailureKind, number> = { limit: 60 * 60_000, auth: 6 * 60 * 60_000, other: 0 };

export function classifyFailure(r: {
  ok: boolean;
  errorText: string | null;
  errorKind: string | null;
  rateLimitStatus: RateLimitSignal['status'] | null;
}): FailureKind | null {
  if (r.ok) return null;
  const text = r.errorText ?? '';
  if (r.errorKind === 'rate_limit' || r.rateLimitStatus === 'rejected' || LIMIT_PATTERNS.some((p) => p.test(text))) return 'limit';
  if (r.errorKind === 'authentication_failed' || AUTH_PATTERNS.some((p) => p.test(text))) return 'auth';
  return 'other';
}
