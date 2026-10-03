import { ACCOUNTS, CARD_ID, type Account, type UsageSeat } from '../../shared/accounts';
import { emptyAccountUsage, emptySnapshot, parseIsoUtc, type AccountUsage, type GptCredits, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

export type TurnWindows = { fiveHour?: UsageWindow; weekly?: UsageWindow; /** GPT only (Codex rollout) */ credits?: GptCredits };

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

export function parseDeckCards(json: unknown): { accounts: Record<Account, AccountUsage>; gpt: AccountUsage } {
  const byId = cardsById(json);
  const accounts: Record<Account, AccountUsage> = { a: emptyAccountUsage(), b: emptyAccountUsage(), c: emptyAccountUsage() };
  for (const account of ACCOUNTS) {
    const card = byId.get(CARD_ID[account]);
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

export function parseDeckState(json: unknown): Record<Account, AccountUsage> {
  return parseDeckCards(json).accounts;
}

export class UsageService {
  private snap: UsageSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: UsageSnapshot) => void>();
  /** Per-turn windows and when they were observed; kept until the deck has a newer reading. */
  private turnObs = new Map<UsageSeat, { w: TurnWindows; atMs: number }>();
  /** Newest GPT credits reading; the usage-deck card has none, so it outlives the window overlay. */
  private gptCredits: { c: GptCredits; atMs: number } | null = null;
  /** When deck last completed a turn on each Claude account (see noteTurnOk). */
  private turnOkAt = new Map<Account, number>();
  private readonly url: string;
  private readonly fetchFn: FetchLike;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(opts: { deckUrl: string; fetchFn?: FetchLike; intervalMs?: number; timeoutMs?: number; now?: () => Date }) {
    this.url = opts.deckUrl.replace(/\/+$/, '') + '/api/state';
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? 6_000;
    this.now = opts.now ?? (() => new Date());
    this.snap = emptySnapshot(this.now());
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
    let accounts: UsageSnapshot['accounts'] | null = null;
    for (const a of ACCOUNTS) {
      const u = this.lift(a, this.snap.accounts[a]);
      if (u !== this.snap.accounts[a]) (accounts ??= { ...this.snap.accounts })[a] = u;
    }
    return accounts ? { ...this.snap, accounts } : this.snap;
  }

  onChange(cb: (s: UsageSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private publish(next: UsageSnapshot): void {
    this.snap = next;
    for (const cb of this.listeners) cb(next);
  }

  private seatOf(s: UsageSnapshot, seat: UsageSeat): AccountUsage {
    return seat === 'gpt' ? (s.gpt ?? emptyAccountUsage()) : s.accounts[seat];
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
    if (u.status === 'down' || Number.isNaN(fetched) || obs.atMs > fetched) {
      const overridden: AccountUsage = { ...u, fiveHour: obs.w.fiveHour ?? u.fiveHour, weekly: obs.w.weekly ?? u.weekly };
      if (seat === 'gpt') return { ...overridden, status: this.obsStatus(obs.w), fetchedAt: new Date(obs.atMs).toISOString() };
      return overridden;
    }
    this.turnObs.delete(seat);
    return u;
  }

  /**
   * A `down` Claude card (usage-deck's own token expired: setup_needed) while deck itself completed a turn on that
   * account within TURN_OK_TRUST_MS: the account works, so it is not 'down' for routing (routingSnapshot only). Numbers are not invented —
   * the card's last-known rows (or a turn observation) stay; no weekly value still keeps it out of routing.
   */
  private lift(account: Account, u: AccountUsage): AccountUsage {
    const at = this.turnOkAt.get(account);
    if (u.status !== 'down' || at === undefined) return u;
    if (this.now().getTime() - at >= TURN_OK_TRUST_MS) { this.turnOkAt.delete(account); return u; }
    return { ...u, status: 'ok' };
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
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, { signal: ac.signal });
      if (!res.ok) throw new Error(`deck HTTP not ok`);
      const parsed = parseDeckCards(await res.json());
      const accounts = { ...parsed.accounts };
      for (const a of ACCOUNTS) accounts[a] = this.overlay(a, accounts[a]);
      this.publish({ generatedAt: this.now().toISOString(), deckReachable: true, accounts, gpt: this.withCredits(this.overlay('gpt', parsed.gpt)) });
    } catch {
      // Spec §8: deck unreachable → keep last values, show them as stale.
      const stale = (u: AccountUsage): AccountUsage => ({ ...u, status: u.status === 'ok' ? 'stale' : u.status });
      const accounts = { ...this.snap.accounts };
      for (const a of ACCOUNTS) accounts[a] = stale(accounts[a]);
      this.publish({ generatedAt: this.now().toISOString(), deckReachable: false, accounts, gpt: stale(this.seatOf(this.snap, 'gpt')) });
    } finally {
      clearTimeout(t);
    }
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
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
  applyTurn(seat: UsageSeat, w: TurnWindows, observedAtMs: number = this.now().getTime()): void {
    const prev = this.turnObs.get(seat);
    // F3: the rollout poller may report a reading older than one a turn already gave; never go back in time.
    if (prev && observedAtMs < prev.atMs) return;
    if (seat === 'gpt' && w.credits && (!this.gptCredits || observedAtMs >= this.gptCredits.atMs)) this.gptCredits = { c: w.credits, atMs: observedAtMs };
    const merged: TurnWindows = { ...prev?.w, ...(w.fiveHour ? { fiveHour: w.fiveHour } : {}), ...(w.weekly ? { weekly: w.weekly } : {}) };
    const atMs = Math.max(observedAtMs, prev?.atMs ?? 0);
    this.turnObs.set(seat, { w: merged, atMs });
    const cur = this.seatOf(this.snap, seat);
    let next: AccountUsage = { ...cur, fiveHour: w.fiveHour ?? cur.fiveHour, weekly: w.weekly ?? cur.weekly };
    if (seat === 'gpt') next = this.withCredits({ ...next, status: this.obsStatus(merged), fetchedAt: new Date(atMs).toISOString() });
    const generatedAt = this.now().toISOString();
    if (seat === 'gpt') this.publish({ ...this.snap, generatedAt, gpt: next });
    else this.publish({ ...this.snap, generatedAt, accounts: { ...this.snap.accounts, [seat]: next } });
  }

  /** deck just completed a turn on `account` (result ok): affects `routingSnapshot` only (see `lift`); nothing is published. */
  noteTurnOk(account: Account, atMs: number = this.now().getTime()): void {
    this.turnOkAt.set(account, Math.max(atMs, this.turnOkAt.get(account) ?? 0));
  }
}
