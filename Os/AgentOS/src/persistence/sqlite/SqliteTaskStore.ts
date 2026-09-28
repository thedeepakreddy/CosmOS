import type { Database } from 'better-sqlite3';
import { Task, TaskState } from '../../domain/types';
import {
  ClaimOptions,
  ClaimTicket,
  TaskCompletion,
  TaskRef,
  TaskStore
} from '../contracts';

interface TaskRow {
  run_id: string;
  task_id: string;
  name: string;
  description: string;
  agent_definition_id: string;
  fallback_agent_definition_id: string | null;
  state: string;
  input: string | null;
  output: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  timeout_ms: number | null;
  retries_allowed: number;
  retries_attempted: number;
  owner_id: string | null;
  lease_expires_at: number | null;
  fence: number;
  attempt: number;
  not_before: number | null;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.task_id,
    runId: row.run_id,
    name: row.name,
    description: row.description,
    agentDefinitionId: row.agent_definition_id,
    fallbackAgentDefinitionId: row.fallback_agent_definition_id ?? undefined,
    state: row.state as TaskState,
    input: row.input ? JSON.parse(row.input) : undefined,
    output: row.output ? JSON.parse(row.output) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
    retriesAllowed: row.retries_allowed,
    retriesAttempted: row.retries_attempted,
    ownerId: row.owner_id ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    fence: row.fence,
    attempt: row.attempt,
    notBefore: row.not_before ?? undefined
  };
}

export class SqliteTaskStore implements TaskStore {
  constructor(private db: Database) {}

  /**
   * Insert, or update only the DESCRIPTIVE fields of an existing task.
   *
   * Deliberately never writes state, output, error, owner_id, lease_expires_at,
   * fence or attempt. Those are ownership-sensitive and move only through
   * claim / renewLease / complete / setState, every one of which is guarded.
   * In v0.1 a plain upsert could stamp over a running task's state, which is
   * exactly how a stale in-memory copy corrupted live work.
   */
  upsert(task: Task): void {
    if (!task.runId) {
      throw new Error(`TASK_MISSING_RUN_ID: ${task.id}`);
    }
    this.db
      .prepare(
        `INSERT INTO tasks (
           run_id, task_id, name, description, agent_definition_id,
           fallback_agent_definition_id, state, input, output, error,
           created_at, started_at, completed_at, timeout_ms,
           retries_allowed, retries_attempted
         ) VALUES (
           @run_id, @task_id, @name, @description, @agent_definition_id,
           @fallback_agent_definition_id, @state, @input, @output, @error,
           @created_at, @started_at, @completed_at, @timeout_ms,
           @retries_allowed, @retries_attempted
         )
         ON CONFLICT(run_id, task_id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           agent_definition_id = excluded.agent_definition_id,
           fallback_agent_definition_id = excluded.fallback_agent_definition_id,
           input = excluded.input,
           timeout_ms = excluded.timeout_ms,
           retries_allowed = excluded.retries_allowed`
      )
      .run({
        run_id: task.runId,
        task_id: task.id,
        name: task.name,
        description: task.description,
        agent_definition_id: task.agentDefinitionId,
        fallback_agent_definition_id: task.fallbackAgentDefinitionId ?? null,
        state: task.state,
        input: task.input !== undefined ? JSON.stringify(task.input) : null,
        output: task.output !== undefined ? JSON.stringify(task.output) : null,
        error: task.error ?? null,
        created_at: task.createdAt ?? new Date().toISOString(),
        started_at: task.startedAt ?? null,
        completed_at: task.completedAt ?? null,
        timeout_ms: task.timeoutMs ?? null,
        retries_allowed: task.retriesAllowed,
        retries_attempted: task.retriesAttempted
      });
  }

  get(ref: TaskRef): Task | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ? AND task_id = ?')
      .get(ref.runId, ref.taskId) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  listByRun(runId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ?')
      .all(runId) as TaskRow[];
    return rows.map(toTask);
  }

  pageByRun(runId: string, limit: number, cursor?: string): { tasks: Task[]; nextCursor: string | null } {
    // Keyset pagination on the (run_id, task_id) primary key: stable while other
    // workers are writing, and index-ordered so it costs a seek, not a scan.
    const rows = (cursor === undefined
      ? this.db
          .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id LIMIT ?')
          .all(runId, limit + 1)
      : this.db
          .prepare('SELECT * FROM tasks WHERE run_id = ? AND task_id > ? ORDER BY task_id LIMIT ?')
          .all(runId, cursor, limit + 1)) as TaskRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      tasks: page.map(toTask),
      nextCursor: hasMore ? page[page.length - 1].task_id : null
    };
  }

  countByRun(runId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM tasks WHERE run_id = ?')
      .get(runId) as { c: number };
    return row.c;
  }

  /** Only advances a task that is not currently owned by anyone. */
  setState(ref: TaskRef, state: TaskState): boolean {
    const info = this.db
      .prepare(
        `UPDATE tasks SET state = @state
          WHERE run_id = @run_id AND task_id = @task_id
            AND state IN ('PENDING', 'BLOCKED', 'READY')
            AND owner_id IS NULL`
      )
      .run({ state, run_id: ref.runId, task_id: ref.taskId });
    return info.changes === 1;
  }

  /**
   * B4 + B8 + B10: the atomic claim.
   *
   * One statement decides everything, under SQLite's write lock:
   *   - the task must be READY, or RUNNING with an EXPIRED lease (reclaim)
   *   - a healthy owner's unexpired lease makes the WHERE clause fail, so a
   *     second worker simply loses -- it cannot steal live work (B8)
   *   - the optional global concurrency ceiling is evaluated in the same
   *     statement, so the cap holds ACROSS processes rather than per-process
   *   - fence and attempt both increment, so the previous owner's ticket is
   *     immediately stale (B6) and attempts never decrease (B11)
   *
   * `changes === 0` means the claim was LOST. The caller must not execute.
   */
  claim(options: ClaimOptions): ClaimTicket | null {
    const { runId, taskId, workerId, leaseMs, now, maxConcurrent } = options;
    const leaseExpiresAt = now + leaseMs;

    const update = this.db.prepare(
      `UPDATE tasks
          SET state            = 'RUNNING',
              owner_id         = @worker_id,
              lease_expires_at = @lease_expires_at,
              fence            = fence + 1,
              attempt          = attempt + 1,
              -- Phase C: a retry is counted when it actually STARTS, not when it
              -- is queued. Re-executing a READY task that has already run once is
              -- a retry; reclaiming a RUNNING task from a dead worker is not --
              -- a worker dying is not the task's fault.
              retries_attempted = CASE
                WHEN state = 'READY' AND attempt > 0 THEN retries_attempted + 1
                ELSE retries_attempted
              END,
              not_before       = NULL,
              started_at       = COALESCE(started_at, @started_at),
              completed_at     = NULL
        WHERE run_id  = @run_id
          AND task_id = @task_id
          AND (
                state = 'READY'
                OR (state = 'RUNNING'
                    AND lease_expires_at IS NOT NULL
                    AND lease_expires_at <= @now)
              )
          -- Phase C: durable retry backoff.
          AND (not_before IS NULL OR not_before <= @now)
          AND (
                @max_concurrent IS NULL
                OR (
                     SELECT COUNT(*) FROM tasks AS live
                      WHERE live.run_id = @run_id
                        AND live.state = 'RUNNING'
                        AND live.lease_expires_at IS NOT NULL
                        AND live.lease_expires_at > @now
                        AND live.task_id <> @task_id
                   ) < @max_concurrent
              )`
    );

    const read = this.db.prepare(
      'SELECT fence, attempt, retries_attempted, lease_expires_at FROM tasks WHERE run_id = ? AND task_id = ?'
    );

    // BEGIN IMMEDIATE: the conditional update and the read-back of the new fence
    // are one atomic unit, so two workers can never observe the same fence.
    const tx = this.db.transaction((): ClaimTicket | null => {
      const info = update.run({
        worker_id: workerId,
        lease_expires_at: leaseExpiresAt,
        started_at: new Date(now).toISOString(),
        run_id: runId,
        task_id: taskId,
        now,
        max_concurrent: maxConcurrent ?? null
      });
      if (info.changes !== 1) return null;

      const row = read.get(runId, taskId) as
        | { fence: number; attempt: number; retries_attempted: number; lease_expires_at: number }
        | undefined;
      if (!row) return null;

      return {
        runId,
        taskId,
        workerId,
        fence: row.fence,
        attempt: row.attempt,
        retriesAttempted: row.retries_attempted,
        leaseExpiresAt: row.lease_expires_at
      };
    });

    return tx.immediate();
  }

  /** B17: extend the lease. Rejected unless the ticket is still the live owner. */
  renewLease(ticket: ClaimTicket, leaseMs: number, now: number): ClaimTicket | null {
    const leaseExpiresAt = now + leaseMs;
    const info = this.db
      .prepare(
        `UPDATE tasks SET lease_expires_at = @lease_expires_at
          WHERE run_id  = @run_id
            AND task_id = @task_id
            AND owner_id = @worker_id
            AND fence    = @fence
            AND state    = 'RUNNING'`
      )
      .run({
        lease_expires_at: leaseExpiresAt,
        run_id: ticket.runId,
        task_id: ticket.taskId,
        worker_id: ticket.workerId,
        fence: ticket.fence
      });
    if (info.changes !== 1) return null;
    return { ...ticket, leaseExpiresAt };
  }

  /**
   * B7: ownership-checked terminal write.
   *
   * The WHERE clause pins run, task, owner, fence AND state. If ownership has
   * moved on -- because the lease expired and another worker reclaimed, bumping
   * the fence -- zero rows update and this returns false. That is the mechanism
   * that stops a late result from a superseded worker becoming canonical.
   */
  complete(ticket: ClaimTicket, completion: TaskCompletion): boolean {
    const requeue = completion.requeueAsReady === true;
    const info = this.db
      .prepare(
        `UPDATE tasks
            SET state             = @state,
                output            = @output,
                error             = @error,
                completed_at      = @completed_at,
                not_before        = @not_before,
                owner_id          = NULL,
                lease_expires_at  = NULL
          WHERE run_id  = @run_id
            AND task_id = @task_id
            AND owner_id = @worker_id
            AND fence    = @fence
            AND state    = 'RUNNING'`
      )
      .run({
        state: requeue ? 'READY' : completion.state,
        output: completion.output !== undefined ? JSON.stringify(completion.output) : null,
        error: completion.error ?? null,
        // A requeued task has not completed; leaving a stale completedAt behind
        // was a v0.1 wart.
        completed_at: requeue ? null : completion.completedAt,
        // Backoff applies only to a requeue; a terminal write clears the gate.
        not_before: requeue ? completion.notBefore ?? null : null,
        run_id: ticket.runId,
        task_id: ticket.taskId,
        worker_id: ticket.workerId,
        fence: ticket.fence
      });
    return info.changes === 1;
  }

  // ---- Phase D: indexed, set-shaped scheduling queries ----------------------

  countByState(runId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS c FROM tasks WHERE run_id = ? GROUP BY state')
      .all(runId) as { state: string; c: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.c;
    return out;
  }

  /**
   * Dependency resolution in SQL.
   *
   * `NOT EXISTS (... dep.state <> 'SUCCEEDED')` is the set-shaped equivalent of
   * the old per-task JS loop over every dependency edge. It uses the
   * task_dependencies primary key (run_id, task_id, depends_on) and the tasks
   * primary key, so the cost is proportional to the edges of the candidate
   * tasks -- not to the size of the whole run.
   */
  findUnblocked(runId: string): string[] {
    return this.db
      .prepare(
        `SELECT t.task_id FROM tasks t
          WHERE t.run_id = @run_id
            AND t.state IN ('PENDING', 'BLOCKED')
            AND t.owner_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM task_dependencies d
              JOIN tasks dep ON dep.run_id = d.run_id AND dep.task_id = d.depends_on
               WHERE d.run_id = t.run_id AND d.task_id = t.task_id
                 AND dep.state <> 'SUCCEEDED'
            )`
      )
      .pluck()
      .all({ run_id: runId }) as string[];
  }

  findDependencyFailed(runId: string): string[] {
    return this.db
      .prepare(
        `SELECT t.task_id FROM tasks t
          WHERE t.run_id = @run_id
            AND t.state IN ('PENDING', 'BLOCKED')
            AND t.owner_id IS NULL
            AND EXISTS (
              SELECT 1 FROM task_dependencies d
              JOIN tasks dep ON dep.run_id = d.run_id AND dep.task_id = d.depends_on
               WHERE d.run_id = t.run_id AND d.task_id = t.task_id
                 AND dep.state = 'FAILED'
            )`
      )
      .pluck()
      .all({ run_id: runId }) as string[];
  }

  listClaimable(runId: string, now: number, limit: number): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
          WHERE run_id = @run_id
            AND (
                  (state = 'READY' AND (not_before IS NULL OR not_before <= @now))
                  OR (state = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now)
                )
          LIMIT @limit`
      )
      .all({ run_id: runId, now, limit }) as TaskRow[];
    return rows.map(toTask);
  }

  nextWakeAt(runId: string, now: number): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(wake) AS wake FROM (
           SELECT lease_expires_at AS wake FROM tasks
            WHERE run_id = @run_id AND state = 'RUNNING'
              AND lease_expires_at IS NOT NULL AND lease_expires_at > @now
           UNION ALL
           SELECT not_before AS wake FROM tasks
            WHERE run_id = @run_id AND state = 'READY'
              AND not_before IS NOT NULL AND not_before > @now
         )`
      )
      .get({ run_id: runId, now }) as { wake: number | null };
    return row.wake ?? null;
  }

  countLiveClaims(runId: string, now: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks
          WHERE run_id = ? AND state = 'RUNNING'
            AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`
      )
      .get(runId, now) as { c: number };
    return row.c;
  }

  /**
   * Phase C: drain every non-terminal task in a run to CANCELLED.
   *
   * Leases are released so the row stops being reclaimable, and because the
   * state is no longer RUNNING, a worker still executing one of these tasks has
   * its `complete()` rejected by the same ownership check that rejects a stale
   * fence. Its result is discarded instead of landing in a finished run.
   */
  cancelNonTerminal(runId: string, completedAt: string): number {
    const info = this.db
      .prepare(
        `UPDATE tasks
            SET state            = 'CANCELLED',
                completed_at     = @completed_at,
                owner_id         = NULL,
                lease_expires_at = NULL,
                not_before       = NULL
          WHERE run_id = @run_id
            AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SKIPPED')`
      )
      .run({ run_id: runId, completed_at: completedAt });
    return info.changes;
  }

  findReclaimable(runId: string, now: number): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
          WHERE run_id = ? AND state = 'RUNNING'
            AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
      )
      .all(runId, now) as TaskRow[];
    return rows.map(toTask);
  }
}
