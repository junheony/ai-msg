// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HubPage } from './HubPage';
import { HubOverview } from './HubOverview';
import { hubStatusFixture } from './__fixtures__/status';

// The two Trading panels have their own tests (sr/SrPanel.test.tsx, lab/LabPanel.test.tsx, TradingRoom.test.tsx); the
// page test only needs their frames. `paperBadge` is pure and the source strip uses it, so the real one stays.
vi.mock('./lab/LabPanel', () => ({ LabPanel: () => <section data-testid="lab-panel" /> }));
vi.mock('./sr/SrPanel', async () => ({ ...(await vi.importActual<typeof import('./sr/SrPanel')>('./sr/SrPanel')), SrPanel: () => <section data-testid="sr-panel" /> }));
// The page's own Trading reads never touch the network in this test.
const quiet = { labApi: { summary: async () => { throw new Error('offline'); } }, srApi: { sr: async () => { throw new Error('offline'); }, klines: async () => [] } };

const T = Date.parse('2026-10-30T13:00:00Z');
const STATUS = hubStatusFixture(T);
const mode = (id: string) => STATUS.modes.find((m) => m.id === id)!;
const page = (id: string, extra: Partial<Parameters<typeof HubPage>[0]> = {}) => render(<HubPage modeKey={id as never} mode={mode(id)} now={T} error={null} loading={false} onRefresh={() => {}} generatedAt={STATUS.generated_at} {...quiet} {...extra} />);

afterEach(cleanup);

describe('HubPage template', () => {
  it('leads with the headline and the decision, then the KPIs and 주의', () => {
    page('ops');
    const lead = screen.getByTestId('hub-lead');
    expect(lead.className).toContain('warn');
    expect(lead.textContent).toContain('프린터 4대 중 3대 가동 · sub1 정지');
    expect(lead.textContent).toContain('다음 결정');
    expect(lead.textContent).toContain('sub1 전원·네트워크 확인');
    const kpis = screen.getByTestId('hub-kpis').querySelectorAll('.kpi');
    expect(kpis.length).toBe(2);
    expect(kpis[0]!.className).toContain('warn');
    expect(kpis[1]!.textContent).toBe('큐2건');
    const att = screen.getByRole('list', { name: '주의' });
    expect(att.textContent).toContain('sub1 하트비트 정지 · 12분 전');
    expect(att.textContent).toContain('→ sub1 전원·네트워크 확인');
    expect(att.textContent).toContain('12분 전');
  });

  it('a table section right-aligns numeric columns and colours status words; an empty table says so', () => {
    page('ops');
    const table = screen.getByTestId('hub-sec-table');
    expect(table.hasAttribute('open')).toBe(true);
    const cells = table.querySelectorAll('tbody td');
    expect(cells[2]!.className).toContain('n');
    expect(cells[1]!.className).toContain('st-ok');
    expect(cells[4]!.className).toContain('st-warn');
    expect(cells[10]!.className).toContain('st-bad');
    expect(table.querySelector('.cnt')!.textContent).toBe('4');
    cleanup();
    page('quant');
    expect(screen.getByTestId('hub-sec-table').textContent).toContain('자료 없음');
  });

  it('a section added above does not remount the ones below (an opened or closed section keeps its state)', () => {
    const ops = mode('ops');
    const props = { modeKey: 'ops' as never, now: T, error: null, loading: false, onRefresh: () => {}, generatedAt: STATUS.generated_at, ...quiet };
    const r = render(<HubPage {...props} mode={ops} />);
    fireEvent.click(screen.getByTestId('hub-sec-table').querySelector('summary')!);
    expect(screen.getByTestId('hub-sec-table').hasAttribute('open')).toBe(false);
    const added = { ...ops, page: { ...ops.page!, sections: [{ kind: 'text' as const, title: '새 섹션', open: true, body: 'x' }, ...ops.page!.sections] } };
    r.rerender(<HubPage {...props} mode={added} />);
    expect(screen.getByTestId('hub-sec-text')).toBeTruthy();
    expect(screen.getByTestId('hub-sec-table').hasAttribute('open')).toBe(false);
  });

  it('KPI tiles carry the full label and value as a tooltip', () => {
    page('ops');
    const k = screen.getByTestId('hub-kpis').querySelectorAll('.kpi')[1]!;
    expect(k.querySelector('.l')!.getAttribute('title')).toBe('큐');
    expect(k.querySelector('.v')!.getAttribute('title')).toBe('2건');
  });

  it('원본 보기 mounts the sandboxed frame only once opened; the sandbox allows no forms', () => {
    page('quant');
    const raw = screen.getByTestId('hub-sec-raw');
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('iframe')).toBeNull();
    fireEvent.click(raw.querySelector('summary')!);
    const frame = raw.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('/hub/p/quant/');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-forms');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    fireEvent.click(raw.querySelector('summary')!);
    expect(raw.querySelector('iframe')).toBeNull();
  });

  it('an outside 원본 is a new-tab link, never a frame', () => {
    page('nexus');
    const raw = screen.getByTestId('hub-sec-raw');
    fireEvent.click(raw.querySelector('summary')!);
    expect(raw.querySelector('iframe')).toBeNull();
    const a = raw.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('http://nexus.example/');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(screen.getByTestId('hub-lead').className).toContain('bad');
    expect(screen.getByText('nexus · 시간 초과')).toBeTruthy();
  });

  it('bars scale to the largest magnitude and mark negatives; lists, kv and text render their rows', () => {
    page('trading');
    expect(screen.getByText('PAPER').className).toBe('hub-tag');
    const bars = screen.getByTestId('hub-sec-bars').querySelectorAll('.bar .tr i');
    expect((bars[0] as HTMLElement).style.width).toBe('100%');
    expect((bars[1] as HTMLElement).style.width).toBe('34%');
    expect(bars[1]!.className).toBe('neg');
    cleanup();
    page('game');
    expect(screen.getByTestId('hub-sec-list').querySelectorAll('li').length).toBe(2);
    cleanup();
    page('msg');
    expect(screen.getByTestId('hub-sec-kv').textContent).toContain('abc123');
    cleanup();
    page('video');
    expect(screen.getByTestId('hub-sec-text').querySelector('pre')!.textContent).toBe('첫 줄\n둘째 줄');
    expect(screen.getByTestId('hub-lead').className).toContain('idle');
  });

  it('an older server without a page still gets a lead, KPIs from the metrics and the alerts', () => {
    page('yapping');
    expect(screen.getByTestId('hub-lead').textContent).toContain('상태 파일 없음');
    expect(screen.getByTestId('hub-kpis').textContent).toContain('확인 불가');
    expect(screen.getByTestId('hub-kpis').textContent).toContain('—');
    expect(screen.getByTestId('hub-sec-kv')).toBeTruthy();
    expect(screen.getByText('systemd · 권한 없음')).toBeTruthy();
  });

  it('shows the error and keeps refresh usable; nothing on the page is a form control', () => {
    const onRefresh = vi.fn();
    page('ops', { error: 'HTTP 503', onRefresh });
    expect(screen.getByRole('alert').textContent).toContain('HTTP 503');
    fireEvent.click(screen.getByRole('button', { name: '지금 새로고침' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(document.querySelector('form, input, select, textarea')).toBeNull();
    expect(screen.getByTestId('hub-mode-ops').textContent).toContain('읽기 전용 · 제어 없음');
  });
});

describe('HubOverview', () => {
  it('counts the states, names the first 장애 as the decision, and lets a 주의 row jump to its mode', () => {
    const onOpenMode = vi.fn();
    render(<HubOverview status={STATUS} error={null} loading={false} fetchedAt={T} now={T} pushOn onOpenMode={onOpenMode} onRefresh={() => {}} />);
    const lead = screen.getByTestId('hub-lead');
    expect(lead.className).toContain('bad');
    expect(lead.textContent).toContain('장애 1 · 주의 1 · 정상 5 · 대기 1 · 미확인 1');
    expect(lead.textContent).toContain('NEXUS — 연결 실패 → nexus 서비스 확인');
    const cards = screen.getByTestId('hub-overview').querySelectorAll('.card');
    expect(cards.length).toBe(9);
    expect(cards[1]!.className).toContain('bad');
    expect(cards[5]!.className).toContain('warn');
    expect(cards[5]!.textContent).toContain('프린터 4대 중 3대 가동');
    expect(cards[6]!.textContent).toContain('다음 · 조치 없음');
    const att = screen.getByRole('list', { name: '주의' });
    expect(att.querySelectorAll('li').length).toBe(2);
    expect(att.querySelectorAll('li')[0]!.className).toBe('bad');
    fireEvent.click(att.querySelectorAll('button')[1]!);
    expect(onOpenMode).toHaveBeenCalledWith('ops');
    fireEvent.click(screen.getByRole('button', { name: 'QUANT 열기' }));
    expect(onOpenMode).toHaveBeenCalledWith('quant');
    expect(screen.getByText('실시간 푸시')).toBeTruthy();
    expect(document.querySelector('form, input, select, textarea')).toBeNull();
  });

  it('says 폴링 and the stale time when there is no push and the last fetch failed', () => {
    render(<HubOverview status={STATUS} error="HTTP 503" loading={false} fetchedAt={T - 120_000} now={T} pushOn={false} onOpenMode={() => {}} onRefresh={() => {}} />);
    expect(screen.getByText('15초 폴링')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('마지막 성공 2분 전');
  });
});

it('mounts the source strip and both panels before legacy summaries even when trading data is missing', () => {
  const { container } = page('trading', { mode: undefined });
  expect(screen.getByTestId('tr-src')).toBeTruthy();
  expect(screen.getByTestId('lab-panel')).toBeTruthy();
  expect(screen.getByTestId('sr-panel')).toBeTruthy();
  expect(container.querySelector('[data-testid="tr-paper"]')).toBeNull();
  const order = [...container.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'));
  expect(order.indexOf('tr-src')).toBeLessThan(order.indexOf('lab-panel'));
  expect(order.indexOf('lab-panel')).toBeLessThan(order.indexOf('sr-panel'));
});

it('trading sections are static (no fold, no frame): a 원본 is a new-tab link; other modes keep their folds', () => {
  const t = mode('trading');
  const withRaw = { ...t, page: { ...t.page!, sections: [...t.page!.sections, { kind: 'raw' as const, title: '원본', href: '/hub/p/trading/', embed: true }] } };
  page('trading', { mode: withRaw });
  expect(document.querySelector('details, summary, iframe')).toBeNull();
  const raw = screen.getByTestId('hub-sec-raw');
  expect(raw.tagName).toBe('SECTION');
  expect(raw.querySelector('a')!.getAttribute('target')).toBe('_blank');
  expect(raw.querySelector('button')).toBeNull();
  expect(screen.getByTestId('hub-sec-bars').tagName).toBe('SECTION');
  cleanup();
  page('quant');
  expect(screen.getByTestId('hub-sec-raw').tagName).toBe('DETAILS');
});
