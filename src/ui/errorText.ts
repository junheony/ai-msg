import { ui } from './i18n';

/** An error put into words: `text` to show, `raw` (the original) to fold underneath — null when `text` is already it. */
export type ErrorText = { text: string; raw: string | null };

/** An HTTP status only counts with its context ("status 401", "HTTP 429", "API Error: 529", "401 Unauthorized"): a bare number or word in a tool's own error is not the API's. */
const status = (code: number, reason: string) => `(?:status(?: code)?|HTTP(?:/[\\d.]+)?|API Error:?)\\s*${code}\\b|\\b${code} ${reason}`;

/** Raw codes and English API phrases → the readable sentence (ui().common.errors); first match wins. */
const RULES: [RegExp, keyof ReturnType<typeof ui>['common']['errors']][] = [
  [/error_max_turns|max[_ ]turns/i, 'maxTurns'],
  [/error_max_budget|max[_ ]budget|budget[_ ]exceeded/i, 'maxBudget'],
  [new RegExp(`overloaded_error|API is overloaded|${status(529, 'Overloaded')}`, 'i'), 'overloaded'],
  [new RegExp(`rate_limit_error|rate limit (?:exceeded|reached)|${status(429, 'Too Many Requests')}`, 'i'), 'rateLimit'],
  [new RegExp(`authentication_error|invalid[_ ]api[_ ]key|invalid x-api-key|not logged in|oauth token (?:has )?expired|${status(401, 'Unauthorized')}`, 'i'), 'auth'],
  [/request timed out|timeout_error|ETIMEDOUT|(?:API|request) timeout/i, 'timeout'],
  [/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error|fetch failed/i, 'network'],
  [/error_during_execution/i, 'execution'],
];

/** A bare machine code (snake_case / UPPER_CASE, no spaces): not something to show a person as it is. */
const BARE_CODE = /^[A-Za-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+)+$/;
const HANGUL = /[가-힣]/;

/**
 * A raw error (a CLI subtype such as "error_during_execution", an API message) → a sentence a person can act on,
 * with the original kept for 자세히. Text that is already written for people (any Korean, or no known code in it) is
 * shown as it is.
 */
export function describeError(raw: string): ErrorText {
  const s = raw.trim();
  if (!s || HANGUL.test(s)) return { text: raw, raw: null };
  const errors = ui().common.errors;
  const hit = RULES.find(([re]) => re.test(s));
  if (hit) return { text: errors[hit[1]], raw: s };
  if (BARE_CODE.test(s)) return { text: errors.unknown, raw: s };
  return { text: raw, raw: null };
}
