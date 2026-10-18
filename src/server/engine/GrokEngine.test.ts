import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Attachment } from '../attachments/AttachmentStore';
import { AcpRpcError } from './acp/AcpConnection';
import { agentLog, fakeAgent } from './acp/fakeAcpAgent.synthetic';
import type { SpawnFn } from './CodexEngine';
import type { EngineEvent, EngineResult, LiveInput, PermissionRequest } from './Engine';
import { GROK_AGENT_ARGS, GROK_TEXT, classifyGrokError, runGrokTurn, type GrokDeps, type GrokTurnRequest } from './GrokEngine';
import { GrokLock } from './grokLock';

// Every agent here is the SYNTHETIC fake from fakeAcpAgent.synthetic.ts (ACP v1 spec shapes); S1 recordings replace it.

let tmp: string;
let cwd: string;
let home: string;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-grok-engine-')));
  cwd = path.join(tmp, 'work');
  home = path.join(tmp, 'grokhome');
  await fs.mkdir(cwd);
  await fs.mkdir(home);
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const FAST = { lockMs: 2000, initializeMs: 2000, sessionMs: 2000, settingMs: 2000, modeConfirmMs: 200, cancelMs: 400, closeMs: 2000, termMs: 500, killMs: 1000, steerMs: 1000 };
const SID = 'sess-synthetic-1';

type Opts = { req?: Partial<GrokTurnRequest>; deps?: Partial<GrokDeps>; onEvent?: (e: EngineEvent) => void };

function baseReq(over: Partial<GrokTurnRequest> = {}): GrokTurnRequest {
  return {
    account: 'x1', cwd, resumeSessionId: null, model: 'grok', effort: 'high', permissionMode: 'default', prompt: 'hi',
    signal: new AbortController().signal, onPermission: async () => 'once', ...over,
  };
}

async function turn(body: string, o: Opts = {}): Promise<{ events: EngineEvent[]; result: EngineResult; log: Array<Record<string, unknown>>; logs: string[] }> {
  const agent = fakeAgent(tmp, body);
  const logs: string[] = [];
  const deps: GrokDeps = { bin: 'grok', grokHome: home, spawnFn: agent.spawnFn, baseEnv: { PATH: process.env.PATH, HOME: home }, lock: new GrokLock(), timeouts: FAST, log: (m) => logs.push(m), ...o.deps };
  const events: EngineEvent[] = [];
  for await (const e of runGrokTurn(baseReq(o.req), deps)) { events.push(e); o.onEvent?.(e); }
  const results = events.filter((e): e is EngineResult => e.kind === 'result');
  expect(results).toHaveLength(1);
  expect(events.at(-1)).toBe(results[0]);
  return { events, result: results[0]!, log: agentLog(agent.logFile), logs };
}

const methods = (log: Array<Record<string, unknown>>) => log.map((m) => m.method).filter(Boolean);
const responsesTo = (log: Array<Record<string, unknown>>, id: number) => log.filter((m) => m.id === id && m.method === undefined);
const of = <K extends EngineEvent['kind']>(events: EngineEvent[], kind: K) => events.filter((e): e is Extract<EngineEvent, { kind: K }> => e.kind === kind);

describe('runGrokTurn: lifecycle and mapping', () => {
  it('spawns `grok agent --no-leader stdio`, initialize without fs/terminal, new session, mode, effort, prompt', async () => {
    let args: string[] = [];
    const agent = fakeAgent(tmp, '');
    const spawnFn: SpawnFn = (b, a, o) => { args = a; return agent.spawnFn(b, a, o); };
    const { result, events } = await turn('', { deps: { spawnFn }, req: { permissionMode: 'acceptEdits', effort: 'medium' } });
    const log = agentLog(agent.logFile);
    expect(args).toEqual([...GROK_AGENT_ARGS]);
    expect(methods(log)).toEqual(['initialize', 'session/new', 'session/set_mode', 'session/set_config_option', 'session/prompt']);
    expect(log[0]).toMatchObject({ params: { protocolVersion: 1, clientCapabilities: {} } });
    expect(log[1]).toMatchObject({ params: { cwd, mcpServers: [] } });
    expect(log[2]).toMatchObject({ params: { sessionId: SID, modeId: 'acceptEdits' } });
    expect(log[3]).toMatchObject({ params: { sessionId: SID, configId: 'effort', value: 'medium' } });
    expect(log[4]).toMatchObject({ params: { sessionId: SID, prompt: [{ type: 'text', text: 'hi' }] } });
    expect(events[0]).toEqual({ kind: 'init', sessionId: SID, model: 'grok-4.6' });
    expect(result).toMatchObject({ ok: true, sessionId: SID, terminalReason: 'completed' });
  });

  it('maps chunks, thinking, merged tool state with one result each, drops replayed and unknown kinds (logged once)', async () => {
    const { events, result, logs } = await turn(String.raw`
      on('session/prompt', async (p, id) => {
        notify('_x.ai/mcp/servers_updated', {});
        update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' }, _meta: { 'x.ai/replayed': true } });
        update(SID, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
        update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } });
        update(SID, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.txt', kind: 'read', status: 'pending', rawInput: { path: 'a.txt' } });
        update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' });
        update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'content', content: { type: 'text', text: 'line1' } }] });
        update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'again' } }] });
        update(SID, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'ls', kind: 'execute', rawInput: 'ls -la' });
        update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'denied' } }] });
        update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 'child-9', status: 'completed' });
        update(SID, { sessionUpdate: 'mystery_kind', x: 1 });
        update(SID, { sessionUpdate: 'mystery_kind', x: 2 });
        update(SID, { sessionUpdate: 'plan', entries: [] });
        update('other-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child' } });
        update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } });
        respond(id, { stopReason: 'end_turn' });
        update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after-end' } });
      });`);
    expect(of(events, 'delta').map((e) => e.text)).toEqual(['Hel', 'lo']);
    expect(of(events, 'thinking')).toEqual([{ kind: 'thinking', text: 'hmm' }]);
    expect(of(events, 'tool_call')).toEqual([
      { kind: 'tool_call', toolUseId: 't1', name: 'grok:read', input: { path: 'a.txt' } },
      { kind: 'tool_call', toolUseId: 't2', name: 'grok:execute', input: { value: 'ls -la' } },
    ]);
    expect(of(events, 'tool_result')).toEqual([
      { kind: 'tool_result', toolUseId: 't1', content: 'line1', isError: false },
      { kind: 'tool_result', toolUseId: 't2', content: 'denied', isError: true },
    ]);
    expect(logs.filter((l) => l.includes('mystery_kind'))).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, text: 'Hello' });
  });

  it('a tool still open at the end gets one error result (결과 없음); a long result is cut to 32KB', async () => {
    const { events } = await turn(String.raw`
      on('session/prompt', async (p, id) => {
        update(SID, { sessionUpdate: 'tool_call', toolCallId: 'big', title: 'cat', kind: 'read', status: 'in_progress' });
        update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 'big', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'y'.repeat(40000) } }] });
        update(SID, { sessionUpdate: 'tool_call', toolCallId: 'open', title: 'x', kind: 'execute', status: 'in_progress' });
        respond(id, { stopReason: 'end_turn' });
      });`);
    const rs = of(events, 'tool_result');
    expect(rs[0]!.content).toHaveLength(32 * 1024);
    expect(rs[1]).toEqual({ kind: 'tool_result', toolUseId: 'open', content: GROK_TEXT.noResult, isError: true });
  });

  it.each([
    ['max_tokens', true, GROK_TEXT.maxTokens],
    ['max_turn_requests', true, GROK_TEXT.maxTurnRequests],
  ])('stopReason %s → success + notice', async (reason, ok, notice) => {
    const { events, result } = await turn(`on('session/prompt', (p, id) => respond(id, { stopReason: '${reason}' }));`);
    expect(of(events, 'notice').map((e) => e.message)).toContain(notice);
    expect(result.ok).toBe(ok);
  });

  it('stopReason refusal → failure with the refusal text, partial output kept as streamed', async () => {
    const { events, result } = await turn(String.raw`on('session/prompt', (p, id) => {
      update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part' } });
      respond(id, { stopReason: 'refusal' });
    });`);
    expect(of(events, 'delta').map((e) => e.text)).toEqual(['part']);
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.refusal, errorKind: 'refusal' });
  });

  it('stopReason cancelled → the aborted path', async () => {
    const { result } = await turn(`on('session/prompt', (p, id) => respond(id, { stopReason: 'cancelled' }));`);
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
  });

  it('resume: session/load with noReplay; a load failure ends the turn (no session/new, no prompt)', async () => {
    const ok = await turn('', { req: { resumeSessionId: 'sess-old' } });
    expect(agentLogMethodsWithParams(ok.log, 'session/load')).toEqual([{ sessionId: 'sess-old', cwd, mcpServers: [], _meta: { noReplay: true } }]);
    expect(ok.result).toMatchObject({ ok: true, sessionId: 'sess-old' });

    const bad = await turn(`on('session/load', (p, id) => fail(id, -32002, 'Resource not found'));`, { req: { resumeSessionId: 'sess-old' } });
    expect(bad.result.ok).toBe(false);
    expect(methods(bad.log)).toEqual(['initialize', 'session/load']);
  });

  it('a malformed resume id never reaches the agent', async () => {
    const { result, log } = await turn('', { req: { resumeSessionId: '--flag' } });
    expect(result.ok).toBe(false);
    expect(log).toEqual([]);
  });

  it('a new session id is saved before the prompt is sent', async () => {
    const agent = fakeAgent(tmp, '', 'saver');
    let promptSeenAtSave: boolean | null = null;
    const { result } = await turn('', {
      deps: { spawnFn: agent.spawnFn },
      req: { onSessionId: async (id) => { expect(id).toBe(SID); promptSeenAtSave = methods(agentLog(agent.logFile)).includes('session/prompt'); } },
    });
    expect(promptSeenAtSave).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('image attachments are refused when promptCapabilities.image is false (before any session)', async () => {
    const img: Attachment = { id: 'a', name: 'a.png', mediaType: 'image/png', size: 4, path: path.join(tmp, 'a.png'), isImage: true, createdAtMs: 0 };
    const { result, log } = await turn('', { req: { attachments: [img] } });
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.imageUnsupported });
    expect(methods(log)).toEqual(['initialize']);
  });

  it('images go as image blocks when supported; other files as 첨부 파일 lines', async () => {
    await fs.writeFile(path.join(tmp, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const img: Attachment = { id: 'a', name: 'a.png', mediaType: 'image/png', size: 4, path: path.join(tmp, 'a.png'), isImage: true, createdAtMs: 0 };
    const doc: Attachment = { id: 'b', name: 'b.txt', mediaType: 'application/octet-stream', size: 1, path: path.join(tmp, 'b.txt'), isImage: false, createdAtMs: 0 };
    const { log } = await turn(String.raw`on('initialize', (p, id) => respond(id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [] }));`, { req: { attachments: [img, doc] } });
    expect(agentLogMethodsWithParams(log, 'session/prompt')[0]).toMatchObject({
      prompt: [{ type: 'text', text: `hi\n\n첨부 파일: ${doc.path}` }, { type: 'image', mimeType: 'image/png', data: 'iVBORw==' }],
    });
  });

  it('a project .grok/ blocks the turn before spawn', async () => {
    await fs.mkdir(path.join(cwd, '.grok'));
    let spawned = false;
    const { result } = await turn('', { deps: { spawnFn: () => { spawned = true; throw new Error('no'); } } });
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.projectBlocked });
    expect(spawned).toBe(false);
  });

  it('the agent gets the allow-listed env with the seat GROK_HOME', async () => {
    const { log } = await turn(`log({ env: Object.keys(process.env).sort(), home: process.env.GROK_HOME });`, {
      deps: { baseEnv: { PATH: process.env.PATH, HOME: home, XAI_API_KEY: 'x', GROK_HOME: '/elsewhere' } },
    });
    const entry = log.find((m) => m.env) as { env: string[]; home: string };
    expect(entry.home).toBe(home);
    expect(entry.env).not.toContain('XAI_API_KEY');
  });
});

function agentLogMethodsWithParams(log: Array<Record<string, unknown>>, method: string): unknown[] {
  return log.filter((m) => m.method === method).map((m) => m.params);
}

describe('runGrokTurn: permission mode (fail-closed)', () => {
  it('set_mode error → no prompt, turn fails', async () => {
    const { result, log } = await turn(`on('session/set_mode', (p, id) => fail(id, -32601, 'Method not found'));`, { req: { permissionMode: 'plan' } });
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.modeUnconfirmed });
    expect(methods(log)).not.toContain('session/prompt');
  });

  it('set_mode answered but never confirmed → no prompt, turn fails', async () => {
    const { result, log } = await turn(`on('session/set_mode', (p, id) => respond(id, {}));`, { req: { permissionMode: 'plan' } });
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.modeUnconfirmed });
    expect(methods(log)).not.toContain('session/prompt');
  });

  it('confirmed to a different mode → fails', async () => {
    const { result } = await turn(String.raw`on('session/set_mode', (p, id) => { update(p.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' }); respond(id, {}); });`, { req: { permissionMode: 'plan' } });
    expect(result.errorText).toBe(GROK_TEXT.modeUnconfirmed);
  });

  it("a config.toml default of bypass is overridden and confirmed; the session's own matching mode needs no set_mode", async () => {
    const bypass = await turn(`mode = 'bypassPermissions';`, { req: { permissionMode: 'default' } });
    expect(methods(bypass.log)).toContain('session/set_mode');
    expect(bypass.result.ok).toBe(true);
    const same = await turn('', { req: { permissionMode: 'default' } });
    expect(methods(same.log)).not.toContain('session/set_mode');
  });

  it('confirmation via a mode-category config option also counts', async () => {
    const { result } = await turn(String.raw`
      on('session/new', (p, id) => respond(id, { sessionId: SID, configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [] }] }));
      on('session/set_mode', (p, id) => { update(SID, { sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: p.modeId, options: [] }] }); respond(id, {}); });`,
    { req: { permissionMode: 'acceptEdits' } });
    expect(result.ok).toBe(true);
  });

  it('a mode change mid-turn → notice, session/cancel, turn fails', async () => {
    const { result, events, log } = await turn(String.raw`on('session/prompt', (p, id) => {
      update(SID, { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' });
      on('session/cancel', () => respond(id, { stopReason: 'cancelled' }));
    });`);
    expect(of(events, 'notice').map((e) => e.message)).toContain('Grok 권한 모드가 바뀜: bypassPermissions');
    expect(methods(log)).toContain('session/cancel');
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.modeChanged });
  });
});

const PERM_BODY = (options: string, toolCall = `{ toolCallId: 't1', title: 'Write f', kind: 'edit', rawInput: { path: 'f' } }`, announce = true) => String.raw`
  on('session/prompt', async (p, id) => {
    ${announce ? `update(SID, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write f', kind: 'edit', status: 'pending', rawInput: { path: 'f' } });` : ''}
    const r = await ask('session/request_permission', { sessionId: SID, toolCall: ${toolCall}, options: ${options} });
    log({ outcome: r.result });
    respond(id, { stopReason: 'end_turn' });
  });`;
const ALL_OPTS = `[{ optionId: 'ok1', name: 'Allow', kind: 'allow_once' }, { optionId: 'okA', name: 'Always', kind: 'allow_always' }, { optionId: 'no1', name: 'Reject', kind: 'reject_once' }]`;
const outcomeOf = (log: Array<Record<string, unknown>>) => log.find((m) => m.outcome)?.outcome;

describe('runGrokTurn: permissions', () => {
  it("'once' → the allow_once option id; the card gets name, input, toolUseId, title, signal", async () => {
    const seen: PermissionRequest[] = [];
    const { log } = await turn(PERM_BODY(ALL_OPTS), { req: { onPermission: async (r) => { seen.push(r); return 'once'; } } });
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'selected', optionId: 'ok1' } });
    expect(seen[0]).toMatchObject({ toolName: 'grok:edit', input: { path: 'f' }, toolUseId: 't1', title: 'Write f' });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.suggestions).toBeUndefined();
  });

  it("'deny' → reject_once; 'session' is never allow_always", async () => {
    const deny = await turn(PERM_BODY(ALL_OPTS), { req: { onPermission: async () => 'deny' } });
    expect(outcomeOf(deny.log)).toEqual({ outcome: { outcome: 'selected', optionId: 'no1' } });
    const session = await turn(PERM_BODY(ALL_OPTS), { req: { onPermission: async () => 'session' } });
    expect(outcomeOf(session.log)).toEqual({ outcome: { outcome: 'selected', optionId: 'ok1' } });
  });

  it('only broad options → cancelled, never allow_always', async () => {
    const { log } = await turn(PERM_BODY(`[{ optionId: 'okA', name: 'Always', kind: 'allow_always' }, { optionId: 'noA', name: 'Never', kind: 'reject_always' }]`));
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('an unknown toolCallId (subagent) still gets a card, titled 하위 에이전트', async () => {
    const seen: PermissionRequest[] = [];
    await turn(PERM_BODY(ALL_OPTS, `{ toolCallId: 'child-1', title: 'Run x', kind: 'execute' }`, false), { req: { onPermission: async (r) => { seen.push(r); return 'once'; } } });
    expect(seen[0]).toMatchObject({ toolName: 'grok:execute', toolUseId: 'child-1', title: '하위 에이전트 · Run x' });
  });

  it('모두 자동 승인: a listed kind is answered allow_once without a card and audited', async () => {
    let cards = 0;
    const audited: PermissionRequest[] = [];
    const { log } = await turn(PERM_BODY(ALL_OPTS), {
      req: { autoApprove: () => true, onPermission: async () => { cards++; return 'deny'; }, onAutoApproved: async (r) => { audited.push(r); } },
    });
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'selected', optionId: 'ok1' } });
    expect(cards).toBe(0);
    expect(audited.map((r) => r.toolUseId)).toEqual(['t1']);
  });

  it('모두 자동 승인 exceptions go to the card: plan exit (switch_mode), and no allow_once option', async () => {
    let cards = 0;
    const req = { autoApprove: () => true, onPermission: async () => { cards++; return 'deny' as const; } };
    await turn(PERM_BODY(ALL_OPTS, `{ toolCallId: 'p1', title: 'Exit plan', kind: 'switch_mode' }`, false), { req });
    await turn(PERM_BODY(`[{ optionId: 'no1', name: 'Reject', kind: 'reject_once' }]`), { req });
    expect(cards).toBe(2);
  });

  it('audit: a tool that ran without a permission request is logged once as cli; an asked one is not', async () => {
    const audits: unknown[] = [];
    await turn(String.raw`on('session/prompt', async (p, id) => {
      update(SID, { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read', kind: 'read', status: 'pending', rawInput: { path: 'a' } });
      update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'in_progress' });
      update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' });
      update(SID, { sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Edit', kind: 'edit', status: 'pending' });
      await ask('session/request_permission', { sessionId: SID, toolCall: { toolCallId: 'e1' }, options: ${ALL_OPTS} });
      update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed' });
      respond(id, { stopReason: 'end_turn' });
    });`, { req: { onToolAudit: async (e) => { audits.push(e); } } });
    expect(audits).toEqual([{ toolName: 'grok:read', input: { path: 'a' }, toolUseId: 'r1', decision: 'allow', source: 'cli' }]);
  });

  it('abort with a card open: card closed, cancelled answered once, session/cancel sent, a later request answered cancelled', async () => {
    const ac = new AbortController();
    let cardSignal: AbortSignal | undefined;
    let lateAnswer!: (d: 'once') => void;
    const { log, result } = await turn(String.raw`on('session/prompt', async (p, id) => {
      on('session/cancel', async () => {
        const late = await ask('session/request_permission', { sessionId: SID, toolCall: { toolCallId: 'late' }, options: ${ALL_OPTS} });
        log({ late: late.result });
        respond(id, { stopReason: 'cancelled' });
      });
      const r = await ask('session/request_permission', { sessionId: SID, toolCall: { toolCallId: 't1', kind: 'edit' }, options: ${ALL_OPTS} });
      log({ outcome: r.result });
    });`, {
      req: {
        signal: ac.signal,
        onPermission: (r) => { cardSignal = r.signal; setTimeout(() => ac.abort(), 20); return new Promise((res) => { lateAnswer = res; }); },
      },
    });
    lateAnswer('once');
    expect(cardSignal!.aborted).toBe(true);
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect((log.find((m) => m.late) as { late: unknown }).late).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(responsesTo(log, 9000)).toHaveLength(1);
    expect(methods(log).filter((m) => m === 'session/cancel')).toHaveLength(1);
    expect(log.find((m) => m.method === 'session/cancel')).toMatchObject({ params: { sessionId: SID } });
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
  });
});

describe('runGrokTurn: steer', () => {
  it('sends x.ai/interject once per id, delivered at the ACK; false with attachments or after the PromptResponse', async () => {
    let live: LiveInput | undefined;
    const answers: boolean[] = [];
    const { events, log } = await turn(String.raw`
      on('x.ai/interject', (p, id) => respond(id, {}));
      on('session/prompt', async (p, id) => { await wait(150); respond(id, { stopReason: 'end_turn' }); });`, {
      req: {
        onLive: (l) => {
          live = l;
          void (async () => {
            answers.push(await l.send({ text: 'x', attachments: [] }));
            answers.push(await l.steer!({ text: 'more', attachments: [] }, 'st-1'));
            answers.push(await l.steer!({ text: 'more', attachments: [] }, 'st-1'));
            answers.push(await l.steer!({ text: 'pic', attachments: [{ id: 'a' } as Attachment] }, 'st-2'));
          })();
        },
      },
    });
    expect(answers).toEqual([false, true, true, false]);
    expect(agentLogMethodsWithParams(log, 'x.ai/interject')).toEqual([{ sessionId: SID, text: 'more', interjectionId: 'st-1' }]);
    expect(of(events, 'steer_delivered')).toEqual([{ kind: 'steer_delivered', id: 'st-1' }]);
    expect(await live!.steer!({ text: 'late', attachments: [] }, 'st-3')).toBe(false);
  });
});

describe('runGrokTurn: abort and process group', () => {
  it('abort during the prompt: session/cancel, then group kill when no PromptResponse comes', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const { result, log } = await turn(String.raw`process.on('SIGTERM', () => { log({ sigterm: true }); process.exit(0); });
      onEnd = () => {};
      on('session/prompt', () => {});`, { req: { signal: ac.signal, onLive: () => { setTimeout(() => ac.abort(), 30); } } });
    expect(methods(log)).toContain('session/cancel');
    expect(log.some((m) => m.sigterm)).toBe(true);
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(FAST.cancelMs + FAST.termMs + 1500);
  });

  it('abort during start-up (initialize never answered): the stage is dropped, no prompt', async () => {
    const ac = new AbortController();
    // Abort once the agent has read initialize (it logs on receipt), not on a guess about node start-up time.
    const poll = setInterval(() => { if (methods(agentLog(path.join(tmp, 'agent.log.jsonl'))).includes('initialize')) ac.abort(); }, 10);
    const t0 = Date.now();
    const { result, log } = await turn(String.raw`on('initialize', () => {}); onEnd = () => {};`, { req: { signal: ac.signal } })
      .finally(() => clearInterval(poll));
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
    expect(methods(log)).toEqual(['initialize']);
    // Straight to the group kill: no closeMs grace for an aborted start-up.
    expect(Date.now() - t0).toBeLessThan(FAST.closeMs);
  });

  it('a lingering child of the agent is killed with the group before the turn returns', async () => {
    const pidFile = path.join(tmp, 'child.pid');
    await turn(String.raw`
      const c = spawn('sleep', ['30'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      onEnd = () => process.exit(0);`, { deps: { timeouts: { ...FAST, closeMs: 200 } } });
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('turns on one session run one at a time (lock released only after the group ends)', async () => {
    const lock = new GrokLock();
    const spans: Array<[string, number, number]> = [];
    const body = String.raw`on('session/prompt', async (p, id) => { log({ start: Date.now() }); await wait(150); respond(id, { stopReason: 'end_turn' }); });`;
    const a = fakeAgent(tmp, body, 'a');
    const b = fakeAgent(tmp, body, 'b');
    const run = async (name: string, spawnFn: SpawnFn) => {
      const t0 = Date.now();
      for await (const _ of runGrokTurn(baseReq({ resumeSessionId: 'sess-same' }), { bin: 'grok', grokHome: home, spawnFn, baseEnv: { PATH: process.env.PATH }, lock, timeouts: FAST })) { /* drain */ }
      spans.push([name, t0, Date.now()]);
    };
    await Promise.all([run('a', a.spawnFn), run('b', b.spawnFn)]);
    const startA = (agentLog(a.logFile).find((m) => m.start) as { start: number }).start;
    const startB = (agentLog(b.logFile).find((m) => m.start) as { start: number }).start;
    const [first, second] = startA < startB ? ['a', startB] : ['b', startA];
    const firstEnd = spans.find((s) => s[0] === first)![2];
    expect(second).toBeGreaterThanOrEqual(firstEnd - 5);
  });

  it('lock wait over the limit → the lock text, no spawn', async () => {
    const lock = new GrokLock();
    const { grokLockKey } = await import('./grokLock');
    const release = await lock.acquire(grokLockKey(home, 'sess-held', 'x'), { timeoutMs: 1000 });
    let spawned = false;
    const { result } = await turn('', { req: { resumeSessionId: 'sess-held' }, deps: { lock, timeouts: { ...FAST, lockMs: 50 }, spawnFn: () => { spawned = true; throw new Error('no'); } } });
    release();
    expect(result).toMatchObject({ ok: false, errorText: '이전 Grok 프로세스가 아직 끝나지 않음' });
    expect(spawned).toBe(false);
  });

  it('the agent dying mid-prompt → exit code and redacted stderr tail', async () => {
    const { result } = await turn(String.raw`on('session/prompt', () => { process.stderr.write('boom token=abcdefghijklmnop\n'); setTimeout(() => process.exit(3), 20); });`);
    expect(result).toMatchObject({ ok: false, errorText: 'grok 종료 코드 3' });
    expect(result.stderr).toContain('boom');
    expect(result.stderr).not.toContain('abcdefghijklmnop');
  });
});

describe('§8 error classification', () => {
  it('logged-out session/new (observed grok 1.0.62) → login text, no retry', async () => {
    const { result, log } = await turn(`on('session/new', (p, id) => fail(id, -32000, 'Authentication required', 'no auth method id provided'));`);
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.notLoggedIn, errorKind: 'authentication_failed' });
    expect(methods(log).filter((m) => m === 'session/new')).toHaveLength(1);
  });

  it('429 rate_limit → rate_limit event + errorKind; 503 → overloaded notice only', async () => {
    const rl = await turn(`on('session/prompt', (p, id) => fail(id, -32603, 'Too many requests', { type: 'rate_limit', status: 429 }));`);
    expect(of(rl.events, 'rate_limit')).toHaveLength(1);
    expect(rl.result).toMatchObject({ ok: false, errorKind: 'rate_limit', errorText: GROK_TEXT.rateLimit });
    const busy = await turn(`on('session/prompt', (p, id) => fail(id, -32603, 'Service unavailable', { status: 503 }));`);
    expect(of(busy.events, 'rate_limit')).toHaveLength(0);
    expect(of(busy.events, 'notice').map((e) => e.message)).toContain(GROK_TEXT.overloaded);
  });

  it('numbers in tool output are not an error', async () => {
    const { result, events } = await turn(String.raw`on('session/prompt', (p, id) => {
      update(SID, { sessionUpdate: 'tool_call', toolCallId: 't', title: 'curl', kind: 'fetch', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'HTTP 429 rate limit quota exceeded / 503' } }] });
      respond(id, { stopReason: 'end_turn' });
    });`);
    expect(result.ok).toBe(true);
    expect(of(events, 'rate_limit')).toHaveLength(0);
  });

  it('classifyGrokError: structured fields first', () => {
    expect(classifyGrokError(new AcpRpcError(-32000, 'Authentication required', 'no auth method id provided'))).toBe('auth');
    expect(classifyGrokError(new AcpRpcError(-1, 'x', { type: 'authentication_failed' }))).toBe('auth');
    expect(classifyGrokError(new AcpRpcError(-1, 'x', { type: 'rate_limited', status: 429 }))).toBe('rate_limit');
    expect(classifyGrokError(new AcpRpcError(-1, 'monthly quota reached', { type: 'rate_limit' }))).toBe('rate_limit');
    expect(classifyGrokError(new AcpRpcError(-1, 'slow down', { type: 'rate_limit' }))).toBe('overloaded');
    expect(classifyGrokError(new AcpRpcError(-1, 'x', { status: 529 }))).toBe('overloaded');
    expect(classifyGrokError(new AcpRpcError(-1, 'something 429 happened', { type: 'tool_error' }))).toBe('other');
    expect(classifyGrokError(new Error('429'))).toBe('other');
  });
});
