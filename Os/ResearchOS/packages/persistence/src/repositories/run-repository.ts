/**
 * Agent runs, critique findings, failure memory, verification and debates.
 *
 * Everything an agent *did*, as opposed to what it produced. Keeping these
 * separate from research artifacts means a claim can be traced to the run that
 * proposed it without the claim table carrying execution metadata.
 */
import type {
  AgentRun, AgentRunStatus, CritiqueFinding, Debate, FailureRecord, VerificationCheck, VerificationSummary,
} from "@research-os/contracts";
import type { Database } from "../database.ts";
import { asEntity, bool, json, jsonOrNull, num, numOrNull, str, strOrNull, toJson, type Row } from "../row.ts";

export class RunRepository {
  readonly #db: Database;
  constructor(db: Database) { this.#db = db; }

  /* ---------- Agent runs ---------- */

  async startRun(run: AgentRun): Promise<void> {
    await this.#db.execute(
      `INSERT INTO agent_runs (id, project_id, task_id, role, status, model, provider, input, output, usage,
        trace_id, error_code, error_message, started_at, finished_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [run.id, run.projectId, run.taskId, run.role, run.status, run.model, run.provider, toJson(run.input),
       toJson(run.output), toJson(run.usage), run.traceId, run.errorCode, run.errorMessage,
       run.startedAt, run.finishedAt, run.durationMs],
    );
  }

  async finishRun(id: string, patch: { status: AgentRunStatus; output?: unknown; usage?: AgentRun["usage"]; model?: string | null; provider?: string | null; errorCode?: string | null; errorMessage?: string | null }, finishedAt: string, durationMs: number): Promise<void> {
    await this.#db.execute(
      `UPDATE agent_runs SET status = ?, output = COALESCE(?, output), usage = COALESCE(?, usage),
        model = COALESCE(?, model), provider = COALESCE(?, provider), error_code = ?, error_message = ?,
        finished_at = ?, duration_ms = ? WHERE id = ?`,
      [patch.status, toJson(patch.output), toJson(patch.usage), patch.model ?? null, patch.provider ?? null,
       patch.errorCode ?? null, patch.errorMessage ?? null, finishedAt, durationMs, id],
    );
  }

  async listRuns(projectId: string, options: { limit?: number; cursor?: string; status?: AgentRunStatus } = {}): Promise<AgentRun[]> {
    const conditions = ["project_id = ?"];
    const params: (string | number)[] = [projectId];
    if (options.status) { conditions.push("status = ?"); params.push(options.status); }
    if (options.cursor) { conditions.push("id < ?"); params.push(options.cursor); }
    params.push(options.limit ?? 200);
    const rows = await this.#db.query<Row>(`SELECT * FROM agent_runs WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, params);
    return rows.map(toRun);
  }

  async activeRuns(projectId: string): Promise<AgentRun[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM agent_runs WHERE project_id = ? AND status = 'running' ORDER BY id", [projectId]);
    return rows.map(toRun);
  }

  async countRuns(projectId: string): Promise<number> {
    const row = await this.#db.queryOne<Row>("SELECT COUNT(*) AS c FROM agent_runs WHERE project_id = ?", [projectId]);
    return row ? num(row, "c") : 0;
  }

  /* ---------- Critique findings ---------- */

  async addFindings(findings: readonly CritiqueFinding[]): Promise<void> {
    for (const finding of findings) {
      await this.#db.execute(
        `INSERT INTO critique_findings (id, project_id, kind, status, target_type, target_id, description,
          resolution_criteria, severity, raised_by_run_id, resolved_by_run_id, resolution, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [finding.id, finding.projectId, finding.kind, finding.status, finding.targetType, finding.targetId,
         finding.description, finding.resolutionCriteria, finding.severity, finding.raisedByRunId,
         finding.resolvedByRunId, finding.resolution, finding.createdAt, finding.updatedAt],
      );
    }
  }

  async listFindings(projectId: string, options: { status?: string; targetId?: string; limit?: number } = {}): Promise<CritiqueFinding[]> {
    const conditions = ["project_id = ?"];
    const params: (string | number)[] = [projectId];
    if (options.status) { conditions.push("status = ?"); params.push(options.status); }
    if (options.targetId) { conditions.push("target_id = ?"); params.push(options.targetId); }
    params.push(options.limit ?? 500);
    const rows = await this.#db.query<Row>(`SELECT * FROM critique_findings WHERE ${conditions.join(" AND ")} ORDER BY severity DESC, id LIMIT ?`, params);
    return rows.map(toFinding);
  }

  async resolveFinding(id: string, status: string, resolution: string | null, runId: string | null, updatedAt: string): Promise<void> {
    await this.#db.execute(
      "UPDATE critique_findings SET status = ?, resolution = ?, resolved_by_run_id = ?, updated_at = ? WHERE id = ?",
      [status, resolution, runId, updatedAt, id],
    );
  }

  /* ---------- Failure memory ---------- */

  async addFailure(failure: FailureRecord): Promise<void> {
    await this.#db.execute(
      `INSERT INTO failure_records (id, project_id, kind, approach, reason, lesson, context, transferable,
        recorded_by_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [failure.id, failure.projectId, failure.kind, failure.approach, failure.reason, failure.lesson,
       toJson(failure.context), failure.transferable, failure.recordedByRunId, failure.createdAt],
    );
  }

  async listFailures(projectId: string): Promise<FailureRecord[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM failure_records WHERE project_id = ? ORDER BY id DESC", [projectId]);
    return rows.map(toFailure);
  }

  /**
   * Failures marked transferable, from *other* projects in the same tenant.
   *
   * This is the mechanism behind "we already tried this and it failed because
   * X" — a new run reads the accumulated dead ends before planning.
   *
   * The tenant join is load-bearing, not decoration. Without it a failure
   * recorded by one customer would be read by another's research run, which
   * leaks what they were investigating and what did not work for them. A dead
   * end is often a statement about a private dataset or an internal system.
   *
   * `tenantId` is resolved from the excluding project rather than passed in, so
   * a caller cannot widen the scope by omitting it.
   */
  async transferableFailures(excludeProjectId: string, limit = 50): Promise<FailureRecord[]> {
    const rows = await this.#db.query<Row>(
      `SELECT f.* FROM failure_records f
       JOIN projects p ON p.id = f.project_id
       WHERE f.transferable = ${this.#db.dialect.booleanLiteral(true)}
         AND f.project_id <> ?
         AND (
           p.tenant_id IS NOT DISTINCT FROM (SELECT tenant_id FROM projects WHERE id = ?)
         )
       ORDER BY f.id DESC LIMIT ?`,
      [excludeProjectId, excludeProjectId, limit],
    );
    return rows.map(toFailure);
  }

  /**
   * Whether an equivalent failure is already recorded for this project.
   *
   * Failure memory is written at the end of every cycle, and a run that hits the
   * same wall three times would otherwise record it three times — after which
   * the planner reads the same lesson repeatedly and the genuinely distinct dead
   * ends are crowded out of the limit.
   *
   * Equivalence is exact on `(kind, approach)` after normalisation. Fuzzy
   * matching would merge distinct failures that happen to be worded alike, which
   * is the worse error: a lost dead end is repeated work, a merged one is
   * misleading advice.
   */
  async hasSimilarFailure(projectId: string, kind: string, approach: string): Promise<boolean> {
    const row = await this.#db.queryOne<Row>(
      "SELECT COUNT(*) AS c FROM failure_records WHERE project_id = ? AND kind = ? AND LOWER(TRIM(approach)) = ?",
      [projectId, kind, approach.trim().toLowerCase()],
    );
    return row ? num(row, "c") > 0 : false;
  }

  /* ---------- Verification ---------- */

  async addVerificationChecks(checks: readonly VerificationCheck[]): Promise<void> {
    for (const check of checks) {
      await this.#db.execute(
        `INSERT INTO verification_checks (id, project_id, check_type, target_type, target_id, outcome, detail,
          weight, verifier_provider, verified_by_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [check.id, check.projectId, check.checkType, check.targetType, check.targetId, check.outcome,
         check.detail, check.weight, check.verifierProvider, check.verifiedByRunId, check.createdAt],
      );
    }
  }

  async verificationSummary(targetType: string, targetId: string): Promise<VerificationSummary> {
    const rows = await this.#db.query<Row>(
      "SELECT outcome, check_type FROM verification_checks WHERE target_type = ? AND target_id = ?",
      [targetType, targetId],
    );
    const passed = rows.filter((row) => str(row, "outcome") === "passed").length;
    const failed = rows.filter((row) => str(row, "outcome") === "failed").length;
    const inconclusive = rows.filter((row) => str(row, "outcome") === "inconclusive").length;
    const decisive = passed + failed;
    return {
      targetType, targetId,
      total: rows.length, passed, failed, inconclusive,
      // Inconclusive checks are excluded from the rate rather than counted as
      // failures: "we could not tell" is not the same as "it is wrong".
      passRate: decisive === 0 ? null : passed / decisive,
      failedCheckTypes: [...new Set(rows.filter((row) => str(row, "outcome") === "failed").map((row) => str(row, "check_type")))],
    } as VerificationSummary;
  }

  async listVerificationChecks(projectId: string, limit = 500): Promise<VerificationCheck[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM verification_checks WHERE project_id = ? ORDER BY id DESC LIMIT ?", [projectId, limit]);
    return rows.map((row) => asEntity<VerificationCheck>({
      id: str(row, "id"), projectId: str(row, "project_id"), checkType: str(row, "check_type"),
      targetType: str(row, "target_type"), targetId: str(row, "target_id"), outcome: str(row, "outcome"),
      detail: str(row, "detail"), weight: num(row, "weight"), verifierProvider: strOrNull(row, "verifier_provider"),
      verifiedByRunId: strOrNull(row, "verified_by_run_id"), createdAt: str(row, "created_at"),
    }));
  }

  /* ---------- Debates ---------- */

  async saveDebate(debate: Debate): Promise<void> {
    const conflict = this.#db.dialect.upsert(["id"], ["status", "rounds", "turns", "verdict", "updated_at"]);
    await this.#db.execute(
      `INSERT INTO debates (id, project_id, subject_type, subject_id, topic, status, rounds, max_rounds,
        turns, verdict, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
      [debate.id, debate.projectId, debate.subjectType, debate.subjectId, debate.topic, debate.status,
       debate.rounds, debate.maxRounds, toJson(debate.turns), toJson(debate.verdict),
       debate.createdAt, debate.updatedAt],
    );
  }

  async listDebates(projectId: string, subjectId?: string): Promise<Debate[]> {
    const conditions = ["project_id = ?"];
    const params: string[] = [projectId];
    if (subjectId) { conditions.push("subject_id = ?"); params.push(subjectId); }
    const rows = await this.#db.query<Row>(`SELECT * FROM debates WHERE ${conditions.join(" AND ")} ORDER BY id DESC`, params);
    return rows.map((row) => asEntity<Debate>({
      id: str(row, "id"), projectId: str(row, "project_id"), subjectType: str(row, "subject_type"),
      subjectId: str(row, "subject_id"), topic: str(row, "topic"), status: str(row, "status"),
      rounds: num(row, "rounds"), maxRounds: num(row, "max_rounds"), turns: json(row, "turns", []),
      verdict: jsonOrNull(row, "verdict"), createdAt: str(row, "created_at"), updatedAt: str(row, "updated_at"),
    }));
  }

  /* ---------- Model and tool call ledgers ---------- */

  async recordModelCall(record: {
    id: string; projectId: string | null; agentRunId: string | null; provider: string; model: string;
    taskKind: string | null; inputTokens: number; outputTokens: number; cachedInputTokens: number;
    costUsd: number; latencyMs: number; stopReason: string | null; succeeded: boolean;
    errorMessage: string | null; traceId: string | null; createdAt: string;
  }): Promise<void> {
    await this.#db.execute(
      `INSERT INTO model_calls (id, project_id, agent_run_id, provider, model, task_kind, input_tokens,
        output_tokens, cached_input_tokens, cost_usd, latency_ms, stop_reason, succeeded, error_message,
        trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.projectId, record.agentRunId, record.provider, record.model, record.taskKind,
       record.inputTokens, record.outputTokens, record.cachedInputTokens, record.costUsd, record.latencyMs,
       record.stopReason, record.succeeded, record.errorMessage, record.traceId, record.createdAt],
    );
  }

  async recordToolCall(record: {
    id: string; projectId: string | null; agentRunId: string | null; toolId: string; capability: string;
    input: unknown; output: unknown; status: string; errorMessage: string | null; durationMs: number;
    executorId: string | null; traceId: string | null; createdAt: string;
  }): Promise<void> {
    await this.#db.execute(
      `INSERT INTO tool_calls (id, project_id, agent_run_id, tool_id, capability, input, output, status,
        error_message, duration_ms, executor_id, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.projectId, record.agentRunId, record.toolId, record.capability, toJson(record.input),
       toJson(record.output), record.status, record.errorMessage, record.durationMs, record.executorId,
       record.traceId, record.createdAt],
    );
  }

  /** Spend so far. Read before every model call to enforce the budget. */
  async usageTotals(projectId: string): Promise<{ modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    const model = await this.#db.queryOne<Row>(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(cost_usd), 0) AS cost FROM model_calls WHERE project_id = ?`,
      [projectId],
    );
    const tool = await this.#db.queryOne<Row>("SELECT COUNT(*) AS calls FROM tool_calls WHERE project_id = ?", [projectId]);
    return {
      modelCalls: model ? num(model, "calls") : 0,
      toolCalls: tool ? num(tool, "calls") : 0,
      inputTokens: model ? Math.round(num(model, "input")) : 0,
      outputTokens: model ? Math.round(num(model, "output")) : 0,
      costUsd: model ? num(model, "cost") : 0,
    };
  }

  async recordAudit(entry: {
    id: string; tenantId: string | null; application: string | null; actor: string; action: string;
    resourceType: string; resourceId: string | null; allowed: boolean; reason: string | null;
    details: unknown; createdAt: string;
  }): Promise<void> {
    await this.#db.execute(
      `INSERT INTO audit_log (id, tenant_id, application, actor, action, resource_type, resource_id, allowed,
        reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.tenantId, entry.application, entry.actor, entry.action, entry.resourceType,
       entry.resourceId, entry.allowed, entry.reason, toJson(entry.details), entry.createdAt],
    );
  }
}

function toRun(row: Row): AgentRun {
  return asEntity<AgentRun>({
    id: str(row, "id"), projectId: str(row, "project_id"), taskId: strOrNull(row, "task_id"),
    role: str(row, "role"), status: str(row, "status"), model: strOrNull(row, "model"),
    provider: strOrNull(row, "provider"), input: json(row, "input", null), output: jsonOrNull(row, "output"),
    usage: json(row, "usage", {}), traceId: strOrNull(row, "trace_id"), errorCode: strOrNull(row, "error_code"),
    errorMessage: strOrNull(row, "error_message"), startedAt: str(row, "started_at"),
    finishedAt: strOrNull(row, "finished_at"), durationMs: numOrNull(row, "duration_ms"),
  });
}

function toFinding(row: Row): CritiqueFinding {
  return asEntity<CritiqueFinding>({
    id: str(row, "id"), projectId: str(row, "project_id"), kind: str(row, "kind"), status: str(row, "status"),
    targetType: str(row, "target_type"), targetId: str(row, "target_id"), description: str(row, "description"),
    resolutionCriteria: strOrNull(row, "resolution_criteria"), severity: num(row, "severity"),
    raisedByRunId: strOrNull(row, "raised_by_run_id"), resolvedByRunId: strOrNull(row, "resolved_by_run_id"),
    resolution: strOrNull(row, "resolution"), createdAt: str(row, "created_at"), updatedAt: str(row, "updated_at"),
  });
}

function toFailure(row: Row): FailureRecord {
  return asEntity<FailureRecord>({
    id: str(row, "id"), projectId: str(row, "project_id"), kind: str(row, "kind"), approach: str(row, "approach"),
    reason: str(row, "reason"), lesson: strOrNull(row, "lesson"), context: json(row, "context", {}),
    transferable: bool(row, "transferable"), recordedByRunId: strOrNull(row, "recorded_by_run_id"),
    createdAt: str(row, "created_at"),
  });
}

export { toRun, toFinding, toFailure };
