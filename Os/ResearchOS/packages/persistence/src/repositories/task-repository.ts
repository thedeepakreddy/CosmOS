/**
 * The durable task queue.
 *
 * This is what makes a research run resumable. Every unit of work is a row, and
 * a worker holds a *lease* on a row rather than owning it: if the worker dies,
 * the lease expires and another worker picks the task up. Nothing is held in
 * process memory, so a crash costs at most one task's progress.
 *
 * Claiming is a single atomic UPDATE. On Postgres the inner select takes
 * `FOR UPDATE SKIP LOCKED` so concurrent workers never contend for the same
 * row; on SQLite writes are serialised anyway, so the same statement is safe
 * without it.
 */
import type { Task, TaskStatus, TaskType } from "@research-os/contracts";
import { newId } from "@research-os/shared";
import type { Database } from "../database.ts";
import { asEntity, json, num, str, strOrNull, toJson, type Row } from "../row.ts";

function toTask(row: Row): Task {
  return asEntity<Task>({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    type: str(row, "type") as TaskType,
    status: str(row, "status") as TaskStatus,
    priority: num(row, "priority"),
    dependsOn: json(row, "depends_on", []),
    input: json(row, "input", null),
    output: json(row, "output", null),
    attempts: num(row, "attempts"),
    maxAttempts: num(row, "max_attempts"),
    leasedBy: strOrNull(row, "leased_by"),
    leaseExpiresAt: strOrNull(row, "lease_expires_at"),
    runAfter: str(row, "run_after"),
    awaitingRequestId: strOrNull(row, "awaiting_request_id"),
    errorCode: strOrNull(row, "error_code"),
    errorMessage: strOrNull(row, "error_message"),
    traceId: strOrNull(row, "trace_id"),
    metadata: json(row, "metadata", {}),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    startedAt: strOrNull(row, "started_at"),
    finishedAt: strOrNull(row, "finished_at"),
  });
}

export interface ClaimOptions {
  readonly workerId: string;
  readonly projectId?: string;
  readonly max: number;
  readonly leaseMs: number;
  readonly now: string;
}

export class TaskRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async create(tasks: readonly Task[]): Promise<void> {
    await this.#db.transaction(async (tx) => {
      for (const task of tasks) {
        await tx.execute(
          `INSERT INTO tasks (id, project_id, type, status, priority, depends_on, input, output, attempts,
            max_attempts, leased_by, lease_expires_at, run_after, awaiting_request_id, error_code, error_message,
            trace_id, metadata, created_at, updated_at, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [task.id, task.projectId, task.type, task.status, task.priority, toJson(task.dependsOn),
           toJson(task.input), toJson(task.output), task.attempts, task.maxAttempts, task.leasedBy,
           task.leaseExpiresAt, task.runAfter, task.awaitingRequestId, task.errorCode, task.errorMessage,
           task.traceId, toJson(task.metadata), task.createdAt, task.updatedAt, task.startedAt, task.finishedAt],
        );
        for (const dependency of task.dependsOn) {
          await tx.execute(
            "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
            [task.id, dependency],
          );
        }
      }
    });
  }

  /**
   * Atomically leases up to `max` runnable tasks to a worker.
   *
   * A task is runnable when it is pending or queued, its `run_after` has passed,
   * and every dependency has completed. The lease token embedded in `leased_by`
   * identifies exactly the rows this call claimed — without it, a second claim
   * by the same worker in the same millisecond could not be told apart from the
   * first.
   */
  async claim(options: ClaimOptions): Promise<Task[]> {
    const leaseToken = `${options.workerId}#${newId("task")}`;
    const expiresAt = new Date(Date.parse(options.now) + options.leaseMs).toISOString();

    const conditions = [
      "status IN ('pending', 'queued')",
      "run_after <= ?",
      `NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on_task_id
        WHERE d.task_id = tasks.id AND dep.status <> 'completed'
      )`,
    ];
    const params: (string | number)[] = [options.now];
    if (options.projectId) {
      conditions.push("project_id = ?");
      params.push(options.projectId);
    }
    params.push(options.max);

    const inner = `SELECT id FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY priority DESC, id ASC LIMIT ? ${this.#db.dialect.skipLocked}`.trim();

    return this.#db.transaction(async (tx) => {
      const updated = await tx.execute(
        `UPDATE tasks SET status = 'running', leased_by = ?, lease_expires_at = ?, attempts = attempts + 1,
           started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id IN (${inner})`,
        [leaseToken, expiresAt, options.now, options.now, ...params],
      );
      if (updated === 0) return [];
      const rows = await tx.query<Row>("SELECT * FROM tasks WHERE leased_by = ? ORDER BY priority DESC, id ASC", [leaseToken]);
      return rows.map(toTask);
    });
  }

  /**
   * Returns tasks whose lease has expired to the pending pool.
   *
   * This is crash recovery: a worker that died mid-task left a row marked
   * `running` with a lease nobody is renewing. A task that has exhausted its
   * attempts is failed rather than looped forever.
   */
  async reclaimExpiredLeases(now: string): Promise<{ requeued: number; failed: number }> {
    const failed = await this.#db.execute(
      `UPDATE tasks SET status = 'failed', leased_by = NULL, lease_expires_at = NULL,
         error_code = 'lease_expired', error_message = 'Worker lease expired and the task has no attempts left',
         finished_at = ?, updated_at = ?
       WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ? AND attempts >= max_attempts`,
      [now, now, now],
    );
    const requeued = await this.#db.execute(
      `UPDATE tasks SET status = 'pending', leased_by = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ? AND attempts < max_attempts`,
      [now, now],
    );
    return { requeued, failed };
  }

  /** Task ids that are waiting on this one. */
  async dependents(taskId: string): Promise<string[]> {
    const rows = await this.#db.query<Row>(
      "SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?",
      [taskId],
    );
    return rows.map((row) => str(row, "task_id"));
  }

  /**
   * Adds dependencies to an existing task.
   *
   * Needed because a planned step can expand at run time: a discovery step that
   * finds eight sources creates eight ingestion tasks, and whatever was waiting
   * on discovery must now wait on those too. Without this the plan's DAG would
   * be correct only for work known before the run started.
   *
   * The `dependsOn` column is kept in step with the join table so a task row
   * read on its own still shows what it is waiting for.
   */
  async addDependencies(taskId: string, dependsOnTaskIds: readonly string[]): Promise<void> {
    if (dependsOnTaskIds.length === 0) return;
    await this.#db.transaction(async (tx) => {
      const row = await tx.queryOne<Row>("SELECT depends_on FROM tasks WHERE id = ?", [taskId]);
      if (!row) return;
      const existing = new Set(json<string[]>(row, "depends_on", []));
      for (const dependency of dependsOnTaskIds) {
        if (dependency === taskId || existing.has(dependency)) continue;
        existing.add(dependency);
        await tx.execute(
          `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?) ${tx.dialect.upsert(["task_id", "depends_on_task_id"], [])}`,
          [taskId, dependency],
        );
      }
      await tx.execute("UPDATE tasks SET depends_on = ? WHERE id = ?", [toJson([...existing]), taskId]);
    });
  }

  /** Extends a lease on a task that is still being worked. */
  async renewLease(taskId: string, leasedBy: string, leaseMs: number, now: string): Promise<boolean> {
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const updated = await this.#db.execute(
      "UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND leased_by = ? AND status = 'running'",
      [expiresAt, now, taskId, leasedBy],
    );
    return updated > 0;
  }

  async complete(taskId: string, output: unknown, now: string): Promise<void> {
    await this.#db.execute(
      `UPDATE tasks SET status = 'completed', output = ?, leased_by = NULL, lease_expires_at = NULL,
        error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
      [toJson(output), now, now, taskId],
    );
  }

  /**
   * Records a failure. A retryable failure with attempts remaining goes back to
   * pending with a backoff; anything else is terminal.
   */
  async fail(taskId: string, error: { code: string; message: string; retryable: boolean }, backoffMs: number, now: string): Promise<TaskStatus> {
    const row = await this.#db.queryOne<Row>("SELECT attempts, max_attempts FROM tasks WHERE id = ?", [taskId]);
    if (!row) return "failed";
    const canRetry = error.retryable && num(row, "attempts") < num(row, "max_attempts");

    if (canRetry) {
      await this.#db.execute(
        `UPDATE tasks SET status = 'pending', leased_by = NULL, lease_expires_at = NULL, run_after = ?,
          error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`,
        [new Date(Date.parse(now) + backoffMs).toISOString(), error.code, error.message, now, taskId],
      );
      return "pending";
    }
    await this.#db.execute(
      `UPDATE tasks SET status = 'failed', leased_by = NULL, lease_expires_at = NULL,
        error_code = ?, error_message = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      [error.code, error.message, now, now, taskId],
    );
    return "failed";
  }

  /** Parks a task awaiting an external executor result. */
  async waitForTool(taskId: string, requestId: string, now: string): Promise<void> {
    await this.#db.execute(
      `UPDATE tasks SET status = 'waiting_for_tool', awaiting_request_id = ?, leased_by = NULL,
        lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      [requestId, now, taskId],
    );
  }

  async waitForUser(taskId: string, prompt: string, now: string): Promise<void> {
    await this.#db.execute(
      `UPDATE tasks SET status = 'waiting_for_user', leased_by = NULL, lease_expires_at = NULL,
        metadata = ?, updated_at = ? WHERE id = ?`,
      [toJson({ waitingPrompt: prompt }), now, taskId],
    );
  }

  /** Returns a parked task to the runnable pool once its blocker clears. */
  async resume(taskId: string, now: string): Promise<void> {
    await this.#db.execute(
      `UPDATE tasks SET status = 'pending', awaiting_request_id = NULL, run_after = ?, updated_at = ? WHERE id = ?`,
      [now, now, taskId],
    );
  }

  async findById(id: string): Promise<Task | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM tasks WHERE id = ?", [id]);
    return row ? toTask(row) : undefined;
  }

  async findByAwaitingRequest(requestId: string): Promise<Task | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM tasks WHERE awaiting_request_id = ?", [requestId]);
    return row ? toTask(row) : undefined;
  }

  async list(projectId: string, options: { status?: TaskStatus; limit?: number; cursor?: string } = {}): Promise<Task[]> {
    const conditions = ["project_id = ?"];
    const params: (string | number)[] = [projectId];
    if (options.status) { conditions.push("status = ?"); params.push(options.status); }
    if (options.cursor) { conditions.push("id < ?"); params.push(options.cursor); }
    params.push(options.limit ?? 200);
    const rows = await this.#db.query<Row>(`SELECT * FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, params);
    return rows.map(toTask);
  }

  async countByStatus(projectId: string): Promise<Record<string, number>> {
    const rows = await this.#db.query<Row>("SELECT status, COUNT(*) AS c FROM tasks WHERE project_id = ? GROUP BY status", [projectId]);
    return Object.fromEntries(rows.map((row) => [str(row, "status"), num(row, "c")]));
  }

  /** True when no task can make further progress — the run is finished or wedged. */
  async hasRunnableWork(projectId: string): Promise<boolean> {
    const row = await this.#db.queryOne<Row>(
      `SELECT COUNT(*) AS c FROM tasks
       WHERE project_id = ? AND status IN ('pending', 'queued', 'running', 'waiting_for_tool', 'waiting_for_user')`,
      [projectId],
    );
    return row ? num(row, "c") > 0 : false;
  }

  async cancelAll(projectId: string, now: string): Promise<number> {
    return this.#db.execute(
      `UPDATE tasks SET status = 'cancelled', leased_by = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
       WHERE project_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, now, projectId],
    );
  }
}

export { toTask };
