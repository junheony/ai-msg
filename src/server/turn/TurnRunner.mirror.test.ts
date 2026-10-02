import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import { StubEngine, okResult } from '../engine/StubEngine';
import type { TurnRequest } from '../engine/Engine';
import { SessionIndex } from '../sessions/SessionIndex';
import { moveSession } from '../sessions/SessionMover';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore, type ClaudeSessionState } from './SessionState';
import { TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const SID = '22222222-2222-4222-8222-222222222222';
const DIR = '-w-one';
const CWD = '/w/one';

function card(id: string, s: number, w: number, f: number, resetH: number) {
  const resetsAt = new Date(NOW + resetH * 3_600_000).toISOString();
  return { id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [
    { label: 'Session (5h)', used: s, resetsAt }, { label: 'Weekly (7d)', used: w, resetsAt }, { label: 'Fable (7d)', used: f, resetsAt } ] };
}

const line = (text: string) => JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: text } }) + '\n';

type Ctx = { base: string; roots: Record<Account, string>; deps: TurnRunnerDeps; runner: TurnRunner; eng: StubEngine; msgs: ServerMessage[]; sink: TurnSink; seen: string[] };

/** The stub "CLI" appends one line to the session's jsonl in the profile it runs on (like a real turn). */
async function setup(): Promise<Ctx> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-mirror-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const state = { cards: [card('claude:main', 13, 7, 0, 154), card('claude:second', 2, 3, 4, 84), card('claude:third', 0, 91, 27, 36)] };
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => state }), now: () => new Date(NOW) });
  await usage.pollOnce();
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const seen: string[] = [];
  const eng = new StubEngine(async (req: TurnRequest, call) => {
    const sid = req.resumeSessionId ?? SID;
    const dir = path.join(roots[req.account], DIR);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    seen.push(await fs.readFile(file, 'utf8').catch(() => ''));
    await fs.appendFile(file, line(`deck turn ${call} on ${req.account}`));
    return [{ kind: 'init', sessionId: sid, model: 'm', cwd: CWD }, okResult(sid)];
  });
  const deps: TurnRunnerDeps = {
    engine: eng, usage, index: new SessionIndex({ roots, pinnedFile: path.join(base, 'p.json') }), store,
    cooldownDir: path.join(base, 'cooldown'), protectedAccount: 'a', auditFile: path.join(base, 'audit.log'),
    projectsRoots: roots, codex: null, attachments: null, codexSessionsRoot: path.join(base, 'codex'),
    homeAccount: 'a', now: () => NOW, maxRetries: 0,
  };
  const msgs: ServerMessage[] = [];
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: new AbortController().signal };
  return { base, roots, deps, runner: new TurnRunner(deps), eng, msgs, sink, seen };
}

const fileOf = (c: Ctx, a: Account, dir = DIR) => path.join(c.roots[a], dir, `${SID}.jsonl`);
const read = (f: string) => fs.readFile(f, 'utf8');
const notices = (c: Ctx) => c.msgs.filter((m): m is Extract<ServerMessage, { type: 'turn_notice' }> => m.type === 'turn_notice').map((m) => m.message);

async function put(c: Ctx, a: Account, content: string, mtimeMs?: number, dir = DIR) {
  await fs.mkdir(path.join(c.roots[a], dir), { recursive: true });
  await fs.writeFile(fileOf(c, a, dir), content);
  if (mtimeMs !== undefined) await fs.utimes(fileOf(c, a, dir), mtimeMs / 1000, mtimeMs / 1000);
}

/** A session deck last ran on B (warm, so routing keeps it there). */
async function onB(c: Ctx) {
  await c.deps.store.set({ sessionId: SID, cwd: CWD, account: 'b', projectDir: path.join(c.roots.b, DIR), lastTurnAtMs: NOW - 60_000, justCompacted: false, defaultModel: 'opus' });
}

async function turn(c: Ctx, sessionId: string | null, turnId = 't') {
  await c.runner.run({ turnId, cwd: CWD, sessionId, text: 'go' }, c.sink);
  await c.runner.mirrorsSettled();
}

describe('TurnRunner: home (A) write-back', () => {
  it('a deck-born session run on B is mirrored into A; the B source is never written by the mirror', async () => {
    const c = await setup();
    let srcAfterTurn = '';
    let srcStat: { mtimeMs: number; ino: number } | null = null;
    const runP = c.runner.run({ turnId: 't', cwd: CWD, sessionId: null, text: 'go' }, c.sink).then(async () => {
      srcAfterTurn = await read(fileOf(c, 'b'));
      srcStat = await fs.stat(fileOf(c, 'b'));
    });
    await runP;
    await c.runner.mirrorsSettled();
    expect(c.eng.calls[0]).toMatchObject({ account: 'b' });
    expect(await read(fileOf(c, 'a'))).toBe(srcAfterTurn);
    const after = await fs.stat(fileOf(c, 'b'));
    expect(await read(fileOf(c, 'b'))).toBe(srcAfterTurn);
    expect({ mtimeMs: after.mtimeMs, ino: after.ino }).toEqual({ mtimeMs: srcStat!.mtimeMs, ino: srcStat!.ino });
    expect(notices(c)).toEqual([]);
  });

  it('an older A copy (byte-prefix) is brought up to date after a B turn', async () => {
    const c = await setup();
    await put(c, 'a', line('one'), NOW - 3_600_000);
    await put(c, 'b', line('one') + line('two'), NOW - 60_000);
    await onB(c);
    await turn(c, SID);
    expect(c.eng.calls[0]).toMatchObject({ account: 'b', resumeSessionId: SID });
    const b = await read(fileOf(c, 'b'));
    expect(b.startsWith(line('one') + line('two'))).toBe(true);
    expect(await read(fileOf(c, 'a'))).toBe(b);
    expect(notices(c)).toEqual([]);
  });

  it('an A copy Desktop continued on its own is left untouched, with a notice; B (newer) is resumed', async () => {
    const c = await setup();
    const desktop = line('one') + line('desktop went on');
    await put(c, 'a', desktop, NOW - 3_600_000);
    await put(c, 'b', line('one') + line('deck went on'), NOW - 60_000);
    await onB(c);
    await turn(c, SID);
    expect(c.eng.calls[0]).toMatchObject({ account: 'b' });
    expect(await read(fileOf(c, 'a'))).toBe(desktop);
    const n = notices(c);
    expect(n.some((m) => m.startsWith('Desktop 에서 따로 이어진 대화가 있어 갈라졌습니다'))).toBe(true);
    // A second turn does not repeat the same notice.
    const before = n.length;
    await turn(c, SID, 't2');
    expect(notices(c).length).toBe(before);
    expect(await read(fileOf(c, 'a'))).toBe(desktop);
  });

  it('next turn: when Desktop extended the A copy (B is its prefix), deck resumes from the longer copy', async () => {
    const c = await setup();
    const shared = line('one') + line('two');
    const longer = shared + line('continued in Desktop');
    await put(c, 'b', shared, NOW - 3_600_000);
    await put(c, 'a', longer, NOW - 60_000);
    await onB(c);
    await turn(c, SID);
    // Pulled into B before the CLI ran there: routing unchanged, and the CLI saw Desktop's turn.
    expect(c.eng.calls[0]).toMatchObject({ account: 'b', resumeSessionId: SID });
    expect(c.seen[0]).toBe(longer);
    expect((c.deps.store.get(SID) as ClaudeSessionState).account).toBe('b');
    // ...and the turn's result was written back over the (prefix) A copy.
    const b = await read(fileOf(c, 'b'));
    expect(b.startsWith(longer)).toBe(true);
    expect(await read(fileOf(c, 'a'))).toBe(b);
    expect(notices(c)).toEqual([]);
  });

  it('truly diverged with A newer: continues from A, tells the user, leaves the B copy untouched', async () => {
    const c = await setup();
    const deckCopy = line('one') + line('deck went on');
    await put(c, 'b', deckCopy, NOW - 3_600_000);
    await put(c, 'a', line('one') + line('desktop went on'), NOW - 60_000);
    await onB(c);
    await turn(c, SID);
    expect(c.eng.calls[0]).toMatchObject({ account: 'a' });
    expect(c.seen[0]).toBe(line('one') + line('desktop went on'));
    expect(await read(fileOf(c, 'b'))).toBe(deckCopy);
    expect(notices(c).some((m) => m.includes('갈라졌습니다') && m.includes('A 계정 사본으로 이어가고'))).toBe(true);
  });

  it('Desktop extended A during a turn that wrote nothing on B: no divergence notice, A untouched, the next turn pulls it', async () => {
    const c = await setup();
    await put(c, 'a', line('one'), NOW - 3_600_000);
    await put(c, 'b', line('one'), NOW - 60_000);
    await onB(c);
    const desktop = line('one') + line('desktop meanwhile');
    const r = new TurnRunner({ ...c.deps, engine: new StubEngine(async () => {
      await fs.writeFile(fileOf(c, 'a'), desktop);
      return [{ kind: 'init', sessionId: SID, model: 'm', cwd: CWD }, okResult(SID)];
    }) });
    await r.run({ turnId: 't', cwd: CWD, sessionId: SID, text: 'go' }, c.sink);
    await r.mirrorsSettled();
    expect(await read(fileOf(c, 'a'))).toBe(desktop);
    expect(notices(c)).toEqual([]);
    await turn(c, SID, 't2');
    expect(c.seen.at(-1)).toBe(desktop);
  });

  it('a stale copy of the same id under an old dir spelling in A neither blocks the mirror nor is touched', async () => {
    const c = await setup();
    const OLD = '-w--old-encoding';
    await put(c, 'a', line('ancient'), NOW - 86_400_000, OLD);
    await put(c, 'b', line('one'), NOW - 60_000);
    await onB(c);
    await turn(c, SID);
    expect(await read(fileOf(c, 'a'))).toBe(await read(fileOf(c, 'b')));
    expect(await read(fileOf(c, 'a', OLD))).toBe(line('ancient'));
    expect(notices(c)).toEqual([]);
  });

  it('without homeAccount nothing is mirrored; a turn on A itself is not copied anywhere', async () => {
    const c = await setup();
    const r = new TurnRunner({ ...c.deps, homeAccount: null });
    await r.run({ turnId: 't', cwd: CWD, sessionId: null, text: 'go' }, c.sink);
    await r.mirrorsSettled();
    await expect(fs.stat(fileOf(c, 'a'))).rejects.toThrow();
  });
});

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { p, open };
}

async function until(cond: () => Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('TurnRunner: write-back while the session is held open for background work', () => {
  it('writes back after the results of a held-open session (throttled), and once more at close', async () => {
    const c = await setup();
    const g1 = gate();
    const g2 = gate();
    const append = (text: string) => fs.mkdir(path.join(c.roots.b, DIR), { recursive: true }).then(() => fs.appendFile(fileOf(c, 'b'), line(text)));
    const eng = new StubEngine(async () => (async function* () {
      await append('turn');
      yield { kind: 'init' as const, sessionId: SID, model: 'm', cwd: CWD };
      yield { kind: 'background' as const, tasks: ['agent'] };
      yield okResult(SID);
      await g1.p;
      await append('bg one');
      yield okResult(SID, 'bg one');
      await g2.p;
      await append('bg two');
      yield { kind: 'background' as const, tasks: [] };
      yield okResult(SID, 'bg two');
    })());
    let moves = 0;
    const r = new TurnRunner({ ...c.deps, engine: eng, mirrorThrottleMs: 400, move: async (o) => { moves++; return moveSession(o); } });
    const results = () => c.msgs.filter((m) => m.type === 'turn_result').length;
    const done = r.run({ turnId: 't', cwd: CWD, sessionId: null, text: 'go' }, c.sink);

    // Still held open (the stream has not ended): the first result is already written back.
    await until(async () => (await read(fileOf(c, 'a')).catch(() => '')) === line('turn'), 'first write-back');
    const t0 = Date.now();
    g1.open();
    await until(async () => results() === 2, 'bg result');
    // Within the throttle window: not yet …
    if (Date.now() - t0 < 300) expect(await read(fileOf(c, 'a'))).toBe(line('turn'));
    // … but the trailing write-back follows without another result.
    await until(async () => (await read(fileOf(c, 'a'))) === line('turn') + line('bg one'), 'trailing write-back');
    expect(moves).toBe(2);

    g2.open();
    await done;
    await r.mirrorsSettled();
    expect(await read(fileOf(c, 'a'))).toBe(await read(fileOf(c, 'b')));
    expect(await read(fileOf(c, 'a'))).toContain('bg two');
    // The final write-back at close replaced the throttled one (no extra copy left pending).
    expect(moves).toBe(3);
    expect(notices(c).filter((m) => m.includes('갱신 실패'))).toEqual([]);
  });
});

describe('TurnRunner: resolving a session that diverged between deck and Desktop', () => {
  async function diverged(c: Ctx) {
    await put(c, 'a', line('one') + line('desktop went on'), NOW - 3_600_000);
    await fs.mkdir(path.join(c.roots.a, DIR, SID, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(c.roots.a, DIR, SID, 'subagents', 'agent-d.jsonl'), '{"d":1}\n');
    await put(c, 'b', line('one') + line('deck went on'), NOW - 60_000);
    await fs.mkdir(path.join(c.roots.b, DIR, SID), { recursive: true });
    await fs.writeFile(path.join(c.roots.b, DIR, SID, 'deck.txt'), 'b');
    await onB(c);
  }
  const listing = async (dir: string) => (await fs.readdir(dir)).sort();

  it('keep deck: A\'s copy and companions are renamed to *.deck-fork-<ts> (never deleted) and deck\'s copy is written to A', async () => {
    const c = await setup();
    await diverged(c);
    expect(await c.runner.forkStatus(SID)).toEqual({ diverged: true, deckAccount: 'b', homeAccount: 'a' });
    const r = await c.runner.resolveFork(SID, 'deck');
    expect(r.ok).toBe(true);
    const aDir = path.join(c.roots.a, DIR);
    const names = await listing(aDir);
    const bak = names.find((n) => n.startsWith(`${SID}.jsonl.deck-fork-`))!;
    const bakDir = names.find((n) => n.startsWith(`${SID}.deck-fork-`))!;
    expect(bak).toBeTruthy();
    expect(r.ok && r.backup).toBe(path.join(aDir, bak));
    expect(await read(path.join(aDir, bak))).toBe(line('one') + line('desktop went on'));
    expect(await read(path.join(aDir, bakDir, 'subagents', 'agent-d.jsonl'))).toBe('{"d":1}\n');
    expect(await read(fileOf(c, 'a'))).toBe(line('one') + line('deck went on'));
    expect(await read(path.join(aDir, SID, 'deck.txt'))).toBe('b');
    expect(await read(fileOf(c, 'b'))).toBe(line('one') + line('deck went on'));
    expect(await c.runner.forkStatus(SID)).toMatchObject({ diverged: false });
    // Nothing left to resolve; later turns write back normally.
    expect(await c.runner.resolveFork(SID, 'deck')).toEqual({ ok: false, error: '갈라진 사본이 없습니다' });
    await turn(c, SID);
    expect(await read(fileOf(c, 'a'))).toBe(await read(fileOf(c, 'b')));
  });

  it('keep home: deck\'s copy is backed up in its own profile and A\'s is adopted; refused while deck runs it', async () => {
    const c = await setup();
    await diverged(c);
    const g = gate();
    const eng = new StubEngine(async () => (async function* () {
      yield { kind: 'init' as const, sessionId: SID, model: 'm', cwd: CWD };
      await g.p;
      yield okResult(SID);
    })());
    const r = new TurnRunner({ ...c.deps, engine: eng });
    const running = r.run({ turnId: 't', cwd: CWD, sessionId: SID, text: 'go' }, c.sink);
    await until(async () => eng.calls.length === 1, 'turn started');
    expect(await r.resolveFork(SID, 'home')).toMatchObject({ ok: false, error: expect.stringContaining('실행 중') });
    g.open();
    await running;
    await r.mirrorsSettled();

    const res = await r.resolveFork(SID, 'home');
    expect(res.ok).toBe(true);
    const bDir = path.join(c.roots.b, DIR);
    const names = await listing(bDir);
    const bak = names.find((n) => n.startsWith(`${SID}.jsonl.deck-fork-`))!;
    expect(await read(path.join(bDir, bak))).toBe(line('one') + line('deck went on'));
    expect(await read(path.join(bDir, names.find((n) => n.startsWith(`${SID}.deck-fork-`))!, 'deck.txt'))).toBe('b');
    expect(await read(fileOf(c, 'b'))).toBe(line('one') + line('desktop went on'));
    expect(await read(path.join(bDir, SID, 'subagents', 'agent-d.jsonl'))).toBe('{"d":1}\n');
    // A is untouched.
    expect(await read(fileOf(c, 'a'))).toBe(line('one') + line('desktop went on'));
    expect(c.deps.store.get(SID)).toMatchObject({ account: 'b', projectDir: bDir });
  });

  it('a failed copy puts the backups back', async () => {
    const c = await setup();
    await diverged(c);
    const r = new TurnRunner({ ...c.deps, move: async () => ({ ok: false, error: 'injected' }) });
    expect(await r.resolveFork(SID, 'deck')).toEqual({ ok: false, error: 'injected' });
    const aDir = path.join(c.roots.a, DIR);
    expect((await listing(aDir)).filter((n) => n.includes('deck-fork'))).toEqual([]);
    expect(await read(fileOf(c, 'a'))).toBe(line('one') + line('desktop went on'));
    expect(await read(path.join(aDir, SID, 'subagents', 'agent-d.jsonl'))).toBe('{"d":1}\n');
  });
});

describe('SessionIndex: which copy of a session wins', () => {
  it('prefers the copy that contains the others over a newer prefix; diverged → newest; bestCopy follows suit', async () => {
    const c = await setup();
    await put(c, 'a', line('one') + line('two'), NOW - 3_600_000);
    await put(c, 'b', line('one'), NOW - 60_000);
    await c.deps.index.refresh();
    expect(c.deps.index.lookup(SID)?.account).toBe('a');
    expect((await c.deps.index.bestCopy(SID, path.join(c.roots.b, DIR), 'b'))?.account).toBe('a');
    await put(c, 'b', line('one') + line('other'), NOW - 60_000);
    await c.deps.index.refresh();
    expect(c.deps.index.lookup(SID)?.account).toBe('b');
    expect((await c.deps.index.bestCopy(SID, path.join(c.roots.b, DIR), 'b'))?.account).toBe('b');
  });
});
