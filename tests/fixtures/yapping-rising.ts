/** Synthetic data for tests and opt-in previews only; never a live fallback. */
export function risingFixture() {
  return {
    generated_at: '2026-11-02T03:00:00.000Z', window_h: 12, count: 30,
    items: Array.from({ length: 30 }, (_, i) => {
      const rank = 30 - i;
      return { id: String(900000 + rank), rank, url: `https://x.com/fixture_${rank}/status/${900000 + rank}`, author: `@fixture_${rank}`, followers: 1000 + rank, text: `[FIXTURE] ${rank}번째 공개 게시물 · 인공지능과 개발 도구에 관한 새로운 소식입니다. 긴 제목도 한 줄로 표시합니다.`, views: 20_000 - rank * 100, velocity_vph: 12_000.5 / rank, age_h: rank / 4, observations: 4, method: 'fixture', topic: rank % 2 ? 'AI' : '개발 도구', score: 100 / rank };
    }),
  };
}
