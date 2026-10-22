import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstanceLockedError } from '../instanceLock';
import { PortInUseError } from '../server';
import { loginUrl, runCli, type CliIo } from './app';

function fakeIo(env: NodeJS.ProcessEnv, isTTY = false) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo & { outText: () => string; errText: () => string } = {
    out: (s) => out.push(s), err: (s) => err.push(s), isTTY, env,
    outText: () => out.join('\n'), errText: () => err.join('\n'),
  };
  return io;
}

describe('runCli', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cli-'));
    fs.mkdirSync(path.join(root, 'home'));
    env = { HOME: path.join(root, 'home'), DECK_CONFIG_DIR: path.join(root, 'cfg'), PATH: '' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('port in use: one Korean line, fatal exit 78, no signal sent, mentions DECK_CONFIG_DIR', async () => {
    const io = fakeIo(env);
    const code = await runCli(['start'], io, { start: async () => { throw new PortInUseError(9320); } });
    expect(code).toBe(78);
    expect(io.errText().split('\n')).toHaveLength(1);
    expect(io.errText()).toMatch(/9320/);
    expect(io.errText()).toMatch(/--port/);
    expect(io.errText()).toMatch(/DECK_CONFIG_DIR/);
  });

  it('instance locked: names the holder port and DECK_CONFIG_DIR', async () => {
    const io = fakeIo(env);
    const holder = { pid: 4321, port: 9411, addresses: [], version: 't', configDir: '/c', startedAt: '', supervisor: null };
    const code = await runCli(['start'], io, { start: async () => { throw new InstanceLockedError('/c', holder, 'lock'); } });
    expect(code).toBe(78);
    expect(io.errText()).toMatch(/9411/);
    expect(io.errText()).toMatch(/4321/);
    expect(io.errText()).toMatch(/DECK_CONFIG_DIR/);
    const io2 = fakeIo(env);
    expect(await runCli(['start'], io2, { start: async () => { throw new InstanceLockedError('/c', null, 'relaunch-loop'); } })).toBe(78);
    expect(io2.errText()).toMatch(/relaunch/);
  });

  it('other start failures exit 1; under launchd a fatal failure waits 300 s first and the log file is capped', async () => {
    const io = fakeIo(env);
    expect(await runCli(['start'], io, { start: async () => { throw new Error('boom'); } })).toBe(1);
    const slept: number[] = [];
    const launchdEnv = { ...env, DECK_SUPERVISOR: 'launchd' };
    expect(await runCli(['start'], fakeIo(launchdEnv), { start: async () => { throw new Error('boom'); }, sleep: async (ms) => { slept.push(ms); } })).toBe(1);
    expect(slept).toEqual([]);
    fs.mkdirSync(env.DECK_CONFIG_DIR!);
    const log = path.join(env.DECK_CONFIG_DIR!, 'ai-msg.log');
    fs.writeFileSync(log, Buffer.alloc(10 * 1024 * 1024 + 1, 'x'));
    const io2 = fakeIo(launchdEnv);
    expect(await runCli(['start'], io2, { start: async () => { throw new PortInUseError(9320); }, sleep: async (ms) => { slept.push(ms); } })).toBe(78);
    expect(slept).toEqual([300_000]);
    expect(io2.errText()).toContain('300초');
    expect(fs.statSync(log).size).toBe(0);
    expect(fs.statSync(`${log}.1`).size).toBe(10 * 1024 * 1024 + 1);
  });

  it('prints the login URL on a TTY only', async () => {
    const tokenFile = path.join(root, 'token');
    fs.writeFileSync(tokenFile, 'abc\n');
    const info = { port: 9320, addresses: ['127.0.0.1'], tokenFile, tokenCreated: true, lockFile: path.join(root, 'server.lock') };
    const tty = fakeIo(env, true);
    expect(await runCli(['start'], tty, { start: async (o) => { o?.onListening?.(info); } })).toBe(0);
    expect(tty.outText()).toContain('http://127.0.0.1:9320/#token=abc');
    const pipe = fakeIo(env, false);
    expect(await runCli(['start'], pipe, { start: async (o) => { o?.onListening?.(info); } })).toBe(0);
    expect(pipe.outText()).not.toContain('#token=');
    expect(pipe.outText()).not.toContain('abc');
    expect(pipe.outText()).toContain(tokenFile);
  });

  it('--port sets DECK_PORT for loadConfig', async () => {
    let port = 0;
    expect(await runCli(['start', '--port', '9400'], fakeIo(env), { start: async (o) => { port = o?.cfg?.port ?? -1; } })).toBe(0);
    expect(port).toBe(9400);
  });

  it('login-url uses the running instance port from server.lock', async () => {
    fs.mkdirSync(env.DECK_CONFIG_DIR!);
    fs.writeFileSync(path.join(env.DECK_CONFIG_DIR!, 'token'), 'tok\n');
    fs.writeFileSync(path.join(env.DECK_CONFIG_DIR!, 'server.lock'), JSON.stringify({ pid: process.pid, port: 9411 }));
    const io = fakeIo(env);
    expect(await runCli(['login-url'], io)).toBe(0);
    expect(io.outText()).toBe('http://127.0.0.1:9411/#token=tok');
  });

  it('login-url without a running server: config port and a note; without a token: exit 1', async () => {
    const io = fakeIo({ ...env, DECK_PORT: '9500' });
    expect(await runCli(['login-url'], io)).toBe(1);
    expect(io.errText()).toMatch(/한 번 실행/);
    fs.mkdirSync(env.DECK_CONFIG_DIR!);
    fs.writeFileSync(path.join(env.DECK_CONFIG_DIR!, 'token'), 'tok\n');
    const io2 = fakeIo({ ...env, DECK_PORT: '9500' });
    expect(await runCli(['login-url'], io2)).toBe(0);
    expect(io2.outText()).toBe('http://127.0.0.1:9500/#token=tok');
    expect(io2.errText()).toMatch(/실행 중이 아닙니다/);
  });

  it('--version, --help, bad args', async () => {
    const v = fakeIo(env);
    expect(await runCli(['--version'], v)).toBe(0);
    expect(v.outText()).toBe(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')).version);
    const h = fakeIo(env);
    expect(await runCli(['--help'], h)).toBe(0);
    expect(h.outText()).toMatch(/login-url/);
    const b = fakeIo(env);
    expect(await runCli(['bogus'], b)).toBe(2);
    expect(b.errText()).not.toBe('');
  });

  it('service: dispatched to serviceAction; only the injected runner is used (never the real launchctl/systemctl)', async () => {
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(' ')); return { code: 3, stdout: 'inactive\n', stderr: '' }; };
    const io = fakeIo(env);
    expect(await runCli(['service', 'status'], io, { service: { run } })).toBe(0);
    expect(io.outText()).not.toBe('');
    expect(calls.every((c) => c.startsWith('launchctl ') || c.startsWith('systemctl '))).toBe(true);
    const d = fakeIo(env);
    expect(await runCli(['service', 'install', '--dry-run', '--port', '9555'], d, { service: { run, cliBins: () => ({}), execPath: '/usr/bin/node', bin: '/g/q/dist/server/bin.js' } })).toBe(process.platform === 'win32' ? 1 : 0);
    if (process.platform !== 'win32') expect(d.outText()).toMatch(/ai-msg/);
    expect(calls.filter((c) => /bootstrap|enable|daemon-reload/.test(c))).toEqual([]);
  });

  it('doctor: probes only through the injected runner, exit 0, --json is the same report', async () => {
    const codex = path.join(root, 'codex');
    fs.writeFileSync(codex, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
    const calls: string[] = [];
    const probeExec = async (bin: string, args: string[]) => {
      calls.push(`${path.basename(bin)} ${args.join(' ')}`);
      return args[0] === 'login' ? { code: 1, stdout: 'Not logged in\n', timedOut: false } : { code: 0, stdout: 'codex-cli 0.159.2\n', timedOut: false };
    };
    const e = { ...env, DECK_CODEX_BIN: codex };
    const io = fakeIo(e);
    expect(await runCli(['doctor'], io, { probeExec })).toBe(0);
    expect(calls.sort()).toEqual(['codex --version', 'codex login status']);
    const lines = io.outText().split('\n');
    expect(lines[0]).toMatch(/^claude .*찾지 못함/);
    expect(lines[1]).toMatch(/codex .*0\.159\.2.*로그인 안 됨.*codex login/);
    expect(fs.existsSync(path.join(root, 'cfg'))).toBe(false);
    const j = fakeIo(e);
    expect(await runCli(['doctor', '--json'], j, { probeExec })).toBe(0);
    const report = JSON.parse(j.outText()) as { engines: { engine: string; login: string }[]; claudeProfiles: unknown[] };
    expect(report.engines.map((x) => `${x.engine}:${x.login}`)).toEqual(['claude:unknown', 'codex:no', 'gemini:unknown', 'grok:unknown']);
  });

  it('loginUrl encodes the token', () => expect(loginUrl(9320, 'a+b')).toBe('http://127.0.0.1:9320/#token=a%2Bb'));
});

describe('runCli language', () => {
  it('--help follows the terminal language', async () => {
    const env = { HOME: os.tmpdir(), PATH: '' };
    const e = fakeIo({ ...env, LANG: 'en_US.UTF-8' });
    expect(await runCli(['--help'], e)).toBe(0);
    expect(e.outText().split('\n')[0]).toBe('Usage: ai-msg [command] [options]');
    const k = fakeIo({ ...env, LANG: 'ko_KR.UTF-8' });
    expect(await runCli(['--help'], k)).toBe(0);
    expect(k.outText().split('\n')[0]).toBe('사용법: ai-msg [명령] [옵션]');
  });
});
