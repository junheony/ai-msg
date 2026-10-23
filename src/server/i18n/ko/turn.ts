import type { Widen } from '../../../shared/locale';
import type { turn as en } from '../en/turn';

export const turn: Widen<typeof en> = {
  crossNotice: (from: string, to: string) => `${from} 한도가 차서 ${to} 로 이어갑니다`,
  crossCarry: (from: string, excerpt: string) =>
    `[deck] 이 새 세션은 사용자가 다른 AI(${from})와 하던 대화를 이어받았습니다 — ${from} 한도가 차서 AI-MSG 가 자동으로 넘겼습니다. 아래는 이전 대화 발췌입니다(도구 호출 제외, 비밀값 가림). 이번 메시지에 답하고, 대화를 넘겨받았다는 사실을 사용자에게 한 줄로 알리세요.\n\n${excerpt || '(발췌할 이전 대화가 없습니다)'}`,
  draining: '서버가 재시작을 준비 중입니다 — 잠시 뒤 다시 보내 주세요',
  stopping: '서버가 꺼지는 중입니다 — 다시 켜지면 보내지 못한 메시지를 이어서 보냅니다',
  crossContinue: '이어서 진행해 주세요.',
  crossCarried: '이전 대화는 요약 발췌만 넘어갑니다',
  crossNotCarried: '이전 대화를 넘기지 못했습니다',
  restartResume: {
    lead: '서버가 다시 시작되면서 이 세션에서 하던 작업이 끊겼습니다.',
    prompt: (tasks: string) =>
      `서버가 다시 시작되면서 이 세션에서 하던 작업이 끊겼습니다.${tasks ? ` 끊긴 백그라운드 작업: ${tasks}.` : ''} 어디까지 됐는지 확인하고, 필요하면 끊긴 작업(대기·잠자기·모니터 포함)을 다시 걸고 이어서 진행해 주세요. (AI-MSG 가 자동으로 보낸 메시지입니다)`,
    notice: '서버 재시작으로 끊긴 작업을 자동으로 이어갑니다',
    log: (n: number) => `deck: 재시작으로 끊긴 세션 ${n}개를 자동으로 이어가도록 예약했습니다`,
    repeatSkipped: (ids: string) => `deck: 지난 재시작 뒤에도 이어간 세션이라 이번엔 자동으로 이어가지 않습니다: ${ids}`,
    cutWriteFailed: (err: string) => `deck: 끊길 세션 기록(restart-cut.json) 실패 — ${err}`,
  },
};
