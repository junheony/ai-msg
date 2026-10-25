import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import type { CliUserMessage, Rec } from './messages';
import type { ClaudeChildLike, ClaudeSpawnFn } from './spawnTypes';
import { postBridge } from './permissionMcp';

export type FakeSpawn = { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; files: { settings: Record<string, unknown> | null; mcpConfig: Record<string, unknown> | null } };
export type FakeCtl = { push(...ms: unknown[]): void; raw(text: string): void; exit(code: number | null, signal?: NodeJS.Signals | null): void };

/**
 * Test double for the `claude` child. Frames pushed before a spawn are queued and written as soon
 * as the next child starts; frames pushed while a child is alive go straight to its stdout. Every
 * stdin line is parsed into `inputs`. Closing stdin ends the child with exit 0 (the real CLI's
 * behaviour once its input ends and the turn is over) unless `exitOnStdinClose: false`.
 * Signals: SIGINT → `onSignal` if given, else exit 130 with no output; SIGTERM/SIGKILL → killed by signal.
 * `end()` before a child exists is queued for the next one. Each spawn snapshots its `--settings` / `--mcp-config`
 * files (the engine deletes them when the turn ends; tests inspect them afterwards).
 */
export function fakeClaudeCli(opts: { exitOnStdinClose?: boolean; onSignal?: (sig: NodeJS.Signals, ctl: FakeCtl) => void } = {}) {
  const spawns: FakeSpawn[] = [];
  const inputs: CliUserMessage[] = [];
  const state = { inputClosed: false, calls: 0, signals: [] as NodeJS.Signals[] };
  const queue: unknown[] = [];
  let live: FakeCtl | null = null;
  let stderrOf: PassThrough | null = null;
  let endQueued: number | null = null;
  const readJson = (p: string | undefined) => { if (!p) return null; try { return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; } };

  const spawnFn: ClaudeSpawnFn = (bin, args, o) => {
    state.calls++;
    state.inputClosed = false;
    spawns.push({ bin, args: [...args], cwd: o.cwd, env: { ...o.env }, files: { settings: readJson(argValue(args, '--settings')), mcpConfig: readJson(argValue(args, '--mcp-config')) } });
    const ee = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let exited = false;
    const ctl: FakeCtl = {
      push: (...ms) => { if (!exited) for (const m of ms) stdout.write(JSON.stringify(m) + '\n'); },
      raw: (text) => { if (!exited) stdout.write(text + '\n'); },
      exit: (code, signal = null) => {
        if (exited) return;
        exited = true;
        if (live === ctl) live = null;
        stdout.end();
        stderr.end();
        setImmediate(() => ee.emit('exit', code, signal));
      },
    };
    readline.createInterface({ input: stdin }).on('line', (l) => { if (l.trim()) inputs.push(JSON.parse(l) as CliUserMessage); });
    stdin.on('finish', () => {
      state.inputClosed = true;
      if (opts.exitOnStdinClose !== false) setImmediate(() => ctl.exit(0));
    });
    const child: ClaudeChildLike = {
      stdin, stdout, stderr, pid: 40000 + state.calls,
      kill: (sig: NodeJS.Signals = 'SIGTERM') => {
        state.signals.push(sig);
        if (exited) return false;
        if (sig === 'SIGINT') { if (opts.onSignal) opts.onSignal(sig, ctl); else ctl.exit(130); }
        else ctl.exit(null, sig);
        return true;
      },
      once: ((event: string, cb: (...a: never[]) => void) => { ee.once(event, cb as (...a: unknown[]) => void); return child; }) as ClaudeChildLike['once'],
    };
    live = ctl;
    stderrOf = stderr;
    const pending = queue.splice(0);
    if (pending.length) setImmediate(() => ctl.push(...pending));
    if (endQueued !== null) { const c = endQueued; endQueued = null; setImmediate(() => setImmediate(() => ctl.exit(c))); }
    return child;
  };

  return {
    spawnFn,
    spawns,
    inputs,
    state,
    push: (...ms: unknown[]) => { if (live) live.push(...ms); else queue.push(...ms); },
    end: (code = 0) => { if (live) live.exit(code); else endQueued = code; },
    stderr: (text: string) => { stderrOf?.write(text); },
    ctl: () => live,
    /** What the real permissionMcp.ts would do for the latest spawn: read its mcp-config (snapshot), POST to the bridge. */
    ask: async (call: { tool_name: string; input: Record<string, unknown>; tool_use_id: string; permission_suggestions?: unknown }) => {
      const s = spawns[spawns.length - 1];
      if (!s) throw new Error('no spawn');
      if (!s.files.mcpConfig) throw new Error('no mcp-config');
      const env = (s.files.mcpConfig as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers.deck_bridge!.env;
      const r = await postBridge(env.DECK_BRIDGE_SOCK!, env.DECK_BRIDGE_TOKEN!, '/v1/permission', call);
      return JSON.parse(r.body) as Record<string, unknown>;
    },
    /** What hookRelay.ts would do for the latest spawn: parse --sock and the DECK_BRIDGE_TOKEN= prefix out of the settings (snapshot)'s first hook command. */
    hook: async (input: Record<string, unknown>) => {
      const s = spawns[spawns.length - 1]!;
      if (!s.files.settings) throw new Error('no settings');
      const settings = s.files.settings as { hooks: Record<string, { hooks: { command: string }[] }[]> };
      const cmd = Object.values(settings.hooks)[0]![0]!.hooks[0]!.command;
      const word = (flag: string) => (cmd.match(new RegExp(`'${flag}' '([^']*)'`)) ?? [])[1]!;
      // `( … ) || exit 2` around a fail-closed (commander) command — args.ts relayCommand.
      const token = (cmd.match(/^(?:\( )?DECK_BRIDGE_TOKEN='([^']*)' /) ?? [])[1]!;
      const r = await postBridge(word('--sock'), token, '/v1/hook', input);
      return JSON.parse(r.body) as Record<string, unknown>;
    },
  };
}

/** `--flag value` or `--flag=value` → value (first occurrence). */
export function argValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) return args[i + 1];
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  return undefined;
}

/** stream-json frame builders: today's `sdk` builders (same names, same shapes) plus replay/result-for helpers. */
export const cli = {
  init: (sid = 's1') => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' }),
  delta: (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }),
  result: (text: string, sid = 's1') => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, usage: { input_tokens: 1, output_tokens: 2 } }),
  bgLevel: (tasks: { id: string; desc: string; ambient?: boolean }[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: tasks.map((t) => ({ task_id: t.id, task_type: 'local_agent', description: t.desc, ...(t.ambient ? { ambient: true } : {}) })), session_id: 's1' }),
  taskStarted: (id: string, desc: string, backgrounded = true) => ({ type: 'system', subtype: 'task_started', task_id: id, description: desc, is_backgrounded: backgrounded, session_id: 's1' }),
  taskDone: (id: string) => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed', output_file: '/tmp/o', summary: 'done', session_id: 's1' }),
  /** The CLI's injected notification turn opener (origin task-notification). */
  notifyUser: () => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: '<task-notification>done</task-notification>' }, origin: { kind: 'task-notification' }, session_id: 's1' }),
  /** The result of the turn the CLI runs by itself for a queued notification (fixtures/background.jsonl: origin task-notification, no uuids). */
  notifyResult: (text: string, sid = 's1') => ({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, session_id: sid, usage: { input_tokens: 1, output_tokens: 2 }, origin: { kind: 'task-notification' } }),
  /** The result the CLI writes for a notification it queues without asking the model (shouldQuery:false — e.g. the orphaned-agent notice on resume): no uuids, no turns, zero usage. */
  notifyNoopResult: () => ({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, session_id: 's1', usage: { input_tokens: 0, output_tokens: 0 }, origin: { kind: 'task-notification' } }),
  /** A queued notification the CLI folded into the running turn, echoed by --replay-user-messages (queued_command attachment → replayed user message). */
  notifyReplay: (taskId: string) => ({ type: 'user', isReplay: true, uuid: `n-${taskId}`, parent_tool_use_id: null, message: { role: 'user', content: `<task-notification> <task-id>${taskId}</task-id> <status>completed</status> <summary>done</summary> </task-notification>` }, origin: { kind: 'task-notification' }, session_id: 's1' }),
  /** Main-conversation stream events (token meter / phase). */
  messageStart: () => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: {} } }),
  blockStart: (type: 'text' | 'thinking' | 'tool_use') => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type } } }),
  messageDelta: (outputTokens: number) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: {}, usage: { output_tokens: outputTokens } } }),
  /** An Agent tool call in the main conversation, its subagent's task messages, and the subagent's own tool use/result. */
  agentCall: (id = 'toolu_ag', desc = 'count files') => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: desc, subagent_type: 'general-purpose', prompt: 'count' } }] }, session_id: 's1' }),
  agentStarted: (taskId = 'a1', toolUseId = 'toolu_ag') => ({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: 'count files', subagent_type: 'general-purpose', task_type: 'local_agent', session_id: 's1' }),
  agentProgress: (taskId = 'a1', toolUseId = 'toolu_ag', tokens = 1200) => ({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: toolUseId, description: 'count files', usage: { total_tokens: tokens, tool_uses: 2, duration_ms: 3000 }, last_tool_name: 'Bash', session_id: 's1' }),
  subToolCall: (parent = 'toolu_ag', id = 'sub1', name = 'Bash', input: unknown = { command: 'ls' }) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id, name, input }] }, session_id: 's1' }),
  subToolResult: (parent = 'toolu_ag', id = 'sub1', isError = false) => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'a\nb', is_error: isError }] }, session_id: 's1' }),
  subagentTool: () => ({ type: 'assistant', parent_tool_use_id: 'toolu_bg', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] }, session_id: 's1' }),
  replay: (uuid: string, text = 'x'): Rec => ({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content: text }, session_id: 's1' }),
  resultFor: (uuids: string[], text: string, sid = 's1'): Rec => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, usage: { input_tokens: 1, output_tokens: 2 }, user_message_uuids: uuids }),
};
