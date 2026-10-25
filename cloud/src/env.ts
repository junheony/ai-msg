/** Bindings, secrets and vars of the cloud Worker. Later Tasks extend it. */
export interface Env {
  DB: D1Database;
  /** RelayRoom Durable Object namespace (one room per host, `idFromName(hostId)`). */
  RELAY: DurableObjectNamespace;
  /** Phone UI bundles (Task 5c). */
  UI: R2Bucket;
  PUBLIC_ORIGIN: string;
  RELAY_ORIGIN: string;
  EMAIL_MODE: 'log' | 'resend';
  EMAIL_FROM: string;
  RESEND_API_KEY?: string;
  SESSION_SECRET: string;
  EMAIL_HASH_SECRET: string;
  DEV_ROUTES: '0' | '1';
  MAX_DEVICES: string;
  MAX_HOSTS: string;
  TRIAL_DAYS: string;
  /** Paddle notification destination secret (webhook HMAC). Empty → the webhook answers 503. */
  PADDLE_WEBHOOK_SECRET?: string;
  /** Picks the Paddle API host and the webhook source IP list. */
  PADDLE_ENV: 'sandbox' | 'production';
  /** `1` → webhooks only from Paddle's published IPs (`CF-Connecting-IP`). */
  PADDLE_IP_CHECK: '0' | '1';
  /** Paddle API key: `subscription.write` (Task 9) and `customer_portal_session.write` (Task 10). */
  PADDLE_API_KEY?: string;
  /** Signs the checkout `customData.ref` (userRef). At least 32 characters (checkConfig). */
  CHECKOUT_SECRET: string;
  /** Paddle.js client-side token (public; `test_` sandbox, `live_` production — checkConfig). Empty → /checkout answers 503. */
  PADDLE_CLIENT_TOKEN?: string;
  /** Paddle price ids (`pri_…`) of the two plans. Empty → /checkout answers 503. */
  PADDLE_PRICE_MONTHLY?: string;
  PADDLE_PRICE_YEARLY?: string;
  /** Optional discount code prefilled at checkout (founding offer). */
  PADDLE_DISCOUNT_FOUNDING?: string;
}
