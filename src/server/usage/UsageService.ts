import { ACCOUNTS, CARD_ID, type Account } from '../../shared/accounts';
import { emptyAccountUsage, emptySnapshot, parseIsoUtc, type AccountUsage, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

export type TurnWindows = { fiveHour?: UsageWindow; weekly?: UsageWindow };

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

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

export function parseDeckState(json: unknown): Record<Account, AccountUsage> {
  const result: Record<Account, AccountUsage> = { a: emptyAccountUsage(), b: emptyAccountUsage(), c: emptyAccountUsage() };
  const cards = json && typeof json === 'object' && Array.isArray((json as { cards?: unknown }).cards)
    ? ((json as { cards: unknown[] }).cards as unknown[])
    : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of cards) if (c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string') byId.set((c as { id: string }).id, c as Record<string, unknown>);
  for (const account of ACCOUNTS) {
    const card = byId.get(CARD_ID[account]);
    if (!card) continue;
    const status = card.status === 'ok' ? 'ok' : card.status === 'stale' ? 'stale' : 'down';
    result[account] = { status, fetchedAt: str(card.fetchedAt), ...rowsOf(card) };
  }
  return result;
}

export class UsageService {
  private snap: UsageSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: UsageSnapshot) => void>();
  /** Per-turn windows and when they were observed; kept until the deck has a newer reading. */
  private turnObs = new Map<Account, { w: TurnWindows; atMs: number }>();
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

  snapshot(): UsageSnapshot {
    return this.snap;
  }

  onChange(cb: (s: UsageSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private publish(next: UsageSnapshot): void {
    this.snap = next;
    for (const cb of this.listeners) cb(next);
  }

  async pollOnce(): Promise<void> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, { signal: ac.signal });
      if (!res.ok) throw new Error(`deck HTTP not ok`);
      const accounts = parseDeckState(await res.json());
      for (const a of ACCOUNTS) {
        const obs = this.turnObs.get(a);
        if (!obs) continue;
        const u = accounts[a];
        const fetched = u.fetchedAt ? parseIsoUtc(u.fetchedAt) : Number.NaN;
        if (Number.isNaN(fetched) || obs.atMs > fetched) {
          accounts[a] = { ...u, fiveHour: obs.w.fiveHour ?? u.fiveHour, weekly: obs.w.weekly ?? u.weekly };
        } else {
          this.turnObs.delete(a);
        }
      }
      this.publish({ generatedAt: this.now().toISOString(), deckReachable: true, accounts });
    } catch {
      // Spec §8: deck unreachable → keep last values, show them as stale.
      const accounts = { ...this.snap.accounts };
      for (const a of ACCOUNTS) {
        const u = accounts[a];
        accounts[a] = { ...u, status: u.status === 'ok' ? 'stale' : u.status };
      }
      this.publish({ generatedAt: this.now().toISOString(), deckReachable: false, accounts });
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
   * Between polls, trust the API's own numbers from the turn's rate_limit_event. They survive later
   * polls until the deck card's fetchedAt is newer than `observedAtMs` (default: now).
   */
  applyTurn(account: Account, w: TurnWindows, observedAtMs: number = this.now().getTime()): void {
    const prev = this.turnObs.get(account);
    const merged: TurnWindows = { ...prev?.w, ...(w.fiveHour ? { fiveHour: w.fiveHour } : {}), ...(w.weekly ? { weekly: w.weekly } : {}) };
    this.turnObs.set(account, { w: merged, atMs: Math.max(observedAtMs, prev?.atMs ?? 0) });
    const cur = this.snap.accounts[account];
    const next: AccountUsage = {
      ...cur,
      fiveHour: w.fiveHour ?? cur.fiveHour,
      weekly: w.weekly ?? cur.weekly,
    };
    this.publish({ ...this.snap, generatedAt: this.now().toISOString(), accounts: { ...this.snap.accounts, [account]: next } });
  }
}
