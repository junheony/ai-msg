import { describe, expect, it } from 'vitest';
import { verifyPaddleSignature } from '../src/paddle/signature';

const secret = 'test_' + 'secret_value';
async function sign(body: string, ts: number, key = secret) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${ts}:${body}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verifyPaddleSignature', () => {
  it('valid', async () => { const b = '{"a":1}'; expect(await verifyPaddleSignature(`ts=100;h1=${await sign(b, 100)}`, b, secret, 102)).toBe(true); });
  it('tampered body', async () => { const h = `ts=100;h1=${await sign('{"a":1}', 100)}`; expect(await verifyPaddleSignature(h, '{"a":2}', secret, 100)).toBe(false); });
  it('re-serialized body fails (raw body required)', async () => {
    const raw = '{ "a": 1 }';
    const h = `ts=100;h1=${await sign(raw, 100)}`;
    expect(await verifyPaddleSignature(h, JSON.stringify(JSON.parse(raw)), secret, 100)).toBe(false);
  });
  it('outside 5 s', async () => {
    const b = 'x';
    expect(await verifyPaddleSignature(`ts=100;h1=${await sign(b, 100)}`, b, secret, 106)).toBe(false);
    expect(await verifyPaddleSignature(`ts=100;h1=${await sign(b, 100)}`, b, secret, 94)).toBe(false);
    expect(await verifyPaddleSignature(`ts=100;h1=${await sign(b, 100)}`, b, secret, 105)).toBe(true);
  });
  it('one of several h1 matches', async () => { const b = 'x'; expect(await verifyPaddleSignature(`ts=100;h1=${'0'.repeat(64)};h1=${await sign(b, 100)}`, b, secret, 100)).toBe(true); });
  it('wrong secret / malformed header / missing header', async () => {
    const b = 'x';
    expect(await verifyPaddleSignature(`ts=100;h1=${await sign(b, 100, 'other_secret')}`, b, secret, 100)).toBe(false);
    expect(await verifyPaddleSignature(`h1=${await sign(b, 100)}`, b, secret, 100)).toBe(false);
    expect(await verifyPaddleSignature('ts=abc;h1=00', b, secret, 100)).toBe(false);
    expect(await verifyPaddleSignature('ts=100', b, secret, 100)).toBe(false);
    expect(await verifyPaddleSignature(null, b, secret, 100)).toBe(false);
  });
  it('an empty secret never verifies', async () => {
    const b = 'x';
    expect(await verifyPaddleSignature(`ts=100;h1=${'0'.repeat(64)}`, b, '', 100)).toBe(false);
  });
});
