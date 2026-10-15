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
import { claudeArgs, claudeEnv } from '../args';
import { resolveClaudeBin } from '../version';
import { scrubLine } from './scrub';
import { BackgroundTracker } from '../stream';
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
  let args = claudeArgs({ model: 'sonnet', permissionMode: 'default', settingsPath, mcpConfigPath, ...(sc.resume ? { resume: sc.resume(dir) } : {}) });
  args = replaceFlag(args, '--setting-sources', 'project');
  if (!bridge) { args = replaceFlag(args, '--permission-prompt-tool', null); args = replaceFlag(args, '--permission-prompts', 'none'); }
  args.push('--max-turns', String(sc.maxTurns), ...(sc.extraArgs?.(dir) ?? []));
  const proc = new ClaudeProcess({ bin: bin.bin, args, cwd: work, env: claudeEnv(process.env, 600_000) });
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
  fs.writeFileSync(out, frames.map((f) => scrub(JSON.stringify(f))).join('\n') + '\n');
  fs.writeFileSync(path.join(import.meta.dirname, `${name}.meta.json`), scrub(JSON.stringify(meta, null, 2)) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${path.relative(process.cwd(), out)} (${frames.length} frames)`, meta.exit);
}

if (process.argv[1]?.endsWith('capture.ts')) {
  const name = process.argv[2] ?? '';
  const sc = scenarios[name];
  if (!sc) { console.error(`scenarios: ${Object.keys(scenarios).join(', ')}`); process.exit(2); }
  await capture(name, sc);
}
