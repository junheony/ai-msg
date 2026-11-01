// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MiniStatus } from '../../shared/mini-types';

const NOW = Date.parse('2026-10-30T12:00:00Z');

const payload = (contextPct: number): MiniStatus => ({
  running: 1,
  waiting: 0,
  sessions: [{ title: 'deck', engine: 'claude', model: 'opus', account: 'a', contextPct, context: 1000, out: 1, cacheRead: 1, costUsd: 1, turns: 1, lastPrompt: '', state: 'idle', updatedAgoMs: 10_000, forMs: 0 }],
  seats: [{ id: 'a', label: 'A', status: 'ok', left5h: 50, leftWeek: 50, resets5h: new Date(NOW + 130.51 * 60_000).toISOString(), resetsWeek: null }],
  hub: null,
  generated_at: new Date(NOW).toISOString(),
});

const bar = () => document.querySelector<HTMLElement>('.bar i')!;
const refresh = () => document.querySelector<HTMLElement>('.refresh')!;

describe('mini page', () => {
  let answer: MiniStatus;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW });
    vi.resetModules();
    document.body.innerHTML = '<main id="mini"></main>';
    answer = payload(12);
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => answer })));
    await import('./main');
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sets the bar width through CSSOM from its data attribute', () => {
    expect(bar().style.width).toBe('12%');
    expect(bar().dataset.pct).toBe('12');
  });

  it('the 5 s tick moves the time texts and keeps every node', async () => {
    const [i, button] = [bar(), refresh()];
    expect(document.querySelector('[data-reset]:not([data-reset=""])')!.textContent).toBe('2h 11m');
    await vi.advanceTimersByTimeAsync(5000);
    expect(bar()).toBe(i);
    expect(refresh()).toBe(button);
    expect(document.querySelector('.head .when')!.textContent).toBe('5초 전');
    expect(document.querySelector('[data-ago]')!.textContent).toBe('15초 전');
    expect(document.querySelector('[data-reset]:not([data-reset=""])')!.textContent).toBe('2h 10m');
  });

  it('new data rebuilds the body, restores focus to refresh and resets the head time', async () => {
    refresh().focus();
    const before = bar();
    answer = payload(40);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bar()).not.toBe(before);
    expect(bar().style.width).toBe('40%');
    expect(document.activeElement).toBe(refresh());
    expect(document.querySelector('.head .when')!.textContent).toBe('방금');
  });

  it('is not a live region (every rebuild and moving time text would be read out)', () => {
    expect(readFileSync(path.resolve(__dirname, '../mini.html'), 'utf8')).not.toContain('aria-live');
  });
});
