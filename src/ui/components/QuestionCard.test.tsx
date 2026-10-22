// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuestionCard } from './QuestionCard';
import type { PendingQuestion } from '../state';

const req: PendingQuestion = {
  turnId: 't', sessionId: 's1', cwd: '/w/proj', requestId: 'q1',
  questions: [
    { question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: 'cool' }], multiSelect: false },
    { question: 'Which features?', header: 'Features', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }, { label: 'c', description: '' }], multiSelect: true },
  ],
};

describe('QuestionCard (D8)', () => {
  afterEach(cleanup);

  it('shows headers, questions, options with descriptions and the session scope; submit is disabled until every question is answered', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={req} onAnswer={onAnswer} />);
    expect(screen.getByText('Color')).toBeTruthy();
    expect(screen.getByText('Which color?')).toBeTruthy();
    expect(screen.getByText('cool')).toBeTruthy();
    expect(screen.getByTestId('question-scope').textContent).toContain('/w/proj');
    const submit = screen.getByText('답변 보내기') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByText('blue'));
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(screen.getByText('c'));
    fireEvent.click(screen.getByText('a')); // toggles off
    fireEvent.click(screen.getByText('b'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'blue', 'Which features?': 'c, b' });
  });

  it('single-select replaces the pick; free text overrides the options', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('red'));
    fireEvent.click(screen.getByText('blue'));
    fireEvent.change(screen.getByPlaceholderText('기타 (직접 입력)'), { target: { value: 'green' } });
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'green' });
  });

  it('keys the submitted answers by the exact question text via answersFor, verbatim including trailing whitespace', () => {
    const onAnswer = vi.fn();
    const trailing: PendingQuestion = {
      turnId: 't', sessionId: null, cwd: '/w', requestId: 'q2',
      questions: [{ question: 'Which DB?  ', header: '', options: [{ label: 'pg', description: '' }], multiSelect: false }],
    };
    render(<QuestionCard req={trailing} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('pg'));
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q2', { 'Which DB?  ': 'pg' });
    expect(Object.keys(onAnswer.mock.calls[0]![1] as object)).toEqual(['Which DB?  ']);
  });

  it('typing free text then clicking an option submits the option, and unpicks the free text visually', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={onAnswer} />);
    const free = screen.getByPlaceholderText('기타 (직접 입력)') as HTMLInputElement;
    fireEvent.change(free, { target: { value: 'green' } });
    fireEvent.click(screen.getByText('blue'));
    expect(free.value).toBe('');
    expect((screen.getByText('blue').closest('button') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'blue' });
  });

  it('clicking an option then typing free text submits the text, and unpicks the option visually', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={onAnswer} />);
    const blueBtn = screen.getByText('blue').closest('button') as HTMLButtonElement;
    fireEvent.click(blueBtn);
    expect(blueBtn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByPlaceholderText('기타 (직접 입력)'), { target: { value: 'green' } });
    expect(blueBtn.className).not.toContain('picked');
    expect(blueBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'green' });
  });

  it('sets aria-pressed on option buttons and an aria-label on the free-text input', () => {
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={vi.fn()} />);
    expect((screen.getByText('red').closest('button') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByLabelText('Color 직접 입력')).toBeTruthy();
  });

  it('답변 보내기 disables the form and shows 보내는 중…', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('red'));
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect((screen.getByText('답변 보내기') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('red').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText('기타 (직접 입력)') as HTMLInputElement).disabled).toBe(true);
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
    expect(screen.getByText('추천')).toBeTruthy();
    fireEvent.click(label);
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q3', { 'Which DB?': 'Postgres (Recommended)' });
  });

  it('shows progress (n/total) and how many questions are left, ready when all are answered', () => {
    render(<QuestionCard req={req} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('question-progress').textContent).toBe('0/2 답변');
    expect(screen.getByTestId('question-left').textContent).toBe('2개 남음');
    fireEvent.click(screen.getByText('red'));
    expect(screen.getByTestId('question-progress').textContent).toBe('1/2 답변');
    expect(screen.getByTestId('question-left').textContent).toBe('1개 남음');
    fireEvent.change(screen.getByLabelText('Features 직접 입력'), { target: { value: 'all' } });
    expect(screen.getByTestId('question-progress').textContent).toBe('2/2 답변');
    expect(screen.getByTestId('question-left').textContent).toBe('모두 골랐어요');
    // Whitespace-only free text does not count as an answer.
    fireEvent.change(screen.getByLabelText('Features 직접 입력'), { target: { value: '   ' } });
    expect(screen.getByTestId('question-left').textContent).toBe('1개 남음');
  });

  it('a single question shows no progress counter', () => {
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={vi.fn()} />);
    expect(screen.queryByTestId('question-progress')).toBeNull();
    expect(screen.getByText('Claude 가 선택을 기다려요')).toBeTruthy();
  });

  it('the 기타 row and multi-select picks are mutually exclusive: typing clears every pick, picking clears the text', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={{ ...req, questions: [req.questions[1]!] }} onAnswer={onAnswer} />);
    const a = screen.getByText('a').closest('button')!;
    const b = screen.getByText('b').closest('button')!;
    fireEvent.click(a);
    fireEvent.click(b);
    const free = screen.getByPlaceholderText('기타 (직접 입력)') as HTMLInputElement;
    fireEvent.change(free, { target: { value: 'none' } });
    expect(a.getAttribute('aria-pressed')).toBe('false');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(free.closest('label')!.className).toContain('picked');
    fireEvent.click(b);
    expect(free.value).toBe('');
    expect(free.closest('label')!.className).not.toContain('picked');
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which features?': 'b' });
  });
});
