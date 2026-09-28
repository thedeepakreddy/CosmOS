import type { Database } from 'better-sqlite3';
import { RateLimitDecision, RateLimitStore } from '../contracts';

/**
 * Phase H: rate limiting shared across workers.
 *
 * Phase E's limiter was explicitly documented as PER-PROCESS: behind N workers
 * the effective ceiling was N x limit. This moves the window into the database,
 * so the check-and-increment is one atomic statement and the ceiling is real
 * regardless of how many processes are serving.
 */
export class SqliteRateLimitStore implements RateLimitStore {
  constructor(private db: Database) {}

  check(key: string, max: number, windowMs: number, now: number): RateLimitDecision {
    const tx = this.db.transaction((): RateLimitDecision => {
      const row = this.db
        .prepare('SELECT count, reset_at FROM rate_limit_windows WHERE key = ?')
        .get(key) as { count: number; reset_at: number } | undefined;

      if (!row || row.reset_at <= now) {
        const resetAt = now + windowMs;
        this.db
          .prepare(
            `INSERT INTO rate_limit_windows (key, count, reset_at) VALUES (?, 1, ?)
             ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`
          )
          .run(key, resetAt);
        return { allowed: true, remaining: max - 1, resetAt };
      }

      const count = row.count + 1;
      this.db.prepare('UPDATE rate_limit_windows SET count = ? WHERE key = ?').run(count, key);
      return { allowed: count <= max, remaining: Math.max(0, max - count), resetAt: row.reset_at };
    });
    return tx.immediate();
  }

  /** Drop expired windows so the table cannot grow without bound. */
  prune(now: number): number {
    return this.db.prepare('DELETE FROM rate_limit_windows WHERE reset_at <= ?').run(now).changes;
  }
}
