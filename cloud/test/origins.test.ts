import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { RELAY, call, post, relayPost, tokenIn } from './helpers';

describe('two origins (D18)', () => {
  it('app routes are 404 on the relay origin and vice versa', async () => {
    expect((await call('/login', {}, RELAY)).status).toBe(404);
    expect((await call('/checkout', {}, RELAY)).status).toBe(404);
    expect((await post('/v1/auth/magic', { email: 'a@example.test' }, {}, RELAY)).status).toBe(404);
    expect((await post('/v1/pair/claim', { pairingId: 'x' })).status).toBe(404);
    expect((await call('/login', {}, 'https://other.test')).status).toBe(404);
  });

  it('relay origin never sets cookies and sends a strict CSP', async () => {
    const r = await relayPost('/v1/pair/claim', { pairingId: 'nope', claim: 'x', devicePub: 'x', deviceName: 'x', mac: 'x' });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(r.headers.get('content-security-policy')).not.toMatch(/https?:\/\//);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const missing = await call('/nothing-here', {}, RELAY);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('the web session cookie is host-only', async () => {
    await post('/v1/auth/magic', { email: 'c@example.test' });
    const row = await env.DB.prepare('SELECT body FROM outbox ORDER BY id DESC LIMIT 1').first<{ body: string }>();
    const res = await post('/auth/verify', { t: tokenIn(row!.body) });
    const sc = res.headers.get('set-cookie')!;
    expect(sc).toMatch(/^__Host-aimsg_web=/);
    expect(sc.toLowerCase()).not.toContain('domain=');
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('Secure');
    expect(sc).toContain('SameSite=Lax');
  });

  it('app HTML gets its CSP and every response is no-store', async () => {
    const r = await call('/login');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toBe("default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).not.toMatch(/<script>|<script [^>]*>[^<]/);
  });

  it('dev outbox is open only with DEV_ROUTES=1 and log mail', async () => {
    await post('/v1/auth/magic', { email: 'outbox@example.test' });
    const r = await call('/dev/outbox?to=outbox@example.test');
    expect(r.status).toBe(200);
    expect(((await r.json()) as unknown[]).length).toBeGreaterThan(0);
    expect((await call('/dev/outbox?to=x', {}, RELAY)).status).toBe(404);
  });
});
