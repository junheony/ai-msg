// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UsageChip, chipCountdown } from './UsageChip';
import type { Seat } from '../../shared/accounts';
import type { GrokStatus } from '../../shared/protocol';
import type { AccountUsage, UsageSnapshot } from '../../shared/usage-types';
import type { RouteNext } from './usageSeats';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const acct = (fiveHour: number | null, weekly: number | null, extra: Partial<AccountUsage> = {}): AccountUsage => ({
  status: 'ok', fetchedAt: null,
  fiveHour: fiveHour === null ? null : { usedPct: fiveHour, resetsAt: at(2 * 3_600_000 + 60_000) },
  weekly: weekly === null ? null : { usedPct: weekly, resetsAt: at(3 * 86_400_000) },
  fable: null, ...extra,
});
const snap = (a: AccountUsage, b: AccountUsage = acct(10, 5), over: Partial<UsageSnapshot> = {}): UsageSnapshot =>
  ({ generatedAt: 'x', deckReachable: true, accounts: { a, b, c: acct(5, 5) }, ...over });

const chip = (u: UsageSnapshot | null, current: Seat | null, opts: { next?: RouteNext | null; compact?: boolean; grok?: GrokStatus | null } = {}) =>
  render(<UsageChip usage={u} current={current} next={opts.next ?? null} compact={opts.compact ?? false} grok={opts.grok ?? null} now={NOW} onToggle={() => {}} />);
const el = () => screen.getByTestId('usage-chip');

afterEach(cleanup);

describe('chipCountdown', () => {
  it('m / h / d, nothing when past or unknown', () => {
    expect(chipCountdown(at(40 * 60_000), NOW)).toBe('40m');
    expect(chipCountdown(at(2 * 3_600_000 + 60_000), NOW)).toBe('2h');
    expect(chipCountdown(at(47 * 3_600_000), NOW)).toBe('47h');
    expect(chipCountdown(at(3 * 86_400_000), NOW)).toBe('3d');
    expect(chipCountdown(at(-1), NOW)).toBe('');
    expect(chipCountdown(null, NOW)).toBe('');
    expect(chipCountdown('junk', NOW)).toBe('');
  });
});

describe('UsageChip states', () => {
  it('정상: current seat, USED % of the fullest window and its reset; the spoken label', () => {
    chip(snap(acct(42, 10)), 'a');
    expect(el().className).toContain('ok');
    expect(el().textContent).toBe('A42% · 2h');
    expect(el().getAttribute('aria-label')).toBe('A 계정 사용량 42퍼센트, 2시간 뒤 초기화');
    expect(el().getAttribute('aria-haspopup')).toBe('dialog');
    expect(el().getAttribute('aria-expanded')).toBe('false');
    expect(el().hasAttribute('data-sheet-return')).toBe(true);
  });

  it('A→B: the next turn goes to another seat — on a desktop and on a phone, reason in the title', () => {
    chip(snap(acct(42, 10)), 'a', { next: { account: 'b', reason: '5h 여유 많음' } });
    expect(el().textContent).toBe('A→B42% · 2h');
    expect(screen.getByTestId('next-b').textContent).toBe('→B');
    expect(el().getAttribute('aria-label')).toBe('A 계정 사용량 42퍼센트, 2시간 뒤 초기화, 다음 턴은 B 계정');
    expect(el().title).toContain('5h 여유 많음');
    cleanup();
    chip(snap(acct(42, 10)), 'a', { next: { account: 'b', reason: 'r' }, compact: true });
    expect(el().textContent).toBe('A→B');
    cleanup();
    // Same seat: no arrow; the Opus step-down is still said.
    chip(snap(acct(42, 10)), 'a', { next: { account: 'a', reason: 'r', asOpus: true } });
    expect(screen.queryByTestId(/^next-/)).toBeNull();
    expect(el().getAttribute('aria-label')).toContain('다음 턴은 A 계정(Opus)');
    cleanup();
    // The session's own seat not known yet: the chip is about the next turn alone.
    chip(snap(acct(10, 5), acct(42, 10)), null, { next: { account: 'b', reason: 'r' } });
    expect(el().textContent).toBe('→B42% · 2h');
    expect(el().getAttribute('aria-label')).toBe('다음 턴 B 계정 사용량 42퍼센트, 2시간 뒤 초기화');
  });

  it('경고 / 위험: amber at 80% used, red at 95%', () => {
    chip(snap(acct(82, 10)), 'a');
    expect(el().className).toContain('warn');
    expect(el().textContent).toBe('A82% · 2h');
    cleanup();
    chip(snap(acct(97, 10)), 'a', { compact: true });
    expect(el().className).toContain('danger');
    expect(el().textContent).toBe('A97%');
  });

  it('소진: a spent window reads 소진 with its reset (✕ on a phone)', () => {
    chip(snap(acct(100, 10, { fiveHour: { usedPct: 100, resetsAt: at(12 * 60_000) } })), 'a');
    expect(el().className).toContain('spent');
    expect(el().textContent).toBe('A소진 · 12m');
    expect(el().getAttribute('aria-label')).toBe('A 계정 사용량 소진, 12분 뒤 초기화');
    cleanup();
    chip(snap(acct(100, 10, { fiveHour: { usedPct: 100, resetsAt: at(12 * 60_000) } })), 'a', { compact: true });
    expect(el().textContent).toBe('A✕');
  });

  it('추정: an estimated window (or a kept cli seat) is marked estimated', () => {
    chip(snap(acct(null, 30, { weekly: { usedPct: 30, resetsAt: at(86_400_000 * 3), estimated: true } })), 'a');
    expect(el().className).toContain('estimated');
    expect(el().getAttribute('aria-label')).toContain('추정');
  });

  it('오래됨: a stale seat, or the usage-deck unreachable, says 오래됨 instead of the reset', () => {
    chip(snap(acct(42, 10, { status: 'stale' })), 'a');
    expect(el().className).toContain('stale');
    expect(el().textContent).toBe('A42% · 오래됨');
    expect(el().getAttribute('aria-label')).toContain('오래된 값');
    cleanup();
    chip(snap(acct(42, 10), acct(10, 5), { deckReachable: false }), 'a');
    expect(el().className).toContain('stale');
    cleanup();
    // cli mode never asks usage-deck: deckReachable false says nothing there.
    chip(snap(acct(42, 10), acct(10, 5), { deckReachable: false, usageMode: 'cli' }), 'a');
    expect(el().className).toContain('ok');
  });

  it('쿨다운: a Grok seat in a live cooldown', () => {
    const today = { inputTokens: 0, outputTokens: 0, turns: 0, day: '' };
    const u = snap(acct(10, 10), acct(10, 5), { grokSeats: { x1: { status: 'cooldown', lastTurnAt: null, lastError: null, cooldownUntil: at(30 * 60_000), today } } });
    chip(u, 'x1', { grok: { bin: true } });
    expect(el().className).toContain('cooldown');
    expect(el().querySelector('.usage-chip-num')!.textContent).toBe('쿨다운');
    expect(el().getAttribute('aria-label')).toContain('쿨다운 중');
  });

  it('숨김: no snapshot, or no session and no number anywhere — nothing in the bar', () => {
    chip(null, 'a');
    expect(screen.queryByTestId('usage-chip')).toBeNull();
    cleanup();
    chip(snap(acct(null, null), acct(null, null), { accounts: { a: acct(null, null), b: acct(null, null) } }), null);
    expect(screen.queryByTestId('usage-chip')).toBeNull();
    cleanup();
    // No session but numbers exist: a plain "사용량" chip that still opens the sheet.
    chip(snap(acct(42, 10)), null);
    expect(el().textContent).toBe('사용량');
  });

  it('a small red dot when another seat is in danger (not for the target itself, not for a dimmed seat)', () => {
    chip(snap(acct(42, 10), acct(97, 10)), 'a');
    expect(screen.getByTestId('usage-chip-alert')).toBeTruthy();
    expect(el().getAttribute('aria-label')).toContain('다른 계정 한도 임박');
    cleanup();
    chip(snap(acct(97, 10), acct(10, 10)), 'a');
    expect(screen.queryByTestId('usage-chip-alert')).toBeNull();
  });

  it('click toggles the sheet; aria-expanded follows open', () => {
    const onToggle = vi.fn();
    render(<UsageChip usage={snap(acct(42, 10))} current="a" open now={NOW} onToggle={onToggle} />);
    expect(el().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(el());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
