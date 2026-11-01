/** Fixed loopback summary only. No filesystem or trading control access. */
import type { ServerResponse } from 'node:http';
import { LAB_SUPPRESS_RE, type LabExtra, type LabExtraValue, type LabResponse, type LabSnapshot } from '../../shared/lab-types';
import { SECRET_FIELD_RE, bool, errorText, isObj, num, scrub, slowCache, stripSecrets } from './shared';

export const LAB_PREFIX = '/api/hub/lab';
export const LAB_URL = 'http://127.0.0.1:8792/lab/api/summary';
export const LAB_CACHE_MS = 60_000;
export const LAB_TIMEOUT_MS = 5_000;
/** Dedicated transport: no redirects, cookies or credentials; a bounded diagnostic never logs source strings. */
export async function fetchLabJson(_url: string = LAB_URL, timeoutMs = LAB_TIMEOUT_MS): Promise<unknown> {
  const response = await fetch(LAB_URL, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new SyntaxError('JSON empty response');
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) { await reader.cancel(); throw new SyntaxError('JSON response too large'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text) as unknown; }
  catch {
    // Preserve only JSON punctuation in the first 200 characters, including for broken/unterminated strings.
    // Values, keys, URLs and secrets are never included in logs.
    const diagnostic = text.slice(0, 200).replace(/[^\s{}\[\]:,"]/g, '·').replace(/\s/g, ' ');
    console.warn('[lab] JSON parse failed; redacted prefix:', diagnostic);
    throw new SyntaxError('JSON parse failed');
  }
}
function validKstLocal(value: string): boolean {
  const normalized = value.replace(' ', 'T');
  const ms = Date.parse(`${normalized}+09:00`);
  return Number.isFinite(ms) && new Date(ms + 9 * 3_600_000).toISOString().slice(0, normalized.length) === normalized;
}
class LabValidationError extends Error {}
const obj = (v: unknown): Record<string, unknown> => isObj(v) ? v : {};

/* ───────── unknown fields, kept generically ───────── */

/** Old kNN scenario probabilities must never reach the room, not even through an unknown field. */
export { LAB_SUPPRESS_RE };
/**
 * `depth` is container levels (a realistic future `backtests.strategies[0].metrics.sharpe` is four); `nodes` is the
 * whole-tree cap per mapped summary so a deeper allowance cannot turn into an unbounded page.
 */
export const LAB_EXTRA_LIMITS = { depth: 6, nodes: 400, keys: 24, items: 20, text: 120, key: 40 } as const;
const KNOWN_TOP = new Set(['schema', 'generated_at', 'live', 'read_only', 'sources', 'errors', 'engine', 'books', 'open_positions_total', 'recent_closed_trades', 'ledger', 'verify']);
/** Transport metadata the feed reports about itself (its cache TTL, upstream timeout): not strategy content, never shown. */
const KNOWN_TOP_META = new Set(['cache']);
const KNOWN_BOOK = new Set(['id', 'label', 'equity', 'return_pct', 'pnl', 'n_trades', 'wins', 'open_positions', 'max_dd_pct', 'open']);
const KNOWN_LEDGER = new Set(['certifiable_closed_trades', 'span_days', 'all_pass', 'expectancy']);
const KNOWN_VERIFY = new Set(['ok', 'msg', 'entries', 'head', 'last_merkle_root', 'last_merkle_root_date', 'last_ots_status', 'gap_count', 'gap_seconds_total']);
const KNOWN_PAPER = new Set(['ok', 'ready', 'live']);
const KNOWN_LEDGER_ENGINE = new Set(['ok']);
const EXTRA_KEY_RE = /^[\p{L}\p{N}_.\- ]{1,40}$/u;
/** Markup and anything address-like cannot ride a free-text field into the page. */
const URLISH_RE = /[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S+|<\/?[a-z!?][^<>]*>?|`/gi;

const extraKeyOk = (k: string): boolean => EXTRA_KEY_RE.test(k) && !SECRET_FIELD_RE.test(k) && !LAB_SUPPRESS_RE.test(k);
function extraText(v: string): string | undefined {
  if (LAB_SUPPRESS_RE.test(v)) return undefined;
  return scrub(v, 400).replace(URLISH_RE, '…').replace(/\s+/g, ' ').trim().slice(0, LAB_EXTRA_LIMITS.text);
}
/** One summary's node allowance; every kept leaf or container spends one. */
export interface ExtraBudget { nodes: number }
export const extraBudget = (): ExtraBudget => ({ nodes: LAB_EXTRA_LIMITS.nodes });
/** `v` as a bounded plain tree, or undefined when nothing safe is left of it (or the budget is spent). */
export function extraValue(v: unknown, depth = 0, budget: ExtraBudget = extraBudget()): LabExtraValue | undefined {
  if (budget.nodes <= 0) return undefined;
  if (v === null) { budget.nodes -= 1; return null; }
  if (typeof v === 'boolean') { budget.nodes -= 1; return v; }
  if (typeof v === 'number') { budget.nodes -= 1; return Number.isFinite(v) ? v : null; }
  if (typeof v === 'string') { const t = extraText(v); if (t !== undefined) budget.nodes -= 1; return t; }
  if (depth >= LAB_EXTRA_LIMITS.depth) return undefined;
  if (Array.isArray(v)) {
    budget.nodes -= 1;
    const out: LabExtraValue[] = [];
    for (const item of v.slice(0, LAB_EXTRA_LIMITS.items)) { const x = extraValue(item, depth + 1, budget); if (x !== undefined) out.push(x); }
    return out;
  }
  if (isObj(v)) { budget.nodes -= 1; return extraObject(v, () => false, depth + 1, budget); }
  return undefined;
}
/** The keys of `src` that `known` does not claim, each as a safe tree; keys are kept in the feed's order. */
export function extraObject(src: Record<string, unknown>, known: (k: string) => boolean, depth = 0, budget: ExtraBudget = extraBudget()): LabExtra {
  const out: LabExtra = {};
  let n = 0;
  for (const [k, v] of Object.entries(src)) {
    if (known(k) || !extraKeyOk(k)) continue;
    if (n >= LAB_EXTRA_LIMITS.keys || budget.nodes <= 0) break;
    const x = extraValue(v, depth, budget);
    if (x === undefined) continue;
    out[k] = x; n += 1;
  }
  return out;
}
const nonEmpty = (e: LabExtra): LabExtra | undefined => (Object.keys(e).length ? e : undefined);

export function mapLab(body: unknown): LabSnapshot {
  const raw = obj(body);
  const paperEnvelope = obj(obj(raw.engine).paper);
  if (raw.schema !== 'cblabx_lab_summary/v1' || raw.live !== false || raw.read_only !== true || ('live' in paperEnvelope && paperEnvelope.live !== false)) {
    throw new LabValidationError('요약 스키마 또는 읽기 전용 조건 오류');
  }
  const errors = Array.isArray(raw.errors) ? raw.errors.filter((e): e is string => typeof e === 'string').slice(0, 40).map(e => scrub(e, 240)) : ['errors: 응답 형식 오류'];
  if (Array.isArray(raw.errors) && raw.errors.some(e => typeof e !== 'string')) errors.push('errors: 응답 형식 오류');
  const issues: Record<string, string> = {};
  const sources = obj(raw.sources);
  const sourceError = (names: string[]) => {
    for (const name of names) {
      const reported = errors.find(e => e.startsWith(`${name}:`) || e.startsWith(`${name} `));
      if (reported) return reported;
      const source = obj(sources[name]);
      if (source.ok === false) return `${name}: ${scrub(source.error, 200) || '조회 오류'}`;
    }
    return null;
  };
  const read = <T,>(value: unknown, path: string, parse: (v: unknown) => T | null, names: string[]): T | null => {
    const parsed = parse(value);
    if (parsed === null) {
      const reason = sourceError(names) ?? (value !== null && value !== undefined ? '응답 형식 오류' : null);
      if (reason) issues[path] = reason;
    }
    return parsed;
  };
  const n = (v: unknown, p: string, ...s: string[]) => read(v, p, num, s);
  const count = (v: unknown, p: string, ...s: string[]) => read(v, p, x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null, s);
  const positive = (v: unknown, p: string, ...s: string[]) => read(v, p, x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null, s);
  const hash = (v: unknown, p: string, ...s: string[]) => read(v, p, x => typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x) ? x : null, s);
  const date = (v: unknown, p: string, ...s: string[]) => read(v, p, x => typeof x === 'string' && /^\d{4}-\d\d-\d\d$/.test(x) && validKstLocal(`${x}T00:00:00`) ? x : null, s);
  const side = (v: unknown, p: string, ...s: string[]) => read(v, p, x => x === 'long' || x === 'short' ? x : null, s);
  const time = (v: unknown, p: string, ...s: string[]) => read(v, p, x => typeof x === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?$/.test(x) && validKstLocal(x) ? x : null, s);
  const container = (value: unknown, path: string) => {
    if (value !== null && !isObj(value)) issues[path] = '응답 형식 오류';
    return obj(value);
  };
  const b = (v: unknown, p: string, ...s: string[]) => read(v, p, bool, s);
  const t = (v: unknown, p: string, ...s: string[]) => read(v, p, x => typeof x === 'string' && x.length ? scrub(x, 240) : null, s);
  const a = (v: unknown, p: string, ...s: string[]) => read(v, p, x => Array.isArray(x) ? x : null, s);
  const engine = container(raw.engine, 'engine'), paper = container(engine.paper, 'engine.paper'), ledgerEngine = container(engine.ledger, 'engine.ledger'), ledger = container(raw.ledger, 'ledger'), expectancy = container(ledger.expectancy, 'ledger.expectancy'), verify = container(raw.verify, 'verify');
  // One node budget for the whole summary: book, top-level and nested unknowns share it.
  const budget = extraBudget();
  const booksRaw = a(raw.books, 'books', 'paper_state');
  const loading = paper.ready === false || booksRaw?.length === 0;
  const books = booksRaw?.slice(0, 40).map((value, i) => {
    const p = `books.${i}`, book = container(value, p), pnl = container(book.pnl, `${p}.pnl`);
    if (!isObj(value)) issues[p] = '응답 형식 오류';
    return {
      id: t(book.id, `${p}.id`, 'paper_state'), label: t(book.label, `${p}.label`, 'paper_state'),
      equity: n(book.equity, `${p}.equity`, 'paper_state'), return_pct: n(book.return_pct, `${p}.return_pct`, 'paper_state'),
      pnl: { realized: n(pnl.realized, `${p}.pnl.realized`, 'paper_state'), unrealized: n(pnl.unrealized, `${p}.pnl.unrealized`, 'paper_state') },
      n_trades: count(book.n_trades, `${p}.n_trades`, 'paper_state'), wins: count(book.wins, `${p}.wins`, 'paper_state'),
      open_positions: count(book.open_positions, `${p}.open_positions`, 'paper_state'), max_dd_pct: positive(book.max_dd_pct, `${p}.max_dd_pct`, 'paper_state'),
      open: a(book.open, `${p}.open`, 'paper_state')?.slice(0, 200).map((value, j) => {
        const q = `${p}.open.${j}`, position = container(value, q);
        if (!isObj(value)) issues[q] = '응답 형식 오류';
        return { sym: t(position.sym, `${q}.sym`, 'paper_state'), side: side(position.side, `${q}.side`, 'paper_state'), entry_kst: time(position.entry_kst, `${q}.entry_kst`, 'paper_state'), entry: n(position.entry, `${q}.entry`, 'paper_state'), mark: n(position.mark, `${q}.mark`, 'paper_state'), upnl: n(position.upnl, `${q}.upnl`, 'paper_state'), upnl_pct: n(position.upnl_pct, `${q}.upnl_pct`, 'paper_state') };
      }) ?? null,
      extra: extraObject(book, (k) => KNOWN_BOOK.has(k), 0, budget),
    };
  }) ?? null;
  const trades = a(raw.recent_closed_trades, 'recent_closed_trades', 'paper_trades')?.slice(0, 10).map((value, i) => {
    const p = `recent_closed_trades.${i}`, trade = container(value, p);
    if (!isObj(value)) issues[p] = '응답 형식 오류';
    return { book: t(trade.book, `${p}.book`, 'paper_trades'), sym: t(trade.sym, `${p}.sym`, 'paper_trades'), side: side(trade.side, `${p}.side`, 'paper_trades'), exit_kst: time(trade.exit_kst, `${p}.exit_kst`, 'paper_trades'), reason: t(trade.reason, `${p}.reason`, 'paper_trades'), pnl: n(trade.pnl, `${p}.pnl`, 'paper_trades'), r: n(trade.r, `${p}.r`, 'paper_trades'), ledger_certifiable: b(trade.ledger_certifiable, `${p}.ledger_certifiable`, 'ledger_exits') };
  }) ?? null;
  for (const [path, names] of Object.entries({ books: ['paper_state'], engine: ['paper_health', 'ledger_health'], ledger: ['ledger_stats', 'ledger_exits'], verify: ['ledger_verify'] })) {
    const reason = sourceError(names);
    if (raw[path] === null && reason) issues[path] = reason;
  }
  const extra: LabExtra = extraObject(raw, (k) => KNOWN_TOP.has(k) || KNOWN_TOP_META.has(k), 0, budget);
  const nested: LabExtra = {};
  // Depth is counted from each known container (a book, ledger, verify, engine) so a future block under one of them
  // gets the same nesting allowance as a top-level one; the shared node budget is what bounds the total.
  const ledgerX = nonEmpty(extraObject(ledger, (k) => KNOWN_LEDGER.has(k), 0, budget));
  const verifyX = nonEmpty(extraObject(verify, (k) => KNOWN_VERIFY.has(k), 0, budget));
  const paperX = nonEmpty(extraObject(paper, (k) => KNOWN_PAPER.has(k), 0, budget));
  const ledgerEngineX = nonEmpty(extraObject(ledgerEngine, (k) => KNOWN_LEDGER_ENGINE.has(k), 0, budget));
  const engineX = nonEmpty(extraObject(engine, (k) => k === 'paper' || k === 'ledger', 0, budget));
  if (ledgerX) nested.ledger = ledgerX;
  if (verifyX) nested.verify = verifyX;
  if (paperX || ledgerEngineX || engineX) nested.engine = { ...(engineX ?? {}), ...(paperX ? { paper: paperX } : {}), ...(ledgerEngineX ? { ledger: ledgerEngineX } : {}) };
  const generated_at = read(raw.generated_at, 'generated_at', v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?\+09:00$/.test(v) && validKstLocal(v.slice(0, 19)) ? v : null, []);
  return stripSecrets({
    schema: 'cblabx_lab_summary/v1', live: false, read_only: true, generated_at, loading,
    engine: { paper: { ok: b(paper.ok, 'engine.paper.ok', 'paper_health'), ready: b(paper.ready, 'engine.paper.ready', 'paper_health', 'paper_state') }, ledger: { ok: b(ledgerEngine.ok, 'engine.ledger.ok', 'ledger_health') } },
    books: loading ? [] : books, open_positions_total: loading ? null : count(raw.open_positions_total, 'open_positions_total', 'paper_state'), recent_closed_trades: loading ? [] : trades,
    ledger: { certifiable_closed_trades: count(ledger.certifiable_closed_trades, 'ledger.certifiable_closed_trades', 'ledger_stats'), span_days: positive(ledger.span_days, 'ledger.span_days', 'ledger_exits'), all_pass: b(ledger.all_pass, 'ledger.all_pass', 'ledger_stats', 'ledger_exits'), expectancy: { ci95_lower: n(expectancy.ci95_lower, 'ledger.expectancy.ci95_lower', 'ledger_exits'), reason: t(expectancy.reason, 'ledger.expectancy.reason', 'ledger_exits') } },
    verify: { ok: b(verify.ok, 'verify.ok', 'ledger_verify'), msg: t(verify.msg, 'verify.msg', 'ledger_verify'), entries: count(verify.entries, 'verify.entries', 'ledger_verify'), head: hash(verify.head, 'verify.head', 'ledger_verify'), last_merkle_root: hash(verify.last_merkle_root, 'verify.last_merkle_root', 'ledger_roots'), last_merkle_root_date: date(verify.last_merkle_root_date, 'verify.last_merkle_root_date', 'ledger_roots'), last_ots_status: t(verify.last_ots_status, 'verify.last_ots_status', 'ledger_roots'), gap_count: count(verify.gap_count, 'verify.gap_count', 'ledger_gaps'), gap_seconds_total: count(verify.gap_seconds_total, 'verify.gap_seconds_total', 'ledger_gaps') },
    errors, issues, extra: { ...extra, ...nested },
  });
}

export interface LabService { get(): Promise<LabResponse> }
export interface LabDeps { fetchJson: (url: string, timeoutMs: number) => Promise<unknown>; now?: () => number }
export function createLabService(deps: LabDeps): LabService {
  const now = deps.now ?? Date.now;
  let snapshot: LabSnapshot | null = null, failures = 0, lastSuccessAt: string | null = null;
  // Failures are cache VALUES: shared slowCache otherwise immediately retries failed loaders.
  const cached = slowCache(LAB_CACHE_MS, async () => {
    try {
      snapshot = mapLab(await deps.fetchJson(LAB_URL, LAB_TIMEOUT_MS));
      failures = 0;
      lastSuccessAt = new Date(now()).toISOString();
      return { snapshot, failures, lastSuccessAt, error: null };
    } catch (e) {
      const malformed = e instanceof SyntaxError || e instanceof LabValidationError;
      failures = malformed ? 0 : failures + 1;
      return { snapshot, failures, lastSuccessAt, error: e instanceof LabValidationError ? e.message : malformed ? '응답 형식 오류' : errorText(e) };
    }
  }, now);
  return { async get() {
    const { value } = await cached();
    if (!value) throw new Error('요약 조회 오류');
    const ageSeconds = value.snapshot?.generated_at ? Math.max(0, Math.floor((now() - Date.parse(value.snapshot.generated_at)) / 1000)) : null;
    const stale = value.error !== null || (ageSeconds !== null && ageSeconds >= 90);
    const state = value.snapshot?.verify.ok === false ? 'verify-failed' : value.failures >= 3 ? 'offline' : value.error ? 'error' : value.snapshot?.loading ? 'loading' : stale ? 'stale' : value.snapshot && (value.snapshot.errors.length || Object.keys(value.snapshot.issues).length) ? 'partial' : 'ok';
    return { ...value, ageSeconds, stale, state };
  } };
}

/** Caller is inside the existing authenticated /api boundary. */
export async function serveLab(service: LabService, method: string | undefined, res: ServerResponse): Promise<void> {
  res.setHeader('Allow', 'GET');
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(stripSecrets(body)));
  };
  if (method !== 'GET') { send(405, { error: 'method not allowed' }); return; }
  try { send(200, await service.get()); }
  catch (e) { send(503, { error: errorText(e) }); }
}
