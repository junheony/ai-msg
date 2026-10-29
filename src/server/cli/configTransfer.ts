import fs from 'node:fs';
import path from 'node:path';

/**
 * Move deck's own config (pins, titles, archive, account pins, permission/settings, memory) to another host.
 * The archive is a JSON file of those texts. It never includes the login token, push keys, or service env,
 * and the command's stdout/stderr name files only — never their contents.
 */

export const EXPORT_FORMAT = 'deck-config-export';
export const EXPORT_VERSION = 1;

/** User state the sidebar and settings need on a new host. Order is the archive's file order. */
export const EXPORT_FILES = [
  'pins.json',
  'session-meta.json',
  'session-state.json',
  'session-icons.json',
  'settings.json',
  'projects.json',
  'recent-folders.json',
  'accounts.json',
  'memory.md',
] as const;

/** Never copied, even if an archive names them. Listed in the command output so an operator can see the policy. */
export const SECRET_FILES = ['token', 'vapid.json', 'push-subscriptions.json', 'service.env', 'env'] as const;

const ALLOW = new Set<string>(EXPORT_FILES);
const MAX_FILE = 4 * 1024 * 1024;
const MAX_ARCHIVE = 16 * 1024 * 1024;

export type TransferIo = {
  configDir: string;
  out: (s: string) => void;
  err: (s: string) => void;
  /** Live server holds this config dir. Import refuses; export still reads. */
  isLocked?: () => boolean;
  cwd?: string;
};

const SKIP: Record<string, string> = {
  symlink: '심볼릭 링크',
  binary: '텍스트가 아님',
  big: '너무 큼',
  dir: '파일이 아님',
  unreadable: '읽을 수 없음',
};

type ReadFail = keyof typeof SKIP;

function readRegularText(file: string, max: number): { ok: true; text: string } | { ok: false; reason: ReadFail | 'missing' } {
  let fh: number;
  try {
    fh = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    if (code === 'ELOOP') return { ok: false, reason: 'symlink' };
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const st = fs.fstatSync(fh);
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (!st.isFile()) return { ok: false, reason: 'dir' };
    if (st.size > max) return { ok: false, reason: 'big' };
    const buf = Buffer.alloc(st.size);
    fs.readSync(fh, buf, 0, st.size, 0);
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
    } catch {
      return { ok: false, reason: 'binary' };
    }
  } finally {
    fs.closeSync(fh);
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isSymlink(file: string): boolean {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

/** Mode 0600, replacing a regular file. A symlink at `file` is left untouched and reported. */
function writePrivate(file: string, text: string): void {
  if (isSymlink(file)) throw Object.assign(new Error('symlink'), { code: 'ELOOP' });
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fh = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fh, text); } finally { fs.closeSync(fh); }
  fs.chmodSync(tmp, 0o600);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.chmodSync(file, 0o600);
}

function secretLine(): string {
  return `비밀 파일은 넣지 않습니다: ${SECRET_FILES.join(', ')}`;
}

const TRANSCRIPT_LINE = '대화 원본(CLI 홈)과 첨부 파일은 이 묶음에 없습니다.';

/** Write the portable config next to `outFile` (default `./deck-config.json`). Never prints file contents. */
export function exportConfig(io: TransferIo, opts: { outFile?: string } = {}): number {
  const cwd = io.cwd ?? process.cwd();
  const dest = path.resolve(cwd, opts.outFile ?? 'deck-config.json');
  if (isInside(io.configDir, dest)) {
    io.err('설정 폴더 안에는 내보낼 수 없습니다 — 다른 경로를 --out 으로 지정하세요');
    return 1;
  }
  const files: Record<string, string> = {};
  let skipped = false;
  let total = 0;
  for (const name of EXPORT_FILES) {
    const read = readRegularText(path.join(io.configDir, name), MAX_FILE);
    if (!read.ok) {
      if (read.reason === 'missing') continue;
      skipped = true;
      io.err(`건너뜀: ${name} (${SKIP[read.reason]})`);
      continue;
    }
    total += Buffer.byteLength(read.text);
    if (total > MAX_ARCHIVE) {
      skipped = true;
      io.err('건너뜀: 묶음이 너무 큽니다');
      break;
    }
    files[name] = read.text;
  }
  const body = JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, files }, null, 2) + '\n';
  try {
    writePrivate(dest, body);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    io.err(code === 'ELOOP' ? '내보낼 경로가 심볼릭 링크라 쓰지 않습니다' : '설정 묶음을 쓰지 못했습니다');
    return 1;
  }
  const names = Object.keys(files);
  io.out([`내보냄: ${dest}`, `포함: ${names.length ? names.join(', ') : '(없음)'}`, secretLine(), TRANSCRIPT_LINE].join('\n'));
  return skipped ? 1 : 0;
}

type Archive = { files: Record<string, string>; ignoredSecrets: string[] };

function parseArchive(text: string): Archive | 'format' | 'version' | 'big' {
  if (Buffer.byteLength(text) > MAX_ARCHIVE) return 'big';
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return 'format'; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'format';
  const rec = raw as Record<string, unknown>;
  if (rec.format !== EXPORT_FORMAT) return 'format';
  if (rec.version !== EXPORT_VERSION) return 'version';
  if (!rec.files || typeof rec.files !== 'object' || Array.isArray(rec.files)) return 'format';
  const src = rec.files as Record<string, unknown>;
  const files: Record<string, string> = {};
  const ignoredSecrets: string[] = [];
  let total = 0;
  for (const key of Object.keys(src)) {
    if ((SECRET_FILES as readonly string[]).includes(key)) { ignoredSecrets.push(key); continue; }
    if (!ALLOW.has(key)) continue;
    const val = src[key];
    if (typeof val !== 'string') return 'format';
    const n = Buffer.byteLength(val);
    if (n > MAX_FILE) return 'big';
    total += n;
    if (total > MAX_ARCHIVE) return 'big';
    files[key] = val;
  }
  return { files, ignoredSecrets };
}

/**
 * Replace allowlisted files in the config dir from an archive. Refuses while a server holds the dir,
 * and refuses to overwrite an existing file unless `yes`. The token and other secret files are never written.
 */
export function importConfig(io: TransferIo, opts: { file: string; yes: boolean }): number {
  if (io.isLocked?.()) {
    io.err('서버가 이 설정 폴더를 쓰는 중이라 가져오지 않습니다 — 서비스를 멈춘 뒤 다시 실행하세요');
    return 1;
  }
  const src = path.resolve(io.cwd ?? process.cwd(), opts.file);
  const read = readRegularText(src, MAX_ARCHIVE);
  if (!read.ok) {
    io.err(read.reason === 'missing' ? '설정 묶음 파일을 찾지 못했습니다' : read.reason === 'symlink' ? '설정 묶음 경로가 심볼릭 링크라 읽지 않습니다' : '설정 묶음을 읽지 못했습니다');
    return 1;
  }
  const parsed = parseArchive(read.text);
  if (parsed === 'format') { io.err('이 파일은 MSG 설정 묶음이 아닙니다'); return 1; }
  if (parsed === 'version') { io.err('이 묶음의 버전은 가져올 수 없습니다'); return 1; }
  if (parsed === 'big') { io.err('설정 묶음이 너무 큽니다'); return 1; }
  const names = Object.keys(parsed.files);
  if (!names.length) {
    io.err('가져올 설정 파일이 없습니다');
    io.out(secretLine());
    return 1;
  }
  const existing = names.filter((name) => {
    const dest = path.join(io.configDir, name);
    if (isSymlink(dest)) return false;
    try { return fs.statSync(dest).isFile(); } catch { return false; }
  });
  if (existing.length && !opts.yes) {
    io.err(`이미 있는 파일을 덮어쓰려면 --yes 가 필요합니다: ${existing.join(', ')}`);
    return 2;
  }
  const symlinks = names.filter((name) => isSymlink(path.join(io.configDir, name)));
  if (symlinks.length) {
    for (const name of symlinks) io.err(`건너뜀: ${name} (심볼릭 링크)`);
    return 1;
  }
  try { fs.mkdirSync(io.configDir, { recursive: true, mode: 0o700 }); } catch {
    io.err('설정 폴더를 만들지 못했습니다');
    return 1;
  }
  const wrote: string[] = [];
  try {
    for (const name of names) {
      writePrivate(path.join(io.configDir, name), parsed.files[name]!);
      wrote.push(name);
    }
  } catch {
    io.err(wrote.length ? `일부만 가져왔습니다: ${wrote.join(', ')}` : '설정 파일을 쓰지 못했습니다');
    return 1;
  }
  const lines = [`가져옴: ${wrote.join(', ')}`, '로그인 토큰은 가져오지 않습니다. 새 호스트의 token 을 그대로 둡니다.', secretLine()];
  if (parsed.ignoredSecrets.length) lines.push(`묶음에 있어도 두지 않음: ${parsed.ignoredSecrets.join(', ')}`);
  io.out(lines.join('\n'));
  return 0;
}
