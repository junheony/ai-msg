import { accountDelete, accountDeletedGet } from './account';
import { loginGet, loginPost, magicRequest, verifyGet, verifyPost } from './auth/magic';
import { billingIntent, billingIntentComplete, billingPortal } from './billing';
import { runCleanup } from './cleanup';
import { listDevices, revokeDevice } from './devices';
import { entitlement } from './entitlement';
import type { Env } from './env';
import { linkApprove, linkGet, linkPoll, linkStart, hostUnlink, hostUnlinkByUser } from './hosts';
import { HttpError, clientIp, json, problem } from './http';
import { APP_HTML_CSP, relayHeaders, sideOf } from './origins';
import { ACCOUNT_JS, accountGet, signOut } from './pages/account';
import { CHECKOUT_JS, checkoutGet } from './pages/checkout';
import { PAGES_CSS } from './pages/css';
import { legalEn, legalKo } from './pages/legal';
import { LINK_JS } from './pages/link';
import { paddleApi } from './paddle/api';
import { type WebhookDeps, paddleWebhook, webhookSecretProblem } from './paddle/webhook';
import { pairClaim, pairConfirm, pairReject, pairStart, pairStatus } from './pairing';
import { relayDevice, relayHost } from './relay/routes';
import { relayTicket } from './relay/tickets';
import { type Ctx, type Route, route } from './router';

export { RelayRoom } from './relay/RelayRoom';

export type ConfigCheck = { ok: true } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Refuses a deployment that would leak or misroute: log mail / dev routes off a local or `.test` origin,
 * short secrets (`CHECKOUT_SECRET` too), `resend` without a key or sender, equal origins, a non-https origin off localhost,
 * a `PADDLE_ENV`/`PADDLE_IP_CHECK` typo, a Paddle client token of the other environment, or a limit (`MAX_HOSTS`·`MAX_DEVICES`·`TRIAL_DAYS`) that is not a positive integer.
 */
export function checkConfig(env: Env): ConfigCheck {
  let pub: URL, relay: URL;
  try { pub = new URL(env.PUBLIC_ORIGIN); relay = new URL(env.RELAY_ORIGIN); } catch { return { ok: false, reason: 'PUBLIC_ORIGIN / RELAY_ORIGIN must be URLs' }; }
  for (const u of [pub, relay]) {
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return { ok: false, reason: `${u.origin} must be https` };
  }
  if (pub.origin === relay.origin) return { ok: false, reason: 'PUBLIC_ORIGIN and RELAY_ORIGIN must differ' };
  const testOrigin = LOCAL_HOSTS.has(pub.hostname) || pub.hostname.endsWith('.test');
  if ((env.EMAIL_MODE === 'log' || env.DEV_ROUTES === '1') && !testOrigin) return { ok: false, reason: 'EMAIL_MODE=log and DEV_ROUTES=1 are for local or .test origins only' };
  if (env.EMAIL_MODE !== 'log' && env.EMAIL_MODE !== 'resend') return { ok: false, reason: 'EMAIL_MODE must be log or resend' };
  if (env.EMAIL_MODE === 'resend' && !env.RESEND_API_KEY) return { ok: false, reason: 'RESEND_API_KEY is missing' };
  if (env.EMAIL_MODE === 'resend' && !env.EMAIL_FROM) return { ok: false, reason: 'EMAIL_FROM is missing' };
  if ((env.SESSION_SECRET ?? '').length < 32) return { ok: false, reason: 'SESSION_SECRET must be at least 32 characters' };
  if ((env.EMAIL_HASH_SECRET ?? '').length < 32) return { ok: false, reason: 'EMAIL_HASH_SECRET must be at least 32 characters' };
  if ((env.CHECKOUT_SECRET ?? '').length < 32) return { ok: false, reason: 'CHECKOUT_SECRET must be at least 32 characters' };
  if (env.PADDLE_ENV !== 'sandbox' && env.PADDLE_ENV !== 'production') return { ok: false, reason: 'PADDLE_ENV must be sandbox or production' };
  if (env.PADDLE_IP_CHECK !== '0' && env.PADDLE_IP_CHECK !== '1') return { ok: false, reason: 'PADDLE_IP_CHECK must be 0 or 1' };
  // A sandbox token on the live checkout (or the reverse) fails at the customer, so refuse it here.
  if (env.PADDLE_CLIENT_TOKEN && !env.PADDLE_CLIENT_TOKEN.startsWith(env.PADDLE_ENV === 'production' ? 'live_' : 'test_')) return { ok: false, reason: 'PADDLE_CLIENT_TOKEN must match PADDLE_ENV (live_ / test_)' };
  // `Number('x')` is NaN and `count >= NaN` is false — a typo would silently lift the limit.
  for (const key of ['MAX_HOSTS', 'MAX_DEVICES', 'TRIAL_DAYS'] as const) {
    if (!/^[1-9]\d{0,5}$/.test(env[key] ?? '')) return { ok: false, reason: `${key} must be a positive integer` };
  }
  return { ok: true };
}

/** Workers have no "failed to boot": the check runs once per env object and every request reuses it. */
const checked = new WeakMap<Env, ConfigCheck>();
function cachedCheck(env: Env): ConfigCheck {
  let r = checked.get(env);
  if (!r) {
    r = checkConfig(env);
    if (!r.ok) console.error(`misconfigured: ${r.reason}`);
    // Never the whole Worker: a missing/short secret closes only the webhook route (webhook.ts).
    if (webhookSecretProblem(env.PADDLE_WEBHOOK_SECRET) === 'prefix') console.warn('PADDLE_WEBHOOK_SECRET does not start with pdl_ntfset_ (Paddle format)');
    checked.set(env, r);
  }
  return r;
}

/** `GET /dev/outbox?to=` — local e2e only (DEV_ROUTES=1 and log mail). */
async function devOutbox(c: Ctx): Promise<Response> {
  if (c.env.DEV_ROUTES !== '1' || c.env.EMAIL_MODE !== 'log') return problem(404, 'not_found');
  const rows = await c.env.DB.prepare('SELECT subject, body, created_at FROM outbox WHERE to_addr = ? ORDER BY id DESC LIMIT 20')
    .bind((c.url.searchParams.get('to') ?? '').toLowerCase()).all<{ subject: string; body: string; created_at: number }>();
  return json(200, rows.results.map((r) => ({ subject: r.subject, text: r.body, createdAt: r.created_at })));
}

/** Outside-world dependencies of the Paddle webhook. Tests replace these fields (same isolate) and restore them. */
export const deps: WebhookDeps = { paddle: (env) => paddleApi(env), db: (env) => env.DB };

/** The app pages' static files, served from the bundle (this Worker has no `assets` binding). Only these names. */
const asset = (body: string, type: string) => async () => new Response(body, { headers: { 'content-type': `${type}; charset=utf-8` } });
const JS = 'text/javascript';

const ROUTES: readonly Route[] = [
  // app origin — pages
  ['app', 'GET', '/login', loginGet],
  ['app', 'POST', '/login', loginPost],
  ['app', 'GET', '/auth/verify', verifyGet],
  ['app', 'POST', '/auth/verify', verifyPost],
  ['app', 'GET', '/link', linkGet],
  ['app', 'GET', '/account', accountGet],
  ['app', 'POST', '/logout', signOut],
  ['app', 'GET', '/checkout', checkoutGet],
  ['app', 'GET', '/account/deleted', accountDeletedGet],
  ['app', 'GET', '/legal/ko/:doc', legalKo],
  ['app', 'GET', '/legal/:doc', legalEn],
  ['app', 'GET', '/static/link.js', asset(LINK_JS, JS)],
  ['app', 'GET', '/static/account.js', asset(ACCOUNT_JS, JS)],
  ['app', 'GET', '/static/checkout.js', asset(CHECKOUT_JS, JS)],
  ['app', 'GET', '/static/pages.css', asset(PAGES_CSS, 'text/css')],
  // app origin — API
  ['app', 'POST', '/v1/auth/magic', magicRequest],
  ['app', 'POST', '/v1/host/link/start', linkStart],
  ['app', 'POST', '/v1/host/link/approve', linkApprove],
  ['app', 'POST', '/v1/host/link/poll', linkPoll],
  ['app', 'POST', '/v1/host/unlink', hostUnlink],
  ['app', 'POST', '/v1/hosts/:id/unlink', hostUnlinkByUser],
  ['app', 'POST', '/v1/pair/start', pairStart],
  ['app', 'GET', '/v1/pair/:id', pairStatus],
  ['app', 'POST', '/v1/pair/:id/confirm', pairConfirm],
  ['app', 'POST', '/v1/pair/:id/reject', pairReject],
  ['app', 'GET', '/v1/devices', listDevices],
  ['app', 'POST', '/v1/devices/:id/revoke', revokeDevice],
  ['app', 'GET', '/v1/entitlement', entitlement],
  ['app', 'POST', '/v1/billing/intent', billingIntent],
  ['app', 'POST', '/v1/billing/intent/complete', billingIntentComplete],
  ['app', 'POST', '/v1/billing/portal', billingPortal(deps)],
  ['app', 'POST', '/v1/account/delete', accountDelete],
  ['app', 'POST', '/v1/paddle/webhook', (c) => paddleWebhook(c, deps)],
  ['app', 'GET', '/dev/outbox', devOutbox],
  // relay origin — no cookies are read or set here
  ['relay', 'POST', '/v1/pair/claim', pairClaim],
  ['relay', 'POST', '/v1/relay/ticket', relayTicket],
  ['relay', 'GET', '/relay/host', relayHost],
  ['relay', 'GET', '/relay/device', relayDevice],
];

async function dispatch(req: Request, env: Env, exec: ExecutionContext): Promise<{ res: Response; side: 'app' | 'relay' | null }> {
  const side = sideOf(req, env);
  if (!side) return { res: problem(404, 'not_found'), side };
  const url = new URL(req.url);
  const hitRoute = route(ROUTES, side, req.method, url.pathname);
  if (hitRoute === null) return { res: problem(404, 'not_found'), side };
  const c: Ctx = { req, env, exec, url, params: hitRoute.params, nowMs: Date.now(), ip: clientIp(req) };
  try {
    return { res: await hitRoute.handler(c), side };
  } catch (e) {
    if (e instanceof HttpError) return { res: problem(e.status, e.code), side };
    console.error(`unhandled ${req.method} ${url.pathname}: ${e instanceof Error ? e.name : 'error'}`);
    return { res: problem(500, 'internal'), side };
  }
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const cfg = cachedCheck(env);
    const { res, side } = cfg.ok ? await dispatch(req, env, exec) : { res: problem(503, 'misconfigured'), side: null };
    if (res.status === 101) return res; // the relay room's WebSocket: rebuilding the Response would drop it
    const out = new Response(req.method === 'HEAD' ? null : res.body, { status: res.status, headers: new Headers(res.headers) });
    // Only the legal pages bring their own (public, an hour); everything else is never cached.
    if (!out.headers.has('cache-control')) out.headers.set('cache-control', 'no-store');
    out.headers.set('x-content-type-options', 'nosniff');
    if (side === 'relay') relayHeaders(out.headers);
    else {
      out.headers.set('referrer-policy', 'same-origin'); // see pages/layout.ts — `no-referrer` would make form POSTs `Origin: null`
      // A page may bring its own policy (only /checkout does, for Paddle.js); every other HTML page gets the strict one.
      if ((out.headers.get('content-type') ?? '').startsWith('text/html') && !out.headers.has('content-security-policy')) out.headers.set('content-security-policy', APP_HTML_CSP);
    }
    return out;
  },

  /** The daily cron (wrangler.jsonc `17 3 * * *`): expired rows, refund cancel retries, stale-link/-subscription alerts. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCleanup(env, Date.now(), { paddle: deps.paddle(env) }));
  },
} satisfies ExportedHandler<Env>;
