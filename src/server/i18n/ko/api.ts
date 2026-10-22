import type { Widen } from '../../../shared/locale';
import type { api as en } from '../en/api';

export const api: Widen<typeof en> = {
  badSessionIcon: '잘못된 세션 아이콘 요청입니다',
};
