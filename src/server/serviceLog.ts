import fs from 'node:fs';

/** The LaunchAgent's stdout/stderr file is capped here (systemd services log to journald, which caps itself). */
export const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Over the cap → copy to `<file>.1` (replacing the older one) and truncate in place. launchd keeps the file open with
 * O_APPEND, so a rename would leave it writing into `.1`; truncation keeps the same inode. Best-effort: false on any error.
 */
export function capServiceLog(file: string, maxBytes = SERVICE_LOG_MAX_BYTES): boolean {
  try {
    if (fs.statSync(file).size < maxBytes) return false;
    fs.copyFileSync(file, `${file}.1`);
    fs.chmodSync(`${file}.1`, 0o600);
    fs.truncateSync(file, 0);
    return true;
  } catch {
    return false;
  }
}
