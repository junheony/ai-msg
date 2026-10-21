import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config';
import { acquireInstanceLock } from './instanceLock';
import { startServer } from './server';

describe('startServer write order', () => {
  let root: string;
  let home: string;
  let cfgDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-order-'));
    home = path.join(root, 'home');
    fs.mkdirSync(home);
    cfgDir = path.join(root, 'cfg');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const tmpCfg = (port: number) => loadConfig({ DECK_CONFIG_DIR: cfgDir, DECK_PORT: String(port), DECK_LOOPBACK_ONLY: '1', PATH: '' }, home, root, () => {});

  it('port in use: config dir untouched (no token, no cache, no lock left)', async () => {
    const blocker = http.createServer().listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(startServer({ cfg: tmpCfg(port) })).rejects.toMatchObject({ name: 'PortInUseError', port });
    } finally {
      blocker.close();
    }
    expect(fs.existsSync(cfgDir) ? fs.readdirSync(cfgDir) : []).toEqual([]);
  });

  it('lock held by another live server: nothing written', async () => {
    fs.mkdirSync(cfgDir);
    const held = await acquireInstanceLock(cfgDir, { pid: process.pid, port: 1, version: 't', supervisor: null });
    const before = fs.readFileSync(path.join(cfgDir, 'server.lock'), 'utf8');
    try {
      await expect(startServer({ cfg: tmpCfg(0) })).rejects.toMatchObject({ name: 'InstanceLockedError', reason: 'lock' });
      expect(fs.readdirSync(cfgDir)).toEqual(['server.lock']);
      expect(fs.readFileSync(path.join(cfgDir, 'server.lock'), 'utf8')).toBe(before);
    } finally {
      held.release();
    }
  });
});
