import type { HubSource } from './hub-types';
/** One summary in the collapsed source panel, including old-server API failures. */
export function yappingSourceSummary(sources: HubSource[]): string {
  const api = sources.filter((s) => s.name.startsWith('/api/'));
  const slow = api.filter((s) => !s.ok && /시간 초과|timeout/i.test(s.error ?? ''));
  if (slow.length) return `야핑봇 API 응답 느림 (${slow.length}/${api.length})`;
  const failed = sources.filter((s) => !s.ok);
  if (failed.length) return `소스 확인 필요 (${failed.length}/${sources.length})`;
  return '로컬 운영 기록 연결됨';
}
