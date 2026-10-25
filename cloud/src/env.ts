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
}
