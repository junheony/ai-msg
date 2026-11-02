import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HermesEngine, HERMES_PLAN_REFUSED, hermesEnv, resolveHermesBin, type HermesTurnRequest } from './HermesEngine';
import type { EngineEvent, EngineResult, PermissionRequest } from './Engine';
let dir: string;
let log: string;
const cli = fileURLToPath(new URL('./acp/fakeHermesCli.ts', import.meta.url));
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-hermes-')); log = path.join(dir, 'rpc.jsonl'); });
afterEach(async () => { await fs.rm(dir, { force: true, recursive: true }); });
const request = (over: Partial<HermesTurnRequest> = {}): HermesTurnRequest => ({ cwd: dir, resumeSessionId: null, prompt: 'hello', signal: new AbortController().signal, permissionMode: 'default', autoApprove: () => false, onPermission: async () => 'deny', ...over });
const make = (over: Partial<ConstructorParameters<typeof HermesEngine>[0]> = {}) => new HermesEngine({ bin: '/mock/hermes', checkPolicy: async () => true, baseEnv: { ...process.env, HERMES_TEST_LOG: log }, handshakeMs: 5000, stopMs: 40,
  spawnFn: (_bin, args, opts) => { expect(args).toEqual(['acp']); return spawn(process.execPath, [cli], opts); }, ...over });
async function collect(engine: HermesEngine, req: HermesTurnRequest) { const events: EngineEvent[] = []; for await (const event of engine.runTurn(req)) events.push(event); return events; }
const messages = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
const result = (events: EngineEvent[]) => events.find((e): e is EngineResult => e.kind === 'result')!;

describe('Hermes ACP adapter with a mocked CLI process', () => {
  it('creates and persists an id before prompt; streams text/thinking/tools and token usage', async () => {
    const onSessionId = vi.fn(async () => {});
    const events = await collect(make(), request({ onPermission: async () => 'once', onSessionId }));
    expect(onSessionId).toHaveBeenCalledWith('hermes-fixture-session');
    expect(events.filter((e) => e.kind === 'delta').map((e) => e.text).join('')).toBe('Hello Hermes.');
    expect(events.some((e) => e.kind === 'thinking')).toBe(true);
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ isError: false });
    expect(result(events)).toMatchObject({ ok: true, text: 'Hello Hermes.', usage: { inputTokens: 13, outputTokens: 5, cacheReadTokens: 4 } });
    const rpc = await messages();
    expect(rpc.map((m) => m.method).filter(Boolean)).toEqual(['initialize', 'session/new', 'session/set_mode', 'session/set_model', 'session/prompt']);
    expect(rpc.find((m) => m.method === 'session/set_model').params.modelId).toBe('gpt-6-astra');
    expect(rpc.find((m) => m.method === 'session/set_mode').params.modeId).toBe('default');
  });
  it('transmits image attachments as ACP image blocks', async () => {
    const image = path.join(dir, 'image.png'); await fs.writeFile(image, Buffer.from([1, 2, 3]));
    await collect(make(), request({ attachments: [{ id: 'i', name: 'image.png', mediaType: 'image/png', path: image, size: 3, isImage: true, createdAtMs: 0 }] }));
    expect((await messages()).find((m) => m.method === 'session/prompt').params.prompt[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AQID' });
  });
  it('loads a persisted id and suppresses old replay/foreign-session notifications', async () => {
    const events = await collect(make(), request({ resumeSessionId: 'hermes-fixture-session' }));
    expect(result(events).text).toBe('Hello Hermes.');
    expect((await messages()).find((m) => m.method === 'session/load').params).toMatchObject({ sessionId: 'hermes-fixture-session', cwd: dir });
  });
  it('never treats a missing resume as a new session', async () => {
    const events = await collect(make(), request({ resumeSessionId: 'missing' }));
    expect(result(events)).toMatchObject({ ok: false, sessionId: null });
    expect((await messages()).some((m) => m.method === 'session/new' || m.method === 'session/prompt')).toBe(false);
  });
  it('default denies, accept-edits keeps the native gate, auto-approve uses allow_once only', async () => {
    const ask = vi.fn(async () => 'deny' as const);
    const audit = vi.fn(async () => {});
    await collect(make(), request({ permissionMode: 'acceptEdits', onPermission: ask }));
    let rpc = await messages();
    expect(ask).toHaveBeenCalledOnce();
    expect(rpc.find((m) => m.method === 'session/set_mode').params.modeId).toBe('default');
    expect(rpc.find((m) => m.id === 'permission').result.outcome.optionId).toBe('deny');
    await fs.writeFile(log, '');
    await collect(make(), request({ permissionMode: 'bypassPermissions', autoApprove: () => true, onPermission: ask, onAutoApproved: audit }));
    rpc = await messages();
    expect(ask).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
    expect(rpc.find((m) => m.id === 'permission').result.outcome.optionId).toBe('allow_once');
    expect(rpc.find((m) => m.method === 'session/set_mode').params.modeId).toBe('default');
  });
  it('reads edit-auto dynamically and keeps the native mode default', async () => {
    const ask = vi.fn(async () => 'deny' as const);
    const audit = vi.fn(async () => {});
    await collect(make(), request({ permissionMode: 'acceptEdits', editAuto: () => true, onPermission: ask, onAutoApproved: audit }));
    expect(ask).not.toHaveBeenCalled(); expect(audit).toHaveBeenCalledOnce();
    await fs.writeFile(log, '');
    await collect(make(), request({ permissionMode: 'acceptEdits', editAuto: () => false, onPermission: ask }));
    expect(ask).toHaveBeenCalledOnce();
    expect((await messages()).find((m) => m.method === 'session/set_mode').params.modeId).toBe('default');
  });
  it('refuses plan and unsafe/unverifiable native approval policy before spawning', async () => {
    const spawnFn = vi.fn();
    const plan = await collect(make({ spawnFn }), request({ permissionMode: 'plan' }));
    expect(result(plan).errorText).toBe(HERMES_PLAN_REFUSED);
    const unsafe = await collect(make({ spawnFn, checkPolicy: async () => false }), request());
    expect(result(unsafe).errorText).toContain('manual');
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('aborts a running CLI, sends cancellation and yields one failed terminal result', async () => {
    const ac = new AbortController();
    const events: EngineEvent[] = [];
    for await (const event of make().runTurn(request({ prompt: 'hang', signal: ac.signal }))) {
      events.push(event);
      if (event.kind === 'init') setTimeout(() => ac.abort(), 20);
    }
    expect(events.filter((e) => e.kind === 'result')).toHaveLength(1);
    expect(result(events)).toMatchObject({ ok: false, errorText: '중단됨' });
    expect((await messages()).some((m) => m.method === 'session/cancel')).toBe(true);
  });
  it('closes an outstanding permission card when Hermes finishes without an answer', async () => {
    let pr: PermissionRequest | undefined;
    const events = await collect(make(), request({ prompt: 'permission-timeout', onPermission: async (p) => { pr = p; return new Promise(() => {}); } }));
    expect(result(events).ok).toBe(true);
    expect(pr?.signal?.aborted).toBe(true);
  });
  it('handles CLI crashes without leaking stderr, and redacts JSON-RPC error secrets', async () => {
    expect(JSON.stringify(await collect(make(), request({ prompt: 'crash' })))).not.toContain('do-not-leak');
    const rpcError = result(await collect(make(), request({ prompt: 'rpc-error' })));
    expect(rpcError.ok).toBe(false);
    expect(rpcError.errorText).toContain('[redacted]');
    expect(rpcError.errorText).not.toContain('very-secret');
  });
});

it('discovers explicit/PATH/local Hermes binaries and strips inherited approval bypass', () => {
  expect(resolveHermesBin({}, '/home/test', (p) => p === '/home/test/.local/bin/hermes')).toBe('/home/test/.local/bin/hermes');
  expect(resolveHermesBin({ DECK_HERMES_BIN: '/missing' }, '/home/test', () => false)).toBeNull();
  const env = hermesEnv({ HERMES_YOLO_MODE: '1', HERMES_ACCEPT_HOOKS: '1', OPENAI_API_KEY: 'secret', INVOCATION_ID: 'unit', HERMES_CRON_SESSION: '1' });
  expect(env).toMatchObject({ HERMES_YOLO_MODE: '0', HERMES_ACCEPT_HOOKS: '0' });
  expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.INVOCATION_ID).toBeUndefined(); expect(env.HERMES_CRON_SESSION).toBeUndefined();
});
