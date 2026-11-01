import { describe, expect, it } from 'vitest';
import { buildCalendar, buildShortsView, collectShorts, kstTomorrow, ledgerStatusOf, normalizeLedgerStatusLabel, parseChannels, parseClaudePick, parseCodex, parseDf, parseDistribution, parseHistory, parseLedger, parseStatus, redact } from './shorts';
import { stripSecrets, type HubDeps } from './shared';
import { CH1, CH2, CH3, CHANNELS, DIST, HISTORY, HOME, LEDGER, NOW, NO_PROBES, PLACEHOLDER, PROBES_OK, STATUS } from './__fixtures__/shorts';

const j = (v: unknown): string => JSON.stringify(v);
const view = (o: { status?: unknown; channels?: unknown; history?: string | null; probes?: typeof PROBES_OK | typeof NO_PROBES; now?: number } = {}) =>
  buildShortsView({ status: o.status === undefined ? null : typeof o.status === 'string' ? o.status : j(o.status), channels: o.channels === undefined ? null : typeof o.channels === 'string' ? o.channels : j(o.channels), history: o.history ?? null, probes: o.probes ?? PROBES_OK, probeNote: null }, o.now ?? NOW);
const texts = (v: { alerts: { text: string }[] }): string[] => v.alerts.map((a) => a.text);
const kpiOf = (v: { kpis: { label: string; value: string; unit?: string; status?: string; hint?: string }[] }, label: string) => v.kpis.find((k) => k.label === label)!;

describe('Shorts 공장 · files', () => {
  it('with nothing on disk says so everywhere: unknown state, no counts, no healthy tile, and no per-channel tomorrow alerts', () => {
    const v = view({ probes: NO_PROBES });
    expect(v.state).toBe('unknown');
    expect(v.files.status).toMatchObject({ state: 'missing', note: '파일 없음' });
    expect(v.files.channels.state).toBe('missing');
    expect(v.files.history).toMatchObject({ state: 'missing', rows: 0 });
    expect(v.channels).toEqual([]);
    expect(v.liveCount).toBe(0);
    expect(kpiOf(v, '개설 채널')).toMatchObject({ value: '—', unit: '/20', status: 'warn' });
    expect(kpiOf(v, '구독자 합').value).toBe('미공개');
    expect(kpiOf(v, '루틴')).toMatchObject({ value: '미보고', status: 'warn' });
    expect(kpiOf(v, '대기열')).toMatchObject({ value: '미보고', status: 'warn' });
    expect(kpiOf(v, '디스크 /')).toMatchObject({ value: '측정 불가', status: 'warn' });
    expect(kpiOf(v, 'Claude')).toMatchObject({ value: '확인 불가', status: 'warn' });
    expect(kpiOf(v, 'Codex')).toMatchObject({ value: '확인 불가', status: 'warn' });
    expect(v.kpis.every((k) => k.status !== 'ok')).toBe(true);
    expect(texts(v)).toEqual(expect.arrayContaining(['status.json 없음', 'channels.json 없음', '디스크 사용률 측정 불가 · exec 없음', 'Claude 확인 불가 · exec 없음', 'Codex 확인 불가 · exec 없음']));
    expect(texts(v).some((t) => t.includes('예약'))).toBe(false);
    expect(v.calendar.unavailable).toBe('status.json 없음');
    expect(v.calendar.days).toHaveLength(14);
    expect(v.calendar.days[0]).toMatchObject({ date: '2026-10-26', dow: '월' });
    expect(v.calendar.days.find((d) => d.today)?.date).toBe('2026-11-01');
    expect(v.calendar.days.find((d) => d.tomorrow)?.date).toBe('2026-11-02');
    expect(v.decision).toBe('루틴이 status.json 을 쓰게 한다');
  });
  it('the bootstrap placeholder is never healthy: 미보고 routine, one 확인 불가 alert for tomorrow (not one per channel)', () => {
    const v = view({ status: PLACEHOLDER, channels: CHANNELS });
    expect(v.files.status).toMatchObject({ state: 'placeholder', note: '자리표시자 · 루틴이 아직 쓰지 않음' });
    expect(v.state).toBe('warn');
    expect(texts(v)).toContain('루틴 상태 미보고 · status.json 자리표시자');
    expect(texts(v)).toContain('내일(11-02) 예약 확인 불가 · 자리표시자 · 예약 정보 없음');
    expect(texts(v).filter((t) => t.includes('예약'))).toHaveLength(1);
    expect(v.calendar.unavailable).toBe('자리표시자 · 예약 정보 없음');
    expect(kpiOf(v, '루틴')).toMatchObject({ value: '미보고', status: 'warn', hint: '실행 기록 없음' });
    expect(v.pipeline.routine.status).toBe('unknown');
  });
  it('reads a full status + channels + history: counts stay null when YouTube hides them, failures keep the previous data, sparklines come from history', () => {
    const v = view({ status: STATUS, channels: CHANNELS, history: HISTORY });
    expect(v.files.status.state).toBe('fresh');
    expect(v.files.channels.state).toBe('fresh');
    expect(v.files.history).toMatchObject({ rows: 5, skipped: 2 });
    expect(v.channels.map((c) => c.id)).toEqual([CH1, CH2, CH3]); // the id-less entry is dropped
    expect(v.liveCount).toBe(2); // 썰 한 스푼 has no platforms block → unknown, not live
    expect(v.channels[2]!.platforms).toEqual({ youtube: 'unknown', tiktok: 'unknown', instagram: 'unknown', x: 'unknown', other: 'unknown' });
    expect(v.channels[0]).toMatchObject({ name: '궁금한 1분', publishKst: '18:00', subscribers: null, totalViews: null, videoCount: 12, latestViews: 545, spark: { label: '최신 영상 조회', values: [300, 400, 545] }, collection: { error: null, stale: false } });
    expect(v.channels[1]).toMatchObject({ subscribers: 1200, latestViews: 1157, spark: null, collection: { stale: true, lastSuccessAt: '2026-10-30T10:41:00.000Z' } });
    expect(v.channels[1]!.collection.error).toBe('yt-dlp timeout after 60s (…)');
    expect(kpiOf(v, '개설 채널')).toMatchObject({ value: '2', unit: '/20', status: 'ok' });
    expect(kpiOf(v, '구독자 합')).toMatchObject({ value: '1,200', hint: '1/3 채널 공개' });
    expect(kpiOf(v, '총 조회 합')).toMatchObject({ value: '미공개', status: 'info' });
    expect(kpiOf(v, '최신 영상 조회 합')).toMatchObject({ value: '1,702', hint: '2/3 채널 · 채널당 최신 1편' });
    expect(kpiOf(v, '루틴')).toMatchObject({ value: '정상', status: 'ok', hint: '10분 전 실행' });
    expect(kpiOf(v, '대기열')).toMatchObject({ value: '3' });
    expect(kpiOf(v, '디스크 /')).toMatchObject({ value: '91', unit: '%', status: 'warn' });
    expect(kpiOf(v, 'Claude')).toMatchObject({ value: '계정 b', status: 'ok', hint: '계정 b 선택 · 후보 2/3' });
    expect(kpiOf(v, 'Codex')).toMatchObject({ value: 'codex-cli 0.159.2', status: 'ok' });
    expect(v.pipeline.lastRender).toEqual({ file: 'ep-041.mp4', at: '2026-11-01T10:54:00.000Z' });
    expect(v.pipeline.routine.logTail[1]).toBe('[19:54:00] wrote …');
    expect(v.pipeline.gateFailures).toEqual(['caption-length · ep-040 caption 2.1s over']);
    expect(v.notes).toEqual(['TikTok 계정 신청 대기']);
    expect(v.unmappedReference).toEqual([{ at: '2026-11-01T10:00:00.000Z', videoId: 'VFfjBXHu6Oo', views: 431 }]);
    expect(JSON.stringify(v)).not.toContain(HOME);
    expect(stripSecrets(v)).toEqual(v); // no field name the secret filter would drop
  });
  it('alerts: a channel with no scheduled upload tomorrow (KST), a failed collection, gate failures; the worst leads', () => {
    const v = view({ status: STATUS, channels: CHANNELS, history: HISTORY });
    expect(v.state).toBe('warn');
    expect(texts(v)).toContain('썰 한 스푼 내일(11-02) 예약 없음');
    expect(v.alerts.find((a) => a.text.includes('썰 한 스푼 내일'))?.hint).toBe('계획 20:00 KST');
    expect(texts(v).some((t) => t.startsWith('궁금한 1분 내일') || t.startsWith('Curious Minute 내일'))).toBe(false);
    expect(v.alerts.find((a) => a.text === 'Curious Minute 수집 실패 · 이전 값 유지')).toMatchObject({ level: 'warn', at: '2026-11-01T10:41:00.000Z' });
    expect(texts(v)).toContain('게이트 실패 1건');
    expect(texts(v)).toContain('history.jsonl 깨진 줄 2개 건너뜀');
    expect(texts(v)).toContain('참고 관측 1건 채널 미지정');
    expect(v.alerts.map((a) => a.level)).toEqual([...v.alerts.map((a) => a.level)].sort((a, b) => ({ bad: 0, warn: 1, info: 2 })[a] - ({ bad: 0, warn: 1, info: 2 })[b]));
    expect(v.headline).toBe(v.alerts[0]!.text);
    const ok = view({ status: { ...STATUS, gate_failures: [], scheduled: [...STATUS.scheduled, { channel_id: CH3, video_id: 'x', title: 't', publish_at: '2026-11-02T20:00:00+09:00' }] }, channels: { ...CHANNELS, channels: CHANNELS.channels.slice(0, 1) }, history: HISTORY });
    expect(ok.state).toBe('ok');
    expect(ok.headline).toBe('채널 1/20 개설 · 내일 예약 1/1');
    expect(ok.decision).toBe('조치 없음');
  });
  it('a failed routine and a disk over 95% are bad; a stuck running routine, stale files and malformed input are warnings', () => {
    const failed = view({ status: { ...STATUS, routine: { ...STATUS.routine, status: 'failed' } }, channels: CHANNELS, probes: { ...PROBES_OK, disk: parseDf('x 1 1 1 97% /') } });
    expect(failed.state).toBe('down');
    expect(failed.alerts.slice(0, 2).map((a) => a.text)).toEqual(['루틴 실패', '디스크 97% · 95% 초과']);
    expect(failed.alerts[0]).toMatchObject({ at: '2026-11-01T10:50:00.000Z', hint: '[19:54:50] upload queued' });
    expect(kpiOf(failed, '루틴')).toMatchObject({ value: '실패', status: 'bad' });
    expect(kpiOf(failed, '디스크 /')).toMatchObject({ value: '97', status: 'bad' });
    const stuck = view({ status: { ...STATUS, routine: { ...STATUS.routine, status: 'running', last_run_at: '2026-11-01T10:00:00+09:00' } }, channels: CHANNELS });
    expect(texts(stuck)).toContain('루틴 실행 중 표시가 6시간 넘게 그대로');
    const fine = view({ status: { ...STATUS, routine: { ...STATUS.routine, status: 'running' } }, channels: CHANNELS });
    expect(texts(fine).some((t) => t.includes('실행 중'))).toBe(false);
    const stale = view({ status: { ...STATUS, generated_at: '2026-11-01T12:30:00+09:00' }, channels: { ...CHANNELS, generated_at: '2026-11-01T11:00:00+09:00' } });
    expect(stale.files.status).toMatchObject({ state: 'stale', note: '7시간 30분 전 기록' });
    expect(stale.files.channels.state).toBe('stale');
    expect(texts(stale)).toEqual(expect.arrayContaining(['status.json 오래됨', 'channels.json 오래됨']));
    expect(kpiOf(stale, '개설 채널')).toMatchObject({ status: 'warn', hint: 'channels.json 오래됨' });
    const bad = view({ status: '{nope', channels: '[1,2]' });
    expect(bad.files.status).toMatchObject({ state: 'malformed' });
    expect(bad.files.status.note).toMatch(/^JSON 해석 실패/);
    expect(bad.files.channels).toMatchObject({ state: 'malformed', note: '객체가 아님' });
    expect(texts(bad)).toEqual(expect.arrayContaining(['status.json 형식 오류', 'channels.json 형식 오류']));
    expect(bad.calendar.unavailable).toBe('status.json 형식 오류');
    const odd = view({ status: { routine: { status: 'weird' }, queue_depth: -1, scheduled: 'nope', gate_failures: ['plain text', 7] }, channels: CHANNELS });
    expect(odd.files.status).toMatchObject({ state: 'malformed', note: 'generated_at 없음 또는 형식 오류' });
    expect(odd.pipeline).toMatchObject({ routine: { status: 'invalid', logTail: [] }, queueDepth: null, gateFailures: ['plain text'] });
    expect(texts(odd)).toContain('routine.status 형식 오류');
  });
  it('parsers alone: status rows need a channel and a time, history keeps only known sources, channels bound their videos', () => {
    const st = parseStatus(j({ generated_at: '2026-11-01T19:55:00+09:00', scheduled: [{ channel_id: CH1 }, { video_id: 'v', publish_at: '2026-11-02T18:00:00+09:00' }, { channel_id: CH1, publish_at: 'not a time' }, { channel_id: CH1, publish_at: '2026-11-02T18:00:00+09:00' }] }), NOW);
    expect(st.raw?.scheduled).toHaveLength(1);
    expect(st.raw?.placeholder).toBe(true); // no routine.status at all → unknown → placeholder
    expect(st.file.state).toBe('placeholder');
    expect(parseHistory('').rows).toEqual([]);
    expect(parseHistory(null)).toEqual({ rows: [], skipped: 0 });
    const h = parseHistory(HISTORY);
    expect(h.rows.map((r) => r.source)).toEqual(['collector', 'collector', 'user_reference', 'user_reference', 'collector']); // sorted by time
    const ch = parseChannels(j({ generated_at: '2026-11-01T19:40:00+09:00', channels: [{ id: CH1, videos: Array.from({ length: 30 }, (_, i) => ({ id: `v${i}`, views: i })), platforms: { youtube: { status: 'LIVE' } } }] }), NOW);
    expect(ch.raw?.channels[0]?.videos).toHaveLength(10);
    expect(ch.raw?.channels[0]?.platforms.youtube).toBe('unknown'); // case matters: not a known status
    expect(ch.raw?.plannedTotal).toBe(20);
    expect(kstTomorrow(Date.parse('2026-11-01T14:59:00Z'))).toBe('2026-11-02'); // 23:59 KST
    expect(kstTomorrow(Date.parse('2026-11-01T15:00:00Z'))).toBe('2026-11-03'); // 00:00 KST next day
  });
  it('calendar: scheduled and published land on their KST day in time order; days outside the two weeks are ignored', () => {
    const st = parseStatus(j({ ...STATUS, scheduled: [...STATUS.scheduled, { channel_id: CH1, video_id: 'far', publish_at: '2026-12-01T18:00:00+09:00' }, { channel_id: CH2, video_id: 'late', publish_at: '2026-11-01T23:30:00+09:00' }, { channel_id: CH2, video_id: 'utc', publish_at: '2026-11-01T15:30:00Z' }] }), NOW);
    const cal = buildCalendar(st.raw, st.file, parseChannels(j(CHANNELS), NOW).raw!.channels, NOW);
    expect(cal.unavailable).toBeNull();
    const d = Object.fromEntries(cal.days.map((x) => [x.date, x.items.map((i) => `${i.kind} ${i.time} ${i.channelName}`)]));
    expect(d['2026-11-01']).toEqual(['published 18:00 궁금한 1분', 'scheduled 23:30 Curious Minute']);
    expect(d['2026-11-02']).toEqual(['scheduled 00:30 Curious Minute', 'scheduled 09:00 Curious Minute', 'scheduled 18:00 궁금한 1분']); // 15:30Z is 00:30 KST next day
    expect(d['2026-11-05']).toEqual(['scheduled 18:00 궁금한 1분']);
    expect(cal.days.flatMap((x) => x.items).some((i) => i.videoId === 'far')).toBe(false);
    expect(cal.days.map((x) => x.dow).join('')).toBe('월화수목금토일월화수목금토일');
  });
});

describe('Shorts 공장 · redaction', () => {
  it('credential-looking values inside log_tail, gate details and notes are blanked, the key names stay', () => {
    const v = view({ status: { ...STATUS, routine: { ...STATUS.routine, log_tail: ['curl -H "Authorization: Bearer abcDEF123456" api', 'token=t0k3n-EXAMPLE-value ok', 'api_key: "AIzaSyEXAMPLEEXAMPLEEXAMPLEEXAMPLE1234" loaded', 'YT_KEY=sk-EXAMPLE1234567890 cookie=abc123def; done'] }, gate_failures: [{ gate: 'auth', detail: 'password=hunter2 rejected' }], notes: ['secret: s3cr3t-EXAMPLE'] } });
    const dump = JSON.stringify(v);
    for (const leak of ['abcDEF123456', 't0k3n', 'AIzaSy', 'sk-EXAMPLE', 'abc123def', 'hunter2', 's3cr3t']) expect(dump).not.toContain(leak);
    expect(v.pipeline.routine.logTail).toEqual(['curl -H "Authorization: …" api', 'token=… ok', 'api_key: … loaded', 'YT_KEY=… cookie=… done']);
    expect(v.pipeline.gateFailures).toEqual(['auth · password=… rejected']);
    expect(v.notes).toEqual(['secret: …']);
  });
  it('a recognized claude-pick verdict carrying a token still comes out without it', () => {
    const c = parseClaudePick('claude-pick: 후보 b: 주간 31% token=sk-EXAMPLE-abcdefgh · 점수 0.4\nb\nclaude-pick-exit=0\n');
    expect(c.accounts[0]?.detail).toBe('주간 31% token=… · 점수 0.4');
    expect(JSON.stringify(c)).not.toContain('EXAMPLE');
    expect(redact('plain words with no secrets 12345')).toBe('plain words with no secrets 12345');
  });
  it('a malformed status.json gets a constant label, never the parser message with its source snippet', () => {
    const bad = view({ status: '{"routine": {"secret": "s3cr3t-EXAMPLE"} oops' });
    expect(bad.files.status.note).toBe('JSON 해석 실패');
    expect(JSON.stringify(bad)).not.toContain('s3cr3t');
  });
});

describe('Shorts 공장 · gate failures are a report, not an inference', () => {
  it('no gate_failures array → null + 미보고 alert; placeholder/missing status → null without the extra alert; [] → none', () => {
    const { gate_failures: _g, ...noGates } = STATUS;
    const v = view({ status: noGates, channels: CHANNELS });
    expect(v.pipeline.gateFailures).toBeNull();
    expect(texts(v)).toContain('게이트 실패 미보고');
    const ph = view({ status: PLACEHOLDER, channels: CHANNELS });
    expect(ph.pipeline.gateFailures).toBeNull();
    expect(texts(ph)).not.toContain('게이트 실패 미보고');
    expect(view({ probes: NO_PROBES }).pipeline.gateFailures).toBeNull();
    expect(view({ status: { ...STATUS, gate_failures: [] }, channels: CHANNELS }).pipeline.gateFailures).toEqual([]);
    expect(view({ status: { ...STATUS, gate_failures: 'none' }, channels: CHANNELS }).pipeline.gateFailures).toBeNull();
  });
});

describe('Shorts 공장 · host probes', () => {
  it('claude-pick: only verdict lines and the picked account survive; URLs, deck JSON and anything else are dropped', () => {
    const ok = parseClaudePick('{"accounts":{"a":{"token":"sk-EXAMPLE"}}}\nclaude-pick: 제외 a: 보호 계정\nclaude-pick: 후보 b: 주간 31% · 리셋 52h · 점수 0.41\nb\nclaude-pick-exit=0\n');
    expect(ok).toEqual({ state: 'ok', summary: '계정 b 선택 · 후보 1/2', picked: 'b', accounts: [{ id: 'a', verdict: 'excluded', detail: '보호 계정' }, { id: 'b', verdict: 'candidate', detail: '주간 31% · 리셋 52h · 점수 0.41' }] });
    expect(JSON.stringify(ok)).not.toMatch(/token|sk-/);
    expect(parseClaudePick('claude-pick: 제외 a: 주간 97%\nclaude-pick: 제외 b: stale 20분\nclaude-pick: 자격 있는 계정 없음 → 최소 사용 b\nb\nclaude-pick-exit=3\n')).toMatchObject({ state: 'warn', summary: '자격 있는 계정 없음 · 최소 사용 b · 후보 0/2', picked: null });
    const down = parseClaudePick('claude-pick: 대시보드 조회 실패(http://127.0.0.1:9310/api/state) → 대체 계정 b\nb\nclaude-pick-exit=4\n');
    expect(down).toMatchObject({ state: 'warn', summary: '대시보드 조회 실패 · 대체 b', picked: null, accounts: [] });
    expect(JSON.stringify(down)).not.toContain('127.0.0.1');
    expect(parseClaudePick('claude-pick: 알 수 없는 옵션 --x\nclaude-pick-exit=2\n')).toMatchObject({ state: 'warn', summary: '알 수 없는 옵션 --x' });
    expect(parseClaudePick('garbage only\n')).toMatchObject({ state: 'unknown', summary: '응답 해석 불가', picked: null });
    expect(parseClaudePick(null)).toMatchObject({ state: 'unknown', summary: 'claude-pick 실행 불가' });
  });
  it('df and codex', () => {
    expect(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme1n1p2 1920641288 1648242724 174761600 91% /\n')).toEqual({ usedPct: 91, note: null });
    expect(parseDf('nothing useful')).toEqual({ usedPct: null, note: 'df 출력 해석 실패' });
    expect(parseDf(null)).toEqual({ usedPct: null, note: 'df 실행 실패' });
    expect(parseCodex('codex-cli 0.159.2\n')).toEqual({ available: true, version: 'codex-cli 0.159.2', note: null });
    expect(parseCodex(null)).toMatchObject({ available: false, version: null });
    expect(parseCodex('')).toMatchObject({ available: true, version: null });
  });
  it('collectShorts reads the three files under ~/shorts_status, runs the probes with fixed argv once a minute, and ships no home path', async () => {
    const calls: string[][] = []; let clock = NOW;
    const files: Record<string, string> = { 'shorts_status/status.json': j(STATUS), 'shorts_status/channels.json': j(CHANNELS), 'shorts_status/history.jsonl': HISTORY, 'shorts_status/reference_ledger.json': j(LEDGER) };
    const rel = (p: string) => (p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p);
    const deps: HubDeps = {
      fetchJson: async () => { throw new Error('offline'); }, latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null,
      readText: async (f) => files[rel(f)] ?? null, readTail: async (f, max) => { expect(max).toBe(512 * 1024); return files[rel(f)] ?? null; }, listDir: async () => null, fileMtime: async () => null, systemdShow: async () => null,
      exec: async (cmd, args) => { calls.push([cmd, ...args]); return cmd === 'df' ? '/dev/x 1 1 1 91% /\n' : cmd === 'bash' ? 'claude-pick: 후보 b: 주간 31% · 리셋 52h · 점수 0.41\nb\nclaude-pick-exit=0\n' : 'codex-cli 0.159.2\n'; },
      now: () => clock, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
    };
    const v = await collectShorts(deps);
    expect(calls).toEqual([['df', '-P', '/'], ['bash', '-c', 'claude-pick --verbose 2>&1; echo "claude-pick-exit=$?"'], ['codex', '--version']]);
    expect(v.pipeline.disk.usedPct).toBe(91);
    expect(v.pipeline.claude.picked).toBe('b');
    expect(v.pipeline.codex.version).toBe('codex-cli 0.159.2');
    expect(v.channels).toHaveLength(3);
    expect(v.ledger.file.state).toBe('fresh');
    expect(v.ledger.total).toBe(6);
    expect(v.alerts.some((a) => a.text.includes('호스트 점검'))).toBe(false);
    expect(JSON.stringify(v)).not.toContain(HOME);
    clock += 30_000;
    await collectShorts(deps);
    expect(calls).toHaveLength(3); // cached
    clock += 60_000;
    await collectShorts(deps);
    expect(calls).toHaveLength(6);
  });
  it('a hub without exec still answers, with every probe marked 확인 불가 rather than healthy', async () => {
    const deps: HubDeps = { fetchJson: async () => { throw new Error('offline'); }, latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null, readText: async () => null, readTail: async () => null, listDir: async () => null, fileMtime: async () => null, systemdShow: async () => null, now: () => NOW, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME };
    const v = await collectShorts(deps);
    expect(v.pipeline.disk).toEqual({ usedPct: null, note: '측정 불가 · exec 없음' });
    expect(v.pipeline.claude.state).toBe('unknown');
    expect(v.pipeline.codex.available).toBeNull();
    expect(v.state).toBe('unknown');
  });
});

describe('Shorts 공장 · 적용 현황 (reference_ledger.json)', () => {
  it('normalizes the status label: en dash, hyphen and stray spaces all land in the same bucket; anything else is 미분류', () => {
    expect(normalizeLedgerStatusLabel('적용됨 – 운영 중')).toBe('적용됨-운영 중');
    expect(normalizeLedgerStatusLabel('적용됨 - 운영 중')).toBe('적용됨-운영 중');
    expect(normalizeLedgerStatusLabel('  적용됨–운영  중 ')).toBe('적용됨-운영 중');
    for (const v of ['적용됨 – 운영 중', '적용됨 - 운영 중', '적용됨-운영 중', '적용됨 — 운영 중']) expect(ledgerStatusOf(v)).toBe('applied');
    for (const v of ['구현됨 – 꺼짐', '구현됨 - 꺼짐']) expect(ledgerStatusOf(v)).toBe('built_off');
    expect(ledgerStatusOf('문서만')).toBe('docs_only');
    expect(ledgerStatusOf('검토 후 제외')).toBe('rejected');
    expect(ledgerStatusOf('미착수')).toBe('todo');
    for (const v of ['검토중', '적용됨', '', null, undefined, 3, 'applied']) expect(ledgerStatusOf(v)).toBe('unknown');
  });
  it('missing and malformed files are said so, with no items and zero counts', () => {
    const missing = parseLedger(null);
    expect(missing.file).toMatchObject({ name: 'reference_ledger.json', state: 'missing', note: '파일 없음' });
    expect(missing).toMatchObject({ items: [], total: 0, truncated: 0, skipped: 0 });
    expect(Object.values(missing.counts).every((n) => n === 0)).toBe(true);
    expect(parseLedger('{ not json').file).toMatchObject({ state: 'malformed', note: 'JSON 해석 실패' });
    expect(parseLedger('[1,2]').file).toMatchObject({ state: 'malformed', note: '객체가 아님' });
    expect(parseLedger(j({ generated_at: '2026-11-01T19:30:00+09:00' })).file).toMatchObject({ state: 'malformed', note: 'items 배열 없음' });
    expect(parseLedger(j({ generated_at: '2026-11-01T19:30:00+09:00', items: [] }))).toMatchObject({ file: { state: 'fresh', at: '2026-11-01T10:30:00.000Z' }, items: [], total: 0 });
  });
  it('reads the fixture: newest added first then newest updated, urls only when http(s), unknown type → other, id/title-less entries skipped, secrets and home paths scrubbed', () => {
    const l = parseLedger(j(LEDGER));
    expect(l.file).toMatchObject({ state: 'fresh', at: '2026-11-01T10:30:00.000Z' });
    expect(l.total).toBe(6); expect(l.skipped).toBe(1); expect(l.truncated).toBe(0);
    expect(l.items.map((i) => i.id)).toEqual(['ref-music', 'ref-caption-tool', 'ref-sub4sub', 'ref-thumb-post', 'ref-hook-3s', 'ref-odd']); // 11-01; then the three 10-25 by updated_at desc (null last); 10-20; 10-01
    expect(l.counts).toEqual({ applied: 1, built_off: 1, docs_only: 1, rejected: 1, todo: 1, unknown: 1 });
    expect(l.items[0]).toMatchObject({ title: '트렌드 음원 자동 매칭', url: 'https://example.com/music', type: 'video', status: 'todo', statusText: null, evidence: 'token=… in notes', nextAction: '음원 라이선스 확인', addedAt: '2026-11-01', updatedAt: null });
    expect(l.items[1]).toMatchObject({ status: 'built_off', statusReason: '한국어 정확도 미달', evidence: 'd4e5f6a · gates/caption.py · CAPTION_ALIGN=0', url: 'https://github.com/example/caps', type: 'tool' });
    expect(l.items[2]).toMatchObject({ status: 'rejected', statusReason: '정책 위반 위험', url: null, type: 'tip' });
    expect(l.items[3]).toMatchObject({ status: 'docs_only', url: null, type: 'post' }); // ftp:// is not a web link
    expect(l.items[5]).toMatchObject({ status: 'unknown', statusText: '검토중', type: 'other', whatWeTook: null, evidence: '…' }); // the whole home-rooted path is blanked, as elsewhere
    const dump = JSON.stringify(l);
    expect(dump).not.toContain('sk-EXAMPLE'); expect(dump).not.toContain(HOME);
    expect(stripSecrets(l)).toEqual(l);
  });
  it('caps the table at 400 newest items while the counts cover the whole file; malformed dates sort last', () => {
    const many = Array.from({ length: 405 }, (_, i) => ({ id: `r${i}`, title: `t${i}`, type: 'tip', status: '미착수', added_at: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` }));
    const l = parseLedger(j({ generated_at: '2026-11-01T19:30:00+09:00', items: [...many, { id: 'nodate', title: 'x', status: '문서만', added_at: '2026/10/01' }] }));
    expect(l.total).toBe(406); expect(l.items).toHaveLength(400); expect(l.truncated).toBe(6);
    expect(l.counts.todo).toBe(405); expect(l.counts.docs_only).toBe(1);
    expect(l.items.map((i) => i.addedAt ?? 'null').slice(0, 2).every((d) => d >= '2026-12')).toBe(true);
    const full = parseLedger(j({ generated_at: '2026-11-01T19:30:00+09:00', items: [{ id: 'nodate', title: 'x', status: '문서만', added_at: '2026/10/01' }, { id: 'dated', title: 'y', status: '문서만', added_at: '2020-01-01' }] }));
    expect(full.items.map((i) => i.id)).toEqual(['dated', 'nodate']);
    expect(full.items[1]!.addedAt).toBeNull();
  });
  it('the view carries the ledger and alerts only on a malformed file, skipped entries or 미분류 (a missing ledger is not an alert)', () => {
    const none = view({ status: STATUS, channels: CHANNELS });
    expect(none.ledger.file.state).toBe('missing');
    expect(texts(none).some((t) => t.includes('reference_ledger'))).toBe(false);
    const v = buildShortsView({ status: j(STATUS), channels: j(CHANNELS), history: null, ledger: j(LEDGER), probes: PROBES_OK, probeNote: null }, NOW);
    expect(v.ledger.total).toBe(6);
    expect(v.alerts.find((a) => a.text === 'reference_ledger.json 항목 1개 건너뜀')?.level).toBe('info');
    expect(v.alerts.find((a) => a.text === '적용 현황 미분류 1건')?.level).toBe('info');
    const bad = buildShortsView({ status: j(STATUS), channels: j(CHANNELS), history: null, ledger: '{', probes: PROBES_OK, probeNote: null }, NOW);
    expect(bad.alerts.find((a) => a.text === 'reference_ledger.json 형식 오류')).toMatchObject({ level: 'warn', hint: 'JSON 해석 실패' });
    expect(JSON.stringify(v)).not.toContain(HOME);
    expect(stripSecrets(v)).toEqual(v);
  });
});

describe('distribution (status.json distribution block)', () => {
  const withDist = (d: unknown) => buildShortsView({ status: j({ ...STATUS, distribution: d }), channels: j(CHANNELS), history: HISTORY, probes: PROBES_OK, probeNote: null }, NOW);
  it('is null when status.json carries no block or a broken one', () => {
    expect(view().distribution).toBeNull();
    expect(parseDistribution('x')).toBeNull();
    expect(parseDistribution({ platforms: [] })).toBeNull();
  });
  it('keeps slug platforms, sanitizes states, urls and secrets', () => {
    const d = parseDistribution(DIST)!;
    expect(d.platforms.map((p) => p.id)).toEqual(['youtube', 'tiktok', 'instagram']);
    const c = d.channels[0]!;
    expect(c.cells.tiktok!.url).toBeNull();
    expect(c.cells.tiktok!.accountState).toBe('name_pending');
    expect(c.cells.instagram!.accountState).toBe('none');
    expect(c.cells.tiktok!.blockers.join(' ')).not.toContain('abc123secret');
    expect(d.totals.tiktok).toEqual({ queued: 0, scheduled: 0, posted: 0, failed: 1 });
    expect(d.shorts.map((s) => s.id)).toEqual(['tk-snow', 'tears', 'boil']);
    expect(d.shorts[1]!.platforms.tiktok).toMatchObject({ state: 'failed', error: '429 rate limit' });
  });
  it('fills YouTube views from channels.json videos by video id', () => {
    const d = withDist(DIST).distribution!;
    expect(d.shorts.find((s) => s.id === 'tears')!.platforms.youtube!.views).toBe(545);
    expect(d.shorts.find((s) => s.id === 'boil')!.platforms.youtube!.views).toBe(2300);
    expect(d.channels[0]!.cells.youtube!.views).toBe(2845);
    expect(d.channels[0]!.youtubeChannelId).toBe(CH1);
  });
});
