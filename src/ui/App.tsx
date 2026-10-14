import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { ClientMessage } from '../shared/protocol';
import type { SessionEntry } from '../shared/session-types';
import { CommandPalette, type PaletteAction, type PaletteSession } from './components/CommandPalette';
import { DeckMark } from './components/DeckMark';
import { engineOf } from './components/EngineMark';
import { ConfirmDialog, ShortcutHelp } from './components/Dialogs';
import { SessionCwdDialog } from './components/SessionCwdDialog';
import { Login } from './components/Login';
import { NotifyMenu } from './components/NotifyMenu';
import { SettingsView } from './components/SettingsView';
import { Toasts, type ToastItem } from './components/Toasts';
import { postPin, postPinOrder } from './pins';
import { findHitElement } from './scrollToHit';
import { postSessionMeta, restoreSession, searchTranscripts, trashSession, type SearchHit } from './sessionApi';
import { Pane, sendFromPane, useQueueRunner } from './components/Pane';
import { PermissionCard } from './components/PermissionCard';
import { QuestionCard } from './components/QuestionCard';
import { Sidebar, type SidebarView } from './components/Sidebar';
import { UsagePanel } from './components/UsagePanel';
import { UsageView } from './components/UsageView';
import { Highlights } from './components/Highlights';
import { HighlightsBadge, ServerChip, WorkStatus } from './components/WorkStatus';
import { isGeminiAccount } from '../shared/accounts';
import { isClaudeModel, type ClaudeModel } from '../shared/models';
import { claimReload, hasDraftText, hasOpenModal, isNewBuild, shouldAutoReload } from './autoReload';
import { paneColumns, paneSize, resizePair } from './paneResize';
import { hydrate, loadQueues, loadSent, loadUi, saveQueues, saveSent, saveUi, snapshotQueues, snapshotUi } from './persist';
import { findSession } from './push';
import { dockedPanes, initialState, orphanCards, reducer, sessionsToClose, type Action, type AppState, type UploadedAttachment } from './state';
import { arrangeFloats, clampFloat, dockSlot, EDGE_PX, FLOAT_MIN_H, FLOAT_MIN_W, floatRectAt, onRail, reorderSlot, SCROLL_STEP, slotX, useTabReorder, type FloatRect } from './paneDrag';
import { isMacPlatform, isTypingTarget, matchPinShortcut, matchShortcut, type ShortcutId } from './shortcuts';
import { useIsPhone } from './useIsPhone';
import { useTouchTooltip } from './useTouchTooltip';
import { FIND_EVENT } from './components/FindBar';

/** Disconnected this long → the 서버 응답 없음 bar (short blips during a restart stay at 재연결 중…). */
const DOWN_NOTICE_MS = 20_000;
const DOWN_TICK_MS = 10_000;
/** Hidden sidebar peek: dwell on the left edge this long before it slides out; this long outside it before it goes. */
const PEEK_OPEN_MS = 150;
const PEEK_CLOSE_MS = 300;
/** How long the 재시작됨 chip stays after a reconnect found a new server process (a click closes it sooner). */
const RESTARTED_CHIP_MS = 10 * 60_000;
/** Boot /api/me misses (3 s apart) before 확인 중… turns into 서버 응답 없음. */
const BOOT_NOTICE_FAILS = 5;
const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
import { usePrefs } from './usePrefs';
import { nextTheme, type Theme } from './prefs';
import { createSocket } from './ws';
import { useStartWatch } from './useStartWatch';
import { OPEN_REQUEST_MISSING, OPEN_REQUEST_WAIT_MS, openRequestStep } from './openRequest';
import { composerOf, finePointer, focusComposer, hasOpenPopup, routeContext, routeKey } from './composerFocus';
import { tabTitle } from './tabTitle';
import { useIndexRefresh, type IndexRefresh } from './indexRefresh';
import { createCatchup, type Catchup } from './catchup';
import { AccountsContext, uiAccounts } from './accounts';
import { has, setFeatures } from './features';

const VIEW_KEY = 'deck.sidebarView';
const HIDDEN_KEY = 'deck.sidebarHidden';
const UNDO_MS = 10_000;
/** 보관 되돌리기 toast: shorter than 삭제's (보관 is milder and also undone from the 보관됨 list). */
const ARCHIVE_UNDO_MS = 8_000;
/** How often a visible page asks /api/build (it also asks whenever it becomes visible). */
const BUILD_CHECK_MS = 5 * 60_000;
const MAC = isMacPlatform();
const THEME_LABEL: Record<Theme, string> = { system: '시스템', light: '라이트', dark: '다크' };

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: not kept */ }
}

/**
 * What to ask route_preview for the pane (a Claude session, or a new chat set to Claude); null = no 다음 tag. `model` is
 * what a send would carry (as Pane's modelField): none for an existing session the user picked no model for.
 */
function routePreviewAsk(pane: AppState['panes'][number]): { key: string; sessionId: string | null; cwd: string; model?: ClaudeModel | 'auto' } | null {
  const s = pane.session;
  if (!s) return null;
  const claude = s.sessionId === null ? pane.engine === 'claude' && !s.accountPin : s.engine ? s.engine === 'claude' : s.account !== 'gpt' && !(s.account && isGeminiAccount(s.account));
  if (!claude) return null;
  const picked = s.sessionId === null || pane.modelPicked;
  const model = picked && (pane.model === 'auto' || isClaudeModel(pane.model)) ? pane.model : undefined;
  return { key: `${s.sessionId ?? ''}|${s.cwd}|${s.account ?? ''}|${s.accountPin ?? ''}|${model ?? ''}`, sessionId: s.sessionId, cwd: s.cwd, ...(model ? { model } : {}) };
}

/** The last server process start this tab saw, and the 재시작됨 chip it showed (sessionStorage: survives a reload). */
const SERVER_START_KEY = 'deck.serverStart';
function loadServerStart(): { startedAt: number | null; restartedAt: number | null } {
  try {
    const v = JSON.parse(sessionStorage.getItem(SERVER_START_KEY) ?? 'null') as { startedAt?: unknown; restartedAt?: unknown } | null;
    return { startedAt: typeof v?.startedAt === 'number' ? v.startedAt : null, restartedAt: typeof v?.restartedAt === 'number' ? v.restartedAt : null };
  } catch { return { startedAt: null, restartedAt: null }; }
}

/** Every non-archived session once (the copy in the index), newest first — the 최근 order ⌘[ / ⌘] walk. */
function recentSessions(projects: { name: string; sessions: SessionEntry[] }[]): (SessionEntry & { project: string })[] {
  const seen = new Map<string, SessionEntry & { project: string }>();
  for (const p of projects) for (const s of p.sessions) if (!s.archived && !seen.has(s.sessionId)) seen.set(s.sessionId, { ...s, project: p.name });
  return [...seen.values()].sort((a, b) => b.lastModified - a.lastModified);
}
/** Tab title: "● <chat> — deck" while any turn runs; "✓ …" when one finished while the tab was hidden, until it is shown. */
function useTabTitle(running: boolean, chat: string | null) {
  const was = useRef(running);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const finished = was.current && !running;
    was.current = running;
    if (running) setDone(false);
    else if (finished && document.hidden) setDone(true);
  }, [running]);
  useEffect(() => {
    const onVis = () => { if (!document.hidden) setDone(false); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => { document.title = tabTitle(running ? '●' : done ? '✓' : null, chat); }, [running, done, chat]);
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  // ux-state: panes, pickers, folded sidebar groups and the drawer come back after a reload (persist.ts).
  const saved = useMemo(() => loadUi(), []);
  const [state, dispatch] = useReducer(reducer, saved, (ui) => {
    // A reload (often the automatic one after a restart) compares the first activity with the server this tab saw last.
    const start = loadServerStart();
    return hydrate({ ...initialState, serverStartedAt: start.startedAt, restartedAt: start.restartedAt }, ui, loadQueues());
  });
  const [collapsed, setCollapsed] = useState<string[]>(() => saved?.collapsed ?? []);
  const firstBuild = useRef<string | null | undefined>(undefined);
  const [newBuild, setNewBuild] = useState(false);
  const sock = useRef<ReturnType<typeof createSocket> | null>(null);
  // Down for a while: the header dot alone says nothing (on a phone it is all there is), so after DOWN_NOTICE_MS a bar
  // says since when the server stopped answering and offers 다시 시도. `now` ticks only while disconnected.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.connected || state.disconnectedSince === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), DOWN_TICK_MS);
    return () => clearInterval(t);
  }, [state.connected, state.disconnectedSince]);
  const downSince = !state.connected && state.disconnectedSince !== null && now - state.disconnectedSince >= DOWN_NOTICE_MS ? state.disconnectedSince : null;
  const retryNow = () => { sock.current?.retry(); setNow(Date.now()); };
  const latest = useRef(state);
  latest.current = state;
  /** 고정됨 reorder requests: only the newest one's answer is applied. */
  const pinOrderSeq = useRef(0);
  const phone = useIsPhone();
  const [drawer, setDrawer] = useState(() => saved?.drawer ?? false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [prefs, setPref] = usePrefs();
  const themeRef = useRef(prefs.theme);
  themeRef.current = prefs.theme;
  // ⌘K palette actions (설정 열기 / 테마 전환) arrive as window events; ⌘, goes through the shortcut table.
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    const cycle = () => setPref({ type: 'set', key: 'theme', value: nextTheme(themeRef.current) });
    window.addEventListener('deck:open-settings', open);
    window.addEventListener('deck:cycle-theme', cycle);
    return () => { window.removeEventListener('deck:open-settings', open); window.removeEventListener('deck:cycle-theme', cycle); };
  }, [setPref]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>(() => (readLocal(VIEW_KEY) === 'projects' ? 'projects' : 'recent'));
  const [sidebarHidden, setSidebarHidden] = useState(() => readLocal(HIDDEN_KEY) === '1');
  useEffect(() => { writeLocal(VIEW_KEY, sidebarView); }, [sidebarView]);
  useEffect(() => { writeLocal(HIDDEN_KEY, sidebarHidden ? '1' : '0'); }, [sidebarHidden]);
  // Peek: with the sidebar hidden (desktop), resting the pointer on the window's left edge (or on ☰) slides it out over
  // the panes; leaving it slides it back. A rename field or an open menu inside keeps it out until that is done.
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarWrap = useRef<HTMLDivElement>(null);
  /** Closed by Esc / a click while the pointer still rests on it: no reopening until the pointer has left. */
  const peekLatch = useRef(false);
  const tucked = !phone && sidebarHidden;
  // Hover only means something with a mouse / trackpad: a touch screen keeps ☰ / ⌘\ to show it.
  const peekable = tucked && finePointer() && window.matchMedia('(hover: hover)').matches;
  const clearPeekTimer = () => { if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; } };
  const armPeek = (e: { buttons: number }) => {
    // A drag (text selection, pin reorder) passing the edge is no request to see the sidebar.
    if (peekLatch.current || e.buttons !== 0) return;
    clearPeekTimer();
    peekTimer.current = setTimeout(() => { peekTimer.current = null; setPeek(true); }, PEEK_OPEN_MS);
  };
  const unlatchPeek = () => { peekLatch.current = false; };
  /** Esc / a click inside: closes at once and latches until the pointer leaves. */
  const closePeek = () => {
    clearPeekTimer();
    if (peek) peekLatch.current = true;
    setPeek(false);
  };
  const leavePeek = () => {
    clearPeekTimer();
    const tryClose = () => {
      peekTimer.current = setTimeout(() => {
        const wrap = sidebarWrap.current;
        const focus = document.activeElement;
        const busy = !!wrap && (!!wrap.querySelector('.session-menu') || (!!focus && wrap.contains(focus) && focus.matches('input, textarea')));
        if (busy) tryClose(); else { peekTimer.current = null; setPeek(false); }
      }, PEEK_CLOSE_MS);
    };
    tryClose();
  };
  useEffect(() => { if (!peekable) { clearPeekTimer(); setPeek(false); peekLatch.current = false; } }, [peekable]);
  useEffect(() => clearPeekTimer, []);
  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const wrap = sidebarWrap.current;
      if (e.target instanceof Element && e.target.matches('input, textarea') && wrap?.contains(e.target)) return;
      // A menu / modal / palette open (a row menu inside, or ⌘/ help opened over the peek): that Esc is its own.
      if (hasOpenPopup()) return;
      // Taken: the pane's side panel and its Esc (stop the running turn) must not fire with it (both skip a
      // defaultPrevented Esc; Pane's ESC_OWNERS lists the peek too).
      e.preventDefault();
      clearPeekTimer();
      peekLatch.current = true;
      setPeek(false);
    };
    // Capture: runs before the bubble-phase Esc handlers (side panel, dialogs), so one Esc closes only the topmost thing.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peek]);
  // The latch's fallback: a pointer that left without a mouseleave (the sidebar slid out from under it) is noticed on its next move.
  useEffect(() => {
    if (!peekable) return;
    const onMove = (e: MouseEvent) => {
      if (!peekLatch.current) return;
      const t = e.target;
      if (t instanceof Element && (sidebarWrap.current?.contains(t) || t.closest('.sidebar-hotzone, .sidebar-toggle'))) return;
      peekLatch.current = false;
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [peekable]);
  /** The empty pane's preselected project, by pane (the project it showed before ⌘N / a delete). */
  const [newChatCwd, setNewChatCwd] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<{ s: SessionEntry; which?: string } | null>(null);
  /** 작업 폴더 바꾸기: the session whose folder picker is open. */
  const [cwdFor, setCwdFor] = useState<SessionEntry | null>(null);
  // One undo toast at a time: 삭제 (restore from the trash) or 보관 (unarchive).
  const [undo, setUndo] = useState<{ kind: 'trash'; trashId: string; title: string; which?: string } | { kind: 'archive'; sessionId: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), undo.kind === 'archive' ? ARCHIVE_UNDO_MS : UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);
  // The reducer keeps one app-wide `error` slot (many writers: server errors, show_error, refused steers…). Each value
  // it takes moves into the toast stack and the slot is cleared at once, so errors stack instead of overwriting one
  // another, and the same text arriving twice is two toasts (a slot left set would not change, so no second one).
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  useEffect(() => {
    if (state.error === null) return;
    const text = state.error;
    setToasts((t) => [...t, { id: ++toastSeq.current, text, kind: 'error' }]);
    dispatch({ type: 'dismiss_error' });
  }, [state.error]);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const onShortcut = useRef<(id: ShortcutId) => void>(() => {});
  /** ⌘1 … ⌘9: set by the sidebar — opens the nth 고정됨 row it shows, as a click on it would; false when there is none. */
  const openPinned = useRef<(index: number, peek?: boolean) => boolean>(() => false);
  const lastSaved = useRef<string | null>(null);
  useEffect(() => { lastSaved.current = saveUi(snapshotUi(state, { collapsed, drawer }), lastSaved.current); }, [state.panes, state.activePaneId, collapsed, drawer]);
  // Queued messages: per tab (sessionStorage), so another tab of this browser never sends them.
  const lastQueues = useRef<string | null>(null);
  useEffect(() => {
    const queued = snapshotQueues(state);
    lastQueues.current = saveQueues(queued, lastQueues.current);
    const n = queued.queues.reduce((k, q) => k + q.queue.length, 0);
    if (lastQueues.current === null && n > 0) dispatch({ type: 'show_error', message: `대기 중인 메시지 ${n}개를 저장하지 못했습니다 — 새로고침하면 사라집니다: ${queued.queues.flatMap((q) => q.queue.map((i) => i.text || '첨부만')).join(' / ')}` });
  }, [state.panes, state.parked]);
  // Sent files per session (thumbnails after a transcript reload): re-saved only when some pane's sent files change.
  const sentSig = state.panes.map((p) => `${p.session?.sessionId ?? ''}:${p.items.filter((it) => it.kind === 'user' && it.attachments?.length).length}`).join('|');
  useEffect(() => { saveSent(latest.current.panes); }, [sentSig]);
  // A 대화 내용 검색 hit being opened: once its pane has loaded the transcript, scroll to the message containing it.
  const [scrollTo, setScrollTo] = useState<{ paneId: string; sessionId: string; snippet: string; match: string; until: number } | null>(null);

  // An unreachable server (a phone that just woke up, no network yet) is retried, not left at 확인 중… for good.
  // After BOOT_NOTICE_FAILS misses the screen says so (the server is down, not the app hanging) and offers a reload.
  const [bootFails, setBootFails] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      fetch('/api/me').then((r) => { if (!cancelled) setAuthed(r.ok); }, () => { if (!cancelled) { setBootFails((n) => n + 1); timer = setTimeout(check, 3000); } });
    };
    check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  /** A build id from the server (a hello, or /api/build) against the first hello's: reload when nothing is at stake (true), else offer the pill. */
  const noticeBuild = (build: string | null, nextState: () => AppState): boolean => {
    // No baseline yet (the first hello came from a server without a build): the first id seen becomes it.
    if (!firstBuild.current) { if (build) firstBuild.current = build; return false; }
    if (!isNewBuild(firstBuild.current, build)) return false;
    const next = nextState();
    if (shouldAutoReload({ draftText: hasDraftText(), modalOpen: hasOpenModal(), state: next }) && claimReload(build!)) {
      // The save effect never runs before the reload: the queues as of now are stored first.
      lastQueues.current = saveQueues(snapshotQueues(next), lastQueues.current);
      location.reload();
      return true;
    }
    setNewBuild(true);
    return false;
  };
  // A UI-only rebuild sends no hello: ask when the page comes back to the front (an installed PWA has no reload button), and every few minutes while it stays there.
  useEffect(() => {
    if (!authed) return;
    let busy = false;
    const check = () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      void fetch('/api/build')
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { build?: unknown } | null) => {
          if (typeof body?.build !== 'string') return;
          noticeBuild(body.build, () => latest.current);
        })
        .catch(() => undefined)
        .finally(() => { busy = false; });
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    const t = setInterval(check, BUILD_CHECK_MS);
    return () => { document.removeEventListener('visibilitychange', check); window.removeEventListener('pageshow', check); clearInterval(t); };
  }, [authed]);

  // The sidebar's times and new outside sessions: a throttled rescan on reconnect, on coming back into view, every 2 min,
  // and after a turn's result unless the server sends its index by itself (it does not while background work keeps the process open).
  const refreshIndex = useRef<IndexRefresh | null>(null);
  /** Keeps each shown session's turn events in order and asks for what a reconnect or a stalled socket missed (catchup.ts). */
  const catchup = useRef<Catchup | null>(null);
  refreshIndex.current = useIndexRefresh(!!authed, () => sock.current?.send({ type: 'refresh_index' }));
  useEffect(() => {
    if (!authed) return;
    const tracker = createCatchup({
      send: (m) => !!sock.current?.send(m),
      enabled: () => has('catchup'),
      shown: () => latest.current.panes.map((p) => p.session?.sessionId).filter((x): x is string => !!x),
      stalled: () => sock.current?.reconnect(),
    });
    catchup.current = tracker;
    sock.current = createSocket((msg) => {
      if (msg.type === 'hello') setFeatures(msg.features);
      // A repeat of an event already applied, one ahead of a gap (what is missing was just asked for), or a retry's same failure: not applied.
      if (!tracker.accept(msg)) return;
      dispatch(msg.type === 'history' ? { type: 'server', msg, sentFiles: loadSent(msg.sessionId) } : { type: 'server', msg });
      if (msg.type === 'turn_result') refreshIndex.current?.afterTurn();
      if (msg.type === 'index') refreshIndex.current?.indexSeen();
      // 복제 opened the copy in the focused pane: the phone drawer gets out of the way.
      if (msg.type === 'session_duplicate') setDrawer(false);
      // Reconnected: re-open every pane's session (once each) so this socket receives their turn events again (review I3, D6).
      if (msg.type === 'hello') {
        // A restarted server with a new UI build: reload when nothing is at stake, else offer the pill.
        const build = msg.build ?? null;
        setBuildId(build);
        if (noticeBuild(build, () => reducer(latest.current, { type: 'server', msg }))) return;
        refreshIndex.current?.request();
        // shown() reads latest.current, which the dispatch above updates only on the next render: apply the hello now so
        // a new session's id adopted from hello.running (7b) is among the sessions re-opened.
        latest.current = reducer(latest.current, { type: 'server', msg });
        // A 'catchup' server is asked only for what came after this device's last event (it sends the whole history if it cannot tell).
        tracker.hello();
        for (const p of latest.current.panes) {
          if (p.activeTurnId && msg.running.some((r) => r.turnId === p.activeTurnId)) sock.current?.send({ type: 'watch_turn', turnId: p.activeTurnId });
        }
      }
    }, (value) => { if (!value) tracker.cancel(); dispatch({ type: 'connected', value, at: Date.now() }); }, () => setAuthed(false));
    const onVis = () => { if (document.hidden) return; sock.current?.wake(); tracker.visible(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', onVis); tracker.cancel(); catchup.current = null; sock.current?.close(); };
  }, [authed]);

  // Only once this socket's hello is in: a send between onopen and hello would be requeued by that hello.
  useQueueRunner(state.panes, state.ready, dispatch, (m) => (sock.current ? sock.current.send(m) : false), state.defaultPermMode);
  // 시작하는 중… for START_STALL_MS on a socket that looks open: it is likely dead — a fresh one's hello requeues the send.
  useStartWatch(state.panes, state.connected, () => sock.current?.reconnect());
  useTouchTooltip();
  useTabTitle(state.activity.some((a) => a.running) || state.panes.some((p) => p.activeTurnId !== null), state.panes.find((p) => p.id === state.activePaneId)?.session?.title ?? null);
  // Composer focus after opening a chat / 새 채팅 / a pane switch: run after the commit so the pane's textarea exists.
  // No pane id: whichever pane is active then (a new split's id is only known after the reducer).
  const [focusReq, setFocusReq] = useState<{ paneId: string | null; n: number } | null>(null);
  const requestFocus = (paneId: string | null = null) => setFocusReq((r) => ({ paneId, n: (r?.n ?? 0) + 1 }));
  useEffect(() => { if (focusReq) focusComposer(focusReq.paneId ?? latest.current.activePaneId); }, [focusReq]);
  useEffect(() => { if (authed) requestFocus(); }, [authed]);
  // A file dropped outside the chat pane (sidebar, top bar) must never make the browser navigate to it.
  useEffect(() => {
    // The chat pane handles its own (preventDefault first), so only the rest gets the "no drop here" cursor.
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => { window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard); };
  }, []);
  // PWA: a notification click opens deck at /?session=<id> or, with deck already open, posts the id here.
  const [openReq, setOpenReq] = useState<string | null>(() => new URLSearchParams(window.location.search).get('session'));
  const openById = useRef<(sessionId: string) => boolean>(() => false);
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMsg = (e: MessageEvent) => { const d = e.data as { type?: unknown; sessionId?: unknown } | null; if (d?.type === 'deck-open-session' && typeof d.sessionId === 'string') setOpenReq(d.sessionId); };
    sw.addEventListener('message', onMsg);
    return () => sw.removeEventListener('message', onMsg);
  }, []);
  // A session not in the index yet (a new session's first turn) waits for the next index, at most OPEN_REQUEST_WAIT_MS.
  const openMiss = useRef<{ id: string; projects: AppState['projects']; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    if (!openReq || !state.connected) return;
    const settle = (error: boolean) => {
      if (openMiss.current) clearTimeout(openMiss.current.timer);
      openMiss.current = null;
      setOpenReq(null);
      if (window.location.search) window.history.replaceState(null, '', '/');
      if (error) dispatch({ type: 'show_error', message: OPEN_REQUEST_MISSING });
    };
    if (openMiss.current && openMiss.current.id !== openReq) { clearTimeout(openMiss.current.timer); openMiss.current = null; }
    const step = openRequestStep({ found: openById.current(openReq), projects: state.projects, missedIn: openMiss.current?.projects ?? null });
    if (step === 'done') settle(false);
    else if (step === 'fail') settle(true);
    else if (step === 'miss') openMiss.current = { id: openReq, projects: state.projects, timer: setTimeout(() => settle(true), OPEN_REQUEST_WAIT_MS) };
  }, [openReq, state.connected, state.projects]);

  useEffect(() => {
    if (!phone || !drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, drawer]);

  // ⇧Esc: caret to the active pane's composer (as in ChatGPT / claude.ai), even from another field or from a hardware
  // keyboard on a touch screen. Captured so the Pane/Sheet Esc handlers never see it; popups keep their own Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229 || e.repeat || hasOpenPopup()) return;
      const ta = composerOf(latest.current.activePaneId);
      if (!ta) return;
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement !== ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Global shortcuts (⌘ on Mac, Ctrl elsewhere). While a dialog is open only ⌘K (toggle) and ⌘/ get through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // ⌘1 … ⌘9: the nth 고정됨 row, also from the composer. The key is only taken when that row exists; a held key's
      // repeats are taken too (not reopened), or the browser would switch tabs on them.
      const pin = matchPinShortcut(e, MAC);
      if (pin !== null) {
        if (!hasOpenModal() && openPinned.current(pin, e.repeat)) e.preventDefault();
        return;
      }
      const id = matchShortcut(e, { mac: MAC, typing: isTypingTarget(e.target) });
      if (!id) {
        // Type-to-compose: the key lands in the focused pane's composer (focus moves before the key's default action).
        // An IME key only moves focus (and is swallowed) so the composition never garbles.
        const how = routeKey(e, routeContext(e.target));
        const ta = how ? composerOf(latest.current.activePaneId) : null;
        if (!ta) return;
        // Already in the composer (a key event retargeted elsewhere, as iPadOS does mid-IME): leave the key and the caret alone.
        if (document.activeElement !== ta) {
          if (how === 'focus') e.preventDefault();
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        return;
      }
      if (hasOpenModal() && id !== 'palette' && id !== 'help' && id !== 'settings') return;
      e.preventDefault();
      onShortcut.current(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const cancelDelete = useCallback(() => setConfirmDelete(null), []);

  useEffect(() => {
    if (!scrollTo) return;
    if (Date.now() > scrollTo.until) { setScrollTo(null); return; }
    const pane = state.panes.find((p) => p.id === scrollTo.paneId);
    if (pane?.session?.sessionId !== scrollTo.sessionId) { setScrollTo(null); return; }
    const root = document.querySelector(`[data-testid="pane-${scrollTo.paneId}"]`);
    // After the pane's own scroll-to-bottom (it runs in the same commit), hence the frame delay.
    const id = requestAnimationFrame(() => {
      const el = root && findHitElement(root, scrollTo.snippet, scrollTo.match);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('search-flash');
      setTimeout(() => el.classList.remove('search-flash'), 2000);
      el.dispatchEvent(new CustomEvent(FIND_EVENT, { bubbles: true, detail: scrollTo.match }));
      setScrollTo(null);
    });
    return () => cancelAnimationFrame(id);
  }, [scrollTo, state.panes]);

  useEffect(() => {
    if (state.restartedAt === null) return;
    const t = setTimeout(() => dispatch({ type: 'dismiss_restart' }), RESTARTED_CHIP_MS);
    return () => clearTimeout(t);
  }, [state.restartedAt]);
  useEffect(() => {
    try {
      if (state.serverStartedAt === null) sessionStorage.removeItem(SERVER_START_KEY);
      else sessionStorage.setItem(SERVER_START_KEY, JSON.stringify({ startedAt: state.serverStartedAt, restartedAt: state.restartedAt }));
    } catch { /* storage unavailable: a reload forgets it */ }
  }, [state.serverStartedAt, state.restartedAt]);
  // 다음 턴 미리보기 ('routePreview' servers): asked for the active pane's Claude session whenever it (or its account,
  // pin or model) changes and on each connect; the server answers again by itself after usage changes. Leaving Claude
  // withdraws the ask, so nothing more comes for it.
  const activePane = state.panes.find((p) => p.id === state.activePaneId) ?? state.panes[0]!;
  const previewKey = routePreviewAsk(activePane);
  const previewAsked = useRef(false);
  useEffect(() => {
    if (!state.ready) { previewAsked.current = false; return; }
    if (!has('routePreview')) return;
    dispatch({ type: 'clear_route_preview' });
    if (previewKey) {
      sock.current?.send({ type: 'route_preview', sessionId: previewKey.sessionId, cwd: previewKey.cwd, ...(previewKey.model ? { model: previewKey.model } : {}) });
      previewAsked.current = true;
    } else if (previewAsked.current) {
      sock.current?.send({ type: 'route_preview', sessionId: null });
      previewAsked.current = false;
    }
  }, [state.ready, previewKey?.key]);

  const accounts = useMemo(() => uiAccounts(state.accounts), [state.accounts]);
  // A phone has tabs instead of a grid: a floating card means nothing there, so any float is parked (a tab at the end,
  // its box remembered) and the tabs are the panes in array order; a wide screen again floats the parked ones back.
  // (Hooks: before the early returns below.)
  useEffect(() => {
    dispatch({ type: phone ? 'park_floats' : 'unpark_floats' });
  }, [phone, state.panes]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  // Screen-reader narration of the card work (drag, keyboard moves): one polite live region, written directly so a
  // drag's per-move updates never re-render the panes.
  const liveRef = useRef<HTMLDivElement>(null);
  const announce = (text: string) => {
    const el = liveRef.current;
    if (!el) return;
    // The same text twice must still be read: clear, then set again on the next frame.
    if (el.textContent !== text || typeof requestAnimationFrame !== 'function') { el.textContent = text; return; }
    el.textContent = '';
    requestAnimationFrame(() => { if (liveRef.current) liveRef.current.textContent = text; });
  };
  // Floating cards stay reachable when the body shrinks (window resized, sidebar unfolded, a save from a bigger
  // monitor): every card is clamped to the body whenever its size changes. Same rect → the reducer returns the same state.
  const floatCount = state.panes.filter((p) => p.float).length;
  useEffect(() => {
    if (phone || !authed || floatCount === 0) return;
    const body = bodyRef.current;
    if (!body) return;
    const clamp = () => {
      const bounds = { w: body.clientWidth, h: body.clientHeight };
      if (!bounds.w || !bounds.h) return;
      for (const p of latest.current.panes) {
        if (!p.float) continue;
        const rect = clampFloat(p.float, bounds);
        if (rect.x !== p.float.x || rect.y !== p.float.y || rect.w !== p.float.w || rect.h !== p.float.h) dispatch({ type: 'move_float', paneId: p.id, rect });
      }
    };
    clamp();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', clamp); return () => window.removeEventListener('resize', clamp); }
    const ro = new ResizeObserver(clamp);
    ro.observe(body);
    return () => ro.disconnect();
  }, [phone, authed, floatCount]);
  // Phone tabs: hold (touch) or press-and-drag (mouse) a tab to put it elsewhere in the row.
  const tabs = useTabReorder(state.panes.length, (from, to) => { const id = state.panes[from]?.id; if (id) dispatch({ type: 'move_pane', paneId: id, to }); });
  if (authed === null) {
    if (bootFails < BOOT_NOTICE_FAILS) return <div className="center">확인 중…</div>;
    return (
      <div className="center boot-wait" role="status">
        <div>서버 응답 없음 — 3초마다 다시 시도합니다</div>
        <div className="boot-wait-hint">deck 서버가 꺼져 있거나 Tailscale 연결이 끊겼을 수 있습니다. 연결되면 자동으로 들어갑니다.</div>
        <button type="button" className="text-btn" onClick={() => location.reload()}>지금 다시 시도</button>
      </div>
    );
  }
  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;

  // No socket yet counts as not connected; otherwise the socket's own answer (`false` = not connected).
  const send = (m: ClientMessage) => (sock.current ? sock.current.send(m) : false);
  /**
   * Pane-changing actions (open / close): the server's per-socket view set must shrink too, so every session
   * no pane views after the action gets a close_session (T9 prerequisite b; duplicate-session panes keep it).
   */
  const apply = (action: Action) => {
    const prev = latest.current;
    const next = reducer(prev, action);
    latest.current = next;
    dispatch(action);
    for (const sessionId of sessionsToClose(prev, next)) { catchup.current?.forget(sessionId); send({ type: 'close_session', sessionId }); }
  };
  const active = state.panes.find((p) => p.id === state.activePaneId) ?? state.panes[0]!;
  // The grid shows the docked panes; the floating ones are cards over the body. A phone has tabs instead: a floating
  // card means nothing there, so any float lands (as a tab at the end) and the tabs are the panes in array order.
  const docked = dockedPanes(state.panes);
  const floats = state.panes.filter((p) => p.float);
  // Splitter drag: the grid is restyled directly while the pointer moves (no re-render of every pane per frame);
  // the weights reach the state on release, a cancelled drag puts the columns back.
  const startPaneResize = (e: ReactPointerEvent<HTMLDivElement>, leftId: string, rightId: string) => {
    const el = e.currentTarget;
    const grid = el.parentElement;
    const left = el.previousElementSibling?.getBoundingClientRect();
    const right = el.nextElementSibling?.getBoundingClientRect();
    if (!grid || !left || !right) return;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    const panes = dockedPanes(latest.current.panes);
    const sizes = panes.map((p) => paneSize(p.size));
    const i = panes.findIndex((p) => p.id === leftId);
    if (i < 0 || panes[i + 1]?.id !== rightId) return;
    const startX = e.clientX;
    const before = grid.style.gridTemplateColumns;
    let pair: [number, number] | null = null;
    const move = (ev: PointerEvent) => {
      pair = resizePair([sizes[i]!, sizes[i + 1]!], [left.width, right.width], ev.clientX - startX);
      grid.style.gridTemplateColumns = paneColumns(sizes.map((s, j) => (j === i ? pair![0] : j === i + 1 ? pair![1] : s)));
    };
    const end = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      if (ev.type === 'pointercancel' || !pair) { grid.style.gridTemplateColumns = before; return; }
      dispatch({ type: 'resize_panes', sizes: { [leftId]: pair[0], [rightId]: pair[1] } });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  /**
   * The ⋮⋮ grip: a docked pane dragged along the top edge of the split view (the rail) changes places with its
   * neighbours; dragged below it, it comes off as a floating card. A floating card dragged anywhere moves; dropped
   * on the rail it goes back into the grid at that slot. The DOM is moved while the pointer moves (ghost, marker,
   * the card itself); the state changes once, on release. Escape (or a cancelled pointer) puts everything back.
   */
  const startPaneDrag = (e: ReactPointerEvent<HTMLButtonElement>, paneId: string) => {
    const body = bodyRef.current;
    const grid = panesRef.current;
    const section = e.currentTarget.closest<HTMLElement>('.pane');
    const pane = latest.current.panes.find((p) => p.id === paneId);
    if (phone || e.button !== 0 || !body || !grid || !section || !pane) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const touch = e.pointerType !== 'mouse';
    const slop = touch ? 8 : 4;
    const startX = e.clientX;
    const startY = e.clientY;
    const bodyRect = body.getBoundingClientRect();
    const bounds = { w: bodyRect.width, h: bodyRect.height };
    const card = pane.float ? section.closest<HTMLElement>('.float-card') : null;
    const source = (card ?? section).getBoundingClientRect();
    const docked = dockedPanes(latest.current.panes);
    const from = docked.findIndex((p) => p.id === paneId);
    // The docked panes' boxes are measured on every move: the grid may scroll under the pointer (many panes).
    let dockedRects: DOMRect[] = [];
    let mids: number[] = [];
    let otherRects: DOMRect[] = [];
    const measure = () => {
      dockedRects = docked.map((p) => grid.querySelector<HTMLElement>(`.pane[data-pane="${p.id}"]`)?.getBoundingClientRect() ?? new DOMRect());
      mids = dockedRects.map((r) => r.left + r.width / 2);
      otherRects = dockedRects.filter((_, i) => i !== from);
    };
    const canFloat = !!pane.float || docked.length > 1;
    const cardStyle = card ? { left: card.style.left, top: card.style.top } : null;
    let active = false;
    let done = false;
    let ghost: HTMLDivElement | null = null;
    let marker: HTMLDivElement | null = null;
    let lastEv: PointerEvent | null = null;
    let raf: number | null = null;
    let result: { kind: 'reorder'; to: number } | { kind: 'dock'; to: number } | { kind: 'float'; rect: FloatRect } | { kind: 'move'; rect: FloatRect } | null = null;
    // What the drop would do, said once per change (not per move).
    let said = '';
    const say = (text: string) => { if (text !== said) { said = text; announce(text); } };
    const blocked = (text: string, local: { x: number; y: number }) => {
      result = null;
      ghost!.classList.add('chip', 'blocked');
      ghost!.textContent = text;
      Object.assign(ghost!.style, { left: `${local.x + 12}px`, top: `${local.y + 12}px` });
      say(text);
    };
    // On the rail near either end of a grid that overflows, the grid scrolls on its own so far-off slots can be reached.
    const autoScroll = () => {
      if (raf !== null || typeof requestAnimationFrame !== 'function') return;
      const step = () => {
        raf = null;
        if (!active || !lastEv) return;
        const gr = grid.getBoundingClientRect();
        const room = grid.scrollWidth - grid.clientWidth;
        const rail = onRail({ x: lastEv.clientX, y: lastEv.clientY }, gr);
        const dir = !rail || room <= 0 ? 0 : lastEv.clientX < gr.left + EDGE_PX ? -1 : lastEv.clientX > gr.right - EDGE_PX ? 1 : 0;
        if (dir === 0 || (dir < 0 && grid.scrollLeft <= 0) || (dir > 0 && grid.scrollLeft >= room)) return;
        grid.scrollLeft += dir * SCROLL_STEP;
        move(lastEv);
      };
      raf = requestAnimationFrame(step);
    };
    const begin = () => {
      active = true;
      document.body.classList.add('pane-dragging');
      section.classList.add('pane-drag-source');
      ghost = document.createElement('div');
      ghost.className = 'pane-ghost';
      ghost.textContent = pane.session?.title ?? '새 세션';
      marker = document.createElement('div');
      marker.className = 'pane-drop-marker';
      body.append(ghost, marker);
      say(pane.float ? '카드 끌기 시작 — 위 가장자리에 놓으면 패널에 붙입니다, Esc 로 취소' : '패널 끌기 시작 — 위 가장자리에서는 순서 바꾸기, 아래로 끌면 카드로 떼기, Esc 로 취소');
    };
    const showMarker = (clientX: number) => {
      const gr = grid.getBoundingClientRect();
      Object.assign(marker!.style, { display: '', left: `${Math.round(clientX - bodyRect.left) - 1}px`, top: `${gr.top - bodyRect.top}px`, height: `${gr.height}px` });
    };
    const move = (ev: PointerEvent) => {
      // The button came up without a pointerup reaching us (⌘-Tab mid-drag, a popup): nothing is dropped.
      if (ev.buttons === 0) { end({ type: 'cancel' }); return; }
      if (!active) {
        if (Math.abs(ev.clientX - startX) <= slop && Math.abs(ev.clientY - startY) <= slop) return;
        begin();
      }
      lastEv = ev;
      measure();
      const gr = grid.getBoundingClientRect();
      const rail = onRail({ x: ev.clientX, y: ev.clientY }, gr);
      const local = { x: ev.clientX - bodyRect.left, y: ev.clientY - bodyRect.top };
      const inBody = local.x >= 0 && local.y >= 0 && local.x <= bounds.w && local.y <= bounds.h;
      marker!.style.display = 'none';
      ghost!.className = 'pane-ghost';
      ghost!.style.cssText = '';
      if (card) card.classList.toggle('drag-move', !rail);
      if (rail) autoScroll();
      if (!pane.float && rail) {
        // Reorder among the docked panes.
        const to = reorderSlot(mids, from, ev.clientX);
        result = { kind: 'reorder', to };
        if (to !== from) showMarker(slotX(otherRects, to));
        ghost!.classList.add('chip');
        Object.assign(ghost!.style, { left: `${local.x + 12}px`, top: `${local.y + 12}px` });
        say(to === from ? '원래 자리' : `${to + 1}번째 자리로`);
      } else if (!pane.float) {
        // Off the rail: the pane as a card — but not above the rail (the top bar) or outside the body (sidebar), where
        // a slip of the hand would otherwise pull the pane out.
        if (!canFloat) { blocked('마지막 패널은 떼어낼 수 없어요', local); return; }
        if (!inBody || ev.clientY < gr.top) { blocked('여기에는 놓을 수 없어요', local); return; }
        ghost!.textContent = pane.session?.title ?? '새 세션';
        const rect = floatRectAt(local, { w: source.width, h: source.height }, bounds);
        result = { kind: 'float', rect };
        ghost!.classList.add('card');
        Object.assign(ghost!.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
        say('카드로 떼기');
      } else if (rail) {
        // A card back onto the rail.
        const to = dockSlot(mids, ev.clientX);
        result = { kind: 'dock', to };
        showMarker(slotX(dockedRects, to));
        ghost!.classList.add('chip');
        Object.assign(ghost!.style, { left: `${local.x + 12}px`, top: `${local.y + 12}px` });
        say(`${to + 1}번째 자리에 붙이기`);
      } else {
        // A card moved.
        ghost!.style.display = 'none';
        const rect = clampFloat({ ...pane.float, x: pane.float.x + (ev.clientX - startX), y: pane.float.y + (ev.clientY - startY) }, bounds);
        result = { kind: 'move', rect };
        if (card) Object.assign(card.style, { left: `${rect.x}px`, top: `${rect.y}px` });
        say('카드 이동');
      }
    };
    const end = (ev: PointerEvent | { type: 'cancel' }) => {
      if (done) return;
      done = true;
      if (raf !== null) cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.removeEventListener('lostpointercapture', onLost);
      window.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('pane-dragging');
      section.classList.remove('pane-drag-source');
      card?.classList.remove('drag-move');
      ghost?.remove();
      marker?.remove();
      if (!active) return;
      const drop = ev.type === 'pointerup' ? result : null;
      if (!drop) { if (card && cardStyle) Object.assign(card.style, cardStyle); say('끌기 취소'); return; }
      if (drop.kind === 'reorder') { if (drop.to !== from) dispatch({ type: 'move_pane', paneId, to: drop.to }); say(drop.to === from ? '제자리' : `${drop.to + 1}번째 자리로 옮겼습니다`); }
      else if (drop.kind === 'dock') { dispatch({ type: 'dock_pane', paneId, to: drop.to }); say(`${drop.to + 1}번째 자리에 붙였습니다`); }
      else if (drop.kind === 'float') { dispatch({ type: 'float_pane', paneId, rect: drop.rect }); say('카드로 뗐습니다'); }
      else { dispatch({ type: 'move_float', paneId, rect: drop.rect }); say('카드를 옮겼습니다'); }
      requestFocus(paneId);
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && active) { ev.preventDefault(); ev.stopPropagation(); end({ type: 'cancel' }); } };
    // Capture taken away (the element re-rendered, the browser gave up on the pointer): nothing is left half-dragged.
    const onLost = () => end({ type: 'cancel' });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', onLost);
    window.addEventListener('keydown', onKey, true);
  };
  /** ⋯ 떠 있는 카드로 떼기 / Enter on the grip: the pane as a card, staggered from the top-left so cards do not pile up. */
  const floatPane = (paneId: string) => {
    const body = bodyRef.current;
    const bounds = { w: body?.clientWidth ?? 1200, h: body?.clientHeight ?? 600 };
    const n = latest.current.panes.filter((p) => p.float).length;
    dispatch({ type: 'float_pane', paneId, rect: floatRectAt({ x: 80 + 24 * n, y: 40 + 24 * n }, { w: 480, h: bounds.h }, bounds) });
    requestFocus(paneId);
    announce('카드로 뗐습니다');
  };
  const dockPane = (paneId: string) => {
    dispatch({ type: 'dock_pane', paneId });
    requestFocus(paneId);
    announce('패널에 붙였습니다');
  };
  /** ⋯ 떠 있는 카드 정렬: every card dealt into a grid over the body, in array order. */
  const arrangeCards = () => {
    const body = bodyRef.current;
    const bounds = { w: body?.clientWidth ?? 1200, h: body?.clientHeight ?? 600 };
    const cards = latest.current.panes.filter((p) => p.float);
    const rects = arrangeFloats(cards.length, bounds);
    cards.forEach((p, i) => dispatch({ type: 'move_float', paneId: p.id, rect: rects[i]! }));
    announce(`카드 ${cards.length}장을 정렬했습니다`);
  };
  const bodyBounds = () => { const body = bodyRef.current; return { w: body?.clientWidth ?? 1200, h: body?.clientHeight ?? 600 }; };
  /** Arrow keys as a (dx, dy) step: 24px, 96 with Shift; null for any other key. */
  const arrowStep = (e: ReactKeyboardEvent): { dx: number; dy: number } | null => {
    const d = e.shiftKey ? 96 : 24;
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
    const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
    return dx || dy ? { dx, dy } : null;
  };
  /** The ⋮⋮ grip from the keyboard: ←→ reorder a docked pane (←→↑↓ move a card by 24px, 96 with Shift); Enter/Space floats or docks. */
  const gripKey = (e: ReactKeyboardEvent<HTMLButtonElement>, paneId: string) => {
    const pane = latest.current.panes.find((p) => p.id === paneId);
    if (!pane || e.altKey || e.metaKey || e.ctrlKey) return;
    const act = e.key === 'Enter' || e.key === ' ';
    if (pane.float) {
      const step = arrowStep(e);
      if (step) {
        e.preventDefault();
        const rect = clampFloat({ ...pane.float, x: pane.float.x + step.dx, y: pane.float.y + step.dy }, bodyBounds());
        dispatch({ type: 'move_float', paneId, rect });
        announce(`카드 위치 ${rect.x}, ${rect.y}`);
      } else if (act) { e.preventDefault(); dockPane(paneId); }
      return;
    }
    const docked = dockedPanes(latest.current.panes);
    const i = docked.findIndex((p) => p.id === paneId);
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); dispatch({ type: 'move_pane', paneId, to: i - 1 }); announce(`${i}번째 자리로 옮겼습니다`); }
    else if (e.key === 'ArrowRight' && i >= 0 && i < docked.length - 1) { e.preventDefault(); dispatch({ type: 'move_pane', paneId, to: i + 1 }); announce(`${i + 2}번째 자리로 옮겼습니다`); }
    else if (act && docked.length > 1) { e.preventDefault(); floatPane(paneId); }
  };
  /** The ◢ corner from the keyboard: ←→ width, ↑↓ height (24px, 96 with Shift), never below the minimum. */
  const resizeKey = (e: ReactKeyboardEvent<HTMLDivElement>, paneId: string) => {
    const pane = latest.current.panes.find((p) => p.id === paneId);
    const step = pane?.float ? arrowStep(e) : null;
    if (!pane?.float || !step || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    const rect = clampFloat({ ...pane.float, w: Math.max(FLOAT_MIN_W, pane.float.w + step.dx), h: Math.max(FLOAT_MIN_H, pane.float.h + step.dy) }, bodyBounds());
    dispatch({ type: 'move_float', paneId, rect });
    announce(`카드 크기 ${rect.w} × ${rect.h}`);
  };
  /** The ◢ corner of a floating card: its size follows the pointer; the state gets the final box. */
  const startFloatResize = (e: ReactPointerEvent<HTMLDivElement>, paneId: string) => {
    const body = bodyRef.current;
    const card = e.currentTarget.closest<HTMLElement>('.float-card');
    const pane = latest.current.panes.find((p) => p.id === paneId);
    if (e.button !== 0 || !body || !card || !pane?.float) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const start = pane.float;
    const bounds = { w: body.clientWidth, h: body.clientHeight };
    let rect: FloatRect | null = null;
    const move = (ev: PointerEvent) => {
      rect = clampFloat({ ...start, w: Math.max(FLOAT_MIN_W, start.w + (ev.clientX - startX)), h: Math.max(FLOAT_MIN_H, start.h + (ev.clientY - startY)) }, bounds);
      Object.assign(card.style, { width: `${rect.w}px`, height: `${rect.h}px` });
    };
    const end = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      if (ev.type === 'pointercancel' || !rect) { Object.assign(card.style, { width: `${start.w}px`, height: `${start.h}px` }); return; }
      dispatch({ type: 'move_float', paneId, rect });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  const openIn = (paneId: string, sessionId: string | null, cwd: string, title: string) => {
    apply({ type: 'open', sessionId, cwd, title, paneId });
    if (sessionId) { catchup.current?.forget(sessionId); send({ type: 'open_session', sessionId }); }
    setDrawer(false); closePeek();
    requestFocus(paneId);
  };
  openById.current = (sessionId) => {
    const pane = state.panes.find((p) => p.session?.sessionId === sessionId);
    if (pane) { dispatch({ type: 'focus_pane', paneId: pane.id }); requestFocus(pane.id); return true; }
    const hit = findSession(state.projects, state.desktop, sessionId);
    if (!hit) return false;
    openIn(active.id, sessionId, hit.cwd, hit.title);
    return true;
  };
  const showError = (fallback: string) => (err: unknown) => dispatch({ type: 'show_error', message: err instanceof Error ? err.message : fallback });
  const recent = recentSessions(state.projects);
  /** ⌘N / 새 대화: the focused pane goes back to the new-chat screen, its project preselected. */
  const newChat = (paneId = active.id) => {
    const pane = state.panes.find((p) => p.id === paneId);
    const cwd = pane?.session?.cwd;
    if (cwd) setNewChatCwd((m) => ({ ...m, [paneId]: cwd }));
    if (pane?.session) apply({ type: 'clear_pane', paneId });
    dispatch({ type: 'focus_pane', paneId });
    setDrawer(false); closePeek();
    requestFocus(paneId);
  };
  const startChat = (paneId: string, cwd: string, name: string, text: string, attachments: UploadedAttachment[] = []) => {
    openIn(paneId, null, cwd, `${name} · 새 세션`);
    const pane = latest.current.panes.find((p) => p.id === paneId);
    // Same first-turn defaults as the composer of a new session: pane model/engine/sandbox, 새 세션 기본 권한.
    if (text && pane) sendFromPane(pane, text, attachments, dispatch, send, latest.current.defaultPermMode);
  };
  const openHit = (h: SearchHit) => {
    if (active.session?.sessionId !== h.sessionId) openIn(active.id, h.sessionId, h.cwd, h.title);
    else { setDrawer(false); closePeek(); }
    setScrollTo({ paneId: active.id, sessionId: h.sessionId, snippet: h.snippet, match: h.snippet.slice(h.matchStart, h.matchStart + h.matchLength), until: Date.now() + 15_000 });
  };
  const stepSession = (dir: -1 | 1) => {
    if (!recent.length) return;
    const i = recent.findIndex((s) => s.sessionId === active.session?.sessionId);
    const next = recent[i < 0 ? 0 : Math.min(Math.max(i + dir, 0), recent.length - 1)]!;
    if (next.sessionId !== active.session?.sessionId) openIn(active.id, next.sessionId, next.cwd, next.title);
  };
  const toggleSidebar = () => { if (phone) setDrawer((d) => !d); else setSidebarHidden((h) => !h); };
  /** + 분할 / ⌘⇧O: another pane (a phone shows it as another tab). No ceiling the user meets: the grid scrolls sideways. */
  const addPane = () => { dispatch({ type: 'add_pane' }); requestFocus(); };
  /**
   * ⋯ 분할 보기로 열기: a new pane, then the session in it — even one another pane already shows (the same session in two
   * panes is allowed). `apply` moves latest.current on at once, so the new pane's id is read from there.
   * This rests on add_pane's id being deterministic (`p${max+1}`): the reducer run again by React makes the same id.
   */
  const openSplit = (sessionId: string, cwd: string, title: string) => {
    apply({ type: 'add_pane' });
    openIn(latest.current.activePaneId, sessionId, cwd, title);
  };
  /** ⌘⌥[ / ⌘⌥]: the pane to the left / right (on a phone: the previous / next tab) becomes active, wrapping. */
  const stepPane = (dir: -1 | 1) => {
    const panes = state.panes;
    if (panes.length < 2) return;
    const i = panes.findIndex((p) => p.id === active.id);
    const next = panes[(i + dir + panes.length) % panes.length]!;
    dispatch({ type: 'focus_pane', paneId: next.id });
    requestFocus(next.id);
  };
  /** ⌘⇧X: the active pane closes as its ✕ would (a running turn keeps running, as with ✕); the last pane stays. */
  const closeActivePane = () => {
    if (state.panes.length < 2) return;
    apply({ type: 'close_pane', paneId: active.id });
    requestFocus();
  };
  onShortcut.current = (id) => {
    if (id === 'palette') { setHelpOpen(false); setPaletteOpen((o) => !o); }
    else if (id === 'help') { setPaletteOpen(false); setHelpOpen((o) => !o); }
    else if (id === 'new-chat') newChat();
    else if (id === 'new-pane') addPane();
    else if (id === 'prev-session') stepSession(-1);
    else if (id === 'next-session') stepSession(1);
    else if (id === 'toggle-sidebar') toggleSidebar();
    else if (id === 'settings') { setPaletteOpen(false); setHelpOpen(false); setSettingsOpen((o) => !o); }
    else if (id === 'prev-pane' || id === 'next-pane') stepPane(id === 'prev-pane' ? -1 : 1);
    else if (id === 'close-pane') closeActivePane();
  };
  const mod = MAC ? '⌘' : 'Ctrl+';
  const actions: PaletteAction[] = [
    { id: 'new-chat', label: '새 대화', hint: `${mod}N`, run: () => newChat() },
    { id: 'new-pane', label: '새 분할', hint: `${mod}⇧O`, run: addPane },
    { id: 'settings', label: '설정 열기', hint: `${mod},`, run: () => window.dispatchEvent(new CustomEvent('deck:open-settings')) },
    { id: 'usage', label: '사용량 보기', run: () => setUsageOpen(true) },
    ...(has('highlights') ? [{ id: 'highlights', label: '하이라이트 보기', run: () => setHighlightsOpen(true) }] : []),
    { id: 'theme', label: '테마 전환', run: () => window.dispatchEvent(new CustomEvent('deck:cycle-theme')) },
    { id: 'sidebar', label: phone ? '사이드바 열기' : sidebarHidden ? '사이드바 보이기' : '사이드바 숨기기', hint: `${mod}\\`, run: toggleSidebar },
    { id: 'help', label: '단축키 보기', hint: `${mod}/`, run: () => setHelpOpen(true) },
  ];
  const paletteSessions: PaletteSession[] = [
    ...recent.map((s) => ({ sessionId: s.sessionId, title: s.title, cwd: s.cwd, project: s.project, lastModified: s.lastModified, engine: engineOf(s) })),
    ...state.desktop.filter((d) => !d.archived && !recent.some((s) => s.sessionId === d.sessionId)).map((d) => ({ sessionId: d.sessionId, title: d.title, cwd: d.cwd, project: `${d.project} · Desktop`, lastModified: d.lastModified })),
  ].sort((a, b) => b.lastModified - a.lastModified);
  /** 삭제, step 1: refuse what is running here; otherwise ask. */
  const askDelete = (s: SessionEntry, which?: string) => {
    const busy = state.panes.some((p) => p.session?.sessionId === s.sessionId && (p.activeTurnId !== null || p.awaitingStart)) || state.activity.some((a) => a.sessionId === s.sessionId && (a.running || a.bg > 0));
    if (busy) { dispatch({ type: 'show_error', message: '실행 중인 대화는 삭제할 수 없어요 — 끝난 뒤 다시 시도하세요' }); return; }
    setConfirmDelete(which ? { s, which } : { s });
  };
  const doDelete = (s: SessionEntry, which?: string) => {
    setConfirmDelete(null);
    trashSession(s.sessionId).then(({ trashId }) => {
      for (const p of latest.current.panes) if (p.session?.sessionId === s.sessionId) { setNewChatCwd((m) => ({ ...m, [p.id]: s.cwd })); apply({ type: 'clear_pane', paneId: p.id }); }
      setUndo({ kind: 'trash', trashId, title: s.title, ...(which ? { which } : {}) });
    }, showError('삭제 실패'));
  };
  // The sidebar ⋯ menu and the chat title ⌄ menu share these.
  const togglePin = (sessionId: string, pinned: boolean) => { postPin(sessionId, pinned).then((pins) => dispatch({ type: 'set_pins', pins }), showError('고정 실패')); };
  const renameSession = (sessionId: string, title: string | null) => { postSessionMeta(sessionId, { title }).catch(showError('이름 바꾸기 실패')); };
  const archiveSession = (sessionId: string, archived: boolean) => {
    // A 삭제 undo still showing keeps its slot: the archive can be undone from the archived list anyway.
    postSessionMeta(sessionId, { archived }).then(() => { if (archived) setUndo((u) => (u?.kind === 'trash' ? u : { kind: 'archive', sessionId })); }, showError('보관 실패'));
  };
  const setCwd = has('sessionOps') ? (s: SessionEntry) => setCwdFor(s) : undefined;
  const duplicate = has('sessionOps') ? (sessionId: string) => { send({ type: 'duplicate_session', sessionId }); } : undefined;
  const sessionActions = { pins: state.pins, onRename: renameSession, onTogglePin: togglePin, onArchive: archiveSession, onDelete: (s: SessionEntry) => askDelete(s), ...(setCwd ? { onSetCwd: setCwd } : {}), ...(duplicate ? { onDuplicate: duplicate } : {}) };
  const footAccount = active.session?.account ?? null;
  const orphanPerms = orphanCards(state.panes, state.pending);
  const orphanQs = orphanCards(state.panes, state.questions);
  const waitingCards = [...state.pending, ...state.questions].map((c) => ({ sessionId: c.sessionId, cwd: c.cwd, turnId: c.turnId }));
  /** A session's name for the 작업 현황 list: its title, else its folder, else its id's first 8 characters. */
  const titleOf = (sessionId: string, cwd: string | null) => paletteSessions.find((x) => x.sessionId === sessionId)?.title
    ?? state.panes.find((p) => p.session?.sessionId === sessionId)?.session?.title
    ?? (cwd ? cwd.split('/').filter(Boolean).pop() : undefined)
    ?? sessionId.slice(0, 8);
  const preview = previewKey && state.routePreview && state.routePreview.sessionId === previewKey.sessionId ? state.routePreview : null;
  const busySessions = state.activity.filter((a) => a.running || a.bg > 0).length;

  return (
    <AccountsContext value={accounts}>
    <div className="app">
      <header className="topbar">
        {phone && <button type="button" className="menu" aria-label="메뉴" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>☰</button>}
        {/* Tablet / unfolded (721–1100px, CSS only shows it there): a visible way to fold the sidebar away without ⌘\. */}
        {!phone && <button type="button" className="icon-btn sidebar-toggle" aria-label={sidebarHidden ? '사이드바 보이기' : '사이드바 숨기기'} title={sidebarHidden ? '사이드바 보이기' : '사이드바 숨기기'} aria-pressed={!sidebarHidden} onClick={toggleSidebar} onMouseEnter={peekable && !peek ? armPeek : undefined} onMouseLeave={peekable ? () => { unlatchPeek(); leavePeek(); } : undefined}>☰</button>}
        <span className="brand"><DeckMark className="spark" />deck</span>
        <button type="button" className="text-btn palette-open" onClick={() => setPaletteOpen(true)} title={`세션 검색 · 명령 (${mod}K)`} aria-label="세션 검색 · 명령">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="4.75" /><path d="m10.5 10.5 3.25 3.25" /></svg>
          {!phone && <><span>검색</span><kbd>{mod}K</kbd></>}
        </button>
        <UsagePanel usage={state.usage} current={active.session?.account ?? null} onOpenHistory={() => setUsageOpen(true)} next={!phone ? preview : null} />
        <div className="topbar-end">
          {!phone && <WorkStatus activity={state.activity} waiting={waitingCards} titleOf={titleOf} onNewChat={() => newChat()} onOpenHighlights={has('highlights') ? () => setHighlightsOpen(true) : undefined} onOpen={(r) => {
            if (r.sessionId) { if (!openById.current(r.sessionId) && r.cwd) openIn(active.id, r.sessionId, r.cwd, r.title); return; }
            // 새 대화: the pane whose turn the card belongs to.
            const pane = state.panes.find((p) => p.activeTurnId === r.turnId || p.myTurns.includes(r.turnId ?? ''));
            if (pane) { dispatch({ type: 'focus_pane', paneId: pane.id }); requestFocus(pane.id); }
          }} />}
          {!phone && has('highlights') && <HighlightsBadge ready={state.ready} running={state.activity.filter((a) => a.running).length} onOpen={() => setHighlightsOpen(true)} />}
          {!phone && <ServerChip startedAt={state.serverStartedAt} restartedAt={state.restartedAt} draining={state.draining} busy={busySessions} onDismissRestart={() => dispatch({ type: 'dismiss_restart' })} />}
          <button type="button" className="text-btn uv-open" onClick={() => setUsageOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={usageOpen} data-sheet-return="" title="토큰 사용량 기록 (주별·일별)">사용량</button>
          {!phone && <button type="button" className="text-btn split" onClick={addPane} title="분할보기: 패널 하나 더 (⋮⋮ 를 끌어 순서를 바꾸거나 카드로 떼어낼 수 있어요)">{state.panes.length >= 2 ? `+ 분할 ${state.panes.length}` : '+ 분할'}</button>}
          <NotifyMenu />
          {state.connected
            ? <span className="conn on" title="연결됨">연결됨</span>
            : <button type="button" className="conn off" onClick={retryNow} title={downSince !== null ? `서버 응답 없음 · ${hhmm(downSince)}부터 — 눌러서 다시 시도` : '재연결 중… — 눌러서 지금 다시 시도'}>{downSince !== null ? '서버 응답 없음' : '재연결 중…'}</button>}
        </div>
      </header>
      {downSince !== null && (
        <div className="conn-down" role="status">
          <span>서버 응답 없음 · {hhmm(downSince)}부터 — 연결되면 자동으로 이어집니다</span>
          <button type="button" className="text-btn" onClick={retryNow}>다시 시도</button>
        </div>
      )}
      {usageOpen && <UsageView onClose={() => setUsageOpen(false)} />}
      {highlightsOpen && <Highlights onClose={() => setHighlightsOpen(false)} engineOf={(id) => paletteSessions.find((x) => x.sessionId === id)?.engine} onOpenSession={(sessionId, cwd, title) => { setHighlightsOpen(false); if (!openById.current(sessionId)) openIn(active.id, sessionId, cwd, title); }} />}
      {settingsOpen && <SettingsView build={buildId} defaultPermMode={state.defaultPermMode} onDefaultPermMode={(defaultPermissionMode) => send({ type: 'set_settings', defaultPermissionMode })} routingPolicy={state.routingPolicy} onRoutingPolicy={(routingPolicy) => send({ type: 'set_settings', routingPolicy })} onOpenUsage={() => setUsageOpen(true)} onOpenHighlights={has('highlights') ? () => setHighlightsOpen(true) : undefined} onClose={() => setSettingsOpen(false)} />}
      {paletteOpen && <CommandPalette sessions={paletteSessions} actions={actions} onClose={closePalette} onOpenSession={(s) => openById.current(s.sessionId) || openIn(active.id, s.sessionId, s.cwd, s.title)} onOpenHit={openHit} searchFn={searchTranscripts} />}
      {helpOpen && <ShortcutHelp mac={MAC} onClose={closeHelp} />}
      {cwdFor && <SessionCwdDialog title={cwdFor.title} cwd={cwdFor.cwd} onClose={() => setCwdFor(null)} onPick={(cwd) => { setCwdFor(null); send({ type: 'set_cwd', sessionId: cwdFor.sessionId, cwd }); }} />}
      {confirmDelete && (
        <ConfirmDialog title="대화 삭제" danger confirmLabel="삭제" onCancel={cancelDelete} onConfirm={() => doDelete(confirmDelete.s, confirmDelete.which)}
          message={`“${confirmDelete.s.title}”${confirmDelete.which ? ` (${confirmDelete.which})` : ''} 을(를) 목록에서 지울까요? 파일은 휴지통(session-trash)으로 옮겨지고 바로 되돌릴 수 있어요.`} />
      )}
      {undo?.kind === 'trash' && (
        <div className="toast" role="status">
          <span>“{undo.title.length > 40 ? `${undo.title.slice(0, 40)}…` : undo.title}”{undo.which ? ` (${undo.which})` : ''} 삭제됨</span>
          <button type="button" className="text-btn" onClick={() => { const { trashId } = undo; setUndo(null); restoreSession(trashId).catch(showError('되돌리기 실패')); }}>되돌리기</button>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={() => setUndo(null)}>✕</button>
        </div>
      )}
      {undo?.kind === 'archive' && (
        <div className="toast" role="status">
          <span>보관했어요</span>
          <button type="button" className="text-btn" onClick={() => { const { sessionId } = undo; setUndo(null); postSessionMeta(sessionId, { archived: false }).catch(showError('되돌리기 실패')); }}>되돌리기</button>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={() => setUndo(null)}>✕</button>
        </div>
      )}
      {newBuild && <button type="button" className="update-pill" onClick={() => location.reload()}>새 버전이 있어요 · 새로고침</button>}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
      {(orphanPerms.length > 0 || orphanQs.length > 0) && (
        <div className="global-cards">
          {orphanPerms.map((p) => <PermissionCard key={p.requestId} req={p} onDecide={(requestId, decision) => send({ type: 'permission_response', requestId, decision })} />)}
          {orphanQs.map((q) => <QuestionCard key={q.requestId} req={q} onAnswer={(requestId, answers) => send({ type: 'question_response', requestId, answers })} />)}
        </div>
      )}
      <div ref={bodyRef} className="body">
        <div ref={liveRef} className="sr-only" aria-live="polite" aria-atomic="true" data-testid="cards-live" />
        {phone && drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
        {peekable && <div className="sidebar-hotzone" data-testid="sidebar-hotzone" aria-hidden="true" onMouseEnter={peek ? undefined : armPeek} onMouseLeave={() => { unlatchPeek(); if (!peek) clearPeekTimer(); }} />}
        <div
          ref={sidebarWrap}
          className={`sidebar-wrap ${phone ? 'drawer' : ''} ${drawer ? 'open' : ''} ${tucked ? 'hidden' : ''} ${peek ? 'peek' : ''}`}
          onMouseEnter={peek ? clearPeekTimer : undefined}
          onMouseLeave={peekable ? () => { unlatchPeek(); if (peek) leavePeek(); } : undefined}
        >
          <Sidebar
            projects={state.projects}
            currentSessionId={active.session?.sessionId ?? null}
            onOpen={(sessionId, cwd, title) => openIn(active.id, sessionId, cwd, title)}
            onOpenSplit={openSplit}
            onNew={(cwd, name) => openIn(active.id, null, cwd, `${name} · 새 세션`)}
            onRefresh={() => send({ type: 'refresh_index' })}
            pins={state.pins}
            pinShortcut={openPinned}
            desktop={state.desktop}
            onTogglePin={togglePin}
            onReorderPins={(order) => {
              // Optimistic: the new order shows at once. Only the latest move's answer counts — an older one arriving
              // late must not undo a newer move (the index broadcast settles those). A failed save puts the old order
              // back, keeping pins added meanwhile (on top, like a new pin).
              const seq = ++pinOrderSeq.current;
              const before = latest.current.pins;
              dispatch({ type: 'set_pins', pins: order });
              postPinOrder(order).then(
                (pins) => { if (seq === pinOrderSeq.current) dispatch({ type: 'set_pins', pins }); },
                (err: unknown) => {
                  if (seq !== pinOrderSeq.current) return;
                  const now = latest.current.pins;
                  const kept = new Set(before);
                  const has = new Set(now);
                  dispatch({ type: 'set_pins', pins: [...now.filter((id) => !kept.has(id)), ...before.filter((id) => has.has(id))] });
                  dispatch({ type: 'show_error', message: err instanceof Error ? err.message : '고정 순서 변경 실패' });
                },
              );
            }}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            onRename={renameSession}
            onArchive={archiveSession}
            onOpenHit={openHit}
            view={sidebarView}
            onViewChange={setSidebarView}
            onDelete={askDelete}
            onSetCwd={setCwd}
            onDuplicate={duplicate}
            activity={state.activity}
            unread={state.unread}
            waiting={[...state.pending, ...state.questions].map((c) => c.sessionId).filter((id): id is string => !!id)}
            onOpenSettings={() => setSettingsOpen(true)}
            avatar={footAccount ? ([...accounts.label(footAccount)][0] ?? '').toUpperCase() : 'D'}
            avatarTitle={footAccount ? `deck · ${footAccount === 'gpt' ? 'GPT' : `계정 ${accounts.label(footAccount)}`}` : 'deck'}
            footMenu={[
              { label: '설정', hint: `${mod},`, run: () => setSettingsOpen(true) },
              { label: '사용량 기록', run: () => setUsageOpen(true) },
              { label: `테마: ${THEME_LABEL[prefs.theme]}`, run: () => window.dispatchEvent(new CustomEvent('deck:cycle-theme')) },
              { label: '단축키', hint: `${mod}/`, run: () => setHelpOpen(true) },
              { label: '새로고침', run: () => location.reload() },
            ]}
            onOpenFolder={(cwd) => openIn(active.id, null, cwd, `${cwd.split('/').filter(Boolean).pop() ?? cwd} · 새 세션`)}
            onNewChat={() => newChat()}
          />
        </div>
        <div ref={panesRef} className="panes" data-count={phone ? 1 : docked.length} style={{ '--cols': phone ? 1 : docked.length, ...(!phone && docked.length > 1 ? { gridTemplateColumns: paneColumns(docked.map((p) => paneSize(p.size))) } : {}) } as CSSProperties}>
          {phone && state.panes.length > 1 && (
            <div className="pane-switch" {...tabs.stripProps}>
              {state.panes.map((p, i) => <button type="button" key={p.id} data-tab={p.id} className={p.id === active.id ? 'on' : ''} onClick={() => { dispatch({ type: 'focus_pane', paneId: p.id }); requestFocus(p.id); }}>{i + 1}{p.session ? ` · ${p.session.title.slice(0, 12)}` : ''}</button>)}
              <button type="button" className="add" aria-label="새 분할" title="새 분할" onClick={addPane}>+</button>
            </div>
          )}
          {(phone ? [active] : docked).map((p, i, shown) => (
            <Fragment key={p.id}>
            {i > 0 && (
              <div className="pane-splitter" role="separator" aria-orientation="vertical" aria-label="패널 폭 조절" title="드래그: 폭 조절 · 더블클릭: 균등"
                onPointerDown={(e) => startPaneResize(e, shown[i - 1]!.id, p.id)}
                onDoubleClick={() => dispatch({ type: 'resize_panes', sizes: Object.fromEntries(docked.map((x) => [x.id, 1])) })} />
            )}
            <Pane pane={p} app={state} active={p.id === state.activePaneId} closable={state.panes.length > 1} dispatch={dispatch} send={send} onClose={() => { apply({ type: 'close_pane', paneId: p.id }); requestFocus(); }} onOpenSession={(sessionId, cwd, title) => openIn(p.id, sessionId, cwd, title)}
              onStartChat={(cwd, name, text, attachments) => startChat(p.id, cwd, name, text, attachments)} newChatCwd={newChatCwd[p.id] ?? null} sessionActions={sessionActions}
              {...(!phone && (docked.length > 1 || floats.length > 0) ? { grip: { onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => startPaneDrag(e, p.id), onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => gripKey(e, p.id) } } : {})}
              {...(!phone && docked.length > 1 ? { onFloat: () => floatPane(p.id), onShift: { ...(i > 0 ? { left: () => dispatch({ type: 'move_pane', paneId: p.id, to: i - 1 }) } : {}), ...(i < shown.length - 1 ? { right: () => dispatch({ type: 'move_pane', paneId: p.id, to: i + 1 }) } : {}) } } : {})} />
            </Fragment>
          ))}
        </div>
        {!phone && floats.length > 0 && (
          <div className="floats">
            {floats.map((p) => (
              <div key={p.id} className={`float-card${p.id === state.activePaneId ? ' on' : ''}`} data-float={p.id} style={{ left: p.float!.x, top: p.float!.y, width: p.float!.w, height: p.float!.h }}>
                <Pane pane={p} app={state} active={p.id === state.activePaneId} closable dispatch={dispatch} send={send} onClose={() => { apply({ type: 'close_pane', paneId: p.id }); requestFocus(); }} onOpenSession={(sessionId, cwd, title) => openIn(p.id, sessionId, cwd, title)}
                  onStartChat={(cwd, name, text, attachments) => startChat(p.id, cwd, name, text, attachments)} newChatCwd={newChatCwd[p.id] ?? null} sessionActions={sessionActions}
                  floating grip={{ onPointerDown: (e) => startPaneDrag(e, p.id), onKeyDown: (e) => gripKey(e, p.id) }} onDock={() => dockPane(p.id)} {...(floats.length > 1 ? { onArrange: arrangeCards } : {})} />
                <div className="float-resize" role="separator" tabIndex={0} aria-label="카드 크기 조절" aria-valuetext={`${p.float!.w} × ${p.float!.h}`} title="드래그: 카드 크기 · 키보드: ←→ 너비, ↑↓ 높이 (Shift: 크게)"
                  onPointerDown={(e) => startFloatResize(e, p.id)} onKeyDown={(e) => resizeKey(e, p.id)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
    </AccountsContext>
  );
}
