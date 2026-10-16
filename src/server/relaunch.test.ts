import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../scripts/relaunch.sh');

/** A throwaway config dir + repo whose run.sh is `body`. The loop's knobs are shrunk to seconds. */
async function world(body: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-relaunch-'));
  const conf = path.join(dir, 'conf');
  const repo = path.join(dir, 'repo');
  await fs.mkdir(path.join(repo, 'scripts', 'launchd'), { recursive: true });
  await fs.writeFile(path.join(repo, 'scripts', 'launchd', 'run.sh'), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const env = { ...process.env, DECK_CONFIG_DIR: conf, DECK_DIR: repo, DECK_RELAUNCH_BASE: '1', DECK_RELAUNCH_CAP: '2', DECK_RELAUNCH_HEALTHY: '60' };
  const log = async () => { try { return await fs.readFile(path.join(conf, 'deck.log'), 'utf8'); } catch { return ''; } };
  const run = (...args: string[]) => spawn('/bin/sh', [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const finished = (p: ChildProcess) => new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = '';
    p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    p.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    p.on('close', (code) => resolve({ code, out }));
  });
  const until = async (pred: (text: string) => boolean, ms = 8000) => {
    const t0 = Date.now();
    for (;;) { const text = await log(); if (pred(text)) return text; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for log; log so far:\n${text}`); await new Promise((r) => setTimeout(r, 100)); }
  };
  return { dir, conf, repo, env, log, run, finished, until };
}

const procs: ChildProcess[] = [];
afterEach(() => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } procs.length = 0; });

describe('scripts/relaunch.sh', () => {
  it('a server that keeps failing is retried with growing pauses, the cause named, and the loop never quits', async () => {
    const w = await world('exit 126');
    const loop = w.run(); procs.push(loop);
    const text = await w.until((t) => (t.match(/연속 빠른 실패/g) ?? []).length >= 3, 9000);
    expect(text).toContain('환경 거부(126)');
    expect(text).toContain('전체 디스크 접근 권한');
    expect(text).toMatch(/연속 빠른 실패 1 → 1s 뒤 재시작/);
    expect(text).toMatch(/연속 빠른 실패 2 → 2s 뒤 재시작/);
    expect(text).toMatch(/연속 빠른 실패 3 → 2s 뒤 재시작/); // capped
    expect(loop.exitCode).toBeNull();
    expect(text).toContain('포기하지 않음');
  }, 15_000);

  it('the server it starts sees DECK_SUPERVISED=1 (the UI may offer 지금 재시작)', async () => {
    const w = await world('echo "sup=${DECK_SUPERVISED:-none}"; sleep 2');
    const loop = w.run(); procs.push(loop);
    expect(await w.until((t) => t.includes('sup='))).toContain('sup=1');
  }, 15_000);

  it('only one loop at a time: a second start is refused; stop ends the loop but leaves the server running', async () => {
    const w = await world('echo "server up $$" >> "$HOME/../server.pid" 2>/dev/null; sleep 30');
    const loop = w.run(); procs.push(loop);
    await w.until((t) => t.includes('루프 시작'));
    const pid = Number((await fs.readFile(path.join(w.conf, 'relaunch.pid'), 'utf8')).trim());
    expect(pid).toBe(loop.pid);

    const second = await w.finished(w.run());
    expect(second.code).toBe(1);
    expect(second.out).toContain('이미 돌고 있습니다');
    expect(await w.log()).toContain('두 번째 루프 시도 거부');

    const status = await w.finished(w.run('status'));
    expect(status.code).toBe(0);
    expect(status.out).toContain(`pid ${pid}`);

    // The server (here: a sleeping bash) is the loop's child; stopping the loop must not take it down.
    const children = await new Promise<string>((resolve) => { let out = ''; const ps = spawn('pgrep', ['-P', String(pid)]); ps.stdout.on('data', (d: Buffer) => { out += d.toString(); }); ps.on('close', () => resolve(out)); });
    const serverPid = Number(children.trim().split('\n')[0]);
    expect(serverPid).toBeGreaterThan(0);

    const stop = await w.finished(w.run('stop'));
    expect(stop.code).toBe(0);
    expect(stop.out).toContain('서버는 그대로');
    await new Promise<void>((r) => loop.on('close', () => r()));
    expect(await fs.access(path.join(w.conf, 'relaunch.pid')).then(() => true, () => false)).toBe(false);
    expect(() => process.kill(serverPid, 0)).not.toThrow();
    process.kill(serverPid, 'SIGKILL');

    const after = await w.finished(w.run('status'));
    expect(after.code).toBe(1);
  }, 15_000);

  it('install copies itself next to the config and records the repo path', async () => {
    const w = await world('exit 0');
    const r = await w.finished(w.run('install'));
    expect(r.code).toBe(0);
    expect((await fs.stat(path.join(w.conf, 'relaunch.sh'))).mode & 0o111).toBeTruthy();
    expect(await fs.readFile(path.join(w.conf, 'relaunch.env'), 'utf8')).toBe(`DECK_DIR=${w.repo}\n`);
    expect(r.out).toContain('POSIX::setsid()');
  });
});
