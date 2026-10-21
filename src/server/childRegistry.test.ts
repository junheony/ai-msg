import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildRegistry } from './childRegistry';

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
    r.add({ pgid: 300, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: 't' }); // ours, dies on SIGTERM
    r.add({ pgid: 301, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: 't' }); // ours, ignores SIGTERM
    r.add({ pgid: 302, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: 't' }); // reused by another program
    r.add({ pgid: 303, bin: '/h/.grok/bin/grok', engine: 'grok', startedAt: 't' }); // already gone
    const alive = new Set([300, 301, 302]);
    const kills: string[] = [];
    const logs: string[] = [];
    const slept: number[] = [];
    const n = await ChildRegistry.open(file).reapStale({
      isAlive: (p) => alive.has(p),
      commandOf: (p) => (p === 302 ? '/usr/bin/vim notes.txt' : '/h/.grok/bin/grok agent stdio --secret-arg'),
      kill: (p, sig) => { kills.push(`${p}:${sig}`); if (sig === 'SIGKILL' || p === 300) alive.delete(p); },
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

  it('nothing recorded → no wait', async () => {
    const slept: number[] = [];
    expect(await ChildRegistry.open(file).reapStale({ isAlive: () => true, commandOf: () => 'x', kill: () => {}, sleep: async (ms) => { slept.push(ms); } })).toBe(0);
    expect(slept).toEqual([]);
  });
});
