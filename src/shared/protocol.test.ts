import { describe, expect, it } from 'vitest';
import { ClientMessageSchema } from './protocol';

describe('ClientMessageSchema', () => {
  it('accepts valid messages', () => {
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: 'x', cwd: '/w', text: 'hi', model: 'fable' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'permission_response', requestId: 'r', decision: 'session' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'interrupt', turnId: 't' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'open_session', sessionId: 's' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'refresh_index' }).success).toBe(true);
  });

  it('rejects unknown types, haiku, empty text, and non-objects', () => {
    expect(ClientMessageSchema.safeParse({ type: 'exec', cmd: 'rm' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', model: 'haiku' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: '' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse('send').success).toBe(false);
  });
});
