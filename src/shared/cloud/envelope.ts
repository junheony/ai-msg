/**
 * Relay envelope — the only thing the cloud Durable Object reads — and the size/close-code constants both sides
 * share. No imports at all: `cloud/` compiles this file into the Worker (`cloud/tsconfig.json` include), so zod
 * and other packages must stay in `frames.ts`. `frames.ts` re-exports everything here.
 */
/** Noise message limit 65535 minus the 16-byte AES-GCM tag. */
export const NOISE_MAX_PLAINTEXT = 65519;
export const TUNNEL_CHUNK = 32768;
/** Largest envelope (header + payload) either side or the relay accepts; bigger is closed with 4413. */
export const MAX_FRAME = 1 << 20;
export const CLOSE = { unauthorized: 4401, notEntitled: 4402, revoked: 4403, hsTimeout: 4408, replaced: 4409, tooLarge: 4413, rateLimited: 4429 } as const;

export enum EnvKind { Data = 1, HsInit = 2, HsAck = 3, Close = 4 }

export type Envelope = { kind: EnvKind; peer: string; payload: Uint8Array };

const PEER_MAX = 64;
const PEER_RE = /^[\x20-\x7e]*$/;
const isKind = (k: number): k is EnvKind => k >= EnvKind.Data && k <= EnvKind.Close;

export function encodeEnvelope(e: Envelope): Uint8Array {
  if (!isKind(e.kind)) throw new RangeError('unknown envelope kind');
  if (e.peer.length > PEER_MAX || !PEER_RE.test(e.peer)) throw new RangeError('peer must be printable ASCII, at most 64 chars');
  if (2 + e.peer.length + e.payload.length > MAX_FRAME) throw new RangeError(`envelope over ${MAX_FRAME} bytes`);
  const out = new Uint8Array(2 + e.peer.length + e.payload.length);
  out[0] = e.kind;
  out[1] = e.peer.length;
  for (let i = 0; i < e.peer.length; i++) out[2 + i] = e.peer.charCodeAt(i);
  out.set(e.payload, 2 + e.peer.length);
  return out;
}

/** `null` for anything malformed: unknown kind, peer over 64 bytes or not printable ASCII, truncated, over `MAX_FRAME`. */
export function decodeEnvelope(u8: Uint8Array): Envelope | null {
  if (u8.length < 2 || u8.length > MAX_FRAME) return null;
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
