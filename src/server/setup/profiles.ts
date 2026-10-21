// Claude profile add from the setup wizard (plan ② Task 5): `<configDir>/accounts.json` gets one more account, and the
// profile dir is created (empty, 0700) when it is not there. deck never logs in — the wizard shows the login command.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AccountsFileError, loadAccountRegistry } from '../accounts';
import { ACCOUNT_ID_RE, RESERVED_ACCOUNT_IDS, buildRegistry, type AccountRegistry, type AccountSpec, type AccountsConfig } from '../../shared/accounts';
import { PROFILE_TEXTS } from './texts';

export class ProfileError extends Error {
  override name = 'ProfileError';
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}

/** `dir` under `home` as `~` / `~/…`; anything else stays absolute. */
function tildeDir(dir: string, home: string): string {
  const h = path.resolve(home);
  if (dir === h) return '~';
  return dir.startsWith(h + path.sep) ? `~/${dir.slice(h.length + 1)}` : dir;
}

/**
 * The registry written out as an accounts.json that builds the same registry: every account (retired included) in
 * order, its profile dir spelled out, a label only when it is not the default. `card` is never written — the a/b/c
 * defaults (claude-pick card ids) come back by themselves.
 */
export function materializeAccountsConfig(reg: AccountRegistry, home: string): AccountsConfig {
  return {
    version: 1,
    home: reg.home,
    accounts: reg.all().map((id) => {
      const spec: AccountSpec = { id };
      const label = reg.label(id);
      if (label !== id.toUpperCase()) spec.label = label;
      spec.configDir = tildeDir(reg.profileDir(id), home);
      if (reg.isRetired(id)) spec.retired = true;
      return spec;
    }),
  };
}

const canonicalDir = (dir: string): string => {
  try { return fs.realpathSync.native(dir); } catch { return path.resolve(dir); }
};

const LOCK_STALE_MS = 30_000;
let chain: Promise<unknown> = Promise.resolve();

/** Serialize within this process. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** `<configDir>/accounts.json.lock` (O_EXCL) against other processes; one older than 30 s is a leftover and goes. */
async function takeFileLock(file: string, waitMs: number): Promise<() => void> {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fh = await fsp.open(file, 'wx', 0o600);
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const st = await fsp.lstat(file).catch(() => null);
    if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fsp.rm(file, { force: true }); continue; }
    if (Date.now() >= until) throw new ProfileError(409, PROFILE_TEXTS.busy);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A path that is not there is fine; a symlink, another owner's file or (for a dir) a non-directory is refused. */
async function checkOwn(p: string, uid: number | undefined, kind: 'file' | 'dir'): Promise<fs.Stats | null> {
  let st: fs.Stats;
  try { st = await fsp.lstat(p); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink()) throw new ProfileError(400, PROFILE_TEXTS.symlink(p));
  if (uid !== undefined && st.uid !== uid) throw new ProfileError(400, PROFILE_TEXTS.notOwner(p));
  if (kind === 'dir' && !st.isDirectory()) throw new ProfileError(400, PROFILE_TEXTS.notDir(p));
  return st;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

async function readOrNull(file: string): Promise<string | null> {
  try { return await fsp.readFile(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Add one Claude profile: `<home>/.claude-<id>` registered in `<configDir>/accounts.json`. Without an accounts.json the
 * accounts found right now (discovery, re-run here) are written out first, so nothing disappears and home stays.
 * Applied at the next server start. Any failure leaves accounts.json as it was and removes only the dir made here
 * while it is still empty. `hooks` and `lockWaitMs` are for tests.
 */
export function addClaudeProfile(o: {
  configDir: string; home: string; id: string; label?: string; uid?: number; now?: () => Date;
  lockWaitMs?: number;
  hooks?: { afterRead?: () => void | Promise<void>; rename?: (from: string, to: string) => Promise<void> };
}): Promise<{ id: string; dir: string; createdDir: boolean; backup: string | null }> {
  const { id } = o;
  if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) return Promise.reject(new ProfileError(400, PROFILE_TEXTS.badId(String(id), ACCOUNT_ID_RE.source)));
  if (RESERVED_ACCOUNT_IDS.includes(id)) return Promise.reject(new ProfileError(400, PROFILE_TEXTS.reservedId(id)));
  if (o.label !== undefined && (o.label.trim().length === 0 || o.label.length > 40)) return Promise.reject(new ProfileError(400, PROFILE_TEXTS.badLabel));
  const uid = o.uid ?? process.getuid?.();
  const file = path.join(o.configDir, 'accounts.json');
  const home = path.resolve(o.home);
  const dir = path.join(home, `.claude-${id}`);

  return serialized(async () => {
    await fsp.mkdir(o.configDir, { recursive: true, mode: 0o700 });
    const unlock = await takeFileLock(`${file}.lock`, o.lockWaitMs ?? 5_000);
    let createdDir = false;
    let tmp: string | null = null;
    try {
      // 2. The base: the file as it is, or the accounts found now.
      await checkOwn(file, uid, 'file');
      const text = await readOrNull(file);
      let base: Record<string, unknown> & { accounts: AccountSpec[] };
      if (text === null) {
        base = materializeAccountsConfig(loadAccountRegistry({ configDir: o.configDir, homeDir: home, log: () => {} }), home);
      } else {
        try { loadAccountRegistry({ configDir: o.configDir, homeDir: home, log: () => {} }); } catch (err) {
          if (err instanceof AccountsFileError) throw new ProfileError(400, PROFILE_TEXTS.brokenFile(err.message));
          throw err;
        }
        base = JSON.parse(text) as typeof base;
      }
      await o.hooks?.afterRead?.();

      // 3. Checks.
      if (base.accounts.some((a) => a.id === id)) throw new ProfileError(409, PROFILE_TEXTS.duplicate(id));
      const existing = await checkOwn(dir, uid, 'dir');

      // 5. The new content must build a registry (same dir under another name, …) before anything is touched.
      const spec: AccountSpec = { id, ...(o.label !== undefined ? { label: o.label.trim() } : {}), configDir: `~/.claude-${id}` };
      const next = { ...base, accounts: [...base.accounts, spec] };
      try { buildRegistry(next as AccountsConfig, { homeDir: home, canonical: canonicalDir }); } catch (err) {
        throw new ProfileError(400, PROFILE_TEXTS.invalid(err instanceof Error ? err.message : String(err)));
      }

      // 4. The profile dir (an existing one is left as it is).
      if (!existing) {
        await fsp.mkdir(dir, { mode: 0o700 });
        createdDir = true;
      }

      // 6. Still the file that was read?
      const now = await readOrNull(file);
      if ((now === null) !== (text === null) || (now !== null && text !== null && sha(now) !== sha(text))) throw new ProfileError(409, PROFILE_TEXTS.changed);

      // 7. deck's first edit of a file the user wrote: one copy.
      let backup: string | null = null;
      if (text !== null && !(await fsp.readdir(o.configDir)).some((n) => n.startsWith('accounts.json.bak-'))) {
        backup = path.join(o.configDir, `accounts.json.bak-${stamp(o.now?.() ?? new Date())}`);
        await fsp.writeFile(backup, text, { mode: 0o600, flag: 'wx' });
      }

      // 8. Same-dir temp file → fsync → rename.
      tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      const fh = await fsp.open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify(next, null, 2) + '\n');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await (o.hooks?.rename ?? fsp.rename)(tmp, file);
      tmp = null;
      return { id, dir, createdDir, backup };
    } catch (err) {
      // 9. Undo what this call made (a backup stays).
      if (tmp) await fsp.rm(tmp, { force: true }).catch(() => undefined);
      if (createdDir) await fsp.rmdir(dir).catch(() => undefined); // only succeeds while empty
      throw err;
    } finally {
      unlock();
    }
  });
}
