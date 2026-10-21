// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Pane } from './Pane';
import { PREVIEW_FRAME_SRC, SidePanel } from './SidePanel';
import { newPane, type PaneState } from '../state';
import { Markdown } from './MessageView';
import { SidePanelContext } from '../sidePanel';
import { SIDE_WIDTH_KEY, forgetSideTabs } from '../sideTabs';
import { CopyButton } from './CopyButton';

Element.prototype.scrollIntoView = () => {};

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('SidePanel', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows a text file with line numbers, path relative to the cwd, and asks the server with cwd + session', async () => {
    const fetchFn = mockFetch({ path: '/w/src/a.ts', size: 4, kind: 'text', text: 'a\nb\nc\n' });
    render(<SidePanel doc={{ kind: 'file', path: '/w/src/a.ts' }} cwd="/w" sessionId="s1" onClose={() => {}} onOpen={() => {}} />);
    expect((await screen.findByTestId('side-text')).textContent).toContain('a\nb\nc');
    expect(screen.getByTestId('side-text').querySelector('.side-gutter')!.textContent).toBe('1\n2\n3');
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe('/api/file?cwd=%2Fw&path=%2Fw%2Fsrc%2Fa.ts&session=s1');
    expect(screen.getByText('경로 복사')).toBeTruthy();
  });

  it('shows the server error (e.g. outside the folder)', async () => {
    mockFetch({ error: '세션 폴더 안의 파일만 열 수 있습니다' }, 403);
    render(<SidePanel doc={{ kind: 'file', path: '/etc/hosts' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe('세션 폴더 안의 파일만 열 수 있습니다');
  });

  it('HTML preview: sandboxed iframe (scripts only, never same-origin) on the shell URL; 원문 tab shows the source', () => {
    render(<SidePanel doc={{ kind: 'html', title: 'HTML 미리보기', html: '<b>hi</b>' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    const frame = screen.getByTestId('html-preview') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(PREVIEW_FRAME_SRC);
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: '원문' }));
    expect(screen.getByTestId('side-text').textContent).toContain('<b>hi</b>');
  });

  it('an edit opens on its 변경 사항 tab', async () => {
    mockFetch({ path: '/w/a.ts', size: 1, kind: 'text', text: 'x' });
    const diff = { path: '/w/a.ts', isNew: false, isDeleted: false, note: null, added: 1, removed: 0, lines: [{ kind: 'add' as const, text: 'x', oldNo: null, newNo: 1 }] };
    render(<SidePanel doc={{ kind: 'file', path: '/w/a.ts', diffs: [diff] }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole('tab', { name: '변경 사항' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('diff-card')).toBeTruthy();
  });
});

describe('Pane side panel', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const pane: PaneState = {
    ...newPane('p1'),
    session: { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null },
    items: [{ kind: 'assistant', turnId: 't1', text: 'See `src/b.md` and\n\n```html\n<p>x</p>\n```\n', toolCalls: [{ toolUseId: 'u1', name: 'Read', input: { file_path: '/w/src/a.ts' }, result: 'ok', isError: false }], badge: null, streaming: false, error: null, notes: [], attempts: [] }],
  };
  const renderPane = () => render(<Pane pane={pane} app={{ pending: [], questions: [], codexAvailable: false }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} />);

  it('a Read path opens the panel; Esc closes it', async () => {
    mockFetch({ path: '/w/src/a.ts', size: 1, kind: 'text', text: 'x' });
    renderPane();
    expect(screen.queryByTestId('side-panel')).toBeNull();
    fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
    expect(await screen.findByTestId('side-text')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('side-panel')).toBeNull();
  });

  it('inline code paths, the html block 미리보기 and the 파일 button open it too', async () => {
    mockFetch({ path: '/w/src/b.md', size: 1, kind: 'text', text: '# T' });
    renderPane();
    fireEvent.click(screen.getByTitle('src/b.md — 사이드 패널에서 열기'));
    expect((await screen.findByRole('heading', { name: 'T' }))).toBeTruthy();
    fireEvent.click(screen.getByText('미리보기'));
    expect(screen.getByTestId('html-preview')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('사이드 패널 닫기'));
    fireEvent.click(screen.getByTestId('session-chip-head')); // 파일 lives in the header ⋯ menu
    fireEvent.click(screen.getByRole('menuitem', { name: '파일 열기' }));
    expect(screen.getByLabelText('세션 폴더의 파일 경로')).toBeTruthy();
  });
});

describe('html block with md-render highlighting', () => {
  afterEach(cleanup);

  it('keeps the language label, 미리보기 and 코드 복사 together once highlight.js has run; 미리보기 gets the raw source', async () => {
    const open = vi.fn();
    const { container } = render(<SidePanelContext.Provider value={open}><Markdown text={'```html\n<b class="x">hi</b>\n```'} /></SidePanelContext.Provider>);
    await waitFor(() => expect(container.querySelector('.code-block code.hljs')).not.toBeNull());
    expect(container.querySelector('.code-lang')!.textContent).toBe('html');
    expect(screen.getByLabelText('코드 복사')).toBeTruthy();
    fireEvent.click(screen.getByText('미리보기'));
    expect(open).toHaveBeenCalledWith({ kind: 'html', title: 'HTML 미리보기', html: '<b class="x">hi</b>' });
  });
});

describe('SidePanel header buttons (narrow panel)', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('복사 / 경로 복사 carry an icon a narrow panel can show alone, named by title and aria-label; ✕ is the outlined close', async () => {
    mockFetch({ path: '/w/a.ts', size: 2, kind: 'text', text: 'a\n' });
    render(<SidePanel doc={{ kind: 'file', path: '/w/a.ts' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    await screen.findByTestId('side-text');
    for (const name of ['내용 복사', '경로 복사']) {
      const b = screen.getByRole('button', { name });
      expect(b.classList.contains('copy-compact')).toBe(true);
      expect(b.getAttribute('title')).toBe(name);
      expect(b.querySelector('.copy-compact-icon svg')).not.toBeNull();
      expect(b.querySelector('.copy-compact-caption')!.textContent).toBe(name === '경로 복사' ? '경로 복사' : '복사');
    }
    expect(screen.getByRole('button', { name: '사이드 패널 닫기' }).classList.contains('side-close')).toBe(true);
  });

  it('CopyButton elsewhere (code blocks, message actions) is unchanged', () => {
    render(<><CopyButton text="x" /><CopyButton text="y" icon label="코드 복사" /></>);
    const text = screen.getByRole('button', { name: '복사' });
    expect(text.className).toBe('code-copy');
    expect(text.textContent).toBe('복사');
    expect(text.querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: '코드 복사' }).classList.contains('copy-compact')).toBe(false);
  });
});

describe('SidePanel code highlighting', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('colours a known language with the hljs classes and keeps the line numbers', async () => {
    mockFetch({ path: '/w/a.ts', size: 30, kind: 'text', text: 'const a = 1;\n// note\n' });
    render(<SidePanel doc={{ kind: 'file', path: '/w/a.ts' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    await waitFor(() => expect(document.querySelector('.side-lines .hljs-keyword')?.textContent).toBe('const'));
    expect(document.querySelector('.side-lines .hljs-comment')!.textContent).toBe('// note');
    expect(screen.getByTestId('side-text').textContent).toContain('const a = 1;');
    expect(document.querySelector('.side-gutter')!.textContent).toBe('1\n2');
  });

  it('an extension named like an Object member stays plain instead of throwing', async () => {
    mockFetch({ path: '/w/x.constructor', size: 1, kind: 'text', text: 'a\n' });
    render(<SidePanel doc={{ kind: 'file', path: '/w/x.constructor' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    expect((await screen.findByTestId('side-text')).textContent).toContain('a');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('side-text').querySelector('.side-lines span')).toBeNull();
  });

  it('leaves big files and unknown types plain', async () => {
    mockFetch({ path: '/w/a.ts', size: 1, kind: 'text', text: 'const a = 1;\n' });
    const first = render(<SidePanel doc={{ kind: 'file', path: '/w/a.ts' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    await waitFor(() => expect(document.querySelector('.side-lines .hljs-keyword')).not.toBeNull()); // grammars loaded
    first.unmount();
    mockFetch({ path: '/w/big.ts', size: 1, kind: 'text', text: 'const a = 1;\n'.repeat(5001) });
    const big = render(<SidePanel doc={{ kind: 'file', path: '/w/big.ts' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    await screen.findByTestId('side-text');
    expect(document.querySelector('.side-lines span')).toBeNull();
    big.unmount();
    mockFetch({ path: '/w/n.txt', size: 1, kind: 'text', text: 'const a = 1;\n' });
    render(<SidePanel doc={{ kind: 'file', path: '/w/n.txt' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    await screen.findByTestId('side-text');
    expect(document.querySelector('.side-lines span')).toBeNull();
  });
});

describe('Pane side panel tabs', () => {
  beforeEach(() => { forgetSideTabs(); localStorage.clear(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const session = { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude' as const, sandbox: null };
  const pane = (sessionId = 's1'): PaneState => ({
    ...newPane('p1'),
    session: { ...session, sessionId },
    items: [{ kind: 'assistant', turnId: 't1', text: 'See `src/b.md` and\n\n```html\n<p>x</p>\n```\n', toolCalls: [{ toolUseId: 'u1', name: 'Read', input: { file_path: '/w/src/a.ts' }, result: 'ok', isError: false }], badge: null, streaming: false, error: null, notes: [], attempts: [] }],
  });
  const ui = (sessionId?: string) => <Pane pane={pane(sessionId)} app={{ pending: [], questions: [], codexAvailable: false }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} />;
  const docTabs = () => within(screen.getByRole('tablist', { name: '열린 문서' })).getAllByRole('tab');
  const selected = () => docTabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;

  it('a tab per document; opening one again activates it; closing the active goes back; the last closes the panel', () => {
    mockFetch({ path: '/w/x', size: 1, kind: 'text', text: 'x' });
    render(ui());
    fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
    fireEvent.click(screen.getByTitle('src/b.md — 사이드 패널에서 열기'));
    expect(docTabs().map((t) => t.textContent)).toEqual(['a.ts', 'b.md']);
    expect(docTabs()[0]!.getAttribute('title')).toBe('/w/src/a.ts');
    expect(selected()).toBe('b.md');
    fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
    expect(docTabs()).toHaveLength(2);
    expect(selected()).toBe('a.ts');
    fireEvent.click(screen.getByText('미리보기')); // the reply's html block
    expect(selected()).toBe('HTML 미리보기');
    fireEvent.click(screen.getByRole('button', { name: 'HTML 미리보기 닫기' }));
    expect(selected()).toBe('a.ts');
    fireEvent(docTabs()[0]!.parentElement!, new MouseEvent('auxclick', { bubbles: true, button: 1 })); // middle click
    expect(docTabs().map((t) => t.textContent)).toEqual(['b.md']);
    fireEvent.click(screen.getByRole('button', { name: 'b.md 닫기' }));
    expect(screen.queryByTestId('side-panel')).toBeNull();
  });

  it('a file picked in 파일 열기 replaces that tab', () => {
    mockFetch({ files: ['src/c.ts'] });
    render(ui());
    fireEvent.click(screen.getByTestId('session-chip-head'));
    fireEvent.click(screen.getByRole('menuitem', { name: '파일 열기' }));
    expect(selected()).toBe('파일 열기');
    fireEvent.change(screen.getByLabelText('세션 폴더의 파일 경로'), { target: { value: 'src/c.ts' } });
    fireEvent.click(screen.getByRole('button', { name: '열기' }));
    expect(docTabs().map((t) => t.textContent)).toEqual(['c.ts']);
  });

  it('another session shows its own (none); coming back reopens the tabs', () => {
    mockFetch({ path: '/w/x', size: 1, kind: 'text', text: 'x' });
    const { rerender } = render(ui());
    fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
    fireEvent.click(screen.getByTitle('src/b.md — 사이드 패널에서 열기'));
    fireEvent.click(docTabs()[0]!);
    rerender(ui('s2'));
    expect(screen.queryByTestId('side-panel')).toBeNull();
    rerender(ui('s1'));
    expect(docTabs().map((t) => t.textContent)).toEqual(['a.ts', 'b.md']);
    expect(selected()).toBe('a.ts');
  });

  it('a session switch remounts the document view (tab ids restart per session)', () => {
    const { rerender } = render(ui());
    fireEvent.click(screen.getByText('미리보기'));
    const first = screen.getByTestId('html-preview');
    rerender(ui('s2'));
    fireEvent.click(screen.getByText('미리보기'));
    expect(screen.getByTestId('html-preview')).not.toBe(first);
  });

  it('a new chat keeps its tabs when its first message gives it a session id', () => {
    mockFetch({ path: '/w/x', size: 1, kind: 'text', text: 'x' });
    const { rerender } = render(<Pane pane={{ ...pane(), session: { ...session, sessionId: null } }} app={{ pending: [], questions: [], codexAvailable: false }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
    rerender(ui('s9'));
    expect(docTabs().map((t) => t.textContent)).toEqual(['a.ts']);
  });

  it('the same file by relative and absolute path is one tab', () => {
    mockFetch({ path: '/w/x', size: 1, kind: 'text', text: 'x' });
    const p = pane();
    const items = [{ ...(p.items[0] as Extract<PaneState['items'][number], { kind: 'assistant' }>), text: 'See `src/a.ts`' }];
    render(<Pane pane={{ ...p, items }} app={{ pending: [], questions: [], codexAvailable: false }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('src/a.ts — 사이드 패널에서 열기'));
    fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
    expect(docTabs()).toHaveLength(1);
  });

  it('on a phone the remembered tabs wait closed; opening a document shows them again', () => {
    mockFetch({ path: '/w/x', size: 1, kind: 'text', text: 'x' });
    const { unmount } = render(ui());
    fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
    unmount();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-width: 720px)', addEventListener() {}, removeEventListener() {} }));
    render(ui());
    expect(screen.queryByTestId('side-panel')).toBeNull();
    fireEvent.click(screen.getByTitle('src/b.md — 사이드 패널에서 열기'));
    expect(docTabs().map((t) => t.textContent)).toEqual(['a.ts', 'b.md']);
  });

  it('desktop: Esc slides the panel shut; opening during the slide shows it at once; leaving mid-slide forgets the tabs', () => {
    vi.useFakeTimers();
    try {
      mockFetch({ path: '/w/x', size: 1, kind: 'text', text: 'x' });
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width: 721px'), addEventListener() {}, removeEventListener() {} }));
      const { rerender } = render(ui());
      fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(document.querySelector('.side-wrap')!.classList.contains('closing')).toBe(true);
      fireEvent.click(screen.getByTitle('src/b.md — 사이드 패널에서 열기'));
      const wrap = document.querySelector('.side-wrap')!;
      expect(wrap.classList.contains('closing')).toBe(false);
      expect(wrap.classList.contains('instant')).toBe(true);
      fireEvent.keyDown(window, { key: 'Escape' });
      rerender(ui('s2'));
      rerender(ui('s1'));
      expect(screen.queryByTestId('side-panel')).toBeNull();
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.queryByTestId('side-panel')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('the width comes from storage and a drag saves it', () => {
    mockFetch({ path: '/w/x', size: 1, kind: 'text', text: 'x' });
    localStorage.setItem(SIDE_WIDTH_KEY, '520');
    render(ui());
    fireEvent.click(screen.getByTitle('/w/src/a.ts — 사이드 패널에서 열기'));
    const wrap = document.querySelector<HTMLElement>('.side-wrap')!;
    expect(wrap.style.width).toBe('520px');
    const splitter = screen.getByRole('separator', { name: '사이드 패널 크기 조절' });
    fireEvent.pointerDown(splitter, { pointerId: 1 });
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: -400 });
    fireEvent.pointerUp(splitter, { pointerId: 1 });
    expect(localStorage.getItem(SIDE_WIDTH_KEY)).toBe(wrap.style.width.replace('px', ''));
    expect(wrap.style.width).not.toBe('520px');
  });
});
