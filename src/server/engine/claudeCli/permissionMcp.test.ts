// src/server/engine/claudeCli/permissionMcp.test.ts
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { PermissionBridge } from './bridge';
import { handleRpc, RELAY_FAILED_MESSAGE } from './permissionMcp';

const SCRIPT = path.join(__dirname, 'permissionMcp.ts');
let bridge: PermissionBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

describe('handleRpc', () => {
  const deps = (status = 200, body = '{"behavior":"allow","updatedInput":{}}') => ({ post: async () => ({ status, body }), inflight: new Map<string | number, AbortController>() });
  it('initialize / tools/list / ping / unknown', async () => {
    expect(await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, deps())).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'deck_bridge' } } });
    const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['permission']);
    expect(await handleRpc({ jsonrpc: '2.0', id: 3, method: 'ping' }, deps())).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps())).toBeNull();
    expect(await handleRpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, deps())).toMatchObject({ id: 4, error: { code: -32601 } });
  });
  it('tools/call returns the bridge reply as one text block; a failed relay denies', async () => {
    const ok = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'permission', arguments: { tool_name: 'Bash', input: {} } } }, deps()) as { result: { content: { type: string; text: string }[] } };
    expect(ok.result.content).toEqual([{ type: 'text', text: '{"behavior":"allow","updatedInput":{}}' }]);
    const bad = await handleRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'permission', arguments: {} } }, deps(401, '')) as { result: { content: { text: string }[] } };
    expect(JSON.parse(bad.result.content[0]!.text)).toEqual({ behavior: 'deny', message: RELAY_FAILED_MESSAGE });
    const thrown = await handleRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'permission', arguments: {} } }, { post: async () => { throw new Error('ECONNREFUSED'); }, inflight: new Map() }) as { result: { content: { text: string }[] } };
    expect(JSON.parse(thrown.result.content[0]!.text).behavior).toBe('deny');
  });
  it('notifications/cancelled aborts the matching in-flight call', async () => {
    const inflight = new Map<string | number, AbortController>();
    let seen: AbortSignal | null = null;
    const p = handleRpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'permission', arguments: {} } }, { inflight, post: (_p, _b, signal) => { seen = signal; return new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))); } });
    await handleRpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }, { inflight, post: async () => ({ status: 200, body: '' }) });
    await p;
    expect(seen!.aborted).toBe(true);
    expect(inflight.size).toBe(0);
  });
});

describe('permissionMcp.ts as a child process (plain node, no tsx)', () => {
  it('speaks newline-delimited JSON-RPC and relays tools/call to the bridge', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ permission: async (c) => ({ behavior: 'allow', updatedInput: { ...c.input, seen: c.tool_use_id } }), hook: async () => ({}) });
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT], { env: { PATH: process.env.PATH ?? '', DECK_BRIDGE_SOCK: reg.socketPath, DECK_BRIDGE_TOKEN: reg.token }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const rpc = async (m: object) => { child.stdin.write(JSON.stringify(m) + '\n'); return JSON.parse((await lines.next()).value as string); };
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result.serverInfo.name).toBe('deck_bridge');
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'permission', arguments: { tool_name: 'Write', input: { file_path: '/w/a' }, tool_use_id: 'toolu_1' } } });
    expect(JSON.parse(r.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { file_path: '/w/a', seen: 'toolu_1' } });
    const exited = new Promise((res) => child.once('exit', res));
    child.stdin.end();
    await exited;
  });
});
