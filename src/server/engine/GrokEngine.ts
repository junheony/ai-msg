import { randomUUID } from 'node:crypto';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import type { Effort } from '../../shared/models';
import { ZERO_USAGE, type PermissionDecision } from '../../shared/turn-types';
import { promptWithFiles, type Attachment } from '../attachments/AttachmentStore';
import { AcpAbortError, AcpClosedError, AcpConnection, AcpRpcError, AcpTimeoutError } from './acp/AcpConnection';
import type { ChildLike, SpawnFn } from './CodexEngine';
import type { EngineEvent, EngineResult, FollowUp, LiveInput, PermissionRequest } from './Engine';
import { grokEnv } from './grokEnv';
import { GrokLock, GrokLockTimeoutError, grokLock, grokLockKey } from './grokLock';
import { GROK_PROJECT_BLOCKED_TEXT, findGrokProjectConfig } from './grokProjectGuard';
import { redactSecrets } from './redact';

/**
 * Grok Build CLI over ACP (`grok agent stdio`), design docs/superpowers/specs/2026-10-18-grok-engine-design.md.
 * One deck turn = one agent process in its own process group: lock → spawn → initialize → session/new|load →
 * permission mode (fail-closed), model, effort → session/prompt → close stdin → group ends → unlock.
 * Wire shapes follow the ACP v1 spec (agentclientprotocol.com/protocol/v1); Grok-specific parts are marked with the
 * spike item (S#) that will confirm them.
 */

type Rec = Record<string, unknown>;

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
  noResult: '(결과 없음)',
  subagent: '하위 에이전트',
  effortUnsupported: '이 Grok 모델은 effort 설정을 받지 않음',
  aborted: '중단됨',
  leftoverProcesses: 'Grok 이 띄운 프로세스 일부가 남아 있음',
} as const;

export type GrokTurnRequest = {
  account: Account;
  /** The session's canonical cwd; realpath'd again before spawn. */
  cwd: string;
  /** Grok session id; null starts a new session. */
  resumeSessionId: string | null;
  /** `grok` = Grok's default (nothing sent); anything else → `session/set_config_option` on the model option. */
  model: string;
  effort: Effort;
  permissionMode: GrokPermissionMode;
  prompt: string;
  attachments?: Attachment[];
  signal: AbortSignal;
  /** 모두 자동 승인: consulted per permission request; never for the exceptions in §4.2. */
  autoApprove?: () => boolean;
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
  /** After set_mode: how long to wait for the confirming current_mode_update (S10). */
  modeConfirmMs: number;
  /** session/cancel → PromptResponse(cancelled). */
  cancelMs: number;
  /** stdin closed → the group ends on its own (history flush; S4 에서 조정). */
  closeMs: number;
  /** group SIGTERM → SIGKILL. */
  termMs: number;
  /** after SIGKILL, how long to wait before giving up (logged). */
  killMs: number;
  steerMs: number;
};

export const GROK_TIMEOUTS: GrokTimeouts = {
  lockMs: 30_000, initializeMs: 15_000, sessionMs: 30_000, settingMs: 10_000, modeConfirmMs: 1_000,
  cancelMs: 5_000, closeMs: 10_000, termMs: 3_000, killMs: 2_000, steerMs: 10_000,
};

export type GrokDeps = {
  bin: string;
  /** The seat's GROK_HOME, given by deck (never inherited from the shell). */
  grokHome: string;
  spawnFn?: SpawnFn;
  baseEnv?: NodeJS.ProcessEnv;
  lock?: GrokLock;
  timeouts?: Partial<GrokTimeouts>;
  log?: (msg: string) => void;
  /** Process table for the end-of-turn sweep (tests); default runs `ps` once, null = skip. */
  listProcesses?: () => Promise<GrokProcEntry[] | null>;
};

export type GrokProcEntry = { pid: number; ppid: number; pgid: number };

/** §8: stderr kept for an abnormal exit. */
export const GROK_STDERR_MAX = 4096;
/** §3: a tool_result body is the merged content text, cut here. */
export const TOOL_RESULT_MAX = 32 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Permission mode (§2-5, §4.1). S10 에서 확정: method, mode ids and how the agent confirms are the ACP standard
// `session/set_mode { sessionId, modeId }` (empty response) confirmed by `current_mode_update` or a mode-category
// config option. Kept here so S10 can swap to `session/set_config_option` without touching the rest.

export const GROK_MODE_ID: Record<GrokPermissionMode, string> = { default: 'default', acceptEdits: 'acceptEdits', plan: 'plan' };
export const GROK_SET_MODE_METHOD = 'session/set_mode';
export function grokSetModeParams(sessionId: string, modeId: string): Rec {
  return { sessionId, modeId };
}

/** §4.2: permission kinds 자동 승인 may answer before S1·S10 pin the real request shapes; anything else gets a card. */
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

/** §7 steer: S7 에서 확정 — until an echo carrying the interjectionId is seen, delivery = the interject ACK. */
export const GROK_INTERJECT_METHOD = 'x.ai/interject';

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
  kind: string;
  title: string;
  status: string;
  content: unknown[];
  rawInput: unknown;
  resulted: boolean;
  audited: boolean;
};

type ConfigOption = { id: string; category: string | null; type: string; currentValue: unknown; values: string[] };

const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const isTerminal = (s: string) => s === 'completed' || s === 'failed';

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
    if (!o || typeof o !== 'object') continue;
    const r = o as Rec;
    const id = str(r.id);
    if (!id) continue;
    const values: string[] = [];
    const walk = (opts: unknown) => {
      if (!Array.isArray(opts)) return;
      for (const v of opts) {
        if (!v || typeof v !== 'object') continue;
        const e = v as Rec;
        if (typeof e.value === 'string') values.push(e.value);
        else if (Array.isArray(e.options)) walk(e.options);
      }
    };
    walk(r.options);
    out.push({ id, category: str(r.category), type: str(r.type) ?? 'select', currentValue: r.currentValue, values });
  }
  return out;
}

function isReplayed(meta: unknown): boolean {
  return !!meta && typeof meta === 'object' && (meta as Rec)['x.ai/replayed'] !== undefined && (meta as Rec)['x.ai/replayed'] !== false;
}

/** Kinds the mapper knows and drops on purpose (v1); anything else is logged once per kind. */
const IGNORED_UPDATES = new Set(['plan', 'user_message_chunk', 'available_commands_update', 'session_info_update', 'usage_update']);

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

class GrokTurn {
  private readonly t: GrokTimeouts;
  private readonly lock: GrokLock;
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
  private text = '';
  private resultSent = false;
  /** The result, pushed only after the group has ended (so an end-of-turn notice still comes before it). */
  private final: EngineResult | null = null;
  /** Lock releases: the start key, plus (home, id) once a new session has its id. */
  private readonly releases: Array<() => void> = [];
  private cancelled = false;
  private cancelReason: 'abort' | 'mode' = 'abort';
  private promptInFlight = false;
  private promptDone = false;
  private promptAnswered = false;
  private settingsDone = false;
  private targetMode: string;
  private currentMode: string | null = null;
  private configOptions: ConfigOption[] = [];
  private actualModel: string | null = null;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly tools = new Map<string, ToolState>();
  private readonly permissionAsked = new Set<string>();
  private readonly openPerms = new Set<() => void>();
  private readonly loggedKinds = new Set<string>();
  /** One request per steer id; a repeated call gets the first call's outcome. */
  private readonly steers = new Map<string, Promise<boolean>>();

  constructor(private readonly req: GrokTurnRequest, private readonly deps: GrokDeps, private readonly q: EventQueue) {
    this.t = { ...GROK_TIMEOUTS, ...deps.timeouts };
    this.lock = deps.lock ?? grokLock;
    this.log = deps.log ?? ((m) => console.warn(m));
    this.sessionId = req.resumeSessionId;
    this.targetMode = GROK_MODE_ID[req.permissionMode];
  }

  private result(ok: boolean, errorText: string | null, extra: Partial<EngineResult> = {}): EngineResult {
    return {
      kind: 'result', sessionId: this.sessionId, ok, text: ok ? this.text : '', usage: ZERO_USAGE,
      errorText: ok ? null : errorText, stderr: null, errorKind: null, terminalReason: ok ? 'completed' : null, ...extra,
    };
  }

  private finish(r: EngineResult): void {
    if (this.resultSent) return;
    this.resultSent = true;
    this.final = r;
  }

  private aborted(): EngineResult {
    if (this.cancelReason === 'mode') return this.result(false, GROK_TEXT.modeChanged, { errorKind: 'permission_mode' });
    return this.result(false, GROK_TEXT.aborted, { terminalReason: 'aborted' });
  }

  /** Turn abort (deck ■, consumer gone) or a mid-turn mode change: cancel first, then let the phases wind down (§4.2, §7). */
  cancel(reason: 'abort' | 'mode'): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelReason = reason;
    for (const close of [...this.openPerms]) close();
    this.cancelAc.abort();
    const conn = this.conn;
    if (this.promptInFlight && !this.promptAnswered && conn && this.sessionId) {
      conn.notify('session/cancel', { sessionId: this.sessionId }).catch(() => {});
      this.cancelTimer = setTimeout(() => conn.close('no PromptResponse after session/cancel'), this.t.cancelMs);
    }
  }

  async run(): Promise<void> {
    try {
      await this.start();
    } finally {
      if (this.final) this.q.push(this.final);
    }
  }

  private async start(): Promise<void> {
    const req = this.req;
    if (req.signal.aborted) { this.finish(this.aborted()); return; }
    if (req.resumeSessionId !== null && !GROK_SESSION_ID_RE.test(req.resumeSessionId)) {
      this.finish(this.result(false, '잘못된 세션 ID 형식'));
      return;
    }
    let grokHomeReal: string;
    try { grokHomeReal = await fs.realpath(this.deps.grokHome); } catch { grokHomeReal = path.resolve(this.deps.grokHome); }
    try {
      this.releases.push(await this.lock.acquire(grokLockKey(grokHomeReal, req.resumeSessionId, randomUUID()), { timeoutMs: this.t.lockMs, signal: this.cancelAc.signal }));
    } catch (e) {
      if (e instanceof GrokLockTimeoutError) this.finish(this.result(false, e.message, { errorKind: 'grok_locked' }));
      else this.finish(this.aborted());
      return;
    }
    try {
      let cwd: string;
      try { cwd = await fs.realpath(req.cwd); } catch (e) {
        this.finish(this.result(false, `작업 폴더를 열 수 없음: ${(e as Error).message}`));
        return;
      }
      if ((await findGrokProjectConfig(cwd, grokHomeReal)) !== null) {
        this.finish(this.result(false, GROK_TEXT.projectBlocked, { errorKind: 'grok_project_config' }));
        return;
      }
      if (this.cancelled) { this.finish(this.aborted()); return; }
      try {
        await this.drive(cwd, grokHomeReal);
      } catch (e) {
        this.finish(await this.errorResult(e));
      } finally {
        await this.endGroup();
      }
    } finally {
      for (const release of this.releases.splice(0).reverse()) release();
    }
  }

  private spawn(cwd: string, grokHome: string): ChildLike {
    const spawnFn: SpawnFn = this.deps.spawnFn
      ?? ((b, args, o) => nodeSpawn(b, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }));
    const child = spawnFn(this.deps.bin, [...GROK_AGENT_ARGS], { cwd, env: grokEnv(this.deps.baseEnv ?? process.env, grokHome) });
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer | string) => { this.stderrTail = (this.stderrTail + String(chunk)).slice(-GROK_STDERR_MAX); });
    this.exitP = new Promise<void>((resolve) => {
      child.once('exit', (code: number | null) => { this.exited = true; this.exitCode = code; resolve(); });
      child.once('error', (err: Error) => { this.exited = true; this.spawnError = err.message; resolve(); });
    });
    return child;
  }

  private async drive(cwd: string, grokHome: string): Promise<void> {
    const req = this.req;
    const child = this.spawn(cwd, grokHome);
    if (!child.stdout || !child.stdin) throw new Error('grok: no stdio pipes');
    const conn = new AcpConnection(child.stdout, child.stdin);
    this.conn = conn;
    // Our process ending also ends the connection, even if the agent's stdout is held open by a grandchild.
    void this.exitP.then(() => setTimeout(() => conn.close('agent exited'), 200).unref?.());
    conn.onRequest('session/request_permission', (p) => this.onPermissionRequest(p));
    conn.onNotification((method, params) => { if (method === 'session/update') this.onUpdate(params); });
    const sig = this.cancelAc.signal;

    // initialize: no fs / terminal capability (omitted = unsupported in ACP) — the agent handles files and shell itself (§2-3).
    const init = (await conn.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, this.t.initializeMs, sig)) as Rec | null;
    this.observeModelState(init?._meta);
    const caps = (init?.agentCapabilities && typeof init.agentCapabilities === 'object' ? init.agentCapabilities : {}) as Rec;
    const promptCaps = (caps.promptCapabilities && typeof caps.promptCapabilities === 'object' ? caps.promptCapabilities : {}) as Rec;
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
        sessionId: req.resumeSessionId, cwd, mcpServers: [], _meta: { noReplay: true },
      }, this.t.sessionMs, sig)) as Rec | null;
    } else {
      sess = (await conn.request('session/new', { cwd, mcpServers: [] }, this.t.sessionMs, sig)) as Rec | null;
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
    const modes = (sess?.modes && typeof sess.modes === 'object' ? sess.modes : null) as Rec | null;
    if (modes && typeof modes.currentModeId === 'string') this.currentMode = modes.currentModeId;
    this.observeModelState(sess?._meta);
    this.observeConfig(sess?.configOptions);

    // Settings: permission mode first, fail-closed (§2-5); then model and effort (notice only).
    if (!(await this.setPermissionMode(sessionId))) {
      this.finish(this.result(false, GROK_TEXT.modeUnconfirmed, { errorKind: 'permission_mode' }));
      return;
    }
    if (req.model !== GROK_DEFAULT_MODEL) {
      const r = await this.setConfig(sessionId, 'model', req.model);
      if (r !== 'ok') this.q.push({ kind: 'notice', message: `Grok 모델을 ${req.model} 로 정하지 못함 — ${this.actualModel ?? '기본 모델'} 로 진행` });
    }
    // S3 에서 확정: grok 1.0.62 lists efforts per model in `_meta.modelState`, not (yet seen) as a thought_level option.
    // With no such option deck cannot tell support from absence, so only the server log hears of it.
    const effort = await this.setConfig(sessionId, 'thought_level', GROK_EFFORT[req.effort]);
    if (effort === 'missing') this.log('deck: grok: no thought_level config option; effort left at the model default');
    else if (effort !== 'ok') this.q.push({ kind: 'notice', message: GROK_TEXT.effortUnsupported });
    if (this.cancelled) throw new AcpAbortError('settings');
    this.settingsDone = true;
    this.q.push({ kind: 'init', sessionId, model: this.actualModel ?? req.model });

    // Prompt.
    const blocks: Rec[] = [{ type: 'text', text: promptWithFiles(req.prompt, attachments) }];
    for (const img of images) blocks.push({ type: 'image', mimeType: img.mediaType, data: (await fs.readFile(img.path)).toString('base64') });
    // Last checks with nothing awaited before the send: an abort during the reads above, and a mode changed by a
    // model/effort answer or update after set_mode was confirmed (recorded even before settingsDone).
    if (this.cancelled) throw new AcpAbortError('session/prompt');
    if (this.currentMode !== this.targetMode) {
      this.finish(this.result(false, GROK_TEXT.modeUnconfirmed, { errorKind: 'permission_mode' }));
      return;
    }
    this.promptInFlight = true;
    // Marked answered the moment the response line is read: updates after it are dropped (§2-7).
    const promptP = conn.request('session/prompt', { sessionId, prompt: blocks }, { onResponse: () => { this.promptAnswered = true; this.promptDone = true; } });
    req.onLive?.({ send: async () => false, steer: (f, id) => this.steer(f, id) });
    let resp: Rec | null;
    try {
      resp = (await promptP) as Rec | null;
    } finally {
      this.promptDone = true;
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
      this.flushTools();
    }
    this.finishPrompt(str(resp?.stopReason));
  }

  private finishPrompt(stopReason: string | null): void {
    switch (stopReason) {
      case 'end_turn':
        this.finish(this.cancelled ? this.aborted() : this.result(true, null));
        return;
      case 'cancelled':
        this.finish(this.aborted());
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
        this.finish(this.cancelled ? this.aborted() : this.result(true, null));
    }
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
   * Descendants of `root` that left its process group (setsid), found by following ppid in one `ps` table. Only
   * processes whose parent chain is still intact can be found. S12 에서 확인: what Grok really leaves behind.
   */
  private async strays(root: number): Promise<number[]> {
    const table = await (this.deps.listProcesses ?? listProcesses)().catch(() => null);
    if (!table) return [];
    const byParent = new Map<number, GrokProcEntry[]>();
    for (const e of table) byParent.set(e.ppid, [...(byParent.get(e.ppid) ?? []), e]);
    const out: number[] = [];
    const seen = new Set<number>([root]);
    const stack = [root];
    while (stack.length) {
      for (const e of byParent.get(stack.pop()!) ?? []) {
        if (seen.has(e.pid) || e.pid <= 1 || e.pid === process.pid) continue;
        seen.add(e.pid);
        stack.push(e.pid);
        if (e.pgid !== root) out.push(e.pid);
      }
    }
    return out;
  }

  /**
   * §2-7: close stdin, give the group closeMs to end on its own, then SIGTERM, then SIGKILL — the whole group plus
   * descendants that left it (S12 에서 확인). Whatever survives SIGKILL is reported, and the lock is released anyway
   * (waiting for it forever would block the session).
   */
  private async endGroup(): Promise<void> {
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.conn?.close('turn ended');
    const child = this.child;
    if (!child) return;
    const pid = child.pid;
    const strays = new Set<number>();
    // Collected while the agent is still alive: once it exits, its children's ppid no longer leads back to it.
    const collect = async () => { if (pid !== undefined && !this.exited) for (const p of await this.strays(pid)) strays.add(p); };
    await collect();
    try { child.stdin?.end(); } catch { /* already closed */ }
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
    // An aborted turn whose PromptResponse never came goes straight to the group kill (§7).
    const graceful = !this.cancelled || this.promptAnswered;
    if (graceful) {
      if (await gone(this.t.closeMs)) return;
      await collect();
    }
    kill('SIGTERM');
    if (await gone(this.t.termMs)) return;
    await collect();
    kill('SIGKILL');
    if (!(await gone(this.t.killMs))) {
      this.log(`deck: grok process group ${pid} (or a descendant) still alive after SIGKILL; lock released anyway`);
      this.q.push({ kind: 'notice', message: GROK_TEXT.leftoverProcesses });
    }
  }

  // --- settings --------------------------------------------------------------------------------------------------

  /** S10 에서 확정 — see GROK_SET_MODE_METHOD. True only when the agent itself reports the requested mode. */
  private async setPermissionMode(sessionId: string): Promise<boolean> {
    const want = this.targetMode;
    if (this.currentMode === want) return true;
    const conn = this.conn!;
    try {
      const res = (await conn.request(GROK_SET_MODE_METHOD, grokSetModeParams(sessionId, want), this.t.settingMs, this.cancelAc.signal)) as Rec | null;
      // SetSessionModeResponse is `{ _meta? }` in ACP v1; tolerate an agent that also returns the new state.
      const modes = (res?.modes && typeof res.modes === 'object' ? res.modes : null) as Rec | null;
      if (modes && typeof modes.currentModeId === 'string') this.currentMode = modes.currentModeId;
      this.observeConfig(res?.configOptions);
    } catch (e) {
      if (e instanceof AcpAbortError) throw e;
      return false;
    }
    const until = Date.now() + this.t.modeConfirmMs;
    while (this.currentMode !== want && Date.now() < until && !this.cancelled) await sleep(20);
    if (this.cancelled) throw new AcpAbortError(GROK_SET_MODE_METHOD);
    return this.currentMode === want;
  }

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
    const ms = meta && typeof meta === 'object' ? (meta as Rec).modelState : null;
    const id = ms && typeof ms === 'object' ? str((ms as Rec).currentModelId) : null;
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

  /** §3: once the turn runs, a mode change is shown, and a mode other than deck's cancels the turn. */
  private observeMode(id: string): void {
    const prev = this.currentMode;
    this.currentMode = id;
    if (!this.settingsDone || this.promptDone || prev === id) return;
    this.q.push({ kind: 'notice', message: `Grok 권한 모드가 바뀜: ${id}` });
    if (id !== this.targetMode) this.cancel('mode');
  }

  // --- session/update ---------------------------------------------------------------------------------------------

  private onUpdate(params: unknown): void {
    if (this.promptDone || !params || typeof params !== 'object') return;
    const p = params as Rec;
    const u = (p.update && typeof p.update === 'object' ? p.update : null) as Rec | null;
    if (!u) return;
    // Another session's updates (a subagent's own session, S5) are dropped.
    // Once the session is known, an update without its id is dropped too.
    if (this.sessionId && p.sessionId !== this.sessionId) return;
    if (isReplayed(p._meta) || isReplayed(u._meta)) return;
    const kind = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : '';
    // Content belongs to the prompt: anything before it is dropped; mode/config updates are always observed.
    if (!this.promptInFlight && (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call' || kind === 'tool_call_update')) return;
    switch (kind) {
      case 'agent_message_chunk': {
        const c = (u.content && typeof u.content === 'object' ? u.content : {}) as Rec;
        if (c.type === 'text' && typeof c.text === 'string' && c.text) { this.text += c.text; this.q.push({ kind: 'delta', text: c.text }); }
        return;
      }
      case 'agent_thought_chunk': {
        const c = (u.content && typeof u.content === 'object' ? u.content : {}) as Rec;
        if (c.type === 'text' && typeof c.text === 'string' && c.text) this.q.push({ kind: 'thinking', text: c.text });
        return;
      }
      case 'tool_call':
        this.onToolCall(u, true);
        return;
      case 'tool_call_update':
        this.onToolCall(u, false);
        return;
      case 'current_mode_update':
        if (typeof u.currentModeId === 'string') this.observeMode(u.currentModeId);
        return;
      case 'config_option_update':
        this.observeConfig(u.configOptions);
        return;
      default:
        if (IGNORED_UPDATES.has(kind)) return;
        if (!this.loggedKinds.has(kind)) {
          this.loggedKinds.add(kind);
          this.log(`deck: grok: unknown session/update kind ${JSON.stringify(kind.slice(0, 64))}`);
        }
    }
  }

  private toolName(st: { kind: string }): string {
    return `grok:${st.kind}`;
  }

  /** §3: per-toolCallId state; updates merge (only fields present change); the first terminal status yields one result. */
  private onToolCall(u: Rec, create: boolean): void {
    const id = str(u.toolCallId);
    if (!id) return;
    let st = this.tools.get(id);
    if (!st) {
      // An update for a call never announced (a subagent's child, S5) is dropped.
      if (!create) return;
      st = { id, kind: 'other', title: '', status: 'pending', content: [], rawInput: undefined, resulted: false, audited: false };
      this.tools.set(id, st);
      this.merge(st, u);
      this.q.push({ kind: 'tool_call', toolUseId: id, name: this.toolName(st), input: normInput(st.rawInput) });
    } else {
      this.merge(st, u);
    }
    if ((st.status === 'in_progress' || isTerminal(st.status)) && !st.audited) {
      st.audited = true;
      if (!this.permissionAsked.has(id)) {
        void this.req.onToolAudit?.({ toolName: this.toolName(st), input: normInput(st.rawInput), toolUseId: id, decision: 'allow', source: 'cli' })?.catch(() => {});
      }
    }
    if (isTerminal(st.status) && !st.resulted) {
      st.resulted = true;
      this.q.push({ kind: 'tool_result', toolUseId: id, content: contentText(st.content).slice(0, TOOL_RESULT_MAX), isError: st.status === 'failed' });
    }
  }

  private merge(st: ToolState, u: Rec): void {
    if (typeof u.kind === 'string' && u.kind) st.kind = u.kind;
    if (typeof u.title === 'string') st.title = u.title;
    if (typeof u.status === 'string' && u.status) st.status = u.status;
    if (Array.isArray(u.content)) st.content = u.content;
    if (u.rawInput !== undefined && u.rawInput !== null) st.rawInput = u.rawInput;
  }

  /** §3: tools still open when the turn ends get one error result. */
  private flushTools(): void {
    for (const st of this.tools.values()) {
      if (st.resulted) continue;
      st.resulted = true;
      this.q.push({ kind: 'tool_result', toolUseId: st.id, content: GROK_TEXT.noResult, isError: true });
    }
  }

  // --- session/request_permission (§4.2) --------------------------------------------------------------------------

  private async onPermissionRequest(params: unknown): Promise<unknown> {
    // Cancel first: after an abort, after the PromptResponse, or before the settings are done (a folder-trust or
    // other start-up request), every request is answered cancelled at once.
    if (this.cancelled || this.promptDone || !this.settingsDone) return CANCELLED;
    const p = (params && typeof params === 'object' ? params : {}) as Rec;
    const tc = (p.toolCall && typeof p.toolCall === 'object' ? p.toolCall : {}) as Rec;
    const options = (Array.isArray(p.options) ? p.options : []).filter((o): o is Rec => !!o && typeof o === 'object');
    const optionOf = (kind: string) => str(options.find((o) => o.kind === kind && typeof o.optionId === 'string')?.optionId);
    const allowOnce = optionOf('allow_once');
    const rejectOnce = optionOf('reject_once');
    const id = str(tc.toolCallId);
    const known = id ? this.tools.get(id) : undefined;
    if (id) this.permissionAsked.add(id);
    const kind = str(tc.kind) ?? known?.kind ?? 'other';
    const baseTitle = str(tc.title) ?? known?.title ?? '';
    const title = known ? baseTitle : `${GROK_TEXT.subagent}${baseTitle ? ` · ${baseTitle}` : ''}`;
    const pr: PermissionRequest = {
      toolName: `grok:${kind}`,
      input: normInput(tc.rawInput ?? known?.rawInput),
      toolUseId: id ?? `grok-permission-${randomUUID()}`,
      title,
    };

    let closeCard!: () => void;
    const closed = new Promise<'closed'>((r) => { closeCard = () => r('closed'); });
    const cardAc = new AbortController();
    const close = () => { cardAc.abort(); closeCard(); };
    this.openPerms.add(close);
    try {
      // 자동 승인: allow_once only, only for known kinds, never plan exit / mode widening (those kinds are not listed).
      if (allowOnce && isGrokAutoApprovable(pr.toolName) && this.req.autoApprove?.()) {
        await Promise.race([this.req.onAutoApproved?.(pr).catch(() => {}), closed]);
        return this.cancelled || this.promptDone ? CANCELLED : selected(allowOnce);
      }
      const decision = await Promise.race([this.req.onPermission({ ...pr, signal: cardAc.signal }).catch((): PermissionDecision => 'deny'), closed]);
      if (decision === 'closed' || this.cancelled || this.promptDone) return CANCELLED;
      // 'session' has no Grok equivalent in v1 (no suggestions are offered): it counts as once. allow_always never.
      if (decision === 'deny') return rejectOnce ? selected(rejectOnce) : CANCELLED;
      return allowOnce ? selected(allowOnce) : CANCELLED;
    } finally {
      this.openPerms.delete(close);
      cardAc.abort();
    }
  }

  // --- steer (§7) -------------------------------------------------------------------------------------------------

  private steer(f: FollowUp, id: string): Promise<boolean> {
    // The same id is never sent twice: a repeated call shares the first call's outcome (pending, true or false).
    const first = this.steers.get(id);
    if (first) return first;
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (this.promptDone || this.resultSent || this.cancelled || f.attachments.length > 0 || !conn || !sessionId) return Promise.resolve(false);
    const p = (async () => {
      try {
        await conn.request(GROK_INTERJECT_METHOD, { sessionId, text: f.text, interjectionId: id }, this.t.steerMs);
      } catch {
        return false;
      }
      // S7 에서 확정: delivered at the ACK. An ACK read after the PromptResponse is too late for this turn.
      if (this.promptDone || this.resultSent) return false;
      this.q.push({ kind: 'steer_delivered', id });
      return true;
    })();
    this.steers.set(id, p);
    return p;
  }
}

/**
 * One Grok turn. Exactly one `result` comes last, after the process group has ended. When the consumer stops iterating early, the turn is cancelled and
 * this does not return until the agent's process group is gone and the lock is free.
 */
export async function* runGrokTurn(req: GrokTurnRequest, deps: GrokDeps): AsyncGenerator<EngineEvent> {
  const q = new EventQueue();
  const turn = new GrokTurn(req, deps, q);
  const onAbort = () => turn.cancel('abort');
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
    turn.cancel('abort');
    await done;
  }
}
