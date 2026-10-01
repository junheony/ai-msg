import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import { AttachmentStore } from '../attachments/AttachmentStore';
import type { ServerMessage } from '../../shared/protocol';
import { StubEngine, failResult, okResult } from '../engine/StubEngine';
import type { CodexEngine, CodexTurnRequest } from '../engine/CodexEngine';
import type { EngineEvent } from '../engine/Engine';
import { readCooldownUntilMs } from '../routing/cooldown';
import { SessionIndex } from '../sessions/SessionIndex';
import { projectSlug } from '../sessions/slug';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore, type ClaudeSessionState } from './SessionState';
import { TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const SID = '11111111-1111-4111-8111-111111111111';

function card(id: string, s: number, w: number, f: number, resetH: number) {
  const resetsAt = new Date(NOW + resetH * 3_600_000).toISOString();
  return { id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [
    { label: 'Session (5h)', used: s, resetsAt }, { label: 'Weekly (7d)', used: w, resetsAt }, { label: 'Fable (7d)', used: f, resetsAt } ] };
}

async function usageWith(a: [number, number, number], b: [number, number, number], c: [number, number, number]) {
  const state = { cards: [card('claude:main', ...a, 154), card('claude:second', ...b, 84), card('claude:third', ...c, 36)] };
  const u = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => state }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

type Ctx = { deps: TurnRunnerDeps; base: string; msgs: ServerMessage[]; sink: TurnSink; roots: Record<Account, string>; moves: unknown[] };

async function ctx(engine: StubEngine, over: Partial<TurnRunnerDeps> = {}, usage?: UsageService): Promise<Ctx> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-tr-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const index = new SessionIndex({ roots, pinnedFile: path.join(base, 'projects.json') });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const moves: unknown[] = [];
  const deps: TurnRunnerDeps = {
    engine,
    usage: usage ?? (await usageWith([13, 7, 0], [2, 3, 4], [0, 91, 27])),
    index,
    store,
    cooldownDir: path.join(base, 'cooldown'),
    protectedAccount: 'a',
    auditFile: path.join(base, 'audit.log'),
    projectsRoots: roots,
    codex: null,
    attachments: null,
    codexSessionsRoot: path.join(base, 'codex-sessions'),
    move: async (o) => { moves.push(o); return { ok: true, targetDir: path.join(o.targetProjectsRoot, path.basename(o.sourceProjectDir)), targetFile: '', copied: [] }; },
    now: () => NOW,
    maxRetries: 2,
    ...over,
  };
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { deps, base, msgs, sink, roots, moves };
}

async function seedSession(c: Ctx, account: Account, cwd = '/w/one') {
  const dir = path.join(c.roots[account], '-w-one');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'seed' } }) + '\n');
  await c.deps.index.refresh();
  return dir;
}

const ok = (sid: string, extra: EngineEvent[] = []): EngineEvent[] => [{ kind: 'init', sessionId: sid, model: 'claude-opus-5-5' }, { kind: 'delta', text: 'ok' }, ...extra, okResult(sid)];

describe('TurnRunner', () => {
  let msgsOf: (c: Ctx, t: ServerMessage['type']) => ServerMessage[];
  beforeEach(() => { msgsOf = (c, t) => c.msgs.filter((m) => m.type === t); });

  it('new session: routes to the best non-protected account, streams, stores state, applies usage', async () => {
    const eng = new StubEngine(() => ok('new1', [{ kind: 'rate_limit', info: { status: 'allowed', fiveHour: { usedPct: 9, resetsAt: null }, weekly: { usedPct: 4, resetsAt: null } } }]));
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(eng.calls[0]).toMatchObject({ account: 'b', resumeSessionId: null, model: 'opus', cwd: '/w/new', prompt: 'hi' });
    expect(msgsOf(c, 'turn_started')[0]).toMatchObject({ turnId: 't1', account: 'b', model: 'opus', attempt: 0 });
    expect(msgsOf(c, 'delta')).toEqual([{ type: 'delta', turnId: 't1', sessionId: 'new1', cwd: '/w/new', text: 'ok' }]);
    const res = msgsOf(c, 'turn_result')[0];
    expect(res).toMatchObject({ type: 'turn_result', ok: true, sessionId: 'new1', text: 'ok', badge: { account: 'b', model: 'opus', usage: { outputTokens: 4 } } });
    expect(c.deps.store.get('new1')).toMatchObject({ account: 'b', cwd: '/w/new', lastTurnAtMs: NOW, projectDir: path.join(c.roots.b, '-w-new') });
    expect(c.deps.usage.snapshot().accounts.b.fiveHour?.usedPct).toBe(9);
  });

  it('new session in a symlinked cwd: projectDir comes from the CLI-reported (real) cwd', async () => {
    let c!: Ctx;
    const eng = new StubEngine(async (req) => {
      const real = await fs.realpath(req.cwd); // what the CLI does before slugging
      const dir = path.join(c.roots[req.account], projectSlug(real));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'sym1.jsonl'), '{}\n');
      return [{ kind: 'init', sessionId: 'sym1', model: 'm', cwd: real }, okResult('sym1')];
    });
    c = await ctx(eng);
    const realParent = path.join(c.base, 'real');
    await fs.mkdir(path.join(realParent, 'proj'), { recursive: true });
    await fs.symlink(realParent, path.join(c.base, 'link'));
    const linked = path.join(c.base, 'link', 'proj');
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: linked, sessionId: null, text: 'hi' }, c.sink);
    const expected = path.join(c.roots.b, projectSlug(await fs.realpath(linked)));
    expect(projectSlug(linked)).not.toBe(projectSlug(await fs.realpath(linked)));
    expect((c.deps.store.get('sym1') as ClaudeSessionState | null)?.projectDir).toBe(expected);
  });

  it('new session: when the slugged dir has no jsonl, the account root is searched for it', async () => {
    let c!: Ctx;
    const eng = new StubEngine(async (req) => {
      // e.g. the CLI spelled 개발 in NFD while we hold NFC — simulate with an unrelated dir name
      const dir = path.join(c.roots[req.account], '-somewhere-else');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'far1.jsonl'), '{}\n');
      return [{ kind: 'init', sessionId: 'far1', model: 'm' }, okResult('far1')];
    });
    c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect((c.deps.store.get('far1') as ClaudeSessionState | null)?.projectDir).toBe(path.join(c.roots.b, '-somewhere-else'));
  });

  it('imported session on a (cold) moves to b, then resumes there', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await ctx(eng);
    const srcDir = await seedSession(c, 'a');
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(c.moves).toEqual([{ sessionId: SID, sourceProjectDir: srcDir, targetProjectsRoot: c.roots.b }]);
    expect(eng.calls[0]).toMatchObject({ account: 'b', resumeSessionId: SID });
    expect(c.deps.store.get(SID)).toMatchObject({ account: 'b', projectDir: path.join(c.roots.b, '-w-one') });
    expect(msgsOf(c, 'turn_started')[0]).toMatchObject({ reason: expect.stringContaining('캐시 식음') });
  });

  it('warm session stays; a failed move cancels the switch', async () => {
    const eng = new StubEngine(() => ok(SID));
    const c = await ctx(eng);
    const srcDir = await seedSession(c, 'a');
    await c.deps.store.set({ sessionId: SID, cwd: '/w/one', account: 'a', projectDir: srcDir, lastTurnAtMs: NOW - 60_000, justCompacted: false, defaultModel: 'opus' });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(c.moves).toEqual([]);
    expect(eng.calls[0]?.account).toBe('a');

    const eng2 = new StubEngine(() => ok(SID));
    const c2 = await ctx(eng2, { move: async () => ({ ok: false, error: 'disk full' }) });
    const src2 = await seedSession(c2, 'a');
    await c2.deps.store.set({ sessionId: SID, cwd: '/w/one', account: 'a', projectDir: src2, lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus' });
    await new TurnRunner(c2.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c2.sink);
    expect(eng2.calls[0]?.account).toBe('a');
    expect(msgsOf(c2, 'turn_notice')[0]).toMatchObject({ turnId: 't', message: expect.stringContaining('세션 이전 실패') });
    expect(msgsOf(c2, 'error')).toEqual([]);
    expect(msgsOf(c2, 'turn_result')[0]).toMatchObject({ ok: true, badge: { account: 'a' } });
  });

  it('an engine notice carrying a token-shaped string arrives redacted (review finding 1)', async () => {
    const eng = new StubEngine(() => ok('new2', [{ kind: 'notice', message: 'sk-ant-abc123def456ghi789jkl secret leaked' }]));
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    const notice = msgsOf(c, 'turn_notice')[0];
    expect(notice).toMatchObject({ type: 'turn_notice', turnId: 't' });
    expect((notice as { message: string }).message).not.toContain('sk-ant-abc123def456ghi789jkl');
    expect((notice as { message: string }).message).toContain('[redacted]');
  });

  it('limit on first account → cooldown, move, retry on next; auth failure likewise; third failure ends', async () => {
    const eng = new StubEngine((req, call) => {
      if (call === 0) return [{ kind: 'init', sessionId: 'n1', model: 'm' }, { kind: 'rate_limit', info: { status: 'rejected', fiveHour: null, weekly: null } }, failResult('limit', { sessionId: 'n1' })];
      if (call === 1) return [{ kind: 'init', sessionId: 'n1', model: 'm' }, failResult('Failed to authenticate. API Error: 401 OAuth access token has been revoked.', { sessionId: 'n1' })];
      return ok('n1');
    });
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(eng.calls.map((r) => r.account)).toEqual(['b', 'c', 'a']);
    expect(readCooldownUntilMs(c.deps.cooldownDir, 'b', NOW)).toBe(NOW + 3_600_000);
    expect(readCooldownUntilMs(c.deps.cooldownDir, 'c', NOW)).toBe(NOW + 6 * 3_600_000);
    expect(msgsOf(c, 'turn_retry')).toMatchObject([{ fromAccount: 'b', toAccount: 'c', attempt: 1 }, { fromAccount: 'c', toAccount: 'a', attempt: 2 }]);
    expect(c.moves.map((m) => (m as { targetProjectsRoot: string }).targetProjectsRoot)).toEqual([c.roots.c, c.roots.a]);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: true, badge: { account: 'a' } });

    const eng3 = new StubEngine(() => [failResult('usage limit reached')]);
    const c3 = await ctx(eng3);
    await new TurnRunner(c3.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c3.sink);
    expect(eng3.calls).toHaveLength(3);
    expect(msgsOf(c3, 'turn_result')[0]).toMatchObject({ ok: false, errorText: expect.stringContaining('usage limit') });
  });

  it('errorText shown to the UI is truncated and has token-shaped strings redacted', async () => {
    const secret = 'sk-ant-oat01-' + 'Ab3'.repeat(20);
    const eng = new StubEngine(() => [failResult(`boom Authorization: Bearer ${secret}`, { stderr: `token=${'9f'.repeat(30)}\n` + 'y'.repeat(10_000) })]);
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    const r = msgsOf(c, 'turn_result')[0] as Extract<ServerMessage, { type: 'turn_result' }>;
    expect(r.errorText).toContain('boom');
    expect(r.errorText).not.toContain(secret);
    expect(r.errorText).not.toContain('9f'.repeat(30));
    expect(r.errorText).toContain('[redacted]');
    expect(r.errorText!.length).toBeLessThan(3000);
  });

  it('retry: when the move to the next account is refused, that account is skipped and the one after is used', async () => {
    const eng = new StubEngine((req) => (req.account === 'a' ? [failResult('API Error: 429 rate limit reached', { sessionId: SID })] : ok(SID)));
    const c = await ctx(eng, {
      move: async (o) => {
        if (o.targetProjectsRoot === c.roots.b) return { ok: false, error: 'target busy' };
        return { ok: true, targetDir: path.join(o.targetProjectsRoot, path.basename(o.sourceProjectDir)), targetFile: '', copied: [] };
      },
    });
    const srcDir = await seedSession(c, 'a');
    await c.deps.store.set({ sessionId: SID, cwd: '/w/one', account: 'a', projectDir: srcDir, lastTurnAtMs: NOW - 60_000, justCompacted: false, defaultModel: 'opus' });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(eng.calls.map((r) => r.account)).toEqual(['a', 'c']);
    expect(msgsOf(c, 'turn_retry')).toMatchObject([{ fromAccount: 'a', toAccount: 'c', attempt: 1 }]);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: true, badge: { account: 'c' } });
    expect(c.deps.store.get(SID)).toMatchObject({ account: 'c' });
  });

  it('other failures do not retry', async () => {
    const eng = new StubEngine(() => [failResult('error_max_turns: too many')]);
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(eng.calls).toHaveLength(1);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: false });
    expect(msgsOf(c, 'turn_retry')).toEqual([]);
  });

  it('relays permission requests to the sink and audits them without the input', async () => {
    const eng = new StubEngine(async (req) => {
      const d = await req.onPermission({ toolName: 'Write', input: { file_path: '/secret', content: 'TOKEN=abc' }, toolUseId: 'tu1' });
      return ok('p1', [{ kind: 'delta', text: d }]);
    });
    const c = await ctx(eng);
    const asked: unknown[] = [];
    c.sink.askPermission = async (r) => { asked.push(r); return 'deny'; };
    await new TurnRunner(c.deps).run({ turnId: 't9', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(asked).toEqual([{ turnId: 't9', sessionId: null, cwd: '/w/new', toolName: 'Write', input: { file_path: '/secret', content: 'TOKEN=abc' }, toolUseId: 'tu1' }]);
    expect(msgsOf(c, 'delta').map((m) => (m as { text: string }).text)).toEqual(['ok', 'deny']);
    const audit = await fs.readFile(c.deps.auditFile, 'utf8');
    expect(audit).toContain('"toolName":"Write"');
    expect(audit).toContain('"decision":"deny"');
    expect(audit).not.toContain('TOKEN=abc');
  });

  it('a failing audit write does not lose the permission decision', async () => {
    const eng = new StubEngine(async (req) => ok('p2', [{ kind: 'delta', text: await req.onPermission({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tu', signal: new AbortController().signal }) }]));
    const c = await ctx(eng);
    await fs.mkdir(c.deps.auditFile, { recursive: true }); // appendFile on a directory → EISDIR
    c.sink.askPermission = async () => 'once';
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(msgsOf(c, 'delta').map((m) => (m as { text: string }).text)).toEqual(['ok', 'once']);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: true });
  });

  it('an already-aborted turn never reaches the engine', async () => {
    const eng = new StubEngine(() => ok('x'));
    const c = await ctx(eng);
    const ac = new AbortController();
    ac.abort();
    c.sink.signal = ac.signal;
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(eng.calls).toHaveLength(0);
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ ok: false, errorText: expect.stringContaining('중단') });
  });

  it('allow-for-session on turn 1 pre-allows the same scoped action on turn 2; a different command still prompts', async () => {
    const ruleOf = (cmd: string) => `Bash(${cmd})`;
    // Emulates the CLI: prompt unless a pre-allowed rule matches this exact command.
    const eng = new StubEngine(async (req) => {
      const cmd = req.prompt;
      let d = 'preallowed';
      if (!(req.allowRules ?? []).includes(ruleOf(cmd))) {
        d = await req.onPermission({ toolName: 'Bash', input: { command: cmd }, toolUseId: 'tu', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: cmd }], behavior: 'allow', destination: 'session' }] });
      }
      return ok('perm1', [{ kind: 'delta', text: d }]);
    });
    const c = await ctx(eng);
    const asked: string[] = [];
    c.sink.askPermission = async (r) => { asked.push(String(r.input.command)); return 'session'; };
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'git status' }, c.sink);
    expect((c.deps.store.get('perm1') as ClaudeSessionState | null)?.allowRules).toEqual(['Bash(git status)']);
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'perm1', text: 'git status' }, c.sink);
    expect(asked).toEqual(['git status']);
    expect(eng.calls[1]?.allowRules).toEqual(['Bash(git status)']);
    await runner.run({ turnId: 't3', cwd: '/w/new', sessionId: 'perm1', text: 'rm -rf build' }, c.sink);
    expect(asked).toEqual(['git status', 'rm -rf build']);
  });

  it('once, deny, or a suppressed session allow store nothing', async () => {
    const eng = new StubEngine(async (req) => {
      await req.onPermission({ toolName: 'Bash', input: { command: 'x' }, toolUseId: 'tu', suppressAlwaysAllowRule: true, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] });
      return ok('perm2');
    });
    const c = await ctx(eng);
    c.sink.askPermission = async () => 'session';
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'x' }, c.sink);
    expect((c.deps.store.get('perm2') as ClaudeSessionState | null)?.allowRules ?? []).toEqual([]);
  });

  // Real CLI suggestion shapes (captured on account b with deck's buildOptions).
  const REAL_WRITE = [{ type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const }];
  const realBash = (cmd: string) => [
    { type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: cmd }], behavior: 'allow' as const, destination: 'localSettings' as const },
    { type: 'addDirectories' as const, directories: ['/w/new/sub'], destination: 'session' as const },
    { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
  ];

  it('Write → 이 세션 (real setMode suggestion): stored as mode acceptEdits, later turns run in acceptEdits and do not prompt', async () => {
    // Emulates the CLI: Write prompts unless the session runs in acceptEdits.
    const eng = new StubEngine(async (req) => {
      if (req.permissionMode !== 'acceptEdits') await req.onPermission({ toolName: 'Write', input: { file_path: '/w/new/p.txt' }, toolUseId: 'tu', suggestions: REAL_WRITE });
      return ok('permW');
    });
    const c = await ctx(eng);
    let asked = 0;
    c.sink.askPermission = async () => { asked++; return 'session'; };
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'write' }, c.sink);
    expect(eng.calls[0]?.permissionMode).toBeUndefined();
    expect(c.deps.store.get('permW')).toMatchObject({ mode: 'acceptEdits' });
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'permW', text: 'write' }, c.sink);
    expect(eng.calls[1]?.permissionMode).toBe('acceptEdits');
    expect(asked).toBe(1);
  });

  it('Bash → 이 세션 (real addRules localSettings + addDirectories + setMode): rule, directory and mode are kept for later turns', async () => {
    let n = 0;
    const eng = new StubEngine(async (req) => {
      if (n++ === 0) await req.onPermission({ toolName: 'Bash', input: { command: 'touch s3.txt' }, toolUseId: 'tu', suggestions: realBash('touch s3.txt') });
      return ok('permB');
    });
    const c = await ctx(eng);
    c.sink.askPermission = async () => 'session';
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'x' }, c.sink);
    expect(c.deps.store.get('permB')).toMatchObject({ allowRules: ['Bash(touch s3.txt)'], allowDirs: ['/w/new/sub'], mode: 'acceptEdits' });
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'permB', text: 'x' }, c.sink);
    expect(eng.calls[1]).toMatchObject({ allowRules: ['Bash(touch s3.txt)'], allowDirs: ['/w/new/sub'], permissionMode: 'acceptEdits' });
  });

  it('bypassPermissions and unknown suggestion kinds are never persisted', async () => {
    const eng = new StubEngine(async (req) => {
      await req.onPermission({ toolName: 'Bash', input: { command: 'x' }, toolUseId: 'tu', suggestions: [
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        { type: 'removeDirectories', directories: ['/'], destination: 'session' },
        { type: 'somethingNew', destination: 'userSettings' } as never,
      ] });
      return ok('permX');
    });
    const c = await ctx(eng);
    c.sink.askPermission = async () => 'session';
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'x' }, c.sink);
    const st = c.deps.store.get('permX') as ClaudeSessionState | null;
    expect(st?.mode).toBeUndefined();
    expect(st?.allowRules).toBeUndefined();
    expect(st?.allowDirs).toBeUndefined();
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'permX', text: 'x' }, c.sink);
    expect(eng.calls[1]?.permissionMode).toBeUndefined();
  });

  it('fable with no account having room is downgraded to opus with a note', async () => {
    const eng = new StubEngine(() => ok('f1'));
    const c = await ctx(eng, {}, await usageWith([13, 7, 85], [2, 3, 90], [0, 50, 80]));
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi', model: 'fable' }, c.sink);
    expect(eng.calls[0]?.model).toBe('opus');
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ badge: { model: 'opus', modelNote: expect.stringContaining('Fable') } });
  });

  it('effort travels to the Claude engine and survives a Fable → Opus downgrade; absent → no effort', async () => {
    const eng = new StubEngine(() => ok('e1'));
    const c = await ctx(eng, {}, await usageWith([13, 7, 85], [2, 3, 90], [0, 50, 80]));
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi', model: 'fable', effort: 'xhigh' }, c.sink);
    expect(eng.calls[0]).toMatchObject({ model: 'opus', effort: 'xhigh' });
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: null, text: 'hi', model: 'sonnet' }, c.sink);
    expect(eng.calls[1]).not.toHaveProperty('effort');
  });

  it('자동: the first turn picks the model and effort from the prompt; later 자동 turns keep the session model', async () => {
    const eng = new StubEngine(() => ok('auto1'));
    const c = await ctx(eng);
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: '이 함수 이름 뭐야?', model: 'auto' }, c.sink);
    expect(eng.calls[0]).toMatchObject({ model: 'sonnet', effort: 'medium' });
    expect(msgsOf(c, 'turn_started')[0]).toMatchObject({ model: 'sonnet', reason: expect.stringMatching(/^자동 → Sonnet 5\.5 · 짧은 조회/) });
    expect(c.deps.store.get('auto1')).toMatchObject({ defaultModel: 'sonnet' });
    // A later 자동 turn with a "hard" prompt does not switch models mid-session.
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 'auto1', text: '보안 취약점 검토해줘', model: 'auto' }, c.sink);
    expect(eng.calls[1]).toMatchObject({ model: 'sonnet', effort: 'medium' });
    // An explicit effort wins over the automatic one.
    await runner.run({ turnId: 't3', cwd: '/w/new', sessionId: null, text: '버그 고쳐줘', model: 'auto', effort: 'low' }, c.sink);
    expect(eng.calls[2]).toMatchObject({ model: 'opus', effort: 'low' });
  });

  it('unknown session id → error, no engine call', async () => {
    const eng = new StubEngine(() => ok('x'));
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: 'nope', text: 'hi' }, c.sink);
    expect(eng.calls).toHaveLength(0);
    expect(msgsOf(c, 'error')[0]).toMatchObject({ turnId: 't', message: expect.stringContaining('세션') });
  });
});

function fakeCodex(events: EngineEvent[] | ((req: CodexTurnRequest) => EngineEvent[])): { engine: Pick<CodexEngine, 'runTurn'>; calls: CodexTurnRequest[] } {
  const calls: CodexTurnRequest[] = [];
  return { calls, engine: { async *runTurn(req) { calls.push(req); for (const e of typeof events === 'function' ? events(req) : events) yield e; } } };
}

const codexOk = (tid: string, text = 'ok'): EngineEvent[] => [
  { kind: 'init', sessionId: tid, model: 'gpt-6-sol' },
  { kind: 'notice', message: '`[features].codex_hooks` is deprecated.' },
  { kind: 'delta', text },
  { kind: 'result', sessionId: tid, ok: true, text, usage: { inputTokens: 15447, outputTokens: 5, cacheReadTokens: 11264, cacheCreationTokens: 0 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' },
];

async function usageWithGpt(gptWeekly: number | null) {
  const cards: unknown[] = [card('claude:main', 13, 70, 0, 154), card('claude:second', 2, 60, 4, 84), card('claude:third', 0, 91, 27, 36)];
  if (gptWeekly !== null) cards.push({ id: 'codex', status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [{ label: 'Weekly (7d)', used: gptWeekly }] });
  const u = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards }) }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

describe('TurnRunner: Codex sessions (D2–D5)', () => {
  it('engine codex: runs the codex engine sandboxed, stores a codex state with the rollout file, corrects GPT usage, badge says gpt', async () => {
    const codex = fakeCodex(codexOk('tid-1'));
    const c = await ctx(new StubEngine(async () => []), {
      codex: codex.engine,
      findRollout: async (root, tid) => path.join(root, '2026/09/30', `rollout-x-${tid}.jsonl`),
      readRateLimits: async () => ({ weekly: { usedPct: 40, resetsAt: null } }),
    }, await usageWithGpt(null));
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'hello codex\nsecond line', engine: 'codex', sandbox: 'workspace-write' }, c.sink);
    expect(codex.calls[0]).toMatchObject({ cwd: '/w', resumeThreadId: null, model: 'gpt-6-sol', sandbox: 'workspace-write', prompt: 'hello codex\nsecond line' });
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'gpt', engine: 'codex', model: 'gpt-6-sol', reason: 'GPT 지정', sessionId: null });
    expect(c.msgs.find((m) => m.type === 'turn_notice')).toMatchObject({ sessionId: 'tid-1', message: expect.stringContaining('deprecated') });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'ok', sessionId: 'tid-1', badge: { account: 'gpt', model: 'gpt-6-sol', usage: { cacheReadTokens: 11264 } } });
    const st = c.deps.store.get('tid-1');
    expect(st).toMatchObject({ engine: 'codex', cwd: '/w', sandbox: 'workspace-write', defaultModel: 'gpt-6-sol', title: 'hello codex', rolloutFile: path.join(c.deps.codexSessionsRoot, '2026/09/30', 'rollout-x-tid-1.jsonl'), lastTurnAtMs: NOW });
    expect(c.deps.usage.snapshot().gpt?.weekly?.usedPct).toBe(40);
    expect(c.deps.store.codexEntries()[0]).toMatchObject({ sessionId: 'tid-1', account: 'gpt', title: 'hello codex' });
    expect((c.deps.engine as StubEngine).calls).toHaveLength(0);
  });

  it('resuming a codex session honours a per-turn Codex model; the badge shows it; the stored default is unchanged', async () => {
    const codex = fakeCodex((req) => codexOk(req.resumeThreadId ?? 'x'));
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null });
    await c.deps.store.set({ engine: 'codex', sessionId: 'tid-2', cwd: '/w2', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-astra', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w2', sessionId: 'tid-2', text: 'again', model: 'gpt-6-sol' }, c.sink);
    expect(codex.calls[0]).toMatchObject({ resumeThreadId: 'tid-2', model: 'gpt-6-sol', sandbox: 'read-only' });
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ model: 'gpt-6-sol' });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, badge: { account: 'gpt', model: 'gpt-6-sol' } });
    expect(c.deps.store.get('tid-2')).toMatchObject({ defaultModel: 'gpt-6-astra' });
  });

  it('a per-turn effort reaches the codex engine', async () => {
    const codex = fakeCodex((req) => codexOk(req.resumeThreadId ?? 'x'));
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null });
    await c.deps.store.set({ engine: 'codex', sessionId: 'tid-2', cwd: '/w2', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-astra', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w2', sessionId: 'tid-2', text: 'again', model: 'gpt-6-sol', effort: 'high' }, c.sink);
    expect(codex.calls[0]).toMatchObject({ model: 'gpt-6-sol', effort: 'high' });
  });

  it('resuming a codex session keeps its engine, model and sandbox; the sent sandbox and a non-Codex model are ignored', async () => {
    const codex = fakeCodex((req) => codexOk(req.resumeThreadId ?? 'x'));
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null });
    await c.deps.store.set({ engine: 'codex', sessionId: 'tid-2', cwd: '/w2', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-astra', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/other', sessionId: 'tid-2', text: 'again', sandbox: 'workspace-write', model: 'opus', engine: 'claude' }, c.sink);
    expect(codex.calls[0]).toMatchObject({ cwd: '/w2', resumeThreadId: 'tid-2', model: 'gpt-6-astra', sandbox: 'read-only' });
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'gpt', reason: 'GPT 세션', sessionId: 'tid-2' });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, sessionId: 'tid-2' });
  });

  it('weekly 100% with credits: an explicit GPT turn still runs and sets no cooldown; auto stays on Claude', async () => {
    const codex = fakeCodex(codexOk('tid-cr'));
    const u = await usageWithGpt(100);
    u.applyTurn('gpt', { weekly: { usedPct: 100, resetsAt: null }, credits: { hasCredits: true, unlimited: false, balance: 49563.32 } });
    const c = await ctx(new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]), {
      codex: codex.engine, findRollout: async () => null,
    }, u);
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 'tc1', cwd: '/w', sessionId: null, text: 'x', engine: 'codex' }, c.sink);
    expect(codex.calls).toHaveLength(1);
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'gpt', reason: 'GPT 지정' });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true });
    expect(runner.gptCooldownUntilMs()).toBeNull();
    c.msgs.length = 0;
    await runner.run({ turnId: 'tc2', cwd: '/w', sessionId: null, text: 'y', engine: 'auto' }, c.sink);
    expect(codex.calls).toHaveLength(1);
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ reason: expect.stringContaining('GPT 주간 100%') });
  });

  it('a Codex turn.failed JSON blob with status 429 / usage_limit_reached sets the GPT cooldown', async () => {
    const blob = '{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}';
    const codex = fakeCodex([{ kind: 'init', sessionId: 'tid-9', model: 'gpt-6-sol' }, failResult(blob, { sessionId: 'tid-9' })]);
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null }, await usageWithGpt(10));
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't9', cwd: '/w', sessionId: null, text: 'x', engine: 'codex' }, c.sink);
    expect(runner.gptCooldownUntilMs()).toBe(NOW + 60 * 60_000);
  });

  it('a Codex limit failure sets a 1 h in-memory GPT cooldown that auto then honours; no retry, no account cooldown files', async () => {
    const codex = fakeCodex([{ kind: 'init', sessionId: 'tid-3', model: 'gpt-6-sol' }, failResult('usage limit reached for this week', { sessionId: 'tid-3' })]);
    const c = await ctx(new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]), { codex: codex.engine, findRollout: async () => null }, await usageWithGpt(10));
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't3', cwd: '/w', sessionId: null, text: 'x', engine: 'codex' }, c.sink);
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: false, badge: { account: 'gpt' }, errorText: expect.stringContaining('usage limit') });
    expect(c.msgs.filter((m) => m.type === 'turn_retry')).toHaveLength(0);
    expect(runner.gptCooldownUntilMs()).toBe(NOW + 60 * 60_000);
    expect(readCooldownUntilMs(c.deps.cooldownDir, 'b', NOW)).toBeNull();
    c.msgs.length = 0;
    await runner.run({ turnId: 't4', cwd: '/w', sessionId: null, text: 'y', engine: 'auto' }, c.sink);
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'b', reason: expect.stringContaining('GPT 쿨다운') });
  });

  it('auto opens on GPT when it has the headroom; codex requested without a binary falls back to Claude with the reason', async () => {
    const codex = fakeCodex(codexOk('tid-5'));
    const c = await ctx(new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]), { codex: codex.engine, findRollout: async () => null }, await usageWithGpt(10));
    await new TurnRunner(c.deps).run({ turnId: 't5', cwd: '/w', sessionId: null, text: 'x', engine: 'auto' }, c.sink);
    expect(c.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'gpt', reason: expect.stringContaining('→ GPT') });
    const d = await ctx(new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]), { codex: null });
    await new TurnRunner(d.deps).run({ turnId: 't6', cwd: '/w', sessionId: null, text: 'x', engine: 'codex', model: 'gpt-6-astra' }, d.sink);
    expect(d.msgs.find((m) => m.type === 'turn_started')).toMatchObject({ account: 'b', engine: 'claude', model: 'opus', reason: expect.stringContaining('codex CLI 없음 → Claude') });
  });
});

describe('TurnRunner: Codex session ids', () => {
  it('persists only a thread id the CLI reported (init), never a result-only id', async () => {
    const codex = fakeCodex([failResult('잘못된 세션 ID 형식', { sessionId: '--dangerously-bypass-approvals-and-sandbox' })]);
    const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, findRollout: async () => null });
    await new TurnRunner(c.deps).run({ turnId: 't7', cwd: '/w', sessionId: null, text: 'x', engine: 'codex' }, c.sink);
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: false, sessionId: null });
    expect(c.deps.store.get('--dangerously-bypass-approvals-and-sandbox')).toBeNull();
    expect(c.deps.store.codexEntries()).toEqual([]);
  });
});

describe('TurnRunner: attachments (D7)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

  it('resolves ids to Attachment objects for Claude, and to imagePaths + path lines for Codex; unknown ids fail the turn before any engine runs', async () => {
    const stub = new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]);
    const c = await ctx(stub);
    const store = new AttachmentStore(path.join(c.base, 'att'));
    await store.init();
    const img = await store.save('a.png', PNG);
    const doc = await store.save('notes.md', Buffer.from('# n'));
    c.deps.attachments = store;
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'look', attachments: [img.id, doc.id] }, c.sink);
    expect(stub.calls[0]?.attachments?.map((a) => a.id)).toEqual([img.id, doc.id]);
    expect(stub.calls[0]?.prompt).toBe('look');
    const codex = fakeCodex(codexOk('tid-a'));
    c.deps.codex = codex.engine; c.deps.findRollout = async () => null;
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w', sessionId: null, text: 'look', engine: 'codex', attachments: [img.id, doc.id] }, c.sink);
    expect(codex.calls[0]).toMatchObject({ imagePaths: [img.path], prompt: `look\n\n첨부 파일: ${doc.path}` });
    c.msgs.length = 0;
    await new TurnRunner(c.deps).run({ turnId: 't3', cwd: '/w', sessionId: null, text: 'x', attachments: ['11111111-1111-4111-8111-111111111111'] }, c.sink);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't3', message: expect.stringContaining('첨부를 찾을 수 없습니다') }]);
    expect(stub.calls).toHaveLength(1);
  });

  it('duplicate ids reach the engine once; with no store every id is missing (no crash)', async () => {
    const stub = new StubEngine(async () => [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)]);
    const c = await ctx(stub);
    const store = new AttachmentStore(path.join(c.base, 'att'));
    await store.init();
    const img = await store.save('a.png', PNG);
    const doc = await store.save('notes.md', Buffer.from('# n'));
    c.deps.attachments = store;
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'look', attachments: [img.id, doc.id, img.id, doc.id] }, c.sink);
    expect(stub.calls[0]?.attachments?.map((a) => a.id)).toEqual([img.id, doc.id]);
    c.deps.attachments = null;
    c.msgs.length = 0;
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w', sessionId: null, text: 'x', attachments: [img.id, img.id] }, c.sink);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't2', message: `첨부를 찾을 수 없습니다: ${img.id}` }]);
    expect(stub.calls).toHaveLength(1);
  });
});

describe('TurnRunner: questions (D8)', () => {
  it('relays onQuestion to the sink with turn scope and audits it as answered / deny', async () => {
    const stub = new StubEngine(async (req) => {
      const a = await req.onQuestion?.({ toolUseId: 'tu1', questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }], multiSelect: false }] });
      return [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID, `answer=${a ? a['Which color?'] : 'none'}`)];
    });
    const c = await ctx(stub);
    const seen: unknown[] = [];
    c.sink.askQuestion = async (q) => { seen.push(q); return { 'Which color?': 'blue' }; };
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'ask' }, c.sink);
    expect(seen[0]).toMatchObject({ turnId: 't1', cwd: '/w', toolUseId: 'tu1', questions: [{ header: 'Color' }] });
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'answer=blue' });
    const audit = (await fs.readFile(c.deps.auditFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { toolName: string; decision: string });
    expect(audit.at(-1)).toMatchObject({ toolName: 'AskUserQuestion', decision: 'answered' });
    c.sink.askQuestion = async () => null;
    await new TurnRunner(c.deps).run({ turnId: 't2', cwd: '/w', sessionId: null, text: 'ask' }, c.sink);
    expect(c.msgs.at(-1)).toMatchObject({ type: 'turn_result', text: 'answer=none' });
  });

  it('a malformed AskUserQuestion is never shown but still leaves a deny audit line', async () => {
    const stub = new StubEngine(async (req) => {
      await req.onQuestionMalformed?.({ questions: [{ question: 'dup' }, { question: 'dup' }] });
      return [{ kind: 'init', sessionId: SID, model: 'm' }, okResult(SID)];
    });
    const c = await ctx(stub);
    let asked = 0;
    c.sink.askQuestion = async () => { asked++; return null; };
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'ask' }, c.sink);
    expect(asked).toBe(0);
    const audit = (await fs.readFile(c.deps.auditFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { toolName: string; decision: string; turnId: string; inputSha256: string });
    expect(audit.at(-1)).toMatchObject({ toolName: 'AskUserQuestion', decision: 'deny', turnId: 't1', inputSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe('TurnRunner: 자동 승인', () => {
  it('on: tool calls skip the card and are audited as auto', async () => {
    const eng = new StubEngine(async (req) => {
      expect(req.autoApprove?.()).toBe(true);
      await req.onAutoApproved?.({ toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: 'tu1' });
      return ok('aa1');
    });
    const c = await ctx(eng, { autoApprove: () => true });
    let asked = 0;
    c.sink.askPermission = async () => { asked++; return 'deny'; };
    await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(asked).toBe(0);
    const audit = (await fs.readFile(c.deps.auditFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { toolName: string; decision: string });
    expect(audit).toEqual([expect.objectContaining({ toolName: 'Bash', decision: 'auto' })]);
  });

  it('new GPT session without an explicit sandbox: workspace-write when on, read-only when off; an explicit choice wins', async () => {
    for (const [auto, sent, want] of [[true, undefined, 'workspace-write'], [false, undefined, 'read-only'], [true, 'read-only', 'read-only']] as const) {
      const codex = fakeCodex(codexOk('tid-aa'));
      const c = await ctx(new StubEngine(async () => []), { codex: codex.engine, autoApprove: () => auto, findRollout: async () => null }, await usageWithGpt(null));
      await new TurnRunner(c.deps).run({ turnId: 't1', cwd: '/w', sessionId: null, text: 'x', engine: 'codex', ...(sent ? { sandbox: sent } : {}) }, c.sink);
      expect(codex.calls[0]?.sandbox).toBe(want);
    }
  });
});
