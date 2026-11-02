// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResearchArticle, ResearchResponse, ResearchSource } from '../../../shared/research-types';
import { liveResearchApi } from './api';
import { ResearchPage, ResearchPanel, tagTone } from './ResearchPanel';

afterEach(cleanup);

const art = (id: string, over: Partial<ResearchArticle> = {}): ResearchArticle => ({ id, title: `제목 ${id}`, date: '2026-11-01', summary: '', tags: ['RWA'], url: `https://example.com/${id}`, source: 'AI-Crypto 리서치', ...over });
const src = (name: string, over: Partial<ResearchSource> = {}): ResearchSource => ({ name, url: `https://www.${name.toLowerCase()}.io/`, focus: `${name} 설명`, category: 'Data', ownerPick: false, ...over });
const res = (over: Partial<ResearchResponse> = {}): ResearchResponse => ({ articles: [], sources: [], files: { articles: 'ok', sources: 'ok' }, skipped: { articles: 0, sources: 0 }, ...over });
const api = (r: ResearchResponse) => ({ get: async () => r });

describe('tagTone', () => {
  it.each([['RWA', 'rwa'], ['Perp/Prop', 'perp'], ['Perp·Prop', 'perp'], ['AI Compute', 'ai'], ['Launchpad', 'launch'], ['거시', 'other']])('%s → %s', (tag, tone) => {
    expect(tagTone(tag)).toBe(tone);
  });
});

describe('ResearchPanel', () => {
  it('leads with the first article and links everything to a new tab', async () => {
    render(<ResearchPanel api={api(res({ articles: [art('a', { summary: '결론 한 줄' }), art('b')], sources: [src('Kaiko')] }))} />);
    const lead = await screen.findByTestId('research-lead');
    expect(within(lead).getByRole('heading', { name: '제목 a' })).toBeTruthy();
    expect(within(lead).getByText('결론 한 줄')).toBeTruthy();
    expect(within(lead).getByText('2026.11.01')).toBeTruthy();
    const links = [lead, screen.getByTestId('research-card'), screen.getByTestId('research-source')];
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });

  it('marks an empty summary as 요약 대기, on the cover and the cards', async () => {
    render(<ResearchPanel api={api(res({ articles: [art('a'), art('b')] }))} />);
    await screen.findByTestId('research-lead');
    expect(screen.getAllByText('요약 대기')).toHaveLength(2);
  });

  it('shows the 매일 갱신 badge in place of the date', async () => {
    render(<ResearchPanel api={api(res({ articles: [art('a'), art('d', { updatedDaily: true, date: '2026-11-02' })] }))} />);
    const card = await screen.findByTestId('research-card');
    expect(within(card).getByText('매일 갱신')).toBeTruthy();
    expect(within(card).queryByText('2026.11.02')).toBeNull();
  });

  it('shows Perp/Prop as Perp·Prop with its colour', async () => {
    render(<ResearchPanel api={api(res({ articles: [art('p', { tags: ['Perp/Prop'] })] }))} />);
    const lead = await screen.findByTestId('research-lead');
    expect(lead.dataset.tone).toBe('perp');
    expect(within(lead).getByText('Perp·Prop').dataset.tone).toBe('perp');
  });

  it('lets a long list of names break only after a separator', async () => {
    render(<ResearchPanel api={api(res({ articles: [art('n', { title: 'Liquid·Lyber/Venice 세션' })] }))} />);
    const title = within(await screen.findByTestId('research-lead')).getByRole('heading');
    expect(title.textContent).toBe('Liquid·Lyber/Venice 세션');
    expect(title.querySelectorAll('wbr')).toHaveLength(2);
  });

  it('filters by tag, and the first match becomes the lead', async () => {
    render(<ResearchPanel api={api(res({ articles: [art('a'), art('l', { tags: ['Launchpad'] }), art('c', { tags: ['AI Compute'] })] }))} />);
    fireEvent.click(await screen.findByRole('button', { name: /Launchpad/ }));
    expect(within(screen.getByTestId('research-lead')).getByText('제목 l')).toBeTruthy();
    expect(screen.queryByTestId('research-card')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /전체/ }));
    expect(screen.getAllByTestId('research-card')).toHaveLength(2);
  });

  it('hides the filter when there is only one tag to pick', async () => {
    render(<ResearchPanel api={api(res({ articles: [art('a'), art('b')] }))} />);
    await screen.findByTestId('research-lead');
    expect(screen.queryByTestId('research-filter')).toBeNull();
  });

  it('puts owner picks first and groups the rest by category', async () => {
    render(<ResearchPanel api={api(res({ sources: [src('Kaiko'), src('Semi', { category: 'AI-GPU' }), src('Pillars', { ownerPick: true, nameKo: '포필러스', category: 'Research house' })] }))} />);
    const groups = (await screen.findByTestId('research-sources')).querySelectorAll('[data-testid^="research-group-"]');
    expect([...groups].map((g) => g.querySelector('h4')?.textContent)).toEqual(['오너 픽', '데이터', 'AI·GPU']);
    expect(within(screen.getByTestId('research-group-pick')).getByText('포필러스')).toBeTruthy();
  });

  it('gives a missing file a friendly empty state with the next step', async () => {
    render(<ResearchPanel api={api(res({ files: { articles: 'missing', sources: 'missing' } }))} />);
    expect((await screen.findByTestId('research-empty')).textContent).toContain('msg-research-add');
    expect(screen.queryByTestId('research-sources')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the sources when only the articles file is missing', async () => {
    render(<ResearchPanel api={api(res({ sources: [src('Kaiko')], files: { articles: 'missing', sources: 'ok' } }))} />);
    await screen.findByTestId('research-empty');
    expect(screen.getByTestId('research-sources')).toBeTruthy();
  });

  it('says which file to fix when it is broken, and counts left-out entries', async () => {
    render(<ResearchPanel api={api(res({ files: { articles: 'invalid', sources: 'ok' }, skipped: { articles: 0, sources: 2 } }))} />);
    expect((await screen.findByTestId('research-invalid')).textContent).toContain('articles.json');
    expect(screen.getByTestId('research-skipped').textContent).toContain('2건');
  });

  it('names sources.json when only that file is broken, and keeps the articles', async () => {
    render(<ResearchPanel api={api(res({ articles: [art('a')], files: { articles: 'ok', sources: 'invalid' } }))} />);
    await screen.findByTestId('research-lead');
    expect(screen.getByTestId('research-sources-invalid').textContent).toContain('sources.json');
  });

  it('recovers from a failed read with the retry button', async () => {
    const get = vi.fn<() => Promise<ResearchResponse>>().mockRejectedValueOnce(new Error('연결 실패')).mockResolvedValue(res({ articles: [art('a')] }));
    render(<ResearchPanel api={{ get }} />);
    expect((await screen.findByRole('alert')).textContent).toContain('연결 실패');
    fireEvent.click(screen.getByRole('button', { name: /다시 불러오기/ }));
    await waitFor(() => expect(screen.getByTestId('research-lead')).toBeTruthy());
  });

  it('has no controls besides the filter', async () => {
    render(<ResearchPage api={api(res({ articles: [art('a'), art('l', { tags: ['Launchpad'] })], sources: [src('Kaiko')] }))} />);
    await screen.findByTestId('research-lead');
    expect(screen.getAllByRole('button').every((b) => b.closest('[data-testid="research-filter"]'))).toBe(true);
    expect(document.querySelector('form, input, textarea')).toBeNull();
  });
});

describe('liveResearchApi', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const answer = (body: string, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));

  it('passes a well-formed answer through', async () => {
    answer(JSON.stringify(res({ articles: [art('a')] })));
    expect((await liveResearchApi.get()).articles).toHaveLength(1);
  });

  it('shows a 200 with the wrong shape as an error, not a crash', async () => {
    answer('{}');
    render(<ResearchPanel api={liveResearchApi} />);
    expect((await screen.findByRole('alert')).textContent).toContain('형식');
  });

  it('tells an older server apart from other failures', async () => {
    answer('{}', 404);
    await expect(liveResearchApi.get()).rejects.toThrow('새 빌드');
    answer('{}', 500);
    await expect(liveResearchApi.get()).rejects.toThrow('500');
  });
});
