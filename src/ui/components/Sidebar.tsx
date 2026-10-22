import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { EngineKind } from '../../shared/models';
import type { SessionActivity } from '../../shared/protocol';
import type { DesktopSession, ProjectEntry, SessionEntry } from '../../shared/session-types';
import { groupByDate } from '../dateGroups';
import { groupBranches, linksOf, type BranchGroup } from '../../shared/branches';
import { searchTranscripts, type SearchHit } from '../sessionApi';
import { FolderPicker } from './FolderPicker';
import { EngineBadge, EngineMark, engineOf } from './EngineMark';
import { usePinReorder } from '../pinOrder';
import { BlockedDeleteItem, MenuList, deleteBlockedReason, isGrokBotEntry } from './SessionMenu';
import { openInNewTab } from './ShareMenu';
import { isMacPlatform, isPinMod, isSafariBrowser, pinKeyLabel } from '../shortcuts';
import { hasOpenModal } from '../autoReload';
import { useLongPress } from './FileMenu';
import { BrandMark, BrandWordmark } from './BrandMark';
import { AvatarFace, assignMonograms, avatarIndex, monogram, publishSessionAvatars, type MonoRow, type SessionAvatar } from './SessionIcon';
import { SessionIconButton } from './SessionIconPicker';
import { usePrefs } from '../usePrefs';
// Re-exported so existing importers of these avatar helpers keep working after they moved to SessionIcon.
export { AVATAR_COLORS, avatarIndex } from './SessionIcon';

/** 대화 내용 검색 starts at this many characters (the server's minimum), after a short pause in typing. */
export const SEARCH_MIN_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 300;
/** 최근 view: newest sessions across all projects, split by day. */
const MAX_RECENT = 150;
/** How often the rows' "N분 전" (their tooltip, the 갈래 menu line, search hits) is recomputed. */
export const META_TICK_MS = 60_000;

/** Touch: holding a row this long shows its ⋯ button (design §7.2: 350ms). */
export const ROW_PRESS_MS = 350;
/** The head's + menu: 지금 프로젝트 plus this many other recently used folders. */
export const RECENT_FOLDERS = 3;
/** Injected by vite.config.ts (package.json version); absent under vitest. */
declare const __DECK_VERSION__: string | undefined;
/** The avatar menu's last line (spec §3.2/§3.6: 정보 → "deck v…"), an information row that does nothing. */
export const DECK_VERSION_LINE = `AI-MSG ${typeof __DECK_VERSION__ === 'string' ? `v${__DECK_VERSION__}` : '개발 모드'}`;
/** One entry of the avatar (설정 및 계정) menu at the bottom left. */
export type SidebarMenuItem = { label: string; hint?: string; run: () => void };

function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 60_000) return '방금';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  return `${Math.floor(d / 86_400_000)}일 전`;
}

/** A stable default: a fresh [] per render would read as a new list (and hide a revealed row) every time. */
const NO_DESKTOP: DesktopSession[] = [];
const NO_ICONS: Record<string, string> = {};

const baseName = (cwd: string) => cwd.replace(/\/+$/, '').split('/').pop() || cwd;

export function Sidebar({ projects, currentSessionId, onOpen, onNew, onRefresh, onOpenFolder, fetchFn, pins = [], sessionIcons = NO_ICONS, onSetSessionIcon, pinShortcut, onTogglePin, onReorderPins, desktop = NO_DESKTOP, onRename, onArchive, onOpenHit, searchFn, activity = [], unread = [], waiting = [], onOpenSettings, onDelete, onSetCwd, onDuplicate, onNewChat, footMenu, avatar, avatarTitle, onOpenSplit, splitBlocked, openPanes, onOpenPalette }: {
  /** 설정 (avatar menu at the bottom left; ⌘, also opens it — 새 세션 기본 권한 lives there). Used when footMenu is absent. */
  onOpenSettings?: () => void;
  /** The avatar menu's items (설정 / 사용량 / 테마 / 단축키…); absent = just 설정. */
  footMenu?: SidebarMenuItem[];
  /** The avatar's letter (the current account) and the menu's first line. */
  avatar?: string;
  avatarTitle?: string;
  projects: ProjectEntry[];
  currentSessionId: string | null;
  onOpen: (sessionId: string, cwd: string, title: string) => void;
  onNew: (cwd: string, name: string) => void;
  onRefresh: () => void;
  /** F1: a folder chosen in 폴더 열기 (real path, server-validated) → new session there. */
  onOpenFolder?: (cwd: string) => void;
  fetchFn?: typeof fetch;
  /** F2: pinned session ids in display order (top first), shown as 고정됨 above the projects. */
  pins?: string[];
  /** 직접 고른 세션 아이콘 (session id → icon): the avatar shows it instead of the title's first letter. */
  sessionIcons?: Record<string, string>;
  /** Tapping an avatar opens its icon picker; the choice lands here (null = back to the first letter). Absent = no picker. */
  onSetSessionIcon?: (sessionId: string, icon: string | null) => void;
  /**
   * ⌘1 … ⌘9: the sidebar puts its opener here — (index) opens the nth 고정됨 row as shown (same list, same onOpen as a
   * click) and says whether there was one. With it, those rows show their number while ⌘/Ctrl is held.
   */
  pinShortcut?: { current: (index: number, peek?: boolean) => boolean };
  onTogglePin?: (sessionId: string, pinned: boolean) => void;
  /** 고정됨 drag order: the full pin list, top first. Absent = the pinned rows do not reorder. */
  onReorderPins?: (order: string[]) => void;
  /** Recent Claude Desktop sessions (newest first); opened like any session. */
  desktop?: DesktopSession[];
  /** Custom title (null = back to the transcript's own title); stored by deck, the jsonl is untouched. */
  onRename?: (sessionId: string, title: string | null) => void;
  /** 보관 / 보관 해제: archived sessions only show under the "보관됨 N" row at the end of the list, folded until opened. */
  onArchive?: (sessionId: string, archived: boolean) => void;
  /** Enables 대화 내용 검색 (full-text over all transcripts); a clicked hit lands here. */
  onOpenHit?: (hit: SearchHit) => void;
  searchFn?: (q: string) => Promise<{ hits: SearchHit[]; truncated: boolean }>;
  /** Sessions with a running turn or background work (any device): a turning ring at the row's end. */
  activity?: SessionActivity[];
  /** Sessions that finished while not shown: an accent dot at the row's end until opened. */
  unread?: string[];
  /** Sessions with a permission card or question waiting for the user: a warn dot at the row's end (승인 대기). */
  waiting?: string[];
  /** 삭제 (Claude sessions): the app confirms, moves it to the trash and offers undo. `which` names the branch of a 갈래 row. */
  onDelete?: (s: SessionEntry, which?: string) => void;
  /** 작업 폴더 바꾸기 / 복제 (servers with 'sessionOps'); absent = no such items. */
  onSetCwd?: (s: SessionEntry) => void;
  onDuplicate?: (sessionId: string) => void;
  /** 새 세션 (first item of the head's "+" menu): same as ⌘N — a new chat in the current pane's folder. */
  onNewChat?: () => void;
  /** ⋯ 분할 보기로 열기: the session in a new split pane. Absent = no such item (a phone). */
  onOpenSplit?: (sessionId: string, cwd: string, title: string) => void;
  /** Why 분할 보기로 열기 cannot run now (all panes in use): the item shows disabled with this as its title. */
  splitBlocked?: string | null;
  /** Sessions open in a pane (its split number, left to right) or only in a floating card: a marker on their rows. */
  openPanes?: ReadonlyMap<string, number | 'float'>;
  /** ⌘K: a button next to the opened search box (a phone's second way to the palette). Absent = no button. */
  onOpenPalette?: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [{ pinnedFolded }, setPref] = usePrefs();
  // "N분 전" (row tooltips, the 갈래 menu line) moves on by itself: the rows re-render every minute even when no index arrives.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), META_TICK_MS); return () => clearInterval(t); }, []);
  const [footOpen, setFootOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBtn = useRef<HTMLButtonElement>(null);
  const plusBtn = useRef<HTMLButtonElement>(null);
  /** Closing the box by Esc hands the focus back to the 검색 button (it would fall to <body> with the box gone). */
  const closeSearch = (refocus = false) => { setSearchOpen(false); setQuery(''); if (refocus) searchBtn.current?.focus(); };
  // Touch: a long press on a row shows its ⋯ (a mouse gets it on hover). One row at a time; it hides again on a press
  // anywhere outside that row, a scroll of the list, opening a session, or a new list.
  const [revealed, setRevealed] = useState<string | null>(null);
  const pressRow = useRef<string | null>(null);
  // The row's own open button (.row-open) is the row: a press on it may become a long press; its other buttons may not.
  const press = useLongPress(() => { if (!pressRow.current) return false; setRevealed(pressRow.current); }, { ms: ROW_PRESS_MS, ignore: 'button:not(.row-open), input, a, [role="menu"]' });
  useEffect(() => {
    if (!revealed) return;
    const outside = (e: PointerEvent) => {
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>('li[data-row]') : null;
      if (row?.dataset.row !== revealed) setRevealed(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [revealed]);
  useEffect(() => { setRevealed(null); }, [projects, desktop]);
  const open = (sessionId: string, cwd: string, title: string) => { setRevealed(null); onOpen(sessionId, cwd, title); };
  // ⌘/⌃ (Ctrl off a Mac) held alone, no dialog open: the 고정됨 rows show ⌘1 … ⌘9 (⌃1 … ⌃9 in Safari). Cleared on blur / hide, where the keyup never arrives.
  const [modHeld, setModHeld] = useState(false);
  const pinKeys = !!pinShortcut;
  useEffect(() => {
    if (!pinKeys) return;
    const mac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => setModHeld(isPinMod(e, mac) && !hasOpenModal());
    const clear = () => setModHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', clear); };
  }, [pinKeys]);
  // Keyed `${group}:${sessionId}`: a pinned session is listed twice and only the clicked copy opens its menu / editor.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [found, setFound] = useState<{ q: string; hits: SearchHit[]; truncated: boolean; error: string | null } | null>(null);

  const q = query.trim().toLowerCase();
  const match = (s: SessionEntry) => !q || s.title.toLowerCase().includes(q);
  const inView = (s: { archived?: boolean }) => !s.archived;
  const canEdit = !!(onRename || onArchive || onDelete || onOpenSplit || onTogglePin);

  // 대화 내용 검색: debounced; a stale answer (query changed meanwhile) is dropped.
  const fullQ = query.trim();
  const fullOn = !!onOpenHit && fullQ.length >= SEARCH_MIN_CHARS;
  useEffect(() => {
    if (!fullOn) { setFound(null); return; }
    let live = true;
    const run = searchFn ?? ((x: string) => searchTranscripts(x, fetchFn));
    const t = setTimeout(() => {
      run(fullQ).then(
        (r) => { if (live) setFound({ q: fullQ, hits: r.hits, truncated: r.truncated, error: null }); },
        (err: unknown) => { if (live) setFound({ q: fullQ, hits: [], truncated: false, error: err instanceof Error ? err.message : '검색 실패' }); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [fullOn, fullQ, searchFn, fetchFn]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!(e.target instanceof Element && e.target.closest('.session-menu'))) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const splitItem = (t: { sessionId: string; cwd: string; title: string }) => onOpenSplit && (splitBlocked
    ? <button type="button" role="menuitem" aria-disabled="true" title={splitBlocked}>분할 보기로 열기</button>
    : <button type="button" role="menuitem" onClick={() => { setMenu(null); onOpenSplit(t.sessionId, t.cwd, t.title); }}>분할 보기로 열기</button>);
  const tabItem = (sessionId: string) => <button type="button" role="menuitem" onClick={() => { setMenu(null); openInNewTab(sessionId); }}>새 탭에서 열기</button>;
  const startEdit = (s: SessionEntry, key: string) => { if (!onRename) return; setMenu(null); setEditing({ id: key, text: s.title }); };
  const commitEdit = (s: SessionEntry, key: string) => {
    if (!editing || editing.id !== key) return;
    const v = editing.text.replace(/\s+/g, ' ').trim();
    setEditing(null);
    if (v !== s.title) onRename?.(s.sessionId, v || null);
  };
  const pinSet = new Set(pins);
  const byId = new Map<string, SessionEntry>();
  for (const p of projects) for (const s of p.sessions) byId.set(s.sessionId, s);
  const desktopById = new Map(desktop.map((d) => [d.sessionId, d]));
  const dMatch = (d: DesktopSession) => !q || d.title.toLowerCase().includes(q) || d.project.toLowerCase().includes(q);
  // 고정됨 holds deck sessions and Desktop-only ones alike; each session is listed once — pinned rows leave the lists below.
  type PinnedItem = { kind: 'session'; s: SessionEntry } | { kind: 'desktop'; d: DesktopSession };
  const pinned = pins.flatMap((id): PinnedItem[] => {
    const s = byId.get(id);
    if (s) return inView(s) && match(s) ? [{ kind: 'session', s }] : [];
    const d = desktopById.get(id);
    return d && inView(d) && dMatch(d) ? [{ kind: 'desktop', d }] : [];
  });
  // 고정됨 rows reorder by drag (touch: long-press) or Alt+↑/↓; hidden pins (filtered out) keep their place.
  const reorderKeys = (group: string) => (group === 'pinned' && onReorderPins ? 'Alt+ArrowUp Alt+ArrowDown' : undefined);
  const pinDrag = usePinReorder(pinned.map((it) => (it.kind === 'session' ? it.s.sessionId : it.d.sessionId)), pins, onReorderPins);
  // ⌘1 … ⌘9 reads the very list the 고정됨 section renders (filters included), so a number is always the row showing it.
  if (pinShortcut) {
    pinShortcut.current = (index, peek) => {
      const it = pinned[index];
      if (!it) return false;
      if (peek) return true;
      const t = it.kind === 'session' ? it.s : it.d;
      open(t.sessionId, t.cwd, t.title);
      return true;
    };
  }
  // Gone with the sidebar (signed out): the key listener outlives it and must not open into a hidden pane.
  useEffect(() => () => { if (pinShortcut) pinShortcut.current = () => false; }, [pinShortcut]);
  const pinKey = (index: number) => (modHeld ? pinKeyLabel(index, isMacPlatform(), isSafariBrowser()) : null);

  const actById = new Map(activity.map((a) => [a.sessionId, a]));
  const unreadSet = new Set(unread);
  const waitingSet = new Set(waiting);
  /**
   * The row's one status mark (its end), by priority: 승인 대기 (warn dot: it needs the user) → 응답 중 / 백그라운드 (a
   * turning ring) → 안 읽음 (accent dot). `label` names every fact that holds, for the mark's aria-label and tooltip —
   * the row no longer says them in words. A 갈래 row: any member. `extra`: a Grok Bot roster's own unread count, and its
   * 답장 대기 (the bot waits on the user: the same warn mark as 승인 대기).
   */
  const status = (ids: string[], extra: RowExtra = {}): { kind: 'waiting' | 'running' | 'bg' | 'unread'; label: string } | null => {
    const extraUnread = extra.unread ?? 0;
    const acts = ids.map((id) => actById.get(id)).filter((a): a is SessionActivity => !!a);
    const approvals = ids.some((id) => waitingSet.has(id));
    const waits = approvals || !!extra.awaiting;
    const runs = acts.some((a) => a.running);
    const bg = acts.reduce((n, a) => n + a.bg, 0);
    const unreadN = ids.filter((id) => unreadSet.has(id)).length + extraUnread;
    const facts = [approvals && '승인 대기', extra.awaiting && '답장 대기', runs && '응답 중', bg > 0 && `백그라운드 ${bg}개`, unreadN > 0 && (unreadN > 1 ? `안 읽음 ${unreadN}` : '안 읽음')].filter((x): x is string => !!x);
    if (!facts.length) return null;
    return { kind: waits ? 'waiting' : runs ? 'running' : bg > 0 ? 'bg' : 'unread', label: facts.join(' · ') };
  };
  /** 분할 N / 떠 있는 카드: the session is open already. A 갈래 row: any member. */
  const openAt = (ids: string[]) => {
    const at = ids.map((id) => openPanes?.get(id)).find((x) => x !== undefined);
    if (at === undefined) return null;
    return { at, label: at === 'float' ? '떠 있는 카드에 열림' : openSlotLabel(at) };
  };
  /**
   * The row's end: one quiet mark, or nothing (Grok Bot's list). A status wins; with none, a session open in a pane shows
   * its split number (◱ a card) in the faint text colour. Whatever the mark leaves out is in its aria-label / tooltip.
   */
  const statusMark = (ids: string[], marked: boolean, extra: RowExtra = {}) => {
    const st = status(ids, extra);
    const open = marked ? openAt(ids) : null;
    if (st) {
      const label = open ? `${st.label} · ${open.label}` : st.label;
      return <span className={`row-status ${st.kind}`} role="img" aria-label={label} title={label} />;
    }
    if (open) return <span className="row-status open open-mark" role="img" aria-label={open.label} title={open.label}>{open.at === 'float' ? '◱' : open.at}</span>;
    return null;
  };
  // 고정됨 folded: the session open now stays as a row; the rest fold away, their highest status (승인 대기 > 안 읽음 >
  // 응답 중) shown on the head so it doesn't vanish with them.
  const pinnedId = (it: PinnedItem) => (it.kind === 'session' ? it.s.sessionId : it.d.sessionId);
  const pinnedShown = pinnedFolded ? pinned.filter((it) => pinnedId(it) === currentSessionId) : pinned;
  const foldedMark = (() => {
    if (!pinnedFolded) return null;
    const hidden = pinned.filter((it) => !pinnedShown.includes(it));
    const bot = (it: PinnedItem) => (it.kind === 'session' ? it.s.grokBot : undefined);
    if (hidden.some((it) => waitingSet.has(pinnedId(it)) || !!bot(it)?.awaitingUserResponse)) return { kind: 'waiting', label: '고정됨에 승인 대기' };
    if (hidden.some((it) => unreadSet.has(pinnedId(it)) || (bot(it)?.unreadCount ?? 0) > 0)) return { kind: 'unread', label: '고정됨에 안 읽음' };
    if (hidden.some((it) => actById.get(pinnedId(it))?.running)) return { kind: 'running', label: '고정됨에 응답 중' };
    return null;
  })();
  /**
   * The row's avatar (§3.2): project colour + the title's first letter (two when a neighbour of the project would show the
   * same one: assignMonograms), or the icon the user chose. Nothing on its edge — status, engine and open marks live at
   * the row's end and on the second line.
   */
  const avatarOf = (slug: string, sessionId: string, title: string) => (
    <span className="row-avatar" data-avatar={avatarIndex(slug)} style={{ '--av': `var(--avatar-${avatarIndex(slug)})` } as CSSProperties}>
      <AvatarFace mono={monos.get(sessionId) ?? monogram(title, slug)} icon={sessionIcons[iconKey(sessionId)] ?? null} />
    </span>
  );
  /** 직접 고르기: a button over the avatar (beside the row's open button, so a tap there never opens the session). */
  const avatarPick = (sessionId: string) => onSetSessionIcon && (
    <SessionIconButton className="row-avatar-pick" current={sessionIcons[iconKey(sessionId)] ?? null} onPick={(icon) => onSetSessionIcon(iconKey(sessionId), icon)} />
  );
  /**
   * Line 2: the last reply's preview when there is one, else the project folder. Only a non-Claude engine gets a mark (a
   * 12px muted glyph up front); a row deck cannot continue gets a one-word tag. Statuses are the row end's job.
   */
  const metaLine = (p: { engine: EngineKind; tag?: string | null; text: string; title?: string; folder?: string | null }) => (
    <span className="session-meta" {...(p.title ? { title: p.title } : {})}>
      {p.engine !== 'claude' && <MetaEngine engine={p.engine} />}
      {p.tag && <span className="meta-tag">{p.tag}</span>}
      {p.folder && <span className="meta-folder" data-testid="meta-folder">{p.folder}</span>}
      {p.folder && <span className="meta-sep" aria-hidden="true">·</span>}
      <span className="meta-text">{p.text}</span>
    </span>
  );
  const rowClass = (active: boolean) => (active ? 'session-item active' : 'session-item');
  // An attribute, not a class: a re-render must not wipe the 고정됨 drag's own classes (pin-dragging) on the same press.
  const rowProps = (key: string) => ({ 'data-row': key, ...(revealed === key ? { 'data-revealed': '' } : {}) });
  /** The row's open button: Tab reaches it, Enter / Space open it; the current session says so (aria-current). */
  const openButton = (p: { current: boolean; keys?: string; onOpen: (detail: number) => void; children: ReactNode }) => (
    <button type="button" className="row-open" aria-current={p.current ? 'page' : undefined} aria-keyshortcuts={p.keys}
      onClick={(e) => p.onOpen(e.detail)}>{p.children}</button>
  );
  const moreButton = (key: string, group: string, title: string) => (
    <span className="row-end">
      <button type="button" className="row-more-btn" aria-keyshortcuts={reorderKeys(group)} aria-label="세션 메뉴" title={title} aria-haspopup="menu" aria-expanded={menu === key}
        onClick={(e) => { e.stopPropagation(); setMenu((m) => (m === key ? null : key)); }}>⋯</button>
    </span>
  );

  /** `tree`: a 메시지 편집 갈래 tree shown as this one row — a click opens its newest session. */
  const row = (s: SessionEntry, group: string, tree?: BranchGroup<SessionEntry>, keyHint?: string | null) => {
    const on = pinSet.has(s.sessionId);
    const key = `${group}:${s.sessionId}`;
    const edit = editing?.id === key ? editing : null;
    const members = tree?.members ?? [s.sessionId];
    const openId = tree?.openId ?? s.sessionId;
    const target = byId.get(openId) ?? s;
    // The row's menu acts on the session a click opens (the newest version of a 갈래 tree), and says which one it is.
    const order = members.map((id) => byId.get(id)).filter((x): x is SessionEntry => !!x).sort((a, b) => a.lastModified - b.lastModified);
    const which = members.length > 1 ? `갈래 ${order.findIndex((x) => x.sessionId === target.sessionId) + 1}/${members.length} · ${ago(target.lastModified, now)} 수정` : undefined;
    const slug = projectName.get(s.sessionId) ?? baseName(s.cwd);
    const more = canEdit && !edit;
    const current = !!currentSessionId && members.includes(currentSessionId);
    const engine = engineOf(target);
    // A 갈래 row shows its newest version (`target`): title and preview both come from it.
    const preview = oneLine(target.preview);
    // Another row shows the same title: line 2 leads with the folder (when the preview would otherwise hide it).
    const folder = preview && (titleCount.get(target.title) ?? 0) > 1 ? slug : null;
    const meta = metaLine({ engine, tag: rowTag(s), text: preview || slug, folder, ...(s.imported ? { title: importTitle(s) } : {}) });
    const avatarEl = avatarOf(slug, s.sessionId, target.title);
    // The row's tooltip keeps what the row stopped showing: folder, engine, run kind, 갈래, the time.
    const facts = [slug, engine !== 'claude' ? ENGINE_NAME[engine] ?? engine : null, s.codexExec || s.autoRun ? '자동 실행' : null, ...grokBotTags(s).filter((t) => !t.startsWith('안 읽음')), s.codexArchived ? 'Codex 보관' : null, s.cwdMissing ? '폴더 없음' : null, members.length > 1 ? `갈래 ${members.length}` : null, ago(target.lastModified, now)];
    // Screen readers get the same facts in the button (the li title is mouse-only), less what the row already says:
    // the folder when line 2 shows it, the tag, and the statuses the end mark's label names.
    const spoken = facts.filter((f): f is string => !!f && !(f === slug && !preview) && f !== rowTag(s) && f !== '답장 대기');
    return (
      <li key={s.sessionId} {...rowProps(key)} className={rowClass(current)} title={`${target.title}\n${facts.filter(Boolean).join(' · ')}`}
        onContextMenu={canEdit ? (e) => { e.preventDefault(); setMenu(key); } : undefined}>
        {edit ? (
          // Renaming: an input cannot sit inside a button, so the row is plain for the while.
          <span className="row-open">
            {avatarEl}
            <span className="row-text">
              <input className="session-rename" aria-label="세션 이름" value={edit.text} autoFocus maxLength={200}
                onChange={(e) => setEditing({ id: key, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') { e.preventDefault(); commitEdit(target, key); }
                  if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                }}
                onBlur={() => commitEdit(target, key)} onClick={(e) => e.stopPropagation()} />
              {meta}
            </span>
          </span>
        ) : openButton({
          current, keys: reorderKeys(group),
          // The second click of a double-click (rename) must not re-open the session.
          onOpen: (detail) => { if (detail <= 1) open(target.sessionId, target.cwd, target.title); },
          children: (
            <>
              {avatarEl}
              <span className="row-text">
                <span className="session-title" onDoubleClick={onRename ? (e) => { e.stopPropagation(); startEdit(target, key); } : undefined}>{target.title}</span>
                {meta}
              </span>
              {statusMark(members, true, { unread: s.grokBot?.unreadCount ?? 0, awaiting: !!s.grokBot?.awaitingUserResponse })}
              <span className="sr-only">{`, ${spoken.join(', ')}`}</span>
            </>
          ),
        })}
        {!edit && avatarPick(s.sessionId)}
        {/* ⋯: shown on hover or keyboard focus (a mouse), after a long press (touch), or while the menu is open */}
        {more && moreButton(key, group, '이름 바꾸기 · 보관 · 삭제')}
        {keyHint && !edit && <kbd className="pin-key" aria-hidden="true">{keyHint}</kbd>}
        {menu === key && (
          <MenuList onClose={() => setMenu(null)}>
            {which && <div className="session-menu-which muted" data-testid="session-menu-which">{which}</div>}
            {onRename && <button type="button" role="menuitem" onClick={() => startEdit(target, key)}>이름 바꾸기</button>}
            {splitItem(target)}
            {tabItem(target.sessionId)}
            {onTogglePin && <button type="button" role="menuitem" onClick={() => { setMenu(null); onTogglePin(s.sessionId, !on); }}>{on ? '고정 해제' : '맨 위에 고정'}</button>}
            {/* Archived in Codex: only the Codex app can unarchive it. */}
            {onArchive && !target.codexArchived && <button type="button" role="menuitem" onClick={() => { setMenu(null); onArchive(target.sessionId, !target.archived); }}>{target.archived ? '보관 해제' : '보관'}</button>}
            {onSetCwd && (target.engine ?? 'claude') !== 'gemini' && target.engine !== 'grok' && <button type="button" role="menuitem" onClick={() => { setMenu(null); onSetCwd(target); }}>작업 폴더 바꾸기</button>}
            {onDuplicate && !isGrokBotEntry(target) && <button type="button" role="menuitem" onClick={() => { setMenu(null); onDuplicate(target.sessionId); }}>복제</button>}
            {/* GPT / Gemini / Codex-app sessions: shown disabled with the reason, so it is clear why they stay. */}
            {onDelete && (deleteBlockedReason(target)
              ? <BlockedDeleteItem reason={deleteBlockedReason(target)!} />
              : <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(null); onDelete(target, which); }}>삭제…</button>)}
          </MenuList>
        )}
      </li>
    );
  };

  /** A Claude Desktop session outside deck's projects: opens like any session; its menu has 분할 / 새 탭 / 고정. */
  const desktopRow = (d: DesktopSession, group: string, keyHint?: string | null) => {
    const on = pinSet.has(d.sessionId);
    const key = `${group}:${d.sessionId}`;
    const more = !!(onTogglePin || onOpenSplit);
    return (
      <li key={d.sessionId} {...rowProps(key)} className={rowClass(d.sessionId === currentSessionId)} title={`${d.title}\n${d.project} · Desktop · ${ago(d.lastModified, now)}\n${d.cwd}`}>
        {openButton({
          current: d.sessionId === currentSessionId, keys: onTogglePin ? reorderKeys(group) : undefined,
          onOpen: () => open(d.sessionId, d.cwd, d.title),
          children: (
            <>
              {avatarOf(d.project, d.sessionId, d.title)}
              <span className="row-text">
                <span className="session-title">{d.title}</span>
                {metaLine({ engine: 'claude', text: d.project })}
              </span>
              {statusMark([d.sessionId], true)}
              <span className="sr-only">{`, Desktop, ${ago(d.lastModified, now)}`}</span>
            </>
          ),
        })}
        {avatarPick(d.sessionId)}
        {more && moreButton(key, onTogglePin ? group : '', [onOpenSplit && '분할 보기로 열기', onTogglePin && '고정'].filter(Boolean).join(' · '))}
        {keyHint && <kbd className="pin-key" aria-hidden="true">{keyHint}</kbd>}
        {menu === key && more && (
          <MenuList onClose={() => setMenu(null)}>
            {splitItem(d)}
            {tabItem(d.sessionId)}
            {onTogglePin && <button type="button" role="menuitem" onClick={() => { setMenu(null); onTogglePin(d.sessionId, !on); }}>{on ? '고정 해제' : '맨 위에 고정'}</button>}
          </MenuList>
        )}
      </li>
    );
  };

  const projectName = new Map<string, string>();
  for (const p of projects) for (const s of p.sessions) if (!projectName.has(s.sessionId)) projectName.set(s.sessionId, p.name);
  // 메시지 편집 갈래: one row per branch tree (its root, opening the newest version); the tree's other sessions are not listed.
  // A deleted root (휴지통) just drops out: its children keep their link and group under the oldest one left.
  const links = linksOf(byId.values());
  // A 갈래 tree's chosen icon is stored under its entry (the root, or the oldest version left): every row and head of the
  // tree — a pinned version included — reads and sets that one.
  const treeOf = new Map<string, BranchGroup<SessionEntry>>();
  for (const g of groupBranches([...byId.values()], links)) for (const m of g.members) treeOf.set(m, g);
  const iconKey = (id: string) => treeOf.get(id)?.entry.sessionId ?? id;
  // deck sessions and Desktop-only sessions in one date-split list, minus what 고정됨 already shows.
  type RecentItem = { kind: 'session'; g: BranchGroup<SessionEntry>; lastModified: number } | { kind: 'desktop'; d: DesktopSession; lastModified: number };
  const itemMatch = (t: RecentItem) => (t.kind === 'session' ? match(t.g.entry) : dMatch(t.d));
  // Before the 세션 검색 filter: the session glyphs step past neighbours here, so a search never changes a row's glyph.
  // A Desktop session whose folder deck already lists shows there; the Desktop rows only carry the rest.
  const recentAll: RecentItem[] = [
    ...groupBranches([...byId.values()].filter(inView), links).filter((g) => !pinSet.has(g.entry.sessionId)).map((g): RecentItem => ({ kind: 'session', g, lastModified: g.entry.lastModified })),
    ...desktop.filter((d) => !byId.has(d.sessionId) && !pinSet.has(d.sessionId) && inView(d)).map((d): RecentItem => ({ kind: 'desktop', d, lastModified: d.lastModified })),
  ].sort((a, b) => b.lastModified - a.lastModified);
  const recentList = recentAll.filter(itemMatch).slice(0, MAX_RECENT);
  // 보관됨 N: archived sessions (pinned or not) and archived Desktop-only ones, newest first, in one folded section at the end.
  // The count is all a folded row needs: the rows are only built (and sorted) once it is open; neither on every tick.
  const archived = useMemo(() => {
    if (!onArchive) return { count: 0, list: [] as RecentItem[], all: [] as RecentItem[] };
    const all = projects.flatMap((p) => p.sessions);
    const groupsAll = groupBranches(all.filter((s) => s.archived), linksOf(all));
    const dsAll = desktop.filter((d) => d.archived && !all.some((s) => s.sessionId === d.sessionId));
    const groups = groupsAll.filter((g) => match(g.entry));
    const ds = dsAll.filter(dMatch);
    // `all`: the open list before the search filter (session glyphs, as recentAll).
    const listAll = archivedOpen
      ? [...groupsAll.map((g): RecentItem => ({ kind: 'session', g, lastModified: g.entry.lastModified })), ...dsAll.map((d): RecentItem => ({ kind: 'desktop', d, lastModified: d.lastModified }))].sort((a, b) => b.lastModified - a.lastModified)
      : [];
    return { count: groups.length + ds.length, list: listAll.filter(itemMatch), all: listAll };
    // match / dMatch read only `q`.
  }, [projects, desktop, q, archivedOpen, !!onArchive]); // eslint-disable-line react-hooks/exhaustive-deps
  // Avatar letters: over the pins and the rows below together (their order never matters), before the search filter. A 갈래
  // row carries its other members, so the head of any version shows (and changes) the row's avatar.
  type AvatarRow = MonoRow & { members?: string[] };
  const monoRow = (id: string, s: SessionEntry): AvatarRow => ({ id, project: projectName.get(id) ?? baseName(s.cwd), title: s.title });
  const listRow = (t: RecentItem): AvatarRow => (t.kind === 'session'
    ? { ...monoRow(t.g.entry.sessionId, byId.get(t.g.openId) ?? t.g.entry), members: t.g.members }
    : { id: t.d.sessionId, project: t.d.project, title: t.d.title });
  const pinRows = pins.flatMap((id): AvatarRow[] => {
    const s = byId.get(id);
    if (s) return inView(s) ? [monoRow(id, s)] : [];
    const d = desktopById.get(id);
    return d && inView(d) ? [{ id, project: d.project, title: d.title }] : [];
  });
  const restRows = [...recentAll.slice(0, MAX_RECENT), ...archived.all].map(listRow);
  const monos = assignMonograms(pinRows, restRows);
  // The session head (top bar / pane) shows the same avatar as the row: colour by the row's project, the letters assigned,
  // the chosen icon; its picker changes the row's.
  useEffect(() => {
    const next = new Map<string, SessionAvatar>();
    for (const r of [...pinRows, ...restRows]) {
      const key = iconKey(r.id);
      const a: SessionAvatar = { color: avatarIndex(r.project), mono: monos.get(r.id) ?? monogram(r.title, r.project), icon: sessionIcons[key] ?? null, iconId: key };
      if (!next.has(r.id)) next.set(r.id, a);
      for (const m of r.members ?? treeOf.get(r.id)?.members ?? []) if (!next.has(m)) next.set(m, a);
    }
    publishSessionAvatars(next, sessionIcons, onSetSessionIcon ?? null);
  });
  // Same-titled rows (as shown: a 갈래 tree counts once, by its newest version) tell apart by their folder.
  const titleCount = new Map<string, number>();
  const countTitle = (t: string) => titleCount.set(t, (titleCount.get(t) ?? 0) + 1);
  for (const it of pinned) countTitle(it.kind === 'session' ? it.s.title : it.d.title);
  for (const t of [...recentList, ...archived.list]) countTitle(t.kind === 'session' ? (byId.get(t.g.openId) ?? t.g.entry).title : t.d.title);
  // A full-text hit in an archived session shows once 보관됨 is open (as its row does).
  const hitsShown = (found && found.q === fullQ ? found.hits : []).filter((h) => { const s = byId.get(h.sessionId); return !s || !s.archived || archivedOpen; });
  const searching = fullOn && found?.q !== fullQ;
  const menuItems: SidebarMenuItem[] = footMenu ?? (onOpenSettings ? [{ label: '설정', hint: `${isMacPlatform() ? '⌘' : 'Ctrl+'},`, run: onOpenSettings }] : []);
  const mod = isMacPlatform() ? '⌘' : 'Ctrl+';
  // + menu folders (§3.2 / §8-1): the current session's project, then the other projects by their newest session.
  const currentCwd = currentSessionId ? (byId.get(currentSessionId)?.cwd ?? desktopById.get(currentSessionId)?.cwd) : undefined;
  const hereProject = currentCwd !== undefined ? projects.find((p) => p.cwd === currentCwd) : undefined;
  const newest = (p: ProjectEntry) => p.sessions.reduce((m, s) => Math.max(m, s.lastModified), 0);
  const recentFolders = projects.filter((p) => p !== hereProject).map((p) => ({ p, t: newest(p) })).sort((a, b) => b.t - a.t).slice(0, RECENT_FOLDERS).map((x) => x.p);
  /** A + menu item that leaves the focus with + (an item opening its own screen takes it from there). */
  const plusItem = (run: () => void) => () => { setNewMenu(false); plusBtn.current?.focus(); run(); };
  const folderItem = (p: ProjectEntry, here: boolean) => (
    <button key={p.cwd} type="button" role="menuitem" aria-label={`${p.name} 새 세션${here ? ' (지금 프로젝트)' : ''}`} title={p.cwd} onClick={plusItem(() => onNew(p.cwd, p.name))}>
      <span>{p.name}</span>{here && <span className="menu-tag">지금</span>}
    </button>
  );
  return (
    <aside className="sidebar" {...press}
      onPointerDown={(e) => {
        // Which row a long press would reveal (a press elsewhere hides the one shown: the document listener above).
        const li = e.target instanceof Element ? e.target.closest<HTMLElement>('li[data-row]') : null;
        pressRow.current = li?.dataset.row ?? null;
        press.onPointerDown(e);
      }}
      onScroll={revealed ? () => setRevealed(null) : undefined}>
      <div className="sidebar-head">
        <span className="sidebar-brand"><BrandMark className="sidebar-brand-mark" /><BrandWordmark /></span>
        <span className="grow" />
        <button ref={searchBtn} type="button" className="icon-btn" aria-label="검색" title="세션 검색" aria-expanded={searchOpen} onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}><SearchIcon /></button>
        <span className="new-menu-wrap">
          <button ref={plusBtn} type="button" className="icon-btn" aria-label="새 세션" title="새 세션 · 폴더 열기" aria-haspopup="menu" aria-expanded={newMenu} onClick={() => setNewMenu((o) => !o)}><PlusIcon /></button>
          {newMenu && (
            <MenuList className="session-menu new-menu" label="새 세션" onClose={() => setNewMenu(false)}>
              {onNewChat && <button type="button" role="menuitem" onClick={plusItem(onNewChat)}><span>새 세션</span><kbd>{mod}N</kbd></button>}
              {onOpenFolder && <button type="button" role="menuitem" title="아무 폴더에서 새 세션" onClick={plusItem(() => setPicking(true))}><span>폴더 열기…</span></button>}
              {(hereProject || recentFolders.length > 0) && <div className="menu-sep" role="separator" />}
              {hereProject && folderItem(hereProject, true)}
              {recentFolders.map((p) => folderItem(p, false))}
              <div className="menu-sep" role="separator" />
              <button type="button" role="menuitem" onClick={plusItem(onRefresh)}><span>세션 목록 다시 읽기</span></button>
            </MenuList>
          )}
        </span>
      </div>
      {picking && onOpenFolder && <FolderPicker onOpen={(cwd) => { setPicking(false); onOpenFolder(cwd); }} onClose={() => { setPicking(false); plusBtn.current?.focus(); }} {...(fetchFn ? { fetchFn } : {})} />}
      {searchOpen && (
        <div className="sidebar-search-row">
          <label className="sidebar-search">
            <SearchIcon />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="세션 검색" aria-label="세션 검색" autoFocus
              onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); closeSearch(true); } }} />
          </label>
          {onOpenPalette && <button type="button" className="icon-btn" aria-label="명령 팔레트" title={`명령 팔레트 (${mod}K)`} onClick={onOpenPalette}>{mod === '⌘' ? '⌘K' : 'K'}</button>}
        </div>
      )}
      {pinned.length > 0 && (
        <section className={`project pinned-group${pinnedFolded ? ' collapsed' : ''}`} data-testid="pinned-group">
          <div className="project-head">
            <button type="button" className="project-head-btn" aria-expanded={!pinnedFolded} aria-controls="pinned-list" title={pinnedFolded ? '고정됨 펼치기' : '고정됨 접기'}
              onClick={() => setPref({ type: 'set', key: 'pinnedFolded', value: !pinnedFolded })}>
              <Chevron /><span className="project-name">고정됨</span>
            </button>
            {foldedMark && <span className={`row-status ${foldedMark.kind}`} role="img" aria-label={foldedMark.label} title={foldedMark.label} data-testid="pinned-folded-status" />}
          </div>
          <ul id="pinned-list" hidden={pinnedFolded && !pinnedShown.length} {...pinDrag.listProps}>{pinned.map((it, i) => (!pinnedShown.includes(it) ? null : it.kind === 'session' ? row(it.s, 'pinned', undefined, pinKey(i)) : desktopRow(it.d, 'pinned', pinKey(i))))}</ul>
          <span className="sr-only" role="status" aria-live="polite">{pinDrag.live}</span>
        </section>
      )}
      {projects.length === 0 && desktop.length === 0 && <div className="muted sidebar-empty">아직 대화가 없어요. 위 + 메뉴의 폴더 열기로 작업할 폴더를 고른 뒤, 새 세션으로 시작해 보세요.</div>}
      {groupByDate(recentList).map((g) => (
        <section key={g.label} className="project date-group" data-testid={`date-group-${g.label}`}>
          <div className="project-head"><span className="project-name">{g.label}</span></div>
          <ul>{g.items.map((t) => (t.kind === 'session' ? row(t.g.entry, 'recent', t.g) : desktopRow(t.d, 'recent')))}</ul>
        </section>
      ))}
      {q && recentList.length === 0 && pinned.length === 0 && archived.count === 0 && hitsShown.length === 0 && !searching && <div className="muted sidebar-empty">“{query}” 와 맞는 세션이 없습니다.</div>}
      {onArchive && (!q || archived.count > 0) && (
        <section className={`project archived-group ${archivedOpen ? '' : 'collapsed'}`} data-testid="archived-group">
          <button type="button" className="archived-row" aria-expanded={archivedOpen} aria-label={`보관됨 ${archived.count}`} onClick={() => setArchivedOpen((o) => !o)}>
            <Chevron />
            <span className="project-name">보관됨</span>
            <span className="archived-count">{archived.count}</span>
          </button>
          {archivedOpen && (archived.list.length === 0
            ? <div className="muted sidebar-empty">보관된 세션이 없습니다.</div>
            : <ul>{archived.list.map((t) => (t.kind === 'session' ? row(t.g.entry, 'archived', t.g) : desktopRow(t.d, 'archived')))}</ul>)}
        </section>
      )}
      {fullOn && (searching || hitsShown.length > 0 || found?.error) && (
        <section className="project search-group" data-testid="search-group">
          <div className="project-head"><span className="project-name">대화 내용</span></div>
          {searching && hitsShown.length === 0 && <div className="muted sidebar-empty">검색 중…</div>}
          {found?.error && <div className="error sidebar-empty">{found.error}</div>}
          <ul>
            {hitsShown.map((h, i) => (
              <li key={`${h.sessionId}-${i}`} className="search-hit" title={`${h.title}\n${h.cwd}`}>
                <button type="button" className="row-open" onClick={() => onOpenHit?.(h)}>
                  <span className="session-row">
                    <span className="session-title"><EngineMark engine={h.engine} decorative />{h.title}</span>
                    <span className="session-meta">{h.role === 'user' ? '나' : h.engine === 'codex' ? 'GPT' : 'Claude'} · {ago(h.lastModified, now)}</span>
                  </span>
                  <span className="search-snippet">
                    {h.snippet.slice(0, h.matchStart)}<mark>{h.snippet.slice(h.matchStart, h.matchStart + h.matchLength)}</mark>{h.snippet.slice(h.matchStart + h.matchLength)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {found?.q === fullQ && found.truncated && <div className="muted sidebar-empty">결과 일부만 표시됩니다.</div>}
        </section>
      )}
      {menuItems.length > 0 && (
        // The avatar (settings/account) bottom left; the list scrolls under it behind a fade. 새 세션 lives in the head's + menu (and ⌘N).
        <div className="sidebar-foot">
          <span className="foot-menu-wrap">
            <button type="button" className="sidebar-avatar" aria-haspopup="menu" aria-expanded={footOpen} aria-label="설정 및 계정" title="설정 및 계정" onClick={() => setFootOpen((o) => !o)}>
              {avatar ?? 'D'}
            </button>
            {footOpen && (
              <MenuList className="session-menu foot-menu" label="설정 및 계정" onClose={() => setFootOpen(false)}>
                {avatarTitle && <div className="foot-menu-head">{avatarTitle}</div>}
                {menuItems.map((it) => (
                  <button key={it.label} type="button" role="menuitem" onClick={() => { setFootOpen(false); it.run(); }}>
                    <span>{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}
                  </button>
                ))}
                <button type="button" role="menuitem" aria-disabled="true" className="foot-menu-version" data-testid="foot-menu-version">{DECK_VERSION_LINE}</button>
              </MenuList>
            )}
          </span>
        </div>
      )}
    </aside>
  );
}

/** Tooltip of an imported row's meta: where it came from and whether a message continues it in deck. */
export function importTitle(s: SessionEntry): string {
  const preview = s.preview ? `\n\n${s.preview}` : '';
  if (s.source === 'grokbot') return `Grok Bot 앱 대화 — 읽기만 할 수 있어요 (새 Grok 세션으로 이어갈 수 있어요)${preview}`;
  if (s.cwdMissing) return `폴더가 없어 이어서 보낼 수 없음 — 읽기만 할 수 있습니다${preview}`;
  if (s.engine === 'grok' && s.heldBy) return `${SIDEBAR_HELD.title}${preview}`;
  if (s.engine === 'grok') return `${s.autoRun ? 'grok 헤드리스로 자동 실행된' : '터미널 Grok CLI 에서 만든'} 대화 — 메시지를 보내면 AI-MSG 에서 이어갑니다${preview}`;
  if (s.engine === 'gemini') return `agy 에서 만든 대화 — 메시지를 보내면 AI-MSG 에서 이어갑니다 (이전 메시지는 AI-MSG 에 보이지 않음)${preview}`;
  if (s.codexArchived) return 'Codex 에서 보관한 대화 — 읽기만 할 수 있습니다';
  return s.codexExec ? 'codex exec 로 자동 실행된 대화 — 메시지를 보내면 AI-MSG 에서 이어갑니다' : 'Codex 앱/CLI 에서 만든 대화 — 메시지를 보내면 AI-MSG 에서 이어갑니다';
}

/** Where an open session sits: "N번 칸에 열림" (the row's small outlined number; not an unread count). */
export const openSlotLabel = (n: number) => `${n}번 칸에 열림`;

/** A non-Claude engine's name, for the row's tooltip. */
const ENGINE_NAME: Partial<Record<EngineKind, string>> = { codex: 'Codex (GPT)', grok: 'Grok', gemini: 'Gemini' };

/** The one-word tag a row deck cannot continue carries on its second line (the tooltip says why). */
export function rowTag(s: SessionEntry): string | null {
  if (s.source === 'grokbot' || s.codexArchived) return '읽기 전용';
  if (s.cwdMissing) return '폴더 없음';
  if (s.engine === 'grok' && s.heldBy) return SIDEBAR_HELD.tag;
  return null;
}

/** A Grok conversation a terminal grok has open (heldBy): its row tag and the tooltip's line. */
const SIDEBAR_HELD = {
  tag: '터미널에서 열림',
  title: '터미널에서 grok 이 열고 있어 지금은 읽기만 할 수 있어요 — 그쪽 grok 을 끝내면 AI-MSG 에서 이어 쓸 수 있어요',
} as const;

/** A preview as one line (the row truncates it with an ellipsis). */
const oneLine = (t: string | undefined) => (t ? t.replace(/\s+/g, ' ').trim() : '');

/** Line 2's engine badge (non-Claude only): 12px, single colour (the line's muted grey), decorative — the tooltip names it. */
function MetaEngine({ engine }: { engine: EngineKind }) {
  if (engine === 'claude') return null;
  return <span className={`meta-engine ${engine}`} aria-hidden="true"><EngineBadge engine={engine} className="meta-engine-badge" /></span>;
}

/** Grok Bot row tags: the app name, reply-awaited / unread / group markers, read-only. */
type RowExtra = { unread?: number; awaiting?: boolean };

export function grokBotTags(s: SessionEntry): string[] {
  if (s.source !== 'grokbot') return [];
  const b = s.grokBot;
  return ['Grok Bot', ...(b?.awaitingUserResponse ? ['답장 대기'] : []), ...(b?.unreadCount ? [`안 읽음 ${b.unreadCount}`] : []), ...(b?.isGroup ? ['그룹'] : []), '읽기 전용'];
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.75" /><path d="m10.5 10.5 3.25 3.25" />
    </svg>
  );
}

function Chevron() {
  return <svg className="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.75 5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
