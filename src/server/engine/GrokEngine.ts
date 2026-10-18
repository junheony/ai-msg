import { randomUUID } from 'node:crypto';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import type { Effort } from '../../shared/models';
import { ZERO_USAGE, type PermissionDecision, type TurnUsage } from '../../shared/turn-types';
import type { GrokBilling } from '../../shared/usage-types';
import { promptWithFiles, type Attachment } from '../attachments/AttachmentStore';
import { AcpAbortError, AcpClosedError, AcpConnection, AcpRpcError, AcpTimeoutError } from './acp/AcpConnection';
import type { ChildLike, SpawnFn } from './CodexEngine';
import type { EngineEvent, EngineResult, FollowUp, LiveInput, PermissionRequest } from './Engine';
import { GROK_BILLING_METHOD, parseGrokBilling } from './grokBilling';
import { editAutoAllowed } from './grokEditPaths';
import { grokEnv } from './grokEnv';
import { checkGrokInspect, grokInspectRefusal } from './grokInspect';
import { GrokLock, GrokLockTimeoutError, grokLock, grokLockKey } from './grokLock';
import { GROK_PROJECT_BLOCKED_TEXT, findGrokProjectConfig } from './grokProjectGuard';
import { isTripwire } from './grokTripwire';
import { redactSecrets } from './redact';
import { GROK_SHADOW_LINKS, ShadowHomeError, createShadowHome, type ShadowHome } from './shadowHome';

/**
 * Grok Build CLI over ACP (`grok agent stdio`), design docs/superpowers/specs/2026-10-18-grok-engine-design.md §14
 * (revision 2; §14.9 wins). One deck turn = one agent process in its own process group, with a fresh shadow HOME:
 * engine lock check → lock → shadow HOME → `grok inspect` (fail-closed) → spawn → initialize → session/new|load →
 * model, effort → session/prompt → close stdin → group ends → reap → shadow HOME removed → unlock.
 *
 * Grok's session mode always stays `default` (every write and shell asks). deck's modes are only how deck answers
 * `session/request_permission`, read live per request. A changing tool that runs with no request for its id trips the
 * wire (§14.9-3): the turn stops and the Grok engine is locked for this server process. Wire shapes: grok 1.0.62
 * recordings in acp/fixtures/grok-1.0.62/ and docs/grok-spike.md.
 */

type Rec = Record<string, unknown>;

/** deck's request mode. Only `plan` reaches the engine as such — and is refused (§14.2: hidden until S14). */
export type GrokPermissionMode = 'default' | 'acceptEdits' | 'plan';

/** deck's model id for "Grok's own default model": no model setting is sent (§6). */
export const GROK_DEFAULT_MODEL = 'grok';

/** §12: a session id must pass this before it is sent in session/load (or used in a history path). */
export const GROK_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const GROK_TEXT = {
  notLoggedIn: 'Grok 로그인 필요 — 터미널에서 grok login',
  rateLimit: 'Grok 한도 — 잠시 뒤',
  overloaded: 'Grok 서버 혼잡 — 잠시 뒤 다시',
  refusal: 'Grok 이 거절함',
  maxTokens: '출력 한도에서 멈춤',
  maxTurnRequests: '모델 요청 횟수 한도에서 멈춤',
  imageUnsupported: 'Grok 은 이미지 첨부를 받지 않음',
  projectBlocked: GROK_PROJECT_BLOCKED_TEXT,
  modeUnconfirmed: 'Grok 권한 모드를 확인할 수 없어 시작하지 않음',
  modeChanged: 'Grok 권한 모드가 deck 이 고른 모드와 달라져 중단함',
  tripwire: 'Grok 이 승인 없이 쓰기를 실행해 멈춤',
  planUnsupported: 'Grok 계획 모드는 아직 지원하지 않음 — 다른 모드로 바꿔 주세요',
  inspectFailed: 'Grok 설정 점검(grok inspect)을 할 수 없어 시작하지 않음',
  shadowHomeFailed: 'Grok 격리 HOME 을 준비할 수 없어 시작하지 않음',
  externallyModified: '이 Grok 세션이 deck 밖에서 수정됨 — 대화가 갈라졌을 수 있음',
  stopRejected: '멈춤: 승인 거부',
  stopCancelled: '멈춤: 승인 취소',
  stopUnknown: '멈춤: 원인 미확인',
  steerQueued: 'Grok 이 추가 메시지를 접수함',
  noResult: '(결과 없음)',
  subagent: '하위 에이전트',
  effortUnsupported: '이 Grok 모델은 effort 설정을 받지 않음',
  aborted: '중단됨',
  leftoverProcesses: 'Grok 이 띄운 프로세스 일부가 남아 있음',
} as const;

/** Error text of a turn refused because the engine is locked (§14.9-3). */
export const grokEngineLockedText = (reason: string) => `Grok 엔진 잠김 — ${reason} (설정 화면에서 해제하거나 서버 재시작)`;

export type GrokTurnRequest = {
  account: Account;
  /** The session's canonical cwd; realpath'd again before spawn. */
  cwd: string;
  /** Grok session id; null starts a new session. */
  resumeSessionId: string | null;
  /** `grok` = Grok's default (nothing sent); anything else → `session/set_config_option` on the model option. */
  model: string;
  effort: Effort;
  /** `plan` is refused; anything else runs with Grok's default mode (deck answers the requests). */
  permissionMode: GrokPermissionMode;
  prompt: string;
  attachments?: Attachment[];
  signal: AbortSignal;
  /** 모두 자동 승인, read per permission request (a mid-turn change applies to the next request). */
  autoApprove?: () => boolean;
  /** 편집 자동, read per permission request; absent = `permissionMode === 'acceptEdits'`. */
  editAuto?: () => boolean;
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  onAutoApproved?: (req: PermissionRequest) => Promise<void>;
  onToolAudit?: (e: { toolName: string; input: unknown; toolUseId: string; decision: 'allow' | 'deny'; source: 'cli' | 'rule' | 'deck' }) => Promise<void>;
  onLive?: (live: LiveInput) => void;
  /** A new session's id, awaited before the prompt is sent (so a crash mid-turn can still be resumed). */
  onSessionId?: (id: string) => Promise<void> | void;
};

export type GrokTimeouts = {
  lockMs: number;
  initializeMs: number;
  sessionMs: number;
  settingMs: number;
  /** session/cancel → PromptResponse(cancelled) (§14.5: 5s). */
  cancelMs: number;
  /** stdin closed → the group ends on its own (history flush). */
  closeMs: number;
  /** group SIGTERM → SIGKILL. */
  termMs: number;
  /** after SIGKILL, how long to wait before giving up (logged). */
  killMs: number;
  steerMs: number;
  /** After a cancelled PromptResponse with no cancellationCategory yet: how long to wait for it (§14.9-7). */
  categoryMs: number;
  /** After the PromptResponse, when steers were sent: how long to watch for an interject-fallback turn to cancel. */
  fallbackMs: number;
  /** Process table sampling for the descendant sweep (§14.9-9). */
  sampleMs: number;
  /** `_x.ai/billing` after the prompt (and the idle poller's): short — the subscription usage is extra, never the turn. */
  billingMs: number;
};

export const GROK_TIMEOUTS: GrokTimeouts = {
  lockMs: 30_000, initializeMs: 15_000, sessionMs: 30_000, settingMs: 10_000,
  cancelMs: 5_000, closeMs: 10_000, termMs: 3_000, killMs: 2_000, steerMs: 10_000,
  categoryMs: 1_000, fallbackMs: 500, sampleMs: 2_000, billingMs: 5_000,
};

/** §14.9-3: once tripped, no Grok turn starts in this server process until unlocked (settings) or restarted. */
export class GrokEngineLock {
  private why: string | null = null;
  private readonly subs = new Set<(reason: string | null) => void>();

  get reason(): string | null {
    return this.why;
  }

  lock(reason: string): void {
    if (this.why !== null) return;
    this.why = reason;
    for (const s of this.subs) s(reason);
  }

  unlock(): void {
    if (this.why === null) return;
    this.why = null;
    for (const s of this.subs) s(null);
  }

  onChange(fn: (reason: string | null) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
}

export const grokEngineLock = new GrokEngineLock();

/** Size and mtime of a session's `updates.jsonl` when deck's last turn on it ended (§14.9-10). */
export type GrokSessionStamp = { size: number; mtimeMs: number };
const grokSessionStamps = new Map<string, GrokSessionStamp>();

export type GrokDeps = {
  bin: string;
  /** The seat's GROK_HOME, given by deck (never inherited from the shell). */
  grokHome: string;
  /** Parent of the per-turn shadow HOME folders (`<configDir>/homes/grok`). */
  homesDir: string;
  /** The user's real HOME: source of the allowed links, and the HOME the edit-auto and project checks compare with. */
  realHome: string;
  /** `grok inspect --json` with the turn's env and cwd (main: runGrokInspect). */
  inspect: (env: Record<string, string>, cwd: string) => Promise<unknown>;
  /** Reads a config layer for checkGrokInspect (tests); default fs. */
  readConfig?: (p: string) => Promise<string>;
  engineLock?: GrokEngineLock;
  sessionStamps?: Map<string, GrokSessionStamp>;
  spawnFn?: SpawnFn;
  baseEnv?: NodeJS.ProcessEnv;
  lock?: GrokLock;
  timeouts?: Partial<GrokTimeouts>;
  log?: (msg: string) => void;
  /** Process table for the descendant sweep (tests); default runs `ps`, null = skip. */
  listProcesses?: () => Promise<GrokProcEntry[] | null>;
};

export type GrokProcEntry = { pid: number; ppid: number; pgid: number };

/** §8: stderr kept for an abnormal exit. */
export const GROK_STDERR_MAX = 4096;
/** §3: a tool_result body is the merged content text, cut here. */
export const TOOL_RESULT_MAX = 32 * 1024;

/** §4.2: permission kinds 모두 자동 승인 may answer; anything else gets a card. */
export const AUTO_APPROVE_KINDS: ReadonlySet<string> = new Set(['edit', 'execute', 'read', 'fetch', 'search']);
/**
 * 모두 자동 승인 may answer a `grok:<kind>` card itself only for these kinds (the engine's own check and ws's bulk approval
 * when a session switches to bypassPermissions). Plan exit, mode/permission widening and unknown kinds stay cards.
 */
export function isGrokAutoApprovable(toolName: string): boolean {
  return toolName.startsWith('grok:') && AUTO_APPROVE_KINDS.has(toolName.slice('grok:'.length));
}

/**
 * `--no-leader`: a config.toml leader mode would otherwise share one backend between processes (observed grok 1.0.62);
 * deck's turn = its own process.
 */
export const GROK_AGENT_ARGS = ['agent', '--no-leader', 'stdio'] as const;

/** §6 effort → Grok's thought_level value (deck already spells max as xhigh). */
export const GROK_EFFORT: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };

/** §14.4 steer: answered `{ result: { status: "queued" } }`, echoed as `_x.ai/session/interjection`. */
export const GROK_INTERJECT_METHOD = '_x.ai/interject';
/** A prompt id Grok gives a turn it starts itself from an interject that arrived after its turn ended. */
const FALLBACK_PREFIX = 'interject-fallback-';

/** Sent with session/new and session/load (§14.1-2; a secondary measure, not the gate). */
const SESSION_META = { yoloMode: false, autoMode: false } as const;

// ---------------------------------------------------------------------------------------------------------------
// Error classification (§8): structured fields first; only the JSON-RPC error itself is read, never tool output.

export type GrokErrorClass = 'rate_limit' | 'overloaded' | 'auth' | 'other';

/** ACP `auth_required`. */
const ACP_AUTH_REQUIRED = -32000;
const QUOTA_RE = /quota|usage limit|limit reached|\b429\b/i;
const AUTH_MSG_RE = /auth(?:entication)?[ _-]?(?:required|failed)|unauthori[sz]ed|not logged in|grok login/i;
const RATE_MSG_RE = /rate[ _-]?limit/i;

export function classifyGrokError(err: unknown): GrokErrorClass {
  if (!(err instanceof AcpRpcError)) return 'other';
  const data = (err.data && typeof err.data === 'object' ? err.data : {}) as Rec;
  const inner = (data.error && typeof data.error === 'object' ? data.error : {}) as Rec;
  const types = [data.type, data.kind, data.errorType, inner.type].filter((x): x is string => typeof x === 'string').map((s) => s.toLowerCase());
  const statuses = [data.status, data.statusCode, data.httpStatus, inner.status, inner.statusCode].map((x) => Number(x)).filter((n) => Number.isFinite(n));
  const text = [err.message, data.message, inner.message].filter((x): x is string => typeof x === 'string').join('\n');
  // Structured type/status first: -32000 is also a generic JSON-RPC server error code and may carry a rate limit.
  if (types.some((t) => t === 'authentication_failed' || t === 'auth_required' || t === 'unauthenticated')) return 'auth';
  if (types.some((t) => t === 'rate_limit' || t === 'rate_limited')) return statuses.includes(429) || QUOTA_RE.test(text) ? 'rate_limit' : 'overloaded';
  if (statuses.includes(503) || statuses.includes(529) || types.includes('overloaded')) return 'overloaded';
  if (statuses.includes(429)) return 'rate_limit';
  // No structured type: the error message only (still never tool output).
  if (types.length === 0 && statuses.length === 0) {
    if (err.code === ACP_AUTH_REQUIRED && /authentication required/i.test(err.message)) return 'auth';
    if (AUTH_MSG_RE.test(text)) return 'auth';
    if (RATE_MSG_RE.test(text) && QUOTA_RE.test(text)) return 'rate_limit';
  }
  return 'other';
}

// ---------------------------------------------------------------------------------------------------------------

type ToolState = {
  id: string;
  sessionId: string;
  /** ACP kind (from tool_call_update; the first tool_call has none). */
  kind: string | null;
  /** `_meta["x.ai/tool"]`: Grok's tool name and its own kind (`write`, `execute`, …). */
  xaiName: string | null;
  xaiKind: string | null;
  title: string;
  status: string;
  content: unknown[];
  rawInput: unknown;
  locations: unknown;
  notRun: boolean;
  /** A tool_call event went out (parent session, during the prompt). */
  shown: boolean;
  resulted: boolean;
  checked: boolean;
};

type ConfigOption = { id: string; category: string | null; type: string; currentValue: unknown; values: string[] };

const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const rec = (x: unknown): Rec | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Rec) : null);
const isTerminal = (s: string) => s === 'completed' || s === 'failed';

/** Grok's own tool kinds → ACP kinds, for a tool whose update with the ACP kind has not come (yet). */
const XAI_KIND: Record<string, string> = {
  write: 'edit', edit: 'edit', search_replace: 'edit', multi_edit: 'edit', apply_patch: 'edit', str_replace: 'edit', create_file: 'edit',
  execute: 'execute', bash: 'execute', shell: 'execute', terminal: 'execute',
  delete: 'delete', delete_file: 'delete', move: 'move', rename: 'move',
};
const effectiveKind = (st: ToolState): string => st.kind ?? (st.xaiKind ? XAI_KIND[st.xaiKind] : undefined) ?? 'other';

function normInput(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : raw === undefined ? {} : { value: raw };
}

/** Text of merged ToolCallContent: `{ type: 'content', content: { type: 'text', text } }` items (diff/terminal carry no text). */
function contentText(content: unknown[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const item = c as Rec;
    const block = (item.type === 'content' && item.content && typeof item.content === 'object' ? item.content : item) as Rec;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function parseConfigOptions(x: unknown): ConfigOption[] | null {
  if (!Array.isArray(x)) return null;
  const out: ConfigOption[] = [];
  for (const o of x) {
    const r = rec(o);
    const id = r ? str(r.id) : null;
    if (!r || !id) continue;
    const values: string[] = [];
    const walk = (opts: unknown) => {
      if (!Array.isArray(opts)) return;
      for (const v of opts) {
        const e = rec(v);
        if (!e) continue;
        if (typeof e.value === 'string') values.push(e.value);
        else if (Array.isArray(e.options)) walk(e.options);
      }
    };
    walk(r.options);
    out.push({ id, category: str(r.category), type: str(r.type) ?? 'select', currentValue: r.currentValue, values });
  }
  return out;
}

/** PromptResponse `_meta.usage` (grok 1.0.62): inputTokens includes the cached reads; deck counts them apart. */
function usageOf(meta: unknown): TurnUsage {
  const u = rec(rec(meta)?.usage);
  if (!u) return ZERO_USAGE;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  const cached = n(u.cachedReadTokens);
  return { inputTokens: Math.max(0, n(u.inputTokens) - cached), outputTokens: n(u.outputTokens), cacheReadTokens: cached, cacheCreationTokens: n(u.cacheCreationTokens) };
}

/** Kinds the mapper knows and drops on purpose; anything else is logged once per kind. */
const IGNORED_UPDATES = new Set([
  'plan', 'user_message_chunk', 'available_commands_update', 'session_info_update', 'usage_update', 'tool_call_delta_chunk',
  'model_changed', 'response_completed', 'session_summary_generated', 'background_tasks', 'last_turn_summary',
  'hook_annotation', 'hook_execution', 'hook_run_started', 'subagent_progress', 'subagent_finished',
]);

const CANCELLED = { outcome: { outcome: 'cancelled' } } as const;
const selected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });

class EventQueue {
  private items: EngineEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(e: EngineEvent): void {
    if (this.ended) return;
    this.items.push(e);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<EngineEvent> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** One `ps` run; null when it fails (the sweep is then skipped). */
function listProcesses(): Promise<GrokProcEntry[] | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const out: GrokProcEntry[] = [];
      for (const line of String(stdout).split('\n')) {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) out.push({ pid: pid!, ppid: ppid!, pgid: pgid! });
      }
      resolve(out);
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); });

/** `GROK_HOME/sessions/*\/<id>/updates.jsonl`, only when its real path stays under `GROK_HOME/sessions` (§14.4). */
async function sessionUpdatesFile(grokHome: string, sessionId: string): Promise<string | null> {
  const root = await fs.realpath(path.join(grokHome, 'sessions')).catch(() => null);
  if (!root) return null;
  for (const group of await fs.readdir(root).catch(() => [] as string[])) {
    const file = path.join(root, group, sessionId, 'updates.jsonl');
    const real = await fs.realpath(file).catch(() => null);
    if (real && real.startsWith(root + path.sep)) return real;
  }
  return null;
}

async function sessionStamp(grokHome: string, sessionId: string): Promise<GrokSessionStamp | null> {
  const file = await sessionUpdatesFile(grokHome, sessionId);
  const st = file ? await fs.stat(file).catch(() => null) : null;
  return st ? { size: st.size, mtimeMs: st.mtimeMs } : null;
}

class GrokTurn {
  private readonly t: GrokTimeouts;
  private readonly lock: GrokLock;
  private readonly engineLock: GrokEngineLock;
  private readonly stamps: Map<string, GrokSessionStamp>;
  private readonly log: (msg: string) => void;
  private readonly cancelAc = new AbortController();
  private child: ChildLike | null = null;
  private exited = false;
  private exitCode: number | null = null;
  private spawnError: string | null = null;
  private exitP: Promise<void> = Promise.resolve();
  private stderrTail = '';
  private conn: AcpConnection | null = null;
  private sessionId: string | null;
  private cwd = '';
  private realHome = '';
  private text = '';
  private usage: TurnUsage = ZERO_USAGE;
  /** `_x.ai/billing` read after the prompt answered; rides the result for the usage card (absent when it failed). */
  private billing: GrokBilling | null = null;
  /** The result, pushed only after the group has ended (so an end-of-turn notice still comes before it). */
  private final: EngineResult | null = null;
  /** Lock releases: the start key, plus (home, id) once a new session has its id. */
  private readonly releases: Array<() => void> = [];
  /** deck cancelled (■, consumer gone): always wins the end-of-turn classification. */
  private cancelled = false;
  /** The tripwire fired (§14.9-3): its text replaces any other result. */
  private tripped: string | null = null;
  private cancelSent = false;
  private promptInFlight = false;
  private promptAnswered = false;
  /** A PromptResponse line actually came (promptAnswered is also set when the request fails or the connection closes). */
  private promptResponded = false;
  private configOptions: ConfigOption[] = [];
  private actualModel: string | null = null;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private sampler: ReturnType<typeof setInterval> | null = null;
  private readonly tools = new Map<string, ToolState>();
  /** toolCallIds a permission request was seen for (any session). */
  private readonly asked = new Set<string>();
  /** toolCallIds deck answered allow-once (§14.9-3): an asked id that runs without being in here is a leak too. */
  private readonly allowed = new Set<string>();
  /** Subagent sessions of this turn (`subagent_spawned`). */
  private readonly children = new Set<string>();
  private readonly openPerms = new Set<() => void>();
  private readonly loggedKinds = new Set<string>();
  /** cancellationCategory values of deck's prompt (never of an interject-fallback turn). */
  private readonly categories: string[] = [];
  private fallbackCancelled = false;
  /** One request per steer id; a repeated call gets the first call's outcome. */
  private readonly steers = new Map<string, Promise<boolean>>();
  /** Descendants seen while the turn ran (§14.9-9). */
  private readonly seenPids = new Set<number>();
  private readonly seenPgids = new Set<number>();
  private serverPgid: number | null = null;

  constructor(private readonly req: GrokTurnRequest, private readonly deps: GrokDeps, private readonly q: EventQueue) {
    this.t = { ...GROK_TIMEOUTS, ...deps.timeouts };
    this.lock = deps.lock ?? grokLock;
    this.engineLock = deps.engineLock ?? grokEngineLock;
    this.stamps = deps.sessionStamps ?? grokSessionStamps;
    this.log = deps.log ?? ((m) => console.warn(m));
    this.sessionId = req.resumeSessionId;
  }

  private result(ok: boolean, errorText: string | null, extra: Partial<EngineResult> = {}): EngineResult {
    return {
      kind: 'result', sessionId: this.sessionId, ok, text: ok ? this.text : '', usage: this.usage,
      errorText: ok ? null : errorText, stderr: null, errorKind: null, terminalReason: ok ? 'completed' : null, ...extra,
    };
  }

  private finish(r: EngineResult): void {
    if (this.final) return;
    this.final = r;
  }

  private aborted(): EngineResult {
    return this.result(false, GROK_TEXT.aborted, { terminalReason: 'aborted' });
  }

  /** True while deck's prompt is running and nothing has stopped it: the only time a permission request gets a card. */
  private get active(): boolean {
    return this.promptInFlight && !this.promptAnswered && !this.cancelled && this.tripped === null;
  }

  /** session/cancel for the prompt (once), then the PromptResponse gets cancelMs before the connection is dropped (§14.5). */
  private sendCancel(): void {
    const conn = this.conn;
    if (this.cancelSent || !this.promptInFlight || this.promptAnswered || !conn || !this.sessionId) return;
    this.cancelSent = true;
    conn.notify('session/cancel', { sessionId: this.sessionId }).catch(() => {});
    this.cancelTimer = setTimeout(() => conn.close('no PromptResponse after session/cancel'), this.t.cancelMs);
  }

  /** Turn abort (deck ■, consumer gone): open requests are answered cancelled, then session/cancel (§14.9-6). */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const close of [...this.openPerms]) close();
    this.cancelAc.abort();
    this.sendCancel();
  }

  /** §14.9-3: stop the turn and lock the engine. Works at any point (before, during or after the prompt). */
  private trip(reason: string, text: string): void {
    if (this.tripped !== null) return;
    this.tripped = text;
    this.log(`deck: grok tripwire: ${reason}`);
    this.engineLock.lock(reason);
    for (const close of [...this.openPerms]) close();
    this.cancelAc.abort();
    this.sendCancel();
  }

  async run(): Promise<void> {
    try {
      await this.start();
    } finally {
      const r = this.tripped !== null
        ? this.result(false, this.tripped, { errorKind: 'grok_tripwire', text: this.text })
        : this.final;
      if (r) this.q.push(this.billing ? { ...r, grokBilling: this.billing } : r);
    }
  }

  private async start(): Promise<void> {
    const req = this.req;
    if (req.signal.aborted) { this.finish(this.aborted()); return; }
    if (req.resumeSessionId !== null && !GROK_SESSION_ID_RE.test(req.resumeSessionId)) {
      this.finish(this.result(false, '잘못된 세션 ID 형식'));
      return;
    }
    const locked = this.engineLock.reason;
    if (locked !== null) { this.finish(this.result(false, grokEngineLockedText(locked), { errorKind: 'grok_engine_locked' })); return; }
    if (req.permissionMode === 'plan') { this.finish(this.result(false, GROK_TEXT.planUnsupported, { errorKind: 'permission_mode' })); return; }
    let grokHomeReal: string;
    try { grokHomeReal = await fs.realpath(this.deps.grokHome); } catch { grokHomeReal = path.resolve(this.deps.grokHome); }
    this.realHome = await fs.realpath(this.deps.realHome).catch(() => path.resolve(this.deps.realHome));
    try {
      this.releases.push(await this.lock.acquire(grokLockKey(grokHomeReal, req.resumeSessionId, randomUUID()), { timeoutMs: this.t.lockMs, signal: this.cancelAc.signal }));
    } catch (e) {
      if (e instanceof GrokLockTimeoutError) this.finish(this.result(false, e.message, { errorKind: 'grok_locked' }));
      else this.finish(this.aborted());
      return;
    }
    let shadow: ShadowHome | null = null;
    try {
      try { this.cwd = await fs.realpath(req.cwd); } catch (e) {
        this.finish(this.result(false, `작업 폴더를 열 수 없음: ${(e as Error).message}`));
        return;
      }
      if ((await findGrokProjectConfig(this.cwd, grokHomeReal, this.realHome)) !== null) {
        this.finish(this.result(false, GROK_TEXT.projectBlocked, { errorKind: 'grok_project_config' }));
        return;
      }
      try {
        shadow = await createShadowHome({ root: this.deps.homesDir, realHome: this.realHome, links: GROK_SHADOW_LINKS });
      } catch (e) {
        const msg = e instanceof ShadowHomeError ? e.message : (e as Error).message;
        this.finish(this.result(false, `${GROK_TEXT.shadowHomeFailed} — ${msg}`, { errorKind: 'grok_shadow_home' }));
        return;
      }
      const env = grokEnv(this.deps.baseEnv ?? process.env, grokHomeReal, shadow.path);
      if (!(await this.inspect(env))) return;
      if (this.cancelled) { this.finish(this.aborted()); return; }
      if (req.resumeSessionId) {
        const before = this.stamps.get(`${grokHomeReal}\0${req.resumeSessionId}`);
        const now = before ? await sessionStamp(grokHomeReal, req.resumeSessionId) : null;
        if (before && (!now || now.size !== before.size || now.mtimeMs !== before.mtimeMs)) this.q.push({ kind: 'notice', message: GROK_TEXT.externallyModified });
      }
      try {
        await this.drive(env, grokHomeReal);
      } catch (e) {
        this.finish(await this.errorResult(e));
      } finally {
        await this.readBilling();
        await this.endGroup();
      }
    } finally {
      if (shadow) await shadow.remove();
      if (this.sessionId && this.child) {
        const key = `${grokHomeReal}\0${this.sessionId}`;
        const stamp = await sessionStamp(grokHomeReal, this.sessionId).catch(() => null);
        if (stamp) this.stamps.set(key, stamp);
        else this.stamps.delete(key);
      }
      for (const release of this.releases.splice(0).reverse()) release();
    }
  }

  /**
   * The subscription's usage on the connection the turn already has: after the prompt answered, before stdin closes. One
   * short request; any failure (Method not found on an older grok, a time-out, a closed connection) is ignored.
   */
  private async readBilling(): Promise<void> {
    const conn = this.conn;
    if (!conn || conn.isClosed || this.exited || !this.promptResponded || this.cancelled || this.tripped !== null) return;
    try {
      this.billing = parseGrokBilling(await conn.request(GROK_BILLING_METHOD, {}, this.t.billingMs), Date.now());
    } catch { /* billing is extra: the turn's result does not depend on it */ }
  }

  /** §14.9-2: `grok inspect --json` with the turn's env, cwd and shadow HOME; anything but a clean answer refuses. */
  private async inspect(env: Record<string, string>): Promise<boolean> {
    let json: unknown;
    try {
      json = await this.deps.inspect(env, this.cwd);
    } catch (e) {
      this.finish(this.result(false, redactSecrets(`${GROK_TEXT.inspectFailed} — ${(e as Error)?.message ?? String(e)}`), { errorKind: 'grok_inspect' }));
      return false;
    }
    const v = await checkGrokInspect(json, this.deps.readConfig);
    if (!v.ok) {
      this.finish(this.result(false, grokInspectRefusal(v.item), { errorKind: 'grok_inspect' }));
      return false;
    }
    return true;
  }

  private spawn(env: Record<string, string>): ChildLike {
    const spawnFn: SpawnFn = this.deps.spawnFn
      ?? ((b, args, o) => nodeSpawn(b, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }));
    const child = spawnFn(this.deps.bin, [...GROK_AGENT_ARGS], { cwd: this.cwd, env });
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer | string) => { this.stderrTail = (this.stderrTail + String(chunk)).slice(-GROK_STDERR_MAX); });
    this.exitP = new Promise<void>((resolve) => {
      child.once('exit', (code: number | null) => { this.exited = true; this.exitCode = code; resolve(); });
      child.once('error', (err: Error) => { this.exited = true; this.spawnError = err.message; resolve(); });
    });
    if (child.pid !== undefined) {
      void this.sample();
      this.sampler = setInterval(() => { void this.sample(); }, this.t.sampleMs);
      this.sampler.unref?.();
    }
    return child;
  }

  private async drive(env: Record<string, string>, grokHome: string): Promise<void> {
    const req = this.req;
    const child = this.spawn(env);
    if (!child.stdout || !child.stdin) throw new Error('grok: no stdio pipes');
    const conn = new AcpConnection(child.stdout, child.stdin);
    this.conn = conn;
    // Our process ending also ends the connection, even if the agent's stdout is held open by a grandchild.
    void this.exitP.then(() => setTimeout(() => conn.close('agent exited'), 200).unref?.());
    conn.onRequest('session/request_permission', (p) => this.onPermissionRequest(p));
    conn.onNotification((method, params) => this.onNotification(method, params));
    const sig = this.cancelAc.signal;

    // initialize: no fs / terminal capability (omitted = unsupported in ACP) — the agent handles files and shell itself (§2-3).
    const init = (await conn.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, this.t.initializeMs, sig)) as Rec | null;
    this.observeModelState(init?._meta);
    const promptCaps = rec(rec(init?.agentCapabilities)?.promptCapabilities) ?? {};
    const attachments = req.attachments ?? [];
    const images = attachments.filter((a) => a.isImage);
    if (images.length && promptCaps.image !== true) {
      this.finish(this.result(false, GROK_TEXT.imageUnsupported));
      return;
    }

    // Session: load never falls back to new, and the prompt is never resent (§2-4).
    let sess: Rec | null;
    if (req.resumeSessionId) {
      sess = (await conn.request('session/load', {
        sessionId: req.resumeSessionId, cwd: this.cwd, mcpServers: [], _meta: { ...SESSION_META, noReplay: true },
      }, this.t.sessionMs, sig)) as Rec | null;
    } else {
      sess = (await conn.request('session/new', { cwd: this.cwd, mcpServers: [], _meta: { ...SESSION_META } }, this.t.sessionMs, sig)) as Rec | null;
      const id = str(sess?.sessionId);
      if (!id || !GROK_SESSION_ID_RE.test(id)) { this.finish(this.result(false, 'Grok 이 올바른 세션 ID 를 주지 않음')); return; }
      this.sessionId = id;
      // The start key was temporary: from here a resumed turn on this id must wait for this one (released at the end).
      try {
        this.releases.push(await this.lock.acquire(grokLockKey(grokHome, id, ''), { timeoutMs: this.t.lockMs, signal: this.cancelAc.signal }));
      } catch (e) {
        if (e instanceof GrokLockTimeoutError) { this.finish(this.result(false, e.message, { errorKind: 'grok_locked' })); return; }
        throw new AcpAbortError('lock');
      }
      await req.onSessionId?.(id);
    }
    const sessionId = this.sessionId!;
    // grok 1.0.62 sends no `modes`; one that reports a mode other than default is not a session deck can gate.
    const modes = rec(sess?.modes);
    if (modes && modes.currentModeId !== undefined && modes.currentModeId !== 'default') {
      this.finish(this.result(false, GROK_TEXT.modeUnconfirmed, { errorKind: 'permission_mode' }));
      return;
    }
    this.observeModelState(sess?._meta);
    this.observeConfig(sess?.configOptions);

    // Settings: model and effort (notice only). No mode is ever set (§14.1).
    if (req.model !== GROK_DEFAULT_MODEL) {
      const r = await this.setConfig(sessionId, 'model', req.model);
      if (r !== 'ok') this.q.push({ kind: 'notice', message: `Grok 모델을 ${req.model} 로 정하지 못함 — ${this.actualModel ?? '기본 모델'} 로 진행` });
    }
    const effort = await this.setConfig(sessionId, 'thought_level', GROK_EFFORT[req.effort]);
    if (effort === 'missing') this.log('deck: grok: no thought_level config option; effort left at the model default');
    else if (effort !== 'ok') this.q.push({ kind: 'notice', message: GROK_TEXT.effortUnsupported });
    if (this.cancelled || this.tripped !== null) throw new AcpAbortError('settings');
    this.q.push({ kind: 'init', sessionId, model: this.actualModel ?? req.model });

    // Prompt.
    const blocks: Rec[] = [{ type: 'text', text: promptWithFiles(req.prompt, attachments) }];
    for (const img of images) blocks.push({ type: 'image', mimeType: img.mediaType, data: (await fs.readFile(img.path)).toString('base64') });
    // Nothing awaited between this check and the send: an abort or a trip during the reads above stops here.
    if (this.cancelled || this.tripped !== null) throw new AcpAbortError('session/prompt');
    this.promptInFlight = true;
    // Marked answered the moment the response line is read: content after it is not this turn's (§2-7).
    const promptP = conn.request('session/prompt', { sessionId, prompt: blocks }, { onResponse: () => { this.promptAnswered = true; this.promptResponded = true; } });
    req.onLive?.({ send: async () => false, steer: (f, id) => this.steer(f, id) });
    let resp: Rec | null;
    try {
      resp = (await promptP) as Rec | null;
    } finally {
      this.promptAnswered = true;
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
      this.closeOpenTools();
    }
    const meta = rec(resp?._meta);
    this.usage = usageOf(meta);
    const cat = str(meta?.cancellationCategory);
    if (cat) this.categories.push(cat);
    const stopReason = str(resp?.stopReason);
    // §14.9-7: a category may come after the PromptResponse; give it a moment.
    if (stopReason === 'cancelled' && !this.cancelled && this.categories.length === 0) await this.waitFor(() => this.categories.length > 0, this.t.categoryMs);
    // A steer queued right as the turn ended becomes Grok's own interject-fallback turn: watch for it to cancel it.
    if (this.steers.size > 0) await this.waitFor(() => this.fallbackCancelled, this.t.fallbackMs);
    this.finishPrompt(stopReason);
  }

  private async waitFor(cond: () => boolean, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (!cond() && Date.now() < until && !this.exited) await sleep(20);
  }

  private finishPrompt(stopReason: string | null): void {
    if (this.cancelled) { this.finish(this.aborted()); return; }
    switch (stopReason) {
      case 'end_turn':
        this.finish(this.result(true, null));
        return;
      case 'cancelled':
        this.finish(this.stopped());
        return;
      case 'max_tokens':
        this.q.push({ kind: 'notice', message: GROK_TEXT.maxTokens });
        this.finish(this.result(true, null, { terminalReason: 'max_tokens' }));
        return;
      case 'max_turn_requests':
        this.q.push({ kind: 'notice', message: GROK_TEXT.maxTurnRequests });
        this.finish(this.result(true, null, { terminalReason: 'max_turn_requests' }));
        return;
      case 'refusal':
        this.finish(this.result(false, GROK_TEXT.refusal, { errorKind: 'refusal', terminalReason: 'refusal' }));
        return;
      default:
        this.q.push({ kind: 'notice', message: `Grok 종료 이유를 모름: ${stopReason ?? '없음'}` });
        this.finish(this.result(true, null));
    }
  }

  /** §14.9-7: a cancel deck did not ask for. MidTurnAbort counts as aborted; the permission ones keep the output. */
  private stopped(): EngineResult {
    const cats = this.categories;
    if (cats.includes('MidTurnAbort')) return this.aborted();
    const text = cats.includes('PermissionRejected') ? GROK_TEXT.stopRejected
      : cats.includes('PermissionCancelled') ? GROK_TEXT.stopCancelled
        : GROK_TEXT.stopUnknown;
    if (text === GROK_TEXT.stopUnknown) this.log(`deck: grok: cancelled turn with category ${JSON.stringify(cats.slice(0, 3))}`);
    return this.result(false, text, { errorKind: 'grok_stopped', text: this.text, terminalReason: 'cancelled' });
  }

  private async errorResult(e: unknown): Promise<EngineResult> {
    // After a cancel, whatever the agent answers (an RPC error included) is the abort.
    if (e instanceof AcpAbortError || this.cancelled) return this.aborted();
    if (e instanceof AcpRpcError) {
      switch (classifyGrokError(e)) {
        case 'auth':
          return this.result(false, GROK_TEXT.notLoggedIn, { errorKind: 'authentication_failed' });
        case 'rate_limit':
          this.q.push({ kind: 'rate_limit', info: { status: 'rejected', fiveHour: null, weekly: null } });
          return this.result(false, GROK_TEXT.rateLimit, { errorKind: 'rate_limit' });
        case 'overloaded':
          this.q.push({ kind: 'notice', message: GROK_TEXT.overloaded });
          return this.result(false, GROK_TEXT.overloaded, { errorKind: 'overloaded' });
        default:
          return this.result(false, redactSecrets(`Grok 오류 (${e.code}): ${e.message}`));
      }
    }
    if (e instanceof AcpTimeoutError) return this.result(false, `Grok 응답 없음 (${e.method})`);
    // The process went away (or never started): wait briefly for its exit so stderr and the code are known.
    await Promise.race([this.exitP, sleep(1000)]);
    const stderr = this.stderrTail ? redactSecrets(this.stderrTail) : null;
    if (this.spawnError !== null) return this.result(false, `grok 실행 실패: ${this.spawnError}`, { stderr });
    if (e instanceof AcpClosedError) return this.result(false, this.exited ? `grok 종료 코드 ${this.exitCode ?? '?'}` : `Grok 연결 오류: ${e.message}`, { stderr });
    return this.result(false, redactSecrets(`Grok 오류: ${(e as Error)?.message ?? String(e)}`), { stderr });
  }

  /**
   * Descendants of the agent, found by following ppid in one `ps` table (only processes whose parent chain is still
   * intact). Their pids and pgids are kept for the end-of-turn sweep (§14.9-9); returns those that left the group.
   */
  private async sample(): Promise<number[]> {
    const root = this.child?.pid;
    if (root === undefined || this.exited) return [];
    const table = await (this.deps.listProcesses ?? listProcesses)().catch(() => null);
    if (!table) return [];
    const byParent = new Map<number, GrokProcEntry[]>();
    for (const e of table) {
      byParent.set(e.ppid, [...(byParent.get(e.ppid) ?? []), e]);
      if (e.pid === process.pid) this.serverPgid = e.pgid;
    }
    const out: number[] = [];
    const seen = new Set<number>([root]);
    const stack = [root];
    while (stack.length) {
      for (const e of byParent.get(stack.pop()!) ?? []) {
        if (seen.has(e.pid) || e.pid <= 1 || e.pid === process.pid) continue;
        seen.add(e.pid);
        stack.push(e.pid);
        this.seenPids.add(e.pid);
        if (e.pgid !== root) { this.seenPgids.add(e.pgid); out.push(e.pid); }
      }
    }
    return out;
  }

  /**
   * §2-7 / §14.5: close stdin, give the group closeMs to end on its own, then SIGTERM, then SIGKILL — the whole group
   * plus descendants that left it. Then every process group a descendant was seen in gets SIGKILL (§14.9-9). Whatever
   * survives is reported, and the lock is released anyway (waiting for it forever would block the session).
   */
  private async endGroup(): Promise<void> {
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    const child = this.child;
    if (!child) { this.conn?.close('turn ended'); return; }
    const pid = child.pid;
    const strays = new Set<number>();
    // Collected while the agent is still alive: once it exits, its children's ppid no longer leads back to it.
    const collect = async () => { for (const p of await this.sample()) strays.add(p); };
    await collect();
    if (this.sampler) clearInterval(this.sampler);
    try { child.stdin?.end(); } catch { /* already closed */ }
    try {
      if (pid === undefined) { await Promise.race([this.exitP, sleep(this.t.killMs)]); return; }
      const gone = async (ms: number): Promise<boolean> => {
        const until = Date.now() + ms;
        for (;;) {
          if (this.exited && !groupAlive(pid) && [...strays].every((p) => !pidAlive(p))) return true;
          if (Date.now() >= until) return false;
          await sleep(25);
        }
      };
      const kill = (sig: NodeJS.Signals) => {
        try { process.kill(-pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
        for (const p of strays) { try { process.kill(p, sig); } catch { /* gone */ } }
      };
      // A tripped turn, or an aborted one whose PromptResponse never came, goes straight to the group kill (§14.5, §14.9-3).
      const graceful = this.tripped === null && (!this.cancelled || this.promptResponded);
      let ended = false;
      if (graceful) {
        ended = await gone(this.t.closeMs);
        if (!ended) await collect();
      }
      if (!ended) {
        kill('SIGTERM');
        ended = await gone(this.t.termMs);
      }
      if (!ended) {
        await collect();
        kill('SIGKILL');
        if (!(await gone(this.t.killMs))) {
          this.log(`deck: grok process group ${pid} (or a descendant) still alive after SIGKILL; lock released anyway`);
          this.q.push({ kind: 'notice', message: GROK_TEXT.leftoverProcesses });
        }
      }
      await this.reap(pid);
    } finally {
      this.conn?.close('turn ended');
    }
  }

  /**
   * §14.9-9: SIGKILL every process group a descendant was seen in (never the server's own), then log survivors. A fresh
   * process table is read first: a group is killed only while a process in it is one of the descendants seen (a group
   * id can be reused by an unrelated process once ours are gone). No table = no group kill.
   */
  private async reap(root: number): Promise<void> {
    const groups = [...this.seenPgids].filter((g) => !(g <= 1 || g === root || g === process.pid || g === this.serverPgid));
    if (groups.length) {
      const table = await (this.deps.listProcesses ?? listProcesses)().catch(() => null);
      if (!table) this.log('deck: grok sweep skipped: the process table could not be read');
      for (const g of table ? groups : []) {
        if (!table!.some((e) => e.pgid === g && this.seenPids.has(e.pid))) continue;
        try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    const left = [...this.seenPids].filter((p) => pidAlive(p));
    if (left.length) this.log(`deck: grok descendants still present after the sweep: ${left.slice(0, 10).join(', ')}`);
  }

  // --- settings --------------------------------------------------------------------------------------------------

  /** `session/set_config_option` on the option of `category`; 'ok' only when the agent reports `value` back. */
  private async setConfig(sessionId: string, category: string, value: string): Promise<'ok' | 'missing' | 'unsupported' | 'mismatch' | 'error'> {
    const opt = this.configOptions.find((o) => o.category === category && o.type === 'select');
    if (!opt) return 'missing';
    if (!opt.values.includes(value)) return 'unsupported';
    if (opt.currentValue === value) return 'ok';
    try {
      const res = (await this.conn!.request('session/set_config_option', { sessionId, configId: opt.id, value }, this.t.settingMs, this.cancelAc.signal)) as Rec | null;
      this.observeConfig(res?.configOptions);
    } catch (e) {
      if (e instanceof AcpAbortError) throw e;
      return 'error';
    }
    return this.configOptions.find((o) => o.id === opt.id)?.currentValue === value ? 'ok' : 'mismatch';
  }

  /** grok's `_meta.modelState.currentModelId` (initialize / session responses, grok 1.0.62): the model actually used. */
  private observeModelState(meta: unknown): void {
    const id = str(rec(rec(meta)?.modelState)?.currentModelId);
    if (id) this.actualModel = id;
  }

  private observeConfig(x: unknown): void {
    const opts = parseConfigOptions(x);
    if (!opts) return;
    this.configOptions = opts;
    for (const o of opts) {
      if (o.category === 'model' && typeof o.currentValue === 'string') this.actualModel = o.currentValue;
      if (o.category === 'mode' && typeof o.currentValue === 'string') this.observeMode(o.currentValue);
    }
  }

  /** §14.9-3: Grok's mode is deck's gate; any mode but default (plan included) trips. */
  private observeMode(id: string): void {
    if (id !== 'default') this.trip(`Grok 권한 모드가 ${JSON.stringify(id.slice(0, 40))} 로 바뀜`, GROK_TEXT.modeChanged);
  }

  // --- notifications ----------------------------------------------------------------------------------------------

  private onNotification(method: string, params: unknown): void {
    const p = rec(params);
    if (!p) return;
    switch (method) {
      case 'session/update':
        this.onUpdate(p);
        return;
      case '_x.ai/session_notification': {
        const u = rec(p.update);
        if (!u) return;
        if (u.sessionUpdate === 'subagent_spawned') {
          const parent = str(u.parent_session_id);
          const child = str(u.child_session_id);
          if (child && parent && (parent === this.sessionId || this.children.has(parent))) this.children.add(child);
        } else if (u.sessionUpdate === 'turn_completed' && p.sessionId === this.sessionId) {
          this.onTurnSignal(str(u.prompt_id), str(rec(p._meta)?.cancellationCategory));
        }
        return;
      }
      case '_x.ai/session/prompt_complete':
        if (p.sessionId === this.sessionId) this.onTurnSignal(str(p.promptId), str(p.cancellationCategory));
        return;
      case '_x.ai/queue/changed':
        if (p.sessionId === this.sessionId) this.onTurnSignal(str(p.runningPromptId), null);
        return;
      default:
    }
  }

  /** A turn's prompt id (and its cancellationCategory): deck's prompt's are collected, a fallback turn is cancelled. */
  private onTurnSignal(promptId: string | null, category: string | null): void {
    if (promptId?.startsWith(FALLBACK_PREFIX)) { this.cancelFallback(promptId); return; }
    if (category && this.promptInFlight) this.categories.push(category);
  }

  /** §14.4: a turn Grok started on its own from a late interject is not a deck turn — cancel it, log only. */
  private cancelFallback(promptId: string): void {
    if (this.fallbackCancelled || !this.promptAnswered || !this.conn || !this.sessionId) return;
    this.fallbackCancelled = true;
    this.log(`deck: grok started its own turn ${JSON.stringify(promptId.slice(0, 80))} from a late interject; cancelled`);
    this.conn.notify('session/cancel', { sessionId: this.sessionId }).catch(() => {});
  }

  private onUpdate(p: Rec): void {
    const u = rec(p.update);
    if (!u) return;
    // §14.4: replayed history (before the load response) is never this turn's.
    if (rec(p._meta)?.isReplay === true) return;
    const sid = str(p.sessionId);
    const kind = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : '';
    if (kind === 'tool_call' || kind === 'tool_call_update') { if (sid) this.onToolCall(sid, u, kind === 'tool_call'); return; }
    if (kind === 'current_mode_update') { if (typeof u.currentModeId === 'string') this.observeMode(u.currentModeId); return; }
    if (kind === 'config_option_update') { if (sid === this.sessionId) this.observeConfig(u.configOptions); return; }
    // Content belongs to the parent session's running prompt only.
    if (!this.sessionId || sid !== this.sessionId || !this.promptInFlight || this.promptAnswered) return;
    switch (kind) {
      case 'agent_message_chunk': {
        const c = rec(u.content) ?? {};
        if (c.type === 'text' && typeof c.text === 'string' && c.text) { this.text += c.text; this.q.push({ kind: 'delta', text: c.text }); }
        return;
      }
      case 'agent_thought_chunk': {
        const c = rec(u.content) ?? {};
        if (c.type === 'text' && typeof c.text === 'string' && c.text) this.q.push({ kind: 'thinking', text: c.text });
        return;
      }
      default:
        if (IGNORED_UPDATES.has(kind)) return;
        if (!this.loggedKinds.has(kind)) {
          this.loggedKinds.add(kind);
          this.log(`deck: grok: unknown session/update kind ${JSON.stringify(kind.slice(0, 64))}`);
        }
    }
  }

  private shownName(st: ToolState): string {
    return `grok:${st.xaiName ?? effectiveKind(st)}`;
  }

  /**
   * §3 / §14.4: per-toolCallId state for every session (the tripwire needs subagents too); updates merge (only fields
   * present change). Events go out only for the parent session's running prompt; the first terminal status yields one result.
   */
  private onToolCall(sessionId: string, u: Rec, create: boolean): void {
    const id = str(u.toolCallId);
    if (!id) return;
    let st = this.tools.get(id);
    if (!st) {
      st = {
        id, sessionId, kind: null, xaiName: null, xaiKind: null, title: '', status: 'pending', content: [], rawInput: undefined,
        locations: undefined, notRun: false, shown: false, resulted: false, checked: false,
      };
      this.tools.set(id, st);
    }
    this.merge(st, u);
    const ours = sessionId === this.sessionId && this.promptInFlight && !this.promptAnswered;
    if (ours && !st.shown && (create || st.kind !== null)) {
      st.shown = true;
      this.q.push({ kind: 'tool_call', toolUseId: id, name: this.shownName(st), input: normInput(st.rawInput) });
    }
    // Asked but not allowed (denied, cancelled, rejected outside the prompt, or still unanswered) and yet running.
    if ((st.status === 'in_progress' || st.status === 'completed') && this.asked.has(id) && !this.allowed.has(id)) {
      this.trip(`${this.shownName(st)} (${effectiveKind(st)}) ran (${st.status}) though deck did not allow it${sessionId === this.sessionId ? '' : ' in a subagent'}`, GROK_TEXT.tripwire);
    }
    if ((st.status === 'in_progress' || isTerminal(st.status)) && !st.checked) {
      st.checked = true;
      if (!this.asked.has(id) && !st.notRun) {
        void this.req.onToolAudit?.({ toolName: this.shownName(st), input: normInput(st.rawInput), toolUseId: id, decision: 'allow', source: 'cli' })?.catch(() => {});
        if (isTripwire(effectiveKind(st), st.xaiName, st.rawInput)) {
          this.trip(`${this.shownName(st)} (${effectiveKind(st)}) ran with no permission request${sessionId === this.sessionId ? '' : ' in a subagent'}`, GROK_TEXT.tripwire);
        }
      }
    }
    if (st.shown && isTerminal(st.status) && !st.resulted && ours) {
      st.resulted = true;
      this.q.push({ kind: 'tool_result', toolUseId: id, content: contentText(st.content).slice(0, TOOL_RESULT_MAX), isError: st.status === 'failed' });
    }
  }

  private merge(st: ToolState, u: Rec): void {
    if (typeof u.kind === 'string' && u.kind) st.kind = u.kind;
    if (typeof u.title === 'string') st.title = u.title;
    if (Array.isArray(u.content)) st.content = u.content;
    if (u.rawInput !== undefined && u.rawInput !== null) st.rawInput = u.rawInput;
    if (u.locations !== undefined) st.locations = u.locations;
    const meta = rec(u._meta);
    const xai = rec(meta?.['x.ai/tool']);
    if (xai) {
      st.xaiName = str(xai.name) ?? st.xaiName;
      st.xaiKind = str(xai.kind) ?? st.xaiKind;
    }
    if (typeof u.status === 'string' && u.status) {
      st.status = u.status;
      // A tool Grok reports as not run (rejected, or blocked by its own auto mode) did nothing.
      if (u.status === 'failed' && (meta?.toolNotRun !== undefined || /was not executed/.test(contentText(st.content)))) st.notRun = true;
    }
  }

  /** §14.4: tools of this turn still open when the prompt ends get one error result. */
  private closeOpenTools(): void {
    for (const st of this.tools.values()) {
      if (!st.shown || st.resulted) continue;
      st.resulted = true;
      this.q.push({ kind: 'tool_result', toolUseId: st.id, content: this.cancelled ? GROK_TEXT.aborted : GROK_TEXT.noResult, isError: true });
    }
  }

  // --- session/request_permission (§4.2, §14.1-3, §14.9-5/6) ------------------------------------------------------

  private async onPermissionRequest(params: unknown): Promise<unknown> {
    const p = rec(params) ?? {};
    const tc = rec(p.toolCall) ?? {};
    const id = str(tc.toolCallId);
    // Marked before anything is awaited. A status update for this id counts as allowed only once deck answered allow-once.
    if (id) this.asked.add(id);
    if (this.cancelled || this.tripped !== null) return CANCELLED;
    const options = (Array.isArray(p.options) ? p.options : []).filter((o): o is Rec => !!o && typeof o === 'object');
    const optionOf = (kind: string) => str(options.find((o) => o.kind === kind && typeof o.optionId === 'string')?.optionId);
    const allowOnce = optionOf('allow_once');
    const rejectOnce = optionOf('reject_once');
    const requester = str(rec(tc._meta)?.['x.ai/requestingSessionId']) ?? str(p.sessionId);
    const known = requester !== null && (requester === this.sessionId || this.children.has(requester));
    // Outside deck's running prompt, or from a session this turn does not know: no card.
    if (!this.active || p.sessionId !== this.sessionId || !known) return rejectOnce ? selected(rejectOnce) : CANCELLED;
    const st = id ? this.tools.get(id) : undefined;
    const kind = str(tc.kind) ?? st?.kind ?? 'other';
    const baseTitle = str(tc.title) ?? st?.title ?? '';
    const title = requester === this.sessionId ? baseTitle : `${GROK_TEXT.subagent}${baseTitle ? ` · ${baseTitle}` : ''}`;
    const pr: PermissionRequest = {
      toolName: `grok:${kind}`,
      input: normInput(tc.rawInput ?? st?.rawInput),
      toolUseId: id ?? `grok-permission-${randomUUID()}`,
      title,
    };

    let closeCard!: () => void;
    const closed = new Promise<'closed'>((r) => { closeCard = () => r('closed'); });
    const cardAc = new AbortController();
    const close = () => { cardAc.abort(); closeCard(); };
    this.openPerms.add(close);
    const editAuto = () => (this.req.editAuto ? this.req.editAuto() : this.req.permissionMode === 'acceptEdits');
    const allow = (optionId: string) => { if (id) this.allowed.add(id); return selected(optionId); };
    try {
      // 자동 승인: allow_once only, only for known kinds, never plan exit / mode widening (those kinds are not listed).
      // Both automatic paths re-read the live mode and the turn state right before answering.
      if (allowOnce && isGrokAutoApprovable(pr.toolName) && this.req.autoApprove?.()) {
        await Promise.race([this.req.onAutoApproved?.(pr).catch(() => {}), closed]);
        if (!this.active) return CANCELLED;
        if (this.req.autoApprove?.()) return allow(allowOnce);
      } else if (allowOnce && kind === 'edit' && editAuto()) {
        const ok = await Promise.race([editAutoAllowed({ cwd: this.cwd, home: this.realHome, toolCall: tc, known: st }).catch(() => false), closed]);
        if (!this.active) return CANCELLED;
        if (ok === true && editAuto()) {
          await Promise.race([this.req.onAutoApproved?.(pr).catch(() => {}), closed]);
          if (!this.active) return CANCELLED;
          if (editAuto()) return allow(allowOnce);
        }
      }
      const decision = await Promise.race([this.req.onPermission({ ...pr, signal: cardAc.signal }).catch((): PermissionDecision => 'deny'), closed]);
      if (decision === 'closed' || !this.active) return CANCELLED;
      // 'session' has no Grok equivalent in v1 (no suggestions are offered): it counts as once. allow_always never.
      if (decision === 'deny') return rejectOnce ? selected(rejectOnce) : CANCELLED;
      return allowOnce ? allow(allowOnce) : CANCELLED;
    } finally {
      this.openPerms.delete(close);
      cardAc.abort();
    }
  }

  // --- steer (§14.4, §14.9-8) -------------------------------------------------------------------------------------

  private steer(f: FollowUp, id: string): Promise<boolean> {
    // The same id is never sent twice (Grok does not de-duplicate): a repeated call shares the first call's outcome.
    const first = this.steers.get(id);
    if (first) return first;
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (!this.active || f.attachments.length > 0 || !conn || !sessionId) return Promise.resolve(false);
    const p = (async () => {
      let r: Rec | null;
      try {
        r = rec(await conn.request(GROK_INTERJECT_METHOD, { sessionId, text: f.text, interjectionId: id }, this.t.steerMs));
      } catch {
        return false;
      }
      const status = r?.status ?? rec(r?.result)?.status;
      // Queued after the PromptResponse is too late for this turn (Grok would start its own turn; that one is cancelled).
      if (status !== 'queued' || !this.active) return false;
      this.q.push({ kind: 'steer_delivered', id });
      this.q.push({ kind: 'notice', message: GROK_TEXT.steerQueued });
      return true;
    })();
    this.steers.set(id, p);
    return p;
  }
}

/**
 * One Grok turn. Exactly one `result` comes last, after the process group has ended. When the consumer stops iterating
 * early, the turn is cancelled and this does not return until the agent's process group is gone and the lock is free.
 */
export async function* runGrokTurn(req: GrokTurnRequest, deps: GrokDeps): AsyncGenerator<EngineEvent> {
  const q = new EventQueue();
  const turn = new GrokTurn(req, deps, q);
  const onAbort = () => turn.cancel();
  req.signal.addEventListener('abort', onAbort, { once: true });
  const done = turn.run().catch((e: unknown) => {
    q.push({
      kind: 'result', sessionId: req.resumeSessionId, ok: false, text: '', usage: ZERO_USAGE,
      errorText: redactSecrets(`Grok 오류: ${(e as Error)?.message ?? String(e)}`), stderr: null, errorKind: null, terminalReason: null,
    });
  }).finally(() => q.end());
  try {
    yield* q.drain();
  } finally {
    req.signal.removeEventListener('abort', onAbort);
    turn.cancel();
    await done;
  }
}
