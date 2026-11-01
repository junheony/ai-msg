import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '../../shared/protocol';
import type { HermesTurnRequest } from '../engine/HermesEngine';
import { StubEngine, okResult } from '../engine/StubEngine';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { isHermesState, SessionStateStore } from './SessionState';
import { TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';
let dir: string;
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msg-hermes-runner-'))); });
afterEach(async () => { await fs.rm(dir, { force: true, recursive: true }); });
async function setup(over: Partial<TurnRunnerDeps> = {}) {
  const roots = rootsOf({ a: path.join(dir, 'a') });
  const store = new SessionStateStore(path.join(dir, 'state.json')); await store.load();
  const index = new SessionIndex({ roots, pinnedFile: path.join(dir, 'pins.json') }); await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://unused', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  const calls: HermesTurnRequest[] = [];
  const runner = new TurnRunner({ accounts: testRegistry(), engine: new StubEngine(async () => { throw new Error('unexpected Claude route'); }), codex: null, attachments: null, usage, store, index, cooldownDir: path.join(dir, 'cd'), protectedAccount: null, auditFile: path.join(dir, 'audit'), projectsRoots: roots, codexSessionsRoot: path.join(dir, 'codex'), defaultPermissionMode: () => 'bypassPermissions', hermes: { async *runTurn(req) {
    calls.push(req); const id = req.resumeSessionId ?? 'hermes-new'; await req.onSessionId?.(id);
    // The session must already be persisted before the first model output.
    expect(store.get(id)?.engine).toBe('hermes');
    yield { kind: 'init', sessionId: id, model: 'gpt-6-astra' };
    yield { kind: 'delta', text: 'Hermes reply' };
    yield okResult(id, 'Hermes reply');
  } }, ...over });
  const messages: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => messages.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { runner, store, index, calls, messages, sink };
}
describe('Hermes routing and persistent sessions', () => {
  it('creates explicit Hermes with safe default, survives store reload, keeps engine/cwd on resume', async () => {
    const c = await setup();
    await c.runner.run({ turnId: 't1', cwd: dir, sessionId: null, text: 'first', engine: 'hermes', model: 'gpt-6-astra' }, c.sink);
    expect(c.calls[0]?.permissionMode).toBe('default');
    expect(c.calls[0]?.autoApprove()).toBe(false); // global Claude bypass is not inherited
    expect(c.messages.find((m) => m.type === 'turn_started')).toMatchObject({ engine: 'hermes', model: 'gpt-6-astra', account: 'hermes' });
    const reopened = new SessionStateStore(path.join(dir, 'state.json')); await reopened.load();
    const state = reopened.get('hermes-new');
    expect(state && isHermesState(state) && state.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    expect(reopened.codexEntries()).toContainEqual(expect.objectContaining({ engine: 'hermes', account: 'hermes', title: 'first' }));
    const resumed = await setup();
    await resumed.runner.run({ turnId: 't2', cwd: '/ignored', sessionId: 'hermes-new', text: 'continue', engine: 'claude', model: 'opus' }, resumed.sink);
    expect(resumed.calls[0]).toMatchObject({ resumeSessionId: 'hermes-new', cwd: dir });
    expect(resumed.messages.find((m) => m.type === 'turn_started')).toMatchObject({ engine: 'hermes', model: 'gpt-6-astra' });
    expect(resumed.store.get('hermes-new')).toMatchObject({ messages: [expect.objectContaining({ text: 'first' }), expect.objectContaining({ text: 'Hermes reply' }), expect.objectContaining({ text: 'continue' }), expect.objectContaining({ text: 'Hermes reply' })] });
  });
  it('persists explicit bypass and live changes; refuses unsupported plan', async () => {
    const c = await setup();
    await c.runner.run({ turnId: 't1', cwd: dir, sessionId: null, text: 'first', engine: 'hermes', permissionMode: 'bypassPermissions' }, c.sink);
    expect(c.calls[0]?.autoApprove()).toBe(true);
    expect(await c.runner.setPermissionMode('hermes-new', 'plan')).toBe(false);
    expect(await c.runner.setPermissionMode('hermes-new', 'default')).toBe(true);
    expect(c.runner.permissionModeOf('hermes-new')).toBe('default');
  });
  it('refuses a fresh commander turn before invoking Hermes', async () => {
    const c = await setup();
    await c.runner.run({ turnId: 't1', cwd: dir, sessionId: null, text: 'automatic', engine: 'hermes', commanderHop: 1 }, c.sink);
    expect(c.calls).toEqual([]);
    expect(c.messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('Claude') });
  });
  it('rejects uninstalled Hermes and automated commander turns without falling back', async () => {
    const c = await setup({ hermes: null });
    await c.runner.run({ turnId: 't1', cwd: dir, sessionId: null, text: 'first', engine: 'hermes' }, c.sink);
    expect(c.messages.at(-1)).toMatchObject({ type: 'turn_result', ok: false, errorText: expect.stringContaining('Hermes CLI') });
    expect(c.store.list()).toEqual([]);
  });
});
