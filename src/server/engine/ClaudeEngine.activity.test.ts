import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundTracker, ClaudeEngine, ProgressMeter, mapCliMessage } from './ClaudeEngine';
import type { EngineEvent, LiveInput, TurnRequest } from './Engine';
import { fakeClaudeCli, cli } from './claudeCli/fakeClaudeCli';
import { PermissionBridge } from './claudeCli/bridge';
import type { CliMessage } from './claudeCli/messages';
import { testRegistry } from '../../shared/accounts.testkit';

const M = (o: unknown) => o as CliMessage;

let bridge: PermissionBridge | null = null;
let tmp = '';
afterEach(async () => { await bridge?.close(); bridge = null; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });
async function engineWith(f: ReturnType<typeof fakeClaudeCli>) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-act-'));
  bridge = await PermissionBridge.open();
  return new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge, accounts: testRegistry(), readFile: async () => Buffer.from(''), tmpRoot: tmp, killGraceMs: 50 });
}

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

async function all(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('mapCliMessage: subagent activity', () => {
  it("a subagent's tool calls and results ride with the parent Agent call, never as main transcript events", () => {
    expect(mapCliMessage(M(cli.subToolCall()))).toEqual([{ kind: 'sub_tool_call', parentToolUseId: 'toolu_ag', toolUseId: 'sub1', name: 'Bash', input: { command: 'ls' } }]);
    expect(mapCliMessage(M(cli.subToolResult('toolu_ag', 'sub1', true)))).toEqual([{ kind: 'sub_tool_result', parentToolUseId: 'toolu_ag', toolUseId: 'sub1', isError: true }]);
    // The subagent's own streamed text stays out.
    expect(mapCliMessage(M({ type: 'stream_event', parent_tool_use_id: 'toolu_ag', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } }))).toEqual([]);
  });

  it('task_started / task_progress / task_updated → task_update; ambient tasks are left out', () => {
    expect(mapCliMessage(M(cli.agentStarted()))).toEqual([{ kind: 'task_update', taskId: 'a1', toolUseId: 'toolu_ag', status: 'running', description: 'count files', subagentType: 'general-purpose', taskType: 'local_agent' }]);
    expect(mapCliMessage(M(cli.agentProgress()))).toEqual([{ kind: 'task_update', taskId: 'a1', toolUseId: 'toolu_ag', status: 'running', usage: { totalTokens: 1200, toolUses: 2, durationMs: 3000 }, lastToolName: 'Bash' }]);
    expect(mapCliMessage(M({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'killed' } }))).toEqual([{ kind: 'task_update', taskId: 'a1', toolUseId: null, status: 'stopped' }]);
    expect(mapCliMessage(M({ ...cli.agentStarted(), ambient: true }))).toEqual([]);
  });

  it('task_notification carries the task id, its Agent call and usage', () => {
    expect(mapCliMessage(M({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_ag', status: 'completed', summary: '42 files', usage: { total_tokens: 9, tool_uses: 3, duration_ms: 4100 } }))).toEqual([
      { kind: 'task_done', status: 'completed', summary: '42 files', taskId: 'a1', toolUseId: 'toolu_ag', usage: { totalTokens: 9, toolUses: 3, durationMs: 4100 } },
    ]);
  });
});

describe('ProgressMeter', () => {
  it('counts output tokens of the main conversation: exact per finished message, estimated while streaming', () => {
    let t = 0;
    const m = new ProgressMeter(() => t, 400);
    expect(m.apply(M(cli.delta('ignored before message_start')))).toBeNull();
    expect(m.apply(M(cli.messageStart()))).toBeNull();
    expect(m.apply(M(cli.blockStart('thinking')))).toEqual({ outputTokens: 0, phase: 'thinking' });
    t = 1000;
    expect(m.apply(M(cli.blockStart('text')))).toEqual({ outputTokens: 0, phase: 'responding' });
    t = 2000;
    expect(m.apply(M(cli.delta('x'.repeat(400))))).toEqual({ outputTokens: 100, phase: 'responding' });
    // Throttled: within minGap nothing is emitted.
    expect(m.apply(M(cli.delta('x'.repeat(40))))).toBeNull();
    expect(m.apply(M(cli.messageDelta(120)))).toEqual({ outputTokens: 120, phase: 'responding' });
    // A subagent's stream does not count.
    expect(m.apply(M({ type: 'stream_event', parent_tool_use_id: 'p', event: { type: 'message_delta', usage: { output_tokens: 999 } } }))).toBeNull();
    m.apply(M(cli.messageStart()));
    expect(m.apply(M(cli.blockStart('tool_use')))).toEqual({ outputTokens: 120, phase: 'tool' });
    m.reset();
    m.apply(M(cli.messageStart()));
    expect(m.apply(M(cli.blockStart('text')))).toEqual({ outputTokens: 0, phase: 'responding' });
  });
});

describe('BackgroundTracker detail', () => {
  it('keeps each live task id, type and first-seen time', () => {
    let t = 5000;
    const b = new BackgroundTracker(() => t);
    b.apply(M({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'k', task_type: 'local_bash', description: 'sleep 20' }] }));
    t = 9000;
    b.apply(M({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'k', task_type: 'local_bash', description: 'sleep 20' }, { task_id: 'g', task_type: 'local_agent', description: 'explore' }] }));
    expect(b.detail()).toEqual([
      { id: 'k', description: 'sleep 20', type: 'local_bash', startedAtMs: 5000 },
      { id: 'g', description: 'explore', type: 'local_agent', startedAtMs: 9000 },
    ]);
  });
});

describe('ClaudeEngine: activity events in a turn', () => {
  it('streams progress, subagent calls and task updates; background carries detail', async () => {
    const f = fakeClaudeCli();
    f.push(
      cli.init(), cli.messageStart(), cli.blockStart('tool_use'), cli.agentCall(), cli.messageDelta(30),
      cli.agentStarted(), cli.subToolCall(), cli.subToolResult(), cli.agentProgress(),
      { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_ag', status: 'completed', summary: '42', session_id: 's1' },
      cli.result('ok'),
    );
    const evs = await all((await engineWith(f)).runTurn(req()));
    expect(evs.map((e) => e.kind)).toEqual(['init', 'progress', 'tool_call', 'progress', 'task_update', 'sub_tool_call', 'sub_tool_result', 'task_update', 'task_done', 'result']);
    expect(evs[1]).toEqual({ kind: 'progress', outputTokens: 0, phase: 'tool' });
    expect(evs[3]).toEqual({ kind: 'progress', outputTokens: 30, phase: 'tool' });
  });

  it('background detail rides the turn; stopping one task is not offered (Lost or changed features)', async () => {
    const f = fakeClaudeCli();
    let live: LiveInput | null = null;
    f.push(cli.init(), cli.bgLevel([{ id: 'k', desc: 'sleep 20' }]), cli.result('launched'));
    const it = (await engineWith(f)).runTurn(req({ onLive: (l) => { live = l; } }))[Symbol.asyncIterator]();
    const seen: EngineEvent[] = [];
    while (!seen.some((e) => e.kind === 'result')) seen.push((await it.next()).value as EngineEvent);
    const bg = seen.find((e) => e.kind === 'background');
    expect(bg).toMatchObject({ kind: 'background', tasks: ['sleep 20'], detail: [{ id: 'k', description: 'sleep 20', type: 'local_agent' }] });
    expect(live!.stopTask).toBeUndefined();
    expect(f.state.inputClosed).toBe(false);
    f.push(cli.bgLevel([]));
    f.end();
    const rest: EngineEvent[] = [];
    for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value);
    expect(rest.at(-1)).toMatchObject({ kind: 'background', tasks: [] });
  });
});
