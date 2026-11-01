// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { GameStudio, HubMode, StudioGame, StudioStage } from '../../../shared/hub-types';
import { HubPage } from '../HubPage';
import { GameStudioHome, kst } from './GameStudioHome';

vi.mock('../sr/SrPanel', () => ({ SrPanel: () => null }));

const T = Date.parse('2026-11-01T03:00:00Z');
const iso = (minAgo: number) => new Date(T - minAgo * 60_000).toISOString();
const LABELS = ['콘셉트', '에셋', '빌드', '테스트·검증', '미리보기', '오너 승인', '출시'];
const IDS = ['concept', 'assets', 'build', 'test', 'preview', 'approval', 'release'] as const;
const stages = (states: StudioStage['state'][]): StudioStage[] => IDS.map((id, i) => ({ id, label: LABELS[i]!, state: states[i]!, found: 1, total: 1, at: iso(60) }));

const game = (over: Partial<StudioGame>): StudioGame => ({
  id: 'brawl', title: 'Bored Brawl', titleKo: '보어드 브롤', genre: '아레나', engine: 'Three.js', status: 'candidate', reference: null, referenceTitle: null, version: '3.0',
  cover: { src: '/api/hub/file/sjobs/q/a.png', kind: 'image', group: 'screenshots', name: 'a.png', at: iso(30), game: 'brawl', gameTitle: 'Bored Brawl', job: 'q' },
  stages: stages(['done', 'done', 'done', 'done', 'done', 'active', 'todo']), nextAction: { text: 'v1 공개 여부 결정', owner: true },
  approvals: [{ what: 'v1 공개', state: 'pending', at: null }], play: { label: '플레이', href: '/api/hub/file/scodex/brawl/dist/index.html' }, previews: [],
  repos: [{ label: 'web', branch: 'main', remote: null, readonly: true }], tests: [{ label: 'unit', at: iso(90), found: true }], jobs: ['q'], artifacts: [], lastAt: iso(5), facts: null, ...over,
});

const STUDIO: GameStudio = {
  games: [game({}), game({ id: 'neon-2', title: 'Neon 2', status: 'building', reference: 'brawl', referenceTitle: 'Bored Brawl', cover: null, play: null, approvals: [], nextAction: { text: '에셋 라이선스 정리', owner: false }, stages: stages(['done', 'blocked', 'todo', 'todo', 'todo', 'todo', 'todo']) })],
  agents: [
    { job: 'q', title: '브롤 QA', account: 'b', model: 'opus', state: 'working', alive: true, line: '스크린샷 캡처 중', lineAt: iso(2), reportAt: null, reason: null, game: 'brawl', gameTitle: 'Bored Brawl' },
    { job: 'art', title: null, account: 'codex', model: null, state: 'blocked', alive: false, line: 'x', lineAt: iso(40), reportAt: iso(39), reason: '라이선스 확인 필요', game: 'neon-2', gameTitle: 'Neon 2' },
  ],
  others: { count: 3, working: 1, names: ['a', 'b', 'c'] },
  loot: [
    { src: '/api/hub/file/sjobs/q/a.png', kind: 'image', group: 'screenshots', name: 'a.png', at: iso(30), game: 'brawl', gameTitle: 'Bored Brawl', job: 'q' },
    { src: '/api/hub/file/sjobs/art/c.png', kind: 'image', group: 'concept', name: 'c.png', at: iso(50), game: 'neon-2', gameTitle: 'Neon 2', job: 'art' },
  ],
  feed: [{ at: iso(2), game: 'brawl', job: 'q', kind: 'agent', text: 'Claude b · q 작업 중', level: 'info' }],
  summary: { working: 1, owner: 1, released: 0, blocked: 1, games: 2 },
  pipeline: { doc: '/api/hub/game-pipeline', template: true, manifests: 2 },
  generatedAt: iso(0),
};

afterEach(cleanup);

describe('GameStudioHome', () => {
  it('shows the lobby line, the party, one cartridge per game with its quest track and callout', () => {
    render(<GameStudioHome studio={STUDIO} now={T} />);
    const lobby = screen.getByTestId('gs-lobby');
    expect(lobby.textContent).toContain('1작업 중 에이전트');
    expect(lobby.textContent).toContain('1오너 확인 필요');
    const agents = screen.getAllByTestId('gs-agent');
    expect(agents).toHaveLength(2);
    expect(agents[0]!.textContent).toContain('Claude b');
    expect(agents[0]!.textContent).toContain('작업 중');
    expect(agents[1]!.textContent).toContain('라이선스 확인 필요');
    expect(screen.getByText(/다른 프로젝트 에이전트 3 · 작업 중 1/)).toBeTruthy();

    const carts = screen.getAllByTestId('gs-cart');
    expect(carts).toHaveLength(2);
    const track = within(carts[0]!).getByRole('list', { name: /퀘스트 5\/7 · 지금 오너 승인/ });
    expect(track.querySelectorAll('.gs-node')).toHaveLength(7);
    expect(within(carts[0]!).getByTestId('gs-next').textContent).toContain('오너 OK 필요');
    expect(within(carts[0]!).getByRole('link', { name: /플레이/ }).getAttribute('href')).toBe('/api/hub/file/scodex/brawl/dist/index.html');
    expect(within(carts[1]!).getByTestId('gs-next').textContent).toContain('막힘 해결');
    expect(within(carts[1]!).getByText(/레퍼런스/).textContent).toContain('Bored Brawl');
    expect(screen.getByRole('link', { name: /파이프라인 문서/ }).getAttribute('href')).toBe('/api/hub/game-pipeline');
  });

  it('filters the loot by game and opens a viewer', () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
    render(<GameStudioHome studio={STUDIO} now={T} />);
    const loot = screen.getByRole('region', { name: '획득한 결과물' });
    expect(loot.querySelectorAll('.gs-thumb')).toHaveLength(2);
    fireEvent.click(within(loot).getByRole('button', { name: 'Neon 2' }));
    expect(loot.querySelectorAll('.gs-thumb')).toHaveLength(1);
    fireEvent.click(within(loot).getByRole('button', { name: /Neon 2 c.png 크게 보기/ }));
    expect(document.querySelector('.gs-viewer')?.textContent).toContain('c.png');
  });

  it('kst formats Seoul time and reads 기록 없음 for nothing', () => {
    expect(kst('2026-11-01T03:05:00Z')).toBe('11-01 12:05');
    expect(kst(null)).toBe('기록 없음');
  });
});

describe('HubPage with the studio', () => {
  it('leads with the lobby and folds the old ops view under 상세 기록', () => {
    const mode: HubMode = { id: 'game', name: '게임 스튜디오', state: 'ok', lastActivity: iso(5), metrics: {}, alerts: [], links: [], sources: [], page: { headline: '옛 헤드라인', decision: '옛 결정', kpis: [], sections: [] }, studio: STUDIO };
    render(<HubPage modeKey="game" mode={mode} now={T} error={null} loading={false} onRefresh={() => {}} generatedAt={iso(0)} />);
    expect(screen.getByTestId('game-studio')).toBeTruthy();
    const detail = screen.getByTestId('gs-detail') as HTMLDetailsElement;
    expect(detail.open).toBe(false);
    expect(within(detail).getByTestId('hub-lead').textContent).toContain('옛 헤드라인');
  });
});
