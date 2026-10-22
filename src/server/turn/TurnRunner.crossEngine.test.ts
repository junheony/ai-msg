import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account, GeminiAccount } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import { StubEngine, failResult } from '../engine/StubEngine';
import type { CodexEngine, CodexTurnRequest } from '../engine/CodexEngine';
import type { GeminiTurnRequest } from '../engine/GeminiEngine';
import type { EngineEvent } from '../engine/Engine';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { CROSS_ENGINE_MAX_HOPS, TurnRunner, type CrossEngineHandoff, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

// 다른 AI 로 이어가기 (crossEngineFailover): a limit with no account of the engine left goes on in a new session of another engine.

const NOW = Date.parse('2026-09-30T12:30:00Z');
const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
const EXCERPT = 'User: earlier question\nClaude: earlier answer';

async function usage(): Promise<UsageService> {
  const resetsAt = new Date(NOW + 36 * 3_600_000).toISOString();
  const card = (id: string, s: number, w: number) => ({ id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [{ label: 'Session (5h)', used: s, resetsAt }, { label: 'Weekly (7d)', used: w, resetsAt }, { label: 'Fable (7d)', used: 0, resetsAt }] });
  const cards = [card('claude:main', 13, 7), card('claude:second', 2, 3), card('claude:third', 0, 91), { id: 'codex', status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [{ label: 'Weekly (7d)', used: 10 }] }];
  const u = new UsageService({ mode: 'usage-deck', accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards }) }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

function fakeCodex(events: (req: CodexTurnRequest) => EngineEvent[]): { engine: Pick<CodexEngine, 'runTurn'>; calls: CodexTurnRequest[] } {
  const calls: CodexTurnRequest[] = [];
  return { calls, engine: { async *runTurn(req) { calls.push(req); for (const e of events(req)) yield e; } } };
}
const codexResult = (tid: string, ok: boolean, text: string): EngineEvent[] => [
  { kind: 'init', sessionId: tid, model: 'gpt-6-sol' },
  ...(ok ? [{ kind: 'delta', text } as EngineEvent] : []),
  { kind: 'result', sessionId: tid, ok, text: ok ? text : '', usage: ZERO, errorText: ok ? null : text, stderr: null, errorKind: null, terminalReason: ok ? 'completed' : null },
];

function fakeGemini(events: (req: GeminiTurnRequest) => EngineEvent[]) {
  const calls: GeminiTurnRequest[] = [];
  return { calls, dep: { loggedIn: (a: GeminiAccount) => a === 'g1', engine: { async *runTurn(req: GeminiTurnRequest) { calls.push(req); for (const e of events(req)) yield e; } } } };
}
const geminiQuota = (sid: string): EngineEvent[] => [
  { kind: 'init', sessionId: sid, model: 'gemini-2.5-pro' },
  { kind: 'result', sessionId: sid, ok: false, text: '', usage: ZERO, errorText: 'You have exhausted your daily quota on this model.', stderr: null, errorKind: null, terminalReason: null },
];

/** A question 자동 may give Gemini (explain: Gemini is in that cell only). */
const EXPLAIN = '이 함수가 무엇을 하는지 설명해 줘';
const claudeLimit = new StubEngine(() => [{ kind: 'init', sessionId: 'n1', model: 'm' }, failResult('usage limit reached', { sessionId: 'n1' })]);

type Ctx = { deps: TurnRunnerDeps; msgs: ServerMessage[]; sink: TurnSink; handoffs: CrossEngineHandoff[] };

async function ctx(engine: StubEngine, over: Partial<TurnRunnerDeps> = {}): Promise<Ctx> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trx-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const deps: TurnRunnerDeps = {
    accounts: testRegistry(), engine, usage: await usage(),
    index: new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'projects.json') }), store,
    cooldownDir: path.join(base, 'cooldown'), protectedAccount: 'a', auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots),
    codex: null, attachments: null, codexSessionsRoot: path.join(base, 'codex-sessions'),
    findRollout: async () => null, readRateLimits: async () => null,
    now: () => NOW, maxRetries: 2, sameVendorRotation: () => false, crossEngineFailover: () => true,
    ...over,
  };
  const msgs: ServerMessage[] = [];
  const handoffs: CrossEngineHandoff[] = [];
  const sink: TurnSink = {
    emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal,
    crossEngine: async (c) => { handoffs.push(c); return { excerpt: EXCERPT }; },
  };
  return { deps, msgs, sink, handoffs };
}

const of = <T extends ServerMessage['type']>(c: Ctx, t: T) => c.msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);

describe('TurnRunner · 다른 AI 로 이어가기', () => {
  it('Claude limit with no Claude account left: a new GPT session gets the excerpt and the message; the failed turn says so; no retry booked', async () => {
    const codex = fakeCodex(() => codexResult('tid-x', true, 'continued'));
    const c = await ctx(claudeLimit, { codex: codex.engine });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi there', clientRef: 'r1' }, c.sink);
    expect(c.handoffs).toEqual([expect.objectContaining({ from: 'n1', fromTurnId: 't', fromEngine: 'claude', engine: 'codex', turnId: 't:x1', text: 'hi there', notice: 'Claude 한도가 차서 GPT 로 이어갑니다', cwd: '/w/new' })]);
    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0]).toMatchObject({ resumeThreadId: null, prompt: 'hi there', developerInstructions: expect.stringContaining(EXCERPT) });
    expect(codex.calls[0]!.developerInstructions).toContain('Claude');
    const results = of(c, 'turn_result');
    expect(results.map((m) => [m.turnId, m.ok])).toEqual([['t', false], ['t:x1', true]]);
    expect(results[0]!.errorText).toContain('Claude 한도가 차서 GPT 로 이어갑니다');
    expect(of(c, 'turn_started').map((m) => [m.turnId, m.engine ?? 'claude'])).toEqual([['t', 'claude'], ['t:x1', 'codex']]);
    expect(c.deps.store.get('n1')?.pendingRetry).toBeUndefined();
    expect(c.deps.store.get('tid-x')).toMatchObject({ engine: 'codex', cwd: '/w/new' });
  });

  it('setting off (or no hook): the old behaviour — no handover, the retry is booked', async () => {
    const codex = fakeCodex(() => codexResult('tid-x', true, 'continued'));
    const c = await ctx(claudeLimit, { codex: codex.engine, crossEngineFailover: () => false });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi' }, c.sink);
    expect(c.handoffs).toEqual([]);
    expect(codex.calls).toEqual([]);
    expect(of(c, 'turn_result').map((m) => m.turnId)).toEqual(['t']);
    expect(c.deps.store.get('n1')?.pendingRetry).toMatchObject({ text: 'hi', hops: 1 });
  });

  it('Gemini without consent is never picked: with GPT not installed nothing takes over; with consent Gemini does', async () => {
    const g = fakeGemini(() => geminiQuota('gem-1'));
    const autoRoute = { autoEngines: ['claude', 'codex', 'gemini', 'grok'] as const, autoConsent: [] as const, grokFast: false, crossEngineFailover: true };
    const c = await ctx(claudeLimit, { gemini: g.dep, autoRoute: () => ({ ...autoRoute, autoEngines: [...autoRoute.autoEngines], autoConsent: [] }) });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: EXPLAIN }, c.sink);
    expect(c.handoffs).toEqual([]);
    expect(g.calls).toEqual([]);
    expect(c.deps.store.get('n1')?.pendingRetry).toMatchObject({ text: EXPLAIN });

    const c2 = await ctx(claudeLimit, { gemini: g.dep, autoRoute: () => ({ ...autoRoute, autoEngines: [...autoRoute.autoEngines], autoConsent: ['gemini'] }) });
    await new TurnRunner(c2.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: EXPLAIN }, c2.sink);
    expect(c2.handoffs.map((h) => h.engine)).toEqual(['gemini']);
    expect(g.calls).toHaveLength(1);
  });

  it(`chains at most ${CROSS_ENGINE_MAX_HOPS} handovers per message: Claude → GPT → Gemini, then the Gemini limit stands`, async () => {
    const codex = fakeCodex(() => codexResult('tid-x', false, 'usage limit reached for this week'));
    const g = fakeGemini(() => geminiQuota('gem-1'));
    const c = await ctx(claudeLimit, { codex: codex.engine, gemini: g.dep, autoRoute: () => ({ autoEngines: ['claude', 'codex', 'gemini', 'grok'], autoConsent: ['gemini', 'grok'], grokFast: false, crossEngineFailover: true }) });
    await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: EXPLAIN }, c.sink);
    expect(c.handoffs.map((h) => [h.fromEngine, h.engine, h.turnId])).toEqual([['claude', 'codex', 't:x1'], ['codex', 'gemini', 't:x1:x2']]);
    expect(codex.calls).toHaveLength(1);
    expect(g.calls).toHaveLength(1);
    expect(of(c, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t', false], ['t:x1', false], ['t:x1:x2', false]]);
    expect(of(c, 'turn_result')[1]!.errorText).toContain('GPT 한도가 차서 Gemini 로 이어갑니다');
  });

  it('a handoff-note, commander or background-task turn never moves', async () => {
    const codex = fakeCodex(() => codexResult('tid-x', true, 'continued'));
    for (const extra of [{ commanderHop: 1 }, { bgTask: true }]) {
      const c = await ctx(claudeLimit, { codex: codex.engine });
      await new TurnRunner(c.deps).run({ turnId: 't', cwd: '/w/new', sessionId: null, text: 'hi', ...extra }, c.sink);
      expect(c.handoffs).toEqual([]);
    }
    expect(codex.calls).toEqual([]);
  });
});
