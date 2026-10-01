import { describe, expect, it, vi } from 'vitest';
import { postPin } from './pins';

describe('postPin (F2)', () => {
  it('POSTs the toggle and returns the server pins', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ pins: ['s1'] }), { status: 200 }));
    expect(await postPin('s1', true, fetchFn as unknown as typeof fetch)).toEqual(['s1']);
    expect(fetchFn).toHaveBeenCalledWith('/api/pins', expect.objectContaining({ method: 'POST', body: JSON.stringify({ sessionId: 's1', pinned: true }) }));
  });

  it('throws the server error, or a Korean network error', async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: '잘못된 고정 요청입니다' }), { status: 400 }));
    await expect(postPin('s1', true, bad as unknown as typeof fetch)).rejects.toThrow('잘못된 고정 요청입니다');
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(postPin('s1', true, down as unknown as typeof fetch)).rejects.toThrow('고정 실패: 네트워크 오류');
  });
});
