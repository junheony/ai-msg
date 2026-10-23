import type { Widen } from '../../../shared/locale';
import type { cards as en } from '../en/cards';

export const cards: Widen<typeof en> = {
  question: {
    cardLabel: '질문',
    title: 'Claude가 선택을 기다려요',
    step: (n: number, total: number) => `${n}/${total}`,
    prev: '이전 질문',
    next: '다음 질문',
    multi: '여러 개 선택',
    recommended: '추천',
    other: '기타',
    otherPlaceholder: '직접 입력해 주세요',
    otherLabel: (header: string) => `${header} 직접 입력`,
    left: (n: number) => `${n}개 남음`,
    submit: '답변 보내기',
    send: '보내기',
    sending: '보내는 중…',
    reopen: (q: string) => `답 바꾸기: ${q}`,
  },
  summary: {
    label: '고른 답',
    none: '답하지 않음',
  },
  permission: {
    label: (tool: string) => `권한 요청 ${tool}`,
    head: '권한 요청',
    reason: (r: string) => `이유: ${r}`,
    path: (p: string) => `경로: ${p}`,
    details: '자세히',
    deny: '거부',
    allowSession: '이 세션 동안 허용',
    sessionScope: '이 세션 동안 허용하면 다음은 다시 묻지 않아요:',
    sessionDir: (d: string) => `${d} 폴더 접근`,
    sessionEdits: '파일 편집',
    allowOnce: '허용 1회',
    sending: '보내는 중…',
  },
  plan: {
    label: '계획 승인',
    empty: '계획 내용이 없습니다.',
    keepPlanning: '계속 계획',
    manual: '승인하고 진행 · 수동 승인',
    manualTitle: '진행하되 도구 호출마다 묻습니다',
    auto: '승인하고 진행 · 편집 자동 승인',
    autoTitle: '진행하며 파일 편집은 묻지 않고 허용합니다',
  },
};
