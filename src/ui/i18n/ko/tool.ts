import type { Widen } from '../../../shared/locale';
import type { tool as en } from '../en/tool';

export const tool: Widen<typeof en> = {
  error: '오류',
  running: '실행 중…',
  exitCode: (n: number) => `종료 코드 ${n}`,
  command: '명령',
  input: '입력',
  output: '출력',
  copyCommand: '명령 복사',
  copyInput: '입력 복사',
  copyOutput: '출력 복사',
  raw: '원문 입력',
  noOutput: '출력 없음',
  showAll: (lines: number) => `전체 보기 (${lines}줄)`,
  showTail: (lines: number) => `끝 ${lines}줄만 보기`,
  hiddenLines: (n: number) => `앞 ${n}줄 생략`,
  hiddenChars: (n: string) => `앞부분 ${n}자 생략`,
  serverCut: (shown: string, total: string) => `출력이 길어 원래 ${total}자 중 앞 ${shown}자만 남았어요`,
  wrap: '줄바꿈',
  wrapTitle: '긴 줄 감싸기 (모든 코드 블록·diff)',
};
