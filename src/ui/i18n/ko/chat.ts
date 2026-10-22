import type { Widen } from '../../../shared/locale';
import type { chat as en } from '../en/chat';

export const chat: Widen<typeof en> = {
  meta: {
    label: '이 턴 정보',
    thinking: '생각하는 중…',
    thought: '생각함',
    thoughtFor: (s: number) => `${s}초 동안 생각함`,
    process: '생각 과정',
    live: '계속 작업 중',
    step: (n: number) => `단계 ${n}`,
    running: '실행 중…',
    errors: (n: number) => `오류 ${n}`,
  },
  bg: {
    completed: '백그라운드 완료',
    failed: '백그라운드 실패',
    stopped: '백그라운드 중단됨',
    running: '백그라운드 진행 중',
    other: '백그라운드 알림',
    raw: '원문 보기',
  },
  roles: {
    agents: (n: number) => `서브에이전트 ${n}`,
    offloads: (n: number) => `offload ${n}`,
    defaultModel: '기본 모델',
    auto: '자동',
  },
  agent: {
    result: '결과',
    prompt: '지시',
    fallback: '에이전트',
    background: '백그라운드',
    tokens: (n: string) => `${n} 토큰`,
    more: (n: number) => `+${n}개 더 보기`,
  },
  account: (name: string) => `계정 ${name}`,
  accountNote: { unknown: '설정에 없는 계정', retired: '뺀 계정', pinned: '고정', pin: '고정 계정' },
  images: (n: number) => `이미지 ${n}장`,
};
