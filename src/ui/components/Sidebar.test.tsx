// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Sidebar } from './Sidebar';

const noop = () => {};

describe('Sidebar 폴더 열기 (F1)', () => {
  afterEach(cleanup);

  it('opens the folder picker and hands the server-validated path to onOpenFolder', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ path: '/Users/u/x', recent: ['/Users/u/x'] }), { status: 200 });
      if (url === '/api/recent-folders') return new Response(JSON.stringify({ recent: [] }), { status: 200 });
      return new Response(JSON.stringify({ path: '/Users/u', parent: null, dirs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const onOpenFolder = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenFolder={onOpenFolder} fetchFn={fetchFn} />);
    expect(screen.queryByLabelText('폴더 경로')).toBeNull();
    fireEvent.click(screen.getByText('폴더 열기'));
    fireEvent.change(screen.getByLabelText('폴더 경로'), { target: { value: '~/x' } });
    fireEvent.click(screen.getByText('열기'));
    await waitFor(() => expect(onOpenFolder).toHaveBeenCalledWith('/Users/u/x'));
    expect(screen.queryByLabelText('폴더 경로')).toBeNull();
  });
});
