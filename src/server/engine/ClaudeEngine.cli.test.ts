import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ClaudeEngine, type ClaudeEngineOptions } from './ClaudeEngine';
import type { EngineEvent, LiveInput, TurnRequest } from './Engine';
import { fakeClaudeCli, cli, argValue } from './claudeCli/fakeClaudeCli';
import { PermissionBridge } from './claudeCli/bridge';
import { OwnedEntries } from './claudeCli/ownedEntries';
import { CLAUDE_MISSING_TEXT, FORK_SOURCE_MISSING, PLAN_GATE_MESSAGE, claudeTooOldText, invalidResumeText } from './claudeCli/texts';
import { testRegistry } from '../../shared/accounts.testkit';

let bridge: PermissionBridge | null = null;
let tmp = '';
afterEach(async () => { await bridge?.close(); bridge = null; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ account: 'c', cwd: '/w', resumeSessionId: null, model: 'opus', prompt: 'hi', signal: new AbortController().signal, onPermission: async () => 'once', ...over });
async function setup(over: Partial<ClaudeEngineOptions> = {}, fakeOpts: Parameters<typeof fakeClaudeCli>[0] = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-eng-'));
  bridge = await PermissionBridge.open();
  const f = fakeClaudeCli(fakeOpts);
  const owned = new OwnedEntries();
  const engine = new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge, accounts: testRegistry('/h'), baseEnv: { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'x' }, readFile: async () => Buffer.from(''), tmpRoot: tmp, owned, killGraceMs: 50, ...over });
  return { f, engine, owned };
}
const drain = async (it: AsyncIterable<EngineEvent>) => { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; };

describe('ClaudeEngine over the claude CLI', () => {
  it('spawns claude -p with stream-json, the prompt tool, 0600 files in a 0700 dir; the token never in argv/env', async () => {
    const { f, engine } = await setup();
    f.push(cli.init('s1'), cli.delta('a'), cli.result('a', 's1'));
    const evs = await drain(engine.runTurn(req()));
    const s = f.spawns[0]!;
    expect(s.bin).toBe('claude');
    expect(s.cwd).toBe('/w');
    expect(s.args.slice(0, 1)).toEqual(['-p']);
    expect(argValue(s.args, '--input-format')).toBe('stream-json');
    expect(argValue(s.args, '--permission-prompt-tool')).toBe('mcp__deck_bridge__permission');
    expect(s.args).not.toContain('--bare');
    expect(s.args).not.toContain('--strict-mcp-config');
    expect(argValue(s.args, '--session-id')).toMatch(/^[0-9a-f-]{36}$/);
    const settingsPath = argValue(s.args, '--settings')!;
    expect(path.dirname(settingsPath).startsWith(tmp)).toBe(true);
    expect(fs.existsSync(path.dirname(settingsPath))).toBe(false); // removed after the turn
    const token = (s.files.mcpConfig as { mcpServers: { deck_bridge: { env: { DECK_BRIDGE_TOKEN: string } } } }).mcpServers.deck_bridge.env.DECK_BRIDGE_TOKEN;
    expect(token.length).toBeGreaterThan(20);
    expect(s.args.join(' ')).not.toContain(token);
    expect(Object.values(s.env).join(' ')).not.toContain(token);
    expect(s.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(s.env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(s.env.MCP_TOOL_TIMEOUT).toBe(String(12 * 60 * 60_000));
    expect((s.files.settings as { hooks: Record<string, unknown> }).hooks.PreToolUse).toBeTruthy();
    expect(evs.find((e) => e.kind === 'result')).toMatchObject({ ok: true, sessionId: 's1' });
  });

  it('files are private while the child runs', async () => {
    const { f, engine } = await setup();
    let modes: number[] = [];
    const spawnFn: typeof f.spawnFn = (bin, args, o) => {
      const st = (p: string) => fs.statSync(p).mode & 0o777;
      const sp = argValue(args, '--settings')!;
      modes = [st(path.dirname(sp)), st(sp), st(argValue(args, '--mcp-config')!)];
      return f.spawnFn(bin, args, o);
    };
    const e2 = new ClaudeEngine({ bin: 'claude', spawnFn, bridge: bridge!, accounts: testRegistry('/h'), baseEnv: {}, readFile: async () => Buffer.from(''), tmpRoot: tmp });
    void engine;
    f.push(cli.init('s1'), cli.result('a', 's1'));
    await drain(e2.runTurn(req()));
    expect(modes).toEqual([0o700, 0o600, 0o600]);
  });

  it('resume passes --resume=<id> and no --session-id', async () => {
    const { f, engine } = await setup();
    f.push(cli.init('p1'), cli.result('a', 'p1'));
    await drain(engine.runTurn(req({ resumeSessionId: '11111111-2222-4333-8444-555555555555' })));
    expect(argValue(f.spawns[0]!.args, '--resume')).toBe('11111111-2222-4333-8444-555555555555');
    expect(argValue(f.spawns[0]!.args, '--session-id')).toBeUndefined();
  });

  it('missing or too old binary: one failed result, nothing spawned', async () => {
    const { f } = await setup();
    const missing = new ClaudeEngine({ bin: { ok: false, reason: 'missing' }, spawnFn: f.spawnFn, bridge: bridge!, accounts: testRegistry('/h') });
    expect((await drain(missing.runTurn(req()))).at(-1)).toMatchObject({ kind: 'result', ok: false, errorText: CLAUDE_MISSING_TEXT });
    const old = new ClaudeEngine({ bin: { ok: false, reason: 'too_old', bin: '/x/claude', version: '2.0.1' }, spawnFn: f.spawnFn, bridge: bridge!, accounts: testRegistry('/h') });
    expect((await drain(old.runTurn(req()))).at(-1)).toMatchObject({ ok: false, errorText: claudeTooOldText('2.0.1') });
    expect(f.state.calls).toBe(0);
  });

  it('a resume id that is not a session id: one failed result, nothing spawned, nothing registered (no rejected iterator)', async () => {
    const { f, engine } = await setup();
    const evs = await drain(engine.runTurn(req({ resumeSessionId: 'not-a-uuid' })));
    expect(evs).toEqual([expect.objectContaining({ kind: 'result', ok: false, errorText: invalidResumeText('not-a-uuid') })]);
    expect(f.state.calls).toBe(0);
    expect(bridge!.registrations).toBe(0);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('close() closes the bridge the engine opened itself (server shutdown); a bridge passed in stays open', async () => {
    const { f } = await setup();
    const own = new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, accounts: testRegistry('/h'), baseEnv: { PATH: '/bin' }, readFile: async () => Buffer.from(''), tmpRoot: tmp, owned: new OwnedEntries(), killGraceMs: 50 });
    await own.close(); // never opened: no-op
    f.push(cli.init('s1'), cli.result('a', 's1'));
    await drain(own.runTurn(req()));
    const sock = (f.spawns[0]!.files.mcpConfig as { mcpServers: { deck_bridge: { env: { DECK_BRIDGE_SOCK: string } } } }).mcpServers.deck_bridge.env.DECK_BRIDGE_SOCK;
    expect(sock).not.toBe(bridge!.socketPath);
    expect(fs.existsSync(sock)).toBe(true);
    await own.close();
    expect(fs.existsSync(sock)).toBe(false);
    expect(fs.existsSync(path.dirname(sock))).toBe(false);

    const shared = new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge: bridge!, accounts: testRegistry('/h') });
    await shared.close();
    expect(fs.existsSync(bridge!.socketPath)).toBe(true);
  });

  it('abort: SIGINT, the CLI\'s interrupted result is reported as 중단됨 / aborted, the child is stopped', async () => {
    const ac = new AbortController();
    const { f, engine } = await setup({}, { onSignal: (_sig, ctl) => ctl.push({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1', errors: ['interrupted'] }) });
    f.push(cli.init('s1'), cli.delta('par'));
    const evs: EngineEvent[] = [];
    for await (const e of engine.runTurn(req({ signal: ac.signal }))) { evs.push(e); if (e.kind === 'delta') ac.abort(); }
    expect(f.state.signals[0]).toBe('SIGINT');
    expect(evs.filter((e) => e.kind === 'result')).toEqual([expect.objectContaining({ ok: false, errorText: '중단됨', terminalReason: 'aborted' })]);
    expect(f.state.inputClosed).toBe(true);
  });

  it('abort before the turn starts: nothing is spawned, no bridge registration is left, one 중단됨 / aborted result', async () => {
    const ac = new AbortController();
    ac.abort();
    const { f, engine } = await setup();
    const evs = await drain(engine.runTurn(req({ signal: ac.signal })));
    expect(f.state.calls).toBe(0);
    expect(f.spawns).toHaveLength(0);
    expect(bridge!.registrations).toBe(0);
    expect(fs.readdirSync(tmp)).toEqual([]); // no per-process dir was created
    expect(evs).toEqual([expect.objectContaining({ kind: 'result', ok: false, errorText: '중단됨', terminalReason: 'aborted' })]);
  });

  it('exit without a result: the exit becomes the failure text, with the stderr tail', async () => {
    const { f, engine } = await setup();
    const it = engine.runTurn(req())[Symbol.asyncIterator]();
    f.push(cli.init('s1'));
    expect((await it.next()).value).toMatchObject({ kind: 'init' });
    f.stderr('boom\n'); // the fake only has a stderr once the child exists
    f.end(1);
    const rest: EngineEvent[] = [];
    for (let x = await it.next(); !x.done; x = await it.next()) rest.push(x.value);
    const r = rest.at(-1)!;
    expect(r).toMatchObject({ kind: 'result', ok: false, errorText: expect.stringContaining('종료 코드 1'), stderr: expect.stringContaining('boom') });
  });

  it('a permission request from the prompt tool reaches onPermission; the answer goes back', async () => {
    const seen: string[] = [];
    const { f, engine } = await setup();
    const it = engine.runTurn(req({ onPermission: async (p) => { seen.push(p.toolName); return 'once'; } }))[Symbol.asyncIterator]();
    f.push(cli.init('s1'));
    expect((await it.next()).value).toMatchObject({ kind: 'init' });
    const reply = await f.ask({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' });
    expect(seen).toEqual(['Bash']);
    expect(reply).toMatchObject({ behavior: 'allow', updatedInput: { command: 'ls' } });
    f.push(cli.result('ok', 's1'));
    for (let r = await it.next(); !r.done; r = await it.next()) { /* drain */ }
  });

  it('보안 #4: a commanderHop turn registers fail-closed and writes one fail-closed .* hook; other turns register as before', async () => {
    const { f, engine } = await setup();
    const spy = vi.spyOn(bridge!, 'register');
    f.push(cli.init('s1'), cli.result('a', 's1'));
    await drain(engine.runTurn(req({ commanderHop: 2 })));
    expect(spy.mock.calls[0]![1]).toEqual({ failClosed: true });
    const hooks = (f.spawns[0]!.files.settings as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } }).hooks.PreToolUse;
    expect(hooks.map((h) => h.matcher)).toEqual(['.*']);
    expect(hooks[0]!.hooks[0]!.command).toContain("'--fail' 'closed'");
    f.push(cli.init('s2'), cli.result('a', 's2'));
    await drain(engine.runTurn(req()));
    expect(spy.mock.calls[1]![1]).toEqual({ failClosed: false });
  });

  it('setPermissionMode mid-process: the PreToolUse gate refuses edits after a switch to plan; stopTask is not offered', async () => {
    let live: LiveInput | null = null;
    const { f, engine } = await setup();
    const it = engine.runTurn(req({ onLive: (l) => { live = l; } }))[Symbol.asyncIterator]();
    f.push(cli.init('s1'));
    await it.next();
    expect(live!.stopTask).toBeUndefined();
    expect(await live!.setPermissionMode!('plan')).toBe(true);
    const out = await f.hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {}, tool_use_id: 'w1' });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_GATE_MESSAGE } });
    f.push(cli.result('ok', 's1'));
    for (let r = await it.next(); !r.done; r = await it.next()) { /* drain */ }
  });

  it('records what the child wrote as deck\'s own (prompt uuid, assistant uuid and message id)', async () => {
    const { f, engine, owned } = await setup();
    f.push(cli.init('s1'), { type: 'assistant', parent_tool_use_id: null, uuid: 'as-1', message: { id: 'msg_9', content: [] }, session_id: 's1' }, cli.result('a', 's1'));
    await drain(engine.runTurn(req()));
    expect(owned.has(String(f.inputs[0]!.uuid), null)).toBe(true);
    expect(owned.has('as-1', null)).toBe(true);
    expect(owned.has('other', 'msg_9')).toBe(true);
  });

  it('forkAt: resumes a truncated copy with --fork-session; a missing parent transcript fails without spawning', async () => {
    const { f, engine } = await setup();
    const projects = path.join(tmp, 'projects');
    const accounts = { ...testRegistry('/h'), projectsDir: () => projects };
    const cwd = path.join(tmp, 'w');
    fs.mkdirSync(cwd);
    const e2 = new ClaudeEngine({ bin: 'claude', spawnFn: f.spawnFn, bridge: bridge!, accounts, baseEnv: {}, readFile: async () => Buffer.from(''), tmpRoot: tmp });
    void engine;
    expect((await drain(e2.runTurn(req({ cwd, resumeSessionId: 'parent', forkAt: 'a1' })))).at(-1)).toMatchObject({ ok: false, errorText: FORK_SOURCE_MISSING, sessionId: null });
    expect(f.state.calls).toBe(0);
    const dir = path.join(projects, fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'parent.jsonl'), [{ uuid: 'u1', parentUuid: null }, { uuid: 'a1', parentUuid: 'u1' }, { uuid: 'u2', parentUuid: 'a1' }].map((r) => JSON.stringify(r)).join('\n'));
    f.push(cli.init('child'), cli.result('ok', 'child'));
    const evs = await drain(e2.runTurn(req({ cwd, resumeSessionId: 'parent', forkAt: 'a1' })));
    const args = f.spawns[0]!.args;
    expect(argValue(args, '--resume')).toMatch(/parent\.jsonl$/);
    expect(args).toContain('--fork-session');
    expect(evs.find((e) => e.kind === 'result')).toMatchObject({ ok: true, sessionId: 'child' });
  });
});

describe('ClaudeEngine — ⚡ 빠르게 (fast mode)', () => {
  it('fast: --model is Opus whatever was routed, fastMode merged into the one --settings file (hooks kept)', async () => {
    const { f, engine } = await setup();
    f.push(cli.init('s1'), cli.result('a', 's1'));
    await drain(engine.runTurn(req({ model: 'fable', fast: true, allowRules: ['Bash(npm test:*)'] })));
    const s = f.spawns[0]!;
    expect(argValue(s.args, '--model')).toBe('claude-opus-5-5');
    expect(s.args.filter((a) => a === '--settings' || a.startsWith('--settings=')).length).toBe(1);
    const settings = s.files.settings as { fastMode?: boolean; hooks: Record<string, unknown>; permissions: unknown };
    expect(settings.fastMode).toBe(true);
    expect(settings.hooks.PreToolUse).toBeTruthy();
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test:*)'] });
  });

  it('no fast: the arguments and settings are what they were', async () => {
    const a = await setup();
    a.f.push(cli.init('s1'), cli.result('a', 's1'));
    await drain(a.engine.runTurn(req({ model: 'fable' })));
    const s = a.f.spawns[0]!;
    expect(argValue(s.args, '--model')).toBe('claude-fable-5-1');
    expect((s.files.settings as { fastMode?: boolean }).fastMode).toBeUndefined();
    expect(JSON.stringify(s.files.settings)).not.toContain('fastMode');
  });

  it('a fast turn refused for usage credits gets deck’s explanation as a notice before the failed result', async () => {
    const { f, engine } = await setup();
    f.push(cli.init('s1'), { type: 'result', subtype: 'success', is_error: true, result: 'Fast mode requires usage credits', session_id: 's1', usage: { input_tokens: 0, output_tokens: 0 } });
    const evs = await drain(engine.runTurn(req({ fast: true })));
    const i = evs.findIndex((e) => e.kind === 'notice' && e.message.startsWith('⚡') && e.message.includes('사용 크레딧'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(evs[i]).toMatchObject({ fast: 'off' });
    // Nothing is retried by itself: the words never promise one.
    expect((evs[i] as { message: string }).message).not.toContain('다시 시도');
    expect(evs.findIndex((e) => e.kind === 'result')).toBeGreaterThan(i);
  });

  it('the same failure without fast adds no notice', async () => {
    const { f, engine } = await setup();
    f.push(cli.init('s1'), { type: 'result', subtype: 'success', is_error: true, result: 'Fast mode requires usage credits', session_id: 's1', usage: { input_tokens: 0, output_tokens: 0 } });
    const evs = await drain(engine.runTurn(req()));
    expect(evs.some((e) => e.kind === 'notice')).toBe(false);
  });

  it('a CLI system/notification reaches the turn as a notice (fast ones with deck’s words)', async () => {
    const { f, engine } = await setup();
    f.push(cli.init('s1'), { type: 'system', subtype: 'notification', key: 'fast', text: 'Fast mode disabled · usage credits exhausted', priority: 'high', session_id: 's1' }, cli.result('a', 's1'));
    const evs = await drain(engine.runTurn(req({ fast: true })));
    const n = evs.find((e) => e.kind === 'notice');
    expect(n).toMatchObject({ kind: 'notice', fast: 'exhausted' });
    expect((n as { message: string }).message).toContain('usage credits exhausted');
    expect((n as { message: string }).message).toContain('표준 속도로 돕니다');
    expect((n as { message: string }).message).not.toContain('다시 시도');
  });
});
