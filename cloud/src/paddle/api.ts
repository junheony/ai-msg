import type { Env } from '../env';

/** The Paddle Billing API calls the Worker makes. Tests inject a fake (`deps.paddle` in index.ts). */
export interface PaddleApi {
  /** Cancels at once (full refund or chargeback, D15). Throws on a non-2xx answer (the error carries `status`). */
  cancelSubscription(id: string): Promise<void>;
  /** A fresh customer portal link (`urls.general.overview`). Throws on a non-2xx answer or a missing / non-https link. */
  portalSession(customerId: string, subscriptionIds: string[]): Promise<{ url: string }>;
}

/** Base URLs (developer.paddle.com, "Authentication"): sandbox keys work only on the sandbox host, live keys only on live. */
export const PADDLE_API_BASE = { sandbox: 'https://sandbox-api.paddle.com', production: 'https://api.paddle.com' } as const;

/**
 * `POST /subscriptions/{id}/cancel` with `{effective_from: 'immediately'}` (key permission `subscription.write`), and
 * `POST /customers/{id}/portal-sessions` with `{subscription_ids?}` ≤ 25 (permission `customer_portal_session.write`;
 * 201 `data.urls.general.overview` + `data.urls.subscriptions[]`, links carry a temporary token — never cache them).
 * Both with `Authorization: Bearer <PADDLE_API_KEY>`.
 */
export const paddleApi = (env: Pick<Env, 'PADDLE_ENV' | 'PADDLE_API_KEY'>, fetchFn: typeof fetch = fetch): PaddleApi => {
  const base = PADDLE_API_BASE[env.PADDLE_ENV === 'production' ? 'production' : 'sandbox'];
  const postJson = (path: string, body: unknown) => fetchFn(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.PADDLE_API_KEY ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    async cancelSubscription(id) {
      const r = await postJson(`/subscriptions/${encodeURIComponent(id)}/cancel`, { effective_from: 'immediately' });
      await r.body?.cancel();
      if (!r.ok) throw Object.assign(new Error(`paddle cancel ${r.status}`), { status: r.status });
    },
    async portalSession(customerId, subscriptionIds) {
      const ids = subscriptionIds.slice(0, 25);
      const r = await postJson(`/customers/${encodeURIComponent(customerId)}/portal-sessions`, ids.length ? { subscription_ids: ids } : {});
      if (!r.ok) { await r.body?.cancel(); throw new Error(`paddle portal ${r.status}`); }
      const body = (await r.json().catch(() => null)) as { data?: { urls?: { general?: { overview?: unknown } } } } | null;
      const url = body?.data?.urls?.general?.overview;
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('paddle portal: no overview link');
      return { url };
    },
  };
};
