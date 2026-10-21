/** Sidebar 최근 view: Desktop-style buckets by local calendar day. */
export const DATE_GROUPS = ['오늘', '어제', '지난 7일', '지난 30일', '이전'] as const;
export type DateGroup = (typeof DATE_GROUPS)[number];

/** Local midnight `daysAgo` days before `now` (calendar arithmetic, so DST days still count as one). */
function dayStart(now: number, daysAgo: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

export function dateGroupOf(ms: number, now: number = Date.now()): DateGroup {
  if (ms >= dayStart(now, 0)) return '오늘';
  if (ms >= dayStart(now, 1)) return '어제';
  if (ms >= dayStart(now, 6)) return '지난 7일';
  if (ms >= dayStart(now, 29)) return '지난 30일';
  return '이전';
}

/** Newest first, split into the non-empty buckets in DATE_GROUPS order. */
export function groupByDate<T extends { lastModified: number }>(items: T[], now: number = Date.now()): { label: DateGroup; items: T[] }[] {
  const sorted = [...items].sort((a, b) => b.lastModified - a.lastModified);
  const out = new Map<DateGroup, T[]>();
  for (const it of sorted) {
    const g = dateGroupOf(it.lastModified, now);
    out.set(g, [...(out.get(g) ?? []), it]);
  }
  return DATE_GROUPS.filter((g) => out.has(g)).map((label) => ({ label, items: out.get(label)! }));
}

/** A divider goes in when the conversation picks up after this long a pause (or on another day). */
export const DIVIDER_GAP_MS = 30 * 60_000;

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** The transcript's time divider, Grok Bot style: "오전 11:50"; "어제 오후 3:05"; "10월 20일 오전 9:00"; another year leads with it. */
export function timeLabel(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const h = d.getHours();
  const time = `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay(ms, now)) return time;
  if (sameDay(ms, dayStart(now, 1))) return `어제 ${time}`;
  const date = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return d.getFullYear() === new Date(now).getFullYear() ? `${date} ${time}` : `${d.getFullYear()}년 ${date} ${time}`;
}

/**
 * Where the transcript's time dividers go: index → the time to show (null = none). Only replies carry a time (their
 * context's `at`), so a user message takes its exchange's — the first timed reply after it — and gets a divider when that
 * is on another day or more than DIVIDER_GAP_MS after the last time seen above it (the first exchange always does).
 */
export function timeDividers(items: readonly { kind: string; ctx?: { at: number | null } }[]): (number | null)[] {
  const turnAt = new Map<number, number>();
  let user = -1;
  items.forEach((it, i) => {
    if (it.kind === 'user') user = i;
    else if (user >= 0 && !turnAt.has(user) && it.ctx?.at != null) turnAt.set(user, it.ctx.at);
  });
  let prev: number | null = null;
  return items.map((it, i) => {
    const t = turnAt.get(i);
    const show = t !== undefined && (prev === null || !sameDay(prev, t) || t - prev > DIVIDER_GAP_MS);
    if (it.ctx?.at != null) prev = it.ctx.at;
    return show ? t! : null;
  });
}
