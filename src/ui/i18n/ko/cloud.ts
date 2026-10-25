import type { Widen } from '../../../shared/locale';
import type { cloud as en } from '../en/cloud';

export const cloud: Widen<typeof en> = {
  planLabel: '요금제',
  planNone: 'Community — 폰 릴레이는 Pro 에서',
  planTrial: (days: number) => `체험 중 · ${days}일 남음`,
  planActive: 'Pro · 사용 중',
  planPastDue: (date: string) => `결제 확인 필요 · ${date}까지 유지`,
  planCanceled: (date: string) => `해지됨 · ${date}까지`,
  planComp: (date: string) => `Pro(초대) · ${date}까지`,
  proLine: 'Pro: 집 밖에서 폰으로 보고 승인하는 클라우드 릴레이와 폰 알림',
  checkedAt: (when: string) => `마지막 확인 ${when}`,
  refresh: '새로고침',
  refreshing: '확인 중…',
  subscribe: 'Pro 구독',
  manage: '구독 관리',
};
