/** Independent read-only feed: local operational counters remain authoritative. */
import type { HubSource, YappingRising, YappingRisingItem } from '../../shared/hub-types';
import { risingPostUrl } from '../../shared/yapping';
import { HUB_TIMEOUTS, HUB_URLS, errorText, isObj, scrub, toIso, type HubDeps } from './shared';

const CACHE_MS = 30_000;
type Result = { rising: YappingRising; source: HubSource };
const cache = new WeakMap<HubDeps, { at: number; value: Result }>();
const inflight = new WeakMap<HubDeps, Promise<Result>>();
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v);
const clean = (v: string, max: number) => scrub(v, max).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

export function parseRising(raw: unknown): YappingRising {
  const invalid = () => { throw new Error('응답 형식 오류'); };
  if (!isObj(raw) || typeof raw.generated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw.generated_at) || !toIso(raw.generated_at) || !finite(raw.window_h) || raw.window_h <= 0 || !Array.isArray(raw.items) || raw.items.length > 100) return invalid();
  const items: YappingRisingItem[] = raw.items.map((item: unknown) => {
    if (!isObj(item) || !integer(item.rank) || item.rank < 1 || !finite(item.velocity_vph) || !finite(item.age_h)
      || !integer(item.followers) || !integer(item.views) || !integer(item.observations) || !finite(item.score)
      || typeof item.method !== 'string' || typeof item.author !== 'string' || typeof item.text !== 'string' || typeof item.topic !== 'string') return invalid();
    const url = risingPostUrl(item.url), author = clean(item.author, 80), text = clean(item.text, 500), topic = clean(item.topic, 60);
    if (!url || !author || !text || !topic) return invalid();
    return { rank: item.rank, url, author, text, topic, velocityVph: item.velocity_vph, ageH: item.age_h };
  });
  const seen = new Set<string>();
  const top = items.sort((a, b) => a.rank - b.rank).filter(item => { if (seen.has(item.url)) return false; seen.add(item.url); return true; }).slice(0, 10);
  return { generatedAt: toIso(raw.generated_at), windowH: raw.window_h, items: top, reason: top.length ? null : '집계된 게시물 없음' };
}

export async function collectRising(deps: HubDeps): Promise<Result> {
  const saved = cache.get(deps);
  if (saved && deps.now() - saved.at < CACHE_MS) return saved.value;
  const pending = inflight.get(deps);
  if (pending) return pending;
  const task = (async (): Promise<Result> => {
    const start = deps.now();
    let value: Result;
    try {
      const rising = parseRising(await deps.fetchJson(HUB_URLS.yappingRising, HUB_TIMEOUTS.default));
      value = { rising, source: { name: '/api/rising', ok: true, ms: deps.now() - start } };
    } catch (error) {
      const reason = errorText(error);
      value = { rising: { generatedAt: null, windowH: null, items: [], reason }, source: { name: '/api/rising', ok: false, ms: deps.now() - start, error: reason } };
    }
    // Cache failures too; a down source must not be retried on every hub refresh.
    cache.set(deps, { at: deps.now(), value });
    return value;
  })();
  inflight.set(deps, task);
  try { return await task; } finally { inflight.delete(deps); }
}
