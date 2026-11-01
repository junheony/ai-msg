import { describe, expect, it } from 'vitest';
import { presentTranscript, replyStatus, sessionPreview, type AssistantItem } from './terminalPresentation';

const a = (text = '', extra: Partial<AssistantItem> = {}): AssistantItem => ({ kind: 'assistant', turnId: null, text, toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [], model: 'opus', ...extra });
const tool = (id: string) => ({ toolUseId: id, name: 'Bash', input: { command: id }, result: 'ok', isError: false });
const thought = { text: '먼저 확인', redacted: false, startedAt: null, ms: null };

describe('terminal presentation', () => {
  it('groups thinking and tools losslessly in source order, retaining original objects', () => {
    const first = a('', { thinking: thought, toolCalls: [tool('one')] });
    const second = a('', { thinking: { ...thought, text: '다음 확인' }, toolCalls: [tool('two')] });
    const final = a('결과', { toolCalls: [tool('three')] });
    const input = [first, second, final];
    const rows = presentTranscript(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.item).toBe(final);
    expect(rows[0]!.steps).toEqual(input);
    expect(rows[0]!.steps[0]).toBe(first);
    expect(first.toolCalls).toHaveLength(1);
  });
  it('does not cross users, system notices, model changes or turn boundaries', () => {
    const first = a('', { thinking: thought });
    for (const boundary of [{ kind: 'user', text: '다음', n: 5 } as const, { kind: 'system', source: 'hook', label: 'hook', text: '확인' } as const, a('답', { model: 'gpt' }), a('답', { turnId: 'next' })]) {
      expect(presentTranscript([first, boundary])).toHaveLength(2);
    }
  });
  it('keeps narrative, errors and notes as visible semantic boundaries', () => {
    const first = a('', { thinking: thought });
    expect(presentTranscript([a('확인 중'), first, a('결과')])).toHaveLength(2);
    expect(presentTranscript([first, a('', { error: '권한 오류' })])).toHaveLength(2);
    expect(presentTranscript([first, a('', { notes: ['계정 변경'] })])).toHaveLength(2);
  });
  it('marks a finished turn partial across commentary and model changes without mutating source text', () => {
    const failure = a('검사 중', { turnId: 't1', toolCalls: [{ ...tool('bad'), isError: true }] });
    const final = a('SUCCESS — 완료', { turnId: 't1', model: 'gpt-6-astra' });
    const rows = presentTranscript([failure, a('수정 확인', { turnId: 't1' }), final]);
    expect(rows.at(-1)?.statusOverride).toBe('PARTIAL');
    expect(rows[0]?.statusOverride).toBeUndefined();
    expect(final.text).toBe('SUCCESS — 완료');
  });
  it('isolates historical null-id turns by user and explicit turn ids without requiring a user boundary', () => {
    const failure = a('도구 오류', { toolCalls: [{ ...tool('bad'), isError: true }] });
    const history = presentTranscript([failure, a('SUCCESS — 일부 완료'), { kind: 'user', text: '다음 요청' }, a('SUCCESS — 전부 완료')]);
    expect(history[1]?.statusOverride).toBe('PARTIAL');
    expect(history.at(-1)?.statusOverride).toBeUndefined();
    const explicit = presentTranscript([{ ...failure, turnId: 'old' }, a('SUCCESS — 다음 작업', { turnId: 'new' })]);
    expect(explicit.at(-1)?.statusOverride).toBeUndefined();
  });
  it('preserves explicit-turn errors across steering user bubbles and waits for that turn to finish', () => {
    const failure = a('검토', { turnId: 'steered', toolCalls: [{ ...tool('bad'), isError: true }] });
    const items = [failure, { kind: 'user' as const, text: '검토를 더 해 줘' }, a('SUCCESS — 정리 완료', { turnId: 'steered' })];
    expect(presentTranscript(items, true, 'steered').every((row) => !row.statusOverride)).toBe(true);
    expect(presentTranscript(items).at(-1)?.statusOverride).toBe('PARTIAL');
    const next = [...items, { kind: 'user' as const, text: '새 작업' }, a('새 검토', { turnId: 'next', streaming: true })];
    expect(presentTranscript(next, true, 'next')[2]?.statusOverride).toBe('PARTIAL');
    expect(presentTranscript(next, true, 'next').at(-1)?.statusOverride).toBeUndefined();
  });

  it('retains BLOCKED and clean SUCCESS, and waits until streaming finishes to mark partial', () => {
    const failure = a('', { turnId: 't', toolCalls: [{ ...tool('bad'), isError: true }] });
    expect(presentTranscript([failure, a('BLOCKED — 권한 필요', { turnId: 't' })]).at(-1)?.statusOverride).toBeUndefined();
    expect(presentTranscript([a('SUCCESS — 확인 완료')]).at(-1)?.statusOverride).toBeUndefined();
    const live = a('SUCCESS — 작성 중', { turnId: 't', streaming: true });
    expect(presentTranscript([failure, live]).at(-1)?.statusOverride).toBeUndefined();
    expect(presentTranscript([failure, { ...live, streaming: false }], true).at(-1)?.statusOverride).toBeUndefined();
    expect(presentTranscript([failure, { ...live, streaming: false }]).at(-1)?.statusOverride).toBe('PARTIAL');
  });

  it('retains local streaming state and final model, while quieting repeated models', () => {
    const live = a('', { streaming: true, toolCalls: [{ ...tool('one'), result: null }] });
    const rows = presentTranscript([a('확인 중'), live]);
    expect(rows[0]!.quietModel).toBe(true);
    expect(rows[1]!.quietModel).toBe(false);
    expect(rows[1]!.steps[0]!.streaming).toBe(true);
    expect(presentTranscript([a('확인 중'), a('완료', { model: 'gpt' })])[0]!.quietModel).toBe(false);
  });
});

describe('report markers and session previews', () => {
  it.each(['PARTIAL. 수정 중', '**PARTIAL:** 수정 중', '**PARTIAL**: 수정 중', 'PARTIAL 수정 중', 'PARTIAL — 수정 중', '**PARTIAL** — 수정 중'])('extracts explicit marker %s', (text) => {
    expect(replyStatus(text)).toEqual({ status: 'PARTIAL', text: '수정 중' });
  });
  it.each(['SUCCESS is a variable', '작업 결과는 BLOCKED: 입니다', '`SUCCESS`', '> BLOCKED: quoted', '```\nPARTIAL.\n```', 'SUCCESSFUL', '**BLOCKEDNESS**', '**SUCCESS**ful'])('does not reinterpret ordinary prose/code %s', (text) => {
    expect(replyStatus(text)).toEqual({ status: null, text });
  });
  it('strips markdown while retaining meaningful preview words and extracting status separately', () => {
    expect(sessionPreview('**BLOCKED:** **영상** [링크](https://example.test) 확인\n- 다음 단계')).toEqual({ status: 'BLOCKED', text: '영상 링크 확인 다음 단계' });
    expect(sessionPreview('```css\nbody{}\n```\n`source.css` **수정** 완료')).toEqual({ status: null, text: '수정 완료' });
  });
});
