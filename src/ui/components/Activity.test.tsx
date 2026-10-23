// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentInfo, ToolCallItem } from '../state';
import { AgentContext, BackgroundPill, StatusRow, agentStatus, clock, tokens, toolVerb } from './Activity';
import { DEFAULT_PREFS, PREFS_KEY } from '../prefs';
import { ToolCalls } from './ToolCallView';

const agentCall: ToolCallItem = { toolUseId: 'ag', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'count files', prompt: 'count' }, result: null, isError: false };
const info = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  taskId: 'a1', status: 'running', description: 'count files', subagentType: 'general-purpose', backgrounded: false,
  startedAt: Date.now() - 65_000, endedAt: null, usage: { totalTokens: 1500, toolUses: 7, durationMs: 0 }, lastToolName: null,
  calls: Array.from({ length: 7 }, (_, i) => ({ toolUseId: `c${i}`, name: 'Bash', input: { command: `ls ${i}` }, done: i < 6, isError: false })),
  ...over,
});

describe('formatting', () => {
  it('clock is m:ss, tokens use k', () => {
    expect(clock(5_000)).toBe('0:05');
    expect(clock(125_000)).toBe('2:05');
    expect(clock(3_725_000)).toBe('1:02:05');
    expect(tokens(950)).toBe('950');
    expect(tokens(1234)).toBe('1.2k');
    expect(tokens(25_300)).toBe('25k');
  });

  it('tool verbs are present tense with a short argument', () => {
    expect(toolVerb({ name: 'Read', input: { file_path: '/a/b/c.ts' } })).toEqual({ verb: '파일 읽는 중', arg: 'c.ts' });
    expect(toolVerb({ name: 'Bash', input: { command: 'npm test' } })).toEqual({ verb: '명령 실행 중', arg: 'npm test' });
    expect(toolVerb({ name: 'Agent', input: { description: 'explore' } }).verb).toBe('에이전트 실행 중');
  });
});

describe('StatusRow', () => {
  beforeEach(() => {
    // Full-mode expectations below; concise is on by default.
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: false }));
  });
  afterEach(() => { cleanup(); localStorage.removeItem(PREFS_KEY); });
  it('shows the phase verb, elapsed time and live output tokens; 시작하는 중… before the turn starts', () => {
    render(<StatusRow startedAt={Date.now() - 75_000} started progress={{ outputTokens: 2400, phase: 'thinking' }} live={null} onInterrupt={() => {}} />);
    const s = screen.getByTestId('turn-status');
    expect(s.textContent).toContain('생각 중…');
    expect(s.textContent).toContain('1:15');
    expect(s.textContent).toContain('↓ 2.4k 토큰');
    cleanup();
    render(<StatusRow startedAt={Date.now()} started={false} progress={null} live={null} />);
    expect(screen.getByTestId('turn-status').textContent).toContain('시작하는 중…');
    expect(screen.queryByText('중단')).toBeNull();
  });

  it('취소 while 시작하는 중…; none once the turn started', () => {
    const onCancel = vi.fn();
    render(<StatusRow startedAt={Date.now()} started={false} progress={null} live={null} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('취소'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    cleanup();
    render(<StatusRow startedAt={Date.now()} started progress={null} live={null} onInterrupt={() => {}} onCancel={onCancel} />);
    expect(screen.queryByText('취소')).toBeNull();
    expect(screen.getByText('중단')).toBeTruthy();
  });

  it('queued behind a segment: says what it waits for instead of 시작하는 중…, still with 취소; ignored once started', () => {
    const onCancel = vi.fn();
    render(<StatusRow startedAt={Date.now()} started={false} progress={null} live={null} onCancel={onCancel} queuedBehind="백그라운드 계속" />);
    const s = screen.getByTestId('turn-status');
    expect(s.textContent).toContain('백그라운드 계속 뒤에서 기다리는 중');
    expect(s.textContent).not.toContain('시작하는 중…');
    fireEvent.click(screen.getByText('취소'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    cleanup();
    render(<StatusRow startedAt={Date.now()} started progress={null} live={null} onInterrupt={() => {}} queuedBehind="백그라운드 계속" />);
    expect(screen.getByTestId('turn-status').textContent).not.toContain('기다리는 중');
  });
});

  it('concise mode: short ack naming the model instead of phase chrome', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: true }));
    render(<StatusRow startedAt={Date.now()} started progress={null} live={null} routeAck={{ model: 'gpt-6-sol', engine: 'codex', accountLabel: 'A' }} onInterrupt={() => {}} />);
    expect(screen.getByTestId('turn-status').textContent).toContain('GPT Sol · 작업 중');
    // The account letter is internal: tooltip only.
    expect(screen.getByTestId('turn-status').textContent).not.toContain('(A)');
    expect(screen.getByText('GPT Sol · 작업 중').getAttribute('title')).toContain('A');
    cleanup();
    render(<StatusRow startedAt={Date.now()} started progress={null} live={null} routeAck={{ model: 'opus', engine: 'claude', step: '원인부터 찾을게요' }} onInterrupt={() => {}} />);
    expect(screen.getByTestId('turn-status').textContent).toContain('Opus · 원인부터 찾을게요');
    cleanup();
    render(<StatusRow startedAt={Date.now()} started={false} progress={null} live={null} />);
    expect(screen.getByTestId('turn-status').textContent).toContain('확인…');
  });

  it('waiting for the user: says so, the clock stops and the spinner rests', () => {
    cleanup();
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      render(<StatusRow startedAt={t0 - 5_000} started progress={null} live={null} onInterrupt={() => {}} waiting="question" />);
      const s = screen.getByTestId('turn-status');
      expect(s.textContent).toContain('답을 기다리는 중');
      expect(s.textContent).toContain('0:05');
      expect(s.classList.contains('waiting')).toBe(true);
      expect(s.querySelector('.spin')).toBeNull();
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(screen.getByTestId('turn-status').textContent).toContain('0:05');
      cleanup();
      render(<StatusRow startedAt={Date.now()} started progress={null} live={null} waiting="permission" />);
      expect(screen.getByTestId('turn-status').textContent).toContain('승인을 기다리는 중');
      cleanup();
      // Resume after a 30s wait: the clock carries on from 0:05, it does not jump to 0:35.
      const t1 = Date.now();
      const view = render(<StatusRow startedAt={t1 - 5_000} started progress={null} live={null} waiting={null} />);
      view.rerender(<StatusRow startedAt={t1 - 5_000} started progress={null} live={null} waiting="question" />);
      act(() => { vi.advanceTimersByTime(30_000); });
      view.rerender(<StatusRow startedAt={t1 - 5_000} started progress={null} live={null} waiting={null} />);
      expect(screen.getByTestId('turn-status').textContent).toContain('0:05');
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(screen.getByTestId('turn-status').textContent).toContain('0:07');
    } finally {
      vi.useRealTimers();
    }
  });

describe('AgentCard', () => {
  afterEach(cleanup);
  const renderCard = (agents: Record<string, AgentInfo>, call = agentCall, live = true) => render(
    <AgentContext.Provider value={{ agents, bgLive: false, active: false }}><ToolCalls calls={[{ toolUseId: 'b', name: 'Bash', input: { command: 'pwd' }, result: 'x', isError: false }, call]} live={live} /></AgentContext.Provider>,
  );

  it('running: type, description, timer and tokens, the last 5 sub calls with "+N개 더 보기"', () => {
    renderCard({ ag: info() });
    const card = screen.getByTestId('agent-card');
    expect(card.classList.contains('running')).toBe(true);
    expect(card.textContent).toContain('general-purpose');
    expect(card.textContent).toContain('count files');
    expect(card.textContent).toContain('1:05');
    expect(card.textContent).toContain('1.5k 토큰');
    expect(card.querySelectorAll('.agent-calls li.done, .agent-calls li.running')).toHaveLength(5);
    fireEvent.click(within(card).getByText('+2개 더 보기'));
    expect(card.querySelectorAll('.agent-calls li.done, .agent-calls li.running')).toHaveLength(7);
  });

  it('finished: ✓ and the duration; reload without sidechain still shows the card with its result', () => {
    renderCard({ ag: info({ status: 'completed', endedAt: Date.now(), usage: { totalTokens: 900, toolUses: 2, durationMs: 4_000 } }) }, { ...agentCall, result: '42 files' }, false);
    const card = screen.getByTestId('agent-card');
    expect(card.classList.contains('completed')).toBe(true);
    expect(card.textContent).toContain('0:04');
    expect(card.textContent).toContain('완료');
    cleanup();
    renderCard({}, { ...agentCall, result: '42 files' }, false);
    expect(screen.getByTestId('agent-card').textContent).toContain('count files');
    expect(screen.getByText('결과')).toBeTruthy();
  });

  it('status: an error result fails; a call without result in a finished turn was stopped', () => {
    expect(agentStatus({ ...agentCall, isError: true, result: 'x' }, undefined, false, false)).toBe('failed');
    expect(agentStatus(agentCall, undefined, false, false)).toBe('stopped');
    expect(agentStatus(agentCall, info({ backgrounded: true }), false, true)).toBe('running');
    expect(agentStatus(agentCall, info({ status: 'stopped' }), true, false)).toBe('stopped');
  });

  it('opened mid-turn: the Agent call sits in the reloaded (not streaming) transcript, yet runs while the pane turn does', () => {
    render(<AgentContext.Provider value={{ agents: { ag: info() }, bgLive: false, active: true }}><ToolCalls calls={[agentCall]} live={false} /></AgentContext.Provider>);
    expect(screen.getByTestId('agent-card').classList.contains('running')).toBe(true);
  });
});

describe('BackgroundPill', () => {
  afterEach(cleanup);
  it('lists tasks with type and age; 중지 stops one task, 모두 중지 all', () => {
    const onStopTask = vi.fn();
    const onStopAll = vi.fn();
    render(<BackgroundPill bg={{ turnId: 't1', tasks: ['sleep 20', 'explore'], detail: [{ id: 'k', description: 'sleep 20', type: 'local_bash', ageMs: 12_000 }, { id: 'g', description: 'explore', type: 'local_agent', ageMs: 0 }], receivedAt: Date.now(), canStop: true, last: null }} onStopTask={onStopTask} onStopAll={onStopAll} />);
    expect(screen.getByTestId('bg-pill').textContent).toContain('백그라운드 작업 2개');
    fireEvent.click(screen.getByTestId('bg-pill'));
    const pop = screen.getByTestId('bg-popover');
    expect(pop.textContent).toContain('sleep 20');
    expect(pop.textContent).toContain('명령');
    expect(pop.textContent).toContain('0:12');
    fireEvent.click(within(pop).getAllByText('중지')[0]!);
    expect(onStopTask).toHaveBeenCalledWith('k');
    fireEvent.click(within(pop).getByText('모두 중지'));
    expect(onStopAll).toHaveBeenCalled();
    expect(screen.queryByTestId('bg-popover')).toBeNull();
  });

  it('the pill itself shows how long the oldest task has run, ticking while closed', () => {
    vi.useFakeTimers();
    try {
      render(<BackgroundPill bg={{ turnId: 't1', tasks: ['scan', 'explore'], detail: [{ id: 'k', description: 'scan', type: 'local_bash', ageMs: 33 * 60_000 }, { id: 'g', description: 'explore', type: 'local_agent', ageMs: 5_000 }], receivedAt: Date.now(), canStop: true, last: null }} onStopAll={() => {}} />);
      expect(screen.getByTestId('bg-pill').textContent).toContain('33:00');
      act(() => { vi.advanceTimersByTime(61_000); });
      expect(screen.getByTestId('bg-pill').textContent).toContain('34:01');
    } finally {
      vi.useRealTimers();
    }
  });

  it('without detail (older server) the pill counts from when it appeared', () => {
    vi.useFakeTimers();
    try {
      render(<BackgroundPill bg={{ turnId: 't1', tasks: ['build'], detail: [], receivedAt: Date.now() - 90_000, canStop: false, last: null }} onStopAll={() => {}} />);
      expect(screen.getByTestId('bg-pill').textContent).toContain('1:30');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the last subagent activity: how long ago on the pill, what it was in the popover', () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const { rerender } = render(<BackgroundPill bg={{ turnId: 't1', tasks: ['forensics'], detail: [{ id: 'k', description: 'forensics', type: 'local_agent', ageMs: 60_000 }], receivedAt: now, canStop: true, last: { kind: 'call', at: now - 8_000, name: 'Bash', input: { command: 'cast call 0x5d78' } } }} onStopAll={() => {}} />);
      expect(screen.getByTestId('bg-pill').textContent).toContain('활동 8초 전');
      fireEvent.click(screen.getByTestId('bg-pill'));
      expect(screen.getByTestId('bg-popover').textContent).toContain('Bash cast call 0x5d78');
      act(() => { vi.advanceTimersByTime(90_000); });
      expect(screen.getByTestId('bg-pill').textContent).toContain('활동 1분 전');
      rerender(<BackgroundPill bg={{ turnId: 't1', tasks: ['forensics'], detail: [], receivedAt: now, canStop: true, last: { kind: 'task', at: Date.now(), text: 'Trace 0x0a38 BAY source' } }} onStopAll={() => {}} />);
      expect(screen.getByTestId('bg-pill').textContent).toContain('방금 활동');
      expect(screen.getByTestId('bg-popover').textContent).toContain('Trace 0x0a38 BAY source');
    } finally {
      vi.useRealTimers();
    }
  });

  it('without any activity seen yet the pill shows only the clock', () => {
    render(<BackgroundPill bg={{ turnId: 't1', tasks: ['build'], detail: [], receivedAt: Date.now(), canStop: false, last: null }} onStopAll={() => {}} />);
    expect(screen.getByTestId('bg-pill').textContent).not.toContain('활동');
  });

  it('without per-task stop (older server) only 모두 중지 is offered', () => {
    render(<BackgroundPill bg={{ turnId: 't1', tasks: ['build'], detail: [], receivedAt: Date.now(), canStop: false, last: null }} onStopAll={() => {}} />);
    fireEvent.click(screen.getByTestId('bg-pill'));
    expect(screen.queryByText('중지')).toBeNull();
    expect(screen.getByText('모두 중지')).toBeTruthy();
  });
});
