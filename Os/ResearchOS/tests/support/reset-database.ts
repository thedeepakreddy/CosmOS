/**
 * Truncates every application table between tests.
 *
 * Tests that assert on counts — "exactly one transferable failure", "nothing is
 * claimable" — are only meaningful against a known-empty database. Opening a
 * fresh engine per test would also give that, but migrating 34 tables into a new
 * PGlite instance for every test costs far more than emptying them, and the
 * dialect differences this suite exists to catch are in the schema, not in how
 * it is created.
 *
 * The table list is read from the engine's own catalog rather than hard-coded,
 * so a new migration cannot leave a table silently un-reset — the failure mode
 * where a test passes because stale rows happened to be somewhere nobody
 * remembered to clear.
 */
import type { Database } from "@research-os/persistence";

/** The migration ledger is schema state, not test data: clearing it would re-run every migration. */
const PRESERVED = new Set(["schema_migrations"]);

async function applicationTables(db: Database): Promise<string[]> {
  const rows =
    db.dialect.name === "postgres"
      ? await db.query<{ name: string }>(
          `SELECT tablename AS name FROM pg_tables WHERE schemaname = ANY (current_schemas(false))`,
        )
      : await db.query<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        );
  return rows.map((row) => row.name).filter((name) => !PRESERVED.has(name));
}

export async function resetDatabase(db: Database): Promise<void> {
  const tables = await applicationTables(db);
  if (tables.length === 0) return;

  if (db.dialect.name === "postgres") {
    // One statement: CASCADE resolves the foreign-key order for us, and
    // RESTART IDENTITY puts any sequence back to its starting value.
    await db.executeScript(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    return;
  }

  // SQLite has no TRUNCATE and enforces foreign keys on DELETE. Since every
  // table is being emptied, the order is irrelevant once the constraint is
  // lifted for the duration. PRAGMA cannot take effect inside a transaction,
  // so this runs as a script rather than through `transaction()`.
  await db.executeScript(
    [
      "PRAGMA foreign_keys = OFF",
      ...tables.map((table) => `DELETE FROM "${table}"`),
      "PRAGMA foreign_keys = ON",
    ].join(";\n"),
  );
}
