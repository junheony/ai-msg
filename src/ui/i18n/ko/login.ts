import type { Widen } from '../../../shared/locale';
import type { login as en } from '../en/login';

export const login: Widen<typeof en> = {
  hint: '이 컴퓨터의 AI-MSG 가 만든 로그인 토큰을 붙여 넣으세요.',
  where: '토큰은 어디 있나요?',
  whereBody: '이 컴퓨터의 터미널에서 `ai-msg login-url` 을 실행하면 로그인 주소가 나옵니다. 그 주소를 열거나, 설정 폴더의 token 파일 내용을 아래에 붙여 넣으세요.',
  token: '로그인 토큰',
  submit: '로그인',
  badToken: '토큰이 올바르지 않습니다',
};
