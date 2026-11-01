// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HubMode } from '../../shared/hub-types';
import { YappingHome } from './YappingHome';
import { risingFixture } from '../../../tests/fixtures/yapping-rising';
import { parseRising } from '../../server/hub/yapping-rising';
import { dailyFixture } from '../../../tests/fixtures/yapping-daily';
import { YappingDailyChart } from './YappingDailyChart';
afterEach(cleanup);
function mode(): HubMode { return { id: 'yapping', name: '야핑봇', state: 'warn', lastActivity: null, metrics: {}, links: [], alerts: [{ level: 'warn', text: '/api/status 응답 없음 · 시간 초과' }], sources: Array.from({ length: 7 }, (_, i) => ({ name: `/api/${i}`, ok: i === 6, ms: 3000, ...(i === 6 ? {} : { error: '시간 초과' }) })), page: { headline: '', decision: '', kpis: [{ label: '속보', value: '5 / 5', hint: '마지막 정상 11-02 01:50' }, { label: '조회수 변화', value: '데이터 없음', hint: '과거 관측값 없음' }], sections: [{ kind: 'table', title: 'X 최근 게시', rows: [['2026-11-01T15:00:00Z', '게시 제목', 'https://x.com/cblabx/status/123']], columns: [] }, { kind: 'table', title: 'Telegram 미러', rows: [['2026-11-01T15:00:00Z', '미러 제목', 'https://t.me/blockschool/123']], columns: [] }] } }; }
describe('YappingHome', () => {
  it('renders 30 calendar slots with independent bars and only observed follower points', () => {
    const m = mode(); m.daily = { rows: dailyFixture(), reason: null };
    m.page!.kpis.push({ label: '팔로워 변화', value: '+5명', hint: '오늘 − 어제 · 7일 전 대비 +29명' });
    m.page!.kpis[1] = { label: '조회수 변화', value: '+892회', hint: '오늘 − 어제 · 7일 전 대비 +262회' };
    const { container } = render(<YappingHome mode={m} now={Date.parse('2026-11-01T17:00:00Z')} />);
    const chart = screen.getByTestId('yapping-daily-chart');
    expect(chart.querySelectorAll('[data-day]')).toHaveLength(30);
    expect(chart.querySelectorAll('rect[data-series="views"]')).toHaveLength(30);
    expect(chart.querySelectorAll('rect[data-series="posts"]')).toHaveLength(30);
    expect(chart.querySelectorAll('circle[data-series="followers"]')).toHaveLength(14);
    expect(chart.querySelectorAll('path[data-series="followers"]')).toHaveLength(1);
    expect(chart.querySelector('[data-day="2026-10-04"]')?.getAttribute('data-followers')).toBe('null');
    expect(chart.querySelector('[data-day="2026-10-04"] rect[data-series="views"]')?.getAttribute('height')).toBe('0');
    expect(chart.textContent).toContain('팔로워 기록은 14일치');
    expect(chart.textContent).toContain('오늘 집계 중');
    expect(chart.textContent).toContain('답글·재게시 제외');
    expect(container.querySelector('[data-metric="followers"]')?.textContent).toContain('+5명오늘 − 어제 · 7일 전 대비 +29명');
    expect(container.querySelector('[data-metric="views"]')?.textContent).toContain('+892회오늘 − 어제 · 7일 전 대비 +262회');
    const oldDay = chart.querySelector('[data-day="2026-10-04"]')!;
    fireEvent.focus(oldDay);
    expect(chart.querySelector('.yp-daily-readout')?.textContent).toBe('2026-10-04 KST · 조회 0회 · 게시 0건 · 팔로워 기록 없음');
    expect(oldDay.getAttribute('aria-pressed')).toBe('true');
  });
  it('breaks follower lines on nulls and missing dates without converting gaps into zero', () => {
    const rows = dailyFixture();
    rows[19]!.followers = null;
    rows.splice(24, 1);
    const { container } = render(<YappingDailyChart daily={{ rows, reason: null }} now={Date.parse('2026-11-02T00:00:00Z')} />);
    expect(container.querySelectorAll('[data-day]')).toHaveLength(30);
    expect(container.querySelectorAll('path[data-series="followers"]')).toHaveLength(3);
    expect(container.querySelector('[data-day="2026-10-28"]')?.getAttribute('data-views')).toBe('null');
    expect(container.querySelector('[data-day="2026-10-28"] rect[data-series="views"]')).toBeNull();
    expect(container.querySelector('[data-day="2026-10-23"] circle')).toBeNull();
    const paths = [...container.querySelectorAll('path')].map(path => path.getAttribute('d'));
    expect(paths.every(path => path?.startsWith('M') && !path.includes('NaN'))).toBe(true);
  });
  it('keeps the new KST day empty and handles all-null follower history', () => {
    const rows = dailyFixture().map(row => ({ ...row, followers: null }));
    const { container } = render(<YappingDailyChart daily={{ rows, reason: null }} now={Date.parse('2026-11-02T15:00:00Z')} />);
    expect(container.querySelector('[data-day="2026-11-03"]')?.getAttribute('data-views')).toBe('null');
    expect(container.querySelector('[data-day="2026-10-04"]')).toBeNull();
    expect(container.querySelectorAll('path[data-series="followers"]')).toHaveLength(0);
    expect(container.querySelectorAll('rect[data-series="views"]')).toHaveLength(29);
    expect(container.querySelector('.yp-daily-readout')?.textContent).toContain('2026-11-03 KST · 조회 기록 없음');
  });
  it('shows a scoped daily error while existing recent posts remain available', () => {
    const m = mode(); m.daily = { rows: [], reason: '시간 초과' };
    render(<YappingHome mode={m} now={Date.parse('2026-11-02T00:00:00Z')} />);
    expect(screen.getByTestId('yapping-daily-chart').querySelector('.yp-empty')?.textContent).toBe('데이터 없음 · 시간 초과');
    expect(screen.getByRole('link', { name: /게시 제목/ })).toBeTruthy();
  });
  it('shows all ten fixture rankings, topic chips, velocity, age and safe post links', () => {
    const m = mode(); m.rising = parseRising(risingFixture());
    const { container } = render(<YappingHome mode={m} now={Date.now()} />);
    const card = screen.getByRole('region', { name: 'Rising' });
    expect(card.querySelectorAll('li')).toHaveLength(10);
    expect(card.textContent).toContain('12,000.5 조회/시간');
    expect(card.textContent).toContain('게시 0.3시간 경과');
    expect(card.querySelector('.yp-rising-topic')?.textContent).toBe('AI');
    const links = [...card.querySelectorAll('a')];
    expect(links[0]?.href).toBe('https://x.com/fixture_1/status/900001');
    expect(links.every(link => link.rel === 'noopener noreferrer' && link.target === '_blank')).toBe(true);
    expect(container.querySelector('.yp-cap')?.textContent).toContain('5 / 5');
  });
  it('shows a muted reason on failure without suppressing local stats', () => {
    const m = mode(); m.rising = { generatedAt: null, windowH: null, items: [], reason: '시간 초과' };
    render(<YappingHome mode={m} now={Date.now()} />);
    expect(screen.getByRole('region', { name: 'Rising' }).querySelector('.yp-empty')?.textContent).toBe('데이터 없음 · 시간 초과');
    expect(screen.getByRole('link', { name: /게시 제목/ })).toBeTruthy();
  });
  it('shows usable caps and explicit missing reasons, marks last-good data grey', () => {
    const { container } = render(<YappingHome mode={mode()} now={Date.parse('2026-11-01T17:00:00Z')} />);
    expect(screen.getByRole('heading', { name: '@cblabx 자동 성장' })).toBeTruthy();
    expect(container.querySelector('.yp-cap.yp-stale')?.textContent).toContain('마지막 정상');
    expect(screen.getByText('과거 관측값 없음')).toBeTruthy();
    expect(container.textContent).not.toContain('—/—');
    expect(container.textContent).not.toContain('09:30');
    expect(container.querySelector('.yp-growth-item.yp-missing')).toBeTruthy();
  });
  it('puts all source failures behind one collapsed source summary and opens external posts safely', () => {
    const { container } = render(<YappingHome mode={mode()} now={Date.now()} />);
    const panel = container.querySelector('details')!;
    expect(panel.open).toBe(false);
    expect(panel.querySelector('summary')?.textContent).toBe('소스 상태야핑봇 API 응답 느림 (6/7)');
    expect(container.querySelector('.yp-alert')).toBeNull();
    const link = screen.getByRole('link', { name: /게시 제목/ });
    expect(link.getAttribute('href')).toBe('https://x.com/cblabx/status/123');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
