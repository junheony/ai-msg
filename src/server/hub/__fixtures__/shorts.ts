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
