import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LAUNCHD_LABEL } from './cli/service/record';
import { RELAUNCH_LOOP_RE, ServerUpdateWatch, sourceMtimes, startSupervisor, supervisionCheck, type SupervisionProbe } from './serverUpdate';

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
  const sup = (p: SupervisionProbe, env = true) => supervisionCheck({ supervisor: env ? 'relaunch' : null, pidFile: '/x', probe: p, ttlMs: 0 })();

  it('RELAUNCH_LOOP_RE: the loop shape only', () => {
    expect(RELAUNCH_LOOP_RE.test(LOOP)).toBe(true);
    expect(RELAUNCH_LOOP_RE.test('/bin/sh /Users/u/.config/deck/relaunch.sh')).toBe(true);
    expect(RELAUNCH_LOOP_RE.test('sh relaunch.sh')).toBe(true);
    expect(RELAUNCH_LOOP_RE.test("zsh -c '/x/relaunch.sh stop && bash run.sh'")).toBe(false);
    expect(RELAUNCH_LOOP_RE.test('/bin/sh /x/relaunch.sh.bak')).toBe(false);
    expect(RELAUNCH_LOOP_RE.test('vim relaunch.sh')).toBe(false);
  });

  it('relaunch supervisor keeps today’s rules: under the loop (and relaunch.pid naming it, or no file): supervised', async () => {
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
    const check = supervisionCheck({ supervisor: 'relaunch', pidFile: '/x', probe: { ppid: () => ppid, command: async () => LOOP, loopPid: async () => undefined }, ttlMs: 3000, now: () => t });
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
    expect(await supervisionCheck({ supervisor: 'relaunch', pidFile, ttlMs: 0 })()).toBe(false);
  });

  const svc = (servicePid: number | null, ppid = 1): SupervisionProbe => ({ ppid: () => ppid, command: async () => null, loopPid: async () => undefined, servicePid: async () => servicePid });

  it('systemd supervisor: supervised iff INVOCATION_ID set and MainPID is me', async () => {
    const check = (env: NodeJS.ProcessEnv, mainPid: number | null) => supervisionCheck({ supervisor: 'systemd', pidFile: '/x', env, platform: 'linux', pid: 4242, probe: svc(mainPid), ttlMs: 0 })();
    expect(await check({ INVOCATION_ID: 'abc' }, 4242)).toBe(true);
    expect(await check({}, 4242)).toBe(false);
    expect(await check({ INVOCATION_ID: 'abc' }, 999)).toBe(false);
    expect(await check({ INVOCATION_ID: 'abc' }, null)).toBe(false);
  });

  it('launchd supervisor: supervised iff XPC_SERVICE_NAME is our label and launchd pid is me; an orphan with ppid 1 is not', async () => {
    const check = (env: NodeJS.ProcessEnv, jobPid: number | null, platform: NodeJS.Platform = 'darwin') => supervisionCheck({ supervisor: 'launchd', pidFile: '/x', env, platform, pid: 4242, probe: svc(jobPid, 1), ttlMs: 0 })();
    expect(await check({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 4242)).toBe(true);
    expect(await check({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, null)).toBe(false);
    expect(await check({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 7)).toBe(false);
    expect(await check({ XPC_SERVICE_NAME: 'com.deck.server' }, 4242)).toBe(false);
    expect(await check({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 4242, 'linux')).toBe(false);
    expect(await supervisionCheck({ supervisor: null, pidFile: '/x', probe: svc(4242), ttlMs: 0 })()).toBe(false);
  });

  it('startSupervisor: the lock claims a manager only with its own markers and the right parent', () => {
    const commandOf = (pid: number) => (pid === 500 ? LOOP : '/sbin/launchd');
    const at = (supervisor: 'relaunch' | 'systemd' | 'launchd' | null, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, ppid: number) => startSupervisor({ supervisor, env, platform, pid: 4242, ppid, commandOf });
    expect(at('relaunch', {}, 'darwin', 500)).toBe('relaunch');
    expect(at('relaunch', {}, 'darwin', 1)).toBe(null);
    expect(at('systemd', { INVOCATION_ID: 'a', SYSTEMD_EXEC_PID: '4242' }, 'linux', 1)).toBe('systemd');
    expect(at('systemd', { INVOCATION_ID: 'a', MANAGERPID: '900' }, 'linux', 900)).toBe('systemd');
    expect(at('systemd', { INVOCATION_ID: 'a', SYSTEMD_EXEC_PID: '1' }, 'linux', 77)).toBe(null);
    expect(at('systemd', { SYSTEMD_EXEC_PID: '4242' }, 'linux', 1)).toBe(null);
    expect(at('launchd', { XPC_SERVICE_NAME: LAUNCHD_LABEL }, 'darwin', 1)).toBe('launchd');
    expect(at('launchd', { XPC_SERVICE_NAME: LAUNCHD_LABEL }, 'darwin', 77)).toBe(null);
    expect(at('launchd', { XPC_SERVICE_NAME: 'com.deck.server' }, 'darwin', 1)).toBe(null);
    expect(at(null, { INVOCATION_ID: 'a', SYSTEMD_EXEC_PID: '4242' }, 'linux', 1)).toBe(null);
  });
});

describe('ServerUpdateWatch package mode', () => {
  it('package mode: a newer package.json on disk means restartNeeded', async () => {
    const r = await root({ 'dist/server/bin.js': T });
    await fs.writeFile(path.join(r, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    const w = new ServerUpdateWatch({ root: r, startedAt: T, version: '0.1.0', minMs: 0 });
    await w.start();
    expect(await w.check()).toEqual({ changedFiles: 0, newestAt: null });
    await fs.writeFile(path.join(r, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    const u = await w.check();
    expect(u).toMatchObject({ changedFiles: 1, restartNeeded: true, reason: '패키지가 업그레이드됨' });
    expect(typeof u.newestAt).toBe('number');
    await fs.writeFile(path.join(r, 'package.json'), '{broken');
    expect((await w.check()).changedFiles).toBe(0);
  });

  it('a repo checkout (src/server present) keeps the mtime rule even with a version', async () => {
    const r = await root({ 'src/server/a.ts': T - 1 });
    await fs.writeFile(path.join(r, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const w = new ServerUpdateWatch({ root: r, startedAt: T, version: '0.1.0', minMs: 0 });
    await w.start();
    expect(await w.check()).toEqual({ changedFiles: 0, newestAt: null });
  });
});
