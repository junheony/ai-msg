import type { Widen } from '../../../shared/locale';
import type { common as en } from '../en/common';

export const common: Widen<typeof en> = {
  copy: '복사',
  settings: '설정',
  periodFiveHour: '5시간',
  periodWeek: '주',
  periodMonth: '월',
};
