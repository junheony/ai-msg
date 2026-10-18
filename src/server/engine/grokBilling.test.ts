import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentLog, fakeAgent } from './acp/fakeAcpAgent';
import type { SpawnFn } from './CodexEngine';
import { GrokEngineLock, type GrokDeps } from './GrokEngine';
import { GROK_BILLING_METHOD, parseGrokBilling, probeGrokBilling } from './grokBilling';

const FIXTURES = path.join(__dirname, 'acp', 'fixtures', 'grok-1.0.62');
const CLEAN_INSPECT = JSON.parse(fsSync.readFileSync(path.join(FIXTURES, 'inspect.clean.json'), 'utf8')) as unknown;
const CLAUDE_RULES_INSPECT = JSON.parse(fsSync.readFileSync(path.join(FIXTURES, 'inspect.claude-rules.json'), 'utf8')) as unknown;

const FAST = {
  lockMs: 2000, initializeMs: 2000, sessionMs: 2000, settingMs: 2000, cancelMs: 400, closeMs: 2000, termMs: 500, killMs: 1000,
  steerMs: 1000, categoryMs: 150, fallbackMs: 300, sampleMs: 2000, billingMs: 300,
};
const NOW = Date.parse('2026-10-18T10:00:00Z');
// The shape grok 1.0.62 answers `_x.ai/billing` with (values made up).
const SAMPLE = {
  config: {
    creditUsagePercent: 1.0,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-18T07:54:33.561+00:00', end: '2026-10-25T07:54:33.561+00:00' },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
  },
  subscription_tier: 'SuperGrok Heavy',
};

let tmp: string;
let home: string;
let realHome: string;
let homesDir: string;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-grok-billing-')));
  home = path.join(tmp, 'grokhome');
  realHome = path.join(tmp, 'realhome');
  homesDir = path.join(tmp, 'homes');
  await fs.mkdir(home);
  await fs.mkdir(realHome);
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

function deps(spawnFn: SpawnFn | undefined, over: Partial<GrokDeps> = {}): GrokDeps {
  return {
    bin: 'grok', grokHome: home, homesDir, realHome, inspect: async () => CLEAN_INSPECT, readConfig: async () => '',
    engineLock: new GrokEngineLock(), spawnFn, baseEnv: { PATH: process.env.PATH, HOME: realHome }, timeouts: FAST, ...over,
  };
}
const methods = (log: Array<Record<string, unknown>>) => log.map((m) => m.method).filter(Boolean);
const leftHomes = async () => (await fs.readdir(homesDir).catch(() => [] as string[]));

describe('parseGrokBilling', () => {
  it('reads the recorded shape: used %, the weekly window, the tier', () => {
    expect(parseGrokBilling(SAMPLE, NOW)).toEqual({
      usedPct: 1, windowStart: '2026-10-18T07:54:33.561+00:00', windowEnd: '2026-10-25T07:54:33.561+00:00',
      tier: 'SuperGrok Heavy', fetchedAt: '2026-10-18T10:00:00.000Z', periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
    });
  });

  it('no usable creditUsagePercent → null', () => {
    expect(parseGrokBilling({ config: {} }, NOW)).toBeNull();
    expect(parseGrokBilling({ config: { creditUsagePercent: 'x' } }, NOW)).toBeNull();
    expect(parseGrokBilling(null, NOW)).toBeNull();
    expect(parseGrokBilling([], NOW)).toBeNull();
  });

  it('clamps to 0–100, takes {val} numbers and the optional amounts when present', () => {
    const b = parseGrokBilling({
      config: {
        creditUsagePercent: { val: 140 }, billingPeriodStart: '2026-10-01T00:00:00Z', billingPeriodEnd: '2026-11-01T00:00:00Z',
        monthlyLimit: { val: 3000 }, onDemandCap: 500, onDemandUsed: '12', billingPeriodUsage: { includedUsed: 40, totalUsed: 52 },
      },
    }, NOW);
    expect(b).toEqual({
      usedPct: 100, windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-11-01T00:00:00Z', tier: null, fetchedAt: '2026-10-18T10:00:00.000Z',
      monthlyLimit: 3000, onDemandCap: 500, onDemandUsed: 12, includedUsed: 40, totalUsed: 52,
    });
    expect(parseGrokBilling({ config: { creditUsagePercent: -3 } }, NOW)?.usedPct).toBe(0);
  });
});

describe('probeGrokBilling', () => {
  it('only initialize + `_x.ai/billing` (no session, no prompt); the shadow HOME is gone afterwards', async () => {
    const agent = fakeAgent(tmp, `on('${GROK_BILLING_METHOD}', (p, id) => respond(id, ${JSON.stringify(SAMPLE)}));`);
    const r = await probeGrokBilling(deps(agent.spawnFn), () => NOW);
    expect(r).toEqual({ kind: 'ok', billing: expect.objectContaining({ usedPct: 1, tier: 'SuperGrok Heavy', fetchedAt: '2026-10-18T10:00:00.000Z' }) });
    expect(methods(agentLog(agent.logFile))).toEqual(['initialize', GROK_BILLING_METHOD]);
    expect(await leftHomes()).toEqual([]);
  });

  it('Method not found → unsupported', async () => {
    const agent = fakeAgent(tmp, '');
    expect(await probeGrokBilling(deps(agent.spawnFn))).toMatchObject({ kind: 'unsupported' });
    expect(await leftHomes()).toEqual([]);
  });

  it('no answer within billingMs → error (tried again later)', async () => {
    const agent = fakeAgent(tmp, `on('${GROK_BILLING_METHOD}', () => {});`);
    const t0 = Date.now();
    expect(await probeGrokBilling(deps(agent.spawnFn))).toMatchObject({ kind: 'error', message: expect.stringContaining('응답 없음') });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('an answer without a percent → error', async () => {
    const agent = fakeAgent(tmp, `on('${GROK_BILLING_METHOD}', (p, id) => respond(id, { config: {} }));`);
    expect(await probeGrokBilling(deps(agent.spawnFn))).toMatchObject({ kind: 'error' });
  });

  it('a login error → auth', async () => {
    const agent = fakeAgent(tmp, `on('${GROK_BILLING_METHOD}', (p, id) => fail(id, -32000, 'Authentication required'));`);
    expect(await probeGrokBilling(deps(agent.spawnFn))).toMatchObject({ kind: 'auth' });
  });

  it('a missing binary → no_bin (spawn ENOENT, or inspect ENOENT)', async () => {
    expect(await probeGrokBilling(deps(undefined, { bin: path.join(tmp, 'no-such-grok') }))).toMatchObject({ kind: 'no_bin' });
    const enoent = Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' });
    expect(await probeGrokBilling(deps(undefined, { inspect: async () => { throw enoent; } }))).toMatchObject({ kind: 'no_bin' });
    expect(await leftHomes()).toEqual([]);
  });

  it('the engine lock, an inspect refusal or an inspect failure → blocked, nothing spawned', async () => {
    let spawned = false;
    const noSpawn: SpawnFn = () => { spawned = true; throw new Error('no'); };
    const lock = new GrokEngineLock();
    lock.lock('test');
    expect(await probeGrokBilling(deps(noSpawn, { engineLock: lock }))).toMatchObject({ kind: 'blocked' });
    expect(await probeGrokBilling(deps(noSpawn, { inspect: async () => CLAUDE_RULES_INSPECT }))).toMatchObject({ kind: 'blocked' });
    expect(await probeGrokBilling(deps(noSpawn, { inspect: async () => { throw new Error('bad json'); } }))).toMatchObject({ kind: 'blocked' });
    expect(spawned).toBe(false);
    expect(await leftHomes()).toEqual([]);
  });
});
