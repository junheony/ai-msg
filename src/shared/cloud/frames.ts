/**
 * Relay envelope (the only thing the cloud Durable Object reads) and the tunnel frames carried
 * as Noise transport plaintext. Shared by the Mac, the phone and the cloud Worker (envelope only).
 */
import { z } from 'zod';

/** Noise message limit 65535 minus the 16-byte AES-GCM tag. */
export const NOISE_MAX_PLAINTEXT = 65519;
export const TUNNEL_CHUNK = 32768;
export const MAX_FRAME = 1 << 20;
export const CLOSE = { unauthorized: 4401, notEntitled: 4402, revoked: 4403, hsTimeout: 4408, replaced: 4409, tooLarge: 4413 } as const;

export enum EnvKind { Data = 1, HsInit = 2, HsAck = 3, Close = 4 }

export type Envelope = { kind: EnvKind; peer: string; payload: Uint8Array };

const PEER_MAX = 64;
const PEER_RE = /^[\x20-\x7e]*$/;
const isKind = (k: number): k is EnvKind => k >= EnvKind.Data && k <= EnvKind.Close;

export function encodeEnvelope(e: Envelope): Uint8Array {
  if (!isKind(e.kind)) throw new RangeError('unknown envelope kind');
  if (e.peer.length > PEER_MAX || !PEER_RE.test(e.peer)) throw new RangeError('peer must be printable ASCII, at most 64 chars');
  const out = new Uint8Array(2 + e.peer.length + e.payload.length);
  out[0] = e.kind;
  out[1] = e.peer.length;
  for (let i = 0; i < e.peer.length; i++) out[2 + i] = e.peer.charCodeAt(i);
  out.set(e.payload, 2 + e.peer.length);
  return out;
}

/** `null` for anything malformed: unknown kind, peer over 64 bytes or not printable ASCII, truncated. */
export function decodeEnvelope(u8: Uint8Array): Envelope | null {
  if (u8.length < 2) return null;
  const kind = u8[0]!;
  const len = u8[1]!;
  if (!isKind(kind) || len > PEER_MAX || u8.length < 2 + len) return null;
  let peer = '';
  for (let i = 0; i < len; i++) {
    const c = u8[2 + i]!;
    if (c < 0x20 || c > 0x7e) return null;
    peer += String.fromCharCode(c);
  }
  return { kind, peer, payload: u8.slice(2 + len) };
}

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headers = z.record(z.string(), z.string());
const method = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export const TunnelFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready') }),
  z.object({ t: z.literal('ws.open'), s: id }),
  z.object({ t: z.literal('ws.msg'), s: id, d: z.string(), more: z.boolean().optional() }),
  z.object({ t: z.literal('ws.close'), s: id, code: z.number().int().min(1000).max(4999).optional() }),
  z.object({ t: z.literal('http.req'), id, m: method, p: z.string().startsWith('/'), h: headers, b: z.string().optional(), more: z.boolean() }),
  z.object({ t: z.literal('http.res'), id, st: z.number().int().min(100).max(599), h: headers, b: z.string().optional(), more: z.boolean() }),
  z.object({ t: z.literal('http.chunk'), id, b: z.string(), more: z.boolean() }),
  z.object({ t: z.literal('http.abort'), id }),
]);
export type TunnelFrame = z.infer<typeof TunnelFrame>;

export function parseTunnelFrame(json: unknown): TunnelFrame | null {
  const r = TunnelFrame.safeParse(json);
  return r.success ? r.data : null;
}

export function encodeTunnel(f: TunnelFrame): Uint8Array {
  const u8 = new TextEncoder().encode(JSON.stringify(f));
  if (u8.length > NOISE_MAX_PLAINTEXT) throw new RangeError(`tunnel frame over ${NOISE_MAX_PLAINTEXT} bytes`);
  return u8;
}

export function chunkBytes(u8: Uint8Array, size = TUNNEL_CHUNK): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < u8.length; i += size) out.push(u8.subarray(i, i + size));
  return out;
}

/** Bytes a UTF-16 code unit costs once JSON-escaped and UTF-8 encoded (a surrogate pair costs 4 in total). */
function jsonCost(c: number): number {
  if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) return 2;
  if (c < 0x20) return 6;
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c >= 0xd800 && c <= 0xdfff) return 6; // a lone surrogate is escaped as \uXXXX
  return 3;
}

/**
 * Splits so each piece costs at most `size` bytes once JSON-escaped and UTF-8 encoded, so a
 * `ws.msg` carrying one piece always fits a Noise message. Never splits a UTF-16 surrogate pair.
 */
export function chunkString(s: string, size = TUNNEL_CHUNK): string[] {
  const out: string[] = [];
  let start = 0;
  let cost = 0;
  for (let i = 0; i < s.length; ) {
    const hi = s.charCodeAt(i);
    const pair = hi >= 0xd800 && hi <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    const w = pair ? 2 : 1;
    const c = pair ? 4 : jsonCost(hi);
    if (cost + c > size && i > start) {
      out.push(s.slice(start, i));
      start = i;
      cost = 0;
    }
    cost += c;
    i += w;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}
