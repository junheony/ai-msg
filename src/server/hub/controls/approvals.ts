/**
 * 승인함: approval requests any bot, agent or script on this server files as one JSON file in
 * `~/.msg/approvals/pending/<id>.json` (scripts/msg-approve does it for you). The owner decides in the hub; the file
 * moves to `decided/<id>.json` with who/when/note, and one line goes to the append-only `~/.msg/msg-approvals.log`
 * (never a trading ledger). Deciding only records the decision — unless an executor hook is configured for the
 * kind (`~/.msg/approvals/hooks/<kind>`), nothing is merged or deployed. Locked requests (guard.ts) cannot be decided.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { approvalLock, LOCKED_LABEL } from './guard';

export const APPROVAL_KINDS = ['generic', 'pr-merge', 'deploy'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export interface ApprovalLink { label: string; href: string }

export interface ApprovalRequest {
  id: string;
  from: string;
  mode: string;
  /** Unknown kinds are shown as `generic` (and kept verbatim in `rawKind`). */
  kind: ApprovalKind;
  rawKind?: string;
  title: string;
  detail: string;
  links: ApprovalLink[];
  createdAt: string;
  /** pr-merge: the PR and its diff stat as the requester reported them. */
  pr?: { url?: string; base?: string; head?: string; files?: number; additions?: number; deletions?: number };
  /** deploy: what and where. */
  deploy?: { target?: string; version?: string };
}

export interface ApprovalDecision { status: 'approved' | 'rejected'; by: string; at: string; note: string; hook: 'none' | 'launched' | 'failed' }

export interface ApprovalItem extends ApprovalRequest {
  /** Why the hub may not decide it (QUANT/해당 채팅에서만 승인), null = the owner may decide here. */
  locked: string | null;
  lockedLabel?: string;
  decision?: ApprovalDecision;
  /** An executor hook exists for this kind (approve would run it); false = decision is only recorded. */
  hook: boolean;
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_TEXT = 4000;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9 ? v : undefined);
const httpUrl = (v: unknown): string | undefined => (typeof v === 'string' && /^https?:\/\/[^\s]{1,500}$/.test(v) ? v : undefined);

/** A file's JSON as a request, or null when it is not one (bad id, missing title…). */
export function parseRequest(raw: unknown, fileId: string): ApprovalRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id, 80);
  if (!ID_RE.test(id) || id !== fileId) return null;
  const title = str(o.title, 200).trim();
  if (!title) return null;
  const rawKind = str(o.kind, 40) || 'generic';
  const kind = (APPROVAL_KINDS as readonly string[]).includes(rawKind) ? (rawKind as ApprovalKind) : 'generic';
  const links = Array.isArray(o.links) ? o.links.slice(0, 10).flatMap((l) => {
    const lo = l as Record<string, unknown> | null;
    const href = httpUrl(lo?.href);
    return href ? [{ label: str(lo?.label, 80) || href, href }] : [];
  }) : [];
  const req: ApprovalRequest = {
    id, kind, title, links,
    from: str(o.from, 80) || '알 수 없음',
    mode: str(o.mode, 40) || 'msg',
    detail: str(o.detail, MAX_TEXT),
    createdAt: typeof o.createdAt === 'string' && !Number.isNaN(Date.parse(o.createdAt)) ? o.createdAt : new Date(0).toISOString(),
  };
  if (kind !== rawKind) req.rawKind = rawKind;
  if (o.pr && typeof o.pr === 'object') {
    const p = o.pr as Record<string, unknown>;
    req.pr = Object.fromEntries(Object.entries({ url: httpUrl(p.url), base: str(p.base, 120) || undefined, head: str(p.head, 120) || undefined, files: int(p.files), additions: int(p.additions), deletions: int(p.deletions) }).filter(([, v]) => v !== undefined));
  }
  if (o.deploy && typeof o.deploy === 'object') {
    const d = o.deploy as Record<string, unknown>;
    req.deploy = Object.fromEntries(Object.entries({ target: str(d.target, 120) || undefined, version: str(d.version, 120) || undefined }).filter(([, v]) => v !== undefined));
  }
  return req;
}

export interface ApprovalsDeps {
  /** `~/.msg` */
  root: string;
  now?: () => Date;
  /** Runs an executor hook (detached); injectable for tests. Default: spawn the file with the decided JSON path. */
  runHook?: (file: string, decidedFile: string) => Promise<void>;
}

export class ApprovalError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export function approvalPaths(root: string) {
  const base = path.join(root, 'approvals');
  return { pending: path.join(base, 'pending'), decided: path.join(base, 'decided'), hooks: path.join(base, 'hooks'), log: path.join(root, 'msg-approvals.log') };
}

const defaultRunHook = (file: string, decided: string): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(file, [decided], { detached: true, stdio: 'ignore' });
  child.once('error', reject);
  child.once('spawn', () => { child.unref(); resolve(); });
});

export function createApprovals(deps: ApprovalsDeps) {
  const p = approvalPaths(deps.root);
  const now = deps.now ?? (() => new Date());

  const hookFor = async (kind: string): Promise<string | null> => {
    if (!(APPROVAL_KINDS as readonly string[]).includes(kind)) return null;
    const file = path.join(p.hooks, kind);
    try { await fs.access(file, fs.constants.X_OK); return file; } catch { return null; }
  };

  const readDir = async (dir: string, limit: number): Promise<{ raw: unknown; id: string; mtime: number }[]> => {
    let names: string[] = [];
    try { names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')); } catch { return []; }
    const out = await Promise.all(names.map(async (n) => {
      const file = path.join(dir, n);
      try {
        const [text, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
        if (st.size > 256 * 1024) return null;
        return { raw: JSON.parse(text) as unknown, id: n.slice(0, -5), mtime: st.mtimeMs };
      } catch { return null; }
    }));
    return out.filter((x): x is NonNullable<typeof x> => x !== null).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  };

  const toItem = async (raw: unknown, id: string): Promise<ApprovalItem | null> => {
    const req = parseRequest(raw, id);
    if (!req) return null;
    const locked = approvalLock({ ...req, kind: req.rawKind ?? req.kind });
    const item: ApprovalItem = { ...req, locked, hook: (await hookFor(req.kind)) !== null };
    if (locked) item.lockedLabel = LOCKED_LABEL;
    const d = (raw as { decision?: ApprovalDecision }).decision;
    if (d && (d.status === 'approved' || d.status === 'rejected')) item.decision = d;
    return item;
  };

  const log = async (line: Record<string, unknown>) => {
    await fs.mkdir(path.dirname(p.log), { recursive: true, mode: 0o700 });
    // O_APPEND: lines are only ever added, never rewritten.
    await fs.appendFile(p.log, JSON.stringify(line) + '\n', { mode: 0o600, flag: 'a' });
  };

  return {
    paths: p,
    async list(): Promise<{ pending: ApprovalItem[]; decided: ApprovalItem[] }> {
      const [pend, dec] = await Promise.all([readDir(p.pending, 200), readDir(p.decided, 30)]);
      const pending = (await Promise.all(pend.map((x) => toItem(x.raw, x.id)))).filter((x): x is ApprovalItem => !!x && !x.decision);
      pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const decided = (await Promise.all(dec.map((x) => toItem(x.raw, x.id)))).filter((x): x is ApprovalItem => !!x && !!x.decision);
      decided.sort((a, b) => (b.decision!.at).localeCompare(a.decision!.at));
      return { pending, decided };
    },
    /** Approve or reject one pending request. 404 gone, 403 locked, 409 decided meanwhile. */
    async decide(id: string, status: 'approved' | 'rejected', note: string, by: string): Promise<ApprovalItem> {
      if (!ID_RE.test(id)) throw new ApprovalError(400, '잘못된 요청 id');
      const src = path.join(p.pending, `${id}.json`);
      let raw: unknown;
      try { raw = JSON.parse(await fs.readFile(src, 'utf8')); } catch { throw new ApprovalError(404, '대기 중인 요청이 없습니다'); }
      const item = await toItem(raw, id);
      if (!item) throw new ApprovalError(422, '요청 파일 형식이 올바르지 않습니다');
      if (item.locked) {
        await log({ ts: now().toISOString(), id, action: 'refused', want: status, reason: item.locked, by });
        throw new ApprovalError(403, `${LOCKED_LABEL} · ${item.locked}`);
      }
      await fs.mkdir(p.decided, { recursive: true, mode: 0o700 });
      const dst = path.join(p.decided, `${id}.json`);
      // Claim it: the rename is atomic, so two deciders never both win (the loser finds the pending file gone).
      const claim = path.join(p.decided, `.${id}.claim`);
      try { await fs.rename(src, claim); } catch { throw new ApprovalError(409, '이미 처리된 요청입니다'); }
      const hookFile = status === 'approved' ? await hookFor(item.kind) : null;
      const decision: ApprovalDecision = { status, by, at: now().toISOString(), note: note.slice(0, 1000), hook: hookFile ? 'launched' : 'none' };
      const out = { ...(raw as object), decision };
      await fs.writeFile(claim, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(claim, dst);
      if (hookFile) {
        try { await (deps.runHook ?? defaultRunHook)(hookFile, dst); } catch { decision.hook = 'failed'; await fs.writeFile(dst, JSON.stringify({ ...(raw as object), decision }, null, 2) + '\n', { mode: 0o600 }); }
      }
      await log({ ts: decision.at, id, action: status, kind: item.kind, mode: item.mode, from: item.from, title: item.title, note: decision.note, by, hook: decision.hook });
      return { ...item, decision };
    },
  };
}

export type ApprovalsService = ReturnType<typeof createApprovals>;
