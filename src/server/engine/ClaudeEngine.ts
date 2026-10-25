import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountRegistry } from '../../shared/accounts';
import type { Attachment } from '../attachments/AttachmentStore';
import { ZERO_USAGE, contextUsageOf, type ContextUsage } from '../../shared/turn-types';
import type { BgTask, Engine, EngineEvent, LiveInput, TurnRequest } from './Engine';
import { buildMcpConfig, buildSettings, claudeArgs, claudeEnv, validResume, type CliPermissionMode } from './claudeCli/args';
import { MCP_TOOL_TIMEOUT_MS, PermissionBridge } from './claudeCli/bridge';
import { forkCandidates, writeForkSource } from './claudeCli/fork';
import { hookHandler } from './claudeCli/hooks';
import type { CliUserMessage, Rec } from './claudeCli/messages';
import { deckWrites, type OwnedEntries } from './claudeCli/ownedEntries';
import { SessionGrants, permissionHandler, type ModeGate } from './claudeCli/permissions';
import { ClaudeProcess, exitFailureText } from './claudeCli/process';
import { toUserMessage, type ReadFile } from './claudeCli/prompt';
import type { ClaudeSpawnFn } from './claudeCli/spawnTypes';
import { childScript } from './claudeCli/childScripts';
import { BackgroundTracker, ProgressMeter, ToolTracker, deniedCalls, foldedNotificationIds, isActivity, isInjectedNoopResult, isNotificationResult, mapCliMessage, noteCommands, toolAudit, type CommandsListener } from './claudeCli/stream';
import { ABORTED_TEXT, CLAUDE_MISSING_TEXT, claudeTooOldText, fastFailureKind, fastModeText, invalidResumeText } from './claudeCli/texts';
import type { ClaudeBin } from './claudeCli/version';

export { BackgroundTracker, ProgressMeter, isActivity, isInjectedNoopResult, toolAudit, deniedCalls, noteCommands, mapCliMessage, type CommandsListener, type ToolAudit } from './claudeCli/stream';
export { toUserMessage, type ReadFile } from './claudeCli/prompt';
export { NO_TOOLS_MESSAGE, KEEP_PLANNING_MESSAGE } from './claudeCli/texts';

/**
 * Background waiting caps: total wait after the first result (default Infinity — no cap, the process is held until its
 * background work ends; a finite `bgMaxMs` restores one), and how long an emptied set may stay idle.
 */
export const BG_MAX_MS = Infinity;
/** setTimeout fires at once for delays it cannot hold (Infinity, or beyond 2^31-1 ms): those mean no cap timer at all. */
const MAX_TIMER_MS = 2_147_483_647;
export const BG_GRACE_MS = 60_000;
/**
 * With `promptSuggestions`, how long stdin stays open after the last result for the CLI's `prompt_suggestion` (it comes
 * ~2 s after the result, or not at all); the process is let go as soon as one arrives.
 */
export const SUGGEST_WAIT_MS = 5_000;
/**
 * An abort of a turn that is already over (waiting for its suggestion, or closing): stdin is closed first so the CLI
 * flushes its transcript and exits by itself; one still alive after this long is SIGTERMed.
 */
export const OVER_ABORT_GRACE_MS = 1_000;

const HOOK_RELAY = childScript('hookRelay');
const PERMISSION_MCP = childScript('permissionMcp');

export type ClaudeEngineOptions = {
  bin: ClaudeBin | string;
  spawnFn?: ClaudeSpawnFn;
  bridge?: PermissionBridge;
  accounts: Pick<AccountRegistry, 'env' | 'projectsDir'>;
  baseEnv?: NodeJS.ProcessEnv;
  readFile?: ReadFile;
  bgMaxMs?: number;
  bgGraceMs?: number;
  onCommands?: CommandsListener;
  steer?: boolean;
  killGraceMs?: number;
  owned?: OwnedEntries;
  node?: string;
  tmpRoot?: string;
  /** The child scripts' run-time copies (S7 `snapshotChildScripts`); default: next to this code. */
  scripts?: { hookRelay: string; permissionMcp: string };
  /** Ask the CLI for its next-prompt guess (`initialize` with promptSuggestions) and yield it as a `suggestion` event. */
  promptSuggestions?: boolean;
  /** Default SUGGEST_WAIT_MS. */
  suggestWaitMs?: number;
  /** Default OVER_ABORT_GRACE_MS. */
  overAbortGraceMs?: number;
};

export class ClaudeEngine implements Engine {
  private readonly bin: ClaudeBin;
  private readonly o: ClaudeEngineOptions;
  private readonly readFile: ReadFile;
  private readonly owned: OwnedEntries;
  private bridgeP: Promise<PermissionBridge> | null;

  constructor(opts: ClaudeEngineOptions) {
    this.o = opts;
    this.bin = typeof opts.bin === 'string' ? { ok: true, bin: opts.bin, version: '', belowRecommended: false } : opts.bin;
    this.readFile = opts.readFile ?? ((p) => fs.readFile(p));
    this.owned = opts.owned ?? deckWrites;
    this.bridgeP = opts.bridge ? Promise.resolve(opts.bridge) : null;
  }

  private bridge(): Promise<PermissionBridge> {
    return (this.bridgeP ??= PermissionBridge.open());
  }

  /** Closes the bridge (server shutdown). A bridge passed in by the caller is the caller's to close. */
  async close(): Promise<void> {
    if (this.bridgeP && !this.o.bridge) await (await this.bridgeP).close();
  }

  /**
   * One deck turn = one `claude -p` child in stream-json input mode. Its stdin stays open after a result while
   * background tasks are live: when one settles, the CLI injects its notification and runs another turn by itself
   * (yielded as `continue` + that turn's events + its result), and `onLive().send` can add user messages. Stdin
   * closes — and the child ends — after a result with no live background task and no unanswered message, after an
   * emptied set stays idle for `bgGraceMs`, after a finite `bgMaxMs` (the child is terminated), or on abort (SIGINT).
   */
  async *runTurn(req: TurnRequest): AsyncIterable<EngineEvent> {
    // A fork gets its own id from init; the parent's id must never be reported as the turn's session.
    let sessionId: string | null = req.forkAt ? null : req.resumeSessionId;
    const fail = (errorText: string, terminalReason: string | null = null, stderr: string | null = null): EngineEvent =>
      ({ kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText, stderr, errorKind: null, terminalReason });
    // Review M2: an interrupt that landed before the turn started must not spawn the CLI at all.
    if (req.signal.aborted) { yield fail(ABORTED_TEXT, 'aborted'); return; }
    if (!this.bin.ok) { yield fail(this.bin.reason === 'too_old' ? claudeTooOldText(this.bin.version) : CLAUDE_MISSING_TEXT); return; }
    // claudeArgs throws on a bad resume target; answer with a failed result here instead of rejecting the iterator.
    // (A fork resumes the truncated copy's path instead, which writeForkSource produces.)
    if (req.resumeSessionId && !req.forkAt && !validResume(req.resumeSessionId)) { yield fail(invalidResumeText(req.resumeSessionId)); return; }

    const procDir = await fs.mkdtemp(path.join(this.o.tmpRoot ?? os.tmpdir(), 'qd-claude-'));
    await fs.chmod(procDir, 0o700);
    const audit = toolAudit(req);
    const tracker = new ToolTracker(audit);
    const startMode: CliPermissionMode = req.permissionMode ?? 'default';
    const gate: ModeGate = { mode: startMode, startedIn: startMode };
    const reg = (await this.bridge()).register({
      permission: permissionHandler(req, audit, gate, new SessionGrants()),
      hook: hookHandler(req, audit, gate),
    }, { failClosed: !!req.commanderHop });
    let proc: ClaudeProcess | null = null;
    let aborted = false;
    /** The turn is over and stdin is held open only for the CLI's prompt_suggestion (SUGGEST_WAIT_MS). */
    let suggestWait = false;
    /**
     * The turn is over (waiting only for its suggestion, or closing): an abort closes stdin (no SIGINT) and SIGTERMs only
     * a process still alive after OVER_ABORT_GRACE_MS — the CLI may still be flushing the transcript's end, and a send
     * waiting for the session does not sit through SUGGEST_WAIT_MS.
     */
    let over = false;
    let capTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let suggestTimer: NodeJS.Timeout | null = null;
    let overKill: NodeJS.Timeout | null = null;
    const onAbort = () => {
      aborted = true;
      reg.abortAll();
      if (!over) { proc?.interrupt(); return; }
      if (suggestTimer) { clearTimeout(suggestTimer); suggestTimer = null; }
      proc?.closeInput();
      overKill = setTimeout(() => proc?.terminate(), this.o.overAbortGraceMs ?? OVER_ABORT_GRACE_MS);
      overKill.unref?.();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const relay = { node: this.o.node ?? process.execPath, script: this.o.scripts?.hookRelay ?? HOOK_RELAY, socketPath: reg.socketPath, token: reg.token };
      const settingsPath = path.join(procDir, 'settings.json');
      const mcpConfigPath = path.join(procDir, 'mcp.json');
      await fs.writeFile(settingsPath, JSON.stringify(buildSettings({ ...(req.allowRules?.length ? { allowRules: req.allowRules } : {}), ...(req.noTools ? { noTools: true } : {}), ...(req.systemNote ? { systemNote: req.systemNote } : {}), ...(req.commanderHop ? { commander: true } : {}), ...(req.fast ? { fast: true } : {}), relay })), { mode: 0o600 });
      await fs.writeFile(mcpConfigPath, JSON.stringify(buildMcpConfig({ node: relay.node, script: this.o.scripts?.permissionMcp ?? PERMISSION_MCP, socketPath: reg.socketPath, token: reg.token })), { mode: 0o600 });

      let resume = req.resumeSessionId ?? undefined;
      let forkSession = false;
      if (req.forkAt && req.resumeSessionId) {
        const src = await writeForkSource({ candidates: forkCandidates(this.o.accounts.projectsDir(req.account), req.cwd, req.resumeSessionId), at: req.forkAt, dir: procDir, sessionId: req.resumeSessionId });
        if (!src.ok) { yield fail(src.text); return; }
        resume = src.path;
        forkSession = true;
      }
      const args = claudeArgs({
        model: req.fast ? 'opus' : req.model, ...(req.effort ? { effort: req.effort } : {}), permissionMode: startMode,
        settingsPath, mcpConfigPath, ...(req.allowDirs?.length ? { addDirs: req.allowDirs } : {}),
        ...(resume !== undefined ? { resume, forkSession } : { sessionId: randomUUID() }),
        ...(req.appendSystemPrompt ? { appendSystemPrompt: req.appendSystemPrompt } : {}),
      });
      const env = claudeEnv(this.o.accounts.env(req.account, this.o.baseEnv ?? process.env), MCP_TOOL_TIMEOUT_MS);
      const p = new ClaudeProcess({ bin: this.bin.bin, args, cwd: req.cwd, env, ...(this.o.spawnFn ? { spawnFn: this.o.spawnFn } : {}), ...(this.o.killGraceMs !== undefined ? { killGraceMs: this.o.killGraceMs } : {}) });
      proc = p;

      // ---- the loop below is today's runTurn body; only the marked lines differ ----
      let errorKind: string | null = null;
      let sawResult = false;
      let lastOk = false;
      let lastCtx: ContextUsage | null = null;
      const bg = new BackgroundTracker();
      const meter = new ProgressMeter();
      let shownTasks: string[] = [];
      let shownSig = '[]';
      /**
       * Background tasks that ended while a turn was streaming: the CLI queues their notification and runs it as a turn of
       * its own right after that turn's result. Until that turn begins they are still shown as background work, so the
       * result does not let the process go — here, nor ws endHeld while a restart drains (2026-10-25: the notification
       * turn was cut at once, its answer never came). Each entry keeps the turn it ended in and is settled on its own:
       *  - by the next turn the CLI starts (the process idle after a result shows main-thread activity again), or by a
       *    notification turn's own result (origin task-notification): only entries from before that turn — the CLI drains
       *    every queued notification into one turn (dequeueAllMatching, same mode), so one ending during it (B while A's
       *    notification turn runs) is still owed its own turn;
       *  - by its id, when the CLI folds its notification into a running turn instead (foldedNotificationIds) — a user turn
       *    included.
       * Not by the SDK `task_notification` frame: the CLI writes it when the task ends (its task-registry update, before
       * the notification is even queued), not when the notification is taken in — mid-turn it means nothing was told yet.
       * Bounded: an idle process with no live task is still let go after bgGraceMs (armGrace counts live tasks only).
       */
      const owed = new Map<string, { task: BgTask; turn: number }>();
      /** A turn is streaming: main-thread activity since the last result (the first turn streams from the start). */
      let streaming = true;
      /** This process's turns so far: a turn begins with the first main-thread activity after a result. */
      let turnNo = 1;
      /** Live tasks whose notification was already folded into a turn: leaving the live set later owes nothing. */
      const toldEarly = new Set<string>();
      /** Settles what ended before turn `n`; true when something was. */
      const settleBefore = (n: number): boolean => { let any = false; for (const [id, o] of owed) if (o.turn < n) { owed.delete(id); any = true; } return any; };
      const shown = (): BgTask[] => { const live = bg.detail(); const ids = new Set(live.map((t) => t.id)); return [...live, ...[...owed.values()].map((o) => o.task).filter((t) => !ids.has(t.id))]; };
      /** The shown set as a `background` event when it changed since last told, else null. */
      const bgChange = (): EngineEvent | null => {
        const detail = shown();
        const sig = JSON.stringify(detail.map((t) => [t.id, t.description, t.type]));
        if (sig === shownSig) return null;
        shownSig = sig;
        shownTasks = detail.map((t) => t.description);
        return { kind: 'background', tasks: shownTasks, detail };
      };
      const unanswered: string[] = [];
      const steers = new Map<string, string>();
      let echoed: string[] = [];
      let namesAnswers = false;
      const answer = (ids: Iterable<string>) => { for (const id of ids) { const i = unanswered.indexOf(id); if (i >= 0) unanswered.splice(i, 1); } };
      let idle = false;
      let ended: 'cap' | 'grace' | null = null;
      // changed: cap kills (tasks are still running), grace only closes stdin (nothing is running).
      const finish = (why: 'cap' | 'grace') => { if (!p.inputOpen || ended) return; ended = why; if (why === 'cap') p.terminate(); else p.stop(); };
      const clearGrace = () => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } };
      const armGrace = () => {
        clearGrace();
        if (!idle || unanswered.length > 0 || bg.tasks().length > 0) return;
        graceTimer = setTimeout(() => finish('grace'), this.o.bgGraceMs ?? BG_GRACE_MS);
        graceTimer.unref?.();
      };
      // ⚡ 빠르게: a failed turn whose error names fast mode / usage credits gets deck's explanation as a note first.
      const fastRefusal = (ev: { ok: boolean; errorText: string | null; errorKind?: string | null }): EngineEvent | null => {
        if (!req.fast || ev.ok) return null;
        const kind = fastFailureKind(ev.errorText, ev.errorKind ?? errorKind);
        return kind ? { kind: 'notice', message: `⚡ ${fastModeText(kind, true)}`, fast: kind } : null;
      };
      const toolInputs = new Map<string, unknown>();
      /** Uuids of the user messages deck itself wrote to this process (owned holds every entry this process saw). */
      const wrote = new Set<string>();
      const writeMsg = (m: CliUserMessage): boolean => { if (typeof m.uuid === 'string') { this.owned.add(m.uuid); wrote.add(m.uuid); } return p.write(m); }; // changed
      const write = async (f: { text: string; attachments: Attachment[] }, steerId: string | null): Promise<boolean> => {
        if (!p.inputOpen || aborted) return false; // changed
        // A follow-up while only the suggestion was awaited: the wait is called off and the message goes in as usual.
        if (suggestWait) { suggestWait = false; over = false; if (suggestTimer) clearTimeout(suggestTimer); suggestTimer = null; }
        const uuid = randomUUID();
        unanswered.push(uuid);
        if (steerId !== null) steers.set(uuid, steerId);
        idle = false;
        clearGrace();
        const undo = () => { answer([uuid]); steers.delete(uuid); idle = unanswered.length === 0; armGrace(); };
        let m: CliUserMessage;
        try {
          m = await toUserMessage(f.text, f.attachments, this.readFile);
        } catch (err) {
          undo();
          throw err;
        }
        if (!writeMsg({ ...m, uuid, ...(steerId !== null ? { priority: 'next' as const } : {}) })) { undo(); return false; }
        return true;
      };
      // changed: no stopTask (control protocol only); the mode switch goes through deck's PreToolUse gate.
      const live: LiveInput = {
        send: (f) => write(f, null),
        steer: (f, id) => write(f, id),
        setPermissionMode: async (mode) => {
          if (!p.inputOpen) return false;
          gate.mode = mode;
          return true;
        },
      };
      const first = randomUUID();
      unanswered.push(first);
      let firstMsg: CliUserMessage;
      try {
        firstMsg = { ...(await toUserMessage(req.prompt, req.attachments ?? [], this.readFile)), uuid: first };
      } catch (err) {
        // e.g. an attachment that can no longer be read: a failed result before anything is spawned, not a throw.
        yield fail(err instanceof Error ? err.message : String(err));
        return;
      }
      p.start(); // changed
      // Before any user message: the CLI reads initialize first (its control_response is ignored like any unknown frame).
      const suggest = !!this.o.promptSuggestions && req.suggest === true;
      if (suggest) p.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'initialize', promptSuggestions: true } });
      writeMsg(firstMsg); // changed
      if (req.signal.aborted) onAbort();
      if (this.o.steer === false || req.noTools) delete live.steer;
      req.onLive?.(live);
      for await (const m of p.messages()) { // changed
        if (ended) break; // changed: what arrives after cap/grace is the dying child's
        if (m.type === 'prompt_suggestion') {
          const text = typeof m.suggestion === 'string' ? m.suggestion.trim() : '';
          // Only while it is awaited: one racing a follow-up (or after an abort) is stale.
          if (text && !aborted && suggestWait) yield { kind: 'suggestion', text };
          if (suggestWait) break;
          continue;
        }
        this.owned.note(m); // changed
        await tracker.apply(m); // changed: replaces PostToolUse/PostToolUseFailure
        if (isInjectedNoopResult(m) && unanswered.length > 0) {
          const r = m as unknown as Rec;
          if (r.subtype !== 'success' || r.is_error === true) console.warn(`deck: CLI-injected turn failed (not ours): ${[r.subtype, ...(Array.isArray(r.errors) ? r.errors : [])].join(': ')}`);
          continue;
        }
        if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use' && typeof b.id === 'string') toolInputs.set(b.id, b.input);
        for (const d of deniedCalls(m, toolInputs)) await audit.report(d, 'deny', d.source);
        if (m.type === 'result') toolInputs.clear();
        const before = m.type === 'system' ? bg.detail() : [];
        const taskMsg = bg.apply(m);
        if (taskMsg && streaming) { const now = new Set(bg.detail().map((t) => t.id)); for (const t of before) if (!now.has(t.id) && !toldEarly.delete(t.id)) owed.set(t.id, { task: t, turn: turnNo }); }
        // What owed is being told now (see owed). Shown after the turn opened (`continue` below), so it never looks idle in
        // between. A no-op result (shouldQuery:false) is no turn: the CLI never batches a queried notification into it.
        let settled = false;
        const noop = isInjectedNoopResult(m);
        if (isActivity(m) && !streaming && !noop) { turnNo++; if (idle) settled = settleBefore(turnNo); }
        if (m.type === 'result' && isNotificationResult(m) && !noop) settled = settleBefore(turnNo) || settled;
        // A replay of what deck itself wrote (a pasted notification, say) is the user talking, not the CLI telling.
        const uuid = (m as { uuid?: unknown }).uuid;
        const mine = typeof uuid === 'string' && wrote.has(uuid);
        for (const id of mine ? [] : foldedNotificationIds(m)) {
          if (owed.delete(id)) settled = true;
          else if (bg.detail().some((t) => t.id === id)) toldEarly.add(id); // told before its level frame let it go
        }
        if (m.type === 'result') streaming = false;
        else if (isActivity(m)) streaming = true;
        if (taskMsg) {
          const change = bgChange();
          if (change) yield change;
          armGrace();
        }
        if (idle && isActivity(m)) { idle = false; clearGrace(); yield { kind: 'continue', cause: 'background' }; }
        if (settled) { const change = bgChange(); if (change) yield change; }
        const prog = meter.apply(m);
        if (prog) yield { kind: 'progress', ...prog };
        if (m.type === 'assistant' && m.parent_tool_use_id === null) lastCtx = contextUsageOf(m.message.usage) ?? lastCtx;
        if (m.type === 'assistant' && typeof m.error === 'string') errorKind = m.error;
        if (this.o.onCommands) noteCommands(m, req.cwd, this.o.onCommands);
        if (m.type === 'user' && m.isReplay === true && typeof m.uuid === 'string') {
          const id = steers.get(m.uuid);
          if (id !== undefined) { steers.delete(m.uuid); echoed.push(m.uuid); yield { kind: 'steer_delivered', id }; }
        }
        let gotResult = false;
        for (const ev of mapCliMessage(m)) {
          if (ev.kind === 'init') sessionId = ev.sessionId;
          if (ev.kind !== 'result') { yield ev; continue; }
          sawResult = true;
          gotResult = true;
          lastOk = ev.ok;
          // changed: the interrupted turn's result, however the CLI words it, is a stop.
          if (aborted) { yield { ...ev, ok: false, text: '', errorText: ABORTED_TEXT, stderr: null, terminalReason: 'aborted' }; break; }
          const r = m as unknown as Rec;
          const ids = Array.isArray(r.user_message_uuids) ? (r.user_message_uuids as unknown[]).filter((x): x is string => typeof x === 'string')
            : typeof r.user_message_uuid === 'string' ? [r.user_message_uuid] : null;
          if (ids) namesAnswers = true;
          if (ids && ids.length && ids.some((u) => unanswered.includes(u))) {
            for (const u of ids) {
              const id = steers.get(u);
              if (id !== undefined) { steers.delete(u); yield { kind: 'steer_delivered', id }; }
            }
            answer(ids);
          } else if (ids && ids.length) {
            console.warn('deck: result answers no message written to this process', { session: sessionId, ids, unanswered: unanswered.length });
            answer([...unanswered.slice(0, 1), ...echoed]);
          } else if (!namesAnswers || !ev.ok) {
            answer([...unanswered.slice(0, 1), ...echoed]);
          }
          echoed = [];
          const fastWhy = fastRefusal(ev);
          if (fastWhy) yield fastWhy;
          yield { ...ev, ...(lastCtx ? { usage: { ...ev.usage, context: lastCtx } } : {}), errorKind: ev.errorKind ?? errorKind, stderr: ev.ok ? null : p.stderrTail || null }; // changed: stderr from the child
          errorKind = null;
          lastCtx = null;
          meter.reset();
        }
        if (!gotResult) continue;
        if (aborted) break; // changed
        if (unanswered.length === 0 && shown().length === 0) {
          // The turn is done; only a successful one gets a suggestion, so only then is stdin held open a moment for it.
          if (!suggest || !lastOk || suggestWait) break;
          suggestWait = true;
          over = true;
          clearGrace();
          suggestTimer = setTimeout(() => p.stop(), this.o.suggestWaitMs ?? SUGGEST_WAIT_MS);
          suggestTimer.unref?.();
          continue;
        }
        idle = unanswered.length === 0;
        const capMs = this.o.bgMaxMs ?? BG_MAX_MS;
        if (!capTimer && capMs <= MAX_TIMER_MS) { capTimer = setTimeout(() => finish('cap'), capMs); capTimer.unref?.(); }
        armGrace();
      }
      // changed: the SDK threw on a dead process; the child's exit is read instead.
      over = sawResult;
      p.stop();
      const exit = await p.exited;
      if (!sawResult) yield aborted ? fail(ABORTED_TEXT, 'aborted') : { ...(fail(exitFailureText(exit), null, p.stderrTail || null) as Extract<EngineEvent, { kind: 'result' }>), errorKind };
      if (ended === 'cap') {
        const minutes = Math.round((this.o.bgMaxMs ?? BG_MAX_MS) / 60_000);
        yield { kind: 'notice', message: `백그라운드 작업이 ${minutes}분 안에 끝나지 않아 프로세스를 종료했습니다` };
        yield { kind: 'bg_cap', tasks: shownTasks.length ? [...shownTasks] : bg.tasks(), minutes };
      }
      if (shownTasks.length) yield { kind: 'background', tasks: [], detail: [] };
    } finally {
      if (capTimer) clearTimeout(capTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (suggestTimer) clearTimeout(suggestTimer);
      if (overKill) clearTimeout(overKill);
      req.signal.removeEventListener('abort', onAbort);
      // A consumer that stopped reading early must not leave the child behind.
      if (proc && proc.exit === null) proc.terminate();
      reg.dispose();
      await fs.rm(procDir, { recursive: true, force: true });
    }
  }
}
