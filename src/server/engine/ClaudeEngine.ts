import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { query, type HookInput, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AccountRegistry } from '../../shared/accounts';
import type { Attachment } from '../attachments/AttachmentStore';
import { ZERO_USAGE, contextUsageOf, type ContextUsage } from '../../shared/turn-types';
import { MODEL_ARG } from '../routing/ModelPolicy';
import { parseQuestions, sessionUpdates, type Engine, type EngineEvent, type LiveInput, type TurnRequest } from './Engine';
import { STDERR_MAX } from './redact';
import type { CliMessage, Rec } from './claudeCli/messages';
import { toUserMessage, type ReadFile } from './claudeCli/prompt';
import { BackgroundTracker as CliBackgroundTracker, ProgressMeter as CliProgressMeter, deniedCalls, isActivity, isInjectedNoopResult, mapCliMessage, noteCommands as noteCliCommands, toolAudit, type CommandsListener, type ToolAudit } from './claudeCli/stream';
export { deniedCalls, toolAudit, toUserMessage };
export type { CommandsListener, ToolAudit, ReadFile };

/** Until Task 8b migrates their tests, the moved helpers keep accepting the SDK's message type (the same objects, typed looser locally). */
type AnyMessage = CliMessage | SDKMessage;
export class BackgroundTracker extends CliBackgroundTracker { override apply(m: AnyMessage): boolean { return super.apply(m as CliMessage); } }
export class ProgressMeter extends CliProgressMeter { override apply(m: AnyMessage) { return super.apply(m as CliMessage); } }
export const mapSdkMessage = (m: AnyMessage): EngineEvent[] => mapCliMessage(m as CliMessage);
export const noteCommands = (m: AnyMessage, fallbackCwd: string, onCommands: CommandsListener): void => noteCliCommands(m as CliMessage, fallbackCwd, onCommands);

export type PromptInput = string | AsyncIterable<SDKUserMessage>;
export type QueryFn = (params: { prompt: PromptInput; options?: Options }) => AsyncIterable<SDKMessage>;

/** D7/D14: the prompt for `query()` — a string without images, else a one-message stream (built by `toUserMessage`). */
export async function buildPrompt(text: string, attachments: Attachment[], readFile: ReadFile = (p) => fs.readFile(p)): Promise<PromptInput> {
  const m = await toUserMessage(text, attachments, readFile);
  if (typeof m.message.content === 'string') return m.message.content;
  const message = m as unknown as SDKUserMessage;
  return (async function* () { yield message; })();
}

/**
 * The process's stdin in streaming-input mode. Open = the CLI stays alive after a result
 * (sdk.d.ts SDKResultMessage: "In single-prompt (non-streaming-input) mode the process exits
 * after the turn" — which is what killed background Agent/Bash tasks).
 */
export class InputChannel implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  closed = false;

  push(m: SDKUserMessage): boolean {
    if (this.closed) return false;
    const w = this.waiter;
    if (w) { this.waiter = null; w({ value: m, done: false }); } else this.queue.push(m);
    return true;
  }

  close(): void {
    this.closed = true;
    const w = this.waiter;
    this.waiter = null;
    w?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiter = resolve; });
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

/** Background waiting caps: total wait after the first result, and how long an emptied set may stay idle. */
export const BG_MAX_MS = 6 * 60 * 60_000;
export const BG_GRACE_MS = 60_000;

/** The handoff-note turn (TurnRequest.noTools): what a denied tool call tells the model. */
export const NO_TOOLS_MESSAGE = '인계 메모 작성 중에는 도구를 쓸 수 없습니다 — 지금까지의 대화만으로 메모를 써 주세요';

/** 계속 계획 on the plan card: what the denied ExitPlanMode call tells the model. */
export const KEEP_PLANNING_MESSAGE = '사용자가 계획을 승인하지 않았습니다 — 계획 모드를 유지하며 계획을 더 다듬어 주세요';

export function buildOptions(
  req: TurnRequest,
  deps: { home: string; accounts: Pick<AccountRegistry, 'env'>; baseEnv: NodeJS.ProcessEnv; abortController: AbortController; onStderr: (s: string) => void; /** false: DECK_STEER=0 (no echo flag). */ steer?: boolean; /** Shared with the stream loop (denials it sees); a fresh one by default. */ audit?: ToolAudit },
): Options {
  // Audit: canUseTool is asked only about calls that need a decision; an allow rule, the mode (acceptEdits) or a tool
  // that needs no permission runs the rest without it. Those are reported from the after-hooks, denials also from the
  // stream (run): the PermissionDenied hook fires only for auto-mode classifier denials, which deck's modes never use.
  const audit = deps.audit ?? toolAudit(req);
  const after = (decision: 'allow' | 'deny') => async (input: HookInput) => {
    if (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure' || input.hook_event_name === 'PermissionDenied') await audit.report(input, decision, 'cli');
    return { continue: true };
  };
  const noTools = async (input: HookInput) => {
    if (input.hook_event_name === 'PreToolUse') await audit.report(input, 'deny', 'deck');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: NO_TOOLS_MESSAGE } };
  };
  // deck's note rides the process's first user prompt only, as that prompt's additionalContext (sdk.d.ts
  // UserPromptSubmitHookSpecificOutput): the system prompt — and so the prompt cache — stays as on every other turn, and
  // follow-ups, continuations and steers into the same process do not get it again.
  let noteSent = false;
  const note = async (input: HookInput) => {
    if (input.hook_event_name !== 'UserPromptSubmit' || noteSent || !req.systemNote) return {};
    noteSent = true;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: req.systemNote } };
  };
  return {
    cwd: req.cwd,
    env: deps.accounts.env(req.account, deps.baseEnv),
    model: MODEL_ARG[req.model],
    // sdk.d.ts Options.effort?: EffortLevel ('low' | 'medium' | 'high' | 'xhigh' | 'max'), "works with adaptive thinking".
    ...(req.effort ? { effort: req.effort } : {}),
    resume: req.resumeSessionId ?? undefined,
    ...(req.forkAt && req.resumeSessionId ? { forkSession: true, resumeSessionAt: req.forkAt } : {}),
    // ~/.claude/settings.json sets defaultMode "auto"; spec §6 wants ask-every-time — unless the session's mode
    // (picker, plan approval, or 이 세션's "allow all edits") says acceptEdits / plan. Never 'bypassPermissions'.
    permissionMode: req.permissionMode ?? 'default',
    // Spec §4.3: hooks, agents, CLAUDE.md from the profile + project.
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    // Echo each user message as the CLI takes it off stdin (isReplay frames carrying our uuid): how a steer is seen
    // reaching the model — at the tool boundary it was folded in at, or at the start of its own turn. null = bare flag.
    ...(deps.steer !== false ? { extraArgs: { 'replay-user-messages': null } } : {}),
    abortController: deps.abortController,
    stderr: deps.onStderr,
    // Review I4: "이 세션" on an earlier turn stored the SDK's own scoped suggestions; they are
    // handed back through the flag-settings layer (`settings`, the --settings equivalent, whose
    // d.ts documents rule syntax such as 'Bash(*)'), so the CLI's own matcher applies them and
    // later turns don't prompt. The layer is session-only: the SDK serializes an object to the
    // `--settings <json>` argv and never writes it to a file (d.ts: applyFlagSettings "only touches
    // the session-scoped flag layer", unlike updateSettings). Chosen over `allowedTools` (documented as bare tool names) and
    // over auto-answering in canUseTool (would mean re-implementing the CLI's rule matching).
    ...(req.allowRules?.length ? { settings: { permissions: { allow: req.allowRules } } } : {}),
    ...(req.allowDirs?.length ? { additionalDirectories: req.allowDirs } : {}),
    hooks: {
      ...(req.noTools ? { PreToolUse: [{ hooks: [noTools] }] } : {}),
      ...(req.systemNote ? { UserPromptSubmit: [{ hooks: [note] }] } : {}),
      PostToolUse: [{ hooks: [after('allow')] }],
      PostToolUseFailure: [{ hooks: [after('allow')] }],
      PermissionDenied: [{ hooks: [after('deny')] }],
    },
    canUseTool: async (toolName, input, ctx) => {
      audit.handled.add(ctx.toolUseID);
      if (req.noTools) return { behavior: 'deny', message: NO_TOOLS_MESSAGE, interrupt: false };
      // D8: AskUserQuestion is not a permission prompt. The answers travel back as updatedInput.answers
      // (sdk-tools.d.ts AskUserQuestionInput.answers: "User answers collected by the permission component").
      if (toolName === 'AskUserQuestion') {
        const questions = parseQuestions(input);
        if (!questions) {
          await req.onQuestionMalformed?.(input);
          return { behavior: 'deny', message: '질문 형식이 올바르지 않습니다', interrupt: false };
        }
        const answers = req.onQuestion ? await req.onQuestion({ toolUseId: ctx.toolUseID, questions, signal: ctx.signal }) : null;
        if (!answers) return { behavior: 'deny', message: '사용자가 답하지 않았습니다', interrupt: false };
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      const pr = {
        toolName,
        input,
        toolUseId: ctx.toolUseID,
        signal: ctx.signal,
        ...(ctx.suggestions ? { suggestions: ctx.suggestions } : {}),
        suppressAlwaysAllowRule: ctx.suppressAlwaysAllowRule === true,
        ...(ctx.title !== undefined ? { title: ctx.title } : {}),
        ...(ctx.decisionReason !== undefined ? { decisionReason: ctx.decisionReason } : {}),
        ...(ctx.blockedPath !== undefined ? { blockedPath: ctx.blockedPath } : {}),
        ...(ctx.defaultToNo !== undefined ? { defaultToNo: ctx.defaultToNo } : {}),
      };
      if (req.autoApprove?.()) {
        await req.onAutoApproved?.(pr);
        return { behavior: 'allow' };
      }
      const decision = await req.onPermission(pr);
      // The plan card: approval also leaves plan mode, into the mode the user picked (Desktop: auto-accept edits vs manually approve).
      if (toolName === 'ExitPlanMode') {
        if (decision === 'deny') return { behavior: 'deny', message: KEEP_PLANNING_MESSAGE, interrupt: false };
        return { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: decision === 'session' ? 'acceptEdits' : 'default', destination: 'session' }] };
      }
      if (decision === 'deny') return { behavior: 'deny', message: '사용자가 거부했습니다', interrupt: false };
      // Only the SDK's own suggestions, sanitized to destination 'session' — never ctx.suggestions
      // verbatim (a localSettings rule would be written to disk) and never a rule of our own.
      if (decision === 'session') {
        const updates = sessionUpdates(pr);
        if (updates.length) return { behavior: 'allow', updatedPermissions: updates };
      }
      return { behavior: 'allow' };
    },
  };
}

export class ClaudeEngine implements Engine {
  private readonly queryFn: QueryFn;
  private readonly home: string;
  private readonly accounts: Pick<AccountRegistry, 'env'>;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly readFile: ReadFile;
  private readonly bgMaxMs: number;
  private readonly bgGraceMs: number;
  private readonly onCommands: CommandsListener | null;
  /** Kill switch (DECK_STEER=0 → false): no `onLive().steer`, no echo flag; follow-ups and per-uuid bookkeeping stay. */
  private readonly steer: boolean;

  constructor(opts: { queryFn?: QueryFn; home?: string; accounts: Pick<AccountRegistry, 'env'>; baseEnv?: NodeJS.ProcessEnv; readFile?: ReadFile; bgMaxMs?: number; bgGraceMs?: number; onCommands?: CommandsListener; steer?: boolean }) {
    this.queryFn = opts.queryFn ?? ((p) => query(p));
    this.home = opts.home ?? os.homedir();
    this.accounts = opts.accounts;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.readFile = opts.readFile ?? ((p) => fs.readFile(p));
    this.bgMaxMs = opts.bgMaxMs ?? BG_MAX_MS;
    this.bgGraceMs = opts.bgGraceMs ?? BG_GRACE_MS;
    this.onCommands = opts.onCommands ?? null;
    this.steer = opts.steer ?? true;
  }

  /**
   * One deck turn = one CLI process in streaming-input mode. The input stays open after a result
   * while background tasks are live: when one settles, the CLI injects its task notification and
   * runs another turn by itself (yielded as `continue` + that turn's events + its result), and
   * `onLive().send` can add user messages. The input closes — and the process ends — after a result
   * with no live background task and no unanswered message, after an emptied set stays idle for
   * `bgGraceMs`, after `bgMaxMs`, or on abort.
   */
  async *runTurn(req: TurnRequest): AsyncIterable<EngineEvent> {
    // Review M2: an interrupt that landed before the turn started must not spawn the CLI at all.
    if (req.signal.aborted) {
      yield { kind: 'result', sessionId: req.forkAt ? null : req.resumeSessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '중단됨', stderr: null, errorKind: null, terminalReason: 'aborted' };
      return;
    }
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    let stderrTail = '';
    // A fork gets its own id from init; the parent's id must never be reported as the turn's session.
    let sessionId: string | null = req.forkAt ? null : req.resumeSessionId;
    let errorKind: string | null = null;
    let sawResult = false;
    /** Prompt tokens of the main conversation's latest API call (the turn's result carries it as the context size). */
    let lastCtx: ContextUsage | null = null;
    const input = new InputChannel();
    const bg = new BackgroundTracker();
    const meter = new ProgressMeter();
    let shownTasks: string[] = [];
    let shownSig = '[]';
    /** The SDK handle (Query) once the process is spawned: per-task stop when it has stopTask. */
    type Handle = { stopTask?: (id: string) => Promise<void>; setPermissionMode?: (m: 'default' | 'acceptEdits' | 'plan') => Promise<void> };
    let handle: Handle | null = null;
    /** uuids of the messages written (initial prompt, follow-ups, steers) not yet answered by a result, oldest first. */
    const unanswered: string[] = [];
    /** Steers written but not yet seen reaching the model: our uuid → the caller's id. */
    const steers = new Map<string, string>();
    /** Steers seen reaching the model since the last result (fallback attribution for a result without uuids). */
    let echoed: string[] = [];
    /** This CLI names what each result answered (user_message_uuids): a result without them then answers nothing (a background continuation). */
    let namesAnswers = false;
    const answer = (ids: Iterable<string>) => { for (const id of ids) { const i = unanswered.indexOf(id); if (i >= 0) unanswered.splice(i, 1); } };
    /** Between a result and the next main-thread output: new output there is a background continuation. */
    let idle = false;
    let capTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let ended: 'cap' | 'grace' | null = null;
    const finish = (why: 'cap' | 'grace') => { if (input.closed) return; ended = why; input.close(); abortController.abort(); };
    const clearGrace = () => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } };
    const armGrace = () => {
      clearGrace();
      if (!idle || unanswered.length > 0 || bg.tasks().length > 0) return;
      graceTimer = setTimeout(() => finish('grace'), this.bgGraceMs);
      graceTimer.unref?.();
    };
    const audit = toolAudit(req);
    // Tool inputs by call id (for a permission_denied frame, which carries none); emptied at each result.
    const toolInputs = new Map<string, unknown>();
    const options = buildOptions(req, { home: this.home, accounts: this.accounts, baseEnv: this.baseEnv, abortController, steer: this.steer, audit, onStderr: (s) => { stderrTail = (stderrTail + s).slice(-STDERR_MAX); } });
    const write = async (f: { text: string; attachments: Attachment[] }, steerId: string | null): Promise<boolean> => {
      if (input.closed) return false;
      // Counted before the first await: the loop decides whether to close right after a result,
      // and a message sent from that result's handler must already keep the input open.
      const uuid = randomUUID();
      unanswered.push(uuid);
      if (steerId !== null) steers.set(uuid, steerId);
      idle = false;
      clearGrace();
      const undo = () => { answer([uuid]); steers.delete(uuid); idle = unanswered.length === 0; armGrace(); };
      let m: SDKUserMessage;
      try {
        m = (await toUserMessage(f.text, f.attachments, this.readFile)) as unknown as SDKUserMessage;
      } catch (err) {
        undo();
        throw err;
      }
      // 'next' (the CLI's default) is what folds a mid-turn message in at the next tool boundary; 'now' would abort the turn.
      if (!input.push({ ...m, uuid, ...(steerId !== null ? { priority: 'next' as const } : {}) })) { undo(); return false; }
      return true;
    };
    const live: LiveInput = {
      send: (f) => write(f, null),
      steer: (f, id) => write(f, id),
      stopTask: async (taskId) => {
        if (input.closed || typeof handle?.stopTask !== 'function') return false;
        await handle.stopTask(taskId);
        return true;
      },
      setPermissionMode: async (mode) => {
        if (input.closed || typeof handle?.setPermissionMode !== 'function') return false;
        await handle.setPermissionMode(mode);
        return true;
      },
    };
    try {
      const first = randomUUID();
      unanswered.push(first);
      input.push({ ...((await toUserMessage(req.prompt, req.attachments ?? [], this.readFile)) as unknown as SDKUserMessage), uuid: first });
      const stream = this.queryFn({ prompt: input, options });
      handle = stream as Handle;
      if (typeof handle.stopTask !== 'function') delete live.stopTask;
      if (typeof handle.setPermissionMode !== 'function') delete live.setPermissionMode;
      // Switched off, or a handoff note (no tools: no boundary to fold at): the caller queues for after the turn.
      if (!this.steer || req.noTools) delete live.steer;
      req.onLive?.(live);
      for await (const sdkMsg of stream) {
        const m = sdkMsg as unknown as CliMessage;
        // The CLI's own non-querying turn (a notification queued shouldQuery:false — e.g. the orphaned-agent notice it
        // injects on resume) still writes a result: no uuids, no model turn, origin not ours. It answers nothing we wrote
        // and is no turn of ours — counting it closed the input before our prompt ran. With nothing of ours unanswered
        // (idle after our result: e.g. an agent hand-back) it can steal no answer, so it goes through as a normal result —
        // closing the continuation segment its notification opened and running the close check.
        // A failed one (setup error) is the CLI's, not our prompt's: logged, never shown as our turn's failure.
        if (isInjectedNoopResult(m) && unanswered.length > 0) {
          const r = m as unknown as Rec;
          if (r.subtype !== 'success' || r.is_error === true) console.warn(`deck: CLI-injected turn failed (not ours): ${[r.subtype, ...(Array.isArray(r.errors) ? r.errors : [])].join(': ')}`);
          continue;
        }
        if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') toolInputs.set(String(b.id), b.input);
        for (const d of deniedCalls(m, toolInputs)) await audit.report(d, 'deny', d.source);
        if (m.type === 'result') toolInputs.clear();
        if (bg.apply(m)) {
          const tasks = bg.tasks();
          const detail = bg.detail();
          const sig = JSON.stringify(detail.map((t) => [t.id, t.description, t.type]));
          if (sig !== shownSig) { shownSig = sig; shownTasks = tasks; yield { kind: 'background', tasks, detail }; }
          armGrace();
        }
        if (idle && isActivity(m)) { idle = false; clearGrace(); yield { kind: 'continue', cause: 'background' }; }
        const prog = meter.apply(m);
        if (prog) yield { kind: 'progress', ...prog };
        if (m.type === 'assistant' && m.parent_tool_use_id === null) lastCtx = contextUsageOf((m.message as unknown as Rec).usage) ?? lastCtx;
        if (m.type === 'assistant' && typeof (m as unknown as Rec).error === 'string') errorKind = (m as unknown as Rec).error as string;
        if (this.onCommands) noteCommands(m, req.cwd, this.onCommands);
        if (m.type === 'user' && (m as unknown as Rec).isReplay === true && typeof m.uuid === 'string') {
          const id = steers.get(m.uuid);
          if (id !== undefined) { steers.delete(m.uuid); echoed.push(m.uuid); yield { kind: 'steer_delivered', id }; }
        }
        let gotResult = false;
        for (const ev of mapCliMessage(m)) {
          if (ev.kind === 'init') sessionId = ev.sessionId;
          if (ev.kind === 'result') {
            sawResult = true;
            gotResult = true;
            const r = m as unknown as Rec;
            const ids = Array.isArray(r.user_message_uuids) ? (r.user_message_uuids as unknown[]).filter((x): x is string => typeof x === 'string')
              : typeof r.user_message_uuid === 'string' ? [r.user_message_uuid] : null;
            if (ids) namesAnswers = true;
            if (ids && ids.length && ids.some((u) => unanswered.includes(u))) {
              // A steer the result names but whose echo never came still reached the model: report it before the result.
              for (const u of ids) {
                const id = steers.get(u);
                if (id !== undefined) { steers.delete(u); yield { kind: 'steer_delivered', id }; }
              }
              answer(ids);
            } else if (ids && ids.length) {
              // Names none of ours: attribute as if unnamed rather than leave the input open until bgMaxMs.
              console.warn('deck: result answers no message written to this process', { session: sessionId, ids, unanswered: unanswered.length });
              answer([...unanswered.slice(0, 1), ...echoed]);
            } else if (!namesAnswers || !ev.ok) {
              // No uuids from an older CLI, or a delivery failure / error result: the oldest message, plus any steer folded into this turn.
              answer([...unanswered.slice(0, 1), ...echoed]);
            }
            // else: a CLI that names its answers named none — a background continuation, answering nothing we wrote.
            echoed = [];
            yield { ...ev, ...(lastCtx ? { usage: { ...ev.usage, context: lastCtx } } : {}), errorKind: ev.errorKind ?? errorKind, stderr: ev.ok ? null : stderrTail || null };
            errorKind = null;
            lastCtx = null;
            meter.reset();
          } else {
            yield ev;
          }
        }
        if (!gotResult) continue;
        // Decided after the consumer handled the result (it may have sent a queued follow-up meanwhile).
        if (unanswered.length === 0 && bg.tasks().length === 0) break;
        idle = unanswered.length === 0;
        if (!capTimer) { capTimer = setTimeout(() => finish('cap'), this.bgMaxMs); capTimer.unref?.(); }
        armGrace();
      }
    } catch (err) {
      // The SDK throws after yielding an error result; only synthesize one if none was seen.
      if (!sawResult) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: msg, stderr: stderrTail || null, errorKind, terminalReason: null };
      }
    } finally {
      input.close();
      if (capTimer) clearTimeout(capTimer);
      clearGrace();
      req.signal.removeEventListener('abort', onAbort);
    }
    if (ended === 'cap') {
      const minutes = Math.round(this.bgMaxMs / 60_000);
      yield { kind: 'notice', message: `백그라운드 작업이 ${minutes}분 안에 끝나지 않아 프로세스를 종료했습니다` };
      // The cut work by name (what the pane last showed): the runner records it and sends the session on by itself.
      yield { kind: 'bg_cap', tasks: shownTasks.length ? [...shownTasks] : bg.tasks(), minutes };
    }
    if (shownTasks.length) yield { kind: 'background', tasks: [], detail: [] };
  }
}
