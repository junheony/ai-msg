// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToolCallView } from './ToolCallView';
import { DiffCard } from './DiffView';
import { CODE_WRAP_KEY } from '../codeWrap';

afterEach(() => { cleanup(); localStorage.clear(); });

const cwd = '/work/proj';

describe('opened tool call', () => {
  it('shows a command as one `$ …` line and a file relative to the session folder, the raw JSON folded', () => {
    const { container, rerender } = render(<ToolCallView call={{ toolUseId: 'a', name: 'Bash', input: { command: 'ls -la', description: 'list' }, result: 'x', isError: false }} cwd={cwd} />);
    expect(container.querySelector('.tool-cmd')!.textContent).toBe('$ ls -la');
    expect(container.querySelector('.tool-raw:not([open])')).not.toBeNull();
    rerender(<ToolCallView call={{ toolUseId: 'b', name: 'Read', input: { file_path: '/work/proj/src/a.ts', limit: 5 }, result: 'x', isError: false }} cwd={cwd} />);
    expect(container.querySelector('.tool-path')!.textContent).toBe('src/a.ts');
    expect(container.querySelector('.tool-fields')!.textContent).toBe('limit5');
  });

  it('shows the last lines of a long output with 전체 보기, saying how many were left out', () => {
    const result = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const { container } = render(<ToolCallView call={{ toolUseId: 'c', name: 'Bash', input: { command: 'seq' }, result, isError: false }} />);
    expect(container.querySelector('.tool-note')!.textContent).toBe('앞 38줄 생략');
    expect(container.querySelector('.tool-output')!.textContent!.split('\n')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: '전체 보기 (50줄)' }));
    expect(container.querySelector('.tool-output')!.textContent).toBe(result);
    expect(container.querySelector('.tool-note')).toBeNull();
  });

  it("says when the server cut the output", () => {
    const { container } = render(<ToolCallView call={{ toolUseId: 'd', name: 'Bash', input: { command: 'cat x' }, result: 'head\n…[잘림: 원래 9000자]', isError: false }} />);
    expect(container.querySelector('.tool-note.cut')!.textContent).toContain('9,000자');
    expect(container.querySelector('.tool-output')!.textContent).toBe('head');
  });

  it('marks a failed call with its exit code', () => {
    const { container } = render(<ToolCallView call={{ toolUseId: 'e', name: 'Bash', input: { command: 'false' }, result: 'Exit code 1\nnope', isError: true }} />);
    expect(container.querySelector('.tool-call.error')).not.toBeNull();
    expect([...container.querySelectorAll('.tool-chip.error')].map((n) => n.textContent)).toEqual(['종료 코드 1', '종료 코드 1']);
    expect(container.querySelector('.tool-output')!.textContent).toBe('nope');
  });
});

describe('diff wrap', () => {
  it('줄바꿈 wraps long diff lines, shared with code blocks', () => {
    const diff = { path: '/work/proj/a.ts', lines: [{ kind: 'add' as const, text: 'x'.repeat(300), oldNo: null, newNo: 1 }], added: 1, removed: 0, isNew: false, isDeleted: false, note: null };
    const { container } = render(<DiffCard diff={diff} cwd={cwd} />);
    expect(container.querySelector('.diff-body.wrap')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '줄바꿈' }));
    expect(container.querySelector('.diff-body.wrap')).not.toBeNull();
    expect(localStorage.getItem(CODE_WRAP_KEY)).toBe('1');
  });
});
