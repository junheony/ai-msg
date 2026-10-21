// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Chat, type ChatProps } from './Chat';

Element.prototype.scrollIntoView = () => {};

const base = (extra: Partial<ChatProps> = {}) => (
  <Chat items={[]} pending={[]} questions={[]} activeTurnId={null} busy={false} title="t" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine={null} sessionSandbox={null} isNew={false} codexAvailable={false} attachments={[]} onSend={() => {}} onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}} onAttach={() => {}} onUnattach={() => {}} {...extra} />
);

describe('composer (one shape: session chip above, + · mic · send below)', () => {
  afterEach(() => { cleanup(); delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition; });

  it('the bottom row is + · mic · send only; the session chip (model · account · permission) sits above the text', () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = vi.fn();
    render(base({ accountPin: null, account: 'a', onAccountPin: () => {}, permMode: 'bypassPermissions', onPermMode: () => {} }));
    const row = document.querySelector<HTMLElement>('.composer-row')!;
    expect(Array.from(row.querySelectorAll('button, select')).map((el) => el.getAttribute('aria-label') ?? el.textContent?.replace('↑', ''))).toEqual(['첨부', '음성 받아쓰기', '보내기']);
    const chip = screen.getByTestId('session-chip');
    expect(chip.closest('.composer-top')).not.toBeNull();
    expect(chip.getAttribute('aria-label')).toBe('세션 설정: Opus 5.5 높음 · 계정: 자동 · A · 자동 승인');
    expect(chip.textContent).toContain('Opus 5.5 높음');
    expect(within(chip).getByTestId('account-picker').getAttribute('aria-label')).toMatch(/^계정: 자동 · /);
    // Tab order: chip, text, +, mic, send.
    const order = [chip, screen.getByRole('textbox', { name: '메시지' }), screen.getByRole('button', { name: '첨부' }), screen.getByRole('button', { name: '음성 받아쓰기' }), screen.getByRole('button', { name: '보내기' })];
    const all = Array.from(document.querySelectorAll<HTMLElement>('.composer button, .composer textarea'));
    const idx = order.map((el) => all.indexOf(el));
    expect(idx.every((n) => n >= 0)).toBe(true);
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    expect(screen.getByRole('button', { name: '보내기' }).className).toBe('send');
    // Model, account and permission are not in the row any more.
    expect(screen.queryByTestId('perm-select')).toBeNull();
    expect(screen.queryByTestId('model-menu')).toBeNull();
  });

  it('the auto-approve control stays reachable: changing it in the chip sheet calls onPermMode', () => {
    const onPermMode = vi.fn();
    render(base({ permMode: 'default', onPermMode }));
    fireEvent.click(screen.getByTestId('session-chip'));
    const sheet = screen.getByRole('dialog', { name: '세션 설정' });
    fireEvent.change(within(sheet).getByTestId('perm-select'), { target: { value: 'bypassPermissions' } });
    expect(onPermMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('no account / permission controls → the chip names the model only; no dictation support → no mic', () => {
    render(base());
    expect(screen.getByTestId('session-chip').getAttribute('aria-label')).toBe('세션 설정: Opus 5.5 높음');
    expect(screen.queryByTestId('account-picker')).toBeNull();
    expect(screen.queryByRole('button', { name: '음성 받아쓰기' })).toBeNull();
  });

  it('while running, the round send becomes a round stop', () => {
    const onInterrupt = vi.fn();
    render(base({ busy: true, activeTurnId: 't1', onInterrupt }));
    const stop = document.querySelector<HTMLButtonElement>('.composer-send .send')!;
    expect(within(stop).getByText('중단')).toBeTruthy();
    expect(stop.className).toBe('send stop');
    fireEvent.click(stop);
    expect(onInterrupt).toHaveBeenCalled();
  });
});
