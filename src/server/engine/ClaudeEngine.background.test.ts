import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeEngine, type ClaudeEngineOptions } from './ClaudeEngine';
import type { EngineEvent, LiveInput, TurnRequest } from './Engine';
import { fakeClaudeCli, cli } from './claudeCli/fakeClaudeCli';
import { PermissionBridge } from './claudeCli/bridge';
import { testRegistry } from '../../shared/accounts.testkit';

let bridge: PermissionBridge | null = null;
let tmp = '';
afterEach(async () => { await bridge?.close(); bridge = null; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });
async function engine(f: ReturnType<typeof fakeClaudeCli>, over: Partial<ClaudeEngineOptions> = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-bg-'));
  bridge = await PermissionBridge.open();
  return new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge, accounts: testRegistry(), readFile: async () => Buffer.from(''), tmpRoot: tmp, killGraceMs: 50, ...over });
}

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

/** Pulls engine events one by one so the test can feed CLI frames between them. */
function reader(it: AsyncIterable<EngineEvent>) {
  const iter = it[Symbol.asyncIterator]();
  const seen: EngineEvent[] = [];
  return {
    seen,
    /** Next event (skipping nothing); `null` once the turn is over. */
    async next(): Promise<EngineEvent | null> {
      const r = await iter.next();
      if (r.done) return null;
      seen.push(r.value);
      return r.value;
    },
    /** Reads until an event of `kind` arrives; returns it. */
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

const textOf = (m: { message: { content: unknown } }) => (typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content));

describe('ClaudeEngine: background tasks outlive the turn result', () => {
  it('without background tasks the input closes right after the result (one-shot as before)', async () => {
    const f = fakeClaudeCli();
    f.push(cli.init(), cli.delta('ok'), cli.result('ok'));
    const evs = await reader((await engine(f)).runTurn(req())).rest();
    expect(evs.map((e) => e.kind)).toEqual(['init', 'delta', 'result']);
    expect(f.inputs.map(textOf)).toEqual(['hi']);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.state.inputClosed).toBe(true);
  });

  it('keeps the process open while a task is live and streams the continuation after it settles', async () => {
    const f = fakeClaudeCli();
    const r = reader((await engine(f)).runTurn(req()));
    f.push(cli.init(), cli.bgLevel([{ id: 't1', desc: 'explore repo' }, { id: 'amb', desc: 'monitor', ambient: true }]), cli.delta('started'), cli.result('started'));
    expect(await r.until('background')).toMatchObject({ kind: 'background', tasks: ['explore repo'] });
    expect(await r.until('result')).toMatchObject({ ok: true, text: 'started' });
    await new Promise((res) => setTimeout(res, 5));
    expect(f.state.inputClosed).toBe(false);
    // Subagent progress while idle is not a continuation.
    f.push(cli.subagentTool());
    // The task settles; the CLI injects its notification and runs another turn by itself.
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('found it'), cli.result('found it'));
    expect(await r.until('background')).toMatchObject({ kind: 'background', tasks: [] });
    const after: EngineEvent[] = [];
    for (let e = await r.next(); e && e.kind !== 'result'; e = await r.next()) after.push(e);
    // The CLI's task-notification user message is a system row (as in the transcript), not a user message.
    expect(after.map((e) => e.kind)).toEqual(['continue', 'system', 'delta']);
    expect(after[1]).toMatchObject({ kind: 'system', source: 'task' });
    expect(after[0]).toEqual({ kind: 'continue', cause: 'background' });
    expect(r.seen.at(-1)).toMatchObject({ kind: 'result', text: 'found it' });
    expect(await r.rest()).toEqual([]);
    await new Promise((res) => setTimeout(res, 0));
    expect(f.state.inputClosed).toBe(true);
    expect(r.seen.filter((e) => e.kind === 'continue')).toHaveLength(1);
  });

  it('a follow-up written through onLive is answered in the same process without a continue marker', async () => {
    const f = fakeClaudeCli();
    let live: LiveInput | null = null;
    const r = reader((await engine(f)).runTurn(req({ onLive: (l) => { live = l; } })));
    f.push(cli.init(), cli.bgLevel([{ id: 't1', desc: 'build' }]), cli.result('first'));
    await r.until('result');
    expect(await live!.send({ text: 'and also this', attachments: [] })).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(f.inputs.map(textOf)).toEqual(['hi', 'and also this']);
    f.push(cli.delta('answer'), cli.result('answer'));
    expect(await r.until('result')).toMatchObject({ text: 'answer' });
    expect(r.seen.some((e) => e.kind === 'continue')).toBe(false);
    // Still a live task → still open; settling it ends the process after its continuation.
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.result('done'));
    const rest = await r.rest();
    expect(rest.map((e) => e.kind)).toEqual(['background', 'continue', 'system', 'result']);
    await new Promise((res) => setTimeout(res, 0));
    expect(f.state.inputClosed).toBe(true);
    expect(await live!.send({ text: 'late', attachments: [] })).toBe(false);
  });

  it('ends after the grace window when the task set empties but no continuation comes', async () => {
    const f = fakeClaudeCli();
    const r = reader((await engine(f, { bgGraceMs: 20 })).runTurn(req()));
    f.push(cli.init(), cli.bgLevel([{ id: 't1', desc: 'x' }]), cli.result('r'));
    await r.until('result');
    f.push(cli.bgLevel([]));
    const rest = await r.rest();
    expect(rest).toMatchObject([{ kind: 'background', tasks: [] }]);
    expect(f.state.inputClosed).toBe(true);
  });

  it('caps the wait and says so', async () => {
    const f = fakeClaudeCli();
    const r = reader((await engine(f, { bgMaxMs: 20 })).runTurn(req()));
    f.push(cli.init(), cli.bgLevel([{ id: 't1', desc: 'forever' }]), cli.result('r'));
    await r.until('result');
    const rest = await r.rest();
    expect(rest[0]).toMatchObject({ kind: 'notice', message: expect.stringContaining('백그라운드 작업이') });
    // The cut work by name, for the runner to record and send the session on (before the clearing background event).
    expect(rest[1]).toEqual({ kind: 'bg_cap', tasks: ['forever'], minutes: 0 });
    expect(rest.at(-1)).toMatchObject({ kind: 'background', tasks: [] });
    expect(rest.some((e) => e.kind === 'result')).toBe(false);
  });

  it('with no cap (default, or a bgMaxMs setTimeout cannot hold) the process waits until the work ends', async () => {
    for (const over of [{}, { bgMaxMs: Infinity }, { bgMaxMs: 2 ** 31 }]) {
      const f = fakeClaudeCli();
      const r = reader((await engine(f, { bgGraceMs: 20, ...over })).runTurn(req()));
      f.push(cli.init(), cli.bgLevel([{ id: 't1', desc: 'long watch' }]), cli.result('r'));
      await r.until('result');
      await new Promise((res) => setTimeout(res, 50));
      expect(f.state.inputClosed).toBe(false);
      f.push(cli.bgLevel([]));
      const rest = await r.rest();
      expect(rest.some((e) => e.kind === 'bg_cap' || e.kind === 'notice')).toBe(false);
      expect(rest).toMatchObject([{ kind: 'background', tasks: [] }]);
      await bridge?.close(); bridge = null; fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('abort while waiting stops the process and clears the background status', async () => {
    const f = fakeClaudeCli();
    const ac = new AbortController();
    const r = reader((await engine(f)).runTurn(req({ signal: ac.signal })));
    f.push(cli.init(), cli.bgLevel([{ id: 't1', desc: 'x' }]), cli.result('r'));
    await r.until('result');
    ac.abort();
    const rest = await r.rest();
    expect(rest).toMatchObject([{ kind: 'background', tasks: [] }]);
    expect(f.state.inputClosed).toBe(true);
  });

  it('falls back to task_started / task_notification when no level signal is sent', async () => {
    const f = fakeClaudeCli();
    const r = reader((await engine(f)).runTurn(req()));
    f.push(cli.init(), cli.taskStarted('t1', 'review'), cli.taskStarted('t2', 'inline', false), cli.result('r'));
    expect(await r.until('background')).toMatchObject({ kind: 'background', tasks: ['review'] });
    await r.until('result');
    f.push(cli.taskDone('t1'), cli.notifyUser(), cli.delta('d'), cli.result('d'));
    const rest = await r.rest();
    expect(rest.map((e) => e.kind)).toEqual(['background', 'task_done', 'continue', 'system', 'delta', 'result']);
  });
});

describe('ClaudeEngine: a task that ends while a turn streams', () => {
  it('its queued notification turn is still owed after that result: the process stays open and the task stays shown until the notification turn begins (restart drain 2026-10-25)', async () => {
    const f = fakeClaudeCli();
    const r = reader((await engine(f)).runTurn(req()));
    f.push(cli.init(), cli.bgLevel([{ id: 'rv', desc: 'review' }]), cli.delta('waiting for the review'));
    expect(await r.until('background')).toMatchObject({ tasks: ['review'] });
    await r.until('delta');
    // The review ends while the turn still streams (the CLI queues its notification behind the turn), then the turn ends.
    f.push(cli.bgLevel([]), cli.delta(' — merge once it is in'), cli.result('merge once it is in'));
    expect(await r.until('result')).toMatchObject({ ok: true });
    await new Promise((res) => setTimeout(res, 10));
    expect(f.state.inputClosed).toBe(false);
    // Not shown as settled before the notification turn opens (ws ends a drained process with nothing left).
    expect(r.seen.filter((e) => e.kind === 'background').map((e) => (e as Extract<EngineEvent, { kind: 'background' }>).tasks)).toEqual([['review']]);
    // The CLI runs the notification as its own turn (fixtures/background.jsonl order).
    f.push(cli.taskDone('rv'), cli.init(), cli.delta('review is in'), cli.notifyResult('review is in'));
    const kinds: string[] = [];
    for (let e = await r.next(); e && e.kind !== 'result'; e = await r.next()) kinds.push(e.kind === 'background' ? `background:${e.tasks.length}` : e.kind);
    expect(kinds.indexOf('continue')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('continue')).toBeLessThan(kinds.indexOf('background:0'));
    expect(kinds).toContain('delta');
    expect(r.seen.at(-1)).toMatchObject({ kind: 'result', ok: true, text: 'review is in' });
    await r.rest();
    await new Promise((res) => setTimeout(res, 0));
    expect(f.state.inputClosed).toBe(true);
  });

  it('back-to-back: B ends while A\'s notification turn streams — A\'s result settles A only, B still gets its own turn', async () => {
    const f = fakeClaudeCli();
    const r = reader((await engine(f, { bgGraceMs: 60_000 })).runTurn(req()));
    const tasksSeen = () => r.seen.filter((e) => e.kind === 'background').map((e) => (e as Extract<EngineEvent, { kind: 'background' }>).tasks);
    f.push(cli.init(), cli.bgLevel([{ id: 'a', desc: 'A' }, { id: 'b', desc: 'B' }]), cli.delta('waiting'));
    await r.until('delta');
    // A ends mid-turn (frame at completion, CLI order), then the turn ends.
    f.push(cli.bgLevel([{ id: 'b', desc: 'B' }]), cli.taskDone('a'), cli.result('first'));
    await r.until('result');
    // A's notification turn; B ends while it streams.
    f.push(cli.init(), cli.delta('A is in'));
    await r.until('continue');
    await r.until('delta');
    f.push(cli.bgLevel([]), cli.taskDone('b'), cli.delta(' — wrapping up'), cli.notifyResult('A is in'));
    expect(await r.until('result')).toMatchObject({ text: 'A is in' });
    await new Promise((res) => setTimeout(res, 10));
    expect(f.state.inputClosed).toBe(false);
    expect(tasksSeen().at(-1)).toEqual(['B']);
    // B's own notification turn, then the process goes.
    f.push(cli.init(), cli.delta('B is in'), cli.notifyResult('B is in'));
    const kinds: string[] = [];
    for (let e = await r.next(); e && e.kind !== 'result'; e = await r.next()) kinds.push(e.kind === 'background' ? `background:${e.tasks.length}` : e.kind);
    expect(kinds.indexOf('continue')).toBeLessThan(kinds.indexOf('background:0'));
    expect(r.seen.at(-1)).toMatchObject({ kind: 'result', text: 'B is in' });
    await r.rest();
    await new Promise((res) => setTimeout(res, 0));
    expect(f.state.inputClosed).toBe(true);
  });

  it('a notification the CLI folds into the running turn (replayed) is told: no owed turn, the process goes after the result', async () => {
    const f = fakeClaudeCli();
    const r = reader((await engine(f, { bgGraceMs: 60_000 })).runTurn(req()));
    f.push(cli.init(), cli.bgLevel([{ id: 'rv', desc: 'review' }]), cli.delta('waiting'));
    await r.until('delta');
    f.push(cli.bgLevel([]), cli.taskDone('rv'), cli.delta(' tool runs'), cli.notifyReplay('rv'), cli.delta(' review is in'), cli.result('review is in'));
    expect(await r.until('result')).toMatchObject({ text: 'review is in' });
    expect(r.seen.filter((e) => e.kind === 'background').map((e) => (e as Extract<EngineEvent, { kind: 'background' }>).tasks)).toEqual([['review'], []]);
    await r.rest();
    await new Promise((res) => setTimeout(res, 0));
    expect(f.state.inputClosed).toBe(true);
  });

  it('a user turn that takes the owed notification in (replayed) settles it: the process goes after that result, not after the grace', async () => {
    const f = fakeClaudeCli();
    let live: LiveInput | null = null;
    const r = reader((await engine(f, { bgGraceMs: 60_000 })).runTurn(req({ onLive: (l) => { live = l; } })));
    f.push(cli.init(), cli.bgLevel([{ id: 'rv', desc: 'review' }]), cli.delta('waiting'));
    await r.until('delta');
    f.push(cli.bgLevel([]), cli.taskDone('rv'), cli.result('first'));
    await r.until('result');
    expect(await live!.send({ text: 'and this', attachments: [] })).toBe(true);
    f.push(cli.notifyReplay('rv'), cli.delta('both'), cli.result('both'));
    expect(await r.until('result')).toMatchObject({ text: 'both' });
    await r.rest();
    await new Promise((res) => setTimeout(res, 0));
    expect(f.state.inputClosed).toBe(true);
  });

  it('a task that ends while the process waits idle is no owed turn: nothing changes there', async () => {
    const f = fakeClaudeCli();
    const r = reader((await engine(f)).runTurn(req()));
    f.push(cli.init(), cli.bgLevel([{ id: 't1', desc: 'build' }]), cli.result('started'));
    await r.until('result');
    f.push(cli.bgLevel([]));
    expect(await r.until('background')).toMatchObject({ tasks: [] });
  });
});
