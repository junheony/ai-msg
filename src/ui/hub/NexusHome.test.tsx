// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { NexusHome as NexusHomeData } from '../../shared/hub-types';
import { ageOf, kstDay, NexusHome, sgn, usd } from './NexusHome';

const T = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST
const iso = (offsetMs: number): string => new Date(T + offsetMs).toISOString();
const DASH = 'http://dash.example:3005';
const TABS = [['지금', '/'], ['상장', '/listing'], ['갭', '/arb'], ['지갑', '/coins'], ['더보기', '/alerts']].map(([label, p]) => ({ label: label!, href: `${DASH}${p}` }));

function fixture(over: Partial<NexusHomeData> = {}): NexusHomeData {
  return {
    ts: iso(-20_000), late: false,
    head: { armed_n: 0, kill: false, gap_age_s: 33, failed_nexus: 2, failed_all: 13 },
    actions: [
      { id: 'a1', kind: 'ops', source: 'ops', verdict: '고장', tone: 'bad', title: '고장 · x.service 실패', action: '로그 보고 고친다', href: `${DASH}/sys`, nums: [], detail: 'PAPER observer', fold: 'fix' },
      { id: 'a2', kind: 'wallet', source: 'crime_cex', verdict: '팀→CEX', tone: 'warn', title: 'FET 팀 지갑 → 바이낸스', action: '물량 확인', href: `${DASH}/crime?sym=FET`, nums: ['금액 $1.2M', '2시간'], detail: '', fold: null },
      { id: 'a3', kind: 'trade', source: 'missed', verdict: '놓침', tone: 'info', title: 'PYBOBO', action: '', href: null, nums: [], detail: '', fold: null },
    ],
    near: [{ id: 'n1', kind: 'near', source: 'kr_gap', verdict: '경로 막힘/미상', tone: 'warn', title: 'ELF HTX→게이트', action: 'HTX 출금중지', href: null, nums: ['갭 +22.63%', '순 모름'], detail: '', fold: null }],
    funnel: { total: 197, route: 142, ident: 9, depth: 10, net: 36, pass: 0 },
    best_24h: 'PUNDIX 쿠코인→업비트 +15.28%',
    ops: [{ tone: 'bad', cat: '고장', title: 'x.service 실패', detail: 'why', ts: iso(-300_000), href: `${DASH}/sys` }, { tone: 'q', cat: '승인', title: '채점 기준 추가?', detail: '32일 대기', ts: null, href: null }],
    kr: { ok: true, age_s: 54, fresh: true, min_net: 5, best_net: 0.12, best_sym: 'CRO' },
    listing: { ok: true, age_s: 30, n_seen: 311, upcoming: 0, pending: 0, recent: [{ ex: 'upbit', sym: 'NIL', kind: '마켓추가', network: 'Ethereum', notice_ts: iso(-86_400_000), open_ts: iso(-86_000_000), hedge_perp: '가능', m10: -0.08, m30: 1.5 }] },
    market: { btc: { v: -5, px: 77252.96 }, alt: { v: -6.479, n: 679 }, kimp: { v: 0.0008, n: 198 }, pulse_age_s: 30, blocked: null, blocked_n: { upbit: 42, bithumb: 57 } },
    peg: { bank: 1338.04, upbit_usdt: 1345, age_s: 10, tprem: 0.52 },
    halts: [],
    flows: { ok: true, kol_ok: true, kol_age_s: 42, persons24: 74, usd24: 49_980_429, feed: Array.from({ length: 10 }, (_, i) => ({ t: iso(-60_000 * (i + 1)), kind: i === 0 ? 'team' : 'kol', who: `who${i}`, sym: 'ONDO', usd: 19_953 * (i + 1), venue: 'upbit', kr: true })), coins: [{ sym: 'ENA', persons: 8, usd: 1_671_494 }], deposits_hidden_n: 34, deposits_min_usd: 50_000 },
    score: { ok: true, age_s: 37, rows: [{ sig: 'captive', name: '가두리', hit: 6, scored: 7, hit_pct: 85.7, med_usd_1k: 81.6, verdict: '된다', policy: 'send' }, { sig: 'x', name: '크라임 (crime)', hit: 1, scored: 2, hit_pct: 50, med_usd_1k: -3, verdict: '대부분 허수', policy: 'ledger_only' }] },
    today: { real: [{ t: iso(-1_000_000), sym: 'KERNEL', route: 'kr_gap', net1k: 17.18, why: '이체 도착 후에도 순 +1.72%' }], armed_n: 0, day_start: iso(-36_000_000) },
    band: { t0: iso(-36_000_000), t1: iso(7_200_000), now: iso(0), bin_s: 600, bins: Array.from({ length: 60 }, (_, i) => ({ t: iso(-36_000_000 + 600_000 * i), max: 0.5 + (i % 4) * 0.3, sym: '0G', buy: 'bithumb', sell: 'upbit' })), bins_age_s: 54 },
    tabs: TABS,
    ...over,
  };
}
const empty = (): NexusHomeData => fixture({ actions: [], near: [], ops: [], listing: { ok: true, age_s: 30, n_seen: 0, upcoming: 0, pending: 0, recent: [] }, flows: { ok: true, kol_ok: true, kol_age_s: 1, persons24: null, usd24: null, feed: [], coins: [], deposits_hidden_n: 0, deposits_min_usd: null }, score: { ok: true, age_s: 1, rows: [] }, today: { real: [], armed_n: 0, day_start: null }, band: { t0: iso(-36_000_000), t1: iso(7_200_000), now: iso(0), bin_s: 600, bins: [], bins_age_s: null } });

afterEach(cleanup);

describe('NexusHome', () => {
  it('shows the tab strip: 지금 active, the other four as outside links in a new tab', () => {
    render(<NexusHome home={fixture()} now={T} />);
    const nav = screen.getByRole('navigation', { name: 'NEXUS 탭' });
    expect(nav.querySelector('.nx-tab.on')!.textContent).toBe('지금');
    const links = nav.querySelectorAll('a');
    expect([...links].map((a) => [a.textContent!.trim(), a.getAttribute('href')])).toEqual([['상장', `${DASH}/listing`], ['갭', `${DASH}/arb`], ['지갑', `${DASH}/coins`], ['더보기', `${DASH}/alerts`]]);
    for (const a of links) { expect(a.getAttribute('target')).toBe('_blank'); expect(a.getAttribute('rel')).toBe('noopener noreferrer'); }
    expect(screen.getByTestId('nexus-home').textContent).toContain('데이터 20초 전');
  });
  it('has no hero answer block, only the one-line 시장 summary; and never a button', () => {
    const { container } = render(<NexusHome home={fixture()} now={T} />);
    expect(container.textContent).not.toContain('지금 바로 돈 되는 것');
    expect(container.textContent).not.toContain('다음 기회');
    expect(container.querySelector('h1')).toBeNull();
    const mk = screen.getByTestId('nx-market').textContent!;
    expect(mk).toContain('BTC$77,253');
    expect(mk).toContain('−5.0% 24h');
    expect(mk).toContain('알트 679종−6.5%');
    expect(mk).toContain('테더김프+0.52%');
    expect(mk).toContain('업비트 ₩1,345 ÷ 은행 ₩1,338');
    expect(mk).toContain('입출금 중단없음');
    expect(mk).toContain('막힘업비트 42 · 빗썸 57');
    expect(mk).toContain('24h 최고PUNDIX 쿠코인→업비트 +15.28%');
    expect(mk).toContain('+0.12% CRO');
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.querySelectorAll('input, select, textarea, form').length).toBe(0);
    expect(container.textContent).not.toMatch(/journalctl|systemctl/);
  });
  it('renders 할 일 cards by tone with action, nums chips, detail and an outside link; 고칠 것 and 근접 folded', () => {
    const { container } = render(<NexusHome home={fixture()} now={T} />);
    const todo = screen.getByTestId('nx-todo');
    const open = todo.querySelectorAll('.nx-cards:not(details .nx-cards) > .nx-card');
    expect([...open].map((c) => c.className)).toEqual(['nx-card t-warn', 'nx-card t-info']);
    expect(open[0]!.textContent).toContain('FET 팀 지갑 → 바이낸스');
    expect(open[0]!.textContent).toContain('→ 물량 확인');
    expect(open[0]!.querySelectorAll('.nx-nums span').length).toBe(2);
    expect(open[0]!.querySelector('.nx-badge')!.className).toContain('warn');
    const link = open[0]!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(`${DASH}/crime?sym=FET`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(open[1]!.querySelector('a')).toBeNull();
    const folds = todo.querySelectorAll('details.nx-fold');
    expect(folds.length).toBe(2);
    expect(folds[0]!.hasAttribute('open')).toBe(false);
    expect(folds[0]!.querySelector('summary')!.textContent).toContain('고칠 것 1');
    expect(folds[0]!.querySelector('.nx-card')!.className).toBe('nx-card t-bad');
    expect(folds[0]!.textContent).toContain('PAPER observer');
    expect(folds[1]!.querySelector('summary')!.textContent).toContain('근접 1');
    expect(folds[1]!.textContent).toContain('ELF HTX→게이트');
    expect(todo.querySelector('.nx-funnel')!.textContent).toBe('전체197→경로142→식별9→깊이10→순익36→통과0');
    expect(container.textContent).not.toContain('⋯');
  });
  it('draws the 12-hour band: one bar per bin, bar height from max, the now marker and the day list', () => {
    render(<NexusHome home={fixture()} now={T} />);
    const band = screen.getByTestId('nx-band');
    const bins = band.querySelectorAll('.nx-bin');
    expect(bins.length).toBe(60);
    expect((bins[0] as HTMLElement).style.left).toBe('0%');
    expect((bins[0] as HTMLElement).style.height).toBe('36%'); // 0.5 of max 1.4
    expect((bins[3] as HTMLElement).style.height).toBe('100%');
    expect(bins[0]!.getAttribute('title')).toBe('12:00 0G 빗썸→업비트 최대 +0.50%');
    const now = band.querySelector('.nx-now') as HTMLElement;
    expect(now.style.left).toBe('83.33333333333334%');
    expect(now.textContent).toBe('지금 22:00');
    expect(band.querySelectorAll('.nx-miss').length).toBe(1);
    expect(band.textContent).toContain('국내갭 10분 칸 60개 · 최대 +1.40% (수수료 전) · 놓침 1');
    expect(band.querySelector('.nx-list')!.textContent).toContain('21:43KERNEL국내갭$1k당 +$17이체 도착 후에도 순 +1.72%');
    expect([...band.querySelectorAll('.nx-axis span')].map((s) => s.textContent)).toEqual(['12:00', '14:00', '16:00', '18:00', '20:00', '22:00', '00:00']);
  });
  it('renders 상장, 지갑 흐름 and 신호 성적표 as tables, 운영 메모 as a list without buttons', () => {
    render(<NexusHome home={fixture()} now={T} />);
    const lst = screen.getByTestId('nx-listing');
    expect(lst.querySelector('tbody tr')!.textContent).toBe('업비트NIL마켓추가Ethereum어제 22:00어제 22:06가능−0.08%+1.50%');
    expect(lst.textContent).toContain('공지 311건 감시 · 예정 0 · 미정 0 · 30초 전 확인');
    const fl = screen.getByTestId('nx-flows');
    expect(fl.querySelectorAll('table')[0]!.querySelectorAll('tbody tr').length).toBe(8);
    expect(fl.querySelector('tbody tr')!.textContent).toBe('21:59팀who0ONDO$20K업비트국내1분 전');
    expect(fl.querySelector('details summary')!.textContent).toContain('나머지 2건');
    expect(fl.textContent).toContain('12시간 10건 · 24h KOL 74명 $50M');
    expect(fl.textContent).toContain('ENA 8명 $1.7M');
    expect(fl.textContent).toContain('입금 34건 숨김 (< $50K)');
    const sc = screen.getByTestId('nx-score');
    const rows = sc.querySelectorAll('tbody tr');
    expect(rows[0]!.textContent).toBe('가두리 captive6786%+$82된다send');
    expect(rows[1]!.textContent).toBe('크라임 x1250%−$3.0대부분 허수기록만');
    expect(rows[0]!.querySelector('td:nth-child(6)')!.className).toBe('st-ok');
    expect(rows[1]!.querySelector('td:nth-child(6)')!.className).toBe('st-bad');
    const ops = screen.getByTestId('nx-ops');
    const items = ops.querySelectorAll('li');
    expect(items.length).toBe(2);
    expect(items[0]!.className).toBe('bad');
    expect(items[0]!.textContent).toContain('고장x.service 실패');
    expect(items[0]!.textContent).toContain('21:55 · 5분 전');
    expect(items[0]!.querySelector('a')!.getAttribute('href')).toBe(`${DASH}/sys`);
    expect(items[1]!.className).toBe('info');
    expect(ops.querySelectorAll('button').length).toBe(0);
    expect(ops.textContent).not.toMatch(/고쳤음|안 씀/);
  });
  it('says 없음 for every empty list and keeps the layout', () => {
    const { container } = render(<NexusHome home={empty()} now={T} />);
    expect(screen.getByTestId('nx-todo').textContent).toContain('남은 할 일 없음');
    expect(screen.getByTestId('nx-todo').querySelectorAll('details').length).toBe(0);
    expect(screen.getByTestId('nx-band').textContent).toContain('국내갭 기록 없음');
    expect(screen.getByTestId('nx-band').textContent).toContain("오늘 '진짜'로 채점된 따리 없음");
    expect(screen.getByTestId('nx-listing').querySelector('tbody td.nx-none')!.textContent).toBe('없음');
    expect(screen.getByTestId('nx-flows').querySelector('tbody td.nx-none')!.textContent).toContain('없음');
    expect(screen.getByTestId('nx-flows').textContent).toContain('물리는 코인 없음');
    expect(screen.getByTestId('nx-score').querySelector('tbody td.nx-none')!.textContent).toBe('없음');
    expect(screen.getByTestId('nx-ops').textContent).toContain('없음');
    expect(container.querySelectorAll('button').length).toBe(0);
  });
  it('marks late data and stale sources', () => {
    const { container } = render(<NexusHome home={fixture({ late: true, late_what: ['inbox'], head: { armed_n: 1, kill: true, gap_age_s: null, failed_nexus: 0, failed_all: 0 }, market: { ...fixture().market, pulse_age_s: 900 }, kr: { ok: true, age_s: 1200, fresh: false, min_net: 5, best_net: null, best_sym: null }, band: { ...fixture().band, bins_age_s: 1800 } })} now={T} />);
    const top = container.querySelector('.nx-top')!;
    expect(top.querySelector('.hub-st.warn')!.textContent).toContain('지연');
    expect(top.textContent).toContain('inbox 불러오는 중');
    expect(top.querySelector('.hub-st.bad')!.textContent).toContain('KILL');
    expect(screen.getByTestId('nx-market').textContent).toContain('멈춤 15분 전');
    expect(screen.getByTestId('nx-market').textContent).toContain('자료 낡음 20분 전');
    expect(screen.getByTestId('nx-band').textContent).toContain('스캔 멈춤 30분 전');
  });
});

describe('formatting helpers', () => {
  it('kstDay / ageOf / sgn / usd', () => {
    expect(kstDay(iso(0), T)).toBe('22:00');
    expect(kstDay(iso(-86_400_000), T)).toBe('어제 22:00');
    expect(kstDay(iso(86_400_000), T)).toBe('내일 22:00');
    expect(kstDay(iso(-3 * 86_400_000), T)).toBe('27/10 22:00');
    expect(kstDay(null, T)).toBe('—');
    expect(ageOf(iso(-5_000), T)).toBe('5초 전');
    expect(ageOf(iso(-120_000), T)).toBe('2분 전');
    expect(ageOf(null, T)).toBe('시각 모름');
    expect(sgn(1.234)).toBe('+1.23%'); expect(sgn(-0.5, 1)).toBe('−0.5%'); expect(sgn(0)).toBe('0.00%'); expect(sgn(null)).toBe('—');
    expect(usd(49_980_429)).toBe('$50M'); expect(usd(4_980_429)).toBe('$5.0M'); expect(usd(1_671_494)).toBe('$1.7M'); expect(usd(19_953)).toBe('$20K'); expect(usd(1_500)).toBe('$1.5K'); expect(usd(563.6)).toBe('$564'); expect(usd(3.5)).toBe('$3.50'); expect(usd(null)).toBe('—');
  });
});
