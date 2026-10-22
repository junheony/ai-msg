// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Chat, composerPlaceholder, messageKeys, modelChoices } from './Chat';
import { GROK_MODELS } from '../../shared/models';
import { THREAD_LOCKED_MESSAGE } from '../../shared/handoff';
import { GROK_BYPASS_HINT, PERM_MODE_HINT } from '../../shared/permission';
import type { ChatProps } from './Chat';
import type { ChatItem } from '../state';

// jsdom has no layout, hence no scrollIntoView.
Element.prototype.scrollIntoView = () => {};

const failed: ChatItem = { kind: 'assistant', turnId: 't', text: '', toolCalls: [], badge: null, streaming: false, error: '한도 도달', notes: [], attempts: [] };

function renderChat(items: ChatItem[], busy = false, onSend = vi.fn(), extra: Partial<ChatProps> = {}) {
  render(<Chat items={items} pending={[]} questions={[]} activeTurnId={null} busy={busy} title="t" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine={null} sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={onSend} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} {...extra} />);
  return onSend;
}

/** Opens the session chip's sheet, where the engine / sandbox / model / account / permission pickers live. */
const openSheet = () => fireEvent.click(screen.getByTestId('session-chip'));

const chatProps = (items: ChatItem[]): ChatProps => ({ items, pending: [], questions: [], activeTurnId: null, busy: false, title: 't', model: 'opus', effort: 'high', engine: 'claude', sandbox: 'read-only', sessionEngine: null, sessionSandbox: null, isNew: false, codexAvailable: false, attachments: [], onSend: () => {}, onInterrupt: () => {}, onDecide: () => {}, onAnswer: () => {}, onModel: () => {}, onEffort: () => {}, onEngine: () => {}, onSandbox: () => {}, onAttach: () => {}, onUnattach: () => {} });

describe('Chat', () => {
  afterEach(cleanup);

  it('a Grok session: Grok models only, the permission picker works (approval cards), no sandbox picker', () => {
    expect(modelChoices('grok')).toEqual(GROK_MODELS);
    const onPermMode = vi.fn();
    renderChat([], false, vi.fn(), { sessionEngine: 'grok', model: 'grok-4.6', onPermMode, permMode: 'default' });
    openSheet();
    const perm = screen.getByTestId('perm-select') as HTMLSelectElement;
    expect(perm.disabled).toBe(false);
    fireEvent.change(perm, { target: { value: 'acceptEdits' } });
    expect(onPermMode).toHaveBeenCalledWith('acceptEdits');
    expect(screen.queryByTestId('sandbox-select')).toBeNull();
    // 모두 자동 승인 explains Grok's narrower rule.
    cleanup();
    renderChat([], false, vi.fn(), { sessionEngine: 'grok', model: 'grok-4.6', onPermMode, permMode: 'bypassPermissions' });
    openSheet();
    expect(screen.getByTestId('perm-select').getAttribute('title')).toContain(GROK_BYPASS_HINT);
    expect(screen.getByTestId('perm-badge').getAttribute('title')).toContain(GROK_BYPASS_HINT);
    // The head's warning dot keeps its words for screen readers (visually clipped, not removed).
    expect(screen.getByTestId('perm-badge').textContent).toContain('모두 자동 승인');
    cleanup();
    renderChat([], false, vi.fn(), { sessionEngine: 'claude', onPermMode, permMode: 'bypassPermissions' });
    openSheet();
    expect(screen.getByTestId('perm-select').getAttribute('title')).toContain(PERM_MODE_HINT.bypassPermissions);
  });

  it('pane header: engine mark (role=img) only once the engine is known — no Claude flash on an opening Codex thread', () => {
    renderChat([], false, vi.fn(), { title: 'thread', sessionEngine: null });
    expect(document.querySelector('.head-chip-title .engine-mark')).toBeNull();
    cleanup();
    renderChat([], false, vi.fn(), { title: 'thread', sessionEngine: 'codex' });
    expect(screen.getByRole('img', { name: 'Codex (GPT)' }).closest('.head-chip-title')).not.toBeNull();
    cleanup();
    renderChat([], false, vi.fn(), { title: 'thread', sessionEngine: 'claude' });
    expect(screen.getByRole('img', { name: 'Claude' }).closest('.head-chip-title')).not.toBeNull();
    cleanup();
    renderChat([], false, vi.fn(), { title: 'thread', sessionEngine: 'claude', isNew: true });
    expect(screen.queryByRole('img', { name: 'Claude' })).toBeNull();
  });

  it('pane bars: a notice is a status bar, an error an alert bar; both show; × dismisses that one', () => {
    const onDismissNotice = vi.fn();
    renderChat([{ kind: 'user', text: 'x' }], false, vi.fn(), { notices: [{ message: '「x」 대화의 기록 파일이 방금 AI-MSG 밖에서 바뀌었어요.', level: 'notice' }, { message: '기록을 읽지 못했습니다', level: 'error' }], onDismissNotice });
    const bars = screen.getAllByTestId('pane-notice');
    expect(bars).toHaveLength(2);
    expect(bars[0]!.getAttribute('role')).toBe('status');
    expect(bars[0]!.classList.contains('notice')).toBe(true);
    expect(bars[1]!.getAttribute('role')).toBe('alert');
    expect(bars[1]!.classList.contains('error')).toBe(true);
    fireEvent.click(within(bars[1]!).getByLabelText('알림 닫기'));
    expect(onDismissNotice).toHaveBeenCalledWith('기록을 읽지 못했습니다');
    cleanup();
    renderChat([{ kind: 'user', text: 'x' }], false, vi.fn(), { notices: [] });
    expect(screen.queryByTestId('pane-notice')).toBeNull();
  });

  it('a failed last turn offers 재시도, which re-sends the same prompt', () => {
    const onSend = renderChat([{ kind: 'user', text: 'first' }, { ...failed, error: null, text: 'fine' }, { kind: 'user', text: 'do the thing' }, failed]);
    fireEvent.click(screen.getByText('재시도'));
    expect(onSend).toHaveBeenCalledWith('do the thing');
    expect(screen.getAllByText('재시도')).toHaveLength(1);
  });

  it('a GPT turn refused by the thread lock offers AI-MSG 에서 새 GPT 세션으로 이어가기 next to 재시도 (errorCode, or an older server\'s text)', () => {
    const label = 'AI-MSG 에서 새 GPT 세션으로 이어가기';
    const onCodexHandoff = vi.fn();
    const lockedItem: ChatItem = { ...failed, turnId: 'tl', error: THREAD_LOCKED_MESSAGE, errorCode: 'thread_locked' };
    renderChat([{ kind: 'user', text: 'go' }, lockedItem], false, vi.fn(), { sessionEngine: 'codex', model: 'gpt-6-sol', onCodexHandoff });
    expect(screen.getByText('재시도')).toBeTruthy();
    fireEvent.click(screen.getByText(label));
    expect(onCodexHandoff).toHaveBeenCalledWith('tl');
    cleanup();
    // an older server: no errorCode, the message text only
    renderChat([{ kind: 'user', text: 'go' }, { ...failed, turnId: 'tl', error: THREAD_LOCKED_MESSAGE }], false, vi.fn(), { sessionEngine: 'codex', model: 'gpt-6-sol', onCodexHandoff });
    expect(screen.getByText(label)).toBeTruthy();
    cleanup();
    // another failure of a GPT turn: none
    renderChat([{ kind: 'user', text: 'go' }, failed], false, vi.fn(), { sessionEngine: 'codex', model: 'gpt-6-sol', onCodexHandoff });
    expect(screen.queryByText(label)).toBeNull();
    cleanup();
    // a Claude session (even with that text): none
    renderChat([{ kind: 'user', text: 'go' }, lockedItem], false, vi.fn(), { sessionEngine: 'claude', onCodexHandoff });
    expect(screen.queryByText(label)).toBeNull();
    cleanup();
    // busy: none
    renderChat([{ kind: 'user', text: 'go' }, lockedItem], true, vi.fn(), { sessionEngine: 'codex', model: 'gpt-6-sol', onCodexHandoff });
    expect(screen.queryByText(label)).toBeNull();
  });

  it('no 재시도 while busy or when the last turn succeeded', () => {
    renderChat([{ kind: 'user', text: 'x' }, failed], true);
    expect(screen.queryByText('재시도')).toBeNull();
    cleanup();
    renderChat([{ kind: 'user', text: 'x' }, { ...failed, error: null }]);
    expect(screen.queryByText('재시도')).toBeNull();
  });

  it('engine picker only for a new session with Codex available; GPT engine shows the sandbox picker and GPT models; a Codex session shows its sandbox tag', () => {
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: false });
    openSheet();
    expect(screen.queryByTestId('engine-select')).toBeNull();
    cleanup();
    const onEngine = vi.fn();
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: true, engine: 'codex', model: 'gpt-6-sol', onEngine });
    openSheet();
    fireEvent.change(screen.getByTestId('engine-select'), { target: { value: 'auto' } });
    expect(onEngine).toHaveBeenCalledWith('auto');
    expect(screen.getByTestId('sandbox-select')).toBeTruthy();
    expect(within(screen.getByTestId('model-menu')).getAllByRole('menuitemradio').map((b) => b.textContent)).toEqual([expect.stringContaining('GPT-6.1-Sol'), expect.stringContaining('GPT-6-Astra')]);
    expect(Array.from((screen.getByRole('combobox', { name: '추론 수준' }) as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['낮음', '중간', '높음', '엑스트라']);
    cleanup();
    renderChat([], false, vi.fn(), { sessionEngine: 'codex', sessionSandbox: 'workspace-write', model: 'gpt-6-astra' });
    openSheet();
    expect(screen.getByText(/샌드박스: 작업폴더 쓰기/)).toBeTruthy(); // the composer chip's sheet (the head no longer repeats it)
    expect(screen.queryByTestId('engine-select')).toBeNull();
  });

  it('an existing Codex session: the sandbox chip is the same picker as a new one (with onSessionSandbox) and sends the pick', () => {
    const onSessionSandbox = vi.fn();
    renderChat([], false, vi.fn(), { sessionEngine: 'codex', sessionSandbox: 'read-only', model: 'gpt-6-sol', onSessionSandbox });
    openSheet();
    const pick = screen.getByTestId('session-sandbox-select') as HTMLSelectElement;
    expect(pick.value).toBe('read-only');
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['읽기 전용', '작업폴더 쓰기 · 네트워크']);
    expect(pick.parentElement!.querySelector('.pick-label')!.textContent).toBe('읽기 전용');
    fireEvent.change(pick, { target: { value: 'workspace-write' } });
    expect(onSessionSandbox).toHaveBeenCalledWith('workspace-write');
    expect(screen.queryByTestId('engine-select')).toBeNull();
    cleanup();
    // Without the handler (an older server, or a Claude / Gemini session) the chip stays a tag.
    renderChat([], false, vi.fn(), { sessionEngine: 'codex', sessionSandbox: 'workspace-write', model: 'gpt-6-sol' });
    openSheet();
    expect(screen.getByText('샌드박스: 작업폴더 쓰기 · 네트워크')).toBeTruthy();
    expect(screen.queryByTestId('session-sandbox-select')).toBeNull();
    cleanup();
    renderChat([], false, vi.fn(), { sessionEngine: 'gemini', sessionSandbox: 'read-only', model: 'gemini-pro', onSessionSandbox });
    openSheet();
    expect(screen.queryByTestId('session-sandbox-select')).toBeNull();
  });

  it('Gemini: option only with agy; disabled with 로그인 필요 until agy is logged in; Gemini models with effort', () => {
    const out = { available: true, loggedIn: { g1: false, g2: false } };
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: false, gemini: out, grok: { bin: false } });
    openSheet();
    const opt = () => within(screen.getByTestId('engine-select')).getByRole('option', { name: /Gemini/ }) as HTMLOptionElement;
    expect(opt().disabled).toBe(true);
    expect(opt().textContent).toBe('Gemini · 로그인 필요');
    // Without Codex there is no GPT or 자동 engine.
    expect(within(screen.getByTestId('engine-select')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Claude', 'Gemini · 로그인 필요', 'Grok · 설치 필요']);
    cleanup();
    // An older server (no hello.grok): no Grok option at all.
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: false, gemini: out });
    openSheet();
    expect(within(screen.getByTestId('engine-select')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Claude', 'Gemini · 로그인 필요']);
    cleanup();
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: true, gemini: { available: false, loggedIn: { g1: false, g2: false } } });
    openSheet();
    expect(within(screen.getByTestId('engine-select')).queryByRole('option', { name: /Gemini/ })).toBeNull();
    cleanup();
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: true, engine: 'gemini', model: 'gemini-pro', effort: 'medium', gemini: { available: true, loggedIn: { g1: false, g2: true } } });
    openSheet();
    expect(opt().disabled).toBe(false);
    expect(opt().textContent).toBe('Gemini');
    expect(within(screen.getByTestId('sandbox-select')).getAllByRole('option').map((o) => o.textContent)).toEqual(['읽기 전용', '파일 편집 허용(셸 거부)']);
    expect(within(screen.getByTestId('model-menu')).getAllByRole('menuitemradio').map((b) => b.querySelector('.mp-name')?.textContent ?? b.textContent)).toEqual(['Gemini 4 Argon', 'Gemini Flash', '낮음', '중간', '높음']); // agy: no xhigh for Gemini
    cleanup();
    renderChat([], false, vi.fn(), { sessionEngine: 'gemini', sessionSandbox: 'read-only', model: 'gemini-pro' });
    openSheet();
    expect(screen.getByText('승인 모드: 읽기 전용')).toBeTruthy();
  });

  it('PF11: a new session follows the engine picker even when the session engine frozen at open says claude', () => {
    renderChat([], false, vi.fn(), { isNew: true, codexAvailable: true, engine: 'codex', sessionEngine: 'claude', model: 'gpt-6-sol' });
    openSheet();
    expect(screen.getByTestId('sandbox-select')).toBeTruthy();
    expect(within(screen.getByTestId('model-menu')).getAllByRole('menuitemradio').map((b) => b.textContent)).toEqual([expect.stringContaining('GPT-6.1-Sol'), expect.stringContaining('GPT-6-Astra')]);
    expect(Array.from((screen.getByRole('combobox', { name: '추론 수준' }) as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['낮음', '중간', '높음', '엑스트라']);
    expect(screen.queryByText(/샌드박스:/)).toBeNull();
  });

  it('pasting an image uploads it and reports the attachment; sending with attachments only uses a default text', async () => {
    const uploadFn = vi.fn(async (f: File) => ({ id: 'id-1', name: f.name, size: f.size, isImage: true }));
    const onAttach = vi.fn();
    const onSend = renderChat([], false, vi.fn(), { uploadFn, onAttach, attachments: [{ id: 'id-0', name: 'prev.png', size: 1, isImage: true }] });
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(screen.getByPlaceholderText(/메시지/), { clipboardData: { files: [file], items: [] } });
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith({ id: 'id-1', name: 'shot.png', size: 1, isImage: true }));
    fireEvent.click(screen.getByText('보내기'));
    expect(onSend).toHaveBeenCalledWith('첨부 파일을 확인해 주세요.');
  });

  it('renders question cards and forwards answers', () => {
    const onAnswer = vi.fn();
    renderChat([], false, vi.fn(), { onAnswer, questions: [{ turnId: 't', sessionId: 's', cwd: '/w', requestId: 'q1', questions: [{ question: 'Which?', header: '', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }], multiSelect: false }] }] });
    fireEvent.click(screen.getByText('b'));
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which?': 'b' });
  });
});

describe('Chat composer and header (Desktop style)', () => {
  afterEach(cleanup);
  it('header shows the title and the folder chip (full path on hover); a running turn shows the status line and a stop button', () => {
    const onInterrupt = vi.fn();
    renderChat([{ kind: 'user', text: 'x' }, { kind: 'assistant', turnId: 't1', text: '', toolCalls: [{ toolUseId: '1', name: 'Bash', input: { command: 'ls' }, result: null, isError: false }], badge: null, streaming: true, error: null, notes: [], attempts: [] }], true, vi.fn(), { activeTurnId: 't1', cwd: '/Users/u/Documents/proj', onInterrupt });
    fireEvent.click(screen.getByTestId('session-chip-head')); // in a pane (not the top bar) the folder is the menu's first row
    const chip = screen.getByRole('menuitem', { name: /폴더: proj/ });
    expect(chip.getAttribute('title')).toBe('/Users/u/Documents/proj');
    const status = screen.getByTestId('turn-status');
    expect(status.textContent).toContain('명령 실행 중');
    expect(status.textContent).toContain('ls');
    expect(status.textContent).toContain('0:0');
    expect(status.textContent).toContain('도구 1회');
    fireEvent.click(within(status).getByText('중단'));
    expect(onInterrupt).toHaveBeenCalled();
    cleanup();
    renderChat([]);
    expect(screen.queryByTestId('turn-status')).toBeNull();
  });
});

describe('Composer keyboard (Desktop)', () => {
  afterEach(cleanup);
  const box = () => screen.getByLabelText('메시지') as HTMLTextAreaElement;
  const type = (t: string) => fireEvent.change(box(), { target: { value: t } });

  it('Enter sends; Shift+Enter does not (the textarea keeps its newline); Cmd/Ctrl+Enter also sends', () => {
    const onSend = renderChat([]);
    type('hi');
    expect(fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false);
    expect(onSend).toHaveBeenCalledWith('hi');
    type('again');
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenLastCalledWith('again');
    // The keys are on the 보내기 button (tooltip + aria-keyshortcuts); the placeholder names the session.
    expect(screen.getByLabelText('메시지').getAttribute('placeholder')).not.toContain('Enter');
    const sendBtn = screen.getByRole('button', { name: '보내기' });
    expect(sendBtn.getAttribute('title')).toBe('보내기 (Enter · Shift+Enter 줄바꿈)');
    expect(sendBtn.getAttribute('aria-keyshortcuts')).toBe('Enter');
  });

  it('an Enter that belongs to an IME composition never sends (isComposing, keyCode 229, between compositionstart/end)', () => {
    const onSend = renderChat([]);
    type('안녕하세요');
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    // Committed: the next real Enter sends the whole text, once.
    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('안녕하세요');
  });

  it('on a touch screen Enter is a newline; the send button sends', () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    try {
      const onSend = renderChat([]);
      type('hi');
      expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true);
      expect(onSend).not.toHaveBeenCalled();
      // No key to promise here: the tooltip is just 보내기 and no aria-keyshortcuts.
      const sendBtn = screen.getByRole('button', { name: '보내기' });
      expect(sendBtn.getAttribute('title')).toBe('보내기');
      expect(sendBtn.hasAttribute('aria-keyshortcuts')).toBe(false);
      fireEvent.click(sendBtn);
      expect(onSend).toHaveBeenCalledWith('hi');
    } finally {
      window.matchMedia = mm;
    }
  });

  it('on a touch screen with a hardware keyboard (no soft keyboard shrinking the viewport) Enter sends', () => {
    const mm = window.matchMedia;
    const vv = { width: 1024, scale: 1, height: 1300, addEventListener: () => {}, removeEventListener: () => {} };
    window.matchMedia = ((q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    try {
      const onSend = renderChat([]);
      type('hi');
      expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false);
      expect(onSend).toHaveBeenCalledWith('hi');
      // The on-screen keyboard comes up (the viewport shrinks): Enter is a newline again.
      vv.height = 700;
      type('more');
      expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true);
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = mm;
      Reflect.deleteProperty(window, 'visualViewport');
    }
  });

  it('Esc interrupts a running turn; while busy Enter queues; ArrowUp in an empty composer recalls the last message', () => {
    const onInterrupt = vi.fn();
    const onQueue = vi.fn();
    const onSend = renderChat([{ kind: 'user', text: 'previous ask' }], true, vi.fn(), { activeTurnId: 't1', onInterrupt, onQueue });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    type('next');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onQueue).toHaveBeenCalledWith('next');
    expect(onSend).not.toHaveBeenCalled();
    box().setSelectionRange(0, 0);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('previous ask');
  });
});

describe('Chat · composer buttons while a turn runs', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); });
  const box = () => document.querySelector('textarea') as HTMLTextAreaElement;
  const run = (onInterrupt = vi.fn(), onQueue = vi.fn()) => {
    renderChat([{ kind: 'user', text: 'p' }], true, vi.fn(), { activeTurnId: 't1', onInterrupt, onQueue });
    return { onInterrupt, onQueue };
  };

  it('running + empty draft: the main button is stop, no mini stop', () => {
    const { onInterrupt } = run();
    const main = document.querySelector('.send') as HTMLButtonElement;
    expect(main.classList.contains('stop')).toBe(true);
    expect(document.querySelector('.stop-mini')).toBeNull();
    fireEvent.click(main);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('running + draft: main button sends (queues) and a mini stop interrupts', () => {
    const { onInterrupt, onQueue } = run();
    fireEvent.change(box(), { target: { value: 'next' } });
    expect(document.querySelector('.queue-add')).toBeNull();
    const mini = document.querySelector('.send.stop.stop-mini') as HTMLButtonElement;
    expect(mini.title).toBe('중단 (Esc)');
    const main = [...document.querySelectorAll('.send')].find((b) => !b.classList.contains('stop')) as HTMLButtonElement;
    expect(main.disabled).toBe(false);
    fireEvent.click(main);
    expect(onQueue).toHaveBeenCalledWith('next');
    expect(onInterrupt).not.toHaveBeenCalled();
    fireEvent.change(box(), { target: { value: 'again' } });
    fireEvent.click(document.querySelector('.stop-mini') as HTMLButtonElement);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('idle: plain send button, no stop', () => {
    renderChat([], false);
    expect(document.querySelector('.send.stop')).toBeNull();
    expect((document.querySelector('.send') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Chat · handoff prefill vs. an edited draft', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); });
  const box = () => document.querySelector('textarea') as HTMLTextAreaElement;

  it('a remount keeps the draft the user edited instead of putting the original note back', () => {
    const extra: Partial<ChatProps> = { isNew: true, sessionId: null, draftKey: 'new:p0', prefill: '인계 메모' };
    renderChat([], false, vi.fn(), extra);
    expect(box().value).toBe('인계 메모');
    fireEvent.change(box(), { target: { value: '인계 메모 — 고쳐 씀' } });
    cleanup();
    renderChat([], false, vi.fn(), extra);
    expect(box().value).toBe('인계 메모 — 고쳐 씀');
  });

  it('with no draft yet the note is put in; once the session has its id the id-less draft is dropped', () => {
    renderChat([], false, vi.fn(), { isNew: true, sessionId: null, draftKey: 'new:p1', prefill: '노트' });
    expect(box().value).toBe('노트');
    cleanup();
    renderChat([], false, vi.fn(), { sessionId: 'sid-1', draftKey: 'new:p1', prefill: null });
    cleanup();
    renderChat([], false, vi.fn(), { isNew: true, sessionId: null, draftKey: 'new:p1', prefill: null });
    expect(box().value).toBe('');
  });
});

describe('Chat readOnly', () => {
  afterEach(cleanup);
  it('disables the composer and shows the reason in place of the placeholder; Enter sends nothing', () => {
    const onSend = renderChat([], false, vi.fn(), { readOnly: '보관된 Codex 대화라 읽기만 할 수 있어요' });
    const box = screen.getByLabelText('메시지') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe('보관된 Codex 대화라 읽기만 할 수 있어요');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '보내기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers no 재시도 and ignores pasted / dropped files', async () => {
    const uploadFn = vi.fn(async (f: File) => ({ id: 'id-1', name: f.name, size: f.size, isImage: true }));
    const onAttach = vi.fn();
    renderChat([{ kind: 'user', text: 'do the thing' }, failed], false, vi.fn(), { readOnly: '읽기만', uploadFn, onAttach });
    expect(screen.queryByText('재시도')).toBeNull();
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('메시지'), { clipboardData: { files: [file], items: [] } });
    fireEvent.drop(screen.getByLabelText('메시지').closest('.composer')!, { dataTransfer: { files: [file], items: [] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadFn).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
  });
});

describe('Chat title ⌄ menu', () => {
  afterEach(cleanup);
  const menu = (extra: Partial<NonNullable<ChatProps['titleMenu']>> = {}) => ({ pinned: false, archived: false, onRename: vi.fn(), onTogglePin: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), deleteBlocked: null, ...extra });

  it('opens 이름 바꾸기 / 고정 / 보관 / 삭제 and runs the sidebar actions', () => {
    const tm = menu();
    renderChat([], false, vi.fn(), { title: '내 채팅', sessionId: 's1', titleMenu: tm });
    const title = screen.getByRole('button', { name: /내 채팅/ });
    expect(title.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(title);
    const names = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(names.slice(0, 3)).toEqual(['이름 바꾸기', '맨 위에 고정', '보관']); // 세션 first, 위험 last
    expect(names.at(-1)).toBe('삭제…');
    fireEvent.click(screen.getByText('맨 위에 고정'));
    expect(tm.onTogglePin).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(title);
    fireEvent.click(screen.getByText('보관'));
    fireEvent.click(title);
    fireEvent.click(screen.getByText('삭제…'));
    expect(tm.onArchive).toHaveBeenCalled();
    expect(tm.onDelete).toHaveBeenCalled();
  });

  it('이름 바꾸기 edits the title inline: Enter saves (trimmed; empty = back to the default), Esc cancels', () => {
    const tm = menu();
    renderChat([], false, vi.fn(), { title: '내 채팅', sessionId: 's1', titleMenu: tm });
    fireEvent.click(screen.getByRole('button', { name: /내 채팅/ }));
    fireEvent.click(screen.getByText('이름 바꾸기'));
    const input = screen.getByLabelText('채팅 이름') as HTMLInputElement;
    expect(input.value).toBe('내 채팅');
    fireEvent.change(input, { target: { value: '  새   이름 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(tm.onRename).toHaveBeenCalledTimes(1);
    expect(tm.onRename).toHaveBeenCalledWith('새 이름');
    fireEvent.click(screen.getByRole('button', { name: /내 채팅/ }));
    fireEvent.click(screen.getByText('이름 바꾸기'));
    fireEvent.change(screen.getByLabelText('채팅 이름'), { target: { value: 'nope' } });
    fireEvent.keyDown(screen.getByLabelText('채팅 이름'), { key: 'Escape' });
    expect(screen.queryByLabelText('채팅 이름')).toBeNull();
    expect(tm.onRename).toHaveBeenCalledTimes(1);
  });

  it('삭제 is disabled with the reason for sessions deck cannot delete; no menu without actions', () => {
    const tm = menu({ deleteBlocked: 'Codex 앱 기록은 AI-MSG에서 지울 수 없어요' });
    renderChat([], false, vi.fn(), { title: 'gpt', sessionId: 's1', titleMenu: tm });
    fireEvent.click(screen.getByRole('button', { name: /gpt/ }));
    const del = screen.getByRole('menuitem', { name: '삭제…' });
    expect(del.getAttribute('aria-disabled')).toBe('true');
    expect(del.getAttribute('title')).toBe('Codex 앱 기록은 AI-MSG에서 지울 수 없어요');
    fireEvent.click(del);
    expect(tm.onDelete).not.toHaveBeenCalled();
    cleanup();
    renderChat([], false, vi.fn(), { title: 'plain' });
    fireEvent.click(screen.getByTestId('session-chip-head'));
    expect(screen.queryByRole('menuitem', { name: '이름 바꾸기' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '삭제…' })).toBeNull();
  });

  describe('history placeholder and pane drop', () => {
    it('shows 불러오는 중… while loading with no items, and nothing once items exist', () => {
      renderChat([], false, vi.fn(), { loading: true });
      expect(screen.getByTestId('chat-loading')).toHaveProperty('textContent', '불러오는 중…');
      expect(screen.getByRole('status')).toBeTruthy();
      cleanup();
      renderChat([{ kind: 'user', text: 'q', ts: null } as ChatItem], false, vi.fn(), { loading: true });
      expect(screen.queryByTestId('chat-loading')).toBeNull();
      cleanup();
      renderChat([], false, vi.fn(), { loading: false });
      expect(screen.queryByTestId('chat-loading')).toBeNull();
    });

    it('a file dragged anywhere on the pane shows the overlay; moving between children keeps it (no relatedTarget needed — Safari); leaving or dropping hides it', () => {
      renderChat([]);
      const main = document.querySelector('main.chat')!;
      const body = document.querySelector('.chat-body')!;
      const files = { types: ['Files'], files: [], items: [] };
      fireEvent.dragEnter(main, { dataTransfer: files });
      expect(fireEvent.dragOver(main, { dataTransfer: files })).toBe(false); // preventDefault → the browser will not open the file
      expect(screen.getByTestId('drop-overlay').textContent).toBe('여기에 파일을 놓으세요');
      fireEvent.dragEnter(body, { dataTransfer: files }); // onto a child: enter (child) fires before leave (pane)
      fireEvent.dragLeave(main, { dataTransfer: files });
      expect(screen.queryByTestId('drop-overlay')).not.toBeNull();
      fireEvent.dragLeave(body, { dataTransfer: files }); // out of the pane
      expect(screen.queryByTestId('drop-overlay')).toBeNull();
      fireEvent.dragEnter(body, { dataTransfer: files });
      expect(fireEvent.drop(body, { dataTransfer: files })).toBe(false);
      expect(screen.queryByTestId('drop-overlay')).toBeNull();
      fireEvent.dragEnter(body, { dataTransfer: files }); // the count starts over after a drop
      expect(screen.queryByTestId('drop-overlay')).not.toBeNull();
      fireEvent.dragLeave(body, { dataTransfer: files });
      expect(screen.queryByTestId('drop-overlay')).toBeNull();
    });

    it('a read-only session shows its reason instead and accepts nothing', async () => {
      const uploadFn = vi.fn(async (f: File) => ({ id: 'id-1', name: f.name, size: f.size, isImage: true }));
      renderChat([], false, vi.fn(), { readOnly: '읽기만 할 수 있어요', uploadFn });
      const body = document.querySelector('.chat-body')!;
      const file = new File(['x'], 'a.png', { type: 'image/png' });
      const dt = { types: ['Files'], files: [file], items: [], dropEffect: 'copy' };
      fireEvent.dragEnter(body, { dataTransfer: dt });
      fireEvent.dragOver(body, { dataTransfer: dt });
      expect(screen.getByTestId('drop-overlay').textContent).toBe('읽기만 할 수 있어요');
      expect(dt.dropEffect).toBe('none');
      expect(fireEvent.drop(body, { dataTransfer: dt })).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(uploadFn).not.toHaveBeenCalled();
    });

    it('a file dropped on the transcript (not just the composer) is uploaded', async () => {
      const uploadFn = vi.fn(async (f: File) => ({ id: 'id-1', name: f.name, size: f.size, isImage: true }));
      renderChat([], false, vi.fn(), { uploadFn });
      const file = new File(['x'], 'a.png', { type: 'image/png' });
      fireEvent.drop(document.querySelector('.chat-body')!, { dataTransfer: { types: ['Files'], files: [file], items: [] } });
      await waitFor(() => expect(uploadFn).toHaveBeenCalledTimes(1));
    });

    it('a text drop (rename / edit / queue fields) is left to the browser', () => {
      renderChat([]);
      expect(fireEvent.drop(document.querySelector('.chat-body')!, { dataTransfer: { types: ['text/plain'] } })).toBe(true);
    });

    it('dragging text (not files) leaves the pane alone', () => {
      renderChat([]);
      expect(fireEvent.dragOver(document.querySelector('.chat-body')!, { dataTransfer: { types: ['text/plain'] } })).toBe(true);
      expect(screen.queryByTestId('drop-overlay')).toBeNull();
    });
  });
  describe('message keys', () => {
    const asst = (text: string, extra: Partial<Extract<ChatItem, { kind: 'assistant' }>> = {}): ChatItem => ({ kind: 'assistant', turnId: null, text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], ...extra });
    const thought = { text: '깊은 생각', redacted: false, startedAt: null, ms: 3000 };

    it('anchored on user ordinals: a row added earlier in the list does not move the keys of later turns', () => {
      const a = messageKeys([{ kind: 'user', text: 'q0', n: 0 }, asst('a0'), { kind: 'user', text: 'q1', n: 1 }, asst('a1')]);
      const b = messageKeys([{ kind: 'user', text: 'q0', n: 0 }, { kind: 'system', source: 'hook', label: 'Stop', text: 'x' }, asst('a0'), { kind: 'user', text: 'q1', n: 1 }, asst('a1')]);
      expect(a.slice(2)).toEqual(b.slice(3));
      expect(new Set(b).size).toBe(b.length);
      // a repeated ordinal (should never happen) still yields unique keys
      const d = messageKeys([{ kind: 'user', text: 'x', n: 0 }, { kind: 'user', text: 'y', n: 0 }, asst('z')]);
      expect(new Set(d).size).toBe(3);
    });

    it('an expanded thinking card stays expanded when the history reloads the same messages (with a row shifted in before it)', () => {
      const cached: ChatItem[] = [{ kind: 'user', text: 'q0', n: 0 }, asst('a0'), { kind: 'user', text: 'q1', n: 1 }, asst('a1', { thinking: thought })];
      const { rerender } = render(<Chat {...chatProps(cached)} />);
      const details = screen.getByTestId('thinking') as HTMLDetailsElement;
      details.open = true;
      const reloaded: ChatItem[] = [{ kind: 'user', text: 'q0', n: 0 }, { kind: 'system', source: 'hook', label: 'Stop', text: 'x' }, asst('a0'), { kind: 'user', text: 'q1', n: 1 }, asst('a1', { thinking: { ...thought } })];
      rerender(<Chat {...chatProps(reloaded)} />);
      expect((screen.getByTestId('thinking') as HTMLDetailsElement).open).toBe(true);
    });

    it('loading over cached items: no skeleton, a quiet 불러오는 중 status instead', () => {
      renderChat([{ kind: 'user', text: 'q0', n: 0 }], false, vi.fn(), { loading: true });
      expect(screen.queryByTestId('chat-loading')).toBeNull();
      expect(screen.getByTestId('chat-refreshing').textContent).toContain('불러오는 중');
      cleanup();
      renderChat([], false, vi.fn(), { loading: true });
      expect(screen.getByTestId('chat-loading')).not.toBeNull();
      expect(screen.queryByTestId('chat-refreshing')).toBeNull();
    });
  });
});

describe('Composer placeholder and 보내기', () => {
  afterEach(cleanup);
  it('names the session ("{이름}에게 메시지 보내기"), plain "메시지 보내기" for a new one; a long name is cut', () => {
    renderChat([], false, vi.fn(), { title: '$BBAI' });
    expect(screen.getByLabelText('메시지').getAttribute('placeholder')).toBe('$BBAI에게 메시지 보내기');
    cleanup();
    renderChat([], false, vi.fn(), { isNew: true, title: '새 세션' });
    expect(screen.getByLabelText('메시지').getAttribute('placeholder')).toBe('메시지 보내기');
    expect(composerPlaceholder('  ')).toBe('메시지 보내기');
    expect(composerPlaceholder('a'.repeat(40))).toBe(`${'a'.repeat(29)}…에게 메시지 보내기`);
  });

  it('disabled 보내기 is neutral (--track), only an enabled one is the accent', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    const disabled = [...css.matchAll(/(^|\n)[^\n{]*\.send:disabled \{([^}]*)\}/g)].map((m) => m[2]!);
    expect(disabled.length).toBeGreaterThan(0);
    for (const d of disabled) { expect(d).not.toMatch(/--accent/); }
    expect(disabled[disabled.length - 1]).toMatch(/background: var\(--track\)/);
  });

  it('the session chip focus ring is a box-shadow (--focus is a shadow value), kept on hover', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    expect(css).not.toMatch(/(session-chip|\.send):focus-visible[^{]*\{[^}]*outline: 2px solid var\(--focus\)/);
    expect(css).toMatch(/\.session-chip:focus-visible, \.session-chip:focus-visible:hover \{[^}]*box-shadow:[^}]*var\(--focus\)/);
  });
});

describe('Chat · model name once per turn', () => {
  afterEach(cleanup);
  it('only the last reply block of each turn names its model (system rows do not end a turn)', () => {
    const a = (text: string): ChatItem => ({ kind: 'assistant', turnId: null, text, model: 'claude-opus-5-5', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] });
    const items: ChatItem[] = [{ kind: 'user', text: 'q0', n: 0 }, a('a'), a('b'), { kind: 'system', source: 'hook', label: 'Stop', text: 'x' }, a('c'), { kind: 'user', text: 'q1', n: 1 }, { ...a('d'), model: 'claude-sonnet-5-5' } as ChatItem];
    render(<Chat {...chatProps(items)} />);
    expect(screen.getAllByTestId('msg-model')).toHaveLength(2);
  });
  it('a turn on the same model as the turn before does not name it again', () => {
    const a = (text: string): ChatItem => ({ kind: 'assistant', turnId: null, text, model: 'claude-opus-5-5', toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] });
    render(<Chat {...chatProps([{ kind: 'user', text: 'q0', n: 0 }, a('a'), { kind: 'user', text: 'q1', n: 1 }, a('b')])} />);
    expect(screen.getAllByTestId('msg-model')).toHaveLength(1);
  });
});
