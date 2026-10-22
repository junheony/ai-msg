import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account, GeminiAccount } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import { StubEngine, failResult } from '../engine/StubEngine';
import type { CodexEngine, CodexTurnRequest } from '../engine/CodexEngine';
import type { GeminiTurnRequest } from '../engine/GeminiEngine';
import type { GrokTurnRequest } from '../engine/GrokEngine';
import type { EngineEvent } from '../engine/Engine';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { AUTO_RETRY_NOTICE, TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';
import { sm } from '../i18n';

// 한도가 풀리면 자동으로 이어가기 (autoResume): a limit with nowhere to hand the turn over books a resume
// (SessionState.pendingRetry) at the earliest reset of an account / engine that could take it.

const NOW = Date.parse('2026-09-30T12:30:00Z');
const MIN = 60_000;
const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
const CONTINUE = '이어서 진행해 주세요.';

type Row = { label: string; used: number; resetsAt?: string };
/** Claude accounts main / second / third with their 5h used % and reset (ms from NOW); `gpt`: the Codex weekly row. */
async function usage(claude: Record<'main' | 'second' | 'third', [number, number]>, gpt: [number, number] = [10, 0]): Promise<UsageService> {
  const iso = (ms: number) => new Date(NOW + ms).toISOString();
  const far = iso(36 * 3_600_000);
  const card = (id: string, rows: Row[]) => ({ id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows });
  const claudeCard = (id: string, [used, resetMs]: [number, number]) => card(id, [{ label: 'Session (5h)', used, resetsAt: iso(resetMs) }, { label: 'Weekly (7d)', used: 5, resetsAt: far }, { label: 'Fable (7d)', used: 0, resetsAt: far }]);
  const cards = [claudeCard('claude:main', claude.main), claudeCard('claude:second', claude.second), claudeCard('claude:third', claude.third), card('codex', [{ label: 'Weekly (7d)', used: gpt[0], resetsAt: iso(gpt[1]) }])];
  const u = new UsageService({ mode: 'usage-deck', accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards }) }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}
const FREE = { main: [10, 3_600_000], second: [10, 3_600_000], third: [10, 3_600_000] } as Record<'main' | 'second' | 'third', [number, number]>;

type RootOf = (a: Account) => string;
/** A Claude limit in session n1 (cwd /w); its transcript is written like the CLI does, so a move to another account works. */
const claude = (worked: boolean) => (rootOf: RootOf) => new StubEngine(async (req) => {
  const file = path.join(rootOf(req.account), '-w', 'n1.jsonl');
  if (!req.resumeSessionId) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ type: 'user', cwd: '/w', message: { role: 'user', content: req.prompt } }) + '\n');
  }
  return [{ kind: 'init', sessionId: 'n1', model: 'm' }, ...(worked ? [{ kind: 'delta', text: 'half an answer' } as EngineEvent] : []), failResult('usage limit reached', { sessionId: 'n1' })];
});
const claudeLimit = claude(false);
const claudeCut = claude(true);

function fakeCodex(events: (req: CodexTurnRequest) => EngineEvent[]): { engine: Pick<CodexEngine, 'runTurn'>; calls: CodexTurnRequest[] } {
  const calls: CodexTurnRequest[] = [];
  return { calls, engine: { async *runTurn(req) { calls.push(req); for (const e of events(req)) yield e; } } };
}
const codexLimit = (tid: string, worked = false): EngineEvent[] => [
  { kind: 'init', sessionId: tid, model: 'gpt-6-sol' },
  ...(worked ? [{ kind: 'tool_call', toolUseId: 'u1', name: 'Bash', input: {} } as EngineEvent] : []),
  { kind: 'result', sessionId: tid, ok: false, text: '', usage: ZERO, errorText: "You've hit your usage limit.", stderr: null, errorKind: null, terminalReason: null },
];
function fakeGemini(events: (req: GeminiTurnRequest) => EngineEvent[]) {
  return { loggedIn: (a: GeminiAccount) => a === 'g1', engine: { async *runTurn(req: GeminiTurnRequest) { for (const e of events(req)) yield e; } } };
}
function fakeGrok(events: (req: GrokTurnRequest) => EngineEvent[]) {
  return { async *run(req: GrokTurnRequest) { await req.onSessionId?.(req.resumeSessionId ?? 'gk1'); for (const e of events(req)) yield e; } };
}

type Ctx = { deps: TurnRunnerDeps; msgs: ServerMessage[]; sink: TurnSink };

async function ctx(engine: (rootOf: RootOf) => StubEngine, over: Partial<TurnRunnerDeps> = {}, u: UsageService | null = null): Promise<Ctx> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trar-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const deps: TurnRunnerDeps = {
    accounts: testRegistry(), engine: engine((a) => roots[a]!), usage: u ?? (await usage(FREE)),
    index: new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'projects.json') }), store,
    cooldownDir: path.join(base, 'cooldown'), protectedAccount: 'a', auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots),
    codex: null, attachments: null, codexSessionsRoot: path.join(base, 'codex-sessions'),
    findRollout: async () => null, readRateLimits: async () => null,
    now: () => NOW, maxRetries: 2, sameVendorRotation: () => true, crossEngineFailover: () => false,
    ...over,
  };
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { deps, msgs, sink };
}

describe('TurnRunner · 한도가 풀리면 자동으로 이어가기', () => {
  it('setting off: a limit with nowhere to go books nothing', async () => {
    const c = await ctx(claudeLimit, { autoResume: () => false });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi' }, c.sink);
    expect(c.deps.store.get('n1')).toBeDefined();
    expect(c.deps.store.get('n1')?.pendingRetry).toBeUndefined();
  });

  it('a background task turn books nothing (like the handover, it is not resent by itself)', async () => {
    const c = await ctx(claudeLimit);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi', bgTask: true }, c.sink);
    expect(c.deps.store.get('n1')).toBeDefined();
    expect(c.deps.store.get('n1')?.pendingRetry).toBeUndefined();
  });

  it('booked at the earliest usage reset among the accounts that could take the turn (+1 min), the message itself when nothing ran', async () => {
    const u = await usage({ main: [100, 50 * MIN], second: [100, 20 * MIN], third: [100, 40 * MIN] });
    const c = await ctx(claudeLimit, {}, u);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi' }, c.sink);
    expect(c.deps.store.get('n1')?.pendingRetry).toEqual({ text: 'hi', hops: 1, atMs: NOW + 21 * MIN });
  });

  it('같은 벤더 계정 자동 순환 off: only the session account\'s own reset counts', async () => {
    const u = await usage({ main: [100, 50 * MIN], second: [100, 20 * MIN], third: [100, 40 * MIN] });
    const c = await ctx(claudeLimit, { sameVendorRotation: () => false }, u);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi' }, c.sink);
    const st = c.deps.store.get('n1');
    const own = { a: 50, b: 20, c: 40 } as Record<string, number>;
    expect(st && 'account' in st ? st.pendingRetry?.atMs : null).toBe(NOW + (own[(st as { account: string }).account]! + 1) * MIN);
  });

  it('a turn cut part-way is resumed with a short 계속 request, not its message again (files or not)', async () => {
    const c = await ctx(claudeCut);
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'do the big thing' }, c.sink);
    expect(c.deps.store.get('n1')?.pendingRetry).toMatchObject({ text: CONTINUE, hops: 1 });
  });

  it('GPT: a limit books the resume at the GPT reset; the resumed turn says so; the third limit in a row books nothing', async () => {
    const codex = fakeCodex((req) => codexLimit(req.resumeThreadId ?? 'tid-1'));
    const c = await ctx(claudeLimit, { codex: codex.engine }, await usage(FREE, [100, 45 * MIN]));
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi gpt', engine: 'codex' }, c.sink);
    expect(c.deps.store.get('tid-1')?.pendingRetry).toEqual({ text: 'hi gpt', hops: 1, atMs: NOW + 46 * MIN });
    await runner.run({ turnId: 't2', cwd: '/w', sessionId: 'tid-1', text: 'hi gpt', retryHop: 1 }, c.sink);
    expect(c.msgs.filter((m) => m.type === 'turn_notice' && m.turnId === 't2').map((m) => (m as { message: string }).message)).toContain(AUTO_RETRY_NOTICE);
    expect(c.deps.store.get('tid-1')?.pendingRetry).toMatchObject({ hops: 2 });
    await runner.run({ turnId: 't3', cwd: '/w', sessionId: 'tid-1', text: 'hi gpt', retryHop: 2 }, c.sink);
    expect(c.deps.store.get('tid-1')?.pendingRetry).toBeUndefined();
  });

  it('GPT cut part-way: the 계속 request', async () => {
    const codex = fakeCodex((req) => codexLimit(req.resumeThreadId ?? 'tid-1', true));
    const c = await ctx(claudeLimit, { codex: codex.engine });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi gpt', engine: 'codex' }, c.sink);
    expect(c.deps.store.get('tid-1')?.pendingRetry).toMatchObject({ text: CONTINUE });
  });

  it('Gemini with no usage numbers: the engine cooldown (+1 min)', async () => {
    const gemini = fakeGemini(() => [
      { kind: 'init', sessionId: 'gs1', model: 'gemini-2.5-pro' },
      { kind: 'result', sessionId: 'gs1', ok: false, text: '', usage: ZERO, errorText: 'You have exhausted your daily quota on this model.', stderr: null, errorKind: null, terminalReason: null },
    ]);
    const c = await ctx(claudeLimit, { gemini });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi gem', engine: 'gemini' }, c.sink);
    expect(c.deps.store.get('gs1')?.pendingRetry).toEqual({ text: 'hi gem', hops: 1, atMs: NOW + 61 * MIN });
  });

  it('Gemini: only the buckets of the model group the resume runs on count', async () => {
    const iso = (ms: number) => new Date(NOW + ms).toISOString();
    const gemini = fakeGemini(() => [
      { kind: 'init', sessionId: 'gs1', model: 'm' },
      { kind: 'result', sessionId: 'gs1', ok: false, text: '', usage: ZERO, errorText: 'You have exhausted your daily quota on this model.', stderr: null, errorKind: null, terminalReason: null },
    ]);
    const at = async (model: 'gemini-pro' | 'gemini-flash') => {
      const u = await usage(FREE);
      const real = u.snapshot.bind(u);
      u.snapshot = () => ({ ...real(), geminiSeats: { g1: { status: 'ok', fetchedAt: iso(0), loggedIn: true, buckets: [{ name: 'Gemini · 5h', usedPct: 100, resetsAt: iso(10 * MIN) }, { name: 'Argon · 5h', usedPct: 100, resetsAt: iso(50 * MIN) }] } } });
      const c = await ctx(claudeLimit, { gemini }, u);
      await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi gem', engine: 'gemini', model }, c.sink);
      return c.deps.store.get('gs1')?.pendingRetry?.atMs;
    };
    expect(await at('gemini-pro')).toBe(NOW + 51 * MIN);
    expect(await at('gemini-flash')).toBe(NOW + 11 * MIN);
  });

  it('Grok rate limit books the resume; an aborted turn books nothing', async () => {
    const grok = fakeGrok((req) => [{ kind: 'result', sessionId: req.resumeSessionId ?? 'gk1', ok: false, text: '', usage: ZERO, errorText: 'rate limited', stderr: null, errorKind: 'rate_limit', terminalReason: null } as EngineEvent]);
    const c = await ctx(claudeLimit, { grok });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi grok', engine: 'grok' }, c.sink);
    expect(c.deps.store.get('gk1')?.pendingRetry).toMatchObject({ text: 'hi grok', hops: 1 });
    const d = await ctx(claudeLimit, { grok });
    const ac = new AbortController();
    ac.abort();
    await new TurnRunner(d.deps).run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi grok', engine: 'grok' }, { ...d.sink, signal: ac.signal });
    expect(d.deps.store.get('gk1')?.pendingRetry).toBeUndefined();
  });

  it('재시작으로 끊긴 작업 이어가기 (push/restartResume): its turn says so instead of the limit notice, on Claude and GPT', async () => {
    const text = sm().turn.restartResume.prompt('sleep 600');
    const codex = fakeCodex((req) => codexLimit(req.resumeThreadId ?? 'tid-1'));
    const c = await ctx(claudeLimit, { codex: codex.engine }, await usage(FREE, [100, 45 * MIN]));
    const runner = new TurnRunner(c.deps);
    await runner.run({ turnId: 't', cwd: '/w', sessionId: null, text: 'hi gpt', engine: 'codex' }, c.sink);
    await runner.run({ turnId: 't2', cwd: '/w', sessionId: 'tid-1', text, retryHop: 1 }, c.sink);
    await runner.run({ turnId: 'c1', cwd: '/w', sessionId: null, text: 'hi' }, c.sink);
    await runner.run({ turnId: 'c2', cwd: '/w', sessionId: 'n1', text, retryHop: 1 }, c.sink);
    for (const id of ['t2', 'c2']) {
      const notices = c.msgs.filter((m) => m.type === 'turn_notice' && m.turnId === id).map((m) => (m as { message: string }).message);
      expect(notices).toContain(sm().turn.restartResume.notice);
      expect(notices).not.toContain(AUTO_RETRY_NOTICE);
    }
    // A limit on that turn takes the auto-resume path as any retry: booked again with the next hop.
    expect(c.deps.store.get('tid-1')?.pendingRetry).toMatchObject({ text, hops: 2 });
  });
});
