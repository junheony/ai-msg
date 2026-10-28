// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const summary = () => screen.getByTestId('usage-summary');
const reveal = () => { fireEvent.click(el()); };

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
  it('the header is one pill for the tightest seat; opening it lists every seat at full: label · bar · REMAINING % · reset', () => {
    strip(snap(), 'a');
    // Spent (0 left) is tighter than GPT's 15, so the pill names C and draws one bar. No seat row yet.
    expect(el().querySelector('.usage-seg')).toBeNull();
    expect(summary().textContent).toBe('C소진');
    expect(el().querySelectorAll('.usage-seg-bar')).toHaveLength(1);
    expect((el().querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('0%');
    expect(el().querySelector('.usage-strip-head')).toBeNull();
    expect(el().className).toContain('spent');
    expect(el().title).toMatch(/^계정별 남은 사용량 — 숫자와 막대는 남은 양/);
    expect(el().getAttribute('aria-haspopup')).toBe('true');
    expect(el().getAttribute('aria-expanded')).toBe('false');
    expect(el().hasAttribute('data-sheet-return')).toBe(true);
    expect(screen.queryByTestId('usage-strip-pop')).toBeNull();
    reveal();
    const segs = screen.getByTestId('usage-strip-pop').querySelectorAll('.usage-seg');
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
    expect(el().getAttribute('aria-expanded')).toBe('true');
    // The pill stays one seat; the list is the popover.
    expect(el().querySelector('.usage-seg')).toBeNull();
    expect(summary().textContent).toBe('C소진');
  });

  it('with nothing spent, the pill is the lowest remaining % and says 남음; six seats still open as six full rows', () => {
    const healthy = snap({ accounts: { a: acct(42, 10), b: acct(18, 5), c: acct(10, 5) }, gpt: acct(20, 5) });
    strip(healthy, 'a');
    expect(summary().textContent).toBe('A58%');
    expect(el().querySelector('.usage-strip-head')!.textContent).toBe('남음');
    expect((el().querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('58%');
    expect(el().className).toContain('ok');
    cleanup();
    const grok = { bin: true } as GrokStatus;
    const gemini = { status: 'ok' as const, fetchedAt: null, loggedIn: true, buckets: [{ name: 'Gemini · 5h', usedPct: 40, resetsAt: at(3_600_000) }] };
    strip(snap({ gemini }), 'a', { grok });
    expect(el().querySelector('.usage-seg')).toBeNull();
    reveal();
    expect([...screen.getByTestId('usage-strip-pop').querySelectorAll('.usage-seg')].map((s) => s.getAttribute('data-testid'))).toEqual(['seg-a', 'seg-b', 'seg-c', 'seg-gpt', 'seg-g1', 'seg-x1']);
    expect(seg('a').textContent).toBe('A58%2h');
    expect(seg('g1').textContent).toBe('Gemini60%1h');
    expect((seg('g1').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('60%');
    expect(seg('x1').querySelector('.usage-seg-bar')).not.toBeNull();
    expect(seg('c').textContent).toBe('C소진· 12m');
  });

  it('the session seat is lifted (data-current); → marks another seat the next turn goes to; the label reads every seat', () => {
    strip(snap(), 'a', { next: { account: 'b', reason: '5h 여유 많음' } });
    expect(el().getAttribute('aria-label')).toBe('계정별 남은 사용량: 지금 A 58퍼센트 남음, 2시간 뒤 초기화; B 82퍼센트 남음, 2시간 뒤 초기화; C 소진, 12분 뒤 초기화; GPT 15퍼센트 남음, 2시간 뒤 초기화; 다음 턴 B');
    expect(el().title).toContain('5h 여유 많음');
    expect(screen.queryByTestId('next-b')).toBeNull();
    reveal();
    expect(seg('a').hasAttribute('data-current')).toBe(true);
    expect(seg('b').hasAttribute('data-current')).toBe(false);
    expect(screen.getByTestId('next-b').textContent).toBe('→');
    cleanup();
    // The same seat: no arrow.
    strip(snap(), 'a', { next: { account: 'a', reason: 'r' } });
    expect(el().getAttribute('aria-label')).not.toContain('다음 턴');
    reveal();
    expect(screen.queryByTestId(/^next-/)).toBeNull();
    cleanup();
    // No session seat yet: only the arrow, and only once the list is open.
    strip(snap(), null, { next: { account: 'c', reason: 'r', asOpus: true } });
    expect(el().getAttribute('aria-label')).toContain('다음 턴 C(Opus)');
    expect(screen.queryByTestId('next-c')).toBeNull();
    reveal();
    expect(document.querySelector('[data-current]')).toBeNull();
    expect(screen.getByTestId('next-c')).toBeTruthy();
    expect(el().getAttribute('aria-label')).toContain('다음 턴 C(Opus)');
  });

  it('쿨다운 (only what is known), Grok without numbers (가능 / ?), stale (오래됨, a spent seat too) and estimated', () => {
    const grok = { bin: true } as GrokStatus;
    strip(snap({ grokSeats: { x1: { status: 'cooldown', lastTurnAt: null, lastError: null, cooldownUntil: at(30 * 60_000), today } } }), 'a', { grok });
    expect(el().getAttribute('aria-label')).toContain('Grok 쿨다운 30분 뒤 해제');
    reveal();
    expect(seg('x1').className).toContain('cooldown');
    expect(seg('x1').textContent).toBe('Grok쿨다운· 30m');
    // No used % is known in a cooldown: an empty track, not a full bar; its end is said when known.
    expect((seg('x1').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('0%');
    cleanup();
    strip(snap({ grokSeats: { x1: { status: 'ok', lastTurnAt: at(-60_000), lastError: null, cooldownUntil: null, today } } }), 'a', { grok });
    expect(el().getAttribute('aria-label')).toContain('Grok 사용 가능');
    reveal();
    expect(seg('x1').querySelector('.usage-seg-num')!.textContent).toBe('가능');
    cleanup();
    strip(snap(), 'a', { grok });
    expect(el().getAttribute('aria-label')).toContain('Grok 알 수 없음');
    reveal();
    expect(seg('x1').querySelector('.usage-seg-num')!.textContent).toBe('?');
    cleanup();
    strip(snap({ accounts: { a: acct(97, 10, { status: 'stale' }), b: acct(30, 5, { status: 'stale' }) } }), 'a');
    // 3 % left is the tightest number, so the pill names A before the list opens.
    expect(summary().textContent).toBe('A3%');
    expect(el().className).toContain('danger');
    reveal();
    // Old numbers, read time unknown: "오래됨" as before (red still red: 97 % used = 3 % left).
    expect(seg('a').className).toBe('usage-seg danger stale');
    expect(seg('a').textContent).toBe('A3%오래됨');
    expect(seg('b').className).toBe('usage-seg stale');
    expect(seg('a').querySelector('.usage-seg-age svg')).not.toBeNull();
    expect(el().getAttribute('aria-label')).toContain('A 3퍼센트 남음, 2시간 뒤 초기화, 마지막 턴 기준의 오래된 값, 지금은 이보다 적게 남았을 수 있음');
    expect(el().getAttribute('aria-label')).toContain('B 70퍼센트 남음, 2시간 뒤 초기화, 마지막 턴 기준의 오래된 값');
    cleanup();
    strip(snap({ accounts: { a: acct(42, 10), c: acct(100, 10, { status: 'stale', fiveHour: { usedPct: 100, resetsAt: at(12 * 60_000) } }) } }), 'a');
    reveal();
    expect(seg('c').className).toBe('usage-seg spent stale');
    expect(el().getAttribute('aria-label')).toContain('C 소진, 12분 뒤 초기화, 마지막 턴 기준의 오래된 값');
    cleanup();
    strip(snap({ accounts: { a: acct(null, 30, { weekly: { usedPct: 30, resetsAt: at(3 * 86_400_000), estimated: true } }) } }), 'a');
    reveal();
    expect(seg('a').className).toContain('estimated');
    expect(el().getAttribute('aria-label')).toContain('A 70퍼센트 남음, 3일 뒤 초기화, 추정');
  });

  it('colours stay by what is used: ≤20% left amber, ≤5% left red (levelClass), shown as what is left', () => {
    strip(snap({ accounts: { a: acct(79, 0), b: acct(80, 0), c: acct(94, 0) }, gpt: acct(95, 0) }), 'a');
    expect(summary().textContent).toBe('GPT5%');
    expect(el().querySelector('.usage-strip-head')!.textContent).toBe('남음');
    expect(el().className).toContain('danger');
    expect(el().querySelector('.usage-seg')).toBeNull();
    reveal();
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

  it('old numbers: dimmed, the old % with a clock and when it was read; past the reset a refresh "리셋됨" on an empty track; no reset time: 오래됨', () => {
    const read = at(-3 * 86_400_000);
    // C last read 3 days ago, its weekly (90 % used) resets in 2 days: the old % stays, with the age.
    const c = { status: 'stale' as const, fetchedAt: read, fiveHour: null, weekly: { usedPct: 90, resetsAt: at(2 * 86_400_000) }, fable: null };
    strip(snap({ accounts: { a: acct(42, 10), c } }), 'a');
    reveal();
    expect(seg('c').className).toBe('usage-seg warn stale');
    expect(seg('c').textContent).toBe('C10%3일 전');
    expect(seg('c').querySelector('.usage-seg-age svg')).not.toBeNull();
    expect(el().getAttribute('aria-label')).toContain('C 10퍼센트 남음, 2일 뒤 초기화, 3일 전 마지막 턴 기준 값, 지금은 이보다 적게 남았을 수 있음');
    expect(el().title).toContain('C 10% — 3일 전 마지막 턴 기준 값. 지금은 이보다 적게 남았을 수 있음');
    cleanup();
    // The same reading, the weekly reset an hour ago: the 90 % says nothing any more.
    const gone = { ...c, weekly: { usedPct: 90, resetsAt: at(-3_600_000) } };
    strip(snap({ accounts: { a: acct(42, 10), c: gone } }), 'a');
    reveal();
    expect(seg('c').className).toBe('usage-seg stale');
    expect(seg('c').querySelector('.usage-seg-num')!.textContent).toBe('리셋됨');
    expect(seg('c').querySelector('.usage-seg-num svg')).not.toBeNull();
    expect(seg('c').querySelector('.usage-seg-reset')).toBeNull();
    expect((seg('c').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('0%');
    expect(el().getAttribute('aria-label')).toContain('C 리셋 시각이 지나 지금 값은 모름, 이 계정으로 한 턴 돌리면 갱신됨');
    expect(el().getAttribute('aria-label')).not.toContain('C 10퍼센트');
    expect(el().title).toContain('C — 리셋 시각이 지나 지금 값은 모름. 이 계정으로 한 턴 돌리면 갱신됨');
    cleanup();
    // A spent window whose reset has passed: also "리셋됨", not 소진.
    strip(snap({ accounts: { a: acct(42, 10), c: { ...c, weekly: { usedPct: 100, resetsAt: at(-60_000) } } } }), 'a');
    reveal();
    expect(seg('c').querySelector('.usage-seg-num')!.textContent).toBe('리셋됨');
    cleanup();
    // No reset time known: as before.
    strip(snap({ accounts: { a: acct(42, 10), c: { ...c, weekly: { usedPct: 90, resetsAt: null } } } }), 'a');
    reveal();
    expect(seg('c').textContent).toBe('C10%오래됨');
    expect(el().getAttribute('aria-label')).toContain('C 10퍼센트 남음, 마지막 턴 기준의 오래된 값');
    cleanup();
    // A phone opens the same full row (bar, %, age), not a thinner mid line.
    strip(snap({ accounts: { a: acct(42, 10), c } }), 'a', { phone: true });
    expect(document.querySelector('.usage-strip-row')).toBeNull();
    reveal();
    expect(seg('c').textContent).toBe('C10%3일 전');
    expect(seg('c').querySelector('.usage-seg-bar')).not.toBeNull();
    expect(seg('c').querySelector('.usage-seg-age svg')).not.toBeNull();
    cleanup();
    strip(snap({ accounts: { a: acct(42, 10), c: gone } }), 'a', { phone: true });
    reveal();
    expect(seg('c').textContent).toBe('C리셋됨');
    expect(seg('c').querySelector('.usage-seg-bar')).not.toBeNull();
  });

  it('old numbers per window: a 5h window past its reset is dropped, the weekly one not reset yet still shows (a lower bound)', () => {
    const read = at(-3 * 86_400_000);
    // 5h read at 95 % used, reset an hour ago; weekly 30 % used, resets in 2 days: C 70% with the age, not 5 % nor 리셋됨.
    const c = { status: 'stale' as const, fetchedAt: read, fiveHour: { usedPct: 95, resetsAt: at(-3_600_000) }, weekly: { usedPct: 30, resetsAt: at(2 * 86_400_000) }, fable: null };
    strip(snap({ accounts: { a: acct(42, 10), c } }), 'a');
    reveal();
    expect(seg('c').className).toBe('usage-seg stale');
    expect(seg('c').textContent).toBe('C70%3일 전');
    expect((seg('c').querySelector('.usage-seg-bar > i') as HTMLElement).style.width).toBe('70%');
    expect(el().getAttribute('aria-label')).toContain('C 70퍼센트 남음, 2일 뒤 초기화, 3일 전 마지막 턴 기준 값');
    cleanup();
    // Both windows past their reset: only then 리셋됨.
    strip(snap({ accounts: { a: acct(42, 10), c: { ...c, weekly: { usedPct: 30, resetsAt: at(-60_000) } } } }), 'a');
    reveal();
    expect(seg('c').querySelector('.usage-seg-num')!.textContent).toBe('리셋됨');
    cleanup();
    // A window without a reset time is not known to have passed: it stays, as 오래됨.
    strip(snap({ accounts: { a: acct(42, 10), c: { ...c, weekly: { usedPct: 30, resetsAt: null } } } }), 'a');
    reveal();
    expect(seg('c').textContent).toBe('C70%오래됨');
    cleanup();
    // Fresh numbers are not judged by reset time (the server's own job): the fuller window still shows.
    strip(snap({ accounts: { a: acct(42, 10), c: { ...c, status: 'ok' as const } } }), 'a');
    reveal();
    expect(seg('c').querySelector('.usage-seg-num')!.textContent).toBe('5%');
  });

  it('phone: the same collapsed pill, in place; opening it is the full list, not a mid row under the bar', () => {
    const { container } = strip(snap(), 'a', { phone: true, rowSlot: document.createElement('div') });
    expect(container.querySelector('.usage-strip-row')).toBeNull();
    expect(el().closest('.usage-strip-wrap')).toBeTruthy();
    expect(el().querySelector('.usage-seg')).toBeNull();
    expect(summary().textContent).toBe('C소진');
    reveal();
    expect(seg('a').textContent).toBe('A58%2h');
    expect(seg('a').querySelector('.usage-seg-bar')).not.toBeNull();
    expect(seg('gpt').textContent).toBe('GPT15%2h');
    expect(seg('c').textContent).toBe('C소진· 12m');
  });

  it('a narrow top bar still keeps the collapsed pill; barRoom still ignores the strip itself', () => {
    const cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
    const rect = Element.prototype.getBoundingClientRect;
    const gcs = globalThis.getComputedStyle;
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get(this: Element) { return this.tagName === 'HEADER' ? 400 : 0; } });
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { width: this.hasAttribute('data-w') ? Number(this.getAttribute('data-w')) : 0 } as DOMRect;
    };
    globalThis.getComputedStyle = ((e: Element) => {
      const base = { display: 'block', position: 'static', paddingLeft: '0px', paddingRight: '0px', minWidth: '0px', columnGap: 'normal', gap: 'normal' };
      if (e.tagName === 'HEADER') return { ...base, display: 'flex', paddingLeft: '10px', paddingRight: '10px', columnGap: '10px' };
      if (e.classList.contains('topbar-head')) return { ...base, minWidth: '220px' };
      if (e.classList.contains('gone')) return { ...base, display: 'none' };
      return base;
    }) as unknown as typeof getComputedStyle;
    const slot = document.body.appendChild(document.createElement('div'));
    try {
      const { container } = render(
        <header className="topbar">
          <button type="button" className="gone">☰</button>
          <div className="topbar-head" />
          <UsageStrip usage={snap()} current="a" rowSlot={slot} now={NOW} onToggle={() => {}} />
          <div className="topbar-end" data-w="100" />
        </header>,
      );
      const bar = container.querySelector('header')!;
      const own = (e: Element) => e.matches('.usage-strip-wrap, .usage-strip-row');
      // 400 − 20 − 220 − 100 − 2 × 10. The pill is not in that sum.
      expect(barRoom(bar, own)).toBe(40);
      expect(bar.contains(el())).toBe(true);
      expect(slot.childElementCount).toBe(0);
      expect(el().querySelector('.usage-seg')).toBeNull();
      expect(summary().textContent).toBe('C소진');
      reveal();
      expect(bar.contains(screen.getByTestId('usage-strip-pop'))).toBe(true);
      expect(seg('a').textContent).toBe('A58%2h');
      expect(seg('gpt').textContent).toBe('GPT15%2h');
    } finally {
      slot.remove();
      Object.defineProperty(Element.prototype, 'clientWidth', cw);
      Element.prototype.getBoundingClientRect = rect;
      globalThis.getComputedStyle = gcs;
    }
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

  it('nothing without a snapshot or any number; the pill opens the list, 자세히 opens the sheet, outside and Escape close the list', () => {
    strip(null, 'a');
    expect(screen.queryByTestId('usage-strip')).toBeNull();
    cleanup();
    strip(snap({ accounts: { a: acct(null, null), b: acct(null, null) }, gpt: acct(null, null) }), null);
    expect(screen.queryByTestId('usage-strip')).toBeNull();
    cleanup();
    const onToggle = vi.fn();
    strip(snap(), 'a', { open: true, onToggle });
    // The sheet being open does not expand the six seats under the pill.
    expect(el().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('seg-a')).toBeNull();
    fireEvent.click(el());
    expect(onToggle).not.toHaveBeenCalled();
    expect(el().getAttribute('aria-expanded')).toBe('true');
    expect(seg('c').textContent).toBe('C소진· 12m');
    fireEvent.click(screen.getByRole('button', { name: '자세히' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    cleanup();
    strip(snap(), 'a');
    reveal();
    expect(screen.getByTestId('usage-strip-pop')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('usage-strip-pop')).toBeNull();
    expect(el().getAttribute('aria-expanded')).toBe('false');
    reveal();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('usage-strip-pop')).toBeNull();
  });

  it('a logged-out seat with no remaining numbers still opens the pill for 재로그인', () => {
    const onReauth = vi.fn();
    render(<UsageStrip usage={snap({ accounts: { a: acct(null, null) }, gpt: acct(null, null) })} current={null} reauth={['a']} onReauth={onReauth} now={NOW} onToggle={() => {}} />);
    fireEvent.click(screen.getByTestId('usage-strip'));
    fireEvent.click(screen.getByTestId('reauth-a').querySelector('button')!);
    expect(onReauth).toHaveBeenCalledWith('a');
  });

  it('a logged-out seat in the list offers 재로그인 and nothing else does', () => {
    const onReauth = vi.fn();
    render(<UsageStrip usage={snap()} current="a" reauth={['b']} onReauth={onReauth} now={NOW} onToggle={() => {}} />);
    fireEvent.click(screen.getByTestId('usage-strip'));
    expect(screen.queryByTestId('reauth-a')).toBeNull();
    fireEvent.click(screen.getByTestId('reauth-b').querySelector('button')!);
    expect(onReauth).toHaveBeenCalledWith('b');
  });
});
