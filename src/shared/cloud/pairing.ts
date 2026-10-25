/**
 * Pairing QR, the pairing MAC (binds the phone key to the QR-only `authSecret`) and the
 * 6-digit confirm code both screens show. Node and browser only.
 */
import { fromB64u, lp, sha256B64u, timingSafeEqual, toB64u } from './b64';
import { isSemver } from './noise';

export type PairQr = { v: 2; pairingId: string; claim: string; auth: string; hostPub: string; hostVersion: string; relayOrigin: string };
type PairKeys = { pairingId: string; devicePub: string; hostPub: string };

const PART = /^[A-Za-z0-9_-]+$/;
/** `claimSecret`·`authSecret` are 32 random bytes → at least 43 base64url characters (256 bits). */
const SECRET_MIN = 43;
const isSecret = (s: string) => PART.test(s) && s.length >= SECRET_MIN;

export function encodePairUrl(q: PairQr): string {
  if (!isSemver(q.hostVersion)) throw new RangeError('hostVersion must be semver');
  for (const p of [q.pairingId, q.hostPub]) if (!PART.test(p)) throw new RangeError('pair fields must be base64url');
  if (!isSecret(q.claim) || !isSecret(q.auth)) throw new RangeError('claim and auth must be 256-bit base64url secrets');
  return `${q.relayOrigin.replace(/\/+$/, '')}/v/${q.hostVersion}/#pair=2.${q.pairingId}.${q.claim}.${q.auth}.${q.hostPub}`;
}

/** Accepts `#pair=…`, `pair=…` or the bare pairing code `2.<id>.<claim>.<auth>.<hostPub>`. */
export function parsePairHash(hash: string): Omit<PairQr, 'relayOrigin' | 'hostVersion'> | null {
  const code = hash.replace(/^#/, '').replace(/^pair=/, '').trim();
  const parts = code.split('.');
  if (parts.length !== 5 || parts[0] !== '2') return null;
  const [, pairingId, claim, auth, hostPub] = parts as [string, string, string, string, string];
  if (!PART.test(pairingId) || !PART.test(hostPub) || !isSecret(claim) || !isSecret(auth)) return null;
  try {
    if (fromB64u(hostPub).length !== 32) return null;
  } catch {
    return null;
  }
  return { v: 2, pairingId, claim, auth, hostPub };
}

export function claimHash(claim: string): Promise<string> {
  return sha256B64u(claim);
}

/** `HMAC-SHA256(authSecret, lp("aimsg-pair-v2") ‖ lp(pairingId) ‖ lp(devicePub) ‖ lp(hostPub))`, base64url. */
export async function pairingMac(auth: string, o: PairKeys): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(auth) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, lp('aimsg-pair-v2', o.pairingId, o.devicePub, o.hostPub) as BufferSource);
  return toB64u(new Uint8Array(sig));
}

export async function verifyPairingMac(auth: string, o: PairKeys, mac: string): Promise<boolean> {
  return timingSafeEqual(await pairingMac(auth, o), mac);
}

/**
 * Short authentication string for the human check on both screens. Only 20 bits and computed from
 * public values, so it is not a secret: it is safe only together with the QR-only `authSecret` MAC
 * (`pairingMac`) and the cloud burning a pairing that sees a second valid claim.
 * `u32be(sha256(lp("aimsg-sas-v1") ‖ lp(pairingId) ‖ lp(devicePub) ‖ lp(hostPub))[0..4)) mod 1 000 000`, zero-padded. */
export async function confirmCode(o: PairKeys): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', lp('aimsg-sas-v1', o.pairingId, o.devicePub, o.hostPub) as BufferSource);
  return String(new DataView(d).getUint32(0, false) % 1_000_000).padStart(6, '0');
}
