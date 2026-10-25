import { problem } from '../http';
import { NOTICE } from '../legal/notice';
import { LEGAL, LEGAL_DRAFT } from '../legal/pages.gen';
import type { Ctx } from '../router';
import { esc, page } from './layout';

/** No script at all on the legal pages; they change only with a deploy, so an hour of caching is fine. */
export const LEGAL_CSP = "default-src 'self'; script-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const LEGAL_HEADERS = { 'cache-control': 'public, max-age=3600' };

const NOTICE_TITLE = { en: 'Notice', ko: '고지' } as const;
const DRAFT_BANNER = { en: 'Draft — not yet in force', ko: '초안 — 아직 시행 전' } as const;

/**
 * `GET /legal/{terms,privacy,refund,notice}` (English) and `/legal/ko/…` (Korean), app origin only. The documents are
 * built from `docs/legal/*.md` (scripts/build-legal.mjs). A build with draft marks shows a banner on top — only
 * locally and in tests, since `predeploy` builds with `--strict`.
 */
const legalPage = (lang: 'en' | 'ko') => async (c: Ctx): Promise<Response> => {
  const doc = c.params.doc ?? '';
  const draft = LEGAL_DRAFT ? `<p class="draft" role="note">${DRAFT_BANNER[lang]}</p>` : '';
  if (doc === 'notice') {
    return page(NOTICE_TITLE[lang], `${draft}<h1>${NOTICE_TITLE[lang]}</h1><p>${esc(NOTICE[lang])}</p>`, { csp: LEGAL_CSP, headers: LEGAL_HEADERS, lang });
  }
  if (!Object.hasOwn(LEGAL, doc)) return problem(404, 'not_found');
  const d = LEGAL[doc as keyof typeof LEGAL][lang];
  return page(d.title, `${draft}<article class="legal">${d.html}</article>`, { csp: LEGAL_CSP, headers: LEGAL_HEADERS, lang });
};

export const legalEn = legalPage('en');
export const legalKo = legalPage('ko');
