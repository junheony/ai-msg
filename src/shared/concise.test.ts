import { describe, expect, it } from 'vitest';
import { conciseAck, conciseEventRole, conciseForwardsEvent, conciseMilestone, shouldEmitMilestone, CONCISE_MILESTONE_MS } from './concise';

describe('conciseAck', () => {
  it('names the model', () => {
    expect(conciseAck({ model: 'gpt-6-sol', engine: 'codex' })).toBe('확인 · GPT Sol로 처리 중');
    expect(conciseAck({ model: 'sonnet', engine: 'claude', accountLabel: 'A' })).toBe('확인 · Sonnet(A)로 처리 중');
    expect(conciseAck({ engine: 'gemini' })).toBe('확인 · Gemini로 처리 중');
  });
});

describe('conciseEventRole', () => {
  it('surfaces starts/results/asks, milestones progress/tools, defers deltas, suppresses thinking bodies', () => {
    expect(conciseEventRole('turn_started')).toBe('surface');
    expect(conciseEventRole('turn_result')).toBe('surface');
    expect(conciseEventRole('permission_request')).toBe('surface');
    expect(conciseEventRole('tool_call')).toBe('milestone');
    expect(conciseEventRole('turn_progress')).toBe('milestone');
    expect(conciseEventRole('delta')).toBe('defer');
    expect(conciseEventRole('thinking')).toBe('suppress');
    expect(conciseEventRole('tool_result')).toBe('suppress');
    expect(conciseForwardsEvent('delta')).toBe(false);
    expect(conciseForwardsEvent('tool_call')).toBe(true);
  });
});

describe('conciseMilestone / shouldEmitMilestone', () => {
  it('emits started and done, and throttles working milestones', () => {
    expect(conciseMilestone({ phase: 'started' })).toBe('시작함');
    expect(conciseMilestone({ phase: 'done' })).toBe('끝남');
    expect(conciseMilestone({ phase: 'working', step: 3, elapsedMs: 65_000 })).toBe('계속 작업 중 · 단계 3 · 1분');

    let s = { lastAtMs: 0, steps: 0, startedAtMs: 0 };
    const start = shouldEmitMilestone(s, 1000, 'turn_started');
    expect(start).toMatchObject({ emit: true, message: '시작함' });
    s = start.next;

    const early = shouldEmitMilestone(s, 1000 + 5_000, 'tool_call');
    // first tool step bumps
    expect(early.emit).toBe(true);
    s = early.next;

    const mid = shouldEmitMilestone(s, s.lastAtMs + 1_000, 'tool_call');
    expect(mid.emit).toBe(false);
    s = mid.next;

    const later = shouldEmitMilestone(s, s.lastAtMs + CONCISE_MILESTONE_MS, 'turn_progress');
    expect(later.emit).toBe(true);
    expect(later.message).toMatch(/계속 작업 중/);
  });
});
