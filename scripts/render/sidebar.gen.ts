// Sidebar fixture markup: the real Sidebar rendered to static HTML, so the sidebar fixtures stop drifting from the
// component (sidebar-rows / sidebar-avatars / landscape-focus had kept an old row-time layout). Rewrites every
// bare `<aside class="sidebar">…</aside>` (no other attributes: a styled one-row cell is left alone) in the named
// fixtures with a fresh render:
//   npx tsx scripts/render/sidebar.gen.ts sidebar-clean sidebar-rows landscape-focus      (13-session list)
//   npx tsx scripts/render/sidebar.gen.ts --avatars sidebar-avatars                       (15 sessions, 'app' ×12)
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setLocale } from '../../src/shared/locale';
import { Sidebar } from '../../src/ui/components/Sidebar';
import type { ProjectEntry, SessionEntry } from '../../src/shared/session-types';
import type { SessionActivity } from '../../src/shared/protocol';

setLocale('ko');
const args = process.argv.slice(2);
const avatars = args.includes('--avatars');
const files = args.filter((a) => !a.startsWith('--'));
const now = Date.now();
const min = 60_000;
let n = 0;
const id = () => `3f2a${String(n++).padStart(4, '0')}-8d1e-4c2b-9a7f-${'abcdef0123456789'[n % 16]}a1b2c3d4e5f`;
type Extra = Partial<SessionEntry>;
const s = (cwd: string, title: string, ago: number, preview: string, extra: Extra = {}): SessionEntry => ({
  sessionId: id(), cwd, projectDir: `/r${cwd}`, file: `/r${cwd}/f`, title, preview, lastModified: now - ago * min, sizeBytes: 1, account: 'a', engine: 'claude', ...extra,
} as SessionEntry);

const dev = '/Users/me/src/app', deck = '/Users/me/deck', notes = '/Users/me/notes';
const list: SessionEntry[] = avatars
  ? [
    ...['사이드바 아바타 아이콘', '봇 로그 정리', '⌘1 단축키 안 먹음', '로그인 버그', '인수인계 갱신', 'PDF 마크다운 변환', '리눅스 동기화 확인', '라우팅 표 개정', '배포 점검', '토큰 갱신 타이머', '폰 키보드 높이', '알림 권한 정리']
      .map((t, i) => s(dev, t, 3 + i * 40, i % 3 ? '' : '바꾼 내용을 확인해 주세요.')),
    s(deck, 'deck 설정 시트 정리', 25, '설정 시트를 두 단으로 나누었습니다.'), s(deck, '분할 창 포커스', 1500, ''), s(notes, '주말 계획', 240, ''),
  ]
  : [
    s(dev, '사이드바 아바타 아이콘', 3, '배지를 모두 걷어내고 상태는 행 오른쪽 끝 한 자리로 옮겼어요. 캡처를 확인해 주세요.'),
    s(dev, '봇 로그 정리', 120, ''),
    s(deck, 'deck 설정 시트 정리', 25, '설정 시트를 두 단으로 나누고 계정 카드는 위로 올렸습니다.'),
    s(dev, '⌘1 단축키 안 먹음', 44, '조합 중이던 한글 입력이 끝난 뒤에 세션을 바꾸도록 고쳤어요.'),
    s(dev, '배포 점검', 60, 'Build passed. 3 warnings remain in the vite chunk report.', { engine: 'codex', account: 'gpt', imported: true }),
    s(notes, '라우팅 표 개정', 61, ''),
    s(dev, '로그인 버그', 122, '토큰 갱신 타이머가 탭이 잠들 때 멈추는 게 원인이었어요.'),
    s(dev, '인수인계 갱신', 180, 'HANDOFF.md 를 고쳐도 될까요? 권한 요청을 기다리는 중입니다.'),
    // The row from the user's screenshot: a read-only Grok Bot chat whose preview opens with a time.
    s(notes, '서버 점검 알림', 200, '⚠ 12:09(KST) 정기 점검이 끝났어요. 지연된 메시지는 순서대로 다시 보냅니다.', { engine: 'grok', source: 'grokbot', grokBot: { awaitingUserResponse: false, unreadCount: 2, isGroup: false } } as Extra),
    s(deck, '아이콘 대비 계산', 300, 'The glyph on avatar-6 measures 4.9:1, above the 3:1 floor.', { engine: 'gemini', imported: true }),
    s('/Users/me/old', '옮긴 폴더의 세션', 900, '예전 경로에서 하던 작업입니다.', { cwdMissing: true }),
    s(dev, 'PDF 마크다운 변환', 1500, '표가 많은 PDF 는 markitdown 이 더 깔끔했어요.'),
    s(dev, '리눅스 동기화 확인', 1510, ''),
    s(deck, '분할 창 포커스', 1520, '포커스 링이 패널 경계에 가려지던 문제를 고쳤습니다.'),
  ];

const byCwd = new Map<string, SessionEntry[]>();
for (const e of list) byCwd.set(e.cwd, [...(byCwd.get(e.cwd) ?? []), e]);
const projects: ProjectEntry[] = [...byCwd].map(([cwd, sessions]) => ({ cwd, name: cwd.split('/').pop()!, pinned: false, sessions }) as ProjectEntry);
const at = (title: string) => list.find((e) => e.title === title)!;
const pins = avatars ? [list[0], list[1], list[2], list[12]].map((e) => e.sessionId) : ['사이드바 아바타 아이콘', '봇 로그 정리', 'deck 설정 시트 정리'].map((t) => at(t).sessionId);
const current = avatars ? list[2] : at('⌘1 단축키 안 먹음');
const activity: SessionActivity[] = [
  { sessionId: current.sessionId, cwd: current.cwd, turnId: 't', running: true, bg: 0, forMs: 4000 },
  ...(avatars ? [] : [{ sessionId: at('봇 로그 정리').sessionId, cwd: dev, turnId: 'u', running: false, bg: 2, forMs: 0 }]),
];
const unread = avatars ? [list[3].sessionId] : ['사이드바 아바타 아이콘', '로그인 버그'].map((t) => at(t).sessionId);
const waiting = [(avatars ? list[4] : at('인수인계 갱신')).sessionId];
const openPanes = new Map<string, number>([[current.sessionId, 1], [(avatars ? list[13] : at('분할 창 포커스')).sessionId, 2]]);
const noop = () => {};

const aside = renderToStaticMarkup(createElement(Sidebar, {
  projects, currentSessionId: current.sessionId, onOpen: noop, onNew: noop, onRefresh: noop, onArchive: noop, onRename: noop,
  pins, activity, unread, waiting, openPanes, avatar: 'D', onOpenSettings: noop,
}));
if (!aside.startsWith('<aside class="sidebar"')) throw new Error('Sidebar no longer renders <aside class="sidebar">');

const dir = new URL('.', import.meta.url).pathname;
for (const f of files) {
  const path = join(dir, `${f}.html`);
  const html = readFileSync(path, 'utf8');
  let count = 0;
  const out = html.replace(/<aside class="sidebar">[\s\S]*?<\/aside>/g, () => { count++; return aside; });
  if (!count) throw new Error(`${f}.html has no <aside class="sidebar">`);
  writeFileSync(path, out);
  process.stdout.write(`${f}.html: ${count} sidebar(s) rewritten\n`);
}
if (!files.length) process.stdout.write(aside);
