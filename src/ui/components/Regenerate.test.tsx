// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientMessage } from '../../shared/protocol';
import type { TranscriptMessage } from '../../shared/session-types';
import { initialState, reducer, type ChatItem, type PaneState, type UploadedAttachment } from '../state';
import { mergeToolRuns } from '../toolRuns';
import { replyTurn } from '../replyTurn';
import { MessageView } from './MessageView';
import { Pane } from './Pane';

Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

const u = (text: string, n: number): TranscriptMessage => ({ kind: 'user', text, ts: null, n });
const a = (text: string, toolCalls: { id: string; name: string; input: unknown }[] = []): TranscriptMessage => ({ kind: 'assistant', text, model: null, toolCalls, ts: null });

function open(messages: TranscriptMessage[], engine: 'claude' | 'codex' = 'claude') {
  let s = reducer(initialState, { type: 'open', sessionId: 'R', cwd: '/w', title: '원본' });
  s = reducer(s, { type: 'server', msg: { type: 'history', sessionId: 'R', cwd: '/w', account: engine === 'codex' ? 'gpt' : 'b', engine, ...(engine === 'claude' ? { sessionModel: 'opus' as const } : {}), runningTurnId: null, messages } });
  const sent: ClientMessage[] = [];
  const dispatch = (x: Parameters<typeof reducer>[1]) => { s = reducer(s, x); };
  const ui = (pane: PaneState) => <Pane pane={pane} app={{ pending: [], questions: [], codexAvailable: true, projects: [] }} active closable={false} dispatch={dispatch} send={(m) => sent.push(m)} onClose={() => {}} />;
  const view = render(ui(s.panes[0]!));
  return { sent, state: () => s, dispatch, attach: (attachment: UploadedAttachment, paneId: string) => dispatch({ type: 'attach', attachment, paneId }), rerender: () => view.rerender(ui(s.panes[0]!)) };
}

const THREE = [u('첫 질문', 0), a('답 0'), u('두 번째', 1), a('답 1'), u('세 번째', 2), a('답 2')];

describe('다시 생성 · any turn', () => {
  it('an earlier reply offers 다시 생성; it branches from that turn with the prompt unchanged (like 편집)', () => {
    const t = open(THREE);
    // The last reply keeps 재시도 (same session); the two earlier ones get 다시 생성.
    expect(screen.getAllByRole('button', { name: '재시도' })).toHaveLength(1);
    const again = screen.getAllByRole('button', { name: '다시 생성' });
    expect(again).toHaveLength(2);
    fireEvent.click(again[1]!);
    expect(t.sent).toHaveLength(1);
    const m = t.sent[0] as Extract<ClientMessage, { type: 'send' }>;
    expect(m).toMatchObject({ type: 'send', sessionId: null, cwd: '/w', text: '두 번째', engine: 'claude', branch: { from: 'R', n: 1, expect: '두 번째' } });
    // No model was picked: the send leaves it to the session, as 편집 does.
    expect(m.model).toBeUndefined();
    const pane = t.state().panes[0]!;
    expect(pane.session?.sessionId).toBeNull();
    expect(pane.items.map((it) => (it.kind === 'user' ? it.text : it.kind))).toEqual(['첫 질문', 'assistant', '두 번째']);
  });

  it("picking a model branches with it and the pane's picker follows (the branch keeps that model)", () => {
    const t = open(THREE);
    const before = t.state().panes[0]!;
    const carets = screen.getAllByRole('button', { name: '다른 모델로 다시 생성' });
    // Every reply (the last too) can be run again with another model.
    expect(carets).toHaveLength(3);
    fireEvent.click(carets[0]!);
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(items.some((x) => x?.includes('Sonnet'))).toBe(true);
    expect(items.some((x) => x?.includes('자동'))).toBe(false);
    fireEvent.click(screen.getAllByRole('menuitem').find((b) => b.textContent?.includes('Sonnet'))!);
    expect(t.sent[0]).toMatchObject({ type: 'send', sessionId: null, text: '첫 질문', model: 'sonnet', branch: { from: 'R', n: 0 } });
    const after = t.state().panes[0]!;
    expect(before.model).not.toBe('sonnet');
    expect(after.model).toBe('sonnet');
    expect(after.modelPicked).toBe(true);
    expect(t.sent.some((m) => m.type !== 'send')).toBe(false);
  });

  it('a refused branch puts the picker back on the model before the pick, with a one-line notice', () => {
    const t = open(THREE);
    const before = t.state().panes[0]!;
    fireEvent.click(screen.getAllByRole('button', { name: '다른 모델로 다시 생성' })[0]!);
    fireEvent.click(screen.getAllByRole('menuitem').find((b) => b.textContent?.includes('Sonnet'))!);
    t.rerender();
    expect(t.state().panes[0]!.model).toBe('sonnet');
    const ref = (t.sent[0] as Extract<ClientMessage, { type: 'send' }>).clientRef!;
    act(() => { t.dispatch({ type: 'server', msg: { type: 'error', turnId: null, clientRef: ref, message: '갈래를 만들 수 없습니다' } }); });
    act(() => { t.rerender(); });
    const after = t.state().panes[0]!;
    expect(after.model).toBe(before.model);
    expect(after.modelPicked).toBe(before.modelPicked);
    expect(after.notices?.some((n) => n.message.startsWith('갈래를 만들지 못해 모델을'))).toBe(true);
  });

  it('a branch picked without another model leaves the picker alone when refused', () => {
    const t = open(THREE);
    const before = t.state().panes[0]!;
    fireEvent.click(screen.getAllByRole('button', { name: '다시 생성' })[0]!);
    t.rerender();
    const ref = (t.sent[0] as Extract<ClientMessage, { type: 'send' }>).clientRef!;
    act(() => { t.dispatch({ type: 'server', msg: { type: 'error', turnId: null, clientRef: ref, message: 'x' } }); });
    act(() => { t.rerender(); });
    expect(t.state().panes[0]!.model).toBe(before.model);
    expect(t.state().panes[0]!.notices?.some((n) => n.message.startsWith('갈래를 만들지 못해'))).toBe(false);
  });

  it('the last reply with another model branches too (a plain send with a model would change the session’s own)', () => {
    const t = open(THREE);
    fireEvent.click(screen.getAllByRole('button', { name: '다른 모델로 다시 생성' })[2]!);
    fireEvent.click(screen.getAllByRole('menuitem').find((b) => b.textContent?.includes('Sonnet'))!);
    expect(t.sent[0]).toMatchObject({ sessionId: null, text: '세 번째', model: 'sonnet', branch: { from: 'R', n: 2 } });
  });

  it('only the reply that ends its turn (tool runs folded) gets the actions; none while a turn runs', () => {
    const t = open([u('질문', 0), a('먼저 볼게요'), a('', [{ id: 't1', name: 'Bash', input: { command: 'ls' } }]), a('끝'), u('다음', 1), a('답')]);
    expect(screen.getAllByRole('button', { name: '다시 생성' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '다시 생성' }));
    expect(t.sent[0]).toMatchObject({ text: '질문', branch: { n: 0 } });
    cleanup();
    const busy = open(THREE);
    const s = reducer(busy.state(), { type: 'sent', text: '넷', paneId: busy.state().panes[0]!.id, clientRef: 'x' });
    cleanup();
    render(<Pane pane={s.panes[0]!} app={{ pending: [], questions: [], codexAvailable: false, projects: [] }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: '다시 생성' })).toBeNull();
    expect(screen.queryByRole('button', { name: '다른 모델로 다시 생성' })).toBeNull();
  });

  it('GPT: no branch, so earlier replies get nothing; the last one re-sends with the picked model (no set_model)', () => {
    const t = open([u('하나', 0), a('일'), u('둘', 1), a('이')], 'codex');
    expect(screen.queryByRole('button', { name: '다시 생성' })).toBeNull();
    const carets = screen.getAllByRole('button', { name: '다른 모델로 다시 생성' });
    expect(carets).toHaveLength(1);
    const before = t.state().panes[0]!;
    fireEvent.click(carets[0]!);
    const names = screen.getAllByRole('menuitem').map((b) => b.textContent ?? '');
    expect(names.every((x) => /GPT/.test(x))).toBe(true);
    fireEvent.click(screen.getAllByRole('menuitem').find((b) => !b.className.includes('on'))!);
    const m = t.sent[0] as Extract<ClientMessage, { type: 'send' }>;
    expect(m).toMatchObject({ type: 'send', sessionId: 'R', text: '둘' });
    expect(m.model).not.toBe(before.model);
    expect(t.state().panes[0]!.model).toBe(before.model);
  });

  it('GPT: the re-send carries none of the composer’s attachments, and they stay for the next message', () => {
    const t = open([u('하나', 0), a('일')], 'codex');
    const file = { id: 'f1', name: 'note.txt', size: 3, isImage: false };
    // Attached for the next message, not for the old prompt.
    t.attach(file, t.state().panes[0]!.id);
    t.rerender();
    fireEvent.click(screen.getByRole('button', { name: '다른 모델로 다시 생성' }));
    fireEvent.click(screen.getAllByRole('menuitem').find((b) => !b.className.includes('on'))!);
    const m = t.sent[0] as Extract<ClientMessage, { type: 'send' }>;
    expect(m).toMatchObject({ type: 'send', sessionId: 'R', text: '하나' });
    expect(m.attachments).toBeUndefined();
    expect(t.state().panes[0]!.attachments).toEqual([file]);
  });
});

describe('replyTurn', () => {
  it('finds the turn of a folded copy (mergeToolRuns) and none for a reply mid-turn', () => {
    const r = (text: string, extra: Partial<Extract<ChatItem, { kind: 'assistant' }>> = {}): ChatItem => ({ kind: 'assistant', turnId: null, text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], ...extra });
    const items: ChatItem[] = [{ kind: 'user', text: 'q', n: 3 }, r('mid'), r('', { toolCalls: [{ toolUseId: 'x', name: 'Bash', input: {}, result: null, isError: false }] }), r('end')];
    const shown = mergeToolRuns(items);
    expect(replyTurn(items, shown[1]!)).toBeNull();
    expect(replyTurn(items, shown[2]!)).toEqual({ n: 3, text: 'q' });
    // A message with attachments or no position cannot be branched from.
    expect(replyTurn([{ kind: 'user', text: 'q' }, r('a')], r('a'))).toBeNull();
  });
});

describe('긴 사용자 메시지 접기', () => {
  const long = Array.from({ length: 20 }, (_, i) => `줄 ${i + 1}`).join('\n');

  it('folds past 12 lines with 더 보기 (N줄); 접기 folds it back', () => {
    render(<MessageView item={{ kind: 'user', text: long }} />);
    const pre = screen.getByTestId('user-text');
    expect(pre.className).toContain('folded');
    // The whole text stays in the DOM (copy, search).
    expect(pre.textContent).toBe(long);
    fireEvent.click(screen.getByRole('button', { name: '더 보기 (20줄)' }));
    expect(pre.className).not.toContain('folded');
    fireEvent.click(screen.getByRole('button', { name: '접기' }));
    expect(pre.className).toContain('folded');
  });

  it('folds past 1200 characters; a short message never folds', () => {
    render(<MessageView item={{ kind: 'user', text: 'ㄱ'.repeat(1300) }} />);
    expect(screen.getByTestId('user-text').className).toContain('folded');
    cleanup();
    render(<MessageView item={{ kind: 'user', text: '짧은\n메시지' }} />);
    expect(screen.queryByTestId('user-text')).toBeNull();
    expect(screen.queryByRole('button', { name: /더 보기/ })).toBeNull();
  });

  it('a search jump (search-flash on the message) unfolds it', async () => {
    const { container } = render(<MessageView item={{ kind: 'user', text: long }} />);
    await act(async () => { container.querySelector('.msg')!.classList.add('search-flash'); await Promise.resolve(); });
    expect(screen.getByTestId('user-text').className).not.toContain('folded');
    expect(screen.getByRole('button', { name: '접기' })).toBeTruthy();
  });
});
