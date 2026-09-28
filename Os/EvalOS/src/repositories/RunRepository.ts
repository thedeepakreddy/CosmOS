import type { Database } from 'better-sqlite3';
import { EvaluationRun, RunStatus } from '../contracts/Domain';

export class RunRepository {
  constructor(private db: Database) {}

  create(run: EvaluationRun): void {
    const stmt = this.db.prepare(`
      INSERT INTO evaluation_runs (
        id, suite_id, suite_version, dataset_id, dataset_version,
        candidate_id, candidate_version, baseline_id, evaluator_versions,
        configuration, environment, status, start_time, end_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.id,
      run.suiteId,
      run.suiteVersion,
      run.datasetId || null,
      run.datasetVersion || null,
      run.candidateId,
      run.candidateVersion,
      run.baselineId || null,
      run.evaluatorVersions ? JSON.stringify(run.evaluatorVersions) : null,
      run.configuration ? JSON.stringify(run.configuration) : null,
      run.environment ? JSON.stringify(run.environment) : null,
      run.status,
      run.startTime ? run.startTime.toISOString() : null,
      run.endTime ? run.endTime.toISOString() : null
    );
  }

  updateStatus(id: string, status: RunStatus, endTime?: Date): void {
    if (endTime) {
      this.db.prepare('UPDATE evaluation_runs SET status = ?, end_time = ? WHERE id = ?')
        .run(status, endTime.toISOString(), id);
    } else {
      this.db.prepare('UPDATE evaluation_runs SET status = ? WHERE id = ?')
        .run(status, id);
    }
  }

  getById(id: string): EvaluationRun | null {
    const row = this.db.prepare('SELECT * FROM evaluation_runs WHERE id = ?').get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      suiteId: row.suite_id,
      suiteVersion: row.suite_version,
      datasetId: row.dataset_id,
      datasetVersion: row.dataset_version,
      candidateId: row.candidate_id,
      candidateVersion: row.candidate_version,
      baselineId: row.baseline_id,
      evaluatorVersions: row.evaluator_versions ? JSON.parse(row.evaluator_versions) : undefined,
      configuration: row.configuration ? JSON.parse(row.configuration) : undefined,
      environment: row.environment ? JSON.parse(row.environment) : undefined,
      status: row.status as RunStatus,
      startTime: row.start_time ? new Date(row.start_time) : undefined,
      endTime: row.end_time ? new Date(row.end_time) : undefined,
    };
  }
}
