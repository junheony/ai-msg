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
  /** Paddle API key (`subscription.write`; Task 10 adds `customer_portal_session.write`). */
  PADDLE_API_KEY?: string;
  /** Signs the checkout `customData.ref` (userRef). At least 32 characters (checkConfig). */
  CHECKOUT_SECRET: string;
}
