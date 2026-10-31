import { describe, expect, it } from 'vitest';
import type { HubSection } from '../../shared/hub-types';
import { collectHubStatus, type HubDeps, type HubSelfSeat } from './status';

const NOW = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST
const HOME = '/Users/alice';

/** Everything but `self` is unreachable: the other collectors degrade to unknown/down and the msg mode is modes[0]. */
function deps(self: ReturnType<HubDeps['self']>): HubDeps {
  return {
    fetchJson: async () => { throw new Error('fetch failed: ECONNREFUSED'); },
    latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null,
    readText: async () => null, readTail: async () => null, listDir: async () => null, fileMtime: async () => null, systemdShow: async () => null,
    now: () => NOW, self: () => self, host: 'deck-host.example.ts.net', home: HOME,
  };
}
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));
const seat = (id: string, label: string, o: Partial<HubSelfSeat> = {}): HubSelfSeat => ({ id, label, status: 'ok', fiveHour: 10, weekly: 20, fable: 5, resetsAt: '2026-10-30T15:00:00Z', weeklyResetsAt: '2026-11-02T00:00:00Z', ...o });

describe('collectMsg (via collectHubStatus)', () => {
  it('without session/seat detail (an older self) it falls back to counts, uptime and a pointer at the usage sheet', async () => {
    const s = await collectHubStatus(deps({ uptimeMs: 90_061_000, sessions: 4, activeTurns: 1 }));
    const m = s.modes[0]!;
    expect(m.id).toBe('msg');
    expect(m.name).toBe('MSG 터미널');
    expect(m.state).toBe('ok');
    expect(m.metrics).toEqual({ '가동 시간': '1일 1시간', '세션': 4, '실행 중 턴': 1 });
    expect(m.page!.headline).toBe('세션 4 · 진행 중 턴 1 · 서버 가동 1일 1시간');
    expect(m.page!.decision).toBe('진행 중 턴 1개 확인');
    expect(m.page!.kpis.map((k) => [k.label, k.value])).toEqual([['진행 중 턴', '1'], ['24h 세션', '4'], ['좌석 여유', '—'], ['서버 가동', '1일 1시간']]);
    expect(m.page!.kpis[3]!.hint).toBe('10-29 20:58 시작');
    expect(m.page!.sections.map((x) => x.title)).toEqual(['사용량', '서버']);
    const server = section(m.page!.sections, /^서버$/)!;
    if (server.kind === 'kv') {
      expect(server.open).toBe(true);
      expect(server.rows).toEqual([['호스트', 'deck-host.example.ts.net'], ['가동 시간', '1일 1시간'], ['시작 시각', '10-29 20:58 KST'], ['세션', '4'], ['진행 중 턴', '1']]);
    }
    expect(m.alerts).toEqual([]);
    expect(m.sources).toEqual([{ name: 'self', ok: true, ms: 0 }]);
    expect(m.lastActivity).toBe(new Date(NOW).toISOString());
    expect(JSON.stringify(m)).not.toContain(HOME);
  });
  it('says 조치 없음 when no turn is in flight and dashes unknown counts', async () => {
    const s = await collectHubStatus(deps({ uptimeMs: 5_000, sessions: null, activeTurns: null }));
    const m = s.modes[0]!;
    expect(m.page!.headline).toBe('세션 — · 진행 중 턴 0 · 서버 가동 5초');
    expect(m.page!.decision).toBe('조치 없음');
    expect(m.metrics).toEqual({ '가동 시간': '5초' });
    expect(m.page!.kpis[0]).toMatchObject({ value: '0', status: 'ok', hint: '대기 중' });
    expect(m.page!.kpis[1]!.value).toBe('—');
  });
  it('shows the work: running and recent sessions (slash-command titles replaced), seats with the best one picked and the spent ones named', async () => {
    const s = await collectHubStatus(deps({
      uptimeMs: 3_600_000, sessions: 40, activeTurns: 1, active24h: 6,
      recent: [
        { title: '/hub-phase3 continue', project: 'ai-msg-hub3', engine: 'claude', seat: 'Claude B', lastModified: NOW - 60_000, running: true, bg: 0 },
        { title: '레인 성적표 갱신', project: 'arbitrage-nexus', engine: 'codex', seat: 'GPT', lastModified: NOW - 3_600_000, running: false, bg: 0 },
        { title: '', project: 'games', engine: 'gemini', seat: 'Gemini', lastModified: NOW - 7_200_000, running: false, bg: 0 },
      ],
      seats: [
        seat('a', 'Claude A', { fiveHour: 100, weekly: 60 }),
        seat('b', 'Claude B', { fiveHour: 35, weekly: 20, fable: 5 }),
        seat('c', 'Claude C', { fiveHour: 10, weekly: 95, fable: 50 }),
        seat('gpt', 'GPT', { fiveHour: 0, weekly: 12, fable: null }),
        seat('g1', 'Gemini', { status: 'login', fiveHour: null, weekly: null, fable: null, resetsAt: null, weeklyResetsAt: null, note: '로그인 필요 (agy)' }),
        seat('x1', 'Grok', { status: 'unknown', fiveHour: null, weekly: null, fable: null, resetsAt: null, weeklyResetsAt: null, note: '오늘 0턴' }),
      ],
    }));
    const m = s.modes[0]!;
    expect(m.state).toBe('warn'); // a seat needs a login
    expect(m.page!.headline).toBe('진행 중 턴 1 · 24h 세션 6 · 좌석 여유 GPT 12% 사용 · 소진 Claude A · 로그인 필요 Gemini');
    expect(m.page!.decision).toBe('Gemini 다시 로그인 — 상단 칩에서');
    expect(m.page!.kpis.map((k) => [k.label, k.value])).toEqual([['진행 중 턴', '1'], ['24h 세션', '6'], ['좌석 여유', 'GPT'], ['서버 가동', '1시간 0분']]);
    expect(m.page!.kpis[0]!.hint).toBe('ai-msg-hub3');
    expect(m.page!.kpis[2]).toMatchObject({ status: 'ok', hint: '사용 12% · 5h 0% · 소진 1' });
    expect(m.alerts.map((a) => a.text)).toEqual(['Claude A 소진 · 5시간 100%', 'Gemini 로그인 필요']);
    expect(m.alerts[0]!.hint).toBe('리셋 10-31 00:00');
    expect(m.alerts[1]!.hint).toContain('Gemini → 다시 로그인');
    expect(m.page!.sections.map((x) => x.title)).toEqual(['진행 중 · 최근 세션', '좌석 사용량', '서버']);
    const sess = section(m.page!.sections, /최근 세션/)!;
    if (sess.kind === 'table') {
      expect(sess.open).toBe(true);
      expect(sess.rows).toEqual([
        ['응답 중', '1분 전', 'Claude B', 'ai-msg-hub3', 'ai-msg-hub3 · 명령'],
        ['대기', '1시간 0분 전', 'GPT', 'arbitrage-nexus', '레인 성적표 갱신'],
        ['대기', '2시간 0분 전', 'Gemini', 'games', 'games · 명령'],
      ]);
      expect(sess.note).toContain('응답 중 1');
    }
    const seatsSec = section(m.page!.sections, /^좌석 사용량$/)!;
    if (seatsSec.kind === 'table') {
      expect(seatsSec.columns).toEqual(['좌석', '5시간', '주간', 'Fable 7d', '리셋', '상태']);
      expect(seatsSec.rows[0]).toEqual(['Claude A', '100%', '60%', '5%', '10-31 00:00', '소진']);
      expect(seatsSec.rows[3]).toEqual(['GPT', '0%', '12%', '—', '10-31 00:00', '정상']);
      expect(seatsSec.rows[4]).toEqual(['Gemini', '—', '—', '—', '—', '로그인 필요 · 로그인 필요 (agy)']);
      expect(seatsSec.rows[5]).toEqual(['Grok', '—', '—', '—', '—', '기록 없음 · 오늘 0턴']);
    }
    expect(section(m.page!.sections, /^서버$/)!.open).toBe(false);
    expect(m.sources).toEqual([{ name: 'self', ok: true, ms: 0 }, { name: '사용량', ok: true, ms: 0 }]);
    expect(JSON.stringify(m)).not.toContain(HOME);
  });
  it('all seats spent → warn and 리셋 대기; a spent seat with another free → that one is the decision', async () => {
    let s = await collectHubStatus(deps({ uptimeMs: 1, sessions: 1, activeTurns: 0, recent: [], seats: [seat('a', 'Claude A', { fiveHour: 100 }), seat('gpt', 'GPT', { weekly: 100 })] }));
    expect(s.modes[0]!.state).toBe('warn');
    expect(s.modes[0]!.page!.decision).toBe('모든 좌석 소진 — 리셋 대기');
    expect(s.modes[0]!.page!.kpis[2]).toMatchObject({ value: '없음', status: 'bad' });
    s = await collectHubStatus(deps({ uptimeMs: 1, sessions: 1, activeTurns: 0, recent: [], seats: [seat('a', 'Claude A', { fiveHour: 100 }), seat('b', 'Claude B', { fiveHour: 85, weekly: 10 })] }));
    expect(s.modes[0]!.state).toBe('ok');
    expect(s.modes[0]!.page!.decision).toBe('Claude A 소진 — Claude B로 작업');
    expect(s.modes[0]!.page!.kpis[2]).toMatchObject({ value: 'Claude B', status: 'warn' });
  });
});
