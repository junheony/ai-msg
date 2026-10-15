// src/server/engine/claudeCli/bridge.test.ts
import fs from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { PermissionBridge, type BridgeHandlers } from './bridge';
import { postBridge } from './permissionMcp';

let bridge: PermissionBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

const allowAll: BridgeHandlers = {
  permission: async (c) => ({ behavior: 'allow', updatedInput: c.input }),
  hook: async () => ({}),
};
const call = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' };

describe('PermissionBridge', () => {
  it('socket dir is private and the socket answers registered tokens only', async () => {
    bridge = await PermissionBridge.open();
    const dirMode = fs.statSync(bridge.socketPath.replace(/\/[^/]+$/, '')).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const reg = bridge.register(allowAll);
    const ok = await postBridge(reg.socketPath, reg.token, '/v1/permission', call);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect((await postBridge(reg.socketPath, 'wrong', '/v1/permission', call)).status).toBe(401);
    expect((await postBridge(reg.socketPath, reg.token, '/v1/nope', call)).status).toBe(404);
  });

  it('400 on a malformed body, 410 after dispose', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register(allowAll);
    expect((await postBridge(reg.socketPath, reg.token, '/v1/permission', { tool_name: 1 })).status).toBe(400);
    reg.dispose();
    expect((await postBridge(reg.socketPath, reg.token, '/v1/permission', call)).status).toBe(410);
  });

  it('routes hooks to the hook handler', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ ...allowAll, hook: async (i) => ({ echoed: i.hook_event_name }) });
    const r = await postBridge(reg.socketPath, reg.token, '/v1/hook', { hook_event_name: 'PreToolUse' });
    expect(JSON.parse(r.body)).toEqual({ echoed: 'PreToolUse' });
  });

  it('client disconnect aborts the handler signal (MCP notifications/cancelled path)', async () => {
    bridge = await PermissionBridge.open();
    let aborted = false;
    const reg = bridge.register({ ...allowAll, permission: (_c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve({ behavior: 'deny', message: 'x' }); })) });
    const ac = new AbortController();
    const p = postBridge(reg.socketPath, reg.token, '/v1/permission', call, ac.signal).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await p;
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
  });

  it('abortAll aborts in-flight requests and answers them with a deny', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ ...allowAll, permission: (_c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'aborted' }))) });
    const p = postBridge(reg.socketPath, reg.token, '/v1/permission', call);
    await new Promise((r) => setTimeout(r, 50));
    reg.abortAll();
    expect(JSON.parse((await p).body)).toMatchObject({ behavior: 'deny' });
  });

  it('the wait cap answers deny in Korean', async () => {
    bridge = await PermissionBridge.open({ waitMs: 50 });
    const reg = bridge.register({ ...allowAll, permission: () => new Promise(() => {}) });
    const r = JSON.parse((await postBridge(reg.socketPath, reg.token, '/v1/permission', call)).body);
    expect(r).toEqual({ behavior: 'deny', message: '권한 요청이 오래 응답되지 않아 거부했습니다' });
  });

  it('a throwing handler answers deny, never 500 with a stack', async () => {
    bridge = await PermissionBridge.open();
    const reg = bridge.register({ ...allowAll, permission: async () => { throw new Error('boom'); } });
    const r = await postBridge(reg.socketPath, reg.token, '/v1/permission', call);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ behavior: 'deny', message: '권한 요청을 처리하다 오류가 나서 거부했습니다' });
  });

  it('register N then dispose N leaks nothing: zero registrations, in-flight requests aborted, socket stays until close', async () => {
    bridge = await PermissionBridge.open();
    const N = 20;
    let aborted = 0;
    const regs = Array.from({ length: N }, () => bridge!.register({ ...allowAll, permission: (_c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted++; resolve({ behavior: 'deny', message: 'aborted' }); }, { once: true })) }));
    expect(bridge.registrations).toBe(N);
    const pending = regs.map((r) => postBridge(r.socketPath, r.token, '/v1/permission', call));
    await new Promise((r) => setTimeout(r, 50));
    for (const r of regs) r.dispose();
    for (const r of regs) r.dispose(); // idempotent
    await Promise.all(pending);
    expect(bridge.registrations).toBe(0);
    expect(aborted).toBe(N);
    for (const r of regs) expect((await postBridge(r.socketPath, r.token, '/v1/permission', call)).status).toBe(410);
    expect(fs.existsSync(bridge.socketPath)).toBe(true); // one shared socket per deck server
    const sock = bridge.socketPath;
    await bridge.close();
    bridge = null;
    expect(fs.existsSync(sock)).toBe(false);
  });

  it('close removes the socket dir', async () => {
    const b = await PermissionBridge.open();
    const dir = b.socketPath.replace(/\/[^/]+$/, '');
    await b.close();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
