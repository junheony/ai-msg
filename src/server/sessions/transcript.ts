import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { TranscriptMessage } from '../../shared/session-types';
import { contextUsageOf } from '../../shared/turn-types';
import { splitDeckChoices, stripSystemReminders } from '../../shared/choices';
import { TOKEN_PATTERNS, redactSecrets } from '../engine/redact';

/** `headless`: every record in the head that names its writer is a non-interactive `claude -p` run (`sdk-cli`) — a script's one-shot, or deck's own CLI child (SessionIndex tells them apart). */
export type HeadInfo = { cwd: string | null; title: string | null; headless?: boolean; preview?: string };

/** The `entrypoint` a non-interactive `claude -p` run stamps on its records. */
export const HEADLESS_ENTRYPOINT = 'sdk-cli';

type Rec = Record<string, unknown>;

function parseLines(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split('\n')) {
    const r = parseLine(line);
    if (r) out.push(r);
  }
  return out;
}

export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Rec;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[이미지]');
    else if (block.type === 'document') parts.push('[문서]');
  }
  return parts.join('\n');
}

const hasToolResult = (content: unknown) => Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as Rec).type === 'tool_result');

function message(r: Rec): Rec | null {
  const m = r.message;
  return m && typeof m === 'object' ? (m as Rec) : null;
}

const originKind = (r: Rec): string | null => {
  const o = r.origin;
  return o && typeof o === 'object' && typeof (o as Rec).kind === 'string' ? ((o as Rec).kind as string) : null;
};

/** A user record the person (or deck) sent: not a compact summary, a subagent's, harness-injected (`isMeta`) or a task notification. */
function isRealUser(r: Rec): boolean {
  return r.type === 'user' && !r.isCompactSummary && !r.isSidechain && !r.isMeta && originKind(r) !== 'task-notification';
}

/** Claude Code's hook messages: "Stop hook feedback:\n…", "PreToolUse:Bash hook blocking error from command: …". */
const HOOK_RE = /^([A-Za-z]+)(?::\S*)? hook (?:feedback|blocking error)\b/;

/** A hook's message to the model (e.g. a Stop hook sending it back to work): its event and text, else null. */
export function hookMessage(text: string): { event: string; text: string } | null {
  const m = HOOK_RE.exec(text);
  return m ? { event: m[1]!, text } : null;
}

/** A harness-injected message shown as a collapsed system row: what kind (hook event, peer, task…), its label, its text. */
export type SystemRow = { source: string; label: string; text: string };

/** Injected context for the model only (skill bodies, caveats, image paths, retries): never shown. */
const HIDDEN_META_RE = /^(?:<local-command-caveat>|<system-reminder>|Base directory for this skill|\[Image:|Continue from where you left off\.|\(Re-invocation of |Skill \/\S+ was loaded earlier|The previous response failed to produce a valid tool call)/;
const GOAL_RE = /^(?:Goal check-in:|A session-scoped Stop hook is now active)/;
const SYSTEM_ROW_MAX = 8000;

const TASK_LABEL: Record<string, string> = { completed: '백그라운드 작업 완료', failed: '백그라운드 작업 실패', killed: '백그라운드 작업 중단됨', stopped: '백그라운드 작업 중단됨' };
const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? '';

function row(source: string, label: string, text: string): SystemRow {
  const t = redactSecrets(text);
  return { source, label, text: t.length > SYSTEM_ROW_MAX ? `${t.slice(0, SYSTEM_ROW_MAX)}\n…[잘림: 원래 ${t.length}자]` : t };
}

/**
 * A user-role record the harness wrote, not the person: a system row, 'hide' (context for the model only), or null (a real
 * message). Works on jsonl records (`isMeta`, `origin`, `turnOrigin`, `turnCompanion`) and SDK messages (`isSynthetic`, `origin`).
 * Callers skip tool_result records.
 */
export function systemRow(r: Rec, text: string): SystemRow | 'hide' | null {
  const origin = originKind(r);
  if (origin === 'task-notification') {
    const status = tag(text, 'status').toLowerCase();
    const event = tag(text, 'event');
    const body = [tag(text, 'summary'), tag(text, 'result'), event].filter(Boolean).join('\n\n');
    return row('task', TASK_LABEL[status] ?? (event && !tag(text, 'task-type') ? '모니터 이벤트' : '백그라운드 작업 알림'), body || text);
  }
  if (r.isMeta !== true && r.isSynthetic !== true) return null;
  if (r.turnCompanion === true || HIDDEN_META_RE.test(text) || (text.startsWith('<command-message>') && text.includes('<skill-format>true'))) return 'hide';
  const hook = hookMessage(text);
  if (hook) return row(hook.event, hook.event === 'Stop' || hook.event === 'SubagentStop' ? `${hook.event} 훅이 이어서 진행시킴` : `${hook.event} 훅 메시지`, text);
  if (origin === 'peer') return row('peer', '다른 세션의 메시지', text);
  if (r.turnOrigin === 'scheduled') return row('scheduled', '예약 작업', text);
  if (GOAL_RE.test(text)) return row('goal', '목표 확인', text);
  return text.trim() ? row('auto', '자동 메시지', text) : 'hide';
}

/**
 * A message sent into a running turn (steer) that the CLI folded in at a tool boundary: logged as a
 * `queued_command` attachment, not a user record, but shown — and counted — as the user's message there.
 * `source`: the uuid of the input message it came from (a message is shown once even if logged both ways).
 */
function queuedPrompt(r: Rec): { content: unknown; source: string | null } | null {
  if (r.type !== 'attachment' || r.isSidechain) return null;
  const a = r.attachment;
  if (!a || typeof a !== 'object') return null;
  const q = a as Rec;
  if (q.type !== 'queued_command' || (q.commandMode ?? 'prompt') !== 'prompt' || q.isMeta) return null;
  return { content: q.prompt, source: typeof q.source_uuid === 'string' && q.source_uuid ? q.source_uuid : null };
}

/** Input-message ids already shown as user messages (a steer can be logged as a user record and as a queued_command). */
class SeenPrompts {
  private ids: Set<string>;
  constructor(ids: Iterable<string> = []) {
    this.ids = new Set(ids);
  }
  list(): string[] {
    return [...this.ids];
  }
  /** false = this id was shown before (skip it). */
  first(id: string | null): boolean {
    if (!id) return true;
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    return true;
  }
}

function titleFrom(text: string): string | null {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!first || first.startsWith('<')) return null;
  return first.length > 80 ? first.slice(0, 80) : first;
}

function scan(text: string): { cwd: string | null; custom: string | null; firstUser: string | null; headless: boolean } {
  let cwd: string | null = null;
  let custom: string | null = null;
  let firstUser: string | null = null;
  let headless: boolean | null = null;
  for (const r of parseLines(text)) {
    if (cwd === null && typeof r.cwd === 'string' && r.cwd) cwd = r.cwd;
    if (typeof r.entrypoint === 'string' && headless !== false) headless = r.entrypoint === HEADLESS_ENTRYPOINT;
    if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle.trim()) custom = r.customTitle.trim();
    if (firstUser === null && isRealUser(r)) {
      const m = message(r);
      const t = titleFrom(textOfContent(m?.content));
      if (t) firstUser = t;
    }
  }
  return { cwd, custom, firstUser, headless: headless === true };
}

export function parseHead(text: string): HeadInfo {
  const { cwd, custom, firstUser, headless } = scan(text);
  return { cwd, title: custom ?? firstUser, ...(headless ? { headless } : {}) };
}

async function companionTitle(file: string): Promise<string | null> {
  try {
    const o = JSON.parse(await fs.readFile(path.join(file.replace(/\.jsonl$/, ''), 'custom-title.json'), 'utf8')) as unknown;
    const t = o && typeof o === 'object' ? (o as Rec).customTitle : null;
    return typeof t === 'string' && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

/**
 * cwd from the head; title = the LAST `custom-title` record in the tail window, else the companion
 * `<id>/custom-title.json` (it can lag behind the jsonl), else the last `custom-title` in the head,
 * else the first real user message in the head.
 */
/** How much of a transcript's end the list preview looks at, and how long the preview may be. */
export const PREVIEW_TAIL_BYTES = 64 * 1024;
export const PREVIEW_CHARS = 120;

/**
 * The last thing the assistant said, as one short line for the session list: the newest main-thread assistant record
 * with text in `buf`'s last PREVIEW_TAIL_BYTES (reminders, deck-choices blocks and secrets taken out). Only lines that
 * name `"assistant"` are parsed, newest first, so a long tool-heavy tail costs one backwards walk and a parse or two.
 * null when the window holds no reply (a turn made only of tool calls, a cut first line).
 */
export function lastReplyOf(buf: Buffer): string | null {
  const text = buf.subarray(Math.max(0, buf.length - PREVIEW_TAIL_BYTES)).toString('utf8');
  let end = text.length;
  while (end > 0) {
    const nl = text.lastIndexOf('\n', end - 1);
    const line = text.slice(nl + 1, end);
    end = nl < 0 ? 0 : nl;
    if (!line.includes('"assistant"')) continue;
    const r = parseLine(line);
    if (!r || r.type !== 'assistant' || r.isSidechain) continue;
    // Claude Code's own stand-ins ("API Error: …", "No response requested."): not something the model said.
    if (r.isApiErrorMessage || message(r)?.model === '<synthetic>') continue;
    const raw = textOfContent(message(r)?.content);
    if (!raw) continue;
    const one = redactSecrets(splitDeckChoices(stripSystemReminders(raw)).text).replace(/\s+/g, ' ').trim();
    if (!one) continue;
    // Cut by code point: a slice through a surrogate pair (an emoji) would leave half a character.
    const chars = Array.from(one);
    return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS - 1).join('')}…` : one;
  }
  return null;
}

/** The list preview alone, for a file whose head SessionIndex already knows (after a turn grew it). */
export async function readTailPreview(file: string): Promise<string | null> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - PREVIEW_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return lastReplyOf(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export async function readHead(file: string, maxBytes = 256 * 1024): Promise<HeadInfo> {
  const fh = await fs.open(file, 'r');
  let head: ReturnType<typeof scan>;
  let tailCustom: string | null = null;
  let preview: string | null = null;
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(maxBytes, size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = scan(buf.subarray(0, bytesRead).toString('utf8'));
    if (size <= maxBytes) {
      tailCustom = head.custom; // the head is the whole file
      preview = lastReplyOf(buf.subarray(0, bytesRead));
    } else {
      const start = Math.max(maxBytes, size - maxBytes);
      const tail = Buffer.alloc(size - start);
      const r = await fh.read(tail, 0, tail.length, start);
      // The first tail line is usually cut mid-record; parseLines skips it.
      tailCustom = scan(tail.subarray(0, r.bytesRead).toString('utf8')).custom;
      // The preview reads from bytes already in memory: no extra I/O for the list. A file just over maxBytes has a
      // short tail; the head's end runs straight into it (tail starts where the head stopped), so join them.
      const tailBytes = tail.subarray(0, r.bytesRead);
      const short = PREVIEW_TAIL_BYTES - tailBytes.length;
      preview = lastReplyOf(short > 0 && start === bytesRead ? Buffer.concat([buf.subarray(Math.max(0, bytesRead - short), bytesRead), tailBytes]) : tailBytes);
    }
  } finally {
    await fh.close();
  }
  const title = tailCustom ?? (await companionTitle(file)) ?? head.custom ?? head.firstUser;
  return { cwd: head.cwd, title, ...(head.headless ? { headless: true } : {}), ...(preview ? { preview } : {}) };
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return textOfContent(v) || JSON.stringify(v);
  return v === undefined ? '' : JSON.stringify(v);
}

export type TranscriptOptions = {
  /** Keep only the last N messages. */
  maxMessages?: number;
  /** Cut each tool result to this many characters, with a marker. */
  maxToolResultChars?: number;
};

function parseLine(line: string): Rec | null {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line) as unknown;
    return o && typeof o === 'object' ? (o as Rec) : null;
  } catch {
    return null; // truncated or non-JSON line: skip
  }
}

/** Everything a `TranscriptBuilder` carries from one line to the next: resuming from it reads on as if from the start. */
type BuilderState = { out: TranscriptMessage[]; lastAssistantId: string | null; userCount: number; seen: string[] };

/** Incremental jsonl → TranscriptMessage[] (assistant chunks with the same message id merge). */
class TranscriptBuilder {
  private out: TranscriptMessage[] = [];
  private lastAssistantId: string | null = null;
  /** User messages seen so far (their ordinal `n`; must count exactly as `promptText` does). */
  private userCount = 0;
  private seen = new SeenPrompts();
  private readonly max: number;
  private readonly maxChars: number;

  constructor(opts: TranscriptOptions, state?: BuilderState) {
    this.max = opts.maxMessages ?? Infinity;
    this.maxChars = opts.maxToolResultChars ?? Infinity;
    if (state) {
      this.out = state.out;
      this.lastAssistantId = state.lastAssistantId;
      this.userCount = state.userCount;
      this.seen = new SeenPrompts(state.seen);
    }
  }

  /** Shares `out` with the builder (only its last entry is ever changed again). */
  state(): BuilderState {
    return { out: this.out, lastAssistantId: this.lastAssistantId, userCount: this.userCount, seen: this.seen.list() };
  }

  private push(m: TranscriptMessage): void {
    this.out.push(m);
    // Only the last entry is ever merged into, so dropping from the front is safe.
    if (this.out.length > this.max * 2 + 64) this.out = this.out.slice(-this.max);
  }

  add(r: Rec): void {
    const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
    const sys = r.type === 'user' && !r.isSidechain && !r.isCompactSummary && !hasToolResult(message(r)?.content) ? systemRow(r, textOfContent(message(r)?.content)) : null;
    if (sys) {
      // Harness-injected (hook feedback, peer messages, task notifications…): never a user message, so not counted.
      if (sys !== 'hide') {
        this.push({ kind: 'system', ...sys, ts });
        this.lastAssistantId = null;
      }
    } else if (isRealUser(r)) {
      const m = message(r);
      const content = m?.content;
      if (Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as Rec).type === 'tool_result')) {
        for (const b of content) {
          const block = b as Rec;
          if (block.type !== 'tool_result') continue;
          let text = stringify(block.content);
          let truncated = false;
          if (text.length > this.maxChars) {
            text = `${text.slice(0, this.maxChars)}\n…[잘림: 원래 ${text.length}자]`;
            truncated = true;
          }
          this.push({ kind: 'tool_result', toolUseId: String(block.tool_use_id ?? ''), content: text, isError: block.is_error === true, ts, ...(truncated ? { truncated } : {}) });
        }
        this.lastAssistantId = null;
        return;
      }
      const t = textOfContent(content);
      if (t && this.seen.first(typeof r.uuid === 'string' ? r.uuid : null)) this.push({ kind: 'user', text: t, ts, n: this.userCount++ });
      this.lastAssistantId = null;
    } else if (queuedPrompt(r)) {
      const q = queuedPrompt(r)!;
      const t = textOfContent(q.content);
      if (t && this.seen.first(q.source)) this.push({ kind: 'user', text: t, ts, n: this.userCount++ });
      this.lastAssistantId = null;
    } else if (r.type === 'assistant' && !r.isSidechain) {
      const m = message(r);
      if (!m) return;
      const id = typeof m.id === 'string' ? m.id : null;
      const model = typeof m.model === 'string' ? m.model : null;
      const blocks = Array.isArray(m.content) ? (m.content as Rec[]) : [];
      let entry: Extract<TranscriptMessage, { kind: 'assistant' }>;
      const last = this.out[this.out.length - 1];
      if (id && id === this.lastAssistantId && last && last.kind === 'assistant') entry = last;
      else {
        entry = { kind: 'assistant', text: '', model, toolCalls: [], ts };
        this.push(entry);
      }
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') entry.text += (entry.text ? '\n' : '') + b.text;
        else if (b.type === 'thinking') {
          if (typeof b.thinking === 'string' && b.thinking.trim()) entry.thinking = (entry.thinking ? `${entry.thinking}\n\n` : '') + redactSecrets(b.thinking); // as the live stream shows it
          else if (typeof b.signature === 'string' && b.signature) entry.thinkingRedacted = true; // empty text + signature = thinking the API did not return
        } else if (b.type === 'redacted_thinking') entry.thinkingRedacted = true;
        else if (b.type === 'tool_use') entry.toolCalls.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input });
      }
      const usage = contextUsageOf(m.usage);
      if (usage) entry.usage = usage;
      this.lastAssistantId = id;
    }
  }

  result(): TranscriptMessage[] {
    return Number.isFinite(this.max) ? this.out.slice(-this.max) : this.out;
  }
}

export function parseTranscript(text: string, opts: TranscriptOptions = {}): TranscriptMessage[] {
  const b = new TranscriptBuilder(opts);
  for (const line of text.split('\n')) {
    const r = parseLine(line);
    if (r) b.add(r);
  }
  return b.result();
}

/** Line ends exactly as readline splits them (`crlfDelay: Infinity`): `\r\n`, `\n`, or a lone `\r`. */
const LINE_END = /\r?\n|\r(?!\n)/;

/** The whole file through readline: the reference the cached read must match, and the path for unbounded windows. */
export async function readTranscriptUncached(file: string, opts: TranscriptOptions = {}): Promise<TranscriptMessage[]> {
  const b = new TranscriptBuilder({ maxMessages: opts.maxMessages ?? 200, maxToolResultChars: opts.maxToolResultChars ?? 8192 });
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const r = parseLine(line);
    if (r) b.add(r);
  }
  return b.result();
}

/**
 * Where a cached read stopped: the builder state after the last complete line (`offset` = the byte after its `\n`), and
 * what identifies the file it came from (dev/ino, a hash of its first and of the last bytes before `offset`). The jsonl
 * is append-only; a file that shrank, moved or was rewritten fails the check and is read from the start.
 */
type CacheEntry = { file: string; key: string; dev: string; ino: string; offset: number; headLen: number; headHash: string; tailLen: number; tailHash: string; state: BuilderState };

const FINGERPRINT_BYTES = 4096;
const READ_CHUNK = 4 * 1024 * 1024;
/** The in-memory cache's rough size cap (UTF-16 length of each window's JSON): the least recently used go first. */
const MEMORY_MAX_BYTES = 64 * 1024 * 1024;
/** Snapshots past this are not written (the window holds at most maxMessages messages; tool results are already cut). */
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
/** Raise by hand whenever the output's shape changes in a way the hashed code below does not show. */
const CACHE_FORMAT = 1;
/** Snapshots written by different parsing code are not used: the code (and the constants it reads) that shapes the output is part of the key. */
export const CODE_VERSION_SOURCE = [
  `format:${CACHE_FORMAT}`,
  ...[TranscriptBuilder, systemRow, textOfContent, queuedPrompt, isRealUser, hookMessage, stringify, parseLine, contextUsageOf, redactSecrets, message, hasToolResult, originKind, row, tag].map(String),
  ...[HIDDEN_META_RE, HOOK_RE, GOAL_RE, ...TOKEN_PATTERNS].map(String),
  JSON.stringify(TASK_LABEL),
  String(SYSTEM_ROW_MAX),
].join('\0');
const CODE_VERSION = createHash('sha1').update(CODE_VERSION_SOURCE).digest('hex').slice(0, 16);

const memory = new Map<string, { e: CacheEntry; bytes: number }>();
let memoryBytes = 0;
let memoryMax = MEMORY_MAX_BYTES;
const locks = new Map<string, Promise<unknown>>();
let snapshotDir: string | null = null;

/** Where the cache survives a restart (`<configDir>/transcript-cache`); null = memory only (the default). */
export function setTranscriptCacheDir(dir: string | null): void {
  snapshotDir = dir;
}

/** Forgets the in-memory cache (as a restart would). */
export function clearTranscriptCache(): void {
  memory.clear();
  memoryBytes = 0;
}

/** Tests: the in-memory cache's byte cap (null = the default). */
export function setTranscriptMemoryLimit(bytes: number | null): void {
  memoryMax = bytes ?? MEMORY_MAX_BYTES;
}

/** Tests: the sessions held in memory (least recently used first) and their estimated size. */
export function transcriptMemoryState(): { files: string[]; bytes: number } {
  return { files: [...memory.values()].map((m) => m.e.file), bytes: memoryBytes };
}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

async function readAt(fh: fs.FileHandle, start: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, start + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

function snapshotFile(key: string): string | null {
  return snapshotDir ? path.join(snapshotDir, `${createHash('sha1').update(key).digest('hex')}.json`) : null;
}

async function loadSnapshot(key: string): Promise<CacheEntry | null> {
  const f = snapshotFile(key);
  if (!f) return null;
  try {
    const e = JSON.parse(await fs.readFile(f, 'utf8')) as CacheEntry;
    const s = e?.state;
    const ok = e.key === key && typeof e.file === 'string' && typeof e.dev === 'string' && typeof e.ino === 'string' && Number.isSafeInteger(e.offset) && e.offset >= 0
      && Number.isSafeInteger(e.headLen) && Number.isSafeInteger(e.tailLen) && typeof e.headHash === 'string' && typeof e.tailHash === 'string'
      && e.headLen <= e.offset && e.tailLen <= e.offset
      && s && Array.isArray(s.out) && s.out.every((m) => m && typeof m === 'object' && typeof (m as Rec).kind === 'string') && Array.isArray(s.seen) && Number.isSafeInteger(s.userCount) && (s.lastAssistantId === null || typeof s.lastAssistantId === 'string');
    return ok ? e : null;
  } catch {
    return null; // missing or damaged: rebuilt from the jsonl
  }
}

let writing: Promise<void> = Promise.resolve();
function saveSnapshot(e: CacheEntry, max: number): void {
  const f = snapshotFile(e.key);
  if (!f) return;
  // Serialized now: the builder keeps changing the window's last entry after this.
  // `file` first: pruning reads only the head of each snapshot to find its source.
  const { file, ...rest } = e;
  const json = JSON.stringify({ file, ...rest, state: { ...e.state, out: e.state.out.slice(-max) } });
  if (Buffer.byteLength(json, 'utf8') > SNAPSHOT_MAX_BYTES) return;
  writing = writing.then(async () => {
    const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, json, { mode: 0o600 });
      await fs.rename(tmp, f);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  });
}

/** Snapshot dir size cap: past it the least recently written snapshots go first. */
export const SNAPSHOT_DIR_MAX_BYTES = 200 * 1024 * 1024;
/** Snapshots not written for this long are dropped (each read that uses one rewrites it only when the session grew). */
const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SNAPSHOT_SOURCE_RE = /^\{"file":("(?:[^"\\]|\\.)*")/;

/**
 * Removes snapshots whose session file is gone (or that do not say which it is), ones not written for 14 days, then the
 * oldest until the rest fit `maxBytes`. Returns the removed paths.
 */
export async function pruneTranscriptSnapshots(dir: string, opts: { maxBytes?: number; maxAgeMs?: number } = {}): Promise<string[]> {
  const maxBytes = opts.maxBytes ?? SNAPSHOT_DIR_MAX_BYTES;
  const maxAgeMs = opts.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const now = Date.now();
  const removed: string[] = [];
  const kept: { f: string; size: number; mtime: number }[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const f = path.join(dir, n);
    try {
      const st = await fs.stat(f);
      let drop = now - st.mtimeMs >= maxAgeMs;
      if (!drop) {
        const fh = await fs.open(f, 'r');
        const head = await readAt(fh, 0, 8192).finally(() => fh.close());
        const m = SNAPSHOT_SOURCE_RE.exec(head.toString('utf8'));
        const src = m ? (JSON.parse(m[1]!) as string) : null;
        drop = !src || !(await fs.stat(src).then(() => true, () => false));
      }
      if (!drop) {
        kept.push({ f, size: st.size, mtime: st.mtimeMs });
        continue;
      }
      await fs.rm(f, { force: true });
      removed.push(f);
    } catch {
      // vanished meanwhile, or unreadable: left for the next run
    }
  }
  kept.sort((a, b) => a.mtime - b.mtime);
  let total = kept.reduce((t, k) => t + k.size, 0);
  for (const k of kept) {
    if (total <= maxBytes) break;
    try {
      await fs.rm(k.f, { force: true });
      removed.push(k.f);
      total -= k.size;
    } catch {
      // left for the next run
    }
  }
  return removed;
}

/** Resolves once pending snapshot writes are done (tests, shutdown). */
export function flushTranscriptCache(): Promise<void> {
  return writing;
}

function forget(key: string): void {
  memoryBytes -= memory.get(key)?.bytes ?? 0;
  memory.delete(key);
}

function remember(e: CacheEntry, bytes = JSON.stringify(e.state.out).length): void {
  forget(e.key);
  memory.set(e.key, { e, bytes });
  memoryBytes += bytes;
  // The entry just used stays even when it alone is past the cap.
  while (memoryBytes > memoryMax && memory.size > 1) forget(memory.keys().next().value!);
}

async function stillValid(fh: fs.FileHandle, e: CacheEntry, dev: string, ino: string, size: number): Promise<boolean> {
  if (e.dev !== dev || e.ino !== ino || size < e.offset) return false;
  if (sha1(await readAt(fh, 0, e.headLen)) !== e.headHash) return false;
  return sha1(await readAt(fh, e.offset - e.tailLen, e.tailLen)) === e.tailHash;
}

function feed(b: TranscriptBuilder, text: string): void {
  for (const line of text.split(LINE_END)) {
    const r = parseLine(line);
    if (r) b.add(r);
  }
}

/** A snapshot that passes the checks but still breaks the read is dropped, and the file read once more from the start. */
async function readCached(file: string, opts: Required<TranscriptOptions>, key: string): Promise<TranscriptMessage[]> {
  try {
    return await readCachedFrom(file, opts, key, true);
  } catch {
    forget(key);
    const f = snapshotFile(key);
    if (f) await fs.rm(f, { force: true }).catch(() => {});
    return readCachedFrom(file, opts, key, false);
  }
}

async function readCachedFrom(file: string, opts: Required<TranscriptOptions>, key: string, useCache: boolean): Promise<TranscriptMessage[]> {
  const fh = await fs.open(file, 'r');
  try {
    const st = await fh.stat({ bigint: true });
    const size = Number(st.size);
    const dev = String(st.dev);
    const ino = String(st.ino);
    const cached = useCache ? memory.get(key) : undefined;
    let entry = useCache ? (cached?.e ?? (await loadSnapshot(key))) : null;
    if (entry && !(await stillValid(fh, entry, dev, ino, size))) entry = null;
    forget(key); // the builder changes the state in place: not cached again until it is consistent
    const b = new TranscriptBuilder(opts, entry?.state);
    const start = entry?.offset ?? 0;
    let pos = start;
    let carry: Buffer = Buffer.alloc(0);
    while (pos < size) {
      const chunk = await readAt(fh, pos, Math.min(READ_CHUNK, size - pos));
      if (chunk.length === 0) break;
      pos += chunk.length;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const nl = buf.lastIndexOf(10);
      if (nl < 0) {
        carry = buf;
        continue;
      }
      feed(b, buf.toString('utf8', 0, nl + 1));
      carry = buf.subarray(nl + 1);
    }
    const offset = pos - carry.length;
    const state = b.state();
    const headLen = Math.min(FINGERPRINT_BYTES, offset);
    const tailLen = Math.min(FINGERPRINT_BYTES, offset);
    const next: CacheEntry = {
      file: path.resolve(file), key, dev, ino, offset, state,
      headLen, headHash: entry && entry.headLen === headLen ? entry.headHash : sha1(await readAt(fh, 0, headLen)),
      tailLen, tailHash: entry && offset === start && entry.tailLen === tailLen ? entry.tailHash : sha1(await readAt(fh, offset - tailLen, tailLen)),
    };
    // Nothing new read: the window (and so its size) is the cached one.
    remember(next, entry && offset === start && cached?.e === entry ? cached.bytes : undefined);
    if (offset !== start) saveSnapshot(next, opts.maxMessages);
    // A last line without its `\n` yet (being written, or the file's end): read like readline does, but not kept.
    let out = state.out;
    const tail = carry.toString('utf8');
    if (tail.split(LINE_END).some((l) => parseLine(l))) {
      const t = new TranscriptBuilder(opts, structuredClone({ ...state, out: state.out.slice(-1) }));
      feed(t, tail);
      out = [...state.out.slice(0, -1), ...t.state().out];
    }
    const res = out.slice(-opts.maxMessages);
    // The window's last entry may still grow on a later read; callers get their own copy.
    const shared = res.lastIndexOf(state.out[state.out.length - 1]!);
    if (shared >= 0) res[shared] = structuredClone(res[shared]!);
    return res;
  } finally {
    await fh.close();
  }
}

/**
 * The transcript's last messages (default: 200, 8 KB per tool result). Large sessions reach hundreds of MB, so a bounded
 * window is read incrementally: where the last read stopped is cached (memory, plus a snapshot under
 * `setTranscriptCacheDir`) and only what was appended since is read. Same output as `readTranscriptUncached`.
 */
export async function readTranscript(file: string, opts: TranscriptOptions = {}): Promise<TranscriptMessage[]> {
  const o = { maxMessages: opts.maxMessages ?? 200, maxToolResultChars: opts.maxToolResultChars ?? 8192 };
  // An unbounded window (search) is not kept: it would hold the whole session. (`slice(-0)` makes 0 unbounded too.)
  if (!Number.isFinite(o.maxMessages) || o.maxMessages < 1) return readTranscriptUncached(file, o);
  const key = `${CODE_VERSION}\0${o.maxMessages}\0${o.maxToolResultChars}\0${path.resolve(file)}`;
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => readCached(file, o, key));
  locks.set(key, run);
  const done = () => {
    if (locks.get(key) === run) locks.delete(key);
  };
  run.then(done, done);
  return run;
}

/** The text of a user prompt record or folded steer (what the transcript shows as a user message, counted by `n`), else null. */
function promptText(r: Rec, seen: SeenPrompts): string | null {
  const q = queuedPrompt(r);
  if (q) {
    const t = textOfContent(q.content);
    return t && seen.first(q.source) ? t : null;
  }
  if (!isRealUser(r)) return null;
  const content = message(r)?.content;
  if (Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as Rec).type === 'tool_result')) return null;
  const t = textOfContent(content);
  return t && seen.first(typeof r.uuid === 'string' ? r.uuid : null) ? t : null;
}

/** An image block of a user message, decoded (base64 source only), and the file state it was read from. */
export type TranscriptImage = { mediaType: string; data: Buffer; file: { ino: number; size: number; mtimeMs: number } };

/**
 * Where user messages start in one transcript (`readUserImage`), one per path: `offsets[n]` = the byte where user message
 * `n`'s line starts; `pos`/`seen` = how far the scan got (always a line start) and the steer ids seen up to there (a later
 * `n` reads on from `pos`). `ino`/`size`/`mtimeMs` = the file it was built on, `tail` = its last bytes before `pos`: a
 * session that grew keeps its index and reads on; a shorter, replaced or rewritten file (a fork resolve) starts over.
 */
type ImageIndex = { ino: number; size: number; mtimeMs: number; offsets: number[]; pos: number; seen: SeenPrompts; done: boolean; tail: Buffer };
const IMAGE_INDEX_FILES = 16;
const IMAGE_TAIL = 256;
const imageIndexes = new Map<string, ImageIndex>();
/** One `readUserImage` at a time per path (a page asks for its thumbnails together). */
const imageLocks = new Map<string, Promise<unknown>>();
const IMAGE_CHUNK = 1 << 20;

async function readRange(fh: fs.FileHandle, at: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, at);
  return buf.subarray(0, bytesRead);
}

/** The line starting at byte `at` (without its `\n`). */
async function lineAt(fh: fs.FileHandle, at: number, size: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (let pos = at; pos < size; ) {
    const buf = Buffer.allocUnsafe(Math.min(IMAGE_CHUNK, size - pos));
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    if (!bytesRead) break;
    const nl = buf.subarray(0, bytesRead).indexOf(10);
    parts.push(buf.subarray(0, nl >= 0 ? nl : bytesRead));
    if (nl >= 0) break;
    pos += bytesRead;
  }
  return Buffer.concat(parts);
}

/**
 * Whether a line can be a user message (`promptText`), checked on the raw bytes so the rest is never parsed: it must be a
 * user record (`"user"`) or a queued_command attachment. A user record with a tool_result block is never one (`promptText`
 * rejects any content holding one, text or not) — and tool results are most of a session's user records by size. Quotes
 * inside JSON strings are escaped, so `"user"` / `"tool_result"` only match as keys or whole values.
 */
const mayBePrompt = (line: Buffer) => line.includes('queued_command') || (line.includes('"user"') && !line.includes('"tool_result"'));

/** Reads on from `idx.pos` up to `size`, recording user message starts, until message `n` (its record) or the end (null). */
async function scanTo(fh: fs.FileHandle, idx: ImageIndex, n: number, size: number): Promise<Rec | null> {
  const check = (line: Buffer, start: number, seen: SeenPrompts): Rec | null => {
    if (!mayBePrompt(line)) return null;
    const r = parseLine(line.toString('utf8'));
    if (!r || promptText(r, seen) === null) return null;
    if (seen !== idx.seen) return idx.offsets.length === n ? r : null; // the unfinished last line: not recorded
    idx.offsets.push(start);
    return idx.offsets.length - 1 === n ? r : null;
  };
  const buf = Buffer.allocUnsafe(IMAGE_CHUNK);
  const carry: Buffer[] = [];
  let lineStart = idx.pos;
  for (let pos = idx.pos; pos < size; ) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
    if (!bytesRead) break;
    const chunk = buf.subarray(0, bytesRead);
    let s = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, s)) {
      carry.push(chunk.subarray(s, nl));
      const line = carry.length === 1 ? carry[0]! : Buffer.concat(carry);
      carry.length = 0;
      const r = check(line, lineStart, idx.seen);
      lineStart = idx.pos = pos + nl + 1;
      s = nl + 1;
      if (r) return r;
    }
    if (s < bytesRead) carry.push(Buffer.from(chunk.subarray(s))); // `buf` is reused: keep a copy
    pos += bytesRead;
  }
  idx.done = true;
  // The last line without its `\n` (readline reads it too): it may still be being written, so `pos` stays at its start
  // and it is checked against a copy of `seen` — a later, longer file reads it again in full.
  return carry.length ? check(Buffer.concat(carry), lineStart, new SeenPrompts(idx.seen.list())) : null;
}

/** This path's index for the file state `st` (`fh`'s): kept, read on from, or new. Most recently used last. */
async function imageIndexFor(key: string, fh: fs.FileHandle, st: { ino: number; size: number; mtimeMs: number }): Promise<ImageIndex> {
  let idx = imageIndexes.get(key);
  imageIndexes.delete(key);
  if (idx && !(idx.ino === st.ino && idx.size === st.size && idx.mtimeMs === st.mtimeMs)) {
    // Grown: the same file only if what was read before is still there (its last bytes before `pos`).
    const grown = idx.ino === st.ino && st.size > idx.size && (await readRange(fh, idx.pos - idx.tail.length, idx.tail.length)).equals(idx.tail);
    if (grown) Object.assign(idx, { size: st.size, mtimeMs: st.mtimeMs, done: false });
    else idx = undefined;
  }
  idx ??= { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offsets: [], pos: 0, seen: new SeenPrompts(), done: false, tail: Buffer.alloc(0) };
  imageIndexes.set(key, idx);
  while (imageIndexes.size > IMAGE_INDEX_FILES) imageIndexes.delete(imageIndexes.keys().next().value!);
  return idx;
}

/**
 * 'historyImages': the `k`-th image block of user message `n` (counted as `promptText` / the branch point counts `n`),
 * or null. Only base64 sources of the given media types. Sessions reach hundreds of MB: only candidate lines are parsed,
 * and where each message starts is kept per path (`ImageIndex`), so a session's next thumbnails read one line each and a
 * growing session reads only what was appended.
 */
export async function readUserImage(file: string, n: number, k: number, types: ReadonlySet<string>): Promise<TranscriptImage | null> {
  const key = path.resolve(file);
  const run = (imageLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const fh = await fs.open(file, 'r');
    try {
      const st = await fh.stat();
      const version = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
      const idx = await imageIndexFor(key, fh, version);
      let r: Rec | null = null;
      if (n < idx.offsets.length) r = parseLine((await lineAt(fh, idx.offsets[n]!, st.size)).toString('utf8'));
      else if (!idx.done) {
        try {
          r = await scanTo(fh, idx, n, st.size);
        } finally {
          idx.tail = await readRange(fh, Math.max(0, idx.pos - IMAGE_TAIL), Math.min(IMAGE_TAIL, idx.pos));
        }
      }
      return { content: r ? (queuedPrompt(r)?.content ?? message(r)?.content) : undefined, version };
    } finally {
      await fh.close();
    }
  });
  imageLocks.set(key, run);
  const done = () => {
    if (imageLocks.get(key) === run) imageLocks.delete(key);
  };
  run.then(done, done);
  const { content, version } = await run;
  if (!Array.isArray(content)) return null;
  const block = content.filter((b) => b && typeof b === 'object' && (b as Rec).type === 'image')[k] as Rec | undefined;
  const src = block?.source as Rec | undefined;
  if (!src || src.type !== 'base64' || typeof src.media_type !== 'string' || typeof src.data !== 'string' || !types.has(src.media_type)) return null;
  const data = Buffer.from(src.data, 'base64');
  return data.length ? { mediaType: src.media_type, data, file: version } : null;
}

/** Test hook: how far `readUserImage`'s index for a path got (null = not cached). */
export function imageIndexState(file: string): { messages: number; pos: number; size: number } | null {
  const idx = imageIndexes.get(path.resolve(file));
  return idx ? { messages: idx.offsets.length, pos: idx.pos, size: idx.size } : null;
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

/**
 * 메시지 편집 갈래: where to fork a Claude transcript so user message `n` is replaced.
 * `at` = the chain entry the message was appended after (its `parentUuid`, else the last chain entry before it): the
 * kept turn's last entry, which `resumeSessionAt` accepts. null = the message opens the conversation (no history to keep).
 * `expect` (the text the user saw, injected blocks stripped): the chosen message must contain it; when message `n`
 * does not (e.g. the device counted differently), the nearest message that does is taken. Null = not found.
 */
export type BranchPoint = { n: number; at: string | null; uuid: string | null };

/** Line-by-line `findBranchPoint`: `feed` returns true once the answer is known (stop reading). */
function branchScanner(n: number, expect?: string): { feed(line: string): boolean; result(): BranchPoint | null } {
  const want = expect ? squash(expect) : '';
  let lastUuid: string | null = null;
  let count = 0;
  let best: BranchPoint | null = null;
  let done = false;
  const seen = new SeenPrompts();
  return {
    feed(line) {
      if (done) return true;
      const r = parseLine(line);
      if (!r) return false;
      const t = promptText(r, seen);
      if (t !== null) {
        const k = count++;
        if (!want || squash(t).includes(want)) {
          const parent = typeof r.parentUuid === 'string' && r.parentUuid ? r.parentUuid : null;
          const cand: BranchPoint = { n: k, at: parent ?? (k === 0 ? null : lastUuid), uuid: typeof r.uuid === 'string' ? r.uuid : null };
          if (k === n || !best || Math.abs(k - n) < Math.abs(best.n - n)) best = cand;
          // Exact hit, or past `n` and only moving away from it.
          if (k >= n) done = true;
        }
      }
      if (typeof r.uuid === 'string' && r.uuid && !r.isSidechain && 'parentUuid' in r) lastUuid = r.uuid;
      return done;
    },
    // Without a text to match only message `n` itself will do.
    result: () => (want || best?.n === n ? best : null),
  };
}

export function findBranchPoint(lines: Iterable<string>, n: number, expect?: string): BranchPoint | null {
  const scan = branchScanner(n, expect);
  for (const line of lines) if (scan.feed(line)) break;
  return scan.result();
}

/** `findBranchPoint` over a transcript file, streamed (sessions reach hundreds of MB). */
export async function readBranchPoint(file: string, n: number, expect?: string): Promise<BranchPoint | null> {
  const scan = branchScanner(n, expect);
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) if (scan.feed(line)) break;
  } finally {
    rl.close();
  }
  return scan.result();
}
