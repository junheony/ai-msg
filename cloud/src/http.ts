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

export const clientIp = (req: Request): string => req.headers.get('cf-connecting-ip') ?? 'unknown';
