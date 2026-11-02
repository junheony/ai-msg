// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HubView } from '../HubView';
import { hubStatusFixture } from '../__fixtures__/status';
import type { HubFeed } from '../useHubStatus';
import { createCtlApi, type CtlApi } from './api';
import type { ApprovalItem, ControlsState, RunItem } from './types';

vi.mock('../lab/LabPanel', () => ({ LabPanel: () => <section data-testid="lab-panel" /> }));
vi.mock('../sr/SrPanel', async () => ({ ...(await vi.importActual<typeof import('../sr/SrPanel')>('../sr/SrPanel')), SrPanel: () => <section data-testid="sr-panel" /> }));
vi.mock('../lab/api', () => ({ liveLabApi: { summary: async () => { throw new Error('offline'); } } }));
vi.mock('../sr/api', () => ({ liveSrApi: { sr: async () => { throw new Error('offline'); }, klines: async () => [] } }));

const T = Date.parse('2026-11-02T03:00:00Z');
const feed: HubFeed = { status: hubStatusFixture(T), error: null, fetchedAt: T, loading: false, refresh: () => {} };
const LOCK = 'QUANT/해당 채팅에서만 승인';

const appr = (o: Partial<ApprovalItem>): ApprovalItem => ({ id: 'a1', from: 'shorts-bot', mode: 'video', kind: 'generic', title: 'Upload ep 5', detail: '', links: [], createdAt: '2026-11-02T02:50:00Z', locked: null, hook: false, ...o });
const run = (o: Partial<RunItem>): RunItem => ({ id: 'jobs:20261102-x', root: 'jobs', name: '20261102-x', path: '~/jobs/20261102-x', title: 'Polish copy', mode: 'msg', engine: 'claude', account: 'b', launchedByMsg: true, pids: [{ pid: 4242, alive: true, source: 'msg', file: 'msg-job.json', stoppable: true, why: null }], alive: true, startedAt: '2026-11-02T02:30:00Z', endedAt: null, elapsedMs: 1_800_000, status: null, statusKind: 'none', limitHit: false, hasReport: false, hasLog: true, locked: null, cwd: '~/ai-msg', updatedAt: '2026-11-02T02:59:00Z', ...o });

function state(o: Partial<ControlsState> = {}): ControlsState {
  const modes = Object.fromEntries(['msg', 'nexus', 'trading', 'video', 'game', 'ops', 'updown', 'quant', 'yapping'].map((m) => [m, { locked: m === 'trading' || m === 'quant', cwd: m === 'msg' ? '~/ai-msg' : m === 'video' ? '~/engineering-shorts' : null, bot: m === 'video' ? 'shorts' : null, pending: 0 }]));
  return {
    csrf: 'c'.repeat(64), home: '/home/u', lockedLabel: LOCK, lockedModes: ['trading', 'quant'], bots: ['msg', 'shorts'], suggested: 'claude', modes,
    engines: [
      { id: 'claude', label: 'Claude', available: true, limitedUntil: null, reason: null, quota: 'anthropic', detail: 'claude-pick' },
      { id: 'codex', label: 'Codex', available: false, limitedUntil: '2026-11-04T06:41:00.000Z', reason: '사용 한도 · 2026-11-04 15:41 KST 해제', quota: 'openai', detail: 'codex exec' },
      { id: 'hermes', label: 'Hermes', available: false, limitedUntil: '2026-11-04T06:41:00.000Z', reason: '사용 한도 · 2026-11-04 15:41 KST 해제', quota: 'openai', detail: 'hermes -z' },
    ],
    approvals: {
      pending: [
        appr({ id: 'a1' }),
        appr({ id: 'pr1', kind: 'pr-merge', mode: 'msg', title: 'Merge feat/hub-controls', pr: { url: 'https://github.com/x/y/pull/9', base: 'main', head: 'feat/hub-controls', files: 12, additions: 840, deletions: 30 } }),
        appr({ id: 'tr1', mode: 'trading', title: 'Enable maker on SR', locked: 'mode trading', lockedLabel: LOCK }),
      ],
      decided: [],
    },
    ...o,
  };
}

function fakeApi(s = state(), runs: RunItem[] = [run({})]) {
  const calls: string[] = [];
  const api: CtlApi = {
    state: vi.fn(async () => s),
    runs: vi.fn(async () => runs),
    read: vi.fn(async (_id: string, what: string) => ({ text: what === 'report' ? '# 보고\n\nSTATUS: DONE' : 'line1\nline2' })),
    decide: vi.fn(async (id: string, d: string) => { calls.push(`decide ${id} ${d}`); }),
    launch: vi.fn(async (b) => { calls.push(`launch ${b.mode} ${b.engine}`); return { run: run({ id: 'jobs:new' }), jobDir: '~/jobs/20261102-new' }; }),
    task: vi.fn(async (b) => { calls.push(`task ${b.bot}`); return { id: 't', file: `~/.msg/tasks/${b.bot}/t.json` }; }),
    stop: vi.fn(async (id: string, pid: number) => { calls.push(`stop ${id} ${pid}`); }),
    rerun: vi.fn(async (id: string, e) => { calls.push(`rerun ${id} ${e}`); return { run: run({}), jobDir: '~/jobs/r' }; }),
  };
  return { api, calls };
}

const view = (api: CtlApi, mode: Parameters<typeof HubView>[0]['mode'] = 'home', onOpenTerminal?: (c: string) => void) =>
  render(<HubView mode={mode} onChangeMode={() => {}} feed={feed} pushOn={false} controls={api} {...(onOpenTerminal ? { onOpenTerminal } : {})} />);

afterEach(cleanup);

describe('hub controls on the 개요', () => {
  it('cards get 다음 작업 and the 승인 badge; Trading and QUANT get the lock line and no buttons', async () => {
    const { api } = fakeApi();
    view(api, 'home', () => {});
    await screen.findByTestId('ctl-acts-video');
    const video = within(screen.getByTestId('ctl-acts-video'));
    expect(video.getByRole('button', { name: '다음 작업' })).toBeTruthy();
    expect(video.getByRole('button', { name: '터미널' })).toBeTruthy();
    expect(video.getByRole('button', { name: '승인 대기 1건' })).toBeTruthy();
    for (const m of ['trading', 'quant']) {
      expect(screen.queryByTestId(`ctl-acts-${m}`)).toBeNull();
      expect(screen.getByTestId(`ctl-locked-${m}`).textContent).toBe(LOCK);
    }
    const tradingCard = document.querySelector('.card[data-mode="trading"]')!;
    expect(within(tradingCard as HTMLElement).queryByRole('button', { name: '다음 작업' })).toBeNull();
  });

  it('a trading request is read-only: lock band, no approve or reject', async () => {
    const { api } = fakeApi();
    view(api);
    const slip = await screen.findByTestId('approval-tr1');
    expect(within(slip).getByTestId('approval-locked').textContent).toContain(LOCK);
    expect(within(slip).queryByRole('button', { name: '승인' })).toBeNull();
    expect(within(slip).queryByRole('button', { name: '거절' })).toBeNull();
  });

  it('shows a PR request with its diff stat and the record-only note', async () => {
    const { api } = fakeApi();
    view(api);
    const slip = await screen.findByTestId('approval-pr1');
    expect(slip.textContent).toContain('main ← feat/hub-controls');
    expect(slip.textContent).toContain('+840');
    expect(slip.textContent).toContain('실행 훅 없음');
    expect(within(slip).getByRole('link', { name: /PR 열기/ }).getAttribute('href')).toBe('https://github.com/x/y/pull/9');
  });

  it('approve goes through the confirm dialog before anything is sent', async () => {
    const { api, calls } = fakeApi();
    view(api);
    const slip = await screen.findByTestId('approval-a1');
    fireEvent.change(within(slip).getByRole('textbox'), { target: { value: 'ok' } });
    fireEvent.click(within(slip).getByRole('button', { name: '승인' }));
    expect(calls).toEqual([]);
    const dlg = screen.getByRole('alertdialog');
    fireEvent.click(within(dlg).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls).toEqual([]);
    fireEvent.click(within(slip).getByRole('button', { name: '승인' }));
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '승인' })); });
    expect(calls).toEqual(['decide a1 approve']);
    expect(api.decide).toHaveBeenCalledWith('a1', 'approve', 'ok');
  });

  it('a refusal stays in the dialog in the server\'s words', async () => {
    const { api } = fakeApi();
    (api.decide as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(`${LOCK} · mode trading`));
    view(api);
    const slip = await screen.findByTestId('approval-a1');
    fireEvent.click(within(slip).getByRole('button', { name: '거절' }));
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '거절' })); });
    expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toContain(LOCK);
  });
});

describe('다음 작업 composer', () => {
  it('greys out Codex and Hermes with the reset, launches only after the confirm step', async () => {
    const { api, calls } = fakeApi();
    view(api);
    await screen.findByTestId('ctl-acts-video');
    fireEvent.click(within(screen.getByTestId('ctl-acts-video')).getByRole('button', { name: '다음 작업' }));
    const dlg = screen.getByTestId('composer');
    expect((within(dlg).getByTestId('engine-codex').querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect((within(dlg).getByTestId('engine-hermes').querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect(within(dlg).getByTestId('engine-codex').textContent).toContain('해제');
    expect((within(dlg).getByTestId('engine-claude').querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect((within(dlg).getByPlaceholderText(/비우면/) as HTMLInputElement).value).toBe('~/engineering-shorts');
    const next = within(dlg).getByRole('button', { name: '다음' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.change(within(dlg).getByPlaceholderText(/무엇을/), { target: { value: 'Render ep 5 thumbnails' } });
    fireEvent.click(next);
    expect(calls).toEqual([]);
    const confirm = within(dlg).getByTestId('composer-confirm');
    expect(confirm.textContent).toContain('Claude');
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '실행' })); });
    expect(calls).toEqual(['launch video claude']);
    expect(dlg.textContent).toContain('~/jobs/20261102-new');
  });

  it('봇에게 files into the queue', async () => {
    const { api, calls } = fakeApi();
    view(api);
    await screen.findByTestId('ctl-acts-video');
    fireEvent.click(within(screen.getByTestId('ctl-acts-video')).getByRole('button', { name: '다음 작업' }));
    const dlg = screen.getByTestId('composer');
    fireEvent.click(within(dlg).getByRole('tab', { name: '봇에게' }));
    fireEvent.change(within(dlg).getByPlaceholderText(/봇이/), { target: { value: 'Three hooks for ep 5' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '다음' }));
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '큐에 넣기' })); });
    expect(calls).toEqual(['task shorts']);
  });
});

describe('실행 관리', () => {
  it('lists engine, account, elapsed and status; stop needs a confirm and sends the PID', async () => {
    const { api, calls } = fakeApi(state(), [run({}), run({ id: 'jobs:old', title: 'Old job', alive: false, pids: [], status: 'BLOCKED: limit', statusKind: 'blocked', limitHit: true, hasReport: true, engine: 'codex', account: 'codex' })]);
    view(api);
    const row = await screen.findByTestId('run-jobs:20261102-x');
    expect(row.textContent).toContain('Claude b');
    const old = screen.getByTestId('run-jobs:old');
    expect(old.textContent).toContain('BLOCKED: limit');
    expect(old.textContent).toContain('한도 도달');
    expect(within(old).queryByRole('button', { name: /중지/ })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: '중지' }));
    expect(calls).toEqual([]);
    expect(screen.getByRole('alertdialog').textContent).toContain('SIGTERM');
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'SIGTERM 보내기' })); });
    expect(calls).toEqual(['stop jobs:20261102-x 4242']);
  });

  it('opens the REPORT rendered and reruns with a picked engine after a confirm', async () => {
    const { api, calls } = fakeApi(state(), [run({ id: 'jobs:old', alive: false, pids: [], hasReport: true, engine: 'codex' })]);
    view(api);
    const row = await screen.findByTestId('run-jobs:old');
    fireEvent.click(within(row).getByRole('button', { name: '보고서' }));
    const v = await screen.findByTestId('viewer-report');
    await waitFor(() => expect(v.querySelector('h1')?.textContent).toBe('보고'));
    fireEvent.click(within(v).getByRole('button', { name: '닫기' }));
    fireEvent.click(within(row).getByRole('button', { name: '다시 실행' }));
    const dlg = screen.getByRole('alertdialog');
    // the job's own engine (codex) is limited, so Claude is preselected
    expect((within(dlg).getByTestId('engine-claude').querySelector('input') as HTMLInputElement).checked).toBe(true);
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '다시 실행' })); });
    expect(calls).toEqual(['rerun jobs:old claude']);
  });

  it('a locked run has no stop, rerun or terminal', async () => {
    const { api } = fakeApi(state(), [run({ id: 'jobs:nexus-engine-x', locked: 'nexus-engine', alive: true })]);
    view(api, 'home', () => {});
    const row = await screen.findByTestId('run-jobs:nexus-engine-x');
    expect(within(row).queryByRole('button', { name: /중지|다시 실행|터미널/ })).toBeNull();
    expect(row.textContent).toContain(LOCK);
  });

  it('터미널 opens the folder as an absolute path', async () => {
    const { api } = fakeApi();
    const open = vi.fn();
    view(api, 'home', open);
    await screen.findByTestId('ctl-acts-video');
    fireEvent.click(within(screen.getByTestId('ctl-acts-video')).getByRole('button', { name: '터미널' }));
    expect(open).toHaveBeenCalledWith('/home/u/engineering-shorts');
  });
});

describe('mode pages', () => {
  it('the Trading room keeps no controls at all', async () => {
    const { api } = fakeApi();
    view(api, 'trading');
    await waitFor(() => expect(api.state).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: '다음 작업' })).toBeNull();
    expect(screen.queryByTestId('approval-inbox')).toBeNull();
    expect(screen.queryByTestId('runs-panel')).toBeNull();
    expect(document.body.textContent).toContain('읽기 전용 · 제어 없음');
  });

  it('QUANT shows its requests read-only and offers nothing to run', async () => {
    const s = state();
    s.approvals.pending.push(appr({ id: 'q1', mode: 'quant', title: 'Rebalance', locked: 'mode quant', lockedLabel: LOCK }));
    const { api } = fakeApi(s);
    view(api, 'quant');
    const slip = await screen.findByTestId('approval-q1');
    expect(within(slip).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: '다음 작업' })).toBeNull();
    expect(screen.getByTestId('ctl-locked-quant')).toBeTruthy();
  });

  it('a normal mode page has 다음 작업 in its head and its own requests', async () => {
    const { api } = fakeApi();
    view(api, 'video', () => {});
    const head = await screen.findByTestId('ctl-acts-video');
    expect(head.closest('header')).not.toBeNull();
    expect(await screen.findByTestId('approval-a1')).toBeTruthy();
    expect(screen.queryByTestId('approval-pr1')).toBeNull();
  });
});

describe('client', () => {
  it('sends CSRF + confirm + JSON on writes', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(url.endsWith('state') ? state() : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const api = createCtlApi(f);
    await api.decide('a1', 'approve', '');
    const post = seen.find((s) => s.init?.method === 'POST')!;
    const h = post.init!.headers as Record<string, string>;
    expect(post.url).toBe('/api/hub/ctl/approvals/a1/decide');
    expect(h['x-msg-csrf']).toBe('c'.repeat(64));
    expect(h['x-msg-confirm']).toBe('yes');
    expect(h['content-type']).toBe('application/json');
  });
});
