import type { Widen } from '../../../shared/locale';
import type { turn as en } from '../en/turn';

export const turn: Widen<typeof en> = {
  crossNotice: (from: string, to: string) => `${from} 한도가 차서 ${to} 로 이어갑니다`,
  crossCarry: (from: string, excerpt: string) =>
    `[deck] 이 새 세션은 사용자가 다른 AI(${from})와 하던 대화를 이어받았습니다 — ${from} 한도가 차서 deck 이 자동으로 넘겼습니다. 아래는 이전 대화 발췌입니다(도구 호출 제외, 비밀값 가림). 이번 메시지에 답하고, 대화를 넘겨받았다는 사실을 사용자에게 한 줄로 알리세요.\n\n${excerpt || '(발췌할 이전 대화가 없습니다)'}`,
  crossContinue: '이어서 진행해 주세요.',
};
