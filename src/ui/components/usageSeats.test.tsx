// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { agoText, bucketLabel, chipCountdown, countdown, creditsText, fullestWindow, geminiHint, observedText, resetStamp, shortCountdown, type RouteNext } from './usageSeats';
import { UsageSheet } from './UsageSheet';
import { localDay, type GrokUsage, type UsageSnapshot } from '../../shared/usage-types';
import type { GrokStatus } from '../../shared/protocol';
import type { Seat } from '../../shared/accounts';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const usage: UsageSnapshot = {
  generatedAt: 'x',
  deckReachable: false,
  accounts: {
    a: { status: 'stale', fetchedAt: null, fiveHour: { usedPct: 13, resetsAt: new Date(NOW + 2.5 * 3_600_000).toISOString() }, weekly: { usedPct: 7, resetsAt: null }, fable: { usedPct: 0, resetsAt: null } },
    b: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 82, resetsAt: null }, weekly: { usedPct: 3, resetsAt: null }, fable: null },
    c: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 0, resetsAt: null }, weekly: { usedPct: 96, resetsAt: null }, fable: { usedPct: 27, resetsAt: null } },
  },
};

/** The seat rows now live in the usage sheet: render it the way App does (no fetch — history stays closed). */
const sheet = (u: UsageSnapshot | null, current: Seat | null, opts: { now?: number; next?: RouteNext | null; grok?: GrokStatus | null } = {}) =>
  render(<UsageSheet usage={u} current={current} onClose={() => {}} {...('now' in opts ? (opts.now === undefined ? {} : { now: opts.now }) : { now: NOW })} next={opts.next ?? null} grok={opts.grok ?? null} />);

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('usage seats in the sheet', () => {
  it('shows REMAINING % per window ("남음" on each row), warn/danger classes, current tag, countdown, stale note', () => {
    sheet(usage, 'b');
    // 13 % used = 87 % left, like the strip.
    expect(screen.getByTestId('a-fiveHour').querySelector('.usage-value')!.textContent).toBe('87% 남음');
    expect(screen.getByTestId('a-weekly').querySelector('.usage-value')!.textContent).toBe('93% 남음');
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('2시간 30분');
    expect(screen.getByTestId('b-fiveHour').className).toContain('warn');
    expect(screen.getByTestId('c-weekly').className).toContain('danger');
    expect(screen.getByTestId('b-fable').textContent).toContain('—');
    expect(screen.getByTestId('account-b').className).toContain('current');
    expect(screen.getByTestId('account-b').textContent).toContain('현재');
    expect(screen.getByTestId('account-a').className).not.toContain('current');
    expect(screen.getByTestId('usage-stale').textContent).toContain('오래된 값');
    expect(screen.getByTestId('a-status').textContent).toBe('오래됨');
  });

  it('renders a placeholder without data', () => {
    sheet(null, null);
    expect(screen.getByText('사용량 불러오는 중…')).toBeTruthy();
  });

  it('no Gemini seat without the data; with it, one row per bucket, current when a Gemini session is active', () => {
    const { unmount } = sheet(usage, null);
    expect(screen.queryByTestId('account-g1')).toBeNull();
    unmount();
    const g = { status: 'ok' as const, fetchedAt: new Date(NOW - 60_000).toISOString(), loggedIn: true, error: null, buckets: [
      { name: 'gemini-4-argon', usedPct: 27, resetsAt: new Date(NOW + 2 * 3_600_000 + 10 * 60_000).toISOString() },
      { name: 'gemini-3.8-flash', usedPct: 96, resetsAt: null },
    ] };
    sheet({ ...usage, gemini: g }, 'g1');
    const card = screen.getByTestId('account-g1');
    expect(card.className).toContain('gemini');
    expect(card.className).toContain('current');
    expect(card.title).toBe('');
    expect(screen.getByTestId('g1-b0').textContent).toContain('4 Argon');
    expect(screen.getByTestId('g1-b0').textContent).toContain('73% 남음');
    expect(screen.getByTestId('g1-b0').textContent).toContain('2시간 10분');
    expect(screen.getByTestId('g1-b1').textContent).toContain('3.8 Flash');
    expect(screen.getByTestId('g1-b1').className).toContain('danger');
    expect(screen.getByTestId('g1-observed').textContent).toContain('확인');
  });

  it('a logged-out Gemini seat shows the login hint; a stale read shows the reason', () => {
    const out = { status: 'down' as const, fetchedAt: null, loggedIn: false, buckets: [], error: 'Gemini 로그인 필요 — 터미널에서 agy 실행 후 Google 로그인' };
    const { unmount } = sheet({ ...usage, gemini: out }, null);
    const card = screen.getByTestId('account-g1');
    expect(card.title).toContain('agy 실행');
    expect(card.className).toContain('down');
    expect(screen.getByTestId('g1-main').textContent).toContain('로그인');
    expect(screen.getByTestId('g1-status').textContent).toBe('로그인 필요');
    unmount();
    const stale = { status: 'stale' as const, fetchedAt: null, loggedIn: true, buckets: [{ name: 'x', usedPct: 10, resetsAt: null }], error: 'agy /usage 실패 (exit 1)' };
    sheet({ ...usage, gemini: stale }, null);
    expect(screen.getByTestId('account-g1').title).toBe('Gemini 사용량 오래된 값 — agy /usage 실패 (exit 1)');
    expect(geminiHint({ ...stale, status: 'down', error: null })).toBe('Gemini 사용량 불명');
    expect(bucketLabel('gemini-4-argon')).toBe('4 Argon');
    expect(bucketLabel('Gemini 3.8 Flash')).toBe('3.8 Flash');
    expect(bucketLabel('Pro')).toBe('Pro');
    expect(bucketLabel('gemini')).toBe('gemini');
    expect(bucketLabel('Gemini · 5h')).toBe('Gemini · 5h');
  });

  it('countdown reads a zone-less reset time as UTC', () => {
    expect(countdown('2026-09-30T14:30:00', NOW)).toBe('2시간 후 리셋');
  });

  it('countdown leaves zero parts out: "7분", "2시간", "3일" — never "0시간 7분"', () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(countdown(at(7 * 60_000 + 30_000), NOW)).toBe('7분 후 리셋');
    expect(countdown(at(30_000), NOW)).toBe('1분 안에 리셋');
    expect(countdown(at(2 * 3_600_000 + 5 * 60_000), NOW)).toBe('2시간 5분 후 리셋');
    expect(countdown(at(3 * 86_400_000), NOW)).toBe('3일 후 리셋');
    expect(countdown(at(3 * 86_400_000 + 4 * 3_600_000), NOW)).toBe('3일 4시간 후 리셋');
  });

  it('without a fixed now, the countdown ticks every 30 s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const u: UsageSnapshot = { ...usage, accounts: { ...usage.accounts, a: { ...usage.accounts.a!, fiveHour: { usedPct: 13, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() } } } };
    sheet(u, null, { now: undefined });
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('2시간 후 리셋');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('1시간 59분');
  });

  it('GPT: weekly remaining % when ok, — with a hint when unknown, current tag', () => {
    const withGpt: UsageSnapshot = { ...usage, gpt: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: { usedPct: 40, resetsAt: null }, fable: null } };
    sheet(withGpt, 'gpt');
    expect(screen.getByTestId('gpt-weekly').textContent).toContain('60% 남음');
    expect(screen.getByTestId('gpt-weekly').title).toContain('60% 남음');
    expect(screen.getByTestId('gpt-weekly').title).not.toContain('사용');
    expect(screen.getByTestId('account-gpt').className).toContain('current');
    expect(screen.getByTestId('account-gpt').querySelector('svg.usage-mark.gpt')).toBeTruthy();
    expect(screen.getByTestId('gpt-fiveHour').textContent).toContain('—');
    expect(screen.queryByTestId('gpt-credits')).toBeNull();
    cleanup();
    sheet(usage, null);
    expect(screen.getByTestId('gpt-weekly').textContent).toContain('—');
    expect(screen.getByTestId('account-gpt').title).toContain('usage-deck');
  });

  it('a window at 0% collapses into a 소진 pill with the absolute reset time instead of 0%', () => {
    const resetsAt = new Date(NOW + 3 * 86_400_000).toISOString();
    sheet({ ...usage, gpt: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: { usedPct: 100, resetsAt }, fable: null } }, null);
    const w = screen.getByTestId('gpt-weekly');
    expect(w.className).toContain('danger');
    expect(w.textContent).not.toContain('0%');
    expect(w.querySelector('.usage-bar')).toBeNull();
    expect(w.querySelector('.usage-pill')!.textContent).toBe(`소진 · ${resetStamp(resetsAt)}`);
    expect(resetStamp(resetsAt)).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    expect(w.title).toContain(`${resetStamp(resetsAt)} 리셋`);
  });

  it('spent weekly with credits shows a 크레딧 line with the whole balance; unlimited and no-credits cases', () => {
    const resetsAt = new Date(NOW + 3 * 86_400_000).toISOString();
    sheet({ ...usage, gpt: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: { usedPct: 100, resetsAt }, fable: null, credits: { hasCredits: true, unlimited: false, balance: 49563.32 } } }, null);
    expect(screen.getByTestId('gpt-credits').textContent).toBe('크레딧49,563');
    expect(creditsText({ hasCredits: true, unlimited: true, balance: null })).toBe('무제한');
    expect(creditsText({ hasCredits: false, unlimited: false, balance: 12 })).toBeNull();
    expect(creditsText({ hasCredits: true, unlimited: false, balance: null })).toBeNull();
    expect(creditsText(undefined)).toBeNull();
  });

  it('each window has a bar filled to the REMAINING % (a battery, like the strip); the legend says what the numbers and colours mean', () => {
    sheet({ ...usage, deckReachable: true }, 'b');
    const bar = screen.getByTestId('a-fiveHour').querySelector('.usage-bar > i') as HTMLElement;
    expect(bar.style.width).toBe('87%');
    expect(screen.getByTestId('account-a').querySelector('svg.usage-mark.claude.claude-mark')).not.toBeNull();
    const legend = document.querySelector('.usage-sheet-legend')!;
    expect(legend.textContent).toBe('숫자는 남은 양 · 노랑 20% 이하 남음 · 빨강 5% 이하 남음');
    expect(legend.textContent).not.toContain('사용');
    // The colours keep their used-% thresholds (82 % used → amber, 96 % → red), said as what is left.
    expect(screen.getByTestId('b-fiveHour').title).toBe('5h · 18% 남음 · 노랑: 20% 이하 남음');
    expect(screen.getByTestId('c-weekly').title).toBe('주간 · 4% 남음 · 빨강: 5% 이하 남음');
    // A's numbers are old (stale): marked old and said so (an upper bound of what is left).
    expect(screen.getByTestId('a-weekly').title).toBe('주간 · 93% 남음 · 마지막 턴 기준 값, 지금은 이보다 적게 남았을 수 있음');
    expect(screen.getByTestId('a-weekly').className).toContain('old');
    expect(screen.getByTestId('b-fiveHour').className).not.toContain('old');
  });

  it('다음 턴 tag on the routed seat, Opus noted, reason in the title; staying put is no news unless it steps down to Opus', () => {
    const { rerender } = sheet(usage, 'a', { next: { account: 'b', reason: '5h 여유 많음' } });
    const tag = screen.getByTestId('sheet-next-b');
    expect(tag.textContent).toBe('다음 턴 여기');
    expect(tag.title).toBe('다음 턴은 이 계정으로 갑니다: 5h 여유 많음');
    const again = (next: RouteNext | null) => rerender(<UsageSheet usage={usage} current="a" onClose={() => {}} now={NOW} next={next} />);
    again({ account: 'c', reason: 'r', asOpus: true });
    expect(screen.getByTestId('sheet-next-c').textContent).toBe('다음 턴 여기 · Opus');
    again({ account: 'a', reason: 'r' });
    expect(screen.queryByTestId(/^sheet-next-/)).toBeNull();
    again({ account: 'a', reason: 'r', asOpus: true });
    expect(screen.getByTestId('sheet-next-a').textContent).toBe('다음 턴 여기 · Opus');
  });
});

describe('short countdowns and the fullest window', () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();

  it('shortCountdown: 분 / 시간 / 일, 리셋됨 once passed, nothing without a reset time', () => {
    expect(shortCountdown(at(47 * 60_000 + 30_000), NOW)).toBe('47분');
    expect(shortCountdown(at(20_000), NOW)).toBe('1분');
    expect(shortCountdown(at(3.5 * 3_600_000), NOW)).toBe('3시간');
    expect(shortCountdown(at(23.9 * 3_600_000), NOW)).toBe('23시간');
    expect(shortCountdown(at(2.2 * 86_400_000), NOW)).toBe('2일');
    expect(shortCountdown(at(-1), NOW)).toBe('리셋됨');
    expect(shortCountdown(at(0), NOW)).toBe('리셋됨');
    expect(shortCountdown(null, NOW)).toBe('');
  });

  it('shortCountdown: boundaries — 59분 / 60분, 1일 N시간 under 48 hours, a bad ISO string shows nothing', () => {
    expect(shortCountdown(at(59 * 60_000 + 59_000), NOW)).toBe('59분');
    expect(shortCountdown(at(60 * 60_000), NOW)).toBe('1시간');
    expect(shortCountdown(at(24 * 3_600_000), NOW)).toBe('1일');
    expect(shortCountdown(at(29.5 * 3_600_000), NOW)).toBe('1일 5시간');
    expect(shortCountdown(at(47 * 3_600_000 + 59 * 60_000), NOW)).toBe('1일 23시간');
    expect(shortCountdown(at(48 * 3_600_000), NOW)).toBe('2일');
    expect(shortCountdown('not a date', NOW)).toBe('');
    expect(shortCountdown('2026-13-45T99:00:00Z', NOW)).toBe('');
  });

  it('fullestWindow: highest usedPct, ties 5h > 주간 > Fable', () => {
    const all = ['fiveHour', 'weekly', 'fable'] as const;
    const w = (usedPct: number) => ({ usedPct, resetsAt: null });
    expect(fullestWindow({ status: 'ok', fetchedAt: null, fiveHour: w(10), weekly: w(60), fable: w(30) }, [...all])).toBe('weekly');
    expect(fullestWindow({ status: 'ok', fetchedAt: null, fiveHour: w(50), weekly: w(50), fable: w(50) }, [...all])).toBe('fiveHour');
    expect(fullestWindow({ status: 'ok', fetchedAt: null, fiveHour: null, weekly: w(40), fable: w(40) }, [...all])).toBe('weekly');
    expect(fullestWindow({ status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, [...all])).toBeNull();
  });
});

describe('usage sheet · old numbers per window', () => {
  it('an old seat: a row past its reset says 리셋됨 with a refresh icon on an empty bar; the window not reset yet keeps its % (dimmed); one refresh line', () => {
    const iso = (ms: number) => new Date(NOW + ms).toISOString();
    const old: UsageSnapshot = { ...usage, accounts: { a: { status: 'stale', fetchedAt: iso(-3 * 86_400_000), fiveHour: { usedPct: 95, resetsAt: iso(-3_600_000) }, weekly: { usedPct: 30, resetsAt: iso(2 * 86_400_000) }, fable: null } } };
    sheet(old, 'a');
    const five = screen.getByTestId('a-fiveHour');
    expect(five.querySelector('.usage-value')!.textContent).toBe('리셋됨');
    expect(five.querySelector('.usage-value svg')).not.toBeNull();
    expect((five.querySelector('.usage-bar > i') as HTMLElement).style.width).toBe('0%');
    expect(five.title).toBe('5h · 리셋 시각이 지나 지금 값은 모름. 이 계정으로 한 턴 돌리면 갱신됨');
    const weekly = screen.getByTestId('a-weekly');
    expect(weekly.querySelector('.usage-value')!.textContent).toBe('70% 남음');
    expect(weekly.className).toContain('old');
    expect(screen.getByTestId('account-a').className).toContain('old');
    // The status tag keeps its word with a clock; the card says how to refresh it.
    expect(screen.getByTestId('a-status').textContent).toBe('오래됨');
    expect(screen.getByTestId('a-status').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('a-refresh').textContent).toBe('3일 전 마지막 턴 기준 값 · 지금은 이보다 적게 남았을 수 있어요 · 이 계정으로 한 턴 돌리면 갱신돼요');
    cleanup();
    // Fresh numbers: the row is as read (the server judges resets on its side), no refresh line.
    sheet({ ...old, deckReachable: true, accounts: { a: { ...old.accounts.a!, status: 'ok' } } }, 'a');
    expect(screen.getByTestId('a-fiveHour').querySelector('.usage-value')!.textContent).toBe('5% 남음');
    expect(screen.queryByTestId('a-refresh')).toBeNull();
    expect(screen.getByTestId('account-a').className).not.toContain('old');
  });
});

describe('usage seats · cli usage mode (observed times)', () => {
  const cliUsage: UsageSnapshot = {
    generatedAt: 'x',
    deckReachable: false,
    usageMode: 'cli',
    accounts: {
      a: { status: 'stale', fetchedAt: new Date(NOW - 12 * 60_000).toISOString(), fiveHour: { usedPct: 0, resetsAt: new Date(NOW - 60_000).toISOString(), estimated: true }, weekly: { usedPct: 40, resetsAt: null }, fable: null },
      b: { status: 'down', fetchedAt: null, fiveHour: null, weekly: null, fable: null },
      c: { status: 'ok', fetchedAt: new Date(NOW - 20_000).toISOString(), fiveHour: { usedPct: 10, resetsAt: null }, weekly: { usedPct: 3, resetsAt: null }, fable: null },
    },
  };

  it('agoText / observedText', () => {
    expect(agoText(null, NOW)).toBe('');
    expect(agoText('junk', NOW)).toBe('');
    expect(agoText(new Date(NOW - 30_000).toISOString(), NOW)).toBe('방금');
    expect(agoText(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('12분 전');
    expect(agoText(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3시간 전');
    expect(agoText(new Date(NOW - 50 * 3_600_000).toISOString(), NOW)).toBe('2일 전');
    expect(observedText(cliUsage.accounts.a!, NOW)).toBe('마지막 턴 기준 · 12분 전');
    expect(observedText(cliUsage.accounts.b!, NOW)).toBe('아직 관측 없음');
  });

  it('each Claude seat says when its numbers were observed; no usage-deck stale note', () => {
    sheet(cliUsage, null);
    expect(screen.getByTestId('account-a').title).toBe('마지막 턴 기준 · 12분 전 · 라우팅은 모름으로 봄');
    expect(screen.getByTestId('account-a').className).toContain('stale');
    expect(screen.getByTestId('account-b').title).toBe('아직 관측 없음');
    expect(screen.getByTestId('account-c').title).toBe('마지막 턴 기준 · 방금');
    expect(screen.queryByTestId('usage-stale')).toBeNull();
    expect(screen.getByTestId('a-fiveHour').title).toContain('추정');
    expect(screen.getByTestId('a-weekly').title).not.toContain('추정');
    expect(screen.getByTestId('a-observed').textContent).toContain('마지막 턴 기준 · 12분 전');
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('100% 남음');
    expect(screen.getByTestId('b-observed').textContent).toContain('아직 관측 없음');
    expect(screen.getByTestId('account-gpt').title).not.toContain('usage-deck');
  });

  it('MED-1: a stale seat within trustUntil is kept (추정(유지)) and not dimmed; past it, dimmed', () => {
    const a = { ...cliUsage.accounts.a!, fiveHour: { usedPct: 30, resetsAt: new Date(NOW + 3_600_000).toISOString() }, trustUntil: new Date(NOW + 3_600_000).toISOString() };
    const kept: UsageSnapshot = { ...cliUsage, accounts: { ...cliUsage.accounts, a } };
    expect(observedText(a, NOW)).toBe('추정 · 마지막 턴 12분 전');
    expect(observedText(a, NOW + 2 * 3_600_000)).toBe('마지막 턴 기준 · 2시간 전');
    const { unmount } = sheet(kept, null);
    expect(screen.getByTestId('account-a').title).toBe('추정 · 마지막 턴 12분 전');
    expect(screen.getByTestId('account-a').className).toContain('kept');
    expect(screen.getByTestId('account-a').className).not.toContain('stale');
    expect(screen.getByTestId('a-status').textContent).toBe('추정(유지)');
    unmount();
    sheet(kept, null, { now: NOW + 2 * 3_600_000 });
    expect(screen.getByTestId('account-a').className).toContain('stale');
    expect(screen.getByTestId('account-a').title).toContain('라우팅은 모름으로 봄');
  });

  it('MED-3: in cli mode an unknown Fable row says "CLI 미제공"; a known one shows its value', () => {
    sheet({ ...cliUsage, accounts: { ...cliUsage.accounts, c: { ...cliUsage.accounts.c!, fable: { usedPct: 100, resetsAt: null } } } }, null);
    expect(screen.getByTestId('a-fable').textContent).toContain('Fable');
    expect(screen.getByTestId('a-fable').textContent).toContain('CLI 미제공');
    expect(screen.getByTestId('a-fable').title).toBe('Fable · CLI 미제공');
    expect(screen.getByTestId('c-fable').textContent).toContain('소진');
  });

  it('LOW-5: an estimated row carries the estimated class (striped bar, dashed number)', () => {
    sheet(cliUsage, null);
    expect(screen.getByTestId('a-fiveHour').className).toContain('estimated');
    expect(screen.getByTestId('a-weekly').className).not.toContain('estimated');
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/\.usage-row\.estimated \.usage-bar > i \{ background: repeating-linear-gradient/);
    expect(css).toMatch(/\.usage-row\.estimated \.usage-value \{ text-decoration: underline dashed/);
  });

  it('usage-deck mode shows no observed label', () => {
    sheet(usage, null);
    expect(screen.getByTestId('account-a').title).toBe('');
    expect(document.body.textContent).not.toContain('CLI 미제공');
    expect(screen.queryByTestId('a-observed')).toBeNull();
  });
});

describe('usage seats · Grok (cooldown expiry, midnight, subscription)', () => {
  const today = localDay(new Date(NOW));
  const yesterday = localDay(new Date(NOW - 86_400_000));
  const grokUsage = (g: Partial<GrokUsage>): UsageSnapshot => ({
    ...usage,
    grokSeats: { x1: { status: 'ok', lastTurnAt: new Date(NOW - 10 * 60_000).toISOString(), lastError: null, cooldownUntil: null, today: { inputTokens: 1200, outputTokens: 34, turns: 3, day: today }, ...g } },
  });
  const bin = { grok: { bin: true } as GrokStatus };

  it('no Grok seat without grok.bin; with it, the status sentence and today\'s deck tally', () => {
    const { unmount } = sheet(grokUsage({}), null);
    expect(screen.queryByTestId('account-x1')).toBeNull();
    unmount();
    sheet(grokUsage({}), null, bin);
    expect(screen.getByTestId('x1-main').textContent).toBe('사용 가능 · 마지막 턴 10분 전');
    expect(screen.getByTestId('x1-today').textContent).toBe('deck 오늘3턴 · 입력 1,200 · 출력 34');
    expect(screen.getByTestId('account-x1').querySelector('svg.usage-mark.grok')).not.toBeNull();
  });

  it('a live cooldown says "한도 — HH:MM 이후"', () => {
    const until = new Date(NOW + 30 * 60_000).toISOString();
    sheet(grokUsage({ status: 'cooldown', cooldownUntil: until }), null, bin);
    expect(screen.getByTestId('x1-main').textContent).toBe(`한도 — ${resetStamp(until)} 이후`);
    expect(screen.getByTestId('account-x1').className).toContain('cooldown');
    expect(screen.getByTestId('x1-status').textContent).toBe('쿨다운');
  });

  it('a cooldown whose time has passed is no longer shown, even while the snapshot still says cooldown', () => {
    sheet(grokUsage({ status: 'cooldown', cooldownUntil: new Date(NOW - 60_000).toISOString() }), null, bin);
    expect(screen.getByTestId('x1-main').textContent).toBe('사용 가능 · 마지막 턴 10분 전');
    expect(screen.getByTestId('account-x1').className).not.toContain('cooldown');
  });

  it('after local midnight, yesterday\'s tally reads 0 until the next turn', () => {
    sheet(grokUsage({ today: { inputTokens: 1200, outputTokens: 34, turns: 3, day: yesterday } }), null, bin);
    expect(screen.getByTestId('x1-today').textContent).toBe('deck 오늘0턴 · 입력 0 · 출력 0');
  });

  const billing = (usedPct: number, endMs = NOW + 6 * 86_400_000 + 2 * 3_600_000) => ({
    usedPct, windowStart: new Date(endMs - 7 * 86_400_000).toISOString(), windowEnd: new Date(endMs).toISOString(),
    tier: 'SuperGrok Heavy', fetchedAt: new Date(NOW - 5 * 60_000).toISOString(), periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
  });

  it('with the subscription usage: one 주간 row with the %, tier, today and the observed stamp', () => {
    sheet(grokUsage({ billing: billing(1) }), null, bin);
    expect(screen.getByTestId('x1-week').textContent).toContain('주간');
    expect(screen.getByTestId('x1-week').textContent).toContain('99% 남음');
    expect(screen.getByTestId('x1-week').querySelector('.usage-bar > i')!.getAttribute('style')).toContain('width: 99%');
    expect(screen.getByTestId('x1-tier').textContent).toBe('구독SuperGrok Heavy');
    expect(screen.getByTestId('x1-today').textContent).toBe('deck 오늘3턴 · 입력 1,200 · 출력 34');
    expect(screen.getByTestId('x1-observed').textContent).toContain('확인');
    expect(screen.queryByTestId('x1-main')).toBeNull();
  });

  it('a live cooldown wins over the bar: the reason line is shown with the row', () => {
    const until = new Date(NOW + 30 * 60_000).toISOString();
    sheet(grokUsage({ status: 'cooldown', cooldownUntil: until, billing: billing(40) }), null, bin);
    expect(screen.getByTestId('x1-main').textContent).toBe(`한도 — ${resetStamp(until)} 이후`);
    expect(screen.getByTestId('account-x1').className).toContain('cooldown');
  });

  it('a period that ended since the reading reads as a fresh period (estimated, not the old number)', () => {
    sheet(grokUsage({ billing: billing(90, NOW - 60_000) }), null, bin);
    const row = screen.getByTestId('x1-week');
    expect(row.textContent).toContain('100% 남음');
    expect(row.className).toContain('estimated');
  });

  it('without the subscription usage and no turn yet: "아직 사용 없음", no bar', () => {
    sheet(grokUsage({ status: 'unknown', lastTurnAt: null, today: { inputTokens: 0, outputTokens: 0, turns: 0, day: today } }), null, bin);
    expect(screen.getByTestId('x1-main').textContent).toBe('아직 사용 없음');
    expect(screen.getByTestId('account-x1').querySelector('.usage-bar')).toBeNull();
  });
});

describe('styles.css', () => {
  it('every @media block in styles.css is closed (an unclosed one swallowed the rules after it)', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    let depth = 0;
    for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) { if (ch === '{') depth++; if (ch === '}') depth--; expect(depth).toBeGreaterThanOrEqual(0); }
    expect(depth).toBe(0);
  });
});

describe('chipCountdown', () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
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
