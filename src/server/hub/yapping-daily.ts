/** Read-only daily history: failures never replace independent local operational counters. */
import type { HubSource, YappingDaily, YappingDailyRow } from '../../shared/hub-types';
import { HUB_TIMEOUTS, HUB_URLS, errorText, isObj, type HubDeps } from './shared';

const CACHE_MS = 60_000;
type Result = { daily: YappingDaily; source: HubSource };
const cache = new WeakMap<HubDeps, { at: number; value: Result }>();
const inflight = new WeakMap<HubDeps, Promise<Result>>();
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseDaily(raw: unknown): YappingDaily {
  const invalid = (): never => { throw new Error('응답 형식 오류'); };
  if (!Array.isArray(raw) || raw.length > 30) return invalid();
  let previous = '';
  const rows: YappingDailyRow[] = raw.map((row: unknown) => {
    if (!isObj(row) || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
      || !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`))
      || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date || row.date <= previous
      || !(row.followers === null || count(row.followers)) || !(row.following === null || count(row.following))
      || !count(row.views) || !count(row.posts)) return invalid();
    previous = row.date;
    return { date: row.date, followers: row.followers, following: row.following, views: row.views, posts: row.posts };
  });
  return { rows, reason: rows.length ? null : '집계된 일별 기록 없음' };
}

export async function collectDaily(deps: HubDeps): Promise<Result> {
  const saved = cache.get(deps);
  if (saved && deps.now() - saved.at < CACHE_MS) return saved.value;
  const pending = inflight.get(deps);
  if (pending) return pending;
  const task = (async (): Promise<Result> => {
    const start = deps.now();
    let value: Result;
    try {
      const daily = parseDaily(await deps.fetchJson(HUB_URLS.yappingDaily, HUB_TIMEOUTS.default));
      value = { daily, source: { name: '/api/metrics/daily', ok: true, ms: deps.now() - start } };
    } catch (error) {
      const reason = errorText(error);
      value = { daily: { rows: [], reason }, source: { name: '/api/metrics/daily', ok: false, ms: deps.now() - start, error: reason } };
    }
    // Cache errors as well; do not hammer a failed source on every hub refresh.
    cache.set(deps, { at: deps.now(), value });
    return value;
  })();
  inflight.set(deps, task);
  try { return await task; } finally { inflight.delete(deps); }
}
