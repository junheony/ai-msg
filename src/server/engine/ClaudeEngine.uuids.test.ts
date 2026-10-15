import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClaudeEngine, type ClaudeEngineOptions } from './ClaudeEngine';
import type { EngineEvent, LiveInput, TurnRequest } from './Engine';
import { fakeClaudeCli, cli } from './claudeCli/fakeClaudeCli';
import { PermissionBridge } from './claudeCli/bridge';
import { testRegistry } from '../../shared/accounts.testkit';

const SID = '11111111-2222-4333-8444-555555555555';
let bridge: PermissionBridge;
let tmp = '';
beforeAll(async () => { bridge = await PermissionBridge.open(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-uuids-')); });
afterAll(async () => { await bridge.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

/** Pulls engine events one by one so the test can feed CLI frames between them. */
function reader(it: AsyncIterable<EngineEvent>) {
  const iter = it[Symbol.asyncIterator]();
  const seen: EngineEvent[] = [];
  return {
    seen,
    async next(): Promise<EngineEvent | null> {
      const r = await iter.next();
      if (r.done) return null;
      seen.push(r.value);
      return r.value;
    },
    async until<K extends EngineEvent['kind']>(kind: K): Promise<Extract<EngineEvent, { kind: K }>> {
      for (;;) {
        const e = await this.next();
        if (!e) throw new Error(`stream ended before ${kind}; saw ${seen.map((x) => x.kind).join(',')}`);
        if (e.kind === kind) return e as Extract<EngineEvent, { kind: K }>;
      }
    },
    async rest(): Promise<EngineEvent[]> {
      const out: EngineEvent[] = [];
      for (let e = await this.next(); e; e = await this.next()) out.push(e);
      return out;
    },
  };
}

/** A result as the real CLI reports it: the uuids of the user messages the turn consumed. */
const answered = (text: string, uuids: string[]) => ({ ...cli.result(text), user_message_uuids: uuids });
const tick = () => new Promise((r) => setTimeout(r, 5));
const engine = (f: ReturnType<typeof fakeClaudeCli>, over: Partial<ClaudeEngineOptions> = {}) => new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge, accounts: testRegistry(), readFile: async () => Buffer.from(''), tmpRoot: tmp, killGraceMs: 50, ...over });

afterEach(() => vi.restoreAllMocks());

describe('ClaudeEngine: results that name what they answered (user_message_uuids)', () => {
  it('a normal turn: the result names the prompt, the input closes right after it', async () => {
    const f = fakeClaudeCli();
    const r = reader(engine(f).runTurn(req()));
    f.push(cli.init());
    await r.until('init');
    f.push(cli.delta('ok'), answered('ok', [f.inputs[0]!.uuid!]));
    expect((await r.rest()).map((e) => e.kind)).toEqual(['delta', 'result']);
    await tick();
    expect(f.state.inputClosed).toBe(true);
  });

  it('a background turn: held open for the task, a follow-up answered by its own uuid, the unnamed continuation closes it once the set is empty', async () => {
    const f = fakeClaudeCli();
    let live: LiveInput | null = null;
    const r = reader(engine(f).runTurn(req({ onLive: (l) => { live = l; } })));
    f.push(cli.init());
    await r.until('init');
    f.push(cli.bgLevel([{ id: 'b1', desc: 'explore' }]), cli.delta('started'), answered('started', [f.inputs[0]!.uuid!]));
    await r.until('result');
    await tick();
    expect(f.state.inputClosed).toBe(false);
    expect(await live!.send({ text: 'status?', attachments: [] })).toBe(true);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
    f.push(cli.delta('still going'), answered('still going', [f.inputs[1]!.uuid!]));
    const fu = await r.until('result');
    expect(fu).toMatchObject({ text: 'still going' });
    await tick();
    expect(f.state.inputClosed).toBe(false);
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('found'), cli.result('found'));
    await r.until('continue');
    expect(await r.until('result')).toMatchObject({ text: 'found' });
    expect(await r.rest()).toEqual([]);
    await tick();
    expect(f.state.inputClosed).toBe(true);
    expect(r.seen.filter((e) => e.kind === 'continue')).toHaveLength(1);
  });

  it('once a result named its answers, an unnamed success (a background continuation) answers nothing: a pending steer keeps the input open', async () => {
    const f = fakeClaudeCli();
    let live: LiveInput | null = null;
    const r = reader(engine(f).runTurn(req({ onLive: (l) => { live = l; } })));
    f.push(cli.init(), cli.bgLevel([{ id: 'b1', desc: 'build' }]));
    await r.until('background');
    expect(await live!.steer!({ text: 'also this', attachments: [] }, 'k1')).toBe(true);
    const [first, steer] = f.inputs;
    // The turn ends before any tool boundary took the steer in: it answers only the prompt.
    f.push(answered('first', [first!.uuid!]));
    await r.until('result');
    // The background task settles; the CLI's own continuation turn names no input message.
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('bg done'), cli.result('bg done'));
    await r.until('result');
    await tick();
    expect(f.state.inputClosed).toBe(false);
    // Now the steer runs as its own turn and is answered: the process may close.
    f.push({ type: 'user', isReplay: true, uuid: steer!.uuid, parent_tool_use_id: null, message: steer!.message, session_id: 's1' }, answered('steer done', [steer!.uuid!]));
    expect(await r.until('steer_delivered')).toEqual({ kind: 'steer_delivered', id: 'k1' });
    await r.until('result');
    expect(await r.rest()).toEqual([]);
    await tick();
    expect(f.state.inputClosed).toBe(true);
  });

  it('an unnamed error result still answers the oldest message (delivery failure, synthesized error)', async () => {
    const f = fakeClaudeCli();
    let live: LiveInput | null = null;
    const r = reader(engine(f).runTurn(req({ onLive: (l) => { live = l; } })));
    f.push(cli.init(), cli.bgLevel([{ id: 'b1', desc: 'build' }]));
    await r.until('background');
    f.push(answered('first', [f.inputs[0]!.uuid!]));
    await r.until('result');
    expect(await live!.send({ text: 'next', attachments: [] })).toBe(true);
    f.push(cli.bgLevel([]), { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 's1', usage: { input_tokens: 0, output_tokens: 0 } });
    expect(await r.until('result')).toMatchObject({ ok: false });
    expect(await r.rest()).toEqual([]);
  });

  it('resume: the result of a notification the CLI queued without asking the model (orphaned agent) is not our turn — the prompt is still answered in this process', async () => {
    const f = fakeClaudeCli();
    const r = reader(engine(f).runTurn(req({ resumeSessionId: SID })));
    f.push(cli.init());
    await r.until('init');
    // On resume the CLI reports the agent the previous process left running, as its own non-querying turn, before our prompt.
    f.push(cli.notifyUser(), cli.notifyNoopResult(), cli.delta('ok'), answered('ok', [f.inputs[0]!.uuid!]));
    const rest = await r.rest();
    expect(r.seen.filter((e) => e.kind === 'result')).toEqual([expect.objectContaining({ ok: true, text: 'ok' })]);
    expect(rest.map((e) => e.kind)).toEqual(['system', 'delta', 'result']);
    await tick();
    expect(f.state.inputClosed).toBe(true);
  });

  it('an injected no-query turn that failed (error result, num_turns 0) while our prompt is pending is logged, not taken as our answer — the prompt still runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const f = fakeClaudeCli();
      const r = reader(engine(f).runTurn(req({ resumeSessionId: SID })));
      f.push(cli.init());
      await r.until('init');
      f.push(cli.notifyUser(), { ...cli.notifyNoopResult(), subtype: 'error_during_execution', is_error: true, errors: ['boom'] }, cli.delta('ok'), answered('ok', [f.inputs[0]!.uuid!]));
      await r.rest();
      expect(r.seen.filter((e) => e.kind === 'result')).toEqual([expect.objectContaining({ ok: true, text: 'ok' })]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('boom'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('idle with the background set emptied: a no-query notification the CLI injects closes its segment with a result and lets the process end', async () => {
    const f = fakeClaudeCli();
    const r = reader(engine(f, { bgGraceMs: 30 }).runTurn(req()));
    f.push(cli.init());
    await r.until('init');
    f.push(cli.bgLevel([{ id: 'b1', desc: 'agent' }]), answered('started', [f.inputs[0]!.uuid!]));
    await r.until('result');
    await tick();
    expect(f.state.inputClosed).toBe(false);
    // The agent hands back: its notification is queued shouldQuery:false, and nothing follows.
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.notifyNoopResult());
    const restP = r.rest();
    await new Promise((res) => setTimeout(res, 200));
    expect(f.state.inputClosed).toBe(true);
    const rest = await restP;
    // The notification shows in the continuation segment, which the result closes.
    expect(rest.map((e) => e.kind)).toEqual(['background', 'continue', 'system', 'result']);
    expect(rest.at(-1)).toMatchObject({ ok: true });
  });

  it('a result naming none of our messages is warned about and attributed like an unnamed one — the process is not held until bgMaxMs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeClaudeCli();
    const r = reader(engine(f, { bgMaxMs: 60 * 60_000 }).runTurn(req()));
    f.push(cli.init(), answered('odd', ['not-ours']));
    await r.until('result');
    expect(await r.rest()).toEqual([]);
    await tick();
    expect(f.state.inputClosed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('answers no message'), expect.objectContaining({ ids: ['not-ours'] }));
  });
});
