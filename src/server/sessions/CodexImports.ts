import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { SessionEntry } from '../../shared/session-types';
import { elsewhereNotice } from './elsewhereNotice';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

const ROLLOUT = /^rollout-.*\.jsonl$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bytes read from a rollout's start to find its meta and first prompt (Desktop prepends ~100 KB of context). */
const HEAD_BYTES = 2 * 1024 * 1024;
/** A rollout touched this recently is probably still open in Codex Desktop / CLI. */
const UNTITLED = '(제목 없음)';

export const LIVE_ROLLOUT_MS = 2 * 60 * 1000;
/** `codex exec` (automation) threads are listed only while written this recently. */
export const EXEC_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** `exec`: a non-interactive `codex exec` run (listed only while recent, tagged 자동 실행). */
export type RolloutHead = { threadId: string; cwd: string; title: string | null; exec?: true };

/** Codex Desktop wraps attachments as `# Files mentioned by the user: … ## My request[ for Codex]:` then the prompt. */
const REQUEST_MARK = /^## My request[^\n]*:[ \t]*$/m;

function titleOf(text: string): string | null {
  const m = REQUEST_MARK.exec(text);
  const t = (m ? text.slice(m.index + m[0].length) : text).trimStart();
  // Injected context (environment, AGENTS.md, plugins, images) — same rule as the transcript reader.
  if (!t || t.startsWith('<') || t.startsWith('# AGENTS.md') || (!m && t.startsWith('# Files mentioned by the user'))) return null;
  const first = t.split('\n').find((l) => l.trim())?.trim() ?? '';
  return first ? first.slice(0, 80) : null;
}

/**
 * Streams the first HEAD_BYTES of a rollout: `session_meta` (thread id, cwd) and the first real user prompt.
 * Null for sub-agent threads (Codex Desktop spawns hundreds; they are not conversations) and unusable files.
 * `codex exec` runs are returned with `exec: true`; `stopAtExec` returns those right after the meta line (no prompt scan).
 */
export async function readRolloutHead(file: string, maxBytes = HEAD_BYTES, opts: { stopAtExec?: boolean } = {}): Promise<RolloutHead | null> {
  const stream = createReadStream(file, { encoding: 'utf8', start: 0, end: maxBytes - 1 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let meta: { threadId: string; cwd: string; exec?: true } | null = null;
  let title: string | null = null;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r: Rec | null;
      try { r = rec(JSON.parse(line)); } catch { if (!meta) return null; continue; }
      const p = r ? rec(r.payload) : null;
      if (!r || !p) continue;
      if (!meta) {
        if (r.type !== 'session_meta') return null;
        const id = typeof p.id === 'string' ? p.id : null;
        if (!id || !UUID.test(id) || typeof p.cwd !== 'string' || !p.cwd.startsWith('/')) return null;
        if (p.thread_source === 'subagent' || (p.source !== undefined && typeof p.source !== 'string')) return null;
        meta = { threadId: id, cwd: p.cwd, ...(p.source === 'exec' || p.originator === 'codex_exec' ? { exec: true as const } : {}) };
        if (opts.stopAtExec && meta.exec) break;
        continue;
      }
      if (r.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
        for (const b of p.content) {
          const block = rec(b);
          if (block?.type !== 'input_text' || typeof block.text !== 'string') continue;
          title = titleOf(block.text);
          if (title) break;
        }
        if (title) break;
      }
    }
  } catch {
    if (!meta) return null;
  } finally {
    rl.close();
    stream.destroy();
  }
  return meta ? { ...meta, title } : null;
}

async function rolloutFiles(root: string): Promise<{ file: string; mtimeMs: number; size: number }[]> {
  const subdirs = async (p: string) => (await fs.readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
  const out: { file: string; mtimeMs: number; size: number }[] = [];
  for (const y of await subdirs(root)) {
    for (const m of await subdirs(y)) {
      for (const d of await subdirs(m)) {
        for (const name of await fs.readdir(d).catch(() => [] as string[])) {
          if (!ROLLOUT.test(name)) continue;
          const file = path.join(d, name);
          const st = await fs.stat(file).catch(() => null);
          if (st?.isFile()) out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
        }
      }
    }
  }
  return out;
}

/**
 * Codex Desktop / CLI threads under `~/.codex/sessions` (read-only), as Codex sidebar entries.
 * A rollout's head never changes once written, so it is read once per file and kept while the file
 * does not shrink; a rescan only stats. Nothing else under `~/.codex` is ever opened.
 */
export class CodexRolloutIndex {
  private heads = new Map<string, { size: number; head: RolloutHead | null }>();
  private entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();

  constructor(private readonly root: string, private readonly readHead: typeof readRolloutHead = readRolloutHead, private readonly now: () => number = Date.now) {}

  async refresh(): Promise<void> {
    const nowMs = this.now();
    const files = await rolloutFiles(this.root);
    const live = new Set<string>();
    const byId = new Map<string, SessionEntry>();
    // Threads whose folder is gone (e.g. temp dirs of scripted `codex exec` runs) cannot be continued.
    const dirOk = new Map<string, Promise<boolean>>();
    const cwdExists = (cwd: string) => {
      let v = dirOk.get(cwd);
      if (!v) { v = fs.stat(cwd).then((st) => st.isDirectory(), () => false); dirOk.set(cwd, v); }
      return v;
    };
    for (const f of files) {
      live.add(f.file);
      let cached = this.heads.get(f.file);
      // A head without a prompt yet (thread just started) is retried once the file grows (a write makes an old exec one recent).
      if (!cached || f.size < cached.size || (cached.head && !cached.head.title && f.size !== cached.size)) {
        // An exec rollout already too old to list needs only its meta line, not the 2 MB prompt scan.
        const old = nowMs - f.mtimeMs > EXEC_RECENT_MS;
        cached = { size: f.size, head: await this.readHead(f.file, HEAD_BYTES, old ? { stopAtExec: true } : {}).catch(() => null) };
        this.heads.set(f.file, cached);
      }
      const h = cached.head;
      if (!h || (h.exec && nowMs - f.mtimeMs > EXEC_RECENT_MS) || !(await cwdExists(h.cwd))) continue;
      const prev = byId.get(h.threadId);
      if (prev && prev.lastModified >= f.mtimeMs) continue;
      byId.set(h.threadId, {
        sessionId: h.threadId, account: 'gpt', engine: 'codex', cwd: h.cwd, projectDir: path.dirname(f.file), file: f.file,
        title: h.title ?? UNTITLED, lastModified: f.mtimeMs, sizeBytes: f.size, imported: true,
        ...(h.exec ? { codexExec: true } : {}),
      });
    }
    for (const k of this.heads.keys()) if (!live.has(k)) this.heads.delete(k);
    this.byId = byId;
    this.entries = [...byId.values()];
  }

  list(): SessionEntry[] {
    return this.entries;
  }

  lookup(threadId: string): SessionEntry | null {
    return this.byId.get(threadId) ?? null;
  }
}

/** How long ago a rollout was written, if within LIVE_ROLLOUT_MS (Codex Desktop / CLI probably has it open); else null. */
export async function rolloutActiveAgeMs(file: string, nowMs = Date.now()): Promise<number | null> {
  const st = await fs.stat(file).catch(() => null);
  return st && nowMs - st.mtimeMs < LIVE_ROLLOUT_MS ? Math.max(0, nowMs - st.mtimeMs) : null;
}

/** Whether a rollout was written within LIVE_ROLLOUT_MS. */
export async function rolloutRecentlyActive(file: string, nowMs = Date.now()): Promise<boolean> {
  return (await rolloutActiveAgeMs(file, nowMs)) !== null;
}

/** The notice for an imported Codex thread written outside deck `ageMs` ago. */
export function liveRolloutNotice(title: string | null, ageMs: number): string {
  return elsewhereNotice({ engine: 'codex', title: title === UNTITLED ? null : title, ageMs });
}
