/**
 * Tunnel frames carried as Noise transport plaintext (zod-validated), shared by the Mac and the phone.
 * The relay envelope lives in `envelope.ts` (zod-free, compiled into the cloud Worker) and is re-exported here.
 */
import { z } from 'zod';
import { NOISE_MAX_PLAINTEXT, TUNNEL_CHUNK } from './envelope';

export { CLOSE, EnvKind, MAX_FRAME, NOISE_MAX_PLAINTEXT, TUNNEL_CHUNK, decodeEnvelope, encodeEnvelope } from './envelope';
export type { Envelope } from './envelope';

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headers = z.record(z.string(), z.string());
const method = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Codes a close frame must not carry on the wire (RFC 6455 §7.4.1). */
const RESERVED_CLOSE = new Set([1005, 1006, 1015]);
const closeCode = z.number().int().min(1000).max(4999).refine((c) => !RESERVED_CLOSE.has(c), 'reserved close code');
/** A dot segment, also percent-encoded (`%2e`, `.%2E`, …). */
const isDotSegment = (seg: string) => /^(?:\.|%2e){1,2}$/i.test(seg);
/**
 * Origin-relative path only: one leading `/` (no `//host`), no backslash, no control/space, no `.`/`..`
 * segment. The Mac's path policy must still normalise (percent-decode) before matching rules.
 */
const tunnelPath = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)[^\\\x00-\x20]*$/)
  .refine((p) => !p.split(/[?#]/, 1)[0]!.split('/').some(isDotSegment), 'dot segment in path');

export const TunnelFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready') }),
  z.object({ t: z.literal('ws.open'), s: id }),
  z.object({ t: z.literal('ws.msg'), s: id, d: z.string(), more: z.boolean().optional() }),
  z.object({ t: z.literal('ws.close'), s: id, code: closeCode.optional() }),
  z.object({ t: z.literal('http.req'), id, m: method, p: tunnelPath, h: headers, b: z.string().optional(), more: z.boolean() }),
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

function checkSize(size: number): void {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('chunk size must be a positive integer');
}

export function chunkBytes(u8: Uint8Array, size = TUNNEL_CHUNK): Uint8Array[] {
  checkSize(size);
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
  checkSize(size);
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
