import fs from 'node:fs';
import path from 'node:path';
import type { Account } from '../../shared/accounts';

export function readCooldownUntilMs(dir: string, account: Account, nowMs: number): number | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, account), 'utf8');
  } catch {
    return null;
  }
  // Same acceptance as claude-pick's Python float(): the whole stripped text must be a decimal number.
  const t = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const secs = Number(t);
  if (!Number.isFinite(secs)) return null;
  const untilMs = Math.round(secs * 1000);
  return untilMs > nowMs ? untilMs : null;
}

/** `accounts`: the registry's active ids; the file name is the account id. */
export function readAllCooldownsMs(dir: string, nowMs: number, accounts: readonly Account[]): Partial<Record<Account, number>> {
  const out: Partial<Record<Account, number>> = {};
  for (const a of accounts) {
    const v = readCooldownUntilMs(dir, a, nowMs);
    if (v !== null) out[a] = v;
  }
  return out;
}

/** Atomic for concurrent readers (claude-pick/offload): tmp in the same dir, then rename. */
function writeAtomic(dir: string, account: Account, name: string, text: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${account}.deck-tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, path.join(dir, name));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeCooldown(dir: string, account: Account, untilMs: number): void {
  // ceil so a short cooldown never lands at or before now.
  writeAtomic(dir, account, account, `${Math.ceil(untilMs / 1000)}\n`);
}

/**
 * Why deck cooled `account`, next to the cooldown file: `.<account>.kind` = "<kind> <until secs>". Dot-prefixed, so
 * claude-pick (which opens only `<dir>/<account>`) never reads it; kept across server restarts.
 */
const kindFile = (dir: string, account: Account) => path.join(dir, `.${account}.kind`);

export function writeCooldownKind(dir: string, account: Account, kind: 'auth' | 'limit', untilMs: number): void {
  writeAtomic(dir, account, path.basename(kindFile(dir, account)), `${kind} ${Math.ceil(untilMs / 1000)}\n`);
}

/** The kind deck wrote for the cooldown ending at `untilMs` (readCooldownUntilMs); null when it is for another one (claude-pick wrote over it) or missing. */
export function readCooldownKind(dir: string, account: Account, untilMs: number): 'auth' | 'limit' | null {
  let text: string;
  try {
    text = fs.readFileSync(kindFile(dir, account), 'utf8');
  } catch {
    return null;
  }
  const m = /^(auth|limit) (\d+)$/.exec(text.trim());
  return m && Number(m[2]) * 1000 === untilMs ? (m[1] as 'auth' | 'limit') : null;
}

/** A turn on `account` just worked: its cooldown no longer holds (a missing file is fine). */
export function clearCooldown(dir: string, account: Account): void {
  fs.rmSync(path.join(dir, account), { force: true });
  fs.rmSync(kindFile(dir, account), { force: true });
}
