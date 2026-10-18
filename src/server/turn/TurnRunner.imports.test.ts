import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '../../shared/protocol';
import type { SessionEntry } from '../../shared/session-types';
import type { EngineEvent } from '../engine/Engine';
import type { GeminiTurnRequest } from '../engine/GeminiEngine';
import type { GrokTurnRequest } from '../engine/GrokEngine';
import { StubEngine } from '../engine/StubEngine';
import { GROKBOT_SEND_REFUSED } from '../sessions/GrokBotImports';
import { GEMINI_RUNNING_NOTICE } from '../sessions/GeminiImports';
import { GROK_HELD_NOTICE } from '../sessions/GrokImports';
import type { ImportIndex } from '../sessions/ImportIndex';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

let base: string;
let work: string;
let file: string;
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-tr-imports-')));
  work = path.join(base, 'work');
  await fs.mkdir(work);
  file = path.join(base, 'history.jsonl');
  await fs.writeFile(file, '');
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

const list = (entries: SessionEntry[], age: number | null = null): ImportIndex => ({
  refresh: async () => {}, list: () => entries, lookup: (id) => entries.find((e) => e.sessionId === id) ?? null, activeAgeMs: async () => age,
});
const entry = (over: Partial<SessionEntry>): SessionEntry => ({ sessionId: 'x', account: 'x1', engine: 'grok', cwd: work, projectDir: base, file, title: '터미널 대화', lastModified: 1, sizeBytes: 0, imported: true, ...over });
const ok = (sid: string): EngineEvent[] => [
  { kind: 'delta', text: 'ok' },
  { kind: 'result', sessionId: sid, ok: true, text: 'ok', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' },
];

async function setup(lists: { grok?: SessionEntry[]; gemini?: SessionEntry[]; grokBot?: SessionEntry[]; age?: number | null; geminiHeld?: string | null }, over: Partial<TurnRunnerDeps> = {}) {
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  const index = new SessionIndex({
    roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'),
    grokImports: list(lists.grok ?? [], lists.age ?? null), geminiImports: { ...list(lists.gemini ?? [], lists.age ?? null), ...(lists.geminiHeld !== undefined ? { heldReason: async () => lists.geminiHeld ?? null } : {}) }, grokBotImports: list(lists.grokBot ?? []),
  });
  await index.refresh();
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const grokCalls: GrokTurnRequest[] = [];
  const geminiCalls: GeminiTurnRequest[] = [];
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  const runner = new TurnRunner({
    accounts: testRegistry(), engine: new StubEngine(async () => { throw new Error('no Claude turn expected'); }), codex: null, attachments: null, usage, index, store,
    cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codexSessionsRoot: path.join(base, 'codex'),
    grok: { async *run(req) { grokCalls.push(req); await req.onSessionId?.(req.resumeSessionId ?? 'new'); for (const e of ok(req.resumeSessionId ?? 'new')) yield e; } },
    gemini: { loggedIn: () => true, engine: { async *runTurn(req) { geminiCalls.push(req); for (const e of ok(req.resumeSessionId ?? 'new')) yield e; } } },
    ...over,
  });
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { runner, store, index, grokCalls, geminiCalls, msgs, sink };
}

describe('TurnRunner: Grok Bot conversations are never sent', () => {
  it('a listed Grok Bot entry: explicit refusal, no engine call, no new session', async () => {
    const bot = entry({ sessionId: 'grokbot-abc', source: 'grokbot', readOnly: true, cwd: work });
    const c = await setup({ grokBot: [bot] });
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: 'grokbot-abc', text: '안녕', engine: 'grok' }, c.sink);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't1', message: GROKBOT_SEND_REFUSED }]);
    expect(c.grokCalls).toEqual([]);
    expect(c.store.get('grokbot-abc')).toBeNull();
    expect(c.store.codexEntries()).toEqual([]);
  });

  it('a grokbot- id deck no longer lists: still refused, never a new session', async () => {
    const c = await setup({});
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: 'grokbot-gone', text: '안녕' }, c.sink);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't1', message: GROKBOT_SEND_REFUSED }]);
    expect(c.grokCalls).toEqual([]);
    expect(c.store.codexEntries()).toEqual([]);
  });
});

describe('TurnRunner: continuing an imported Grok CLI session', () => {
  it('resumes it by id in its real cwd with its model / effort, then stores it as deck\'s', async () => {
    const c = await setup({ grok: [entry({ sessionId: 'g-1', grokModel: 'grok-4.6', grokEffort: 'low' })] });
    await c.runner.run({ turnId: 't1', cwd: '/elsewhere', sessionId: 'g-1', text: '이어서 해줘' }, c.sink);
    expect(c.grokCalls).toHaveLength(1);
    expect(c.grokCalls[0]).toMatchObject({ resumeSessionId: 'g-1', cwd: work, model: 'grok-4.6', effort: 'low', prompt: '이어서 해줘' });
    expect(c.msgs.find((m) => m.type === 'turn_result')).toMatchObject({ ok: true, sessionId: 'g-1' });
    expect(c.msgs.some((m) => m.type === 'turn_notice')).toBe(false);
    expect(c.store.get('g-1')).toMatchObject({ engine: 'grok', grokSessionId: 'g-1', cwd: work, title: '터미널 대화' });
  });

  it('held by a terminal grok (same id): refused; a grok in the same folder only warns', async () => {
    const held = await setup({ grok: [entry({ sessionId: 'g-1' })] }, { holders: { grokHeldBy: (id) => (id === 'g-1' ? 'other' : null) } });
    await held.runner.run({ turnId: 't1', cwd: work, sessionId: 'g-1', text: 'x' }, held.sink);
    expect(held.msgs).toEqual([{ type: 'error', turnId: 't1', message: GROK_HELD_NOTICE }]);
    expect(held.grokCalls).toEqual([]);
    const near = await setup({ grok: [entry({ sessionId: 'g-1' })] }, { holders: { grokHeldBy: () => null, grokCwdHeld: (cwd) => cwd === work } });
    await near.runner.run({ turnId: 't1', cwd: work, sessionId: 'g-1', text: 'x' }, near.sink);
    expect(near.grokCalls).toHaveLength(1);
    expect(near.msgs.find((m) => m.type === 'turn_notice')).toMatchObject({ message: expect.stringContaining('터미널 대화') });
  });

  it('a deck-owned Grok session a terminal grok resumed meanwhile: refused', async () => {
    let holding = false;
    const c = await setup({ grok: [entry({ sessionId: 'g-1' })] }, { holders: { grokHeldBy: (id) => (holding && id === 'g-1' ? 'other' : null) } });
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: 'g-1', text: 'x' }, c.sink);
    expect(c.store.get('g-1')).toMatchObject({ engine: 'grok' });
    holding = true;
    c.msgs.length = 0;
    await c.runner.run({ turnId: 't2', cwd: work, sessionId: 'g-1', text: 'y' }, c.sink);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't2', message: GROK_HELD_NOTICE }]);
    expect(c.grokCalls).toHaveLength(1);
  });

  it('the holder list is rescanned (TTL ignored) right before the send: a grok that just opened the session refuses it', async () => {
    let holding = false;
    const forced: unknown[] = [];
    const c = await setup({ grok: [entry({ sessionId: 'g-1' })] }, { holders: { grokHeldBy: (id) => (holding && id === 'g-1' ? 'other' : null), refresh: async (opts) => { forced.push(opts); holding = true; return true; } } });
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: 'g-1', text: 'x' }, c.sink);
    expect(forced).toEqual([{ force: true }]);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't1', message: GROK_HELD_NOTICE }]);
    expect(c.grokCalls).toEqual([]);
  });

  it('a failed rescan keeps the last answer: held stays refused, free stays sendable', async () => {
    const fail = async () => { throw new Error('ps failed'); };
    const held = await setup({ grok: [entry({ sessionId: 'g-1' })] }, { holders: { grokHeldBy: () => 'other', refresh: fail } });
    await held.runner.run({ turnId: 't1', cwd: work, sessionId: 'g-1', text: 'x' }, held.sink);
    expect(held.msgs).toEqual([{ type: 'error', turnId: 't1', message: GROK_HELD_NOTICE }]);
    const free = await setup({ grok: [entry({ sessionId: 'g-1' })] }, { holders: { grokHeldBy: () => null, refresh: fail } });
    await free.runner.run({ turnId: 't1', cwd: work, sessionId: 'g-1', text: 'x' }, free.sink);
    expect(free.grokCalls).toHaveLength(1);
  });

  it('folder gone: refused with the cwd-missing notice', async () => {
    const c = await setup({ grok: [entry({ sessionId: 'g-1', cwd: path.join(base, 'gone'), cwdMissing: true })] });
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: 'g-1', text: 'x' }, c.sink);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't1', message: expect.stringContaining(path.join(base, 'gone')) }]);
    expect(c.grokCalls).toEqual([]);
  });
});

describe('TurnRunner: continuing an imported agy conversation', () => {
  it('resumes it with its id on its account, warning when agy wrote it moments ago', async () => {
    const c = await setup({ gemini: [entry({ sessionId: 'conv-1', engine: 'gemini', account: 'g2', title: 'agy 대화' })], age: 0 });
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: 'conv-1', text: '계속' }, c.sink);
    expect(c.geminiCalls).toHaveLength(1);
    expect(c.geminiCalls[0]).toMatchObject({ account: 'g2', resumeSessionId: 'conv-1', cwd: work, prompt: '계속' });
    expect(c.msgs.find((m) => m.type === 'turn_notice')).toMatchObject({ message: expect.stringContaining('agy 대화') });
    expect(c.store.get('conv-1')).toMatchObject({ engine: 'gemini', account: 'g2', cwd: work });
  });
});

describe('TurnRunner: an agy conversation agy is running right now', () => {
  it('refused with the running notice, no engine call, not stored', async () => {
    const c = await setup({ gemini: [entry({ sessionId: 'conv-1', engine: 'gemini', account: 'g2', title: 'agy 대화' })], geminiHeld: GEMINI_RUNNING_NOTICE });
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: 'conv-1', text: '계속' }, c.sink);
    expect(c.msgs).toEqual([{ type: 'error', turnId: 't1', message: GEMINI_RUNNING_NOTICE }]);
    expect(c.geminiCalls).toEqual([]);
    expect(c.store.get('conv-1')).toBeFalsy();
  });

  it('an old RUNNING row (no held reason) only warns and goes through', async () => {
    const c = await setup({ gemini: [entry({ sessionId: 'conv-1', engine: 'gemini', account: 'g2', title: 'agy 대화' })], age: 0, geminiHeld: null });
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: 'conv-1', text: '계속' }, c.sink);
    expect(c.geminiCalls).toHaveLength(1);
    expect(c.msgs.find((m) => m.type === 'turn_notice')).toBeTruthy();
  });
});

describe('SessionIndex: import lists', () => {
  it('ids of running new-session turns count as deck\'s own: an agy rescan does not list them twice', async () => {
    const c = await setup({ gemini: [entry({ sessionId: 'conv-new', engine: 'gemini', account: 'g1' }), entry({ sessionId: 'conv-1', engine: 'gemini', account: 'g1' })] });
    const ids = (own?: string[]) => c.index.projects(c.store.codexEntries(), own ? { own } : undefined).flatMap((p) => p.sessions).map((s) => s.sessionId).sort();
    expect(ids()).toEqual(['conv-1', 'conv-new']);
    expect(ids(['conv-new'])).toEqual(['conv-1']);
  });


  it('merges Grok / agy / Grok Bot imports into projects and drops ids deck owns', async () => {
    const c = await setup({ grok: [entry({ sessionId: 'g-1' })], gemini: [entry({ sessionId: 'conv-1', engine: 'gemini', account: 'g1' })], grokBot: [entry({ sessionId: 'grokbot-a', source: 'grokbot', readOnly: true })] });
    const ids = () => c.index.projects(c.store.codexEntries()).flatMap((p) => p.sessions).map((s) => [s.sessionId, !!s.imported]);
    expect(ids().sort()).toEqual([['conv-1', true], ['g-1', true], ['grokbot-a', true]]);
    expect(c.index.importOf('grokbot-a')).toMatchObject({ source: 'grokbot' });
    await c.runner.run({ turnId: 't1', cwd: work, sessionId: 'g-1', text: 'x' }, c.sink);
    expect(ids().filter(([id]) => id === 'g-1')).toEqual([['g-1', false]]);
  });
});
