// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { GameStudio, HubMode, StudioAgent, StudioGame, StudioStage } from '../../../shared/hub-types';
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
    { job: 'q', title: '브롤 QA', account: 'b', model: 'opus', state: 'working', alive: true, line: '스크린샷 캡처 중', lineAt: iso(2), reportAt: null, reason: null, successor: null, game: 'brawl', gameTitle: 'Bored Brawl' },
    { job: 'art', title: null, account: 'codex', model: null, state: 'blocked', alive: false, line: 'x', lineAt: iso(40), reportAt: iso(39), reason: '라이선스 확인 필요', successor: null, game: 'neon-2', gameTitle: 'Neon 2' },
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
  it('shows one summary line, a compact party, and calm cartridges with a dot track and one next move', () => {
    render(<GameStudioHome studio={STUDIO} now={T} />);
    const lobby = screen.getByTestId('gs-lobby');
    expect(lobby.textContent).toContain('작업 중 1');
    expect(lobby.textContent).toContain('오너 확인 1');
    const agents = screen.getAllByTestId('gs-agent');
    expect(agents).toHaveLength(2);
    expect(within(agents[0]!).getByRole('button').textContent).toBe('q작업 중 · Bored Brawl');
    // task, line, job and time live in the hover/focus tooltip, linked to the face for screen readers
    const tip = within(agents[1]!).getByRole('tooltip', { hidden: true });
    expect(tip.textContent).toContain('라이선스 확인 필요');
    expect(within(agents[1]!).getByRole('button').getAttribute('aria-describedby')).toBe(tip.id);
    expect(screen.getByText('다른 프로젝트 에이전트 3')).toBeTruthy();

    const carts = screen.getAllByTestId('gs-cart');
    expect(carts).toHaveLength(2);
    const track = within(carts[0]!).getByRole('list', { name: /퀘스트 5\/7 · 지금 오너 승인/ });
    expect(track.querySelectorAll('.gs-dot')).toHaveLength(7);
    expect(track.querySelector('.gs-dot.active')?.getAttribute('aria-label')).toBe('오너 승인 진행 중');
    expect(carts[0]!.textContent).toContain('오너 승인 기다리는 중');
    expect(carts[0]!.querySelectorAll('.gs-badge')).toHaveLength(1);
    expect(within(carts[0]!).getByTestId('gs-next').textContent).toContain('오너 OK 필요');
    expect(within(carts[0]!).getByRole('link', { name: /플레이/ }).getAttribute('href')).toBe('/api/hub/file/scodex/brawl/dist/index.html');
    expect(within(carts[1]!).getByTestId('gs-next').textContent).toContain('막힘 해결');
    expect(carts[1]!.querySelector('.gs-badge')?.textContent).toBe('제작 중');
    expect(carts[1]!.textContent).toContain('에셋에서 막힘');
    // lineage, repos, tests sit behind 자세히
    const more = carts[1]!.querySelector('details.gs-more') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain('레퍼런스Bored Brawl');
    expect(screen.getByRole('link', { name: /파이프라인 문서/ }).getAttribute('href')).toBe('/api/hub/game-pipeline');
  });

  it('caps the loot and the quest log behind 더 보기, and opens a viewer', () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
    const loot = Array.from({ length: 9 }, (_, i) => ({ ...STUDIO.loot[i % 2]!, src: `/api/hub/file/sjobs/q/${i}.png`, name: `${i}.png` }));
    const feed = Array.from({ length: 8 }, (_, i) => ({ ...STUDIO.feed[0]!, text: `소식 ${i}` }));
    render(<GameStudioHome studio={{ ...STUDIO, loot, feed }} now={T} />);
    const sec = screen.getByRole('region', { name: '결과물' });
    expect(sec.querySelectorAll('.gs-thumb')).toHaveLength(6);
    expect(sec.querySelector('.gs-thumb-cap')?.textContent).toBe('Bored Brawl');
    fireEvent.click(within(sec).getByRole('button', { name: '더 보기 (3)' }));
    expect(sec.querySelectorAll('.gs-thumb')).toHaveLength(9);
    const log = screen.getByRole('region', { name: '퀘스트 로그' });
    expect(log.querySelectorAll('li')).toHaveLength(5);
    fireEvent.click(within(log).getByRole('button', { name: '더 보기 (3)' }));
    expect(log.querySelectorAll('li')).toHaveLength(8);
    fireEvent.click(within(sec).getByRole('button', { name: /Neon 2 1.png 크게 보기/ }));
    expect(document.querySelector('.gs-viewer')?.textContent).toContain('1.png');
  });

  it('kst formats Seoul time and reads 기록 없음 for nothing', () => {
    expect(kst('2026-11-01T03:05:00Z')).toBe('11-01 12:05');
    expect(kst(null)).toBe('기록 없음');
  });
});

describe('the party strip', () => {
  const base = STUDIO.agents[0]!;
  const agent = (over: Partial<StudioAgent>): StudioAgent => ({ ...base, alive: false, state: 'done', line: null, ...over });
  const strip = (agents: StudioAgent[]) => render(<GameStudioHome studio={{ ...STUDIO, agents }} now={T} />);
  const AGENTS = [
    agent({ job: 'live', state: 'working', alive: true }),
    agent({ job: 'ask', state: 'needs-owner', reason: '오너 결정 필요' }),
    agent({ job: 'fresh', state: 'blocked', reason: '게이트 미달' }),
    agent({ job: 'old', state: 'stopped', reason: '라이선스 없음' }),
    agent({ job: 'web-3', state: 'superseded', successor: 'web-4', reason: '게이트 미달' }),
    agent({ job: 'ok', state: 'done' }),
  ];

  it('keeps live, needs-owner and recent 막힘 out, in order, and folds the rest under 지난 작업', () => {
    strip(AGENTS);
    expect(screen.getAllByTestId('gs-agent').map((m) => m.querySelector('.gs-member-name')?.textContent)).toEqual(['live', 'ask', 'fresh']);
    expect(screen.queryByTestId('gs-past')).toBeNull();
    const toggle = screen.getByRole('button', { name: '지난 작업 (3)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(screen.getByTestId('gs-past')).getAllByTestId('gs-agent').map((m) => m.querySelector('.gs-member-name')?.textContent)).toEqual(['old', 'web-3', 'ok']);
  });

  it('labels each state; only 승인 필요 carries the red state class', () => {
    strip(AGENTS);
    fireEvent.click(screen.getByRole('button', { name: /지난 작업/ }));
    const labels = Object.fromEntries(screen.getAllByTestId('gs-agent').map((m) => [m.querySelector('.gs-member-name')?.textContent, m.querySelector('.gs-member-state b')?.textContent]));
    expect(labels).toEqual({ live: '작업 중', ask: '승인 필요', fresh: '막힘', old: '중단됨', 'web-3': '이어받음 → web-4', ok: '완료' });
    expect(document.querySelectorAll('.gs-member.st-needs-owner')).toHaveLength(1);
    expect(within(screen.getAllByTestId('gs-agent')[3]!).getByRole('tooltip', { hidden: true }).textContent).toContain('라이선스 없음');
  });

  it('says nothing is running when all work is past, and an idle job folds only once it has gone quiet', () => {
    strip([agent({ job: 'ok' })]);
    expect(screen.getByText('지금 작업 중인 에이전트 없음')).toBeTruthy();
    cleanup();
    strip([agent({ job: 'queued', state: 'idle', lineAt: null }), agent({ job: 'quiet', state: 'idle', lineAt: iso(200) })]);
    expect(screen.getAllByTestId('gs-agent').map((m) => m.querySelector('.gs-member-name')?.textContent)).toEqual(['queued']);
    expect(screen.getByRole('button', { name: '지난 작업 (1)' })).toBeTruthy();
  });

  it('calls a card 오너 OK 필요 only when the server says so, and the approval stage waits only then', () => {
    render(<GameStudioHome studio={{ ...STUDIO, games: [game({ nextAction: { text: '재빌드 후 재측정', owner: false } })] }} now={T} />);
    const cart = screen.getByTestId('gs-cart');
    expect(within(cart).getByTestId('gs-next').textContent).toContain('다음 행동');
    expect(cart.textContent).toContain('승인 요청 전');
    expect(cart.textContent).not.toContain('오너 승인 기다리는 중');
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
