import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { checkConfig } from '../src/index';

describe('checkConfig', () => {
  const base = {
    PUBLIC_ORIGIN: 'https://app.aimsg.app', RELAY_ORIGIN: 'https://relay.aimsg.app', EMAIL_MODE: 'resend', EMAIL_FROM: 'AI msg <login@example.com>',
    RESEND_API_KEY: 'k', DEV_ROUTES: '0', SESSION_SECRET: 's'.repeat(32), EMAIL_HASH_SECRET: 'e'.repeat(32),
    MAX_HOSTS: '3', MAX_DEVICES: '3', TRIAL_DAYS: '7',
    CHECKOUT_SECRET: 'k'.repeat(32), PADDLE_ENV: 'production', PADDLE_IP_CHECK: '1',
  } as Env;

  it('refuses log email or dev routes on a public origin', () => {
    expect(checkConfig(base)).toEqual({ ok: true });
    expect(checkConfig({ ...base, EMAIL_MODE: 'log' })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, DEV_ROUTES: '1' })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, RESEND_API_KEY: undefined })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, RELAY_ORIGIN: base.PUBLIC_ORIGIN })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, PUBLIC_ORIGIN: 'http://localhost:8787', RELAY_ORIGIN: 'http://127.0.0.1:8787', EMAIL_MODE: 'log', RESEND_API_KEY: undefined })).toEqual({ ok: true });
  });

  it('refuses short secrets, plain http on a public host, a missing sender and junk origins', () => {
    expect(checkConfig({ ...base, SESSION_SECRET: 'short' })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, EMAIL_HASH_SECRET: 'e'.repeat(31) })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, CHECKOUT_SECRET: 'k'.repeat(31) })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, CHECKOUT_SECRET: undefined } as unknown as Env)).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, PADDLE_ENV: 'live' } as unknown as Env)).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, PADDLE_IP_CHECK: 'yes' } as unknown as Env)).toMatchObject({ ok: false });
    // Paddle's endpoint_secret_key format: pdl_ntfset_<26>_<32>. Unset is allowed (the webhook answers 503).
    expect(checkConfig({ ...base, PADDLE_WEBHOOK_SECRET: 'short' })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, PADDLE_WEBHOOK_SECRET: 'w'.repeat(70) })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, PADDLE_WEBHOOK_SECRET: `pdl_ntfset_${'a'.repeat(26)}_${'b'.repeat(32)}` })).toMatchObject({ ok: true });
    expect(checkConfig({ ...base, PADDLE_WEBHOOK_SECRET: undefined })).toMatchObject({ ok: true });
    expect(checkConfig({ ...base, RELAY_ORIGIN: 'http://relay.aimsg.app' })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, EMAIL_FROM: '' })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, PUBLIC_ORIGIN: 'not a url' })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, PUBLIC_ORIGIN: 'https://app.test', RELAY_ORIGIN: 'https://relay.test', EMAIL_MODE: 'log', DEV_ROUTES: '1' })).toEqual({ ok: true });
  });

  it('limits must be positive integers (NaN would lift them)', () => {
    const ok = { ...base, MAX_HOSTS: '3', MAX_DEVICES: '3', TRIAL_DAYS: '7' } as Env;
    expect(checkConfig(ok)).toEqual({ ok: true });
    for (const key of ['MAX_HOSTS', 'MAX_DEVICES', 'TRIAL_DAYS'] as const) {
      for (const bad of [undefined, '', 'x', '0', '-1', '1.5', '3abc']) expect(checkConfig({ ...ok, [key]: bad } as Env)).toMatchObject({ ok: false });
    }
  });
});
