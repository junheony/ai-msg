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
    [{ type: 'send', text: 'hi', sandbox: 'workspace-write' }, 'mac_confirm_required'],
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
});
