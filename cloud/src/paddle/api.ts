import type { Env } from '../env';

/** The Paddle Billing API calls the Worker makes. Tests inject a fake (`deps.paddle` in index.ts). */
export interface PaddleApi {
  /** Cancels at once (full refund or chargeback, D15). Throws on a non-2xx answer. */
  cancelSubscription(id: string): Promise<void>;
  /** Task 10. */
  portalSession(customerId: string, subscriptionIds: string[]): Promise<{ url: string }>;
}

/** Base URLs (developer.paddle.com, "Authentication"): sandbox keys work only on the sandbox host, live keys only on live. */
export const PADDLE_API_BASE = { sandbox: 'https://sandbox-api.paddle.com', production: 'https://api.paddle.com' } as const;

/**
 * `POST /subscriptions/{id}/cancel` with `{effective_from: 'immediately'}`, `Authorization: Bearer <PADDLE_API_KEY>`.
 * The key needs the `subscription.write` permission.
 */
export const paddleApi = (env: Pick<Env, 'PADDLE_ENV' | 'PADDLE_API_KEY'>, fetchFn: typeof fetch = fetch): PaddleApi => ({
  async cancelSubscription(id) {
    const base = PADDLE_API_BASE[env.PADDLE_ENV === 'production' ? 'production' : 'sandbox'];
    const r = await fetchFn(`${base}/subscriptions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.PADDLE_API_KEY ?? ''}`, 'content-type': 'application/json' },
      body: JSON.stringify({ effective_from: 'immediately' }),
    });
    await r.body?.cancel();
    if (!r.ok) throw new Error(`paddle cancel ${r.status}`);
  },
  async portalSession() {
    throw new Error('portalSession: Task 10');
  },
});
