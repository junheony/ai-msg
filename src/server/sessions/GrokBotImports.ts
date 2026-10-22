import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionEntry, TranscriptMessage } from '../../shared/session-types';
import type { GrokBotUsage } from '../../shared/usage-types';
import { singleFlight, type ImportIndex } from './ImportIndex';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const UNTITLED = '(제목 없음)';
/** Session ids of Grok Bot entries: `grokbot-<agent id>` (no `:` — PinStore.isPinnableId). */
export const GROKBOT_ID_PREFIX = 'grokbot-';
const AGENT_ID = /^[A-Za-z0-9-]{1,100}$/;

export const GROKBOT_READONLY_NOTICE = 'Grok Bot 앱 대화는 읽기만 할 수 있어요 — 이어 쓰려면 아래 “새 Grok 세션으로 이어가기”를 누르세요';
export const GROKBOT_SEND_REFUSED = 'Grok Bot 앱 대화에는 보낼 수 없어요 — “새 Grok 세션으로 이어가기”로 이어 쓰세요';

export type GrokBotBlobKind = 'roster' | 'transcript' | 'usage';

/** The only blobs this module opens (allowlist on the decoded key). Everything else in the folder — and anything outside it — is never read. */
const ALLOWED: [GrokBotBlobKind, RegExp][] = [
  ['roster', /^sand\.client\.slice\.account\..+\.roster\.last-roster$/],
  ['transcript', /^sand\.client\.slice\.account\..+\.transcript\.replicas\.([A-Za-z0-9-]{1,100})$/],
  ['usage', /^sand\.client\.slice\.account\..+\.weekly-usage\.cache$/],
];
/** Measured `schemaVersion`s (2026-10-18); any other value is skipped. */
export const KNOWN_SCHEMA: Record<GrokBotBlobKind, readonly number[]> = { roster: [4], transcript: [1], usage: [2] };

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 (padding optional) of a `.blob` file name, as UTF-8; null when it is not that. */
export function decodeBlobKey(fileName: string): string | null {
  if (!fileName.endsWith('.blob')) return null;
  const s = fileName.slice(0, -5).replace(/=+$/, '').toUpperCase();
  if (!s) return null;
  let bits = 0;
  let val = 0;
  const out: number[] = [];
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i < 0) return null;
    val = ((val << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((val >> (bits - 8)) & 0xff); bits -= 8; }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(out)); } catch { return null; }
}

/** Which allowed blob a file name is (and the agent id of a transcript), or null = never open it. */
export function classifyBlob(fileName: string): { kind: GrokBotBlobKind; agentId?: string } | null {
  const key = decodeBlobKey(fileName);
  if (!key) return null;
  for (const [kind, re] of ALLOWED) {
    const m = re.exec(key);
    if (m) return kind === 'transcript' ? { kind, agentId: m[1]! } : { kind };
  }
  return null;
}

const warned = new Set<string>();

/** An allowed blob's `value` when its `schemaVersion` is known; null otherwise (unknown version: one log line per kind). Refuses any file name off the allowlist, and anything but a regular file (a symlink is never followed). */
export async function readBlob(file: string, kind: GrokBotBlobKind, log: (m: string) => void = (m) => console.log(m)): Promise<unknown> {
  if (classifyBlob(path.basename(file))?.kind !== kind) return null;
  if (!(await fs.lstat(file).then((st) => st.isFile(), () => false))) return null;
  let r: Rec | null;
  try { r = rec(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { return null; }
  if (!r) return null;
  if (typeof r.schemaVersion !== 'number' || !KNOWN_SCHEMA[kind].includes(r.schemaVersion)) {
    if (!warned.has(kind)) { warned.add(kind); log(`grok bot: unknown ${kind} schemaVersion ${String(r.schemaVersion)}, skipped`); }
    return null;
  }
  return r.value;
}

type Blobs = { rosters: string[]; transcripts: Map<string, string>; usage: string[] };

/** The allowed blobs in `dir` that are regular files (one readdir; nothing is opened, symlinks are left out). */
async function listBlobs(dir: string): Promise<Blobs | null> {
  let names: string[];
  try { names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name); } catch { return null; }
  const out: Blobs = { rosters: [], transcripts: new Map(), usage: [] };
  for (const n of names) {
    const c = classifyBlob(n);
    if (!c) continue;
    const file = path.join(dir, n);
    if (c.kind === 'roster') out.rosters.push(file);
    else if (c.kind === 'usage') out.usage.push(file);
    else out.transcripts.set(c.agentId!, file);
  }
  return out;
}

const oneLine = (s: string, max = 200) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** A roster row as a read-only Grok entry; null for hidden or malformed rows. */
export function grokBotRowToEntry(row: unknown, home: string, rosterFile: string, transcript: string | undefined): SessionEntry | null {
  const r = rec(row);
  const id = str(r?.id);
  if (!r || !id || !AGENT_ID.test(id) || r.isHiddenFromSidebar === true) return null;
  const last = rec(r.lastEntry);
  const preview = str(last?.text);
  const description = str(r.description);
  return {
    sessionId: GROKBOT_ID_PREFIX + id, account: 'x1', engine: 'grok', source: 'grokbot', cwd: home, projectDir: path.dirname(rosterFile),
    file: transcript ?? rosterFile, title: str(r.name) ?? str(r.title) ?? UNTITLED,
    lastModified: num(r.lastActivityAt) ?? num(r.updatedAt) ?? 0, sizeBytes: 0, imported: true, readOnly: true,
    ...(preview ? { preview: oneLine(preview) } : {}),
    grokBot: {
      ...(description ? { description: oneLine(description) } : {}),
      awaitingUserResponse: Boolean(r.awaitingUserResponse ?? false),
      unreadCount: Math.max(0, num(r.unreadCount) ?? 0),
      isGroup: r.isGroup === true,
    },
  };
}

/** A transcript blob as messages, in `seq` order: `message` = the user's turn, `send-message` = the bot's (design §2.4, 개정 2판). */
export async function readGrokBotTranscript(file: string): Promise<TranscriptMessage[]> {
  const v = rec(await readBlob(file, 'transcript'));
  const entries = Array.isArray(v?.entries) ? v.entries.map(rec).filter((e): e is Rec => !!e) : [];
  entries.sort((a, b) => (num(a.seq) ?? 0) - (num(b.seq) ?? 0));
  const out: TranscriptMessage[] = [];
  const ts = (e: Rec) => { const t = num(e.timestampMs); return t !== null ? new Date(t).toISOString() : null; };
  const bot = (e: Rec, text: string) => out.push({ kind: 'assistant', text, model: null, toolCalls: [], ts: ts(e) });
  const user = (e: Rec, text: string) => out.push({ kind: 'user', text, ts: ts(e) });
  for (const e of entries) {
    if (e.kind === 'message') {
      const t = str(e.content);
      if (t && (e.role === undefined || e.role === 'user')) user(e, t);
    } else if (e.kind === 'voice-call') {
      user(e, '[음성 통화]');
    } else if (e.kind === 'send-message') {
      const m = rec(e.message);
      if (!m) continue;
      if (m.type === 'text') {
        const t = str(m.content);
        if (t) bot(e, t);
      } else if (m.type === 'widget') {
        const w = rec(m.widget);
        const labels = (Array.isArray(w?.options) ? w.options : []).flatMap((o) => { const l = str(rec(o)?.label); return l ? [oneLine(l, 60)] : []; }).slice(0, 5);
        const prompt = str(w?.prompt);
        bot(e, `${prompt ? `${oneLine(prompt)} ` : ''}[선택지: ${labels.length ? labels.join(' · ') : '없음'}]`);
        const answer = str(e.respondedValue);
        if (answer) user(e, answer);
        else if (e.widgetSkipped) user(e, '[건너뜀]');
      } else if (m.type === 'local-tool-permission') {
        const a = rec(m.ask);
        bot(e, `[권한 요청: ${[str(a?.action), str(a?.target)].filter(Boolean).map((s) => oneLine(s!, 120)).join(' ') || '도구'}]`);
      } else if (m.type === 'attachment') {
        bot(e, `[첨부: ${oneLine(str(m.file_name) ?? '파일', 120)}]`);
      }
    }
  }
  return out;
}

/** The app's cached weekly usage when it is `present` and not expired; the newest of the accounts' caches. */
export async function readGrokBotWeeklyUsage(files: string[], nowMs = Date.now()): Promise<GrokBotUsage | null> {
  let best: GrokBotUsage | null = null;
  for (const f of files) {
    const v = rec(await readBlob(f, 'usage'));
    if (v?.kind !== 'present') continue;
    const expires = num(v.expiresAtMs);
    if (expires !== null && expires <= nowMs) continue;
    const reading = rec(v.reading);
    const u = rec(reading?.usage);
    const percentUsed = num(u?.percentUsed);
    const readAtMs = num(reading?.readAtMs);
    if (percentUsed === null || readAtMs === null) continue;
    const next: GrokBotUsage = { percentUsed, nextResetMs: num(u?.nextResetMs), planLabel: str(u?.grokPlanLabel), readAtMs };
    if (!best || next.readAtMs > best.readAtMs) best = next;
  }
  return best;
}

/**
 * Grok Bot app conversations (macOS), read-only: the roster blobs as Grok entries with `source: 'grokbot'`.
 * `dir` null or missing = silently none. Only allowlisted blobs are ever opened (see ALLOWED); a roster is re-read
 * when its mtime / size changed, and a blob that fails to parse keeps the previous rows. `onUsage` gets the weekly
 * usage cache after each scan (null when absent / expired).
 */
export class GrokBotIndex implements ImportIndex {
  private stamps = new Map<string, string>();
  private rows = new Map<string, unknown[]>();
  private transcripts = new Map<string, string>();
  private entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  readonly refresh: () => Promise<void>;
  onUsage: ((u: GrokBotUsage | null) => void) | null = null;

  constructor(private readonly dir: string | null, private readonly home: string, private readonly now: () => number = () => Date.now()) {
    this.refresh = singleFlight(() => this.scan());
  }

  private async scan(): Promise<void> {
    const blobs = this.dir ? await listBlobs(this.dir) : null;
    if (!blobs) { this.entries = []; this.byId = new Map(); return; }
    for (const f of blobs.rosters) {
      const st = await fs.stat(f).catch(() => null);
      if (!st) continue;
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (this.stamps.get(f) === stamp) continue;
      const v = rec(await readBlob(f, 'roster'));
      if (!v || !Array.isArray(v.rows)) continue;
      this.rows.set(f, v.rows);
      this.stamps.set(f, stamp);
    }
    for (const k of [...this.rows.keys()]) if (!blobs.rosters.includes(k)) { this.rows.delete(k); this.stamps.delete(k); }
    this.transcripts = blobs.transcripts;
    const byId = new Map<string, SessionEntry>();
    for (const [f, rows] of this.rows) {
      for (const row of rows) {
        const id = str(rec(row)?.id);
        const e = grokBotRowToEntry(row, this.home, f, id ? blobs.transcripts.get(id) : undefined);
        if (e && (byId.get(e.sessionId)?.lastModified ?? -1) < e.lastModified) byId.set(e.sessionId, e);
      }
    }
    this.byId = byId;
    this.entries = [...byId.values()];
    if (this.onUsage) this.onUsage(await readGrokBotWeeklyUsage(blobs.usage, this.now()).catch(() => null));
  }

  list(): SessionEntry[] {
    return this.entries;
  }

  lookup(id: string): SessionEntry | null {
    return this.byId.get(id) ?? null;
  }

  /** The conversation's messages (empty when the app has not cached it). */
  async transcript(id: string): Promise<TranscriptMessage[]> {
    const e = this.byId.get(id);
    const file = e ? this.transcripts.get(id.slice(GROKBOT_ID_PREFIX.length)) : undefined;
    return file ? readGrokBotTranscript(file).catch(() => []) : [];
  }

  async activeAgeMs(): Promise<number | null> {
    return null;
  }
}
