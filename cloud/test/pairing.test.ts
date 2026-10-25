import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, PairClaimRes, PairStatusRes } from '../../src/shared/cloud/api-types';
import { bearer, call, claim, freshIp, getJson, linkHost, loginAs, post, pub, relayPost, startPairing } from './helpers';

afterEach(() => { vi.useRealTimers(); });

const status = (id: string, token: string) => getJson<PairStatusRes>(`/v1/pair/${id}`, token);
const confirm = (id: string, token: string) => post(`/v1/pair/${id}/confirm`, {}, bearer(token));
const ticket = (deviceToken: string) => relayPost('/v1/relay/ticket', {}, bearer(deviceToken));

describe('QR pairing', () => {
  it('claim works only on the relay origin with the right secret; device limit 3', async () => {
    const h = await linkHost('limit@example.test');
    const id = await startPairing(h.hostToken);
    const body = { pairingId: id, claim: 'claim-secret', devicePub: pub(2), deviceName: 'Phone', mac: 'm' };
    expect((await post('/v1/pair/claim', body)).status).toBe(404); // app origin
    expect((await relayPost('/v1/pair/claim', body, { origin: 'https://app.test' })).status).toBe(403);
    expect((await relayPost('/v1/pair/claim', body, { origin: null })).status).toBe(403);
    expect((await relayPost('/v1/pair/claim', { ...body, devicePub: 'short' })).status).toBe(400);
    const ok = await relayPost('/v1/pair/claim', body);
    expect(ok.status).toBe(200);
    const res = (await ok.json()) as PairClaimRes;
    expect(res.hostId).toBe(h.hostId);
    const stored = await env.DB.prepare('SELECT token_hash, state FROM devices WHERE id = ?').bind(res.deviceId).first<{ token_hash: string; state: string }>();
    expect(stored!.state).toBe('claimed');
    expect(stored!.token_hash).not.toBe(res.deviceToken);

    for (const fill of [4, 5]) expect((await claim({ hostToken: h.hostToken, devicePub: pub(fill) })).res.status).toBe(200);
    const fourth = await claim({ hostToken: h.hostToken, devicePub: pub(6) });
    expect(fourth.res.status).toBe(409);
    expect(await fourth.res.json()).toMatchObject({ code: 'device_limit' });
  });

  it('claims are rate limited per IP (10 per minute)', async () => {
    const h = await linkHost('crate@example.test');
    const id = await startPairing(h.hostToken);
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await relayPost('/v1/pair/claim', { pairingId: 'missing', claim: 'x', devicePub: pub(2), deviceName: 'P', mac: 'm' }, { 'cf-connecting-ip': ip })).status).toBe(404);
    expect((await relayPost('/v1/pair/claim', { pairingId: id, claim: 'claim-secret', devicePub: pub(2), deviceName: 'P', mac: 'm' }, { 'cf-connecting-ip': ip })).status).toBe(429);
  });

  it('wrong secret 5 times expires the pairing', async () => {
    const h = await linkHost('wrong@example.test');
    const id = await startPairing(h.hostToken);
    for (let i = 0; i < 5; i++) {
      const r = await relayPost('/v1/pair/claim', { pairingId: id, claim: `nope${i}`, devicePub: pub(2), deviceName: 'P', mac: 'm' }, { 'cf-connecting-ip': freshIp() });
      expect(r.status).toBe(403);
    }
    expect((await status(id, h.hostToken)).body.state).toBe('expired');
    expect((await relayPost('/v1/pair/claim', { pairingId: id, claim: 'claim-secret', devicePub: pub(2), deviceName: 'P', mac: 'm' })).status).toBe(410);
  });

  it('a pairing lives 5 minutes and a host has at most 3 open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = await linkHost('open@example.test');
    const first = await startPairing(h.hostToken);
    await startPairing(h.hostToken); await startPairing(h.hostToken);
    const fourth = await post('/v1/pair/start', { claimHash: 'A'.repeat(43) }, bearer(h.hostToken));
    expect(fourth.status).toBe(429);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect((await status(first, h.hostToken)).body.state).toBe('expired');
    expect((await relayPost('/v1/pair/claim', { pairingId: first, claim: 'claim-secret', devicePub: pub(2), deviceName: 'P', mac: 'm' })).status).toBe(410);
    expect((await post('/v1/pair/start', { claimHash: 'A'.repeat(43) }, bearer(h.hostToken))).status).toBe(200);
  });

  it('a second correct claim burns the pairing and revokes every device it made', async () => {
    const h = await linkHost('burn@example.test');
    const first = await claim({ hostToken: h.hostToken });
    expect(first.res.status).toBe(200);
    const again = await relayPost('/v1/pair/claim', { pairingId: first.pairingId, claim: 'claim-secret', devicePub: pub(3), deviceName: 'Thief', mac: 'm' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'pairing_burned' });
    const rows = await env.DB.prepare('SELECT state FROM devices WHERE pairing_id = ?').bind(first.pairingId).all<{ state: string }>();
    expect(rows.results.length).toBe(1);
    expect(rows.results.every((r) => r.state === 'revoked')).toBe(true);
    expect((await status(first.pairingId, h.hostToken)).body.state).toBe('burned');
    expect((await confirm(first.pairingId, h.hostToken)).status).toBe(409);
  });

  it('a second correct claim after confirm also burns and revokes the active device', async () => {
    const h = await linkHost('burn2@example.test');
    const first = await claim({ hostToken: h.hostToken });
    const dev = (await first.res.json()) as PairClaimRes;
    expect((await confirm(first.pairingId, h.hostToken)).status).toBe(200);
    const again = await relayPost('/v1/pair/claim', { ...first.body, devicePub: pub(3) });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'pairing_burned' });
    expect((await ticket(dev.deviceToken)).status).toBe(401);
  });

  it('the same phone resending the same claim (lost response) gets the same deviceId and a fresh token, not a burn', async () => {
    const h = await linkHost('resend@example.test');
    const first = await claim({ hostToken: h.hostToken });
    const a = (await first.res.json()) as PairClaimRes;
    const again = await relayPost('/v1/pair/claim', first.body);
    expect(again.status).toBe(200);
    const b = (await again.json()) as PairClaimRes;
    expect(b.deviceId).toBe(a.deviceId);
    expect(b.deviceToken).not.toBe(a.deviceToken);
    expect((await status(first.pairingId, h.hostToken)).body.state).toBe('claimed');
    expect((await ticket(a.deviceToken)).status).toBe(401); // old token gone
    const pending = await ticket(b.deviceToken);
    expect(pending.status).toBe(403);
    expect(await pending.json()).toMatchObject({ code: 'pending_confirm' });
    expect((await confirm(first.pairingId, h.hostToken)).status).toBe(200);
    const late = await relayPost('/v1/pair/claim', first.body);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: 'already_paired' });
    expect((await status(first.pairingId, h.hostToken)).body.state).toBe('confirmed');
  });

  it('cookie routes need Origin === PUBLIC_ORIGIN and JSON; Bearer routes ignore cookies', async () => {
    const cookie = await loginAs('c@example.test');
    expect((await post('/v1/host/link/approve', { userCode: 'AAAA-AAAA' }, { cookie, origin: 'https://evil.test' })).status).toBe(403);
    expect((await post('/v1/host/link/approve', { userCode: 'AAAA-AAAA' }, { cookie, origin: null })).status).toBe(403);
    const form = await call('/v1/host/link/approve', { method: 'POST', headers: { cookie, origin: 'https://app.test', 'content-type': 'application/x-www-form-urlencoded' }, body: 'userCode=AAAA-AAAA' });
    expect(form.status).toBe(415);
    expect((await post('/v1/host/link/approve', { userCode: 'AAAA-AAAA' })).status).toBe(401); // no session
    expect((await post('/v1/pair/start', { claimHash: 'x' }, { cookie })).status).toBe(401);
    expect((await call('/v1/devices', { headers: { cookie } })).status).toBe(401);
  });

  it('host sees devicePub+mac, confirm activates only from claimed, reject revokes', async () => {
    const h = await linkHost('flow@example.test');
    const open = await startPairing(h.hostToken);
    expect((await status(open, h.hostToken)).body).toEqual({ state: 'open' });
    expect((await confirm(open, h.hostToken)).status).toBe(409);

    const c = await claim({ hostToken: h.hostToken, devicePub: pub(7) });
    const dev = (await c.res.json()) as PairClaimRes;
    const st = await status(c.pairingId, h.hostToken);
    expect(st.body).toEqual({ state: 'claimed', deviceId: dev.deviceId, devicePub: pub(7), deviceName: 'Phone', mac: 'm' });
    expect(((await getJson<DeviceInfo[]>('/v1/devices', h.hostToken)).body)).toEqual([]);
    expect((await confirm(c.pairingId, h.hostToken)).status).toBe(200);
    expect((await confirm(c.pairingId, h.hostToken)).status).toBe(409);
    const list = (await getJson<DeviceInfo[]>('/v1/devices', h.hostToken)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: dev.deviceId, name: 'Phone', pub: pub(7), lastSeen: null });
    expect(typeof list[0]!.addedAt).toBe('number');
    expect((await ticket(dev.deviceToken)).status).not.toBe(401);

    const r = await claim({ hostToken: h.hostToken, secret: 'other', devicePub: pub(8) });
    const rdev = (await r.res.json()) as PairClaimRes;
    expect((await post(`/v1/pair/${r.pairingId}/reject`, {}, bearer(h.hostToken))).status).toBe(200);
    expect((await status(r.pairingId, h.hostToken)).body.state).toBe('rejected');
    expect((await ticket(rdev.deviceToken)).status).toBe(401);
    expect((await confirm(r.pairingId, h.hostToken)).status).toBe(409);
  });

  it('a host cannot read another host’s pairing', async () => {
    const a = await linkHost('hosta@example.test');
    const b = await linkHost('hostb@example.test');
    const id = await startPairing(a.hostToken);
    expect((await status(id, b.hostToken)).status).toBe(404);
    expect((await confirm(id, b.hostToken)).status).toBe(404);
    expect((await post(`/v1/pair/${id}/reject`, {}, bearer(b.hostToken))).status).toBe(404);
  });
});

describe('device API', () => {
  async function activeDevice(email: string) {
    const h = await linkHost(email);
    const c = await claim({ hostToken: h.hostToken, devicePub: pub(9) });
    const dev = (await c.res.json()) as PairClaimRes;
    await confirm(c.pairingId, h.hostToken);
    return { h, dev };
  }

  it('the host revokes its own device with its Bearer token', async () => {
    const { h, dev } = await activeDevice('rev1@example.test');
    const other = await linkHost('rev1other@example.test');
    expect((await post(`/v1/devices/${dev.deviceId}/revoke`, {}, bearer(other.hostToken))).status).toBe(404);
    expect((await post(`/v1/devices/${dev.deviceId}/revoke`, {}, bearer('bogus'))).status).toBe(401);
    expect((await post(`/v1/devices/${dev.deviceId}/revoke`, {}, bearer(h.hostToken))).status).toBe(200);
    expect((await getJson<DeviceInfo[]>('/v1/devices', h.hostToken)).body).toEqual([]);
    expect((await ticket(dev.deviceToken)).status).toBe(401);
  });

  it('the account page revokes with the web session and an Origin check', async () => {
    const { h, dev } = await activeDevice('rev2@example.test');
    expect((await post(`/v1/devices/${dev.deviceId}/revoke`, {}, { cookie: h.cookie, origin: 'https://evil.test' })).status).toBe(403);
    const stranger = await loginAs('rev2stranger@example.test');
    expect((await post(`/v1/devices/${dev.deviceId}/revoke`, {}, { cookie: stranger })).status).toBe(404);
    expect((await post(`/v1/devices/${dev.deviceId}/revoke`, {}, { cookie: h.cookie })).status).toBe(200);
    expect((await getJson<DeviceInfo[]>('/v1/devices', h.hostToken)).body).toEqual([]);
  });

  it('unlinking the host revokes its devices', async () => {
    const { h, dev } = await activeDevice('rev3@example.test');
    await post('/v1/host/unlink', {}, bearer(h.hostToken));
    const row = await env.DB.prepare('SELECT state FROM devices WHERE id = ?').bind(dev.deviceId).first('state');
    expect(row).toBe('revoked');
  });
});
