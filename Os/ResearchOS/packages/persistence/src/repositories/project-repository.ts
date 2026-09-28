/**
 * Projects and the research question tree.
 *
 * Repositories own their SQL. There is no query builder and no ORM: the schema
 * is small enough to read, the queries are the interesting part, and hand-written
 * SQL is what makes the two-dialect story tractable.
 */
import type {
  Hypothesis,
  Objective,
  ProjectProgress,
  ProjectStatus,
  ResearchPlan,
  ResearchProject,
  ResearchQuestion,
} from "@research-os/contracts";
import type { Database } from "../database.ts";
import { asEntity, bool, json, num, numOrNull, str, strOrNull, toJson, type Row } from "../row.ts";

function toProject(row: Row): ResearchProject {
  return asEntity<ResearchProject>({
    id: str(row, "id"),
    tenantId: strOrNull(row, "tenant_id"),
    createdBy: json(row, "created_by", null),
    title: str(row, "title"),
    description: strOrNull(row, "description"),
    originalQuestion: str(row, "original_question"),
    status: str(row, "status") as ProjectStatus,
    preferences: json(row, "preferences", {}),
    budget: json(row, "budget", {}),
    failureReason: strOrNull(row, "failure_reason"),
    metadata: json(row, "metadata", {}),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    completedAt: strOrNull(row, "completed_at"),
  });
}

function toQuestion(row: Row): ResearchQuestion {
  return asEntity<ResearchQuestion>({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    parentQuestionId: strOrNull(row, "parent_question_id"),
    text: str(row, "text"),
    kind: str(row, "kind"),
    status: str(row, "status"),
    rationale: strOrNull(row, "rationale") ?? undefined,
    priority: num(row, "priority"),
    answerSummary: strOrNull(row, "answer_summary") ?? undefined,
    answerClaimIds: json(row, "answer_claim_ids", []),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  });
}

function toHypothesis(row: Row): Hypothesis {
  return asEntity<Hypothesis>({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    questionId: strOrNull(row, "question_id"),
    statement: str(row, "statement"),
    rationale: strOrNull(row, "rationale") ?? undefined,
    status: str(row, "status"),
    falsificationCriteria: strOrNull(row, "falsification_criteria") ?? undefined,
    priorConfidence: numOrNull(row, "prior_confidence"),
    posteriorConfidence: numOrNull(row, "posterior_confidence"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  });
}

export class ProjectRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async create(project: ResearchProject): Promise<ResearchProject> {
    await this.#db.execute(
      `INSERT INTO projects (id, tenant_id, created_by, title, description, original_question, status,
        preferences, budget, failure_reason, metadata, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        project.id, project.tenantId, toJson(project.createdBy), project.title, project.description,
        project.originalQuestion, project.status, toJson(project.preferences), toJson(project.budget),
        project.failureReason, toJson(project.metadata), project.createdAt, project.updatedAt, project.completedAt,
      ],
    );
    return project;
  }

  async findById(id: string): Promise<ResearchProject | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM projects WHERE id = ?", [id]);
    return row ? toProject(row) : undefined;
  }

  async list(options: { status?: ProjectStatus; application?: string; limit: number; cursor?: string }): Promise<ResearchProject[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    // IDs are time-sortable, so the cursor is just the last id seen.
    if (options.cursor) {
      conditions.push("id < ?");
      params.push(options.cursor);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(options.limit);
    const rows = await this.#db.query<Row>(`SELECT * FROM projects ${where} ORDER BY id DESC LIMIT ?`, params);
    const projects = rows.map(toProject);
    // `created_by` is a JSON blob rather than a column, so application filtering
    // happens here. Promote it to a column if this ever needs an index.
    return options.application
      ? projects.filter((project) => project.createdBy?.application === options.application)
      : projects;
  }

  async updateStatus(id: string, status: ProjectStatus, options: { failureReason?: string | null; completedAt?: string | null; updatedAt: string } ): Promise<void> {
    await this.#db.execute(
      `UPDATE projects SET status = ?, failure_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [status, options.failureReason ?? null, options.completedAt ?? null, options.updatedAt, id],
    );
  }

  async update(id: string, patch: Partial<Pick<ResearchProject, "title" | "description" | "preferences" | "budget" | "metadata">>, updatedAt: string): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
    if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
    if (patch.preferences !== undefined) { sets.push("preferences = ?"); params.push(toJson(patch.preferences)); }
    if (patch.budget !== undefined) { sets.push("budget = ?"); params.push(toJson(patch.budget)); }
    if (patch.metadata !== undefined) { sets.push("metadata = ?"); params.push(toJson(patch.metadata)); }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(updatedAt, id);
    await this.#db.execute(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  async delete(id: string): Promise<void> {
    await this.#db.execute("DELETE FROM projects WHERE id = ?", [id]);
  }

  /* ---------- Objectives ---------- */

  async addObjectives(objectives: readonly Objective[]): Promise<void> {
    for (const objective of objectives) {
      await this.#db.execute(
        `INSERT INTO objectives (id, project_id, statement, rationale, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [objective.id, objective.projectId, objective.statement, objective.rationale ?? null, objective.position, objective.createdAt],
      );
    }
  }

  async listObjectives(projectId: string): Promise<Objective[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM objectives WHERE project_id = ? ORDER BY position", [projectId]);
    return rows.map((row) => ({
      id: str(row, "id"),
      projectId: str(row, "project_id"),
      statement: str(row, "statement"),
      rationale: strOrNull(row, "rationale") ?? undefined,
      position: num(row, "position"),
      createdAt: str(row, "created_at"),
    })).map((value) => asEntity<Objective>(value));
  }

  /* ---------- Questions ---------- */

  async addQuestions(questions: readonly ResearchQuestion[]): Promise<void> {
    for (const question of questions) {
      await this.#db.execute(
        `INSERT INTO research_questions (id, project_id, parent_question_id, text, kind, status, rationale,
          priority, answer_summary, answer_claim_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          question.id, question.projectId, question.parentQuestionId, question.text, question.kind, question.status,
          question.rationale ?? null, question.priority, question.answerSummary ?? null,
          toJson(question.answerClaimIds), question.createdAt, question.updatedAt,
        ],
      );
    }
  }

  async listQuestions(projectId: string): Promise<ResearchQuestion[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM research_questions WHERE project_id = ? ORDER BY priority DESC, id", [projectId]);
    return rows.map(toQuestion);
  }

  async findQuestion(id: string): Promise<ResearchQuestion | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM research_questions WHERE id = ?", [id]);
    return row ? toQuestion(row) : undefined;
  }

  async updateQuestion(id: string, patch: { status?: string; answerSummary?: string | null; answerClaimIds?: readonly string[] }, updatedAt: string): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.answerSummary !== undefined) { sets.push("answer_summary = ?"); params.push(patch.answerSummary); }
    if (patch.answerClaimIds !== undefined) { sets.push("answer_claim_ids = ?"); params.push(toJson(patch.answerClaimIds)); }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(updatedAt, id);
    await this.#db.execute(`UPDATE research_questions SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  /* ---------- Hypotheses ---------- */

  async addHypotheses(hypotheses: readonly Hypothesis[]): Promise<void> {
    for (const hypothesis of hypotheses) {
      await this.#db.execute(
        `INSERT INTO hypotheses (id, project_id, question_id, statement, rationale, status,
          falsification_criteria, prior_confidence, posterior_confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hypothesis.id, hypothesis.projectId, hypothesis.questionId, hypothesis.statement, hypothesis.rationale ?? null,
          hypothesis.status, hypothesis.falsificationCriteria ?? null, hypothesis.priorConfidence,
          hypothesis.posteriorConfidence, hypothesis.createdAt, hypothesis.updatedAt,
        ],
      );
    }
  }

  async listHypotheses(projectId: string): Promise<Hypothesis[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM hypotheses WHERE project_id = ? ORDER BY id", [projectId]);
    return rows.map(toHypothesis);
  }

  async updateHypothesis(id: string, patch: { status?: string; posteriorConfidence?: number | null }, updatedAt: string): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.posteriorConfidence !== undefined) { sets.push("posterior_confidence = ?"); params.push(patch.posteriorConfidence); }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(updatedAt, id);
    await this.#db.execute(`UPDATE hypotheses SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  /* ---------- Plans ---------- */

  async savePlan(plan: ResearchPlan): Promise<void> {
    await this.#db.execute(
      `INSERT INTO research_plans (project_id, version, summary, strategy, steps, created_by_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [plan.projectId, plan.version, plan.summary, plan.strategy, toJson(plan.steps), plan.createdByRunId, plan.createdAt],
    );
  }

  async latestPlan(projectId: string): Promise<ResearchPlan | undefined> {
    const row = await this.#db.queryOne<Row>(
      "SELECT * FROM research_plans WHERE project_id = ? ORDER BY version DESC LIMIT 1",
      [projectId],
    );
    if (!row) return undefined;
    return asEntity<ResearchPlan>({
      projectId: str(row, "project_id"),
      version: num(row, "version"),
      summary: str(row, "summary"),
      strategy: str(row, "strategy"),
      steps: json(row, "steps", []),
      createdByRunId: strOrNull(row, "created_by_run_id"),
      createdAt: str(row, "created_at"),
    });
  }

  async nextPlanVersion(projectId: string): Promise<number> {
    const row = await this.#db.queryOne<Row>("SELECT MAX(version) AS v FROM research_plans WHERE project_id = ?", [projectId]);
    return (numOrNull(row ?? {}, "v") ?? 0) + 1;
  }

  /**
   * Aggregate counts for the status endpoint.
   *
   * One query per metric rather than a single wide join: the joins would
   * multiply rows across independent one-to-many relationships and produce
   * inflated counts, which is a classic and very quiet bug.
   */
  async progress(projectId: string, startedAt: string, now: number): Promise<ProjectProgress> {
    const count = async (sql: string, params: (string | number)[] = [projectId]): Promise<number> => {
      const row = await this.#db.queryOne<Row>(sql, params);
      return row ? num(row, "c") : 0;
    };
    const [
      tasksTotal, tasksCompleted, tasksFailed, tasksRunning,
      sourcesDiscovered, sourcesProcessed, evidenceCount, claimsCount,
      contradictionsOpen, experimentsCompleted,
    ] = await Promise.all([
      count("SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?"),
      count("SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND status = 'completed'"),
      count("SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND status = 'failed'"),
      count("SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND status = 'running'"),
      count("SELECT COUNT(*) AS c FROM sources WHERE project_id = ?"),
      count("SELECT COUNT(*) AS c FROM sources WHERE project_id = ? AND status = 'indexed'"),
      count("SELECT COUNT(*) AS c FROM evidence WHERE project_id = ?"),
      count("SELECT COUNT(*) AS c FROM claims WHERE project_id = ?"),
      count("SELECT COUNT(*) AS c FROM contradictions WHERE project_id = ? AND status = 'open'"),
      count("SELECT COUNT(*) AS c FROM experiment_runs WHERE project_id = ? AND status = 'succeeded'"),
    ]);

    const usage = await this.#db.queryOne<Row>(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost
       FROM model_calls WHERE project_id = ?`,
      [projectId],
    );

    return {
      tasksTotal, tasksCompleted, tasksFailed, tasksRunning,
      sourcesDiscovered, sourcesProcessed, evidenceCount, claimsCount,
      contradictionsOpen, experimentsCompleted,
      tokensUsed: usage ? Math.round(num(usage, "tokens")) : 0,
      costUsd: usage ? num(usage, "cost") : 0,
      elapsedMs: Math.max(0, now - Date.parse(startedAt)),
    };
  }
}

export { toProject, toQuestion, toHypothesis, bool };
