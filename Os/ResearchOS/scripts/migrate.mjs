#!/usr/bin/env node
/**
 * Applies pending migrations to the configured database.
 *
 * Run: npm run migrate            (uses RESEARCH_OS_DATABASE_URL, or the SQLite default)
 *      npm run migrate -- --status   (report without applying anything)
 *
 * Deliberately a thin shell over `migrate()`: the runner, the ledger and the
 * dual-dialect DDL all live in the package, so this script and the API's
 * start-up path apply migrations through exactly the same code.
 */
import {
  createDatabaseFromEnv, databaseConfigFromEnv, describeDatabase, migrate, MIGRATIONS,
} from "@research-os/persistence";
import { createLogger } from "@research-os/observability";

const statusOnly = process.argv.includes("--status");
const logger = createLogger({ format: "pretty", base: { component: "migrate" } });

const config = databaseConfigFromEnv();
const target = describeDatabase(config);
const db = await createDatabaseFromEnv();

try {
  const health = await db.healthCheck();
  if (!health.ok) {
    logger.error("Database is not reachable", { target, detail: health.detail });
    process.exitCode = 1;
  } else if (statusOnly) {
    const rows = await db
      .query("SELECT id, applied_at FROM schema_migrations ORDER BY id")
      .catch(() => []);
    const applied = new Set(rows.map((row) => row.id));
    logger.info("Migration status", {
      target,
      total: MIGRATIONS.length,
      applied: applied.size,
      pending: MIGRATIONS.filter((migration) => !applied.has(migration.id)).map((migration) => migration.id),
    });
  } else {
    const result = await migrate(db, { logger });
    logger.info("Migrations up to date", {
      target,
      applied: result.applied,
      alreadyApplied: result.alreadyApplied.length,
    });
  }
} catch (error) {
  logger.error("Migration failed", { target, error });
  process.exitCode = 1;
} finally {
  await db.close();
}
