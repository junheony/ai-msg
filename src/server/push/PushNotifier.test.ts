import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '../../shared/protocol';
import { AUTO_RETRY_NOTICE } from '../turn/TurnRunner';
import { CONCISE_LONG_TURN_MS, LONG_TURN_MS, PushNotifier, firstLine, selectPush, turnNeedsAttention, type PushSender } from './PushNotifier';
import { SubscriptionStore } from './SubscriptionStore';

const scope = { turnId: 't1', sessionId: 's1', cwd: '/Users/alice/dev/proj' };
const titleOf = (sid: string | null, cwd: string) => (sid === 's1' ? '로그인 버그 고치기' : cwd.split('/').pop() ?? 'deck');

describe('firstLine', () => {
  it('skips blank lines and markdown marks', () => {
    expect(firstLine('\n\n## 결과\n둘째 줄')).toBe('결과');
    expect(firstLine('- 항목 하나\n- 둘')).toBe('항목 하나');
    expect(firstLine('   ')).toBe('');
  });
});

describe('selectPush (trigger rules)', () => {
  it('a finished turn → session title + first line, one tag per session', () => {
    const p = selectPush({ type: 'turn_result', ...scope, ok: true, text: '\n고쳤습니다.\n자세한 내용…', badge: null, errorText: null }, titleOf);
    expect(p).toEqual({ kind: 'turn', title: '로그인 버그 고치기', body: '완료 · 고쳤습니다.', sessionId: 's1', tag: 'turn-s1' });
  });

  it('a failed turn says so with the error line', () => {
    const p = selectPush({ type: 'turn_result', ...scope, ok: false, text: '', badge: null, errorText: '한도 도달\nstack' }, titleOf);
    expect(p?.body).toBe('실패 · 한도 도달');
  });

  it('a waiting permission card and question card', () => {
    const perm = selectPush({
      type: 'permission_request', ...scope, requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf x' }, title: 'Run rm -rf x', decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: null,
    } as ServerMessage, titleOf);
    expect(perm).toMatchObject({ kind: 'permission', body: '권한 요청 · Bash: Run rm -rf x', tag: 'ask-r1', sessionId: 's1' });
    const q = selectPush({ type: 'question_request', ...scope, requestId: 'r2', questions: [{ question: '어느 색?', header: '색', options: [], multiSelect: false }] } as unknown as ServerMessage, titleOf);
    expect(q).toMatchObject({ kind: 'question', body: '질문 · 어느 색?', tag: 'ask-r2' });
  });

  it('a background task that settled', () => {
    expect(selectPush({ type: 'task_done', ...scope, status: 'completed', summary: '빌드 끝' }, titleOf)).toMatchObject({ kind: 'task', body: '백그라운드 작업 완료 · 빌드 끝' });
    expect(selectPush({ type: 'task_done', ...scope, status: 'failed', summary: '' }, titleOf)?.body).toBe('백그라운드 작업 실패');
  });

  it('a new session without an id falls back to the folder name', () => {
    const p = selectPush({ type: 'turn_result', turnId: 't9', sessionId: null, cwd: '/Users/alice/dev/proj', ok: true, text: 'ok', badge: null, errorText: null }, titleOf);
    expect(p).toMatchObject({ title: 'proj', tag: 'turn-t9', sessionId: null });
  });

  it('everything else is not a push', () => {
    const none: ServerMessage[] = [
      { type: 'delta', ...scope, text: 'x' },
      { type: 'tool_call', ...scope, toolUseId: 'u', name: 'Read', input: {} },
      { type: 'turn_notice', ...scope, message: 'n' },
      { type: 'permission_resolved', requestId: 'r1', decision: 'once' },
      { type: 'question_resolved', requestId: 'r2', answers: null },
      { type: 'error', turnId: null, message: 'e' },
    ];
    for (const m of none) expect(selectPush(m, titleOf)).toBeNull();
  });

  it('clips long titles and bodies', () => {
    const p = selectPush({ type: 'turn_result', ...scope, ok: true, text: 'x'.repeat(500), badge: null, errorText: null }, () => 'y'.repeat(200));
    expect(p!.title.length).toBeLessThanOrEqual(60);
    expect(p!.body.length).toBeLessThanOrEqual(140);
  });
});

describe('PushNotifier (mock sender)', () => {
  const setup = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-notifier-'));
    const store = new SubscriptionStore(path.join(dir, 'subs.json'));
    await store.add({ endpoint: 'https://fcm.googleapis.com/fcm/send/live', keys: { p256dh: 'P', auth: 'A' } });
    await store.add({ endpoint: 'https://web.push.apple.com/gone', keys: { p256dh: 'P', auth: 'A' } });
    const calls: { endpoint: string; payload: unknown; opts: unknown }[] = [];
    const send: PushSender = async (sub, payload, opts) => {
      calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
      if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('Received unexpected response code'), { statusCode: 410 });
    };
    const n = new PushNotifier({ store, vapid: { publicKey: 'pub', privateKey: 'priv' }, subject: 'https://x.ts.net', titleOf, send });
    return { store, calls, n };
  };

  it('notify() sends selected events to every device and forgets 404/410 subscriptions', async () => {
    const { store, calls, n } = await setup();
    n.notify({ type: 'delta', ...scope, text: 'x' });
    expect(calls).toHaveLength(0);
    const r = await n.sendAll({ kind: 'turn', title: 't', body: 'b', sessionId: 's1', tag: 'turn-s1' });
    expect(r).toEqual({ sent: 1, removed: 1 });
    expect(calls.map((c) => c.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/live', 'https://web.push.apple.com/gone']);
    expect(store.list().map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/live']);
  });

  it('permission/question pushes are high urgency with a short TTL', async () => {
    const { calls, n } = await setup();
    n.notify({ type: 'question_request', ...scope, requestId: 'r', questions: [{ question: 'q?' }] } as unknown as ServerMessage);
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[0]!.opts).toEqual({ TTL: 1800, urgency: 'high' });
    expect(calls[0]!.payload).toMatchObject({ kind: 'question', sessionId: 's1' });
  });

  it('a failed delivery is logged by push host only, never the endpoint path or keys', async () => {
    const { store } = await setup();
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    try {
      const n = new PushNotifier({ store, vapid: { publicKey: 'pub', privateKey: 'priv' }, subject: 's', titleOf, send: async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); } });
      expect(await n.sendTo('https://fcm.googleapis.com/fcm/send/live', { kind: 'test', title: 'deck', body: 'b', sessionId: null, tag: 'test' })).toBe(false);
    } finally {
      console.error = orig;
    }
    expect(logged.join('\n')).toContain('fcm.googleapis.com');
    expect(logged.join('\n')).not.toContain('/fcm/send/live');
    expect(logged.join('\n')).not.toContain('priv');
    expect(store.list()).toHaveLength(2);
  });
});

describe('turnNeedsAttention (which finished turns are pushed)', () => {
  it('a failure or a long turn always', () => {
    expect(turnNeedsAttention('', false, 1000)).toBe(true);
    expect(turnNeedsAttention('고쳤습니다.', true, LONG_TURN_MS)).toBe(true);
    expect(turnNeedsAttention('고쳤습니다.', true, LONG_TURN_MS - 1)).toBe(false);
    expect(turnNeedsAttention('고쳤습니다.', true, null)).toBe(false);
  });

  it('the last paragraph asks: ends with ? / ？ or asks to pick / confirm', () => {
    expect(turnNeedsAttention('바꿨습니다.\n\n이대로 커밋할까요?', true, 0)).toBe(true);
    expect(turnNeedsAttention('바꿨습니다.\n\n**A 와 B 중 어느 쪽？**', true, 0)).toBe(true);
    expect(turnNeedsAttention('둘 중 하나를 골라 주세요.', true, 0)).toBe(true);
    expect(turnNeedsAttention('바꿨습니다.\n\n어느 쪽으로 진행할지 알려 주세요.', true, 0)).toBe(true);
    expect(turnNeedsAttention('Done.\n\nLet me know which one you prefer.', true, 0)).toBe(true);
    expect(turnNeedsAttention('Done.\n\nShould I also update the docs.', true, 0)).toBe(true);
    expect(turnNeedsAttention('Done.\n\nDo you want me to push.', true, 0)).toBe(true);
    // A question earlier on, answered by the end: not.
    expect(turnNeedsAttention('왜 실패했을까?\n\n원인을 찾아 고쳤습니다.', true, 0)).toBe(false);
  });

  it('a closing list is looked past to the paragraph before it', () => {
    expect(turnNeedsAttention('둘 중 어느 쪽으로 할까요?\n\n- A안: 빠름\n- B안: 안전', true, 0)).toBe(true);
    expect(turnNeedsAttention('정리했습니다:\n\n1. 빌드\n2. 테스트', true, 0)).toBe(false);
  });

  it('words that only look like asking are not', () => {
    expect(turnNeedsAttention('바꿨습니다.\n\n원하시면 테스트도 추가하겠습니다.', true, 0)).toBe(false);
    expect(turnNeedsAttention('원하시면 언제든 다시 돌릴 수 있습니다.', true, 0)).toBe(false);
    expect(turnNeedsAttention('실패한 테스트 3개를 골라냈습니다.', true, 0)).toBe(false);
    expect(turnNeedsAttention('B안을 선택해서 적용했습니다.', true, 0)).toBe(false);
  });

  it('code fences are left out first', () => {
    // A ? or a # line inside a fence neither asks nor is a heading…
    expect(turnNeedsAttention('설정을 바꿨습니다.\n\n```bash\n# TODO\nread -p "continue?"\n```', true, 0)).toBe(false);
    // …nor hides the question / heading before it.
    expect(turnNeedsAttention('이대로 배포할까요?\n\n```bash\n# 설치\nnpm i\n```', true, 0)).toBe(true);
    expect(turnNeedsAttention('## 다음 단계\n실행:\n\n```bash\n# 설치\nnpm i\n```', true, 0)).toBe(true);
    // An unclosed fence runs to the end.
    expect(turnNeedsAttention('고쳤습니다.\n\n```\nwhy?', true, 0)).toBe(false);
  });

  it('the last heading is a 남은 일 / 다음 단계 / 결정 / 확인 필요 / TODO / 질문 section', () => {
    expect(turnNeedsAttention('## 한 일\n- a\n\n## 남은 일\n- b', true, 0)).toBe(true);
    expect(turnNeedsAttention('**확인 필요**\n- 키 값', true, 0)).toBe(true);
    expect(turnNeedsAttention('### TODO\n- x\n\n끝.', true, 0)).toBe(true);
    expect(turnNeedsAttention('## 남은 일\n- 없음\n\n## 검증\n통과.', true, 0)).toBe(false);
    expect(turnNeedsAttention('#### 남은 일\n- b', true, 0)).toBe(false);
    expect(turnNeedsAttention('## 2. 결정 필요:\n- 색', true, 0)).toBe(true);
    // Only the whole heading counts.
    expect(turnNeedsAttention('## 결정한 것\n- 색은 파랑', true, 0)).toBe(false);
    expect(turnNeedsAttention('## 질문에 대한 답\n그렇습니다.', true, 0)).toBe(false);
  });
});

describe('PushNotifier.notify · turn results', () => {
  const setup = async (o: { commanderQuiet?: (sessionId: string) => boolean; conciseTurn?: (turnId: string) => boolean } = {}) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-notifier-turn-'));
    const store = new SubscriptionStore(path.join(dir, 'subs.json'));
    await store.add({ endpoint: 'https://fcm.googleapis.com/fcm/send/live', keys: { p256dh: 'P', auth: 'A' } });
    const calls: { body: string }[] = [];
    let now = 1_000_000;
    const n = new PushNotifier({ store, vapid: { publicKey: 'pub', privateKey: 'priv' }, subject: 's', titleOf, send: async (_s, payload) => { calls.push(JSON.parse(payload)); }, now: () => now, ...(o.commanderQuiet ? { commanderQuiet: o.commanderQuiet } : {}), ...(o.conciseTurn ? { conciseTurn: o.conciseTurn } : {}) });
    return { n, calls, advance: (ms: number) => { now += ms; } };
  };
  const started = (turnId: string): ServerMessage => ({ type: 'turn_started', ...scope, turnId, account: 'a', model: 'opus', reason: 'r', attempt: 0 } as ServerMessage);
  const result = (turnId: string, ok: boolean, text = '고쳤습니다.'): ServerMessage => ({ type: 'turn_result', ...scope, turnId, ok, text, badge: null, errorText: ok ? null : 'boom' });

  it('a quiet short success is not pushed; a long one is (timed from its first turn_started)', async () => {
    const { n, calls, advance } = await setup();
    n.notify(started('t1'));
    advance(60_000);
    n.notify(result('t1', true));
    n.notify(started('t2'));
    advance(LONG_TURN_MS / 2);
    n.notify(started('t2')); // a retry attempt of the same turn
    advance(LONG_TURN_MS / 2);
    n.notify(result('t2', true));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toBe('완료 · 고쳤습니다.');
  });

  it('간결 모드 turns count as long from CONCISE_LONG_TURN_MS; others only from LONG_TURN_MS', async () => {
    expect(LONG_TURN_MS).toBe(10 * 60_000);
    const { n, calls, advance } = await setup({ conciseTurn: (id) => id === 'c1' });
    n.notify(started('c1'));
    n.notify(started('f1'));
    advance(CONCISE_LONG_TURN_MS);
    n.notify(result('f1', true));
    n.notify(result('c1', true, '간결 끝.'));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toBe('완료 · 간결 끝.');
  });

  it('a background segment only when it failed', async () => {
    const { n, calls } = await setup();
    n.notify(result('t1:bg1', true, '할까요?'));
    n.notify(result('t1:bg2', false));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toBe('실패 · boom');
  });

  it('a commander turn is never pushed by itself (the commander pushes human · done · stop)', async () => {
    const { n, calls } = await setup();
    n.notify(started('t1:cmd1'));
    n.notify({ ...result('t1:cmd1', false), auto: 'commander' } as ServerMessage);
    n.notify(started('t2'));
    n.notify(result('t2', false));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
  });

  it('a commander turn is held back only while its commander runs (quiet); paused / stopped → pushed like any turn', async () => {
    let quiet = true;
    const { n, calls } = await setup({ commanderQuiet: () => quiet });
    n.notify(started('t1:cmd1'));
    n.notify({ ...result('t1:cmd1', false), auto: 'commander' } as ServerMessage);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
    quiet = false;
    n.notify(started('t1:cmd2'));
    n.notify({ ...result('t1:cmd2', false), auto: 'commander' } as ServerMessage);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toBe('실패 · boom');
  });

  it('a turn deck retried by itself is always pushed, even a quiet success', async () => {
    const { n, calls } = await setup();
    n.notify(started('t1'));
    n.notify({ type: 'turn_notice', ...scope, turnId: 't1', message: AUTO_RETRY_NOTICE });
    n.notify(result('t1', true));
    n.notify(started('t2'));
    n.notify(result('t2', true));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toBe('완료 · 고쳤습니다.');
  });
});
