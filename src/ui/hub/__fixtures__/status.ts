import type { HubMode, HubStatus } from '../../../shared/hub-types';

/** A full status as the redesigned server sends it: nine modes, every section kind, one of each state. */
export function hubStatusFixture(nowMs: number): HubStatus {
  const iso = (agoMs: number) => new Date(nowMs - agoMs).toISOString();
  const modes: HubMode[] = [
    {
      id: 'msg', name: 'MSG 터미널', state: 'ok', lastActivity: iso(0), metrics: { '가동 시간': '3시간 2분', '세션': 4 }, alerts: [], links: [], sources: [{ name: 'msg', ok: true, ms: 0 }],
      page: { headline: '세션 4개 · 가동 3시간 2분', decision: '조치 없음', kpis: [{ label: '세션', value: '4' }, { label: '가동', value: '3시간 2분' }], sections: [{ kind: 'kv', title: '서버', open: true, rows: [['빌드', 'abc123'], ['Node', 'v24']] }] },
    },
    {
      id: 'nexus', name: 'NEXUS', state: 'down', lastActivity: null, metrics: {}, alerts: [{ level: 'bad', text: '연결 실패', hint: 'nexus 서비스 확인' }], links: [{ label: 'NEXUS 열기', href: 'http://nexus.example/' }], sources: [{ name: 'nexus', ok: false, ms: 3000, error: '시간 초과' }],
      page: { headline: 'NEXUS 응답 없음 (시간 초과)', decision: 'nexus 서비스 상태 확인', kpis: [{ label: '응답', value: '없음', status: 'bad' }], sections: [{ kind: 'raw', title: '원본 보기', href: 'http://nexus.example/' }] },
    },
    {
      id: 'trading', name: 'Trading Room', state: 'ok', lastActivity: iso(60_000), metrics: { '감시 종목': 12 }, alerts: [], links: [], sources: [{ name: 'trading', ok: true, ms: 5 }], tag: 'PAPER',
      page: { headline: '감시 12 종목 · 체결 0', decision: '조치 없음', kpis: [{ label: '감시 종목', value: '12', unit: '개' }, { label: '오늘 손익', value: '+1.2', unit: '%', status: 'ok' }], sections: [{ kind: 'bars', title: '종목별 손익', open: true, items: [{ label: 'AAA', value: 3.5, text: '+3.5%' }, { label: 'BBB', value: -1.2, text: '-1.2%' }] }] },
    },
    {
      id: 'video', name: '영상 스튜디오', state: 'idle', lastActivity: null, metrics: {}, alerts: [], links: [], sources: [],
      page: { headline: '최근 작업 없음', decision: '다음 에피소드 선택', kpis: [], sections: [{ kind: 'text', title: '메모', body: '첫 줄\n둘째 줄' }] },
    },
    {
      id: 'game', name: '게임 스튜디오', state: 'ok', lastActivity: iso(3_600_000), metrics: { '빌드': 'PASS' }, alerts: [], links: [], sources: [],
      page: { headline: '빌드 PASS · 테스트 120/120', decision: '조치 없음', kpis: [{ label: '테스트', value: '120/120', status: 'ok' }], sections: [{ kind: 'list', title: '최근 커밋', open: true, items: [{ text: 'fix: 충돌 판정', at: iso(3_600_000) }, { text: 'feat: 보스', level: 'ok' }] }] },
    },
    {
      id: 'ops', name: 'OPS · 펍덱', state: 'warn', lastActivity: iso(720_000), metrics: { '서비스': 'ok' }, alerts: [{ level: 'warn', text: 'sub1 하트비트 정지 · 12분 전', at: iso(720_000), hint: 'sub1 전원·네트워크 확인' }], links: [{ label: 'OPS 열기', href: '/hub/p/ops/', embed: true }], sources: [{ name: 'ops', ok: true, ms: 40 }],
      page: {
        headline: '프린터 4대 중 3대 가동 · sub1 정지', decision: 'sub1 전원·네트워크 확인',
        kpis: [{ label: '가동', value: '3/4', status: 'warn' }, { label: '큐', value: '2', unit: '건' }],
        sections: [
          { kind: 'table', title: '프린터', open: true, columns: ['이름', '상태', '큐'], rows: [['main', '가동', '1'], ['sub1', '정지', '0'], ['sub2', '가동', '1'], ['sub3', '실패', '0']], num: [2] },
          { kind: 'raw', title: '원본 보기', href: '/hub/p/ops/', embed: true },
        ],
      },
    },
    {
      id: 'updown', name: 'UPDOWN', state: 'ok', lastActivity: iso(5_000), metrics: {}, alerts: [], links: [], sources: [{ name: 'updown', ok: true, ms: 8 }],
      page: { headline: '정상 · 가동 2일', decision: '조치 없음', kpis: [{ label: '가동', value: '2일' }], sections: [] },
    },
    {
      id: 'quant', name: 'QUANT', state: 'ok', lastActivity: iso(30_000), metrics: { '타일': 9 }, alerts: [], links: [{ label: 'QUANT 열기', href: '/hub/p/quant/', embed: true }], sources: [{ name: 'quant', ok: true, ms: 3 }],
      page: {
        headline: 'IOC 발견 0 · 타일 9/9 정상', decision: '조치 없음',
        kpis: [{ label: 'IOC 발견', value: '0', status: 'ok' }, { label: '타일', value: '9/9' }],
        sections: [
          { kind: 'table', title: 'IOC 발견 — 계정별', open: true, columns: ['계정', '건수'], rows: [], num: [1] },
          { kind: 'raw', title: '원본 보기', href: '/hub/p/quant/', embed: true },
        ],
      },
    },
    // An older-server shape: no page → the template falls back to metrics + alerts.
    { id: 'yapping', name: '야핑봇', state: 'unknown', lastActivity: null, metrics: { '서비스': '확인 불가', '답글(24h)': null }, alerts: [{ level: 'info', text: '상태 파일 없음' }], links: [], sources: [{ name: 'systemd', ok: false, ms: 10, error: '권한 없음' }] },
  ];
  return { host: 'deck-host', generated_at: new Date(nowMs).toISOString(), modes };
}
