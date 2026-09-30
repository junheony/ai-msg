import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const COOKIE_NAME = 'deck_session';
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;

export async function loadOrCreateToken(file: string): Promise<string> {
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // fall through: create
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const token = randomBytes(32).toString('hex');
  await fs.writeFile(file, token + '\n', { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return token;
}

/** The browser never holds the login token itself, only this derived value. */
export function cookieValueFor(token: string): string {
  return createHash('sha256').update(`deck-cookie:${token}`).digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = safeDecode(v);
  }
  return out;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function isAuthed(cookieHeader: string | undefined, token: string): boolean {
  const v = parseCookies(cookieHeader)[COOKIE_NAME];
  return typeof v === 'string' && safeEqual(v, cookieValueFor(token));
}

export function tokenMatches(candidate: string, token: string): boolean {
  return safeEqual(candidate.trim(), token);
}

export function loginCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${cookieValueFor(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
}

export function logoutCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export type UpgradeCheck = { ok: true } | { ok: false; reason: string };

/**
 * WebSocket upgrade gate (spec §6): the session cookie must validate and the
 * Origin must be this server itself (scheme http, host:port equal to the Host
 * header) or one of `extraOrigins` (Vite dev server).
 */
export function checkUpgrade(
  req: { headers: { cookie?: string; origin?: string; host?: string } },
  token: string,
  extraOrigins: string[] = [],
): UpgradeCheck {
  if (!isAuthed(req.headers.cookie, token)) return { ok: false, reason: 'unauthenticated' };
  const origin = req.headers.origin;
  if (!origin) return { ok: false, reason: 'missing origin' };
  const host = req.headers.host ?? '';
  const self = `http://${host}`;
  if (origin === self || extraOrigins.includes(origin)) return { ok: true };
  return { ok: false, reason: `origin ${origin} not allowed` };
}
