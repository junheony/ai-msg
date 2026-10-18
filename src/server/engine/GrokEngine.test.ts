import { spawn as nodeSpawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../attachments/AttachmentStore';
import { AcpRpcError } from './acp/AcpConnection';
import { agentLog, fakeAgent } from './acp/fakeAcpAgent';
import type { SpawnFn } from './CodexEngine';
import type { EngineEvent, EngineResult, LiveInput, PermissionRequest } from './Engine';
import {
  GROK_AGENT_ARGS, GROK_INTERJECT_METHOD, GROK_TEXT, GrokEngineLock, classifyGrokError, grokEngineLockedText, isGrokAutoApprovable, runGrokTurn,
  type GrokDeps, type GrokSessionStamp, type GrokTurnRequest,
} from './GrokEngine';
import { GrokLock, grokLockKey } from './grokLock';

// Agents here are the fake from acp/fakeAcpAgent.ts, shaped after the grok 1.0.62 recordings (fixtures/grok-1.0.62/).

const FIXTURES = path.join(__dirname, 'acp', 'fixtures', 'grok-1.0.62');
const CLEAN_INSPECT = JSON.parse(fsSync.readFileSync(path.join(FIXTURES, 'inspect.clean.json'), 'utf8')) as unknown;
const CLAUDE_RULES_INSPECT = JSON.parse(fsSync.readFileSync(path.join(FIXTURES, 'inspect.claude-rules.json'), 'utf8')) as unknown;

let tmp: string;
let cwd: string;
let home: string;
let realHome: string;
let homesDir: string;
let engineLock: GrokEngineLock;
let stamps: Map<string, GrokSessionStamp>;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-grok-engine-')));
  cwd = path.join(tmp, 'work');
  home = path.join(tmp, 'grokhome');
  realHome = path.join(tmp, 'realhome');
  homesDir = path.join(tmp, 'homes');
  await fs.mkdir(cwd);
  await fs.mkdir(home);
  await fs.mkdir(realHome);
  engineLock = new GrokEngineLock();
  stamps = new Map();
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const FAST = {
  lockMs: 2000, initializeMs: 2000, sessionMs: 2000, settingMs: 2000, cancelMs: 400, closeMs: 2000, termMs: 500, killMs: 1000,
  steerMs: 1000, categoryMs: 150, fallbackMs: 300, sampleMs: 2000, billingMs: 300,
};
const SID = '01a14e16-8100-7cb3-b038-2b02138059a5';
const CHILD = '01a14e16-aaaa-7cb3-b038-2b02138059a5';

type Opts = { req?: Partial<GrokTurnRequest>; deps?: Partial<GrokDeps>; onEvent?: (e: EngineEvent) => void };

function baseReq(over: Partial<GrokTurnRequest> = {}): GrokTurnRequest {
  return {
    account: 'x1', cwd, resumeSessionId: null, model: 'grok', effort: 'high', permissionMode: 'default', prompt: 'hi',
    signal: new AbortController().signal, onPermission: async () => 'once', ...over,
  };
}

function baseDeps(spawnFn: SpawnFn, over: Partial<GrokDeps> = {}): GrokDeps {
  return {
    bin: 'grok', grokHome: home, homesDir, realHome, inspect: async () => CLEAN_INSPECT, readConfig: async () => '',
    engineLock, sessionStamps: stamps, spawnFn, baseEnv: { PATH: process.env.PATH, HOME: realHome }, lock: new GrokLock(), timeouts: FAST,
    log: () => {}, ...over,
  };
}

async function turn(body: string, o: Opts = {}): Promise<{ events: EngineEvent[]; result: EngineResult; log: Array<Record<string, unknown>>; logs: string[] }> {
  const agent = fakeAgent(tmp, body);
  const logs: string[] = [];
  const deps = baseDeps(agent.spawnFn, { log: (m) => logs.push(m), ...o.deps });
  const events: EngineEvent[] = [];
  for await (const e of runGrokTurn(baseReq(o.req), deps)) { events.push(e); o.onEvent?.(e); }
  const results = events.filter((e): e is EngineResult => e.kind === 'result');
  expect(results).toHaveLength(1);
  expect(events.at(-1)).toBe(results[0]);
  return { events, result: results[0]!, log: agentLog(agent.logFile), logs };
}

const methods = (log: Array<Record<string, unknown>>) => log.map((m) => m.method).filter(Boolean);
const responsesTo = (log: Array<Record<string, unknown>>, id: number) => log.filter((m) => m.id === id && m.method === undefined);
const paramsOf = (log: Array<Record<string, unknown>>, method: string): unknown[] => log.filter((m) => m.method === method).map((m) => m.params);
const of = <K extends EngineEvent['kind']>(events: EngineEvent[], kind: K) => events.filter((e): e is Extract<EngineEvent, { kind: K }> => e.kind === kind);
const outcomeOf = (log: Array<Record<string, unknown>>) => log.find((m) => m.outcome)?.outcome;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const noSpawn = (flag: { spawned: boolean }): SpawnFn => () => { flag.spawned = true; throw new Error('no'); };

/** A write tool as grok sends it: tool_call (x.ai/tool), tool_call_update with ACP kind, then the permission request. */
const WRITE = (file: string) => String.raw`
  toolCall(SID, 't1', 'write', 'write', { file_path: ${JSON.stringify(file)}, content: 'hi' });
  toolUpdate(SID, 't1', { kind: 'edit', title: 'Write f', locations: [{ path: ${JSON.stringify(file)} }], rawInput: { variant: 'Write', file_path: ${JSON.stringify(file)}, content: 'hi' } });`;
const ASK_WRITE = (file: string) => String.raw`
  on('session/prompt', async (p, id) => {
    ${WRITE(file)}
    const r = await askPermission({ toolCallId: 't1', kind: 'edit', title: 'Write f', rawInput: { variant: 'Write', file_path: ${JSON.stringify(file)}, content: 'hi' } });
    log({ outcome: r.result });
    if (r.result.outcome.optionId === 'allow-once') toolUpdate(SID, 't1', { status: 'completed', content: [] });
    complete(id);
  });`;

describe('runGrokTurn: lifecycle and mapping', () => {
  it('spawns `grok agent --no-leader stdio`: initialize, session/new with yolo/auto off, effort by category, prompt; no set_mode', async () => {
    let args: string[] = [];
    const agent = fakeAgent(tmp, '');
    const spawnFn: SpawnFn = (b, a, o) => { args = a; return agent.spawnFn(b, a, o); };
    const { result, events } = await turn('', { deps: { spawnFn }, req: { permissionMode: 'acceptEdits', effort: 'medium' } });
    const log = agentLog(agent.logFile);
    expect(args).toEqual([...GROK_AGENT_ARGS]);
    // `_x.ai/billing` after the prompt (the fake has no handler: Method not found, ignored).
    expect(methods(log)).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/prompt', '_x.ai/billing']);
    expect(log[0]).toMatchObject({ params: { protocolVersion: 1, clientCapabilities: {} } });
    expect(log[1]).toMatchObject({ params: { cwd, mcpServers: [], _meta: { yoloMode: false, autoMode: false } } });
    expect(log[2]).toMatchObject({ params: { sessionId: SID, configId: 'reasoning_effort', value: 'medium' } });
    expect(log[3]).toMatchObject({ params: { sessionId: SID, prompt: [{ type: 'text', text: 'hi' }] } });
    expect(events[0]).toEqual({ kind: 'init', sessionId: SID, model: 'grok-4.7' });
    // PromptResponse _meta.usage: inputTokens includes the cached reads.
    expect(result).toMatchObject({ ok: true, sessionId: SID, terminalReason: 'completed', usage: { inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheCreationTokens: 0 } });
  });

  it('after the prompt, `_x.ai/billing` on the same connection rides the result (grokBilling)', async () => {
    const { result, log } = await turn(String.raw`
      on('_x.ai/billing', (p, id) => respond(id, { config: { creditUsagePercent: 1.0, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-18T07:54:33.561+00:00', end: '2026-10-25T07:54:33.561+00:00' }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true }, subscription_tier: 'SuperGrok Heavy' }));`);
    expect(methods(log).slice(-2)).toEqual(['session/prompt', '_x.ai/billing']);
    expect(paramsOf(log, '_x.ai/billing')).toEqual([{}]);
    expect(result).toMatchObject({ ok: true, text: '', grokBilling: { usedPct: 1, windowStart: '2026-10-18T07:54:33.561+00:00', windowEnd: '2026-10-25T07:54:33.561+00:00', tier: 'SuperGrok Heavy', periodType: 'USAGE_PERIOD_TYPE_WEEKLY' } });
  });

  it('billing Method not found, a billing error or a billing that never answers: the turn result is unchanged, no grokBilling', async () => {
    const missing = await turn('');
    expect(missing.result).toMatchObject({ ok: true, terminalReason: 'completed' });
    expect(missing.result.grokBilling).toBeUndefined();
    const failed = await turn(String.raw`on('_x.ai/billing', (p, id) => fail(id, -32603, 'boom'));`);
    expect(failed.result).toMatchObject({ ok: true });
    expect(failed.result.grokBilling).toBeUndefined();
    const t0 = Date.now();
    const silent = await turn(String.raw`on('_x.ai/billing', () => {});`);
    expect(silent.result).toMatchObject({ ok: true });
    expect(silent.result.grokBilling).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(FAST.closeMs + 1500);
  });

  it('no billing request for a turn that never got a PromptResponse (refused before the prompt)', async () => {
    const { log } = await turn(String.raw`on('session/new', (p, id) => fail(id, -32000, 'Authentication required'));`);
    expect(methods(log)).not.toContain('_x.ai/billing');
  });

  it('a picked model goes by the model option; the same effort as the current one sends nothing', async () => {
    const { log } = await turn('', { req: { model: 'grok-4.6', effort: 'high' } });
    expect(paramsOf(log, 'session/set_config_option')).toEqual([{ sessionId: SID, configId: 'model', value: 'grok-4.6' }]);
  });

  it('maps chunks, thinking and tool state (kind from the update, name from x.ai/tool); drops replay, other sessions, after-end', async () => {
    const { events, result, logs } = await turn(String.raw`
      on('session/prompt', async (p, id) => {
        update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } }, { isReplay: true });
        update(SID, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
        update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } });
        toolCall(SID, 'r1', 'read_file', 'read', { path: 'a.txt' });
        toolUpdate(SID, 'r1', { kind: 'read', title: 'Read a.txt' });
        toolUpdate(SID, 'r1', { status: 'in_progress' });
        toolUpdate(SID, 'r1', { status: 'completed', content: text('line1') });
        toolUpdate(SID, 'r1', { status: 'completed', content: text('again') });
        notify('_x.ai/session_notification', { sessionId: SID, update: { sessionUpdate: 'tool_call_delta_chunk', tool_index: 0 } });
        update(SID, { sessionUpdate: 'mystery_kind', x: 1 });
        update(SID, { sessionUpdate: 'mystery_kind', x: 2 });
        update(SID, { sessionUpdate: 'available_commands_update', availableCommands: [] });
        update('other-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child' } });
        update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } });
        complete(id);
        update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after-end' } });
      });`);
    expect(of(events, 'delta').map((e) => e.text)).toEqual(['Hel', 'lo']);
    expect(of(events, 'thinking')).toEqual([{ kind: 'thinking', text: 'hmm' }]);
    expect(of(events, 'tool_call')).toEqual([{ kind: 'tool_call', toolUseId: 'r1', name: 'grok:read_file', input: { path: 'a.txt' } }]);
    expect(of(events, 'tool_result')).toEqual([{ kind: 'tool_result', toolUseId: 'r1', content: 'line1', isError: false }]);
    expect(logs.filter((l) => l.includes('mystery_kind'))).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, text: 'Hello' });
  });

  it('a tool still open at the end gets one error result (결과 없음); a long result is cut to 32KB', async () => {
    const { events } = await turn(String.raw`
      on('session/prompt', async (p, id) => {
        toolCall(SID, 'big', 'read_file', 'read', { path: 'b' });
        toolUpdate(SID, 'big', { status: 'completed', content: text('y'.repeat(40000)) });
        toolCall(SID, 'open', 'read_file', 'read', { path: 'c' });
        complete(id);
      });`);
    const rs = of(events, 'tool_result');
    expect(rs[0]!.content).toHaveLength(32 * 1024);
    expect(rs[1]).toEqual({ kind: 'tool_result', toolUseId: 'open', content: GROK_TEXT.noResult, isError: true });
  });

  it.each([
    ['max_tokens', GROK_TEXT.maxTokens],
    ['max_turn_requests', GROK_TEXT.maxTurnRequests],
  ])('stopReason %s → success + notice', async (reason, notice) => {
    const { events, result } = await turn(`on('session/prompt', (p, id) => complete(id, '${reason}'));`);
    expect(of(events, 'notice').map((e) => e.message)).toContain(notice);
    expect(result.ok).toBe(true);
  });

  it('stopReason refusal → failure with the refusal text, partial output kept as streamed', async () => {
    const { events, result } = await turn(String.raw`on('session/prompt', (p, id) => {
      update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part' } });
      complete(id, 'refusal');
    });`);
    expect(of(events, 'delta').map((e) => e.text)).toEqual(['part']);
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.refusal, errorKind: 'refusal' });
  });

  it('resume: session/load with noReplay and yolo/auto off; a load failure ends the turn (no session/new, no prompt)', async () => {
    const ok = await turn('', { req: { resumeSessionId: 'sess-old' } });
    expect(paramsOf(ok.log, 'session/load')).toEqual([{ sessionId: 'sess-old', cwd, mcpServers: [], _meta: { yoloMode: false, autoMode: false, noReplay: true } }]);
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
    expect(paramsOf(log, 'session/prompt')[0]).toMatchObject({
      prompt: [{ type: 'text', text: `hi\n\n첨부 파일: ${doc.path}` }, { type: 'image', mimeType: 'image/png', data: 'iVBORw==' }],
    });
  });

  it('a project .grok/ blocks the turn before spawn', async () => {
    await fs.mkdir(path.join(cwd, '.grok'));
    const flag = { spawned: false };
    const { result } = await turn('', { deps: { spawnFn: noSpawn(flag) } });
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.projectBlocked });
    expect(flag.spawned).toBe(false);
  });

  it('a project .cursor/ blocks the turn before spawn too', async () => {
    await fs.mkdir(path.join(cwd, '.cursor'));
    const flag = { spawned: false };
    const { result } = await turn('', { deps: { spawnFn: noSpawn(flag) } });
    expect(result).toMatchObject({ ok: false, errorKind: 'grok_project_config' });
    expect(GROK_TEXT.projectBlocked).toContain('.cursor/');
    expect(flag.spawned).toBe(false);
  });

  it('a session that reports a mode other than default is refused before the prompt', async () => {
    const { result, log } = await turn(String.raw`on('session/new', (p, id) => respond(id, { sessionId: SID, modes: { currentModeId: 'plan', availableModes: [] }, configOptions: configOptions() }));`);
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.modeUnconfirmed });
    expect(methods(log)).not.toContain('session/prompt');
  });
});

describe('runGrokTurn: shadow HOME, inspect, plan, engine lock (start gates)', () => {
  it('the agent and inspect get a fresh shadow HOME (allowed links only), the seat GROK_HOME, SSH_AUTH_SOCK; the folder goes after the turn', async () => {
    await fs.writeFile(path.join(realHome, '.gitconfig'), '[user]\n');
    await fs.mkdir(path.join(realHome, '.claude'));
    let inspected: { env: Record<string, string>; cwd: string; entries: string[] } | null = null;
    const { log, result } = await turn(`log({ env: Object.keys(process.env).sort(), home: process.env.HOME, grokHome: process.env.GROK_HOME, sock: process.env.SSH_AUTH_SOCK, entries: require('fs').readdirSync(process.env.HOME).sort() });`, {
      deps: {
        baseEnv: { PATH: process.env.PATH, HOME: realHome, XAI_API_KEY: 'x', GROK_HOME: '/elsewhere', SSH_AUTH_SOCK: '/tmp/agent.sock' },
        inspect: async (env, c) => { inspected = { env, cwd: c, entries: (await fs.readdir(env.HOME!)).sort() }; return CLEAN_INSPECT; },
      },
    });
    expect(result.ok).toBe(true);
    const entry = log.find((m) => m.env) as { env: string[]; home: string; grokHome: string; sock: string; entries: string[] };
    expect(path.dirname(entry.home)).toBe(homesDir);
    expect(entry.grokHome).toBe(home);
    expect(entry.sock).toBe('/tmp/agent.sock');
    expect(entry.env).not.toContain('XAI_API_KEY');
    expect(entry.entries).toEqual(['.gitconfig']);
    expect(inspected!.env.HOME).toBe(entry.home);
    expect(inspected!.env.GROK_HOME).toBe(home);
    expect(inspected!.cwd).toBe(cwd);
    expect(await fs.readdir(homesDir)).toEqual([]);
  });

  it('inspect showing Claude permission rules → refused, no spawn (fail-closed); a failing inspect too', async () => {
    const flag = { spawned: false };
    const rules = await turn('', { deps: { spawnFn: noSpawn(flag), inspect: async () => CLAUDE_RULES_INSPECT } });
    expect(rules.result).toMatchObject({ ok: false, errorKind: 'grok_inspect' });
    expect(rules.result.errorText).toContain('권한 규칙 출처');
    const broken = await turn('', { deps: { spawnFn: noSpawn(flag), inspect: async () => { throw new Error('grok inspect 출력이 JSON 이 아님'); } } });
    expect(broken.result).toMatchObject({ ok: false, errorKind: 'grok_inspect' });
    expect(broken.result.errorText).toContain(GROK_TEXT.inspectFailed);
    const toml = await turn('', { deps: { spawnFn: noSpawn(flag), inspect: async () => ({ ...(CLEAN_INSPECT as object), configSources: { layers: [{ path: '/x/config.toml' }] } }), readConfig: async () => '[permissions]\ndefault_mode = "auto"\n' } });
    expect(toml.result).toMatchObject({ ok: false, errorKind: 'grok_inspect' });
    expect(flag.spawned).toBe(false);
    expect(await fs.readdir(homesDir)).toEqual([]);
  });

  it('plan mode is refused by the server (hidden in the UI), no spawn', async () => {
    const flag = { spawned: false };
    const { result } = await turn('', { req: { permissionMode: 'plan' }, deps: { spawnFn: noSpawn(flag) } });
    expect(result).toMatchObject({ ok: false, errorText: GROK_TEXT.planUnsupported });
    expect(flag.spawned).toBe(false);
  });

  it('a locked engine refuses the turn before anything; unlock lets the next one run', async () => {
    engineLock.lock('test reason');
    const flag = { spawned: false };
    const locked = await turn('', { deps: { spawnFn: noSpawn(flag) } });
    expect(locked.result).toMatchObject({ ok: false, errorKind: 'grok_engine_locked', errorText: grokEngineLockedText('test reason') });
    expect(flag.spawned).toBe(false);
    engineLock.unlock();
    expect((await turn('')).result.ok).toBe(true);
  });
});

describe('isGrokAutoApprovable', () => {
  it("only the listed kinds of a grok card; plan exit, mode switches, unknown kinds and other engines' tools never", () => {
    for (const k of ['edit', 'execute', 'read', 'fetch', 'search']) expect(isGrokAutoApprovable(`grok:${k}`)).toBe(true);
    for (const t of ['grok:switch_mode', 'grok:exit_plan_mode', 'grok:other', 'grok:', 'edit', 'ExitPlanMode', 'Bash']) expect(isGrokAutoApprovable(t)).toBe(false);
  });
});

describe('runGrokTurn: permissions (deck answers; Grok stays in default)', () => {
  it("'once' → allow-once to the agent's request id 0; the card gets name, input, toolUseId, title, signal", async () => {
    const seen: PermissionRequest[] = [];
    const file = path.join(cwd, 'f');
    const { log, events } = await turn(ASK_WRITE(file), { req: { onPermission: async (r) => { seen.push(r); return 'once'; } } });
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(responsesTo(log, 0)).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolName: 'grok:edit', input: { variant: 'Write', file_path: file }, toolUseId: 't1', title: 'Write f' });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(of(events, 'tool_call')).toEqual([{ kind: 'tool_call', toolUseId: 't1', name: 'grok:write', input: { file_path: file, content: 'hi' } }]);
  });

  it("'deny' → reject-once; 'session' never allow-edits-session / always-allow", async () => {
    const deny = await turn(ASK_WRITE(path.join(cwd, 'f')), { req: { onPermission: async () => 'deny' } });
    expect(outcomeOf(deny.log)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    const session = await turn(ASK_WRITE(path.join(cwd, 'f')), { req: { onPermission: async () => 'session' } });
    expect(outcomeOf(session.log)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('only broad options → cancelled, never allow_always', async () => {
    const { log } = await turn(String.raw`on('session/prompt', async (p, id) => {
      const r = await askPermission({ toolCallId: 'x', kind: 'execute', rawInput: { command: 'rm x' } }, [BASH_OPTS[0], BASH_OPTS[3]]);
      log({ outcome: r.result }); complete(id);
    });`);
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('a subagent (subagent_spawned) gets a card titled 하위 에이전트; an unknown requester or session is rejected with no card', async () => {
    const seen: PermissionRequest[] = [];
    const { log } = await turn(String.raw`on('session/prompt', async (p, id) => {
      notify('_x.ai/session_notification', { sessionId: SID, update: { sessionUpdate: 'subagent_spawned', child_session_id: CHILD, parent_session_id: SID } });
      const a = await askPermission({ toolCallId: 'c1', kind: 'execute', title: 'Run x', rawInput: { command: 'x' } }, BASH_OPTS, CHILD);
      log({ child: a.result });
      const b = await askPermission({ toolCallId: 'c2', kind: 'execute', title: 'Run y', rawInput: { command: 'y' } }, BASH_OPTS, 'stranger');
      log({ stranger: b.result });
      const c = await ask('session/request_permission', { sessionId: 'other', toolCall: { toolCallId: 'c3', kind: 'edit' }, options: EDIT_OPTS });
      log({ other: c.result });
      complete(id);
    });`, { req: { onPermission: async (r) => { seen.push(r); return 'once'; } } });
    expect(seen).toEqual([expect.objectContaining({ toolName: 'grok:execute', toolUseId: 'c1', title: '하위 에이전트 · Run x' })]);
    const pick = (k: string) => (log.find((m) => m[k]) as Record<string, unknown>)[k];
    expect(pick('child')).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(pick('stranger')).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(pick('other')).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
  });

  it('§14.9-5: a request outside the running prompt (during the settings, after the PromptResponse) is rejected with no card', async () => {
    let cards = 0;
    const { log, result } = await turn(String.raw`
      on('session/set_config_option', async (p, id) => {
        const r = await askPermission({ toolCallId: 'early', kind: 'edit' });
        log({ early: r.result });
        effort = p.value; respond(id, { configOptions: configOptions() });
      });
      on('session/prompt', async (p, id) => {
        complete(id);
        const r = await askPermission({ toolCallId: 'late', kind: 'edit' });
        log({ late: r.result });
      });`, { req: { effort: 'low', autoApprove: () => true, onPermission: async () => { cards++; return 'once'; } } });
    const pick = (k: string) => (log.find((m) => m[k]) as Record<string, unknown>)[k];
    expect(pick('early')).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(pick('late')).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(cards).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('모두 자동 승인: a listed kind is answered allow-once without a card and audited; switch_mode still asks', async () => {
    let cards = 0;
    const audited: PermissionRequest[] = [];
    const req = { autoApprove: () => true, onPermission: async () => { cards++; return 'deny' as const; }, onAutoApproved: async (r: PermissionRequest) => { audited.push(r); } };
    const { log } = await turn(ASK_WRITE(path.join(tmp, 'outside')), { req });
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(cards).toBe(0);
    expect(audited.map((r) => r.toolUseId)).toEqual(['t1']);
    await turn(String.raw`on('session/prompt', async (p, id) => { const r = await askPermission({ toolCallId: 'p1', kind: 'switch_mode', title: 'Exit plan' }); log({ outcome: r.result }); complete(id); });`, { req });
    expect(cards).toBe(1);
  });

  it('편집 자동: an edit inside the cwd is allowed with no card; outside, a denied path or a shell command asks', async () => {
    let cards = 0;
    const audited: string[] = [];
    const req = { editAuto: () => true, onPermission: async () => { cards++; return 'deny' as const; }, onAutoApproved: async (r: PermissionRequest) => { audited.push(r.toolUseId); } };
    const inside = await turn(ASK_WRITE(path.join(cwd, 'src', 'a.ts')), { req });
    expect(outcomeOf(inside.log)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(cards).toBe(0);
    expect(audited).toEqual(['t1']);
    for (const file of [path.join(tmp, 'outside.txt'), path.join(cwd, '.git', 'hooks', 'pre-commit'), path.join(cwd, '.env')]) {
      const r = await turn(ASK_WRITE(file), { req });
      expect(outcomeOf(r.log), file).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    }
    await turn(String.raw`on('session/prompt', async (p, id) => { const r = await askPermission({ toolCallId: 'b', kind: 'execute', rawInput: { command: 'touch x' } }, BASH_OPTS); log({ outcome: r.result }); complete(id); });`, { req });
    expect(cards).toBe(4);
  });

  it('the mode is read live per request: 편집 자동 switched off before the answer → a card', async () => {
    let on = true;
    let cards = 0;
    const { log } = await turn(ASK_WRITE(path.join(cwd, 'a.ts')), {
      req: { editAuto: () => on, onAutoApproved: async () => { on = false; }, onPermission: async () => { cards++; return 'deny'; } },
    });
    expect(cards).toBe(1);
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
  });

  it('audit: a read tool that ran without a request is logged once as cli; an asked one is not', async () => {
    const audits: unknown[] = [];
    await turn(String.raw`on('session/prompt', async (p, id) => {
      toolCall(SID, 'r1', 'read_file', 'read', { path: 'a' });
      toolUpdate(SID, 'r1', { status: 'in_progress' });
      toolUpdate(SID, 'r1', { status: 'completed' });
      ${WRITE(path.join(cwd, 'f'))}
      await askPermission({ toolCallId: 't1', kind: 'edit' });
      toolUpdate(SID, 't1', { status: 'completed' });
      complete(id);
    });`, { req: { onToolAudit: async (e) => { audits.push(e); } } });
    expect(audits).toEqual([{ toolName: 'grok:read_file', input: { path: 'a' }, toolUseId: 'r1', decision: 'allow', source: 'cli' }]);
  });

  it('§14.9-6: abort with a card open: card closed, cancelled answered once, session/cancel, a later request cancelled', async () => {
    const ac = new AbortController();
    let cardSignal: AbortSignal | undefined;
    let lateAnswer!: (d: 'once') => void;
    const { log, result, events } = await turn(String.raw`on('session/prompt', async (p, id) => {
      on('session/cancel', async () => {
        const late = await askPermission({ toolCallId: 'late', kind: 'edit' });
        log({ late: late.result });
        complete(id, 'cancelled', 'MidTurnAbort');
      });
      ${WRITE(path.join(cwd, 'f'))}
      const r = await askPermission({ toolCallId: 't1', kind: 'edit' });
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
    expect(responsesTo(log, 0)).toHaveLength(1);
    expect(methods(log).filter((m) => m === 'session/cancel')).toHaveLength(1);
    expect(log.find((m) => m.method === 'session/cancel')).toMatchObject({ params: { sessionId: SID } });
    expect(of(events, 'tool_result')).toEqual([{ kind: 'tool_result', toolUseId: 't1', content: GROK_TEXT.aborted, isError: true }]);
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
  });
});

describe('runGrokTurn: end of turn (§14.9-7)', () => {
  it.each([
    ['PermissionRejected', { ok: false, errorText: GROK_TEXT.stopRejected, text: 'part' }],
    ['PermissionCancelled', { ok: false, errorText: GROK_TEXT.stopCancelled, text: 'part' }],
    ['MidTurnAbort', { ok: false, errorText: GROK_TEXT.aborted, terminalReason: 'aborted' }],
  ])('cancelled with %s', async (category, expected) => {
    const { result } = await turn(String.raw`on('session/prompt', (p, id) => {
      update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part' } });
      complete(id, 'cancelled', '${category}');
    });`);
    expect(result).toMatchObject(expected);
  });

  it('a category that only comes after the PromptResponse still counts; none at all → 원인 미확인', async () => {
    const late = await turn(String.raw`on('session/prompt', async (p, id) => {
      respond(id, { stopReason: 'cancelled', _meta: {} });
      await wait(30);
      notify('_x.ai/session/prompt_complete', { sessionId: SID, promptId: PROMPT_ID, stopReason: 'cancelled', cancellationCategory: 'PermissionCancelled' });
    });`);
    expect(late.result).toMatchObject({ ok: false, errorText: GROK_TEXT.stopCancelled });
    const none = await turn(`on('session/prompt', (p, id) => respond(id, { stopReason: 'cancelled' }));`);
    expect(none.result).toMatchObject({ ok: false, errorText: GROK_TEXT.stopUnknown });
  });

  it('deck ■ always wins: an RPC error after the cancel is the abort', async () => {
    const ac = new AbortController();
    const { result } = await turn(String.raw`on('session/prompt', (p, id) => { on('session/cancel', () => fail(id, -32603, 'Interrupted by user')); });`, {
      req: { signal: ac.signal, onLive: () => { setTimeout(() => ac.abort(), 30); } },
    });
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted', errorText: GROK_TEXT.aborted });
  });

  it('a response to an id deck never sent is ignored', async () => {
    const { result } = await turn(String.raw`on('session/prompt', (p, id) => { respond(4242, { stopReason: 'cancelled' }); complete(id); });`);
    expect(result.ok).toBe(true);
  });
});

describe('runGrokTurn: tripwire and engine lock (§14.9-3)', () => {
  it('a write that runs with no permission request stops the turn and locks the engine; the next turn is refused', async () => {
    const changes: Array<string | null> = [];
    engineLock.onChange((r) => changes.push(r));
    const { result, log, logs } = await turn(String.raw`on('session/prompt', async (p, id) => {
      on('session/cancel', () => complete(id, 'cancelled', 'MidTurnAbort'));
      toolCall(SID, 'w1', 'run_terminal_command', 'execute', { command: 'printf sub > sub.txt', description: 'x' });
      toolUpdate(SID, 'w1', { kind: 'execute', rawInput: { variant: 'Bash', command: 'printf sub > sub.txt' } });
      toolUpdate(SID, 'w1', { status: 'in_progress' });
    });`);
    expect(methods(log)).toContain('session/cancel');
    expect(result).toMatchObject({ ok: false, errorKind: 'grok_tripwire', errorText: GROK_TEXT.tripwire });
    expect(engineLock.reason).toContain('no permission request');
    expect(changes).toHaveLength(1);
    expect(logs.some((l) => l.includes('tripwire'))).toBe(true);
    const flag = { spawned: false };
    const next = await turn('', { deps: { spawnFn: noSpawn(flag) } });
    expect(next.result.errorKind).toBe('grok_engine_locked');
    expect(flag.spawned).toBe(false);
  });

  it("Grok's no-approval list (read tools, read-only shell, mkdir, touch) and a not-run (blocked or rejected) tool do not trip", async () => {
    const { result } = await turn(String.raw`on('session/prompt', async (p, id) => {
      toolCall(SID, 'a', 'run_terminal_command', 'execute', { command: 'git status && ls' }); toolUpdate(SID, 'a', { kind: 'execute', status: 'completed' });
      toolCall(SID, 'b', 'run_terminal_command', 'execute', { command: 'mkdir -p out && touch out/x' }); toolUpdate(SID, 'b', { status: 'completed' });
      toolCall(SID, 'c', 'list_dir', 'read', { path: '.' }); toolUpdate(SID, 'c', { status: 'completed' });
      toolCall(SID, 'd', 'run_terminal_command', 'execute', { command: 'rm -rf x' });
      toolUpdate(SID, 'd', { kind: 'execute', status: 'failed', content: text('Tool run_terminal_command was not executed: Auto mode blocked this action') });
      toolCall(SID, 'e', 'write', 'write', { file_path: 'x' });
      toolUpdate(SID, 'e', { status: 'failed', content: text('User rejected the execution for tool write'), _meta: { toolNotRun: 'rejected' } });
      complete(id);
    });`);
    expect(result.ok).toBe(true);
    expect(engineLock.reason).toBeNull();
  });

  it('a subagent edit with no request trips too; an open card is closed (answered cancelled)', async () => {
    let cardSignal: AbortSignal | undefined;
    const { result, log } = await turn(String.raw`on('session/prompt', async (p, id) => {
      on('session/cancel', () => complete(id, 'cancelled', 'MidTurnAbort'));
      notify('_x.ai/session_notification', { sessionId: SID, update: { sessionUpdate: 'subagent_spawned', child_session_id: CHILD, parent_session_id: SID } });
      const r = askPermission({ toolCallId: 'held', kind: 'execute', rawInput: { command: 'rm x' } }, BASH_OPTS);
      await wait(50);
      toolCall(CHILD, 'cw', 'write', 'write', { file_path: 'y' });
      toolUpdate(CHILD, 'cw', { kind: 'edit', status: 'completed' });
      log({ outcome: (await r).result });
    });`, { req: { onPermission: (r) => { cardSignal = r.signal; return new Promise(() => {}); } } });
    expect(result.errorKind).toBe('grok_tripwire');
    expect(cardSignal!.aborted).toBe(true);
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('a tool whose request was denied that still runs (in_progress / completed) trips', async () => {
    for (const status of ['in_progress', 'completed']) {
      engineLock.unlock();
      const { result } = await turn(String.raw`on('session/prompt', async (p, id) => {
        on('session/cancel', () => complete(id, 'cancelled', 'MidTurnAbort'));
        ${WRITE(path.join(cwd, 'f'))}
        const r = await askPermission({ toolCallId: 't1', kind: 'edit', title: 'Write f', rawInput: { file_path: 'f' } });
        log({ outcome: r.result });
        toolUpdate(SID, 't1', { status: ${JSON.stringify(status)} });
        await wait(100); complete(id);
      });`, { req: { onPermission: async () => 'deny' } });
      expect(result, status).toMatchObject({ ok: false, errorKind: 'grok_tripwire', errorText: GROK_TEXT.tripwire });
    }
  });

  it('a request rejected outside the running prompt (no card) whose tool then runs trips; an allowed one does not', async () => {
    const late = await turn(String.raw`on('session/prompt', async (p, id) => {
      complete(id);
      const r = await askPermission({ toolCallId: 'late', kind: 'edit', rawInput: { file_path: 'f' } });
      log({ late: r.result });
      toolCall(SID, 'late', 'write', 'write', { file_path: 'f' });
      toolUpdate(SID, 'late', { kind: 'edit', status: 'completed' });
      await wait(100);
    });`);
    expect(late.result).toMatchObject({ ok: false, errorKind: 'grok_tripwire' });
    engineLock.unlock();
    const ok = await turn(ASK_WRITE(path.join(cwd, 'f')));
    expect(ok.result.ok).toBe(true);
    expect(engineLock.reason).toBeNull();
  });

  it('tripped after the PromptResponse: no graceful wait, the group is killed at once', async () => {
    const t0 = Date.now();
    const { result } = await turn(String.raw`onEnd = () => {}; setInterval(() => {}, 1000);
      on('session/prompt', async (p, id) => {
        on('session/cancel', () => complete(id, 'cancelled', 'MidTurnAbort'));
        toolCall(SID, 'w1', 'write', 'write', { file_path: 'x' });
        toolUpdate(SID, 'w1', { kind: 'edit', status: 'completed' });
      });`, { deps: { timeouts: { ...FAST, closeMs: 4000 } } });
    expect(result.errorKind).toBe('grok_tripwire');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a mode change to anything but default (current_mode_update or a mode option) trips', async () => {
    const a = await turn(String.raw`on('session/prompt', (p, id) => {
      on('session/cancel', () => complete(id, 'cancelled', 'MidTurnAbort'));
      update(SID, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    });`);
    expect(a.result).toMatchObject({ ok: false, errorKind: 'grok_tripwire', errorText: GROK_TEXT.modeChanged });
    engineLock.unlock();
    const b = await turn(String.raw`on('session/set_config_option', (p, id) => respond(id, { configOptions: [...configOptions(), { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'auto', options: [] }] }));`, { req: { effort: 'low' } });
    expect(b.result).toMatchObject({ ok: false, errorKind: 'grok_tripwire' });
    expect(methods(b.log)).not.toContain('session/prompt');
  });
});

describe('runGrokTurn: steer (§14.4, §14.9-8)', () => {
  it('_x.ai/interject once per id, queued → 접수됨 notice; repeated ids share the outcome; deterministic (the prompt waits for the interjects)', async () => {
    let live: LiveInput | undefined;
    let answers: boolean[] = [];
    const { events, log } = await turn(String.raw`
      on('_x.ai/interject', (p, id) => {
        interjects.push(p.interjectionId);
        if (p.interjectionId === 'bad') fail(id, -32603, 'no'); else respond(id, { result: { status: 'queued' } });
      });
      on('session/prompt', async (p, id) => { while (interjects.length < 2) await wait(5); complete(id); });`, {
      req: {
        onLive: (l) => {
          live = l;
          const f = { text: 'more', attachments: [] };
          void (async () => {
            answers.push(await l.send({ text: 'x', attachments: [] }));
            answers.push(await l.steer!({ text: 'pic', attachments: [{ id: 'a' } as Attachment] }, 'pic'));
            answers = [...answers, ...(await Promise.all([l.steer!(f, 'good'), l.steer!(f, 'good'), l.steer!(f, 'bad'), l.steer!(f, 'bad')]))];
          })();
        },
      },
    });
    expect(answers).toEqual([false, false, true, true, false, false]);
    expect(paramsOf(log, GROK_INTERJECT_METHOD)).toEqual([
      { sessionId: SID, text: 'more', interjectionId: 'good' },
      { sessionId: SID, text: 'more', interjectionId: 'bad' },
    ]);
    expect(of(events, 'steer_delivered')).toEqual([{ kind: 'steer_delivered', id: 'good' }]);
    expect(of(events, 'notice').map((e) => e.message)).toEqual([GROK_TEXT.steerQueued]);
    expect(await live!.steer!({ text: 'late', attachments: [] }, 'after')).toBe(false);
  });

  it('queued only after the PromptResponse → false; the interject-fallback turn Grok starts is cancelled and only logged', async () => {
    let answer: Promise<boolean> | undefined;
    const { events, result, log, logs } = await turn(String.raw`
      let ij = null;
      on('_x.ai/interject', (p, id) => { ij = id; });
      on('session/prompt', async (p, id) => {
        while (ij === null) await wait(5);
        complete(id);
        respond(ij, { result: { status: 'queued' } });
        notify('_x.ai/queue/changed', { sessionId: SID, runningPromptId: 'interject-fallback-1' });
        update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fallback' } }, { promptId: 'interject-fallback-1' });
      });`, {
      req: { onLive: (l) => { answer = l.steer!({ text: 'more', attachments: [] }, 'st-late'); } },
    });
    expect(await answer).toBe(false);
    expect(of(events, 'steer_delivered')).toEqual([]);
    expect(of(events, 'delta')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(methods(log).filter((m) => m === 'session/cancel')).toHaveLength(1);
    expect(logs.some((l) => l.includes('interject-fallback-1'))).toBe(true);
  });
});

describe('runGrokTurn: abort and process group (§14.9-9)', () => {
  it('abort during the prompt: session/cancel, then group kill when no PromptResponse comes within cancelMs', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const { result, log } = await turn(String.raw`process.on('SIGTERM', () => { log({ sigterm: true }); process.exit(0); });
      onEnd = () => {}; setInterval(() => {}, 1000);
      on('session/prompt', () => {});`, { req: { signal: ac.signal, onLive: () => { setTimeout(() => ac.abort(), 30); } } });
    expect(methods(log)).toContain('session/cancel');
    expect(log.some((m) => m.sigterm)).toBe(true);
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(FAST.cancelMs + FAST.termMs + 1500);
  });

  it('abort during start-up (initialize never answered): the stage is dropped, no prompt', async () => {
    const ac = new AbortController();
    const poll = setInterval(() => { if (methods(agentLog(path.join(tmp, 'agent.log.jsonl'))).includes('initialize')) ac.abort(); }, 10);
    const t0 = Date.now();
    const { result, log } = await turn(String.raw`on('initialize', () => {}); onEnd = () => {};`, { req: { signal: ac.signal } })
      .finally(() => clearInterval(poll));
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
    expect(methods(log)).toEqual(['initialize']);
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

  it('a setsid grandchild (outside the group) is found by ppid and killed too', async () => {
    const pidFile = path.join(tmp, 'stray.pid');
    let stray = 0;
    try {
      await turn(String.raw`
        const c = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`, { deps: { timeouts: { ...FAST, closeMs: 200 } } });
      stray = Number(await fs.readFile(pidFile, 'utf8'));
      expect(stray).toBeGreaterThan(0);
      await vi.waitFor(() => expect(isAlive(stray)).toBe(false), { timeout: 2000, interval: 20 });
    } finally {
      if (stray > 0) try { process.kill(stray, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('an orphan whose parent left (ppid 1) is still reaped by the process group it was seen in', async () => {
    const pidFile = path.join(tmp, 'orphan.pid');
    let orphan = 0;
    try {
      await turn(String.raw`
        spawn('sh', ['-c', 'sleep 30 & echo $! > ' + ${JSON.stringify(pidFile)} + '; sleep 0.6'], { stdio: 'ignore', detached: true });
        on('session/prompt', async (p, id) => { await wait(1000); complete(id); });`, { deps: { timeouts: { ...FAST, closeMs: 200, sampleMs: 100 } } });
      orphan = Number((await fs.readFile(pidFile, 'utf8')).trim());
      expect(orphan).toBeGreaterThan(0);
      await vi.waitFor(() => expect(isAlive(orphan)).toBe(false), { timeout: 2000, interval: 20 });
    } finally {
      if (orphan > 0) try { process.kill(orphan, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('a process group seen earlier is re-checked in a fresh table before the kill: no longer ours → left alone', async () => {
    // An unrelated group (its leader is not a descendant); the agent's fake descendant in it is gone by the sweep.
    const other = nodeSpawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    const g = other.pid!;
    const ghost = 3_999_999;
    try {
      const cap = rootCapture();
      const agent = fakeAgent(tmp, '', 'regroup');
      await turn('', {
        deps: {
          spawnFn: cap.wrap(agent.spawnFn), timeouts: { ...FAST, closeMs: 200 },
          listProcesses: async () => [
            ...(cap.pid() && isAlive(cap.pid()!) ? [{ pid: ghost, ppid: cap.pid()!, pgid: g }] : []),
            { pid: g, ppid: 1, pgid: g },
          ],
        },
      });
      await tick(100);
      expect(isAlive(g)).toBe(true);
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('turns on one session run one at a time (lock released only after the group ends)', async () => {
    const lock = new GrokLock();
    const spans: Array<[string, number, number]> = [];
    const body = String.raw`on('session/prompt', async (p, id) => { log({ start: Date.now() }); await wait(150); complete(id); });`;
    const a = fakeAgent(tmp, body, 'a');
    const b = fakeAgent(tmp, body, 'b');
    const run = async (name: string, spawnFn: SpawnFn) => {
      const t0 = Date.now();
      for await (const _ of runGrokTurn(baseReq({ resumeSessionId: 'sess-same' }), baseDeps(spawnFn, { lock }))) { /* drain */ }
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
    const release = await lock.acquire(grokLockKey(home, 'sess-held', 'x'), { timeoutMs: 1000 });
    const flag = { spawned: false };
    const { result } = await turn('', { req: { resumeSessionId: 'sess-held' }, deps: { lock, timeouts: { ...FAST, lockMs: 50 }, spawnFn: noSpawn(flag) } });
    release();
    expect(result).toMatchObject({ ok: false, errorText: '이전 Grok 프로세스가 아직 끝나지 않음' });
    expect(flag.spawned).toBe(false);
  });

  it('a new session also takes the (home, id) key: held elsewhere → grok_locked, no prompt; both keys released', async () => {
    const lock = new GrokLock();
    const release = await lock.acquire(grokLockKey(home, SID, 'other'), { timeoutMs: 1000 });
    const { result, log } = await turn('', { deps: { lock, timeouts: { ...FAST, lockMs: 100 } } });
    release();
    expect(result).toMatchObject({ ok: false, errorKind: 'grok_locked' });
    expect(methods(log)).toContain('session/new');
    expect(methods(log)).not.toContain('session/prompt');
    await tick();
    expect(lock.size).toBe(0);
  });

  it('an abort while waiting for the lock → aborted, no spawn', async () => {
    const lock = new GrokLock();
    const release = await lock.acquire(grokLockKey(home, 'sess-held', 'x'), { timeoutMs: 5000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const flag = { spawned: false };
    const { result } = await turn('', { req: { resumeSessionId: 'sess-held', signal: ac.signal }, deps: { lock, spawnFn: noSpawn(flag) } });
    release();
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
    expect(flag.spawned).toBe(false);
    await tick();
    expect(lock.size).toBe(0);
  });

  it('an abort while the images are read → no prompt, aborted', async () => {
    await fs.writeFile(path.join(tmp, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const img: Attachment = { id: 'a', name: 'a.png', mediaType: 'image/png', size: 4, path: path.join(tmp, 'a.png'), isImage: true, createdAtMs: 0 };
    const ac = new AbortController();
    const { result, log } = await turn(String.raw`on('initialize', (p, id) => respond(id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [] }));`, {
      req: { attachments: [img], signal: ac.signal },
      onEvent: (e) => { if (e.kind === 'init') ac.abort(); },
    });
    expect(methods(log)).not.toContain('session/prompt');
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
  });

  it('cancel while 자동 승인 is still recording: answered cancelled once, the late finish changes nothing', async () => {
    const ac = new AbortController();
    let finished = false;
    const { log, result } = await turn(String.raw`on('session/prompt', async (p, id) => {
      on('session/cancel', () => setTimeout(() => complete(id, 'cancelled', 'MidTurnAbort'), 50));
      const r = await askPermission({ toolCallId: 't1', kind: 'edit' });
      log({ outcome: r.result });
    });`, {
      req: {
        signal: ac.signal, autoApprove: () => true,
        onAutoApproved: () => { setTimeout(() => ac.abort(), 10); return new Promise<void>((r) => setTimeout(() => { finished = true; r(); }, 300)); },
      },
    });
    expect(outcomeOf(log)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(responsesTo(log, 0)).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, terminalReason: 'aborted' });
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2000 });
    await tick(50);
    expect(responsesTo(agentLog(path.join(tmp, 'agent.log.jsonl')), 0)).toHaveLength(1);
  });

  it('the agent dying mid-prompt → exit code and redacted stderr tail', async () => {
    const { result } = await turn(String.raw`on('session/prompt', () => { process.stderr.write('boom token=abcdefghijklmnop\n'); setTimeout(() => process.exit(3), 20); });`);
    expect(result).toMatchObject({ ok: false, errorText: 'grok 종료 코드 3' });
    expect(result.stderr).toContain('boom');
    expect(result.stderr).not.toContain('abcdefghijklmnop');
  });

  const rootCapture = () => {
    let pid: number | undefined;
    const wrap = (spawnFn: SpawnFn): SpawnFn => (b, a, o) => { const c = spawnFn(b, a, o); pid = c.pid; return c; };
    return { wrap, pid: () => pid };
  };

  it('something that survives SIGKILL → notice before the result, lock released anyway', async () => {
    // A zombie cannot be killed and still answers kill(pid, 0): it stands in for the unkillable descendant.
    const holder = nodeSpawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 10'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const zombie = await new Promise<number>((r) => holder.stdout!.once('data', (d) => r(Number(String(d).trim()))));
      await tick(100);
      const lock = new GrokLock();
      const cap = rootCapture();
      const agent = fakeAgent(tmp, '', 'zagent');
      const { events, logs } = await turn('', {
        deps: {
          lock, spawnFn: cap.wrap(agent.spawnFn), timeouts: { ...FAST, closeMs: 100, termMs: 100, killMs: 100 },
          listProcesses: async () => (cap.pid() ? [{ pid: zombie, ppid: cap.pid()!, pgid: zombie }] : []),
        },
      });
      expect(events.at(-2)).toEqual({ kind: 'notice', message: GROK_TEXT.leftoverProcesses });
      expect(logs.some((l) => l.includes('still alive after SIGKILL'))).toBe(true);
      await tick();
      expect(lock.size).toBe(0);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('an agent that ignores SIGTERM is SIGKILLed', async () => {
    const cap = rootCapture();
    const agent = fakeAgent(tmp, String.raw`process.on('SIGTERM', () => log({ sigterm: true })); onEnd = () => {}; setInterval(() => {}, 1000);`, 'stubborn');
    const t0 = Date.now();
    const { result, events } = await turn('', { deps: { spawnFn: cap.wrap(agent.spawnFn), timeouts: { ...FAST, closeMs: 100, termMs: 200, killMs: 1000 } } });
    expect(result.ok).toBe(true);
    expect(agentLog(agent.logFile).some((m) => m.sigterm)).toBe(true);
    expect(isAlive(cap.pid()!)).toBe(false);
    expect(of(events, 'notice')).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500 + 100 + 200 + 1000);
  });

  it('kill(-pid) failing (no own group) falls back to the child itself', async () => {
    const agent = fakeAgent(tmp, String.raw`process.on('SIGTERM', () => { log({ sigterm: true }); process.exit(0); }); onEnd = () => {}; setInterval(() => {}, 1000);`, 'nogroup');
    let pid = 0;
    const spawnFn: SpawnFn = (_b, args, o) => {
      const c = nodeSpawn(process.execPath, [agent.script, agent.logFile, ...args], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
      pid = c.pid ?? 0;
      return c;
    };
    const { result } = await turn('', { deps: { spawnFn, timeouts: { ...FAST, closeMs: 100 } } });
    expect(result.ok).toBe(true);
    expect(agentLog(agent.logFile).some((m) => m.sigterm)).toBe(true);
    expect(isAlive(pid)).toBe(false);
  });
});

describe('runGrokTurn: outside changes (§14.9-10)', () => {
  it("a session's updates.jsonl changed since deck's last turn → notice; unchanged → none", async () => {
    const dir = path.join(home, 'sessions', 'g1', 'sess-ext');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'updates.jsonl');
    await fs.writeFile(file, '{}\n');
    const notices = async () => of((await turn('', { req: { resumeSessionId: 'sess-ext' } })).events, 'notice').map((e) => e.message);
    expect(await notices()).toEqual([]);
    expect(await notices()).toEqual([]);
    await fs.appendFile(file, '{"more":1}\n');
    expect(await notices()).toEqual([GROK_TEXT.externallyModified]);
    expect(await notices()).toEqual([]);
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
      toolCall(SID, 't', 'web_fetch', 'read', { url: 'x' });
      toolUpdate(SID, 't', { kind: 'fetch', status: 'completed', content: text('HTTP 429 rate limit quota exceeded / 503') });
      complete(id);
    });`);
    expect(result.ok).toBe(true);
    expect(of(events, 'rate_limit')).toHaveLength(0);
  });

  it('classifyGrokError: structured fields first; -32000 alone is auth only with the Authentication required message', () => {
    expect(classifyGrokError(new AcpRpcError(-32000, 'Authentication required', 'no auth method id provided'))).toBe('auth');
    expect(classifyGrokError(new AcpRpcError(-1, 'x', { type: 'authentication_failed' }))).toBe('auth');
    expect(classifyGrokError(new AcpRpcError(-1, 'x', { type: 'rate_limited', status: 429 }))).toBe('rate_limit');
    expect(classifyGrokError(new AcpRpcError(-1, 'monthly quota reached', { type: 'rate_limit' }))).toBe('rate_limit');
    expect(classifyGrokError(new AcpRpcError(-1, 'slow down', { type: 'rate_limit' }))).toBe('overloaded');
    expect(classifyGrokError(new AcpRpcError(-1, 'x', { status: 529 }))).toBe('overloaded');
    expect(classifyGrokError(new AcpRpcError(-1, 'something 429 happened', { type: 'tool_error' }))).toBe('other');
    expect(classifyGrokError(new Error('429'))).toBe('other');
    expect(classifyGrokError(new AcpRpcError(-32000, 'Too many requests', { type: 'rate_limit', status: 429 }))).toBe('rate_limit');
    expect(classifyGrokError(new AcpRpcError(-32000, 'Server error', { status: 503 }))).toBe('overloaded');
    expect(classifyGrokError(new AcpRpcError(-32000, 'Internal error'))).toBe('other');
  });
});
