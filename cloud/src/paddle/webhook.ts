import { json, problem } from '../http';
import type { Env } from '../env';
import { alertStmt } from '../ops';
import { notifyRelay } from '../relay/routes';
import type { Ctx } from '../router';
import type { PaddleApi } from './api';
import { type Effect, type PaddleEvent, paddleTime, planEvent } from './apply';
import { verifyPaddleSignature } from './signature';

/** What the webhook reaches outside the request; index.ts binds the real ones, tests swap in fakes. */
export type WebhookDeps = { paddle: (env: Env) => PaddleApi; db: (env: Env) => D1Database };

/** Paddle's webhook source IPs (developer.paddle.com, "Allow Paddle IP addresses"). */
export const PADDLE_IPS = {
  sandbox: ['34.194.127.46', '54.234.237.108', '3.208.120.145', '44.226.236.210', '44.241.183.62', '100.20.172.113'],
  production: ['34.232.58.13', '34.195.105.136', '34.237.3.244', '35.155.119.135', '52.11.166.252', '34.212.5.7'],
} as const;

export function paddleIpAllowed(env: Pick<Env, 'PADDLE_IP_CHECK' | 'PADDLE_ENV'>, ip: string | null): boolean {
  if (env.PADDLE_IP_CHECK !== '1') return true;
  const list: readonly string[] = PADDLE_IPS[env.PADDLE_ENV === 'production' ? 'production' : 'sandbox'];
  return ip !== null && list.includes(ip.trim());
}

/** Paddle events are a few KB; anything larger is refused before the HMAC and before any write. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

/** The body bytes, or `null` once more than `max` arrive (stops reading; `content-length` may be absent or lie). */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

async function sha256Hex16(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseEvent(raw: string): PaddleEvent | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const at = paddleTime(o.occurred_at);
  if (typeof o.event_id !== 'string' || !o.event_id || o.event_id.length > 128) return null;
  if (typeof o.event_type !== 'string' || !o.event_type || o.event_type.length > 64 || at === null) return null;
  return { event_id: o.event_id, event_type: o.event_type, occurred_at: at, data: o.data };
}

/**
 * A cancel is claimed first: `cancel_done_at` goes from NULL to `-claimedAt` in one conditional UPDATE, so of two
 * concurrent deliveries only one calls Paddle. Success writes `+doneAt`. A failure leaves the negative claim and an
 * alert; the Task 12 cron retries `full = 1 AND (cancel_done_at IS NULL OR cancel_done_at < 0)`.
 */
async function runEffects(c: Ctx, db: D1Database, paddle: PaddleApi, effects: Effect[]): Promise<void> {
  for (const e of effects) {
    if (e.kind === 'recheck') { notifyRelay(c, e.hostId, 'recheck'); continue; }
    try {
      const claim = await db.prepare('UPDATE refunds SET cancel_done_at = ? WHERE adjustment_id = ? AND cancel_done_at IS NULL').bind(-Date.now(), e.adjustmentId).run();
      if (claim.meta.changes !== 1) continue; // another delivery has it (or it is done)
      await paddle.cancelSubscription(e.subscriptionId);
      await db.prepare('UPDATE refunds SET cancel_done_at = ? WHERE adjustment_id = ?').bind(Date.now(), e.adjustmentId).run();
    } catch (err) {
      const why = err instanceof Error ? err.message.slice(0, 200) : 'error';
      try { await alertStmt(db, 'refund_cancel_failed', e.subscriptionId, `${e.adjustmentId}: ${why}`, Date.now()).run(); } catch { /* the console line is still there */ }
    }
  }
}

/**
 * `POST /v1/paddle/webhook` (app origin). Synchronous (D14): body ≤ 64 KB (413) → raw-body HMAC → IP list (optional) → parse →
 * `event_id` look-up → `planEvent` → one batch (changes + alerts + event row) → 200 `{outcome}`. Only a D1 error
 * is 500, and then nothing was written, so Paddle's retry starts over. Effects run after the commit.
 */
export async function paddleWebhook(c: Ctx, deps: WebhookDeps): Promise<Response> {
  const secret = c.env.PADDLE_WEBHOOK_SECRET ?? '';
  if (!secret) return problem(503, 'misconfigured');
  const declared = Number(c.req.headers.get('content-length') ?? '0');
  if (!(declared <= MAX_WEBHOOK_BYTES)) return problem(413, 'too_large'); // NaN fails too
  const bytes = await readCapped(c.req, MAX_WEBHOOK_BYTES); // the exact bytes Paddle signed — never re-serialize
  if (!bytes) return problem(413, 'too_large');
  if (!(await verifyPaddleSignature(c.req.headers.get('paddle-signature'), bytes, secret, Math.floor(Date.now() / 1000)))) return problem(401, 'bad_signature');
  if (!paddleIpAllowed(c.env, c.req.headers.get('cf-connecting-ip'))) return problem(403, 'forbidden');
  const db = deps.db(c.env);
  const now = c.nowMs;
  try {
    const raw = new TextDecoder().decode(bytes);
    const ev = parseEvent(raw);
    if (!ev) {
      // Signed but unusable: a retry would be the same bytes, so 200 and an alert instead of 500.
      await db.batch([alertStmt(db, 'bad_payload', await sha256Hex16(raw), 'unparseable or missing event_id/event_type/occurred_at', now)]);
      return json(200, { outcome: 'bad_payload' });
    }
    if (await db.prepare('SELECT outcome FROM paddle_events WHERE event_id = ?').bind(ev.event_id).first()) return json(200, { outcome: 'duplicate' });
    const p = await planEvent({ DB: db, CHECKOUT_SECRET: c.env.CHECKOUT_SECRET }, ev, now);
    const insertEvent = db.prepare('INSERT INTO paddle_events (event_id, event_type, occurred_at, received_at, outcome) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING')
      .bind(ev.event_id, ev.event_type, ev.occurred_at, now, p.outcome);
    await db.batch([...p.stmts, ...p.alerts, insertEvent]);
    if (p.effects.length > 0) c.exec.waitUntil(runEffects(c, db, deps.paddle(c.env), p.effects));
    return json(200, { outcome: p.outcome });
  } catch (e) {
    console.error(`paddle webhook: ${e instanceof Error ? e.name : 'error'}`);
    return problem(500, 'internal');
  }
}
