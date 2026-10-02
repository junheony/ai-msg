import fs from 'node:fs/promises';
import path from 'node:path';
import { ACCOUNTS, type Account } from '../../shared/accounts';
import { isBytePrefix } from './SessionMover';

/** One profile's copy of a session transcript. */
export type SessionCopy = { account: Account; projectDir: string; file: string; size: number; mtimeMs: number };

type Stamped = { file: string; size: number; mtimeMs: number };
export type PrefixFn = (prefix: Stamped, full: Stamped) => Promise<boolean>;

const plainPrefix: PrefixFn = (a, b) => isBytePrefix(a.file, b.file);

/**
 * The copies `claude --resume` would use: in each profile, `<id>.jsonl` in the directory named like
 * `projectDir` (deck copies keep the dir name). The copy at `projectDir` itself comes first. A copy in a
 * differently spelled dir (e.g. an old NFD-era name) is not one resume picks and is ignored.
 */
export async function findCopies(roots: Record<Account, string>, sessionId: string, projectDir: string, account: Account): Promise<SessionCopy[]> {
  const name = path.basename(projectDir);
  const dirs: [Account, string][] = [[account, projectDir], ...ACCOUNTS.map((a): [Account, string] => [a, path.join(roots[a], name)])];
  const seen = new Set<string>();
  const out: SessionCopy[] = [];
  for (const [acc, dir] of dirs) {
    const key = path.resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    const file = path.join(dir, `${sessionId}.jsonl`);
    const st = await fs.stat(file).catch(() => null);
    if (st?.isFile()) out.push({ account: acc, projectDir: dir, file, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/**
 * Which copy wins. Transcripts are append-only, so a copy that is a byte-prefix of another is just
 * older: the longest one in a prefix chain wins (on a tie the earlier-listed copy). `heads` are the
 * copies no other copy contains; more than one = truly diverged, and then the latest mtime wins
 * (the caller tells the user; nothing is overwritten).
 */
export async function resolveCopies<T extends Stamped>(copies: T[], prefix: PrefixFn = plainPrefix): Promise<{ best: T; heads: T[] } | null> {
  let heads: T[] = [];
  for (const c of copies) {
    let dominated = false;
    for (const h of heads) if (await prefix(c, h)) { dominated = true; break; }
    if (dominated) continue;
    const kept: T[] = [];
    for (const h of heads) if (!(await prefix(h, c))) kept.push(h);
    heads = [...kept, c];
  }
  if (!heads.length) return null;
  const best = heads.length === 1 ? heads[0]! : heads.reduce((x, y) => (y.mtimeMs > x.mtimeMs ? y : x));
  return { best, heads };
}
