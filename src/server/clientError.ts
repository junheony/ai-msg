import { errnoOf } from './fsRetry';

/** Node errno names and absolute paths must not ride along in a browser-facing sentence. */
const FS_CODE = /\b(ENOENT|EPERM|EACCES|EBUSY|EAGAIN|EIO|ENOTDIR|EMFILE|ENFILE|EISDIR)\b/;
const ABS_PATH = /(?:^|[\s'"(])(?:\/(?:Users|home|var|tmp|opt|private|Volumes)\/|~\/|[A-Za-z]:\\)/;

/**
 * A file-read failure shown in the chat. A Korean reason with no path is kept. An errno or an absolute path
 * is replaced with a short reason; the original line stays in the server log.
 */
export function clientFileError(label: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = (raw.split('\n')[0] ?? raw).trim();
  const code = errnoOf(err);
  if (!code && !FS_CODE.test(line) && !ABS_PATH.test(line)) return line ? `${label}: ${line}` : label;
  console.error(`deck: ${label}`, [code, line].filter(Boolean).join(' ').slice(0, 500));
  if (code === 'ENOENT' || /\bENOENT\b/.test(line)) return `${label}: 파일을 찾을 수 없습니다`;
  if (code === 'EPERM' || code === 'EACCES' || /\bEPERM\b|\bEACCES\b/.test(line)) return `${label}: 권한이 없습니다`;
  if (code === 'EISDIR' || /\bEISDIR\b/.test(line)) return `${label}: 파일이 아닙니다`;
  return label;
}
