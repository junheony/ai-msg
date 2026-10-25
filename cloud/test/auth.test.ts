import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, freshIp, lastMailTo, loginAs, post, tokenIn } from './helpers';

afterEach(() => { vi.useRealTimers(); });

const verify = (t: string) => post('/auth/verify', { t });

describe('magic link sign-in', () => {
  it('magic link: same answer for any email, single use, 15 minutes', async () => {
    const a = await post('/v1/auth/magic', { email: 'a@example.test' });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    const junk = await post('/v1/auth/magic', { email: 'not-an-email' });
    expect(junk.status).toBe(200);
    expect(await junk.json()).toEqual({ ok: true });

    const cookie = await loginAs('a@example.test');
    expect(cookie).toMatch(/^__Host-aimsg_web=/);

    await post('/v1/auth/magic', { email: 'once@example.test' });
    const t = tokenIn(await lastMailTo('once@example.test'));
    expect(await lastMailTo('once@example.test')).toContain(`https://app.test/auth/verify?t=${t}`);
    expect((await verify(t)).status).toBe(303);
    expect((await verify(t)).status).toBe(400); // used

    vi.useFakeTimers({ toFake: ['Date'] });
    await post('/v1/auth/magic', { email: 'late@example.test' });
    const late = tokenIn(await lastMailTo('late@example.test'));
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
    expect((await verify(late)).status).toBe(400); // expired
  });

  it('stores only the token hash and redirects to a same-origin next', async () => {
    await post('/v1/auth/magic', { email: 'next@example.test', next: '/link?code=ABCD-EFGH' });
    const t = tokenIn(await lastMailTo('next@example.test'));
    expect(await env.DB.prepare('SELECT count(*) AS n FROM magic_links WHERE token_hash = ?').bind(t).first('n')).toBe(0);
    const r = await verify(t);
    expect(r.headers.get('location')).toBe('/link?code=ABCD-EFGH');

    await post('/v1/auth/magic', { email: 'next@example.test', next: '//evil.test/x' });
    expect((await verify(tokenIn(await lastMailTo('next@example.test')))).headers.get('location')).toBe('/account');
  });

  it('GET /auth/verify does not consume the token (link scanners)', async () => {
    await post('/v1/auth/magic', { email: 'scan@example.test' });
    const t = tokenIn(await lastMailTo('scan@example.test'));
    const page = await call(`/auth/verify?t=${t}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Sign in');
    expect(html).toContain('method="post"');
    expect((await call(`/auth/verify?t=${t}`)).status).toBe(200);
    expect((await verify(t)).status).toBe(303);
  });

  it('the sign-in form posts urlencoded with the same Origin check', async () => {
    await post('/v1/auth/magic', { email: 'form@example.test' });
    const t = tokenIn(await lastMailTo('form@example.test'));
    const form = (origin: string) => call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: `t=${t}` });
    expect((await form('https://evil.test')).status).toBe(403);
    const ok = await form('https://app.test');
    expect(ok.status).toBe(303);
    expect(ok.headers.get('set-cookie')).toMatch(/^__Host-aimsg_web=/);
  });

  it('rate limits per normalized email', async () => {
    for (let i = 0; i < 6; i++) await post('/v1/auth/magic', { email: i % 2 ? 'r+x@example.test' : 'r@example.test' }, { 'cf-connecting-ip': freshIp() });
    const n = await env.DB.prepare("SELECT count(*) AS n FROM outbox WHERE to_addr LIKE 'r%@example.test'").first<{ n: number }>();
    expect(n!.n).toBe(5);
  });

  it('rate limits per IP (20 per hour), still answering 200', async () => {
    const ip = freshIp();
    for (let i = 0; i < 21; i++) {
      const r = await post('/v1/auth/magic', { email: `ipl${i}@example.test` }, { 'cf-connecting-ip': ip });
      expect(r.status).toBe(200);
    }
    const n = await env.DB.prepare("SELECT count(*) AS n FROM outbox WHERE to_addr LIKE 'ipl%'").first<{ n: number }>();
    expect(n!.n).toBe(20);
  });

  it('rejects cross-origin state changes', async () => {
    expect((await post('/auth/verify', { t: 'x' }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await post('/auth/verify', { t: 'x' }, { origin: null })).status).toBe(403);
  });

  it('a forged or unknown session cookie is not a session', async () => {
    const cookie = await loginAs('forge@example.test');
    const [name, value] = cookie.split('=') as [string, string];
    const [id] = value.split('.');
    const forged = `${name}=${id}.${'A'.repeat(43)}`;
    const r = await call('/link?code=AAAA-AAAA', { headers: { cookie: forged } });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(/^\/login\?next=/);
  });
});
