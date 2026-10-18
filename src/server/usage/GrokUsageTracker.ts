import fs from 'node:fs';
import path from 'node:path';
import { GROK_ACCOUNTS, isGrokAccount, type GrokAccount } from '../../shared/accounts';
import { emptyGrokUsage, localDay, type GrokUsage } from '../../shared/usage-types';
import type { TurnUsage } from '../../shared/turn-types';

type StoredAccount = {
  lastTurnAtMs: number | null;
  lastError: 'auth' | 'limit' | 'busy' | null;
  /** The only source (TurnRunner.grokCooldownUntil) — this tracker reads it, never computes its own cooldown. */
  cooldownUntilMs: number | null;
  /** Set on an auth error, cleared only by a successful turn (persists through other failures in between — design §7-5). */
  down: boolean;
  today: { inputTokens: number; outputTokens: number; turns: number; day: string };
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

const LAST_ERRORS = new Set(['auth', 'limit', 'busy']);

/**
 * The Grok seat's usage card, from deck's own Grok turns only (design §4/§7-4/§7-5): TurnRunner.runGrok calls
 * `noteTurn` at the one place every Grok turn ends (success, stop, error, cancel), after it has set its own
 * `grokCooldownUntil`. No `grok usage` CLI and no `~/.grok` file is ever read.
 */
export class GrokUsageTracker {
  private readonly data = new Map<GrokAccount, StoredAccount>();
  private readonly file: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** Pushed to UsageService after every turn, so the snapshot (hello, broadcasts) carries the new numbers; absent in tests that only check the tracker itself. */
  private readonly usage: { applyGrok(account: GrokAccount, u: GrokUsage): void } | null;

  constructor(opts: { file: string; now?: () => number; log?: (line: string) => void; usage?: { applyGrok(account: GrokAccount, u: GrokUsage): void } | null }) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.usage = opts.usage ?? null;
    this.read();
    // A restart carries the day's numbers over into the snapshot right away, not only after the next turn.
    for (const a of this.data.keys()) this.usage?.applyGrok(a, this.snapshotOf(a));
  }

  /** Corrupt JSON (or a shape this version does not recognize) is moved aside and the tracker starts at 0 — never thrown. */
  private read(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`deck: ${this.file} 을 읽을 수 없어 Grok 오늘 사용량 없이 시작합니다 — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      const json = JSON.parse(text) as { accounts?: unknown } | null;
      const accounts = json?.accounts;
      if (!accounts || typeof accounts !== 'object') throw new Error('accounts 가 없습니다');
      for (const [k, v] of Object.entries(accounts as Record<string, unknown>)) {
        if (!isGrokAccount(k) || !v || typeof v !== 'object') continue;
        const o = v as Record<string, unknown>;
        const today = (o.today && typeof o.today === 'object' ? o.today : {}) as Record<string, unknown>;
        const day = typeof today.day === 'string' && today.day ? today.day : this.dayOf(this.now());
        this.data.set(k, {
          lastTurnAtMs: typeof o.lastTurnAtMs === 'number' ? o.lastTurnAtMs : null,
          lastError: typeof o.lastError === 'string' && LAST_ERRORS.has(o.lastError) ? (o.lastError as StoredAccount['lastError']) : null,
          cooldownUntilMs: typeof o.cooldownUntilMs === 'number' ? o.cooldownUntilMs : null,
          down: o.down === true,
          today: { inputTokens: num(today.inputTokens), outputTokens: num(today.outputTokens), turns: num(today.turns), day },
        });
      }
    } catch (err) {
      const bad = `${this.file}.bad-${this.now()}`;
      try { fs.renameSync(this.file, bad); } catch { /* best effort — the read above already proved the file exists */ }
      this.log(`deck: ${this.file} 이 손상되어 ${bad} 로 옮기고 0부터 시작합니다 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Atomically (tmp + rename), 0600; a failure is logged and the numbers stay in memory only. */
  private write(): void {
    const out: Record<string, StoredAccount> = {};
    for (const [k, v] of this.data) out[k] = v;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts: out }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      this.log(`deck: ${this.file} 을 쓰지 못했습니다 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private dayOf(ms: number): string {
    return localDay(new Date(ms));
  }

  private todayOf(cur: StoredAccount | undefined, day: string): StoredAccount['today'] {
    return cur && cur.today.day === day ? cur.today : { inputTokens: 0, outputTokens: 0, turns: 0, day };
  }

  /**
   * One Grok turn ended on `account`. `cooldownUntilMs`: the caller's own cooldown map value at this moment (null =
   * not in cooldown) — the only source, this tracker never derives its own. Tokens: input + output only (no cache /
   * reasoning split for Grok); counted for every ended turn, `ok` or not.
   */
  noteTurn(account: GrokAccount, result: { ok: boolean; errorKind: string | null; usage: Pick<TurnUsage, 'inputTokens' | 'outputTokens'>; cooldownUntilMs: number | null }): void {
    const nowMs = this.now();
    const day = this.dayOf(nowMs);
    const cur = this.data.get(account);
    const today = this.todayOf(cur, day);
    const lastError: StoredAccount['lastError'] = result.ok
      ? null
      : result.errorKind === 'authentication_failed' ? 'auth' : result.errorKind === 'rate_limit' ? 'limit' : result.errorKind === 'overloaded' ? 'busy' : null;
    const next: StoredAccount = {
      lastTurnAtMs: nowMs,
      lastError,
      cooldownUntilMs: result.cooldownUntilMs,
      down: result.ok ? false : lastError === 'auth' ? true : (cur?.down ?? false),
      today: {
        inputTokens: today.inputTokens + Math.max(0, result.usage.inputTokens),
        outputTokens: today.outputTokens + Math.max(0, result.usage.outputTokens),
        turns: today.turns + 1,
        day,
      },
    };
    this.data.set(account, next);
    this.write();
    this.usage?.applyGrok(account, this.snapshotOf(account, nowMs));
  }

  /** One account's current card; the day is compared again here (a read with no new turn still sees the midnight reset). */
  snapshotOf(account: GrokAccount, nowMs: number = this.now()): GrokUsage {
    const day = this.dayOf(nowMs);
    const cur = this.data.get(account);
    if (!cur) return emptyGrokUsage(day);
    const today = this.todayOf(cur, day);
    const status: GrokUsage['status'] = cur.down ? 'down' : cur.cooldownUntilMs !== null && nowMs < cur.cooldownUntilMs ? 'cooldown' : cur.lastTurnAtMs === null ? 'unknown' : 'ok';
    return {
      status,
      lastTurnAt: cur.lastTurnAtMs !== null ? new Date(cur.lastTurnAtMs).toISOString() : null,
      lastError: cur.lastError,
      cooldownUntil: cur.cooldownUntilMs !== null ? new Date(cur.cooldownUntilMs).toISOString() : null,
      today,
    };
  }

  /** Every Grok seat that has ever had a turn (today only in practice: x1). */
  snapshotAll(nowMs: number = this.now()): Partial<Record<GrokAccount, GrokUsage>> {
    const out: Partial<Record<GrokAccount, GrokUsage>> = {};
    for (const a of GROK_ACCOUNTS) if (this.data.has(a)) out[a] = this.snapshotOf(a, nowMs);
    return out;
  }
}
