import { describe, expect, it } from 'vitest';
import { relayPathPolicy } from './pathPolicy';

describe('relayPathPolicy', () => {
  it.each([
    ['GET', '/api/me', 'allow'], ['POST', '/api/push/subscribe', 'allow'], ['GET', '/api/cloud/status', 'allow'],
    ['GET', '/api/server-update', 'allow'],
    ['POST', '/api/restart', 'mac_confirm_required'], ['POST', '/api/server-update/apply', 'mac_confirm_required'],
    ['GET', '/api/setup', 'mac_confirm_required'], ['POST', '/api/setup/finish', 'mac_confirm_required'],
    ['POST', '/api/login', 'mac_confirm_required'], ['POST', '/api/logout', 'mac_confirm_required'],
    ['POST', '/api/cloud/unlink', 'mac_confirm_required'], ['POST', '/api/cloud/pair/start', 'mac_confirm_required'],
    ['POST', '/api/cloud/devices/d1/revoke', 'mac_confirm_required'],
    ['POST', '/api/cloud/plan/refresh', 'mac_confirm_required'], ['GET', '/api/cloud/plan/refresh', 'mac_confirm_required'],
    ['GET', '/api/../etc', 'deny'], ['GET', '/api/%2E%2E/x', 'deny'], ['GET', '/api\\..\\x', 'deny'],
    ['GET', '//evil.test/api/me', 'deny'], ['GET', '/index.html', 'deny'],
  ])('%s %s → %s', (m, p, want) => expect(relayPathPolicy(m, p)).toBe(want));

  it.each([
    // Decoded and normalised must equal the original: an encoded letter cannot slip past a rule.
    ['POST', '/api/%72estart', 'deny'], ['GET', '/api/m%65', 'deny'],
    ['GET', '/api/cloud%2Fstatus', 'deny'],
    ['POST', '/api/restart/', 'mac_confirm_required'],
    ['POST', '/api/restart?x=1', 'mac_confirm_required'],
    ['GET', '/api/cloud/status?x=1', 'allow'],
    ['POST', '/api/cloud/status', 'mac_confirm_required'],
    ['GET', '/api/cloud', 'mac_confirm_required'],
    ['GET', '/api/me?next=/../x', 'allow'],
    ['GET', '/api/a//b', 'deny'], ['GET', '/api/./me', 'deny'], ['GET', '/api/a%2F%2Fb', 'deny'],
    ['GET', '/api/%252e%252e/x', 'deny'], ['GET', '/api/%zz', 'deny'], ['GET', '/api/a%5Cb', 'deny'],
    ['GET', 'https://evil.test/api/me', 'deny'], ['GET', 'api/me', 'deny'], ['GET', '', 'deny'], ['GET', '/api', 'deny'],
  ])('%s %s → %s (normalised)', (m, p, want) => expect(relayPathPolicy(m, p)).toBe(want));

  it.each([
    ['GET', '/api/memory', 'allow'],
    ['PUT', '/api/memory', 'mac_confirm_required'],
    ['POST', '/api/memory', 'mac_confirm_required'],
    ['DELETE', '/api/memory/x', 'mac_confirm_required'],
    ['GET', '/api/memory?x=1', 'allow'],
  ])('memory (an instruction every session gets): %s %s → %s', (m, p, want) => expect(relayPathPolicy(m, p)).toBe(want));
});
