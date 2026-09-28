import type { Database } from 'better-sqlite3';
import { EvaluationSuite } from '../contracts/Domain';

export class SuiteRepository {
  constructor(private db: Database) {}

  create(suite: EvaluationSuite): void {
    const stmt = this.db.prepare(`
      INSERT INTO suites (id, name, version, description, case_ids)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      suite.id,
      suite.name,
      suite.version,
      suite.description || null,
      JSON.stringify(suite.caseIds)
    );
  }

  getById(id: string): EvaluationSuite | null {
    const row = this.db.prepare('SELECT * FROM suites WHERE id = ?').get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      caseIds: JSON.parse(row.case_ids),
    };
  }
}
