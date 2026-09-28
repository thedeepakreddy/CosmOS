import type { Database } from 'better-sqlite3';
import { RunUsage, UsageStore } from '../contracts';

function toUsage(runId: string, row: any): RunUsage {
  return {
    runId,
    modelCalls: row?.model_calls ?? 0,
    toolCalls: row?.tool_calls ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    costUsd: row?.cost_usd ?? 0
  };
}

export class SqliteUsageStore implements UsageStore {
  constructor(private db: Database) {}

  private ensureRow(runId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO run_usage (run_id) VALUES (?)').run(runId);
  }

  get(runId: string): RunUsage {
    const row = this.db.prepare('SELECT * FROM run_usage WHERE run_id = ?').get(runId);
    return toUsage(runId, row);
  }

  /**
   * Reserve one call, atomically.
   *
   * The limit is part of the WHERE clause, so the check and the increment are a
   * single statement under SQLite's write lock. Two workers cannot both observe
   * "one slot left" and both take it -- the same compare-and-set discipline as
   * the Phase B task claim.
   */
  private reserve(runId: string, column: 'model_calls' | 'tool_calls', max?: number): boolean {
    const tx = this.db.transaction((): boolean => {
      this.ensureRow(runId);
      const info = this.db
        .prepare(
          `UPDATE run_usage SET ${column} = ${column} + 1
            WHERE run_id = @run_id
              AND (@max IS NULL OR ${column} < @max)`
        )
        .run({ run_id: runId, max: max ?? null });
      return info.changes === 1;
    });
    return tx.immediate();
  }

  reserveModelCall(runId: string, maxCalls?: number): boolean {
    return this.reserve(runId, 'model_calls', maxCalls);
  }

  reserveToolCall(runId: string, maxCalls?: number): boolean {
    return this.reserve(runId, 'tool_calls', maxCalls);
  }

  recordModelUsage(
    runId: string,
    usage: { inputTokens: number; outputTokens: number; costUsd?: number },
    maxCostUsd?: number
  ): { withinBudget: boolean; total: RunUsage } {
    const tx = this.db.transaction((): { withinBudget: boolean; total: RunUsage } => {
      this.ensureRow(runId);
      this.db
        .prepare(
          `UPDATE run_usage
              SET input_tokens  = input_tokens + @in,
                  output_tokens = output_tokens + @out,
                  cost_usd      = cost_usd + @cost
            WHERE run_id = @run_id`
        )
        .run({
          in: usage.inputTokens, out: usage.outputTokens,
          cost: usage.costUsd ?? 0, run_id: runId
        });
      const total = this.get(runId);
      // Cost can only be checked AFTER the call, because only the adapter knows
      // what the call cost. The ceiling therefore stops the NEXT call.
      const withinBudget = maxCostUsd === undefined || total.costUsd <= maxCostUsd;
      return { withinBudget, total };
    });
    return tx.immediate();
  }

  isCostExhausted(runId: string, maxCostUsd?: number): boolean {
    if (maxCostUsd === undefined) return false;
    return this.get(runId).costUsd >= maxCostUsd;
  }
}
