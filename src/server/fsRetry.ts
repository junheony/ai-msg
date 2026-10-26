/** Codes that often clear within a moment: an atomic rename, a full fd table, a busy file. EPERM/EACCES do not. */
export const TRANSIENT_FS = new Set(['ENOENT', 'EBUSY', 'EAGAIN', 'EIO', 'EMFILE', 'ENFILE']);

export function errnoOf(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') return (err as { code: string }).code;
  return undefined;
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Run `fn` again when it fails with a transient filesystem code (a file mid-rename, a brief EIO).
 * Permission errors are not retried: macOS TCC keeps refusing the same process until it is restarted.
 */
export async function withFileRetry<T>(fn: () => Promise<T>, attempts = 3, waitMs = 25): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const code = errnoOf(err);
      if (!code || !TRANSIENT_FS.has(code) || i === attempts - 1) throw err;
      await wait(waitMs * (i + 1));
    }
  }
  throw last;
}
