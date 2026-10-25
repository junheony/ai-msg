import { expect, it } from 'vitest';
import { EnvKind, chunkBytes, chunkString, decodeEnvelope, encodeEnvelope, encodeTunnel, parseTunnelFrame } from './frames';

it('envelope round trip and peer limits', () => {
  const p = new Uint8Array([1, 2, 3]);
  expect(decodeEnvelope(encodeEnvelope({ kind: EnvKind.Data, peer: 'dev_abc', payload: p }))).toEqual({ kind: EnvKind.Data, peer: 'dev_abc', payload: p });
  expect(() => encodeEnvelope({ kind: EnvKind.Data, peer: 'x'.repeat(65), payload: p })).toThrow();
  expect(() => encodeEnvelope({ kind: EnvKind.Data, peer: 'dév', payload: p })).toThrow();
  expect(decodeEnvelope(new Uint8Array([9]))).toBeNull();
  expect(decodeEnvelope(new Uint8Array([9, 0]))).toBeNull();
  expect(decodeEnvelope(new Uint8Array([1, 65, ...new Uint8Array(65).fill(97)]))).toBeNull();
  expect(decodeEnvelope(new Uint8Array([1, 3, 97, 0xc3, 0xa9]))).toBeNull();
  expect(decodeEnvelope(new Uint8Array([1, 5, 97]))).toBeNull();
  expect(decodeEnvelope(new Uint8Array([4, 4, 104, 111, 115, 116]))).toEqual({ kind: EnvKind.Close, peer: 'host', payload: new Uint8Array() });
});
it('tunnel frames are validated', () => {
  expect(parseTunnelFrame({ t: 'ready' })).not.toBeNull();
  expect(parseTunnelFrame({ t: 'http.req', id: 1, m: 'GET', p: '/api/me', h: {}, more: false })).not.toBeNull();
  expect(parseTunnelFrame({ t: 'http.req', id: 1, m: 'TRACE', p: '/api/me', h: {}, more: false })).toBeNull();
  expect(parseTunnelFrame({ t: 'eval', code: '1' })).toBeNull();
  expect(parseTunnelFrame({ t: 'ws.msg', s: 1, d: 'x', more: true })).not.toBeNull();
  expect(parseTunnelFrame({ t: 'ws.close', s: 1 })).not.toBeNull();
  expect(parseTunnelFrame({ t: 'http.res', id: 1, st: 200, h: { 'content-type': 'text/plain' }, b: 'aGk=', more: false })).not.toBeNull();
  expect(parseTunnelFrame({ t: 'http.abort', id: -1 })).toBeNull();
  expect(parseTunnelFrame(null)).toBeNull();
});
it('chunks at 32 KiB and a full chunk still fits one Noise message', () => {
  expect(chunkBytes(new Uint8Array(32768 * 2 + 1)).map((c) => c.length)).toEqual([32768, 32768, 1]);
  expect(chunkBytes(new Uint8Array(0))).toEqual([]);
  const b = btoa(String.fromCharCode(...new Uint8Array(32768).fill(255)));
  expect(encodeTunnel({ t: 'http.chunk', id: 2_000_000_000, b, more: true }).length).toBeLessThanOrEqual(65519);
});
it('encodeTunnel refuses a frame that would not fit', () => {
  expect(() => encodeTunnel({ t: 'ws.msg', s: 1, d: 'x'.repeat(70000) })).toThrow(RangeError);
});
it('chunkString never splits a surrogate pair', () => {
  const s = 'a'.repeat(32767) + '😀';
  expect(chunkString(s).join('')).toBe(s);
  expect(chunkString(s)[0]!.endsWith('\ud83d')).toBe(false);
});
it('a full ws.msg chunk of 3-byte characters still fits one Noise message', () => {
  for (const s of ['가'.repeat(40000), '\u0001'.repeat(40000), '"'.repeat(40000), '😀'.repeat(20000)]) {
    const parts = chunkString(s);
    expect(parts.join('')).toBe(s);
    for (const d of parts) expect(encodeTunnel({ t: 'ws.msg', s: 1, d, more: true }).length).toBeLessThanOrEqual(65519);
  }
});
