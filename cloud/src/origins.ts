import type { Env } from './env';

export type Side = 'app' | 'relay';

const hostOf = (origin: string): string | null => { try { return new URL(origin).host; } catch { return null; } };

/** Which origin a request came in on (by host name); `null` → 404. */
export function sideOf(req: Request, env: Env): Side | null {
  const host = new URL(req.url).host;
  if (host === hostOf(env.PUBLIC_ORIGIN)) return 'app';
  if (host === hostOf(env.RELAY_ORIGIN)) return 'relay';
  return null;
}

export const RELAY_CSP = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const APP_HTML_CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Every relay-origin response: no cookies ever, a CSP with no third-party origin. */
export function relayHeaders(h: Headers): void {
  h.delete('set-cookie');
  h.set('content-security-policy', RELAY_CSP);
  h.set('referrer-policy', 'no-referrer');
  h.set('cross-origin-opener-policy', 'same-origin');
}
