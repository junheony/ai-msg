import fs from 'node:fs';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import { addDays, familyOf, localDay, type ModelFamily, type UsageHistory, type UsageRow, type UsageSource } from '../../shared/token-usage';

/** [input, output, cacheRead, cacheWrite, messages] — compact on disk. */
type Bucket = [number, number, number, number, number];
/** Codex `total_token_usage` seen so far in one rollout: [input incl. cached, cached, cacheWrite, output]. */
type CodexTotal = [number, number, number, number];

type FileState = { source: UsageSource; size: number; ino: number; offset: number; codexTotal?: CodexTotal };

type IndexFile = {
  version: 1;
  lastScanAt: string | null;
  files: Record<string, FileState>;
  /** Bytes of the `.seen` log this file's counts include (anything beyond is from a save that never finished). */
  seenLen?: number;
  /** Legacy (pre-log) inline dedupe map; migrated into the `.seen` log on load. */
  seen?: Record<string, number>;
  /** `${day}|${source|all}|${family}` → counts. */
  buckets: Record<string, Bucket>;
};

const VERSION = 1;
const ACCOUNT_BIT: Record<Account, number> = { a: 1, b: 2, c: 4 };
const GLOBAL_BIT = 8;
const SAVE_EVERY_MS = 30_000;
const CHUNK = 1024 * 1024;
const NL = 0x0a;
const CLAUDE_NEEDLE = Buffer.from('"usage"');
const CODEX_NEEDLES = [Buffer.from('"token_count"')];

export type UsageIndexOpts = {
  /** Claude `projects` dir per account (transcripts + `<id>/subagents/*.jsonl`). */
  projectsRoots: Record<Account, string>;
  /** `$CODEX_HOME/sessions` (rollout jsonl files). */
  codexSessionsRoot: string;
  /** Cache file (`~/.config/deck/usage-index.json`). */
  indexFile: string;
  intervalMs?: number;
  now?: () => Date;
};

function emptyIndex(): IndexFile {
  return { version: VERSION, lastScanAt: null, files: {}, buckets: {} };
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/** null when the root can't be listed (missing or unreadable). */
async function walkJsonl(root: string, accept: (rel: string) => boolean): Promise<string[] | null> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(root, { recursive: true });
  } catch {
    return null;
  }
  return entries.filter((rel) => rel.endsWith('.jsonl') && accept(rel)).map((rel) => path.join(root, rel));
}

/**
 * Token usage history from the transcripts themselves. Each refresh reads only bytes appended since the last
 * one (offsets per file, complete lines only), streaming in 1 MiB chunks and yielding between files, and keeps
 * the aggregates plus offsets in one JSON cache so a restart resumes where it stopped.
 *
 * Claude: assistant lines' `message.usage`, deduped by `message.id` (one message is written as several lines,
 * and copied sessions repeat whole prefixes) — per account within that account, and once more across accounts
 * for the global total. Re-reading a file is therefore harmless. Codex: deltas of each rollout's cumulative
 * `token_count.info.total_token_usage` (repeated events add nothing).
 */
export class UsageIndex {
  private state: IndexFile = emptyIndex();
  private loaded = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSave = 0;
  /**
   * message id → `mask | maxOutput * 16`: mask = accounts that counted it (a=1, b=2, c=4) plus GLOBAL once the
   * global total did; maxOutput = the largest output_tokens seen for it (every counted target holds exactly that).
   * Persisted as an append-only log (`<indexFile>.seen`), not inside the JSON that is rewritten on every save.
   */
  private seen = new Map<string, number>();
  private dirtySeen = new Map<string, number>();
  private seenLines = 0;
  private readonly now: () => Date;

  constructor(private readonly opts: UsageIndexOpts) {
    this.now = opts.now ?? (() => new Date());
  }

  get scanning(): boolean {
    return this.running !== null;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.intervalMs ?? 10 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan at a time; a call during a scan joins it. */
  refresh(): Promise<void> {
    this.running ??= this.scan()
      .catch((err: unknown) => console.error('deck: usage index scan failed', err instanceof Error ? err.message : String(err)))
      .finally(() => { this.running = null; });
    return this.running;
  }

  /** Rows for the last `days` local days (today included). */
  history(days: number): UsageHistory {
    const today = localDay(this.now());
    const from = addDays(today, -(days - 1));
    const rows: UsageRow[] = [];
    for (const [key, b] of Object.entries(this.state.buckets)) {
      const [day, source, family] = key.split('|') as [string, UsageSource | 'all', ModelFamily];
      if (day < from || day > today) continue;
      rows.push({ day, source, family, input: b[0], output: b[1], cacheRead: b[2], cacheWrite: b[3], messages: b[4] });
    }
    rows.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
    return { generatedAt: this.now().toISOString(), days, lastScanAt: this.state.lastScanAt, scanning: this.scanning, rows };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.opts.indexFile, 'utf8')) as IndexFile;
      if (raw?.version === VERSION && raw.files && raw.buckets) {
        this.state = raw;
        if (raw.seen) {
          for (const [id, v] of Object.entries(raw.seen)) { this.seen.set(id, v); this.dirtySeen.set(id, v); }
          delete this.state.seen;
        } else {
          await this.loadSeen(raw.seenLen ?? 0);
        }
        return;
      }
    } catch {
      // missing or unreadable: start over (Claude counts are idempotent by message id)
    }
    // Counts start from zero, so a leftover dedupe log would make messages count as already seen.
    await fs.promises.rm(this.seenFile, { force: true });
  }

  private get seenFile(): string {
    return `${this.opts.indexFile}.seen`;
  }

  private async loadSeen(len: number): Promise<void> {
    let buf: Buffer;
    try { buf = (await fs.promises.readFile(this.seenFile)).subarray(0, len); } catch { return; }
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    for (const line of end < 0 ? [] : text.slice(0, end).split('\n')) {
      const tab = line.indexOf('\t');
      const v = Number(line.slice(tab + 1));
      if (tab > 0 && Number.isFinite(v)) { this.seen.set(line.slice(0, tab), v); this.seenLines++; }
    }
    // Drop what a crashed save left beyond the counted part, so appends continue from a clean tail.
    if (buf.length < (await fs.promises.stat(this.seenFile)).size) await fs.promises.truncate(this.seenFile, buf.length);
  }

  private async save(): Promise<void> {
    this.lastSave = Date.now();
    await fs.promises.mkdir(path.dirname(this.opts.indexFile), { recursive: true, mode: 0o700 });
    // The dedupe log first: a crash between the two leaves it ahead of the counts, never behind.
    if (this.seenLines > 2 * this.seen.size + 10_000) {
      this.dirtySeen.clear();
      this.seenLines = this.seen.size;
      const all = [...this.seen].map(([id, v]) => `${id}\t${v}\n`).join('');
      await fs.promises.writeFile(`${this.seenFile}.tmp`, all, { mode: 0o600 });
      await fs.promises.rename(`${this.seenFile}.tmp`, this.seenFile);
    } else if (this.dirtySeen.size) {
      const add = [...this.dirtySeen].map(([id, v]) => `${id}\t${v}\n`).join('');
      await fs.promises.appendFile(this.seenFile, add, { mode: 0o600 });
      this.seenLines += this.dirtySeen.size;
      this.dirtySeen.clear();
    }
    this.state.seenLen = (await fs.promises.stat(this.seenFile).catch(() => ({ size: 0 }))).size;
    const tmp = `${this.opts.indexFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
    await fs.promises.rename(tmp, this.opts.indexFile);
  }

  private async scan(): Promise<void> {
    await this.load();
    const targets: { file: string; source: UsageSource }[] = [];
    const unlisted: string[] = [];
    const roots: { root: string; source: UsageSource; accept: (rel: string) => boolean }[] = [
      // Transcripts and subagent transcripts; tool-result dumps and other sidecars are not jsonl.
      ...(['a', 'b', 'c'] as const).map((a) => ({ root: this.opts.projectsRoots[a], source: a, accept: () => true })),
      { root: this.opts.codexSessionsRoot, source: 'codex', accept: (rel) => path.basename(rel).startsWith('rollout-') },
    ];
    for (const { root, source, accept } of roots) {
      const files = await walkJsonl(root, accept);
      if (!files) { unlisted.push(root + path.sep); continue; }
      for (const file of files) targets.push({ file, source });
    }

    let changed = false;
    const live = new Set<string>();
    for (const { file, source } of targets) {
      live.add(file);
      try {
        if (await this.scanFile(file, source)) changed = true;
      } catch (err) {
        console.error('deck: usage index read failed', file, err instanceof Error ? err.message : String(err));
      }
      await yieldLoop();
      if (changed && Date.now() - this.lastSave > SAVE_EVERY_MS) await this.save();
    }
    // Deleted files: drop their offsets; what they contributed stays (that usage happened). A root that could
    // not be listed this time keeps its offsets, so a transient error never causes a Codex re-count.
    for (const f of Object.keys(this.state.files)) {
      if (!live.has(f) && !unlisted.some((r) => f.startsWith(r))) delete this.state.files[f];
    }
    this.state.lastScanAt = this.now().toISOString();
    await this.save();
  }

  /** True when anything was read. */
  private async scanFile(file: string, source: UsageSource): Promise<boolean> {
    const st = await fs.promises.stat(file);
    let fs0 = this.state.files[file];
    if (fs0 && fs0.source === source && fs0.ino === st.ino && st.size === fs0.offset) return false;
    if (!fs0 || fs0.source !== source || fs0.ino !== st.ino || st.size < fs0.offset) {
      // New, replaced or truncated: read from the start (Claude: idempotent; Codex: baseline restarts).
      fs0 = { source, size: st.size, ino: st.ino, offset: 0, ...(source === 'codex' ? { codexTotal: [0, 0, 0, 0] as CodexTotal } : {}) };
      this.state.files[file] = fs0;
    }
    if (st.size <= fs0.offset) return false;
    const state = fs0;
    const onLine = source === 'codex' ? (line: Buffer) => this.codexLine(line, state) : (line: Buffer) => this.claudeLine(line, source);
    await readLines(file, state.offset, st.size, (line, endOffset) => {
      onLine(line);
      state.offset = endOffset;
    });
    state.size = st.size;
    return true;
  }

  private add(day: string, source: UsageSource | 'all', family: ModelFamily, c: Bucket): void {
    const key = `${day}|${source}|${family}`;
    const b = (this.state.buckets[key] ??= [0, 0, 0, 0, 0]);
    for (let i = 0; i < 5; i++) b[i]! += c[i]!;
  }

  private claudeLine(line: Buffer, account: Account): void {
    if (!line.includes(CLAUDE_NEEDLE)) return;
    let o: { type?: unknown; timestamp?: unknown; requestId?: unknown; uuid?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    try { o = JSON.parse(line.toString('utf8')) as typeof o; } catch { return; }
    const m = o?.message;
    const u = m?.usage;
    if (o.type !== 'assistant' || !u || typeof u !== 'object' || m.model === '<synthetic>') return;
    const id = typeof m.id === 'string' ? m.id : typeof o.requestId === 'string' ? o.requestId : typeof o.uuid === 'string' ? o.uuid : null;
    const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (!id || Number.isNaN(t)) return;
    const n = (k: string) => { const v = u[k]; return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0; };
    const c: Bucket = [n('input_tokens'), n('output_tokens'), n('cache_read_input_tokens'), n('cache_creation_input_tokens'), 1];
    if (c[0] + c[1] + c[2] + c[3] === 0) return;
    const prev = this.seen.get(id) ?? 0;
    const mask = prev & 15;
    const maxOut = Math.floor(prev / 16);
    const bit = ACCOUNT_BIT[account];
    const newMax = Math.max(maxOut, c[1]);
    if (mask & bit && newMax === maxOut) return;
    const day = localDay(new Date(t));
    const family = familyOf(typeof m.model === 'string' ? m.model : null);
    // A later line of the same message can carry a larger output_tokens: top up every target that counted it.
    const full: Bucket = [c[0], newMax, c[2], c[3], 1];
    if (!(mask & bit)) this.add(day, account, family, full);
    if (!(mask & GLOBAL_BIT)) this.add(day, 'all', family, full);
    if (newMax > maxOut && mask) {
      const top: Bucket = [0, newMax - maxOut, 0, 0, 0];
      for (const a of ['a', 'b', 'c'] as const) if (mask & ACCOUNT_BIT[a]) this.add(day, a, family, top);
      if (mask & GLOBAL_BIT) this.add(day, 'all', family, top);
    }
    const next = (mask | bit | GLOBAL_BIT) + newMax * 16;
    this.seen.set(id, next);
    this.dirtySeen.set(id, next);
  }

  private codexLine(line: Buffer, state: FileState): void {
    if (!CODEX_NEEDLES.some((nd) => line.includes(nd))) return;
    let o: { type?: unknown; timestamp?: unknown; payload?: { type?: unknown; info?: { total_token_usage?: Record<string, unknown>; last_token_usage?: Record<string, unknown> } | null } };
    try { o = JSON.parse(line.toString('utf8')) as typeof o; } catch { return; }
    const p = o?.payload;
    if (o.type !== 'event_msg' || p?.type !== 'token_count' || !p.info?.total_token_usage) return;
    const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isNaN(t)) return;
    const vec = (u: Record<string, unknown> | undefined): CodexTotal => {
      const n = (k: string) => { const v = u?.[k]; return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0; };
      return [n('input_tokens'), n('cached_input_tokens'), n('cache_write_input_tokens'), n('output_tokens')];
    };
    const total = vec(p.info.total_token_usage);
    const prev = state.codexTotal ?? [0, 0, 0, 0];
    // A cumulative counter that went backwards (compaction/reset): this event's own usage is the delta.
    const d: CodexTotal = total.some((v, i) => v < prev[i]!) ? vec(p.info.last_token_usage) : (total.map((v, i) => v - prev[i]!) as CodexTotal);
    state.codexTotal = total;
    if (d[0] + d[2] + d[3] === 0) return;
    // Codex input includes its cached share; report them apart like Anthropic usage.
    this.add(localDay(new Date(t)), 'codex', 'gpt', [Math.max(0, d[0] - d[1]), d[3], d[1], d[2], 1]);
    this.add(localDay(new Date(t)), 'all', 'gpt', [Math.max(0, d[0] - d[1]), d[3], d[1], d[2], 1]);
  }
}

/**
 * Streams [start, end) and calls `onLine(line, offsetAfterLine)` for every complete (newline-terminated) line;
 * a trailing partial line is left for the next read.
 */
async function readLines(file: string, start: number, end: number, onLine: (line: Buffer, endOffset: number) => void): Promise<void> {
  const stream = fs.createReadStream(file, { start, end: end - 1, highWaterMark: CHUNK });
  let parts: Buffer[] = [];
  let pos = start; // file offset of the first byte of `parts`
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(NL); nl !== -1; nl = chunk.indexOf(NL, from)) {
      const piece = chunk.subarray(from, nl);
      const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
      pos += line.length + 1;
      parts = [];
      onLine(line, pos);
      from = nl + 1;
    }
    if (from < chunk.length) parts.push(chunk.subarray(from));
  }
}
