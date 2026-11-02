import { useState } from 'react';
import type { YappingDaily } from '../../shared/hub-types';
import { yappingDailyWindow } from '../../shared/yapping';

const number = (value: number | null) => value === null ? '기록 없음' : value.toLocaleString('ko-KR');
const compact = (value: number) => value.toLocaleString('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });
const WIDTH = 600;
const TRACK = 72;
const HEIGHT = 48;

export function YappingDailyChart({ daily, now }: { daily?: YappingDaily; now: number }) {
  const rows = yappingDailyWindow(daily?.rows ?? [], now);
  const [selected, setSelected] = useState<string | null>(null);
  // The default window always contains 30 calendar slots, including missing days.
  const active = rows.find(row => row.date === selected) ?? rows[29]!;
  const observed = rows.some(row => row.views !== null || row.followers !== null);
  const maxViews = Math.max(1, ...rows.map(row => row.views ?? 0));
  const maxPosts = Math.max(1, ...rows.map(row => row.posts ?? 0));
  const followers = rows.flatMap(row => row.followers === null ? [] : [row.followers]);
  const minFollowers = followers.length ? Math.max(0, Math.min(...followers) - 1) : 0;
  const maxFollowers = followers.length ? Math.max(...followers) + 1 : 1;
  const step = WIDTH / rows.length;
  const x = (index: number) => step * (index + .5);
  const followerY = (value: number) => TRACK * 2 + 8 + HEIGHT * (1 - (value - minFollowers) / (maxFollowers - minFollowers));
  // Calendar slots include missing days, so no path bridges an absent observation.
  const segments: string[] = [];
  let segment = '';
  rows.forEach((row, index) => {
    if (row.followers === null) { if (segment) segments.push(segment); segment = ''; return; }
    segment += `${segment ? ' L' : 'M'}${x(index)} ${followerY(row.followers)}`;
  });
  if (segment) segments.push(segment);
  const description = (row: typeof rows[number]) => `${row.date} KST · 조회 ${number(row.views)}${row.views === null ? '' : '회'} · 게시 ${number(row.posts)}${row.posts === null ? '' : '건'} · 팔로워 ${number(row.followers)}${row.followers === null ? '' : '명'}`;
  const tracks = [
    { key: 'views', label: '조회수', unit: '회', min: 0, max: maxViews },
    { key: 'posts', label: '게시물', unit: '건', min: 0, max: maxPosts },
    { key: 'followers', label: '팔로워', unit: '명', min: minFollowers, max: maxFollowers },
  ];
  return <section className="yp-daily" aria-label="최근 30일 성장 기록" data-testid="yapping-daily-chart">
    <div className="yp-section-head"><h3>최근 30일</h3><span>KST 기준 · 오늘 집계 중</span></div>
    <p className="yp-daily-note">조회수·게시물은 해당 날짜의 원본 게시물만 집계 (답글·재게시 제외)</p>
    {observed ? <>
      <div className="yp-daily-chart">
        <div className="yp-daily-scales">{tracks.map(track => <div className={`yp-daily-scale yp-series-${track.key}`} key={track.key}><strong>{track.label}<span> ({track.unit})</span></strong><span>{compact(track.min)} – {compact(track.max)}</span></div>)}</div>
        <svg className="yp-daily-svg" viewBox={`0 0 ${WIDTH} ${TRACK * 3}`} preserveAspectRatio="none" role="group" aria-label="일별 조회수와 게시물 막대, 팔로워 선 그래프">
          {tracks.map((track, index) => <g key={track.key} className="yp-daily-grid"><line x1={0} x2={WIDTH} y1={index * TRACK + 8} y2={index * TRACK + 8} /><line x1={0} x2={WIDTH} y1={index * TRACK + 8 + HEIGHT} y2={index * TRACK + 8 + HEIGHT} /></g>)}
          {segments.map((path, index) => <path key={index} d={path} data-series="followers" className="yp-daily-followers" vectorEffect="non-scaling-stroke" />)}
          {rows.map((row, index) => <g key={row.date} data-day={row.date} data-views={String(row.views)} data-posts={String(row.posts)} data-followers={String(row.followers)} role="button" tabIndex={0} aria-label={description(row)} aria-pressed={active.date === row.date} className="yp-daily-day" onFocus={() => setSelected(row.date)} onMouseEnter={() => setSelected(row.date)} onClick={() => setSelected(row.date)} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(row.date); }
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const sibling = event.key === 'ArrowRight' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling; if (sibling?.hasAttribute('data-day')) (sibling as SVGGElement).focus(); }
          }}>
            <title>{description(row)}</title>
            <rect className="yp-daily-hit" x={step * index} y={0} width={step} height={TRACK * 3} />
            {row.views !== null && <rect data-series="views" className="yp-daily-views" x={x(index) - step * .3} y={8 + HEIGHT * (1 - row.views / maxViews)} width={step * .6} height={HEIGHT * row.views / maxViews} />}
            {row.posts !== null && <rect data-series="posts" className="yp-daily-posts" x={x(index) - step * .3} y={TRACK + 8 + HEIGHT * (1 - row.posts / maxPosts)} width={step * .6} height={HEIGHT * row.posts / maxPosts} />}
            {row.followers !== null && <circle data-series="followers" className="yp-daily-point" cx={x(index)} cy={followerY(row.followers)} r={2} />}
          </g>)}
        </svg>
        <div className="yp-daily-dates">{rows.filter((_, index) => [0, 9, 19, 29].includes(index)).map(row => <span key={row.date}>{row.date.slice(5).replace('-', '/')}</span>)}</div>
      </div>
      <p className="yp-daily-readout" aria-live="polite" aria-atomic="true">{description(active)}</p>
    </> : <p className="yp-empty" role="status">데이터 없음 · {daily?.reason || '일별 성장 기록 없음'}</p>}
    <p className="yp-daily-note yp-daily-retention">팔로워 기록은 14일치</p>
  </section>;
}
