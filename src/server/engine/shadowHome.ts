import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * A per-turn "shadow" HOME for an engine child (Grok design §14.1-1, §14.9-1). Gemini's second seat does not use this:
 * g2 keeps a persistent `~/.agy-g2` (`ensureGeminiSeatHome`) because a shadow home is deleted and would drop `.gemini`.
 * The real HOME would hand the child `~/.claude/settings*.json` (allow rules, defaultMode) and every
 * other tool's config; the shadow folder holds only symlinks from an allow-list, and only for entries the real HOME has.
 *
 * Layout: `<root>/<id>/`, mode 0700, made fresh for one turn and removed after the turn's process group is gone.
 * `root` (e.g. `<deck config dir>/homes/grok`) and its parent are checked too: real directories (not symlinks), owned
 * by this user, mode 0700. Anything else = the turn does not start.
 */

/** Grok's allow-list (§14.9-1): git config and ssh only. */
export const GROK_SHADOW_LINKS = ['.gitconfig', '.config/git', '.ssh'] as const;

/** Never linked, whatever a caller's list says (another tool's config or credentials, deck's own state). */
export const SHADOW_FORBIDDEN = ['.claude', 'Library', '.codex', '.gemini', '.grok', '.cursor', '.config/deck', '.config/gcloud', '.aws', '.gnupg', '.npmrc', '.netrc', '.docker', '.kube'] as const;

export class ShadowHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShadowHomeError';
  }
}

export type ShadowHome = {
  /** The folder to pass as HOME. */
  path: string;
  /** Removes the folder (links only — their targets are never touched). Safe to call twice. */
  remove: () => Promise<void>;
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function uid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** lstat → a real directory, ours, mode 0700 (fixed with chmod when only the mode is off, since we own it). */
async function checkDir(dir: string): Promise<void> {
  let st = await fs.lstat(dir).catch(() => null);
  if (!st) throw new ShadowHomeError(`그림자 HOME 폴더 없음: ${dir}`);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ShadowHomeError(`그림자 HOME 경로가 폴더가 아님(심링크 등): ${dir}`);
  const me = uid();
  if (me !== null && st.uid !== me) throw new ShadowHomeError(`그림자 HOME 폴더의 소유자가 다름: ${dir}`);
  if ((st.mode & 0o777) !== 0o700) {
    await fs.chmod(dir, 0o700);
    st = await fs.lstat(dir);
    if ((st.mode & 0o777) !== 0o700) throw new ShadowHomeError(`그림자 HOME 폴더 권한을 0700 으로 맞출 수 없음: ${dir}`);
  }
}

function isForbidden(rel: string): boolean {
  const norm = path.posix.normalize(rel.split(path.sep).join('/')).replace(/\/+$/, '');
  return SHADOW_FORBIDDEN.some((f) => norm === f || norm.startsWith(`${f}/`) || f.startsWith(`${norm}/`));
}

/** `root` and its parent: made 0700 when missing, then checked. */
async function prepareRoot(root: string): Promise<void> {
  const parent = path.dirname(root);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await checkDir(parent);
  await checkDir(root);
}

/**
 * Makes `<root>/<id>/` with the allowed links. `links` are paths relative to HOME; an entry the real HOME lacks is
 * skipped, a forbidden or escaping one is refused. Throws ShadowHomeError (the turn must not start).
 */
export async function createShadowHome(opts: { root: string; realHome: string; links: readonly string[]; id?: string }): Promise<ShadowHome> {
  const id = opts.id ?? randomUUID();
  if (!ID_RE.test(id)) throw new ShadowHomeError(`그림자 HOME id 형식이 잘못됨: ${id}`);
  const root = path.resolve(opts.root);
  await prepareRoot(root);
  const dir = path.join(root, id);
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (e) {
    throw new ShadowHomeError(`그림자 HOME 을 만들 수 없음: ${(e as Error).message}`);
  }
  const remove = async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); };
  try {
    await checkDir(dir);
    for (const rel of opts.links) {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !rel || isForbidden(rel)) throw new ShadowHomeError(`그림자 HOME 에 둘 수 없는 항목: ${rel}`);
      const src = path.join(opts.realHome, rel);
      if (!(await fs.lstat(src).catch(() => null))) continue;
      const dst = path.join(dir, rel);
      const parent = path.dirname(dst);
      if (parent !== dir) {
        await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        await checkDir(parent);
      }
      await fs.symlink(src, dst);
    }
  } catch (e) {
    await remove();
    throw e instanceof ShadowHomeError ? e : new ShadowHomeError(`그림자 HOME 준비 실패: ${(e as Error).message}`);
  }
  return { path: dir, remove };
}

/** Server start: removes every turn folder left under `root` (a crash or kill mid-turn). Returns how many. */
export async function sweepShadowHomes(root: string): Promise<number> {
  const st = await fs.lstat(root).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return 0;
  let n = 0;
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    await fs.rm(path.join(root, name), { recursive: true, force: true }).then(() => { n += 1; }, () => {});
  }
  return n;
}
