import { expect, it } from 'vitest';
import { fromB64u, lp, toB64u } from './b64';
import { claimHash, confirmCode, encodePairUrl, pairingMac, parsePairHash, verifyPairingMac } from './pairing';

it('QR url round trip on the relay origin, hash only, v2', () => {
  const hostPub = toB64u(new Uint8Array(32).fill(7));
  const url = encodePairUrl({ v: 2, pairingId: 'p1', claim: 'c', auth: 'a', hostPub, hostVersion: '1.2.3', relayOrigin: 'https://relay.example' });
  expect(url).toBe(`https://relay.example/v/1.2.3/#pair=2.p1.c.a.${hostPub}`);
  expect(parsePairHash(new URL(url).hash)).toEqual({ v: 2, pairingId: 'p1', claim: 'c', auth: 'a', hostPub });
  expect(parsePairHash(`2.p1.c.a.${hostPub}`)).toEqual({ v: 2, pairingId: 'p1', claim: 'c', auth: 'a', hostPub });
  expect(parsePairHash('#pair=1.p1.c.a.h')).toBeNull();
  expect(parsePairHash('#pair=2.p1.c.a.short')).toBeNull();
  expect(parsePairHash(`#pair=2.p1..a.${hostPub}`)).toBeNull();
  expect(parsePairHash(`#pair=2.p1.c.a.${hostPub}.x`)).toBeNull();
  expect(() => encodePairUrl({ v: 2, pairingId: 'p1', claim: 'c', auth: 'a', hostPub, hostVersion: '../x', relayOrigin: 'https://relay.example' })).toThrow();
});
it('mac fails when the cloud swaps the device key, and lp removes boundary ambiguity', async () => {
  const mac = await pairingMac('auth', { pairingId: 'p1', devicePub: 'real', hostPub: 'h' });
  expect(await verifyPairingMac('auth', { pairingId: 'p1', devicePub: 'real', hostPub: 'h' }, mac)).toBe(true);
  expect(await verifyPairingMac('auth', { pairingId: 'p1', devicePub: 'swapped', hostPub: 'h' }, mac)).toBe(false);
  expect(await verifyPairingMac('other', { pairingId: 'p1', devicePub: 'real', hostPub: 'h' }, mac)).toBe(false);
  expect(await pairingMac('k', { pairingId: 'ab', devicePub: 'c', hostPub: 'h' })).not.toBe(await pairingMac('k', { pairingId: 'a', devicePub: 'bc', hostPub: 'h' }));
});
it('confirm code is 6 digits, stable, and changes with the device key', async () => {
  const a = await confirmCode({ pairingId: 'p1', devicePub: 'real', hostPub: 'h' });
  expect(a).toMatch(/^\d{6}$/);
  expect(await confirmCode({ pairingId: 'p1', devicePub: 'real', hostPub: 'h' })).toBe(a);
  expect(await confirmCode({ pairingId: 'p1', devicePub: 'swapped', hostPub: 'h' })).not.toBe(a);
});
it('confirm code follows the contract formula', async () => {
  const o = { pairingId: 'p1', devicePub: 'real', hostPub: 'h' };
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', lp('aimsg-sas-v1', o.pairingId, o.devicePub, o.hostPub) as BufferSource));
  const n = ((d[0]! << 24) >>> 0) + (d[1]! << 16) + (d[2]! << 8) + d[3]!;
  expect(await confirmCode(o)).toBe(String(n % 1_000_000).padStart(6, '0'));
});
it('claimHash is sha256 base64url of the claim secret', async () => {
  expect(await claimHash('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});
it('b64 helpers reject bad input and lp limits parts', () => {
  expect(() => fromB64u('ab+c')).toThrow(TypeError);
  expect(() => fromB64u('a')).toThrow(TypeError);
  expect(fromB64u(toB64u(new Uint8Array([0, 255, 1])))).toEqual(new Uint8Array([0, 255, 1]));
  expect(lp('a', new Uint8Array([1, 2]))).toEqual(new Uint8Array([0, 1, 97, 0, 2, 1, 2]));
  expect(() => lp(new Uint8Array(65536))).toThrow(RangeError);
});
