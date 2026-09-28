import type { Database } from 'better-sqlite3';
import { AgentRun, RunState, TaskGraph } from '../../domain/types';
import { RunStore, TaskStore } from '../contracts';

export class SqliteRunStore implements RunStore {
  constructor(private db: Database, private tasks: TaskStore) {}

  save(run: AgentRun): void {
    // A1 (Phase A, preserved): duplicate task ids within one graph are rejected
    // at the persistence boundary, before anything is written. Phase B scopes
    // ids per run, so this now checks uniqueness WITHIN the run -- which is
    // exactly the right granularity.
    if (run.taskGraph) {
      const seen = new Set<string>();
      for (const task of run.taskGraph.tasks) {
        if (seen.has(task.id)) {
          throw new Error(`DUPLICATE_TASK_ID: ${task.id}`);
        }
        seen.add(task.id);
      }
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runs (id, goal, state, budget, created_at, started_at, completed_at, error, result)
           VALUES (@id, @goal, @state, @budget, @created_at, @started_at, @completed_at, @error, @result)
           ON CONFLICT(id) DO UPDATE SET
             state        = excluded.state,
             started_at   = excluded.started_at,
             completed_at = excluded.completed_at,
             error        = excluded.error,
             result       = excluded.result`
        )
        .run({
          id: run.id,
          goal: run.goal,
          state: run.state,
          budget: run.budget ? JSON.stringify(run.budget) : null,
          created_at: run.createdAt,
          started_at: run.startedAt ?? null,
          completed_at: run.completedAt ?? null,
          error: run.error ?? null,
          result: run.result !== undefined ? JSON.stringify(run.result) : null
        });

      if (run.taskGraph) {
        for (const task of run.taskGraph.tasks) {
          this.tasks.upsert({ ...task, runId: run.id });
        }

        // Dependencies are run-scoped. Replacing only THIS run's edges cannot
        // disturb another run, which the v0.1 global keying could not guarantee.
        this.db.prepare('DELETE FROM task_dependencies WHERE run_id = ?').run(run.id);
        const insertDep = this.db.prepare(
          'INSERT OR IGNORE INTO task_dependencies (run_id, task_id, depends_on) VALUES (?, ?, ?)'
        );
        for (const dep of run.taskGraph.dependencies) {
          insertDep.run(run.id, dep.taskId, dep.dependsOn);
        }
      }
    });
    tx.immediate();
  }

  /** Phase D: run row only -- no task-graph hydration. */
  getMeta(id: string): Omit<AgentRun, 'taskGraph'> | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      goal: row.goal,
      state: row.state as RunState,
      budget: row.budget ? JSON.parse(row.budget) : undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      result: row.result ? JSON.parse(row.result) : undefined
    };
  }

  listActive(limit = 100): Array<Omit<AgentRun, 'taskGraph'>> {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs
          WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT')
          ORDER BY created_at LIMIT ?`
      )
      .all(limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      goal: row.goal,
      state: row.state as RunState,
      budget: row.budget ? JSON.parse(row.budget) : undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      result: row.result ? JSON.parse(row.result) : undefined
    }));
  }

  get(id: string): AgentRun | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as any;
    if (!row) return null;

    const tasks = this.tasks.listByRun(id);
    const deps = this.db
      .prepare('SELECT task_id AS taskId, depends_on AS dependsOn FROM task_dependencies WHERE run_id = ?')
      .all(id) as { taskId: string; dependsOn: string }[];

    const taskGraph: TaskGraph | undefined =
      tasks.length > 0 ? { tasks, dependencies: deps } : undefined;

    return {
      id: row.id,
      goal: row.goal,
      state: row.state as RunState,
      budget: row.budget ? JSON.parse(row.budget) : undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
      taskGraph
    };
  }

  /**
   * B18: compare-and-set for run state.
   *
   * Run-level transitions (start, pause, terminal) are ownership-sensitive in a
   * multi-worker world: two workers observing the same snapshot must not both
   * decide to drive the transition. Pinning the expected prior state in the
   * WHERE clause makes exactly one of them win.
   */
  /**
   * Phase C: terminal transition and task drain in ONE transaction.
   *
   * Performed separately, there is a window between "the run is finished" and
   * "its tasks are finished" in which another worker can still claim work. The
   * audit measured the consequence: 27.5% of terminal runs left live tasks
   * behind, which also inflated attempt counters.
   */
  terminate(
    id: string,
    from: RunState[],
    to: RunState,
    patch: Partial<AgentRun> = {}
  ): { drained: number } | null {
    const tx = this.db.transaction((): { drained: number } | null => {
      if (!this.compareAndSetState(id, from, to, patch)) return null;
      const drained = this.tasks.cancelNonTerminal(
        id,
        patch.completedAt ?? new Date().toISOString()
      );
      return { drained };
    });
    return tx.immediate();
  }

  compareAndSetState(
    id: string,
    from: RunState[],
    to: RunState,
    patch: Partial<AgentRun> = {}
  ): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => '?').join(', ');
    const info = this.db
      .prepare(
        `UPDATE runs
            SET state        = ?,
                started_at   = COALESCE(?, started_at),
                completed_at = COALESCE(?, completed_at),
                error        = COALESCE(?, error),
                result       = COALESCE(?, result)
          WHERE id = ? AND state IN (${placeholders})`
      )
      .run(
        to,
        patch.startedAt ?? null,
        patch.completedAt ?? null,
        patch.error ?? null,
        patch.result !== undefined ? JSON.stringify(patch.result) : null,
        id,
        ...from
      );
    return info.changes === 1;
  }
}
