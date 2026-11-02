// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HubMode } from '../../shared/hub-types';
import { CH1, CHANNELS, DIST, HISTORY, HOME, LEDGER, NOW, NO_PROBES, PLACEHOLDER, PROBES_OK, STATUS } from '../../server/hub/__fixtures__/shorts';
import { buildShortsView } from '../../server/hub/shorts';
import { hubStatusFixture } from './__fixtures__/status';
import { HubPage } from './HubPage';
import { kst, ShortsFactoryHome, VIDEO_PROJECT_KEY } from './ShortsFactoryHome';

vi.mock('./sr/SrPanel', () => ({ SrPanel: () => <section data-testid="sr-panel" /> }));

const j = (v: unknown) => JSON.stringify(v);
/** The same builder the server uses, so the UI sees exactly the payload the collector ships. */
const FULL = buildShortsView({ status: j(STATUS), channels: j(CHANNELS), history: HISTORY, probes: PROBES_OK, probeNote: null }, NOW);
const EMPTY = buildShortsView({ status: null, channels: null, history: null, probes: NO_PROBES, probeNote: '호스트 점검(df · claude-pick · codex) 진행 중' }, NOW);
const LEDGERED = buildShortsView({ status: j(STATUS), channels: j(CHANNELS), history: HISTORY, ledger: j(LEDGER), probes: PROBES_OK, probeNote: null }, NOW);
const BOOT = buildShortsView({ status: j(PLACEHOLDER), channels: j(CHANNELS), history: null, probes: PROBES_OK, probeNote: null }, NOW);
const video = (shorts?: HubMode['shorts']): HubMode => ({ ...hubStatusFixture(NOW).modes.find((m) => m.id === 'video')!, ...(shorts ? { shorts } : {}) });
const page = (mode: HubMode) => render(<HubPage modeKey="video" mode={mode} now={NOW} error={null} loading={false} onRefresh={() => {}} generatedAt={new Date(NOW).toISOString()} />);
const txt = (el: Element | null): string => el?.textContent ?? '';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('header while Shorts 공장 is selected', () => {
  it('shows the factory state, file freshness and the three files as sources instead of engineering-shorts', () => {
    localStorage.setItem(VIDEO_PROJECT_KEY, 'factory');
    const mode = video(FULL);
    page({ ...mode, state: 'down', lastActivity: '2026-09-01T00:00:00.000Z', tag: 'studio-tag', sources: [{ name: 'studio-src', ok: false, ms: 0, error: 'x' }] });
    const header = screen.getByTestId('hub-mode-video').querySelector('header.ph')!;
    expect(txt(header)).toContain('Shorts 공장');
    expect(txt(header)).not.toContain('studio-tag');
    expect(txt(header)).not.toContain('studio-src');
    expect(txt(header)).toContain('파일 갱신');
    expect(txt(header)).not.toContain('61일 전');
    expect(within(screen.getByTestId('hub-sources')).getAllByText(/\.json|\.jsonl/).map((e) => e.textContent)).toEqual(['status.json', 'channels.json', 'history.jsonl']);
    cleanup();
    page({ ...video(EMPTY), state: 'ok' });
    const h2 = screen.getByTestId('hub-mode-video').querySelector('header.ph')!;
    expect(txt(h2)).toContain('status.json');
    expect(txt(h2)).toContain('없음');
  });
});

describe('영상 project tabs', () => {
  it('opens on Shorts 공장, switches to engineering-shorts on click and remembers the choice', () => {
    page(video(FULL));
    const tabs = within(screen.getByTestId('hub-video-tabs')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([`Shorts 공장${FULL.alerts.filter((a) => a.level !== 'info').length}`, expect.stringMatching(/^engineering-shorts/)]);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('sf-root')).toBeTruthy();
    expect(screen.queryByTestId('hub-sec-text')).toBeNull();
    expect(screen.queryByTestId('hub-kpis')).toBeNull();
    expect(txt(screen.getByTestId('hub-mode-video'))).toContain('읽기 전용 · 제어 없음'); // the footer stays
    fireEvent.click(tabs[1]!);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('hub-sec-text')).toBeTruthy(); // the studio's own section
    expect(screen.queryByTestId('sf-root')).toBeNull();
    expect(localStorage.getItem(VIDEO_PROJECT_KEY)).toBe('studio');
    cleanup();
    page(video(FULL));
    expect(screen.queryByTestId('sf-root')).toBeNull(); // remembered
    fireEvent.click(screen.getByRole('tab', { name: /Shorts 공장/ }));
    expect(screen.getByTestId('sf-root')).toBeTruthy();
    expect(localStorage.getItem(VIDEO_PROJECT_KEY)).toBe('factory');
  });
  it('an older kept choice (deck.hubVideoProject) does not carry over: Shorts 공장 leads', () => {
    localStorage.setItem('deck.hubVideoProject', 'studio');
    page(video(FULL));
    expect(screen.getByTestId('sf-root')).toBeTruthy();
  });
  it('the engineering-shorts tab shows its own state and 주의, not the factory ones that lead the card', () => {
    localStorage.setItem(VIDEO_PROJECT_KEY, 'studio');
    const base = video(FULL);
    page({ ...base, state: 'down', alerts: [{ level: 'bad', text: 'factory-alert' }], videoOwn: { state: 'idle', lastActivity: '2026-09-01T00:00:00.000Z', alerts: [], metrics: {} } });
    const root = screen.getByTestId('hub-mode-video');
    expect(txt(root)).not.toContain('factory-alert');
    expect(within(screen.getByTestId('hub-video-tabs')).getAllByRole('tab')[1]!.textContent).toBe('engineering-shorts');
  });
  it('tells when the server sent no Shorts 공장 payload instead of showing an empty page', () => {
    localStorage.setItem(VIDEO_PROJECT_KEY, 'factory');
    page(video());
    expect(txt(screen.getByTestId('sf-absent'))).toContain('서버가 Shorts 공장 데이터를 보내지 않았다');
    expect(screen.queryByTestId('sf-root')).toBeNull();
  });
  it('only 영상 gets the tab bar', () => {
    render(<HubPage modeKey="ops" mode={hubStatusFixture(NOW).modes.find((m) => m.id === 'ops')} now={NOW} error={null} loading={false} onRefresh={() => {}} generatedAt={null} />);
    expect(screen.queryByTestId('hub-video-tabs')).toBeNull();
  });
});

describe('ShortsFactoryHome', () => {
  it('renders the lead, nine KPI tiles, 주의 and no control or link below the tabs', () => {
    const { container } = render(<ShortsFactoryHome sf={FULL} now={NOW} />);
    expect(txt(screen.getByTestId('hub-lead'))).toContain(FULL.headline);
    expect(txt(screen.getByTestId('hub-lead'))).toContain('다음 결정');
    expect(screen.getByTestId('sf-kpis').querySelectorAll('.kpi')).toHaveLength(9);
    expect(txt(screen.getByTestId('sf-kpis'))).toContain('미공개');
    expect(txt(screen.getByTestId('sf-kpis'))).toContain('/20');
    expect(txt(screen.getByTestId('sf-alerts'))).toContain('썰 한 스푼 내일(11-02) 예약 없음');
    expect(txt(screen.getByTestId('sf-alerts'))).toContain('→ 계획 20:00 KST');
    expect(container.querySelectorAll('button, input, select, textarea, form, [onclick], [role="button"], a[href]')).toHaveLength(0);
    expect(container.textContent).not.toContain(HOME);
  });
  it('channel table: leader first with a bar, 미공개 for hidden counts, sparkline from history, failure keeps the previous data', () => {
    render(<ShortsFactoryHome sf={FULL} now={NOW} />);
    const t = screen.getByTestId('sf-channels');
    const rows = within(t).getAllByRole('row').slice(1);
    expect(rows.map((r) => txt(r.querySelector('.sf-name b')))).toEqual(['Curious Minute', '궁금한 1분', '썰 한 스푼']); // 1,157 > 545 > 미수집
    expect(rows[0]!.className).toContain('sf-top');
    expect(rows[0]!.querySelector('.sf-bar')).toBeTruthy();
    expect(rows[2]!.querySelector('.sf-bar')).toBeNull(); // nothing collected → no bar, no zero
    expect(txt(rows[2]!)).toContain('미수집');
    expect(txt(rows[1]!)).toContain('미공개');
    expect(txt(rows[0]!)).toContain('1,200');
    expect(t.querySelectorAll('.hs-spark svg')).toHaveLength(1); // only 궁금한 1분 has ≥2 history points
    expect(txt(rows[0]!)).toContain('실패 · 이전 값 유지');
    expect(txt(rows[0]!)).toContain('yt-dlp timeout');
    expect(txt(rows[1]!)).toContain('11-01 19:40'); // last success, KST
    expect(txt(t)).toContain('개설 2/20');
  });
  it('platforms: YouTube 개설, the rest 미개설; a channel without a platforms block is 미확인 everywhere', () => {
    render(<ShortsFactoryHome sf={FULL} now={NOW} />);
    const t = screen.getByTestId('sf-platforms');
    expect(within(t).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['채널', 'YouTube', 'TikTok', 'Instagram', 'X', '기타']);
    const rows = within(t).getAllByRole('row').slice(1);
    expect(Array.from(rows[0]!.querySelectorAll('td.sf-pf')).map((c) => c.textContent)).toEqual(['개설', '미개설', '미개설', '미개설', '미개설']);
    expect(Array.from(rows[2]!.querySelectorAll('td.sf-pf')).map((c) => c.textContent)).toEqual(['미확인', '미확인', '미확인', '미확인', '미확인']);
  });
  it('calendar coverage counts distinct known channels: two bookings on one channel do not hide a channel with none', () => {
    const doubled = buildShortsView({ status: j({ ...STATUS, scheduled: [...STATUS.scheduled.filter((r) => !r.publish_at.startsWith('2026-11-02')), { channel_id: CH1, video_id: 'a', title: 'a', publish_at: '2026-11-02T18:00:00+09:00' }, { channel_id: CH1, video_id: 'b', title: 'b', publish_at: '2026-11-02T19:00:00+09:00' }, { channel_id: 'UCstranger', video_id: 'c', title: 'c', publish_at: '2026-11-02T20:00:00+09:00' }] }), channels: j(CHANNELS), history: HISTORY, probes: PROBES_OK, probeNote: null }, NOW);
    render(<ShortsFactoryHome sf={doubled} now={NOW} />);
    expect(txt(screen.getByTestId('sf-day-2026-11-02'))).toContain('예정 1/3');
    expect(txt(screen.getByTestId('sf-calendar'))).toContain('내일 예정 1/3');
  });

  it('pipeline says 미보고 for gate failures when status.json carries no array, 없음 only for an empty one', () => {
    const { gate_failures: _g, ...noGates } = STATUS;
    render(<ShortsFactoryHome sf={buildShortsView({ status: j(noGates), channels: j(CHANNELS), history: null, probes: PROBES_OK, probeNote: null }, NOW)} now={NOW} />);
    expect(txt(screen.getByTestId('sf-pipeline'))).toContain('게이트 실패미보고');
    expect(screen.queryByTestId('sf-gates')).toBeNull();
    cleanup();
    render(<ShortsFactoryHome sf={buildShortsView({ status: j({ ...STATUS, gate_failures: [] }), channels: j(CHANNELS), history: null, probes: PROBES_OK, probeNote: null }, NOW)} now={NOW} />);
    expect(txt(screen.getByTestId('sf-pipeline'))).toContain('게이트 실패없음');
  });

  it('calendar: two KST weeks from Monday, today and tomorrow marked, scheduled and published listed, a short tomorrow flagged', () => {
    render(<ShortsFactoryHome sf={FULL} now={NOW} />);
    const cal = screen.getByTestId('sf-calendar');
    const days = within(cal).getAllByRole('listitem').filter((li) => li.className.includes('sf-day'));
    expect(days).toHaveLength(14);
    expect(days[0]!.getAttribute('data-testid')).toBe('sf-day-2026-10-26');
    const today = screen.getByTestId('sf-day-2026-11-01');
    expect(today.className).toContain('today');
    expect(txt(today)).toContain('오늘');
    expect(txt(today)).toContain('18:00궁금한 1분');
    expect(today.querySelector('.sf-it.published')).toBeTruthy();
    const tomorrow = screen.getByTestId('sf-day-2026-11-02');
    expect(tomorrow.className).toContain('tomorrow');
    expect(tomorrow.className).toContain('gap'); // 2 of 3 channels booked
    expect(txt(tomorrow)).toContain('예정 2/3');
    expect(tomorrow.querySelectorAll('.sf-it.scheduled')).toHaveLength(2);
    expect(txt(screen.getByTestId('sf-day-2026-11-05'))).toContain('18:00궁금한 1분');
    expect(txt(screen.getByTestId('sf-day-2026-11-08'))).toContain('—');
    expect(txt(cal)).toContain('내일 예정 2/3');
  });
  it('pipeline and log: routine, render, gates, queue, disk, Claude verdicts (sanitized) and Codex; the log tail is a pre', () => {
    render(<ShortsFactoryHome sf={FULL} now={NOW} />);
    const p = txt(screen.getByTestId('sf-pipeline'));
    expect(p).toContain('루틴 상태정상');
    expect(p).toContain('ep-041.mp4');
    expect(p).toContain('1건');
    expect(p).toContain('91%');
    expect(p).toContain('계정 b 선택 · 후보 2/3');
    expect(p).toContain('codex-cli 0.159.2');
    expect(txt(screen.getByTestId('sf-gates'))).toContain('caption-length · ep-040 caption 2.1s over');
    const claude = screen.getByTestId('sf-claude');
    expect(within(claude).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['a 제외 · 보호 계정', 'b 후보 · 주간 31% · 리셋 52h · 점수 0.41', 'c 후보 · 주간 70% · 리셋 12h · 점수 0.83 · stale']);
    expect(screen.getByTestId('sf-log').querySelector('pre')!.textContent).toContain('[19:54:50] upload queued');
    expect(screen.getByTestId('sf-log').querySelector('pre')!.textContent).not.toContain(HOME);
    expect(txt(screen.getByTestId('sf-notes'))).toContain('TikTok 계정 신청 대기');
    expect(txt(screen.getByTestId('sf-notes'))).toContain('VFfjBXHu6Oo 431회');
    expect(txt(screen.getByTestId('sf-band'))).toContain('파일 최신');
  });
  it('with nothing on disk every area says what is missing and what to do; nothing reads as healthy', () => {
    render(<ShortsFactoryHome sf={EMPTY} now={NOW} />);
    const band = txt(screen.getByTestId('sf-band'));
    expect(band).toContain('status.json 없음');
    expect(band).toContain('SCHEMA.md 의 routine 블록부터');
    expect(band).toContain('channels.json 없음');
    expect(band).toContain('collect_youtube.py 를 한 번 실행하면 채워진다');
    expect(band).toContain('history.jsonl 없음');
    expect(screen.getByTestId('sf-kpis').querySelectorAll('.kpi.ok')).toHaveLength(0);
    expect(txt(screen.getByTestId('sf-channels'))).toContain('채널 데이터 없음');
    expect(txt(screen.getByTestId('sf-platforms'))).toContain('채널 데이터 없음');
    expect(txt(screen.getByTestId('sf-calendar'))).toContain('status.json 없음 · 예정·게시를 그릴 수 없다');
    expect(screen.getByTestId('sf-calendar').querySelectorAll('.sf-day.gap')).toHaveLength(0); // no channels → nothing to flag
    const p = txt(screen.getByTestId('sf-pipeline'));
    expect(p).toContain('미보고');
    expect(p).toContain('측정 불가');
    expect(p).toContain('확인 불가');
    expect(txt(screen.getByTestId('sf-log'))).toContain('로그 꼬리 없음');
    expect(txt(screen.getByTestId('sf-alerts'))).toContain('호스트 점검(df · claude-pick · codex) 진행 중');
    expect(screen.queryByTestId('sf-notes')).toBeNull();
  });
  it('the bootstrap placeholder is banded as such and the calendar is dimmed, not drawn as empty days', () => {
    render(<ShortsFactoryHome sf={BOOT} now={NOW} />);
    expect(txt(screen.getByTestId('sf-band'))).toContain('status.json 자리표시자');
    expect(screen.getByTestId('sf-calendar').className).toContain('sf-cal-off');
    expect(txt(screen.getByTestId('sf-calendar'))).toContain('자리표시자 · 예약 정보 없음');
    expect(txt(screen.getByTestId('sf-alerts'))).toContain('내일(11-02) 예약 확인 불가');
    expect(txt(screen.getByTestId('sf-day-2026-11-02'))).not.toContain('예정 0/3');
  });
  it('적용 현황: chips count every status plus 미분류, the table is newest first with links, type words, badges and clipped cells; a chip filters', () => {
    render(<ShortsFactoryHome sf={LEDGERED} now={NOW} />);
    const sec = screen.getByTestId('sf-ledger');
    expect(txt(sec.querySelector('.sh')!)).toContain('6건 · 30분 전 갱신');
    const chips = within(screen.getByTestId('sf-ledger-chips')).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['전체6', '적용됨 – 운영 중1', '구현됨 – 꺼짐1', '문서만1', '검토 후 제외1', '미착수1', '미분류1']);
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(within(sec).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['추가일', '제목', '유형', '상태', '가져온 것', '근거', '다음 할 일']);
    const rows = within(sec).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['sf-ledger-ref-music', 'sf-ledger-ref-caption-tool', 'sf-ledger-ref-sub4sub', 'sf-ledger-ref-thumb-post', 'sf-ledger-ref-hook-3s', 'sf-ledger-ref-odd']);
    const link = rows[0]!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/music');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(rows[3]!.querySelector('a')).toBeNull(); // ftp:// url dropped → plain title
    expect(rows.map((r) => txt(r.querySelector('.sf-ld-type')))).toEqual(['영상', '도구', '팁', '게시물', '영상', '기타']);
    expect(rows.map((r) => txt(r.querySelector('.sf-badge')))).toEqual(['미착수', '구현됨 – 꺼짐', '검토 후 제외', '문서만', '적용됨 – 운영 중', '미분류']);
    expect(txt(rows[2]!.querySelector('.sf-ld-status'))).toContain('정책 위반 위험'); // the reason is shown for 검토 후 제외
    expect(rows[2]!.querySelector('.sf-ld-status')!.getAttribute('title')).toBe('정책 위반 위험');
    expect(txt(rows[5]!.querySelector('.sf-ld-status'))).toContain('검토중'); // 미분류 shows the file's own label
    expect(txt(rows[0]!)).toContain('2026-11-01');
    expect(txt(rows[1]!)).toContain('갱신 2026-10-30');
    expect(txt(rows[1]!)).toContain('d4e5f6a · gates/caption.py · CAPTION_ALIGN=0');
    expect(txt(rows[1]!)).toContain('한국어 샘플 50개로 재측정');
    expect(rows[1]!.querySelector('.sf-clip.sf-ev')!.getAttribute('title')).toBe('d4e5f6a · gates/caption.py · CAPTION_ALIGN=0');
    expect(txt(rows[0]!)).not.toContain('sk-EXAMPLE');
    expect(txt(sec)).not.toContain(HOME);
    fireEvent.click(chips[4]!); // 검토 후 제외
    expect(chips[4]!.getAttribute('aria-pressed')).toBe('true');
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(within(sec).getAllByRole('row').slice(1).map((r) => r.getAttribute('data-testid'))).toEqual(['sf-ledger-ref-sub4sub']);
    fireEvent.click(chips[6]!); // 미분류
    expect(within(sec).getAllByRole('row').slice(1).map((r) => r.getAttribute('data-testid'))).toEqual(['sf-ledger-ref-odd']);
    fireEvent.click(chips[0]!);
    expect(within(sec).getAllByRole('row').slice(1)).toHaveLength(6);
  });
  it('적용 현황 without a file says 파일 없음 and shows no chip or link; a malformed file says so', () => {
    render(<ShortsFactoryHome sf={FULL} now={NOW} />);
    const sec = screen.getByTestId('sf-ledger');
    expect(txt(sec)).toContain('파일 없음');
    expect(txt(sec)).toContain('reference_ledger.json 없음');
    expect(sec.querySelectorAll('button, a[href], table')).toHaveLength(0);
    cleanup();
    render(<ShortsFactoryHome sf={buildShortsView({ status: j(STATUS), channels: j(CHANNELS), history: null, ledger: '{"generated_at":"2026-11-01T19:30:00+09:00"}', probes: PROBES_OK, probeNote: null }, NOW)} now={NOW} />);
    expect(txt(screen.getByTestId('sf-ledger'))).toContain('형식 오류 · items 배열 없음');
    expect(screen.getByTestId('sf-ledger').querySelectorAll('button, table')).toHaveLength(0);
    cleanup();
    render(<ShortsFactoryHome sf={buildShortsView({ status: j(STATUS), channels: j(CHANNELS), history: null, ledger: '{"generated_at":"2026-11-01T19:30:00+09:00","items":[]}', probes: PROBES_OK, probeNote: null }, NOW)} now={NOW} />);
    expect(txt(screen.getByTestId('sf-ledger'))).toContain('항목 없음');
  });
  it('formats Seoul time', () => {
    expect(kst('2026-11-01T10:54:00.000Z')).toBe('11-01 19:54');
    expect(kst('2026-11-01T15:30:00Z')).toBe('11-02 00:30');
    expect(kst(null)).toBe('—');
    expect(kst('nope')).toBe('—');
  });
});

describe('플랫폼 배포 매트릭스', () => {
  const DISTED = buildShortsView({ status: j({ ...STATUS, distribution: DIST }), channels: j(CHANNELS), history: HISTORY, probes: PROBES_OK, probeNote: null }, NOW);
  it('replaces the old platform table with channel × platform cells, chips, links and counts', () => {
    render(<ShortsFactoryHome sf={DISTED} now={NOW} />);
    expect(screen.queryByTestId('sf-platforms')).toBeNull();
    const yt = screen.getByTestId('sf-dc-gunggeum-1min-youtube');
    expect(yt.dataset.state).toBe('ready');
    expect(txt(yt)).toContain('준비됨');
    expect(within(yt).getByText('@gunggeum_1min').getAttribute('href')).toBe('https://www.youtube.com/@gunggeum_1min');
    expect(txt(yt)).toContain('조회 2,845');
    const tk = screen.getByTestId('sf-dc-gunggeum-1min-tiktok');
    expect(txt(tk)).toContain('이름 대기');
    expect(txt(tk)).toContain('실패 1');
    expect(within(tk).getByText('@maxmaxmax858').tagName).toBe('SPAN');
    expect(txt(screen.getByTestId('sf-dist-blockers'))).toContain('닉네임 변경 잠금');
    expect(txt(screen.getByTestId('sf-dist-blockers'))).not.toContain('계정 없음');
    expect(txt(screen.getByTestId('sf-ds-boil'))).toContain('게시*');
  });
  it('falls back to the channels.json platform table without a distribution block', () => {
    render(<ShortsFactoryHome sf={FULL} now={NOW} />);
    expect(screen.getByTestId('sf-platforms')).toBeTruthy();
    expect(screen.queryByTestId('sf-dist')).toBeNull();
  });
});

describe("routines · longform · blockers · setup checklist", () => {
  const extra = {
    routines: [
      { id: "shorts", name: "Shorts 공장", schedule: "매일 22:00 KST", last_run_at: "2026-11-01T22:00:00+09:00", status: "failed", note: "메모리 부족 → 수정 완료" },
      { id: "longform", name: "롱폼 공장", schedule: "매일 14:00 KST", last_run_at: null, status: "unknown", note: "첫 실행 11/3" },
    ],
    longform: { target_per_day: 5, done_today: 2, published: [{ id: "yeoksa-01", channel_name: "역사 반전", title: "해상시계", url: "https://www.youtube.com/watch?v=kQuNYRKfTVg", state: "posted", published_at: "2026-11-02T16:28:14+09:00" }], pending: [{ id: "alba-lf-01", state: "ready", plan: "게시 예정 2026-11-03 19:00" }], queue: [{ text: "alba-lf-01 · T", done: false }], progress: null },
    blockers: [{ id: "thumb", text: "휴대폰 인증 필요", owner: "user" }],
    distribution: { ...DIST, setup_fields: ["avatar", "link"], channels: (DIST as any).channels.map((c: any, i: number) => i ? c : { ...c, cells: { ...c.cells, youtube: { ...(c.cells?.youtube ?? { account_state: "ready" }), setup: { avatar: true, link: false }, setup_note: "웹에서 막힘" } } }) },
  };
  it("shows the routine table, longform links and queue, the blocker list and a 설정 n/m chip with what is open", () => {
    const sf = buildShortsView({ status: j({ ...STATUS, ...extra }), channels: j(CHANNELS), history: HISTORY, probes: PROBES_OK, probeNote: null }, NOW);
    render(<ShortsFactoryHome sf={sf} now={NOW} />);
    expect(txt(screen.getByTestId("sf-routine-shorts"))).toContain("매일 22:00 KST");
    expect(screen.getByTestId("sf-routine-longform").getAttribute("data-status")).toBe("unknown");
    expect(txt(screen.getByTestId("sf-routine-longform"))).toContain("실행 기록 없음");
    const lf = screen.getByTestId("sf-longform");
    expect(txt(lf)).toContain("오늘 2/5");
    expect(within(lf).getByRole("link", { name: "해상시계" }).getAttribute("href")).toBe("https://www.youtube.com/watch?v=kQuNYRKfTVg");
    expect(txt(screen.getByTestId("sf-lf-alba-lf-01"))).toContain("업로드 준비");
    expect(txt(screen.getByTestId("sf-lf-queue"))).toContain("alba-lf-01");
    expect(txt(screen.getByTestId("sf-blocker-thumb"))).toContain("사용자");
    const chip = screen.getByTestId("sf-setup");
    expect(txt(chip)).toBe("설정 1/2");
    expect(chip.getAttribute("title")).toContain("남음: 링크");
  });
});
