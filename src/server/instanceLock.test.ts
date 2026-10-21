import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireInstanceLock, readInstanceLock } from './instanceLock';

const DEAD = 2_147_000_000;

describe('instanceLock', () => {
  let root: string;
  let dir: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lock-')); dir = path.join(root, 'cfg'); fs.mkdirSync(dir); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = () => path.join(dir, 'server.lock');
  const writeLock = (v: object | string) => fs.writeFileSync(lockPath(), typeof v === 'string' ? v : JSON.stringify(v));

  it('second acquire on the same dir is refused while the first holder lives', async () => {
    const a = await acquireInstanceLock(dir, { pid: process.pid, port: 1, version: 't', supervisor: null });
    expect(a.tookOverStale).toBe(false);
    expect((fs.statSync(lockPath()).mode & 0o777).toString(8)).toBe('600');
    await expect(acquireInstanceLock(dir, { pid: 999999, port: 2, version: 't', supervisor: null })).rejects.toMatchObject({ name: 'InstanceLockedError', reason: 'lock', holder: { pid: process.pid, port: 1 } });
    a.release();
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('a stale lock (dead pid) is taken over and flagged', async () => {
    writeLock({ pid: DEAD, port: 5 });
    const l = await acquireInstanceLock(dir, { pid: process.pid, port: 6, version: 't', supervisor: null });
    expect(l.tookOverStale).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath(), 'utf8'))).toMatchObject({ pid: process.pid, port: 6 });
    l.release();
  });

  it('a reused pid running something else is stale', async () => {
    writeLock({ pid: 4242, port: 5 });
    const l = await acquireInstanceLock(dir, { pid: process.pid, port: 6, version: 't', supervisor: null, isAlive: () => true, commandOf: () => '/bin/sleep 100' });
    expect(l.tookOverStale).toBe(true);
    l.release();
  });

  it('a live node holder (by command) is not stale', async () => {
    writeLock({ pid: 4242, port: 5 });
    await expect(acquireInstanceLock(dir, { pid: process.pid, port: 6, version: 't', supervisor: null, isAlive: () => true, commandOf: () => 'node /x/bin.js start' })).rejects.toMatchObject({ reason: 'lock', holder: { pid: 4242 } });
  });

  it('a corrupt lock is stale', async () => {
    writeLock('{');
    const l = await acquireInstanceLock(dir, { pid: process.pid, port: 6, version: 't', supervisor: null });
    expect(l.tookOverStale).toBe(true);
    l.release();
  });

  it('unsupervised start refuses while a relaunch loop lives', async () => {
    fs.writeFileSync(path.join(dir, 'relaunch.pid'), '777\n');
    const probes = { isAlive: (p: number) => p === 777, commandOf: (p: number) => (p === 777 ? '/bin/sh /x/relaunch.sh' : null) };
    await expect(acquireInstanceLock(dir, { pid: process.pid, port: 6, version: 't', supervisor: null, ...probes })).rejects.toMatchObject({ reason: 'relaunch-loop' });
    expect(fs.existsSync(lockPath())).toBe(false);
    // DECK_SUPERVISED inherited by some other process: claims the loop, but the loop is not its parent.
    await expect(acquireInstanceLock(dir, { pid: process.pid, port: 6, version: 't', supervisor: 'relaunch', ppid: 778, ...probes })).rejects.toMatchObject({ reason: 'relaunch-loop' });
    const l = await acquireInstanceLock(dir, { pid: process.pid, port: 6, version: 't', supervisor: 'relaunch', ppid: 777, ...probes });
    l.release();
    // A dead loop pid does not block.
    const l2 = await acquireInstanceLock(dir, { pid: process.pid, port: 6, version: 't', supervisor: null, isAlive: () => false });
    l2.release();
  });

  it('release removes the dir it created when empty', async () => {
    const fresh = path.join(root, 'new', 'cfg');
    const l = await acquireInstanceLock(fresh, { pid: process.pid, port: 1, version: 't', supervisor: null });
    expect((fs.statSync(fresh).mode & 0o777).toString(8)).toBe('700');
    l.release();
    expect(fs.existsSync(fresh)).toBe(false);
    // An existing dir stays.
    const k = await acquireInstanceLock(dir, { pid: process.pid, port: 1, version: 't', supervisor: null });
    k.release();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('release leaves a lock that another pid now holds', async () => {
    const l = await acquireInstanceLock(dir, { pid: process.pid, port: 1, version: 't', supervisor: null });
    writeLock({ pid: 31337, port: 9 });
    l.release();
    expect(fs.existsSync(lockPath())).toBe(true);
  });

  it('update rewrites addresses and port', async () => {
    const l = await acquireInstanceLock(dir, { pid: process.pid, port: 1, version: 'v9', supervisor: null });
    await l.update({ addresses: ['127.0.0.1'], port: 9411 });
    expect(readInstanceLock(dir)).toMatchObject({ pid: process.pid, port: 9411, addresses: ['127.0.0.1'], version: 'v9', configDir: dir });
    l.release();
  });

  it('readInstanceLock ignores a dead holder', () => {
    writeLock({ pid: DEAD, port: 5 });
    expect(readInstanceLock(dir)).toBeNull();
    writeLock({ pid: process.pid, port: 5 });
    expect(readInstanceLock(dir)?.port).toBe(5);
    expect(readInstanceLock(path.join(root, 'missing'))).toBeNull();
  });
  it('stale takeover never removes a lock that replaced the stale one meanwhile', async () => {
    writeLock({ pid: 4242, port: 5 });
    const fresh = JSON.stringify({ pid: 5555, port: 9 });
    // pid 4242 now runs something else (stale); while it is being judged, a new server writes its lock.
    const commandOf = (p: number) => { if (p === 4242) { fs.writeFileSync(lockPath(), fresh); return '/bin/sleep 100'; } return 'node /x/bin.js start'; };
    await expect(acquireInstanceLock(dir, { pid: process.pid, port: 6, version: 't', supervisor: null, isAlive: () => true, commandOf })).rejects.toMatchObject({ reason: 'lock', holder: { pid: 5555 } });
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(fresh);
    expect(fs.readdirSync(dir).filter((f) => f !== 'server.lock')).toEqual([]);
  });
});
