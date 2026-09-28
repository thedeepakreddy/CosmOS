/**
 * Database port.
 *
 * Narrow on purpose: query, execute, transaction. Repositories own the SQL, so
 * swapping an engine never means rewriting query logic — and there is no query
 * builder to learn or to fight.
 */
import type { SqlDialect } from "./dialect.ts";

export type SqlParameter = string | number | boolean | null;

export interface Database {
  readonly dialect: SqlDialect;
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParameter[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: readonly SqlParameter[]): Promise<T | undefined>;
  execute(sql: string, params?: readonly SqlParameter[]): Promise<number>;
  /** Raw DDL/multi-statement execution. Migrations only. */
  executeScript(sql: string): Promise<void>;
  /**
   * Runs `fn` in a transaction, committing on return and rolling back on throw.
   * Nested calls join the outer transaction rather than opening a new one.
   */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

/** Converts a JS value into something both drivers accept. */
export function toParam(value: unknown): SqlParameter {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export function toParams(values: readonly unknown[]): SqlParameter[] {
  return values.map(toParam);
}
