import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { isGeminiAccount, isGrokAccount, type AccountNames } from '../shared/accounts';
import { DEFAULT_CODEX_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_GROK_MODEL, DEFAULT_SANDBOX, defaultGeminiSandbox, IMPORTED_DEFAULT_MODEL, isGrokModel, type ClaudeModel, type CodexSandbox, type EngineKind } from '../shared/models';
import { CLIENT_REF_MAX, ClientMessageSchema, FEATURES, accountInfos, type ClientMessage, type CommanderView, type StreamPos, type GeminiStatus, type GrokStatus, type RefusalCode, type RunningTurn, type ServerMessage, type SessionActivity, type TurnPrompt } from '../shared/protocol';
import type { SessionEntry, TranscriptMessage } from '../shared/session-types';
import type { PermissionDecision, QuestionAnswers } from '../shared/turn-types';
import { checkUpgrade } from './auth';
import type { AcceptedRefs } from './sessions/AcceptedRefs';
import { DirError, resolveUnderRoots } from './dirs';
import { HANDOFF_PROMPT, codexHandoffExcerpt, handoffTitle } from '../shared/handoff';
import { readCodexTranscript, readCodexTranscriptTail } from './engine/codexRollout';
import { sessionAllowLabel } from './engine/Engine';
import { isGrokAutoApprovable } from './engine/GrokEngine';
import { displayError, redactSecrets } from './engine/redact';
import { CWD_MISSING_NOTICE, importBlockReason, liveRolloutNotice, rolloutActiveAgeMs } from './sessions/CodexImports';
import { findGrokSessionDir, readGrokTranscriptTail } from './engine/grokHistory';
import { elsewhereNotice } from './sessions/elsewhereNotice';
import { GROKBOT_READONLY_NOTICE, readGrokBotTranscript } from './sessions/GrokBotImports';
import { grokImportBlockReason } from './sessions/GrokImports';
import { OWN_LAG_MS, scanForeign } from './sessions/foreignWrites';
import { deckWrites } from './engine/claudeCli/ownedEntries';
import { isPinnableId, type PinStore } from './sessions/PinStore';
import type { SessionMetaStore } from './sessions/SessionMetaStore';
import type { SettingsStore } from './settings';
import { TCC_DENIAL_NOTICE, isTccDenial } from './tccDenial';
import type { ProcessHolders } from './sessions/ProcessHolders';
import type { SessionIndex } from './sessions/SessionIndex';
import { readBranchPoint, readTranscript, type BranchPoint } from './sessions/transcript';
import { isCodexState, isGeminiState, isGrokState, isOtherEngineState, type ClaudeSessionState, type SessionStateStore } from './turn/SessionState';
import { abortedText, RESEND_NOTICE, ROUTE_ENGINE_LABEL, SHUTDOWN_ABORT, type TurnRunner, type TurnSink } from './turn/TurnRunner';
import type { UsageService } from './usage/UsageService';
import { SegmentCollector } from './commander/digest';
import { DISABLED_MESSAGE, type CommanderResult, type CommanderSendRequest } from './commander/Commander';
import type { SegmentDigest } from './commander/types';
import type { TaskRegistry } from './tasks/TaskRegistry';
import type { PushPayload } from './push/PushNotifier';
import { TASKS_QUEUED_MAX, TASK_CANCELED_LINE, clampTaskCap } from '../shared/tasks';
import { setLocale, type Locale } from '../shared/locale';
import { turnLanguage } from './turn/language';
import { resolveServerLocale, sm } from './i18n';

const FORK_NOTICE = "Desktop 에서 따로 이어진 대화가 있어 갈라졌습니다 — 머리글의 '갈라짐' 메뉴에서 어느 쪽으로 맞출지 고를 수 있습니다";

/** Following an outside write is silent; only background work the restarted process had to drop is worth a line (`n`: tasks stopped). */
/** ⚡ 빠르게 switched while a process was held open: a new one answers, so its waiting background tasks end. */
/** ⚡ The held process still runs background work when ↯ was switched: it is left to finish, then the send starts a new process. */
export const fastWaitNotice = (n: number) => `↯ 빠르게 설정이 바뀌어, 백그라운드 작업 ${n}개가 끝나면 새 프로세스로 보냅니다`;
/** turn_queued `behind` for a send waiting on that background work (the status row: "… 뒤에서 기다리는 중"). */
export const FAST_WAIT_BEHIND = '백그라운드 작업(↯ 설정 바뀜)';
/** steer_rejected when ↯ differs from the running process's: sent after the turn instead, as a send (new process). */
export const FAST_STEER_REJECTED = '↯ 빠르게 설정이 바뀌어 이 턴이 끝난 뒤 새로 보냅니다';
/** Whether a send asks for ⚡ 빠르게 (never on a handoff — TurnRunner.fastTurn). */
const fastSend = (m: { fast?: boolean; handoff?: boolean }) => m.fast === true && !m.handoff;
export const recycleNotice = (n: number) => `AI-MSG 밖(Claude Desktop 등)에서 이어진 대화를 이어받느라, 기다리던 백그라운드 작업 ${n}개가 중단됐습니다`;

/** How often, while a browser is connected, deck looks for outside holders (one `ps`), outside writes to the open sessions and newer mtimes of the listed transcripts (a stat each). */
export const OUTSIDE_POLL_MS = 15_000;
/** An entry is stamped a moment before it reaches the file: writes this much older than the last history sent are looked at again. */
const OUTSIDE_SLACK_MS = 2000;

type PermissionMsg = Extract<ServerMessage, { type: 'permission_request' }>;
type QuestionMsg = Extract<ServerMessage, { type: 'question_request' }>;

export const PERMISSION_TIMEOUT_MS = 30 * 60_000;

/**
 * Holds unanswered prompts so a reconnecting browser sees them again (spec §8).
 * Review I5: a prompt also closes — with `cancelValue`, announced to every client via `onResolved` —
 * when its signal aborts, when its turn ends (cancelTurn), or after a long timeout.
 */
export class AskBroker<M extends { requestId: string; turnId: string }, R> {
  protected waiting = new Map<string, { msg: M; resolve: (r: R) => void; cleanup: () => void }>();

  constructor(
    private readonly send: (m: M) => void,
    private readonly onResolved: (requestId: string, result: R) => void,
    private readonly cancelValue: R,
    private readonly timeoutMs: number,
  ) {}

  ask(msg: M, signal?: AbortSignal): Promise<R> {
    if (signal?.aborted) return Promise.resolve(this.cancelValue);
    return new Promise((resolve) => {
      const onAbort = () => this.resolve(msg.requestId, this.cancelValue);
      const timer = setTimeout(onAbort, this.timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.waiting.set(msg.requestId, { msg, resolve, cleanup });
      this.send(msg);
    });
  }

  resolve(requestId: string, result: R): boolean {
    const w = this.waiting.get(requestId);
    if (!w) return false;
    this.waiting.delete(requestId);
    w.cleanup();
    w.resolve(result);
    this.onResolved(requestId, result);
    return true;
  }

  /** Cancel every prompt still open for this turn (it finished, failed or was interrupted). */
  cancelTurn(turnId: string): void {
    for (const [id, w] of [...this.waiting]) if (w.msg.turnId === turnId) this.resolve(id, this.cancelValue);
  }

  pending(): M[] {
    return [...this.waiting.values()].map((w) => w.msg);
  }
}

export class PermissionBroker extends AskBroker<PermissionMsg, PermissionDecision> {
  constructor(broadcast: (m: ServerMessage) => void, opts: { timeoutMs?: number } = {}) {
    super(broadcast, (requestId, decision) => broadcast({ type: 'permission_resolved', requestId, decision }), 'deny', opts.timeoutMs ?? PERMISSION_TIMEOUT_MS);
  }
}

/** D8: AskUserQuestion cards; null = unanswered (timeout, abort, turn end) → the engine denies the tool call. */
export class QuestionBroker extends AskBroker<QuestionMsg, QuestionAnswers | null> {
  constructor(broadcast: (m: ServerMessage) => void, opts: { timeoutMs?: number } = {}) {
    super(broadcast, (requestId, answers) => broadcast({ type: 'question_resolved', requestId, answers }), null, opts.timeoutMs ?? PERMISSION_TIMEOUT_MS);
  }

  /** Answers are user text: only keys naming an asked question survive (lengths are capped by the schema); none left → unanswered. */
  override resolve(requestId: string, answers: QuestionAnswers | null): boolean {
    const w = this.waiting.get(requestId);
    if (!w || !answers) return super.resolve(requestId, answers);
    const asked = new Set(w.msg.questions.map((q) => q.question));
    const kept = Object.fromEntries(Object.entries(answers).filter(([k]) => asked.has(k)));
    return super.resolve(requestId, Object.keys(kept).length ? kept : null);
  }
}

/** Deviation (added per review I5): extraHosts feeds the Host allowlist in checkUpgrade. */
export type WsDeps = {
  token: string;
  devOrigins: string[];
  runner: TurnRunner;
  index: SessionIndex;
  usage: UsageService;
  store: SessionStateStore;
  extraHosts?: string[];
  /** UI build id (see buildId.ts); rides hello so open tabs notice a new build. A function is read per hello (live). */
  build?: string | null | (() => string | null);
  /** D11: false hides the GPT engine in the UI and makes 'auto' mean Claude. */
  codexAvailable: boolean;
  /** The configured Claude accounts: rides hello (`accounts`), and an account pin must be one of its active ids. */
  accounts: AccountNames;
  /** Read on every hello, so a login done while deck runs shows up on the next connect. Absent = no Gemini. */
  geminiStatus?: () => GeminiStatus;
  /** A `grok` binary and its version (found once at start). Absent or `bin: false` = no Grok: 'grok' is not in hello.features. */
  grokStatus?: GrokStatus | (() => GrokStatus);
  /** Settings' 잠금 해제 for a tripped Grok engine (§14.9-3); main broadcasts the new grok_status. */
  grokUnlock?: () => void;
  readCodexHistory?: typeof readCodexTranscript;
  /** History of an imported (Codex Desktop / CLI) thread: the rollout's tail only. */
  readCodexImportHistory?: typeof readCodexTranscriptTail;
  /** F1: a new session's cwd must (after realpath) lie inside one of these (default: the OS home dir). */
  cwdRoots?: string[];
  /** F2: pinned session ids ride hello and every index message. */
  pins?: PinStore;
  /** 자동 승인 etc.; rides hello, changed with set_settings. */
  settings?: SettingsStore;
  /** Web Push hook: sees every turn event and every permission/question card (PushNotifier picks what to send). */
  notify?: (msg: ServerMessage) => void;
  /**
   * The user sent to a session from a device (병목 알림 stop: BottleneckWatch.userSent). Opening one is not reported: every
   * tab opens its sessions again when it reconnects (a restart), which is not the user acting.
   */
  onUserSend?: (sessionId: string) => void;
  /** Attachment metadata (name, image or not) for the prompt every viewing device is shown. */
  attachments?: { resolve(ids: string[]): { found: { id: string; name: string; isImage: boolean }[] } };
  /** 새 세션으로 이어가기: a new session sent with `handoffFrom` is linked to that session (and titled) here once it has an id. */
  meta?: Pick<SessionMetaStore, 'link' | 'branch'> & Partial<Pick<SessionMetaStore, 'update' | 'setCwd' | 'title'>>;
  /** The send clientRefs / steer ids each session accepted (survives a restart); rides `history` as `acceptedRefs`. */
  acceptedRefs?: Pick<AcceptedRefs, 'add' | 'remove' | 'has' | 'list' | 'since'>;
  /** Process scan behind the index entries' `heldBy` (the same object the SessionIndex reads): rescanned at hello, open, send and on the outside poll. */
  holders?: Pick<ProcessHolders, 'refresh'> & Partial<Pick<ProcessHolders, 'grokHeldBy' | 'grokCwdHeld'>>;
  /** x1's GROK_HOME: deck's own Grok sessions' history is read from `sessions/*\/<id>/chat_history.jsonl` there. Absent = empty panes. */
  grokHome?: string | null;
  /** See OUTSIDE_POLL_MS; 0 = no poll. */
  outsidePollMs?: number;
  /** See CATCHUP_KEEP_EVENTS (tests shrink it). */
  catchupKeep?: number;
  /** …and at most this many bytes (default CATCHUP_KEEP_BYTES), idle for at most this long (default CATCHUP_IDLE_MS). */
  catchupKeepBytes?: number;
  catchupIdleMs?: number;
  /** Where the running turns and background tasks are written on each change (scripts/restart.sh reads it); absent = not written. */
  activityFile?: string;
  /** When this server process started (ms); rides every `activity` message. Default: when this module loaded. */
  serverStartedAt?: number;
  /** 첫 실행 마법사: `hello.setup.needed` and the 'setup' feature. Absent = neither. */
  setup?: { needed: () => boolean };
  /** 총사령탑(Commander): the `commander_*` messages, SessionFacts.commander and the idle hook. Absent = no commander. */
  commander?: WsCommander;
  /**
   * The session went idle with a booked retry (SessionState.pendingRetry): fire it now if its time has come — a retry
   * refused because the session was busy then is not left for the next restart (BottleneckWatch.retryDue).
   */
  retryDue?: (sessionId: string) => void;
  /** 백그라운드 작업 (`start_task`): the list; absent = no tasks ('tasks' not advertised). */
  tasks?: TaskRegistry;
  /** A task ended: always pushed (PushNotifier.sendAll), whatever turnNeedsAttention says. */
  pushTask?: (p: PushPayload) => void;
};

/** What ws needs of the Commander (main.ts wires the real one). */
export type WsCommander = {
  enabled(): boolean;
  set(sessionId: string, a: { goal: string; done: string; maxTurns?: number }): CommanderResult;
  stop(sessionId: string, epoch: number): CommanderResult;
  /** 설정에서 끔: every active commander is stopped. */
  disableAll(): void;
  pause(sessionId: string, epoch: number): CommanderResult;
  resume(sessionId: string, epoch: number): CommanderResult;
  view(sessionId: string): CommanderView | null;
  isActive(sessionId: string): boolean;
  /** A permission / question card of this session was answered. */
  cardAnswered(sessionId: string): void;
  /** ws released the session (busy off, nothing waiting in afterRelease, no booked retry): one call per segment. */
  onSessionIdle(sessionId: string, digest: SegmentDigest): void | Promise<void>;
  /** The session went idle with an automatic turn's retry booked for `atMs` (the segment stays open until it runs). */
  retryBooked?(sessionId: string, atMs: number): void;
};

/** A server-made send: an automatic retry (BottleneckWatch) or a commander instruction (Commander). */
export type ServerSend = { kind: 'retry'; sessionId: string; cwd: string; text: string; hop: number; commanderHop?: number } | CommanderSendRequest;
/** A commander turn's id carries its hop (`<uuid>:cmd<hop>`, its background segments `…:cmd<hop>:bg<n>`): its turn_result is marked `auto`. */
const COMMANDER_TURN_RE = /:cmd\d+(?::|$)/;

/** This process's start (ms), fixed for its life: a device that sees another value after a reconnect knows the server restarted. */
const SERVER_STARTED_AT = Date.now();

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function isDirectory(p: string): Promise<boolean> {
  return fs.stat(p).then((st) => st.isDirectory(), () => false);
}

/**
 * `turnId` is the turn the send started (its AbortController ends the whole process). `current` is
 * the deck turn now streaming — that turn, a background continuation or a follow-up — and null
 * while the process only waits for background work; `bg` is the last turn_background.
 */
type TurnMsg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
/**
 * What a device opening the session mid-turn needs besides the transcript: the latest state of each
 * task (subagent cards), the subagents' tool calls so far (bounded), and the status row's progress.
 */
type ReplayLog = { tasks: Map<string, { msg: TurnMsg<'task_update'>; at: number }>; subs: (TurnMsg<'sub_tool_call'> | TurnMsg<'sub_tool_result'>)[]; progress: TurnMsg<'turn_progress'> | null; /** Steers delivered in the running segment (the transcript may lag behind them). */ steers: TurnMsg<'steer_delivered'>[]; /** The text block streaming now, as one delta (see record). */ text: TurnMsg<'delta'> | null; /** 다른 AI 로 이어가기: the turn's session_handoff messages in order — a device that comes back to an old session follows them. */ handoffs: Extract<ServerMessage, { type: 'session_handoff' }>[] };
const MAX_REPLAY_SUBS = 500;
/**
 * Catch-up: how much of a running process's event stream is kept for devices that come back (`open_session.after`).
 * Older events fall out; a device that needs them gets the full history instead.
 */
export const CATCHUP_KEEP_EVENTS = 5000;
export const CATCHUP_KEEP_BYTES = 4 * 1024 * 1024;
/** A process that ended its turn and has sent nothing for this long (it is only kept open by background work) gives its kept events up: a device behind then gets the full history. */
export const CATCHUP_IDLE_MS = 10 * 60_000;

type Turn = RunningTurn & { /** As its turn_started said (absent until then). */ engine?: EngineKind; origin: WebSocket; watchers: Set<WebSocket>; ac: AbortController; current: string | null; /** When `current` started (ms). */ since: number; bg: { msg: TurnMsg<'turn_background'>; at: number } | null; log: ReplayLog; /** Started without a session id: the sidebar is refreshed once the CLI reports one. */ fresh: boolean; /** 새 세션으로 이어가기: the session this new one continues. */ handoffFrom: string | null; /** 메시지 편집 갈래: recorded in session meta once the new session has an id. */ branch: { parent: string; n: number } | null; /** 복제: the title the new session gets once it has an id. */ title?: string; afterRelease: { ws: WebSocket; msg: Extract<ClientMessage, { type: 'send' }>; retryHop?: number; /** Told the device it is going in (pendingRefs): run even if that socket closed. */ held?: true }[]; /** Refs of sends / steers handed to the process but not yet recorded as accepted (`history.pendingRefs`). */ pendingRefs: Set<string>; /** The foreign-write check a send to the held-open process waits on (shared by sends arriving together). */ outside: Promise<boolean> | null; /** Being ended because the conversation went on outside deck: sends wait in `afterRelease` for a new process. */ recycling: boolean; /** The last stream position this process stamped (0: none yet). */ seq: number; /** Its newest stamped events as sent, oldest first (see CATCHUP_KEEP_*). */ stream: { seq: number; data: string; bytes: number }[]; streamBytes: number; /** Drops `stream` once the process has sat idle (CATCHUP_IDLE_MS). */ streamIdle: ReturnType<typeof setTimeout> | null; /** ⚡ 빠르게: the process was started with fast mode (TurnRunner.fastTurn) — a send asking otherwise never joins it. */ fast: boolean; /** 다른 AI 로 이어가기: the sessions this turn moved away from, in order (Claude → GPT → Gemini: both; sends to any follow the turn). */ crossFrom?: string[]; /** …until the old turn `fromTurnId`'s result is out (the turn keeps the old session meanwhile). */ crossing?: { fromTurnId: string; from: string | null } };

export const DRAINING_MESSAGE = '서버가 재시작을 준비 중입니다 — 잠시 뒤 다시 보내 주세요';

export type WsHandle = {
  broadcast(msg: ServerMessage): void;
  broadcastIndex(): void;
  close(): void;
  /** Graceful restart: from now on refuse sends that need a new process (running turns, their background work and follow-ups into them go on). */
  drain(): void;
  /** Turns still running, including processes held open for background work. */
  activeTurns(): number;
  /** Ends every running turn (drain deadline). */
  abortAll(): void;
  /**
   * An automatic retry (BottleneckWatch, SessionState.pendingRetry): `text` sent to the session as a device's send would
   * be (busy, follow-up and draining rules alike — not reported as the user's send), from no device. `hop` rides the turn
   * as TurnParams.retryHop on every path (a new turn, a follow-up into a held process, a send waiting for one to close);
   * a refusal is only logged (the booking stays for the next restart's rearm). `commanderHop` (the failed turn was an
   * automatic one, 보안 #3) rides a new turn only: such a retry on a busy session is refused, since a follow-up carries no
   * commanderHop and the held process may be a person's ungated one.
   */
  submitRetry(r: { sessionId: string; cwd: string; text: string; hop: number; commanderHop?: number }): void;
  /**
   * submitRetry, generalized. `kind: 'commander'` (총사령탑 §6): only ever a new turn — refused synchronously (false) when
   * the feature is off, the server drains, the session is busy (a running turn, sends waiting in afterRelease, a booked
   * retry), the sendKey was sent already, or the session is not an existing Claude one; true = the turn started. A retry
   * with `commanderHop` runs only while the session's commander is running (else the booking is dropped).
   */
  submitServerSend(r: ServerSend): boolean;
  /** A turn runs (or is about to) or a retry is booked: the commander sends nothing now. */
  isBusy(sessionId: string): boolean;
  /** The turn is a 백그라운드 작업's first turn (its result is pushed by the task, not by PushNotifier). */
  isTaskTurn(turnId: string): boolean;
  /** The turn (or follow-up) was sent in 간결 모드: PushNotifier pushes it once it ran CONCISE_LONG_TURN_MS. */
  isConciseTurn(turnId: string): boolean;
};

/** The sender of a server-made send (submitRetry): never open, so nothing is sent to it and it views nothing. */
const NO_DEVICE = { readyState: WebSocket.CLOSED } as unknown as WebSocket;

export function attachWebSocket(servers: http.Server[], deps: WsDeps): WsHandle {
  const cwdRoots = deps.cwdRoots ?? [os.homedir()];
  // maxPayload: a text frame over 1 MiB is refused (ws emits 'error' on the socket, handled below).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  wss.on('error', (err) => console.error('deck ws: server error', err));
  const clients = new Set<WebSocket>();
  /** 백그라운드 작업 sockets → told the task's session id as soon as the engine names it (before any event carries it). */
  const taskSockets = new WeakMap<WebSocket, (sessionId: string) => void>();
  /** Turn / follow-up ids sent in 간결 모드 (newest last, bounded): only PushNotifier asks (isConciseTurn). */
  const conciseTurns = new Set<string>();
  const markConcise = (id: string, m: { concise?: boolean; handoff?: boolean }) => {
    if (!m.concise || m.handoff) return;
    conciseTurns.add(id);
    if (conciseTurns.size > 2000) conciseTurns.delete(conciseTurns.values().next().value!);
  };
  const turns = new Map<string, Turn>();
  /** Turn ids a running turn's process produced after its own (background continuations, follow-ups) → that turn's id. */
  const aliases = new Map<string, string>();
  const baseOf = (turnId: string) => aliases.get(turnId) ?? turnId;
  /**
   * The socket that sent each follow-up (by its turn id), while it is aliased, and whether its turn_started went out: a
   * refusal before that start, or a restart's refusal, goes back to it.
   */
  const followFrom = new Map<string, { ws: WebSocket; started: boolean }>();
  /** Refs of held sends being handed on again by drainWaiting (startTurn runs synchronously): told once, not per pass. */
  const rehold = new Set<string>();
  /** The user message of each deck turn started by a send (its own turn or a follow-up), until the turn's process ends. */
  const prompts = new Map<string, TurnPrompt>();
  const promptOf = (msg: { text: string; attachments?: string[] }): TurnPrompt => ({
    text: msg.text,
    attachments: msg.attachments?.length ? (deps.attachments?.resolve([...new Set(msg.attachments)]).found ?? []).map(({ id, name, isImage }) => ({ id, name, isImage })) : [],
  });
  let draining = false;
  /**
   * While draining, only a process waiting with no work left is ended at once (the 10-09 incident: such processes sat
   * out the whole drain window and took the real turns down with them at the deadline). A process held open for live
   * background tasks (subagents, Monitor; DECK_BG_MAX_MIN) is work in progress: the drain waits for it (by default until it
   * ends), and a finite deadline (DECK_DRAIN_MAX_MIN) ends it like a running turn (abortAll, SHUTDOWN_ABORT). Nor is one with a send on its way in (pendingRefs: a
   * follow-up queued behind the turn that just ended).
   */
  const endHeld = (t: Turn) => { if (draining && t.current === null && t.bg === null && t.pendingRefs.size === 0 && !t.recycling) { t.recycling = true; t.ac.abort(); } };
  /**
   * Review I2: one turn per session. Keyed by sessionId; a new session is keyed by
   * `new:<turnId>` until the CLI reports its id, then by that id as well.
   */
  const busy = new Map<string, string>();
  /** 다른 AI 로 이어가기: a session a running turn moved away from → that turn (sends to the old session follow it). */
  const crossedTo = new Map<string, Turn>();
  // A `claude -p` transcript is deck's own while a deck turn runs it or once the state store has it; other scripts' runs stay out of the sidebar.
  deps.index.setKnown?.((id) => busy.has(id) || deps.store.get(id) !== null);
  /** D6: the sessions each socket has open (one per pane); a session's turn events go to every socket viewing it. */
  const viewing = new Map<WebSocket, Set<string>>();
  const view = (ws: WebSocket, sessionId: string) => { let s = viewing.get(ws); if (!s) { s = new Set(); viewing.set(ws, s); } s.add(sessionId); };
  /** Sidebar listing: profile scan + deck-created Codex sessions (D4). */
  /** Sessions deck started whose CLI named them but whose first turn has not stored them yet (`new:` busy key still held). */
  const ownUnstored = () => [...turns.values()].flatMap((t) => (t.sessionId && busy.get(`new:${t.turnId}`) === t.turnId ? [t.sessionId] : []));
  const projects = () => deps.index.projects(deps.store.codexEntries(), { own: ownUnstored() });
  const pinList = () => deps.pins?.list() ?? [];
  const indexMsg = (): ServerMessage => ({ type: 'index', projects: projects(), pins: pinList(), desktop: deps.index.desktop() });

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    // A refused automatic retry (draining, busy, …) has no pane to show it: the booking stays (a restart re-arms it).
    else if (ws === NO_DEVICE && msg.type === 'error') console.warn(`deck: retry deferred — ${msg.message}`);
  };
  const broadcast = (msg: ServerMessage) => { for (const c of clients) send(c, msg); };
  /** Sockets whose UI asked for `sandbox` messages (open_session.accepts, protocol rule 3: an older UI never gets one). */
  const sandboxAware = new WeakSet<WebSocket>();
  /** Sockets whose UI asked for `turn_queued` (a follow-up waiting behind a streaming segment; an older UI shows 시작하는 중… meanwhile). */
  const queuedAware = new WeakSet<WebSocket>();
  const broadcastSandbox = (sessionId: string, sandbox: CodexSandbox) => { for (const c of clients) if (sandboxAware.has(c)) send(c, { type: 'sandbox', sessionId, sandbox }); };
  const notify = (msg: ServerMessage) => { try { deps.notify?.(msg); } catch (err) { console.error('deck: push hook failed', errMsg(err)); } };
  const broadcastAndNotify = (msg: ServerMessage) => { broadcast(msg); notify(msg); };
  const userSent = (sessionId: string) => { try { deps.onUserSend?.(sessionId); } catch (err) { console.error('deck: user send hook failed', errMsg(err)); } };
  /** Cards opening / closing also mark a running 백그라운드 작업 as 승인 대기 (or not). */
  const askBroadcast = (msg: ServerMessage) => { broadcastAndNotify(msg); syncTaskWaiting(); };
  const broker = new PermissionBroker(askBroadcast);
  const questions = new QuestionBroker(askBroadcast);
  /** Each socket's last route_preview ask: answered again after a usage change, unless the answer is what it last got. */
  const routeAsk = new Map<WebSocket, { sessionId: string | null; model?: ClaudeModel | 'auto' }>();
  /** The last route_preview sent to each socket (JSON): a usage change that leaves it as it is sends nothing. */
  const routeSent = new Map<WebSocket, string>();
  const sendRoutePreview = (ws: WebSocket) => {
    const ask = routeAsk.get(ws);
    if (!ask) return;
    try {
      const p = deps.runner.previewRoute(ask.sessionId, ask.model);
      if (!p) { routeSent.delete(ws); return; }
      const msg: ServerMessage = { type: 'route_preview', sessionId: ask.sessionId, account: p.account, reason: p.reason, ...(p.asOpus ? { asOpus: true } : {}) };
      const sig = JSON.stringify(msg);
      if (routeSent.get(ws) === sig) return;
      routeSent.set(ws, sig);
      send(ws, msg);
    } catch (err) {
      console.error('deck: route preview failed', errMsg(err));
    }
  };
  const unsubscribeUsage = deps.usage.onChange((usage) => {
    broadcast({ type: 'usage', usage });
    for (const ws of routeAsk.keys()) sendRoutePreview(ws);
  });
  /** Every session with a turn streaming or background work held open (sidebar dots, tab title on all devices). */
  const shownTurns = () => [...turns.values()].filter((t): t is Turn & { sessionId: string } => t.sessionId !== null && (t.current !== null || (t.bg?.msg.tasks.length ?? 0) > 0));
  const activity = (): SessionActivity[] => {
    const now = Date.now();
    return shownTurns()
      .map((t) => ({ sessionId: t.sessionId, cwd: t.cwd, turnId: t.current ?? t.turnId, running: t.current !== null, bg: t.bg?.msg.tasks.length ?? 0, forMs: t.current !== null ? Math.max(0, now - t.since) : 0, ...(t.bg?.msg.tasks.length ? { tasks: t.bg.msg.tasks.slice(0, 5).map((x) => x.slice(0, 80)) } : {}) }));
  };
  // The task names are in it too: work swapped for other work of the same count is still a change (activityFile lists them).
  let activitySig = '[[],[]]';
  const serverStartedAt = deps.serverStartedAt ?? SERVER_STARTED_AT;
  const activityMsg = (sessions = activity()): ServerMessage => ({ type: 'activity', sessions, ...(draining ? { draining: true } : {}), serverStartedAt });
  const broadcastActivity = () => {
    const sessions = activity();
    const sig = JSON.stringify([sessions.map(({ forMs: _f, ...rest }) => rest), shownTurns().map((t) => t.bg?.msg.tasks ?? [])]);
    if (sig === activitySig) return;
    activitySig = sig;
    broadcast(activityMsg(sessions));
    if (deps.activityFile && !activityTimer && !activityClosed) activityTimer = setTimeout(writeActivity, 200);
  };
  /** `activityFile` (scripts/restart.sh reads it): what is running now, written atomically a moment after it changed. */
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  let activityWrite: Promise<void> = Promise.resolve();
  let activityError: string | null = null;
  /** After close(): the file is gone and is not written again. */
  let activityClosed = false;
  const writeActivity = () => {
    activityTimer = null;
    const file = deps.activityFile;
    if (!file || activityClosed) return;
    const data = JSON.stringify({
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      draining,
      sessions: shownTurns().map((t) => ({ sessionId: t.sessionId, cwd: t.cwd, running: t.current !== null, bg: t.bg?.msg.tasks.length ?? 0, tasks: t.bg?.msg.tasks ?? [] })),
    });
    const tmp = `${file}.${process.pid}.tmp`;
    activityWrite = activityWrite.then(async () => {
      if (activityClosed) return;
      try {
        await fs.writeFile(tmp, data, { mode: 0o600 });
        if (activityClosed) { await fs.rm(tmp, { force: true }); return; }
        await fs.rename(tmp, file);
        activityError = null;
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        const m = errMsg(err);
        if (m !== activityError) { activityError = m; console.error('deck: activity 파일 쓰기 실패', m); }
      }
    });
  };
  const running = (): RunningTurn[] => [...turns.values()].filter((t) => t.current !== null).map(({ current, sessionId, cwd }) => ({ turnId: current!, sessionId, cwd }));

  /**
   * A session created moments ago (e.g. in Claude Desktop) may not be in the in-memory
   * index yet. Single-flight: concurrent misses await the same rescan instead of each
   * triggering their own.
   */
  let indexRescan: Promise<void> | null = null;
  /** A request made while a scan runs gets one (shared) scan started after it, so it sees files written before the request. */
  let queuedRescan: Promise<void> | null = null;
  const rescanIndex = (): Promise<void> => {
    if (!indexRescan) { indexRescan = deps.index.refresh().finally(() => { indexRescan = null; }); return indexRescan; }
    queuedRescan ??= indexRescan.catch(() => {}).then(() => { queuedRescan = null; return rescanIndex(); });
    return queuedRescan;
  };

  /** A Grok session deck can send in (its own, or an imported Grok CLI one — not a Grok Bot conversation). */
  const isGrokTarget = (id: string) => {
    const st = deps.store.get(id);
    if (st) return isGrokState(st);
    const e = deps.index.importOf(id);
    return e?.engine === 'grok' && e.source !== 'grokbot';
  };
  /**
   * Rescans who else holds sessions open (cached a few seconds; `force`: now — a send to a Grok session, whose runner
   * joins this scan before deciding); the index goes out again only when a holder came or went.
   */
  const syncHolders = (force = false) => {
    void deps.holders?.refresh(force ? { force } : undefined).then((changed) => { if (changed) { deps.index.regroup(); broadcast(indexMsg()); } }).catch(() => undefined);
  };
  /**
   * Per socket and Claude session it views: when its history was last sent (entries another process wrote after that are
   * not on its screen yet) and, per transcript copy, the offset the outside poll found clean up to — a tick reads only
   * what was appended since the last one. Per socket: one device opening a session must not hide from another what
   * came in between.
   */
  const historyAt = new Map<WebSocket, Map<string, { at: number; clean: Map<string, number> }>>();
  /**
   * The open panes follow the other side: a viewed, idle Claude session whose transcript (any profile's copy) gained
   * entries deck did not write since a socket's history was sent gets that history again — read once per session, sent
   * to each socket that lacks it. Sessions with a deck turn are left alone: their pane is fed by the turn's own stream.
   */
  const followOutside = async () => {
    const files = new Map<string, string[]>();
    const stale = new Map<string, WebSocket[]>();
    for (const [ws, seen] of historyAt) {
      for (const [id, rec] of [...seen]) {
        if (!viewing.get(ws)?.has(id)) { seen.delete(id); continue; }
        if (busy.has(id)) continue;
        if (!files.has(id)) files.set(id, deps.index.sessions().filter((e) => e.sessionId === id).map((e) => e.file));
        for (const file of files.get(id)!) {
          const r = await scanForeign(file, rec.at - OUTSIDE_SLACK_MS, rec.clean.get(file) ?? 0, { isOwn: (u, id) => deckWrites.has(u, id), lagMs: OWN_LAG_MS }).catch(() => null);
          if (!r) continue;
          if (r.foreign) { stale.set(id, [...(stale.get(id) ?? []), ws]); break; }
          rec.clean.set(file, r.end);
        }
      }
    }
    for (const [id, sockets] of stale) {
      const st = deps.store.get(id);
      const entry = deps.index.lookup(id);
      if (!entry || busy.has(id) || (st && (isOtherEngineState(st)))) continue;
      // What is in the files now is in the history read next: the poll goes on from these sizes, so this write is not found again.
      const clean = new Map<string, number>();
      for (const file of files.get(id) ?? []) { const s = await fs.stat(file).catch(() => null); if (s) clean.set(file, s.size); }
      const read = await readClaudeHistory(id, entry, st ?? null).catch(() => null);
      // A turn that started during the read streams into the pane already: a history now would wipe what it showed.
      if (!read || busy.has(id)) continue;
      // No view() here: a pane closed during the read stays closed.
      for (const ws of sockets) if (viewing.get(ws)?.has(id)) sendClaudeHistory(ws, id, read, clean);
    }
  };
  let following = false;
  const pollMs = deps.outsidePollMs ?? OUTSIDE_POLL_MS;
  const outsideTimer = pollMs > 0 ? setInterval(() => {
    if (!clients.size || following) return;
    syncHolders();
    // Sessions written outside deck (Desktop, a terminal) move in the list too: a stat of the known transcripts (~1 ms).
    // Sessions with a deck turn running are left out — their files grow with the turn; its end touches them and broadcasts.
    void deps.index.touch(undefined, new Set(busy.keys())).then((changed) => { if (changed) broadcast(indexMsg()); }).catch(() => undefined);
    following = true;
    void followOutside().catch((err: unknown) => console.error('deck: outside-write check failed', errMsg(err))).finally(() => { following = false; });
  }, pollMs) : null;
  outsideTimer?.unref?.();

  /**
   * A new session got its id: other devices list it in their sidebar now, not when the turn ends. The CLI may
   * write its transcript a moment after reporting the id, so rescan a few times until the index has it.
   */
  const announceSession = (sid: string, tries = 4) => {
    void rescanIndex()
      .then(() => {
        if (deps.index.lookup(sid) || deps.store.codexEntries().some((e) => e.sessionId === sid)) broadcast(indexMsg());
        else if (tries > 1) setTimeout(() => announceSession(sid, tries - 1), 750).unref?.();
      })
      .catch((err: unknown) => console.error('deck: index refresh for a new session failed', errMsg(err)));
  };

  /** 새 세션으로 이어가기: `to` continues `from` (deck's session meta, never the transcript), titled "<old title> (이어서)". */
  const linkHandoff = async (from: string, to: string) => {
    if (!deps.meta) return;
    const old = deps.index.lookup(from)?.title ?? deps.index.codexOwned(deps.store.codexEntries()).find((e) => e.sessionId === from)?.title ?? from.slice(0, 8);
    try {
      await deps.meta.link(from, to, handoffTitle(old));
      deps.index.regroup();
      broadcast(indexMsg());
    } catch (err) {
      console.error('deck: handoff link failed', errMsg(err));
    }
  };

  /** 복제: the duplicate's first turn gave it an id — it takes the "<원래 제목> (복사)" title its send carried. */
  const titleNew = async (sid: string, title: string) => {
    if (!deps.meta?.update) return;
    try {
      await deps.meta.update(sid, { title });
      deps.index.regroup();
    } catch (err) {
      console.error('deck: duplicate title failed', errMsg(err));
    }
  };

  /** 메시지 편집 갈래: `child` was forked from `parent` at user message `n` (deck's session meta, never the transcript). */
  const linkBranch = async (child: string, parent: string, n: number) => {
    if (!deps.meta) return;
    try {
      await deps.meta.branch(child, parent, n);
      deps.index.regroup();
      broadcast(indexMsg());
    } catch (err) {
      console.error('deck: branch link failed', errMsg(err));
    }
  };

  /**
   * 메시지 편집 갈래: where to fork Claude session `from` so that its user message `n` (checked against `expect`)
   * is replaced — read from the copy the session's history is shown from. Null = not a Claude session / not found.
   */
  const resolveBranch = async (from: string, n: number, expect: string | undefined): Promise<BranchPoint | null> => {
    const st = deps.store.get(from);
    if (st && (isOtherEngineState(st))) return null;
    const entry = deps.index.lookup(from);
    if (!st && (!entry || entry.account === 'gpt' || isGeminiAccount(entry.account) || isGrokAccount(entry.account))) return null;
    const best = st ? await deps.index.bestCopy(from, st.projectDir, st.account).catch(() => null) : null;
    const files = [best?.file ?? (st ? `${st.projectDir}/${from}.jsonl` : entry!.file), ...(entry ? [entry.file] : [])];
    for (const f of new Set(files)) {
      const bp = await readBranchPoint(f, n, expect).catch(() => null);
      if (bp) return bp;
    }
    return null;
  };

  /** Each session's newest stream position since this server started (a later process of the session counts on from it). */
  const heads = new Map<string, StreamPos>();
  const keepEvents = deps.catchupKeep ?? CATCHUP_KEEP_EVENTS;
  const keepBytes = deps.catchupKeepBytes ?? CATCHUP_KEEP_BYTES;
  const idleMs = deps.catchupIdleMs ?? CATCHUP_IDLE_MS;
  /** (Re)starts the idle clock of a process's kept events; a turn still running when it runs out keeps them. */
  const idleSoon = (turn: Turn) => {
    if (turn.streamIdle) clearTimeout(turn.streamIdle);
    turn.streamIdle = setTimeout(() => {
      turn.streamIdle = null;
      if (turn.current !== null && turns.has(turn.turnId)) { idleSoon(turn); return; }
      turn.stream = [];
      turn.streamBytes = 0;
    }, idleMs);
    turn.streamIdle.unref?.();
  };

  /**
   * The turn's session got (or changed) its id: busy under it, linked and announced once, and on every device's activity
   * (hello.running too) — a device reloaded mid first turn finds the session by its turn id.
   */
  const adopt = (turn: Turn, sid: string | null | undefined) => {
    if (!sid || turn.sessionId === sid) return;
    turn.sessionId = sid;
    if (!busy.has(sid)) busy.set(sid, turn.turnId);
    if (turn.fresh) {
      turn.fresh = false;
      if (turn.title) void titleNew(sid, turn.title).finally(() => announceSession(sid));
      else if (turn.handoffFrom) void linkHandoff(turn.handoffFrom, sid).finally(() => announceSession(sid));
      else if (turn.branch) { const b = turn.branch; void linkBranch(sid, b.parent, b.n).finally(() => announceSession(sid)); }
      else announceSession(sid);
    }
    broadcastActivity();
  };

  /**
   * Turn events reach the socket that started the turn and sockets viewing its session — nobody else. Once the session
   * has an id every event is numbered (`pos`) and kept for a while, so a device that was away can ask for what it missed.
   */
  const emitTurn = (turn: Turn, msg: ServerMessage) => {
    adopt(turn, 'sessionId' in msg ? msg.sessionId : null);
    // Per-turn model: the result says which model answered (the badge's), saved with the turn on every device.
    if (msg.type === 'turn_result' && msg.model === undefined && msg.badge?.model) msg = { ...msg, model: msg.badge.model };
    if (msg.type === 'turn_result' && COMMANDER_TURN_RE.test(msg.turnId)) msg = { ...msg, auto: 'commander' };
    const to = new Set<WebSocket>([turn.origin, ...turn.watchers]);
    if (turn.sessionId) for (const [c, v] of viewing) if (v.has(turn.sessionId)) to.add(c);
    let out = msg;
    let seq = 0;
    if (turn.sessionId) {
      seq = Math.max(turn.seq, heads.get(turn.sessionId)?.seq ?? 0) + 1;
      const pos: StreamPos = { sid: turn.sessionId, epoch: turn.turnId, seq };
      turn.seq = seq;
      heads.set(turn.sessionId, pos);
      // Only turn events and a turn's errors come through here: both carry `pos`.
      out = { ...msg, pos } as ServerMessage;
    }
    const data = JSON.stringify(out);
    if (seq) {
      // The newest event is always kept, whatever its size: what is kept is a whole tail or nothing.
      turn.stream.push({ seq, data, bytes: Buffer.byteLength(data) });
      turn.streamBytes += turn.stream[turn.stream.length - 1]!.bytes;
      while (turn.stream.length > keepEvents || (turn.streamBytes > keepBytes && turn.stream.length > 1)) turn.streamBytes -= turn.stream.shift()!.bytes;
      idleSoon(turn);
    }
    for (const c of to) if (c.readyState === WebSocket.OPEN) c.send(data);
    notify(msg);
  };

  for (const server of servers) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const chk = checkUpgrade({ headers: { cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host } }, deps.token, deps.devOrigins, deps.extraHosts ?? []);
      if (!chk.ok) {
        const status = chk.reason === 'unauthenticated' ? '401 Unauthorized' : chk.reason.startsWith('host ') ? '421 Misdirected Request' : '403 Forbidden';
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }

  /** Keeps what `replay` re-sends to a device that opens the session mid-turn. */
  const record = (turn: Turn, m: ServerMessage) => {
    const log = turn.log;
    if (m.type === 'task_update') {
      const prev = log.tasks.get(m.taskId);
      // A patch (task_updated) carries no Agent call id; keep the one task_started gave.
      log.tasks.set(m.taskId, { msg: prev ? { ...prev.msg, ...m, toolUseId: m.toolUseId ?? prev.msg.toolUseId } : m, at: prev?.at ?? Date.now() });
    } else if (m.type === 'task_done' && m.taskId) {
      const prev = log.tasks.get(m.taskId);
      if (prev) prev.msg = { ...prev.msg, status: m.status, ...(m.usage ? { usage: m.usage } : {}) };
    } else if (m.type === 'sub_tool_call' || m.type === 'sub_tool_result') {
      log.subs.push(m);
      if (log.subs.length > MAX_REPLAY_SUBS) log.subs.splice(0, log.subs.length - MAX_REPLAY_SUBS);
    } else if (m.type === 'delta') {
      log.text = log.text ? { ...log.text, ...m, text: log.text.text + m.text } : m;
    } else if (m.type === 'turn_progress') {
      // A phase change is a new content block starting: the text block before it is finished, and finished blocks are
      // what the CLI has written to the transcript (block by block), which `history` carries.
      if (m.phase !== log.progress?.phase) log.text = null;
      log.progress = m;
    } else if (m.type === 'steer_delivered') {
      // The steer is in the process's input now: accepted (not when runner.steer resolved — the process may end first).
      const sid = m.sessionId ?? turn.sessionId;
      if (sid) deps.acceptedRefs?.add(sid, m.steerId);
      turn.pendingRefs.delete(m.steerId);
      log.steers.push(m);
      if (log.steers.length > MAX_REPLAY_SUBS) log.steers.shift();
    } else if (m.type === 'steer_rejected') {
      turn.pendingRefs.delete(m.steerId);
    } else if (m.type === 'turn_result') {
      // The segment's transcript is complete now.
      log.steers = [];
      log.text = null;
    }
    // These follow the end of a text block too (a fallback for a producer without progress events).
    if (m.type === 'thinking' || m.type === 'tool_call' || m.type === 'tool_result' || m.type === 'steer_delivered') log.text = null;
  };
  /** After `history`: the running turn's tasks, subagent calls, progress and background work, as of now. */
  const replay = (ws: WebSocket, t: Turn, sessionId: string) => {
    const now = Date.now();
    for (const { msg, at } of t.log.tasks.values()) send(ws, { ...msg, sessionId, ageMs: Math.max(0, now - at) });
    for (const m of t.log.subs) send(ws, { ...m, sessionId });
    for (const m of t.log.steers) send(ws, { ...m, sessionId, replay: true });
    if (t.current && t.log.progress) send(ws, { ...t.log.progress, sessionId });
    if (t.bg) {
      const elapsed = now - t.bg.at;
      const { msg } = t.bg;
      send(ws, { ...msg, sessionId, cwd: t.cwd, ...(msg.detail ? { detail: msg.detail.map((d) => ({ ...d, ageMs: d.ageMs + elapsed })) } : {}) });
    }
  };

  /**
   * The session took this ref already (recorded: the device drops its copy) or is taking it (handed to its running process,
   * which may still fail to deliver it: the device keeps its copy, paused). Undefined: neither.
   */
  const refusal = (sessionId: string, ref: string): { message: string; code: RefusalCode } | undefined =>
    deps.acceptedRefs?.has(sessionId, ref) ? { message: '이미 들어간 메시지라 다시 보내지 않았습니다', code: 'already_accepted' }
      : turns.get(busy.get(sessionId) ?? '')?.pendingRefs.has(ref) ? { message: '아직 처리 중인 메시지 — 멈춰 둠', code: 'in_flight' }
        : undefined;

  /** `checked`: this send already waited for the foreign-write check of its session's held-open process. */
  const accounts = deps.accounts;
  /** Why this account cannot be pinned (the schema only checks an id's shape), or null. */
  const pinRefusal = (id: string): string | null => {
    const usable = accounts.list().map((a) => `${accounts.label(a)}(${a})`).join(', ');
    return !accounts.has(id) ? `설정에 없는 계정이라 고정할 수 없습니다: ${id} (쓸 수 있는 계정: ${usable})`
      : accounts.isRetired(id) ? `설정에서 뺀(retired) 계정이라 고정할 수 없습니다: ${accounts.label(id)}(${id}) (쓸 수 있는 계정: ${usable})`
        : null;
  };

  const startTurn = (ws: WebSocket, sent: Extract<ClientMessage, { type: 'send' }>, checked = false, retryHop?: number, commanderHop?: number, commanderNote?: string) => {
    // The handoff note's prompt is fixed server-side (the turn runs with tools denied, so it must not carry arbitrary text).
    // 다른 AI 로 이어가기: a send to a session a running turn moved away from goes to the new session — queued on that
    // turn until the new session has an id and is between turns (the new engine running: it waits, never refused as busy).
    const moved = sent.sessionId && !sent.handoff && commanderHop === undefined ? crossedTo.get(sent.sessionId) : undefined;
    if (moved && turns.get(moved.turnId) !== moved) crossedTo.delete(sent.sessionId!);
    else if (moved) {
      if (moved.sessionId && moved.sessionId !== sent.sessionId && !moved.crossing && moved.current === null) { startTurn(ws, { ...sent, sessionId: moved.sessionId }, checked, retryHop); return; }
      moved.afterRelease.push({ ws, msg: sent, ...(retryHop ? { retryHop } : {}) });
      return;
    }
    const msg = sent.handoff ? { ...sent, text: HANDOFF_PROMPT, attachments: undefined } : sent;
    // A socket that closed while its send waited (foreign-write check, recycle) still gets its message run; it just views nothing.
    if (msg.sessionId && clients.has(ws)) view(ws, msg.sessionId);
    if (!checked) syncHolders(!!msg.sessionId && isGrokTarget(msg.sessionId));
    // The client's correlation id rides this send's turn_started and every error refusing the send (which pane sent it).
    const ref = msg.clientRef ? { clientRef: msg.clientRef } : {};
    const hop = retryHop ? { retryHop } : {};
    // Only a pin the user picked for a new session is refused. An edit branch or a handoff carries its parent's stored pin,
    // which the runner treats as no pin when the account is not active any more. A handoff is one only when `handoffFrom`
    // (a session id) names a session deck knows — any other string does not lift the check.
    const hf = msg.handoffFrom;
    const fromKnown = isPinnableId(hf) && (!!deps.store.get(hf) || !!deps.index.lookup(hf));
    const badPin = msg.sessionId === null && msg.accountPin && !msg.branch && !fromKnown ? pinRefusal(msg.accountPin) : null;
    if (badPin) { send(ws, { type: 'error', turnId: null, message: badPin, ...ref }); return; }
    // Idempotency: a send this session already took (or is taking) under this ref — a resent queue copy, a duplicated tab — runs once.
    const dup = msg.sessionId && msg.clientRef ? refusal(msg.sessionId, msg.clientRef) : undefined;
    if (dup) { send(ws, { type: 'error', turnId: null, ...dup, ...ref }); return; }
    if (msg.handoff && msg.sessionId) {
      const st = deps.store.get(msg.sessionId);
      if (msg.engine === 'codex' || msg.engine === 'gemini' || msg.engine === 'grok' || (st && isOtherEngineState(st)) || (!st && !deps.index.lookup(msg.sessionId) && deps.index.importOf(msg.sessionId))) {
        send(ws, { type: 'error', turnId: null, message: '이어서 새 세션은 Claude 대화에서만 돼요', ...ref });
        return;
      }
    }
    // A Claude process that already answered and holds no background work may only be waiting for its prompt suggestion:
    // it is ended and the handoff runs once the session is released.
    const idle = msg.handoff && msg.sessionId && busy.has(msg.sessionId) ? turns.get(busy.get(msg.sessionId)!) : undefined;
    if (idle && idle.engine === 'claude' && idle.current === null && !idle.bg && !idle.recycling && idle.afterRelease.length === 0 && !deps.runner.resendingFor(msg.sessionId!)) {
      idle.recycling = true;
      idle.afterRelease.push({ ws, msg, ...hop });
      idle.ac.abort();
      return;
    }
    if (msg.handoff && (!msg.sessionId || busy.has(msg.sessionId))) {
      send(ws, { type: 'error', turnId: null, message: msg.sessionId ? '세션이 실행 중이라 지금은 넘길 수 없습니다 — 끝난 뒤 다시 시도하세요' : '새 세션은 넘길 대화가 없습니다', ...ref });
      return;
    }
    if (msg.sessionId && busy.has(msg.sessionId)) {
      // 보안 #3: an automatic turn's retry never joins a running process (FollowUpParams has no commanderHop).
      if (commanderHop) { send(ws, { type: 'error', turnId: null, message: '이 세션은 이미 실행 중입니다', ...ref }); return; }
      // The session's process may only be waiting for background work: then the message joins it (TurnRunner.followUp).
      const base = turns.get(busy.get(msg.sessionId)!);
      const sid = msg.sessionId;
      // ⚡ A send waiting for a ↯ switch's background work (recycling, not aborted): held as going in — the device shows
      // what it waits behind, and a stalled-socket reconnect never sends it again (pendingRefs).
      const holdBehindBg = (b: Turn, behind = FAST_WAIT_BEHIND) => {
        if (!msg.clientRef) return;
        b.pendingRefs.add(msg.clientRef);
        // Back here from drainWaiting (still waiting): the device was told already.
        if (queuedAware.has(ws) && !rehold.has(msg.clientRef)) send(ws, { type: 'turn_queued', turnId: b.turnId, sessionId: sid, cwd: b.cwd, clientRef: msg.clientRef, behind });
      };
      if (base?.recycling) {
        if (!base.ac.signal.aborted) holdBehindBg(base);
        base.afterRelease.push({ ws, msg, ...hop });
        return;
      }
      // ⚡ 빠르게 switched since this process started (fast is a launch setting): the send never joins it — billed as the
      // person chose. Mid-turn it waits for the result; between turns the held process is ended and a new one answers —
      // but background work it still runs is left to finish first (the process then ends by itself, release starts the send).
      if (base && (base.engine === undefined || base.engine === 'claude') && base.fast !== fastSend(msg)) {
        // Follow-ups of an ended process still being sent on (TurnRunner.resending) count as a turn running: never cut.
        // The send is held as going in meanwhile, like one behind background work: a stalled-socket reconnect never
        // queues the same message twice (pendingRefs), and the pane shows what it waits behind.
        if (deps.runner.resendingFor(sid)) { holdBehindBg(base, RESEND_NOTICE); base.afterRelease.push({ ws, msg, ...hop, ...(msg.clientRef ? { held: true as const } : {}) }); return; }
        if (base.current !== null) { base.afterRelease.push({ ws, msg, ...hop }); return; }
        if (draining) { send(ws, { type: 'error', turnId: null, message: DRAINING_MESSAGE, code: 'draining', ...ref }); return; }
        base.recycling = true;
        base.afterRelease.push({ ws, msg, ...hop });
        const running = base.bg?.msg.tasks.length ?? 0;
        if (running === 0) { base.ac.abort(); return; }
        holdBehindBg(base);
        const notice: ServerMessage = { type: 'turn_notice', turnId: '', sessionId: sid, cwd: base.cwd, message: fastWaitNotice(running) };
        for (const [c, v] of viewing) if (v.has(sid)) send(c, notice);
        return;
      }
      // deck follows the other side: a process held open for background work read the transcript when it started. If
      // Desktop / a CLI went on with the session since, a message written into it would be answered from before that —
      // the conversation forks. So that process is ended and the send starts a new one, which resumes from the newest
      // entry. Only between turns (`current` null): a streaming turn is never cut, the send then queues behind it as before.
      if (base && !checked && base.current === null) {
        const check = (base.outside ??= deps.runner.foreignWrites(sid).catch(() => false));
        void check.then((foreign) => {
          if (base.outside === check) base.outside = null;
          // No socket check: the message was sent, and neither a follow-up nor a new turn needs its sender connected.
          const live = !base.recycling && base.current === null && turns.get(busy.get(sid) ?? '') === base;
          // While draining a new process is not started: the held one is left alone (its background work goes on) and
          // the send is refused like any that needs a new process — the device sends it again after the restart.
          if (foreign && live && draining) { send(ws, { type: 'error', turnId: null, message: DRAINING_MESSAGE, code: 'draining', ...ref }); return; }
          if (foreign && live) {
            base.recycling = true;
            const stopped = base.bg?.msg.tasks.length ?? 0;
            if (stopped > 0) {
              const notice: ServerMessage = { type: 'turn_notice', turnId: '', sessionId: sid, cwd: base.cwd, message: recycleNotice(stopped) };
              for (const [c, v] of viewing) if (v.has(sid)) send(c, notice);
            }
            base.ac.abort();
          }
          startTurn(ws, sent, true, retryHop);
        });
        return;
      }
      const followId = randomUUID();
      markConcise(followId, msg);
      if (base) { aliases.set(followId, base.turnId); followFrom.set(followId, { ws, started: false }); }
      prompts.set(followId, promptOf(msg));
      const joined = base !== undefined && deps.runner.followUp(msg.sessionId, {
        turnId: followId, text: msg.text,
        ...(msg.attachments ? { attachments: msg.attachments } : {}),
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.clientRef ? { clientRef: msg.clientRef } : {}),
        ...(msg.lang ? { lang: msg.lang } : {}),
        // How it asked to be answered, for when it is sent on as a turn of its own (as the run below would take it).
        ...(msg.effort ? { effort: msg.effort } : {}),
        concise: !!msg.concise && !msg.handoff,
        fast: fastSend(msg) && !taskSockets.has(ws),
        ...hop,
      });
      // Accepted once its turn_started comes (the sink's alias branch): that is when the process takes it in.
      if (joined) {
        if (msg.clientRef) base.pendingRefs.add(msg.clientRef);
        // Waiting in deck behind a streaming segment: the sending pane shows that instead of 시작하는 중… (and does not
        // suspect its socket). Not through emitTurn: no stream position, nothing to replay — the turn_started settles it.
        if (joined.queuedBehind && msg.clientRef && queuedAware.has(ws)) send(ws, { type: 'turn_queued', turnId: followId, sessionId: sid, cwd: base.cwd, clientRef: msg.clientRef, behind: joined.queuedBehind });
        return;
      }
      aliases.delete(followId);
      followFrom.delete(followId);
      prompts.delete(followId);
      // The turn already sent its result and the process is only closing (no background work to join):
      // the UI's queue fires on that result, so run the send as soon as the lock is released instead of refusing it.
      if (base && base.current === null) {
        base.afterRelease.push({ ws, msg, ...hop });
        // It may only be waiting for its prompt suggestion (ClaudeEngine SUGGEST_WAIT_MS): ended now, so the send does not wait.
        if (base.engine === 'claude' && !base.bg && !base.recycling) { base.recycling = true; base.ac.abort(); }
        return;
      }
      send(ws, { type: 'error', turnId: null, message: '이 세션은 이미 실행 중입니다', ...ref });
      return;
    }
    // Draining refuses only a send that needs a new process: one joining a live process (follow-up above) still goes in.
    if (draining) { send(ws, { type: 'error', turnId: null, message: DRAINING_MESSAGE, code: 'draining', ...ref }); return; }
    const turnId = commanderHop ? `${randomUUID()}:cmd${commanderHop}` : randomUUID();
    markConcise(turnId, msg);
    const ac = new AbortController();
    const turn: Turn = { turnId, sessionId: msg.sessionId, cwd: msg.cwd, origin: ws, watchers: new Set(), ac, current: turnId, since: Date.now(), bg: null, log: { tasks: new Map(), subs: [], progress: null, steers: [], text: null, handoffs: [] }, fresh: msg.sessionId === null, handoffFrom: msg.sessionId === null && isPinnableId(msg.handoffFrom) ? msg.handoffFrom : null, branch: null, ...(msg.sessionId === null && msg.title ? { title: msg.title } : {}), afterRelease: [], pendingRefs: new Set(msg.clientRef ? [msg.clientRef] : []), outside: null, recycling: false, seq: 0, stream: [], streamBytes: 0, streamIdle: null, fast: fastSend(msg) && !retryHop && commanderHop === undefined };
    prompts.set(turnId, promptOf(msg));
    // Taken synchronously, before any await, so two sends in one tick cannot both pass.
    busy.set(msg.sessionId ?? `new:${turnId}`, turnId);
    turns.set(turnId, turn);
    const release = () => {
      turns.delete(turnId);
      if (turn.streamIdle) clearTimeout(turn.streamIdle);
      prompts.delete(turnId);
      for (const [k, v] of [...busy]) if (v === turnId) busy.delete(k);
      broker.cancelTurn(turnId);
      questions.cancelTurn(turnId);
      for (const [a, b] of [...aliases]) if (b === turnId) { aliases.delete(a); followFrom.delete(a); prompts.delete(a); broker.cancelTurn(a); questions.cancelTurn(a); }
      broadcastActivity();
      // 다른 AI 로 이어가기: sends to the old session that waited for this turn go to the new one (when it got an id).
      if (turn.crossFrom) {
        const left = turn.crossFrom;
        for (const f of left) if (crossedTo.get(f) === turn) crossedTo.delete(f);
        const to = turn.sessionId;
        if (to) for (const d of turn.afterRelease) if (d.msg.sessionId && left.includes(d.msg.sessionId)) d.msg = { ...d.msg, sessionId: to };
      }
      // Sends that arrived while the process was closing after its result (a closed socket's send is dropped — but not one
      // that waited because deck itself ended the process). Each goes where a send would go now: the first starts the
      // session's next turn; the others wait on that turn until its process can take a follow-up or is gone.
      for (const d of turn.afterRelease.splice(0)) {
        if (!turn.recycling && !d.held && d.ws !== NO_DEVICE && !clients.has(d.ws)) continue;
        const next = d.msg.sessionId ? turns.get(busy.get(d.msg.sessionId) ?? '') : undefined;
        if (next) {
          next.afterRelease.push(d);
          // Still held as going in, now by the turn it waits on: a reconnect's copy is not queued twice.
          if (d.held && d.msg.clientRef) next.pendingRefs.add(d.msg.clientRef);
        } else startTurn(d.ws, d.msg, false, d.retryHop);
      }
      const sid = turn.sessionId;
      if (sid && !busy.has(sid)) sessionIdle(sid);
    };
    /** Sends carried over from the turn before (see release): given to the process once it is between turns — after the runner registered it as held open, hence the microtask. */
    const drainWaiting = () => queueMicrotask(() => {
      if (turns.get(turnId) !== turn || turn.current !== null || turn.recycling) return;
      for (const d of turn.afterRelease.splice(0)) {
        // Held as going in (pendingRefs) by this very turn: let go first, or the send would be refused as its own duplicate.
        const ref = d.held ? d.msg.clientRef : undefined;
        if (ref) { turn.pendingRefs.delete(ref); rehold.add(ref); }
        startTurn(d.ws, d.msg, false, d.retryHop);
        if (ref) rehold.delete(ref);
      }
    });
    let started = false;
    /** The turn already told about the macOS folder denial (one notice per turn). */
    let tccNoticed: string | null = null;
    /** This send's clientRef, until it is recorded as accepted under its session id (a new session's comes with its result). */
    let unrecorded = msg.clientRef ?? null;
    const accepted = (sessionId: string | null) => {
      if (!unrecorded || !sessionId) return;
      deps.acceptedRefs?.add(sessionId, unrecorded);
      turn.pendingRefs.delete(unrecorded);
      unrecorded = null;
    };
    const sink: TurnSink = {
      // Follow-ups a held process ended before taking are not sent on as new turns while draining (they go back to the device).
      draining: () => draining,
      // The CLI named the session: known now, not only with the first event that carries the id. The send's ref is
      // recorded under it at once (a device reloaded mid first turn drops its maybe-sent copy instead of sending it again).
      sessionKnown: (sid) => { adopt(turn, sid); if (started) accepted(sid); taskSockets.get(ws)?.(sid); if (msg.lang && deps.store.get(sid)?.lang !== msg.lang) void deps.store.setLang(sid, msg.lang).catch((err: unknown) => console.error('deck: session language write failed', errMsg(err))); },
      emit: (m) => {
        if (m.type === 'turn_started') {
          if (turn.current !== m.turnId) turn.since = Date.now();
          turn.current = m.turnId;
          if (m.engine) turn.engine = m.engine;
          turn.log.progress = null;
          turn.log.text = null;
          // Every device viewing the session gets the prompt with each start (retries included); the sending pane skips it.
          const prompt = prompts.get(m.turnId);
          const withPrompt = prompt ? { ...m, prompt } : m;
          if (m.turnId !== turnId) {
            // A follow-up's start: the process took its message in now.
            const sid = m.sessionId ?? turn.sessionId;
            if (m.clientRef && sid) { deps.acceptedRefs?.add(sid, m.clientRef); turn.pendingRefs.delete(m.clientRef); }
            const from = followFrom.get(m.turnId);
            if (from) from.started = true;
            aliases.set(m.turnId, turnId); emitTurn(turn, withPrompt); broadcastActivity(); return;
          }
          started = true;
          accepted(m.sessionId ?? turn.sessionId);
          emitTurn(turn, { ...withPrompt, ...ref });
          broadcastActivity();
          return;
        }
        record(turn, m);
        if (m.type === 'tool_call' || m.type === 'tool_result' || m.type === 'sub_tool_call' || m.type === 'sub_tool_result' || m.type === 'turn_result' || m.type === 'turn_retry') {
          const sid = m.sessionId ?? turn.sessionId;
          if (sid) segments.get(sid)?.add(m);
        }
        // A send the process did not take after all (a follow-up's write failed, or it was still queued when the process
        // ended): no longer going in, and taken back if its turn_started recorded it.
        if (m.type === 'error' && m.clientRef) {
          turn.pendingRefs.delete(m.clientRef);
          // That send no longer keeps a drained process up (endHeld).
          queueMicrotask(() => { if (turns.get(turnId) === turn) endHeld(turn); });
          const sid = m.sessionId ?? turn.sessionId;
          if (sid) deps.acceptedRefs?.remove(sid, m.clientRef);
          // A follow-up whose turn_started went out: its failed turn_result already shows the error in the chat, so this
          // one only takes the ref back (a second, app-wide banner with the same text would just repeat it). Except a
          // restart's refusal (code draining): the sending device holds that message and sends it again after the restart
          // (its turn may have left the device's queue already), so it goes back to that device. One refused before it
          // started (it waited in line: attachment gone, stopped from another device, …) goes back to it whatever the
          // code: the sending pane still waits on that ref and takes the message back into its queue.
          if (m.turnId !== null && aliases.has(m.turnId)) {
            const from = followFrom.get(m.turnId);
            if (from && (m.code === 'draining' || !from.started) && clients.has(from.ws)) send(from.ws, m);
            return;
          }
        }
        // A new session's ref, once it has an id (normally sessionKnown recorded it already).
        if (m.type === 'turn_result' && started) accepted(m.sessionId);
        if (m.type === 'turn_result' && m.turnId === turn.current) { turn.current = null; turn.log.progress = null; if (turn.afterRelease.length) drainWaiting(); queueMicrotask(() => { if (turns.get(turnId) === turn) endHeld(turn); }); }
        if (m.type === 'turn_background') turn.bg = m.tasks.length ? { msg: m, at: Date.now() } : null;
        if (m.type === 'turn_result' || m.type === 'turn_background') queueMicrotask(broadcastActivity);
        // route_fit (the turn was not sent: the engine cannot do it) answers the send like a refusal: the pane gets its ref back.
        if ((m.type === 'error' || m.type === 'route_fit') && !started && (m.turnId === null || m.turnId === turnId)) emitTurn(turn, { ...m, ...ref });
        else emitTurn(turn, m);
        // A failed tool call showing macOS denied this process the folder (TCC): the turn says why, once — the rest of
        // its failures are the same denial.
        if (m.type === 'tool_result' && tccNoticed !== m.turnId && isTccDenial(m.content, m.isError)) {
          tccNoticed = m.turnId;
          emitTurn(turn, { type: 'turn_notice', turnId: m.turnId, sessionId: m.sessionId, cwd: m.cwd, message: TCC_DENIAL_NOTICE });
        }
        // 다른 AI 로 이어가기: the old turn's result is out — from here the turn is the new session's (no id yet).
        if (m.type === 'turn_result' && turn.crossing?.fromTurnId === m.turnId) {
          const from = turn.crossing.from;
          turn.crossing = undefined;
          if (from && busy.get(from) === turnId) busy.delete(from);
          busy.set(`new:${turnId}`, turnId);
          turn.sessionId = null;
          turn.fresh = true;
          turn.title = undefined;
          turn.branch = null;
          turn.handoffFrom = from;
          if (from) sessionIdle(from);
          broadcastActivity();
        }
      },
      crossEngine: async (c) => {
        if (turns.get(turnId) !== turn || ac.signal.aborted) return null;
        const excerpt = await crossExcerpt(c.from, c.fromEngine, c.text);
        if (turns.get(turnId) !== turn || ac.signal.aborted) return null;
        const prompt = promptOf({ text: c.text, ...(c.attachments ? { attachments: c.attachments } : {}) });
        // The notice says what the new session got of the old conversation.
        const notice = `${c.notice} · ${excerpt.trim() ? sm().turn.crossCarried : sm().turn.crossNotCarried}`;
        prompts.set(c.turnId, prompt);
        aliases.set(c.turnId, turnId);
        // The old turn's result no longer ends this turn (current), nor starts the sends waiting for it.
        turn.current = c.turnId;
        turn.since = Date.now();
        turn.crossing = { fromTurnId: c.fromTurnId, from: c.from };
        turn.crossFrom = [...(turn.crossFrom ?? []), ...(c.from ? [c.from] : [])];
        if (c.from) crossedTo.set(c.from, turn);
        // Every device showing the old session moves with it (and gets the new turn's events).
        const out: ServerMessage = { type: 'session_handoff', from: c.from, fromTurnId: c.fromTurnId, cwd: c.cwd, engine: c.engine, model: c.model, turnId: c.turnId, prompt, notice };
        const to = new Set<WebSocket>([turn.origin, ...turn.watchers]);
        if (c.from) for (const [s, v] of viewing) if (v.has(c.from)) to.add(s);
        for (const s of to) { if (s !== turn.origin && s !== NO_DEVICE) turn.watchers.add(s); send(s, out); }
        if (out.type === 'session_handoff') turn.log.handoffs.push(out);
        return { excerpt, notice };
      },
      askPermission: (req) => {
        const sessionLabel = sessionAllowLabel(req);
        return broker.ask(
          {
            type: 'permission_request', turnId: req.turnId, sessionId: req.sessionId, cwd: req.cwd, requestId: randomUUID(), toolName: req.toolName, input: req.input,
            title: req.title ?? null, decisionReason: req.decisionReason ?? null, blockedPath: req.blockedPath ?? null,
            defaultToNo: req.defaultToNo === true, allowSession: sessionLabel !== null, sessionLabel,
          },
          req.signal ? AbortSignal.any([req.signal, ac.signal]) : ac.signal,
        );
      },
      askQuestion: (req) => questions.ask(
        { type: 'question_request', turnId: req.turnId, sessionId: req.sessionId, cwd: req.cwd, requestId: randomUUID(), questions: req.questions },
        req.signal ? AbortSignal.any([req.signal, ac.signal]) : ac.signal,
      ),
      signal: ac.signal,
    };
    void (async () => {
      try {
        // Review M8: the working directory must exist before a CLI is started in it (an existing session: same words as importBlockReason).
        if (!(await isDirectory(msg.cwd))) { send(ws, { type: 'error', turnId: null, message: msg.sessionId ? `${CWD_MISSING_NOTICE}: ${msg.cwd}` : `작업 폴더가 없습니다: ${msg.cwd}`, ...ref }); return; }
        // F1: a new session may only start inside the home dir (realpath, so a symlink cannot escape it).
        // The checked real path is the one used (review fix 3): a symlink swapped after the check cannot redirect the run.
        let runCwd = msg.cwd;
        if (msg.sessionId === null) {
          try {
            runCwd = await resolveUnderRoots(msg.cwd, cwdRoots[0] ?? os.homedir(), cwdRoots);
            turn.cwd = runCwd;
          } catch (err) {
            if (!(err instanceof DirError)) throw err;
            send(ws, { type: 'error', turnId: null, message: `${err.message}: ${msg.cwd}`, ...ref });
            return;
          }
        }
        // 메시지 편집 갈래: fork at the entry the edited message followed; editing the first message starts afresh.
        let fork: { from: string; at: string } | null = null;
        let model = msg.model;
        if (msg.branch && msg.sessionId === null) {
          const b = msg.branch;
          const bp = isPinnableId(b.from) ? await resolveBranch(b.from, b.n, b.expect) : null;
          if (!bp || (bp.n > 0 && !bp.at)) { send(ws, { type: 'error', turnId: null, message: '편집할 메시지를 기록에서 찾지 못해 새 갈래를 만들지 못했습니다 — 원래 세션으로 돌아갑니다', ...ref }); return; }
          turn.branch = { parent: b.from, n: bp.n };
          if (bp.at) fork = { from: b.from, at: bp.at };
          else if (!model || model === 'auto') {
            // The first message: a fresh session, on the original's model (a fork inherits it in the runner).
            const st = deps.store.get(b.from);
            if (st && !isOtherEngineState(st)) model = st.defaultModel;
          }
        }
        // The session's language sticks: it changes only when a device sends another (the prompt cache holds otherwise).
        const sticky = msg.sessionId ? deps.store.get(msg.sessionId)?.lang : msg.branch ? deps.store.get(msg.branch.from)?.lang : undefined;
        const lang = turnLanguage({ device: msg.lang, session: sticky, server: deps.settings?.get().language });
        if (msg.lang && msg.sessionId && msg.lang !== sticky) await deps.store.setLang(msg.sessionId, msg.lang).catch((err: unknown) => console.error('deck: session language write failed', errMsg(err)));
        await deps.runner.run({
          turnId, cwd: runCwd, sessionId: msg.sessionId, text: msg.text,
          ...(fork ? { fork } : {}),
          ...(model ? { model } : {}),
          ...(msg.effort ? { effort: msg.effort } : {}),
          ...(msg.engine ? { engine: msg.engine } : {}),
          ...(msg.sandbox ? { sandbox: msg.sandbox } : {}),
          ...(msg.attachments ? { attachments: msg.attachments } : {}),
          ...(msg.sessionId === null && msg.accountPin ? { accountPin: msg.accountPin } : {}),
          ...(msg.sessionId === null && msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
          ...(msg.handoff ? { handoff: true } : {}),
          ...(msg.ignoreFit ? { ignoreFit: true } : {}),
          ...(msg.concise && !msg.handoff ? { concise: true } : {}),
          ...(lang ? { lang } : {}),
          ...(fastSend(msg) && !taskSockets.has(ws) ? { fast: true } : {}),
          ...(taskSockets.has(ws) ? { bgTask: true } : {}),
          ...hop,
          ...(commanderHop ? { commanderHop } : {}),
          ...(commanderHop && commanderNote ? { commanderNote } : {}),
        }, sink);
      } catch (err) {
        // Review I6: a rejected run still ends the turn for the UI.
        console.error('deck: turn failed', err);
        // Failed before its turn_started: the sending pane is still waiting and only its clientRef can release it.
        // A run cut by an interrupt (any device's) or the shutdown says so in deck's words, as a turn the runner ended itself does.
        const text = ac.signal.aborted ? abortedText(ac.signal) : displayError(errMsg(err), null);
        if (!started && msg.clientRef) send(ws, { type: 'error', turnId: null, message: text ?? '실행 실패', ...ref });
        emitTurn(turn, { type: 'turn_result', turnId, sessionId: turn.sessionId, cwd: turn.cwd, ok: false, text: '', badge: null, errorText: text });
      } finally {
        release();
      }
      // A turn that moved to another AI made a new session too.
      if (msg.sessionId === null || turn.crossFrom !== undefined) {
        await deps.index.refresh();
        broadcast(indexMsg());
      } else {
        // An existing session: its row's time (and place in 최근) follows the turn — a stat of its transcript copies, not a
        // rescan. Codex / Gemini rows are dated by the state store, which the turn has just written.
        const st = deps.store.get(msg.sessionId);
        if ((await deps.index.touch([msg.sessionId])) || (st && (isOtherEngineState(st)))) broadcast(indexMsg());
      }
    })().catch((err: unknown) => console.error('deck: post-turn index refresh failed', errMsg(err)));
  };

  /**
   * 총사령탑: each session's segment (from a commander send until the session goes idle, retries and background
   * segments included) is collected for the judge; the sendKeys already started (one turn per sendKey, §6).
   */
  const segments = new Map<string, SegmentCollector>();
  const sentKeys = new Map<string, string>();
  const isBusy = (sid: string) => busy.has(sid) || !!deps.store.get(sid)?.pendingRetry;
  const cardAnswered = (sid: string) => { try { deps.commander?.cardAnswered(sid); } catch (err) { console.error('deck: commander card hook failed', errMsg(err)); } };
  /**
   * The session's last process is gone and nothing waits for it. A booked retry keeps the segment open (the retry is the
   * same segment's next sub-turn): it is fired now if due. Otherwise the segment ends here and the commander gets it.
   */
  const sessionIdle = (sid: string) => {
    if (deps.store.get(sid)?.pendingRetry) {
      try { deps.retryDue?.(sid); } catch (err) { console.error('deck: retry at idle failed', errMsg(err)); }
      // Still booked (not due yet): an automatic turn's retry may be hours away — the commander says so once.
      const left = deps.store.get(sid)?.pendingRetry;
      if (left?.commanderHop && !busy.has(sid)) {
        try { deps.commander?.retryBooked?.(sid, left.atMs); } catch (err) { console.error('deck: commander retry hook failed', errMsg(err)); }
      }
      return;
    }
    const seg = segments.get(sid);
    segments.delete(sid);
    if (!deps.commander) return;
    const st = deps.store.get(sid);
    const digest = (seg ?? new SegmentCollector(st?.cwd ?? '')).digest(randomUUID());
    try {
      void Promise.resolve(deps.commander.onSessionIdle(sid, digest)).catch((err: unknown) => console.error('deck: commander idle hook failed', errMsg(err)));
    } catch (err) {
      console.error('deck: commander idle hook failed', errMsg(err));
    }
  };
  const submitServerSend = (r: ServerSend): boolean => {
    const { sessionId, cwd, text } = r;
    if (r.kind === 'commander') {
      const st = deps.store.get(sessionId);
      if (!deps.commander?.enabled() || draining || isBusy(sessionId) || sentKeys.get(sessionId) === r.sendKey) return false;
      if (!st || isOtherEngineState(st)) return false;
      sentKeys.set(sessionId, r.sendKey);
      segments.set(sessionId, new SegmentCollector(st.cwd));
      startTurn(NO_DEVICE, { type: 'send', sessionId, cwd, text }, false, undefined, r.hop, r.commanderNote);
      return busy.has(sessionId);
    }
    if (r.commanderHop) {
      // The commander stopped, paused or handed over since the failure: its booked retry goes with it (보안 #3 — and a
      // person decides what runs next).
      if (deps.commander && deps.commander.view(sessionId)?.state.status !== 'running') {
        const st = deps.store.get(sessionId);
        if (st?.pendingRetry) {
          const { pendingRetry: _drop, ...rest } = st;
          void deps.store.set(rest as typeof st).catch((err: unknown) => console.error('deck: retry booking drop failed', errMsg(err)));
        }
        // The booking held the segment open (and the session busy): it ends here, so an armed commander goes on.
        if (!busy.has(sessionId)) sessionIdle(sessionId);
        return false;
      }
      if (!segments.has(sessionId)) segments.set(sessionId, new SegmentCollector(cwd));
    }
    startTurn(NO_DEVICE, { type: 'send', sessionId, cwd, text }, false, r.hop, r.commanderHop);
    return busy.has(sessionId);
  };

  // ── 백그라운드 작업 ────────────────────────────────────────────────────────────────────────────────────────────
  // Each task is a new session started like a device's send, from a socket of its own (never in `clients`): it hears
  // every event of its turn, so the task learns its turn id, session id and result without touching the turn plumbing.
  const taskCap = () => clampTaskCap(deps.settings?.get().taskSoftCap);
  const broadcastTasks = () => { if (deps.tasks) broadcast({ type: 'tasks', tasks: deps.tasks.list(), cap: taskCap() }); };
  /** What a queued task will send once it gets a slot (kept in memory only: a restart fails queued tasks). */
  const taskTexts = new Map<string, { text: string; concise: boolean; lang?: Locale }>();
  const taskRef = (taskId: string) => `task-${taskId}`;
  /** Each running task's first turn id (its process), while it runs. */
  const taskBase = new Map<string, string>();
  /** Running tasks canceled before their turn started: stopped as soon as it does. */
  const taskCanceled = new Set<string>();
  /** Stops a task's turn the way ■ 중지 (interrupt) stops one: the process, and any card it waits on. */
  const stopTaskTurn = (base: string) => { turns.get(base)?.ac.abort(); broker.cancelTurn(base); questions.cancelTurn(base); };
  const syncTaskWaiting = () => {
    const reg = deps.tasks;
    if (!reg || taskBase.size === 0) return;
    const asking = new Set([...broker.pending(), ...questions.pending()].map((m) => baseOf(m.turnId)));
    let changed = false;
    for (const [taskId, base] of taskBase) if (reg.setWaiting(taskId, asking.has(base))) changed = true;
    if (changed) broadcastTasks();
  };
  const finishTask = (taskId: string, r: { ok: boolean; text: string | null; sessionId?: string | null }, quiet = false) => {
    taskBase.delete(taskId);
    taskCanceled.delete(taskId);
    const t = deps.tasks?.finish(taskId, r);
    if (!t) return;
    broadcastTasks();
    if (quiet) { pumpTasks(); return; }
    const title = `작업 ${t.status === 'done' ? '완료' : '실패'} · ${t.title}`;
    try { deps.pushTask?.({ kind: 'task', title: title.length > 60 ? `${title.slice(0, 59)}…` : title, body: (t.line ?? '').slice(0, 140), sessionId: t.sessionId, tag: `bgtask-${t.taskId}` }); } catch (err) { console.error('deck: task push failed', errMsg(err)); }
    pumpTasks();
  };
  const launchTask = (taskId: string) => {
    const reg = deps.tasks;
    const t = reg?.get(taskId);
    const what = taskTexts.get(taskId);
    taskTexts.delete(taskId);
    if (!reg || !t || !what) { if (t) finishTask(taskId, { ok: false, text: '작업 내용을 찾지 못했습니다' }); return; }
    const ref = taskRef(taskId);
    let base: string | null = null;
    const onEvent = (m: ServerMessage) => {
      const sid = 'sessionId' in m && typeof m.sessionId === 'string' ? m.sessionId : null;
      if (sid && reg.get(taskId)?.sessionId !== sid) { reg.sessionKnown(taskId, sid); broadcastTasks(); }
      if (m.type === 'turn_started' && base === null && m.clientRef === ref) {
        base = m.turnId;
        reg.turnStarted(taskId, m.turnId);
        if (taskCanceled.has(taskId)) { taskCanceled.delete(taskId); stopTaskTurn(m.turnId); } else if (reg.get(taskId)?.status === 'running') taskBase.set(taskId, m.turnId);
        return;
      }
      if (m.type === 'turn_result' && m.turnId === base) { finishTask(taskId, { ok: m.ok, text: m.ok ? m.text : (m.errorText ?? m.text), sessionId: m.sessionId }); return; }
      // Refused before it started (bad folder, draining, the engine cannot do it).
      if (base === null && (m.type === 'error' || m.type === 'route_fit') && m.clientRef === ref) finishTask(taskId, { ok: false, text: m.type === 'error' ? m.message : `이 작업에는 ${m.need} 이(가) 필요합니다` });
    };
    const sock = {
      readyState: WebSocket.OPEN,
      send: (data: string) => { try { onEvent(JSON.parse(data) as ServerMessage); } catch (err) { console.error('deck: task event failed', errMsg(err)); } },
    } as unknown as WebSocket;
    taskSockets.set(sock, (sid) => { if (reg.get(taskId)?.sessionId !== sid) { reg.sessionKnown(taskId, sid); broadcastTasks(); } });
    startTurn(sock, { type: 'send', sessionId: null, cwd: t.cwd, text: what.text, engine: 'auto', model: 'auto', title: `작업 · ${t.title}`.slice(0, 200), clientRef: ref, ...(what.concise ? { concise: true } : {}), ...(what.lang ? { lang: what.lang } : {}) });
  };
  /** Start queued tasks while there is room under the soft cap. */
  const pumpTasks = () => {
    const reg = deps.tasks;
    if (!reg || draining) return;
    for (let next = reg.nextQueued(); next && reg.running() < taskCap(); next = reg.nextQueued()) {
      reg.start(next.taskId);
      broadcastTasks();
      launchTask(next.taskId);
    }
  };

  /** `open_session`: the session's history (and, mid-turn, what its running turn has shown so far) to one socket, which views it from now on. */
  /** The deck turn streaming in this session now (null while idle or only waiting for background work) and its prompt. */
  /** hello.features: 'commander' only while the settings turn it on; 'grok' only with a grok binary. */
  const grokStatusNow = (): GrokStatus | undefined => (typeof deps.grokStatus === 'function' ? deps.grokStatus() : deps.grokStatus);
  const featureList = () => FEATURES.filter((f) => (f !== 'commander' || deps.commander?.enabled() === true) && (f !== 'grok' || grokStatusNow()?.bin === true) && (f !== 'tasks' || !!deps.tasks) && (f !== 'setup' || !!deps.setup));
  const runningOf = (sid: string) => {
    const t = turns.get(busy.get(sid) ?? '');
    const current = t?.current ?? null;
    const since = deps.acceptedRefs?.since(sid);
    const pos = heads.get(sid);
    const cmd = deps.commander?.enabled() ? { commander: deps.commander.view(sid) } : {};
    return { ...cmd, ...(pos ? { pos } : {}), runningTurnId: current, runningPrompt: current ? (prompts.get(current) ?? null) : null, ...(t && current ? { runningForMs: Math.max(0, Date.now() - t.since) } : {}), ...(deps.acceptedRefs ? { acceptedRefs: deps.acceptedRefs.list(sid), pendingRefs: t ? [...t.pendingRefs] : [], ...(since !== undefined ? { acceptedRefsSince: since } : {}) } : {}) };
  };
  type ClaudeHistory = { found: SessionEntry; st: ClaudeSessionState | null; at: number; messages: Awaited<ReturnType<typeof readTranscript>> };
  /** A Claude session's transcript as a pane shows it. A copy that contains deck's (e.g. Claude Desktop continued the session on A) is the one read. */
  const readClaudeHistory = async (sessionId: string, found: SessionEntry, st: ClaudeSessionState | null): Promise<ClaudeHistory> => {
    const best = st ? await deps.index.bestCopy(sessionId, st.projectDir, st.account).catch(() => null) : null;
    // Stamped before the read: an entry written while reading is looked at again by the outside poll.
    const at = Date.now();
    const messages = await readTranscript(best?.file ?? (st ? `${st.projectDir}/${sessionId}.jsonl` : found.file)).catch(() => readTranscript(found.file));
    return { found, st, at, messages };
  };
  /**
   * 다른 AI 로 이어가기: what the new session is told of `from`'s conversation (engine `engine`) — user / assistant text
   * only, length-capped (codexHandoffExcerpt), secrets masked. The failed message itself (the transcript's last user line)
   * is left out: it rides the new turn as its prompt. '' = nothing readable.
   */
  const crossExcerpt = async (from: string | null, engine: EngineKind, text: string): Promise<string> => {
    if (!from) return '';
    const st = deps.store.get(from);
    let msgs: TranscriptMessage[] = [];
    if (engine === 'claude') {
      const file = st && !isOtherEngineState(st) ? path.join(st.projectDir, `${from}.jsonl`) : deps.index.lookup(from)?.file;
      if (file) msgs = await readTranscript(file).catch(() => []);
    } else if (engine === 'codex' && st && isCodexState(st) && st.rolloutFile) {
      msgs = await (deps.readCodexHistory ?? readCodexTranscript)(st.rolloutFile).catch(() => []);
    } else if (engine === 'grok' && st && isGrokState(st) && deps.grokHome) {
      const dir = await findGrokSessionDir(deps.grokHome, st.grokSessionId ?? from).catch(() => null);
      if (dir) msgs = await readGrokTranscriptTail(path.join(dir, 'chat_history.jsonl')).catch(() => []);
    } else if (engine === 'gemini') {
      // No agy transcript reader: its conversation list (conversation_summaries.db, through the index) has the title and
      // a preview — that summary is what goes over. The preview of a one-turn conversation is the failed message itself.
      const e = deps.index.lookup(from);
      const summary = [e?.title, e?.preview].map((t) => t?.trim()).filter((t): t is string => !!t && t !== text.trim());
      msgs = [...new Set(summary)].map((t) => ({ kind: 'user', text: t }) as TranscriptMessage);
    }
    const last = msgs.findLastIndex((m) => m.kind === 'user');
    if (last >= 0 && (msgs[last] as { text: string }).text.trim() === text.trim()) msgs = msgs.slice(0, last);
    return redactSecrets(codexHandoffExcerpt(msgs, ROUTE_ENGINE_LABEL[engine]));
  };
  const sendClaudeHistory = (ws: WebSocket, sessionId: string, { found, st, at, messages }: ClaudeHistory, clean?: Map<string, number>) => {
    const t = turns.get(busy.get(sessionId) ?? '');
    let seen = historyAt.get(ws);
    if (!seen) { seen = new Map(); historyAt.set(ws, seen); }
    seen.set(sessionId, { at, clean: new Map(clean) });
    send(ws, { type: 'history', sessionId, cwd: found.cwd, account: st?.account ?? found.account, engine: 'claude', sandbox: null, accountPin: st?.accountPin ?? null, permissionMode: deps.runner.permissionModeOf(sessionId), sessionModel: st?.defaultModel ?? IMPORTED_DEFAULT_MODEL, messages, ...runningOf(sessionId) });
    if (t) replay(ws, t, sessionId);
    // The CLI writes a text block to the transcript only once it is finished: the one streaming now is in memory only, and
    // without it the pane's streaming item would start mid-sentence at the next delta. Claude only (a Codex delta is a
    // whole item its rollout already has). After the replayed steers: the text is what streamed since the latest one.
    if (t?.current && t.log.text) send(ws, { ...t.log.text, sessionId });
  };
  /**
   * `open_session.after`: true when the device was answered without reading anything again — `catchup`, then the events
   * after its position. That needs its position to be on the session's newest process, and either that process still
   * running with every later event kept, or nothing later at all on a socket that has viewed the session all along (a
   * new socket on an idle session may have missed what was written outside deck). Anything else: false, and the caller
   * sends the full history.
   */
  const catchUp = (ws: WebSocket, sessionId: string, after: { epoch: string; seq: number }): boolean => {
    // The header's acceptedRefs are what release a device's held messages (as a history's do).
    if (!deps.acceptedRefs || !clients.has(ws)) return false;
    const head = heads.get(sessionId);
    if (!head || head.epoch !== after.epoch || after.seq > head.seq) return false;
    const t = turns.get(busy.get(sessionId) ?? '');
    const live = t?.turnId === head.epoch ? t : undefined;
    let tail: { seq: number; data: string }[] = [];
    if (after.seq < head.seq) {
      if (!live) return false;
      tail = live.stream.filter((e) => e.seq > after.seq);
      if (tail.length !== head.seq - after.seq || tail[0]!.seq !== after.seq + 1 || tail[tail.length - 1]!.seq !== head.seq) return false;
    } else if (!live && !viewing.get(ws)?.has(sessionId)) return false;
    view(ws, sessionId);
    // The outside poll follows this socket's view of the session from here on, as after a history.
    let seen = historyAt.get(ws);
    if (!seen) { seen = new Map(); historyAt.set(ws, seen); }
    if (!seen.has(sessionId)) seen.set(sessionId, { at: Date.now(), clean: new Map() });
    const st = deps.store.get(sessionId);
    const claude = st && !isOtherEngineState(st) ? { accountPin: st.accountPin ?? null, permissionMode: deps.runner.permissionModeOf(sessionId), sessionModel: st.defaultModel }
      : st && isGrokState(st) ? { permissionMode: deps.runner.permissionModeOf(sessionId) } : {};
    const sandbox = !sandboxAware.has(ws) ? null : st ? (isCodexState(st) ? st.sandbox : null) : deps.runner.importSandboxOf(sessionId);
    send(ws, { type: 'catchup', sessionId, ...claude, ...(sandbox ? { sandbox } : {}), ...runningOf(sessionId) });
    for (const e of tail) ws.send(e.data);
    return true;
  };
  /**
   * 다른 AI 로 이어가기: a device opening a session a running turn moved away from (it was offline at the handover, or
   * reloaded) gets that turn's session_handoff messages again, in order, and the turn's events from here — it follows.
   */
  const followHandoffs = (ws: WebSocket, sessionId: string) => {
    const t = crossedTo.get(sessionId);
    if (!t || turns.get(t.turnId) !== t) return;
    if (ws !== t.origin) t.watchers.add(ws);
    for (const h of t.log.handoffs) send(ws, h);
  };
  const openSession = (ws: WebSocket, sessionId: string) => {
    void (async () => {
      // D4: Codex sessions live only in the state store; history comes from the CLI's rollout file.
      const st = deps.store.get(sessionId);
      if (st && isCodexState(st)) {
        view(ws, sessionId);
        const messages = st.rolloutFile ? await (deps.readCodexHistory ?? readCodexTranscript)(st.rolloutFile).catch(() => []) : [];
        send(ws, { type: 'history', sessionId, cwd: st.cwd, account: 'gpt', engine: 'codex', sandbox: st.sandbox, sessionModel: st.defaultModel, messages, ...runningOf(sessionId) });
        return;
      }
      // Gemini sessions: no transcript reader yet (the CLI's chat files are not read) — the pane starts empty.
      if (st && isGeminiState(st)) {
        view(ws, sessionId);
        send(ws, { type: 'history', sessionId, cwd: st.cwd, account: st.account, engine: 'gemini', sandbox: st.sandbox, sessionModel: st.defaultModel, messages: [], ...runningOf(sessionId) });
        return;
      }
      // Grok sessions: the CLI's own chat_history.jsonl under GROK_HOME (imports design §2.1a).
      if (st && isGrokState(st)) {
        view(ws, sessionId);
        const dir = deps.grokHome ? await findGrokSessionDir(deps.grokHome, st.grokSessionId ?? sessionId).catch(() => null) : null;
        const messages = dir ? await readGrokTranscriptTail(path.join(dir, 'chat_history.jsonl')).catch(() => []) : [];
        send(ws, { type: 'history', sessionId, cwd: st.cwd, account: st.account, engine: 'grok', sandbox: null, permissionMode: deps.runner.permissionModeOf(sessionId), sessionModel: isGrokModel(st.model) ? st.model : DEFAULT_GROK_MODEL, sessionEffort: st.effort, messages, ...runningOf(sessionId) });
        const t = turns.get(busy.get(sessionId) ?? '');
        if (t && messages.length) replay(ws, t, sessionId);
        return;
      }
      let entry = deps.index.lookup(sessionId);
      // Review (flaky ws.test.ts): a session written just after the last scan isn't in
      // the in-memory index yet. Rescan once (single-flight) and re-check before giving up.
      if (!entry && !deps.index.importOf(sessionId)) {
        await rescanIndex();
        entry = deps.index.lookup(sessionId);
      }
      // A Codex Desktop / CLI thread deck has not run yet: its rollout, read-only; the first turn resumes it.
      // Checked live: a rollout moved by Codex (archived / unarchived) or a folder that came / went since the last scan
      // triggers a rescan and an index push, so the list and composer follow without a manual refresh.
      const imported = entry ? null : await deps.index.freshImport(sessionId);
      const note = (message: string) => send(ws, { type: 'turn_notice', turnId: '', sessionId, cwd: imported!.cwd, message });
      const untitled = (t: string) => (t === '(제목 없음)' ? null : t);
      // A Grok Bot app conversation: read-only, always (no app API); continuing is the app's, or a new deck Grok session.
      if (imported && imported.source === 'grokbot') {
        view(ws, sessionId);
        const messages = await readGrokBotTranscript(imported.file).catch(() => []);
        send(ws, { type: 'history', sessionId, cwd: imported.cwd, account: 'x1', engine: 'grok', sandbox: null, messages, ...runningOf(sessionId) });
        note(GROKBOT_READONLY_NOTICE);
        return;
      }
      // A Grok CLI session deck has not run yet: its chat_history, read-only; the first turn resumes it (session/load).
      if (imported && imported.engine === 'grok') {
        view(ws, sessionId);
        const messages = await readGrokTranscriptTail(imported.file).catch(() => []);
        send(ws, { type: 'history', sessionId, cwd: imported.cwd, account: 'x1', engine: 'grok', sandbox: null, permissionMode: deps.runner.permissionModeOf(sessionId), sessionModel: isGrokModel(imported.grokModel) ? imported.grokModel : DEFAULT_GROK_MODEL, ...(imported.grokEffort ? { sessionEffort: imported.grokEffort } : {}), messages, ...runningOf(sessionId) });
        const t = turns.get(busy.get(sessionId) ?? '');
        if (t) replay(ws, t, sessionId);
        const age = await deps.index.importActiveAgeMs(sessionId);
        if (age !== null || (await deps.holders?.grokCwdHeld?.(imported.cwd))) note(elsewhereNotice({ engine: 'grok', title: untitled(imported.title), ageMs: age ?? 0 }));
        const blocked = await grokImportBlockReason(imported, deps.holders);
        if (blocked) note(blocked);
        return;
      }
      // An agy conversation: its messages are not readable (protobuf) — the pane starts empty; the first turn resumes it (--conversation).
      if (imported && imported.engine === 'gemini') {
        view(ws, sessionId);
        send(ws, { type: 'history', sessionId, cwd: imported.cwd, account: isGeminiAccount(imported.account) ? imported.account : 'g1', engine: 'gemini', sandbox: defaultGeminiSandbox(deps.runner.permissionModeOf(sessionId) === 'bypassPermissions'), sessionModel: DEFAULT_GEMINI_MODEL, messages: [], ...runningOf(sessionId) });
        const t = turns.get(busy.get(sessionId) ?? '');
        if (t) replay(ws, t, sessionId);
        const age = await deps.index.importActiveAgeMs(sessionId);
        if (age !== null) note(elsewhereNotice({ engine: 'gemini', title: untitled(imported.title), ageMs: age }));
        // deck itself is running this session's turn right now: that is not agy running it elsewhere, never the "agy 실행 중" notice.
        const blocked = (t?.current ? null : await deps.index.importHeldReason(sessionId)) ?? (await importBlockReason(imported));
        if (blocked) note(blocked);
        return;
      }
      if (imported) {
        view(ws, sessionId);
        const messages = await (deps.readCodexImportHistory ?? readCodexTranscriptTail)(imported.file).catch(() => []);
        send(ws, { type: 'history', sessionId, cwd: imported.cwd, account: 'gpt', engine: 'codex', sandbox: deps.runner.importSandboxOf(sessionId) ?? DEFAULT_SANDBOX, messages, ...runningOf(sessionId) });
        const t = turns.get(busy.get(sessionId) ?? '');
        if (t) replay(ws, t, sessionId);
        const age = await rolloutActiveAgeMs(imported.file);
        if (age !== null) send(ws, { type: 'turn_notice', turnId: '', sessionId, cwd: imported.cwd, message: liveRolloutNotice(imported.title, age) });
        // View only (folder gone / archived in Codex): said up front, not only when a send is refused.
        const blocked = await importBlockReason(imported);
        if (blocked) send(ws, { type: 'turn_notice', turnId: '', sessionId, cwd: imported.cwd, message: blocked });
        return;
      }
      // A new session's first turn running before its transcript is on disk (a device reloaded mid first turn): the
      // running turn alone — its prompt, streaming item and replay; the transcript comes with the next open.
      const live = entry ? undefined : turns.get(busy.get(sessionId) ?? '');
      if (live) {
        view(ws, sessionId);
        send(ws, { type: 'history', sessionId, cwd: live.cwd, account: null, ...(live.engine ? { engine: live.engine } : {}), sandbox: null, messages: [], ...runningOf(sessionId) });
        replay(ws, live, sessionId);
        if (live.current && live.log.text) send(ws, { ...live.log.text, sessionId });
        return;
      }
      if (!entry) { send(ws, { type: 'error', turnId: null, sessionId, code: 'not_found', message: `세션을 찾을 수 없습니다: ${sessionId}` }); return; }
      view(ws, sessionId);
      // PF5: `st` is narrowed to a Claude state (or null) by the Codex return above.
      const found = entry;
      await readClaudeHistory(sessionId, found, st ?? null)
        .then((read) => {
          sendClaudeHistory(ws, sessionId, read);
          // deck's copy and Desktop's (home profile) went separate ways: say so on open, not only after a turn.
          void deps.runner.forkStatus(sessionId).then((f) => { if (f?.diverged) send(ws, { type: 'turn_notice', turnId: '', sessionId, cwd: found.cwd, message: FORK_NOTICE }); }, () => undefined);
        })
        .catch((err: unknown) => send(ws, { type: 'error', turnId: null, sessionId, message: `기록을 읽지 못했습니다: ${errMsg(err)}` }));
    })().catch((err: unknown) => send(ws, { type: 'error', turnId: null, sessionId, message: `세션을 열지 못했습니다: ${errMsg(err)}` }));
  };

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    // Without this listener a bad frame (invalid UTF-8, oversized) is an uncaught 'error' that kills the process.
    ws.on('error', (err) => { console.error('deck ws: client error', (err as Error & { code?: string }).code ?? err.message); ws.terminate(); });
    send(ws, { type: 'hello', usage: deps.usage.snapshot(), projects: projects(), pins: pinList(), desktop: deps.index.desktop(), ...(deps.settings ? { settings: deps.settings.get() } : {}), running: running(), activity: activity(), codex: { available: deps.codexAvailable }, features: featureList(), accounts: accountInfos(accounts), ...(deps.geminiStatus ? { gemini: deps.geminiStatus() } : {}), ...(deps.grokStatus ? { grok: grokStatusNow() } : {}), ...(deps.build !== undefined ? { build: typeof deps.build === 'function' ? deps.build() : deps.build } : {}), ...(deps.setup ? { setup: { needed: deps.setup.needed() } } : {}) });
    // hello's `activity` is the session list only: whether the server is draining, and since when it runs, come here.
    send(ws, activityMsg());
    for (const m of broker.pending()) send(ws, m);
    for (const m of questions.pending()) send(ws, m);
    if (deps.tasks) send(ws, { type: 'tasks', tasks: deps.tasks.list(), cap: taskCap() });
    // hello carried the last scan's flags; a changed scan follows as an index message.
    syncHolders();

    ws.on('message', (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(data)); } catch { send(ws, { type: 'error', turnId: null, message: '메시지를 해석할 수 없습니다(JSON 아님)' }); return; }
      const r = ClientMessageSchema.safeParse(parsed);
      if (!r.success) {
        // A malformed send still names its pane when the frame carries a usable clientRef.
        const raw = parsed !== null && typeof parsed === 'object' ? (parsed as { clientRef?: unknown }).clientRef : undefined;
        const ref = typeof raw === 'string' && raw.length > 0 && raw.length <= CLIENT_REF_MAX ? { clientRef: raw } : {};
        send(ws, { type: 'error', turnId: null, message: `메시지 형식 오류: ${r.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`, ...ref });
        return;
      }
      const msg = r.data;
      switch (msg.type) {
        case 'send':
          if (msg.sessionId) userSent(msg.sessionId);
          startTurn(ws, msg);
          break;
        case 'permission_response': {
          const sid = broker.pending().find((m) => m.requestId === msg.requestId)?.sessionId ?? null;
          if (!broker.resolve(msg.requestId, msg.decision)) send(ws, { type: 'error', turnId: null, message: '이미 처리된 권한 요청입니다', requestId: msg.requestId });
          else if (sid) cardAnswered(sid);
          break;
        }
        case 'question_response': {
          const sid = questions.pending().find((m) => m.requestId === msg.requestId)?.sessionId ?? null;
          if (!questions.resolve(msg.requestId, msg.answers)) send(ws, { type: 'error', turnId: null, message: '이미 처리된 질문입니다', requestId: msg.requestId });
          else if (sid) cardAnswered(sid);
          break;
        }
        case 'watch_turn':
          turns.get(msg.turnId)?.watchers.add(ws);
          break;
        case 'steer': {
          // Into the running Claude turn's process; refused (the device sends it after the turn) when there is none.
          const turn = turns.get(baseOf(msg.turnId));
          const reject = (message: string, code?: RefusalCode) => send(ws, { type: 'steer_rejected', turnId: msg.turnId, sessionId: turn?.sessionId ?? null, cwd: turn?.cwd ?? '', steerId: msg.steerId, message, ...(code ? { code } : {}) });
          const dup = turn?.sessionId ? refusal(turn.sessionId, msg.steerId) : undefined;
          if (dup) { reject(dup.message, dup.code); break; }
          if (!turn || turn.current === null) { reject('실행 중인 턴이 없어 끝난 뒤 보냅니다'); break; }
          // ⚡ ↯ differs from the process's launch setting: never folded into it — sent after the turn (a new process).
          if ((turn.engine === undefined || turn.engine === 'claude') && turn.fast !== (msg.fast === true)) { reject(FAST_STEER_REJECTED); break; }
          // A person steering is a person sending (총사령탑: pause).
          if (turn.sessionId) userSent(turn.sessionId);
          void deps.runner.steer(turn.turnId, { steerId: msg.steerId, text: msg.text, ...(msg.attachments ? { attachments: msg.attachments } : {}), prompt: promptOf(msg) })
            .then((ok) => {
              // Recorded as accepted at steer_delivered (record()); until then it is pending.
              if (ok === false) reject('지금은 실행 중인 턴에 넣을 수 없어 끝난 뒤 보냅니다');
              else if (ok === true && turns.has(turn.turnId)) turn.pendingRefs.add(msg.steerId);
            })
            .catch((err: unknown) => reject(`실행 중인 턴에 넣지 못했습니다: ${errMsg(err)}`));
          break;
        }
        case 'cancel_queued': {
          // 취소 on a send the device was told waits behind a segment (turn_queued): out of the queue before it goes in.
          // Too late (it went in, or the process ended) changes nothing: its turn_started / error settles the device.
          // Only a socket showing the session (pendingRefs are in its history, so any viewer could name the ref).
          const base = viewing.get(ws)?.has(msg.sessionId) ? turns.get(busy.get(msg.sessionId) ?? '') : undefined;
          const withdrawn = base ? deps.runner.cancelQueued(msg.sessionId, msg.clientRef) : null;
          if (base && withdrawn) { base.pendingRefs.delete(msg.clientRef); aliases.delete(withdrawn); followFrom.delete(withdrawn); prompts.delete(withdrawn); endHeld(base); }
          // ⚡ Or waiting in deck for a ↯ switch's background work (holdBehindBg): out of that wait.
          const held = base && !withdrawn ? base.afterRelease.findIndex((d) => d.msg.clientRef === msg.clientRef) : -1;
          if (base && held >= 0) { base.afterRelease.splice(held, 1); base.pendingRefs.delete(msg.clientRef); }
          break;
        }
        case 'interrupt': {
          // A continuation's or follow-up's id stops the process it runs in (and its background work).
          const base = baseOf(msg.turnId);
          // A person stopping an auto turn is a person acting (총사령탑: pause — it is not judged into the next one).
          // Stopping their own turn is not: an armed commander then starts at idle as it would have.
          const sid = turns.get(base)?.sessionId;
          if (sid && COMMANDER_TURN_RE.test(base)) userSent(sid);
          turns.get(base)?.ac.abort();
          for (const id of new Set([msg.turnId, base])) { broker.cancelTurn(id); questions.cancelTurn(id); }
          break;
        }
        case 'stop_task': {
          void deps.runner.stopTask(baseOf(msg.turnId), msg.taskId)
            .then((ok) => { if (!ok) send(ws, { type: 'error', turnId: null, message: '이 작업은 따로 멈출 수 없습니다 — 모두 중지를 써 주세요' }); })
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, message: `작업을 멈추지 못했습니다: ${errMsg(err)}` }));
          break;
        }
        case 'open_session':
          if (msg.accepts?.includes('sandbox')) sandboxAware.add(ws);
          if (msg.accepts?.includes('turn_queued')) queuedAware.add(ws);
          syncHolders();
          if (!(msg.after && catchUp(ws, msg.sessionId, msg.after))) openSession(ws, msg.sessionId);
          followHandoffs(ws, msg.sessionId);
          break;
        case 'close_session':
          viewing.get(ws)?.delete(msg.sessionId);
          break;
        case 'refresh_index':
          void rescanIndex()
            .then(() => broadcast(indexMsg()))
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, message: `세션 목록을 읽지 못했습니다: ${errMsg(err)}` }));
          break;
        case 'set_account_pin': {
          const badPin = msg.pin === null ? null : pinRefusal(msg.pin);
          if (badPin) {
            send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: badPin });
            // The sender showed the pin already: back to what is stored.
            const st = deps.store.get(msg.sessionId);
            send(ws, { type: 'account_pin', sessionId: msg.sessionId, pin: (st && !isOtherEngineState(st) ? st.accountPin : undefined) ?? null });
            break;
          }
          void deps.runner.setAccountPin(msg.sessionId, msg.pin)
            .then((ok) => {
              if (ok) broadcast({ type: 'account_pin', sessionId: msg.sessionId, pin: msg.pin });
              else send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `계정을 고정할 수 없는 세션입니다: ${msg.sessionId}` });
            })
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `계정 고정을 저장하지 못했습니다: ${errMsg(err)}` }));
          break;
        }
        case 'set_permission_mode':
          // 총사령탑 보안: no 모두 자동 승인 while a commander is active (its automatic turns must stay gated).
          if (msg.mode === 'bypassPermissions' && deps.commander?.isActive(msg.sessionId)) {
            send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, code: 'commander_active', message: '총사령탑이 걸린 세션은 모두 자동 승인으로 바꿀 수 없습니다 — 먼저 정지하세요' });
            send(ws, { type: 'permission_mode', sessionId: msg.sessionId, mode: deps.runner.permissionModeOf(msg.sessionId) });
            break;
          }
          void deps.runner.setPermissionMode(msg.sessionId, msg.mode)
            .then((ok) => {
              if (!ok) { send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `권한 모드를 바꿀 수 없는 세션입니다: ${msg.sessionId}` }); return; }
              broadcast({ type: 'permission_mode', sessionId: msg.sessionId, mode: msg.mode });
              // 모두 자동 승인 also lets through this session's cards already waiting (a plan still needs its own choice).
              // Grok: only the kinds its engine would auto-approve; plan exit, widening and other kinds stay cards.
              if (msg.mode === 'bypassPermissions') {
                const st = deps.store.get(msg.sessionId);
                const ok = st && isGrokState(st) ? isGrokAutoApprovable : (toolName: string) => toolName !== 'ExitPlanMode';
                for (const m of broker.pending()) if (m.sessionId === msg.sessionId && ok(m.toolName)) broker.resolve(m.requestId, 'once');
              }
            })
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `권한 모드를 저장하지 못했습니다: ${errMsg(err)}` }));
          break;
        case 'set_sandbox':
          void deps.runner.setSandbox(msg.sessionId, msg.sandbox)
            .then((ok) => {
              if (ok) broadcastSandbox(msg.sessionId, msg.sandbox);
              else send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `샌드박스는 GPT 세션에서만 바꿀 수 있습니다: ${msg.sessionId}` });
            })
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, message: `샌드박스를 저장하지 못했습니다: ${errMsg(err)}` }));
          break;
        case 'set_cwd': {
          // 작업 폴더 바꾸기: refused while a turn (or its background work) runs; an idle held-open process is ended first
          // so the next turn starts fresh in the new folder.
          const id = msg.sessionId;
          const refuse = (message: string) => send(ws, { type: 'error', turnId: null, sessionId: id, message });
          const held = turns.get(busy.get(id) ?? '');
          if (held && (held.current !== null || held.bg !== null || held.pendingRefs.size > 0 || held.afterRelease.length > 0)) { refuse('세션이 실행 중이라 작업 폴더를 바꿀 수 없습니다 — 끝난 뒤 다시 해 주세요'); break; }
          if (draining) { refuse(DRAINING_MESSAGE); break; }
          void (async () => {
            let cwd: string;
            try {
              cwd = await resolveUnderRoots(msg.cwd, cwdRoots[0] ?? os.homedir(), cwdRoots);
            } catch (err) {
              if (!(err instanceof DirError)) throw err;
              refuse(`${err.message}: ${msg.cwd}`);
              return;
            }
            if (held && turns.has(held.turnId)) { held.recycling = true; held.ac.abort(); }
            for (let i = 0; i < 100 && (busy.has(id) || deps.runner.backgroundSessions().includes(id)); i++) await new Promise((r) => setTimeout(r, 50));
            if (busy.has(id)) { refuse('세션이 실행 중이라 작업 폴더를 바꿀 수 없습니다 — 끝난 뒤 다시 해 주세요'); return; }
            const r = await deps.runner.setCwd(id, cwd);
            if (!r.ok) { refuse(r.error); return; }
            if (r.engine === 'claude') await deps.meta?.setCwd?.(id, cwd);
            await rescanIndex();
            deps.index.regroup();
            broadcast({ type: 'session_cwd', sessionId: id, cwd });
            broadcast(indexMsg());
          })().catch((err: unknown) => refuse(`작업 폴더를 바꾸지 못했습니다: ${errMsg(err)}`));
          break;
        }
        case 'duplicate_session': {
          // 복제: the same folder, engine, model and account settings, no history. The session itself is created by the
          // first send of the pane the sender opens with these (its `title` names it then).
          const id = msg.sessionId;
          const st = deps.store.get(id);
          const entry = deps.index.lookup(id);
          const imported = st || entry ? null : deps.index.importOf(id);
          if (imported?.source === 'grokbot') { send(ws, { type: 'error', turnId: null, sessionId: id, message: 'Grok Bot 대화는 복제할 수 없어요 — “새 Grok 세션으로 이어가기”를 쓰세요' }); break; }
          const cwd = st?.cwd ?? entry?.cwd ?? imported?.cwd;
          if (!cwd) { send(ws, { type: 'error', turnId: null, sessionId: id, message: `복제할 수 없는 세션입니다: ${id}` }); break; }
          const old = deps.meta?.title?.(id) ?? entry?.title ?? deps.index.codexOwned(deps.store.codexEntries()).find((e) => e.sessionId === id)?.title ?? imported?.title ?? id.slice(0, 8);
          const title = `${old} (복사)`.slice(0, 200);
          if (st && isGrokState(st)) send(ws, { type: 'session_duplicate', from: id, cwd, engine: 'grok', model: isGrokModel(st.model) ? st.model : DEFAULT_GROK_MODEL, title, permissionMode: deps.runner.permissionModeOf(id) });
          else if (st && isOtherEngineState(st)) send(ws, { type: 'session_duplicate', from: id, cwd, engine: st.engine, model: st.defaultModel, title, sandbox: st.sandbox });
          else if (imported?.engine === 'grok') send(ws, { type: 'session_duplicate', from: id, cwd, engine: 'grok', model: isGrokModel(imported.grokModel) ? imported.grokModel : DEFAULT_GROK_MODEL, title, permissionMode: deps.runner.permissionModeOf(id) });
          else if (imported?.engine === 'gemini') send(ws, { type: 'session_duplicate', from: id, cwd, engine: 'gemini', model: DEFAULT_GEMINI_MODEL, title, sandbox: defaultGeminiSandbox(deps.runner.permissionModeOf(id) === 'bypassPermissions') });
          else if (imported) send(ws, { type: 'session_duplicate', from: id, cwd, engine: 'codex', model: DEFAULT_CODEX_MODEL, title, sandbox: deps.runner.importSandboxOf(id) ?? DEFAULT_SANDBOX });
          else send(ws, { type: 'session_duplicate', from: id, cwd, engine: 'claude', model: st?.defaultModel ?? IMPORTED_DEFAULT_MODEL, title, accountPin: st?.accountPin ?? null, permissionMode: deps.runner.permissionModeOf(id) });
          break;
        }
        case 'route_preview':
          // A fresh ask is always answered (the pane dropped the last answer when it asked); null with no cwd withdraws it.
          routeSent.delete(ws);
          if (msg.sessionId === null && msg.cwd === undefined) { routeAsk.delete(ws); break; }
          routeAsk.set(ws, { sessionId: msg.sessionId, ...(msg.model ? { model: msg.model } : {}) });
          sendRoutePreview(ws);
          break;
        case 'grok_unlock':
          deps.grokUnlock?.();
          break;
        case 'set_settings': {
          const store = deps.settings;
          if (!store) { send(ws, { type: 'error', turnId: null, message: '설정을 바꿀 수 없습니다' }); break; }
          // The default only applies to new sessions (and ones with no stored mode) from their next turn: waiting cards stay.
          void store.set({ ...(msg.autoApprove !== undefined ? { autoApprove: msg.autoApprove } : {}), ...(msg.defaultPermissionMode ? { defaultPermissionMode: msg.defaultPermissionMode } : {}), ...(msg.routingPolicy ? { routingPolicy: msg.routingPolicy } : {}), ...(msg.sameVendorRotation !== undefined ? { sameVendorRotation: msg.sameVendorRotation } : {}), ...(msg.commanderEnabled !== undefined ? { commanderEnabled: msg.commanderEnabled } : {}), ...(msg.autoEngines ? { autoEngines: msg.autoEngines } : {}), ...(msg.autoConsent ? { autoConsent: msg.autoConsent } : {}), ...(msg.grokFast !== undefined ? { grokFast: msg.grokFast } : {}), ...(msg.crossEngineFailover !== undefined ? { crossEngineFailover: msg.crossEngineFailover } : {}), ...(msg.taskSoftCap !== undefined ? { taskSoftCap: msg.taskSoftCap } : {}), ...(msg.language !== undefined ? { language: msg.language } : {}), ...(msg.experimental ? { experimental: msg.experimental } : {}) })
            // 총사령탑 켜기·끄기 changes what the server advertises: every device gets the list again.
            .then((settings) => {
              // Off: no commander is left running unseen (devices drop the chip with the feature) or armed for a later on.
              if (msg.commanderEnabled === false) deps.commander?.disableAll();
              broadcast({ type: 'settings', settings, ...(msg.commanderEnabled !== undefined ? { features: featureList() } : {}) });
              if (msg.taskSoftCap !== undefined) { broadcastTasks(); pumpTasks(); }
              // Server messages follow the last explicit pick from now on.
              if (msg.language !== undefined) setLocale(resolveServerLocale(settings, process.env));
              // 실험적 기능 apply now: the lists they feed are read again (or emptied) and every device gets them.
              if (msg.experimental) void deps.index.refresh().then(() => broadcast(indexMsg()), () => undefined);
            })
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, message: `설정을 저장하지 못했습니다: ${errMsg(err)}` }));
          break;
        }
        case 'start_task': {
          const ref = msg.clientRef ? { clientRef: msg.clientRef } : {};
          if (!deps.tasks) { send(ws, { type: 'error', turnId: null, message: '이 서버는 백그라운드 작업을 지원하지 않습니다', ...ref }); break; }
          if (draining) { send(ws, { type: 'error', turnId: null, message: DRAINING_MESSAGE, code: 'draining', ...ref }); break; }
          if (deps.tasks.queued() >= TASKS_QUEUED_MAX) { send(ws, { type: 'error', turnId: null, message: `대기 중인 작업이 ${TASKS_QUEUED_MAX}개라 더 받을 수 없습니다`, ...ref }); break; }
          const t = deps.tasks.create({ fromSessionId: msg.fromSessionId, cwd: msg.cwd, text: msg.text }, taskCap());
          taskTexts.set(t.taskId, { text: msg.text, concise: msg.concise === true, ...(msg.lang ? { lang: msg.lang } : {}) });
          broadcastTasks();
          if (t.status === 'running') launchTask(t.taskId);
          break;
        }
        case 'dismiss_task':
          if (deps.tasks?.dismiss(msg.taskId)) broadcastTasks();
          break;
        case 'cancel_task': {
          const reg = deps.tasks;
          if (!reg) break;
          if (reg.removeQueued(msg.taskId)) { taskTexts.delete(msg.taskId); broadcastTasks(); break; }
          if (reg.get(msg.taskId)?.status !== 'running') break;
          const base = taskBase.get(msg.taskId);
          // Not started yet: its turn is stopped once turn_started names it (the flag outlives finishTask's cleanup).
          finishTask(msg.taskId, { ok: false, text: TASK_CANCELED_LINE }, true);
          if (base) stopTaskTurn(base);
          else taskCanceled.add(msg.taskId);
          break;
        }
        case 'commander_set':
        case 'commander_stop':
        case 'commander_pause':
        case 'commander_resume': {
          const c = deps.commander;
          // ■ 정지 is heard while off too: a commander from before is never stuck.
          if (!c || (!c.enabled() && msg.type !== 'commander_stop')) { send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, code: 'commander_disabled', message: DISABLED_MESSAGE }); break; }
          const res = msg.type === 'commander_set' ? c.set(msg.sessionId, { goal: msg.goal, done: msg.done, ...(msg.maxTurns !== undefined ? { maxTurns: msg.maxTurns } : {}) })
            : msg.type === 'commander_stop' ? c.stop(msg.sessionId, msg.epoch)
              : msg.type === 'commander_pause' ? c.pause(msg.sessionId, msg.epoch)
                : c.resume(msg.sessionId, msg.epoch);
          if (!res.ok) {
            send(ws, { type: 'error', turnId: null, sessionId: msg.sessionId, code: res.code, message: res.message });
            // The device's view may be the stale part: the current one goes with the refusal.
            const v = c.view(msg.sessionId);
            if (v) send(ws, { type: 'commander', sessionId: msg.sessionId, ...v });
          }
          break;
        }
      }
    });

    ws.on('close', () => { clients.delete(ws); viewing.delete(ws); routeAsk.delete(ws); routeSent.delete(ws); historyAt.delete(ws); for (const t of turns.values()) t.watchers.delete(ws); });
  });

  return {
    broadcast,
    broadcastIndex: () => broadcast(indexMsg()),
    drain() {
      if (draining) return;
      draining = true;
      broadcast({ type: 'error', turnId: null, message: DRAINING_MESSAGE, code: 'draining' });
      // Every device shows 재시작 대기 중 at once, not with the next change of the running work.
      broadcast(activityMsg());
      // restart.sh reads `draining` from the activity file: written now, not with the next change.
      if (deps.activityFile && !activityClosed) { if (activityTimer) clearTimeout(activityTimer); writeActivity(); }
      const waiting = [...turns.values()].filter((t) => (t.bg?.msg.tasks.length ?? 0) > 0);
      if (waiting.length) {
        const list = waiting.map((t) => { const s = t.bg!.msg.tasks.join('·'); return `${(t.sessionId ?? t.turnId).slice(0, 8)}(${s.length > 60 ? `${s.slice(0, 60)}…` : s})`; }).join(' ');
        console.log(`deck: 재시작 대기 — 백그라운드 작업이 있는 세션 ${waiting.length}개: ${list}`);
      }
      // Only processes waiting with no work left end now (see endHeld); live background work is waited for.
      for (const t of turns.values()) endHeld(t);
    },
    submitRetry({ sessionId, cwd, text, hop, commanderHop }) {
      submitServerSend({ kind: 'retry', sessionId, cwd, text, hop, ...(commanderHop ? { commanderHop } : {}) });
    },
    submitServerSend,
    isBusy,
    isTaskTurn: (turnId: string) => deps.tasks?.taskOfTurn(turnId) != null,
    isConciseTurn: (turnId: string) => conciseTurns.has(turnId),
    /** Processes still up (running a prompt, or closing after `drain` ended them): the restart waits for these. */
    activeTurns: () => turns.size,
    abortAll() {
      // Marked as the server's: those turns end with SHUTDOWN_ABORTED, which the UI shows (a user's stop it hides).
      for (const t of turns.values()) t.ac.abort(SHUTDOWN_ABORT);
    },
    close() {
      unsubscribeUsage();
      if (outsideTimer) clearInterval(outsideTimer);
      if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
      activityClosed = true;
      // Gone at once: a stale file must not make restart.sh refuse (or trust) a server that is no longer this one.
      if (deps.activityFile) fsSync.rmSync(deps.activityFile, { force: true });
      for (const c of clients) c.close();
      wss.close();
    },
  };
}
