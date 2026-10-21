import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildRegistry, processStartMs } from './childRegistry';

const T0 = '2026-10-21T10:00:00.000Z';
const t0 = Date.parse(T0);

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-children-'));
  file = path.join(dir, 'run', 'children.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ChildRegistry', () => {
  it('add/remove persist to run/children.json (0600) and survive a reopen', () => {
    const r = ChildRegistry.open(file);
    r.add({ pgid: 300, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: 't' });
    r.add({ pgid: 301, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: 't' });
    r.remove(300);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(ChildRegistry.open(file).list().map((e) => e.pgid)).toEqual([301]);
    fs.writeFileSync(file, '{broken');
    expect(ChildRegistry.open(file).list()).toEqual([]);
  });

  it('reapStale kills a live recorded group whose command matches, ignores a reused pgid', async () => {
    const r = ChildRegistry.open(file);
    r.add({ pgid: 300, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: T0 }); // ours, dies on SIGTERM
    r.add({ pgid: 301, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: T0 }); // ours, ignores SIGTERM
    r.add({ pgid: 302, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: T0 }); // reused by another program
    r.add({ pgid: 303, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: T0 }); // already gone
    const alive = new Set([300, 301, 302]);
    const kills: string[] = [];
    const logs: string[] = [];
    const slept: number[] = [];
    const n = await ChildRegistry.open(file).reapStale({
      isAlive: (p) => alive.has(p),
      commandOf: (p) => (p === 302 ? '/usr/bin/vim notes.txt' : '/h/.grok/bin/grok agent stdio --secret-arg'),
      kill: (p, sig) => { kills.push(`${p}:${sig}`); if (sig === 'SIGKILL' || p === 300) alive.delete(p); },
      startedAtOf: () => t0 + 1000,
      sleep: async (ms) => { slept.push(ms); },
      log: (l) => logs.push(l),
    });
    expect(n).toBe(2);
    expect(kills).toEqual(['300:SIGTERM', '301:SIGTERM', '301:SIGKILL']);
    expect(slept).toEqual([5000]);
    expect(alive.has(302)).toBe(true);
    expect(logs).toHaveLength(2);
    expect(logs.join('\n')).not.toContain('secret');
    expect(logs.join('\n')).toContain('pgid 301');
    expect(ChildRegistry.open(file).list()).toEqual([]);
  });

  it('reapStale leaves a group whose leader started at another time (pid reused by a new grok) or whose start time is unknown', async () => {
    const r = ChildRegistry.open(file);
    r.add({ pgid: 400, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: T0 }); // same command, started an hour later
    r.add({ pgid: 401, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: T0 }); // start time unreadable
    r.add({ pgid: 402, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: 'garbage' }); // record has no usable time
    r.add({ pgid: 403, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: T0 }); // within tolerance (4 s early)
    const kills: string[] = [];
    const starts: Record<number, number | null> = { 400: t0 + 3_600_000, 401: null, 402: t0, 403: t0 - 4000 };
    const n = await ChildRegistry.open(file).reapStale({
      isAlive: () => true,
      commandOf: () => '/h/.grok/bin/grok agent stdio',
      kill: (p, sig) => { kills.push(`${p}:${sig}`); },
      startedAtOf: (p) => starts[p] ?? null,
      sleep: async () => {},
      log: () => {},
    });
    expect(n).toBe(1);
    expect(kills).toEqual(['403:SIGTERM', '403:SIGKILL']);
    expect(ChildRegistry.open(file).list()).toEqual([]);
  });

  it('processStartMs reads this process\'s start time; a dead pid is null', () => {
    const ms = processStartMs(process.pid);
    expect(ms).not.toBeNull();
    expect(Math.abs(Date.now() - ms!)).toBeLessThan(24 * 3_600_000);
    expect(ms!).toBeLessThanOrEqual(Date.now());
    expect(processStartMs(2 ** 22 + 12345)).toBeNull();
  });

  it('nothing recorded → no wait', async () => {
    const slept: number[] = [];
    expect(await ChildRegistry.open(file).reapStale({ isAlive: () => true, commandOf: () => 'x', kill: () => {}, startedAtOf: () => null, sleep: async (ms) => { slept.push(ms); } })).toBe(0);
    expect(slept).toEqual([]);
  });
});
