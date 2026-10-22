import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Account } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import type { Attachment, AttachmentStore } from '../attachments/AttachmentStore';
import { ClaudeEngine } from '../engine/ClaudeEngine';
import { fakeClaudeCli, cli } from '../engine/claudeCli/fakeClaudeCli';
import { PermissionBridge } from '../engine/claudeCli/bridge';
import type { ClaudeSpawnFn } from '../engine/claudeCli/spawnTypes';
import { readCooldownUntilMs } from '../routing/cooldown';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { AUTO_RETRY_NOTICE, MAX_BG_CAP_HOPS, RESEND_NOTICE, SHUTDOWN_ABORT, SHUTDOWN_ABORTED, TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-09-30T12:30:00Z');
/** The CLI resumes only a real session id, so the session the fake child reports is a UUID. */
const SID = '11111111-2222-4333-8444-555555555555';

let bridge: PermissionBridge;
let tmpRoot = '';
beforeAll(async () => { bridge = await PermissionBridge.open(); tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trbg-proc-')); });
afterAll(async () => { await bridge.close(); await fs.rm(tmpRoot, { recursive: true, force: true }); });

async function setup(over: Partial<Pick<TurnRunnerDeps, 'attachments' | 'usage' | 'move' | 'sameVendorRotation'>> & { readFile?: (p: string) => Promise<Buffer>; /** The background wait limit (ClaudeEngine bgMaxMs); default: the engine's. */ bgMaxMs?: number; /** ClaudeEngine prompt suggestions (and their wait). */ promptSuggestions?: boolean; suggestWaitMs?: number } = {}) {
  const f = fakeClaudeCli();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trbg-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const usage = over.usage ?? new UsageService({ mode: 'usage-deck', accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), now: () => new Date(NOW) });
  /**
   * Per process started: its argv, and what its UserPromptSubmit hook adds to the first prompt (undefined: no hook or
   * nothing added). Like the real CLI, the child's output waits until that hook has answered.
   */
  const procs: { args: string[]; note: Promise<string | undefined> }[] = [];
  const spawnFn: ClaudeSpawnFn = (bin, args, o) => {
    const child = f.spawnFn(bin, args, o);
    const settings = f.spawns.at(-1)!.files.settings as { hooks: Record<string, unknown> } | null;
    if (!settings?.hooks.UserPromptSubmit) { procs.push({ args, note: Promise.resolve(undefined) }); return child; }
    const note = f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: SID, transcript_path: '/t', cwd: '/w' })
      .then((r) => (r as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext);
    procs.push({ args, note });
    const stdout = new PassThrough();
    void note.catch(() => undefined).then(() => child.stdout.pipe(stdout));
    return { ...child, stdout };
  };
  const deps: TurnRunnerDeps = {
    accounts: testRegistry(),
    engine: new ClaudeEngine({ bin: 'claude', spawnFn, bridge, tmpRoot, killGraceMs: 50, accounts: testRegistry(), baseEnv: {}, readFile: over.readFile ?? (async () => Buffer.from('')), ...(over.bgMaxMs !== undefined ? { bgMaxMs: over.bgMaxMs } : {}), ...(over.promptSuggestions ? { promptSuggestions: true, suggestWaitMs: over.suggestWaitMs ?? 5_000 } : {}) }),
    usage,
    index: new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'projects.json') }),
    store,
    cooldownDir: path.join(base, 'cooldown'),
    protectedAccount: 'a',
    auditFile: path.join(base, 'audit.log'),
    projectsRoots: rootsOf(roots),
    codex: null,
    attachments: over.attachments ?? null,
    codexSessionsRoot: path.join(base, 'codex-sessions'),
    now: () => NOW,
    maxRetries: 0,
    ...(over.move ? { move: over.move } : {}),
    ...(over.sameVendorRotation ? { sameVendorRotation: over.sameVendorRotation } : {}),
  };
  const msgs: ServerMessage[] = [];
  const ac = new AbortController();
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: ac.signal };
  const runner = new TurnRunner(deps);
  return { f, msgs, sink, ac, runner, store, procs, deps };
}

/** Usage cards for a/b/c: a new session routes to b; with b out, a (protected, the one other account with room — c is at weekly 91). */
async function usageCards(): Promise<UsageService> {
  const resetsAt = new Date(NOW + 36 * 3_600_000).toISOString();
  const card = (id: string, s: number, w: number, fb: number) => ({ id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [
    { label: 'Session (5h)', used: s, resetsAt }, { label: 'Weekly (7d)', used: w, resetsAt }, { label: 'Fable (7d)', used: fb, resetsAt }] });
  const state = { cards: [card('claude:main', 13, 7, 0), card('claude:second', 2, 3, 4), card('claude:third', 0, 91, 27)] };
  const u = new UsageService({ mode: 'usage-deck', accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => state }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

/** A session move that always succeeds (the fake CLI writes no transcript to move). */
const okMove: NonNullable<TurnRunnerDeps['move']> = async (o) => ({ ok: true, targetDir: path.join(o.targetProjectsRoot, path.basename(o.sourceProjectDir)), targetFile: '', copied: [] });

const LIMIT_TEXT = "You've hit your session limit · resets 3:50am (Asia/Seoul)";
const limited = { ...cli.result('', SID), is_error: true, result: LIMIT_TEXT };

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** What the process's UserPromptSubmit hook adds to its first prompt (undefined: no hook or nothing added). */
const promptNote = async (p: { note: Promise<string | undefined> } | undefined): Promise<string | undefined> => p?.note;
/** deck never replaces or appends to the CLI's system prompt. */
const systemPromptFlag = (p: { args: string[] } | undefined) => p?.args.find((a) => /^--(append-)?system-prompt/.test(a));

const of = (msgs: ServerMessage[], type: ServerMessage['type']) => msgs.filter((m) => m.type === type) as (ServerMessage & Record<string, unknown>)[];

describe('TurnRunner: background work after the turn result', () => {
  it('streams the continuation as its own turn with a 백그라운드 계속 marker and badge', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'explore repo' }]), cli.delta('launched'), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    expect(of(msgs, 'turn_background')).toMatchObject([{ type: 'turn_background', turnId: 't1', sessionId: SID, cwd: '/w/new', tasks: ['explore repo'] }]);
    expect(runner.backgroundSessions()).toEqual([SID]);

    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('found'), cli.result('found', SID));
    await done;
    const started = of(msgs, 'turn_started');
    expect(started.map((m) => [m.turnId, m.reason])).toEqual([['t1', expect.any(String)], ['t1:bg1', '백그라운드 계속']]);
    expect(of(msgs, 'turn_notice').at(-1)).toMatchObject({ turnId: 't1:bg1', message: expect.stringContaining('백그라운드 계속') });
    expect(of(msgs, 'delta').map((m) => [m.turnId, m.text])).toEqual([['t1', 'launched'], ['t1:bg1', 'found']]);
    const results = of(msgs, 'turn_result');
    expect(results[1]).toMatchObject({ turnId: 't1:bg1', ok: true, text: 'found', badge: { reason: '백그라운드 계속', usage: { outputTokens: 2 } } });
    expect(of(msgs, 'turn_background').at(-1)).toMatchObject({ tasks: [] });
    expect(runner.backgroundSessions()).toEqual([]);
    expect(runner.followUp(SID, { turnId: 'late', text: 'x' })).toBe(false);
    expect(f.state.calls).toBe(1);
  });

  it('a background task settling after the turn result emits task_done (drives the push)', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.taskDone('x'), cli.bgLevel([]), cli.notifyUser(), cli.delta('built'), cli.result('built', SID));
    await done;
    expect(of(msgs, 'task_done')).toMatchObject([{ type: 'task_done', turnId: 't1', sessionId: SID, cwd: '/w/new', status: 'completed', summary: 'done' }]);
    expect(of(msgs, 'turn_result').map((m) => m.turnId)).toEqual(['t1', 't1:bg1']);
  });

  it('a follow-up while waiting goes into the same process at once; one during a continuation waits for its result', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');

    expect(runner.followUp(SID, { turnId: 'f1', text: 'status?', clientRef: 'r1', model: 'sonnet' })).toEqual({ queuedBehind: null });
    await waitFor(() => f.inputs.length === 2, 'follow-up written');
    expect(of(msgs, 'turn_started').at(-1)).toMatchObject({ turnId: 'f1', clientRef: 'r1', reason: '백그라운드 대기 중 이어 보냄' });
    f.push(cli.delta('still building'), cli.result('still building', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 2, 'follow-up result');
    expect(of(msgs, 'turn_result')[1]).toMatchObject({ turnId: 'f1', text: 'still building', badge: { modelNote: '백그라운드 대기 중인 프로세스의 모델 유지' } });

    // Background finishes; while its continuation streams, another message arrives and is queued.
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('built'));
    await waitFor(() => of(msgs, 'delta').some((m) => m.text === 'built'), 'continuation output');
    // Taken, but held in deck until the continuation's result: the caller is told which segment it waits behind.
    expect(runner.followUp(SID, { turnId: 'f2', text: 'ship it' })).toEqual({ queuedBehind: '백그라운드 계속' });
    await new Promise((r) => setTimeout(r, 5));
    expect(f.inputs).toHaveLength(2);
    f.push(cli.result('built', SID));
    await waitFor(() => f.inputs.length === 3, 'queued follow-up written after the continuation');
    expect(of(msgs, 'turn_started').map((m) => m.turnId)).toEqual(['t1', 'f1', 't1:bg1', 'f2']);
    f.push(cli.result('shipped', SID));
    await done;
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.text])).toEqual([['t1', 'launched'], ['f1', 'still building'], ['t1:bg1', 'built'], ['f2', 'shipped']]);
  });

  it('cancelQueued takes a waiting follow-up back out by its clientRef; one already in, an unknown ref or no process: null', async () => {
    const { f, msgs, sink, runner } = await setup();
    expect(runner.cancelQueued(SID, 'r1')).toBeNull();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('built'));
    await waitFor(() => of(msgs, 'delta').some((m) => m.text === 'built'), 'continuation output');
    expect(runner.followUp(SID, { turnId: 'f1', text: 'first', clientRef: 'r1' })).toEqual({ queuedBehind: '백그라운드 계속' });
    expect(runner.followUp(SID, { turnId: 'f2', text: 'second', clientRef: 'r2' })).toEqual({ queuedBehind: '백그라운드 계속' });
    expect(runner.cancelQueued(SID, 'nope')).toBeNull();
    expect(runner.cancelQueued(SID, 'r1')).toBe('f1');
    expect(runner.cancelQueued(SID, 'r1')).toBeNull();
    f.push(cli.result('built', SID));
    await waitFor(() => f.inputs.length === 2, 'the remaining follow-up written after the continuation');
    expect(of(msgs, 'turn_started').map((m) => m.turnId)).toEqual(['t1', 't1:bg1', 'f2']);
    // Already handed to the process: nothing to withdraw.
    expect(runner.cancelQueued(SID, 'r2')).toBeNull();
    f.push(cli.result('done', SID));
    await done;
    expect(of(msgs, 'turn_result').map((m) => m.turnId)).toEqual(['t1', 't1:bg1', 'f2']);
    expect(of(msgs, 'error')).toEqual([]);
  });

  it('stop while a continuation streams ends it as 중단됨 and refuses the queued follow-up with its clientRef', async () => {
    const { f, msgs, sink, ac, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    expect(runner.followUp(SID, { turnId: 'f1', text: 'next', clientRef: 'r9' })).toEqual({ queuedBehind: '백그라운드 계속' });
    ac.abort();
    await done;
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 't1:bg1', ok: false, errorText: '중단됨' });
    expect(of(msgs, 'error')).toEqual([expect.objectContaining({ turnId: 'f1', clientRef: 'r9' })]);
    expect(of(msgs, 'error')[0]).not.toHaveProperty('code');
    expect(runner.backgroundSessions()).toEqual([]);
  });

  it('the restart deadline dropping a queued follow-up refuses it with code draining (the device sends it again after the restart)', async () => {
    const { f, msgs, sink, ac, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    expect(runner.followUp(SID, { turnId: 'f1', text: 'next', clientRef: 'r9' })).toEqual({ queuedBehind: '백그라운드 계속' });
    ac.abort(SHUTDOWN_ABORT);
    await done;
    expect(of(msgs, 'error')).toEqual([expect.objectContaining({ turnId: 'f1', clientRef: 'r9', code: 'draining' })]);
  });

  it("a queued follow-up starts in the same tick as the continuation's result (before any await), so a microtask sees the process busy again", async () => {
    const { f, msgs, sink, runner } = await setup();
    // What ws's endHeld sees: whether a turn started between a turn_result and the microtask queued on it.
    const seen: boolean[] = [];
    const sink2: TurnSink = { ...sink, emit: (m) => { msgs.push(m); if (m.type === 'turn_result') { const at = msgs.length; queueMicrotask(() => seen.push(msgs.slice(at).some((x) => x.type === 'turn_started'))); } } };
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink2);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('built'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    expect(runner.followUp(SID, { turnId: 'f1', text: 'ship it', clientRef: 'r1' })).toEqual({ queuedBehind: '백그라운드 계속' });
    f.push(cli.result('built', SID));
    await waitFor(() => f.inputs.length === 2, 'queued follow-up written');
    expect(seen).toEqual([false, true]);
    f.push(cli.result('shipped', SID));
    await done;
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', true], ['f1', true]]);
  });

  it('a follow-up that could not be written after its turn_started also sends an error with its clientRef (its accepted ref is taken back)', async () => {
    const img: Attachment = { id: 'i1', name: 'a.png', mediaType: 'image/png', size: 1, path: '/gone/a.png', isImage: true, createdAtMs: 0 };
    const attachments = { resolve: () => ({ found: [img], missing: [] }) } as unknown as AttachmentStore;
    const { f, msgs, sink, runner } = await setup({ attachments, readFile: async () => { throw new Error('gone'); } });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    expect(runner.followUp(SID, { turnId: 'f1', text: 'look', attachments: ['i1'], clientRef: 'r1' })).toEqual({ queuedBehind: null });
    await waitFor(() => of(msgs, 'error').length === 1, 'refusal');
    expect(of(msgs, 'turn_started').at(-1)).toMatchObject({ turnId: 'f1', clientRef: 'r1' });
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f1', ok: false, errorText: '메시지를 보내지 못했습니다' });
    expect(of(msgs, 'error')[0]).toMatchObject({ turnId: 'f1', clientRef: 'r1', message: '메시지를 보내지 못했습니다' });
    f.push(cli.bgLevel([]));
    f.end();
    await done;
  });

  it('a follow-up the waiting process ended before taking goes in as the next turn of the session (same turn id and ref, no error)', async () => {
    const img: Attachment = { id: 'i1', name: 'a.png', mediaType: 'image/png', size: 1, path: '/w/a.png', isImage: true, createdAtMs: 0 };
    const attachments = { resolve: () => ({ found: [img], missing: [] }) } as unknown as AttachmentStore;
    // The follow-up's write waits on its file until the process is gone: the write then finds the input closed.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reads = 0;
    const { f, msgs, sink, runner } = await setup({ attachments, readFile: async () => { if (++reads === 1) await gate; return Buffer.from('x'); } });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    expect(runner.followUp(SID, { turnId: 'f1', text: 'look', attachments: ['i1'], clientRef: 'r1' })).toEqual({ queuedBehind: null });
    expect(of(msgs, 'turn_started').at(-1)).toMatchObject({ turnId: 'f1', clientRef: 'r1' });
    f.end();
    await waitFor(() => runner.backgroundSessions().length === 0, 'process gone');
    release();
    await waitFor(() => f.state.calls === 2, 'the follow-up resumed in a new process');
    f.push(cli.init(SID), cli.delta('seen'), cli.result('seen', SID));
    await done;
    expect(of(msgs, 'error')).toEqual([]);
    expect(of(msgs, 'turn_started').map((m) => [m.turnId, m.clientRef])).toEqual([['t1', undefined], ['f1', 'r1'], ['f1', 'r1']]);
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok, m.text])).toEqual([['t1', true, 'launched'], ['f1', true, 'seen']]);
    expect(of(msgs, 'turn_notice').filter((m) => m.message === RESEND_NOTICE).map((m) => m.turnId)).toEqual(['f1']);
    expect(JSON.stringify(f.inputs.at(-1))).toContain('look');
  });

  it('follow-ups still queued when the process ends go in after it as turns of their own, in order', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    expect(runner.followUp(SID, { turnId: 'f1', text: 'first', clientRef: 'r1' })).toEqual({ queuedBehind: '백그라운드 계속' });
    expect(runner.followUp(SID, { turnId: 'f2', text: 'second', clientRef: 'r2' })).toEqual({ queuedBehind: '백그라운드 계속' });
    f.end();
    await waitFor(() => f.state.calls === 2, 'first follow-up resumed');
    f.push(cli.init(SID), cli.result('one', SID));
    await waitFor(() => f.state.calls === 3, 'second follow-up resumed');
    f.push(cli.init(SID), cli.result('two', SID));
    await done;
    expect(of(msgs, 'error')).toEqual([]);
    expect(of(msgs, 'turn_started').map((m) => [m.turnId, m.clientRef])).toEqual([['t1', undefined], ['t1:bg1', undefined], ['f1', 'r1'], ['f2', 'r2']]);
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', false], ['f1', true], ['f2', true]]);
    expect(of(msgs, 'turn_notice').filter((m) => m.message === RESEND_NOTICE).map((m) => m.turnId)).toEqual(['f1']);
    expect(f.inputs.slice(-2).map((m) => JSON.stringify(m))).toEqual([expect.stringContaining('first'), expect.stringContaining('second')]);
  });

  it('while the server drains, follow-ups the ended process did not take are refused with code draining, no new process', async () => {
    const { f, msgs, sink, runner } = await setup();
    const drainSink: TurnSink = { ...sink, draining: () => true };
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, drainSink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    runner.followUp(SID, { turnId: 'f1', text: 'first', clientRef: 'r1' });
    runner.followUp(SID, { turnId: 'f2', text: 'second', clientRef: 'r2' });
    f.end();
    await done;
    expect(of(msgs, 'error').map((m) => [m.turnId, m.clientRef, m.code])).toEqual([['f1', 'r1', 'draining'], ['f2', 'r2', 'draining']]);
    expect(f.state.calls).toBe(1);
  });

  it('the user stopping a follow-up that already started (its write still on its way) closes its turn and sends its error, no new process', async () => {
    const img: Attachment = { id: 'i1', name: 'a.png', mediaType: 'image/png', size: 1, path: '/w/a.png', isImage: true, createdAtMs: 0 };
    const attachments = { resolve: () => ({ found: [img], missing: [] }) } as unknown as AttachmentStore;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { f, msgs, sink, ac, runner } = await setup({ attachments, readFile: async () => { await gate; return Buffer.from('x'); } });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    expect(runner.followUp(SID, { turnId: 'f1', text: 'look', attachments: ['i1'], clientRef: 'r1' })).toEqual({ queuedBehind: null });
    f.end();
    await waitFor(() => runner.backgroundSessions().length === 0, 'process gone');
    release();
    ac.abort();
    await done;
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f1', ok: false });
    expect(of(msgs, 'error')).toEqual([expect.objectContaining({ turnId: 'f1', clientRef: 'r1' })]);
    expect(of(msgs, 'error')[0]).not.toHaveProperty('code');
    expect(f.state.calls).toBe(1);
    expect(runner.resendingFor(SID)).toBe(false);
  });

  it('a follow-up sent on is refused before its turn starts: its ref comes back with an error and the next one still goes in, each as it asked', async () => {
    const { f, msgs, sink, runner } = await setup();
    const real = runner.run.bind(runner);
    const sent: { turnId: string; effort?: string; concise?: boolean }[] = [];
    // The first one sent on is refused the way a session the runner cannot resume is (no turn_started).
    runner.run = async (p, s) => {
      if (p.turnId !== 't1') sent.push({ turnId: p.turnId, ...(p.effort ? { effort: p.effort } : {}), ...(p.concise !== undefined ? { concise: p.concise } : {}) });
      if (p.turnId === 'f1') { s.emit({ type: 'error', turnId: null, message: '이 세션을 열 수 없습니다' }); return; }
      return real(p, s);
    };
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', effort: 'high', concise: true }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    runner.followUp(SID, { turnId: 'f1', text: 'first', clientRef: 'r1' });
    runner.followUp(SID, { turnId: 'f2', text: 'second', clientRef: 'r2', concise: false, effort: 'low' });
    f.end();
    await waitFor(() => f.state.calls === 2, 'second follow-up resumed');
    f.push(cli.init(SID), cli.result('two', SID));
    await done;
    expect(of(msgs, 'error').filter((m) => m.clientRef).map((m) => [m.turnId, m.clientRef, m.code])).toEqual([['f1', 'r1', undefined]]);
    // About this session (the pane showing it says it), not app-wide.
    expect(of(msgs, 'error').find((m) => m.clientRef)).toMatchObject({ sessionId: SID });
    expect(of(msgs, 'turn_result').filter((m) => m.turnId === 'f1')).toEqual([]);
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f2', ok: true });
    // The held turn's effort / concise unless the follow-up asked otherwise.
    expect(sent).toEqual([{ turnId: 'f1', effort: 'high', concise: true }, { turnId: 'f2', effort: 'low', concise: false }]);
  });

  it('a send while follow-ups are being sent on queues behind them (and can be withdrawn) instead of finding the session free', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    runner.followUp(SID, { turnId: 'f1', text: 'first', clientRef: 'r1' });
    f.end();
    await waitFor(() => f.state.calls === 2, 'first follow-up resumed');
    // Between the ended process and the turn sent on (no process held open): it is not the session's end.
    expect(runner.backgroundSessions()).toEqual([]);
    expect(runner.resendingFor(SID)).toBe(true);
    expect(runner.followUp(SID, { turnId: 'f3', text: 'third', clientRef: 'r3' })).toEqual({ queuedBehind: RESEND_NOTICE });
    expect(runner.followUp(SID, { turnId: 'f4', text: 'fourth', clientRef: 'r4' })).toEqual({ queuedBehind: RESEND_NOTICE });
    expect(runner.cancelQueued(SID, 'r4')).toBe('f4');
    expect(runner.cancelQueued(SID, 'r4')).toBeNull();
    f.push(cli.init(SID), cli.result('one', SID));
    await waitFor(() => f.state.calls === 3, 'the send that came meanwhile resumed after it');
    f.push(cli.init(SID), cli.result('three', SID));
    await done;
    expect(of(msgs, 'error')).toEqual([]);
    expect(of(msgs, 'turn_started').map((m) => m.turnId)).toEqual(['t1', 't1:bg1', 'f1', 'f3']);
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', false], ['f1', true], ['f3', true]]);
    expect(of(msgs, 'turn_notice').filter((m) => m.message === RESEND_NOTICE).map((m) => m.turnId)).toEqual(['f1']);
    expect(runner.resendingFor(SID)).toBe(false);
    expect(runner.followUp(SID, { turnId: 'f5', text: 'fifth' })).toBe(false);
  });

  it('a follow-up sent on whose turn is held open for background work again takes the rest as follow-ups of that process', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    runner.followUp(SID, { turnId: 'f1', text: 'first', clientRef: 'r1' });
    runner.followUp(SID, { turnId: 'f2', text: 'second', clientRef: 'r2' });
    f.end();
    await waitFor(() => f.state.calls === 2, 'first follow-up resumed');
    f.push(cli.init(SID), cli.bgLevel([{ id: 'y', desc: 'test' }]), cli.result('one', SID));
    await waitFor(() => f.inputs.length === 3, 'the second written into the held-open process');
    expect(JSON.stringify(f.inputs.at(-1))).toContain('second');
    expect(runner.resendingFor(SID)).toBe(true);
    f.push(cli.result('two', SID), cli.bgLevel([]));
    f.end();
    await done;
    expect(f.state.calls).toBe(2);
    expect(of(msgs, 'error')).toEqual([]);
    expect(of(msgs, 'turn_started').map((m) => m.turnId)).toEqual(['t1', 't1:bg1', 'f1', 'f2']);
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', false], ['f1', true], ['f2', true]]);
    expect(runner.resendingFor(SID)).toBe(false);
  });

  it('the restart deadline cutting background work says so in the pane, and the next turn tells the user and the model once', async () => {
    const { f, msgs, sink, ac, runner, store, procs } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }, { id: 'y', desc: 'watch logs' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    ac.abort(SHUTDOWN_ABORT);
    await done;
    const notice = of(msgs, 'turn_notice').at(-1);
    expect(notice).toMatchObject({ turnId: 't1', sessionId: SID, message: '서버가 다시 시작되어 백그라운드 작업 2개가 중단됨: build, watch logs' });
    // The notice goes out before the tasks are cleared.
    expect(msgs.indexOf(notice!)).toBeLessThan(msgs.indexOf(of(msgs, 'turn_background').at(-1)!));
    expect(of(msgs, 'turn_background').at(-1)).toMatchObject({ tasks: [] });
    expect(store.get(SID)).toMatchObject({ interrupted: { atMs: NOW, tasks: ['build', 'watch logs'] } });
    expect(systemPromptFlag(procs[0])).toBeUndefined();

    const msgs2: ServerMessage[] = [];
    const sink2: TurnSink = { ...sink, emit: (m) => msgs2.push(m), signal: new AbortController().signal };
    const next = runner.run({ turnId: 't2', cwd: '/w/new', sessionId: SID, text: 'again' }, sink2);
    f.push(cli.init(SID), cli.result('ok', SID));
    await next;
    const at = new Date(NOW).toTimeString().slice(0, 5);
    expect(of(msgs2, 'turn_notice').map((m) => m.message)).toContain(`${at} 서버 재시작으로 백그라운드 작업 2개가 끊겼습니다: build, watch logs — 모델에게 알렸습니다`);
    // Told on the first prompt only (UserPromptSubmit additionalContext); the system prompt stays as on every turn.
    expect(systemPromptFlag(procs[1])).toBeUndefined();
    expect(await promptNote(procs[1])).toEqual(expect.stringMatching(/"build", "watch logs".*이미 다시 띄웠거나 더 필요 없으면 무시하세요\.$/));
    expect(store.get(SID)).not.toHaveProperty('interrupted');
    expect(of(msgs2, 'turn_result').at(-1)).toMatchObject({ turnId: 't2', ok: true });
  });

  it('총사령탑 commanderHop is carried to the cap continuation (its process gets the gate too)', async () => {
    const { f, msgs, sink, runner, deps } = await setup({ bgMaxMs: 20 });
    const hops: (number | undefined)[] = [];
    const engine = deps.engine;
    deps.engine = { runTurn: (r) => { hops.push(r.commanderHop); return engine.runTurn(r); } };
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', commanderHop: 4 }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'slow analysis' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_started').length === 2, 'the automatic continuation');
    f.push(cli.init(SID), cli.result('resumed', SID));
    await done;
    expect(of(msgs, 'turn_started')[1]).toMatchObject({ turnId: 't1:cap1' });
    expect(hops).toEqual([4, 4]);
  });

  it('보안 #3: a follow-up joining a commanderHop turn\'s held process stays gated (same process, same hook settings, no auto-approve)', async () => {
    const { f, msgs, sink, runner, deps } = await setup();
    const reqs: Parameters<typeof deps.engine.runTurn>[0][] = [];
    const engine = deps.engine;
    deps.engine = { runTurn: (r) => { reqs.push(r); return engine.runTurn(r); } };
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', commanderHop: 4 }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    expect(runner.followUp(SID, { turnId: 'f1', text: 'now push it' })).toEqual({ queuedBehind: null });
    await waitFor(() => f.inputs.length === 2, 'follow-up written into the same process');
    expect(f.state.calls).toBe(1);
    expect(reqs.map((r) => r.commanderHop)).toEqual([4]);
    expect(reqs[0]!.autoApprove!()).toBe(false);
    // The follow-up's tool calls hit the same fail-closed .* hook and are judged by the gate.
    expect(await f.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'b1' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
    expect(await f.hook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'x' }, tool_use_id: 'b2' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
    f.push(cli.result('asked', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 2, 'follow-up result');
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.result('built', SID));
    await done;
  });

  it('the cap continuation is asked as the turn was (effort, concise, fast)', async () => {
    const { f, msgs, sink, runner } = await setup({ bgMaxMs: 20 });
    const real = runner.run.bind(runner);
    const asked: { effort?: string; concise?: boolean; fast?: boolean }[] = [];
    runner.run = async (p, s) => { if (p.turnId === 't1:cap1') asked.push({ effort: p.effort, concise: p.concise, fast: p.fast }); return real(p, s); };
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', effort: 'high', concise: true, fast: true }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'slow analysis' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_started').length === 2, 'the automatic continuation');
    f.push(cli.init(SID), cli.result('resumed', SID));
    await done;
    expect(asked).toEqual([{ effort: 'high', concise: true, fast: true }]);
  });

  it('the reply language is carried to the cap continuation', async () => {
    const { f, msgs, sink, runner, deps } = await setup({ bgMaxMs: 20 });
    const notes: (string | undefined)[] = [];
    const engine = deps.engine;
    deps.engine = { runTurn: (r) => { notes.push(r.appendSystemPrompt); return engine.runTurn(r); } };
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', lang: 'ko' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'slow analysis' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_started').length === 2, 'the automatic continuation');
    f.push(cli.init(SID), cli.result('resumed', SID));
    await done;
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n).toContain('[deck language]');
  });

  it('the background wait limit cutting work: deck records it and sends 이어서 진행해 주세요 itself, telling the model it is an automatic continuation', async () => {
    const { f, msgs, sink, runner, store, procs } = await setup({ bgMaxMs: 20 });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'slow analysis' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    // The limit ends the process; the continuation deck sends starts a new one, which the fake CLI feeds next.
    await waitFor(() => of(msgs, 'turn_started').length === 2, 'the automatic continuation');
    expect(store.get(SID)).toMatchObject({ interrupted: { atMs: NOW, tasks: ['slow analysis'], cause: '백그라운드 작업 0분 한도', kind: 'cap' } });
    f.push(cli.init(SID), cli.result('resumed', SID));
    await done;
    const notices = of(msgs, 'turn_notice').map((m) => m.message as string);
    expect(notices).toContain('백그라운드 작업 1개가 0분 한도로 끊김: slow analysis — 이어서 진행하도록 자동으로 보냅니다');
    const at = new Date(NOW).toTimeString().slice(0, 5);
    expect(notices).toContain(`${at} 백그라운드 작업 0분 한도로 백그라운드 작업 1개가 끊겼습니다: slow analysis — AI-MSG 가 자동으로 이어갑니다`);
    expect(of(msgs, 'turn_started')[1]).toMatchObject({ turnId: 't1:cap1', sessionId: SID });
    expect(await promptNote(procs[1])).toEqual(expect.stringMatching(/"slow analysis".*deck 이 자동으로 이어 보낸 것입니다.*한 줄로 알리세요\.$/));
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 't1:cap1', ok: true, text: 'resumed' });
    // The continuation got the note through: nothing is carried to the user's next message.
    expect(store.get(SID)).not.toHaveProperty('interrupted');
    expect(procs.length).toBe(2);
  });

  it('the automatic continuation is sent at most MAX_BG_CAP_HOPS times in a row; after that the cut waits for the user, who still gets the note', async () => {
    const { f, msgs, sink, runner, store, procs } = await setup({ bgMaxMs: 20 });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', bgCapHop: MAX_BG_CAP_HOPS }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'still slow' }]), cli.result('launched', SID));
    await done;
    expect(of(msgs, 'turn_started')).toHaveLength(1);
    expect(of(msgs, 'turn_notice').map((m) => m.message)).toContain(`백그라운드 작업 1개가 0분 한도로 끊김: still slow — 자동 이어가기 ${MAX_BG_CAP_HOPS}회를 다 써서 멈춥니다 (다음 메시지에 모델에게 알립니다)`);
    expect(store.get(SID)).toMatchObject({ interrupted: { tasks: ['still slow'], kind: 'cap' } });

    const msgs2: ServerMessage[] = [];
    const sink2: TurnSink = { ...sink, emit: (m) => msgs2.push(m) };
    const next = runner.run({ turnId: 't2', cwd: '/w/new', sessionId: SID, text: 'again' }, sink2);
    f.push(cli.init(SID), cli.result('ok', SID));
    await next;
    const at = new Date(NOW).toTimeString().slice(0, 5);
    expect(of(msgs2, 'turn_notice').map((m) => m.message)).toContain(`${at} 백그라운드 작업 0분 한도로 백그라운드 작업 1개가 끊겼습니다: still slow — 모델에게 알렸습니다`);
    const note = await promptNote(procs[1]);
    expect(note).toEqual(expect.stringMatching(/끊겨 결과가 오지 않습니다: "still slow"\./));
    expect(note).not.toContain('자동으로 이어 보낸');
    expect(store.get(SID)).not.toHaveProperty('interrupted');
  });

  it('the restart deadline cutting a turn that runs background work: its result says so (no second notice), the work is kept for the next turn', async () => {
    const { f, msgs, sink, ac, runner, store } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'turn output');
    ac.abort(SHUTDOWN_ABORT);
    await done;
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 't1', ok: false, errorText: SHUTDOWN_ABORTED });
    expect(of(msgs, 'turn_notice')).toEqual([]);
    expect(store.get(SID)).toMatchObject({ interrupted: { atMs: NOW, tasks: ['build'] } });
  });

  const seedCut = async (store: SessionStateStore, atMs = NOW) => {
    await store.set({ sessionId: SID, cwd: '/w/new', account: 'a', projectDir: '/w/proj', lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus', title: 'kept', interrupted: { atMs, tasks: ['build'] } });
  };
  const failed = { ...cli.result('', SID), subtype: 'error_during_execution', is_error: true, result: undefined };

  it('a turn that fails before the model got the note keeps the cut for the next turn; the one that gets through clears it', async () => {
    const { f, sink, runner, store, procs } = await setup();
    await seedCut(store);
    // An engine error: the note was offered, but no answer came — told again next turn.
    f.push(cli.init(SID), failed);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: SID, text: 'go' }, sink);
    expect(await promptNote(procs[0])).toContain('"build"');
    expect(store.get(SID)).toMatchObject({ interrupted: { atMs: NOW, tasks: ['build'] } });
    // A stop before the first attempt: same.
    const stopped = new AbortController();
    stopped.abort();
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: SID, text: 'go' }, { ...sink, signal: stopped.signal });
    expect(store.get(SID)).toMatchObject({ interrupted: { atMs: NOW, tasks: ['build'] } });
    f.push(cli.init(SID), cli.result('ok', SID));
    await runner.run({ turnId: 't3', cwd: '/w/new', sessionId: SID, text: 'go' }, { ...sink, signal: new AbortController().signal });
    expect(await promptNote(procs.at(-1))).toContain('"build"');
    expect(store.get(SID)).not.toHaveProperty('interrupted');
  });

  it('a handoff-note turn leaves the cut alone (no note, no notice); a cut from another day shows its date', async () => {
    const { f, msgs, sink, runner, store, procs } = await setup();
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    await seedCut(store, yesterday);
    f.push(cli.init(SID), cli.result('note', SID));
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: SID, text: 'hand off', handoff: true }, sink);
    expect(await promptNote(procs[0])).toBeUndefined();
    expect(of(msgs, 'turn_notice').filter((m) => String(m.message).includes('서버 재시작'))).toEqual([]);
    expect(store.get(SID)).toMatchObject({ interrupted: { atMs: yesterday, tasks: ['build'] } });

    f.push(cli.init(SID), cli.result('ok', SID));
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: SID, text: 'go' }, sink);
    const d = new Date(yesterday);
    const at = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 5)}`;
    expect(of(msgs, 'turn_notice').map((m) => m.message)).toContain(`${at} 서버 재시작으로 백그라운드 작업 1개가 끊겼습니다: build — 모델에게 알렸습니다`);
    expect(await promptNote(procs[1])).toContain(`${at} 에 deck 서버 재시작으로`);
    expect(store.get(SID)).not.toHaveProperty('interrupted');
  });

  it('a user stop of a held process is not recorded as a restart cut', async () => {
    const { f, msgs, sink, ac, runner, store } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    ac.abort();
    await done;
    expect(of(msgs, 'turn_notice')).toEqual([]);
    expect(store.get(SID)).not.toHaveProperty('interrupted');
  });

  it('no background work: no follow-up channel, nothing after the result', async () => {
    const { f, msgs, sink, runner } = await setup();
    f.push(cli.init(SID), cli.delta('ok'), cli.result('ok', SID));
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    expect(msgs.map((m) => m.type)).toEqual(['turn_started', 'delta', 'turn_result']);
    expect(runner.followUp(SID, { turnId: 'f', text: 'x' })).toBe(false);
  });

  describe('a segment hitting a limit goes on on another account', () => {
    it('a background continuation: cooldown, turn_retry + notice, a new turn on the other account told what was cut; no failed result', async () => {
      const { f, msgs, sink, runner, store, deps, procs } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(of(msgs, 'turn_started')[0]).toMatchObject({ account: 'b' });
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'), limited);
      await waitFor(() => f.state.calls === 2, 'the continuation process');
      f.push(cli.init(SID), cli.delta('resumed'), cli.result('resumed', SID));
      await done;

      expect(readCooldownUntilMs(deps.cooldownDir, 'b', NOW)).toBe(NOW + 3_600_000);
      expect(of(msgs, 'turn_retry')).toMatchObject([{ turnId: 't1:bg1', sessionId: SID, fromAccount: 'b', toAccount: 'a', attempt: 1, reason: expect.stringMatching(/^사용 한도 도달 · 03:50 리셋 → /) }]);
      expect(of(msgs, 'turn_notice').map((m) => m.message)).toContain('B 계정 사용 한도 도달 (03:50 리셋) — A 계정으로 이어서 진행합니다');
      expect(of(msgs, 'turn_started').map((m) => [m.turnId, m.account])).toEqual([['t1', 'b'], ['t1:bg1', 'b'], ['t1:bg1', 'a']]);
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', true]]);
      expect(of(msgs, 'turn_result')[1]).toMatchObject({ text: 'resumed', badge: { account: 'a' } });
      const at = new Date(NOW).toTimeString().slice(0, 5);
      expect(of(msgs, 'turn_notice').map((m) => m.message)).toContain(`${at} B 계정 사용 한도 도달로 이전 프로세스가 끝났습니다 — 다른 계정에서 이어갑니다 (모델에게 알렸습니다)`);
      expect(await promptNote(procs[1])).toContain(`${at} 에 B 계정 사용 한도 도달로`);
      expect(JSON.stringify(f.inputs.at(-1))).toContain('이어서 진행해 주세요.');
      expect(store.get(SID)).toMatchObject({ account: 'a' });
      expect(store.get(SID)).not.toHaveProperty('interrupted');
    });

    it('총사령탑 commanderHop is carried to the turn that goes on on the other account', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const hops: (number | undefined)[] = [];
      const engine = deps.engine;
      deps.engine = { runTurn: (r) => { hops.push(r.commanderHop); return engine.runTurn(r); } };
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', commanderHop: 2 }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'), limited);
      await waitFor(() => f.state.calls === 2, 'the continuation process');
      f.push(cli.init(SID), cli.delta('resumed'), cli.result('resumed', SID));
      await done;
      expect(of(msgs, 'turn_started').map((m) => [m.turnId, m.account])).toEqual([['t1', 'b'], ['t1:bg1', 'b'], ['t1:bg1', 'a']]);
      expect(hops).toEqual([2, 2]);
    });

    it('the reply language is carried to the turn that goes on on the other account (continuation and resent follow-up)', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const notes: (string | undefined)[] = [];
      const engine = deps.engine;
      deps.engine = { runTurn: (r) => { notes.push(r.appendSystemPrompt); return engine.runTurn(r); } };
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', lang: 'ko' }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'), limited);
      await waitFor(() => f.state.calls === 2, 'the continuation process');
      f.push(cli.init(SID), cli.delta('resumed'), cli.result('resumed', SID));
      await done;
      expect(notes).toHaveLength(2);
      for (const n of notes) expect(n).toContain('[deck language] Respond to the user in Korean');
    });

    it("a resent follow-up keeps its own device's language", async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const notes: (string | undefined)[] = [];
      const engine = deps.engine;
      deps.engine = { runTurn: (r) => { notes.push(r.appendSystemPrompt); return engine.runTurn(r); } };
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(runner.followUp(SID, { turnId: 'f1', text: 'status?', clientRef: 'r1', lang: 'ko' })).toEqual({ queuedBehind: null });
      await waitFor(() => f.inputs.length === 2, 'follow-up written');
      f.push(limited);
      await waitFor(() => f.state.calls === 2, 'the retry process');
      f.push(cli.init(SID), cli.result('fine', SID));
      await done;
      expect(notes[0]).toBeUndefined();
      expect(notes[1]).toContain('[deck language]');
    });

    it('같은 벤더 순환 꺼짐: the segment does not go on on another Claude account; it ends as failed and the retry is booked', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove, sameVendorRotation: () => false });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      // A new session goes to the home account (a), not the best-ranked b.
      expect(of(msgs, 'turn_started')[0]).toMatchObject({ account: 'a', reason: expect.stringMatching(/^같은 벤더 순환 꺼짐 · /) });
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'), limited);
      await done;
      expect(readCooldownUntilMs(deps.cooldownDir, 'a', NOW)).toBe(NOW + 3_600_000);
      expect(of(msgs, 'turn_retry')).toEqual([]);
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok, m.errorText])).toEqual([['t1', true, null], ['t1:bg1', false, 'A 계정 사용 한도 도달 · 03:50 리셋 · 대안 계정 없음(같은 벤더 순환 꺼짐)']]);
      expect(f.state.calls).toBe(1);
      expect(deps.store.get(SID)).toMatchObject({ account: 'a', pendingRetry: { text: '이어서 진행해 주세요.', hops: 1 } });
    });

    it('a follow-up: sent again under its own turn id and text on the other account; background work cut with it is told to the model', async () => {
      const { f, msgs, sink, runner, deps, procs } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(runner.followUp(SID, { turnId: 'f1', text: 'status?', clientRef: 'r1' })).toEqual({ queuedBehind: null });
      await waitFor(() => f.inputs.length === 2, 'follow-up written');
      f.push(limited);
      await waitFor(() => f.state.calls === 2, 'the retry process');
      f.push(cli.init(SID), cli.result('fine', SID));
      await done;

      expect(readCooldownUntilMs(deps.cooldownDir, 'b', NOW)).toBe(NOW + 3_600_000);
      expect(of(msgs, 'turn_retry')).toMatchObject([{ turnId: 'f1', fromAccount: 'b', toAccount: 'a' }]);
      expect(of(msgs, 'turn_started').map((m) => [m.turnId, m.account])).toEqual([['t1', 'b'], ['f1', 'b'], ['f1', 'a']]);
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['f1', true]]);
      expect(JSON.stringify(f.inputs.at(-1))).toContain('status?');
      expect(await promptNote(procs[1])).toEqual(expect.stringContaining('B 계정 사용 한도 도달로 종료되었고, 그때 돌고 있던 백그라운드 작업 1개는 끊겨 결과가 오지 않습니다: "build"'));
      expect(of(msgs, 'error')).toEqual([]);
    });

    it('any other failure of a segment just ends it as failed (no cooldown, no retry)', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(cli.bgLevel([]), cli.notifyUser(), { ...cli.result('', SID), is_error: true, result: 'boom' });
      await done;
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok, m.errorText])).toEqual([['t1', true, null], ['t1:bg1', false, expect.stringContaining('boom')]]);
      expect(of(msgs, 'turn_retry')).toEqual([]);
      expect(readCooldownUntilMs(deps.cooldownDir, 'b', NOW)).toBeNull();
      expect(f.state.calls).toBe(1);
    });

    it('with no account left (one hop per other account) the segment ends as failed; the follow-ups waiting are refused together, in order, no process started for them', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'));
      await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
      expect(runner.followUp(SID, { turnId: 'f2', text: 'next', clientRef: 'r2' })).toEqual({ queuedBehind: '백그라운드 계속' });
      expect(runner.followUp(SID, { turnId: 'f3', text: 'after', clientRef: 'r3' })).toEqual({ queuedBehind: '백그라운드 계속' });
      // Were they sent on, each would hit the limit again: the fake fails every further run the same way.
      f.push(limited, limited, limited);
      await done;
      expect(readCooldownUntilMs(deps.cooldownDir, 'b', NOW)).toBe(NOW + 3_600_000);
      expect(of(msgs, 'turn_retry')).toEqual([]);
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok, m.errorText])).toEqual([['t1', true, null], ['t1:bg1', false, 'B 계정 사용 한도 도달 · 03:50 리셋 · 대안 계정 없음']]);
      expect(of(msgs, 'error').map((m) => [m.turnId, m.clientRef, m.sessionId])).toEqual([['f2', 'r2', SID], ['f3', 'r3', SID]]);
      expect(of(msgs, 'turn_started').map((m) => m.turnId)).toEqual(['t1', 't1:bg1']);
      expect(f.state.calls).toBe(1);
      expect(runner.resendingFor(SID)).toBe(false);
      // The segment's own retry stays booked (nothing overwrote it): it goes on by itself once the limit lifts.
      expect(deps.store.get(SID)?.pendingRetry).toMatchObject({ text: '이어서 진행해 주세요.', hops: 1 });
    });

    /** 다른 AI 로 이어가기 wired in (setting on, ws's hook), GPT taking the work when `gpt`; usage with a GPT card. */
    async function crossSetup(o: { gpt: boolean; on?: boolean; gptLimitOn?: string; gemini?: boolean }) {
      const resetsAt = new Date(NOW + 36 * 3_600_000).toISOString();
      const card = (id: string, s: number, w: number) => ({ id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [{ label: 'Session (5h)', used: s, resetsAt }, { label: 'Weekly (7d)', used: w, resetsAt }, { label: 'Fable (7d)', used: 0, resetsAt }] });
      const cards = [card('claude:main', 13, 7), card('claude:second', 2, 3), card('claude:third', 0, 91), { id: 'codex', status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [{ label: 'Weekly (7d)', used: 10 }] }];
      const usage = new UsageService({ mode: 'usage-deck', accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards }) }), now: () => new Date(NOW) });
      await usage.pollOnce();
      const s = await setup({ usage, move: okMove });
      const codexCalls: { prompt: string; resumeThreadId: string | null }[] = [];
      const geminiCalls: { prompt: string; resumeSessionId: string | null }[] = [];
      Object.assign(s.deps, {
        crossEngineFailover: () => o.on ?? true, findRollout: async () => null, readRateLimits: async () => null,
        codex: o.gpt ? { async *runTurn(req: { prompt: string; resumeThreadId: string | null }) {
          codexCalls.push(req);
          const ok = req.prompt !== o.gptLimitOn;
          yield { kind: 'init', sessionId: 'tid-x', model: 'gpt-6-sol' };
          yield { kind: 'result', sessionId: 'tid-x', ok, text: ok ? 'ok' : '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, errorText: ok ? null : 'usage limit reached for this week', stderr: null, errorKind: null, terminalReason: ok ? 'completed' : null };
        } } : null,
        ...(o.gemini ? {
          autoRoute: () => ({ autoEngines: ['claude', 'codex', 'gemini', 'grok'], autoConsent: ['gemini'], grokFast: false, crossEngineFailover: true }),
          gemini: { loggedIn: (a: string) => a === 'g1', engine: { async *runTurn(req: { prompt: string; resumeSessionId: string | null }) {
            geminiCalls.push(req);
            yield { kind: 'init', sessionId: 'gem-1', model: 'gemini-2.5-pro' };
            yield { kind: 'result', sessionId: 'gem-1', ok: true, text: 'ok', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' };
          } } },
        } : {}),
      });
      const handoffs: { engine: string; turnId: string; text: string }[] = [];
      s.sink.crossEngine = async (c) => { handoffs.push(c); return { excerpt: 'User: q\nClaude: a' }; };
      return { ...s, codexCalls, geminiCalls, handoffs };
    }

    it('다른 AI 로 이어가기 inside the line: a follow-up that hits GPT\'s limit moves to Gemini, and the next one follows it there — not a new session each', async () => {
      const ASK = '이 함수가 무엇을 하는지 설명해 줘';
      const ASK2 = '이 모듈이 무엇을 하는지 설명해 줘';
      const { f, msgs, sink, runner, codexCalls, geminiCalls, handoffs } = await crossSetup({ gpt: true, gptLimitOn: ASK, gemini: true });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'));
      await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
      runner.followUp(SID, { turnId: 'f2', text: ASK, clientRef: 'r2' });
      runner.followUp(SID, { turnId: 'f3', text: ASK2, clientRef: 'r3' });
      f.push(limited);
      await done;
      expect(handoffs.map((h) => [h.engine, h.turnId])).toEqual([['codex', 't1:bg1:x1'], ['gemini', 'f2:x1']]);
      expect(codexCalls.map((r) => r.prompt)).toEqual(['이어서 진행해 주세요.', ASK]);
      expect(geminiCalls.map((r) => [r.prompt.endsWith(ASK) ? 'f2' : r.prompt.endsWith(ASK2) ? 'f3' : r.prompt, r.resumeSessionId])).toEqual([['f2', null], ['f3', 'gem-1']]);
      expect(of(msgs, 'turn_started').filter((m) => m.turnId === 'f3').map((m) => m.sessionId)).toEqual(['gem-1']);
      expect(of(msgs, 'error')).toEqual([]);
    });

    it('다른 AI 로 이어가기: with no Claude account left the segment goes on in a new GPT session, and the two follow-ups waiting follow it there in order', async () => {
      const { f, msgs, sink, runner, deps, codexCalls, handoffs } = await crossSetup({ gpt: true });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'));
      await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
      expect(runner.followUp(SID, { turnId: 'f2', text: 'next', clientRef: 'r2', model: 'opus' })).toEqual({ queuedBehind: '백그라운드 계속' });
      expect(runner.followUp(SID, { turnId: 'f3', text: 'after', clientRef: 'r3' })).toEqual({ queuedBehind: '백그라운드 계속' });
      f.push(limited);
      await done;
      expect(handoffs).toEqual([expect.objectContaining({ engine: 'codex', turnId: 't1:bg1:x1', text: '이어서 진행해 주세요.' })]);
      expect(codexCalls.map((r) => [r.prompt, r.resumeThreadId])).toEqual([['이어서 진행해 주세요.', null], ['next', 'tid-x'], ['after', 'tid-x']]);
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', false], ['t1:bg1:x1', true], ['f2', true], ['f3', true]]);
      expect(of(msgs, 'turn_result')[1]!.errorText).toEqual(expect.stringContaining('Claude 한도가 차서 GPT 로 이어갑니다'));
      expect(of(msgs, 'turn_started').filter((m) => m.turnId === 'f2' || m.turnId === 'f3').map((m) => [m.turnId, m.clientRef, m.sessionId])).toEqual([['f2', 'r2', 'tid-x'], ['f3', 'r3', 'tid-x']]);
      expect(of(msgs, 'error')).toEqual([]);
      expect(f.state.calls).toBe(1);
      expect(runner.resendingFor(SID)).toBe(false);
      expect(deps.store.get(SID)?.pendingRetry).toBeUndefined();
    });

    it('다른 AI 로 이어가기 with no other engine (or the setting off): the follow-ups waiting are refused together, in order, as before', async () => {
      for (const o of [{ gpt: false }, { gpt: true, on: false }]) {
        const { f, msgs, sink, runner, deps, codexCalls, handoffs } = await crossSetup(o);
        const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
        f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
        await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
        f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'));
        await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
        runner.followUp(SID, { turnId: 'f2', text: 'next', clientRef: 'r2' });
        runner.followUp(SID, { turnId: 'f3', text: 'after', clientRef: 'r3' });
        f.push(limited, limited, limited);
        await done;
        expect(handoffs).toEqual([]);
        expect(codexCalls).toEqual([]);
        expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok, m.errorText])).toEqual([['t1', true, null], ['t1:bg1', false, 'B 계정 사용 한도 도달 · 03:50 리셋 · 대안 계정 없음']]);
        expect(of(msgs, 'error').map((m) => [m.turnId, m.clientRef, m.sessionId])).toEqual([['f2', 'r2', SID], ['f3', 'r3', SID]]);
        expect(f.state.calls).toBe(1);
        expect(runner.resendingFor(SID)).toBe(false);
        expect(deps.store.get(SID)?.pendingRetry).toMatchObject({ text: '이어서 진행해 주세요.', hops: 1 });
      }
    });

    it('the other account refusing the continuation before it starts: the queued follow-up still goes on, before a later send', async () => {
      const { f, msgs, sink, runner } = await setup({ usage: await usageCards(), move: okMove });
      const real = runner.run.bind(runner);
      // The continuation on the other account is refused the way an unresumable session is (no turn_started).
      runner.run = async (p, s) => {
        if (p.turnId === 't1:bg1') { s.emit({ type: 'error', turnId: null, message: '이 세션을 열 수 없습니다' }); return; }
        return real(p, s);
      };
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'));
      await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
      runner.followUp(SID, { turnId: 'f2', text: 'next', clientRef: 'r2' });
      f.push(limited);
      await waitFor(() => f.state.calls === 2, 'the queued follow-up sent on');
      expect(runner.followUp(SID, { turnId: 'f3', text: 'later', clientRef: 'r3' })).toEqual({ queuedBehind: RESEND_NOTICE });
      f.push(cli.init(SID), cli.result('two', SID));
      await waitFor(() => f.state.calls === 3, 'the later send after it');
      f.push(cli.init(SID), cli.result('three', SID));
      await done;
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', false], ['f2', true], ['f3', true]]);
      expect(of(msgs, 'error').filter((m) => m.clientRef)).toEqual([]);
      expect(f.inputs.slice(-2).map((m) => JSON.stringify(m))).toEqual([expect.stringContaining('next'), expect.stringContaining('later')]);
    });

    it('order: the continuation on the other account, then the follow-ups that waited behind it (queued, or sent while the process closed), then a later send', async () => {
      const { f, msgs, sink, runner } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'));
      await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
      runner.followUp(SID, { turnId: 'f2', text: 'next', clientRef: 'r2' });
      f.push(limited);
      await waitFor(() => of(msgs, 'turn_retry').length === 1, 'the failover');
      // Sent while the failed process closes / the continuation starts: it waits, never refused as busy.
      expect(runner.followUp(SID, { turnId: 'f3', text: 'meanwhile', clientRef: 'r3' })).toMatchObject({ queuedBehind: expect.any(String) });
      await waitFor(() => f.state.calls === 2, 'the continuation on the other account');
      f.push(cli.init(SID), cli.result('resumed', SID));
      await waitFor(() => f.state.calls === 3, 'f2');
      expect(runner.followUp(SID, { turnId: 'f4', text: 'later', clientRef: 'r4' })).toEqual({ queuedBehind: RESEND_NOTICE });
      f.push(cli.init(SID), cli.result('two', SID));
      await waitFor(() => f.state.calls === 4, 'f3');
      f.push(cli.init(SID), cli.result('three', SID));
      await waitFor(() => f.state.calls === 5, 'f4');
      f.push(cli.init(SID), cli.result('four', SID));
      await done;
      expect(of(msgs, 'error').filter((m) => m.clientRef)).toEqual([]);
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', true], ['f2', true], ['f3', true], ['f4', true]]);
      expect(f.inputs.slice(-3).map((m) => JSON.stringify(m))).toEqual([expect.stringContaining('next'), expect.stringContaining('meanwhile'), expect.stringContaining('later')]);
    });

    it('a follow-up sent on carries its own fast setting (and the held turn\'s when it gave none)', async () => {
      const { f, msgs, sink, runner } = await setup();
      const real = runner.run.bind(runner);
      const sent: [string, boolean | undefined][] = [];
      runner.run = async (p, s) => { if (p.turnId !== 't1') sent.push([p.turnId, p.fast]); return real(p, s); };
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', fast: true }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('working'));
      await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
      runner.followUp(SID, { turnId: 'f1', text: 'first', clientRef: 'r1', fast: false });
      runner.followUp(SID, { turnId: 'f2', text: 'second', clientRef: 'r2' });
      f.end();
      await waitFor(() => f.state.calls === 2, 'first follow-up resumed');
      f.push(cli.init(SID), cli.result('one', SID));
      await waitFor(() => f.state.calls === 3, 'second follow-up resumed');
      f.push(cli.init(SID), cli.result('two', SID));
      await done;
      expect(sent).toEqual([['f1', false], ['f2', true]]);
    });

    it('an automatic retry that went in as a follow-up says so, and failing on a limit books its text with the next hop', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(runner.followUp(SID, { turnId: 'f1', text: '고쳐 줘', retryHop: 1 })).toEqual({ queuedBehind: null });
      expect(of(msgs, 'turn_notice').filter((m) => m.turnId === 'f1').map((m) => m.message)).toContain(AUTO_RETRY_NOTICE);
      f.push(limited);
      await done;
      expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f1', ok: false, errorText: expect.stringContaining('대안 계정 없음') });
      expect(deps.store.get(SID)?.pendingRetry).toMatchObject({ text: '고쳐 줘', hops: 2 });
    });

    it('a follow-up that got going (text out) before the limit is booked as the 계속 request, not sent again', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(runner.followUp(SID, { turnId: 'f1', text: '고쳐 줘' })).toEqual({ queuedBehind: null });
      f.push(cli.delta('half'), limited);
      await done;
      expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f1', ok: false, errorText: expect.stringContaining('대안 계정 없음') });
      expect(deps.store.get(SID)?.pendingRetry).toMatchObject({ text: '이어서 진행해 주세요.', hops: 1 });
    });

    it('보안 #3: a commanderHop process failing with no account left books its retry (continuation or follow-up) with the hop', async () => {
      const a = await setup({ usage: await usageCards(), move: okMove });
      const doneA = a.runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2, commanderHop: 2 }, a.sink);
      a.f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(a.msgs, 'turn_result').length === 1, 'first result');
      a.f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('half'), limited);
      await doneA;
      expect(a.deps.store.get(SID)?.pendingRetry).toEqual(expect.objectContaining({ text: '이어서 진행해 주세요.', hops: 1, commanderHop: 2 }));

      const b = await setup({ usage: await usageCards(), move: okMove });
      const doneB = b.runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2, commanderHop: 5 }, b.sink);
      b.f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(b.msgs, 'turn_result').length === 1, 'first result');
      expect(b.runner.followUp(SID, { turnId: 'f1', text: '고쳐 줘', retryHop: 1 })).toEqual({ queuedBehind: null });
      b.f.push(limited);
      await doneB;
      expect(b.deps.store.get(SID)?.pendingRetry).toEqual(expect.objectContaining({ text: '고쳐 줘', hops: 2, commanderHop: 5 }));
    });

    it('a follow-up with files failing on a limit with no account left is not booked', async () => {
      const img: Attachment = { id: 'i1', name: 'a.png', mediaType: 'image/png', size: 1, path: '/w/a.png', isImage: true, createdAtMs: 0 };
      const attachments = { resolve: () => ({ found: [img], missing: [] }) } as unknown as AttachmentStore;
      const { f, msgs, sink, runner, deps } = await setup({ attachments, usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
      f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(runner.followUp(SID, { turnId: 'f1', text: 'look', attachments: ['i1'] })).toEqual({ queuedBehind: null });
      await waitFor(() => of(msgs, 'turn_started').some((m) => m.turnId === 'f1'), 'follow-up start');
      f.push(limited);
      await done;
      expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f1', ok: false, errorText: expect.stringContaining('대안 계정 없음') });
      expect(deps.store.get(SID)).not.toHaveProperty('pendingRetry');
    });
  });
});

describe('TurnRunner: prompt suggestion after the turn result', () => {
  it('forwards the CLI suggestion as prompt_suggestion, scoped to the turn, after turn_result', async () => {
    const { f, msgs, sink, runner } = await setup({ promptSuggestions: true });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.delta('ok'), cli.result('ok', SID), { type: 'prompt_suggestion', suggestion: '커밋해줘', uuid: 'u', session_id: SID });
    await done;
    const types = msgs.map((m) => m.type);
    expect(types.indexOf('prompt_suggestion')).toBeGreaterThan(types.indexOf('turn_result'));
    expect(of(msgs, 'prompt_suggestion')).toEqual([{ type: 'prompt_suggestion', turnId: 't1', sessionId: SID, cwd: '/w/new', text: '커밋해줘' }]);
  });

  it('a follow-up while the process only waits for its suggestion (after background work) goes in, no error', async () => {
    const { f, msgs, sink, runner } = await setup({ promptSuggestions: true, suggestWaitMs: 60_000 });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.bgLevel([{ id: 'x', desc: 'build' }]), cli.result('launched', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    // Background done, its continuation answers: nothing is left, so the engine now only waits for the suggestion.
    f.push(cli.bgLevel([]), cli.notifyUser(), cli.delta('built'), cli.result('built', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 2, 'continuation result');
    await new Promise((r) => setTimeout(r, 20));
    const users = () => (f.inputs as unknown as { type: string }[]).filter((m) => m.type === 'user').length;
    expect(runner.followUp(SID, { turnId: 'f1', text: 'ship it' })).toEqual({ queuedBehind: null });
    await waitFor(() => users() === 2, 'follow-up written');
    f.push(cli.result('shipped', SID), { type: 'prompt_suggestion', suggestion: '배포 확인', uuid: 'u', session_id: SID });
    await done;
    expect(of(msgs, 'error')).toEqual([]);
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok, m.text])).toEqual([['t1', true, 'launched'], ['t1:bg1', true, 'built'], ['f1', true, 'shipped']]);
    expect(of(msgs, 'prompt_suggestion')).toMatchObject([{ turnId: 'f1', text: '배포 확인' }]);
  });

  it('an automatic turn (commanderHop) asks for no suggestion', async () => {
    const { f, msgs, sink, runner } = await setup({ promptSuggestions: true, suggestWaitMs: 60_000 });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', commanderHop: 1 }, sink);
    f.push(cli.init(SID), cli.result('ok', SID));
    await done;
    expect((f.inputs as unknown as { type: string }[]).map((m) => m.type)).toEqual(['user']);
    expect(of(msgs, 'turn_result')).toHaveLength(1);
  });

  it('an aborted turn emits no suggestion', async () => {
    const { f, msgs, sink, ac, runner } = await setup({ promptSuggestions: true, suggestWaitMs: 60_000 });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(cli.init(SID), cli.result('ok', SID));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'result');
    ac.abort();
    f.push({ type: 'prompt_suggestion', suggestion: '늦음', uuid: 'u', session_id: SID });
    await done;
    expect(of(msgs, 'prompt_suggestion')).toEqual([]);
  });
});
