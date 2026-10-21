import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { listenAll } from './server';

async function freePort(): Promise<number> {
  const s = http.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('listenAll', () => {
  it('EADDRINUSE becomes PortInUseError', async () => {
    const blocker = http.createServer().listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(listenAll([http.createServer()], port, ['127.0.0.1'])).rejects.toMatchObject({ name: 'PortInUseError', port });
    } finally {
      blocker.close();
    }
  });

  it('partial failure closes the servers already bound', async () => {
    const port = await freePort();
    const s1 = http.createServer();
    const s2 = http.createServer();
    await expect(listenAll([s1, s2], port, ['127.0.0.1', '192.0.2.1'])).rejects.toThrow();
    expect(s1.listening).toBe(false);
    const again = http.createServer().listen(port, '127.0.0.1');
    await once(again, 'listening');
    await new Promise((r) => again.close(r));
  });

  it('all addresses bound on success', async () => {
    const port = await freePort();
    const s1 = http.createServer();
    await listenAll([s1], port, ['127.0.0.1']);
    expect(s1.listening).toBe(true);
    await new Promise((r) => s1.close(r));
  });
});
