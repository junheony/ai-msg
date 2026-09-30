/** Review M5: what the UI sees of an engine failure — stderr capped, token-shaped strings removed. */
export const STDERR_MAX = 2048;
const DISPLAY_MAX = 2600;

const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]+/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:api[_-]?key|token|secret|password|passwd|authorization|cookie|deck_session)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b[0-9a-f]{40,}\b/gi,
  // long mixed-alphanumeric runs (keys); UUIDs are 36 chars with dashes and stay visible
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g,
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (m, g1: unknown) => (typeof g1 === 'string' && /[:=]\s*["']?$/.test(g1) ? `${g1}[redacted]` : /^(Bearer|Basic)\s/i.test(m) ? `${m.split(/\s+/)[0]} [redacted]` : '[redacted]'));
  }
  return out;
}

export function tailOf(s: string, max = STDERR_MAX): string {
  return s.length > max ? s.slice(-max) : s;
}

export function displayError(errorText: string | null, stderr: string | null): string | null {
  const parts = [errorText, stderr ? tailOf(stderr.trim()) : null].filter((x): x is string => !!x && x.length > 0);
  if (parts.length === 0) return null;
  const joined = redactSecrets(parts.join('\n'));
  return joined.length > DISPLAY_MAX ? joined.slice(0, DISPLAY_MAX) + '…' : joined;
}
