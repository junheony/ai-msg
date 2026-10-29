import type { sessionIcon as en } from '../en/sessionIcon';

/** Session avatar picker. The product UI is Korean. */
export const sessionIcon: { [K in keyof typeof en]: (typeof en)[K] } = {
  change: '아이콘 바꾸기',
  picker: '세션 아이콘',
  emoji: '이모지',
  glyphs: '선 아이콘',
  reset: '기본으로 (제목 이모지 또는 첫 글자)',
  failed: '아이콘 바꾸기 실패',
  network: '아이콘 바꾸기 실패: 네트워크 오류',
};
