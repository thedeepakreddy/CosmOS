/**
 * Row mapping helpers.
 *
 * Both drivers return loosely-typed rows, and they differ on two points that
 * would otherwise leak into every repository: SQLite has no boolean type (0/1)
 * and stores JSON as text, while Postgres returns `jsonb` already parsed and
 * numerics sometimes as strings. These helpers normalise both to the same
 * JavaScript values so repositories can be written once.
 */
import { err } from "@research-os/shared";

export type Row = Record<string, unknown>;

export function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === "string") return value;
  if (value === null || value === undefined) {
    throw err.persistence(`Expected column "${column}" to be a string, got ${value === null ? "null" : "undefined"}`);
  }
  return String(value);
}

export function strOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return String(value);
}

export function num(row: Row, column: string): number {
  const value = row[column];
  // Postgres returns BIGINT as a string to avoid precision loss.
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw err.persistence(`Expected column "${column}" to be a number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function numOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(parsed) ? parsed : null;
}

export function bool(row: Row, column: string): boolean {
  const value = row[column];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "t" || value === "true" || value === "1";
  return false;
}

export function boolOrNull(row: Row, column: string): boolean | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return bool(row, column);
}

/** Parses a JSON column from either engine, falling back rather than throwing. */
export function json<T>(row: Row, column: string, fallback: T): T {
  const value = row[column];
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function jsonOrNull<T>(row: Row, column: string): T | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/** Serialises a value for a JSON column. Both engines take a JSON string. */
export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Builds an INSERT with the right number of placeholders. */
export function insertSql(table: string, columns: readonly string[], conflictClause = ""): string {
  const placeholders = columns.map(() => "?").join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ${conflictClause}`.trim();
}

/**
 * Casts a row-mapped plain object to its branded contract type.
 *
 * Contract types carry branded IDs (`Id<"claim">`), which a plain `as` cast
 * cannot reach from `string`. Values were validated against the schema on the
 * way in, and re-parsing every row through zod on the way out would double the
 * cost of every query without adding safety — the database is not an untrusted
 * input. This function marks each place that trade is being made, so the casts
 * are greppable rather than invisible.
 */
export function asEntity<T>(value: Record<string, unknown>): T {
  return value as unknown as T;
}
