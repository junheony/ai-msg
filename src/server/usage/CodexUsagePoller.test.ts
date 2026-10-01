import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexUsagePoller } from './CodexUsagePoller';
import { UsageService } from './UsageService';

const tc = (ts: string, weekly: number, fiveHour?: number) => JSON.stringify({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: weekly, window_minutes: 10080, resets_at: 1791353807 }, secondary: fiveHour === undefined ? null : { used_percent: fiveHour, window_minutes: 300, resets_at: 1790790000 } } },
}) + '\n';

async function rolloutRoot(): Promise<{ root: string; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-poll-'));
  const file = path.join(root, '2026', '10', '01', 'rollout-2026-10-01T00-00-00-t.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, tc('2026-10-01T02:00:00.000Z', 40, 7));
  return { root, file };
}

describe('CodexUsagePoller (F3)', () => {
  it('applies the newest rollout reading to the gpt seat with the event time, once per new reading', async () => {
    const { root, file } = await rolloutRoot();
    const usage = { applyTurn: vi.fn() };
    const p = new CodexUsagePoller({ sessionsRoot: root, usage });
    expect(await p.pollOnce()).toBe(true);
    expect(usage.applyTurn).toHaveBeenCalledWith('gpt', { weekly: { usedPct: 40, resetsAt: new Date(1791353807 * 1000).toISOString() }, fiveHour: { usedPct: 7, resetsAt: new Date(1790790000 * 1000).toISOString() } }, Date.parse('2026-10-01T02:00:00.000Z'));
    expect(await p.pollOnce()).toBe(false);
    await fs.appendFile(file, tc('2026-10-01T02:05:00.000Z', 41));
    expect(await p.pollOnce()).toBe(true);
    expect(usage.applyTurn).toHaveBeenLastCalledWith('gpt', { weekly: expect.objectContaining({ usedPct: 41 }) }, Date.parse('2026-10-01T02:05:00.000Z'));
  });

  it('a missing sessions dir or unreadable data is a no-op, never a throw', async () => {
    const usage = { applyTurn: vi.fn() };
    expect(await new CodexUsagePoller({ sessionsRoot: '/nonexistent/sessions', usage }).pollOnce()).toBe(false);
    const broken = new CodexUsagePoller({ sessionsRoot: '/x', usage, read: async () => { throw new Error('boom'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await broken.pollOnce()).toBe(false);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
    expect(usage.applyTurn).not.toHaveBeenCalled();
  });

  it('feeds UsageService so the GPT seat is known without a deck GPT turn', async () => {
    const { root } = await rolloutRoot();
    const usage = new UsageService({ deckUrl: 'http://x', now: () => new Date('2026-10-01T03:00:00Z') });
    await new CodexUsagePoller({ sessionsRoot: root, usage }).pollOnce();
    expect(usage.snapshot().gpt).toMatchObject({ status: 'ok', weekly: { usedPct: 40 }, fiveHour: { usedPct: 7 }, fetchedAt: '2026-10-01T02:00:00.000Z' });
  });

  it('start() polls immediately and on the interval; stop() halts it', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => null);
      const p = new CodexUsagePoller({ sessionsRoot: '/x', usage: { applyTurn: vi.fn() }, intervalMs: 1000, read });
      p.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2100);
      expect(read).toHaveBeenCalledTimes(3);
      p.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
