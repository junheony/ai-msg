// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HubSection } from '../../shared/hub-types';
import { SectionView, sectionCount } from './HubPage';
import { axis, tick } from './HubSections';

afterEach(cleanup);

const sec = (s: HubSection) => render(<SectionView s={s} name="테스트" />);

describe('cards', () => {
  it('renders a card per item: title, badge, state pill, rows with status colours, spark, note and links', () => {
    sec({ kind: 'cards', title: '계정', open: true, cols: 3, items: [
      { title: '빗썸1', badge: '빗썸 현물', state: 'ok', sub: 'SEED 15.5억 → 21.5억', rows: [{ label: '7일 순익', value: '+6.16M', status: 'ok' }, { label: '어제', value: '−0.2M', status: 'bad' }], spark: { values: [1, 2, null, 4], label: '자본', unit: '억' }, note: '원가 기준', links: [{ label: '원본', href: 'http://x/' }] },
      { title: '빗썸2', rows: [] },
    ] });
    const cards = screen.getByTestId('hub-sec-cards');
    expect(cards.querySelector('.cnt')!.textContent).toBe('2');
    const items = cards.querySelectorAll('.hs-card');
    expect(items.length).toBe(2);
    expect(items[0]!.className).toContain('ok');
    expect(items[0]!.querySelector('.hs-badge')!.textContent).toBe('빗썸 현물');
    expect(items[0]!.querySelector('.hub-st')!.textContent).toBe('정상');
    expect(items[0]!.querySelectorAll('dd')[1]!.className).toBe('bad');
    expect(items[0]!.querySelector('.hs-spark path')!.getAttribute('d')).toMatch(/^M/);
    expect(items[0]!.querySelector('.hs-spark-l b')!.textContent).toBe('4억');
    expect(items[0]!.querySelector('.hs-card-note')!.textContent).toBe('원가 기준');
    const a = items[0]!.querySelector('.hs-card-links a') as HTMLAnchorElement;
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
    expect(items[1]!.querySelector('.hub-st')).toBeNull();
    expect(cards.querySelector('.hs-cards')!.className).toContain('cols3');
  });
  it('says so when empty', () => {
    sec({ kind: 'cards', title: '계정', open: true, items: [] });
    expect(screen.getByText('항목 없음')).toBeTruthy();
  });
});

describe('chart', () => {
  it('draws one path per line series, bars for bar series, the zero line, and reads the newest value in the legend', () => {
    sec({ kind: 'chart', title: '일별', open: true, x: ['10-01', '10-02', '10-03'], unit: 'bp', zero: true, series: [
      { name: 'BNB', values: [10, -5, 20], style: 'bar', color: 'ok' },
      { name: '누적', values: [10, 5, 25] },
    ] });
    const c = screen.getByTestId('hub-chart');
    expect(c.querySelectorAll('rect').length).toBe(3);
    expect(c.querySelectorAll('path').length).toBe(1);
    expect(c.querySelectorAll('.hs-zero').length).toBe(1);
    const legs = c.querySelectorAll('.hs-leg b');
    expect(legs[0]!.textContent).toBe('20bp');
    expect(legs[1]!.textContent).toBe('25bp');
    expect(c.querySelector('.hs-leg.at')!.textContent).toBe('10-03');
    // The x labels include the newest one; the y ticks are nice numbers.
    const xs = Array.from(c.querySelectorAll('text.x')).map((t) => t.textContent);
    expect(xs).toContain('10-03');
  });
  it('a null gap breaks the line and an all-empty chart says 자료 없음; a collapsed chart is not drawn', () => {
    sec({ kind: 'chart', title: 'g', open: true, x: ['a', 'b', 'c'], series: [{ name: 's', values: [1, null, 3] }] });
    expect(screen.getByTestId('hub-chart').querySelector('path')!.getAttribute('d')!.split('M').length - 1).toBe(2);
    cleanup();
    sec({ kind: 'chart', title: 'g', open: true, x: [], series: [] });
    expect(screen.getByText('자료 없음')).toBeTruthy();
    cleanup();
    sec({ kind: 'chart', title: 'g', x: ['a'], series: [{ name: 's', values: [1] }] });
    expect(screen.queryByTestId('hub-chart')).toBeNull();
    fireEvent.click(screen.getByText('g'));
    expect(screen.queryByTestId('hub-chart')).not.toBeNull();
  });
  it('axis and tick helpers', () => {
    expect(axis(0, 100, false).ticks).toEqual([0, 25, 50, 75, 100]);
    expect(axis(5, 12, true).lo).toBe(0);
    expect(axis(7, 7, false).hi).toBeGreaterThan(7);
    expect(tick(1_550_776_466)).toBe('1.55B');
    expect(tick(-6_160_000)).toBe('−6.16M');
    expect(tick(3.456)).toBe('3.46');
    expect(tick(0)).toBe('0');
  });
});

describe('steps', () => {
  it('counts done/total in the header and marks each state in Korean', () => {
    sec({ kind: 'steps', title: '파이프라인', open: true, items: [
      { label: '대본', state: 'done' }, { label: '콘티', state: 'done' }, { label: '나레이션', state: 'blocked', hint: 'Typecast 키 필요' }, { label: '업로드', state: 'todo' },
    ] });
    const s = screen.getByTestId('hub-sec-steps');
    expect(s.querySelector('.cnt')!.textContent).toBe('2/4');
    const li = s.querySelectorAll('li');
    expect(li[0]!.className).toBe('done');
    expect(li[0]!.querySelector('.hs-step-s')!.textContent).toBe('완료');
    expect(li[2]!.querySelector('.hs-step-s')!.textContent).toBe('차단');
    expect(li[2]!.querySelector('.hs-step-h')!.textContent).toBe('Typecast 키 필요');
    expect(li[3]!.querySelector('.hs-step-s')!.textContent).toBe('대기');
    expect(sectionCount({ kind: 'steps', title: 'x', items: [] })).toBe('0/0');
  });
});

describe('images', () => {
  it('thumbnails link out in a new tab, an mp4 becomes an inline video, a playable build a link; nothing loads while collapsed', () => {
    sec({ kind: 'images', title: '렌더', open: true, items: [
      { src: '/api/hub/file/video/episodes/e1/renders/poster.png', label: '포스터' },
      { src: '/api/hub/file/video/episodes/e1/renders/draft.mp4', label: '초안 90초' },
      { src: '/api/hub/file/game/neon-apex/dist/index.html', label: '플레이', kind: 'html' },
    ] });
    const im = screen.getByTestId('hub-sec-images');
    expect(im.querySelector('.cnt')!.textContent).toBe('3');
    const img = im.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('poster.png');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect((img.closest('a') as HTMLAnchorElement).target).toBe('_blank');
    const video = im.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toContain('draft.mp4');
    expect(video.getAttribute('preload')).toBe('metadata');
    const play = im.querySelector('.hs-play') as HTMLAnchorElement;
    expect(play.getAttribute('href')).toContain('index.html');
    expect(play.rel).toContain('noopener');
    cleanup();
    sec({ kind: 'images', title: '렌더', items: [{ src: '/x.png', label: 'x' }] });
    expect(screen.getByTestId('hub-sec-images').querySelector('img')).toBeNull();
  });
});

describe('kvgrid and wrapped tables', () => {
  it('kvgrid keeps label, meaning, number and sub in four cells; status colours the row', () => {
    sec({ kind: 'kvgrid', title: '비용 버킷', open: true, rows: [
      { label: '거래소 수수료', desc: '체결 수수료 합계', value: '$12.30', sub: '1.2 bp', status: 'bad' },
      { label: '펀딩', value: '$0.00' },
    ] });
    const g = screen.getByTestId('hub-sec-kvgrid');
    expect(g.querySelector('.cnt')!.textContent).toBe('2');
    const rows = g.querySelectorAll('.hs-kvrow');
    expect(rows[0]!.className).toContain('bad');
    expect(rows[0]!.querySelector('.hs-kv-l')!.textContent).toBe('거래소 수수료');
    expect(rows[0]!.querySelector('.hs-kv-d')!.textContent).toBe('체결 수수료 합계');
    expect(rows[0]!.querySelector('.hs-kv-v')!.textContent).toBe('$12.30');
    expect(rows[0]!.querySelector('.hs-kv-s')!.textContent).toBe('1.2 bp');
    expect(rows[1]!.querySelector('.hs-kv-d')!.textContent).toBe('');
  });
  it('a table marks wrap columns so long reasons wrap instead of scrolling', () => {
    sec({ kind: 'table', title: '레인', open: true, columns: ['마켓', '이유'], wrap: [1], rows: [['XAU', '긴 이유 '.repeat(20)]] });
    const t = screen.getByTestId('hub-sec-table');
    expect(t.querySelectorAll('th')[1]!.className).toBe('w');
    expect(t.querySelectorAll('td')[1]!.className).toBe('w');
    expect(t.querySelectorAll('td')[0]!.className).toBe('');
  });
});
