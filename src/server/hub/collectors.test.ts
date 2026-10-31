import { describe, expect, it } from 'vitest';
import type { HubSection } from '../../shared/hub-types';
import { fmtVal } from './quant';
import { HUB_URLS, fmtKst, parseSystemdTime, scrub, unitInfo, type HubDeps } from './shared';
import { collectVideo, parseBacklogNow, parseProjectYaml } from './studios';

const NOW = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST
const HOME = '/Users/alice';
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

interface Fx { urls?: Partial<Record<keyof typeof HUB_URLS, unknown>>; files?: Record<string, string>; dirs?: Record<string, string[]>; mtimes?: Record<string, number>; units?: Record<string, Record<string, string>>; render?: { mtimeMs: number; name: string } | null }

/** Deps over an in-memory filesystem (paths relative to HOME), canned URLs and canned systemd units. */
function deps(fx: Fx): HubDeps {
  const byUrl = new Map<string, unknown>(Object.entries(HUB_URLS).map(([k, url]) => [url, fx.urls?.[k as keyof typeof HUB_URLS]]));
  const rel = (p: string): string => p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p;
  return {
    fetchJson: async (url) => { const a = byUrl.get(url); if (a instanceof Error) throw a; if (a === undefined) throw new Error('fetch failed: ECONNREFUSED'); return a; },
    latestRender: async () => fx.render ?? null,
    countEntries: async (d) => fx.dirs?.[rel(d)]?.length ?? null,
    gitLastCommit: async () => null,
    readText: async (f) => fx.files?.[rel(f)] ?? null,
    readTail: async (f) => fx.files?.[rel(f)] ?? null,
    listDir: async (d) => fx.dirs?.[rel(d)] ?? null,
    fileMtime: async (f) => fx.mtimes?.[rel(f)] ?? null,
    systemdShow: async (u) => fx.units?.[u] ?? (fx.units ? { LoadState: 'not-found', ActiveState: 'inactive' } : null),
    now: () => NOW, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
  };
}
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));
const noHome = (v: unknown): void => { expect(JSON.stringify(v)).not.toContain(HOME); expect(JSON.stringify(v)).not.toMatch(/\/home\/[a-z]/); };

/* ───────── shared ───────── */

describe('shared helpers', () => {
  it('parses systemd timestamps in UTC and KST and formats Seoul clock times', () => {
    expect(parseSystemdTime('Fri 2026-10-30 12:49:15 UTC')).toBe('2026-10-30T12:49:15.000Z');
    expect(parseSystemdTime('Fri 2026-10-30 22:05:14 KST')).toBe('2026-10-30T13:05:14.000Z');
    expect(parseSystemdTime('')).toBeNull();
    expect(parseSystemdTime('n/a')).toBeNull();
    expect(fmtKst('2026-10-30T12:49:15Z')).toBe('10-30 21:49');
    expect(fmtKst(null)).toBe('—');
  });
  it('unitInfo reads state, restarts, since and the next timer run (falling back to TimersCalendar)', () => {
    const u = unitInfo('x.timer', { LoadState: 'loaded', ActiveState: 'active', SubState: 'running', NRestarts: '2', ActiveEnterTimestamp: 'Fri 2026-10-30 12:49:15 UTC', NextElapseUSecRealtime: '', TimersCalendar: '{ OnCalendar=*-*-* *:05,35:00 ; next_elapse=Fri 2026-10-30 13:05:00 UTC }', LastTriggerUSec: 'Fri 2026-10-30 21:35:14 KST', Result: 'success' });
    expect(u).toMatchObject({ active: 'active', restarts: 2, since: '2026-10-30T12:49:15.000Z', nextRun: '2026-10-30T13:05:00.000Z', lastRun: '2026-10-30T12:35:14.000Z', result: 'success' });
    expect(unitInfo('nope.service', { LoadState: 'not-found', ActiveState: 'inactive' }).active).toBe('missing');
    expect(unitInfo('nope.service', null).active).toBe('missing');
    expect(unitInfo('f.service', { ActiveState: 'failed', SubState: 'failed' }).active).toBe('failed');
  });
  it('scrub blanks home paths and bounds length', () => {
    expect(scrub('see /home/max/quant/results/x.txt and /Users/alice/y.md now')).toBe('see … and … now');
    expect(scrub('a'.repeat(300), 10)).toHaveLength(10);
    expect(scrub(42)).toBe('');
  });
});

/* ───────── studios (collector behaviour: studios.test.ts) ───────── */

const PROJECT_YAML = 'project:\n  name: "공학쇼츠 자동화"\n  status: pilot_storyboard\npublication:\n  auto_publish: false\n  human_approval_required: true\n';
const BACKLOG = '# Backlog\n\n## Now\n- [x] 파이프라인 골격\n- [x] 첫 렌더\n- [ ] Typecast API 키·Voice ID 연결 후 실제 한국어 내레이션 생성\n- [ ] JSON Schema 작성\n\n## Next\n- [ ] 다른 것\n';

describe('영상 스튜디오 collector', () => {
  it('parses the backlog Now block and project.yaml', () => {
    expect(parseBacklogNow(BACKLOG)).toMatchObject({ checked: 2, total: 4 });
    expect(parseBacklogNow(BACKLOG).items[2]).toEqual({ text: 'Typecast API 키·Voice ID 연결 후 실제 한국어 내레이션 생성', done: false });
    expect(parseBacklogNow(null)).toEqual({ checked: 0, total: 0, items: [] });
    expect(parseProjectYaml(PROJECT_YAML)).toEqual({ status: 'pilot_storyboard', name: '공학쇼츠 자동화', autoPublish: false, approval: true });
  });
  it('is unknown with a "폴더 없음" source when nothing is readable', async () => {
    const m = await collectVideo(deps({}));
    expect(m).toMatchObject({ state: 'unknown', sources: [{ ok: false, error: '폴더 없음' }] });
    expect(m.page!.headline).toBe('프로젝트 폴더 없음');
  });
});

describe('QUANT helpers', () => {
  it('formats tile values by their declared format', () => {
    expect(fmtVal(8377335079, 'krw')).toBe('83.77억');
    expect(fmtVal(203661, 'krw')).toBe('203,661원');
    expect(fmtVal(7.03, 'pct')).toBe('7.03%');
    expect(fmtVal(-1.39, 'bp')).toBe('-1.39 bp');
    expect(fmtVal(3988.5, 'ms')).toBe('3,989 ms');
    expect(fmtVal(null, 'bp')).toBe('—');
    expect(fmtVal('NO-GO', 'str')).toBe('NO-GO');
  });
});
