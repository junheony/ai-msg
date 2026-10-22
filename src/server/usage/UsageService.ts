import fs from 'node:fs';
import path from 'node:path';
import { type Account, type AccountNames, type GrokAccount, type UsageSeat } from '../../shared/accounts';
import { emptyAccountUsage, emptySnapshot, parseIsoUtc, usageOf, type AccountUsage, type GeminiUsage, type GptCredits, type GrokBotUsage, type GrokUsage, type UsageMode, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';
import { STALE_MAX_MS } from '../routing/AccountRouter';

export type TurnWindows = { fiveHour?: UsageWindow; weekly?: UsageWindow; /** GPT only (Codex rollout) */ credits?: GptCredits; /** Claude, `cli` mode only: a Fable/Opus value the CLI told (see stream.ts fableSpentOf). */ fable?: UsageWindow };

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export const GPT_CARD_ID = 'codex';
/** How long a successful deck turn on a Claude account outweighs a `down` (e.g. setup_needed) card for routing. */
export const TURN_OK_TRUST_MS = 30 * 60_000;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Row labels start with "Session (5h)", "Weekly (7d)", "Fable (7d)"; the first matching row per kind wins even if its value is unusable (claude-pick rule). */
function rowsOf(card: Record<string, unknown>): Pick<AccountUsage, 'fiveHour' | 'weekly' | 'fable'> {
  const out: Pick<AccountUsage, 'fiveHour' | 'weekly' | 'fable'> = { fiveHour: null, weekly: null, fable: null };
  const rows = Array.isArray(card.rows) ? card.rows : [];
  const seen = new Set<keyof typeof out>();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const label = String(row.label ?? '').toLowerCase();
    const kind = label.includes('fable') ? 'fable' : label.startsWith('session') ? 'fiveHour' : label.startsWith('weekly') ? 'weekly' : null;
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    const used = num(row.used);
    if (used === null) continue;
    out[kind] = { usedPct: used, resetsAt: str(row.resetsAt) };
  }
  return out;
}

function cardsById(json: unknown): Map<string, Record<string, unknown>> {
  const cards = json && typeof json === 'object' && Array.isArray((json as { cards?: unknown }).cards)
    ? ((json as { cards: unknown[] }).cards as unknown[])
    : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of cards) if (c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string') byId.set((c as { id: string }).id, c as Record<string, unknown>);
  return byId;
}

/** One entry per account of `reg` (retired ones too: their usage stays visible). */
export function parseDeckCards(json: unknown, reg: AccountNames): { accounts: Record<Account, AccountUsage>; gpt: AccountUsage } {
  const byId = cardsById(json);
  const accounts: Record<Account, AccountUsage> = {};
  for (const account of reg.all()) {
    accounts[account] = emptyAccountUsage();
    const card = byId.get(reg.cardId(account));
    if (!card) continue;
    const status = card.status === 'ok' ? 'ok' : card.status === 'stale' ? 'stale' : 'down';
    accounts[account] = { status, fetchedAt: str(card.fetchedAt), ...rowsOf(card) };
  }
  // D5: the codex card's rows are only trusted when the card is ok/stale; setup_needed keeps stale numbers ("limit reached" at 100 % while the real value was 40 %).
  let gpt = emptyAccountUsage();
  const gc = byId.get(GPT_CARD_ID);
  if (gc) {
    const status = gc.status === 'ok' ? 'ok' : gc.status === 'stale' ? 'stale' : 'down';
    gpt = status === 'down' ? { ...emptyAccountUsage(), fetchedAt: str(gc.fetchedAt) } : { status, fetchedAt: str(gc.fetchedAt), ...rowsOf(gc), fable: null };
  }
  return { accounts, gpt };
}

export function parseDeckState(json: unknown, reg: AccountNames): Record<Account, AccountUsage> {
  return parseDeckCards(json, reg).accounts;
}

/** One window as last observed from a deck turn's `rate_limit_event` (`cli` mode), with when; `by: 'poll'` = read by ClaudeUsagePoller (`/usage`). */
type CliWindowObs = { w: UsageWindow; at: number; by?: 'poll' };
type CliAccountObs = { fiveHour?: CliWindowObs; weekly?: CliWindowObs; /** Only when the CLI told one (spent = 100 %, or a warning's utilization). */ fable?: CliWindowObs };
const CLI_WINDOWS = ['fiveHour', 'weekly', 'fable'] as const;

/** `cli` mode: past STALE_MAX_MS an observation still counts as a lower bound until its window resets, but never past this. */
export const CLI_TRUST_MAX_MS = 24 * 3_600_000;

/** A saved window; a future `at` (clock went back, a hand edit) is read as now, so it can neither freeze nor stay fresh. */
function windowObsOf(v: unknown, nowMs: number): CliWindowObs | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const used = num(o.usedPct), at = num(o.at);
  if (used === null || at === null) return undefined;
  return { w: { usedPct: used, resetsAt: str(o.resetsAt) }, at: Math.min(at, nowMs), ...(o.by === 'poll' ? { by: 'poll' as const } : {}) };
}

/** A window whose `resetsAt` has passed reads 0 % with `estimated` (the next observation tells the real value). */
function estimateWindow(w: UsageWindow, nowMs: number): UsageWindow {
  return w.resetsAt !== null && parseIsoUtc(w.resetsAt) <= nowMs ? { usedPct: 0, resetsAt: w.resetsAt, estimated: true } : w;
}

export class UsageService {
  private snap: UsageSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: UsageSnapshot) => void>();
  /** Per-turn windows and when they were observed; kept until the deck has a newer reading. */
  /** `fiveAt`/`weekAt`: when that window itself was last observed (a partial observation keeps the other's time). */
  private turnObs = new Map<UsageSeat, { w: TurnWindows; atMs: number; fiveAt?: number; weekAt?: number; by?: 'poll'; pollAt?: number; fable?: { w: UsageWindow; at: number } }>();
  /** usage-deck mode: Claude accounts whose last dashboard card (parsed, not overlaid) was ok; empty while the dashboard is unreachable. */
  private cardOk = new Set<Account>();
  /** Newest GPT credits reading; the usage-deck card has none, so it outlives the window overlay. */
  private gptCredits: { c: GptCredits; atMs: number } | null = null;
  /** When deck last completed a turn on each Claude account (see noteTurnOk). */
  private turnOkAt = new Map<Account, number>();
  private readonly url: string;
  private readonly fetchFn: FetchLike;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly reg: AccountNames;
  private readonly sourceFile: string | null;
  private readonly strict: boolean | null;
  private readonly deckConfigured: boolean;
  private readonly log: (line: string) => void;
  /** usage-deck has answered at least once (this run, or an earlier one: `sourceFile`). */
  private deckSeen = false;
  /** `sourceFile` is there and unreadable: read as seen (the strict side), written again by the next answer. */
  private recordBroken = false;
  private firstAttemptDone = false;
  private readonly mode: UsageMode;
  /** `cli` mode: `<configDir>/claude-usage-observed.json`; null = kept in memory only. */
  private readonly observedFile: string | null;
  /** `cli` mode: per Claude account, the last observed 5h/weekly windows (loaded from `observedFile`). */
  private cliObs = new Map<Account, CliAccountObs>();

  /**
   * `accounts`: the registry.
   * `usageSourceFile` (`<configDir>/usage-source.json`) and `strict` (`DECK_USAGE_STRICT`: true → 'deck', false → 'none',
   * null → by the record) decide the snapshot's `usageSource`; with neither, the snapshot has none (= 'deck').
   * `deckConfigured`: the user set the usage-deck address (not the default), so with no record yet a failed first fetch
   * still reads as 'deck' (usage-deck is late or down, not absent). Order: `strict` > the record > this > the first fetch.
   * `mode` 'cli' (`DECK_USAGE_SOURCE`, default 'cli' here too; config picks the real default): usage-deck is never
   * asked — Claude accounts carry only what deck's own turns observed (`observedFile`, kept across restarts).
   */
  constructor(opts: { mode?: UsageMode; observedFile?: string; deckUrl: string; fetchFn?: FetchLike; intervalMs?: number; timeoutMs?: number; now?: () => Date; accounts: AccountNames; usageSourceFile?: string; strict?: boolean | null; deckConfigured?: boolean; log?: (line: string) => void }) {
    this.url = opts.deckUrl.replace(/\/+$/, '') + '/api/state';
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? 6_000;
    this.now = opts.now ?? (() => new Date());
    this.reg = opts.accounts;
    this.sourceFile = opts.usageSourceFile ?? null;
    this.strict = opts.strict ?? null;
    this.deckConfigured = opts.deckConfigured ?? false;
    this.log = opts.log ?? (() => {});
    this.mode = opts.mode ?? 'cli';
    this.observedFile = opts.observedFile ?? null;
    if (this.mode === 'cli') {
      if (this.observedFile) this.readObserved(this.observedFile);
      this.snap = this.withSource({ ...emptySnapshot(this.now(), this.reg.all()), accounts: this.cliAccounts(), usageMode: 'cli' });
      return;
    }
    if (this.sourceFile) this.readRecord(this.sourceFile);
    this.snap = this.withSource(emptySnapshot(this.now(), this.reg.all()));
  }

  private readObserved(file: string): void {
    const nowMs = this.now().getTime();
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`deck: ${file} 을 읽을 수 없어 관측값 없이 시작합니다 — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const accounts = json && typeof json === 'object' ? (json as { accounts?: unknown }).accounts : null;
    if (!accounts || typeof accounts !== 'object') return;
    for (const [a, v] of Object.entries(accounts as Record<string, unknown>)) {
      if (!this.reg.has(a) || !v || typeof v !== 'object') continue;
      const o: CliAccountObs = {};
      for (const k of CLI_WINDOWS) { const x = windowObsOf((v as Record<string, unknown>)[k], nowMs); if (x) o[k] = x; }
      if (o.fiveHour || o.weekly || o.fable) this.cliObs.set(a, o);
    }
  }

  /** Atomically, 0600; a failure is logged and the numbers stay in memory. */
  private writeObserved(): void {
    if (!this.observedFile) return;
    const out: Record<string, Record<string, { usedPct: number; resetsAt: string | null; at: number; by?: 'poll' }>> = {};
    for (const [a, o] of this.cliObs) {
      const e: (typeof out)[string] = {};
      for (const k of CLI_WINDOWS) { const x = o[k]; if (x) e[k] = { usedPct: x.w.usedPct, resetsAt: x.w.resetsAt, at: x.at, ...(x.by ? { by: x.by } : {}) }; }
      out[a] = e;
    }
    const tmp = `${this.observedFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.observedFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts: out }), { mode: 0o600 });
      fs.renameSync(tmp, this.observedFile);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      this.log(`deck: ${this.observedFile} 을 쓰지 못했습니다 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `cli` mode: an account as its last observation reads now. Never observed → 'down' (unknown). A window whose
   * `resetsAt` has passed reads 0 % with `estimated` (estimateWindow). `fetchedAt` is the oldest observation among the
   * 5h/weekly windows shown, and past STALE_MAX_MS the account is 'stale'. Usage within a window never goes down, so
   * the numbers stay a lower bound until the window resets: `trustUntil` = the earliest `resetsAt` of the windows shown
   * (a window without one: its observation + STALE_MAX_MS, i.e. the plain stale rule), at most CLI_TRUST_MAX_MS after
   * the oldest observation. The router keeps a stale account as a candidate until then, and only then treats it as unknown.
   * Fable: rate_limit_event carries no Fable window (only five_hour / seven_day in every captured event), so it is
   * null — see `source()` for how unknown Fable is then treated — unless the CLI told a Fable/Opus value (spent = 100 %,
   * or a warning's utilization; kept until its reset, without a reset time for STALE_MAX_MS).
   */
  private cliAccount(a: Account, nowMs: number): AccountUsage {
    const o = this.cliObs.get(a);
    // A polled Fable value (with its reset, usually days away) still goes once CLI_TRUST_MAX_MS old, as any observation would.
    const fableAge = o?.fable ? nowMs - o.fable.at : Infinity;
    const fable = o?.fable && (o.fable.w.resetsAt !== null || fableAge <= STALE_MAX_MS) && (o.fable.by !== 'poll' || fableAge <= CLI_TRUST_MAX_MS) ? estimateWindow(o.fable.w, nowMs) : null;
    if (!o || (!o.fiveHour && !o.weekly)) return { ...emptyAccountUsage(), fable };
    const shown = [o.fiveHour, o.weekly].filter((x): x is CliWindowObs => x !== undefined);
    const oldest = Math.min(...shown.map((x) => x.at));
    const polled = shown.find((x) => x.at === oldest)?.by === 'poll';
    const until = (x: CliWindowObs) => { const r = x.w.resetsAt === null ? Number.NaN : parseIsoUtc(x.w.resetsAt); return Number.isNaN(r) ? x.at + STALE_MAX_MS : r; };
    const trustUntil = Math.min(...shown.map(until), oldest + CLI_TRUST_MAX_MS);
    return {
      status: nowMs - oldest > STALE_MAX_MS ? 'stale' : 'ok', fetchedAt: new Date(oldest).toISOString(), trustUntil: new Date(trustUntil).toISOString(),
      fiveHour: o.fiveHour ? estimateWindow(o.fiveHour.w, nowMs) : null, weekly: o.weekly ? estimateWindow(o.weekly.w, nowMs) : null, fable,
      ...(polled ? { observedBy: 'poll' as const } : {}),
    };
  }

  /** `cli` mode: the GPT seat from its last rollout observation, read now (passed resets estimated, obsStatus again). */
  private cliGpt(): AccountUsage {
    const obs = this.turnObs.get('gpt');
    const cur = this.seatOf(this.snap, 'gpt');
    if (!obs) return cur;
    const nowMs = this.now().getTime();
    const est = (x: UsageWindow | undefined) => (x ? estimateWindow(x, nowMs) : null);
    return this.withCredits({ ...cur, status: this.obsStatus(obs.w), fetchedAt: new Date(obs.atMs).toISOString(), fiveHour: est(obs.w.fiveHour) ?? cur.fiveHour, weekly: est(obs.w.weekly) ?? cur.weekly });
  }

  private cliAccounts(): Record<Account, AccountUsage> {
    const nowMs = this.now().getTime();
    return Object.fromEntries(this.reg.all().map((a) => [a, this.cliAccount(a, nowMs)]));
  }

  private readRecord(file: string): void {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.recordBroken = true;
      this.log(`deck: ${file} 을 읽을 수 없어 usage-deck 이 있는 설치로 봅니다 — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let at: unknown;
    try {
      at = (JSON.parse(text) as { deckSeenAt?: unknown } | null)?.deckSeenAt;
    } catch {
      at = undefined;
    }
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) { this.deckSeen = true; return; }
    this.recordBroken = true;
    this.log(`deck: ${file} 의 내용을 읽을 수 없어 usage-deck 이 있는 설치로 봅니다 (usage-deck 이 다음에 응답하면 다시 씁니다)`);
  }

  /** usage-deck answered: the first time ever, that is written down (atomically, 0600) and never again. */
  private noteDeckSeen(): void {
    if (this.deckSeen) return;
    this.deckSeen = true;
    if (!this.sourceFile) return;
    const tmp = `${this.sourceFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.sourceFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ deckSeenAt: this.now().toISOString() }), { mode: 0o600 });
      fs.renameSync(tmp, this.sourceFile);
      this.recordBroken = false;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      this.log(`deck: ${this.sourceFile} 을 쓰지 못했습니다 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** null = not judged here (no record file and no switch): the snapshot carries no `usageSource`. */
  private source(): 'deck' | 'none' | null {
    if (this.strict !== null) return this.strict ? 'deck' : 'none';
    // `cli` mode has no usage-deck, so no Fable number ever: the install is the "never had usage-deck" kind ('none').
    // Strict ('deck') would read every unknown Fable as "no Fable left" and turn every Fable request into Opus for
    // good; 'none' keeps Fable unless a known value is at the limit, as for any install without usage-deck.
    // DECK_USAGE_STRICT=1 (above) still forces the strict side.
    if (this.mode === 'cli') return 'none';
    if (!this.sourceFile) return null;
    // Before the first fetch attempt has ended nothing is known yet: the strict side.
    return this.deckSeen || this.recordBroken || this.deckConfigured || !this.firstAttemptDone ? 'deck' : 'none';
  }

  private withSource(s: UsageSnapshot): UsageSnapshot {
    const usageSource = this.source();
    if (usageSource === null) return s;
    return { ...s, usageSource };
  }

  /** What the UI shows: the real card status (a setup_needed card stays 'down', so the re-login signal is kept). */
  snapshot(): UsageSnapshot {
    return this.snap;
  }

  /**
   * What routing sees: `snapshot()` with `down` Claude cards lifted to 'ok' while deck completed a turn on that
   * account within TURN_OK_TRUST_MS (see `lift`). Never published — the UI keeps the real status.
   */
  routingSnapshot(): UsageSnapshot {
    // `cli`: read the observations at this moment, so the stale cut-off is exact, not as of the last refresh.
    if (this.mode === 'cli') return { ...this.snap, accounts: this.cliAccounts() };
    let accounts: UsageSnapshot['accounts'] | null = null;
    for (const a of this.reg.all()) {
      const cur = usageOf(this.snap, a);
      const u = this.lift(a, cur);
      if (u !== cur) (accounts ??= { ...this.snap.accounts })[a] = u;
    }
    return accounts ? { ...this.snap, accounts } : this.snap;
  }

  onChange(cb: (s: UsageSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private publish(next: UsageSnapshot): void {
    // The Gemini/Grok seats are each fed by their own poller/tracker only: any other kind of poll carries the last reading over.
    if (next.gemini === undefined && this.snap.gemini !== undefined) next = { ...next, gemini: this.snap.gemini };
    if (next.geminiSeats === undefined && this.snap.geminiSeats !== undefined) next = { ...next, geminiSeats: this.snap.geminiSeats };
    if (next.grokSeats === undefined && this.snap.grokSeats !== undefined) next = { ...next, grokSeats: this.snap.grokSeats };
    if (!('grokBot' in next) && this.snap.grokBot !== undefined) next = { ...next, grokBot: this.snap.grokBot };
    this.snap = this.withSource(next);
    for (const cb of this.listeners) cb(this.snap);
  }

  /** GeminiUsagePoller: a fresh `/usage` reading (or a login/parse failure) for the g1 Gemini card (the only seat it polls today). */
  applyGemini(u: GeminiUsage): void {
    this.publish({ ...this.snap, generatedAt: this.now().toISOString(), gemini: u, geminiSeats: { ...this.snap.geminiSeats, g1: u } });
  }

  /** GrokUsageTracker: a Grok turn just ended on `account` (usage header design §4/§7-4). */
  applyGrok(account: GrokAccount, u: GrokUsage): void {
    this.publish({ ...this.snap, generatedAt: this.now().toISOString(), grokSeats: { ...this.snap.grokSeats, [account]: u } });
  }

  /** GrokBotIndex: the Grok Bot app's cached weekly usage after a scan (null = none / expired: the line goes away). */
  applyGrokBot(u: GrokBotUsage | null): void {
    const cur = this.snap.grokBot;
    if (u === null ? cur === undefined : cur && JSON.stringify(cur) === JSON.stringify(u)) return;
    this.publish({ ...this.snap, generatedAt: this.now().toISOString(), grokBot: u ?? undefined });
  }

  private seatOf(s: UsageSnapshot, seat: UsageSeat): AccountUsage {
    return seat === 'gpt' ? (s.gpt ?? emptyAccountUsage()) : usageOf(s, seat);
  }

  /**
   * Keeps a turn observation on top of a fetched card until a non-down card's fetchedAt is newer.
   * PF12: for the `gpt` seat, a live rollout observation also means the seat is known —
   * `auto` (D3) must be able to pick GPT even while the usage-deck `codex` card is still
   * `setup_needed` (status 'down'); the observation carries `status: 'ok'` and its own
   * `fetchedAt` until a newer deck card wins.
   */
  private overlay(seat: UsageSeat, u: AccountUsage): AccountUsage {
    const obs = this.turnObs.get(seat);
    if (!obs) return u;
    const fetched = u.fetchedAt ? parseIsoUtc(u.fetchedAt) : Number.NaN;
    // A 'down' card (e.g. setup_needed) carries no usable numbers, so it never retires an observation.
    // A card without a usable time (not down) is the card's word: it wins.
    if (u.status === 'down' || (!Number.isNaN(fetched) && obs.atMs > fetched)) {
      const { observedBy: _prevBy, ...base } = u;
      const overridden: AccountUsage = { ...base, fiveHour: obs.w.fiveHour ?? u.fiveHour, weekly: obs.w.weekly ?? u.weekly };
      if (seat === 'gpt') return { ...overridden, status: this.obsStatus(obs.w), fetchedAt: new Date(obs.atMs).toISOString() };
      // An account a `/usage` poll has read: its observation (a later turn's too) shows as ok even over a 'down' card, with
      // the polled Fable; 'poll' is said only while the newest observation is the poll's.
      if (obs.pollAt !== undefined) {
        const status = this.now().getTime() - obs.atMs > STALE_MAX_MS ? 'stale' : this.obsStatus(obs.w);
        return { ...overridden, fable: obs.fable?.w ?? u.fable, status, fetchedAt: new Date(obs.atMs).toISOString(), ...(obs.by === 'poll' ? { observedBy: 'poll' as const } : {}) };
      }
      return overridden;
    }
    this.turnObs.delete(seat);
    return u;
  }

  /**
   * A `down` Claude card (usage-deck's own token expired: setup_needed) while deck itself completed a turn on that
   * account within TURN_OK_TRUST_MS: the account works, so it is not 'down' for routing (routingSnapshot only).
   * Numbers are not invented, and old ones are not trusted: usage-deck back-fills setup_needed cards with the
   * last-good rows indefinitely, and 'ok' skips the router's stale gate. So the lift needs every 5h/weekly number
   * the lifted card would carry to be fresh — the card's own fetchedAt, or that window's own turn observation, within
   * STALE_MAX_MS (a fresh 5h-only observation does not vouch for a days-old weekly). A missing window is fine: no
   * weekly value still keeps it out of routing. Fable (never refreshed by a turn) is kept only when the card is fresh.
   * How often this fires: Claude's rate_limit_event arrives every turn and normally carries both unifiedWindows
   * (five_hour and seven_day; see the deck-core plan's live capture), so a successful turn usually lifts the card for
   * ~STALE_MAX_MS. An event with only five_hour would not lift it (conservative).
   */
  private lift(account: Account, u: AccountUsage): AccountUsage {
    const at = this.turnOkAt.get(account);
    if (u.status !== 'down' || at === undefined) return u;
    const nowMs = this.now().getTime();
    if (nowMs - at >= TURN_OK_TRUST_MS) { this.turnOkAt.delete(account); return u; }
    const fresh = (t: number) => !Number.isNaN(t) && nowMs - t <= STALE_MAX_MS;
    const cardFresh = fresh(u.fetchedAt ? parseIsoUtc(u.fetchedAt) : Number.NaN);
    if (!cardFresh) {
      const obs = this.turnObs.get(account);
      // `u` is already overlaid: a window present in the observation is the value the lifted card uses.
      const ok = (v: unknown, fromObs: boolean, at: number | undefined) => (fromObs ? at !== undefined && fresh(at) : v === null);
      const fiveObs = !!obs?.w.fiveHour, weekObs = !!obs?.w.weekly;
      if (!fiveObs && !weekObs) return u; // nothing fresh at all
      if (!ok(u.fiveHour, fiveObs, obs?.fiveAt) || !ok(u.weekly, weekObs, obs?.weekAt)) return u;
    }
    return { ...u, status: 'ok', fable: cardFresh ? u.fable : null };
  }

  private withCredits(u: AccountUsage): AccountUsage {
    return this.gptCredits ? { ...u, credits: this.gptCredits.c } : u;
  }

  /** F3: an observation is stale once every window it carries has reset since (its numbers no longer apply). */
  private obsStatus(w: TurnWindows): 'ok' | 'stale' {
    const wins = [w.fiveHour, w.weekly].filter((x): x is UsageWindow => !!x);
    const nowMs = this.now().getTime();
    const reset = (x: UsageWindow) => x.resetsAt !== null && parseIsoUtc(x.resetsAt) <= nowMs;
    return wins.length > 0 && wins.every(reset) ? 'stale' : 'ok';
  }

  async pollOnce(): Promise<void> {
    // `cli`: never a request to usage-deck; a poll only re-reads the observations (ages, passed resets), GPT's too.
    if (this.mode === 'cli') {
      this.publish({ ...this.snap, generatedAt: this.now().toISOString(), accounts: this.cliAccounts(), gpt: this.cliGpt() });
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, { signal: ac.signal });
      if (!res.ok) throw new Error(`deck HTTP not ok`);
      const json = await res.json();
      const parsed = parseDeckCards(json, this.reg);
      // usage-deck's own answer (a `cards` list), not just anything listening on that port.
      if (json && typeof json === 'object' && Array.isArray((json as { cards?: unknown }).cards)) this.noteDeckSeen();
      this.firstAttemptDone = true;
      const accounts = { ...parsed.accounts };
      this.cardOk = new Set(this.reg.all().filter((a) => usageOf(parsed, a).status === 'ok'));
      for (const a of this.reg.all()) accounts[a] = this.overlay(a, usageOf(parsed, a));
      this.publish({ generatedAt: this.now().toISOString(), deckReachable: true, accounts, gpt: this.withCredits(this.overlay('gpt', parsed.gpt)) });
    } catch {
      this.firstAttemptDone = true;
      this.cardOk.clear();
      // Spec §8: deck unreachable → keep last values, show them as stale.
      const stale = (u: AccountUsage): AccountUsage => ({ ...u, status: u.status === 'ok' ? 'stale' : u.status });
      const accounts = { ...this.snap.accounts };
      for (const a of this.reg.all()) accounts[a] = stale(usageOf(this.snap, a));
      this.publish({ generatedAt: this.now().toISOString(), deckReachable: false, accounts, gpt: stale(this.seatOf(this.snap, 'gpt')) });
    } finally {
      clearTimeout(t);
    }
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Between polls, trust the engine's own numbers: Claude's rate_limit_event, or the Codex rollout's
   * token_count.rate_limits (D5). They survive later polls until the deck card's fetchedAt is newer
   * than `observedAtMs` (default: now). PF12: for `gpt`, a fresh observation also marks the seat
   * `status: 'ok'` with `fetchedAt` = the observed time, even if the usage-deck `codex` card is
   * currently `setup_needed` — a newer deck card still wins afterwards (see `overlay`).
   */
  applyTurn(seat: UsageSeat, w: TurnWindows, observedAtMs: number = this.now().getTime(), by?: 'poll'): void {
    if (this.mode === 'cli' && seat !== 'gpt') return this.applyCliTurn(seat, w, observedAtMs);
    const prev = this.turnObs.get(seat);
    // F3: the rollout poller may report a reading older than one a turn already gave; never go back in time.
    // Fable is only ever told by a `/usage` poll (a turn's rate_limit_event has none), kept with its own time and origin.
    const fable = by && w.fable && (!prev?.fable || observedAtMs >= prev.fable.at) ? { w: w.fable, at: observedAtMs } : prev?.fable;
    if (prev && observedAtMs < prev.atMs) {
      // A poll that started before a turn and ended after it: the turn's numbers stay, the polled Fable still counts.
      if (by) {
        this.turnObs.set(seat, { ...prev, ...(fable ? { fable } : {}), pollAt: Math.max(observedAtMs, prev.pollAt ?? 0) });
        this.publish({ ...this.snap, generatedAt: this.now().toISOString(), accounts: { ...this.snap.accounts, [seat]: this.overlay(seat, this.seatOf(this.snap, seat)) } });
      }
      return;
    }
    if (seat === 'gpt' && w.credits && (!this.gptCredits || observedAtMs >= this.gptCredits.atMs)) this.gptCredits = { c: w.credits, atMs: observedAtMs };
    const merged: TurnWindows = { ...prev?.w, ...(w.fiveHour ? { fiveHour: w.fiveHour } : {}), ...(w.weekly ? { weekly: w.weekly } : {}) };
    const atMs = Math.max(observedAtMs, prev?.atMs ?? 0);
    this.turnObs.set(seat, { w: merged, atMs, fiveAt: w.fiveHour ? observedAtMs : prev?.fiveAt, weekAt: w.weekly ? observedAtMs : prev?.weekAt, ...(by ? { by } : {}), ...(by || prev?.pollAt !== undefined ? { pollAt: Math.max(by ? observedAtMs : 0, prev?.pollAt ?? 0) } : {}), ...(fable ? { fable } : {}) });
    const cur = this.seatOf(this.snap, seat);
    let next: AccountUsage = seat === 'gpt' ? { ...cur, fiveHour: w.fiveHour ?? cur.fiveHour, weekly: w.weekly ?? cur.weekly } : this.overlay(seat, cur);
    if (seat === 'gpt') next = this.withCredits({ ...next, status: this.obsStatus(merged), fetchedAt: new Date(atMs).toISOString() });
    const generatedAt = this.now().toISOString();
    if (seat === 'gpt') this.publish({ ...this.snap, generatedAt, gpt: next });
    else this.publish({ ...this.snap, generatedAt, accounts: { ...this.snap.accounts, [seat]: next } });
  }

  /**
   * `cli` mode: a Claude turn's windows become the account's numbers (per window, never back in time), saved to disk.
   * A kept time in the future (the clock went back) never blocks a new value.
   */
  private applyCliTurn(account: Account, w: TurnWindows, observedAtMs: number, by?: 'poll'): void {
    if (!w.fiveHour && !w.weekly && !w.fable) return;
    const prev = this.cliObs.get(account) ?? {};
    const next: CliAccountObs = { ...prev };
    const nowMs = this.now().getTime();
    for (const k of CLI_WINDOWS) {
      const x = w[k], p = prev[k];
      if (x && (!p || observedAtMs >= p.at || p.at > nowMs)) next[k] = { w: { usedPct: x.usedPct, resetsAt: x.resetsAt }, at: observedAtMs, ...(by ? { by } : {}) };
    }
    if (CLI_WINDOWS.every((k) => next[k] === prev[k])) return;
    this.cliObs.set(account, next);
    this.writeObserved();
    this.publish({ ...this.snap, generatedAt: this.now().toISOString(), accounts: { ...this.snap.accounts, [account]: this.cliAccount(account, this.now().getTime()) } });
  }

  /**
   * ClaudeUsagePoller: the account's `/usage` reading (no turn), taken at `observedAtMs`. Same path as a turn's
   * rate_limit_event (`cli` mode only), so a window a turn observed later is never overwritten; marked as polled.
   */
  applyCliPoll(account: Account, w: TurnWindows, observedAtMs: number): void {
    if (!this.reg.has(account)) return;
    if (this.mode === 'cli') this.applyCliTurn(account, w, observedAtMs, 'poll');
    else this.applyTurn(account, w, observedAtMs, 'poll'); // usage-deck: as a turn's observation; a newer ok card wins (overlay)
  }

  /**
   * ClaudeUsagePoller's "is it time": when the account was last observed — the oldest of its 5h/weekly windows and of a
   * polled Fable value (turns keep 5h/weekly fresh but never tell Fable, so only a poll does). null = never.
   */
  cliObservedAt(account: Account): number | null {
    if (this.mode !== 'cli') {
      // usage-deck: a card from the dashboard that is ok needs no poll (overlay or not); anything else is judged by the observation.
      if (this.snap.deckReachable && this.cardOk.has(account)) return this.now().getTime();
      const t = this.turnObs.get(account);
      const ats = t ? [t.fiveAt, t.weekAt, t.fable?.at].filter((x): x is number => x !== undefined) : [];
      return ats.length ? Math.min(...ats) : null;
    }
    const o = this.cliObs.get(account);
    if (!o || (!o.fiveHour && !o.weekly)) return null;
    const ats = [o.fiveHour, o.weekly, o.fable?.by === 'poll' ? o.fable : undefined].filter((x): x is CliWindowObs => x !== undefined).map((x) => x.at);
    return Math.min(...ats);
  }

  /** deck just completed a turn on `account` (result ok): affects `routingSnapshot` only (see `lift`); nothing is published. */
  noteTurnOk(account: Account, atMs: number = this.now().getTime()): void {
    this.turnOkAt.set(account, Math.max(atMs, this.turnOkAt.get(account) ?? 0));
  }
}
