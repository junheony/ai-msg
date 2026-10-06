import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRegistry, type Account, type AccountSpec } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import type { EngineEvent } from '../engine/Engine';
import { StubEngine, failResult, okResult } from '../engine/StubEngine';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore, type ClaudeSessionState } from './SessionState';
import { TurnRunner, type TurnSink } from './TurnRunner';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const SID = '55555555-5555-4555-8555-555555555555';
const NEW = '66666666-6666-4666-8666-666666666666';
const DIR = '-w-one';
const line = JSON.stringify({ type: 'user', cwd: '/w/one', message: { role: 'user', content: 'seed' } }) + '\n';

const ok = (sid: string): EngineEvent[] => [{ kind: 'init', sessionId: sid, model: 'claude-opus-5-5' }, { kind: 'delta', text: 'ok' }, okResult(sid)];
const of = <T extends ServerMessage['type']>(msgs: ServerMessage[], t: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

/** A temp home with one config dir per account; no usage-deck (every fetch fails). */
async function setup(accounts: AccountSpec[], protectedAccount: Account | null = null, o: { strict?: boolean; engine?: StubEngine } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-accounts-runner-'));
  const reg = buildRegistry({ version: 1, accounts: accounts.map((a) => ({ ...a, configDir: `~/cfg-${a.id}` })) }, { homeDir: base });
  const roots = reg.projectsRoots();
  for (const r of roots) await fs.mkdir(r.dir, { recursive: true });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const index = new SessionIndex({ roots, pinnedFile: path.join(base, 'p.json') });
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => { throw new Error('ECONNREFUSED'); }, now: () => new Date(NOW), accounts: reg, ...(o.strict === undefined ? {} : { strict: o.strict }) });
  await usage.pollOnce();
  const engine = o.engine ?? new StubEngine((call) => ok(call.resumeSessionId ?? NEW));
  const logs: string[] = [];
  const runner = new TurnRunner({
    engine, usage, index, store, accounts: reg, cooldownDir: path.join(base, 'cd'), protectedAccount, auditFile: path.join(base, 'audit.log'),
    projectsRoots: roots, codex: null, attachments: null, codexSessionsRoot: path.join(base, 'codex'), homeAccount: reg.home, now: () => NOW,
    routeLog: (l) => logs.push(l),
  });
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  /** A transcript under `root` and deck state for it on `account`. */
  const seed = async (account: Account, root: string, stored = true): Promise<ClaudeSessionState> => {
    const projectDir = path.join(root, DIR);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, `${SID}.jsonl`), line);
    await fs.utimes(path.join(projectDir, `${SID}.jsonl`), (NOW - 3_600_000) / 1000, (NOW - 3_600_000) / 1000);
    const st: ClaudeSessionState = { sessionId: SID, cwd: '/w/one', account, projectDir, lastTurnAtMs: NOW - 60_000, justCompacted: false, defaultModel: 'opus' };
    if (stored) await store.set(st);
    await index.refresh();
    return st;
  };
  const rootOf = (id: Account) => roots.find((r) => r.id === id)!.dir;
  return { base, reg, runner, engine, store, index, msgs, sink, logs, seed, rootOf };
}

describe('TurnRunner · 뺀 계정(retired)과 설정에 없는 계정', () => {
  it('a retired account: its session stays listed, a turn on it is refused with what to do, nothing runs', async () => {
    const c = await setup([{ id: 'a' }, { id: 'b' }, { id: 'old', retired: true }]);
    await c.seed('old', c.rootOf('old'));
    expect(c.index.lookup(SID)).toMatchObject({ account: 'old' });
    await c.runner.run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(c.engine.calls).toEqual([]);
    const err = of(c.msgs, 'error')[0]?.message ?? '';
    expect(err).toMatch(/OLD 계정은 뺀 계정\(retired\)이라 이 세션을 이어갈 수 없습니다/);
    expect(err).toMatch(/accounts\.json.*"retired".*다시 시작/);
    expect(err).toMatch(/새 세션/);
    expect(c.store.get(SID)).toMatchObject({ account: 'old' });
  });

  it('a retired account: an index-only session and an edit-fork of one are refused the same way', async () => {
    const c = await setup([{ id: 'a' }, { id: 'old', retired: true }]);
    await c.seed('old', c.rootOf('old'), false);
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    await c.runner.run({ turnId: 't2', cwd: '/w/one', sessionId: null, text: 'go', fork: { from: SID, at: 'u1' } }, c.sink);
    expect(c.engine.calls).toEqual([]);
    expect(of(c.msgs, 'error').map((m) => m.turnId)).toEqual(['t1', 't2']);
    for (const m of of(c.msgs, 'error')) expect(m.message).toMatch(/뺀 계정\(retired\)/);
  });

  it('a retired account is never routed to or pinned: new sessions and pins use the active ones', async () => {
    const c = await setup([{ id: 'a' }, { id: 'b' }, { id: 'old', retired: true }], 'a');
    await c.seed('b', c.rootOf('b'));
    expect(await c.runner.setAccountPin(SID, 'old')).toBe(false);
    expect(await c.runner.setAccountPin(SID, 'zz')).toBe(false);
    expect(c.store.get(SID)).not.toHaveProperty('accountPin');
    await c.runner.run({ turnId: 't', cwd: '/w/one', sessionId: null, text: 'go', accountPin: 'old' }, c.sink);
    expect(c.engine.calls.map((x) => x.account)).toEqual(['b']);
    expect(c.logs[0]).toMatch(/잔여량 모름 B, A$/);
    // A pin stored before the account was retired is no pin: the session stays where it is.
    expect(await c.store.setAccountPin(SID, 'old')).toBe(true);
    expect(c.store.get(SID)).toMatchObject({ accountPin: 'old' });
    await c.runner.run({ turnId: 't2', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(c.engine.calls[1]).toMatchObject({ account: 'b', resumeSessionId: SID });
    expect(of(c.msgs, 'error')).toEqual([]);
  });

  it('an account that is not configured any more: the turn is refused with what to do, the stored session is kept and can be deleted', async () => {
    const c = await setup([{ id: 'a' }, { id: 'b' }]);
    const st = await c.seed('zz', path.join(c.base, 'cfg-zz', 'projects'));
    await c.runner.run({ turnId: 't', cwd: '/w/one', sessionId: SID, text: 'go' }, c.sink);
    expect(c.engine.calls).toEqual([]);
    const err = of(c.msgs, 'error')[0]?.message ?? '';
    expect(err).toMatch(/설정에 없는 계정\(ZZ\)의 세션이라 이어갈 수 없습니다/);
    expect(err).toMatch(/accounts\.json.*"id": ?"zz".*다시 시작/);
    expect(c.store.get(SID)).toEqual(st);

    const r = await c.runner.trashSession(SID);
    expect(r.ok).toBe(true);
    expect(await exists(path.join(st.projectDir, `${SID}.jsonl`))).toBe(false);
  });
});

describe('TurnRunner · usage-deck 없이', () => {
  it('one account, also when it is the protected one: a new session and its next turn run on it', async () => {
    for (const protect of [null, 'a'] as const) {
      const c = await setup([{ id: 'a' }], protect);
      await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'go' }, c.sink);
      await c.runner.run({ turnId: 't2', cwd: '/w/one', sessionId: NEW, text: 'again' }, c.sink);
      expect(c.engine.calls.map((x) => [x.account, x.resumeSessionId])).toEqual([['a', null], ['a', NEW]]);
      expect(of(c.msgs, 'error')).toEqual([]);
      expect(of(c.msgs, 'turn_result').map((m) => m.ok)).toEqual([true, true]);
      expect(c.logs[0]).toMatch(/→ A \(Fable 잔여량 모름\(usage-deck 값 없음\) → Opus · 자격 있는 계정 없음 → 잔여량 모름 · A\) · 잔여량 모름 A$/);
    }
  });

  it('several accounts: a new session takes the first account that is neither protected nor home', async () => {
    const c = await setup([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a');
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'go' }, c.sink);
    expect(c.engine.calls.map((x) => x.account)).toEqual(['b']);
  });
});

describe("TurnRunner · usage-deck 을 본 적 없는 설치 (usageSource: 'none')", () => {
  it('with usage-deck expected (the default) a Fable turn on unknown usage runs on Opus', async () => {
    const c = await setup([{ id: 'a' }], 'a');
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'go', model: 'fable' }, c.sink);
    expect(c.engine.calls.map((x) => [x.account, x.model])).toEqual([['a', 'opus']]);
  });

  it('a Fable turn runs as Fable on the only account, also the protected one, and so does the next turn', async () => {
    for (const protect of [null, 'a'] as const) {
      const c = await setup([{ id: 'a' }], protect, { strict: false });
      await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'go', model: 'fable' }, c.sink);
      await c.runner.run({ turnId: 't2', cwd: '/w/one', sessionId: NEW, text: 'again' }, c.sink);
      expect(c.engine.calls.map((x) => [x.account, x.model])).toEqual([['a', 'fable'], ['a', 'fable']]);
      expect(of(c.msgs, 'turn_result').map((m) => [m.ok, m.badge?.model, m.badge?.modelNote ?? null])).toEqual([[true, 'fable', null], [true, 'fable', null]]);
      expect(c.logs[0]).toMatch(/→ A \(자격 있는 계정 없음 → 잔여량 모름 · A\) · 잔여량 모름 A$/);
    }
  });

  it('a limit failure cools that account down and the Fable turn moves to the next one; the next new session skips it', async () => {
    const engine = new StubEngine((call, n) => (n === 0
      ? [{ kind: 'rate_limit', info: { status: 'rejected', fiveHour: null, weekly: null } }, failResult('limit')]
      : ok(call.resumeSessionId ?? NEW)));
    const c = await setup([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a', { strict: false, engine });
    await c.runner.run({ turnId: 't1', cwd: '/w/one', sessionId: null, text: 'go', model: 'fable' }, c.sink);
    expect(engine.calls.map((x) => [x.account, x.model])).toEqual([['b', 'fable'], ['c', 'fable']]);
    expect(of(c.msgs, 'turn_result').at(-1)).toMatchObject({ ok: true, badge: { account: 'c', model: 'fable' } });
    await c.runner.run({ turnId: 't2', cwd: '/w/two', sessionId: null, text: 'go', model: 'fable' }, c.sink);
    expect(engine.calls[2]).toMatchObject({ account: 'c', model: 'fable' });
    expect(c.logs.at(-1)).toMatch(/잔여량 모름 C, A · 제외 B 잔여량 정보 없음$/);
  });
});
