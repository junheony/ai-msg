// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QuestionSummary, questionAnswers } from './QuestionSummary';
import { ToolCalls } from './ToolCallView';
import { MessageView } from './MessageView';
import { foldedCalls } from './TurnMeta';
import type { ToolCallItem } from '../state';

const input = { questions: [
  { question: '인증 방식은 무엇으로 할까요?', header: '인증', options: [], multiSelect: false },
  { question: 'Which "features", exactly?', header: '', options: [], multiSelect: true },
] };
const result = 'User has answered your questions: "인증 방식은 무엇으로 할까요?"="OAuth (Recommended)", "Which "features", exactly?"="a, "b", c". You can now continue with the user\'s answers in mind.';
const call = (over: Partial<ToolCallItem> = {}): ToolCallItem => ({ toolUseId: 'u1', name: 'AskUserQuestion', input, result, isError: false, ...over });

describe('questionAnswers', () => {
  it('reads the answers back from the result line, anchored on the known questions (quotes and commas inside stay)', () => {
    expect(questionAnswers(call())).toEqual({ '인증 방식은 무엇으로 할까요?': 'OAuth (Recommended)', 'Which "features", exactly?': 'a, "b", c' });
  });
  it('prefers answers kept in the input', () => {
    expect(questionAnswers(call({ input: { ...input, answers: { '인증 방식은 무엇으로 할까요?': 'Email' } }, result: 'ok' }))).toEqual({ '인증 방식은 무엇으로 할까요?': 'Email' });
  });
  it('the last answer runs to the closing sentence, past a `". ` typed inside it', () => {
    const one = { questions: [input.questions[0]!] };
    expect(questionAnswers(call({ input: one, result: 'User has answered your questions: "인증 방식은 무엇으로 할까요?"="He said "hi". Then OAuth". You can now continue with the user\'s answers in mind.' }))).toEqual({ '인증 방식은 무엇으로 할까요?': 'He said "hi". Then OAuth' });
  });
  it('an unrecognised result gives no answers', () => {
    expect(questionAnswers(call({ result: 'something else' }))).toEqual({});
  });
});

describe('QuestionSummary', () => {
  afterEach(cleanup);

  it('one `question → answer` row per question; header when there is one, the 추천 tail dropped', () => {
    render(<QuestionSummary call={call()} />);
    const rows = [...screen.getByTestId('question-summary').querySelectorAll('.question-summary-row')].map((r) => r.textContent);
    expect(rows).toEqual(['인증→OAuth', 'Which "features", exactly?→a, "b", c']);
  });

  it('a refused question says it was not answered; a call still waiting shows nothing', () => {
    const { rerender, container } = render(<QuestionSummary call={call({ isError: true, result: 'denied' })} />);
    expect(screen.getAllByText('답하지 않음')).toHaveLength(2);
    rerender(<QuestionSummary call={call({ result: null })} />);
    expect(container.innerHTML).toBe('');
  });

  it('stands alone in a run of tool calls instead of folding into the group line', () => {
    const bash = (id: string): ToolCallItem => ({ toolUseId: id, name: 'Bash', input: { command: 'ls' }, result: 'x', isError: false });
    render(<ToolCalls calls={[bash('b1'), call(), bash('b2')]} />);
    expect(screen.getByTestId('question-summary')).toBeTruthy();
    expect(screen.getAllByTestId('tool-call')).toHaveLength(2);
  });

  it('an answered call whose answers cannot be read shows the result as written; a refused one still says 답하지 않음', () => {
    const { rerender } = render(<QuestionSummary call={call({ result: 'The user picked something new.' })} />);
    expect(screen.getByTestId('question-summary-raw').textContent).toBe('The user picked something new.');
    rerender(<QuestionSummary call={call({ result: 'denied', isError: true })} />);
    expect(screen.queryByTestId('question-summary-raw')).toBeNull();
    expect(screen.getAllByText('답하지 않음')).toHaveLength(2);
  });

  it('drops only each pick\'s (Recommended) tail, never one in the middle of an answer', () => {
    const one = { questions: [input.questions[0]!] };
    render(<QuestionSummary call={call({ input: { ...one, answers: { '인증 방식은 무엇으로 할까요?': 'OAuth (Recommended), Use (Recommended) wording' } } })} />);
    expect(screen.getByTestId('question-summary').textContent).toContain('OAuth, Use (Recommended) wording');
  });

  it('간결 모드 meta line does not fold the answered question (its summary is in the reply)', () => {
    const bash: ToolCallItem = { toolUseId: 'b1', name: 'Bash', input: { command: 'ls' }, result: 'x', isError: false };
    const item = { kind: 'assistant' as const, turnId: 't', text: 'ok', toolCalls: [call(), bash], badge: null, streaming: false, error: null, notes: [], attempts: [] };
    expect(foldedCalls(item, true).map((c) => c.toolUseId)).toEqual(['b1']);
    expect(foldedCalls(item, false).map((c) => c.toolUseId)).toEqual(['b1']);
  });

  it('a call whose questions cannot be read stays an ordinary tool call', () => {
    render(<ToolCalls calls={[call({ input: {} })]} />);
    expect(screen.queryByTestId('question-summary')).toBeNull();
    expect(screen.getAllByTestId('tool-call')).toHaveLength(1);
  });

  it('shows in the reply in 간결 모드 (the default) too', () => {
    render(<MessageView item={{ kind: 'assistant', turnId: 't', text: '좋아요, OAuth 로 할게요.', toolCalls: [call()], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    expect(screen.getByTestId('question-summary').textContent).toContain('OAuth');
  });
});
