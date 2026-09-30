import { describe, expect, it } from 'vitest';
import { COOLDOWN_MS, classifyFailure } from './limitDetect';

describe('classifyFailure', () => {
  it('returns null for a successful turn even if a warning was seen', () => {
    expect(classifyFailure({ ok: true, errorText: null, errorKind: null, rateLimitStatus: 'allowed_warning' })).toBeNull();
  });

  it('detects limits by SDK error kind, by rejected rate-limit status, and by text patterns', () => {
    expect(classifyFailure({ ok: false, errorText: 'x', errorKind: 'rate_limit', rateLimitStatus: null })).toBe('limit');
    expect(classifyFailure({ ok: false, errorText: 'x', errorKind: null, rateLimitStatus: 'rejected' })).toBe('limit');
    expect(classifyFailure({ ok: false, errorText: "You've hit your usage limit. Resets at 3pm", errorKind: null, rateLimitStatus: null })).toBe('limit');
    expect(classifyFailure({ ok: false, errorText: 'API Error: 429 rate limit reached', errorKind: null, rateLimitStatus: null })).toBe('limit');
    expect(classifyFailure({ ok: false, errorText: 'Claude usage limit reached', errorKind: null, rateLimitStatus: null })).toBe('limit');
  });

  it('detects auth failures (the real 401 text from account a)', () => {
    expect(classifyFailure({ ok: false, errorText: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', errorKind: null, rateLimitStatus: null })).toBe('auth');
    expect(classifyFailure({ ok: false, errorText: 'x', errorKind: 'authentication_failed', rateLimitStatus: null })).toBe('auth');
  });

  it('everything else is other', () => {
    expect(classifyFailure({ ok: false, errorText: 'error_max_turns', errorKind: null, rateLimitStatus: 'allowed' })).toBe('other');
    expect(classifyFailure({ ok: false, errorText: null, errorKind: null, rateLimitStatus: null })).toBe('other');
  });

  it('cooldowns: limit 1h, auth 6h, other none', () => {
    expect(COOLDOWN_MS).toEqual({ limit: 3_600_000, auth: 21_600_000, other: 0 });
  });
});
