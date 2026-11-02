// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActivitySteps, MessageActionsContext, MessageView } from './MessageView';
import { Chat, type ChatProps } from './Chat';
import type { AssistantItem } from '../terminalPresentation';

afterEach(cleanup);
Element.prototype.scrollIntoView = () => {};
const a = (text = '', extra: Partial<AssistantItem> = {}): AssistantItem => ({ kind: 'assistant', turnId: 'turn', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], model: 'opus', ...extra });
const call = { toolUseId: 'one', name: 'Bash', input: { command: 'npm test' }, result: null, isError: false };
function props(extra: Partial<ChatProps>): ChatProps {
  const noop = () => {};
  return { items: [], pending: [], questions: [], activeTurnId: null, busy: false, title: 't', model: 'opus', effort: 'high', engine: 'claude', sandbox: 'read-only', sessionEngine: null, sessionSandbox: null, isNew: false, codexAvailable: false, attachments: [], onSend: noop, onInterrupt: noop, onDecide: noop, onAnswer: noop, onModel: noop, onEffort: noop, onEngine: noop, onSandbox: noop, onAttach: noop, onUnattach: noop, ...extra };
}

describe('terminal activity disclosures', () => {
  it('retains ordered thoughts and calls, updating live/error state without closing the disclosure', () => {
    const first = a('', { thinking: { text: '첫 번째 검토', redacted: false, ms: 2000, startedAt: 0 }, toolCalls: [{ ...call, result: '첫 번째 결과' }] });
    const live = a('', { streaming: true, thinking: { text: '두 번째 검토', redacted: false, ms: null, startedAt: 0 }, toolCalls: [{ ...call, toolUseId: 'two' }] });
    const { rerender } = render(<ActivitySteps items={[first, live]} />);
    const group = screen.getByTestId('activity-steps') as HTMLDetailsElement;
    expect(group.open).toBe(false);
    expect(group.querySelector('summary')!.textContent).toContain('작업 진행 중');
    group.open = true;
    const text = group.textContent!;
    expect(text.indexOf('첫 번째 검토')).toBeLessThan(text.indexOf('첫 번째 결과'));
    expect(text.indexOf('첫 번째 결과')).toBeLessThan(text.indexOf('두 번째 검토'));
    rerender(<ActivitySteps items={[first, { ...live, streaming: false, toolCalls: [{ ...call, toolUseId: 'two', result: '검사 실패', isError: true }] }]} />);
    expect(screen.getByTestId('activity-steps')).toBe(group);
    expect(group.open).toBe(true);
    expect(group.querySelector('summary')!.textContent).toContain('오류 1');
    expect(group.querySelector('summary')!.textContent).toContain('작업 과정');
    expect(group.textContent).toContain('검사 실패');
    expect(screen.getAllByRole('button', { name: '명령 복사', hidden: true })).toHaveLength(2);
  });

  it('a folded tool-only record keeps its subagent controls beside the final answer', () => {
    const work = a('', { toolCalls: [{ ...call, name: 'Agent', input: { description: '검색 검토', model: 'sonnet' }, result: '완료' }] });
    render(<Chat {...props({ items: [{ kind: 'user', text: '확인해 줘', n: 4 }, work, a('SUCCESS — 확인 완료')] })} />);
    expect(screen.getAllByTestId('activity-steps')).toHaveLength(1);
    expect(screen.getByLabelText('작업 상태: SUCCESS')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '서브에이전트 1 · offload 0' }));
    expect(screen.getByTestId('role-list').textContent).toContain('검색 검토');
    expect(screen.getByTestId('role-list').textContent).toContain('sonnet');
  });

  it('replaces a success report with PARTIAL for errors earlier in the same finished turn', () => {
    const work = a('검사 결과를 확인합니다.', { toolCalls: [{ ...call, result: '실패', isError: true }] });
    const { rerender } = render(<Chat {...props({ items: [{ kind: 'user', text: '확인' }, work, a('계속 검토 중'), a('SUCCESS — 검토 완료')] })} />);
    expect(screen.getByLabelText('작업 상태: PARTIAL')).toBeTruthy();
    expect(screen.queryByLabelText('작업 상태: SUCCESS')).toBeNull();
    rerender(<Chat {...props({ items: [work, a('BLOCKED — 해결 필요')] })} />);
    expect(screen.getByLabelText('작업 상태: BLOCKED')).toBeTruthy();
    expect(screen.queryByLabelText('작업 상태: PARTIAL')).toBeNull();
  });

  it('waits through a tool-to-answer streaming gap until the turn actually finishes', () => {
    const work = a('검토 중', { toolCalls: [{ ...call, result: '실패', isError: true }] });
    const items = [work, a('수정 내용을 정리했습니다.')];
    const { rerender } = render(<Chat {...props({ items, busy: true, activeTurnId: 'turn' })} />);
    expect(screen.queryByLabelText('작업 상태: PARTIAL')).toBeNull();
    rerender(<Chat {...props({ items, busy: false })} />);
    expect(screen.getByLabelText('작업 상태: PARTIAL')).toBeTruthy();
  });

  it('keeps retry reachable and ordinary prose unchanged when formatting an explicit status', () => {
    const retry = vi.fn();
    const { rerender } = render(<MessageActionsContext.Provider value={{ onRetry: retry }}><MessageView item={a('**BLOCKED:** 권한이 필요합니다')} last /></MessageActionsContext.Provider>);
    expect(screen.getByLabelText('작업 상태: BLOCKED')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '재시도' }));
    expect(retry).toHaveBeenCalledOnce();
    rerender(<MessageView item={a('SUCCESS is a variable')} />);
    expect(screen.queryByLabelText('작업 상태: SUCCESS')).toBeNull();
    expect(screen.getByText('SUCCESS is a variable')).toBeTruthy();
  });
});
