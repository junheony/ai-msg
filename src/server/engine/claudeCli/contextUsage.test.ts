import { describe, expect, it } from 'vitest';
import { contextUsageRequest, parseContextControl, parseContextPayload } from './contextUsage';
import type { CliMessage } from './messages';

describe('parseContextPayload', () => {
  it('keeps known used rows, by id or by the CLI\'s English name, and drops the rest', () => {
    expect(parseContextPayload({
      categories: [
        { id: 'system_prompt', name: 'System prompt', tokens: 1000, kind: 'used' },
        { name: 'MCP instructions', tokens: 20 },
        { id: 'messages', name: 'Messages', tokens: 500, kind: 'used' },
        { id: 'free_space', name: 'Free space', tokens: 9000, kind: 'free' },
        { id: 'autocompact_buffer', tokens: 400, kind: 'buffer' },
        { id: 'mcp_tools', tokens: 30, kind: 'deferred', isDeferred: true },
        { id: 'mcp_tools_deferred', tokens: 80, kind: 'deferred' },
        { id: 'skills', tokens: 0, kind: 'used' },
        { name: 'Not a category', tokens: 12, kind: 'used' },
      ],
    })).toEqual([
      { id: 'system_prompt', tokens: 1000 },
      { id: 'mcp_instructions', tokens: 20 },
      { id: 'messages', tokens: 500 },
    ]);
  });

  it('sums a repeated id and returns [] for an empty usable list', () => {
    expect(parseContextPayload({ categories: [
      { id: 'skills', tokens: 4, kind: 'used' },
      { name: 'Skills', tokens: 6, kind: 'used' },
    ] })).toEqual([{ id: 'skills', tokens: 10 }]);
    expect(parseContextPayload({ categories: [{ id: 'free_space', tokens: 1, kind: 'free' }] })).toEqual([]);
  });

  it('returns null when there is no categories array', () => {
    expect(parseContextPayload(null)).toBeNull();
    expect(parseContextPayload({ apiUsage: { input_tokens: 1 } })).toBeNull();
    expect(parseContextPayload('nope')).toBeNull();
  });
});

describe('parseContextControl', () => {
  const payload = {
    categories: [{ id: 'system_tools', tokens: 40, kind: 'used' }],
    apiUsage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 },
  };

  it('reads the matching success envelope and ignores a different request', () => {
    const msg = { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: payload } } as CliMessage;
    expect(parseContextControl(msg, 'r1')).toEqual({
      categories: [{ id: 'system_tools', tokens: 40 }],
      api: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 1 },
    });
    expect(parseContextControl(msg, 'other')).toBeNull();
    expect(parseContextControl({ type: 'result', subtype: 'success', session_id: 's' }, 'r1')).toBeNull();
  });

  it('treats an error envelope as an empty answer so the turn can finish', () => {
    const msg = { type: 'control_response', response: { subtype: 'error', request_id: 'r1', error: 'nope' } } as CliMessage;
    expect(parseContextControl(msg, 'r1')).toEqual({ categories: [], api: null });
  });

  it('asks for a summary so the CLI does not spend a token-count request', () => {
    expect(contextUsageRequest('abc')).toEqual({
      type: 'control_request', request_id: 'abc', request: { subtype: 'get_context_usage', detail: 'summary' },
    });
  });
});
