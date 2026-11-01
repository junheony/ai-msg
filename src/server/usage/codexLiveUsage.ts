import { spawn } from 'node:child_process';
import { codexEnv } from '../../shared/accounts';
import type { TurnWindows } from './UsageService';

const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** account/rateLimits/read uses usedPercent, never remaining percent. Ignore other model buckets. */
export function parseCodexLiveUsage(value: unknown): TurnWindows | null {
  const result = obj(value);
  const buckets = obj(result?.rateLimitsByLimitId);
  const bucket = obj(buckets?.codex) ?? obj(result?.rateLimits);
  if (!bucket || (typeof bucket.limitId === 'string' && bucket.limitId !== 'codex')) return null;
  const out: TurnWindows = {};
  for (const key of ['primary', 'secondary']) {
    if (bucket[key] == null) continue;
    const w = obj(bucket[key]);
    // A complete response with a malformed present window cannot safely clear an old valid window.
    if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) return null;
    if (w.windowDurationMins !== 300 && w.windowDurationMins !== 10080) return null;
    const reset = typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000) : null;
    const window = { usedPct: w.usedPercent, resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null };
    if (w.windowDurationMins === 300) out.fiveHour = window;
    if (w.windowDurationMins === 10080) out.weekly = window;
  }
  if (!out.fiveHour && !out.weekly) return null;
  const credits = obj(bucket.credits);
  if (credits && typeof credits.hasCredits === 'boolean') {
    const balance = typeof credits.balance === 'string' && credits.balance.trim() ? Number(credits.balance) : NaN;
    out.credits = { hasCredits: credits.hasCredits, unlimited: credits.unlimited === true, balance: Number.isFinite(balance) ? balance : null };
  }
  return out;
}

/** A short-lived stdio RPC client. No thread/turn/login/reset-credit methods; stderr/auth are never logged. */
export function readCodexLiveUsage(bin: string, opts: { spawnFn?: typeof spawn; timeoutMs?: number } = {}): Promise<TurnWindows | null> {
  return new Promise((resolve) => {
    // Same credential environment as CodexEngine: preserve CODEX_HOME, drop API-key overrides.
    const child = (opts.spawnFn ?? spawn)(bin, ['app-server', '--listen', 'stdio://'], { env: codexEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false;
    let buffer = '';
    let total = 0;
    let initialized = false;
    const finish = (value: TurnWindows | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin?.end();
      child.kill('SIGTERM');
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
      kill.unref();
      child.once('close', () => clearTimeout(kill));
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), opts.timeoutMs ?? 10_000);
    const send = (message: unknown) => child.stdin?.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish(null));
    child.stdin?.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stderr?.resume();
    child.stdout?.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1024 * 1024) { finish(null); return; }
      buffer += chunk.toString('utf8');
      let end: number;
      while (!done && (end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: Record<string, unknown> | null;
        try { message = obj(JSON.parse(line)); } catch { continue; }
        if (message?.id === 1 && !initialized) {
          if (message.error || !message.result) { finish(null); return; }
          initialized = true;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (message?.id === 2) finish(message.error ? null : parseCodexLiveUsage(message.result));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'msg_usage', version: '1.0.0' }, capabilities: {} } });
  });
}
