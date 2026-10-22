import type { Widen } from '../../../shared/locale';
import type { settings as en } from '../en/settings';

export const settings: Widen<typeof en> = {
  language: '언어 · Language',
  languageAuto: '자동',
  languageHint: '알림과 서버 메시지는 어느 기기에서든 마지막으로 고른 언어를 따릅니다.',
  crossEngineFailover: '한도가 차면 다른 AI 로 이어가기',
  crossEngineFailoverHint: '한도가 차면 다른 AI 로 자동으로 이어갑니다. Gemini·Grok 은 외부 전송에 동의한 경우에만',
  autoResume: '한도가 풀리면 자동으로 이어가기',
  autoResumeHint: '넘길 곳 없이 한도로 멈춘 턴을 가장 이른 한도가 풀릴 때 다시 보냅니다. 서버 재시작으로 끊긴 작업도 재시작 직후 이어가게 합니다. 엔진·권한은 그대로',
  experimentalAppsTitle: '다른 앱 연동',
  experimentalBadge: '실험적 · 비공식',
  experimentalNotice: '공식 기능이 아니며 각 앱의 업데이트로 언제든 멈출 수 있어요. 켜면 해당 앱의 로컬 파일을 읽어요.',
  rotationTitle: '계정 순환',
  rotationNotice: '켜면 한도가 찬 계정에서 다음 계정으로 자동으로 넘어갑니다. 각 제공자 약관상 본인이 결제한 본인 계정끼리, 개인 사용에만 쓰세요.',
};
