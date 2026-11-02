import { latestRolloutRateLimits } from '../engine/codexRollout';
import type { UsageService } from './UsageService';
import { readCodexLiveUsage } from './codexLiveUsage';

/**
 * GPT usage without an inference turn: read live account/rateLimits/read first, then fall back to
 * timestamped Codex rollouts. The CLI owns authentication; deck never opens auth.json.
 */
export class CodexUsagePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAtMs = -Infinity;
  private running: Promise<boolean> | null = null;
  private lastLiveAttemptMs = -Infinity;
  private readonly intervalMs: number;
  private readonly read: typeof latestRolloutRateLimits;

  constructor(private readonly opts: { sessionsRoot: string; usage: Pick<UsageService, 'applyTurn'> & Partial<Pick<UsageService, 'applyGptLive'>>; bin?: string | null; intervalMs?: number; read?: typeof latestRolloutRateLimits; readLive?: () => ReturnType<typeof readCodexLiveUsage>; now?: () => number }) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.read = opts.read ?? latestRolloutRateLimits;
  }

  /** True when a new reading was applied. */
  pollOnce(): Promise<boolean> {
    if (this.running) return this.running;
    this.running = this.poll().finally(() => { this.running = null; });
    return this.running;
  }

  private async poll(): Promise<boolean> {
    try {
      const now = this.opts.now ?? Date.now;
      // Coalesce tab focus/open requests; failed RPCs are throttled too. Rollouts remain the fallback.
      const atMs = now();
      if ((this.opts.bin || this.opts.readLive) && atMs - this.lastLiveAttemptMs >= 15_000) {
        this.lastLiveAttemptMs = atMs;
        const windows = await (this.opts.readLive?.() ?? readCodexLiveUsage(this.opts.bin!)).catch(() => null);
        if (windows) {
          this.lastAtMs = Math.max(this.lastAtMs, atMs);
          if (this.opts.usage.applyGptLive) this.opts.usage.applyGptLive(windows, atMs);
          else this.opts.usage.applyTurn('gpt', windows, atMs);
          return true;
        }
      }
      const obs = await this.read(this.opts.sessionsRoot);
      if (!obs || obs.atMs <= this.lastAtMs) return false;
      this.lastAtMs = obs.atMs;
      this.opts.usage.applyTurn('gpt', obs.windows, obs.atMs);
      return true;
    } catch (err) {
      console.error('deck: codex rollout usage read failed', err instanceof Error ? err.message : String(err));
      return false;
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
}
