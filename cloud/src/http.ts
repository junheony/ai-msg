import type { ApiError } from '../../src/shared/cloud/api-types';

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/** `{error, code}` — `error` is a short English sentence, `code` is what clients branch on. */
export const problem = (status: number, code: string, error: string = code): Response => json(status, { error, code } satisfies ApiError);

export const redirect = (location: string, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 303, headers: { location, ...headers } });

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const mediaType = (req: Request) => (req.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();

/**
 * The request body as a flat object. JSON only, unless `form` also allows a same-origin
 * `application/x-www-form-urlencoded` form. Throws `HttpError` 415 / 400.
 */
export async function readBody(req: Request, opts: { form?: boolean } = {}): Promise<Record<string, unknown>> {
  const type = mediaType(req);
  if (type === 'application/json') {
    let v: unknown;
    try { v = await req.json(); } catch { throw new HttpError(400, 'bad_request'); }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'bad_request');
    return v as Record<string, unknown>;
  }
  if (opts.form && type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(await req.text()));
  throw new HttpError(415, 'bad_content_type');
}

/** A string field of 1..max characters, or `HttpError` 400. */
export function str(body: Record<string, unknown>, key: string, max = 256): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new HttpError(400, 'bad_request');
  return v;
}

/** The 8 groups of an IPv6 address (`::` expanded, an embedded IPv4 tail as two groups), or `null`. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.split('%', 1)[0]!.toLowerCase(); // zone id
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(2).map(Number);
    if (b.some((n) => n > 255)) return null;
    s = `${v4[1]}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h: string) => (h === '' ? [] : h.split(':'));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The key per-IP limits count under: IPv4 as is, IPv6 as its /64 (one subscriber usually holds a whole /64, so a
 * full address would give them 2^64 fresh counters). IPv4-mapped IPv6 counts as the IPv4 address.
 */
export function ipKey(raw: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw;
  const g = ipv6Groups(raw);
  if (!g) return 'unknown';
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.');
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(':')}::/64`;
}

export const clientIp = (req: Request): string => ipKey(req.headers.get('cf-connecting-ip') ?? '');
