// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewChat } from './NewChat';
import type { ProjectEntry } from '../../shared/session-types';
import { loadDraft, saveDraft } from '../drafts';

const projects = [{ cwd: '/w', name: 'w', pinned: true, sessions: [] }] as unknown as ProjectEntry[];

describe('NewChat', () => {
  afterEach(cleanup);
  beforeEach(() => localStorage.clear());

  it('최근 대화 cards carry the engine mark before the title', () => {
    const sessions = [
      { sessionId: 'c', account: 'a', cwd: '/w', projectDir: '/p', file: '/f', title: 'claude one', lastModified: 2, sizeBytes: 1 },
      { sessionId: 'g', account: 'gpt', engine: 'codex', cwd: '/w', projectDir: '', file: '', title: 'codex one', lastModified: 1, sizeBytes: 1 },
    ];
    render(<NewChat projects={[{ cwd: '/w', name: 'w', pinned: true, sessions }] as unknown as ProjectEntry[]} onStart={vi.fn()} onOpenSession={vi.fn()} now={10} />);
    expect(screen.getByText('claude one').querySelector('.engine-mark')?.getAttribute('title')).toBe('Claude');
    expect(screen.getByText('codex one').querySelector('.engine-mark')?.getAttribute('title')).toBe('Codex (GPT)');
  });

  const sess = (sessionId: string, lastModified: number, extra: Record<string, unknown> = {}) =>
    ({ sessionId, account: 'a', cwd: '/w', projectDir: '/p', file: '/f', title: `t-${sessionId}`, lastModified, sizeBytes: 1, ...extra });
  const many = (n: number, extra: Record<string, unknown>[] = []) =>
    [{ cwd: '/w', name: 'w', pinned: true, sessions: [...Array.from({ length: n }, (_, i) => sess(`s${i}`, 100 - i)), ...extra] }] as unknown as ProjectEntry[];
  const titles = (label: string) => Array.from(screen.getByRole('region', { name: label }).querySelectorAll('.newchat-card-title')).map((e) => e.textContent);

  it('고정됨 lists pinned sessions in pin order (archived left out) and 최근 대화 the 10 newest others', () => {
    const onOpenSession = vi.fn();
    render(<NewChat projects={many(14, [sess('old', 1, { archived: true })])} pins={['s5', 'old', 's0', 'gone', 's5']} onStart={vi.fn()} onOpenSession={onOpenSession} now={1000} />);
    expect(titles('고정된 대화')).toEqual(['t-s5', 't-s0']);
    expect(screen.getByRole('region', { name: '고정된 대화' }).querySelectorAll('.newchat-card-pin svg')).toHaveLength(2);
    expect(titles('최근 대화')).toEqual(['t-s1', 't-s2', 't-s3', 't-s4', 't-s6', 't-s7', 't-s8', 't-s9', 't-s10', 't-s11']);
    expect(screen.getByRole('region', { name: '최근 대화' }).querySelector('.newchat-card-pin')).toBeNull();
    fireEvent.click(screen.getByText('t-s5'));
    expect(onOpenSession).toHaveBeenCalledWith('s5', '/w', 't-s5');
  });

  it('no pins: no 고정됨 section', () => {
    render(<NewChat projects={many(3)} pins={[]} onStart={vi.fn()} onOpenSession={vi.fn()} now={1000} />);
    expect(screen.queryByRole('region', { name: '고정된 대화' })).toBeNull();
    expect(titles('최근 대화')).toEqual(['t-s0', 't-s1', 't-s2']);
  });

  it('the ↑ button opens an empty new session when nothing is typed', () => {
    const onStart = vi.fn();
    render(<NewChat projects={projects} onStart={onStart} />);
    const go = screen.getByLabelText('빈 새 대화 열기');
    fireEvent.click(go);
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '', [], { engine: 'claude', sandbox: 'workspace-write' });
  });

  it('picked and pasted attachments ride the first message', async () => {
    const onStart = vi.fn();
    const uploadFn = vi.fn(async (f: File) => ({ id: `id-${f.name}`, name: f.name, size: f.size, isImage: f.type.startsWith('image/') }));
    render(<NewChat projects={projects} onStart={onStart} uploadFn={uploadFn} />);
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('attachment-gallery'), { target: { files: [shot] } });
    const notes = new File(['y'], 'notes.md', { type: 'text/markdown' });
    fireEvent.paste(screen.getByLabelText('첫 메시지'), { clipboardData: { files: [notes] } });
    await waitFor(() => expect(screen.getByText(/notes\.md/)).toBeTruthy());
    expect(screen.getByText(/shot\.png/)).toBeTruthy();
    const box = screen.getByLabelText('첫 메시지');
    fireEvent.change(box, { target: { value: '이거 봐줘' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '이거 봐줘', [
      { id: 'id-shot.png', name: 'shot.png', size: 1, isImage: true },
      { id: 'id-notes.md', name: 'notes.md', size: 1, isImage: false },
    ], { engine: 'claude', sandbox: 'workspace-write' });
  });

  it('long text pastes become 붙여넣은 텍스트 chips (pasted-1/2.txt, preview, ×) riding the first message; short text stays in the box', async () => {
    const onStart = vi.fn();
    const uploadFn = vi.fn(async (f: File) => ({ id: `id-${f.name}`, name: f.name, size: f.size, isImage: false }));
    render(<NewChat projects={projects} onStart={onStart} uploadFn={uploadFn} />);
    const box = screen.getByLabelText('첫 메시지') as HTMLTextAreaElement;
    const paste = (text: string) => fireEvent.paste(box, { clipboardData: { files: [], getData: (t: string) => (t === 'text/plain' ? text : '') } });
    expect(paste('짧은 글')).toBe(true);
    expect(uploadFn).not.toHaveBeenCalled();
    const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    expect(paste(long)).toBe(false);
    paste('z'.repeat(2000));
    await waitFor(() => expect(screen.getAllByTestId('pasted-chip')).toHaveLength(2));
    expect(uploadFn.mock.calls.map((c) => c[0].name)).toEqual(['pasted-1.txt', 'pasted-2.txt']);
    expect(screen.getAllByTestId('pasted-chip')[0]!.textContent).toContain(`30줄 · ${long.length}자`);
    fireEvent.click(screen.getAllByTitle('붙여넣은 내용 보기')[0]!);
    expect(screen.getByRole('dialog', { name: '붙여넣은 텍스트 미리보기' }).textContent).toBe(long);
    fireEvent.click(screen.getAllByLabelText('첨부 제거')[1]!);
    expect(screen.getAllByTestId('pasted-chip')).toHaveLength(1);
    fireEvent.change(box, { target: { value: '요약해줘' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '요약해줘', [{ id: 'id-pasted-1.txt', name: 'pasted-1.txt', size: long.length, isImage: false }], { engine: 'claude', sandbox: 'workspace-write' });
  });

  it('attachments alone still send (with the attachment-only text); a removed one does not', async () => {
    const onStart = vi.fn();
    const uploadFn = vi.fn(async (f: File) => ({ id: f.name, name: f.name, size: f.size, isImage: false }));
    render(<NewChat projects={projects} onStart={onStart} uploadFn={uploadFn} />);
    fireEvent.change(screen.getByTestId('attachment-input'), { target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] } });
    await waitFor(() => expect(screen.getAllByLabelText('첨부 제거')).toHaveLength(2));
    fireEvent.click(screen.getAllByLabelText('첨부 제거')[0]!);
    fireEvent.click(screen.getByLabelText(/^보내기/));
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '첨부 파일을 확인해 주세요.', [{ id: 'b.txt', name: 'b.txt', size: 1, isImage: false }], { engine: 'claude', sandbox: 'workspace-write' });
  });

  it('restores its draft (per draftKey), saves on change and clears it on send', () => {
    saveDraft('new:p1', '어제 쓰던 글');
    const onStart = vi.fn();
    render(<NewChat projects={projects} onStart={onStart} draftKey="new:p1" />);
    const box = screen.getByLabelText('첫 메시지') as HTMLTextAreaElement;
    expect(box.value).toBe('어제 쓰던 글');
    fireEvent.change(box, { target: { value: '고친 글' } });
    expect(loadDraft('new:p1')).toBe('고친 글');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '고친 글', [], { engine: 'claude', sandbox: 'workspace-write' });
    expect(loadDraft('new:p1')).toBe('');
  });

  it('without a draftKey it uses the shared new-chat key', () => {
    render(<NewChat projects={projects} onStart={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('첫 메시지'), { target: { value: '초안' } });
    expect(loadDraft('new')).toBe('초안');
  });

  it('no engine picker when only Claude is available', () => {
    render(<NewChat projects={projects} onStart={vi.fn()} />);
    expect(screen.queryByTestId('engine-select')).toBeNull();
    expect(screen.queryByTestId('sandbox-select')).toBeNull();
  });

  it('engine picker; picking GPT shows the sandbox picker and the submit carries both', () => {
    const onStart = vi.fn();
    const onEngine = vi.fn();
    const onSandbox = vi.fn();
    render(<NewChat projects={projects} onStart={onStart} codexAvailable onEngine={onEngine} onSandbox={onSandbox} />);
    const engine = screen.getByTestId('engine-select') as HTMLSelectElement;
    expect(engine.value).toBe('claude');
    expect(screen.queryByTestId('sandbox-select')).toBeNull();
    fireEvent.change(engine, { target: { value: 'codex' } });
    expect(onEngine).toHaveBeenCalledWith('codex');
    const sandbox = screen.getByTestId('sandbox-select') as HTMLSelectElement;
    // 다 붙여: workspace-write with network is the default; read-only stays selectable.
    expect(sandbox.value).toBe('workspace-write');
    expect(sandbox.parentElement!.querySelector('.pick-label')!.textContent).toBe('작업폴더 쓰기 · 네트워크');
    fireEvent.change(sandbox, { target: { value: 'read-only' } });
    expect(onSandbox).toHaveBeenCalledWith('read-only');
    expect(sandbox.parentElement!.querySelector('.pick-label')!.textContent).toBe('읽기 전용');
    fireEvent.change(screen.getByLabelText('첫 메시지'), { target: { value: '고쳐줘' } });
    fireEvent.click(screen.getByLabelText(/^보내기/));
    expect(onStart).toHaveBeenCalledWith('/w', 'w', '고쳐줘', [], { engine: 'codex', sandbox: 'read-only' });
  });

  it('starts from the pane engine/sandbox; Gemini shows its own sandbox labels and needs a login', () => {
    const gemini = { available: true, loggedIn: { g1: true, g2: false } };
    render(<NewChat projects={projects} onStart={vi.fn()} engine="gemini" sandbox="workspace-write" gemini={gemini} />);
    expect((screen.getByTestId('engine-select') as HTMLSelectElement).value).toBe('gemini');
    expect(screen.getByTestId('sandbox-select').parentElement!.querySelector('.pick-label')!.textContent).toBe('파일 편집 허용(셸 거부)');
    cleanup();
    render(<NewChat projects={projects} onStart={vi.fn()} gemini={{ available: true, loggedIn: { g1: false, g2: false } }} />);
    expect((screen.getByRole('option', { name: 'Gemini · 로그인 필요' }) as HTMLOptionElement).disabled).toBe(true);
  });

  it('Ctrl+Enter starts in a new split (text and draft leave this screen); Enter on the 프로젝트 picker starts here', () => {
    const projects2 = [{ cwd: '/w', name: 'w', pinned: true, sessions: [] }, { cwd: '/v', name: 'v', pinned: false, sessions: [] }] as unknown as ProjectEntry[];
    const onStart = vi.fn();
    const onStartSplit = vi.fn();
    render(<NewChat projects={projects2} onStart={onStart} onStartSplit={onStartSplit} draftKey="k" />);
    const box = screen.getByLabelText('첫 메시지') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '안녕' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(onStartSplit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onStartSplit).toHaveBeenCalledWith('/w', 'w', '안녕', [], { engine: 'claude', sandbox: expect.any(String) });
    expect(onStart).not.toHaveBeenCalled();
    expect(box.value).toBe('');
    expect(loadDraft('k')).toBe('');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, shiftKey: true }); // the global maximize's
    expect(onStartSplit).toHaveBeenCalledTimes(1);
    const picker = screen.getByLabelText('프로젝트');
    fireEvent.change(picker, { target: { value: '/v' } });
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledWith('/v', 'v', '', [], expect.anything());
    fireEvent.keyDown(picker, { key: 'Enter', ctrlKey: true });
    expect(onStartSplit).toHaveBeenLastCalledWith('/v', 'v', '', [], expect.anything());
  });

  it('with ⌘Enter as the send key (설정), Ctrl+Enter still starts here', () => {
    localStorage.setItem('deck.prefs.v1', JSON.stringify({ sendKey: 'mod-enter' }));
    const onStart = vi.fn();
    const onStartSplit = vi.fn();
    render(<NewChat projects={projects} onStart={onStart} onStartSplit={onStartSplit} />);
    fireEvent.change(screen.getByLabelText('첫 메시지'), { target: { value: 'x' } });
    fireEvent.keyDown(screen.getByLabelText('첫 메시지'), { key: 'Enter', ctrlKey: true });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStartSplit).not.toHaveBeenCalled();
  });
});
