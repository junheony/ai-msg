import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { PermissionBridge } from './bridge';
import { CLOSED_RELAY_DEADLINE_MS, relayDeadlineMs, relayOutput } from './hookRelay';
import { HOOK_RELAY_FAILED_MESSAGE } from './texts';

const SCRIPT = path.join(__dirname, 'hookRelay.ts');
let bridge: PermissionBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

// Async spawn, not spawnSync: the bridge lives in this process and must keep serving while the child runs.
const run = (args: string[], stdin: string | null, token: string, env: Record<string, string> = {}) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', DECK_BRIDGE_TOKEN: token, ...env }, timeout: 10_000 });
  let stdout = '';
  let stderr = '';
  c.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  c.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  c.on('error', reject);
  c.on('close', (status) => resolve({ status, stdout, stderr }));
  if (stdin !== null) c.stdin.end(stdin);
});

describe('relayOutput', () => {
  it('passes a 200 body through; failures follow the fail mode', () => {
    expect(relayOutput('open', 200, '{"a":1}')).toBe('{"a":1}');
    expect(relayOutput('open', null, '')).toBe('{}');
    expect(JSON.parse(relayOutput('deny', 401, ''))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: HOOK_RELAY_FAILED_MESSAGE } });
  });
});

describe('hookRelay.ts as the CLI runs it (plain node)', () => {
  it('posts stdin to the bridge and prints the answer', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ permission: async () => ({ behavior: 'deny', message: 'x' }), hook: async (i) => ({ hookSpecificOutput: { hookEventName: i.hook_event_name, additionalContext: 'N' } }) });
    const r = await run(['--sock', reg.socketPath, '--fail', 'open'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'p' }), reg.token);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'N' } });
  });
  it('dead socket: fail-open prints {}, fail-deny prints a deny', async () => {
    const sock = path.join(os.tmpdir(), 'qd-none', 'b.sock');
    const open = await run(['--sock', sock, '--fail', 'open'], '{"hook_event_name":"PreToolUse"}', 'x');
    expect(open.status).toBe(0);
    expect(JSON.parse(open.stdout)).toEqual({});
    const deny = await run(['--sock', sock, '--fail', 'deny'], '{"hook_event_name":"PreToolUse"}', 'x');
    expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('보안 #4: --fail closed (총사령탑 자동 턴)', () => {
  const isDeny = (out: string) => JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny';
  let server: http.Server | null = null;
  let dir: string | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
  });
  /** A socket that answers every request with `reply` (or never answers when null). */
  const fake = async (reply: { status: number; body: string } | null) => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-relay-'));
    const sock = path.join(dir, 'b.sock');
    server = http.createServer((req, res) => { req.resume(); if (reply) { res.writeHead(reply.status); res.end(reply.body); } });
    await new Promise<void>((r) => server!.listen(sock, () => r()));
    return sock;
  };

  it('relayOutput: a 200 body that is not a JSON object is a deny in closed mode only', () => {
    expect(relayOutput('closed', 200, '{"a":1}')).toBe('{"a":1}');
    expect(isDeny(relayOutput('closed', 200, 'not json'))).toBe(true);
    expect(isDeny(relayOutput('closed', 200, '[1]'))).toBe(true);
    expect(isDeny(relayOutput('closed', 500, '{}'))).toBe(true);
    expect(relayOutput('open', 200, 'not json')).toBe('not json');
  });
  it('a good answer passes through with exit 0', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ permission: async () => ({ behavior: 'deny', message: 'x' }), hook: async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }) });
    const r = await run(['--sock', reg.socketPath, '--fail', 'closed'], '{"hook_event_name":"PreToolUse"}', reg.token);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });
  it('dead socket: deny JSON, the reason on stderr, exit 2', async () => {
    const r = await run(['--sock', path.join(os.tmpdir(), 'qd-none', 'b.sock'), '--fail', 'closed'], '{"hook_event_name":"PreToolUse"}', 'x');
    expect(r.status).toBe(2);
    expect(isDeny(r.stdout)).toBe(true);
    expect(r.stderr).toContain(HOOK_RELAY_FAILED_MESSAGE);
  });
  it('an unparsable answer or a non-200: exit 2', async () => {
    const bad = await run(['--sock', await fake({ status: 200, body: 'garbage' }), '--fail', 'closed'], '{}', 'x');
    expect(bad.status).toBe(2);
    expect(isDeny(bad.stdout)).toBe(true);
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const gone = await run(['--sock', await fake({ status: 410, body: '{}' }), '--fail', 'closed'], '{}', 'x');
    expect(gone.status).toBe(2);
  });
  it('bad stdin: exit 2', async () => {
    const r = await run(['--sock', path.join(os.tmpdir(), 'qd-none', 'b.sock'), '--fail', 'closed'], 'not json', 'x');
    expect(r.status).toBe(2);
  });
  it('past the deadline (a bridge that never answers, or stdin that never ends): exit 2', async () => {
    const sock = await fake(null);
    const slow = await run(['--sock', sock, '--fail', 'closed'], '{}', 'x', { DECK_HOOK_RELAY_DEADLINE_MS: '200' });
    expect(slow.status).toBe(2);
    expect(isDeny(slow.stdout)).toBe(true);
    const stuck = await run(['--sock', sock, '--fail', 'closed'], null, 'x', { DECK_HOOK_RELAY_DEADLINE_MS: '200' });
    expect(stuck.status).toBe(2);
  });
  it('the deadline knob (tests) can only shorten it', () => {
    expect(relayDeadlineMs({})).toBe(CLOSED_RELAY_DEADLINE_MS);
    expect(relayDeadlineMs({ DECK_HOOK_RELAY_DEADLINE_MS: '200' })).toBe(200);
    for (const v of ['9999999', '0', '-5', 'abc', '']) expect(relayDeadlineMs({ DECK_HOOK_RELAY_DEADLINE_MS: v })).toBe(CLOSED_RELAY_DEADLINE_MS);
  });
});
