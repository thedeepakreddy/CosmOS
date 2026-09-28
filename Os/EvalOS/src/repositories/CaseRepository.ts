import type { Database } from 'better-sqlite3';
import { EvaluationCase } from '../contracts/Domain';

export class CaseRepository {
  constructor(private db: Database) {}

  create(evalCase: EvaluationCase): void {
    const stmt = this.db.prepare(`
      INSERT INTO evaluation_cases (
        id, suite_id, dataset_id, input, expected_behavior, 
        evaluators, metrics, tags, timeout_ms, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      evalCase.id,
      evalCase.suiteId,
      evalCase.datasetId || null,
      JSON.stringify(evalCase.input),
      evalCase.expectedBehavior ? JSON.stringify(evalCase.expectedBehavior) : null,
      JSON.stringify(evalCase.evaluators),
      JSON.stringify(evalCase.metrics),
      evalCase.tags ? JSON.stringify(evalCase.tags) : null,
      evalCase.timeoutMs || null,
      evalCase.metadata ? JSON.stringify(evalCase.metadata) : null
    );
  }

  getById(id: string): EvaluationCase | null {
    const row = this.db.prepare('SELECT * FROM evaluation_cases WHERE id = ?').get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      suiteId: row.suite_id,
      datasetId: row.dataset_id,
      input: JSON.parse(row.input),
      expectedBehavior: row.expected_behavior ? JSON.parse(row.expected_behavior) : undefined,
      evaluators: JSON.parse(row.evaluators),
      metrics: JSON.parse(row.metrics),
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      timeoutMs: row.timeout_ms,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  getBySuiteId(suiteId: string): EvaluationCase[] {
    const rows = this.db.prepare('SELECT * FROM evaluation_cases WHERE suite_id = ?').all(suiteId) as any[];
    return rows.map(row => ({
      id: row.id,
      suiteId: row.suite_id,
      datasetId: row.dataset_id,
      input: JSON.parse(row.input),
      expectedBehavior: row.expected_behavior ? JSON.parse(row.expected_behavior) : undefined,
      evaluators: JSON.parse(row.evaluators),
      metrics: JSON.parse(row.metrics),
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      timeoutMs: row.timeout_ms,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }
}
