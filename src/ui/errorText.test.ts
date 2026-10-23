import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../shared/locale';
import { describeError } from './errorText';

describe('describeError', () => {
  afterEach(() => setLocale('ko'));

  it('a raw CLI code reads as a sentence, the original kept to fold underneath', () => {
    setLocale('ko');
    expect(describeError('error_during_execution')).toEqual({ text: 'AI 가 작업하다 오류로 멈췄어요. 다시 보내면 이어서 시도합니다.', raw: 'error_during_execution' });
    expect(describeError('error_max_turns').text).toMatch(/단계 한도/);
    expect(describeError('API Error: 529 {"type":"overloaded_error"}').text).toMatch(/붐벼요/);
    expect(describeError('rate_limit_error').text).toMatch(/요청이 너무 많아요/);
    expect(describeError('authentication_error: invalid x-api-key').text).toMatch(/로그인/);
    expect(describeError('read ECONNRESET').raw).toBe('read ECONNRESET');
  });

  it('an unknown bare code gets the generic sentence; prose and Korean pass through untouched', () => {
    setLocale('ko');
    expect(describeError('some_new_subtype')).toEqual({ text: '문제가 생겼어요. 다시 시도해 주세요.', raw: 'some_new_subtype' });
    expect(describeError('세션을 열 수 없습니다')).toEqual({ text: '세션을 열 수 없습니다', raw: null });
    expect(describeError('Could not open the folder')).toEqual({ text: 'Could not open the folder', raw: null });
    expect(describeError('')).toEqual({ text: '', raw: null });
  });

  it('follows the UI language', () => {
    setLocale('en');
    expect(describeError('error_during_execution').text).toBe('The AI stopped with an error while working. Send again to retry.');
  });
});
