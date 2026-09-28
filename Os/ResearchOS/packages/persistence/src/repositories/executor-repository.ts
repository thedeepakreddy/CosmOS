/**
 * External executor registry and request queue.
 *
 * Requests are addressed to a *capability*, never to a named executor. Any
 * healthy executor advertising that capability can claim one, which is what
 * keeps ResearchOS free of knowledge about which host application is attached.
 */
import type { Executor, ExecutorRequest, ExecutorRequestStatus, ExecutorStatus, ToolCapability } from "@research-os/contracts";
import type { Database } from "../database.ts";
import { asEntity, json, jsonOrNull, num, str, strOrNull, toJson, type Row } from "../row.ts";

function toExecutor(row: Row): Executor {
  return asEntity<Executor>({
    id: str(row, "id"), name: str(row, "name"), displayName: strOrNull(row, "display_name"),
    capabilities: json(row, "capabilities", []), callbackUrl: strOrNull(row, "callback_url"),
    mode: str(row, "mode"), status: str(row, "status"),
    maxConcurrentRequests: num(row, "max_concurrent_requests"), version: strOrNull(row, "version"),
    lastHeartbeatAt: strOrNull(row, "last_heartbeat_at"), metadata: json(row, "metadata", {}),
    createdAt: str(row, "created_at"), updatedAt: str(row, "updated_at"),
  });
}

function toRequest(row: Row): ExecutorRequest {
  return asEntity<ExecutorRequest>({
    id: str(row, "id"), projectId: str(row, "project_id"), taskId: strOrNull(row, "task_id"),
    capability: str(row, "capability"), toolId: str(row, "tool_id"), input: json(row, "input", null),
    status: str(row, "status"), executorId: strOrNull(row, "executor_id"), output: jsonOrNull(row, "output"),
    errorMessage: strOrNull(row, "error_message"), timeoutMs: num(row, "timeout_ms"),
    expiresAt: str(row, "expires_at"), createdAt: str(row, "created_at"),
    claimedAt: strOrNull(row, "claimed_at"), completedAt: strOrNull(row, "completed_at"),
  });
}

export class ExecutorRepository {
  readonly #db: Database;
  constructor(db: Database) { this.#db = db; }

  async register(executor: Executor, tokenHash: string, tenantId: string | null): Promise<void> {
    // Re-registration is normal: a host application restarts and announces
    // itself again. It replaces its own row rather than creating a duplicate.
    const conflict = this.#db.dialect.upsert(["name"], [
      "display_name", "capabilities", "callback_url", "mode", "status", "max_concurrent_requests",
      "version", "token_hash", "last_heartbeat_at", "metadata", "updated_at",
    ]);
    await this.#db.execute(
      `INSERT INTO executors (id, name, display_name, capabilities, callback_url, mode, status,
        max_concurrent_requests, version, token_hash, tenant_id, last_heartbeat_at, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
      [executor.id, executor.name, executor.displayName, toJson(executor.capabilities), executor.callbackUrl,
       executor.mode, executor.status, executor.maxConcurrentRequests, executor.version, tokenHash, tenantId,
       executor.lastHeartbeatAt, toJson(executor.metadata), executor.createdAt, executor.updatedAt],
    );
  }

  async findByName(name: string): Promise<Executor | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM executors WHERE name = ?", [name]);
    return row ? toExecutor(row) : undefined;
  }

  async findById(id: string): Promise<Executor | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM executors WHERE id = ?", [id]);
    return row ? toExecutor(row) : undefined;
  }

  /** Looks up an executor by its bearer token hash. Used to authenticate calls. */
  async findByTokenHash(tokenHash: string): Promise<Executor | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM executors WHERE token_hash = ?", [tokenHash]);
    return row ? toExecutor(row) : undefined;
  }

  async list(): Promise<Executor[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM executors ORDER BY name");
    return rows.map(toExecutor);
  }

  async heartbeat(id: string, status: ExecutorStatus, at: string): Promise<void> {
    await this.#db.execute("UPDATE executors SET status = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?", [status, at, at, id]);
  }

  /** Executors that advertise a capability and are not revoked. */
  async findByCapability(capability: ToolCapability): Promise<Executor[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM executors WHERE status <> 'revoked'");
    return rows.map(toExecutor).filter((executor) => executor.capabilities.includes(capability));
  }

  /* ---------- Requests ---------- */

  async createRequest(request: ExecutorRequest): Promise<void> {
    await this.#db.execute(
      `INSERT INTO executor_requests (id, project_id, task_id, capability, tool_id, input, status, executor_id,
        output, error_message, timeout_ms, expires_at, created_at, claimed_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [request.id, request.projectId, request.taskId, request.capability, request.toolId, toJson(request.input),
       request.status, request.executorId, toJson(request.output), request.errorMessage, request.timeoutMs,
       request.expiresAt, request.createdAt, request.claimedAt, request.completedAt],
    );
  }

  /**
   * Atomically hands pending requests to an executor.
   *
   * Same leasing shape as the task queue: one UPDATE, `SKIP LOCKED` where the
   * engine supports it, so two executors polling simultaneously never receive
   * the same request.
   */
  async claimRequests(executorId: string, capabilities: readonly ToolCapability[], max: number, now: string): Promise<ExecutorRequest[]> {
    if (capabilities.length === 0) return [];
    const placeholders = capabilities.map(() => "?").join(", ");
    const inner = `SELECT id FROM executor_requests
       WHERE status = 'pending' AND capability IN (${placeholders}) AND expires_at > ?
       ORDER BY created_at ASC LIMIT ? ${this.#db.dialect.skipLocked}`.trim();

    return this.#db.transaction(async (tx) => {
      const updated = await tx.execute(
        `UPDATE executor_requests SET status = 'claimed', executor_id = ?, claimed_at = ? WHERE id IN (${inner})`,
        [executorId, now, ...capabilities, now, max],
      );
      if (updated === 0) return [];
      const rows = await tx.query<Row>(
        "SELECT * FROM executor_requests WHERE executor_id = ? AND status = 'claimed' AND claimed_at = ? ORDER BY created_at",
        [executorId, now],
      );
      return rows.map(toRequest);
    });
  }

  async findRequest(id: string): Promise<ExecutorRequest | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM executor_requests WHERE id = ?", [id]);
    return row ? toRequest(row) : undefined;
  }

  async completeRequest(id: string, status: ExecutorRequestStatus, output: unknown, errorMessage: string | null, at: string): Promise<void> {
    await this.#db.execute(
      "UPDATE executor_requests SET status = ?, output = ?, error_message = ?, completed_at = ? WHERE id = ?",
      [status, toJson(output), errorMessage, at, id],
    );
  }

  /** Marks requests nobody answered in time. Returns them so tasks can be unblocked. */
  async expireStaleRequests(now: string): Promise<ExecutorRequest[]> {
    const rows = await this.#db.query<Row>(
      "SELECT * FROM executor_requests WHERE status IN ('pending', 'claimed') AND expires_at <= ?",
      [now],
    );
    if (rows.length === 0) return [];
    await this.#db.execute(
      "UPDATE executor_requests SET status = 'timed_out', error_message = 'No executor returned a result before the deadline', completed_at = ? WHERE status IN ('pending', 'claimed') AND expires_at <= ?",
      [now, now],
    );
    return rows.map(toRequest);
  }

  async listRequests(projectId: string, limit = 100): Promise<ExecutorRequest[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM executor_requests WHERE project_id = ? ORDER BY id DESC LIMIT ?", [projectId, limit]);
    return rows.map(toRequest);
  }
}

export { toExecutor, toRequest };
