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

  it('port in use: one Korean line, exit 1, no signal sent, mentions DECK_CONFIG_DIR', async () => {
    const io = fakeIo(env);
    const code = await runCli(['start'], io, { start: async () => { throw new PortInUseError(9320); } });
    expect(code).toBe(1);
    expect(io.errText().split('\n')).toHaveLength(1);
    expect(io.errText()).toMatch(/9320/);
    expect(io.errText()).toMatch(/--port/);
    expect(io.errText()).toMatch(/DECK_CONFIG_DIR/);
  });

  it('instance locked: names the holder port and DECK_CONFIG_DIR', async () => {
    const io = fakeIo(env);
    const holder = { pid: 4321, port: 9411, addresses: [], version: 't', configDir: '/c', startedAt: '', supervisor: null };
    const code = await runCli(['start'], io, { start: async () => { throw new InstanceLockedError('/c', holder, 'lock'); } });
    expect(code).toBe(1);
    expect(io.errText()).toMatch(/9411/);
    expect(io.errText()).toMatch(/4321/);
    expect(io.errText()).toMatch(/DECK_CONFIG_DIR/);
    const io2 = fakeIo(env);
    expect(await runCli(['start'], io2, { start: async () => { throw new InstanceLockedError('/c', null, 'relaunch-loop'); } })).toBe(1);
    expect(io2.errText()).toMatch(/relaunch/);
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

  it('--version, --help, bad args, not-yet commands', async () => {
    const v = fakeIo(env);
    expect(await runCli(['--version'], v)).toBe(0);
    expect(v.outText()).toBe(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')).version);
    const h = fakeIo(env);
    expect(await runCli(['--help'], h)).toBe(0);
    expect(h.outText()).toMatch(/login-url/);
    const b = fakeIo(env);
    expect(await runCli(['bogus'], b)).toBe(2);
    expect(b.errText()).not.toBe('');
    expect(await runCli(['doctor'], fakeIo(env))).toBe(2);
    expect(await runCli(['service', 'status'], fakeIo(env))).toBe(2);
  });

  it('loginUrl encodes the token', () => expect(loginUrl(9320, 'a+b')).toBe('http://127.0.0.1:9320/#token=a%2Bb'));
});
