/**
 * A real PostgreSQL engine for tests, via PGlite (Postgres compiled to WASM).
 *
 * This exists so the Postgres code path is *verified* rather than assumed. The
 * dialect emits different DDL and different placeholder syntax for Postgres,
 * and without a real engine those differences would only be discovered in
 * production. PGlite runs the genuine Postgres query planner and parser in
 * process, so a statement that passes here is valid Postgres.
 *
 * Test-only: production uses `PostgresDatabase` against a real server.
 */
import { PGlite } from "@electric-sql/pglite";
import { postgresDialect, type Database, type SqlDialect, type SqlParameter } from "@research-os/persistence";
import { err } from "@research-os/shared";

export class PgliteDatabase implements Database {
  readonly dialect: SqlDialect = postgresDialect;
  readonly #pg: PGlite;
  #depth = 0;

  private constructor(pg: PGlite) {
    this.#pg = pg;
  }

  static async create(): Promise<PgliteDatabase> {
    return new PgliteDatabase(
      // JSON columns come back as raw text, matching both SQLite and the
      // production Postgres adapter. See `jsonAsTextTypeConfig` in
      // postgres-database.ts for why the default parser is the wrong behaviour
      // here — if this test engine parsed JSON and production did not, the
      // dual-engine suite would stop testing the thing it exists to test.
      await PGlite.create({ parsers: { 114: (value) => value, 3802: (value) => value } }),
    );
  }

  async query<T = Record<string, unknown>>(sql: string, params: readonly SqlParameter[] = []): Promise<T[]> {
    try {
      const result = await this.#pg.query(this.dialect.placeholders(sql), [...params]);
      return result.rows as T[];
    } catch (error) {
      throw err.persistence(`PGlite query failed: ${error instanceof Error ? error.message : String(error)}\nSQL: ${sql}`, error);
    }
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: readonly SqlParameter[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  async execute(sql: string, params: readonly SqlParameter[] = []): Promise<number> {
    try {
      const result = await this.#pg.query(this.dialect.placeholders(sql), [...params]);
      return result.affectedRows ?? 0;
    } catch (error) {
      throw err.persistence(`PGlite execute failed: ${error instanceof Error ? error.message : String(error)}\nSQL: ${sql}`, error);
    }
  }

  async executeScript(sql: string): Promise<void> {
    try {
      await this.#pg.exec(sql);
    } catch (error) {
      throw err.persistence(`PGlite script failed: ${error instanceof Error ? error.message : String(error)}\nSQL: ${sql.slice(0, 300)}`, error);
    }
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (this.#depth > 0) return fn(this);
    this.#depth++;
    await this.#pg.exec("BEGIN");
    try {
      const result = await fn(this);
      await this.#pg.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.#pg.exec("ROLLBACK");
      } catch {
        /* preserve the original error */
      }
      throw error;
    } finally {
      this.#depth--;
    }
  }

  async close(): Promise<void> {
    await this.#pg.close();
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.query("SELECT 1 AS ok");
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
