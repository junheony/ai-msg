import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { EntitlementRes } from '../../src/shared/cloud/api-types';
import { RELAY, bearer, call, linkHost } from './helpers';

let seq = 0;
const email = () => `ent-${seq++}-${Math.random().toString(36).slice(2, 8)}@example.test`;
const userOf = async (hostId: string) => (await env.DB.prepare('SELECT user_id FROM hosts WHERE id = ?').bind(hostId).first<string>('user_id'))!;
const ent = (token: string, init: RequestInit = {}, origin?: string) => call('/v1/entitlement', { ...init, headers: { ...bearer(token), ...(init.headers as Record<string, string> | undefined) } }, origin);

describe('GET /v1/entitlement (display only)', () => {
  it('trial host → trial/trialing with the trial end, no-store', async () => {
    const h = await linkHost(email());
    expect(h.trial).toBe('granted');
    const before = Date.now();
    const r = await ent(h.hostToken);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = (await r.json()) as EntitlementRes;
    expect(b).toMatchObject({ plan: 'trial', st: 'trialing' });
    expect(b.untilMs).toBeGreaterThan(Date.now());
    expect(b.checkedAt).toBeGreaterThanOrEqual(before);
    expect(Object.keys(b).sort()).toEqual(['checkedAt', 'plan', 'st', 'untilMs']);
  });

  it('comp grant wins when its until is later', async () => {
    const h = await linkHost(email());
    const until = Date.now() + 400 * 86_400_000;
    await env.DB.prepare("INSERT INTO grants (user_id, plan, until) VALUES (?, 'comp', ?)").bind(await userOf(h.hostId), until).run();
    expect(await (await ent(h.hostToken)).json()).toMatchObject({ plan: 'comp', st: 'active', untilMs: until });
  });

  it('nothing → none / 0', async () => {
    const h = await linkHost(email());
    await env.DB.prepare('UPDATE trials SET ends_at = ? WHERE user_id = ?').bind(Date.now() - 1, await userOf(h.hostId)).run();
    expect(await (await ent(h.hostToken)).json()).toMatchObject({ plan: 'none', st: 'none', untilMs: 0 });
  });

  it('revoked or wrong token → 401; relay origin and other methods → 404', async () => {
    const h = await linkHost(email());
    expect((await call('/v1/entitlement')).status).toBe(401);
    expect((await ent('bogus')).status).toBe(401);
    expect((await ent(h.hostToken, {}, RELAY)).status).toBe(404);
    expect((await ent(h.hostToken, { method: 'POST' })).status).toBe(404);
    await env.DB.prepare('UPDATE hosts SET revoked_at = ? WHERE id = ?').bind(Date.now(), h.hostId).run();
    const r = await ent(h.hostToken);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('6 per minute per host, then 429', async () => {
    const h = await linkHost(email());
    // Start at a fresh minute window so the count cannot straddle two windows.
    const ms = 60_000 - (Date.now() % 60_000);
    if (ms < 3000) await new Promise((r) => setTimeout(r, ms + 50));
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await ent(h.hostToken)).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });
});
