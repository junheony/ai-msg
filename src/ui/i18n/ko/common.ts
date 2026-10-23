import type { Widen } from '../../../shared/locale';
import type { common as en } from '../en/common';

export const common: Widen<typeof en> = {
  copy: '복사',
  settings: '설정',
  periodFiveHour: '5시간',
  periodWeek: '주',
  periodMonth: '월',
  connReconnecting: '다시 연결하는 중…',
  connRestarting: '서버를 다시 시작하는 중… 연결되면 자동으로 이어집니다',
  connDown: (since: string) => `서버에 연결할 수 없어요 · ${since}부터 — 연결되면 자동으로 이어집니다`,
  retry: '다시 시도',
  skipToMain: '본문으로 건너뛰기',
  unsent: '안 보냄',
  unsentHint: '연결이 끊겨 보내지 못했습니다 — 다시 연결되면 보냅니다 (다시 보내기를 눌러도 됩니다)',
  resend: '다시 보내기',
  errorRaw: '원래 메시지',
  errors: {
    execution: 'AI 가 작업하다 오류로 멈췄어요. 다시 보내면 이어서 시도합니다.',
    maxTurns: '이번 턴의 작업 단계 한도에 닿았어요. "계속"이라고 보내면 이어갑니다.',
    maxBudget: '이번 턴의 사용 금액 한도에 닿았어요.',
    overloaded: 'AI 서비스가 지금 붐벼요. 잠시 뒤 다시 시도해 주세요.',
    rateLimit: '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.',
    auth: 'AI 계정 로그인이 없거나 만료됐어요. 설정에서 계정을 확인해 주세요.',
    network: 'AI 서비스와 연결이 끊겼어요. 잠시 뒤 다시 시도해 주세요.',
    timeout: 'AI 응답이 너무 오래 걸렸어요. 다시 시도해 주세요.',
    unknown: '문제가 생겼어요. 다시 시도해 주세요.',
  },
};
