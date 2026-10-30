import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadOrCreateToken } from '../auth';

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** `Authorization: Bearer <token>` → the token, or null when the header is not a bearer. */
export function bearerOf(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1] ?? null;
}

/**
 * The read-only widget token (`~/.config/deck/widget-token`, 0600): a second 64-hex token that is good for exactly
 * one thing, `GET /api/mini/status` with `Authorization: Bearer`. Made on first use; `rotate()` replaces it (the only
 * write anywhere in the mini feature). The main login token is never read here, and no method ever logs the value.
 */
export class WidgetTokenStore {
  private token: string | null = null;
  private loading: Promise<string> | null = null;
  constructor(private readonly file: string) {}

  /** The current token, created on the first call. */
  current(): Promise<string> {
    if (this.token) return Promise.resolve(this.token);
    this.loading ??= loadOrCreateToken(this.file).then((t) => { this.token = t; return t; }).finally(() => { this.loading = null; });
    return this.loading;
  }

  /** A fresh random token written over the old one (0600; the old value stops working at once). */
  async rotate(): Promise<string> {
    await this.current();
    const next = randomBytes(32).toString('hex');
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, next + '\n', { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, this.file);
    this.token = next;
    return next;
  }

  /** Constant-time compare against the current token (loads it on first use). */
  async matches(candidate: string | null): Promise<boolean> {
    if (!candidate || !TOKEN_RE.test(candidate)) return false;
    const t = await this.current();
    const a = Buffer.from(candidate);
    const b = Buffer.from(t);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
