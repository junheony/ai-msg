import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config';
import { acquireInstanceLock } from './instanceLock';
import { startServer } from './server';
import { AttachmentStore } from './attachments/AttachmentStore';
import { CodexUsagePoller } from './usage/CodexUsagePoller';
import { UsageIndex } from './usage/UsageIndex';
import { UsageService } from './usage/UsageService';

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
  it('a failure after listening stops what started, frees the port and releases the lock', async () => {
    // vapid.json is created late (after the usage pollers start): a non-empty directory there makes startup fail.
    fs.mkdirSync(path.join(cfgDir, 'vapid.json', 'x'), { recursive: true });
    const stops = [UsageService, CodexUsagePoller, UsageIndex, AttachmentStore].map((C) => vi.spyOn(C.prototype, 'stop'));
    const probe = http.createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    try {
      await expect(startServer({ cfg: tmpCfg(port) })).rejects.toThrow(/EISDIR|ENOTEMPTY|EEXIST/);
      for (const s of stops) expect(s).toHaveBeenCalledTimes(1);
    } finally {
      for (const s of stops) s.mockRestore();
    }
    expect(fs.existsSync(path.join(cfgDir, 'server.lock'))).toBe(false);
    const again = http.createServer().listen(port, '127.0.0.1');
    await once(again, 'listening');
    await new Promise<void>((r) => again.close(() => r()));
  });
});
