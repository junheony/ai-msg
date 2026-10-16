import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RELAUNCH_LOOP_RE, ServerUpdateWatch, sourceMtimes, supervisionCheck, type SupervisionProbe } from './serverUpdate';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });

/** A throwaway source root with files at `rel` → mtime (ms). */
async function root(files: Record<string, number>): Promise<string> {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-src-'));
  dirs.push(r);
  for (const [rel, at] of Object.entries(files)) await touch(r, rel, at);
  return r;
}
async function touch(r: string, rel: string, at: number): Promise<void> {
  const p = path.join(r, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, '//');
  await fs.utimes(p, at / 1000, at / 1000);
}

const T = 1_800_000_000_000;

describe('serverUpdate', () => {
  it('sourceMtimes: non-test .ts under src/server and src/shared only', async () => {
    const r = await root({ 'src/server/a.ts': T, 'src/server/sub/b.ts': T, 'src/shared/c.ts': T, 'src/server/a.test.ts': T, 'src/server/x.js': T, 'src/ui/d.ts': T, 'scripts/e.ts': T });
    expect((await sourceMtimes(r)).length).toBe(3);
  });

  it('counts files edited after the start (sub dirs too); tests and other dirs are ignored', async () => {
    const r = await root({ 'src/server/a.ts': T - 60_000, 'src/shared/b.ts': T - 60_000 });
    let now = T + 1000;
    const w = new ServerUpdateWatch({ root: r, startedAt: T, minMs: 0, now: () => now });
    await w.start();
    expect(await w.check()).toEqual({ changedFiles: 0, newestAt: null });
    await touch(r, 'src/server/a.ts', T + 5000);
    await touch(r, 'src/shared/deep/n.ts', T + 9000);
    await touch(r, 'src/server/a.test.ts', T + 9500);
    await touch(r, 'src/ui/x.ts', T + 9500);
    now += 1000;
    expect(await w.check()).toEqual({ changedFiles: 2, newestAt: T + 9000 });
  });

  it('a file dated past the start at the first scan sets the baseline (not pending forever)', async () => {
    const r = await root({ 'src/server/a.ts': T + 3_600_000 });
    const w = new ServerUpdateWatch({ root: r, startedAt: T, minMs: 0 });
    await w.start();
    expect((await w.check()).changedFiles).toBe(0);
    await touch(r, 'src/server/a.ts', T + 3_700_000);
    expect((await w.check()).changedFiles).toBe(1);
  });

  it('re-scans at most every minMs; a missing tree is no change', async () => {
    const r = await root({ 'src/server/a.ts': T - 1 });
    let now = T;
    const w = new ServerUpdateWatch({ root: r, startedAt: T, minMs: 60_000, now: () => now });
    expect((await w.check()).changedFiles).toBe(0);
    await touch(r, 'src/server/a.ts', T + 10);
    now += 30_000;
    expect((await w.check()).changedFiles).toBe(0);
    now += 30_000;
    expect((await w.check()).changedFiles).toBe(1);
    const none = new ServerUpdateWatch({ root: path.join(r, 'nope'), startedAt: T, minMs: 0 });
    expect(await none.check()).toEqual({ changedFiles: 0, newestAt: null });
  });
});

describe('supervisionCheck', () => {
  const LOOP = '/bin/sh /Users/u/.config/deck/relaunch.sh 8615';
  const probe = (o: { ppid?: number; cmd?: string | null; loopPid?: number }): SupervisionProbe => ({ ppid: () => o.ppid ?? 500, command: async () => (o.cmd === undefined ? LOOP : o.cmd), loopPid: async () => o.loopPid });
  const sup = (p: SupervisionProbe, env = true) => supervisionCheck({ env, pidFile: '/x', probe: p, ttlMs: 0 })();

  it('RELAUNCH_LOOP_RE: the loop shape only', () => {
    expect(RELAUNCH_LOOP_RE.test(LOOP)).toBe(true);
    expect(RELAUNCH_LOOP_RE.test('/bin/sh /Users/u/.config/deck/relaunch.sh')).toBe(true);
    expect(RELAUNCH_LOOP_RE.test('sh relaunch.sh')).toBe(true);
    expect(RELAUNCH_LOOP_RE.test("zsh -c '/x/relaunch.sh stop && bash run.sh'")).toBe(false);
    expect(RELAUNCH_LOOP_RE.test('/bin/sh /x/relaunch.sh.bak')).toBe(false);
    expect(RELAUNCH_LOOP_RE.test('vim relaunch.sh')).toBe(false);
  });

  it('under the loop (and relaunch.pid naming it, or no file): supervised', async () => {
    expect(await sup(probe({}))).toBe(true);
    expect(await sup(probe({ loopPid: 500 }))).toBe(true);
  });

  it('refused: no DECK_SUPERVISED, parent gone (orphaned → ppid 1, or no process), parent not the loop, relaunch.pid naming another pid', async () => {
    expect(await sup(probe({}), false)).toBe(false);
    expect(await sup(probe({ ppid: 1 }))).toBe(false);
    expect(await sup(probe({ cmd: null }))).toBe(false);
    expect(await sup(probe({ cmd: '/sbin/launchd' }))).toBe(false);
    expect(await sup(probe({ cmd: "zsh -c 'relaunch.sh stop && bash run.sh'" }))).toBe(false);
    expect(await sup(probe({ loopPid: 777 }))).toBe(false);
    expect(await sup(probe({ loopPid: NaN }))).toBe(false);
  });

  it('cached for ttlMs, then checked again', async () => {
    let t = 0;
    let ppid = 500;
    const check = supervisionCheck({ env: true, pidFile: '/x', probe: { ppid: () => ppid, command: async () => LOOP, loopPid: async () => undefined }, ttlMs: 3000, now: () => t });
    expect(await check()).toBe(true);
    ppid = 1;
    t = 2000;
    expect(await check()).toBe(true);
    t = 3000;
    expect(await check()).toBe(false);
  });

  it('the default probe reads relaunch.pid from disk (a temp dir)', async () => {
    const r = await root({});
    const pidFile = path.join(r, 'relaunch.pid');
    await fs.writeFile(pidFile, '424242\n');
    // This test process's parent is not a relaunch loop: refused before the file matters.
    expect(await supervisionCheck({ env: true, pidFile, ttlMs: 0 })()).toBe(false);
  });
});
