import { describe, expect, it } from 'vitest';
import { CONCISE_STYLE_PROMPT, conciseAck, conciseEventRole, conciseFirstStep, conciseForwardsEvent, conciseLeadLine, conciseLiveSplit, conciseMilestone, shouldEmitMilestone, withConcise, CONCISE_MILESTONE_MS } from './concise';

describe('conciseAck', () => {
  it('names the model', () => {
    expect(conciseAck({ model: 'gpt-6-sol', engine: 'codex' })).toBe('확인 · GPT Sol로 처리 중');
    expect(conciseAck({ model: 'sonnet', engine: 'claude', accountLabel: 'A' })).toBe('확인 · Sonnet(A)로 처리 중');
    expect(conciseAck({ engine: 'gemini' })).toBe('확인 · Gemini로 처리 중');
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
    expect(conciseAck({ model: 'opus', engine: 'claude', step: conciseFirstStep('로그인하면 500 에러가 나 왜 그래') })).toBe('확인 · Opus — 원인부터 찾을게요');
    expect(conciseAck({ model: 'sonnet', engine: 'claude', accountLabel: 'A', step: '바로 답할게요' })).toBe('확인 · Sonnet(A) — 바로 답할게요');
    expect(conciseAck({ engine: 'codex', step: null })).toBe('확인 · GPT로 처리 중');
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

describe('conciseLeadLine', () => {
  it('shows the first finished sentence of the streaming text', () => {
    expect(conciseLeadLine('먼저 실패하는 테스트부터 볼게요. 그다음')).toBe('먼저 실패하는 테스트부터 볼게요.');
    expect(conciseLeadLine('먼저 실패하는 테스트부터')).toBeNull();
    expect(conciseLeadLine('')).toBeNull();
    expect(conciseLeadLine('# 제목.\n\n본문')).toBeNull();
    expect(conciseLeadLine(`${'가'.repeat(200)}.`, 20)).toHaveLength(20);
  });
});

describe('conciseLiveSplit', () => {
  it('streams the whole text before any tool call', () => {
    expect(conciseLiveSplit('바로 답할게요', [])).toEqual({ lead: null, live: '바로 답할게요' });
    expect(conciseLiveSplit('답', [undefined, 0])).toEqual({ lead: null, live: '답' });
  });
  it('folds the text before the last tool call into a lead line and streams the rest', () => {
    const t = '먼저 테스트부터 볼게요. 그다음 고칠게요.\n\n원인은 X예요';
    const cut = t.indexOf('\n\n');
    expect(conciseLiveSplit(t, [cut])).toEqual({ lead: '먼저 테스트부터 볼게요.', live: '\n\n원인은 X예요' });
    // Right after the call: nothing live yet, the lead stays.
    expect(conciseLiveSplit(t.slice(0, cut), [cut])).toEqual({ lead: '먼저 테스트부터 볼게요.', live: '' });
  });
  it('leads with the latest non-empty stretch; an unfinished one shows its first line', () => {
    const t = '먼저 볼게요.이제 고쳐 볼게요끝';
    const a = '먼저 볼게요.'.length;
    const b = t.length - 1;
    expect(conciseLiveSplit(t, [a, b])).toEqual({ lead: '이제 고쳐 볼게요', live: '끝' });
    // Back-to-back calls (empty stretch between): the earlier stretch leads.
    expect(conciseLiveSplit('먼저 볼게요.', [a, a, a])).toEqual({ lead: '먼저 볼게요.', live: '' });
    expect(conciseLiveSplit('```\ncode\n```', [14])).toEqual({ lead: null, live: '' });
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
  });
});
