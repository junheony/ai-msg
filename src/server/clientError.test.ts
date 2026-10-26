import { describe, expect, it, vi } from 'vitest';
import { clientFileError } from './clientError';

describe('clientFileError', () => {
  it('keeps a short Korean reason and hides an absolute path or errno', () => {
    expect(clientFileError('세션을 열지 못했습니다', new Error('사본 줄 변환 검증 실패'))).toBe('세션을 열지 못했습니다: 사본 줄 변환 검증 실패');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/ada/.claude/projects/x.jsonl'"), { code: 'ENOENT' });
      expect(clientFileError('기록을 읽지 못했습니다', enoent)).toBe('기록을 읽지 못했습니다: 파일을 찾을 수 없습니다');
      expect(clientFileError('기록을 읽지 못했습니다', Object.assign(new Error('open failed'), { code: 'EPERM' }))).toBe('기록을 읽지 못했습니다: 권한이 없습니다');
      expect(clientFileError('세션 목록을 읽지 못했습니다', new Error('EACCES: permission denied, scandir /home/ada/.claude'))).toBe('세션 목록을 읽지 못했습니다: 권한이 없습니다');
      expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('/Users/ada/.claude');
      expect(clientFileError('기록을 읽지 못했습니다', enoent)).not.toContain('/Users/ada');
    } finally {
      log.mockRestore();
    }
  });
});
