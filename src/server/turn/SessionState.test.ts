import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStateStore, isCodexState } from './SessionState';

describe('SessionStateStore', () => {
  it('persists and reloads states; missing file is empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    expect(s.get('x')).toBeNull();
    await s.set({ sessionId: 'x', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' });
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toEqual({ sessionId: 'x', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps entries whose account or pin is not a configured account (the file is not checked against the registry)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const gone = { sessionId: 'x', cwd: '/w', account: 'zz', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' as const, accountPin: 'old' };
    const kept = { sessionId: 'y', cwd: '/w', account: 'b', projectDir: '/q', lastTurnAtMs: 6, justCompacted: false, defaultModel: 'opus' as const };
    const s = new SessionStateStore(file);
    await s.load();
    await s.set(gone);
    await s.set(kept);
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toEqual(gone);
    expect(s2.get('y')).toEqual(kept);
  });

  it('account pin: persisted across reload, kept by later set() calls, cleared with null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    const base = { sessionId: 'x', cwd: '/w', account: 'b' as const, projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' as const };
    expect(await s.setAccountPin('x', 'c')).toBe(false);
    await s.set({ ...base, accountPin: 'a' });
    expect(s.get('x')).toMatchObject({ accountPin: 'a' });
    expect(await s.setAccountPin('x', 'c')).toBe(true);
    // A turn writing a state it read before the change (stale pin, or none) does not undo it.
    await s.set({ ...base, lastTurnAtMs: 9, accountPin: 'a' });
    await s.set({ ...base, lastTurnAtMs: 10 });
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toMatchObject({ lastTurnAtMs: 10, accountPin: 'c' });
    expect(await s2.setAccountPin('x', null)).toBe(true);
    expect(s2.get('x')).not.toHaveProperty('accountPin');
  });

  it('concurrent set() calls on different sessions all persist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    await Promise.all(ids.map((id) => s.set({ sessionId: id, cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'opus' })));
    const s2 = new SessionStateStore(file);
    await s2.load();
    for (const id of ids) expect(s2.get(id)?.sessionId).toBe(id);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a corrupt file is preserved as .bad-<ts> and the store starts empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    await fs.writeFile(file, '{"x": {"sessionId": "x", tru');
    const s = new SessionStateStore(file);
    await s.load();
    expect(s.get('x')).toBeNull();
    const bad = (await fs.readdir(dir)).filter((f) => f.startsWith('session-state.json.bad-'));
    expect(bad).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, bad[0]!), 'utf8')).toBe('{"x": {"sessionId": "x", tru');
  });
});

describe('commander state (1단계 상태 보존)', () => {
  const commander = {
    goal: '목표', done: '완료 조건', maxTurns: 20, hop: 0, epoch: 1, status: 'armed' as const, startedAtMs: 1000,
    budget: { maxAutoTurns: 20, autoTurnsUsed: 0, maxTokens: 2_000_000, tokensUsed: 0, maxWallClockMs: 43_200_000, maxInternalRetries: 5, internalRetriesUsed: 0 },
    lastVerdicts: [], processedDigestIds: [], signatures: [],
  };

  it('setCommander persists across reload and clears with undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    const base = { sessionId: 'x', cwd: '/w', account: 'b' as const, projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' as const };
    expect(await s.setCommander('x', commander)).toBe(false);
    await s.set(base);
    expect(await s.setCommander('x', commander)).toBe(true);
    expect(s.get('x')).toMatchObject({ commander });
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toMatchObject({ commander });
    expect(await s2.setCommander('x', undefined)).toBe(true);
    expect(s2.get('x')).not.toHaveProperty('commander');
  });

  it('set() keeps the stored commander and drops any commander carried by the incoming state (change only via setCommander)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    const base = { sessionId: 'x', cwd: '/w', account: 'b' as const, projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' as const };
    // A new entry's incoming commander is dropped too.
    await s.set({ ...base, commander });
    expect(s.get('x')?.commander).toBeUndefined();
    await s.setCommander('x', commander);
    // A turn writing a fresh state object (no commander field at all, as TurnRunner rebuilds it) does not drop it.
    await s.set({ ...base, lastTurnAtMs: 9 });
    expect(s.get('x')).toMatchObject({ lastTurnAtMs: 9, commander });
    // Nor does a turn that happens to carry its own (stale) commander value win over the stored one.
    const other = { ...commander, epoch: 99 };
    await s.set({ ...base, lastTurnAtMs: 10, commander: other });
    expect(s.get('x')).toMatchObject({ lastTurnAtMs: 10, commander });
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toMatchObject({ commander });
  });

  it('TurnRunner 가 턴 끝마다 상태를 스프레드 없이 새로 만드는 지점(TurnRunner.ts ~1680행)을 흉내내도 commander 가 사라지지 않는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    await s.set({ sessionId: 'x', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' });
    await s.setCommander('x', commander);
    // Mirrors the literal object TurnRunner builds at ~1680: no `...state` spread, just the fields it knows about.
    await s.set({
      sessionId: 'x',
      cwd: '/w',
      account: 'b',
      projectDir: '/p',
      lastTurnAtMs: 7,
      justCompacted: false,
      defaultModel: 'opus',
      mode: 'default',
    });
    expect(s.get('x')).toMatchObject({ lastTurnAtMs: 7, mode: 'default', commander });
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toMatchObject({ commander });
  });

  it('a malformed commander on disk is dropped while the rest of the session state is kept', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    await fs.writeFile(file, JSON.stringify({
      x: { sessionId: 'x', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus', commander: { goal: '목표만 있고 나머지는 없음' } },
    }));
    const s = new SessionStateStore(file);
    await s.load();
    expect(s.get('x')).not.toHaveProperty('commander');
    expect(s.get('x')).toMatchObject({ sessionId: 'x', lastTurnAtMs: 5 });
  });
});

describe('Codex session state (D4)', () => {
  it('round-trips a codex state, lists it for the sidebar as account gpt, and Plan 1 states stay claude', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-state-codex-'));
    const file = path.join(base, 'state.json');
    await fs.writeFile(file, JSON.stringify({ old: { sessionId: 'old', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' } }));
    const store = new SessionStateStore(file);
    await store.load();
    const old = store.get('old');
    expect(old && isCodexState(old)).toBe(false);
    await store.set({ engine: 'codex', sessionId: 'tid', cwd: '/w/gpt', lastTurnAtMs: null, justCompacted: false, defaultModel: 'gpt-6-astra', sandbox: 'workspace-write', rolloutFile: '/r/2026/09/30/rollout-x-tid.jsonl', createdAtMs: 1000, title: '첫 질문' });
    const again = new SessionStateStore(file);
    await again.load();
    const s = again.get('tid');
    expect(s && isCodexState(s) ? s.sandbox : null).toBe('workspace-write');
    expect(again.list()).toHaveLength(2);
    expect(again.codexEntries()).toEqual([{ sessionId: 'tid', account: 'gpt', engine: 'codex', sandbox: 'workspace-write', cwd: '/w/gpt', projectDir: '/r/2026/09/30', file: '/r/2026/09/30/rollout-x-tid.jsonl', title: '첫 질문', lastModified: 1000, sizeBytes: 0 }]);
    await fs.rm(base, { recursive: true, force: true });
  });
});

describe('pendingRetry.commanderHop (보안 #3)', () => {
  it('a booking with a valid hop loads as is; one whose hop is not a positive integer is dropped whole (fail closed)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const base = { cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' };
    const retry = { text: 'go', atMs: 9, hops: 1 };
    await fs.writeFile(file, JSON.stringify({
      ok: { ...base, sessionId: 'ok', pendingRetry: { ...retry, commanderHop: 3 } },
      plain: { ...base, sessionId: 'plain', pendingRetry: retry },
      ...Object.fromEntries(['x', 0, -1, 1.5, null].map((h, i) => [`bad${i}`, { ...base, sessionId: `bad${i}`, pendingRetry: { ...retry, commanderHop: h } }])),
    }));
    const s = new SessionStateStore(file);
    await s.load();
    expect(s.get('ok')?.pendingRetry).toEqual({ ...retry, commanderHop: 3 });
    expect(s.get('plain')?.pendingRetry).toEqual(retry);
    for (let i = 0; i < 5; i++) {
      expect(s.get(`bad${i}`)).toMatchObject({ sessionId: `bad${i}` });
      expect(s.get(`bad${i}`)).not.toHaveProperty('pendingRetry');
    }
  });
});
