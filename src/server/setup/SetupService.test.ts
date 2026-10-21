import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAccountRegistry } from '../accounts';
import type { DeckConfig } from '../config';
import type { ProbeExec } from './detect';
import { SetupService } from './SetupService';
import { SetupStore } from './SetupStore';

let root: string;
let home: string;
let configDir: string;
let calls: string[][];
const exec: ProbeExec = async (_bin, args, env) => {
  calls.push(args);
  if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ loggedIn: env.CLAUDE_CONFIG_DIR === undefined }), timedOut: false };
  return { code: 0, stdout: 'v1\n', timedOut: false };
};

function cfg(): Pick<DeckConfig, 'claudeBin' | 'codexBin' | 'geminiBin' | 'grokBin' | 'grokHome' | 'home' | 'configDir'> {
  return { claudeBin: { ok: true, bin: '/fake/claude', version: '9.9.9', belowRecommended: false }, codexBin: null, geminiBin: null, grokBin: null, grokHome: path.join(home, '.grok'), home, configDir };
}

async function service(o: { ttlMs?: number; now?: () => number; supervised?: boolean } = {}) {
  const accounts = loadAccountRegistry({ configDir, homeDir: home, log: () => {} });
  const store = await SetupStore.open(path.join(configDir, 'setup.json'), { existingInstall: false });
  return new SetupService({ cfg: cfg(), accounts, store, supervised: async () => o.supervised ?? false, addresses: ['http://127.0.0.1:9320'], exec, env: {}, ...(o.ttlMs !== undefined ? { ttlMs: o.ttlMs } : {}), ...(o.now ? { now: o.now } : {}) });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-setup-svc-')));
  home = path.join(root, 'home');
  configDir = path.join(root, 'config');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-b', 'projects'), { recursive: true });
  fs.mkdirSync(configDir);
  calls = [];
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('SetupService', () => {
  it('SetupService caches the probe for 30s and single-flights', async () => {
    let t = 0;
    const s = await service({ now: () => t });
    const [x, y] = await Promise.all([s.status(), s.status()]);
    expect(x).toEqual(y);
    const perProbe = calls.length;
    expect(perProbe).toBe(2); // two Claude profiles, no other CLI
    t = 29_000;
    await s.status();
    expect(calls.length).toBe(perProbe);
    t = 30_000;
    await s.status();
    expect(calls.length).toBe(perProbe * 2);
    await s.status(true);
    expect(calls.length).toBe(perProbe * 3);
  });

  it('a forced refresh shares the probe still running instead of starting another', async () => {
    const s = await service();
    const first = s.status();
    const forced = [s.status(true), s.status(true), s.status(true)];
    await Promise.all([first, ...forced]);
    expect(calls.length).toBe(2); // one probe: two Claude profiles
    await s.status(true); // nothing running any more: a new probe
    expect(calls.length).toBe(4);
  });

  it('status carries needed, supervision, addresses and the profile list', async () => {
    const s = await service({ supervised: true });
    const st = await s.status();
    expect(st).toMatchObject({ needed: true, supervised: true, restartNeeded: false, accountsFile: false, addresses: ['http://127.0.0.1:9320'] });
    expect(st.engines.map((e) => e.engine)).toEqual(['claude', 'codex', 'gemini', 'grok']);
    expect(st.claudeProfiles.map((p) => [p.id, p.active, p.login, p.dir])).toEqual([['a', true, 'yes', '~/.claude'], ['b', true, 'no', '~/.claude-b']]);
    expect(Number.isNaN(Date.parse(st.checkedAt))).toBe(false);
    await s.markDone();
    expect((await s.status()).needed).toBe(false);
  });

  it('restartNeeded after addProfile; new profile listed as inactive with its login command', async () => {
    const s = await service();
    await s.status();
    const r = await s.addProfile('d', 'Side');
    expect(r.restartNeeded).toBe(true);
    expect(r.profile).toMatchObject({ id: 'd', label: 'Side', active: false, dir: '~/.claude-d', loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-d claude auth login' });
    const st = await s.status();
    expect(st.restartNeeded).toBe(true);
    expect(st.accountsFile).toBe(true);
    expect(st.claudeProfiles.map((p) => [p.id, p.active])).toEqual([['a', true], ['b', true], ['d', false]]);
  });
});
