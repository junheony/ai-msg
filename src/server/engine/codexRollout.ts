import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { TranscriptMessage } from '../../shared/session-types';
import type { GptCredits } from '../../shared/usage-types';
import type { TurnWindows } from '../usage/UsageService';
import { readByteWindow, readByteWindowBefore, type ByteWindow, type OffsetBuilder } from './lineWindow';

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

/** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`, newest day first. Null when absent. */
export async function findRolloutFile(sessionsRoot: string, threadId: string): Promise<string | null> {
  const suffix = `-${threadId}.jsonl`;
  const dirsDesc = async (p: string): Promise<string[]> => {
    try { return (await fs.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse(); } catch { return []; }
  };
  for (const y of await dirsDesc(sessionsRoot)) {
    for (const m of await dirsDesc(path.join(sessionsRoot, y))) {
      for (const d of await dirsDesc(path.join(sessionsRoot, y, m))) {
        const dir = path.join(sessionsRoot, y, m, d);
        let names: string[];
        try { names = await fs.readdir(dir); } catch { continue; }
        const hit = names.find((n) => n.startsWith('rollout-') && n.endsWith(suffix));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}

function windowOf(w: unknown): { usedPct: number; resetsAt: string | null } | null {
  const r = rec(w);
  if (!r || typeof r.used_percent !== 'number') return null;
  const resetsAt = typeof r.resets_at === 'number' && Number.isFinite(r.resets_at) ? new Date(r.resets_at * 1000).toISOString() : null;
  return { usedPct: Math.round(r.used_percent), resetsAt };
}

/** `rate_limits.credits` = `{ has_credits, unlimited, balance: "49563.32…" }` (balance is a decimal string). Null when absent/unusable. */
export function creditsOf(c: unknown): GptCredits | null {
  const r = rec(c);
  if (!r || typeof r.has_credits !== 'boolean') return null;
  const raw = typeof r.balance === 'string' ? Number.parseFloat(r.balance) : typeof r.balance === 'number' ? r.balance : Number.NaN;
  return { hasCredits: r.has_credits, unlimited: r.unlimited === true, balance: Number.isFinite(raw) ? raw : null };
}

export type RateLimitObservation = { windows: TurnWindows; /** the event's own timestamp; null when the line has none */ atMs: number | null };

/** F3: like `rolloutRateLimits`, plus when that `token_count` was written. */
export function rolloutRateLimitsAt(lines: unknown[]): RateLimitObservation | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = rec(lines[i]);
    const p = r ? rec(r.payload) : null;
    if (!r || !p || r.type !== 'event_msg' || p.type !== 'token_count') continue;
    const rl = rec(p.rate_limits);
    if (!rl) continue;
    // Review fix 1: only the ChatGPT plan's own limit (or an older CLI that names none) is the GPT seat's usage.
    if (typeof rl.limit_id === 'string' && rl.limit_id !== 'codex') continue;
    const out: TurnWindows = {};
    for (const key of ['primary', 'secondary'] as const) {
      const w = rec(rl[key]);
      const win = windowOf(w);
      if (!w || !win) continue;
      if (w.window_minutes === 10080) out.weekly = win;
      else if (w.window_minutes === 300) out.fiveHour = win;
    }
    // An entry with no 10080/300-minute window does not hide an earlier usable one.
    if (!out.weekly && !out.fiveHour) continue;
    const credits = creditsOf(rl.credits);
    if (credits) out.credits = credits;
    const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN;
    return { windows: out, atMs: Number.isNaN(ts) ? null : ts };
  }
  return null;
}

/** The last `event_msg`/`token_count` with `rate_limits`: window 10080 min = weekly, 300 min = 5 h (D5). */
export function rolloutRateLimits(lines: unknown[]): TurnWindows | null {
  return rolloutRateLimitsAt(lines)?.windows ?? null;
}

function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* cut line */ }
  }
  return out;
}

async function readTailLines(file: string, maxBytes: number): Promise<unknown[]> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return parseLines(buf.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await fh.close();
  }
}

/** Reads only the tail (rate limits are re-emitted every turn). */
export async function readRolloutRateLimits(file: string, maxBytes = 256 * 1024): Promise<TurnWindows | null> {
  return rolloutRateLimits(await readTailLines(file, maxBytes));
}

export async function readRolloutRateLimitsAt(file: string, maxBytes = 256 * 1024): Promise<RateLimitObservation | null> {
  return rolloutRateLimitsAt(await readTailLines(file, maxBytes));
}

/**
 * F3: the `n` most recently modified `rollout-*.jsonl` under `sessionsRoot/YYYY/MM/DD`, any originator.
 * Every date dir is looked at: a long-running thread started weeks ago keeps appending to its old file.
 */
export async function newestRolloutFiles(sessionsRoot: string, n = 5): Promise<string[]> {
  const subdirs = async (p: string): Promise<string[]> => {
    try { return (await fs.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name)); } catch { return []; }
  };
  const found: { file: string; mtimeMs: number }[] = [];
  for (const y of await subdirs(sessionsRoot)) {
    for (const m of await subdirs(y)) {
      for (const d of await subdirs(m)) {
        let names: string[];
        try { names = await fs.readdir(d); } catch { continue; }
        for (const name of names) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          const file = path.join(d, name);
          try { found.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs }); } catch { /* vanished */ }
        }
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, n).map((f) => f.file);
}

/** F3: the newest rate-limit observation among the newest rollout files (tail-read); a line without a timestamp counts at its file's mtime. */
export async function latestRolloutRateLimits(sessionsRoot: string, n = 5, maxBytes = 256 * 1024): Promise<{ windows: TurnWindows; atMs: number } | null> {
  let best: { windows: TurnWindows; atMs: number } | null = null;
  for (const file of await newestRolloutFiles(sessionsRoot, n)) {
    try {
      const obs = await readRolloutRateLimitsAt(file, maxBytes);
      if (!obs) continue;
      const atMs = obs.atMs ?? (await fs.stat(file)).mtimeMs;
      if (!best || atMs > best.atMs) best = { windows: obs.windows, atMs };
    } catch {
      // unreadable file: skip
    }
  }
  return best;
}

/** Injected context the CLI prepends to the user's turn (environment, AGENTS.md, plugins, permissions). */
function isInjected(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('# AGENTS.md');
}

function textOf(content: unknown, type: string): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => rec(b))
    .filter((b): b is Rec => !!b && b.type === type && typeof b.text === 'string')
    .map((b) => b.text as string)
    .filter((t) => !isInjected(t))
    .join('\n');
}

/** How much of an imported rollout's end is read for its history (Codex Desktop rollouts reach gigabytes). */
export const CODEX_TAIL_BYTES = 16 * 1024 * 1024;

export type CodexTranscriptOptions = { maxMessages?: number; maxToolResultChars?: number };

class CodexTranscriptBuilder {
  private out: TranscriptMessage[] = [];
  /** Index for index with `out`: where the line that pushed each message starts (-1 = not tracked). */
  private starts: number[] = [];
  /** The model of the turn being read (each turn's `turn_context` line names it): kept on its assistant messages. */
  private model: string | null = null;
  constructor(private readonly opts: Required<CodexTranscriptOptions>) {}

  private lastAssistant(ts: string | null): Extract<TranscriptMessage, { kind: 'assistant' }> {
    const last = this.out.at(-1);
    if (last && last.kind === 'assistant') return last;
    const entry: Extract<TranscriptMessage, { kind: 'assistant' }> = { kind: 'assistant', text: '', model: this.model, toolCalls: [], ts };
    this.out.push(entry);
    return entry;
  }

  /** `at`: the byte the line starts at (kept for the messages it pushes). */
  add(line: unknown, at = -1): void {
    const n = this.out.length;
    this.apply(line);
    for (let i = n; i < this.out.length; i++) this.starts[i] = at;
    if (this.out.length > this.opts.maxMessages * 2 + 64) {
      this.out = this.out.slice(-this.opts.maxMessages);
      this.starts = this.starts.slice(-this.opts.maxMessages);
    }
  }

  private apply(line: unknown): void {
    const r = rec(line);
    const p = r ? rec(r.payload) : null;
    if (r && p && r.type === 'turn_context' && typeof p.model === 'string' && p.model) { this.model = p.model; return; }
    if (!r || !p || r.type !== 'response_item') return;
    const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
    if (p.type === 'message' && p.role === 'user') {
      const text = textOf(p.content, 'input_text');
      if (text) this.out.push({ kind: 'user', text, ts });
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = textOf(p.content, 'output_text');
      if (!text) return;
      const last = this.out.at(-1);
      if (last && last.kind === 'assistant' && !last.text && last.toolCalls.length === 0) { last.text = text; last.ts = ts; return; }
      this.out.push({ kind: 'assistant', text, model: this.model, toolCalls: [], ts });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      // custom_tool_call (newer Codex, e.g. apply_patch) carries a raw `input` string instead of JSON `arguments`.
      const raw = p.type === 'function_call' ? p.arguments : p.input;
      let input: unknown = raw;
      if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { input = raw; } }
      this.lastAssistant(ts).toolCalls.push({ id: String(p.call_id ?? ''), name: String(p.name ?? ''), input });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      let content = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      let truncated = false;
      if (content.length > this.opts.maxToolResultChars) { content = `${content.slice(0, this.opts.maxToolResultChars)}\n…[잘림: 원래 ${content.length}자]`; truncated = true; }
      this.out.push({ kind: 'tool_result', toolUseId: String(p.call_id ?? ''), content, isError: false, ts, ...(truncated ? { truncated } : {}) });
    }
  }

  result(): TranscriptMessage[] {
    return this.out.slice(-this.opts.maxMessages);
  }

  entries(): { messages: TranscriptMessage[]; starts: number[] } {
    return { messages: this.out, starts: this.starts };
  }
}

/** A Codex builder over raw lines with their offsets (lineWindow paging; nothing trimmed, the caller bounds the region). */
function codexOffsetBuilder(maxToolResultChars: number): OffsetBuilder {
  const b = new CodexTranscriptBuilder({ maxMessages: Infinity, maxToolResultChars });
  return {
    add(line, at) {
      if (!line.trim()) return;
      let v: unknown;
      try { v = JSON.parse(line); } catch { return; }
      b.add(v, at);
    },
    entries: () => b.entries(),
  };
}

/**
 * readCodexTranscript (whole rollout) or readCodexTranscriptTail (`maxBytes`), plus the cursor for the page before the
 * window ('olderHistory'). Same messages, read in chunks so each knows the byte its line starts at.
 */
export function readCodexWindow(file: string, maxBytes = Infinity, opts: CodexTranscriptOptions = {}): Promise<ByteWindow> {
  return readByteWindow(file, () => codexOffsetBuilder(opts.maxToolResultChars ?? 8192), opts.maxMessages ?? 200, maxBytes);
}

/**
 * The page before cursor `before` (a ByteWindow.older) of a rollout; null = not a cursor of this file. The model of
 * assistant messages before the region's first `turn_context` line is not known (null).
 */
export function readCodexBefore(file: string, before: number, count = 200, maxToolResultChars = 8192): Promise<ByteWindow | null> {
  return readByteWindowBefore(file, before, () => codexOffsetBuilder(maxToolResultChars), count, true);
}

export function parseCodexTranscript(text: string, opts: CodexTranscriptOptions = {}): TranscriptMessage[] {
  const b = new CodexTranscriptBuilder({ maxMessages: opts.maxMessages ?? 200, maxToolResultChars: opts.maxToolResultChars ?? 8192 });
  for (const l of parseLines(text)) b.add(l);
  return b.result();
}

export async function readCodexTranscript(file: string, opts: CodexTranscriptOptions = {}): Promise<TranscriptMessage[]> {
  const b = new CodexTranscriptBuilder({ maxMessages: opts.maxMessages ?? 200, maxToolResultChars: opts.maxToolResultChars ?? 8192 });
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { b.add(JSON.parse(line)); } catch { /* skip */ }
  }
  return b.result();
}

/**
 * Like readCodexTranscript, from the last `maxBytes` only: Codex Desktop rollouts reach gigabytes, and the
 * sidebar opens them read-only to show the recent history. The first (cut) line is skipped.
 */
export async function readCodexTranscriptTail(file: string, maxBytes = CODEX_TAIL_BYTES, opts: CodexTranscriptOptions = {}): Promise<TranscriptMessage[]> {
  const b = new CodexTranscriptBuilder({ maxMessages: opts.maxMessages ?? 200, maxToolResultChars: opts.maxToolResultChars ?? 8192 });
  for (const l of await readTailLines(file, maxBytes)) b.add(l);
  return b.result();
}
