import type { Database } from 'better-sqlite3';
import { CaseExecution, CaseExecutionStatus } from '../contracts/Domain';

export class CaseExecutionRepository {
  constructor(private db: Database) {}

  create(execution: CaseExecution): void {
    const stmt = this.db.prepare(`
      INSERT INTO case_executions (
        id, run_id, case_id, status, start_time, end_time, result, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      execution.id,
      execution.runId,
      execution.caseId,
      execution.status,
      execution.startTime ? execution.startTime.toISOString() : null,
      execution.endTime ? execution.endTime.toISOString() : null,
      execution.result ? JSON.stringify(execution.result) : null,
      execution.error ? JSON.stringify(execution.error) : null
    );
  }

  update(id: string, updates: Partial<CaseExecution>): void {
    const sets: string[] = [];
    const values: any[] = [];
    
    if (updates.status) { sets.push('status = ?'); values.push(updates.status); }
    if (updates.endTime) { sets.push('end_time = ?'); values.push(updates.endTime.toISOString()); }
    if (updates.result !== undefined) { sets.push('result = ?'); values.push(updates.result ? JSON.stringify(updates.result) : null); }
    if (updates.error !== undefined) { sets.push('error = ?'); values.push(updates.error ? JSON.stringify(updates.error) : null); }
    
    if (sets.length === 0) return;
    values.push(id);
    
    const sql = `UPDATE case_executions SET ${sets.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  }

  getByRunId(runId: string): CaseExecution[] {
    const rows = this.db.prepare('SELECT * FROM case_executions WHERE run_id = ?').all(runId) as any[];
    return rows.map(row => ({
      id: row.id,
      runId: row.run_id,
      caseId: row.case_id,
      status: row.status as CaseExecutionStatus,
      startTime: row.start_time ? new Date(row.start_time) : undefined,
      endTime: row.end_time ? new Date(row.end_time) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error ? JSON.parse(row.error) : undefined,
    }));
  }
}
