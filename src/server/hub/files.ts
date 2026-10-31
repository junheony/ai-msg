/**
 * MSG Hub read-only file route: `GET /api/hub/file/<root>/<relative path>` serves media and build outputs from a few
 * named folders (영상 renders, 게임 dist) to the logged-in page. Only an extension allowlist, only files that resolve
 * inside the root after symlinks, never a directory listing. HTML is served under a sandbox CSP so a playable build
 * runs in an opaque origin (no cookies, no same-origin access to the app).
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

export const HUB_FILE_PREFIX = '/api/hub/file/';

export type HubFileRoots = Record<string, string>;

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const MAX_BYTES = 512 * 1024 * 1024;

/** The URL for a file under a root, as collectors hand it to the UI. */
export function hubFileUrl(root: string, rel: string): string {
  return HUB_FILE_PREFIX + root + '/' + rel.split('/').filter((s) => s && s !== '.' && s !== '..').map(encodeURIComponent).join('/');
}

/** Resolve a request path against the roots: the real file path and its type, or a status to answer with. */
export async function resolveHubFile(roots: HubFileRoots, pathname: string): Promise<{ file: string; type: string; size: number } | { status: 400 | 403 | 404 | 413 }> {
  if (!pathname.startsWith(HUB_FILE_PREFIX)) return { status: 404 };
  const rest = pathname.slice(HUB_FILE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return { status: 404 };
  const rootName = rest.slice(0, slash);
  const root = roots[rootName];
  if (!root) return { status: 404 };
  let rel: string;
  try { rel = rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/'); } catch { return { status: 400 }; }
  if (!rel || rel.includes('\0') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return { status: 400 };
  const ext = path.extname(rel).toLowerCase();
  const type = TYPES[ext];
  if (!type) return { status: 403 };
  let real: string; let rootReal: string;
  try { rootReal = await fs.realpath(root); real = await fs.realpath(path.join(root, rel)); } catch { return { status: 404 }; }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { status: 403 };
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try { st = await fs.stat(real); } catch { return { status: 404 }; }
  if (!st.isFile()) return { status: 404 };
  if (st.size > MAX_BYTES) return { status: 413 };
  return { file: real, type, size: st.size };
}

/** Answer the request (GET or HEAD). Supports a single byte range so video can seek. */
export async function serveHubFile(roots: HubFileRoots, pathname: string, range: string | undefined, head: boolean, res: ServerResponse): Promise<void> {
  const r = await resolveHubFile(roots, pathname);
  if ('status' in r) { res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: r.status === 404 ? 'not found' : r.status === 403 ? 'forbidden' : r.status === 413 ? 'too large' : 'bad request' })); return; }
  const headers: Record<string, string> = {
    'content-type': r.type,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=60',
    'accept-ranges': 'bytes',
    'referrer-policy': 'no-referrer',
  };
  // HTML (a playable build) runs sandboxed: scripts allowed, but an opaque origin — no cookies, no app access.
  if (r.type.startsWith('text/html')) headers['content-security-policy'] = "sandbox allow-scripts allow-pointer-lock allow-popups; frame-ancestors 'self'";
  let start = 0; let end = r.size - 1; let status = 200;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && r.size > 0) {
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), r.size - 1) : r.size - 1; } else if (m[2]) { start = Math.max(0, r.size - Number(m[2])); }
    if (start > end || start >= r.size) { res.writeHead(416, { 'content-range': `bytes */${r.size}` }); res.end(); return; }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${r.size}`;
  }
  headers['content-length'] = String(r.size === 0 ? 0 : end - start + 1);
  res.writeHead(status, headers);
  if (head || r.size === 0) { res.end(); return; }
  const stream = createReadStream(r.file, { start, end });
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
