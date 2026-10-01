// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Chat } from './Chat';
import type { ChatProps } from './Chat';
import type { ChatItem } from '../state';

// jsdom has no layout, hence no scrollIntoView.
Element.prototype.scrollIntoView = () => {};

const failed: ChatItem = { kind: 'assistant', turnId: 't', text: '', toolCalls: [], badge: null, streaming: false, error: '한도 도달', notes: [], attempts: [] };

function renderChat(items: ChatItem[], busy = false, onSend = vi.fn(), extra: Partial<ChatProps> = {}) {
  render(<Chat items={items} pending={[]} questions={[]} activeTurnId={null} busy={busy} title="t" model="opus" engine="claude" sandbox="read-only" sessionEngine={null} sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={onSend} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} {...extra} />);
  return onSend;
}

describe('Chat', () => {
  afterEach(cleanup);

  it('a failed last turn offers 재시도, which re-sends the same prompt', () => {
    const onSend = renderChat([{ kind: 'user', text: 'first' }, { ...failed, error: null, text: 'fine' }, { kind: 'user', text: 'do the thing' }, failed]);
    fireEvent.click(screen.getByText('재시도'));
    expect(onSend).toHaveBeenCalledWith('do the thing');
    expect(screen.getAllByText('재시도')).toHaveLength(1);
  });

  it('no 재시도 while busy or when the last turn succeeded', () => {
    renderChat([{ kind: 'user', text: 'x' }, failed], true);
    expect(screen.queryByText('재시도')).toBeNull();
    cleanup();
    renderChat([{ kind: 'user', text: 'x' }, { ...failed, error: null }]);
    expect(screen.queryByText('재시도')).toBeNull();
  });

  it('engine picker only for a new session with Codex available; GPT engine shows the sandbox picker and GPT models; a Codex session shows its sandbox tag', () => {
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: false });
    expect(screen.queryByTestId('engine-select')).toBeNull();
    cleanup();
    const onEngine = vi.fn();
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: true, engine: 'codex', model: 'gpt-6-sol', onEngine });
    fireEvent.change(screen.getByTestId('engine-select'), { target: { value: 'auto' } });
    expect(onEngine).toHaveBeenCalledWith('auto');
    expect(screen.getByTestId('sandbox-select')).toBeTruthy();
    expect(Array.from((screen.getByTestId('model-select') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['gpt-6-sol', 'gpt-6-astra']);
    cleanup();
    renderChat([], false, vi.fn(), { sessionEngine: 'codex', sessionSandbox: 'workspace-write', model: 'gpt-6-astra' });
    expect(screen.getByText(/샌드박스: 작업폴더 쓰기/)).toBeTruthy();
    expect(screen.queryByTestId('engine-select')).toBeNull();
  });

  it('PF11: a new session follows the engine picker even when the session engine frozen at open says claude', () => {
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: true, engine: 'codex', sessionEngine: 'claude', model: 'gpt-6-sol' });
    expect(screen.getByTestId('sandbox-select')).toBeTruthy();
    expect(Array.from((screen.getByTestId('model-select') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['gpt-6-sol', 'gpt-6-astra']);
    expect(screen.queryByText(/샌드박스:/)).toBeNull();
  });

  it('pasting an image uploads it and reports the attachment; sending with attachments only uses a default text', async () => {
    const uploadFn = vi.fn(async (f: File) => ({ id: 'id-1', name: f.name, size: f.size, isImage: true }));
    const onAttach = vi.fn();
    const onSend = renderChat([], false, vi.fn(), { uploadFn, onAttach, attachments: [{ id: 'id-0', name: 'prev.png', size: 1, isImage: true }] });
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(screen.getByPlaceholderText(/메시지/), { clipboardData: { files: [file], items: [] } });
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith({ id: 'id-1', name: 'shot.png', size: 1, isImage: true }));
    fireEvent.click(screen.getByText('보내기'));
    expect(onSend).toHaveBeenCalledWith('첨부 파일을 확인해 주세요.');
  });

  it('renders question cards and forwards answers', () => {
    const onAnswer = vi.fn();
    renderChat([], false, vi.fn(), { onAnswer, questions: [{ turnId: 't', sessionId: 's', cwd: '/w', requestId: 'q1', questions: [{ question: 'Which?', header: '', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }], multiSelect: false }] }] });
    fireEvent.click(screen.getByText('b'));
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which?': 'b' });
  });
});

describe('Chat composer and header (Desktop style)', () => {
  afterEach(cleanup);
  it('header shows the title and the folder chip (full path on hover); a running turn shows the status line and a stop button', () => {
    const onInterrupt = vi.fn();
    renderChat([{ kind: 'user', text: 'x' }, { kind: 'assistant', turnId: 't1', text: '', toolCalls: [{ toolUseId: '1', name: 'Bash', input: { command: 'ls' }, result: null, isError: false }], badge: null, streaming: true, error: null, notes: [], attempts: [] }], true, vi.fn(), { activeTurnId: 't1', cwd: '/Users/u/Documents/proj', onInterrupt });
    const chip = screen.getByText('proj');
    expect(chip.getAttribute('title')).toBe('/Users/u/Documents/proj');
    const status = screen.getByTestId('turn-status');
    expect(status.textContent).toContain('실행 중인 작업 1개');
    expect(status.textContent).toContain('도구 1회');
    fireEvent.click(screen.getByText('중단'));
    expect(onInterrupt).toHaveBeenCalled();
    cleanup();
    renderChat([]);
    expect(screen.queryByTestId('turn-status')).toBeNull();
  });
});
