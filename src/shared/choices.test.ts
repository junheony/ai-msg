import { describe, expect, it } from 'vitest';
import { DECK_CHOICES_PROMPT, MAX_CHOICES, splitDeckChoices, stripSystemReminders, systemReminder } from './choices';

const block = (body: string) => `\`\`\`deck-choices\n${body}\n\`\`\``;

describe('deck-choices', () => {
  it('splits the block out: question, options (-, *, 1.), text without it', () => {
    const r = splitDeckChoices(`테스트가 둘 깨졌습니다.\n\n${block('? 어떻게 할까요?\n- 지금 고치기\n* 이슈만 남기기\n3. 건너뛰기')}\n`);
    expect(r.text).toBe('테스트가 둘 깨졌습니다.');
    expect(r.choices).toEqual({ question: '어떻게 할까요?', options: ['지금 고치기', '이슈만 남기기', '건너뛰기'] });
  });
  it('no question line; plain lines are options; duplicates and empty lines dropped; capped', () => {
    const r = splitDeckChoices(block(['A', '', 'A', ...Array.from({ length: 9 }, (_, i) => `- o${i}`)].join('\n')));
    expect(r.choices?.question).toBeNull();
    expect(r.choices?.options).toHaveLength(MAX_CHOICES);
    expect(r.choices?.options[0]).toBe('A');
    expect(r.text).toBe('');
  });
  it('fewer than two options: no cards, block still removed; the last valid block wins', () => {
    expect(splitDeckChoices(`앞\n${block('- 하나')}`)).toEqual({ text: '앞', choices: null });
    expect(splitDeckChoices(`${block('- a\n- b')}\n중간\n${block('- c\n- d')}`)).toEqual({ text: '중간', choices: { question: null, options: ['c', 'd'] } });
  });
  it('text without a block is untouched (fast path); other fences stay', () => {
    const t = '```ts\nconst x = 1;\n```';
    expect(splitDeckChoices(t)).toEqual({ text: t, choices: null });
  });
  it('streaming: an unclosed block at the end is hidden; finished text keeps an unclosed one as is', () => {
    expect(splitDeckChoices('결과입니다.\n```deck-choices\n- 지금', true)).toEqual({ text: '결과입니다.', choices: null });
    expect(splitDeckChoices('결과입니다.\n```deck-choices\n- 지금', false).text).toContain('deck-choices');
  });
  it('the prompt shows the exact fence the parser reads', () => {
    const example = DECK_CHOICES_PROMPT.slice(DECK_CHOICES_PROMPT.indexOf('```deck-choices'), DECK_CHOICES_PROMPT.lastIndexOf('```') + 3);
    expect(splitDeckChoices(example).choices).toEqual({ question: '짧은 질문', options: ['선택지 1', '선택지 2'] });
  });
  it('system reminders: wrap and strip leading blocks only', () => {
    expect(systemReminder('x')).toBe('<system-reminder>\nx\n</system-reminder>');
    expect(stripSystemReminders(`${systemReminder('a')}\n${systemReminder('b')}\n\n질문 <system-reminder>q</system-reminder>`)).toBe('질문 <system-reminder>q</system-reminder>');
    expect(stripSystemReminders('그냥 질문')).toBe('그냥 질문');
  });
});
