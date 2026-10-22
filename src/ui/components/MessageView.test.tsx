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

describe('MessageView tool lines (Desktop style)', () => {
  afterEach(cleanup);
  const tc = (id: string, name: string, input: unknown, extra = {}) => ({ toolUseId: id, name, input, result: 'out', isError: false, ...extra });

  it('tool calls fold into one 작업 기록 line that expands to per-call lines (one or several)', () => {
    const one = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: 'ok', toolCalls: [tc('1', 'Bash', { command: 'npm test', description: 'Run tests' })], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const line = one.container.querySelector('[data-testid="tool-call"]') as HTMLDetailsElement;
    expect(line.querySelector('summary')?.textContent).toContain('Run tests');
    expect(line.open).toBe(false);
    expect(one.container.querySelector('.tool-group')).toBeNull();
    expect((one.getByTestId('work-log') as HTMLDetailsElement).open).toBe(false);
    cleanup();
    const many = render(<MessageView item={{ kind: 'assistant', turnId: 't', text: '', toolCalls: [tc('1', 'Bash', { command: 'a' }), tc('2', 'Bash', { command: 'b' }, { isError: true })], badge: null, streaming: false, error: null, notes: [], attempts: [] }} />);
    const group = many.container.querySelector('[data-testid="work-log"]') as HTMLDetailsElement;
    expect(group.querySelector('summary')?.textContent).toContain('작업 기록 · 실행된 명령 2개');
    expect(group.querySelector('summary')?.textContent).toContain('오류 1');
    expect(group.open).toBe(false);
    expect(group.querySelectorAll('[data-testid="tool-call"]')).toHaveLength(2);
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
    const t = container.querySelector('.turn-foot .turn-badge')?.textContent ?? '';
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
    expect(getByTestId('work-log').querySelector('summary')?.textContent).toContain('계속 작업 중 · 단계 1');
    expect(container.querySelector('.markdown:not(.thinking-body)')).toBeNull();
    // Tool bodies stay folded inside the collapsed 작업 기록 line (as before).
    expect((getByTestId('work-log') as HTMLDetailsElement).open).toBe(false);
    // …and nothing of the output shows outside that folded line.
    const outside = container.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-testid="work-log"]')!.remove();
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
    expect(getByTestId('work-log').querySelector('summary')?.textContent).toContain('단계 1');
    const md = container.querySelectorAll('.markdown');
    expect(md).toHaveLength(1);
    expect(md[0]!.textContent).toBe('원인은 오타였어요');
  });
});

describe('MessageView · 대화 본문 다듬기', () => {
  afterEach(cleanup);
  const reply = (extra: object = {}) => ({ kind: 'assistant' as const, turnId: 't', text: 'ok', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], ...extra });
  const bash = (id: string) => ({ toolUseId: id, name: 'Bash', input: { command: 'ls' }, result: 'out', isError: false });

  it('thinking and tool calls share one 작업 기록 line with the seconds; expanded it shows both', () => {
    const { getByTestId, queryByTestId } = render(<MessageView item={reply({ thinking: { text: '먼저 확인', redacted: false, startedAt: 0, ms: 12000 }, toolCalls: [bash('1'), bash('2')] })} />);
    const log = getByTestId('work-log') as HTMLDetailsElement;
    expect(log.querySelector('summary')?.textContent).toContain('작업 기록 · 12초 · 실행된 명령 2개');
    expect(log.querySelector('.thinking-body')?.textContent).toContain('먼저 확인');
    expect(log.querySelectorAll('[data-testid="tool-call"]')).toHaveLength(2);
    expect(queryByTestId('thinking')).toBeNull();
    expect(queryByTestId('tool-group')).toBeNull();
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
  it('작업 기록, system notices and the model name are plain muted text — no pill background or ring', () => {
    for (const sel of ['.work-log > summary', '.sys-notice > summary', '.msg-model']) {
      expect(rule(sel)).not.toMatch(/background|box-shadow|999px|r-full/);
    }
    expect(rule('.work-log')).toContain('var(--muted)');
  });
  it('expandable rows are at least 34px tall; prose paragraphs get 16px apart', () => {
    expect(rule('.work-log > summary')).toContain('min-height: 34px');
    expect(rule('.sys-notice > summary')).toContain('min-height: 34px');
    expect(rule('.turn-error .sys-raw > summary')).toContain('min-height: 34px');
    expect(rule('.markdown p')).toContain('margin: 0 0 16px');
  });
});
