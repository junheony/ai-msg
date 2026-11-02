/** Shared by the server tests (shorts.test.ts) and the UI tests (ShortsFactoryHome.test.tsx): the same payload shape the collector ships. */
import { parseClaudePick, parseCodex, parseDf } from '../shorts';

/** 2026-11-01 20:00 KST, a Sunday: tomorrow is Monday 11-02 and the calendar starts Monday 10-26. */
export const NOW = Date.parse('2026-11-01T11:00:00Z');
export const HOME = '/Users/alice';
export const CH1 = 'UC3rtb2M3lZoKIkIZWR4saYQ'; export const CH2 = 'UC6OpOfe_e7tS665qqZgmc8g'; export const CH3 = 'UCWVedICiqdbRhLVt6avZmQQ';

export const STATUS = {
  schema: 1, generated_at: '2026-11-01T19:55:00+09:00', placeholder: false,
  routine: { last_run_at: '2026-11-01T19:50:00+09:00', status: 'ok', log_tail: ['[19:50:01] render ep-041 ok', '[19:54:00] wrote /Users/alice/renders/ep-041.mp4', '[19:54:50] upload queued'] },
  last_render: { file: '/Users/alice/renders/ep-041.mp4', at: '2026-11-01T19:54:00+09:00' },
  gate_failures: [{ gate: 'caption-length', at: '2026-11-01T18:30:00+09:00', detail: 'ep-040 caption 2.1s over' }],
  queue_depth: 3,
  scheduled: [
    { channel_id: CH1, video_id: 'ep-042', title: '내일 18시', publish_at: '2026-11-02T18:00:00+09:00' },
    { channel_id: CH2, video_id: 'ep-043', title: 'tomorrow 9am', publish_at: '2026-11-02T09:00:00+09:00' },
    { channel_id: CH1, video_id: 'ep-050', title: '다음 주', publish_at: '2026-11-05T18:00:00+09:00' },
  ],
  published: [{ channel_id: CH1, video_id: 'zCpK0B_jnnw', title: '오늘 올라간 것', published_at: '2026-11-01T18:00:00+09:00' }],
  notes: ['TikTok 계정 신청 대기'],
};
export const PLACEHOLDER = { schema: 1, generated_at: '2026-11-01T19:30:00+09:00', placeholder: true, routine: { last_run_at: null, status: 'unknown', log_tail: [] }, last_render: { file: null, at: null }, gate_failures: [], queue_depth: null, scheduled: [], published: [], notes: [] };
export const CHANNELS = {
  schema: 1, generated_at: '2026-11-01T19:40:00+09:00', collector: 'collect_youtube.py', planned_total: 20,
  channels: [
    { id: CH1, name: '궁금한 1분', lang: 'ko', publish_kst: '18:00', platforms: { youtube: { status: 'live', url: 'https://www.youtube.com/channel/' + CH1 }, tiktok: { status: 'none' }, instagram: { status: 'none' }, x: { status: 'none' }, other: { status: 'none' } },
      subscribers: null, total_views: null, video_count: 12, videos: [{ id: 'zCpK0B_jnnw', title: '최신', views: 545, url: 'https://www.youtube.com/shorts/zCpK0B_jnnw' }, { id: 'h1yhOEI46fg', title: '그 전', views: 2300 }],
      last_attempt_at: '2026-11-01T19:40:00+09:00', last_success_at: '2026-11-01T19:40:05+09:00', error: null },
    { id: CH2, name: 'Curious Minute', lang: 'en', publish_kst: '09:00', platforms: { youtube: { status: 'live' }, tiktok: { status: 'none' }, instagram: { status: 'none' }, x: { status: 'none' }, other: { status: 'none' } },
      subscribers: 1200, total_views: null, video_count: 9, videos: [{ id: 'lp8Vay4jaoo', title: 'kept', views: 1157 }],
      last_attempt_at: '2026-11-01T19:41:00+09:00', last_success_at: '2026-10-30T19:41:00+09:00', error: 'yt-dlp timeout after 60s (/Users/alice/.local/bin/yt-dlp)' },
    { id: CH3, name: '썰 한 스푼', publish_kst: '20:00', subscribers: null, total_views: null, videos: [], last_attempt_at: null, last_success_at: null, error: null },
    { name: 'no id, skipped' },
  ],
};
export const HISTORY = [
  JSON.stringify({ at: '2026-10-31T20:00:00+09:00', channel_id: CH1, source: 'collector', videos: [{ id: 'zCpK0B_jnnw', views: 300 }, { id: 'h1yhOEI46fg', views: 2100 }] }),
  JSON.stringify({ at: '2026-11-01T00:00:00+09:00', channel_id: CH1, source: 'collector', videos: [{ id: 'zCpK0B_jnnw', views: 400 }, { id: 'h1yhOEI46fg', views: 2200 }] }),
  JSON.stringify({ at: '2026-11-01T19:40:05+09:00', channel_id: CH1, source: 'collector', videos: [{ id: 'zCpK0B_jnnw', views: 545 }, { id: 'h1yhOEI46fg', views: 2300 }] }),
  JSON.stringify({ at: '2026-11-01T19:00:00+09:00', channel_id: CH1, source: 'user_reference', videos: [{ id: 'h1yhOEI46fg', views: 2163 }], mapping: 'live_lookup' }),
  JSON.stringify({ at: '2026-11-01T19:00:00+09:00', channel_id: null, source: 'user_reference', videos: [{ id: 'VFfjBXHu6Oo', views: 431 }], mapping: 'unmapped' }),
  '{"at":"2026-11-01T19:00:00+09:00","channel_id":"UC', // cut line
  JSON.stringify({ at: '2026-11-01T19:00:00+09:00', channel_id: CH2, source: 'somewhere-else', videos: [] }),
].join('\n');
export const PROBES_OK = { disk: parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme1n1p2 1920641288 1648242724 174761600 91% /\n'), claude: parseClaudePick('claude-pick: 제외 a: 보호 계정\nclaude-pick: 후보 b: 주간 31% · 리셋 52h · 점수 0.41\nclaude-pick: 후보 c: 주간 70% · 리셋 12h · 점수 0.83 · stale\nb\nclaude-pick-exit=0\n'), codex: parseCodex('codex-cli 0.159.2\n') };
export const NO_PROBES = { disk: { usedPct: null, note: '측정 불가 · exec 없음' }, claude: { state: 'unknown' as const, summary: '확인 불가 · exec 없음', picked: null, accounts: [] }, codex: { available: null, version: null, note: '확인 불가 · exec 없음' } };
/** reference_ledger.json: statuses with an en dash and with a plain hyphen, one unknown status, one non-http url, one entry without a title (skipped). */
export const LEDGER = {
  schema: 1, generated_at: '2026-11-01T19:30:00+09:00',
  items: [
    { id: 'ref-hook-3s', title: '첫 3초 훅 공식', url: 'https://www.youtube.com/watch?v=hook3s', type: 'video', what_we_took: '첫 컷에 결론 자막 · 0.8초 컷 전환', status: '적용됨 – 운영 중', status_reason: null, evidence: 'a1b2c3d · render/hook.py · HOOK_FIRST=1', next_action: null, added_at: '2026-10-20', updated_at: '2026-10-28' },
    { id: 'ref-caption-tool', title: '자막 자동 정렬 도구', url: 'https://github.com/example/caps', type: 'tool', what_we_took: 'whisper 타임스탬프 → srt 정렬', status: '구현됨 - 꺼짐', status_reason: '한국어 정확도 미달', evidence: 'd4e5f6a · gates/caption.py · CAPTION_ALIGN=0', next_action: '한국어 샘플 50개로 재측정', added_at: '2026-10-25', updated_at: '2026-10-30' },
    { id: 'ref-thumb-post', title: '썸네일 A/B 글', url: 'ftp://not-a-web-link', type: 'post', what_we_took: '썸네일 2종 교차 테스트 아이디어', status: '문서만', status_reason: null, evidence: 'docs/thumbs.md', next_action: '쇼츠는 썸네일 노출이 적어 보류', added_at: '2026-10-25', updated_at: null },
    { id: 'ref-sub4sub', title: '맞구독 팁', url: null, type: 'tip', what_we_took: '없음', status: '검토 후 제외', status_reason: '정책 위반 위험', evidence: '—', next_action: null, added_at: '2026-10-25', updated_at: '2026-10-26' },
    { id: 'ref-music', title: '트렌드 음원 자동 매칭', url: 'https://example.com/music', type: 'video', what_we_took: '음원 트렌드 목록 참고', status: '미착수', status_reason: null, evidence: 'token=sk-EXAMPLE12345678 in notes', next_action: '음원 라이선스 확인', added_at: '2026-11-01', updated_at: null },
    { id: 'ref-odd', title: '상태 모를 항목', url: null, type: 'rumor', what_we_took: null, status: '검토중', status_reason: null, evidence: '/Users/alice/notes/odd.md', next_action: null, added_at: '2026-10-01', updated_at: null },
    { id: 'ref-untitled', url: null, type: 'tip', status: '미착수', added_at: '2026-10-02' },
  ],
};

/** status.json `distribution` block as golf-shorts scripts/dist.py writes it (trimmed). */
export const DIST = {
  platforms: [{ id: 'youtube', label: 'YouTube Shorts', status: 'active' }, { id: 'tiktok', label: 'TikTok', status: 'active', note: '수동 업로드' }, { id: 'instagram', label: 'Instagram Reels', status: 'planned' }, { id: '../evil', label: 'x' }],
  channels: [
    { id: 'gunggeum-1min', name: '궁금한 1분', lang: 'ko', youtube_channel_id: CH1, publish_kst: '18:00', cells: {
      youtube: { account_state: 'ready', handle: '@gunggeum_1min', url: 'https://www.youtube.com/@gunggeum_1min', blockers: [], counts: { queued: 1, scheduled: 1, posted: 1, failed: 0 }, views: null },
      tiktok: { account_state: 'name_pending', handle: '@maxmaxmax858', url: 'javascript:alert(1)', blockers: ['닉네임 변경 잠금 2026-11-08까지', 'token=abc123secret'], counts: { queued: 0, scheduled: 0, posted: 0, failed: 1 }, views: null },
      instagram: { account_state: 'bogus' } } },
  ],
  totals: { youtube: { queued: 1, scheduled: 1, posted: 1, failed: 0 }, tiktok: { failed: 1 } },
  shorts: [
    { id: 'tk-snow', channel: 'gunggeum-1min', title: '눈송이', batch: 'd1104', platforms: { youtube: { state: 'queued', at: '2026-11-08T18:00:00+09:00' } } },
    { id: 'tears', channel: 'gunggeum-1min', title: null, platforms: { youtube: { state: 'scheduled', video_id: 'zCpK0B_jnnw', url: 'https://youtube.com/shorts/zCpK0B_jnnw', at: '2026-11-03T18:00:00+09:00' }, tiktok: { state: 'failed', error: '429 rate limit' } } },
    { id: 'boil', channel: 'gunggeum-1min', title: '끓는 물', platforms: { youtube: { state: 'posted', derived: true, video_id: 'h1yhOEI46fg', at: '2026-10-31T18:00:00+09:00' } } },
    { channel: 'gunggeum-1min' },
  ],
  shorts_total: 3,
  blockers: [{ channel: '궁금한 1분', platform: 'tiktok', text: '닉네임 변경 잠금 2026-11-08까지' }, { channel: '궁금한 1분', platform: 'instagram', text: '계정 없음' }],
  updated_at: '2026-11-02T00:30:00+09:00',
};
