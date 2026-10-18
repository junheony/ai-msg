// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UsagePanel, agoText, bucketLabel, countdown, creditsText, fullestWindow, geminiHint, observedText, resetStamp, shortCountdown } from './UsagePanel';
import { localDay, type GrokUsage, type UsageSnapshot } from '../../shared/usage-types';

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

describe('UsagePanel', () => {
  it('shows remaining % per window, warn/danger classes, current highlight, countdown, stale tag', () => {
    render(<UsagePanel usage={usage} current="b" now={NOW} />);
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('87%');
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('2시간 30분');
    expect(screen.getByTestId('b-fiveHour').className).toContain('warn');
    expect(screen.getByTestId('c-weekly').className).toContain('danger');
    expect(screen.getByTestId('b-fable').textContent).toContain('—');
    expect(screen.getByTestId('account-b').className).toContain('current');
    expect(screen.getByTestId('account-a').className).not.toContain('current');
    expect(screen.getByText('오래된 값')).toBeTruthy();
  });

  it('renders a placeholder without data', () => {
    render(<UsagePanel usage={null} current={null} />);
    expect(screen.getByText('잔여량 불러오는 중…')).toBeTruthy();
  });

  it('no Gemini card without the seat; with it, one row per bucket, the lowest remaining as the summary, current when a Gemini session is active', () => {
    const { unmount } = render(<UsagePanel usage={usage} current={null} now={NOW} />);
    expect(screen.queryByTestId('account-g1')).toBeNull();
    unmount();
    const g = { status: 'ok' as const, fetchedAt: new Date(NOW - 60_000).toISOString(), loggedIn: true, error: null, buckets: [
      { name: 'gemini-4-argon', usedPct: 27, resetsAt: new Date(NOW + 2 * 3_600_000 + 10 * 60_000).toISOString() },
      { name: 'gemini-3.8-flash', usedPct: 96, resetsAt: null },
    ] };
    render(<UsagePanel usage={{ ...usage, gemini: g }} current="g1" now={NOW} />);
    const card = screen.getByTestId('account-g1');
    expect(card.className).toContain('gemini');
    expect(card.className).toContain('current');
    expect(card.className).toContain('ok');
    expect(card.title).toBe('');
    // Popover rows, one per bucket (always in the DOM — see SeatCard — so these are queryable without a click).
    expect(screen.getByTestId('g1-b0').textContent).toContain('4 Argon');
    expect(screen.getByTestId('g1-b0').textContent).toContain('73%');
    expect(screen.getByTestId('g1-b0').textContent).toContain('2시간 10분');
    expect(screen.getByTestId('g1-b1').textContent).toContain('3.8 Flash');
    expect(screen.getByTestId('g1-b1').className).toContain('danger');
    // The main row picks the fullest bucket (b1, 96% used → 4% left); it has no reset time, so no short countdown.
    expect(card.querySelector('.usage-main')!.textContent).toContain('4');
    expect(card.querySelector('.usage-main')!.className).toContain('danger');
    expect(card.querySelector('.usage-cd')).toBeNull();
    expect((card.parentElement as HTMLElement).style.getPropertyValue('--usage-cards')).toBe('5');
  });

  it('a logged-out Gemini seat shows the login hint and a dash; a stale read shows the reason', () => {
    const out = { status: 'down' as const, fetchedAt: null, loggedIn: false, buckets: [], error: 'Gemini 로그인 필요 — 터미널에서 agy 실행 후 Google 로그인' };
    const { unmount } = render(<UsagePanel usage={{ ...usage, gemini: out }} current={null} now={NOW} />);
    const card = screen.getByTestId('account-g1');
    expect(card.title).toContain('agy 실행');
    expect(card.className).toContain('down');
    // No buckets at all: the main row becomes the login-hint text (reasonLine), same height as a bar would be.
    expect(screen.getByTestId('g1-main').textContent).toContain('로그인');
    expect(card.querySelector('.usage-secondary')!.textContent).toBe(' ');
    unmount();
    const stale = { status: 'stale' as const, fetchedAt: null, loggedIn: true, buckets: [{ name: 'x', usedPct: 10, resetsAt: null }], error: 'agy /usage 실패 (exit 1)' };
    render(<UsagePanel usage={{ ...usage, gemini: stale }} current={null} now={NOW} />);
    expect(screen.getByTestId('account-g1').title).toBe('Gemini 사용량 오래된 값 — agy /usage 실패 (exit 1)');
    expect(geminiHint({ ...stale, status: 'down', error: null })).toBe('Gemini 사용량 불명');
    expect(bucketLabel('gemini-4-argon')).toBe('4 Argon');
    expect(bucketLabel('Gemini 3.8 Flash')).toBe('3.8 Flash');
    expect(bucketLabel('Pro')).toBe('Pro');
    expect(bucketLabel('gemini')).toBe('gemini');
    expect(bucketLabel('Gemini · 5h')).toBe('Gemini · 5h');
  });

  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('countdown reads a zone-less reset time as UTC', () => {
    expect(countdown('2026-09-30T14:30:00', NOW)).toBe('2시간 0분 후 리셋');
  });

  it('without a fixed now, the countdown ticks every 30 s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const u: UsageSnapshot = { ...usage, accounts: { ...usage.accounts, a: { ...usage.accounts.a!, fiveHour: { usedPct: 13, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() } } } };
    render(<UsagePanel usage={u} current={null} />);
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('2시간 0분');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('1시간 59분');
  });

  it('GPT column: weekly remaining when the card is ok, — with a hint when unknown, highlighted when current', () => {
    const withGpt: UsageSnapshot = { ...usage, gpt: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: { usedPct: 40, resetsAt: null }, fable: null } };
    render(<UsagePanel usage={withGpt} current="gpt" now={NOW} />);
    expect(screen.getByTestId('gpt-weekly').textContent).toContain('60%');
    expect(screen.getByTestId('gpt-weekly').title).toContain('60% 남음');
    expect(screen.getByTestId('account-gpt').className).toContain('current');
    expect(screen.getByTestId('account-gpt').querySelector('svg.usage-mark.gpt')).toBeTruthy();
    expect(screen.getByTestId('account-gpt').getAttribute('aria-label')).toContain('(현재)');
    expect(screen.getByTestId('account-gpt').querySelector('.usage-dot')).toBeNull(); // the ring alone marks current
    expect(screen.getByTestId('gpt-fiveHour').textContent).toContain('—');
    expect(screen.queryByTestId('gpt-credits')).toBeNull();
    cleanup();
    render(<UsagePanel usage={usage} current={null} now={NOW} />);
    expect(screen.getByTestId('gpt-weekly').textContent).toContain('—');
    expect(screen.getByTestId('account-gpt').title).toContain('usage-deck');
  });
});

describe('UsagePanel exhausted window', () => {
  afterEach(cleanup);
  it('a window at 0% collapses into a muted 소진 pill with the absolute reset time instead of 0%', () => {
    const resetsAt = new Date(NOW + 3 * 86_400_000).toISOString();
    const withGpt: UsageSnapshot = { ...usage, gpt: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: { usedPct: 100, resetsAt }, fable: null } };
    render(<UsagePanel usage={withGpt} current={null} now={NOW} />);
    const w = screen.getByTestId('gpt-weekly');
    expect(w.className).toContain('danger');
    expect(w.textContent).not.toContain('0%');
    expect(w.querySelector('.usage-bar')).toBeNull();
    expect(w.querySelector('.usage-pill')!.textContent).toBe(`소진 · ${resetStamp(resetsAt)}`);
    expect(w.textContent).toContain('주간');
    expect(resetStamp(resetsAt)).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    // The pill is compact (no "한도"/"리셋" words visible); the full wording lives in the row's title instead.
    expect(w.title).toContain('주간');
    expect(w.title).toContain('소진');
    expect(w.title).toContain(`${resetStamp(resetsAt)} 리셋`);
  });

  it('spent weekly with credits shows a 크레딧 line with the whole balance; unlimited and no-credits cases', () => {
    const resetsAt = new Date(NOW + 3 * 86_400_000).toISOString();
    const withCredits: UsageSnapshot = { ...usage, gpt: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: { usedPct: 100, resetsAt }, fable: null, credits: { hasCredits: true, unlimited: false, balance: 49563.32 } } };
    render(<UsagePanel usage={withCredits} current={null} now={NOW} />);
    expect(screen.getByTestId('gpt-credits').textContent).toBe('크레딧49,563');
    expect(screen.getByTestId('gpt-weekly').querySelector('.usage-pill')).toBeTruthy();
    expect(screen.getByTestId('gpt-fiveHour').textContent).toContain('—');
    expect(creditsText({ hasCredits: true, unlimited: true, balance: null })).toBe('무제한');
    expect(creditsText({ hasCredits: false, unlimited: false, balance: 12 })).toBeNull();
    expect(creditsText({ hasCredits: true, unlimited: false, balance: null })).toBeNull();
    expect(creditsText(undefined)).toBeNull();
  });
});

describe('UsagePanel chips', () => {
  afterEach(cleanup);
  it('each window has a bar sized to the remaining %, and a tap opens a popover with the reset times', () => {
    render(<UsagePanel usage={usage} current="b" now={NOW} />);
    const bar = screen.getByTestId('a-fiveHour').querySelector('.usage-bar > i') as HTMLElement;
    expect(bar.style.width).toBe('87%');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(screen.getByTestId('account-a'));
    const pop = screen.getByRole('tooltip');
    expect(pop.textContent).toContain('2시간 30분 후 리셋');
    expect(pop.textContent).toContain('93%'); // weekly has no reset time at all — no reset text, just the %
    expect(screen.getByTestId('account-a').querySelector('svg.usage-mark.claude.claude-mark')).not.toBeNull();
    expect(screen.getByTestId('account-a').textContent).not.toContain('✳');
    expect(screen.getByTestId('account-b').getAttribute('aria-label')).toContain('(현재)');
    expect(screen.getByTestId('account-a').getAttribute('aria-label')).not.toContain('(현재)');
    fireEvent.click(screen.getByTestId('account-a'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('UsagePanel header layout (styles.css)', () => {
  // Layout itself was checked by hand in a real browser (320–1600px wide);
  // these guard the rules that keep all four cards on screen without sideways scrolling.
  const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
  const usage = css.slice(css.indexOf('/* === usage header === */'), css.indexOf('/* === chat polish === */'));
  it('never scrolls the cards sideways; below 1100px the cards drop to their own row, equally stretched', () => {
    expect(usage).not.toMatch(/overflow-x:\s*auto/);
    expect(usage).toMatch(/\.usage-panel \{[^}]*display: flex;[^}]*flex-wrap: nowrap;/);
    const two = usage.slice(usage.indexOf('@media (max-width: 1099.98px)'));
    expect(two).toMatch(/\.topbar \{[^}]*flex-wrap: wrap/);
    expect(two).toMatch(/\.usage-card \{[^}]*flex: 1 1 0/);
    expect(usage).toMatch(/container: usage-card \/ inline-size/);
  });
  it('many cards wrap to two rows only in the two-row (< 1100px) layout; the wide one-row bar never wraps (fixed height)', () => {
    const at = usage.indexOf('@media (max-width: 1099.98px)');
    const wide = usage.slice(0, at);
    const two = usage.slice(at, usage.indexOf('\n}\n', at));
    expect(wide).not.toMatch(/\.usage-panel\[data-wrap\][^{]*\{[^}]*flex-wrap: wrap/);
    expect(two).toMatch(/\.usage-panel\[data-wrap\] \.usage-card \{[^}]*var\(--usage-cols-wrap\)/);
  });
  it('every @media block in styles.css is closed (an unclosed one swallowed the rules after it)', () => {
    let depth = 0;
    for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) { if (ch === '{') depth++; if (ch === '}') depth--; expect(depth).toBeGreaterThanOrEqual(0); }
    expect(depth).toBe(0);
  });
});

describe('UsagePanel short reset countdown and 다음 tag', () => {
  afterEach(() => { cleanup(); });
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

  it('each card shows the short countdown only on its fullest window', () => {
    const u: UsageSnapshot = { generatedAt: 'x', deckReachable: true, accounts: {
      a: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 20, resetsAt: at(47 * 60_000 + 1) }, weekly: { usedPct: 70, resetsAt: at(2.5 * 86_400_000) }, fable: { usedPct: 5, resetsAt: at(3_600_000) } },
      b: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 30, resetsAt: at(3 * 3_600_000 + 1) }, weekly: { usedPct: 30, resetsAt: at(86_400_000) }, fable: null },
      c: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 90, resetsAt: null }, weekly: { usedPct: 10, resetsAt: at(1000) }, fable: null },
    } };
    render(<UsagePanel usage={u} current={null} now={NOW} />);
    // Only one card-level countdown (`.usage-main .usage-cd`), on whichever window the main row picked (the fullest
    // of fiveHour/weekly — Fable is never eligible): a picks weekly (30% left < fiveHour's 80%).
    const cdOf = (seat: string) => screen.getByTestId(`account-${seat}`).querySelector('.usage-cd');
    const a = cdOf('a')!;
    expect(a.textContent).toBe('2일');
    expect(a.getAttribute('title')).toBe('주간 · 2일 12시간 후 리셋'); // the full wording, naming the window
    expect(a.previousElementSibling!.className).toBe('usage-value'); // right after the % of the main row
    // b: fiveHour and weekly tie at 70% left — the earlier-listed window (fiveHour) wins the main row.
    const b = cdOf('b')!;
    expect(b.textContent).toBe('3시간');
    expect(b.getAttribute('title')).toBe('5h · 3시간 0분 후 리셋');
    // c: the fullest window (fiveHour, 90% used) has no reset time at all — no countdown to show.
    expect(cdOf('c')).toBeNull();
  });

  it('다음 tag on the routed Claude card, Opus noted, reason in the title', () => {
    const { rerender } = render(<UsagePanel usage={usage} current="a" now={NOW} next={{ account: 'b', reason: '5h 여유 많음' }} />);
    const tag = screen.getByTestId('next-b');
    expect(tag.textContent).toBe('→ 다음 턴');
    expect(tag.title).toBe('다음 턴은 이 계정으로 갑니다: 5h 여유 많음');
    // A band on the card itself, outside the id column: every card's letter sits the same way with or without it.
    expect(tag.parentElement).toBe(screen.getByTestId('account-b'));
    expect(screen.getByTestId('account-b').querySelector('.usage-id .usage-next')).toBeNull();
    expect(screen.queryByTestId('next-a')).toBeNull();
    rerender(<UsagePanel usage={usage} current="a" now={NOW} next={{ account: 'c', reason: 'r', asOpus: true }} />);
    expect(screen.getByTestId('next-c').textContent).toBe('→ 다음 턴 · Opus');
    // Staying on the current account is no news: no band — unless the model steps down to Opus there.
    rerender(<UsagePanel usage={usage} current="a" now={NOW} next={{ account: 'a', reason: 'r' }} />);
    expect(screen.queryByTestId(/^next-/)).toBeNull();
    rerender(<UsagePanel usage={usage} current="a" now={NOW} next={{ account: 'a', reason: 'r', asOpus: true }} />);
    expect(screen.getByTestId('next-a').textContent).toBe('→ 다음 턴 · Opus');
    rerender(<UsagePanel usage={usage} current="a" now={NOW} next={null} />);
    expect(screen.queryByTestId(/^next-/)).toBeNull();
  });
});

describe('UsagePanel 남음 caption, colour notes and the measured compact switch', () => {
  afterEach(cleanup);
  it('one 남음 caption for the row, its title explaining amber / red; amber and red rows say so in their title', () => {
    render(<UsagePanel usage={usage} current={null} now={NOW} />);
    const caps = document.querySelectorAll('.usage-caption');
    expect(caps).toHaveLength(1);
    const cap = caps[0] as HTMLElement;
    expect(cap.textContent).toBe('남음');
    expect(cap.title).toContain('20% 이하 남음');
    expect(cap.title).toContain('5% 이하 남음');
    expect(screen.getByTestId('b-fiveHour').title).toBe('5h · 18% 남음 · 노랑: 20% 이하 남음');
    expect(screen.getByTestId('c-weekly').title).toBe('주간 · 4% 남음 · 빨강: 5% 이하 남음');
    expect(screen.getByTestId('a-weekly').title).toBe('주간 · 93% 남음');
  });

  // jsdom has no layout: card widths are set by hand, the (mocked) ResizeObserver fired by hand.
  const withRO = (body: (fire: () => void) => void) => {
    const RO = globalThis.ResizeObserver;
    let cb = () => {};
    globalThis.ResizeObserver = class { constructor(f: () => void) { cb = f; } observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
    try { body(() => act(() => cb())); } finally { globalThis.ResizeObserver = RO; }
  };
  const size = (panel: Element, client: number, scroll: number) => {
    for (const c of panel.querySelectorAll('.usage-card')) {
      Object.defineProperty(c, 'clientWidth', { configurable: true, value: client });
      Object.defineProperty(c, 'scrollWidth', { configurable: true, value: scroll });
    }
  };

  it('switches to the compact card while the full cards overflow, back only once 16px wider than they needed', () => withRO((fire) => {
    const { container } = render(<UsagePanel usage={usage} current={null} now={NOW} />);
    const panel = container.querySelector('.usage-panel')!;
    size(panel, 200, 200); fire();
    expect(panel.hasAttribute('data-dense')).toBe(false);
    size(panel, 110, 140); fire(); // the rows stick out of the card: they need 140px
    expect(panel.hasAttribute('data-dense')).toBe(true);
    size(panel, 150, 150); fire(); // wider than needed, but not by 16px: no flicker at the edge
    expect(panel.hasAttribute('data-dense')).toBe(true);
    size(panel, 156, 156); fire();
    expect(panel.hasAttribute('data-dense')).toBe(false);
  }));

  it('content growing inside a card of the same width (a re-render) switches too, before any resize', () => withRO(() => {
    const { container, rerender } = render(<UsagePanel usage={usage} current={null} now={NOW} />);
    const panel = container.querySelector('.usage-panel')!;
    expect(panel.hasAttribute('data-dense')).toBe(false);
    size(panel, 150, 170);
    rerender(<UsagePanel usage={usage} current={null} now={NOW + 60_000} />);
    expect(panel.hasAttribute('data-dense')).toBe(true);
  }));

  it('a change in the set of cards (Gemini arriving) keeps what was measured: the compact card still lets go', () => withRO((fire) => {
    const { container, rerender } = render(<UsagePanel usage={usage} current={null} now={NOW} />);
    const panel = container.querySelector('.usage-panel')!;
    size(panel, 110, 140); fire();
    expect(panel.hasAttribute('data-dense')).toBe(true);
    const g = { status: 'ok' as const, fetchedAt: null, loggedIn: true, error: null, buckets: [{ name: 'gemini-4-argon', usedPct: 10, resetsAt: null }] };
    rerender(<UsagePanel usage={{ ...usage, gemini: g }} current={null} now={NOW} />);
    expect(panel.hasAttribute('data-dense')).toBe(true);
    size(panel, 200, 200); fire();
    expect(panel.hasAttribute('data-dense')).toBe(false);
  }));

  it('the popover opens with what the numbers and colours mean; the card label names the next turn', () => {
    render(<UsagePanel usage={usage} current="a" now={NOW} next={{ account: 'b', reason: 'r', asOpus: true }} />);
    expect(screen.getByTestId('account-b').getAttribute('aria-label')).toContain('다음 턴 여기(Opus)');
    expect(screen.getByTestId('account-a').getAttribute('aria-label')).not.toContain('다음 턴');
    fireEvent.click(screen.getByTestId('account-a'));
    const first = screen.getByRole('tooltip').children[1] as HTMLElement;
    expect(first.textContent).toContain('남은 양');
    expect(first.textContent).toContain('노랑 = 20% 이하 남음');
  });
});

describe('UsagePanel · cli usage mode (observed times)', () => {
  afterEach(cleanup);
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

  it('each Claude card says when its numbers were observed (title and popover); no usage-deck stale tag', () => {
    render(<UsagePanel usage={cliUsage} current={null} now={NOW} />);
    // a: stale with no trustUntil — dimmed, and the title says routing treats it as unknown.
    expect(screen.getByTestId('account-a').title).toBe('마지막 턴 기준 · 12분 전 · 라우팅은 모름으로 봄');
    expect(screen.getByTestId('account-a').className).toContain('stale');
    expect(screen.getByTestId('account-b').title).toBe('아직 관측 없음');
    expect(screen.getByTestId('account-c').title).toBe('마지막 턴 기준 · 방금');
    expect(screen.queryByText('오래된 값')).toBeNull();
    // The assumed reset is said in the row title and in the popover.
    expect(screen.getByTestId('a-fiveHour').title).toContain('추정');
    expect(screen.getByTestId('a-weekly').title).not.toContain('추정');
    fireEvent.click(screen.getByTestId('account-a'));
    expect(screen.getByTestId('a-observed').textContent).toContain('마지막 턴 기준 · 12분 전');
    // The assumed-reset window still shows its remaining % and 추정 note in the popover (wording lives in its title).
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('100');
    expect(screen.getByTestId('a-fiveHour').title).toContain('추정');
    fireEvent.click(screen.getByTestId('account-a'));
    fireEvent.click(screen.getByTestId('account-b'));
    expect(screen.getByTestId('b-observed').textContent).toContain('아직 관측 없음');
    // GPT has no observation label (its numbers come from the Codex rollout, not a Claude turn).
    expect(screen.getByTestId('account-gpt').title).not.toContain('usage-deck');
  });

  it('MED-1: a stale card within trustUntil is not dimmed and reads "추정 · 마지막 턴 N분 전"; past it, dimmed', () => {
    const a = { ...cliUsage.accounts.a!, fiveHour: { usedPct: 30, resetsAt: new Date(NOW + 3_600_000).toISOString() }, trustUntil: new Date(NOW + 3_600_000).toISOString() };
    const kept: UsageSnapshot = { ...cliUsage, accounts: { ...cliUsage.accounts, a } };
    expect(observedText(a, NOW)).toBe('추정 · 마지막 턴 12분 전');
    expect(observedText(a, NOW + 2 * 3_600_000)).toBe('마지막 턴 기준 · 2시간 전');
    const { unmount } = render(<UsagePanel usage={kept} current={null} now={NOW} />);
    expect(screen.getByTestId('account-a').title).toBe('추정 · 마지막 턴 12분 전');
    expect(screen.getByTestId('account-a').className).toContain('kept');
    expect(screen.getByTestId('account-a').className).not.toContain('stale');
    unmount();
    render(<UsagePanel usage={kept} current={null} now={NOW + 2 * 3_600_000} />);
    expect(screen.getByTestId('account-a').className).toContain('stale');
    expect(screen.getByTestId('account-a').title).toContain('라우팅은 모름으로 봄');
  });

  it('MED-3: in cli mode an unknown Fable row says "CLI 미제공" (row and popover); a known one shows its %', () => {
    const withFable: UsageSnapshot = { ...cliUsage, accounts: { ...cliUsage.accounts, c: { ...cliUsage.accounts.c!, fable: { usedPct: 100, resetsAt: null } } } };
    render(<UsagePanel usage={withFable} current={null} now={NOW} />);
    expect(screen.getByTestId('a-fable').textContent).toContain('CLI 미제공');
    expect(screen.getByTestId('a-fable').title).toBe('Fable · CLI 미제공');
    expect(screen.getByTestId('c-fable').textContent).toContain('소진');
    // The popover row has no space between the label and the "no numbers" text (adjacent <span>s, no text node between).
    expect(screen.getByTestId('a-fable').textContent).toContain('Fable');
    expect(screen.getByTestId('a-fable').textContent).toContain('CLI 미제공');
  });

  it('LOW-5: an estimated row carries the estimated class (striped bar, dashed number — no hover needed)', () => {
    render(<UsagePanel usage={cliUsage} current={null} now={NOW} />);
    expect(screen.getByTestId('a-fiveHour').className).toContain('estimated');
    expect(screen.getByTestId('a-weekly').className).not.toContain('estimated');
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/\.usage-row\.estimated \.usage-bar > i \{ background: repeating-linear-gradient/);
    expect(css).toMatch(/\.usage-row\.estimated \.usage-value \{ text-decoration: underline dashed/);
  });

  it('usage-deck mode shows no observed label', () => {
    render(<UsagePanel usage={usage} current={null} now={NOW} />);
    expect(screen.getByTestId('account-a').title).toBe('');
    // No "CLI 미제공" and no trust rule outside cli mode.
    expect(document.body.textContent).not.toContain('CLI 미제공');
    fireEvent.click(screen.getByTestId('account-a'));
    expect(screen.queryByTestId('a-observed')).toBeNull();
  });
});

describe('UsagePanel · Grok seat (card, chip, cooldown expiry, midnight)', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const today = localDay(new Date(NOW));
  const yesterday = localDay(new Date(NOW - 86_400_000));
  const grokUsage = (g: Partial<GrokUsage>): UsageSnapshot => ({
    ...usage,
    grokSeats: { x1: { status: 'ok', lastTurnAt: new Date(NOW - 10 * 60_000).toISOString(), lastError: null, cooldownUntil: null, today: { inputTokens: 1200, outputTokens: 34, turns: 3, day: today }, ...g } },
  });
  const phone = () => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-width: 599.98px)', addEventListener() {}, removeEventListener() {} }));

  it('no Grok card without grok.bin; with it, the status sentence and today\'s deck tally', () => {
    const { unmount } = render(<UsagePanel usage={grokUsage({})} current={null} now={NOW} />);
    expect(screen.queryByTestId('account-x1')).toBeNull();
    unmount();
    render(<UsagePanel usage={grokUsage({})} current={null} now={NOW} grok={{ bin: true }} />);
    expect(screen.getByTestId('x1-main').textContent).toBe('사용 가능 · 마지막 턴 10분 전');
    expect(screen.getByTestId('x1-secondary').textContent).toBe('오늘 3턴 · 입력 1,200 · 출력 34 · deck 기준');
    expect(screen.getByTestId('account-x1').querySelector('svg.usage-mark.grok')).not.toBeNull();
  });

  it('a live cooldown says "한도 — HH:MM 이후" and the chip ●대기', () => {
    const until = new Date(NOW + 30 * 60_000).toISOString();
    const { unmount } = render(<UsagePanel usage={grokUsage({ status: 'cooldown', cooldownUntil: until })} current={null} now={NOW} grok={{ bin: true }} />);
    expect(screen.getByTestId('x1-main').textContent).toBe(`한도 — ${resetStamp(until)} 이후`);
    expect(screen.getByTestId('account-x1').className).toContain('cooldown');
    unmount();
    phone();
    render(<UsagePanel usage={grokUsage({ status: 'cooldown', cooldownUntil: until })} current={null} now={NOW} grok={{ bin: true }} />);
    expect(screen.getByTestId('chip-x1').textContent).toContain('●대기');
  });

  it('a cooldown whose time has passed is no longer shown (card and chip), even while the snapshot still says cooldown', () => {
    const passed = grokUsage({ status: 'cooldown', cooldownUntil: new Date(NOW - 60_000).toISOString() });
    const { unmount } = render(<UsagePanel usage={passed} current={null} now={NOW} grok={{ bin: true }} />);
    expect(screen.getByTestId('x1-main').textContent).toBe('사용 가능 · 마지막 턴 10분 전');
    expect(screen.getByTestId('account-x1').className).not.toContain('cooldown');
    expect(screen.queryByTestId('x1-dot')).toBeNull();
    unmount();
    phone();
    render(<UsagePanel usage={passed} current={null} now={NOW} grok={{ bin: true }} />);
    expect(screen.getByTestId('chip-x1').textContent).not.toContain('대기');
    expect(screen.getByTestId('chip-x1').textContent).toContain('○가능');
  });

  it('after local midnight, yesterday\'s tally reads 0 until the next turn', () => {
    render(<UsagePanel usage={grokUsage({ today: { inputTokens: 1200, outputTokens: 34, turns: 3, day: yesterday } })} current={null} now={NOW} grok={{ bin: true }} />);
    expect(screen.getByTestId('x1-secondary').textContent).toBe('오늘 0턴 · 입력 0 · 출력 0 · deck 기준');
  });

  const billing = (usedPct: number, endMs = NOW + 6 * 86_400_000 + 2 * 3_600_000) => ({
    usedPct, windowStart: new Date(endMs - 7 * 86_400_000).toISOString(), windowEnd: new Date(endMs).toISOString(),
    tier: 'SuperGrok Heavy', fetchedAt: new Date(NOW - 5 * 60_000).toISOString(), periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
  });

  it('with the subscription usage: one bar line "▬ 99% · 6일", tier + deck turns below, popover with the same %, tier and today', () => {
    render(<UsagePanel usage={grokUsage({ billing: billing(1) })} current={null} now={NOW} grok={{ bin: true }} />);
    const main = screen.getByTestId('x1-main');
    expect(main.querySelector('.usage-bar > i')!.getAttribute('style')).toContain('width: 99%');
    expect(main.querySelector('.usage-value')!.textContent).toBe('99%');
    expect(main.querySelector('.usage-cd')!.textContent).toBe('6일');
    expect(main.className).not.toContain('usage-main-text');
    expect(screen.getByTestId('account-x1').querySelectorAll('.usage-main')).toHaveLength(1);
    expect(screen.getByTestId('x1-secondary').textContent).toBe('SuperGrok Heavy · deck 오늘 3턴');
    expect(screen.getByTestId('x1-week').textContent).toContain('주간');
    expect(screen.getByTestId('x1-week').textContent).toContain('99%');
    expect(screen.getByTestId('x1-tier').textContent).toBe('구독SuperGrok Heavy');
    expect(screen.getByTestId('x1-today').textContent).toBe('deck 오늘3턴 · 입력 1,200 · 출력 34');
    expect(screen.getByTestId('x1-observed').textContent).toContain('확인');
  });

  it('with the subscription usage the phone chip shows the same remaining %', () => {
    phone();
    render(<UsagePanel usage={grokUsage({ billing: billing(1) })} current={null} now={NOW} grok={{ bin: true }} />);
    expect(screen.getByTestId('chip-x1').textContent).toContain('99%');
    fireEvent.click(screen.getByTestId('chip-x1'));
    const pop = screen.getByRole('tooltip');
    expect(pop.textContent).toContain('99%');
    expect(pop.textContent).toContain('SuperGrok Heavy');
    expect(pop.textContent).toContain('deck 오늘');
  });

  it('a live cooldown wins over the bar (card and chip)', () => {
    const until = new Date(NOW + 30 * 60_000).toISOString();
    const u = grokUsage({ status: 'cooldown', cooldownUntil: until, billing: billing(40) });
    const { unmount } = render(<UsagePanel usage={u} current={null} now={NOW} grok={{ bin: true }} />);
    expect(screen.getByTestId('x1-main').textContent).toBe(`한도 — ${resetStamp(until)} 이후`);
    expect(screen.getByTestId('x1-main').querySelector('.usage-bar')).toBeNull();
    expect(screen.getByTestId('account-x1').className).toContain('cooldown');
    unmount();
    phone();
    render(<UsagePanel usage={u} current={null} now={NOW} grok={{ bin: true }} />);
    expect(screen.getByTestId('chip-x1').textContent).toContain('●대기');
  });

  it('a period that ended since the reading reads as a fresh period (estimated, not the old number)', () => {
    render(<UsagePanel usage={grokUsage({ billing: billing(90, NOW - 60_000) })} current={null} now={NOW} grok={{ bin: true }} />);
    const main = screen.getByTestId('x1-main');
    expect(main.querySelector('.usage-value')!.textContent).toBe('100%~');
  });

  it('without the subscription usage and no turn yet: one small grey line "아직 사용 없음", no bar', () => {
    render(<UsagePanel usage={grokUsage({ status: 'unknown', lastTurnAt: null, today: { inputTokens: 0, outputTokens: 0, turns: 0, day: today } })} current={null} now={NOW} grok={{ bin: true }} />);
    const card = screen.getByTestId('account-x1');
    expect(card.querySelectorAll('.usage-main')).toHaveLength(1);
    expect(screen.getByTestId('x1-main').textContent).toBe('아직 사용 없음');
    expect(screen.getByTestId('x1-main').className).toContain('usage-main-text');
    expect(card.querySelector('.usage-bar')).toBeNull();
  });

  it('styles: the status dot sits in the corner (not a row under the letter); the reason text is one small muted line', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/\.usage-dot \{[^}]*position: absolute;/);
    expect(css).toMatch(/\.usage-main-text \{[^}]*white-space: nowrap;[^}]*\}/);
    expect(css).toMatch(/\.usage-main-text \{[^}]*text-overflow: ellipsis;[^}]*\}/);
    expect(css).toMatch(/\.usage-main-text \{[^}]*color: var\(--muted\)[^}]*\}/);
  });
});

describe('UsagePanel · phone chip popover', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const phone = () => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-width: 599.98px)', addEventListener() {}, removeEventListener() {} }));

  it('Esc closes the open chip popover', () => {
    phone();
    render(<UsagePanel usage={usage} current={null} now={NOW} />);
    fireEvent.click(screen.getByTestId('chip-a'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('the chip popover has the "토큰 사용량 기록 보기" link, which closes it and opens the history', () => {
    phone();
    const onOpenHistory = vi.fn();
    render(<UsagePanel usage={usage} current={null} now={NOW} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByTestId('chip-a'));
    fireEvent.click(screen.getByRole('button', { name: '토큰 사용량 기록 보기 ›' }));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
