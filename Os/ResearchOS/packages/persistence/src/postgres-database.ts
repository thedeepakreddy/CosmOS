/**
 * PostgreSQL adapter.
 *
 * The production target. `pg` is imported lazily so that a local SQLite-only
 * setup never needs the driver present or a server running — importing the
 * package must not require Postgres to exist.
 */
import { err } from "@research-os/shared";
import type { Database, SqlParameter } from "./database.ts";
import { postgresDialect, type SqlDialect } from "./dialect.ts";

export interface PostgresOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

/** Structural types for the slice of `pg` used here, so the driver stays optional. */
interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}
interface PgClient {
  query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  release(): void;
}
interface PgPool {
  query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

interface PgTypes {
  getTypeParser(oid: number, format?: unknown): (value: string) => unknown;
}

/** `json` and `jsonb`. */
const JSON_OIDS = new Set([114, 3802]);

/**
 * Makes Postgres hand back JSON columns as raw text, exactly as SQLite does.
 *
 * By default the driver parses `json`/`jsonb` for you, which sounds helpful and
 * is the source of a genuinely nasty divergence: a JSON *object* comes back as
 * an object, but a JSON *string* comes back as a bare JavaScript string with the
 * quotes already stripped. Row mapping then cannot tell "JSON text that needs
 * parsing" (what SQLite gives) from "a string that was already parsed" (what
 * Postgres gives) — and `JSON.parse("a plain string")` throws, so the value
 * silently becomes the fallback. Every JSON column holding a scalar string read
 * back as null on Postgres and correctly on SQLite.
 *
 * Turning the parser off is the fix rather than a workaround: `row.ts` promises
 * that both engines normalise to the same JavaScript values, and it can only
 * keep that promise if both hand it the same thing. Nothing here queries inside
 * a JSON column in SQL, so the parsed form was buying nothing.
 */
function jsonAsTextTypeConfig(types: PgTypes): { getTypeParser(oid: number, format?: unknown): (value: string) => unknown } {
  const identity = (value: string): string => value;
  return {
    getTypeParser: (oid, format) => (JSON_OIDS.has(oid) ? identity : types.getTypeParser(oid, format)),
  };
}

export class PostgresDatabase implements Database {
  readonly dialect: SqlDialect = postgresDialect;
  readonly #pool: PgPool;
  /** Set when this instance is a transaction-scoped view over one client. */
  readonly #client: PgClient | null;

  private constructor(pool: PgPool, client: PgClient | null = null) {
    this.#pool = pool;
    this.#client = client;
  }

  static async connect(options: PostgresOptions): Promise<PostgresDatabase> {
    const pg = (await import("pg")) as unknown as {
      default?: { Pool: new (config: unknown) => PgPool; types?: PgTypes };
      Pool?: new (config: unknown) => PgPool;
      types?: PgTypes;
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw err.persistence("The `pg` package did not export a Pool constructor");
    const types = pg.types ?? pg.default?.types;
    if (!types) throw err.persistence("The `pg` package did not export its type parsers");

    const pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      statement_timeout: options.statementTimeoutMs ?? 60_000,
      types: jsonAsTextTypeConfig(types),
    });
    return new PostgresDatabase(pool);
  }

  get #executor(): { query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult> } {
    return this.#client ?? this.#pool;
  }

  async query<T = Record<string, unknown>>(sql: string, params: readonly SqlParameter[] = []): Promise<T[]> {
    try {
      const result = await this.#executor.query(this.dialect.placeholders(sql), params);
      return result.rows as T[];
    } catch (error) {
      throw err.persistence(`Postgres query failed: ${describe(error)}\nSQL: ${sql}`, error);
    }
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: readonly SqlParameter[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async execute(sql: string, params: readonly SqlParameter[] = []): Promise<number> {
    try {
      const result = await this.#executor.query(this.dialect.placeholders(sql), params);
      return result.rowCount ?? 0;
    } catch (error) {
      throw err.persistence(`Postgres execute failed: ${describe(error)}\nSQL: ${sql}`, error);
    }
  }

  async executeScript(sql: string): Promise<void> {
    try {
      await this.#executor.query(sql);
    } catch (error) {
      throw err.persistence(`Postgres script failed: ${describe(error)}`, error);
    }
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (this.#client) return fn(this); // Already inside a transaction.

    const client = await this.#pool.connect();
    const scoped = new PostgresDatabase(this.#pool, client);
    try {
      await client.query("BEGIN");
      const result = await fn(scoped);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.#client) return; // A transaction view does not own the pool.
    await this.#pool.end();
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
