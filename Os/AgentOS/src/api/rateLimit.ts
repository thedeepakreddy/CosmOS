/**
 * Phase E: a minimal fixed-window rate limiter.
 *
 * Deliberately in-house rather than a new dependency: the need is one counter
 * per client per window, and AgentOS's dependency surface is worth keeping small.
 *
 * Scope note: the window is per-process. With several workers behind a load
 * balancer the effective limit is (limit x workers). That is honest and
 * documented rather than silently assumed -- a shared-store limiter belongs with
 * the distributed work in Phase H.
 */
export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  check(key: string): RateLimitDecision {
    const t = this.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= t) {
      const resetAt = t + this.windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.max - 1, resetAt };
    }

    existing.count++;
    return {
      allowed: existing.count <= this.max,
      remaining: Math.max(0, this.max - existing.count),
      resetAt: existing.resetAt
    };
  }

  /** Drop expired windows so the map cannot grow without bound. */
  prune(): void {
    const t = this.now();
    for (const [key, w] of this.windows) {
      if (w.resetAt <= t) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
