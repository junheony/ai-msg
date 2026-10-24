import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { TranscriptMessage } from '../../shared/session-types';
import { stripSystemReminders } from '../../shared/choices';
import { GROK_SESSION_ID_RE } from './GrokEngine';
import { readByteWindow, readByteWindowBefore, type ByteWindow, type OffsetBuilder } from './lineWindow';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

const QUERY = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/;
const INJECTED = /^\s*<(?:system-reminder|user_info)>/;

/**
 * The user's own words in a Grok `chat_history.jsonl` user line: inside `<user_query>` when there is one; else the
 * text as is, minus the items that are injected context (`<system-reminder>`, `<user_info>`). Prompts sent over ACP
 * (deck's own turns) are stored without tags. Null when nothing of the user's is left.
 */
export function grokUserText(content: unknown): string | null {
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap((b) => { const r = rec(b); return r?.type === 'text' && typeof r.text === 'string' ? [r.text] : []; }) : [];
  for (const p of parts) {
    const m = QUERY.exec(p);
    if (m) { const t = m[1]!.trim(); return t || null; }
  }
  // A part that starts with injected context keeps what follows its closed reminder blocks (a prompt deck prefixed).
  const kept = parts.map((p) => (INJECTED.test(p) ? stripSystemReminders(p) : p)).filter((p) => !INJECTED.test(p)).map((p) => p.trim()).filter(Boolean);
  return kept.length ? kept.join('\n\n') : null;
}

const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap((b) => { const r = rec(b); return typeof r?.text === 'string' ? [r.text] : []; }).join('') : '';

/**
 * `GROK_HOME/sessions/*\/<id>/`, only when its real path stays under `GROK_HOME/sessions` (the rule GrokEngine's
 * `sessionUpdatesFile` applies, Grok design §14.4). Null for an id that fails `GROK_SESSION_ID_RE` or no such dir.
 */
export async function findGrokSessionDir(grokHome: string, sessionId: string): Promise<string | null> {
  if (!GROK_SESSION_ID_RE.test(sessionId) || sessionId.includes('..')) return null;
  const root = await fs.realpath(path.join(grokHome, 'sessions')).catch(() => null);
  if (!root) return null;
  for (const group of await fs.readdir(root).catch(() => [] as string[])) {
    const real = await fs.realpath(path.join(root, group, sessionId)).catch(() => null);
    if (real && real.startsWith(root + path.sep) && (await fs.stat(real).then((s) => s.isDirectory(), () => false))) return real;
  }
  return null;
}

export type GrokTranscriptOptions = { maxMessages?: number; maxToolResultChars?: number };

/** Rejects anything at `file` but a regular file (a symlink is never followed). */
async function regularFile(file: string): Promise<void> {
  if (!(await fs.lstat(file)).isFile()) throw new Error(`not a regular file: ${path.basename(file)}`);
}

/** The last `maxBytes` of a Grok `chat_history.jsonl` as transcript messages (a cut first / half-written last line is skipped; anything but a regular file throws). */
export async function readGrokTranscriptTail(file: string, maxBytes = 16 * 1024 * 1024, opts: GrokTranscriptOptions = {}): Promise<TranscriptMessage[]> {
  const maxMessages = opts.maxMessages ?? 200;
  const maxTool = opts.maxToolResultChars ?? 8192;
  await regularFile(file);
  const fh = await fs.open(file, 'r');
  let text: string;
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    text = buf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally {
    await fh.close();
  }
  const out: TranscriptMessage[] = [];
  for (const line of text.split('\n')) {
    const m = grokLine(line, maxTool);
    if (m) out.push(m);
  }
  return out.slice(-maxMessages);
}

/** One `chat_history.jsonl` line as a transcript message (each line stands alone), or null. */
function grokLine(line: string, maxTool: number): TranscriptMessage | null {
  if (!line.trim()) return null;
  let r: Rec | null;
  try { r = rec(JSON.parse(line)); } catch { return null; }
  if (!r) return null;
  if (r.type === 'user') {
    const t = grokUserText(r.content);
    if (t) return { kind: 'user', text: t, ts: null };
  } else if (r.type === 'assistant') {
    const toolCalls = (Array.isArray(r.tool_calls) ? r.tool_calls : []).flatMap((c) => {
      const tc = rec(c);
      const fn = rec(tc?.function);
      const name = typeof tc?.name === 'string' ? tc.name : typeof fn?.name === 'string' ? fn.name : null;
      if (!tc || typeof tc.id !== 'string' || !name) return [];
      const raw = tc.arguments ?? fn?.arguments;
      let input: unknown = raw ?? {};
      if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { input = raw; } }
      return [{ id: tc.id, name, input }];
    });
    const body = textOf(r.content);
    if (body || toolCalls.length) return { kind: 'assistant', text: body, model: typeof r.model_id === 'string' ? r.model_id : null, toolCalls, ts: null };
  } else if (r.type === 'tool' || r.type === 'tool_result') {
    const id = typeof r.tool_call_id === 'string' ? r.tool_call_id : null;
    if (!id) return null;
    const content = textOf(r.content);
    return { kind: 'tool_result', toolUseId: id, content: content.slice(0, maxTool), isError: false, ts: null, ...(content.length > maxTool ? { truncated: true } : {}) };
  }
  return null;
}

function grokOffsetBuilder(maxTool: number): OffsetBuilder {
  const messages: TranscriptMessage[] = [];
  const starts: number[] = [];
  return {
    add(line, at) {
      const m = grokLine(line, maxTool);
      if (!m) return;
      messages.push(m);
      starts.push(at);
    },
    entries: () => ({ messages, starts }),
  };
}

/** readGrokTranscriptTail, plus the cursor for the page before the window ('olderHistory'). */
export async function readGrokWindow(file: string, maxBytes = 16 * 1024 * 1024, opts: GrokTranscriptOptions = {}): Promise<ByteWindow> {
  await regularFile(file);
  return readByteWindow(file, () => grokOffsetBuilder(opts.maxToolResultChars ?? 8192), opts.maxMessages ?? 200, maxBytes);
}

/** The page before cursor `before` (a ByteWindow.older) of a chat_history.jsonl; null = not a cursor of this file. */
export async function readGrokBefore(file: string, before: number, count = 200, maxToolResultChars = 8192): Promise<ByteWindow | null> {
  await regularFile(file);
  return readByteWindowBefore(file, before, () => grokOffsetBuilder(maxToolResultChars), count);
}

/** The first user prompt's first line (80 chars) in the first `maxBytes` of a `chat_history.jsonl`: a title fallback. */
export async function readGrokFirstPrompt(file: string, maxBytes = 2 * 1024 * 1024): Promise<string | null> {
  if (!(await regularFile(file).then(() => true, () => false))) return null;
  const stream = createReadStream(file, { encoding: 'utf8', start: 0, end: maxBytes - 1 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r: Rec | null;
      try { r = rec(JSON.parse(line)); } catch { continue; }
      if (r?.type !== 'user') continue;
      const t = grokUserText(r.content);
      const first = t?.split('\n').find((l) => l.trim())?.trim();
      if (first) return first.slice(0, 80);
    }
  } catch {
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}
