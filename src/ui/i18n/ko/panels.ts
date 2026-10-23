import type { Widen } from '../../../shared/locale';
import type { panels as en } from '../en/panels';

export const panels: Widen<typeof en> = {
  help: { title: '단축키', close: '닫기', move: '이동', compose: '작성', panes: '패널·카드' },
  palette: {
    searching: '찾는 중…',
    empty: '맞는 항목이 없습니다',
    clear: '검색어 지우기',
    newChat: '새 대화 시작',
  },
  activity: {
    upJust: '서버가 방금 켜졌어요',
    upMin: (n: number) => `서버가 켜진 지 ${n}분 됐어요`,
    upHour: (n: number) => `서버가 켜진 지 ${n}시간 됐어요`,
    upDay: (n: number) => `서버가 켜진 지 ${n}일 됐어요`,
    startedAt: (when: string) => `서버 시작 ${when}`,
    idle: '지금 실행 중인 작업이 없어요',
    idleSince: (time: string) => `지금 실행 중인 작업이 없어요 · 마지막 작업은 ${time}에 끝났어요`,
    newChat: '새 대화 시작',
  },
};
