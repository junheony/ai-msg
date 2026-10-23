// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuestionCard, splitRecommended } from './QuestionCard';
import type { PendingQuestion } from '../state';

const req: PendingQuestion = {
  turnId: 't', sessionId: 's1', cwd: '/w/proj', requestId: 'q1',
  questions: [
    { question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: 'cool' }], multiSelect: false },
    { question: 'Which features?', header: 'Features', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }, { label: 'c', description: '' }], multiSelect: true },
  ],
};
const single: PendingQuestion = { ...req, questions: [req.questions[0]!] };
const multiOnly: PendingQuestion = { ...req, questions: [req.questions[1]!] };
const three: PendingQuestion = {
  turnId: 't', sessionId: 's1', cwd: '/w', requestId: 'q3',
  questions: ['One?', 'Two?', 'Three?'].map((q, i) => ({ question: q, header: `H${i + 1}`, options: [{ label: `${q}-x`, description: '' }, { label: `${q}-y`, description: '' }], multiSelect: false })),
};
const sendBtn = () => screen.getByTestId('question-send') as HTMLButtonElement;
const openQuestion = () => screen.getByTestId('question-open').querySelector('.question-text')!.textContent;

describe('QuestionCard (D8)', () => {
  afterEach(cleanup);

  it('a stepper: one question at a time, a single-select pick moves on, answered ones fold to a ✓ line; sends when all are answered', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={req} onAnswer={onAnswer} />);
    expect(screen.getByText('Claude가 선택을 기다려요')).toBeTruthy();
    expect(screen.getByTestId('question-progress').textContent).toBe('1/2');
    expect(openQuestion()).toBe('Which color?');
    expect(screen.queryByText('Which features?')).toBeNull();
    expect(screen.getByText('cool')).toBeTruthy();
    expect(sendBtn().disabled).toBe(true);
    expect(sendBtn().textContent).toBe('2개 남음');
    fireEvent.click(screen.getByText('blue'));
    // Moved on by itself; the answered question is one line with its pick and a ✓.
    expect(openQuestion()).toBe('Which features?');
    expect(screen.getByTestId('question-progress').textContent).toBe('2/2');
    const done = screen.getByTestId('question-done');
    expect(done.textContent).toContain('Color · blue');
    expect(done.textContent).toContain('✓');
    expect(sendBtn().textContent).toBe('1개 남음');
    // A multi-select pick stays on its question.
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(screen.getByText('c'));
    fireEvent.click(screen.getByText('a')); // toggles off
    fireEvent.click(screen.getByText('b'));
    expect(openQuestion()).toBe('Which features?');
    expect(sendBtn().disabled).toBe(false);
    expect(sendBtn().textContent).toBe('답변 보내기');
    fireEvent.click(sendBtn());
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'blue', 'Which features?': 'c, b' });
  });

  it('‹ › move between questions without answering; tapping a folded answer opens that question again', () => {
    render(<QuestionCard req={req} onAnswer={vi.fn()} />);
    const prev = screen.getByRole('button', { name: '이전 질문' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: '다음 질문' }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(next);
    expect(openQuestion()).toBe('Which features?');
    expect(next.disabled).toBe(true);
    // Unanswered questions that are not open are not shown at all.
    expect(screen.queryByTestId('question-done')).toBeNull();
    fireEvent.click(prev);
    expect(openQuestion()).toBe('Which color?');
    fireEvent.click(screen.getByText('red'));
    expect(openQuestion()).toBe('Which features?');
    fireEvent.click(screen.getByTestId('question-done'));
    expect(openQuestion()).toBe('Which color?');
    expect((screen.getByText('red').closest('button') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
  });

  it('auto-next goes to the next unanswered question, wrapping to an earlier one', () => {
    render(<QuestionCard req={three} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '다음 질문' }));
    fireEvent.click(screen.getByText('Two?-x'));
    expect(openQuestion()).toBe('Three?');
    fireEvent.click(screen.getByText('Three?-y'));
    expect(openQuestion()).toBe('One?');
    fireEvent.click(screen.getByText('One?-x'));
    // Nothing left to answer: stays, and the button sends.
    expect(openQuestion()).toBe('One?');
    expect(sendBtn().disabled).toBe(false);
    expect(screen.getAllByTestId('question-done')).toHaveLength(2);
  });

  it('one single-select question sends on the tap itself, with no send button', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={single} onAnswer={onAnswer} />);
    expect(screen.queryByTestId('question-progress')).toBeNull();
    expect(screen.queryByTestId('question-send')).toBeNull();
    fireEvent.click(screen.getByText('blue'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'blue' });
    expect(screen.getByRole('status').textContent).toBe('보내는 중…');
    expect((screen.getByText('red').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('red'));
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('the instant send marks the tapped option while sending', () => {
    render(<QuestionCard req={single} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByText('blue'));
    expect(screen.getByText('blue').closest('button')!.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('red').closest('button')!.getAttribute('aria-checked')).toBe('false');
  });

  it('a single-select question with previews neither sends on the tap nor moves on: pick, compare, then send', () => {
    const onAnswer = vi.fn();
    const layout = { question: 'Layout?', header: '', options: [{ label: 'one', description: '', preview: 'PREVIEW-ONE' }, { label: 'two', description: '', preview: 'PREVIEW-TWO' }], multiSelect: false };
    const { container } = render(<QuestionCard req={{ ...single, questions: [layout] }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('one'));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(container.querySelector('pre.option-preview')!.textContent).toBe('PREVIEW-ONE');
    fireEvent.click(screen.getByText('two'));
    expect(container.querySelector('pre.option-preview')!.textContent).toBe('PREVIEW-TWO');
    fireEvent.click(sendBtn());
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Layout?': 'two' });
    cleanup();
    render(<QuestionCard req={{ ...req, requestId: 'q2', questions: [layout, req.questions[1]!] }} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByText('one'));
    expect(openQuestion()).toBe('Layout?');
  });

  it('keyboard focus follows the step: to the next question after a pick, and to a reopened one', () => {
    render(<QuestionCard req={req} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByText('blue'));
    expect(document.activeElement!.textContent).toBe('Which features?');
    fireEvent.click(screen.getByTestId('question-done'));
    expect(document.activeElement!.textContent).toBe('Which color?');
    expect(screen.getByTestId('question-progress').getAttribute('aria-live')).toBe('polite');
  });

  it('keys the submitted answers by the exact question text via answersFor, verbatim including trailing whitespace', () => {
    const onAnswer = vi.fn();
    const trailing: PendingQuestion = {
      turnId: 't', sessionId: null, cwd: '/w', requestId: 'q2',
      questions: [{ question: 'Which DB?  ', header: '', options: [{ label: 'pg', description: '' }], multiSelect: false }],
    };
    render(<QuestionCard req={trailing} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('pg'));
    expect(onAnswer).toHaveBeenCalledWith('q2', { 'Which DB?  ': 'pg' });
    expect(Object.keys(onAnswer.mock.calls[0]![1] as object)).toEqual(['Which DB?  ']);
  });

  it('single-select 기타 is a radio: it opens a two-line box and a 보내기 button; whitespace does not count', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={single} onAnswer={onAnswer} />);
    const other = screen.getByText('기타').closest('button')!;
    expect(other.getAttribute('role')).toBe('radio');
    fireEvent.click(other);
    expect(other.getAttribute('aria-checked')).toBe('true');
    const box = screen.getByLabelText('Color 직접 입력') as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.rows).toBe(2);
    fireEvent.change(box, { target: { value: '   ' } });
    expect(sendBtn().disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'green' } });
    expect(sendBtn().textContent).toBe('보내기');
    fireEvent.click(sendBtn());
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'green' });
  });

  it('single-select: picking an option after typing in 기타 closes 기타 and the option wins', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={req} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('기타'));
    fireEvent.change(screen.getByLabelText('Color 직접 입력'), { target: { value: 'green' } });
    fireEvent.click(screen.getByText('blue'));
    expect(screen.getByTestId('question-done').textContent).toContain('Color · blue');
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(sendBtn());
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'blue', 'Which features?': 'a' });
  });

  it('multi-select 기타 is a checkbox that combines with the other picks', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={multiOnly} onAnswer={onAnswer} />);
    const other = screen.getByText('기타').closest('button')!;
    expect(other.getAttribute('aria-pressed')).toBe('false');
    expect(other.querySelector('.option-plus')).toBeTruthy();
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(other);
    fireEvent.change(screen.getByLabelText('Features 직접 입력'), { target: { value: 'zzz' } });
    expect((screen.getByText('a').closest('button') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect(other.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(sendBtn());
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which features?': 'a, zzz' });
  });

  it('multi-select: unticking 기타 drops its text from the answer', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={multiOnly} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('기타'));
    fireEvent.change(screen.getByLabelText('Features 직접 입력'), { target: { value: 'zzz' } });
    fireEvent.click(screen.getByText('b'));
    fireEvent.click(screen.getByText('기타'));
    expect(screen.queryByLabelText('Features 직접 입력')).toBeNull();
    fireEvent.click(sendBtn());
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which features?': 'b' });
  });

  it('single-select options are radios (aria-checked), multi-select ones toggle buttons (aria-pressed)', () => {
    render(<QuestionCard req={req} onAnswer={vi.fn()} />);
    const red = screen.getByText('red').closest('button') as HTMLButtonElement;
    expect(red.getAttribute('role')).toBe('radio');
    expect(red.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '다음 질문' }));
    expect((screen.getByText('a').closest('button') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
  });

  it('답변 보내기 disables the form and shows 보내는 중…', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={multiOnly} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(sendBtn());
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(sendBtn().disabled).toBe(true);
    expect((screen.getByText('a').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('보내는 중…');
  });

  it('strips a "(Recommended)" tail into a 추천 badge but submits the original label', () => {
    const onAnswer = vi.fn();
    const rec: PendingQuestion = {
      turnId: 't', sessionId: 's1', cwd: '/w', requestId: 'q3',
      questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres (Recommended)', description: '' }, { label: 'SQLite', description: '' }], multiSelect: false }],
    };
    render(<QuestionCard req={rec} onAnswer={onAnswer} />);
    expect(screen.queryByText('Postgres (Recommended)')).toBeNull();
    const label = screen.getByText('Postgres');
    expect(label.closest('button')!.textContent).toContain('추천');
    fireEvent.click(label);
    expect(onAnswer).toHaveBeenCalledWith('q3', { 'Which DB?': 'Postgres (Recommended)' });
  });

  it('the folder name only (full path in the tooltip), no session id', () => {
    render(<QuestionCard req={req} onAnswer={vi.fn()} />);
    const scope = screen.getByTestId('question-scope');
    expect(scope.textContent).toBe('proj');
    expect(scope.getAttribute('title')).toBe('/w/proj');
  });

  it('shows an option preview only while that option is picked; whitespace-only previews never show', () => {
    const withPreview: PendingQuestion = {
      turnId: 't', sessionId: null, cwd: '/w', requestId: 'q3',
      questions: [{ question: 'Layout?', header: '', options: [{ label: 'one', description: '', preview: 'PREVIEW-ONE' }, { label: 'two', description: '', preview: 'PREVIEW-TWO' }, { label: 'blank', description: '', preview: '  \n ' }], multiSelect: true }],
    };
    const { container } = render(<QuestionCard req={withPreview} onAnswer={vi.fn()} />);
    const pres = () => [...container.querySelectorAll('pre.option-preview')].map((p) => p.textContent);
    expect(pres()).toEqual([]);
    fireEvent.click(screen.getByText('one'));
    expect(pres()).toEqual(['PREVIEW-ONE']);
    fireEvent.click(screen.getByText('one'));
    fireEvent.click(screen.getByText('two'));
    expect(pres()).toEqual(['PREVIEW-TWO']);
    fireEvent.click(screen.getByText('two'));
    fireEvent.click(screen.getByText('blank'));
    expect(pres()).toEqual([]);
  });
});

describe('splitRecommended', () => {
  it('pins the current behaviour', () => {
    expect(splitRecommended('(Recommended)')).toEqual({ text: '(Recommended)', recommended: false });
    expect(splitRecommended('x (recommended)')).toEqual({ text: 'x', recommended: true });
    expect(splitRecommended('x(Recommended) ')).toEqual({ text: 'x', recommended: true });
    expect(splitRecommended('x (Recommended) y')).toEqual({ text: 'x (Recommended) y', recommended: false });
    expect(splitRecommended('x (추천)')).toEqual({ text: 'x', recommended: true });
  });
});
