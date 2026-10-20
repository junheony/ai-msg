// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryEditor } from './MemoryEditor';

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

describe('MemoryEditor (설정 → 일반 · deck 메모)', () => {
  afterEach(cleanup);

  it('loads the note, counts bytes, saves only a change, shows the server error', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return reply(200, { text: '기존', max: 20 });
      const text = (JSON.parse(String(init.body)) as { text: string }).text;
      return text.includes('실패') ? reply(413, { error: '메모는 너무 깁니다' }) : reply(200, { text: text.trim(), max: 20 });
    }) as unknown as typeof fetch;
    render(<MemoryEditor fetchFn={fetchFn} />);
    const box = await screen.findByTestId('memory-text') as HTMLTextAreaElement;
    expect(box.value).toBe('기존');
    expect(screen.getByTestId('memory-count').textContent).toBe('6 / 20바이트');
    const save = screen.getByTestId('memory-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '가나다라마바사' } }); // 21 bytes
    expect(screen.getByTestId('memory-count').className).toContain('over');
    expect(save.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '새 메모 ' } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('저장했습니다'));
    expect(box.value).toBe('새 메모');
    expect(fetchFn).toHaveBeenLastCalledWith('/api/memory', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ text: '새 메모 ' }) }));
    fireEvent.change(box, { target: { value: '실패' } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('메모는 너무 깁니다'));
  });

  it('stays hidden when the server has no memory store', async () => {
    const fetchFn = vi.fn(async () => reply(404, { error: 'not found' })) as unknown as typeof fetch;
    render(<MemoryEditor fetchFn={fetchFn} />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(screen.queryByTestId('memory-editor')).toBeNull();
  });
});
