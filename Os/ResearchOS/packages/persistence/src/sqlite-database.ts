/**
 * SQLite adapter, backed by Node's built-in `node:sqlite`.
 *
 * This exists so that ResearchOS runs locally with no infrastructure at all —
 * no Docker, no database server, no native module to compile. `node:sqlite`
 * ships with Node, so `npm install && npm run dev` is genuinely the whole
 * setup. That matters more than it sounds: a platform that is awkward to run
 * locally gets tested less.
 *
 * The driver is synchronous; the port is async. Wrapping sync calls in promises
 * is correct here rather than wasteful — SQLite operations are microseconds,
 * and it keeps one interface across both engines.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { err } from "@research-os/shared";
import type { Database, SqlParameter } from "./database.ts";
import { sqliteDialect, type SqlDialect } from "./dialect.ts";

export interface SqliteOptions {
  /** File path, or ":memory:" for an ephemeral database. */
  readonly file: string;
}

export class SqliteDatabase implements Database {
  readonly dialect: SqlDialect = sqliteDialect;
  readonly #db: DatabaseSync;
  #inTransaction = false;

  constructor(options: SqliteOptions) {
    if (options.file !== ":memory:") {
      mkdirSync(dirname(options.file), { recursive: true });
    }
    this.#db = new DatabaseSync(options.file);
    // WAL lets readers proceed during a write, which matters once the API and a
    // worker share one file. Foreign keys are off by default in SQLite and are
    // required for the schema's cascade behaviour to mean anything.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
  }

  async query<T = Record<string, unknown>>(sql: string, params: readonly SqlParameter[] = []): Promise<T[]> {
    try {
      const statement = this.#db.prepare(sql);
      return statement.all(...normalise(params)) as T[];
    } catch (error) {
      throw err.persistence(`SQLite query failed: ${describe(error)}\nSQL: ${sql}`, error);
    }
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: readonly SqlParameter[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async execute(sql: string, params: readonly SqlParameter[] = []): Promise<number> {
    try {
      const statement = this.#db.prepare(sql);
      const result = statement.run(...normalise(params));
      return Number(result.changes);
    } catch (error) {
      throw err.persistence(`SQLite execute failed: ${describe(error)}\nSQL: ${sql}`, error);
    }
  }

  async executeScript(sql: string): Promise<void> {
    try {
      this.#db.exec(sql);
    } catch (error) {
      throw err.persistence(`SQLite script failed: ${describe(error)}`, error);
    }
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    // Joining an in-flight transaction rather than nesting keeps repository
    // methods composable: each can open a transaction without callers having to
    // know whether one is already open.
    if (this.#inTransaction) return fn(this);

    this.#inTransaction = true;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // A rollback failure must not mask the original error, which is the
        // one that explains what actually went wrong.
      }
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.query("SELECT 1 AS ok");
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  }
}

/** `node:sqlite` accepts null but not undefined, and stores booleans as integers. */
function normalise(params: readonly SqlParameter[]): (string | number | null)[] {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
