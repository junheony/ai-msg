import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionEntry } from '../../shared/session-types';
import { GROK_SESSION_ID_RE } from '../engine/GrokEngine';
import { readGrokFirstPrompt } from '../engine/grokHistory';
import { CWD_MISSING_NOTICE, isTempCwd, LIVE_ROLLOUT_MS } from './CodexImports';
import { singleFlight, type ImportIndex } from './ImportIndex';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const UNTITLED = '(제목 없음)';

export const GROK_HELD_NOTICE = '터미널에서 grok 이 이 대화를 열고 있어 이어서 보낼 수 없음 — 그쪽 grok 을 끝낸 뒤 다시 보내세요';

/** What `summary.json` says about a Grok CLI session (only what the list needs). */
export type GrokHead = {
  id: string; cwd: string; title: string | null; updatedMs: number | null; createdMs: number | null;
  numChatMessages: number | null; model: string | null; effort: string | null; grokHome: string | null; kind: string | null;
};

/** `summary.json` of a session dir; null when it is unreadable, half-written or not a Grok session summary. */
export async function readGrokSummary(dir: string): Promise<GrokHead | null> {
  let r: Rec | null;
  try { r = rec(JSON.parse(await fs.readFile(path.join(dir, 'summary.json'), 'utf8'))); } catch { return null; }
  const info = rec(r?.info);
  if (!r || !info) return null;
  const id = str(info.id);
  const cwd = str(info.cwd);
  if (!id || !GROK_SESSION_ID_RE.test(id) || !cwd || !cwd.startsWith('/')) return null;
  const ms = (v: unknown) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
  return {
    id, cwd,
    title: str(r.generated_title) ?? str(r.session_summary)?.split('\n')[0]?.slice(0, 80) ?? null,
    updatedMs: ms(r.updated_at) ?? ms(r.last_active_at), createdMs: ms(r.created_at),
    numChatMessages: typeof r.num_chat_messages === 'number' ? r.num_chat_messages : null,
    model: str(r.current_model_id), effort: str(r.reasoning_effort), grokHome: str(r.grok_home), kind: str(r.session_kind),
  };
}

type Cached = { stamp: string; head: GrokHead | null; firstPrompt: string | null };

/**
 * Grok CLI sessions under `GROK_HOME/sessions/<encoded cwd>/<id>/`, read-only, as Grok sidebar entries (design
 * §2.1). deck's own Grok sessions live in the same place; SessionIndex drops the ids deck already owns.
 * Left out: sub-agent sessions, empty ones, another GROK_HOME's, dirs whose real path leaves `GROK_HOME/sessions`,
 * and those whose cwd is a temp dir that no longer exists (finished spikes / scripts). A summary is re-read only
 * when its mtime or size changed.
 */
export class GrokSessionIndex implements ImportIndex {
  private cache = new Map<string, Cached>();
  private entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private lastHidden = 0;
  readonly refresh: () => Promise<void>;

  constructor(
    private readonly grokHome: string,
    private readonly readSummary: typeof readGrokSummary = readGrokSummary,
    private readonly readFirstPrompt: typeof readGrokFirstPrompt = readGrokFirstPrompt,
    private readonly log: (msg: string) => void = (m) => console.log(m),
  ) {
    this.refresh = singleFlight(() => this.scan());
  }

  private async scan(): Promise<void> {
    const root = await fs.realpath(path.join(this.grokHome, 'sessions')).catch(() => null);
    if (!root) { this.entries = []; this.byId = new Map(); return; }
    const home = await fs.realpath(this.grokHome).catch(() => this.grokHome);
    const subdirs = async (p: string) => (await fs.readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
    const dirs = (await Promise.all((await subdirs(root)).map(subdirs))).flat();
    const dirOk = new Map<string, Promise<boolean>>();
    const exists = (cwd: string) => { let v = dirOk.get(cwd); if (!v) { v = fs.stat(cwd).then((s) => s.isDirectory(), () => false); dirOk.set(cwd, v); } return v; };
    const homeOk = new Map<string, Promise<string>>();
    const realHome = (p: string) => { let v = homeOk.get(p); if (!v) { v = fs.realpath(p).catch(() => p); homeOk.set(p, v); } return v; };
    const byId = new Map<string, SessionEntry>();
    const seen = new Set<string>();
    let hidden = 0;
    for (const dir of dirs) {
      const real = await fs.realpath(dir).catch(() => null);
      if (!real || !real.startsWith(root + path.sep)) continue;
      const st = await fs.stat(path.join(real, 'summary.json')).catch(() => null);
      if (!st?.isFile()) continue;
      seen.add(real);
      const stamp = `${st.mtimeMs}:${st.size}`;
      let c = this.cache.get(real);
      if (!c || c.stamp !== stamp) {
        const head = await this.readSummary(real).catch(() => null);
        const firstPrompt = head && !head.title ? await this.readFirstPrompt(path.join(real, 'chat_history.jsonl')).catch(() => null) : null;
        c = { stamp, head, firstPrompt };
        this.cache.set(real, c);
      }
      const h = c.head;
      if (!h || path.basename(real) !== h.id) continue;
      if (h.kind === 'subagent' || h.numChatMessages === 0) continue;
      if (h.grokHome && (await realHome(h.grokHome)) !== home) continue;
      const gone = !(await exists(h.cwd));
      if (gone && isTempCwd(h.cwd)) { hidden++; continue; }
      const file = path.join(real, 'chat_history.jsonl');
      const prev = byId.get(h.id);
      const lastModified = h.updatedMs ?? st.mtimeMs;
      if (prev && prev.lastModified >= lastModified) continue;
      byId.set(h.id, {
        sessionId: h.id, account: 'x1', engine: 'grok', cwd: h.cwd, projectDir: real, file,
        title: h.title ?? c.firstPrompt ?? UNTITLED, lastModified, sizeBytes: st.size, imported: true,
        ...(h.kind === 'headless' ? { autoRun: true } : {}),
        ...(gone ? { cwdMissing: true } : {}),
        ...(h.model ? { grokModel: h.model } : {}),
        ...(h.effort ? { grokEffort: h.effort } : {}),
      });
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    if (hidden !== this.lastHidden) { this.log(`grok imports: ${hidden} hidden (temp cwd gone)`); this.lastHidden = hidden; }
    this.byId = byId;
    this.entries = [...byId.values()];
  }

  list(): SessionEntry[] {
    return this.entries;
  }

  lookup(id: string): SessionEntry | null {
    return this.byId.get(id) ?? null;
  }

  /** `updates.jsonl` (else `chat_history.jsonl`) written within LIVE_ROLLOUT_MS: a secondary signal; holding is the ps scan. */
  async activeAgeMs(id: string, nowMs = Date.now()): Promise<number | null> {
    const e = this.byId.get(id);
    if (!e) return null;
    const st = (await fs.stat(path.join(e.projectDir, 'updates.jsonl')).catch(() => null)) ?? (await fs.stat(e.file).catch(() => null));
    return st && nowMs - st.mtimeMs < LIVE_ROLLOUT_MS ? Math.max(0, nowMs - st.mtimeMs) : null;
  }
}

/** Why deck cannot continue an imported Grok session now (a terminal `grok` holds it by id, or its folder is gone), or null. */
export async function grokImportBlockReason(e: Pick<SessionEntry, 'sessionId' | 'cwd'>, holders?: { grokHeldBy?(id: string): unknown } | null): Promise<string | null> {
  if (holders?.grokHeldBy?.(e.sessionId)) return GROK_HELD_NOTICE;
  const ok = await fs.stat(e.cwd).then((st) => st.isDirectory(), () => false);
  return ok ? null : `${CWD_MISSING_NOTICE}: ${e.cwd}`;
}
