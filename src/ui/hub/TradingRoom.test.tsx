// @vitest-environment jsdom
/**
 * The unified read-only Trading room, with the real Lab and SR panels: every interaction is a link, both paper sources
 * carry a PAPER ONLY badge, a source name and a KST time, DCA is 미보고, and the kNN scenario words never appear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { SrRange } from '../../shared/sr-types';
import type { LabResponse } from '../../shared/lab-types';
import { mapLab } from '../../server/hub/lab';
import { labFixture, LAB_NOW } from '../../test/labFixture';
import { srCandles, srSnap, SR_SYMBOLS } from '../../test/srFixture';
import { hubStatusFixture } from './__fixtures__/status';
import { HubPage } from './HubPage';
import type { LabApi } from './lab/api';
import type { SrApi } from './sr/api';

vi.mock('./sr/SrChart', () => ({ SrChart: (p: { ranges: SrRange[] }) => <div data-testid="sr-chart" data-ranges={p.ranges.map((r) => r.id).join(',')} /> }));

const T = LAB_NOW;
const STATUS = hubStatusFixture(T);
const trading = STATUS.modes.find((m) => m.id === 'trading')!;
const labAnswer = (extra: Partial<LabResponse> = {}): LabResponse => ({ snapshot: mapLab(labFixture()), state: 'ok', stale: false, ageSeconds: 0, failures: 0, error: null, lastSuccessAt: '2026-11-01T08:00:00Z', ...extra });
const labApi = (over: Partial<LabApi> = {}): LabApi => ({ summary: vi.fn(async () => labAnswer()), ...over });
const srApi = (over: Partial<SrApi> = {}): SrApi => ({ sr: vi.fn(async (s: string | null) => { if (s && !SR_SYMBOLS.includes(s)) throw new Error('없는 심볼'); return srSnap(s); }), klines: vi.fn(async () => srCandles(110_000)), ...over });
const room = (p: { labApi?: LabApi; srApi?: SrApi; mode?: typeof trading; loading?: boolean } = {}) =>
  render(<HubPage modeKey="trading" mode={p.mode ?? trading} now={T} error={null} loading={p.loading ?? false} onRefresh={() => {}} generatedAt={STATUS.generated_at} labApi={p.labApi ?? labApi()} srApi={p.srApi ?? srApi()} />);
const go = (hash: string) => act(() => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')); });
const CONTROLS = 'select, input, textarea, form, details, summary, iframe, [contenteditable], [role="button"], [role="switch"], [role="slider"], [role="tab"], video[controls], audio';

beforeEach(() => { window.location.hash = ''; localStorage.clear(); });
afterEach(cleanup);

describe('unified Trading room', () => {
  it('has zero control elements anywhere in hub-mode-trading, header included; every link is a hash or a new-tab read', async () => {
    const { container } = room();
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    await screen.findByText('60,170');
    const page = screen.getByTestId('hub-mode-trading');
    expect(page.querySelectorAll('button').length).toBe(0);
    expect(page.querySelector('header.ph')!.querySelectorAll('button, a, input, select').length).toBe(0);
    expect(page.querySelector('header.ph')!.textContent).toContain('읽기 전용');
    expect(container.querySelectorAll(`button, ${CONTROLS}`).length).toBe(0);
    expect(container.querySelectorAll('[onclick], [onchange], [oninput]').length).toBe(0);
    const links = [...container.querySelectorAll('a[href]')];
    expect(links.length).toBeGreaterThan(5);
    for (const a of links) {
      const href = a.getAttribute('href')!;
      if (href.startsWith('#')) { expect(href).toMatch(/^#(hub-lab|hub-sr|hub-practice|sr-all|sr=[A-Z0-9]+)$/); continue; }
      expect(href).toMatch(/^https?:\/\//);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
    expect(container.textContent).toContain('읽기 전용 · 제어 없음');
  });

  it('while the status is being read the Trading header shows a passive word, still with no button (other modes keep theirs)', async () => {
    const { unmount } = room({ loading: true });
    const head = screen.getByTestId('hub-mode-trading').querySelector('header.ph')!;
    expect(head.textContent).toContain('불러오는 중…');
    expect(head.querySelectorAll('button').length).toBe(0);
    unmount();
    const ops = STATUS.modes.find((m) => m.id === 'ops')!;
    render(<HubPage modeKey="ops" mode={ops} now={T} error={null} loading={false} onRefresh={() => {}} generatedAt={STATUS.generated_at} labApi={labApi()} srApi={srApi()} />);
    expect(screen.getByRole('button', { name: '지금 새로고침' })).toBeTruthy();
  });

  it('leads with both paper sources: PAPER ONLY badges, service names, KST times, links down to each section', async () => {
    room();
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    await screen.findByText('60,170');
    const strip = screen.getByTestId('tr-src');
    const lab = within(strip).getByTestId('tr-src-lab'), sr = within(strip).getByTestId('tr-src-sr');
    // the two sources are named as such — Lab, SR / DCA — next to their Korean titles, on the cards and the sections
    expect(lab.querySelector('h4')!.textContent).toBe('Lab 연구실 페이퍼 요약');
    expect(sr.querySelector('h4')!.textContent).toBe('SR / DCA 지지·저항 · 분할매수(DCA)');
    expect(screen.getByTestId('lab-panel').querySelector('h2')!.textContent).toBe('Lab 연구실 페이퍼 요약');
    expect(screen.getByTestId('sr-panel').querySelector('.sec-title')!.textContent).toBe('SR / DCA 지지·저항 · 분할매수(DCA)');
    expect(lab.textContent).toContain('연구실 페이퍼 요약');
    expect(lab.querySelector('.hs-badge')!.textContent).toBe('PAPER ONLY');
    expect(lab.textContent).toContain('트레이딩 ver2 · :8792');
    expect(lab.textContent).toContain('2026-11-01 17:00 KST');
    expect(lab.textContent).toContain('정상');
    expect(lab.textContent).toContain('1개 · 1');
    expect(within(lab).getByRole('link').getAttribute('href')).toBe('#hub-lab');
    expect(sr.textContent).toContain('지지·저항 · 분할매수(DCA)');
    expect(sr.querySelector('.hs-badge')!.textContent).toBe('PAPER ONLY');
    expect(sr.textContent).toContain('트레이딩룸 :8830');
    expect(sr.textContent).toContain('2026-10-31 15:30 KST');
    expect(sr.textContent).toContain('2026-10-31 17:58 KST');
    expect(sr.textContent).toContain('3 · 5');
    expect(within(sr).getByRole('link').getAttribute('href')).toBe('#hub-sr');
    expect(document.getElementById('hub-lab')).toBe(screen.getByTestId('lab-panel'));
    expect(document.getElementById('hub-sr')).toBe(screen.getByTestId('sr-panel'));
    // the panels carry their own badge + source + KST, so the verdict is visible wherever the reader lands
    expect(screen.getByTestId('lab-paper').textContent).toBe('PAPER ONLY · LIVE OFF');
    expect(screen.getByTestId('sr-paper').textContent).toBe('PAPER ONLY');
    expect(screen.getByTestId('lab-panel').textContent).toContain('2026-11-01 17:00:00 KST');
    expect(screen.getByTestId('sr-clock').textContent).toContain('KST');
  });

  it('keeps the existing content in order and reports DCA honestly, with no kNN scenario probabilities anywhere', async () => {
    const { container } = room();
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    await screen.findByText('60,170');
    const order = [...container.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'));
    const idx = (id: string) => { const i = order.indexOf(id); expect(i, id).toBeGreaterThanOrEqual(0); return i; };
    expect(idx('tr-src')).toBeLessThan(idx('hub-lead'));
    expect(idx('hub-lead')).toBeLessThan(idx('hub-kpis'));
    expect(idx('hub-kpis')).toBeLessThan(idx('lab-panel'));
    expect(idx('lab-panel')).toBeLessThan(idx('sr-panel'));
    expect(idx('sr-panel')).toBeLessThan(idx('hub-sec-bars'));
    expect(idx('hub-sec-bars')).toBeLessThan(idx('hub-practice'));
    expect(screen.getByTestId('hub-sec-bars').tagName).toBe('SECTION');
    expect(screen.getByTestId('sr-dca').textContent).toContain('미보고');
    expect(screen.getByTestId('sr-dca').textContent).toContain('stage paper');
    expect(screen.getByTestId('hub-practice').textContent).toContain('복기 연습 기록');
    expect(container.querySelector('a[href="#replay"]')).toBeNull();
    expect(container.textContent).not.toMatch(/knn|k-nn|scenario|probab|시나리오|확률/i);
    // the existing Room / ver2 content is all still there, static
    expect(screen.getByTestId('hub-sec-bars')).toBeTruthy();
    expect(container.querySelectorAll('details, summary').length).toBe(0);
  });

  it('#replay is not a sub-screen any more: the hash changes nothing, the room stays and no control appears', async () => {
    const { container } = room();
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    go('#replay');
    expect(screen.queryByTestId('hub-practice-screen')).toBeNull();
    expect(screen.queryByTestId('replay-trainer')).toBeNull();
    expect(screen.getByTestId('tr-src')).toBeTruthy();
    expect(screen.getByTestId('sr-panel')).toBeTruthy();
    expect(screen.getByTestId('lab-panel')).toBeTruthy();
    expect(screen.getByTestId('hub-practice').textContent).toContain('복기 연습 기록');
    expect(container.querySelectorAll(`button, ${CONTROLS}`).length).toBe(0);
  });

  it('a poll that fails after a good one keeps the zones on screen but says so, instead of passing cached data off as fresh', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const api = srApi({ sr: vi.fn(async (s: string | null) => { if (s === null && ++calls > 1) throw new Error('연결 실패'); return srSnap(s); }) });
      room({ srApi: api });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('sr-table')).toBeTruthy();
      expect(screen.queryByTestId('sr-client-stale')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const band = screen.getByTestId('sr-client-stale');
      expect(band.textContent).toContain('SR 스냅샷 갱신 실패 · 이전 값 표시 중');
      expect(band.textContent).toContain('연결 실패');
      expect(band.textContent).toContain('KST');
      expect(screen.getByTestId('sr-table')).toBeTruthy();
      expect(screen.getByTestId('tr-src-sr').textContent).toContain('2026-10-31 15:30 KST');
    } finally { vi.useRealTimers(); }
  });

  it('a symbol link in the SR section drives the chart from the hash and nothing else re-renders into a control', async () => {
    const api = srApi();
    const { container } = room({ srApi: api });
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    go('#sr=ETHUSDT');
    await waitFor(() => expect(api.sr).toHaveBeenCalledWith('ETHUSDT'));
    await waitFor(() => expect(screen.getByTestId('sr-chart').dataset.ranges).toBe('eth'));
    expect(container.querySelectorAll(CONTROLS).length).toBe(0);
    expect(api.sr).toHaveBeenCalledWith(null);
    expect((api.sr as ReturnType<typeof vi.fn>).mock.calls.filter(([s]) => s === null).length).toBe(1);
  });

  it('status feed out, SR feed up: the SR card and badge say 상태 미확인, the zones still show; lab out: its card says so, SR unaffected', async () => {
    const statusDown = srApi({ sr: vi.fn(async (s: string | null) => srSnap(s, { room: null })) });
    const { unmount } = room({ srApi: statusDown });
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    const srCard = screen.getByTestId('tr-src-sr');
    expect(srCard.className).toContain('warn');
    expect(srCard.querySelector('.hs-badge')!.textContent).toBe('PAPER ONLY · 상태 미확인');
    expect(srCard.textContent).toContain('응답 없음 · 시간 초과');
    expect(srCard.textContent).toContain('2026-10-31 15:30 KST');
    expect(screen.getByTestId('tr-src-lab').className).not.toContain('bad');
    unmount();
    room({ labApi: labApi({ summary: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) }) });
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    const labCard = await screen.findByTestId('tr-src-lab');
    await waitFor(() => expect(labCard.textContent).toContain('요약 서버 연결 오류'));
    expect(labCard.className).toContain('bad');
    expect(labCard.textContent).toContain('— 미보고');
    expect(labCard.textContent).not.toContain('ECONNREFUSED');
    expect(screen.getByTestId('tr-src-sr').querySelector('.hs-badge')!.textContent).toBe('PAPER ONLY');
    expect(screen.getByTestId('lab-panel').textContent).toContain('요약 서버 연결 오류');
  });

  it('a live flag from the room turns the badge red instead of hiding behind PAPER ONLY', async () => {
    const live = srApi({ sr: vi.fn(async (s: string | null) => { const snap = srSnap(s); return { ...snap, room: { ...snap.room!, paper: { ...snap.room!.paper, adaptiveLive: true } } }; }) });
    room({ srApi: live });
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    expect(screen.getByTestId('sr-paper').textContent).toContain('라이브 플래그 감지');
    expect(screen.getByTestId('sr-paper').className).toContain('bad');
    expect(screen.getByTestId('tr-src-sr').className).toContain('bad');
  });
});
