import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { PermissionBridge } from './bridge';
import { relayOutput } from './hookRelay';
import { HOOK_RELAY_FAILED_MESSAGE } from './texts';

const SCRIPT = path.join(__dirname, 'hookRelay.ts');
let bridge: PermissionBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

// Async spawn, not spawnSync: the bridge lives in this process and must keep serving while the child runs.
const run = (args: string[], stdin: string, token: string) => new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', DECK_BRIDGE_TOKEN: token }, timeout: 10_000 });
  let stdout = '';
  c.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  c.on('error', reject);
  c.on('close', (status) => resolve({ status, stdout }));
  c.stdin.end(stdin);
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
