/**
 * Experiments, runs and datasets.
 *
 * An experiment row stores enough to re-run it elsewhere: code, pinned
 * dependencies, environment, dataset versions and seed. Runs are append-only
 * and numbered, which is what makes replication countable rather than asserted.
 */
import type { Dataset, Experiment, ExperimentRun, ExperimentStatus, ReplicationSummary } from "@research-os/contracts";
import { round } from "@research-os/shared";
import type { Database } from "../database.ts";
import { asEntity, boolOrNull, json, num, numOrNull, str, strOrNull, toJson, type Row } from "../row.ts";

function toExperiment(row: Row): Experiment {
  return asEntity<Experiment>({
    id: str(row, "id"), projectId: str(row, "project_id"), hypothesisId: strOrNull(row, "hypothesis_id"),
    title: str(row, "title"), design: str(row, "design"), expectedOutcome: strOrNull(row, "expected_outcome"),
    falsificationCriteria: strOrNull(row, "falsification_criteria"), status: str(row, "status"),
    code: str(row, "code"), environment: json(row, "environment", {}), parameters: json(row, "parameters", {}),
    datasetIds: json(row, "dataset_ids", []), designedByRunId: strOrNull(row, "designed_by_run_id"),
    createdAt: str(row, "created_at"), updatedAt: str(row, "updated_at"),
  });
}

function toRun(row: Row): ExperimentRun {
  return asEntity<ExperimentRun>({
    id: str(row, "id"), projectId: str(row, "project_id"), experimentId: str(row, "experiment_id"),
    attempt: num(row, "attempt"), status: str(row, "status"), parameters: json(row, "parameters", {}),
    stdout: str(row, "stdout"), stderr: str(row, "stderr"), exitCode: numOrNull(row, "exit_code"),
    metrics: json(row, "metrics", {}), artifacts: json(row, "artifacts", []),
    durationMs: numOrNull(row, "duration_ms"), interpretation: strOrNull(row, "interpretation"),
    reproducedRunId: strOrNull(row, "reproduced_run_id"), reproductionMatched: boolOrNull(row, "reproduction_matched"),
    errorMessage: strOrNull(row, "error_message"), startedAt: strOrNull(row, "started_at"),
    finishedAt: strOrNull(row, "finished_at"), createdAt: str(row, "created_at"),
  });
}

export class ExperimentRepository {
  readonly #db: Database;
  constructor(db: Database) { this.#db = db; }

  async createExperiment(experiment: Experiment): Promise<void> {
    await this.#db.execute(
      `INSERT INTO experiments (id, project_id, hypothesis_id, title, design, expected_outcome,
        falsification_criteria, status, code, environment, parameters, dataset_ids, designed_by_run_id,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [experiment.id, experiment.projectId, experiment.hypothesisId, experiment.title, experiment.design,
       experiment.expectedOutcome, experiment.falsificationCriteria, experiment.status, experiment.code,
       toJson(experiment.environment), toJson(experiment.parameters), toJson(experiment.datasetIds),
       experiment.designedByRunId, experiment.createdAt, experiment.updatedAt],
    );
  }

  async findExperiment(id: string): Promise<Experiment | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM experiments WHERE id = ?", [id]);
    return row ? toExperiment(row) : undefined;
  }

  async listExperiments(projectId: string, limit = 100): Promise<Experiment[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM experiments WHERE project_id = ? ORDER BY id DESC LIMIT ?", [projectId, limit]);
    return rows.map(toExperiment);
  }

  async updateExperimentStatus(id: string, status: ExperimentStatus, updatedAt: string): Promise<void> {
    await this.#db.execute("UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?", [status, updatedAt, id]);
  }

  /**
   * Records a run, or updates one already recorded.
   *
   * An upsert because the interpretation arrives after the numbers do: the run
   * is stored the moment it finishes, and the analyst's reading of it is added
   * once there is something to read. Inserting twice would fail on the primary
   * key, and storing the interpretation only would lose the measurement.
   *
   * Only the fields that can legitimately change afterwards are updated. The
   * measurement itself — status, metrics, stdout, exit code — is immutable once
   * written, because a result that can be edited is not a record of what
   * happened.
   */
  async recordRun(run: ExperimentRun): Promise<void> {
    const conflict = this.#db.dialect.upsert(["id"], ["interpretation", "reproduced_run_id", "reproduction_matched"]);
    await this.#db.execute(
      `INSERT INTO experiment_runs (id, project_id, experiment_id, attempt, status, parameters, stdout, stderr,
        exit_code, metrics, artifacts, duration_ms, interpretation, reproduced_run_id, reproduction_matched,
        error_message, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
      [run.id, run.projectId, run.experimentId, run.attempt, run.status, toJson(run.parameters), run.stdout,
       run.stderr, run.exitCode, toJson(run.metrics), toJson(run.artifacts), run.durationMs, run.interpretation,
       run.reproducedRunId, run.reproductionMatched, run.errorMessage, run.startedAt, run.finishedAt, run.createdAt],
    );
  }

  async listRuns(experimentId: string): Promise<ExperimentRun[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY attempt", [experimentId]);
    return rows.map(toRun);
  }

  async nextAttempt(experimentId: string): Promise<number> {
    const row = await this.#db.queryOne<Row>("SELECT COALESCE(MAX(attempt), 0) AS a FROM experiment_runs WHERE experiment_id = ?", [experimentId]);
    return (row ? num(row, "a") : 0) + 1;
  }

  /**
   * Aggregates runs into a replication picture.
   *
   * Metric spread across runs is reported, not hidden: an experiment whose
   * headline number swings widely between identical runs has not really
   * replicated, even if every run "succeeded".
   */
  async replicationSummary(experimentId: string): Promise<ReplicationSummary> {
    const runs = await this.listRuns(experimentId);
    const successful = runs.filter((run) => run.status === "succeeded");
    const replications = runs.filter((run) => run.reproductionMatched === true).length;
    const failedReplications = runs.filter((run) => run.reproductionMatched === false).length;

    const metricVariance: Record<string, { mean: number; stdDev: number; min: number; max: number }> = {};
    const names = new Set(successful.flatMap((run) => Object.keys(run.metrics)));
    for (const name of names) {
      const values = successful.map((run) => run.metrics[name]).filter((value): value is number => typeof value === "number");
      if (values.length === 0) continue;
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      metricVariance[name] = {
        mean: round(mean, 6),
        stdDev: round(Math.sqrt(variance), 6),
        min: Math.min(...values),
        max: Math.max(...values),
      };
    }

    const attempted = replications + failedReplications;
    return {
      experimentId,
      totalRuns: runs.length,
      successfulRuns: successful.length,
      replications,
      failedReplications,
      metricVariance,
      // No replication attempted means unknown reproducibility, reported as 0
      // rather than as a pass. Absence of a failed replication is not evidence
      // that the result reproduces.
      reproducibilityScore: attempted === 0 ? 0 : round(replications / attempted),
    } as ReplicationSummary;
  }

  async addDataset(dataset: Dataset): Promise<void> {
    await this.#db.execute(
      `INSERT INTO datasets (id, project_id, name, description, version, uri, storage_key, row_count, schema,
        content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [dataset.id, dataset.projectId, dataset.name, dataset.description, dataset.version, dataset.uri,
       dataset.storageKey, dataset.rowCount, toJson(dataset.schema), dataset.contentHash, dataset.createdAt],
    );
  }

  async listDatasets(projectId: string): Promise<Dataset[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM datasets WHERE project_id = ? ORDER BY id", [projectId]);
    return rows.map((row) => asEntity<Dataset>({
      id: str(row, "id"), projectId: str(row, "project_id"), name: str(row, "name"),
      description: strOrNull(row, "description"), version: str(row, "version"), uri: strOrNull(row, "uri"),
      storageKey: strOrNull(row, "storage_key"), rowCount: numOrNull(row, "row_count"),
      schema: json(row, "schema", null), contentHash: strOrNull(row, "content_hash"), createdAt: str(row, "created_at"),
    }));
  }
}

export { toExperiment, toRun as toExperimentRun };
