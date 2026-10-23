// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueueChips, RETRY_CONNECTION_EVENT } from './QueueChips';
import type { QueueItem } from '../state';

const held = { id: 'q1', text: 'hello', attachments: [], restart: 'hold' } as unknown as QueueItem;
const chips = (connected?: boolean) => render(<QueueChips queue={[held]} paused={false} onEdit={vi.fn()} onRemove={vi.fn()} onClear={vi.fn()} onResume={vi.fn()} {...(connected === undefined ? {} : { connected })} />);

describe('QueueChips hold label', () => {
  afterEach(cleanup);
  it('connected: 재시작 뒤 전송', () => {
    chips(true);
    expect(screen.getByText(/재시작 뒤 전송/)).toBeTruthy();
    expect(screen.queryByText(/연결되면 전송/)).toBeNull();
  });
  it('disconnected: 안 보냄 with 다시 보내기 (not a promise to send by itself)', () => {
    chips(false);
    expect(screen.getByText(/안 보냄/)).toBeTruthy();
    expect(screen.queryByText(/재시작 뒤 전송/)).toBeNull();
    expect(screen.getByRole('button', { name: '다시 보내기' })).toBeTruthy();
  });
  it('다시 보내기 asks App to connect now, and resumes a paused queue', () => {
    const onResume = vi.fn();
    const retry = vi.fn();
    window.addEventListener(RETRY_CONNECTION_EVENT, retry);
    const plain = { id: 'q2', text: 'lost one', attachments: [] } as unknown as QueueItem;
    render(<QueueChips queue={[plain]} paused onEdit={vi.fn()} onRemove={vi.fn()} onClear={vi.fn()} onResume={onResume} connected={false} />);
    fireEvent.click(screen.getByRole('button', { name: '다시 보내기' }));
    window.removeEventListener(RETRY_CONNECTION_EVENT, retry);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('offline, an item that may have gone in reads 확인 중 — never 안 보냄 / 다시 보내기 (it could go in twice)', () => {
    for (const extra of [{ maybeLost: true }, { restart: 'hello', maybeSent: 3 }, { lostSteer: 's1' }]) {
      const maybe = { id: 'q3', text: 'maybe', attachments: [], ...extra } as unknown as QueueItem;
      render(<QueueChips queue={[maybe]} paused onEdit={vi.fn()} onRemove={vi.fn()} onClear={vi.fn()} onResume={vi.fn()} connected={false} />);
      expect(screen.getByText(/확인 중/)).toBeTruthy();
      expect(screen.queryByText(/안 보냄/)).toBeNull();
      expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull();
      cleanup();
    }
  });
  it('다시 보내기 beside a maybe-sent item only reconnects: the queue stays paused, the mark stays', () => {
    const onResume = vi.fn();
    const retry = vi.fn();
    window.addEventListener(RETRY_CONNECTION_EVENT, retry);
    const maybe = { id: 'q4', text: 'maybe', attachments: [], maybeLost: true } as unknown as QueueItem;
    const plain = { id: 'q5', text: 'refused', attachments: [] } as unknown as QueueItem;
    render(<QueueChips queue={[maybe, plain]} paused onEdit={vi.fn()} onRemove={vi.fn()} onClear={vi.fn()} onResume={onResume} connected={false} />);
    fireEvent.click(screen.getByRole('button', { name: '다시 보내기' }));
    window.removeEventListener(RETRY_CONNECTION_EVENT, retry);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });
  it('connected: no 안 보냄 / 다시 보내기', () => {
    chips(true);
    expect(screen.queryByText(/안 보냄/)).toBeNull();
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull();
  });
});
