// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UsageStrip, pickStage, STRIP_SLACK } from './UsageStrip';
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
const today = { inputTokens: 0, outputTokens: 0, turns: 0, day: '' };
const snap = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  generatedAt: 'x', deckReachable: true,
  accounts: { a: acct(42, 10), b: acct(18, 5), c: acct(100, 10, { fiveHour: { usedPct: 100, resetsAt: at(12 * 60_000) } }) },
  gpt: acct(85, 20),
  ...over,
});

const strip = (u: UsageSnapshot | null, current: Seat | null, opts: { next?: RouteNext | null; grok?: GrokStatus | null; phone?: boolean; open?: boolean; onToggle?: () => void } = {}) =>
  render(<UsageStrip usage={u} current={current} next={opts.next ?? null} grok={opts.grok ?? null} phone={opts.phone ?? false} open={opts.open ?? false} now={NOW} onToggle={opts.onToggle ?? (() => {})} />);
const el = () => screen.getByTestId('usage-strip');
const seg = (s: string) => screen.getByTestId(`seg-${s}`);

afterEach(cleanup);

describe('pickStage', () => {
  const need = { full: 600, mid: 400, min: 300 };
  it('the widest stage that fits; past min the chip', () => {
    expect(pickStage('full', 700, need)).toBe('full');
    expect(pickStage('full', 599, need)).toBe('mid');
    expect(pickStage('full', 350, need)).toBe('min');
    expect(pickStage('full', 299, need)).toBe('chip');
  });
  it('going back up needs the slack on top; staying or going down does not', () => {
    expect(pickStage('mid', 600, need)).toBe('mid');
    expect(pickStage('mid', 600 + STRIP_SLACK - 1, need)).toBe('mid');
    expect(pickStage('mid', 600 + STRIP_SLACK, need)).toBe('full');
    expect(pickStage('mid', 400, need)).toBe('mid');
    expect(pickStage('chip', 300, need)).toBe('chip');
    expect(pickStage('chip', 300 + STRIP_SLACK, need)).toBe('min');
    expect(pickStage('min', 300, need)).toBe('min');
    expect(pickStage('chip', 1000, need)).toBe('full');
  });
});

describe('UsageStrip', () => {
  it('one segment per seat in buildSeats order; full: label · bar · % · reset; spent says 소진 · reset', () => {
    strip(snap(), 'a');
    const segs = el().querySelectorAll('.usage-seg');
    expect([...segs].map((s) => s.getAttribute('data-testid'))).toEqual(['seg-a', 'seg-b', 'seg-c', 'seg-gpt']);
    expect(seg('a').textContent).toBe('A42%2h');
    expect((seg('a').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('42%');
    expect(seg('c').className).toContain('spent');
    expect(seg('c').textContent).toBe('C소진· 12m');
    expect(seg('gpt').className).toContain('warn');
    expect(el().getAttribute('aria-haspopup')).toBe('dialog');
    expect(el().getAttribute('aria-expanded')).toBe('false');
    expect(el().hasAttribute('data-sheet-return')).toBe(true);
  });

  it('the session seat is lifted (data-current); → marks another seat the next turn goes to; the label reads every seat', () => {
    strip(snap(), 'a', { next: { account: 'b', reason: '5h 여유 많음' } });
    expect(seg('a').hasAttribute('data-current')).toBe(true);
    expect(seg('b').hasAttribute('data-current')).toBe(false);
    expect(screen.getByTestId('next-b').textContent).toBe('→');
    expect(el().getAttribute('aria-label')).toBe('계정별 사용량: 지금 A 42%, B 18%, C 소진 12분 뒤 초기화, GPT 85%, 다음 턴 B');
    expect(el().title).toContain('5h 여유 많음');
    cleanup();
    // The same seat: no arrow.
    strip(snap(), 'a', { next: { account: 'a', reason: 'r' } });
    expect(screen.queryByTestId(/^next-/)).toBeNull();
    expect(el().getAttribute('aria-label')).not.toContain('다음 턴');
    cleanup();
    // No session seat yet: only the arrow.
    strip(snap(), null, { next: { account: 'c', reason: 'r', asOpus: true } });
    expect(el().querySelector('[data-current]')).toBeNull();
    expect(screen.getByTestId('next-c')).toBeTruthy();
    expect(el().getAttribute('aria-label')).toContain('다음 턴 C(Opus)');
  });

  it('쿨다운, Grok without numbers (가능 / ?), stale (오래됨) and estimated', () => {
    const grok = { bin: true } as GrokStatus;
    strip(snap({ grokSeats: { x1: { status: 'cooldown', lastTurnAt: null, lastError: null, cooldownUntil: at(30 * 60_000), today } } }), 'a', { grok });
    expect(seg('x1').className).toContain('cooldown');
    expect(seg('x1').textContent).toBe('Grok쿨다운');
    cleanup();
    strip(snap({ grokSeats: { x1: { status: 'ok', lastTurnAt: at(-60_000), lastError: null, cooldownUntil: null, today } } }), 'a', { grok });
    expect(seg('x1').querySelector('.usage-seg-num')!.textContent).toBe('가능');
    expect(el().getAttribute('aria-label')).toContain('Grok 사용 가능');
    cleanup();
    strip(snap(), 'a', { grok });
    expect(seg('x1').querySelector('.usage-seg-num')!.textContent).toBe('?');
    expect(el().getAttribute('aria-label')).toContain('Grok 알 수 없음');
    cleanup();
    strip(snap({ accounts: { a: acct(97, 10, { status: 'stale' }), b: acct(30, 5, { status: 'stale' }) } }), 'a');
    expect(seg('a').className).toBe('usage-seg danger stale');
    expect(seg('a').textContent).toBe('A97%오래됨');
    expect(seg('b').className).toBe('usage-seg stale');
    expect(el().getAttribute('aria-label')).toContain('A 97% 오래됨');
    cleanup();
    strip(snap({ accounts: { a: acct(null, 30, { weekly: { usedPct: 30, resetsAt: at(3 * 86_400_000), estimated: true } }) } }), 'a');
    expect(seg('a').className).toContain('estimated');
    expect(el().getAttribute('aria-label')).toContain('A 30% 추정');
  });

  it('phone: the mid stage in a line of its own (no bar; the reset only when amber / red / spent)', () => {
    const { container } = strip(snap(), 'a', { phone: true });
    expect(container.querySelector('.usage-strip-row')).toBeTruthy();
    expect(el().querySelector('.usage-seg-bar')).toBeNull();
    expect(seg('a').textContent).toBe('A42%');
    expect(seg('gpt').textContent).toBe('GPT85%2h');
    expect(seg('c').textContent).toBe('C소진· 12m');
  });

  it('measured (ResizeObserver): steps down to mid / min and, when not even min fits, hands over to the one-seat chip', () => {
    const RO = globalThis.ResizeObserver;
    const proto = HTMLElement.prototype;
    const ow = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')!;
    const cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
    let avail = 1000;
    // The measuring copies: full 600, mid 400, min 300 (in that order inside .usage-strip-measure).
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return ({ 0: 600, 1: 400, 2: 300 } as Record<number, number>)[[...(this.parentElement?.children ?? [])].indexOf(this)] ?? 0; } });
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return avail; } });
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
    try {
      const stageOf = (a: number) => { avail = a; const r = strip(snap(), 'a'); const w = r.container.firstElementChild as HTMLElement; const s = w.getAttribute('data-stage'); cleanup(); return { s, maxWidth: w.style.maxWidth }; };
      expect(stageOf(1000)).toEqual({ s: 'full', maxWidth: `${600 + STRIP_SLACK}px` });
      expect(stageOf(500).s).toBe('mid');
      expect(stageOf(320).s).toBe('min');
      avail = 200;
      strip(snap(), 'a');
      expect(screen.queryByTestId('usage-strip')).toBeNull();
      expect(screen.getByTestId('usage-chip').textContent).toBe('A42% · 2h');
    } finally {
      globalThis.ResizeObserver = RO;
      Object.defineProperty(proto, 'offsetWidth', ow);
      Object.defineProperty(Element.prototype, 'clientWidth', cw);
    }
  });

  it('nothing without a snapshot or any number; click toggles; aria-expanded follows open', () => {
    strip(null, 'a');
    expect(screen.queryByTestId('usage-strip')).toBeNull();
    cleanup();
    strip(snap({ accounts: { a: acct(null, null), b: acct(null, null) }, gpt: acct(null, null) }), null);
    expect(screen.queryByTestId('usage-strip')).toBeNull();
    cleanup();
    const onToggle = vi.fn();
    strip(snap(), 'a', { open: true, onToggle });
    expect(el().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(el());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
