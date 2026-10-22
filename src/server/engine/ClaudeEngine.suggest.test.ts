import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { ClaudeEngine, type ClaudeEngineOptions } from './ClaudeEngine';
import type { EngineEvent, LiveInput, TurnRequest } from './Engine';
import { fakeClaudeCli, cli } from './claudeCli/fakeClaudeCli';
import { PermissionBridge } from './claudeCli/bridge';
import { testRegistry } from '../../shared/accounts.testkit';

let bridge: PermissionBridge | null = null;
let tmp = '';
afterEach(async () => { await bridge?.close(); bridge = null; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

/** A person's turn (TurnRunner sets `suggest` on those only). */
const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', suggest: true, ...over });
async function setup(over: Partial<ClaudeEngineOptions> = {}, fakeOpts: Parameters<typeof fakeClaudeCli>[0] = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-sug-'));
  bridge = await PermissionBridge.open();
  const f = fakeClaudeCli(fakeOpts);
  const engine = new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge, accounts: testRegistry('/h'), baseEnv: { PATH: '/bin' }, readFile: async () => Buffer.from(''), tmpRoot: tmp, killGraceMs: 50, ...over });
  return { f, engine };
}
const drain = async (it: AsyncIterable<EngineEvent>) => { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; };
const suggestion = (text: unknown) => ({ type: 'prompt_suggestion', suggestion: text, uuid: 'u1', session_id: 's1' });
const inputs = (f: ReturnType<typeof fakeClaudeCli>) => f.inputs as unknown as Record<string, unknown>[];

describe('ClaudeEngine prompt suggestions', () => {
  it('off by default: no initialize request, the process ends right after the result', async () => {
    const { f, engine } = await setup();
    f.push(cli.init('s1'), cli.result('a', 's1'));
    const evs = await drain(engine.runTurn(req()));
    expect(inputs(f).map((m) => m.type)).toEqual(['user']);
    expect(evs.some((e) => e.kind === 'suggestion')).toBe(false);
  });

  it('sends initialize { promptSuggestions } before the first user message and yields the suggestion after the result', async () => {
    const { f, engine } = await setup({ promptSuggestions: true, suggestWaitMs: 5_000 });
    f.push(cli.init('s1'), { type: 'control_response', response: { subtype: 'success', request_id: 'x' } }, cli.result('a', 's1'), suggestion('  테스트도 돌려줘 '));
    const t0 = Date.now();
    const evs = await drain(engine.runTurn(req()));
    expect(Date.now() - t0).toBeLessThan(2_000); // the suggestion ends the wait, not the timer
    const [first, second] = inputs(f);
    expect(first).toMatchObject({ type: 'control_request', request_id: expect.any(String), request: { subtype: 'initialize', promptSuggestions: true } });
    expect(second).toMatchObject({ type: 'user' });
    const kinds = evs.map((e) => e.kind);
    expect(kinds.indexOf('suggestion')).toBeGreaterThan(kinds.indexOf('result'));
    expect(evs.filter((e) => e.kind === 'suggestion')).toEqual([{ kind: 'suggestion', text: '테스트도 돌려줘' }]);
    expect(f.state.inputClosed).toBe(true);
  });

  it('no suggestion: the wait ends on its timer and closes stdin', async () => {
    const { f, engine } = await setup({ promptSuggestions: true, suggestWaitMs: 30 });
    f.push(cli.init('s1'), cli.result('a', 's1'));
    const evs = await drain(engine.runTurn(req()));
    expect(evs.find((e) => e.kind === 'result')).toMatchObject({ ok: true });
    expect(evs.some((e) => e.kind === 'suggestion')).toBe(false);
    expect(f.state.inputClosed).toBe(true);
    expect(f.state.signals).toEqual([]);
  });

  it('an empty or non-string suggestion yields nothing', async () => {
    const { f, engine } = await setup({ promptSuggestions: true, suggestWaitMs: 5_000 });
    f.push(cli.init('s1'), cli.result('a', 's1'), suggestion('   '));
    const evs = await drain(engine.runTurn(req()));
    expect(evs.some((e) => e.kind === 'suggestion')).toBe(false);
  });

  it('a failed result does not wait for a suggestion', async () => {
    const { f, engine } = await setup({ promptSuggestions: true, suggestWaitMs: 60_000 });
    f.push(cli.init('s1'), { ...cli.result('', 's1'), is_error: true, result: 'boom' });
    const t0 = Date.now();
    await drain(engine.runTurn(req()));
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('an automatic turn (no req.suggest) asks for none and does not wait', async () => {
    const { f, engine } = await setup({ promptSuggestions: true, suggestWaitMs: 60_000 });
    f.push(cli.init('s1'), cli.result('a', 's1'));
    const t0 = Date.now();
    await drain(engine.runTurn(req({ suggest: false })));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(inputs(f).map((m) => m.type)).toEqual(['user']);
  });

  it('a follow-up during the wait calls it off and goes in as a normal message; the follow-up\'s own result waits again', async () => {
    const { f, engine } = await setup({ promptSuggestions: true, suggestWaitMs: 60_000 });
    let live: LiveInput | null = null;
    f.push(cli.init('s1'), cli.result('a', 's1'));
    const evs: EngineEvent[] = [];
    const done = (async () => { for await (const e of engine.runTurn(req({ onLive: (l) => { live = l; } }))) evs.push(e); })();
    for (let i = 0; i < 200 && evs.filter((e) => e.kind === 'result').length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await live!.send({ text: '이어서', attachments: [] })).toBe(true);
    expect(f.state.inputClosed).toBe(false);
    // A suggestion racing the follow-up is stale; the follow-up's result waits for its own.
    f.push(suggestion('낡은 추천'), cli.result('b', 's1'), suggestion('새 추천'));
    await done;
    expect(inputs(f).filter((m) => m.type === 'user')).toHaveLength(2);
    expect(evs.filter((e) => e.kind === 'result')).toHaveLength(2);
    expect(evs.filter((e) => e.kind === 'suggestion')).toEqual([{ kind: 'suggestion', text: '새 추천' }]);
  });

  it('abort during the wait ends the process at once (SIGTERM, no SIGINT) and drops a late suggestion', async () => {
    const { f, engine } = await setup({ promptSuggestions: true, suggestWaitMs: 60_000 }, { exitOnStdinClose: false });
    const ac = new AbortController();
    const evs: EngineEvent[] = [];
    f.push(cli.init('s1'), cli.result('a', 's1'));
    const done = (async () => { for await (const e of engine.runTurn(req({ signal: ac.signal }))) { evs.push(e); if (e.kind === 'result') setTimeout(() => ac.abort(), 5); } })();
    for (let i = 0; i < 200 && !f.state.inputClosed; i++) await new Promise((r) => setTimeout(r, 5));
    expect(f.state.inputClosed).toBe(true);
    f.push(suggestion('늦은 추천'));
    await done;
    expect(f.state.signals).toContain('SIGTERM');
    expect(f.state.signals).not.toContain('SIGINT');
    expect(evs.some((e) => e.kind === 'suggestion')).toBe(false);
  });
});
