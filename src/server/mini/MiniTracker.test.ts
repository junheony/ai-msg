import { describe, expect, it } from 'vitest';
import { clipPrompt, MiniTracker } from './MiniTracker';
import type { ServerMessage } from '../../shared/protocol';
import type { TurnUsage } from '../../shared/turn-types';

const scope = { turnId: 't1', sessionId: 's1', cwd: '/Users/alice/proj' };
const usage: TurnUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50_000, cacheCreationTokens: 3000, context: { inputTokens: 1000, cacheReadTokens: 50_000, cacheCreationTokens: 3000 }, contextWindow: 200_000 };
const started = (extra: Partial<Extract<ServerMessage, { type: 'turn_started' }>> = {}): ServerMessage => ({ type: 'turn_started', ...scope, account: 'a', model: 'opus', reason: 'r', attempt: 1, engine: 'claude', prompt: { text: 'fix the  build\nplease', attachments: [] }, ...extra });
const result = (): ServerMessage => ({ type: 'turn_result', ...scope, ok: true, text: 'done', badge: { account: 'b', model: 'opus', reason: 'r', usage, modelNote: null }, errorText: null, model: 'claude-opus-5-5' });

describe('MiniTracker', () => {
  it('follows a turn: started → running with the prompt, progress → output so far, result → usage and idle', () => {
    let now = 1000;
    const tr = new MiniTracker(() => now);
    tr.observe(started());
    let s = tr.session('s1')!;
    expect(s).toMatchObject({ engine: 'claude', model: 'opus', account: 'a', lastPrompt: 'fix the build please', turns: 1, runningSince: 1000, waitingOn: null });
    now = 2000;
    tr.observe({ type: 'turn_progress', ...scope, outputTokens: 42, phase: 'thinking' } as ServerMessage);
    expect(tr.session('s1')!.progressOut).toBe(42);
    tr.observe(result());
    s = tr.session('s1')!;
    expect(s.usage).toEqual(usage);
    expect(s).toMatchObject({ model: 'claude-opus-5-5', account: 'b', runningSince: null, totals: { input: 1000, output: 200, cacheRead: 50_000, cacheWrite: 3000 }, updatedAt: 2000 });
    // A retry attempt of the same turn is not a second turn.
    tr.observe(started({ attempt: 2 }));
    expect(tr.session('s1')!.turns).toBe(1);
  });

  it('a permission / question card marks the session waiting until the turn goes on or the card is resolved', () => {
    const tr = new MiniTracker(() => 5);
    tr.observe(started());
    tr.observe({ type: 'permission_request', ...scope, requestId: 'p1', toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: null });
    expect(tr.session('s1')!.waitingOn).toBe('p1');
    tr.observe({ type: 'tool_call', ...scope, toolUseId: 'x', name: 'Bash', input: {} });
    expect(tr.session('s1')!.waitingOn).toBeNull();
    tr.observe({ type: 'question_request', ...scope, requestId: 'q1', questions: [] });
    expect(tr.session('s1')!.waitingOn).toBe('q1');
    tr.resolved('q1');
    expect(tr.session('s1')!.waitingOn).toBeNull();
  });

  it('ignores messages without a session id and unknown types', () => {
    const tr = new MiniTracker();
    tr.observe({ type: 'turn_started', ...scope, sessionId: null, account: 'a', model: 'opus', reason: 'r', attempt: 1 });
    tr.observe({ type: 'activity', sessions: [] });
    tr.observe({ type: 'usage', usage: {} as never });
    expect(tr.list()).toEqual([]);
  });

  it('clipPrompt: one line, 80 characters at most, an ellipsis when cut', () => {
    expect(clipPrompt('a\n\n  b   c ')).toBe('a b c');
    const long = '가'.repeat(100);
    const cut = clipPrompt(long);
    expect(Array.from(cut).length).toBe(80);
    expect(cut.endsWith('…')).toBe(true);
    expect(clipPrompt('x'.repeat(80))).toBe('x'.repeat(80));
  });
});
