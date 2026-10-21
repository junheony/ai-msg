import { describe, expect, it } from 'vitest';
import { emptyMilestoneState, filterConciseEvent, projectConciseStream } from './conciseFilter';
import type { ServerMessage } from '../../shared/protocol';

const scope = { turnId: 't1', sessionId: 's1', cwd: '/w' };

describe('filterConciseEvent', () => {
  it('forwards started/result, milestones tools, suppresses thinking and tool bodies, defers deltas', () => {
    let state = emptyMilestoneState(1000);
    const start = filterConciseEvent({ type: 'turn_started', ...scope, account: 'a', model: 'sonnet', reason: 'r', attempt: 0 }, state, 1000);
    expect(start.forward).toBe(true);
    expect(start.milestone).toBe('시작함');
    state = start.state;

    const think = filterConciseEvent({ type: 'thinking', ...scope, text: 'hmm' }, state, 2000);
    expect(think.forward).toBe(false);
    expect(think.role).toBe('suppress');
    state = think.state;

    const delta = filterConciseEvent({ type: 'delta', ...scope, text: 'hi' }, state, 3000);
    expect(delta.forward).toBe(false);
    expect(delta.role).toBe('defer');
    state = delta.state;

    const tool = filterConciseEvent({ type: 'tool_call', ...scope, toolUseId: 'u1', name: 'Bash', input: {} }, state, 4000);
    expect(tool.forward).toBe(true);
    expect(tool.milestone).toMatch(/계속 작업 중|시작/);
    state = tool.state;

    const result = filterConciseEvent({ type: 'tool_result', ...scope, toolUseId: 'u1', content: 'out', isError: false }, state, 5000);
    expect(result.forward).toBe(false);

    const done = filterConciseEvent({ type: 'turn_result', ...scope, ok: true, text: 'done', badge: null, errorText: null }, state, 6000);
    expect(done.forward).toBe(true);
    expect(done.milestone).toBe('끝남');
  });
});

describe('projectConciseStream', () => {
  it('keeps surface/milestone events only', () => {
    const events: ServerMessage[] = [
      { type: 'turn_started', ...scope, account: 'a', model: 'gpt-6-sol', reason: 'auto', attempt: 0 },
      { type: 'thinking', ...scope, text: 'x' },
      { type: 'delta', ...scope, text: 'Hello' },
      { type: 'tool_call', ...scope, toolUseId: '1', name: 'Read', input: { file_path: '/a' } },
      { type: 'tool_result', ...scope, toolUseId: '1', content: '…', isError: false },
      { type: 'turn_result', ...scope, ok: true, text: 'Hello', badge: null, errorText: null },
    ];
    const { kept, milestones } = projectConciseStream(events, 10_000);
    expect(kept.map((m) => m.type)).toEqual(['turn_started', 'tool_call', 'turn_result']);
    expect(milestones[0]).toBe('시작함');
    expect(milestones.at(-1)).toBe('끝남');
  });
});
