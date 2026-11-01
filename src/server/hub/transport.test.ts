import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorText, withLastGood } from './shared';
import { createSpawnGate, createSystemdShow, fetchJsonWithTimeout, parseSystemdBlocks } from './status';

/* The hub's false 시간 초과: a pass starts dozens of children, and each spawn blocks the event loop. A stall longer than a
   probe's budget used to abort every probe in flight the moment it ended, because timers run before socket reads. */

const SERVER = `
  const http = require('node:http');
  http.createServer((req, res) => {
    if (req.url === '/silent') return;
    console.log('got');
    setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }, 150);
  }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });
`;
const block = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('probes on a stalled event loop', () => {
  let child: ChildProcess, base = '';
  beforeAll(async () => {
    child = spawn(process.execPath, ['-e', SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise<string>((resolve) => child.stdout!.once('data', (d: Buffer) => resolve(d.toString().trim())));
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => { child.kill(); });

  it('a healthy server answers during a stall longer than the budget: AbortSignal.timeout reports 시간 초과, the hub transport reads the answer', async () => {
    // Stall the moment the server has both requests: its answers (150 ms later) land in the socket buffer during the stall.
    const bothSeen = new Promise<void>((resolve) => {
      let seen = 0;
      const onData = (d: Buffer): void => { seen += d.toString().split('got').length - 1; if (seen >= 2) { child.stdout!.off('data', onData); resolve(); } };
      child.stdout!.on('data', onData);
    });
    const old = fetch(`${base}/ok`, { signal: AbortSignal.timeout(600) }).then((r) => r.json() as Promise<unknown>).then((v) => ({ v }), (err: unknown) => ({ err }));
    const now = fetchJsonWithTimeout(`${base}/ok`, 600);
    await bothSeen;
    block(1_500);
    const before = await old;
    expect('err' in before && errorText(before.err)).toBe('시간 초과'); // the bug, kept visible: the answer was in the socket buffer
    await expect(now).resolves.toEqual({ ok: true });
  });
  it('still times out on a server that really stays silent', async () => {
    const started = Date.now();
    const err = await fetchJsonWithTimeout(`${base}/silent`, 300).catch((e: unknown) => e);
    expect(errorText(err)).toBe('시간 초과');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it('cuts a silent source off at three budgets even if every tick stalls', async () => {
    const pending = fetchJsonWithTimeout(`${base}/silent`, 400).catch((e: unknown) => e);
    const started = Date.now();
    while (Date.now() - started < 1_300) { block(250); await sleep(1); }
    expect(errorText(await pending)).toBe('시간 초과');
  });
});

describe('createSpawnGate', () => {
  it('keeps at most `limit` children alive and yields to the loop between starts', async () => {
    const gate = createSpawnGate(2);
    let alive = 0, peak = 0, startsSinceYield = 0, maxBurst = 0;
    const yielder = setInterval(() => { startsSinceYield = 0; }, 0);
    const loop = (): void => { startsSinceYield = 0; if (running) setImmediate(loop); };
    let running = true;
    loop();
    const out = await Promise.all(Array.from({ length: 12 }, (_, i) => gate<number>((done) => {
      alive++; startsSinceYield++;
      peak = Math.max(peak, alive); maxBurst = Math.max(maxBurst, startsSinceYield);
      setTimeout(() => { alive--; done(i); }, 2);
    })));
    running = false;
    clearInterval(yielder);
    expect(out).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(peak).toBe(2);
    expect(maxBurst).toBe(1);
  });
});

describe('systemctl batching', () => {
  const block1 = 'LoadState=loaded\nActiveState=active\nResult=success\n', block2 = 'LoadState=not-found\nActiveState=inactive\n';
  it('maps blank-line separated blocks to the units in order, and refuses a count mismatch', () => {
    const m = parseSystemdBlocks(`${block1}\n${block2}\n`, ['a.service', 'b.service'])!;
    expect(m.get('a.service')).toEqual({ LoadState: 'loaded', ActiveState: 'active', Result: 'success' });
    expect(m.get('b.service')!.LoadState).toBe('not-found');
    expect(parseSystemdBlocks(block1, ['a.service', 'b.service'])).toBeNull();
  });
  it('one child answers every unit asked for in the same moment, duplicates included', async () => {
    const calls: string[][] = [];
    const show = createSystemdShow(async (units) => { calls.push(units); return units.map(() => block1).join('\n'); });
    const [a, b, a2] = await Promise.all([show('a.service'), show('b.service'), show('a.service')]);
    expect(calls).toEqual([['a.service', 'b.service']]);
    expect(a!.ActiveState).toBe('active');
    expect(b!.ActiveState).toBe('active');
    expect(a2).toEqual(a);
  });
  it('a flaky user bus is retried, then answered from the last good reading, and only then from nothing', async () => {
    let now = 1_000_000, mode: 'ok' | 'flake-once' | 'down' = 'ok', calls = 0;
    const show = createSystemdShow(async () => {
      calls++;
      if (mode === 'down' || (mode === 'flake-once' && calls === 1)) return null;
      return block1;
    }, () => now);
    expect((await show('a.service'))!.ActiveState).toBe('active');
    mode = 'flake-once'; calls = 0;
    expect((await show('a.service'))!.ActiveState).toBe('active');
    expect(calls).toBe(2);
    mode = 'down';
    expect((await show('a.service'))!.ActiveState).toBe('active'); // last good
    expect(await show('never-seen.service')).toBeNull();
    now += 6 * 60_000;
    expect(await show('a.service')).toBeNull(); // too old to stand in
  });
});

describe('withLastGood', () => {
  it('stands in on a timeout within the limit, never on a refused connection or an HTTP error', async () => {
    let now = 0, next: unknown = { n: 1 };
    const f = withLastGood(async () => { if (next instanceof Error) throw next; return next; }, () => now);
    await expect(f('u', 1)).resolves.toEqual({ n: 1 });
    next = new DOMException('probe budget spent', 'TimeoutError');
    now = 4 * 60_000;
    await expect(f('u', 1)).resolves.toEqual({ n: 1 });
    next = new Error('HTTP 503');
    await expect(f('u', 1)).rejects.toThrow('HTTP 503');
    next = new Error('fetch failed');
    await expect(f('u', 1)).rejects.toThrow('fetch failed');
    next = new DOMException('probe budget spent', 'TimeoutError');
    now = 6 * 60_000;
    await expect(f('u', 1)).rejects.toThrow('probe budget spent');
    await expect(f('other', 1)).rejects.toThrow('probe budget spent');
  });
});
