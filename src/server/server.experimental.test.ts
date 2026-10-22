import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadConfig, type DeckConfig } from './config';
import { startServer } from './server';

/**
 * startServer's 실험적 기능 wiring (settings → Grok Bot / Claude Desktop sources), end to end on a temp home. Startup is
 * made to fail after the first index refresh (a directory where vapid.json goes, as in server.order.test), so no server
 * is left running; by then the settings migration is written and the sources were read (or not).
 */
describe('startServer 실험적 기능 wiring', () => {
  let root: string;
  let home: string;
  let cfgDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-exp-'));
    home = path.join(root, 'home');
    cfgDir = path.join(root, 'cfg');
    fs.mkdirSync(path.join(cfgDir, 'vapid.json', 'x'), { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function freePort(): Promise<number> {
    const probe = http.createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return port;
  }

  /** Runs startServer until it fails at vapid.json; returns every path fs/promises readdir / readFile / stat was asked for. */
  async function start(): Promise<{ cfg: DeckConfig; touched: string[] }> {
    const cfg = loadConfig({ DECK_CONFIG_DIR: cfgDir, DECK_PORT: String(await freePort()), DECK_LOOPBACK_ONLY: '1', PATH: '' }, home, root, () => {});
    for (const d of [cfg.desktopSessionsRoot, cfg.grokBotDir]) if (d) fs.mkdirSync(d, { recursive: true });
    const spies = [vi.spyOn(fsp, 'readdir'), vi.spyOn(fsp, 'readFile'), vi.spyOn(fsp, 'stat'), vi.spyOn(fsp, 'lstat')];
    await expect(startServer({ cfg })).rejects.toThrow(/EISDIR|ENOTEMPTY|EEXIST/);
    const touched = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
    for (const s of spies) s.mockRestore();
    return { cfg, touched };
  }
  const under = (touched: string[], dir: string | null) => (dir ? touched.filter((f) => f === dir || f.startsWith(dir + path.sep)) : []);

  it('fresh install: Grok Bot and Claude Desktop folders are never read; the decision is saved', async () => {
    const { cfg, touched } = await start();
    expect(JSON.parse(fs.readFileSync(cfg.settingsFile, 'utf8')).experimental).toEqual({ grokBot: false, desktop: false, localImports: true });
    expect(under(touched, cfg.desktopSessionsRoot)).toEqual([]);
    expect(under(touched, cfg.grokBotDir)).toEqual([]);
  });

  it('install from before the switches (deck session state there): both are read, as before; all on is saved', async () => {
    fs.writeFileSync(path.join(cfgDir, 'session-state.json'), '{}');
    const { cfg, touched } = await start();
    expect(JSON.parse(fs.readFileSync(cfg.settingsFile, 'utf8')).experimental).toEqual({ grokBot: true, desktop: true, localImports: true });
    expect(under(touched, cfg.desktopSessionsRoot).length).toBeGreaterThan(0);
    if (cfg.grokBotDir) expect(under(touched, cfg.grokBotDir).length).toBeGreaterThan(0);
  });
});
