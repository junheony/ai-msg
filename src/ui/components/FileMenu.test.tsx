// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageView } from './MessageView';
import { FolderChip, LONG_PRESS_MS, clampToViewport } from './FileMenu';
import { SidePanel } from './SidePanel';
import { SidePanelContext, inSessionFolder, type SideDoc } from '../sidePanel';
import { setFeatures } from '../features';
import type { ChatItem } from '../state';

const copyText = vi.fn(async (_: string) => true);
vi.mock('../clipboard', () => ({ copyText: (s: string) => copyText(s) }));

const reply = (text: string): ChatItem => ({ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] });

function renderReply(text: string, { cwd = '/w', open = vi.fn() }: { cwd?: string; open?: (d: SideDoc) => void } = {}) {
  const r = render(<SidePanelContext.Provider value={open}><MessageView item={reply(text)} cwd={cwd} /></SidePanelContext.Provider>);
  return { ...r, open };
}

function mockFetch(status: number, body?: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const items = () => screen.getAllByRole('menuitem').map((b) => b.textContent);

// Every suite here talks to a current server (raw bytes + Finder); the old-server case has its own test below.
beforeEach(() => setFeatures(['fileRaw']));

describe('file chip menu', () => {
  beforeEach(() => copyText.mockClear());

  it('without the fileRaw feature (an older server) the menu keeps only panel/copy items and no thumbnail is tried', () => {
    setFeatures([]);
    const { container } = renderReply('본문 `out/a.png` 와 `src/x.ts` 확인');
    expect(container.querySelector('.file-thumb')).toBeNull();
    fireEvent.contextMenu(screen.getByText('src/x.ts'));
    expect(items()).toEqual(['패널에서 열기', '경로 복사', '파일 이름 복사']);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('right-click opens the menu at the pointer with the file items; Esc closes it and refocuses the chip', () => {
    renderReply('see `src/a.ts` here');
    const chip = screen.getByRole('button', { name: 'src/a.ts' });
    expect(chip.getAttribute('title')).toContain('src/a.ts');
    fireEvent.contextMenu(chip, { clientX: 40, clientY: 50 });
    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('file-menu');
    expect(menu.parentElement).toBe(document.body);
    expect(items()).toEqual(['패널에서 열기', '경로 복사', '파일 이름 복사', '다운로드', 'Finder 에서 보기 (서버 Mac)']);
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('경로 복사');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('closes on an outside click and on scroll; only one menu is open at a time', () => {
    renderReply('`a.ts` and `b.ts`');
    fireEvent.contextMenu(screen.getByRole('button', { name: 'a.ts' }), { clientX: 1, clientY: 1 });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'a.ts' }), { clientX: 1, clientY: 1 });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'b.ts' }), { clientX: 2, clientY: 2 });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    fireEvent.scroll(window);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('패널에서 열기 / 경로 복사 / 파일 이름 복사', async () => {
    const { open } = renderReply('`src/a.ts`');
    const chip = screen.getByRole('button', { name: 'src/a.ts' });
    fireEvent.contextMenu(chip, { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole('menuitem', { name: '패널에서 열기' }));
    expect(open).toHaveBeenCalledWith({ kind: 'file', path: 'src/a.ts' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(chip, { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole('menuitem', { name: '경로 복사' }));
    fireEvent.contextMenu(chip, { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole('menuitem', { name: '파일 이름 복사' }));
    expect(copyText.mock.calls.map((c) => c[0])).toEqual(['src/a.ts', 'a.ts']);
    expect((await screen.findByText('파일 이름을 복사했어요'))).toBeTruthy();
  });

  it('Finder 에서 보기 posts { cwd, file } to /api/reveal and toasts the result; 501 toasts the reason', async () => {
    let fetchFn = mockFetch(204);
    renderReply('`src/a.ts`');
    const chip = screen.getByRole('button', { name: 'src/a.ts' });
    fireEvent.contextMenu(chip, { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Finder 에서 보기 (서버 Mac)' }));
    expect(await screen.findByText('서버 Mac 의 Finder 에서 열었어요')).toBeTruthy();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('/api/reveal');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ cwd: '/w', file: 'src/a.ts' });

    fetchFn = mockFetch(501, { error: 'macOS 에서만 됩니다' });
    fireEvent.contextMenu(chip, { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Finder 에서 보기 (서버 Mac)' }));
    expect((await screen.findByRole('alert')).textContent).toContain('macOS 에서만 됩니다');

    mockFetch(404);
    fireEvent.contextMenu(chip, { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Finder 에서 보기 (서버 Mac)' }));
    expect(await screen.findByText('이 AI-MSG 서버는 아직 Finder 열기를 지원하지 않아요')).toBeTruthy();
  });

  it('다운로드 clicks an <a download> on the raw=1&download=1 URL', () => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });
    renderReply('`src/a.ts`');
    fireEvent.contextMenu(screen.getByRole('button', { name: 'src/a.ts' }), { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole('menuitem', { name: '다운로드' }));
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.getAttribute('href')).toBe('/api/file?cwd=%2Fw&path=src%2Fa.ts&raw=1&download=1');
    expect(clicked[0]!.download).toBe('a.ts');
  });

  it('touch long press opens the menu (moving cancels) and swallows the click that ends it', () => {
    vi.useFakeTimers();
    const { open } = renderReply('`src/a.ts`');
    const chip = screen.getByRole('button', { name: 'src/a.ts' });
    fireEvent.pointerDown(chip, { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(chip, { pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 40 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.pointerDown(chip, { pointerType: 'touch', isPrimary: true, pointerId: 2, clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(chip);
    expect(open).not.toHaveBeenCalled();
  });

  it('without a session folder the folder-bound items are left out', () => {
    render(<SidePanelContext.Provider value={vi.fn()}><MessageView item={reply('`src/a.ts`')} /></SidePanelContext.Provider>);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'src/a.ts' }), { clientX: 1, clientY: 1 });
    expect(items()).toEqual(['패널에서 열기', '경로 복사', '파일 이름 복사']);
  });
});

describe('inline image thumbnails', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('an image path in a reply becomes a thumbnail on the raw URL; click opens it in the panel; onError falls back to the chip', () => {
    const { open, container } = renderReply('결과: `shots/a.png`');
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/file?cwd=%2Fw&path=shots%2Fa.png&raw=1');
    expect(img.alt).toBe('a.png');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(container.querySelector('.file-thumb-cap')?.textContent).toBe('a.png');
    fireEvent.click(img);
    expect(open).toHaveBeenCalledWith({ kind: 'file', path: 'shots/a.png' });
    fireEvent.error(img);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'shots/a.png' }).className).toBe('file-link');
  });

  it('right-click on a thumbnail opens the menu with 새 탭에서 크게 (window.open, noopener)', () => {
    const win = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderReply('`shots/a.png`');
    fireEvent.contextMenu(screen.getByRole('img'), { clientX: 5, clientY: 5 });
    expect(items()).toContain('새 탭에서 크게');
    fireEvent.click(screen.getByRole('menuitem', { name: '새 탭에서 크게' }));
    expect(win).toHaveBeenCalledWith('/api/file?cwd=%2Fw&path=shots%2Fa.png&raw=1', '_blank', 'noopener');
  });

  it('a list of image paths renders a thumbnail per item', () => {
    const { container } = renderReply('- `a.png`\n- `b.jpg`\n- `c.webp`');
    expect(container.querySelectorAll('li > .file-thumb')).toHaveLength(3);
  });

  it('paths outside the session folder stay chips (review I8)', () => {
    renderReply('`../x.png` `/etc/y.png` `~/z.png` `/w/in.png`');
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual(['in.png']);
    expect(screen.getByRole('button', { name: '../x.png' }).className).toBe('file-link');
  });

  it('markdown images: a session-folder path is a thumbnail, a remote URL stays a link', () => {
    const { container } = renderReply('![shot](shots/a.png) ![x](https://evil.example/p.png) ![y](//evil.example/q.png)');
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual(['/api/file?cwd=%2Fw&path=shots%2Fa.png&raw=1']);
    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://evil.example/p.png', '//evil.example/q.png']);
  });

  it('no thumbnails in a user message, nor without a side panel', () => {
    const u = render(<SidePanelContext.Provider value={vi.fn()}><MessageView item={{ kind: 'user', text: '`a.png` 봐줘' }} cwd="/w" /></SidePanelContext.Provider>);
    expect(u.container.querySelector('img')).toBeNull();
    u.unmount();
    const r = render(<MessageView item={reply('`a.png`')} cwd="/w" />);
    expect(r.container.querySelector('img')).toBeNull();
  });
});

describe('folder chip menu', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('click opens 경로 복사 / 파일 패널 열기 / Finder 에서 열기; reveal posts file "."', async () => {
    const fetchFn = mockFetch(204);
    const open = vi.fn();
    render(<SidePanelContext.Provider value={open}><FolderChip cwd="/w/proj" name="proj" /></SidePanelContext.Provider>);
    const chip = screen.getByRole('button', { name: 'proj' });
    expect(chip.getAttribute('title')).toBe('/w/proj');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(items()).toEqual(['경로 복사', '파일 패널 열기', 'Finder 에서 열기 (서버 Mac)']);
    fireEvent.click(screen.getByRole('menuitem', { name: '파일 패널 열기' }));
    expect(open).toHaveBeenCalledWith({ kind: 'pick' });
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('menuitem', { name: '경로 복사' }));
    expect(copyText).toHaveBeenLastCalledWith('/w/proj');
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Finder 에서 열기 (서버 Mac)' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body))).toEqual({ cwd: '/w/proj', file: '.' });
    // A second click on the chip closes it (the chip is not "outside").
    fireEvent.click(chip);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('side panel header actions', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('다운로드 and Finder 에서 보기 (서버 Mac) next to 경로 복사', async () => {
    const fetchFn = vi.fn(async (url: string) => (url === '/api/reveal' ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ path: '/w/a.ts', size: 1, kind: 'text', text: 'x' }), { status: 200 })));
    vi.stubGlobal('fetch', fetchFn);
    render(<SidePanel doc={{ kind: 'file', path: 'a.ts' }} cwd="/w" sessionId={null} onClose={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: '다운로드' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finder 에서 보기 (서버 Mac)' }));
    expect(await screen.findByText('서버 Mac 의 Finder 에서 열었어요')).toBeTruthy();
    const call = fetchFn.mock.calls.find((c) => c[0] === '/api/reveal') as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toEqual({ cwd: '/w', file: 'a.ts' });
  });
});

describe('helpers', () => {
  it('clampToViewport keeps the menu inside the screen', () => {
    expect(clampToViewport(10, 10, 100, 50, 400, 300)).toEqual({ left: 10, top: 10 });
    expect(clampToViewport(380, 290, 100, 50, 400, 300)).toEqual({ left: 292, top: 242 });
    expect(clampToViewport(-5, -5, 100, 50, 400, 300)).toEqual({ left: 8, top: 8 });
  });
  it('inSessionFolder: relative without .., or absolute under the cwd', () => {
    expect(inSessionFolder('a/b.png', '/w')).toBe(true);
    expect(inSessionFolder('./b.png', '/w')).toBe(true);
    expect(inSessionFolder('a/../../b.png', '/w')).toBe(false);
    expect(inSessionFolder('~/b.png', '/w')).toBe(false);
    expect(inSessionFolder('/w/b.png', '/w')).toBe(true);
    expect(inSessionFolder('/wx/b.png', '/w')).toBe(false);
  });
});
