/**
 * Byte helpers shared by the Mac (Node), the phone (browser) and the cloud Worker.
 * Only `globalThis.crypto`, `TextEncoder` and `Uint8Array` — no `node:` imports, no DOM-only APIs.
 */

const B64U = /^[A-Za-z0-9_-]*$/;

export function toB64u(u8: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws `TypeError` on any character outside the base64url alphabet (padding included). */
export function fromB64u(s: string): Uint8Array {
  if (!B64U.test(s) || s.length % 4 === 1) throw new TypeError('invalid base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return toB64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

const utf8 = (s: string | Uint8Array): Uint8Array => (typeof s === 'string' ? new TextEncoder().encode(s) : s);

export async function sha256B64u(s: string | Uint8Array): Promise<string> {
  return toB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s) as BufferSource)));
}

/** Constant time for equal-length inputs; a length mismatch returns false (length is not secret here). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

/** Length-prefixed concatenation: each part becomes `u16be(len) ‖ bytes` (strings as UTF-8). */
export function lp(...parts: (string | Uint8Array)[]): Uint8Array {
  const bytes = parts.map(utf8);
  let total = 0;
  for (const b of bytes) {
    if (b.length > 0xffff) throw new RangeError('lp part longer than 65535 bytes');
    total += 2 + b.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of bytes) {
    out[o] = b.length >> 8;
    out[o + 1] = b.length & 0xff;
    out.set(b, o + 2);
    o += 2 + b.length;
  }
  return out;
}
