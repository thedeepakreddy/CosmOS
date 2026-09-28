/**
 * SQL dialect abstraction.
 *
 * ResearchOS targets PostgreSQL in production and SQLite for local development,
 * and both are driven from one set of migrations. Only the parts that genuinely
 * differ are abstracted — column types, placeholder syntax, upsert and row
 * locking. Everything else is plain SQL that both engines accept, which keeps
 * the schema readable instead of hiding it behind a query builder.
 *
 * Two conventions keep the surface small:
 *
 *   - **Timestamps are ISO-8601 UTC strings, not native date types.** They sort
 *     lexicographically, they are already the wire format, and they come back
 *     from both drivers as the same JavaScript type. Native `timestamptz` would
 *     index marginally better but would have `pg` returning `Date` and SQLite
 *     returning `string` from the same query, which is a bug factory.
 *   - **JSON columns are written and read explicitly by repositories.** No
 *     driver-level magic, so behaviour is identical on both engines.
 */

export type DialectName = "postgres" | "sqlite";

export interface SqlDialect {
  readonly name: DialectName;

  /* Column types */
  readonly id: string;
  readonly text: string;
  readonly json: string;
  readonly timestamp: string;
  readonly boolean: string;
  readonly integer: string;
  readonly real: string;

  /** Rewrites `?` placeholders into the engine's own syntax. */
  placeholders(sql: string): string;
  /** Literal for a boolean value in DDL defaults. */
  booleanLiteral(value: boolean): string;
  /** `ON CONFLICT` clause for an idempotent insert. */
  upsert(conflictColumns: readonly string[], updateColumns: readonly string[]): string;
  /** Row-level lock that skips already-claimed rows, where supported. */
  readonly skipLocked: string;
  readonly supportsSkipLocked: boolean;
  /** Native vector similarity search, when the engine provides it. */
  readonly supportsVectorSearch: boolean;
}

export const postgresDialect: SqlDialect = {
  name: "postgres",
  id: "TEXT",
  text: "TEXT",
  json: "JSONB",
  timestamp: "TEXT",
  boolean: "BOOLEAN",
  integer: "BIGINT",
  real: "DOUBLE PRECISION",
  placeholders(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  },
  booleanLiteral: (value) => (value ? "TRUE" : "FALSE"),
  upsert: (conflictColumns, updateColumns) =>
    updateColumns.length === 0
      ? `ON CONFLICT (${conflictColumns.join(", ")}) DO NOTHING`
      : `ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${updateColumns.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`,
  skipLocked: "FOR UPDATE SKIP LOCKED",
  supportsSkipLocked: true,
  // pgvector would set this; the default Postgres build does not have it, and
  // retrieval falls back to in-process similarity over a candidate set.
  supportsVectorSearch: false,
};

export const sqliteDialect: SqlDialect = {
  name: "sqlite",
  id: "TEXT",
  text: "TEXT",
  json: "TEXT",
  timestamp: "TEXT",
  boolean: "INTEGER",
  integer: "INTEGER",
  real: "REAL",
  placeholders: (sql) => sql,
  booleanLiteral: (value) => (value ? "1" : "0"),
  upsert: (conflictColumns, updateColumns) =>
    updateColumns.length === 0
      ? `ON CONFLICT (${conflictColumns.join(", ")}) DO NOTHING`
      : `ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${updateColumns.map((c) => `${c} = excluded.${c}`).join(", ")}`,
  // SQLite serialises writers, so a leasing UPDATE is already exclusive.
  skipLocked: "",
  supportsSkipLocked: false,
  supportsVectorSearch: false,
};

export function dialectFor(name: DialectName): SqlDialect {
  return name === "postgres" ? postgresDialect : sqliteDialect;
}
