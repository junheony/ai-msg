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

  it('accepts engine/sandbox/attachments/codex models on send, question_response and close_session', () => {
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', engine: 'auto', sandbox: 'workspace-write', model: 'gpt-6-astra', attachments: ['11111111-1111-4111-8111-111111111111'] }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'question_response', requestId: 'q1', answers: { 'Which color?': 'blue' } }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'close_session', sessionId: 's' }).success).toBe(true);
  });

  it('rejects luna, gpt-5.6-sol, bad attachment ids, more than 8 attachments, unknown engines', () => {
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', model: 'gpt-5.6-luna' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', model: 'gpt-5.6-sol' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', attachments: ['../etc/passwd'] }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', attachments: Array(9).fill('11111111-1111-4111-8111-111111111111') }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'send', sessionId: null, cwd: '/w', text: 'hi', engine: 'gemini' }).success).toBe(false);
  });
});
