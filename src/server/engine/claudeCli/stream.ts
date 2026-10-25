import { contextUsageOf, type TaskStatus, type TaskUpdate, type TaskUsage, type TurnPhase, type TurnUsage } from '../../../shared/turn-types';
import { systemRow, textOfContent } from '../../sessions/transcript';
import type { BgTask, EngineEvent, EngineResult, RateLimitSignal, TurnRequest } from '../Engine';
import type { SlashCommandInfo } from '../slashCommands';
import type { CliMessage, Rec } from './messages';
import { fastModeKind, fastModeText } from './texts';

/**
 * Which background tasks are live. Prefers the CLI's level signal `background_tasks_changed`
 * (REPLACE semantics, sdk.d.ts SDKBackgroundTasksChangedMessage); falls back to pairing the
 * task_started / task_updated / task_notification bookends for CLIs that never send the level.
 * Ambient tasks (housekeeping, watchers) are not activity and are left out.
 */
export class BackgroundTracker {
  private level: Map<string, string> | null = null;
  private readonly edge = new Map<string, string>();
  private readonly known = new Map<string, string>();
  /** Type and first-seen time per task id (task_started or the level signal, whichever came first). */
  private readonly meta = new Map<string, { type: string; startedAtMs: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private see(id: string, type: unknown): void {
    const m = this.meta.get(id);
    if (!m) this.meta.set(id, { type: typeof type === 'string' ? type : '', startedAtMs: this.now() });
    else if (!m.type && typeof type === 'string') m.type = type;
  }

  /** Feeds one SDK message; true when it was a task message (the set may have changed). */
  apply(m: CliMessage): boolean {
    if (m.type !== 'system') return false;
    const r = m as unknown as Rec;
    const id = typeof r.task_id === 'string' ? r.task_id : '';
    const desc = typeof r.description === 'string' ? r.description : '';
    const ambient = r.ambient === true || r.skip_transcript === true;
    switch (r.subtype) {
      case 'background_tasks_changed': {
        const tasks = Array.isArray(r.tasks) ? (r.tasks as Rec[]) : [];
        for (const t of tasks) if (t.ambient !== true) this.see(String(t.task_id ?? ''), t.task_type);
        this.level = new Map(tasks.filter((t) => t.ambient !== true).map((t) => [String(t.task_id ?? ''), String(t.description ?? '')]));
        return true;
      }
      case 'task_started':
        if (ambient) return true;
        this.see(id, r.task_type);
        this.known.set(id, desc);
        if (r.is_backgrounded === true) this.edge.set(id, desc);
        return true;
      case 'task_updated': {
        const patch = (r.patch ?? {}) as Rec;
        if (patch.is_backgrounded === true && this.known.has(id)) this.edge.set(id, this.known.get(id) ?? '');
        if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'killed') this.edge.delete(id);
        return true;
      }
      case 'task_notification':
        this.edge.delete(id);
        this.known.delete(id);
        return true;
      default:
        return false;
    }
  }

  tasks(): string[] {
    return [...(this.level ?? this.edge).values()];
  }

  /** The live tasks with id, type and start time, in the same order as `tasks()`. */
  detail(): BgTask[] {
    return [...(this.level ?? this.edge)].map(([id, description]) => {
      const m = this.meta.get(id);
      return { id, description, type: m?.type ?? '', startedAtMs: m?.startedAtMs ?? this.now() };
    });
  }
}

/**
 * Main-conversation output tokens of the current deck turn, for the status row: exact
 * `message_delta.usage.output_tokens` per finished API message plus a chars/4 estimate of the one
 * streaming now (text, thinking, tool input) and the CLI's thinking-token estimates. Emits at most
 * every `minGapMs` while streaming, and at once when the phase changes or a message ends. Messages
 * without a `message_start` first (older producers, test doubles) are not metered.
 */
export class ProgressMeter {
  private done = 0;
  private est = 0;
  private phase: TurnPhase | null = null;
  private metering = false;
  private lastEmit = 0;
  private lastValue = -1;

  constructor(private readonly now: () => number = Date.now, private readonly minGapMs = 400) {}

  /** A deck turn ended (result): the next one counts from zero. */
  reset(): void {
    this.done = 0; this.est = 0; this.phase = null; this.metering = false; this.lastValue = -1;
  }

  apply(m: CliMessage): { outputTokens: number; phase: TurnPhase } | null {
    const r = m as unknown as Rec;
    if (m.type === 'system' && r.subtype === 'thinking_tokens' && typeof r.estimated_tokens_delta === 'number') {
      this.metering = true;
      this.est += r.estimated_tokens_delta;
      return this.emit(this.setPhase('thinking'));
    }
    if (m.type !== 'stream_event' || r.parent_tool_use_id !== null) return null;
    const ev = (r.event ?? {}) as Rec;
    switch (ev.type) {
      case 'message_start':
        this.metering = true;
        this.est = 0;
        return null;
      case 'content_block_start': {
        if (!this.metering) return null;
        const t = ((ev.content_block ?? {}) as Rec).type;
        const phase: TurnPhase = t === 'thinking' || t === 'redacted_thinking' ? 'thinking' : t === 'tool_use' || t === 'server_tool_use' ? 'tool' : 'responding';
        return this.emit(this.setPhase(phase));
      }
      case 'content_block_delta': {
        if (!this.metering) return null;
        const d = (ev.delta ?? {}) as Rec;
        const text = typeof d.text === 'string' ? d.text : typeof d.thinking === 'string' ? d.thinking : typeof d.partial_json === 'string' ? d.partial_json : '';
        this.est += text.length / 4;
        return this.emit(false);
      }
      case 'message_delta': {
        if (!this.metering) return null;
        const out = ((ev.usage ?? {}) as Rec).output_tokens;
        if (typeof out === 'number') { this.done += out; this.est = 0; }
        return this.emit(true);
      }
      default:
        return null;
    }
  }

  private setPhase(p: TurnPhase): boolean {
    if (this.phase === p) return false;
    this.phase = p;
    return true;
  }

  private emit(force: boolean): { outputTokens: number; phase: TurnPhase } | null {
    const value = this.done + Math.round(this.est);
    const t = this.now();
    if (!force && (t - this.lastEmit < this.minGapMs || value === this.lastValue)) return null;
    this.lastEmit = t;
    this.lastValue = value;
    return { outputTokens: value, phase: this.phase ?? 'responding' };
  }
}

function taskUsageOf(u: unknown): TaskUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const r = u as Rec;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return { totalTokens: n('total_tokens'), toolUses: n('tool_uses'), durationMs: n('duration_ms') };
}

const PATCH_STATUS: Record<string, TaskStatus> = { pending: 'running', running: 'running', paused: 'running', completed: 'completed', failed: 'failed', killed: 'stopped' };

/** task_started / task_progress / task_updated → one TaskUpdate (ambient housekeeping tasks are left out); null for anything else. */
function taskUpdateOf(r: Rec): TaskUpdate | null {
  if (r.ambient === true || r.skip_transcript === true) return null;
  const taskId = typeof r.task_id === 'string' ? r.task_id : '';
  if (!taskId) return null;
  const toolUseId = typeof r.tool_use_id === 'string' ? r.tool_use_id : null;
  const str = (k: string) => (typeof r[k] === 'string' && r[k] ? { [k]: r[k] as string } : {});
  switch (r.subtype) {
    case 'task_started':
      return {
        taskId, toolUseId, status: 'running',
        ...(typeof r.description === 'string' ? { description: r.description } : {}),
        ...(str('subagent_type').subagent_type ? { subagentType: r.subagent_type as string } : {}),
        ...(str('task_type').task_type ? { taskType: r.task_type as string } : {}),
        ...(typeof r.is_backgrounded === 'boolean' ? { backgrounded: r.is_backgrounded } : {}),
      };
    case 'task_progress': {
      const usage = taskUsageOf(r.usage);
      return {
        // Its `description` is the subagent's current activity ("Reading README.md"), not the task's: left out.
        taskId, toolUseId, status: 'running',
        ...(str('subagent_type').subagent_type ? { subagentType: r.subagent_type as string } : {}),
        ...(usage ? { usage } : {}),
        ...(str('last_tool_name').last_tool_name ? { lastToolName: r.last_tool_name as string } : {}),
        ...(str('summary').summary ? { summary: r.summary as string } : {}),
      };
    }
    case 'task_updated': {
      const patch = (r.patch ?? {}) as Rec;
      const status = typeof patch.status === 'string' ? PATCH_STATUS[patch.status] : undefined;
      const out: TaskUpdate = { taskId, toolUseId };
      if (status) out.status = status;
      if (typeof patch.description === 'string') out.description = patch.description;
      if (typeof patch.is_backgrounded === 'boolean') out.backgrounded = patch.is_backgrounded;
      return out.status || out.description !== undefined || out.backgrounded !== undefined ? out : null;
    }
    default:
      return null;
  }
}

/** A message that means the main conversation is producing output (subagent traffic and replays are not). */
export function isActivity(m: CliMessage): boolean {
  if (m.type === 'result') return true;
  if (m.type !== 'assistant' && m.type !== 'stream_event' && m.type !== 'user') return false;
  const r = m as unknown as Rec;
  return r.parent_tool_use_id === null && r.isReplay !== true;
}

/**
 * The result of a CLI-originated command the model never ran on: origin set and not 'human', no user_message_uuid(s),
 * num_turns 0. Success or error, it is the CLI's own turn, never an answer to anything deck wrote.
 */
export function isInjectedNoopResult(m: CliMessage): boolean {
  if (m.type !== 'result') return false;
  const r = m as unknown as Rec;
  const kind = r.origin && typeof r.origin === 'object' ? (r.origin as Rec).kind : undefined;
  const named = (Array.isArray(r.user_message_uuids) && r.user_message_uuids.length > 0) || typeof r.user_message_uuid === 'string';
  return typeof kind === 'string' && kind !== 'human' && !named && r.num_turns === 0;
}

/** The result of a turn the CLI ran for a background task's notification (origin task-notification), whether the model ran or not. */
export function isNotificationResult(m: CliMessage): boolean {
  if (m.type !== 'result') return false;
  const o = (m as unknown as Rec).origin;
  return !!o && typeof o === 'object' && (o as Rec).kind === 'task-notification';
}

/**
 * Task ids whose notification the CLI folded into the running turn (a queued `priority: 'next'` notification is taken in
 * at a tool boundary, or at a turn's start). With --replay-user-messages the CLI echoes such a queued_command attachment
 * as a replayed main-thread user message, origin task-notification, its text the notification itself
 * (`<task-notification> <task-id>ID</task-id> …`; CLI 2.1.283 bundle: `if(replayUserMessages&&attachment.type===
 * "queued_command") yield Bdr(…)`, text built by `li({taskId,…})`). [] for anything else.
 */
export function foldedNotificationIds(m: CliMessage): string[] {
  if (m.type !== 'user') return [];
  const r = m as unknown as Rec;
  if (r.isReplay !== true || r.parent_tool_use_id !== null) return [];
  const text = textOfContent((m.message as unknown as Rec | undefined)?.content);
  const o = r.origin;
  const fromCli = o && typeof o === 'object' ? (o as Rec).kind === 'task-notification' : text.trimStart().startsWith('<task-notification>');
  if (!fromCli) return [];
  // Only the first: a notification names one task, and later ids may be quoted text inside its result.
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1];
  return id ? [id] : [];
}

/** Where an audited call was decided without deck being asked: 'cli' = the CLI ran or refused it on its own (an allow rule, the mode, or a tool that needs no permission — the SDK does not say which), 'rule' = a deny rule (the SDK says so), 'deck' = deck's own hook. */
export type AuditSource = 'cli' | 'rule' | 'deck';
export type ToolAudit = { handled: Set<string>; report: (e: { tool_name: string; tool_input: unknown; tool_use_id: string }, decision: 'allow' | 'deny', source: AuditSource) => Promise<void> };

/**
 * One process's tool-call audit: each call is reported once — whichever of the hooks, the stream's permission_denied
 * frame or the result's permission_denials sees it first — and never when canUseTool decided it (the caller audits those).
 */
export function toolAudit(req: Pick<TurnRequest, 'onToolAudit'>): ToolAudit {
  const handled = new Set<string>();
  return {
    handled,
    report: async (e, decision, source) => {
      if (handled.has(e.tool_use_id)) return;
      handled.add(e.tool_use_id);
      try {
        await req.onToolAudit?.({ toolName: e.tool_name, input: e.tool_input, toolUseId: e.tool_use_id, decision, source });
      } catch {
        // best-effort, like every audit write: never fails the tool call
      }
    },
  };
}

/**
 * Stream-side audit for tool calls deck was not asked about (allow rule, permission mode, tools
 * that need no permission) — what the PostToolUse/PostToolUseFailure hooks reported before.
 * Error results are held until the turn's `result`, so a denial seen in the meantime
 * (permission_denied frame or permission_denials) is reported instead.
 */
export class ToolTracker {
  private readonly calls = new Map<string, { name: string; input: unknown }>();
  private held: string[] = [];
  constructor(private readonly audit: ToolAudit) {}

  inputOf(id: string): unknown { return this.calls.get(id)?.input ?? null; }

  async apply(m: CliMessage): Promise<void> {
    if (m.type === 'assistant') {
      for (const b of m.message.content) if (b.type === 'tool_use' && typeof b.id === 'string') this.calls.set(b.id, { name: String(b.name ?? ''), input: b.input });
      return;
    }
    if (m.type === 'user' && m.isReplay !== true && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || !this.calls.has(b.tool_use_id)) continue;
        if (b.is_error === true) this.held.push(b.tool_use_id);
        else await this.report(b.tool_use_id);
      }
      return;
    }
    if (m.type === 'result') {
      const held = this.held;
      this.held = [];
      for (const id of held) await this.report(id);
    }
  }

  private async report(id: string): Promise<void> {
    const c = this.calls.get(id);
    this.calls.delete(id);
    if (c) await this.audit.report({ tool_name: c.name, tool_input: c.input, tool_use_id: id }, 'allow', 'cli');
  }
}

/** The denials an SDK message reports: a `system/permission_denied` frame (input from the call's tool_use block), or a result's `permission_denials`. */
export function deniedCalls(m: CliMessage, inputs: Map<string, unknown>): { tool_name: string; tool_input: unknown; tool_use_id: string; source: AuditSource }[] {
  const r = m as unknown as Rec;
  if (m.type === 'system' && r.subtype === 'permission_denied' && typeof r.tool_use_id === 'string' && typeof r.tool_name === 'string') {
    return [{ tool_name: r.tool_name, tool_use_id: r.tool_use_id, tool_input: inputs.get(r.tool_use_id) ?? null, source: r.decision_reason_type === 'rule' ? 'rule' : 'cli' }];
  }
  if (m.type === 'result' && Array.isArray(r.permission_denials)) {
    return (r.permission_denials as Rec[])
      .filter((d) => typeof d.tool_use_id === 'string' && typeof d.tool_name === 'string')
      .map((d) => ({ tool_name: d.tool_name as string, tool_use_id: d.tool_use_id as string, tool_input: d.tool_input ?? inputs.get(d.tool_use_id as string) ?? null, source: 'cli' as const }));
  }
  return [];
}

function isoFromEpochSec(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
}

function windowOf(w: unknown): RateLimitSignal['fiveHour'] {
  if (!w || typeof w !== 'object') return null;
  const u = (w as Rec).utilization;
  if (typeof u !== 'number') return null;
  return { usedPct: Math.round(u * 100), resetsAt: isoFromEpochSec((w as Rec).resetsAt) };
}

/** `rateLimitType` values the SDK declares (sdk.d.ts SDKRateLimitInfo) — fixtures show five_hour; anything else is logged once. */
/** A CLI notification's own text is cut to this many characters in its notice. */
const NOTIFICATION_MAX = 300;
const KNOWN_LIMIT_TYPES = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage']);
const loggedLimitTypes = new Set<string>();

/**
 * What a rate_limit_event says about Fable. Spent (100 %, until `resetsAt`): the account already runs on overage (the
 * plan's limits are used up), or the Opus family's limit (Fable shares it) refuses. A warning on that limit carries its
 * own `utilization` when there is one (a warning can come at ~60 %: not a spent Fable); without one it says nothing.
 */
function fableSpentOf(info: Rec): RateLimitSignal['fiveHour'] {
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
  if (type !== null && !KNOWN_LIMIT_TYPES.has(type) && !loggedLimitTypes.has(type)) {
    loggedLimitTypes.add(type);
    console.warn(`deck: rate_limit_event 의 처음 보는 rateLimitType "${type}" (status ${String(info.status)})`);
  }
  const resetsAt = isoFromEpochSec(info.resetsAt);
  const family = type !== null && /opus|fable/.test(type);
  if (info.isUsingOverage === true || (family && info.status === 'rejected')) return { usedPct: 100, resetsAt };
  if (family && info.status === 'allowed_warning' && typeof info.utilization === 'number') return { usedPct: Math.round(info.utilization * 100), resetsAt };
  return null;
}

function usageOf(u: unknown): TurnUsage {
  const r = (u ?? {}) as Rec;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return { inputTokens: n('input_tokens'), outputTokens: n('output_tokens'), cacheReadTokens: n('cache_read_input_tokens'), cacheCreationTokens: n('cache_creation_input_tokens') };
}

/** result.modelUsage → the largest reported contextWindow (the main model's; subagent models are never larger). */
function windowFromModelUsage(mu: unknown): { contextWindow?: number } {
  if (!mu || typeof mu !== 'object') return {};
  const ws = Object.values(mu as Rec).map((v) => (v && typeof v === 'object' ? (v as Rec).contextWindow : null)).filter((w): w is number => typeof w === 'number' && w > 0);
  return ws.length ? { contextWindow: Math.max(...ws) } : {};
}

/** Pure translation of one CliMessage into zero or more EngineEvents. */
export function mapCliMessage(m: CliMessage): EngineEvent[] {
  switch (m.type) {
    case 'system': {
      if (m.subtype === 'init') return [{ kind: 'init', sessionId: String(m.session_id ?? ''), model: String(m.model ?? ''), ...(typeof m.cwd === 'string' ? { cwd: m.cwd } : {}) }];
      if (m.subtype === 'compact_boundary') return [{ kind: 'compact' }];
      // A CLI notification (fast-mode credits / cooldown, compaction errors, …): a turn note, a fast-mode one with deck's words.
      if (m.subtype === 'notification') {
        const text = (m as Rec).text;
        if (typeof text !== 'string' || !text.trim()) return [];
        // The CLI's own words are shown capped (NOTIFICATION_MAX): a notice is a line, not a log.
        const said = text.trim().length > NOTIFICATION_MAX ? `${text.trim().slice(0, NOTIFICATION_MAX - 1)}…` : text.trim();
        const kind = fastModeKind(text);
        return [kind ? { kind: 'notice', message: `⚡ ${said} — ${fastModeText(kind, false)}`, fast: kind } : { kind: 'notice', message: said }];
      }
      if (m.subtype === 'task_notification') {
        const r = m as Rec;
        const status = r.status === 'failed' || r.status === 'stopped' ? r.status : 'completed';
        const summary = typeof r.summary === 'string' ? r.summary : '';
        if (r.ambient === true || r.skip_transcript === true) return [{ kind: 'task_done', status, summary }];
        const usage = taskUsageOf(r.usage);
        return [{ kind: 'task_done', status, summary, ...(typeof r.task_id === 'string' ? { taskId: r.task_id } : {}), toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : null, ...(usage ? { usage } : {}) }];
      }
      const update = taskUpdateOf(m as unknown as Rec);
      return update ? [{ kind: 'task_update', ...update }] : [];
    }
    case 'stream_event': {
      if (m.parent_tool_use_id !== null) return [];
      const ev = m.event as unknown as Rec;
      if (ev.type === 'content_block_start') {
        const t = ((ev.content_block ?? {}) as Rec).type;
        if (t === 'redacted_thinking') return [{ kind: 'thinking', text: '', redacted: true }];
        return t === 'thinking' ? [{ kind: 'thinking', text: '' }] : [];
      }
      if (ev.type !== 'content_block_delta') return [];
      const delta = ev.delta as Rec | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ kind: 'delta', text: delta.text }];
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') return [{ kind: 'thinking', text: delta.thinking }];
      return [];
    }
    case 'assistant': {
      const blocks = ((m.message as unknown as Rec).content as Rec[] | undefined) ?? [];
      // A subagent's own tool calls ride with the Agent call that spawned it, never into the main transcript.
      if (m.parent_tool_use_id !== null) {
        const parentToolUseId = m.parent_tool_use_id;
        return blocks
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ kind: 'sub_tool_call' as const, parentToolUseId, toolUseId: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input }));
      }
      return blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ kind: 'tool_call' as const, toolUseId: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input }));
    }
    case 'user': {
      // --replay-user-messages echoes what we (or the CLI) already sent; a replayed tool_result must not show twice.
      if ((m as unknown as Rec).isReplay === true) return [];
      const content = (m.message as unknown as Rec).content;
      // A message the harness injected (hook feedback, peer message, task notification…; isSynthetic / isMeta / origin):
      // a system row in the turn, never a user message — or nothing, if it is context for the model only.
      const sys = m.parent_tool_use_id === null && !(Array.isArray(content) && content.some((b) => (b as Rec)?.type === 'tool_result')) ? systemRow(m as unknown as Rec, textOfContent(content)) : null;
      if (sys) return sys === 'hide' ? [] : [{ kind: 'system', ...sys }];
      if (!Array.isArray(content)) return [];
      if (m.parent_tool_use_id !== null) {
        const parentToolUseId = m.parent_tool_use_id;
        return (content as Rec[])
          .filter((b) => b.type === 'tool_result')
          .map((b) => ({ kind: 'sub_tool_result' as const, parentToolUseId, toolUseId: String(b.tool_use_id ?? ''), isError: b.is_error === true }));
      }
      return (content as Rec[])
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({
          kind: 'tool_result' as const,
          toolUseId: String(b.tool_use_id ?? ''),
          content: typeof b.content === 'string' ? b.content : textOfContent(b.content) || JSON.stringify(b.content ?? ''),
          isError: b.is_error === true,
        }));
    }
    case 'rate_limit_event': {
      const info = m.rate_limit_info as unknown as Rec;
      const uw = (info.unifiedWindows ?? {}) as Rec;
      const fable = fableSpentOf(info);
      return [{ kind: 'rate_limit', info: { status: info.status as RateLimitSignal['status'], fiveHour: windowOf(uw.five_hour), weekly: windowOf(uw.seven_day), ...(fable ? { fable } : {}) } }];
    }
    case 'result': {
      const ok = m.subtype === 'success' && !m.is_error;
      let errorText: string | null = null;
      if (!ok) errorText = m.subtype === 'success' ? (m.result ?? '') : [m.subtype, ...(m.errors ?? [])].join(': ');
      const result: EngineResult = { kind: 'result', sessionId: m.session_id, ok, text: ok ? (m.result ?? '') : '', usage: { ...usageOf(m.usage), ...windowFromModelUsage(m.modelUsage) }, errorText, stderr: null, errorKind: null, terminalReason: m.terminal_reason ?? null };
      return [result];
    }
    default:
      return [];
  }
}

/** The composer's `/` menu source: what system/init (`slash_commands`) or `commands_changed` reported. */
export type CommandsListener = (sessionId: string | null, cwd: string, commands: (string | SlashCommandInfo)[], terminal: string[]) => void;

/** system/init or system/commands_changed → onCommands; anything else is ignored. */
export function noteCommands(m: CliMessage, fallbackCwd: string, onCommands: CommandsListener): void {
  if (m.type !== 'system') return;
  const r = m as unknown as Rec;
  const sessionId = typeof r.session_id === 'string' ? r.session_id : null;
  const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : fallbackCwd;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  if (r.subtype === 'init' && Array.isArray(r.slash_commands)) onCommands(sessionId, cwd, strings(r.slash_commands), strings(r.terminal_slash_commands));
  else if (r.subtype === 'commands_changed' && Array.isArray(r.commands)) {
    const list = (r.commands as unknown[]).filter((c): c is SlashCommandInfo => !!c && typeof c === 'object' && typeof (c as Rec).name === 'string');
    onCommands(sessionId, cwd, list, []);
  }
}
