// Settings › Accounts: the cloud plan row (display only — nothing is locked by it).

export const cloud = {
  planLabel: 'Plan',
  planNone: 'Community — phone relay comes with Pro',
  planTrial: (days: number) => `Trial · ${days} ${days === 1 ? 'day' : 'days'} left`,
  planActive: 'Pro · active',
  planPastDue: (date: string) => `Payment needs attention · kept until ${date}`,
  planCanceled: (date: string) => `Canceled · until ${date}`,
  planComp: (date: string) => `Pro (invited) · until ${date}`,
  proLine: 'Pro: a cloud relay to see and approve from your phone away from home, plus phone notifications',
  checkedAt: (when: string) => `Last checked ${when}`,
  refresh: 'Refresh',
  refreshing: 'Checking…',
};
