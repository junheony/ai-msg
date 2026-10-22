import type { Widen } from '../../../shared/locale';
import type { settings as en } from '../en/settings';

export const settings: Widen<typeof en> = {
  language: '언어 · Language',
  languageAuto: '자동',
  languageHint: '알림과 서버 메시지는 어느 기기에서든 마지막으로 고른 언어를 따릅니다.',
};
