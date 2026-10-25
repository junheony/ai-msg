import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkStartRes, PairClaimRes, TicketRes } from '../../src/shared/cloud/api-types';
import type { Env } from '../src/env';
import worker, { ROUTES } from '../src/index';
import { APP, RELAY, bearer, call, claim, freshIp, lastMailTo, linkHost, loginAs, openWs, pairedDevice, post, pub, relayPost, tokenIn, waitFor } from './helpers';

/**
 * Task 11 security regressions for the Worker: origin separation over the whole route table, the relay origin's
 * cookie-free strict headers, the app origin's CSP / no-store / host-only cookie, Origin checks on every state-changing
 * web route, nothing secret in logs or in D1, the rate limits, and checkConfig closing the Worker.
 */

let seq = 0;
const email = () => `sec${seq++}@example.test`;
/** `:id` / `:doc` filled in so the pattern matches. */
const concrete = (pattern: string) => pattern.replace(/:doc\b/, 'terms').replace(/:[a-z]+/g, 'x');
const routes = (side: 'app' | 'relay') => ROUTES.filter((r) => r[0] === side).map(([, method, pattern]) => ({ method, path: concrete(pattern) }));
const OTHER: Record<'app' | 'relay', string> = { app: RELAY, relay: APP };

afterEach(() => { vi.restoreAllMocks(); });

describe('origin separation (D18)', () => {
  it('every route is 404 on the other origin and on an unknown host name', async () => {
    expect(ROUTES.length).toBeGreaterThan(30);
    const ROUTER_404 = await (await call('/no-such-route-anywhere')).text();
    for (const [side, method, pattern] of ROUTES) {
      const path = concrete(pattern);
      const init = method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json', origin: OTHER[side] }, body: '{}' };
      expect((await call(path, init, OTHER[side])).status, `${method} ${path} on the ${side === 'app' ? 'relay' : 'app'} origin`).toBe(404);
      const h = method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: '{}' };
      expect((await call(path, h, 'https://evil.test')).status, `${method} ${path} on an unknown host`).toBe(404);
      expect((await call(path, h, 'https://app.test.evil.test')).status, `${method} ${path} on a look-alike host`).toBe(404);
      // Control: on its own origin the route exists — whatever it answers, it is not the router's 404.
      const own = side === 'app' ? APP : RELAY;
      const mine = await call(path, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json', origin: own }, body: '{}' }, own);
      expect(mine.status === 404 ? await mine.text() : '', `${method} ${path} on its own origin`).not.toBe(ROUTER_404);
    }
  });
});

describe('relay origin', () => {
  it('never sets a cookie, names no third-party origin, allows no eval — with or without an app cookie on the request', async () => {
    const cookie = await loginAs(email());
    for (const { method, path } of routes('relay')) {
      const init = (extra: Record<string, string>) => (method === 'GET'
        ? { headers: { ...extra } }
        : { method, headers: { 'content-type': 'application/json', origin: RELAY, ...extra }, body: JSON.stringify({ pairingId: 'nope', claim: 'x', devicePub: pub(3), deviceName: 'P', mac: 'm' }) });
      const plain = await call(path, init({ 'cf-connecting-ip': freshIp() }), RELAY);
      const withCookie = await call(path, init({ cookie, 'cf-connecting-ip': freshIp() }), RELAY);
      for (const r of [plain, withCookie]) {
        expect(r.headers.get('set-cookie'), path).toBeNull();
        const csp = r.headers.get('content-security-policy') ?? '';
        expect(csp, path).toContain("script-src 'self'");
        expect(csp, path).not.toMatch(/https?:|\*|'unsafe-eval'|'unsafe-inline'|paddle/i);
        expect(r.headers.get('referrer-policy'), path).toBe('no-referrer');
      }
      // The cookie is not read: same answer either way.
      expect(withCookie.status, path).toBe(plain.status);
      expect(await withCookie.text(), path).toBe(await plain.text());
    }
  });
});

describe('app origin', () => {
  it('every HTML page has a CSP with frame-ancestors none; pages with personal data are no-store; Paddle only on /checkout', async () => {
    const cookie = await loginAs(email());
    await post('/v1/auth/magic', { email: 'page@example.test' });
    const t = tokenIn(await lastMailTo('page@example.test'));
    const pages: Array<[string, Record<string, string>]> = [
      ['/login', {}], [`/auth/verify?t=${t}`, {}], ['/link?code=NOPE-0000', { cookie }], ['/account', { cookie }], ['/checkout?plan=pro-monthly', { cookie }],
      ['/account/deleted', {}], ['/legal/terms', {}], ['/legal/privacy', {}], ['/legal/ko/refund', {}],
    ];
    for (const [path, headers] of pages) {
      const r = await call(path, { headers });
      expect(r.status, path).toBe(path.startsWith('/link') ? 404 : 200); // the "no such code" page: HTML all the same
      expect(r.headers.get('content-type'), path).toMatch(/^text\/html/);
      const csp = r.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("base-uri 'none'");
      expect(csp, path).not.toMatch(/'unsafe-eval'|'unsafe-inline'/);
      expect(/paddle\.com/.test(csp), `${path}: Paddle in the CSP`).toBe(path.startsWith('/checkout'));
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
      if (!path.startsWith('/legal/')) expect(r.headers.get('cache-control'), path).toBe('no-store');
      else expect(r.headers.get('cache-control'), path).toMatch(/^public/); // the same text for everyone, no cookie read
    }
    // The form POST pages and a 404 too.
    const sent = await call('/login', { method: 'POST', headers: { origin: APP, 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=form%40example.test' });
    expect(sent.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(sent.headers.get('cache-control')).toBe('no-store');
    expect((await call('/nothing-here')).headers.get('cache-control')).toBe('no-store');
  });

  it('every cookie set is host-only (__Host-, no Domain), HttpOnly, Secure', async () => {
    await post('/v1/auth/magic', { email: 'cookie@example.test' });
    const verify = await post('/auth/verify', { t: tokenIn(await lastMailTo('cookie@example.test')) });
    const cookie = verify.headers.get('set-cookie')!.split(';')[0]!;
    const out = await call('/logout', { method: 'POST', headers: { cookie, origin: APP, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    for (const sc of [verify.headers.get('set-cookie')!, out.headers.get('set-cookie')!]) {
      expect(sc).toMatch(/^__Host-aimsg_web=/);
      expect(sc.toLowerCase()).not.toContain('domain=');
      expect(sc).toContain('HttpOnly');
      expect(sc).toContain('Secure');
      expect(sc).toContain('Path=/');
    }
  });

  it('state-changing web routes refuse another origin (the relay origin included) and a missing Origin: 403', async () => {
    const { cookie, hostId } = await linkHost(email());
    const json = { 'content-type': 'application/json' };
    const targets: Array<[string, unknown]> = [
      ['/v1/host/link/approve', { userCode: 'ABCD-1234' }], ['/v1/billing/intent', { plan: 'pro-monthly' }], ['/v1/billing/intent/complete', {}],
      ['/v1/billing/portal', {}], ['/v1/account/delete', { confirm: 'DELETE' }], ['/v1/devices/x/revoke', {}], [`/v1/hosts/${hostId}/unlink`, {}],
    ];
    for (const [path, body] of targets) {
      for (const origin of ['https://evil.test', RELAY, 'null']) {
        const r = await call(path, { method: 'POST', headers: { ...json, cookie, origin }, body: JSON.stringify(body) });
        expect(r.status, `${path} from ${origin}`).toBe(403);
        expect(((await r.json()) as { code: string }).code).toBe('bad_origin');
      }
      expect((await call(path, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body) })).status, `${path} without Origin`).toBe(403);
    }
    for (const path of ['/logout', '/login']) {
      expect((await call(path, { method: 'POST', headers: { cookie, origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=x%40example.test' })).status, path).toBe(403);
    }
    // Still linked and still signed in: none of those went through.
    expect((await call('/account', { headers: { cookie } })).status).toBe(200);
    expect(await env.DB.prepare('SELECT revoked_at FROM hosts WHERE id = ?').bind(hostId).first('revoked_at')).toBeNull();
  });
});

describe('secrets stay out of logs and D1', () => {
  it('a full run (sign-in, link, pair, ticket, relay sockets, wrong tokens) logs no token, ticket, claim, auth header or email', async () => {
    const logged: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    const who = email();
    const secrets: string[] = [who];
    const s = (await (await post('/v1/host/link/start', { hostName: 'Sec Mac', hostPub: pub(9), uiVersion: '1.0.0' })).json()) as LinkStartRes;
    secrets.push(s.deviceCode);
    await post('/v1/auth/magic', { email: who });
    const magic = tokenIn(await lastMailTo(who));
    secrets.push(magic);
    const cookie = (await post('/auth/verify', { t: magic })).headers.get('set-cookie')!.split(';')[0]!;
    secrets.push(cookie.split('=')[1]!);
    await post('/v1/host/link/approve', { userCode: s.userCode }, { cookie });
    const linked = (await (await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).json()) as { hostId: string; hostToken: string };
    secrets.push(linked.hostToken);
    const c = await claim({ hostToken: linked.hostToken, secret: 'claim-secret-for-the-log-test' });
    secrets.push('claim-secret-for-the-log-test');
    const dev = (await c.res.json()) as PairClaimRes;
    secrets.push(dev.deviceToken);
    await post(`/v1/pair/${c.pairingId}/confirm`, {}, bearer(linked.hostToken));
    const ticket = ((await (await relayPost('/v1/relay/ticket', {}, bearer(dev.deviceToken))).json()) as TicketRes).ticket;
    secrets.push(ticket);
    const host = await openWs('/relay/host', bearer(linked.hostToken));
    const phone = await openWs(`/relay/device?ticket=${ticket}`, { origin: RELAY });
    expect([host.status, phone.status]).toEqual([101, 101]);
    phone.ws!.close(1000);
    host.ws!.close(1000);
    // Both sockets' open and close lines are in before anything is checked (a missing line fails here, not silently).
    await waitFor(() => logged.filter((l) => l.includes('"ev":"close"')).length >= 2, 3000);
    expect(logged.filter((l) => l.includes('"ev":"open"')).length).toBeGreaterThanOrEqual(2);
    // Wrong tokens are not echoed either.
    const wrong = `wrong-${'z'.repeat(40)}`;
    secrets.push(wrong);
    await call('/v1/devices', { headers: bearer(wrong) });
    await relayPost('/v1/relay/ticket', {}, bearer(wrong));
    await openWs(`/relay/device?ticket=${wrong}`);
    expect(secrets.every((x) => x.length >= 10)).toBe(true);
    const all = logged.join('\n');
    for (const x of [...secrets, 'Bearer ', 'authorization', '@example.test']) expect(all.includes(x), `log carries ${x.slice(0, 8)}…`).toBe(false);
  });

  it('D1 holds no plaintext token: every *_hash column is hash-shaped, no stored value equals a token handed out, email keys are not emails', async () => {
    const who = email();
    const { hostToken, cookie } = await linkHost(who);
    const handed: string[] = [hostToken, cookie.split('=')[1]!];
    const s = (await (await post('/v1/host/link/start', { hostName: 'Pending Mac', hostPub: pub(8), uiVersion: '1.0.0' })).json()) as LinkStartRes;
    handed.push(s.deviceCode);
    await post('/v1/auth/magic', { email: who });
    handed.push(tokenIn(await lastMailTo(who))); // unspent magic link
    const d = await pairedDevice({ hostToken });
    handed.push(d.deviceToken, d.body.claim);
    const r = await relayPost('/v1/relay/ticket', {}, bearer(d.deviceToken));
    handed.push(((await r.json()) as TicketRes).ticket); // unspent ticket

    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>()).results.map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['magic_links', 'web_sessions', 'host_links', 'hosts', 'devices', 'pairings', 'relay_tickets', 'trial_claims']));
    let hashCols = 0;
    // `outbox` is the log-mail stand-in (EMAIL_MODE=log, refused by checkConfig on a public origin): it holds the mail text on purpose.
    for (const t of tables.filter((n) => n !== 'outbox')) {
      const cols = (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((c) => c.name);
      const rows = (await env.DB.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>()).results;
      for (const col of cols) {
        if (col.endsWith('_hash')) hashCols++;
        for (const row of rows) {
          const v = row[col];
          if (typeof v !== 'string') continue;
          if (col.endsWith('_hash')) expect(v, `${t}.${col}`).toMatch(/^[A-Za-z0-9_-]{43}$/);
          if (col === 'email_key') expect(v, `${t}.${col}`).not.toContain('@');
          for (const tok of handed) expect(v.includes(tok), `${t}.${col} holds a token in plain text`).toBe(false);
        }
      }
    }
    expect(hashCols).toBeGreaterThanOrEqual(7);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM trial_claims').first('n')).toBeGreaterThan(0);
  });
});

describe('rate limits', () => {
  it('magic link: 5 mails per address per hour, whatever the IP', async () => {
    const who = email();
    for (let i = 0; i < 7; i++) expect((await post('/v1/auth/magic', { email: who })).status).toBe(200); // same answer: no enumeration
    expect(await env.DB.prepare('SELECT count(*) AS n FROM outbox WHERE to_addr = ?').bind(who).first('n')).toBe(5);
  });

  it('link/start: 10 per IP per hour', async () => {
    const ip = freshIp();
    const start = () => post('/v1/host/link/start', { hostName: 'M', hostPub: pub(4), uiVersion: '1.0.0' }, { 'cf-connecting-ip': ip });
    for (let i = 0; i < 10; i++) expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(429);
  });

  it('link/approve: 10 per user per hour, wrong codes included', async () => {
    const cookie = await loginAs(email());
    for (let i = 0; i < 10; i++) expect((await post('/v1/host/link/approve', { userCode: 'NOPE-0000' }, { cookie })).status).toBe(404);
    expect((await post('/v1/host/link/approve', { userCode: 'NOPE-0000' }, { cookie })).status).toBe(429);
  });

  it('pair claim: 10 per IP per minute', async () => {
    const ip = freshIp();
    const body = { pairingId: 'nope', claim: 'x', devicePub: pub(5), deviceName: 'P', mac: 'm' };
    for (let i = 0; i < 10; i++) expect((await relayPost('/v1/pair/claim', body, { 'cf-connecting-ip': ip })).status).not.toBe(429);
    expect((await relayPost('/v1/pair/claim', body, { 'cf-connecting-ip': ip })).status).toBe(429);
  });

  it('relay ticket: 10 per device per minute', async () => {
    const { hostToken } = await linkHost(email());
    const d = await pairedDevice({ hostToken });
    for (let i = 0; i < 10; i++) expect((await relayPost('/v1/relay/ticket', {}, bearer(d.deviceToken))).status).toBe(200);
    expect((await relayPost('/v1/relay/ticket', {}, bearer(d.deviceToken))).status).toBe(429);
  });

  it('account delete: 5 per user per hour (refused attempts included)', async () => {
    const cookie = await loginAs(email());
    for (let i = 0; i < 5; i++) expect((await post('/v1/account/delete', { confirm: 'nope' }, { cookie })).status).toBe(400);
    expect((await post('/v1/account/delete', { confirm: 'DELETE' }, { cookie })).status).toBe(429);
  });
});

describe('checkConfig closes the Worker', () => {
  const base = env as unknown as Env;
  const bad: Array<[string, Partial<Env>]> = [
    ['log mail on a public origin', { PUBLIC_ORIGIN: 'https://app.aimsg.app', RELAY_ORIGIN: 'https://relay.aimsg.app', EMAIL_MODE: 'log', DEV_ROUTES: '0' }],
    ['dev routes on a public origin', { PUBLIC_ORIGIN: 'https://app.aimsg.app', RELAY_ORIGIN: 'https://relay.aimsg.app', EMAIL_MODE: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: 'a <a@example.test>', DEV_ROUTES: '1' }],
    ['short session secret', { SESSION_SECRET: 'short' }],
    ['short email hash secret', { EMAIL_HASH_SECRET: 'e'.repeat(31) }],
    ['short checkout secret', { CHECKOUT_SECRET: 'k'.repeat(31) }],
    ['the same origin twice', { RELAY_ORIGIN: 'https://app.test' }],
  ];
  it.each(bad)('%s → every request 503 misconfigured, on both origins', async (_name, patch) => {
    const e = { ...base, ...patch } as Env;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [origin, path, method] of [[e.PUBLIC_ORIGIN, '/login', 'GET'], [e.PUBLIC_ORIGIN, '/v1/auth/magic', 'POST'], [e.RELAY_ORIGIN, '/v1/pair/claim', 'POST'], [e.PUBLIC_ORIGIN, '/legal/terms', 'GET']] as const) {
      const ctx = createExecutionContext();
      const r = await worker.fetch(new Request(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', origin }, ...(method === 'POST' ? { body: '{}' } : {}) }), e, ctx);
      await waitOnExecutionContext(ctx);
      expect(r.status, `${method} ${origin}${path}`).toBe(503);
      expect(((await r.json()) as { code: string }).code).toBe('misconfigured');
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    expect(errors.mock.calls.flat().join(' ')).toContain('misconfigured');
    // The secrets themselves never go to the log.
    expect(errors.mock.calls.flat().join(' ')).not.toContain(e.SESSION_SECRET);
  });
});
