/**
 * Choosing a database from the environment.
 *
 * This lives in `persistence` rather than in each application because both the
 * API, the worker and the migration CLI have to make exactly the same choice —
 * and three copies of "which driver, which connection string" is three chances
 * to configure two processes to talk to different databases without noticing.
 *
 * The driver is inferred from `RESEARCH_OS_DATABASE_URL` rather than configured
 * separately, so it is impossible to point a `postgres://` URL at the SQLite
 * adapter. Absent a URL, the default is a SQLite file under `.data/` — the
 * project's stated goal is that `npm install && npm run dev` needs no
 * infrastructure at all.
 */
import { readNumber, readString, type EnvSource } from "@research-os/shared";
import type { Database } from "./database.ts";
import type { DialectName } from "./dialect.ts";
import { PostgresDatabase } from "./postgres-database.ts";
import { SqliteDatabase } from "./sqlite-database.ts";

export const DEFAULT_DATABASE_URL = "sqlite:.data/research-os.db";

export type DatabaseConfig =
  | { readonly driver: Extract<DialectName, "sqlite">; readonly file: string }
  | {
      readonly driver: Extract<DialectName, "postgres">;
      readonly connectionString: string;
      readonly maxConnections: number;
      readonly connectionTimeoutMs: number;
      readonly statementTimeoutMs: number;
    };

/**
 * Accepted forms:
 *   sqlite::memory:                  ephemeral, for tests
 *   sqlite:./.data/research-os.db    a file, relative or absolute
 *   postgres://user:pw@host/db       also postgresql://
 */
export function databaseConfigFromEnv(env: EnvSource = process.env): DatabaseConfig {
  const url = readString(env, "RESEARCH_OS_DATABASE_URL", DEFAULT_DATABASE_URL);

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return {
      driver: "postgres",
      connectionString: url,
      maxConnections: readNumber(env, "RESEARCH_OS_DATABASE_POOL_SIZE", 10),
      connectionTimeoutMs: readNumber(env, "RESEARCH_OS_DATABASE_CONNECT_TIMEOUT_MS", 10_000),
      statementTimeoutMs: readNumber(env, "RESEARCH_OS_DATABASE_STATEMENT_TIMEOUT_MS", 60_000),
    };
  }

  if (url.startsWith("sqlite:")) {
    return { driver: "sqlite", file: url.slice("sqlite:".length) || ":memory:" };
  }

  // A bare path is a common slip; accept it rather than failing on a technicality.
  return { driver: "sqlite", file: url };
}

/** Describes the target without exposing credentials. Safe to log at startup. */
export function describeDatabase(config: DatabaseConfig): string {
  if (config.driver === "sqlite") return `sqlite:${config.file}`;
  try {
    const parsed = new URL(config.connectionString);
    return `postgres://${parsed.host}${parsed.pathname}`;
  } catch {
    return "postgres://<unparseable url>";
  }
}

export async function createDatabase(config: DatabaseConfig): Promise<Database> {
  return config.driver === "postgres"
    ? PostgresDatabase.connect({
        connectionString: config.connectionString,
        maxConnections: config.maxConnections,
        connectionTimeoutMs: config.connectionTimeoutMs,
        statementTimeoutMs: config.statementTimeoutMs,
      })
    : new SqliteDatabase({ file: config.file });
}

export function createDatabaseFromEnv(env: EnvSource = process.env): Promise<Database> {
  return createDatabase(databaseConfigFromEnv(env));
}
