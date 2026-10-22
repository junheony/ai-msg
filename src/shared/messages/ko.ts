import type { Widen } from '../locale';
import type { en } from './en';

export const ko: Widen<typeof en> = {
  loginState: { yes: '로그인됨', no: '로그인 안 됨', unknown: '확인 못 함' },
};
