import type { Widen } from '../../../shared/locale';
import type { sessionIcon as en } from '../en/sessionIcon';

export const sessionIcon: Widen<typeof en> = {
  change: '아이콘 바꾸기',
  picker: '세션 아이콘',
  emoji: '이모지',
  glyphs: '선 아이콘',
  reset: '기본으로 (첫 글자)',
  failed: '아이콘 바꾸기 실패',
  network: '아이콘 바꾸기 실패: 네트워크 오류',
  settings: '설정',
  periodFiveHour: '5시간',
  periodWeek: '주',
};
