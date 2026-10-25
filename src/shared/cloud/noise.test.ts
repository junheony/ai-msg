import { describe, expect, it } from 'vitest';
import { DecryptError, HandshakeError, RekeyNeeded, deviceHandshake, exportStaticPrivate, generateStaticKey, hostHandshake, importStaticPrivate, isSemver } from './noise';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

async function connect(o: { hostSelf?: Awaited<ReturnType<typeof generateStaticKey>>; hostDeviceId?: string; hostHostId?: string; tamper?: (m: Uint8Array) => void } = {}) {
  const host = await generateStaticKey({ extractable: true });
  const dev = await generateStaticKey({ extractable: false });
  const d = await deviceHandshake({ self: dev, hostPublic: host.publicRaw, deviceId: 'd1', hostId: 'h1', uiVersion: '1.0.0' });
  o.tamper?.(d.msg1);
  const h = await hostHandshake({ self: o.hostSelf ?? host, devicePublic: dev.publicRaw, deviceId: o.hostDeviceId ?? 'd1', hostId: o.hostHostId ?? 'h1', msg1: d.msg1, hostVersion: '1.2.3' });
  const fin = await d.finish(h.msg2);
  return { dev: fin.transport, host: h.transport, hostVersion: fin.hostVersion, uiVersion: h.uiVersion };
}

describe('noise relay handshake', () => {
  it('both sides learn the authenticated versions and talk both ways', async () => {
    const c = await connect();
    expect(c.hostVersion).toBe('1.2.3'); expect(c.uiVersion).toBe('1.0.0');
    expect(dec(await c.host.decrypt(await c.dev.encrypt(enc('{"t":"ready"}'))))).toBe('{"t":"ready"}');
    expect(dec(await c.dev.decrypt(await c.host.encrypt(enc('yo'))))).toBe('yo');
  });
  it('prologue mismatch (deviceId or hostId) fails the handshake', async () => {
    await expect(connect({ hostDeviceId: 'd2' })).rejects.toBeInstanceOf(HandshakeError);
    await expect(connect({ hostHostId: 'h2' })).rejects.toBeInstanceOf(HandshakeError);
  });
  it('a host without the paired static key cannot read message 1 (cloud in the middle)', async () => {
    const evil = await generateStaticKey({ extractable: true });
    await expect(connect({ hostSelf: evil })).rejects.toBeInstanceOf(HandshakeError);
  });
  it('a flipped bit anywhere in message 1 fails', async () => {
    await expect(connect({ tamper: (m) => { m[m.length - 1]! ^= 1; } })).rejects.toBeInstanceOf(HandshakeError);
    await expect(connect({ tamper: (m) => { m[0]! ^= 1; } })).rejects.toBeInstanceOf(HandshakeError);
  });
  it('a truncated message 1 fails with HandshakeError', async () => {
    await expect(connect({ tamper: (m) => { m.fill(0); } })).rejects.toBeInstanceOf(HandshakeError);
    const host = await generateStaticKey({ extractable: true }); const dev = await generateStaticKey({ extractable: false });
    await expect(hostHandshake({ self: host, devicePublic: dev.publicRaw, deviceId: 'd1', hostId: 'h1', msg1: new Uint8Array(40), hostVersion: '1.0.0' })).rejects.toBeInstanceOf(HandshakeError);
  });
  it('a relay cannot swap hostVersion: message 2 is authenticated', async () => {
    const host = await generateStaticKey({ extractable: true }); const dev = await generateStaticKey({ extractable: false });
    const d = await deviceHandshake({ self: dev, hostPublic: host.publicRaw, deviceId: 'd1', hostId: 'h1', uiVersion: '1.0.0' });
    const h = await hostHandshake({ self: host, devicePublic: dev.publicRaw, deviceId: 'd1', hostId: 'h1', msg1: d.msg1, hostVersion: '2.0.0' });
    h.msg2[h.msg2.length - 5]! ^= 1;
    await expect(d.finish(h.msg2)).rejects.toBeInstanceOf(HandshakeError);
  });
  it('hostHandshake rejects a non-semver version in the payload', async () => {
    const host = await generateStaticKey({ extractable: true }); const dev = await generateStaticKey({ extractable: false });
    const d = await deviceHandshake({ self: dev, hostPublic: host.publicRaw, deviceId: 'd1', hostId: 'h1', uiVersion: '../../evil' });
    await expect(hostHandshake({ self: host, devicePublic: dev.publicRaw, deviceId: 'd1', hostId: 'h1', msg1: d.msg1, hostVersion: '1.0.0' })).rejects.toBeInstanceOf(HandshakeError);
  });
  it('replayed, reordered and wrong-direction transport messages fail', async () => {
    const c = await connect();
    const f1 = await c.dev.encrypt(enc('1')); const f2 = await c.dev.encrypt(enc('2'));
    await expect(c.host.decrypt(f2)).rejects.toBeInstanceOf(DecryptError); // 순서 바꿈
    expect(dec(await c.host.decrypt(f1))).toBe('1');                         // 실패가 n 을 올리지 않았다
    await expect(c.host.decrypt(f1)).rejects.toBeInstanceOf(DecryptError); // 재전송
    await expect(c.dev.decrypt(await c.dev.encrypt(enc('x')))).rejects.toBeInstanceOf(DecryptError); // 방향
  });
  it('rejects oversize plaintext and signals rekey at 2^32', async () => {
    const c = await connect();
    await expect(c.dev.encrypt(new Uint8Array(65520))).rejects.toBeInstanceOf(RangeError);
    expect((await c.dev.encrypt(new Uint8Array(65519))).length).toBe(65535);
    (c.dev as unknown as { send: { n: bigint } }).send.n = 2n ** 32n;
    await expect(c.dev.encrypt(enc('x'))).rejects.toBeInstanceOf(RekeyNeeded);
  });
  it('the phone key stays non-extractable', async () => {
    const dev = await generateStaticKey({ extractable: false });
    expect(dev.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', dev.privateKey)).rejects.toThrow();
  });
  it('a stored host key round-trips through pkcs8 and still handshakes', async () => {
    const host = await generateStaticKey({ extractable: true });
    const back = await importStaticPrivate(await exportStaticPrivate(host));
    expect(back.publicRaw).toEqual(host.publicRaw);
    expect(back.privateKey.extractable).toBe(false);
    const dev = await generateStaticKey({ extractable: false });
    const d = await deviceHandshake({ self: dev, hostPublic: host.publicRaw, deviceId: 'd1', hostId: 'h1', uiVersion: '1.0.0' });
    const h = await hostHandshake({ self: back, devicePublic: dev.publicRaw, deviceId: 'd1', hostId: 'h1', msg1: d.msg1, hostVersion: '1.0.0' });
    expect((await d.finish(h.msg2)).hostVersion).toBe('1.0.0');
  });
  it('semver check', () => {
    expect(isSemver('1.2.3')).toBe(true); expect(isSemver('1.2.3-beta.1')).toBe(true);
    expect(isSemver('1.2')).toBe(false); expect(isSemver('1.2.3/../x')).toBe(false);
    expect(isSemver('1.2.3-' + 'a'.repeat(40))).toBe(false);
  });
});
