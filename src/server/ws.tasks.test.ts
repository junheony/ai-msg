import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { TASKS_QUEUED_MAX, type TaskInfo } from '../shared/tasks';
import type { TurnRequest } from './engine/Engine';
import { cookieValueFor } from './auth';
import { StubEngine, okResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import type { PushPayload } from './push/PushNotifier';
import { SettingsStore } from './settings';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionMetaStore } from './sessions/SessionMetaStore';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { TaskRegistry } from './tasks/TaskRegistry';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'd'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let server: http.Server;
let origin = '';
let wsUrl = '';
let base = '';
let work = '';
let wsApi: ReturnType<typeof attachWebSocket>;
let settings: SettingsStore;
let store: SessionStateStore;
let tasks: TaskRegistry;
const pushed: PushPayload[] = [];
const notified: ServerMessage[] = [];
const calls: TurnRequest[] = [];
const permDecisions: string[] = [];
const gates = new Map<string, () => void>();
const gate = (name: string) => new Promise<void>((r) => gates.set(name, r));

function card(id: string) {
  return { id, status: 'ok', fetchedAt: new Date().toISOString(), rows: [{ label: 'Session (5h)', used: 1 }, { label: 'Weekly (7d)', used: 1, resetsAt: new Date(Date.now() + 36e5).toISOString() }] };
}

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wst-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wst-work-')));
  const meta = new SessionMetaStore(path.join(base, 'session-meta.json'));
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json'), meta });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [card('claude:main'), card('claude:second'), card('claude:third')] }) }) });
  await usage.pollOnce();
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  let n = 0;
  const stub = new StubEngine(async (req) => {
    calls.push(req);
    const sid = `11111111-1111-4111-8111-${String(++n).padStart(12, '0')}`;
    if (req.prompt.startsWith('slow')) {
      const g = gate(req.prompt);
      return (async function* () { yield { kind: 'init' as const, sessionId: sid, model: 'm' }; await g; yield okResult(sid, `## 결과\n${req.prompt} 끝났습니다.\n\n자세히…`); })();
    }
    if (req.prompt === 'ask-perm') {
      return (async function* () {
        yield { kind: 'init' as const, sessionId: sid, model: 'm' };
        permDecisions.push(await req.onPermission({ toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: 'tu-task' }));
        yield okResult(sid, '권한 뒤 끝');
      })();
    }
    if (req.prompt === 'boom') return [{ kind: 'init', sessionId: sid, model: 'm' }, { kind: 'result', sessionId: sid, ok: false, text: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, errorText: '엔진 오류', stderr: null, errorKind: null, terminalReason: null } as never];
    return [{ kind: 'init', sessionId: sid, model: 'm' }, okResult(sid, `${req.prompt} 완료`)];
  });
  const runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: stub, usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex-sessions') });
  settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  await settings.set({ taskSoftCap: 1 });
  tasks = new TaskRegistry(path.join(base, 'tasks.json'));
  await tasks.load();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], settings, notify: (m) => notified.push(m), meta, acceptedRefs: new AcceptedRefs(null), tasks, pushTask: (p) => pushed.push(p) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { wsApi.close(); server.close(); await fs.rm(base, { recursive: true, force: true }); await fs.rm(work, { recursive: true, force: true }); });

function open(): Promise<{ ws: WebSocket; msgs: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: COOKIE } });
    const msgs: ServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d)) as ServerMessage));
    ws.once('open', () => resolve({ ws, msgs }));
    ws.once('error', reject);
  });
}

/** What a timed-out wait prints: the test sets it to the state worth seeing. */
let timeoutState: (() => unknown) | null = null;
async function until<T>(f: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout ${JSON.stringify(timeoutState?.())}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const lastTasks = (msgs: ServerMessage[]): Extract<ServerMessage, { type: 'tasks' }> | undefined => msgs.filter((m): m is Extract<ServerMessage, { type: 'tasks' }> => m.type === 'tasks').at(-1);
const byTitle = (msgs: ServerMessage[], title: string): TaskInfo | undefined => lastTasks(msgs)?.tasks.find((t) => t.title === title);

describe('ws · 백그라운드 작업', () => {
  it('advertises tasks and sends the list after hello', async () => {
    const { ws, msgs } = await open();
    const hello = await until(() => msgs.find((m) => m.type === 'hello'));
    expect(hello.type === 'hello' && hello.features).toContain('tasks');
    const list = await until(() => lastTasks(msgs));
    expect(list.cap).toBe(1);
    ws.close();
  });

  it('runs a task as a new auto session in the folder, queues the next behind the soft cap, pushes and posts the result', async () => {
    const { ws, msgs } = await open();
    timeoutState = () => ({ t: lastTasks(msgs), calls: calls.map((c) => c.prompt), errs: msgs.filter((m) => m.type === 'error'), n: notified.slice(-5) });
    await until(() => lastTasks(msgs));
    ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: 'slow-a', fromSessionId: 'from-1', concise: true }));
    ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: 'quick-b', fromSessionId: 'from-1' }));
    await until(() => byTitle(msgs, 'quick-b')?.status === 'queued');
    const a = await until(() => { const t = byTitle(msgs, 'slow-a'); return t?.status === 'running' && t.sessionId ? t : null; });
    const callA = calls.find((c) => c.prompt === 'slow-a')!;
    expect(callA.resumeSessionId).toBeNull();
    expect(callA.cwd).toBe(work);
    expect(callA.appendSystemPrompt).toContain('[deck 간결 모드]');
    // The chat it came from is not the task's session, and nobody got the task's turn events.
    expect(a.fromSessionId).toBe('from-1');
    expect(msgs.some((m) => m.type === 'turn_started')).toBe(false);
    expect(calls.some((c) => c.prompt === 'quick-b')).toBe(false);

    gates.get('slow-a')!();
    const doneA = await until(() => { const t = byTitle(msgs, 'slow-a'); return t?.status === 'done' ? t : null; });
    expect(doneA.line).toBe('결과');
    expect(doneA.sessionId).toBe(a.sessionId);
    const pushA = await until(() => pushed.find((p) => p.tag === `bgtask-${a.taskId}`));
    expect(pushA).toMatchObject({ kind: 'task', title: '작업 완료 · slow-a', sessionId: a.sessionId });
    // The slot freed: the queued one ran.
    const b = await until(() => { const t = byTitle(msgs, 'quick-b'); return t?.status === 'done' ? t : null; });
    expect(b.line).toBe('quick-b 완료');
    expect(calls.find((c) => c.prompt === 'quick-b')?.appendSystemPrompt).toBeUndefined();
    const turnA = (notified.find((m) => m.type === 'turn_result' && m.sessionId === a.sessionId) as { turnId: string }).turnId;
    expect(wsApi.isTaskTurn(turnA)).toBe(true);
    expect(wsApi.isConciseTurn(turnA)).toBe(true);
    expect(wsApi.isConciseTurn((notified.find((m) => m.type === 'turn_result' && m.sessionId === b.sessionId) as { turnId: string }).turnId)).toBe(false);

    ws.send(JSON.stringify({ type: 'dismiss_task', taskId: b.taskId }));
    await until(() => lastTasks(msgs)!.tasks.every((t) => t.taskId !== b.taskId));
    ws.close();
  });

  it('⚡ a background task never runs fast, even if an old client asks', async () => {
    const { ws, msgs } = await open();
    await until(() => lastTasks(msgs));
    ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: 'quick-f', fromSessionId: 'from-1', fast: true }));
    await until(() => byTitle(msgs, 'quick-f')?.status === 'done');
    const call = calls.find((c) => c.prompt === 'quick-f')!;
    expect(call.fast).toBeUndefined();
    ws.close();
  });

  it('a failed task is reported failed and pushed; a bad folder fails before it starts', async () => {
    const { ws, msgs } = await open();
    await until(() => lastTasks(msgs));
    ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: 'boom', fromSessionId: null }));
    const t = await until(() => { const x = byTitle(msgs, 'boom'); return x?.status === 'failed' ? x : null; });
    expect(t.line).toBe('엔진 오류');
    await until(() => pushed.find((p) => p.tag === `bgtask-${t.taskId}` && p.title.startsWith('작업 실패')));
    ws.send(JSON.stringify({ type: 'start_task', cwd: path.join(work, 'nope'), text: 'nowhere', fromSessionId: null }));
    const bad = await until(() => { const x = byTitle(msgs, 'nowhere'); return x?.status === 'failed' ? x : null; });
    expect(bad.line).toContain('작업 폴더가 없습니다');
    ws.close();
  });

  it('refuses a task past TASKS_QUEUED_MAX waiting ones', async () => {
    const { ws, msgs } = await open();
    await until(() => lastTasks(msgs));
    ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: 'slow-hold', fromSessionId: null }));
    await until(() => byTitle(msgs, 'slow-hold')?.status === 'running' && gates.has('slow-hold'));
    for (let i = 0; i < TASKS_QUEUED_MAX; i++) ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: `wait-${i}`, fromSessionId: null }));
    await until(() => byTitle(msgs, `wait-${TASKS_QUEUED_MAX - 1}`)?.status === 'queued');
    ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: 'one-too-many', fromSessionId: null, clientRef: 'r-over' }));
    const err = await until(() => msgs.find((m) => m.type === 'error' && 'clientRef' in m && m.clientRef === 'r-over'));
    expect(err.type === 'error' && err.message).toContain(`${TASKS_QUEUED_MAX}개`);
    expect(tasks.list().some((t) => t.title === 'one-too-many')).toBe(false);
    gates.get('slow-hold')!();
    await until(() => byTitle(msgs, `wait-${TASKS_QUEUED_MAX - 1}`)?.status === 'done', 10_000);
    ws.close();
  });

  it('승인 대기 shows on a task stopped on a card; 취소 drops a queued task and stops a running one (no push)', async () => {
    const { ws, msgs } = await open();
    timeoutState = () => ({ t: lastTasks(msgs), perm: permDecisions });
    await until(() => lastTasks(msgs));
    ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: 'ask-perm', fromSessionId: 'from-c', concise: true }));
    ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: 'never-runs', fromSessionId: 'from-c' }));
    const running = await until(() => { const t = byTitle(msgs, 'ask-perm'); return t?.status === 'running' && t.waiting ? t : null; });
    // Nobody watches a task: its concise note asks no AskUserQuestion card.
    const call = calls.find((c) => c.prompt === 'ask-perm')!;
    expect(call.appendSystemPrompt).toContain('[deck 간결 모드]');
    expect(call.appendSystemPrompt).not.toContain('AskUserQuestion');
    const queued = await until(() => byTitle(msgs, 'never-runs')?.status === 'queued' && byTitle(msgs, 'never-runs'));
    ws.send(JSON.stringify({ type: 'cancel_task', taskId: queued.taskId }));
    await until(() => lastTasks(msgs)!.tasks.every((t) => t.taskId !== queued.taskId));
    ws.send(JSON.stringify({ type: 'cancel_task', taskId: running.taskId }));
    const ended = await until(() => { const t = byTitle(msgs, 'ask-perm'); return t?.status === 'failed' ? t : null; });
    expect(ended.line).toBe('취소됨');
    expect(ended.waiting).toBeUndefined();
    await until(() => permDecisions.length === 1);
    expect(permDecisions[0]).toBe('deny');
    await new Promise((r) => setTimeout(r, 100));
    expect(pushed.some((p) => p.tag === `bgtask-${running.taskId}`)).toBe(false);
    expect(calls.some((c) => c.prompt === 'never-runs')).toBe(false);
    ws.close();
  });

  it('raising the cap is broadcast with the list', async () => {
    const { ws, msgs } = await open();
    await until(() => lastTasks(msgs));
    ws.send(JSON.stringify({ type: 'set_settings', taskSoftCap: 4 }));
    await until(() => lastTasks(msgs)?.cap === 4);
    ws.send(JSON.stringify({ type: 'set_settings', taskSoftCap: 1 }));
    await until(() => lastTasks(msgs)?.cap === 1);
    ws.close();
  });
});

describe('ws · reply language', () => {
  const callFor = (prompt: string) => until(() => calls.find((c) => c.prompt === prompt));

  it("a send carries the device's lang: a Korean note for ko (with AskUserQuestion), none for en; never in the pane", async () => {
    const { ws, msgs } = await open();
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'lang-ko', lang: 'ko' }));
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'lang-en', lang: 'en' }));
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'lang-none' }));
    const ko = await callFor('lang-ko');
    expect(ko.appendSystemPrompt).toContain('[deck language] Respond to the user in Korean');
    expect(ko.appendSystemPrompt).toContain('AskUserQuestion');
    expect((await callFor('lang-en')).appendSystemPrompt).toBeUndefined();
    expect((await callFor('lang-none')).appendSystemPrompt).toBeUndefined();
    expect(JSON.stringify(msgs)).not.toContain('[deck language]');
    ws.close();
  });

  it("the device's lang beats the server setting; the setting is only the fallback for a turn with no lang", async () => {
    const { ws } = await open();
    await settings.set({ language: 'ko' });
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'lang-device-en', lang: 'en' }));
    expect((await callFor('lang-device-en')).appendSystemPrompt).toBeUndefined();
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'lang-fallback-ko' }));
    expect((await callFor('lang-fallback-ko')).appendSystemPrompt).toContain('[deck language]');
    // Auto in Settings clears it (set_settings.language null).
    ws.send(JSON.stringify({ type: 'set_settings', language: null }));
    await until(() => settings.get().language === undefined);
    ws.close();
  });

  it("a session keeps the language a device last sent: a turn without lang reuses it, a new lang replaces it", async () => {
    const { ws, msgs } = await open();
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'sticky-1', lang: 'ko', clientRef: 'sticky-1' }));
    const started = await until(() => msgs.find((m) => m.type === 'turn_result' && m.sessionId && calls.some((c) => c.prompt === 'sticky-1')));
    const sid = (started as { sessionId: string }).sessionId;
    await until(() => store.get(sid)?.lang === 'ko');
    ws.send(JSON.stringify({ type: 'send', sessionId: sid, cwd: work, text: 'sticky-2' }));
    expect((await callFor('sticky-2')).appendSystemPrompt).toContain('[deck language]');
    await until(() => msgs.some((m) => m.type === 'turn_result' && m.text === 'sticky-2 완료'));
    ws.send(JSON.stringify({ type: 'send', sessionId: sid, cwd: work, text: 'sticky-3', lang: 'en' }));
    expect((await callFor('sticky-3')).appendSystemPrompt).toBeUndefined();
    expect(store.get(sid)?.lang).toBe('en');
    ws.close();
  });

  it('a task keeps its lang; its note asks no AskUserQuestion and sits after the concise note', async () => {
    const { ws, msgs } = await open();
    await until(() => lastTasks(msgs));
    ws.send(JSON.stringify({ type: 'start_task', cwd: work, text: 'lang-task', fromSessionId: 'from-l', concise: true, lang: 'ko' }));
    const call = await callFor('lang-task');
    expect(call.appendSystemPrompt).toContain('[deck language]');
    expect(call.appendSystemPrompt).not.toContain('AskUserQuestion');
    expect(call.appendSystemPrompt!.indexOf('[deck 간결 모드]')).toBeLessThan(call.appendSystemPrompt!.indexOf('[deck language]'));
    await until(() => byTitle(msgs, 'lang-task')?.status === 'done');
    ws.close();
  });
});
