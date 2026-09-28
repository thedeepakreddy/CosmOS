/**
 * Migration runner.
 *
 * Applies pending migrations in order, recording each in a ledger table so a
 * restart is a no-op. Each migration runs inside a transaction, so a failure
 * part-way leaves the schema at the last good state rather than half-applied.
 */
import type { Logger } from "@research-os/observability";
import { err } from "@research-os/shared";
import type { Database } from "./database.ts";
import { MIGRATIONS, type Migration } from "./migrations/index.ts";

const LEDGER_TABLE = "schema_migrations";

export interface MigrateResult {
  readonly applied: string[];
  readonly alreadyApplied: string[];
}

async function ensureLedger(db: Database): Promise<void> {
  await db.executeScript(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      id ${db.dialect.text} PRIMARY KEY,
      applied_at ${db.dialect.timestamp} NOT NULL,
      statement_count ${db.dialect.integer} NOT NULL
    )`,
  );
}

export async function migrate(
  db: Database,
  options: { logger?: Logger; migrations?: readonly Migration[] } = {},
): Promise<MigrateResult> {
  const logger = options.logger;
  const migrations = options.migrations ?? MIGRATIONS;

  await ensureLedger(db);
  const rows = await db.query<{ id: string }>(`SELECT id FROM ${LEDGER_TABLE}`);
  const done = new Set(rows.map((row) => row.id));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    if (done.has(migration.id)) {
      alreadyApplied.push(migration.id);
      continue;
    }

    const statements = migration.up(db.dialect);
    logger?.info("Applying migration", { migration: migration.id, statements: statements.length });

    await db.transaction(async (tx) => {
      for (const statement of statements) {
        try {
          await tx.executeScript(statement);
        } catch (error) {
          throw err.persistence(
            `Migration ${migration.id} failed on statement:\n${statement.slice(0, 500)}\n${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
      }
      await tx.execute(
        `INSERT INTO ${LEDGER_TABLE} (id, applied_at, statement_count) VALUES (?, ?, ?)`,
        [migration.id, new Date().toISOString(), statements.length],
      );
    });

    applied.push(migration.id);
  }

  logger?.info("Migrations complete", { applied: applied.length, alreadyApplied: alreadyApplied.length });
  return { applied, alreadyApplied };
}

/** Migration ids recorded as applied. Used by health checks and the CLI. */
export async function appliedMigrations(db: Database): Promise<string[]> {
  await ensureLedger(db);
  const rows = await db.query<{ id: string }>(`SELECT id FROM ${LEDGER_TABLE} ORDER BY id`);
  return rows.map((row) => row.id);
}

export async function pendingMigrations(db: Database): Promise<string[]> {
  const done = new Set(await appliedMigrations(db));
  return MIGRATIONS.filter((migration) => !done.has(migration.id)).map((migration) => migration.id);
}
