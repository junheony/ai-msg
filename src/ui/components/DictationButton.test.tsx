// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DictationButton, mergeTranscripts } from './DictationButton';

describe('mergeTranscripts', () => {
  it('Android Chrome cumulative results replace instead of repeating', () => {
    expect(mergeTranscripts(['안녕', '안녕 하세요'])).toBe('안녕 하세요');
    expect(mergeTranscripts(['안녕', '안녕 하세요', '안녕 하세요 반갑습니다'])).toBe('안녕 하세요 반갑습니다');
  });

  it('a new result that extends only the previous one replaces that one', () => {
    expect(mergeTranscripts(['오늘은 ', '날씨가', '날씨가 좋네요'])).toBe('오늘은 날씨가 좋네요');
  });

  it('Safari re-emitted final spans are dropped', () => {
    expect(mergeTranscripts(['안녕하세요.', '안녕하세요'])).toBe('안녕하세요.');
    expect(mergeTranscripts(['안녕하세요 반갑습니다', '반갑습니다'])).toBe('안녕하세요 반갑습니다');
    expect(mergeTranscripts(['안녕하세요', '안녕하세요, 반갑습니다'])).toBe('안녕하세요, 반갑습니다');
    expect(mergeTranscripts(['안녕하세요', ' 반갑습니다', '안녕하세요 반갑습니다'])).toBe('안녕하세요 반갑습니다');
  });

  it('desktop Chrome sequential results are concatenated as-is', () => {
    expect(mergeTranscripts(['안녕하세요', ' 반갑습니다'])).toBe('안녕하세요 반갑습니다');
    expect(mergeTranscripts(['하나', ' 둘', ' 셋'])).toBe('하나 둘 셋');
  });

  it('interim → final transitions never duplicate', () => {
    // Chrome rewrites the last result in place; each event re-merges the whole list.
    const events = [['안녕'], ['안녕하'], ['안녕하세요'], ['안녕하세요', ' 반'], ['안녕하세요', ' 반갑습니다']];
    expect(events.map(mergeTranscripts)).toEqual(['안녕', '안녕하', '안녕하세요', '안녕하세요 반', '안녕하세요 반갑습니다']);
    // Safari: the final copy plus a growing interim that restates it.
    expect(mergeTranscripts(['안녕하세요', '안녕하세요 반'])).toBe('안녕하세요 반');
    expect(mergeTranscripts(['안녕하세요', '안녕하세요', '안녕하세요 반갑습니다'])).toBe('안녕하세요 반갑습니다');
  });

  it('empty input and empty / whitespace-only results', () => {
    expect(mergeTranscripts([])).toBe('');
    expect(mergeTranscripts([''])).toBe('');
    expect(mergeTranscripts(['', '  ', '안녕', ''])).toBe('안녕');
  });
});

describe('DictationButton', () => {
  type Ev = { resultIndex: number; results: Array<Array<{ transcript: string }> & { isFinal: boolean }> };
  let last: { onresult: ((e: Ev) => void) | null; onend: (() => void) | null } | null = null;
  class FakeRec {
    lang = ''; continuous = false; interimResults = false;
    onresult: ((e: Ev) => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor() { last = this; }
    start() {}
    stop() { this.onend?.(); }
  }
  const emit = (texts: string[]) => last!.onresult!({ resultIndex: 0, results: texts.map((t) => Object.assign([{ transcript: t }], { isFinal: true })) });

  afterEach(() => { cleanup(); last = null; delete (window as { SpeechRecognition?: unknown }).SpeechRecognition; });

  it('writes base + sep + merged transcript, keeping previously dictated text in base', () => {
    (window as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRec;
    const onText = vi.fn();
    render(<DictationButton text="이미 받아쓴 안녕" onText={onText} />);
    fireEvent.click(screen.getByRole('button', { name: '음성 받아쓰기' }));
    emit(['안녕', '안녕 하세요']);
    expect(onText).toHaveBeenLastCalledWith('이미 받아쓴 안녕 안녕 하세요');
    emit([]);
    expect(onText).toHaveBeenLastCalledWith('이미 받아쓴 안녕');
  });
});
