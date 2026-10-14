import type { RateLimitSignal } from './Engine';

export type FailureKind = 'limit' | 'auth' | 'other';

/**
 * Spec §8: the exact text at a hard limit is unmeasured (claude-limit-probe
 * pending). Edit these arrays when a real capture arrives.
 *
 * Review M4: these run only on the SDK's own error text (result `errors[]`,
 * an is_error result, or the thrown SDK error message) — never on CLI stderr
 * or on model output — and are anchored on the phrasing the CLI/API use, so a
 * sentence that merely mentions "429" or "rate limit" does not match.
 */
export const LIMIT_PATTERNS: RegExp[] = [
  /\bAPI Error: 429\b/,
  /\brate_limit_error\b/,
  /\busage limit reached\b/i,
  /\bhit your (usage |session )?limit\b/i,
  /\bout of (extra )?usage\b/i,
  // Codex turn.failed / error events carry the API error as a JSON blob.
  /"status"\s*:\s*429\b/,
  /\busage_limit_reached\b/,
  /\brate_limit_exceeded\b/,
];

export const AUTH_PATTERNS: RegExp[] = [
  /\bAPI Error: 401\b/,
  /^Failed to authenticate\b/i,
  /\bOAuth (access )?token has (been )?(revoked|expired)\b/i,
  /\bnot logged in\b.*\/login/i,
  /\bplease run \/login\b/i,
];

export const COOLDOWN_MS: Record<FailureKind, number> = { limit: 60 * 60_000, auth: 6 * 60 * 60_000, other: 0 };

export function classifyFailure(r: {
  ok: boolean;
  errorText: string | null;
  errorKind: string | null;
  rateLimitStatus: RateLimitSignal['status'] | null;
}): FailureKind | null {
  if (r.ok) return null;
  if (r.errorKind === 'authentication_failed') return 'auth';
  if (r.errorKind === 'rate_limit' || r.rateLimitStatus === 'rejected') return 'limit';
  const text = r.errorText ?? '';
  if (LIMIT_PATTERNS.some((p) => p.test(text))) return 'limit';
  if (AUTH_PATTERNS.some((p) => p.test(text))) return 'auth';
  return 'other';
}

/** What the pane says for a limit/auth failure (follow-through failover notices). */
export function failureLabel(kind: 'limit' | 'auth'): string {
  return kind === 'limit' ? '사용 한도 도달' : '인증 실패';
}

/**
 * The reset time in the CLI's limit text ("resets 3:50am (Asia/Seoul)", "Resets at 3pm") as "03:50 리셋" (24-hour);
 * null when the text names none.
 */
export function limitResetHint(text: string | null): string | null {
  const t = resetClock(text);
  return t ? `${String(t.h).padStart(2, '0')}:${String(t.min).padStart(2, '0')} 리셋` : null;
}

/** The same reset time as the next local moment at or after `nowMs` (ms); null when the text names none. */
export function limitResetAtMs(text: string | null, nowMs: number): number | null {
  const t = resetClock(text);
  if (!t) return null;
  const d = new Date(nowMs);
  d.setHours(t.h, t.min, 0, 0);
  if (d.getTime() < nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function resetClock(text: string | null): { h: number; min: number } | null {
  const m = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text ?? '');
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const ampm = m[3]?.toLowerCase();
  if (!ampm && m[2] === undefined) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === 'pm' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return { h, min };
}
