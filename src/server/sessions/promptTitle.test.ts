import { describe, expect, it } from 'vitest';
import { promptTitle } from './promptTitle';

describe('promptTitle', () => {
  it('takes the first non-empty line, cut at 80', () => {
    expect(promptTitle('\n\n  hub 상태 보여줘  \n둘째 줄')).toBe('hub 상태 보여줘');
    expect(promptTitle('a'.repeat(100))).toBe('a'.repeat(80));
  });
  it('a slash command alone is never the title', () => {
    expect(promptTitle('/status')).toBeNull();
    expect(promptTitle('/status\n')).toBeNull();
    expect(promptTitle('/compact\n/status')).toBeNull();
  });
  it('a slash command with an argument titles by the argument; with a following line, by that line', () => {
    expect(promptTitle('/review src/server/hub 전부')).toBe('src/server/hub 전부');
    expect(promptTitle('/status\n\n오늘 프린터 비용 정리해줘')).toBe('오늘 프린터 비용 정리해줘');
    expect(promptTitle('/x y')).toBeNull();
  });
  it('empty input has no title', () => {
    expect(promptTitle('')).toBeNull();
    expect(promptTitle('   \n ')).toBeNull();
  });
});
