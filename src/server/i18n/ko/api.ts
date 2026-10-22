import type { Widen } from '../../../shared/locale';
import type { api as en } from '../en/api';

export const api: Widen<typeof en> = {
  badSessionIcon: '잘못된 세션 아이콘 요청입니다',
  sessionIconsFull: (max) => `세션 아이콘은 ${max}개까지 저장됩니다 — 다른 세션의 아이콘을 먼저 기본으로 되돌려 주세요`,
};
