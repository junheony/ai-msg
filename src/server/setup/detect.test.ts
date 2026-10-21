import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeBin } from '../engine/claudeCli/version';
import { defaultExec, parseClaudeAuth, parseCodexLogin, parseGrokModels, probeEngines, type ProbeExec, type ProbeResult } from './detect';

const HOME = '/h';
const ok = (stdout = '', code: number | null = 0): ProbeResult => ({ code, stdout, timedOut: false });
const claudeOk: ClaudeBin = { ok: true, bin: '/bin/claude', version: '2.1.283', belowRecommended: false };
const cfg = { claudeBin: claudeOk, codexBin: '/bin/codex', geminiBin: '/bin/agy', grokBin: '/h/.grok/bin/grok', grokHome: '/real/.grok', home: HOME };
const profiles = [
  { id: 'a', label: 'A', dir: '/h/.claude', home: true, active: true, env: { PATH: '/bin' } },
  { id: 'b', label: 'B', dir: '/h/.claude-b', home: false, active: true, env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-b' } },
];

type Call = { bin: string; args: string[]; env: NodeJS.ProcessEnv };
/** Answers keyed by `<basename> <args>`; anything else → exit 1, no output. Records every call. */
function fakeExec(answers: Record<string, ProbeResult | ((c: Call) => ProbeResult)> = {}) {
  const calls: Call[] = [];
  const exec: ProbeExec = async (bin, args, env) => {
    const c = { bin, args, env };
    calls.push(c);
    const a = answers[`${path.basename(bin)} ${args.join(' ')}`];
    return typeof a === 'function' ? a(c) : a ?? ok('', 1);
  };
  return { exec, calls };
}

describe('status parsers', () => {
  it('claude: loggedIn only', () => {
    expect(parseClaudeAuth('{"loggedIn":false,"authMethod":"none"}')).toBe('no');
    expect(parseClaudeAuth('{"loggedIn":true,"email":"someone@example.com","orgName":"X"}')).toBe('yes');
    expect(parseClaudeAuth('{"loggedIn":"yes"}')).toBe('unknown');
    expect(parseClaudeAuth('not json')).toBe('unknown');
  });
  it('codex: exit 0 / Not logged in', () => {
    expect(parseCodexLogin(1, 'Not logged in\n')).toBe('no');
    expect(parseCodexLogin(0, 'Logged in using ChatGPT\n')).toBe('yes');
    expect(parseCodexLogin(1, 'boom')).toBe('unknown');
  });
  it('grok: first non-empty line', () => {
    expect(parseGrokModels('You are logged in as …\nmodels:')).toBe('yes');
    expect(parseGrokModels('\n  You are not authenticated. Run grok login')).toBe('no');
    expect(parseGrokModels('models:\nYou are logged in')).toBe('unknown');
  });
});

describe('probeEngines', () => {
  it('reports each engine and profile from the status commands', async () => {
    const { exec } = fakeExec({
      'claude auth status --json': (c) => (c.env.CLAUDE_CONFIG_DIR ? ok('{"loggedIn":true}') : ok('{"loggedIn":false}', 1)),
      'codex --version': ok('codex-cli 0.159.2\n'),
      'codex login status': ok('Not logged in\n', 1),
      'agy --version': ok('1.2.3\n'),
      'agy models': ok('gemini-pro\n'),
      'grok --version': ok('grok 1.0.62\n'),
      'grok models': ok('You are not authenticated\n'),
    });
    const r = await probeEngines({ cfg, profiles, env: {}, exec });
    const by = Object.fromEntries(r.engines.map((e) => [e.engine, e]));
    expect(r.engines.map((e) => e.engine)).toEqual(['claude', 'codex', 'gemini', 'grok']);
    expect(by.claude).toMatchObject({ bin: '/bin/claude', version: '2.1.283', login: 'yes' });
    expect(by.codex).toMatchObject({ version: 'codex-cli 0.159.2', login: 'no', loginCommand: 'codex login' });
    expect(by.gemini).toMatchObject({ version: '1.2.3', login: 'yes', loginCommand: 'agy' });
    expect(by.grok).toMatchObject({ bin: '/h/.grok/bin/grok', version: 'grok 1.0.62', login: 'no', loginCommand: 'grok login' });
    expect(r.claudeProfiles).toEqual([
      { id: 'a', label: 'A', dir: '~/.claude', home: true, active: true, login: 'no', loginCommand: 'claude auth login' },
      { id: 'b', label: 'B', dir: '~/.claude-b', home: false, active: true, login: 'yes', loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-b claude auth login' },
    ]);
  });

  it('never carries account identity into the result', async () => {
    const { exec } = fakeExec({ 'claude auth status --json': ok('{"loggedIn":true,"email":"someone@example.com","orgId":"org-1"}') });
    const r = await probeEngines({ cfg, profiles, env: {}, exec });
    expect(JSON.stringify(r)).not.toMatch(/example\.com|org-1/);
  });

  it('runs claude per profile with that profile env (CLAUDE_CONFIG_DIR)', async () => {
    const { exec, calls } = fakeExec();
    await probeEngines({ cfg, profiles, env: {}, exec });
    const claude = calls.filter((c) => c.bin === '/bin/claude');
    expect(claude.map((c) => c.args)).toEqual([['auth', 'status', '--json'], ['auth', 'status', '--json']]);
    expect(claude.map((c) => c.env.CLAUDE_CONFIG_DIR)).toEqual([undefined, '/h/.claude-b']);
  });

  it('grok is probed with grokEnv: GROK_HOME is cfg.grokHome, not the shell value', async () => {
    const { exec, calls } = fakeExec();
    await probeEngines({ cfg, profiles, env: { GROK_HOME: '/elsewhere', PATH: '/bin' }, exec });
    const models = calls.find((c) => c.bin === cfg.grokBin && c.args[0] === 'models');
    expect(models?.args).toEqual(['models']);
    expect(models?.env.GROK_HOME).toBe('/real/.grok');
  });

  it('probe envs carry no supervisor markers', async () => {
    const marks = { XPC_SERVICE_NAME: 'x', INVOCATION_ID: 'i', JOURNAL_STREAM: 'j', DECK_SUPERVISOR: 'launchd', DECK_SUPERVISED: '1' };
    const { exec, calls } = fakeExec();
    await probeEngines({ cfg, profiles: profiles.map((p) => ({ ...p, env: { ...p.env, ...marks } })), env: { PATH: '/bin', ...marks }, exec });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) for (const k of Object.keys(marks)) expect(c.env[k], `${c.bin} ${k}`).toBeUndefined();
  });

  it('a hanging CLI is unknown, not a crash', async () => {
    const { exec } = fakeExec({ 'codex login status': { code: null, stdout: '', timedOut: true } });
    const r = await probeEngines({ cfg, profiles, env: {}, exec, timeoutMs: 15_000 });
    const codex = r.engines.find((e) => e.engine === 'codex')!;
    expect(codex.login).toBe('unknown');
    expect(codex.note).toMatch(/응답 없음\(15초\)/);
  });

  it('a spawn failure is unknown with its reason, not "logged out"', async () => {
    const { exec } = fakeExec({ 'agy models': { code: null, stdout: '', timedOut: false, spawnError: 'EACCES' } });
    const r = await probeEngines({ cfg, profiles, env: {}, exec });
    const g = r.engines.find((e) => e.engine === 'gemini')!;
    expect(g.login).toBe('unknown');
    expect(g.note).toMatch(/실행하지 못했습니다\(EACCES\)/);
  });

  it('gemini: non-zero exit is logged out', async () => {
    const { exec } = fakeExec({ 'agy models': ok('', 1) });
    const r = await probeEngines({ cfg, profiles, env: {}, exec });
    expect(r.engines.find((e) => e.engine === 'gemini')!.login).toBe('no');
  });

  it('missing binaries are reported with the hint, never probed', async () => {
    const { exec, calls } = fakeExec();
    const r = await probeEngines({ cfg: { ...cfg, claudeBin: { ok: false, reason: 'missing' }, codexBin: null, geminiBin: null, grokBin: null }, profiles, env: {}, exec });
    expect(calls).toHaveLength(0);
    for (const e of r.engines) {
      expect(e.bin).toBeNull();
      expect(e.login).toBe('unknown');
      expect(e.note).toMatch(/찾지 못했습니다/);
    }
    expect(r.engines.find((e) => e.engine === 'grok')!.note).toMatch(/\.grok\/bin\/grok/);
    expect(r.claudeProfiles.every((p) => p.login === 'unknown')).toBe(true);
  });

  it('a too-old claude names the minimum version and is not probed', async () => {
    const { exec, calls } = fakeExec();
    const r = await probeEngines({ cfg: { ...cfg, claudeBin: { ok: false, reason: 'too_old', bin: '/bin/claude', version: '2.0.1' } }, profiles, env: {}, exec });
    expect(calls.some((c) => c.bin === '/bin/claude')).toBe(false);
    const c = r.engines.find((e) => e.engine === 'claude')!;
    expect(c).toMatchObject({ bin: '/bin/claude', version: '2.0.1', login: 'unknown' });
    expect(c.note).toMatch(/2\.1\.259/);
  });
});

describe('defaultExec', () => {
  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('caps output, kills the group on timeout and waits for exit', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-'));
    const pids = path.join(dir, 'pids');
    const script = path.join(dir, 'hang.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho $$ > "${pids}"\nsleep 60 &\necho $! >> "${pids}"\nhead -c 1048576 /dev/zero | tr '\\0' a\nwait\n`, { mode: 0o755 });
    const r = await defaultExec(script, [], { PATH: '/usr/bin:/bin' }, 1500);
    expect(r.timedOut).toBe(true);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout.length).toBeLessThanOrEqual(64 * 1024);
    const ids = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(alive(id), `pid ${id}`).toBe(false);
  }, 10_000);

  it('a missing binary is a spawn error, not a crash', async () => {
    const r = await defaultExec('/nonexistent/deck-no-such-cli', ['--version'], {}, 1000);
    expect(r).toMatchObject({ code: null, timedOut: false, spawnError: 'ENOENT' });
  });

  it('returns exit code and stdout', async () => {
    const r = await defaultExec('/bin/sh', ['-c', 'echo hi; echo err >&2; exit 3'], { PATH: '/usr/bin:/bin' }, 5000);
    expect(r).toEqual({ code: 3, stdout: 'hi\n', timedOut: false });
  });
});
