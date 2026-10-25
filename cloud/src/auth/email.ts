import { hmacB64u } from './tokens';

/**
 * The trial key's view of an address: trimmed, lower case, `+tag` dropped, Gmail dots dropped and
 * `googlemail.com` → `gmail.com`. `null` unless exactly one `@` with something on both sides, ≤ 254 chars.
 * Sign-in accounts use the address as typed (lower case); this is only for "one trial per person".
 */
export function normalizeEmail(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (s.length > 254) return null;
  const parts = s.split('@');
  if (parts.length !== 2) return null;
  let [local, domain] = parts as [string, string];
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

/** `HMAC-SHA256(secret, normalizeEmail(raw))` base64url; an unparseable address hashes as typed (lower case). */
export function emailKey(secret: string, raw: string): Promise<string> {
  return hmacB64u(secret, normalizeEmail(raw) ?? raw.trim().toLowerCase());
}

/** The sign-in address: trimmed, lower case, one `@`, ≤ 254 chars. */
export function accountEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(s) ? s : null;
}
