/**
 * Server-rendered app-origin pages: English, no inline script or style (CSP `default-src 'self'`).
 * Referrer policy `same-origin`, not `no-referrer`: under `no-referrer` a browser form POST sends `Origin: null`,
 * which the cookie-route Origin check (rightly) refuses. Nothing leaves the origin either way.
 */

import { NOTICE_SHORT } from '../legal/notice';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** Footer of every app page: the legal links and the non-affiliation notice (Korean on the Korean legal pages). */
const FOOTER = {
  en: `<a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a> · <a href="/legal/refund">Refunds</a> · <a href="/legal/notice">Notice</a>`,
  ko: `<a href="/legal/ko/terms">이용약관</a> · <a href="/legal/ko/privacy">개인정보처리방침</a> · <a href="/legal/ko/refund">환불 정책</a> · <a href="/legal/ko/notice">고지</a> · <a href="/legal/terms">English</a>`,
} as const;

/**
 * `csp` replaces the default app page policy (index.ts) — /checkout (Paddle.js) and the legal pages pass one.
 * `headers` adds response headers (the legal pages' cache policy). `lang` is `en` unless a Korean legal page says `ko`.
 */
export function page(title: string, body: string, opts: { status?: number; scripts?: string[]; csp?: string; headers?: Record<string, string>; lang?: 'en' | 'ko' } = {}): Response {
  const lang = opts.lang ?? 'en';
  const scripts = (opts.scripts ?? []).map((src) => `<script src="${esc(src)}" defer></script>`).join('');
  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin"><title>${esc(title)} · AI msg</title><link rel="stylesheet" href="/static/pages.css">${scripts}</head>
<body><main>${body}</main>
<footer><p>${FOOTER[lang]}</p><p>${esc(NOTICE_SHORT[lang])}</p></footer>
</body></html>`;
  const headers: Record<string, string> = { ...opts.headers, 'content-type': 'text/html; charset=utf-8' };
  if (opts.csp) headers['content-security-policy'] = opts.csp;
  return new Response(html, { status: opts.status ?? 200, headers });
}

/** The only Pro description on the cloud pages: relay and push, nothing else (launch check, 필수 6). */
export const PRO_LINE = "AI-MSG Pro: a cloud relay to see and approve your Mac's sessions from your phone, with push notifications.";

/** A calendar date in UTC (`2026-11-02`) — the server does not know the reader's locale. */
export const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
