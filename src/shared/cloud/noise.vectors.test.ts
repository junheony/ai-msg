import { describe, expect, it } from 'vitest';
import vectors from './noise.fixtures/kk-vectors.json';
import { HandshakeState, Transport, importRawPrivate } from './noise';
import { fromHex, toHex } from './testHex';

type V = {
  protocol_name: string; init_prologue: string; resp_prologue: string;
  init_static: string; init_ephemeral: string; init_remote_static: string;
  resp_static: string; resp_ephemeral: string; resp_remote_static: string;
  handshake_hash?: string; messages: { payload: string; ciphertext: string }[];
};
const kk = (vectors as { vectors: V[] }).vectors.filter((v) => v.protocol_name === 'Noise_KK_25519_AESGCM_SHA256');

describe('Noise KK official vectors', () => {
  it('has at least one vector', () => expect(kk.length).toBeGreaterThan(0));
  it.each(kk.map((v, i) => [i, v] as const))('vector %i reproduces every ciphertext', async (_i, v) => {
    const init = new HandshakeState({
      initiator: true, prologue: fromHex(v.init_prologue),
      s: await importRawPrivate(fromHex(v.init_static)), rs: fromHex(v.init_remote_static),
      e: await importRawPrivate(fromHex(v.init_ephemeral)),
    });
    const resp = new HandshakeState({
      initiator: false, prologue: fromHex(v.resp_prologue),
      s: await importRawPrivate(fromHex(v.resp_static)), rs: fromHex(v.resp_remote_static),
      e: await importRawPrivate(fromHex(v.resp_ephemeral)),
    });
    const [m1, m2, ...rest] = v.messages;
    if (!m1 || !m2) throw new Error('vector needs two handshake messages');
    expect(toHex(await init.writeMessage(fromHex(m1.payload)))).toBe(m1.ciphertext);
    expect(toHex(await resp.readMessage(fromHex(m1.ciphertext)))).toBe(m1.payload);
    expect(toHex(await resp.writeMessage(fromHex(m2.payload)))).toBe(m2.ciphertext);
    expect(toHex(await init.readMessage(fromHex(m2.ciphertext)))).toBe(m2.payload);
    const i = await init.split(); const r = await resp.split();
    if (v.handshake_hash) expect(toHex(init.handshakeHash)).toBe(v.handshake_hash);
    expect(toHex(resp.handshakeHash)).toBe(toHex(init.handshakeHash));
    const iT = new Transport(i.send, i.recv); const rT = new Transport(r.send, r.recv);
    // KK 는 메시지 3 부터 개시자·응답자가 번갈아 보낸다(벡터 형식 그대로).
    for (const [k, m] of rest.entries()) {
      const [tx, rx] = k % 2 === 0 ? [iT, rT] : [rT, iT];
      expect(toHex(await tx.encrypt(fromHex(m.payload)))).toBe(m.ciphertext);
      expect(toHex(await rx.decrypt(fromHex(m.ciphertext)))).toBe(m.payload);
    }
  });
});
