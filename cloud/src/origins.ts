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

/** Paddle.js v2 is loaded only from here (developer.paddle.com, "Include and initialize Paddle.js"). */
export const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';
/** (미확인) The checkout overlay frame's origin per environment — Paddle documents no CSP list; check in the sandbox. */
const PADDLE_FRAME = { sandbox: 'https://sandbox-buy.paddle.com', production: 'https://buy.paddle.com' } as const;

/**
 * `/checkout` only (app origin): the one page that runs a third-party script. Every other app page keeps
 * `APP_HTML_CSP`, and the relay origin never names Paddle (D18).
 */
export function checkoutCsp(env: Pick<Env, 'PADDLE_ENV'>): string {
  const frame = PADDLE_FRAME[env.PADDLE_ENV === 'production' ? 'production' : 'sandbox'];
  return `default-src 'self'; script-src 'self' https://cdn.paddle.com; frame-src ${frame}; connect-src 'self' ${frame}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}

/** Every relay-origin response: no cookies ever, a CSP with no third-party origin. */
export function relayHeaders(h: Headers): void {
  h.delete('set-cookie');
  h.set('content-security-policy', RELAY_CSP);
  h.set('referrer-policy', 'no-referrer');
  h.set('cross-origin-opener-policy', 'same-origin');
}
