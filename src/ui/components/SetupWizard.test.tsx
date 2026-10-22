// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SetupStatus } from '../../shared/setup-types';
import { SETUP_TEXTS } from '../setupTexts';

const api = vi.hoisted(() => ({ markSetupDone: vi.fn(async () => {}), refreshSetup: vi.fn(), restartServer: vi.fn(async () => ({ ok: true })) }));
vi.mock('../setupApi', async (orig) => ({ ...(await orig<typeof import('../setupApi')>()), ...api }));

import { SetupWizard } from './SetupWizard';
import { RESTART_WAIT_WARNING, restartConfirmText } from './ActivitySheet';

const sample: SetupStatus = {
  engines: [
    { engine: 'claude', bin: '/usr/local/bin/claude', version: '2.1.0', login: 'no', loginCommand: 'claude auth login' },
    { engine: 'codex', bin: '/usr/local/bin/codex', version: '0.50.0', login: 'yes', loginCommand: 'codex login' },
    { engine: 'gemini', bin: null, version: null, login: 'unknown', loginCommand: 'agy', note: 'agy 를 찾지 못했습니다 — 설치 후 PATH 에 두거나 DECK_GEMINI_BIN 으로 지정하세요' },
    { engine: 'grok', bin: '/home/u/.grok/bin/grok', version: '1.0.0', login: 'unknown', loginCommand: 'grok login' },
  ],
  claudeProfiles: [
    { id: 'a', label: 'A', dir: '~/.claude', home: true, active: true, login: 'yes', loginCommand: 'claude auth login' },
    { id: 'b', label: 'B', dir: '~/.claude-b', home: false, active: true, login: 'no', loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-b claude auth login' },
  ],
  addresses: ['http://127.0.0.1:9320/', 'https://mac.tail.ts.net/'],
  needed: true,
  supervised: false,
  restartNeeded: false,
  accountsFile: false,
  checkedAt: '2026-10-21T01:02:03.000Z',
};

beforeEach(() => { api.markSetupDone.mockClear(); api.refreshSetup.mockReset(); api.restartServer.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('SetupWizard', () => {
  it('shows four engines with their state and the login command for a logged-out one', async () => {
    render(<SetupWizard load={async () => sample} onDone={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('Claude')).toBeTruthy();
    expect(screen.getByText('GPT (Codex)')).toBeTruthy();
    expect(screen.getByText('Gemini')).toBeTruthy();
    expect(screen.getByText('Grok')).toBeTruthy();
    expect(screen.getByText('claude auth login')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /복사/ }).length).toBeGreaterThan(0);
    // Logged in / could not tell: no command (unknown is never shown as logged out).
    expect(screen.queryByText('codex login')).toBeNull();
    expect(screen.queryByText('grok login')).toBeNull();
    expect(screen.getAllByText('로그인됨').length).toBeGreaterThan(0);
  });

  it('a missing CLI shows the install note, no login command', async () => {
    render(<SetupWizard load={async () => sample} onDone={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/agy 를 찾지 못했습니다/)).toBeTruthy();
    expect(screen.getByText(SETUP_TEXTS.notInstalled)).toBeTruthy();
    expect(screen.queryByText('agy')).toBeNull();
  });

  it('lists the Claude profiles with the login command of a logged-out one', async () => {
    render(<SetupWizard load={async () => sample} onDone={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('CLAUDE_CONFIG_DIR=~/.claude-b claude auth login')).toBeTruthy();
    expect(screen.getByText('~/.claude-b')).toBeTruthy();
  });

  it('without accounts.json the add form warns that auto-discovery ends', async () => {
    render(<SetupWizard load={async () => sample} onDone={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(SETUP_TEXTS.fixNotice)).toBeTruthy();
    cleanup();
    render(<SetupWizard load={async () => ({ ...sample, accountsFile: true })} onDone={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('Claude');
    expect(screen.queryByText(SETUP_TEXTS.fixNotice)).toBeNull();
  });

  it('adding a profile posts the id and shows the restart notice; supervised shows 지금 재시작', async () => {
    const onAddProfile = vi.fn(async () => ({ ok: true as const, restartNeeded: true as const }));
    const onRestart = vi.fn();
    render(<SetupWizard load={async () => ({ ...sample, supervised: true })} onAddProfile={onAddProfile} onRestart={onRestart} onDone={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(SETUP_TEXTS.addId), { target: { value: 'd' } });
    fireEvent.change(screen.getByLabelText(SETUP_TEXTS.addLabel), { target: { value: 'Side' } });
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.add }));
    expect(await screen.findByText(SETUP_TEXTS.restartNotice)).toBeTruthy();
    expect(onAddProfile).toHaveBeenCalledWith('d', 'Side');
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.restartNow }));
    expect(onRestart).not.toHaveBeenCalled(); // a confirm first
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.restartConfirm }));
    expect(onRestart).toHaveBeenCalled();
    expect(screen.queryByText(SETUP_TEXTS.restartManual)).toBeNull();
  });

  it('지금 재시작 asks first, saying what the drain waits for; 취소 sends nothing, 재시작 posts', async () => {
    const onAddProfile = vi.fn(async () => ({ ok: true as const, restartNeeded: true as const }));
    const activity = [{ sessionId: 's1', cwd: '/w', turnId: 't1', running: true, bg: 1, forMs: 1000 }];
    render(<SetupWizard load={async () => ({ ...sample, supervised: true, restartNeeded: true })} onAddProfile={onAddProfile} activity={activity} onDone={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: SETUP_TEXTS.restartNow }));
    expect(screen.getByText(restartConfirmText(activity))).toBeTruthy();
    expect(screen.getByText('진행 중 작업 2개가 끝나면 재시작합니다')).toBeTruthy();
    expect(screen.getByText(RESTART_WAIT_WARNING)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.restartCancel }));
    expect(api.restartServer).not.toHaveBeenCalled();
    expect(screen.queryByText(RESTART_WAIT_WARNING)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.restartNow }));
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.restartConfirm }));
    await waitFor(() => expect(api.restartServer).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(SETUP_TEXTS.restarting)).toBeTruthy();
  });

  it('not supervised: the notice says to run ai-msg again, no restart button', async () => {
    const onAddProfile = vi.fn(async () => ({ ok: true as const, restartNeeded: true as const }));
    render(<SetupWizard load={async () => sample} onAddProfile={onAddProfile} onDone={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(SETUP_TEXTS.addId), { target: { value: 'd' } });
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.add }));
    expect(await screen.findByText(SETUP_TEXTS.restartManual)).toBeTruthy();
    expect(onAddProfile).toHaveBeenCalledWith('d', undefined);
    expect(screen.queryByRole('button', { name: SETUP_TEXTS.restartNow })).toBeNull();
  });

  it('a server error on add is shown as is', async () => {
    const onAddProfile = vi.fn(async () => ({ ok: false as const, error: '이미 있는 계정입니다: b' }));
    render(<SetupWizard load={async () => sample} onAddProfile={onAddProfile} onDone={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(SETUP_TEXTS.addId), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.add }));
    expect(await screen.findByText('이미 있는 계정입니다: b')).toBeTruthy();
    expect(screen.queryByText(SETUP_TEXTS.restartNotice)).toBeNull();
  });

  it('a pending restart from an earlier add is shown on open', async () => {
    render(<SetupWizard load={async () => ({ ...sample, restartNeeded: true })} onDone={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(SETUP_TEXTS.restartNotice)).toBeTruthy();
  });

  it('shows the access addresses and the pairing line', async () => {
    render(<SetupWizard load={async () => sample} onDone={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('https://mac.tail.ts.net/')).toBeTruthy();
    expect(screen.getByText(SETUP_TEXTS.pairingLater)).toBeTruthy();
  });

  it('다시 확인 forces a fresh probe', async () => {
    api.refreshSetup.mockResolvedValue({ ...sample, engines: sample.engines.map((e) => (e.engine === 'claude' ? { ...e, login: 'yes' as const } : e)) });
    render(<SetupWizard load={async () => sample} onDone={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('claude auth login')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.recheck }));
    await waitFor(() => expect(screen.queryByText('claude auth login')).toBeNull());
    expect(api.refreshSetup).toHaveBeenCalledTimes(1);
  });

  it('완료 calls markSetupDone then onDone', async () => {
    const onDone = vi.fn();
    render(<SetupWizard load={async () => sample} onDone={onDone} onClose={vi.fn()} />);
    await screen.findByText('Claude');
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.done }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.markSetupDone).toHaveBeenCalledTimes(1);
    expect(api.markSetupDone.mock.invocationCallOrder[0]!).toBeLessThan(onDone.mock.invocationCallOrder[0]!);
  });

  it('a failed 완료 stays open with the error', async () => {
    api.markSetupDone.mockRejectedValueOnce(new Error('x'));
    const onDone = vi.fn();
    render(<SetupWizard load={async () => sample} onDone={onDone} onClose={vi.fn()} />);
    await screen.findByText('Claude');
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXTS.done }));
    expect(await screen.findByText(SETUP_TEXTS.doneFailed)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('the ✕ closes without marking done', async () => {
    const onClose = vi.fn();
    render(<SetupWizard load={async () => sample} onDone={vi.fn()} onClose={onClose} />);
    await screen.findByText('Claude');
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.markSetupDone).not.toHaveBeenCalled();
  });

  it('polls while open and stops after close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const load = vi.fn(async () => sample);
    const { unmount } = render(<SetupWizard load={load} pollMs={1000} onDone={vi.fn()} onClose={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(load).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(3);
  });
});
