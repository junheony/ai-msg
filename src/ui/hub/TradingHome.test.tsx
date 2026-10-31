// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { TradingMerged } from '../../shared/hub-types';
import { BOT_NOW, LEDGER_HEALTH, LEDGER_RECORDS, LEDGER_STATS, LEDGER_VERIFY, PAPER_EQUITY, PAPER_EVENTS, PAPER_STATE, PAPER_TRADES, SNAPSHOT_8830, STATUS_8830 } from '../../server/hub/__fixtures__/trading-bots';
import { buildLedger, buildPaper, parseEquity } from '../../server/hub/cblabx';
import { buildRoom } from '../../server/hub/tradingRoom';
import { TradingHome, sgn, usd } from './TradingHome';

/** The same builders the server uses, so the UI test sees exactly the payload shape the collector ships. */
const merged = (over: { room?: Partial<TradingMerged['room']>; paper?: Partial<TradingMerged['ver2']['paper']>; ledger?: Partial<TradingMerged['ver2']['ledger']> } = {}): TradingMerged => ({
  room: { ...buildRoom({ status: STATUS_8830, snapshot: null, statusError: null }, BOT_NOW), ...over.room },
  ver2: {
    paper: { ...buildPaper(PAPER_STATE, null, PAPER_TRADES, parseEquity(PAPER_EQUITY), PAPER_EVENTS), ...over.paper },
    ledger: { ...buildLedger(LEDGER_HEALTH, null, LEDGER_RECORDS, LEDGER_STATS, LEDGER_VERIFY), ...over.ledger },
  },
});
const H = 3_600_000;
const txt = (el: Element | null): string => el?.textContent ?? '';

afterEach(cleanup);

describe('TradingHome', () => {
  it('renders the read-only banner and not a single control', () => {
    const { container } = render(<TradingHome t={merged()} now={BOT_NOW} />);
    expect(txt(screen.getByRole('note'))).toContain('읽기 전용');
    expect(txt(screen.getByRole('note'))).toContain('워크스트림 PnL 합산 안 함');
    expect(container.querySelectorAll('button, input, select, textarea, form, [onclick], [role="button"]')).toHaveLength(0);
    expect(container.querySelectorAll('a[href]')).toHaveLength(0); // nothing to click through to a bot either
  });
  it('shows taker / maker / adaptive as three separate cards, each with its own PnL line and no total anywhere', () => {
    render(<TradingHome t={merged()} now={BOT_NOW} />);
    const wss = screen.getByTestId('tr-workstreams');
    const cards = within(wss).getAllByRole('article');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['테이커 워크스트림', '메이커 워크스트림', '어댑티브 워크스트림']);
    for (const id of ['taker', 'maker', 'adaptive']) {
      const pnl = screen.getByTestId(`tr-pnl-${id}`);
      expect(txt(pnl)).toContain('PnL');
      expect(txt(pnl)).toContain('미보고');
      expect(txt(pnl)).toContain('합산 안 함');
    }
    expect(within(wss).getByText('12 / 63')).toBeTruthy(); // taker: DWF basket / watch
    expect(within(wss).getByText('켜짐 · paper')).toBeTruthy(); // maker paper
    expect(within(wss).getByText('1,113')).toBeTruthy(); // adaptive onchain alerts
    expect(txt(screen.getByTestId('tr-room'))).not.toMatch(/합계|총 PnL|total/i);
    expect(txt(screen.getByTestId('tr-room'))).toContain('3/3 정상');
    expect(txt(screen.getByTestId('tr-room'))).toContain('스냅샷 오래됨 …'); // the bot's own alert passes through, path scrubbed upstream
  });
  it('bands a snapshot fallback, loudly when it is older than 24h', () => {
    const at = Date.parse('2026-10-30T06:44:35Z');
    const fresh = merged({ room: buildRoom({ status: null, snapshot: SNAPSHOT_8830, statusError: '연결 실패' }, at + 2 * H) });
    const { unmount } = render(<TradingHome t={fresh} now={at + 2 * H} />);
    expect(txt(screen.getByTestId('tr-snapshot-band'))).toContain('스냅샷으로 표시 중');
    expect(txt(screen.getByTestId('tr-snapshot-band'))).not.toContain('24h 초과');
    expect(txt(screen.getByTestId('tr-ws-taker'))).toContain('스냅샷에 없음');
    unmount();
    const stale = merged({ room: buildRoom({ status: null, snapshot: SNAPSHOT_8830, statusError: '연결 실패' }, at + 30 * H) });
    render(<TradingHome t={stale} now={at + 30 * H} />);
    const band = screen.getByTestId('tr-snapshot-band');
    expect(txt(band)).toContain('오래된 스냅샷');
    expect(txt(band)).toContain('24h 초과');
    expect(band.className).toContain('warn');
  });
  it('renders the ver2 books with sparklines, the shared equity chart, open positions, trades, the ledger and events', () => {
    render(<TradingHome t={merged()} now={BOT_NOW} />);
    const books = screen.getByTestId('tr-books');
    expect(within(books).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['① KPB 피벗 돌파 · 15m', '② KPB 피벗 돌파 · 1h', '③ FCV 거짓돌파 · 1h', '④ FCV 거짓돌파 · 4h']);
    expect(within(screen.getByTestId('tr-book-kpb_15m')).getByText('$60,187.61')).toBeTruthy();
    expect(txt(screen.getByTestId('tr-book-kpb_15m'))).toContain('열린 2');
    expect(books.querySelectorAll('.hs-spark svg')).toHaveLength(4);
    expect(screen.getByTestId('hub-chart').querySelector('svg')?.getAttribute('aria-label')).toBe('ver2 북별 자산 곡선');
    expect(txt(screen.getByTestId('tr-paper'))).toContain('PAPER');
    expect(txt(screen.getByTestId('tr-paper'))).toContain('4북 · 열린 2');
    const open = screen.getByTestId('tr-open');
    expect(within(open).getAllByRole('row')).toHaveLength(3); // header + BTC + ETH
    expect(txt(open)).toContain('숏');
    expect(txt(open)).toContain('+9.12 (+0.91%)');
    const trades = screen.getByTestId('tr-trades');
    expect(within(trades).getAllByRole('row')).toHaveLength(3);
    expect(txt(trades)).toContain('손절');
    expect(txt(trades)).toContain('-27.07');
    const ledger = screen.getByTestId('tr-ledger');
    expect(txt(ledger)).toContain('검증 통과');
    expect(txt(ledger)).toContain('통과 · 26건');
    expect(txt(ledger)).toContain('634s'); // 633.8 s median, rounded
    expect(txt(ledger)).not.toContain('7e06f40d');
    expect(txt(screen.getByTestId('tr-events'))).toContain('XRP tp 청산 +41.34 (…)');
  });
  it('keeps the page up when a bot is down, with a plain 응답 없음 block and no retry control', () => {
    const t = merged({ paper: buildPaper(null, '연결 실패', null, null, null), ledger: buildLedger(null, '시간 초과', null, null, null) });
    const { container } = render(<TradingHome t={t} now={BOT_NOW} />);
    expect(txt(screen.getByTestId('tr-paper'))).toContain(':8771 /api/paper/state 응답 없음');
    expect(txt(screen.getByTestId('tr-paper'))).toContain('연결 실패');
    expect(txt(screen.getByTestId('tr-ledger'))).toContain(':8793 /health 응답 없음');
    expect(screen.queryByTestId('tr-equity')).toBeNull();
    expect(screen.queryByTestId('tr-open')).toBeNull();
    expect(screen.getByTestId('tr-workstreams')).toBeTruthy(); // the room still renders
    expect(container.querySelectorAll('button')).toHaveLength(0);
    const none = merged({ room: buildRoom({ status: null, snapshot: null, statusError: '연결 실패' }, BOT_NOW) });
    cleanup();
    render(<TradingHome t={none} now={BOT_NOW} />);
    expect(txt(screen.getByTestId('tr-room'))).toContain(':8830 /api/status 응답 없음');
    expect(within(screen.getByTestId('tr-workstreams')).getAllByRole('article')).toHaveLength(3); // three unknown cards, still apart
  });
  it('flags a LIVE paper engine and a failed verify in red', () => {
    const paper = { ...buildPaper(PAPER_STATE, null, PAPER_TRADES, null, null), live: true };
    const ledger = buildLedger(LEDGER_HEALTH, null, LEDGER_RECORDS, LEDGER_STATS, { ok: false, msg: 'hash mismatch at seq 7', n: 26, warnings: ['seq 7 prev 미일치'] });
    render(<TradingHome t={merged({ paper, ledger })} now={BOT_NOW} />);
    expect(txt(screen.getByRole('alert'))).toContain('LIVE=true');
    expect(txt(screen.getByTestId('tr-ledger'))).toContain('검증 실패');
    expect(txt(screen.getByTestId('tr-ledger'))).toContain('seq 7 prev 미일치');
  });
  it('formats money and signed numbers', () => {
    expect(usd(60187.61)).toBe('$60,187.61');
    expect(usd(-5)).toBe('-$5.00');
    expect(usd(null)).toBe('—');
    expect(sgn(41.34)).toBe('+41.34');
    expect(sgn(-27.07)).toBe('-27.07');
    expect(sgn(0)).toBe('0.00');
  });
});
