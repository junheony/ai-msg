import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isUnderRoots, resolveUnderRoots } from './dirs';

/** Files listed for the composer's @ picker, at most. */
export const MAX_FILES = 5000;
const WALK_SKIP = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__', 'venv']);
const CACHE_MS = 10_000;

export type FileListing = { cwd: string; files: string[]; truncated: boolean; git: boolean };

function gitLsFiles(cwd: string, max: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    // Tracked + untracked-but-not-ignored, relative to cwd (a subfolder of a repo lists only itself).
    execFile('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 32 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const files = stdout.split('\0').filter(Boolean);
      resolve(files.slice(0, max + 1));
    });
  });
}

/** No git: breadth-first walk, hidden entries and the usual build/dependency dirs skipped, symlinks not followed. */
async function walk(root: string, max: number): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length <= max) {
    const rel = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!WALK_SKIP.has(e.name)) queue.push(p); }
      else if (e.isFile()) { out.push(p); if (out.length > max) break; }
    }
  }
  return out;
}

/**
 * The composer's `@` picker: files under a session's cwd, relative to it. The cwd must resolve (symlinks
 * included) inside one of `roots` like `/api/dirs`; inside a git repo `git ls-files` decides (.gitignore
 * respected), otherwise a bounded walk. Listings are cached briefly per folder. Read-only.
 */
export class FileLister {
  private cache = new Map<string, { at: number; listing: FileListing }>();

  /**
   * `denyRoots`: folders never previewed wherever the cwd is (deck's own config dir: token, VAPID key…).
   * `platform` / `execFile`: injectable for reveal() tests (default: the running OS and child_process.execFile).
   */
  constructor(private readonly opts: { home: string; roots: string[]; denyRoots?: string[]; max?: number; now?: () => number; platform?: NodeJS.Platform; execFile?: RevealExec }) {}

  async list(input: string): Promise<FileListing> {
    const cwd = await resolveUnderRoots(input, this.opts.home, this.opts.roots);
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(cwd);
    if (hit && now - hit.at < CACHE_MS) return hit.listing;
    const max = this.opts.max ?? MAX_FILES;
    const fromGit = await gitLsFiles(cwd, max);
    const all = fromGit ?? (await walk(cwd, max));
    // git paths are already relative and inside cwd; anything odd (absolute, ..) is dropped anyway.
    const files = all.filter((f) => !f.startsWith('/') && !f.split('/').includes('..'));
    const listing: FileListing = { cwd, files: files.slice(0, max), truncated: files.length > max, git: fromGit !== null };
    this.cache.set(cwd, { at: now, listing });
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
    return listing;
  }

  /** Side panel: one file of the session folder `cwd` (see readSessionFile). */
  read(cwd: string, file: string): Promise<FilePreview> {
    return readSessionFile(this.target(cwd, file));
  }

  /** `/api/file?raw=1`: the file's bytes (see openSessionFileRaw). */
  openRaw(cwd: string, file: string): Promise<RawSessionFile> {
    return openSessionFileRaw(this.target(cwd, file));
  }

  /** `POST /api/reveal` (see revealSessionPath). */
  reveal(cwd: string, file: string): Promise<void> {
    return revealSessionPath({ ...this.target(cwd, file), ...(this.opts.platform ? { platform: this.opts.platform } : {}), ...(this.opts.execFile ? { execFile: this.opts.execFile } : {}) });
  }

  private target(cwd: string, file: string): SessionPathOpts {
    return { home: this.opts.home, roots: this.opts.roots, cwd, file, ...(this.opts.denyRoots ? { denyRoots: this.opts.denyRoots } : {}) };
  }
}

/** /api/file: bigger files are refused (the panel is a preview, not an editor). */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

export type FilePreview =
  | { path: string; size: number; kind: 'text'; text: string }
  | { path: string; size: number; kind: 'image'; mediaType: string; base64: string };

/** /api/file?raw=1: the bytes are streamed, not held in memory, so the cap is much higher than the preview's. */
export const MAX_RAW_BYTES = 50 * 1024 * 1024;

/** A file /api/file or /api/reveal refuses; `status` is the HTTP status, the message is shown to the user. */
export class FileReadError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 413 | 415 | 500 | 501) { super(message); }
}

/**
 * Directly under home, every dotfile / dotdir (.claude*, .ssh, .config, .zsh_history…) and ~/Library hold credentials,
 * shell history or other apps' state: never previewed, wherever the cwd is (a cwd of ~ included). Project dotdirs
 * (`~/code/x/.github`) are not at home level and stay readable.
 */
const DENY_HOME_FIRST = (seg: string) => seg.startsWith('.') || seg === 'Library';
/** Directories (any depth) that are credential stores. */
const DENY_DIR_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.codex']);
/** Credential-looking file names (any depth). `.env.example`-style templates stay readable. */
const DENY_FILE = /^(\.env(\.(?!example$|sample$|template$)[\w.-]+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|auth\.json|credentials(\.json)?|\.credentials\.json|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx)|\..*_history|\.vault-token|.*\.tfrc\.json|service-account.*\.json|logins\.json|key4\.db)$/i;

/** True when `real` (an absolute real path) must never be previewed. */
export function isDeniedPath(real: string, home: string): boolean {
  const parts = real.split(path.sep).filter(Boolean);
  if (DENY_FILE.test(parts.at(-1) ?? '')) return true;
  if (parts.slice(0, -1).some((p) => DENY_DIR_SEGMENTS.has(p))) return true;
  const rel = path.relative(home, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return DENY_HOME_FIRST(rel.split(path.sep)[0]!);
}

const IMAGE_MAGIC: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { type: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

type SessionPathOpts = { home: string; roots: string[]; cwd: string; file: string; denyRoots?: string[] };
type OpenedSessionPath = { real: string; fh: import('node:fs/promises').FileHandle; st: import('node:fs').Stats };

/**
 * The one check every session-file route goes through (preview, raw bytes, reveal). The cwd must resolve inside
 * `roots` (like /api/files), the target's REAL path (symlinks resolved) must lie inside that cwd, the deny list
 * above applies to both the requested and the real path, and the target is opened O_NOFOLLOW so a symlink swapped
 * in after the check is refused. Returns the open handle (the caller closes it); on a throw it is already closed.
 * Directories only with `allowDir` (reveal).
 */
async function openSessionPath(opts: SessionPathOpts, allowDir = false): Promise<OpenedSessionPath> {
  const cwd = await resolveUnderRoots(opts.cwd, opts.home, opts.roots);
  const raw = opts.file.trim();
  if (!raw || raw.includes('\0')) throw new FileReadError('파일 경로가 필요합니다', 400);
  const abs = raw.startsWith('~/') ? path.join(opts.home, raw.slice(2)) : path.resolve(cwd, raw);
  const realHome = await fs.realpath(opts.home).catch(() => opts.home);
  const denyRoots = (await Promise.all((opts.denyRoots ?? []).map(async (d) => [d, await fs.realpath(d).catch(() => d)]))).flat();
  const denied = (p: string, h: string) => isDeniedPath(p, h) || isUnderRoots(p, denyRoots);
  if (denied(abs, opts.home) || denied(abs, realHome)) throw new FileReadError('보안상 열 수 없는 파일입니다', 403);
  let real: string;
  try { real = await fs.realpath(abs); } catch {
    // Don't confirm whether paths outside the folder exist.
    throw isUnderRoots(abs, [cwd]) ? new FileReadError('파일을 찾을 수 없습니다', 404) : new FileReadError('세션 폴더 안의 파일만 열 수 있습니다', 403);
  }
  if (!isUnderRoots(real, [cwd])) throw new FileReadError('세션 폴더 안의 파일만 열 수 있습니다', 403);
  if (denied(real, realHome)) throw new FileReadError('보안상 열 수 없는 파일입니다', 403);
  let fh: import('node:fs/promises').FileHandle;
  try { fh = await fs.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { throw new FileReadError('파일을 열 수 없습니다', 404); }
  try {
    const st = await fh.stat();
    const dir = allowDir && st.isDirectory();
    if (!st.isFile() && !dir) throw new FileReadError('파일이 아닙니다', 400);
    // The opened file must still be the one checked (no swap of a parent dir in between), and a hard link to a file
    // elsewhere (another name for a denied file) is refused. Directories always have nlink > 1 and can't be hard-linked.
    const again = await fs.realpath(abs).then((r) => (r === real ? fs.stat(r) : null), () => null);
    if (!again || again.ino !== st.ino || again.dev !== st.dev || (!dir && st.nlink > 1)) throw new FileReadError('파일을 열 수 없습니다', 403);
    return { real, fh, st };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

/**
 * Side panel preview (`GET /api/file`): one file inside a session's folder, checked by openSessionPath.
 * Text (no NUL in the first 8 KiB, valid UTF-8) or a sniffed raster image; anything else 415.
 */
export async function readSessionFile(opts: SessionPathOpts & { max?: number }): Promise<FilePreview> {
  const { real, fh, st } = await openSessionPath(opts);
  try {
    if (st.size > (opts.max ?? MAX_PREVIEW_BYTES)) throw new FileReadError('파일이 너무 커서 미리 볼 수 없습니다 (2MB 초과)', 413);
    const buf = await fh.readFile();
    const image = IMAGE_MAGIC.find((m) => m.test(buf));
    if (image) return { path: real, size: st.size, kind: 'image', mediaType: image.type, base64: buf.toString('base64') };
    if (buf.subarray(0, 8192).includes(0)) throw new FileReadError('바이너리 파일은 미리 볼 수 없습니다', 415);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new FileReadError('텍스트 파일이 아닙니다', 415); }
    return { path: real, size: st.size, kind: 'text', text };
  } finally {
    await fh.close();
  }
}

/**
 * Raw bytes (`/api/file?raw=1`) for anything that wasn't sniffed as a raster image. Everything that a browser could
 * render as active content from deck's origin (html, svg, xml, js…) is plain text; unknown extensions download.
 */
const RAW_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
const RAW_TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
  '.html', '.htm', '.xhtml', '.svg', '.xml', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.zsh', '.bash',
  '.sql', '.lua', '.r', '.vue', '.svelte', '.diff', '.patch',
]);

/** Content-Type for raw bytes: sniffed raster image, else the safe extension mapping, else octet-stream. */
export function rawContentType(name: string, head: Buffer): string {
  const image = IMAGE_MAGIC.find((m) => m.test(head));
  if (image) return image.type;
  const ext = path.extname(name).toLowerCase();
  if (RAW_TEXT_EXT.has(ext)) return 'text/plain; charset=utf-8';
  return RAW_TYPES[ext] ?? 'application/octet-stream';
}

export type RawSessionFile = { path: string; name: string; size: number; contentType: string; fh: import('node:fs/promises').FileHandle };

/**
 * `GET /api/file?raw=1`: the same check as the preview, then the still-open handle for streaming — the bytes sent
 * come from the very file that was checked (no reopen by name). The caller owns `fh` (a stream with autoClose).
 */
export async function openSessionFileRaw(opts: SessionPathOpts & { max?: number }): Promise<RawSessionFile> {
  const { real, fh, st } = await openSessionPath(opts);
  try {
    if (st.size > (opts.max ?? MAX_RAW_BYTES)) throw new FileReadError('파일이 너무 큽니다 (50MB 초과)', 413);
    const head = Buffer.alloc(16);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return { path: real, name: path.basename(real), size: st.size, contentType: rawContentType(real, head.subarray(0, bytesRead)), fh };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

export type RevealExec = (cmd: string, args: string[], cb: (err: Error | null) => void) => void;
const defaultExec: RevealExec = (cmd, args, cb) => { execFile(cmd, args, { timeout: 10_000 }, (err) => cb(err)); };

/**
 * `POST /api/reveal`: shows a file (selected) or folder of the session in Finder. It opens on the SERVER Mac's
 * screen — a remote user (phone, other Mac) sees nothing. Same check as the preview; no shell (execFile).
 */
export async function revealSessionPath(opts: SessionPathOpts & { platform?: NodeJS.Platform; execFile?: RevealExec }): Promise<void> {
  const { real, fh, st } = await openSessionPath(opts, true);
  await fh.close();
  if ((opts.platform ?? process.platform) !== 'darwin') throw new FileReadError('서버가 macOS 가 아니라 Finder 를 열 수 없습니다', 501);
  // Always reveal (`-R`), folders too: a plain `open` of a folder LAUNCHES bundles (`x.app`, `.prefPane`), and a reply
  // can be steered into naming one. `real` is absolute (starts with /), so it can't be taken for an option.
  void st;
  await new Promise<void>((resolve, reject) => {
    (opts.execFile ?? defaultExec)('open', ['-R', real], (err) => (err ? reject(new FileReadError('Finder 를 열지 못했습니다', 500)) : resolve()));
  });
}
