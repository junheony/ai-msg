/** @cblabx auto-growth: read-only state projection, never call mutating GET /api/autopilot. */
import path from 'node:path';
import type { HubKpi, HubMode, HubSection, HubSource } from '../../shared/hub-types';
import { fmtKst, isObj, num, objs, scrub, showUnit, toIso, type HubDeps } from './shared';
import { YAPPING_READ_SCRIPT } from './yapping-read';

export const YAPPING_UNITS = { service: 'yapping-bot.service' } as const;
const CACHE_MS = 30_000;
const FOLLOWER_STALE_MS = 45 * 60_000;
const cache = new WeakMap<HubDeps, { at: number; data: Record<string, unknown> }>();
const pending = new WeakMap<HubDeps, Promise<Record<string, unknown> | null>>();
const obj = (v: unknown): Record<string, unknown> => isObj(v) ? v : {};
const nonnegative = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? n : null; };
const dateKst = (ms: number): string => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
const publicId = (v: unknown): string | null => typeof v === 'string' && /^\d+$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
const clean = (v: unknown, max = 160): string => scrub(v, max).replace(/\s+/g, ' ').trim();

async function read(deps: HubDeps): Promise<Record<string, unknown> | null> {
  let task = pending.get(deps);
  if (!task) {
    task = (async () => {
      try {
        const raw = await deps.exec?.('python3', ['-c', YAPPING_READ_SCRIPT, path.join(deps.home, 'yapping-bot'), String(deps.now())], { timeoutMs: 1800 });
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return isObj(parsed) ? parsed : null;
      } catch { return null; }
    })();
    pending.set(deps, task);
  }
  try { return await task; } finally { pending.delete(deps); }
}

export async function collectYapping(deps: HubDeps): Promise<HubMode> {
  const now = deps.now();
  const saved = cache.get(deps);
  const freshCache = !!saved && now - saved.at < CACHE_MS;
  const [readData, service] = await Promise.all([freshCache ? Promise.resolve(saved.data) : read(deps), showUnit(deps, YAPPING_UNITS.service)]);
  if (readData && !freshCache && toIso(readData.at) && isObj(readData.plan) && isObj(readData.caps) && (!Array.isArray(readData.errors) || readData.errors.length === 0)) cache.set(deps, { at: now, data: readData });
  // Retain a known good projection after transport failure; its original timestamp remains visible.
  const data = readData ?? saved?.data ?? {};
  const stale = readData === null && !!saved;
  const at = toIso(data.at);
  const plan = obj(data.plan), caps = obj(data.caps), followers = obj(data.followers);
  const day = dateKst(now - 3 * 3_600_000);
  const planCurrent = plan.day === day;
  const errors = Array.isArray(data.errors) ? data.errors.filter((x): x is string => typeof x === 'string').map((s) => clean(s, 30)) : [];
  const sources: HubSource[] = [
    { name: '자동 성장 기록', ok: !!readData && !!at && isObj(data.plan) && isObj(data.caps) && !errors.length, ms: 0, ...(!readData || !at || !isObj(data.plan) || !isObj(data.caps) || errors.length ? { error: !readData ? '로컬 상태 읽기 실패' : errors.length ? errors.join(' · ') : '운영 기록 없음' } : {}) },
    { name: 'systemd', ok: service.active === 'active', ms: 0, ...(service.active !== 'active' ? { error: service.active === 'missing' ? '서비스 확인 불가' : '서비스 정지' } : {}) },
  ];
  const known = (name: string, n: number | null, cap: number | null, hint: string): HubKpi => ({ label: name, value: n === null || cap === null ? '데이터 없음' : `${n} / ${cap}`, status: stale ? 'info' : n !== null && cap !== null && n > cap ? 'warn' : 'info', hint: `${stale ? `마지막 정상 ${fmtKst(at)} · ` : ''}${cap === null ? '운영 한도 설정을 읽을 수 없음' : n === null && !hint.includes('기록') ? '완료 기록을 읽을 수 없음' : hint}` });
  const laneHint = planCurrent ? `운영일 ${day} · 완료+예약` : '오늘 레인 계획이 아직 기록되지 않음';
  const total = planCurrent && nonnegative(plan.posted) !== null && nonnegative(plan.reserved) !== null ? Number(plan.posted) + Number(plan.reserved) : null;
  const kpis: HubKpi[] = [
    known('속보', planCurrent ? nonnegative(plan.breaking) : null, nonnegative(caps.breaking), laneHint),
    known('리포트', planCurrent ? nonnegative(plan.report) : null, nonnegative(caps.report), laneHint),
    known('전체 게시', total, nonnegative(caps.total), planCurrent ? `완료 ${plan.posted} · 예약 ${plan.reserved} (일반 QT 포함)` : laneHint),
    known('답글', at !== null && dateKst(Date.parse(at)) === dateKst(now) ? nonnegative(data.replies) : null, nonnegative(caps.replies), `오늘 ${dateKst(now)} · 자정 기준`),
  ];
  const fAt = toIso(followers.at), f = nonnegative(followers.followers), delta = num(followers.delta_since_last_run);
  const fStale = stale || !fAt || now - Date.parse(fAt) > FOLLOWER_STALE_MS;
  kpis.push({ label: '팔로워 변화', value: delta === null ? '데이터 없음' : `${delta > 0 ? '+' : ''}${delta}`, status: 'info', hint: f === null ? '팔로워 비교 관측값 없음' : `${f.toLocaleString('ko-KR')}명 · 직전 수집 대비 · ${fStale ? '마지막 관측 ' : ''}${fmtKst(fAt)}` });
  kpis.push({ label: '조회수 변화', value: '데이터 없음', status: 'info', hint: '조회수 과거 관측 이력이 없어 증감 비교 불가' });
  // Stale markers are encoded in existing hints, so older hub clients also show the timestamp.
  if (fStale && delta !== null) kpis[4]!.hint = `마지막 정상 ${fmtKst(fAt)} · ${f?.toLocaleString('ko-KR') ?? '데이터 없음'}명 · 직전 수집 대비`;
  const posts = objs(data.posts).filter((p) => publicId(p.tweet_id) !== null).slice(0, 3);
  const channel = typeof data.channel === 'string' && /^[A-Za-z][A-Za-z0-9_]{3,}$/.test(data.channel) ? data.channel : null;
  const mirrors = objs(data.mirrors).filter((p) => publicId(p.tg_message_id) !== null).slice(0, 3);
  const sections: HubSection[] = [
    { kind: 'table', title: 'X 최근 게시', open: true, columns: ['시각', '게시물', '링크'], rows: posts.map((p) => [toIso(p.posted_at) ?? '', clean(p.text, 180), `https://x.com/cblabx/status/${p.tweet_id}`]), note: posts.length ? '@cblabx 최근 3건' : '데이터 없음 · 게시 완료 기록을 읽을 수 없음' },
    { kind: 'table', title: 'Telegram 미러', open: true, columns: ['시각', '게시물', '링크'], rows: channel ? mirrors.map((p) => [toIso(p.tg_posted_at) ?? '', clean(p.headline, 180), `https://t.me/${channel}/${p.tg_message_id}`]) : [], note: channel && mirrors.length ? `@${channel} 최근 3건` : '데이터 없음 · 공개 채널 또는 미러 게시 기록 없음' },
    { kind: 'kv', title: '소스 상태', open: false, rows: [['수집 방식', '로컬 운영 기록 · 읽기 전용'], ['기록 조회', at ? fmtKst(at) : '데이터 없음'], ['게시 운영일', `${day} (03:00 KST 초기화)`], ['답글 운영일', `${dateKst(now)} (00:00 KST 초기화)`], ['API', '동시 조회 6~8초 지연 확인 · 로컬 기록으로 조회'], ['조회수 이력', '현재 누적값만 저장됨 · 시점별 관측 API 필요']] },
  ];
  const alerts = service.active !== 'active' && service.active !== 'missing' ? [{ level: 'bad' as const, text: '야핑봇 서비스 정지' }] : [];
  if (total !== null && nonnegative(caps.total) !== null && total > Number(caps.total)) alerts.push({ level: 'bad', text: `전체 게시 ${total}건 · 현재 한도 ${caps.total}건 초과` });
  const state = service.active !== 'active' && service.active !== 'missing' ? 'down' : !at ? 'unknown' : stale || errors.length || !planCurrent || alerts.length ? 'warn' : 'ok';
  return { id: 'yapping', name: '야핑봇', state, tag: '자동 성장', lastActivity: toIso(posts[0]?.posted_at), metrics: { '전체 게시': kpis[2]!.value, '답글': kpis[3]!.value, '팔로워 변화': delta }, alerts, links: [{ label: '@cblabx', href: 'https://x.com/cblabx' }], sources, page: { headline: '@cblabx 자동 성장', decision: '속보 · 리포트 · 답글 운영 현황', kpis, sections } };
}
