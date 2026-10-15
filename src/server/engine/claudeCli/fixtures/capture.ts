// src/server/engine/claudeCli/fixtures/capture.ts
// Dev-only live capture. Never imported by the server or by tests.
// Usage (repo root): npx tsx src/server/engine/claudeCli/fixtures/capture.ts <scenario>
// Runs the user's real `claude` with --max-turns, in a fresh temp dir, project settings only
// (no user hooks/plugins in the capture), and writes fixtures/<scenario>.jsonl + .meta.json (scrubbed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProcess } from '../process';
import { buildMcpConfig, buildSettings, claudeArgs, claudeEnv, type CliPermissionMode, type RelaySpec } from '../args';
import { PermissionBridge, type BridgeHandlers, type PermissionCall } from '../bridge';
import { resolveClaudeBin } from '../version';
import { scrubLine } from './scrub';
import { BackgroundTracker, toolAudit } from '../stream';
import { hookHandler } from '../hooks';
import type { CliMessage, CliUserMessage, Rec } from '../messages';

export type CaptureCtx = {
  proc: ClaudeProcess; dir: string; frames: CliMessage[]; meta: Rec;
  send(text: string, extra?: Partial<CliUserMessage>): string;
};
export type Scenario = {
  maxTurns: number;
  timeoutMs?: number;
  settings?: Record<string, unknown>;
  /** Default false: prompts off (`--permission-prompts none`, no prompt tool). Task 4 adds the bridge path. */
  bridge?: boolean;
  extraArgs?: (dir: string) => string[];
  /** Starting `--permission-mode` (default `default`). */
  permissionMode?: CliPermissionMode;
  /** The child's `MCP_TOOL_TIMEOUT` in ms (default 600000). */
  toolTimeoutMs?: number;
  resume?: (dir: string) => string;
  first: string;
  drive(ctx: CaptureCtx, m: CliMessage): void | Promise<void>;
  /** Extra checks recorded into meta after the run. */
  after?(ctx: CaptureCtx): void | Promise<void>;
};

export const FIRST_UUID = '00000000-0000-4000-8000-000000000001';
export const SECOND_UUID = '00000000-0000-4000-8000-000000000002';

const text = (m: CliMessage): string => (m.type === 'stream_event' && (m.event as Rec).type === 'content_block_delta' ? String(((m.event as Rec).delta as Rec)?.text ?? '') : '');

export const scenarios: Record<string, Scenario> = {
  abort: {
    maxTurns: 1,
    first: 'Write the numbers from 1 to 400, one per line, with nothing else.',
    drive: (ctx, m) => {
      if (!ctx.proc.interrupted && text(m)) { ctx.meta.sigintAfterFrame = ctx.frames.length; ctx.proc.interrupt(); }
      if (m.type === 'result') { ctx.meta.resultAfterSigint = ctx.proc.interrupted; ctx.meta.result = { subtype: m.subtype, is_error: m.is_error, terminal_reason: m.terminal_reason ?? null }; ctx.proc.stop(); }
    },
  },
  steer: {
    maxTurns: 3,
    settings: { permissions: { allow: ['Bash(sleep 4)'] } },
    first: 'Run the shell command `sleep 4` with the Bash tool. When it finishes, reply with the secret word if I have told you one, else reply NONE.',
    drive: (ctx, m) => {
      if (m.type === 'assistant' && m.message.content.some((b) => b.type === 'tool_use') && !ctx.meta.steerSent) {
        ctx.meta.steerSent = true;
        ctx.send('The secret word is MANGO.', { uuid: SECOND_UUID, priority: 'next' });
      }
      if (m.type === 'user' && m.isReplay === true) (ctx.meta.replays as string[] | undefined ?? (ctx.meta.replays = [] as string[]) as string[]).push(String(m.uuid));
      if (m.type === 'result') {
        ((ctx.meta.results ??= []) as unknown[]).push({ uuids: m.user_message_uuids ?? m.user_message_uuid ?? null, text: m.result });
        const named = JSON.stringify(m.user_message_uuids ?? m.user_message_uuid ?? '');
        if (named.includes(SECOND_UUID) || String(m.result ?? '').includes('MANGO')) ctx.proc.stop();
      }
    },
  },
  background: {
    maxTurns: 3,
    timeoutMs: 120_000,
    settings: { permissions: { allow: ['Bash(sleep 6)'] } },
    first: 'Run the shell command `sleep 6` with the Bash tool with run_in_background set to true. Do not wait for it: reply STARTED right away. When it finishes, reply FINISHED.',
    drive: (ctx, m) => {
      const bg = (ctx.meta.bgTracker ??= new BackgroundTracker()) as BackgroundTracker;
      bg.apply(m);
      if (m.type === 'system' && m.subtype === 'background_tasks_changed') ctx.meta.sawLevel = true;
      if (m.type === 'system' && m.subtype === 'task_started') ctx.meta.sawTaskStarted = true;
      if (m.type === 'system' && m.subtype === 'task_notification') ctx.meta.sawNotification = true;
      if (m.type !== 'result') return;
      const results = ((ctx.meta.results ??= []) as unknown[]);
      results.push({ uuids: m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : null), tasksLive: bg.tasks().length });
      if (results.length === 1) {
        // The engine's rule: stdin stays open while a task is live. Check the child is still there a moment later.
        setTimeout(() => { ctx.meta.aliveAfterFirstResult = ctx.proc.exit === null; }, 500);
        if (bg.tasks().length === 0) ctx.proc.stop();
      } else if (bg.tasks().length === 0) {
        ctx.proc.stop();
      }
    },
    after: (ctx) => { delete ctx.meta.bgTracker; },
  },
};

function replaceFlag(args: string[], flag: string, value: string | null): string[] {
  const i = args.indexOf(flag);
  if (i < 0) return value === null ? args : [...args, flag, value];
  return value === null ? [...args.slice(0, i), ...args.slice(i + 2)] : [...args.slice(0, i + 1), value, ...args.slice(i + 2)];
}

export async function capture(name: string, sc: Scenario, hooks: { bridgeSetup?: (dir: string) => Promise<{ mcpConfigPath: string; settings: Record<string, unknown>; dispose(): Promise<void> }> } = {}): Promise<void> {
  const bin = resolveClaudeBin(process.env, os.homedir());
  if (!bin.ok) throw new Error(`claude not usable: ${bin.reason}`);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qd-cap-')));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const bridge = sc.bridge && hooks.bridgeSetup ? await hooks.bridgeSetup(dir) : null;
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ ...(sc.settings ?? {}), ...(bridge?.settings ?? {}) }), { mode: 0o600 });
  const mcpConfigPath = bridge?.mcpConfigPath ?? path.join(dir, 'mcp.json');
  if (!bridge) fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  let args = claudeArgs({ model: 'sonnet', permissionMode: sc.permissionMode ?? 'default', settingsPath, mcpConfigPath, ...(sc.resume ? { resume: sc.resume(dir) } : {}) });
  args = replaceFlag(args, '--setting-sources', 'project');
  if (!bridge) { args = replaceFlag(args, '--permission-prompt-tool', null); args = replaceFlag(args, '--permission-prompts', 'none'); }
  args.push('--max-turns', String(sc.maxTurns), ...(sc.extraArgs?.(dir) ?? []));
  const proc = new ClaudeProcess({ bin: bin.bin, args, cwd: work, env: claudeEnv(process.env, sc.toolTimeoutMs ?? 600_000) });
  const frames: CliMessage[] = [];
  const meta: Rec = { cli: bin.version, scenario: name, maxTurns: sc.maxTurns };
  const ctx: CaptureCtx = {
    proc, dir, frames, meta,
    send: (t, extra = {}) => { const uuid = extra.uuid ?? randomUUID(); proc.write({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: t }, ...extra, uuid }); return uuid; },
  };
  proc.start();
  ctx.send(sc.first, { uuid: FIRST_UUID });
  const timer = setTimeout(() => { meta.timedOut = true; proc.terminate(); }, sc.timeoutMs ?? 180_000);
  for await (const m of proc.messages()) { frames.push(m); await sc.drive(ctx, m); }
  const exit = await proc.exited;
  clearTimeout(timer);
  meta.exit = { code: exit.code, signal: exit.signal };
  await sc.after?.(ctx);
  await bridge?.dispose();
  const scrub = (s: string) => scrubLine(s, { home: os.homedir(), cwd: work });
  const out = path.join(import.meta.dirname, `${name}.jsonl`);
  fs.writeFileSync(out, frames.map((f) => scrub(JSON.stringify(f))).filter(Boolean).join('\n') + '\n');
  fs.writeFileSync(path.join(import.meta.dirname, `${name}.meta.json`), scrub(JSON.stringify(meta, null, 2)) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${path.relative(process.cwd(), out)} (${frames.length} frames)`, meta.exit);
}

export type BridgeScenario = Scenario & {
  handlers(ctx: { calls: PermissionCall[]; meta: Rec; dir: string }): Partial<BridgeHandlers>;
  /** `--settings` hook commands running the real hookRelay.ts against this capture's bridge registration. */
  hookSettings?: (relay: RelaySpec) => Record<string, unknown>;
};

const MCP_SCRIPT = path.join(import.meta.dirname, '..', 'permissionMcp.ts');
const allow = async (c: PermissionCall) => ({ behavior: 'allow' as const, updatedInput: c.input });

export async function captureWithBridge(name: string, sc: BridgeScenario): Promise<void> {
  const calls: PermissionCall[] = [];
  const meta: Rec = {};
  const bridge = await PermissionBridge.open();
  await capture(name, { ...sc, bridge: true, after: async (ctx) => { Object.assign(ctx.meta, meta, { calls: calls.map((c) => ({ tool_name: c.tool_name, inputKeys: Object.keys(c.input), tool_use_id: c.tool_use_id, permission_suggestions: c.permission_suggestions ?? null })) }); await sc.after?.(ctx); } }, {
    bridgeSetup: async (dir) => {
      const h = sc.handlers({ calls, meta, dir });
      const reg = bridge.register({
        permission: async (c, s) => { calls.push(c); return (h.permission ?? allow)(c, s); },
        hook: h.hook ?? (async () => ({})),
      });
      const mcpConfigPath = path.join(dir, 'mcp.json');
      fs.writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig({ node: process.execPath, script: MCP_SCRIPT, socketPath: reg.socketPath, token: reg.token })), { mode: 0o600 });
      const relay = { node: process.execPath, script: path.join(import.meta.dirname, '..', 'hookRelay.ts'), socketPath: reg.socketPath, token: reg.token };
      return { mcpConfigPath, settings: sc.hookSettings?.(relay) ?? {}, dispose: async () => { reg.dispose(); await bridge.close(); } };
    },
  });
}

export const bridgeScenarios: Record<string, BridgeScenario> = {
  'permission-allow': {
    maxTurns: 3,
    first: 'Create a file named hello.txt containing the word hi, using the Write tool. Then reply DONE.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({}),
    after: (ctx) => { ctx.meta.fileWritten = fs.existsSync(path.join(ctx.dir, 'work', 'hello.txt')); },
  },
  'permission-session': {
    maxTurns: 4,
    // `echo` is auto-allowed by the CLI (never reaches the prompt tool); `touch` asks.
    first: 'Run the shell command `touch one.txt` with the Bash tool, then, as a separate Bash call, run `touch two.txt`. Then reply DONE.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({
      permission: async (c) => ({ behavior: 'allow', updatedInput: c.input, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] }),
    }),
  },
  'plan-exit': {
    maxTurns: 6,
    permissionMode: 'plan',
    first: 'Make a one-line plan to create notes.txt containing x, present it with ExitPlanMode, and once approved create the file with the Write tool. Then reply DONE.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({
      permission: async (c) => c.tool_name === 'ExitPlanMode'
        ? { behavior: 'allow', updatedInput: c.input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }
        : { behavior: 'allow', updatedInput: c.input },
    }),
    after: (ctx) => { ctx.meta.fileWritten = fs.existsSync(path.join(ctx.dir, 'work', 'notes.txt')); },
  },
  // `ask` (spike D6) moved to Task 3 Step 8; its fixture is already committed.
  deny: {
    maxTurns: 3,
    settings: { permissions: { deny: ['Bash(rm:*)'] } },
    first: 'First run `rm -f nothing.txt` with the Bash tool. Then create a file named x.txt containing x with the Write tool. Report each tool result verbatim.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({ permission: async () => ({ behavior: 'deny', message: 'NOPE-MARKER' }) }),
  },
  'self-call': {
    maxTurns: 2,
    first: 'Call the tool named mcp__deck_bridge__permission with tool_name "Bash" and input {}. Report what happened.',
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    handlers: () => ({}),
  },
  hooks: {
    maxTurns: 3,
    first: 'Read the file a.txt with the Read tool. Then tell me the codeword from your context if you were given one, else NONE.',
    hookSettings: (relay) => buildSettings({ noTools: true, systemNote: 'The codeword is PAPAYA.', relay }),
    handlers: ({ meta }) => {
      const audit = toolAudit({ onToolAudit: async (e) => { ((meta.audits ??= []) as unknown[]).push(e); } });
      const h = hookHandler({ noTools: true, systemNote: 'The codeword is PAPAYA.' }, audit, { mode: 'default', startedIn: 'default' });
      return { hook: async (i, s) => { ((meta.hookEvents ??= []) as unknown[]).push(i.hook_event_name); return h(i, s); } };
    },
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
  },
  'hook-ask': {
    maxTurns: 4,
    permissionMode: 'acceptEdits',
    first: 'Create a.txt containing a with the Write tool, then create b.txt containing b with the Write tool. Then reply DONE.',
    hookSettings: (relay) => buildSettings({ relay }),
    handlers: ({ meta }) => {
      let n = 0;
      return { hook: async (i) => {
        if (i.hook_event_name !== 'PreToolUse') return {};
        n += 1;
        ((meta.hookCalls ??= []) as unknown[]).push(i.tool_name);
        return n === 2 ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } } : {};
      } };
    },
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    after: (ctx) => { ctx.meta.files = ['a.txt', 'b.txt'].filter((f) => fs.existsSync(path.join(ctx.dir, 'work', f))); },
  },
  'hook-allow': {
    maxTurns: 3,
    first: 'Create c.txt containing c with the Write tool. Then reply DONE.',
    hookSettings: (relay) => buildSettings({ relay }),
    handlers: () => ({ hook: async (i) => (i.hook_event_name === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } : {}) }),
    drive: (ctx, m) => { if (m.type === 'result') ctx.proc.stop(); },
    after: (ctx) => { ctx.meta.fileWritten = fs.existsSync(path.join(ctx.dir, 'work', 'c.txt')); },
  },
  'permission-slow': slowPermission(3_000),
  'permission-slow-20s': slowPermission(20_000),
};

/**
 * Does MCP_TOOL_TIMEOUT bound the permission prompt tool? The allow is answered 6 s late; with a
 * 3 s timeout the CLI should give up on the call (tool not run), with 20 s it should honour it.
 */
function slowPermission(toolTimeoutMs: number): BridgeScenario {
  return {
    maxTurns: 3,
    toolTimeoutMs,
    timeoutMs: 120_000,
    first: 'Create a file named slow.txt containing the word hi, using the Write tool. Then report the tool result verbatim and reply DONE.',
    drive: (ctx, m) => {
      if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const b of m.message.content) if (b.type === 'tool_result') {
          ((ctx.meta.toolResults ??= []) as unknown[]).push({ is_error: b.is_error === true, text: (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 300) });
        }
      }
      if (m.type === 'result') ctx.proc.stop();
    },
    handlers: ({ meta }) => ({
      permission: (c, signal) => new Promise((resolve) => {
        const t0 = Date.now();
        const t = setTimeout(() => { meta.answeredAfterMs = Date.now() - t0; resolve({ behavior: 'allow', updatedInput: c.input }); }, 6_000);
        signal.addEventListener('abort', () => { clearTimeout(t); meta.cancelledAfterMs = Date.now() - t0; resolve({ behavior: 'deny', message: 'cancelled' }); }, { once: true });
      }),
    }),
    after: (ctx) => { ctx.meta.toolTimeoutMs = toolTimeoutMs; ctx.meta.fileWritten = fs.existsSync(path.join(ctx.dir, 'work', 'slow.txt')); },
  };
}

if (process.argv[1]?.endsWith('capture.ts')) {
  const name = process.argv[2] ?? '';
  const bsc = bridgeScenarios[name];
  const sc = scenarios[name];
  if (bsc) await captureWithBridge(name, bsc);
  else if (sc) await capture(name, sc);
  else { console.error(`scenarios: ${[...Object.keys(scenarios), ...Object.keys(bridgeScenarios)].join(', ')}`); process.exit(2); }
}
