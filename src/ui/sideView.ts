/** Pure helpers behind the side panel's file view (SidePanel.tsx): sizes, error kinds, links inside a document, 파일 열기. */

/** 812 B · 4.2 KB · 1.6 MB (the panel's footer and error card). */
export function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Lines of `text` as the gutter numbers them (a trailing newline does not start another line). */
export function lineCount(text: string): number {
  if (!text) return 1;
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n += 1;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Why a file did not open, from the HTTP status the server answered (server/files.ts FileReadError): 0 = no answer.
 * `tooBig` / `binary` can still be downloaded; the rest only retried.
 */
export type FileErrorKind = 'missing' | 'denied' | 'tooBig' | 'binary' | 'offline' | 'other';
export function fileErrorKind(status: number | undefined): FileErrorKind {
  if (status === 404) return 'missing';
  if (status === 403) return 'denied';
  if (status === 413) return 'tooBig';
  if (status === 415) return 'binary';
  if (status === 0) return 'offline';
  return 'other';
}

/** The status getJson attached to its error (absent: not an HTTP failure). */
export function errorStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

/**
 * A relative link inside a document opened in the panel (`[plan](./plan.md)` in docs/spec.md) points next to that
 * document, not at the session folder: joined onto the document's directory, `.` / `..` folded. Absolute and `~/` paths
 * are left alone; a `..` that climbs past the document's own root stays in front (the server refuses what leaves the folder).
 */
export function resolveDocLink(docPath: string, href: string): string {
  if (href.startsWith('/') || href.startsWith('~')) return href;
  const slash = docPath.lastIndexOf('/');
  const dir = slash >= 0 ? docPath.slice(0, slash) : '';
  const abs = dir.startsWith('/');
  const out: string[] = [];
  for (const part of [...dir.split('/'), ...href.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (part === '..' && abs) continue;
    else out.push(part);
  }
  return (abs ? '/' : '') + out.join('/');
}

/**
 * 파일 열기's Enter / 열기: what was typed when it names a listed file exactly or nothing matches (a path the list does
 * not have — the server answers), else the highlighted match.
 */
export function pickTarget(typed: string, matches: string[], files: string[], active: number): string | null {
  const t = typed.trim();
  if (t && files.includes(t)) return t;
  if (matches.length && active >= 0 && active < matches.length) return matches[active]!;
  return t || null;
}
