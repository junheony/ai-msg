import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkPollRes, LinkStartRes } from '../../src/shared/cloud/api-types';
import { sha256B64u, toB64u } from '../../src/shared/cloud/b64';
import { bearer, call, freshIp, linkHost, loginAs, post } from './helpers';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

const start = async (ip = freshIp()) =>
  (await (await post('/v1/host/link/start', { hostName: 'Test Mac', hostPub: toB64u(new Uint8Array(32)), uiVersion: '1.0.0' }, { 'cf-connecting-ip': ip })).json()) as LinkStartRes;

describe('host link (device code)', () => {
  it('device-code link: pending → approved → token once', async () => {
    const s = await start();
    expect(s.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(s.verifyUrl).toBe(`https://app.test/link?code=${s.userCode}`);
    expect(s).toMatchObject({ interval: 3, expiresIn: 600 });
    expect((await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).status).toBe(202);
    const cookie = await loginAs('u@example.test');
    expect((await post('/v1/host/link/approve', { userCode: s.userCode }, { cookie })).status).toBe(200);
    vi.advanceTimersByTime(3000);
    const p = (await (await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).json()) as LinkPollRes;
    expect(p).toMatchObject({ state: 'linked', email: 'u@example.test' });
    vi.advanceTimersByTime(3000);
    expect((await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).status).toBe(410);
    const hostToken = (p as { hostToken: string }).hostToken;
    const stored = await env.DB.prepare('SELECT token_hash FROM hosts WHERE id = ?').bind((p as { hostId: string }).hostId).first<{ token_hash: string }>();
    expect(stored!.token_hash).not.toContain(hostToken);
    expect(stored!.token_hash).toBe(await sha256B64u(hostToken));
  });

  it('the link page asks for sign-in, then shows the Mac and its key fingerprint', async () => {
    const s = await start();
    const anon = await call(`/link?code=${s.userCode}`);
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toBe(`/login?next=${encodeURIComponent(`/link?code=${s.userCode}`)}`);
    const cookie = await loginAs('page@example.test');
    const page = await call(`/link?code=${s.userCode}`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('Test Mac');
    expect(html).toContain('Link this Mac');
    expect(html).toMatch(/[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/);
  });

  it('polling faster than 2 s gets slow_down', async () => {
    const s = await start();
    expect((await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).status).toBe(202);
    const fast = await post('/v1/host/link/poll', { deviceCode: s.deviceCode });
    expect(fast.status).toBe(429);
    expect(await fast.json()).toMatchObject({ code: 'slow_down' });
    vi.advanceTimersByTime(2500);
    expect((await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).status).toBe(202);
  });

  it('an expired link code is 410', async () => {
    const s = await start();
    vi.advanceTimersByTime(601_000);
    expect((await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).status).toBe(410);
    const cookie = await loginAs('exp@example.test');
    expect((await post('/v1/host/link/approve', { userCode: s.userCode }, { cookie })).status).toBe(404);
  });

  it('rejects a bad uiVersion or hostPub', async () => {
    expect((await post('/v1/host/link/start', { hostName: 'M', hostPub: toB64u(new Uint8Array(32)), uiVersion: 'v1' }, { 'cf-connecting-ip': freshIp() })).status).toBe(400);
    expect((await post('/v1/host/link/start', { hostName: 'M', hostPub: 'short', uiVersion: '1.0.0' }, { 'cf-connecting-ip': freshIp() })).status).toBe(400);
  });

  it('trial once per normalized email, even across accounts', async () => {
    expect((await linkHost('t.r.i.a.l@gmail.com')).trial).toBe('granted');
    expect((await linkHost('trial+again@gmail.com')).trial).toBe('already_used');
    const trials = await env.DB.prepare('SELECT count(*) AS n FROM trials t JOIN users u ON u.id = t.user_id WHERE u.email IN (?, ?)').bind('t.r.i.a.l@gmail.com', 'trial+again@gmail.com').first('n');
    expect(trials).toBe(1);
  });

  it('trial at most 3 per IP per day', async () => {
    for (const n of [1, 2, 3]) expect((await linkHost(`ip${n}@example.test`, '203.0.113.9')).trial).toBe('granted');
    expect((await linkHost('ip4@example.test', '203.0.113.9')).trial).toBe('unavailable');
    vi.advanceTimersByTime(86_400_000);
    expect((await linkHost('ip5@example.test', '203.0.113.9')).trial).toBe('granted');
  });

  it('link/start and approve are rate limited', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await post('/v1/host/link/start', { hostName: 'M', hostPub: toB64u(new Uint8Array(32)), uiVersion: '1.0.0' }, { 'cf-connecting-ip': ip })).status).toBe(200);
    expect((await post('/v1/host/link/start', { hostName: 'M', hostPub: toB64u(new Uint8Array(32)), uiVersion: '1.0.0' }, { 'cf-connecting-ip': ip })).status).toBe(429);

    const cookie = await loginAs('ratel@example.test');
    for (let i = 0; i < 10; i++) expect((await post('/v1/host/link/approve', { userCode: 'AAAA-AAAA' }, { cookie, 'cf-connecting-ip': freshIp() })).status).toBe(404);
    expect((await post('/v1/host/link/approve', { userCode: 'AAAA-AAAA' }, { cookie, 'cf-connecting-ip': freshIp() })).status).toBe(429);
  });

  it('approve is also limited per IP across users', async () => {
    const ip = freshIp();
    for (let u = 0; u < 3; u++) {
      const cookie = await loginAs(`ipa${u}@example.test`);
      for (let i = 0; i < 7; i++) {
        const st = (await post('/v1/host/link/approve', { userCode: 'AAAA-AAAA' }, { cookie, 'cf-connecting-ip': ip })).status;
        expect(st).toBe(u * 7 + i < 20 ? 404 : 429);
      }
    }
  });

  it('the link page is rate limited per user (20/h) and per IP (40/h), wrong codes included', async () => {
    const s = await start();
    const cookie = await loginAs('peek@example.test');
    for (let i = 0; i < 20; i++) expect((await call('/link?code=ZZZZ-ZZZZ', { headers: { cookie } })).status).toBe(404);
    const limited = await call(`/link?code=${s.userCode}`, { headers: { cookie } });
    expect(limited.status).toBe(429);
    expect(await limited.text()).not.toContain('Test Mac');

    const ip = freshIp();
    for (let u = 0; u < 3; u++) {
      const c = await loginAs(`peekip${u}@example.test`);
      for (let i = 0; i < 15; i++) expect((await call('/link?code=ZZZZ-ZZZZ', { headers: { cookie: c, 'cf-connecting-ip': ip } })).status).toBe(u * 15 + i < 40 ? 404 : 429);
    }
  });

  it('two users approving the same code at once: one wins, only the winner can get the trial', async () => {
    const s = await start();
    const [ca, cb] = [await loginAs('racea@example.test'), await loginAs('raceb@example.test')];
    const rs = await Promise.all([ca, cb].map((cookie) => post('/v1/host/link/approve', { userCode: s.userCode }, { cookie })));
    const st = rs.map((r) => r.status).sort();
    expect(st[0]).toBe(200);
    expect([404, 409]).toContain(st[1]);
    const trials = await env.DB.prepare('SELECT count(*) AS n FROM trials t JOIN users u ON u.id = t.user_id WHERE u.email IN (?, ?)').bind('racea@example.test', 'raceb@example.test').first('n');
    expect(trials).toBe(1);
  });

  it('per-IP trial limit groups IPv6 by /64', async () => {
    for (const n of [1, 2, 3]) expect((await linkHost(`v6${n}@example.test`, `2001:db8:9:9::${n}`)).trial).toBe('granted');
    expect((await linkHost('v64@example.test', '2001:db8:9:9:ffff::1')).trial).toBe('unavailable');
    expect((await linkHost('v65@example.test', '2001:db8:9:a::1')).trial).toBe('granted');
  });

  it('MAX_HOSTS', async () => {
    for (let i = 0; i < 3; i++) await linkHost('many@example.test');
    const s = await start();
    const cookie = await loginAs('many@example.test');
    const r = await post('/v1/host/link/approve', { userCode: s.userCode }, { cookie });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'host_limit' });
  });

  it('unlink revokes the host token and every device', async () => {
    const h = await linkHost('unlink@example.test');
    expect((await call('/v1/devices', { headers: bearer(h.hostToken) })).status).toBe(200);
    expect((await post('/v1/host/unlink', {}, bearer(h.hostToken))).status).toBe(200);
    expect((await call('/v1/devices', { headers: bearer(h.hostToken) })).status).toBe(401);
  });
});
