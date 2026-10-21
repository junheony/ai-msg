// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ALERT_SEED_MS, ActivityButton, activityLabel, activitySummary, useHighlightCount } from './ActivityButton';
import { ActivitySheet, FORCE_RESTART_WARNING, RESTART_WAIT_WARNING, idleLabel, restartConfirmText, uptimeLabel, type ActivitySheetProps } from './ActivitySheet';
import type { SessionActivity } from '../../shared/protocol';

const M = 60_000;
/** Lets pending fetch promises (and the state they set) settle. */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const act1 = (over: Partial<SessionActivity>): SessionActivity => ({ sessionId: 's', cwd: '/p', turnId: 't', running: false, bg: 0, forMs: 0, ...over });
const upd = (changedFiles: number, supervised = true) => new Response(JSON.stringify({ changedFiles, newestAt: 1, supervised, draining: false }), { status: 200 });
const ok = (n: number) => new Response(JSON.stringify({ hours: 24, events: Array.from({ length: n }, (_, i) => ({ at: i })) }), { status: 200 });

type Props = ComponentProps<typeof ActivityButton>;
const base = (over: Partial<Props> = {}): Props => ({
  ready: true, connected: true, downSince: null, onRetry: () => {}, pending: [], questions: [], onDecide: () => {}, onAnswer: () => {},
  activity: [], paneBg: [], titleOf: (id) => id, onOpen: () => {}, serverUpdate: true, highlights: false, visibleSessions: [], onAlert: () => {},
  server: { startedAt: null, restartedAt: null, draining: false, onDismissRestart: () => {} },
  ...over,
});
const openSheet = () => { fireEvent.click(screen.getByTestId('activity-btn')); return screen.getByRole('dialog', { name: '활동' }); };

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('labels', () => {
  it('idleLabel: nothing running, with the last work end time when known', () => {
    expect(idleLabel(null)).toBe('지금 실행 중인 작업이 없어요');
    expect(idleLabel(new Date(2026, 9, 13, 14, 2).getTime())).toBe('지금 실행 중인 작업이 없어요 · 14:02 까지 작업');
  });

  it('uptimeLabel: 방금 시작 / 분 / 시간 / 일', () => {
    expect(uptimeLabel(30_000)).toBe('서버 · 방금 시작');
    expect(uptimeLabel(-5)).toBe('서버 · 방금 시작');
    expect(uptimeLabel(5 * M)).toBe('서버 · 5분째');
    expect(uptimeLabel(3 * 60 * M + 59 * M)).toBe('서버 · 3시간째');
    expect(uptimeLabel(50 * 60 * M)).toBe('서버 · 2일째');
  });

  it('restartConfirmText: turns plus background tasks, or 바로 when idle', () => {
    expect(restartConfirmText([])).toBe('바로 재시작합니다');
    expect(restartConfirmText([act1({ running: true, bg: 2 }), act1({ sessionId: 'b', bg: 1 })])).toBe('진행 중 작업 4개가 끝나면 재시작합니다');
  });

  it('activitySummary / activityLabel: one level by priority, zeros left out', () => {
    const card = { sessionId: 's1' };
    const sum = (o: Partial<Parameters<typeof activitySummary>[0]>) => activitySummary({ pending: [], questions: [], activity: [], connected: true, serverWaiting: false, ...o });
    expect(sum({})).toEqual({ waiting: 0, running: 0, bg: 0, level: 'idle' });
    expect(activityLabel(sum({}))).toBe('활동');
    expect(sum({ activity: [act1({ bg: 1 })] }).level).toBe('bg');
    expect(sum({ activity: [act1({ running: true })] }).level).toBe('running');
    expect(sum({ activity: [act1({ running: true })], serverWaiting: true }).level).toBe('server');
    const w = sum({ pending: [card, card], activity: [act1({ running: true })], serverWaiting: true });
    expect(w.level).toBe('waiting');
    expect(activityLabel(w)).toBe('활동 · 승인 대기 2 · 실행 중 1');
    expect(sum({ pending: [card], connected: false }).level).toBe('down');
    // A /bg task stopped on a card counts unless its session's card is already counted.
    const task = { taskId: 'k', fromSessionId: 'a', cwd: '/w', title: 't', status: 'running' as const, sessionId: 's1', createdAt: 1, waiting: true };
    expect(sum({ tasks: [task] }).waiting).toBe(1);
    expect(sum({ tasks: [task], questions: [card] }).waiting).toBe(1);
    expect(sum({ tasks: [{ ...task, status: 'done' }] }).waiting).toBe(0);
    expect(activityLabel({ waiting: 0, running: 0, bg: 0, level: 'server' })).toBe('활동 · 서버 재시작 대기');
  });
});

describe('useHighlightCount', () => {
  const asks = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => u === '/api/highlights?hours=24').length;

  it('counts outcomes, not background task events; nothing asked without the feature', async () => {
    const list = [{ at: 1, kind: 'turn' }, { at: 2, kind: 'task' }, { at: 3, kind: 'task' }, { at: 4, kind: 'interrupted' }, { at: 5, kind: 'permission' }];
    const f = vi.fn(async () => new Response(JSON.stringify({ hours: 24, events: list }), { status: 200 }));
    const { result } = renderHook(() => useHighlightCount(true, true, 0, f as unknown as typeof fetch));
    await flush();
    expect(result.current).toBe(3);
    const g = vi.fn(async () => ok(1));
    renderHook(() => useHighlightCount(true, false, 0, g as unknown as typeof fetch));
    await flush();
    expect(g).not.toHaveBeenCalled();
  });

  it('waits for the connection, then asks every 5 minutes', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => ok(0));
    const { result, rerender } = renderHook(({ ready }) => useHighlightCount(ready, true, 0, f as unknown as typeof fetch), { initialProps: { ready: false } });
    expect(asks(f)).toBe(0);
    rerender({ ready: true });
    await flush();
    expect(asks(f)).toBe(1);
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(5 * M); });
    expect(asks(f)).toBe(2);
  });

  it('a turn ending (running drops) asks 2s later, once for several; a rise does not ask', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => ok(3));
    const { rerender } = renderHook(({ running }) => useHighlightCount(true, true, running, f as unknown as typeof fetch), { initialProps: { running: 2 } });
    await flush();
    expect(asks(f)).toBe(1);
    rerender({ running: 3 });
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(asks(f)).toBe(1);
    rerender({ running: 2 });
    act(() => { vi.advanceTimersByTime(1_000); });
    rerender({ running: 1 });
    act(() => { vi.advanceTimersByTime(1_999); });
    expect(asks(f)).toBe(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(asks(f)).toBe(2);
  });

  it('a failed ask keeps the number; a stale answer does not overwrite a newer one', async () => {
    vi.useFakeTimers();
    let release: (r: Response) => void = () => {};
    const f = vi.fn()
      .mockResolvedValueOnce(ok(4))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }))
      .mockResolvedValueOnce(ok(7));
    const { result } = renderHook(() => useHighlightCount(true, true, 0, f as unknown as typeof fetch));
    await flush();
    expect(result.current).toBe(4);
    act(() => { vi.advanceTimersByTime(5 * M); });
    await flush();
    act(() => { vi.advanceTimersByTime(5 * M); });
    await flush();
    expect(result.current).toBe(4);
    act(() => { vi.advanceTimersByTime(5 * M); }); // slow ask
    act(() => { vi.advanceTimersByTime(5 * M); }); // newer ask lands first
    await flush();
    expect(result.current).toBe(7);
    release(ok(1));
    await flush();
    expect(result.current).toBe(7);
  });
});

describe('활동 시트 · 서버', () => {
  it('서버 업데이트 대기 · 파일 N when code changed under a supervisor (dot ↻); hidden unsupervised, unchanged or draining', async () => {
    const f = vi.fn(async () => upd(3));
    const { rerender } = render(<ActivityButton {...base({ fetchFn: f as unknown as typeof fetch })} />);
    await flush();
    expect(f).toHaveBeenCalledWith('/api/server-update');
    expect(screen.getByTestId('activity-btn').classList.contains('lvl-server')).toBe(true);
    expect(screen.getByTestId('activity-btn').getAttribute('aria-label')).toBe('활동 · 서버 재시작 대기');
    openSheet();
    expect(screen.getByTestId('server-update').textContent).toBe('서버 업데이트 대기 · 파일 3개');
    rerender(<ActivityButton {...base({ fetchFn: f as unknown as typeof fetch, server: { startedAt: null, restartedAt: null, draining: true, onDismissRestart: () => {} } })} />);
    expect(screen.queryByTestId('server-update')).toBeNull();
    cleanup();
    for (const r of [() => upd(2, false), () => upd(0)]) {
      render(<ActivityButton {...base({ fetchFn: (async () => r()) as unknown as typeof fetch })} />);
      await flush();
      expect(screen.getByTestId('activity-btn').classList.contains('lvl-idle')).toBe(true);
      openSheet();
      expect(screen.queryByTestId('server-update')).toBeNull();
      cleanup();
    }
    // No feature → no ask at all.
    const g = vi.fn(async () => upd(3));
    render(<ActivityButton {...base({ serverUpdate: false, fetchFn: g as unknown as typeof fetch })} />);
    await flush();
    expect(g).not.toHaveBeenCalled();
  });

  it('지금 재시작 → a confirm with what it waits for; 재시작 posts /api/restart, 취소 does not', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, ...(init ? { init } : {}) }); return url === '/api/restart' ? new Response('{"ok":true,"draining":true}', { status: 200 }) : upd(1); });
    render(<ActivityButton {...base({ activity: [act1({ running: true })], fetchFn: f as unknown as typeof fetch })} />);
    await flush();
    const sheet = openSheet();
    fireEvent.click(screen.getByTestId('update-restart'));
    expect(sheet.textContent).toContain('진행 중 작업 1개가 끝나면 재시작합니다');
    expect(sheet.textContent).toContain(RESTART_WAIT_WARNING);
    expect(RESTART_WAIT_WARNING).toBe('재시작을 기다리는 동안 새 메시지는 받지 않습니다 — 진행 중인 턴·백그라운드 작업이 모두 끝나야 재시작됩니다.');
    fireEvent.click(within(sheet).getByRole('button', { name: '취소' }));
    expect(sheet.textContent).not.toContain(RESTART_WAIT_WARNING);
    expect(calls.some((c) => c.url === '/api/restart')).toBe(false);
    fireEvent.click(screen.getByTestId('update-restart'));
    fireEvent.click(within(sheet).getByRole('button', { name: '재시작' }));
    await flush();
    expect(calls.filter((c) => c.url === '/api/restart').map((c) => [c.init?.method, c.init?.body])).toEqual([['POST', '{}']]);
    expect(screen.getByTestId('update-restart')).toBeTruthy(); // the confirm closed
  });

  it('a refused restart shows the server\'s message and keeps the confirm open', async () => {
    const f = async (url: string) => (url === '/api/restart' ? new Response(JSON.stringify({ error: '관리자 없이 실행 중' }), { status: 409 }) : upd(1));
    render(<ActivityButton {...base({ fetchFn: f as unknown as typeof fetch })} />);
    await flush();
    const sheet = openSheet();
    fireEvent.click(screen.getByTestId('update-restart'));
    expect(sheet.textContent).toContain('바로 재시작합니다');
    fireEvent.click(within(sheet).getByRole('button', { name: '재시작' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('관리자 없이 실행 중');
    expect(within(sheet).getByRole('button', { name: '재시작' })).toBeTruthy();
  });

  it('draining under a supervisor: 재시작 대기 중 · 작업 N개; 작업 끊고 지금 재시작 → confirm → POST {force:true}', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, ...(init ? { init } : {}) }); return url === '/api/restart' ? new Response('{"ok":true,"draining":true,"forced":true}', { status: 200 }) : upd(1); });
    const activity = [act1({ running: true, bg: 1, tasks: ['dev server'] })];
    render(<ActivityButton {...base({ activity, fetchFn: f as unknown as typeof fetch, server: { startedAt: 1, restartedAt: null, draining: true, onDismissRestart: () => {} } })} />);
    await flush();
    const sheet = openSheet();
    expect(screen.queryByTestId('server-update')).toBeNull();
    expect(screen.getByTestId('drain-status').textContent).toBe('재시작 대기 중 · 작업 2개 기다림');
    const server = screen.getByTestId('act-server');
    expect(server.textContent).toContain('턴 진행 중');
    expect(server.textContent).toContain('· dev server');
    expect(server.textContent).toContain(RESTART_WAIT_WARNING);
    fireEvent.click(screen.getByTestId('drain-force'));
    expect(server.textContent).toContain(FORCE_RESTART_WARNING);
    expect(FORCE_RESTART_WARNING).toBe('진행 중인 턴과 백그라운드 작업(데모 서버 등)이 중단됩니다');
    fireEvent.click(within(sheet).getByRole('button', { name: '취소' }));
    expect(server.textContent).not.toContain(FORCE_RESTART_WARNING);
    expect(calls.some((c) => c.url === '/api/restart')).toBe(false);
    fireEvent.click(screen.getByTestId('drain-force'));
    fireEvent.click(within(sheet).getByRole('button', { name: '중단하고 재시작' }));
    await flush();
    expect(calls.filter((c) => c.url === '/api/restart').map((c) => [c.init?.method, c.init?.body])).toEqual([['POST', '{"force":true}']]);
    expect(screen.getByTestId('drain-force')).toBeTruthy();
  });

  it('draining: no force button unsupervised; a refused force shows the server message', async () => {
    const draining = { startedAt: 1, restartedAt: null, draining: true, onDismissRestart: () => {} };
    render(<ActivityButton {...base({ server: draining, fetchFn: (async () => upd(1, false)) as unknown as typeof fetch })} />);
    await flush();
    openSheet();
    expect(screen.getByTestId('drain-status').textContent).toBe('재시작 중…');
    expect(screen.queryByTestId('drain-force')).toBeNull();
    cleanup();
    const f = async (url: string) => (url === '/api/restart' ? new Response(JSON.stringify({ error: '재시작 대기 중이 아니라' }), { status: 400 }) : upd(0));
    render(<ActivityButton {...base({ server: draining, fetchFn: f as unknown as typeof fetch })} />);
    await flush();
    const sheet = openSheet();
    fireEvent.click(screen.getByTestId('drain-force'));
    fireEvent.click(within(sheet).getByRole('button', { name: '중단하고 재시작' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('재시작 대기 중이 아니라');
  });
});

describe('활동 점 · 알림', () => {
  const card = (sessionId: string | null, n = 0) => ({ requestId: `r-${sessionId}-${n}`, toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: false, sessionLabel: null, turnId: `t-${sessionId}`, sessionId, cwd: '/w' });

  it('a card for a session not on screen alerts once (open → its row); visible sessions and new chats do not', () => {
    vi.useFakeTimers();
    const onAlert = vi.fn();
    const onOpen = vi.fn();
    const props = (pending: ReturnType<typeof card>[]) => base({ pending: pending as unknown as Props['pending'], onAlert, onOpen, visibleSessions: ['s1'], serverUpdate: false });
    const { rerender } = render(<ActivityButton {...props([card('s1'), card(null)])} />);
    act(() => { vi.advanceTimersByTime(ALERT_SEED_MS); });
    expect(onAlert).not.toHaveBeenCalled();
    rerender(<ActivityButton {...props([card('s1'), card(null), card('s2')])} />);
    expect(onAlert).toHaveBeenCalledOnce();
    expect(onAlert.mock.calls[0]![0].text).toBe('s2 · 승인 대기');
    rerender(<ActivityButton {...props([card('s2')])} />);
    expect(onAlert).toHaveBeenCalledOnce();
    onAlert.mock.calls[0]![0].open();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's2', waiting: true }));
    expect(screen.getByTestId('activity-badge').textContent).toBe('1');
  });

  it('a reload: cards already waiting when the tab connects are shown, not alerted; later ones alert; gone ids are forgotten', () => {
    vi.useFakeTimers();
    const onAlert = vi.fn();
    const props = (pending: ReturnType<typeof card>[], ready = true) => base({ ready, pending: pending as unknown as Props['pending'], onAlert, visibleSessions: [], serverUpdate: false });
    const { rerender } = render(<ActivityButton {...props([], false)} />);
    // hello, then the waiting cards one message each, right behind it.
    rerender(<ActivityButton {...props([], true)} />);
    rerender(<ActivityButton {...props([card('s2')])} />);
    rerender(<ActivityButton {...props([card('s2'), card('s3')])} />);
    expect(onAlert).not.toHaveBeenCalled();
    expect(screen.getByTestId('activity-badge').textContent).toBe('2');
    act(() => { vi.advanceTimersByTime(ALERT_SEED_MS); });
    rerender(<ActivityButton {...props([card('s2'), card('s3'), card('s4')])} />);
    expect(onAlert).toHaveBeenCalledOnce();
    expect(onAlert.mock.calls[0]![0].text).toBe('s4 · 승인 대기');
    // A short disconnect keeps what was alerted: the reconnect's replay is no news.
    rerender(<ActivityButton {...props([card('s2'), card('s3'), card('s4')], false)} />);
    rerender(<ActivityButton {...props([card('s2'), card('s3'), card('s4')], true)} />);
    expect(onAlert).toHaveBeenCalledOnce();
    // Answered ids leave the set (ids are never reused, so this only bounds its size).
    rerender(<ActivityButton {...props([])} />);
    rerender(<ActivityButton {...props([card('s4')])} />);
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  it('the badge caps at 99+', () => {
    render(<ActivityButton {...base({ pending: Array.from({ length: 120 }, (_, i) => card('s1', i)) as unknown as Props['pending'], visibleSessions: ['s1'], serverUpdate: false })} />);
    expect(screen.getByTestId('activity-badge').textContent).toBe('99+');
  });
});

describe('활동 시트 · 포커스', () => {
  const card = (sessionId: string, n = 0) => ({ requestId: `r-${sessionId}-${n}`, toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: false, sessionLabel: null, turnId: `t-${sessionId}`, sessionId, cwd: '/w' });
  const sheetProps = (over: Partial<ActivitySheetProps> = {}): ActivitySheetProps => ({
    onClose: () => {}, connected: true, downSince: null, onRetry: () => {}, pending: [], questions: [], onDecide: () => {}, onAnswer: () => {},
    activity: [], tasks: [], paneBg: [], titleOf: (id) => id, onOpen: () => {}, lastWorkAt: null,
    server: { startedAt: null, restartedAt: null, draining: false, update: null, onDismissRestart: () => {} }, now: 0, ...over,
  });
  const cards = (...ids: string[]) => ids.map((id) => card(id)) as unknown as ActivitySheetProps['pending'];

  it('a card answered from the sheet: focus goes to the next card, else the one before, else ✕ — never to the page', () => {
    const { rerender } = render(<ActivitySheet {...sheetProps({ pending: cards('s1', 's2', 's3') })} />);
    const dialog = screen.getByRole('dialog', { name: '활동' });
    const allow = () => within(dialog).getAllByRole('button', { name: '허용 1회' });
    allow()[1]!.focus();
    rerender(<ActivitySheet {...sheetProps({ pending: cards('s1', 's3') })} />);
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).closest('.act-card')!.textContent).toContain('s3');
    // The last one goes: the one before it.
    rerender(<ActivitySheet {...sheetProps({ pending: cards('s1') })} />);
    expect((document.activeElement as HTMLElement).closest('.act-card')!.textContent).toContain('s1');
    // Nothing left: ✕.
    rerender(<ActivitySheet {...sheetProps({ pending: [] })} />);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '닫기' }));
  });

  it('a stopped turn (중단) moves focus to the row now in its place; focus elsewhere is left alone', () => {
    const run = (...ids: string[]) => ids.map((id) => act1({ sessionId: id, turnId: `t-${id}`, running: true }));
    const { rerender } = render(<ActivitySheet {...sheetProps({ activity: run('a', 'b'), onInterrupt: () => {} })} />);
    screen.getByRole('button', { name: 'a 중단' }).focus();
    rerender(<ActivitySheet {...sheetProps({ activity: run('b'), onInterrupt: () => {} })} />);
    expect((document.activeElement as HTMLElement).closest('.act-item')!.textContent).toContain('b');
    // The user moved on to ✕ before the row went: focus stays there.
    const close = screen.getByRole('button', { name: '닫기' });
    close.focus();
    rerender(<ActivitySheet {...sheetProps({ activity: [], onInterrupt: () => {} })} />);
    expect(document.activeElement).toBe(close);
  });

  it('the server uptime moves on every minute while the sheet stays open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10 * M);
    render(<ActivitySheet {...sheetProps({ now: undefined, server: { startedAt: 7 * M, restartedAt: null, draining: false, update: null, onDismissRestart: () => {} } })} />);
    expect(screen.getByTestId('server-uptime').textContent).toBe('서버 · 3분째');
    act(() => { vi.advanceTimersByTime(M); });
    expect(screen.getByTestId('server-uptime').textContent).toBe('서버 · 4분째');
  });

  it('하이라이트 from the sheet: the dot is its opener, so closing it returns focus to the dot', () => {
    const onOpenHighlights = vi.fn(() => { expect(document.activeElement).toBe(screen.getByTestId('activity-btn')); });
    render(<ActivityButton {...base({ highlights: true, serverUpdate: false, onOpenHighlights, fetchFn: (async () => ok(2)) as unknown as typeof fetch })} />);
    const sheet = openSheet();
    fireEvent.click(within(sheet).getByTestId('act-highlights'));
    expect(onOpenHighlights).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(screen.getByTestId('activity-btn'));
  });
});

describe('활동 점 shapes (styles.css)', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
  const rule = (sel: string) => css.match(new RegExp(`^\\s*${sel.replace(/[.*]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';

  it('끊김 is a struck-through hollow ring, not a solid dot (it shares a reddish hue with 실행 중 in the dark theme)', () => {
    const down = rule('.lvl-down .activity-dot');
    expect(down).toMatch(/box-shadow: inset 0 0 0 2px var\(--danger\)/);
    expect(down).toMatch(/linear-gradient\(135deg/);
    expect(down).not.toMatch(/background: var\(--danger\)/);
  });

  it('실행 중 adds a turning arc around the solid dot; reduced motion keeps it as a still ring', () => {
    expect(rule('.lvl-running .activity-dot')).toMatch(/background: var\(--accent\)/);
    expect(rule('.lvl-running::before')).toMatch(/animation: activity-spin/);
    const reduced = css.slice(css.indexOf('@keyframes activity-spin'));
    expect(reduced).toMatch(/prefers-reduced-motion: reduce\) \{[^@]*\.lvl-running::before \{ animation: none;/);
  });
});
