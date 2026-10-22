// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MessageView, errorSummary } from './MessageView';
import { codeFileName } from '../codeWrap';
import { DEFAULT_PREFS, PREFS_KEY } from '../prefs';
import { initialState, reducer, type AppState, type ChatItem } from '../state';
import type { ServerMessage } from '../../shared/protocol';
import { parseUserText } from '../injected';
/** The panel a meta-line opener (aria-controls) unfolds. */
const panelOf = (el: Element) => document.getElementById(el.getAttribute('aria-controls')!)!;

describe('MessageView', () => {
  afterEach(cleanup);

  it('a Stop-hook item is a muted system row with the feedback collapsed until clicked — not a user bubble', () => {
    const { container, getByTestId } = render(<MessageView item={{ kind: 'system', source: 'Stop', label: 'Stop 훅이 이어서 진행시킴', text: 'Stop hook feedback:\n[verify] 테스트가 실패합니다' }} />);
    const row = getByTestId('system-row');
    expect(row.classList.contains('system')).toBe(true);
    expect(container.querySelector('.msg.user')).toBeNull();
    expect(row.querySelector('summary')?.textContent).toContain('Stop 훅이 이어서 진행시킴');
    const details = row.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(row.querySelector('.sys-body')!.textContent).toBe('[verify] 테스트가 실패합니다');
    fireEvent.click(row.querySelector('summary')!);
    expect(details.open).toBe(true);
  });

  it('strips only the hook header, not the colons inside the message', () => {
    const { getByTestId } = render(<MessageView item={{ kind: 'system', source: 'PreToolUse', label: 'PreToolUse 훅 메시지', text: 'PreToolUse:Bash hook blocking error from command: "x": denied' }} />);
    const row = getByTestId('system-row');
    expect(row.querySelector('summary')?.textContent).toContain('PreToolUse 훅 메시지');
    expect(row.querySelector('.sys-body')!.textContent).toBe('"x": denied');
  });

  it("another session's message keeps its whole text as the collapsed body", () => {
    const text = 'Another Claude session sent a message:\n<agent-message from="a1">보고: 끝</agent-message>';
    const { getByTestId } = render(<MessageView item={{ kind: 'system', source: 'peer', label: '다른 세션의 메시지', text }} />);
    expect(getByTestId('system-row').querySelector('summary')?.textContent).toContain('다른 세션의 메시지');
    expect(getByTestId('system-row').querySelector('.sys-body')!.textContent).toBe(text);
  });

  it('renders markdown images as links, never as <img> (no auto-loading remote URLs)', () => {
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'see ![pixel](https://evil.example/p.png?leak=1) here', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    expect(container.querySelector('img')).toBeNull();
    const a = container.querySelector('a[href="https://evil.example/p.png?leak=1"]');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('rel')).toBe('noreferrer noopener');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.textContent).toContain('pixel');
  });

  it('renders GFM: a pipe table becomes a scrollable <table>, plus strikethrough and task lists', () => {
    const text = '| 계정 | 남음 |\n|---|---|\n| A | 42% |\n| B | 7% |\n\n~~old~~\n\n- [x] done\n- [ ] todo';
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const table = container.querySelector('.md-table > table');
    expect(table).not.toBeNull();
    expect([...table!.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['계정', '남음']);
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('del')?.textContent).toBe('old');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.textContent).not.toContain('|---|');
  });

  it('shows the role-distribution badge for subagent/offload calls and attachment chips on user messages', () => {
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'done', toolCalls: [
      { toolUseId: '1', name: 'Agent', input: { subagent_type: 'explore', model: 'sonnet', description: 'find' }, result: 'ok', isError: false },
      { toolUseId: '2', name: 'Bash', input: { command: 'offload cross "x"' }, result: 'ok', isError: false },
    ], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    expect(container.querySelector('.role-badge')?.textContent).toContain('explore');
    expect(container.querySelector('.role-badge')?.textContent).toContain('offload cross');
    cleanup();
    const u = render(<MessageView item={{ kind: 'user', text: 'look', attachments: [{ id: '11111111-2222-3333-4444-555555555555', name: 'shot.png', isImage: false }] }} />);
    expect(u.container.querySelector('.attach-tile .attach-name')?.textContent).toBe('shot.png');
    expect(u.container.querySelector('.attach-tile')?.classList.contains('image')).toBe(true);
  });
});

describe('MessageView · image placeholders in a user bubble', () => {
  afterEach(cleanup);
  it('hides lines that are only [이미지] / [Image #1]; images without a thumbnail become one count pill', () => {
    const { container, getByTestId } = render(<MessageView item={{ kind: 'user', text: '이 화면 봐줘\n[이미지]\n[이미지]\n[Image #3]' }} />);
    expect(container.querySelector('.msg.user pre')?.textContent).toBe('이 화면 봐줘');
    expect(getByTestId('image-count').textContent).toContain('이미지 3장');
  });
  it('with thumbnails only the tiles show; a message of images only has no bubble', () => {
    const att = { id: '11111111-2222-3333-4444-555555555555', name: 'shot.png', isImage: true };
    const { container, queryByTestId } = render(<MessageView item={{ kind: 'user', text: '[이미지]', attachments: [att] }} />);
    expect(container.querySelectorAll('.msg-attachments > *')).toHaveLength(1);
    expect(queryByTestId('image-count')).toBeNull();
    expect(container.querySelector('.msg.user pre')).toBeNull();
  });
  it('an inline [이미지] inside a sentence is left alone', () => {
    const { container } = render(<MessageView item={{ kind: 'user', text: '여기 [이미지] 처럼 써' }} />);
    expect(container.querySelector('.msg.user pre')?.textContent).toBe('여기 [이미지] 처럼 써');
  });
});

describe('MessageView · subagents fold on the meta line', () => {
  afterEach(cleanup);
  it('"서브에이전트 N · offload M" on the line; the chips show only once it is pressed', () => {
    const { getByTestId } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'done', toolCalls: [
      { toolUseId: '1', name: 'Agent', input: { subagent_type: 'explore', model: 'sonnet', description: 'find' }, result: 'ok', isError: false },
      { toolUseId: '2', name: 'Agent', input: { subagent_type: 'executor', description: 'fix' }, result: 'ok', isError: false },
      { toolUseId: '3', name: 'Bash', input: { command: 'offload cross "x"' }, result: 'ok', isError: false },
    ], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const roles = getByTestId('roles');
    expect(roles.textContent).toContain('서브에이전트 2 · offload 1');
    expect(panelOf(roles).hidden).toBe(true);
    fireEvent.click(roles);
    expect(panelOf(roles).hidden).toBe(false);
    expect(panelOf(roles).querySelectorAll('.chip')).toHaveLength(3);
  });
});

describe('MessageView · meta line separators and subagent lines', () => {
  beforeEach(() => { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: false })); });
  afterEach(() => { cleanup(); localStorage.removeItem(PREFS_KEY); });
  const agent = (id: string, type: string, result: string | null = 'done') => ({ toolUseId: id, name: 'Agent', input: { subagent_type: type, description: `${type} 작업`, prompt: 'p' }, result, isError: false });
  const bash = (id: string) => ({ toolUseId: id, name: 'Bash', input: { command: 'ls' }, result: 'out', isError: false });
  const reply = (extra: object) => ({ kind: 'assistant' as const, turnId: 't', text: 'ok', model: 'claude-opus-5-5', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], ...extra });

  it('exactly one dot between items: none before the first, none doubled, no empty item', () => {
    const badge = { account: 'a', model: 'opus', reason: 'r', modelNote: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } };
    for (const item of [
      reply({ thinking: { text: '음', redacted: false, startedAt: 0, ms: 8000 }, toolCalls: [bash('1'), bash('2'), agent('3', 'executor')] }),
      reply({ badge, thinking: { text: '', redacted: true, startedAt: null, ms: null }, toolCalls: [bash('1')] }),
      reply({ toolCalls: [agent('1', 'explore'), bash('2')] }),
    ]) {
      const { getByRole } = render(<MessageView item={item as never} />);
      const line = getByRole('group');
      const cells = [...line.querySelectorAll(':scope > .meta-cell')];
      expect(cells.length).toBeGreaterThan(1);
      expect(line.querySelectorAll('.meta-sep')).toHaveLength(cells.length - 1);
      expect(cells[0]!.querySelector('.meta-sep')).toBeNull();
      for (const c of cells.slice(1)) expect(c.firstElementChild?.className).toBe('meta-sep');
      for (const c of cells) expect(c.textContent!.replace('·', '').trim()).not.toBe('');
      expect(line.textContent).not.toMatch(/·\s*·/);
      cleanup();
    }
  });

  it('CSS: a wrapped meta line hides its leading dot (lead pulled left and clipped, first cell padded back)', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8').replace(/\s+/g, ' ');
    const rule = css.match(/\.turn-meta \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/--meta-lead: \d+px/);
    expect(rule).toContain('margin-left: calc(-1 * var(--meta-lead))');
    expect(rule).toContain('clip-path: inset(-12px -12px -12px var(--meta-lead))');
    expect(css).toMatch(/\.meta-cell:first-child \{ padding-left: var\(--meta-lead\); \}/);
  });

  it('a finished subagent is one line naming its type once; the result still opens under it', () => {
    const { getByTestId } = render(<MessageView item={reply({ toolCalls: [agent('1', 'executor')] })} />);
    const card = getByTestId('agent-card');
    expect(card.querySelector('.agent-type')).toBeNull();
    expect(card.textContent!.match(/executor/g)).toHaveLength(1);
    const open = card.querySelector('.agent-open')!;
    expect(open.textContent).toContain('결과');
    expect(panelOf(open).hidden).toBe(true);
    fireEvent.click(open);
    expect(panelOf(open).hidden).toBe(false);
    expect(panelOf(open).textContent).toContain('done');
  });

  it('an open first subagent stays open when a second Agent call joins it (no remount into the group)', () => {
    const running = (id: string, type: string) => agent(id, type, null);
    const { getAllByTestId, rerender } = render(<MessageView item={reply({ streaming: true, text: '', toolCalls: [running('1', 'executor')] })} />);
    const open = getAllByTestId('agent-card')[0]!.querySelector('.agent-open')!;
    fireEvent.click(open);
    expect(panelOf(open).hidden).toBe(false);
    rerender(<MessageView item={reply({ streaming: true, text: '', toolCalls: [running('1', 'executor'), running('2', 'code-reviewer')] })} />);
    const cards = getAllByTestId('agent-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.closest('[data-testid="agent-group"]')).not.toBeNull();
    expect(cards[0]!.querySelector('.agent-open')).toBe(open);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(panelOf(open).hidden).toBe(false);
  });

  it('two or more subagents in a row share one group; a single one stands alone', () => {
    const many = render(<MessageView item={reply({ toolCalls: [agent('1', 'executor'), agent('2', 'code-reviewer'), bash('3')] })} />);
    expect(many.getAllByTestId('agent-group')).toHaveLength(1);
    expect(many.getByTestId('agent-group').querySelectorAll('[data-testid="agent-card"]')).toHaveLength(2);
    cleanup();
    const one = render(<MessageView item={reply({ toolCalls: [agent('1', 'executor')] })} />);
    expect(one.queryByTestId('agent-group')).toBeNull();
  });

  it('the account reads as text on the meta line ("계정 A"), keeping its tooltip', () => {
    const badge = { account: 'a', model: 'opus', reason: 'r', modelNote: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } };
    const { container } = render(<MessageView item={reply({ badge }) as never} />);
    const acct = container.querySelector('.turn-meta .acct-text')!;
    expect(acct.textContent).toBe('계정 A');
    expect(acct.getAttribute('title')).toContain('계정 A');
    expect(container.querySelector('.turn-meta .acct')).toBeNull();
  });

  it('before any text, the meta line ("생각하는 중…") comes first and the cursor waits under it', () => {
    const { container, getByTestId } = render(<MessageView item={reply({ text: '', streaming: true, thinking: { text: '', redacted: false, startedAt: Date.now(), ms: null } })} />);
    const cursor = container.querySelector('.cursor')!;
    expect(getByTestId('turn-meta').compareDocumentPosition(cursor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    const writing = render(<MessageView item={reply({ text: '쓰는 중', streaming: true })} />);
    const c2 = writing.container.querySelector('.cursor')!;
    expect(c2.compareDocumentPosition(writing.getByTestId('turn-meta')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('MessageView tool lines (Desktop style)', () => {
  afterEach(cleanup);
  const tc = (id: string, name: string, input: unknown, extra = {}) => ({ toolUseId: id, name, input, result: 'out', isError: false, ...extra });

  it('tool calls fold into one 작업 기록 line that expands to per-call lines (one or several)', () => {
    const one = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'ok', toolCalls: [tc('1', 'Bash', { command: 'npm test', description: 'Run tests' })], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const line = one.container.querySelector('[data-testid="tool-call"]') as HTMLDetailsElement;
    expect(line.querySelector('summary')?.textContent).toContain('Run tests');
    expect(line.open).toBe(false);
    expect(one.container.querySelector('.tool-group')).toBeNull();
    expect(one.getByTestId('work-log').getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(one.getByTestId('work-log')).hidden).toBe(true);
    cleanup();
    const many = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: '', toolCalls: [tc('1', 'Bash', { command: 'a' }), tc('2', 'Bash', { command: 'b' }, { isError: true })], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const opener = many.getByTestId('work-log');
    expect(opener.textContent).toContain('실행된 명령 2개');
    expect(opener.textContent).toContain('오류 1');
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(opener).querySelectorAll('[data-testid="tool-call"]')).toHaveLength(2);
    fireEvent.click(opener);
    expect(panelOf(opener).hidden).toBe(false);
    expect(many.container.querySelector('.markdown')).toBeNull();
  });

  it('a call without a result shows 실행 중 only while the turn streams', () => {
    const item = { kind: 'assistant' as const, turnId: 't', text: '', toolCalls: [{ toolUseId: '1', name: 'Read', input: { file_path: '/w/x.ts' }, result: null, isError: false }], badge: null, streaming: true, error: null, notes: [], attempts: [] };
    const live = render(<MessageView item={item} />);
    expect(live.container.querySelector('.tool-call.running')?.textContent).toContain('실행 중');
    cleanup();
    const done = render(<MessageView item={{ ...item, streaming: false }} />);
    expect(done.container.querySelector('.tool-call')?.textContent).not.toContain('실행 중');
  });
});

describe('MessageView injected user turns', () => {
  afterEach(cleanup);
  const notif = '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "research" finished</summary>\n<result>**done** here</result>\n</task-notification>';

  it('renders a task-notification turn as a compact system line, not a raw user bubble', () => {
    const { container } = render(<MessageView item={{ kind: 'user', text: notif }} />);
    expect(container.querySelector('.msg.user')).toBeNull();
    const line = container.querySelector('[data-testid="sys-notice"]') as HTMLDetailsElement;
    expect(line.open).toBe(false);
    expect(line.querySelector('summary')?.textContent).toContain('백그라운드 작업 완료');
    expect(line.querySelector('summary')?.textContent).toContain('Agent "research" finished');
    expect(line.querySelector('summary')?.textContent).not.toContain('<task-id>');
    // expanded: the result as markdown plus the verbatim block
    expect(line.querySelector('.sys-detail strong')?.textContent).toBe('done');
    expect(line.querySelector('.sys-raw pre')?.textContent).toBe(notif);
  });

  it('an absorbed notice row renders nothing; the reply after it shows the notice on its meta line, unfolding to the summary', () => {
    const gone = render(<MessageView item={{ kind: 'user', text: notif }} absorbed />);
    expect(gone.container.innerHTML).toBe('');
    cleanup();
    const { notices } = parseUserText(notif);
    const { getByTestId, getByRole } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'ok', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} notices={notices} />);
    const item = getByTestId('meta-notice');
    expect(getByRole('group').contains(item)).toBe(true);
    expect(item.textContent).toContain('백그라운드 완료');
    expect(panelOf(item).textContent).toContain('Agent "research" finished');
  });

  it('strips system-reminder from a user bubble; a reminder-only turn renders nothing', () => {
    const a = render(<MessageView item={{ kind: 'user', text: 'hi\n<system-reminder>secret ctx</system-reminder>' }} />);
    expect(a.container.querySelector('.msg.user pre')?.textContent).toBe('hi');
    expect(a.container.textContent).not.toContain('secret ctx');
    cleanup();
    const b = render(<MessageView item={{ kind: 'user', text: '<system-reminder>only</system-reminder>' }} />);
    expect(b.container.innerHTML).toBe('');
  });
});

describe('MessageView code blocks and turn footer', () => {
  afterEach(cleanup);

  it('fenced code gets a language label and a copy button; inline code stays a chip', () => {
    const text = 'run `npm test` then:\n\n```ts\nconst a = 1;\n```\n\n```\nplain\n```';
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const blocks = container.querySelectorAll('.code-block');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.querySelector('.code-lang')?.textContent).toBe('ts');
    expect(blocks[0]!.querySelector('pre code')?.textContent).toContain('const a = 1;');
    expect(blocks[1]!.querySelector('.code-lang')?.textContent).toBe('text');
    expect(container.querySelector('p > code')?.textContent).toBe('npm test');
  });

  it('an inline path breaks after each / (a <wbr>); its text is unchanged; fenced code gets none', () => {
    const text = 'see `src/ui/components/App.tsx` and\n\n```\na/b\n```';
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const code = container.querySelector('p code')!;
    expect(code.textContent).toBe('src/ui/components/App.tsx');
    expect(code.querySelectorAll('wbr')).toHaveLength(3);
    expect(container.querySelector('pre code wbr')).toBeNull();
  });

  it('copy button copies the code text and confirms', async () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const { container, findByText } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: '```sh\necho hi\n```', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    fireEvent.click(container.querySelector('.code-copy')!);
    expect(await findByText('복사됨')).toBeTruthy();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('turn badge keeps account, model, all four token counts and the reason', () => {
    const badge = { account: 'b', model: 'opus', reason: '가장 여유', usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 56000, cacheCreationTokens: 0 } } as never;
    const { container } = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'ok', toolCalls: [], badge, streaming: false, error: null, notes: [], attempts: [] }} />);
    const t = container.querySelector('.turn-foot')?.textContent ?? '';
    for (const s of ['B', '입력 1.2k', '출력 340', '캐시 읽기 56.0k', '캐시 쓰기 0', '가장 여유']) expect(t).toContain(s);
  });
});

describe('code block 저장 · 줄바꿈', () => {
  afterEach(() => { cleanup(); localStorage.removeItem('deck.codeWrap'); vi.restoreAllMocks(); });
  const reply = (text: string) => ({ kind: 'assistant' as const, turnId: 't', text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] });

  it('codeFileName: code-N with the language extension, .txt when unknown', () => {
    expect(codeFileName('ts', 1)).toBe('code-1.ts');
    expect(codeFileName('python', 2)).toBe('code-2.py');
    expect(codeFileName('bash', 3)).toBe('code-3.sh');
    expect(codeFileName('json', 4)).toBe('code-4.json');
    expect(codeFileName('md', 5)).toBe('code-5.md');
    expect(codeFileName('', 6)).toBe('code-6.txt');
    expect(codeFileName('cobol', 7)).toBe('code-7.txt');
  });

  it('저장 downloads the block through <a download> named by its language', async () => {
    const created = vi.fn((_b: Blob) => 'blob:x');
    URL.createObjectURL = created as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    let name = '';
    let blob: Blob | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { name = this.download; blob = created.mock.calls.at(-1)![0]; });
    const { getByRole } = render(<MessageView item={reply('```py\nprint(1)\n```')} />);
    fireEvent.click(getByRole('button', { name: '저장' }));
    expect(name).toMatch(/^code-\d+\.py$/);
    expect(await blob!.text()).toBe('print(1)');
  });

  it('줄바꿈 is one device-wide switch (deck.codeWrap): every block wraps, and it is remembered', () => {
    const { container, getAllByRole, unmount } = render(<>
      <MessageView item={reply('```ts\nconst a = 1;\n```')} />
      <MessageView item={reply('```\nplain\n```')} />
    </>);
    const toggles = getAllByRole('button', { name: '줄바꿈' });
    expect(toggles).toHaveLength(2);
    expect(toggles[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelectorAll('pre.code-wrap')).toHaveLength(0);
    fireEvent.click(toggles[0]!);
    expect(container.querySelectorAll('pre.code-wrap')).toHaveLength(2);
    expect(toggles[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('deck.codeWrap')).toBe('1');
    unmount();
    const again = render(<MessageView item={reply('```\nx\n```')} />);
    expect(again.container.querySelector('pre.code-wrap')).not.toBeNull();
  });
});

describe('MessageView · 간결 모드 live text', () => {
  beforeEach(() => { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: true })); });
  afterEach(() => { cleanup(); localStorage.removeItem(PREFS_KEY); });
  const call = (id: string, textAt: number) => ({ toolUseId: id, name: 'Bash', input: { command: 'npm test' }, result: 'SECRET-OUTPUT', isError: false, textAt });
  const turn = (text: string, toolCalls: ReturnType<typeof call>[] = [], streaming = true, extra: object = {}) =>
    ({ kind: 'assistant' as const, turnId: 't', text, toolCalls, badge: null, streaming, error: null, notes: [], attempts: [], ...extra });

  it('streams the answer as it arrives, before the turn ends (no 처리 중 line once text shows)', () => {
    const { container, queryByTestId } = render(<MessageView item={turn('결론부터: 고쳤어요')} />);
    expect(container.querySelector('.markdown')?.textContent).toBe('결론부터: 고쳤어요');
    expect(container.querySelector('.cursor')).not.toBeNull();
    expect(queryByTestId('concise-progress')).toBeNull();
  });

  it('a tool call folds the text before it into a gray lead line; the next stretch streams; tool output and thinking stay hidden', () => {
    const before = '먼저 테스트부터 볼게요.';
    const { container, getByTestId, rerender } = render(<MessageView item={turn(before, [call('1', before.length)], true, { thinking: { text: 'SECRET-THOUGHT', redacted: false, startedAt: 0, ms: 1000 } })} />);
    expect(getByTestId('concise-lead').textContent).toBe(before);
    expect(getByTestId('work-log').textContent).toContain('계속 작업 중 · 단계 1');
    expect(container.querySelector('.markdown:not(.thinking-body)')).toBeNull();
    // Tool bodies stay folded inside the collapsed 작업 기록 line (as before).
    expect(getByTestId('work-log').getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(getByTestId('work-log')).hidden).toBe(true);
    // …and nothing of the output shows outside that folded line.
    const outside = container.cloneNode(true) as HTMLElement;
    outside.querySelector('.work-log-body')!.remove();
    expect(outside.textContent).not.toContain('SECRET-OUTPUT');
    expect(container.textContent).not.toContain('SECRET-THOUGHT');
    rerender(<MessageView item={turn(`${before}\n\n원인은 오타였어요`, [call('1', before.length)])} />);
    expect(getByTestId('concise-lead').textContent).toBe(before);
    const md = container.querySelectorAll('.markdown');
    expect(md).toHaveLength(1);
    expect(md[0]!.textContent).toBe('원인은 오타였어요');
    expect(container.querySelector('.cursor')).not.toBeNull();
  });

  it('when the turn ends: one reply with the whole text, like before (no lead line, no progress, no cursor)', () => {
    const before = '먼저 테스트부터 볼게요.';
    const text = `${before}\n\n원인은 오타였어요`;
    const { container, queryByTestId } = render(<MessageView item={turn(text, [call('1', before.length)], false)} />);
    expect(queryByTestId('concise-progress')).toBeNull();
    expect(queryByTestId('concise-lead')).toBeNull();
    expect(container.querySelector('.cursor')).toBeNull();
    const md = container.querySelectorAll('.markdown');
    expect(md).toHaveLength(1);
    expect(md[0]!.textContent).toContain(before);
    expect(md[0]!.textContent).toContain('원인은 오타였어요');
  });

  it('full mode is unchanged: the whole text streams with the tool calls, no lead line', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: false }));
    const before = '먼저 테스트부터 볼게요.';
    const { container, queryByTestId } = render(<MessageView item={turn(`${before}\n\n원인은`, [call('1', before.length)])} />);
    expect(queryByTestId('concise-progress')).toBeNull();
    expect(container.querySelector('.markdown')?.textContent).toContain(before);
    expect(container.querySelector('.markdown')?.textContent).toContain('원인은');
    expect(container.querySelector('.cursor')).not.toBeNull();
  });

  it('deck-choices in the live stretch do not shift the fold point (textAt counts the raw text)', () => {
    const before = '먼저 찾아볼게요.';
    const text = `${before}\n\n어느 쪽으로 할까요?\n\n\`\`\`deck-choices\n? 고르기\n- 가\n- 나\n\`\`\``;
    const { container, getByTestId } = render(<MessageView item={turn(text, [call('1', before.length)])} />);
    expect(getByTestId('concise-lead').textContent).toBe(before);
    const md = container.querySelectorAll('.markdown');
    expect(md).toHaveLength(1);
    expect(md[0]!.textContent).toBe('어느 쪽으로 할까요?');
    expect(container.textContent).not.toContain('deck-choices');
  });

  it('reducer to screen: delta → tool_call → delta shows the first stretch as the lead and streams the second', () => {
    const scope = { turnId: 't1', sessionId: null, cwd: '/w' };
    const msgs: ServerMessage[] = [
      { type: 'turn_started', ...scope, account: 'a', model: 'opus', reason: 'r', attempt: 0 },
      { type: 'delta', ...scope, text: '먼저 테스트부터 ' },
      { type: 'delta', ...scope, text: '볼게요.' },
      { type: 'tool_call', ...scope, toolUseId: 'u1', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_result', ...scope, toolUseId: 'u1', content: 'SECRET-OUTPUT', isError: false },
      { type: 'delta', ...scope, text: '원인은 ' },
      { type: 'delta', ...scope, text: '오타였어요' },
    ];
    let s: AppState = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: '새 세션' });
    s = reducer(s, { type: 'sent', text: '왜 실패해?' });
    for (const m of msgs) s = reducer(s, { type: 'server', msg: m });
    const item = s.panes[0]!.items.findLast((it): it is Extract<ChatItem, { kind: 'assistant' }> => it.kind === 'assistant')!;
    expect(item.streaming).toBe(true);
    const { container, getByTestId } = render(<MessageView item={item} />);
    expect(getByTestId('concise-lead').textContent).toBe('먼저 테스트부터 볼게요.');
    expect(getByTestId('work-log').textContent).toContain('단계 1');
    const md = container.querySelectorAll('.markdown');
    expect(md).toHaveLength(1);
    expect(md[0]!.textContent).toBe('원인은 오타였어요');
  });
});

describe('MessageView · 대화 본문 다듬기', () => {
  afterEach(cleanup);
  const reply = (extra: object = {}) => ({ kind: 'assistant' as const, turnId: 't', text: 'ok', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], ...extra });
  const bash = (id: string) => ({ toolUseId: id, name: 'Bash', input: { command: 'ls' }, result: 'out', isError: false });

  it('thinking and tool calls sit side by side on the one meta line; each › opens its own panel under it', () => {
    const { getByTestId, getByRole, queryByTestId } = render(<MessageView item={reply({ thinking: { text: '먼저 확인', redacted: false, startedAt: 0, ms: 12000 }, toolCalls: [bash('1'), bash('2')] })} />);
    const line = getByRole('group');
    const think = getByTestId('thinking');
    const tools = getByTestId('work-log');
    expect(line.contains(think) && line.contains(tools)).toBe(true);
    expect(line.textContent).toMatch(/12초 동안 생각함.*·.*실행된 명령 2개/);
    expect(panelOf(think).textContent).toContain('먼저 확인');
    expect(panelOf(tools).querySelectorAll('[data-testid="tool-call"]')).toHaveLength(2);
    fireEvent.click(tools);
    expect(panelOf(tools).hidden).toBe(false);
    expect(panelOf(think).hidden).toBe(true);
    // Esc folds the line back and returns focus to the item that opened last.
    fireEvent.keyDown(panelOf(tools), { key: 'Escape' });
    expect(panelOf(tools).hidden).toBe(true);
    expect(document.activeElement).toBe(tools);
    expect(queryByTestId('tool-group')).toBeNull();
  });

  it('Esc closes one panel per press: the one holding focus, else the one opened last', () => {
    const { getByTestId } = render(<MessageView item={reply({ thinking: { text: '먼저 확인', redacted: false, startedAt: 0, ms: 12000 }, toolCalls: [bash('1'), bash('2')] })} />);
    const think = getByTestId('thinking').closest('button')!;
    const tools = getByTestId('work-log');
    fireEvent.click(think);
    fireEvent.click(tools);
    fireEvent.keyDown(panelOf(think), { key: 'Escape' });
    expect(panelOf(think).hidden).toBe(true);
    expect(panelOf(tools).hidden).toBe(false);
    expect(document.activeElement).toBe(think);
    fireEvent.click(think);
    fireEvent.keyDown(getByTestId('turn-meta'), { key: 'Escape' });
    expect(panelOf(think).hidden).toBe(true);
    expect(panelOf(tools).hidden).toBe(false);
  });

  it('absorbed background notices keep their label and summary as a tooltip, so several stay apart', () => {
    const n = (summary: string) => ({ kind: 'task' as const, label: '백그라운드 작업 완료', summary, status: 'completed', body: '', raw: 'r' });
    const { getAllByTestId } = render(<MessageView item={reply()} notices={[n('테스트 실행'), n('빌드')]} />);
    expect(getAllByTestId('meta-notice').map((b) => b.getAttribute('title'))).toEqual(['백그라운드 작업 완료 · 테스트 실행', '백그라운드 작업 완료 · 빌드']);
  });

  it('only the last block of a turn names the model', () => {
    const mid = render(<MessageView item={reply({ model: 'claude-opus-5-5' })} turnEnd={false} />);
    expect(mid.queryByTestId('msg-model')).toBeNull();
    cleanup();
    const end = render(<MessageView item={reply({ model: 'claude-opus-5-5' })} />);
    expect(end.getByTestId('msg-model').textContent).toBe('Opus 5.5');
  });

  it('a paragraph opening with bold text is marked as a lead paragraph', () => {
    const { container } = render(<MessageView item={reply({ text: '첫 문단.\n\n**라이브 상태.** 설명.\n\n보통 **굵게** 문단.' })} />);
    const ps = [...container.querySelectorAll('.markdown p')];
    expect(ps.map((p) => p.classList.contains('md-lead'))).toEqual([false, true, false]);
  });

  it('an error shows a readable line with the raw text folded under it', () => {
    const raw = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}';
    const { getByTestId } = render(<MessageView item={reply({ text: '', error: raw })} />);
    const e = getByTestId('turn-error');
    expect(e.querySelector('.turn-error-line')?.textContent).toBe('서버가 붐벼 응답하지 못했어요 — 잠시 뒤 다시 시도해 주세요');
    expect((e.querySelector('details') as HTMLDetailsElement).open).toBe(false);
    expect(e.querySelector('pre')?.textContent).toBe(raw);
    expect(e.textContent).not.toContain('오류: ');
  });

  it('errorSummary: a readable one-liner stays as it is (no raw fold), stacks and JSON become a summary', () => {
    expect(errorSummary('엔진이 결과 없이 종료했습니다')).toBe('엔진이 결과 없이 종료했습니다');
    expect(errorSummary('Error: boom\n    at x (y.js:1)')).toBe('응답 중 오류가 났어요');
    expect(errorSummary('Claude Code process exited with code 1')).toBe('엔진이 도중에 종료됐어요');
    expect(errorSummary('429 rate_limit_error')).toBe('사용 한도에 걸렸어요 — 잠시 뒤 다시 시도해 주세요');
    const { getByTestId } = render(<MessageView item={reply({ text: '', error: '엔진이 결과 없이 종료했습니다' })} />);
    expect(getByTestId('turn-error').querySelector('details')).toBeNull();
  });
});

describe('MessageView · quiet status lines (CSS)', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
  // The last rule for a selector is the one the cascade keeps.
  const rule = (sel: string) => [...css.matchAll(new RegExp(`\\n${sel.replace(/[.>]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`, 'g'))].at(-1)![1]!;
  it('the meta line, system notices and the model name are plain quiet text — no pill background or ring', () => {
    for (const sel of ['.meta-item', '.turn-meta .tb-pill', '.sys-notice > summary', '.msg-model']) {
      expect(rule(sel)).not.toMatch(/background: var|box-shadow: (?!none)|999px|r-full/);
    }
    expect(rule('.turn-meta')).toContain('var(--faint)');
  });
  it('expandable rows are at least 34px tall; prose paragraphs get 16px apart', () => {
    expect(rule('.meta-item')).toContain('min-height: 28px');
    expect(rule('.sys-notice > summary')).toContain('min-height: 34px');
    expect(rule('.turn-error .sys-raw > summary')).toContain('min-height: 34px');
    expect(rule('.markdown p')).toContain('margin: 0 0 16px');
  });
});

describe('MessageView · 작업 기록 keeps cards in the open (full mode)', () => {
  beforeEach(() => { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: false })); });
  afterEach(() => { cleanup(); localStorage.removeItem(PREFS_KEY); });
  const call = (id: string, name: string, input: unknown, result: string | null = 'out') => ({ toolUseId: id, name, input, result, isError: false });
  const reply = (toolCalls: ReturnType<typeof call>[], streaming = false) => ({ kind: 'assistant' as const, turnId: 't', text: '', toolCalls, badge: null, streaming, error: null, notes: [], attempts: [], thinking: { text: '확인', redacted: false, startedAt: 0, ms: 3000 } });

  it('a file edit diff card and a subagent card stay out in the reply, in order; the other calls fold into one meta item', () => {
    const { container, getAllByTestId, getByTestId } = render(<MessageView item={reply([
      call('1', 'Bash', { command: 'ls' }),
      call('2', 'Edit', { file_path: '/w/a.ts', old_string: 'one', new_string: 'two' }),
      call('3', 'Agent', { description: 'look around', prompt: 'p' }),
      call('4', 'Bash', { command: 'pwd' }),
    ])} />);
    const logs = getAllByTestId('work-log');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.getAttribute('aria-expanded')).toBe('false');
    const panel = panelOf(logs[0]!);
    expect(panel.querySelectorAll('[data-testid="tool-call"]')).toHaveLength(2);
    expect(panel.querySelector('[data-testid="diff-card"], [data-testid="agent-card"]')).toBeNull();
    const diff = container.querySelector('[data-testid="diff-card"]')!;
    const agent = container.querySelector('[data-testid="agent-card"]')!;
    const foot = getByTestId('turn-meta');
    for (const card of [diff, agent]) expect(foot.contains(card)).toBe(false);
    expect(diff.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(agent.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The seconds belong to the thinking item, not the tools.
    expect(getByTestId('thinking').textContent).toContain('3초 동안 생각함');
    expect(logs[0]!.textContent).not.toContain('3초');
  });

  it('only diff cards: the thinking keeps its own line and the card shows', () => {
    const { container, getByTestId, queryByTestId } = render(<MessageView item={reply([call('1', 'Write', { file_path: '/w/n.md', content: 'a' }, 'File created successfully at: /w/n.md')])} />);
    expect(queryByTestId('work-log')).toBeNull();
    expect(getByTestId('thinking').textContent).toContain('3초 동안 생각함');
    expect(container.querySelector('[data-testid="diff-card"]')).not.toBeNull();
  });

  it('a running command says 실행 중… on its line while live', () => {
    const { getByTestId } = render(<MessageView item={reply([call('1', 'Bash', { command: 'npm test' }, null)], true)} />);
    expect(getByTestId('work-log').textContent).toContain('실행 중…');
  });
});

describe('MessageView · concise progress is announced', () => {
  beforeEach(() => { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: true })); });
  afterEach(() => { cleanup(); localStorage.removeItem(PREFS_KEY); });
  it('"계속 작업 중 · 단계 N" sits in a polite live region', () => {
    const item = { kind: 'assistant' as const, turnId: 't', text: '', toolCalls: [{ toolUseId: '1', name: 'Bash', input: { command: 'ls' }, result: null, isError: false }], badge: null, streaming: true, error: null, notes: [], attempts: [] };
    const { getByTestId } = render(<MessageView item={item} />);
    const label = getByTestId('work-log').querySelector('.tool-label')!;
    expect(label.textContent).toBe('계속 작업 중 · 단계 1');
    expect(label.getAttribute('aria-live')).toBe('polite');
  });
});

describe('errorSummary · deck messages first', () => {
  it('a short Korean first line is shown as it is, even when it names a keyword (로그인, 한도)', () => {
    expect(errorSummary('Gemini 로그인 필요 — 터미널에서 agy 실행 후 Google 로그인')).toBe('Gemini 로그인 필요 — 터미널에서 agy 실행 후 Google 로그인');
    expect(errorSummary('이 계정의 사용 한도를 넘었어요 (5시간 창)\nraw: 429')).toBe('이 계정의 사용 한도를 넘었어요 (5시간 창)');
  });
});

describe('styles · phone touch rows', () => {
  it('meta items keep the line 28px tall; on coarse pointers each grows a --phone-tap touch area', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.meta-item::after \{[^}]*var\(--phone-tap\)/);
  });
});
