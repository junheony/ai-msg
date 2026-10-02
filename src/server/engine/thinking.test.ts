import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseTranscript } from '../sessions/transcript';
import { mapSdkMessage } from './ClaudeEngine';

const ev = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: null, event }) as unknown as SDKMessage;
const L = (o: unknown) => JSON.stringify(o);

describe('thinking: stream', () => {
  it('maps thinking block start / deltas / redacted blocks', () => {
    expect(mapSdkMessage(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }))).toEqual([{ kind: 'thinking', text: '' }]);
    expect(mapSdkMessage(ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '음…' } }))).toEqual([{ kind: 'thinking', text: '음…' }]);
    expect(mapSdkMessage(ev({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } }))).toEqual([{ kind: 'thinking', text: '', redacted: true }]);
    expect(mapSdkMessage(ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }))).toEqual([]);
  });
});

describe('thinking: transcript', () => {
  const asst = (content: unknown[]) => L({ type: 'assistant', timestamp: 't', message: { id: 'm1', model: 'x', content } });
  it('collects thinking text across chunks of one message', () => {
    const m = parseTranscript([asst([{ type: 'thinking', thinking: 'a' }]), asst([{ type: 'thinking', thinking: 'b' }, { type: 'text', text: 'hi' }])].join('\n'));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'assistant', text: 'hi', thinking: 'a\n\nb' });
  });
  it('marks redacted / empty-text thinking', () => {
    expect(parseTranscript(asst([{ type: 'redacted_thinking', data: 'zz' }, { type: 'text', text: 'hi' }]))[0]).toMatchObject({ thinkingRedacted: true });
    expect(parseTranscript(asst([{ type: 'thinking', thinking: '', signature: 's' }]))[0]).toMatchObject({ thinkingRedacted: true });
  });
  it('an empty thinking block with no signature shows nothing (not "encrypted")', () => {
    const e = parseTranscript(asst([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }]))[0];
    expect(e).not.toHaveProperty('thinkingRedacted');
    expect(e).not.toHaveProperty('thinking');
  });
});
