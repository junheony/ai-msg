import { timingSafeEqual } from '../../../src/shared/cloud/b64';

const hex = (u8: Uint8Array) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Paddle `Paddle-Signature: ts=<unix>;h1=<hex>[;h1=<hex>…]` — HMAC-SHA256 hex of `${ts}:${rawBody}` with the
 * notification destination's secret. Any one `h1` may match (secret rotation). `|now - ts| > toleranceSec` fails.
 * The body must be the raw request text: a re-serialized JSON changes the bytes and fails.
 */
export async function verifyPaddleSignature(header: string | null, rawBody: string, secret: string, nowSec: number, toleranceSec = 5): Promise<boolean> {
  if (!header || !secret) return false;
  let ts: number | null = null;
  const h1: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 'ts' && /^\d{1,12}$/.test(v)) ts = Number(v);
    else if (k === 'h1' && /^[0-9a-f]{64}$/i.test(v)) h1.push(v.toLowerCase());
  }
  if (ts === null || h1.length === 0 || Math.abs(nowSec - ts) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${rawBody}`))));
  let ok = false;
  for (const h of h1) ok = timingSafeEqual(h, want) || ok; // no early exit
  return ok;
}
