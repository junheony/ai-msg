import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import type { EngineEvent } from '../engine/Engine';
import { StubEngine, okResult } from '../engine/StubEngine';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const PARENT = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';

async function setup(engine: StubEngine, extra: Partial<TurnRunnerDeps> = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-fork-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const index = new SessionIndex({ roots, pinnedFile: path.join(base, 'projects.json') });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), now: () => new Date(NOW) });
  const runner = new TurnRunner({
    engine, index, store, usage, cooldownDir: path.join(base, 'cooldown'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: roots,
    codex: null, attachments: null, codexSessionsRoot: path.join(base, 'codex'), now: () => NOW, maxRetries: 0, ...extra,
  });
  const dir = path.join(roots.c, '-w-one');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${PARENT}.jsonl`);
  await fs.writeFile(file, [{ type: 'user', uuid: 'u0', parentUuid: null, cwd: '/w/one', message: { role: 'user', content: '첫 질문' } }, { type: 'assistant', uuid: 'a0', parentUuid: 'u0', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: '답' }] } }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  await index.refresh();
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { runner, store, msgs, sink, dir, file };
}

const ok = (sid: string): EngineEvent[] => [{ kind: 'init', sessionId: sid, model: 'claude-opus-5-5' }, { kind: 'delta', text: '새 답' }, okResult(sid)];

describe('TurnRunner · 메시지 편집 갈래', () => {
  it('resumes the parent as a fork at the branch point; the new id is reported and stored with the parent’s pin, model and grants', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const c = await setup(eng);
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: NOW - 3_600_000, justCompacted: false, defaultModel: 'sonnet', accountPin: 'c', allowRules: ['Bash(ls:*)'] });
    const before = await fs.readFile(c.file, 'utf8');
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: '고친 질문', fork: { from: PARENT, at: 'a0' } }, c.sink);

    expect(eng.calls).toHaveLength(1);
    expect(eng.calls[0]).toMatchObject({ resumeSessionId: PARENT, forkAt: 'a0', prompt: '고친 질문', account: 'c', model: 'sonnet', allowRules: ['Bash(ls:*)'] });
    const started = c.msgs.find((m) => m.type === 'turn_started');
    expect(started).toMatchObject({ sessionId: null, reason: expect.stringContaining('메시지 편집') });
    // Nothing of the turn is ever addressed to the parent.
    expect(c.msgs.some((m) => 'sessionId' in m && m.sessionId === PARENT)).toBe(false);
    expect(c.msgs.find((m) => m.type === 'turn_result')).toMatchObject({ ok: true, sessionId: CHILD });
    expect(c.store.get(CHILD)).toMatchObject({ account: 'c', accountPin: 'c', defaultModel: 'sonnet', allowRules: ['Bash(ls:*)'], cwd: '/w/one' });
    expect(c.store.get(PARENT)).toMatchObject({ lastTurnAtMs: NOW - 3_600_000 });
    expect(await fs.readFile(c.file, 'utf8')).toBe(before);
  });

  it('the fork inherits the parent’s mode and announces it once the fork has an id', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const told: [string, string][] = [];
    const c = await setup(eng, { onPermissionMode: (s, m) => told.push([s, m]) });
    await c.store.set({ sessionId: PARENT, cwd: '/w/one', account: 'c', projectDir: c.dir, lastTurnAtMs: null, justCompacted: false, defaultModel: 'sonnet', mode: 'plan' });
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(eng.calls[0]?.permissionMode).toBe('plan');
    expect(c.store.get(CHILD)).toMatchObject({ mode: 'plan' });
    expect(told).toEqual([[CHILD, 'plan']]);
  });

  it('works for an index-only parent too', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const c = await setup(eng);
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', fork: { from: PARENT, at: 'a0' } }, c.sink);
    expect(eng.calls[0]).toMatchObject({ resumeSessionId: PARENT, forkAt: 'a0' });
    expect(c.store.get(CHILD)).toMatchObject({ account: 'c' });
  });

  it('refuses a parent that is no Claude session', async () => {
    const eng = new StubEngine(() => ok(CHILD));
    const c = await setup(eng);
    await c.store.set({ engine: 'codex', sessionId: 'thread-1', cwd: '/w/one', lastTurnAtMs: null, justCompacted: false, defaultModel: 'gpt-6-sol', sandbox: 'read-only', rolloutFile: null, createdAtMs: NOW, title: 't' });
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'x', fork: { from: 'thread-1', at: 'a0' } }, c.sink);
    expect(eng.calls).toHaveLength(0);
    expect(c.msgs[0]).toMatchObject({ type: 'error', message: expect.stringContaining('편집할 Claude 세션') });
  });
});
