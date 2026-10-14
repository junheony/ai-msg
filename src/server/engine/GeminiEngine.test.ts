import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { geminiEnv } from '../../shared/accounts';
import type { EngineEvent, EngineResult } from './Engine';
import { GeminiEngine, GeminiEventMapper, GeminiLogin, geminiArgs, resolveGeminiBin, type GeminiTurnRequest } from './GeminiEngine';

const CID = 'conv-4f1c2b9e-1111';

// The one line confirmed from a real agy 1.3.5 run (logged out).
const AUTH_FAIL_LINE = { event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } };

// init / step_update built from the documented field names (step_update details unconfirmed: docs/gemini-spike.md).
const OK_RUN = [
  { event: 'init', init: { cwd: '/w', tools: ['read_file'], permission_mode: 'plan', conversation_id: CID } },
  { event: 'step_update', step_update: { step_type: 'thinking', state: 'RUNNING', text_delta: 'hmm' } },
  { event: 'step_update', step_update: { step_type: 'text', state: 'RUNNING', text_delta: 'Hel' } },
  { event: 'step_update', step_update: { step_type: 'tool', state: 'RUNNING', tool_info: { id: 't1', name: 'read_file', input: { path: 'a.txt' } } } },
  { event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_info: { id: 't1', name: 'read_file', input: { path: 'a.txt' }, output: 'x' } } },
  { event: 'step_update', step_update: { step_type: 'tool', state: 'FAILED', tool_info: { tool_name: 'run_command', args: { cmd: 'ls' }, error: 'denied' } } },
  { event: 'step_update', step_update: { step_type: 'text', state: 'RUNNING', text_delta: 'lo' } },
  { event: 'result', result: { conversation_id: CID, status: 'SUCCESS', response: 'Hello', error: '', num_turns: 1, usage: { input_tokens: 100, output_tokens: 30, thinking_tokens: 5, cache_read_tokens: 40, total_tokens: 175 } } },
];

const mapAll = (evs: unknown[], resume: string | null = null) => {
  const m = new GeminiEventMapper('gemini-4-argon', resume);
  return evs.flatMap((e) => m.map(e));
};

describe('geminiArgs', () => {
  it('prompt as one -p= element, stream-json, slug model, effort, plan for read-only', () => {
    expect(geminiArgs({ resumeSessionId: null, model: 'gemini-pro', effort: 'high', sandbox: 'read-only', prompt: '--model x' })).toEqual([
      '-p=--model x', '--output-format', 'stream-json', '--model', 'gemini-4-argon', '--effort', 'high', '--mode', 'plan', '--disable-slash-commands', '--print-timeout', '0',
    ]);
  });
  it('workspace-write → accept-edits + --sandbox; resume adds --conversation <id>; never skips permissions', () => {
    const a = geminiArgs({ resumeSessionId: CID, model: 'gemini-flash', effort: 'low', sandbox: 'workspace-write', prompt: 'hi' });
    expect(a).toEqual(['-p=hi', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash', '--effort', 'low', '--mode', 'accept-edits', '--sandbox', '--disable-slash-commands', '--print-timeout', '0', '--conversation', CID]);
    expect(a).not.toContain('--dangerously-skip-permissions');
  });
});

describe('GeminiEventMapper', () => {
  it('init, text deltas, thinking apart, tool calls/results once per id, result with usage', () => {
    const ev = mapAll(OK_RUN);
    expect(ev[0]).toEqual({ kind: 'init', sessionId: CID, model: 'gemini-4-argon' });
    expect(ev.filter((e) => e.kind === 'thinking')).toEqual([{ kind: 'thinking', text: 'hmm' }]);
    expect(ev.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text)).toEqual(['Hel', 'lo']);
    expect(ev.filter((e) => e.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', toolUseId: 't1', name: 'read_file', input: { path: 'a.txt' } },
      { kind: 'tool_call', toolUseId: 'step-5', name: 'run_command', input: { cmd: 'ls' } },
    ]);
    expect(ev.filter((e) => e.kind === 'tool_result')).toEqual([
      { kind: 'tool_result', toolUseId: 't1', content: 'x', isError: false },
      { kind: 'tool_result', toolUseId: 'step-5', content: 'denied', isError: true },
    ]);
    expect(ev.filter((e) => e.kind === 'init')).toHaveLength(1);
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: true, sessionId: CID, text: 'Hello', errorText: null, usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 40, cacheCreationTokens: 0 } });
  });
  it('the real logged-out result line: failed, error text kept, empty conversation id ignored (resume id stays)', () => {
    expect(mapAll([AUTH_FAIL_LINE], CID)).toEqual([expect.objectContaining({ kind: 'result', ok: false, text: '', sessionId: CID, errorText: 'authentication failed or timed out' })]);
    expect(mapAll([{ event: 'result', result: { status: 'CANCELED' } }]).at(-1)).toMatchObject({ ok: false, errorText: 'agy 실패' });
  });
  it('result alone: response is the text; its conversation id becomes an init first; flat payloads accepted', () => {
    const ev = mapAll([{ event: 'result', status: 'SUCCESS', conversation_id: 'c2', response: 'done', usage: {} }]);
    expect(ev).toEqual([{ kind: 'init', sessionId: 'c2', model: 'gemini-4-argon' }, expect.objectContaining({ kind: 'result', ok: true, text: 'done', sessionId: 'c2' })]);
  });
  it('ignores junk and unknown events', () => {
    expect(mapAll([null, 'x', { type: 'init' }, { event: 'init', init: {} }, { event: 'step_update', step_update: { text_delta: '' } }, { event: 'later_event' }])).toEqual([]);
  });
});

describe('geminiEnv', () => {
  it('strips API keys, ADC/Vertex/base-URL and gemini-cli leftovers; sets nothing of its own', () => {
    const base = {
      PATH: '/bin', HOME: '/h', GEMINI_API_KEY: 'k1', GOOGLE_API_KEY: 'k2', GOOGLE_APPLICATION_CREDENTIALS: '/adc.json', GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_GEMINI_BASE_URL: 'http://evil', GEMINI_CLI_HOME: '/other', SEATBELT_PROFILE: 'permissive-open-yolo', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_SANDBOX: 'docker',
    };
    expect(geminiEnv(base)).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('resolveGeminiBin', () => {
  it('DECK_GEMINI_BIN wins when executable; else PATH agy, then ~/.local/bin/agy; null when none; gemini is not looked for', () => {
    expect(resolveGeminiBin({ DECK_GEMINI_BIN: '/x/agy', PATH: '/p' }, '/h', (p) => p === '/x/agy')).toBe('/x/agy');
    expect(resolveGeminiBin({ DECK_GEMINI_BIN: '/x/agy', PATH: '/p' }, '/h', (p) => p === '/p/agy')).toBeNull();
    expect(resolveGeminiBin({ PATH: '/a:/p' }, '/h', (p) => p === '/p/agy')).toBe('/p/agy');
    expect(resolveGeminiBin({ PATH: '/a' }, '/h', (p) => p === '/h/.local/bin/agy')).toBe('/h/.local/bin/agy');
    expect(resolveGeminiBin({ PATH: '/p' }, '/h', (p) => p === '/p/gemini')).toBeNull();
  });
});

/**
 * A fake `agy` binary (node script): records argv, cwd, stdin and env to `$FAKE_LOG`, then replays `$FAKE_SCRIPT`
 * (a JSON file: { lines, exitCode, hang, stderr, delayMs }).
 */
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const script = JSON.parse(fs.readFileSync(process.env.FAKE_SCRIPT, 'utf8'));
  const log = process.env.FAKE_LOG;
  const prev = fs.existsSync(log + '.count') ? Number(fs.readFileSync(log + '.count', 'utf8')) : 0;
  fs.writeFileSync(log + '.count', String(prev + 1));
  fs.writeFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, env: process.env }));
  setTimeout(() => {
    for (const l of script.lines) process.stdout.write(JSON.stringify(l) + '\\n');
    // stderr after the result line: the engine must still attach it.
    if (script.stderr) process.stderr.write(script.stderr);
    if (script.hang) setInterval(() => {}, 1000); else process.exitCode = script.exitCode || 0;
  }, script.delayMs || 0);
});
`;

describe('GeminiEngine / GeminiLogin with a fake agy binary', () => {
  let dir: string;
  let bin: string;
  const req = (over: Partial<GeminiTurnRequest> = {}): GeminiTurnRequest => ({ account: 'g1', cwd: dir, resumeSessionId: null, model: 'gemini-pro', effort: 'medium', sandbox: 'read-only', prompt: '안녕\n--model evil', signal: new AbortController().signal, ...over });
  const script = (s: { lines: unknown[]; exitCode?: number; hang?: boolean; stderr?: string; delayMs?: number }) => fs.writeFile(path.join(dir, 'script.json'), JSON.stringify(s));
  const env = (extra: NodeJS.ProcessEnv = {}) => ({ PATH: process.env.PATH, FAKE_SCRIPT: path.join(dir, 'script.json'), FAKE_LOG: path.join(dir, 'log.json'), ...extra });
  const engine = (extra: NodeJS.ProcessEnv = {}) => new GeminiEngine(bin, { baseEnv: env(extra) });
  const collect = async (it: AsyncIterable<EngineEvent>) => { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; };
  const log = async () => JSON.parse(await fs.readFile(path.join(dir, 'log.json'), 'utf8')) as { argv: string[]; cwd: string; stdin: string; env: Record<string, string> };

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-agy-')));
    bin = path.join(dir, 'agy');
    await fs.writeFile(bin, FAKE, { mode: 0o755 });
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('streams a turn: prompt only in the -p= element, stdin empty, API keys gone, no skip-permissions', async () => {
    await script({ lines: OK_RUN });
    const ev = await collect(engine({ GEMINI_API_KEY: 'secret', GOOGLE_API_KEY: 'secret2' }).runTurn(req()));
    expect(ev[0]).toMatchObject({ kind: 'init', sessionId: CID });
    expect(ev.at(-1)).toMatchObject({ kind: 'result', ok: true, text: 'Hello' });
    const l = await log();
    expect(l.stdin).toBe('');
    expect(l.argv[0]).toBe('-p=안녕\n--model evil');
    expect(l.argv.slice(1)).toEqual(['--output-format', 'stream-json', '--model', 'gemini-4-argon', '--effort', 'medium', '--mode', 'plan', '--disable-slash-commands', '--print-timeout', '0']);
    expect(l.argv).not.toContain('--dangerously-skip-permissions');
    expect(l.cwd).toBe(dir);
    expect(l.env.GEMINI_API_KEY).toBeUndefined();
    expect(l.env.GOOGLE_API_KEY).toBeUndefined();
    expect(l.env.GEMINI_CLI_HOME).toBeUndefined();
  });

  it('resume passes --conversation <id>', async () => {
    await script({ lines: OK_RUN });
    await collect(engine().runTurn(req({ resumeSessionId: CID, sandbox: 'workspace-write' })));
    expect((await log()).argv.slice(-7)).toEqual(['accept-edits', '--sandbox', '--disable-slash-commands', '--print-timeout', '0', '--conversation', CID]);
  });

  it('a flag-shaped resume id never reaches the binary', async () => {
    await fs.rm(path.join(dir, 'log.json'), { force: true });
    const ev = await collect(engine().runTurn(req({ resumeSessionId: '--dangerously-skip-permissions' })));
    expect(ev).toEqual([expect.objectContaining({ kind: 'result', ok: false, errorText: '잘못된 세션 ID 형식' })]);
    await expect(fs.access(path.join(dir, 'log.json'))).rejects.toThrow();
  });

  it('logged out: the auth stderr (even after the result line) turns the error into the login hint', async () => {
    await script({ lines: [AUTH_FAIL_LINE], exitCode: 1, stderr: "authentication required. Run 'agy' to log in\n" });
    const r = (await collect(engine().runTurn(req()))).at(-1) as EngineResult;
    expect(r).toMatchObject({ ok: false, errorText: 'Gemini 로그인 필요 — 터미널에서 agy 실행 후 Google 로그인', stderr: expect.stringContaining('authentication required') });
  });

  it('error result keeps the CLI message and stderr; exit without result → exit code', async () => {
    await script({ lines: [{ event: 'result', result: { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota' } }], exitCode: 1, stderr: 'quota!' });
    expect((await collect(engine().runTurn(req()))).at(-1)).toMatchObject({ ok: false, errorText: 'RESOURCE_EXHAUSTED: quota', stderr: 'quota!' });
    await script({ lines: [], exitCode: 41 });
    expect((await collect(engine().runTurn(req()))).at(-1)).toMatchObject({ ok: false, errorText: 'agy 종료 코드 41' });
  });

  it('abort kills a hanging child and reports 중단됨', async () => {
    await script({ lines: [OK_RUN[0]], hang: true });
    const ac = new AbortController();
    const out: EngineEvent[] = [];
    for await (const e of engine().runTurn(req({ signal: ac.signal }))) { out.push(e); if (e.kind === 'init') ac.abort(); }
    expect(out.at(-1)).toMatchObject({ kind: 'result', ok: false, errorText: '중단됨', terminalReason: 'aborted' });
  });

  it('a missing binary is a failed result, not a crash', async () => {
    const e = new GeminiEngine(path.join(dir, 'nope'), { baseEnv: {} });
    expect((await collect(e.runTurn(req()))).at(-1)).toMatchObject({ ok: false, errorText: expect.stringContaining('agy 실행 실패') });
  });

  describe('GeminiLogin', () => {
    const count = async () => Number(await fs.readFile(path.join(dir, 'log.json.count'), 'utf8').catch(() => '0'));
    const reset = () => fs.rm(path.join(dir, 'log.json.count'), { force: true });

    it('exit 0 → logged in (g1 only); runs `agy models` in the tmp dir without API keys', async () => {
      await script({ lines: [], exitCode: 0 });
      const login = new GeminiLogin(bin, { baseEnv: env({ GEMINI_API_KEY: 'k' }) });
      expect(login.get('g1')).toBe(false);
      expect(await login.refresh()).toBe(true);
      expect(login.get('g1')).toBe(true);
      expect(login.get('g2')).toBe(false);
      const l = await log();
      expect(l.argv).toEqual(['models']);
      expect(l.cwd).toBe(await fs.realpath(os.tmpdir()));
      expect(l.env.GEMINI_API_KEY).toBeUndefined();
    });

    it('non-zero exit, timeout or a missing binary → false', async () => {
      await script({ lines: [], exitCode: 1 });
      expect(await new GeminiLogin(bin, { baseEnv: env() }).refresh()).toBe(false);
      await script({ lines: [], hang: true });
      expect(await new GeminiLogin(bin, { baseEnv: env(), timeoutMs: 200 }).refresh()).toBe(false);
      expect(await new GeminiLogin(path.join(dir, 'nope'), { baseEnv: env() }).refresh()).toBe(false);
    });

    it('concurrent refreshes share one probe; ensureFresh probes only when the cache is older than the ttl', async () => {
      await script({ lines: [], exitCode: 0, delayMs: 100 });
      await reset();
      let t = 1000;
      const login = new GeminiLogin(bin, { baseEnv: env(), ttlMs: 500, now: () => t });
      const [a, b] = await Promise.all([login.refresh(), login.refresh()]);
      expect([a, b]).toEqual([true, true]);
      expect(await count()).toBe(1);
      login.ensureFresh();
      t += 499;
      login.ensureFresh();
      expect(await count()).toBe(1);
      t += 1;
      login.ensureFresh();
      await login.refresh(); // joins the background probe
      expect(await count()).toBe(2);
    });
  });
});
