import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import type { LinkStartRes, PairClaimReq, PairClaimRes, PairStartRes } from '../../src/shared/cloud/api-types';
import { sha256B64u, toB64u } from '../../src/shared/cloud/b64';

export const APP = 'https://app.test';
export const RELAY = 'https://relay.test';

/** A fresh benchmarking-range (198.18.0.0/15) IP per call, so per-IP limits never leak between unrelated tests. */
let ipSeq = Math.floor(Math.random() * 60000);
export const freshIp = () => { const n = ipSeq++; return `198.18.${Math.floor(n / 250) % 256}.${(n % 250) + 1}`; };

/**
 * `redirect: 'manual'` — the entrypoint fetch would otherwise follow our 303s. A fresh client IP unless the
 * caller sets `cf-connecting-ip`, so GETs do not share one per-IP counter either.
 */
export const call = (path: string, init: RequestInit = {}, origin = APP) => {
  const headers = new Headers(init.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', freshIp());
  return exports.default.fetch(new Request(`${origin}${path}`, { redirect: 'manual', ...init, headers }));
};

/**
 * JSON POST with `Origin` set to the target origin and a fresh client IP unless `cf-connecting-ip` is given.
 * Pass `origin: null` in `headers` to drop the Origin header.
 */
export const post = (path: string, body: unknown, headers: Record<string, string | null> = {}, origin = APP) => {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries({ 'content-type': 'application/json', origin, 'cf-connecting-ip': freshIp(), ...headers })) if (v !== null) h[k] = v;
  return call(path, { method: 'POST', headers: h, body: JSON.stringify(body) }, origin);
};
export const relayPost = (path: string, body: unknown, headers: Record<string, string | null> = {}) => post(path, body, headers, RELAY);
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const getJson = async <T>(path: string, token: string, origin = APP): Promise<{ status: number; body: T }> => {
  const r = await call(path, { headers: bearer(token) }, origin);
  return { status: r.status, body: (await r.json()) as T };
};

export async function lastMailTo(email: string): Promise<string> {
  const row = await env.DB.prepare('SELECT body FROM outbox WHERE to_addr = ? ORDER BY id DESC LIMIT 1').bind(email.toLowerCase()).first<{ body: string }>();
  return row!.body;
}
export const tokenIn = (body: string) => /t=([A-Za-z0-9_-]+)/.exec(body)![1]!;

export async function loginAs(email: string): Promise<string> {
  await post('/v1/auth/magic', { email }, { 'cf-connecting-ip': freshIp() });
  const res = await post('/auth/verify', { t: tokenIn(await lastMailTo(email)) });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

export async function linkHost(email = 'user@example.test', ip = freshIp()): Promise<{ hostId: string; hostToken: string; cookie: string; trial: string }> {
  const s = (await (await post('/v1/host/link/start', { hostName: 'Test Mac', hostPub: toB64u(new Uint8Array(32).fill(1)), uiVersion: '1.0.0' }, { 'cf-connecting-ip': freshIp() })).json()) as LinkStartRes;
  const cookie = await loginAs(email);
  const a = (await (await post('/v1/host/link/approve', { userCode: s.userCode }, { cookie, 'cf-connecting-ip': ip })).json()) as { trial: string };
  const p = (await (await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).json()) as { hostId: string; hostToken: string };
  return { ...p, cookie, trial: a.trial };
}

export const pub = (fill: number) => toB64u(new Uint8Array(32).fill(fill));

export async function startPairing(hostToken: string, secret = 'claim-secret'): Promise<string> {
  const r = await post('/v1/pair/start', { claimHash: await sha256B64u(secret) }, bearer(hostToken));
  return ((await r.json()) as PairStartRes).pairingId;
}

export async function claim(o: { hostToken: string; secret?: string; devicePub?: string; ip?: string }): Promise<{ pairingId: string; body: PairClaimReq; res: Response }> {
  const secret = o.secret ?? 'claim-secret';
  const pairingId = await startPairing(o.hostToken, secret);
  const body: PairClaimReq = { pairingId, claim: secret, devicePub: o.devicePub ?? pub(2), deviceName: 'Phone', mac: 'm' };
  const res = await relayPost('/v1/pair/claim', body, { 'cf-connecting-ip': o.ip ?? freshIp() });
  return { pairingId, body, res };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export type Sock = { status: number; ws: WebSocket | null; inbox: (string | ArrayBuffer)[]; closes: number[] };

export async function openWs(path: string, headers: Record<string, string> = {}): Promise<Sock> {
  const res = await call(path, { headers: { upgrade: 'websocket', ...headers } }, RELAY);
  const inbox: (string | ArrayBuffer)[] = [];
  const closes: number[] = [];
  if (res.status !== 101) return { status: res.status, ws: null, inbox, closes };
  const ws = res.webSocket!;
  ws.binaryType = 'arraybuffer'; // workerd's client side defaults to Blob
  ws.accept();
  ws.addEventListener('message', (e) => inbox.push(e.data as string | ArrayBuffer));
  ws.addEventListener('close', (e) => closes.push(e.code));
  return { status: 101, ws, inbox, closes };
}

let pairSeq = 0;
/** A confirmed (active) device of this host. */
export async function pairedDevice(h: { hostToken: string }): Promise<{ deviceId: string; deviceToken: string; pairingId: string; body: PairClaimReq }> {
  const n = ++pairSeq;
  const c = await claim({ hostToken: h.hostToken, secret: `secret-${n}`, devicePub: pub(n % 250) });
  expect(c.res.status).toBe(200);
  const d = (await c.res.json()) as PairClaimRes;
  expect((await post(`/v1/pair/${c.pairingId}/confirm`, {}, bearer(h.hostToken))).status).toBe(200);
  return { deviceId: d.deviceId, deviceToken: d.deviceToken, pairingId: c.pairingId, body: c.body };
}
