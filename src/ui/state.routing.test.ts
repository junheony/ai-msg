import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import { initialState, reducer, type AppState } from './state';

const play = (msgs: ServerMessage[], start: AppState = initialState): AppState => msgs.reduce((s, m) => reducer(s, { type: 'server', msg: m }), start);

describe('routingPolicy (server setting)', () => {
  it('null until the server says; hello/settings set it; an older server without the field means balance', () => {
    expect(initialState.routingPolicy).toBeNull();
    let s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'drain' } }]);
    expect(s.routingPolicy).toBe('drain');
    s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance' } }], s);
    expect(s.routingPolicy).toBe('balance');
    s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'drain' } }], s);
    s = play([{ type: 'settings', settings: { autoApprove: true, defaultPermissionMode: 'bypassPermissions' } }], s);
    expect(s.routingPolicy).toBe('balance');
  });
});

describe('sameVendorRotation (server setting)', () => {
  it('null until the server says (and for an older server without it); settings set and clear it', () => {
    expect(initialState.sameVendorRotation).toBeNull();
    let s = play([{ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default', sameVendorRotation: false } }]);
    expect(s.sameVendorRotation).toBe(false);
    s = play([{ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default', sameVendorRotation: true } }], s);
    expect(s.sameVendorRotation).toBe(true);
    s = play([{ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default' } }], s);
    expect(s.sameVendorRotation).toBeNull();
  });
});

describe('다른 AI 로 이어가기 (session_handoff)', () => {
  const settings = (crossEngineFailover?: boolean): ServerMessage => ({ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default', autoEngines: ['claude', 'codex'], autoConsent: [], ...(crossEngineFailover === undefined ? {} : { crossEngineFailover }) } });
  it('the setting: on for a server that does not send it, off when it says so', () => {
    expect(play([settings()]).autoRoute?.crossEngineFailover).toBe(true);
    expect(play([settings(false)]).autoRoute?.crossEngineFailover).toBe(false);
  });

  it('the pane showing the session moves to the new one with a notice, keeps its queue, and the old failed result no longer lands in it', () => {
    const p0 = initialState.panes[0]!;
    const start: AppState = { ...initialState, panes: [{ ...p0, session: { sessionId: 'n1', cwd: '/w', account: 'a', title: 'Fix it', engine: 'claude', sandbox: null }, engine: 'claude', myTurns: ['t'], activeTurnId: 't', queue: [{ id: 'q1', text: 'next', attachments: [] }] }] };
    const s = play([
      { type: 'session_handoff', from: 'n1', fromTurnId: 't', cwd: '/w', engine: 'codex', model: 'gpt-6-sol', turnId: 't:x1', prompt: { text: 'hi', attachments: [] }, notice: 'Claude 한도가 차서 GPT 로 이어갑니다' },
      { type: 'turn_result', turnId: 't', sessionId: 'n1', cwd: '/w', ok: false, text: '', badge: null, errorText: 'limit' } as never,
    ], start);
    const p = s.panes[0]!;
    expect(p).toMatchObject({ engine: 'codex', activeTurnId: 't:x1', myTurns: ['t:x1'], queuePaused: false, handoffFrom: { sessionId: 'n1', title: 'Fix it' } });
    expect(p.session).toMatchObject({ sessionId: null, cwd: '/w', engine: 'codex' });
    expect(p.queue.map((q) => q.text)).toEqual(['next']);
    expect(JSON.stringify(p.notices)).toContain('Claude 한도가 차서 GPT 로 이어갑니다');
    expect(JSON.stringify(p.items)).not.toContain('limit');
  });

  it('a pane on another session does not move', () => {
    const p0 = initialState.panes[0]!;
    const start: AppState = { ...initialState, panes: [{ ...p0, session: { sessionId: 'other', cwd: '/w', account: 'a', title: 'x', engine: 'claude', sandbox: null }, engine: 'claude' }] };
    const s = play([{ type: 'session_handoff', from: 'n1', fromTurnId: 't', cwd: '/w', engine: 'codex', model: 'gpt-6-sol', turnId: 't:x1', prompt: { text: 'hi', attachments: [] }, notice: 'n' }], start);
    expect(s).toBe(start);
  });
});

describe('새 채팅 기본 엔진 (newChatEngine)', () => {
  const said = (newChatEngine: 'auto' | 'claude'): ServerMessage => ({ type: 'settings', settings: { autoApprove: false, defaultPermissionMode: 'default', newChatEngine } });
  it('a fresh install keeps 자동 for the first pane and added panes', () => {
    let s = play([said('auto')]);
    expect(s.panes[0]).toMatchObject({ engine: 'auto', model: 'auto' });
    s = reducer(s, { type: 'add_pane' });
    expect(s.panes.at(-1)).toMatchObject({ engine: 'auto', model: 'auto' });
  });

  it('an install from before: the untouched first pane and added panes start on Claude; a restored layout is left as it is', () => {
    let s = play([said('claude')]);
    expect(s.panes[0]!.engine).toBe('claude');
    s = reducer(s, { type: 'add_pane' });
    expect(s.panes.at(-1)!.engine).toBe('claude');
    const restored = play([said('claude')], { ...initialState, panesRestored: true });
    expect(restored.panes[0]!.engine).toBe('auto');
    expect(reducer(restored, { type: 'add_pane' }).panes.at(-1)!.engine).toBe('claude');
  });
});
