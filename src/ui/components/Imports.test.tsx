// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useReducer } from 'react';
import { Pane } from './Pane';
import { Sidebar, importTitle, rowTag } from './Sidebar';
import { GEMINI_IMPORT_NOTE } from '../../shared/handoff';
import type { ProjectEntry, SessionEntry } from '../../shared/session-types';
import { initialState, newPane, reducer, type PaneState } from '../state';

Element.prototype.scrollIntoView = () => {};

const noop = () => {};
const e = (over: Partial<SessionEntry>): SessionEntry => ({ sessionId: 'x', account: 'x1', engine: 'grok', cwd: '/h', projectDir: '/p', file: '/f', title: 'Grok Bot 대화', lastModified: 1, sizeBytes: 0, imported: true, ...over });
const bot = e({ sessionId: 'grokbot-a', source: 'grokbot', readOnly: true });
// An index written before `source` existed: only the id says it is a Grok Bot conversation.
const oldBot = e({ sessionId: 'grokbot-old', title: '옛 대화' });
const projects = (sessions: SessionEntry[]): ProjectEntry[] => [{ cwd: '/h', name: 'h', pinned: false, sessions }];
const paneOn = (entry: SessionEntry): PaneState => ({ ...newPane('p1'), session: { sessionId: entry.sessionId, cwd: entry.cwd, account: entry.account, title: entry.title, engine: entry.engine ?? 'claude', sandbox: null } });
const actions = () => ({ pins: [], onRename: vi.fn(), onTogglePin: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onDuplicate: vi.fn() });

describe('Grok Bot conversation pane', () => {
  afterEach(cleanup);

  it.each([['source', bot], ['the grokbot- id alone (old index)', oldBot]])('by %s: read-only composer, the app note, and the handoff button dispatches grokbot_handoff', (_, entry) => {
    const dispatch = vi.fn();
    const send = vi.fn();
    render(<Pane pane={paneOn(entry)} app={{ pending: [], questions: [], codexAvailable: false, projects: projects([entry]) }} active closable={false} dispatch={dispatch} send={send} onClose={noop} />);
    const ta = screen.getByLabelText('메시지') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(true);
    expect(ta.placeholder).toBe('Grok Bot 앱 대화라 읽기만 할 수 있어요');
    expect(screen.getByTestId('composer-note').textContent).toBe('Grok Bot 앱 대화예요 — 여기서 이어 쓰려면 새 Grok 세션으로 옮겨요');
    fireEvent.click(screen.getByTestId('grokbot-handoff'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'grokbot_handoff', paneId: 'p1' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([['source', bot], ['the grokbot- id alone (old index)', oldBot]])('by %s: the title menu has no 복제 and 삭제 is disabled with the reason', (_, entry) => {
    const a = actions();
    render(<Pane pane={paneOn(entry)} app={{ pending: [], questions: [], codexAvailable: false, projects: projects([entry]) }} active closable={false} dispatch={noop} send={noop} onClose={noop} sessionActions={a} />);
    fireEvent.click(screen.getByTestId('session-chip-head'));
    expect(screen.queryByText('복제')).toBeNull();
    const del = screen.getByRole('menuitem', { name: '삭제…' });
    expect(del.getAttribute('aria-disabled')).toBe('true');
    expect(del.querySelector('.menu-note')?.textContent).toBe('Grok Bot 앱 기록은 AI-MSG에서 지울 수 없어요');
    fireEvent.click(del);
    expect(a.onDelete).not.toHaveBeenCalled();
  });

  it('a Gemini (agy) imported session shows the import note and can be sent to', () => {
    const gem = e({ sessionId: 'conv-1', engine: 'gemini', account: 'g1', cwd: '/w', title: 'agy 대화' });
    render(<Pane pane={paneOn(gem)} app={{ pending: [], questions: [], codexAvailable: false, projects: [{ cwd: '/w', name: 'w', pinned: false, sessions: [gem] }] }} active closable={false} dispatch={noop} send={noop} onClose={noop} />);
    expect(screen.getByTestId('composer-note').textContent).toBe(GEMINI_IMPORT_NOTE);
    expect((screen.getByLabelText('메시지') as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByTestId('grokbot-handoff')).toBeNull();
  });
});

describe('Grok conversation open in a terminal grok (heldBy)', () => {
  afterEach(cleanup);
  const held = e({ sessionId: 'g-1', title: '터미널 대화', heldBy: 'other' });

  it('the composer is read-only with a short placeholder and a note saying what frees it', () => {
    render(<Pane pane={paneOn(held)} app={{ pending: [], questions: [], codexAvailable: false, projects: projects([held]) }} active closable={false} dispatch={noop} send={noop} onClose={noop} />);
    const ta = screen.getByLabelText('메시지') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(true);
    expect(ta.placeholder).toBe('터미널 grok 이 쓰는 중 · 읽기만 가능');
    expect(screen.getByTestId('composer-note').textContent).toBe('터미널에서 grok 이 이 대화를 열고 있어요 — 그쪽 grok 을 끝내면 여기서 바로 이어 쓸 수 있어요');
  });

  it('once the terminal grok lets go, the composer opens again', () => {
    const { rerender } = render(<Pane pane={paneOn(held)} app={{ pending: [], questions: [], codexAvailable: false, projects: projects([held]) }} active closable={false} dispatch={noop} send={noop} onClose={noop} />);
    const free = { ...held, heldBy: undefined };
    rerender(<Pane pane={paneOn(free)} app={{ pending: [], questions: [], codexAvailable: false, projects: projects([free]) }} active closable={false} dispatch={noop} send={noop} onClose={noop} />);
    expect((screen.getByLabelText('메시지') as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByTestId('composer-note')).toBeNull();
  });

  it('the sidebar row carries 터미널에서 열림 and the tooltip says why', () => {
    expect(rowTag(held)).toBe('터미널에서 열림');
    expect(importTitle(held)).toContain('그쪽 grok 을 끝내면 AI-MSG 에서 이어 쓸 수 있어요');
    expect(rowTag({ ...held, engine: 'claude' })).toBeNull(); // Claude sessions open elsewhere sync silently
    expect(rowTag({ ...held, heldBy: undefined })).toBeNull();
  });
});

describe('Grok Bot handoff pane: the folder', () => {
  afterEach(cleanup);

  function Harness({ ps }: { ps: ProjectEntry[] }) {
    const [state, dispatch] = useReducer(reducer, { ...initialState, projects: ps, panes: [paneOn(bot)], activePaneId: 'p1' });
    return <Pane pane={state.panes[0]!} app={state} active closable={false} dispatch={dispatch} send={noop} onClose={noop} />;
  }

  it('starts in the most recent non-home project, shown with 작업 폴더 바꾸기 (opens the folder picker); never the home folder', () => {
    const work = e({ sessionId: 'c-1', engine: 'claude', imported: false, cwd: '/w/proj', lastModified: 5 });
    render(<Harness ps={[...projects([bot]), { cwd: '/w/proj', name: 'proj', pinned: false, sessions: [work] }]} />);
    fireEvent.click(screen.getByTestId('grokbot-handoff'));
    expect(screen.getByTestId('composer-note').textContent).toBe('작업 폴더: /w/proj — 보내기 전에 바꿀 수 있어요');
    expect((screen.getByLabelText('메시지') as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('grokbot-handoff-cwd'));
    expect(screen.getByRole('dialog', { name: '작업 폴더 바꾸기' })).toBeTruthy();
  });

  it('no other project: the composer waits for a folder instead of using the home folder', () => {
    render(<Harness ps={projects([bot])} />);
    fireEvent.click(screen.getByTestId('grokbot-handoff'));
    expect(screen.getByTestId('composer-note').textContent).toBe('작업 폴더를 골라 주세요 — 홈 폴더에서는 시작하지 않아요');
    const ta = screen.getByLabelText('메시지') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(true);
    expect(ta.placeholder).toBe('작업 폴더를 고른 뒤 보낼 수 있어요');
    expect(screen.getByTestId('grokbot-handoff-cwd')).toBeTruthy();
  });
});

describe('Sidebar menu on Grok Bot conversations', () => {
  afterEach(cleanup);

  it('복제 is hidden and 삭제 shows the reason — by source, and by the grokbot- id alone for an old index', () => {
    const onDuplicate = vi.fn();
    const grok = e({ sessionId: 'g-1', title: 'CLI 대화' });
    render(<Sidebar projects={projects([bot, oldBot, grok])} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onDelete={vi.fn()} onDuplicate={onDuplicate} />);
    const menuOf = (title: string) => {
      fireEvent.click(screen.getByText(title).closest('li')!.querySelector('[aria-label="세션 메뉴"]')!);
      const items = screen.getAllByRole('menuitem');
      const del = screen.getByRole('menuitem', { name: '삭제…' });
      const out = { names: items.map((b) => b.textContent), reason: del.getAttribute('title') };
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      return out;
    };
    for (const t of ['Grok Bot 대화', '옛 대화']) {
      const m = menuOf(t);
      expect(m.names).not.toContain('복제');
      expect(m.reason).toBe('Grok Bot 앱 기록은 AI-MSG에서 지울 수 없어요');
    }
    const cli = menuOf('CLI 대화');
    expect(cli.names).toContain('복제');
    expect(cli.reason).toBe('Grok CLI 기록은 AI-MSG에서 지울 수 없어요');
  });
});
