import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeEngine, NO_TOOLS_MESSAGE } from './ClaudeEngine';
import type { EngineEvent, TurnRequest } from './Engine';
import { fakeClaudeCli, cli, argValue } from './claudeCli/fakeClaudeCli';
import { PermissionBridge } from './claudeCli/bridge';
import { testRegistry } from '../../shared/accounts.testkit';

const SID = '11111111-2222-4333-8444-555555555555';
function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: SID, model: 'opus', prompt: 'note', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

let bridge: PermissionBridge | null = null;
let tmp = '';
afterEach(async () => { await bridge?.close(); bridge = null; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });
async function setup() {
  if (!tmp) tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-handoff-'));
  bridge ??= await PermissionBridge.open();
  const f = fakeClaudeCli();
  const engine = new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge, accounts: testRegistry(), baseEnv: {}, readFile: async () => Buffer.from(''), tmpRoot: tmp, killGraceMs: 50 });
  return { f, engine };
}

/** Runs one turn, calling `during(f)` while the child is alive (after init), then finishing it with `tail`. */
async function live(r: Partial<TurnRequest>, during: (f: ReturnType<typeof fakeClaudeCli>) => Promise<void>, tail: unknown[] = [cli.result('ok', 's1')]) {
  const { f, engine } = await setup();
  const it = engine.runTurn(req(r))[Symbol.asyncIterator]();
  f.push(cli.init('s1'));
  const evs: EngineEvent[] = [(await it.next()).value as EngineEvent];
  await during(f);
  f.push(...tail);
  for (let x = await it.next(); !x.done; x = await it.next()) evs.push(x.value);
  return { f, evs };
}
const preToolUse = (f: ReturnType<typeof fakeClaudeCli>, tool = 'Bash', id = 'tu1') =>
  f.hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'ls' }, tool_use_id: id, session_id: 's1', transcript_path: '', cwd: '/w' });
type Settings = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };

describe('handoff note turn (noTools)', () => {
  it('denies every tool call through the PreToolUse hook and the prompt tool, without asking', async () => {
    const asked: string[] = [];
    await live({ noTools: true, onPermission: async (p) => { asked.push(p.toolName); return 'once'; }, autoApprove: () => true }, async (f) => {
      expect(await preToolUse(f)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NO_TOOLS_MESSAGE } });
      expect(await f.ask({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' })).toMatchObject({ behavior: 'deny', message: NO_TOOLS_MESSAGE });
      expect(await f.ask({ tool_name: 'AskUserQuestion', input: { questions: [] }, tool_use_id: 'tu2' })).toMatchObject({ behavior: 'deny' });
    });
    expect(asked).toEqual([]);
  });

  it('wins over every permission mode: plan, acceptEdits and 모두 자동 승인 still get no tools', async () => {
    for (const mode of [undefined, 'acceptEdits', 'plan'] as const) {
      for (const auto of [true, false]) {
        const asked: string[] = [];
        await live({ noTools: true, permissionMode: mode, autoApprove: () => auto, onPermission: async (p) => { asked.push(p.toolName); return 'session'; } }, async (f) => {
          expect(await preToolUse(f)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
          for (const t of ['Bash', 'Edit', 'ExitPlanMode']) expect(await f.ask({ tool_name: t, input: { plan: 'p' }, tool_use_id: `t-${t}` })).toMatchObject({ behavior: 'deny', message: NO_TOOLS_MESSAGE });
        });
        expect(asked).toEqual([]);
      }
    }
  });

  it('keeps the rest of the argv (tools, model, resume) as a normal turn so the cached prefix still hits', async () => {
    const run = async (r: Partial<TurnRequest>) => {
      const { f, engine } = await setup();
      f.push(cli.init('s1'), cli.result('ok', 's1'));
      for await (const _ of engine.runTurn(req(r))) void _;
      return f.spawns[0]!;
    };
    const withTools = await run({ noTools: true });
    const normal = await run({});
    const pre = (s: typeof normal) => (s.files.settings as Settings).hooks.PreToolUse!;
    expect(pre(withTools)).toHaveLength(1);
    expect(pre(withTools)[0]!.matcher).toBe('*');
    expect(pre(withTools)[0]!.hooks[0]!.command).toContain("'--fail' 'deny'");
    // A normal turn's only hook is the edit-tool mode gate (PostToolUse/PostToolUseFailure/PermissionDenied became stream audit).
    expect(Object.keys((normal.files.settings as Settings).hooks)).toEqual(['PreToolUse']);
    expect(pre(normal)[0]!.matcher).not.toBe('*');
    const stable = (a: string[]) => a.filter((x) => !x.startsWith('--settings=') && !x.startsWith('--mcp-config='));
    expect(stable(withTools.args)).toEqual(stable(normal.args));
  });
});

describe('one audit line per tool call (stream audit)', () => {
  type Audit = Parameters<NonNullable<TurnRequest['onToolAudit']>>[0];
  const use = (id: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] }, session_id: 's1' });
  const res = (id: string, isError = false) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] }, session_id: 's1' });

  it('reports a call the CLI ran without asking once as cli, skips calls the prompt tool already decided, and reports denials', async () => {
    const got: Audit[] = [];
    await live({ onToolAudit: async (e) => { got.push(e); } }, async (f) => {
      await f.ask({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'c1' });
    }, [
      use('r1'), res('r1'),
      use('c1'), res('c1'),
      use('r2'), res('r2', true),
      use('r3'), { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'r3', decision_reason_type: 'classifier', message: 'denied', session_id: 's1' },
      res('r1'),
      cli.result('ok', 's1'),
    ]);
    // Changed: an error result is attributed when the turn's result arrives (so a denial report can win), hence r2 after r3.
    expect(got.map((e) => [e.toolUseId, e.decision, e.source])).toEqual([['r1', 'allow', 'cli'], ['r3', 'deny', 'cli'], ['r2', 'allow', 'cli']]);
  });

  it('a handoff note turn reports its own refusal as deck, and a failing audit sink never breaks the turn', async () => {
    const got: Audit[] = [];
    const { evs } = await live({ noTools: true, onToolAudit: async (e) => { got.push(e); throw new Error('disk full'); } }, async (f) => {
      expect(await preToolUse(f)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    });
    expect(got.map((e) => [e.toolName, e.decision, e.source])).toEqual([['Bash', 'deny', 'deck']]);
    expect(evs.at(-1)).toMatchObject({ kind: 'result', ok: true });
  });
});

describe('ClaudeEngine: denials from the stream are audited (deck\'s modes never fire the PermissionDenied hook)', () => {
  type Audit = Parameters<NonNullable<TurnRequest['onToolAudit']>>[0];
  const call = (id: string, input: unknown) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] }, session_id: 's1' });

  it('a permission_denied frame and result.permission_denials: one line per call, rule vs cli, never one the prompt tool decided', async () => {
    const got: Audit[] = [];
    await live({ onToolAudit: async (e) => { got.push(e); } }, async (f) => {
      // A call deck itself asked the user about (and audits itself): the prompt tool marks it before it runs.
      await f.ask({ tool_name: 'Bash', input: { command: 'rm' }, tool_use_id: 'c1' });
    }, [
      call('d1', { command: 'curl x' }),
      { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'd1', decision_reason_type: 'rule', message: 'denied', uuid: 'u1', session_id: 's1' },
      call('d2', { command: 'sudo ls' }),
      { ...cli.result('done', 's1'), permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'd1', tool_input: { command: 'curl x' } },
        { tool_name: 'Bash', tool_use_id: 'd2', tool_input: { command: 'sudo ls' } },
        { tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'rm' } },
      ] },
    ]);
    expect(got).toEqual([
      { toolName: 'Bash', input: { command: 'curl x' }, toolUseId: 'd1', decision: 'deny', source: 'rule' },
      { toolName: 'Bash', input: { command: 'sudo ls' }, toolUseId: 'd2', decision: 'deny', source: 'cli' },
    ]);
  });
});

describe('ClaudeEngine: handoff note turn through the CLI (fake)', () => {
  it('hands the no-tools hook to the child and streams the note like any turn', async () => {
    const { f, evs } = await live({ noTools: true }, async (f) => {
      expect(await preToolUse(f)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    }, [cli.delta('## 목표'), cli.result('## 목표', 's1')]);
    expect(evs.map((e) => e.kind)).toEqual(['init', 'delta', 'result']);
    expect(argValue(f.spawns[0]!.args, '--resume')).toBe(SID);
  });
});
