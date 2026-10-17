import { describe, expect, it } from 'vitest';
import type { HighlightEvent } from '../../shared/highlights';
import { groupHighlights } from './Highlights';
import { lastResultOf, plainFirstSentence, sectionHighlights } from './highlightSections';

const NOW = new Date(2026, 9, 13, 12, 0).getTime();
const M = 60_000;
const ev = (minAgo: number, over: Partial<HighlightEvent>): HighlightEvent => ({ at: NOW - minAgo * M, kind: 'turn', sessionId: 's1', cwd: '/p/app', title: 'App', body: '완료 · 끝', ok: true, ...over });
const keys = (xs: { card: { key: string } }[]) => xs.map((x) => x.card.key);

describe('plainFirstSentence', () => {
  it('drops markdown marks and keeps the first sentence of the first line', () => {
    expect(plainFirstSentence('**로그인 버그** 고침. 테스트도 추가함.')).toBe('로그인 버그 고침.');
    expect(plainFirstSentence('`npm test` 통과! 다음은')).toBe('npm test 통과!');
    expect(plainFirstSentence('## 요약\n- 나머지')).toBe('요약');
    expect(plainFirstSentence('- [문서](http://x) 갱신')).toBe('문서 갱신');
    expect(plainFirstSentence('v1.2 배포 _완료_')).toBe('v1.2 배포 완료');
    expect(plainFirstSentence('')).toBe('');
  });
});

describe('sectionHighlights', () => {
  it('sorts sessions into attention / progress / done / system', () => {
    const events: HighlightEvent[] = [
      ev(1, { sessionId: 'ok', body: '완료 · **다 됨**. 끝' }),
      ev(2, { sessionId: 'fail', ok: false, body: '실패 · 타입 에러. 자세히' }),
      ev(3, { sessionId: 'fixed', body: '완료 · 다시 성공' }),
      ev(4, { sessionId: 'fixed', ok: false, body: '실패 · 에러' }),
      ev(5, { sessionId: 'cut', kind: 'interrupted', body: '서버가 다시 시작되어 중단됨', ok: undefined }),
      ev(6, { sessionId: 'limit', ok: false, body: '실패 · 사용 한도 도달' }),
      ev(12, { sessionId: 'ask', kind: 'permission', body: '권한 요청 · Bash', ok: undefined }),
      ev(20, { sessionId: 'ask', body: '완료 · 앞선 일' }),
      ev(7, { sessionId: 'run', ok: false, body: '실패 · 에러' }),
      ev(8, { sessionId: 'bg', body: '완료 · 시작' }),
      ev(9, { sessionId: 'oldask', kind: 'question', body: '질문 · 어느 쪽?', ok: undefined }),
      ev(30, { sessionId: null, cwd: '', title: '서버', kind: 'server', body: '서버 시작', ok: undefined }),
    ];
    const live = {
      waiting: [{ sessionId: 'ask', kind: 'permission' as const }, { sessionId: null, kind: 'question' as const }],
      activity: [{ sessionId: 'run', running: true, bg: 0 }, { sessionId: 'bg', running: false, bg: 3 }, { sessionId: 'ok', running: false, bg: 0 }],
    };
    const s = sectionHighlights(groupHighlights(events, 'all'), live, NOW);
    expect(keys(s.attention)).toEqual(['ask', 'fail', 'limit', 'cut']);
    expect(s.attention.map((a) => a.need)).toEqual(['승인 대기 · 12분', '실패: 타입 에러.', '한도로 끊김: 사용 한도 도달', '서버 재시작으로 끊김']);
    expect(s.attention.map((a) => a.tone)).toEqual(['warn', 'danger', 'danger', 'warn']);
    expect(s.progress.map((p) => [p.card.key, p.status])).toEqual([['run', '실행 중'], ['bg', '백그라운드 3']]);
    // An answered question (no longer waiting) and a failure settled by a later success are done.
    expect(s.done.map((c) => c.key)).toEqual(['ok', 'fixed', 'oldask']);
    expect(lastResultOf(s.done[0]!)).toBe('다 됨.');
    expect(lastResultOf(s.done[2]!)).toBe('');
    expect(s.system.map((c) => c.key)).toEqual(['server']);
  });

  it('without live state nothing is waiting or running', () => {
    const s = sectionHighlights(groupHighlights([ev(1, { kind: 'permission', body: '권한 요청', ok: undefined })], 'all'), undefined, NOW);
    expect(s.attention).toEqual([]);
    expect(s.progress).toEqual([]);
    expect(s.done.map((c) => c.key)).toEqual(['s1']);
  });

  it('a waiting question says 질문 대기', () => {
    const s = sectionHighlights(groupHighlights([ev(65, { kind: 'question', body: '질문', ok: undefined })], 'all'), { waiting: [{ sessionId: 's1', kind: 'question' }], activity: [] }, NOW);
    expect(s.attention.map((a) => a.need)).toEqual(['질문 대기 · 1시간']);
  });
});
