import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import { StubEngine, failResult, okResult } from '../engine/StubEngine';
import type { EngineEvent } from '../engine/Engine';
import { readCooldownUntilMs } from '../routing/cooldown';
import { SessionIndex } from '../sessions/SessionIndex';
import { projectSlug } from '../sessions/slug';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
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
    move: async (o) => { moves.push(o); return { ok: true, targetDir: path.join(o.targetProjectsRoot, path.basename(o.sourceProjectDir)), targetFile: '', copied: [] }; },
    now: () => NOW,
    maxRetries: 2,
    ...over,
  };
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', signal: new AbortController().signal };
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
    expect(msgsOf(c, 'delta')).toEqual([{ type: 'delta', turnId: 't1', text: 'ok' }]);
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
    expect(c.deps.store.get('sym1')?.projectDir).toBe(expected);
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
    expect(c.deps.store.get('far1')?.projectDir).toBe(path.join(c.roots.b, '-somewhere-else'));
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
    expect(asked).toEqual([{ turnId: 't9', toolName: 'Write', input: { file_path: '/secret', content: 'TOKEN=abc' }, toolUseId: 'tu1' }]);
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

  it('fable with no account having room is downgraded to opus with a note', async () => {
    const eng = new StubEngine(() => ok('f1'));
    const c = await ctx(eng, {}, await usageWith([13, 7, 85], [2, 3, 90], [0, 50, 80]));
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi', model: 'fable' }, c.sink);
    expect(eng.calls[0]?.model).toBe('opus');
    expect(msgsOf(c, 'turn_result')[0]).toMatchObject({ badge: { model: 'opus', modelNote: expect.stringContaining('Fable') } });
  });

  it('unknown session id → error, no engine call', async () => {
    const eng = new StubEngine(() => ok('x'));
    const c = await ctx(eng);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: 'nope', text: 'hi' }, c.sink);
    expect(eng.calls).toHaveLength(0);
    expect(msgsOf(c, 'error')[0]).toMatchObject({ turnId: 't', message: expect.stringContaining('세션') });
  });
});
