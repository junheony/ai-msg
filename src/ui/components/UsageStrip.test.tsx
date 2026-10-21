// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UsageStrip, barRoom, pickStage, STRIP_SLACK } from './UsageStrip';
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

const strip = (u: UsageSnapshot | null, current: Seat | null, opts: { next?: RouteNext | null; grok?: GrokStatus | null; phone?: boolean; rowSlot?: HTMLElement | null; open?: boolean; onToggle?: () => void } = {}) =>
  render(<UsageStrip usage={u} current={current} next={opts.next ?? null} grok={opts.grok ?? null} phone={opts.phone ?? false} rowSlot={opts.rowSlot ?? null} open={opts.open ?? false} now={NOW} onToggle={opts.onToggle ?? (() => {})} />);
const el = () => screen.getByTestId('usage-strip');
const seg = (s: string) => screen.getByTestId(`seg-${s}`);

afterEach(cleanup);

describe('pickStage', () => {
  const need = { full: 600, mid: 400, min: 300 };
  it('the widest stage that fits; past min the line under the bar', () => {
    expect(pickStage('full', 700, need)).toBe('full');
    expect(pickStage('full', 599, need)).toBe('mid');
    expect(pickStage('full', 350, need)).toBe('min');
    expect(pickStage('full', 299, need)).toBe('row');
  });
  it('going back up needs the slack on top; staying or going down does not', () => {
    expect(pickStage('mid', 600, need)).toBe('mid');
    expect(pickStage('mid', 600 + STRIP_SLACK - 1, need)).toBe('mid');
    expect(pickStage('mid', 600 + STRIP_SLACK, need)).toBe('full');
    expect(pickStage('mid', 400, need)).toBe('mid');
    expect(pickStage('row', 300, need)).toBe('row');
    expect(pickStage('row', 300 + STRIP_SLACK, need)).toBe('min');
    expect(pickStage('min', 300, need)).toBe('min');
    expect(pickStage('row', 1000, need)).toBe('full');
  });
});

describe('UsageStrip', () => {
  it('one segment per seat in buildSeats order; full: label · bar · REMAINING % · reset; spent says 소진 · reset', () => {
    strip(snap(), 'a');
    const segs = el().querySelectorAll('.usage-seg');
    expect([...segs].map((s) => s.getAttribute('data-testid'))).toEqual(['seg-a', 'seg-b', 'seg-c', 'seg-gpt']);
    // 42 % used reads 58 % left; the bar is as full as what is left (a battery).
    expect(seg('a').textContent).toBe('A58%2h');
    expect((seg('a').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('58%');
    expect(seg('c').className).toContain('spent');
    expect(seg('c').textContent).toBe('C소진· 12m');
    // Spent: an empty battery (the track turns red in CSS), not a full bar.
    expect((seg('c').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('0%');
    expect(seg('gpt').className).toContain('warn');
    expect(seg('gpt').textContent).toBe('GPT15%2h');
    // The strip says once that the numbers are what is left; the title too.
    expect(el().querySelector('.usage-strip-head')!.textContent).toBe('남음');
    expect(el().title).toMatch(/^계정별 남은 사용량 — 숫자와 막대는 남은 양/);
    expect(el().getAttribute('aria-haspopup')).toBe('dialog');
    expect(el().getAttribute('aria-expanded')).toBe('false');
    expect(el().hasAttribute('data-sheet-return')).toBe(true);
  });

  it('the session seat is lifted (data-current); → marks another seat the next turn goes to; the label reads every seat', () => {
    strip(snap(), 'a', { next: { account: 'b', reason: '5h 여유 많음' } });
    expect(seg('a').hasAttribute('data-current')).toBe(true);
    expect(seg('b').hasAttribute('data-current')).toBe(false);
    expect(screen.getByTestId('next-b').textContent).toBe('→');
    // What is left, with the reset: "GPT 15퍼센트 남음, 2시간 뒤 초기화"; seats apart by "; ".
    expect(el().getAttribute('aria-label')).toBe('계정별 남은 사용량: 지금 A 58퍼센트 남음, 2시간 뒤 초기화; B 82퍼센트 남음, 2시간 뒤 초기화; C 소진, 12분 뒤 초기화; GPT 15퍼센트 남음, 2시간 뒤 초기화; 다음 턴 B');
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

  it('쿨다운 (only what is known), Grok without numbers (가능 / ?), stale (오래됨, a spent seat too) and estimated', () => {
    const grok = { bin: true } as GrokStatus;
    strip(snap({ grokSeats: { x1: { status: 'cooldown', lastTurnAt: null, lastError: null, cooldownUntil: at(30 * 60_000), today } } }), 'a', { grok });
    expect(seg('x1').className).toContain('cooldown');
    expect(seg('x1').textContent).toBe('Grok쿨다운· 30m');
    // No used % is known in a cooldown: an empty track, not a full bar; its end is said when known.
    expect((seg('x1').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('0%');
    expect(el().getAttribute('aria-label')).toContain('Grok 쿨다운 30분 뒤 해제');
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
    // Old numbers, read time unknown: "오래됨" as before (red still red: 97 % used = 3 % left).
    expect(seg('a').className).toBe('usage-seg danger stale');
    expect(seg('a').textContent).toBe('A3%오래됨');
    expect(seg('b').className).toBe('usage-seg stale');
    expect(el().getAttribute('aria-label')).toContain('A 3퍼센트 남음, 2시간 뒤 초기화, 오래된 값');
    expect(el().getAttribute('aria-label')).toContain('B 70퍼센트 남음, 2시간 뒤 초기화, 오래된 값');
    cleanup();
    strip(snap({ accounts: { a: acct(42, 10), c: acct(100, 10, { status: 'stale', fiveHour: { usedPct: 100, resetsAt: at(12 * 60_000) } }) } }), 'a');
    expect(seg('c').className).toBe('usage-seg spent stale');
    expect(el().getAttribute('aria-label')).toContain('C 소진, 12분 뒤 초기화, 오래된 값');
    cleanup();
    strip(snap({ accounts: { a: acct(null, 30, { weekly: { usedPct: 30, resetsAt: at(3 * 86_400_000), estimated: true } }) } }), 'a');
    expect(seg('a').className).toContain('estimated');
    expect(el().getAttribute('aria-label')).toContain('A 70퍼센트 남음, 3일 뒤 초기화, 추정');
  });

  it('colours stay by what is used: ≤20% left amber, ≤5% left red (levelClass), shown as what is left', () => {
    strip(snap({ accounts: { a: acct(79, 0), b: acct(80, 0), c: acct(94, 0) }, gpt: acct(95, 0) }), 'a');
    expect(seg('a').className).toBe('usage-seg ok');
    expect(seg('a').querySelector('.usage-seg-num')!.textContent).toBe('21%');
    expect(seg('b').className).toBe('usage-seg warn');
    expect(seg('b').querySelector('.usage-seg-num')!.textContent).toBe('20%');
    expect(seg('c').className).toBe('usage-seg warn');
    expect(seg('c').querySelector('.usage-seg-num')!.textContent).toBe('6%');
    expect(seg('gpt').className).toBe('usage-seg danger');
    expect(seg('gpt').querySelector('.usage-seg-num')!.textContent).toBe('5%');
    expect((seg('gpt').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('5%');
  });

  it('old numbers: before the reset the old % with when it was read; past it "리셋됨?" on an empty track; no reset time: 오래됨', () => {
    const read = at(-3 * 86_400_000);
    // C last read 3 days ago, its weekly (90 % used) resets in 2 days: the old % stays, with the age.
    const c = { status: 'stale' as const, fetchedAt: read, fiveHour: null, weekly: { usedPct: 90, resetsAt: at(2 * 86_400_000) }, fable: null };
    strip(snap({ accounts: { a: acct(42, 10), c } }), 'a');
    expect(seg('c').className).toBe('usage-seg warn stale');
    expect(seg('c').textContent).toBe('C10%· 3일 전');
    expect(el().getAttribute('aria-label')).toContain('C 10퍼센트 남음, 2일 뒤 초기화, 마지막 턴 기준 3일 전 값');
    expect(el().title).toContain('C 10% — 마지막 턴 기준 3일 전 값');
    cleanup();
    // The same reading, the weekly reset an hour ago: the 90 % says nothing any more.
    const gone = { ...c, weekly: { usedPct: 90, resetsAt: at(-3_600_000) } };
    strip(snap({ accounts: { a: acct(42, 10), c: gone } }), 'a');
    expect(seg('c').className).toBe('usage-seg stale');
    expect(seg('c').querySelector('.usage-seg-num')!.textContent).toBe('리셋됨?');
    expect(seg('c').querySelector('.usage-seg-reset')).toBeNull();
    expect((seg('c').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('0%');
    expect(el().getAttribute('aria-label')).toContain('C 마지막 값 이후 초기화 시각이 지남');
    expect(el().getAttribute('aria-label')).not.toContain('C 10퍼센트');
    expect(el().title).toContain('C — 마지막 값 이후 초기화 시각이 지남');
    cleanup();
    // A spent window whose reset has passed: also "리셋됨?", not 소진.
    strip(snap({ accounts: { a: acct(42, 10), c: { ...c, weekly: { usedPct: 100, resetsAt: at(-60_000) } } } }), 'a');
    expect(seg('c').querySelector('.usage-seg-num')!.textContent).toBe('리셋됨?');
    cleanup();
    // No reset time known: as before.
    strip(snap({ accounts: { a: acct(42, 10), c: { ...c, weekly: { usedPct: 90, resetsAt: null } } } }), 'a');
    expect(seg('c').textContent).toBe('C10%오래됨');
    expect(el().getAttribute('aria-label')).toContain('C 10퍼센트 남음, 오래된 값');
    cleanup();
    // mid (phone): the age is left out like a green reset; "리셋됨?" is the value, so it stays.
    strip(snap({ accounts: { a: acct(42, 10), c: gone } }), 'a', { phone: true });
    expect(seg('c').textContent).toBe('C리셋됨?');
  });

  it('phone: the mid stage in a line of its own (no bar; the reset only when amber / red / spent)', () => {
    const { container } = strip(snap(), 'a', { phone: true });
    expect(container.querySelector('.usage-strip-row')).toBeTruthy();
    expect(el().querySelector('.usage-seg-bar')).toBeNull();
    expect(seg('a').textContent).toBe('A58%');
    expect(seg('gpt').textContent).toBe('GPT15%2h');
    expect(el().querySelector('.usage-strip-head')!.textContent).toBe('남음');
    expect(seg('c').textContent).toBe('C소진· 12m');
  });

  describe('measured in a top bar (ResizeObserver)', () => {
    // A bar 10px padded each side, 10px gaps, actions 100px wide, the session chip at least 220px: the strip's room is
    // barW − 20 − 100 − 220 − 2 × 10 = barW − 360. The measured stages: full / mid / min (in that order).
    let barW = 1000;
    let needs = [600, 400, 300];
    let fire = () => {};
    const RO = globalThis.ResizeObserver;
    const cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
    const rect = Element.prototype.getBoundingClientRect;
    const gcs = globalThis.getComputedStyle;
    beforeEach(() => {
      barW = 1000; needs = [600, 400, 300];
      Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get(this: Element) { return this.tagName === 'HEADER' ? barW : 0; } });
      Element.prototype.getBoundingClientRect = function (this: Element) {
        const p = this.parentElement;
        const width = this.hasAttribute('data-w') ? Number(this.getAttribute('data-w'))
          : p?.classList.contains('usage-strip-measure') ? needs[[...p.children].indexOf(this)]! : 0;
        return { width } as DOMRect;
      };
      globalThis.getComputedStyle = ((e: Element) => {
        const base = { display: 'block', position: 'static', paddingLeft: '0px', paddingRight: '0px', minWidth: '0px', columnGap: 'normal', gap: 'normal' };
        if (e.tagName === 'HEADER') return { ...base, display: 'flex', paddingLeft: '10px', paddingRight: '10px', columnGap: '10px' };
        if (e.classList.contains('topbar-head')) return { ...base, minWidth: '220px' };
        if (e.classList.contains('usage-strip-measure')) return { ...base, position: 'fixed' };
        if (e.classList.contains('gone')) return { ...base, display: 'none' };
        return base;
      }) as unknown as typeof getComputedStyle;
      globalThis.ResizeObserver = class { constructor(cb: () => void) { fire = cb; } observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
    });
    afterEach(() => {
      globalThis.ResizeObserver = RO;
      Object.defineProperty(Element.prototype, 'clientWidth', cw);
      Element.prototype.getBoundingClientRect = rect;
      globalThis.getComputedStyle = gcs;
    });
    const inBar = (slot: HTMLElement | null, grok: GrokStatus | null = null) => (
      <header className="topbar">
        <button type="button" className="gone">☰</button>
        <div className="topbar-head" />
        <UsageStrip usage={snap()} current="a" grok={grok} rowSlot={slot} now={NOW} onToggle={() => {}} />
        <div className="topbar-end" data-w="100" />
      </header>
    );
    const wrapIn = (bar: Element) => bar.querySelector<HTMLElement>('.usage-strip-wrap');

    it('the strip takes only its stage\'s width; past min it leaves the bar entirely (no box left to fill), back only past the slack; the focus follows', () => {
      const slot = document.body.appendChild(document.createElement('div'));
      try {
        const { container } = render(inBar(slot));
        const bar = container.querySelector('header')!;
        // full: no width of its own beyond the content (flex: none in CSS, no inline max-width / flex).
        expect(wrapIn(bar)!.getAttribute('data-stage')).toBe('full');
        expect(wrapIn(bar)!.getAttribute('style')).toBeNull();
        const own = (e: Element) => e.matches('.usage-strip-wrap, .usage-strip-measure, .usage-strip-row');
        const roomInBar = barRoom(bar, own);
        expect(roomInBar).toBe(1000 - 360);
        barW = 760; act(() => fire());
        expect(wrapIn(bar)!.getAttribute('data-stage')).toBe('mid');
        barW = 680; act(() => fire());
        expect(wrapIn(bar)!.getAttribute('data-stage')).toBe('min');
        el().focus();
        // Room 300 − 1: the line under the bar; nothing of the strip is left in the bar to take its width.
        barW = 659; act(() => fire());
        expect(wrapIn(bar)).toBeNull();
        expect(bar.querySelector('[data-testid="usage-strip"]')).toBeNull();
        expect(slot.querySelector('.usage-strip-row [data-testid="usage-strip"]')).toBeTruthy();
        expect(seg('a').textContent).toBe('A58%');
        expect(document.activeElement).toBe(el());
        // The room does not depend on where the strip is: the same with it in the bar or in the line.
        barW = 1000;
        expect(barRoom(bar, own)).toBe(roomInBar);
        // Back to min only with the slack on top.
        barW = 360 + 300 + STRIP_SLACK - 1; act(() => fire());
        expect(wrapIn(bar)).toBeNull();
        barW = 360 + 300 + STRIP_SLACK; act(() => fire());
        expect(wrapIn(bar)!.getAttribute('data-stage')).toBe('min');
        expect(slot.childElementCount).toBe(0);
        expect(document.activeElement).toBe(el());
        expect(bar.contains(el())).toBe(true);
      } finally { slot.remove(); }
    });

    it('a strip that grows (a seat added) is judged against the bar at once, not against its old width', () => {
      const { container, rerender } = render(inBar(null));
      const bar = container.querySelector('header')!;
      expect(wrapIn(bar)!.getAttribute('data-stage')).toBe('full');
      // Grok joins: full grows by 30px (more than the slack) and still fits the 640px room — it stays full, no dip to mid.
      needs = [630, 420, 315];
      rerender(inBar(null, { bin: true } as GrokStatus));
      expect(screen.getByTestId('seg-x1')).toBeTruthy();
      expect(wrapIn(bar)!.getAttribute('data-stage')).toBe('full');
      // Grown past the room: mid on that same render, without waiting for the observer.
      needs = [650, 430, 320];
      rerender(inBar(null, { bin: false } as GrokStatus));
      expect(wrapIn(bar)!.getAttribute('data-stage')).toBe('mid');
    });
  });

  it('touch: the strip, 열기 on a toast, the sheets\' small buttons get a 44px hit area; 열기 is in the link colour; the line tints on hover', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    const touch = css.slice(css.indexOf('@media (hover: none), (max-width: 720px) {'));
    const hit = touch.slice(0, touch.indexOf('\n}\n'));
    for (const sel of ['.usage-strip-wrap > .usage-strip::before', '.act-line .text-btn::before', '.toast-item .text-btn::before', '.usage-history-toggle::before']) expect(hit).toContain(sel);
    expect(hit).toMatch(/width: max\(100%, var\(--phone-tap\)\); height: max\(100%, var\(--phone-tap\)\)/);
    expect(css).toMatch(/\.toast-item:not\(\.error\) \.text-btn \{[^}]*color: var\(--link\)/);
    expect(css).toMatch(/\.usage-strip-row \.usage-strip:hover, \.usage-strip-row \.usage-strip\[aria-expanded="true"\] \{ background: var\(--panel\);/);
    expect(css).not.toContain('.usage-chip');
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
