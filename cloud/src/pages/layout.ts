/**
 * Server-rendered app-origin pages: English, no inline script or style (CSP `default-src 'self'`).
 * Referrer policy `same-origin`, not `no-referrer`: under `no-referrer` a browser form POST sends `Origin: null`,
 * which the cookie-route Origin check (rightly) refuses. Nothing leaves the origin either way.
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

export function page(title: string, body: string, opts: { status?: number; scripts?: string[] } = {}): Response {
  const scripts = (opts.scripts ?? []).map((src) => `<script src="${esc(src)}" defer></script>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin"><title>${esc(title)} · AI msg</title>${scripts}</head>
<body><main>${body}</main>
<footer><a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a> · <a href="/legal/refund">Refunds</a></footer>
</body></html>`;
  return new Response(html, { status: opts.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
