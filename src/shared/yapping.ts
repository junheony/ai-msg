import type { HubSource, YappingDailyRow } from './hub-types';

const DAY_MS = 86_400_000;
export const yappingDateKst = (now: number): string => new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);

export type YappingDailyPoint = Omit<YappingDailyRow, 'views' | 'posts'> & { views: number | null; posts: number | null };
/** Include missing calendar dates explicitly so chart lines cannot bridge absent observations. */
export function yappingDailyWindow(rows: YappingDailyRow[], now: number, days = 30): YappingDailyPoint[] {
  const byDate = new Map(rows.map(row => [row.date, row]));
  return Array.from({ length: days }, (_, index) => {
    const date = yappingDateKst(now - (days - 1 - index) * DAY_MS);
    return byDate.get(date) ?? { date, followers: null, following: null, views: null, posts: null };
  });
}

/** Exact calendar comparisons: a missing day or null observation never becomes zero. */
export function yappingDailyDeltas(rows: YappingDailyRow[], now: number) {
  const date = yappingDateKst(now);
  const byDate = new Map(rows.map(row => [row.date, row]));
  const current = byDate.get(date);
  const difference = (field: 'followers' | 'views', days: number): number | null => {
    const previous = byDate.get(yappingDateKst(now - days * DAY_MS));
    const a = current?.[field], b = previous?.[field];
    return a == null || b == null ? null : a - b;
  };
  return { date, followers: { day: difference('followers', 1), week: difference('followers', 7) }, views: { day: difference('views', 1), week: difference('views', 7) } };
}
/** Only public X post permalinks; discard tracking queries and fragments. */
export function risingPostUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https:\/\/(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/\d+\/?(?:[?#].*)?$/.test(value)) return null;
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}
/** One summary in the collapsed source panel, including old-server API failures. */
export function yappingSourceSummary(sources: HubSource[]): string {
  const api = sources.filter((s) => s.name.startsWith('/api/'));
  const slow = api.filter((s) => !s.ok && /시간 초과|timeout/i.test(s.error ?? ''));
  if (slow.length) return `야핑봇 API 응답 느림 (${slow.length}/${api.length})`;
  const failed = sources.filter((s) => !s.ok);
  if (failed.length) return `소스 확인 필요 (${failed.length}/${sources.length})`;
  return '로컬 운영 기록 연결됨';
}
