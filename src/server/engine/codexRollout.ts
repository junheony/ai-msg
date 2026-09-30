import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { TranscriptMessage } from '../../shared/session-types';
import type { TurnWindows } from '../usage/UsageService';

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

/** The last `event_msg`/`token_count` with `rate_limits`: window 10080 min = weekly, 300 min = 5 h (D5). */
export function rolloutRateLimits(lines: unknown[]): TurnWindows | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = rec(lines[i]);
    const p = r ? rec(r.payload) : null;
    if (!r || !p || r.type !== 'event_msg' || p.type !== 'token_count') continue;
    const rl = rec(p.rate_limits);
    if (!rl) continue;
    const out: TurnWindows = {};
    for (const key of ['primary', 'secondary'] as const) {
      const w = rec(rl[key]);
      const win = windowOf(w);
      if (!w || !win) continue;
      if (w.window_minutes === 10080) out.weekly = win;
      else if (w.window_minutes === 300) out.fiveHour = win;
    }
    return out.weekly || out.fiveHour ? out : null;
  }
  return null;
}

function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* cut line */ }
  }
  return out;
}

/** Reads only the tail (rate limits are re-emitted every turn). */
export async function readRolloutRateLimits(file: string, maxBytes = 256 * 1024): Promise<TurnWindows | null> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return rolloutRateLimits(parseLines(buf.subarray(0, bytesRead).toString('utf8')));
  } finally {
    await fh.close();
  }
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

export type CodexTranscriptOptions = { maxMessages?: number; maxToolResultChars?: number };

class CodexTranscriptBuilder {
  private out: TranscriptMessage[] = [];
  constructor(private readonly opts: Required<CodexTranscriptOptions>) {}

  private lastAssistant(ts: string | null): Extract<TranscriptMessage, { kind: 'assistant' }> {
    const last = this.out.at(-1);
    if (last && last.kind === 'assistant') return last;
    const entry: Extract<TranscriptMessage, { kind: 'assistant' }> = { kind: 'assistant', text: '', model: null, toolCalls: [], ts };
    this.out.push(entry);
    return entry;
  }

  add(line: unknown): void {
    const r = rec(line);
    const p = r ? rec(r.payload) : null;
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
      this.out.push({ kind: 'assistant', text, model: null, toolCalls: [], ts });
    } else if (p.type === 'function_call') {
      let input: unknown = p.arguments;
      if (typeof p.arguments === 'string') { try { input = JSON.parse(p.arguments); } catch { input = p.arguments; } }
      this.lastAssistant(ts).toolCalls.push({ id: String(p.call_id ?? ''), name: String(p.name ?? ''), input });
    } else if (p.type === 'function_call_output') {
      let content = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      let truncated = false;
      if (content.length > this.opts.maxToolResultChars) { content = `${content.slice(0, this.opts.maxToolResultChars)}\n…[잘림: 원래 ${content.length}자]`; truncated = true; }
      this.out.push({ kind: 'tool_result', toolUseId: String(p.call_id ?? ''), content, isError: false, ts, ...(truncated ? { truncated } : {}) });
    }
    if (this.out.length > this.opts.maxMessages * 2 + 64) this.out = this.out.slice(-this.opts.maxMessages);
  }

  result(): TranscriptMessage[] {
    return this.out.slice(-this.opts.maxMessages);
  }
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
