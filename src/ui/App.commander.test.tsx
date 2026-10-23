// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClientMessage, CommanderView, ServerMessage } from '../shared/protocol';
import { commanderLabel } from './components/CommanderChip';
import { commanderFormError } from './components/CommanderSheet';

Element.prototype.scrollIntoView = () => {};

const sock = vi.hoisted(() => ({ frames: [] as unknown[], onMessage: null as ((m: unknown) => void) | null }));
vi.mock('./ws', () => ({
  createSocket: (onMessage: (m: unknown) => void, onStatus: (v: boolean) => void) => {
    sock.onMessage = onMessage;
    onStatus(true);
    return { send: (m: unknown) => { sock.frames.push(m); }, wake: () => {}, reconnect: () => {}, retry: () => {}, close: () => {} };
  },
}));

import { App } from './App';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;
const entry = (sessionId: string, title: string) => ({ sessionId, account: 'b' as const, cwd: '/w', projectDir: '/p', title, lastModified: Date.now(), sizeBytes: 1 });
const hello = (features: string[]) => ({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one')] }], running: [], codex: { available: false }, features } as unknown as ServerMessage);
function server(msg: unknown) { act(() => sock.onMessage!(msg)); }
const frames = () => sock.frames as ClientMessage[];
const sent = (type: string) => frames().filter((f) => f.type === type);

const view = (over: Partial<CommanderView['state']> = {}, rest: Partial<CommanderView> = {}): CommanderView => ({
  state: { status: 'running', hop: 7, maxTurns: 20, epoch: 3, goal: '테스트 고치기', done: 'npm test 통과', budget: { maxAutoTurns: 20, autoTurnsUsed: 7, maxTokens: 0, tokensUsed: 0, maxWallClockMs: 0, maxInternalRetries: 3, internalRetriesUsed: 0 }, ...over },
  ...rest,
});

/** Boots, opens 'one' and answers its open_session (history carries the session's commander, as on a reconnect). */
async function bootOpen(features: string[], commander: CommanderView | null = null) {
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  server(hello(features));
  fireEvent.click(within(document.querySelector('.sidebar') as HTMLElement).getByText('one'));
  server({ type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [], ...(features.includes('commander') ? { commander } : {}) });
}
const pane = () => screen.getAllByTestId(/^pane-/)[0]!;
/** The pane's head: a lone pane's sits in the top bar, outside the pane. */
const head = () => document.querySelector<HTMLElement>('[data-pane-head]')!;
const openMenu = () => fireEvent.click(within(head()).getByTestId('session-chip-head'));
const menuItem = (name: string) => screen.queryByRole('menuitem', { name });

describe('총사령탑 (commander) UI', () => {
  beforeEach(() => {
    localStorage.clear();
    sock.frames = [];
    sock.onMessage = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });
  afterEach(() => { vi.useRealTimers(); cleanup(); vi.unstubAllGlobals(); });

  it('the ⋯ item is not there when the server does not advertise commander', async () => {
    await bootOpen([]);
    openMenu();
    expect(menuItem('총사령탑 걸기…')).toBeNull();
    expect(screen.queryByTestId('commander-chip')).toBeNull();
  });

  it('걸기 sheet: required fields and turn range gate the button; 걸기 sends commander_set and a server view closes it', async () => {
    await bootOpen(['commander']);
    openMenu();
    fireEvent.click(menuItem('총사령탑 걸기…')!);
    const sheet = screen.getByRole('dialog', { name: '총사령탑 걸기' });
    const go = within(sheet).getByRole('button', { name: '걸기' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('목표'), { target: { value: '  테스트 고치기 ' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('완료 조건'), { target: { value: 'npm test 통과' } });
    expect(go.disabled).toBe(false);
    const turns = within(sheet).getByLabelText('턴 상한') as HTMLInputElement;
    expect(turns.value).toBe('20');
    fireEvent.change(turns, { target: { value: '51' } });
    expect(go.disabled).toBe(true);
    expect(within(sheet).getByText('턴 상한은 1~50')).toBeTruthy();
    fireEvent.change(turns, { target: { value: '12' } });
    fireEvent.click(go);
    expect(sent('commander_set')).toEqual([{ type: 'commander_set', sessionId: 's1', goal: '테스트 고치기', done: 'npm test 통과', maxTurns: 12 }]);
    server({ type: 'commander', sessionId: 's1', ...view({ status: 'armed', hop: 0, maxTurns: 12, epoch: 1 }) });
    expect(screen.queryByRole('dialog', { name: '총사령탑 걸기' })).toBeNull();
    expect(within(head()).getByText('사령탑 진행 중 · 0/12턴')).toBeTruthy();
  });

  it('a refused 걸기 says why in Korean and the sheet stays', async () => {
    await bootOpen(['commander']);
    openMenu();
    fireEvent.click(menuItem('총사령탑 걸기…')!);
    const sheet = screen.getByRole('dialog', { name: '총사령탑 걸기' });
    fireEvent.change(within(sheet).getByLabelText('목표'), { target: { value: 'g' } });
    fireEvent.change(within(sheet).getByLabelText('완료 조건'), { target: { value: 'd' } });
    fireEvent.click(within(sheet).getByRole('button', { name: '걸기' }));
    server({ type: 'error', turnId: null, sessionId: 's1', code: 'commander_bypass', message: 'bypass' });
    expect(within(sheet).getByText('모두 자동 승인 세션에는 걸 수 없습니다')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '총사령탑 걸기' })).toBeTruthy();
  });

  it('restored from history: the chip, ■ 정지 in one tap with the epoch it saw, and ⋯ offers 정지 instead of 걸기', async () => {
    await bootOpen(['commander'], view());
    expect(within(head()).getByText('사령탑 진행 중 · 7/20턴')).toBeTruthy();
    expect(within(head()).queryByRole('button', { name: '사령탑 재개' })).toBeNull();
    fireEvent.click(within(head()).getByRole('button', { name: '사령탑 정지' }));
    expect(sent('commander_stop')).toEqual([{ type: 'commander_stop', sessionId: 's1', epoch: 3 }]);
    openMenu();
    expect(menuItem('총사령탑 걸기…')).toBeNull();
    fireEvent.click(menuItem('총사령탑 정지')!);
    expect(sent('commander_stop')).toHaveLength(2);
  });

  it('a stale-epoch refusal says so on the chip; 재개 when it waits for a person; the chip opens the last verdict', async () => {
    await bootOpen(['commander'], view({ status: 'waiting_human', epoch: 5 }, { note: '권한 카드 응답 대기', lastVerdict: { verdict: 'human', reason: '되돌리기 어려움', next: '확인 필요', atMs: new Date(2026, 9, 18, 9, 5).getTime() } }));
    expect(within(head()).getByText('사령탑 · 사람 필요 · 7/20턴')).toBeTruthy();
    fireEvent.click(within(head()).getByRole('button', { name: '사령탑 재개' }));
    expect(sent('commander_resume')).toEqual([{ type: 'commander_resume', sessionId: 's1', epoch: 5 }]);
    server({ type: 'error', turnId: null, sessionId: 's1', code: 'commander_stale_epoch', message: 'stale' });
    expect(within(head()).getByRole('alert').textContent).toBe('화면이 오래됐습니다 — 다시 시도');
    fireEvent.click(within(head()).getByText('사령탑 · 사람 필요 · 7/20턴'));
    const detail = within(head()).getByRole('region', { name: '마지막 판정' });
    expect(detail.textContent).toContain('되돌리기 어려움');
    expect(detail.textContent).toContain('확인 필요');
    expect(detail.textContent).toContain('09:05');
    expect(detail.textContent).toContain('권한 카드 응답 대기');
    expect(within(head()).queryByRole('alert')).toBeNull(); // tapping the chip clears the refusal line
  });

  it('a settings broadcast that turns it off takes the menu item away', async () => {
    await bootOpen(['commander']);
    server({ type: 'settings', settings: { autoApprove: false, commanderEnabled: false }, features: [] });
    openMenu();
    expect(menuItem('총사령탑 걸기…')).toBeNull();
  });

  it('a commander refusal with the feature off here shows in the pane notices (no chip to say it)', async () => {
    await bootOpen([]);
    server({ type: 'error', turnId: null, sessionId: 's1', code: 'commander_disabled', message: '총사령탑이 꺼져 있습니다 — 설정에서 총사령탑을 켜 주세요' });
    expect(within(pane()).getByText('총사령탑이 꺼져 있습니다 — 설정에서 총사령탑을 켜 주세요')).toBeTruthy();
  });

  it('a mode change refused because a commander is active, with no commander view here: the pane notices say it', async () => {
    await bootOpen(['commander']);
    server({ type: 'error', turnId: null, sessionId: 's1', code: 'commander_active', message: '총사령탑이 걸린 세션은 모두 자동 승인으로 바꿀 수 없습니다 — 먼저 정지하세요' });
    expect(within(pane()).getByText('총사령탑이 걸린 세션은 모두 자동 승인으로 바꿀 수 없습니다 — 먼저 정지하세요')).toBeTruthy();
  });

  it("the chip's 8-second refusal timer leaves the sheet's refusal until the sheet closes", async () => {
    await bootOpen(['commander'], view({ status: 'stopped', epoch: 4 }));
    vi.useFakeTimers();
    openMenu();
    fireEvent.click(menuItem('총사령탑 걸기…')!);
    const sheet = screen.getByRole('dialog', { name: '총사령탑 걸기' });
    fireEvent.change(within(sheet).getByLabelText('목표'), { target: { value: 'g' } });
    fireEvent.change(within(sheet).getByLabelText('완료 조건'), { target: { value: 'd' } });
    fireEvent.click(within(sheet).getByRole('button', { name: '걸기' }));
    server({ type: 'error', turnId: null, sessionId: 's1', code: 'commander_bypass', message: 'bypass' });
    act(() => { vi.advanceTimersByTime(9000); });
    expect(within(sheet).getByText('모두 자동 승인 세션에는 걸 수 없습니다')).toBeTruthy();
  });

  it('turning it off drops the cached chips and refusals: turned on again, no old chip', async () => {
    await bootOpen(['commander'], view());
    expect(screen.getByTestId('commander-chip')).toBeTruthy();
    server({ type: 'error', turnId: null, sessionId: 's1', code: 'commander_stale_epoch', message: 'stale' });
    server({ type: 'settings', settings: { autoApprove: false, commanderEnabled: false }, features: [] });
    server({ type: 'settings', settings: { autoApprove: false, commanderEnabled: true }, features: ['commander'] });
    expect(screen.queryByTestId('commander-chip')).toBeNull();
    expect(within(pane()).queryByText('화면이 오래됐습니다 — 다시 시도')).toBeNull();
  });

  it("the sheet's turn cap starts at the settings' commanderMaxTurns", async () => {
    await bootOpen(['commander']);
    server({ type: 'settings', settings: { autoApprove: false, commanderEnabled: true, commanderMaxTurns: 7 } });
    openMenu();
    fireEvent.click(menuItem('총사령탑 걸기…')!);
    const sheet = screen.getByRole('dialog', { name: '총사령탑 걸기' });
    expect((within(sheet).getByLabelText('턴 상한') as HTMLInputElement).value).toBe('7');
    fireEvent.change(within(sheet).getByLabelText('목표'), { target: { value: 'g' } });
    fireEvent.change(within(sheet).getByLabelText('완료 조건'), { target: { value: 'd' } });
    fireEvent.click(within(sheet).getByRole('button', { name: '걸기' }));
    expect(sent('commander_set')).toEqual([{ type: 'commander_set', sessionId: 's1', goal: 'g', done: 'd', maxTurns: 7 }]);
  });
});

describe('commander chip text and sheet checks', () => {
  it('names every state', () => {
    expect(commanderLabel(view())).toBe('사령탑 진행 중 · 7/20턴');
    expect(commanderLabel(view({ status: 'judging' }))).toBe('사령탑 판정 중 · 7/20턴');
    expect(commanderLabel(view({ status: 'paused' }))).toBe('사령탑 · 일시 정지 · 7/20턴');
    expect(commanderLabel(view({ status: 'done' }))).toBe('사령탑 · 끝 · 7/20턴');
    expect(commanderLabel(view({ status: 'stopped' }))).toBe('사령탑 · 정지됨 · 7/20턴');
    expect(commanderLabel(view({ status: 'waiting_human' }, { note: '턴 상한 도달(20/20)' }))).toBe('사령탑 · 상한 도달 · 7/20턴');
    expect(commanderLabel(view({ status: 'waiting_human' }, { note: '재시작으로 끊김 · 재개' }))).toBe('사령탑 · 재시작으로 끊김 · 7/20턴');
    expect(commanderLabel(view({ status: 'waiting_human' }, { note: '질문 카드 응답 대기' }))).toBe('사령탑 · 사람 필요 · 7/20턴');
  });

  it('form limits match the server schema', () => {
    expect(commanderFormError(' ', 'd', '20')).not.toBeNull();
    expect(commanderFormError('g', '', '20')).not.toBeNull();
    expect(commanderFormError('x'.repeat(2001), 'd', '20')).not.toBeNull();
    expect(commanderFormError('x'.repeat(2000), 'd', '20')).toBeNull();
    expect(commanderFormError('g', 'd', '0')).not.toBeNull();
    expect(commanderFormError('g', 'd', '2.5')).not.toBeNull();
    expect(commanderFormError('g', 'd', '50')).toBeNull();
  });

  it('styles: theme variables only (light and dark follow) and a bottom sheet at phone width', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    const own = css.slice(css.indexOf('/* 총사령탑'));
    expect(own).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(own).toMatch(/:where\(:root\[data-phone\]\) \{[\s\S]*\.sheet-backdrop:has\(> \.commander-sheet\) \{ align-items: flex-end; \}/);
  });
});
