/**
 * Noise_KK_25519_AESGCM_SHA256 — a thin, spec-literal implementation of Noise rev 34 §5
 * (CipherState · SymmetricState · HandshakeState) on WebCrypto only (X25519, AES-GCM, SHA-256, HMAC).
 * Shared by the Mac (Node) and the phone (browser); the cloud Worker never imports this file.
 * Passes the public cacophony/snow test vectors (`noise.vectors.test.ts`).
 */
import { fromB64u, lp, toB64u } from './b64';
import { NOISE_MAX_PLAINTEXT } from './frames';

export { NOISE_MAX_PLAINTEXT };

export const PROTOCOL_NAME = 'Noise_KK_25519_AESGCM_SHA256';
export const NOISE_MAX_MSG = 65535;

const HASHLEN = 32;
const DHLEN = 32;
const TAGLEN = 16;
const REKEY_AT = 2n ** 32n;
const NONCE_MAX = 2n ** 64n - 1n; // reserved by the spec (§5.1)

export class HandshakeError extends Error { override name = 'HandshakeError'; }
export class DecryptError extends Error { override name = 'DecryptError'; }
export class RekeyNeeded extends Error { override name = 'RekeyNeeded'; }

/** DH behind an interface so the phone can keep a non-extractable `CryptoKey`. */
export interface X25519Key {
  readonly publicRaw: Uint8Array;
  dh(peerPublic: Uint8Array): Promise<Uint8Array>;
}
export type StaticKey = X25519Key & { readonly privateKey: CryptoKey };

const subtle = () => globalThis.crypto.subtle;
const buf = (u: Uint8Array): BufferSource => u as BufferSource;
const X25519 = { name: 'X25519' } as const;
const PKCS8_X25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function wrapKey(privateKey: CryptoKey, publicRaw: Uint8Array): StaticKey {
  return {
    privateKey,
    publicRaw,
    async dh(peerPublic) {
      if (peerPublic.length !== DHLEN) throw new HandshakeError('bad public key length');
      const pub = await subtle().importKey('raw', buf(peerPublic), X25519, true, []);
      const out = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: pub }, privateKey, 256));
      if (out.every((b) => b === 0)) throw new HandshakeError('low-order public key');
      return out;
    },
  };
}

async function publicFromPrivate(privateKey: CryptoKey): Promise<Uint8Array> {
  const jwk = await subtle().exportKey('jwk', privateKey);
  if (!jwk.x) throw new TypeError('X25519 key has no public part');
  return fromB64u(jwk.x);
}

export async function generateStaticKey(o: { extractable: boolean }): Promise<StaticKey> {
  const pair = (await subtle().generateKey(X25519, o.extractable, ['deriveBits'])) as CryptoKeyPair;
  return wrapKey(pair.privateKey, new Uint8Array(await subtle().exportKey('raw', pair.publicKey)));
}

export async function exportStaticPrivate(k: StaticKey): Promise<string> {
  return toB64u(new Uint8Array(await subtle().exportKey('pkcs8', k.privateKey)));
}

/** Imports a stored pkcs8 key; non-extractable unless asked (the public half is read once during import). */
export async function importStaticPrivate(pkcs8B64u: string, o: { extractable?: boolean } = {}): Promise<StaticKey> {
  const der = fromB64u(pkcs8B64u);
  const tmp = await subtle().importKey('pkcs8', buf(der), X25519, true, ['deriveBits']);
  const publicRaw = await publicFromPrivate(tmp);
  const privateKey = o.extractable ? tmp : await subtle().importKey('pkcs8', buf(der), X25519, false, ['deriveBits']);
  return wrapKey(privateKey, publicRaw);
}

/** Test-vector helper: a raw 32-byte X25519 private key. */
export async function importRawPrivate(raw32: Uint8Array): Promise<StaticKey> {
  if (raw32.length !== DHLEN) throw new RangeError('raw X25519 private key must be 32 bytes');
  return importStaticPrivate(toB64u(concat(PKCS8_X25519_PREFIX, raw32)), { extractable: true });
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', buf(data)));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, buf(data)));
}

/** Noise §4.3 HKDF with two outputs (not WebCrypto's HKDF — the output split differs). */
async function hkdf2(ck: Uint8Array, ikm: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const temp = await hmac(ck, ikm);
  const out1 = await hmac(temp, new Uint8Array([1]));
  const out2 = await hmac(temp, concat(out1, new Uint8Array([2])));
  return [out1, out2];
}

/** §5.1. A failed decrypt leaves `n` unchanged. */
export class CipherState {
  /** Nonce counter. Public so tests can push it to the rekey limit. */
  n = 0n;
  private k: CryptoKey | null = null;

  async initializeKey(key: Uint8Array | null): Promise<void> {
    this.k = key ? await subtle().importKey('raw', buf(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) : null;
    this.n = 0n;
  }

  hasKey(): boolean { return this.k !== null; }

  private nonce(): Uint8Array {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, this.n, false);
    return iv;
  }

  async encrypt(ad: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
    if (!this.k) return plain;
    if (this.n >= NONCE_MAX) throw new RekeyNeeded('nonce exhausted');
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(this.nonce()), additionalData: buf(ad), tagLength: 128 }, this.k, buf(plain)));
    this.n += 1n;
    return ct;
  }

  async decrypt(ad: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
    if (!this.k) return ct;
    if (this.n >= NONCE_MAX) throw new RekeyNeeded('nonce exhausted');
    let pt: Uint8Array;
    try {
      pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(this.nonce()), additionalData: buf(ad), tagLength: 128 }, this.k, buf(ct)));
    } catch {
      throw new DecryptError('decrypt failed');
    }
    this.n += 1n;
    return pt;
  }
}

/** §5.2 */
class SymmetricState {
  readonly cs = new CipherState();
  ck: Uint8Array;
  h: Uint8Array;

  constructor() {
    const name = new TextEncoder().encode(PROTOCOL_NAME);
    this.h = new Uint8Array(HASHLEN); // name is ≤ HASHLEN bytes: pad with zeros
    this.h.set(name);
    this.ck = this.h.slice();
  }

  async mixKey(ikm: Uint8Array): Promise<void> {
    const [ck, tempK] = await hkdf2(this.ck, ikm);
    this.ck = ck;
    await this.cs.initializeKey(tempK);
  }

  async mixHash(data: Uint8Array): Promise<void> {
    this.h = await sha256(concat(this.h, data));
  }

  async encryptAndHash(plain: Uint8Array): Promise<Uint8Array> {
    const ct = await this.cs.encrypt(this.h, plain);
    await this.mixHash(ct);
    return ct;
  }

  async decryptAndHash(ct: Uint8Array): Promise<Uint8Array> {
    const pt = await this.cs.decrypt(this.h, ct);
    await this.mixHash(ct);
    return pt;
  }

  async split(): Promise<[CipherState, CipherState]> {
    const [k1, k2] = await hkdf2(this.ck, new Uint8Array(0));
    const c1 = new CipherState(); const c2 = new CipherState();
    await c1.initializeKey(k1); await c2.initializeKey(k2);
    return [c1, c2];
  }
}

/**
 * §5.3, KK only:
 *   -> s
 *   <- s
 *   ...
 *   -> e, es, ss
 *   <- e, ee, se
 */
export class HandshakeState {
  private readonly initiator: boolean;
  private readonly s: X25519Key;
  private readonly rs: Uint8Array;
  private injectedE: X25519Key | undefined;
  private e: X25519Key | undefined;
  private re: Uint8Array | undefined;
  private readonly ss = new SymmetricState();
  private readonly ready: Promise<void>;
  private step = 0; // 0: message 1 (-> e, es, ss), 1: message 2 (<- e, ee, se), 2: done
  private hash: Uint8Array | undefined;

  constructor(o: { initiator: boolean; prologue: Uint8Array; s: X25519Key; rs: Uint8Array; e?: X25519Key /* test vectors only */ }) {
    this.initiator = o.initiator;
    this.s = o.s;
    this.rs = o.rs;
    this.injectedE = o.e;
    // Pre-messages: initiator's s, then responder's s.
    const [iPub, rPub] = o.initiator ? [o.s.publicRaw, o.rs] : [o.rs, o.s.publicRaw];
    this.ready = (async () => {
      await this.ss.mixHash(o.prologue);
      await this.ss.mixHash(iPub);
      await this.ss.mixHash(rPub);
    })();
    this.ready.catch(() => undefined);
  }

  /** Available after `split()`. */
  get handshakeHash(): Uint8Array {
    if (!this.hash) throw new HandshakeError('handshake not finished');
    return this.hash.slice();
  }

  private writesNext(): boolean {
    return this.step === 0 ? this.initiator : this.step === 1 ? !this.initiator : false;
  }

  /** Message 2 tokens after `e`: `ee, se` (same on both sides once both ephemerals are known). */
  private async mixMessage2Tokens(): Promise<void> {
    const { e, re, s, rs } = this;
    if (!e || !re) throw new HandshakeError('missing ephemeral');
    await this.ss.mixKey(await e.dh(re));                                    // ee
    await this.ss.mixKey(this.initiator ? await s.dh(re) : await e.dh(rs)); // se
  }

  async writeMessage(payload: Uint8Array): Promise<Uint8Array> {
    try {
      await this.ready;
      if (!this.writesNext()) throw new HandshakeError('not our turn to write');
      if (payload.length > NOISE_MAX_MSG - DHLEN - TAGLEN) throw new HandshakeError('payload too large');
      this.e = this.injectedE ?? (await generateStaticKey({ extractable: false }));
      this.injectedE = undefined;
      await this.ss.mixHash(this.e.publicRaw);
      // Message 1 is written by the initiator: es = DH(e, rs), ss = DH(s, rs).
      if (this.step === 0) {
        await this.ss.mixKey(await this.e.dh(this.rs));  // es
        await this.ss.mixKey(await this.s.dh(this.rs));  // ss
      } else {
        await this.mixMessage2Tokens();
      }
      const ct = await this.ss.encryptAndHash(payload);
      this.step++;
      return concat(this.e.publicRaw, ct);
    } catch (err) {
      throw asHandshakeError(err);
    }
  }

  async readMessage(msg: Uint8Array): Promise<Uint8Array> {
    try {
      await this.ready;
      if (this.writesNext() || this.step > 1) throw new HandshakeError('not our turn to read');
      if (msg.length < DHLEN + TAGLEN || msg.length > NOISE_MAX_MSG) throw new HandshakeError('bad handshake message length');
      this.re = msg.slice(0, DHLEN);
      await this.ss.mixHash(this.re);
      if (this.step === 0) {
        await this.ss.mixKey(await this.s.dh(this.re));  // es
        await this.ss.mixKey(await this.s.dh(this.rs));  // ss
      } else {
        await this.mixMessage2Tokens();
      }
      const pt = await this.ss.decryptAndHash(msg.slice(DHLEN));
      this.step++;
      return pt;
    } catch (err) {
      throw asHandshakeError(err);
    }
  }

  async split(): Promise<{ send: CipherState; recv: CipherState }> {
    if (this.step !== 2) throw new HandshakeError('handshake not finished');
    const [c1, c2] = await this.ss.split();
    this.hash = this.ss.h.slice();
    return this.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}

function asHandshakeError(err: unknown): HandshakeError {
  if (err instanceof HandshakeError) return err;
  const e = new HandshakeError(err instanceof Error ? err.message : 'handshake failed');
  (e as { cause?: unknown }).cause = err;
  return e;
}

/** Post-handshake channel. Associated data is empty; replay, reordering and tampering all fail as `DecryptError`. */
export class Transport {
  constructor(readonly send: CipherState, readonly recv: CipherState) {}

  async encrypt(plain: Uint8Array): Promise<Uint8Array> {
    if (plain.length > NOISE_MAX_PLAINTEXT) throw new RangeError(`plaintext over ${NOISE_MAX_PLAINTEXT} bytes`);
    if (this.send.n >= REKEY_AT) throw new RekeyNeeded('send counter reached 2^32');
    return this.send.encrypt(new Uint8Array(0), plain);
  }

  async decrypt(ct: Uint8Array): Promise<Uint8Array> {
    if (this.recv.n >= REKEY_AT) throw new RekeyNeeded('receive counter reached 2^32');
    if (ct.length < TAGLEN || ct.length > NOISE_MAX_MSG) throw new DecryptError('bad transport message length');
    try {
      return await this.recv.decrypt(new Uint8Array(0), ct);
    } catch (err) {
      if (err instanceof DecryptError || err instanceof RekeyNeeded) throw err;
      throw new DecryptError('decrypt failed');
    }
  }
}

export function relayPrologue(deviceId: string, hostId: string): Uint8Array {
  return lp('aimsg-relay/2', deviceId, hostId);
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
export function isSemver(s: string): boolean {
  return s.length <= 40 && SEMVER.test(s);
}

function versionPayload(key: 'uiVersion' | 'hostVersion', version: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 2, [key]: version }));
}

function readVersion(key: 'uiVersion' | 'hostVersion', payload: Uint8Array): string {
  let j: unknown;
  try { j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { throw new HandshakeError('payload is not JSON'); }
  const o = j as Record<string, unknown> | null;
  const v = o && typeof o === 'object' ? o[key] : undefined;
  if (o?.v !== 2 || typeof v !== 'string' || !isSemver(v)) throw new HandshakeError(`payload needs v:2 and a semver ${key}`);
  return v;
}

/** Phone side (initiator). */
export async function deviceHandshake(o: { self: X25519Key; hostPublic: Uint8Array; deviceId: string; hostId: string; uiVersion: string }): Promise<{ msg1: Uint8Array; finish(msg2: Uint8Array): Promise<{ transport: Transport; hostVersion: string }> }> {
  const hs = new HandshakeState({ initiator: true, prologue: relayPrologue(o.deviceId, o.hostId), s: o.self, rs: o.hostPublic });
  const msg1 = await hs.writeMessage(versionPayload('uiVersion', o.uiVersion));
  return {
    msg1,
    async finish(msg2) {
      const hostVersion = readVersion('hostVersion', await hs.readMessage(msg2));
      const { send, recv } = await hs.split();
      return { transport: new Transport(send, recv), hostVersion };
    },
  };
}

/** Mac side (responder). `devicePublic` must come from the local trust list. */
export async function hostHandshake(o: { self: X25519Key; devicePublic: Uint8Array; deviceId: string; hostId: string; msg1: Uint8Array; hostVersion: string }): Promise<{ msg2: Uint8Array; transport: Transport; uiVersion: string }> {
  const hs = new HandshakeState({ initiator: false, prologue: relayPrologue(o.deviceId, o.hostId), s: o.self, rs: o.devicePublic });
  const uiVersion = readVersion('uiVersion', await hs.readMessage(o.msg1));
  const msg2 = await hs.writeMessage(versionPayload('hostVersion', o.hostVersion));
  const { send, recv } = await hs.split();
  return { msg2, transport: new Transport(send, recv), uiVersion };
}
