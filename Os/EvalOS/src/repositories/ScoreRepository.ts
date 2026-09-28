import type { Database } from 'better-sqlite3';
import { EvaluationScore } from '../contracts/Evaluator';

export class ScoreRepository {
  constructor(private db: Database) {}

  create(executionId: string, runId: string, score: EvaluationScore): void {
    const stmt = this.db.prepare(`
      INSERT INTO scores (
        execution_id, run_id, metric, value_num, value_bool, value_str,
        unit, passed, evaluator_id, evaluator_version, evidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let num = null;
    let bool = null;
    let str = null;
    
    if (typeof score.value === 'number') num = score.value;
    else if (typeof score.value === 'boolean') bool = score.value ? 1 : 0;
    else str = score.value;

    stmt.run(
      executionId,
      runId,
      score.metric,
      num,
      bool,
      str,
      score.unit || null,
      score.passed === undefined ? null : (score.passed ? 1 : 0),
      score.evaluatorId,
      score.evaluatorVersion,
      score.evidence ? JSON.stringify(score.evidence) : null
    );
  }

  getByRunId(runId: string): (EvaluationScore & { executionId: string })[] {
    const rows = this.db.prepare('SELECT * FROM scores WHERE run_id = ?').all(runId) as any[];
    return rows.map(row => {
      let value: any;
      if (row.value_num !== null) value = row.value_num;
      else if (row.value_bool !== null) value = row.value_bool === 1;
      else value = row.value_str;

      return {
        executionId: row.execution_id,
        metric: row.metric,
        value,
        unit: row.unit,
        passed: row.passed !== null ? row.passed === 1 : undefined,
        evaluatorId: row.evaluator_id,
        evaluatorVersion: row.evaluator_version,
        evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
      };
    });
  }
}
