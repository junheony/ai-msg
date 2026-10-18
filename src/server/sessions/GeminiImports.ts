import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeminiAccount } from '../../shared/accounts';
import type { SessionEntry } from '../../shared/session-types';
import { isTempCwd, LIVE_ROLLOUT_MS } from './CodexImports';
import { singleFlight, type ImportIndex } from './ImportIndex';

const UNTITLED = '(제목 없음)';
export const SUMMARIES_DB = 'conversation_summaries.db';

export { GEMINI_IMPORT_NOTE } from '../../shared/handoff';

export type GeminiRow = {
  conversation_id: string; title: string | null; preview: string | null; step_count: number | null; last_modified_time: string | null;
  workspace_uris: string | null; status: string | null; parent_conversation_id: string | null; nesting_depth: number | null;
  killed: number | null; not_fully_idle: number | null;
};

const stampOf = async (file: string): Promise<string> => {
  const st = await fs.stat(file).catch(() => null);
  return st ? `${st.mtimeMs}:${st.size}` : '-';
};

/**
 * Copies `src` and its `-wal` (when there) into a fresh `tmpRoot/<uuid>/` — the originals are only read, nothing
 * is created next to them. Null when the copy fails or the originals changed while being copied (a torn copy).
 * The caller removes `dir`.
 */
export async function snapshotSqlite(src: string, tmpRoot: string): Promise<{ dir: string; db: string } | null> {
  const before = [await stampOf(src), await stampOf(`${src}-wal`)];
  if (before[0] === '-') return null;
  const dir = path.join(tmpRoot, randomUUID());
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const db = path.join(dir, path.basename(src));
    await fs.copyFile(src, db);
    if (before[1] !== '-') await fs.copyFile(`${src}-wal`, `${db}-wal`).catch(() => undefined);
    const after = [await stampOf(src), await stampOf(`${src}-wal`)];
    if (after[0] !== before[0] || after[1] !== before[1]) { await fs.rm(dir, { recursive: true, force: true }); return null; }
    return { dir, db };
  } catch {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

type SqliteModule = { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => { prepare(sql: string): { all(): unknown[] }; close(): void } };

/** `node:sqlite`, or null when this Node has none. */
export async function loadSqlite(): Promise<SqliteModule | null> {
  try { return (await import('node:sqlite')) as unknown as SqliteModule; } catch { return null; }
}

/** The summaries table of a (copied) db, opened normally (WAL frames count); null when sqlite is missing or the file is torn / not this schema. */
export async function readSummaries(copyPath: string, sqlite: () => Promise<SqliteModule | null> = loadSqlite): Promise<GeminiRow[] | null> {
  const mod = await sqlite();
  if (!mod) return null;
  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null;
  try {
    db = new mod.DatabaseSync(copyPath, { readOnly: true });
    return db.prepare('SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, parent_conversation_id, nesting_depth, killed, not_fully_idle FROM conversation_summaries').all() as GeminiRow[];
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** `YYYY-MM-DD HH:MM:SS.ffffff+00:00` → epoch ms (null when unparseable). */
export function parseGeminiTime(s: string | null): number | null {
  if (!s) return null;
  const iso = s.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function cwdOf(uris: string | null): string | null {
  let list: unknown;
  try { list = JSON.parse(uris ?? ''); } catch { return null; }
  const first = Array.isArray(list) ? list.find((u): u is string => typeof u === 'string' && u.startsWith('file://')) : null;
  if (!first) return null;
  try { return fileURLToPath(first); } catch { return null; }
}

/** A summaries row as a Gemini sidebar entry; null for sub-agent, killed, empty or folder-less conversations (design §5). `cwdGone`: whether its folder is missing. */
export function geminiRowToEntry(row: GeminiRow, account: GeminiAccount, db: string, cwdGone: (cwd: string) => boolean): SessionEntry | null {
  if (!row.conversation_id || (row.nesting_depth ?? 0) > 0 || (row.parent_conversation_id ?? '') !== '' || row.killed || !row.step_count) return null;
  const cwd = cwdOf(row.workspace_uris);
  if (!cwd) return null;
  const gone = cwdGone(cwd);
  if (gone && isTempCwd(cwd)) return null;
  const preview = row.preview?.trim() || null;
  return {
    sessionId: row.conversation_id, account, engine: 'gemini', cwd, projectDir: path.dirname(db), file: db,
    title: row.title?.trim() || preview?.split('\n')[0]?.slice(0, 80) || UNTITLED,
    lastModified: parseGeminiTime(row.last_modified_time) ?? 0, sizeBytes: 0, imported: true,
    ...(preview ? { preview: preview.slice(0, 200) } : {}),
    ...(gone ? { cwdMissing: true } : {}),
  };
}

/**
 * agy conversations from `<dir>/conversation_summaries.db` (design §2.2). The db is never opened in place: it and
 * its `-wal` are copied to `tmpRoot` and the copy is read, then removed — nothing is written under `~/.gemini`.
 * Re-copied only when either file's mtime / size changed; a torn copy or failed read keeps the last good list.
 */
export class GeminiConversationIndex implements ImportIndex {
  private stamps = new Map<string, string>();
  private rows = new Map<string, { row: GeminiRow; entry: SessionEntry }[]>();
  private byId = new Map<string, { row: GeminiRow; entry: SessionEntry }>();
  private entries: SessionEntry[] = [];
  readonly refresh: () => Promise<void>;

  constructor(
    private readonly roots: { account: GeminiAccount; dir: string }[],
    private readonly tmpRoot: string,
    private readonly sqlite: () => Promise<SqliteModule | null> = loadSqlite,
    private readonly snapshot: typeof snapshotSqlite = snapshotSqlite,
    private readonly log: (msg: string) => void = (m) => console.log(m),
  ) {
    this.refresh = singleFlight(() => this.scan());
  }

  private async scan(): Promise<void> {
    for (const { account, dir } of this.roots) {
      const db = path.join(dir, SUMMARIES_DB);
      const stamp = `${await stampOf(db)}|${await stampOf(`${db}-wal`)}`;
      if (stamp.startsWith('-|')) { this.rows.delete(dir); this.stamps.delete(dir); continue; }
      if (this.stamps.get(dir) === stamp) continue;
      const snap = await this.snapshot(db, this.tmpRoot);
      if (!snap) { this.log('gemini imports: copy changed while reading, keeping the last list'); continue; }
      try {
        const rows = await readSummaries(snap.db, this.sqlite);
        if (!rows) { this.log('gemini imports: summaries unreadable (sqlite missing or torn copy), keeping the last list'); continue; }
        const gone = new Map<string, boolean>();
        for (const r of rows) { const c = cwdOf(r.workspace_uris); if (c && !gone.has(c)) gone.set(c, !(await fs.stat(c).then((s) => s.isDirectory(), () => false))); }
        this.rows.set(dir, rows.flatMap((row) => { const entry = geminiRowToEntry(row, account, db, (c) => gone.get(c) ?? true); return entry ? [{ row, entry }] : []; }));
        this.stamps.set(dir, stamp);
      } finally {
        await fs.rm(snap.dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    this.byId = new Map([...this.rows.values()].flat().map((x) => [x.entry.sessionId, x]));
    this.entries = [...this.byId.values()].map((x) => x.entry);
  }

  list(): SessionEntry[] {
    return this.entries;
  }

  lookup(id: string): SessionEntry | null {
    return this.byId.get(id)?.entry ?? null;
  }

  /** 0 while agy reports the conversation running; else the age of `last_modified_time` when within LIVE_ROLLOUT_MS. */
  async activeAgeMs(id: string, nowMs = Date.now()): Promise<number | null> {
    const x = this.byId.get(id);
    if (!x) return null;
    if (x.row.not_fully_idle || /_RUNNING$/.test(x.row.status ?? '')) return 0;
    const t = parseGeminiTime(x.row.last_modified_time);
    return t !== null && nowMs - t < LIVE_ROLLOUT_MS ? Math.max(0, nowMs - t) : null;
  }
}
