import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNTS, type Account } from '../../shared/accounts';

export function defaultCooldownDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.CLAUDE_PICK_COOLDOWN_DIR) return env.CLAUDE_PICK_COOLDOWN_DIR;
  const cache = env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(cache, 'offload', 'cooldown');
}

export function readCooldownUntilMs(dir: string, account: Account, nowMs: number): number | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, account), 'utf8');
  } catch {
    return null;
  }
  const secs = Number.parseFloat(text.trim());
  if (!Number.isFinite(secs)) return null;
  const untilMs = Math.round(secs * 1000);
  return untilMs > nowMs ? untilMs : null;
}

export function readAllCooldownsMs(dir: string, nowMs: number): Partial<Record<Account, number>> {
  const out: Partial<Record<Account, number>> = {};
  for (const a of ACCOUNTS) {
    const v = readCooldownUntilMs(dir, a, nowMs);
    if (v !== null) out[a] = v;
  }
  return out;
}

export function writeCooldown(dir: string, account: Account, untilMs: number): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, account), `${Math.floor(untilMs / 1000)}\n`);
}
