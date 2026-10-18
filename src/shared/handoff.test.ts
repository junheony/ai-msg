import { describe, expect, it } from 'vitest';
import { CODEX_HANDOFF_EXCERPT_MAX, CODEX_HANDOFF_MESSAGE_MAX, THREAD_LOCKED_MESSAGE, codexHandoffExcerpt, codexHandoffMessage, isThreadLocked } from './handoff';

describe('isThreadLocked', () => {
  it('the error code, or (an older server) the error text starting with THREAD_LOCKED_MESSAGE', () => {
    expect(isThreadLocked('thread_locked', 'anything')).toBe(true);
    expect(isThreadLocked(undefined, THREAD_LOCKED_MESSAGE)).toBe(true);
    expect(isThreadLocked(undefined, `${THREAD_LOCKED_MESSAGE}\n\nstderr…`)).toBe(true);
    expect(isThreadLocked(undefined, '한도 도달')).toBe(false);
    expect(isThreadLocked(null, null)).toBe(false);
    expect(isThreadLocked(undefined, `앞말 ${THREAD_LOCKED_MESSAGE}`)).toBe(false);
  });
});

describe('codexHandoffExcerpt', () => {
  it('user and assistant text only, in order, as **사용자:** / **GPT:** paragraphs; tool calls, thinking and notes left out', () => {
    // ChatItem-shaped: only kind and text are read
    const items = [
      { kind: 'user', text: '질문 1' },
      { kind: 'system', text: '훅 메시지' },
      { kind: 'assistant', text: '답 1', toolCalls: [{ name: 'Bash', input: { command: 'rm -rf' } }], thinking: { text: '생각' }, notes: ['알림'] },
      { kind: 'assistant', text: '   ' },
      { kind: 'user', text: '질문 2' },
    ];
    const out = codexHandoffExcerpt(items);
    expect(out).toBe('**사용자:** 질문 1\n\n**GPT:** 답 1\n\n**사용자:** 질문 2');
    expect(out).not.toContain('rm -rf');
    expect(out).not.toContain('생각');
    expect(out).not.toContain('알림');
    expect(out).not.toContain('훅');
  });

  it('a message over 2,000 characters is cut there and ends with …(생략)', () => {
    const long = 'a'.repeat(CODEX_HANDOFF_MESSAGE_MAX + 500);
    expect(codexHandoffExcerpt([{ kind: 'user', text: long }])).toBe(`**사용자:** ${'a'.repeat(CODEX_HANDOFF_MESSAGE_MAX)}…(생략)`);
    const exact = 'b'.repeat(CODEX_HANDOFF_MESSAGE_MAX);
    expect(codexHandoffExcerpt([{ kind: 'user', text: exact }])).toBe(`**사용자:** ${exact}`);
  });

  it('the cut never splits a surrogate pair', () => {
    const t = `${'a'.repeat(CODEX_HANDOFF_MESSAGE_MAX - 1)}😀${'z'.repeat(10)}`;
    expect(codexHandoffExcerpt([{ kind: 'user', text: t }])).toBe(`**사용자:** ${'a'.repeat(CODEX_HANDOFF_MESSAGE_MAX - 1)}…(생략)`);
  });

  it('over 12,000 characters in all: the oldest go first, and the excerpt opens with (앞부분 생략)', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', text: `${i}`.repeat(1990) }));
    const out = codexHandoffExcerpt(msgs);
    expect(out.startsWith('(앞부분 생략)\n\n')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(CODEX_HANDOFF_EXCERPT_MAX + '(앞부분 생략)\n\n'.length);
    // the newest are kept, the oldest dropped
    expect(out).toContain('9'.repeat(1990));
    expect(out).not.toContain('0'.repeat(1990));
    const kept = out.split('\n\n').slice(1);
    expect(kept.at(-1)).toBe(`**GPT:** ${'9'.repeat(1990)}`);
    // as many as fit: one more would go over
    const nextOlder = `**사용자:** ${'0'.repeat(1990)}`;
    const keptLen = kept.join('\n\n').length;
    expect(keptLen + 2 + nextOlder.length).toBeGreaterThan(CODEX_HANDOFF_EXCERPT_MAX);
  });

  it('nothing dropped: no (앞부분 생략); nothing at all: empty', () => {
    expect(codexHandoffExcerpt([{ kind: 'user', text: 'x' }])).not.toContain('앞부분 생략');
    expect(codexHandoffExcerpt([])).toBe('');
  });
});

describe('codexHandoffMessage', () => {
  it('says why, names the old session, carries the excerpt, then the failed request on its own', () => {
    const excerpt = codexHandoffExcerpt([{ kind: 'user', text: '이전 질문' }, { kind: 'assistant', text: '이전 답' }]);
    const m = codexHandoffMessage('작업', 'tid-1', excerpt, '이 함수 고쳐줘');
    expect(m).toContain('이전 GPT 세션(작업, tid-1)이 다른 앱에 열려 있어 deck 에서 새 세션으로 이어갑니다.');
    expect(m).toContain('아래는 이전 대화 발췌입니다(도구 호출 제외).');
    expect(m).toContain('**사용자:** 이전 질문\n\n**GPT:** 이전 답');
    expect(m.trimEnd().endsWith('이어서 할 요청:\n\n이 함수 고쳐줘')).toBe(true);
    // the request comes after the excerpt, once
    expect(m.indexOf('이어서 할 요청:')).toBeGreaterThan(m.indexOf('이전 답'));
    expect(m.split('이 함수 고쳐줘')).toHaveLength(2);
  });

  it('no earlier conversation: says so instead of an empty excerpt', () => {
    expect(codexHandoffMessage('작업', 'tid-1', '', '요청')).toContain('(발췌할 이전 대화가 없습니다)');
  });
});
