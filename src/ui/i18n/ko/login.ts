import type { Widen } from '../../../shared/locale';
import type { login as en } from '../en/login';

export const login: Widen<typeof en> = {
  hint: '터미널에서 `ai-msg login-url` 을 실행해 나온 주소를 열거나, 설정 폴더의 token 파일 내용을 입력하세요.',
  token: '로그인 토큰',
  submit: '로그인',
  badToken: '토큰이 올바르지 않습니다',
};
