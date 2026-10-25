import { describe, expect, it } from 'vitest';
import { relayWsPolicy } from './wsPolicy';

describe('relayWsPolicy', () => {
  it.each([
    [{ type: 'set_permission_mode', sessionId: 's', mode: 'bypassPermissions' }, 'mac_confirm_required'],
    [{ type: 'set_permission_mode', sessionId: 's', mode: 'acceptEdits' }, 'mac_confirm_required'],
    [{ type: 'set_permission_mode', sessionId: 's', mode: 'plan' }, 'allow'],
    [{ type: 'set_settings', autoApprove: true }, 'mac_confirm_required'],
    [{ type: 'set_settings', autoApprove: false }, 'allow'],
    [{ type: 'set_settings', defaultPermissionMode: 'acceptEdits' }, 'mac_confirm_required'],
    [{ type: 'set_settings', commanderEnabled: true }, 'mac_confirm_required'],
    [{ type: 'set_settings', routingPolicy: 'drain' }, 'allow'],
    [{ type: 'send', text: 'hi', permissionMode: 'bypassPermissions' }, 'mac_confirm_required'],
    [{ type: 'send', sessionId: 's', text: 'hi', sandbox: 'workspace-write' }, 'mac_confirm_required'],
    [{ type: 'send', sessionId: null, text: 'hi', sandbox: 'workspace-write' }, 'allow'],
    [{ type: 'send', text: 'hi' }, 'allow'],
    [{ type: 'set_sandbox', sessionId: 's', sandbox: 'workspace-write' }, 'mac_confirm_required'],
    [{ type: 'set_sandbox', sessionId: 's', sandbox: 'read-only' }, 'allow'],
    [{ type: 'permission_response', requestId: 'r', behavior: 'allow' }, 'allow'],
    ['not json', 'allow'],
  ])('%j → %s', (msg, want) => expect(relayWsPolicy(msg)).toBe(want));

  it.each([
    ['{"type":"set_settings","autoApprove":true}', 'mac_confirm_required'],
    ['{"type":"send","text":"hi","sandbox":"read-only","permissionMode":"plan"}', 'allow'],
    [{ type: 'set_settings', defaultPermissionMode: 'bypassPermissions', autoApprove: false }, 'mac_confirm_required'],
    [{ type: 'set_settings', commanderEnabled: false, defaultPermissionMode: 'default' }, 'allow'],
    [null, 'allow'], [[{ type: 'set_settings', autoApprove: true }], 'allow'], [42, 'allow'],
  ])('%j → %s (raw text and odd shapes)', (msg, want) => expect(relayWsPolicy(msg)).toBe(want));

  it('a new session at the Mac default sandbox is allowed; raising an existing session is not', () => {
    expect(relayWsPolicy({ type: 'send', sessionId: null, text: 'hi', sandbox: 'workspace-write' })).toBe('allow');
    expect(relayWsPolicy({ type: 'send', sessionId: 's', text: 'hi', sandbox: 'workspace-write' })).toBe('mac_confirm_required');
    expect(relayWsPolicy({ type: 'send', text: 'hi', sandbox: 'workspace-write' })).toBe('mac_confirm_required'); // no sessionId: not a new session
  });

  it('a new session without sandbox, and start_task, use the Mac defaults: allowed', () => {
    expect(relayWsPolicy({ type: 'send', sessionId: null, text: 'hi' })).toBe('allow');
    expect(relayWsPolicy({ type: 'start_task', cwd: '/x', text: 'hi', fromSessionId: null })).toBe('allow');
  });

  it('grok_unlock needs the Mac', () => {
    expect(relayWsPolicy({ type: 'grok_unlock' })).toBe('mac_confirm_required');
  });

  it.each([
    [{ type: 'set_settings', experimental: { grokBot: true } }, 'mac_confirm_required'],
    [{ type: 'set_settings', experimental: { desktop: false, localImports: true } }, 'mac_confirm_required'],
    [{ type: 'set_settings', experimental: { desktop: false } }, 'allow'],
    [{ type: 'set_settings', experimental: {} }, 'allow'],
  ])('experimental: turning anything on needs the Mac — %j → %s', (msg, want) => expect(relayWsPolicy(msg)).toBe(want));

  it.each([
    [[], ['gemini'], 'mac_confirm_required'],
    [['gemini'], ['gemini', 'grok'], 'mac_confirm_required'],
    [['gemini', 'grok'], ['gemini'], 'allow'],
    [['gemini'], ['gemini'], 'allow'],
    [['gemini'], [], 'allow'],
  ])('autoConsent %j → %j: widening needs the Mac (%s)', (current, next, want) => {
    expect(relayWsPolicy({ type: 'set_settings', autoConsent: next }, { autoConsent: current })).toBe(want);
  });

  it('autoConsent with the current value unknown: any consent needs the Mac, none is fine', () => {
    expect(relayWsPolicy({ type: 'set_settings', autoConsent: ['grok'] })).toBe('mac_confirm_required');
    expect(relayWsPolicy({ type: 'set_settings', autoConsent: [] })).toBe('allow');
  });
});
