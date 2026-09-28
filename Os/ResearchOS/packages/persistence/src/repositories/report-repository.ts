/**
 * Research reports.
 *
 * Reports are versioned and never overwritten: regenerating after new evidence
 * arrives produces version N+1, and the earlier version stays readable. A
 * report that silently changed under a reader who had already cited it would be
 * worse than no report.
 */
import type { ResearchReport } from "@research-os/contracts";
import type { Database } from "../database.ts";
import { jsonOrNull, num, str, strOrNull, toJson, type Row } from "../row.ts";

export class ReportRepository {
  readonly #db: Database;
  constructor(db: Database) { this.#db = db; }

  async save(report: ResearchReport): Promise<void> {
    await this.#db.execute(
      `INSERT INTO reports (id, project_id, version, title, body, overall_confidence, generated_by_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [report.id, report.projectId, report.version, report.title, toJson(report),
       report.overallConfidence, report.generatedByRunId, report.createdAt],
    );
  }

  async latest(projectId: string): Promise<ResearchReport | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM reports WHERE project_id = ? ORDER BY version DESC LIMIT 1", [projectId]);
    return row ? (jsonOrNull<ResearchReport>(row, "body") ?? undefined) : undefined;
  }

  async findVersion(projectId: string, version: number): Promise<ResearchReport | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM reports WHERE project_id = ? AND version = ?", [projectId, version]);
    return row ? (jsonOrNull<ResearchReport>(row, "body") ?? undefined) : undefined;
  }

  async nextVersion(projectId: string): Promise<number> {
    const row = await this.#db.queryOne<Row>("SELECT COALESCE(MAX(version), 0) AS v FROM reports WHERE project_id = ?", [projectId]);
    return (row ? num(row, "v") : 0) + 1;
  }

  async listVersions(projectId: string): Promise<{ version: number; createdAt: string; overallConfidence: number; generatedByRunId: string | null }[]> {
    const rows = await this.#db.query<Row>(
      "SELECT version, created_at, overall_confidence, generated_by_run_id FROM reports WHERE project_id = ? ORDER BY version DESC",
      [projectId],
    );
    return rows.map((row) => ({
      version: num(row, "version"),
      createdAt: str(row, "created_at"),
      overallConfidence: num(row, "overall_confidence"),
      generatedByRunId: strOrNull(row, "generated_by_run_id"),
    }));
  }
}
