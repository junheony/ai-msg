import { describe, expect, it } from 'vitest';
import { CONCISE_STYLE_PROMPT, conciseAck, conciseEventRole, conciseFirstStep, conciseForwardsEvent, conciseMilestone, shouldEmitMilestone, withConcise, CONCISE_MILESTONE_MS } from './concise';

describe('conciseAck', () => {
  it('names the model', () => {
    expect(conciseAck({ model: 'gpt-6-sol', engine: 'codex' })).toBe('GPT Sol · 작업 중');
    expect(conciseAck({ model: 'sonnet', engine: 'claude' })).toBe('Sonnet · 작업 중');
    expect(conciseAck({ engine: 'gemini' })).toBe('Gemini · 작업 중');
    expect(conciseAck({ model: 'opus', engine: 'claude', step: '원인부터 찾을게요' })).toBe('Opus · 원인부터 찾을게요');
  });
});

describe('conciseEventRole', () => {
  it('surfaces starts/results/asks, milestones progress/tools, streams deltas, suppresses thinking bodies', () => {
    expect(conciseEventRole('turn_started')).toBe('surface');
    expect(conciseEventRole('turn_result')).toBe('surface');
    expect(conciseEventRole('permission_request')).toBe('surface');
    expect(conciseEventRole('tool_call')).toBe('milestone');
    expect(conciseEventRole('turn_progress')).toBe('milestone');
    expect(conciseEventRole('delta')).toBe('stream');
    expect(conciseEventRole('thinking')).toBe('suppress');
    expect(conciseEventRole('tool_result')).toBe('suppress');
    expect(conciseForwardsEvent('delta')).toBe(true);
    expect(conciseForwardsEvent('thinking')).toBe(false);
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

describe('instant ack with a first step', () => {
  it('names the model and the first step when the prompt has a cue', () => {
    expect(conciseAck({ model: 'opus', engine: 'claude', step: conciseFirstStep('로그인하면 500 에러가 나 왜 그래') })).toBe('Opus · 원인부터 찾을게요');
    expect(conciseAck({ model: 'sonnet', engine: 'claude', step: '바로 답할게요' })).toBe('Sonnet · 바로 답할게요');
    expect(conciseAck({ engine: 'codex', step: null })).toBe('GPT · 작업 중');
  });
  it('guesses the first step from cue words, null without one', () => {
    expect(conciseFirstStep('테스트 돌려줘')).toBe('먼저 실행해 볼게요');
    expect(conciseFirstStep('설정 화면에 다크모드 토글 추가해줘')).toBe('관련 코드부터 볼게요');
    expect(conciseFirstStep('이 문서 요약해줘')).toBe('내용부터 읽어 볼게요');
    expect(conciseFirstStep('useEffect 가 뭐야?')).toBe('바로 답할게요');
    expect(conciseFirstStep('좋아')).toBeNull();
    expect(conciseFirstStep('')).toBeNull();
    expect(conciseFirstStep(null)).toBeNull();
  });
});

describe('withConcise', () => {
  it('tags sends only while the pref is on, never a handoff note turn', () => {
    const send = { type: 'send', sessionId: null, cwd: '/w', text: 'x' } as const;
    expect(withConcise(send, true)).toEqual({ ...send, concise: true });
    expect(withConcise(send, false)).toBe(send);
    const handoff = { ...send, handoff: true };
    expect(withConcise(handoff, true)).toBe(handoff);
    const other = { type: 'interrupt', turnId: 't' };
    expect(withConcise(other, true)).toBe(other);
  });
  it('the style note asks for results first, option cards and drafts before irreversible actions', () => {
    expect(CONCISE_STYLE_PROMPT).toContain('AskUserQuestion');
    expect(CONCISE_STYLE_PROMPT).toContain('결과');
    expect(CONCISE_STYLE_PROMPT).toContain('초안');
    // Nothing asked is skipped, and nothing claims the text between tool calls is hidden (it streams in full).
    expect(CONCISE_STYLE_PROMPT).toContain('건너뛰지');
    expect(CONCISE_STYLE_PROMPT).not.toContain('접혀');
  });
});
