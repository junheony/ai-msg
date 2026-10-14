import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import type { ServerMessage } from '../../shared/protocol';
import type { Attachment, AttachmentStore } from '../attachments/AttachmentStore';
import { ClaudeEngine } from '../engine/ClaudeEngine';
import { fakeSdk, sdk } from '../engine/fakeSdk';
import { readCooldownUntilMs } from '../routing/cooldown';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { AUTO_RETRY_NOTICE, SHUTDOWN_ABORT, SHUTDOWN_ABORTED, TurnRunner, type TurnRunnerDeps, type TurnSink } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-09-30T12:30:00Z');

async function setup(over: Partial<Pick<TurnRunnerDeps, 'attachments' | 'usage' | 'move'>> & { readFile?: (p: string) => Promise<Buffer> } = {}) {
  const f = fakeSdk();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-trbg-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const usage = over.usage ?? new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), now: () => new Date(NOW) });
  /** The SDK options of each process started. */
  const options: (Options | undefined)[] = [];
  const deps: TurnRunnerDeps = {
    accounts: testRegistry(),
    engine: new ClaudeEngine({ accounts: testRegistry(), queryFn: (p) => { options.push(p.options); return f.queryFn(p); }, readFile: over.readFile ?? (async () => Buffer.from('')) }),
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
  };
  const msgs: ServerMessage[] = [];
  const ac = new AbortController();
  const sink: TurnSink = { emit: (m) => msgs.push(m), askPermission: async () => 'once', askQuestion: async () => null, signal: ac.signal };
  const runner = new TurnRunner(deps);
  return { f, msgs, sink, ac, runner, store, options, deps };
}

/** Usage cards for a/b/c: a new session routes to b; with b out, a (protected, the one other account with room — c is at weekly 91). */
async function usageCards(): Promise<UsageService> {
  const resetsAt = new Date(NOW + 36 * 3_600_000).toISOString();
  const card = (id: string, s: number, w: number, fb: number) => ({ id, status: 'ok', fetchedAt: new Date(NOW - 10_000).toISOString(), rows: [
    { label: 'Session (5h)', used: s, resetsAt }, { label: 'Weekly (7d)', used: w, resetsAt }, { label: 'Fable (7d)', used: fb, resetsAt }] });
  const state = { cards: [card('claude:main', 13, 7, 0), card('claude:second', 2, 3, 4), card('claude:third', 0, 91, 27)] };
  const u = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => state }), now: () => new Date(NOW) });
  await u.pollOnce();
  return u;
}

/** A session move that always succeeds (the fake SDK writes no transcript to move). */
const okMove: NonNullable<TurnRunnerDeps['move']> = async (o) => ({ ok: true, targetDir: path.join(o.targetProjectsRoot, path.basename(o.sourceProjectDir)), targetFile: '', copied: [] });

const LIMIT_TEXT = "You've hit your session limit · resets 3:50am (Asia/Seoul)";
const limited = { ...sdk.result('', 's1'), is_error: true, result: LIMIT_TEXT };

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** What the process's UserPromptSubmit hook adds to its first prompt (undefined: no hook or nothing added). */
async function promptNote(o: Options | undefined): Promise<string | undefined> {
  const hook = o?.hooks?.UserPromptSubmit?.[0]?.hooks[0];
  if (!hook) return undefined;
  const out = (await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 's1', transcript_path: '/t', cwd: '/w' } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { additionalContext?: string } };
  return out.hookSpecificOutput?.additionalContext;
}

const of = (msgs: ServerMessage[], type: ServerMessage['type']) => msgs.filter((m) => m.type === type) as (ServerMessage & Record<string, unknown>)[];

describe('TurnRunner: background work after the turn result', () => {
  it('streams the continuation as its own turn with a 백그라운드 계속 marker and badge', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'explore repo' }]), sdk.delta('launched'), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    expect(of(msgs, 'turn_background')).toMatchObject([{ type: 'turn_background', turnId: 't1', sessionId: 's1', cwd: '/w/new', tasks: ['explore repo'] }]);
    expect(runner.backgroundSessions()).toEqual(['s1']);

    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('found'), sdk.result('found', 's1'));
    await done;
    const started = of(msgs, 'turn_started');
    expect(started.map((m) => [m.turnId, m.reason])).toEqual([['t1', expect.any(String)], ['t1:bg1', '백그라운드 계속']]);
    expect(of(msgs, 'turn_notice').at(-1)).toMatchObject({ turnId: 't1:bg1', message: expect.stringContaining('백그라운드 계속') });
    expect(of(msgs, 'delta').map((m) => [m.turnId, m.text])).toEqual([['t1', 'launched'], ['t1:bg1', 'found']]);
    const results = of(msgs, 'turn_result');
    expect(results[1]).toMatchObject({ turnId: 't1:bg1', ok: true, text: 'found', badge: { reason: '백그라운드 계속', usage: { outputTokens: 2 } } });
    expect(of(msgs, 'turn_background').at(-1)).toMatchObject({ tasks: [] });
    expect(runner.backgroundSessions()).toEqual([]);
    expect(runner.followUp('s1', { turnId: 'late', text: 'x' })).toBe(false);
    expect(f.state.calls).toBe(1);
  });

  it('a background task settling after the turn result emits task_done (drives the push)', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(sdk.taskDone('x'), sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('built'), sdk.result('built', 's1'));
    await done;
    expect(of(msgs, 'task_done')).toMatchObject([{ type: 'task_done', turnId: 't1', sessionId: 's1', cwd: '/w/new', status: 'completed', summary: 'done' }]);
    expect(of(msgs, 'turn_result').map((m) => m.turnId)).toEqual(['t1', 't1:bg1']);
  });

  it('a follow-up while waiting goes into the same process at once; one during a continuation waits for its result', async () => {
    const { f, msgs, sink, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');

    expect(runner.followUp('s1', { turnId: 'f1', text: 'status?', clientRef: 'r1', model: 'sonnet' })).toEqual({ queuedBehind: null });
    await waitFor(() => f.inputs.length === 2, 'follow-up written');
    expect(of(msgs, 'turn_started').at(-1)).toMatchObject({ turnId: 'f1', clientRef: 'r1', reason: '백그라운드 대기 중 이어 보냄' });
    f.push(sdk.delta('still building'), sdk.result('still building', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 2, 'follow-up result');
    expect(of(msgs, 'turn_result')[1]).toMatchObject({ turnId: 'f1', text: 'still building', badge: { modelNote: '백그라운드 대기 중인 프로세스의 모델 유지' } });

    // Background finishes; while its continuation streams, another message arrives and is queued.
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('built'));
    await waitFor(() => of(msgs, 'delta').some((m) => m.text === 'built'), 'continuation output');
    // Taken, but held in deck until the continuation's result: the caller is told which segment it waits behind.
    expect(runner.followUp('s1', { turnId: 'f2', text: 'ship it' })).toEqual({ queuedBehind: '백그라운드 계속' });
    await new Promise((r) => setTimeout(r, 5));
    expect(f.inputs).toHaveLength(2);
    f.push(sdk.result('built', 's1'));
    await waitFor(() => f.inputs.length === 3, 'queued follow-up written after the continuation');
    expect(of(msgs, 'turn_started').map((m) => m.turnId)).toEqual(['t1', 'f1', 't1:bg1', 'f2']);
    f.push(sdk.result('shipped', 's1'));
    await done;
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.text])).toEqual([['t1', 'launched'], ['f1', 'still building'], ['t1:bg1', 'built'], ['f2', 'shipped']]);
  });

  it('cancelQueued takes a waiting follow-up back out by its clientRef; one already in, an unknown ref or no process: null', async () => {
    const { f, msgs, sink, runner } = await setup();
    expect(runner.cancelQueued('s1', 'r1')).toBeNull();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('built'));
    await waitFor(() => of(msgs, 'delta').some((m) => m.text === 'built'), 'continuation output');
    expect(runner.followUp('s1', { turnId: 'f1', text: 'first', clientRef: 'r1' })).toEqual({ queuedBehind: '백그라운드 계속' });
    expect(runner.followUp('s1', { turnId: 'f2', text: 'second', clientRef: 'r2' })).toEqual({ queuedBehind: '백그라운드 계속' });
    expect(runner.cancelQueued('s1', 'nope')).toBeNull();
    expect(runner.cancelQueued('s1', 'r1')).toBe('f1');
    expect(runner.cancelQueued('s1', 'r1')).toBeNull();
    f.push(sdk.result('built', 's1'));
    await waitFor(() => f.inputs.length === 2, 'the remaining follow-up written after the continuation');
    expect(of(msgs, 'turn_started').map((m) => m.turnId)).toEqual(['t1', 't1:bg1', 'f2']);
    // Already handed to the process: nothing to withdraw.
    expect(runner.cancelQueued('s1', 'r2')).toBeNull();
    f.push(sdk.result('done', 's1'));
    await done;
    expect(of(msgs, 'turn_result').map((m) => m.turnId)).toEqual(['t1', 't1:bg1', 'f2']);
    expect(of(msgs, 'error')).toEqual([]);
  });

  it('stop while a continuation streams ends it as 중단됨 and refuses the queued follow-up with its clientRef', async () => {
    const { f, msgs, sink, ac, runner } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    expect(runner.followUp('s1', { turnId: 'f1', text: 'next', clientRef: 'r9' })).toEqual({ queuedBehind: '백그라운드 계속' });
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
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    expect(runner.followUp('s1', { turnId: 'f1', text: 'next', clientRef: 'r9' })).toEqual({ queuedBehind: '백그라운드 계속' });
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
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('built'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
    expect(runner.followUp('s1', { turnId: 'f1', text: 'ship it', clientRef: 'r1' })).toEqual({ queuedBehind: '백그라운드 계속' });
    f.push(sdk.result('built', 's1'));
    await waitFor(() => f.inputs.length === 2, 'queued follow-up written');
    expect(seen).toEqual([false, true]);
    f.push(sdk.result('shipped', 's1'));
    await done;
    expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', true], ['f1', true]]);
  });

  it('a follow-up that could not be written after its turn_started also sends an error with its clientRef (its accepted ref is taken back)', async () => {
    const img: Attachment = { id: 'i1', name: 'a.png', mediaType: 'image/png', size: 1, path: '/gone/a.png', isImage: true, createdAtMs: 0 };
    const attachments = { resolve: () => ({ found: [img], missing: [] }) } as unknown as AttachmentStore;
    const { f, msgs, sink, runner } = await setup({ attachments, readFile: async () => { throw new Error('gone'); } });
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    expect(runner.followUp('s1', { turnId: 'f1', text: 'look', attachments: ['i1'], clientRef: 'r1' })).toEqual({ queuedBehind: null });
    await waitFor(() => of(msgs, 'error').length === 1, 'refusal');
    expect(of(msgs, 'turn_started').at(-1)).toMatchObject({ turnId: 'f1', clientRef: 'r1' });
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f1', ok: false, errorText: '메시지를 보내지 못했습니다' });
    expect(of(msgs, 'error')[0]).toMatchObject({ turnId: 'f1', clientRef: 'r1', message: '메시지를 보내지 못했습니다' });
    f.push(sdk.bgLevel([]));
    f.end();
    await done;
  });

  it('the restart deadline cutting background work says so in the pane, and the next turn tells the user and the model once', async () => {
    const { f, msgs, sink, ac, runner, store, options } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }, { id: 'y', desc: 'watch logs' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    ac.abort(SHUTDOWN_ABORT);
    await done;
    const notice = of(msgs, 'turn_notice').at(-1);
    expect(notice).toMatchObject({ turnId: 't1', sessionId: 's1', message: '서버가 다시 시작되어 백그라운드 작업 2개가 중단됨: build, watch logs' });
    // The notice goes out before the tasks are cleared.
    expect(msgs.indexOf(notice!)).toBeLessThan(msgs.indexOf(of(msgs, 'turn_background').at(-1)!));
    expect(of(msgs, 'turn_background').at(-1)).toMatchObject({ tasks: [] });
    expect(store.get('s1')).toMatchObject({ interrupted: { atMs: NOW, tasks: ['build', 'watch logs'] } });
    expect(options[0]?.systemPrompt).toBeUndefined();

    const msgs2: ServerMessage[] = [];
    const sink2: TurnSink = { ...sink, emit: (m) => msgs2.push(m), signal: new AbortController().signal };
    const next = runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 's1', text: 'again' }, sink2);
    f.push(sdk.init('s1'), sdk.result('ok', 's1'));
    await next;
    const at = new Date(NOW).toTimeString().slice(0, 5);
    expect(of(msgs2, 'turn_notice').map((m) => m.message)).toContain(`${at} 서버 재시작으로 백그라운드 작업 2개가 끊겼습니다: build, watch logs — 모델에게 알렸습니다`);
    // Told on the first prompt only (UserPromptSubmit additionalContext); the system prompt stays as on every turn.
    expect(options[1]?.systemPrompt).toBeUndefined();
    expect(await promptNote(options[1])).toEqual(expect.stringMatching(/"build", "watch logs".*이미 다시 띄웠거나 더 필요 없으면 무시하세요\.$/));
    expect(store.get('s1')).not.toHaveProperty('interrupted');
    expect(of(msgs2, 'turn_result').at(-1)).toMatchObject({ turnId: 't2', ok: true });
  });

  it('the restart deadline cutting a turn that runs background work: its result says so (no second notice), the work is kept for the next turn', async () => {
    const { f, msgs, sink, ac, runner, store } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.delta('working'));
    await waitFor(() => of(msgs, 'delta').length === 1, 'turn output');
    ac.abort(SHUTDOWN_ABORT);
    await done;
    expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 't1', ok: false, errorText: SHUTDOWN_ABORTED });
    expect(of(msgs, 'turn_notice')).toEqual([]);
    expect(store.get('s1')).toMatchObject({ interrupted: { atMs: NOW, tasks: ['build'] } });
  });

  const seedCut = async (store: SessionStateStore, atMs = NOW) => {
    await store.set({ sessionId: 's1', cwd: '/w/new', account: 'a', projectDir: '/w/proj', lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus', title: 'kept', interrupted: { atMs, tasks: ['build'] } });
  };
  const failed = { ...sdk.result('', 's1'), subtype: 'error_during_execution', is_error: true, result: undefined };

  it('a turn that fails before the model got the note keeps the cut for the next turn; the one that gets through clears it', async () => {
    const { f, sink, runner, store, options } = await setup();
    await seedCut(store);
    // An engine error: the note was offered, but no answer came — told again next turn.
    f.push(sdk.init('s1'), failed);
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: 's1', text: 'go' }, sink);
    expect(await promptNote(options[0])).toContain('"build"');
    expect(store.get('s1')).toMatchObject({ interrupted: { atMs: NOW, tasks: ['build'] } });
    // A stop before the first attempt: same.
    const stopped = new AbortController();
    stopped.abort();
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 's1', text: 'go' }, { ...sink, signal: stopped.signal });
    expect(store.get('s1')).toMatchObject({ interrupted: { atMs: NOW, tasks: ['build'] } });
    f.push(sdk.init('s1'), sdk.result('ok', 's1'));
    await runner.run({ turnId: 't3', cwd: '/w/new', sessionId: 's1', text: 'go' }, { ...sink, signal: new AbortController().signal });
    expect(await promptNote(options.at(-1))).toContain('"build"');
    expect(store.get('s1')).not.toHaveProperty('interrupted');
  });

  it('a handoff-note turn leaves the cut alone (no note, no notice); a cut from another day shows its date', async () => {
    const { f, msgs, sink, runner, store, options } = await setup();
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    await seedCut(store, yesterday);
    f.push(sdk.init('s1'), sdk.result('note', 's1'));
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: 's1', text: 'hand off', handoff: true }, sink);
    expect(await promptNote(options[0])).toBeUndefined();
    expect(of(msgs, 'turn_notice').filter((m) => String(m.message).includes('서버 재시작'))).toEqual([]);
    expect(store.get('s1')).toMatchObject({ interrupted: { atMs: yesterday, tasks: ['build'] } });

    f.push(sdk.init('s1'), sdk.result('ok', 's1'));
    await runner.run({ turnId: 't2', cwd: '/w/new', sessionId: 's1', text: 'go' }, sink);
    const d = new Date(yesterday);
    const at = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 5)}`;
    expect(of(msgs, 'turn_notice').map((m) => m.message)).toContain(`${at} 서버 재시작으로 백그라운드 작업 1개가 끊겼습니다: build — 모델에게 알렸습니다`);
    expect(await promptNote(options[1])).toContain(`${at} 에 deck 서버 재시작으로`);
    expect(store.get('s1')).not.toHaveProperty('interrupted');
  });

  it('a user stop of a held process is not recorded as a restart cut', async () => {
    const { f, msgs, sink, ac, runner, store } = await setup();
    const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
    await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
    ac.abort();
    await done;
    expect(of(msgs, 'turn_notice')).toEqual([]);
    expect(store.get('s1')).not.toHaveProperty('interrupted');
  });

  it('no background work: no follow-up channel, nothing after the result', async () => {
    const { f, msgs, sink, runner } = await setup();
    f.push(sdk.init('s1'), sdk.delta('ok'), sdk.result('ok', 's1'));
    await runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
    expect(msgs.map((m) => m.type)).toEqual(['turn_started', 'delta', 'turn_result']);
    expect(runner.followUp('s1', { turnId: 'f', text: 'x' })).toBe(false);
  });

  describe('a segment hitting a limit goes on on another account', () => {
    it('a background continuation: cooldown, turn_retry + notice, a new turn on the other account told what was cut; no failed result', async () => {
      const { f, msgs, sink, runner, store, options, deps } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(of(msgs, 'turn_started')[0]).toMatchObject({ account: 'b' });
      f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('half'), limited);
      await waitFor(() => f.state.calls === 2, 'the continuation process');
      f.push(sdk.init('s1'), sdk.delta('resumed'), sdk.result('resumed', 's1'));
      await done;

      expect(readCooldownUntilMs(deps.cooldownDir, 'b', NOW)).toBe(NOW + 3_600_000);
      expect(of(msgs, 'turn_retry')).toMatchObject([{ turnId: 't1:bg1', sessionId: 's1', fromAccount: 'b', toAccount: 'a', attempt: 1, reason: expect.stringMatching(/^사용 한도 도달 · 03:50 리셋 → /) }]);
      expect(of(msgs, 'turn_notice').map((m) => m.message)).toContain('B 계정 사용 한도 도달 (03:50 리셋) — A 계정으로 이어서 진행합니다');
      expect(of(msgs, 'turn_started').map((m) => [m.turnId, m.account])).toEqual([['t1', 'b'], ['t1:bg1', 'b'], ['t1:bg1', 'a']]);
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['t1:bg1', true]]);
      expect(of(msgs, 'turn_result')[1]).toMatchObject({ text: 'resumed', badge: { account: 'a' } });
      const at = new Date(NOW).toTimeString().slice(0, 5);
      expect(of(msgs, 'turn_notice').map((m) => m.message)).toContain(`${at} B 계정 사용 한도 도달로 이전 프로세스가 끝났습니다 — 다른 계정에서 이어갑니다 (모델에게 알렸습니다)`);
      expect(await promptNote(options[1])).toContain(`${at} 에 B 계정 사용 한도 도달로`);
      expect(JSON.stringify(f.inputs.at(-1))).toContain('이어서 진행해 주세요.');
      expect(store.get('s1')).toMatchObject({ account: 'a' });
      expect(store.get('s1')).not.toHaveProperty('interrupted');
    });

    it('a follow-up: sent again under its own turn id and text on the other account; background work cut with it is told to the model', async () => {
      const { f, msgs, sink, runner, options, deps } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(runner.followUp('s1', { turnId: 'f1', text: 'status?', clientRef: 'r1' })).toEqual({ queuedBehind: null });
      await waitFor(() => f.inputs.length === 2, 'follow-up written');
      f.push(limited);
      await waitFor(() => f.state.calls === 2, 'the retry process');
      f.push(sdk.init('s1'), sdk.result('fine', 's1'));
      await done;

      expect(readCooldownUntilMs(deps.cooldownDir, 'b', NOW)).toBe(NOW + 3_600_000);
      expect(of(msgs, 'turn_retry')).toMatchObject([{ turnId: 'f1', fromAccount: 'b', toAccount: 'a' }]);
      expect(of(msgs, 'turn_started').map((m) => [m.turnId, m.account])).toEqual([['t1', 'b'], ['f1', 'b'], ['f1', 'a']]);
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok])).toEqual([['t1', true], ['f1', true]]);
      expect(JSON.stringify(f.inputs.at(-1))).toContain('status?');
      expect(await promptNote(options[1])).toEqual(expect.stringContaining('B 계정 사용 한도 도달로 종료되었고, 그때 돌고 있던 백그라운드 작업 1개는 끊겨 결과가 오지 않습니다: "build"'));
      expect(of(msgs, 'error')).toEqual([]);
    });

    it('any other failure of a segment just ends it as failed (no cooldown, no retry)', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go' }, sink);
      f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(sdk.bgLevel([]), sdk.notifyUser(), { ...sdk.result('', 's1'), is_error: true, result: 'boom' });
      await done;
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok, m.errorText])).toEqual([['t1', true, null], ['t1:bg1', false, expect.stringContaining('boom')]]);
      expect(of(msgs, 'turn_retry')).toEqual([]);
      expect(readCooldownUntilMs(deps.cooldownDir, 'b', NOW)).toBeNull();
      expect(f.state.calls).toBe(1);
    });

    it('with no account left (one hop per other account) the segment ends as failed and a queued follow-up is refused', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
      f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('half'));
      await waitFor(() => of(msgs, 'delta').length === 1, 'continuation output');
      expect(runner.followUp('s1', { turnId: 'f2', text: 'next', clientRef: 'r2' })).toEqual({ queuedBehind: '백그라운드 계속' });
      f.push(limited);
      await done;
      expect(readCooldownUntilMs(deps.cooldownDir, 'b', NOW)).toBe(NOW + 3_600_000);
      expect(of(msgs, 'turn_retry')).toEqual([]);
      expect(of(msgs, 'turn_result').map((m) => [m.turnId, m.ok, m.errorText])).toEqual([['t1', true, null], ['t1:bg1', false, 'B 계정 사용 한도 도달 · 03:50 리셋 · 대안 계정 없음']]);
      expect(of(msgs, 'error')).toEqual([expect.objectContaining({ turnId: 'f2', clientRef: 'r2' })]);
      expect(f.state.calls).toBe(1);
      // Booked to go on by itself once the limit lifts (BottleneckWatch fires it), the hop count carried over.
      expect(deps.store.get('s1')?.pendingRetry).toMatchObject({ text: '이어서 진행해 주세요.', hops: 1 });
    });

    it('an automatic retry that went in as a follow-up says so, and failing on a limit books its text with the next hop', async () => {
      const { f, msgs, sink, runner, deps } = await setup({ usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
      f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(runner.followUp('s1', { turnId: 'f1', text: '고쳐 줘', retryHop: 1 })).toEqual({ queuedBehind: null });
      expect(of(msgs, 'turn_notice').filter((m) => m.turnId === 'f1').map((m) => m.message)).toContain(AUTO_RETRY_NOTICE);
      f.push(limited);
      await done;
      expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f1', ok: false, errorText: expect.stringContaining('대안 계정 없음') });
      expect(deps.store.get('s1')?.pendingRetry).toMatchObject({ text: '고쳐 줘', hops: 2 });
    });

    it('a follow-up with files failing on a limit with no account left is not booked', async () => {
      const img: Attachment = { id: 'i1', name: 'a.png', mediaType: 'image/png', size: 1, path: '/w/a.png', isImage: true, createdAtMs: 0 };
      const attachments = { resolve: () => ({ found: [img], missing: [] }) } as unknown as AttachmentStore;
      const { f, msgs, sink, runner, deps } = await setup({ attachments, usage: await usageCards(), move: okMove });
      const done = runner.run({ turnId: 't1', cwd: '/w/new', sessionId: null, text: 'go', failoverHop: 2 }, sink);
      f.push(sdk.init('s1'), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', 's1'));
      await waitFor(() => of(msgs, 'turn_result').length === 1, 'first result');
      expect(runner.followUp('s1', { turnId: 'f1', text: 'look', attachments: ['i1'] })).toEqual({ queuedBehind: null });
      await waitFor(() => of(msgs, 'turn_started').some((m) => m.turnId === 'f1'), 'follow-up start');
      f.push(limited);
      await done;
      expect(of(msgs, 'turn_result').at(-1)).toMatchObject({ turnId: 'f1', ok: false, errorText: expect.stringContaining('대안 계정 없음') });
      expect(deps.store.get('s1')).not.toHaveProperty('pendingRetry');
    });
  });
});
