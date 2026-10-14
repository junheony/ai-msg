// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TurnBadge } from '../../shared/protocol';
import { MessageView } from './MessageView';
import { SessionCwdDialog } from './SessionCwdDialog';
import { Sidebar } from './Sidebar';

const noop = () => {};
const s = (id: string, title: string, engine?: 'gemini') => ({ sessionId: id, account: 'b' as const, cwd: '/w/one', projectDir: '/p', file: '/f', title, lastModified: Date.now(), sizeBytes: 1, ...(engine ? { engine } : {}) });
const badge: TurnBadge = { account: 'b', model: 'opus', reason: '', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 } as never, modelNote: null };
const assistant = (extra: object) => ({ kind: 'assistant' as const, turnId: 't', text: 'ok', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], ...extra });

describe('세션 ⋯ 메뉴: 작업 폴더 바꾸기 · 복제', () => {
  afterEach(cleanup);

  it('the sidebar row menu offers both and hands over the session; a Gemini session gets no 작업 폴더 바꾸기', () => {
    const onSetCwd = vi.fn();
    const onDuplicate = vi.fn();
    const projects = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', 'first'), s('g1', 'gem', 'gemini')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onRename={noop} onSetCwd={onSetCwd} onDuplicate={onDuplicate} />);
    const menus = () => screen.getAllByLabelText('세션 메뉴');
    const rowOf = (title: string) => menus().find((b) => b.closest('li, [role="listitem"], .session-row, div')?.textContent?.includes(title))!;
    fireEvent.click(rowOf('first'));
    fireEvent.click(screen.getByRole('menuitem', { name: '작업 폴더 바꾸기' }));
    expect(onSetCwd).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
    fireEvent.click(rowOf('first'));
    fireEvent.click(screen.getByRole('menuitem', { name: '복제' }));
    expect(onDuplicate).toHaveBeenCalledWith('s1');
    fireEvent.click(rowOf('gem'));
    expect(screen.queryByRole('menuitem', { name: '작업 폴더 바꾸기' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '복제' })).toBeTruthy();
  });

  it('without the handlers (an older server) neither item shows', () => {
    const projects = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', 'first')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onRename={noop} />);
    fireEvent.click(screen.getAllByLabelText('세션 메뉴')[0]!);
    expect(screen.queryByRole('menuitem', { name: '작업 폴더 바꾸기' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '복제' })).toBeNull();
  });

  it('the folder dialog hands the server-checked folder to onPick; Esc closes it', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ path: '/Users/u/x', recent: ['/Users/u/x'] }), { status: 200 });
      if (url === '/api/recent-folders') return new Response(JSON.stringify({ recent: [] }), { status: 200 });
      return new Response(JSON.stringify({ path: '/Users/u', parent: null, dirs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<SessionCwdDialog title="first" cwd="/w/one" onPick={onPick} onClose={onClose} fetchFn={fetchFn} />);
    expect(screen.getByRole('dialog', { name: '작업 폴더 바꾸기' }).textContent).toContain('/w/one');
    fireEvent.change(screen.getByLabelText('폴더 경로'), { target: { value: '~/x' } });
    fireEvent.click(screen.getByText('열기'));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('/Users/u/x'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('턴별 모델 표시', () => {
  afterEach(cleanup);

  it('the badge shows the turn\'s own model first; a history turn with no badge still names it', () => {
    const live = render(<MessageView item={assistant({ badge, model: 'fable' })} />);
    expect(live.container.querySelector('.tb-model')!.textContent).toBe('Fable');
    live.unmount();
    const old = render(<MessageView item={assistant({ model: 'claude-opus-5-5' })} />);
    expect(old.getByTestId('msg-model').textContent).toBe('Opus 5.5');
    old.unmount();
    const none = render(<MessageView item={assistant({ badge })} />);
    expect(none.container.querySelector('.tb-model')!.textContent).toBe('Opus');
    expect(none.queryByTestId('msg-model')).toBeNull();
  });
});
