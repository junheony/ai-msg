import fs from 'node:fs/promises';
import os from 'node:os';
import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { accountEnv } from '../../shared/accounts';
import { IMAGE_TYPES, promptWithFiles, type Attachment } from '../attachments/AttachmentStore';
import { ZERO_USAGE, type TurnUsage } from '../../shared/turn-types';
import { MODEL_ARG } from '../routing/ModelPolicy';
import { textOfContent } from '../sessions/transcript';
import { parseQuestions, sessionUpdates, type Engine, type EngineEvent, type EngineResult, type RateLimitSignal, type TurnRequest } from './Engine';
import { STDERR_MAX } from './redact';
import type { SlashCommandInfo } from './slashCommands';

export type PromptInput = string | AsyncIterable<SDKUserMessage>;
export type QueryFn = (params: { prompt: PromptInput; options?: Options }) => AsyncIterable<SDKMessage>;
export type ReadFile = (p: string) => Promise<Buffer>;

type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number];
type Base64Source = Extract<Extract<UserBlock, { type: 'image' }>['source'], { type: 'base64' }>;

function imageMediaType(t: string): Base64Source['media_type'] | null {
  return IMAGE_TYPES.has(t) ? (t as Base64Source['media_type']) : null;
}

/**
 * D7/D14: non-image attachments become path lines in the text; with at least one image the prompt is a
 * one-message stream (`SDKUserMessage` with a content array — the only way to pass image blocks,
 * sdk.d.ts:3233/6158). `session_id: ''` mirrors what the SDK writes for a string prompt.
 */
export async function buildPrompt(text: string, attachments: Attachment[], readFile: ReadFile = (p) => fs.readFile(p)): Promise<PromptInput> {
  const body = promptWithFiles(text, attachments);
  const images = attachments.filter((a) => a.isImage);
  if (!images.length) return body;
  const content: UserBlock[] = [{ type: 'text', text: body }];
  for (const img of images) {
    const media_type = imageMediaType(img.mediaType);
    if (!media_type) continue;
    content.push({ type: 'image', source: { type: 'base64', media_type, data: (await readFile(img.path)).toString('base64') } });
  }
  const message: SDKUserMessage = { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
  return (async function* () { yield message; })();
}

type Rec = Record<string, unknown>;

export function buildOptions(
  req: TurnRequest,
  deps: { home: string; baseEnv: NodeJS.ProcessEnv; abortController: AbortController; onStderr: (s: string) => void },
): Options {
  return {
    cwd: req.cwd,
    env: accountEnv(req.account, deps.baseEnv, deps.home),
    model: MODEL_ARG[req.model],
    // sdk.d.ts Options.effort?: EffortLevel ('low' | 'medium' | 'high' | 'xhigh' | 'max'), "works with adaptive thinking".
    ...(req.effort ? { effort: req.effort } : {}),
    resume: req.resumeSessionId ?? undefined,
    // ~/.claude/settings.json sets defaultMode "auto"; spec §6 wants ask-every-time — unless
    // 이 세션 accepted the SDK's own "allow all edits this session" on an earlier turn.
    permissionMode: req.permissionMode ?? 'default',
    // Spec §4.3: hooks, agents, CLAUDE.md from the profile + project.
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
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
    canUseTool: async (toolName, input, ctx) => {
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

function isoFromEpochSec(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
}

function windowOf(w: unknown): RateLimitSignal['fiveHour'] {
  if (!w || typeof w !== 'object') return null;
  const u = (w as Rec).utilization;
  if (typeof u !== 'number') return null;
  return { usedPct: Math.round(u * 100), resetsAt: isoFromEpochSec((w as Rec).resetsAt) };
}

function usageOf(u: unknown): TurnUsage {
  const r = (u ?? {}) as Rec;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return { inputTokens: n('input_tokens'), outputTokens: n('output_tokens'), cacheReadTokens: n('cache_read_input_tokens'), cacheCreationTokens: n('cache_creation_input_tokens') };
}

/** Pure translation of one SDKMessage into zero or more EngineEvents. */
export function mapSdkMessage(m: SDKMessage): EngineEvent[] {
  switch (m.type) {
    case 'system': {
      if (m.subtype === 'init') return [{ kind: 'init', sessionId: m.session_id, model: m.model, ...(typeof m.cwd === 'string' ? { cwd: m.cwd } : {}) }];
      if (m.subtype === 'compact_boundary') return [{ kind: 'compact' }];
      return [];
    }
    case 'stream_event': {
      if (m.parent_tool_use_id !== null) return [];
      const ev = m.event as unknown as Rec;
      if (ev.type !== 'content_block_delta') return [];
      const delta = ev.delta as Rec | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ kind: 'delta', text: delta.text }];
      return [];
    }
    case 'assistant': {
      if (m.parent_tool_use_id !== null) return [];
      const blocks = ((m.message as unknown as Rec).content as Rec[] | undefined) ?? [];
      return blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ kind: 'tool_call' as const, toolUseId: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input }));
    }
    case 'user': {
      if (m.parent_tool_use_id !== null) return [];
      const content = (m.message as unknown as Rec).content;
      if (!Array.isArray(content)) return [];
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
      return [{ kind: 'rate_limit', info: { status: info.status as RateLimitSignal['status'], fiveHour: windowOf(uw.five_hour), weekly: windowOf(uw.seven_day) } }];
    }
    case 'result': {
      const ok = m.subtype === 'success' && !m.is_error;
      let errorText: string | null = null;
      if (!ok) errorText = m.subtype === 'success' ? m.result : [m.subtype, ...(m.errors ?? [])].join(': ');
      const result: EngineResult = {
        kind: 'result',
        sessionId: m.session_id,
        ok,
        text: ok ? m.result : '',
        usage: usageOf(m.usage),
        errorText,
        stderr: null,
        errorKind: null,
        terminalReason: m.terminal_reason ?? null,
      };
      return [result];
    }
    default:
      return [];
  }
}

/** The composer's `/` menu source: what system/init (`slash_commands`) or `commands_changed` reported. */
export type CommandsListener = (sessionId: string | null, cwd: string, commands: (string | SlashCommandInfo)[], terminal: string[]) => void;

/** system/init or system/commands_changed → onCommands; anything else is ignored. */
export function noteCommands(m: SDKMessage, fallbackCwd: string, onCommands: CommandsListener): void {
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

export class ClaudeEngine implements Engine {
  private readonly queryFn: QueryFn;
  private readonly home: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly readFile: ReadFile;
  private readonly onCommands: CommandsListener | null;

  constructor(opts: { queryFn?: QueryFn; home?: string; baseEnv?: NodeJS.ProcessEnv; readFile?: ReadFile; onCommands?: CommandsListener } = {}) {
    this.queryFn = opts.queryFn ?? ((p) => query(p));
    this.home = opts.home ?? os.homedir();
    this.baseEnv = opts.baseEnv ?? process.env;
    this.readFile = opts.readFile ?? ((p) => fs.readFile(p));
    this.onCommands = opts.onCommands ?? null;
  }

  async *runTurn(req: TurnRequest): AsyncIterable<EngineEvent> {
    // Review M2: an interrupt that landed before the turn started must not spawn the CLI at all.
    if (req.signal.aborted) {
      yield { kind: 'result', sessionId: req.resumeSessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: '중단됨', stderr: null, errorKind: null, terminalReason: 'aborted' };
      return;
    }
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    let stderrTail = '';
    let sessionId: string | null = req.resumeSessionId;
    let errorKind: string | null = null;
    let sawResult = false;
    const options = buildOptions(req, { home: this.home, baseEnv: this.baseEnv, abortController, onStderr: (s) => { stderrTail = (stderrTail + s).slice(-STDERR_MAX); } });
    try {
      const prompt = await buildPrompt(req.prompt, req.attachments ?? [], this.readFile);
      for await (const m of this.queryFn({ prompt, options })) {
        if (m.type === 'assistant' && typeof (m as unknown as Rec).error === 'string') errorKind = (m as unknown as Rec).error as string;
        if (this.onCommands) noteCommands(m, req.cwd, this.onCommands);
        for (const ev of mapSdkMessage(m)) {
          if (ev.kind === 'init') sessionId = ev.sessionId;
          if (ev.kind === 'result') {
            sawResult = true;
            yield { ...ev, errorKind: ev.errorKind ?? errorKind, stderr: ev.ok ? null : stderrTail || null };
          } else {
            yield ev;
          }
        }
        // D14: with a streamed prompt the CLI would wait for more input, so the result ends the turn.
        // String prompts keep the Plan 1 behavior (read to the end) so an unmeasured change stays isolated to image turns.
        if (sawResult && typeof prompt !== 'string') break;
      }
    } catch (err) {
      // The SDK throws after yielding an error result; only synthesize one if none was seen.
      if (!sawResult) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { kind: 'result', sessionId, ok: false, text: '', usage: ZERO_USAGE, errorText: msg, stderr: stderrTail || null, errorKind, terminalReason: null };
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
  }
}
