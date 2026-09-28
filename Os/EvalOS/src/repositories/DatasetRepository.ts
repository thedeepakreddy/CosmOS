import type { Database } from 'better-sqlite3';
import { Dataset } from '../contracts/Domain';

export class DatasetRepository {
  constructor(private db: Database) {}

  create(dataset: Dataset): void {
    const stmt = this.db.prepare(`
      INSERT INTO datasets (id, version, hash, case_count, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      dataset.id,
      dataset.version,
      dataset.hash || null,
      dataset.caseCount,
      dataset.metadata ? JSON.stringify(dataset.metadata) : null
    );
  }

  getById(id: string): Dataset | null {
    const row = this.db.prepare('SELECT * FROM datasets WHERE id = ?').get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      version: row.version,
      hash: row.hash,
      caseCount: row.case_count,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}
