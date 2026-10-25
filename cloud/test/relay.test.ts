import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { PairClaimRes, TicketRes } from '../../src/shared/cloud/api-types';
import { CLOSE, EnvKind, MAX_FRAME, decodeEnvelope, encodeEnvelope } from '../../src/shared/cloud/envelope';
import { notifyRelay } from '../src/relay/routes';
import type { Ctx } from '../src/router';
import { type Sock, RELAY, bearer, call, claim, freshIp, linkHost, openWs, pairedDevice, post, pub, relayPost, waitFor } from './helpers';

const stubFor = (hostId: string) => env.RELAY.get(env.RELAY.idFromName(hostId));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const texts = (s: Sock) => s.inbox.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m) as Record<string, unknown>);
const binaries = (s: Sock) => s.inbox.filter((m): m is ArrayBuffer => m instanceof ArrayBuffer);
const hasText = (s: Sock, want: Record<string, unknown>) => texts(s).some((m) => Object.entries(want).every(([k, v]) => m[k] === v));

let seq = 0;
const email = () => `relay${seq++}@example.test`;

const ticketRes = (deviceToken: string) => relayPost('/v1/relay/ticket', {}, bearer(deviceToken));
async function ticketFor(deviceToken: string): Promise<string> {
  const r = await ticketRes(deviceToken);
  expect(r.status).toBe(200);
  return ((await r.json()) as TicketRes).ticket;
}
async function setTrialEnd(hostId: string, endsAt: number): Promise<void> {
  await env.DB.prepare('UPDATE trials SET ends_at = ? WHERE user_id = (SELECT user_id FROM hosts WHERE id = ?)').bind(endsAt, hostId).run();
}
const openHost = (hostToken: string, headers: Record<string, string> = {}) => openWs('/relay/host', { ...bearer(hostToken), ...headers });
const openDevice = async (deviceToken: string) => openWs(`/relay/device?ticket=${await ticketFor(deviceToken)}`, { origin: RELAY });
/** A round trip through the DO: a frame to a missing peer comes back as `peer up:false`, so earlier messages were handled. */
async function sync(host: Sock): Promise<void> {
  const marker = `sync-${seq++}`;
  host.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: marker, payload: new Uint8Array([0]) }));
  await waitFor(() => hasText(host, { t: 'peer', dev: marker, up: false }));
}

describe('relay ticket', () => {
  it('ticket before Mac approval is 403 pending_confirm', async () => {
    const h = await linkHost(email());
    const { res } = await claim({ hostToken: h.hostToken });
    const { deviceToken } = (await res.json()) as PairClaimRes;
    const t = await ticketRes(deviceToken);
    expect(t.status).toBe(403);
    expect(await t.json()).toMatchObject({ code: 'pending_confirm' });
  });

  it('a claimed device whose pairing expired gets 401, not an endless pending_confirm', async () => {
    const h = await linkHost(email());
    const c = await claim({ hostToken: h.hostToken });
    const { deviceToken } = (await c.res.json()) as PairClaimRes;
    await env.DB.prepare('UPDATE pairings SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, c.pairingId).run();
    const t = await ticketRes(deviceToken);
    expect(t.status).toBe(401);
    expect(await t.json()).toMatchObject({ code: 'pairing_expired' });
  });

  it('issues a 60 s one-time ticket; unknown token or revoked device is 401 revoked; needs the relay Origin', async () => {
    const h = await linkHost(email());
    const d = await pairedDevice(h);
    expect((await relayPost('/v1/relay/ticket', {}, { ...bearer(d.deviceToken), origin: 'https://evil.test' })).status).toBe(403);
    const ok = await ticketRes(d.deviceToken);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as TicketRes;
    expect(body).toMatchObject({ hostId: h.hostId, expiresIn: 60 });
    const row = await env.DB.prepare('SELECT ticket_hash, expires_at, used_at FROM relay_tickets WHERE device_id = ?').bind(d.deviceId).first<{ ticket_hash: string; expires_at: number; used_at: number | null }>();
    expect(row!.ticket_hash).not.toBe(body.ticket);
    expect(row!.used_at).toBeNull();
    const nope = await ticketRes('nope');
    expect(nope.status).toBe(401);
    expect(await nope.json()).toMatchObject({ code: 'revoked' });
  });

  it('ticket is single use and expires in 60 s', async () => {
    const h = await linkHost(email());
    const d = await pairedDevice(h);
    const t = await ticketFor(d.deviceToken);
    const first = await openWs(`/relay/device?ticket=${t}`);
    expect(first.status).toBe(101);
    expect((await openWs(`/relay/device?ticket=${t}`)).status).toBe(401);
    const stale = await ticketFor(d.deviceToken);
    await env.DB.prepare('UPDATE relay_tickets SET expires_at = ? WHERE used_at IS NULL AND device_id = ?').bind(Date.now() - 1, d.deviceId).run();
    expect((await openWs(`/relay/device?ticket=${stale}`)).status).toBe(401);
    expect((await openWs('/relay/device?ticket=')).status).toBe(401);
    expect((await openWs(`/relay/device?ticket=${await ticketFor(d.deviceToken)}`, { origin: 'https://evil.test' })).status).toBe(403);
    const seen = await env.DB.prepare('SELECT last_seen FROM devices WHERE id = ?').bind(d.deviceId).first<number>('last_seen');
    expect(seen).toBeGreaterThan(0);
  });

  it('tickets are limited to 10 per device per minute (429), so the table cannot be flooded', async () => {
    const h = await linkHost(email());
    const d = await pairedDevice(h);
    for (let i = 0; i < 10; i++) expect((await ticketRes(d.deviceToken)).status).toBe(200);
    const over = await ticketRes(d.deviceToken);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: 'rate_limited' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM relay_tickets WHERE device_id = ?').bind(d.deviceId).first('n')).toBe(10);
    const other = await pairedDevice(h); // per device, not per host
    expect((await ticketRes(other.deviceToken)).status).toBe(200);
  });

  it('relay routes are 404 on the app origin', async () => {
    expect((await post('/v1/relay/ticket', {})).status).toBe(404);
    expect((await call('/relay/host', { headers: { upgrade: 'websocket' } })).status).toBe(404);
    expect((await call('/relay/device?ticket=x', { headers: { upgrade: 'websocket' } })).status).toBe(404);
  });

  it('relay WS routes refuse a plain GET with 426', async () => {
    const h = await linkHost(email());
    expect((await call('/relay/host', { headers: bearer(h.hostToken) }, RELAY)).status).toBe(426);
  });
});

describe('relay entitlement', () => {
  it('host needs a valid token but no entitlement; it is told ent:false and tickets are 402', async () => {
    expect((await openHost('nope')).status).toBe(401);
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    await setTrialEnd(h.hostId, 0);
    const host = await openHost(h.hostToken);
    expect(host.status).toBe(101); // 2차 필수 1: the upgrade is accepted
    await waitFor(() => texts(host).length > 0);
    expect(texts(host)[0]).toMatchObject({ t: 'ent', ok: false });
    const t = await ticketRes(d1.deviceToken);
    expect(t.status).toBe(402);
    expect(await t.json()).toMatchObject({ code: 'not_entitled' });
  });

  it('not_entitled host stays attached; recheck after payment flips it to ent:true within the same alarm (2차 필수 1)', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    await setTrialEnd(h.hostId, 0);
    const host = await openHost(h.hostToken);
    await waitFor(() => hasText(host, { t: 'ent', ok: false }));
    await setTrialEnd(h.hostId, Date.now() + 86_400_000); // same effect as a payment or a trial extension
    await stubFor(h.hostId).fetch('https://relay/internal/recheck');
    await runDurableObjectAlarm(stubFor(h.hostId));
    await waitFor(() => hasText(host, { t: 'ent', ok: true }));
    expect(host.closes).toEqual([]); // not closed, only the state changed
    const p1 = await openDevice(d1.deviceToken);
    expect(p1.status).toBe(101);
  });

  it('host text {"t":"recheck"} triggers a recheck at most once per 30 s', async () => {
    const h = await linkHost(email());
    await setTrialEnd(h.hostId, 0); // no alarm armed on its own
    const host = await openHost(h.hostToken);
    await waitFor(() => texts(host).length === 1);
    host.ws!.send('{"t":"recheck"}');
    await waitFor(async () => { await runDurableObjectAlarm(stubFor(h.hostId)); return texts(host).filter((m) => m.t === 'ent').length === 2; });
    host.ws!.send('{"t":"recheck"}');
    host.ws!.send('not json');
    await sync(host);
    expect(await runDurableObjectAlarm(stubFor(h.hostId))).toBe(false);
    await sleep(100);
    expect(texts(host).filter((m) => m.t === 'ent')).toHaveLength(2);
  });

  it('device route forwards user and until: a device-only DO alarm reads the user (2차 필수 3)', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    await setTrialEnd(h.hostId, Date.now() + 60_000);
    const p1 = await openDevice(d1.deviceToken); // a device and no host
    expect(p1.status).toBe(101);
    const user = await env.DB.prepare('SELECT user_id FROM hosts WHERE id = ?').bind(h.hostId).first<string>('user_id');
    await runInDurableObject(stubFor(h.hostId), (_i, state) => {
      const att = state.getWebSockets(`dev:${d1.deviceId}`)[0]!.deserializeAttachment() as Record<string, unknown>;
      expect(att).toMatchObject({ role: 'device', dev: d1.deviceId, user });
      expect(att.until).toBeGreaterThan(Date.now());
    });
    await setTrialEnd(h.hostId, 0);
    await runDurableObjectAlarm(stubFor(h.hostId));
    await waitFor(() => p1.closes.includes(CLOSE.notEntitled));
  });

  it('alarm closes devices with 4402 once the entitlement is over; host stays and gets ent:false', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    await setTrialEnd(h.hostId, Date.now() + 60_000);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: true }));
    expect(hasText(host, { t: 'ent', ok: true })).toBe(true);
    await setTrialEnd(h.hostId, Date.now() - 1);
    expect(await runDurableObjectAlarm(stubFor(h.hostId))).toBe(true);
    await waitFor(() => p1.closes.includes(CLOSE.notEntitled));
    await waitFor(() => hasText(host, { t: 'ent', ok: false }));
    expect(host.closes).toEqual([]);
    // nothing left to watch: no alarm until a recheck
    expect(await runDurableObjectAlarm(stubFor(h.hostId))).toBe(false);
  });

  it('an entitlement that was renewed re-arms the alarm instead of closing', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    await setTrialEnd(h.hostId, Date.now() + 60_000);
    const p1 = await openDevice(d1.deviceToken);
    expect(p1.status).toBe(101);
    await setTrialEnd(h.hostId, Date.now() + 120_000);
    expect(await runDurableObjectAlarm(stubFor(h.hostId))).toBe(true);
    const alarm = await runInDurableObject(stubFor(h.hostId), (_i, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 60_000);
    expect(p1.closes).toEqual([]);
  });
});

describe('relay routing', () => {
  it('client-sent x-relay-* headers are stripped on both routes', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const user = await env.DB.prepare('SELECT user_id FROM hosts WHERE id = ?').bind(h.hostId).first<string>('user_id');
    const forged = { 'x-relay-user': 'someone-else', 'x-relay-role': 'host', 'x-relay-device': 'spoof', 'x-relay-until': '99999999999999' };
    const host = await openHost(h.hostToken, forged);
    expect(host.status).toBe(101);
    const p1 = await openWs(`/relay/device?ticket=${await ticketFor(d1.deviceToken)}`, forged);
    expect(p1.status).toBe(101);
    await runInDurableObject(stubFor(h.hostId), (_i, state) => {
      const hostAtt = state.getWebSockets('host')[0]!.deserializeAttachment() as Record<string, unknown>;
      expect(hostAtt).toMatchObject({ role: 'host', user });
      expect(hostAtt.until).not.toBe(99999999999999);
      const devAtt = state.getWebSockets(`dev:${d1.deviceId}`)[0]!.deserializeAttachment() as Record<string, unknown>;
      expect(devAtt).toMatchObject({ role: 'device', dev: d1.deviceId, user });
      expect(state.getWebSockets('dev:spoof')).toHaveLength(0);
    });
  });

  it('routes host→device and device→host; device cannot spoof its id', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const d2 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    const p2 = await openDevice(d2.deviceToken);
    await waitFor(() => hasText(p1, { t: 'host', up: true }) && hasText(p2, { t: 'host', up: true }));
    p2.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: d1.deviceId, payload: new Uint8Array([7]) }));
    await waitFor(() => binaries(host).length > 0);
    const got = decodeEnvelope(new Uint8Array(binaries(host)[0]!))!;
    expect(got.peer).toBe(d2.deviceId);
    expect(Array.from(got.payload)).toEqual([7]);
    host.ws!.send(encodeEnvelope({ kind: EnvKind.HsAck, peer: d1.deviceId, payload: new Uint8Array([9]) }));
    await waitFor(() => binaries(p1).length > 0);
    const back = decodeEnvelope(new Uint8Array(binaries(p1)[0]!))!;
    expect(back).toMatchObject({ kind: EnvKind.HsAck, peer: 'host' });
    expect(Array.from(back.payload)).toEqual([9]);
    expect(binaries(p2)).toHaveLength(0);
  });

  it('peer presence: a device learns whether the host is up; the host learns devices come and go', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(p1, { t: 'host', up: false }));
    p1.ws!.send(encodeEnvelope({ kind: EnvKind.HsInit, peer: 'host', payload: new Uint8Array([1]) }));
    await waitFor(() => texts(p1).filter((m) => m.t === 'host' && m.up === false).length === 2); // no host to take it
    const host = await openHost(h.hostToken);
    await waitFor(() => hasText(p1, { t: 'host', up: true }));
    p1.ws!.close(1000);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: false }));
    host.ws!.close(1000);
    const p2 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(p2, { t: 'host', up: false }));
  });

  it('payload bytes pass through untouched (no decoding)', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: true }));
    const bytes = crypto.getRandomValues(new Uint8Array(1000));
    p1.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: 'host', payload: bytes }));
    await waitFor(() => binaries(host).length > 0);
    expect(decodeEnvelope(new Uint8Array(binaries(host)[0]!))!.payload).toEqual(bytes);
    const json = new TextEncoder().encode('{"t":"http.req","id":1,"m":"GET","p":"/api/me"}'); // plaintext-shaped: still just bytes
    host.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: d1.deviceId, payload: json }));
    await waitFor(() => binaries(p1).length > 0);
    expect(decodeEnvelope(new Uint8Array(binaries(p1)[0]!))!.payload).toEqual(json);
  });

  it('malformed envelopes are dropped and the connection stays', async () => {
    const h = await linkHost(email());
    const host = await openHost(h.hostToken);
    host.ws!.send(new Uint8Array([99, 0, 1, 2]));
    host.ws!.send(new Uint8Array([1]));
    await sync(host);
    expect(host.closes).toEqual([]);
  });

  it('a second host connection replaces the first with 4409', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const first = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(p1, { t: 'host', up: true }));
    const second = await openHost(h.hostToken);
    await waitFor(() => first.closes.includes(CLOSE.replaced));
    p1.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: 'host', payload: new Uint8Array([5]) }));
    await waitFor(() => binaries(second).length > 0);
    expect(binaries(first)).toHaveLength(0);
    await sleep(50);
    expect(hasText(p1, { t: 'host', up: false })).toBe(false); // the replaced host does not read as "host gone"
  });

  it('a second device connection replaces the first with 4409', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const a = await openDevice(d1.deviceToken);
    const b = await openDevice(d1.deviceToken);
    await waitFor(() => a.closes.includes(CLOSE.replaced));
    host.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: d1.deviceId, payload: new Uint8Array([3]) }));
    await waitFor(() => binaries(b).length > 0);
    await sleep(50);
    expect(hasText(host, { t: 'peer', dev: d1.deviceId, up: false })).toBe(false);
  });

  it('survives hibernation: attachment keeps routing after eviction', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: true }));
    await evictDurableObject(stubFor(h.hostId), { webSockets: 'hibernate' });
    p1.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: 'spoofed', payload: new Uint8Array([4]) }));
    await waitFor(() => binaries(host).length > 0);
    expect(decodeEnvelope(new Uint8Array(binaries(host)[0]!))!.peer).toBe(d1.deviceId);
    host.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: d1.deviceId, payload: new Uint8Array([6]) }));
    await waitFor(() => binaries(p1).length > 0);
  });

  it('a device frame flood closes that device with 4429; a malformed-frame log line is written once per socket', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      const h = await linkHost(email());
      const d1 = await pairedDevice(h);
      const p1 = await openDevice(d1.deviceToken);
      await waitFor(() => texts(p1).length > 0);
      for (let i = 0; i < 1200 && p1.closes.length === 0; i++) {
        try { p1.ws!.send(new Uint8Array([200, 1, 2, 3])); } catch { break; }
      }
      await waitFor(() => p1.closes.length > 0);
      expect(p1.closes).toEqual([CLOSE.rateLimited]);
      expect(lines.filter((l) => l.includes('"ev":"bad_frame"'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('the host socket has no frame limit: 1000 frames at once (a big reply to every device) all pass', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: true }));
    const chunk = new Uint8Array(32 * 1024);
    for (let i = 0; i < 1000; i++) host.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: d1.deviceId, payload: chunk }));
    await waitFor(() => binaries(p1).length === 1000, 15_000);
    expect(host.closes).toEqual([]);
    expect(p1.closes).toEqual([]);
  }, 20_000);

  it('a normal burst (300 frames at once) passes the frame limit', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: true }));
    for (let i = 0; i < 300; i++) p1.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: 'host', payload: new Uint8Array([i & 255]) }));
    await waitFor(() => binaries(host).length === 300);
    expect(p1.closes).toEqual([]);
  });

  it('oversized frame closes with 4413', async () => {
    const h = await linkHost(email());
    const host = await openHost(h.hostToken);
    await waitFor(() => texts(host).length > 0);
    host.ws!.send(new Uint8Array(MAX_FRAME + 1));
    await waitFor(() => host.closes.length > 0);
    expect(host.closes).toEqual([CLOSE.tooLarge]);
  });
});

describe('relay revoke and unlink', () => {
  it('revoking a device closes it with 4403 and tells the host', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: true }));
    expect((await post(`/v1/devices/${d1.deviceId}/revoke`, {}, bearer(h.hostToken))).status).toBe(200);
    await waitFor(() => p1.closes.includes(CLOSE.revoked));
    await waitFor(() => hasText(host, { t: 'revoked' }));
    expect(texts(host).find((m) => m.t === 'revoked')).toEqual({ t: 'revoked', dev: d1.deviceId });
    expect((await ticketRes(d1.deviceToken)).status).toBe(401);
  });

  it('revoking from the account page (web session) also closes the device', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: true }));
    expect((await post(`/v1/devices/${d1.deviceId}/revoke`, {}, { cookie: h.cookie })).status).toBe(200);
    await waitFor(() => p1.closes.includes(CLOSE.revoked));
    await waitFor(() => hasText(host, { t: 'revoked', dev: d1.deviceId }));
  });

  it('a ticket issued before the revoke cannot open a channel after it', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const t = await ticketFor(d1.deviceToken);
    await post(`/v1/devices/${d1.deviceId}/revoke`, {}, bearer(h.hostToken));
    expect((await openWs(`/relay/device?ticket=${t}`)).status).toBe(401);
  });

  it('a burned pairing closes the device that already connected', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: true }));
    const again = await relayPost('/v1/pair/claim', { ...d1.body, devicePub: pub(251) }, { 'cf-connecting-ip': freshIp() });
    expect(await again.json()).toMatchObject({ code: 'pairing_burned' });
    await waitFor(() => p1.closes.includes(CLOSE.revoked));
    await waitFor(() => hasText(host, { t: 'revoked', dev: d1.deviceId }));
  });

  it('unlink closes all with 4401', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(host, { t: 'peer', dev: d1.deviceId, up: true }));
    expect((await post('/v1/host/unlink', {}, bearer(h.hostToken))).status).toBe(200);
    await waitFor(() => host.closes.includes(CLOSE.unauthorized) && p1.closes.includes(CLOSE.unauthorized));
    expect((await openHost(h.hostToken)).status).toBe(401);
  });

  /** Opens a socket on the DO directly, as the Worker does after the ticket/token check (the revoke lands in between). */
  async function openOnRoom(hostId: string, relay: Record<string, string>): Promise<Sock> {
    const res = await stubFor(hostId).fetch('https://relay/relay/x', { headers: { upgrade: 'websocket', 'x-relay-host': hostId, 'x-relay-until': String(Date.now() + 86_400_000), ...relay } });
    const inbox: (string | ArrayBuffer)[] = [];
    const closes: number[] = [];
    if (res.status !== 101) return { status: res.status, ws: null, inbox, closes };
    const ws = res.webSocket!;
    ws.accept();
    ws.addEventListener('message', (e) => inbox.push(e.data as string | ArrayBuffer));
    ws.addEventListener('close', (e) => closes.push(e.code));
    return { status: 101, ws, inbox, closes };
  }
  const userOf = async (hostId: string) => (await env.DB.prepare('SELECT user_id FROM hosts WHERE id = ?').bind(hostId).first<string>('user_id'))!;

  it('race: a device revoked after its ticket was used but before the DO accepted is closed with 4403 right after accept', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const host = await openHost(h.hostToken);
    await waitFor(() => texts(host).length > 0);
    // The revoke commits in D1 while the upgrade is in flight; its DO notice found nothing to close.
    await env.DB.prepare("UPDATE devices SET state = 'revoked' WHERE id = ?").bind(d1.deviceId).run();
    const p1 = await openOnRoom(h.hostId, { 'x-relay-role': 'device', 'x-relay-device': d1.deviceId, 'x-relay-user': await userOf(h.hostId) });
    expect(p1.status).toBe(101);
    await waitFor(() => p1.closes.length > 0);
    expect(p1.closes).toEqual([CLOSE.revoked]);
    await sync(host);
    expect(hasText(host, { t: 'peer', dev: d1.deviceId, up: true })).toBe(false);
  });

  it('race: a host unlinked after its token check but before the DO accepted is closed with 4401 right after accept', async () => {
    const h = await linkHost(email());
    const d1 = await pairedDevice(h);
    const p1 = await openDevice(d1.deviceToken);
    await waitFor(() => hasText(p1, { t: 'host', up: false }));
    await env.DB.prepare('UPDATE hosts SET revoked_at = ? WHERE id = ?').bind(Date.now(), h.hostId).run();
    const host = await openOnRoom(h.hostId, { 'x-relay-role': 'host', 'x-relay-user': await userOf(h.hostId) });
    expect(host.status).toBe(101);
    await waitFor(() => host.closes.length > 0);
    expect(host.closes).toEqual([CLOSE.unauthorized]);
    await sleep(50);
    expect(hasText(p1, { t: 'host', up: true })).toBe(false);
  });

  it('the DO refuses an upgrade without the headers the Worker adds', async () => {
    const res = await stubFor('nobody').fetch('https://relay/relay/host', { headers: { upgrade: 'websocket', 'x-relay-role': 'host' } });
    expect(res.status).toBe(500);
  });
});

describe('notifyRelay', () => {
  const fakeCtx = (fetch: () => Promise<Response>) => {
    const waits: Promise<unknown>[] = [];
    let calls = 0;
    const stub = { fetch: () => { calls++; return fetch(); } };
    const c = { env: { RELAY: { idFromName: (n: string) => n, get: () => stub } }, exec: { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } } as unknown as Ctx;
    return { c, done: () => Promise.all(waits), calls: () => calls };
  };

  it('a failed notice is sent once more', async () => {
    let n = 0;
    const f = fakeCtx(async () => { if (n++ === 0) throw new Error('reset'); return new Response(null, { status: 204 }); });
    notifyRelay(f.c, 'host-a', 'revoke', 'dev-a');
    await f.done();
    expect(f.calls()).toBe(2);
  });

  it('a notice that fails twice (thrown or non-2xx) leaves one metadata-only log line', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      let n = 0;
      const f = fakeCtx(async () => { if (n++ === 0) throw new Error('secret-detail'); return new Response('boom', { status: 500 }); });
      notifyRelay(f.c, 'host-b', 'unlink');
      await f.done();
      expect(f.calls()).toBe(2);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({ ev: 'notify_failed_unlink', host: 'host-b' });
      expect(lines[0]).not.toContain('secret-detail');
    } finally {
      spy.mockRestore();
    }
  });
});
