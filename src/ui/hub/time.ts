/** How long ago an ISO time was, coarsely (방금 · N분 전 · N시간 전 · N일 전); '기록 없음' for none or unreadable. */
export function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '기록 없음';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '기록 없음';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86_400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86_400)}일 전`;
}

export function hhmmss(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}
