import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '../../shared/protocol';
import type { EngineEvent } from '../engine/Engine';
import type { CodexTurnRequest } from '../engine/CodexEngine';
import type { GeminiTurnRequest } from '../engine/GeminiEngine';
import type { GrokTurnRequest } from '../engine/GrokEngine';
import { StubEngine } from '../engine/StubEngine';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { TurnRunner, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';
import { CONCISE_STYLE_PROMPT, conciseStylePrompt } from '../../shared/concise';
import { DECK_CHOICES_PROMPT } from '../../shared/choices';
import { deckAddendum, memoryNote } from '../../shared/memory';

let base: string;
beforeEach(async () => { base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-tr-context-'))); });
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

/** The next engine turn ends failed (then resets). */
let failNext = false;
const ok = (sid: string): EngineEvent[] => {
  const pass = !failNext;
  failNext = false;
  return [
    { kind: 'init', sessionId: sid, model: 'm' },
    { kind: 'delta', text: 'ok' },
    { kind: 'result', sessionId: sid, ok: pass, text: 'ok', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' },
  ];
};

async function setup(memo: { text: string }) {
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const codexCalls: CodexTurnRequest[] = [];
  const geminiCalls: GeminiTurnRequest[] = [];
  const grokCalls: GrokTurnRequest[] = [];
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  const runner = new TurnRunner({
    accounts: testRegistry(), engine: new StubEngine(async () => { throw new Error('no Claude turn expected'); }), attachments: null, usage, index, store,
    cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codexSessionsRoot: path.join(base, 'codex'),
    memory: () => memo.text,
    codex: { async *runTurn(req) { codexCalls.push(req); for (const e of ok(req.resumeThreadId ?? 'cx-new')) yield e; } },
    gemini: { loggedIn: () => true, engine: { async *runTurn(req) { geminiCalls.push(req); for (const e of ok(req.resumeSessionId ?? 'gm-new')) yield e; } } },
    grok: { async *run(req) { grokCalls.push(req); await req.onSessionId?.(req.resumeSessionId ?? 'gk-new'); for (const e of ok(req.resumeSessionId ?? 'gk-new')) yield e; } },
  });
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { runner, codexCalls, geminiCalls, grokCalls, msgs, sink };
}

const work = () => base;

describe('TurnRunner · deck context for GPT, Gemini and Grok', () => {
  it('style variants: Claude keeps AskUserQuestion; the others drop it and get the deck-choices note', () => {
    expect(conciseStylePrompt('claude')).toBe(CONCISE_STYLE_PROMPT);
    // A 백그라운드 작업 turn: nobody answers a question card, so Claude's note drops the line too.
    expect(conciseStylePrompt('claude', { task: true })).toBe(conciseStylePrompt('codex'));
    for (const e of ['codex', 'gemini', 'grok'] as const) {
      expect(conciseStylePrompt(e)).not.toContain('AskUserQuestion');
      expect(conciseStylePrompt(e).split('\n')).toHaveLength(CONCISE_STYLE_PROMPT.split('\n').length - 1);
    }
  });

  it('Codex: style + deck-choices + 메모 as developer instructions on every turn; never in the prompt or the pane', async () => {
    const memo = { text: '배포는 금요일에 하지 않음' };
    const c = await setup(memo);
    await c.runner.run({ turnId: 't1', cwd: work(), sessionId: null, text: '안녕', engine: 'codex', concise: true }, c.sink);
    await c.runner.run({ turnId: 't2', cwd: work(), sessionId: 'cx-new', text: '계속', engine: 'codex' }, c.sink);
    await c.runner.run({ turnId: 't3', cwd: work(), sessionId: 'cx-new', text: '인계', engine: 'codex', handoff: true }, c.sink);
    expect(c.codexCalls.map((r) => r.prompt)).toEqual(['안녕', '계속', '인계']);
    expect(c.codexCalls[0]!.developerInstructions).toBe(deckAddendum({ style: conciseStylePrompt('codex'), choices: DECK_CHOICES_PROMPT, memory: memo.text }));
    expect(c.codexCalls[1]!.developerInstructions).toBe(deckAddendum({ choices: DECK_CHOICES_PROMPT, memory: memo.text }));
    expect(c.codexCalls[2]!.developerInstructions).toBeUndefined();
    expect(JSON.stringify(c.msgs)).not.toContain('금요일');
  });

  it('Gemini: a hidden <system-reminder> on the first turn, again only when the context changes', async () => {
    const memo = { text: 'A' };
    const c = await setup(memo);
    await c.runner.run({ turnId: 't1', cwd: work(), sessionId: null, text: '첫 질문', engine: 'gemini' }, c.sink);
    await c.runner.run({ turnId: 't2', cwd: work(), sessionId: 'gm-new', text: '둘째', engine: 'gemini' }, c.sink);
    memo.text = 'B';
    await c.runner.run({ turnId: 't3', cwd: work(), sessionId: 'gm-new', text: '셋째', engine: 'gemini' }, c.sink);
    const [p1, p2, p3] = c.geminiCalls.map((r) => r.prompt);
    expect(p1).toBe(`<system-reminder>\n${deckAddendum({ choices: DECK_CHOICES_PROMPT, memory: 'A' })}\n</system-reminder>\n\n첫 질문`);
    expect(p2).toBe('둘째');
    expect(p3!.startsWith('<system-reminder>\n')).toBe(true);
    expect(p3).toContain(memoryNote('B')!);
    expect(p3!.endsWith('</system-reminder>\n\n셋째')).toBe(true);
    // The pane and the stored title only ever see the user's own words.
    expect(JSON.stringify(c.msgs)).not.toContain('system-reminder');
  });

  it('Grok: the context is its own ACP block (context), the prompt untouched; sent once per session until it changes', async () => {
    const memo = { text: '' };
    const c = await setup(memo);
    await c.runner.run({ turnId: 't1', cwd: work(), sessionId: null, text: '하나', engine: 'grok', concise: true }, c.sink);
    await c.runner.run({ turnId: 't2', cwd: work(), sessionId: 'gk-new', text: '둘', engine: 'grok', concise: true }, c.sink);
    await c.runner.run({ turnId: 't3', cwd: work(), sessionId: 'gk-new', text: '셋', engine: 'grok' }, c.sink);
    expect(c.grokCalls.map((r) => r.prompt)).toEqual(['하나', '둘', '셋']);
    expect(c.grokCalls[0]!.context).toBe(deckAddendum({ style: conciseStylePrompt('grok'), choices: DECK_CHOICES_PROMPT }));
    expect(c.grokCalls[1]!.context).toBeUndefined();
    expect(c.grokCalls[2]!.context).toBe(DECK_CHOICES_PROMPT); // 간결 모드 turned off: the context changed
  });

  it('Gemini and Grok: a turn that failed does not count as having delivered the context (sent again next turn)', async () => {
    const c = await setup({ text: 'M' });
    failNext = true;
    await c.runner.run({ turnId: 'g1', cwd: work(), sessionId: null, text: '하나', engine: 'gemini' }, c.sink);
    await c.runner.run({ turnId: 'g2', cwd: work(), sessionId: 'gm-new', text: '둘', engine: 'gemini' }, c.sink);
    await c.runner.run({ turnId: 'g3', cwd: work(), sessionId: 'gm-new', text: '셋', engine: 'gemini' }, c.sink);
    expect(c.geminiCalls.map((r) => r.prompt.startsWith('<system-reminder>'))).toEqual([true, true, false]);
    failNext = true;
    await c.runner.run({ turnId: 'k1', cwd: work(), sessionId: null, text: '하나', engine: 'grok' }, c.sink);
    await c.runner.run({ turnId: 'k2', cwd: work(), sessionId: 'gk-new', text: '둘', engine: 'grok' }, c.sink);
    await c.runner.run({ turnId: 'k3', cwd: work(), sessionId: 'gk-new', text: '셋', engine: 'grok' }, c.sink);
    expect(c.grokCalls.map((r) => r.context !== undefined)).toEqual([true, true, false]);
  });
});
