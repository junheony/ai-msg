import { describe, expect, it } from 'vitest';
import * as envelope from './envelope';
import * as frames from './frames';

describe('envelope.ts (zod-free, compiled into the cloud Worker)', () => {
  it('frames.ts re-exports the same envelope API', () => {
    for (const name of ['CLOSE', 'EnvKind', 'MAX_FRAME', 'NOISE_MAX_PLAINTEXT', 'TUNNEL_CHUNK', 'decodeEnvelope', 'encodeEnvelope'] as const) {
      expect(frames[name]).toBe(envelope[name]);
    }
  });

  it('round-trips an envelope', () => {
    const e = { kind: envelope.EnvKind.Data, peer: 'dev-1', payload: new Uint8Array([1, 2, 3]) };
    expect(envelope.decodeEnvelope(envelope.encodeEnvelope(e))).toEqual(e);
  });
});
