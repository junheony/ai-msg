import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeEngine } from './ClaudeEngine';
import type { EngineEvent, LiveInput, TurnRequest } from './Engine';
import { fakeSdk, sdk } from './fakeSdk';

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

/** Pulls engine events one by one so the test can feed SDK messages between them. */
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
const answered = (text: string, uuids: string[]) => ({ ...sdk.result(text), user_message_uuids: uuids });
const tick = () => new Promise((r) => setTimeout(r, 5));
const engine = (f: ReturnType<typeof fakeSdk>, over: ConstructorParameters<typeof ClaudeEngine>[0] = {}) => new ClaudeEngine({ queryFn: f.queryFn, readFile: async () => Buffer.from(''), ...over });

afterEach(() => vi.restoreAllMocks());

describe('ClaudeEngine: results that name what they answered (user_message_uuids)', () => {
  it('a normal turn: the result names the prompt, the input closes right after it', async () => {
    const f = fakeSdk();
    const r = reader(engine(f).runTurn(req()));
    f.push(sdk.init());
    await r.until('init');
    f.push(sdk.delta('ok'), answered('ok', [f.inputs[0]!.uuid!]));
    expect((await r.rest()).map((e) => e.kind)).toEqual(['delta', 'result']);
    await tick();
    expect(f.state.inputClosed).toBe(true);
  });

  it('a background turn: held open for the task, a follow-up answered by its own uuid, the unnamed continuation closes it once the set is empty', async () => {
    const f = fakeSdk();
    let live: LiveInput | null = null;
    const r = reader(engine(f).runTurn(req({ onLive: (l) => { live = l; } })));
    f.push(sdk.init());
    await r.until('init');
    f.push(sdk.bgLevel([{ id: 'b1', desc: 'explore' }]), sdk.delta('started'), answered('started', [f.inputs[0]!.uuid!]));
    await r.until('result');
    await tick();
    expect(f.state.inputClosed).toBe(false);
    expect(await live!.send({ text: 'status?', attachments: [] })).toBe(true);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
    f.push(sdk.delta('still going'), answered('still going', [f.inputs[1]!.uuid!]));
    const fu = await r.until('result');
    expect(fu).toMatchObject({ text: 'still going' });
    await tick();
    expect(f.state.inputClosed).toBe(false);
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('found'), sdk.result('found'));
    await r.until('continue');
    expect(await r.until('result')).toMatchObject({ text: 'found' });
    expect(await r.rest()).toEqual([]);
    await tick();
    expect(f.state.inputClosed).toBe(true);
    expect(r.seen.filter((e) => e.kind === 'continue')).toHaveLength(1);
  });

  it('once a result named its answers, an unnamed success (a background continuation) answers nothing: a pending steer keeps the input open', async () => {
    const f = fakeSdk();
    let live: LiveInput | null = null;
    const r = reader(engine(f).runTurn(req({ onLive: (l) => { live = l; } })));
    f.push(sdk.init(), sdk.bgLevel([{ id: 'b1', desc: 'build' }]));
    await r.until('background');
    expect(await live!.steer!({ text: 'also this', attachments: [] }, 'k1')).toBe(true);
    const [first, steer] = f.inputs;
    // The turn ends before any tool boundary took the steer in: it answers only the prompt.
    f.push(answered('first', [first!.uuid!]));
    await r.until('result');
    // The background task settles; the CLI's own continuation turn names no input message.
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('bg done'), sdk.result('bg done'));
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
    const f = fakeSdk();
    let live: LiveInput | null = null;
    const r = reader(engine(f).runTurn(req({ onLive: (l) => { live = l; } })));
    f.push(sdk.init(), sdk.bgLevel([{ id: 'b1', desc: 'build' }]));
    await r.until('background');
    f.push(answered('first', [f.inputs[0]!.uuid!]));
    await r.until('result');
    expect(await live!.send({ text: 'next', attachments: [] })).toBe(true);
    f.push(sdk.bgLevel([]), { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 's1', usage: { input_tokens: 0, output_tokens: 0 } });
    expect(await r.until('result')).toMatchObject({ ok: false });
    expect(await r.rest()).toEqual([]);
  });

  it('a result naming none of our messages is warned about and attributed like an unnamed one — the process is not held until bgMaxMs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeSdk();
    const r = reader(engine(f, { bgMaxMs: 60 * 60_000 }).runTurn(req()));
    f.push(sdk.init(), answered('odd', ['not-ours']));
    await r.until('result');
    expect(await r.rest()).toEqual([]);
    await tick();
    expect(f.state.inputClosed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('answers no message'), expect.objectContaining({ ids: ['not-ours'] }));
  });
});
